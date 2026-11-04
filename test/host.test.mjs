import test from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { setImmediate as afterPublication } from 'node:timers/promises'

// These are host-contract tests. Git/SQLite and the scheduler have separate tests.
// Test at the Cordis boundary without requiring an installed DSH profile or an API key.
const definitions = new Map(
  Object.entries({
    '@deepseek-ai/dsh-tools': 'export const defineTool = value => value',
    '@deepseek-ai/dsh-llm': 'export const createUserMessage = value => ({id: "msg", ...value})',
    '@deepseek-ai/schemastery':
      'const schema = new Proxy({}, {get: () => () => schema}); export default schema',
    './coordinator.mjs':
      'export class Coordinator { constructor(options) { return globalThis[Symbol.for("dag-test-coordinator")](options) } }',
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

function harness(extra = {}) {
  const calls = [],
    roster = new Map(),
    logs = new Map(),
    tools = new Map(),
    events = new Map()
  let cleanup, api
  const controller = {}
  for (const action of ['start', 'attach', 'status', 'pause', 'resume', 'retry', 'cancel', 'close']) {
    controller[action] = async (request) => {
      calls.push([action, request])
      return { action }
    }
  }
  globalThis[Symbol.for('dag-test-coordinator')] = (opts) => {
    api = opts
    return controller
  }
  function add(id, header = {}) {
    const session = { header: { id, ...header } }
    const log = { session: session.header, inheritedEventCount: 0, events: [] }
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
  const root = add('root'),
    child = add('child', { origin: 'subagent', delegationDepth: 1, parentSession: 'root' })
  const ctx = {
    tools: {
      register(tool) {
        tools.set(tool.name, tool)
      },
      guard(fn) {
        events.set('guard', fn)
      },
    },
    systemPrompt: {
      section() {},
      getSectionOrder() {
        return 1
      },
    },
    agents: { get: (id) => roster.get(id), list: () => [...roster.values()] },
    workingDirectory: { ensure: async () => '/repo' },
    sessions: { flush: async () => true },
    sessionQuery: {
      readSession: async (id) => {
        if (!logs.has(id)) throw Error('missing')
        return logs.get(id)
      },
    },
    subagents: {},
    logger: { warn() {} },
    get: () => undefined,
    on: (name, fn) => events.set(name, fn),
    effect: (start) => {
      cleanup = start()
    },
  }
  const checks = { lint: [['node', '--check', 'index.js']] }
  apply(ctx, { checks, maxWorkers: 3, checkTimeoutMs: 500, ...extra })
  const invoke = (key, args, agent = root) =>
    tools.get(key).execute(args, { agent, signal: new AbortController().signal })
  return {
    ctx,
    root,
    child,
    api,
    roster,
    logs,
    events,
    calls,
    tools,
    checks,
    invoke,
    controller,
    close: () => cleanup(),
  }
}

test('six captain tools bind identity and trusted checks, existing and new root sessions auto-attach', async () => {
  const h = harness()
  await afterPublication()
  assert.deepEqual(h.calls, [['attach', { cwd: '/repo', parentId: 'root' }]])
  assert.deepEqual(
    [...h.tools.keys()],
    ['dag_run', 'dag_status', 'dag_pause', 'dag_resume', 'dag_retry', 'dag_cancel'],
  )
  await h.invoke('dag_run', {
    manifest: '{"specId":"x"}',
    runId: 'r',
    checks: { bad: ['sh'] },
    maxWorkers: 999,
  })
  assert.deepEqual(h.calls.at(-1)[1], {
    cwd: '/repo',
    parentId: 'root',
    runId: 'r',
    manifest: { specId: 'x' },
  })
  assert.deepEqual(h.api.checks, h.checks)
  assert.equal(h.api.maxWorkers, 3)
  await assert.rejects(h.invoke('dag_pause', { runId: 'r' }, h.child), /top-level/)
  await assert.rejects(h.invoke('dag_run', { manifest: {} }, { ...h.root }), /top-level/)
  await h.invoke('dag_retry', { runId: 'r', id: 'A', parentId: 'forged', cwd: '/etc' })
  assert.deepEqual(h.calls.at(-1)[1], { cwd: '/repo', parentId: 'root', runId: 'r', id: 'A' })
  await h.invoke('dag_retry', { runId: 'r', id: 'A', isolated: true })
  assert.equal(h.calls.at(-1)[1].isolated, true)
  await h.close()
})

test('local child launch uses a worktree and caller-delivered completion, drains the exact handle', async () => {
  const h = harness(),
    signal = new AbortController().signal
  let received,
    closeCount = 0,
    settle
  h.ctx.subagents.startActivation = async (spec) => {
    received = spec
    return {
      childId: 'task-1',
      result: new Promise((r) => {
        settle = r
      }),
      dispose: async () => {
        closeCount++
      },
    }
  }
  const request = {
    parentId: 'root',
    childId: 'task-1',
    cwd: '/repo-wt',
    prompt: 'Implement A',
    signal,
    runId: 'r',
    ticketId: 'A',
    attempt: 1,
  }
  const activation = await h.api.launch(request)
  assert.equal(received.request.parent, h.root)
  assert.deepEqual(received.request.prompt, [{ type: 'text', text: request.prompt }])
  assert.equal(received.request.cwd, request.cwd)
  assert.equal(received.childId, 'task-1')
  assert.equal(received.delivery, 'caller')
  assert.equal(received.provider, 'spawn')
  assert.equal(received.signal, signal)
  await Promise.all([activation.dispose(), activation.dispose()])
  assert.equal(closeCount, 1)
  settle({ stopReason: 'error', diagnostic: 'network', output: [{ type: 'text', text: 'Looks done' }] })
  assert.deepEqual(await activation.result, { ok: false, detail: 'error — network' })
  const full = Object.assign(new Error('full'), { code: 'ACTIVATION_LIMIT_REACHED' })
  h.ctx.subagents.startActivation = async () => {
    throw full
  }
  await assert.rejects(h.api.launch(request), (error) => error === full)
  await assert.rejects(h.api.launch({ ...request, cwd: 'relative' }), /absolute/)
  await h.close()
})

test('built-in agent presets are the default; profile presets replace them; a preset model reaches the child', async () => {
  assert.deepEqual(Object.keys(harness().api.agents), ['implementer', 'test-writer', 'docs'])
  const agents = { reviewer: { instructions: 'Review only.', model: 'fast-1', provider: 'acme' } }
  const h = harness({ agents })
  assert.deepEqual(h.api.agents, agents)
  const received = []
  h.ctx.subagents.startActivation = async (spec) => {
    received.push(spec.request)
    return { childId: spec.childId, result: new Promise(() => {}), dispose: async () => {} }
  }
  const request = {
    parentId: 'root',
    cwd: '/repo-wt',
    prompt: 'x',
    signal: new AbortController().signal,
    runId: 'r',
    ticketId: 'A',
    attempt: 1,
  }
  await h.api.launch({ ...request, childId: 'c1', agentOptions: { provider: 'acme', model: 'fast-1' } })
  await h.api.launch({ ...request, childId: 'c2' })
  assert.deepEqual(received[0].agentOptions, { provider: 'acme', model: 'fast-1' })
  assert.equal(Object.hasOwn(received[1], 'agentOptions'), false)
  await h.close()
})

test('notification dedup survives missed flush receipt and only acknowledges a durable inbox', async () => {
  const h = harness()
  const event = { parentId: 'root', eventId: 'r.complete', text: 'Ready' }
  h.ctx.sessions.flush = async () => false
  assert.equal(await h.api.notify(event), false)
  h.ctx.sessions.flush = async () => true
  assert.deepEqual(await Promise.all([h.api.notify(event), h.api.notify(event)]), [true, true])
  assert.equal(h.logs.get('root').events.length, 1)
  assert.equal(h.logs.get('root').events[0].data.inserted[0].source.eventId, 'r.complete')
  h.roster.delete('root')
  assert.equal(await h.api.notify({ ...event, eventId: 'r.followup' }), false)
  h.ctx.get = () => ({
    resolveAgent: async () => {
      h.roster.set('root', h.root)
      return { agent: h.root }
    },
  })
  assert.equal(await h.api.notify({ ...event, eventId: 'r.followup' }), true)
  await h.close()
})

test('unknown owners, live workers, incomplete turns, and wrong session lineage prevent retry', async () => {
  const h = harness(),
    attempt = { parentId: 'root', childId: 'child' }
  assert.equal(await h.api.canRetry(attempt), false)
  h.roster.delete('child')
  const events = h.logs.get('child').events
  events.push({ type: 'turn/start', data: {} })
  assert.equal(await h.api.canRetry(attempt), false)
  events.push({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
  assert.equal(await h.api.canRetry(attempt), true)
  assert.equal(await h.api.canRetry({ ...attempt, parentId: 'elsewhere' }), false)
  events.push({ type: 'agent/inbox/spliced', data: { inserted: [{ id: 'later-message' }] } })
  assert.equal(await h.api.canRetry(attempt), false)
  assert.equal(await h.api.canRetry({ ...attempt, childId: 'unknown' }), false)
  await h.close()
})

test('DSH step and tool guards fence the retired child even after cd, ordinary DSH children stay available', async () => {
  const h = harness()
  const own = h.logs.get('child').events
  own.push(
    { type: 'subagent/descriptor', data: { label: 'dsh-ticket-dag/r/A#1' } },
    { type: 'working-directory/change', data: { cwd: '/original-attempt' } },
    { type: 'working-directory/change', data: { cwd: '/unrelated-later-cwd' } },
  )
  let decision = 'authorized',
    count = 0
  h.controller.childAuthorization = async ({ parentId, childId, cwd }) => {
    assert.deepEqual([parentId, childId, cwd], ['root', 'child', '/original-attempt'])
    return decision
  }
  const step = () =>
    h.events.get('agent/pre-step')({ agent: h.child }, () => {
      count++
      return { kind: 'enter' }
    })
  const tool = () =>
    h.events.get('tools/pre-execute')({ agent: h.child }, () => {
      count++
      return { kind: 'allow' }
    })
  assert.equal((await step()).kind, 'enter')
  decision = 'retired'
  assert.equal((await tool()).kind, 'deny')
  assert.equal((await step()).kind, 'reject')
  assert.match(h.events.get('guard')({ agent: h.child }), /no longer owns/)
  assert.equal(count, 1)
  const plain = { ...h.child, id: 'plain' }
  h.logs.set('plain', {
    inheritedEventCount: 0,
    events: [{ type: 'subagent/descriptor', data: { label: 'normal child' } }],
  })
  assert.equal(await h.events.get('agent/pre-step')({ agent: plain }, () => true), true)
  await h.close()
})
