import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { promisify } from 'node:util'
import { Coordinator } from '../src/coordinator.mjs'
import * as gitApi from '../src/git.mjs'
import { normalizeManifest } from '../src/store.mjs'

// Same fixtures as test/check-selection-run.test.mjs: a throwaway repository
// and a scripted worker that commits one file with the DAG trailers.
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
    await sleep(40)
  }
  throw Error('Timeout: ' + label)
}
async function repo(t) {
  const root = await mkdtemp(join(tmpdir(), 'dag-end-'))
  const cwd = join(root, 'project')
  await mkdir(cwd)
  await git(cwd, 'init', '-q', '-b', 'main')
  await git(cwd, 'config', 'user.name', 'fixture')
  await git(cwd, 'config', 'user.email', 'fixture@example.invalid')
  await git(cwd, 'commit', '--allow-empty', '-qm', 'seed')
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }))
  return { root, cwd }
}
// L writes bug.txt=bad; a fix-* ticket writes bug.txt=ok; others write <id>.txt.
function worker(seen = []) {
  return async (job) => ({
    dispose: async () => {},
    result: (async () => {
      seen.push(job)
      const fix = job.ticketId.startsWith('fix-')
      const file = fix || job.ticketId === 'L' ? 'bug.txt' : 'src/' + job.ticketId + '.txt'
      await mkdir(dirname(join(job.cwd, file)), { recursive: true })
      await writeFile(join(job.cwd, file), fix ? 'ok\n' : job.ticketId === 'L' ? 'bad\n' : job.ticketId + '\n')
      await git(job.cwd, 'add', '--', file)
      const trailers = ['DAG-Run: ' + job.runId, 'DAG-Ticket: ' + job.ticketId, 'DAG-Attempt: ' + job.attempt, 'DAG-Complete: yes']
      await git(job.cwd, 'commit', '-qm', 'Deliver ' + job.ticketId, '-m', trailers.join('\n'))
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
// Waits while the given absolute file exists, so a test can hold a final check open.
const blocking = (gate) => [
  [process.execPath, '-e', "const fs=require('fs');const t=setInterval(()=>{if(!fs.existsSync(process.argv[1]))clearInterval(t)},20)", gate],
]
const meta = { fast: { files: ['**'], fast: true }, slow: { files: ['src/**', 'bug.txt'] } }
const plan = (tickets, extra = {}) => ({ spec_id: 'end', max_workers: 4, tickets, ...extra })
const three = [
  { id: 'A', title: 'A', verify: ['fast', 'slow'] },
  { id: 'L', title: 'L', depends_on: ['A'], verify: ['slow'] },
  { id: 'B', title: 'B', depends_on: ['L'], verify: ['fast'] },
]
const ledger = (co, runId) => [...co.runs.values()].find((r) => r.db.meta().runId === runId).db
const lane = (events) => events.filter((e) => e.type === 'check_finished' && e.ticketId)
const ofType = (events, type) => events.filter((e) => e.type === type)
async function completed(co, q) {
  return until(async () => {
    const s = await co.status(q)
    if (s.counts.NEEDS_ATTENTION) throw Error(JSON.stringify(s.tickets.map((r) => [r.id, r.status, r.message])))
    if (s.diagnostic) throw Error(s.diagnostic)
    return s.complete && s
  }, 'run complete')
}

test('end mode: the lane runs only fast checks; the final check finds, locates and repairs the logic error', { timeout: limit(180000) }, async (t) => {
  const { cwd } = await repo(t)
  const notices = []
  const seen = []
  const co = new Coordinator({
    checks: { fast: pass, slow },
    checkMeta: meta,
    integrationMode: 'end',
    launch: worker(seen),
    notify: async (n) => {
      notices.push(n.text)
      return true
    },
  })
  const q = { cwd, parentId: 'captain', runId: 'end' }
  try {
    const started = await co.start({ ...q, manifest: plan(three) })
    assert.deepEqual(started.integration, { mode: 'end', selectChecksByFiles: false })
    const done = await completed(co, q)
    const db = ledger(co, 'end')
    assert.deepEqual(db.meta().manifest.integration, { mode: 'end', selectChecksByFiles: false, maxFinalRepairs: 2 })
    const events = db.events()
    // slow never runs in the lane, L's bad merge lands untouched.
    assert.ok(lane(events).every((e) => e.details.checkId === 'fast'), JSON.stringify(lane(events).map((e) => e.details)))
    assert.deepEqual(ofType(events, 'verify_started').find((e) => e.ticketId === 'L').details.checks, ['fast'])
    // First final check: both IDs at the first tip, slow fails.
    const [first, second] = ofType(events, 'final_verify_started')
    assert.deepEqual(first.details.checks, ['fast', 'slow'])
    const [failed] = ofType(events, 'final_verify_failed')
    const l = db.get('L')
    assert.equal(failed.details.tipSha, first.details.tipSha)
    assert.deepEqual(failed.details.failed, ['slow'])
    assert.equal(failed.details.culprit, 'L')
    assert.equal(failed.details.culpritSha, l.landedSha)
    assert.equal(failed.details.repair, 'fix-L-1')
    // Bisection reran only slow, at merges before the tip.
    const bisect = events.filter((e) => e.type === 'check_finished' && e.details.stage === 'bisect')
    assert.ok(bisect.length >= 1 && bisect.every((e) => e.details.checkId === 'slow' && e.ticketId === null))
    assert.ok(ofType(events, 'bisect_step').length >= 1)
    // The fix: same agent as L, verify L's checks plus the failed ones, a prompt with the evidence.
    const fix = db.get('fix-L-1')
    assert.equal(fix.status, 'INTEGRATED')
    assert.deepEqual(fix.verify, ['slow'])
    const prompt = seen.find((j) => j.ticketId === 'fix-L-1').prompt
    for (const part of ['"slow"', l.landedSha, 'bug.txt is bad', 'Do not revert other tickets']) assert.ok(prompt.includes(part), part)
    // The second final check passes at the new tip and completes the run, once.
    assert.ok(second)
    assert.equal(ofType(events, 'final_verified').at(-1).details.tipSha, done.verifiedSha)
    const completions = ofType(events, 'run_completed')
    assert.equal(completions.length, 1)
    assert.ok(events.indexOf(completions[0]) > events.indexOf(ofType(events, 'final_verified').at(-1)))
    assert.ok(notices.some((n) => /Final check failed \(slow\).*located L, appended fix-L-1/.test(n)))
    assert.equal(await git(cwd, 'show', 'integration/end:bug.txt'), 'ok')
    const timing = (await co.status(q)).timing
    assert.ok(timing.totals.finalVerifyMs > 0)
    assert.ok(timing.endedAt >= completions[0].createdAt)
    // Probes are released after use.
    const probes = join(dirname(cwd), '.dsh-ticket-worktrees')
    const list = await git(cwd, 'worktree', 'list', '--porcelain')
    assert.doesNotMatch(list, /probes/, probes)
  } finally {
    await co.close()
  }
})

// A plan that marks no check fast (the captain wrote no check_meta) must not land
// tickets unchecked: the lane runs every check, and the final check runs once more.
test('end mode without fast checks runs every check in the lane', { timeout: limit(120000) }, async (t) => {
  const { cwd } = await repo(t)
  const co = new Coordinator({ checks: { slow }, integrationMode: 'end', launch: worker() })
  const q = { cwd, parentId: 'captain', runId: 'merge-only' }
  try {
    await co.start({
      ...q,
      manifest: plan([
        { id: 'A', title: 'A', verify: ['slow'] },
        { id: 'B', title: 'B', verify: ['slow'] },
      ]),
    })
    await completed(co, q)
    const events = ledger(co, 'merge-only').events()
    assert.deepEqual(lane(events).map((e) => [e.ticketId, e.details.checkId]).sort(), [['A', 'slow'], ['B', 'slow']])
    assert.ok(ofType(events, 'verify_started').every((e) => e.details.checks.join() === 'slow'))
    assert.deepEqual(
      events.filter((e) => e.type === 'check_finished' && e.details.stage === 'final').map((e) => e.details.checkId),
      ['slow'],
    )
  } finally {
    await co.close()
  }
})

test('end + file selection: the lane filters the fast checks, the final check runs everything', { timeout: limit(120000) }, async (t) => {
  const { cwd } = await repo(t)
  const co = new Coordinator({
    checks: { fast: pass, slow, docs: pass },
    checkMeta: { ...meta, docs: { files: ['docs/**'], fast: true } },
    integrationMode: 'end',
    selectChecksByFiles: true,
    launch: worker(),
  })
  const q = { cwd, parentId: 'captain', runId: 'af' }
  try {
    await co.start({ ...q, manifest: plan([{ id: 'A', title: 'A', verify: ['fast', 'slow', 'docs'] }]) })
    await completed(co, q)
    const events = ledger(co, 'af').events()
    const [selected] = ofType(events, 'checks_selected')
    assert.deepEqual(selected.details, { stage: 'lane', run: ['fast'], skipped: ['docs'], fallback: null, changed: 1 })
    assert.deepEqual(ofType(events, 'final_verify_started')[0].details.checks, ['fast', 'slow', 'docs'])
    assert.equal(ofType(events, 'checks_selected').length, 1, 'no selection in the final check')
  } finally {
    await co.close()
  }
})

test('a final check interrupted by shutdown runs again after restart; cancel aborts a running one', { timeout: limit(180000) }, async (t) => {
  const { root, cwd } = await repo(t)
  const gate = join(root, 'gate')
  await writeFile(gate, '')
  // fast marks the plan as having a lane check, so the blocking gate runs only in the final check.
  const settings = {
    checks: { gate: blocking(gate), fast: pass },
    checkMeta: { fast: { fast: true } },
    integrationMode: 'end',
    launch: worker(),
  }
  const q = { cwd, parentId: 'captain', runId: 'restart' }
  let co = new Coordinator(settings)
  try {
    await co.start({ ...q, manifest: plan([{ id: 'A', title: 'A', verify: ['gate', 'fast'] }]) })
    const phase = await until(async () => (await co.status(q)).finalPhase?.checkId && (await co.status(q)).finalPhase, 'final check running')
    assert.deepEqual(phase, { stage: 'final', checkId: 'gate', index: 1, total: 2 })
    await co.close()
    co = new Coordinator(settings)
    await co.attach(q)
    await until(async () => (await co.status(q)).finalPhase?.checkId && (await co.status(q)).finalPhase, 'final check restarted')
    await rm(gate)
    await completed(co, q)
    const events = ledger(co, 'restart').events()
    assert.equal(ofType(events, 'final_verify_started').length, 2)
    assert.ok(events.some((e) => e.type === 'check_finished' && e.details.aborted && e.details.stage === 'final'))
    assert.equal(ofType(events, 'run_completed').length, 1)
  } finally {
    await co.close()
  }

  await writeFile(gate, '')
  const c = { cwd, parentId: 'captain', runId: 'cancel' }
  co = new Coordinator(settings)
  try {
    await co.start({ ...c, manifest: plan([{ id: 'A', title: 'A', verify: ['gate', 'fast'] }]) })
    await until(async () => (await co.status(c)).finalPhase?.checkId && (await co.status(c)).finalPhase, 'final check running')
    const began = Date.now()
    const cancelled = await co.cancel(c)
    assert.ok(Date.now() - began < limit(20000))
    assert.equal(cancelled.mode, 'cancelled')
    assert.equal(cancelled.finalPhase, null)
    assert.equal(cancelled.complete, false)
    const events = ledger(co, 'cancel').events()
    assert.equal(ofType(events, 'run_completed').length, 0)
    assert.equal(ofType(events, 'final_verified').length, 0)
    assert.ok(events.some((e) => e.type === 'check_finished' && e.details.aborted && e.details.stage === 'final'))
  } finally {
    await co.close()
    await rm(gate, { force: true })
  }
})

test('past maxFinalRepairs the run is held with a diagnostic naming the located ticket', { timeout: limit(120000) }, async (t) => {
  const { cwd } = await repo(t)
  const notices = []
  const co = new Coordinator({
    checks: { fast: pass, slow },
    checkMeta: meta,
    integrationMode: 'end',
    maxFinalRepairs: 0,
    launch: worker(),
    notify: async (n) => {
      notices.push(n.text)
      return true
    },
  })
  const q = { cwd, parentId: 'captain', runId: 'held' }
  try {
    await co.start({ ...q, manifest: plan(three) })
    const held = await until(async () => {
      const s = await co.status(q)
      return s.mode === 'paused' && s
    }, 'run held')
    assert.equal(held.complete, false)
    assert.match(held.diagnostic, /Final checks slow failed at [0-9a-f]{40}; first failing merge [0-9a-f]{40} landed L/)
    assert.match(held.diagnostic, /maxFinalRepairs 0/)
    const events = ledger(co, 'held').events()
    const [failed] = ofType(events, 'final_verify_failed')
    assert.equal(failed.details.culprit, 'L')
    assert.equal(failed.details.repair, null)
    assert.equal(held.tickets.length, 3, 'no fix ticket appended')
    await until(() => notices.some((n) => /Final checks slow failed/.test(n)), 'captain notified')
  } finally {
    await co.close()
  }
})

test('maxFinalRepairs is frozen only for end modes; other manifests are unchanged', () => {
  const checks = { fast: pass }
  const tickets = [{ id: 'A', title: 'A', verify: ['fast'] }]
  const each = normalizeManifest(plan(tickets), checks, {}, { maxFinalRepairs: 5 })
  assert.equal(Object.hasOwn(each, 'integration'), false)
  const end = normalizeManifest(plan(tickets), checks, {}, { integrationMode: 'end', maxFinalRepairs: 5 })
  assert.deepEqual(end.integration, { mode: 'end', selectChecksByFiles: false, maxFinalRepairs: 5 })
  assert.deepEqual(normalizeManifest(end, checks), end, 'a stored manifest normalizes to itself')
  const own = normalizeManifest(plan(tickets, { integration: { mode: 'end', max_final_repairs: 0 } }), checks)
  assert.equal(own.integration.maxFinalRepairs, 0)
  assert.throws(
    () => normalizeManifest(plan(tickets, { integration: { mode: 'end', max_final_repairs: 11 } }), checks),
    /between 0 and 10/,
  )
})

test('probe helpers only remove the clean probe they created', async (t) => {
  const { root, cwd } = await repo(t)
  const info = await gitApi.repoInfo(cwd)
  const sha = await git(cwd, 'rev-parse', 'HEAD')
  const probe = join(root, 'probes', 'one')
  await gitApi.addProbe(info, probe, sha)
  // Re-adopting the same clean probe is allowed.
  await gitApi.addProbe(info, probe, sha)
  await writeFile(join(probe, 'left.txt'), 'x')
  await assert.rejects(gitApi.releaseProbe(info, probe, sha), /local changes|untracked/)
  await rm(join(probe, 'left.txt'))
  await gitApi.releaseProbe(info, probe, sha)
  assert.equal(existsSync(probe), false)
  // A worktree the plugin did not mark as a probe is refused.
  const other = join(root, 'other')
  await git(cwd, 'worktree', 'add', '--detach', other, sha)
  await assert.rejects(gitApi.releaseProbe(info, other, sha), /not a probe owned by dsh-ticket-dag/)
  await assert.rejects(gitApi.addProbe(info, other, sha), /not a probe owned by dsh-ticket-dag/)
  assert.equal(existsSync(other), true)
})
