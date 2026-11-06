# 16: 信标占领与任务目标

**Status:** ready-for-agent

**Blocked by:** 05, 12

Parent spec: `.scratch/tank-arena/spec.md`（先读其中的原创性要求、技术约束、系统接口和 soak 接入约定）。

## What to build

实现信号信标：玩家方单位在半径内且无敌方时占领进度上升，敌方在场时争夺；关卡目标由若干目标项组成（占领 N 个信标、守住信标 T 帧、击毁首领、在限定帧数内撤离到撤离点）。这是本游戏的胜负核心，不存在“保护基地”目标。

## Interface

```js
// src/systems/objectives.js
export const objectiveSystem = { name: 'objective', init, step, save, load }
// 组件 beacon: { owner, progress, radius }
// 目标项: { kind: 'capture' | 'hold' | 'destroy-boss' | 'extract', target, done }
// services.objective: { status() -> 'running' | 'won' | 'lost', list() }
```

## Files

- `src/systems/objectives.js`
- `src/levels/proving-ground.js`
- `src/main.js`
- `src/world.js`
- `src/events.js`
- `src/data/balance.js`
- `checks/unit/objectives-checks.mjs`

## Shared registrations

只追加本工单的条目，不重排、不删除其他工单的条目（工单 24 除外）。

- `src/main.js`：`objectiveSystem` 放在 `SYSTEMS` 末尾；导演的波次在信标被占领后加快（调用 `services.director`）。
- `src/world.js`：注册组件 `beacon`（`solid: false`）。
- `src/events.js`：注册 `beacon:progress`、`beacon:captured`（id, owner）、`objective:completed`（index, kind）、`match:ended`（result, tick）。
- `src/data/balance.js`：新增 `objective` 节：`captureRate`、`contestDecay`、`beaconRadius`、`holdTicks`、`extractRadius`。
- 试炼场放置两个信标，目标为循环占领，不会结束对局。

## Acceptance criteria

- [ ] 双方同时在场时进度不变或衰减，不会同时被双方占领
- [ ] 信标进度在 0..1 内，存档恢复后不变
- [ ] match:ended 每局只发出一次
- [ ] 玩家坦克被摧毁时状态变为 lost
- [ ] 新增 `checks/unit/objective-checks.mjs`，覆盖本工单的接口与边界情况，`node --test checks/unit/` 通过
- [ ] `node checks/soak.mjs`（默认 60 秒）通过，且本工单的系统状态经 save/load 往返后哈希不变
- [ ] 同种子、同输入两次运行状态哈希相同；逻辑代码不使用 Math.random、Date.now 或 performance.now
