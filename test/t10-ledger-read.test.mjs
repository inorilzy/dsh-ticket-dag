import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { RunCatalog, readLedger } from '../src/dashboard.mjs'
import { RunStore, normalizeManifest } from '../src/store.mjs'

// T10: a settled history row is summarised once and then read from the index
// cache, so a pinned-run detail request never reopens the whole history.

const checks = { test: [['node', '--version']] }

function createLedger(root, name, { parentId = 'captain', tickets = [{ id: 'A', title: 'A title' }] } = {}) {
  const repo = join(root, name)
  mkdirSync(repo, { recursive: true })
  const file = join(repo, 'state.sqlite')
  const db = new RunStore(file)
  const manifest = normalizeManifest({ spec_id: 'perf', tickets }, checks)
  const meta = {
    runId: 'run-' + name,
    parentId,
    repo: { root: repo, commonDir: join(repo, '.git') },
    ref: 'refs/heads/integration/' + name,
    baseSha: 'start',
    manifest,
    policyHash: 'test',
  }
  db.init(meta)
  return { db, file, meta }
}

function addRun(catalog, root, name, options = {}) {
  const made = createLedger(root, name, options)
  catalog.remember(made.file, made.meta, options.at ?? 1)
  return made
}

// A cold coordinator: nothing is attached, so a read must use the ledger index.
const cold = (extra = {}) => ({ maxWorkers: 16, runs: new Map(), ...extra })

// The pre-T10 reader opened every ledger in the history on each request. It is
// reconstructed here from the public `entries` rows so the benchmark compares
// old and new costs without duplicating the dashboard's read logic.
function legacyRead(catalog, context, key) {
  const known = catalog.entries()
  const selectedKey = key ?? known[0]?.key
  for (const row of known) {
    const { file, summary, summarySig, ...entry } = row
    readLedger(file, entry, entry.key === selectedKey, context.maxWorkers)
  }
}

function measure(fn, iterations) {
  const samples = []
  for (let index = 0; index < iterations; index++) {
    const start = process.hrtime.bigint()
    fn()
    samples.push(Number(process.hrtime.bigint() - start) / 1e6)
  }
  samples.sort((a, b) => a - b)
  const at = (fraction) => samples[Math.min(samples.length - 1, Math.floor(fraction * samples.length))]
  return { p50: at(0.5), p95: at(0.95) }
}

function tempRoot(t, label) {
  const root = mkdtempSync(join(tmpdir(), label + '-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

test('the session filter runs inside the index query and keeps conversations apart', (t) => {
  const root = tempRoot(t, 'dag-t10-session')
  const catalog = new RunCatalog(join(root, 'profile'))
  const made = [
    addRun(catalog, root, 'a1', { parentId: 'captain-a', at: 1 }),
    addRun(catalog, root, 'a2', { parentId: 'captain-a', at: 2 }),
    addRun(catalog, root, 'b1', { parentId: 'captain-b', at: 3 }),
  ]
  try {
    assert.deepEqual(
      catalog.entries('captain-a').map((row) => row.repoName).sort(),
      ['a1', 'a2'],
    )
    const view = catalog.read(cold(), null, 'captain-a')
    assert.deepEqual(view.runs.map((row) => row.repoName).sort(), ['a1', 'a2'])
    // A run from another conversation is invisible by key even though it exists.
    const bKey = catalog.entries('captain-b')[0].key
    assert.equal(catalog.read(cold(), bKey, 'captain-a'), null)
    // Without a filter the whole history is visible, as before.
    assert.equal(catalog.read(cold(), null).runs.length, 3)
  } finally {
    made.forEach((run) => run.db.close())
  }
})

test('a pinned detail does not depend on unrelated history ledgers', (t) => {
  const root = tempRoot(t, 'dag-t10-detail')
  const catalog = new RunCatalog(join(root, 'profile'))
  const target = addRun(catalog, root, 'target', { at: 100 })
  const history = [1, 2, 3, 4, 5].map((n) => addRun(catalog, root, 'history-' + n, { at: n }))
  try {
    // Every unrelated ledger is gone before the detail request: the pinned run
    // must still be fully readable, and each broken row keeps its diagnostic.
    for (const run of history) {
      run.db.close()
      rmSync(run.file, { force: true })
      rmSync(run.file + '-wal', { force: true })
      rmSync(run.file + '-shm', { force: true })
    }
    const key = catalog.entries().find((row) => row.repoName === 'target').key
    const view = catalog.read(cold(), key)
    assert.equal(view.selected.available, true)
    assert.equal(view.selected.tickets.length, 1)
    assert.equal(view.selected.tickets[0].id, 'A')
    const broken = view.runs.filter((row) => row.available === false)
    assert.equal(broken.length, history.length)
    assert.match(broken[0].diagnostic, /SQLite/)
  } finally {
    target.db.close()
  }
})

test('a detail request opens only the selected ledger; settled history is cached', (t) => {
  const root = tempRoot(t, 'dag-t10-cost')
  const profile = join(root, 'profile')
  const catalog = new RunCatalog(profile)
  const total = 30
  const made = []
  for (let index = 0; index < total; index++)
    made.push(addRun(catalog, root, 'run-' + index, { at: index + 1 }))
  try {
    const context = cold()
    const list = catalog.read(context, null)
    assert.equal(list.runs.length, total)
    assert.ok(catalog.ledgerOpens >= total, 'the first list read opens each ledger once: ' + catalog.ledgerOpens)

    const pinned = list.runs[0].key
    catalog.ledgerOpens = 0
    const detail = catalog.read(context, pinned)
    assert.equal(detail.selected.tickets.length, 1)
    assert.equal(catalog.ledgerOpens, 1, 'a pinned detail opens exactly the selected ledger')

    catalog.ledgerOpens = 0
    const again = catalog.read(context, null)
    assert.equal(catalog.ledgerOpens, 1, 'a list read only opens its selected detail; history stays cached')
    assert.deepEqual(again.runs.map((row) => row.key), list.runs.map((row) => row.key))
  } finally {
    made.forEach((run) => run.db.close())
  }
})

test('an index from before the summary columns reads and migrates in place', (t) => {
  const root = tempRoot(t, 'dag-t10-migrate')
  const profile = join(root, 'profile')
  const catalog = new RunCatalog(profile)
  const run = addRun(catalog, root, 'legacy', { at: 1 })
  try {
    // Recreate the pre-T10 schema: the cache columns did not exist.
    const old = new DatabaseSync(catalog.index)
    old.exec('ALTER TABLE runs DROP COLUMN summary; ALTER TABLE runs DROP COLUMN summarySig;')
    old.close()

    const restored = new RunCatalog(profile)
    const view = restored.read(cold(), null)
    assert.equal(view.selected.available, true)
    assert.equal(view.selected.counts.PENDING, 1)

    // The read migrated the old index incrementally and cached the summary.
    const check = new DatabaseSync(catalog.index, { readOnly: true })
    try {
      const columns = new Set(check.prepare('PRAGMA table_info(runs)').all().map((column) => column.name))
      assert.ok(columns.has('summary') && columns.has('summarySig'))
      const row = check.prepare('SELECT summary,summarySig FROM runs WHERE key=?').get(view.selected.key)
      assert.ok(row.summary && row.summarySig)
    } finally {
      check.close()
    }
  } finally {
    run.db.close()
  }
})

test('1/10/30/100 runs: read cost stays flat and latency is recorded', (t) => {
  const root = tempRoot(t, 'dag-t10-perf')
  const profile = join(root, 'profile')
  const catalog = new RunCatalog(profile)
  const made = []
  let createdAt = 0
  const rows = []
  try {
    for (const count of [1, 10, 30, 100]) {
      while (made.length < count)
        made.push(addRun(catalog, root, 'perf-' + made.length, { at: ++createdAt }))
      const context = cold()
      const key = catalog.entries()[0].key
      // Warm this process's cache once, the same way an open board does.
      catalog.read(context, key)

      const after = measure(() => catalog.read(context, key), 10)
      const before = measure(() => legacyRead(catalog, context, key), 10)

      // A fresh instance reads the persisted summaries: the pinned detail opens
      // exactly one ledger while every other run comes from the index cache.
      const afterProbe = new RunCatalog(profile)
      afterProbe.read(context, key)
      afterProbe.ledgerOpens = 0
      afterProbe.read(context, key)

      const bytes = Buffer.byteLength(JSON.stringify(catalog.read(context, key)))
      assert.equal(catalog.entries().length, count)
      assert.equal(afterProbe.ledgerOpens, 1)
      rows.push({
        count,
        beforeP50: before.p50.toFixed(2),
        beforeP95: before.p95.toFixed(2),
        afterP50: after.p50.toFixed(2),
        afterP95: after.p95.toFixed(2),
        bytes,
        beforeOpens: count,
        afterOpens: afterProbe.ledgerOpens,
      })
    }
  } finally {
    made.forEach((run) => run.db.close())
  }
  t.diagnostic('history read comparison (ms, same environment):\n' + JSON.stringify(rows, null, 2))
  assert.equal(rows.length, 4)
})
