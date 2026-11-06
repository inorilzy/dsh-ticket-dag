import test, { describe } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { chmod, copyFile, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { setTimeout as sleep } from 'node:timers/promises'
import { Coordinator } from '../src/coordinator.mjs'
import * as git from '../src/git.mjs'
import { RunStore, normalizeManifest } from '../src/store.mjs'

// Windows libuv searches the child cwd for a bare name before PATH, and a
// same-named .exe there beats a later .exe on PATH. These impostors are tiny
// and harmless: where.exe cannot satisfy git or node -e, and the .cmd / shell
// script only writes a marker. A correct resolver never starts them.
const win = process.platform === 'win32'
const delim = win ? ';' : ':'
const exec = promisify(execFile)
const gitEnv = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: win ? 'NUL' : '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
}
const timeScale = win ? 3 : 1
const limit = (ms) => ms * timeScale

function pathKey() {
  return Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
}

async function plantImpostor(dir, name, marker) {
  if (win) {
    const where = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'where.exe')
    await copyFile(where, join(dir, name + '.exe'))
    await writeFile(join(dir, name + '.cmd'), '@echo off\r\necho impostor> "' + marker + '"\r\n')
    return [name + '.exe', name + '.cmd']
  }
  await writeFile(join(dir, name), '#!/bin/sh\necho impostor > ' + JSON.stringify(marker) + '\nexit 0\n')
  await chmod(join(dir, name), 0o755)
  return [name]
}

describe('trusted program resolution', { concurrency: false }, () => {
  test('internal Git ignores a checkout impostor and relative PATH entries', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'dag-trusted-git-'))
    t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
    const main = join(root, 'main')
    await mkdir(main)
    await exec('git', ['init', '-q', '-b', 'main'], { cwd: main, env: gitEnv, windowsHide: true })
    await exec('git', ['config', 'user.name', 'DAG test'], { cwd: main, env: gitEnv, windowsHide: true })
    await exec('git', ['config', 'user.email', 'test@example.invalid'], { cwd: main, env: gitEnv, windowsHide: true })
    await writeFile(join(main, 'seed'), 'seed\n')
    await exec('git', ['add', 'seed'], { cwd: main, env: gitEnv, windowsHide: true })
    await exec('git', ['commit', '-qm', 'seed'], { cwd: main, env: gitEnv, windowsHide: true })
    const base = (await exec('git', ['rev-parse', 'HEAD'], { cwd: main, env: gitEnv, windowsHide: true })).stdout.trim()

    const marker = join(root, 'git-impostor-ran')
    await plantImpostor(main, 'git', marker)
    const empty = join(root, 'empty-on-path')
    await mkdir(empty)
    const key = pathKey()
    const previous = process.env[key]
    t.after(() => {
      process.env[key] = previous
    })
    // "." and a relative directory sit in front of the real Git. A unique absolute
    // entry keeps this lookup off any earlier cache.
    process.env[key] = ['.', 'relbin', empty, previous].filter(Boolean).join(delim)
    const repo = await git.repoInfo(main)
    assert.equal(await git.resolveRef(repo, 'HEAD'), base)
    assert.equal(existsSync(marker), false, 'impostor git ran during a normal lookup')

    process.env[key] = '.'
    await assert.rejects(git.repoInfo(main), /trusted host PATH \(absolute entries only\): git/)
    assert.equal(existsSync(marker), false, 'impostor git ran while reporting it was not found')
  })

  test('bare check programs use the trusted host PATH; explicit scripts keep the candidate cwd', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'dag-trusted-check-'))
    t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }))
    const main = join(root, 'main')
    await mkdir(main)
    const marker = join(root, 'node-impostor-ran')
    await plantImpostor(main, 'node', marker)
    const empty = join(root, 'empty-on-path')
    await mkdir(empty)
    const key = pathKey()
    const previous = process.env[key]
    t.after(() => {
      process.env[key] = previous
    })
    const nodeDir = dirname(process.execPath)
    process.env[key] = ['.', empty, nodeDir, previous].filter(Boolean).join(delim)

    const [chosen] = await git.runChecks(main, [['node', '-e', 'process.stdout.write(process.execPath)']])
    assert.equal(await realpath(chosen.stdout), await realpath(process.execPath))
    assert.equal(existsSync(marker), false, 'impostor node in the candidate ran')

    const relMarker = join(root, 'rel-impostor-ran')
    await mkdir(join(main, 'relbin'))
    await plantImpostor(join(main, 'relbin'), 'node', relMarker)
    process.env[key] = ['relbin', nodeDir].join(delim)
    const [rel] = await git.runChecks(main, [['node', '-e', 'process.stdout.write(process.execPath)']])
    assert.equal(await realpath(rel.stdout), await realpath(process.execPath))
    assert.equal(existsSync(relMarker), false, 'a relative PATH entry was searched inside the candidate')

    const emptyMarker = join(root, 'empty-impostor-ran')
    await plantImpostor(main, 'node', emptyMarker)
    process.env[key] = ['', nodeDir].join(delim)
    const [blank] = await git.runChecks(main, [['node', '-e', 'process.stdout.write(process.execPath)']])
    assert.equal(await realpath(blank.stdout), await realpath(process.execPath))
    assert.equal(existsSync(emptyMarker), false, 'an empty PATH entry searched the candidate')

    const script = win ? 'where.cmd' : 'where.sh'
    await writeFile(join(main, script), win ? '@echo off\r\ncd\r\n' : '#!/bin/sh\npwd\n')
    if (!win) await chmod(join(main, script), 0o755)
    const trap = join(root, 'trap')
    await mkdir(trap)
    await writeFile(join(trap, script), win ? '@echo off\r\necho TRAP\r\n' : '#!/bin/sh\necho TRAP\n')
    if (!win) await chmod(join(trap, script), 0o755)
    process.env[key] = [trap, previous].filter(Boolean).join(delim)
    const [explicit] = await git.runChecks(main, [[win ? '.\\' + script : './' + script]])
    assert.doesNotMatch(explicit.stdout, /TRAP/)
    assert.equal(await realpath(explicit.stdout.trim()), await realpath(main))

    await assert.rejects(git.runChecks(main, [['./missing-tool']]), /Program not found: \.\/missing-tool/)
    await assert.rejects(
      git.runChecks(main, [['dsh-ticket-dag-no-such-program']]),
      /trusted host PATH \(absolute entries only\): dsh-ticket-dag-no-such-program/,
    )
  })

  test(
    'verification runs the host program, not a same-named one committed into the candidate',
    { timeout: limit(90000) },
    async (t) => {
      const root = await mkdtemp(join(tmpdir(), 'dag-trusted-verify-'))
      const cwd = join(root, 'project')
      await mkdir(cwd)
      const raw = (args, dir = cwd) => exec('git', args, { cwd: dir, env: gitEnv, windowsHide: true })
      await raw(['init', '-q', '-b', 'main'])
      await raw(['config', 'user.name', 'fixture'])
      await raw(['config', 'user.email', 'fixture@example.invalid'])
      await raw(['commit', '--allow-empty', '-qm', 'seed'])
      const marker = join(root, 'node-impostor-ran')
      const chosen = join(root, 'chosen-node')
      const key = pathKey()
      const previous = process.env[key]
      t.after(() => {
        process.env[key] = previous
      })
      process.env[key] = ['.', 'relbin', dirname(process.execPath), previous].filter(Boolean).join(delim)
      const co = new Coordinator({
        autoCleanup: false,
        checks: {
          verify: [['node', '-e', "require('node:fs').writeFileSync(process.argv[1], process.execPath)", chosen]],
        },
        launch: async (job) => ({
          dispose: async () => {},
          result: (async () => {
            const files = await plantImpostor(job.cwd, 'node', marker)
            await raw(['add', '--', ...files], job.cwd)
            await writeFile(join(job.cwd, job.ticketId + '.txt'), job.ticketId)
            await raw(['add', '--', job.ticketId + '.txt'], job.cwd)
            const trailers = [
              'DAG-Run: ' + job.runId,
              'DAG-Ticket: ' + job.ticketId,
              'DAG-Attempt: ' + job.attempt,
              'DAG-Complete: yes',
            ].join('\n')
            await raw(['commit', '-qm', 'Deliver ' + job.ticketId, '-m', trailers], job.cwd)
            return { ok: true }
          })(),
        }),
      })
      const q = { cwd, parentId: 'captain', runId: 'trusted-program' }
      t.after(async () => {
        await co.close()
        await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
      })
      await co.start({
        ...q,
        manifest: { spec_id: 'trusted', tickets: [{ id: 'A', title: 'A', depends_on: [], verify: ['verify'] }] },
      })
      const deadline = Date.now() + limit(60000)
      let snapshot
      while (Date.now() < deadline) {
        snapshot = await co.status(q)
        if (snapshot.complete || snapshot.counts.NEEDS_ATTENTION) break
        await sleep(40)
      }
      assert.equal(snapshot.counts.NEEDS_ATTENTION ?? 0, 0, JSON.stringify(snapshot))
      assert.equal(snapshot.complete, true, JSON.stringify(snapshot))
      assert.equal(await realpath(await readFile(chosen, 'utf8')), await realpath(process.execPath))
      assert.equal(existsSync(marker), false, 'verification started the committed impostor')
    },
  )

  test(
    'automatic takeover runs the host Git, not a same-named program in the project',
    { timeout: limit(90000) },
    async (t) => {
      const f = await recoveryFixture(t)
      const marker = join(dirname(f.repo.root), 'git-impostor-ran')
      await plantImpostor(f.repo.root, 'git', marker)
      const empty = join(dirname(f.repo.root), 'empty-on-path')
      mkdirSync(empty)
      const key = pathKey()
      const previous = process.env[key]
      t.after(() => {
        process.env[key] = previous
      })
      process.env[key] = ['.', empty, previous].filter(Boolean).join(delim)
      await f.coordinator.attach({ cwd: f.repo.root, parentId })
      const deadline = Date.now() + limit(60000)
      let snapshot
      while (Date.now() < deadline) {
        snapshot = await f.coordinator.status(f.query)
        if (snapshot.tickets[0].status === 'INTEGRATED' || snapshot.mode === 'paused') break
        await sleep(40)
      }
      assert.equal(snapshot.tickets[0].status, 'INTEGRATED', JSON.stringify(snapshot))
      assert.equal(await git.resolveRef(f.repo, f.ref), f.candidate)
      assert.equal(existsSync(marker), false, 'takeover started the impostor git')
      assert.equal(f.evidence.launches, 0)
    },
  )
})

const checks = { syntax: [[process.execPath, '--check', 'module.js']] }
const original = {
  specId: 'recover',
  baseRef: 'main',
  tickets: [{ id: 'A', title: 'Add module', verify: ['syntax'] }],
}
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const gitRun = async (cwd, ...args) =>
  (await exec('git', args, { cwd, env: gitEnv, windowsHide: true })).stdout.trim()
const runId = 'recovery'
const parentId = 'original-captain'

// A submitted publication intent, same shape as the recovery suite, so attach
// has to drive internal Git to finish it.
async function recoveryFixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dag-trusted-recover-'))
  const main = join(dir, 'project')
  mkdirSync(main)
  await gitRun(main, 'init', '-q', '--initial-branch=main')
  await gitRun(main, 'config', 'user.name', 'Recovery test')
  await gitRun(main, 'config', 'user.email', 'recovery@test.invalid')
  await gitRun(main, 'config', 'commit.gpgSign', 'false')
  writeFileSync(join(main, 'seed'), 'seed\n')
  await gitRun(main, 'add', 'seed')
  await gitRun(main, 'commit', '-qm', 'seed')
  const repo = await git.repoInfo(main)
  const ref = 'refs/heads/integration/' + runId
  const base = await git.initIntegration(repo, ref, 'main')
  const dbPath = join(repo.commonDir, 'dsh-ticket-dag', 'runs', runId, 'state.sqlite')
  mkdirSync(dirname(dbPath), { recursive: true })
  writeFileSync(join(dirname(dbPath), 'initialized'), base)
  const store = new RunStore(dbPath)
  const path = join(dir, 'worker-a')
  const branch = 'ticket/recovery/a'
  const childId = 'previous-child'
  let source, candidate
  try {
    store.init({
      runId,
      parentId,
      ref,
      repo,
      baseSha: base,
      manifest: normalizeManifest(original, checks),
      policyHash: digest([['syntax', checks.syntax]]),
    })
    const lease = store.claim('A', { baseSha: base, childId, path, branch }).lease
    await git.prepareWorktree(repo, path, branch, base)
    writeFileSync(join(path, 'module.js'), 'export default 1\n')
    await gitRun(path, 'add', 'module.js')
    await gitRun(path, 'commit', '-qm', 'Worker A\n\nDAG-Run: recovery\nDAG-Ticket: A\nDAG-Attempt: 1\nDAG-Complete: yes')
    source = await gitRun(path, 'rev-parse', 'HEAD')
    assert.ok(store.move('A', lease, 'RUNNING', 'SUBMITTED', { sourceSha: source }))
    const probe = join(dir, 'candidate')
    candidate = await git.buildCandidate(repo, probe, base, source)
    await git.runChecks(probe, checks.syntax)
    assert.ok(store.intent('A', lease, { oldTip: base, sourceSha: source, candidateSha: candidate }))
  } finally {
    store.close()
  }
  const query = { cwd: main, runId, parentId }
  const evidence = { launches: 0 }
  const coordinator = new Coordinator({
    autoCleanup: false,
    checks,
    launch: async () => {
      evidence.launches++
      throw Error('unexpected worker launch')
    },
    notify: async () => false,
  })
  t.after(async () => {
    try {
      await coordinator.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  return { ref, repo, query, candidate, evidence, coordinator }
}
