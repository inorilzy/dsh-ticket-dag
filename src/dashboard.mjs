import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { planRevision, readIntegrity } from './store.mjs'
import { runTiming } from './timing.mjs'

const route = '/api/ticket-dag.dashboard'
const noStore = { 'cache-control': 'no-store' }
const unreadableDiagnostic = '无法读取这轮任务的 SQLite 记录。请确认原仓库及运行记录仍然可用。'

// A ledger writes recent pages to its -wal file, so both files decide whether a
// cached summary is current. A settled run never changes and stays cached; only
// an active run's growing WAL invalidates it. A missing file returns null so the
// caller still reports that run as unavailable instead of trusting stale data.
function ledgerSignature(file) {
  try {
    const main = statSync(file)
    let signature = main.mtimeMs + ':' + main.size
    try {
      const wal = statSync(file + '-wal')
      signature += '|' + wal.mtimeMs + ':' + wal.size
    } catch {
      // No WAL file: the main file alone is the signature.
    }
    return signature
  } catch {
    return null
  }
}

// The summary fields a history row needs, without its ticket detail. rawMaxWorkers
// keeps the ledger's own cap so the caller can re-apply a changed host limit.
function summaryOf(data) {
  return {
    available: data.available ?? true,
    mode: data.mode,
    complete: data.complete,
    counts: data.counts,
    verifiedSha: data.verifiedSha ?? null,
    integrationRef: data.integrationRef ?? null,
    maxWorkers: data.rawMaxWorkers ?? data.maxWorkers ?? null,
    diagnostic: displayDiagnostic(data.diagnostic),
  }
}

function capWorkers(value, limit) {
  if (value == null) return null
  return Number.isInteger(limit) && limit >= 1 ? Math.min(limit, value) : value
}

function displayDiagnostic(value) {
  if (!value) return null
  return String(value)
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
    .replace(/(\bbearer\s+)[\w.+/=~-]+/gi, '$1[redacted]')
    .replace(/(\b(?:api[_-]?key|access[_-]?token|authorization)\s*[=:]\s*)[^,\s]+/gi, '$1[redacted]')
    .slice(-2200)
}

// Only the coordinator can enroll a ledger. The browser supplies an opaque key,
// never a path or a repository to scan. A dashboard read never opens a run ledger
// as a writer; only the small summary cache index is written.
export class RunCatalog {
  constructor(profileDir) {
    this.index = profileDir ? join(profileDir, 'dsh-ticket-dag', 'catalog.sqlite') : null
    this.live = new Map()
    // key -> { signature, summary }: this process's already-read history rows.
    this.cache = new Map()
    // Files this instance opened. A detail request must open the selected ledger
    // only; settled history comes from the cache, so the count stays constant.
    this.ledgerOpens = 0
    // Recovery failures reported by the attach scan, keyed by parentId + runId.
    // A run the host could not take over is shown as unreadable with its
    // diagnostic instead of disappearing from the board.
    this.failures = new Map()
  }

  // Remember a run that failed to attach so its board row can explain why.
  // The host reports the same failure to the captain; this keeps the board honest.
  reportFailure(parentId, runId, diagnostic, file = null) {
    const id = String(parentId) + '\u0000' + String(runId)
    this.failures.set(id, {
      parentId: String(parentId),
      runId: String(runId),
      file: file ? String(file) : null,
      diagnostic: displayDiagnostic(diagnostic) || unreadableDiagnostic,
      createdAt: Date.now(),
    })
  }

  // Add the cache columns to an index created before them. Old rows read as NULL
  // (nothing cached) and are migrated incrementally on the next read.
  #ensureCacheColumns(db) {
    const columns = new Set(db.prepare('PRAGMA table_info(runs)').all().map((c) => c.name))
    if (!columns.has('summary')) db.exec('ALTER TABLE runs ADD COLUMN summary TEXT')
    if (!columns.has('summarySig')) db.exec('ALTER TABLE runs ADD COLUMN summarySig TEXT')
  }

  remember(file, meta, createdAt) {
    const key = createHash('sha256')
      .update(JSON.stringify([file, meta.parentId]))
      .digest('hex')
    const row = {
      key,
      file,
      runId: meta.runId,
      parentId: meta.parentId,
      repoName: basename(meta.repo.root),
      specId: meta.manifest.specId,
      total: meta.manifest.tickets.length,
      createdAt,
    }
    this.live.set(key, row)
    this.cache.delete(key)
    if (!this.index) return
    mkdirSync(dirname(this.index), { recursive: true, mode: 0o700 })
    const db = new DatabaseSync(this.index)
    try {
      db.exec(`PRAGMA busy_timeout=1000;
        CREATE TABLE IF NOT EXISTS runs (
          key TEXT PRIMARY KEY, file TEXT NOT NULL, runId TEXT NOT NULL, parentId TEXT NOT NULL,
          repoName TEXT NOT NULL, specId TEXT NOT NULL, total INTEGER NOT NULL, createdAt INTEGER NOT NULL,
          summary TEXT, summarySig TEXT
        )`)
      this.#ensureCacheColumns(db)
      // Keep any cached summary on re-open; its signature decides whether it is
      // still current, so a restart does not need to reread every settled ledger.
      db.prepare(
        `INSERT INTO runs(key,file,runId,parentId,repoName,specId,total,createdAt,summary,summarySig)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
        ON CONFLICT(key) DO UPDATE SET
          file=excluded.file, runId=excluded.runId, parentId=excluded.parentId,
          repoName=excluded.repoName, specId=excluded.specId, total=excluded.total,
          createdAt=excluded.createdAt`,
      ).run(key, file, row.runId, row.parentId, row.repoName, row.specId, row.total, row.createdAt)
    } finally {
      db.close()
    }
  }

  // A session filter runs inside the index query, so one conversation's board
  // never loads another conversation's rows. Rows carry their cached summary
  // when available; an index from before the cache columns reads them as NULL.
  entries(parent = null) {
    const known = new Map()
    if (this.index && existsSync(this.index)) {
      const db = new DatabaseSync(this.index, { readOnly: true })
      try {
        const columns = new Set(db.prepare('PRAGMA table_info(runs)').all().map((c) => c.name))
        const summary =
          columns.has('summary') && columns.has('summarySig')
            ? 'summary,summarySig'
            : 'NULL AS summary,NULL AS summarySig'
        const statement = db.prepare(
          `SELECT key,file,runId,parentId,repoName,specId,total,createdAt,${summary} FROM runs` +
            (parent === null ? '' : ' WHERE parentId=?'),
        )
        for (const row of parent === null ? statement.all() : statement.all(parent))
          known.set(row.key, row)
      } finally {
        db.close()
      }
    }
    // Entries remembered this process stay visible even when the index is missing
    // or not yet written, and their metadata wins over the index row; the cached
    // summary still comes from the index so a live entry does not force a ledger read.
    for (const [key, live] of this.live) {
      if (parent !== null && live.parentId !== parent) continue
      const cached = known.get(key)
      known.set(key, { ...cached, ...live, summary: cached?.summary ?? null, summarySig: cached?.summarySig ?? null })
    }
    return [...known.values()].sort((a, b) => b.createdAt - a.createdAt || a.key.localeCompare(b.key))
  }

  // A history row's summary: memory, then the persisted index, then the ledger.
  // Only a signature change (a write) reopens a ledger, so a settled history is
  // read once regardless of how many runs the board lists.
  #cachedSummary(entry, file, indexSummary, indexSignature, signature, coordinator) {
    if (signature) {
      const memo = this.cache.get(entry.key)
      if (memo && memo.signature === signature) return memo.summary
      if (indexSummary && indexSignature === signature) {
        const summary = JSON.parse(indexSummary)
        this.cache.set(entry.key, { signature, summary })
        return summary
      }
    }
    this.ledgerOpens++
    const summary = summaryOf(readLedger(file, entry, false, coordinator.maxWorkers))
    if (signature) this.#storeSummary(entry.key, summary, signature)
    return summary
  }

  #storeSummary(key, summary, signature) {
    this.cache.set(key, { signature, summary })
    if (!this.index) return
    try {
      const db = new DatabaseSync(this.index)
      try {
        db.exec('PRAGMA busy_timeout=1000;')
        this.#ensureCacheColumns(db)
        db.prepare('UPDATE runs SET summary=?,summarySig=? WHERE key=?').run(
          JSON.stringify(summary),
          signature,
          key,
        )
      } finally {
        db.close()
      }
    } catch {
      // The cache is advisory: a busy index just means the next read recomputes.
    }
  }

  // parent limits the view to runs started by that captain session. captainOf
  // returns a loaded captain's model route; unloaded captains show none.
  // The selected run's detail is read on demand; every other row is a cached
  // summary, so an unreadable unrelated ledger cannot hide the selected run.
  read(coordinator, key, parent = null, captainOf = () => undefined) {
    const known = this.entries(parent)
    // Runs the attach scan could not recover are listed as unreadable rows so
    // the user sees the failure with its diagnostic, not only in the host log.
    const failed = [...this.failures.values()].filter((f) => parent === null || f.parentId === parent)
    const knownRuns = new Set(known.map((row) => row.parentId + '\u0000' + row.runId))
    for (const f of failed) {
      if (knownRuns.has(f.parentId + '\u0000' + f.runId)) continue
      known.push({
        key: createHash('sha256')
          .update(JSON.stringify([f.file ?? 'recovery:' + f.parentId + ':' + f.runId, f.parentId]))
          .digest('hex'),
        file: f.file,
        runId: f.runId,
        parentId: f.parentId,
        repoName: f.file ? basename(dirname(dirname(dirname(f.file)))) : '',
        specId: '',
        total: 0,
        createdAt: f.createdAt,
        summary: null,
        summarySig: null,
      })
    }
    if (failed.length) known.sort((a, b) => b.createdAt - a.createdAt || a.key.localeCompare(b.key))
    const failedById = new Map(failed.map((f) => [f.parentId + '\u0000' + f.runId, f]))
    if (key && !known.some((entry) => entry.key === key)) return null
    const selectedKey = key ?? known[0]?.key
    let selected = null
    const now = Date.now()
    const runs = known.map((row) => {
      const { file, summary, summarySig, ...entry } = row
      const detail = entry.key === selectedKey
      const attached = coordinator.runs.has(file)
      // A run that is now attached is live even if an earlier scan failed it.
      const recovery = attached ? null : failedById.get(entry.parentId + '\u0000' + entry.runId)
      let data
      try {
        if (attached) {
          data = coordinator.peek(file, detail ? now : undefined)
          if (!data) throw new Error('run is no longer attached')
        } else if (detail) {
          const signature = ledgerSignature(file)
          this.ledgerOpens++
          data = readLedger(file, entry, true, coordinator.maxWorkers, coordinator.agents, now)
          // Refresh the cache only when the ledger changed since it was last read.
          if (signature && this.cache.get(entry.key)?.signature !== signature)
            this.#storeSummary(entry.key, summaryOf(data), signature)
        } else {
          data = this.#cachedSummary(entry, file, summary, summarySig, ledgerSignature(file), coordinator)
        }
      } catch {
        // Keep moved/deleted/unavailable repositories visible without inventing progress.
        data = {
          available: false,
          mode: 'unavailable',
          complete: false,
          counts: {},
          diagnostic: unreadableDiagnostic,
          tickets: [],
        }
      }
      if (recovery) {
        // A run that could not be recovered is not live even if a read-only
        // ledger read would succeed (for example another coordinator holds the lock).
        data = {
          available: false,
          mode: 'unavailable',
          complete: false,
          counts: {},
          diagnostic: recovery.diagnostic,
          tickets: [],
        }
      }
      const summaryRow = {
        ...entry,
        attached,
        available: data.available ?? true,
        mode: data.mode,
        complete: data.complete,
        counts: data.counts,
        verifiedSha: data.verifiedSha ?? null,
        integrationRef: data.integrationRef ?? null,
        maxWorkers: capWorkers(data.rawMaxWorkers ?? data.maxWorkers, coordinator.maxWorkers),
        diagnostic: displayDiagnostic(data.diagnostic),
      }
      const route = detail ? captainOf(entry.parentId) : undefined
      if (detail)
        selected = {
          ...summaryRow,
          captain: route?.model ? { provider: route.provider ?? '', model: route.model } : null,
          // The plan review offers the current presets; approval resolves them on the host.
          // Every other mode only reads them to name each ticket's frozen agent.
          presets: Object.entries(coordinator.agents ?? {}).map(([id, p]) => ({
            id,
            name: p?.name ?? '',
            description: p?.description ?? '',
            provider: p?.provider ?? '',
            model: p?.model ?? '',
            reasoningEffort: p?.reasoningEffort ?? '',
          })),
          // Every approved or reviewable command; the plan review shows them for approval.
          checks: data.checks ?? {},
          planChecks: data.planChecks ?? [],
          // The opaque plan version the review shows and approval must echo back.
          revision: data.revision ?? null,
          // The server's clock, so a live board can count from timing.runningSince.
          timing: data.timing ?? null,
          now,
          tickets: data.tickets.map((t) => ({
            id: t.id,
            title: t.title,
            status: t.status,
            agent: t.agent ?? null,
            model: t.model ?? null,
            route: t.route ?? null,
            dependsOn: t.dependsOn,
            verify: t.verify ?? [],
            attempt: t.attempt,
            path: t.path,
            branch: t.branch,
            baseSha: t.baseSha,
            sourceSha: t.sourceSha,
            landedSha: t.landedSha,
            childId: t.childId,
            autoRetries: t.autoRetries,
            retryAt: t.retryAt,
            message: displayDiagnostic(t.message),
            livePhase: t.livePhase ?? null,
            cleanup: t.cleanup ?? null,
            cleanupReason: displayDiagnostic(t.cleanupReason),
            appended: t.appended ?? false,
            appendedAt: t.appendedAt ?? null,
          })),
        }
      return summaryRow
    })
    return { runs, selected }
  }
}

// Read one ledger. `detail` also loads each ticket row; otherwise only the run
// row and status counts are read. Exported so the history benchmark can measure
// the pre-cache cost without duplicating the queries.
export function readLedger(file, entry, detail, globalLimit, agents = {}, now = Date.now()) {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON; BEGIN')
    const run = db
      .prepare(
        `SELECT mode,diagnostic,ref AS integrationRef,tipSha AS verifiedSha,
        json_extract(manifest, '$.maxWorkers') AS maxWorkers FROM run
        WHERE singleton=1 AND runId=? AND parentId=?`,
      )
      .get(entry.runId, entry.parentId)
    if (!run) throw new Error('Mismatched DAG ledger')
    const counts = Object.fromEntries(
      db
        .prepare('SELECT status,count(*) AS n FROM tickets GROUP BY status')
        .all()
        .map((row) => [row.status, row.n]),
    )
    const total = Object.values(counts).reduce((sum, n) => sum + n, 0)
    const result = {
      ...run,
      maxWorkers: Math.min(globalLimit, run.maxWorkers),
      // Kept raw so a later host-limit change re-applies without reopening the ledger.
      rawMaxWorkers: run.maxWorkers ?? null,
      total,
      counts,
      complete: total > 0 && counts.INTEGRATED === total,
    }
    if (detail) {
      // A ledger from before worktree cleanup has no cleanup columns: not cleaned.
      const columns = new Set(db.prepare('PRAGMA table_info(tickets)').all().map((c) => c.name))
      const cleanup = columns.has('cleanup') && columns.has('cleanupReason')
        ? 'cleanup,cleanupReason'
        : 'NULL AS cleanup,NULL AS cleanupReason'
      // One shared read of the integrity rows: the same rows RunStore.integrity()
      // returns, so the append list and plan revision cannot drift from the writer.
      const integrity = readIntegrity(db)
      const appended = new Map(integrity.appended.map((r) => [r.ticketId, r.createdAt]))
      result.tickets = db
        .prepare(
          `SELECT id,json_extract(definition,'$.title') AS title,
        json_extract(definition,'$.dependsOn') AS deps,json_extract(definition,'$.verify') AS checkIds,
        status,attempt,baseSha,sourceSha,landedSha,
        path,branch,childId,message,autoRetries,retryAt,${cleanup},json_extract(definition,'$.agent') AS agent,
        json_extract(definition,'$.agentSpec.provider') AS provider,
        json_extract(definition,'$.agentSpec.model') AS modelId FROM tickets ORDER BY position`,
        )
        .all()
        .map(({ deps, checkIds, provider, modelId, ...row }) => ({
          ...row,
          dependsOn: JSON.parse(deps),
          verify: checkIds ? JSON.parse(checkIds) : [],
          model: modelId ? [provider, modelId].filter(Boolean).join('/') : null,
          livePhase: null,
          appended: appended.has(row.id),
          appendedAt: appended.get(row.id) ?? null,
        }))
      // A plan waiting for approval shows the captain's commands even before its captain reopens.
      if (run.mode === 'staged') {
        const checks = JSON.parse(integrity.run.manifest).checks ?? {}
        result.checks = checks
        result.planChecks = Object.keys(checks)
        // The same revision RunStore.revision() computes, built from the shared
        // integrity rows so a plan read without the coordinator still carries
        // the exact version, including each ticket's effective preset now.
        result.revision = planRevision({ ...integrity, agents })
      }
      result.timing = runTiming(
        db
          .prepare('SELECT type,ticketId,attempt,createdAt,details FROM events ORDER BY rowid')
          .all()
          .map((row) => ({ ...row, details: JSON.parse(row.details) })),
        now,
      )
    }
    return result
  } finally {
    db.close()
  }
}

// Provider/model/effort choices for the settings form. Read-only: it never
// changes any session's model. A provider whose catalog fails is named in
// failures and its models are omitted.
async function modelCatalog(llm) {
  const providers = []
  const failures = []
  for (const provider of llm?.listProviders?.() ?? []) {
    try {
      const models = []
      for (const model of await llm.listModels(provider.id)) {
        let reasoning
        try {
          reasoning = (await llm.resolveModelInfo?.(provider.id, model.id))?.reasoning
        } catch {
          // Effort metadata is optional; the model stays selectable without it.
        }
        models.push({
          id: model.id,
          name: model.name || model.id,
          efforts: (reasoning?.efforts ?? []).map(({ id, name }) => ({ id, name: name || id })),
          defaultEffort: reasoning?.defaultEffort ?? null,
        })
      }
      if (models.length) providers.push({ id: provider.id, name: provider.name || provider.id, models })
    } catch {
      failures.push(provider.id)
    }
  }
  return { providers, failures }
}

export function mountModels(ctx, getLlm) {
  ctx.connection.fetch.register({
    path: '/api/ticket-dag.models',
    methods: ['GET'],
    requestBody: 'buffered',
    async fetch() {
      return Response.json(await modelCatalog(getLlm()), { headers: noStore })
    },
  })
}

const approvalLimit = 256 * 1024
const fieldLimit = 200
const refuse = (status, text) => new Response(text, { status, headers: noStore })

// A cross-site form cannot set a custom header or a JSON type without a CORS
// preflight, and a browser that names an Origin must name this host.
function crossSite(request) {
  const type = (request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
  if (type !== 'application/json') return refuse(415, 'Approval requires an application/json body')
  if (request.headers.get('x-dsh-ticket-dag') !== '1') return refuse(403, 'Missing x-dsh-ticket-dag: 1 header')
  const origin = request.headers.get('origin')
  if (origin !== null) {
    let host
    try {
      host = new URL(origin).host
    } catch {
      host = null
    }
    if (!host || host !== (request.headers.get('host') ?? new URL(request.url).host))
      return refuse(403, 'Cross-origin approval refused')
  }
  return null
}

class ChoiceError extends Error {
  constructor(text, status = 400) {
    super(text)
    this.status = status
  }
}

// Each choice names known text fields; a chosen model must be listed in the
// model catalog, and its reasoning effort among that model's efforts.
async function checkChoices(choices, getLlm) {
  let models
  for (const c of choices) {
    if (c === null || typeof c !== 'object' || Array.isArray(c)) throw new ChoiceError('Each choice must be an object')
    for (const field of ['id', 'agent', 'provider', 'model', 'reasoningEffort']) {
      const value = c[field] ?? ''
      if (typeof value !== 'string') throw new ChoiceError(field + ' must be text')
      if (value.length > fieldLimit) throw new ChoiceError(field + ' is longer than ' + fieldLimit + ' characters')
    }
    const provider = (c.provider ?? '').trim(),
      model = (c.model ?? '').trim(),
      effort = (c.reasoningEffort ?? '').trim()
    if (!model) continue
    models ??= await modelCatalog(getLlm?.())
    const listed = models.providers.filter((p) => !provider || p.id === provider)
    const found = listed.flatMap((p) => p.models).find((m) => m.id === model)
    if (!found) {
      if (!models.providers.length || (provider ? models.failures.includes(provider) : models.failures.length))
        throw new ChoiceError('模型目录暂不可用，无法校验 ' + model + '。请改用宿主默认模型或稍后重试。', 503)
      throw new ChoiceError(
        provider && !listed.length ? 'Unknown provider: ' + provider : 'Unknown model: ' + [provider, model].filter(Boolean).join('/'),
      )
    }
    if (effort && !found.efforts.some((e) => e.id === effort))
      throw new ChoiceError('Model ' + model + ' does not support reasoning effort ' + effort)
  }
}

// Validate the routes a staged plan will actually dispatch, not only the ones a
// user typed: a ticket that keeps its planned preset still inherits that
// preset's provider/model/effort. The coordinator calls this inside its serial
// region so every effective route resolves before any worker starts.
export async function validateTicketRoutes(tickets, getLlm) {
  let models
  for (const ticket of tickets) {
    const spec = ticket?.agentSpec ?? {}
    const provider = String(spec.provider ?? '').trim()
    const model = String(spec.model ?? '').trim()
    const effort = String(spec.reasoningEffort ?? '').trim()
    if (!model) {
      if (provider || effort) throw new ChoiceError(ticket.id + ' sets a provider or reasoning effort without a model')
      continue
    }
    models ??= await modelCatalog(getLlm?.())
    const listed = models.providers.filter((p) => !provider || p.id === provider)
    const found = listed.flatMap((p) => p.models).find((m) => m.id === model)
    if (!found) {
      if (!models.providers.length || (provider ? models.failures.includes(provider) : models.failures.length))
        throw new ChoiceError('模型目录暂不可用，无法校验 ' + model + '。请稍后重试。', 503)
      throw new ChoiceError(
        provider && !listed.length
          ? 'Unknown provider: ' + provider
          : 'Unknown model: ' + [provider, model].filter(Boolean).join('/'),
      )
    }
    if (effort && !found.efforts.some((e) => e.id === effort))
      throw new ChoiceError('Model ' + model + ' does not support reasoning effort ' + effort)
  }
}

// The user's decision on a staged plan. Like the dashboard read, the managed
// dispatcher admits only the owner; the body names the run by its opaque key.
export function mountApproval(ctx, catalog, coordinator, getLlm = () => undefined) {
  ctx.connection.fetch.register({
    path: '/api/ticket-dag.approve',
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      const refused = crossSite(request)
      if (refused) return refused
      let body
      try {
        const raw = await request.text()
        if (raw.length > approvalLimit) throw new Error('too large')
        body = JSON.parse(raw)
      } catch {
        return new Response('Invalid approval request', { status: 400, headers: noStore })
      }
      const { key, action, choices, maxWorkers, revision } = body ?? {}
      if (
        typeof key !== 'string' ||
        !/^[0-9a-f]{64}$/.test(key) ||
        !['approve', 'discard'].includes(action) ||
        (action === 'approve' && !Array.isArray(choices)) ||
        (maxWorkers !== undefined && (!Number.isInteger(maxWorkers) || maxWorkers < 1 || maxWorkers > 32)) ||
        // An old client sends no revision; the coordinator answers with a
        // refresh/upgrade diagnostic. A non-string or oversized one is malformed.
        (revision !== undefined && (typeof revision !== 'string' || revision.length > 512))
      ) {
        return new Response('Invalid approval request', { status: 400, headers: noStore })
      }
      if (action === 'approve') {
        try {
          await checkChoices(choices, getLlm)
        } catch (error) {
          if (!(error instanceof ChoiceError)) throw error
          return refuse(error.status, error.message)
        }
      }
      const entry = catalog.entries().find((row) => row.key === key)
      if (!entry) return new Response('Unknown run', { status: 404, headers: noStore })
      if (!coordinator.runs.has(entry.file)) {
        return new Response('Open the captain conversation of this run first', { status: 409, headers: noStore })
      }
      try {
        const snapshot =
          action === 'approve'
            ? await coordinator.approve(entry.file, choices, {
                ...(maxWorkers !== undefined && { maxWorkers }),
                ...(revision !== undefined && { revision }),
              })
            : await coordinator.discard(entry.file)
        return Response.json(snapshot, { headers: noStore })
      } catch (error) {
        const message = displayDiagnostic(error?.message) || 'Approval failed'
        // A stale or missing plan revision is the only refusal the board treats
        // as "review the new plan again"; every other refusal (duplicate or
        // unknown ticket, a bad route, a tampered ledger) keeps its own message.
        const code = typeof error?.code === 'string' ? error.code : null
        return new Response(code ? JSON.stringify({ code, message }) : message, {
          status: error?.status ?? 409,
          headers: code ? { ...noStore, 'content-type': 'application/json' } : noStore,
        })
      }
    },
  })
}

// The managed Connection exact-route dispatcher rejects non-owner Peers before
// invoking this handler, including in Desktop's transport. No public web route.
export function mountDashboard(ctx, catalog, coordinator, captainOf) {
  ctx.connection.fetch.register({
    path: route,
    methods: ['GET'],
    requestBody: 'buffered',
    async fetch(request) {
      const query = new URL(request.url).searchParams
      const key = query.get('key')
      const parent = query.get('parent')
      if (
        [...query.keys()].some((k) => k !== 'key' && k !== 'parent') ||
        query.getAll('key').length > 1 ||
        query.getAll('parent').length > 1 ||
        (key !== null && !/^[0-9a-f]{64}$/.test(key)) ||
        (parent !== null && !/^[A-Za-z0-9_.:-]{1,200}$/.test(parent))
      ) {
        return new Response('Invalid run key', { status: 400, headers: noStore })
      }
      try {
        const view = catalog.read(coordinator, key, parent, captainOf)
        return view
          ? Response.json(view, { headers: noStore })
          : new Response('Unknown run', { status: 404, headers: noStore })
      } catch {
        return new Response('Run index unavailable', { status: 503, headers: noStore })
      }
    },
  })
}
