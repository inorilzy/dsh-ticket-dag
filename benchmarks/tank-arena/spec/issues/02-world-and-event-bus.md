# 02: 实体存储与事件总线

**Status:** ready-for-agent

**Blocked by:** None (can start immediately)

Parent spec: `.scratch/tank-arena/spec.md`（先读其中的原创性要求、技术约束、系统接口和 soak 接入约定）。

## What to build

实现实体存储与事件总线。实体是带递增整数 ID 的组件集合；组件类型必须先在 COMPONENTS 注册。事件必须先在 EVENT_TYPES 注册，发出未注册事件直接抛错。

## Interface

```js
// src/world.js
export const COMPONENTS = { position: { x: 0, y: 0 }, body: { radius: 8, solid: true } }
export function createWorld()  // { spawn(kind, components) -> id, despawn(id), get(id), has(id, comp),
                               //   query(...comps) -> 按 id 升序的实体数组, count(kind) }
export function serializeWorld(world) / restoreWorld(data)  // 纯 JSON，往返后 query 顺序与 nextId 不变
// src/events.js
export const EVENT_TYPES = { 'entity:spawned': ['id', 'kind'], 'entity:despawned': ['id', 'kind'] }
export function createEventBus()  // { emit(type, payload), on(type, fn) -> off, drain() -> 本帧事件,
                                  //   emitted() -> 至今发出过的类型（排序去重）, save(), load(data) }
```

## Files

- `src/world.js`
- `src/events.js`
- `checks/unit/world-checks.mjs`

## Shared registrations

只追加本工单的条目，不重排、不删除其他工单的条目（工单 24 除外）。

- `src/world.js`：定义 `COMPONENTS` 并注册 `position`、`body`；`spawn` 对未注册组件抛错并用默认值补全字段。
- `src/events.js`：定义 `EVENT_TYPES`（值为必填字段名数组）并注册 `entity:spawned`、`entity:despawned`；`emit` 校验类型已注册、必填字段齐全。

## Acceptance criteria

- [ ] spawn 未注册组件或 emit 未注册事件时抛出带名称的错误
- [ ] query 结果按实体 ID 升序，despawn 后 ID 不复用
- [ ] serializeWorld → JSON → restoreWorld 后继续 spawn 得到与未序列化时相同的 ID
- [ ] 事件监听器按注册顺序调用，emitted() 记录全部发出过的类型
- [ ] 新增 `checks/unit/world-checks.mjs`，覆盖本工单的接口与边界情况，`node --test checks/unit/` 通过
- [ ] `node checks/soak.mjs`（默认 60 秒）通过，且本工单的系统状态经 save/load 往返后哈希不变
- [ ] 同种子、同输入两次运行状态哈希相同；逻辑代码不使用 Math.random、Date.now 或 performance.now
