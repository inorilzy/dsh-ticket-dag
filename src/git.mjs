import { execFile, spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, lstat, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { basename, delimiter, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
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

// Passed identity checks, keyed by checkout and expected common directory. An
// entry is reused only while the checkout directory, its .git entry and any
// commondir redirect are the very same unmodified filesystem objects.
const verifiedIdentity = new Map()

async function identityPrint(root) {
  // Git itself keeps writing inside directories, so only their identity counts.
  const entry = (s) => [s.dev, s.ino, s.birthtimeNs, ...(s.isDirectory() ? [] : [s.mtimeNs, s.size])].join('.')
  try {
    const dotGit = join(root, '.git')
    const [dir, link] = await Promise.all([stat(root, { bigint: true }), lstat(dotGit, { bigint: true })])
    const parts = [dir.dev, dir.ino, dir.birthtimeNs, entry(link)]
    let admin = dotGit
    if (link.isFile()) {
      const text = await readFile(dotGit, 'utf8')
      parts.push(text)
      admin = resolve(root, text.replace(/^gitdir: */, '').trim())
      parts.push(entry(await stat(admin, { bigint: true })))
    } else if (!link.isDirectory()) return null
    const commondir = join(admin, 'commondir')
    try {
      parts.push(entry(await lstat(commondir, { bigint: true })), await readFile(commondir, 'utf8'))
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
    }
    return parts.join('|')
  } catch {
    // Unknown layout: never reuse a cached answer.
    return null
  }
}

// Persisted metadata identifies one repository, even if the original checkout
// path is subsequently replaced by another clone containing the very same SHAs.
async function checkIdentity(repo) {
  const root = rootOf(repo)
  const key = root + '\0' + repo.commonDir
  const print = await identityPrint(root)
  const known = verifiedIdentity.get(key)
  if (print !== null && known?.print === print) return known.check
  const check = (async () => {
    const actual = await git(root, 'rev-parse', '--path-format=absolute', '--git-common-dir')
    verify((await realpath(actual)) === repo.commonDir, 'Git repository identity changed')
  })()
  if (print !== null) {
    verifiedIdentity.set(key, { print, check })
    check.catch(() => {
      if (verifiedIdentity.get(key)?.check === check) verifiedIdentity.delete(key)
    })
  }
  return check
}

// Absolute host git, keyed by PATH and PATHEXT. cwd is not part of the key: a
// checkout must not be able to change which git later commands run.
const gitPrograms = new Map()
function gitProgram(env) {
  const key = (envValue(env, 'PATH') ?? '') + '\0' + (envValue(env, 'PATHEXT') ?? '')
  let found = gitPrograms.get(key)
  if (!found) {
    found = resolveProgram('git', null, env, { native: true })
    gitPrograms.set(key, found)
    found.catch(() => {
      if (gitPrograms.get(key) === found) gitPrograms.delete(key)
    })
  }
  return found
}

async function git(repo, ...args) {
  if (typeof repo === 'object' && repo?.commonDir) await checkIdentity(repo)
  const env = envForCheckout()
  const { stdout } = await exec(await gitProgram(env), args, {
    cwd: rootOf(repo),
    env,
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

/** Repository paths that differ between two commits. -z keeps unusual names unquoted; renames count as delete plus add. */
export async function changedFiles(repo, fromSha, toSha) {
  const out = await git(repo, 'diff', '--name-only', '--no-renames', '-z', oid(fromSha), oid(toSha), '--')
  return out.split('\0').filter(Boolean)
}

function candidatePin(candidate) {
  return 'refs/dsh-ticket-dag/candidates/' + oid(candidate)
}

/** Full message of the precise immutable commit, including its completion metadata. */
export async function readCommitMessage(repo, sha) {
  const commit = await resolveRef(repo, oid(sha))
  return git(repo, 'show', '-s', '--format=%B', commit)
}

async function candidateOwner(wt, create, kind = 'candidate') {
  // This file is private to the linked checkout, outside the tracked/tested tree.
  // A candidate and a probe carry different markers, so neither helper adopts the other's checkout.
  const admin = await git(wt, 'rev-parse', '--absolute-git-dir')
  const marker = join(admin, 'dsh-ticket-dag-' + kind + '-v1')
  const expected = await realpath(wt)
  if (create) await writeFile(marker, expected, { encoding: 'utf8', flag: 'wx' })
  else
    verify(
      (await exists(marker)) && (await readFile(marker, 'utf8')) === expected,
      'Checkout is not a ' + kind + ' owned by dsh-ticket-dag: ' + wt,
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
      // A content conflict is the ticket's to resolve on its own branch: record the
      // files, abort the plugin-owned trial so the checkout is clean for the next try.
      const conflicts = await optionalGit(wt, 'diff', '--name-only', '--diff-filter=U').catch(() => null)
      if (conflicts) {
        await git(wt, 'merge', '--abort')
        const files = conflicts.split(/\r?\n/).filter(Boolean)
        const error = new Error('Trial merge conflicts with the integration tip in: ' + files.join(', '), {
          cause: err,
        })
        error.conflicts = files
        throw error
      }
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

/**
 * A merge train: in a fresh plugin-owned detached checkout of oldTip, merge
 * each source in order with --no-ff, so merge i has the parents (merge i-1 or
 * oldTip, source i) and can be published by itself with publishCandidate. A
 * source that conflicts is aborted and skipped; the next one merges onto the
 * previous merge. Each merge is pinned like a candidate until it is published
 * or unpinned. A merge that fails for another reason stops the train with
 * err.sourceSha set and the checkout preserved for inspection.
 * @returns { merges: [{ sourceSha, sha }], conflicts: [{ sourceSha, files }] }
 */
export async function buildTrain(repo, path, oldTip, sources) {
  const wt = checkoutPath(path)
  const old = await resolveRef(repo, oid(oldTip))
  verify(Array.isArray(sources) && sources.length > 0, 'A merge train needs at least one source')
  verify(!(await exists(wt)), 'Merge train checkout already exists: ' + wt)
  await mkdir(dirname(wt), { recursive: true })
  try {
    await git(repo, 'worktree', 'add', '--detach', '--', wt, old)
    await candidateOwner(wt, true)
  } catch (err) {
    err.trainSetup = true
    throw err
  }
  const merges = [],
    conflicts = []
  let head = old
  for (const value of sources) {
    const source = await resolveRef(repo, oid(value))
    if (await isAncestor(repo, source, head)) {
      const error = new Error('Source ' + source + ' already belongs to the merge train base; inspect the ticket branch')
      error.sourceSha = source
      for (const x of merges) await git(repo, 'update-ref', '-d', candidatePin(x.sha), x.sha).catch(() => {})
      throw error
    }
    try {
      await git(wt, 'merge', '--no-ff', '--no-edit', '--no-overwrite-ignore', '-m', 'dsh-ticket-dag: verify ' + source, source)
    } catch (err) {
      const files = await optionalGit(wt, 'diff', '--name-only', '--diff-filter=U').catch(() => null)
      if (files) {
        // Back to the previous merge, clean, so the rest of the train still merges.
        await git(wt, 'merge', '--abort')
        conflicts.push({ sourceSha: source, files: files.split(/\r?\n/).filter(Boolean) })
        continue
      }
      const error = new Error(
        'Merge train failed to merge ' + source + '; checkout preserved at ' + wt + '. ' + err.message,
        { cause: err },
      )
      error.sourceSha = source
      // The merges before it will not be published from this train.
      for (const x of merges) await git(repo, 'update-ref', '-d', candidatePin(x.sha), x.sha).catch(() => {})
      throw error
    }
    const sha = await resolveRef(wt, 'HEAD')
    await assertMergeParents(repo, sha, head, source)
    await git(repo, 'update-ref', candidatePin(sha), sha)
    merges.push({ sourceSha: source, sha })
    head = sha
  }
  await assertCandidate(repo, wt, head)
  return { merges, conflicts }
}

/**
 * Move a clean plugin-owned candidate checkout from one commit to another
 * (a merge train bisects in its own checkout instead of adding probes).
 */
export async function switchCandidate(repo, path, fromSha, toSha) {
  const wt = checkoutPath(path)
  await assertCandidate(repo, wt, fromSha)
  const to = await resolveRef(repo, oid(toSha))
  if (to !== fromSha) await git(wt, 'switch', '--detach', '--no-overwrite-ignore', to)
  return assertCandidate(repo, wt, to)
}

/** Drop the reachability pin of a train merge that will not be published. */
export async function unpinCandidate(repo, sha) {
  await git(repo, 'update-ref', '-d', candidatePin(sha), oid(sha))
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

async function assertProbe(repo, wt, sha) {
  await checkoutInfo(repo, wt)
  await candidateOwner(wt, false, 'probe')
  const state = await workState(wt)
  verify(
    state.branch === null && state.head === sha && state.clean && !state.inProgress,
    'Probe checkout changed, is on a branch, or has local changes: ' + wt,
  )
}

/**
 * A detached plugin-owned checkout of an already published commit, where the
 * final full check and its bisection run. Re-adopts a clean probe of the same
 * commit left by an interrupted process; refuses anything else at the path.
 */
export async function addProbe(repo, path, sha) {
  const wt = checkoutPath(path)
  const commit = await resolveRef(repo, oid(sha))
  if (!(await exists(wt))) {
    await mkdir(dirname(wt), { recursive: true })
    await git(repo, 'worktree', 'add', '--detach', '--', wt, commit)
    await candidateOwner(wt, true, 'probe')
  }
  await assertProbe(repo, wt, commit)
  return wt
}

/** Remove only a clean probe this plugin created, at the expected commit. Never forces. */
export async function releaseProbe(repo, path, sha) {
  const wt = checkoutPath(path)
  await assertProbe(repo, wt, oid(sha))
  const leftovers = await git(wt, 'status', '--porcelain=v1', '--ignored=matching', '--untracked-files=all', '-z')
  verify(!leftovers, 'Probe contains ignored or untracked files; retained at ' + wt)
  await git(repo, 'worktree', 'remove', '--', wt)
}

/** The first-parent commits after base up to tip, oldest first: on an integration ref, one merge per landed ticket. */
export async function firstParentCommits(repo, baseSha, tipSha) {
  const out = await git(repo, 'rev-list', '--first-parent', '--reverse', oid(baseSha) + '..' + oid(tipSha), '--')
  return out.split(/\r?\n/).filter(Boolean).map(oid)
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

// Comparable form of a checkout path: canonical when it exists, case-folded on Windows.
// A missing path takes the canonical form of its nearest existing ancestor.
async function pathKey(path) {
  let full = resolve(path)
  const rest = []
  for (;;) {
    try {
      full = join(await realpath(full), ...rest)
      break
    } catch (err) {
      if (err.code !== 'ENOENT' || dirname(full) === full) throw err
      rest.unshift(basename(full))
      full = dirname(full)
    }
  }
  return process.platform === 'win32' ? full.toLowerCase() : full
}

function inside(root, path) {
  const rest = relative(root, path)
  return rest !== '' && !rest.startsWith('..') && !isAbsolute(rest)
}

async function worktreeList(repo) {
  const entries = []
  for (const record of (await git(repo, 'worktree', 'list', '--porcelain', '-z')).split('\0\0')) {
    const fields = record.split('\0').filter(Boolean)
    const path = fields.find((f) => f.startsWith('worktree '))?.slice('worktree '.length)
    if (!path) continue
    const branch = fields.find((f) => f.startsWith('branch '))?.slice('branch '.length) ?? null
    entries.push({ key: await pathKey(path), branch })
  }
  return entries
}

/** The local branch a base ref names: a branch itself, HEAD's branch, or none for a commit ID. */
async function baseBranch(repo, baseRef) {
  if (typeof baseRef !== 'string' || !baseRef || oidPattern.test(baseRef)) return null
  if (baseRef === 'HEAD') return optionalGit(repo, 'symbolic-ref', '--quiet', 'HEAD')
  return 'refs/heads/' + baseRef.replace(/^refs\/heads\//, '')
}

/**
 * Why a worktree must stay, or null when nothing local would be lost. A plain
 * git worktree remove deletes ignored files without complaint, and user config
 * can hide untracked files or submodule changes, so every option is explicit.
 */
async function localFilesReason(wt) {
  const status = await git(
    wt,
    'status',
    '--porcelain=v1',
    '--ignored=matching',
    '--untracked-files=all',
    '--ignore-submodules=none',
    '--no-renames',
    '-z',
  )
  if (!status) return null
  const kinds = { 'tracked changes': [], untracked: [], ignored: [] }
  for (const entry of status.split('\0').filter(Boolean)) {
    const code = entry.slice(0, 2)
    kinds[code === '!!' ? 'ignored' : code === '??' ? 'untracked' : 'tracked changes'].push(entry.slice(3))
  }
  // Names only, bounded, and quoted so a hostile file name stays one inert token in the diagnostic.
  const parts = Object.entries(kinds)
    .filter(([, names]) => names.length)
    .map(([kind, names]) => {
      const shown = names.slice(0, 5).map((name) => JSON.stringify(name.slice(0, 120)))
      const more = names.length > shown.length ? ', and ' + (names.length - shown.length) + ' more' : ''
      return kind + ': ' + shown.join(', ') + more
    })
  return 'worktree has uncommitted local files (' + parts.join('; ') + '): ' + wt
}

/**
 * Remove one integrated ticket's recorded worktree and branch. Refuses (throws)
 * a protected branch, a path outside the plugin worktree root, the main
 * worktree, or a branch checked out elsewhere. Skips (with a reason) work not
 * merged into the integration branch or a worktree holding tracked changes,
 * untracked or ignored files. Never forces: git worktree remove, then git
 * branch -d against the integration branch as its upstream, then git worktree
 * prune. Repeating it is harmless.
 */
export async function cleanupWorktree(repo, { path, branch, target, baseRef, root }) {
  await checkedRef(repo, target, targetPattern)
  const ref = 'refs/heads/' + String(branch ?? '').replace(/^refs\/heads\//, '')
  const protectedRefs = [target, await baseBranch(repo, baseRef)].filter(Boolean)
  verify(!protectedRefs.includes(ref), 'Refusing to delete protected branch: ' + ref)
  const name = await ticketBranch(repo, branch)
  const wt = checkoutPath(path)
  verify(typeof root === 'string' && isAbsolute(root), 'The plugin worktree root must be absolute')
  const key = await pathKey(wt)
  verify(inside(await pathKey(root), key), 'Refusing a path outside the plugin worktree root: ' + wt)
  const worktrees = await worktreeList(repo)
  verify(
    key !== worktrees[0]?.key && key !== (await pathKey(rootOf(repo))),
    'Refusing to remove the main worktree: ' + wt,
  )
  const own = worktrees.find((w) => w.key === key)
  verify(!own || own.branch === ref, 'Worktree has another branch checked out: ' + wt)
  verify(
    !worktrees.some((w) => w.key !== key && w.branch === ref),
    'Ticket branch is checked out in another worktree: ' + ref,
  )
  const hasBranch = await localRefExists(repo, ref)
  if (!own && (await exists(wt))) return { status: 'skipped', reason: 'path is not a registered worktree: ' + wt }
  if (!own && !hasBranch) {
    await git(repo, 'worktree', 'prune')
    return { status: 'cleaned' }
  }
  if (hasBranch && !(await isAncestor(repo, await resolveRef(repo, ref), await resolveRef(repo, target))))
    return { status: 'skipped', reason: 'ticket branch is not merged into ' + target }
  if (own) {
    const reason = await localFilesReason(wt)
    if (reason) return { status: 'skipped', reason }
    await git(repo, 'worktree', 'remove', '--', wt)
  }
  if (hasBranch) {
    // -d checks a branch against its upstream; the integration branch is the one it merged into.
    await git(repo, 'branch', '--set-upstream-to=' + target.replace(/^refs\/heads\//, ''), name)
    await git(repo, 'branch', '-d', name)
  }
  await git(repo, 'worktree', 'prune')
  return { status: 'cleaned' }
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

async function isProgram(path) {
  if (!(await isFile(path))) return false
  if (isWindows) return true
  try {
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

// Absolute PATH entries only. Empty and relative entries are the current
// directory in disguise, and Windows also searches the child cwd before PATH.
function trustedPathDirs(env) {
  return (envValue(env, 'PATH') || '')
    .split(delimiter)
    .map((entry) => {
      const trimmed = entry.trim()
      return (isWindows ? trimmed.replace(/^"(.*)"$/, '$1') : trimmed).trim()
    })
    .filter((dir) => dir && isAbsolute(dir))
}

function pathexts(env, native) {
  if (!isWindows) return []
  return (envValue(env, 'PATHEXT') || '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((ext) => ext.trim().toLowerCase())
    .filter((ext) => ext && (!native || ext === '.com' || ext === '.exe'))
}

/**
 * Absolute path of the program argv[0] names. A bare name is looked up only in
 * absolute entries of the host PATH: never in cwd, and never in relative
 * entries such as "." that would resolve inside the candidate checkout. A name
 * that already contains a path separator is an explicit project script and
 * resolves against cwd. Missing programs fail loudly.
 * `native` limits Windows to .com/.exe, which execFile can start without a shell.
 */
async function resolveProgram(command, cwd, env, { native = false } = {}) {
  const exts = pathexts(env, native)
  // Windows does not append PATHEXT when the name already contains a dot.
  const names = !isWindows || extname(command) ? [command] : exts.map((ext) => command + ext)
  const explicit = isAbsolute(command) || /[\\/]/.test(command)
  const dirs = explicit ? [cwd ?? process.cwd()] : trustedPathDirs(env)
  for (const dir of dirs) {
    for (const name of names) {
      const found = resolve(dir, name)
      if (!(await isProgram(found))) continue
      verify(isAbsolute(found), 'Resolved program is not absolute: ' + command)
      return found
    }
  }
  throw Object.assign(
    new Error(
      explicit
        ? 'Program not found: ' +
          command +
          (cwd && !isAbsolute(command) ? ' (relative to ' + cwd + ')' : '')
        : 'Program not found on the trusted host PATH (absolute entries only): ' + command,
    ),
    { code: 'ENOENT' },
  )
}

function quoteForCmd(arg) {
  verify(!cmdMeta.test(arg), 'Check argument contains a cmd.exe metacharacter ("%!^&|<>, CR or LF): ' + arg)
  // Double trailing backslashes so the closing quote survives CRT argv parsing downstream.
  return '"' + arg.replace(/(\\+)$/, '$1$1') + '"'
}

/** spawn() arguments; .cmd/.bat run via cmd.exe with strictly quoted, metacharacter-free tokens. */
async function checkCommand(argv, cwd, env) {
  const program = await resolveProgram(argv[0], cwd, env)
  if (!isWindows || !/\.(?:bat|cmd)$/i.test(program))
    return { file: program, args: argv.slice(1), verbatim: false }
  const line = [program, ...argv.slice(1)].map(quoteForCmd).join(' ')
  // A relative COMSPEC would be resolved inside the candidate checkout.
  const configured = envValue(env, 'COMSPEC')
  const comspec =
    configured && isAbsolute(configured)
      ? configured
      : join(envValue(env, 'SYSTEMROOT') || 'C:\\Windows', 'System32', 'cmd.exe')
  return { file: comspec, args: ['/d', '/s', '/v:off', '/c', '"' + line + '"'], verbatim: true }
}

function killTree(child) {
  if (!child.pid) return Promise.resolve()
  if (isWindows) {
    const root = envValue(process.env, 'SYSTEMROOT') || 'C:\\Windows'
    const taskkill = join(root, 'System32', 'taskkill.exe')
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
