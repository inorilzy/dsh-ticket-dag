import assert from 'node:assert/strict'
import { execFile, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { Coordinator } from '../src/coordinator.mjs'
import { RunStore } from '../src/store.mjs'

const report = fileURLToPath(new URL('report.mjs', import.meta.url))

const cli = (...args) => spawnSync(process.execPath, [report, ...args], { encoding: 'utf8' })

function reportJson(...args) {
  const out = cli('--json', ...args)
  assert.equal(out.status, 0, out.stderr)
  return JSON.parse(out.stdout).groups
}

function reportTable(...args) {
  const out = cli(...args)
  assert.equal(out.status, 0, out.stderr)
  return out.stdout
}

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'bench-report-'))
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 3 }))
  return dir
}

// 用 RunStore 建出真实表结构，再写入手写事件，这样时间戳和数值都是确定的。
async function ledger(dir, runId, events, statuses) {
  const runDir = join(dir, '.git', 'dsh-ticket-dag', 'runs', runId)
  await mkdir(runDir, { recursive: true })
  const file = join(runDir, 'state.sqlite')
  new RunStore(file).close()
  const db = new DatabaseSync(file)
  try {
    const ticket = db.prepare('INSERT INTO tickets(id,definition,position,status) VALUES (?,?,?,?)')
    Object.entries(statuses).forEach(([id, status], i) => ticket.run(id, '{}', i, status))
    const event = db.prepare('INSERT INTO events VALUES (?,?,?,NULL,?,?,?)')
    events.forEach(([createdAt, type, ticketId = null, details = {}], i) =>
      event.run('e' + i, type, ticketId, type, JSON.stringify(details), createdAt),
    )
  } finally {
    db.close()
  }
  return file
}

async function trial(root, name, events, statuses = { A: 'INTEGRATED', B: 'INTEGRATED', C: 'INTEGRATED' }) {
  const dir = join(root, name)
  await ledger(dir, 'r1', events, statuses)
  return dir
}

// 与 test/timing.test.mjs 的 gh1 序列相同：累计 830、等待处理 300、工单工作 540、
// 排队 200、验收 100、2 次命令、1 次冲突、5 次尝试。k 按比例放大所有时间。
function gh1(k = 1) {
  return [
    [0, 'run_started', null, { mode: 'staged' }],
    [100, 'run_approved'],
    [110, 'claimed', 'A'],
    [120, 'claimed', 'B'],
    [200, 'needs_attention', 'A'],
    [300, 'submitted', 'B'],
    [320, 'conflict_requeued', 'B'],
    [500, 'retry_requested', 'A'],
    [510, 'claimed', 'A'],
    [520, 'claimed', 'B'],
    [600, 'submitted', 'A'],
    [610, 'submitted', 'B'],
    [650, 'verify_started', 'A', { checks: ['unit'] }],
    [700, 'check_finished', 'A', { checkId: 'unit', ms: 50, ok: true }],
    [710, 'publishing', 'A'],
    [720, 'integrated', 'A'],
    [730, 'verify_started', 'B', { checks: ['unit'] }],
    [780, 'check_finished', 'B', { checkId: 'unit', ms: 50, ok: true }],
    [790, 'publishing', 'B'],
    [800, 'integrated', 'B'],
    [800, 'run_completed'],
    [1800, 'tickets_appended'],
    [1810, 'claimed', 'C'],
    [1900, 'submitted', 'C'],
    [1910, 'verify_started', 'C', { checks: [] }],
    [1920, 'publishing', 'C'],
    [1930, 'integrated', 'C'],
    [1930, 'run_completed'],
  ].map(([at, type, id, details]) => [
    at * k,
    type,
    id,
    details?.ms ? { ...details, ms: details.ms * k } : details,
  ])
}

// 写在账本出现验收事件之前：run_started 没有 mode，也没有 verify_started/check_finished。
const oldLedger = () =>
  gh1()
    .filter(([, type]) => type !== 'verify_started' && type !== 'check_finished')
    .map((row) => (row[1] === 'run_started' ? [0, 'run_started', null, { ref: 'r', baseSha: 'b' }] : row))

const dataRow = (table, label) => table.split('\n').find((line) => line.startsWith(`| ${label} |`))

test('one round reports the runTiming numbers in the table and in --json', async (t) => {
  const root = await tempDir(t)
  const dir = await trial(root, 'a', gh1())
  assert.equal(
    dataRow(reportTable('each=' + dir), 'each'),
    '| each | each | 1 | 830ms（830ms–830ms） | 530ms | 540ms | 200ms | 100ms | 2 | 0 | 0 | 1 | 5 |',
  )
  const [group] = reportJson('each=' + dir)
  assert.equal(group.label, 'each')
  assert.equal(group.rounds, 1)
  assert.deepEqual(group.trials[0].metrics, {
    accumulatedMs: 830,
    netMs: 530,
    workerMs: 540,
    queueMs: 200,
    verifyMs: 100,
    checkRuns: 2,
    checkFailures: 0,
    skippedChecks: 0,
    conflicts: 1,
    attempts: 5,
  })
  assert.equal(group.trials[0].runs[0].timing.attentionMs, 300)
  assert.equal(group.mode, 'each', 'a ledger without frozen integration settings ran each')
})

test('repeated labels give medians with min and max, per label in argument order', async (t) => {
  const root = await tempDir(t)
  const args = [
    'each=' + (await trial(root, 'e10', gh1(10))),
    'other=' + (await trial(root, 'o1', gh1(1))),
    'each=' + (await trial(root, 'e1', gh1(1))),
    'other=' + (await trial(root, 'o3', gh1(3))),
    'each=' + (await trial(root, 'e2', gh1(2))),
  ]
  const groups = reportJson(...args)
  assert.deepEqual(groups.map((g) => [g.label, g.rounds]), [['each', 3], ['other', 2]])
  assert.deepEqual(groups[0].summary.accumulatedMs, { median: 1660, min: 830, max: 8300 })
  assert.deepEqual(groups[0].summary.verifyMs, { median: 200, min: 100, max: 1000 })
  // 偶数轮取中间两轮的平均。
  assert.deepEqual(groups[1].summary.accumulatedMs, { median: 1660, min: 830, max: 2490 })
  assert.equal(
    dataRow(reportTable(...args), 'each'),
    '| each | each | 3 | 1.7s（830ms–8.3s） | 1.1s | 1.1s | 400ms | 200ms | 2 | 0 | 0 | 1 | 5 |',
  )
})

test('net time is the median of each round, not the difference of two medians', async (t) => {
  const root = await tempDir(t)
  const round = (name, total, attention) =>
    trial(
      root,
      name,
      [
        [0, 'run_started', null, { mode: 'active' }],
        [0, 'claimed', 'A'],
        [total - attention, 'needs_attention', 'A'],
        [total, 'integrated', 'A'],
        [total, 'run_completed'],
      ],
      { A: 'INTEGRATED' },
    )
  const [group] = reportJson(
    'x=' + (await round('a', 1000, 0)),
    'x=' + (await round('b', 2000, 1800)),
    'x=' + (await round('c', 3000, 2500)),
  )
  // 各轮净用时 1000、200、500；中位数之差会得出 2000 - 1800 = 200。
  assert.deepEqual(group.summary.netMs, { median: 500, min: 200, max: 1000 })
})

test('failed checks are counted; a check stopped by cancel is not a failure', async (t) => {
  const root = await tempDir(t)
  const dir = await trial(
    root,
    'a',
    [
      [0, 'run_started', null, { mode: 'active' }],
      [10, 'verify_started', 'A', { checks: ['x'] }],
      [20, 'check_finished', 'A', { checkId: 'x', ms: 10, ok: false }],
      [30, 'check_finished', 'A', { checkId: 'x', ms: 10, ok: false, aborted: true }],
      [40, 'check_finished', 'A', { checkId: 'x', ms: 10, ok: true }],
      [50, 'integrated', 'A'],
      [50, 'run_completed'],
    ],
    { A: 'INTEGRATED' },
  )
  const [group] = reportJson('x=' + dir)
  assert.equal(group.summary.checkRuns.median, 3)
  assert.equal(group.summary.checkFailures.median, 1)
})

test('unfinished and multi-run trials are named and left out of the summary', async (t) => {
  const root = await tempDir(t)
  const good = await trial(root, 'good', gh1())
  const unfinished = await trial(
    root,
    'unfinished',
    [
      [0, 'run_started', null, { mode: 'active' }],
      [10, 'claimed', 'A'],
      [100000, 'integrated', 'A'],
    ],
    { A: 'INTEGRATED', B: 'NEEDS_ATTENTION', C: 'PENDING' },
  )
  const twoRuns = await trial(root, 'two-runs', gh1(50))
  await ledger(twoRuns, 'r2', gh1(50), { A: 'INTEGRATED', B: 'INTEGRATED', C: 'INTEGRATED' })
  // 全部合入，但时钟在暂停时就停了：累计用时只有 100。
  const paused = await trial(
    root,
    'paused',
    [
      [0, 'run_started', null, { mode: 'active' }],
      [100, 'run_paused'],
      [9000, 'integrated', 'A'],
      [9000, 'run_completed'],
    ],
    { A: 'INTEGRATED' },
  )
  const empty = join(root, 'empty')
  await mkdir(empty)
  const args = [good, unfinished, twoRuns, paused, empty].map((dir) => 'each=' + dir)

  const [group] = reportJson(...args)
  assert.equal(group.rounds, 1)
  assert.deepEqual(group.summary.accumulatedMs, { median: 830, min: 830, max: 830 })
  assert.deepEqual(group.trials.map((x) => x.metrics !== null), [true, false, false, false, false])

  const table = reportTable(...args)
  assert.match(dataRow(table, 'each'), /^\| each \| each \| 1 \| 830ms/)
  const section = table.slice(table.indexOf('## 未计入汇总'))
  const line = (dir) => section.split('\n').find((l) => l.includes(dir))
  assert.equal(line(good), undefined)
  assert.match(line(unfinished), /运行未全部 INTEGRATED：1\/3（NEEDS_ATTENTION 1，PENDING 1）/)
  assert.match(line(twoRuns), /有 2 轮运行/)
  assert.match(line(paused), /计时没有停在运行完成的时刻/)
  assert.match(line(empty), /没有找到运行账本/)
})

test('a label with no usable round still shows, with dashes instead of zeros', async (t) => {
  const root = await tempDir(t)
  const missing = join(root, 'never-created')
  assert.equal(dataRow(reportTable('x=' + missing), 'x'), '| x | — | 0 | — | — | — | — | — | — | — | — | — | — |')
})

test('an unreadable ledger is reported instead of ending the report', async (t) => {
  const root = await tempDir(t)
  const good = await trial(root, 'good', gh1())
  const broken = join(root, 'broken')
  const file = join(broken, '.git', 'dsh-ticket-dag', 'runs', 'r1', 'state.sqlite')
  await mkdir(join(file, '..'), { recursive: true })
  await writeFile(file, 'not a database, long enough that sqlite actually looks at the header')
  const table = reportTable('x=' + good, 'x=' + broken)
  assert.match(dataRow(table, 'x'), /^\| x \| each \| 1 \|/)
  assert.match(table, /账本读取失败/)
})

test('an old ledger shows dashes for what it never recorded, a recorded zero stays 0', async (t) => {
  const root = await tempDir(t)
  const old = await trial(root, 'old', oldLedger())
  assert.equal(
    dataRow(reportTable('old=' + old), 'old'),
    '| old | each | 1 | 830ms（830ms–830ms） | 530ms | 540ms | — | — | — | — | 0 | 1 | 5 |',
  )
  const [group] = reportJson('old=' + old)
  assert.equal(group.summary.queueMs, null)
  assert.equal(group.summary.checkRuns, null)
  assert.equal(group.trials[0].metrics.checkFailures, null)

  // 一轮缺数据时不用其余轮的值代替。
  const fresh = await trial(root, 'fresh', gh1())
  assert.match(dataRow(reportTable('m=' + old, 'm=' + fresh), 'm'), /^\| m \| each \| 2 \| 830ms.* \| — \| — \| — \| — \| 0 \| 1 \| 5 \|$/)

  // 工单确实没有验收命令：记录下来的 0 不是缺数据。
  const noChecks = await trial(
    root,
    'no-checks',
    [
      [0, 'run_started', null, { mode: 'active' }],
      [10, 'claimed', 'A'],
      [20, 'submitted', 'A'],
      [30, 'verify_started', 'A', { checks: [] }],
      [40, 'integrated', 'A'],
      [40, 'run_completed'],
    ],
    { A: 'INTEGRATED' },
  )
  assert.equal(
    dataRow(reportTable('z=' + noChecks), 'z'),
    '| z | each | 1 | 40ms（40ms–40ms） | 40ms | 10ms | 10ms | 0ms | 0 | 0 | 0 | 0 | 1 |',
  )
})

test('the ledger is not changed by reading it', async (t) => {
  const root = await tempDir(t)
  const dir = await trial(root, 'a', gh1())
  const file = join(dir, '.git', 'dsh-ticket-dag', 'runs', 'r1', 'state.sqlite')
  const digest = async () => createHash('sha256').update(await readFile(file)).digest('hex')
  const before = await digest()
  reportTable('x=' + dir)
  assert.equal(await digest(), before)
})

test('long durations read as minutes and hours', async (t) => {
  const root = await tempDir(t)
  const round = (name, ms) =>
    trial(
      root,
      name,
      [
        [0, 'run_started', null, { mode: 'active' }],
        [ms, 'integrated', 'A'],
        [ms, 'run_completed'],
      ],
      { A: 'INTEGRATED' },
    )
  const table = reportTable('m=' + (await round('m', 125000)), 'h=' + (await round('h', 3723000)))
  assert.match(dataRow(table, 'm'), /^\| m \| each \| 1 \| 2m05s（2m05s–2m05s） /)
  assert.match(dataRow(table, 'h'), /^\| h \| each \| 1 \| 1h02m03s（1h02m03s–1h02m03s） /)
})

test('bad arguments stop with usage instead of an empty report', async (t) => {
  const root = await tempDir(t)
  for (const args of [[], ['--json'], ['no-label'], ['=dir'], ['label='], ['--csv', 'a=b'], ['a=' + root, 'b=' + root]]) {
    const out = cli(...args)
    assert.equal(out.status, 1, args.join(' '))
    assert.match(out.stderr, /usage: /)
    assert.equal(out.stdout, '')
  }
})

// 在手写账本里补一行 run，清单带上冻结的 integration，模拟按文件选测试的一轮。
async function modeTrial(root, name, integration, skipped = []) {
  const events = [
    [0, 'run_started', null, { mode: 'active' }],
    [10, 'claimed', 'A'],
    [20, 'submitted', 'A'],
    [25, 'checks_selected', 'A', { stage: 'lane', run: ['fast'], skipped, fallback: null, changed: 1 }],
    [30, 'verify_started', 'A', { checks: ['fast'] }],
    [35, 'check_finished', 'A', { checkId: 'fast', ms: 5, ok: true }],
    [40, 'integrated', 'A'],
    [40, 'run_completed'],
  ]
  const dir = join(root, name)
  const file = await ledger(dir, 'r1', events, { A: 'INTEGRATED' })
  const db = new DatabaseSync(file)
  try {
    const manifest = { specId: 's', baseRef: 'main', maxWorkers: 1, tickets: [], ...(integration && { integration }) }
    db.prepare("INSERT INTO run VALUES (1,'r1','{}','ref','b',?,'p','h','b','active',NULL)").run(JSON.stringify(manifest))
  } finally {
    db.close()
  }
  return dir
}

test('the table names the mode each round actually ran and counts skipped checks', async (t) => {
  const root = await tempDir(t)
  const f = await modeTrial(root, 'f', { mode: 'each', selectChecksByFiles: true }, ['slow'])
  const each = await modeTrial(root, 'each', null)
  const table = reportTable('f=' + f, 'base=' + each)
  assert.equal(dataRow(table, 'f'), '| f | each+F | 1 | 40ms（40ms–40ms） | 40ms | 10ms | 10ms | 5ms | 1 | 0 | 1 | 0 | 1 |')
  assert.match(dataRow(table, 'base'), /^\| base \| each \| 1 \| .* \| 1 \| 0 \| 0 \| 0 \| 1 \|$/)
  assert.doesNotMatch(table, /## 警告/)
  const groups = reportJson('f=' + f)
  assert.equal(groups[0].mode, 'each+F')
  assert.deepEqual(groups[0].trials[0].runs[0].integration, { mode: 'each', selectChecksByFiles: true })
  assert.equal(groups[0].summary.skippedChecks.median, 1)
})

test('rounds of one label that ran different modes are flagged', async (t) => {
  const root = await tempDir(t)
  const f = await modeTrial(root, 'f', { mode: 'each', selectChecksByFiles: true }, ['slow'])
  const each = await modeTrial(root, 'each', null)
  const table = reportTable('x=' + f, 'x=' + each)
  assert.match(dataRow(table, 'x'), /^\| x \| each\+F\/each \| 2 \|/)
  assert.match(table, /## 警告\n\n- label x 下各轮的实际模式不一致：each\+F、each/)
  assert.deepEqual(reportJson('x=' + f, 'x=' + each)[0].warnings.length, 1)
})

const exec = promisify(execFile)
const env = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
}
const git = async (cwd, ...args) => (await exec('git', args, { cwd, env })).stdout.trim()

test('a ledger written by a real run is found and reported', { timeout: 300000 }, async (t) => {
  const cwd = await tempDir(t)
  await git(cwd, 'init', '-q', '-b', 'main')
  await git(cwd, 'config', 'user.name', 'fixture')
  await git(cwd, 'config', 'user.email', 'fixture@example.invalid')
  await git(cwd, 'commit', '--allow-empty', '-qm', 'seed')
  const co = new Coordinator({
    maxWorkers: 2,
    checks: { verify: [[process.execPath, '-e', 'process.exit(0)']] },
    notify: async () => true,
    launch: async (job) => {
      await writeFile(join(job.cwd, job.ticketId + '.txt'), job.ticketId)
      await git(job.cwd, 'add', '--', job.ticketId + '.txt')
      const trailers = [
        'DAG-Run: ' + job.runId,
        'DAG-Ticket: ' + job.ticketId,
        'DAG-Attempt: ' + job.attempt,
        'DAG-Complete: yes',
      ].join('\n')
      await git(job.cwd, 'commit', '-qm', 'Deliver ' + job.ticketId, '-m', trailers)
      return { result: Promise.resolve({ ok: true }), dispose: async () => {} }
    },
  })
  const q = { cwd, parentId: 'captain', runId: 'real' }
  try {
    await co.start({
      ...q,
      manifest: { spec_id: 'real', tickets: [{ id: 'A', title: 'A', verify: ['verify'] }] },
    })
    const deadline = Date.now() + 240000
    while (!(await co.status(q)).complete) {
      assert.ok(Date.now() < deadline, 'run did not complete')
      await sleep(40)
    }
  } finally {
    await co.close()
  }
  const [group] = reportJson('real=' + cwd)
  assert.equal(group.rounds, 1, JSON.stringify(group.trials[0].reasons))
  assert.equal(group.summary.checkRuns.median, 1)
  assert.equal(group.summary.checkFailures.median, 0)
  assert.equal(group.summary.attempts.median, 1)
  assert.ok(group.summary.accumulatedMs.median > 0)
})
