import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { normalizeManifest } from '../src/store.mjs'
import { importTickets } from '../src/tracker.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))
const newTrial = join(here, 'new-trial.mjs')
const kit = join(here, 'tank-arena')

// 工单表：编号 -> 依赖，与 benchmarks/tank-arena/spec/spec.md 的依赖表一致。
const EXPECTED = {
  '01': [], '02': [], '03': [], '04': [],
  '05': ['01', '02', '03', '04'], '06': ['02', '03', '04'], '07': ['05', '06'], '08': ['03', '06'],
  '09': ['03'], '10': ['05', '06', '09'], '11': ['07', '10'], '12': ['10'], '13': ['07', '10'],
  '14': ['07'], '15': ['04', '14'], '16': ['05', '12'], '17': ['03', '05'], '18': ['01', '02', '15'],
  '19': ['05', '06', '08'], '20': ['17', '19'], '21': ['02', '06'], '22': ['05'], '23': ['03', '16', '19'],
  '24': ['11', '12', '13', '14', '15', '16', '18', '20', '21', '22', '23'],
}
const SHARED = ['src/world.js', 'src/main.js', 'src/data/balance.js', 'src/events.js']

async function tempDir(t, prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

function trial(target) {
  return spawnSync(process.execPath, [newTrial, target], { encoding: 'utf8' })
}

function head(dir) {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim()
}

// 每张工单所在的层（最长依赖链上的位置，从 1 开始）。
function levels(deps) {
  const memo = new Map()
  const level = (id) => {
    if (!memo.has(id)) memo.set(id, 1 + Math.max(0, ...deps[id].map(level)))
    return memo.get(id)
  }
  return Object.fromEntries(Object.keys(deps).map((id) => [id, level(id)]))
}

test('new-trial builds the same HEAD twice, imports cleanly and refuses non-empty targets', async (t) => {
  const root = await tempDir(t, 'tank-arena-trial-')
  const a = join(root, 'a')
  const b = join(root, 'b')
  const first = trial(a)
  assert.equal(first.status, 0, first.stderr)
  const second = trial(b)
  assert.equal(second.status, 0, second.stderr)
  assert.equal(head(a), head(b))
  assert.match(first.stdout, new RegExp('HEAD ' + head(a)))
  assert.equal(execFileSync('git', ['branch', '--show-current'], { cwd: a, encoding: 'utf8' }).trim(), 'main')
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: a, encoding: 'utf8' }), '')

  const again = trial(a)
  assert.notEqual(again.status, 0)
  assert.match(again.stderr, /not empty/)
  const occupied = join(root, 'occupied')
  await mkdir(occupied)
  await writeFile(join(occupied, 'keep.txt'), 'user data')
  assert.notEqual(trial(occupied).status, 0)
  assert.deepEqual(await readdir(occupied), ['keep.txt'])

  const out = await importTickets({ cwd: a, spec: '.scratch/tank-arena' })
  assert.equal(out.dependencyMode, 'declared')
  assert.deepEqual(out.warnings, [])
  assert.equal(out.manifest.tickets.length, 24)
  const imported = Object.fromEntries(out.manifest.tickets.map((x) => [x.id, x.depends_on]))
  assert.deepEqual(
    imported,
    Object.fromEntries(Object.entries(EXPECTED).map(([n, d]) => ['T' + n, d.map((x) => 'T' + x)])),
  )

  const manifest = JSON.parse(await readFile(join(a, 'manifest.json'), 'utf8'))
  assert.equal(manifest.spec_id, 'tank-arena')
  assert.equal(manifest.base_ref, 'main')
  assert.equal(manifest.max_workers, 6)
  assert.deepEqual(manifest.checks, { fast: [['node', '--test', 'checks/unit/']], soak: [['node', 'checks/soak.mjs']] })
  assert.deepEqual(manifest.tickets.map((x) => x.id), out.manifest.tickets.map((x) => x.id))
  for (const [i, ticket] of manifest.tickets.entries()) {
    const from = out.manifest.tickets[i]
    assert.deepEqual(ticket.depends_on, from.depends_on, ticket.id)
    assert.equal(ticket.title, from.title, ticket.id)
    assert.deepEqual(ticket.acceptance, from.acceptance, ticket.id)
    assert.deepEqual(ticket.verify, ['fast', 'soak'], ticket.id)
    assert.equal(ticket.agent, undefined, ticket.id)
    assert.equal(ticket.prompt, (await readFile(join(a, ticket.source.path), 'utf8')).trim(), ticket.id)
  }
  normalizeManifest(manifest)
})

test('the ticket graph is deep, wide and contends for the four shared files', async () => {
  const byLevel = levels(EXPECTED)
  assert.ok(Math.max(...Object.values(byLevel)) >= 6, 'longest chain has at least 6 levels')
  const widths = {}
  for (const level of Object.values(byLevel)) widths[level] = (widths[level] ?? 0) + 1
  assert.ok(Math.max(...Object.values(widths)) >= 6, 'some level holds at least 6 parallel tickets')

  const dir = join(kit, 'spec', 'issues')
  const bodies = await Promise.all((await readdir(dir)).sort().map((f) => readFile(join(dir, f), 'utf8')))
  assert.equal(bodies.length, 24)
  for (const file of SHARED) {
    const count = bodies.filter((body) => body.includes('`' + file + '`')).length
    assert.ok(count >= 8, file + ' is named by ' + count + ' issues')
  }
  for (const body of bodies) {
    assert.match(body, /^\*\*Blocked by:\*\* /m)
    assert.match(body, /checks\/unit\/[\w-]+-checks\.mjs/)
    assert.match(body, /soak/)
  }
  const spec = await readFile(join(kit, 'spec', 'spec.md'), 'utf8')
  assert.match(spec, /原创/)
  assert.match(spec, /不使用“保护基地/)
  assert.match(spec, /色块与几何图形/)
  assert.match(spec, /至少 3 个原创关卡/)
})

test('seed checks stay out of default node --test discovery and soak honours BENCH_SOAK_SECONDS', async () => {
  const seed = join(kit, 'seed')
  const listed = []
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        assert.notEqual(entry.name, 'test', path)
        await walk(path)
      } else listed.push(entry.name)
    }
  }
  await walk(seed)
  for (const name of listed) assert.doesNotMatch(name, /(^test[-.])|([.\-_]test\.[cm]?js$)|(^test\.[cm]?js$)/, name)

  // 实测：在 seed 根目录不带参数运行 node --test，一个测试也找不到。
  // 外层 node --test 设置的 NODE_TEST_CONTEXT 会让嵌套运行不输出报告，必须去掉。
  const { NODE_TEST_CONTEXT: _context, ...cleanEnv } = process.env
  const discovered = spawnSync(process.execPath, ['--test'], { cwd: seed, encoding: 'utf8', env: cleanEnv })
  assert.equal(discovered.status, 0, discovered.stdout + discovered.stderr)
  assert.match(discovered.stdout, /tests 0/)
  const fast = spawnSync(process.execPath, ['--test', 'checks/unit/'], { cwd: seed, encoding: 'utf8', env: cleanEnv })
  assert.equal(fast.status, 0, fast.stdout + fast.stderr)
  assert.match(fast.stdout, /pass [1-9]/)

  const started = performance.now()
  const soak = spawnSync(process.execPath, ['checks/soak.mjs'], {
    cwd: seed,
    encoding: 'utf8',
    env: { ...process.env, BENCH_SOAK_SECONDS: '1' },
  })
  const elapsed = performance.now() - started
  assert.equal(soak.status, 0, soak.stdout + soak.stderr)
  const summary = JSON.parse(/^soak (.*)$/m.exec(soak.stdout)[1])
  // 判定用 soak 自己量的时长；墙钟时间包含进程启动，上限放宽以容忍并行负载。
  assert.ok(summary.elapsedMs >= 1000 && summary.elapsedMs < 3000, 'soak measured ' + summary.elapsedMs + ' ms')
  assert.ok(elapsed >= 1000 && elapsed < 30000, 'soak took ' + Math.round(elapsed) + ' ms')
  assert.equal(summary.mode, 'burn')
  assert.equal(summary.problems, 0)
})

// 一个最小的假游戏，用来证明 soak 在 game 模式下真的会抓到问题。
// flaw: 'none' | 'unsaved' (有私有状态没进存档) | 'random' (非确定) | 'event' (未注册事件)
//       | 'missing-key' (读了不存在的数值) | 'unused-key' (已注册系统有键没人读)
const fakeMain = (flaw) => `
const flaw = ${JSON.stringify(flaw)}
let entropy = 0
class Game {
  constructor(seed) { this.seed = seed; this.tick = 0; this.x = 100; this.heat = 0; this.systems = ['tank'] }
  step(input) {
    this.tick++
    this.x = Math.min(300, Math.max(40, this.x + input.move.x))
    this.heat = (this.heat + (input.fire ? 3 : 1)) % 97
    if (flaw === 'random' && this.tick === 200) this.x += ++entropy
  }
  hash() { return JSON.stringify([this.seed, this.tick, this.x, this.heat]) }
  save() { return flaw === 'unsaved' ? { seed: this.seed, tick: this.tick, x: this.x } : { seed: this.seed, tick: this.tick, x: this.x, heat: this.heat } }
  inspect() {
    return {
      entities: [{ id: 1, kind: 'tank', x: this.x, y: 100, radius: 10, hp: 5, maxHp: 10 }],
      terrain: { isBlocked: (x) => x < 0 },
      resources: { ammo: { value: 3, max: 9 } },
      emittedEvents: flaw === 'event' ? ['tank:moved', 'ghost:boo'] : ['tank:moved'],
      balanceReads: flaw === 'missing-key' ? ['tank.speed', 'tank.turn', 'tank.ghost'] : flaw === 'unused-key' ? ['tank.speed'] : ['tank.speed', 'tank.turn'],
    }
  }
}
export function createGame({ seed }) { return new Game(seed) }
export function loadGame(s) { const g = new Game(s.seed); g.tick = s.tick; g.x = s.x; g.heat = s.heat ?? 0; return g }
`

test('soak in game mode passes a sound game and catches nondeterminism, unsaved state and unregistered events', async (t) => {
  const root = await tempDir(t, 'tank-arena-soak-')
  const run = async (flaw) => {
    const dir = join(root, flaw)
    await cp(join(kit, 'seed'), dir, { recursive: true })
    await writeFile(join(dir, 'src', 'main.js'), fakeMain(flaw))
    await writeFile(join(dir, 'src', 'events.js'), "export const EVENT_TYPES = { 'tank:moved': ['id'] }\n")
    await writeFile(
      join(dir, 'src', 'data', 'balance.js'),
      'export const BALANCE = { tank: { speed: 1, turn: 2 } }\nexport const validateBalance = () => []\n',
    )
    return spawnSync(process.execPath, ['checks/soak.mjs'], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, BENCH_SOAK_SECONDS: '0.3' },
    })
  }
  const sound = await run('none')
  assert.equal(sound.status, 0, sound.stdout + sound.stderr)
  const summary = JSON.parse(/^soak (.*)$/m.exec(sound.stdout)[1])
  assert.equal(summary.mode, 'game')
  assert.ok(summary.matches >= 1)
  assert.deepEqual(summary.skipped, [])

  const unsaved = await run('unsaved')
  assert.equal(unsaved.status, 1)
  assert.match(unsaved.stderr, /loadGame\(save\(\)\)|some system state is not saved/)
  const random = await run('random')
  assert.equal(random.status, 1)
  assert.match(random.stderr, /nondeterminism/)
  const event = await run('event')
  assert.equal(event.status, 1)
  assert.match(event.stderr, /ghost:boo/)
  const missing = await run('missing-key')
  assert.equal(missing.status, 1)
  assert.match(missing.stderr, /tank\.ghost is read but missing/)
  const unused = await run('unused-key')
  assert.equal(unused.status, 1)
  assert.match(unused.stderr, /tank\.turn belongs to a registered system/)
})
