# SPEC 变更：预设 Agent 与模型目录

相对交接包 `refs\handoff\dsh-ticket-dag-0.2.0\docs\SPEC.md`（只读，未修改）的增量。

## 配置

`agents`：`{ [id]: { description, instructions, provider, model, reasoningEffort, maxConcurrent } }`，`maxConcurrent` 为 0–32 的整数（0 表示不单独限制），其余字段为字符串，默认值为 `src/agents.mjs` 的 `implementer`、`test-writer`、`docs`。profile 保存后以保存值为准，不与内置值合并。空的 `provider`、`model`、`reasoningEffort` 表示使用宿主默认。

## 清单

工单可选 `agent`（安全 ID）。规范化时：

- ID 不在当前 `agents` 中：拒绝，报 `unknown agent preset: <id>`。
- 设置了 `provider` 或 `reasoningEffort` 却没有 `model`：拒绝。
- 否则写入 `ticket.agent` 与 `ticket.agentSpec`（只含非空的 `instructions`、`provider`、`model`、`reasoningEffort`），随清单冻结进运行账本。

不写 `agent` 的清单与 0.2.0 规范化结果逐字节一致，已有运行的清单比对和验收策略哈希不受影响。`policyHash` 仍只覆盖验收命令。

## 派工

- `agentSpec.instructions` 以 `Role (<id>): <instructions>` 一段写入 worker 提示词，位于工单标题之后、`prompt` 之前。
- `agentSpec.model` 非空时，`launch` 收到 `agentOptions: { provider?, model, reasoningEffort? }`，宿主适配器把它放进 `startActivation` 的 `request.agentOptions`；否则不传该字段。
- 派工时，若工单的 `agent` 在当前（实时）配置中有 `maxConcurrent > 0`，且该协调器所有运行中使用这个预设的在途 worker 数已达上限，就跳过这张工单、继续检查后面的就绪工单。上限不冻结进清单；配置更新会唤醒所有运行重新派工，已在运行的 worker 不受影响。预设从配置中删除后只剩全局与单轮上限。

## 插件页

`plugins.tab` 注册为「Agent 预设」页（替代原来的全部运行总览），`plugins.bundle.config` 显示同一页面。页面通过客户端 `configForms.get('dsh-ticket-dag')` 读写配置，只编辑 `maxWorkers`（显示为“最大 Agent 数量”）与 `agents`。完整配置仍在 `plugins.row.config`。运行看板只在对话右侧栏。

## 看板与路由

- `GET /api/ticket-dag.dashboard` 的工单行新增 `agent`（ID 或 `null`）与 `model`（`provider/model`、`model` 或 `null`），热运行与冷历史一致。
- `GET /api/ticket-dag.dashboard` 接受可选的 `parent`（队长会话 ID，`[A-Za-z0-9_.:-]{1,200}`，最多一个），只返回该会话发起的运行；`key` 不属于该会话时返回 404。对话右侧栏的「工单进度」标签和对话顶部的「查看工单」按钮用它读取本对话的运行。
- 新增 owner-only `GET /api/ticket-dag.models`，返回 `{ providers: [{ id, name, models: [{ id, name, efforts: [{ id, name }], defaultEffort }] }], failures: [providerId] }`。数据来自宿主 `llm.listProviders`、`listModels`、`resolveModelInfo`；只读，不改变任何会话的模型。读取失败的 provider 列入 `failures`。

## 启动前确认

- 配置 `requireApproval`（布尔，默认 `true`，实时生效于之后的 `dag_run`）。开启时新运行以 `mode: 'staged'` 建立；`run.mode` 的 SQL 约束增加 `staged`，只有新建的运行库会用到它。
- `staged` 运行不派工。`setMode` 不能把它改成 `active` 或 `paused`（队长的 `dag_resume` 报错、`dag_pause` 无效），只能取消；`hold` 只记录诊断，保持 `staged`。
- `RunStore.approve(tickets)`：须按原顺序列出全部工单，否则抛错；仅在 `staged` 时把每张工单的 `agent`/`agentSpec` 写入工单定义与运行清单、置为 `active`、写一条需要通知队长的 `run_approved` 事件，返回 `true`。
- `Coordinator.approve(file, choices)`：`choices` 为 `{ id, agent, provider, model, reasoningEffort }`；预设按当前配置解析出角色说明，模型三项取用户选择；未列出的工单保持原计划。`Coordinator.discard(file)` 取消待确认的运行。
- 新增 owner-only `POST /api/ticket-dag.approve`，body `{ key, action: 'approve' | 'discard', choices? }`。未知 key 返回 404；运行未被本宿主接管或状态不对返回 409；格式错误返回 400。
- 待确认运行的看板快照附带 `presets`（当前预设的 ID、简介与模型），工单行附带 `route`（计划中的 provider/model/reasoningEffort），供审查面板预填。

## 回归测试

| 行为 | 测试 |
| --- | --- |
| 预设校验、冻结、旧清单不变 | `test/store.test.mjs` |
| 派工透传与提示词、运行中改配置不影响本轮 | `test/coordinator.test.mjs` |
| 默认预设、`agentOptions` 透传 | `test/host.test.mjs` |
| 模型目录路由、冷历史字段 | `test/dashboard.test.mjs` |
| 看板显示、配置页下拉、内置预设副本一致 | `test/client-board.test.mjs` |
| 待确认状态、审批冻结、放弃、队长不能绕过 | `test/store.test.mjs`、`test/coordinator.test.mjs` |
| 审批路由、审查面板、审批开关 | `test/dashboard.test.mjs`、`test/client-board.test.mjs` |
