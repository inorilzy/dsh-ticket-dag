import test from 'node:test'
import assert from 'node:assert/strict'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { Coordinator } from '../src/coordinator.mjs'

// T09: an empty verify list means only "no check of its own". A ticket's
// candidate still runs the accumulated regression checks of the tickets already
// integrated in the run. These are real mixed runs on temporary Git repos.

const exec = promisify(execFile)
const env = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
}
const timeScale = process.platform === 'win32' ? 3 : 1
const limit = (ms) => ms * timeScale
async function git(cwd, ...args) {
  return (await exec('git', args, { cwd, env })).stdout.trim()
}
async function repo(t) {
  const root = await mkdtemp(join(tmpdir(), 'dag-t09-'))
  const cwd = join(root, 'project')
  await mkdir(cwd)
  await git(cwd, 'init', '-q', '-b', 'main')
  await git(cwd, 'config', 'user.name', 'fixture')
  await git(cwd, 'config', 'user.email', 'fixture@example.invalid')
  await git(cwd, 'commit', '--allow-empty', '-qm', 'seed')
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }))
  return { root, cwd }
}
// Write the submitted files, then commit with the ticket's completion trailers.
async function commitTicket(job, files) {
  for (const [name, body] of Object.entries(files)) await writeFile(join(job.cwd, name), body)
  await git(job.cwd, 'add', '-A')
  const trailers = [
    'DAG-Run: ' + job.runId,
    'DAG-Ticket: ' + job.ticketId,
    'DAG-Attempt: ' + job.attempt,
    'DAG-Complete: yes',
  ].join('\n')
  await git(job.cwd, 'commit', '-qm', 'Deliver ' + job.ticketId, '-m', trailers)
}
async function until(check, label, ms = 90000) {
  const deadline = Date.now() + limit(ms)
  while (Date.now() < deadline) {
    const value = await check()
    if (value) return value
    await sleep(40)
  }
  throw Error('Timeout: ' + label)
}

test(
  'a ticket with no own verify still runs the integrated ticket regression checks; a failure is not published',
  { timeout: limit(60000) },
  async (t) => {
    const { root, cwd } = await repo(t)
    // The regression check reads guard.txt in the candidate and fails when it is
    // not 'ok'. It appends what it saw to a log outside the checkout, so the
    // test can prove B's empty-verify candidate actually ran it.
    const log = join(root, 'regression-runs.log')
    const guard = [
      process.execPath,
      '-e',
      "const fs=require('fs');const v=fs.existsSync('guard.txt')?fs.readFileSync('guard.txt','utf8'):'';fs.appendFileSync(process.argv[1],v+'\\n');process.exit(v==='ok'?0:17)",
      log,
    ]
    const co = new Coordinator({
      checks: { guard: [guard] },
      notify: async () => true,
      launch: async (job) => ({
        dispose: async () => {},
        result: (async () => {
          if (job.ticketId === 'A') {
            // A brings its own check and keeps guard.txt healthy.
            await commitTicket(job, { 'A.txt': 'A', 'guard.txt': 'ok' })
          } else {
            // B has no verify of its own and breaks the guard A established.
            await commitTicket(job, { 'B.txt': 'B', 'guard.txt': 'broken' })
          }
          return { ok: true }
        })(),
      }),
    })
    const q = { cwd, parentId: 'captain', runId: 't09-mixed' }
    try {
      await co.start({
        ...q,
        manifest: { spec_id: 't09-mixed', tickets: [{ id: 'A', title: 'A', verify: ['guard'] }, { id: 'B', title: 'B', depends_on: ['A'], verify: [] }] },
      })
      const stuck = await until(async () => {
        const s = await co.status(q)
        return s.counts.NEEDS_ATTENTION && s
      }, 'B fails the accumulated regression check')
      const a = stuck.tickets.find((r) => r.id === 'A')
      const b = stuck.tickets.find((r) => r.id === 'B')
      assert.equal(a.status, 'INTEGRATED')
      assert.equal(b.status, 'NEEDS_ATTENTION')
      assert.match(b.message, /Check failed/, 'B failed in the candidate check step, not in the worker')

      // The accepted tip is still A's landed commit: B was never published.
      assert.equal(await git(cwd, 'rev-parse', 'integration/t09-mixed'), a.landedSha)
      await assert.rejects(git(cwd, 'cat-file', '-e', 'integration/t09-mixed:B.txt'))

      // A's own check ran on A's candidate, and B's empty-verify candidate ran
      // the same guard again (where it failed), proving the regression re-ran.
      const runs = (await readFile(log, 'utf8')).trim().split(/\r?\n/)
      assert.deepEqual(runs.slice(0, 2), ['ok', 'broken'])
      assert.equal(runs.filter((v) => v === 'broken').length, 1)
    } finally {
      await co.close()
    }
  },
)

test(
  'an empty-verify ticket with no historical checks integrates after a clean trial merge',
  { timeout: limit(60000) },
  async (t) => {
    const { cwd } = await repo(t)
    const co = new Coordinator({
      checks: {},
      notify: async () => true,
      launch: async (job) => ({
        dispose: async () => {},
        result: (async () => {
          await commitTicket(job, { [job.ticketId + '.txt']: job.ticketId })
          return { ok: true }
        })(),
      }),
    })
    const q = { cwd, parentId: 'captain', runId: 't09-empty' }
    try {
      const started = await co.start({
        ...q,
        manifest: { spec_id: 't09-empty', tickets: [{ id: 'A', title: 'A', verify: [] }, { id: 'B', title: 'B', depends_on: ['A'], verify: [] }] },
      })
      assert.equal(started.mode, 'active', 'no captain-written commands, so nothing waits for approval')
      const done = await until(async () => {
        const s = await co.status(q)
        if (s.counts.NEEDS_ATTENTION) throw Error(JSON.stringify(s.tickets.map((r) => [r.id, r.status, r.message])))
        return s.complete && s
      }, 'both empty-verify tickets integrated')
      assert.deepEqual(done.tickets.map((r) => r.verify), [[], []])
      assert.equal(done.counts.INTEGRATED, 2)
      assert.equal(await git(cwd, 'show', 'integration/t09-empty:B.txt'), 'B')
    } finally {
      await co.close()
    }
  },
)
