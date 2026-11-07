import { createHash, randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/**
 * The raw ledger arrays that decide what a plan approves: the run row, every
 * ticket definition, the dependency edges, the dag_add batches and the approval
 * records. Kept in one place so the coordinator's ledger digest, the plan
 * revision and the read-only dashboard all hash the same rows.
 */
export function ledgerSnapshot({ run, tickets, dependencies, appended, approvals }) {
  return {
    run: [run.runId, run.repo, run.ref, run.baseSha, run.parentId, run.policyHash, run.manifest],
    tickets: tickets.map((t) => [t.id, t.position, t.definition]),
    dependencies: dependencies.map((d) => [d.ticketId, d.upstream]),
    appended: appended.map((a) => [a.ticketId, a.batch, a.definition, a.policyHash, a.createdAt]),
    approvals: approvals.map((a) => a.details),
  }
}

// The preset fields approval resolves for a ticket right now: the preset named
// by its definition, resolved from the live settings, or the copy frozen at
// dag_run when that preset has since been removed (approve's own fallback). A
// settings edit that changes any of these must change the plan revision, so a
// review of the old preset cannot be approved as if nothing changed.
function effectivePreset(ticket, agents) {
  let definition = ticket?.definition
  if (typeof definition === 'string') {
    try {
      definition = JSON.parse(definition)
    } catch {
      return null
    }
  }
  const agent = definition?.agent
  if (typeof agent !== 'string' || !agent) return null
  if (agents && Object.hasOwn(agents, agent)) return agentSpec(agents, agent)
  const frozen = definition.agentSpec
  return frozen && typeof frozen === 'object' && !Array.isArray(frozen) ? frozen : {}
}

/**
 * The opaque revision the plan review carries for a staged run. It covers every
 * ledger field that decides what the user is approving: each ticket definition,
 * the effective preset fields approval would freeze for that ticket now, the
 * dependency edges, the dag_add batches and their frozen commands, the
 * submission (manifest, which holds the command registry) and the approval
 * records. A stale approval names an older revision.
 *
 * Both the live coordinator (RunStore.revision) and the read-only dashboard
 * (readLedger) build the same digest from raw ledger rows so a refresh shows the
 * exact revision the coordinator checks in its serial region.
 */
export function planRevision({ run, tickets, dependencies, appended, approvals, agents = {} }) {
  const snapshot = ledgerSnapshot({ run, tickets, dependencies, appended, approvals })
  return createHash('sha256')
    .update(
      JSON.stringify([
        run.mode,
        snapshot.run,
        tickets.map((t, i) => [...snapshot.tickets[i], effectivePreset(t, agents)]),
        snapshot.dependencies,
        snapshot.appended,
        snapshot.approvals,
      ]),
    )
    .digest('hex')
}

/**
 * Run the ledger integrity queries against any open connection, so the writer
 * (RunStore.integrity) and the read-only dashboard (readLedger) read the same
 * rows instead of keeping two copies that can drift.
 */
export function readIntegrity(db) {
  const hasAppended = Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='appended'").get(),
  )
  return {
    run: db
      .prepare('SELECT runId,repo,ref,baseSha,manifest,parentId,policyHash,mode FROM run WHERE singleton=1')
      .get(),
    tickets: db.prepare('SELECT id,position,definition FROM tickets ORDER BY position').all(),
    dependencies: db.prepare('SELECT ticketId,upstream FROM dependencies ORDER BY ticketId,upstream').all(),
    appended: hasAppended
      ? db.prepare('SELECT ticketId,batch,definition,policyHash,createdAt FROM appended ORDER BY batch,rowid').all()
      : [],
    approvals: db.prepare("SELECT details FROM events WHERE type='run_approved' ORDER BY rowid").all(),
  }
}

const STATUSES = [
  'PENDING',
  'RUNNING',
  'SUBMITTED',
  'PUBLISHING',
  'INTEGRATED',
  'NEEDS_ATTENTION',
  'CANCELLED',
]
const STATES_SQL = STATUSES.map((s) => "'" + s + "'").join(', ')
// staged: created but waiting for the user's approval; nothing is dispatched.
const MODES = new Set(['staged', 'active', 'paused', 'cancelled'])
const EDITABLE = new Set(['sourceSha', 'landedSha', 'message', 'childId', 'path', 'branch', 'baseSha'])
// claim, retry, intent and finish have additional invariants. Those transitions
// are not available through the generic CAS.
const MOVES = {
  PENDING: ['NEEDS_ATTENTION', 'CANCELLED'],
  RUNNING: ['PENDING', 'SUBMITTED', 'NEEDS_ATTENTION', 'CANCELLED'],
  SUBMITTED: ['NEEDS_ATTENTION', 'CANCELLED'],
  PUBLISHING: ['SUBMITTED', 'NEEDS_ATTENTION'],
  NEEDS_ATTENTION: ['SUBMITTED', 'CANCELLED'],
}

function record(value, field) {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError(field + ' must be an object')
  return value
}

function text(value, field) {
  if (typeof value !== 'string' || value.trim() === '' || value.includes('\0'))
    throw new TypeError(field + ' must be non-empty text')
  return value
}

function safeId(value, field) {
  if (
    typeof value !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/.test(value) ||
    value.includes('..') ||
    value.endsWith('.') ||
    value.toLowerCase().endsWith('.lock') ||
    /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:[.]|$)/i.test(value)
  ) {
    throw new TypeError(field + ' is not a safe ID')
  }
  return value
}

function gitRef(value) {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(value) ||
    value.includes('..') ||
    (value.startsWith('refs/') && !value.startsWith('refs/heads/')) ||
    value
      .split('/')
      .some(
        (part) => !part || part.startsWith('.') || part.endsWith('.') || part.toLowerCase().endsWith('.lock'),
      )
  ) {
    throw new TypeError('baseRef must be a branch/ref name or commit ID')
  }
  return value
}

function strings(value, field, validator = text) {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new TypeError(field + ' must be an array')
  const list = value.map((item) => validator(item, field))
  if (new Set(list).size !== list.length) throw new TypeError(field + ' has duplicate entries')
  return list
}

function commandExists(registry, name) {
  if (!Object.hasOwn(registry, name)) throw new TypeError('unknown verification check: ' + name)
  argvList(registry[name], name)
}

function argvList(commands, name) {
  if (
    !Array.isArray(commands) ||
    commands.length === 0 ||
    commands.some(
      (argv) =>
        !Array.isArray(argv) ||
        !argv.length ||
        typeof argv[0] !== 'string' ||
        !argv[0].trim() ||
        argv.some((arg) => typeof arg !== 'string' || arg.includes('\0')),
    )
  ) {
    throw new TypeError('check registry entry must be a non-empty list of argv arrays: ' + name)
  }
}

// The resolved preset is stored with the ticket, so later profile edits cannot
// change a run's instructions or model route. Empty fields are omitted.
export function agentSpec(registry, name) {
  if (!Object.hasOwn(registry, name)) throw new TypeError('unknown agent preset: ' + name)
  const preset = record(registry[name], 'agent preset ' + name)
  const spec = {}
  for (const field of ['instructions', 'provider', 'model', 'reasoningEffort']) {
    const value = preset[field] ?? ''
    if (typeof value !== 'string') throw new TypeError('agent preset ' + name + '.' + field + ' must be a string')
    if (value.trim()) spec[field] = value.trim()
  }
  if ((spec.provider || spec.reasoningEffort) && !spec.model)
    throw new TypeError('agent preset ' + name + ' sets a provider or reasoning effort without a model')
  return spec
}

// Where dag_import found the ticket; a GitHub source lets the run report back
// on that issue. Only these exact shapes are kept.
function trackerSource(value, field) {
  record(value, field)
  if (value.kind === 'github') {
    if (typeof value.repo !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value.repo))
      throw new TypeError(field + '.repo must look like owner/name')
    if (!Number.isSafeInteger(value.number) || value.number < 1)
      throw new TypeError(field + '.number must be an issue number')
    const source = { kind: 'github', repo: value.repo, number: value.number }
    if (value.url !== undefined) source.url = text(value.url, field + '.url')
    return source
  }
  if (value.kind === 'local') return { kind: 'local', path: text(value.path, field + '.path') }
  throw new TypeError(field + '.kind must be github or local')
}

// Each ticket's own fields; IDs must differ case-insensitively within the list.
function normalizeTickets(list, checkRegistry, agentRegistry) {
  if (!Array.isArray(list) || !list.length) throw new TypeError('tickets must be a non-empty array')
  const filesystemNames = new Set()
  return list.map((raw) => {
    record(raw, 'ticket')
    const id = safeId(raw.id, 'ticket ID')
    if (filesystemNames.has(id.toLowerCase()))
      throw new TypeError('duplicate ticket ID (case-insensitive): ' + id)
    filesystemNames.add(id.toLowerCase())
    if (raw.kind !== undefined && !['code', 'coding', 'implementation', 'work'].includes(raw.kind)) {
      throw new TypeError(
        id + ': unsupported ticket kind ' + raw.kind + ' (only Git coding tickets are supported)',
      )
    }
    const title = text(raw.title, id + '.title')
    const prompt = text(raw.prompt ?? raw.description ?? title, id + '.prompt')
    const dependsOn = strings(raw.dependsOn ?? raw.depends_on, id + '.dependsOn', safeId)
    // Optional: an empty list means no check of the ticket's own; checks of tickets
    // already integrated still run on its candidate.
    const verify = strings(raw.verify, id + '.verify', safeId)
    verify.forEach((name) => commandExists(checkRegistry, name))
    const acceptance = strings(raw.acceptance, id + '.acceptance')
    const ticket = { id, title, prompt, dependsOn, verify, acceptance }
    if (raw.kind !== undefined) ticket.kind = raw.kind
    if (raw.produces !== undefined) ticket.produces = strings(raw.produces, id + '.produces')
    if (raw.consumes !== undefined) ticket.consumes = strings(raw.consumes, id + '.consumes')
    if (raw.agent !== undefined) {
      ticket.agent = safeId(raw.agent, id + '.agent')
      ticket.agentSpec = agentSpec(agentRegistry, ticket.agent)
    }
    if (raw.source !== undefined) ticket.source = trackerSource(raw.source, id + '.source')
    return ticket
  })
}

// Dependencies must name listed tickets without a cycle, and every consumed
// artifact must come from a transitive dependency or an external input.
function checkGraph(tickets, externalInputs) {
  const byId = new Map(tickets.map((t) => [t.id, t]))
  const downstream = new Map(tickets.map((t) => [t.id, []]))
  const remaining = new Map(tickets.map((t) => [t.id, t.dependsOn.length]))
  for (const ticket of tickets) {
    for (const dep of ticket.dependsOn) {
      if (!byId.has(dep)) throw new TypeError(ticket.id + ': unknown dependency ' + dep)
      downstream.get(dep).push(ticket.id)
    }
  }
  // A topological walk also carries the transitive set of declared artifacts.
  const ready = tickets.filter((t) => !t.dependsOn.length).map((t) => t.id)
  const availableAt = new Map()
  for (let index = 0; index < ready.length; index++) {
    const id = ready[index]
    const ticket = byId.get(id)
    const available = new Set(externalInputs)
    for (const dep of ticket.dependsOn) for (const artifact of availableAt.get(dep)) available.add(artifact)
    for (const artifact of ticket.consumes ?? []) {
      if (!available.has(artifact))
        throw new TypeError(id + ': no declared dependency or external input produces ' + artifact)
    }
    for (const artifact of ticket.produces ?? []) available.add(artifact)
    availableAt.set(id, available)
    for (const next of downstream.get(id)) {
      const count = remaining.get(next) - 1
      remaining.set(next, count)
      if (count === 0) ready.push(next)
    }
  }
  if (ready.length !== tickets.length) throw new TypeError('ticket dependency cycle')
}

/**
 * Latest worker_verify_finished per ticket, without the output tail. Shared by
 * RunStore and the read-only dashboard so both show the same result.
 * @param db - an open DatabaseSync on a run ledger.
 */
export function latestWorkerResults(db) {
  const out = new Map()
  for (const row of db
    .prepare("SELECT ticketId,details FROM events WHERE type='worker_verify_finished' AND ticketId IS NOT NULL ORDER BY rowid")
    .all()) {
    const { sourceSha, coveredTip, ok, failed } = JSON.parse(row.details)
    out.set(row.ticketId, { sourceSha, coveredTip: coveredTip ?? null, ok: ok === true, failed: failed ?? [] })
  }
  return out
}

/** Every integration mode the profile and manifest accept; the set is fixed so configs stay valid across builds. */
export const INTEGRATION_MODES = Object.freeze(['each', 'end', 'worker', 'worker-end', 'train'])
/** The modes this build can run; the rest are refused at dag_run instead of silently running as each. */
export const IMPLEMENTED_MODES = Object.freeze(new Set(['each', 'end', 'worker', 'worker-end', 'train']))
/** Modes whose lane runs only fast checks and whose run completes after one final full check. */
export const END_MODES = Object.freeze(new Set(['end', 'worker-end']))
/** Modes that check each submitted commit in a probe, in parallel and outside the integration lane. */
export const WORKER_MODES = Object.freeze(new Set(['worker', 'worker-end']))
const defaultFinalRepairs = 2
const defaultTrainSize = 4

/**
 * The integration settings a run froze into its manifest. A manifest without
 * the field (every run from before 0.16, and every default run) is each with
 * file selection off.
 */
export function integrationOf(manifest) {
  const frozen = manifest?.integration
  return {
    mode: typeof frozen?.mode === 'string' ? frozen.mode : 'each',
    selectChecksByFiles: frozen?.selectChecksByFiles === true,
  }
}

/** How many fix tickets a failed final check may append automatically; only end modes freeze it. */
export function maxFinalRepairsOf(manifest) {
  const value = manifest?.integration?.maxFinalRepairs
  return Number.isSafeInteger(value) && value >= 0 ? value : defaultFinalRepairs
}

/** How many submitted tickets one merge train takes at most; only train freezes it. */
export function trainSizeOf(manifest) {
  const value = manifest?.integration?.trainSize
  return Number.isSafeInteger(value) && value >= 1 ? value : defaultTrainSize
}

function integrationMode(value, field) {
  if (!INTEGRATION_MODES.includes(value))
    throw new TypeError(field + ' must be one of ' + INTEGRATION_MODES.join(', '))
  if (!IMPLEMENTED_MODES.has(value))
    throw new TypeError('integration mode ' + value + ' is not implemented in this build')
  return value
}

function normalizeIntegration(raw, defaults) {
  if (raw !== undefined) record(raw, 'integration')
  const mode = integrationMode(raw?.mode ?? defaults.integrationMode ?? 'each', 'integration.mode')
  const select = raw?.select_checks_by_files ?? raw?.selectChecksByFiles ?? defaults.selectChecksByFiles ?? false
  if (typeof select !== 'boolean') throw new TypeError('integration.select_checks_by_files must be a boolean')
  if (mode === 'train') {
    const size = raw?.train_size ?? raw?.trainSize ?? defaults.trainSize ?? defaultTrainSize
    if (!Number.isSafeInteger(size) || size < 2 || size > 16)
      throw new RangeError('integration.train_size must be an integer between 2 and 16')
    return { mode, selectChecksByFiles: select, trainSize: size }
  }
  if (!END_MODES.has(mode)) return { mode, selectChecksByFiles: select }
  const repairs = raw?.max_final_repairs ?? raw?.maxFinalRepairs ?? defaults.maxFinalRepairs ?? defaultFinalRepairs
  if (!Number.isSafeInteger(repairs) || repairs < 0 || repairs > 10)
    throw new RangeError('integration.max_final_repairs must be an integer between 0 and 10')
  return { mode, selectChecksByFiles: select, maxFinalRepairs: repairs }
}

function metaEntry(value, field) {
  record(value, field)
  const entry = {}
  if (value.files !== undefined) entry.files = strings(value.files, field + '.files')
  if (value.fast !== undefined) {
    if (typeof value.fast !== 'boolean') throw new TypeError(field + '.fast must be a boolean')
    entry.fast = value.fast
  }
  return entry
}

// Metadata for the check IDs the tickets use: the profile's as the base, the
// manifest's field by field on top. A manifest entry for an unused or unknown
// ID is an error (the captain wrote it); a profile entry for one is ignored.
function normalizeCheckMeta(raw, profile, used) {
  const merged = {}
  if (profile !== undefined && profile !== null) {
    record(profile, 'checkMeta')
    for (const id of Object.keys(profile))
      if (used.has(id)) merged[id] = metaEntry(profile[id], 'checkMeta.' + id)
  }
  if (raw !== undefined) {
    record(raw, 'check_meta')
    for (const id of Object.keys(raw)) {
      if (!used.has(id)) throw new TypeError('check_meta names ' + id + ', which no ticket verifies')
      merged[id] = { ...merged[id], ...metaEntry(raw[id], 'check_meta.' + id) }
    }
  }
  const out = {}
  // Ticket order keeps the stored JSON stable for the same plan.
  for (const id of used) {
    const entry = merged[id]
    if (!entry) continue
    const files = entry.files ?? []
    const fast = entry.fast ?? false
    if (files.length || fast) out[id] = { files, fast }
  }
  return out
}

/**
 * Accept the spec author's snake_case or the stored camelCase representation.
 * defaults carries the profile's integrationMode, selectChecksByFiles and
 * checkMeta; the manifest's own integration / check_meta win over them.
 */
export function normalizeManifest(input, checkRegistry = {}, agentRegistry = {}, defaults = {}) {
  record(input, 'manifest')
  record(checkRegistry, 'checkRegistry')
  record(agentRegistry, 'agentRegistry')
  record(defaults, 'defaults')
  const specId = safeId(input.specId ?? input.spec_id, 'specId')
  const baseRef = gitRef(input.baseRef ?? input.base_ref ?? 'main')
  const maxWorkers = input.maxWorkers ?? input.max_workers ?? 16
  if (!Number.isInteger(maxWorkers) || maxWorkers < 1 || maxWorkers > 32)
    throw new RangeError('maxWorkers must be an integer between 1 and 32')
  if (!Array.isArray(input.tickets) || !input.tickets.length)
    throw new TypeError('tickets must be a non-empty array')
  const externalInputs = strings(input.externalInputs ?? input.external_inputs, 'externalInputs')
  const checks = planChecks(input.checks, checkRegistry)
  const tickets = normalizeTickets(input.tickets, { ...checkRegistry, ...checks }, agentRegistry)
  checkGraph(tickets, externalInputs)
  const integration = normalizeIntegration(input.integration, defaults)
  const used = new Set(tickets.flatMap((t) => t.verify))
  const checkMeta = normalizeCheckMeta(input.check_meta ?? input.checkMeta, defaults.checkMeta, used)
  // Both fields are written only when they change something, so a default
  // manifest keeps the exact JSON (and run identity) of earlier versions.
  return {
    specId,
    baseRef,
    maxWorkers,
    tickets,
    ...(externalInputs.length ? { externalInputs } : {}),
    ...(Object.keys(checks).length ? { checks } : {}),
    ...(integration.mode !== 'each' || integration.selectChecksByFiles ? { integration } : {}),
    ...(Object.keys(checkMeta).length ? { checkMeta } : {}),
  }
}

const planCheckLimit = 20
const planCommandLimit = 10
const planArgLimit = 4096

/**
 * Checks the captain writes into the manifest: { id: [argv, ...] }. They run
 * only after the user approves the plan, and may not reuse a profile check ID,
 * so a ticket's verify ID names exactly one command list.
 */
function planChecks(value, profileChecks) {
  if (value === undefined) return {}
  record(value, 'checks')
  const ids = Object.keys(value)
  if (ids.length > planCheckLimit) throw new RangeError('checks takes at most ' + planCheckLimit + ' IDs')
  const checks = {}
  for (const id of ids) {
    safeId(id, 'check ID')
    if (Object.hasOwn(profileChecks, id))
      throw new TypeError('check ' + id + ' is already a profile check; use it by ID or pick another ID')
    argvList(value[id], id)
    if (value[id].length > planCommandLimit)
      throw new RangeError('check ' + id + ' takes at most ' + planCommandLimit + ' commands')
    if (value[id].some((argv) => argv.some((arg) => arg.length > planArgLimit)))
      throw new RangeError('check ' + id + ' has an argument longer than ' + planArgLimit + ' characters')
    checks[id] = value[id].map((argv) => [...argv])
  }
  return checks
}

/**
 * The tickets of one dag_add batch, by the manifest's per-ticket rules. Their
 * dependencies are checked against the run by RunStore.append.
 */
export function normalizeAppend(input, checkRegistry = {}, agentRegistry = {}) {
  record(checkRegistry, 'checkRegistry')
  record(agentRegistry, 'agentRegistry')
  return normalizeTickets(input, checkRegistry, agentRegistry)
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS run (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1), runId TEXT NOT NULL,
    repo TEXT NOT NULL, ref TEXT NOT NULL, baseSha TEXT NOT NULL,
    manifest TEXT NOT NULL, parentId TEXT NOT NULL, policyHash TEXT NOT NULL, tipSha TEXT NOT NULL,
    mode TEXT NOT NULL CHECK(mode IN ('staged', 'active', 'paused', 'cancelled')), diagnostic TEXT
  );
  CREATE TABLE IF NOT EXISTS tickets (
    id TEXT PRIMARY KEY, definition TEXT NOT NULL, position INTEGER NOT NULL UNIQUE,
    status TEXT NOT NULL CHECK(status IN (${STATES_SQL})), attempt INTEGER NOT NULL DEFAULT 0,
    lease TEXT, baseSha TEXT, sourceSha TEXT, landedSha TEXT, childId TEXT, path TEXT, branch TEXT, message TEXT,
    retryAt INTEGER NOT NULL DEFAULT 0 CHECK(retryAt >= 0), autoRetries INTEGER NOT NULL DEFAULT 0 CHECK(autoRetries >= 0),
    cleanup TEXT CHECK(cleanup IN ('cleaned', 'skipped')), cleanupReason TEXT
  );
  CREATE TABLE IF NOT EXISTS dependencies (
    ticketId TEXT NOT NULL REFERENCES tickets(id), upstream TEXT NOT NULL REFERENCES tickets(id),
    PRIMARY KEY(ticketId, upstream)
  );
  CREATE TABLE IF NOT EXISTS retired_resources (
    kind TEXT NOT NULL CHECK(kind IN ('path','branch','childId')), value TEXT NOT NULL,
    PRIMARY KEY (kind,value)
  );
  CREATE TABLE IF NOT EXISTS intents (
    ticketId TEXT PRIMARY KEY REFERENCES tickets(id), lease TEXT NOT NULL, oldTip TEXT NOT NULL,
    sourceSha TEXT NOT NULL, candidateSha TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS events (
    id TEXT NOT NULL UNIQUE, type TEXT NOT NULL, ticketId TEXT, attempt INTEGER,
    message TEXT NOT NULL, details TEXT NOT NULL, createdAt INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS outbox (
    eventId TEXT PRIMARY KEY REFERENCES events(id), parentId TEXT NOT NULL, acknowledgedAt INTEGER
  );
  CREATE TABLE IF NOT EXISTS appended (
    ticketId TEXT PRIMARY KEY REFERENCES tickets(id), batch INTEGER NOT NULL CHECK(batch >= 1),
    definition TEXT NOT NULL, policyHash TEXT NOT NULL, createdAt INTEGER NOT NULL
  );
`

// A retired checkout can still host a writer whose exit could not be proven.
// Keep the keys conservative across case-insensitive workspaces and Git refs.
function resourceKeys({ path, branch, childId }) {
  return [
    ['path', path == null ? null : resolve(path).toLowerCase()],
    ['branch', branch == null ? null : branch.replace(/^refs\/heads\//, '').toLowerCase()],
    ['childId', childId],
  ].filter(([, value]) => value != null)
}

function ticketRow(row) {
  if (!row) return null
  const { definition, position, ...runtime } = row
  return { ...JSON.parse(definition), ...runtime }
}

function eventRow(row) {
  return { ...row, eventId: row.id, details: JSON.parse(row.details) }
}

export class RunStore {
  #db

  constructor(dbPath) {
    this.#db = new DatabaseSync(dbPath)
    try {
      this.#db.exec(
        'PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;',
      )
      this.#db.exec(SCHEMA)
      // Ledgers from before worktree cleanup lack its columns: NULL reads as not cleaned.
      const columns = new Set(this.#db.prepare('PRAGMA table_info(tickets)').all().map((c) => c.name))
      if (!columns.has('cleanup'))
        this.#db.exec("ALTER TABLE tickets ADD COLUMN cleanup TEXT CHECK(cleanup IN ('cleaned', 'skipped'))")
      if (!columns.has('cleanupReason')) this.#db.exec('ALTER TABLE tickets ADD COLUMN cleanupReason TEXT')
    } catch (error) {
      this.#db.close()
      throw error
    }
  }

  #transaction(work) {
    this.#db.exec('BEGIN IMMEDIATE')
    try {
      const value = work()
      this.#db.exec('COMMIT')
      return value
    } catch (error) {
      this.#db.exec('ROLLBACK')
      throw error
    }
  }

  #event(type, ticket, message, details = {}, notify = false) {
    const id = randomUUID()
    this.#db
      .prepare('INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(
        id,
        type,
        ticket?.id ?? null,
        ticket?.attempt ?? null,
        message,
        JSON.stringify(details),
        Date.now(),
      )
    if (notify)
      this.#db
        .prepare('INSERT INTO outbox(eventId,parentId) SELECT ?,parentId FROM run WHERE singleton=1')
        .run(id)
  }

  init({ runId, repo, ref, baseSha, manifest, parentId, policyHash, mode = 'active' }) {
    if (mode !== 'active' && mode !== 'staged') throw new TypeError('a run starts active or staged')
    safeId(runId, 'runId')
    text(repo?.root, 'repo.root')
    text(repo?.commonDir, 'repo.commonDir')
    text(ref, 'ref')
    text(baseSha, 'baseSha')
    text(parentId, 'parentId')
    text(policyHash, 'policyHash')
    return this.#transaction(() => {
      if (this.meta()) throw new Error('run already initialized')
      this.#db
        .prepare('INSERT INTO run VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)')
        .run(
          runId,
          JSON.stringify({ root: repo.root, commonDir: repo.commonDir }),
          ref,
          baseSha,
          JSON.stringify(manifest),
          parentId,
          policyHash,
          baseSha,
          mode,
        )
      const insert = this.#db.prepare(
        "INSERT INTO tickets(id, definition, position, status) VALUES (?, ?, ?, 'PENDING')",
      )
      const edge = this.#db.prepare('INSERT INTO dependencies(ticketId, upstream) VALUES (?, ?)')
      manifest.tickets.forEach((t, i) => insert.run(t.id, JSON.stringify(t), i))
      for (const t of manifest.tickets) for (const upstream of t.dependsOn) edge.run(t.id, upstream)
      // The mode tells timing whether this start waits for an approval.
      this.#event('run_started', null, 'Run started', { ref, baseSha, mode })
      return this.meta()
    })
  }

  meta() {
    const row = this.#db
      .prepare(
        'SELECT runId,repo,ref,baseSha,manifest,parentId,policyHash,tipSha,mode,diagnostic FROM run WHERE singleton=1',
      )
      .get()
    return row ? { ...row, repo: JSON.parse(row.repo), manifest: JSON.parse(row.manifest) } : null
  }

  setMode(mode) {
    if (!MODES.has(mode)) throw new TypeError('invalid run mode: ' + mode)
    return this.#transaction(() => {
      const run = this.meta()
      if (!run || run.mode === mode || run.mode === 'cancelled') return false
      // Leaving staged other than by cancel requires approve().
      if (run.mode === 'staged' && mode !== 'cancelled') return false
      if (mode === 'staged') return false
      this.#db
        .prepare(
          "UPDATE run SET mode=?, diagnostic=CASE WHEN ?='active' THEN NULL ELSE diagnostic END WHERE singleton=1",
        )
        .run(mode, mode)
      if (mode === 'cancelled') {
        // A running child may still be writing. A publisher may already have
        // executed Git CAS. Their coordinators settle those records explicitly.
        const unstarted = this.#db
          .prepare("SELECT * FROM tickets WHERE status IN ('PENDING', 'SUBMITTED') ORDER BY position")
          .all()
        this.#db
          .prepare("UPDATE tickets SET status='CANCELLED' WHERE status IN ('PENDING', 'SUBMITTED')")
          .run()
        for (const old of unstarted)
          this.#event('cancelled', old, 'Run cancelled', { from: old.status, lease: old.lease })
      }
      this.#event('run_' + mode, null, 'Run ' + mode, {}, mode === 'cancelled')
      return true
    })
  }

  /**
   * Stop dispatch and record a diagnostic.
   * @param message - the diagnostic shown to the captain and the board.
   * @param options.staged - return the run to staged: the user never approved it.
   * @returns true when the run was held.
   */
  hold(message, { staged = false } = {}) {
    text(message, 'diagnostic')
    return this.#transaction(() => {
      const run = this.meta()
      if (!run || (run.mode !== 'active' && run.diagnostic === message)) return false
      // A staged run keeps waiting for approval and a cancelled run stays final;
      // both only record the diagnostic.
      this.#db
        .prepare(
          "UPDATE run SET mode=CASE WHEN mode='cancelled' THEN 'cancelled' WHEN mode='staged' OR ? THEN 'staged' ELSE 'paused' END,diagnostic=? WHERE singleton=1",
        )
        .run(staged ? 1 : 0, message)
      this.#event('run_blocked', null, message, { previousMode: run.mode }, true)
      return true
    })
  }

  /** The caller has settled what the diagnostic reported. Its run_blocked event stays in the log. */
  clearDiagnostic() {
    return this.#transaction(() => {
      this.#db.prepare('UPDATE run SET diagnostic=NULL WHERE singleton=1').run()
      return true
    })
  }

  /**
   * Leave staged for active with the user's per-ticket choices. Each ticket
   * definition row takes the given agent/agentSpec in one transaction, before
   * any ticket can be claimed. The run manifest keeps the submitted plan, so
   * dag_run with the original manifest stays idempotent; dispatch, snapshots
   * and the board read the approved ticket definitions.
   * @param tickets - every ticket definition of the run, with its approved agent fields.
   * @returns true when the run was staged and is now active.
   */
  approve(tickets, { maxWorkers } = {}) {
    if (maxWorkers !== undefined && (!Number.isInteger(maxWorkers) || maxWorkers < 1 || maxWorkers > 32))
      throw new TypeError('maxWorkers must be an integer from 1 to 32')
    return this.#transaction(() => {
      const run = this.meta()
      const plan = run ? this.plan() : []
      const ids = plan.map((t) => t.id)
      if (tickets.length !== ids.length || tickets.some((t, i) => t?.id !== ids[i]))
        throw new TypeError('approval must list the run ticket set in order')
      if (run.mode !== 'staged') return false
      const approved = plan.map((old, i) => {
        const { agent, agentSpec, ...rest } = old
        const next = { ...rest }
        if (tickets[i].agent !== undefined) next.agent = safeId(tickets[i].agent, old.id + '.agent')
        if (tickets[i].agentSpec !== undefined) next.agentSpec = record(tickets[i].agentSpec, old.id + '.agentSpec')
        return next
      })
      const update = this.#db.prepare('UPDATE tickets SET definition=? WHERE id=?')
      for (const t of approved) update.run(JSON.stringify(t), t.id)
      this.#db.prepare("UPDATE run SET mode='active', diagnostic=NULL WHERE singleton=1").run()
      // The review shows every manifest check, so approval covers each of them.
      // An approval without this record predates that and covers none on its own.
      // maxWorkers, when the user chose one, is the concurrency cap for this run.
      const planChecks = Object.keys(run.manifest.checks ?? {})
      const details = maxWorkers === undefined ? { planChecks } : { planChecks, maxWorkers }
      this.#event('run_approved', null, 'Plan approved by the user; dispatch started', details, true)
      return true
    })
  }

  /** How many tickets may run at once: the user's choice at approval, else the manifest's. */
  workerLimit() {
    const row = this.#db
      .prepare("SELECT details FROM events WHERE type='run_approved' ORDER BY rowid DESC LIMIT 1")
      .get()
    const chosen = row ? JSON.parse(row.details).maxWorkers : undefined
    return Number.isInteger(chosen) && chosen >= 1 && chosen <= 32 ? chosen : this.meta().manifest.maxWorkers
  }

  /** The manifest check IDs the user saw and approved; empty before approval and for older approvals. */
  approvedChecks() {
    return this.#approvals().flatMap((row) => JSON.parse(row.details).planChecks ?? [])
  }

  #approvals() {
    return this.#db.prepare("SELECT details FROM events WHERE type='run_approved' ORDER BY rowid").all()
  }

  /**
   * Append one dag_add batch. The run manifest is left as submitted; the batch
   * is recorded beside it. Only additions: an ID already in the run is refused,
   * except that repeating an earlier batch exactly returns its result.
   * @param tickets - normalizeAppend output; dependencies may name run or batch tickets.
   * @param options.policyHash - digest of the batch's frozen verification commands.
   * @param options.limit - the most tickets a run may take through appends.
   * @returns { batch, appendedAt, tickets: ids, added } where added is false for a repeat.
   */
  append(tickets, { policyHash, limit = Infinity } = {}) {
    if (!Array.isArray(tickets) || !tickets.length) throw new TypeError('tickets must be a non-empty array')
    text(policyHash, 'policyHash')
    if (limit !== Infinity && (!Number.isInteger(limit) || limit < 0))
      throw new TypeError('limit must be a nonnegative integer')
    return this.#transaction(() => this.#append(tickets, policyHash, limit))
  }

  /**
   * A failed final check located at one ticket: append its fix ticket and
   * record final_verify_failed (notifying the captain) in one transaction, so
   * the repair count read from the events never misses an appended fix.
   * Not bounded by maxAppendedTickets; maxFinalRepairs bounds it.
   * @param ticket - one normalized ticket definition.
   * @param details - { tipSha, failed, culprit, culpritSha }.
   */
  appendRepair(ticket, { policyHash, details }) {
    text(policyHash, 'policyHash')
    record(details, 'final failure')
    return this.#transaction(() => {
      const result = this.#append([ticket], policyHash, Infinity)
      this.#event(
        'final_verify_failed',
        null,
        'Final check failed (' + details.failed.join(', ') + ') at ' + details.tipSha + '; located ' +
          details.culprit + ', appended ' + ticket.id,
        { ...details, repair: ticket.id },
        true,
      )
      return result
    })
  }

  #append(tickets, policyHash, limit) {
    // Presets resolve to a route at append time; the request is the ticket without it.
    const request = ({ agentSpec, ...rest }) => JSON.stringify(rest)
    {
      const run = this.meta()
      if (!run) throw new Error('run is not initialized')
      if (run.mode === 'cancelled') throw new Error('A cancelled run cannot take more tickets; start a new run')
      const batches = this.appended()
      const same = batches.find(
        (b) => b.tickets.length === tickets.length && b.tickets.every((t, i) => request(t) === request(tickets[i])),
      )
      if (same)
        return { batch: same.batch, appendedAt: same.createdAt, tickets: same.tickets.map((t) => t.id), added: false }
      const existing = this.tickets()
      const appendedIds = new Set(batches.flatMap((b) => b.tickets.map((t) => t.id)))
      const known = new Map(existing.map((t) => [t.id.toLowerCase(), t.id]))
      for (const t of tickets) {
        const old = known.get(t.id.toLowerCase())
        if (old === t.id && appendedIds.has(t.id))
          throw new TypeError(t.id + ' was already appended with a different definition')
        if (old) throw new TypeError('duplicate ticket ID (case-insensitive): ' + t.id)
      }
      const count = batches.reduce((n, b) => n + b.tickets.length, 0)
      if (count + tickets.length > limit)
        throw new RangeError(
          'Appending ' +
            tickets.length +
            ' tickets would exceed maxAppendedTickets (' +
            limit +
            ', ' +
            count +
            ' already appended) for this run; start a new run with dag_run',
        )
      checkGraph([...existing, ...tickets], run.manifest.externalInputs ?? [])
      const batch = (batches.at(-1)?.batch ?? 0) + 1
      const createdAt = Date.now()
      const start = this.#db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS n FROM tickets').get().n
      const insert = this.#db.prepare(
        "INSERT INTO tickets(id, definition, position, status) VALUES (?, ?, ?, 'PENDING')",
      )
      const edge = this.#db.prepare('INSERT INTO dependencies(ticketId, upstream) VALUES (?, ?)')
      const note = this.#db.prepare('INSERT INTO appended VALUES (?, ?, ?, ?, ?)')
      tickets.forEach((t, i) => {
        insert.run(t.id, JSON.stringify(t), start + i)
        note.run(t.id, batch, JSON.stringify(t), policyHash, createdAt)
      })
      for (const t of tickets) for (const upstream of t.dependsOn) edge.run(t.id, upstream)
      const ids = tickets.map((t) => t.id)
      this.#event('tickets_appended', null, 'Appended ' + ids.join(', '), { batch, tickets: ids })
      return { batch, appendedAt: createdAt, tickets: ids, added: true }
    }
  }

  /** Each dag_add batch in order: { batch, createdAt, policyHash, tickets: definitions }. */
  appended() {
    const batches = []
    for (const row of this.#db
      .prepare('SELECT ticketId,batch,definition,policyHash,createdAt FROM appended ORDER BY batch,rowid')
      .all()) {
      let last = batches.at(-1)
      if (last?.batch !== row.batch) {
        last = { batch: row.batch, createdAt: row.createdAt, policyHash: row.policyHash, tickets: [] }
        batches.push(last)
      }
      last.tickets.push(JSON.parse(row.definition))
    }
    return batches
  }

  /** The submitted plan: the manifest tickets, then each appended ticket as appended. */
  plan() {
    return [...this.meta().manifest.tickets, ...this.appended().flatMap((b) => b.tickets)]
  }

  /**
   * The raw ledger fields that decide what may run and how it is accepted:
   * the run row (including mode), every ticket definition, the dependency
   * edges, the append records and the approval records. The coordinator pins
   * a digest of them against outside edits.
   */
  integrity() {
    return readIntegrity(this.#db)
  }

  /**
   * The opaque plan revision a staged plan is approved against. It is derived
   * from integrity(), so any change that would alter what runs or how it is
   * accepted (an appended ticket, a frozen command, an approval record, or the
   * effective preset a ticket would resolve now) makes an earlier snapshot's
   * revision stale.
   */
  revision(agents = {}) {
    return planRevision({ ...this.integrity(), agents })
  }

  get(id) {
    return ticketRow(this.#db.prepare('SELECT * FROM tickets WHERE id=?').get(id))
  }
  tickets() {
    return this.#db.prepare('SELECT * FROM tickets ORDER BY position').all().map(ticketRow)
  }

  startedAt() {
    return this.#db.prepare("SELECT createdAt FROM events WHERE type='run_started' ORDER BY rowid LIMIT 1").get().createdAt
  }

  claim(id, { baseSha, childId, path, branch }) {
    for (const [field, value] of Object.entries({ baseSha, childId, path, branch })) text(value, field)
    return this.#transaction(() => {
      const run = this.meta()
      if (!run || run.mode !== 'active') return null
      const previous = this.get(id)
      if (!previous || previous.status !== 'PENDING') return null
      if (previous.attempt === 0) {
        if (baseSha !== run.tipSha) return null
      } else {
        if (previous.baseSha !== baseSha) return null
        if (previous.path !== null && (previous.branch !== branch || previous.path !== path)) return null
      }
      const retired = this.#db.prepare('SELECT 1 FROM retired_resources WHERE kind=? AND value=?')
      if (resourceKeys({ path, branch, childId }).some(([kind, value]) => retired.get(kind, value)))
        return null
      const active = this.#db.prepare("SELECT COUNT(*) AS n FROM tickets WHERE status='RUNNING'").get().n
      if (active >= this.workerLimit()) return null
      const lease = randomUUID()
      const changed = this.#db
        .prepare(
          `UPDATE tickets SET status='RUNNING', attempt=attempt+1, lease=?,
        baseSha=?, childId=?, path=?, branch=?, sourceSha=NULL, landedSha=NULL, retryAt=0
        WHERE id=? AND status='PENDING' AND retryAt <= ?
        AND NOT EXISTS (SELECT 1 FROM dependencies d JOIN tickets up ON up.id=d.upstream
                        WHERE d.ticketId=tickets.id AND (up.status!='INTEGRATED' OR up.landedSha IS NULL))
        AND NOT EXISTS (SELECT 1 FROM tickets busy WHERE busy.status='RUNNING'
                        AND (busy.path=? OR busy.branch=? OR busy.childId=?))`,
        )
        .run(lease, baseSha, childId, path, branch, id, Date.now(), path, branch, childId)
      if (changed.changes !== 1) return null
      const ticket = this.get(id)
      this.#event('claimed', ticket, 'Ticket claimed', { lease, baseSha, childId, path, branch })
      return ticket
    })
  }

  move(id, lease, from, to, patch = {}) {
    if (!MOVES[from]?.includes(to)) throw new TypeError('invalid ticket transition: ' + from + ' -> ' + to)
    const entries = Object.entries(record(patch, 'patch'))
    for (const [field, value] of entries) {
      if (!EDITABLE.has(field)) throw new TypeError('unsupported ticket field: ' + field)
      if (value !== null && typeof value !== 'string') throw new TypeError('invalid value for ' + field)
    }
    return this.#transaction(() => {
      const ticket = this.get(id)
      if (!ticket || ticket.status !== from || ticket.lease !== lease) return false
      if (this.meta()?.mode === 'cancelled' && (to === 'PENDING' || to === 'SUBMITTED')) return false
      if (ticket.status === 'NEEDS_ATTENTION' && this.#hasIntent(id)) return false
      if (to === 'SUBMITTED') {
        if (lease === null) return false
        // A late result may only return through the same non-revoked lease.
        // Its caller must verify the durable Git receipt before this CAS.
        const source =
          from === 'NEEDS_ATTENTION'
            ? patch.sourceSha
            : Object.hasOwn(patch, 'sourceSha')
              ? patch.sourceSha
              : ticket.sourceSha
        text(source, 'submitted sourceSha')
      }
      const fields = ['status=?', ...entries.map(([field]) => field + '=?')]
      if (to === 'PENDING') fields.push('lease=NULL')
      this.#db
        .prepare('UPDATE tickets SET ' + fields.join(',') + ' WHERE id=? AND status=? AND lease IS ?')
        .run(to, ...entries.map(([, v]) => v), id, from, lease)
      if (from === 'PUBLISHING' && to === 'SUBMITTED')
        this.#db.prepare('DELETE FROM intents WHERE ticketId=? AND lease=?').run(id, lease)
      this.#event(
        to.toLowerCase(),
        ticket,
        patch.message ?? id + ' ' + to,
        { from, to, lease, ...patch },
        to === 'NEEDS_ATTENTION',
      )
      return true
    })
  }

  #hasIntent(id) {
    return Boolean(this.#db.prepare('SELECT 1 FROM intents WHERE ticketId=?').get(id))
  }

  intent(id, lease, { oldTip, sourceSha, candidateSha }) {
    for (const [field, value] of Object.entries({ oldTip, sourceSha, candidateSha })) text(value, field)
    return this.#transaction(() => {
      const run = this.meta()
      if (run?.mode !== 'active' || run.tipSha !== oldTip) return false
      // One serial publisher per run, including unresolved publication failures.
      if (this.#db.prepare('SELECT 1 FROM intents LIMIT 1').get()) return false
      const ticket = this.get(id)
      if (
        !ticket ||
        ticket.status !== 'SUBMITTED' ||
        ticket.lease !== lease ||
        ticket.sourceSha !== sourceSha
      )
        return false
      this.#db
        .prepare('INSERT INTO intents VALUES (?, ?, ?, ?, ?)')
        .run(id, lease, oldTip, sourceSha, candidateSha)
      this.#db.prepare("UPDATE tickets SET status='PUBLISHING' WHERE id=?").run(id)
      this.#event('publishing', ticket, 'Candidate ready to publish', {
        lease,
        oldTip,
        sourceSha,
        candidateSha,
      })
      return true
    })
  }

  intents() {
    return this.#db
      .prepare(
        'SELECT ticketId AS id,ticketId,lease,oldTip,sourceSha,candidateSha FROM intents ORDER BY rowid',
      )
      .all()
      .map((r) => ({ ...r }))
  }

  /** The exclusive coordinator must first establish that Git still points to oldTip. */
  abandonIntent(id, lease) {
    return this.#transaction(() => {
      if (this.meta()?.mode !== 'cancelled') return false
      const intent = this.#db.prepare('SELECT * FROM intents WHERE ticketId=? AND lease=?').get(id, lease)
      if (!intent) return false
      const note = 'Cancelled before publishing the verified candidate'
      const changed = this.#db
        .prepare(
          "UPDATE tickets SET status='CANCELLED',message=? WHERE id=? AND lease=? AND status='PUBLISHING'",
        )
        .run(note, id, lease)
      if (changed.changes !== 1) return false
      this.#db.prepare('DELETE FROM intents WHERE ticketId=? AND lease=?').run(id, lease)
      this.#event('cancelled', this.get(id), note, intent)
      return true
    })
  }

  /**
   * @param options.complete - false in end modes: the last integration does not
   * complete the run, completeRun does after the final full check.
   */
  finish(id, lease, landedSha, { complete = true } = {}) {
    return this.#transaction(() => {
      const publishing = this.#db
        .prepare('SELECT oldTip,candidateSha FROM intents WHERE ticketId=? AND lease=?')
        .get(id, lease)
      const run = this.meta()
      if (!publishing || publishing.candidateSha !== landedSha || publishing.oldTip !== run?.tipSha)
        return false
      const change = this.#db
        .prepare(
          "UPDATE tickets SET status='INTEGRATED', landedSha=? WHERE id=? AND status IN ('PUBLISHING','NEEDS_ATTENTION') AND lease=?",
        )
        .run(landedSha, id, lease)
      if (change.changes !== 1) return false
      this.#db
        .prepare('UPDATE run SET tipSha=? WHERE singleton=1 AND tipSha=?')
        .run(landedSha, publishing.oldTip)
      this.#db.prepare('DELETE FROM intents WHERE ticketId=? AND lease=?').run(id, lease)
      this.#event('integrated', this.get(id), id + ' integrated', { lease, landedSha })
      if (
        complete &&
        run.mode !== 'cancelled' &&
        !this.#db.prepare("SELECT 1 FROM tickets WHERE status != 'INTEGRATED' LIMIT 1").get()
      ) {
        this.#event('run_completed', null, 'All tickets integrated at ' + landedSha, { landedSha }, true)
      }
      return true
    })
  }

  /**
   * The final full check passed at tipSha. Records final_verified and, while
   * tipSha is still the tip and every ticket is integrated, run_completed.
   * @returns true when the run completed.
   */
  completeRun(tipSha, details = {}) {
    text(tipSha, 'tipSha')
    return this.#transaction(() => {
      const run = this.meta()
      if (!run || run.mode === 'cancelled') return false
      this.#event('final_verified', null, 'Final checks passed at ' + tipSha, { ...details, tipSha })
      if (run.tipSha !== tipSha || this.#db.prepare("SELECT 1 FROM tickets WHERE status != 'INTEGRATED' LIMIT 1").get())
        return false
      this.#event(
        'run_completed',
        null,
        'All tickets integrated and the final checks passed at ' + tipSha,
        { landedSha: tipSha, finalVerified: true },
        true,
      )
      return true
    })
  }

  /** Whether a final full check already passed at this tip. */
  finalVerified(tipSha) {
    return Boolean(
      this.#db
        .prepare("SELECT 1 FROM events WHERE type='final_verified' AND json_extract(details,'$.tipSha')=? LIMIT 1")
        .get(tipSha),
    )
  }

  /** Fix tickets a failed final check has appended so far in this run. */
  finalRepairs() {
    return this.#db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE type='final_verify_failed' AND json_extract(details,'$.repair') IS NOT NULL")
      .get().n
  }

  /**
   * A final-check progress event: final_verify_started { tipSha, checks },
   * bisect_step { sha, ok, checks }, or final_verify_failed without a repair
   * (the run is held next). Timing only; the captain is not notified.
   */
  recordFinal(type, message, details) {
    if (!['final_verify_started', 'bisect_step', 'final_verify_failed'].includes(type))
      throw new TypeError('not a final-check event: ' + type)
    text(message, 'message')
    record(details, 'details')
    this.#transaction(() => this.#event(type, null, message, details))
  }

  /**
   * A merge-train progress event: train_started { tipSha, tickets, merges, conflicts, checks },
   * train_bisect_step { sha, ok, checks }, train_failed { tipSha, failed, culprit, culpritSha, published }
   * or train_passed { tipSha, lastSha, tickets }. Timing only; the captain is not notified.
   */
  recordTrain(type, message, details) {
    if (!['train_started', 'train_bisect_step', 'train_failed', 'train_passed'].includes(type))
      throw new TypeError('not a merge-train event: ' + type)
    text(message, 'message')
    record(details, 'details')
    this.#transaction(() => this.#event(type, null, message, details))
  }

  /**
   * When each ticket last entered SUBMITTED, as the ledger sequence of that
   * submitted event: the merge train takes submissions first in, first out.
   */
  submittedOrder() {
    const out = new Map()
    for (const row of this.#db
      .prepare("SELECT ticketId, MAX(rowid) AS seq FROM events WHERE type='submitted' AND ticketId IS NOT NULL GROUP BY ticketId")
      .all())
      out.set(row.ticketId, row.seq)
    return out
  }

  /**
   * Send a submitted ticket whose trial merge conflicted back to its own
   * branch: the next attempt resumes the same worktree and frozen base and
   * merges the integration tip itself. Bounded per ticket.
   * @returns true when the ticket was requeued.
   */
  requeueConflict(id, lease, { message, maxRetries = 2 }) {
    if (!Number.isSafeInteger(maxRetries) || maxRetries < 0)
      throw new TypeError('maxRetries must be a nonnegative integer')
    text(message, 'conflict message')
    return this.#transaction(() => {
      if (this.meta()?.mode !== 'active' || this.#hasIntent(id)) return false
      const used = this.#db
        .prepare("SELECT COUNT(*) AS n FROM events WHERE type='conflict_requeued' AND ticketId=?")
        .get(id).n
      if (used >= maxRetries) return false
      const result = this.#db
        .prepare(
          "UPDATE tickets SET status='PENDING', lease=NULL, retryAt=0, message=? WHERE id=? AND status='SUBMITTED' AND lease=?",
        )
        .run(message, id, lease)
      if (result.changes !== 1) return false
      this.#event('conflict_requeued', this.get(id), message, { oldLease: lease, conflictRetries: used + 1 })
      return true
    })
  }

  /**
   * Send a submitted ticket whose checks failed (worker-side checks, or the
   * merge train located it) back to its own branch, like requeueConflict: the
   * next attempt resumes the same worktree with the failure as its diagnostic.
   * Counted apart from conflicts.
   * @returns true when the ticket was requeued; false past maxRetries or on a stale lease.
   */
  requeueCheckFailure(id, lease, { message, maxRetries = 2 }) {
    if (!Number.isSafeInteger(maxRetries) || maxRetries < 0)
      throw new TypeError('maxRetries must be a nonnegative integer')
    text(message, 'check failure message')
    return this.#transaction(() => {
      if (this.meta()?.mode !== 'active' || this.#hasIntent(id)) return false
      const used = this.#db
        .prepare("SELECT COUNT(*) AS n FROM events WHERE type='check_requeued' AND ticketId=?")
        .get(id).n
      if (used >= maxRetries) return false
      const result = this.#db
        .prepare(
          "UPDATE tickets SET status='PENDING', lease=NULL, retryAt=0, message=? WHERE id=? AND status='SUBMITTED' AND lease=?",
        )
        .run(message, id, lease)
      if (result.changes !== 1) return false
      this.#event('check_requeued', this.get(id), message, { oldLease: lease, checkRetries: used + 1 })
      return true
    })
  }

  /**
   * The worker-side checks of one submitted commit ended. Timing only; the
   * captain is not notified. The ledger keeps the result so a restart reuses it.
   * @param details - { sourceSha, coveredTip, ok, checks, failed, output }.
   */
  recordWorkerVerify(id, details) {
    record(details, 'worker verification')
    text(details.sourceSha, 'sourceSha')
    const note = id + ' worker-side checks ' + (details.ok ? 'passed' : 'failed') + ' at ' + details.sourceSha
    this.#transaction(() => this.#event('worker_verify_finished', this.get(id), note, details))
  }

  /** The latest worker-side result for this exact commit of the ticket, or null. */
  workerVerify(id, sourceSha) {
    const row = this.#db
      .prepare(
        "SELECT details FROM events WHERE type='worker_verify_finished' AND ticketId=? AND json_extract(details,'$.sourceSha')=? ORDER BY rowid DESC LIMIT 1",
      )
      .get(id, sourceSha)
    return row ? JSON.parse(row.details) : null
  }

  /** The latest worker-side result of every ticket that has one, by ticket ID. */
  workerResults() {
    return latestWorkerResults(this.#db)
  }

  /** The worker-mode lane runs every check again: reason is tip-moved or not-covered. Timing only. */
  recordReverify(id, details) {
    record(details, 'reverify')
    this.#transaction(() =>
      this.#event('reverify', this.get(id), id + ' checks run again in the lane (' + details.reason + ')', details),
    )
  }

  /** Call only after this generation's writer has demonstrably quiesced. */
  defer(id, lease, { at, message, maxRetries = 2 }) {
    if (!Number.isSafeInteger(at) || at < 0)
      throw new TypeError('at must be a nonnegative epoch time in milliseconds')
    if (!Number.isSafeInteger(maxRetries) || maxRetries < 0)
      throw new TypeError('maxRetries must be a nonnegative integer')
    text(message, 'defer message')
    return this.#transaction(() => {
      if (this.meta()?.mode !== 'active') return false
      const result = this.#db
        .prepare(
          `UPDATE tickets SET status='PENDING', lease=NULL, retryAt=?, autoRetries=autoRetries+1, message=?
        WHERE id=? AND status='RUNNING' AND lease=? AND autoRetries < ?`,
        )
        .run(at, message, id, lease, maxRetries)
      if (result.changes !== 1) return false
      const ticket = this.get(id)
      this.#event('retry_deferred', ticket, message, { oldLease: lease, at, autoRetries: ticket.autoRetries })
      return true
    })
  }

  retry(id, { isolated = false } = {}) {
    if (typeof isolated !== 'boolean') throw new TypeError('isolated must be a boolean')
    return this.#transaction(() => {
      if (this.meta()?.mode === 'cancelled') return false
      const ticket = this.get(id)
      if (!ticket || ticket.status !== 'NEEDS_ATTENTION' || this.#hasIntent(id)) return false
      if (isolated) {
        const reserve = this.#db.prepare('INSERT OR IGNORE INTO retired_resources(kind,value) VALUES (?,?)')
        for (const [kind, value] of resourceKeys(ticket)) reserve.run(kind, value)
        this.#db
          .prepare(
            `UPDATE tickets SET status='PENDING',lease=NULL,path=NULL,branch=NULL,childId=NULL,
          sourceSha=NULL,retryAt=0,autoRetries=0 WHERE id=?`,
          )
          .run(id)
        const { path, branch, childId, attempt, lease, baseSha, sourceSha } = ticket
        this.#event(
          'isolated_retry_requested',
          ticket,
          'Retry in a new isolated worktree; original checkout preserved',
          { path, branch, childId, attempt, lease, baseSha, sourceSha },
        )
      } else {
        this.#db
          .prepare("UPDATE tickets SET status='PENDING', lease=NULL, retryAt=0, autoRetries=0 WHERE id=?")
          .run(id)
        this.#event('retry_requested', ticket, 'Ticket retry requested', { oldLease: ticket.lease })
      }
      return true
    })
  }

  /**
   * Record one integrated ticket's worktree cleanup.
   * @param status - 'cleaned' or 'skipped'; a cleaned ticket is never reopened.
   * @param reason - why it was skipped.
   * @returns true when the ticket's record changed.
   */
  recordCleanup(id, status, reason = null) {
    if (status !== 'cleaned' && status !== 'skipped') throw new TypeError('invalid cleanup status: ' + status)
    if (reason !== null) text(reason, 'cleanup reason')
    return this.#transaction(() => {
      const changed = this.#db
        .prepare(
          `UPDATE tickets SET cleanup=?, cleanupReason=? WHERE id=? AND status='INTEGRATED'
          AND cleanup IS NOT 'cleaned'`,
        )
        .run(status, status === 'cleaned' ? null : reason, id)
      if (changed.changes !== 1) return false
      const ticket = this.get(id)
      this.#event('cleanup_' + status, ticket, reason ?? id + ' worktree and branch removed', {
        path: ticket.path,
        branch: ticket.branch,
      })
      return true
    })
  }

  /** Record the result of reporting an integrated ticket back to its tracker issue. */
  recordWriteback(id, status, message, details = {}) {
    this.#transaction(() => this.#event('writeback_' + status, this.get(id), message, details))
  }

  /** The integration lane starts on this ticket. Timing only; the captain is not notified. */
  recordVerifyStart(id, checks) {
    this.#transaction(() => this.#event('verify_started', this.get(id), id + ' verification started', { checks }))
  }

  /**
   * One check command ended. Timing only; the captain is not notified.
   * @param id - the ticket, or null for a run-level check (final, bisect, train).
   * @param stage - lane (the default, not stored), worker, final, bisect or train.
   */
  recordCheck(id, { checkId, ms, ok, aborted = false, stage = 'lane' }) {
    const details = aborted ? { checkId, ms, ok, aborted } : { checkId, ms, ok }
    if (stage !== 'lane') details.stage = stage
    this.#transaction(() =>
      this.#event('check_finished', id ? this.get(id) : null, checkId + (ok ? ' passed' : ' did not pass'), details),
    )
  }

  /**
   * Which checks a candidate runs after file selection. Timing only; the captain is not notified.
   * @param id - the ticket, or null for a run-level selection.
   * @param details - { stage, run, skipped, fallback, changed }.
   */
  recordSelection(id, details) {
    record(details, 'selection')
    const note =
      (details.run?.length ?? 0) + ' checks selected, ' + (details.skipped?.length ?? 0) + ' skipped' +
      (details.fallback ? ' (' + details.fallback + ')' : '')
    this.#transaction(() => this.#event('checks_selected', id ? this.get(id) : null, note, details))
  }

  events() {
    return this.#db.prepare('SELECT * FROM events ORDER BY rowid').all().map(eventRow)
  }

  pendingNotifications() {
    return this.#db
      .prepare(
        `SELECT e.*, o.parentId FROM outbox o JOIN events e ON e.id=o.eventId
      WHERE o.acknowledgedAt IS NULL ORDER BY e.rowid`,
      )
      .all()
      .map(eventRow)
  }

  ackNotification(id) {
    return (
      this.#db
        .prepare('UPDATE outbox SET acknowledgedAt=? WHERE eventId=? AND acknowledgedAt IS NULL')
        .run(Date.now(), id).changes === 1
    )
  }

  close() {
    this.#db.close()
  }
}
