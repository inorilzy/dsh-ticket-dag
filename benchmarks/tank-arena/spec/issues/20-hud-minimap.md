# 20: HUD 与小地图

**Status:** ready-for-agent

**Blocked by:** 17, 19

Parent spec: `.scratch/tank-arena/spec.md`（先读其中的原创性要求、技术约束、系统接口和 soak 接入约定）。

## What to build

实现 HUD：血量条、弹药、技能能量、锈币、当前波次、目标列表；小地图显示已探索地形、可见敌人、信标和撤离点，遵守战争迷雾。HUD 数据由纯函数从游戏状态派生，绘制只在浏览器进行。

## Interface

```js
// src/ui/hud-model.js（纯逻辑）
export function hudModel(game) -> { hp, maxHp, ammo, energy, scrip, wave, objectives: [...] }
export function minimapModel(game, { size }) -> { cells, markers: [{ kind, x, y }] } // 不包含迷雾中的敌人
// src/ui/hud.js / src/ui/minimap.js：绘制到 canvas 覆盖层
```

## Files

- `src/ui/hud-model.js`
- `src/ui/hud.js`
- `src/ui/minimap.js`
- `src/app.js`
- `checks/unit/hud-checks.mjs`

## Shared registrations

只追加本工单的条目，不重排、不删除其他工单的条目（工单 24 除外）。

- 本工单不改共享文件；只读取各系统在 `services` 上公开的状态。缺少某个系统时对应 HUD 项隐藏，不报错。

## Acceptance criteria

- [ ] minimapModel 不包含玩家阵营看不到的敌人
- [ ] hudModel 在缺少经济、技能、目标系统时也能返回结果
- [ ] HUD 数值与 inspect().resources 一致
- [ ] 调用 hudModel 不改变 hash()
- [ ] 新增 `checks/unit/hud-checks.mjs`，覆盖本工单的接口与边界情况，`node --test checks/unit/` 通过
- [ ] `node checks/soak.mjs`（默认 60 秒）通过，且本工单的系统状态经 save/load 往返后哈希不变
- [ ] 同种子、同输入两次运行状态哈希相同；逻辑代码不使用 Math.random、Date.now 或 performance.now
