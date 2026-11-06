# 07: 伤害与按受击方向计算的装甲

**Status:** ready-for-agent

**Blocked by:** 05, 06

Parent spec: `.scratch/tank-arena/spec.md`（先读其中的原创性要求、技术约束、系统接口和 soak 接入约定）。

## What to build

实现伤害结算。坦克有前、侧、后三个装甲面，按受击方向与车体朝向的夹角选择装甲面并折算伤害；范围爆炸按距离衰减；血量归零发出 destroyed 事件并销毁实体。

## Interface

```js
// src/systems/damage.js
export const damageSystem = { name: 'damage', init, step, save, load }
// 组件 armor: { front, side, rear }（伤害倍率）
export function armorFacing(hullAngle, dirX, dirY) // 'front' | 'side' | 'rear'
// services.damage: { apply(targetId, amount, { dirX, dirY, sourceId, kind }) -> 实际伤害 }
```

## Files

- `src/systems/damage.js`
- `src/main.js`
- `src/world.js`
- `src/events.js`
- `src/data/balance.js`
- `checks/unit/damage-checks.mjs`

## Shared registrations

只追加本工单的条目，不重排、不删除其他工单的条目（工单 24 除外）。

- `src/main.js`：`damageSystem` 插在 `projectile` 之后。订阅 `projectile:hit` 和 `projectile:exploded`。
- `src/world.js`：注册组件 `armor`，玩家坦克生成时带上它（修改工单 05 的生成参数）。
- `src/events.js`：注册 `damage:dealt`（targetId, amount, facing, sourceId）、`entity:destroyed`（id, kind, sourceId, x, y）。
- `src/data/balance.js`：新增 `damage` 节：`armor.front`、`armor.side`、`armor.rear`、`falloff`、`minSplash`。

## Acceptance criteria

- [ ] 正面、侧面、背面的边界角度（45°/135°）结果确定且有测试
- [ ] 血量被钳制在 0..maxHp，不会出现负数或溢出
- [ ] 范围爆炸对同一实体每次只结算一次
- [ ] 实体被摧毁后其弹丸 ownerId 引用不会导致异常
- [ ] 新增 `checks/unit/damage-checks.mjs`，覆盖本工单的接口与边界情况，`node --test checks/unit/` 通过
- [ ] `node checks/soak.mjs`（默认 60 秒）通过，且本工单的系统状态经 save/load 往返后哈希不变
- [ ] 同种子、同输入两次运行状态哈希相同；逻辑代码不使用 Math.random、Date.now 或 performance.now
