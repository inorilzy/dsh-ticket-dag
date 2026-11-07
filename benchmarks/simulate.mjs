#!/usr/bin/env node
// node benchmarks/simulate.mjs [--slow-seconds N] [--only each,f] [--timeout S] [--json] [--keep]
//
// 第一层模拟对比：同一份 8 张工单，用脚本 worker（不调用模型）在临时 Git 仓库里跑真实的
// Coordinator，每种配置一个新仓库，比较总耗时、排队、验收次数、跳过、冲突、尝试，
// 以及逻辑错误在哪个阶段被发现、是否定位到工单 L。说明见 benchmarks/README.md。
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { Coordinator } from '../src/coordinator.mjs'
import { runTiming } from '../src/timing.mjs'

/**
 * 每种配置是传给 Coordinator 的 profile 设置。新增模式只需在这里加一项，
 * 工单、夹具和指标都不用改。
 */
export const CONFIGS = {
  each: { title: 'each（现状）', settings: { integrationMode: 'each', selectChecksByFiles: false } },
  f: { title: 'F 按文件选测试', settings: { integrationMode: 'each', selectChecksByFiles: true } },
  a: { title: 'A 先合并、最后测', settings: { integrationMode: 'end', selectChecksByFiles: false } },
  af: { title: 'A+F', settings: { integrationMode: 'end', selectChecksByFiles: true } },
  e: { title: 'E 验收在 worker 侧', settings: { integrationMode: 'worker', selectChecksByFiles: false } },
  aef: { title: 'A+E+F', settings: { integrationMode: 'worker-end', selectChecksByFiles: true } },
  b: { title: 'B 合并列车', settings: { integrationMode: 'train', selectChecksByFiles: false, trainSize: 4 } },
}

const USAGE =
  'usage: node benchmarks/simulate.mjs [--slow-seconds N] [--only ' + Object.keys(CONFIGS).join(',') + '] [--timeout S] [--json] [--keep]'

// 与 test/coordinator.test.mjs 相同：不读用户和系统的 Git 配置。
const exec = promisify(execFile)
const gitEnv = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
}
const git = async (cwd, ...args) => (await exec('git', args, { cwd, env: gitEnv })).stdout.trim()

const tenLines = Array.from({ length: 10 }, (_, i) => 'line ' + (i + 1)).join('\n') + '\n'
const SEED = {
  'src/shared1.txt': 'base\n',
  'src/shared2.txt': tenLines,
  'src/shared3.txt': tenLines,
  'docs/README.md': '# docs\n',
}

// 改同一文件的不同行，可以干净合并。
const editLine = (index, text) => (body) => {
  const lines = body.split('\n')
  lines[index] = text
  return lines.join('\n')
}

/**
 * 8 张工单：3 组改同一文件（S1 两张改同一行，后合入的一张必然冲突；S2、S3 改不同行，
 * 合并干净），L 合并干净但写入 logic-bug.txt=bad 让 slow 失败，D 只改 docs/（F 能跳过 slow）。
 * D 依赖 S2a，保证它集成时累计验收里已经有 slow。
 */
export const TICKETS = [
  { id: 'S1a', file: 'src/shared1.txt', edit: () => 'from S1a\n', verify: ['fast', 'slow'] },
  { id: 'S1b', file: 'src/shared1.txt', edit: () => 'from S1b\n', verify: ['fast', 'slow'] },
  { id: 'S2a', file: 'src/shared2.txt', edit: editLine(0, 'S2a was here'), verify: ['fast', 'slow'] },
  { id: 'S2b', file: 'src/shared2.txt', edit: editLine(9, 'S2b was here'), verify: ['fast', 'slow'] },
  { id: 'S3a', file: 'src/shared3.txt', edit: editLine(0, 'S3a was here'), verify: ['fast', 'slow'] },
  { id: 'S3b', file: 'src/shared3.txt', edit: editLine(9, 'S3b was here'), verify: ['fast', 'slow'] },
  { id: 'L', file: 'logic-bug.txt', edit: () => 'bad\n', verify: ['slow'] },
  { id: 'D', file: 'docs/guide.md', edit: () => '# guide\n', verify: ['fast'], dependsOn: ['S2a'] },
]
export const CHECK_META = {
  fast: { files: ['**'], fast: true },
  slow: { files: ['src/**', 'logic-bug.txt'], fast: false },
}

// slow：睡指定秒数；logic-bug.txt 内容为 bad 时失败，并在输出里点名，让修复提示词能看到。
const SLOW_SCRIPT = `
const { existsSync, readFileSync } = require('node:fs')
const seconds = Number(process.argv[2])
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.round(seconds * 1000))
if (existsSync('logic-bug.txt') && readFileSync('logic-bug.txt', 'utf8').trim() === 'bad') {
  console.error('logic-bug.txt is bad: the logic error broke the slow check')
  process.exit(1)
}
`

function parseArgs(argv) {
  const opts = { slowSeconds: 2, only: Object.keys(CONFIGS), timeoutS: 300, json: false, keep: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const value = () => {
      if (i + 1 >= argv.length) fail('missing value for ' + arg)
      return argv[++i]
    }
    if (arg === '--json') opts.json = true
    else if (arg === '--keep') opts.keep = true
    else if (arg === '--slow-seconds') opts.slowSeconds = Number(value())
    else if (arg === '--timeout') opts.timeoutS = Number(value())
    else if (arg === '--only') opts.only = value().split(',').map((s) => s.trim()).filter(Boolean)
    else fail('unknown argument ' + arg)
  }
  if (!Number.isFinite(opts.slowSeconds) || opts.slowSeconds < 0) fail('--slow-seconds must be a nonnegative number')
  if (!Number.isFinite(opts.timeoutS) || opts.timeoutS <= 0) fail('--timeout must be a positive number')
  for (const name of opts.only) if (!Object.hasOwn(CONFIGS, name)) fail('unknown config ' + name)
  if (!opts.only.length) fail('--only needs at least one config')
  return opts
}

function fail(message) {
  console.error('simulate: ' + message)
  console.error(USAGE)
  process.exit(1)
}

async function seedRepo(root) {
  const cwd = join(root, 'project')
  await mkdir(cwd, { recursive: true })
  await git(cwd, 'init', '-q', '-b', 'main')
  await git(cwd, 'config', 'user.name', 'simulate')
  await git(cwd, 'config', 'user.email', 'simulate@example.invalid')
  for (const [file, body] of Object.entries(SEED)) {
    await mkdir(dirname(join(cwd, file)), { recursive: true })
    await writeFile(join(cwd, file), body)
  }
  await git(cwd, 'add', '.')
  await git(cwd, 'commit', '-qm', 'seed')
  return cwd
}

async function commitStamped(job, subject) {
  const trailers = ['DAG-Run: ' + job.runId, 'DAG-Ticket: ' + job.ticketId, 'DAG-Attempt: ' + job.attempt, 'DAG-Complete: yes']
  await git(job.cwd, 'commit', '-q', '--allow-empty', '-m', subject, '-m', trailers.join('\n'))
}

// 冲突重试：合入集成分支，冲突文件去掉标记、保留双方内容（并集）。
async function mergeIntegration(job) {
  try {
    await git(job.cwd, 'merge', '--no-ff', '--no-commit', 'integration/' + job.runId)
  } catch {
    const files = (await git(job.cwd, 'diff', '--name-only', '--diff-filter=U')).split('\n').filter(Boolean)
    for (const file of files) {
      const body = await readFile(join(job.cwd, file), 'utf8')
      await writeFile(join(job.cwd, file), body.split('\n').filter((l) => !/^(<{7}|={7}|>{7})/.test(l)).join('\n'))
      await git(job.cwd, 'add', '--', file)
    }
  }
}

/**
 * 脚本 worker：首次尝试按工单表改文件；冲突退回时合入集成分支；被要求修复逻辑错误时
 * （提示词提到 logic-bug 或验收失败，含后续阶段自动追加的 fix-* 工单）把 logic-bug.txt 改成 ok。
 */
function scriptedWorker() {
  const byId = new Map(TICKETS.map((t) => [t.id, t]))
  return async (job) => ({
    dispose: async () => {},
    result: (async () => {
      const conflicted = /conflicted with the integration branch/.test(job.prompt)
      const repair = /logic-bug|did not pass|Check failed|Worker-side checks failed|Merge-train checks failed/.test(job.prompt) && (job.attempt > 1 || !byId.has(job.ticketId))
      if (conflicted) {
        await mergeIntegration(job)
        await commitStamped(job, 'Merge integration into ' + job.ticketId)
      } else if (repair) {
        await writeFile(join(job.cwd, 'logic-bug.txt'), 'ok\n')
        await git(job.cwd, 'add', '--', 'logic-bug.txt')
        await commitStamped(job, 'Fix logic bug for ' + job.ticketId)
      } else {
        const t = byId.get(job.ticketId)
        if (!t) return { ok: false, detail: 'simulate: no script for ' + job.ticketId }
        const path = join(job.cwd, t.file)
        await mkdir(dirname(path), { recursive: true })
        const before = existsSync(path) ? await readFile(path, 'utf8') : ''
        await writeFile(path, t.edit(before))
        await git(job.cwd, 'add', '--', t.file)
        await commitStamped(job, 'Deliver ' + job.ticketId)
      }
      return { ok: true }
    })(),
  })
}

// 逻辑错误第一次被哪条失败的 slow 发现，以及能否归到工单 L。
// 后续阶段的事件（final_verify_failed 的 culprit、check_requeued 的工单）也在这里认。
function logicBugReport(events) {
  const first = events.find(
    (e) => e.type === 'check_finished' && e.details?.checkId === 'slow' && e.details.ok === false && !e.details.aborted,
  )
  if (!first) return { foundAt: 'never', located: null }
  const culprit =
    events.find((e) => e.details?.culprit)?.details.culprit ??
    first.ticketId ??
    events.find((e) => e.type === 'check_requeued')?.ticketId ??
    null
  return { foundAt: first.details.stage ?? 'lane', located: culprit }
}

// 运行完成：最后一次 run_completed 在最后一次 integrated 之后（end 类模式的完成在最终全量之后）。
function finished(events) {
  const done = events.findLastIndex((e) => e.type === 'run_completed')
  return done >= 0 && done > events.findLastIndex((e) => e.type === 'integrated')
}

export async function simulate(name, { slowSeconds = 2, timeoutS = 300, keep = false } = {}) {
  const config = CONFIGS[name]
  const root = await mkdtemp(join(tmpdir(), 'dag-simulate-' + name + '-'))
  const slowScript = join(root, 'slow.cjs')
  await writeFile(slowScript, SLOW_SCRIPT)
  const cwd = await seedRepo(root)
  const co = new Coordinator({
    launch: scriptedWorker(),
    notify: async () => true,
    // 脚本 worker 跑完即退出，队长重试总是安全的。
    canRetry: async () => true,
    requireApproval: false,
    maxWorkers: 8,
    checkTimeoutMs: Math.max(120000, Math.ceil(slowSeconds * 1000) * 4),
    checks: {
      fast: [[process.execPath, '-e', 'process.exit(0)']],
      slow: [[process.execPath, slowScript, String(slowSeconds)]],
    },
    checkMeta: CHECK_META,
    ...config.settings,
  })
  const runId = 'sim-' + name
  const q = { cwd, parentId: 'simulate-captain', runId }
  const began = Date.now()
  let captainRetries = 0
  let outcome = 'completed'
  let snapshot
  let events = []
  try {
    snapshot = await co.start({
      ...q,
      manifest: {
        spec_id: 'simulate',
        max_workers: 8,
        tickets: TICKETS.map((t) => ({ id: t.id, title: t.id, verify: t.verify, depends_on: t.dependsOn ?? [] })),
      },
    })
    const run = [...co.runs.values()].find((r) => r.db.meta().runId === runId)
    while (true) {
      snapshot = await co.status(q)
      events = run.db.events()
      if (finished(events) && snapshot.complete) break
      if (Date.now() - began > timeoutS * 1000) {
        outcome = 'timeout'
        break
      }
      if (snapshot.mode !== 'active' && snapshot.mode !== 'staged') {
        outcome = 'blocked: ' + (snapshot.diagnostic ?? snapshot.mode)
        break
      }
      // 扮演队长：处理“需要处理”的工单（在 each 下，验收失败会停在这里）。
      for (const t of snapshot.tickets.filter((t) => t.status === 'NEEDS_ATTENTION')) {
        if (captainRetries >= 10) {
          outcome = 'blocked: too many captain retries'
          break
        }
        try {
          await co.retry({ ...q, id: t.id })
          captainRetries++
        } catch {
          // The worker may still be settling; try again on the next poll.
        }
      }
      if (outcome !== 'completed') break
      await sleep(50)
    }
    events = run.db.events()
    const timing = runTiming(events, Date.now())
    let finalLogic = 'missing'
    try {
      finalLogic = await git(cwd, 'show', 'integration/' + runId + ':logic-bug.txt')
    } catch {}
    return {
      config: name,
      title: config.title,
      settings: config.settings,
      integration: snapshot.integration,
      outcome,
      wallMs: Date.now() - began,
      accumulatedMs: timing?.accumulatedMs ?? null,
      queueMs: timing?.totals.queueMs ?? null,
      verifyMs: timing?.totals.verifyMs ?? null,
      checkRuns: timing?.totals.checkRuns ?? 0,
      checkFailures: timing?.totals.checkFailures ?? 0,
      skippedChecks: timing?.totals.skippedChecks ?? 0,
      conflicts: timing?.totals.conflicts ?? 0,
      attempts: timing?.totals.attempts ?? 0,
      captainRetries,
      // worker 模式：集成通道因集成分支前进而补跑全部验收的次数（只在 --json 里）。
      reverifies: events.filter((e) => e.type === 'reverify').length,
      // train 模式：列车趟数（只在 --json 里）。
      trains: events.filter((e) => e.type === 'train_started').length,
      ...logicBugReport(events),
      finalLogic,
      integrated: snapshot.counts.INTEGRATED ?? 0,
      tickets: snapshot.tickets.length,
      repo: keep ? cwd : null,
    }
  } finally {
    await co.close()
    if (!keep) await rm(root, { recursive: true, force: true, maxRetries: 3 })
  }
}

function seconds(ms) {
  return ms === null ? '—' : (ms / 1000).toFixed(1) + 's'
}

export function markdown(results, slowSeconds) {
  const row = (cells) => '| ' + cells.join(' | ') + ' |'
  const headers = [
    '配置', '集成模式', '结果', '总耗时', '集成排队', '验收耗时', '验收命令次数', '验收失败', '跳过验收',
    '冲突', '尝试', '队长重试', '逻辑错误发现于', '定位工单', '最终 logic-bug.txt',
  ]
  const lines = [row(headers), row(headers.map(() => '---'))]
  for (const r of results) {
    lines.push(
      row([
        r.config,
        r.integration.mode + (r.integration.selectChecksByFiles ? '+F' : ''),
        r.outcome === 'completed' ? `完成 ${r.integrated}/${r.tickets}` : r.outcome,
        seconds(r.accumulatedMs),
        seconds(r.queueMs),
        seconds(r.verifyMs),
        r.checkRuns,
        r.checkFailures,
        r.skippedChecks,
        r.conflicts,
        r.attempts,
        r.captainRetries,
        r.foundAt,
        r.located ?? '—',
        r.finalLogic,
      ]),
    )
  }
  lines.push('', `slow 每次 ${slowSeconds} 秒；8 张工单，并发 8。总耗时是 runTiming 的累计用时；队长重试是模拟队长对“需要处理”工单调用 dag_retry 的次数。`)
  return lines.join('\n')
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const opts = parseArgs(process.argv.slice(2))
  const results = []
  for (const name of opts.only) {
    if (!opts.json) console.error('simulate: running ' + name + ' …')
    results.push(await simulate(name, opts))
  }
  console.log(opts.json ? JSON.stringify({ slowSeconds: opts.slowSeconds, results }, null, 2) : markdown(results, opts.slowSeconds))
  if (results.some((r) => r.outcome !== 'completed')) process.exitCode = 2
}
