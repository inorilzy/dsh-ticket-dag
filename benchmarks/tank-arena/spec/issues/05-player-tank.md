# 05: 玩家坦克：带惯性的移动、独立炮塔、碰撞

**Status:** ready-for-agent

**Blocked by:** 01, 02, 03, 04

Parent spec: `.scratch/tank-arena/spec.md`（先读其中的原创性要求、技术约束、系统接口和 soak 接入约定）。

## What to build

把 01–04 接成可玩的骨架，并实现玩家坦克“犁锋号”（Ploughshare）。车体有加速度、摩擦和转向速度，炮塔独立朝向瞄准方向；与地形做圆—格子碰撞并沿墙滑动，地形减速生效。

## Interface

```js
// src/systems/tank.js
export const tankSystem = { name: 'tank', init, step, save, load, resources }
// 组件 tank: { hullAngle, turretAngle, vx, vy, throttle, team }；组件 health: { hp, maxHp }
// services.tank: { playerId(), moveCircle(id, dx, dy) /* 共享的圆形碰撞移动，其他系统复用 */ }
```

## Files

- `src/systems/tank.js`
- `src/levels/proving-ground.js`
- `src/main.js`
- `src/world.js`
- `src/events.js`
- `src/data/balance.js`
- `checks/unit/tank-checks.mjs`

## Shared registrations

只追加本工单的条目，不重排、不删除其他工单的条目（工单 24 除外）。

- `src/main.js`：`createGame` 创建 `game.world`、`game.events`、`game.terrain`（来自 `src/levels/proving-ground.js` 的 40×30 训练场）和 `game.balance`；`save()` 增加 `world`、`terrain`、`events`；`loadGame` 恢复它们；`inspect()` 填好 `entities`（含 hp/maxHp）、`terrain`、`resources`（汇总各系统 `resources(game)`）、`emittedEvents`、`balanceReads`。把 `tankSystem` 放进 `SYSTEMS` 第一位。
- `src/world.js`：注册组件 `tank`、`health`。
- `src/events.js`：注册 `tank:moved`（id, x, y）、`tank:collided`（id, cx, cy）。
- `src/data/balance.js`：新增 `tank` 节：`maxSpeed`、`accel`、`friction`、`hullTurnRate`、`turretTurnRate`、`radius`、`maxHp`。

## Acceptance criteria

- [ ] 松开输入后坦克按 friction 减速而不是立即停止
- [ ] 炮塔转向速度受 turretTurnRate 限制，与车体朝向无关
- [ ] 以任意速度撞墙都不会嵌入不可穿越格子，沿墙方向的速度保留
- [ ] soak 的 inspect 不变量（血量、嵌墙）在 game 模式下开始生效
- [ ] 新增 `checks/unit/tank-checks.mjs`，覆盖本工单的接口与边界情况，`node --test checks/unit/` 通过
- [ ] `node checks/soak.mjs`（默认 60 秒）通过，且本工单的系统状态经 save/load 往返后哈希不变
- [ ] 同种子、同输入两次运行状态哈希相同；逻辑代码不使用 Math.random、Date.now 或 performance.now
