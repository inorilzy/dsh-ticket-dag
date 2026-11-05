// DSH serves this entry as a browser script; React is supplied by the DSH Web shell.
window.__ModuleLoader__.load({
  id: 'dsh-ticket-dag',
  factory(require) {
    const { createElement: h, useEffect, useRef, useState } = require('react')
    const demoChecks = {
      greeting: [
        [
          'node',
          '-e',
          "require('node:assert/strict').equal(require('./dag-demo/greet.cjs').greet('Ada'), 'Hello Ada')",
        ],
      ],
      normalize: [
        [
          'node',
          '-e',
          "require('node:assert/strict').equal(require('./dag-demo/normalize.cjs').normalize(' Ada '), 'Ada')",
        ],
      ],
      welcome: [
        [
          'node',
          '-e',
          "require('node:assert/strict').equal(require('./dag-demo/welcome.cjs').welcome(' Ada '), 'Hello Ada')",
        ],
      ],
    }

    // Same as src/agents.mjs builtinAgents; shown when the profile has no saved presets.
    const builtinAgents = {
      implementer: {
        name: '实现者',
        description: '实现者：按工单完成代码与配套测试',
        instructions:
          'Implement the ticket end to end: production code plus the tests that prove it. Keep the change limited to what the ticket asks for.',
        provider: '',
        model: '',
        reasoningEffort: '',
        maxConcurrent: 0,
      },
      'test-writer': {
        name: '测试员',
        description: '测试编写者：只补测试与测试夹具',
        instructions:
          'Add or improve automated tests and test fixtures only. Do not change production code; if a test exposes a defect, describe it in your report instead of fixing it.',
        provider: '',
        model: '',
        reasoningEffort: '',
        maxConcurrent: 0,
      },
      docs: {
        name: '文档员',
        description: '文档编写者：只改文档与注释',
        instructions:
          'Update documentation, README files and code comments only. Do not change program behavior.',
        provider: '',
        model: '',
        reasoningEffort: '',
        maxConcurrent: 0,
      },
    }
    const agentFields = ['name', 'description', 'instructions', 'provider', 'model', 'reasoningEffort']
    const agentRow = (id, preset) => ({
      id,
      ...Object.fromEntries(agentFields.map((f) => [f, preset?.[f] ?? ''])),
      maxConcurrent: String(preset?.maxConcurrent ?? 0),
    })

    const styles = `
.dtd-panel {display:grid;gap:1.2rem;max-width:50rem;color:inherit;font:inherit;line-height:1.5}
.dtd-panel * {box-sizing:border-box}
.dtd-panel select {background:Canvas;color:CanvasText;font:inherit;border:1px solid color-mix(in srgb,currentColor 30%,transparent);border-radius:.4rem;padding:.4rem;min-width:0;max-width:100%}
.dtd-dashboard {margin:1rem 0;overflow-wrap:anywhere}
.dtd-dashboard progress {width:100%;height:.7rem;accent-color:#337cbd}
.dtd-counts {display:flex;gap:.45rem;flex-wrap:wrap}.dtd-counts span,.dtd-badge {background:color-mix(in srgb,currentColor 7%,transparent);border-radius:.35rem;padding:.18rem .5rem;font-size:.83rem}
.dtd-badge {font-weight:600}.dtd-badge.work {background:color-mix(in srgb,#548dc7 18%,transparent)}.dtd-badge.done {background:color-mix(in srgb,#47a478 22%,transparent)}
.dtd-tickets {display:grid;gap:.55rem;list-style:none;margin:0;padding:0}
.dtd-ticket {border:1px solid var(--dtd-line);background:var(--dtd-card);border-radius:.55rem;padding:.7rem .8rem;display:grid;gap:.32rem}
.dtd-ticket-head {display:flex;flex-wrap:wrap;gap:.35rem .7rem;align-items:baseline}.dtd-ticket-head .dtd-badge {margin-inline-start:auto}
.dtd-phase,.dtd-ticket details {font-size:.86rem}.dtd-ticket summary {cursor:pointer}
.dtd-info {display:grid;grid-template-columns:max-content minmax(0,1fr);gap:.25rem .75rem;margin:.3rem 0}
.dtd-info dd {margin:0}.dtd-ticket .dtd-alert {white-space:pre-wrap}
.dtd-panel h3,.dtd-panel h4,.dtd-panel p,.dtd-panel fieldset {margin:0}
.dtd-panel h3 {font-size:1.1rem}.dtd-panel h4 {font-size:.96rem}
.dtd-panel small,.dtd-panel .dtd-hint {font-size:.83rem;color:inherit;opacity:.78}
.dtd-panel fieldset {min-width:0;border:0;padding:0;display:grid;gap:1rem}
.dtd-panel .dtd-section {display:grid;gap:.7rem}
.dtd-panel .dtd-grid {display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,13rem),1fr));gap:.8rem}
.dtd-panel label {display:grid;gap:.3rem;min-width:0;font-size:.9rem}
.dtd-panel input,.dtd-panel textarea,.dtd-panel button {font:inherit;color:inherit}
.dtd-panel input,.dtd-panel textarea {width:100%;background:transparent;border:1px solid color-mix(in srgb,currentColor 30%,transparent);border-radius:.4rem;padding:.42rem .6rem}
.dtd-panel textarea {min-height:2.25rem;resize:vertical;line-height:1.4;font-family:ui-monospace,monospace}
.dtd-panel button {background:transparent;border:1px solid color-mix(in srgb,currentColor 28%,transparent);border-radius:.45rem;cursor:pointer;padding:.37rem .65rem}
.dtd-panel button:disabled {cursor:default;opacity:.45}
.dtd-panel button:focus-visible,.dtd-panel input:focus-visible,.dtd-panel textarea:focus-visible {outline:2px solid #528ed6;outline-offset:2px}
.dtd-panel .dtd-actions {display:flex;flex-wrap:wrap;align-items:center;gap:.5rem}
.dtd-panel .dtd-rule {display:grid;gap:.75rem;border:1px solid color-mix(in srgb,currentColor 22%,transparent);border-radius:.65rem;padding:1rem}
.dtd-panel .dtd-head,.dtd-panel .dtd-pair {display:flex;align-items:center;justify-content:space-between;gap:.5rem}
.dtd-panel .dtd-pair label {flex:1}.dtd-panel .dtd-pair button {align-self:flex-end}
.dtd-panel .dtd-command {display:grid;gap:.5rem;border-inline-start:2px solid color-mix(in srgb,currentColor 24%,transparent);padding-inline-start:.75rem}
.dtd-panel .dtd-primary {background:#245d9b;border-color:transparent;color:#fff;font-weight:600}
.dtd-panel .dtd-alert {padding:.5rem .7rem;border-inline-start:3px solid #d38f39}
.dtd-dashboard {--dtd-work:var(--dsw-alias-state-business-primary,#4c8df6);--dtd-wait:var(--dsw-alias-state-warn-primary,#e5a03a);--dtd-done:var(--dsw-alias-state-success-primary,#3fb27f);--dtd-blocked:var(--dsw-alias-state-error-primary,#e5534b);--dtd-pending:var(--dsw-alias-text-secondary,#8b9099);--dtd-idle:color-mix(in srgb,currentColor 38%,transparent);--dtd-line:var(--dsw-alias-border-l2,color-mix(in srgb,currentColor 16%,transparent));--dtd-card:color-mix(in srgb,currentColor 4%,transparent)}
.dtd-sr {position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.dtd-card {border:1px solid var(--dtd-line);border-radius:.75rem;background:var(--dtd-card);padding:.8rem .95rem;display:grid;gap:.3rem}
.dtd-run-head {display:flex;align-items:baseline;gap:.6rem;flex-wrap:wrap}.dtd-run-head strong {font-size:1.02rem}.dtd-run-head .dtd-badge {margin-inline-start:auto}
.dtd-bar {display:flex;gap:3px;height:.4rem}.dtd-bar span {border-radius:99px;min-width:.4rem;background:var(--dtd-idle)}
.dtd-legend {display:flex;flex-wrap:wrap;gap:.25rem .9rem;font-size:.8rem}.dtd-legend span {display:inline-flex;align-items:center;gap:.3rem}
.dtd-dot {display:inline-block;flex:none;width:.5rem;height:.5rem;border-radius:2px;background:var(--dtd-idle)}
[data-tone=work]>.dtd-dot,.dtd-bar [data-dag-segment=work],.dtd-dot[data-tone=work] {background:var(--dtd-work)}
[data-tone=wait]>.dtd-dot,.dtd-dot[data-tone=wait] {background:var(--dtd-wait)}
.dtd-progress [data-tone=wait]>.dtd-dot,.dtd-progress .dtd-dot[data-tone=wait],.dtd-bar [data-dag-segment=wait] {background:var(--dtd-pending)}
[data-tone=done]>.dtd-dot,.dtd-bar [data-dag-segment=done],.dtd-dot[data-tone=done] {background:var(--dtd-done)}
[data-tone=blocked]>.dtd-dot,.dtd-bar [data-dag-segment=blocked],.dtd-dot[data-tone=blocked] {background:var(--dtd-blocked)}
.dtd-badge.wait {background:color-mix(in srgb,var(--dtd-wait) 24%,transparent)}.dtd-progress .dtd-badge.wait {background:color-mix(in srgb,var(--dtd-pending) 24%,transparent)}.dtd-badge.blocked {background:color-mix(in srgb,var(--dtd-blocked) 24%,transparent)}
.dtd-banner {display:flex;align-items:center;gap:.5rem;border-radius:.5rem;padding:.4rem .7rem;font-size:.86rem;background:color-mix(in srgb,var(--dtd-blocked) 12%,transparent)}
.dtd-fold {display:flex;align-items:center;gap:.6rem;flex-wrap:wrap;border-radius:.5rem;padding:.3rem .5rem;background:var(--dtd-card)}
.dtd-panel .dtd-fold button {border:0;padding:.2rem .3rem;font-weight:600}.dtd-fold .dtd-hint {margin-inline-start:auto}
.dtd-fold label {display:flex;align-items:center;gap:.4rem;margin-inline-start:auto;font-size:.83rem}
.dtd-ticket-head .dtd-dot {align-self:center}
.dtd-graph {overflow:auto;padding:.2rem 0 .4rem}.dtd-canvas {position:relative}
.dtd-canvas svg {position:absolute;inset:0;overflow:visible;pointer-events:none}
.dtd-canvas path {fill:none;stroke:color-mix(in srgb,currentColor 30%,transparent);stroke-width:1.3}
.dtd-canvas path[data-active=true] {stroke:var(--dtd-work);stroke-width:1.8}
.dtd-panel .dtd-node {position:absolute;display:grid;align-content:start;gap:.2rem;text-align:start;border:1px solid var(--dtd-line);border-radius:.6rem;background:var(--dsw-alias-bg-layer-1,Canvas);padding:.45rem .6rem;overflow:hidden}
.dtd-node-head {display:flex;align-items:center;gap:.4rem;font-weight:600;font-size:.84rem}
.dtd-node-head small {margin-inline-start:auto;font-weight:400;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dtd-node-title {font-size:.84rem;line-height:1.35;opacity:.86;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.dtd-node[data-tone=work] {border-color:color-mix(in srgb,var(--dtd-work) 60%,transparent)}
.dtd-node[data-tone=blocked] {border-color:color-mix(in srgb,var(--dtd-blocked) 70%,transparent)}
.dtd-node[data-dim=true] {opacity:.42}.dtd-canvas path[data-active=false] {opacity:.45}
.dtd-steps {display:flex;list-style:none;margin:.2rem 0;padding:0;gap:3px;font-size:.76rem}
.dtd-steps li {flex:1;min-width:0;text-align:center;padding-top:.3rem;border-top:3px solid var(--dtd-idle);opacity:.7;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dtd-steps [data-state=done] {border-color:var(--dtd-done);opacity:1}
.dtd-steps [data-state=current] {border-color:var(--dtd-work);opacity:1;font-weight:600}
.dtd-steps [data-state=current] {border-top-color:transparent;background:linear-gradient(90deg,transparent,rgba(255,255,255,.7),transparent) -70% 0/40% 3px no-repeat border-box,linear-gradient(var(--dtd-work),var(--dtd-work)) 0 0/100% 3px no-repeat border-box;animation:dtd-sweep 1.4s linear infinite}
.dtd-spin {flex:none;box-sizing:border-box;width:.75rem;height:.75rem;border-radius:50%;border:2px solid color-mix(in srgb,var(--dtd-work) 25%,transparent);border-top-color:var(--dtd-work);animation:dtd-rotate .8s linear infinite}
.dtd-status {flex:none;width:.8rem;height:.8rem;fill:none;stroke:var(--dtd-idle);stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.dtd-status[data-tone=wait] {stroke:var(--dtd-wait)}.dtd-progress .dtd-status[data-tone=wait] {stroke:var(--dtd-pending)}.dtd-status[data-tone=done] {stroke:var(--dtd-done)}.dtd-status[data-tone=blocked] {stroke:var(--dtd-blocked)}
.dtd-canvas .dtd-status {position:static;inset:auto;pointer-events:none}.dtd-canvas .dtd-status path {stroke:inherit;stroke-width:inherit;opacity:1}
@keyframes dtd-rotate {to {transform:rotate(360deg)}}
@keyframes dtd-sweep {from {background-position:-70% 0,0 0} to {background-position:170% 0,0 0}}
@media (prefers-reduced-motion:reduce) {.dtd-spin,.dtd-steps [data-state=current] {animation:none}}
.dtd-steps [data-state=skipped] {border-color:var(--dtd-blocked);opacity:1}
.dtd-detail .dtd-run-head strong {font-size:.96rem}
.dtd-panel .dtd-preset:not(.dtd-rule) {border:1px solid color-mix(in srgb,currentColor 16%,transparent);border-radius:.55rem;padding:.5rem .75rem}
.dtd-preset-row {display:flex;flex-wrap:wrap;align-items:center;gap:.3rem .8rem}
.dtd-panel label.dtd-check {display:flex;align-items:flex-start;gap:.6rem}.dtd-panel label.dtd-check input {width:auto;margin-top:.3rem}
.dtd-check span {display:grid;gap:.15rem}
.dtd-panel .dtd-ticket-head input[type=checkbox] {width:auto;margin:0}
.dtd-avatar {position:relative;display:inline-flex;flex:none;border-radius:50%}
.dtd-avatar-tag {position:absolute;right:-.25rem;bottom:-.2rem;min-width:1rem;padding:0 .18rem;border-radius:.4rem;font-size:.58rem;line-height:.9rem;font-weight:700;color:#fff;text-align:center;border:1px solid color-mix(in srgb,Canvas 60%,transparent)}
.dtd-block {border:1px solid var(--dtd-line);border-radius:.8rem;background:var(--dtd-card);padding:.85rem .95rem;display:grid;gap:.55rem;min-width:0}
.dtd-panel .dtd-block > h4,.dtd-member-head h4 {font-size:1.05rem;font-weight:700}
.dtd-captain {display:flex;align-items:center;gap:.7rem;border:1px solid var(--dtd-line);border-radius:.6rem;padding:.55rem .75rem;background:color-mix(in srgb,currentColor 3%,transparent)}
.dtd-captain-model {margin-inline-start:auto;opacity:.8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dtd-review {gap:1rem}
.dtd-review-head {display:grid;gap:.35rem}
.dtd-run-name {margin:0;font-weight:600;overflow-wrap:anywhere}
.dtd-review-head .dtd-run-name {color:var(--dsw-alias-text-secondary,inherit);font-size:.9rem}
.dtd-review-title {display:flex;align-items:center;justify-content:space-between;gap:.6rem}
.dtd-panel .dtd-review-title h3 {font-size:1.4rem;font-weight:700}
.dtd-pill {border:1px solid var(--dtd-wait);color:var(--dtd-wait);border-radius:99px;padding:.1rem .75rem;font-size:.85rem;white-space:nowrap}
.dtd-wizard {display:flex;align-items:center;list-style:none;margin:.35rem 0 0;padding:0;gap:.5rem}
.dtd-wizard li {display:flex;align-items:center;gap:.45rem;white-space:nowrap;font-size:.92rem;opacity:.72}
.dtd-wizard li:not(:last-child) {flex:1}
.dtd-wizard li:not(:last-child)::after {content:'';flex:1;height:1px;min-width:1rem;background:color-mix(in srgb,currentColor 30%,transparent)}
.dtd-wizard li span {display:inline-grid;place-items:center;width:1.55rem;height:1.55rem;border-radius:50%;background:color-mix(in srgb,currentColor 18%,transparent);font-size:.82rem;font-weight:600}
.dtd-wizard [data-state=current] {opacity:1;color:var(--dtd-work);font-weight:600}
.dtd-wizard [data-state=current] span {background:var(--dtd-work);color:#fff}
.dtd-wizard [data-state=done] {opacity:1}.dtd-wizard [data-state=done] span {background:var(--dtd-done);color:#fff}
.dtd-member-head,.dtd-member {display:grid;grid-template-columns:1.1rem 2rem minmax(0,1fr) minmax(0,auto) 7.5rem 6rem;align-items:center;gap:.5rem}
.dtd-member-tasks {justify-self:start;max-width:100%;padding:.12rem .5rem;border-radius:.35rem;background:color-mix(in srgb,currentColor 10%,transparent);font-size:.8rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dtd-member-captain-model {grid-column:5 / 7;font-size:.84rem;opacity:.8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dtd-map-hint {margin:.4rem 0 0;font-size:.82rem}
.dtd-member-head h4 {grid-column:2 / 4}.dtd-member-head h4 small {font-weight:400;font-size:.8rem}
.dtd-member {padding:.4rem 0;border-top:1px solid var(--dtd-line)}
.dtd-member .dtd-route,.dtd-member-head .dtd-route {display:contents}
.dtd-panel .dtd-member select,.dtd-panel .dtd-member-head select {width:100%;padding:.25rem .35rem;font-size:.84rem}
.dtd-member-head select {border-color:color-mix(in srgb,var(--dtd-work) 60%,transparent)}
.dtd-member-name {display:grid;min-width:0}.dtd-member-name small {opacity:.7;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dtd-panel .dtd-member input[type=checkbox],.dtd-panel .dtd-member-head input[type=checkbox] {width:1.05rem;height:1.05rem;margin:0;accent-color:var(--dtd-work)}
.dtd-member-foot {display:flex;flex-wrap:wrap;align-items:center;gap:.5rem;padding-top:.3rem}.dtd-member-foot button {margin-inline-start:auto}
.dtd-tasks {list-style:none;margin:0;padding:0;display:grid}
.dtd-task {border-top:1px solid var(--dtd-line)}
.dtd-panel .dtd-task-row {display:grid;grid-template-columns:auto minmax(0,1fr) auto auto;align-items:center;gap:.75rem;width:100%;border:0;border-radius:0;padding:.55rem .15rem;text-align:start;background:transparent}
.dtd-panel .dtd-task-row:hover {background:color-mix(in srgb,currentColor 5%,transparent)}
.dtd-chip {display:inline-grid;place-items:center;min-width:1.75rem;height:1.6rem;padding:0 .3rem;border-radius:.35rem;background:color-mix(in srgb,currentColor 14%,transparent);font-weight:700;font-size:.84rem}
.dtd-task-title {font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dtd-chevron {opacity:.6;font-size:1.15rem;line-height:1;transition:transform .15s}.dtd-task-row[aria-expanded=true] .dtd-chevron {transform:rotate(90deg)}
.dtd-task-edit {padding:.1rem .15rem .75rem 2.5rem}.dtd-task-edit select {width:100%}
.dtd-panel .dtd-node.dtd-node-compact {padding:.55rem .7rem;border-radius:.6rem;gap:.3rem;background:color-mix(in srgb,currentColor 4%,var(--dsw-alias-bg-layer-1,Canvas))}
.dtd-node-compact .dtd-node-head small {font-family:ui-monospace,monospace;font-size:.76rem}
.dtd-node-compact .dtd-node-title {font-size:.9rem;opacity:.8}
.dtd-panel .dtd-progress .dtd-node.dtd-node-compact[data-tone=wait] {border-color:color-mix(in srgb,var(--dtd-pending) 75%,transparent)}
.dtd-actionbar {position:sticky;bottom:0;z-index:2;display:grid;grid-template-columns:1fr 1fr auto;gap:.6rem;padding:.8rem 0 .2rem;background:var(--dsw-alias-bg-layer-1,Canvas);border-top:1px solid var(--dtd-line)}
.dtd-panel .dtd-actionbar button {padding:.6rem .9rem;font-weight:600;border-radius:.55rem}
.dtd-panel .dtd-actionbar .dtd-danger {border-color:transparent;color:var(--dtd-blocked)}
.dtd-preset-row .dtd-actions {margin-inline-start:auto}
.dtd-preset-meta {font-size:.83rem;background:color-mix(in srgb,currentColor 7%,transparent);border-radius:.35rem;padding:.1rem .45rem}
.dtd-owner {font-size:.84rem;font-weight:600;white-space:nowrap}
.dtd-appended {font-size:.76rem;padding:0 .35rem;border-radius:.3rem;border:1px solid currentColor;opacity:.75;white-space:nowrap;cursor:help}
.dtd-run-card {border:1px solid var(--dtd-line);border-radius:.75rem;background:var(--dtd-card);padding:.7rem .9rem;display:grid;gap:.55rem;margin:.4rem 0;line-height:1.5}
.dtd-run-card-head {display:flex;align-items:center;gap:.6rem;min-width:0}
.dtd-run-card-title {font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dtd-run-card-meta {margin-inline-start:auto;font-size:.83rem;opacity:.72;white-space:nowrap}
.dtd-run-card button {font:inherit;font-size:.83rem;font-weight:600;color:inherit;background:color-mix(in srgb,currentColor 10%,transparent);border:1px solid var(--dtd-line);border-radius:.45rem;padding:.2rem .6rem;cursor:pointer;white-space:nowrap}
.dtd-run-card-members {display:flex;flex-wrap:wrap;gap:.45rem}
.dtd-run-card-member {display:inline-flex;align-items:center;gap:.35rem;font-size:.85rem;border-radius:999px;padding:.15rem .6rem .15rem .2rem;background:color-mix(in srgb,currentColor 8%,transparent)}
.dtd-ticket-head .dtd-task-title {min-width:0}
`

    function draftFor(value) {
      return {
        maxWorkers: String(value.maxWorkers ?? 16),
        requireApproval: value.requireApproval ?? true,
        checkTimeoutMs: String(value.checkTimeoutMs ?? 120000),
        rules: Object.entries(value.checks ?? {}).map(([id, commands]) => ({ id, commands })),
        agents: Object.entries(value.agents ?? builtinAgents).map(([id, preset]) => agentRow(id, preset)),
      }
    }

    const validId = (id) =>
      /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(id) &&
      !id.includes('..') &&
      !id.endsWith('.') &&
      !id.toLowerCase().endsWith('.lock') &&
      !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(id)

    function agentsFrom(rows) {
      const agents = Object.create(null)
      for (const [i, { id, ...preset }] of rows.entries()) {
        if (!validId(id)) throw new Error('第 ' + (i + 1) + ' 个预设 Agent 的 ID 无效。请使用以字母或数字开头的短标识，例如 test-writer。')
        if (Object.hasOwn(agents, id)) throw new Error('预设 Agent ID 重复：' + id)
        const cap = Number(preset.maxConcurrent)
        if (!/^\d+$/.test(preset.maxConcurrent) || cap > 32)
          throw new Error(id + ' 的同时运行上限须为 0 到 32 之间的整数，0 表示不单独限制。')
        agents[id] = { ...preset, maxConcurrent: cap }
      }
      return agents
    }

    function numberField(raw, max, label) {
      const value = Number(raw)
      if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < 1 || value > max) {
        throw new Error(label + '须为 1 到 ' + max + ' 之间的整数。')
      }
      return value
    }

    function checksFrom(rules) {
      const checks = Object.create(null)
      for (const [i, { id, commands }] of rules.entries()) {
        const name = '第 ' + (i + 1) + ' 个验收项'
        if (!validId(id)) {
          throw new Error(name + '的 ID 无效。请使用以字母或数字开头的短标识，例如 unit-tests。')
        }
        if (Object.hasOwn(checks, id)) throw new Error('验收项 ID 重复：' + id)
        if (!commands.length) throw new Error(name + '至少需要一条命令。')
        for (const [j, argv] of commands.entries()) {
          if (!argv?.[0]?.trim()) throw new Error(id + ' 的第 ' + (j + 1) + ' 条命令缺少程序名。')
          if (argv.some((arg) => typeof arg !== 'string' || arg.includes('\0'))) {
            throw new Error(id + ' 的命令包含无效参数。')
          }
        }
        checks[id] = commands
      }
      return checks
    }

    function operations(base, draft) {
      const changed = []
      for (const [field, max, label] of [
        ['maxWorkers', 32, '最大并发工单数'],
        ['checkTimeoutMs', 2_147_483_647, '验收超时'],
      ]) {
        const value = numberField(draft[field], max, label)
        if (value !== Number(base[field])) changed.push({ op: 'set', path: [field], value })
      }
      if (base.requireApproval !== draft.requireApproval) {
        changed.push({ op: 'set', path: ['requireApproval'], value: draft.requireApproval })
      }
      if (JSON.stringify(base.rules) !== JSON.stringify(draft.rules)) {
        changed.push({ op: 'set', path: ['checks'], value: checksFrom(draft.rules) })
      }
      if (JSON.stringify(base.agents) !== JSON.stringify(draft.agents)) {
        changed.push({ op: 'set', path: ['agents'], value: agentsFrom(draft.agents) })
      }
      return changed
    }

    function button(title, onClick, extra = {}) {
      return h('button', { type: 'button', onClick, ...extra }, title)
    }

    function numeric(label, value, change, hint, max) {
      return h(
        'label',
        null,
        h('span', null, label),
        h('input', {
          'aria-label': label,
          type: 'number',
          min: 1,
          max,
          step: 1,
          value,
          onChange: (e) => change(e.target.value),
        }),
        h('small', null, hint),
      )
    }

    function field(label, value, change, multiline = false) {
      return h(
        'label',
        null,
        h('span', null, label),
        h(multiline ? 'textarea' : 'input', {
          'aria-label': label,
          rows: multiline ? 1 : undefined,
          spellCheck: false,
          value,
          onChange: (e) => change(e.target.value),
        }),
      )
    }

    function Rule({ rule, index, modify, remove }) {
      return h(
        'section',
        { className: 'dtd-rule', 'aria-label': '验收项 ' + (rule.id || index + 1) },
        h(
          'div',
          { className: 'dtd-head' },
          h('h4', null, '验收项 ' + (index + 1)),
          button('移除验收项', remove),
        ),
        field('验收项 ID', rule.id, (v) =>
          modify((r) => {
            r.id = v
          }),
        ),
        ...rule.commands.map((argv, j) => {
          const title = '命令 ' + (j + 1)
          return h(
            'div',
            { className: 'dtd-command', key: j },
            field(title + ' 的程序', argv[0], (v) =>
              modify((r) => {
                r.commands[j][0] = v
              }),
            ),
            ...argv.slice(1).map((param, k) =>
              h(
                'div',
                { key: k, className: 'dtd-pair' },
                field(
                  title + ' 的参数 ' + (k + 1),
                  param,
                  (v) =>
                    modify((r) => {
                      r.commands[j][k + 1] = v
                    }),
                  true,
                ),
                button('移除参数', () => modify((r) => r.commands[j].splice(k + 1, 1))),
              ),
            ),
            h(
              'div',
              { className: 'dtd-actions' },
              button('添加参数', () => modify((r) => r.commands[j].push(''))),
              rule.commands.length > 1 && button('移除命令', () => modify((r) => r.commands.splice(j, 1))),
            ),
          )
        }),
        h(
          'div',
          { className: 'dtd-actions' },
          button('添加命令', () => modify((r) => r.commands.push(['']))),
        ),
      )
    }

    const routeKey = (provider, model) => (model ? JSON.stringify([provider, model]) : '')

    // Options come from the host model catalog. A saved route the catalog no
    // longer lists stays selectable so opening the form never drops it.
    // bare: only the two selects, for table rows whose header names the columns.
    function ModelPicker({ agent, catalog, modify, label, bare = false, disabled = false }) {
      const name = label || agent.id || '未命名'
      const providers = catalog?.providers ?? []
      const current = routeKey(agent.provider, agent.model)
      const known = providers.find((p) => p.id === agent.provider)?.models.find((m) => m.id === agent.model)
      const efforts = known?.efforts ?? []
      const modelSelect = h(
        'select',
        {
          'aria-label': name + ' 的模型',
          value: current,
          disabled,
          onChange: (e) =>
            modify((a) => {
              const [provider, model] = e.target.value ? JSON.parse(e.target.value) : ['', '']
              Object.assign(a, { provider, model, reasoningEffort: '' })
            }),
        },
        h('option', { value: '' }, '宿主默认'),
        current &&
          !known &&
          h('option', { value: current }, [agent.provider, agent.model].filter(Boolean).join('/') + '（当前目录中没有）'),
        ...providers.map((p) =>
          h(
            'optgroup',
            { key: p.id, label: p.name },
            ...p.models.map((m) => h('option', { key: m.id, value: routeKey(p.id, m.id) }, m.name)),
          ),
        ),
      )
      const effortSelect = h(
        'select',
        {
          'aria-label': name + ' 的推理强度',
          value: agent.reasoningEffort,
          disabled: disabled || (!efforts.length && !agent.reasoningEffort),
          onChange: (e) =>
            modify((a) => {
              a.reasoningEffort = e.target.value
            }),
        },
        h('option', { value: '' }, '模型默认'),
        agent.reasoningEffort &&
          !efforts.some((x) => x.id === agent.reasoningEffort) &&
          h('option', { value: agent.reasoningEffort }, agent.reasoningEffort + '（当前目录中没有）'),
        ...efforts.map((x) => h('option', { key: x.id, value: x.id }, x.name)),
      )
      if (bare) return h('div', { className: 'dtd-route' }, modelSelect, effortSelect)
      return h(
        'div',
        { className: 'dtd-grid' },
        h('label', null, h('span', null, '模型'), modelSelect),
        h('label', null, h('span', null, '推理强度'), effortSelect),
      )
    }

    // One line per preset: what it is, which model, how many may run at once.
    function presetSummary(agent, catalog) {
      const model = catalog?.providers
        ?.find((p) => p.id === agent.provider)
        ?.models.find((m) => m.id === agent.model)
      const route = agent.model
        ? (model?.name ?? [agent.provider, agent.model].filter(Boolean).join('/'))
        : '宿主默认模型'
      const effort = agent.reasoningEffort
        ? (model?.efforts.find((x) => x.id === agent.reasoningEffort)?.name ?? agent.reasoningEffort)
        : ''
      const cap = Number(agent.maxConcurrent) || 0
      return [route + (effort ? ' · ' + effort : ''), cap > 0 ? '同时运行 ≤ ' + cap : '不单独限制']
    }

    function AgentRule({ agent, index, catalog, open, toggle, modify, remove }) {
      const name = agent.name || builtinAgents[agent.id]?.name || agent.id || '预设 ' + (index + 1)
      const [route, limit] = presetSummary(agent, catalog)
      const head = h(
        'div',
        { className: 'dtd-preset-row' },
        h('strong', null, name),
        agent.id && name !== agent.id && h('code', { className: 'dtd-hint' }, agent.id),
        agent.description && h('span', { className: 'dtd-hint' }, agent.description),
        h('span', { className: 'dtd-preset-meta' }, route),
        h('span', { className: 'dtd-preset-meta' }, limit),
        h('span', { className: 'dtd-actions' }, button(open ? '收起' : '编辑', toggle), button('移除', remove)),
      )
      if (!open) return h('section', { className: 'dtd-preset', 'data-dag-preset': agent.id, 'aria-label': '预设 ' + name }, head)
      return h(
        'section',
        { className: 'dtd-rule dtd-preset', 'data-dag-preset': agent.id, 'aria-label': '预设 ' + name },
        head,
        h(
          'div',
          { className: 'dtd-grid' },
          field('显示名', agent.name, (v) =>
            modify((a) => {
              a.name = v
            }),
          ),
          field('Agent ID', agent.id, (v) =>
            modify((a) => {
              a.id = v
            }),
          ),
          field('简介', agent.description, (v) =>
            modify((a) => {
              a.description = v
            }),
          ),
        ),
        h(
          'label',
          null,
          h('span', null, '角色说明'),
          h('textarea', {
            'aria-label': '角色说明',
            rows: 3,
            value: agent.instructions,
            onChange: (e) =>
              modify((a) => {
                a.instructions = e.target.value
              }),
          }),
          h('small', null, '会写进使用该预设的工单提示词。'),
        ),
        h(ModelPicker, { agent, catalog, modify }),
        h(
          'label',
          null,
          h('span', null, '同时运行上限'),
          h('input', {
            'aria-label': (agent.id || '未命名') + ' 的同时运行上限',
            type: 'number',
            min: 0,
            max: 32,
            step: 1,
            value: agent.maxConcurrent,
            onChange: (e) =>
              modify((a) => {
                a.maxConcurrent = e.target.value
              }),
          }),
          h('small', null, '用这个预设的工单最多同时跑几个。0 表示不单独限制，只受最大 Agent 数量约束。修改后立即用于后续派工。'),
        ),
      )
    }

    // scope 'agents' is the plugin-page Agent preset view: the overall agent
    // limit and the presets only. Hidden fields are never written.
    function Editor({ form, scope = 'all' }) {
      const agentsOnly = scope === 'agents'
      const [edit, setEdit] = useState(null)
      const [notice, setNotice] = useState(null)
      const [busy, setBusy] = useState(false)
      const [catalog, setCatalog] = useState(null)
      // Indices of preset rows being edited; saved presets show collapsed.
      const [open, setOpen] = useState(() => new Set())
      const inFlight = useRef(false)
      useEffect(() => {
        const ctrl = new AbortController()
        fetch('api/ticket-dag.models', { signal: ctrl.signal, cache: 'no-store' })
          .then((r) => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
          .then((data) => setCatalog(Array.isArray(data?.providers) ? data : { error: true }))
          .catch((error) => error.name !== 'AbortError' && setCatalog({ error: true }))
        return () => ctrl.abort()
      }, [])
      const { value, writable, revision } = form.state
      const current = draftFor(value)
      const draft = edit?.draft ?? current
      const base = edit?.base ?? current
      const stale = edit !== null && edit.revision !== revision
      const dirty = edit !== null && JSON.stringify(draft) !== JSON.stringify(base)
      function change(fn) {
        setNotice(null)
        setEdit((old) => {
          const initial = old ?? { revision, base: current, draft: current }
          const draft = structuredClone(initial.draft)
          fn(draft)
          return { ...initial, draft }
        })
      }
      function discard() {
        setEdit(null)
        setNotice(null)
        setOpen(new Set())
      }
      function toggle(i) {
        setOpen((old) => {
          const next = new Set(old)
          if (!next.delete(i)) next.add(i)
          return next
        })
      }
      async function save(event) {
        event.preventDefault()
        if (!dirty || stale || !writable || inFlight.current) return
        inFlight.current = true
        setBusy(true)
        try {
          const ops = operations(base, draft)
          if (ops.length && !(await form.mutate(ops, edit.revision))) {
            throw new Error('宿主未接受本次保存。请检查配置或重新载入当前值。')
          }
          setEdit(null)
          setOpen(new Set())
          setNotice({ text: '配置已保存。' })
        } catch (error) {
          setNotice({ error: true, text: error.message || '保存失败，修改仍保留在表单中。' })
        } finally {
          inFlight.current = false
          setBusy(false)
        }
      }

      return h(
        'form',
        { className: 'dtd-panel', noValidate: true, onSubmit: save },
        h('style', null, styles),
        h(
          'section',
          { className: 'dtd-section' },
          h('h3', null, agentsOnly ? 'Agent 预设' : '工单调度配置'),
          h(
            'p',
            { className: 'dtd-hint' },
            agentsOnly
              ? '设置最多能同时创建几个 Agent、有哪些预设、每个预设用什么模型和最多同时跑几个。保存在当前 DSH profile 中；验收命令在插件详情的“配置”里设置。'
              : '这些设置保存在当前 DSH profile 中。每轮任务仍可在工单清单里指定更低的并发数。',
          ),
        ),
        !writable && h('p', { className: 'dtd-alert', role: 'status' }, '当前配置只读。'),
        stale &&
          h(
            'p',
            { className: 'dtd-alert', role: 'alert' },
            '配置已在其他位置更新。请丢弃修改，载入最新值后再编辑。',
          ),
        h(
          'fieldset',
          { disabled: !writable || busy || stale },
          h(
            'div',
            { className: 'dtd-grid' },
            numeric(
              agentsOnly ? '最大 Agent 数量' : '最大并发工单数',
              draft.maxWorkers,
              (v) =>
                change((d) => {
                  d.maxWorkers = v
                }),
              agentsOnly
                ? '所有运行合计最多同时创建几个工单 Agent，可设 1–32。实际还受 DSH 子智能体上限限制。'
                : '可设 1–32。实际并发还受 DSH 子智能体上限限制。',
              32,
            ),
            !agentsOnly &&
            numeric(
              '验收超时（毫秒）',
              draft.checkTimeoutMs,
              (v) =>
                change((d) => {
                  d.checkTimeoutMs = v
                }),
              '每条验收命令各自计时。120000 毫秒等于 2 分钟。',
              2_147_483_647,
            ),
          ),
          h(
            'label',
            { className: 'dtd-check' },
            h('input', {
              type: 'checkbox',
              'aria-label': '启动前需要我确认',
              checked: draft.requireApproval,
              onChange: (e) =>
                change((d) => {
                  d.requireApproval = e.target.checked
                }),
            }),
            h(
              'span',
              null,
              h('strong', null, '启动前需要我确认'),
              h(
                'small',
                null,
                '打开时，队长提交的工单先停在“执行前计划审查”，你在对话右侧栏确认每张工单的预设和模型后才开始派工。关闭则提交后立即派工。',
              ),
            ),
          ),
          h(
            'section',
            { className: 'dtd-section', 'aria-label': '预设 Agent' },
            h('h3', null, '预设 Agent'),
            h(
              'p',
              { className: 'dtd-hint' },
              '工单用 agent 引用预设 ID，子会话按该预设的角色说明和模型工作。模型选“宿主默认”时沿用宿主的模型路由。dag_run 开始时会冻结所用预设，之后修改只影响新的运行。',
            ),
            catalog === null && h('p', { className: 'dtd-hint', role: 'status' }, '正在读取模型列表…'),
            catalog?.error &&
              h('p', { className: 'dtd-alert', role: 'status' }, '模型列表暂不可用。已保存的选择会保留。'),
            catalog?.failures?.length > 0 &&
              h(
                'p',
                { className: 'dtd-alert', role: 'status' },
                '以下 provider 的模型列表读取失败：' + catalog.failures.join('、'),
              ),
            h(
              'div',
              { className: 'dtd-actions' },
              button('添加预设 Agent', () => {
                setOpen((old) => new Set(old).add(draft.agents.length))
                change((d) => d.agents.push(agentRow('', null)))
              }),
              button(
                '补入内置预设',
                () =>
                  change((d) => {
                    const ids = new Set(d.agents.map((a) => a.id))
                    for (const [id, preset] of Object.entries(builtinAgents)) {
                      if (!ids.has(id)) d.agents.push(agentRow(id, preset))
                    }
                  }),
                { disabled: Object.keys(builtinAgents).every((id) => draft.agents.some((a) => a.id === id)) },
              ),
            ),
            !draft.agents.length && h('p', { className: 'dtd-hint' }, '尚未配置预设。未写 agent 的工单使用宿主默认子会话。'),
            ...draft.agents.map((a, i) =>
              h(AgentRule, {
                key: i,
                agent: a,
                index: i,
                catalog: catalog?.error ? null : catalog,
                open: open.has(i),
                toggle: () => toggle(i),
                modify: (fn) => change((d) => fn(d.agents[i])),
                remove: () => {
                  // Row indices shift after a removal, so editing state restarts collapsed.
                  setOpen(new Set())
                  change((d) => d.agents.splice(i, 1))
                },
              }),
            ),
          ),
          !agentsOnly &&
          h(
            'section',
            { className: 'dtd-section' },
            h('h3', null, '验收命令'),
            h(
              'p',
              { className: 'dtd-hint' },
              '工单用 verify 引用验收项 ID。程序和每个参数分别填写。验收时，命令按顺序在候选工作树中运行。',
            ),
            h(
              'div',
              { className: 'dtd-actions' },
              button('添加验收项', () => change((d) => d.rules.push({ id: '', commands: [['']] }))),
              button(
                '补入示例验收项',
                () =>
                  change((d) => {
                    const ids = new Set(d.rules.map((r) => r.id))
                    for (const [id, commands] of Object.entries(demoChecks)) {
                      if (!ids.has(id)) d.rules.push({ id, commands })
                    }
                  }),
                { disabled: Object.keys(demoChecks).every((id) => draft.rules.some((r) => r.id === id)) },
              ),
            ),
            !draft.rules.length &&
              h(
                'p',
                { className: 'dtd-hint' },
                '尚未配置验收项。试跑 A/C/B 示例时，可补入三条示例验收项再保存。',
              ),
            ...draft.rules.map((r, i) =>
              h(Rule, {
                key: i,
                rule: r,
                index: i,
                modify: (fn) => change((d) => fn(d.rules[i])),
                remove: () => change((d) => d.rules.splice(i, 1)),
              }),
            ),
          ),
        ),
        h(
          'div',
          { className: 'dtd-actions' },
          h(
            'button',
            { type: 'submit', className: 'dtd-primary', disabled: !dirty || !writable || busy || stale },
            busy ? '正在保存…' : '保存配置',
          ),
          button('丢弃修改', discard, { disabled: edit === null || busy }),
        ),
        notice &&
          h(
            'p',
            { role: notice.error ? 'alert' : 'status', className: notice.error ? 'dtd-alert' : undefined },
            notice.text,
          ),
      )
    }

    const modes = { staged: '待确认', active: '运行中', paused: '已暂停', cancelled: '已取消' }
    const states = {
      RUNNING: ['执行中', 'work'],
      SUBMITTED: ['等待集成', 'work'],
      PUBLISHING: ['正在发布', 'work'],
      INTEGRATED: ['已集成', 'done'],
      NEEDS_ATTENTION: ['需要处理', 'blocked'],
      CANCELLED: ['已取消', 'neutral'],
    }
    const stages = {
      worktree: '准备工作树',
      launch: '启动 DSH 子会话',
      agent: '子会话执行中',
      receipt: '核对工单提交回执',
      merge: '候选工作树试合并',
      verify: '正在验收',
      publish: '推进集成分支',
      cleanup: '清理工作树与分支',
    }

    function ticketView(ticket, byId, mode) {
      const missing = ticket.dependsOn.filter((id) => byId.get(id)?.status !== 'INTEGRATED')
      let [label, tone] = states[ticket.status] ?? [ticket.status, 'neutral']
      if (ticket.status === 'PENDING') {
        tone = 'wait'
        if (mode === 'cancelled') [label, tone] = ['运行已取消', 'neutral']
        else if (missing.length) label = '等待依赖'
        else if (mode === 'paused') label = '暂停派工'
        else if (ticket.retryAt > Date.now()) label = '等待退避重试'
        // In a live run a ready ticket waits for a slot; in a plan under review it is merely startable.
        else [label, tone] = ['可派工', mode === 'staged' ? 'neutral' : 'wait']
      }
      // A submitted ticket only works while it holds the integration slot; otherwise it queues.
      if (ticket.status === 'SUBMITTED' && !ticket.livePhase) tone = 'wait'
      const phase = ticket.livePhase
      let stage =
        ['RUNNING', 'SUBMITTED', 'PUBLISHING'].includes(ticket.status) && phase && stages[phase.stage]
      if (stage && phase.stage === 'verify' && phase.checkId) {
        stage = '验收 ' + phase.checkId
        if (phase.index && phase.total) stage += ' · ' + phase.index + '/' + phase.total
      }
      return { label, tone, stage, missing }
    }

    function runMode(run) {
      if (run.available === false) return '记录不可读取'
      if (run.complete) return '已完成'
      if (run.mode === 'active' && run.counts?.NEEDS_ATTENTION > 0) return '运行中 · 有待处理工单'
      return modes[run.mode] ?? run.mode
    }

    // Opens the worker's own conversation; present once the ticket has a child session.
    const chatButton = (ticket, open) =>
      open && ticket.childId && button('查看对话', () => open(ticket.childId), { title: '打开这个工单子会话的对话记录' })

    // A ticket row knows its model as "provider/model"; the vendor match reads the whole string.
    const ticketRoute = (ticket, captain) => (ticket.model ? { model: ticket.model } : captain)

    // A member's name in its own colour; ID-free like the plan review.
    const memberTag = (member) =>
      h('span', { className: 'dtd-owner', 'data-dag-color': member.color, style: { color: member.color } }, member.name)

    // A ticket the captain added with dag_add after the run started; hover shows when.
    const appendedTag = (ticket) =>
      ticket.appended &&
      h(
        'span',
        {
          className: 'dtd-appended',
          'data-dag-appended': '',
          title: '追加于 ' + new Date(ticket.appendedAt).toLocaleString('zh-CN'),
        },
        '追加',
      )

    function Ticket({ ticket, view, open, captain, member }) {
      const { id, title, status, dependsOn, attempt, retryAt, message } = ticket
      const info = [
        ['子会话', ticket.childId],
        ['工作树', ticket.path],
        ['工单分支', ticket.branch],
        ['基线提交', ticket.baseSha],
        ['成果提交', ticket.sourceSha],
        ['已集成提交', ticket.landedSha],
      ].filter(([, value]) => value)
      return h(
        'li',
        { className: 'dtd-ticket', 'data-dag-ticket': id, 'data-dag-status': status },
        h(
          'div',
          { className: 'dtd-ticket-head', 'data-tone': view.tone },
          h('span', { className: 'dtd-dot' }),
          h(Avatar, { route: ticketRoute(ticket, captain), size: 22 }),
          h('span', { className: 'dtd-chip' }, id),
          title && title !== id && h('span', { className: 'dtd-task-title' }, title),
          appendedTag(ticket),
          memberTag(member),
          h('span', { className: 'dtd-badge ' + view.tone }, view.label),
          chatButton(ticket, open),
        ),
        view.stage && h('p', { className: 'dtd-phase' }, view.stage),
        h(
          'p',
          { className: 'dtd-hint' },
          '上游：' + (dependsOn.length ? dependsOn.join('、') : '无') + '　执行尝试：' + (attempt ?? 0),
        ),
        status === 'PENDING' &&
          view.missing.length > 0 &&
          h('p', { className: 'dtd-phase' }, '等待集成：' + view.missing.join('、')),
        status === 'PENDING' &&
          retryAt > Date.now() &&
          h('p', { className: 'dtd-phase' }, '下次可重试：' + new Date(retryAt).toLocaleTimeString('zh-CN')),
        message && status === 'NEEDS_ATTENTION' && h('p', { className: 'dtd-alert' }, message),
        (info.length > 0 || (message && status !== 'NEEDS_ATTENTION')) &&
          h(
            'details',
            null,
            h('summary', null, '执行信息'),
            message && status !== 'NEEDS_ATTENTION' && h('p', null, message),
            info.length > 0 &&
              h(
                'dl',
                { className: 'dtd-info' },
                ...info.flatMap(([key, value]) => [
                  h('dt', { key: key + '-key' }, key),
                  h('dd', { key: key + '-value' }, h('code', null, value)),
                ]),
              ),
          ),
      )
    }

    function RunProgress({ run, compact, openChild }) {
      const [filter, setFilter] = useState('all')
      const byId = new Map(run.tickets.map((t) => [t.id, t]))
      const rows = run.tickets.map((ticket) => ({ ticket, view: ticketView(ticket, byId, run.mode) }))
      const [listOpen, setListOpen] = useState(true)
      const [mapOpen, setMapOpen] = useState(true)
      // The map node under the pointer or keyboard focus; null shows the default ticket.
      const [hovered, setHovered] = useState(null)
      // Frozen tickets name their agent; the snapshot presets give its display name.
      const presets = run.presets ?? []
      const memberIds = [...new Set([...presets.map((p) => p.id), ...run.tickets.map((t) => t.agent ?? '')])]
      const memberOf = (t) => ({ name: memberName(t.agent, presets), color: memberColor(memberIds, t.agent ?? '') })
      const counts = run.counts
      const complete = counts.INTEGRATED ?? 0
      const count = (s) => counts[s] ?? 0
      const attention = count('NEEDS_ATTENTION')
      const groups = [
        ['done', '已集成', complete],
        ['work', '进行中', rows.filter((r) => r.view.tone === 'work').length],
        ['wait', '等待', rows.filter((r) => r.view.tone === 'wait').length],
        ['blocked', '需要处理', attention],
        ['neutral', '已取消', count('CANCELLED')],
      ]
      const visible = rows.filter(
        ({ ticket, view }) =>
          filter === 'all' ||
          (filter === 'blocked'
            ? ticket.status === 'NEEDS_ATTENTION'
            : filter === 'waiting'
              ? view.label === '等待依赖'
              : view.tone === 'work'),
      )
      const open = openChild && run.parentId ? (childId) => openChild(run.parentId, childId) : null
      const listFold = h(
        'div',
        { className: 'dtd-fold', key: 'list-fold' },
        h(
          'button',
          { type: 'button', 'aria-expanded': listOpen, onClick: () => setListOpen(!listOpen) },
          (listOpen ? '▾ ' : '▸ ') + run.tickets.length + ' 张工单',
        ),
        listOpen &&
          h(
            'label',
            null,
            '筛选',
            h(
              'select',
              { 'aria-label': '筛选工单', value: filter, onChange: (e) => setFilter(e.target.value) },
              h('option', { value: 'all' }, '全部工单'),
              h('option', { value: 'working' }, '执行或集成中'),
              h('option', { value: 'waiting' }, '等待依赖'),
              h('option', { value: 'blocked' }, '需要处理'),
            ),
          ),
      )
      const listBody =
        listOpen &&
        (visible.length
          ? h(
              'ul',
              { className: 'dtd-tickets', key: 'list' },
              ...visible.map(({ ticket, view }) =>
                h(Ticket, { key: ticket.id, ticket, view, open, captain: run.captain, member: memberOf(ticket) }),
              ),
            )
          : h('p', { className: 'dtd-hint', key: 'list' }, '当前没有符合筛选条件的工单。'))
      const mapFold = h(
        'div',
        { className: 'dtd-fold', key: 'map-fold' },
        h(
          'button',
          { type: 'button', 'aria-expanded': mapOpen, onClick: () => setMapOpen(!mapOpen) },
          (mapOpen ? '▾ ' : '▸ ') + '工单依赖',
        ),
        h('span', { className: 'dtd-hint' }, '从左到右：上游合入后解锁 · 悬停查看详情'),
      )
      const mapBody =
        mapOpen &&
        h(DependencyMap, { key: 'map', rows, hovered, setHovered, open, captain: run.captain, ownerOf: memberOf })
      const listBlock = h(
        'section',
        { className: 'dtd-block', 'aria-label': '工单列表', key: 'list-block' },
        listFold,
        listBody,
      )
      const mapBlock = h(
        'section',
        { className: 'dtd-block', 'aria-label': '依赖图', key: 'map-block' },
        mapFold,
        mapBody,
      )
      return h(
        'section',
        { className: 'dtd-section dtd-progress', 'aria-label': '运行详情' },
        h(CaptainCard, { run }),
        h(
          'section',
          { className: 'dtd-block', 'aria-label': '运行' },
          h(
            'div',
            { className: 'dtd-run-head' },
            h('strong', null, run.runId),
            h('span', { className: 'dtd-hint' }, '队长会话 · 派工与集成'),
            h('span', { className: 'dtd-badge ' + (attention ? 'blocked' : 'neutral') }, runMode(run)),
          ),
          h(
            'p',
            { className: 'dtd-hint' },
            [run.repoName, run.specId, run.integrationRef].filter(Boolean).join(' · '),
          ),
          h('p', null, '已集成 ', h('strong', null, complete + ' / ' + run.total), ' 张工单'),
          cleanupSummary(run.tickets) &&
            h('p', { className: 'dtd-hint', 'data-dag-cleanup': '' }, cleanupSummary(run.tickets)),
          run.attached === false &&
            h('p', { className: 'dtd-hint' }, '持久记录 · 当前宿主未接管，本页显示最近记录的工单状态。'),
        ),
        h(
          'section',
          { className: 'dtd-block', 'aria-label': '总进度' },
          h('h4', null, '总进度'),
          h('progress', {
            className: 'dtd-sr',
            max: run.total || 1,
            value: complete,
            'aria-label': '已集成工单',
          }),
          h(
            'div',
            { className: 'dtd-bar', 'data-dag-bar': '', 'aria-hidden': true },
            ...groups
              .filter(([, , n]) => n > 0)
              .map(([tone, , n]) =>
                h('span', { key: tone, 'data-dag-segment': tone, style: { flexGrow: n } }),
              ),
          ),
          h(
            'div',
            { className: 'dtd-legend', 'data-dag-legend': '' },
            ...groups
              .filter(([tone, , n]) => tone !== 'neutral' || n > 0)
              .map(([tone, title, n]) =>
                h(
                  'span',
                  { key: tone },
                  h('span', { className: 'dtd-dot', 'data-tone': tone }),
                  title + ' ' + n,
                ),
              ),
          ),
        ),
        attention > 0 &&
          h(
            'p',
            { className: 'dtd-banner', role: 'status' },
            h('span', { className: 'dtd-dot', 'data-tone': 'blocked' }),
            attention + ' 张工单需要处理',
          ),
        run.diagnostic && h('p', { className: 'dtd-alert' }, run.diagnostic),
        // The narrow sidebar leads with the map; the ticket list follows it.
        ...(compact ? [mapBlock, listBlock] : [listBlock, mapBlock]),
      )
    }

    // Columns are the longest dependency path from a root, so a ticket always
    // sits right of every upstream. A damaged ledger with a cycle still renders.
    function depthMap(tickets) {
      const byId = new Map(tickets.map((t) => [t.id, t]))
      const memo = new Map()
      function visit(id, trail) {
        if (memo.has(id)) return memo.get(id)
        if (trail.has(id)) return 0
        trail.add(id)
        const deps = (byId.get(id)?.dependsOn ?? []).filter((d) => byId.has(d))
        const depth = deps.length ? 1 + Math.max(...deps.map((d) => visit(d, trail))) : 0
        trail.delete(id)
        memo.set(id, depth)
        return depth
      }
      for (const t of tickets) visit(t.id, new Set())
      return memo
    }

    const fullNode = { width: 172, height: 76, gapX: 44, gapY: 14 }
    // Three columns fit a ~480px sidebar; deeper plans scroll sideways.
    const compactNode = { width: 136, height: 76, gapX: 26, gapY: 14 }

    function dagLayout(tickets, node = fullNode) {
      const depth = depthMap(tickets)
      const rowsUsed = []
      const at = new Map()
      for (const t of tickets) {
        const column = depth.get(t.id)
        const row = rowsUsed[column] ?? 0
        rowsUsed[column] = row + 1
        at.set(t.id, { x: column * (node.width + node.gapX), y: row * (node.height + node.gapY) })
      }
      const edges = []
      for (const t of tickets)
        for (const dep of t.dependsOn) {
          const from = at.get(dep)
          const to = at.get(t.id)
          if (!from) continue
          const [x1, y1] = [from.x + node.width, from.y + node.height / 2]
          const [x2, y2] = [to.x, to.y + node.height / 2]
          edges.push({ from: dep, to: t.id, d: `M${x1} ${y1}C${x1 + 20} ${y1},${x2 - 20} ${y2},${x2} ${y2}` })
        }
      const columns = Math.max(0, ...depth.values()) + 1
      const rows = Math.max(1, ...rowsUsed.filter(Boolean))
      return {
        at,
        edges,
        width: columns * node.width + (columns - 1) * node.gapX,
        height: rows * node.height + (rows - 1) * node.gapY,
      }
    }

    // Every ticket reachable upstream or downstream of id; cycle-safe.
    function chainOf(id, tickets) {
      const byId = new Map(tickets.map((t) => [t.id, t]))
      const walk = (next) => {
        const seen = new Set([id])
        const queue = [id]
        while (queue.length)
          for (const other of next(queue.pop()))
            if (!seen.has(other)) {
              seen.add(other)
              queue.push(other)
            }
        return seen
      }
      const up = walk((t) => byId.get(t)?.dependsOn ?? [])
      const down = walk((t) => tickets.filter((x) => x.dependsOn.includes(t)).map((x) => x.id))
      return new Set([...up, ...down])
    }

    // Each node card names its ID, owner and task; ownerOf(ticket) returns the
    // owner's { name, color }. compact (plan review) has no focus or detail card.
    function DependencyMap({ rows, hovered, setHovered, open, captain, compact = false, ownerOf }) {
      if (!rows.length) return null
      const tickets = rows.map((r) => r.ticket)
      const node = compact ? compactNode : fullNode
      const layout = dagLayout(tickets, node)
      if (compact) {
        // Nothing has started in a plan, so waiting tasks stay plain grey. Hover
        // or focus lights up a node's upstream and downstream and dims the rest.
        const lit = hovered && tickets.some((t) => t.id === hovered) ? chainOf(hovered, tickets) : null
        return h(
          'div',
          { className: 'dtd-graph', 'data-dag-map': '' },
          h(
            'div',
            { className: 'dtd-canvas', style: { width: layout.width, height: layout.height } },
            h(
              'svg',
              { width: layout.width, height: layout.height, 'aria-hidden': true },
              ...layout.edges.map((e) =>
                h('path', {
                  key: e.from + '>' + e.to,
                  'data-dag-edge': e.from + '>' + e.to,
                  d: e.d,
                  'data-active': lit ? lit.has(e.from) && lit.has(e.to) : undefined,
                }),
              ),
            ),
            ...rows.map(({ ticket, view }) => {
              const { x, y } = layout.at.get(ticket.id)
              const owner = ownerOf(ticket)
              // Focusable so keyboard users can reach each task and hear its state.
              return h(
                'div',
                {
                  key: ticket.id,
                  className: 'dtd-node dtd-node-compact',
                  'data-dag-node': ticket.id,
                  'data-tone': view.tone === 'wait' ? 'neutral' : view.tone,
                  'data-dim': lit ? !lit.has(ticket.id) : false,
                  onMouseEnter: () => setHovered?.(ticket.id),
                  onMouseLeave: () => setHovered?.(null),
                  onFocus: () => setHovered?.(ticket.id),
                  onBlur: () => setHovered?.(null),
                  tabIndex: 0,
                  role: 'group',
                  'aria-label': [ticket.id, owner.name, ticket.title !== ticket.id && ticket.title, view.label]
                    .filter(Boolean)
                    .join(' · '),
                  title: [ticket.id, owner.name, ticket.title].filter(Boolean).join(' · '),
                  style: { left: x, top: y, width: node.width, height: node.height },
                },
                h(
                  'span',
                  { className: 'dtd-node-head', 'data-tone': view.tone === 'wait' ? 'neutral' : view.tone },
                  h('span', { className: 'dtd-dot' }),
                  ticket.id,
                  h('small', { 'data-dag-color': owner.color, style: { color: owner.color } }, owner.name),
                ),
                ticket.title && ticket.title !== ticket.id && h('span', { className: 'dtd-node-title' }, ticket.title),
              )
            }),
          ),
        )
      }
      const urgent =
        rows.find((r) => r.ticket.status === 'NEEDS_ATTENTION') ??
        rows.find((r) => r.view.tone === 'work') ??
        rows.find((r) => r.ticket.status === 'PENDING') ??
        rows[0]
      const hit = rows.find((r) => r.ticket.id === hovered)
      const focus = hit ?? urgent
      // Only a hovered node lights up its chain; with nothing hovered the whole map stays undimmed.
      const chain = hit ? chainOf(hit.ticket.id, tickets) : null
      return h(
        'div',
        { className: 'dtd-section', 'data-dag-map': '' },
        h(
          'div',
          { className: 'dtd-graph' },
          h(
            'div',
            { className: 'dtd-canvas', style: { width: layout.width, height: layout.height } },
            h(
              'svg',
              { width: layout.width, height: layout.height, 'aria-hidden': true },
              ...layout.edges.map((e) =>
                h('path', {
                  key: e.from + '>' + e.to,
                  'data-dag-edge': e.from + '>' + e.to,
                  d: e.d,
                  'data-active': chain ? chain.has(e.from) && chain.has(e.to) : undefined,
                }),
              ),
            ),
            ...rows.map(({ ticket, view }) => {
              const { x, y } = layout.at.get(ticket.id)
              const owner = ownerOf(ticket)
              // The state is spelled out, not only coloured.
              const summary = [
                ticket.id,
                ticket.title !== ticket.id && ticket.title,
                view.label,
                view.stage,
                ticket.agent && [owner.name, ticket.model].filter(Boolean).join(' / '),
              ]
                .filter(Boolean)
                .join(' · ')
              return h(
                'button',
                {
                  key: ticket.id,
                  type: 'button',
                  className: 'dtd-node dtd-node-compact',
                  'data-dag-node': ticket.id,
                  'data-tone': view.tone,
                  'data-dim': chain ? !chain.has(ticket.id) : false,
                  'aria-label': summary,
                  title: summary,
                  style: { left: x, top: y, width: node.width, height: node.height },
                  // Pointer and keyboard focus both light up the chain and drive the detail card.
                  onMouseEnter: () => setHovered(ticket.id),
                  onMouseLeave: () => setHovered(null),
                  onFocus: () => setHovered(ticket.id),
                  onBlur: () => setHovered(null),
                },
                h(
                  'span',
                  { className: 'dtd-node-head', 'data-tone': view.tone },
                  h('span', { className: 'dtd-dot' }),
                  h(Avatar, { route: ticketRoute(ticket, captain), size: 16 }),
                  ticket.id,
                  h(StatusIcon, { tone: view.tone }),
                  // An unassigned ticket keeps its state here instead of a placeholder owner.
                  ticket.agent
                    ? h('small', { 'data-dag-color': owner.color, style: { color: owner.color } }, owner.name)
                    : h('small', null, view.label),
                ),
                ticket.title && ticket.title !== ticket.id && h('span', { className: 'dtd-node-title' }, ticket.title),
              )
            }),
          ),
        ),
        h(TicketDetail, { ...focus, tickets, open, member: ownerOf(focus.ticket) }),
      )
    }

    // Only a working ticket moves; the others get a still glyph in their tone colour.
    const statusGlyphs = {
      wait: 'M4 2h8M4 14h8M5 2c0 4 6 4 6 6s-6 2-6 6M11 2c0 4-6 4-6 6s6 2 6 6',
      done: 'M3 8.5l3.2 3L13 4.5',
      blocked: 'M8 1.5a6.5 6.5 0 1 0 0 13a6.5 6.5 0 1 0 0-13M8 4.5v4.2M8 11v.5',
    }
    function StatusIcon({ tone }) {
      if (tone === 'work') return h('span', { className: 'dtd-spin', 'aria-hidden': true })
      if (!statusGlyphs[tone]) return null
      return h(
        'svg',
        { className: 'dtd-status', 'data-tone': tone, viewBox: '0 0 16 16', 'aria-hidden': true },
        h('path', { d: statusGlyphs[tone] }),
      )
    }

    const stepLabels = {
      worktree: '工作树',
      launch: '启动',
      agent: '执行',
      receipt: '回执',
      merge: '试合并',
      verify: '验收',
      publish: '集成',
      cleanup: '清理',
    }

    // Live phase is only known for attached in-flight tickets; otherwise the
    // stepper is either done up to integration or untouched. The last step
    // follows the ticket's recorded worktree cleanup.
    function stepStates(ticket) {
      const order = Object.keys(stages)
      const live = ['RUNNING', 'SUBMITTED', 'PUBLISHING'].includes(ticket.status)
      const current = live ? order.indexOf(ticket.livePhase?.stage) : -1
      return order.map((stage, i) => [
        stage,
        stage === 'cleanup'
          ? ticket.cleanup === 'cleaned'
            ? 'done'
            : ticket.cleanup === 'skipped'
              ? 'skipped'
              : 'todo'
          : ticket.status === 'INTEGRATED' || i < current
            ? 'done'
            : i === current
              ? 'current'
              : 'todo',
      ])
    }

    // "已清理 N 张 / 跳过 M 张（原因）", or null before any cleanup result.
    function cleanupSummary(tickets) {
      const cleaned = tickets.filter((t) => t.cleanup === 'cleaned').length
      const skipped = tickets.filter((t) => t.cleanup === 'skipped')
      if (!cleaned && !skipped.length) return null
      const reasons = skipped.map((t) => t.id + '：' + (t.cleanupReason || '未说明')).join('；')
      return '已清理 ' + cleaned + ' 张 / 跳过 ' + skipped.length + ' 张' + (reasons ? '（' + reasons + '）' : '')
    }

    function TicketDetail({ ticket, view, tickets, open, member }) {
      const downstream = tickets.filter((t) => t.dependsOn.includes(ticket.id)).map((t) => t.id)
      const chat = chatButton(ticket, open)
      const upstream = ticket.dependsOn.length
        ? '上游 ' +
          ticket.dependsOn.join('、') +
          (view.missing.length ? ' · 等待 ' + view.missing.join('、') : ' · 均已集成')
        : '无上游工单'
      return h(
        'section',
        { className: 'dtd-card dtd-detail', 'data-dag-detail': ticket.id, 'aria-label': '工单 ' + ticket.id },
        h(
          'div',
          { className: 'dtd-run-head' },
          h('strong', null, ticket.id),
          ticket.title && ticket.title !== ticket.id && h('span', null, ticket.title),
          h('span', { className: 'dtd-badge ' + view.tone }, view.label),
        ),
        h('p', null, upstream),
        ticket.agent &&
          h('p', { className: 'dtd-hint' }, memberTag(member), ' · ' + (ticket.model || '宿主默认模型')),
        h(
          'ol',
          { className: 'dtd-steps', 'aria-label': '工单阶段' },
          ...stepStates(ticket).map(([stage, state]) =>
            h(
              'li',
              {
                key: stage,
                'data-dag-step': stage,
                'data-state': state,
                'aria-current': state === 'current' ? 'step' : undefined,
                title:
                  stage === 'cleanup' && state === 'skipped'
                    ? stages[stage] + ' · 已跳过：' + (ticket.cleanupReason || '未说明')
                    : stages[stage],
              },
              stepLabels[stage],
            ),
          ),
        ),
        view.stage && h('p', { className: 'dtd-phase' }, view.stage),
        h(
          'p',
          { className: 'dtd-hint' },
          (downstream.length ? '解锁 ' + downstream.join('、') : '无下游工单') +
            ' · 执行尝试 ' +
            (ticket.attempt ?? 0),
        ),
        ticket.message && ticket.status === 'NEEDS_ATTENTION' && h('p', { className: 'dtd-alert' }, ticket.message),
        chat && h('div', { className: 'dtd-actions' }, chat),
      )
    }

    // Vendor of a model route, recognised from the provider and model names.
    // Order matters: a routed name such as magpie/auto/claude-opus resolves by its model.
    const vendors = [
      ['deepseek', 'DeepSeek', /deepseek/, '#4d6bfe', 'DS'],
      ['claude', 'Claude', /claude|anthropic/, '#d97757', 'C'],
      ['gemini', 'Gemini', /gemini|google|vertex/, '#1a73e8', 'G'],
      ['grok', 'Grok', /grok|\bxai\b|x-ai/, '#3a3a3c', 'X'],
      ['gpt', 'GPT', /\bgpt|openai|chatgpt|\bo[134]\b/, '#10a37f', 'AI'],
      ['qwen', 'Qwen', /qwen|tongyi|dashscope/, '#615ced', 'Q'],
      ['kimi', 'Kimi', /kimi|moonshot/, '#16191d', 'K'],
      ['glm', 'GLM', /glm|zhipu/, '#3b5bdb', 'GL'],
    ]
    const genericVendor = ['generic', '通用模型', null, '#6b7280', '?']
    function vendorOf(provider, model) {
      const name = ((model || '') + ' ' + (provider || '')).toLowerCase()
      return (model && vendors.find(([, , pattern]) => pattern.test(name))) || genericVendor
    }

    // Official vendor icons from lobehub/lobe-icons (MIT, @lobehub/icons-static-svg@1.102.0),
    // each a list of [d, fill, fill-rule] paths on a 24-unit grid. A numeric fill
    // names a Gemini gradient; iconInk stands in for the icons' currentColor.
    const iconInk = '#1f1f1f'
    const geminiStar =
      'M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z'
    const vendorIcons = {
      deepseek: [
        ['M23.748 4.482c-.254-.124-.364.113-.512.234-.051.039-.094.09-.137.136-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.156-.708-.311-.955-.65-.172-.241-.219-.51-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.093.172.187.129.323-.082.28-.18.552-.266.833-.055.179-.137.217-.329.14a5.526 5.526 0 01-1.736-1.18c-.857-.828-1.631-1.742-2.597-2.458a11.365 11.365 0 00-.689-.471c-.985-.957.13-1.743.388-1.836.27-.098.093-.432-.779-.428-.872.004-1.67.295-2.687.684a3.055 3.055 0 01-.465.137 9.597 9.597 0 00-2.883-.102c-1.885.21-3.39 1.102-4.497 2.623C.082 8.606-.231 10.684.152 12.85c.403 2.284 1.569 4.175 3.36 5.653 1.858 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.133-.284 4.994-1.86.47.234.962.327 1.78.397.63.059 1.236-.03 1.705-.128.735-.156.684-.837.419-.961-2.155-1.004-1.682-.595-2.113-.926 1.096-1.296 2.746-2.642 3.392-7.003.05-.347.007-.565 0-.845-.004-.17.035-.237.23-.256a4.173 4.173 0 001.545-.475c1.396-.763 1.96-2.015 2.093-3.517.02-.23-.004-.467-.247-.588zM11.581 18c-2.089-1.642-3.102-2.183-3.52-2.16-.392.024-.321.471-.235.763.09.288.207.486.371.739.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.167-1.361-.802-2.5-1.86-3.301-3.307-.774-1.393-1.224-2.887-1.298-4.482-.02-.386.093-.522.477-.592a4.696 4.696 0 011.529-.039c2.132.312 3.946 1.265 5.468 2.774.868.86 1.525 1.887 2.202 2.891.72 1.066 1.494 2.082 2.48 2.914.348.292.625.514.891.677-.802.09-2.14.11-3.054-.614zm1-6.44a.306.306 0 01.415-.287.302.302 0 01.2.288.306.306 0 01-.31.307.303.303 0 01-.304-.308zm3.11 1.596c-.2.081-.399.151-.59.16a1.245 1.245 0 01-.798-.254c-.274-.23-.47-.358-.552-.758a1.73 1.73 0 01.016-.588c.07-.327-.008-.537-.239-.727-.187-.156-.426-.199-.688-.199a.559.559 0 01-.254-.078c-.11-.054-.2-.19-.114-.358.028-.054.16-.186.192-.21.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.391.451.462.576.685.914.176.265.336.537.445.848.067.195-.019.354-.25.452z', '#4D6BFE'],
      ],
      claude: [
        ['M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z', '#D97757', 'nonzero'],
      ],
      gemini: [
        [geminiStar, '#3186FF'],
        [geminiStar, 0],
        [geminiStar, 1],
        [geminiStar, 2],
      ],
      grok: [
        ['M9.27 15.29l7.978-5.897c.391-.29.95-.177 1.137.272.98 2.369.542 5.215-1.41 7.169-1.951 1.954-4.667 2.382-7.149 1.406l-2.711 1.257c3.889 2.661 8.611 2.003 11.562-.953 2.341-2.344 3.066-5.539 2.388-8.42l.006.007c-.983-4.232.242-5.924 2.75-9.383.06-.082.12-.164.179-.248l-3.301 3.305v-.01L9.267 15.292M7.623 16.723c-2.792-2.67-2.31-6.801.071-9.184 1.761-1.763 4.647-2.483 7.166-1.425l2.705-1.25a7.808 7.808 0 00-1.829-1A8.975 8.975 0 005.984 5.83c-2.533 2.536-3.33 6.436-1.962 9.764 1.022 2.487-.653 4.246-2.34 6.022-.599.63-1.199 1.259-1.682 1.925l7.62-6.815', iconInk, 'evenodd'],
      ],
      gpt: [
        ['M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z', iconInk, 'evenodd'],
      ],
      qwen: [
        ['M19.713 2.825h-5.907c0-.251-.066-.503-.196-.728L12.819.728A1.46 1.46 0 0 0 11.559 0h-1.58c-.52 0-1 .275-1.26.728l-2.42 4.19a1.45 1.45 0 0 0 0 1.453l.791 1.37c.26.448.74.727 1.26.727h11.36c.52 0 1-.275 1.26-.728l.79-1.37a1.45 1.45 0 0 0 0-1.451l-.79-1.37a1.46 1.46 0 0 0-1.26-.728zM.195 9.905l2.951 5.115a1.46 1.46 0 0 0-.531.531l-.791 1.37a1.45 1.45 0 0 0 0 1.452l.79 1.37c.26.448.74.727 1.26.727h4.84c.52 0 1-.275 1.26-.728l.79-1.37a1.45 1.45 0 0 0 0-1.451L5.086 7.083a1.46 1.46 0 0 0-1.26-.728h-1.58c-.52 0-1 .276-1.26.728l-.79 1.37a1.45 1.45 0 0 0 0 1.452m15.888 13.367 2.951-5.115c.217.125.469.196.728.196h1.582c.52 0 1-.275 1.26-.728l.79-1.37a1.45 1.45 0 0 0 0-1.451l-2.42-4.191a1.46 1.46 0 0 0-1.259-.728h-1.582c-.52 0-1 .276-1.259.728l-5.678 9.838a1.45 1.45 0 0 0 0 1.452l.79 1.37c.26.448.74.727 1.26.727h1.582c.52 0 1-.275 1.26-.728z', '#082dff'],
      ],
      kimi: [
        ['M21.846 0a1.923 1.923 0 110 3.846H20.15a.226.226 0 01-.227-.226V1.923C19.923.861 20.784 0 21.846 0z', '#1783FF'],
        ['M11.065 11.199l7.257-7.2c.137-.136.06-.41-.116-.41H14.3a.164.164 0 00-.117.051l-7.82 7.756c-.122.12-.302.013-.302-.179V3.82c0-.127-.083-.23-.185-.23H3.186c-.103 0-.186.103-.186.23V19.77c0 .128.083.23.186.23h2.69c.103 0 .186-.102.186-.23v-3.25c0-.069.025-.135.069-.178l2.424-2.406a.158.158 0 01.205-.023l6.484 4.772a7.677 7.677 0 003.453 1.283c.108.012.2-.095.2-.23v-3.06c0-.117-.07-.212-.164-.227a5.028 5.028 0 01-2.027-.807l-5.613-4.064c-.117-.078-.132-.279-.028-.381z', iconInk],
      ],
      glm: [
        ['M11.991 23.503a.24.24 0 00-.244.248.24.24 0 00.244.249.24.24 0 00.245-.249.24.24 0 00-.22-.247l-.025-.001zM9.671 5.365a1.697 1.697 0 011.099 2.132l-.071.172-.016.04-.018.054c-.07.16-.104.32-.104.498-.035.71.47 1.279 1.186 1.314h.366c1.309.053 2.338 1.173 2.286 2.523-.052 1.332-1.152 2.38-2.478 2.327h-.174c-.715.018-1.274.64-1.239 1.368 0 .124.018.23.053.337.209.373.54.658.96.8.75.23 1.517-.125 1.9-.782l.018-.035c.402-.64 1.17-.96 1.92-.711.854.284 1.378 1.226 1.099 2.167a1.661 1.661 0 01-2.077 1.102 1.711 1.711 0 01-.907-.711l-.017-.035c-.2-.323-.463-.58-.851-.711l-.056-.018a1.646 1.646 0 00-1.954.746 1.66 1.66 0 01-1.065.764 1.677 1.677 0 01-1.989-1.279c-.209-.906.332-1.83 1.257-2.043a1.51 1.51 0 01.296-.035h.018c.68-.071 1.151-.622 1.116-1.333a1.307 1.307 0 00-.227-.693 2.515 2.515 0 01-.366-1.403 2.39 2.39 0 01.366-1.208c.14-.195.21-.444.227-.693.018-.71-.506-1.261-1.186-1.332l-.07-.018a1.43 1.43 0 01-.299-.07l-.05-.019a1.7 1.7 0 01-1.047-2.114 1.68 1.68 0 012.094-1.101zm-5.575 10.11c.26-.264.639-.367.994-.27.355.096.633.379.728.74.095.362-.007.748-.267 1.013-.402.41-1.053.41-1.455 0a1.062 1.062 0 010-1.482zm14.845-.294c.359-.09.738.024.992.297.254.274.344.665.237 1.025-.107.36-.396.634-.756.718-.551.128-1.1-.22-1.23-.781a1.05 1.05 0 01.757-1.26zm-.064-4.39c.314.32.49.753.49 1.206 0 .452-.176.886-.49 1.206-.315.32-.74.5-1.185.5-.444 0-.87-.18-1.184-.5a1.727 1.727 0 010-2.412 1.654 1.654 0 012.369 0zm-11.243.163c.364.484.447 1.128.218 1.691a1.665 1.665 0 01-2.188.923c-.855-.36-1.26-1.358-.907-2.228a1.68 1.68 0 011.33-1.038c.593-.08 1.183.169 1.547.652zm11.545-4.221c.368 0 .708.2.892.524.184.324.184.724 0 1.048a1.026 1.026 0 01-.892.524c-.568 0-1.03-.47-1.03-1.048 0-.579.462-1.048 1.03-1.048zm-14.358 0c.368 0 .707.2.891.524.184.324.184.724 0 1.048a1.026 1.026 0 01-.891.524c-.569 0-1.03-.47-1.03-1.048 0-.579.461-1.048 1.03-1.048zm10.031-1.475c.925 0 1.675.764 1.675 1.706s-.75 1.705-1.675 1.705-1.674-.763-1.674-1.705c0-.942.75-1.706 1.674-1.706zm-2.626-.684c.362-.082.653-.356.761-.718a1.062 1.062 0 00-.238-1.028 1.017 1.017 0 00-.996-.294c-.547.14-.881.7-.752 1.257.13.558.675.907 1.225.783zm0 16.876c.359-.087.644-.36.75-.72a1.062 1.062 0 00-.237-1.019 1.018 1.018 0 00-.985-.301 1.037 1.037 0 00-.762.717c-.108.361-.017.754.239 1.028.245.263.606.377.953.305l.043-.01zM17.19 3.5a.631.631 0 00.628-.64c0-.355-.279-.64-.628-.64a.631.631 0 00-.628.64c0 .355.28.64.628.64zm-10.38 0a.631.631 0 00.628-.64c0-.355-.28-.64-.628-.64a.631.631 0 00-.628.64c0 .355.279.64.628.64zm-5.182 7.852a.631.631 0 00-.628.64c0 .354.28.639.628.639a.63.63 0 00.627-.606l.001-.034a.62.62 0 00-.628-.64zm5.182 9.13a.631.631 0 00-.628.64c0 .355.279.64.628.64a.631.631 0 00.628-.64c0-.355-.28-.64-.628-.64zm10.38.018a.631.631 0 00-.628.64c0 .355.28.64.628.64a.631.631 0 00.628-.64c0-.355-.279-.64-.628-.64zm5.182-9.148a.631.631 0 00-.628.64c0 .354.279.639.628.639a.631.631 0 00.628-.64c0-.355-.28-.64-.628-.64zm-.384-4.992a.24.24 0 00.244-.249.24.24 0 00-.244-.249.24.24 0 00-.244.249c0 .142.122.249.244.249zM11.991.497a.24.24 0 00.245-.248A.24.24 0 0011.99 0a.24.24 0 00-.244.249c0 .133.108.236.223.247l.021.001zM2.011 6.36a.24.24 0 00.245-.249.24.24 0 00-.244-.249.24.24 0 00-.244.249.24.24 0 00.244.249zm0 11.263a.24.24 0 00-.243.248.24.24 0 00.244.249.24.24 0 00.244-.249.252.252 0 00-.244-.248zm19.995-.018a.24.24 0 00-.245.248.24.24 0 00.245.25.24.24 0 00.244-.25.252.252 0 00-.244-.248z', '#3859FF', 'nonzero'],
      ],
    }

    // Gemini's colour washes; each icon instance gets its own ids (see VendorIcon).
    const geminiGradients = [
      ['7', '11', '15.5', '12', '#08B962', '1'],
      ['8', '11.5', '5.5', '11', '#F94543', '1'],
      ['3.5', '17.5', '13.5', '12', '#FABC12', '.46'],
    ]
    let gradientSeq = 0

    // A vendor's official icon (lobehub/lobe-icons, MIT) on its 24-unit grid,
    // drawn at (x, y) with the given size inside an enclosing svg.
    function VendorIcon({ id, x, y, size }) {
      const seq = useRef(null)
      if (seq.current === null) seq.current = ++gradientSeq
      const gradient = (i) => 'dtd-gemini-' + seq.current + '-' + i
      return h(
        'svg',
        { x, y, width: size, height: size, viewBox: '0 0 24 24', 'data-dag-vendor-icon': id },
        id === 'gemini' &&
          h(
            'defs',
            null,
            geminiGradients.map(([x1, x2, y1, y2, color, end], i) =>
              h(
                'linearGradient',
                { key: i, id: gradient(i), gradientUnits: 'userSpaceOnUse', x1, x2, y1, y2 },
                h('stop', { stopColor: color }),
                h('stop', { offset: end, stopColor: color, stopOpacity: 0 }),
              ),
            ),
          ),
        vendorIcons[id].map(([d, fill, fillRule], i) =>
          h('path', { key: i, d, fill: typeof fill === 'number' ? 'url(#' + gradient(fill) + ')' : fill, fillRule }),
        ),
      )
    }

    // A recognised vendor shows its official icon on a light disc, which keeps
    // colour icons legible in either theme. With color it is a plan-review
    // member: the disc is ringed in the member colour, and a member on the host
    // default shows the captain's vendor. An unknown model keeps a plain figure:
    // in the member colour for a member, else the grey ? figure.
    function Avatar({ route, captain, size = 28, color: memberColor, tag: showTag = true }) {
      const own = vendorOf(route?.provider, route?.model)
      const [id, name, , vendorColor, tag] =
        memberColor && route && !route.model ? vendorOf(captain?.provider, captain?.model) : own
      const color = memberColor ?? vendorColor
      const figure = (fill) => [
        h('circle', { key: 'b', cx: 16, cy: 16, r: 16, fill }),
        h('circle', { key: 'h', cx: 16, cy: 12.5, r: 5.5, fill: '#fff', fillOpacity: 0.92 }),
        h('path', { key: 's', d: 'M6.5 27.5c1.3-5.8 5.1-8.8 9.5-8.8s8.2 3 9.5 8.8z', fill: '#fff', fillOpacity: 0.92 }),
      ]
      const disc = h('circle', {
        key: 'd',
        cx: 16,
        cy: 16,
        r: memberColor ? 15 : 15.5,
        fill: '#fff',
        stroke: memberColor ?? '#d4d4d8',
        strokeWidth: memberColor ? 2 : 1,
      })
      const known = id !== 'generic'
      return h(
        'span',
        {
          className: 'dtd-avatar',
          'data-dag-avatar': known ? id : memberColor ? 'member' : id,
          'data-dag-color': color,
          title: known || !memberColor ? name : undefined,
          style: { width: size, height: size },
        },
        h(
          'svg',
          { viewBox: '0 0 32 32', width: size, height: size, 'aria-hidden': true },
          known ? [disc, h(VendorIcon, { key: 'i', id, x: 6, y: 6, size: 20 })] : figure(color),
        ),
        !memberColor && !known && showTag && h('span', { className: 'dtd-avatar-tag', style: { background: color } }, tag),
      )
    }

    // Short display name of a route: the catalog name, else the last path segment.
    function routeName(route, catalog) {
      if (!route?.model) return ''
      const known = catalog?.providers?.find((p) => p.id === route.provider)?.models.find((m) => m.id === route.model)
      return known?.name ?? route.model.split('/').pop()
    }

    // The captain is the conversation that called dag_run; it plans, submits and is notified.
    function CaptainCard({ run, catalog }) {
      const route = run.captain
      return h(
        'section',
        { className: 'dtd-block', 'data-dag-captain': '' },
        h('h4', null, '队长'),
        h(
          'div',
          { className: 'dtd-captain' },
          h(Avatar, { route, size: 30, tag: false }),
          h('span', null, '队长 · 当前对话'),
          h('span', { className: 'dtd-captain-model' }, routeName(route, catalog) || '对话未打开，模型未知'),
        ),
      )
    }

    // Plan-review member colours, assigned by a stable member order.
    const memberColors = ['#6d8cf5', '#3fbf8a', '#b07ce8', '#f0a04b', '#e8697a', '#41b6c9', '#c9a227', '#8a94a6']
    // Shared by the plan review and the progress board. Presets saved before
    // display names existed fall back to the built-in name; '' is the default worker.
    const memberName = (id, presets) =>
      id ? presets?.find((p) => p.id === id)?.name || builtinAgents[id]?.name || id : '默认成员'
    // ids is every possible owner in a stable order, which fixes each member colour.
    const memberColor = (ids, id) => memberColors[Math.max(0, ids.indexOf(id)) % memberColors.length]
    const routeFields = (r) => ({
      provider: r?.provider ?? '',
      model: r?.model ?? '',
      reasoningEffort: r?.reasoningEffort ?? '',
    })

    // Header picker for checked members. It starts on a "修改模型" placeholder, so
    // nothing changes until a model is picked; effort follows the picked model.
    function BulkPicker({ bulk, catalog, disabled, onModel, onEffort }) {
      const providers = catalog?.providers ?? []
      const known = bulk && providers.find((p) => p.id === bulk.provider)?.models.find((m) => m.id === bulk.model)
      const efforts = known?.efforts ?? []
      return h(
        'div',
        { className: 'dtd-route' },
        h(
          'select',
          {
            'aria-label': '批量修改模型',
            value: bulk ? routeKey(bulk.provider, bulk.model) : '__pick',
            disabled,
            onChange: (e) => {
              if (e.target.value === '__pick') return
              const [provider, model] = e.target.value ? JSON.parse(e.target.value) : ['', '']
              onModel(provider, model)
            },
          },
          h('option', { value: '__pick', disabled: true }, '修改模型'),
          h('option', { value: '' }, '宿主默认'),
          ...providers.map((p) =>
            h(
              'optgroup',
              { key: p.id, label: p.name },
              ...p.models.map((m) => h('option', { key: m.id, value: routeKey(p.id, m.id) }, m.name)),
            ),
          ),
        ),
        h(
          'select',
          {
            'aria-label': '批量修改推理强度',
            value: bulk?.effortSet ? bulk.reasoningEffort : '__pick',
            disabled: disabled || !efforts.length,
            onChange: (e) => e.target.value !== '__pick' && onEffort(e.target.value),
          },
          h('option', { value: '__pick', disabled: true }, '推理强度'),
          h('option', { value: '' }, '模型默认'),
          ...efforts.map((x) => h('option', { key: x.id, value: x.id }, x.name)),
        ),
      )
    }

    // Focus the conversation composer so the user can tell the captain what to change.
    function backToChat() {
      if (typeof document === 'undefined') return
      document
        .querySelector('[data-composer-card] [contenteditable="true"][role="textbox"], [data-composer-card] textarea')
        ?.focus()
    }

    // A staged run waits for the user. Members are the presets that own tasks:
    // each member's model applies to all of its tasks; a task row expands to
    // change its owner. Approve starts dispatch; discard cancels the plan.
    function PlanReview({ run, refresh }) {
      const [owners, setOwners] = useState(null)
      const [routes, setRoutes] = useState(null)
      const [catalog, setCatalog] = useState(null)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const [confirmDiscard, setConfirmDiscard] = useState(false)
      // Members the header picker changes, the task row being edited, and the
      // header picker's last choice (null until a model is picked).
      const [checked, setChecked] = useState(() => new Set())
      const [expanded, setExpanded] = useState(null)
      const [bulk, setBulk] = useState(null)
      // The map node under the pointer or keyboard focus.
      const [hovered, setHovered] = useState(null)
      useEffect(() => {
        const ctrl = new AbortController()
        fetch('api/ticket-dag.models', { signal: ctrl.signal, cache: 'no-store' })
          .then((r) => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
          .then((data) => setCatalog(Array.isArray(data?.providers) ? data : { error: true }))
          .catch((e) => e.name !== 'AbortError' && setCatalog({ error: true }))
        return () => ctrl.abort()
      }, [])
      const models = catalog?.error ? null : catalog
      const presets = run.presets ?? []
      const presetOf = (id) => presets.find((p) => p.id === id)
      const plannedOwners = Object.fromEntries(run.tickets.map((t) => [t.id, t.agent ?? '']))
      const currentOwners = owners ?? plannedOwners
      // Every possible owner, in a stable order that also fixes each member colour.
      const allIds = [
        ...new Set([...presets.map((p) => p.id), ...Object.values(plannedOwners), ...Object.values(currentOwners)]),
      ]
      const plannedRoutes = Object.fromEntries(
        allIds.map((id) => {
          const first = run.tickets.find((t) => (t.agent ?? '') === id && t.route)
          return [id, routeFields(first ? first.route : presetOf(id))]
        }),
      )
      const currentRoutes = routes ?? plannedRoutes
      const routeOf = (id) => currentRoutes[id] ?? routeFields(presetOf(id))
      const owned = (id) => run.tickets.filter((t) => currentOwners[t.id] === id).map((t) => t.id)
      const memberIds = [...presets.map((p) => p.id), ...allIds.filter((id) => id && !presetOf(id)), ''].filter(
        (id) => owned(id).length,
      )
      const nameOf = (id) => memberName(id, presets)
      const colorOf = (id) => memberColor(allIds, id)
      const edges = run.tickets.reduce((n, t) => n + t.dependsOn.length, 0)
      const byId = new Map(run.tickets.map((t) => [t.id, t]))
      const rows = run.tickets.map((ticket) => ({ ticket, view: ticketView(ticket, byId, 'staged') }))
      const changed = owners !== null || routes !== null
      const allChecked = memberIds.length > 0 && memberIds.every((id) => checked.has(id))
      const toggle = (id) =>
        setChecked((old) => {
          const next = new Set(old)
          if (!next.delete(id)) next.add(id)
          return next
        })
      // A member row changes only that member.
      const changeRoute = (id, fn) =>
        setRoutes((old) => {
          const next = structuredClone(old ?? plannedRoutes)
          next[id] = { ...(next[id] ?? routeFields(presetOf(id))) }
          fn(next[id])
          return next
        })
      // The header picker writes to every checked member.
      const changeChecked = (fn) =>
        setRoutes((old) => {
          const next = structuredClone(old ?? plannedRoutes)
          for (const member of checked) {
            next[member] = { ...(next[member] ?? routeFields(presetOf(member))) }
            fn(next[member])
          }
          return next
        })
      const bulkModel = (provider, model) => {
        setBulk({ provider, model, reasoningEffort: '', effortSet: false })
        changeChecked((r) => Object.assign(r, { provider, model, reasoningEffort: '' }))
      }
      const bulkEffort = (reasoningEffort) => {
        setBulk((old) => ({ ...old, reasoningEffort, effortSet: true }))
        changeChecked((r) => {
          r.reasoningEffort = reasoningEffort
        })
      }
      async function send(body) {
        setBusy(true)
        setError('')
        try {
          const response = await fetch('api/ticket-dag.approve', {
            method: 'POST',
            // The host refuses an approval without this header (CSRF guard).
            headers: { 'content-type': 'application/json', 'x-dsh-ticket-dag': '1' },
            body: JSON.stringify({ key: run.key, ...body }),
          })
          if (!response.ok) throw new Error((await response.text()) || 'HTTP ' + response.status)
          refresh()
        } catch (err) {
          setError(err.message || '操作失败，请重试。')
        } finally {
          setBusy(false)
        }
      }
      const approve = () =>
        send({
          action: 'approve',
          choices: run.tickets.map((t) => ({ id: t.id, agent: currentOwners[t.id], ...routeOf(currentOwners[t.id]) })),
        })
      const step = changed ? 1 : 0
      const blocked = busy || run.attached === false
      return h(
        'section',
        { className: 'dtd-section dtd-review', 'data-dag-review': '', 'aria-label': '执行前计划审查' },
        h(
          'header',
          { className: 'dtd-review-head' },
          h('p', { className: 'dtd-run-name', 'data-dag-run-title': '' }, '工单 · ' + run.runId),
          h(
            'div',
            { className: 'dtd-review-title' },
            h('h3', null, '执行前计划审查'),
            h('span', { className: 'dtd-pill' }, '待确认'),
          ),
          h(
            'p',
            { className: 'dtd-hint' },
            memberIds.length + ' 名成员 · ' + run.tickets.length + ' 项任务 · ' + edges + ' 条依赖',
          ),
          h(
            'ol',
            { className: 'dtd-wizard', 'aria-label': '审查步骤' },
            ...['审查计划', '确认模型', '开始执行'].map((label, i) =>
              h(
                'li',
                {
                  key: label,
                  'data-state': i === step ? 'current' : i < step ? 'done' : 'todo',
                  'aria-current': i === step ? 'step' : undefined,
                },
                h('span', null, i + 1),
                label,
              ),
            ),
          ),
        ),
        run.attached === false &&
          h('p', { className: 'dtd-alert', role: 'status' }, '这轮计划的队长对话当前未打开。请先打开发起它的对话，再在这里确认。'),
        catalog?.error && h('p', { className: 'dtd-alert', role: 'status' }, '模型列表暂不可用，仍可保留预设里的模型。'),
        h(
          'section',
          { className: 'dtd-block', 'aria-label': '成员与模型' },
          h(
            'div',
            { className: 'dtd-member-head' },
            h('input', {
              type: 'checkbox',
              'aria-label': '全选成员',
              checked: allChecked,
              disabled: busy,
              onChange: (e) => setChecked(e.target.checked ? new Set(memberIds) : new Set()),
            }),
            h('h4', null, '成员', checked.size > 0 && h('small', { className: 'dtd-hint' }, ' 已选 ' + checked.size)),
            h('span', { className: 'dtd-hint' }, '负责任务'),
            checked.size > 0
              ? h(BulkPicker, { bulk, catalog: models, disabled: busy, onModel: bulkModel, onEffort: bulkEffort })
              : [h('span', { key: 'm', className: 'dtd-hint' }, '模型'), h('span', { key: 'e', className: 'dtd-hint' }, '推理强度')],
          ),
          // The captain leads the list; its model is the conversation's and cannot change here.
          h(
            'div',
            { key: 'captain', className: 'dtd-member', 'data-dag-captain': '' },
            h('span', null),
            h(Avatar, { route: run.captain, size: 34, tag: false }),
            h('span', { className: 'dtd-member-name' }, h('strong', null, '队长'), h('small', null, '当前对话')),
            h('span', { className: 'dtd-member-tasks' }, '拆解 · 派发 · 汇总'),
            h(
              'span',
              { className: 'dtd-member-captain-model', title: '队长使用当前对话的模型，这里不能修改' },
              routeName(run.captain, models) || '对话未打开，模型未知',
            ),
          ),
          ...memberIds.map((id) =>
            h(
              'div',
              { key: id || '-', className: 'dtd-member', 'data-dag-member': id },
              h('input', {
                type: 'checkbox',
                'aria-label': '选择 ' + nameOf(id),
                checked: checked.has(id),
                disabled: busy,
                onChange: () => toggle(id),
              }),
              h(Avatar, { route: routeOf(id), captain: run.captain, color: colorOf(id), size: 34 }),
              h('span', { className: 'dtd-member-name' }, h('strong', null, nameOf(id))),
              h('span', { className: 'dtd-member-tasks', 'data-dag-member-tasks': '' }, '负责 ' + owned(id).join('、')),
              h(ModelPicker, {
                agent: { id, ...routeOf(id) },
                label: nameOf(id),
                catalog: models,
                bare: true,
                disabled: busy,
                modify: (fn) => changeRoute(id, fn),
              }),
            ),
          ),
          changed &&
            h(
              'div',
              { className: 'dtd-member-foot' },
              button(
                '恢复计划原值',
                () => {
                  setOwners(null)
                  setRoutes(null)
                },
                { disabled: busy },
              ),
            ),
        ),
        h(
          'section',
          { className: 'dtd-block', 'aria-label': '任务与依赖' },
          h('h4', null, '任务与依赖'),
          h(
            'ul',
            { className: 'dtd-tasks' },
            ...run.tickets.map((t) => {
              const owner = currentOwners[t.id]
              const open = expanded === t.id
              return h(
                'li',
                { key: t.id, className: 'dtd-task', 'data-dag-task': t.id },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dtd-task-row',
                    'aria-expanded': open,
                    onClick: () => setExpanded(open ? null : t.id),
                  },
                  h('span', { className: 'dtd-chip' }, t.id),
                  h('span', { className: 'dtd-task-title' }, t.title || t.id),
                  appendedTag(t),
                  h(
                    'span',
                    { className: 'dtd-hint' },
                    nameOf(owner) + ' · ' + (t.dependsOn.length ? '等待 ' + t.dependsOn.join('、') : '可开始'),
                  ),
                  h('span', { className: 'dtd-chevron', 'aria-hidden': true }, '›'),
                ),
                open &&
                  h(
                    'div',
                    { className: 'dtd-task-edit' },
                    h(
                      'label',
                      null,
                      h('span', null, '负责人'),
                      h(
                        'select',
                        {
                          'aria-label': t.id + ' 的负责人',
                          value: owner,
                          disabled: busy,
                          onChange: (e) =>
                            setOwners((old) => ({ ...(old ?? plannedOwners), [t.id]: e.target.value })),
                        },
                        ...presets.map((p) => h('option', { key: p.id, value: p.id }, p.name || p.id)),
                        owner && !presetOf(owner) && h('option', { value: owner }, owner + '（配置中已没有）'),
                        h('option', { value: '' }, '默认成员（不使用预设）'),
                      ),
                    ),
                  ),
              )
            }),
          ),
        ),
        h(
          'section',
          { className: 'dtd-block', 'aria-label': '依赖图' },
          h('h4', null, '依赖图'),
          h(DependencyMap, {
            rows,
            compact: true,
            hovered,
            setHovered,
            ownerOf: (t) => ({ name: nameOf(currentOwners[t.id]), color: colorOf(currentOwners[t.id]) }),
          }),
          h(
            'p',
            { className: 'dtd-hint dtd-map-hint', role: 'status' },
            byId.has(hovered)
              ? [
                  hovered + ' 依赖 ' + (byId.get(hovered).dependsOn.join('、') || '无'),
                  '被 ' + (run.tickets.filter((t) => t.dependsOn.includes(hovered)).map((t) => t.id).join('、') || '无') + ' 依赖',
                ].join(' · ')
              : '悬停节点查看它的依赖和被依赖关系',
          ),
        ),
        error && h('p', { className: 'dtd-alert', role: 'alert' }, error),
        h(
          'div',
          { className: 'dtd-actionbar', 'data-dag-actions': '' },
          h('button', { type: 'button', className: 'dtd-primary', disabled: blocked, onClick: approve }, '确认并启动'),
          button('返回对话修改', backToChat),
          button(
            confirmDiscard ? '再次点击确认放弃' : '放弃本次计划',
            () => (confirmDiscard ? send({ action: 'discard' }) : setConfirmDiscard(true)),
            { disabled: blocked, className: 'dtd-danger' },
          ),
        ),
      )
    }

    const dashboardUrl = (key, sessionId) => {
      const query = new URLSearchParams()
      if (key) query.set('key', key)
      if (sessionId) query.set('parent', sessionId)
      const text = query.toString()
      return 'api/ticket-dag.dashboard' + (text ? '?' + text : '')
    }

    // Poll intervals in milliseconds: the open board tab, the conversation header
    // entry, a run that has finished, and the longest retry after failures.
    const tabPollMs = 2000
    const entryPollMs = 5000
    const settledPollMs = 30000
    const maxBackoffMs = 30000
    const backoff = (base, failures) => Math.min(maxBackoffMs, base * 2 ** failures)
    const pageHidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden'

    // Runs tick() now and again after the delay it resolves to; null stops.
    // One tick at a time: a call during a tick runs once more right after it.
    // While the page is hidden no tick runs; showing it ticks at once.
    function poller(tick) {
      let timer,
        running = false,
        again = false,
        stopped = false
      async function run() {
        clearTimeout(timer)
        if (stopped) return
        if (running) {
          again = true
          return
        }
        if (pageHidden()) return
        running = true
        let delay = null
        try {
          delay = await tick()
        } finally {
          running = false
          if (!stopped && (again || delay !== null)) timer = setTimeout(run, again ? 0 : delay)
          again = false
        }
      }
      const onVisibility = () => void (!pageHidden() && run())
      if (typeof document !== 'undefined') document.addEventListener?.('visibilitychange', onVisibility)
      void run()
      return {
        run,
        stop() {
          stopped = true
          clearTimeout(timer)
          if (typeof document !== 'undefined') document.removeEventListener?.('visibilitychange', onVisibility)
        },
      }
    }

    // Only one request at a time. A changed selection supersedes an older
    // response; unmount aborts the pending read and clears the next timer.
    // A failed read keeps the last snapshot and retries with backoff; a 404
    // for the pinned run stops polling.
    // With sessionId (the conversation sidebar) only that captain's runs show.
    // runKey pins the board to one run (one sidebar tab per run); without it
    // the board follows this conversation's newest run.
    function Dashboard({ sessionId, openChild, runKey } = {}) {
      const [data, setData] = useState(null)
      const [selectedKey, setSelectedKey] = useState(runKey ?? '')
      const [error, setError] = useState('')
      const [lastRead, setLastRead] = useState(null)
      const target = useRef(runKey ?? '')
      const refresh = useRef(null)
      useEffect(() => {
        let disposed = false,
          active = null,
          failures = 0,
          settled = false
        async function tick() {
          active = new AbortController()
          const key = target.current
          const timeout = setTimeout(() => active?.abort(), 12000)
          try {
            const response = await fetch(dashboardUrl(key, sessionId), { signal: active.signal, cache: 'no-store' })
            if (disposed) return null
            if (response.status === 404 && key && !runKey && key === target.current) {
              target.current = ''
              setSelectedKey('')
              setData(null)
              setLastRead(null)
              return 0
            }
            if (response.status === 404) {
              if (key === target.current) setError('运行记录已不可用（HTTP 404），已停止自动刷新。')
              return null
            }
            if (!response.ok)
              throw new Error(
                response.status === 401 || response.status === 403
                  ? '当前连接没有读取运行进度的权限。'
                  : '读取进度失败（HTTP ' + response.status + '）。',
              )
            const view = await response.json()
            if (!Array.isArray(view?.runs) || (view.selected && !Array.isArray(view.selected.tickets))) {
              throw new Error('宿主未返回有效的运行快照。')
            }
            if (disposed) return null
            failures = 0
            if (key !== target.current) return tabPollMs
            const selected = view.selected?.key ?? ''
            settled = Boolean(view.selected?.complete || view.selected?.mode === 'cancelled')
            target.current = selected
            setSelectedKey(selected)
            setData(view)
            setError('')
            setLastRead(new Date())
            return settled ? settledPollMs : tabPollMs
          } catch (err) {
            if (disposed) return null
            failures++
            if (key === target.current)
              setError(
                err.name === 'AbortError'
                  ? '读取进度超时，将自动重试。'
                  : '进度暂不可用。' + (err.message ?? ''),
              )
            return backoff(settled ? settledPollMs : tabPollMs, failures)
          } finally {
            clearTimeout(timeout)
            active = null
          }
        }
        const polling = poller(tick)
        refresh.current = polling.run
        return () => {
          disposed = true
          polling.stop()
          active?.abort()
          refresh.current = null
        }
      }, [sessionId, runKey])
      const selected = data?.selected?.key === selectedKey ? data.selected : null
      // The plan review carries its own title.
      const reviewing = selected?.mode === 'staged'
      return h(
        'section',
        { className: 'dtd-panel dtd-dashboard', 'aria-label': 'DAG 运行进度' },
        h('style', null, styles),
        !reviewing &&
          h(
            'div',
            { className: 'dtd-head' },
            // The tab title is cut short in a narrow sidebar; the full run ID leads the panel.
            selected
              ? h('h3', { className: 'dtd-run-name', 'data-dag-run-title': '' }, '工单 · ' + selected.runId)
              : h('h3', null, '运行进度'),
            button('刷新进度', () => {
              void refresh.current?.()
            }),
          ),
        !reviewing &&
          h(
            'p',
            { className: 'dtd-hint' },
            selected?.complete || selected?.mode === 'cancelled'
              ? '运行已结束，每 ' + settledPollMs / 1000 + ' 秒检查一次。'
              : '每 ' + tabPollMs / 1000 + ' 秒检查运行状态。',
            lastRead && ' 最近更新 ' + lastRead.toLocaleTimeString('zh-CN'),
          ),
        error && h('p', { className: 'dtd-alert', role: 'status' }, data ? '数据可能已过期。' + error : error),
        !error && !data && h('p', { role: 'status' }, '正在读取运行进度…'),
        data?.runs.length === 0 &&
          h(
            'div',
            { className: 'dtd-section' },
            h('h4', null, sessionId ? '这个对话还没有启动工单运行' : '暂无运行记录'),
            h(
              'p',
              { className: 'dtd-hint' },
              sessionId
                ? '在这个对话里让队长用 dag_run 启动一轮工单，进度会显示在这里。'
                : '在项目的队长会话里用 dag_run 启动一轮工单，进度会显示在这里。',
            ),
          ),
        selected?.available === false &&
          h(
            'p',
            { role: 'status', className: 'dtd-alert' },
            selected.diagnostic || '这轮运行的持久记录暂不可读取。',
          ),
        selected &&
          selected.available !== false &&
          (selected.mode === 'staged'
            ? h(PlanReview, { run: selected, key: selected.key, refresh: () => void refresh.current?.() })
            : h(RunProgress, { run: selected, key: selected.key, compact: Boolean(sessionId), openChild })),
        data?.runs.length > 0 && !selected && !error && h('p', { role: 'status' }, '正在读取所选运行…'),
      )
    }

    const tabId = 'dsh-ticket-dag/progress'
    const tabKind = 'ticket-dag'
    // Each run opens at its own address, so it gets its own sidebar tab and
    // reopening the same run reveals that tab.
    const runPrefix = 'dsh-resource://ticket-dag/'
    const runAddress = (run) => runPrefix + run.key + '/' + run.runId
    function parseRun(address) {
      const match = /^dsh-resource:\/\/ticket-dag\/([0-9a-f]{64})\/([a-z0-9][a-z0-9_-]{0,62})$/.exec(address ?? '')
      return match ? { key: match[1], runId: match[2] } : null
    }

    // Conversation header action. It appears once this conversation has started
    // a run and opens the newest run's tab; a run that starts later opens its
    // own tab by itself.
    function BoardEntry({ sessionId, openRun }) {
      const [runs, setRuns] = useState(null)
      useEffect(() => {
        let disposed = false,
          known = null,
          failures = 0
        const ctrl = new AbortController()
        // A failed read keeps the button's last known state and retries with backoff.
        async function tick() {
          try {
            const response = await fetch(dashboardUrl('', sessionId), { signal: ctrl.signal, cache: 'no-store' })
            if (response.status === 404) return null
            if (!response.ok) throw new Error('HTTP ' + response.status)
            const view = await response.json()
            if (disposed) return null
            if (!Array.isArray(view?.runs)) throw new Error('invalid snapshot')
            failures = 0
            const fresh = view.runs.filter((run) => known && !known.has(run.key) && !run.complete)
            known = new Set(view.runs.map((run) => run.key))
            setRuns(view.runs)
            if (fresh.length) openRun(fresh[0])
            return entryPollMs
          } catch {
            return disposed ? null : backoff(entryPollMs, ++failures)
          }
        }
        const polling = poller(tick)
        return () => {
          disposed = true
          polling.stop()
          ctrl.abort()
        }
      }, [sessionId])
      if (!runs?.length) return null
      return h(
        'button',
        {
          type: 'button',
          title: '在右侧栏打开「工单 · ' + runs[0].runId + '」标签',
          style: {
            font: 'inherit',
            fontSize: '.85rem',
            color: 'inherit',
            background: 'transparent',
            border: '1px solid var(--dsw-alias-border-l2, color-mix(in srgb, currentColor 22%, transparent))',
            borderRadius: '.5rem',
            padding: '.25rem .6rem',
            cursor: 'pointer',
            whiteSpace: 'nowrap',
          },
          // runs arrive newest first.
          onClick: () => openRun(runs[0]),
        },
        '查看工单',
      )
    }

    // Conversation card for one dag_run. It folds the durable dag_run tool call
    // and its result, so it stays in the transcript after the sidebar tab is
    // closed or the session is reopened.
    const cardKind = 'dsh-ticket-dag/run'
    const resultText = (message) =>
      (message?.content ?? [])
        .filter((b) => b?.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('\n')
    const resultFailed = (data) =>
      data.error !== undefined ||
      data.message?.isError === true ||
      (data.message?.content ?? []).some((b) => b?.type === 'tool-result' && b.isError === true)
    function runFromResult(message) {
      try {
        const result = JSON.parse(resultText(message))
        if (typeof result?.runId !== 'string' || !result.runId) return null
        return {
          runId: result.runId,
          tickets: (Array.isArray(result.tickets) ? result.tickets : []).map((t) => ({
            id: String(t?.id ?? ''),
            agent: typeof t?.agent === 'string' && t.agent ? t.agent : null,
          })),
        }
      } catch {
        return null
      }
    }
    const runCardDefinition = {
      kind: cardKind,
      target: 'chat',
      match: (event) => {
        if (event.type === 'tool/call' && event.data?.name === 'dag_run')
          return { id: String(event.data.callId), role: 'start' }
        if (event.type === 'tool/result' && event.data?.message?.source?.kind === 'tool')
          return { id: String(event.data.message.source.callId), role: 'update' }
        return null
      },
      start: () => ({ run: null }),
      update: (context, match) => {
        if (match.event.type !== 'tool/result' || resultFailed(match.event.data)) return context.state
        return { run: runFromResult(match.event.data.message) ?? context.state?.run ?? null }
      },
      buildViewNode: (context) =>
        context.start && context.state?.run
          ? {
              key: context.key,
              kind: cardKind,
              id: context.id,
              target: 'chat',
              anchorSeq: context.start.event.seq,
              location: context.start.location,
              visibility: 'visible',
              data: context.state.run,
            }
          : null,
    }
    const inTurn = (location) => location?.kind === 'turn' || location?.kind === 'step'

    // Members are the presets that own tickets, in ticket order, with their ticket counts.
    function runMembers(tickets) {
      const members = new Map()
      for (const t of tickets) members.set(t.agent ?? '', (members.get(t.agent ?? '') ?? 0) + 1)
      return [...members]
    }
    const runState = (run) =>
      !run
        ? ''
        : run.available === false
          ? '记录不可读'
          : run.mode === 'staged'
            ? '待确认'
            : run.mode === 'discarded'
              ? '已放弃'
              : run.complete
                ? '已完成'
                : '进行中'

    // Reads this conversation's run list once to find the run's sidebar address
    // and preset names; no polling, the tab owns live progress.
    function RunCard({ run, sessionId, openRun }) {
      const [found, setFound] = useState(null)
      const [presets, setPresets] = useState(null)
      const [notice, setNotice] = useState('')
      useEffect(() => {
        let disposed = false
        const ctrl = new AbortController()
        const read = async (key) => {
          const response = await fetch(dashboardUrl(key, sessionId), { signal: ctrl.signal, cache: 'no-store' })
          if (!response.ok) throw new Error('HTTP ' + response.status)
          return response.json()
        }
        void (async () => {
          try {
            const view = await read('')
            const hit = view?.runs?.find?.((r) => r.runId === run.runId)
            if (disposed || !hit) return
            setFound(hit)
            const detail = view.selected?.key === hit.key ? view.selected : (await read(hit.key))?.selected
            if (!disposed && Array.isArray(detail?.presets)) setPresets(detail.presets)
          } catch {
            // The card still shows what the tool result recorded.
          }
        })()
        return () => {
          disposed = true
          ctrl.abort()
        }
      }, [sessionId, run.runId])
      const members = runMembers(run.tickets)
      const ids = members.map(([id]) => id)
      const state = runState(found)
      return h(
        'section',
        { className: 'dtd-dashboard dtd-run-card', 'data-dag-run-card': run.runId },
        h('style', null, styles),
        h(
          'header',
          { className: 'dtd-run-card-head' },
          h('span', { className: 'dtd-run-card-title', title: run.runId }, '工单 · ' + run.runId),
          h('span', { className: 'dtd-run-card-meta' }, [state, run.tickets.length + ' 张工单'].filter(Boolean).join(' · ')),
          h(
            'button',
            {
              type: 'button',
              title: '在右侧栏打开「工单 · ' + run.runId + '」标签',
              onClick: () => (found ? openRun(found) : setNotice('找不到这轮运行的记录，可能已被删除或不属于当前对话。')),
            },
            '查看工单',
          ),
        ),
        members.length > 0 &&
          h(
            'div',
            { className: 'dtd-run-card-members' },
            members.map(([id, count]) =>
              h(
                'span',
                { key: id || 'default', className: 'dtd-run-card-member', 'data-dag-member': id },
                h(Avatar, { color: memberColor(ids, id), size: 20 }),
                memberName(id, presets) + ' · ' + count + ' 张',
              ),
            ),
          ),
        notice && h('p', { role: 'status', className: 'dtd-alert' }, notice),
      )
    }

    // Live turns show the card at the tool call; closed turns fold their tool
    // rows, so the turn tail shows the same cards below the reply.
    function RunCardNode({ node, sessionId, openRun }) {
      if (inTurn(node.location) && node.location.turn?.status === 'closed') return null
      return h(RunCard, { run: node.data, sessionId, openRun })
    }
    function RunTurnCards({ sessionId, turn, useChat, openRun }) {
      const nodes = useChat((snapshot) => snapshot.nodes)
      if (turn?.status !== 'closed') return null
      const cards = [...(nodes?.values?.() ?? [])].filter(
        (n) => n.kind === cardKind && inTurn(n.location) && n.location.turn?.turn === turn.turn,
      )
      if (!cards.length) return null
      return h(
        'div',
        { 'data-dag-turn-cards': '' },
        cards.map((n) => h(RunCard, { key: n.key, run: n.data, sessionId, openRun })),
      )
    }

    function Panel({ view, form, scope }) {
      if (view === 'summary') return '并发工单、预设 Agent、验收超时与验收命令。'
      if (!form || form.state.status !== 'ready' || !form.state.value || form.state.revision === undefined) {
        return h(
          'p',
          { role: 'status' },
          form?.state.status === 'loading' ? '正在读取插件配置…' : '宿主配置暂不可用，请确认插件已启用。',
        )
      }
      return h(Editor, { form, scope })
    }

    // Plugin-page Agent preset view. It reads and writes the same settings
    // namespace as the row configuration page through the host's config form.
    function AgentsPage({ readConfig, watchConfig, saveConfig }) {
      const [state, setState] = useState(readConfig)
      useEffect(() => watchConfig(() => setState(readConfig())), [])
      return h(Panel, { view: 'page', scope: 'agents', form: { state, mutate: saveConfig } })
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // The Agent preset page needs the settings service; hosts without it
        // keep the row configuration page only.
        ctx.inject?.(['configForms'], (scope) => {
          const form = scope.configForms.get('dsh-ticket-dag')
          const face = () => ({
            readConfig: () => form.getSnapshot(),
            watchConfig: (listener) => form.subscribe(listener),
            saveConfig: (ops, revision) => form.mutate(ops, revision),
          })
          scope.effect(() =>
            scope.slots.inject('plugins.tab', () =>
              scope.slots.register(
                { name: 'plugins.tab', id: 'ticket-dag-agents', order: 60, label: () => 'Agent 预设', inject: face },
                AgentsPage,
              ),
            ),
          )
          scope.effect(() =>
            scope.slots.inject('plugins.bundle.config', () =>
              scope.slots.register({ name: 'plugins.bundle.config', key: 'dsh-ticket-dag', inject: face }, AgentsPage),
            ),
          )
        })
        ctx.effect(() =>
          ctx.slots.inject('plugins.row.config', () =>
            ctx.slots.register({ name: 'plugins.row.config', key: 'dsh-ticket-dag#dsh-ticket-dag' }, Panel),
          ),
        )
        // The board lives only in the conversation right sidebar, one 「工单 · <runId>」 tab per run.
        // Worker transcripts are continuable subagent sessions under the captain (spawn with a fixed child ID).
        // Newer hosts list them in the parent's catalog first; older ones open by ID.
        let openChild = null
        ctx.inject?.(['sessions'], (scope) => {
          const sessions = scope.sessions
          openChild = async (parentSessionId, childSessionId) => {
            const workspace = scope.get?.('uiWorkspace')
            if (!sessions.open && workspace?.openSession) {
              workspace.openSession({ parentSessionId, childSessionId, mode: 'continuable' })
              return
            }
            if (sessions.openSubagent && sessions.refreshSubagents) {
              await sessions.refreshSubagents(parentSessionId)
              const kept = sessions.subagentAddress?.(childSessionId)
              sessions.openSubagent(
                kept?.parentSessionId === parentSessionId ? kept : { parentSessionId, childSessionId, mode: 'continuable' },
              )
            } else {
              sessions.open?.(childSessionId)
            }
            scope.get?.('layout')?.selectPanel?.(null)
          }
          return () => {
            openChild = null
          }
        })
        ctx.inject?.(['sidebarRight', 'sidebarRightTabs'], (native) => {
          native.effect(() =>
            native.sidebarRightTabs.register({
              id: tabId,
              kind: tabKind,
              patterns: [runPrefix + '**'],
              canOpen: (address) => parseRun(address) !== null,
              title: (address) => {
                const run = parseRun(address)
                return run ? '工单 · ' + run.runId : '工单进度'
              },
            }),
          )
          native.effect(() =>
            native.slots.inject('sidebar.right.pane.tab', () =>
              // The pane gives the tab its height; this element owns the scrolling.
              native.slots.register({ name: 'sidebar.right.pane.tab', key: tabId }, ({ sessionId, useTabInfo }) => {
                const run = parseRun(useTabInfo?.().tab?.contentId)
                return h(
                  'div',
                  { style: { height: '100%', overflowY: 'auto', padding: '0 .75rem 1.5rem', boxSizing: 'border-box' } },
                  h(Dashboard, {
                    key: run?.key ?? 'latest',
                    sessionId,
                    runKey: run?.key,
                    openChild: (parent, child) => openChild?.(parent, child),
                  }),
                )
              }),
            ),
          )
          native.effect(() =>
            native.slots.inject('conversation.session.header.actions', () =>
              native.slots.register(
                {
                  name: 'conversation.session.header.actions',
                  id: 'ticket-dag-entry',
                  order: 55,
                  inject: () => ({
                    openRun: (run) => native.sidebarRight.openResource(runAddress(run), { kind: tabKind }),
                  }),
                },
                BoardEntry,
              ),
            ),
          )
          const cardFace = () => ({
            openRun: (run) => native.sidebarRight.openResource(runAddress(run), { kind: tabKind }),
          })
          native.effect(() =>
            native.slots.inject('conversation.chat.node', () =>
              native.slots.register({ name: 'conversation.chat.node', key: cardKind, inject: cardFace }, RunCardNode),
            ),
          )
          native.effect(() =>
            native.slots.inject('conversation.chat.turnTail', () =>
              native.slots.register(
                { name: 'conversation.chat.turnTail', id: 'ticket-dag-run-cards', order: 55, inject: cardFace },
                RunTurnCards,
              ),
            ),
          )
        })
        // The run card folds durable dag_run tool events; hosts without the
        // conversation service keep the header entry only.
        ctx.inject?.(['uiConversation'], (scope) => {
          scope.effect(() => scope.uiConversation.events.register(runCardDefinition))
        })
      },
    }
  },
})
