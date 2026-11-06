import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { promisify } from 'node:util'

// dag_cancel through the real plugin entry: only the DSH packages and the host
// services are fixtures. The Coordinator, Git and SQLite are the real ones, and
// a real host's stop is asserted separately by test/dsh-e2e.mjs.
const definitions = new Map(
  Object.entries({
    '@deepseek-ai/dsh-tools': 'export const defineTool = value => value',
    '@deepseek-ai/dsh-llm': 'export const createUserMessage = value => ({id: "msg", ...value})',
    '@deepseek-ai/schemastery':
      'const schema = new Proxy({}, {get: () => () => schema}); export default schema',
  }),
)
const hook = registerHooks({
  resolve(specifier, context, next) {
    if (definitions.has(specifier) && context.parentURL?.endsWith('/src/index.mjs')) {
      return {
        url: 'data:text/javascript,' + encodeURIComponent(definitions.get(specifier)),
        shortCircuit: true,
      }
    }
    return next(specifier, context)
  },
})
const { apply } = await import('../src/index.mjs')
hook.deregister()

const gitRun = (cwd, ...argv) =>
  execFileSync('git', argv, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const exec = promisify(execFile)
// For worker fixtures: a synchronous child would stall the coordinator under test.
const gitAsync = async (cwd, ...argv) => (await exec('git', argv, { cwd, encoding: 'utf8' })).stdout.trim()
// Every Git call and check is a process start, which costs several times more on Windows.
const timeScale = process.platform === 'win32' ? 3 : 1
const limit = (ms) => ms * timeScale

function host(cwd) {
  const roster = new Map(),
    logs = new Map(),
    tools = new Map(),
    events = new Map(),
    children = new Map()
  let cleanup, publishA
  const allowA = new Promise((resolve) => {
    publishA = resolve
  })
  function add(id, header, descriptor = []) {
    const session = { header: { id, ...header } }
    const log = { session: session.header, inheritedEventCount: 0, events: descriptor }
    const agent = {
      id,
      session,
      followup(message) {
        log.events.push({ type: 'agent/inbox/spliced', data: { inserted: [message] } })
      },
    }
    logs.set(id, log)
    roster.set(id, agent)
    return agent
  }
  const root = add('root', {})
  const ctx = {
    tools: {
      register: (tool) => tools.set(tool.name, tool),
      guard() {},
    },
    systemPrompt: { section() {}, getSectionOrder: () => 1 },
    agents: { get: (id) => roster.get(id), list: () => [...roster.values()] },
    workingDirectory: { ensure: async () => cwd },
    sessions: { flush: async () => true },
    sessionQuery: {
      readSession: async (id) => {
        if (!logs.has(id)) throw Error('missing')
        return logs.get(id)
      },
    },
    subagents: {
      async startActivation(spec) {
        const ticketId = spec.label.split('/').at(-1).split('#')[0]
        const child = {
          ticketId,
          signal: spec.signal,
          disposed: 0,
          agent: add(
            spec.childId,
            { origin: 'subagent', delegationDepth: 1, parentSession: 'root', cwd: spec.request.cwd },
            [{ type: 'subagent/descriptor', data: { label: spec.label } }],
          ),
        }
        children.set(ticketId, child)
        const result =
          ticketId === 'A'
            ? allowA.then(async () => {
                writeFileSync(join(spec.request.cwd, 'A.txt'), 'A')
                await gitAsync(spec.request.cwd, 'add', 'A.txt')
                await gitAsync(
                  spec.request.cwd,
                  'commit',
                  '-qm',
                  'A\n\nDAG-Run: host-cancel\nDAG-Ticket: A\nDAG-Attempt: 1\nDAG-Complete: yes',
                )
                return { stopReason: 'completed', output: [] }
              })
            : // The host ends an activation once its signal aborts.
              new Promise((resolve) => {
                spec.signal.addEventListener('abort', () =>
                  resolve({ stopReason: 'aborted', diagnostic: 'stopped', output: [] }),
                )
              })
        return {
          childId: spec.childId,
          result,
          dispose: async () => {
            child.disposed++
          },
        }
      },
    },
    logger: { warn() {} },
    get: () => undefined,
    on: (name, fn) => events.set(name, fn),
    effect: (start) => {
      cleanup = start()
    },
  }
  apply(ctx, { checks: {}, maxWorkers: 2, requireApproval: false })
  return {
    root,
    logs,
    events,
    children,
    publishA,
    invoke: async (key, args) => tools.get(key).execute(args, { agent: root, signal: new AbortController().signal }),
    close: () => cleanup(),
  }
}

async function until(check, label) {
  const deadline = Date.now() + limit(150000)
  while (Date.now() < deadline) {
    const value = await check()
    if (value) return value
    await sleep(20)
  }
  assert.fail('Timeout: ' + label)
}

test('dag_cancel stops the host worker and fences its tools although reconciliation fails', { timeout: limit(180000) }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dag-host-cancel-'))
  const main = join(dir, 'project'),
    occupant = join(dir, 'occupant')
  mkdirSync(main)
  gitRun(main, 'init', '-q', '--initial-branch=main')
  gitRun(main, 'config', 'user.name', 'Host cancel')
  gitRun(main, 'config', 'user.email', 'host@test.invalid')
  gitRun(main, 'config', 'commit.gpgSign', 'false')
  gitRun(main, 'commit', '--allow-empty', '-qm', 'seed')
  const h = host(main)
  t.after(async () => {
    try {
      await h.close()
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
    }
  })
  const runId = 'host-cancel'
  const started = await h.invoke('dag_run', {
    runId,
    manifest: {
      spec_id: 'host-cancel',
      max_workers: 2,
      tickets: [
        { id: 'A', title: 'A' },
        { id: 'B', title: 'B' },
        { id: 'C', title: 'C', depends_on: ['A'] },
      ],
    },
  })
  await until(() => h.children.size === 2, 'A and B start')
  const worker = h.children.get('B')
  const preExecute = () => h.events.get('tools/pre-execute')({ agent: worker.agent }, async () => ({ kind: 'allow' }))
  assert.deepEqual(await preExecute(), { kind: 'allow' })

  gitRun(main, 'worktree', 'add', '-q', occupant, started.integrationRef.replace('refs/heads/', ''))
  h.publishA()
  await until(async () => {
    const s = await h.invoke('dag_status', { runId })
    return s.mode === 'paused' && s.tickets[0].status === 'PUBLISHING'
  }, 'A publication holds')
  assert.equal(worker.signal.aborted, false)
  gitRun(occupant, 'commit', '--allow-empty', '-qm', 'unrecorded external change')

  const stopped = await h.invoke('dag_cancel', { runId })
  assert.equal(stopped.mode, 'cancelled')
  assert.match(stopped.reconcileError, /Unrecognized target tip/)
  assert.equal(worker.signal.aborted, true)
  assert.equal(worker.disposed > 0, true)
  assert.deepEqual(
    stopped.tickets.map((x) => x.status),
    ['PUBLISHING', 'CANCELLED', 'CANCELLED'],
  )
  assert.equal(stopped.pendingPublications.length, 1)
  assert.equal((await preExecute()).kind, 'deny')
  await until(
    () =>
      h.logs
        .get('root')
        .events.some((e) => JSON.stringify(e.data.inserted).includes('Unrecognized target tip')),
    'the captain is told about the reconciliation error',
  )

  const status = await h.invoke('dag_status', { runId })
  assert.match(status.diagnostic, /Unrecognized target tip/)
  assert.equal(status.pendingPublications.length, 1)
  // The plugin hides its scheduler, so this one waits a scaled window; a claim would also count an attempt.
  await sleep(limit(500))
  assert.equal(h.children.size, 2, 'C must not be dispatched after the cancel')
  assert.equal((await h.invoke('dag_status', { runId })).tickets[2].attempt, 0, 'C was never claimed')
})
