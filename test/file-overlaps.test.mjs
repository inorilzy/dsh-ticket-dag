import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { setTimeout as sleep } from 'node:timers/promises'
import { Coordinator } from '../src/coordinator.mjs'
import { changedFiles, ownChangedFiles, repoInfo, resolveRef } from '../src/git.mjs'
import { fileOverlaps, globsOverlap, undeclaredFiles } from '../src/selection.mjs'
import { RunStore, normalizeAppend, normalizeManifest } from '../src/store.mjs'

const checks = { unit: [['node', '--test']] }
const ticket = (id, deps = [], files) => ({
  id,
  title: 'Implement ' + id,
  depends_on: deps,
  verify: ['unit'],
  ...(files ? { files } : {}),
})
const plan = (tickets) => normalizeManifest({ spec_id: 'test', tickets }, checks)

test('globsOverlap: exact for literals and literal against glob, conservative for two globs', () => {
  assert.ok(globsOverlap('src/main.js', 'src/main.js'))
  assert.ok(!globsOverlap('src/main.js', 'src/events.js'))
  assert.ok(globsOverlap('src/**', 'src/systems/player.js'))
  assert.ok(globsOverlap('src/systems/*.js', 'src/systems/enemy.js'))
  assert.ok(!globsOverlap('src/systems/*.js', 'src/systems/a/enemy.js'), '* stays within one segment')
  assert.ok(!globsOverlap('src/systems/*.js', 'tests/enemy.test.mjs'))
  assert.ok(globsOverlap('src/**', 'src/systems/*.js'))
  assert.ok(globsOverlap('**/*.md', 'docs/a.md'))
  assert.ok(!globsOverlap('src/*.js', 'src/*.ts'), 'different literal suffixes cannot meet')
  assert.ok(!globsOverlap('src/a*', 'src/b*'), 'different literal prefixes cannot meet')
  assert.ok(globsOverlap('{src,lib}/x.js', 'lib/*.js'))
  assert.ok(!globsOverlap('{src,lib}/x.js', 'docs/*.js'))
})

test('fileOverlaps reports the shared-registry fan-out that made plane-b conflict', () => {
  // P02–P06 each add an entry to the same three registration files and depend only on P01.
  const own = { P02: 'player', P03: 'bullet', P04: 'enemy', P05: 'score', P06: 'powerup' }
  const registry = ['src/main.js', 'src/events.js', 'src/data/balance.js']
  const tickets = [
    { id: 'P01', dependsOn: [], files: ['src/**', 'tests/core.test.mjs'] },
    ...Object.entries(own).map(([id, name]) => ({
      id,
      dependsOn: ['P01'],
      files: ['src/systems/' + name + '.js', 'tests/' + name + '.test.mjs', ...registry],
    })),
  ]
  const overlaps = fileOverlaps(tickets)
  assert.equal(overlaps.length, 10, 'every pair of the five parallel tickets, none with P01 they depend on')
  assert.deepEqual(overlaps[0], { tickets: ['P02', 'P03'], files: registry })

  // The fix the fish plugin forced: parallel tickets keep to their own files and
  // one registration ticket after them owns the shared files.
  const split = [
    tickets[0],
    ...tickets.slice(1).map((t) => ({ ...t, files: t.files.slice(0, 2) })),
    { id: 'REG', dependsOn: Object.keys(own), files: registry },
  ]
  assert.deepEqual(fileOverlaps(split), [])
})

test('fileOverlaps skips transitive order, finished tickets and tickets without files', () => {
  const chain = [
    { id: 'A', dependsOn: [], files: ['x.js'] },
    { id: 'B', dependsOn: ['A'], files: ['y.js'] },
    { id: 'C', dependsOn: ['B'], files: ['x.js'] },
  ]
  assert.deepEqual(fileOverlaps(chain), [], 'A and C are ordered through B')
  assert.deepEqual(
    fileOverlaps([
      { id: 'A', dependsOn: [], files: ['x.js'] },
      { id: 'B', dependsOn: [], files: ['x.js'], status: 'INTEGRATED' },
      { id: 'C', dependsOn: [], files: ['x.js'], status: 'CANCELLED' },
      { id: 'D', dependsOn: [] },
      { id: 'E', dependsOn: [], files: ['*.js'], status: 'RUNNING' },
    ]),
    [{ tickets: ['A', 'E'], files: ['x.js ↔ *.js'] }],
  )
})

test('undeclaredFiles lists changed paths no declared glob covers', () => {
  assert.deepEqual(
    undeclaredFiles(['src/systems/*.js', 'tests/**'], ['src/systems/a.js', 'tests/x/y.mjs', 'src/main.js', 'README.md']),
    ['src/main.js', 'README.md'],
  )
  assert.deepEqual(undeclaredFiles(['**'], ['a', 'b/c']), [])
})

test('manifest files: kept when given, omitted otherwise, repository-relative only', () => {
  const m = plan([ticket('A', [], ['src/a.js', 'tests/**']), ticket('B', ['A'])])
  assert.deepEqual(m.tickets[0].files, ['src/a.js', 'tests/**'])
  assert.equal('files' in m.tickets[1], false)
  assert.deepEqual(normalizeManifest(m, checks), m, 'a stored manifest normalizes to itself')
  assert.equal(
    JSON.stringify(plan([ticket('A', [], [])])),
    JSON.stringify(plan([ticket('A')])),
    'an empty files list keeps the manifest of a ticket without it',
  )
  for (const bad of ['/etc/passwd', '../x.js', 'a//b.js', './a.js', 'a\\b.js', ''])
    assert.throws(() => plan([ticket('A', [], [bad])]), /files/, bad)
  assert.throws(() => plan([ticket('A', [], ['a.js', 'a.js'])]), /duplicate/)
  assert.throws(() => plan([ticket('A', [], 'a.js')]), /array/)
  assert.deepEqual(normalizeAppend([ticket('C', [], ['c.js'])], checks)[0].files, ['c.js'])
})

test('RunStore keeps the latest undeclared-files note per ticket', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dag-overlap-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const db = new RunStore(join(dir, 'run.sqlite'))
  t.after(() => db.close())
  db.init({
    runId: 'run-1',
    repo: { root: '/work', commonDir: '/work/.git' },
    ref: 'refs/heads/integration/run-1',
    baseSha: 'start',
    parentId: 'parent',
    policyHash: 'checks-hash',
    manifest: plan([ticket('A', [], ['a.js'])]),
  })
  assert.equal(db.undeclaredResults().size, 0)
  db.recordUndeclared('A', { sourceSha: 'one', files: ['b.js'] })
  db.recordUndeclared('A', { sourceSha: 'two', files: ['c.js', 'd.js'] })
  assert.deepEqual(db.undeclaredResults().get('A'), { sourceSha: 'two', files: ['c.js', 'd.js'] })
  const event = db.events().find((e) => e.type === 'files_undeclared')
  assert.match(event.message, /A changed 1 undeclared file\(s\): b\.js/)
  assert.equal(db.pendingNotifications().length, 0, 'a diagnostic, not a captain notification')
})

const exec = promisify(execFile)
const g = async (cwd, ...args) =>
  (await exec('git', args, { cwd, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' } })).stdout.trim()

test('ownChangedFiles leaves out files a conflict merge brought in from the integration tip', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dag-overlap-git-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }))
  const main = join(root, 'main')
  await mkdir(main)
  await g(main, 'init', '-q', '-b', 'main')
  await g(main, 'config', 'user.name', 'DAG test')
  await g(main, 'config', 'user.email', 'test@example.invalid')
  await g(main, 'config', 'commit.gpgSign', 'false')
  const commit = async (file, message) => {
    await writeFile(join(main, file), message + '\n')
    await g(main, 'add', '--', file)
    await g(main, 'commit', '-qm', message)
  }
  await commit('seed.txt', 'Seed')
  await g(main, 'branch', 'ticket')
  await commit('other.txt', 'Another ticket landed')
  const tip = await g(main, 'rev-parse', 'HEAD')
  await g(main, 'checkout', '-q', 'ticket')
  await commit('mine.txt', 'This ticket')
  await g(main, 'merge', '-q', '--no-edit', 'main')
  const repo = await repoInfo(main)
  const source = await resolveRef(repo, 'HEAD')
  const base = await g(main, 'rev-parse', 'HEAD^1^1')
  assert.deepEqual((await changedFiles(repo, base, source)).sort(), ['mine.txt', 'other.txt'])
  assert.deepEqual(await ownChangedFiles(repo, tip, source), ['mine.txt'])
})

// A scripted worker that commits src/<ticket>.txt with the DAG trailers, as in test/integration-end.test.mjs.
function worker() {
  return async (job) => ({
    dispose: async () => {},
    result: (async () => {
      const file = 'src/' + job.ticketId + '.txt'
      await mkdir(join(job.cwd, 'src'), { recursive: true })
      await writeFile(join(job.cwd, file), job.ticketId + '\n')
      await g(job.cwd, 'add', '--', file)
      const trailers = ['DAG-Run: ' + job.runId, 'DAG-Ticket: ' + job.ticketId, 'DAG-Attempt: ' + job.attempt, 'DAG-Complete: yes']
      await g(job.cwd, 'commit', '-qm', 'Deliver ' + job.ticketId, '-m', trailers.join('\n'))
      return { ok: true }
    })(),
  })
}

test('dag_run reports overlapping files as a warning and the run still integrates; undeclared changes are noted', { timeout: 120000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dag-overlap-run-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }))
  const cwd = join(root, 'project')
  await mkdir(cwd)
  await g(cwd, 'init', '-q', '-b', 'main')
  await g(cwd, 'config', 'user.name', 'fixture')
  await g(cwd, 'config', 'user.email', 'fixture@example.invalid')
  await g(cwd, 'commit', '--allow-empty', '-qm', 'seed')
  const co = new Coordinator({ checks: { pass: [[process.execPath, '-e', 'process.exit(0)']] }, launch: worker() })
  const q = { cwd, parentId: 'captain', runId: 'overlap' }
  try {
    const started = await co.start({
      ...q,
      manifest: {
        spec_id: 'overlap',
        max_workers: 3,
        tickets: [
          { id: 'A', title: 'A', verify: ['pass'], files: ['src/A.txt', 'src/registry.js'] },
          { id: 'B', title: 'B', verify: ['pass'], files: ['src/B.txt', 'src/registry.js'] },
          { id: 'C', title: 'C', verify: ['pass'], files: ['docs/**'] },
        ],
      },
    })
    assert.deepEqual(started.fileOverlaps, [{ tickets: ['A', 'B'], files: ['src/registry.js'] }])
    assert.deepEqual(started.tickets.find((x) => x.id === 'A').files, ['src/A.txt', 'src/registry.js'])
    const deadline = Date.now() + 90000
    let done
    while (Date.now() < deadline) {
      const s = await co.status(q)
      if (s.counts.NEEDS_ATTENTION || s.diagnostic) throw Error(JSON.stringify(s.tickets.map((r) => [r.id, r.status, r.message])))
      if (s.complete) {
        done = s
        break
      }
      await sleep(40)
    }
    assert.ok(done, 'run complete')
    assert.deepEqual(done.fileOverlaps, [], 'integrated tickets no longer overlap anything')
    const byId = Object.fromEntries(done.tickets.map((x) => [x.id, x]))
    assert.equal(byId.A.undeclaredFiles, null)
    assert.deepEqual(byId.C.undeclaredFiles.files, ['src/C.txt'])
    assert.equal(byId.C.status, 'INTEGRATED', 'an undeclared change never blocks integration')
  } finally {
    await co.close()
  }
})
