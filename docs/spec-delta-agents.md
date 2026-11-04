# SPEC 变更：预设 Agent 与模型目录

相对交接包 `refs\handoff\dsh-ticket-dag-0.2.0\docs\SPEC.md`（只读，未修改）的增量。

## 配置

`agents`：`{ [id]: { description, instructions, provider, model, reasoningEffort } }`，字段均为字符串，默认值为 `src/agents.mjs` 的 `implementer`、`test-writer`、`docs`。profile 保存后以保存值为准，不与内置值合并。空的 `provider`、`model`、`reasoningEffort` 表示使用宿主默认。

## 清单

工单可选 `agent`（安全 ID）。规范化时：

- ID 不在当前 `agents` 中：拒绝，报 `unknown agent preset: <id>`。
- 设置了 `provider` 或 `reasoningEffort` 却没有 `model`：拒绝。
- 否则写入 `ticket.agent` 与 `ticket.agentSpec`（只含非空的 `instructions`、`provider`、`model`、`reasoningEffort`），随清单冻结进运行账本。

不写 `agent` 的清单与 0.2.0 规范化结果逐字节一致，已有运行的清单比对和验收策略哈希不受影响。`policyHash` 仍只覆盖验收命令。

## 派工

- `agentSpec.instructions` 以 `Role (<id>): <instructions>` 一段写入 worker 提示词，位于工单标题之后、`prompt` 之前。
- `agentSpec.model` 非空时，`launch` 收到 `agentOptions: { provider?, model, reasoningEffort? }`，宿主适配器把它放进 `startActivation` 的 `request.agentOptions`；否则不传该字段。

## 看板与路由

- `GET /api/ticket-dag.dashboard` 的工单行新增 `agent`（ID 或 `null`）与 `model`（`provider/model`、`model` 或 `null`），热运行与冷历史一致。
- `GET /api/ticket-dag.dashboard` 接受可选的 `parent`（队长会话 ID，`[A-Za-z0-9_.:-]{1,200}`，最多一个），只返回该会话发起的运行；`key` 不属于该会话时返回 404。对话右侧栏的「工单进度」标签和对话顶部的「查看工单」按钮用它读取本对话的运行。
- 新增 owner-only `GET /api/ticket-dag.models`，返回 `{ providers: [{ id, name, models: [{ id, name, efforts: [{ id, name }], defaultEffort }] }], failures: [providerId] }`。数据来自宿主 `llm.listProviders`、`listModels`、`resolveModelInfo`；只读，不改变任何会话的模型。读取失败的 provider 列入 `failures`。

## 回归测试

| 行为 | 测试 |
| --- | --- |
| 预设校验、冻结、旧清单不变 | `test/store.test.mjs` |
| 派工透传与提示词、运行中改配置不影响本轮 | `test/coordinator.test.mjs` |
| 默认预设、`agentOptions` 透传 | `test/host.test.mjs` |
| 模型目录路由、冷历史字段 | `test/dashboard.test.mjs` |
| 看板显示、配置页下拉、内置预设副本一致 | `test/client-board.test.mjs` |
