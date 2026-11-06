// 慢检查：node checks/soak.mjs
//
// 用不同种子循环跑无头对局，找出“各自合并干净、合在一起出错”的问题：
//   (a) 同种子两次运行，每个检查点的 hash() 相同；
//   (b) 对局中途 save() → JSON → loadGame() 后接着跑，hash 与不存档的一致，
//       所以任何新系统忘了接入存档都会在这里失败；
//   (c) 跨系统不变量：血量和资源不越界、实体不嵌入不可穿越地形、
//       没有未在 EVENT_TYPES 注册的事件、平衡表没有缺失或未使用的键。
// 还不存在的系统对应的检查跳过；全无游戏代码时用确定性计算占满时长。
//
// 时长是实验有意设定的固定成本：默认 BENCH_SOAK_SECONDS=60，时间没用完就换种子
// 继续开新对局，所以每次验收的耗时与已合入多少系统无关，便于比较各集成模式。
// 不要为了提速缩短默认时长。
import { performance } from 'node:perf_hooks'
import {
  burn,
  checkInvariants,
  inputFor,
  INVARIANT_EVERY,
  loadOptional,
  MATCH_TICKS,
  soakSeconds,
  unusedBalanceKeys,
} from './harness.mjs'

const CHECKPOINT_EVERY = 60
const MAX_REPORTED = 20

const seconds = soakSeconds()
const started = performance.now()
const deadline = started + seconds * 1000
const problems = []
const skipped = new Set()
const report = (message) => {
  if (!problems.includes(message)) problems.push(message)
}

const main = await loadOptional(new URL('../src/main.js', import.meta.url))
const events = await loadOptional(new URL('../src/events.js', import.meta.url))
const balance = await loadOptional(new URL('../src/data/balance.js', import.meta.url))

const eventTypes =
  events?.EVENT_TYPES && typeof events.EVENT_TYPES === 'object' ? new Set(Object.keys(events.EVENT_TYPES)) : null
if (!eventTypes) skipped.add('events: src/events.js has no EVENT_TYPES')

function flatten(node, prefix = '', out = []) {
  for (const [key, value] of Object.entries(node)) {
    const path = prefix ? prefix + '.' + key : key
    if (value && typeof value === 'object' && !Array.isArray(value)) flatten(value, path, out)
    else out.push(path)
  }
  return out
}
const balanceKeys =
  balance?.BALANCE && typeof balance.BALANCE === 'object' ? new Set(flatten(balance.BALANCE)) : null
if (!balanceKeys) skipped.add('balance: src/data/balance.js has no BALANCE')
if (balanceKeys && typeof balance.validateBalance === 'function') {
  for (const p of balance.validateBalance(balance.BALANCE)) report('validateBalance: ' + p)
} else if (balanceKeys) skipped.add('balance validation: src/data/balance.js has no validateBalance')

const hashOf = (game, where) => {
  const value = game.hash()
  if (typeof value !== 'string' || !value) throw new Error(where + ': hash() must return a non-empty string')
  return value
}

// 跑一局；onTick 在每帧之后调用，返回 false 表示提前结束（例如超时）。
function play(game, seed, from, until, onTick) {
  for (let tick = from; tick < until; tick++) {
    game.step(inputFor(seed, tick))
    if (onTick(tick + 1) === false) return tick + 1
  }
  return until
}

async function match(seed) {
  const where = 'seed ' + seed
  const a = await main.createGame({ seed })
  if (typeof a?.step !== 'function' || typeof a.hash !== 'function') {
    report('createGame() must return an object with step(input) and hash()')
    return { complete: false }
  }
  const canInspect = typeof a.inspect === 'function'
  if (!canInspect) skipped.add('invariants: game has no inspect()')
  const canSave = typeof a.save === 'function' && typeof main.loadGame === 'function'
  if (!canSave) skipped.add('save/restore: no game.save() and loadGame() yet')

  const midTick = 300 + (seed % 300)
  const hashes = new Map([[0, hashOf(a, where)]])
  let snapshot = null
  const reads = new Set()
  const inspect = (tick) => {
    const view = a.inspect()
    for (const p of checkInvariants(view, eventTypes)) report(where + ' tick ' + tick + ': ' + p)
    for (const key of view?.balanceReads ?? []) reads.add(key)
  }
  const endA = play(a, seed, 0, MATCH_TICKS, (tick) => {
    if (tick % CHECKPOINT_EVERY === 0 || tick === midTick) hashes.set(tick, hashOf(a, where))
    if (canInspect && tick % INVARIANT_EVERY === 0) inspect(tick)
    if (canSave && tick === midTick) snapshot = JSON.stringify(a.save())
    // 只有第一局必须跑完，保证至少有一次完整比较；之后到点就停。
    return seed === 1 || performance.now() < deadline
  })
  if (canInspect) inspect(endA)
  hashes.set(endA, hashOf(a, where))
  if (endA < MATCH_TICKS) return { complete: false }

  // (a) 同种子再跑一次，逐检查点比较。
  const b = await main.createGame({ seed })
  const first = [0, hashOf(b, where)]
  if (first[1] !== hashes.get(0)) report(where + ': state differs right after createGame (hash ' + first[1] + ' vs ' + hashes.get(0) + ')')
  let diverged = false
  play(b, seed, 0, MATCH_TICKS, (tick) => {
    if (!diverged && hashes.has(tick) && hashOf(b, where) !== hashes.get(tick)) {
      diverged = true
      report(where + ': same seed diverged by tick ' + tick + ' (nondeterminism)')
    }
  })

  // (b) 中途存档恢复后接着跑，必须与不存档的一致。
  if (canSave && snapshot !== null) {
    const restored = await main.loadGame(JSON.parse(snapshot))
    if (hashOf(restored, where) !== hashes.get(midTick)) {
      report(where + ': loadGame(save()) at tick ' + midTick + ' does not reproduce the saved state; some system is missing from the save')
    } else {
      let off = false
      play(restored, seed, midTick, MATCH_TICKS, (tick) => {
        if (!off && hashes.has(tick) && hashOf(restored, where) !== hashes.get(tick)) {
          off = true
          report(where + ': after restoring the tick ' + midTick + ' save, state diverged by tick ' + tick + '; some system state is not saved')
        }
      })
    }
  }
  return { complete: true, reads, systems: Array.isArray(a.systems) ? a.systems : [] }
}

let mode
let matches = 0
let digest = 0
if (typeof main?.createGame !== 'function') {
  mode = 'burn'
  skipped.add('game: src/main.js has no createGame yet; burning the fixed duration')
  while (performance.now() < deadline) digest = burn(200_000, digest)
} else {
  mode = 'game'
  const reads = new Set()
  const systems = new Set()
  try {
    for (let seed = 1; seed === 1 || performance.now() < deadline; seed++) {
      const result = await match(seed)
      if (!result.complete) break
      matches++
      for (const key of result.reads) reads.add(key)
      for (const name of result.systems) systems.add(name)
      if (problems.length >= MAX_REPORTED) break
    }
  } catch (err) {
    report('game threw: ' + (err?.stack ?? err))
  }
  if (balanceKeys && matches > 0) {
    // game.balance 还没接入时谁都读不到键，这时判“未使用”只会误报先合入的系统。
    if (!reads.size) skipped.add('balance usage: inspect() reports no balanceReads')
    else {
      for (const key of [...reads].sort()) if (!balanceKeys.has(key)) report('balance key ' + key + ' is read but missing from BALANCE')
      for (const key of unusedBalanceKeys(balanceKeys, reads, systems))
        report('balance key ' + key + ' belongs to a registered system but was never read')
    }
  }
}

const summary = {
  mode,
  seconds,
  elapsedMs: Math.round(performance.now() - started),
  matches,
  ...(mode === 'burn' ? { digest } : {}),
  skipped: [...skipped],
  problems: problems.length,
}
console.log('soak ' + JSON.stringify(summary))
for (const p of problems.slice(0, MAX_REPORTED)) console.error('soak problem: ' + p)
process.exitCode = problems.length ? 1 : 0
