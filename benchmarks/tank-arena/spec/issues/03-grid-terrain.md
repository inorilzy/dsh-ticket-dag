# 03: 网格地形与属性：可摧毁、不可穿越、减速、遮蔽

**Status:** ready-for-agent

**Blocked by:** None (can start immediately)

Parent spec: `.scratch/tank-arena/spec.md`（先读其中的原创性要求、技术约束、系统接口和 soak 接入约定）。

## What to build

实现格子地形。每种地形是属性组合：blocking（不可穿越）、destructible（带耐久，可被摧毁成 rubble）、slow（移动速度系数）、cover（遮蔽视线与弹道）。地形变更必须可订阅，路径寻找和迷雾依赖它做增量更新。

## Interface

```js
// src/terrain.js
export const TILE = 32
export const TILE_TYPES = { floor, rubble, steel, crate, brine, reeds, barrel }  // 每项 { blocking, destructible, hp, slow, cover, color }
export function createTerrain(width, height, fill = 'floor')
// { width, height, get(cx, cy), set(cx, cy, type), damage(cx, cy, amount) -> 被摧毁时 true,
//   isBlocked(x, y) /* 世界坐标，越界为 true */, slowAt(x, y), coverAt(x, y),
//   raycast(x0, y0, x1, y1) -> 第一个 blocking/cover 格或 null,
//   onChange(fn) -> off /* fn([{cx, cy, from, to}]) */, toJSON(), static fromJSON(data) }
export function parseTerrain(rows, legend)  // 字符画 -> terrain，供关卡与测试使用
```

## Files

- `src/terrain.js`
- `checks/unit/terrain-checks.mjs`

## Shared registrations

只追加本工单的条目，不重排、不删除其他工单的条目（工单 24 除外）。

- 本工单不改共享文件；`TILE_TYPES` 的数值（耐久、减速系数）在工单 05 之后由各系统通过 `BALANCE.terrain` 覆盖，见工单 08。

## Acceptance criteria

- [ ] isBlocked 对越界坐标返回 true，对格子边界坐标归属一致（左闭右开）
- [ ] damage 把 destructible 格子打到 0 时变为 rubble 并通过 onChange 批量通知
- [ ] raycast 用 DDA 遍历格子，结果与逐像素采样一致
- [ ] toJSON / fromJSON 往返后所有格子和剩余耐久相同
- [ ] 新增 `checks/unit/terrain-checks.mjs`，覆盖本工单的接口与边界情况，`node --test checks/unit/` 通过
- [ ] `node checks/soak.mjs`（默认 60 秒）通过，且本工单的系统状态经 save/load 往返后哈希不变
- [ ] 同种子、同输入两次运行状态哈希相同；逻辑代码不使用 Math.random、Date.now 或 performance.now
