import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { RunCatalog, mountDashboard } from '../src/dashboard.mjs'
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

test('dashboard URL accepts only one opaque key and only supplies a GET route', async () => {
  let route,
    reads = 0
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
      read(_co, key) {
        reads++
        return key ? null : { runs: [], selected: null }
      },
    },
    {},
  )
  assert.deepEqual(route.methods, ['GET'])
  const get = (suffix) => route.fetch(new Request('http://localhost' + route.path + suffix))
  for (const input of ['?path=/tmp/private.sqlite', '?key=../private', '?key=a&key=b', '?extra=1']) {
    assert.equal((await get(input)).status, 400)
  }
  assert.equal(reads, 0)
  const list = await get('')
  assert.match(list.headers.get('cache-control'), /no-store/)
  assert.deepEqual(await list.json(), { runs: [], selected: null })
  assert.equal((await get('?key=' + 'a'.repeat(64))).status, 404)
})

test(
  'the installed DSH dispatcher rejects a non-owner before serving any dashboard data',
  {
    skip: !process.env.DSH_TEST_BIN && 'Set DSH_TEST_BIN to test host access control',
  },
  async () => {
    const requireHost = createRequire(resolve(process.env.DSH_TEST_BIN))
    const { HostConnectionService } = await import(
      pathToFileURL(requireHost.resolve('@deepseek-ai/dsh-client-connection')).href
    )
    const connection = Object.create(HostConnectionService.prototype)
    connection.fetchRoutes = new Map()
    connection.interceptors = new Map()
    const scope = { effect: (f) => f() }
    let reads = 0
    mountDashboard(
      { connection: { fetch: { register: (route) => connection.registerFetchRoute(scope, route) } } },
      {
        read() {
          reads++
          return { runs: [], selected: null }
        },
      },
      {},
    )
    const host = connection.createSharedFetchHandler('/api')
    const url = 'http://localhost/api/ticket-dag.dashboard'
    assert.equal((await host.fetch(new Request(url), { principal: { kind: 'remote' } })).status, 403)
    assert.equal(reads, 0)
    assert.equal((await host.fetch(new Request(url), { principal: { kind: 'owner' } })).status, 200)
    assert.equal(reads, 1)
  },
)
