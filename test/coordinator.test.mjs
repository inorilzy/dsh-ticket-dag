import test from 'node:test'
import assert from 'node:assert/strict'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { Coordinator } from '../src/coordinator.mjs'

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
async function until(check, label, ms = 90000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const v = await check()
    if (v) return v
    await sleep(40)
  }
  throw Error('Timeout: ' + label)
}

test(
  '16 concurrent worker turns; no wave barrier; accepted dependencies, stable ref and one completion wake',
  { timeout: 110000 },
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
  { timeout: 45000 },
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
  { timeout: 45000 },
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
  { timeout: 45000 },
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
  { timeout: 45000 },
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
  { timeout: 120000 },
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
  { timeout: 120000 },
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
  'status identifies a running worker and the exact cumulative check being executed',
  { timeout: 20000 },
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
