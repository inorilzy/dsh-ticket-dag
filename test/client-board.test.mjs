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
const loadBoard = (seeds) => loadSlots(seeds)['plugins.tab']

// Editor state order: edit draft, notice, busy, model catalog.
function editorFor(value, catalog) {
  const Panel = loadSlots([null, null, false, catalog])['plugins.row.config']
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
  assert.equal(findAll(map, (n) => n.type === 'path').length, 2)
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
  const active = findAll(map, (n) => n.type === 'path').map((p) => p.props['data-active'])
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

test('nodes and the detail card name the ticket agent preset and its model', () => {
  const root = boardFor([
    { id: 'A', title: 'Docs', status: 'RUNNING', agent: 'docs', model: 'acme/fast-1', livePhase: { stage: 'agent' } },
    { id: 'B', status: 'PENDING', dependsOn: ['A'] },
  ])
  const node = find(root, (n) => n.props['data-dag-node'] === 'A')
  assert.match(text(node), /docs/)
  assert.match(node.props.title, /acme\/fast-1/)
  assert.match(text(find(root, (n) => n.props['data-dag-detail'] === 'A')), /docs · acme\/fast-1/)
  assert.doesNotMatch(text(find(root, (n) => n.props['data-dag-node'] === 'B')), /默认/)
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
  assert.deepEqual(
    values('角色说明'),
    Object.values(builtinAgents).map((a) => a.instructions),
  )
})

test('a dependency cycle in a damaged ledger still renders every ticket', () => {
  const root = boardFor([
    { id: 'X', status: 'PENDING', dependsOn: ['Y'] },
    { id: 'Y', status: 'PENDING', dependsOn: ['X'] },
  ])
  assert.equal(findAll(root, (n) => n.props['data-dag-node'] !== undefined).length, 2)
})
