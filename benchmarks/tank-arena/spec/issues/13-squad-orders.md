# 13: 友军小队与指令

**Status:** ready-for-agent

**Blocked by:** 07, 10

Parent spec: `.scratch/tank-arena/spec.md`（先读其中的原创性要求、技术约束、系统接口和 soak 接入约定）。

## What to build

实现两辆友军僚机“锚钩”与“灯芯”（Grapnel、Wick），复用 AI 状态机但阵营相反；玩家通过输入的 order 字段下达 follow、hold、attack、regroup 指令。友军火力不伤友军。

## Interface

```js
// src/systems/squad.js
export const squadSystem = { name: 'squad', init, step, save, load }
// 组件 squad: { order, anchor, slot }
// services.squad: { members(), issue(order) }
```

## Files

- `src/systems/squad.js`
- `src/main.js`
- `src/world.js`
- `src/events.js`
- `src/data/balance.js`
- `checks/unit/squad-checks.mjs`

## Shared registrations

只追加本工单的条目，不重排、不删除其他工单的条目（工单 24 除外）。

- `src/main.js`：`squadSystem` 插在 `ai` 之后、`tank` 之前；试炼场开局生成两名僚机。
- `src/world.js`：注册组件 `squad`。
- `src/events.js`：注册 `squad:order`（order, tick）、`squad:down`（id）。
- `src/data/balance.js`：新增 `squad` 节：`followDistance`、`holdRadius`、`regroupSpeed`、`friendlyFire`（必须为 0）、`memberHp`。
- 修改工单 07 的伤害结算：同阵营伤害乘以 `squad.friendlyFire`。

## Acceptance criteria

- [ ] regroup 后僚机在限定帧数内回到玩家附近的槽位
- [ ] 友军弹丸命中友军不扣血，但仍会反弹或爆炸
- [ ] 指令在存档恢复后保持
- [ ] 僚机阵亡后指令只作用于存活成员
- [ ] 新增 `checks/unit/squad-checks.mjs`，覆盖本工单的接口与边界情况，`node --test checks/unit/` 通过
- [ ] `node checks/soak.mjs`（默认 60 秒）通过，且本工单的系统状态经 save/load 往返后哈希不变
- [ ] 同种子、同输入两次运行状态哈希相同；逻辑代码不使用 Math.random、Date.now 或 performance.now
