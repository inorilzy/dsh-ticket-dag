# 14: 道具与主动技能

**Status:** ready-for-agent

**Blocked by:** 07

Parent spec: `.scratch/tank-arena/spec.md`（先读其中的原创性要求、技术约束、系统接口和 soak 接入约定）。

## What to build

实现道具（修理包、弹药箱、相位电池）与玩家主动技能：输入 ability 为真时释放当前技能。技能：“盐雾屏障”（短时减伤）和“回涌冲刺”（瞬间位移，不得穿墙）。技能能量是资源，必须出现在 inspect().resources。

## Interface

```js
// src/systems/pickups.js
export const pickupSystem = { name: 'pickup', init, step, save, load, resources }
// 组件 pickup: { kind, amount }；组件 ability: { slot, cooldown, energy, maxEnergy, activeUntil }
// services.pickup: { drop(kind, x, y) -> id, grant(entityId, kind) }
```

## Files

- `src/systems/pickups.js`
- `src/main.js`
- `src/world.js`
- `src/events.js`
- `src/data/balance.js`
- `checks/unit/pickups-checks.mjs`

## Shared registrations

只追加本工单的条目，不重排、不删除其他工单的条目（工单 24 除外）。

- `src/main.js`：`pickupSystem` 插在 `damage` 之后；`entity:destroyed` 时按掉落表用 `game.rng.fork('loot')` 掉落。
- `src/world.js`：注册组件 `pickup`（`solid: false`）、`ability`。
- `src/events.js`：注册 `pickup:spawned`、`pickup:collected`（id, kind, by）、`ability:used`（id, kind）、`ability:ended`（id, kind）。
- `src/data/balance.js`：新增 `pickup` 节：`repairAmount`、`ammoAmount`、`energyAmount`、`dropChance`、`shieldReduction`、`shieldDuration`、`dashDistance`、`abilityCost`、`maxEnergy`。
- 修改工单 07：屏障生效期间伤害乘以 `pickup.shieldReduction`。

## Acceptance criteria

- [ ] 修理包回血不超过 maxHp，能量不超过 maxEnergy
- [ ] 回涌冲刺遇墙时停在墙前，不嵌入地形
- [ ] 技能持续时间和冷却在存档恢复后不变
- [ ] 掉落只使用 loot 子随机流，不影响其他系统的随机序列
- [ ] 新增 `checks/unit/pickup-checks.mjs`，覆盖本工单的接口与边界情况，`node --test checks/unit/` 通过
- [ ] `node checks/soak.mjs`（默认 60 秒）通过，且本工单的系统状态经 save/load 往返后哈希不变
- [ ] 同种子、同输入两次运行状态哈希相同；逻辑代码不使用 Math.random、Date.now 或 performance.now
