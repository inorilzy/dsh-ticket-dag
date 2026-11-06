# 19: Canvas 渲染、相机、粒子

**Status:** ready-for-agent

**Blocked by:** 05, 06, 08

Parent spec: `.scratch/tank-arena/spec.md`（先读其中的原创性要求、技术约束、系统接口和 soak 接入约定）。

## What to build

实现 Canvas 2D 渲染：只用色块与几何图形绘制地形、坦克（车体矩形 + 炮塔圆 + 炮管线条）、弹丸、爆炸和碎屑粒子。相机平滑跟随玩家并在爆炸时震动，渲染用 loop.alpha 插值。渲染只读游戏状态，不写入。

## Interface

```js
// src/render/renderer.js
export function createRenderer(canvas, { palette }) // { draw(game, alpha), resize(w, h) }
// src/render/camera.js（纯逻辑，可在 Node 测试）
export function createCamera({ lerp, shakeDecay }) // { follow(x, y, dt), shake(amount), worldToScreen(x, y), state() }
// src/render/particles.js（纯逻辑）
export function createParticles(seed) // 由事件生成粒子，使用独立随机流，不影响 game.rng
// src/render/palette.js：原创配色（锈橙、盐白、潮绿、灰潮蓝），不使用任何现有游戏的配色方案
index.html：全屏 canvas，加载 src/app.js
```

## Files

- `src/render/renderer.js`
- `src/render/camera.js`
- `src/render/particles.js`
- `src/render/palette.js`
- `src/app.js`
- `index.html`
- `src/main.js`
- `src/events.js`
- `checks/unit/render-checks.mjs`

## Shared registrations

只追加本工单的条目，不重排、不删除其他工单的条目（工单 24 除外）。

- `src/main.js`：导出 `startBrowser(canvas)`，用工单 01 的 `createLoop` 驱动逻辑与渲染；渲染器只订阅事件，不加入 `SYSTEMS`。
- `src/events.js`：注册 `camera:shake`（amount），爆炸系统在 `projectile:exploded` 与 `barrel:exploded` 时发出。

## Acceptance criteria

- [ ] camera 与 particles 在 Node 下可测试，不触碰 DOM
- [ ] 同一游戏状态绘制两次不改变 hash()
- [ ] 粒子使用独立随机流，开关渲染不改变逻辑结果
- [ ] 浏览器中能看到坦克移动、开火、爆炸（手工验证，写明步骤）
- [ ] 新增 `checks/unit/render-checks.mjs`，覆盖本工单的接口与边界情况，`node --test checks/unit/` 通过
- [ ] `node checks/soak.mjs`（默认 60 秒）通过，且本工单的系统状态经 save/load 往返后哈希不变
- [ ] 同种子、同输入两次运行状态哈希相同；逻辑代码不使用 Math.random、Date.now 或 performance.now
