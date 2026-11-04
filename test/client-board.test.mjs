import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'
import vm from 'node:vm'

// Renders the browser entry without DSH or a DOM: a stand-in React builds a
// plain element tree, and the first useState calls receive seeded values.
function loadSlots(seeds) {
  let definition
  const source = readFileSync(resolve(import.meta.dirname, '..', 'src', 'client.js'), 'utf8')
  vm.runInNewContext(source, { window: { __ModuleLoader__: { load: (d) => (definition = d) } } })
  const queue = [...seeds]
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
    useState: (init) => [queue.length ? queue.shift() : typeof init === 'function' ? init() : init, () => {}],
    useRef: (current) => ({ current }),
    useEffect: () => {},
  }
  const slots = {}
  definition.factory(() => react).apply({
    effect: (fn) => fn(),
    slots: { inject: (_, fn) => fn(), register: (meta, component) => (slots[meta.name] = component) },
  })
  return slots
}
const loadBoard = (seeds) => loadHost(seeds).slots['sidebar.right.pane.tab'].component

// Loads the entry with the conversation right-sidebar and settings services
// present. Effects run immediately and fetch only records the URL it was asked for.
function loadHost(seeds, { expanded = false, config = { status: 'loading' } } = {}) {
  let definition
  const source = readFileSync(resolve(import.meta.dirname, '..', 'src', 'client.js'), 'utf8')
  const urls = []
  const posts = []
  const postHeaders = []
  vm.runInNewContext(source, {
    window: { __ModuleLoader__: { load: (d) => (definition = d) } },
    fetch: (url, init) => {
      urls.push(url)
      if (init?.method === 'POST') {
        posts.push([url, JSON.parse(init.body)])
        postHeaders.push(init.headers)
      }
      return new Promise(() => {})
    },
    setTimeout: () => 0,
    clearTimeout: () => {},
    AbortController,
    URLSearchParams,
    structuredClone,
  })
  const queue = [...seeds]
  // Every state update is recorded so a test can inspect what an interaction would set.
  const sets = []
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
    useState: (init) => [
      queue.length ? queue.shift() : typeof init === 'function' ? init() : init,
      (value) => sets.push(value),
    ],
    useRef: (current) => ({ current }),
    useEffect: (fn) => void fn(),
  }
  const host = { tabs: [], opened: [], slots: {}, urls, posts, postHeaders, sets, injected: [], namespaces: [], saved: [], sessions: [] }
  const slots = {
    inject: (_, fn) => fn(),
    register: (meta, component) => (host.slots[meta.name] = { meta, component }),
  }
  definition.factory(() => react).apply({
    effect: (fn) => fn(),
    slots,
    inject(names, fn) {
      host.injected.push(names)
      fn({
        effect: (f) => f(),
        slots,
        sidebarRightTabs: { register: (definition) => (host.tabs.push(definition), () => {}) },
        sidebarRight: {
          openTab: (kind) => host.opened.push(kind),
          openResource: (address, options) => host.opened.push([address, options?.kind]),
          isExpanded: () => expanded,
        },
        sessions: {
          refreshSubagents: async (parent) => host.sessions.push(['refresh', parent]),
          subagentAddress: () => undefined,
          openSubagent: (address) => host.sessions.push(['open', { ...address }]),
        },
        get: () => undefined,
        configForms: {
          get: (ns) => (
            host.namespaces.push(ns),
            {
              getSnapshot: () => config,
              subscribe: () => () => {},
              mutate: async (ops, revision) => (host.saved.push([ops, revision]), true),
            }
          ),
        },
      })
    },
  })
  host.renderSlot = (name, props) => {
    const { meta, component } = host.slots[name]
    return render({ type: component, props: { ...props, ...meta.inject?.(props.sessionId) }, children: [] })
  }
  return host
}

// Editor state order: edit draft, notice, busy, model catalog, expanded preset rows.
// By default every preset row is seeded open so its fields can be inspected.
function editorFor(value, catalog, open = new Set([0, 1, 2, 3, 4, 5])) {
  const Panel = loadSlots([null, null, false, catalog, open])['plugins.row.config']
  const form = { state: { status: 'ready', value, writable: true, revision: 1 }, mutate: async () => true }
  return render({ type: Panel, props: { view: 'detail', form }, children: [] })
}

function render(node) {
  if (Array.isArray(node)) return node.map(render).filter((n) => n !== null)
  if (node === null || node === undefined || node === false || node === true) return null
  if (typeof node !== 'object') return String(node)
  if (typeof node.type === 'function') return render(node.type({ ...node.props, children: node.children }))
  return { type: node.type, props: node.props, children: render(node.children) }
}

const text = (node) =>
  typeof node === 'string' ? node : node.type === 'style' ? '' : node.children.map(text).join('')
function findAll(node, match, out = []) {
  if (typeof node === 'string') return out
  if (match(node)) out.push(node)
  for (const child of node.children) findAll(child, match, out)
  return out
}
const find = (node, match) => findAll(node, match)[0]

function boardFor(tickets) {
  const counts = {}
  for (const t of tickets) counts[t.status] = (counts[t.status] ?? 0) + 1
  const selected = {
    key: 'k'.repeat(64),
    runId: 'hello-01',
    repoName: 'playground',
    specId: 'hello',
    integrationRef: 'refs/heads/integration/hello-01',
    mode: 'active',
    complete: false,
    total: tickets.length,
    counts,
    tickets: tickets.map((t) => ({ dependsOn: [], attempt: 0, ...t })),
  }
  const Dashboard = loadBoard([{ runs: [selected], selected }, selected.key])
  return render({ type: Dashboard, props: {}, children: [] })
}

const sample = [
  { id: 'A', title: 'Greeting', status: 'INTEGRATED', attempt: 1 },
  { id: 'C', title: 'Normalize', status: 'RUNNING', attempt: 1, livePhase: { stage: 'agent' } },
  { id: 'B', title: 'Welcome', status: 'PENDING', dependsOn: ['A', 'C'] },
]

test('board keeps the ticket rows and the integrated progress value', () => {
  const root = boardFor(sample)
  const row = (id) => find(root, (n) => n.props['data-dag-ticket'] === id)
  assert.match(text(row('A')), /已集成/)
  assert.match(text(row('C')), /执行中/)
  assert.match(text(row('B')), /等待依赖/)
  const progress = find(root, (n) => n.type === 'progress')
  assert.equal(progress.props['aria-label'], '已集成工单')
  assert.equal(progress.props.value, 1)
  assert.equal(progress.props.max, 3)
})

test('overall progress shows one segment and one legend entry per state group', () => {
  const root = boardFor(sample)
  const bar = find(root, (n) => n.props['data-dag-bar'] !== undefined)
  const segments = findAll(bar, (n) => n.props['data-dag-segment'] !== undefined)
  assert.deepEqual(
    segments.map((s) => [s.props['data-dag-segment'], s.props.style.flexGrow]),
    [
      ['work', 1],
      ['wait', 1],
      ['done', 1],
    ],
  )
  const legend = text(find(root, (n) => n.props['data-dag-legend'] !== undefined))
  for (const part of ['进行中 1', '等待 1', '需要处理 0', '已集成 1']) assert.ok(legend.includes(part), legend)
})

test('dependency map lays tickets out left to right by depth with one edge per dependency', () => {
  const root = boardFor(sample)
  const map = find(root, (n) => n.props['data-dag-map'] !== undefined)
  const nodes = Object.fromEntries(
    findAll(map, (n) => n.props['data-dag-node'] !== undefined).map((n) => [n.props['data-dag-node'], n]),
  )
  assert.deepEqual(Object.keys(nodes).sort(), ['A', 'B', 'C'])
  assert.equal(nodes.A.props.style.left, nodes.C.props.style.left)
  assert.ok(nodes.B.props.style.left > nodes.A.props.style.left)
  assert.notEqual(nodes.A.props.style.top, nodes.C.props.style.top)
  assert.equal(nodes.A.props['data-tone'], 'done')
  assert.equal(nodes.C.props['data-tone'], 'work')
  assert.equal(nodes.B.props['data-tone'], 'wait')
  assert.equal(findAll(map, (n) => n.props['data-dag-edge'] !== undefined).length, 2)
})

test('ticket detail defaults to the most urgent ticket and names its neighbours', () => {
  const running = text(find(boardFor(sample), (n) => n.props['data-dag-detail'] !== undefined))
  assert.match(running, /C/)
  assert.match(running, /解锁 B/)

  const blocked = boardFor([
    ...sample.slice(0, 2),
    { id: 'B', title: 'Welcome', status: 'NEEDS_ATTENTION', dependsOn: ['A', 'C'], message: 'verify failed' },
  ])
  const detail = find(blocked, (n) => n.props['data-dag-detail'] !== undefined)
  assert.equal(detail.props['data-dag-detail'], 'B')
  assert.match(text(detail), /上游 A、C/)
  assert.match(text(detail), /无下游工单/)
  assert.match(text(blocked), /1 张工单需要处理/)
})

test('focusing a ticket highlights its whole upstream and downstream chain and dims the rest', () => {
  const root = boardFor([
    { id: 'A', status: 'INTEGRATED' },
    { id: 'B', status: 'RUNNING', dependsOn: ['A'], livePhase: { stage: 'agent' } },
    { id: 'C', status: 'PENDING', dependsOn: ['B'] },
    { id: 'X', status: 'PENDING' },
  ])
  const map = find(root, (n) => n.props['data-dag-map'] !== undefined)
  const dim = Object.fromEntries(
    findAll(map, (n) => n.props['data-dag-node'] !== undefined).map((n) => [n.props['data-dag-node'], n.props['data-dim']]),
  )
  assert.deepEqual(dim, { A: false, B: false, C: false, X: true })
  const active = findAll(map, (n) => n.props['data-dag-edge'] !== undefined).map((p) => p.props['data-active'])
  assert.deepEqual(active, [true, true])
})

test('ticket detail shows a stage stepper and node tooltips name the live stage', () => {
  const root = boardFor([
    { id: 'A', title: 'Greeting', status: 'RUNNING', livePhase: { stage: 'merge' } },
    { id: 'B', status: 'INTEGRATED' },
  ])
  const steps = findAll(
    find(root, (n) => n.props['data-dag-detail'] === 'A'),
    (n) => n.props['data-dag-step'] !== undefined,
  )
  assert.deepEqual(
    steps.map((s) => [s.props['data-dag-step'], s.props['data-state']]),
    [
      ['worktree', 'done'],
      ['launch', 'done'],
      ['agent', 'done'],
      ['receipt', 'done'],
      ['merge', 'current'],
      ['verify', 'todo'],
      ['publish', 'todo'],
    ],
  )
  const node = find(root, (n) => n.props['data-dag-node'] === 'A')
  assert.equal(node.props.title, 'A · Greeting · 执行中 · 候选工作树试合并')
})

test('integrated and waiting tickets show a fully done or untouched stepper', () => {
  const states = (status) => {
    const root = boardFor([{ id: 'A', status, dependsOn: [] }])
    return findAll(root, (n) => n.props['data-dag-step'] !== undefined).map((s) => s.props['data-state'])
  }
  assert.deepEqual(states('INTEGRATED'), Array(7).fill('done'))
  assert.deepEqual(states('PENDING'), Array(7).fill('todo'))
})

test('nodes and the detail card name the ticket member and its model', () => {
  const root = boardFor([
    { id: 'A', title: 'Docs', status: 'RUNNING', agent: 'docs', model: 'acme/fast-1', livePhase: { stage: 'agent' } },
    { id: 'B', status: 'PENDING', dependsOn: ['A'] },
  ])
  const node = find(root, (n) => n.props['data-dag-node'] === 'A')
  assert.match(text(node), /文档员/)
  assert.match(node.props.title, /文档员 \/ acme\/fast-1/)
  assert.match(text(find(root, (n) => n.props['data-dag-detail'] === 'A')), /文档员 · acme\/fast-1/)
  assert.doesNotMatch(text(find(root, (n) => n.props['data-dag-node'] === 'B')), /默认/)
})

test('the progress board names members everywhere instead of preset IDs, in review-style blocks', () => {
  const selected = {
    key: 'k'.repeat(64),
    runId: 'named',
    parentId: 'session-captain',
    mode: 'active',
    attached: true,
    total: 3,
    counts: { RUNNING: 1, PENDING: 2 },
    captain: { provider: 'magpie', model: 'auto/claude-opus-5-5' },
    presets: [
      { id: 'implementer', name: '' },
      { id: 'test-writer', name: '写测试的' },
    ],
    tickets: [
      { id: 'A', title: '定义接口', status: 'RUNNING', dependsOn: [], attempt: 1, agent: 'implementer', livePhase: { stage: 'agent' } },
      { id: 'T', title: '编写测试', status: 'PENDING', dependsOn: ['A'], attempt: 0, agent: 'test-writer' },
      { id: 'B', title: '接入客户端', status: 'PENDING', dependsOn: ['A'], attempt: 0, agent: null },
    ],
  }
  const pane = loadHost([{ runs: [selected], selected }, selected.key]).renderSlot('sidebar.right.pane.tab', {
    sessionId: 'session-captain',
  })
  assert.doesNotMatch(text(pane), /implementer|test-writer|Agent：/, 'no preset ID is shown')
  const row = (id) => text(find(pane, (n) => n.props['data-dag-ticket'] === id))
  assert.match(row('A'), /实现者/, 'a preset without a display name falls back to the built-in name')
  assert.match(row('T'), /写测试的/)
  assert.match(row('B'), /默认成员/)
  const node = (id) => find(pane, (n) => n.props['data-dag-node'] === id)
  assert.match(text(node('A')), /A.*实现者.*定义接口/, 'a map node shows its ID, owner and task')
  assert.match(text(node('T')), /T.*写测试的.*编写测试/)
  assert.match(node('A').props.title, /实现者/)
  assert.doesNotMatch(node('A').props.title, /implementer/)
  assert.match(text(find(pane, (n) => n.props['data-dag-detail'] === 'A')), /实现者 · 宿主默认模型/)
  const colour = (id) =>
    find(node(id), (n) => n.props['data-dag-color'] !== undefined && n.props['data-dag-avatar'] === undefined)?.props[
      'data-dag-color'
    ]
  assert.ok(colour('A') && colour('T') && colour('A') !== colour('T'), 'each member has its own colour')
  const block = (label) => find(pane, (n) => n.props['aria-label'] === label)
  for (const label of ['总进度', '工单列表', '依赖图']) assert.match(block(label).props.className, /dtd-block/, label)
  assert.ok(find(block('工单列表'), (n) => n.props['aria-label'] === '筛选工单'))
})

const catalog = {
  providers: [
    {
      id: 'acme',
      name: 'Acme',
      models: [
        { id: 'fast-1', name: 'Fast 1', efforts: [], defaultEffort: null },
        { id: 'deep-2', name: 'Deep 2', efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high' },
      ],
    },
  ],
  failures: [],
}

test('config page lists agent presets with model and effort pickers from the host catalog', () => {
  const root = editorFor(
    {
      agents: {
        docs: { description: '文档', instructions: 'Docs only.', provider: 'acme', model: 'deep-2', reasoningEffort: 'high' },
        plain: { instructions: 'Anything.' },
      },
    },
    catalog,
  )
  const section = find(root, (n) => n.props['aria-label'] === '预设 Agent')
  const select = (label) => find(section, (n) => n.type === 'select' && n.props['aria-label'] === label)
  const model = select('docs 的模型')
  assert.equal(model.props.value, JSON.stringify(['acme', 'deep-2']))
  for (const label of ['宿主默认', 'Fast 1', 'Deep 2']) assert.match(text(model), new RegExp(label))
  assert.equal(find(model, (n) => n.type === 'optgroup').props.label, 'Acme')
  const effort = select('docs 的推理强度')
  assert.equal(effort.props.value, 'high')
  assert.match(text(effort), /模型默认/)
  assert.match(text(effort), /High/)
  assert.equal(select('plain 的模型').props.value, '')
  assert.equal(select('plain 的推理强度').props.disabled, true)
})

test('a saved model missing from the catalog stays selectable and is flagged', () => {
  const root = editorFor({ agents: { docs: { instructions: 'x', provider: 'gone', model: 'old-1' } } }, catalog)
  const model = find(root, (n) => n.type === 'select' && n.props['aria-label'] === 'docs 的模型')
  assert.equal(model.props.value, JSON.stringify(['gone', 'old-1']))
  assert.match(text(model), /gone\/old-1（当前目录中没有）/)
})

test('without saved presets the config page starts from the built-in presets', async () => {
  const { builtinAgents } = await import('../src/agents.mjs')
  const root = editorFor({}, { providers: [], failures: [] })
  const section = find(root, (n) => n.props['aria-label'] === '预设 Agent')
  const values = (label) =>
    findAll(section, (n) => n.props['aria-label'] === label).map((n) => n.props.value)
  assert.deepEqual(values('Agent ID'), Object.keys(builtinAgents))
  assert.deepEqual(values('显示名'), ['实现者', '测试员', '文档员'])
  assert.deepEqual(
    values('角色说明'),
    Object.values(builtinAgents).map((a) => a.instructions),
  )
})

test('each conversation gets a right-sidebar tab that reads only its own runs', () => {
  const host = loadHost([])
  assert.deepEqual(
    host.injected.map((names) => [...names]),
    [['configForms'], ['sessions'], ['sidebarRight', 'sidebarRightTabs']],
  )
  assert.deepEqual(
    host.tabs.map((t) => [t.id, t.kind, t.title()]),
    [['dsh-ticket-dag/progress', 'ticket-dag', '工单进度']],
  )
  assert.equal(host.slots['sidebar.right.pane.tab'].meta.key, 'dsh-ticket-dag/progress')
  host.renderSlot('sidebar.right.pane.tab', { sessionId: 'session-1' })
  assert.deepEqual(host.urls, ['api/ticket-dag.dashboard?parent=session-1'])

  // Each run opens as its own tab: the address names the run, the title its runId.
  const [tab] = host.tabs
  const key = 'a'.repeat(64)
  const address = 'dsh-resource://ticket-dag/' + key + '/demo-agents-02'
  assert.deepEqual([...tab.patterns], ['dsh-resource://ticket-dag/**'])
  assert.equal(tab.canOpen(address), true)
  assert.equal(tab.canOpen('dsh-resource://ticket-dag/oops'), false)
  assert.equal(tab.title(address), '工单 · demo-agents-02')
  const pinned = loadHost([])
  pinned.renderSlot('sidebar.right.pane.tab', {
    sessionId: 'session-1',
    useTabInfo: () => ({ tab: { contentId: address } }),
  })
  assert.deepEqual(pinned.urls, ['api/ticket-dag.dashboard?key=' + key + '&parent=session-1'])

  const two = [
    { key, runId: 'demo-agents-02', mode: 'active', total: 0, counts: {}, tickets: [] },
    { key: 'b'.repeat(64), runId: 'demo-agents-01', mode: 'active', total: 0, counts: {}, tickets: [] },
  ]
  const shown = loadHost([{ runs: two, selected: two[0] }, key]).renderSlot('sidebar.right.pane.tab', {
    sessionId: 'session-1',
    useTabInfo: () => ({ tab: { contentId: address } }),
  })
  assert.equal(find(shown, (n) => n.props['aria-label'] === '选择运行'), undefined, 'a tab shows one run, no picker')

  const empty = loadHost([{ runs: [], selected: null }, ''])
  const pane = empty.renderSlot('sidebar.right.pane.tab', { sessionId: 'session-1' })
  assert.match(text(pane), /这个对话还没有启动工单运行/)
})

test('the sidebar board scrolls, shows the dependency map before the ticket list, and opens worker conversations', async () => {
  const selected = {
    key: 'k'.repeat(64),
    runId: 'demo',
    parentId: 'session-captain',
    mode: 'active',
    total: 2,
    counts: { RUNNING: 1, PENDING: 1 },
    tickets: [
      { id: 'A', title: 'A', status: 'RUNNING', dependsOn: [], attempt: 1, childId: 'child-a', livePhase: { stage: 'agent' } },
      { id: 'B', title: 'B', status: 'PENDING', dependsOn: ['A'], attempt: 0 },
    ],
  }
  const host = loadHost([{ runs: [selected], selected }, selected.key])
  const pane = host.renderSlot('sidebar.right.pane.tab', { sessionId: 'session-captain' })
  assert.equal(pane.props.style.overflowY, 'auto')
  assert.equal(pane.props.style.height, '100%')
  const order = findAll(pane, (n) => n.props['data-dag-map'] !== undefined || n.props['data-dag-ticket'] !== undefined)
  assert.ok(order[0].props['data-dag-map'] !== undefined, 'map comes first in the sidebar')

  const rowA = find(pane, (n) => n.props['data-dag-ticket'] === 'A')
  assert.equal(find(find(pane, (n) => n.props['data-dag-ticket'] === 'B'), (n) => text(n) === '查看对话'), undefined)
  await find(rowA, (n) => n.type === 'button' && text(n) === '查看对话').props.onClick()
  const detail = find(pane, (n) => n.props['data-dag-detail'] === 'A')
  assert.ok(find(detail, (n) => n.type === 'button' && text(n) === '查看对话'))
  assert.deepEqual(host.sessions, [
    ['refresh', 'session-captain'],
    ['open', { parentSessionId: 'session-captain', childSessionId: 'child-a', mode: 'continuable' }],
  ])
})

// The A/C/T/B/D plan of the review design: three named members own five tasks.
function reviewRun() {
  const presets = [
    { id: 'implementer', name: '实现者', description: '', provider: 'acme', model: 'deep-2', reasoningEffort: 'high' },
    { id: 'test-writer', name: '测试员', description: '', provider: 'acme', model: 'fast-1', reasoningEffort: '' },
    { id: 'docs', name: '文档员', description: '', provider: '', model: '', reasoningEffort: '' },
  ]
  const route = (agent) => {
    const p = presets.find((x) => x.id === agent)
    return { provider: p.provider, model: p.model, reasoningEffort: p.reasoningEffort }
  }
  return {
    key: 'k'.repeat(64),
    runId: 'plan',
    parentId: 'session-captain',
    mode: 'staged',
    attached: true,
    total: 5,
    counts: { PENDING: 5 },
    captain: { provider: 'magpie', model: 'auto/claude-opus-5-5' },
    presets,
    tickets: [
      ['A', '定义接口', [], 'implementer'],
      ['C', '实现服务', ['A'], 'implementer'],
      ['T', '编写测试', ['C'], 'test-writer'],
      ['B', '接入客户端', ['A'], 'implementer'],
      ['D', '更新文档', ['B'], 'docs'],
    ].map(([id, title, dependsOn, agent]) => ({
      id,
      title,
      status: 'PENDING',
      dependsOn,
      attempt: 0,
      agent,
      route: route(agent),
    })),
  }
}

test('plan review: named members with their tasks and model, compact task list, map and fixed actions', () => {
  const selected = reviewRun()
  const host = loadHost([{ runs: [selected], selected }, selected.key])
  const pane = host.renderSlot('sidebar.right.pane.tab', { sessionId: 'session-captain' })
  const review = find(pane, (n) => n.props['data-dag-review'] !== undefined)
  assert.match(text(review), /执行前计划审查/)
  assert.match(text(review), /待确认/)
  assert.match(text(review), /3 名成员 · 5 项任务 · 4 条依赖/)
  for (const step of ['审查计划', '确认模型', '开始执行']) assert.match(text(review), new RegExp(step))
  assert.match(text(find(review, (n) => n.props['data-dag-captain'] !== undefined)), /队长 · 当前对话.*claude-opus-5-5/)

  const members = findAll(review, (n) => n.props['data-dag-member'] !== undefined)
  assert.deepEqual(members.map((m) => m.props['data-dag-member']), ['implementer', 'test-writer', 'docs'])
  assert.match(text(members[0]), /实现者/)
  assert.match(text(members[0]), /负责 A、C、B/)
  assert.doesNotMatch(text(members[0]), /implementer/, 'members show their name, not the preset ID')
  const field = (label) => find(review, (n) => n.props['aria-label'] === label)
  assert.equal(field('实现者 的模型').props.value, JSON.stringify(['acme', 'deep-2']))
  assert.equal(field('实现者 的推理强度').props.value, 'high')
  assert.equal(field('文档员 的模型').props.value, '')
  assert.equal(field('批量修改模型'), undefined, 'the bulk picker appears only once members are checked')

  const tasks = findAll(review, (n) => n.props['data-dag-task'] !== undefined)
  assert.deepEqual(tasks.map((t) => t.props['data-dag-task']), ['A', 'C', 'T', 'B', 'D'])
  assert.match(text(tasks[0]), /定义接口.*实现者 · 可开始/)
  assert.match(text(tasks[2]), /编写测试.*测试员 · 等待 C/)
  assert.equal(field('A 的负责人'), undefined, 'task rows stay collapsed')

  const node = find(review, (n) => n.props['data-dag-node'] === 'A')
  assert.equal(text(node), 'A实现者定义接口', 'a map node shows its ID, owner and task')
  assert.equal(node.props['data-tone'], 'neutral', 'a task that can start is plain')
  assert.equal(find(review, (n) => n.props['data-dag-node'] === 'T').props['data-tone'], 'wait')
  assert.match(text(find(review, (n) => n.props['data-dag-node'] === 'T')), /T测试员编写测试/)
  assert.equal(find(review, (n) => n.props['data-dag-detail'] !== undefined), undefined)
  assert.equal(find(pane, (n) => n.props['data-dag-ticket'] !== undefined), undefined, 'no progress list yet')

  const bar = find(review, (n) => n.props['data-dag-actions'] !== undefined)
  assert.deepEqual(
    findAll(bar, (n) => n.type === 'button').map(text),
    ['确认并启动', '返回对话修改', '放弃本次计划'],
  )
  find(bar, (n) => n.type === 'button' && text(n) === '确认并启动').props.onClick()
  const impl = { agent: 'implementer', provider: 'acme', model: 'deep-2', reasoningEffort: 'high' }
  assert.deepEqual(host.posts, [
    [
      'api/ticket-dag.approve',
      {
        key: selected.key,
        action: 'approve',
        choices: [
          { id: 'A', ...impl },
          { id: 'C', ...impl },
          { id: 'T', agent: 'test-writer', provider: 'acme', model: 'fast-1', reasoningEffort: '' },
          { id: 'B', ...impl },
          { id: 'D', agent: 'docs', provider: '', model: '', reasoningEffort: '' },
        ],
      },
    ],
  ])
  assert.deepEqual(
    { ...host.postHeaders[0] },
    { 'content-type': 'application/json', 'x-dsh-ticket-dag': '1' },
    'the approval request carries the JSON type and the plugin header the host requires',
  )
})

function stagedRun(tickets) {
  return {
    key: 'k'.repeat(64),
    runId: 'plan',
    parentId: 'session-captain',
    mode: 'staged',
    attached: true,
    total: tickets.length,
    counts: { PENDING: tickets.length },
    captain: { provider: 'magpie', model: 'auto/claude-opus-5-5' },
    presets: [],
    tickets: tickets.map(([id, provider, model]) => ({
      id,
      title: id,
      status: 'PENDING',
      dependsOn: [],
      attempt: 0,
      agent: null,
      route: { provider, model, reasoningEffort: '' },
    })),
  }
}

test('built-in presets saved without a display name still show their Chinese name', () => {
  const selected = reviewRun()
  selected.presets = selected.presets.map((p) => ({ ...p, name: '' }))
  const pane = loadHost([{ runs: [selected], selected }, selected.key]).renderSlot('sidebar.right.pane.tab', {
    sessionId: 'session-captain',
  })
  const names = findAll(pane, (n) => n.props['data-dag-member'] !== undefined).map((m) => text(m))
  assert.match(names[0], /实现者/)
  assert.match(names[1], /测试员/)
  assert.match(names[2], /文档员/)
})

test('the captain avatar follows its vendor; each member has its own colour, also on its map nodes', () => {
  const selected = reviewRun()
  const host = loadHost([{ runs: [selected], selected }, selected.key])
  const pane = host.renderSlot('sidebar.right.pane.tab', { sessionId: 'session-captain' })
  const avatar = (node) => find(node, (n) => n.props['data-dag-avatar'] !== undefined).props
  assert.equal(avatar(find(pane, (n) => n.props['data-dag-captain'] !== undefined))['data-dag-avatar'], 'claude')
  const colour = (match) => avatar(find(pane, match))['data-dag-color']
  const members = ['implementer', 'test-writer', 'docs'].map((id) => colour((n) => n.props['data-dag-member'] === id))
  assert.equal(new Set(members).size, 3)
  const owner = (id) =>
    find(find(pane, (n) => n.props['data-dag-node'] === id), (n) => n.props['data-dag-color'] !== undefined).props[
      'data-dag-color'
    ]
  assert.equal(owner('C'), members[0], 'a map node names its owner in the member colour')
  assert.equal(owner('D'), members[2])
})

test('vendor recognition covers the main model families and falls back to a generic figure', () => {
  const vendorFor = (provider, model) => {
    const selected = { ...reviewRun(), captain: { provider, model } }
    const pane = loadHost([{ runs: [selected], selected }, selected.key]).renderSlot('sidebar.right.pane.tab', {
      sessionId: 'session-captain',
    })
    const captain = find(pane, (n) => n.props['data-dag-captain'] !== undefined)
    return find(captain, (n) => n.props['data-dag-avatar'] !== undefined).props['data-dag-avatar']
  }
  assert.deepEqual(
    [
      ['deepseek-official', 'deepseek-v4-pro'],
      ['xai', 'grok-4'],
      ['google', 'gemini-2.5-pro'],
      ['openai', 'gpt-5'],
      ['local', 'llama-3'],
    ].map(([p, m]) => vendorFor(p, m)),
    ['deepseek', 'grok', 'gemini', 'gpt', 'generic'],
  )
})

test('the progress board also shows the captain, and avatars on ticket rows and map nodes', () => {
  const selected = {
    ...stagedRun([]),
    mode: 'active',
    total: 2,
    counts: { RUNNING: 1, PENDING: 1 },
    tickets: [
      { id: 'A', title: 'A', status: 'RUNNING', dependsOn: [], attempt: 1, agent: 'docs', model: 'xai/grok-4', livePhase: { stage: 'agent' } },
      { id: 'B', title: 'B', status: 'PENDING', dependsOn: ['A'], attempt: 0, agent: null, model: null },
    ],
  }
  const host = loadHost([{ runs: [selected], selected }, selected.key])
  const pane = host.renderSlot('sidebar.right.pane.tab', { sessionId: 'session-captain' })
  assert.ok(find(pane, (n) => n.props['data-dag-captain'] !== undefined))
  const avatar = (node) => find(node, (n) => n.props['data-dag-avatar'] !== undefined)?.props['data-dag-avatar']
  assert.equal(avatar(find(pane, (n) => n.props['data-dag-ticket'] === 'A')), 'grok')
  assert.equal(avatar(find(pane, (n) => n.props['data-dag-ticket'] === 'B')), 'claude')
  assert.equal(avatar(find(pane, (n) => n.props['data-dag-node'] === 'A')), 'grok')
})

test('checked members get a header bulk model picker; a member row changes only itself; tasks expand to change owner', () => {
  const selected = reviewRun()
  // Dashboard: data, selectedKey, error, lastRead. PlanReview: owners, routes,
  // catalog, busy, error, confirmDiscard, checked members, expanded task.
  const seeds = [{ runs: [selected], selected }, selected.key, '', null, null, null, catalog, false, '', false]
  const host = loadHost([...seeds, new Set(['implementer', 'docs']), 'T'])
  const pane = host.renderSlot('sidebar.right.pane.tab', { sessionId: 'session-captain' })
  const field = (label) => find(pane, (n) => n.props['aria-label'] === label)
  // The update runs inside the vm realm; compare plain data.
  const nextRoutes = () => JSON.parse(JSON.stringify(host.sets.find((v) => typeof v === 'function')(null)))
  assert.equal(field('全选成员').props.type, 'checkbox')
  assert.equal(field('全选成员').props.checked, false)
  assert.equal(field('选择 实现者').props.checked, true)
  assert.equal(field('选择 测试员').props.checked, false)

  const impl = { provider: 'acme', model: 'deep-2', reasoningEffort: 'high' }
  const writer = { provider: 'acme', model: 'fast-1', reasoningEffort: '' }
  host.sets.length = 0
  field('文档员 的模型').props.onChange({ target: { value: JSON.stringify(['acme', 'deep-2']) } })
  let routes = nextRoutes()
  assert.deepEqual(routes.docs, { provider: 'acme', model: 'deep-2', reasoningEffort: '' })
  assert.deepEqual(routes.implementer, impl, 'a member row never changes another member')

  const bulk = field('批量修改模型')
  assert.equal(bulk.props.value, '__pick')
  assert.match(text(bulk), /修改模型/)
  assert.equal(field('批量修改推理强度').props.disabled, true, 'effort waits for a bulk model')
  host.sets.length = 0
  bulk.props.onChange({ target: { value: JSON.stringify(['acme', 'fast-1']) } })
  routes = nextRoutes()
  assert.deepEqual(routes.implementer, writer)
  assert.deepEqual(routes.docs, writer)
  assert.deepEqual(routes['test-writer'], writer, 'unchecked members keep their own model')
  host.sets.length = 0
  bulk.props.onChange({ target: { value: '__pick' } })
  assert.equal(host.sets.length, 0, 'the placeholder is not a choice')

  const owner = field('T 的负责人')
  assert.equal(owner.props.value, 'test-writer')
  assert.match(text(owner), /实现者.*测试员.*文档员/)
  host.sets.length = 0
  owner.props.onChange({ target: { value: 'docs' } })
  assert.equal(host.sets.find((v) => typeof v === 'function')(null).T, 'docs')

  host.sets.length = 0
  field('全选成员').props.onChange({ target: { checked: true } })
  assert.deepEqual([...host.sets[0]], ['implementer', 'test-writer', 'docs'])
})

test('settings carry the approval switch, on by default', () => {
  const root = editorFor({}, catalog)
  const box = find(root, (n) => n.props['aria-label'] === '启动前需要我确认')
  assert.equal(box.props.type, 'checkbox')
  assert.equal(box.props.checked, true)
  const off = editorFor({ requireApproval: false }, catalog)
  assert.equal(find(off, (n) => n.props['aria-label'] === '启动前需要我确认').props.checked, false)
})

test('the conversation header shows 查看工单 only when this conversation has runs, and opens the tab', () => {
  const none = loadHost([[]])
  assert.equal(none.renderSlot('conversation.session.header.actions', { sessionId: 's1' }), null)
  assert.deepEqual(none.urls, ['api/ticket-dag.dashboard?parent=s1'])

  const key = 'c'.repeat(64)
  const host = loadHost([[{ key, runId: 'latest', complete: false }, { key: 'd'.repeat(64), runId: 'older' }]])
  const entry = host.renderSlot('conversation.session.header.actions', { sessionId: 's1' })
  assert.equal(text(entry), '查看工单')
  entry.props.onClick()
  assert.deepEqual(host.opened, [['dsh-resource://ticket-dag/' + key + '/latest', 'ticket-dag']], 'opens the newest run')
})

test('the plugin page tab is the Agent preset page: max agents, presets, per-preset limit and model', () => {
  const config = {
    status: 'ready',
    revision: 3,
    writable: true,
    value: {
      maxWorkers: 6,
      checkTimeoutMs: 120000,
      checks: { unit: [['node', '--test']] },
      agents: { docs: { instructions: 'Docs.', provider: '', model: '', reasoningEffort: '', maxConcurrent: 2 } },
    },
  }
  const host = loadHost([], { config })
  assert.equal(host.slots['plugins.tab'].meta.label(), 'Agent 预设')
  assert.deepEqual([...host.namespaces], ['dsh-ticket-dag'])
  const page = host.renderSlot('plugins.tab', {})
  const input = (label) => find(page, (n) => n.props['aria-label'] === label)
  assert.equal(input('最大 Agent 数量').props.value, '6')
  // Saved presets show as a compact list; fields appear only while editing.
  assert.equal(input('docs 的模型'), undefined)
  const row = find(page, (n) => n.props['data-dag-preset'] === 'docs')
  assert.match(text(row), /docs/)
  assert.match(text(row), /宿主默认模型/)
  assert.match(text(row), /同时运行 ≤ 2/)
  assert.ok(find(row, (n) => n.type === 'button' && text(n) === '编辑'))
  assert.equal(input('验收超时（毫秒）'), undefined)
  assert.equal(find(page, (n) => n.type === 'h3' && text(n) === '验收命令'), undefined)
  assert.ok(host.urls.includes('api/ticket-dag.models'))

  const loading = loadHost([]).renderSlot('plugins.tab', {})
  assert.match(text(loading), /正在读取插件配置/)
})

test('collapsed preset rows summarise model, effort and limit; an expanded row shows its fields', () => {
  const value = {
    agents: {
      docs: { description: '文档', instructions: 'x', provider: 'acme', model: 'deep-2', reasoningEffort: 'high', maxConcurrent: 0 },
      tests: { description: '测试', instructions: 'y', provider: 'acme', model: 'fast-1', reasoningEffort: '', maxConcurrent: 3 },
    },
  }
  const collapsed = editorFor(value, catalog, new Set())
  const rows = findAll(collapsed, (n) => n.props['data-dag-preset'] !== undefined)
  assert.deepEqual(rows.map((r) => r.props['data-dag-preset']), ['docs', 'tests'])
  assert.match(text(rows[0]), /文档/)
  assert.match(text(rows[0]), /Deep 2 · High/)
  assert.match(text(rows[0]), /不单独限制/)
  assert.match(text(rows[1]), /Fast 1/)
  assert.match(text(rows[1]), /同时运行 ≤ 3/)
  assert.equal(find(collapsed, (n) => n.props['aria-label'] === 'docs 的模型'), undefined)

  const one = editorFor(value, catalog, new Set([1]))
  assert.equal(find(one, (n) => n.props['aria-label'] === 'docs 的模型'), undefined)
  assert.ok(find(one, (n) => n.props['aria-label'] === 'tests 的模型'))
  const done = find(one, (n) => n.props['data-dag-preset'] === 'tests')
  assert.ok(find(done, (n) => n.type === 'button' && text(n) === '收起'))
})

test('the full settings form also edits each preset limit', () => {
  const root = editorFor({ agents: { docs: { instructions: 'x', maxConcurrent: 3 } } }, catalog)
  const field = find(root, (n) => n.props['aria-label'] === 'docs 的同时运行上限')
  assert.equal(field.props.value, '3')
  assert.ok(find(root, (n) => n.props['aria-label'] === '最大并发工单数'))
})

test('a dependency cycle in a damaged ledger still renders every ticket', () => {
  const root = boardFor([
    { id: 'X', status: 'PENDING', dependsOn: ['Y'] },
    { id: 'Y', status: 'PENDING', dependsOn: ['X'] },
  ])
  assert.equal(findAll(root, (n) => n.props['data-dag-node'] !== undefined).length, 2)
})
