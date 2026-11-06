# 17: 战争迷雾与视野

**Status:** ready-for-agent

**Blocked by:** 03, 05

Parent spec: `.scratch/tank-arena/spec.md`（先读其中的原创性要求、技术约束、系统接口和 soak 接入约定）。

## What to build

实现格子级战争迷雾：三种状态 unseen、explored、visible；视野来自玩家与友军，被 cover 格子遮挡（使用 terrain.raycast）。AI 也只能看到自己阵营视野内的目标（与工单 10 的 sightRange 共同生效）。

## Interface

```js
// src/systems/fog.js
export const fogSystem = { name: 'fog', init, step, save, load }
export function computeVisibility(terrain, viewers, radius) -> Uint8Array // 纯函数
// services.fog: { isVisible(team, x, y), explored() -> 压缩成 base64 的位图 }
```

## Files

- `src/systems/fog.js`
- `src/main.js`
- `src/world.js`
- `src/data/balance.js`
- `checks/unit/fog-checks.mjs`

## Shared registrations

只追加本工单的条目，不重排、不删除其他工单的条目（工单 24 除外）。

- `src/main.js`：`fogSystem` 插在 `tank` 之后；每 `fog.updateInterval` 帧重算一次。
- `src/world.js`：注册组件 `vision`（radius, team）。
- `src/data/balance.js`：新增 `fog` 节：`playerRadius`、`squadRadius`、`enemyRadius`、`updateInterval`。
- 存档只保存 explored 位图（base64 字符串，不保存 Uint8Array）。

## Acceptance criteria

- [ ] 墙后的格子在视野半径内也保持不可见
- [ ] explored 一旦置位不再回退
- [ ] explored 在存档恢复后相同，visible 恢复后在下一次更新时一致
- [ ] 地形被摧毁后视野在下一次更新时扩大
- [ ] 新增 `checks/unit/fog-checks.mjs`，覆盖本工单的接口与边界情况，`node --test checks/unit/` 通过
- [ ] `node checks/soak.mjs`（默认 60 秒）通过，且本工单的系统状态经 save/load 往返后哈希不变
- [ ] 同种子、同输入两次运行状态哈希相同；逻辑代码不使用 Math.random、Date.now 或 performance.now
