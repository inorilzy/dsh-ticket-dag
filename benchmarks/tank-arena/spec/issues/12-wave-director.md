# 12: 波次导演与动态难度

**Status:** ready-for-agent

**Blocked by:** 10

Parent spec: `.scratch/tank-arena/spec.md`（先读其中的原创性要求、技术约束、系统接口和 soak 接入约定）。

## What to build

实现波次导演：读取关卡的波次表生成敌人；根据玩家近期表现（受伤速度、击杀速度）在限定范围内调整强度系数，只影响下一波的数量和间隔，不影响当前波。

## Interface

```js
// src/systems/director.js
export const directorSystem = { name: 'director', init, step, save, load }
// 私有状态：{ wave, timer, intensity, history: [...] }
export function nextIntensity(intensity, stats, limits) // 纯函数
// services.director: { currentWave(), intensity(), forceWave(n) }
```

## Files

- `src/systems/director.js`
- `src/main.js`
- `src/events.js`
- `src/data/balance.js`
- `checks/unit/director-checks.mjs`

## Shared registrations

只追加本工单的条目，不重排、不删除其他工单的条目（工单 24 除外）。

- `src/main.js`：`directorSystem` 插在 `ai` 之前；生成敌人时优先调用 `services.roster.spawnEnemy`（若已注册），否则直接生成基础敌人。
- `src/events.js`：注册 `wave:started`（wave, count, intensity）、`wave:cleared`（wave, ticks）。
- `src/data/balance.js`：新增 `director` 节：`baseCount`、`countPerWave`、`interval`、`intensityMin`、`intensityMax`、`intensityStep`、`historyWindow`。

## Acceptance criteria

- [ ] nextIntensity 永远落在 [intensityMin, intensityMax]
- [ ] 存档恢复后下一波的时间点和数量与不存档时相同
- [ ] 同一波内调整难度不改变已排队的生成
- [ ] 试炼场中 900 帧内至少开始两波
- [ ] 新增 `checks/unit/director-checks.mjs`，覆盖本工单的接口与边界情况，`node --test checks/unit/` 通过
- [ ] `node checks/soak.mjs`（默认 60 秒）通过，且本工单的系统状态经 save/load 往返后哈希不变
- [ ] 同种子、同输入两次运行状态哈希相同；逻辑代码不使用 Math.random、Date.now 或 performance.now
