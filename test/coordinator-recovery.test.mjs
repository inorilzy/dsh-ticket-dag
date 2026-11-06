import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { Coordinator } from '../src/coordinator.mjs'
import * as git from '../src/git.mjs'
import { RunStore, normalizeManifest } from '../src/store.mjs'

// Each fixture represents a state on disk after the original process is gone.
// No Coordinator implementation is mocked: a fresh instance reopens SQLite
// and operates on real refs and worktrees. A model launch is a test failure.
const checks = { syntax: [[process.execPath, '--check', 'module.js']] }
const original = {
  specId: 'recover',
  baseRef: 'main',
  tickets: [{ id: 'A', title: 'Add module', verify: ['syntax'] }],
}
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const gitRun = (cwd, ...argv) =>
  execFileSync('git', argv, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const runId = 'recovery',
  parentId = 'original-captain'

async function fixture(t, { intent = true, published = false, mode = 'active' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dag-coordinator-recover-'))
  const main = join(dir, 'project')
  mkdirSync(main)
  gitRun(main, 'init', '-q', '--initial-branch=main')
  gitRun(main, 'config', 'user.name', 'Recovery test')
  gitRun(main, 'config', 'user.email', 'recovery@test.invalid')
  gitRun(main, 'config', 'commit.gpgSign', 'false')
  writeFileSync(join(main, 'seed'), 'seed\n')
  gitRun(main, 'add', 'seed')
  gitRun(main, 'commit', '-qm', 'seed')
  const repo = await git.repoInfo(main),
    ref = 'refs/heads/integration/' + runId
  const base = await git.initIntegration(repo, ref, 'main')
  const dbPath = join(repo.commonDir, 'dsh-ticket-dag', 'runs', runId, 'state.sqlite')
  mkdirSync(dirname(dbPath), { recursive: true })
  writeFileSync(join(dirname(dbPath), 'initialized'), base)
  const store = new RunStore(dbPath)
  const path = join(dir, 'worker-a'),
    branch = 'ticket/recovery/a',
    childId = 'previous-child'
  let source, candidate, lease
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
    lease = store.claim('A', { baseSha: base, childId, path, branch }).lease
    await git.prepareWorktree(repo, path, branch, base)
    writeFileSync(join(path, 'module.js'), 'export default 1\n')
    gitRun(path, 'add', 'module.js')
    gitRun(
      path,
      'commit',
      '-qm',
      'Worker A\n\nDAG-Run: recovery\nDAG-Ticket: A\nDAG-Attempt: 1\nDAG-Complete: yes',
    )
    source = gitRun(path, 'rev-parse', 'HEAD')
    if (intent) {
      assert.ok(store.move('A', lease, 'RUNNING', 'SUBMITTED', { sourceSha: source }))
      const probe = join(dir, 'candidate')
      candidate = await git.buildCandidate(repo, probe, base, source)
      await git.runChecks(probe, checks.syntax)
      assert.ok(store.intent('A', lease, { oldTip: base, sourceSha: source, candidateSha: candidate }))
      if (published) await git.publishCandidate(repo, ref, base, candidate)
    }
    if (mode !== 'active') store.setMode(mode)
  } finally {
    store.close()
  }
  const query = { cwd: main, runId, parentId }
  const evidence = { retired: false, launches: 0 }
  const coordinator = new Coordinator({
    checks,
    launch: async () => {
      evidence.launches++
      throw Error('unexpected worker launch')
    },
    notify: async () => false,
    canRetry: async ({ childId: id }) => evidence.retired && id === childId,
  })
  t.after(async () => {
    try {
      await coordinator.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  return { ref, repo, query, base, source, candidate, lease, evidence, coordinator, dbPath, path }
}

test('cold attach on a paused run repairs an already-published receipt without launching a worker', async (t) => {
  const f = await fixture(t, { published: true, mode: 'paused' })
  const snapshot = await f.coordinator.status(f.query)
  assert.equal(snapshot.mode, 'paused')
  assert.equal(snapshot.verifiedSha, f.candidate)
  assert.equal(snapshot.tickets[0].landedSha, f.candidate)
  assert.equal(snapshot.tickets[0].attempt, 1)
  assert.equal(f.evidence.launches, 0)
  const reader = new RunStore(f.dbPath)
  try {
    assert.deepEqual(reader.intents(), [])
    assert.equal(reader.events().filter((e) => e.type === 'integrated').length, 1)
    assert.equal(reader.pendingNotifications().filter((e) => e.type === 'run_completed').length, 1)
  } finally {
    reader.close()
  }
})

test('cold status leaves a paused, unexecuted publication untouched until explicit resume', async (t) => {
  const f = await fixture(t, { mode: 'paused' })
  const held = await f.coordinator.status(f.query)
  assert.equal(held.tickets[0].status, 'PUBLISHING')
  assert.equal(await git.resolveRef(f.repo, f.ref), f.base)
  const done = await f.coordinator.resume(f.query)
  assert.equal(done.tickets[0].status, 'INTEGRATED')
  assert.equal(done.verifiedSha, f.candidate)
  assert.equal(f.evidence.launches, 0)
})

test('a cold cancel cannot publish an intent while opening the run to stop it', async (t) => {
  const f = await fixture(t)
  const stopped = await f.coordinator.cancel(f.query)
  assert.equal(stopped.mode, 'cancelled')
  assert.equal(stopped.verifiedSha, f.base)
  assert.equal(await git.resolveRef(f.repo, f.ref), f.base)
  assert.equal(f.evidence.launches, 0)
})

test('a lost completion is adopted only after proving the old child is no longer a writer', async (t) => {
  const f = await fixture(t, { intent: false })
  const uncertain = await f.coordinator.status(f.query)
  assert.equal(uncertain.tickets[0].status, 'NEEDS_ATTENTION')
  await assert.rejects(f.coordinator.retry({ ...f.query, id: 'A' }), /old child|writer|stopped/i)
  assert.equal(gitRun(f.path, 'rev-parse', 'HEAD'), f.source)
  assert.equal(f.evidence.launches, 0)
  f.evidence.retired = true
  await f.coordinator.retry({ ...f.query, id: 'A' })
  let done
  for (let i = 0; i < 200; i++) {
    done = await f.coordinator.status(f.query)
    if (done.complete) break
    await sleep(20)
  }
  assert.ok(done.complete, JSON.stringify(done))
  assert.equal(done.tickets[0].sourceSha, f.source)
  assert.equal(done.tickets[0].attempt, 1)
  assert.equal(f.evidence.launches, 0)
  assert.equal(await git.isAncestor(f.repo, f.source, done.verifiedSha), true)
})

test('a changed check registry cannot replay a green intent with different verification commands', async (t) => {
  const f = await fixture(t)
  f.coordinator.checks = { syntax: [[process.execPath, '-e', 'process.exit(0)']] }
  const snapshot = await f.coordinator.status(f.query)
  assert.equal(snapshot.mode, 'paused')
  assert.match(snapshot.diagnostic, /verification|checks/i)
  assert.equal(snapshot.tickets[0].status, 'PUBLISHING')
  assert.equal(await git.resolveRef(f.repo, f.ref), f.base)
  const reader = new RunStore(f.dbPath)
  try {
    assert.equal(reader.meta().diagnostic, snapshot.diagnostic)
    assert.equal(reader.pendingNotifications().filter((n) => n.type === 'run_blocked').length, 1)
  } finally {
    reader.close()
  }
  assert.equal(f.evidence.launches, 0)
})

test('unexpected external advancement during recovery is preserved and never accepted into the ledger', async (t) => {
  const f = await fixture(t)
  const foreign = gitRun(
    f.repo.root,
    'commit-tree',
    f.base + '^{tree}',
    '-p',
    f.base,
    '-m',
    'unrecorded external change',
  )
  gitRun(f.repo.root, 'update-ref', f.ref, foreign, f.base)
  const snapshot = await f.coordinator.status(f.query)
  assert.equal(snapshot.mode, 'paused')
  assert.match(snapshot.diagnostic, /unrecognized target|integration ref/i)
  assert.equal(snapshot.verifiedSha, f.base)
  assert.equal(await git.resolveRef(f.repo, f.ref), foreign)
  assert.equal(snapshot.tickets[0].status, 'PUBLISHING')
  assert.equal(f.evidence.launches, 0)
})

test('an already-executed CAS is accounted even if the restored run is cancelled', async (t) => {
  const f = await fixture(t, { published: true, mode: 'cancelled' })
  const snapshot = await f.coordinator.status(f.query)
  assert.equal(snapshot.mode, 'cancelled')
  assert.equal(snapshot.tickets[0].status, 'INTEGRATED')
  assert.equal(snapshot.verifiedSha, f.candidate)
  const reader = new RunStore(f.dbPath)
  try {
    assert.deepEqual(reader.intents(), [])
    assert.equal(reader.events().filter((e) => e.type === 'run_completed').length, 0)
  } finally {
    reader.close()
  }
})

test('a run approved before the review listed unused checks keeps its used commands but cannot presume the rest approved', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dag-coordinator-legacy-'))
  const main = join(dir, 'project')
  mkdirSync(main)
  gitRun(main, 'init', '-q', '--initial-branch=main')
  gitRun(main, 'config', 'user.name', 'Recovery test')
  gitRun(main, 'config', 'user.email', 'recovery@test.invalid')
  gitRun(main, 'config', 'commit.gpgSign', 'false')
  gitRun(main, 'commit', '--allow-empty', '-qm', 'seed')
  const ok = [[process.execPath, '-e', 'process.exit(0)']]
  const hiddenRan = join(dir, 'hidden-ran')
  const own = {
    used: ok,
    early: ok,
    hidden: [[process.execPath, '-e', "require('node:fs').writeFileSync(process.argv[1], 'ran')", hiddenRan]],
  }
  const options = {
    checks: {},
    notify: async () => true,
    launch: async (job) => ({
      dispose: async () => {},
      result: (async () => {
        writeFileSync(join(job.cwd, job.ticketId + '.txt'), job.ticketId)
        gitRun(job.cwd, 'add', '--', job.ticketId + '.txt')
        gitRun(
          job.cwd,
          'commit',
          '-qm',
          'Deliver ' + job.ticketId,
          '-m',
          'DAG-Run: ' + job.runId + '\nDAG-Ticket: ' + job.ticketId + '\nDAG-Attempt: ' + job.attempt + '\nDAG-Complete: yes',
        )
        return { ok: true }
      })(),
    }),
  }
  const q = { cwd: main, parentId, runId: 'legacy' }
  const settled = async (coordinator) => {
    for (let i = 0; i < 3000; i++) {
      const s = await coordinator.status(q)
      assert.equal(s.counts.NEEDS_ATTENTION, undefined, JSON.stringify(s))
      if (s.complete) return s
      await sleep(40)
    }
    throw Error('run did not settle')
  }
  const first = new Coordinator(options)
  let reopened
  t.after(async () => {
    await first.close()
    await reopened?.close()
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
  })
  const manifest = { spec_id: 'legacy', checks: own, tickets: [{ id: 'A', title: 'A', verify: ['used'] }] }
  await first.start({ ...q, manifest })
  const [file] = first.runs.keys()
  await first.approve(file, [])
  await settled(first)
  // Appended under the old rules: from then on this command is part of the run.
  const history = [{ id: 'B', title: 'B', depends_on: ['A'], verify: ['early'] }]
  await first.add({ ...q, tickets: history })
  await settled(first)
  await first.close()

  // What 0.13.0 wrote: approval with no record of which commands were shown.
  const old = new DatabaseSync(file)
  old.prepare("UPDATE events SET details='{}' WHERE type='run_approved'").run()
  old.close()

  reopened = new Coordinator(options)
  const loaded = await reopened.status(q)
  assert.equal(loaded.mode, 'active')
  assert.equal(loaded.diagnostic, null)
  assert.deepEqual(loaded.unapprovedChecks, ['hidden'])
  assert.deepEqual(Object.keys(loaded.checks).sort(), ['early', 'used'])
  await assert.rejects(
    reopened.add({ ...q, tickets: [{ id: 'X', title: 'X', verify: ['hidden'] }] }),
    /X: check hidden was not shown/,
  )
  assert.equal((await reopened.add({ ...q, tickets: history })).tickets.length, 2, 'the old batch stays idempotent')
  assert.equal((await reopened.start({ ...q, manifest })).mode, 'active', 'the old manifest stays idempotent')
  await reopened.add({ ...q, tickets: [{ id: 'C', title: 'C', depends_on: ['B'], verify: ['used', 'early'] }] })
  const done = await settled(reopened)
  assert.equal(done.tickets.at(-1).status, 'INTEGRATED')
  assert.deepEqual(done.unapprovedChecks, ['hidden'])
  assert.throws(() => readFileSync(hiddenRan))

  // A forged approval record is an outside edit, not a grant.
  const forged = new DatabaseSync(file)
  forged.prepare("UPDATE events SET details='{\"planChecks\":[\"hidden\"]}' WHERE type='run_approved'").run()
  forged.close()
  await assert.rejects(
    reopened.add({ ...q, tickets: [{ id: 'Y', title: 'Y', verify: ['hidden'] }] }),
    /modified outside the coordinator/,
  )
  assert.equal((await reopened.status(q)).mode, 'paused')
})
