# 06: 弹道：反弹、穿透、范围爆炸

**Status:** ready-for-agent

**Blocked by:** 02, 03, 04

Parent spec: `.scratch/tank-arena/spec.md`（先读其中的原创性要求、技术约束、系统接口和 soak 接入约定）。

## What to build

实现弹丸系统。三种弹种：钢芯弹（遇墙反弹 N 次）、穿甲矛（穿透 destructible 格子并衰减）、熔渣榴弹（落点或命中时范围爆炸）。弹丸用连续碰撞检测，不会在高速时穿过一格厚的墙。

## Interface

```js
// src/systems/projectile.js
export const projectileSystem = { name: 'projectile', init, step, save, load }
// 组件 projectile: { kind, ownerId, team, vx, vy, bounces, pierce, fuse }
// services.projectile: { fire(ownerId, kind, x, y, angle) -> id }
// 爆炸只发事件，不直接扣血（扣血在工单 07）
```

## Files

- `src/systems/projectile.js`
- `src/main.js`
- `src/world.js`
- `src/events.js`
- `src/data/balance.js`
- `checks/unit/projectile-checks.mjs`

## Shared registrations

只追加本工单的条目，不重排、不删除其他工单的条目（工单 24 除外）。

- `src/main.js`：`projectileSystem` 插在 `tank` 之后；输入 `fire` 为真且冷却结束时由本系统替玩家开火（读取 `services.tank` 若存在）。
- `src/world.js`：注册组件 `projectile`（`body.solid` 为 false）。
- `src/events.js`：注册 `projectile:fired`（id, ownerId, kind）、`projectile:bounced`（id, cx, cy）、`projectile:hit`（id, targetId, x, y, dirX, dirY, kind）、`projectile:exploded`（id, x, y, radius）。
- `src/data/balance.js`：新增 `projectile` 节，每个弹种一组 `speed`、`damage`、`bounces`、`pierce`、`radius`、`cooldown`、`lifetime`。

## Acceptance criteria

- [ ] 速度大于一格每帧时也不会穿过一格厚的 steel
- [ ] 反弹角度满足入射角等于反射角，用完次数后销毁
- [ ] projectile:hit 带上从弹丸指向目标的单位方向，供工单 07 计算受击方向
- [ ] 弹丸超出 lifetime 自动销毁，世界中不残留实体
- [ ] 新增 `checks/unit/projectile-checks.mjs`，覆盖本工单的接口与边界情况，`node --test checks/unit/` 通过
- [ ] `node checks/soak.mjs`（默认 60 秒）通过，且本工单的系统状态经 save/load 往返后哈希不变
- [ ] 同种子、同输入两次运行状态哈希相同；逻辑代码不使用 Math.random、Date.now 或 performance.now
