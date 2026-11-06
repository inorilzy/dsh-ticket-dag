# 18: 存档与回放：带版本迁移，能在对局中途保存恢复

**Status:** ready-for-agent

**Blocked by:** 01, 02, 15

Parent spec: `.scratch/tank-arena/spec.md`（先读其中的原创性要求、技术约束、系统接口和 soak 接入约定）。

## What to build

把 save/load 做成正式功能：存档格式带 version，提供迁移链把旧版本存档升级到当前版本；本地存档槽使用可替换的存储后端（浏览器为 localStorage，Node 为内存）；回放文件 = 种子 + 关卡 + 升级 + 输入录制。

## Interface

```js
// src/save.js
export const SAVE_VERSION = 2
export const MIGRATIONS = { 1: (v1) => v2 }      // 版本 n 升到 n+1
export function migrate(snapshot) -> 当前版本快照  // 未知的更高版本抛错
export function createSaveSlots(storage)          // { list(), write(slot, game), read(slot) -> snapshot, remove(slot) }
// src/replay.js
export function recordReplay(game) / playReplay(replay) -> game  // 回放结束时 hash 与原对局一致
```

## Files

- `src/save.js`
- `src/replay.js`
- `src/main.js`
- `src/events.js`
- `checks/unit/save-checks.mjs`
- `checks/fixtures/save-v1.json`

## Shared registrations

只追加本工单的条目，不重排、不删除其他工单的条目（工单 24 除外）。

- `src/main.js`：`save()` 输出 `version: SAVE_VERSION`；`loadGame` 先 `migrate`；把经济系统的已购升级纳入存档的 `options`。
- `src/events.js`：注册 `save:written`（slot, tick）、`save:loaded`（slot, fromVersion）。
- 提交一份 version 1 的固定存档 fixture，验证迁移后可以加载并继续运行。

## Acceptance criteria

- [ ] version 1 fixture 经 migrate 后可加载，继续 300 帧不报错
- [ ] 版本号高于 SAVE_VERSION 的存档被拒绝并给出明确错误
- [ ] 回放 900 帧后 hash 与原对局一致
- [ ] 任意中途存档在 soak 的存档恢复一致性检查中通过
- [ ] 新增 `checks/unit/save-checks.mjs`，覆盖本工单的接口与边界情况，`node --test checks/unit/` 通过
- [ ] `node checks/soak.mjs`（默认 60 秒）通过，且本工单的系统状态经 save/load 往返后哈希不变
- [ ] 同种子、同输入两次运行状态哈希相同；逻辑代码不使用 Math.random、Date.now 或 performance.now
