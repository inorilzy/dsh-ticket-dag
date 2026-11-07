# 集成模式对比实验手册

用同一个起点、同一份工单，比较不同集成模式跑完一轮要多久。基准项目是 `benchmarks/tank-arena/`：
24 张工单的原创网页坦克战役 Ferrowake。

- `benchmarks/new-trial.mjs`：建一个全新的基线仓库（一个 trial）。
- `benchmarks/report.mjs`：只读这些 trial 的运行账本，输出对比表。
- `benchmarks/simulate.mjs`：不调用模型的模拟对比，几十秒跑完，见下文“模拟对比”。
- `benchmarks/profiles/<方案>.patch.yml`：各方案的 profile 片段。

## 当前能比什么

模式由 profile 的 `integrationMode`、`selectChecksByFiles`、`checkMeta` 决定（见根目录 README“集成模式”）。插件默认已是 A+F，跑对照组 each 时须显式用 `profiles/each.patch.yml` 或在清单里写 `"integration": {"mode": "each"}`。
当前能跑的方案：

| 方案 | profile 片段 | 设置 |
| --- | --- | --- |
| `each`（现状，对照组） | `benchmarks/profiles/each.patch.yml` | `integrationMode: each`，`selectChecksByFiles: false` |
| F 按改动文件选测试 | `benchmarks/profiles/f.patch.yml` | `integrationMode: each`，`selectChecksByFiles: true` |
| A 先合并、最后测 | `benchmarks/profiles/a.patch.yml` | `integrationMode: end`，`selectChecksByFiles: false`，`maxFinalRepairs: 2` |
| A+F | `benchmarks/profiles/af.patch.yml` | `integrationMode: end`，`selectChecksByFiles: true`，`maxFinalRepairs: 2` |
| E 验收在 worker 侧 | `benchmarks/profiles/e.patch.yml` | `integrationMode: worker`，`selectChecksByFiles: false` |
| A+E+F | `benchmarks/profiles/aef.patch.yml` | `integrationMode: worker-end`，`selectChecksByFiles: true`，`maxFinalRepairs: 2` |
| B 合并列车 | `benchmarks/profiles/b.patch.yml` | `integrationMode: train`，`selectChecksByFiles: false`，`trainSize: 4` |

各片段用同一份 `checkMeta`：`fast` 负责 `src/**`、`checks/unit/**`（快测试），`soak` 负责 `src/**`、`checks/soak.mjs`、
`checks/harness.mjs`。片段合并进宿主 profile 的 `dsh-ticket-dag` 配置后再开新对话；设置在 `dag_run` 时冻结进清单，
所以不要改 `benchmarks/tank-arena/manifest.json`（会改变基准 SHA）。
A 下 soak 不在集成通道跑，只在全部工单集成后的最终全量里跑一次（失败时二分还会再跑几次），累计用时包含最终全量。
E 下 soak 在 worker 提交后立即由插件在它的提交上跑（与其他工单的 worker 侧验收并行，不占集成通道，不采信 worker 自报）；
集成通道只在集成分支已前进时补跑（事件 `reverify`）。A+E+F（`worker-end` + 按文件选测试）从不补跑，靠最终全量兜底。
worker 侧验收的命令计入对应工单的验收耗时，报告的 totals 里另有 `workerVerifyMs`。
B 下集成通道按提交先后一次取最多 4 张，依次合并后只在最后一个合并上跑一次 fast 和 soak，失败时在列车内二分；
列车的命令记在运行上（stage `train`），计入 totals 的验收耗时与命令次数，不归属任何工单。

`report.mjs` 从每轮账本冻结的清单读出实际模式，写在“实际模式”列（`each+F` 表示 each 加按文件选测试）；
label 只是你起的名字，同一 label 下实际模式不一致时，报告末尾的“警告”一节会列出来。

## 本次取值

| 参数 | 取值 |
| --- | --- |
| `BENCH_SOAK_SECONDS` | 60（默认值） |
| `max_workers` | 6（`manifest.json` 的默认值） |

模式优势主要来自慢验收的排队，所以 soak 的秒数是关键参数：它越大，串行排队的代价越明显；
它很小时，各模式的差距可能被 AI 输出的随机性盖过。每次实验都要写明实际取值，取值不同的结果不能放在一张表里比较。

## 成本

24 张工单、soak 60 秒时，`each` 模式仅串行验收就至少约 24 分钟（24 × 60 秒）。这是下限，
不含快检查、工单工作和失败重试。每个模式跑 3 轮，光这部分就至少约 72 分钟，还要加上真实 AI 调用的费用。

正式实验前，先用较小的 `BENCH_SOAK_SECONDS` 跑通一轮，例如 5 秒时这部分约 2 分钟。
这一轮只用来确认流程，结果不要算进正式对比。

## 实验步骤

每轮都重复下面的步骤。

1. **建全新 trial。** 一个模式的一轮对应一个全新目录，不要重复使用：

   ```
   node benchmarks/new-trial.mjs D:\bench\each-1
   ```

   脚本输出 `HEAD <sha>`。所有轮次的 SHA 必须相同，不同说明起点不一样，这轮不能比较。

2. **设置 soak 时长。** 验收命令继承 DeepSeek Harness 宿主进程的环境变量，清单里设置不了。
   要改时长，先在宿主的启动环境里设置 `BENCH_SOAK_SECONDS`，再启动宿主；已经在运行的宿主不会变。
   不设置时为 60 秒。

3. **开新对话启动。** 在该 trial 目录打开新对话，用 Agent Teams 加载根目录的 `manifest.json` 调用 `dag_run`，
   不要重新拆分工单。清单带验收命令，所以会先进入计划审查，确认后才开跑。

4. **保持条件一致。** 每轮用相同的模型和相同的 `max_workers`。计划审查里的模型、推理强度和“同时运行工单数”
   都能改，确认前要逐项核对。实际并发还受“最大 Agent 数量”和宿主容量限制，这些设置也要保持一致。

5. **运行期间。** 机器不做其他重负载。不要用 `dag_add` 追加工单。工单进入等待处理时，各轮用同样的方式处理。

6. **出报告。** 所有轮次结束后，在本仓库运行：

   ```
   node benchmarks/report.mjs each=D:\bench\each-1 each=D:\bench\each-2 each=D:\bench\each-3
   ```

   同一 label 重复就是同一模式的多轮。加 `--json` 输出每轮的原始数据。

放弃了计划、中途取消或又发起了一轮 `dag_run` 时，这个 trial 就作废了，换一个新目录重跑。

## 怎么读报告

每个 label 一行。除累计用时的最小最大外，各列都是各轮的中位数。

| 列 | 含义 |
| --- | --- |
| 轮数 | 计入汇总的轮数 |
| 累计用时 | 从首次批准（无需批准时从启动）起算的墙钟时间，运行暂停、阻塞、取消或结束时不计。计划审查的等待不计 |
| 扣除等待处理后的用时 | 每轮的累计用时减去等待处理时间，再取中位数 |
| 工单工作合计 | 所有工单每次尝试的墙钟时间之和，从领取到提交。多张工单并行时会超过累计用时，暂停也不会让它停止 |
| 集成排队 | 所有工单从提交到集成通道开始处理的时间之和 |
| 验收 | 所有验收命令的耗时之和 |
| 实际模式 | 账本里冻结的集成模式；同一 label 各轮不一致时用 / 连接并给出警告 |
| 验收命令次数、验收失败次数 | 被取消或关停打断的命令算一次运行，不算失败。运行级的验收（后续方案的最终全量、二分、列车）也计入 |
| 跳过验收数 | 按改动文件选测试时跳过的验收命令数（`checks_selected` 事件），旧账本为 0 |
| 冲突次数 | 试合并冲突后退回工单的次数 |
| 尝试次数 | 工单被领取的总次数 |

口径与 `src/timing.mjs` 的 `runTiming` 一致，看板显示的也是同一套数字。

**比较时用“扣除等待处理后的用时”。** 等待处理时间是至少有一张工单处于 `NEEDS_ATTENTION` 的运行时段，
多张重叠只算一次。这段时间大多在等人，长短取决于人什么时候回应，和集成模式无关，留在累计用时里只会增加噪声。
不过模式也可能让工单更容易进入等待处理，所以还要同时看验收失败次数、冲突次数和尝试次数。

**— 表示账本里没有这项数据，不是 0。** 旧账本没有验收事件，分不清排队和验收，这几列显示 —。
同一 label 只要有一轮缺某项数据，这一列的汇总就显示 —，各轮的值可在 `--json` 里查看。

**“未计入汇总”一节列出被排除的 trial 和原因：**

- trial 里有多轮运行；
- 运行没有全部 `INTEGRATED`；
- 工单全部合入，但计时没有停在运行完成的时刻（例如暂停或取消后才收尾），用时偏小；
- 找不到账本，或账本读取失败。

有 trial 被排除时报告不算失败，退出码仍是 0，所以要看这一节，并核对轮数是否符合预期。

## 模拟对比

```
node benchmarks/simulate.mjs --slow-seconds 1
node benchmarks/simulate.mjs --only each,a --json
```

脚本直接创建 `Coordinator`，用脚本 worker（不调用模型）在临时 Git 仓库里跑一份固定的 8 张工单，每种配置一个新仓库：
S1a/S1b 改 `src/shared1.txt` 的同一行（后合入的一张冲突，worker 合入集成分支并取并集解决）；S2a/S2b、S3a/S3b
改同一文件的不同行（合并干净）；L 合并干净但写入 `logic-bug.txt=bad`，让慢检查 `slow` 失败；D 只改 `docs/`。
验收项 `fast` 立即通过，`slow` 睡 `--slow-seconds` 秒（默认 2）。脚本扮演队长：工单进入“需要处理”时调用 `dag_retry`，
被要求修复的尝试把 `logic-bug.txt` 改成 `ok`。A 下 L 的错误在最终全量才暴露，插件自动追加的 `fix-L-1` 同样由脚本 worker 修复，
所以 A 的工单数是 9、队长重试为 0。E 和 A+E+F 下 L 的错误在 worker 侧验收就被发现，插件把 L 退回原 worker
（提示词带失败的 slow 和输出末尾），脚本 worker 修复后重新提交，所以工单数仍是 8、队长重试为 0；验收命令次数比 each 多，
是因为每张工单在 worker 侧先跑一遍累计验收，集成分支前进时 E 还要在通道里补跑。
B 下几张同时提交的工单坐同一趟列车，只在最后一个合并上跑一次累计验收，L 的错误在列车验收（`train`）中被发现，
列车内二分定位到 L 并把它退回原 worker，排在它前面的工单照常发布，后面的进入下一趟；工单数 8、队长重试为 0。
`--json` 里的 `trains` 是列车趟数。

表格列出总耗时（runTiming 累计用时）、集成排队、验收耗时与次数、失败、跳过、冲突、尝试、队长重试次数，
以及逻辑错误在哪个阶段被发现（lane / worker / final / train / never）、定位到哪张工单。`--only` 选择配置（当前为 `each`、`f`、`a`、`af`、`e`、`aef`、`b`），
`--keep` 保留临时仓库，`--timeout` 设每种配置的上限秒数。任一配置没跑完时退出码为 2。
配置表是 `simulate.mjs` 的 `CONFIGS` 对象，后续方案在其中加一项即可。

## 限制

- 真实 AI 输出有随机性。每个模式至少跑 3 轮，比较中位数；差异小于组内波动（最小到最大的范围）时不下结论。
- 3 轮只够排除明显的偶然，不是统计检验。差距不大时要多跑几轮。
- 报告只读 `<trial>/.git/dsh-ticket-dag/runs/*/state.sqlite`，所以 trial 要放在本地，出报告前不要删除。
