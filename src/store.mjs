import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

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
const MODES = new Set(['active', 'paused', 'cancelled'])
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
  const commands = registry[name]
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
function agentSpec(registry, name) {
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

/** Accept the spec author's snake_case or the stored camelCase representation. */
export function normalizeManifest(input, checkRegistry = {}, agentRegistry = {}) {
  record(input, 'manifest')
  record(checkRegistry, 'checkRegistry')
  record(agentRegistry, 'agentRegistry')
  const specId = safeId(input.specId ?? input.spec_id, 'specId')
  const baseRef = gitRef(input.baseRef ?? input.base_ref ?? 'main')
  const maxWorkers = input.maxWorkers ?? input.max_workers ?? 16
  if (!Number.isInteger(maxWorkers) || maxWorkers < 1 || maxWorkers > 32)
    throw new RangeError('maxWorkers must be an integer between 1 and 32')
  if (!Array.isArray(input.tickets) || !input.tickets.length)
    throw new TypeError('tickets must be a non-empty array')
  const externalInputs = strings(input.externalInputs ?? input.external_inputs, 'externalInputs')
  const byId = new Map()
  const filesystemNames = new Set()
  const tickets = input.tickets.map((raw) => {
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
    const verify = strings(raw.verify, id + '.verify', safeId)
    if (!verify.length) throw new TypeError(id + ': at least one verification check is required')
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
    byId.set(id, ticket)
    return ticket
  })
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
  return { specId, baseRef, maxWorkers, tickets, ...(externalInputs.length ? { externalInputs } : {}) }
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS run (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1), runId TEXT NOT NULL,
    repo TEXT NOT NULL, ref TEXT NOT NULL, baseSha TEXT NOT NULL,
    manifest TEXT NOT NULL, parentId TEXT NOT NULL, policyHash TEXT NOT NULL, tipSha TEXT NOT NULL,
    mode TEXT NOT NULL CHECK(mode IN ('active', 'paused', 'cancelled')), diagnostic TEXT
  );
  CREATE TABLE IF NOT EXISTS tickets (
    id TEXT PRIMARY KEY, definition TEXT NOT NULL, position INTEGER NOT NULL UNIQUE,
    status TEXT NOT NULL CHECK(status IN (${STATES_SQL})), attempt INTEGER NOT NULL DEFAULT 0,
    lease TEXT, baseSha TEXT, sourceSha TEXT, landedSha TEXT, childId TEXT, path TEXT, branch TEXT, message TEXT,
    retryAt INTEGER NOT NULL DEFAULT 0 CHECK(retryAt >= 0), autoRetries INTEGER NOT NULL DEFAULT 0 CHECK(autoRetries >= 0)
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

  init({ runId, repo, ref, baseSha, manifest, parentId, policyHash }) {
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
        .prepare("INSERT INTO run VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL)")
        .run(
          runId,
          JSON.stringify({ root: repo.root, commonDir: repo.commonDir }),
          ref,
          baseSha,
          JSON.stringify(manifest),
          parentId,
          policyHash,
          baseSha,
        )
      const insert = this.#db.prepare(
        "INSERT INTO tickets(id, definition, position, status) VALUES (?, ?, ?, 'PENDING')",
      )
      const edge = this.#db.prepare('INSERT INTO dependencies(ticketId, upstream) VALUES (?, ?)')
      manifest.tickets.forEach((t, i) => insert.run(t.id, JSON.stringify(t), i))
      for (const t of manifest.tickets) for (const upstream of t.dependsOn) edge.run(t.id, upstream)
      this.#event('run_started', null, 'Run started', { ref, baseSha })
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

  hold(message) {
    text(message, 'diagnostic')
    return this.#transaction(() => {
      const run = this.meta()
      if (!run || run.mode === 'cancelled' || (run.mode === 'paused' && run.diagnostic === message))
        return false
      this.#db.prepare("UPDATE run SET mode='paused',diagnostic=? WHERE singleton=1").run(message)
      this.#event('run_blocked', null, message, { previousMode: run.mode }, true)
      return true
    })
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
      if (active >= run.manifest.maxWorkers) return null
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

  finish(id, lease, landedSha) {
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
        run.mode !== 'cancelled' &&
        !this.#db.prepare("SELECT 1 FROM tickets WHERE status != 'INTEGRATED' LIMIT 1").get()
      ) {
        this.#event('run_completed', null, 'All tickets integrated at ' + landedSha, { landedSha }, true)
      }
      return true
    })
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
