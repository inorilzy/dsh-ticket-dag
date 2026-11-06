# 10: 敌人 AI 状态机：巡逻、追击、掩护、撤退

**Status:** ready-for-agent

**Blocked by:** 05, 06, 09

Parent spec: `.scratch/tank-arena/spec.md`（先读其中的原创性要求、技术约束、系统接口和 soak 接入约定）。

## What to build

实现敌方坦克 AI，阵营名“灰潮联合体”（Greytide Syndicate）。状态：patrol、chase、cover（寻找 cover 格子躲避）、retreat（血量低时撤退）。转换条件写成表驱动，便于测试。

## Interface

```js
// src/systems/ai.js
export const aiSystem = { name: 'ai', init, step, save, load }
// 组件 brain: { state, target, waypoint, timer, memory }
export const TRANSITIONS = [{ from, to, when(ctx) }]
export function decide(brain, ctx) -> 下一个状态（纯函数）
// AI 的输出是与玩家同结构的 input，交给 services.tank 驱动，开火交给 services.projectile.fire
```

## Files

- `src/systems/ai.js`
- `src/levels/proving-ground.js`
- `src/main.js`
- `src/world.js`
- `src/events.js`
- `src/data/balance.js`
- `checks/unit/ai-checks.mjs`

## Shared registrations

只追加本工单的条目，不重排、不删除其他工单的条目（工单 24 除外）。

- `src/main.js`：`aiSystem` 插在 `tank` 之前，使 AI 的输入在同一帧生效。
- `src/world.js`：注册组件 `brain`。
- `src/events.js`：注册 `ai:state`（id, from, to）、`ai:spotted`（id, targetId）。
- `src/data/balance.js`：新增 `ai` 节：`sightRange`、`fireRange`、`retreatHp`、`coverSearchRadius`、`reactionTicks`、`patrolRadius`。
- 在试炼场放置 3 辆巡逻敌人，保证 soak 对局中出现交战。

## Acceptance criteria

- [ ] decide 对每条转换都有单元测试
- [ ] AI 的随机行为只使用 game.rng.fork('ai')，存档恢复后行为一致
- [ ] brain.memory 只含 JSON 值，save/load 往返无损
- [ ] 敌人不会卡在墙角超过 repathInterval 帧仍不重新寻路
- [ ] 新增 `checks/unit/ai-checks.mjs`，覆盖本工单的接口与边界情况，`node --test checks/unit/` 通过
- [ ] `node checks/soak.mjs`（默认 60 秒）通过，且本工单的系统状态经 save/load 往返后哈希不变
- [ ] 同种子、同输入两次运行状态哈希相同；逻辑代码不使用 Math.random、Date.now 或 performance.now
