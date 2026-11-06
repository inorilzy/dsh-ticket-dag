import test from 'node:test'
import assert from 'node:assert/strict'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as sleep } from 'node:timers/promises'
import { Coordinator } from '../src/coordinator.mjs'
import { RunCatalog, mountApproval, mountDashboard } from '../src/dashboard.mjs'

const exec = promisify(execFile)
const env = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
}
const noopChecks = { verify: [[process.execPath, '-e', 'process.exit(0)']] }
async function git(cwd, ...args) {
  return (await exec('git', args, { cwd, env })).stdout.trim()
}
function gate() {
  let release
  const wait = new Promise((r) => {
    release = r
  })
  return { wait, release }
}
async function repo(t) {
  const root = await mkdtemp(join(tmpdir(), 'dag-plugin-'))
  const cwd = join(root, 'project')
  await mkdir(cwd)
  await git(cwd, 'init', '-q', '-b', 'main')
  await git(cwd, 'config', 'user.name', 'fixture')
  await git(cwd, 'config', 'user.email', 'fixture@example.invalid')
  await git(cwd, 'commit', '--allow-empty', '-qm', 'seed')
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }))
  return cwd
}
async function commit(job, body = job.ticketId) {
  await writeFile(join(job.cwd, job.ticketId + '.txt'), body)
  await git(job.cwd, 'add', '--', job.ticketId + '.txt')
  const trailers = [
    'DAG-Run: ' + job.runId,
    'DAG-Ticket: ' + job.ticketId,
    'DAG-Attempt: ' + job.attempt,
    'DAG-Complete: yes',
  ].join('\n')
  await git(job.cwd, 'commit', '-qm', 'Deliver ' + job.ticketId, '-m', trailers)
}
const ticket = (id, depends_on = []) => ({ id, title: id, depends_on, verify: ['verify'] })
// Every Git call and check is a process start, which costs several times more on Windows.
const timeScale = process.platform === 'win32' ? 3 : 1
const limit = (ms) => ms * timeScale
async function until(check, label, ms = 90000) {
  const deadline = Date.now() + limit(ms)
  while (Date.now() < deadline) {
    const v = await check()
    if (v) return v
    await sleep(40)
  }
  throw Error('Timeout: ' + label)
}

test(
  '16 concurrent worker turns; no wave barrier; accepted dependencies, stable ref and one completion wake',
  { timeout: limit(110000) },
  async (t) => {
    const cwd = await repo(t),
      main = await git(cwd, 'rev-parse', 'HEAD'),
      all16 = gate(),
      slow = gate()
    const started = [],
      notices = [],
      lookup = new Map()
    let inFlight = 0,
      peak = 0,
      refilled = false
    const co = new Coordinator({
      maxWorkers: 16,
      checks: noopChecks,
      notify: async (e) => {
        notices.push(e)
        return true
      },
      launch: async (job) => {
        assert.equal(await git(job.cwd, 'rev-parse', 'HEAD'), job.baseSha)
        assert.equal(await git(job.cwd, 'branch', '--show-current'), job.branch)
        started.push(job.ticketId)
        lookup.set(job.ticketId, job.cwd)
        peak = Math.max(peak, ++inFlight)
        if (started.length === 16) all16.release()
        if (job.ticketId === 'refill') {
          refilled = true
          slow.release()
        }
        const result = (async () => {
          if (job.ticketId.startsWith('root')) {
            await all16.wait
            if (job.ticketId !== 'root0') await slow.wait
          }
          if (job.ticketId === 'join') {
            assert.equal(await readFile(join(job.cwd, 'root0.txt'), 'utf8'), 'root0')
            assert.equal(await readFile(join(job.cwd, 'root1.txt'), 'utf8'), 'root1')
          }
          await commit(job)
          return { ok: true }
        })().finally(() => inFlight--)
        return { result, dispose: async () => {} }
      },
    })
    const q = { cwd, parentId: 'captain', runId: 'rolling' }
    try {
      const manifest = {
        spec_id: 'rolling-demo',
        max_workers: 16,
        tickets: [
          ...Array.from({ length: 16 }, (_, i) => ticket('root' + i)),
          ticket('refill'),
          ticket('join', ['root0', 'root1']),
        ],
      }
      await co.start({ ...q, manifest })
      // Idempotent start returns the existing run and does not spawn duplicate workers.
      await co.start({ ...q, manifest })
      await assert.rejects(co.status({ ...q, parentId: 'other' }), /captain|ownership/)
      await until(() => refilled, 'a new root must start before the fifteen slow roots can finish')
      const done = await until(async () => {
        const s = await co.status(q)
        if (s.counts.NEEDS_ATTENTION) throw Error(JSON.stringify(s))
        return s.complete && s
      }, 'complete')
      assert.equal(peak, 16)
      assert.equal(new Set(started).size, 18)
      assert.equal(started.length, 18)
      assert.equal(new Set(lookup.values()).size, 18)
      assert.equal(done.counts.INTEGRATED, 18)
      assert.equal(await git(cwd, 'rev-parse', 'main'), main)
      assert.equal(await git(cwd, 'show', 'integration/rolling:join.txt'), 'join')
      assert.equal(
        await git(cwd, 'rev-list', '--count', '--first-parent', main + '..integration/rolling'),
        '18',
      )
      await until(() => notices.length, 'captain notice')
      assert.equal(notices.length, 1)
    } finally {
      all16.release()
      slow.release()
      await co.close()
    }
  },
)

test(
  'terminal transport error keeps dirty state for retry; lost completion receipt is adopted',
  { timeout: limit(45000) },
  async (t) => {
    const cwd = await repo(t),
      attempts = new Map()
    const co = new Coordinator({
      checks: noopChecks,
      retryDelayMs: 15,
      maxAutoRetries: 1,
      notify: async () => true,
      launch: async (job) => {
        attempts.set(job.ticketId, (attempts.get(job.ticketId) ?? 0) + 1)
        return {
          dispose: async () => {},
          result: (async () => {
            if (job.ticketId === 'A' && job.attempt === 1) {
              await writeFile(join(job.cwd, 'A.txt'), 'partial')
              return { ok: false, detail: 'TRANSPORT unexpected EOF' }
            }
            if (job.ticketId === 'A') assert.equal(await readFile(join(job.cwd, 'A.txt'), 'utf8'), 'partial')
            await commit(job)
            return job.ticketId === 'C' ? { ok: false, detail: 'STREAM_CLOSED' } : { ok: true }
          })(),
        }
      },
    })
    const q = { cwd, parentId: 'captain', runId: 'interrupted' }
    try {
      await co.start({
        ...q,
        manifest: { spec_id: 'r', tickets: [ticket('A'), ticket('C'), ticket('B', ['A', 'C'])] },
      })
      await until(async () => {
        const s = await co.status(q)
        if (s.counts.NEEDS_ATTENTION) throw Error(JSON.stringify(s))
        return s.complete
      }, 'recover all')
      assert.equal(attempts.get('A'), 2)
      assert.equal(attempts.get('C'), 1)
      assert.equal(attempts.get('B'), 1)
    } finally {
      await co.close()
    }
  },
)

test(
  'failed verification keeps accepted tip; repair is a new attempt on original ticket branch',
  { timeout: limit(45000) },
  async (t) => {
    const cwd = await repo(t)
    const checks = {
      verify: [
        [
          process.execPath,
          '-e',
          "if (require('fs').existsSync('A.txt') && require('fs').readFileSync('A.txt','utf8')!=='fixed') process.exit(4)",
        ],
      ],
    }
    const launches = []
    const co = new Coordinator({
      checks,
      notify: async () => true,
      launch: async (job) => {
        launches.push(job.ticketId)
        return {
          dispose: async () => {},
          result: (async () => {
            await commit(job, job.ticketId === 'A' && job.attempt > 1 ? 'fixed' : 'first')
            return { ok: true }
          })(),
        }
      },
    })
    const q = { cwd, parentId: 'cap', runId: 'repair' }
    try {
      const s0 = await co.start({
        ...q,
        manifest: { spec_id: 'repair', tickets: [ticket('A'), ticket('B', ['A'])] },
      })
      await until(async () => (await co.status(q)).counts.NEEDS_ATTENTION, 'rejected candidate')
      assert.deepEqual(launches, ['A'])
      assert.equal(await git(cwd, 'rev-parse', 'integration/repair'), s0.verifiedSha)
      await co.retry({ ...q, id: 'A' })
      await until(async () => {
        const s = await co.status(q)
        if (s.counts.NEEDS_ATTENTION) throw Error(JSON.stringify(s))
        return s.complete
      }, 'repair and follow-up')
      assert.deepEqual(launches, ['A', 'A', 'B'])
    } finally {
      await co.close()
    }
  },
)

test(
  'unknown activation is fenced; isolated retry leaves the old worktree and branch intact',
  { timeout: limit(45000) },
  async (t) => {
    const cwd = await repo(t),
      jobs = []
    let co
    co = new Coordinator({
      checks: noopChecks,
      notify: async () => true,
      canRetry: async () => false,
      launch: async (job) => {
        jobs.push(job)
        assert.equal(await co.childAuthorization({ ...job }), 'authorized')
        if (jobs.length === 1) {
          await writeFile(join(job.cwd, 'partial.txt'), 'old attempt')
          throw Error('ambiguous host acceptance')
        }
        await assert.rejects(readFile(join(job.cwd, 'partial.txt')), (e) => e.code === 'ENOENT')
        return {
          dispose: async () => {},
          result: (async () => {
            await commit(job)
            return { ok: true }
          })(),
        }
      },
    })
    const q = { cwd, parentId: 'p', runId: 'quarantine' }
    try {
      await co.start({ ...q, manifest: { spec_id: 'q', tickets: [ticket('A')] } })
      await until(async () => (await co.status(q)).counts.NEEDS_ATTENTION, 'uncertain child')
      assert.equal(await co.childAuthorization(jobs[0]), 'retired')
      await assert.rejects(co.retry({ ...q, id: 'A' }), /Cannot prove/)
      await co.retry({ ...q, id: 'A', isolated: true })
      const done = await until(async () => {
        const s = await co.status(q)
        if (s.counts.NEEDS_ATTENTION) throw Error(JSON.stringify(s))
        return s.complete && s
      }, 'isolated fallback')
      assert.equal(done.counts.INTEGRATED, 1)
      assert.equal(jobs.length, 2)
      assert.notEqual(jobs[0].cwd, jobs[1].cwd)
      assert.notEqual(jobs[0].branch, jobs[1].branch)
      assert.equal(await readFile(join(jobs[0].cwd, 'partial.txt'), 'utf8'), 'old attempt')
      assert.equal(await co.childAuthorization(jobs[1]), 'retired')
    } finally {
      await co.close()
    }
  },
)

test(
  'saving settings changes admission without cancelling workers and preserves each open run’s checks',
  { timeout: limit(45000) },
  async (t) => {
    const cwd = await repo(t)
    const holds = new Map(['A', 'B'].map((id) => [id, gate()]))
    const started = []
    const stops = []
    const failingChecks = { verify: [[process.execPath, '-e', 'process.exit(17)']] }
    const co = new Coordinator({
      maxWorkers: 1,
      checks: noopChecks,
      launch: async (job) => {
        started.push(job.ticketId)
        job.signal.addEventListener('abort', () => stops.push(job.ticketId), { once: true })
        return {
          dispose: async () => {},
          result: (async () => {
            await holds.get(job.ticketId)?.wait
            await commit(job)
            return { ok: true }
          })(),
        }
      },
    })
    const q = { cwd, parentId: 'captain', runId: 'open-run' }
    const update = (maxWorkers) =>
      co.updateSettings({ maxWorkers, checks: failingChecks, checkTimeoutMs: 20000 })
    try {
      await co.start({
        ...q,
        manifest: { spec_id: 'old', max_workers: 2, tickets: ['A', 'B', 'C'].map((id) => ticket(id)) },
      })
      await until(() => started.length === 1, 'first worker before settings change', 5000)
      update(2)
      await until(() => started.includes('B'), 'new slot wakes waiting worker', 5000)
      update(1)
      holds.get('B').release()
      await until(
        async () => (await co.status(q)).counts.INTEGRATED === 1,
        'B publishes under its original checks',
        9000,
      )
      assert.deepEqual(started, ['A', 'B'])
      assert.deepEqual(stops, [])
      holds.get('A').release()
      await until(
        async () => (await co.status(q)).complete,
        'remaining tickets integrate under the frozen checks',
        9000,
      )
      assert.deepEqual(started, ['A', 'B', 'C'])
      const next = { ...q, runId: 'next-run' }
      await co.start({ ...next, manifest: { spec_id: 'new', tickets: [ticket('D')] } })
      await until(
        async () => (await co.status(next)).counts.NEEDS_ATTENTION === 1,
        'new run applies the edited command',
        9000,
      )
    } finally {
      for (const item of holds.values()) item.release()
      await co.close()
    }
  },
)

test(
  'a ticket agent preset reaches the worker launch, its prompt and status; later edits do not change the run',
  { timeout: limit(120000) },
  async (t) => {
    const cwd = await repo(t)
    const jobs = []
    const hold = gate()
    const co = new Coordinator({
      checks: noopChecks,
      agents: { docs: { instructions: 'Edit documentation only.', provider: 'acme', model: 'fast-1' } },
      launch: async (job) => {
        jobs.push(job)
        return {
          dispose: async () => {},
          result: (async () => {
            if (job.ticketId === 'B') await hold.wait
            await commit(job)
            return { ok: true }
          })(),
        }
      },
    })
    const q = { cwd, parentId: 'captain', runId: 'agents' }
    try {
      await co.start({
        ...q,
        manifest: { spec_id: 'agents', tickets: [{ ...ticket('A'), agent: 'docs' }, { ...ticket('B', ['A']), agent: 'docs' }, ticket('C')] },
      })
      await until(() => jobs.some((j) => j.ticketId === 'B'), 'B starts after A', 60000)
      co.updateSettings({ checks: noopChecks, maxWorkers: 16, checkTimeoutMs: 20000, agents: { docs: { model: 'other' } } })
      hold.release()
      await until(async () => (await co.status(q)).complete, 'all integrate', 60000)
      const byId = Object.fromEntries(jobs.map((j) => [j.ticketId, j]))
      assert.deepEqual(byId.A.agentOptions, { provider: 'acme', model: 'fast-1' })
      assert.deepEqual(byId.B.agentOptions, { provider: 'acme', model: 'fast-1' })
      assert.match(byId.A.prompt, /Role \(docs\): Edit documentation only\./)
      assert.equal(byId.C.agentOptions, undefined)
      assert.doesNotMatch(byId.C.prompt, /Role/)
      assert.deepEqual(
        (await co.status(q)).tickets.map((r) => [r.id, r.agent, r.model]),
        [
          ['A', 'docs', 'acme/fast-1'],
          ['B', 'docs', 'acme/fast-1'],
          ['C', null, null],
        ],
      )
    } finally {
      hold.release()
      await co.close()
    }
  },
)

test(
  'a preset concurrency cap holds back only that preset; raising it in settings admits more at once',
  { timeout: limit(120000) },
  async (t) => {
    const cwd = await repo(t)
    const holds = new Map(['D1', 'D2', 'D3', 'P'].map((id) => [id, gate()]))
    const running = new Set()
    const started = []
    let peakDocs = 0
    const docs = { instructions: 'Docs.', maxConcurrent: 1 }
    const co = new Coordinator({
      checks: noopChecks,
      maxWorkers: 8,
      agents: { docs },
      launch: async (job) => {
        started.push(job.ticketId)
        running.add(job.ticketId)
        peakDocs = Math.max(peakDocs, [...running].filter((id) => id.startsWith('D')).length)
        return {
          dispose: async () => {},
          result: (async () => {
            await holds.get(job.ticketId).wait
            await commit(job)
            running.delete(job.ticketId)
            return { ok: true }
          })(),
        }
      },
    })
    const q = { cwd, parentId: 'captain', runId: 'preset-cap' }
    const docTicket = (id) => ({ ...ticket(id), agent: 'docs' })
    try {
      await co.start({
        ...q,
        manifest: { spec_id: 'cap', tickets: [docTicket('D1'), docTicket('D2'), docTicket('D3'), ticket('P')] },
      })
      await until(() => started.length === 2, 'one docs ticket and the plain ticket start', 60000)
      assert.deepEqual([...started].sort(), ['D1', 'P'])
      await sleep(300)
      assert.equal(started.length, 2, 'the other docs tickets wait for the cap')
      co.updateSettings({
        checks: noopChecks,
        maxWorkers: 8,
        checkTimeoutMs: 20000,
        agents: { docs: { ...docs, maxConcurrent: 2 } },
      })
      await until(() => started.includes('D2'), 'raised cap admits a second docs ticket', 60000)
      assert.equal(started.includes('D3'), false)
      assert.equal(peakDocs, 2)
      for (const item of holds.values()) item.release()
      await until(async () => (await co.status(q)).complete, 'all integrate', 60000)
      assert.equal(peakDocs, 2)
    } finally {
      for (const item of holds.values()) item.release()
      await co.close()
    }
  },
)

test(
  'with approval required a run waits staged; the user approval sets each ticket preset and model, then dispatch starts',
  { timeout: limit(120000) },
  async (t) => {
    const cwd = await repo(t)
    const jobs = []
    const co = new Coordinator({
      checks: noopChecks,
      requireApproval: true,
      agents: {
        docs: { instructions: 'Docs only.', provider: 'acme', model: 'fast-1' },
        impl: { instructions: 'Implement.' },
      },
      launch: async (job) => {
        jobs.push(job)
        return {
          dispose: async () => {},
          result: (async () => {
            await commit(job)
            return { ok: true }
          })(),
        }
      },
    })
    const q = { cwd, parentId: 'captain', runId: 'staged' }
    const plan = { spec_id: 'staged', tickets: [{ ...ticket('A'), agent: 'docs' }, ticket('B', ['A'])] }
    let reopened
    try {
      const started = await co.start({ ...q, manifest: plan })
      assert.equal(started.mode, 'staged')
      await sleep(400)
      assert.equal(jobs.length, 0, 'nothing is dispatched before approval')
      await assert.rejects(co.resume(q), /approv/)
      await co.pause(q)
      assert.equal((await co.status(q)).mode, 'staged')
      const [file] = co.runs.keys()
      await assert.rejects(co.approve(file, [{ id: 'A', agent: 'ghost' }]), /unknown agent preset/)
      await assert.rejects(co.approve(file, [{ id: 'A', agent: 'docs', provider: 'acme' }]), /without a model/)
      const approved = await co.approve(file, [
        { id: 'A', agent: 'docs', provider: 'acme', model: 'deep-2', reasoningEffort: 'high' },
        { id: 'B', agent: 'impl', provider: '', model: '', reasoningEffort: '' },
      ])
      assert.equal(approved.mode, 'active')
      // The captain may resubmit the original manifest: approval is not a manifest change.
      const again = await co.start({ ...q, manifest: plan })
      assert.equal(again.runId, 'staged')
      assert.equal(again.mode, 'active')
      assert.equal(again.tickets[0].model, 'acme/deep-2')
      assert.equal(again.tickets[1].agent, 'impl')
      await until(async () => (await co.status(q)).complete, 'approved run integrates', 60000)
      const byId = Object.fromEntries(jobs.map((j) => [j.ticketId, j]))
      assert.deepEqual(byId.A.agentOptions, { provider: 'acme', model: 'deep-2', reasoningEffort: 'high' })
      assert.match(byId.A.prompt, /Role \(docs\): Docs only\./)
      assert.equal(byId.B.agentOptions, undefined)
      assert.match(byId.B.prompt, /Role \(impl\): Implement\./)
      await assert.rejects(co.approve(file, []), /not waiting for approval/)
      await co.close()
      // A fresh coordinator loads the ledger and still accepts the original manifest.
      reopened = new Coordinator({
        checks: noopChecks,
        requireApproval: true,
        agents: co.agents,
        launch: async () => {
          throw Error('unexpected launch')
        },
      })
      const loaded = await reopened.start({ ...q, manifest: plan })
      assert.equal(loaded.complete, true)
      assert.equal(loaded.tickets[0].model, 'acme/deep-2')
      assert.equal(loaded.tickets[0].route.reasoningEffort, 'high')
    } finally {
      await co.close()
      await reopened?.close()
    }
  },
)

// A worker or captain shell writing the ledger directly, outside the coordinator.
function tamper(file, sql) {
  const db = new DatabaseSync(file)
  try {
    db.exec('PRAGMA busy_timeout=5000')
    db.exec(sql)
  } finally {
    db.close()
  }
}

test(
  'a staged run edited to active in the ledger is held, dispatches nothing and still waits for the user',
  { timeout: limit(60000) },
  async (t) => {
    const cwd = await repo(t)
    const jobs = []
    const co = new Coordinator({
      checks: noopChecks,
      requireApproval: true,
      launch: async (job) => {
        jobs.push(job)
        return {
          dispose: async () => {},
          result: (async () => {
            await commit(job)
            return { ok: true }
          })(),
        }
      },
    })
    const q = { cwd, parentId: 'captain', runId: 'forged-approval' }
    try {
      await co.start({ ...q, manifest: { spec_id: 'forged', tickets: [ticket('A')] } })
      const [file] = co.runs.keys()
      tamper(file, "UPDATE run SET mode='active'")
      const held = await co.status(q)
      await sleep(400)
      assert.equal(jobs.length, 0, 'a forged mode never dispatches')
      const after = await co.status(q)
      assert.equal(after.mode, 'staged')
      assert.match(after.diagnostic, /outside the coordinator/)
      assert.equal(held.tickets[0].status, 'PENDING')
      await assert.rejects(co.resume(q), /approv/)
      // The user can still approve the plan from the board.
      const approved = await co.approve(file, [{ id: 'A' }], { maxWorkers: 1 })
      assert.equal(approved.maxWorkers, 1, 'the user concurrency applies to the run')
      await until(async () => (await co.status(q)).complete, 'approved run integrates', 30000)
      assert.equal(jobs.length, 1)
    } finally {
      await co.close()
    }
  },
)

test(
  'a ticket verify edited in the ledger holds the run and its submission is never integrated',
  { timeout: limit(60000) },
  async (t) => {
    const cwd = await repo(t)
    const worker = gate()
    const co = new Coordinator({
      checks: { ...noopChecks, skip: [[process.execPath, '-e', 'process.exit(0)']] },
      launch: async (job) => ({
        dispose: async () => {},
        result: (async () => {
          await worker.wait
          await commit(job)
          return { ok: true }
        })(),
      }),
    })
    const q = { cwd, parentId: 'captain', runId: 'forged-verify' }
    try {
      const s0 = await co.start({ ...q, manifest: { spec_id: 'forged', tickets: [ticket('A')] } })
      const [file] = co.runs.keys()
      await until(async () => (await co.status(q)).tickets[0].status === 'RUNNING', 'worker started', 10000)
      tamper(file, `UPDATE tickets SET definition=json_set(definition,'$.verify',json('["skip"]')) WHERE id='A'`)
      worker.release()
      const held = await until(async () => {
        const s = await co.status(q)
        return s.mode === 'paused' && s.tickets[0].status === 'SUBMITTED' && s
      }, 'run held with the submission waiting', 20000)
      assert.match(held.diagnostic, /outside the coordinator/)
      // A shell may also try to lift the hold.
      tamper(file, "UPDATE run SET mode='active', diagnostic=NULL")
      await co.status(q)
      await sleep(600)
      const after = await co.status(q)
      assert.equal(after.tickets[0].status, 'SUBMITTED')
      assert.equal(after.mode, 'paused')
      assert.equal(await git(cwd, 'rev-parse', 'integration/forged-verify'), s0.verifiedSha)
      await assert.rejects(co.resume(q), /outside the coordinator/)
      assert.equal((await co.status(q)).tickets[0].status, 'SUBMITTED')
    } finally {
      worker.release()
      await co.close()
    }
  },
)

test(
  'a ticket whose planned preset was deleted from settings can still be approved with its frozen preset',
  { timeout: limit(60000) },
  async (t) => {
    const cwd = await repo(t)
    const jobs = []
    const co = new Coordinator({
      checks: noopChecks,
      requireApproval: true,
      agents: { docs: { instructions: 'Docs only.', provider: 'acme', model: 'fast-1' } },
      launch: async (job) => {
        jobs.push(job)
        return {
          dispose: async () => {},
          result: (async () => {
            await commit(job)
            return { ok: true }
          })(),
        }
      },
    })
    const q = { cwd, parentId: 'captain', runId: 'deleted-preset' }
    try {
      await co.start({ ...q, manifest: { spec_id: 'deleted', tickets: [{ ...ticket('A'), agent: 'docs' }] } })
      co.updateSettings({ checks: noopChecks, maxWorkers: 16, checkTimeoutMs: 20000, agents: {} })
      const [file] = co.runs.keys()
      await assert.rejects(co.approve(file, [{ id: 'A', agent: 'ghost' }]), /unknown agent preset/)
      const approved = await co.approve(file, [{ id: 'A', agent: 'docs', provider: 'acme', model: 'fast-1' }])
      assert.equal(approved.mode, 'active')
      await until(async () => (await co.status(q)).complete, 'approved run integrates', 30000)
      assert.match(jobs[0].prompt, /Role \(docs\): Docs only\./)
      assert.deepEqual(jobs[0].agentOptions, { provider: 'acme', model: 'fast-1' })
    } finally {
      await co.close()
    }
  },
)

test('a staged run can be discarded from the board without dispatching anything', { timeout: limit(60000) }, async (t) => {
  const cwd = await repo(t)
  let launched = 0
  const co = new Coordinator({
    checks: noopChecks,
    requireApproval: true,
    launch: async () => {
      launched++
      throw Error('unexpected launch')
    },
  })
  const q = { cwd, parentId: 'captain', runId: 'discard' }
  try {
    await co.start({ ...q, manifest: { spec_id: 'discard', tickets: [ticket('A')] } })
    const [file] = co.runs.keys()
    const after = await co.discard(file)
    assert.equal(after.mode, 'cancelled')
    assert.equal(after.tickets[0].status, 'CANCELLED')
    await sleep(300)
    assert.equal(launched, 0)
  } finally {
    await co.close()
  }
})

test(
  'status identifies a running worker and the exact cumulative check being executed',
  { timeout: limit(20000) },
  async (t) => {
    const cwd = await repo(t)
    const release = join(cwd, '..', 'allow-final-check')
    const worker = gate()
    const co = new Coordinator({
      checks: {
        first: [[process.execPath, '-e', 'process.exit(0)']],
        final: [
          [
            process.execPath,
            '-e',
            "const fs = require('node:fs'); const wait = setInterval(() => { if (fs.existsSync(process.argv[1])) clearInterval(wait) }, 20)",
            release,
          ],
        ],
      },
      launch: async (job) => ({
        dispose: async () => {},
        result: (async () => {
          await worker.wait
          await commit(job)
          return { ok: true }
        })(),
      }),
    })
    const q = { cwd, parentId: 'captain', runId: 'progress' }
    try {
      await co.start({
        ...q,
        manifest: {
          spec_id: 'progress',
          tickets: [{ id: 'A', title: 'Visible task title', verify: ['first', 'final'] }],
        },
      })
      const current = () => co.status(q).then((s) => s.tickets[0])
      await until(async () => (await current()).livePhase?.stage === 'agent', 'child executing', 5000)
      worker.release()
      const verifying = await until(
        async () => {
          const row = await current()
          return row.livePhase?.checkId === 'final' && row
        },
        'exact check appears',
        6500,
      )
      assert.equal(verifying.title, 'Visible task title')
      assert.equal(verifying.status, 'SUBMITTED')
      assert.deepEqual(verifying.livePhase, { stage: 'verify', checkId: 'final', index: 2, total: 2 })
      await writeFile(release, 'go')
      await until(async () => (await current()).status === 'INTEGRATED', 'verified', 4000)
      assert.equal((await current()).livePhase, null)
    } finally {
      worker.release()
      await writeFile(release, 'stop')
      await co.close()
    }
  },
)

test('a ledger error while recording a worker or merge failure holds the run without an unhandled rejection', { timeout: limit(60000) }, async (t) => {
  const cwd = await repo(t)
  const unhandled = []
  const record = (err) => unhandled.push(err)
  process.on('unhandledRejection', record)
  t.after(() => process.off('unhandledRejection', record))
  const worker = gate()
  const co = new Coordinator({
    checks: { ...noopChecks, fail: [[process.execPath, '-e', 'process.exit(17)']] },
    launch: async (job) => ({
      dispose: async () => {},
      result: (async () => {
        await worker.wait
        if (job.runId === 'worker-fails') return { ok: false, detail: 'worker gave up' }
        await commit(job)
        return { ok: true }
      })(),
    }),
  })
  const brokenLedger = (runId) => {
    const run = [...co.runs.values()].find((r) => r.db.meta().runId === runId)
    const move = run.db.move.bind(run.db)
    run.db.move = (...args) => {
      if (args[3] === 'NEEDS_ATTENTION') throw Error('ledger write failed for ' + runId)
      return move(...args)
    }
  }
  const worked = { cwd, parentId: 'captain', runId: 'worker-fails' }
  const merged = { cwd, parentId: 'captain', runId: 'merge-fails' }
  try {
    await co.start({ ...worked, manifest: { spec_id: 'w', tickets: [ticket('A')] } })
    await co.start({ ...merged, manifest: { spec_id: 'm', tickets: [{ ...ticket('B'), verify: ['fail'] }] } })
    brokenLedger('worker-fails')
    brokenLedger('merge-fails')
    worker.release()
    for (const q of [worked, merged]) {
      const held = await until(async () => {
        const s = await co.status(q)
        return s.mode === 'paused' && s
      }, 'held ' + q.runId)
      assert.match(held.diagnostic, new RegExp('ledger write failed for ' + q.runId))
    }
    await sleep(200)
    assert.deepEqual(unhandled, [])
  } finally {
    worker.release()
    await co.close()
  }
})

const exists = (path) =>
  readFile(path).then(
    () => true,
    (e) => (e.code === 'ENOENT' ? false : true),
  )
const ticketBranches = async (cwd) => (await git(cwd, 'branch', '--list', 'ticket/*')).split('\n').filter(Boolean)

test(
  'a completed run removes its integrated worktrees and branches after the captain is notified; dag_cleanup is idempotent',
  { timeout: limit(90000) },
  async (t) => {
    const cwd = await repo(t)
    const main = await git(cwd, 'rev-parse', 'main')
    const delivered = gate()
    const notices = []
    const options = {
      checks: noopChecks,
      notify: async (e) => {
        await delivered.wait
        notices.push(e)
        return true
      },
      launch: async (job) => ({
        dispose: async () => {},
        result: (async () => {
          await commit(job)
          return { ok: true }
        })(),
      }),
    }
    const co = new Coordinator(options)
    let reopened
    const q = { cwd, parentId: 'captain', runId: 'auto-clean' }
    try {
      await co.start({ ...q, manifest: { spec_id: 'clean', tickets: [ticket('A'), ticket('B', ['A'])] } })
      const done = await until(async () => {
        const s = await co.status(q)
        if (s.counts.NEEDS_ATTENTION) throw Error(JSON.stringify(s))
        return s.complete && s
      }, 'complete')
      const tip = await git(cwd, 'rev-parse', 'integration/auto-clean')
      await sleep(300)
      // Nothing is removed before the completion notice reaches the captain.
      for (const row of (await co.status(q)).tickets) {
        assert.equal(row.cleanup, null)
        assert.equal(await exists(join(row.path, 'A.txt')), true)
      }
      delivered.release()
      const cleaned = await until(async () => {
        const s = await co.status(q)
        return s.tickets.every((r) => r.cleanup === 'cleaned') && s
      }, 'auto cleanup')
      assert.equal(notices.length, 1)
      assert.deepEqual(cleaned.cleanup, { cleaned: 2, skipped: 0 })
      for (const row of done.tickets) assert.equal(await exists(join(row.path, 'A.txt')), false)
      assert.deepEqual(await ticketBranches(cwd), [])
      assert.equal(await git(cwd, 'rev-parse', 'main'), main)
      assert.equal(await git(cwd, 'rev-parse', 'integration/auto-clean'), tip)
      const again = await co.cleanup(q)
      assert.deepEqual(
        again.results.map((r) => [r.id, r.status]),
        [
          ['A', 'cleaned'],
          ['B', 'cleaned'],
        ],
      )
      await co.close()
      // An ended run reopened by a new coordinator can still be cleaned by hand, again without error.
      reopened = new Coordinator({ ...options, notify: async () => true })
      const old = await reopened.cleanup(q)
      assert.deepEqual(old.results.map((r) => r.status), ['cleaned', 'cleaned'])
      assert.deepEqual(old.cleanup, { cleaned: 2, skipped: 0 })
      assert.equal(await git(cwd, 'rev-parse', 'integration/auto-clean'), tip)
    } finally {
      delivered.release()
      await co.close()
      await reopened?.close()
    }
  },
)

test(
  'with autoCleanup off nothing is removed until it is switched on; a dirty worktree is skipped with its reason',
  { timeout: limit(90000) },
  async (t) => {
    const cwd = await repo(t)
    const settings = { checks: noopChecks, maxWorkers: 16, checkTimeoutMs: 20000 }
    const co = new Coordinator({
      ...settings,
      autoCleanup: false,
      notify: async () => true,
      launch: async (job) => ({
        dispose: async () => {},
        result: (async () => {
          await commit(job)
          return { ok: true }
        })(),
      }),
    })
    const q = { cwd, parentId: 'captain', runId: 'manual-clean' }
    try {
      await co.start({ ...q, manifest: { spec_id: 'manual', tickets: [ticket('A'), ticket('B')] } })
      const done = await until(async () => {
        const s = await co.status(q)
        if (s.counts.NEEDS_ATTENTION) throw Error(JSON.stringify(s))
        return s.complete && s.pendingNotifications === 0 && s
      }, 'complete and notified')
      await sleep(500)
      const paths = Object.fromEntries(done.tickets.map((r) => [r.id, r.path]))
      for (const row of (await co.status(q)).tickets) assert.equal(row.cleanup, null)
      assert.equal(await exists(join(paths.A, 'A.txt')), true)
      assert.equal((await ticketBranches(cwd)).length, 2)
      await writeFile(join(paths.A, 'scratch.txt'), 'keep me')
      co.updateSettings({ ...settings, autoCleanup: true })
      const after = await until(async () => {
        const s = await co.status(q)
        return s.tickets.every((r) => r.cleanup) && s
      }, 'cleanup after switching on')
      const [a, b] = after.tickets
      assert.equal(a.cleanup, 'skipped')
      assert.match(a.cleanupReason, /uncommitted/)
      assert.equal(b.cleanup, 'cleaned')
      assert.deepEqual(after.cleanup, { cleaned: 1, skipped: 1 })
      assert.equal(await readFile(join(paths.A, 'scratch.txt'), 'utf8'), 'keep me')
      assert.equal(await exists(join(paths.B, 'B.txt')), false)
      // A manual cleanup retries the skipped ticket once its worktree is clean.
      await rm(join(paths.A, 'scratch.txt'))
      const manual = await co.cleanup(q)
      assert.deepEqual(manual.results.map((r) => r.status), ['cleaned', 'cleaned'])
      assert.deepEqual(await ticketBranches(cwd), [])
    } finally {
      await co.close()
    }
  },
)

test(
  'a reconciliation error or a throwing dispose cannot keep cancel from stopping workers and a running check',
  { timeout: limit(60000) },
  async (t) => {
    const cwd = await repo(t)
    const pidFile = join(cwd, '..', 'check-pid').replaceAll('\\', '/')
    const signals = new Map()
    const co = new Coordinator({
      maxWorkers: 3,
      checkTimeoutMs: limit(120000),
      checks: {
        verify: [
          [
            process.execPath,
            '-e',
            `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`,
          ],
        ],
      },
      launch: async (job) => {
        signals.set(job.ticketId, job.signal)
        return {
          // The first worker's release entry fails before it can return a promise.
          dispose: () => {
            if (job.ticketId === 'B') throw Error('dispose failed')
            return Promise.resolve()
          },
          result:
            job.ticketId === 'A'
              ? commit(job).then(() => ({ ok: true }))
              : new Promise((resolve) => {
                  job.signal.addEventListener('abort', () => resolve({ ok: false, detail: 'stopped' }))
                }),
        }
      },
    })
    const q = { cwd, parentId: 'captain', runId: 'cancel-signals' }
    try {
      await co.start({
        ...q,
        manifest: {
          spec_id: 'cancel-signals',
          tickets: [ticket('A'), { id: 'B', title: 'B' }, { id: 'C', title: 'C' }],
        },
      })
      await until(async () => {
        const s = await co.status(q)
        return s.tickets[0].livePhase?.stage === 'verify' && signals.size === 3
      }, 'the check and both workers are running')
      const pid = Number(await until(() => readFile(pidFile, 'utf8').catch(() => ''), 'the check process started'))
      const [run] = co.runs.values()
      const integration = run.integration
      let aborted
      co._reconcile = async () => {
        aborted = [signals.get('B').aborted, signals.get('C').aborted, integration.ctrl.signal.aborted]
        throw Error('git exploded')
      }
      const after = await co.cancel(q)
      assert.deepEqual(aborted, [true, true, true], 'stop signals precede reconciliation')
      assert.equal(after.mode, 'cancelled')
      assert.equal(after.reconcileError, 'git exploded')
      assert.equal(after.diagnostic, 'git exploded')
      assert.equal(after.tickets.find((x) => x.id === 'A').livePhase, null)
      assert.equal(after.tickets.find((x) => x.id === 'A').status, 'CANCELLED')
      assert.equal(after.tickets.find((x) => x.id === 'C').status, 'CANCELLED')
      // B's stop could not be proven, so it stays for inspection instead of counting as cancelled.
      assert.equal(after.tickets.find((x) => x.id === 'B').status, 'NEEDS_ATTENTION')
      await until(() => {
        try {
          process.kill(pid, 0)
          return false
        } catch {
          return true
        }
      }, 'the check process is gone')
    } finally {
      await co.close()
    }
  },
)

for (const mode of ['automatic', 'manual'])
  test(
    mode + ' cleanup keeps local files, reports why through status and the board, then cleans once they are gone',
    { timeout: limit(120000) },
    async (t) => {
      const cwd = await repo(t)
      await writeFile(join(cwd, '.git', 'info', 'exclude'), '*.env\n')
      const settings = { checks: noopChecks, maxWorkers: 16, checkTimeoutMs: 20000 }
      const catalog = new RunCatalog()
      const co = new Coordinator({
        ...settings,
        autoCleanup: false,
        notify: async () => true,
        rememberRun: (file, meta, startedAt) => catalog.remember(file, meta, startedAt),
        launch: async (job) => ({
          dispose: async () => {},
          result: (async () => {
            await commit(job)
            return { ok: true }
          })(),
        }),
      })
      let board
      mountDashboard({ connection: { fetch: { register: (r) => (board = r) } } }, catalog, co)
      const q = { cwd, parentId: 'captain', runId: 'keep-' + mode }
      try {
        const ids = ['Ignored', 'Untracked', 'Tracked', 'Clean']
        await co.start({ ...q, manifest: { spec_id: 'keep', tickets: ids.map((id) => ticket(id)) } })
        const done = await until(async () => {
          const s = await co.status(q)
          if (s.counts.NEEDS_ATTENTION) throw Error(JSON.stringify(s))
          return s.complete && s.pendingNotifications === 0 && s
        }, 'complete and notified')
        const paths = Object.fromEntries(done.tickets.map((r) => [r.id, r.path]))
        const local = [
          [join(paths.Ignored, 'local.env'), 'ignored data', /ignored: "local\.env"/],
          [join(paths.Untracked, 'notes.txt'), 'untracked data', /untracked: "notes\.txt"/],
          [join(paths.Tracked, 'Tracked.txt'), 'edited data', /tracked changes: "Tracked\.txt"/],
        ]
        for (const [file, data] of local) await writeFile(file, data)

        let status
        if (mode === 'automatic') {
          co.updateSettings({ ...settings, autoCleanup: true })
          status = await until(async () => {
            const s = await co.status(q)
            return s.tickets.every((r) => r.cleanup) && s
          }, 'automatic cleanup')
        } else status = await co.cleanup(q)

        assert.deepEqual(status.cleanup, { cleaned: 1, skipped: 3 })
        const row = (rows, id) => rows.find((r) => r.id === id)
        const selected = (await (await board.fetch(new Request('http://localhost' + board.path))).json()).selected
        for (const [index, [file, data, reason]] of local.entries()) {
          assert.equal(await readFile(file, 'utf8'), data)
          for (const rows of [status.tickets, selected.tickets]) {
            assert.equal(row(rows, ids[index]).cleanup, 'skipped')
            assert.match(row(rows, ids[index]).cleanupReason, reason)
          }
        }
        assert.equal(row(selected.tickets, 'Clean').cleanup, 'cleaned')
        assert.equal(await exists(paths.Clean), false)
        assert.equal((await ticketBranches(cwd)).length, 3)

        // Retrying by hand while the files remain keeps them; once tidied, the same call cleans.
        const retried = await co.cleanup(q)
        assert.deepEqual(retried.results.map((r) => r.status), ['skipped', 'skipped', 'skipped', 'cleaned'])
        for (const [file, data] of local) assert.equal(await readFile(file, 'utf8'), data)
        await rm(local[0][0])
        await rm(local[1][0])
        await git(paths.Tracked, 'checkout', '--', 'Tracked.txt')
        for (let i = 0; i < 2; i++) {
          const cleaned = await co.cleanup(q)
          assert.deepEqual(cleaned.results.map((r) => r.status), ['cleaned', 'cleaned', 'cleaned', 'cleaned'])
          assert.deepEqual(cleaned.cleanup, { cleaned: 4, skipped: 0 })
          assert.deepEqual(await ticketBranches(cwd), [])
        }
      } finally {
        await co.close()
      }
    },
  )

test('a cancelled run is never cleaned', { timeout: limit(60000) }, async (t) => {
  const cwd = await repo(t)
  const co = new Coordinator({
    checks: noopChecks,
    notify: async () => true,
    launch: async (job) => ({
      dispose: async () => {},
      result: (async () => {
        if (job.ticketId === 'B') {
          // B keeps working until the run is cancelled.
          await new Promise((r) => job.signal.addEventListener('abort', r, { once: true }))
          return { ok: false, detail: 'cancelled' }
        }
        await commit(job)
        return { ok: true }
      })(),
    }),
  })
  const q = { cwd, parentId: 'captain', runId: 'cancel-clean' }
  try {
    await co.start({ ...q, manifest: { spec_id: 'cancel', tickets: [ticket('A'), ticket('B')] } })
    await until(async () => (await co.status(q)).counts.INTEGRATED === 1, 'A integrates')
    await co.cancel(q)
    const result = await co.cleanup(q)
    assert.ok(result.results.every((r) => r.status === 'skipped'))
    const a = result.tickets.find((r) => r.id === 'A')
    assert.equal(a.cleanup, null)
    assert.equal(await exists(join(a.path, 'A.txt')), true)
  } finally {
    await co.close()
  }
})

test('shutdown closes every run even if one run fails to close', { timeout: limit(60000) }, async (t) => {
  const cwd = await repo(t)
  const options = { checks: noopChecks, requireApproval: true, launch: async () => Error('unexpected launch') }
  const co = new Coordinator(options)
  const runIds = ['close-a', 'close-b', 'close-c']
  const closed = []
  let broken
  for (const runId of runIds)
    await co.start({ cwd, parentId: 'captain', runId, manifest: { spec_id: runId, tickets: [ticket('A')] } })
  for (const run of co.runs.values()) {
    const { runId } = run.db.meta()
    const [db, owner] = [run.db.close.bind(run.db), run.owner.close.bind(run.owner)]
    run.owner.close = () => {
      closed.push(runId + ' owner')
      owner()
    }
    if (runId === 'close-a') {
      broken = db
      run.db.close = () => {
        throw Error('ledger close failed')
      }
    } else
      run.db.close = () => {
        closed.push(runId + ' ledger')
        db()
      }
  }
  await assert.rejects(co.close(), (err) => err instanceof AggregateError && /ledger close failed/.test(err.errors[0].message))
  broken()
  assert.deepEqual(closed.sort(), ['close-a owner', 'close-b ledger', 'close-b owner', 'close-c ledger', 'close-c owner'])
  // Every run's ownership lock is released, so another coordinator can take each one over.
  const next = new Coordinator(options)
  try {
    for (const runId of runIds) assert.equal((await next.status({ cwd, parentId: 'captain', runId })).mode, 'staged')
  } finally {
    await next.close()
  }
})

test(
  'dag_add dispatches appended tickets without another approval, keeps approved member models and is capped',
  { timeout: limit(120000) },
  async (t) => {
    const cwd = await repo(t)
    const jobs = []
    const checks = { ...noopChecks, extra: [[process.execPath, '-e', 'process.exit(0)']] }
    const co = new Coordinator({
      checks,
      requireApproval: true,
      maxAppendedTickets: 3,
      agents: {
        docs: { instructions: 'Docs only.', provider: 'acme', model: 'fast-1' },
        impl: { instructions: 'Implement.', model: 'impl-1' },
      },
      notify: async () => true,
      launch: async (job) => {
        jobs.push(job)
        return {
          dispose: async () => {},
          result: (async () => {
            await commit(job)
            return { ok: true }
          })(),
        }
      },
    })
    const q = { cwd, parentId: 'captain', runId: 'append' }
    const plan = { spec_id: 'append', tickets: [{ ...ticket('A'), agent: 'docs' }] }
    try {
      await co.start({ ...q, manifest: plan })
      const [file] = co.runs.keys()
      await co.approve(file, [{ id: 'A', agent: 'docs', provider: 'acme', model: 'deep-2', reasoningEffort: 'high' }])
      await assert.rejects(co.add({ ...q, tickets: [{ ...ticket('X'), verify: ['nope'] }] }), /unknown verification/)
      await assert.rejects(co.add({ ...q, tickets: [ticket('X', ['Y']), ticket('Y', ['X'])] }), /cycle/)
      const batch = [
        { ...ticket('B', ['A']), agent: 'docs' },
        { ...ticket('C'), agent: 'impl', verify: ['extra'] },
      ]
      const added = await co.add({ ...q, tickets: batch })
      assert.equal(added.mode, 'active', 'no approval is needed for appended tickets')
      assert.deepEqual(
        added.tickets.map((r) => [r.id, r.appended, typeof r.appendedAt]),
        [
          ['A', false, 'object'],
          ['B', true, 'number'],
          ['C', true, 'number'],
        ],
      )
      // The appended check is frozen into the run like the manifest checks.
      co.updateSettings({ checks: noopChecks, agents: co.agents, maxAppendedTickets: 3, maxWorkers: 16, checkTimeoutMs: 20000 })
      const done = await until(async () => {
        const s = await co.status(q)
        if (s.counts.NEEDS_ATTENTION || s.mode !== 'active') throw Error(JSON.stringify(s))
        return s.complete && s
      }, 'appended tickets integrate', 60000)
      assert.equal(done.diagnostic, null, 'its own append is not mistaken for tampering')
      const byId = Object.fromEntries(jobs.map((j) => [j.ticketId, j]))
      assert.deepEqual(byId.B.agentOptions, { provider: 'acme', model: 'deep-2', reasoningEffort: 'high' })
      assert.match(byId.B.prompt, /Role \(docs\): Docs only\./)
      assert.deepEqual(byId.C.agentOptions, { model: 'impl-1' })
      // An identical batch is idempotent; the run still accepts its original manifest.
      const again = await co.add({ ...q, tickets: batch })
      assert.equal(again.tickets.length, 3)
      assert.equal((await co.start({ ...q, manifest: plan })).complete, true)
      await assert.rejects(co.add({ ...q, tickets: [{ ...batch[0], title: 'changed' }] }), /different definition/)
      await assert.rejects(co.add({ ...q, tickets: [ticket('D'), ticket('E')] }), /maxAppendedTickets.*new run/)
      assert.equal(jobs.length, 3)
      // Real tampering of an appended ticket is still detected.
      tamper(file, `UPDATE appended SET definition=json_set(definition,'$.title','forged') WHERE ticketId='B'`)
      const held = await until(async () => {
        const s = await co.status(q)
        return s.mode === 'paused' && s
      }, 'tampered append held', 20000)
      assert.match(held.diagnostic, /outside the coordinator/)
    } finally {
      await co.close()
    }
  },
)

test('tickets appended to a staged run wait for the user and are approved with the plan', { timeout: limit(60000) }, async (t) => {
  const cwd = await repo(t)
  const jobs = []
  const co = new Coordinator({
    checks: noopChecks,
    requireApproval: true,
    agents: { docs: { instructions: 'Docs only.', model: 'fast-1' } },
    launch: async (job) => {
      jobs.push(job)
      return {
        dispose: async () => {},
        result: (async () => {
          await commit(job)
          return { ok: true }
        })(),
      }
    },
  })
  const q = { cwd, parentId: 'captain', runId: 'append-staged' }
  try {
    await co.start({ ...q, manifest: { spec_id: 'staged', tickets: [ticket('A')] } })
    const added = await co.add({ ...q, tickets: [{ ...ticket('B', ['A']), agent: 'docs' }] })
    assert.equal(added.mode, 'staged')
    assert.equal(added.tickets[1].model, 'fast-1')
    await sleep(400)
    assert.equal(jobs.length, 0)
    assert.equal((await co.status(q)).diagnostic, null)
    const [file] = co.runs.keys()
    await co.approve(file, [{ id: 'A' }, { id: 'B', agent: 'docs', model: 'deep-2' }])
    await until(async () => (await co.status(q)).complete, 'approved plan with appended ticket integrates', 30000)
    assert.deepEqual(jobs.find((j) => j.ticketId === 'B').agentOptions, { model: 'deep-2' })
    await co.cancel(q)
    await assert.rejects(co.add({ ...q, tickets: [ticket('C')] }), /cancelled/)
  } finally {
    await co.close()
  }
})

test('reviewOnComplete asks for one review round on the first completion and not after the fixes land', { timeout: limit(90000) }, async (t) => {
  const cwd = await repo(t)
  const notices = []
  const co = new Coordinator({
    checks: {},
    reviewOnComplete: true,
    notify: async (n) => (notices.push(n.text), true),
    launch: async (job) => ({ dispose: async () => {}, result: (async () => (await commit(job), { ok: true }))() }),
  })
  const q = { cwd, parentId: 'captain', runId: 'review' }
  const completions = () => notices.filter((n) => /All tickets integrated/.test(n))
  try {
    await co.start({ ...q, manifest: { spec_id: 'rv', tickets: [{ id: 'A', title: 'A' }] } })
    await until(async () => completions().length === 1, 'first completion notice')
    const base = await git(cwd, 'rev-parse', 'main')
    assert.match(completions()[0], /Review step: run the code-review skill/)
    assert.ok(completions()[0].includes('git diff ' + base + '...integration/review'), completions()[0])
    assert.match(completions()[0], /dag_add to runId review/)
    await co.add({ ...q, tickets: [{ id: 'FIX1', title: 'Review fix' }] })
    await until(async () => completions().length === 2, 'second completion notice')
    assert.match(completions()[1], /without reviewing again/)
    assert.doesNotMatch(completions()[1], /Review step/)
  } finally {
    await co.close()
  }
  // Off by default: the completion notice is unchanged.
  const cwd2 = await repo(t)
  const plain = []
  const off = new Coordinator({
    checks: {},
    notify: async (n) => (plain.push(n.text), true),
    launch: async (job) => ({ dispose: async () => {}, result: (async () => (await commit(job), { ok: true }))() }),
  })
  try {
    await off.start({ cwd: cwd2, parentId: 'captain', runId: 'plain', manifest: { spec_id: 'p', tickets: [{ id: 'A', title: 'A' }] } })
    await until(async () => plain.some((n) => /All tickets integrated/.test(n)), 'plain completion')
    assert.ok(plain.every((n) => !/review/i.test(n)))
  } finally {
    await off.close()
  }
})

test('an integrated imported GitHub ticket is reported once when trackerWriteback is on; failures do not block', { timeout: limit(60000) }, async (t) => {
  const cwd = await repo(t)
  const reports = []
  const co = new Coordinator({
    checks: {},
    trackerWriteback: 'comment',
    writeback: async (q) => {
      reports.push(q)
      if (q.source.number === 3) throw new Error('gh offline')
      return { status: 'commented', target: q.source.repo + '#' + q.source.number }
    },
    launch: async (job) => ({ dispose: async () => {}, result: (async () => (await commit(job), { ok: true }))() }),
  })
  const q = { cwd, parentId: 'captain', runId: 'writeback' }
  const gh = (number) => ({ kind: 'github', repo: 'o/r', number })
  try {
    await co.start({
      ...q,
      manifest: {
        spec_id: 'gh-1',
        tickets: [
          { id: 'A', title: 'A', source: gh(2) },
          { id: 'B', title: 'B', depends_on: ['A'], source: gh(3) },
          { id: 'C', title: 'C', source: { kind: 'local', path: '.scratch/x/issues/01-c.md' } },
        ],
      },
    })
    const done = await until(async () => {
      const s = await co.status(q)
      if (s.counts.NEEDS_ATTENTION) throw Error(JSON.stringify(s))
      return s.complete && reports.length === 2 && s
    }, 'integrated and reported')
    assert.deepEqual(done.tickets.find((x) => x.id === 'A').source, gh(2))
    assert.deepEqual(reports.map((r) => [r.source.number, r.mode, r.ref, r.runId]).sort(), [
      [2, 'comment', 'refs/heads/integration/writeback', 'writeback'],
      [3, 'comment', 'refs/heads/integration/writeback', 'writeback'],
    ])
    const landed = done.tickets.find((x) => x.id === 'A').landedSha
    assert.equal(reports.find((r) => r.source.number === 2).landedSha, landed)
    const run = co.runs.values().next().value
    await run.writebacks
    const types = run.db.events().filter((e) => e.type.startsWith('writeback_')).map((e) => [e.ticketId, e.type])
    assert.deepEqual(types.sort(), [['A', 'writeback_done'], ['B', 'writeback_failed']])
  } finally {
    await co.close()
  }
})

// Both tickets edit the same line of shared.txt, so whichever lands second conflicts.
async function editShared(job, text) {
  await writeFile(join(job.cwd, 'shared.txt'), text + '\n')
  await git(job.cwd, 'add', '--', 'shared.txt')
  const trailers = ['DAG-Run: ' + job.runId, 'DAG-Ticket: ' + job.ticketId, 'DAG-Attempt: ' + job.attempt, 'DAG-Complete: yes']
  await git(job.cwd, 'commit', '-qm', 'Edit shared by ' + job.ticketId, '-m', trailers.join('\n'))
}
async function sharedRepo(t) {
  const cwd = await repo(t)
  await writeFile(join(cwd, 'shared.txt'), 'base\n')
  await git(cwd, 'add', 'shared.txt')
  await git(cwd, 'commit', '-qm', 'shared')
  return cwd
}

test('a trial merge conflict goes back to the ticket worker, which merges the tip and integrates', { timeout: limit(120000) }, async (t) => {
  const cwd = await sharedRepo(t)
  const prompts = []
  const gateA = gate()
  const co = new Coordinator({
    checks: {},
    launch: async (job) => {
      prompts.push([job.ticketId, job.attempt, job.prompt])
      return {
        dispose: async () => {},
        result: (async () => {
          if (job.ticketId === 'A') {
            await editShared(job, 'from A')
            gateA.release()
          } else if (job.attempt === 1) {
            await gateA.wait
            await editShared(job, 'from B')
          } else {
            // The resumed worker merges the integration tip, resolving to both lines.
            await git(job.cwd, 'merge', '--no-edit', 'integration/conflict').catch(() => {})
            await writeFile(join(job.cwd, 'shared.txt'), 'from A\nfrom B\n')
            await git(job.cwd, 'add', '--', 'shared.txt')
            const trailers = ['DAG-Run: ' + job.runId, 'DAG-Ticket: B', 'DAG-Attempt: ' + job.attempt, 'DAG-Complete: yes']
            await git(job.cwd, 'commit', '-qm', 'Merge tip into B', '-m', trailers.join('\n'))
          }
          return { ok: true }
        })(),
      }
    },
  })
  const q = { cwd, parentId: 'captain', runId: 'conflict' }
  try {
    await co.start({ ...q, manifest: { spec_id: 'c', tickets: [{ id: 'A', title: 'A' }, { id: 'B', title: 'B' }] } })
    const done = await until(async () => {
      const s = await co.status(q)
      if (s.counts.NEEDS_ATTENTION) throw Error(JSON.stringify(s.tickets.map((r) => [r.id, r.status, r.message])))
      return s.complete && s
    }, 'both integrated after the conflict')
    assert.equal(await git(cwd, 'show', 'integration/conflict:shared.txt'), 'from A\nfrom B')
    const b = done.tickets.find((r) => r.id === 'B')
    assert.equal(b.attempt, 2, 'B was requeued once')
    const retryPrompt = prompts.find(([id, attempt]) => id === 'B' && attempt === 2)[2]
    assert.match(retryPrompt, /conflicted with the integration branch/)
    assert.match(retryPrompt, /shared\.txt/)
    assert.match(retryPrompt, /git merge integration\/conflict/)
    assert.match(prompts[0][2], /Before the final commit, run git merge integration\/conflict/)
    const [run] = co.runs.values()
    assert.ok(run.db.events().some((e) => e.type === 'conflict_requeued' && e.ticketId === 'B'))
    assert.ok(!run.db.events().some((e) => e.type === 'needs_attention'))
  } finally {
    await co.close()
  }
})

test('conflict requeues are bounded; then the ticket needs attention with the conflicting files', { timeout: limit(120000) }, async (t) => {
  const cwd = await sharedRepo(t)
  const gateA = gate()
  const co = new Coordinator({
    checks: {},
    maxConflictRetries: 1,
    launch: async (job) => ({
      dispose: async () => {},
      result: (async () => {
        if (job.ticketId === 'A') {
          await editShared(job, 'from A')
          gateA.release()
        } else {
          await gateA.wait
          // Each attempt commits another conflicting edit without merging the tip.
          await editShared(job, 'from B ' + job.attempt)
        }
        return { ok: true }
      })(),
    }),
  })
  const q = { cwd, parentId: 'captain', runId: 'stuck' }
  try {
    await co.start({ ...q, manifest: { spec_id: 's', tickets: [{ id: 'A', title: 'A' }, { id: 'B', title: 'B' }] } })
    const s = await until(async () => {
      const s = await co.status(q)
      return s.counts.NEEDS_ATTENTION && s
    }, 'B needs attention')
    const b = s.tickets.find((r) => r.id === 'B')
    assert.equal(b.attempt, 2)
    assert.match(b.message, /Trial merge conflicts with the integration tip in: shared\.txt/)
  } finally {
    await co.close()
  }
})

test('dag_retry submits a new stamped commit for the current attempt instead of starting a worker', { timeout: limit(120000) }, async (t) => {
  const cwd = await sharedRepo(t)
  const gateA = gate()
  let launches = 0
  const co = new Coordinator({
    checks: {},
    maxConflictRetries: 0,
    canRetry: async () => true,
    launch: async (job) => {
      launches++
      return {
        dispose: async () => {},
        result: (async () => {
          if (job.ticketId === 'A') {
            await editShared(job, 'from A')
            gateA.release()
          } else {
            await gateA.wait
            await editShared(job, 'from B')
          }
          return { ok: true }
        })(),
      }
    },
  })
  const q = { cwd, parentId: 'captain', runId: 'adopt' }
  try {
    await co.start({ ...q, manifest: { spec_id: 'a', tickets: [{ id: 'A', title: 'A' }, { id: 'B', title: 'B' }] } })
    const stuck = await until(async () => {
      const s = await co.status(q)
      return s.counts.NEEDS_ATTENTION && s
    }, 'B conflicts')
    const b = stuck.tickets.find((r) => r.id === 'B')
    // The captain merges the tip on B's branch and commits it with B's current trailers.
    await git(b.path, 'merge', '--no-edit', 'integration/adopt').catch(() => {})
    await writeFile(join(b.path, 'shared.txt'), 'from A\nfrom B\n')
    await git(b.path, 'add', '--', 'shared.txt')
    await git(b.path, 'commit', '-qm', 'Captain merge', '-m', ['DAG-Run: adopt', 'DAG-Ticket: B', 'DAG-Attempt: 1', 'DAG-Complete: yes'].join('\n'))
    const before = launches
    const retried = await co.retry({ ...q, id: 'B' })
    assert.equal(retried.tickets.find((r) => r.id === 'B').status, 'SUBMITTED')
    await until(async () => {
      const s = await co.status(q)
      if (s.counts.NEEDS_ATTENTION) throw Error(JSON.stringify(s.tickets.map((r) => [r.id, r.status, r.message])))
      return s.complete
    }, 'B integrated from the captain commit', 60000)
    assert.equal(launches, before, 'no new worker was started')
    assert.equal(await git(cwd, 'show', 'integration/adopt:shared.txt'), 'from A\nfrom B')
  } finally {
    await co.close()
  }
})

test('a ticket without checks integrates after a clean merge, with an empty profile registry', { timeout: limit(60000) }, async (t) => {
  const cwd = await repo(t)
  const prompts = []
  const co = new Coordinator({
    checks: {},
    launch: async (job) => {
      prompts.push(job.prompt)
      return {
        dispose: async () => {},
        result: (async () => {
          await commit(job)
          return { ok: true }
        })(),
      }
    },
  })
  const q = { cwd, parentId: 'captain', runId: 'no-checks' }
  try {
    const started = await co.start({
      ...q,
      manifest: { spec_id: 'nochk', tickets: [{ id: 'A', title: 'A' }, { id: 'B', title: 'B', depends_on: ['A'], verify: [] }] },
    })
    assert.equal(started.mode, 'active', 'no captain-written commands, so nothing waits for approval')
    const done = await until(async () => {
      const s = await co.status(q)
      if (s.counts.NEEDS_ATTENTION) throw Error(JSON.stringify(s))
      return s.complete && s
    }, 'unchecked tickets integrated')
    assert.deepEqual(done.tickets.map((r) => r.verify), [[], []])
    assert.equal(await git(cwd, 'show', 'integration/no-checks:B.txt'), 'B')
    assert.match(prompts[0], /No automatic check is attached/)
  } finally {
    await co.close()
  }
})

test('checks the captain writes into the manifest wait for approval even without requireApproval, then run', { timeout: limit(60000) }, async (t) => {
  const cwd = await repo(t)
  const ran = join(cwd, '..', 'captain-check-ran')
  let launched = 0
  const co = new Coordinator({
    checks: noopChecks,
    requireApproval: false,
    launch: async (job) => {
      launched++
      return {
        dispose: async () => {},
        result: (async () => {
          await commit(job)
          return { ok: true }
        })(),
      }
    },
  })
  const q = { cwd, parentId: 'captain', runId: 'own-checks' }
  const own = { 'own-test': [[process.execPath, '-e', "require('node:fs').writeFileSync(process.argv[1], 'ok')", ran]] }
  try {
    // A manifest check may not reuse a profile check ID.
    await assert.rejects(
      co.start({ ...q, runId: 'clash', manifest: { spec_id: 'clash', checks: { verify: own['own-test'] }, tickets: [ticket('A')] } }),
      /already a profile check/,
    )
    const started = await co.start({
      ...q,
      manifest: { spec_id: 'own', checks: own, tickets: [{ id: 'A', title: 'A', verify: ['own-test', 'verify'] }] },
    })
    assert.equal(started.mode, 'staged', 'captain-written commands always wait for the user')
    assert.deepEqual(started.planChecks, ['own-test'])
    assert.deepEqual(started.checks['own-test'], own['own-test'], 'the review sees the exact commands')
    await sleep(300)
    assert.equal(launched, 0)
    // dag_add may reuse the manifest's check but cannot bring a new command past the review.
    await assert.rejects(
      co.add({ ...q, tickets: [{ id: 'X', title: 'X', verify: ['sneaky'] }] }),
      /unknown verification check: sneaky/,
    )
    await co.add({ ...q, tickets: [{ id: 'B', title: 'B', depends_on: ['A'], verify: ['own-test'] }] })
    const [file] = co.runs.keys()
    await co.approve(file, [])
    const done = await until(async () => {
      const s = await co.status(q)
      if (s.counts.NEEDS_ATTENTION) throw Error(JSON.stringify(s))
      return s.complete && s
    }, 'approved own checks ran and integrated')
    assert.equal(done.diagnostic, null)
    assert.equal(await readFile(ran, 'utf8'), 'ok', 'the captain-written command ran in the candidate')
    await co.close()
    // A new coordinator restores the run's own commands from the manifest and stays trusted.
    const reopened = new Coordinator({ checks: noopChecks, launch: async () => ({ dispose: async () => {}, result: new Promise(() => {}) }) })
    try {
      const after = await reopened.status(q)
      await sleep(300)
      assert.equal((await reopened.status(q)).diagnostic, null)
      assert.equal(after.complete, true)
    } finally {
      await reopened.close()
    }
  } finally {
    await co.close()
  }
})

test(
  'a completed run reopened by dag_add notifies completion again and cleans only the new tickets',
  { timeout: limit(90000) },
  async (t) => {
    const cwd = await repo(t)
    const notices = []
    const options = {
      checks: noopChecks,
      notify: async (e) => {
        notices.push(e)
        return true
      },
      launch: async (job) => ({
        dispose: async () => {},
        result: (async () => {
          await commit(job)
          return { ok: true }
        })(),
      }),
    }
    const co = new Coordinator(options)
    let reopened
    const q = { cwd, parentId: 'captain', runId: 'append-done' }
    const completions = () => notices.filter((n) => /All tickets integrated/.test(n.text)).length
    try {
      await co.start({ ...q, manifest: { spec_id: 'done', tickets: [ticket('A')] } })
      await until(async () => (await co.status(q)).tickets[0].cleanup === 'cleaned', 'first completion cleaned')
      assert.equal(completions(), 1)
      const added = await co.add({ ...q, tickets: [ticket('B', ['A'])] })
      assert.equal(added.complete, false, 'appending reopens a completed run')
      const done = await until(async () => {
        const s = await co.status(q)
        if (s.counts.NEEDS_ATTENTION) throw Error(JSON.stringify(s))
        return s.complete && s.tickets.every((r) => r.cleanup === 'cleaned') && s
      }, 'appended ticket integrated and cleaned')
      assert.equal(done.diagnostic, null)
      assert.equal(completions(), 2)
      const [run] = co.runs.values()
      assert.deepEqual(
        run.db.events().filter((e) => e.type === 'cleanup_cleaned').map((e) => e.ticketId),
        ['A', 'B'],
      )
      await co.close()
      // A new coordinator reloads the appended checks and keeps the run trusted.
      reopened = new Coordinator(options)
      const loaded = await reopened.status(q)
      await sleep(300)
      const after = await reopened.status(q)
      assert.equal(loaded.complete, true)
      assert.equal(after.mode, 'active')
      assert.equal(after.diagnostic, null)
      assert.deepEqual(after.tickets.map((r) => r.appended), [false, true])
    } finally {
      await co.close()
      await reopened?.close()
    }
  },
)

test(
  'the registered board shows every manifest command with exact argv; dag_add may first use one only after approval',
  { timeout: limit(120000) },
  async (t) => {
    const cwd = await repo(t)
    const recorder = "require('node:fs').writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)))"
    const usedRan = join(cwd, '..', 'used-ran')
    const laterRan = join(cwd, '..', 'later-ran')
    const evilRan = join(cwd, '..', 'evil-ran')
    const laterArgs = ['', 'a b', 'tab\tnew\nline\x07']
    const checks = {
      used: [[process.execPath, '-e', recorder, usedRan]],
      later: [[process.execPath, '-e', recorder, laterRan, ...laterArgs]],
    }
    const manifest = { spec_id: 'shown', checks, tickets: [{ id: 'A', title: 'A', verify: ['used'] }] }
    const catalog = new RunCatalog()
    const launched = []
    const options = {
      checks: noopChecks,
      requireApproval: false,
      rememberRun: (...args) => catalog.remember(...args),
      launch: async (job) => {
        launched.push(job.ticketId)
        return {
          dispose: async () => {},
          result: (async () => {
            await commit(job)
            return { ok: true }
          })(),
        }
      },
    }
    const handlers = (coordinator) => {
      const routes = {}
      const ctx = { connection: { fetch: { register: (r) => (routes[r.path] = r) } } }
      mountDashboard(ctx, catalog, coordinator, () => undefined)
      mountApproval(ctx, catalog, coordinator)
      return {
        board: async () =>
          (await routes['/api/ticket-dag.dashboard'].fetch(new Request('http://x/api/ticket-dag.dashboard'))).json(),
        post: (body) =>
          routes['/api/ticket-dag.approve'].fetch(
            new Request('http://x/api/ticket-dag.approve', {
              method: 'POST',
              headers: { 'content-type': 'application/json', 'x-dsh-ticket-dag': '1' },
              body: JSON.stringify(body),
            }),
          ),
      }
    }
    const q = { cwd, parentId: 'captain', runId: 'shown' }
    const settled = async (coordinator, label) =>
      until(async () => {
        const s = await coordinator.status(q)
        if (s.counts.NEEDS_ATTENTION) throw Error(JSON.stringify(s))
        return s.complete && s
      }, label)
    const co = new Coordinator(options)
    let reopened
    try {
      await co.start({ ...q, manifest })
      const { board, post } = handlers(co)
      const { selected } = await board()
      assert.equal(selected.mode, 'staged')
      assert.deepEqual(selected.checks, checks, 'the unused command is listed with its exact argv')
      assert.deepEqual(selected.planChecks, ['used', 'later'])
      assert.deepEqual(selected.tickets[0].verify, ['used'])
      assert.equal((await post({ key: selected.key, action: 'approve', choices: [] })).status, 200)
      await settled(co, 'A integrated')
      assert.equal(await readFile(laterRan, 'utf8').catch(() => null), null, 'an unused command does not run')

      // Approved: no ticket used this command yet, and the batch still cannot bring a new one.
      await assert.rejects(
        co.add({ ...q, tickets: [{ id: 'X', title: 'X', verify: ['sneaky'] }] }),
        /unknown verification check: sneaky/,
      )
      const batch = [{ id: 'B', title: 'B', depends_on: ['A'], verify: ['later'] }]
      const added = await co.add({ ...q, tickets: batch })
      assert.deepEqual(added.unapprovedChecks, [])
      assert.equal((await settled(co, 'B integrated')).diagnostic, null)
      assert.deepEqual(JSON.parse(await readFile(laterRan, 'utf8')), laterArgs, 'the approved argv reaches the program')
      assert.equal((await co.add({ ...q, tickets: batch })).tickets.length, 2, 'a repeated batch adds nothing')
      assert.equal((await co.start({ ...q, manifest })).mode, 'active', 'resubmitting the manifest stays idempotent')
      await co.close()

      // A later profile check with the same ID cannot displace the approved command.
      await rm(laterRan)
      reopened = new Coordinator({
        ...options,
        checks: {
          ...noopChecks,
          later: [[process.execPath, '-e', "require('node:fs').writeFileSync(process.argv[1], 'evil')", evilRan]],
        },
      })
      const loaded = await reopened.status(q)
      assert.equal(loaded.diagnostic, null)
      assert.deepEqual(loaded.checks.later, checks.later)
      assert.equal((await reopened.add({ ...q, tickets: batch })).tickets.length, 2, 'still idempotent once reopened')
      await reopened.add({ ...q, tickets: [{ id: 'C', title: 'C', depends_on: ['B'], verify: ['later'] }] })
      assert.equal((await settled(reopened, 'C integrated')).diagnostic, null)
      assert.deepEqual(JSON.parse(await readFile(laterRan, 'utf8')), laterArgs)
      assert.equal(await readFile(evilRan, 'utf8').catch(() => null), null)
      assert.deepEqual(launched, ['A', 'B', 'C'])
    } finally {
      await co.close()
      await reopened?.close()
    }
  },
)
