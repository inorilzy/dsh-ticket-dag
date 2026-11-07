import { createHash, randomUUID } from 'node:crypto'
import { access, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import * as git from './git.mjs'
import { fileOverlaps, selectChecks, undeclaredFiles } from './selection.mjs'
import {
  agentSpec,
  END_MODES,
  integrationOf,
  ledgerSnapshot,
  maxFinalRepairsOf,
  normalizeAppend,
  normalizeManifest,
  RunStore,
  trainSizeOf,
  WORKER_MODES,
} from './store.mjs'
import { runTiming } from './timing.mjs'
import { repairAgent } from './agents.mjs'

const hash = (text) => createHash('sha256').update(text).digest('hex')
const message = (err) => String(err?.message ?? err).slice(-3500)
const keyOf = (id) => 't-' + hash(id).slice(0, 24)
const transient =
  /\b(TRANSPORT|TIMEOUT|ECONNRESET|ETIMEDOUT|STREAM_CLOSED|RATE_LIMIT)\b|unexpected EOF|before a terminal event/i
const capacityCode = 'ACTIVATION_LIMIT_REACHED'
const runPattern = /^[a-z0-9][a-z0-9_-]{0,62}$/
// End modes defer every non-fast check to one final full check of the integrated tip.
const endMode = (manifest) => END_MODES.has(integrationOf(manifest).mode)
// Worker modes check every submitted commit in a probe before the lane takes it.
const workerMode = (manifest) => WORKER_MODES.has(integrationOf(manifest).mode)
// The merge train verifies several submissions at once on a chain of merges.
const trainMode = (manifest) => integrationOf(manifest).mode === 'train'
const usedChecks = (tickets) => [...new Set(tickets.flatMap((t) => t.verify))]
// Whether the frozen plan marked any check fast; an end-mode lane relies on it.
const hasFastCheck = (manifest) => Object.values(manifest?.checkMeta ?? {}).some((entry) => entry?.fast === true)

function requireValue(test, text, code) {
  if (!test) {
    const error = new Error(text)
    if (code) error.code = code
    throw error
  }
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
// A manifest or a dag_add batch: anything with tickets.
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
// Profile checks plus the checks the captain wrote into the manifest; a
// manifest check cannot reuse a profile ID, so neither shadows the other.
function registryOf(profile, manifest) {
  return { ...profile, ...(manifest?.checks ?? {}) }
}
// Manifest checks no approval covers and no ticket of the run uses. A run
// approved before the review listed unused checks never showed them to the user.
function unapprovedChecks(db, meta, used) {
  if (meta.mode === 'staged') return []
  const approved = new Set(db.approvedChecks())
  return Object.keys(meta.manifest.checks ?? {}).filter((id) => !approved.has(id) && !Object.hasOwn(used, id))
}
// Every ticket a run will verify: the submitted manifest plus each dag_add batch.
function runTickets(db, meta = db.meta()) {
  return { tickets: [...meta.manifest.tickets, ...db.appended().flatMap((b) => b.tickets)] }
}
// Digest of the ledger fields that decide dispatch and acceptance. plan covers
// the run row and submitted manifest; approval covers the per-ticket
// definitions (approved presets, verify IDs), dependency edges, append records
// and which manifest checks the approval covered. The arrays come from
// store.ledgerSnapshot so this digest and planRevision hash the same rows.
function ledgerDigest(db) {
  const integrity = db.integrity()
  const snapshot = ledgerSnapshot(integrity)
  return {
    mode: integrity.run.mode,
    plan: hash(JSON.stringify(snapshot.run)),
    approval: hash(
      JSON.stringify([snapshot.tickets, snapshot.dependencies, snapshot.appended, snapshot.approvals]),
    ),
  }
}
function eventText(meta, event, review = '') {
  return '[dsh-ticket-dag ' + meta.runId + '] ' + event.message + (review ? '\n\n' + review : '') + '\nevent_id=' + event.eventId
}
// With reviewOnComplete, the first completion notice asks the captain for one
// review round; later completions (the appended fixes landing) say it is done.
function reviewText(meta, first) {
  const branch = meta.ref.replace(/^refs\/heads\//, '')
  return first
    ? 'Review step: run the code-review skill on this run before reporting. Fixed point ' + meta.baseSha +
        '; review ' + branch + ' rather than HEAD: git diff ' + meta.baseSha + '...' + branch +
        ' and git log ' + meta.baseSha + '..' + branch + '. Use the spec this run was built from. ' +
        'Turn each finding you accept into a small fix ticket and add it with dag_add to runId ' + meta.runId +
        ' (verify may name only check IDs this run already uses). Write down why for each finding you do not fix. ' +
        'If nothing needs fixing, report to the user now.'
    : 'Review fixes are integrated. This run had its review round; report to the user without reviewing again.'
}
// Rules every worker follows whatever its preset, so a preset only adds its role.
function workerRules(row) {
  return [
    'Working rules:',
    '- Do only what this ticket asks, with the smallest change that does it. Follow the naming, error handling, imports and test style already in the repository. Do not add an abstraction for logic used once, and do not refactor neighbouring code.',
    row.files?.length
      ? '- This ticket declares the files it changes: ' + JSON.stringify(row.files) +
        '. Stay inside them; if the work truly needs another file, change it and name it with the reason in your report.'
      : '',
    '- A behavior change comes with a test that proves it. Put new tests in a new test file named for this ticket rather than appending to a large shared test file, so parallel tickets do not conflict.',
    '- When a test fails, fix the cause in the code under test. Do not weaken assertions, skip tests or special-case the test. Remove temporary debug output before committing.',
    '- Report only results you ran and saw, with the command; never "should pass". After three failed attempts at the same problem, stop and report what you tried and where it is stuck.',
  ]
    .filter(Boolean)
    .join('\n')
}
function specPrompt(meta, row, upstream) {
  const stamp = [
    'DAG-Run: ' + meta.runId,
    'DAG-Ticket: ' + row.id,
    'DAG-Attempt: ' + row.attempt,
    'DAG-Complete: yes',
  ]
  const branch = meta.ref.replace(/^refs\/heads\//, '')
  const conflicted = row.attempt > 1 && /^Trial merge conflicts with the integration tip/.test(row.message ?? '')
  return [
    'Implement this single ticket in the assigned Git worktree. Confirm git rev-parse --show-toplevel matches ' +
      row.path +
      ', and git branch --show-current matches ' +
      row.branch +
      ' before writing.',
    'Do not change branches, run the DAG control tools, modify other worktrees, or push. The coordinator alone integrates.',
    'Frozen base: ' + row.baseSha + '. Integrated dependencies: ' + JSON.stringify(upstream),
    conflicted
      ? 'Your previous completion conflicted with the integration branch. ' + row.message +
        '. Run git merge ' + branch + ' in this worktree, resolve every conflict keeping both your change and the integrated work, run the tests, and commit the merge with the trailers below. Do not redo the ticket from scratch.'
      : row.attempt > 1
        ? 'This is a recovery attempt. Inspect the existing diff, git log, and tests. Preserve valid prior work; continue this ticket. Prior diagnostic: ' +
          (row.message || 'inspect the worktree')
        : '',
    'Ticket: ' + row.id + ' — ' + row.title,
    row.agentSpec?.instructions ? 'Role (' + row.agent + '): ' + row.agentSpec.instructions : '',
    row.prompt,
    workerRules(row),
    'Acceptance: ' + JSON.stringify(row.acceptance) + '. ' +
      (row.verify.length
        ? 'Required check IDs: ' + JSON.stringify(row.verify) +
          (workerMode(meta.manifest)
            ? ' (the coordinator runs all of them on your commit as soon as you commit, before it may integrate it' +
              (endMode(meta.manifest)
                ? ', and all of them once more after every ticket is integrated'
                : ', and again at integration only if the integration branch moved since') +
              '. Before committing, always merge the latest integration branch ' + branch +
              ' so those checks cover it, and run them yourself.)'
            : endMode(meta.manifest)
            ? ' (the coordinator runs the fast ones when it integrates your commit and all of them once every ticket is integrated, so run them yourself before committing).'
            : ' (the coordinator runs them after you commit).')
        : 'No automatic check is attached: the coordinator only trial-merges your commit, so test your own change before committing.'),
    'Before the final commit, run git merge ' +
      branch +
      ' so your branch contains the latest integrated work, resolve any conflict, and rerun the tests; the coordinator trial-merges against that branch.',
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
// Read without acquiring the owner lock, so a scan never touches another captain's run.
function ledgerOwner(file) {
  try {
    const reader = new DatabaseSync(file, { readOnly: true })
    try {
      return reader.prepare('SELECT parentId FROM run WHERE singleton=1').get()?.parentId
    } finally {
      reader.close()
    }
  } catch (e) {
    throw new Error('Cannot read the run ledger ' + file + ': ' + message(e), { cause: e })
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
    autoCleanup = true,
    maxAppendedTickets = 20,
    maxWorkers = 16,
    checkTimeoutMs = 120000,
    retryDelayMs = 1500,
    maxAutoRetries = 2,
    maxConflictRetries = 2,
    trackerWriteback = 'off',
    reviewOnComplete = false,
    integrationMode = 'each',
    selectChecksByFiles = false,
    checkMeta = {},
    maxFinalRepairs = 2,
    trainSize = 4,
    validateRoutes,
    writeback,
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
      autoCleanup,
      maxAppendedTickets,
      maxWorkers,
      checkTimeoutMs,
      retryDelayMs,
      maxAutoRetries,
      maxConflictRetries,
      trackerWriteback,
      reviewOnComplete,
      integrationMode,
      selectChecksByFiles,
      checkMeta,
      maxFinalRepairs,
      trainSize,
      validateRoutes,
      writeback,
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

  updateSettings({
    checks,
    agents = this.agents,
    requireApproval = this.requireApproval,
    autoCleanup = this.autoCleanup,
    maxAppendedTickets = this.maxAppendedTickets,
    maxWorkers,
    checkTimeoutMs,
    trackerWriteback = this.trackerWriteback,
    reviewOnComplete = this.reviewOnComplete,
    integrationMode = this.integrationMode,
    selectChecksByFiles = this.selectChecksByFiles,
    checkMeta = this.checkMeta,
    maxFinalRepairs = this.maxFinalRepairs,
    trainSize = this.trainSize,
  }) {
    requireValue(
      Number.isInteger(maxWorkers) && maxWorkers >= 1 && maxWorkers <= 32,
      'Host maxWorkers must be 1..32',
    )
    requireValue(
      Number.isInteger(checkTimeoutMs) && checkTimeoutMs >= 1 && checkTimeoutMs <= 2_147_483_647,
      'Invalid check timeout',
    )
    requireValue(Number.isInteger(maxAppendedTickets) && maxAppendedTickets >= 0, 'Invalid maxAppendedTickets')
    // Already-open runs retain their immutable verification command and agent
    // preset snapshots, and the integration settings frozen in their manifest.
    // A running worker or a verification process keeps its handle.
    Object.assign(this, {
      checks,
      agents,
      requireApproval,
      autoCleanup,
      maxAppendedTickets,
      maxWorkers,
      checkTimeoutMs,
      trackerWriteback,
      reviewOnComplete,
      integrationMode,
      selectChecksByFiles,
      checkMeta,
      maxFinalRepairs,
      trainSize,
    })
    for (const run of this.runs.values()) this._wake(run)
  }

  async start({ cwd, parentId, runId, manifest: input, checks = this.checks, maxWorkers }) {
    requireValue(
      !this.stopping && typeof parentId === 'string' && parentId.length,
      'A live captain is required',
    )
    const manifest = normalizeManifest(input, checks, this.agents, {
      integrationMode: this.integrationMode,
      selectChecksByFiles: this.selectChecksByFiles,
      checkMeta: this.checkMeta,
      maxFinalRepairs: this.maxFinalRepairs,
      trainSize: this.trainSize,
    })
    const id = safeId(runId ?? 'r-' + hash(parentId + '\0' + manifest.specId).slice(0, 20))
    // Commands the captain wrote run only after the user approves them, even
    // with requireApproval off.
    const mode = this.requireApproval || manifest.checks ? 'staged' : 'active'
    const run = await this._open({ cwd, parentId, runId: id }, { manifest, checks, mode })
    const meta = run.db.meta()
    requireValue(
      JSON.stringify(meta.manifest) === JSON.stringify(manifest),
      'runId already has a different immutable manifest',
    )
    requireValue(
      meta.policyHash === policyHash(manifest, registryOf(checks, manifest)),
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
          policyHash: policyHash(seed.manifest, registryOf(seed.checks, seed.manifest)),
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
          policyHash(seed.manifest, registryOf(seed.checks, seed.manifest)) === meta.policyHash,
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
        checks: copyChecks(runTickets(db, meta), registryOf(seed?.checks ?? this.checks, meta.manifest)),
        limit: db.workerLimit(),
        serial: Promise.resolve(),
        pump: null,
        again: false,
        work: new Map(),
        integration: null,
        // Worker-side checks in flight, by ticket ID; at most run.limit of them.
        verifying: new Map(),
        // Probe checkouts that could not be created, by ticket: { tries, at } for a bounded delayed retry.
        probeRetry: new Map(),
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
  // Only the selected run passes now: its timing reads every event of the ledger.
  peek(file, now) {
    const run = this.runs.get(file)
    if (!run) return null
    return now === undefined ? this._snapshot(run) : { ...this._snapshot(run), timing: runTiming(run.db.events(), now) }
  }

  /**
   * The recovery scan: take over every run of this captain in the repository.
   * One run failing (owner lock held elsewhere, corrupt ledger, failed load)
   * is reported and the scan goes on. A ledger too damaged to name its captain
   * is reported to every captain scanning the repository.
   * @returns { attached: runId[], failures: { runId, error }[] }
   */
  async attach({ cwd, parentId }) {
    const report = { attached: [], failures: [] }
    if (this.stopping) return report
    let repo
    try {
      repo = await git.repoInfo(cwd)
    } catch {
      return report
    }
    const dir = dirname(dirname(dbFile(repo, 'probe')))
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (err) {
      if (err.code === 'ENOENT') return report
      throw err
    }
    for (const e of entries) {
      if (this.stopping || !e.isDirectory() || !runPattern.test(e.name)) continue
      // The ledger path is known before opening, so a failure can name the file
      // the board should show as unreadable alongside the diagnostic.
      const file = dbFile(repo, e.name)
      try {
        // Do not acquire or reconcile a different captain's runs.
        if (!(await exists(file)) || ledgerOwner(file) !== parentId) continue
        const run = await this._open({ cwd, parentId, runId: e.name })
        this._wake(run)
        report.attached.push(e.name)
      } catch (err) {
        report.failures.push({ runId: e.name, error: message(err), file })
      }
    }
    return report
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
      policyHash(m.manifest, run.checks) === m.policyHash &&
        run.db.appended().every((b) => policyHash(b, run.checks) === b.policyHash),
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
    const m = run.db.meta(),
      open = run.db.intents()
    for (const i of open) {
      const actual = await git.resolveRef(m.repo, m.ref)
      await git.assertMergeParents(m.repo, i.candidateSha, i.oldTip, i.sourceSha)
      const complete = { complete: !endMode(m.manifest) }
      if (actual === i.candidateSha) {
        requireValue(run.db.finish(i.id, i.lease, i.candidateSha, complete), 'Cannot repair the published ledger')
        this._writeback(run, i.id)
      } else if (actual === i.oldTip) {
        if (m.mode === 'cancelled') {
          run.db.abandonIntent(i.id, i.lease)
          continue
        }
        if (m.mode !== 'active' || !publish) continue
        this._checkPolicy(run)
        await git.publishCandidate(m.repo, m.ref, i.oldTip, i.candidateSha)
        requireValue(run.db.finish(i.id, i.lease, i.candidateSha, complete), 'Cannot finish recovered publication')
        this._writeback(run, i.id)
      } else throw new Error('Unrecognized target tip during publication recovery: ' + i.id)
    }
    // A final run has nothing else to recover: its open publication was what the diagnostic warned about.
    if (m.mode === 'cancelled' && open.length) {
      run.haltError = ''
      run.db.clearDiagnostic()
    }
  }
  _snapshot(run) {
    const m = run.db.meta(),
      tickets = run.db.tickets(),
      unapproved = unapprovedChecks(run.db, m, run.checks)
    const appendedAt = new Map(run.db.appended().flatMap((b) => b.tickets.map((t) => [t.id, b.createdAt])))
    const planCommands = Object.entries(m.manifest.checks ?? {}).filter(([id]) => !unapproved.includes(id))
    const counts = Object.create(null)
    for (const t of tickets) counts[t.status] = (counts[t.status] ?? 0) + 1
    const workerResults = run.db.workerResults()
    const undeclared = run.db.undeclaredResults()
    return {
      runId: m.runId,
      specId: m.manifest.specId,
      mode: m.mode,
      // An end-mode run completes only once the final full check passed at its tip.
      complete:
        tickets.every((t) => t.status === 'INTEGRATED') && (!endMode(m.manifest) || run.db.finalVerified(m.tipSha)),
      // The settings frozen at dag_run, not the live profile.
      integration: integrationOf(m.manifest),
      // The final full check or its bisection while it runs: { stage, checkId, index, total }.
      finalPhase: run.integration?.final ? run.integration.phase : null,
      // A merge train while it runs: { size, stage, checkId, index, total, step? }.
      trainPhase: run.integration?.train ? { size: run.integration.size, ...run.integration.phase } : null,
      integrationRef: m.ref,
      verifiedSha: m.tipSha,
      // The opaque version of the plan the review is showing. Sending it back
      // with approval lets the serial region refuse an approval of an older plan.
      revision: run.db.revision(this.agents),
      maxWorkers: Math.min(this.maxWorkers, run.limit),
      counts,
      cleanup: {
        cleaned: tickets.filter((t) => t.cleanup === 'cleaned').length,
        skipped: tickets.filter((t) => t.cleanup === 'skipped').length,
      },
      diagnostic: run.haltError || m.diagnostic || null,
      // What the user approves: every check command the captain wrote, used or
      // not, the profile commands the run uses, and each ticket's check IDs.
      checks: { ...Object.fromEntries(planCommands), ...run.checks },
      planChecks: Object.keys(m.manifest.checks ?? {}),
      unapprovedChecks: unapproved,
      // Unfinished ticket pairs that may run together and declare overlapping
      // files: a warning to split or order them, never a refusal.
      fileOverlaps: fileOverlaps(tickets),
      tickets: tickets.map(
        ({
          id,
          title,
          status,
          attempt,
          dependsOn,
          verify,
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
          cleanup,
          cleanupReason,
          source,
          files,
        }) => ({
          id,
          title,
          status,
          source: source ?? null,
          files: files ?? [],
          // Files the current submitted commit changed outside files: { sourceSha, files }.
          // A note about an earlier attempt's commit no longer applies.
          undeclaredFiles: undeclared.get(id)?.sourceSha === sourceSha ? undeclared.get(id) : null,
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
              : (run.integration?.id === id || run.integration?.ids?.includes(id)) &&
                  (status === 'SUBMITTED' || status === 'PUBLISHING')
                ? run.integration.phase
                : status === 'SUBMITTED'
                  ? (run.verifying.get(id)?.phase ?? null)
                  : null,
          // Worker modes: the latest worker-side result { sourceSha, coveredTip, ok, failed }.
          workerVerify: workerResults.get(id) ?? null,
          attempt,
          dependsOn,
          verify,
          baseSha,
          sourceSha,
          landedSha,
          path,
          branch,
          childId,
          message,
          autoRetries,
          retryAt,
          cleanup: cleanup ?? null,
          cleanupReason: cleanupReason ?? null,
          appended: appendedAt.has(id),
          appendedAt: appendedAt.get(id) ?? null,
        }),
      ),
      pendingNotifications: run.db.pendingNotifications().length,
      pendingPublications: run.db.intents(),
    }
  }
  async status(q) {
    const run = await this._open(q)
    this._wake(run)
    const now = Date.now()
    return { ...this._snapshot(run), timing: runTiming(run.db.events(), now), now }
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
      // A stamped commit for the current attempt that is not the one already
      // tried (for example the captain's conflict merge) is submitted directly.
      let adopt
      if (t.path) {
        try {
          const head = await stampedSource(m, t)
          if (head !== t.sourceSha) adopt = head
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
  /**
   * The captain's dag_cancel. Once the ledger says cancelled, workers and checks
   * stop whether or not Git can be reconciled. Repeating it sends the stop again
   * and retries an open publication: a published one is accounted, an unpublished
   * one is abandoned, and one that cannot be proven either way stays on record.
   * @returns the run snapshot; reconcileError is null once nothing failed to settle.
   */
  async cancel(q) {
    const run = await this._open(q)
    await serial(run, () => this._setMode(run, 'cancelled'))
    const jobs = [...run.work.values(), ...run.verifying.values(), run.integration].filter(Boolean)
    for (const j of jobs) {
      j.ctrl.abort()
      if (j.handle) Promise.resolve().then(() => j.handle.dispose()).catch(() => {})
    }
    const reconcileError = await serial(run, async () => {
      try {
        await this._reconcile(run, false)
        return null
      } catch (err) {
        this._holdQuietly(run, err)
        return message(err)
      }
    })
    await Promise.allSettled(jobs.map((j) => j.promise))
    this._wake(run)
    return { ...this._snapshot(run), reconcileError }
  }

  /**
   * The captain's dag_cleanup: remove the recorded worktree and branch of every
   * integrated ticket of a run, including an ended one. Cleaned tickets stay
   * cleaned; skipped ones are tried again.
   * @returns the run snapshot with one { id, status, reason } result per ticket.
   */
  async cleanup(q) {
    const run = await this._open(q)
    const results = await serial(run, () => this._cleanup(run, true))
    return { ...this._snapshot(run), results }
  }

  /**
   * The captain's dag_add: append tickets to a run without another approval.
   * Each ticket follows the dag_run rules; a preset the user already approved
   * for a member of this run keeps the user's route, any other resolves from
   * the current settings. A staged run takes them into the plan under review.
   * @returns the run snapshot; an identical repeated batch changes nothing.
   */
  async add(q) {
    const run = await this._open(q)
    await serial(run, () => {
      requireValue(run.db.meta().mode !== 'cancelled', 'A cancelled run cannot take more tickets; start a new run')
      this._checkLedger(run)
      // Frozen commands win over the current settings for check IDs the run already uses.
      // A batch may reuse the manifest's own checks but cannot bring new commands:
      // appended tickets skip the user's review.
      const registry = registryOf(this.checks, run.db.meta().manifest)
      const tickets = normalizeAppend(q.tickets, { ...registry, ...run.checks }, this.agents)
      const unapproved = unapprovedChecks(run.db, run.db.meta(), run.checks)
      for (const t of tickets) {
        const id = t.verify.find((name) => unapproved.includes(name))
        requireValue(
          !id,
          t.id + ': check ' + id + ' was not shown when this run was approved, so dag_add cannot use it; start a new run',
        )
      }
      const approval = run.db.events().find((e) => e.type === 'run_approved')
      if (approval) {
        const late = new Set(
          run.db
            .appended()
            .filter((b) => b.createdAt > approval.createdAt)
            .flatMap((b) => b.tickets.map((t) => t.id)),
        )
        const approved = run.db.tickets().filter((t) => !late.has(t.id))
        for (const t of tickets) {
          const chosen = t.agent && approved.find((a) => a.agent === t.agent)
          if (!chosen) continue
          const spec = t.agentSpec.instructions ? { instructions: t.agentSpec.instructions } : {}
          for (const field of ['provider', 'model', 'reasoningEffort'])
            if (chosen.agentSpec?.[field]) spec[field] = chosen.agentSpec[field]
          t.agentSpec = spec
        }
      }
      const checks = Object.freeze({ ...copyChecks({ tickets }, registry), ...run.checks })
      const result = run.db.append(tickets, {
        policyHash: policyHash({ tickets }, checks),
        limit: this.maxAppendedTickets,
      })
      if (!result.added) return
      run.checks = checks
      // The ledger now holds this append; it is the new trusted state.
      const after = ledgerDigest(run.db)
      run.trust = { ...run.trust, plan: after.plan, approval: after.approval }
    })
    this._wake(run)
    return this._snapshot(run)
  }

  // Due once every ticket is integrated and the completion notice reached the captain.
  _cleanupDue(run, rows) {
    if (!this.autoCleanup || !rows.length || !rows.every((t) => t.status === 'INTEGRATED')) return false
    if (!rows.some((t) => !t.cleanup) || run.db.pendingNotifications().length) return false
    return run.db.events().some((e) => e.type === 'run_completed')
  }

  // Only the ledger's own path and branch of an INTEGRATED ticket in a run
  // that was not cancelled; git.cleanupWorktree refuses anything else.
  async _cleanup(run, manual) {
    const m = run.db.meta()
    const results = []
    for (const t of run.db.tickets()) {
      if (m.mode === 'cancelled') {
        results.push({ id: t.id, status: 'skipped', reason: 'run cancelled' })
        continue
      }
      if (t.status !== 'INTEGRATED') {
        results.push({ id: t.id, status: 'skipped', reason: 'ticket is ' + t.status })
        continue
      }
      if (t.cleanup === 'cleaned' || (t.cleanup && !manual) || this.stopping) {
        results.push({ id: t.id, status: t.cleanup ?? 'skipped', reason: t.cleanupReason ?? undefined })
        continue
      }
      let result
      if (!t.path || !t.branch) result = { status: 'skipped', reason: 'no recorded worktree' }
      else {
        try {
          result = await git.cleanupWorktree(m.repo, {
            path: t.path,
            branch: t.branch,
            target: m.ref,
            baseRef: m.manifest.baseRef,
            root: run.root,
          })
        } catch (err) {
          result = { status: 'skipped', reason: 'refused: ' + message(err) }
        }
      }
      run.db.recordCleanup(t.id, result.status, result.reason ?? null)
      results.push({ id: t.id, ...result })
    }
    return results
  }

  /**
   * The user's approval of a staged run, from the board. Each choice names a
   * ticket and its preset (empty for none) plus provider/model/reasoningEffort;
   * tickets without a choice keep their planned preset. Presets resolve from
   * the current settings, except a planned preset since removed from them,
   * which keeps the copy frozen at dag_run; the result is frozen into the run.
   * The approval must name the revision of the plan the user saw: a missing or
   * stale revision is refused before anything is dispatched, so a plan that
   * changed after review (an appended ticket, a concurrent approval) can only
   * start after the user refreshes and confirms the current plan again.
   * @param file - the run ledger the board selected.
   * @param choices - per-ticket selections.
   * @param options.maxWorkers - the user's concurrency for this run, replacing the manifest's.
   * @param options.revision - the opaque plan revision the board showed the user.
   * @returns the run snapshot after approval.
   */
  async approve(file, choices, { maxWorkers, revision } = {}) {
    const run = this.runs.get(file)
    requireValue(run, 'Open the captain conversation of this run first')
    await serial(run, async () => {
      const m = run.db.meta()
      requireValue(m.mode === 'staged', 'This run is not waiting for approval')
      requireValue(Array.isArray(choices), 'choices must be an array')
      this._checkLedger(run)
      // The plan changes whenever a ticket is appended or a frozen command and
      // its approval record change. Refuse a request that names any other plan.
      requireValue(
        typeof revision === 'string' && revision.length > 0,
        'This approval did not include the revision of the plan you reviewed. ' +
          'Refresh the plan and confirm again; if you are on an older client, upgrade before approving a staged plan.',
        'missing-revision',
      )
      requireValue(
        revision === run.db.revision(this.agents),
        'The plan changed after you reviewed it (a ticket was appended, the approved checks changed, or an effective preset changed). ' +
          'Refresh the plan and confirm the current version again.',
        'stale-revision',
      )
      // A choice may only name a ticket of the plan, once each. Unknown or
      // duplicate IDs are a malformed request, not a grant to start anything.
      const planIds = new Set(run.db.plan().map((t) => t.id))
      const named = new Set()
      for (const c of choices) {
        requireValue(
          c !== null && typeof c === 'object' && !Array.isArray(c),
          'Each approval choice must be an object',
        )
        requireValue(typeof c.id === 'string' && c.id.length > 0, 'Each approval choice must name a ticket ID')
        requireValue(!named.has(c.id), 'Duplicate ticket ID in approval: ' + c.id)
        requireValue(planIds.has(c.id), 'Unknown ticket ID in approval: ' + c.id)
        named.add(c.id)
      }
      const byId = new Map(choices.map((c) => [c.id, c]))
      const tickets = run.db.plan().map((t) => {
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
      // Every actually-effective route (including a preset the user kept) must
      // resolve before any worker starts. The host injects the catalog check.
      if (this.validateRoutes) await this.validateRoutes(tickets)
      requireValue(run.db.approve(tickets, { maxWorkers }), 'This run is not waiting for approval')
      run.limit = run.db.workerLimit()
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
      let delivered = false
      for (const e of run.db.pendingNotifications()) {
        if (this.stopping) break
        let review = ''
        if (e.type === 'run_completed' && this.reviewOnComplete) {
          const first = run.db.events().find((x) => x.type === 'run_completed')
          review = reviewText(m, first?.id === e.eventId)
        }
        if (!(await this.notify({ parentId: m.parentId, eventId: e.eventId, text: eventText(m, e, review) }))) break
        run.db.ackNotification(e.eventId)
        delivered = true
      }
      // A delivered completion notice can make worktree cleanup due.
      if (delivered && !this.stopping) this._wake(run)
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
    // Restart, resume and a landed fix all reach this same test, so the final
    // check runs again for every integrated tip it has not passed at.
    if (
      endMode(m.manifest) &&
      rows.length &&
      rows.every((t) => t.status === 'INTEGRATED') &&
      !run.db.finalVerified(m.tipSha)
    ) {
      if (run.integration) return
      this._checkPolicy(run)
      const tip = await this._trustedTip(run)
      const job = { id: null, final: true, phase: { stage: 'final' }, ctrl: new AbortController() }
      run.integration = job
      job.promise = this._finalVerify(run, tip, job)
        .catch((err) => {
          // Cancel and shutdown stop the check; a held ledger already says why.
          if (job.ctrl.signal.aborted || this.stopping || err.ledger) return
          return serial(run, () => this._hold(run, err))
        })
        .finally(() => {
          run.integration = null
          this._wake(run)
        })
        .catch((err) => this._holdQuietly(run, err))
      return
    }
    if (this._cleanupDue(run, rows)) {
      await this._cleanup(run, false)
      return
    }
    // Worker modes: the lane only takes a submission whose own commit passed its
    // worker-side checks; the others are checked first, in parallel.
    const worker = workerMode(m.manifest)
    const results = worker ? run.db.workerResults() : new Map()
    const resultOf = (t) => {
      const r = results.get(t.id)
      return r?.sourceSha === t.sourceSha ? r : null
    }
    const waiting = worker ? rows.filter((t) => t.status === 'SUBMITTED' && !run.verifying.has(t.id)) : []
    const unverified = waiting.filter((t) => {
      if (resultOf(t)) return false
      const again = run.probeRetry.get(t.id)
      if (again?.sha === t.sourceSha && again.at > Date.now()) {
        this._later(run, again.at)
        return false
      }
      return true
    })
    // A failure recorded just before a crash still has to send its ticket back.
    const rejected = waiting.filter((t) => resultOf(t)?.ok === false)
    // A merge train takes the oldest submissions first (by their submitted event)
    // and up to trainSize of them; every other mode takes one in ticket order.
    const train = trainMode(m.manifest)
    const order = train ? run.db.submittedOrder() : null
    const queue = train
      ? rows
          .filter((t) => t.status === 'SUBMITTED')
          .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
          .slice(0, trainSizeOf(m.manifest))
      : []
    const submitted = train
      ? queue[0]
      : rows.find((t) => t.status === 'SUBMITTED' && (!worker || resultOf(t)?.ok === true))
    const ready = rows.filter(
      (t) => t.status === 'PENDING' && t.dependsOn.every((d) => byId.get(d)?.status === 'INTEGRATED'),
    )
    if (!submitted && !ready.length && !unverified.length && !rejected.length) return
    this._checkPolicy(run)
    const tip = await this._trustedTip(run)
    for (const t of rejected) {
      const fresh = run.db.get(t.id)
      if (fresh.status === 'SUBMITTED' && fresh.lease === t.lease && fresh.sourceSha === t.sourceSha)
        this._workerFailed(run, fresh, run.db.workerVerify(t.id, t.sourceSha))
    }
    for (const t of unverified) {
      if (this.stopping || run.verifying.size >= run.limit) break
      const fresh = run.db.get(t.id)
      if (fresh.status !== 'SUBMITTED' || fresh.lease !== t.lease || fresh.sourceSha !== t.sourceSha) continue
      const job = { id: t.id, phase: { stage: 'worker' }, ctrl: new AbortController() }
      run.verifying.set(t.id, job)
      job.promise = this._workerVerify(run, fresh, job)
        .catch((err) => {
          if (job.ctrl.signal.aborted || this.stopping || err.ledger) return
          // Creating the probe races with concurrent git worktree add (a git commondir
          // read error); that is no verdict on the commit, so try again a few times.
          const tries = run.probeRetry.get(t.id)?.sha === t.sourceSha ? run.probeRetry.get(t.id).tries : 0
          if (err.probeSetup && tries < 3) {
            run.probeRetry.set(t.id, { sha: t.sourceSha, tries: tries + 1, at: Date.now() + 300 * (tries + 1) })
            return
          }
          // A probe that cannot even run is the ticket's problem to look at, not the run's.
          return serial(run, () => {
            const now = run.db.get(t.id)
            if (now.status !== 'SUBMITTED' || now.lease !== t.lease || now.sourceSha !== t.sourceSha) return
            run.db.move(t.id, t.lease, 'SUBMITTED', 'NEEDS_ATTENTION', {
              message: 'Worker-side checks could not run: ' + message(err),
            })
          })
        })
        .finally(() => {
          run.verifying.delete(t.id)
          this._wake(run)
        })
        .catch((err) => this._holdQuietly(run, err))
    }
    // Re-read after the awaits above: an integration that finished meanwhile may
    // have moved this row, and a stale submission must not be trial-merged again.
    const same = (t) => {
      const now = run.db.get(t.id)
      return now.status === 'SUBMITTED' && now.lease === t.lease && now.sourceSha === t.sourceSha
    }
    // A train whose checkout could not be created waits a moment before the next try.
    const trainWait = train && run.trainAt > Date.now()
    if (trainWait) this._later(run, run.trainAt)
    const cars = train && !run.integration && !trainWait ? queue.filter(same) : []
    if (cars.length) {
      const job = { id: null, train: true, ids: cars.map((t) => t.id), size: cars.length, phase: { stage: 'merge' }, ctrl: new AbortController() }
      run.integration = job
      job.promise = this._integrateTrain(run, cars, tip, job)
        .catch((err) => {
          // Cancel and shutdown stop the train; a held ledger already says why.
          if (job.ctrl.signal.aborted || this.stopping || err.ledger) return
          // Creating the train checkout races with concurrent git worktree add; try again shortly.
          if (err.trainSetup && (run.trainRetry ?? 0) < 3) {
            run.trainRetry = (run.trainRetry ?? 0) + 1
            run.trainAt = Date.now() + 300 * run.trainRetry
            return
          }
          return serial(run, () => {
            // A merge that failed for a reason other than a conflict belongs to its ticket.
            const t = err.sourceSha && cars.find((c) => c.sourceSha === err.sourceSha)
            if (t && same(t)) run.db.move(t.id, t.lease, 'SUBMITTED', 'NEEDS_ATTENTION', { message: message(err) })
            else this._hold(run, err)
          })
        })
        .finally(() => {
          run.integration = null
          this._wake(run)
        })
        .catch((err) => this._holdQuietly(run, err))
    }
    const fresh = !train && submitted && run.db.get(submitted.id)
    if (
      !train &&
      submitted &&
      !run.integration &&
      fresh.status === 'SUBMITTED' &&
      fresh.lease === submitted.lease &&
      fresh.sourceSha === submitted.sourceSha
    ) {
      const job = { id: submitted.id, phase: { stage: 'merge' }, ctrl: new AbortController() }
      run.integration = job
      job.promise = this._integrate(run, submitted, tip, job)
        .catch((err) => {
          // A held ledger leaves the submission as it was for inspection.
          if (err.ledger) return
          // A failure belongs only to the submission it tried; a newer one (same lease) stays.
          if (run.db.get(submitted.id)?.sourceSha !== submitted.sourceSha) return
          // A content conflict goes back to the ticket's own worker, a bounded number of times.
          if (
            err.conflicts &&
            run.db.requeueConflict(submitted.id, submitted.lease, {
              message: message(err),
              maxRetries: this.maxConflictRetries,
            })
          )
            return
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
      await this._recordUndeclared(run, row, sourceSha)
    } catch (err) {
      job.atCapacity = launching && !job.handle && err.code === capacityCode
      if (!launching || job.atCapacity) job.quiet = true
      throw err
    } finally {
      if (job.quiet) run.safeChildren.add(row.childId)
    }
  }

  /**
   * Who works an automatic fix ticket: the repair preset when the profile has
   * it, keeping the route the user chose for that preset in this run if any
   * ticket already used it; otherwise the culprit's own preset, as before.
   * @returns { agent, spec } or null for the default worker.
   */
  _repairOwner(run, culprit) {
    if (this.agents && Object.hasOwn(this.agents, repairAgent)) {
      const used = run.db.tickets().find((t) => t.agent === repairAgent && t.agentSpec)
      const spec = agentSpec(this.agents, repairAgent)
      if (used)
        for (const field of ['provider', 'model', 'reasoningEffort']) {
          if (used.agentSpec[field]) spec[field] = used.agentSpec[field]
          else delete spec[field]
        }
      return { agent: repairAgent, spec }
    }
    return culprit.agent ? { agent: culprit.agent, spec: culprit.agentSpec ?? {} } : null
  }

  // Compare a submitted commit's own changes with the files its ticket declared.
  // Diagnostic only: an unknown diff or a ledger write failure never blocks integration.
  async _recordUndeclared(run, row, sourceSha) {
    if (!row.files?.length) return
    try {
      const changed = await git.ownChangedFiles(run.db.meta().repo, run.db.meta().tipSha, sourceSha)
      const files = undeclaredFiles(row.files, changed)
      if (files.length) run.db.recordUndeclared(row.id, { sourceSha, files })
    } catch {}
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

  // Report an integrated imported ticket on its GitHub issue, once, when the
  // profile turned trackerWriteback on. Failure is recorded and never blocks the run.
  _writeback(run, id) {
    if (this.trackerWriteback === 'off' || !this.writeback) return
    const t = run.db.get(id)
    if (t?.status !== 'INTEGRATED' || t.source?.kind !== 'github') return
    if (run.db.events().some((e) => e.ticketId === id && e.type === 'writeback_done')) return
    const m = run.db.meta()
    const mode = this.trackerWriteback
    run.writebacks = (run.writebacks ?? Promise.resolve())
      .then(() =>
        this.writeback({ cwd: m.repo.root, source: t.source, mode, runId: m.runId, ref: m.ref, landedSha: t.landedSha }),
      )
      .then(
        (r) => run.db.recordWriteback(id, 'done', id + ' reported on ' + (r?.target ?? 'its issue'), { mode, ...r }),
        (err) => run.db.recordWriteback(id, 'failed', id + ' could not be reported: ' + message(err), { mode }),
      )
      .catch(() => {})
  }

  /**
   * The check IDs a candidate runs. Without file selection frozen into the run
   * this is checkIds unchanged and nothing is recorded, as before 0.16.
   * @param id - the ticket, or null for a run-level candidate.
   * @param stage - lane, worker, final, bisect or train; goes into checks_selected.
   * @returns the IDs to run, in checkIds order.
   */
  async _selectChecks(run, id, stage, checkIds, fromSha, toSha) {
    const m = run.db.meta()
    if (!integrationOf(m.manifest).selectChecksByFiles) return checkIds
    let changed = null
    try {
      changed = await git.changedFiles(m.repo, fromSha, toSha)
    } catch {
      // An unknown diff selects everything (fallback no-diff), never nothing.
    }
    const picked = selectChecks(checkIds, m.manifest.checkMeta ?? {}, changed)
    run.db.recordSelection(id, {
      stage,
      run: picked.run,
      skipped: picked.skipped,
      fallback: picked.fallback,
      changed: changed?.length ?? null,
    })
    return picked.run
  }

  async _integrate(run, row, tip, job) {
    await serial(run, () => this._checkLedger(run))
    const m = run.db.meta()
    const candidatePath = join(
      run.root,
      'candidates',
      keyOf(row.id) + '-' + row.attempt + '-' + tip.slice(0, 12),
    )
    let candidate
    try {
      candidate = await git.buildCandidate(m.repo, candidatePath, tip, row.sourceSha)
    } catch (err) {
      // The conflicted trial was aborted back to the tip; drop the clean checkout.
      if (err.conflicts) await git.releaseCandidate(m.repo, candidatePath, tip).catch(() => {})
      throw err
    }
    let checkIds = usedChecks([row, ...run.db.tickets().filter((t) => t.status === 'INTEGRATED')])
    const end = endMode(m.manifest)
    const fastOnly = (ids) => ids.filter((id) => m.manifest.checkMeta?.[id]?.fast === true)
    // An end-mode lane runs only the fast checks. A plan that marked none fast
    // runs every check here instead, so a missing check_meta never lands a
    // ticket with no check at all before the final full check.
    if (end && hasFastCheck(m.manifest)) checkIds = fastOnly(checkIds)
    else if (workerMode(m.manifest)) {
      // worker: the worker-side checks covered this tip exactly, so only the fast
      // ones run again; once the tip moved, everything runs again on the candidate.
      const covered = run.db.workerVerify(row.id, row.sourceSha)?.coveredTip ?? null
      if (covered === tip) checkIds = fastOnly(checkIds)
      else
        run.db.recordReverify(row.id, {
          reason: covered ? 'tip-moved' : 'not-covered',
          coveredTip: covered,
          tipSha: tip,
          checks: checkIds,
        })
    }
    const runIds = await this._selectChecks(run, row.id, 'lane', checkIds, tip, candidate)
    const commands = runIds.flatMap((id) => run.checks[id].map((argv) => ({ id, argv })))
    const options = { signal: job.ctrl.signal, timeoutMs: this.checkTimeoutMs }
    run.db.recordVerifyStart(row.id, runIds)
    for (const [index, { id, argv }] of commands.entries()) {
      job.phase = { stage: 'verify', checkId: id, index: index + 1, total: commands.length }
      const began = Date.now()
      let ok = false
      try {
        await git.runChecks(candidatePath, [argv], options)
        ok = true
      } finally {
        run.db.recordCheck(row.id, { checkId: id, ms: Date.now() - began, ok, aborted: !ok && job.ctrl.signal.aborted })
      }
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
        requireValue(
          run.db.finish(row.id, row.lease, candidate, { complete: !end }),
          'Ledger did not accept published candidate',
        )
      } catch (err) {
        this._hold(run, err)
        throw err
      }
    })
    if (run.db.get(row.id).status === 'INTEGRATED') {
      this._writeback(run, row.id)
      try {
        await git.releaseCandidate(m.repo, candidatePath, candidate)
      } catch {
        /* Preserve checkout if cleanup cannot be proven safe. */
      }
    }
  }

  /**
   * Run checkIds in a fresh probe checkout of sha, one check_finished per ID,
   * on ticketId (worker-side checks) or on the run (null: final, bisect).
   * @returns { failed: id[], output: { id: tail } }; throws if the job was aborted.
   */
  async _probeChecks(run, job, sha, checkIds, stage, phase = {}, ticketId = null) {
    const m = run.db.meta()
    // A fresh path each time: a probe an interrupted check left dirty is kept, never reused.
    const path = join(run.root, 'probes', sha.slice(0, 12) + '-' + randomUUID().slice(0, 8))
    try {
      await git.addProbe(m.repo, path, sha)
    } catch (err) {
      err.probeSetup = true
      throw err
    }
    try {
      return await this._checksIn(run, job, path, checkIds, stage, phase, ticketId)
    } finally {
      await git.releaseProbe(m.repo, path, sha).catch(() => {
        /* A probe the checks dirtied stays for inspection. */
      })
    }
  }

  // Run checkIds in an existing checkout, one check_finished per ID; a failure is collected, an abort thrown.
  async _checksIn(run, job, path, checkIds, stage, phase = {}, ticketId = null) {
    const failed = [],
      output = {}
    for (const [index, id] of checkIds.entries()) {
      job.phase = { stage, checkId: id, index: index + 1, total: checkIds.length, ...phase }
      const began = Date.now()
      let ok = false
      try {
        await git.runChecks(path, run.checks[id], { signal: job.ctrl.signal, timeoutMs: this.checkTimeoutMs })
        ok = true
      } catch (err) {
        if (job.ctrl.signal.aborted) throw err
        failed.push(id)
        output[id] = message(err).slice(-3000)
      } finally {
        run.db.recordCheck(ticketId, { checkId: id, ms: Date.now() - began, ok, aborted: !ok && job.ctrl.signal.aborted, stage })
      }
    }
    return { failed, output }
  }

  /**
   * Train mode: merge up to trainSize submissions (oldest first) onto tip as a
   * chain of two-parent merges M1..Mn, skipping each that conflicts, and run the
   * cumulative checks once on Mn. A pass publishes M1..Mn one by one, each with
   * the ordinary single-ticket intent/CAS/finish, so publication recovery is
   * unchanged. A failure bisects the chain on the failed IDs, publishes the
   * passing prefix, sends the first failing ticket back to its worker and leaves
   * the rest submitted for the next train. Conflicts go back to their workers
   * after the verdict, so they merge the integration branch with the cars that landed.
   */
  async _integrateTrain(run, cars, tip, job) {
    await serial(run, () => this._checkLedger(run))
    const m = run.db.meta()
    const path = join(run.root, 'candidates', 'train-' + tip.slice(0, 12) + '-' + randomUUID().slice(0, 8))
    const { merges, conflicts } = await git.buildTrain(m.repo, path, tip, cars.map((t) => t.sourceSha))
    run.trainRetry = 0
    const carOf = new Map(cars.map((t) => [t.sourceSha, t]))
    const last = merges.at(-1)?.sha ?? tip
    // Where the train checkout is; the bisection moves it.
    let at = last
    const landing = merges.map((x) => carOf.get(x.sourceSha))
    let published = []
    try {
      if (merges.length) {
        const integrated = run.db.tickets().filter((t) => t.status === 'INTEGRATED')
        const checkIds = usedChecks([...landing, ...integrated])
        const runIds = await this._selectChecks(run, null, 'train', checkIds, tip, last)
        run.db.recordTrain('train_started', 'Merge train of ' + merges.length + ' at ' + tip, {
          tipSha: tip,
          tickets: landing.map((t) => t.id),
          merges: merges.map((x) => x.sha),
          conflicts: conflicts.map((c) => carOf.get(c.sourceSha).id),
          checks: runIds,
        })
        for (const t of landing) run.db.recordVerifyStart(t.id, runIds)
        const { failed, output } = await this._checksIn(run, job, path, runIds, 'train')
        if (!failed.length) {
          // As in the each lane: the checks must not have moved or dirtied the checkout they passed in.
          await git.assertCandidate(m.repo, path, last)
          published = await this._publishTrain(run, job, tip, merges, landing)
          run.db.recordTrain('train_passed', 'Merge train passed at ' + last, {
            tipSha: tip,
            lastSha: last,
            tickets: published,
          })
        } else {
          // First failing merge: M(hi). The tip passed before this train; Mn is known to fail.
          let lo = -1,
            hi = merges.length - 1
          for (let step = 1; hi - lo > 1; step++) {
            const mid = Math.floor((lo + hi) / 2)
            const used = new Set(usedChecks([...landing.slice(0, mid + 1), ...integrated]))
            const ids = failed.filter((id) => used.has(id))
            let ok = true
            if (ids.length) {
              // Bisect in the train checkout itself: no further git worktree add.
              at = await git.switchCandidate(m.repo, path, at, merges[mid].sha)
              ok = !(await this._checksIn(run, job, path, ids, 'train', { bisect: true, step })).failed.length
            }
            run.db.recordTrain('train_bisect_step', merges[mid].sha + (ok ? ' passes' : ' fails'), { sha: merges[mid].sha, ok, checks: ids })
            if (ok) lo = mid
            else hi = mid
          }
          const culprit = landing[hi]
          published = await this._publishTrain(run, job, tip, merges.slice(0, hi), landing.slice(0, hi))
          const tails = failed.map((id) => id + ':\n' + output[id]).join('\n\n').slice(-3000)
          await serial(run, () => {
            if (this.stopping || run.db.meta().mode !== 'active') return
            this._checkLedger(run)
            run.db.recordTrain('train_failed', 'Merge train checks failed; first failing merge landed ' + culprit.id, {
              tipSha: tip,
              failed,
              culprit: culprit.id,
              culpritSha: merges[hi].sha,
              published,
            })
            // Only a ticket the whole prefix landed before is blamed on its own merge.
            if (published.length !== hi) return
            const t = run.db.get(culprit.id)
            if (t.status !== 'SUBMITTED' || t.lease !== culprit.lease || t.sourceSha !== culprit.sourceSha) return
            this._checkFailed(
              run,
              t,
              'Merge-train checks failed: ' + failed.join(', ') + '. The coordinator merged your commit ' + t.sourceSha +
                ' in a merge train after ' + (hi ? landing.slice(0, hi).map((x) => x.id).join(', ') : 'the integration tip') +
                ' and bisecting the train located its merge ' + merges[hi].sha +
                ' as the first that fails; your own report does not count. Make the checks pass, merge the latest integration branch, and commit again.\n\nOutput tail:\n' +
                tails,
              'merge-train',
            )
          })
        }
      }
      // Conflicts after the verdict: the worker then merges a branch that holds the cars ahead of it.
      await serial(run, () => {
        if (this.stopping || run.db.meta().mode !== 'active') return
        for (const c of conflicts) {
          const car = carOf.get(c.sourceSha)
          const t = run.db.get(car.id)
          if (t.status !== 'SUBMITTED' || t.lease !== car.lease || t.sourceSha !== car.sourceSha) continue
          const note = 'Trial merge conflicts with the integration tip in: ' + c.files.join(', ') + ' (merge train)'
          if (!run.db.requeueConflict(t.id, t.lease, { message: note, maxRetries: this.maxConflictRetries }))
            run.db.move(t.id, t.lease, 'SUBMITTED', 'NEEDS_ATTENTION', { message: note })
        }
      })
    } finally {
      // An open publication intent still needs its merge reachable for recovery.
      const open = new Set(run.db.intents().map((i) => i.candidateSha))
      for (const x of merges.filter((x) => !published.includes(carOf.get(x.sourceSha).id) && !open.has(x.sha)))
        await git.unpinCandidate(m.repo, x.sha).catch(() => {})
      await git.releaseCandidate(m.repo, path, at).catch(() => {
        /* Preserve the train checkout if cleanup cannot be proven safe. */
      })
    }
  }

  /**
   * Publish a verified prefix of a train merge chain, one ticket at a time with
   * the single-ticket intent, CAS and finish. Stops at the first ticket that
   * changed meanwhile: the merges after it are built on it and cannot land.
   * @returns the IDs that landed, in order.
   */
  async _publishTrain(run, job, tip, merges, landing) {
    const m = run.db.meta()
    const done = []
    let prev = tip
    for (const [i, x] of merges.entries()) {
      const row = landing[i]
      job.phase = { stage: 'publish', index: i + 1, total: merges.length }
      const ok = await serial(run, async () => {
        if (this.stopping || run.db.meta().mode !== 'active') return false
        const t = run.db.get(row.id)
        if (t.status !== 'SUBMITTED' || t.lease !== row.lease || t.sourceSha !== row.sourceSha) return false
        this._checkLedger(run)
        this._checkPolicy(run)
        // The chain only lands on the tip it was built from, link by link.
        requireValue((await this._trustedTip(run)) === prev, 'Integration tip moved during the merge train')
        // A ticket that changed under the train stops it there, as one in the each lane would stop.
        try {
          requireValue((await stampedSource(m, t)) === row.sourceSha, 'Worker branch moved after submission')
          for (const id of t.dependsOn) {
            const p = run.db.get(id)
            requireValue(
              p.status === 'INTEGRATED' && (await git.isAncestor(m.repo, p.landedSha, prev)),
              'Dependency changed before publication',
            )
          }
        } catch (err) {
          run.db.move(t.id, t.lease, 'SUBMITTED', 'NEEDS_ATTENTION', { message: message(err) })
          return false
        }
        await git.assertMergeParents(m.repo, x.sha, prev, row.sourceSha)
        requireValue(
          run.db.intent(row.id, row.lease, { oldTip: prev, sourceSha: row.sourceSha, candidateSha: x.sha }),
          'Could not record publication intent',
        )
        try {
          await git.publishCandidate(m.repo, m.ref, prev, x.sha)
          requireValue(run.db.finish(row.id, row.lease, x.sha), 'Ledger did not accept published candidate')
        } catch (err) {
          this._hold(run, err)
          // Held with the open intent on record; the train's catch must not hold again.
          err.ledger = true
          throw err
        }
        return true
      })
      if (!ok) break
      this._writeback(run, row.id)
      done.push(row.id)
      prev = x.sha
    }
    return done
  }

  /**
   * Worker modes: run the cumulative checks (this ticket's plus every integrated
   * one's) on the submitted commit itself, in a probe outside the lane. The
   * worker's own report never counts. coveredTip is the integration tip the
   * commit already contains, or null; file selection diffs from it (else from
   * the frozen base). The result goes into the ledger, where a restart finds it.
   */
  async _workerVerify(run, row, job) {
    await serial(run, () => this._checkLedger(run))
    const m = run.db.meta()
    // Tip and integrated set are read together, before any await, so they agree.
    const tip = m.tipSha
    const checkIds = usedChecks([row, ...run.db.tickets().filter((t) => t.status === 'INTEGRATED')])
    const covered = (await git.isAncestor(m.repo, tip, row.sourceSha)) ? tip : null
    const runIds = await this._selectChecks(run, row.id, 'worker', checkIds, covered ?? m.baseSha, row.sourceSha)
    const { failed, output } = runIds.length
      ? await this._probeChecks(run, job, row.sourceSha, runIds, 'worker', {}, row.id)
      : { failed: [], output: {} }
    await serial(run, () => {
      if (this.stopping || run.db.meta().mode !== 'active') return
      const t = run.db.get(row.id)
      if (t.status !== 'SUBMITTED' || t.lease !== row.lease || t.sourceSha !== row.sourceSha) return
      this._checkLedger(run)
      const details = {
        sourceSha: row.sourceSha,
        coveredTip: covered,
        ok: !failed.length,
        checks: runIds,
        failed,
        output: failed.map((id) => id + ':\n' + output[id]).join('\n\n').slice(-3000),
      }
      run.db.recordWorkerVerify(row.id, details)
      if (failed.length) this._workerFailed(run, t, details)
    })
  }

  // Back to the ticket's own worker with the failure, a bounded number of times; then the captain.
  _workerFailed(run, t, details) {
    this._checkFailed(
      run,
      t,
      'Worker-side checks failed on your commit ' + details.sourceSha + ': ' + details.failed.join(', ') +
        '. The coordinator ran them; your own report does not count. Make them pass, merge the latest integration branch, and commit again.\n\nOutput tail:\n' +
        (details.output ?? ''),
      'worker-side',
    )
  }

  // A failed check sends the ticket back through requeueCheckFailure; kind names the gate in the note to the captain.
  _checkFailed(run, t, note, kind) {
    if (run.db.requeueCheckFailure(t.id, t.lease, { message: note, maxRetries: this.maxConflictRetries })) return
    run.db.move(t.id, t.lease, 'SUBMITTED', 'NEEDS_ATTENTION', {
      message: note.slice(0, 3400) + '\n\nThe automatic ' + kind + ' retries (maxConflictRetries) are used up.',
    })
  }

  /**
   * End modes: every ticket is integrated at tip. Run every check the run uses
   * (no file selection) on tip; a pass completes the run. A failure bisects the
   * first-parent merges, rerunning only the failed IDs, to the first merge that
   * fails, appends a fix ticket for the ticket that landed it, and tells the
   * captain. Past maxFinalRepairs, or when no merge can be blamed, the run is held.
   */
  async _finalVerify(run, tip, job) {
    await serial(run, () => this._checkLedger(run))
    const m = run.db.meta()
    const tickets = run.db.tickets()
    const checkIds = usedChecks(tickets)
    run.db.recordFinal('final_verify_started', 'Final checks started at ' + tip, { tipSha: tip, checks: checkIds })
    const { failed, output } = await this._probeChecks(run, job, tip, checkIds, 'final')
    if (!failed.length) {
      await serial(run, () => {
        if (this.stopping || run.db.meta().mode !== 'active') return
        this._checkLedger(run)
        run.db.completeRun(tip, { checks: checkIds })
      })
      return
    }
    const culprit = await this._bisect(run, job, tip, failed, tickets)
    await serial(run, async () => {
      if (this.stopping || run.db.meta().mode !== 'active') return
      this._checkLedger(run)
      requireValue((await this._trustedTip(run)) === tip, 'Integration tip moved during the final checks')
      const tails = failed.map((id) => id + ':\n' + output[id]).join('\n\n').slice(-3000)
      const limit = maxFinalRepairsOf(m.manifest)
      const used = run.db.finalRepairs()
      const details = { tipSha: tip, failed, culprit: culprit?.id ?? null, culpritSha: culprit?.landedSha ?? null }
      if (!culprit || used >= limit) {
        const why = !culprit
          ? 'no integrated merge could be blamed (the failure may be flaky or need several tickets together)'
          : 'the run already appended ' + used + ' automatic fix tickets (maxFinalRepairs ' + limit + ')'
        run.db.recordFinal('final_verify_failed', 'Final checks failed at ' + tip + '; ' + why, { ...details, repair: null })
        this._hold(
          run,
          new Error(
            'Final checks ' + failed.join(', ') + ' failed at ' + tip +
              (culprit ? '; first failing merge ' + culprit.landedSha + ' landed ' + culprit.id : '') +
              '. Held: ' + why + '. Add a fix ticket with dag_add and dag_resume, or start a new run.\n' + tails,
          ),
        )
        return
      }
      const owner = this._repairOwner(run, culprit)
      const fix = normalizeAppend(
        [
          {
            id: 'fix-' + culprit.id.slice(0, 70) + '-' + (used + 1),
            title: 'Fix final check failure from ' + culprit.id,
            prompt:
              'The final full check of this run failed after every ticket was integrated. Failed check IDs: ' +
              JSON.stringify(failed) + '. Bisecting the integration merges located the first failing merge ' +
              culprit.landedSha + ', which landed ticket ' + culprit.id + ' (' + culprit.title + ').\n\n' +
              'Fix the failure on top of the current integration branch (your worktree starts from it). ' +
              'Do not revert other tickets; change only what makes the failed checks pass again.\n\n' +
              'Output tail:\n' + tails,
            verify: [...new Set([...culprit.verify, ...failed])],
            acceptance: ['Checks ' + failed.join(', ') + ' pass on the integrated tip'],
            ...(owner && { agent: owner.agent }),
          },
        ],
        run.checks,
        owner ? { [owner.agent]: owner.spec } : {},
      )
      run.db.appendRepair(fix[0], { policyHash: policyHash({ tickets: fix }, run.checks), details })
      // The ledger now holds this append; it is the new trusted state, as in add().
      const after = ledgerDigest(run.db)
      run.trust = { ...run.trust, plan: after.plan, approval: after.approval }
      this._drainOutbox(run)
    })
  }

  /**
   * The ticket whose merge first fails, or null. Assumes failure is monotonic
   * along the first-parent merges: the base passes and tip fails. At merge Mi
   * only the failed IDs that tickets landed up to Mi use are run; none means pass.
   */
  async _bisect(run, job, tip, failed, tickets) {
    const m = run.db.meta()
    const merges = await git.firstParentCommits(m.repo, m.baseSha, tip)
    const bySha = new Map(tickets.map((t) => [t.landedSha, t]))
    let lo = -1,
      hi = merges.length - 1
    for (let step = 1; hi - lo > 1; step++) {
      const mid = Math.floor((lo + hi) / 2)
      const landed = merges.slice(0, mid + 1).map((sha) => bySha.get(sha)).filter(Boolean)
      const used = new Set(landed.flatMap((t) => t.verify))
      const ids = failed.filter((id) => used.has(id))
      const ok = ids.length ? !(await this._probeChecks(run, job, merges[mid], ids, 'bisect', { step })).failed.length : true
      run.db.recordFinal('bisect_step', merges[mid] + (ok ? ' passes' : ' fails'), { sha: merges[mid], ok, checks: ids })
      if (ok) lo = mid
      else hi = mid
    }
    return bySha.get(merges[hi]) ?? null
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
        for (const j of r.verifying.values()) j.ctrl.abort()
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
          [...r.work.values(), ...r.verifying.values()]
            .map((j) => j.promise)
            .concat([r.integration?.promise, r.notifier, r.writebacks]),
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
