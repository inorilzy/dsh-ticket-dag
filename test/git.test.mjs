import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, mkdir, writeFile, readFile, rm, access } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  repoInfo,
  resolveRef,
  initIntegration,
  localRefExists,
  prepareWorktree,
  inspectWorktree,
  isAncestor,
  verifySource,
  buildCandidate,
  assertCandidate,
  assertMergeParents,
  readCommitMessage,
  publishCandidate,
  releaseCandidate,
  runChecks,
} from '../src/git.mjs'

const exec = promisify(execFile)
const target = 'refs/heads/integration/test-run'
async function g(cwd, ...args) {
  const { stdout } = await exec('git', args, {
    cwd,
    windowsHide: true,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
  })
  return stdout.trim()
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-ticket-git-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }))
  const main = join(root, 'main')
  await mkdir(main)
  await g(main, 'init', '-q', '-b', 'main')
  await g(main, 'config', 'user.name', 'DAG test')
  await g(main, 'config', 'user.email', 'test@example.invalid')
  await g(main, 'config', 'commit.gpgSign', 'false')
  await writeFile(join(main, 'common.txt'), 'before\n')
  await g(main, 'add', 'common.txt')
  await g(main, 'commit', '-qm', 'Seed')
  const repo = await repoInfo(main)
  const base = await resolveRef(repo, 'main')
  return { root, main, repo, base }
}
async function finish(cwd, file, data, message) {
  await writeFile(join(cwd, file), data)
  await g(cwd, 'add', '--', file)
  await g(cwd, 'commit', '-qm', message)
  return resolveRef(cwd, 'HEAD')
}

test('integration ownership is local only and initial reference creation is an atomic claim', async (t) => {
  const { repo, base, main } = await fixture(t)
  assert.equal(await localRefExists(repo, target), false)
  await assert.rejects(localRefExists('/this/checkout/does/not/exist', target))
  await assert.rejects(localRefExists(repo, 'refs/remotes/origin/a'))
  assert.equal(await initIntegration(repo, target, 'refs/heads/main'), base)
  assert.equal(await localRefExists(repo, target), true)
  await assert.rejects(initIntegration(repo, target, base))
  for (const ref of [
    'refs/heads/main',
    'refs/remotes/origin/a',
    'refs/heads/integration/../evil',
    'refs/heads/integration/t/a',
    '--help',
    'refs/heads/integration/run.lock',
  ]) {
    await assert.rejects(initIntegration(repo, ref, base))
  }
  await g(main, 'update-ref', 'refs/remotes/origin/main', base)
  await g(main, 'tag', 'version-one', base)
  for (const name of [
    '--all',
    'refs/remotes/origin/main',
    'origin/main',
    'refs/tags/version-one',
    'main^{commit}',
  ]) {
    await assert.rejects(resolveRef(repo, name))
  }
  assert.equal(await resolveRef(repo, 'HEAD'), base)
  assert.equal(await resolveRef(repo, base), base)
})

test('first dispatch is idempotent; a resume may keep dirty files but never the wrong ticket/repository or base', async (t) => {
  const { root, repo, base, main } = await fixture(t)
  const other = await fixture(t)
  const mismatched = { root: repo.root, commonDir: other.repo.commonDir }
  await assert.rejects(initIntegration(mismatched, target, base), /identity changed/)
  assert.equal(await localRefExists(repo, target), false)
  const slot = join(root, 'task-A'),
    branch = 'ticket/test-run/A'
  assert.deepEqual(await prepareWorktree(repo, slot, branch, base), { head: base, clean: true })
  assert.deepEqual(await prepareWorktree(repo, slot, branch, base), { head: base, clean: true })
  await assert.rejects(verifySource(repo, slot, branch, base))
  await assert.rejects(inspectWorktree(repo, slot, 'ticket/test-run/B', base))
  await assert.rejects(inspectWorktree(other.repo, slot, branch, base))
  await assert.rejects(prepareWorktree(repo, slot, '../bad', base))
  const side = await finish(main, 'other.txt', 'other\n', 'Advance main independently')
  await assert.rejects(inspectWorktree(repo, slot, branch, side, { resume: true }))
  assert.equal(await isAncestor(repo, side, base), false)
  await assert.rejects(isAncestor(repo, '1'.repeat(40), base))
  await writeFile(join(slot, 'A.txt'), 'partial\n')
  await assert.rejects(prepareWorktree(repo, slot, branch, base))
  assert.equal((await prepareWorktree(repo, slot, branch, base, { resume: true })).clean, false)
  assert.equal(await readFile(join(slot, 'A.txt'), 'utf8'), 'partial\n')
  const committed = await finish(slot, 'A.txt', 'complete\n', 'DAG-Complete: yes')
  assert.equal(await verifySource(repo, slot, branch, base), committed)
  assert.match(await readCommitMessage(repo, committed), /DAG-Complete: yes/)
  await assert.rejects(prepareWorktree(repo, slot, branch, base))
  await g(main, 'worktree', 'remove', slot)
  assert.equal((await prepareWorktree(repo, slot, branch, base, { resume: true })).head, committed)
  await mkdir(join(slot, 'nested'))
  await assert.rejects(inspectWorktree(repo, join(slot, 'nested'), branch, base, { resume: true }))
})

test('trial merges use exact parents, cannot publish a stale tip or checked-out integration, clean up only owned checkouts', async (t) => {
  const { root, repo, base, main } = await fixture(t)
  await initIntegration(repo, target, base)
  const a = join(root, 'a'),
    b = join(root, 'b'),
    trialA = join(root, 'candidate-a'),
    trialB = join(root, 'candidate-b')
  await prepareWorktree(repo, a, 'ticket/test-run/A', base)
  await prepareWorktree(repo, b, 'ticket/test-run/B', base)
  const aTip = await finish(a, 'A.txt', 'A', 'Finish A')
  const bTip = await finish(b, 'B.txt', 'B', 'Finish B')
  const candA = await buildCandidate(repo, trialA, base, aTip)
  const candB = await buildCandidate(repo, trialB, base, bTip)
  assert.equal(await assertCandidate(repo, trialA, candA), candA)
  await assertMergeParents(repo, candA, base, aTip)
  await assert.rejects(assertMergeParents(repo, candA, base, bTip))
  const held = join(root, 'user-owns-integration')
  await g(main, 'worktree', 'add', held, 'integration/test-run')
  await assert.rejects(publishCandidate(repo, target, base, candA), /checked out/)
  await g(main, 'worktree', 'remove', held)
  await publishCandidate(repo, target, base, candA)
  await assert.rejects(publishCandidate(repo, target, base, candB))
  assert.equal(await resolveRef(repo, target), candA)
  const fresh = await buildCandidate(repo, trialB, candA, bTip)
  assert.notEqual(candB, fresh)
  await publishCandidate(repo, target, candA, fresh)
  assert.equal(await isAncestor(repo, candA, fresh), true)
  await writeFile(join(trialA, 'untracked'), 'keep')
  await assert.rejects(releaseCandidate(repo, trialA, candA))
  assert.equal(await readFile(join(trialA, 'untracked'), 'utf8'), 'keep')
  await rm(join(trialA, 'untracked'))
  await releaseCandidate(repo, trialA, candA)
  await assert.rejects(access(trialA))
  const unowned = join(root, 'user-detached')
  await g(main, 'worktree', 'add', '--detach', unowned, fresh)
  await assert.rejects(releaseCandidate(repo, unowned, fresh), /not a candidate owned/)
  await access(unowned)
  await releaseCandidate(repo, trialB, fresh)
})

test('conflict state and worker commits persist; retry adopts an explicitly resolved exact merge', async (t) => {
  const { root, repo, base } = await fixture(t)
  await initIntegration(repo, target, base)
  const a = join(root, 'task-a'),
    b = join(root, 'task-b'),
    conflict = join(root, 'candidate')
  await prepareWorktree(repo, a, 'ticket/test-run/A', base)
  await prepareWorktree(repo, b, 'ticket/test-run/B', base)
  const aTip = await finish(a, 'common.txt', 'A\n', 'A')
  const bTip = await finish(b, 'common.txt', 'B\n', 'B')
  const first = await buildCandidate(repo, join(root, 'first'), base, aTip)
  await publishCandidate(repo, target, base, first)
  await assert.rejects(buildCandidate(repo, conflict, first, bTip), /checkout preserved/)
  assert.match(await readFile(join(conflict, 'common.txt'), 'utf8'), /<<<<<<</)
  assert.equal(await g(conflict, 'rev-parse', 'MERGE_HEAD'), bTip)
  await assert.rejects(buildCandidate(repo, conflict, first, bTip), /unfinished operation/)
  assert.equal(await resolveRef(repo, target), first)
  assert.equal(await resolveRef(b, 'HEAD'), bTip)
  const resolved = await finish(conflict, 'common.txt', 'A+B\n', 'Resolve ticket B with A')
  assert.equal(await buildCandidate(repo, conflict, first, bTip), resolved)
  await assertMergeParents(repo, resolved, first, bTip)
})

test('checks use exact argv, stop on nonzero exit, timeout and honor cancellation', async (t) => {
  const { main } = await fixture(t)
  const literal = '$(echo injected) && echo shell expanded'
  const checks = await runChecks(main, [
    [process.execPath, '-e', 'process.stdout.write(process.argv[1])', literal],
  ])
  assert.equal(checks[0].stdout, literal)
  await assert.rejects(runChecks(main, [[process.execPath, '-e', 'process.exit(3)']]), /failed/)
  await assert.rejects(
    runChecks(main, [[process.execPath, '-e', 'setTimeout(()=>{},60000)']], { timeoutMs: 50 }),
    /timed out/,
  )
  const interrupted = new AbortController()
  const late = runChecks(main, [[process.execPath, '-e', 'setTimeout(()=>{},60000)']], {
    signal: interrupted.signal,
  })
  setTimeout(() => interrupted.abort(), 30)
  await assert.rejects(late, /cancelled/)
})

test('Windows .cmd checks run through cmd.exe without shell injection', { skip: process.platform !== 'win32' }, async (t) => {
  const { root, main } = await fixture(t)
  const bin = join(root, 'bin dir')
  await mkdir(bin)
  const script = join(bin, 'check.cmd')
  await writeFile(script, '@echo off\r\necho cmd-ok %1 %2\r\n')
  const [result] = await runChecks(main, [[script, 'a b', 'C:\\trailing\\']])
  assert.equal(result.stdout.trim(), 'cmd-ok "a b" "C:\\trailing\\\\"')

  const previous = process.env.PATH
  process.env.PATH = bin + ';' + previous
  t.after(() => (process.env.PATH = previous))
  const [bare] = await runChecks(main, [['check', 'x']])
  assert.match(bare.stdout, /cmd-ok "x"/)

  const marker = join(root, 'injected.txt')
  for (const arg of ['a & echo x > "' + marker + '"', '%PATH%', 'a | b', 'a"b', '!x!', 'a^b', 'line\nbreak']) {
    await assert.rejects(runChecks(main, [[script, arg]]), /cmd\.exe metacharacter/)
  }
  await assert.rejects(access(marker))
})

for (const mode of ['timeout', 'cancel']) {
  test('check ' + mode + ' kills the whole process tree', async (t) => {
    const { root, main } = await fixture(t)
    const pidFile = join(root, 'grandchild.pid')
    // On Windows libuv puts node children in a kill-on-close job; breaking away
    // models grandchildren of non-node tools, which nothing kills implicitly.
    const parent = [
      "const { spawn } = require('node:child_process')",
      "const c = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', detached: process.platform === 'win32' })",
      "require('node:fs').writeFileSync(process.argv[1], String(c.pid))",
      'setInterval(()=>{},1000)',
    ].join(';')
    let grandchild
    t.after(() => {
      try {
        if (grandchild) process.kill(grandchild, 'SIGKILL')
      } catch {}
    })
    const alive = (pid) => {
      try {
        process.kill(pid, 0)
        return true
      } catch (err) {
        return err.code === 'EPERM'
      }
    }
    const interrupted = new AbortController()
    const pending = runChecks(main, [[process.execPath, '-e', parent, pidFile]], {
      timeoutMs: mode === 'timeout' ? 2000 : 60_000,
      signal: interrupted.signal,
    })
    if (mode === 'cancel') {
      const started = Date.now()
      while (Date.now() - started < 10_000) {
        try {
          await access(pidFile)
          break
        } catch {
          await new Promise((r) => setTimeout(r, 25))
        }
      }
      interrupted.abort()
    }
    await assert.rejects(pending, mode === 'timeout' ? /timed out/ : /cancelled/)
    grandchild = Number(await readFile(pidFile, 'utf8'))
    assert.ok(Number.isSafeInteger(grandchild) && grandchild > 0)
    const deadline = Date.now() + 3000
    while (alive(grandchild) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
    assert.equal(alive(grandchild), false, 'grandchild ' + grandchild + ' survived the ' + mode)
  })
}
