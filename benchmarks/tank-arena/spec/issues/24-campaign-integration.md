# 24: 战役流程：菜单、胜负、进度、整合全部系统

**Status:** ready-for-agent

**Blocked by:** 11, 12, 13, 14, 15, 16, 18, 20, 21, 22, 23

Parent spec: `.scratch/tank-arena/spec.md`（先读其中的原创性要求、技术约束、系统接口和 soak 接入约定）。

## What to build

把全部系统整合成完整战役：标题菜单（新战役、继续、关卡选择、改键、音量）、关卡间升级商店、胜负结算、战役进度存档。检查 SYSTEMS 顺序、事件注册、平衡表和存档覆盖了所有系统，修掉合并后才暴露的跨模块问题。

## Interface

```js
// src/campaign.js（纯逻辑）
export function createCampaign(storage) // { state(), startLevel(id), finishLevel(result), unlocked(), save(), load() }
// 战役顺序：rust-quay -> brine-pumpworks -> forge-embankment；通关解锁下一关并获得锈币
// src/ui/menu.js（浏览器）：菜单与结算界面，全部用几何图形与系统字体绘制
```

## Files

- `src/campaign.js`
- `src/ui/menu.js`
- `src/app.js`
- `src/main.js`
- `src/world.js`
- `src/events.js`
- `src/data/balance.js`
- `checks/unit/campaign-checks.mjs`

## Shared registrations

只追加本工单的条目，不重排、不删除其他工单的条目（工单 24 除外）。

- `src/main.js`：最终确定 `SYSTEMS` 顺序：`roster`、`director`、`ai`、`squad`、`tank`、`fog`、`projectile`、`destruction`、`damage`、`navigation`、`pickup`、`economy`、`objective`，并为顺序写检查。
- `src/world.js`：确认每个组件都有使用者，删除无人使用的组件注册。
- `src/events.js`：注册 `campaign:level-started`、`campaign:level-finished`（level, result, scrip）；确认每个注册事件都有发出者。
- `src/data/balance.js`：新增 `campaign` 节：`levelReward`、`retryPenalty`；删除无人读取的键。

## Acceptance criteria

- [ ] 从菜单开始新战役，三关依次解锁，通关后显示结算（手工验证，写明步骤）
- [ ] 战役进度存档包含已购升级，读档后继续下一关
- [ ] soak 的 skipped 列表中不再有游戏、存档、不变量、事件、平衡相关的跳过项
- [ ] 所有工单的 checks/unit 检查一起运行通过
- [ ] 新增 `checks/unit/campaign-checks.mjs`，覆盖本工单的接口与边界情况，`node --test checks/unit/` 通过
- [ ] `node checks/soak.mjs`（默认 60 秒）通过，且本工单的系统状态经 save/load 往返后哈希不变
- [ ] 同种子、同输入两次运行状态哈希相同；逻辑代码不使用 Math.random、Date.now 或 performance.now
