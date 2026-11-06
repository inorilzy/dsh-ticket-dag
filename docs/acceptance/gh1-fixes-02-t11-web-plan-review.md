# T11 验收记录：真实 Web 计划审查到集成

- 工单：T11 —— P2 · 恢复真实 Web 计划审查到集成的验收（GitHub issue #12）
- 父规格：GitHub issue #1
- 运行：`gh1-fixes-02`
- 分支：`ticket/gh1-fixes-02/t-691802e8547e838d715e468c`
- 冻结基线：`433e1996f8da2f77f5978cf33eb796b4c94348c0`
- 记录生成时 HEAD：`433e1996f8da2f77f5978cf33eb796b4c94348c0`（冻结基线）

## 环境

| 项 | 值 |
| --- | --- |
| 平台 | win32 x64（Windows） |
| Node.js | v24.14.1 |
| Git | 2.54.0.windows.1 |
| npm | 11.13.0 |
| 插件版本（package.json） | 0.14.0 |
| 支持的 DSH 宿主 | `0.2.1-rc.2 || 0.2.1-rc.5` |

## 预检结果

命令：

```sh
node -e "for (const k of ['DSH_TEST_BIN','DSH_TEST_CHROME','DSH_TEST_PUPPETEER']) { const v=process.env[k]; console.log(k+'='+(v===undefined?'<unset>':v)) }"
```

输出：

```
DSH_TEST_BIN=<unset>
DSH_TEST_CHROME=<unset>
DSH_TEST_PUPPETEER=<unset>
```

补充查找：

```sh
# 工作区内是否有已安装的 @deepseek-ai/dsh/lib/bin.js
Get-ChildItem -Path 'D:\tmp\dsh-ticket-dag-workspace' -Recurse -Filter 'bin.js' | Where-Object { $_.FullName -match '@deepseek-ai\\dsh\\lib\\bin\.js$' }
# 全局是否有 @deepseek-ai 包
Get-ChildItem "$env:USERPROFILE\AppData\Roaming\npm\node_modules\@deepseek-ai"
# 是否有 puppeteer-core
Get-ChildItem "$env:USERPROFILE\AppData\Roaming\npm\node_modules" | Where-Object { $_.Name -like 'puppeteer*' }
```

输出：三段均为空；`C:\Program Files\Google\Chrome\Application\chrome.exe` 存在（`Test-Path` 返回 `True`），但 `DSH_TEST_CHROME` 未指向它。

结论：`DSH_TEST_BIN`、`DSH_TEST_CHROME`、`DSH_TEST_PUPPETEER` 均缺失，且本机没有可用的 `@deepseek-ai/dsh` 安装或 `puppeteer-core`。真实宿主 Web / 访问控制 / SDK 用例均为 **NOT RUN**，不是 PASS。

## 验收项结果

| # | 验收项 | 结果 | 依据 |
| --- | --- | --- | --- |
| 1 | 从真实队长会话进入本轮侧栏，替换过期的插件详情看板入口。 | NOT RUN | 已在 `test/web-panel.mjs` 改为「真实队长会话 → 会话顶部『查看工单』→ 右侧栏『工单 · web-board』」，但缺 `DSH_TEST_BIN` / `DSH_TEST_CHROME` / `DSH_TEST_PUPPETEER`，未执行。 |
| 2 | 检查完整命令与精确参数，批准 staged 计划后观察真实执行。 | NOT RUN | `test/web-panel.mjs` 现在断言「验收命令」区块的精确 argv（含含空格参数与空参数）后点击「确认并启动」，缺环境未执行。 |
| 3 | 覆盖追加导致旧 revision 拒绝并重新确认。 | NOT RUN | `test/web-panel.mjs` 现在追加 C 后用旧 revision 直接 POST 审批，断言 409，再在刷新后的审查面板重新确认；缺环境未执行。 |
| 4 | 验证依赖顺序、集成 Git 结果、当前卡片信息及页面重载。 | NOT RUN | `test/web-panel.mjs` 现在等待 A 执行时 B/C 等待、A 集成后 B/C 执行、3/3 集成，`git show integration/web-board:B.txt|C.txt`，会话卡片「已完成 · 3 张工单」，页面重载后重开同一侧栏标签；缺环境未执行。 |
| 5 | 真实宿主访问控制验证 owner 与非 owner，夹具隔离且清理可靠。 | NOT RUN | 复用 `test/dashboard.test.mjs:516` 的已安装 DSH 派发器用例：非 owner 返回 403 且不触发账本读取，owner 只读自己的隔离运行；临时账本夹具在 `t.after` 删除。缺 `DSH_TEST_BIN`，未执行。 |
| 6 | 预检 DSH_TEST_BIN、DSH_TEST_CHROME 和 DSH_TEST_PUPPETEER，复用现有 Web/访问控制测试入口，缺环境报告 NOT RUN。 | PASS | 见“预检结果”与下方命令输出：三个变量缺失已如实记录，受影响项标为 NOT RUN；Web 入口仍为 `test/web-panel.mjs`，访问控制入口仍为 `test/dashboard.test.mjs`，未新增入口。 |

统计：PASS 1 / FAIL 0 / NOT RUN 5。

## 复用的现有测试入口

- **Web**：`test/web-panel.mjs`（真实 DSH Web + Chromium/Puppeteer，真实临时 Git 仓库、SQLite、真实子会话与队长通知；模型传输仅为本地回环夹具）。
- **访问控制**：`test/dashboard.test.mjs` 中「the installed DSH dispatcher rejects a non-owner before serving any dashboard data」，使用已安装 DSH 的 `HostConnectionService`。
- **SDK 真实宿主**：`test/dsh-e2e.mjs`（预检 + 真实 SDK 流程）。

## 本次对测试入口的改动（夹具/测试，不是生产代码）

- `test/web-panel.mjs`
  - 删除对已下线的「插件详情看板」入口的假设（原先 `openBundle(second)` 后等待「暂无运行记录」）。
  - 改为真实队长会话流程：`workspace/create` → `session/create` → `session/prompt` 提交计划 → 点击会话顶部「查看工单」打开右侧栏「工单 · web-board」→ 检查「验收命令」精确 argv → 点击「确认并启动」。
  - 追加 `dag_add` 使计划 revision 变化，断言旧 revision 审批返回 409，刷新后重新确认。
  - 断言依赖顺序（A 先、B/C 等待）、集成 Git 结果（`integration/web-board:B.txt`、`C.txt`）、会话卡片（已完成 · 3 张工单 · 实现者 · 3 张）以及页面重载后重开同一标签。
  - 夹具继续使用 `mkdtempSync` 独立临时根目录，`t.after` 递归删除。
- `test/dashboard.test.mjs`
  - 访问控制用例补齐 owner / 非 owner 隔离：非 owner 对 `parent=` 与 `key=` 请求均为 403 且 `read` 不执行；owner 只读到自己的运行。
  - 使用独立临时账本夹具，并在 `t.after` 关闭账本、删除临时目录。
- `test/dsh-e2e.mjs`
  - 无界面清单自带 `checks` 保持 staged 的用例新增断言：staged 结果携带 `revision`（审批绑定到该计划版本）。

## 实际执行的命令与输出

### 1) Web 入口（`test/web-panel.mjs`）

```sh
node --test test/web-panel.mjs
```

输出（末尾）：

```
﹣ real DSH Web: review the captain plan, approve the exact commands, append, integrate and reload (…) # Set DSH_TEST_BIN, DSH_TEST_CHROME and DSH_TEST_PUPPETEER
ℹ tests 1
ℹ pass 0
ℹ fail 0
ℹ skipped 1
```

结果：**NOT RUN**（环境缺失，跳过）。

### 2) SDK 真实宿主入口（`test/dsh-e2e.mjs`）

```sh
node --test test/dsh-e2e.mjs
```

输出：

```
✔ SDK smoke preflight records DSH_TEST_BIN for each supported host version
ℹ DSH 0.2.1-rc.2: NOT RUN in this process; rerun with DSH_TEST_BIN of DSH 0.2.1-rc.2
ℹ DSH 0.2.1-rc.5: NOT RUN in this process; rerun with DSH_TEST_BIN of DSH 0.2.1-rc.5
﹣ real DSH  SDK: dag_cancel stops an in-flight worker # Set DSH_TEST_BIN to the locally installed @deepseek-ai/dsh/lib/bin.js
﹣ real DSH  SDK: one ticket and idle captain wake # NOT RUN: set DSH_TEST_BIN ...
﹣ real DSH  SDK: 16 workers, rolling refill and a dependent ticket # NOT RUN ...
﹣ real DSH  SDK: a manifest check stays staged with requireApproval off # NOT RUN ...
ℹ tests 5
ℹ pass 1
ℹ fail 0
ℹ skipped 4
```

结果：预检以 **NOT RUN** 记录两个宿主版本；真实 SDK 用例 **NOT RUN**。

### 3) 访问控制入口（`test/dashboard.test.mjs`）

```sh
node --test test/dashboard.test.mjs
```

输出（末尾）：

```
﹣ the installed DSH dispatcher rejects a non-owner before serving any dashboard data # Set DSH_TEST_BIN to test host access control
ℹ tests 13
ℹ pass 12
ℹ fail 0
ℹ skipped 1
```

结果：真实宿主访问控制用例 **NOT RUN**；其余 12 项通过。

### 4) 工单要求的检查（协调器提交后运行，这里先自测）

```sh
node --test test/store.test.mjs test/host.test.mjs test/tracker.test.mjs test/client-board.test.mjs test/dashboard.test.mjs
```

输出（末尾）：

```
ℹ tests 121
ℹ pass 120
ℹ fail 0
ℹ skipped 1
```

```sh
node --test test/coordinator-recovery.test.mjs
```

输出（末尾）：

```
ℹ tests 11
ℹ pass 11
ℹ fail 0
ℹ skipped 0
```

结果：`unit-tests` 与 `recovery-tests` 均通过。

## 结论

- 验收项 6（预检并如实报告 NOT RUN）完成，PASS。
- 验收项 1–5 依赖真实宿主、真实浏览器与 Puppeteer，本机缺 `DSH_TEST_BIN`、`DSH_TEST_CHROME`、`DSH_TEST_PUPPETEER`，均记为 **NOT RUN**，未伪造为 PASS。
- 测试入口已更新到当前流程（默认审批 + revision 绑定 + 右侧栏计划审查 + 页面重载），可在具备两份受支持 DSH 宿主、Chromium 与 puppeteer-core 的环境里直接运行 `node --test test/web-panel.mjs`、`node --test test/dsh-e2e.mjs`、`node --test test/dashboard.test.mjs` 补做真实结果。
