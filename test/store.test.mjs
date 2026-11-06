import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { RunStore, normalizeAppend, normalizeManifest } from '../src/store.mjs'

const checks = {
  unit: [['node', '--test']],
  lint: [
    ['eslint', '.'],
    ['tsc', '--noEmit'],
  ],
}
const ticket = (id, deps = []) => ({ id, title: 'Implement ' + id, depends_on: deps, verify: ['unit'] })
const manifest = (tickets, extra = {}) =>
  normalizeManifest({ spec_id: 'test', base_ref: 'refs/heads/main', tickets, ...extra }, checks)

function tempDb(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dag-store-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return join(dir, 'run.sqlite')
}
function init(db, spec) {
  return db.init({
    runId: 'run-1',
    repo: { root: '/work', commonDir: '/work/.git' },
    ref: 'refs/heads/integration/run-1',
    baseSha: 'start',
    parentId: 'parent',
    policyHash: 'checks-hash',
    manifest: spec,
  })
}
function assignment(id, baseSha = 'start') {
  return { baseSha, childId: 'child-' + id, path: '/worktree/' + id, branch: 'ticket/test/' + id }
}
function submit(db, row, sourceSha) {
  assert.equal(db.move(row.id, row.lease, 'RUNNING', 'SUBMITTED', { sourceSha }), true)
}
function publish(db, row, oldTip, sourceSha, candidateSha) {
  assert.equal(db.intent(row.id, row.lease, { oldTip, sourceSha, candidateSha }), true)
  assert.equal(db.finish(row.id, row.lease, candidateSha), true)
}

test('verification events stay out of the outbox and the plan revision', (t) => {
  const db = new RunStore(tempDb(t))
  try {
    init(db, manifest([ticket('A')]))
    assert.equal(db.events()[0].details.mode, 'active')
    const row = db.claim('A', assignment('A'))
    submit(db, row, 'source')
    const revision = db.revision()
    const integrity = JSON.stringify(db.integrity())
    const pending = db.pendingNotifications().length
    db.recordVerifyStart('A', ['unit'])
    db.recordCheck('A', { checkId: 'unit', ms: 12, ok: true })
    db.recordCheck('A', { checkId: 'lint', ms: 3, ok: false, aborted: true })
    const [started, passed, stopped] = db.events().slice(-3)
    assert.deepEqual([started.type, started.ticketId, started.attempt], ['verify_started', 'A', 1])
    assert.deepEqual(started.details, { checks: ['unit'] })
    assert.equal(passed.type, 'check_finished')
    assert.deepEqual(passed.details, { checkId: 'unit', ms: 12, ok: true })
    assert.deepEqual(stopped.details, { checkId: 'lint', ms: 3, ok: false, aborted: true })
    assert.equal(db.pendingNotifications().length, pending)
    assert.equal(db.revision(), revision)
    assert.equal(JSON.stringify(db.integrity()), integrity)
    // They change no ticket state, so publication proceeds as before.
    publish(db, db.get('A'), 'start', 'source', 'landed')
    assert.equal(db.get('A').status, 'INTEGRATED')
  } finally {
    db.close()
  }
})

test('plan aliases, defaults and declared artifact dependencies', () => {
  const m = manifest(
    [
      { ...ticket('A'), produces: ['api'] },
      ticket('B', ['A']),
      { ...ticket('C', ['B']), consumes: ['api', 'database'] },
    ],
    { external_inputs: ['database'] },
  )
  assert.equal(m.maxWorkers, 16)
  assert.equal(m.baseRef, 'refs/heads/main')
  assert.deepEqual(m.tickets[1].dependsOn, ['A'])
  assert.deepEqual(normalizeManifest(m, checks), m)
  assert.throws(
    () =>
      manifest([
        { ...ticket('A'), produces: ['api'] },
        { ...ticket('B'), consumes: ['api'] },
      ]),
    /no declared dependency/,
  )
  assert.throws(() => manifest([ticket('A'), ticket('A')]), /duplicate/)
  assert.throws(() => manifest([ticket('A', ['Z'])]), /unknown dependency/)
  assert.throws(() => manifest([ticket('A', ['B']), ticket('B', ['A'])]), /cycle/)
  assert.throws(() => manifest([ticket('../A')]), /safe ID/)
  assert.throws(() => manifest([ticket('NUL.txt')]), /safe ID/)
  assert.throws(() => manifest([ticket('Ticket'), ticket('ticket')]), /duplicate/)
  assert.throws(() => manifest([ticket('A')], { base_ref: 'main~3' }), /baseRef/)
  assert.throws(() => manifest([ticket('A')], { max_workers: 33 }), /1 and 32/)
  assert.deepEqual(manifest([{ ...ticket('A'), verify: [] }]).tickets[0].verify, [], 'verify is optional')
  assert.deepEqual(manifest([{ id: 'A', title: 'Docs' }]).tickets[0].verify, [])
  // The captain may define its own checks; they are kept on the manifest and cannot shadow a profile ID.
  const own = manifest([{ ...ticket('A'), verify: ['py'] }], { checks: { py: [['uv', 'run', 'pytest', '-q']] } })
  assert.deepEqual(own.checks, { py: [['uv', 'run', 'pytest', '-q']] })
  assert.deepEqual(normalizeManifest(own, checks), own, 'a stored manifest normalizes to itself')
  assert.equal(Object.hasOwn(manifest([ticket('A')]), 'checks'), false)
  assert.throws(() => manifest([ticket('A')], { checks: { unit: [['x']] } }), /already a profile check/)
  assert.throws(() => manifest([ticket('A')], { checks: { py: ['uv', 'test'] } }), /argv/)
  assert.throws(() => manifest([ticket('A')], { checks: { py: [] } }), /argv/)
  assert.throws(() => manifest([ticket('A')], { checks: { '../x': [['x']] } }), /safe ID/)
  assert.throws(() => manifest([ticket('A')], { checks: [['x']] }), /object/)
  assert.throws(() => manifest([ticket('A')], { checks: { py: [['x', 'a'.repeat(4097)]] } }), /longer than/)
  assert.throws(() => manifest([{ ...ticket('A'), verify: ['arbitrary'] }]), /unknown verification/)
  assert.throws(
    () => normalizeManifest({ spec_id: 'x', tickets: [ticket('A')] }, { unit: ['node', '--test'] }),
    /argv/,
  )
})

test('a ticket agent preset is frozen into the manifest; tickets without one are unchanged', () => {
  const agents = {
    'test-writer': { instructions: 'Only add tests.', provider: 'acme', model: 'fast-1', reasoningEffort: '' },
  }
  const plan = (tickets) => ({ spec_id: 'test', base_ref: 'refs/heads/main', tickets })
  assert.equal(
    JSON.stringify(normalizeManifest(plan([ticket('A')]), checks, agents)),
    JSON.stringify(manifest([ticket('A')])),
  )
  // Bytes produced by the 0.2.0 normalizer for the same plan.
  assert.equal(
    JSON.stringify(
      normalizeManifest(
        plan([ticket('A'), { ...ticket('B', ['A']), kind: 'code', produces: ['api'], acceptance: ['ok'] }]),
        checks,
        agents,
      ),
    ),
    '{"specId":"test","baseRef":"refs/heads/main","maxWorkers":16,"tickets":[' +
      '{"id":"A","title":"Implement A","prompt":"Implement A","dependsOn":[],"verify":["unit"],"acceptance":[]},' +
      '{"id":"B","title":"Implement B","prompt":"Implement B","dependsOn":["A"],"verify":["unit"],"acceptance":["ok"],"kind":"code","produces":["api"]}]}',
  )
  const m = normalizeManifest(plan([{ ...ticket('A'), agent: 'test-writer' }, ticket('B')]), checks, agents)
  assert.equal(m.tickets[0].agent, 'test-writer')
  assert.deepEqual(m.tickets[0].agentSpec, { instructions: 'Only add tests.', provider: 'acme', model: 'fast-1' })
  assert.equal(Object.hasOwn(m.tickets[1], 'agent'), false)
  assert.deepEqual(normalizeManifest(m, checks, agents), m)
  assert.throws(
    () => normalizeManifest(plan([{ ...ticket('A'), agent: 'ghost' }]), checks, agents),
    /unknown agent preset: ghost/,
  )
  assert.throws(() => normalizeManifest(plan([{ ...ticket('A'), agent: '../x' }]), checks, agents), /safe ID/)
})

test('cross-connection leases, max workers and fan-in use durable integrated records', (t) => {
  const file = tempDb(t)
  const db = new RunStore(file),
    peer = new RunStore(file)
  try {
    assert.equal(db.meta(), null)
    const spec = manifest([ticket('A'), ticket('C'), ticket('B', ['A', 'C'])], { max_workers: 1 })
    init(db, spec)
    assert.throws(() => init(peer, spec), /already initialized/)
    assert.equal(peer.meta().policyHash, 'checks-hash')
    assert.equal(peer.meta().tipSha, 'start')
    const a = db.claim('A', assignment('A'))
    assert.equal(peer.claim('A', assignment('A')), null)
    assert.equal(peer.claim('C', assignment('C')), null)
    assert.equal(db.claim('B', assignment('B')), null)
    assert.throws(() => db.move('A', a.lease, 'RUNNING', 'SUBMITTED'), /sourceSha/)
    assert.equal(db.get('A').status, 'RUNNING')
    submit(db, a, 'source-a')
    assert.equal(db.claim('B', assignment('B')), null)
    const c = peer.claim('C', assignment('C'))
    assert.ok(c)
    publish(db, a, 'start', 'source-a', 's1')
    assert.equal(db.claim('B', assignment('B', 's1')), null)
    submit(peer, c, 'source-c')
    assert.equal(
      peer.intent('C', c.lease, { oldTip: 'start', sourceSha: 'source-c', candidateSha: 'obsolete' }),
      false,
    )
    publish(peer, c, 's1', 'source-c', 's2')
    assert.equal(db.claim('B', assignment('B', 's1')), null)
    const b = db.claim('B', assignment('B', 's2'))
    assert.ok(b)
    assert.equal(b.baseSha, 's2')
    assert.deepEqual(db.pendingNotifications(), [])
    submit(db, b, 'source-b')
    publish(db, b, 's2', 'source-b', 's3')
    assert.equal(db.meta().tipSha, 's3')
    assert.deepEqual(
      db.tickets().map((row) => row.status),
      ['INTEGRATED', 'INTEGRATED', 'INTEGRATED'],
    )
    const [done] = db.pendingNotifications()
    assert.equal(done.type, 'run_completed')
    assert.equal(done.parentId, 'parent')
    assert.equal(peer.ackNotification(done.id), true)
    assert.equal(db.ackNotification(done.id), false)
    assert.equal(db.events().at(-1).id, done.id)
    assert.deepEqual(db.pendingNotifications(), [])
  } finally {
    peer.close()
    db.close()
  }
})

test('fresh attempt excludes a late worker and preserves the previous branch and directory', (t) => {
  const db = new RunStore(tempDb(t))
  try {
    init(db, manifest([ticket('A')]))
    const a = db.claim('A', assignment('A'))
    assert.equal(db.move('A', a.lease, 'RUNNING', 'PENDING', { message: 'capacity full' }), true)
    const next = db.claim('A', assignment('A'))
    assert.notEqual(next.lease, a.lease)
    assert.equal(db.move('A', a.lease, 'RUNNING', 'NEEDS_ATTENTION', { message: 'late EOF' }), false)
    assert.equal(
      db.move('A', next.lease, 'RUNNING', 'NEEDS_ATTENTION', { message: 'preserved uncommitted work' }),
      true,
    )
    const [notice] = db.pendingNotifications()
    assert.equal(notice.ticketId, 'A')
    assert.equal(notice.attempt, 2)
    assert.equal(notice.details.lease, next.lease)
    assert.equal(db.retry('A'), true)
    const pending = db.get('A')
    assert.deepEqual(
      [pending.baseSha, pending.branch, pending.path, pending.attempt, pending.lease],
      [next.baseSha, next.branch, next.path, 2, null],
    )
    assert.equal(db.claim('A', assignment('wrong-worktree')), null)
    const third = db.claim('A', assignment('A'))
    assert.equal(third.attempt, 3)
    assert.equal(third.message, 'preserved uncommitted work')
    assert.equal(db.move('A', next.lease, 'RUNNING', 'SUBMITTED', { sourceSha: 'late' }), false)
  } finally {
    db.close()
  }
})

test('publish intent survives restart, commits exactly one completion notice and receipt', (t) => {
  const file = tempDb(t)
  let db = new RunStore(file)
  try {
    init(db, manifest([ticket('A')]))
    const a = db.claim('A', assignment('A'))
    submit(db, a, 'source')
    assert.equal(
      db.intent('A', a.lease, { oldTip: 'start', sourceSha: 'changed-source', candidateSha: 'accepted' }),
      false,
    )
    assert.equal(
      db.intent('A', a.lease, { oldTip: 'start', sourceSha: 'source', candidateSha: 'accepted' }),
      true,
    )
    db.close()
    db = new RunStore(file)
    assert.equal(db.get('A').status, 'PUBLISHING')
    assert.equal(db.intents()[0].candidateSha, 'accepted')
    assert.equal(db.finish('A', 'old-token', 'accepted'), false)
    assert.equal(db.finish('A', a.lease, 'wrong-commit'), false)
    assert.equal(db.meta().tipSha, 'start')
    assert.equal(db.finish('A', a.lease, 'accepted'), true)
    assert.equal(db.finish('A', a.lease, 'accepted'), false)
    assert.deepEqual(db.intents(), [])
    assert.equal(db.get('A').landedSha, 'accepted')
    assert.equal(db.meta().tipSha, 'accepted')
    const [done] = db.pendingNotifications()
    db.close()
    db = new RunStore(file)
    assert.deepEqual(
      db.pendingNotifications().map((n) => n.id),
      [done.id],
    )
    assert.equal(db.ackNotification(done.id), true)
  } finally {
    db.close()
  }
})

test('cleanup results persist only for integrated tickets; a ledger from before cleanup reads as not cleaned', (t) => {
  const file = tempDb(t)
  let db = new RunStore(file)
  try {
    init(db, manifest([ticket('A'), ticket('B')]))
    const a = db.claim('A', assignment('A'))
    submit(db, a, 'source')
    publish(db, a, 'start', 'source', 'landed')
    db.close()
    // The ledger layout of earlier releases has no cleanup columns.
    const old = new DatabaseSync(file)
    old.exec('ALTER TABLE tickets DROP COLUMN cleanupReason; ALTER TABLE tickets DROP COLUMN cleanup')
    old.close()
    db = new RunStore(file)
    assert.equal(db.get('A').cleanup, null)
    assert.equal(db.get('A').cleanupReason, null)
    assert.equal(db.recordCleanup('B', 'cleaned'), false)
    assert.equal(db.recordCleanup('A', 'skipped', 'worktree has uncommitted changes'), true)
    assert.deepEqual([db.get('A').cleanup, db.get('A').cleanupReason], ['skipped', 'worktree has uncommitted changes'])
    assert.equal(db.recordCleanup('A', 'cleaned'), true)
    // A cleaned ticket stays cleaned.
    assert.equal(db.recordCleanup('A', 'skipped', 'late'), false)
    assert.deepEqual([db.get('A').cleanup, db.get('A').cleanupReason], ['cleaned', null])
    assert.throws(() => db.recordCleanup('A', 'gone'), /cleanup status/)
    assert.equal(db.get('B').cleanup, null)
  } finally {
    db.close()
  }
})

test('ambiguous publication remains visible, blocks new publishing and cannot be blindly retried', (t) => {
  const db = new RunStore(tempDb(t))
  try {
    init(db, manifest([ticket('A'), ticket('B')]))
    const a = db.claim('A', assignment('A')),
      b = db.claim('B', assignment('B'))
    submit(db, a, 'source-a')
    submit(db, b, 'source-b')
    assert.equal(
      db.intent('A', a.lease, { oldTip: 'start', sourceSha: 'source-a', candidateSha: 's1' }),
      true,
    )
    assert.equal(
      db.intent('B', b.lease, { oldTip: 'start', sourceSha: 'source-b', candidateSha: 'other' }),
      false,
    )
    assert.equal(
      db.move('A', a.lease, 'PUBLISHING', 'NEEDS_ATTENTION', { message: 'unknown target rewrite' }),
      true,
    )
    assert.equal(db.retry('A'), false)
    assert.equal(db.move('A', a.lease, 'NEEDS_ATTENTION', 'CANCELLED'), false)
    assert.equal(db.intents()[0].oldTip, 'start')
    assert.equal(db.get('A').status, 'NEEDS_ATTENTION')
    assert.equal(db.move('A', a.lease, 'NEEDS_ATTENTION', 'SUBMITTED', { sourceSha: 'other' }), false)
    assert.equal(db.finish('A', a.lease, 's1'), true)
    assert.deepEqual(db.intents(), [])
    assert.equal(db.meta().tipSha, 's1')
  } finally {
    db.close()
  }
})

test('a staged run admits nothing until approved; approval freezes each ticket choice beside the original manifest', (t) => {
  const file = tempDb(t)
  let db = new RunStore(file)
  try {
    const spec = manifest([ticket('A'), ticket('B', ['A'])])
    db.init({
      runId: 'run-1',
      repo: { root: '/work', commonDir: '/work/.git' },
      ref: 'refs/heads/integration/run-1',
      baseSha: 'start',
      parentId: 'parent',
      policyHash: 'checks-hash',
      manifest: spec,
      mode: 'staged',
    })
    assert.equal(db.meta().mode, 'staged')
    assert.equal(db.claim('A', assignment('A')), null)
    // The captain's pause/resume cannot leave the staged state; only approval or cancel can.
    assert.equal(db.setMode('active'), false)
    assert.equal(db.setMode('paused'), false)
    assert.equal(db.hold('broken policy'), true)
    assert.equal(db.meta().mode, 'staged')
    const choices = [
      { ...spec.tickets[0], agent: 'docs', agentSpec: { instructions: 'Docs.', model: 'fast-1' } },
      spec.tickets[1],
    ]
    assert.equal(db.approve(choices), true)
    assert.equal(db.meta().mode, 'active')
    assert.equal(db.meta().diagnostic, null)
    assert.deepEqual(db.get('A').agentSpec, { instructions: 'Docs.', model: 'fast-1' })
    assert.equal(db.get('A').agent, 'docs')
    // The submitted manifest stays byte-identical so dag_run remains idempotent.
    assert.equal(JSON.stringify(db.meta().manifest), JSON.stringify(spec))
    assert.equal(Object.hasOwn(db.get('B'), 'agent'), false)
    const claimed = db.claim('A', assignment('A'))
    assert.deepEqual(claimed.agentSpec, { instructions: 'Docs.', model: 'fast-1' })
    assert.deepEqual(db.tickets()[0].agentSpec, claimed.agentSpec)
    db.close()
    db = new RunStore(file)
    assert.equal(JSON.stringify(db.meta().manifest), JSON.stringify(spec))
    assert.equal(db.get('A').agent, 'docs')
    assert.equal(db.approve(choices), false, 'approval happens once')
    assert.deepEqual(
      db.pendingNotifications().map((n) => n.type),
      ['run_blocked', 'run_approved'],
    )
    assert.throws(() => db.approve([{ ...spec.tickets[0], id: 'Z' }]), /ticket set/)
  } finally {
    db.close()
  }
})

test('the user concurrency chosen at approval replaces the manifest max_workers and survives reopening', (t) => {
  const file = tempDb(t)
  let db = new RunStore(file)
  try {
    const spec = manifest([ticket('A'), ticket('B'), ticket('C')])
    db.init({
      runId: 'run-1',
      repo: { root: '/work', commonDir: '/work/.git' },
      ref: 'refs/heads/integration/run-1',
      baseSha: 'start',
      parentId: 'parent',
      policyHash: 'checks-hash',
      manifest: spec,
      mode: 'staged',
    })
    assert.equal(db.workerLimit(), spec.maxWorkers)
    assert.throws(() => db.approve(spec.tickets, { maxWorkers: 0 }), /1 to 32/)
    assert.throws(() => db.approve(spec.tickets, { maxWorkers: 33 }), /1 to 32/)
    assert.equal(db.approve(spec.tickets, { maxWorkers: 1 }), true)
    assert.equal(db.workerLimit(), 1)
    assert.ok(db.claim('A', assignment('A')))
    assert.equal(db.claim('B', assignment('B')), null, 'one ticket at a time')
    db.close()
    db = new RunStore(file)
    assert.equal(db.workerLimit(), 1)
  } finally {
    db.close()
  }
})

test('a staged run can be discarded, and approval must name exactly the run tickets', (t) => {
  const db = new RunStore(tempDb(t))
  try {
    const spec = manifest([ticket('A')])
    db.init({
      runId: 'run-1',
      repo: { root: '/work', commonDir: '/work/.git' },
      ref: 'refs/heads/integration/run-1',
      baseSha: 'start',
      parentId: 'parent',
      policyHash: 'checks-hash',
      manifest: spec,
      mode: 'staged',
    })
    assert.throws(() => db.approve([]), /ticket set/)
    assert.equal(db.setMode('cancelled'), true)
    assert.equal(db.get('A').status, 'CANCELLED')
    assert.equal(db.approve(spec.tickets), false)
  } finally {
    db.close()
  }
})

test('the plan revision is opaque and changes with the plan and its frozen commands', (t) => {
  const file = tempDb(t)
  const db = new RunStore(file)
  try {
    const spec = manifest([ticket('A')])
    db.init({
      runId: 'run-1',
      repo: { root: '/work', commonDir: '/work/.git' },
      ref: 'refs/heads/integration/run-1',
      baseSha: 'start',
      parentId: 'parent',
      policyHash: 'checks-hash',
      manifest: spec,
      mode: 'staged',
    })
    const first = db.revision()
    assert.match(first, /^[0-9a-f]{64}$/)
    assert.equal(first, db.revision(), 'stable while nothing changes')
    // Appending a ticket changes the version a review would show.
    const batch = normalizeAppend([{ id: 'B', title: 'B', depends_on: ['A'], verify: ['unit'] }], checks)
    assert.equal(db.append(batch, { policyHash: 'p' }).added, true)
    const afterAppend = db.revision()
    assert.notEqual(afterAppend, first)
    // Repeating the identical batch is idempotent and leaves the version alone.
    assert.equal(db.append(batch, { policyHash: 'p' }).added, false)
    assert.equal(db.revision(), afterAppend)
  } finally {
    db.close()
  }
  // The frozen command registry is part of what the user approves, so a plan
  // with an extra captain-written command has a different revision.
  const plain = new RunStore(file + '-plain')
  const extra = new RunStore(file + '-extra')
  try {
    plain.init({
      runId: 'run-1',
      repo: { root: '/work', commonDir: '/work/.git' },
      ref: 'refs/heads/integration/run-1',
      baseSha: 'start',
      parentId: 'parent',
      policyHash: 'checks-hash',
      manifest: manifest([ticket('A')]),
      mode: 'staged',
    })
    extra.init({
      runId: 'run-1',
      repo: { root: '/work', commonDir: '/work/.git' },
      ref: 'refs/heads/integration/run-1',
      baseSha: 'start',
      parentId: 'parent',
      policyHash: 'checks-hash',
      manifest: manifest([ticket('A')], { checks: { extra: [['node', '--test']] } }),
      mode: 'staged',
    })
    assert.notEqual(extra.revision(), plain.revision())
  } finally {
    plain.close()
    extra.close()
  }
})

test('pause stops dispatch; cancellation preserves running and potentially published tickets', (t) => {
  const db = new RunStore(tempDb(t))
  try {
    init(db, manifest([ticket('A'), ticket('B'), ticket('C')]))
    assert.equal(db.setMode('paused'), true)
    assert.equal(db.claim('A', assignment('A')), null)
    assert.equal(db.setMode('active'), true)
    const a = db.claim('A', assignment('A')),
      b = db.claim('B', assignment('B'))
    submit(db, a, 'source')
    assert.equal(db.intent('A', a.lease, { oldTip: 'start', sourceSha: 'source', candidateSha: 's1' }), true)
    assert.equal(db.setMode('cancelled'), true)
    assert.equal(db.get('A').status, 'PUBLISHING')
    assert.equal(db.get('B').status, 'RUNNING')
    assert.equal(db.get('C').status, 'CANCELLED')
    assert.equal(db.setMode('active'), false)
    assert.equal(db.move('B', b.lease, 'RUNNING', 'SUBMITTED', { sourceSha: 'late' }), false)
    assert.equal(db.move('B', b.lease, 'RUNNING', 'CANCELLED'), true)
    assert.equal(db.finish('A', a.lease, 's1'), true)
    assert.equal(db.meta().tipSha, 's1')
    assert.deepEqual(
      db.pendingNotifications().map((n) => n.type),
      ['run_cancelled'],
    )
  } finally {
    db.close()
  }
})

test('a verified original worker receipt recovers a late submission without redoing work', (t) => {
  const db = new RunStore(tempDb(t))
  try {
    init(db, manifest([ticket('A')]))
    const a = db.claim('A', assignment('A'))
    assert.equal(
      db.move('A', a.lease, 'RUNNING', 'NEEDS_ATTENTION', {
        message: 'worker exited without acknowledgement',
      }),
      true,
    )
    assert.equal(
      db.move('A', 'foreign-lease', 'NEEDS_ATTENTION', 'SUBMITTED', { sourceSha: 'land-me' }),
      false,
    )
    assert.throws(() => db.move('A', a.lease, 'NEEDS_ATTENTION', 'SUBMITTED'), /sourceSha/)
    assert.equal(db.move('A', a.lease, 'NEEDS_ATTENTION', 'SUBMITTED', { sourceSha: 'land-me' }), true)
    assert.equal(db.get('A').attempt, 1)
    publish(db, a, 'start', 'land-me', 'landed')
  } finally {
    db.close()
  }
})

test('durable bounded backoff blocks claim until retryAt; a manual retry resets the budget', (t) => {
  const file = tempDb(t)
  let db = new RunStore(file)
  try {
    init(db, manifest([ticket('A')]))
    const a = db.claim('A', assignment('A')),
      at = Date.now() + 60_000
    assert.equal(db.defer('A', 'wrong-generation', { at, message: 'transient' }), false)
    assert.equal(db.defer('A', a.lease, { at, message: 'transient', maxRetries: 1 }), true)
    db.close()
    db = new RunStore(file)
    assert.equal(db.get('A').retryAt, at)
    assert.equal(db.get('A').autoRetries, 1)
    assert.equal(db.get('A').branch, a.branch)
    assert.equal(db.claim('A', assignment('A')), null)
    assert.equal(
      db.move('A', null, 'PENDING', 'NEEDS_ATTENTION', { message: 'inspect before early retry' }),
      true,
    )
    assert.equal(db.retry('A'), true)
    const a2 = db.claim('A', assignment('A'))
    assert.equal(a2.retryAt, 0)
    assert.equal(a2.autoRetries, 0)
    assert.equal(
      db.defer('A', a2.lease, { at: Date.now() - 1, message: 'retry immediately', maxRetries: 1 }),
      true,
    )
    const a3 = db.claim('A', assignment('A'))
    assert.equal(a3.autoRetries, 1)
    assert.equal(a3.retryAt, 0)
    assert.equal(db.defer('A', a3.lease, { at: Date.now(), message: 'exhausted', maxRetries: 1 }), false)
    assert.equal(db.get('A').status, 'RUNNING')
  } finally {
    db.close()
  }
})

test('two processes racing to claim the same ticket create one durable attempt', async (t) => {
  const file = tempDb(t)
  const db = new RunStore(file)
  const children = []
  try {
    init(db, manifest([ticket('A')]))
    const url = JSON.stringify(new URL('../src/store.mjs', import.meta.url).href)
    const run = `import { RunStore } from ${url};
      const db = new RunStore(process.argv[1]);
      process.send('ready');
      process.once('message', () => {
        const ticket=db.claim('A',{baseSha:'start',childId:'child-A',path:'/worktree/A',branch:'ticket/test/A'});
        db.close();
        process.send(ticket?.lease ?? 'refused',()=>process.disconnect());
      });`
    const peers = await Promise.all(
      [1, 2].map(
        () =>
          new Promise((resolve, reject) => {
            const child = spawn(process.execPath, ['--input-type=module', '--eval', run, file], {
              stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
            })
            children.push(child)
            child.once('error', reject)
            child.once('exit', (code) => reject(new Error('claim process exited unexpectedly: ' + code)))
            child.once('message', (message) =>
              message === 'ready' ? resolve(child) : reject(new Error('bad claim handshake')),
            )
          }),
      ),
    )
    const result = await Promise.all(
      peers.map(
        (child) =>
          new Promise((resolve, reject) => {
            child.once('error', reject)
            child.once('exit', (code) => reject(new Error('claim process exited before its result: ' + code)))
            child.once('message', resolve)
            child.send('claim')
          }),
      ),
    )
    assert.equal(result.filter((value) => value === 'refused').length, 1)
    assert.ok(result.includes(db.get('A').lease))
    assert.equal(db.get('A').attempt, 1)
    assert.equal(db.events().filter((e) => e.type === 'claimed').length, 1)
  } finally {
    for (const child of children) if (child.exitCode == null) child.kill()
    db.close()
  }
})

test('hold stores its diagnostic with one notification, repeat observation is idempotent', (t) => {
  const file = tempDb(t)
  let db = new RunStore(file)
  try {
    init(db, manifest([ticket('A')]))
    assert.equal(db.hold('Target ref changed'), true)
    assert.equal(db.hold('Target ref changed'), false)
    db.close()
    db = new RunStore(file)
    assert.equal(db.meta().mode, 'paused')
    assert.equal(db.meta().diagnostic, 'Target ref changed')
    assert.equal(db.pendingNotifications().length, 1)
    assert.equal(db.pendingNotifications()[0].message, 'Target ref changed')
    assert.equal(db.setMode('active'), true)
    assert.equal(db.meta().diagnostic, null)
  } finally {
    db.close()
  }
})

test('a cancelled run stays final while keeping a diagnostic until the caller clears it', (t) => {
  const db = new RunStore(tempDb(t))
  try {
    init(db, manifest([ticket('A')]))
    assert.equal(db.setMode('cancelled'), true)
    assert.equal(db.hold('Unrecognized tip', { staged: true }), true)
    assert.equal(db.hold('Unrecognized tip'), false)
    assert.equal(db.meta().mode, 'cancelled')
    assert.equal(db.meta().diagnostic, 'Unrecognized tip')
    assert.equal(db.pendingNotifications().filter((n) => n.type === 'run_blocked').length, 1)
    assert.equal(db.clearDiagnostic(), true)
    assert.equal(db.meta().diagnostic, null)
    assert.equal(db.events().filter((e) => e.type === 'run_blocked').length, 1)
  } finally {
    db.close()
  }
})

test('abandonIntent cancels only an unpublished intent for the exact cancelled run and lease', (t) => {
  const db = new RunStore(tempDb(t))
  try {
    init(db, manifest([ticket('A'), ticket('B', ['A'])]))
    const a = db.claim('A', assignment('A'))
    submit(db, a, 'source')
    assert.ok(db.intent('A', a.lease, { oldTip: 'start', sourceSha: 'source', candidateSha: 'candidate' }))
    assert.equal(db.abandonIntent('A', a.lease), false)
    assert.equal(db.setMode('cancelled'), true)
    assert.equal(db.abandonIntent('A', 'other'), false)
    assert.equal(db.abandonIntent('A', a.lease), true)
    assert.equal(db.get('A').status, 'CANCELLED')
    assert.equal(db.get('A').landedSha, null)
    assert.equal(db.meta().tipSha, 'start')
    assert.deepEqual(db.intents(), [])
    assert.equal(db.finish('A', a.lease, 'candidate'), false)
  } finally {
    db.close()
  }
})

test('isolated retry durably retires every old directory, branch and child across repeated recovery', (t) => {
  const file = tempDb(t)
  let db = new RunStore(file)
  try {
    init(db, manifest([ticket('A'), ticket('B')]))
    const first = db.claim('A', assignment('A'))
    assert.ok(
      db.move('A', first.lease, 'RUNNING', 'NEEDS_ATTENTION', {
        message: 'child still unconfirmed',
        sourceSha: 'recorded-source',
      }),
    )
    assert.equal(db.retry('A', { isolated: true }), true)
    const pending = db.get('A')
    assert.equal(pending.baseSha, first.baseSha)
    assert.equal(pending.attempt, 1)
    for (const field of ['path', 'branch', 'childId', 'lease', 'sourceSha'])
      assert.equal(pending[field], null)
    assert.deepEqual(db.events().at(-1).details, {
      path: first.path,
      branch: first.branch,
      childId: first.childId,
      attempt: 1,
      lease: first.lease,
      baseSha: first.baseSha,
      sourceSha: 'recorded-source',
    })
    assert.equal(
      db.move('A', first.lease, 'NEEDS_ATTENTION', 'SUBMITTED', { sourceSha: 'late-old-report' }),
      false,
    )
    db.close()
    db = new RunStore(file)
    // The retired generation's resources cannot be allocated even to a different ticket.
    assert.equal(db.claim('B', assignment('A')), null)
    const second = db.claim('A', assignment('A-replacement'))
    assert.equal(second.attempt, 2)
    assert.ok(db.move('A', second.lease, 'RUNNING', 'NEEDS_ATTENTION', { message: 'second child unknown' }))
    assert.ok(db.retry('A', { isolated: true }))
    db.close()
    db = new RunStore(file)
    const third = assignment('A-fresh')
    assert.equal(db.claim('A', { ...third, baseSha: 'different-base' }), null)
    for (const old of [first, second]) {
      assert.equal(db.claim('A', { ...third, path: old.path + '/.' }), null)
      assert.equal(db.claim('A', { ...third, branch: 'refs/heads/' + old.branch }), null)
      assert.equal(db.claim('A', { ...third, childId: old.childId }), null)
    }
    const active = db.claim('A', third)
    assert.equal(active.attempt, 3)
    assert.equal(active.baseSha, first.baseSha)
    assert.notEqual(active.lease, first.lease)
    assert.notEqual(active.lease, second.lease)
    assert.equal(db.events().filter((e) => e.type === 'isolated_retry_requested').length, 2)
  } finally {
    db.close()
  }
})

test('appended tickets follow the manifest rules, may depend on run or batch tickets, and leave the manifest unchanged', (t) => {
  const file = tempDb(t)
  let db = new RunStore(file)
  try {
    const spec = manifest([ticket('A'), ticket('B', ['A'])])
    init(db, spec)
    db.close()
    // A ledger from before dag_add has no appended table.
    const old = new DatabaseSync(file)
    old.exec('DROP TABLE appended')
    old.close()
    db = new RunStore(file)
    assert.deepEqual(db.appended(), [])
    const add = (tickets, limit = 20) => db.append(normalizeAppend(tickets, checks), { policyHash: 'append-hash', limit })
    assert.throws(() => normalizeAppend([], checks), /non-empty/)
    assert.deepEqual(normalizeAppend([{ ...ticket('X'), verify: [] }], checks)[0].verify, [], 'verify is optional')
    assert.throws(() => normalizeAppend([{ ...ticket('C'), verify: ['arbitrary'] }], checks), /unknown verification/)
    assert.throws(() => normalizeAppend([ticket('../C')], checks), /safe ID/)
    assert.throws(() => normalizeAppend([{ ...ticket('C'), title: ' ' }], checks), /title/)
    assert.throws(() => normalizeAppend([{ ...ticket('C'), agent: 'ghost' }], checks, {}), /unknown agent preset: ghost/)
    assert.throws(() => normalizeAppend([ticket('C'), ticket('c')], checks), /duplicate/)
    assert.throws(() => add([ticket('a')]), /duplicate/)
    assert.throws(() => add([ticket('C', ['Z'])]), /unknown dependency/)
    assert.throws(() => add([ticket('C', ['D']), ticket('D', ['C'])]), /cycle/)
    assert.deepEqual(db.appended(), [], 'a refused batch leaves nothing behind')
    const first = add([ticket('C', ['B']), ticket('D', ['C', 'A'])])
    assert.equal(first.added, true)
    assert.equal(first.batch, 1)
    assert.deepEqual(first.tickets, ['C', 'D'])
    assert.equal(typeof first.appendedAt, 'number')
    assert.deepEqual(
      db.tickets().map((r) => [r.id, r.status]),
      [
        ['A', 'PENDING'],
        ['B', 'PENDING'],
        ['C', 'PENDING'],
        ['D', 'PENDING'],
      ],
    )
    assert.deepEqual(db.get('D').dependsOn, ['C', 'A'])
    // Repeating the identical batch returns the existing result.
    assert.deepEqual(add([ticket('C', ['B']), ticket('D', ['C', 'A'])]), { ...first, added: false })
    assert.throws(() => add([{ ...ticket('C', ['B']), title: 'Other' }]), /different definition/)
    assert.throws(() => add([ticket('E'), ticket('F')], 3), /maxAppendedTickets.*new run/)
    assert.equal(db.get('E'), null)
    const second = add([ticket('E')], 3)
    assert.equal(second.batch, 2)
    assert.equal(JSON.stringify(db.meta().manifest), JSON.stringify(spec))
    db.close()
    db = new RunStore(file)
    assert.equal(JSON.stringify(db.meta().manifest), JSON.stringify(spec))
    assert.deepEqual(
      db.appended().map((b) => [b.batch, b.tickets.map((x) => x.id), typeof b.createdAt, b.policyHash]),
      [
        [1, ['C', 'D'], 'number', 'append-hash'],
        [2, ['E'], 'number', 'append-hash'],
      ],
    )
    assert.deepEqual(db.plan().map((x) => x.id), ['A', 'B', 'C', 'D', 'E'])
    assert.equal(db.events().filter((e) => e.type === 'tickets_appended').length, 2)
    assert.equal(db.setMode('cancelled'), true)
    assert.throws(() => add([ticket('G')]), /cancelled/)
  } finally {
    db.close()
  }
})

test('tickets appended to a staged run join the plan the user approves', (t) => {
  const db = new RunStore(tempDb(t))
  try {
    const spec = manifest([ticket('A')])
    db.init({
      runId: 'run-1',
      repo: { root: '/work', commonDir: '/work/.git' },
      ref: 'refs/heads/integration/run-1',
      baseSha: 'start',
      parentId: 'parent',
      policyHash: 'checks-hash',
      manifest: spec,
      mode: 'staged',
    })
    db.append(normalizeAppend([ticket('B', ['A'])], checks), { policyHash: 'append-hash' })
    assert.equal(db.meta().mode, 'staged')
    assert.equal(db.claim('B', assignment('B')), null)
    assert.throws(() => db.approve(spec.tickets), /ticket set/)
    const plan = db.plan()
    assert.equal(db.approve([plan[0], { ...plan[1], agent: 'docs', agentSpec: { model: 'fast-1' } }]), true)
    assert.equal(db.meta().mode, 'active')
    assert.deepEqual(db.get('B').agentSpec, { model: 'fast-1' })
    assert.equal(JSON.stringify(db.meta().manifest), JSON.stringify(spec))
  } finally {
    db.close()
  }
})
