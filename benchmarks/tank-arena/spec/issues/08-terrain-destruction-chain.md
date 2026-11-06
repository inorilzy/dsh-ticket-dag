# 08: 地形破坏与连锁爆炸

**Status:** ready-for-agent

**Blocked by:** 03, 06

Parent spec: `.scratch/tank-arena/spec.md`（先读其中的原创性要求、技术约束、系统接口和 soak 接入约定）。

## What to build

让爆炸和穿甲矛破坏地形；barrel（燃料桶）格子被摧毁时延迟若干帧后自身爆炸，形成连锁。连锁顺序必须确定，同一帧多个爆炸按坐标排序结算。

## Interface

```js
// src/systems/destruction.js
export const destructionSystem = { name: 'destruction', init, step, save, load }
// 私有状态：待引爆队列 [{ cx, cy, at }]，必须进入 save()
// services.destruction: { blast(x, y, radius, power) }
```

## Files

- `src/systems/destruction.js`
- `src/levels/proving-ground.js`
- `src/main.js`
- `src/world.js`
- `src/events.js`
- `src/data/balance.js`
- `checks/unit/destruction-checks.mjs`

## Shared registrations

只追加本工单的条目，不重排、不删除其他工单的条目（工单 24 除外）。

- `src/main.js`：`destructionSystem` 插在 `projectile` 之后、`damage` 之前（若已存在）。
- `src/world.js`：注册组件 `debris`（短寿命、`solid: false`，供渲染粒子使用）。
- `src/events.js`：注册 `terrain:destroyed`（cx, cy, from）、`barrel:primed`（cx, cy, at）、`barrel:exploded`（cx, cy）。
- `src/data/balance.js`：新增 `destruction` 节：`barrelDelay`、`barrelRadius`、`barrelPower`、`crateHp`、`debrisLifetime`；`terrain` 节覆盖 `TILE_TYPES` 的耐久。
- 在试炼场放置若干 crate 和 barrel，保证 soak 对局会触发连锁。

## Acceptance criteria

- [ ] 一排 barrel 按确定顺序依次引爆，结果与同种子重跑一致
- [ ] 对局中途存档时待引爆队列被保存，恢复后照常引爆
- [ ] 被摧毁的格子变为 rubble 后坦克可以通过
- [ ] 爆炸摧毁地形不会把实体留在不可穿越格子内
- [ ] 新增 `checks/unit/destruction-checks.mjs`，覆盖本工单的接口与边界情况，`node --test checks/unit/` 通过
- [ ] `node checks/soak.mjs`（默认 60 秒）通过，且本工单的系统状态经 save/load 往返后哈希不变
- [ ] 同种子、同输入两次运行状态哈希相同；逻辑代码不使用 Math.random、Date.now 或 performance.now
