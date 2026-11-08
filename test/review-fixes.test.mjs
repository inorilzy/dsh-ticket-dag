// Regression tests for the findings of the 0.18.0 review run (reviews/summary.md
// on integration/r-3669515a09a66717f690): brace expansion, ** backtracking,
// unmatched braces, a bad diagnostic row, the repair route and adopted commits.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { promisify } from 'node:util'
import { Coordinator } from '../src/coordinator.mjs'
import { fileOverlaps, globsOverlap } from '../src/selection.mjs'
import { RunStore, latestUndeclared, normalizeManifest } from '../src/store.mjs'

const alternativesOf = (n, prefix) => '{' + Array.from({ length: n }, (_, i) => prefix + i).join(',') + '}'

test('brace groups past the expansion limit fall back to an overlap instead of throwing (A-1/B-1/C-1)', () => {
  const big = alternativesOf(70, 'a')
  // Before the fix the nested and concatenated forms threw a TypeError.
  assert.equal(globsOverlap('x/' + big + '/' + big, 'x/a1/a2'), true, 'concatenated groups')
  assert.equal(globsOverlap('{p,' + alternativesOf(70, 'q') + '}', 'zzz'), true, 'nested group')
  assert.equal(globsOverlap(big, 'nothing'), true, 'one group past the limit')
  // Exactly 64 alternatives still expand and stay exact.
  const sixtyFour = alternativesOf(64, 'b')
  assert.equal(globsOverlap(sixtyFour, 'b63'), true)
  assert.equal(globsOverlap(sixtyFour, 'b64'), false)
  // The run-level warning no longer takes the snapshot down with it.
  assert.deepEqual(
    fileOverlaps([
      { id: 'A', dependsOn: [], files: ['x/' + big + '/' + big] },
      { id: 'B', dependsOn: [], files: ['x/a1/a2'] },
    ]).map((o) => o.tickets),
    [['A', 'B']],
  )
})

test('many ** segments are compared in polynomial time (A-2)', () => {
  const many = Array.from({ length: 24 }, () => '**').join('/') + '/x.js'
  const started = performance.now()
  assert.equal(globsOverlap(many, 'a/b/c/y.js'), false)
  assert.equal(globsOverlap(many, 'a/b/c/x.js'), true)
  // 14 segments took about 2.8 s before memoization; 24 would take hours.
  assert.ok(performance.now() - started < 500, 'took ' + (performance.now() - started) + ' ms')
})

test('an unmatched brace is literal and later groups still expand, as in globToRegExp (A-3/B-2)', () => {
  assert.equal(globsOverlap('{x{a,b}', '{xa'), true)
  assert.equal(globsOverlap('a{b/{c,d}.js', 'a{b/c.js'), true)
  assert.equal(globsOverlap('a{b/{c,d}.js', 'a{b/e.js'), false)
})

test('a malformed files_undeclared row is skipped instead of failing the read (C-4)', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dag-review-fixes-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'run.sqlite')
  const db = new RunStore(file)
  t.after(() => db.close())
  db.init({
    runId: 'run-1',
    repo: { root: '/work', commonDir: '/work/.git' },
    ref: 'refs/heads/integration/run-1',
    baseSha: 'start',
    parentId: 'parent',
    policyHash: 'h',
    manifest: normalizeManifest({ spec_id: 'x', tickets: [{ id: 'A', title: 'A', files: ['a.js'] }] }, {}),
  })
  db.recordUndeclared('A', { sourceSha: 'one', files: ['b.js'] })
  const raw = new DatabaseSync(file)
  raw
    .prepare('INSERT INTO events(id,type,ticketId,attempt,message,details,createdAt) VALUES (?,?,?,?,?,?,?)')
    .run('bad', 'files_undeclared', 'A', 1, 'bad row', 'not-json{', Date.now())
  assert.deepEqual(latestUndeclared(raw).get('A'), { sourceSha: 'one', files: ['b.js'] })
  raw.close()
})

// A fake run ledger for _repairOwner: tickets in plan order, appended batches and the approval.
function ledger({ tickets, appended = [], approvedAt = 100 }) {
  return {
    db: {
      tickets: () => tickets,
      appended: () => appended,
      events: () => (approvedAt === null ? [] : [{ type: 'run_approved', createdAt: approvedAt }]),
    },
  }
}
const culprit = { id: 'L', agent: 'implementer', agentSpec: { instructions: 'Build it.', model: 'mid-1' } }
const debuggerPreset = { instructions: 'Find the cause.', provider: 'acme', model: 'deep-2', reasoningEffort: 'high' }

test('a repair keeps a host-default debugger choice and ignores tickets appended after approval (A-5/B-4/C-5)', () => {
  const co = new Coordinator({ agents: { debugger: debuggerPreset }, launch: async () => {} })
  // Approved on the host default with no instructions: the ticket froze no agentSpec.
  const hostDefault = { id: 'D', agent: 'debugger' }
  assert.deepEqual(co._repairOwner(ledger({ tickets: [culprit, hostDefault] }), culprit), {
    agent: 'debugger',
    spec: { instructions: 'Find the cause.' },
  })
  // A debugger ticket appended after the approval was never reviewed by the user.
  const late = { id: 'E', agent: 'debugger', agentSpec: { instructions: 'x', provider: 'other', model: 'late-9' } }
  const owner = co._repairOwner(
    ledger({ tickets: [culprit, late], appended: [{ createdAt: 200, tickets: [{ id: 'E' }] }] }),
    culprit,
  )
  assert.deepEqual(owner.spec, debuggerPreset, 'falls back to the preset, not the unreviewed route')
  // With several approved debugger tickets the first in plan order wins.
  const first = { id: 'D1', agent: 'debugger', agentSpec: { model: 'm1' } }
  const second = { id: 'D2', agent: 'debugger', agentSpec: { model: 'm2' } }
  assert.equal(co._repairOwner(ledger({ tickets: [first, second] }), culprit).spec.model, 'm1')
})

test('a malformed debugger preset leaves the repair with the culprit preset (C-6)', () => {
  const co = new Coordinator({ agents: { debugger: { provider: 'acme' } }, launch: async () => {} })
  assert.deepEqual(co._repairOwner(ledger({ tickets: [culprit] }), culprit), {
    agent: 'implementer',
    spec: culprit.agentSpec,
  })
})

const exec = promisify(execFile)
const env = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
}
const git = async (cwd, ...args) => (await exec('git', args, { cwd, env })).stdout.trim()

test('a commit adopted after an interrupted delivery still gets its undeclared-files note (A-4/B-3)', { timeout: 60000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dag-review-adopt-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }))
  const cwd = join(root, 'project')
  await mkdir(cwd)
  await git(cwd, 'init', '-q', '-b', 'main')
  await git(cwd, 'config', 'user.name', 'fixture')
  await git(cwd, 'config', 'user.email', 'fixture@example.invalid')
  await git(cwd, 'commit', '--allow-empty', '-qm', 'seed')
  const co = new Coordinator({
    checks: { pass: [[process.execPath, '-e', 'process.exit(0)']] },
    retryDelayMs: 15,
    notify: async () => true,
    launch: async (job) => ({
      dispose: async () => {},
      result: (async () => {
        await writeFile(join(job.cwd, 'C.txt'), 'C\n')
        await git(job.cwd, 'add', '--', 'C.txt')
        const trailers = ['DAG-Run: ' + job.runId, 'DAG-Ticket: ' + job.ticketId, 'DAG-Attempt: ' + job.attempt, 'DAG-Complete: yes']
        await git(job.cwd, 'commit', '-qm', 'Deliver ' + job.ticketId, '-m', trailers.join('\n'))
        // The commit landed but the delivery was lost: the coordinator adopts it.
        return { ok: false, detail: 'STREAM_CLOSED' }
      })(),
    }),
  })
  const q = { cwd, parentId: 'captain', runId: 'adopt' }
  try {
    await co.start({
      ...q,
      manifest: { spec_id: 'adopt', tickets: [{ id: 'C', title: 'C', verify: ['pass'], files: ['docs/**'] }] },
    })
    const deadline = Date.now() + 45000
    let done
    while (Date.now() < deadline && !done) {
      const s = await co.status(q)
      if (s.counts.NEEDS_ATTENTION || s.diagnostic) throw Error(JSON.stringify(s.tickets.map((r) => [r.id, r.status, r.message])))
      if (s.complete) done = s
      else await sleep(40)
    }
    assert.ok(done, 'run complete')
    const c = done.tickets.find((x) => x.id === 'C')
    assert.equal(c.attempt, 1, 'adopted, not rerun')
    assert.deepEqual(c.undeclaredFiles?.files, ['C.txt'])
  } finally {
    await co.close()
  }
})
