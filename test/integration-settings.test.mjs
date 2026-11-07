import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { test } from 'node:test'
import { INTEGRATION_MODES, integrationOf, normalizeManifest } from '../src/store.mjs'
import { runTiming } from '../src/timing.mjs'

// The host packages are peer dependencies; stub them as test/host.test.mjs does.
const stubs = new Map(
  Object.entries({
    '@deepseek-ai/dsh-tools': 'export const defineTool = value => value',
    '@deepseek-ai/dsh-llm': 'export const createUserMessage = value => value',
    '@deepseek-ai/schemastery': 'const schema = new Proxy({}, {get: () => () => schema}); export default schema',
  }),
)
const hook = registerHooks({
  resolve(specifier, context, next) {
    if (stubs.has(specifier) && context.parentURL?.endsWith('/src/index.mjs'))
      return { url: 'data:text/javascript,' + encodeURIComponent(stubs.get(specifier)), shortCircuit: true }
    return next(specifier, context)
  },
})
const { captainSection } = await import('../src/index.mjs')
hook.deregister()

const checks = { fast: [['node', '-e', '0']], slow: [['node', '-e', '1']], lint: [['node', '-e', '2']] }
const plan = (extra = {}) => ({
  spec_id: 'modes',
  tickets: [
    { id: 'A', title: 'A', verify: ['fast', 'slow'] },
    { id: 'B', title: 'B', verify: ['fast'] },
  ],
  ...extra,
})
const profileMeta = {
  fast: { files: ['**'], fast: true },
  slow: { files: ['src/**'], fast: false },
  // Not used by any ticket: ignored, not an error.
  lint: { files: ['**/*.js'], fast: true },
}

test('default settings keep the manifest JSON byte for byte', () => {
  const before = JSON.stringify(normalizeManifest(plan(), checks))
  for (const defaults of [
    {},
    { integrationMode: 'each', selectChecksByFiles: false, checkMeta: {} },
    { integrationMode: 'each', selectChecksByFiles: false },
  ])
    assert.equal(JSON.stringify(normalizeManifest(plan(), checks, {}, defaults)), before)
  assert.deepEqual(integrationOf(JSON.parse(before)), { mode: 'each', selectChecksByFiles: false })
  assert.deepEqual(integrationOf(undefined), { mode: 'each', selectChecksByFiles: false })
  // Metadata that only repeats the defaults (no files, not fast) changes nothing either.
  assert.equal(
    JSON.stringify(normalizeManifest(plan(), checks, {}, { checkMeta: { slow: { files: [], fast: false } } })),
    before,
  )
})

test('profile settings are frozen into the manifest, and the manifest wins field by field', () => {
  const m = normalizeManifest(plan(), checks, {}, { selectChecksByFiles: true, checkMeta: profileMeta })
  assert.deepEqual(m.integration, { mode: 'each', selectChecksByFiles: true })
  assert.deepEqual(m.checkMeta, {
    fast: { files: ['**'], fast: true },
    slow: { files: ['src/**'], fast: false },
  })
  // A stored manifest normalizes to itself under any later profile.
  assert.deepEqual(normalizeManifest(m, checks), m)
  assert.deepEqual(normalizeManifest(m, checks, {}, { selectChecksByFiles: false, checkMeta: {} }), m)

  const own = normalizeManifest(
    plan({
      integration: { select_checks_by_files: false },
      check_meta: { slow: { files: ['lib/**'] } },
    }),
    checks,
    {},
    { selectChecksByFiles: true, checkMeta: profileMeta },
  )
  assert.equal(Object.hasOwn(own, 'integration'), false, 'the manifest turned selection back off')
  assert.deepEqual(own.checkMeta.slow, { files: ['lib/**'], fast: false })
  assert.deepEqual(own.checkMeta.fast, { files: ['**'], fast: true })
  // camelCase is accepted as well.
  const camel = normalizeManifest(plan({ integration: { mode: 'each', selectChecksByFiles: true } }), checks)
  assert.deepEqual(camel.integration, { mode: 'each', selectChecksByFiles: true })
})

test('every mode is implemented in this build; malformed settings are refused', () => {
  assert.deepEqual(INTEGRATION_MODES, ['each', 'end', 'worker', 'worker-end', 'train'])
  // Since stage B every accepted mode runs; the not-implemented refusal stays for future modes.
  for (const mode of INTEGRATION_MODES) assert.equal(normalizeManifest(plan(), checks, {}, { integrationMode: mode }).tickets.length > 0, true)
  assert.throws(() => normalizeManifest(plan({ integration: { mode: 'fast' } }), checks), /must be one of/)
  assert.throws(() => normalizeManifest(plan({ integration: 'each' }), checks), /integration must be an object/)
  assert.throws(
    () => normalizeManifest(plan({ integration: { select_checks_by_files: 'yes' } }), checks),
    /must be a boolean/,
  )
  assert.throws(() => normalizeManifest(plan({ check_meta: { lint: { files: ['**'] } } }), checks), /no ticket verifies/)
  assert.throws(() => normalizeManifest(plan({ check_meta: { ghost: {} } }), checks), /no ticket verifies/)
  assert.throws(() => normalizeManifest(plan({ check_meta: { slow: { files: 'src/**' } } }), checks), /must be an array/)
  assert.throws(() => normalizeManifest(plan({ check_meta: { slow: { files: [''] } } }), checks), /non-empty text/)
  assert.throws(() => normalizeManifest(plan({ check_meta: { slow: { files: ['a', 'a'] } } }), checks), /duplicate/)
  assert.throws(() => normalizeManifest(plan({ check_meta: { slow: { fast: 1 } } }), checks), /fast must be a boolean/)
  assert.throws(() => normalizeManifest(plan(), checks, {}, { checkMeta: { slow: { fast: 'no' } } }), /fast must be a boolean/)
})

test('the captain hears about a non-default integration mode in one sentence', () => {
  const base = { checks: {}, agents: {}, checkTimeoutMs: 120000, maxWorkers: 16 }
  assert.doesNotMatch(captainSection(base), /Integration mode/)
  assert.doesNotMatch(captainSection({ ...base, integrationMode: 'each', selectChecksByFiles: false }), /Integration mode/)
  const on = captainSection({ ...base, integrationMode: 'each', selectChecksByFiles: true })
  assert.match(on, /Integration mode: each, with checks selected by changed files/)
  assert.match(on, /check_meta/)
})

test('the captain hears what the worker modes do', () => {
  const base = { checks: {}, agents: {}, checkTimeoutMs: 120000, maxWorkers: 16 }
  const worker = captainSection({ ...base, integrationMode: 'worker' })
  assert.match(worker, /Integration mode: worker\. Each submitted commit is checked by the coordinator/)
  assert.match(worker, /runs every check again when the integration branch moved/)
  assert.doesNotMatch(worker, /bisected/)
  const end = captainSection({ ...base, integrationMode: 'worker-end' })
  assert.match(end, /never from the worker report/)
  assert.match(end, /bisected to one ticket/)
})

const rows = (list) =>
  list.map(([createdAt, type, ticketId = null, details = {}]) => ({ type, ticketId, attempt: null, createdAt, details }))

test('timing counts run-level checks, skipped checks and the stage split', () => {
  const timing = runTiming(
    rows([
      [0, 'run_started', null, { mode: 'active' }],
      [10, 'claimed', 'A'],
      [20, 'submitted', 'A'],
      [25, 'checks_selected', 'A', { stage: 'lane', run: ['fast'], skipped: ['slow', 'lint'], fallback: null, changed: 1 }],
      [30, 'verify_started', 'A', { checks: ['fast'] }],
      [40, 'check_finished', 'A', { checkId: 'fast', ms: 10, ok: true }],
      [41, 'check_finished', 'A', { checkId: 'fast', ms: 7, ok: true, stage: 'worker' }],
      [50, 'integrated', 'A'],
      [60, 'checks_selected', null, { stage: 'final', run: ['slow'], skipped: [], fallback: 'no-diff', changed: null }],
      [70, 'check_finished', null, { checkId: 'slow', ms: 100, ok: false, stage: 'final' }],
      [80, 'check_finished', null, { checkId: 'slow', ms: 50, ok: true, stage: 'bisect' }],
      [85, 'check_finished', null, { checkId: 'slow', ms: 5, ok: false, aborted: true, stage: 'train' }],
      [90, 'run_completed'],
    ]),
    1000,
  )
  assert.equal(timing.totals.checkRuns, 5)
  assert.equal(timing.totals.checkFailures, 1)
  assert.equal(timing.totals.verifyMs, 10 + 7 + 100 + 50 + 5)
  assert.equal(timing.totals.skippedChecks, 2)
  assert.equal(timing.totals.finalVerifyMs, 150)
  assert.equal(timing.totals.workerVerifyMs, 7)
  // Run-level checks belong to no ticket.
  assert.equal(timing.tickets.A.verifyMs, 17)
  assert.deepEqual(Object.keys(timing.tickets), ['A'])
})

test('a ledger that cannot split verification keeps verifyMs unknown even with run-level checks', () => {
  const timing = runTiming(
    rows([
      [0, 'run_started', null, { mode: 'active' }],
      [10, 'claimed', 'A'],
      [20, 'integrated', 'A'],
      [30, 'check_finished', null, { checkId: 'slow', ms: 100, ok: true, stage: 'final' }],
    ]),
    1000,
  )
  assert.equal(timing.totals.verifyMs, null)
  assert.equal(timing.totals.checkRuns, 1)
  assert.equal(timing.totals.finalVerifyMs, 100)
})
