# 15: 经济与升级树

**Status:** ready-for-agent

**Blocked by:** 04, 14

Parent spec: `.scratch/tank-arena/spec.md`（先读其中的原创性要求、技术约束、系统接口和 soak 接入约定）。

## What to build

实现资源“锈币”（scrip）：击杀与拾取获得，用于局间升级。升级树三条分支（装甲、火力、机动），每个节点有前置节点和价格；升级效果通过 balance overrides 应用，不直接改系统代码。

## Interface

```js
// src/data/upgrades.js
export const UPGRADE_TREE = [{ id, branch, cost, requires: [], effects: { 'tank.maxSpeed': 1.1 } }]
// src/systems/economy.js
export const economySystem = { name: 'economy', init, step, save, load, resources }
export function canBuy(tree, owned, scrip, id) / buy(...) -> { owned, scrip }
export function overridesFor(tree, owned) -> balance overrides（乘法效果按购买顺序叠加）
```

## Files

- `src/data/upgrades.js`
- `src/systems/economy.js`
- `src/main.js`
- `src/events.js`
- `src/data/balance.js`
- `checks/unit/economy-checks.mjs`

## Shared registrations

只追加本工单的条目，不重排、不删除其他工单的条目（工单 24 除外）。

- `src/main.js`：`economySystem` 插在 `pickup` 之后；`createGame({ options: { upgrades } })` 用 `overridesFor` 创建 `game.balance`，存档保存已购升级。
- `src/events.js`：注册 `economy:earned`（amount, reason）、`economy:purchased`（id, cost）。
- `src/data/balance.js`：新增 `economy` 节：`killReward`、`pickupReward`、`maxScrip`、`bossReward`；`validateBalance` 校验 `UPGRADE_TREE` 的 effects 只引用存在的键。

## Acceptance criteria

- [ ] 锈币在 0..maxScrip 内并出现在 inspect().resources.scrip
- [ ] 缺少前置或锈币不足时 buy 抛错且状态不变
- [ ] 带升级创建的对局在存档恢复后仍使用相同的 overrides
- [ ] UPGRADE_TREE 引用不存在的 balance 键时 validateBalance 报错
- [ ] 新增 `checks/unit/economy-checks.mjs`，覆盖本工单的接口与边界情况，`node --test checks/unit/` 通过
- [ ] `node checks/soak.mjs`（默认 60 秒）通过，且本工单的系统状态经 save/load 往返后哈希不变
- [ ] 同种子、同输入两次运行状态哈希相同；逻辑代码不使用 Math.random、Date.now 或 performance.now
