# SPEC 变更：预设 Agent 与模型目录

相对交接包 `refs\handoff\dsh-ticket-dag-0.2.0\docs\SPEC.md`（只读，未修改）的增量。覆盖 0.3.0–0.9.2，以及尚未发布的工作树清理与追加工单；按版本的条目见 `CHANGELOG.md`。

## 范围变化

PRD 把“运行前在看板上审批清单”和“按工单切换模型”列为非目标。0.3.0 起工单可经预设指定模型，0.5.0 起这两项已纳入范围：启动前确认（见下文）让用户在派工前逐工单选择负责人、模型与推理强度，批准或放弃整份计划。审查面板仍不能修改工单内容、依赖或验收项。

## 配置

`agents`：`{ [id]: { name, description, instructions, provider, model, reasoningEffort, maxConcurrent } }`，`maxConcurrent` 为 0–32 的整数（0 表示不单独限制），其余字段为字符串。`name` 是显示名（0.7.0 起），内置值为 架构 / 修复 / 实现者 / 前端 / 文书 / 验收员；只用于界面，不进入清单或 `agentSpec`。默认值为 `src/agents.mjs` 的 `architect`、`debugger`、`implementer`、`frontend`、`scribe`、`verifier`（0.18.0 起；之前为 `implementer`、`test-writer`、`docs`、`frontend`、`verifier`、`merger`）。profile 保存后以保存值为准，不与内置值合并。空的 `provider`、`model`、`reasoningEffort` 表示使用宿主默认。

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
- `GET /api/ticket-dag.dashboard` 接受可选的 `parent`（队长会话 ID，`[A-Za-z0-9_.:-]{1,200}`，最多一个），只返回该会话发起的运行；`key` 不属于该会话时返回 404。对话右侧栏的运行标签和对话顶部的「查看工单」按钮用它读取本对话的运行。
- 运行摘要带 `attached`：该运行是否已被本宿主的协调器接管。未接管的运行从只读 SQLite 读取，审批接口对它返回 409。
- 选中运行的快照（`selected`）在所有状态下都带：
  - `captain`：`{ provider, model }`，取队长会话当前的模型路由；队长会话未加载或没有模型时为 `null`（0.6.0）。
  - `presets`：当前配置中每个预设的 `{ id, name, description, provider, model, reasoningEffort }`。待确认时供审查面板预填；其他状态只用来把已冻结的 `agent` 换成显示名（`name` 自 0.7.0，非待确认状态也带 `presets` 自本轮修复）。
  - 工单行的 `route`：计划中的 `{ provider, model, reasoningEffort }`，供审查面板预填。
- 新增 owner-only `GET /api/ticket-dag.models`，返回 `{ providers: [{ id, name, models: [{ id, name, efforts: [{ id, name }], defaultEffort }] }], failures: [providerId] }`。数据来自宿主 `llm.listProviders`、`listModels`、`resolveModelInfo`；只读，不改变任何会话的模型。读取失败的 provider 列入 `failures`。

## 右侧栏标签与轮询

- 每轮运行一个右侧栏标签（0.8.0），资源地址 `dsh-resource://ticket-dag/<key>/<runId>`，标题「工单 · <runId>」，只显示这一轮；再次打开同一轮切回已有标签。对话顶部的「查看工单」只在本对话有运行时出现，打开最新一轮的标签；新的一轮开始时自动打开它自己的标签。原来的运行选择器和单一的「工单进度」标签已移除。
- 显示名：负责人按 `presets[].name` → 内置预设的中文名 → 预设 ID 的顺序取名，未指定预设显示「默认成员」。审查面板与进度看板（工单行、依赖图节点、详情卡、节点提示）共用这一规则，并用成员颜色标出。
- 轮询（本轮修复）：看板与顶部入口共用一个轮询器，同一时刻只有一个请求。打开的标签每 2 秒读一次，顶部入口每 5 秒；运行已全部集成或已取消后改为每 30 秒。`document.visibilityState === 'hidden'` 时不读，重新可见时立即读一次。读取失败保留上一份快照并提示「数据可能已过期」，按 `base × 2^失败次数` 退避，最长 30 秒；固定的运行返回 404 时停止轮询。
- 无障碍：当前阶段步骤和审查步骤带 `aria-current="step"`，依赖图节点在 `aria-label` 中写出状态，审查面板的依赖图节点可用键盘聚焦。

## 启动前确认

- 配置 `requireApproval`（布尔，默认 `true`，实时生效于之后的 `dag_run`）。开启时新运行以 `mode: 'staged'` 建立；`run.mode` 的 SQL 约束增加 `staged`，只有新建的运行库会用到它。
- `staged` 运行不派工。`setMode` 不能把它改成 `active` 或 `paused`（队长的 `dag_resume` 报错并提示去右侧栏「工单 · <runId>」标签批准，`dag_pause` 无效），只能取消；`hold` 只记录诊断，保持 `staged`。
- `RunStore.approve(tickets)`：须按原顺序列出全部工单，否则抛错；仅在 `staged` 时把每张工单的 `agent`/`agentSpec` 写入**工单定义**、置为 `active`、写一条需要通知队长的 `run_approved` 事件，返回 `true`。
- 审批结果与原清单分开存储（本轮修复）：`run.manifest` 保持 `dag_run` 提交并规范化后的计划，不写入批准结果，因此批准后用原清单重新 `dag_run` 仍是幂等的，`policyHash` 也不变。派工、快照和看板读取工单定义中的批准结果。0.5.0–0.8.0 曾把选择同时写进 `run.manifest`；批准结果与原计划不同时，批准后重新提交同一清单会被当作不同清单拒绝。
- `Coordinator.approve(file, choices)`：`choices` 为 `{ id, agent, provider, model, reasoningEffort }`。冻结时点：`agent` 按**批准时**的当前配置解析出角色说明；`provider`/`model`/`reasoningEffort` 取用户选择；计划中的预设若已从配置删除，沿用 `dag_run` 时冻结的 `agentSpec`（本轮修复）；未列出的工单保持原计划；有 provider 或推理强度而无模型时拒绝。`Coordinator.discard(file)` 取消待确认的运行。

### 审批接口

owner-only `POST /api/ticket-dag.approve`，body `{ key, action: 'approve' | 'discard', choices? }`，`key` 为 64 位十六进制，body 不超过 256 KiB。按以下顺序检查（请求头检查为本轮修复）：

| 状态码 | 条件 |
| --- | --- |
| 415 | `Content-Type` 不是 `application/json` |
| 403 | 缺少请求头 `x-dsh-ticket-dag: 1`；或带了 `Origin` 但与请求的 `Host` 不同源 |
| 400 | body 不是 JSON 或超长；`key`/`action` 格式不对；`approve` 缺少 `choices` 数组；某项 choice 不是对象、字段不是文本或超过 200 字符；所选模型不在模型目录、provider 未知或推理强度不是该模型支持的选项 |
| 503 | 选了具体模型但模型目录不可用，无法校验（选宿主默认不受影响） |
| 404 | `key` 不对应已知运行 |
| 409 | 运行未被本宿主接管（`attached` 为假）；运行不在 `staged`；账本校验失败或批准过程报错 |
| 200 | 返回批准或放弃后的运行快照 |

跨站表单无法设置自定义请求头或 JSON 类型而不触发 CORS 预检，`Origin` 检查再挡住声明了其他来源的浏览器请求。

### 账本防篡改（本轮修复）

- 协调器在内存中保存每轮运行的摘要：`mode`、`plan`（运行行与原清单的哈希）、`approval`（工单定义与依赖边的哈希），以及是否已批准。打开运行时从账本取得，本进程批准、暂停或改状态后更新。
- 派工前、验收前和发布前，以及 `dag_resume`、批准时，比对 SQLite 账本与摘要。不一致时暂停该轮并通知队长；从未批准的运行（例如账本里被改成 `active`）退回 `staged`。
- 局限：从磁盘加载的运行以加载时的账本为准，协调器未运行期间的修改无法察觉，非 `staged` 的运行视为已批准。能写账本的本地进程同样能改 Git 与 worktree，这不是权限边界，只防止误改或越过审批开工。

## 工作树清理（未发布）

- 配置 `autoCleanup`（布尔，默认 `true`，实时生效）。新增队长工具 `dag_cleanup({ runId })`，返回运行快照加每张工单的 `results: [{ id, status, reason? }]`。
- 自动清理的时机：全部工单为 `INTEGRATED`、至少一张工单尚无清理结果、没有待投递的通知，且账本中已有 `run_completed` 事件。通知投递成功后唤醒该轮，重新判断是否到期。`dag_cleanup` 不看这些条件，可用于已结束的运行。
- 范围：`cancelled` 运行的所有工单、非 `INTEGRATED` 的工单一律跳过；只处理账本中该工单的 `path` 与 `branch`。已 `cleaned` 的工单不再处理；`skipped` 的工单自动清理不重试，`dag_cleanup` 会重试。
- `git.cleanupWorktree(repo, { path, branch, target, baseRef, root })` 的保护：
  - 拒绝（抛错，记为 `skipped`，原因前缀 `refused:`）：分支等于集成分支或 `baseRef` 指向的本地分支；路径不在插件 worktree 根目录内；路径是主 worktree；该路径检出的是别的分支；该分支在另一 worktree 中检出。
  - 跳过（返回原因）：工单分支不是集成分支的祖先；worktree 有 tracked 改动、untracked 或 ignored 文件（原因列出类别和文件名，每类最多 5 个）；路径存在但不是已登记的 worktree。
  - 删除：`git worktree remove`、以集成分支为上游的 `git branch -d`、`git worktree prune`，均不强制。集成分支永不删除。
- 账本：`tickets` 新增 `cleanup`（`cleaned` | `skipped` | NULL）与 `cleanupReason` 列，打开旧账本时补列，NULL 视为未清理。`RunStore.recordCleanup(id, status, reason)` 只写 `INTEGRATED` 且未 `cleaned` 的工单，并记 `cleanup_cleaned` / `cleanup_skipped` 事件。
- 快照：运行带 `cleanup: { cleaned, skipped }`，工单行带 `cleanup` 与 `cleanupReason`；冷历史缺列时读为 `null`。看板阶段条末尾新增“清理”步（`done` / `skipped` / `todo`），运行概况显示“已清理 N 张 / 跳过 M 张（原因）”。

## 追加工单（未发布）

- 配置 `maxAppendedTickets`（非负整数，默认 20，实时生效）。新增队长工具 `dag_add({ runId, tickets })`，`tickets` 为工单数组或其 JSON 字符串，返回运行快照。
- 规范化：`normalizeAppend` 对每张工单使用与清单相同的规则；验收 ID 在当前配置与本轮冻结命令的并集中查找。`RunStore.append` 拒绝与本轮已有工单（不区分大小写）重复的 ID，并对“已有工单 + 本批”整体检查依赖、环与产物关系（`external_inputs` 取原清单）。
- 幂等：与此前某一批逐项相同（忽略解析出的 `agentSpec`）时返回该批结果，`added: false`；同一 ID 换了内容再追加被拒绝。`cancelled` 运行拒绝追加。累计追加数超过 `maxAppendedTickets` 时拒绝并提示另开 `dag_run`。
- 审批：`dag_add` 不需要用户批准，追加的工单以 `PENDING` 进入调度，仍经过试合并、验收和集成。`staged` 运行把它们并入待审查的计划，`RunStore.approve` 与 `Coordinator.approve` 按 `plan()` 列出全部工单。已批准的运行中，追加工单的 `agent` 若与批准时已在计划中的某张工单相同，沿用其 `provider`/`model`/`reasoningEffort`，角色说明按当前配置解析；否则按当前配置解析。
- 验收命令：本轮已冻结的验收 ID 沿用冻结命令，新 ID 按当前配置冻结。每批记录自己的 `policyHash`，`_checkPolicy` 同时核对原清单与每一批。
- 已批准范围：审查面板列出清单的全部 `checks`，批准时把这些 ID 写进 `run_approved` 事件的 `details.planChecks`，该记录纳入账本摘要的 `approval` 部分。批准后追加工单可以首次引用其中的命令。旧账本的批准事件没有这条记录，没有工单用过的清单命令不算已批准：快照的 `unapprovedChecks` 列出它们，`checks` 不含它们，`dag_add` 引用时拒绝。已被工单用过的命令照常恢复。
- 已完成的运行：追加后存在非 `INTEGRATED` 工单，运行重新派工；新工单全部集成时再写一条 `run_completed` 并通知队长，随后自动清理只处理尚无清理结果的新工单。
- 快照：工单行带 `appended` 与 `appendedAt`；看板与审查面板为追加工单显示“追加”标记，悬停显示追加时间。

### 清单语义变化

此前运行的工单集合等于 `dag_run` 时规范化并冻结的清单（`run.manifest`），之后只有批准会改写工单定义。现在运行的工单集合是**原清单 + 追加记录**：

- `run.manifest` 仍保持 `dag_run` 提交时的样子，不写入追加的工单，因此用原清单重新 `dag_run` 仍幂等，原清单的 `policyHash` 不变。
- 追加的工单另存于新表 `appended`（`ticketId`、`batch`、`definition`、`policyHash`、`createdAt`），同时插入 `tickets` 与 `dependencies`。`RunStore.plan()` 返回原清单工单加各批追加工单，`RunStore.appended()` 按批返回追加记录。
- 账本防篡改摘要的 `approval` 部分加入 `appended` 表的全部字段；协调器自己追加后以新账本为可信状态。冷启动时从原清单加各批追加工单恢复验收命令。

## 其他修复（本轮）

- Windows 验收命令：`argv[0]` 经 `PATH`/`PATHEXT` 解析为 `.cmd`/`.bat` 时，经 `cmd.exe /d /s /v:off /c` 执行，每个参数加双引号；参数含 `"`、`%`、`!`、`^`、`&`、`|`、`<`、`>`、CR、LF 时拒绝。超时、取消或输出超限时终止整棵进程树：Windows `taskkill /T /F`，POSIX 用独立进程组并 `kill(-pid)`。
- 仓库身份检查缓存：对已持久化仓库的每次 `git()` 不再额外运行 `rev-parse --git-common-dir`。通过的检查仅在 checkout 目录、其 `.git` 条目和 `commondir` 重定向仍是未修改的同一文件系统对象时复用；并发调用共享一次检查，失败不缓存。
- 关闭协调器时逐轮关闭账本与所有者锁并汇总报错，一轮失败不会让其他轮保持锁定。后台 worker 与集成任务的 Promise 在记录失败本身出错时也暂停该轮，不产生未处理的 rejection。
- 测试在 win32 上把时限放大 3 倍。

## 回归测试

| 行为 | 测试 |
| --- | --- |
| 预设校验、冻结、旧清单不变 | `test/store.test.mjs` |
| 派工透传与提示词、运行中改配置不影响本轮、预设并发上限 | `test/coordinator.test.mjs` |
| 默认预设、`agentOptions` 透传 | `test/host.test.mjs` |
| 模型目录路由、冷历史字段 | `test/dashboard.test.mjs` |
| 看板显示、配置页下拉、内置预设副本一致 | `test/client-board.test.mjs` |
| 待确认状态、审批冻结、放弃、队长不能绕过 | `test/store.test.mjs`、`test/coordinator.test.mjs` |
| 批准后原清单不变、重新提交幂等（含重新打开账本）、按批准的模型派工 | `test/store.test.mjs`、`test/coordinator.test.mjs` |
| 已删除的计划预设仍可按冻结副本批准 | `test/coordinator.test.mjs` |
| 账本被改为 `active` 或改了 `verify` 时暂停且不集成 | `test/coordinator.test.mjs` |
| 审批路由：请求头、同源、模型与推理强度校验、目录不可用、只批准已接管的待确认运行 | `test/dashboard.test.mjs` |
| 审查面板、审批开关、批量改模型、显示名与内置中文名兜底 | `test/client-board.test.mjs` |
| 所有状态的快照带 `presets`，进度看板显示成员名 | `test/dashboard.test.mjs`、`test/client-board.test.mjs` |
| 每轮一个标签、「查看工单」入口 | `test/client-board.test.mjs` |
| 轮询：失败保留快照并退避、404 停止、完成后 30 秒、页面隐藏暂停 | `test/client-board.test.mjs` |
| `.cmd` 经 cmd.exe 执行且不注入（仅 win32）、超时与取消终止进程树 | `test/git.test.mjs` |
| 身份检查缓存后换成另一个 clone 仍被拒绝 | `test/git.test.mjs` |
| 关闭时一轮失败不影响其他轮、记录失败出错时暂停 | `test/coordinator.test.mjs` |
| 8 个队长工具；`dag_cleanup`、`dag_add` 仅限队长，`autoCleanup` 默认开启，`maxAppendedTickets` 默认 20 | `test/host.test.mjs` |
| 清理只删已合入且干净的工单 worktree 与分支，集成分支和 main 保留提交；拒绝集成分支、base 分支、他处检出与根目录外路径；源码中不强制删除 | `test/git.test.mjs` |
| 清理结果只记录在已集成工单上，旧账本读为未清理（含冷历史） | `test/store.test.mjs`、`test/dashboard.test.mjs` |
| 运行完成且通知队长后自动清理、`dag_cleanup` 幂等；`autoCleanup` 关闭时不删、开启后补做；有改动的 worktree 带原因跳过；取消的运行不清理 | `test/coordinator.test.mjs` |
| 阶段条的清理步、运行概况的清理计数 | `test/client-board.test.mjs` |
| 追加工单遵循清单规则、可依赖本轮或同批工单、原清单不变；待确认运行的追加工单并入审批计划 | `test/store.test.mjs`、`test/coordinator.test.mjs` |
| `dag_add` 无需再批准即派工、沿用已批准成员的模型、受上限约束；已完成运行被重开后再次通知并只清理新工单 | `test/coordinator.test.mjs` |
| 看板与审查面板的“追加”标记与悬停时间 | `test/client-board.test.mjs` |
| 全部清单命令经看板与审批路由可见、批准后首次引用、重开账本与幂等、同名配置不能替换已批准命令 | `test/coordinator.test.mjs` |
| 旧批准不推定未展示的命令、已用命令照常恢复、伪造批准记录被暂停 | `test/coordinator-recovery.test.mjs` |
| 未引用命令的标注、参数边界与控制字符的转义显示；冷读待确认计划的命令 | `test/client-board.test.mjs`、`test/dashboard.test.mjs` |
