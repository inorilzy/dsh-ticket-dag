import test from 'node:test'
import assert from 'node:assert/strict'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Coordinator } from '../src/coordinator.mjs'
import { RunCatalog, mountApproval, mountDashboard } from '../src/dashboard.mjs'
import { RunStore, normalizeAppend, normalizeManifest, readIntegrity } from '../src/store.mjs'

// R1: the plan revision binds approval to the presets the user reviewed, and the
// dashboard reads the same integrity rows the store does (one shared function).

const exec = promisify(execFile)
const env = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
}
const noopChecks = { verify: [[process.execPath, '-e', 'process.exit(0)']] }
const ticket = (id, dependsOn = []) => ({ id, title: id, depends_on: dependsOn, verify: ['verify'] })
const timeScale = process.platform === 'win32' ? 3 : 1
const limit = (ms) => ms * timeScale

async function git(cwd, ...args) {
  return (await exec('git', args, { cwd, env })).stdout.trim()
}
async function repo(t) {
  const root = await mkdtemp(join(tmpdir(), 'dag-approval-revision-'))
  const cwd = join(root, 'project')
  await mkdir(cwd)
  await git(cwd, 'init', '-q', '-b', 'main')
  await git(cwd, 'config', 'user.name', 'fixture')
  await git(cwd, 'config', 'user.email', 'fixture@example.invalid')
  await git(cwd, 'commit', '--allow-empty', '-qm', 'seed')
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }))
  return cwd
}

// Mount the real dashboard + approval routes the way index.mjs does, so the
// tests exercise the registered approval handler rather than calling the
// coordinator method directly.
function handlers(catalog, coordinator, getLlm = () => undefined) {
  const routes = {}
  const ctx = { connection: { fetch: { register: (r) => (routes[r.path] = r) } } }
  mountDashboard(ctx, catalog, coordinator, () => undefined)
  mountApproval(ctx, catalog, coordinator, getLlm)
  return {
    board: async () =>
      (await routes['/api/ticket-dag.dashboard'].fetch(new Request('http://x/api/ticket-dag.dashboard'))).json(),
    post: (body) =>
      routes['/api/ticket-dag.approve'].fetch(
        new Request('http://x/api/ticket-dag.approve', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-dsh-ticket-dag': '1' },
          body: JSON.stringify(body),
        }),
      ),
  }
}

test(
  'editing a preset after review changes the plan revision; the old approval is a 409 and stays staged',
  { timeout: limit(90000) },
  async (t) => {
    const cwd = await repo(t)
    const resolved = []
    const catalog = new RunCatalog()
    const co = new Coordinator({
      checks: noopChecks,
      requireApproval: true,
      agents: { docs: { instructions: 'Docs v1.', provider: 'acme', model: 'fast-1' } },
      rememberRun: (...args) => catalog.remember(...args),
      // Capture the exact route approval resolves; the run never needs to dispatch.
      validateRoutes: async (tickets) => resolved.push(tickets),
      launch: async () => ({ dispose: async () => {}, result: new Promise(() => {}) }),
    })
    const q = { cwd, parentId: 'captain', runId: 'rev-preset' }
    try {
      await co.start({ ...q, manifest: { spec_id: 'rev-preset', tickets: [{ ...ticket('A'), agent: 'docs' }] } })
      // The approval route validates the chosen route against the host catalog.
      const llm = {
        listProviders: () => [{ id: 'acme', name: 'Acme' }],
        async listModels() {
          return [{ id: 'fast-1', name: 'Fast 1' }]
        },
        async resolveModelInfo() {
          return {}
        },
      }
      const { board, post } = handlers(catalog, co, () => llm)
      const first = await board()
      assert.equal(first.selected.mode, 'staged')
      const revision1 = first.selected.revision
      assert.match(revision1, /^[0-9a-f]{64}$/)

      // The user edits the preset after reviewing: the effective instructions
      // change while the provider/model route stays the same.
      co.updateSettings({
        checks: noopChecks,
        maxWorkers: co.maxWorkers,
        checkTimeoutMs: co.checkTimeoutMs,
        agents: { docs: { instructions: 'Docs v2.', provider: 'acme', model: 'fast-1' } },
      })
      const second = await board()
      const revision2 = second.selected.revision
      assert.notEqual(revision2, revision1, 'a preset edit changes the plan revision')
      assert.equal(second.selected.tickets[0].model, 'acme/fast-1', 'only the instructions moved')

      // Approving the revision the user saw must not start anything unseen.
      const stale = await post({ key: first.selected.key, action: 'approve', revision: revision1, choices: [{ id: 'A', agent: 'docs' }] })
      const staleText = await stale.text()
      assert.equal(stale.status, 409, staleText)
      assert.match(staleText, /plan changed/i)
      assert.equal((await co.status(q)).mode, 'staged', 'the run stays staged after the stale approval')
      assert.equal(resolved.length, 0, 'the stale approval never resolved a route')

      // Confirming the current revision approves and freezes the edited preset.
      const ok = await post({
        key: first.selected.key,
        action: 'approve',
        revision: revision2,
        choices: [{ id: 'A', agent: 'docs', provider: 'acme', model: 'fast-1', reasoningEffort: '' }],
      })
      const okText = await ok.text()
      assert.equal(ok.status, 200, okText)
      assert.equal((await co.status(q)).mode, 'active')
      // The approval froze the instructions it resolved from the edited preset.
      assert.equal(resolved.length, 1)
      assert.equal(resolved[0][0].agentSpec.instructions, 'Docs v2.')
      assert.deepEqual(
        { provider: resolved[0][0].agentSpec.provider, model: resolved[0][0].agentSpec.model },
        { provider: 'acme', model: 'fast-1' },
      )
    } finally {
      await co.close()
    }
  },
)

test(
  'each effective preset field (instructions, provider, model, reasoningEffort) moves the revision',
  { timeout: limit(60000) },
  async (t) => {
    const cwd = await repo(t)
    const catalog = new RunCatalog()
    const co = new Coordinator({
      checks: noopChecks,
      requireApproval: true,
      agents: { docs: { instructions: 'Docs v1.', provider: 'acme', model: 'fast-1' } },
      rememberRun: (...args) => catalog.remember(...args),
      launch: async () => {
        throw Error('unexpected launch')
      },
    })
    const q = { cwd, parentId: 'captain', runId: 'rev-fields' }
    const revisionFor = async (docs) => {
      co.updateSettings({ checks: noopChecks, maxWorkers: co.maxWorkers, checkTimeoutMs: co.checkTimeoutMs, agents: { docs } })
      return (await co.status(q)).revision
    }
    try {
      await co.start({ ...q, manifest: { spec_id: 'rev-fields', tickets: [{ ...ticket('A'), agent: 'docs' }] } })
      const base = await revisionFor({ instructions: 'Docs v1.', provider: 'acme', model: 'fast-1' })
      const instructions = await revisionFor({ instructions: 'Docs v2.', provider: 'acme', model: 'fast-1' })
      const provider = await revisionFor({ instructions: 'Docs v1.', provider: 'beta', model: 'fast-1' })
      const model = await revisionFor({ instructions: 'Docs v1.', provider: 'acme', model: 'deep-2' })
      const effort = await revisionFor({ instructions: 'Docs v1.', provider: 'acme', model: 'fast-1', reasoningEffort: 'high' })
      for (const [field, value] of Object.entries({ instructions, provider, model, effort }))
        assert.notEqual(value, base, field + ' is part of the plan revision')
      assert.equal(new Set([base, instructions, provider, model, effort]).size, 5, 'every field is distinct')
    } finally {
      await co.close()
    }
  },
)

test(
  'the detached dashboard read matches the coordinator revision, preset edits included',
  { timeout: limit(60000) },
  async (t) => {
    const cwd = await repo(t)
    const catalog = new RunCatalog()
    const co = new Coordinator({
      checks: noopChecks,
      requireApproval: true,
      agents: { docs: { instructions: 'Docs v1.', provider: 'acme', model: 'fast-1' } },
      rememberRun: (...args) => catalog.remember(...args),
      launch: async () => {
        throw Error('unexpected launch')
      },
    })
    const q = { cwd, parentId: 'captain', runId: 'read-parity' }
    // A dashboard with no run attached reads the ledger through readLedger, not
    // the coordinator snapshot: the revision must still match exactly.
    const cold = () => ({ maxWorkers: 16, agents: co.agents, runs: new Map(), peek: () => assert.fail('not attached') })
    try {
      await co.start({ ...q, manifest: { spec_id: 'read-parity', tickets: [{ ...ticket('A'), agent: 'docs' }] } })
      const [file] = co.runs.keys()
      const entry = catalog.entries().find((row) => row.file === file)
      const reviewBefore = catalog.read(cold(), entry.key).selected
      assert.equal(reviewBefore.attached, false)
      const liveBefore = await co.status(q)
      assert.equal(reviewBefore.revision, liveBefore.revision, 'detached dashboard and coordinator agree')

      co.updateSettings({
        checks: noopChecks,
        maxWorkers: 16,
        checkTimeoutMs: 20000,
        agents: { docs: { instructions: 'Docs v2.', provider: 'acme', model: 'fast-1' } },
      })
      const reviewAfter = catalog.read(cold(), entry.key).selected
      const liveAfter = await co.status(q)
      assert.equal(reviewAfter.revision, liveAfter.revision, 'still agree after the preset edit')
      assert.notEqual(reviewAfter.revision, reviewBefore.revision, 'both track the preset edit')
    } finally {
      await co.close()
    }
  },
)

test('RunStore.integrity() and the dashboard use one shared integrity read', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'dag-integrity-shared-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const file = join(root, 'state.sqlite')
  const db = new RunStore(file)
  try {
    db.init({
      runId: 'run-1',
      repo: { root: '/work', commonDir: '/work/.git' },
      ref: 'refs/heads/integration/run-1',
      baseSha: 'start',
      parentId: 'parent',
      policyHash: 'checks-hash',
      manifest: normalizeManifest({ spec_id: 'demo', tickets: [{ id: 'A', title: 'A', verify: ['verify'] }] }, noopChecks),
      mode: 'staged',
    })
    db.append(normalizeAppend([{ id: 'B', title: 'B', depends_on: ['A'], verify: ['verify'] }], noopChecks), { policyHash: 'p' })
    // A read-only connection is exactly what readLedger uses; the writer's
    // method and the dashboard query helper must return the same rows.
    const reader = new DatabaseSync(file, { readOnly: true })
    try {
      assert.deepEqual(readIntegrity(reader), db.integrity())
    } finally {
      reader.close()
    }
  } finally {
    db.close()
  }
})
