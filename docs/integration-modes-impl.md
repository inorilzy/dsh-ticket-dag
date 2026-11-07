# 集成模式实现记录

方案见 `docs/integration-modes-plan.md`。本文记录已经实现的部分，按阶段累积更新。

## 阶段 F：公共基础 + 按改动文件选测试

基线 `91f198e`（0.15.2），分支 `modes/f`。

### 已实现

**公共基础（后续阶段共用）**

- profile 配置（`src/index.mjs` 的 `Config` 与 `settings()`，`Coordinator` 构造参数与 `updateSettings`）：
  - `integrationMode`：`each | end | worker | worker-end | train`，默认 `each`。取值一次定好；本版本只实现 `each`，其他取值在 `normalizeManifest` 中报 `integration mode X is not implemented in this build`（`dag_run` 失败，不建运行）。可实现的集合是 `src/store.mjs` 的 `IMPLEMENTED_MODES`。
  - `selectChecksByFiles`：默认 `false`。
  - `checkMeta`：`{ <checkId>: { files: glob[], fast: bool } }`，默认 `{}`。
  - `trainSize`、`maxFinalRepairs` 留给 B、A 阶段（均已实现，见各阶段一节）。
- 清单字段（`normalizeManifest(input, checkRegistry, agentRegistry, defaults)`，第 4 个参数是 profile 的上述三项）：
  - `integration: { mode, select_checks_by_files }`（也接受 camelCase）→ 规范化为 `integration: { mode, selectChecksByFiles }`，清单优先，缺省取 profile；只有 mode ≠ each 或 selectChecksByFiles 为真时才写入。
  - `check_meta`（也接受 `checkMeta`）→ `checkMeta`：只保留工单 `verify` 用到的 ID；profile 打底、清单逐字段覆盖；`files` 必须是不重复的非空字符串数组，`fast` 必须是布尔；清单里写了没用到或不存在的 ID 报错，profile 里的忽略；条目只在 `files` 非空或 `fast` 为真时写入，整个字段非空才写入。
  - 默认设置下规范化结果与 0.15.2 逐字节相同（测试 `test/integration-settings.test.mjs` 断言）。
  - 运行行为只读冻结在 `meta.manifest` 里的值：`integrationOf(manifest)` 返回 `{ mode, selectChecksByFiles }`（缺省 each/false），`manifest.checkMeta` 是冻结的元数据；`dag_add` 追加的工单用同一份，没有元数据的 ID 视为“无 files（总是运行）、非 fast”。
- 可见性：`_snapshot` 与看板只读路径（`readLedger`）都带 `integration`；`src/client.js` 在运行概况和计划审查各显示一行“集成模式：each 每张完整验收（按文件选测试：开/关）”（`data-dag-integration`）。完整配置页加了“集成模式（实验）”下拉（未实现的模式列出但禁用）和“按改动文件选验收命令”开关；`checkMeta` 只能在配置文件里编辑（schema 有，表单不提供，避免一个嵌套编辑器）。`captainSection` 在非默认设置时多一句说明。README 设置表与“集成模式（实验）”一节已更新。

**F：按改动文件选测试**

- `src/selection.mjs`（纯函数）：
  - `globToRegExp(glob)`：支持 `**`、`*`、`?`、`{a,b}`（可嵌套），分隔符 `/`；`**/` 也匹配零层目录；不带 `/` 的 glob 只匹配根目录。没有用 `path.matchesGlob`（Node 22 上有实验特性告警）。
  - `selectChecks(checkIds, checkMeta, changedFiles)` → `{ run, skipped, fallback }`：changedFiles 为 null 或空 → 全部运行，`fallback: 'no-diff'`；无 files 的 check 总是运行；声明了 files 的 check 只在有改动文件匹配时运行；所有 check 都声明了 files 且有改动文件无人认领 → 全部运行，`fallback: 'unclaimed:<file>'`；保持原顺序。
- `src/git.mjs`：`changedFiles(repo, fromSha, toSha)` = `git diff --name-only --no-renames -z from to --`。
- `src/coordinator.mjs`：新方法 `_selectChecks(run, ticketId|null, stage, checkIds, fromSha, toSha)`。冻结配置未开启时原样返回 checkIds、不写任何事件；开启时求 diff（出错为 null）、调用 `selectChecks`、写 `checks_selected` 事件、返回要跑的 ID。`_integrate` 在 `buildCandidate` 之后用 `(tip, candidate)` 调用它，只跑返回的命令，`recordVerifyStart` 记录实际要跑的 ID。
- `src/store.mjs`：`recordSelection(id|null, details)`（事件 `checks_selected`，details `{ stage, run, skipped, fallback, changed }`，不通知队长）；`recordCheck` 接受 `id` 为 null（运行级）和可选 `stage`（`lane` 为默认且不写入 details，保持旧事件形状）。

**计时与报告**

- `src/timing.mjs` 的 `runTiming`：运行级 `check_finished`（ticketId 为 null）计入 `checkRuns`、`checkFailures`，并在 verifyMs 可知时计入 `verifyMs`（不归属任何工单）；新 totals `skippedChecks`、`finalVerifyMs`（stage 为 final 或 bisect）、`workerVerifyMs`（stage 为 worker），旧账本都是 0。
- `benchmarks/report.mjs`：从账本 `run.manifest` 读出实际模式（`each`、`each+F`…），写进每轮 JSON（`runs[].integration`、`runs[].mode`、`trial.mode`）、分组（`mode`、`modes`、`warnings`）和表格“实际模式”列；同一 label 下实际模式不一致时在“警告”一节说明；表格加“跳过验收数”列。
- `benchmarks/profiles/each.patch.yml`、`f.patch.yml`：坦克基准用的 profile 片段（同一份 checkMeta）。

**模拟对比**：`benchmarks/simulate.mjs`、`benchmarks/simulate.test.mjs`，用法见 `benchmarks/README.md`“模拟对比”。

### 配置方法

profile（headless 写法，也可在配置页设置前两项）：

```yaml
- id: dsh-ticket-dag
  config:
    integrationMode: each
    selectChecksByFiles: true
    checkMeta:
      unit: { files: ['src/**', 'test/**'], fast: true }
      e2e: { files: ['src/**'] }
```

或在清单里：`"integration": {"select_checks_by_files": true}, "check_meta": {"e2e": {"files": ["src/**"]}}`。

### 如何验收

```
npm test
node benchmarks/simulate.mjs --slow-seconds 1
node --test test/check-selection.test.mjs test/check-selection-run.test.mjs test/integration-settings.test.mjs
```

阶段 F 完成时：`npm test` 共 276 项，269 pass，0 fail，7 skip（基线 255/248/0/7，新增 21 项）。

模拟对比（`--slow-seconds 1`，本机一次运行，数值有波动）：

| 配置 | 集成模式 | 结果 | 总耗时 | 集成排队 | 验收耗时 | 验收命令次数 | 验收失败 | 跳过验收 | 冲突 | 尝试 | 队长重试 | 逻辑错误发现于 | 定位工单 | 最终 logic-bug.txt |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| each | each | 完成 8/8 | 11.8s | 37.0s | 9.4s | 17 | 1 | 0 | 1 | 10 | 1 | lane | L | ok |
| f | each+F | 完成 8/8 | 10.7s | 34.7s | 8.4s | 16 | 1 | 1 | 1 | 10 | 1 | lane | L | ok |

F 只少跑一次 slow（工单 D 只改 docs/），其余工单都改 `src/**` 或 `logic-bug.txt`，slow 仍要跑：这份工单本来就是为后续 A/E/B 设计的，F 的收益在只改文档/局部文件的工单多时才明显。

### 与方案文档的偏差及原因

- 方案写“试合并后用 `git diff --name-only`”。实现用候选相对集成 tip 的 diff（`tip..candidate`），也就是这张工单合入后真正改变的文件；不用工单分支相对冻结基线的 diff，因为后者会包含 worker 合入集成分支带进来的别人的改动。
- `checkMeta` 在 `selectChecksByFiles` 关闭时也会冻结进清单（只要有非默认条目）：A 阶段的 fast 判定要读它，也让报告能核对。代价是：profile 配了 `checkMeta` 后，同一 runId 用原清单重新提交会因清单不同被拒绝（与预设规则一致，README 写明）。
- `checkMeta` 没有表单控件，只能写配置文件；DESIGN 允许“schema 自动生成则不用动”，本插件的配置页是自定义表单，嵌套字典编辑器成本高，先不做。
- 模拟脚本扮演队长：each 下验收失败的工单进入 NEEDS_ATTENTION，脚本调用 `dag_retry`（表中“队长重试”），worker 看到提示词里的 `Check failed` / `logic-bug` 就修复。

### 已知限制

- （阶段 F 时）只实现 `each`；阶段 A 起 `end` 放行，`worker`、`worker-end`、`train` 仍被拒绝。
- glob 不支持 `!` 取反、字符类 `[...]`（按字面处理）。
- 全量兜底只在“没有总是运行的 check”时触发：有一条无 files 的 check 时，没人认领的文件只由那条 check 覆盖，这是 DESIGN 规则 4 的原意。
- 选择只看改动路径，不看依赖关系（例如测试依赖的被改模块不在 glob 里时会漏跑），glob 写得窄就有漏测风险；需要保险时给关键 check 不写 files。

### 后续阶段可复用的接口

- 配置/清单：`INTEGRATION_MODES`、`IMPLEMENTED_MODES`（加入新模式即放行）、`integrationOf(manifest)`、`manifest.checkMeta`；`normalizeIntegration` 内加 `trainSize`、`maxFinalRepairs` 字段即可冻结。
- 选择：`selectChecks`、`globToRegExp`、`git.changedFiles`、`Coordinator#_selectChecks(run, id|null, stage, checkIds, from, to)`。
- 事件：`checks_selected {stage, run, skipped, fallback, changed}`、`check_finished` 的可选 `stage`（`lane`/`worker`/`final`/`bisect`/`train`）与 ticketId 为 null 的运行级写法：`store.recordCheck(null, { checkId, ms, ok, stage })`、`store.recordSelection(null, details)`。
- 计时：`totals.skippedChecks`、`finalVerifyMs`、`workerVerifyMs`，运行级检查已计入 `checkRuns`/`verifyMs`。
- 模拟：`benchmarks/simulate.mjs` 的 `CONFIGS` 对象（加 `a: { title, settings: { integrationMode: 'end' } }` 等）；`logicBugReport` 已识别 stage 为 final/worker/train 的失败和事件 details 中的 `culprit`、`check_requeued`；`finished()` 判定 run_completed 在最后一次 integrated 之后，适用于 end 类模式；脚本 worker 对不在工单表里的 `fix-*` 工单直接修复。

## 阶段 A：先合并、最后测（`end`）

分支 `modes/a`，在阶段 F 的未提交实现上继续。A+F（`end` + `selectChecksByFiles`）是同一份代码。

### 已实现

- **配置**：`IMPLEMENTED_MODES` 加入 `end`；新常量 `END_MODES = {end, worker-end}`（阶段 E 的 `worker-end` 复用）。profile 新增 `maxFinalRepairs`（`z.natural().max(10).default(2)`），`Coordinator` 构造参数/`updateSettings`/`start` 传入。`normalizeIntegration` 只在 end 类模式下写入 `maxFinalRepairs`（清单可写 `max_final_repairs` / `maxFinalRepairs`，0–10），所以 each 清单 JSON 不变；`maxFinalRepairsOf(manifest)` 读冻结值（缺省 2）。
- **集成通道**：`_integrate` 在 end 类模式下把累计 ID 过滤为 `checkMeta[id].fast === true` 的那些，再交给 `_selectChecks`（F 开启时按 `tip..candidate` 过滤）；没有 fast check 时 `recordVerifyStart(id, [])`、只试合并。发布用 `store.finish(..., { complete: false })`；`_reconcile` 的两处 finish 同样按模式传。
- **最终全量**：`_pump` 开头判定“end 类模式、全部 INTEGRATED、`finalVerified(tipSha)` 为假”→ 占用 `run.integration` 槽（`job.final = true`，phase `{ stage: 'final' | 'bisect', checkId, index, total, step? }`）启动 `_finalVerify`。判定只看账本，所以重启（`attach`）、`dag_resume`、修复工单集成后都会重新触发。`cancel`/`_shutdown` 原本就会 abort `run.integration` 并等待它的 promise，最终全量因此可被中止（中止不 hold、不完成）。
  - `_probeChecks(run, job, sha, ids, stage, phase)`：每次在 `run.root/probes/<sha12>-<随机 8 位>` 建 probe（新 git 辅助 `addProbe`/`releaseProbe`，私有标记 `dsh-ticket-dag-probe-v1`，与 candidate 标记分开；只删自己的、干净的、HEAD 未变的 probe，否则保留现场），逐个 ID 跑命令，`recordCheck(null, { stage })`，失败时收集输出末尾 3000 字符。
  - 全部通过 → `store.completeRun(tip)`：写 `final_verified {tipSha, checks}`，tip 未变且全部集成时写 `run_completed`（notify，details 带 `finalVerified: true`）。
  - 失败 → `_bisect`：`git.firstParentCommits(repo, baseSha, tip)`（`rev-list --first-parent --reverse`）得 M1..Mn；在 Mi 只跑“到 Mi 为止已集成工单 verify 里出现的失败 ID”，没有则视为通过；每步写 `bisect_step {sha, ok, checks}`，命令事件 stage `bisect`。culprit = `landedSha === Mi` 的工单。
  - 定位到且已用修复次数 < `maxFinalRepairs` → `store.appendRepair(ticket, { policyHash, details })`：一个事务内追加 `fix-<culprit>-<n>`（不受 `maxAppendedTickets` 限制，policyHash 用 `run.checks` 计算）并写 `final_verify_failed {tipSha, failed, culprit, culpritSha, repair}`（notify 队长）；随后像 `add()` 一样刷新 `run.trust`。修复工单 verify = culprit.verify ∪ 失败 ID，agent/agentSpec 同 culprit，prompt 含失败 ID、culprit 及其合并 SHA、输出末尾、“在当前集成分支基础上修复，不要回退其他工单”。新工单 attempt 0 从当前 tip 建工作树。
  - 定位不到或次数用完 → `recordFinal('final_verify_failed', …, { repair: null })` + `_hold`（run_blocked 通知队长，诊断写明失败 ID、tip、第一个失败合并点和工单、原因、处理建议与输出末尾）。
- **store 新方法**：`finish(id, lease, sha, { complete = true })`、`completeRun(tipSha, details)`、`finalVerified(tipSha)`、`finalRepairs()`、`appendRepair(ticket, { policyHash, details })`、`recordFinal(type, message, details)`（`final_verify_started` / `bisect_step` / 无修复的 `final_verify_failed`，不通知）。`append` 内部拆成 `#append` 以便在同一事务里复用。
- **快照/看板**：`_snapshot.complete` 在 end 类模式下还要求 `finalVerified(tipSha)`；`readLedger` 的只读路径同样判断（看 `final_verified` 事件），历史列表因此不会把“全部集成、最终全量未过”的运行显示为已完成。`_snapshot.finalPhase` 为最终全量/二分的实时 phase，dashboard 透传；`client.js` 在运行概况里显示 `data-dag-final="final|bisect"` 一行（“最终验收（全量） · slow 2/3”/“最终验收失败，二分定位出错工单 · 第 2 步 · slow 1/1”）。配置页下拉放开 `end`，显示名“A 先合并、最后测”。
- **worker 提示词**：end 类模式下“Required check IDs”说明改为“集成时只跑 fast 的、全部集成后统一跑全部，提交前自己跑”。`captainSection` 在 `end` 下多一句说明最终全量、自动修复工单与暂停条件。
- **计时**：`run_completed` 在最终全量之后才写，`runTiming` 的累计用时自然包含最终全量；`finalVerifyMs` 统计 final+bisect。
- **基准/模拟**：`benchmarks/profiles/a.patch.yml`、`af.patch.yml`；`simulate.mjs` 的 `CONFIGS` 加 `a`、`af`；`simulate.test.mjs` 断言 A/A+F 跑完 9/9（含 `fix-L-1`）、逻辑错误在 `final` 发现、定位到 `L`、最终 `logic-bug.txt` 为 ok。

### 配置方法

```yaml
- id: dsh-ticket-dag
  config:
    integrationMode: end
    selectChecksByFiles: false   # true 即 A+F
    maxFinalRepairs: 2
    checkMeta:
      unit: { files: ['src/**', 'test/**'], fast: true }
      e2e: { files: ['src/**'] }
```

或清单：`"integration": {"mode": "end", "max_final_repairs": 1}`。

### 如何验收

```
npm test
node --test test/integration-end.test.mjs
node benchmarks/simulate.mjs --slow-seconds 1
```

阶段 A 完成时：`npm test` 共 285 项，278 pass，0 fail，7 skip（阶段 F 为 276/269/0/7；新增 `test/integration-end.test.mjs` 7 项、`simulate.test.mjs` 1 项、`client-board.test.mjs` 1 项），连跑两次结果相同。

全量连跑 6 次中有 1 次 `test/coordinator.test.mjs` 的“16 concurrent worker turns”失败，原因是并行 `git worktree add` 报 `failed to read .git/worktrees/<other>/commondir`（方案文档第 1 节记录的已知偶发问题，与集成模式无关）；该用例单独连跑 6 次在 mode-a 与 mode-f 都通过。

模拟对比（`--slow-seconds 1`，本机一次运行，数值有波动）：

| 配置 | 集成模式 | 结果 | 总耗时 | 集成排队 | 验收耗时 | 验收命令次数 | 验收失败 | 跳过验收 | 冲突 | 尝试 | 队长重试 | 逻辑错误发现于 | 定位工单 | 最终 logic-bug.txt |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| each | each | 完成 8/8 | 11.8s | 41.6s | 9.4s | 17 | 1 | 0 | 1 | 10 | 1 | lane | L | ok |
| f | each+F | 完成 8/8 | 10.5s | 40.6s | 8.4s | 16 | 1 | 1 | 1 | 10 | 1 | lane | L | ok |
| a | end | 完成 9/9 | 8.1s | 6.6s | 5.4s | 16 | 2 | 0 | 1 | 10 | 0 | final | L | ok |
| af | end+F | 完成 9/9 | 8.2s | 6.8s | 5.4s | 15 | 4 | 0 | 1 | 11 | 1 | final | L | ok |

- A 的集成排队从约 41 秒降到约 7 秒：lane 不再跑 slow。验收失败数包含最终全量和二分中失败的那几步，随合并顺序变化（2–4）。
- 这份 checkMeta 里 fast 的 files 是 `**`，A+F 在 lane 上没有可跳过的；F 的收益在 A 下只剩 fast 那部分。
- 表中 af 的那一次“队长重试”来自并行 `git worktree add` 的已知偶发失败（方案文档第 1 节），与模式无关；多跑几次通常为 0。

### 与方案/设计的偏差及原因

- probe 路径为 `probes/<tip12>-<随机后缀>` 而非 `probes/<tip12>`：二分要在多个合并点各建一次，被检查弄脏而保留下来的 probe 不应阻塞下一次（`addProbe` 也能重新接管同路径的干净 probe）。
- `final_verify_failed` 在无法修复时也会写（`repair: null`，不通知），通知由随后的 `run_blocked` 负责，避免队长收到两条。
- 修复次数按 `final_verify_failed` 中 `repair` 非空的事件计，与追加在同一事务里，崩溃不会漏计。
- `appendRepair` 不经过 `dag_add` 的检查（未批准的清单 check、预设路由覆盖），修复工单只用 culprit 已有的 verify 和失败 ID，这些都已在 `run.checks` 中，不引入新命令。
- 二分只在失败的那组 ID 上做，且假设单调（基线通过、tip 失败）。若中途合并点全部通过且 tip 之前的 Mn 才失败，culprit 就是最后一张；若 Mn 不是任何工单的 landedSha（理论上不会出现），视为定位不到并 hold。

### 已知限制

- 偶发失败（flaky）会被当成真实失败：二分能定位到某张工单就会追加修复工单，否则 hold。
- 多张工单共同造成的失败只会定位到第一个失败的合并点。
- 超过 `maxFinalRepairs` 被 hold 后，`dag_resume` 会再跑一次最终全量；仍然失败会再次 hold（不再追加修复），需要队长自己 `dag_add` 修复工单。
- 最终全量期间整条集成通道被占用；它只在全部工单 INTEGRATED 时启动，所以不会挡住其他工单。
- probe 目录和 candidate 一样，在被检查弄脏时保留不删，需要手动清理。

### 给阶段 E（`worker`、`worker-end`）的接口

- 模式判定：`END_MODES`（已含 `worker-end`）与 coordinator 内的 `endMode(manifest)`；`worker-end` 加进 `IMPLEMENTED_MODES` 后，lane 的 fast 过滤、`finish({ complete:false })`、最终全量、二分、自动修复都会自动生效，不需要改。
- probe：`git.addProbe(repo, path, sha)` / `git.releaseProbe(repo, path, sha)`（同路径同 SHA 可重入，只删自己的干净 probe）。worker 侧验收可直接用 `Coordinator#_probeChecks(run, job, sourceSha, ids, 'worker')`：它负责建/删 probe、逐条 `recordCheck(null, { stage })`、更新 `job.phase`、返回 `{ failed, output }`，abort 时抛错。注意它的 `recordCheck` 写 ticketId null；worker 侧若要计入工单，需要加一个 ticketId 参数（目前未加，避免无用参数）。
- 最终全量入口：`_pump` 开头的判定 + `_finalVerify(run, tip, job)`；`_bisect(run, job, tip, failed, tickets)` 可被 B 的列车二分参考（规则相同，但 B 在候选合并链上二分，不在已发布的 first-parent 上）。
- `git.firstParentCommits(repo, base, tip)`。
- store：`completeRun`、`finalVerified`、`finalRepairs`、`appendRepair`、`recordFinal`；`finish` 的 `complete` 选项。
- 看板：`_snapshot.finalPhase`（`stage` 为 `final`/`bisect`），client 的 `finalText` 可以加 `worker` 等阶段名。

## 阶段 E：验收在 worker 侧（`worker`、`worker-end`）

分支 `modes/e`，在阶段 F、A 的未提交实现上继续。`worker-end` + `selectChecksByFiles` 即 A+E+F，是同一份代码（见下文单独一节）。

### 已实现

- **配置**：`IMPLEMENTED_MODES` 加入 `worker`、`worker-end`；新常量 `WORKER_MODES = {worker, worker-end}`。`worker-end` 原本就在 `END_MODES` 里，所以 lane 只跑 fast、`finish({ complete:false })`、最终全量、二分、自动修复、看板最终验收进度都直接生效。`worker` 不冻结 `maxFinalRepairs`（不是 end 类）。
- **“worker 侧”的含义（与方案字面的偏差）**：不是采信 worker（LLM）自报的测试结果——README 规定 worker 自己报告的结果不算数，这一条不变。“worker 侧”指**插件**在 worker 提交的那个 sourceSha 上、**离开串行集成通道**并行跑验收。
- **worker 侧验收**（`Coordinator#_workerVerify`）：
  - `_pump` 在 worker 类模式下，为“当前 sourceSha 还没有 worker 侧结果、也没在跑”的 SUBMITTED 工单启动它，记在 `run.verifying`（Map，按工单 ID），同时最多 `run.limit` 个；不计入 `activeCount`/`run.work`，不占 worker 名额。
  - 读 `meta.tipSha` 与已集成工单（同一时刻），累计 check = 本工单 verify ∪ 已集成工单 verify。`coveredTip` = tip（若 tip 是 sourceSha 的祖先）否则 null。开启 F 时 `_selectChecks(run, id, 'worker', ids, coveredTip ?? baseSha, sourceSha)`。
  - 用 `_probeChecks(run, job, sourceSha, ids, 'worker', {}, ticketId)` 在 probe 里跑（`_probeChecks` 新增第 7 个参数 `ticketId`，默认 null；worker 侧的 `check_finished` 因此记在工单上，计时把耗时计入该工单的 verifyMs 和 `totals.workerVerifyMs`）。
  - 结果事件 `worker_verify_finished {sourceSha, coveredTip, ok, checks, failed, output}`（output 为失败输出末尾 ≤3000 字符）。写之前在 serial 里确认工单仍是同一 lease/sourceSha、运行仍 active，否则丢弃结果。
  - 结果只从账本推导：`store.workerVerify(id, sourceSha)`、`store.workerResults()`（每张工单最新一条，不含 output）。重启后已记录的结果直接复用，不重跑；没记录（中途被关）的会重跑。
  - 失败 → `_workerFailed`：`store.requeueCheckFailure(id, lease, { message, maxRetries: maxConflictRetries })`（事件 `check_requeued {oldLease, checkRetries}`，与 `conflict_requeued` 分开计数），工单回 PENDING，同一工作树、attempt+1，提示词走 recovery 分支，诊断写明失败的 check、“插件跑的，自报不算”、要求合入最新集成分支后再提交、以及输出末尾。超过上限 → NEEDS_ATTENTION（通知队长）。若崩溃发生在“结果已写、退回未做”之间，下一次 `_pump` 看到 ok=false 的结果会补做退回。
  - probe 建不起来（`git worktree add` 失败，常见为并行 add 的已知 commondir 偶发错误）不算对提交的判定：`run.probeRetry` 记下次数，延迟 300/600/900 ms 重试最多 3 次（仅内存，重启后从 0 计）；仍失败或其他异常 → 该工单 NEEDS_ATTENTION（诊断 `Worker-side checks could not run: …`），不 hold 整个运行。
  - `cancel` 与 `_shutdown` 一并 abort 并等待 `run.verifying` 中的任务。
- **集成通道**：`_pump` 只把“worker 侧对当前 sourceSha 已通过”的 SUBMITTED 工单交给 lane。lane 中：
  - `worker-end`：同 A，只跑 fast（F 过滤 tip..candidate），从不补跑。
  - `worker`：`coveredTip === 当前 tip` → 只跑 fast；否则写 `reverify {reason: 'tip-moved' | 'not-covered', coveredTip, tipSha, checks}`，跑全部累计 check（F 开启时按 tip..candidate 过滤）。`not-covered` 是 worker 提交时就没包含当时的 tip（没按提示合入集成分支）。
- **提示词**：worker 类模式下 “Required check IDs” 后说明插件会在你提交后立即在你的提交上跑这些 check（`worker` 补一句集成分支前进时集成时再跑；`worker-end` 补一句全部集成后再跑一次），并要求提交前合入最新集成分支 `integration/<runId>`。`captainSection` 对两种模式各加一句说明。
- **计时**：`check_requeued` 加入 `SETTLES_TICKET`（结束排队段）；worker 侧命令计入工单 verifyMs 和 `workerVerifyMs`。注意 worker 侧验收发生在 `verify_started` 之前，所以该工单的 queueMs 包含 worker 侧验收的时间（排队 = 提交到进入集成通道）。
- **看板**：`_snapshot.tickets[].workerVerify`（`{sourceSha, coveredTip, ok, failed}` 或 null），SUBMITTED 工单在 worker 侧验收中时 `livePhase = {stage: 'worker', checkId, index, total}`；只读路径 `readLedger` 通过共享的 `latestWorkerResults(db)` 给出同样的 `workerVerify`。`client.js`：配置页下拉放开两种模式，显示名“E 验收在 worker 侧”“A+E 验收在 worker 侧、最后全量”；工单行多一行 `data-dag-worker-verify="running|failed|passed"`（“worker 侧验收中 · slow 1/2”/“worker 侧验收失败：slow”/“worker 侧验收已通过，等待集成”），依赖图节点的阶段文字同样显示，worker 侧验收中的工单色调为进行中。失败行在工单退回 worker 重做期间和进入“需要处理”后都显示；提交了新 commit 后不再显示旧失败。
- **基准/模拟**：`benchmarks/profiles/e.patch.yml`、`aef.patch.yml`；`simulate.mjs` 的 `CONFIGS` 加 `e`、`aef`，脚本 worker 认 `Worker-side checks failed` 的提示词并修复；结果 JSON 多一项 `reverifies`。`simulate.test.mjs` 断言 e/aef 跑完、逻辑错误在 `worker` 或 `final` 发现、定位到 `L`。

### 配置方法

```yaml
- id: dsh-ticket-dag
  config:
    integrationMode: worker      # 或 worker-end
    selectChecksByFiles: false
    maxConflictRetries: 2        # worker 侧验收失败的自动退回上限（与冲突退回分开计数）
    checkMeta:
      unit: { files: ['src/**', 'test/**'], fast: true }
      e2e: { files: ['src/**'] }
```

或清单：`"integration": {"mode": "worker"}`。

### 如何验收

```
npm test
node --test test/integration-worker.test.mjs
node benchmarks/simulate.mjs --slow-seconds 1
```

阶段 E 完成时：`npm test` 共 298 项，291 pass，0 fail，7 skip（阶段 A 为 285/278/0/7；新增 `test/integration-worker.test.mjs` 9 项、`client-board.test.mjs` 2 项、`integration-settings.test.mjs` 1 项、`simulate.test.mjs` 1 项），连跑两次结果相同。阶段开始时的基线一次为 285/277/1/7，失败的是已知的“16 concurrent worker turns”（并行 `git worktree add` 的 commondir 偶发错误），单独重跑通过。为适应模式放行，改了 3 处原有断言：`integration-settings` 与 `check-selection-run` 中“未实现模式被拒”改用 `train`；`client-board` 下拉中 worker/worker-end 由禁用改为可选。

模拟对比（`--slow-seconds 1`，本机一次运行，数值有波动）：

| 配置 | 集成模式 | 结果 | 总耗时 | 集成排队 | 验收耗时 | 验收命令次数 | 验收失败 | 跳过验收 | 冲突 | 尝试 | 队长重试 | 逻辑错误发现于 | 定位工单 | 最终 logic-bug.txt |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| each | each | 完成 8/8 | 11.7s | 35.8s | 9.4s | 17 | 1 | 0 | 1 | 10 | 1 | lane | L | ok |
| f | each+F | 完成 8/8 | 10.6s | 41.2s | 8.4s | 16 | 1 | 1 | 1 | 10 | 1 | lane | L | ok |
| a | end | 完成 9/9 | 8.2s | 6.8s | 5.4s | 16 | 2 | 0 | 1 | 10 | 0 | final | L | ok |
| af | end+F | 完成 9/9 | 8.2s | 6.9s | 5.4s | 16 | 2 | 0 | 1 | 10 | 0 | final | L | ok |
| e | worker | 完成 8/8 | 10.6s | 36.3s | 17.9s | 33 | 1 | 0 | 1 | 10 | 0 | worker | L | ok |
| aef | worker-end+F | 完成 8/8 | 4.6s | 15.9s | 10.7s | 27 | 1 | 1 | 1 | 10 | 0 | worker | L | ok |

- E：L 的错误在 worker 侧被发现并退回 L 自己（不追加修复工单，队长重试 0），但集成分支一直在前进，几乎每张都 `reverify` 补跑 slow，总耗时与 each 相当、命令次数翻倍。集成排队包含 worker 侧验收时间（见“已知限制”）。
- A+E+F：lane 从不跑 slow，错误仍在 worker 侧就被发现，总耗时最短；代价是每张工单在 worker 侧多跑一遍累计验收（命令次数 27），这些在 probe 里并行，不占集成通道。

`test/integration-worker.test.mjs` 覆盖：worker 侧失败退回原工单（同一工作树、提示词带失败 check 与输出末尾）并在修复后通过；超过上限进入 NEEDS_ATTENTION 且 lane 从未接收；coveredTip 等于 tip 时 lane 只跑 fast、tip 前进/未覆盖时写 `reverify` 并补跑 slow；F 按 diff 过滤 worker 侧 check；worker-end 的逻辑错误在 worker 侧被发现、lane 只跑 fast、最终全量通过完成运行；A+E+F 下 worker 侧因 F 跳过的错误由最终全量发现、定位到 L 并自动修复；多张工单的 worker 侧验收并行且不超过 run.limit、期间 lane 不接收；重启后复用已记录的 worker 侧结果；清单冻结。

### 与方案/设计的偏差及原因

- `run.limit` 同时约束 worker 和 worker 侧验收，两者各自计数，所以最多可能有 2×limit 个进程（worker 子会话 + probe 中的 check）。DESIGN 要求“独立于 worker 名额计数”，这是有意的：worker 侧验收在等待集成，不应挤掉新 worker。
- `worker` 模式 lane 跳过慢 check 的条件严格为 `coveredTip === tip`。worker 没有按提示合入集成分支时 coveredTip 为 null，即使当前 tip 仍是基线也会补跑（`reason: 'not-covered'`）——不能证明覆盖就补跑。
- worker 侧结果绑定 sourceSha：同一提交重新提交（例如队长 `dag_retry` 采纳同一提交）会复用旧结果，包括失败结果——会再次退回 worker。
- 失败输出存进 `worker_verify_finished.output`（≤3000 字符），以便崩溃后补做退回时提示词仍有输出末尾；它不会出现在快照里。

### 已知限制

- worker 侧验收在 probe 里跑，和 worker 自己的工作树是两套；依赖缓存（node_modules 等）不会共享，命令必须在干净检出上能跑。
- `worker` 模式下集成分支前进频繁时几乎每张都要补跑，收益主要来自“失败在 worker 侧就退回、不占集成通道”；`worker-end` 才能把慢 check 完全移出集成通道。
- worker 侧验收中的 flaky 失败会退回 worker，消耗 `maxConflictRetries` 的名额。
- 计时里该工单的 queueMs 包含 worker 侧验收时长（见上）。

## A+E+F：worker 侧验收 + 最后全量 + 按改动文件选测试

同一份代码：`integrationMode: worker-end` + `selectChecksByFiles: true`。

### 配置

```yaml
- id: dsh-ticket-dag
  config:
    integrationMode: worker-end
    selectChecksByFiles: true
    maxFinalRepairs: 2
    checkMeta:
      fast: { files: ['src/**', 'checks/unit/**'], fast: true }
      soak: { files: ['src/**', 'checks/soak.mjs', 'checks/harness.mjs'] }
```

坦克基准用 `benchmarks/profiles/aef.patch.yml`；清单写法 `"integration": {"mode": "worker-end", "select_checks_by_files": true}`。

### 每一层跑什么

| 层 | 跑哪些 check | 文件过滤 |
| --- | --- | --- |
| worker 侧（提交后立即，并行） | 本工单 + 已集成工单的累计 verify | `coveredTip ?? baseSha` → sourceSha |
| 集成通道 | 累计 verify 中 `fast: true` 的 | tip → candidate |
| 最终全量（全部集成后） | 全部累计 verify | 不过滤 |
| 二分（最终全量失败时） | 失败的 ID | 不过滤 |

### 验收

```
node --test test/integration-worker.test.mjs --test-name-pattern "worker-end"
node benchmarks/simulate.mjs --slow-seconds 1 --only aef
```

看账本事件：`checks_selected` 的 stage 为 `worker`/`lane`，`worker_verify_finished`、`check_requeued`、`final_verify_started`/`final_verified`（或 `final_verify_failed` + `bisect_step`）。模拟里 aef 的逻辑错误在 `worker` 发现（L 的 diff 含 `logic-bug.txt`，被 slow 认领），定位到 L；测试里另有一例 glob 写窄、worker 侧跳过 slow，错误由最终全量发现并自动修复——这正是 A 的最终全量给 F 的漏测兜底。

### 给阶段 B（`train`）的接口

- 模式集合：`WORKER_MODES`、`END_MODES`、`IMPLEMENTED_MODES`（加 `train`）；coordinator 内 `workerMode(manifest)`、`endMode(manifest)`。`train` 不属于两者，lane 选择的分支在 `_integrate` 里（`end` → fast；`worker` → coveredTip 判断）。B 会把 lane 拆成列车，建议新写 `_integrateTrain`，复用 `_selectChecks`（stage `train`）和 `_probeChecks`。
- `_probeChecks(run, job, sha, ids, stage, phase, ticketId)`：ticketId 非空时 `check_finished` 记在工单上；列车的命令按 DESIGN 写 ticketId null、stage `train`。
- `store.requeueCheckFailure(id, lease, { message, maxRetries })`：列车二分定位到的那张用它退回 worker（事件 `check_requeued`，计时已结束其排队段，模拟的 `logicBugReport` 已认它）。
- `_workerFailed(run, ticket, { sourceSha, failed, output })` 生成退回提示词（文案写的是 worker 侧验收，B 若复用需改成参数化文案）。
- 工单级 worker 结果：`store.workerVerify(id, sha)`、`store.workerResults()`、`latestWorkerResults(db)`；B 不需要，但若 B 与 E 组合，lane 的“只收已通过”过滤在 `_pump` 的 `submitted` 选择处。
- `run.verifying` 与 `run.integration` 是两类后台任务；B 的列车仍应占 `run.integration` 一个槽（cancel/shutdown 已覆盖）。

## 阶段 B：合并列车（`train`）

分支 `modes/b`，在阶段 F、A、E 的未提交实现上继续。

### 已实现

- **配置**：`IMPLEMENTED_MODES` 加入 `train`（至此五种取值全部放行，“未实现”的报错路径保留给以后的新取值）。profile 新增 `trainSize`（`z.natural().min(2).max(16).default(4)`），`Coordinator` 构造参数/`updateSettings`/`start` 传入。`normalizeIntegration` 只在 `train` 下写入 `trainSize`（清单可写 `train_size` / `trainSize`，2–16），其他模式的清单 JSON 不变；`trainSizeOf(manifest)` 读冻结值（缺省 4）。
- **FIFO 选取**：`store.submittedOrder()` 给出每张工单最近一次 `submitted` 事件的账本序号；`_pump` 在 `train` 下把 SUBMITTED 工单按它排序，取前 `trainSize` 张。按“默认行为不变”的原则，**只有 `train` 改变选取顺序**，each/end/worker 仍按工单表顺序取第一张 SUBMITTED（这些模式一次只集成一张，顺序影响的是公平性，不影响正确性；要改可以复用 `submittedOrder`，但会改变现有基准的合并顺序，留给以后单独评估）。用事件序号而不是时间戳，同一毫秒提交的也有确定顺序。
- **git**：
  - `buildTrain(repo, path, tip, sources)`：在新建的插件 candidate 工作树（同 candidate 标记）里依次 `merge --no-ff`；每张成功的合并校验父提交为（上一个合并或 tip，该 source），并像 candidate 一样钉在 `refs/dsh-ticket-dag/candidates/<sha>` 防 GC；冲突的 `merge --abort` 回到上一个合并、记录 `{ sourceSha, files }` 并跳过。返回 `{ merges, conflicts }`。非冲突的合并失败抛错（`err.sourceSha`），保留工作树。`worktree add` 失败带 `err.trainSetup`。
  - `switchCandidate(repo, path, from, to)`：二分时在列车工作树内切到 Mi，不再额外 `worktree add`（减少并行 add 的 commondir 偶发错误面）。
  - `unpinCandidate(repo, sha)`：未发布的合并解除钉住（有未完成发布意图的保留）。
  - 发布用现有 `publishCandidate`：它要求 `parents[0] === oldTip`，链式合并 Mi 的第一父正是 M(i-1)，所以对得上。
- **coordinator**：
  - `_pump` 在 train 下若通道空闲，把仍是同一 lease/sourceSha 的车厢交给 `_integrateTrain`，占用 `run.integration` 一个槽（`job.train = true`、`job.ids`、`job.size`），cancel/shutdown 原有逻辑即可中止。列车工作树建不起来时延迟 300/600/900 ms 重试最多 3 次（`run.trainRetry`/`run.trainAt`，仅内存），仍失败则 hold 运行。
  - `_integrateTrain`：`buildTrain` → 累计 check（列车内合并成功的工单 + 已集成工单的 verify）→ 开 F 时 `_selectChecks(run, null, 'train', ids, tip, last)` → 写 `train_started {tipSha, tickets, merges, conflicts, checks}`，每张入车工单写 `verify_started`（计时结束其排队）→ 在列车工作树里 `_checksIn(..., 'train')`（命令事件 ticketId null、stage `train`）。
  - 通过：`assertCandidate(last)` 后 `_publishTrain` 按顺序逐张发布：每一步在 serial 内确认 tip 仍是 M(i-1)（或 tip）、工单仍是同一 lease/sourceSha、工单分支未动、依赖仍是祖先，然后 `assertMergeParents(Mi, M(i-1), source)` → `intent(oldTip=M(i-1), candidate=Mi)` → `publishCandidate` → `finish`。每步是现有的单张 CAS，`_reconcile` 不用改。某张工单在等待期间变化（分支动了、依赖变了）→ 它进 NEEDS_ATTENTION，后面的车厢不再发布（它们的合并建在它上面），保持 SUBMITTED 进下一趟。写 `train_passed`。
  - 失败：列车内二分（规则同第 6 节：只重跑失败 ID，在 Mi 只跑“列车前 i 张 + 已集成”用到的失败 ID，没有则视为通过；tip 视为通过，Mn 已知失败），每步 `train_bisect_step {sha, ok, checks}`，命令事件 stage `train`、phase 带 `bisect: true, step`。定位到 M(hi) → 发布 M1..M(hi-1)（二分已确认通过的前缀）→ `train_failed {tipSha, failed, culprit, culpritSha, published}` → 若前缀全部发布成功，第 hi 张用 `requeueCheckFailure` 退回原 worker（新方法 `_checkFailed(run, t, note, kind)` 是 `_workerFailed` 抽出的参数化部分；列车文案写明“Merge-train checks failed”、排在它前面的工单、它的合并 SHA、输出末尾；超过 `maxConflictRetries` 进 NEEDS_ATTENTION，说明是 merge-train 重试用完）。其后的车厢保持 SUBMITTED 进入下一趟。
  - 冲突：在本趟的结论（发布）之后才对冲突车厢调用 `requeueConflict`（文案“Trial merge conflicts with the integration tip in: … (merge train)”，沿用 `specPrompt` 的冲突分支），这样 worker 合入的集成分支已包含本趟发布的车厢；超过上限进 NEEDS_ATTENTION。
  - 结束时解除未发布合并的钉住、删除干净的列车工作树（被检查弄脏的保留）。
  - `_snapshot.trainPhase = { size, stage, checkId, index, total, bisect?, step? }`，车厢的 `livePhase` 为列车 phase；dashboard 透传 `trainPhase`。
- **看板**（`src/client.js`）：配置页下拉放开 `train`（“B 合并列车”），选中时出现“合并列车长度”输入框（2–16，`trainSize`）；运行概况在列车进行时显示 `data-dag-train` 一行：“列车 3 张 · slow 1/2”、“列车 3 张 · 验收失败，列车内二分 第 1 步 · slow 1/1”、“列车 2 张 · 逐张发布 1/2”、“列车 2 张 · 依次合并”；车厢的工单行显示“合并列车验收 slow · 1/2”，步骤条停在“正在验收”。
- **提示词**：`captainSection` 在 train 下多一句列车规则说明。worker 提示词沿用 each 的说法（插件在你提交后跑这些 check）。
- **基准/模拟**：`benchmarks/profiles/b.patch.yml`；`simulate.mjs` 的 `CONFIGS` 加 `b`（trainSize 4），脚本 worker 认 `Merge-train checks failed` 的提示词并修复；结果 JSON 多一项 `trains`。`simulate.test.mjs` 断言 b 跑完 8/8、逻辑错误在 `train` 发现并定位到 `L`。

### 配置方法

```yaml
- id: dsh-ticket-dag
  config:
    integrationMode: train
    trainSize: 4
    maxConflictRetries: 2        # 列车定位到的出错工单与冲突工单的自动退回上限（分开计数）
```

或清单：`"integration": {"mode": "train", "train_size": 6}`。

### 如何验收

```
npm test
node --test test/integration-train.test.mjs
node benchmarks/simulate.mjs --slow-seconds 1
```

`test/integration-train.test.mjs`（8 项）覆盖：多张同时提交时一趟列车一次验收合入，顺序按提交先后（C、B、A 提交 → 按 C、B、A 合入，不按工单表顺序），每个链式合并都是“上一个合并 + 工单提交”的二父合并，列车工作树与钉住引用都已清理；列车中一张冲突被跳过并退回、其余同趟合入；逻辑错误被列车内二分定位到 L，前缀 A 发布、L 带证据退回、B 进入下一趟；发布中途“崩溃”（ref 已移动未记账、意图已记未移动两种）后重启 + resume 不重复不丢失、顺序不变；trainSize 冻结与车长 1 时等价 each（一次普通合并、同样的 check、一次发布）；F 下列车按 tip..last 过滤；`trainSize` 只对 train 冻结、范围 2–16。

阶段 B 完成时：`npm test` 共 308 项，301 pass，0 fail，7 skip（阶段 E 为 298/291/0/7；新增 `test/integration-train.test.mjs` 8 项、`simulate.test.mjs` 1 项、`client-board.test.mjs` 1 项），连跑两次结果相同。阶段开始时的基线一次为 298/290/0/7、1 cancelled（`coordinator.test.mjs` 的“a reconciliation error or a throwing dispose…”超时，单独重跑通过）。中途另一次全量出现过已知的“16 concurrent worker turns”失败（并行 `git worktree add` 的 commondir 偶发错误）；该用例跑在 each 模式，不经过列车代码，单独连跑 8 次在 mode-b 失败 3 次、在 mode-e（无本阶段改动）失败 1 次，属原有问题。

模拟对比（`--slow-seconds 1`，本机一次运行，数值有波动）：

| 配置 | 集成模式 | 结果 | 总耗时 | 集成排队 | 验收耗时 | 验收命令次数 | 验收失败 | 跳过验收 | 冲突 | 尝试 | 队长重试 | 逻辑错误发现于 | 定位工单 | 最终 logic-bug.txt |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| each | each | 完成 8/8 | 11.6s | 36.7s | 9.4s | 17 | 1 | 0 | 1 | 10 | 1 | lane | L | ok |
| f | each+F | 完成 8/8 | 10.6s | 41.1s | 8.4s | 16 | 1 | 1 | 1 | 11 | 2 | lane | L | ok |
| a | end | 完成 9/9 | 8.2s | 6.9s | 5.4s | 16 | 2 | 0 | 1 | 10 | 0 | final | L | ok |
| af | end+F | 完成 9/9 | 8.1s | 7.3s | 5.4s | 16 | 2 | 0 | 1 | 11 | 1 | final | L | ok |
| e | worker | 完成 8/8 | 10.6s | 35.0s | 17.9s | 33 | 1 | 0 | 1 | 10 | 0 | worker | L | ok |
| aef | worker-end+F | 完成 8/8 | 4.6s | 15.6s | 10.8s | 27 | 1 | 1 | 1 | 10 | 0 | worker | L | ok |
| b | train | 完成 8/8 | 7.9s | 25.9s | 6.3s | 10 | 2 | 0 | 1 | 10 | 0 | train | L | ok |

- B：几张同时提交的工单坐一趟列车，只跑一次累计验收，验收命令次数最少（10，each 为 17）；L 的错误在列车验收中被发现，列车内二分定位到 L 并退回它自己，不需要队长重试。验收失败 2 = 列车整体失败 1 次 + 二分中 L 的合并点失败 1 次。集成排队仍有约 26 秒：一趟列车占住通道期间新提交的要等下一趟，而且每张的排队一直算到它那趟列车开始验收。

为适应 `train` 放行，改了 3 处原有断言（同阶段 E 的做法）：`integration-settings` 的“未实现模式被拒”改为“全部模式都可规范化”；`check-selection-run` 的“dag_run 拒绝未实现模式”改为拒绝未知取值 `fast`；`client-board` 下拉中 `train` 由禁用改为可选。

### 与方案/设计的偏差及原因

- 二分在列车工作树内 `switchCandidate` 切换，而不是像 A 那样每步建 probe：Mi 还没发布，本来就在这个 candidate 工作树的历史里，省掉并行 `worktree add`。
- 冲突车厢在本趟结论之后才退回，而不是合并时立即退回：立即退回时 worker 可能马上重新提交、又要和本趟还没发布的车厢冲突。
- 前缀发布时若中途某张工单状态变了（被取消、分支被改），发布在那里停下，culprit 也不退回（`published.length !== hi`），所有剩余车厢原样进入下一趟重新验收。
- 列车的命令事件不归属工单，所以这些工单的 `verifyMs` 是 0（但有 `verify_started`，计时不会因此变成 null）；列车耗时只进 totals 的 `verifyMs`。
- `trainSize` 下限 2：DESIGN 的 schema 如此；“车长 1”通过“队列里只有一张”自然出现，行为与 each 等价（测试覆盖）。

### 已知限制

- 一趟列车占住整个集成通道直到验收（及二分、发布）结束，期间新提交的工单只能等下一趟。
- 列车验收只在最后一个合并上做一次；flaky 失败会触发二分，二分若在中间某点也偶发失败会错怪那张工单（退回它，消耗它的重试名额）。
- 多张工单共同导致的失败只会定位到第一个失败的合并点。
- 发布中途进程崩溃后，已发布的前缀通过 `_reconcile` 补记；未发布的剩余车厢回到 SUBMITTED，下一趟重新合并验收（不会沿用崩溃前那趟的验收结论）。
- 被检查弄脏的列车工作树保留不删，需要手动清理（同 candidate/probe）。
- 与 E 组合（worker 侧先验收再进列车）未实现：`train` 不属于 `WORKER_MODES`。

## 默认改为 A+F

依据 plane-bench 真实 AI 对比（每种 1 轮，见 `../plane-bench/README.md`），插件默认改为 `integrationMode: end` + `selectChecksByFiles: true`。

- 默认值：`src/index.mjs` 的配置 schema 与 `apply` 的回退值，`src/client.js` 配置页的回退值（profile 没写或写了未知模式时显示 `end`，按文件选测试默认勾选）。`Coordinator` 构造参数和 `normalizeManifest` 的库级默认仍是 `each`，没有 `integration` 字段的旧运行也仍按 `each` 处理；只有经插件入口（profile）启动的新运行用 A+F。
- 没有快验收时的兜底：`_integrate` 在 end 类模式下，只有冻结清单的 `checkMeta` 里至少有一条 `fast: true` 才只跑快验收；一条都没有时集成通道跑全部累计验收（原来是只做试合并）。worker 模式的 fast 过滤不变（它在 worker 侧已对同一 tip 跑过全部验收）。
- 队长提示词：end 类模式或打开按文件选测试时，要求为每个用到的验收 ID 写 `check_meta`（`files` 宜宽、`fast` 区分快慢），并告诉用户哪些标了 fast。
- 测试：`test/host.test.mjs` 新增默认值与提示词用例；`test/integration-end.test.mjs` 中“没有快验收”用例改为断言集成通道跑全部验收，重启用例加一条 fast 验收让阻塞的 gate 只出现在最终全量；`test/client-board.test.mjs` 配置页默认值改为 end / 开。
