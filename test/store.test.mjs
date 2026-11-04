import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { test } from 'node:test'
import { RunStore, normalizeManifest } from '../src/store.mjs'

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
  assert.throws(() => manifest([{ ...ticket('A'), verify: [] }]), /verification check/)
  assert.throws(() => manifest([{ ...ticket('A'), verify: ['arbitrary'] }]), /unknown verification/)
  assert.throws(
    () => normalizeManifest({ spec_id: 'x', tickets: [ticket('A')] }, { unit: ['node', '--test'] }),
    /argv/,
  )
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
