# 09: 路径寻找：A* 与流场，地形变化后增量更新

**Status:** ready-for-agent

**Blocked by:** 03

Parent spec: `.scratch/tank-arena/spec.md`（先读其中的原创性要求、技术约束、系统接口和 soak 接入约定）。

## What to build

实现路径寻找。单体用 A*（8 方向、禁止切角穿墙、slow 格子代价更高）；大量敌人共用指向目标的流场。地形变化时只重算受影响区域，不全图重建。

## Interface

```js
// src/pathfinding.js
export function findPath(terrain, from, to, { maxNodes, costOf }) -> [{cx, cy}] | null
export function createFlowField(terrain, { maxCost }) // { setGoal(cx, cy), directionAt(x, y) -> {x, y}, invalidate(changes), cost(cx, cy) }
// src/systems/navigation.js
export const navigationSystem = { name: 'navigation', init, step, save, load }
// services.navigation: { path(from, to), flowTo(goalKey) -> field }，流场按需构建并缓存
```

## Files

- `src/pathfinding.js`
- `src/systems/navigation.js`
- `src/main.js`
- `src/data/balance.js`
- `checks/unit/navigation-checks.mjs`

## Shared registrations

只追加本工单的条目，不重排、不删除其他工单的条目（工单 24 除外）。

- `src/main.js`：`navigationSystem` 插在 `damage` 之后（若已存在，否则在 `tank` 之后）；`init` 中订阅 `terrain.onChange` 调用 `invalidate`。
- `src/data/balance.js`：新增 `navigation` 节：`maxNodes`、`slowCost`、`diagonalCost`、`fieldMaxCost`、`repathInterval`。

## Acceptance criteria

- [ ] A* 结果与暴力 Dijkstra 的路径代价相同（多张随机地图测试）
- [ ] 一格墙被摧毁后流场增量更新的结果与全量重建一致
- [ ] 缓存的流场是派生数据：不进入存档，loadGame 后按需重建且结果相同
- [ ] 目标不可达时返回 null，不死循环
- [ ] 新增 `checks/unit/navigation-checks.mjs`，覆盖本工单的接口与边界情况，`node --test checks/unit/` 通过
- [ ] `node checks/soak.mjs`（默认 60 秒）通过，且本工单的系统状态经 save/load 往返后哈希不变
- [ ] 同种子、同输入两次运行状态哈希相同；逻辑代码不使用 Math.random、Date.now 或 performance.now
