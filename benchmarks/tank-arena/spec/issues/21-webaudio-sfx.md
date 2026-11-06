# 21: WebAudio 合成音效，由事件驱动

**Status:** ready-for-agent

**Blocked by:** 02, 06

Parent spec: `.scratch/tank-arena/spec.md`（先读其中的原创性要求、技术约束、系统接口和 soak 接入约定）。

## What to build

用 WebAudio 程序合成全部音效（开火、反弹、爆炸、占领、首领换阶段、按钮），不使用音频文件。音效由事件总线驱动：事件到音效的映射是纯数据，便于在 Node 下测试映射与节流。

## Interface

```js
// src/audio/cues.js（纯逻辑）
export const CUES = { 'projectile:fired': { synth: 'thump', pitch, gain, throttle }, ... }
export function planCues(events, state) -> { play: [...], state }  // 同帧同类事件节流
// src/audio/synth.js（浏览器）
export function createSynth(audioContext) // { play(cue), setVolume(v), mute(bool) }
```

## Files

- `src/audio/cues.js`
- `src/audio/synth.js`
- `src/app.js`
- `src/events.js`
- `src/data/balance.js`
- `checks/unit/audio-checks.mjs`

## Shared registrations

只追加本工单的条目，不重排、不删除其他工单的条目（工单 24 除外）。

- `src/events.js`：注册 `audio:muted`（muted）；`CUES` 的每个键必须是已注册事件（检查里断言）。
- `src/data/balance.js`：新增 `audio` 节：`masterGain`、`throttleTicks`、`maxVoices`。音频系统不在 `SYSTEMS` 中，所以 soak 不检查这些键是否被读取；单元检查要读取它们。

## Acceptance criteria

- [ ] CUES 只引用 EVENT_TYPES 中存在的事件
- [ ] 同一帧 10 次 projectile:fired 只产生 maxVoices 以内的播放
- [ ] 没有 AudioContext 的环境下导入 cues.js 不报错
- [ ] 静音状态不影响逻辑 hash()
- [ ] 新增 `checks/unit/audio-checks.mjs`，覆盖本工单的接口与边界情况，`node --test checks/unit/` 通过
- [ ] `node checks/soak.mjs`（默认 60 秒）通过，且本工单的系统状态经 save/load 往返后哈希不变
- [ ] 同种子、同输入两次运行状态哈希相同；逻辑代码不使用 Math.random、Date.now 或 performance.now
