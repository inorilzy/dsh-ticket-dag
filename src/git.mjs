import { execFile, spawn } from 'node:child_process'
import { lstat, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { delimiter, dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const id = '[A-Za-z0-9][A-Za-z0-9._-]{0,127}'
const targetPattern = new RegExp('^refs/heads/integration/' + id + '$')
const ticketPattern = new RegExp('^ticket/' + id + '/' + id + '$')
const oidPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
const maxOutput = 8 * 1024 * 1024

function verify(ok, message) {
  if (!ok) throw new Error(message)
}

function envForCheckout() {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_MERGE_AUTOEDIT: 'no' }
  for (const key of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_COMMON_DIR',
    'GIT_INDEX_FILE',
    'GIT_NAMESPACE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_PREFIX',
  ])
    delete env[key]
  return env
}

function rootOf(repo) {
  const root = typeof repo === 'string' ? repo : repo?.root
  verify(typeof root === 'string' && root.length > 0, 'A Git checkout path is required')
  return root
}

async function git(repo, ...args) {
  // Persisted metadata identifies one repository, even if the original checkout
  // path is subsequently replaced by another clone containing the very same SHAs.
  if (typeof repo === 'object' && repo?.commonDir) {
    const actual = await git(rootOf(repo), 'rev-parse', '--path-format=absolute', '--git-common-dir')
    verify((await realpath(actual)) === repo.commonDir, 'Git repository identity changed')
  }
  const { stdout } = await exec('git', args, {
    cwd: rootOf(repo),
    env: envForCheckout(),
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    maxBuffer: maxOutput,
  })
  return stdout.replace(/\r?\n$/, '')
}

async function exists(path) {
  try {
    return await lstat(path)
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
}

async function optionalGit(repo, ...args) {
  try {
    return await git(repo, ...args)
  } catch (err) {
    if (err.code === 1) return null
    throw err
  }
}

function oid(value) {
  verify(typeof value === 'string' && oidPattern.test(value), 'Expected a full lowercase Git commit SHA')
  return value
}

function checkoutPath(value) {
  verify(typeof value === 'string' && isAbsolute(value), 'A worktree path must be absolute')
  return resolve(value)
}

async function checkedRef(repo, ref, pattern) {
  verify(typeof ref === 'string' && pattern.test(ref), 'Invalid managed Git ref: ' + ref)
  await git(repo, 'check-ref-format', ref)
  return ref
}

async function ticketBranch(repo, name) {
  verify(typeof name === 'string', 'A ticket branch is required')
  const short = name.replace(/^refs\/heads\//, '')
  verify(ticketPattern.test(short), 'Invalid ticket branch: ' + name)
  await git(repo, 'check-ref-format', 'refs/heads/' + short)
  return short
}

/** Canonical locations of this checkout and its shared Git administration directory. */
export async function repoInfo(cwd) {
  const [root, common] = await Promise.all([
    git(cwd, 'rev-parse', '--show-toplevel'),
    git(cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'),
  ])
  return { root: await realpath(root), commonDir: await realpath(common) }
}

/** Read only HEAD, a local heads ref (short or full), or a literal full object ID. */
export async function resolveRef(repo, ref) {
  verify(typeof ref === 'string' && ref.length > 0 && !ref.startsWith('-'), 'Invalid local Git ref')
  let rev = ref
  if (!oidPattern.test(ref) && ref !== 'HEAD') {
    verify(!ref.startsWith('refs/') || ref.startsWith('refs/heads/'), 'Expected a local branch ref')
    const short = ref.replace(/^refs\/heads\//, '')
    verify(short && !short.startsWith('-'), 'Invalid local branch')
    rev = 'refs/heads/' + short
    await git(repo, 'check-ref-format', rev)
  }
  const commit = oid(await git(repo, 'rev-parse', '--verify', '--end-of-options', rev + '^{commit}'))
  // A full SHA supplied by the caller must identify a commit itself, not a tag object.
  if (oidPattern.test(ref)) verify(commit === ref, 'SHA must identify the commit directly')
  return commit
}

/** Existence of an exact local branch. Git 2.43+ separates missing (2) from errors (1). */
export async function localRefExists(repo, ref) {
  verify(typeof ref === 'string' && ref.startsWith('refs/heads/'), 'Expected a full local branch ref')
  await git(repo, 'check-ref-format', ref)
  try {
    await git(repo, 'show-ref', '--exists', ref)
    return true
  } catch (err) {
    if (err.code === 2) return false
    throw err
  }
}

async function requireUnoccupied(repo, ref) {
  const entries = (await git(repo, 'worktree', 'list', '--porcelain', '-z')).split('\0')
  verify(!entries.includes('branch ' + ref), 'Integration target is checked out in a worktree: ' + ref)
}

/** Atomically claim a completely new integration/<run> branch at a local commit. */
export async function initIntegration(repo, ref, baseRef) {
  await checkedRef(repo, ref, targetPattern)
  const base = await resolveRef(repo, baseRef)
  await requireUnoccupied(repo, ref)
  await git(
    repo,
    'update-ref',
    '--create-reflog',
    '-m',
    'dsh-ticket-dag: start',
    ref,
    base,
    '0'.repeat(base.length),
  )
  return base
}

/** True iff the first commit is an ancestor of (or equal to) the second. Errors are not a negative answer. */
export async function isAncestor(repo, ancestor, descendant) {
  return (await optionalGit(repo, 'merge-base', '--is-ancestor', oid(ancestor), oid(descendant))) !== null
}

async function checkoutInfo(repo, path) {
  const wt = checkoutPath(path)
  const stat = await exists(wt)
  verify(stat?.isDirectory() && !stat.isSymbolicLink(), 'Expected a real worktree directory: ' + wt)
  const [wantedRoot, info, owner] = await Promise.all([realpath(wt), repoInfo(wt), repoInfo(rootOf(repo))])
  verify(
    info.root === wantedRoot && info.commonDir === owner.commonDir,
    'Wrong worktree root or Git repository: ' + wt,
  )
  // Recheck the issued common directory too, if the caller retained repoInfo from dispatch.
  if (typeof repo === 'object' && repo.commonDir)
    verify(info.commonDir === repo.commonDir, 'Git repository identity changed')
  return wt
}

async function workState(wt) {
  const [head, branch, changes, admin] = await Promise.all([
    git(wt, 'rev-parse', '--verify', 'HEAD^{commit}'),
    optionalGit(wt, 'symbolic-ref', '--quiet', 'HEAD'),
    git(wt, 'status', '--porcelain=v1', '--untracked-files=all', '-z'),
    git(wt, 'rev-parse', '--absolute-git-dir'),
  ])
  const markers = [
    'MERGE_HEAD',
    'CHERRY_PICK_HEAD',
    'REVERT_HEAD',
    'rebase-merge',
    'rebase-apply',
    'sequencer',
    'BISECT_START',
  ]
  const operations = await Promise.all(markers.map((marker) => exists(join(admin, marker))))
  return { head: oid(head), branch, clean: !changes, inProgress: operations.some(Boolean) }
}

/** A fresh invocation starts clean at exactly base. An authorized same-ticket resume may retain local edits. */
export async function inspectWorktree(repo, path, branch, baseSha, { resume = false } = {}) {
  const name = await ticketBranch(repo, branch)
  const wt = await checkoutInfo(repo, path)
  const state = await workState(wt)
  verify(state.branch === 'refs/heads/' + name, 'Unexpected ticket branch at ' + wt)
  verify(!state.inProgress, 'Unfinished Git operation in ticket worktree: ' + wt)
  if (resume) {
    verify(await isAncestor(repo, baseSha, state.head), 'Ticket HEAD does not descend from its assigned base')
  } else {
    verify(state.head === oid(baseSha), 'Ticket HEAD differs from its frozen base')
    verify(state.clean, 'Fresh ticket worktree is dirty: ' + wt)
  }
  return { head: state.head, clean: state.clean }
}

/** Create or reattach only the assigned ticket branch; never reset it or remove an existing checkout. */
export async function prepareWorktree(repo, path, branch, baseSha, { resume = false } = {}) {
  const wt = checkoutPath(path)
  const name = await ticketBranch(repo, branch)
  const base = await resolveRef(repo, oid(baseSha))
  if (!(await exists(wt))) {
    await mkdir(dirname(wt), { recursive: true })
    const ref = 'refs/heads/' + name
    if (await localRefExists(repo, ref)) {
      const existing = await resolveRef(repo, ref)
      verify(
        resume ? await isAncestor(repo, base, existing) : existing === base,
        'Existing ticket branch has an unexpected base or HEAD',
      )
      await git(repo, 'worktree', 'add', '--', wt, name)
    } else {
      verify(!resume, 'Cannot resume a missing ticket branch')
      await git(repo, 'worktree', 'add', '-b', name, '--', wt, base)
    }
  }
  return inspectWorktree(repo, wt, name, base, { resume })
}

/** Verify a completed worker's clean checkout and freeze its non-empty commit history. */
export async function verifySource(repo, path, branch, baseSha) {
  const state = await inspectWorktree(repo, path, branch, baseSha, { resume: true })
  verify(state.clean && state.head !== baseSha, 'Ticket must have a clean worktree and a new commit')
  return state.head
}

function candidatePin(candidate) {
  return 'refs/dsh-ticket-dag/candidates/' + oid(candidate)
}

/** Full message of the precise immutable commit, including its completion metadata. */
export async function readCommitMessage(repo, sha) {
  const commit = await resolveRef(repo, oid(sha))
  return git(repo, 'show', '-s', '--format=%B', commit)
}

async function candidateOwner(wt, create) {
  // This file is private to the linked checkout, outside the tracked/tested tree.
  const admin = await git(wt, 'rev-parse', '--absolute-git-dir')
  const marker = join(admin, 'dsh-ticket-dag-candidate-v1')
  const expected = await realpath(wt)
  if (create) await writeFile(marker, expected, { encoding: 'utf8', flag: 'wx' })
  else
    verify(
      (await exists(marker)) && (await readFile(marker, 'utf8')) === expected,
      'Checkout is not a candidate owned by dsh-ticket-dag: ' + wt,
    )
}

async function parentsOf(repo, candidate) {
  return (await git(repo, 'show', '-s', '--format=%P', oid(candidate))).split(' ').filter(Boolean)
}

/** Verify the exact ordered merge parents recorded in a durable publication intent. */
export async function assertMergeParents(repo, candidateSha, oldTip, sourceSha) {
  const parents = await parentsOf(repo, candidateSha)
  verify(
    parents.length === 2 && parents[0] === oid(oldTip) && parents[1] === oid(sourceSha),
    'Candidate is not the expected two-parent merge',
  )
}

/** Re-check the isolated checkout after tests and before recording a green candidate. */
export async function assertCandidate(repo, path, expectedSha) {
  const wt = await checkoutInfo(repo, path)
  await candidateOwner(wt, false)
  const state = await workState(wt)
  verify(
    state.branch === null && state.head === oid(expectedSha) && state.clean && !state.inProgress,
    'Candidate checkout changed, is on a branch, or has pending work',
  )
  return state.head
}

/**
 * Build (or re-adopt) an exact detached trial merge. Its Git ref keeps an
 * unpublished SHA reachable across crash recovery and Git garbage collection.
 * On conflict stop: inspect the named checkout, resolve and commit the merge,
 * or explicitly abort it. Retrying recognizes the resolved parent pair.
 */
export async function buildCandidate(repo, path, oldTip, sourceSha) {
  const wt = checkoutPath(path)
  const old = await resolveRef(repo, oid(oldTip))
  const source = await resolveRef(repo, oid(sourceSha))
  verify(
    !(await isAncestor(repo, source, old)),
    'Source already belongs to this baseline; reconcile its existing intent',
  )
  if (!(await exists(wt))) {
    await mkdir(dirname(wt), { recursive: true })
    await git(repo, 'worktree', 'add', '--detach', '--', wt, old)
    await candidateOwner(wt, true)
  }
  await checkoutInfo(repo, wt)
  await candidateOwner(wt, false)
  const state = await workState(wt)
  verify(state.branch === null, 'Candidate directory must be a detached worktree')
  verify(
    state.clean && !state.inProgress,
    'Candidate checkout has local changes or an unfinished operation: ' +
      wt +
      '. Inspect git status; resolve and commit the trial merge, or explicitly abort it before retrying.',
  )
  const parents = await parentsOf(repo, state.head)
  let candidate = state.head
  if (parents.length !== 2 || parents[0] !== old || parents[1] !== source) {
    if (state.head !== old) {
      // Keep every commit reachable before switching away. Unknown detached work is never discarded.
      const pinned = await optionalGit(repo, 'show-ref', '--verify', '--quiet', candidatePin(state.head))
      verify(
        pinned !== null || (await isAncestor(repo, state.head, old)),
        'Unrecognized detached HEAD in candidate directory; preserve it before proceeding: ' + wt,
      )
      await git(wt, 'switch', '--detach', '--no-overwrite-ignore', old)
    }
    try {
      await git(
        wt,
        'merge',
        '--no-ff',
        '--no-edit',
        '--no-overwrite-ignore',
        '-m',
        'dsh-ticket-dag: verify ' + source,
        source,
      )
    } catch (err) {
      throw new Error(
        'Trial merge failed; checkout preserved at ' +
          wt +
          '. Inspect git status; resolve and commit the merge or explicitly abort it. ' +
          err.message,
        { cause: err },
      )
    }
    candidate = await resolveRef(wt, 'HEAD')
  }
  await assertCandidate(repo, wt, candidate)
  await assertMergeParents(repo, candidate, old, source)
  await git(repo, 'update-ref', candidatePin(candidate), candidate)
  return candidate
}

/** Remove only a clean plugin-owned trial at the requested SHA. Never force deletion. */
export async function releaseCandidate(repo, path, expectedSha) {
  const wt = checkoutPath(path)
  await assertCandidate(repo, wt, expectedSha)
  const leftovers = await git(
    wt,
    'status',
    '--porcelain=v1',
    '--ignored=matching',
    '--untracked-files=all',
    '-z',
  )
  verify(!leftovers, 'Candidate contains ignored or untracked files; retained at ' + wt)
  await git(repo, 'worktree', 'remove', '--', wt)
}

/** Compare-and-swap the unoccupied integration ref. All external writers must obey the same ownership convention. */
export async function publishCandidate(repo, ref, oldTip, candidateSha) {
  await checkedRef(repo, ref, targetPattern)
  const old = oid(oldTip)
  const candidate = oid(candidateSha)
  const parents = await parentsOf(repo, candidate)
  verify(parents.length === 2 && parents[0] === old, 'Cannot publish a candidate built on a different tip')
  await requireUnoccupied(repo, ref)
  await git(repo, 'update-ref', '-m', 'dsh-ticket-dag: publish', ref, candidate, old)
  // From this instant the target keeps the candidate reachable. Ref housekeeping
  // must not turn a successful CAS into a failed publication for the caller.
  try {
    await git(repo, 'update-ref', '-d', candidatePin(candidate), candidate)
  } catch {
    /* safe to retain */
  }
  return candidate
}

const isWindows = process.platform === 'win32'
// Inside a double-quoted cmd.exe token these still expand, escape or end the quote.
// The rest are rejected too, because batch scripts often re-expand %* unquoted.
const cmdMeta = /["%!^&|<>\r\n]/

function envValue(env, name) {
  const key = Object.keys(env).find((k) => k.toUpperCase() === name)
  return key ? env[key] : undefined
}

async function isFile(path) {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

/** Windows: the batch file argv[0] would launch (PATH/PATHEXT lookup), or null for a native executable. */
async function windowsBatch(command, cwd, env) {
  const exts = (envValue(env, 'PATHEXT') || '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .filter(Boolean)
    .map((ext) => ext.toLowerCase())
  const names = extname(command) ? [command] : exts.map((ext) => command + ext)
  const dirs = /[\\/]/.test(command)
    ? [cwd]
    : [cwd, ...(envValue(env, 'PATH') || '').split(delimiter).filter(Boolean)]
  for (const dir of dirs) {
    for (const name of names) {
      const path = resolve(dir, name)
      if (await isFile(path)) return /\.(?:bat|cmd)$/i.test(path) ? path : null
    }
  }
  return null
}

function quoteForCmd(arg) {
  verify(!cmdMeta.test(arg), 'Check argument contains a cmd.exe metacharacter ("%!^&|<>, CR or LF): ' + arg)
  // Double trailing backslashes so the closing quote survives CRT argv parsing downstream.
  return '"' + arg.replace(/(\\+)$/, '$1$1') + '"'
}

/** spawn() arguments; .cmd/.bat run via cmd.exe with strictly quoted, metacharacter-free tokens. */
async function checkCommand(argv, cwd, env) {
  const batch = isWindows ? await windowsBatch(argv[0], cwd, env) : null
  if (!batch) return { file: argv[0], args: argv.slice(1), verbatim: false }
  const line = [batch, ...argv.slice(1)].map(quoteForCmd).join(' ')
  const comspec = envValue(env, 'COMSPEC') || 'cmd.exe'
  return { file: comspec, args: ['/d', '/s', '/v:off', '/c', '"' + line + '"'], verbatim: true }
}

function killTree(child) {
  if (!child.pid) return Promise.resolve()
  if (isWindows) {
    const root = process.env.SystemRoot
    const taskkill = root ? join(root, 'System32', 'taskkill.exe') : 'taskkill'
    return new Promise((done) =>
      execFile(taskkill, ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, (err) => {
        if (err) child.kill('SIGKILL')
        done()
      }),
    )
  }
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    child.kill('SIGKILL')
  }
  return Promise.resolve()
}

/** Run one check; on abort or output overflow, kill its whole process tree and wait for stdio to close. */
function runCheck(command, { cwd, env, signal }) {
  return new Promise((done, fail) => {
    const child = spawn(command.file, command.args, {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: command.verbatim,
      // POSIX: own process group, so process.kill(-pid) reaches every descendant.
      detached: !isWindows,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const out = { stdout: '', stderr: '' }
    let error = null
    let killing = null
    const stop = (cause) => {
      error ??= cause
      killing ??= killTree(child)
    }
    for (const name of ['stdout', 'stderr']) {
      child[name].setEncoding('utf8')
      child[name].on('data', (chunk) => {
        out[name] += chunk
        if (out[name].length > maxOutput) stop(new Error(name + ' maxBuffer length exceeded'))
      })
    }
    const onAbort = () => stop(signal.reason ?? new Error('aborted'))
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
    child.once('error', (err) => {
      error ??= err
    })
    child.once('close', async (code, signalName) => {
      signal.removeEventListener('abort', onAbort)
      await killing
      if (!error && code !== 0)
        error = new Error('Command exited with ' + (signalName ? 'signal ' + signalName : 'code ' + code))
      if (!error) return done(out)
      fail(Object.assign(new Error(error?.message ?? String(error), { cause: error }), out, { code }))
    })
  })
}

/** Sequential trusted argv checks. No shell expansion. Timeout or cancellation kills each command's whole process tree. */
export async function runChecks(cwd, checks, { signal, timeoutMs = 120_000 } = {}) {
  verify(Array.isArray(checks), 'Checks must be an array of argv arrays')
  verify(
    Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 2_147_483_647,
    'Invalid check timeout',
  )
  signal?.throwIfAborted()
  const results = []
  for (const argv of checks) {
    verify(
      Array.isArray(argv) &&
        argv.length &&
        typeof argv[0] === 'string' &&
        argv[0].length &&
        argv.every((arg) => typeof arg === 'string' && !arg.includes('\0')),
      'Checks must use nonempty executable argv arrays',
    )
    signal?.throwIfAborted()
    const timer = AbortSignal.timeout(timeoutMs)
    const stop = signal ? AbortSignal.any([timer, signal]) : timer
    try {
      const env = envForCheckout()
      const output = await runCheck(await checkCommand(argv, cwd, env), { cwd, env, signal: stop })
      results.push({ argv: [...argv], stdout: output.stdout, stderr: output.stderr })
    } catch (cause) {
      const reason = timer.aborted ? 'timed out' : signal?.aborted ? 'was cancelled' : 'failed'
      const detail = String(cause.stderr || cause.stdout || cause.message).slice(-4096)
      throw new Error('Check ' + reason + ': ' + argv[0] + '\n' + detail, { cause })
    }
  }
  return results
}
