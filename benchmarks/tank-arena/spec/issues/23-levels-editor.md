# 23: 关卡数据格式、3 个以上原创关卡、关卡编辑器

**Status:** ready-for-agent

**Blocked by:** 03, 16, 19

Parent spec: `.scratch/tank-arena/spec.md`（先读其中的原创性要求、技术约束、系统接口和 soak 接入约定）。

## What to build

定义关卡 JSON 格式并制作至少 3 个原创关卡：锈蚀码头（Rust Quay）、盐沼泵站（Brine Pumpworks）、熔炉堤岸（Forge Embankment，首领关）。每关含地形字符画、出生点、信标、撤离点、波次表、目标列表。提供浏览器内关卡编辑器（画格子、放信标、导出 JSON）。

## Interface

```js
// src/levels/format.js
export function validateLevel(level) -> 问题列表 // 出生点可达所有信标（用工单 09 的 findPath 若存在，否则 BFS）
export function loadLevel(level) -> { terrain, spawns, beacons, extract, waves, objectives }
// src/levels/index.js
export const LEVELS = { 'proving-ground', 'rust-quay', 'brine-pumpworks', 'forge-embankment' }
// src/editor/editor.js（浏览器）+ editor.html
```

## Files

- `src/levels/format.js`
- `src/levels/index.js`
- `src/levels/rust-quay.json`
- `src/levels/brine-pumpworks.json`
- `src/levels/forge-embankment.json`
- `src/levels/proving-ground.js`
- `src/editor/editor.js`
- `editor.html`
- `src/main.js`
- `checks/unit/levels-checks.mjs`

## Shared registrations

只追加本工单的条目，不重排、不删除其他工单的条目（工单 24 除外）。

- `src/main.js`：`createGame({ level })` 通过 `LEVELS` 和 `loadLevel` 创建地形与实体；试炼场改写为同一格式。
- 关卡布局为原创设计，不得照搬任何现有游戏的地图；不得出现被砖墙包围、需要保护的基地。

## Acceptance criteria

- [ ] 三个原创关卡都通过 validateLevel，且每关至少一个可达信标和撤离点
- [ ] 编辑器导出的 JSON 能被 loadLevel 读取并开局
- [ ] 用每个关卡创建对局各跑 300 帧，同种子哈希一致
- [ ] 试炼场仍是 createGame 的默认关卡，soak 行为不变
- [ ] 新增 `checks/unit/levels-checks.mjs`，覆盖本工单的接口与边界情况，`node --test checks/unit/` 通过
- [ ] `node checks/soak.mjs`（默认 60 秒）通过，且本工单的系统状态经 save/load 往返后哈希不变
- [ ] 同种子、同输入两次运行状态哈希相同；逻辑代码不使用 Math.random、Date.now 或 performance.now
