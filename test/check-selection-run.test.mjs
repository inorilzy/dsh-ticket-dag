import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { promisify } from 'node:util'
import { Coordinator } from '../src/coordinator.mjs'

// Same fixtures as test/coordinator.test.mjs: a throwaway repository and a
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
  throw Error('Timeout: ' + label)
}
async function repo(t) {
  const root = await mkdtemp(join(tmpdir(), 'dag-select-'))
  const cwd = join(root, 'project')
  await mkdir(cwd)
  await git(cwd, 'init', '-q', '-b', 'main')
  await git(cwd, 'config', 'user.name', 'fixture')
  await git(cwd, 'config', 'user.email', 'fixture@example.invalid')
  await git(cwd, 'commit', '--allow-empty', '-qm', 'seed')
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }))
  return cwd
}
// Each ticket writes the one file its ID maps to.
function worker(files) {
  return async (job) => ({
    dispose: async () => {},
    result: (async () => {
      const file = files[job.ticketId]
      await mkdir(dirname(join(job.cwd, file)), { recursive: true })
      await writeFile(join(job.cwd, file), job.ticketId + '\n')
      await git(job.cwd, 'add', '--', file)
      const trailers = ['DAG-Run: ' + job.runId, 'DAG-Ticket: ' + job.ticketId, 'DAG-Attempt: ' + job.attempt, 'DAG-Complete: yes']
      await git(job.cwd, 'commit', '-qm', 'Deliver ' + job.ticketId, '-m', trailers.join('\n'))
      return { ok: true }
    })(),
  })
}
const pass = [[process.execPath, '-e', 'process.exit(0)']]
const checks = { fast: pass, slow: pass, unit: pass }
const profileMeta = { fast: { files: ['**'], fast: true }, slow: { files: ['src/**'], fast: false } }

async function finish(co, q) {
  return until(async () => {
    const s = await co.status(q)
    if (s.counts.NEEDS_ATTENTION) throw Error(JSON.stringify(s.tickets.map((r) => [r.id, r.status, r.message])))
    return s.complete && s
  }, 'run complete')
}
function ledger(co, runId) {
  const run = [...co.runs.values()].find((r) => r.db.meta().runId === runId)
  return run.db
}
const of = (events, type, ticket) => events.filter((e) => e.type === type && e.ticketId === ticket)

test('with file selection a docs-only ticket skips the src check; a check without files always runs', { timeout: limit(120000) }, async (t) => {
  const cwd = await repo(t)
  const co = new Coordinator({
    checks,
    selectChecksByFiles: true,
    checkMeta: profileMeta,
    launch: worker({ D: 'docs/guide.md', S: 'src/logic.txt' }),
  })
  const q = { cwd, parentId: 'captain', runId: 'select' }
  try {
    const started = await co.start({
      ...q,
      manifest: {
        spec_id: 'select',
        tickets: [
          { id: 'D', title: 'D', verify: ['slow', 'unit'] },
          { id: 'S', title: 'S', depends_on: ['D'], verify: ['slow'] },
        ],
      },
    })
    assert.deepEqual(started.integration, { mode: 'each', selectChecksByFiles: true })
    await finish(co, q)
    const db = ledger(co, 'select')
    const meta = db.meta().manifest
    assert.deepEqual(meta.integration, { mode: 'each', selectChecksByFiles: true })
    assert.deepEqual(meta.checkMeta, { slow: { files: ['src/**'], fast: false } }, 'only metadata of used checks is frozen')
    const events = db.events()
    const [d] = of(events, 'checks_selected', 'D')
    assert.deepEqual(d.details, { stage: 'lane', run: ['unit'], skipped: ['slow'], fallback: null, changed: 1 })
    assert.deepEqual(of(events, 'verify_started', 'D')[0].details.checks, ['unit'])
    assert.deepEqual(of(events, 'check_finished', 'D').map((e) => e.details.checkId), ['unit'])
    const [s] = of(events, 'checks_selected', 'S')
    assert.deepEqual(s.details, { stage: 'lane', run: ['slow', 'unit'], skipped: [], fallback: null, changed: 1 })
    assert.deepEqual(of(events, 'check_finished', 'S').map((e) => e.details.checkId), ['slow', 'unit'])
    // Lane checks keep the old event shape: no stage field.
    assert.ok(of(events, 'check_finished', 'S').every((e) => !Object.hasOwn(e.details, 'stage')))
    const timing = (await co.status(q)).timing
    assert.equal(timing.totals.skippedChecks, 1)
    assert.equal(timing.totals.checkRuns, 3)
  } finally {
    await co.close()
  }
})

test('a change no declared check claims falls back to every check; the manifest overrides the profile', { timeout: limit(120000) }, async (t) => {
  const cwd = await repo(t)
  const co = new Coordinator({ checks, checkMeta: profileMeta, launch: worker({ R: 'README.md' }) })
  const q = { cwd, parentId: 'captain', runId: 'fallback' }
  try {
    await co.start({
      ...q,
      manifest: {
        spec_id: 'fallback',
        integration: { select_checks_by_files: true },
        check_meta: { fast: { files: ['src/**'] } },
        tickets: [{ id: 'R', title: 'R', verify: ['fast', 'slow'] }],
      },
    })
    await finish(co, q)
    const events = ledger(co, 'fallback').events()
    const [r] = of(events, 'checks_selected', 'R')
    assert.deepEqual(r.details, { stage: 'lane', run: ['fast', 'slow'], skipped: [], fallback: 'unclaimed:README.md', changed: 1 })
    assert.deepEqual(of(events, 'check_finished', 'R').map((e) => e.details.checkId), ['fast', 'slow'])
  } finally {
    await co.close()
  }
})

test('without file selection nothing is selected or recorded, even with checkMeta set', { timeout: limit(120000) }, async (t) => {
  const cwd = await repo(t)
  const co = new Coordinator({ checks, checkMeta: profileMeta, launch: worker({ D: 'docs/guide.md' }) })
  const q = { cwd, parentId: 'captain', runId: 'plain' }
  try {
    const started = await co.start({ ...q, manifest: { spec_id: 'plain', tickets: [{ id: 'D', title: 'D', verify: ['slow'] }] } })
    assert.deepEqual(started.integration, { mode: 'each', selectChecksByFiles: false })
    await finish(co, q)
    const events = ledger(co, 'plain').events()
    assert.equal(events.filter((e) => e.type === 'checks_selected').length, 0)
    assert.deepEqual(of(events, 'check_finished', 'D').map((e) => e.details.checkId), ['slow'])
    // The metadata is still frozen (later modes read fast from it); the default integration is not written.
    const manifest = ledger(co, 'plain').meta().manifest
    assert.equal(Object.hasOwn(manifest, 'integration'), false)
    assert.deepEqual(manifest.checkMeta, { slow: { files: ['src/**'], fast: false } })
  } finally {
    await co.close()
  }
})

test('an unknown integration mode is refused at dag_run before anything starts', async (t) => {
  const cwd = await repo(t)
  const co = new Coordinator({ checks, integrationMode: 'fast', launch: worker({}) })
  try {
    await assert.rejects(
      co.start({ cwd, parentId: 'captain', runId: 'train', manifest: { spec_id: 'b', tickets: [{ id: 'A', title: 'A' }] } }),
      /integration\.mode must be one of/,
    )
    assert.equal(co.runs.size, 0)
  } finally {
    await co.close()
  }
})
