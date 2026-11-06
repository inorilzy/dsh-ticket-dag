# 01: 固定步长循环、种子随机数、输入录制

**Status:** ready-for-agent

**Blocked by:** None (can start immediately)

Parent spec: `.scratch/tank-arena/spec.md`（先读其中的原创性要求、技术约束、系统接口和 soak 接入约定）。

## What to build

建立确定性内核：固定步长逻辑循环、可序列化的种子随机数、输入录制与重放，以及 src/main.js 的游戏对象骨架。之后所有系统都挂在这个骨架上。

## Interface

```js
// src/core/loop.js
export const DT = 1 / 60
export function createLoop({ step, maxSubSteps = 5 })   // advance(realSeconds) -> 执行的逻辑帧数；alpha 供渲染插值
// src/core/rng.js（PCG32 或 xorshift128+，状态为整数数组）
export function createRng(seed)   // { next() /* [0,1) */, int(lo, hi), pick(list), fork(label), state(), setState(s) }
// src/core/hash.js
export function hashState(value)  // 键排序后的稳定序列化 + FNV-1a，返回 16 位十六进制字符串
// src/core/recorder.js
export function createRecorder()  // { push(tick, input), frames(), toJSON() }；replay(game, frames)
// src/main.js
export async function createGame({ seed, level = 'proving-ground', options = {} })
export async function loadGame(snapshot)
```

## Files

- `src/core/loop.js`
- `src/core/rng.js`
- `src/core/hash.js`
- `src/core/recorder.js`
- `src/main.js`
- `checks/unit/core-checks.mjs`

## Shared registrations

只追加本工单的条目，不重排、不删除其他工单的条目（工单 24 除外）。

- `src/main.js`：实现 `createGame` / `loadGame`。游戏对象含 `seed`、`tick`、`rng`、`services`（空对象，供系统公开函数）、`systems`、`step(input)`、`hash()`、`save()`、`inspect()`；`step` 按 `SYSTEMS` 顺序调用每个系统的 `step(game, input, DT)` 后 `tick++`；`save()` 返回 `{ version: 1, seed, tick, rng, systems: { [name]: system.save(game) } }`；`hash()` 为 `hashState(save())`；`inspect()` 先返回 `{ entities: [], resources: {}, emittedEvents: [], balanceReads: [] }`。`SYSTEMS` 保持为空数组导出，供后续工单插入。

## Acceptance criteria

- [ ] createRng 同种子序列相同，setState(state()) 后序列可续接，fork 得到独立且确定的子流
- [ ] createLoop 在帧率抖动下逻辑帧数只由累计时间决定，单次最多 maxSubSteps 帧
- [ ] 录制 N 帧输入后在新对局重放，最终 hash() 与原对局一致
- [ ] createGame + step 后 soak 从 burn 模式切换为 game 模式并通过
- [ ] 新增 `checks/unit/core-checks.mjs`，覆盖本工单的接口与边界情况，`node --test checks/unit/` 通过
- [ ] `node checks/soak.mjs`（默认 60 秒）通过，且本工单的系统状态经 save/load 往返后哈希不变
- [ ] 同种子、同输入两次运行状态哈希相同；逻辑代码不使用 Math.random、Date.now 或 performance.now
