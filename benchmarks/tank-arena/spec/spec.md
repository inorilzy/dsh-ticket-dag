# Ferrowake：俯视角坦克战役

## 目标

做一款原创的俯视角网页坦克战役 **Ferrowake**（中文名“铁潮”）。玩家驾驶一辆可升级的突击坦克，带领小队在锈蚀的海岸工业区里夺取并守住信号信标，击退一波波敌军，最后击毁多阶段首领“潮汐熔炉”。

本 spec 是集成模式对比实验的固定任务：每轮实验使用相同的 spec、24 张工单、依赖和基线仓库。工单之间刻意存在深依赖、宽并行、共享文件竞争，以及“各自合并干净、合在一起出错”的跨模块风险。请按工单写明的接口实现，不要自行合并或拆分工单。

## 原创性要求（硬性）

- 名称、角色、阵营、关卡、地图、文案、音乐与音效全部原创。不复刻、不致敬任何现有游戏的名称、角色、地图、音乐、外观或玩法目标。
- 胜利目标是夺取与守住信标、完成任务目标，**不使用“保护基地/保护老鹰”一类目标**，也不出现砖墙围住基地的布局。
- 美术只用色块与几何图形（矩形、多边形、圆、线条），在 Canvas 上程序绘制；不引入任何图片、字体或精灵图文件。
- 音效全部用 WebAudio 振荡器、噪声和包络程序合成；不引入音频文件。
- 至少 3 个原创关卡，关卡名与布局自拟（参考命名：锈蚀码头 Rust Quay、盐沼泵站 Brine Pumpworks、熔炉堤岸 Forge Embankment）。

## 技术约束

- 零依赖：不写 dependencies/devDependencies，只用浏览器原生 API 与 Node 标准库。原生 JS ESM，文件扩展名 `.js`，`package.json` 已设 `"type": "module"`。
- 逻辑与渲染分离：`src/` 下除 `src/render/`、`src/ui/`、`src/audio/`、`src/input/`（DOM 部分）和 `index.html` 外，所有模块必须能在 Node 下无头导入和运行，不得触碰 `window`、`document`、`AudioContext`。
- 固定步长：逻辑帧 `DT = 1/60` 秒，渲染只做插值，不影响逻辑。
- 确定性：所有随机都来自带种子的随机数（工单 01），禁止 `Math.random()`、`Date.now()`、`performance.now()` 进入逻辑。同种子、同输入序列必须得到相同状态哈希。迭代顺序必须确定（按实体 ID 升序，不依赖对象插入顺序以外的东西）。
- 状态可序列化：所有逻辑状态（包括各系统的私有状态和随机数状态）必须能 `JSON.stringify` 往返无损，禁止 `NaN`、`Infinity`、`Map`、`Set`、函数进入存档。
- 世界坐标单位为像素，地形格子边长 `TILE = 32`。

## 架构与共享注册点

四个共享文件是全体系统的注册点，几乎每张工单都要修改它们。修改时只追加自己的注册项，不重排、不删除别人的条目。

| 文件 | 内容 | 每张工单要做的事 |
| --- | --- | --- |
| `src/main.js` | `SYSTEMS` 有序数组、`createGame`、`loadGame` | 把自己的系统按工单写明的位置插入 `SYSTEMS` |
| `src/world.js` | 实体存储、`COMPONENTS` 组件注册表、`serializeWorld` / `restoreWorld` | 在 `COMPONENTS` 注册自己的组件及默认值 |
| `src/events.js` | `EVENT_TYPES` 事件注册表、事件总线 | 在 `EVENT_TYPES` 注册自己发出的事件及字段 |
| `src/data/balance.js` | `BALANCE` 数值表、`createBalance`、`validateBalance` | 在 `BALANCE` 下新增以系统名为第一段的数值节 |

### 系统接口

`SYSTEMS` 的每一项形如：

```js
export const tankSystem = {
  name: 'tank',                 // 与 BALANCE 的第一段同名（若有数值）
  init(game) {},                // createGame 时按 SYSTEMS 顺序调用
  step(game, input, dt) {},     // 每个逻辑帧按 SYSTEMS 顺序调用
  save(game) { return {} },     // 返回该系统私有状态（纯 JSON）
  load(game, data) {},          // 用 save 的结果恢复私有状态
  resources(game) { return {} },// 可选：{ 名称: { value, max } }，汇总进 inspect().resources
}
```

系统只能通过 `game.world`、`game.events`、`game.balance`、`game.rng`、`game.terrain` 以及其他系统在 `game.services` 上公开的函数协作，不直接 import 其他系统的内部状态。

工单 06、08、09 不依赖工单 01 和 05，合入时 `createGame`、`game.world`、`game.terrain`、`game.balance` 可能都还不存在。这些系统照常注册，但 `init`、`step` 在所需部件缺失时必须直接返回，不抛错，等部件落地后自动生效。可选协作方（`game.services.xxx`）同样按“存在才调用”处理。

### 游戏对象（soak 接入约定）

`src/main.js` 必须导出：

- `createGame({ seed, level = 'proving-ground', options })`：返回（或以 Promise 返回）游戏对象。默认关卡“试炼场”（proving-ground）是 soak 使用的无尽训练场：各工单把自己的内容（敌人、信标、油桶、道具等）接入它，保证 soak 的 900 帧对局能跑到每个系统。
- `loadGame(snapshot)`：用 `game.save()` 的结果重建游戏对象，`hash()` 必须与存档时完全相同，之后喂相同输入得到相同哈希。

游戏对象必须提供：

- `step(input)`：推进一个逻辑帧。`input` 结构为 `{ move: {x, y}, aim: {x, y}, fire, ability, order }`，`move`/`aim` 各分量在 `[-1, 1]`，`order` 为 `null` 或 `'follow' | 'hold' | 'attack' | 'regroup'`。
- `hash()`：整局逻辑状态的哈希字符串，由 `src/core/hash.js` 的 `hashState` 对世界、地形、随机数、所有系统 `save()` 的结果计算。
- `save()`：纯 JSON 快照，包含 `version`（存档格式版本）、种子、帧号、世界、地形、随机数状态和每个系统的 `save()`。
- `systems`：已注册系统名数组（`SYSTEMS.map(s => s.name)`）。
- `inspect()`：供不变量检查的只读视图：
  - `entities`：`[{ id, kind, x, y, radius, solid, hp, maxHp }]`，`hp`/`maxHp` 仅对有血量的实体给出；`solid === false` 的实体（弹丸、粒子、道具）不参与嵌墙检查。
  - `terrain`：带 `isBlocked(x, y)` 的对象，世界坐标落在不可穿越格子内返回 `true`。
  - `resources`：`{ 名称: { value, max } }`，如弹药、能量、金属。
  - `emittedEvents`：本局至今发出过的事件类型数组。
  - `balanceReads`：本局至今读取过的 `BALANCE` 键（点分路径）数组。

### soak 检查

`checks/soak.mjs` 在固定时长内（默认 `BENCH_SOAK_SECONDS=60`）用种子 1、2、3…… 循环跑 900 帧的无头对局，输入由 `checks/harness.mjs` 的 `inputFor(seed, tick)` 生成，并断言：

1. 同种子两次运行，每 60 帧的 `hash()` 相同；
2. 对局中途 `save()` → `JSON` → `loadGame()` 后继续运行，后续哈希与不存档的一致——任何系统忘了在 `save/load` 中带上自己的状态都会失败；
3. 每 30 帧的跨系统不变量：血量在 `0..maxHp`、资源在 `0..max`、实体中心附近不落在不可穿越地形内、`emittedEvents` 都已在 `EVENT_TYPES` 注册；
4. 全部对局结束后：读取过但 `BALANCE` 里没有的键报错；`BALANCE` 中属于已注册系统（第一段等于某个 `systems` 名）却从未被读取的键报错。

每个系统的 `BALANCE` 键都必须在一局 900 帧的 soak 对局里被读到；只在少见分支用到的键在 `init` 里读取并缓存即可（`init` 中的读取也计入 `balanceReads`）。

还不存在的系统对应的检查自动跳过。时长是实验有意设定的固定成本，不要缩短默认值。

### 测试

- 快检查：`node --test checks/unit/`。`checks/unit/index.js` 会导入同目录全部 `.mjs` 文件；每张工单新增 `checks/unit/<系统名>-checks.mjs`。
- 测试文件名不得匹配 `node --test` 的默认发现规则：不要 `*.test.*`、`*-test.*`、`*_test.*`、`test-*`、`test.*`，也不要名为 `test` 的目录。
- 慢检查：`node checks/soak.mjs`。

## 工单与依赖

| # | 工单 | Blocked by |
| --- | --- | --- |
| 01 | 固定步长循环、种子随机数、输入录制 | 无 |
| 02 | 实体存储与事件总线 | 无 |
| 03 | 网格地形与属性 | 无 |
| 04 | 数值表与校验 | 无 |
| 05 | 玩家坦克：惯性移动、独立炮塔、碰撞 | 01、02、03、04 |
| 06 | 弹道：反弹、穿透、范围爆炸 | 02、03、04 |
| 07 | 伤害与受击方向装甲 | 05、06 |
| 08 | 地形破坏与连锁爆炸 | 03、06 |
| 09 | 路径寻找：A* 与流场、增量更新 | 03 |
| 10 | 敌人 AI 状态机 | 05、06、09 |
| 11 | 四种敌人与多阶段首领 | 07、10 |
| 12 | 波次导演与动态难度 | 10 |
| 13 | 友军小队与指令 | 07、10 |
| 14 | 道具与主动技能 | 07 |
| 15 | 经济与升级树 | 04、14 |
| 16 | 信标占领与任务目标 | 05、12 |
| 17 | 战争迷雾与视野 | 03、05 |
| 18 | 存档与回放、版本迁移 | 01、02、15 |
| 19 | Canvas 渲染、相机、粒子 | 05、06、08 |
| 20 | HUD 与小地图 | 17、19 |
| 21 | WebAudio 合成音效 | 02、06 |
| 22 | 键鼠与触控输入、改键 | 05 |
| 23 | 关卡格式、3 个原创关卡、关卡编辑器 | 03、16、19 |
| 24 | 战役流程与整合 | 11、12、13、14、15、16、18、20、21、22、23 |

## 完成标准

- 24 张工单全部合入后，`node --test checks/unit/` 与 `node checks/soak.mjs` 都通过，且 soak 的 `skipped` 中不再有游戏、存档、不变量、事件、平衡相关的跳过项。
- 打开 `index.html`（用任意静态文件服务器）可以从菜单开始战役、通关 3 个关卡并看到胜负结算。
