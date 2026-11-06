# 04: 数值表 src/data/balance.js 与校验

**Status:** ready-for-agent

**Blocked by:** None (can start immediately)

Parent spec: `.scratch/tank-arena/spec.md`（先读其中的原创性要求、技术约束、系统接口和 soak 接入约定）。

## What to build

实现集中数值表。所有可调数值放在 BALANCE，按系统名分节；读取统一经过 createBalance 返回的读取器，读取器记录读过的键，soak 用它检查缺失键和未使用键。

## Interface

```js
// src/data/balance.js
export const BALANCE = { meta: { version: 1 } }
export function validateBalance(table)    // 返回问题列表：非有限数、负的时长/速度、节名不是小写标识符、重复键
export function createBalance(table = BALANCE, overrides = {})
// { get(path) /* 'tank.maxSpeed'，缺失时抛错 */, section(name) /* 只读对象，读取字段也计入 reads */,
//   reads() -> 读过的点分路径（排序去重）, keys() -> 全部叶子路径 }
```

## Files

- `src/data/balance.js`
- `checks/unit/balance-checks.mjs`

## Shared registrations

只追加本工单的条目，不重排、不删除其他工单的条目（工单 24 除外）。

- `src/data/balance.js`：建立 `BALANCE`，只放 `meta.version`。之后每张有数值的工单在这里新增以系统名为第一段的节，节名必须等于该系统的 `name`。

## Acceptance criteria

- [ ] get 缺失路径抛出包含路径名的错误
- [ ] section 返回的对象被冻结，读取字段计入 reads()
- [ ] validateBalance 能发现 NaN、Infinity、负时长和未知类型
- [ ] overrides 只能覆盖已存在的键
- [ ] 新增 `checks/unit/balance-checks.mjs`，覆盖本工单的接口与边界情况，`node --test checks/unit/` 通过
- [ ] `node checks/soak.mjs`（默认 60 秒）通过，且本工单的系统状态经 save/load 往返后哈希不变
- [ ] 同种子、同输入两次运行状态哈希相同；逻辑代码不使用 Math.random、Date.now 或 performance.now
