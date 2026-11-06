# T12 验收记录：集成验收 · 核对两个宿主版本与交付归档

- 工单：T12 —— 集成验收（GitHub issue #13）
- 父规格：GitHub issue #1
- 运行：`gh1-fixes-02`
- 分支：`ticket/gh1-fixes-02/t-8fd4b56e4d77f9e976a49cfc`
- 运行基线：`feat/dag-import` `c4e90da`（0.14.0）
- 验收固定提交（集成分支 tip，本票冻结基线）：`89b52db7b38c878ba6eb601f07d77e58397b7779`
- 规格要求的 0.12.0 基线：`1628da9`（已包含在本运行基线历史中，`git log` 可查）
- 记录生成时间：2026-11-05

> 说明：本记录只做验收与核对，不发布、不打 tag、不 push、不部署。真实宿主缺失的项一律记为 **NOT RUN**，不记为 PASS。

## 环境

| 项 | 值 |
| --- | --- |
| 平台 | win32 x64（Windows） |
| Node.js | v24.14.1 |
| npm | 11.13.0 |
| Git | 2.54.0.windows.1 |
| 插件版本（`package.json`） | 0.14.0 |
| 支持的 DSH 宿主 | `0.2.1-rc.2 || 0.2.1-rc.5` |
| DSH 真实宿主（`@deepseek-ai/dsh/lib/bin.js`） | **不可用**（见「真实宿主预检」） |
| `DSH_TEST_CHROME` / `DSH_TEST_PUPPETEER` | 未设置 / puppeteer-core 缺失 |

## 一、全部实现工单已集成（PASS）

集成分支 `integration/gh1-fixes-02` 的 tip `89b52db` 按 first-parent 可追溯到每张实现工单的集成提交（`dsh-ticket-dag: verify <sha>` 形式），T01–T11 全部在册：

| 工单 | 集成 verify 提交 | 被验收的实现提交（subject） |
| --- | --- | --- |
| T01 可信程序解析 | `525811d` | `cd7e6d9` Resolve internal Git and bare check programs from the trusted host PATH |
| T02 完整命令审批 | `c669d54` | `31b7a7c` Re-verify T02: the failed check passes on rerun |
| T03 审批版本绑定 | `433e199` | `3187a31` T03: bind approval to the reviewed plan revision |
| T04 清理保留本地文件 | `9468478` | `5268a78` Keep local files when cleaning ticket worktrees |
| T05 取消仍发停止信号 | `cdb6dc0` | `43fd1d1` Re-verify T05: the failed recovery check passes on rerun |
| T06 单轮失败隔离恢复 | `039f9f2` | `6dfcb76` Merge integration into the T06 ticket branch |
| T07 无界面 SDK 首跑 | `d9c63e4` | `84f9237` Explain headless SDK approval so a first run can finish |
| T08 会话卡片状态与成员 | `bf3f91d` | `df11751` Show the conversation card's live status, members and ticket count |
| T09 空 verify 累计回归语义 | `e9fe27b` | `e6866d1` T09: 统一空 verify 与累计回归的用户语义 |
| T10 降低历史账本读取成本 | `e82c568` | `1a0ca9e` T10: 降低活动看板读取历史账本的成本 |
| T11 真实 Web 计划审查验收 | `89b52db` | `8b4f62a` T11: 验收真实 Web 计划审查到集成 |

各工单的验收测试文件均已并入集成提交（`test/t01-*.test.mjs`、`t07-*`、`t09-*`、`t10-*`、`cancel-host`、`cancel-recovery` 等），并在下方完整测试中运行。T12 即本记录。子 issue 在本 profile 下不回写 GitHub，故 issue 状态仍为 open；集成状态以 git 集成分支为准。

## 二、验收固定提交、归档内容与环境（PASS）

### 固定提交与环境
见上表「验收固定提交」与「环境」。验证时 `git rev-parse HEAD == git rev-parse integration/gh1-fixes-02 == 89b52db7...`。

### 重新生成归档并核对内容对应集成版本

生成命令（在集成提交 `89b52db` 的工作树运行）：

```sh
npm pack --pack-destination <scratch> --silent
```

产物：`dsh-ticket-dag-0.14.0.tgz`

- 字节数：213,781
- SHA1：`09801cd48a596f6587a1f5beec0280e9877f0c89`
- SHA256：`6A621CFE7822C50FE157758E8542BA402C567593E0CE07C5FCF6C059A65C0113`
- 解包后文件数：30

核对方法：解包每个文件，计算其 git blob 哈希（`git hash-object <file>`）并与 `git rev-parse 89b52db:<path>` 比较。结果：**30/30 全部逐字节一致，0 处不符**。

30 个文件（路径 / 字节）：

```
README.md 40417;  cordis.patch.yml 124;  package.json 1122
examples/hello.json 1068;  examples/profile.patch.yml 1417
src/agents.mjs 3116;  src/client.js 139993;  src/coordinator.mjs 58163;
src/dashboard.mjs 26704;  src/git.mjs 32169;  src/index.mjs 28339;
src/store.mjs 43923;  src/tracker.mjs 15163
test/cancel-host.test.mjs 7702;  test/cancel-recovery.test.mjs 8809;
test/client-board.test.mjs 91113;  test/coordinator-recovery.test.mjs 21781;
test/coordinator.test.mjs 78645;  test/dashboard.test.mjs 24425;
test/dsh-e2e.mjs 23049;  test/fixtures/provider.mjs 1238;
test/git.test.mjs 22598;  test/host.test.mjs 22467;  test/store.test.mjs 35341;
test/t01-trusted-program.test.mjs 14511;  test/t07-headless-approval.test.mjs 2324;
test/t09-empty-verify-regression.test.mjs 6565;  test/t10-ledger-read.test.mjs 9286;
test/tracker.test.mjs 11111;  test/web-panel.mjs 23175
```

与工作区根目录既有 `dsh-ticket-dag-0.14.0.tgz` 的对比：旧归档 24 个文件、175,941 字节，生成于 0.14.0 基线（`c4e90da`），缺少本次新增的 6 个工单测试文件（`t01`、`t07`、`t09`、`t10`、`cancel-host`、`cancel-recovery`）；重生成的新归档 30 个文件、213,781 字节，恰好补齐这 6 个文件并逐字节对应集成提交 `89b52db`。因此交付归档已随集成版本更新。

## 三、完整本地测试与四项 P1 门禁（PASS）

### 完整本地测试

```sh
npm test          # package.json: node --test
```

输出（末尾）：

```
ℹ tests 201
ℹ suites 1
ℹ pass 195
ℹ fail 0
ℹ cancelled 0
ℹ skipped 6
ℹ todo 0
ℹ duration_ms 1060406.8498
```

`skipped 6` 全部是真实宿主相关项（1 个宿主访问控制、4 个真实 DSH SDK、1 个真实 DSH Web），原因见「真实宿主预检」；没有失败、没有伪造通过。

### 四项 P1 门禁（按集成提交 `89b52db` 运行）

```sh
node --test --test-concurrency=1 \
  test/t01-trusted-program.test.mjs test/client-board.test.mjs \
  test/dashboard.test.mjs test/store.test.mjs test/git.test.mjs
```

输出（末尾）：`ℹ tests 114 / pass 113 / fail 0 / skipped 1`（skipped 为真实宿主访问控制项）。逐门禁证据（均为 `✔`）：

| P1 门禁 | 验收测试（集成提交中运行通过） |
| --- | --- |
| ① 可信程序解析 | `internal Git ignores a checkout impostor and relative PATH entries`；`bare check programs use the trusted host PATH; explicit scripts keep the candidate cwd`；`verification runs the host program, not a same-named one committed into the candidate`；`automatic takeover runs the host Git, not a same-named program in the project` |
| ② 完整命令审批 | `plan review lists each check command, marks the ones the captain wrote and names unchecked tasks`；`plan review names a check no task uses yet and keeps every argument boundary and control character visible`；`checks the captain writes into the manifest wait for approval even without requireApproval, then run` |
| ③ 审批版本绑定 | `plan review turns a 409 into a refreshed plan and asks for a fresh confirmation`；`approval forwards the plan revision and refuses a malformed one before the coordinator`；`the plan revision is opaque and changes with the plan and its frozen commands`；`approval is bound to the reviewed plan revision; stale, missing, duplicate and unknown selections start nothing` |
| ④ ignored 文件保护 | `cleanup keeps a worktree with tracked changes, untracked or ignored files and names them` |

### 工单要求的检查（协调器提交后运行的 ID，本票自测）

```sh
# unit-tests
node --test --test-concurrency=1 test/store.test.mjs test/host.test.mjs \
  test/tracker.test.mjs test/client-board.test.mjs test/dashboard.test.mjs
# recovery-tests
node --test --test-concurrency=1 test/coordinator-recovery.test.mjs
```

输出：

```
# unit-tests
ℹ tests 121
ℹ pass 120
ℹ fail 0
ℹ skipped 1
ℹ duration_ms 1417.923

# recovery-tests
ℹ tests 11
ℹ pass 11
ℹ fail 0
ℹ skipped 0
ℹ duration_ms 135094.3506
```

`unit-tests` 与 `recovery-tests` 均通过（唯一 skip 为真实宿主访问控制项）。协调器会在本提交后按运行清单再跑一次权威检查。

## 四、两版宿主（rc.2 / rc.5）真实验收（NOT RUN）

### 真实宿主预检

```sh
# 环境变量与宿主/浏览器探测（本机实测）
DSH_TEST_BIN=<unset>
DSH_TEST_TARBALL=<unset>
DSH_TEST_CHROME=<unset>
DSH_TEST_PUPPETEER=<unset>
@deepseek-ai（npm 全局）: NOT PRESENT
ref rc.2 version=0.2.1-rc.2 builtLibBinExists=False node_modules=False
ref rc.5 version=0.2.1-rc.5 builtLibBinExists=False node_modules=False
profiles 的 @deepseek-ai/dsh 是 junction，target（npx 缓存 _npx/1e7f6d9597241db0）已不存在 -> exists=False
本机唯一构建出的 @deepseek-ai/dsh 位于 Codex checkout：version=0.1.0-rc.5（不受支持，且非 rc.2/rc.5）
chrome: present（C:\Program Files\Google\Chrome\Application\chrome.exe），但 DSH_TEST_CHROME 未指向它
puppeteer-core: ABSENT
```

结论：本机没有与 `0.2.1-rc.2`、`0.2.1-rc.5` 匹配、可直接作为 `DSH_TEST_BIN` 指向的 `@deepseek-ai/dsh/lib/bin.js`，也没有 puppeteer-core：

- 工作区 `refs/repos/...@dsh-v0.2.1-rc.2` 与 `...@dsh-v0.2.1-rc.5` 是**未构建的源码快照**（无 `lib/bin.js`、无 `node_modules`）。
- `~/.dsh/profiles/node_modules/@deepseek-ai/*` 是指向已清理 npx 缓存目录的**悬空 junction**。
- 桌面程序 `DeepSeek Harness` 自身为 `0.2.1-rc.2`，但被打包在 `app.asar` 内，启动入口是 `dsh-desktop-host/lib/cli.js`，并非测试所需的 `@deepseek-ai/dsh/lib/bin.js`，普通 node 进程无法作为 `DSH_TEST_BIN` 使用。

按工单规则「真实宿主缺失或跳过不能计为通过」，下列各项记为 **NOT RUN**（非 PASS）。这些用例本身在 `test/dsh-e2e.mjs`、`test/web-panel.mjs`、`test/dashboard.test.mjs` 中就绪，具备匹配宿主后可直接补跑。

| 宿主版本 | 验收项 | 现有入口 | 结果 |
| --- | --- | --- | --- |
| DSH 0.2.1-rc.2 | SDK（真实宿主会话/派工/取消） | `node --test test/dsh-e2e.mjs`（`DSH_TEST_BIN` 指向 rc.2） | **NOT RUN** |
| DSH 0.2.1-rc.2 | Web（真实浏览器计划审查→集成） | `node --test test/web-panel.mjs`（`DSH_TEST_BIN`+`DSH_TEST_CHROME`+`DSH_TEST_PUPPETEER`） | **NOT RUN** |
| DSH 0.2.1-rc.2 | 宿主访问控制（owner/非 owner） | `test/dashboard.test.mjs` 的 installed DSH dispatcher 用例 | **NOT RUN** |
| DSH 0.2.1-rc.2 | 取消后停止行为（在途 worker 收到停止） | `test/dsh-e2e.mjs` 的 `dag_cancel stops an in-flight worker` | **NOT RUN** |
| DSH 0.2.1-rc.5 | SDK（真实宿主会话/派工/取消） | 同上，`DSH_TEST_BIN` 指向 rc.5 | **NOT RUN** |
| DSH 0.2.1-rc.5 | Web（真实浏览器计划审查→集成） | 同上 | **NOT RUN** |
| DSH 0.2.1-rc.5 | 宿主访问控制（owner/非 owner） | 同上 | **NOT RUN** |
| DSH 0.2.1-rc.5 | 取消后停止行为（在途 worker 收到停止） | 同上 | **NOT RUN** |

关于验收项「两版宿主分别使用匹配的 DSH_TEST_BIN，DSH_TEST_TARBALL 固定到同一新归档，并运行 npm test 及现有 SDK/Web/访问控制入口」：

- `npm test` 已在集成提交上完整运行并通过（见第三节）。
- 现有 SDK / Web / 访问控制入口均已定位且就绪；其中真实宿主用例因缺宿主被 skip，记为 **NOT RUN**。
- 新归档已生成并计算指纹（`dsh-ticket-dag-0.14.0.tgz`，SHA256 `6A621CFE...`），可作为两版宿主共用的 `DSH_TEST_TARBALL`。
- 但「两版宿主分别用匹配 `DSH_TEST_BIN` 运行」这一前提不具备，故整项 **NOT RUN**，不计为通过。

## 五、性能对比（同一环境实测）

来源一：本次 `npm test` 中 `test/t10-ledger-read.test.mjs` 的 `1/10/30/100 runs: read cost stays flat and latency is recorded` 实测（每档取 p50/p95，毫秒）：

| 账本数 | 优化前 p50 | 优化前 p95 | 优化后 p50 | 优化后 p95 |
| ---: | ---: | ---: | ---: | ---: |
| 1 | 3.75 | 4.25 | 3.40 | 4.43 |
| 10 | 10.52 | 15.66 | 3.50 | 5.52 |
| 30 | 37.47 | 43.77 | 4.03 | 4.79 |
| 100 | 134.70 | 167.26 | 7.35 | 8.10 |

来源二：`docs/perf-dashboard-history.md`（T10 归档的确定性证据）：读取成本由「每请求 N 个账本」降为「每请求 1 个账本（选中详情）」，与历史条数无关；100 条时 p50 约 142 ms → 9 ms、p95 约 211 ms → 11 ms。本次实测与之一致（100 条 p50 134.7 ms → 7.35 ms）。耗时随机器负载波动，仅作性能证据，不作单测阈值。

## 六、剩余风险

1. **真实宿主完全未验收**：rc.2 / rc.5 的 SDK、Web、访问控制、取消后停止行为均为 NOT RUN。发布前必须在两份匹配的 DSH 宿主（`DSH_TEST_BIN`）加 Chromium + puppeteer-core 环境补跑 `test/dsh-e2e.mjs`、`test/web-panel.mjs`、`test/dashboard.test.mjs`；在此之前，宿主兼容性没有实证。
2. **响应体仍随历史线性增长**：列表 `runs` 每条仍带摘要，100 条约 38 KB；读取成本已解耦，但序列化/传输仍是 O(N)。
3. **首次读取仍有一次 O(N) 预热**：索引无摘要时首读会为每条历史生成摘要并写回，之后命中缓存。
4. **每轮仍对每条账本做一次 `stat`**：历史增长时 O(N) 次轻量系统调用（不再打开账本）。
5. **`puppeteer-core` 与 `DSH_TEST_CHROME` 未就绪**：本机有 Chrome 可执行文件，但未安装 puppeteer-core，Web 端到端无法运行。

## 七、PASS / FAIL / NOT RUN 汇总

工单七条验收判定：

| # | 验收条件 | 结果 |
| --- | --- | --- |
| 1 | 全部实现工单已集成，验收固定提交、归档内容和环境 | **PASS** |
| 2 | 运行完整本地测试及新增公开入口回归，核对四项 P1 门禁 | **PASS** |
| 3 | DSH rc.2 和 rc.5 分别运行 SDK、Web、宿主访问控制以及取消后停止行为 | **NOT RUN**（无匹配 `DSH_TEST_BIN`） |
| 4 | 记录 PASS/FAIL/NOT RUN，真实宿主缺失或跳过不能计为通过 | **PASS**（本记录如实记录） |
| 5 | 重新生成归档并核对内容对应集成版本，记录性能对比和剩余风险，产出可复核验收记录 | **PASS** |
| 6 | 本票完成不执行版本发布或生产部署 | **PASS**（未发布/未部署/未 push/未打 tag） |
| 7 | 两版宿主分别使用匹配 DSH_TEST_BIN，DSH_TEST_TARBALL 固定到同一新归档，并运行 npm test 及现有 SDK/Web/访问控制入口 | **NOT RUN**（两版宿主缺失；npm test 已通过、归档已就绪） |

合计：**PASS 5 / FAIL 0 / NOT RUN 2**（按宿主子项计：真实宿主 8 个子项全部 NOT RUN）。

## 结论

- 集成完整：T01–T11 全部并入 `integration/gh1-fixes-02`（tip `89b52db`）。
- 交付归档已按集成提交重生成并逐字节核对（30/30 一致，SHA256 `6A621CFE...`）。
- 完整本地测试 201 项（195 通过、0 失败、6 跳过）；四项 P1 门禁与 `unit-tests`、`recovery-tests` 均通过。
- 两版真实宿主（rc.2 / rc.5）的 SDK、Web、访问控制与取消后停止行为因本机缺匹配宿主与 puppeteer-core，全部如实记为 **NOT RUN**，未伪装为通过。
- 本票未执行任何版本发布或生产部署。
