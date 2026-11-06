# Ferrowake 基准基线仓库

这是集成模式对比实验的固定起点：一款原创的俯视角网页坦克战役 Ferrowake，本仓库只有空壳。
需求在 `.scratch/tank-arena/spec.md`，24 张工单在 `.scratch/tank-arena/issues/`，冻结的 `dag_run`
清单是根目录的 `manifest.json`。

- 零依赖：只用浏览器原生 API 与 Node 标准库，不要添加任何依赖。
- 快检查：`node --test checks/unit/`
- 慢检查：`node checks/soak.mjs`，默认运行 `BENCH_SOAK_SECONDS=60` 秒。时长是实验有意设定的固定成本。

测试目录叫 `checks/`，文件名不匹配 `node --test` 的默认发现规则（不要 `*.test.*`、`*-test.*`、
`*_test.*`、`test-*`，也不要名为 `test` 的目录）。新检查放在 `checks/unit/<系统名>-checks.mjs`。
