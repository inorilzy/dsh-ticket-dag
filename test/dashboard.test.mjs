import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { RunCatalog, mountApproval, mountDashboard, mountModels } from '../src/dashboard.mjs'
import { RunStore, normalizeManifest } from '../src/store.mjs'

function addRun(root, name, catalog, at) {
  const repo = join(root, name)
  mkdirSync(repo)
  const file = join(repo, 'state.sqlite')
  const db = new RunStore(file)
  const manifest = normalizeManifest(
    {
      spec_id: 'demo',
      tickets: [
        { id: 'A', title: 'A title', verify: ['test'] },
        { id: 'B', title: 'B title', depends_on: ['A'], verify: ['test'] },
      ],
    },
    { test: [['node', '--version']] },
  )
  const meta = {
    runId: 'same',
    parentId: 'captain-' + name,
    repo: { root: repo, commonDir: join(repo, '.git') },
    ref: 'refs/heads/integration/same',
    baseSha: 'start',
    manifest,
    policyHash: 'test',
  }
  db.init(meta)
  catalog.remember(file, meta, at)
  return { db, file }
}

test('dashboard history survives restart, separates projects, and never attaches or repairs a run', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dag-history-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const profile = join(root, 'profile')
  const catalog = new RunCatalog(profile)
  const first = addRun(root, 'repo-1', catalog, 1000)
  const second = addRun(root, 'repo-2', catalog, 2000)
  const job = first.db.claim('A', {
    childId: 'child',
    path: '/fixture/work',
    branch: 'ticket/A',
    baseSha: 'start',
  })
  const initialEvents = first.db.events().length
  const cold = {
    maxWorkers: 16,
    runs: new Map(),
    peek() {
      throw Error('Unexpected attach')
    },
  }
  try {
    const restored = new RunCatalog(profile)
    const list = restored.read(cold, null)
    assert.equal(list.runs.length, 2)
    const keys = new Map(list.runs.map((row) => [row.repoName, row.key]))
    assert.notEqual(keys.get('repo-1'), keys.get('repo-2'))
    const data = restored.read(cold, keys.get('repo-1')).selected
    assert.equal(data.attached, false)
    assert.equal(data.counts.RUNNING, 1)
    assert.equal(data.tickets[0].livePhase, null)
    assert.deepEqual(data.tickets[1].dependsOn, ['A'])
    assert.equal(first.db.get('A').lease, job.lease)
    assert.equal(first.db.events().length, initialEvents)
    assert.deepEqual(new RunCatalog(join(root, 'other-profile')).read(cold, null).runs, [])
    const routes = { 'captain-repo-1': { provider: 'magpie', model: 'auto/claude-opus-5-5', maxTokens: 9 } }
    const withCaptain = restored.read(cold, keys.get('repo-1'), null, (id) => routes[id])
    assert.deepEqual(withCaptain.selected.captain, { provider: 'magpie', model: 'auto/claude-opus-5-5' })
    assert.equal(restored.read(cold, keys.get('repo-2'), null, (id) => routes[id]).selected.captain, null)
    const own = restored.read(cold, null, 'captain-repo-1')
    assert.deepEqual(own.runs.map((r) => r.repoName), ['repo-1'])
    assert.equal(own.selected.repoName, 'repo-1')
    assert.deepEqual(restored.read(cold, null, 'someone-else'), { runs: [], selected: null })
    assert.equal(restored.read(cold, keys.get('repo-2'), 'captain-repo-1'), null)
    assert.equal(restored.read(cold, keys.get('repo-1').replace(/^./, 'g')), null)
    second.db.close()
    rmSync(second.file)
    assert.equal(restored.read(cold, keys.get('repo-2')).selected.available, false)
    assert.equal(existsSync(second.file), false)
  } finally {
    first.db.close()
    if (existsSync(second.file)) second.db.close()
  }
})

test('only the selected run carries timing, including an old ledger and an attached run', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dag-history-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const catalog = new RunCatalog()
  const first = addRun(root, 'repo-1', catalog, 1000)
  const second = addRun(root, 'repo-2', catalog, 2000)
  first.db.claim('A', { childId: 'child', path: '/fixture/work', branch: 'ticket/A', baseSha: 'start' })
  const cold = { maxWorkers: 16, runs: new Map(), peek: () => assert.fail('Unexpected attach') }
  try {
    const keys = new Map(catalog.read(cold, null).runs.map((row) => [row.repoName, row.key]))
    const before = Date.now()
    const view = catalog.read(cold, keys.get('repo-1'))
    assert.ok(view.selected.now >= before)
    assert.equal(view.selected.timing.tickets.A.attempts, 1)
    assert.equal(view.selected.timing.runningSince, view.selected.timing.startedAt)
    assert.equal(view.selected.timing.totals.queueMs, null)
    for (const row of view.runs) assert.equal('timing' in row, false)

    // A ledger from before run_started named its mode still reads.
    first.db.close()
    const old = new DatabaseSync(first.file)
    old.exec(`UPDATE events SET details='{}' WHERE type='run_started'`)
    old.close()
    assert.equal(catalog.read(cold, keys.get('repo-1')).selected.timing.tickets.A.attempts, 1)

    // Attached rows other than the selected one are not asked for timing.
    const asked = []
    const attached = {
      maxWorkers: 16,
      runs: new Map([
        [first.file, {}],
        [second.file, {}],
      ]),
      peek(file, now) {
        asked.push([file, now])
        return { mode: 'active', complete: false, counts: {}, tickets: [], timing: now ? { fixture: now } : undefined }
      },
    }
    const live = catalog.read(attached, keys.get('repo-2'))
    assert.deepEqual(live.selected.timing, { fixture: live.selected.now })
    assert.deepEqual(asked.sort(([a], [b]) => (a === second.file ? -1 : b === second.file ? 1 : 0)), [
      [second.file, live.selected.now],
      [first.file, undefined],
    ])
  } finally {
    second.db.close()
  }
})

test('a plan under review has no timing until it is approved', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dag-history-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const repo = join(root, 'repo')
  mkdirSync(repo)
  const file = join(repo, 'state.sqlite')
  const db = new RunStore(file)
  const manifest = normalizeManifest({ spec_id: 'demo', tickets: [{ id: 'A', title: 'A' }] })
  const meta = {
    runId: 'review',
    parentId: 'captain',
    repo: { root: repo, commonDir: join(repo, '.git') },
    ref: 'refs/heads/integration/review',
    baseSha: 'start',
    manifest,
    policyHash: 'test',
    mode: 'staged',
  }
  db.init(meta)
  const catalog = new RunCatalog()
  catalog.remember(file, meta, 1000)
  const cold = { maxWorkers: 16, runs: new Map(), peek: () => assert.fail('Unexpected attach') }
  try {
    assert.equal(catalog.read(cold, null).selected.timing, null)
    assert.equal(db.approve(db.plan()), true)
    assert.equal(catalog.read(cold, null).selected.timing.tickets.A, undefined)
    assert.equal(typeof catalog.read(cold, null).selected.timing.startedAt, 'number')
  } finally {
    db.close()
  }
})

test('a cold plan under review still lists its manifest commands; other cold runs claim none', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dag-history-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const repo = join(root, 'repo')
  mkdirSync(repo)
  const file = join(repo, 'state.sqlite')
  const db = new RunStore(file)
  const checks = { later: [['node', '', 'a b']] }
  const meta = {
    runId: 'cold',
    parentId: 'captain',
    repo: { root: repo, commonDir: join(repo, '.git') },
    ref: 'refs/heads/integration/cold',
    baseSha: 'start',
    manifest: normalizeManifest({ spec_id: 'demo', checks, tickets: [{ id: 'A', title: 'A' }] }),
    policyHash: 'test',
    mode: 'staged',
  }
  db.init(meta)
  const catalog = new RunCatalog()
  catalog.remember(file, meta, 1000)
  const cold = { maxWorkers: 16, runs: new Map(), peek: () => assert.fail('Unexpected attach') }
  try {
    const review = catalog.read(cold, null).selected
    assert.equal(review.attached, false)
    assert.deepEqual(review.checks, checks)
    assert.deepEqual(review.planChecks, ['later'])
    // A staged plan read without the coordinator still carries the same opaque
    // revision the coordinator's serial region will compare against.
    assert.match(review.revision, /^[0-9a-f]{64}$/)
    assert.equal(review.revision, db.revision())
    db.setMode('cancelled')
    const ended = catalog.read(cold, null).selected
    assert.deepEqual(ended.checks, {})
    assert.deepEqual(ended.planChecks, [])
    assert.equal(ended.revision, null)
  } finally {
    db.close()
  }
})

test('dashboard URL accepts only one opaque key and only supplies a GET route', async () => {
  let route,
    reads = 0
  const parents = []
  mountDashboard(
    {
      connection: {
        fetch: {
          register(r) {
            route = r
          },
        },
      },
    },
    {
      read(_co, key, parent) {
        reads++
        parents.push(parent)
        return key ? null : { runs: [], selected: null }
      },
    },
    {},
  )
  assert.deepEqual(route.methods, ['GET'])
  const get = (suffix) => route.fetch(new Request('http://localhost' + route.path + suffix))
  for (const input of [
    '?path=/tmp/private.sqlite',
    '?key=../private',
    '?key=a&key=b',
    '?extra=1',
    '?parent=a&parent=b',
    '?parent=' + encodeURIComponent('../x y'),
    '?parent=',
  ]) {
    assert.equal((await get(input)).status, 400, input)
  }
  assert.equal(reads, 0)
  const list = await get('')
  assert.match(list.headers.get('cache-control'), /no-store/)
  assert.deepEqual(await list.json(), { runs: [], selected: null })
  assert.equal((await get('?key=' + 'a'.repeat(64))).status, 404)
  assert.equal((await get('?parent=session_01:abc-9')).status, 200)
  assert.deepEqual(parents, [null, null, 'session_01:abc-9'])
})

const approvalHeaders = { 'content-type': 'application/json', 'x-dsh-ticket-dag': '1' }
const llm = {
  listProviders: () => [{ id: 'acme', name: 'Acme' }],
  async listModels(provider) {
    return [
      { provider, id: 'fast-1', name: 'Fast 1' },
      { provider, id: 'deep-2', name: 'Deep 2' },
    ]
  },
  async resolveModelInfo(provider, model) {
    return model === 'deep-2' ? { reasoning: { efforts: [{ id: 'high' }], defaultEffort: 'high' } } : {}
  },
}

function approvalRoute(getLlm = () => llm) {
  let route
  const calls = []
  const key = 'b'.repeat(64)
  const coordinator = {
    runs: new Map([['/runs/a/state.sqlite', {}]]),
    async approve(file, choices) {
      calls.push(['approve', choices])
      return { mode: 'active' }
    },
    async discard() {
      calls.push(['discard'])
      return { mode: 'cancelled' }
    },
  }
  const catalog = { entries: () => [{ key, file: '/runs/a/state.sqlite' }] }
  mountApproval({ connection: { fetch: { register: (r) => (route = r) } } }, catalog, coordinator, getLlm)
  const post = (body, headers = approvalHeaders, url = 'http://localhost') =>
    route.fetch(new Request(url + route.path, { method: 'POST', headers, body: JSON.stringify({ key, ...body }) }))
  return { post, calls }
}

test('approval POST requires a JSON body, the plugin header and a same-origin caller', async () => {
  const { post, calls } = approvalRoute()
  const discard = { action: 'discard' }
  assert.equal((await post(discard, { 'x-dsh-ticket-dag': '1' })).status, 415, 'no content type')
  assert.equal((await post(discard, { 'content-type': 'text/plain', 'x-dsh-ticket-dag': '1' })).status, 415)
  assert.equal((await post(discard, { 'content-type': 'application/json' })).status, 403, 'no plugin header')
  assert.equal((await post(discard, { ...approvalHeaders, 'x-dsh-ticket-dag': '0' })).status, 403)
  assert.equal((await post(discard, { ...approvalHeaders, origin: 'https://evil.example' })).status, 403)
  assert.equal((await post(discard, { ...approvalHeaders, origin: 'null' })).status, 403)
  assert.deepEqual(calls, [], 'a refused request never reaches the coordinator')
  const json = { 'content-type': 'application/json; charset=utf-8', 'x-dsh-ticket-dag': '1' }
  assert.equal((await post(discard, json)).status, 200)
  assert.equal((await post(discard, { ...approvalHeaders, origin: 'http://127.0.0.1:4000' }, 'http://127.0.0.1:4000')).status, 200)
  assert.equal(calls.length, 2)
})

test('approval checks each chosen model and reasoning effort against the model catalog', async () => {
  const { post, calls } = approvalRoute()
  const approve = (choice) => post({ action: 'approve', choices: [{ id: 'A', agent: 'docs', ...choice }] })
  for (const [choice, pattern] of [
    [{ provider: 'acme', model: 'missing-9' }, /missing-9/],
    [{ provider: 'other', model: 'fast-1' }, /other/],
    [{ provider: 'acme', model: 'fast-1', reasoningEffort: 'high' }, /high/],
    [{ provider: 'acme', model: 'deep-2', reasoningEffort: 'max' }, /max/],
    [{ provider: 'acme', model: 'x'.repeat(201) }, /200/],
    [{ provider: 'acme', model: 7 }, /model/],
  ]) {
    const response = await approve(choice)
    assert.equal(response.status, 400, JSON.stringify(choice))
    assert.match(await response.text(), pattern)
  }
  assert.equal((await post({ action: 'approve', choices: [null] })).status, 400)
  assert.deepEqual(calls, [])
  for (const choice of [
    { provider: 'acme', model: 'deep-2', reasoningEffort: 'high' },
    { provider: 'acme', model: 'fast-1', reasoningEffort: '' },
    { provider: '', model: 'fast-1' },
    { provider: '', model: '', reasoningEffort: '' },
  ]) {
    assert.equal((await approve(choice)).status, 200, JSON.stringify(choice))
  }
  assert.equal(calls.length, 4)
})

test('without a model catalog approval refuses a chosen model but accepts the host default', async () => {
  for (const getLlm of [
    () => undefined,
    () => ({ ...llm, listModels: async () => Promise.reject(Error('offline')) }),
  ]) {
    const { post, calls } = approvalRoute(getLlm)
    const refused = await post({ action: 'approve', choices: [{ id: 'A', provider: 'acme', model: 'fast-1' }] })
    assert.equal(refused.status, 503)
    assert.match(await refused.text(), /模型目录/)
    assert.equal((await post({ action: 'approve', choices: [{ id: 'A', model: '' }] })).status, 200)
    assert.equal(calls.length, 1)
  }
})

test('approval route approves or discards only an attached staged run named by its opaque key', async () => {
  let route
  const calls = []
  const key = 'b'.repeat(64)
  const catalog = { entries: () => [{ key, file: '/runs/a/state.sqlite' }] }
  const coordinator = {
    runs: new Map([['/runs/a/state.sqlite', {}]]),
    async approve(file, choices, options) {
      calls.push(['approve', file, choices, options])
      return { mode: 'active' }
    },
    async discard(file) {
      calls.push(['discard', file])
      return { mode: 'cancelled' }
    },
  }
  mountApproval({ connection: { fetch: { register: (r) => (route = r) } } }, catalog, coordinator, () => llm)
  assert.equal(route.path, '/api/ticket-dag.approve')
  assert.deepEqual(route.methods, ['POST'])
  const post = (body) =>
    route.fetch(
      new Request('http://localhost' + route.path, { method: 'POST', headers: approvalHeaders, body: JSON.stringify(body) }),
    )
  const choices = [{ id: 'A', agent: 'docs', provider: 'acme', model: 'fast-1', reasoningEffort: '' }]
  const ok = await post({ key, action: 'approve', choices })
  assert.equal(ok.status, 200)
  assert.deepEqual(await ok.json(), { mode: 'active' })
  assert.equal((await post({ key, action: 'discard' })).status, 200)
  assert.equal((await post({ key, action: 'approve', choices, maxWorkers: 8 })).status, 200)
  for (const bad of [0, 33, 2.5, '8']) assert.equal((await post({ key, action: 'approve', choices, maxWorkers: bad })).status, 400)
  assert.deepEqual(calls, [
    ['approve', '/runs/a/state.sqlite', choices, {}],
    ['discard', '/runs/a/state.sqlite'],
    ['approve', '/runs/a/state.sqlite', choices, { maxWorkers: 8 }],
  ])
  assert.equal((await post({ key: 'c'.repeat(64), action: 'approve', choices })).status, 404)
  assert.equal((await post({ key: '../x', action: 'approve', choices })).status, 400)
  assert.equal((await post({ key, action: 'launch' })).status, 400)
  assert.equal(
    (await route.fetch(new Request('http://localhost' + route.path, { method: 'POST', headers: approvalHeaders, body: '{' })))
      .status,
    400,
  )
  coordinator.runs.clear()
  assert.equal((await post({ key, action: 'approve', choices })).status, 409)
  coordinator.runs.set('/runs/a/state.sqlite', {})
  coordinator.approve = async () => {
    throw Error('This run is not waiting for approval')
  }
  const refused = await post({ key, action: 'approve', choices })
  assert.equal(refused.status, 409)
  assert.match(await refused.text(), /not waiting for approval/)
})

test('approval forwards the plan revision and refuses a malformed one before the coordinator', async () => {
  let route
  const calls = []
  const key = 'b'.repeat(64)
  const catalog = { entries: () => [{ key, file: '/runs/a/state.sqlite' }] }
  const coordinator = {
    runs: new Map([['/runs/a/state.sqlite', {}]]),
    async approve(file, choices, options) {
      calls.push(['approve', options])
      return { mode: 'active' }
    },
  }
  mountApproval({ connection: { fetch: { register: (r) => (route = r) } } }, catalog, coordinator, () => llm)
  const post = (body) =>
    route.fetch(
      new Request('http://localhost' + route.path, {
        method: 'POST',
        headers: approvalHeaders,
        body: JSON.stringify({ key, ...body }),
      }),
    )
  const choices = [{ id: 'A', agent: 'docs', provider: 'acme', model: 'fast-1', reasoningEffort: '' }]
  const revision = 'r'.repeat(64)
  assert.equal((await post({ action: 'approve', choices, revision })).status, 200)
  assert.deepEqual(calls.at(-1), ['approve', { revision }])
  assert.equal((await post({ action: 'approve', choices, revision: 7 })).status, 400)
  assert.equal((await post({ action: 'approve', choices, revision: 'x'.repeat(513) })).status, 400)
  assert.equal(calls.length, 1, 'a malformed revision never reaches the coordinator')
  // A stale revision surfaces the coordinator's diagnostic as a coded 409 so
  // the board can tell "review the new plan again" from any other refusal.
  coordinator.approve = async () => {
    const error = new Error('The plan changed after you reviewed it')
    error.status = 409
    error.code = 'stale-revision'
    throw error
  }
  const stale = await post({ action: 'approve', choices, revision })
  assert.equal(stale.status, 409)
  assert.deepEqual(await stale.json(), {
    code: 'stale-revision',
    message: 'The plan changed after you reviewed it',
  })
})

test('model catalog route lists every provider, its models and efforts, and reports a failing provider', async () => {
  let route
  const llm = {
    listProviders: () => [
      { id: 'acme', name: 'Acme' },
      { id: 'down', name: 'Down' },
    ],
    async listModels(provider) {
      if (provider === 'down') throw Error('offline')
      return [
        { provider, id: 'fast-1', name: 'Fast 1' },
        { provider, id: 'deep-2', name: 'Deep 2' },
      ]
    },
    async resolveModelInfo(provider, model) {
      return model === 'deep-2'
        ? { provider, id: model, name: 'Deep 2', reasoning: { efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high' } }
        : { provider, id: model, name: 'Fast 1' }
    },
  }
  mountModels({ connection: { fetch: { register: (r) => (route = r) } } }, () => llm)
  assert.equal(route.path, '/api/ticket-dag.models')
  assert.deepEqual(route.methods, ['GET'])
  const response = await route.fetch(new Request('http://localhost' + route.path))
  assert.match(response.headers.get('cache-control'), /no-store/)
  assert.deepEqual(await response.json(), {
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
    failures: ['down'],
  })
  mountModels({ connection: { fetch: { register: (r) => (route = r) } } }, () => undefined)
  assert.deepEqual(await (await route.fetch(new Request('http://localhost' + route.path))).json(), {
    providers: [],
    failures: [],
  })
})

test('cold history exposes each ticket agent preset and model route', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dag-agents-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const repo = join(root, 'repo')
  mkdirSync(repo)
  const file = join(repo, 'state.sqlite')
  const db = new RunStore(file)
  const manifest = normalizeManifest(
    {
      spec_id: 'demo',
      tickets: [
        { id: 'A', title: 'A', verify: ['test'], agent: 'docs' },
        { id: 'B', title: 'B', verify: ['test'] },
      ],
    },
    { test: [['node', '--version']] },
    { docs: { instructions: 'Docs.', provider: 'acme', model: 'fast-1' } },
  )
  const meta = {
    runId: 'agents',
    parentId: 'captain',
    repo: { root: repo, commonDir: join(repo, '.git') },
    ref: 'refs/heads/integration/agents',
    baseSha: 'start',
    manifest,
    policyHash: 'test',
  }
  db.init(meta)
  const catalog = new RunCatalog(join(root, 'profile'))
  catalog.remember(file, meta, 1)
  try {
    const cold = { maxWorkers: 16, runs: new Map() }
    const rows = catalog.read(cold, null).selected.tickets
    assert.deepEqual(
      rows.map((r) => [r.id, r.agent, r.model]),
      [
        ['A', 'docs', 'acme/fast-1'],
        ['B', null, null],
      ],
    )
  } finally {
    db.close()
  }
})

test('cold history carries declared files, their overlaps and the undeclared-files note', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dag-files-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const repo = join(root, 'repo')
  mkdirSync(repo)
  const file = join(repo, 'state.sqlite')
  const db = new RunStore(file)
  const manifest = normalizeManifest(
    {
      spec_id: 'demo',
      tickets: [
        { id: 'A', title: 'A', verify: ['test'], files: ['src/a.js', 'src/main.js'] },
        { id: 'B', title: 'B', verify: ['test'], files: ['src/b.js', 'src/main.js'] },
        { id: 'C', title: 'C', verify: ['test'], depends_on: ['A'], files: ['src/main.js'] },
        { id: 'D', title: 'D', verify: ['test'] },
      ],
    },
    { test: [['node', '--version']] },
  )
  const meta = {
    runId: 'files',
    parentId: 'captain',
    repo: { root: repo, commonDir: join(repo, '.git') },
    ref: 'refs/heads/integration/files',
    baseSha: 'start',
    manifest,
    policyHash: 'test',
  }
  db.init(meta)
  db.recordUndeclared('A', { sourceSha: 'a'.repeat(40), files: ['README.md'] })
  // B's note is about an earlier commit than the one it carries now, so it no longer applies.
  db.recordUndeclared('B', { sourceSha: 'c'.repeat(40), files: ['old.js'] })
  const raw = new DatabaseSync(file)
  raw.prepare('UPDATE tickets SET sourceSha=? WHERE id=?').run('a'.repeat(40), 'A')
  raw.prepare('UPDATE tickets SET sourceSha=? WHERE id=?').run('b'.repeat(40), 'B')
  raw.close()
  const catalog = new RunCatalog(join(root, 'profile'))
  catalog.remember(file, meta, 1)
  try {
    const selected = catalog.read({ maxWorkers: 16, runs: new Map() }, null).selected
    // C depends on A, so only A–B and B–C may run together on src/main.js.
    assert.deepEqual(selected.fileOverlaps, [
      { tickets: ['A', 'B'], files: ['src/main.js'] },
      { tickets: ['B', 'C'], files: ['src/main.js'] },
    ])
    const byId = Object.fromEntries(selected.tickets.map((r) => [r.id, r]))
    assert.deepEqual(byId.A.files, ['src/a.js', 'src/main.js'])
    assert.deepEqual(byId.D.files, [])
    assert.deepEqual(byId.A.undeclaredFiles, { sourceSha: 'a'.repeat(40), files: ['README.md'] })
    assert.equal(byId.B.undeclaredFiles, null)
  } finally {
    db.close()
  }
})

test('cold history reads cleanup results, and a ledger from before cleanup as not cleaned', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dag-cleanup-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const catalog = new RunCatalog(join(root, 'profile'))
  const cold = { maxWorkers: 16, runs: new Map() }
  const fresh = addRun(root, 'fresh', catalog, 2)
  const old = addRun(root, 'old', catalog, 1)
  try {
    const a = fresh.db.claim('A', { childId: 'child', path: '/fixture/A', branch: 'ticket/same/A', baseSha: 'start' })
    fresh.db.move('A', a.lease, 'RUNNING', 'SUBMITTED', { sourceSha: 'source' })
    fresh.db.intent('A', a.lease, { oldTip: 'start', sourceSha: 'source', candidateSha: 'landed' })
    fresh.db.finish('A', a.lease, 'landed')
    fresh.db.recordCleanup('A', 'skipped', 'not merged')
    const [freshKey, oldKey] = catalog.read(cold, null).runs.map((r) => r.key)
    const rows = catalog.read(cold, freshKey).selected.tickets
    assert.deepEqual(rows.map((r) => [r.id, r.cleanup, r.cleanupReason]), [
      ['A', 'skipped', 'not merged'],
      ['B', null, null],
    ])
    old.db.close()
    const legacy = new DatabaseSync(old.file)
    legacy.exec('ALTER TABLE tickets DROP COLUMN cleanupReason; ALTER TABLE tickets DROP COLUMN cleanup')
    legacy.close()
    const legacyRows = catalog.read(cold, oldKey).selected.tickets
    assert.deepEqual(legacyRows.map((r) => [r.id, r.cleanup, r.cleanupReason]), [
      ['A', null, null],
      ['B', null, null],
    ])
  } finally {
    fresh.db.close()
  }
})

test('every snapshot mode carries the presets so the progress board can name members', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dag-presets-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const catalog = new RunCatalog(join(root, 'profile'))
  const { db, file } = addRun(root, 'repo', catalog, 1)
  const agents = { docs: { name: '文档员', description: '文档', instructions: 'Docs.', provider: 'acme', model: 'fast-1' } }
  const docs = { id: 'docs', name: '文档员', description: '文档', provider: 'acme', model: 'fast-1', reasoningEffort: '' }
  try {
    const cold = { maxWorkers: 16, runs: new Map(), agents }
    const active = catalog.read(cold, null).selected
    assert.equal(active.mode, 'active')
    assert.deepEqual(active.presets, [docs])
    const attached = {
      ...cold,
      runs: new Map([[file, {}]]),
      peek: () => ({ mode: 'paused', complete: false, counts: {}, tickets: [] }),
    }
    assert.deepEqual(catalog.read(attached, null).selected.presets, [docs])
    assert.deepEqual(catalog.read({ maxWorkers: 16, runs: new Map() }, null).selected.presets, [])
  } finally {
    db.close()
  }
})

test('a run the recovery scan cannot attach is listed as unreadable with its diagnostic', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dag-recovery-board-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const catalog = new RunCatalog(join(root, 'profile'))
  const { db, file } = addRun(root, 'repo', catalog, 1)
  const cold = { maxWorkers: 16, runs: new Map(), peek: () => assert.fail('Unexpected attach') }
  try {
    const before = catalog.read(cold, null, 'captain-repo')
    assert.equal(before.runs.length, 1)
    assert.equal(before.selected.available, true)
    // The host reports a failed attach: same run, still listed, now unreadable with the reason.
    catalog.reportFailure('captain-repo', 'same', 'Another DSH coordinator owns this run: /runs/same', file)
    const view = catalog.read(cold, null, 'captain-repo')
    assert.equal(view.runs.length, 1)
    assert.equal(view.selected.available, false)
    assert.equal(view.selected.mode, 'unavailable')
    assert.match(view.selected.diagnostic, /Another DSH coordinator owns this run/)
    assert.deepEqual(view.selected.tickets, [])
    // Another captain neither sees this run nor its failure.
    assert.deepEqual(catalog.read(cold, null, 'someone-else'), { runs: [], selected: null })

    // A failure for a run missing from the index still appears as a board row.
    catalog.reportFailure('captain-ghost', 'ghost-run', 'Cannot read the run ledger x: not a database', '/nonexistent/runs/ghost-run/state.sqlite')
    const ghost = catalog.read(cold, null, 'captain-ghost')
    assert.equal(ghost.runs.length, 1)
    assert.equal(ghost.selected.runId, 'ghost-run')
    assert.equal(ghost.selected.available, false)
    assert.match(ghost.selected.diagnostic, /not a database/)
  } finally {
    db.close()
  }
})

test(
  'the installed DSH dispatcher rejects a non-owner before serving any dashboard data',
  {
    skip: !process.env.DSH_TEST_BIN && 'Set DSH_TEST_BIN to test host access control',
  },
  async (t) => {
    const requireHost = createRequire(resolve(process.env.DSH_TEST_BIN))
    const { HostConnectionService } = await import(
      pathToFileURL(requireHost.resolve('@deepseek-ai/dsh-client-connection')).href
    )
    // An isolated ledger fixture per run: the owner sees only this run, and the
    // temp root is removed even if an assertion fails.
    const root = mkdtempSync(join(tmpdir(), 'dsh-access-'))
    const catalog = new RunCatalog(join(root, 'profile'))
    const { db, file } = addRun(root, 'owned-repo', catalog, 1)
    t.after(() => {
      db.close()
      rmSync(root, { recursive: true, force: true })
    })
    const coordinator = {
      runs: new Map([[file, {}]]),
      maxWorkers: 16,
      agents: {},
      peek: () => ({
        available: true,
        mode: 'active',
        complete: true,
        counts: { INTEGRATED: 2 },
        rawMaxWorkers: 1,
        tickets: [
          { id: 'A', title: 'A title', status: 'INTEGRATED', dependsOn: [], verify: [], attempt: 1 },
          { id: 'B', title: 'B title', status: 'INTEGRATED', dependsOn: ['A'], verify: [], attempt: 1 },
        ],
      }),
    }
    const connection = Object.create(HostConnectionService.prototype)
    connection.fetchRoutes = new Map()
    connection.interceptors = new Map()
    const scope = { effect: (f) => f() }
    let reads = 0
    const readOwn = catalog.read.bind(catalog)
    catalog.read = (...args) => {
      reads++
      return readOwn(...args)
    }
    mountDashboard(
      { connection: { fetch: { register: (route) => connection.registerFetchRoute(scope, route) } } },
      catalog,
      coordinator,
      () => undefined,
    )
    const host = connection.createSharedFetchHandler('/api')
    const url = 'http://localhost/api/ticket-dag.dashboard'
    // A non-owner never reaches the ledger, whether it names a parent or a key.
    assert.equal(
      (await host.fetch(new Request(url + '?parent=captain-owned-repo'), { principal: { kind: 'remote' } })).status,
      403,
    )
    assert.equal(
      (await host.fetch(new Request(url + '?key=' + 'a'.repeat(64)), { principal: { kind: 'remote' } })).status,
      403,
    )
    assert.equal(reads, 0)
    // The owner reads only its own isolated run.
    const owned = await host.fetch(new Request(url + '?parent=captain-owned-repo'), {
      principal: { kind: 'owner' },
    })
    assert.equal(owned.status, 200)
    const view = await owned.json()
    assert.equal(view.runs.length, 1)
    assert.equal(view.selected.runId, 'same')
    assert.equal(reads, 1)
  },
)
