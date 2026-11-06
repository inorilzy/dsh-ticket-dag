# 22: 键鼠与触控输入、改键

**Status:** ready-for-agent

**Blocked by:** 05

Parent spec: `.scratch/tank-arena/spec.md`（先读其中的原创性要求、技术约束、系统接口和 soak 接入约定）。

## What to build

实现输入层：键盘鼠标（WASD 移动、鼠标瞄准、左键开火、空格技能、1–4 指令）与触控（左半屏虚拟摇杆、右半屏瞄准开火、按钮）。把设备事件归一化为 spec 规定的 input 结构；支持改键并持久化。

## Interface

```js
// src/input/bindings.js（纯逻辑）
export const DEFAULT_BINDINGS = { up: 'KeyW', ..., ability: 'Space', orderFollow: 'Digit1' }
export function rebind(bindings, action, code) -> 新 bindings（冲突时交换）
export function toInput(deviceState, bindings, { deadzone }) -> { move, aim, fire, ability, order }
// src/input/devices.js（浏览器）：键盘、鼠标、触控监听，输出 deviceState
```

## Files

- `src/input/bindings.js`
- `src/input/devices.js`
- `src/app.js`
- `src/main.js`
- `src/data/balance.js`
- `checks/unit/input-checks.mjs`

## Shared registrations

只追加本工单的条目，不重排、不删除其他工单的条目（工单 24 除外）。

- `src/main.js`：`startBrowser` 每个逻辑帧用 `toInput` 生成输入交给 `game.step`，并交给工单 01 的录制器。
- `src/data/balance.js`：新增 `input` 节：`deadzone`、`aimSmoothing`、`touchStickRadius`。

## Acceptance criteria

- [ ] move 向量长度不超过 1，死区内为 0
- [ ] rebind 冲突时交换两个动作的按键，不产生重复绑定
- [ ] toInput 的输出能被录制器序列化并重放
- [ ] 浏览器中键鼠与触控都能操作（手工验证，写明步骤）
- [ ] 新增 `checks/unit/input-checks.mjs`，覆盖本工单的接口与边界情况，`node --test checks/unit/` 通过
- [ ] `node checks/soak.mjs`（默认 60 秒）通过，且本工单的系统状态经 save/load 往返后哈希不变
- [ ] 同种子、同输入两次运行状态哈希相同；逻辑代码不使用 Math.random、Date.now 或 performance.now
