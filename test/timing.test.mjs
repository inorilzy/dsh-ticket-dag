import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { promisify } from 'node:util'
import { Coordinator } from '../src/coordinator.mjs'
import { RunCatalog, readLedger } from '../src/dashboard.mjs'
import { runTiming } from '../src/timing.mjs'

// [createdAt, type, ticketId?, details?]
const rows = (list) =>
  list.map(([createdAt, type, ticketId = null, details = {}]) => ({
    type,
    ticketId,
    attempt: null,
    createdAt,
    details,
  }))
const active = [0, 'run_started', null, { mode: 'active' }]
const staged = [0, 'run_started', null, { mode: 'staged' }]

// The shape of the gh1-fixes-02 ledger, plus the verification events. A fails
// and is retried, B conflicts once, C arrives after the first completion.
const gh1 = [
  staged,
  [100, 'run_approved'],
  [110, 'claimed', 'A'],
  [120, 'claimed', 'B'],
  [200, 'needs_attention', 'A'],
  [300, 'submitted', 'B'],
  [320, 'conflict_requeued', 'B'],
  [500, 'retry_requested', 'A'],
  [510, 'claimed', 'A'],
  [520, 'claimed', 'B'],
  [600, 'submitted', 'A'],
  [610, 'submitted', 'B'],
  [650, 'verify_started', 'A', { checks: ['unit'] }],
  [700, 'check_finished', 'A', { checkId: 'unit', ms: 50, ok: true }],
  [710, 'publishing', 'A'],
  [720, 'integrated', 'A'],
  [730, 'verify_started', 'B', { checks: ['unit'] }],
  [780, 'check_finished', 'B', { checkId: 'unit', ms: 50, ok: true }],
  [790, 'publishing', 'B'],
  [800, 'integrated', 'B'],
  [800, 'run_completed'],
  [1800, 'tickets_appended'],
  [1810, 'claimed', 'C'],
  [1900, 'submitted', 'C'],
  [1910, 'verify_started', 'C', { checks: [] }],
  [1920, 'publishing', 'C'],
  [1930, 'integrated', 'C'],
  [1930, 'run_completed'],
]

test('a plan still waiting for approval has no timing', () => {
  assert.equal(runTiming(rows([staged]), 5000), null)
  assert.equal(runTiming(rows([staged, [50, 'tickets_appended'], [60, 'run_blocked']]), 5000), null)
  // Discarded at review: it never ran.
  assert.equal(runTiming(rows([staged, [50, 'run_cancelled']]), 5000), null)
  assert.equal(runTiming([], 5000), null)
})

test('review time is not counted once the plan is approved', () => {
  const timing = runTiming(rows([staged, [100, 'run_approved']]), 400)
  assert.equal(timing.startedAt, 100)
  assert.equal(timing.runningSince, 100)
  assert.equal(timing.accumulatedMs, 300)
  assert.equal(timing.endedAt, null)
})

test('a run that needs no approval counts from its start', () => {
  const timing = runTiming(rows([active, [10, 'claimed', 'A']]), 100)
  assert.equal(timing.startedAt, 0)
  assert.equal(timing.accumulatedMs, 100)
  assert.equal(timing.runningSince, 0)
  // An open attempt counts up to now.
  assert.equal(timing.tickets.A.workerMs, 90)
  assert.equal(timing.tickets.A.attempts, 1)
})

test('the gh1-fixes-02 sequence gives the documented numbers', () => {
  assert.deepEqual(runTiming(rows(gh1), 99999), {
    startedAt: 100,
    endedAt: 1930,
    // 100..800 plus 1800..1930; the idle second before the append is not counted.
    accumulatedMs: 830,
    runningSince: null,
    attentionMs: 300,
    tickets: {
      A: { attempts: 2, workerMs: 180, queueMs: 50, verifyMs: 50, attentionMs: 300 },
      // Its conflicted submission waited 20 before going back to the worker.
      B: { attempts: 2, workerMs: 270, queueMs: 140, verifyMs: 50, attentionMs: 0 },
      C: { attempts: 1, workerMs: 90, queueMs: 10, verifyMs: 0, attentionMs: 0 },
    },
    totals: {
      workerMs: 540,
      queueMs: 200,
      verifyMs: 100,
      checkRuns: 2,
      checkFailures: 0,
      conflicts: 1,
      attempts: 5,
      // A ledger without selection or run-level stages records none of these.
      skippedChecks: 0,
      finalVerifyMs: 0,
      workerVerifyMs: 0,
    },
  })
})

test('completion stops the clock and an append restarts it', () => {
  const first = gh1.findIndex(([, type]) => type === 'run_completed')
  const settled = runTiming(rows(gh1.slice(0, first + 1)), 1500)
  assert.equal(settled.accumulatedMs, 700)
  assert.equal(settled.endedAt, 800)
  assert.equal(settled.runningSince, null)
  const appended = runTiming(rows(gh1.slice(0, first + 2)), 1850)
  assert.equal(appended.accumulatedMs, 750)
  assert.equal(appended.endedAt, null)
  assert.equal(appended.runningSince, 1800)
})

test('pause and resume leave a gap; an append while paused does not resume', () => {
  const timing = runTiming(
    rows([
      active,
      [100, 'run_paused'],
      [150, 'tickets_appended'],
      [200, 'run_active'],
      [300, 'run_blocked'],
      [400, 'run_active'],
    ]),
    450,
  )
  assert.equal(timing.accumulatedMs, 100 + 100 + 50)
  assert.equal(timing.runningSince, 400)
  const held = runTiming(rows([active, [100, 'run_paused'], [150, 'tickets_appended']]), 9000)
  assert.equal(held.accumulatedMs, 100)
  assert.equal(held.endedAt, 100)
  assert.equal(held.runningSince, null)
})

test('resuming a settled run does not restart the clock without new tickets', () => {
  const timing = runTiming(rows([active, [100, 'run_completed'], [200, 'run_paused'], [300, 'run_active']]), 9000)
  assert.equal(timing.accumulatedMs, 100)
  assert.equal(timing.runningSince, null)
})

test('cancelling ends the clock and bounds an attempt nobody settled', () => {
  const timing = runTiming(rows([active, [10, 'claimed', 'A'], [100, 'run_cancelled']]), 9000)
  assert.equal(timing.accumulatedMs, 100)
  assert.equal(timing.endedAt, 100)
  assert.equal(timing.runningSince, null)
  assert.equal(timing.tickets.A.workerMs, 90)
})

test('attention is the union across tickets and only counts running time', () => {
  const timing = runTiming(
    rows([
      active,
      [100, 'needs_attention', 'A'],
      [200, 'needs_attention', 'B'],
      [300, 'retry_requested', 'A'],
      [350, 'run_paused'],
      [850, 'run_active'],
      // A second way out: dag_retry submitting the worker's commit.
      [900, 'submitted', 'B', { from: 'NEEDS_ATTENTION' }],
    ]),
    1000,
  )
  assert.equal(timing.attentionMs, 100 + 100 + 50 + 50)
  assert.equal(timing.tickets.A.attentionMs, 200)
  assert.equal(timing.tickets.B.attentionMs, 150 + 50)
  assert.equal(timing.accumulatedMs, 500)
})

test('an attention still open counts up to now', () => {
  const timing = runTiming(rows([active, [100, 'needs_attention', 'A']]), 400)
  assert.equal(timing.attentionMs, 300)
})

test('a check stopped by cancel is a run but not a failure', () => {
  const { totals } = runTiming(
    rows([
      active,
      [10, 'verify_started', 'A', { checks: ['x', 'y'] }],
      [20, 'check_finished', 'A', { checkId: 'x', ms: 10, ok: false }],
      [30, 'check_finished', 'A', { checkId: 'y', ms: 10, ok: false, aborted: true }],
    ]),
    40,
  )
  assert.equal(totals.checkRuns, 2)
  assert.equal(totals.checkFailures, 1)
  assert.equal(totals.verifyMs, 20)
})

test('an old ledger without verification events reports neither queue nor verify', () => {
  // Written before run_started named its mode.
  const old = gh1
    .filter(([, type]) => type !== 'verify_started' && type !== 'check_finished')
    .map((row) => (row[1] === 'run_started' ? [0, 'run_started', null, { ref: 'r', baseSha: 'b' }] : row))
  const timing = runTiming(rows(old), 99999)
  assert.equal(timing.accumulatedMs, 830)
  assert.equal(timing.attentionMs, 300)
  assert.equal(timing.tickets.A.workerMs, 180)
  assert.equal(timing.tickets.A.queueMs, null)
  assert.equal(timing.tickets.A.verifyMs, null)
  assert.equal(timing.totals.workerMs, 540)
  assert.equal(timing.totals.queueMs, null)
  assert.equal(timing.totals.verifyMs, null)
  assert.equal(timing.totals.checkRuns, 0)

  // Started without approval and with a claim: it ran. Without a claim: it may be a plan.
  const unapproved = [[0, 'run_started', null, { ref: 'r', baseSha: 'b' }]]
  assert.equal(runTiming(rows(unapproved), 100), null)
  assert.equal(runTiming(rows([...unapproved, [10, 'claimed', 'A']]), 100).accumulatedMs, 100)

  // A ledger upgraded mid-run cannot split its earlier tickets, so totals stay unknown.
  const mixed = runTiming(
    rows([
      active,
      [10, 'claimed', 'A'],
      [20, 'submitted', 'A'],
      [30, 'integrated', 'A'],
      [40, 'claimed', 'B'],
      [50, 'submitted', 'B'],
      [60, 'verify_started', 'B', { checks: [] }],
    ]),
    100,
  )
  assert.equal(mixed.tickets.A.queueMs, null)
  assert.equal(mixed.tickets.B.queueMs, 10)
  assert.equal(mixed.totals.queueMs, null)
})

test('a ticket id that is an Object.prototype name stays an ordinary row', () => {
  const timing = runTiming(rows([active, [10, 'claimed', 'constructor'], [20, 'submitted', 'constructor']]), 30)
  assert.equal(timing.tickets.constructor.workerMs, 10)
})

const exec = promisify(execFile)
const env = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
}
const git = async (cwd, ...args) => (await exec('git', args, { cwd, env })).stdout.trim()

async function repo(t) {
  const root = await mkdtemp(join(tmpdir(), 'dag-timing-'))
  const cwd = join(root, 'project')
  await mkdir(cwd)
  await git(cwd, 'init', '-q', '-b', 'main')
  await git(cwd, 'config', 'user.name', 'fixture')
  await git(cwd, 'config', 'user.email', 'fixture@example.invalid')
  await git(cwd, 'commit', '--allow-empty', '-qm', 'seed')
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }))
  return cwd
}

function coordinator(checks) {
  return new Coordinator({
    maxWorkers: 4,
    checks,
    notify: async () => true,
    launch: async (job) => {
      await writeFile(join(job.cwd, job.ticketId + '.txt'), job.ticketId)
      await git(job.cwd, 'add', '--', job.ticketId + '.txt')
      const trailers = [
        'DAG-Run: ' + job.runId,
        'DAG-Ticket: ' + job.ticketId,
        'DAG-Attempt: ' + job.attempt,
        'DAG-Complete: yes',
      ].join('\n')
      await git(job.cwd, 'commit', '-qm', 'Deliver ' + job.ticketId, '-m', trailers)
      return { result: Promise.resolve({ ok: true }), dispose: async () => {} }
    },
  })
}

async function until(check, label) {
  const deadline = Date.now() + 240000
  while (Date.now() < deadline) {
    const value = await check()
    if (value) return value
    await sleep(40)
  }
  throw Error('Timeout: ' + label)
}

test('the integration lane records verification; attached and read-only paths agree', { timeout: 300000 }, async (t) => {
  const cwd = await repo(t)
  const co = coordinator({ verify: [[process.execPath, '-e', 'process.exit(0)']] })
  const q = { cwd, parentId: 'captain', runId: 'timed' }
  let closed = false
  try {
    await co.start({
      ...q,
      manifest: {
        spec_id: 'timed',
        tickets: [
          { id: 'bare', title: 'no verify' },
          { id: 'checked', title: 'verify', depends_on: ['bare'], verify: ['verify'] },
        ],
      },
    })
    await until(async () => (await co.status(q)).complete, 'run completes')
    const [[file, run]] = co.runs
    const events = run.db.events()

    const started = events.filter((e) => e.type === 'verify_started')
    assert.deepEqual(started.map((e) => [e.ticketId, e.details.checks]), [
      ['bare', []],
      ['checked', ['verify']],
    ])
    const finished = events.filter((e) => e.type === 'check_finished')
    assert.equal(finished.length, 1)
    assert.equal(finished[0].ticketId, 'checked')
    assert.equal(finished[0].details.checkId, 'verify')
    assert.equal(finished[0].details.ok, true)
    assert.ok(Number.isInteger(finished[0].details.ms) && finished[0].details.ms >= 0)

    const outbox = new DatabaseSync(file, { readOnly: true })
    try {
      const noticed = outbox
        .prepare('SELECT e.type FROM outbox o JOIN events e ON e.id=o.eventId')
        .all()
        .map((row) => row.type)
      assert.ok(noticed.includes('run_completed'))
      assert.ok(!noticed.includes('verify_started') && !noticed.includes('check_finished'))
    } finally {
      outbox.close()
    }

    const status = await co.status(q)
    assert.equal(status.timing.totals.checkRuns, 1)
    assert.equal(status.timing.totals.attempts, 2)
    assert.equal(status.timing.tickets.bare.verifyMs, 0)
    assert.equal(typeof status.timing.tickets.bare.queueMs, 'number')
    assert.equal(typeof status.now, 'number')
    // Only the selected row pays for the event read.
    assert.equal(co.peek(file).timing, undefined)

    const now = Date.now()
    const meta = run.db.meta()
    const entry = { runId: meta.runId, parentId: meta.parentId }
    assert.deepEqual(readLedger(file, entry, true, 16, {}, now).timing, co.peek(file, now).timing)

    const catalog = new RunCatalog()
    catalog.remember(file, meta, 1)
    const live = catalog.read(co, null).selected
    assert.equal(live.attached, true)
    assert.equal(typeof live.now, 'number')
    await co.close()
    closed = true
    const cold = catalog.read({ maxWorkers: 16, runs: new Map() }, null).selected
    assert.equal(cold.attached, false)
    assert.deepEqual(cold.timing, live.timing)
  } finally {
    if (!closed) await co.close()
  }
})

test('a failing check is recorded and counted', { timeout: 300000 }, async (t) => {
  const cwd = await repo(t)
  const co = coordinator({ verify: [[process.execPath, '-e', 'process.exit(3)']] })
  const q = { cwd, parentId: 'captain', runId: 'failing' }
  try {
    await co.start({
      ...q,
      manifest: { spec_id: 'failing', tickets: [{ id: 'A', title: 'A', verify: ['verify'] }] },
    })
    const status = await until(async () => {
      const s = await co.status(q)
      return s.counts.NEEDS_ATTENTION === 1 && s
    }, 'ticket fails its check')
    assert.equal(status.timing.totals.checkRuns, 1)
    assert.equal(status.timing.totals.checkFailures, 1)
    const [[, run]] = co.runs
    assert.equal(run.db.events().find((e) => e.type === 'check_finished').details.ok, false)
  } finally {
    await co.close()
  }
})
