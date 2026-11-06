#!/usr/bin/env node
// node benchmarks/report.mjs [--json] <label=trial目录> ...
//
// 只读打开每个 trial 的运行账本，用 runTiming 算出用时并按 label 汇总成对比表。
// 同一 label 可重复，一个模式多轮。口径和实验步骤见 benchmarks/README.md。
import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { runTiming } from '../src/timing.mjs'

const USAGE = 'usage: node benchmarks/report.mjs [--json] <label=trial-directory> ...'
const MISSING = '—'
const COLUMNS = [
  ['扣除等待处理后的用时', 'netMs', duration],
  ['工单工作合计', 'workerMs', duration],
  ['集成排队', 'queueMs', duration],
  ['验收', 'verifyMs', duration],
  ['验收命令次数', 'checkRuns', count],
  ['验收失败次数', 'checkFailures', count],
  ['冲突次数', 'conflicts', count],
  ['尝试次数', 'attempts', count],
]
const METRICS = ['accumulatedMs', ...COLUMNS.map(([, key]) => key)]

function fail(message) {
  console.error('report: ' + message)
  console.error(USAGE)
  process.exit(1)
}

function parseArgs(argv) {
  const json = argv.includes('--json')
  const trials = []
  const seen = new Set()
  for (const arg of argv.filter((a) => a !== '--json')) {
    if (arg.startsWith('--')) fail('unknown option ' + arg)
    const at = arg.indexOf('=')
    if (at < 1 || at === arg.length - 1) fail('expected label=trial-directory, got ' + arg)
    const dir = resolve(arg.slice(at + 1))
    // 同一个 trial 算两次会悄悄改变中位数。
    if (seen.has(dir)) fail('trial directory given twice: ' + dir)
    seen.add(dir)
    trials.push({ label: arg.slice(0, at), dir })
  }
  if (!trials.length) fail('no trials given')
  return { json, trials }
}

function ledgerFiles(dir) {
  const root = join(dir, '.git', 'dsh-ticket-dag', 'runs')
  if (!existsSync(root)) return []
  return readdirSync(root)
    .sort()
    .map((name) => join(root, name, 'state.sqlite'))
    .filter((file) => existsSync(file))
}

function readRun(file, now) {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON; BEGIN')
    const counts = Object.fromEntries(
      db
        .prepare('SELECT status,count(*) AS n FROM tickets GROUP BY status')
        .all()
        .map((row) => [row.status, row.n]),
    )
    const events = db
      .prepare('SELECT type,ticketId,attempt,createdAt,details FROM events ORDER BY rowid')
      .all()
      .map((row) => ({ ...row, details: JSON.parse(row.details) }))
    const timing = runTiming(events, now)
    return { file, counts, timing, problem: runProblem(counts, events, timing) }
  } finally {
    db.close()
  }
}

// 全部 INTEGRATED 还不够：暂停或取消后才收尾的运行，时钟停在收尾之前，用时偏小。
function runProblem(counts, events, timing) {
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0)
  const integrated = counts.INTEGRATED ?? 0
  if (!total || integrated !== total) {
    const rest = Object.entries(counts)
      .filter(([status]) => status !== 'INTEGRATED')
      .map(([status, n]) => status + ' ' + n)
      .join('，')
    return `运行未全部 INTEGRATED：${integrated}/${total}` + (rest ? `（${rest}）` : '')
  }
  const completed = events.findLast((e) => e.type === 'run_completed')
  if (!completed || timing?.endedAt !== completed.createdAt) return '工单已全部 INTEGRATED，但计时没有停在运行完成的时刻'
  return null
}

function metricsOf({ accumulatedMs, attentionMs, totals }) {
  // runTiming 在分不清排队和验收时把两者记为 null，这时命令次数的 0 也只是“没有记录”。
  const recorded = totals.verifyMs !== null
  return {
    accumulatedMs,
    netMs: accumulatedMs - attentionMs,
    workerMs: totals.workerMs,
    queueMs: totals.queueMs,
    verifyMs: totals.verifyMs,
    checkRuns: recorded ? totals.checkRuns : null,
    checkFailures: recorded ? totals.checkFailures : null,
    conflicts: totals.conflicts,
    attempts: totals.attempts,
  }
}

function readTrial({ label, dir }, now) {
  const trial = { label, dir, runs: [], reasons: [], metrics: null }
  try {
    for (const file of ledgerFiles(dir)) trial.runs.push(readRun(file, now))
  } catch (err) {
    trial.reasons.push('账本读取失败：' + err.message)
    return trial
  }
  if (!trial.runs.length) trial.reasons.push('没有找到运行账本')
  if (trial.runs.length > 1) trial.reasons.push(`有 ${trial.runs.length} 轮运行，一个 trial 只应有一轮`)
  for (const run of trial.runs) if (run.problem) trial.reasons.push(run.problem)
  if (!trial.reasons.length) trial.metrics = metricsOf(trial.runs[0].timing)
  return trial
}

function stats(values) {
  // 有一轮缺数据时不用其余轮代替：那样比较的就不是同一组运行了。
  if (!values.length || values.some((v) => v === null)) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return {
    median: sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2,
    min: sorted[0],
    max: sorted.at(-1),
  }
}

function summarize(trials) {
  const groups = new Map()
  for (const trial of trials) {
    if (!groups.has(trial.label)) groups.set(trial.label, [])
    groups.get(trial.label).push(trial)
  }
  return [...groups].map(([label, members]) => {
    const rounds = members.filter((t) => t.metrics).map((t) => t.metrics)
    const summary = Object.fromEntries(METRICS.map((key) => [key, stats(rounds.map((m) => m[key]))]))
    return { label, rounds: rounds.length, summary, trials: members }
  })
}

function duration(ms) {
  if (ms < 1000) return Math.round(ms) + 'ms'
  if (ms < 60000) return (ms / 1000).toFixed(1) + 's'
  const total = Math.round(ms / 1000)
  const pad = (n) => String(n).padStart(2, '0')
  const hours = Math.floor(total / 3600)
  const rest = pad(Math.floor((total % 3600) / 60)) + 'm' + pad(total % 60) + 's'
  return hours ? hours + 'h' + rest : rest.replace(/^0/, '')
}

function count(n) {
  return String(n)
}

function markdown(groups) {
  const row = (cells) => '| ' + cells.map((c) => String(c).replaceAll('|', '\\|')).join(' | ') + ' |'
  const headers = ['label', '轮数', '累计用时（中位数，最小–最大）', ...COLUMNS.map(([title]) => title)]
  const lines = [row(headers), row(headers.map(() => '---'))]
  for (const { label, rounds, summary } of groups) {
    const total = summary.accumulatedMs
    lines.push(
      row([
        label,
        rounds,
        total ? `${duration(total.median)}（${duration(total.min)}–${duration(total.max)}）` : MISSING,
        ...COLUMNS.map(([, key, format]) => (summary[key] ? format(summary[key].median) : MISSING)),
      ]),
    )
  }
  lines.push('', `除累计用时的最小最大外，各列都是各轮的中位数。${MISSING} 表示账本里没有这项数据，不是 0。`)
  const excluded = groups.flatMap((g) => g.trials).filter((t) => !t.metrics)
  if (excluded.length) {
    lines.push('', '## 未计入汇总', '')
    for (const t of excluded) lines.push(`- ${t.label}：${t.dir}：${t.reasons.join('；')}`)
  }
  return lines.join('\n')
}

const { json, trials } = parseArgs(process.argv.slice(2))
const now = Date.now()
const groups = summarize(trials.map((t) => readTrial(t, now)))
console.log(json ? JSON.stringify({ generatedAt: now, groups }, null, 2) : markdown(groups))
