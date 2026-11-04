import { createHash, randomUUID } from 'node:crypto'
import { access, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import * as git from './git.mjs'
import { agentSpec, normalizeManifest, RunStore } from './store.mjs'

const hash = (text) => createHash('sha256').update(text).digest('hex')
const message = (err) => String(err?.message ?? err).slice(-3500)
const keyOf = (id) => 't-' + hash(id).slice(0, 24)
const transient =
  /\b(TRANSPORT|TIMEOUT|ECONNRESET|ETIMEDOUT|STREAM_CLOSED|RATE_LIMIT)\b|unexpected EOF|before a terminal event/i
const capacityCode = 'ACTIVATION_LIMIT_REACHED'
const runPattern = /^[a-z0-9][a-z0-9_-]{0,62}$/

function requireValue(test, text) {
  if (!test) throw new Error(text)
}
async function exists(path) {
  try {
    await access(path)
    return true
  } catch (e) {
    if (e.code === 'ENOENT') return false
    throw e
  }
}
function safeId(id) {
  requireValue(
    typeof id === 'string' && runPattern.test(id) && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/.test(id),
    'Use a lowercase runId of 1–63 letters, numbers, hyphens or underscores',
  )
  return id
}
function policyHash(manifest, checks) {
  return hash(
    JSON.stringify(
      [...new Set(manifest.tickets.flatMap((t) => t.verify))].sort().map((id) => [id, checks[id]]),
    ),
  )
}
function copyChecks(manifest, registry) {
  const copy = Object.create(null)
  for (const id of new Set(manifest.tickets.flatMap((t) => t.verify))) {
    if (Object.hasOwn(registry, id))
      copy[id] = Object.freeze(registry[id].map((argv) => Object.freeze([...argv])))
  }
  return Object.freeze(copy)
}
// Digest of the ledger fields that decide dispatch and acceptance. plan covers
// the run row and submitted manifest; approval covers the per-ticket
// definitions (approved presets, verify IDs) and dependency edges.
function ledgerDigest(db) {
  const { run, tickets, dependencies } = db.integrity()
  return {
    mode: run.mode,
    plan: hash(
      JSON.stringify([run.runId, run.repo, run.ref, run.baseSha, run.parentId, run.policyHash, run.manifest]),
    ),
    approval: hash(
      JSON.stringify([
        tickets.map((t) => [t.id, t.position, t.definition]),
        dependencies.map((d) => [d.ticketId, d.upstream]),
      ]),
    ),
  }
}
function eventText(meta, event) {
  return '[dsh-ticket-dag ' + meta.runId + '] ' + event.message + '\nevent_id=' + event.eventId
}
function specPrompt(meta, row, upstream) {
  const stamp = [
    'DAG-Run: ' + meta.runId,
    'DAG-Ticket: ' + row.id,
    'DAG-Attempt: ' + row.attempt,
    'DAG-Complete: yes',
  ]
  return [
    'Implement this single ticket in the assigned Git worktree. Confirm git rev-parse --show-toplevel matches ' +
      row.path +
      ', and git branch --show-current matches ' +
      row.branch +
      ' before writing.',
    'Do not change branches, run the DAG control tools, modify other worktrees, or push. The coordinator alone integrates.',
    'Frozen base: ' + row.baseSha + '. Integrated dependencies: ' + JSON.stringify(upstream),
    row.attempt > 1
      ? 'This is a recovery attempt. Inspect the existing diff, git log, and tests. Preserve valid prior work; continue this ticket. Prior diagnostic: ' +
        (row.message || 'inspect the worktree')
      : '',
    'Ticket: ' + row.id + ' — ' + row.title,
    row.agentSpec?.instructions ? 'Role (' + row.agent + '): ' + row.agentSpec.instructions : '',
    row.prompt,
    'Acceptance: ' + JSON.stringify(row.acceptance) + '. Required check IDs: ' + JSON.stringify(row.verify),
    'When work is complete, commit all intended changes on this branch and leave git status clean. The final commit message must end with these four separate Git trailers (in a final paragraph). A WIP commit is not a completion receipt:',
    stamp.join('\n'),
    'After the commit, return the commit SHA and a short report.',
  ]
    .filter(Boolean)
    .join('\n\n')
}
async function stampedSource(meta, row) {
  const source = await git.verifySource(meta.repo, row.path, row.branch, row.baseSha)
  const body = (await git.readCommitMessage(meta.repo, source))
    .trimEnd()
    .split(/\r?\n\s*\r?\n/)
    .at(-1)
  const trailers = new Set(body.split(/\r?\n/))
  for (const wanted of [
    'DAG-Run: ' + meta.runId,
    'DAG-Ticket: ' + row.id,
    'DAG-Attempt: ' + row.attempt,
    'DAG-Complete: yes',
  ]) {
    requireValue(
      trailers.has(wanted),
      'Missing completion trailer: ' + wanted + '. Inspect the ticket branch before retrying.',
    )
  }
  return source
}
// Host child-agent route for one ticket; undefined keeps the host default.
function agentOptions(row) {
  const { provider, model, reasoningEffort } = row.agentSpec ?? {}
  if (!model) return undefined
  return { ...(provider && { provider }), model, ...(reasoningEffort && { reasoningEffort }) }
}
function modelRoute(row) {
  const options = agentOptions(row)
  return options ? [options.provider, options.model].filter(Boolean).join('/') : null
}

// A per-run asynchronous command queue. Long worker/model turns and test runs
// run outside this queue; mutations that grant ownership or publish a ref do not.
function serial(run, fn) {
  const op = run.serial.then(fn)
  run.serial = op.catch(() => {})
  return op
}
const dbFile = (repo, id) => join(repo.commonDir, 'dsh-ticket-dag', 'runs', safeId(id), 'state.sqlite')
function openWriter(directory) {
  const db = new DatabaseSync(join(directory, 'owner.sqlite'))
  try {
    db.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE')
    return db
  } catch (e) {
    db.close()
    throw new Error('Another DSH coordinator owns this run: ' + directory, { cause: e })
  }
}

export class Coordinator {
  constructor({
    launch,
    notify = async () => false,
    canRetry = async () => false,
    rememberRun,
    checks = {},
    agents = {},
    requireApproval = false,
    maxWorkers = 16,
    checkTimeoutMs = 120000,
    retryDelayMs = 1500,
    maxAutoRetries = 2,
  } = {}) {
    requireValue(typeof launch === 'function', 'A subagent launch adapter is required')
    requireValue(
      Number.isInteger(maxWorkers) && maxWorkers >= 1 && maxWorkers <= 32,
      'Host maxWorkers must be 1..32',
    )
    Object.assign(this, {
      launch,
      notify,
      canRetry,
      rememberRun,
      checks,
      agents,
      requireApproval,
      maxWorkers,
      checkTimeoutMs,
      retryDelayMs,
      maxAutoRetries,
    })
    this.runs = new Map()
    this.opening = new Map()
    this.activeCount = 0
    // Running workers per agent preset ID, across every run this coordinator owns.
    this.activeByAgent = new Map()
    this.stopping = false
  }

  // The cap is read from the live settings, like maxWorkers; 0 or a removed
  // preset leaves only the global and per-run limits.
  _presetFull(agent) {
    const cap = agent ? Number(this.agents[agent]?.maxConcurrent) || 0 : 0
    return cap > 0 && (this.activeByAgent.get(agent) ?? 0) >= cap
  }

  updateSettings({ checks, agents = this.agents, requireApproval = this.requireApproval, maxWorkers, checkTimeoutMs }) {
    requireValue(
      Number.isInteger(maxWorkers) && maxWorkers >= 1 && maxWorkers <= 32,
      'Host maxWorkers must be 1..32',
    )
    requireValue(
      Number.isInteger(checkTimeoutMs) && checkTimeoutMs >= 1 && checkTimeoutMs <= 2_147_483_647,
      'Invalid check timeout',
    )
    // Already-open runs retain their immutable verification command and agent
    // preset snapshots. A running worker or a verification process keeps its handle.
    Object.assign(this, { checks, agents, requireApproval, maxWorkers, checkTimeoutMs })
    for (const run of this.runs.values()) this._wake(run)
  }

  async start({ cwd, parentId, runId, manifest: input, checks = this.checks, maxWorkers }) {
    requireValue(
      !this.stopping && typeof parentId === 'string' && parentId.length,
      'A live captain is required',
    )
    const manifest = normalizeManifest(input, checks, this.agents)
    const id = safeId(runId ?? 'r-' + hash(parentId + '\0' + manifest.specId).slice(0, 20))
    const run = await this._open(
      { cwd, parentId, runId: id },
      { manifest, checks, mode: this.requireApproval ? 'staged' : 'active' },
    )
    const meta = run.db.meta()
    requireValue(
      JSON.stringify(meta.manifest) === JSON.stringify(manifest),
      'runId already has a different immutable manifest',
    )
    requireValue(
      meta.policyHash === policyHash(manifest, checks),
      'Verification registry changed for this run',
    )
    run.limit = Math.min(maxWorkers ?? manifest.maxWorkers, manifest.maxWorkers)
    this._wake(run)
    return this._snapshot(run)
  }

  async _open(query, seed) {
    requireValue(!this.stopping, 'Coordinator is stopping')
    const repo = await git.repoInfo(query.cwd)
    requireValue(!this.stopping, 'Coordinator is stopping')
    const file = dbFile(repo, query.runId)
    let run = this.runs.get(file)
    if (!run) {
      let op = this.opening.get(file)
      if (!op) {
        op = this._load(repo, file, query, seed).finally(() => this.opening.delete(file))
        this.opening.set(file, op)
      }
      run = await op
    }
    const meta = run.db.meta()
    requireValue(
      meta.parentId === query.parentId && meta.repo.commonDir === repo.commonDir,
      'Run belongs to a different captain or repository',
    )
    return run
  }

  async _load(repo, file, { parentId, runId }, seed) {
    if (!seed && !(await exists(file))) throw new Error('Unknown run: ' + runId)
    const dir = dirname(file)
    await mkdir(dir, { recursive: true })
    requireValue(!(await lstat(dir)).isSymbolicLink(), 'Refusing symbolic-link run directory')
    const owner = openWriter(dir)
    let db
    try {
      db = new RunStore(file)
      let meta = db.meta()
      const ref = 'refs/heads/integration/' + runId
      if (!meta) {
        requireValue(seed, 'Incomplete run, submit the original manifest')
        requireValue(!(await git.localRefExists(repo, ref)), 'Target integration branch already exists')
        const baseSha = await git.resolveRef(repo, seed.manifest.baseRef)
        meta = db.init({
          runId,
          parentId,
          ref,
          repo,
          baseSha,
          manifest: seed.manifest,
          policyHash: policyHash(seed.manifest, seed.checks),
          mode: seed.mode,
        })
      }
      requireValue(
        meta.parentId === parentId &&
          meta.runId === runId &&
          meta.ref === ref &&
          meta.repo.commonDir === repo.commonDir,
        'Run ownership mismatch',
      )
      if (seed) {
        requireValue(
          JSON.stringify(seed.manifest) === JSON.stringify(meta.manifest),
          'runId already has a different immutable manifest',
        )
        requireValue(
          policyHash(seed.manifest, seed.checks) === meta.policyHash,
          'Verification registry changed for this run',
        )
      }
      const initialized = join(dir, 'initialized')
      if (!(await exists(initialized))) {
        if (!(await git.localRefExists(repo, ref))) await git.initIntegration(meta.repo, ref, meta.baseSha)
        requireValue(
          (await git.resolveRef(repo, ref)) === meta.baseSha,
          'Interrupted initialization has an unexpected target tip',
        )
        await writeFile(initialized, meta.baseSha, { flag: 'wx' })
      }
      const root = join(
        dirname(meta.repo.root),
        '.dsh-ticket-worktrees',
        hash(meta.repo.commonDir).slice(0, 12),
        runId,
      )
      const run = {
        db,
        owner,
        file,
        root,
        checks: copyChecks(meta.manifest, seed?.checks ?? this.checks),
        limit: meta.manifest.maxWorkers,
        serial: Promise.resolve(),
        pump: null,
        again: false,
        work: new Map(),
        integration: null,
        notifier: null,
        timer: null,
        due: 0,
        safeChildren: new Set(),
        haltError: '',
        capacityUntil: 0,
        // What this process last wrote or loaded. A run loaded from disk takes
        // the ledger as found: an edit made while no coordinator was running
        // cannot be detected, and a non-staged run counts as approved.
        trust: { ...ledgerDigest(db), approved: meta.mode !== 'staged' },
      }
      for (const row of db.tickets()) {
        if (row.status === 'RUNNING')
          db.move(row.id, row.lease, 'RUNNING', 'NEEDS_ATTENTION', {
            message:
              'Coordinator restarted. Dag retry reconciles the recorded child, worktree and completion commit before takeover.',
          })
      }
      try {
        await this._reconcile(run, false)
        this._checkPolicy(run)
        await this._trustedTip(run)
      } catch (err) {
        this._hold(run, err)
      }
      this.runs.set(file, run)
      this.rememberRun?.(file, meta, db.startedAt())
      return run
    } catch (err) {
      db?.close()
      owner.close()
      throw err
    }
  }

  // An owner dashboard can only observe an already-attached run through this
  // method. It cannot attach to a repository or wake its scheduler.
  peek(file) {
    const run = this.runs.get(file)
    return run ? this._snapshot(run) : null
  }

  async attach({ cwd, parentId }) {
    if (this.stopping) return
    let repo
    try {
      repo = await git.repoInfo(cwd)
    } catch {
      return
    }
    const dir = dirname(dirname(dbFile(repo, 'probe')))
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (err) {
      if (err.code === 'ENOENT') return
      throw err
    }
    for (const e of entries) {
      if (this.stopping || !e.isDirectory() || !runPattern.test(e.name)) continue
      // Do not acquire or reconcile a different captain's runs.
      const file = dbFile(repo, e.name)
      if (!(await exists(file))) continue
      const reader = new DatabaseSync(file, { readOnly: true })
      let same
      try {
        same = reader.prepare('SELECT parentId FROM run WHERE singleton=1').get()?.parentId === parentId
      } finally {
        reader.close()
      }
      if (same) {
        const run = await this._open({ cwd, parentId, runId: e.name })
        this._wake(run)
      }
    }
  }

  // This grant is stored outside the worker checkout and exists before DSH can
  // materialize the child. Historical children retain their lookup record; the
  // live SQLite ticket always determines which execution still owns the work.
  async childAuthorization({ cwd, childId, parentId }) {
    if (!/^[a-f0-9-]{36}$/i.test(childId)) return 'unmanaged'
    let repo
    try {
      repo = await git.repoInfo(cwd)
    } catch {
      return 'unmanaged'
    }
    const index = join(repo.commonDir, 'dsh-ticket-dag', 'children', childId + '.json')
    let raw
    try {
      raw = await readFile(index, 'utf8')
    } catch (err) {
      if (err.code === 'ENOENT') return 'unmanaged'
      throw err
    }
    const saved = JSON.parse(raw)
    if (saved.parentId !== parentId || saved.childId !== childId || this.stopping) return 'retired'
    const file = dbFile(repo, saved.runId)
    const reader = new DatabaseSync(file, { readOnly: true })
    try {
      const row = reader.prepare('SELECT status,childId,lease FROM tickets WHERE id=?').get(saved.id)
      const run = reader.prepare('SELECT mode,parentId FROM run WHERE singleton=1').get()
      return run?.mode !== 'cancelled' &&
        run?.parentId === parentId &&
        row?.status === 'RUNNING' &&
        row.childId === childId &&
        row.lease === saved.lease
        ? 'authorized'
        : 'retired'
    } finally {
      reader.close()
    }
  }

  _checkPolicy(run) {
    const m = run.db.meta()
    requireValue(
      policyHash(m.manifest, run.checks) === m.policyHash,
      'Restore the trusted verification commands originally used by this run',
    )
  }
  async _trustedTip(run) {
    const m = run.db.meta(),
      actual = await git.resolveRef(m.repo, m.ref)
    requireValue(
      actual === m.tipSha,
      'Integration ref changed outside the verified ledger. Inspect ' +
        m.ref +
        ' (expected ' +
        m.tipSha +
        ', found ' +
        actual +
        ')',
    )
    return actual
  }
  _hold(run, err) {
    run.haltError = message(err)
    // A run the user never approved goes back to waiting for approval.
    run.db.hold(run.haltError, { staged: !run.trust.approved })
    run.trust.mode = run.db.meta()?.mode
    this._drainOutbox(run)
  }
  // Last resort for detached job promises: a failure while recording a failure
  // holds the run instead of surfacing as an unhandled rejection.
  _holdQuietly(run, err) {
    try {
      this._hold(run, err)
    } catch {
      run.haltError ||= message(err)
    }
  }
  _setMode(run, mode) {
    run.db.setMode(mode)
    run.trust.mode = run.db.meta().mode
  }
  // The SQLite ledger is writable by any local shell. Compare it with what this
  // process wrote or loaded before granting work or accepting a submission.
  _checkLedger(run) {
    const now = ledgerDigest(run.db),
      trust = run.trust
    const changed = ['mode', 'plan', 'approval'].filter((k) => now[k] !== trust[k])
    if (now.mode === 'active' && !trust.approved && !changed.includes('mode')) changed.push('mode')
    if (!changed.length) return
    const err = new Error(
      'The run ledger was modified outside the coordinator (' +
        changed.join(', ') +
        '). Dispatch and integration are held; restore ' +
        run.file +
        ' or start a new run.',
    )
    err.ledger = true
    this._hold(run, err)
    throw err
  }
  async _reconcile(run, publish = true) {
    const m = run.db.meta()
    for (const i of run.db.intents()) {
      const actual = await git.resolveRef(m.repo, m.ref)
      await git.assertMergeParents(m.repo, i.candidateSha, i.oldTip, i.sourceSha)
      if (actual === i.candidateSha) {
        requireValue(run.db.finish(i.id, i.lease, i.candidateSha), 'Cannot repair the published ledger')
      } else if (actual === i.oldTip) {
        if (m.mode === 'cancelled') {
          run.db.abandonIntent(i.id, i.lease)
          continue
        }
        if (m.mode !== 'active' || !publish) continue
        this._checkPolicy(run)
        await git.publishCandidate(m.repo, m.ref, i.oldTip, i.candidateSha)
        requireValue(run.db.finish(i.id, i.lease, i.candidateSha), 'Cannot finish recovered publication')
      } else throw new Error('Unrecognized target tip during publication recovery: ' + i.id)
    }
  }
  _snapshot(run) {
    const m = run.db.meta(),
      tickets = run.db.tickets()
    const counts = Object.create(null)
    for (const t of tickets) counts[t.status] = (counts[t.status] ?? 0) + 1
    return {
      runId: m.runId,
      specId: m.manifest.specId,
      mode: m.mode,
      complete: tickets.every((t) => t.status === 'INTEGRATED'),
      integrationRef: m.ref,
      verifiedSha: m.tipSha,
      maxWorkers: Math.min(this.maxWorkers, run.limit),
      counts,
      diagnostic: run.haltError || m.diagnostic || null,
      tickets: tickets.map(
        ({
          id,
          title,
          status,
          attempt,
          dependsOn,
          baseSha,
          sourceSha,
          landedSha,
          path,
          branch,
          childId,
          message,
          autoRetries,
          retryAt,
          agent,
          agentSpec,
        }) => ({
          id,
          title,
          status,
          agent: agent ?? null,
          model: modelRoute({ agentSpec }),
          route: {
            provider: agentSpec?.provider ?? '',
            model: agentSpec?.model ?? '',
            reasoningEffort: agentSpec?.reasoningEffort ?? '',
          },
          livePhase:
            status === 'RUNNING'
              ? (run.work.get(id)?.phase ?? null)
              : run.integration?.id === id && (status === 'SUBMITTED' || status === 'PUBLISHING')
                ? run.integration.phase
                : null,
          attempt,
          dependsOn,
          baseSha,
          sourceSha,
          landedSha,
          path,
          branch,
          childId,
          message,
          autoRetries,
          retryAt,
        }),
      ),
      pendingNotifications: run.db.pendingNotifications().length,
    }
  }
  async status(q) {
    const run = await this._open(q)
    this._wake(run)
    return this._snapshot(run)
  }
  async pause(q) {
    const run = await this._open(q)
    await serial(run, () => this._setMode(run, 'paused'))
    return this._snapshot(run)
  }
  async resume(q) {
    const run = await this._open(q)
    await serial(run, async () => {
      requireValue(run.db.meta().mode !== 'cancelled', 'A cancelled run is final')
      requireValue(
        run.db.meta().mode !== 'staged' && run.trust.approved,
        'This run is waiting for the user to approve it in the 「工单 · ' +
          run.db.meta().runId +
          '」 tab of the conversation right sidebar. It cannot be resumed from the conversation.',
      )
      this._checkLedger(run)
      this._checkPolicy(run)
      run.haltError = ''
      this._setMode(run, 'active')
      try {
        await this._reconcile(run)
        await this._trustedTip(run)
      } catch (err) {
        this._hold(run, err)
        throw err
      }
    })
    this._wake(run)
    return this._snapshot(run)
  }
  async retry(q) {
    const run = await this._open(q)
    await serial(run, async () => {
      const t = run.db.get(q.id),
        m = run.db.meta()
      requireValue(
        m.mode !== 'cancelled' && t?.status === 'NEEDS_ATTENTION',
        'Ticket must be in NEEDS_ATTENTION',
      )
      requireValue(
        !run.db.intents().some((i) => i.id === t.id),
        'Reconcile the open publication before retry',
      )
      requireValue(!run.work.has(t.id), 'Prior runner has not released this workspace')
      if (q.isolated === true) {
        requireValue(run.db.retry(t.id, { isolated: true }), 'Cannot queue isolated recovery')
        return
      }
      requireValue(
        run.safeChildren.has(t.childId) ||
          (await this.canRetry({
            parentId: m.parentId,
            childId: t.childId,
            cwd: t.path,
            runId: m.runId,
            ticketId: t.id,
          })),
        'Cannot prove the old child stopped. Stop it and retry, or request isolated recovery to a NEW directory from the frozen base; old files are retained.',
      )
      let adopt
      if (t.path && !t.sourceSha) {
        try {
          adopt = await stampedSource(m, t)
        } catch {
          /* Unstamped work is a resume candidate, never a success receipt. */
        }
      }
      if (adopt)
        requireValue(
          run.db.move(t.id, t.lease, 'NEEDS_ATTENTION', 'SUBMITTED', {
            sourceSha: adopt,
            message: 'Recovered the original completion commit; integration checks remain required',
          }),
          'Stale ticket',
        )
      else requireValue(run.db.retry(t.id), 'Ticket could not be retried')
    })
    this._wake(run)
    return this._snapshot(run)
  }
  async cancel(q) {
    const run = await this._open(q)
    await serial(run, async () => {
      this._setMode(run, 'cancelled')
      await this._reconcile(run, false)
    })
    const jobs = [...run.work.values()]
    for (const j of jobs) {
      j.ctrl.abort()
      if (j.handle) j.handle.dispose().catch(() => {})
    }
    run.integration?.ctrl.abort()
    await Promise.allSettled(jobs.map((j) => j.promise))
    this._wake(run)
    return this._snapshot(run)
  }

  /**
   * The user's approval of a staged run, from the board. Each choice names a
   * ticket and its preset (empty for none) plus provider/model/reasoningEffort;
   * tickets without a choice keep their planned preset. Presets resolve from
   * the current settings, except a planned preset since removed from them,
   * which keeps the copy frozen at dag_run; the result is frozen into the run.
   * @param file - the run ledger the board selected.
   * @param choices - per-ticket selections.
   * @returns the run snapshot after approval.
   */
  async approve(file, choices) {
    const run = this.runs.get(file)
    requireValue(run, 'Open the captain conversation of this run first')
    await serial(run, async () => {
      const m = run.db.meta()
      requireValue(m.mode === 'staged', 'This run is not waiting for approval')
      requireValue(Array.isArray(choices), 'choices must be an array')
      this._checkLedger(run)
      const byId = new Map(choices.map((c) => [c?.id, c]))
      const tickets = m.manifest.tickets.map((t) => {
        const c = byId.get(t.id)
        if (!c) return t
        const { agent, agentSpec: frozen, ...rest } = t
        // The planned preset may have left the settings since dag_run; its
        // frozen copy still describes the role.
        const preset = !c.agent
          ? {}
          : String(c.agent) === agent && !Object.hasOwn(this.agents, agent)
            ? (frozen ?? {})
            : agentSpec(this.agents, String(c.agent))
        const spec = preset.instructions ? { instructions: preset.instructions } : {}
        for (const field of ['provider', 'model', 'reasoningEffort']) {
          const value = String(c[field] ?? '').trim()
          if (value) spec[field] = value
        }
        requireValue(
          spec.model || !(spec.provider || spec.reasoningEffort),
          t.id + ' sets a provider or reasoning effort without a model',
        )
        return {
          ...rest,
          ...(c.agent && { agent: String(c.agent) }),
          ...(Object.keys(spec).length && { agentSpec: spec }),
        }
      })
      requireValue(run.db.approve(tickets), 'This run is not waiting for approval')
      const after = ledgerDigest(run.db)
      run.trust = { ...run.trust, mode: after.mode, approval: after.approval, approved: true }
      run.haltError = ''
      this._drainOutbox(run)
    })
    this._wake(run)
    return this._snapshot(run)
  }

  /**
   * The user's rejection of a staged plan, from the board.
   * @param file - the run ledger the board selected.
   * @returns the cancelled run snapshot.
   */
  async discard(file) {
    const run = this.runs.get(file)
    requireValue(run, 'Open the captain conversation of this run first')
    await serial(run, () => {
      requireValue(run.db.meta().mode === 'staged', 'This run is not waiting for approval')
      this._setMode(run, 'cancelled')
    })
    this._wake(run)
    return this._snapshot(run)
  }

  _later(run, at) {
    if (this.stopping || (run.timer && run.due <= at)) return
    clearTimeout(run.timer)
    run.due = at
    run.timer = setTimeout(
      () => {
        run.timer = null
        this._wake(run)
      },
      Math.max(5, at - Date.now()),
    )
    run.timer.unref?.()
  }
  _wake(run) {
    if (this.stopping) return
    if (run.pump) {
      run.again = true
      return
    }
    run.pump = serial(run, () => this._pump(run))
      .catch((err) => this._hold(run, err))
      .finally(() => {
        run.pump = null
        if (run.again) {
          run.again = false
          this._wake(run)
        }
      })
  }
  _drainOutbox(run) {
    if (run.notifier || !run.db.pendingNotifications().length) return
    run.notifier = (async () => {
      const m = run.db.meta()
      for (const e of run.db.pendingNotifications()) {
        if (this.stopping) break
        if (!(await this.notify({ parentId: m.parentId, eventId: e.eventId, text: eventText(m, e) }))) break
        run.db.ackNotification(e.eventId)
      }
    })()
      .catch(() => {})
      .finally(() => {
        run.notifier = null
        if (!this.stopping && run.db.pendingNotifications().length) this._later(run, Date.now() + 30000)
      })
  }
  async _pump(run) {
    if (this.stopping) return
    this._drainOutbox(run)
    this._checkLedger(run)
    const m = run.db.meta()
    if (m.mode !== 'active') return
    if (run.db.intents().length) await this._reconcile(run)
    const rows = run.db.tickets(),
      byId = new Map(rows.map((t) => [t.id, t]))
    const submitted = rows.find((t) => t.status === 'SUBMITTED')
    const ready = rows.filter(
      (t) => t.status === 'PENDING' && t.dependsOn.every((d) => byId.get(d)?.status === 'INTEGRATED'),
    )
    if (!submitted && !ready.length) return
    this._checkPolicy(run)
    const tip = await this._trustedTip(run)
    if (submitted && !run.integration) {
      const job = { id: submitted.id, phase: { stage: 'merge' }, ctrl: new AbortController() }
      run.integration = job
      job.promise = this._integrate(run, submitted, tip, job)
        .catch((err) => {
          // A held ledger leaves the submission as it was for inspection.
          if (err.ledger) return
          run.db.move(submitted.id, submitted.lease, 'SUBMITTED', 'NEEDS_ATTENTION', {
            message: message(err),
          })
        })
        .finally(() => {
          run.integration = null
          this._wake(run)
        })
        .catch((err) => this._holdQuietly(run, err))
    }
    for (const old of ready) {
      if (this.stopping || this.activeCount >= this.maxWorkers || run.work.size >= run.limit) break
      // A full preset holds back only its own tickets; later ready tickets may still start.
      if (this._presetFull(old.agent)) continue
      const wait = Math.max(old.retryAt ?? 0, run.capacityUntil)
      if (wait > Date.now()) {
        this._later(run, wait)
        continue
      }
      const base = old.baseSha ?? tip
      for (const dep of old.dependsOn) {
        requireValue(
          await git.isAncestor(m.repo, byId.get(dep).landedSha, base),
          'Frozen base misses accepted dependency ' + dep,
        )
      }
      const isolatedSuffix = old.attempt > 0 && !old.path ? '-r' + (old.attempt + 1) : ''
      const key = keyOf(old.id) + isolatedSuffix,
        childId = randomUUID()
      if (this.stopping || this.activeCount >= this.maxWorkers || run.work.size >= run.limit) break
      if (this._presetFull(old.agent)) continue
      const row = run.db.claim(old.id, {
        baseSha: base,
        childId,
        path: old.path ?? join(run.root, 'tickets', key),
        branch: old.branch ?? 'ticket/' + m.runId + '/' + key,
      })
      if (!row) continue
      const job = { ctrl: new AbortController(), handle: null, quiet: false, phase: { stage: 'worktree' } }
      run.work.set(row.id, job)
      this.activeCount++
      if (row.agent) this.activeByAgent.set(row.agent, (this.activeByAgent.get(row.agent) ?? 0) + 1)
      job.promise = this._execute(run, { ...row, message: old.message }, job)
        .catch((err) => this._failed(run, row, job, err))
        .finally(() => {
          this.activeCount--
          if (row.agent) this.activeByAgent.set(row.agent, this.activeByAgent.get(row.agent) - 1)
          run.work.delete(row.id)
          for (const other of this.runs.values()) this._wake(other)
        })
        .catch((err) => this._holdQuietly(run, err))
    }
  }

  async _execute(run, row, job) {
    const m = run.db.meta()
    const resume =
      row.attempt > 1 &&
      ((await exists(row.path)) || (await git.localRefExists(m.repo, 'refs/heads/' + row.branch)))
    let launching = false
    try {
      await git.prepareWorktree(m.repo, row.path, row.branch, row.baseSha, { resume })
      const { head } = await git.inspectWorktree(m.repo, row.path, row.branch, row.baseSha, { resume })
      const upstream = {}
      for (const dep of row.dependsOn) {
        const parent = run.db.get(dep)
        requireValue(
          parent.status === 'INTEGRATED' && (await git.isAncestor(m.repo, parent.landedSha, head)),
          'Worker checkout is missing ' + dep,
        )
        upstream[dep] = parent.landedSha
      }
      job.ctrl.signal.throwIfAborted()
      const index = join(m.repo.commonDir, 'dsh-ticket-dag', 'children')
      await mkdir(index, { recursive: true })
      await writeFile(
        join(index, row.childId + '.json'),
        JSON.stringify({
          runId: m.runId,
          parentId: m.parentId,
          id: row.id,
          childId: row.childId,
          lease: row.lease,
        }),
        { flag: 'wx', mode: 0o600 },
      )
      job.ctrl.signal.throwIfAborted()
      launching = true
      job.phase = { stage: 'launch' }
      const handle = await this.launch({
        parentId: m.parentId,
        childId: row.childId,
        cwd: row.path,
        prompt: specPrompt(m, row, upstream),
        agentOptions: agentOptions(row),
        signal: job.ctrl.signal,
        runId: m.runId,
        ticketId: row.id,
        attempt: row.attempt,
        baseSha: row.baseSha,
        branch: row.branch,
      })
      job.handle = handle
      job.phase = { stage: 'agent' }
      if (job.ctrl.signal.aborted) await handle.dispose()
      let result
      try {
        result = await handle.result
        job.phase = { stage: 'receipt' }
      } finally {
        await handle.dispose()
        job.quiet = true
      }
      requireValue(result?.ok, 'Worker ended without success: ' + String(result?.detail ?? 'unknown'))
      const sourceSha = await stampedSource(m, row)
      if (run.db.meta().mode === 'cancelled') throw new Error('Run cancelled')
      requireValue(
        run.db.move(row.id, row.lease, 'RUNNING', 'SUBMITTED', {
          sourceSha,
          message: 'Completion commit verified; waiting for integration',
        }),
        'Stale worker receipt',
      )
    } catch (err) {
      job.atCapacity = launching && !job.handle && err.code === capacityCode
      if (!launching || job.atCapacity) job.quiet = true
      throw err
    } finally {
      if (job.quiet) run.safeChildren.add(row.childId)
    }
  }

  async _failed(run, row, job, err) {
    const note = message(err),
      m = run.db.meta(),
      patch = { message: note }
    if (m.mode === 'cancelled') {
      run.db.move(row.id, row.lease, 'RUNNING', job.quiet ? 'CANCELLED' : 'NEEDS_ATTENTION', patch)
      return
    }
    if (!this.stopping && job.quiet && job.atCapacity) {
      run.capacityUntil = Date.now() + 1000
      run.db.move(row.id, row.lease, 'RUNNING', 'PENDING', patch)
      this._later(run, run.capacityUntil)
      return
    }
    if (!this.stopping && job.quiet && transient.test(String(err.code) + ' ' + note)) {
      // A lost acknowledgement may follow an already committed worker result.
      let sourceSha
      try {
        sourceSha = await stampedSource(m, row)
      } catch {}
      if (
        sourceSha &&
        run.db.move(row.id, row.lease, 'RUNNING', 'SUBMITTED', {
          sourceSha,
          message: 'Adopted completion after interrupted delivery',
        })
      )
        return
      const at =
        Date.now() +
        this.retryDelayMs * 2 ** (row.autoRetries ?? 0) +
        Math.floor((Math.random() * this.retryDelayMs) / 4)
      if (run.db.defer(row.id, row.lease, { at, message: note, maxRetries: this.maxAutoRetries })) {
        this._later(run, at)
        return
      }
    }
    run.db.move(row.id, row.lease, 'RUNNING', 'NEEDS_ATTENTION', patch)
  }

  async _integrate(run, row, tip, job) {
    await serial(run, () => this._checkLedger(run))
    const m = run.db.meta()
    const candidatePath = join(
      run.root,
      'candidates',
      keyOf(row.id) + '-' + row.attempt + '-' + tip.slice(0, 12),
    )
    const candidate = await git.buildCandidate(m.repo, candidatePath, tip, row.sourceSha)
    const checkIds = [
      ...new Set(
        [row, ...run.db.tickets().filter((t) => t.status === 'INTEGRATED')].flatMap((t) => t.verify),
      ),
    ]
    const commands = checkIds.flatMap((id) => run.checks[id].map((argv) => ({ id, argv })))
    const options = { signal: job.ctrl.signal, timeoutMs: this.checkTimeoutMs }
    for (const [index, { id, argv }] of commands.entries()) {
      job.phase = { stage: 'verify', checkId: id, index: index + 1, total: commands.length }
      await git.runChecks(candidatePath, [argv], options)
    }
    job.phase = { stage: 'publish' }
    await git.assertCandidate(m.repo, candidatePath, candidate)
    await serial(run, async () => {
      if (this.stopping || run.db.meta().mode !== 'active') return
      const t = run.db.get(row.id)
      if (t.status !== 'SUBMITTED' || t.lease !== row.lease || t.sourceSha !== row.sourceSha) return
      this._checkLedger(run)
      this._checkPolicy(run)
      await this._trustedTip(run)
      requireValue((await stampedSource(m, t)) === row.sourceSha, 'Worker branch moved after submission')
      for (const id of t.dependsOn) {
        const p = run.db.get(id)
        requireValue(
          p.status === 'INTEGRATED' && (await git.isAncestor(m.repo, p.landedSha, tip)),
          'Dependency changed before publication',
        )
      }
      await git.assertMergeParents(m.repo, candidate, tip, row.sourceSha)
      requireValue(
        run.db.intent(row.id, row.lease, { oldTip: tip, sourceSha: row.sourceSha, candidateSha: candidate }),
        'Could not record publication intent',
      )
      try {
        await git.publishCandidate(m.repo, m.ref, tip, candidate)
        requireValue(run.db.finish(row.id, row.lease, candidate), 'Ledger did not accept published candidate')
      } catch (err) {
        this._hold(run, err)
        throw err
      }
    })
    if (run.db.get(row.id).status === 'INTEGRATED') {
      try {
        await git.releaseCandidate(m.repo, candidatePath, candidate)
      } catch {
        /* Preserve checkout if cleanup cannot be proven safe. */
      }
    }
  }

  close() {
    if (!this.closeTask) this.closeTask = this._shutdown()
    return this.closeTask
  }

  async _shutdown() {
    this.stopping = true
    await Promise.allSettled([...this.opening.values()])
    const runs = [...this.runs.values()]
    // Stop admission first; wait for pumps to finish acquiring any work they already own.
    await Promise.allSettled(runs.map((r) => r.pump))
    const errors = []
    for (const r of runs) {
      try {
        clearTimeout(r.timer)
        r.integration?.ctrl.abort()
        for (const j of r.work.values()) {
          j.ctrl.abort()
          if (j.handle) Promise.resolve().then(() => j.handle.dispose()).catch(() => {})
        }
      } catch (err) {
        errors.push(err)
      }
    }
    // Each run releases its ledger and ownership lock even if another run fails to.
    for (const r of runs) {
      try {
        await Promise.allSettled(
          [...r.work.values()].map((j) => j.promise).concat([r.integration?.promise, r.notifier]),
        )
        await r.serial
      } catch (err) {
        errors.push(err)
      } finally {
        for (const release of [() => r.db.close(), () => r.owner.close()]) {
          try {
            release()
          } catch (err) {
            errors.push(err)
          }
        }
      }
    }
    this.runs.clear()
    if (errors.length) throw new AggregateError(errors, 'Some runs did not close cleanly')
  }
}
