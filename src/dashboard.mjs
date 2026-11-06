import { createHash } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const route = '/api/ticket-dag.dashboard'
const noStore = { 'cache-control': 'no-store' }

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
// never a path or a repository to scan. A dashboard read never opens a writer.
export class RunCatalog {
  constructor(profileDir) {
    this.index = profileDir ? join(profileDir, 'dsh-ticket-dag', 'catalog.sqlite') : null
    this.live = new Map()
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
    if (!this.index) return
    mkdirSync(dirname(this.index), { recursive: true, mode: 0o700 })
    const db = new DatabaseSync(this.index)
    try {
      db.exec(`PRAGMA busy_timeout=1000;
        CREATE TABLE IF NOT EXISTS runs (
          key TEXT PRIMARY KEY, file TEXT NOT NULL, runId TEXT NOT NULL, parentId TEXT NOT NULL,
          repoName TEXT NOT NULL, specId TEXT NOT NULL, total INTEGER NOT NULL, createdAt INTEGER NOT NULL
        )`)
      db.prepare('INSERT OR REPLACE INTO runs VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
        key,
        file,
        row.runId,
        row.parentId,
        row.repoName,
        row.specId,
        row.total,
        row.createdAt,
      )
    } finally {
      db.close()
    }
  }

  entries() {
    const known = new Map(this.live)
    if (this.index && existsSync(this.index)) {
      const db = new DatabaseSync(this.index, { readOnly: true })
      try {
        for (const row of db
          .prepare('SELECT key,file,runId,parentId,repoName,specId,total,createdAt FROM runs')
          .all()) {
          if (!known.has(row.key)) known.set(row.key, row)
        }
      } finally {
        db.close()
      }
    }
    return [...known.values()].sort((a, b) => b.createdAt - a.createdAt || a.key.localeCompare(b.key))
  }

  // parent limits the view to runs started by that captain session. captainOf
  // returns a loaded captain's model route; unloaded captains show none.
  read(coordinator, key, parent = null, captainOf = () => undefined) {
    const known = this.entries().filter((entry) => parent === null || entry.parentId === parent)
    if (key && !known.some((entry) => entry.key === key)) return null
    const selectedKey = key ?? known[0]?.key
    let selected = null
    const runs = known.map(({ file, ...entry }) => {
      const detail = entry.key === selectedKey
      const attached = coordinator.runs.has(file)
      let data
      try {
        data =
          attached && detail
            ? coordinator.peek(file)
            : readLedger(file, entry, detail, coordinator.maxWorkers)
      } catch {
        // Keep moved/deleted/unavailable repositories visible without inventing progress.
        data = {
          available: false,
          mode: 'unavailable',
          complete: false,
          counts: {},
          diagnostic: '无法读取这轮任务的 SQLite 记录。请确认原仓库及运行记录仍然可用。',
          tickets: [],
        }
      }
      const summary = {
        ...entry,
        attached,
        available: data.available ?? true,
        mode: data.mode,
        complete: data.complete,
        counts: data.counts,
        verifiedSha: data.verifiedSha ?? null,
        integrationRef: data.integrationRef ?? null,
        maxWorkers: data.maxWorkers ?? null,
        diagnostic: displayDiagnostic(data.diagnostic),
      }
      const route = detail ? captainOf(entry.parentId) : undefined
      if (detail)
        selected = {
          ...summary,
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
          // Commands of the checks the run uses; the plan review shows them for approval.
          checks: data.checks ?? {},
          planChecks: data.planChecks ?? [],
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
      return summary
    })
    return { runs, selected }
  }
}

function readLedger(file, entry, detail, globalLimit) {
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
      // A ledger from before dag_add has no appended table: nothing was appended.
      const appended = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='appended'").get()
        ? new Map(db.prepare('SELECT ticketId,createdAt FROM appended').all().map((r) => [r.ticketId, r.createdAt]))
        : new Map()
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
      const { key, action, choices, maxWorkers } = body ?? {}
      if (
        typeof key !== 'string' ||
        !/^[0-9a-f]{64}$/.test(key) ||
        !['approve', 'discard'].includes(action) ||
        (action === 'approve' && !Array.isArray(choices)) ||
        (maxWorkers !== undefined && (!Number.isInteger(maxWorkers) || maxWorkers < 1 || maxWorkers > 32))
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
            ? await coordinator.approve(entry.file, choices, maxWorkers === undefined ? {} : { maxWorkers })
            : await coordinator.discard(entry.file)
        return Response.json(snapshot, { headers: noStore })
      } catch (error) {
        return new Response(displayDiagnostic(error?.message) || 'Approval failed', { status: 409, headers: noStore })
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
