// 慢检查 soak.mjs 与 checks/unit/ 共用的确定性工具，只用 Node 标准库。
// 这里定义的是游戏代码要遵守的无头接入约定，见 .scratch/tank-arena/spec.md 的“soak 接入约定”。
import { access } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

export const DEFAULT_SOAK_SECONDS = 60
// 每局 900 个固定步长帧，按 60 Hz 相当于 15 秒对局。
export const MATCH_TICKS = 900
export const INVARIANT_EVERY = 30

/** BENCH_SOAK_SECONDS 未设置时为 60；必须是正数。 */
export function soakSeconds(env = process.env) {
  const raw = env.BENCH_SOAK_SECONDS
  if (raw === undefined || raw === '') return DEFAULT_SOAK_SECONDS
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0)
    throw new RangeError('BENCH_SOAK_SECONDS must be a positive number of seconds, got ' + raw)
  return value
}

/** 32 位整数混合函数，结果与平台无关。 */
export function mix32(a, b) {
  let h = (Math.imul((a ^ 0x9e3779b9) >>> 0, 0x85ebca6b) ^ (b >>> 0)) >>> 0
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b) >>> 0
  return (h ^ (h >>> 16)) >>> 0
}

const ORDERS = ['follow', 'hold', 'attack', 'regroup']

/**
 * 第 tick 帧的玩家输入，只由 seed 和 tick 决定，不依赖之前的状态，
 * 所以存档恢复后可以接着喂同样的输入。数值都是 1/8 的整数倍，序列化后不丢精度。
 */
export function inputFor(seed, tick) {
  const chunk = Math.floor(tick / 45) // 方向保持 45 帧，让坦克走出连贯路线
  const held = (k) => mix32(mix32(seed, chunk), k)
  const now = (k) => mix32(mix32(seed, tick + 0x10000), k)
  const axis = (v) => ((v % 17) - 8) / 8
  const order = now(5) % 300 === 0 ? ORDERS[now(6) % ORDERS.length] : null
  return {
    move: { x: axis(held(1)), y: axis(held(2)) },
    aim: { x: axis(held(3)), y: axis(held(4)) },
    fire: now(7) % 4 === 0,
    ability: now(8) % 240 === 0,
    order,
  }
}

/** 没有游戏代码时占满时长的确定性计算；同样的 iterations 总得到同样的 digest。 */
export function burn(iterations, digest = 0x2545f491) {
  let h = digest >>> 0
  for (let i = 0; i < iterations; i++) h = mix32(h, i)
  return h
}

/** 文件存在就导入，不存在返回 null；文件存在但导入出错照样抛出。 */
export async function loadOptional(url) {
  try {
    await access(fileURLToPath(url))
  } catch {
    return null
  }
  return import(url)
}

const finite = (v) => typeof v === 'number' && Number.isFinite(v)

/**
 * 跨系统不变量。view 是 game.inspect() 的结果，eventTypes 是 src/events.js 的
 * EVENT_TYPES 键集合（没有时传 null 跳过事件检查）。返回问题列表，空表示通过。
 */
export function checkInvariants(view, eventTypes = null) {
  const problems = []
  if (view === null || typeof view !== 'object') return ['inspect() must return an object']
  const entities = view.entities ?? []
  if (!Array.isArray(entities)) return ['inspect().entities must be an array']
  const blocked = typeof view.terrain?.isBlocked === 'function' ? (x, y) => view.terrain.isBlocked(x, y) : null
  for (const e of entities) {
    const who = 'entity ' + e?.id + (e?.kind ? ' (' + e.kind + ')' : '')
    if (!finite(e?.x) || !finite(e?.y)) {
      problems.push(who + ' has a non-finite position')
      continue
    }
    if (e.hp !== undefined || e.maxHp !== undefined) {
      if (!finite(e.hp) || !finite(e.maxHp) || e.hp < 0 || e.hp > e.maxHp)
        problems.push(who + ' hp ' + e.hp + ' is outside 0..' + e.maxHp)
    }
    if (blocked && e.solid !== false && finite(e.radius) && e.radius > 0) {
      const r = e.radius * 0.5
      const probes = [[0, 0], [r, 0], [-r, 0], [0, r], [0, -r]]
      if (probes.some(([dx, dy]) => blocked(e.x + dx, e.y + dy)))
        problems.push(who + ' at ' + e.x + ',' + e.y + ' is embedded in impassable terrain')
    }
  }
  for (const [name, res] of Object.entries(view.resources ?? {})) {
    if (!finite(res?.value) || !finite(res?.max) || res.value < 0 || res.value > res.max)
      problems.push('resource ' + name + ' ' + res?.value + ' is outside 0..' + res?.max)
  }
  if (eventTypes && view.emittedEvents !== undefined) {
    for (const type of view.emittedEvents) {
      if (!eventTypes.has(type)) problems.push('event ' + type + ' was emitted but is not registered in EVENT_TYPES')
    }
  }
  return problems
}

/**
 * 平衡表里属于已注册系统、但整个 soak 都没读过的键。
 * 键的第一段是系统名；不属于任何已注册系统的段（包括 meta）跳过，等它的系统落地。
 */
export function unusedBalanceKeys(keys, readKeys, systemNames) {
  const read = new Set(readKeys)
  const systems = new Set(systemNames)
  return [...keys].filter((key) => systems.has(key.split('.')[0]) && !read.has(key)).sort()
}
