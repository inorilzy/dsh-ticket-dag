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

function harness(extra = {}, { commands, importer } = {}) {
  const calls = [],
    roster = new Map(),
    logs = new Map(),
    tools = new Map(),
    events = new Map(),
    sections = []
  let cleanup, api
  const controller = {}
  for (const action of ['start', 'attach', 'status', 'pause', 'resume', 'retry', 'cancel', 'cleanup', 'add', 'close']) {
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
      section(section) {
        sections.push(section)
      },
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
    // Only the commands service is offered; the Web and settings mounts stay out of these tests.
    ...(commands && {
      inject: (names, fn) => {
        if (names[0] !== 'commands') return
        fn({ effect: (start) => start(), commands: { register: (c) => (commands.push(c), () => {}) } })
      },
    }),
  }
  const checks = { lint: [['node', '--check', 'index.js']] }
  apply(ctx, { checks, maxWorkers: 3, checkTimeoutMs: 500, ...extra }, importer ? { importer } : undefined)
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
    sections,
    checks,
    invoke,
    controller,
    close: () => cleanup(),
  }
}

test('nine captain tools bind identity and trusted checks, existing and new root sessions auto-attach', async () => {
  const h = harness()
  await afterPublication()
  assert.deepEqual(h.calls, [['attach', { cwd: '/repo', parentId: 'root' }]])
  assert.deepEqual(
    [...h.tools.keys()],
    ['dag_run', 'dag_status', 'dag_pause', 'dag_resume', 'dag_retry', 'dag_cancel', 'dag_cleanup', 'dag_add', 'dag_import'],
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

test('a recovery scan logs each failed run by its runId', async () => {
  const h = harness()
  const warnings = []
  h.ctx.logger.warn = (line) => warnings.push(line)
  h.controller.attach = async () => ({
    attached: ['good'],
    failures: [
      { runId: 'locked', error: 'Another DSH coordinator owns this run: x' },
      { runId: 'corrupt', error: 'Cannot read the run ledger x: file is not a database' },
    ],
  })
  await afterPublication()
  await afterPublication()
  assert.deepEqual(warnings, [
    'DAG recovery scan, run locked: Another DSH coordinator owns this run: x',
    'DAG recovery scan, run corrupt: Cannot read the run ledger x: file is not a database',
  ])
  await h.close()
})

test('a recovery scan reports each failed run to the captain, not only the host log', async () => {
  const h = harness()
  h.controller.attach = async () => ({
    attached: [],
    failures: [
      { runId: 'locked', error: 'Another DSH coordinator owns this run: x', file: '/repo/runs/locked/state.sqlite' },
      {
        runId: 'corrupt',
        error: 'Cannot read the run ledger x: file is not a database',
        file: '/repo/runs/corrupt/state.sqlite',
      },
    ],
  })
  await afterPublication()
  await afterPublication()
  await afterPublication()
  const inbox = h.logs
    .get('root')
    .events.filter((event) => event.type === 'agent/inbox/spliced')
    .map((event) => event.data.inserted[0])
  const byId = new Map(inbox.map((message) => [message.source.eventId, message]))
  assert.deepEqual([...byId.keys()].sort(), ['recovery-failed:corrupt', 'recovery-failed:locked'])
  assert.match(byId.get('recovery-failed:locked').content[0].text, /恢复失败：Another DSH coordinator owns this run/)
  assert.match(byId.get('recovery-failed:corrupt').content[0].text, /Cannot read the run ledger/)
  await h.close()
})

test('dag_cleanup is a captain-only run tool and autoCleanup defaults on', async () => {
  const h = harness()
  assert.deepEqual(h.tools.get('dag_cleanup').parameters, { runId: h.tools.get('dag_status').parameters.runId })
  assert.equal(h.api.autoCleanup, true)
  assert.equal(harness({ autoCleanup: false }).api.autoCleanup, false)
  await h.invoke('dag_cleanup', { runId: 'old-run', cwd: '/etc' })
  assert.deepEqual(h.calls.at(-1), ['cleanup', { cwd: '/repo', parentId: 'root', runId: 'old-run' }])
  const before = h.calls.length
  await assert.rejects(h.invoke('dag_cleanup', { runId: 'old-run' }, h.child), /top-level/)
  assert.equal(h.calls.length, before)
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
  assert.deepEqual(Object.keys(harness().api.agents), ['implementer', 'test-writer', 'docs', 'frontend', 'verifier', 'merger'])
  assert.equal(harness().api.requireApproval, true, 'runs wait for the user by default')
  assert.equal(harness({ requireApproval: false }).api.requireApproval, false)
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

test('dag_add is a captain-only tool that appends tickets; its cap defaults to 20 and the captain is told about it', async () => {
  const h = harness()
  assert.equal(h.api.maxAppendedTickets, 20)
  assert.equal(harness({ maxAppendedTickets: 5 }).api.maxAppendedTickets, 5)
  const tool = h.tools.get('dag_add')
  assert.deepEqual(Object.keys(tool.parameters), ['runId', 'tickets'])
  assert.equal(tool.parameters.runId.required, true)
  assert.equal(tool.parameters.tickets.required, true)
  assert.match(tool.description, /approval/)
  await h.invoke('dag_add', { runId: 'r', tickets: '[{"id":"X"}]', cwd: '/etc', parentId: 'forged' })
  assert.deepEqual(h.calls.at(-1), ['add', { cwd: '/repo', parentId: 'root', runId: 'r', tickets: [{ id: 'X' }] }])
  await h.invoke('dag_add', { runId: 'r', tickets: [{ id: 'Y' }] })
  assert.deepEqual(h.calls.at(-1)[1].tickets, [{ id: 'Y' }])
  const before = h.calls.length
  await assert.rejects(h.invoke('dag_add', { runId: 'r', tickets: [] }, h.child), /top-level/)
  assert.equal(h.calls.length, before)
  assert.match(h.tools.get('dag_run').description, /dag_add/)
  assert.match(h.sections.map((s) => (typeof s.text === 'function' ? s.text() : s.text)).join('\n'), /dag_add.*approval/)
  await h.close()
})

test('dag_import is captain-only, reads in the captain cwd, and the captain is told to keep declared edges', async () => {
  const seen = []
  const h = harness({}, { importer: async (q) => (seen.push(q), { dependencyMode: 'declared', manifest: { tickets: [] } }) })
  const tool = h.tools.get('dag_import')
  assert.deepEqual(Object.keys(tool.parameters), ['spec', 'repo'])
  assert.equal(tool.parameters.spec.required, true)
  const out = await h.invoke('dag_import', { spec: '#1', repo: 'o/r', cwd: '/etc' })
  assert.equal(out.dependencyMode, 'declared')
  assert.deepEqual(seen, [{ cwd: '/repo', spec: '#1', repo: 'o/r' }])
  await assert.rejects(h.invoke('dag_import', { spec: '#1' }, h.child), /top-level/)
  assert.equal(seen.length, 1)
  const text = h.sections.find((s) => s.name === 'tool:dsh-ticket-dag').text()
  assert.match(text, /dag_import/)
  assert.match(text, /declared, keep every ticket and its depends_on exactly/)
  assert.match(text, /does not report back to GitHub/)
  const on = harness({ trackerWriteback: 'close' }).sections.find((s) => s.name === 'tool:dsh-ticket-dag').text()
  assert.match(on, /reports each integrated GitHub ticket on its issue \(close\)/)
  assert.doesNotMatch(text, /reviews each run once/)
  const review = harness({ reviewOnComplete: true })
  assert.equal(review.api.reviewOnComplete, true)
  assert.match(review.sections.find((s) => s.name === 'tool:dsh-ticket-dag').text(), /reviews each run once.*code-review/)
  await h.close()
})

test('A+F is the default: end mode with file selection, and the captain is told to write check_meta', async () => {
  const h = harness()
  assert.equal(h.api.integrationMode, 'end')
  assert.equal(h.api.selectChecksByFiles, true)
  const text = h.sections.find((s) => s.name === 'tool:dsh-ticket-dag').text()
  assert.match(text, /Integration mode: end, with checks selected by changed files/)
  assert.match(text, /every check when none is marked fast/)
  assert.match(text, /"check_meta": \{"<id>": \{"files": \["<glob>", \.\.\.\], "fast": true\|false\}\}/)
  assert.match(text, /Tell the user which checks you marked fast/)
  await h.close()
  // A profile that set each and off explicitly keeps the old behavior and prompt.
  const each = harness({ integrationMode: 'each', selectChecksByFiles: false })
  assert.equal(each.api.integrationMode, 'each')
  assert.equal(each.api.selectChecksByFiles, false)
  assert.doesNotMatch(each.sections.find((s) => s.name === 'tool:dsh-ticket-dag').text(), /Integration mode|check_meta/)
  await each.close()
})

test('the captain section states the check timeout, the worker cap, preset choice and how conflicts are handled', async () => {
  const h = harness({ checkTimeoutMs: 600000, maxWorkers: 16 })
  const text = h.sections.find((s) => s.name === 'tool:dsh-ticket-dag').text()
  assert.match(text, /600 seconds before it times out/)
  assert.match(text, /Set max_workers explicitly \(this profile allows at most 16\) and tell the user/)
  assert.match(text, /preset that matches its kind of work/)
  assert.match(text, /conflict is sent back to the ticket worker automatically/)
  assert.match(text, /dag_retry, which submits that commit without starting a new worker/)
  await h.close()
})

test('the captain section says when to use the plugin, names Agent Teams, lists the trusted checks and the /dag command', async () => {
  const h = harness({ checks: { lint: [['node', '--check', 'index.js']], 'unit-tests': [['npm', 'test']] } })
  const section = h.sections.find((s) => s.name === 'tool:dsh-ticket-dag')
  const text = typeof section.text === 'function' ? section.text() : section.text
  assert.match(text, /Agent Teams/i, 'the plugin answers to Agent Teams requests')
  assert.match(text, /two or more tickets/i, 'used only when the work splits into 2+ tickets')
  assert.match(text, /explicitly/i)
  assert.match(text, /\/dag/)
  assert.match(text, /contains "Agent Teams".*always activates/i, 'the keyword is a forced trigger')
  assert.match(text, /lint.*unit-tests|unit-tests.*lint/s, 'the configured check IDs are listed by name')
  assert.match(text, /verification is optional/i, 'verify may be left empty')
  assert.match(text, /"checks"/, 'the captain may write its own checks into the manifest')
  assert.match(text, /approves these commands/i, 'and the user approves them')
  // The live settings are read each time, so a newly saved check shows up.
  const none = harness({ checks: {} }).sections.find((s) => s.name === 'tool:dsh-ticket-dag')
  const noneText = typeof none.text === 'function' ? none.text() : none.text
  assert.match(noneText, /no checks configured/i)
  assert.doesNotMatch(noneText, /stop and ask the user/i, 'an empty profile no longer blocks the captain')
  await h.close()
})

test('the /dag slash command is registered and replays the goal as a user message', async () => {
  const commands = []
  const h = harness({}, { commands })
  assert.equal(commands.length, 1)
  const cmd = commands[0]
  assert.equal(cmd.name, 'dag')
  assert.match(cmd.description, /Agent Teams/)
  const sent = []
  const agent = { followup: (m) => sent.push(m) }
  assert.equal(cmd.handler({ rawInput: '   ', agent }).kind, 'error')
  assert.equal(sent.length, 0)
  assert.equal(cmd.handler({ rawInput: ' 重构登录模块', agent }).kind, 'success')
  assert.equal(sent[0].content[0].text, '/dag 重构登录模块')
  assert.equal(sent[0].source.kind, 'user')
  await h.close()
})

test('a user message starting with /dag adds a captain directive with the goal; other messages and workers are untouched', async () => {
  const h = harness()
  const step = h.events.get('agent/pre-step')
  const user = (text) => ({ id: 'u', source: { kind: 'user' }, content: [{ type: 'text', text }] })
  const enter = { kind: 'enter', messages: [] }
  const run = (messages, agent = h.root) => step({ agent, messages, signal: new AbortController().signal }, async () => enter)

  const decision = await run([user('/dag 给登录页加记住我，并补测试和文档')])
  assert.equal(decision.kind, 'enter')
  const directive = decision.messages.at(-1)
  assert.equal(directive.source.kind, 'dsh-ticket-dag-command')
  const said = directive.content[0].text
  assert.match(said, /dag_run/)
  assert.match(said, /Goal: 给登录页加记住我，并补测试和文档/)
  assert.match(said, /lint/, 'the directive names the usable check IDs')

  const empty = await run([user('/dag')])
  assert.match(empty.messages.at(-1).content[0].text, /ask the user/i)
  // A command name that only starts with dag, prose and older messages do not trigger it.
  for (const text of ['/dagger now', '请用 /dag 吗', '我们团队讨论一下']) assert.equal(await run([user(text)]), enter, text)
  assert.equal(await run([user('/dag A'), { id: 'a', source: { kind: 'assistant' }, content: [] }, user('继续')]), enter)
  // Workers never receive the captain directive.
  assert.notEqual((await run([user('/dag X')], h.child)).messages?.at(-1)?.source?.kind, 'dsh-ticket-dag-command')
  await h.close()
})

test('a user message containing Agent Teams anywhere adds the captain directive with the whole message as the goal', async () => {
  const h = harness()
  const step = h.events.get('agent/pre-step')
  const user = (text) => ({ id: 'u', source: { kind: 'user' }, content: [{ type: 'text', text }] })
  const enter = { kind: 'enter', messages: [] }
  const run = (messages, agent = h.root) => step({ agent, messages, signal: new AbortController().signal }, async () => enter)

  for (const text of ['帮我用 Agent Teams 重构登录模块', 'agent teams：补测试', '组建一个 agent team 做这个', '用AgentTeams做', 'use agent-teams here']) {
    const directive = (await run([user(text)])).messages.at(-1)
    assert.equal(directive?.source?.kind, 'dsh-ticket-dag-command', text)
    assert.match(directive.content[0].text, /Agent Teams keyword/, text)
    assert.ok(directive.content[0].text.includes('Goal: ' + text), text)
  }
  // Other words that only contain the letters, and other team words, are left to the model.
  for (const text of ['subagent team', 'agentteamsx', '组建团队', 'ticket DAG 跑一下']) assert.equal(await run([user(text)]), enter, text)
  // /dag wins over the keyword, so one message adds exactly one directive.
  const both = await run([user('/dag 用 Agent Teams 做 X')])
  assert.equal(both.messages.length, 1)
  assert.match(both.messages[0].content[0].text, /\/dag command[\s\S]*Goal: 用 Agent Teams 做 X/)
  // Only the latest user message counts, and workers never receive the directive.
  assert.equal(await run([user('Agent Teams A'), { id: 'a', source: { kind: 'assistant' }, content: [] }, user('继续')]), enter)
  assert.notEqual((await run([user('Agent Teams X')], h.child)).messages?.at(-1)?.source?.kind, 'dsh-ticket-dag-command')
  await h.close()
})