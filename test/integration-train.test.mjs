import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { promisify } from 'node:util'
import { Coordinator } from '../src/coordinator.mjs'
import { normalizeManifest } from '../src/store.mjs'

// Same fixtures as test/integration-end.test.mjs: a throwaway repository and a
// scripted worker that commits one file with the DAG trailers.
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
  throw Error('Timeout: ' + (typeof label === 'function' ? await label() : label))
}
async function repo(t) {
  const root = await mkdtemp(join(tmpdir(), 'dag-train-'))
  const cwd = join(root, 'project')
  await mkdir(cwd)
  await git(cwd, 'init', '-q', '-b', 'main')
  await git(cwd, 'config', 'user.name', 'fixture')
  await git(cwd, 'config', 'user.email', 'fixture@example.invalid')
  await writeFile(join(cwd, 'shared.txt'), 'base\n')
  await git(cwd, 'add', '.')
  await git(cwd, 'commit', '-qm', 'seed')
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }))
  return { root, cwd }
}
const stamp = async (job, subject) => {
  const trailers = ['DAG-Run: ' + job.runId, 'DAG-Ticket: ' + job.ticketId, 'DAG-Attempt: ' + job.attempt, 'DAG-Complete: yes']
  await git(job.cwd, 'commit', '-q', '--allow-empty', '-m', subject, '-m', trailers.join('\n'))
}
/**
 * files: ticket → [path, content]; hold: ticket → promise the first attempt waits
 * for before it returns. A conflict retry merges the integration branch keeping
 * both sides; a merge-train failure writes bug.txt=ok.
 */
function worker({ files = {}, hold = {}, seen = [] } = {}) {
  return async (job) => ({
    dispose: async () => {},
    result: (async () => {
      seen.push(job)
      if (/conflicted with the integration branch/.test(job.prompt)) {
        try {
          await git(job.cwd, 'merge', '--no-ff', '--no-commit', 'integration/' + job.runId)
        } catch {
          for (const f of (await git(job.cwd, 'diff', '--name-only', '--diff-filter=U')).split('\n').filter(Boolean)) {
            const body = await readFile(join(job.cwd, f), 'utf8')
            await writeFile(join(job.cwd, f), body.split('\n').filter((l) => !/^(<{7}|={7}|>{7})/.test(l)).join('\n'))
            await git(job.cwd, 'add', '--', f)
          }
        }
        await stamp(job, 'Merge integration into ' + job.ticketId)
      } else if (/Merge-train checks failed/.test(job.prompt)) {
        await writeFile(join(job.cwd, 'bug.txt'), 'ok\n')
        await git(job.cwd, 'add', '--', 'bug.txt')
        await stamp(job, 'Fix ' + job.ticketId)
      } else {
        const [file, body] = files[job.ticketId] ?? ['src/' + job.ticketId + '.txt', job.ticketId + '\n']
        await mkdir(dirname(join(job.cwd, file)), { recursive: true })
        await writeFile(join(job.cwd, file), body)
        await git(job.cwd, 'add', '--', file)
        await stamp(job, 'Deliver ' + job.ticketId)
      }
      if (job.attempt === 1) await hold[job.ticketId]
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
// Waits while the given absolute file exists, so a test can hold a train open.
const blocking = (gate) => [
  [process.execPath, '-e', "const fs=require('fs');const t=setInterval(()=>{if(!fs.existsSync(process.argv[1]))clearInterval(t)},20)", gate],
]
const plan = (tickets, extra = {}) => ({ spec_id: 'train', max_workers: 8, tickets, ...extra })
const ledger = (co, runId) => [...co.runs.values()].find((r) => r.db.meta().runId === runId).db
const ofType = (events, type) => events.filter((e) => e.type === type)
const deferred = () => {
  let resolve
  const promise = new Promise((r) => (resolve = r))
  return { promise, resolve }
}
async function completed(co, q) {
  return until(async () => {
    const s = await co.status(q)
    if (s.counts.NEEDS_ATTENTION) throw Error(JSON.stringify(s.tickets.map((r) => [r.id, r.status, r.message])))
    if (s.diagnostic) throw Error(s.diagnostic)
    return s.complete && s
  }, 'run complete')
}
// The landed ticket of each first-parent merge on the integration branch, oldest first.
async function landedOrder(cwd, db, runId) {
  const base = db.meta().baseSha
  const merges = (await git(cwd, 'rev-list', '--first-parent', '--reverse', base + '..integration/' + runId)).split('\n').filter(Boolean)
  const bySha = new Map(db.tickets().map((t) => [t.landedSha, t.id]))
  return merges.map((sha) => bySha.get(sha) ?? sha)
}
// Holds ticket Z's train on a gate while the others submit, then lets them go in the given order.
async function queueBehind(co, q, gate, release, order) {
  await until(async () => (await co.status(q)).trainPhase?.checkId === 'gate', 'first train running')
  for (const id of order) {
    release[id].resolve()
    await until(async () => (await co.status(q)).tickets.find((t) => t.id === id).status === 'SUBMITTED', id + ' submitted')
  }
  await rm(gate)
}

test('several submissions ride one train, oldest submission first, and are checked once together', { timeout: limit(180000) }, async (t) => {
  const { root, cwd } = await repo(t)
  const gate = join(root, 'gate')
  await writeFile(gate, '')
  const release = { A: deferred(), B: deferred(), C: deferred() }
  const co = new Coordinator({
    checks: { gate: blocking(gate), fast: pass },
    integrationMode: 'train',
    launch: worker({ hold: { A: release.A.promise, B: release.B.promise, C: release.C.promise } }),
  })
  const q = { cwd, parentId: 'captain', runId: 'fifo' }
  try {
    const started = await co.start({
      ...q,
      manifest: plan(['Z', 'A', 'B', 'C'].map((id) => ({ id, title: id, verify: id === 'Z' ? ['gate'] : ['fast'] }))),
    })
    assert.deepEqual(started.integration, { mode: 'train', selectChecksByFiles: false })
    // Submitted C, then B, then A: the train takes them in that order, not in ticket order.
    await queueBehind(co, q, gate, release, ['C', 'B', 'A'])
    await completed(co, q)
    const db = ledger(co, 'fifo')
    assert.deepEqual(db.meta().manifest.integration, { mode: 'train', selectChecksByFiles: false, trainSize: 4 })
    const events = db.events()
    const trains = ofType(events, 'train_started')
    assert.deepEqual(trains.map((e) => e.details.tickets), [['Z'], ['C', 'B', 'A']])
    assert.deepEqual(trains[1].details.checks, ['fast', 'gate'])
    assert.deepEqual(await landedOrder(cwd, db, 'fifo'), ['Z', 'C', 'B', 'A'])
    // One run of each cumulative check for the whole second train, recorded on the run, stage train.
    const second = events.slice(events.indexOf(trains[1]))
    const checks = ofType(second, 'check_finished')
    assert.deepEqual(checks.map((e) => [e.ticketId, e.details.checkId, e.details.stage]), [
      [null, 'fast', 'train'],
      [null, 'gate', 'train'],
    ])
    // Every car's queue ends when its train starts checking.
    for (const id of ['A', 'B', 'C']) assert.deepEqual(ofType(second, 'verify_started').find((e) => e.ticketId === id).details.checks, ['fast', 'gate'])
    // Each landed merge is the ordinary two-parent merge of the previous tip and the ticket.
    const [, c, b, a] = ['Z', 'C', 'B', 'A'].map((id) => db.get(id))
    assert.equal(await git(cwd, 'show', '-s', '--format=%P', b.landedSha), c.landedSha + ' ' + b.sourceSha)
    assert.equal(await git(cwd, 'show', '-s', '--format=%P', a.landedSha), b.landedSha + ' ' + a.sourceSha)
    assert.equal(ofType(events, 'run_completed').length, 1)
    const timing = (await co.status(q)).timing
    assert.ok(timing.totals.verifyMs !== null && timing.totals.checkRuns === 3)
    // Train checkouts are released and no pin is left behind, once the train job ended.
    await until(() => ![...co.runs.values()].some((r) => r.integration), 'train job ended')
    assert.doesNotMatch(await git(cwd, 'worktree', 'list', '--porcelain'), /candidates/)
    assert.equal(await git(cwd, 'for-each-ref', 'refs/dsh-ticket-dag/candidates'), '')
  } finally {
    await co.close()
  }
})

test('a conflicting car is skipped and sent back; the rest of its train lands', { timeout: limit(180000) }, async (t) => {
  const { root, cwd } = await repo(t)
  const gate = join(root, 'gate')
  await writeFile(gate, '')
  const release = { X1: deferred(), X2: deferred(), Y: deferred() }
  const co = new Coordinator({
    checks: { gate: blocking(gate), fast: pass },
    integrationMode: 'train',
    launch: worker({
      files: { X1: ['shared.txt', 'from X1\n'], X2: ['shared.txt', 'from X2\n'] },
      hold: Object.fromEntries(Object.entries(release).map(([k, v]) => [k, v.promise])),
    }),
  })
  const q = { cwd, parentId: 'captain', runId: 'conflict' }
  try {
    await co.start({
      ...q,
      manifest: plan(['Z', 'X1', 'X2', 'Y'].map((id) => ({ id, title: id, verify: id === 'Z' ? ['gate'] : ['fast'] }))),
    })
    await queueBehind(co, q, gate, release, ['X1', 'X2', 'Y'])
    await completed(co, q)
    const db = ledger(co, 'conflict')
    const events = db.events()
    const [, second] = ofType(events, 'train_started')
    assert.deepEqual(second.details.tickets, ['X1', 'Y'])
    assert.deepEqual(second.details.conflicts, ['X2'])
    const requeued = ofType(events, 'conflict_requeued')
    assert.equal(requeued.length, 1)
    assert.equal(requeued[0].ticketId, 'X2')
    assert.match(requeued[0].message, /Trial merge conflicts with the integration tip in: shared\.txt \(merge train\)/)
    // X1 and Y landed in the same train, X2 after its worker merged the integration branch.
    assert.deepEqual(await landedOrder(cwd, db, 'conflict'), ['Z', 'X1', 'Y', 'X2'])
    assert.equal(db.get('X2').attempt, 2)
    // The scripted worker resolved the conflict keeping both sides.
    assert.deepEqual((await git(cwd, 'show', 'integration/conflict:shared.txt')).split('\n').sort(), ['from X1', 'from X2'])
  } finally {
    await co.close()
  }
})

test('a logic error is bisected inside the train: the prefix lands, the culprit goes back, the rest waits', { timeout: limit(180000) }, async (t) => {
  const { root, cwd } = await repo(t)
  const gate = join(root, 'gate')
  await writeFile(gate, '')
  const release = { A: deferred(), L: deferred(), B: deferred() }
  const seen = []
  const co = new Coordinator({
    checks: { gate: blocking(gate), slow },
    integrationMode: 'train',
    launch: worker({
      seen,
      files: { L: ['bug.txt', 'bad\n'] },
      hold: Object.fromEntries(Object.entries(release).map(([k, v]) => [k, v.promise])),
    }),
  })
  const q = { cwd, parentId: 'captain', runId: 'logic' }
  try {
    await co.start({
      ...q,
      manifest: plan(['Z', 'A', 'L', 'B'].map((id) => ({ id, title: id, verify: id === 'Z' ? ['gate'] : ['slow'] }))),
    })
    await queueBehind(co, q, gate, release, ['A', 'L', 'B'])
    await completed(co, q)
    const db = ledger(co, 'logic')
    const events = db.events()
    const [, second, third] = ofType(events, 'train_started')
    assert.deepEqual(second.details.tickets, ['A', 'L', 'B'])
    const [failed] = ofType(events, 'train_failed')
    assert.deepEqual(failed.details.failed, ['slow'])
    assert.equal(failed.details.culprit, 'L')
    assert.equal(failed.details.culpritSha, second.details.merges[1])
    assert.deepEqual(failed.details.published, ['A'])
    // The bisection reran only the failed ID on a merge of the chain.
    const steps = ofType(events, 'train_bisect_step')
    assert.ok(steps.length >= 1 && steps.every((s) => second.details.merges.includes(s.details.sha) && s.details.checks.join() === 'slow'))
    // L went back to its worker with the evidence; B stayed submitted and rode the next train.
    const [back] = ofType(events, 'check_requeued')
    assert.equal(back.ticketId, 'L')
    assert.match(back.message, /Merge-train checks failed: slow/)
    const retry = seen.find((j) => j.ticketId === 'L' && j.attempt === 2)
    for (const part of ['merge train after A', second.details.merges[1], 'bug.txt is bad']) assert.ok(retry.prompt.includes(part), part)
    assert.ok(third.details.tickets.includes('B'))
    assert.equal(ofType(events, 'check_requeued').filter((e) => e.ticketId !== 'L').length, 0)
    assert.deepEqual((await landedOrder(cwd, db, 'logic')).slice(0, 2), ['Z', 'A'])
    assert.equal(await git(cwd, 'show', 'integration/logic:bug.txt'), 'ok')
    const timing = (await co.status(q)).timing
    assert.ok(timing.totals.checkFailures >= 1)
  } finally {
    await co.close()
  }
})

for (const crash of ['after-publish', 'before-publish']) {
  test('a restart in the middle of a train publication neither repeats nor loses a ticket (' + crash + ')', { timeout: limit(180000) }, async (t) => {
    const { root, cwd } = await repo(t)
    const gate = join(root, 'gate')
    await writeFile(gate, '')
    const release = { A: deferred(), B: deferred(), C: deferred() }
    const settings = {
      checks: { gate: blocking(gate), fast: pass },
      integrationMode: 'train',
      launch: worker({ hold: Object.fromEntries(Object.entries(release).map(([k, v]) => [k, v.promise])) }),
    }
    const q = { cwd, parentId: 'captain', runId: 'crash' }
    let co = new Coordinator(settings)
    try {
      await co.start({
        ...q,
        manifest: plan(['Z', 'A', 'B', 'C'].map((id) => ({ id, title: id, verify: id === 'Z' ? ['gate'] : ['fast'] }))),
      })
      await until(async () => (await co.status(q)).trainPhase?.checkId === 'gate', 'first train running')
      for (const id of ['A', 'B', 'C']) {
        release[id].resolve()
        await until(async () => (await co.status(q)).tickets.find((x) => x.id === id).status === 'SUBMITTED', id + ' submitted')
      }
      // The second car's publication dies half way, as a killed process would leave it.
      const db = ledger(co, 'crash')
      if (crash === 'after-publish') {
        const finish = db.finish.bind(db)
        db.finish = (id, ...rest) => {
          if (id === 'B') throw Error('simulated crash after the ref moved')
          return finish(id, ...rest)
        }
      } else {
        const intent = db.intent.bind(db)
        db.intent = (id, ...rest) => {
          const ok = intent(id, ...rest)
          if (id === 'B') throw Error('simulated crash before the ref moved')
          return ok
        }
      }
      await rm(gate)
      const held = await until(async () => {
        const s = await co.status(q)
        // A pump queued before the hold may already have reconciled B's open intent.
        return s.mode === 'paused' && ['PUBLISHING', 'INTEGRATED'].includes(s.tickets.find((x) => x.id === 'B').status) && s
      }, async () => 'publication held: ' + JSON.stringify(await co.status(q).then((s) => [s.mode, s.diagnostic, s.tickets.map((x) => [x.id, x.status, x.message])])), 20000)
      assert.match(held.diagnostic, /simulated crash/)
      assert.equal(held.tickets.find((x) => x.id === 'A').status, 'INTEGRATED')
      assert.equal(held.tickets.find((x) => x.id === 'C').status, 'SUBMITTED')
      await co.close()
      co = new Coordinator(settings)
      await co.attach(q)
      await co.resume(q)
      await until(async () => {
        const s = await co.status(q)
        if (s.counts.NEEDS_ATTENTION || s.diagnostic) throw Error(JSON.stringify([s.diagnostic, s.tickets.map((x) => [x.id, x.status, x.message])]))
        return s.complete
      }, async () => JSON.stringify((await co.status(q)).tickets.map((x) => [x.id, x.status])), 30000)
      const fresh = ledger(co, 'crash')
      const events = fresh.events()
      for (const id of ['Z', 'A', 'B', 'C'])
        assert.equal(ofType(events, 'integrated').filter((e) => e.ticketId === id).length, 1, id + ' integrated once')
      const order = await landedOrder(cwd, fresh, 'crash')
      assert.deepEqual(order, ['Z', 'A', 'B', 'C'])
      assert.equal(ofType(events, 'run_completed').length, 1)
    } finally {
      await co.close()
    }
  })
}

test('a train of one is the each lane: one ordinary merge, the same checks, then publish', { timeout: limit(120000) }, async (t) => {
  const { cwd } = await repo(t)
  const co = new Coordinator({ checks: { fast: pass, slow }, integrationMode: 'train', trainSize: 2, launch: worker() })
  const q = { cwd, parentId: 'captain', runId: 'single' }
  try {
    await co.start({ ...q, manifest: plan([{ id: 'A', title: 'A', verify: ['fast', 'slow'] }]) })
    await completed(co, q)
    const db = ledger(co, 'single')
    assert.equal(db.meta().manifest.integration.trainSize, 2)
    const events = db.events()
    const [train] = ofType(events, 'train_started')
    assert.deepEqual(train.details.tickets, ['A'])
    assert.deepEqual(ofType(events, 'verify_started')[0].details.checks, ['fast', 'slow'])
    assert.deepEqual(ofType(events, 'check_finished').map((e) => e.details.checkId), ['fast', 'slow'])
    const a = db.get('A')
    assert.equal(await git(cwd, 'show', '-s', '--format=%P', a.landedSha), db.meta().baseSha + ' ' + a.sourceSha)
    assert.equal(ofType(events, 'publishing').length, 1)
    assert.equal(ofType(events, 'run_completed').length, 1)
  } finally {
    await co.close()
  }
})

test('train file selection diffs the whole train against the tip', { timeout: limit(120000) }, async (t) => {
  const { cwd } = await repo(t)
  const co = new Coordinator({
    checks: { fast: pass, slow },
    integrationMode: 'train',
    selectChecksByFiles: true,
    checkMeta: { fast: { files: ['**'], fast: true }, slow: { files: ['src/**'] } },
    launch: worker({ files: { D: ['docs/guide.md', 'guide\n'] } }),
  })
  const q = { cwd, parentId: 'captain', runId: 'select' }
  try {
    await co.start({ ...q, manifest: plan([{ id: 'D', title: 'D', verify: ['fast', 'slow'] }]) })
    await completed(co, q)
    const events = ledger(co, 'select').events()
    const [selected] = ofType(events, 'checks_selected')
    assert.equal(selected.ticketId, null)
    assert.deepEqual(selected.details, { stage: 'train', run: ['fast'], skipped: ['slow'], fallback: null, changed: 1 })
    assert.deepEqual(ofType(events, 'check_finished').map((e) => e.details.checkId), ['fast'])
  } finally {
    await co.close()
  }
})

test('trainSize is frozen only for train and must be 2..16', () => {
  const tickets = [{ id: 'A', title: 'A', verify: ['fast'] }]
  const checks = { fast: pass }
  assert.equal(Object.hasOwn(normalizeManifest(plan(tickets), checks, {}, { trainSize: 8 }), 'integration'), false)
  assert.deepEqual(normalizeManifest(plan(tickets), checks, {}, { integrationMode: 'end', trainSize: 8 }).integration, {
    mode: 'end',
    selectChecksByFiles: false,
    maxFinalRepairs: 2,
  })
  assert.deepEqual(normalizeManifest(plan(tickets), checks, {}, { integrationMode: 'train', trainSize: 8 }).integration, {
    mode: 'train',
    selectChecksByFiles: false,
    trainSize: 8,
  })
  assert.equal(normalizeManifest(plan(tickets, { integration: { mode: 'train', train_size: 3 } }), checks).integration.trainSize, 3)
  for (const size of [1, 17, 2.5, '4'])
    assert.throws(() => normalizeManifest(plan(tickets, { integration: { mode: 'train', trainSize: size } }), checks), /train_size must be an integer between 2 and 16/)
})
