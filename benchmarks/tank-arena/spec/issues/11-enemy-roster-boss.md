# 11: 四种敌人与多阶段首领

**Status:** ready-for-agent

**Blocked by:** 07, 10

Parent spec: `.scratch/tank-arena/spec.md`（先读其中的原创性要求、技术约束、系统接口和 soak 接入约定）。

## What to build

定义四种原创敌人：刺鳐（Skate，快速轻装）、壁虎（Gecko，正面重甲）、迫鸣（Mortarwren，远程榴弹）、织网者（Weaver，布雷减速）；以及首领“潮汐熔炉”（Tidal Forge）：三个阶段，按血量阈值切换，每阶段改变弹种和移动模式。

## Interface

```js
// src/data/enemies.js
export const ENEMY_TYPES = { skate, gecko, mortarwren, weaver }  // { hp, armor, speed, weapon, ai: 覆盖项, color, shape }
export const BOSS = { id: 'tidal-forge', phases: [{ hpBelow, weapon, pattern }] }
// src/systems/roster.js
export const rosterSystem = { name: 'roster', init, step, save, load }
// services.roster: { spawnEnemy(type, x, y) -> id, spawnBoss(x, y) -> id }
```

## Files

- `src/data/enemies.js`
- `src/systems/roster.js`
- `src/main.js`
- `src/world.js`
- `src/events.js`
- `src/data/balance.js`
- `checks/unit/roster-checks.mjs`

## Shared registrations

只追加本工单的条目，不重排、不删除其他工单的条目（工单 24 除外）。

- `src/main.js`：`rosterSystem` 插在 `ai` 之前。
- `src/world.js`：注册组件 `enemy`（type）和 `boss`（phase）。
- `src/events.js`：注册 `boss:phase`（id, phase）、`enemy:spawned`（id, type）、`mine:laid`（id, x, y）。
- `src/data/balance.js`：新增 `roster` 节：每种敌人一组 `hp`、`speed`、`armor`、`reward`，以及 `boss.hp`、`boss.phaseThresholds`、`mine.slow`、`mine.duration`。
- 试炼场每 600 帧生成一次首领以外的随机敌人，第 450 帧生成一次首领，使 soak 覆盖阶段切换代码路径（首领 hp 在试炼场按 `roster.boss.trainingScale` 缩放）。

## Acceptance criteria

- [ ] 首领在同一帧跨越两个阈值时按顺序发出两次 boss:phase
- [ ] 织网者的地雷在存档恢复后剩余时间不变
- [ ] 四种敌人的数值全部来自 BALANCE，代码中没有硬编码数值
- [ ] 敌人生成位置不在不可穿越格子内
- [ ] 新增 `checks/unit/roster-checks.mjs`，覆盖本工单的接口与边界情况，`node --test checks/unit/` 通过
- [ ] `node checks/soak.mjs`（默认 60 秒）通过，且本工单的系统状态经 save/load 往返后哈希不变
- [ ] 同种子、同输入两次运行状态哈希相同；逻辑代码不使用 Math.random、Date.now 或 performance.now
