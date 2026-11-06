import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import test from 'node:test'
import { Coordinator } from '../src/coordinator.mjs'
import * as git from '../src/git.mjs'
import { RunStore } from '../src/store.mjs'

const checks = { syntax: [[process.execPath, '--check', 'module.js']] }
const runId = 'cancel-recovery',
  parentId = 'captain'
const gitRun = (cwd, ...argv) =>
  execFileSync('git', argv, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

// A's publication fails for real with B still in flight and C waiting on A:
// the checkout occupying the integration branch refuses the CAS after the intent
// is durable, and its own commit then leaves Git at neither oldTip nor candidate.
async function failedPublication(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dag-coordinator-cancel-'))
  const main = join(dir, 'project'),
    occupant = join(dir, 'occupant')
  mkdirSync(main)
  gitRun(main, 'init', '-q', '--initial-branch=main')
  gitRun(main, 'config', 'user.name', 'Cancel test')
  gitRun(main, 'config', 'user.email', 'cancel@test.invalid')
  gitRun(main, 'config', 'commit.gpgSign', 'false')
  gitRun(main, 'commit', '--allow-empty', '-qm', 'seed')
  const workers = new Map()
  let publishA
  const allowA = new Promise((resolve) => {
    publishA = resolve
  })
  const coordinator = new Coordinator({
    checks,
    notify: async () => false,
    launch: async (job) => {
      const worker = { job, disposed: 0 }
      workers.set(job.ticketId, worker)
      return {
        dispose: async () => {
          worker.disposed++
        },
        result:
          job.ticketId === 'A'
            ? (async () => {
                await allowA
                writeFileSync(join(job.cwd, 'module.js'), 'export default 1\n')
                gitRun(job.cwd, 'add', 'module.js')
                gitRun(
                  job.cwd,
                  'commit',
                  '-qm',
                  'A\n\nDAG-Run: ' + runId + '\nDAG-Ticket: A\nDAG-Attempt: 1\nDAG-Complete: yes',
                )
                return { ok: true }
              })()
            : new Promise((resolve) => {
                job.signal.addEventListener('abort', () => resolve({ ok: false, detail: 'stopped' }))
              }),
      }
    },
  })
  t.after(async () => {
    try {
      await coordinator.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  const query = { cwd: main, runId, parentId }
  const started = await coordinator.start({
    ...query,
    manifest: {
      spec_id: 'cancel',
      max_workers: 2,
      tickets: [
        { id: 'A', title: 'A', verify: ['syntax'] },
        { id: 'B', title: 'B' },
        { id: 'C', title: 'C', depends_on: ['A'] },
      ],
    },
  })
  const seen = async (check, label) => {
    for (let i = 0; i < 600; i++) {
      const snapshot = await coordinator.status(query)
      if (check(snapshot)) return snapshot
      await sleep(100)
    }
    assert.fail(label + ': ' + JSON.stringify(await coordinator.status(query)))
  }
  const repo = await git.repoInfo(main)
  const dbPath = join(repo.commonDir, 'dsh-ticket-dag', 'runs', runId, 'state.sqlite')
  await seen(() => workers.size === 2, 'A and B start')
  gitRun(main, 'worktree', 'add', '-q', occupant, started.integrationRef.replace('refs/heads/', ''))
  publishA()
  const held = await seen((s) => s.mode === 'paused' && s.tickets[0].status === 'PUBLISHING', 'A publication holds')
  // A hold does not stop workers, so the signal asserted below can only come from cancel.
  assert.equal(workers.get('B').job.signal.aborted, false)
  assert.equal(workers.get('B').disposed, 0)
  gitRun(occupant, 'commit', '--allow-empty', '-qm', 'unrecorded external change')
  const foreign = gitRun(occupant, 'rev-parse', 'HEAD')
  const ref = started.integrationRef
  const base = started.verifiedSha
  const candidate = held.pendingPublications[0].candidateSha
  const events = (type) => {
    const reader = new RunStore(dbPath)
    try {
      return reader.events().filter((e) => e.type === type).length
    } finally {
      reader.close()
    }
  }
  const stopped = await coordinator.cancel(query)
  assert.equal(stopped.mode, 'cancelled')
  assert.match(stopped.reconcileError, /Unrecognized target tip/)
  assert.match(stopped.diagnostic, /Unrecognized target tip/)
  assert.equal(workers.get('B').job.signal.aborted, true)
  assert.equal(workers.get('B').disposed > 0, true)
  assert.deepEqual(
    stopped.tickets.map((x) => x.status),
    ['PUBLISHING', 'CANCELLED', 'CANCELLED'],
  )
  assert.equal(stopped.pendingPublications.length, 1)
  assert.equal(stopped.verifiedSha, base)
  assert.equal(await git.resolveRef(repo, ref), foreign)
  assert.equal(existsSync(stopped.tickets[0].path), true)
  assert.equal(existsSync(stopped.tickets[1].path), true)
  return { main, query, coordinator, workers, ref, base, foreign, candidate, repo, events, dbPath }
}

test(
  'a failed reconciliation stops the worker, keeps the evidence, and a repeated cancel abandons what never published',
  { timeout: 180000 },
  async (t) => {
    const f = await failedPublication(t)
    await sleep(300)
    assert.equal(f.workers.size, 2, 'C must not be dispatched after the cancel')

    // Repeating changes nothing while Git still cannot be reconciled.
    const blocked = f.events('run_blocked')
    const disposed = f.workers.get('B').disposed
    const same = await f.coordinator.cancel(f.query)
    assert.equal(same.mode, 'cancelled')
    assert.match(same.reconcileError, /Unrecognized target tip/)
    assert.equal(same.tickets[0].status, 'PUBLISHING')
    assert.equal(same.pendingPublications.length, 1)
    assert.equal(f.events('run_cancelled'), 1)
    assert.equal(f.events('run_blocked'), blocked)
    assert.equal(f.workers.get('B').disposed, disposed)
    assert.equal(await git.resolveRef(f.repo, f.ref), f.foreign)

    // The evidence is on disk, not only in this process.
    await f.coordinator.close()
    const reader = new RunStore(f.dbPath)
    try {
      assert.equal(reader.meta().mode, 'cancelled')
      assert.match(reader.meta().diagnostic, /Unrecognized target tip/)
      assert.equal(reader.intents().length, 1)
      assert.equal(reader.get('A').status, 'PUBLISHING')
      assert.equal(reader.pendingNotifications().filter((n) => /Unrecognized/.test(n.message)).length, 1)
    } finally {
      reader.close()
    }
    const reopened = new Coordinator({ checks, launch: async () => assert.fail('no launch'), notify: async () => false })
    try {
      const cold = await reopened.status(f.query)
      assert.equal(cold.mode, 'cancelled')
      assert.match(cold.diagnostic, /Unrecognized target tip/)
      assert.equal(cold.pendingPublications.length, 1)
      assert.equal(f.events('run_blocked'), blocked)

      gitRun(f.main, 'update-ref', f.ref, f.base, f.foreign)
      const settled = await reopened.cancel(f.query)
      assert.equal(settled.reconcileError, null)
      assert.equal(settled.diagnostic, null)
      assert.equal(settled.tickets[0].status, 'CANCELLED')
      assert.equal(settled.tickets[0].landedSha, null)
      assert.deepEqual(settled.pendingPublications, [])
      assert.equal(settled.verifiedSha, f.base)
      assert.equal(await git.resolveRef(f.repo, f.ref), f.base)
      assert.equal(f.events('run_blocked'), blocked, 'the failure stays in the event log')

      const noop = await reopened.cancel(f.query)
      assert.equal(noop.reconcileError, null)
      assert.equal(f.events('run_cancelled'), 1)
    } finally {
      await reopened.close()
    }
  },
)

test('a repeated cancel accounts an intent once Git proves it was published', { timeout: 180000 }, async (t) => {
  const f = await failedPublication(t)
  gitRun(f.main, 'update-ref', f.ref, f.candidate, f.foreign)
  const again = await f.coordinator.cancel(f.query)
  assert.equal(again.reconcileError, null)
  assert.equal(again.diagnostic, null)
  assert.equal(again.mode, 'cancelled')
  assert.equal(again.tickets[0].status, 'INTEGRATED')
  assert.equal(again.tickets[0].landedSha, f.candidate)
  assert.deepEqual(again.pendingPublications, [])
  assert.equal(again.verifiedSha, f.candidate)
  assert.equal(await git.resolveRef(f.repo, f.ref), f.candidate)
  assert.equal(f.events('run_completed'), 0)
  assert.equal(f.workers.size, 2)
})
