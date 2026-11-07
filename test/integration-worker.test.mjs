import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { promisify } from 'node:util'
import { Coordinator } from '../src/coordinator.mjs'
import { normalizeManifest } from '../src/store.mjs'

// Same fixtures as test/integration-end.test.mjs: a throwaway repository and a
// scripted worker that commits with the DAG trailers.
const exec = promisify(execFile)
const env = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
}
const git = async (cwd, ...args) => (await exec('git', args, { cwd, env })).stdout.trim()
const limit = (ms) => ms * (process.platform === 'win32' ? 3 : 1)
async function until(check, label, ms = 90000) {
  const deadline = Date.now() + limit(ms)
  while (Date.now() < deadline) {
    const v = await check()
    if (v) return v
    await sleep(30)
  }
  throw Error('Timeout: ' + label)
}
async function repo(t) {
  const root = await mkdtemp(join(tmpdir(), 'dag-worker-'))
  const cwd = join(root, 'project')
  await mkdir(cwd)
  await git(cwd, 'init', '-q', '-b', 'main')
  await git(cwd, 'config', 'user.name', 'fixture')
  await git(cwd, 'config', 'user.email', 'fixture@example.invalid')
  await git(cwd, 'commit', '--allow-empty', '-qm', 'seed')
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }))
  return { root, cwd }
}
async function commit(job, file, body) {
  await mkdir(dirname(join(job.cwd, file)), { recursive: true })
  await writeFile(join(job.cwd, file), body)
  await git(job.cwd, 'add', '--', file)
  const trailers = ['DAG-Run: ' + job.runId, 'DAG-Ticket: ' + job.ticketId, 'DAG-Attempt: ' + job.attempt, 'DAG-Complete: yes']
  await git(job.cwd, 'commit', '-qm', 'Deliver ' + job.ticketId, '-m', trailers.join('\n'))
}
/**
 * L writes bug.txt=bad, and bug.txt=ok once told its worker-side checks failed
 * (a fix-* ticket writes bug.txt=ok);
 * D writes docs/<id>.md; others write src/<id>.txt. before(job) runs first, so
 * a test can hold a worker or merge the integration branch into it.
 */
function worker(seen = [], before = async () => {}) {
  return async (job) => ({
    dispose: async () => {},
    result: (async () => {
      seen.push(job)
      await before(job)
      if (job.ticketId.startsWith('fix-')) await commit(job, 'bug.txt', 'ok\n')
      else if (job.ticketId === 'L')
        await commit(job, 'bug.txt', /Worker-side checks failed/.test(job.prompt) ? 'ok\n' : 'bad\n')
      else if (job.ticketId.startsWith('D')) await commit(job, 'docs/' + job.ticketId + '.md', job.ticketId + '\n')
      else await commit(job, 'src/' + job.ticketId + '.txt', job.ticketId + '\n')
      return { ok: true }
    })(),
  })
}
const pass = [[process.execPath, '-e', 'process.exit(0)']]
// Fails while bug.txt says bad.
const slow = [
  [
    process.execPath,
    '-e',
    "const fs=require('fs');if(fs.existsSync('bug.txt')&&fs.readFileSync('bug.txt','utf8').trim()==='bad'){console.error('bug.txt is bad');process.exit(1)}",
  ],
]
const meta = { fast: { files: ['**'], fast: true }, slow: { files: ['src/**', 'bug.txt'] } }
const plan = (tickets, extra = {}) => ({ spec_id: 'worker', max_workers: 4, tickets, ...extra })
const ledger = (co, runId) => [...co.runs.values()].find((r) => r.db.meta().runId === runId).db
const ofType = (events, type) => events.filter((e) => e.type === type)
const checksOf = (events, stage, id) =>
  events.filter((e) => e.type === 'check_finished' && (e.details.stage ?? 'lane') === stage && (!id || e.ticketId === id))
async function completed(co, q) {
  return until(async () => {
    const s = await co.status(q)
    if (s.counts.NEEDS_ATTENTION) throw Error(JSON.stringify(s.tickets.map((r) => [r.id, r.status, r.message])))
    if (s.diagnostic) throw Error(s.diagnostic)
    return s.complete && s
  }, 'run complete')
}

test('worker mode: a failed worker-side check goes back to the same worker, which fixes it', { timeout: limit(120000) }, async (t) => {
  const { cwd } = await repo(t)
  const seen = []
  const co = new Coordinator({ checks: { fast: pass, slow }, checkMeta: meta, integrationMode: 'worker', launch: worker(seen) })
  const q = { cwd, parentId: 'captain', runId: 'requeue' }
  try {
    const started = await co.start({ ...q, manifest: plan([{ id: 'L', title: 'L', verify: ['fast', 'slow'] }]) })
    assert.deepEqual(started.integration, { mode: 'worker', selectChecksByFiles: false })
    await completed(co, q)
    const db = ledger(co, 'requeue')
    const events = db.events()
    const [requeued] = ofType(events, 'check_requeued')
    assert.equal(requeued.ticketId, 'L')
    assert.equal(requeued.details.checkRetries, 1)
    const results = ofType(events, 'worker_verify_finished')
    assert.deepEqual(results.map((e) => [e.details.ok, e.details.failed]), [[false, ['slow']], [true, []]])
    assert.notEqual(results[0].details.sourceSha, results[1].details.sourceSha)
    // The base was the tip when the worker committed: its checks covered it.
    assert.equal(results[0].details.coveredTip, db.meta().baseSha)
    // The retry resumed the same worktree with the failure in its recovery prompt.
    const [first, second] = seen
    assert.equal(second.attempt, 2)
    assert.equal(second.cwd, first.cwd)
    for (const part of ['This is a recovery attempt', 'Worker-side checks failed', 'slow', 'bug.txt is bad']) assert.ok(second.prompt.includes(part), part)
    // The worker prompt explains that the coordinator checks the commit at once.
    assert.match(first.prompt, /runs all of them on your commit as soon as you commit/)
    assert.match(first.prompt, /merge the latest integration branch integration\/requeue/)
    // Worker-side checks are recorded on the ticket, in the worker stage.
    const workerChecks = checksOf(events, 'worker', 'L')
    assert.equal(workerChecks.length, 4)
    assert.equal(db.get('L').status, 'INTEGRATED')
    assert.equal(await git(cwd, 'show', 'integration/requeue:bug.txt'), 'ok')
    const timing = (await co.status(q)).timing
    assert.ok(timing.totals.workerVerifyMs >= 0 && timing.totals.checkRuns >= 4)
    assert.equal(timing.tickets.L.attempts, 2)
    assert.ok(timing.tickets.L.verifyMs >= workerChecks.reduce((n, e) => n + e.details.ms, 0))
    assert.equal(timing.totals.conflicts, 0, 'check retries are not conflicts')
    assert.doesNotMatch(await git(cwd, 'worktree', 'list', '--porcelain'), /probes/)
  } finally {
    await co.close()
  }
})

test('past maxConflictRetries a failing worker-side check needs attention', { timeout: limit(120000) }, async (t) => {
  const { cwd } = await repo(t)
  const co = new Coordinator({
    checks: { slow },
    integrationMode: 'worker',
    maxConflictRetries: 0,
    launch: worker(),
  })
  const q = { cwd, parentId: 'captain', runId: 'exhausted' }
  try {
    await co.start({ ...q, manifest: plan([{ id: 'L', title: 'L', verify: ['slow'] }]) })
    const row = await until(async () => (await co.status(q)).tickets.find((r) => r.status === 'NEEDS_ATTENTION'), 'needs attention')
    assert.match(row.message, /Worker-side checks failed on your commit [0-9a-f]{40}: slow/)
    assert.match(row.message, /retries \(maxConflictRetries\) are used up/)
    assert.equal(row.workerVerify.ok, false)
    assert.deepEqual(row.workerVerify.failed, ['slow'])
    const events = ledger(co, 'exhausted').events()
    assert.equal(ofType(events, 'check_requeued').length, 0)
    assert.equal(ofType(events, 'verify_started').length, 0, 'the lane never took it')
  } finally {
    await co.close()
  }
})

test('worker mode: the lane skips slow checks the worker side covered at this tip and reruns them after the tip moved', { timeout: limit(120000) }, async (t) => {
  const { cwd } = await repo(t)
  const base = await git(cwd, 'rev-parse', 'HEAD')
  const moved = async () => (await git(cwd, 'rev-parse', 'integration/lane')) !== base
  // B waits for A to land and does not merge it; C waits too, then merges it in.
  const co = new Coordinator({
    checks: { fast: pass, slow },
    checkMeta: meta,
    integrationMode: 'worker',
    launch: worker([], async (job) => {
      if (job.ticketId === 'A') return
      await until(moved, 'A landed')
      if (job.ticketId === 'C') await git(job.cwd, 'merge', '-q', '--no-edit', 'integration/lane')
    }),
  })
  const q = { cwd, parentId: 'captain', runId: 'lane' }
  try {
    await co.start({
      ...q,
      manifest: plan([
        { id: 'A', title: 'A', verify: ['fast', 'slow'] },
        { id: 'B', title: 'B', verify: ['fast', 'slow'] },
        { id: 'C', title: 'C', verify: ['fast', 'slow'] },
      ]),
    })
    await completed(co, q)
    const events = ledger(co, 'lane').events()
    const laneIds = (id) => checksOf(events, 'lane', id).map((e) => e.details.checkId)
    const covered = (id) => ofType(events, 'worker_verify_finished').find((e) => e.ticketId === id).details.coveredTip
    // A: checked against the base, which was still the tip at integration.
    assert.equal(covered('A'), base)
    assert.deepEqual(laneIds('A'), ['fast'])
    // B does not contain A's merge: its worker-side result covered nothing current, so everything runs again.
    assert.equal(covered('B'), null)
    const reverify = ofType(events, 'reverify')
    assert.ok(reverify.some((e) => e.ticketId === 'B' && ['not-covered', 'tip-moved'].includes(e.details.reason)))
    assert.ok(laneIds('B').includes('slow'))
    // C merged the integration branch, so its worker-side checks covered a real tip.
    assert.notEqual(covered('C'), null)
    const rc = reverify.find((e) => e.ticketId === 'C')
    if (rc) {
      // B landed between C's worker-side checks and its lane turn.
      assert.equal(rc.details.reason, 'tip-moved')
      assert.ok(laneIds('C').includes('slow'))
    } else assert.deepEqual(laneIds('C'), ['fast'])
    assert.ok(!reverify.some((e) => e.ticketId === 'A'))
  } finally {
    await co.close()
  }
})

test('worker mode with file selection filters the worker-side checks by the commit diff', { timeout: limit(120000) }, async (t) => {
  const { cwd } = await repo(t)
  const co = new Coordinator({
    checks: { fast: pass, slow },
    checkMeta: meta,
    integrationMode: 'worker',
    selectChecksByFiles: true,
    launch: worker(),
  })
  const q = { cwd, parentId: 'captain', runId: 'wf' }
  try {
    await co.start({ ...q, manifest: plan([{ id: 'D', title: 'docs', verify: ['fast', 'slow'] }]) })
    await completed(co, q)
    const events = ledger(co, 'wf').events()
    const selected = ofType(events, 'checks_selected').find((e) => e.details.stage === 'worker')
    assert.deepEqual(selected.details, { stage: 'worker', run: ['fast'], skipped: ['slow'], fallback: null, changed: 1 })
    assert.deepEqual(checksOf(events, 'worker', 'D').map((e) => e.details.checkId), ['fast'])
    assert.deepEqual(ofType(events, 'worker_verify_finished')[0].details.checks, ['fast'])
  } finally {
    await co.close()
  }
})

test('worker-end: the logic error is caught on the worker side, the lane runs only fast checks, the final check completes the run', { timeout: limit(120000) }, async (t) => {
  const { cwd } = await repo(t)
  const co = new Coordinator({ checks: { fast: pass, slow }, checkMeta: meta, integrationMode: 'worker-end', launch: worker() })
  const q = { cwd, parentId: 'captain', runId: 'we' }
  try {
    await co.start({
      ...q,
      manifest: plan([
        { id: 'A', title: 'A', verify: ['fast', 'slow'] },
        { id: 'L', title: 'L', depends_on: ['A'], verify: ['slow'] },
        { id: 'B', title: 'B', depends_on: ['L'], verify: ['fast'] },
      ]),
    })
    const done = await completed(co, q)
    const db = ledger(co, 'we')
    assert.deepEqual(db.meta().manifest.integration, { mode: 'worker-end', selectChecksByFiles: false, maxFinalRepairs: 2 })
    const events = db.events()
    // Found on the worker side and sent back to L itself, before L could land.
    const failure = checksOf(events, 'worker').find((e) => e.details.ok === false)
    assert.equal(failure.ticketId, 'L')
    assert.equal(failure.details.checkId, 'slow')
    assert.deepEqual(ofType(events, 'check_requeued').map((e) => e.ticketId), ['L'])
    // Never rerun in the lane: only fast, and no reverify.
    assert.ok(checksOf(events, 'lane').every((e) => e.details.checkId === 'fast'))
    assert.equal(ofType(events, 'reverify').length, 0)
    // The final full check of A's error-free tip passed; no repair ticket was needed.
    assert.equal(ofType(events, 'final_verify_failed').length, 0)
    assert.equal(ofType(events, 'final_verified').at(-1).details.tipSha, done.verifiedSha)
    assert.equal(ofType(events, 'run_completed').length, 1)
    assert.equal(done.tickets.length, 3)
    assert.equal(await git(cwd, 'show', 'integration/we:bug.txt'), 'ok')
  } finally {
    await co.close()
  }
})

test('worker-end + file selection: an error the worker side skipped is found by the final full check, located and repaired', { timeout: limit(120000) }, async (t) => {
  const { cwd } = await repo(t)
  const integrated = async (id) => (await co.status(q)).tickets.find((r) => r.id === id).status === 'INTEGRATED'
  // slow claims only src/**: a glob too narrow for bug.txt, so selection skips it for L.
  // L waits for B to land without merging it, so B is the first merge and L the second.
  const co = new Coordinator({
    checks: { fast: pass, slow },
    checkMeta: { fast: meta.fast, slow: { files: ['src/**'] } },
    integrationMode: 'worker-end',
    selectChecksByFiles: true,
    launch: worker([], async (job) => {
      if (job.ticketId === 'L') await until(() => integrated('B'), 'B landed')
    }),
  })
  const q = { cwd, parentId: 'captain', runId: 'aef' }
  try {
    await co.start({
      ...q,
      manifest: plan([
        { id: 'B', title: 'B', verify: ['fast', 'slow'] },
        { id: 'L', title: 'L', verify: ['fast'] },
      ]),
    })
    await completed(co, q)
    const db = ledger(co, 'aef')
    const events = db.events()
    const l = ofType(events, 'worker_verify_finished').find((e) => e.ticketId === 'L')
    assert.equal(l.details.ok, true)
    assert.equal(l.details.coveredTip, null, 'L does not contain B')
    assert.deepEqual(l.details.checks, ['fast'])
    const firstFailure = events.find((e) => e.type === 'check_finished' && e.details.checkId === 'slow' && e.details.ok === false)
    assert.equal(firstFailure.details.stage, 'final')
    const [failed] = ofType(events, 'final_verify_failed')
    assert.equal(failed.details.culprit, 'L')
    assert.equal(failed.details.repair, 'fix-L-1')
    assert.equal(db.get('fix-L-1').status, 'INTEGRATED')
    assert.equal(ofType(events, 'run_completed').length, 1)
    assert.equal(await git(cwd, 'show', 'integration/aef:bug.txt'), 'ok')
  } finally {
    await co.close()
  }
})

// Waits while the gate file exists. probes: only in a probe checkout; lane: only outside one.
const gated = (gate, where) => [
  [
    process.execPath,
    '-e',
    "const inProbe=process.cwd().includes('probes');if(process.argv[2]==='probes'?!inProbe:inProbe)process.exit(0);" +
      "const fs=require('fs');const t=setInterval(()=>{if(!fs.existsSync(process.argv[1]))clearInterval(t)},20)",
    gate,
    where,
  ],
]

test('worker-side checks of several submissions run in parallel, at most run.limit at once, outside the lane', { timeout: limit(120000) }, async (t) => {
  const { root, cwd } = await repo(t)
  const gate = join(root, 'gate')
  await writeFile(gate, '')
  const co = new Coordinator({ checks: { gate: gated(gate, 'probes') }, integrationMode: 'worker', launch: worker() })
  const q = { cwd, parentId: 'captain', runId: 'parallel' }
  const verifying = async () => (await co.status(q)).tickets.filter((r) => r.livePhase?.stage === 'worker')
  const checking = async () => (await verifying()).filter((r) => r.livePhase.checkId)
  try {
    await co.start({
      ...q,
      manifest: plan(['A', 'B', 'C'].map((id) => ({ id, title: id, verify: ['gate'] })), { max_workers: 2 }),
    })
    const two = await until(async () => ((await checking()).length === 2 ? checking() : null), 'two worker-side checks at once')
    assert.deepEqual(two[0].livePhase, { stage: 'worker', checkId: 'gate', index: 1, total: 1 })
    // The third commit queues for a slot; the lane stays free meanwhile.
    await until(async () => (await co.status(q)).tickets.filter((r) => r.status === 'SUBMITTED').length === 3, 'all submitted')
    for (let i = 0; i < 10; i++) {
      assert.ok((await verifying()).length <= 2)
      await sleep(30)
    }
    assert.equal(ofType(ledger(co, 'parallel').events(), 'verify_started').length, 0)
    await rm(gate)
    await completed(co, q)
    const events = ledger(co, 'parallel').events()
    assert.equal(ofType(events, 'worker_verify_finished').length, 3)
    // Each worker-side check began before any other ended, for the first two.
    const starts = checksOf(events, 'worker').map((e) => e.createdAt - e.details.ms)
    const ends = checksOf(events, 'worker').map((e) => e.createdAt)
    assert.ok(starts[1] < ends[0], 'overlapping worker-side checks')
  } finally {
    await co.close()
    await rm(gate, { force: true })
  }
})

test('a recorded worker-side result is reused after a restart instead of running again', { timeout: limit(120000) }, async (t) => {
  const { root, cwd } = await repo(t)
  const gate = join(root, 'gate')
  await writeFile(gate, '')
  const q = { cwd, parentId: 'captain', runId: 'reuse' }
  let co
  const laneOn = async (id) => (await co.status(q)).tickets.find((r) => r.id === id)?.livePhase?.stage === 'verify'
  const settings = {
    checks: { fast: pass, gate: gated(gate, 'lane') },
    checkMeta: { gate: { fast: true } },
    integrationMode: 'worker',
    // X commits only once Y holds the lane, so X's checked commit has to wait for it.
    launch: worker([], async (job) => {
      if (job.ticketId === 'X') await until(() => laneOn('Y'), 'Y in the lane')
    }),
  }
  co = new Coordinator(settings)
  try {
    await co.start({
      ...q,
      manifest: plan([
        { id: 'Y', title: 'Y', verify: ['gate'] },
        { id: 'X', title: 'X', verify: ['fast'] },
      ]),
    })
    await until(
      () => ofType(ledger(co, 'reuse').events(), 'worker_verify_finished').some((e) => e.ticketId === 'X'),
      'X checked on the worker side',
    )
    const sha = ledger(co, 'reuse').get('X').sourceSha
    await co.close()
    co = new Coordinator({ ...settings, launch: worker() })
    await co.attach(q)
    await until(async () => (await co.status(q)).tickets.find((r) => r.id === 'X').status === 'INTEGRATED', 'X integrated')
    const events = ledger(co, 'reuse').events()
    const results = ofType(events, 'worker_verify_finished').filter((e) => e.ticketId === 'X')
    assert.equal(results.length, 1, 'not checked again')
    assert.equal(results[0].details.sourceSha, sha)
    assert.equal(checksOf(events, 'worker', 'X').length, 1)
  } finally {
    await co.close()
    await rm(gate, { force: true })
  }
})

test('worker modes are accepted and frozen into the manifest', () => {
  const tickets = [{ id: 'A', title: 'A', verify: ['fast'] }]
  const w = normalizeManifest(plan(tickets), { fast: pass }, {}, { integrationMode: 'worker' })
  assert.deepEqual(w.integration, { mode: 'worker', selectChecksByFiles: false })
  const we = normalizeManifest(plan(tickets, { integration: { mode: 'worker-end', select_checks_by_files: true } }), { fast: pass })
  assert.deepEqual(we.integration, { mode: 'worker-end', selectChecksByFiles: true, maxFinalRepairs: 2 })
})
