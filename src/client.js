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
        description: '实现者：按工单完成代码与配套测试',
        instructions:
          'Implement the ticket end to end: production code plus the tests that prove it. Keep the change limited to what the ticket asks for.',
        provider: '',
        model: '',
        reasoningEffort: '',
        maxConcurrent: 0,
      },
      'test-writer': {
        description: '测试编写者：只补测试与测试夹具',
        instructions:
          'Add or improve automated tests and test fixtures only. Do not change production code; if a test exposes a defect, describe it in your report instead of fixing it.',
        provider: '',
        model: '',
        reasoningEffort: '',
        maxConcurrent: 0,
      },
      docs: {
        description: '文档编写者：只改文档与注释',
        instructions:
          'Update documentation, README files and code comments only. Do not change program behavior.',
        provider: '',
        model: '',
        reasoningEffort: '',
        maxConcurrent: 0,
      },
    }
    const agentFields = ['description', 'instructions', 'provider', 'model', 'reasoningEffort']
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
.dtd-badge {font-weight:600}.dtd-badge.work {background:color-mix(in srgb,#548dc7 18%,transparent)}.dtd-badge.done {background:color-mix(in srgb,#47a478 22%,transparent)}.dtd-badge.blocked {background:color-mix(in srgb,#dd953c 25%,transparent)}
.dtd-tickets {display:grid;gap:.55rem;list-style:none;margin:0;padding:0}
.dtd-ticket {border:1px solid color-mix(in srgb,currentColor 20%,transparent);border-radius:.55rem;padding:.7rem .8rem;display:grid;gap:.32rem}
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
.dtd-dashboard {--dtd-work:var(--dsw-alias-state-business-primary,#4c8df6);--dtd-wait:var(--dsw-alias-state-warn-primary,#e5a03a);--dtd-done:var(--dsw-alias-state-success-primary,#3fb27f);--dtd-blocked:var(--dsw-alias-state-error-primary,#e5534b);--dtd-idle:color-mix(in srgb,currentColor 38%,transparent);--dtd-line:var(--dsw-alias-border-l2,color-mix(in srgb,currentColor 16%,transparent));--dtd-card:color-mix(in srgb,currentColor 4%,transparent)}
.dtd-sr {position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.dtd-card {border:1px solid var(--dtd-line);border-radius:.75rem;background:var(--dtd-card);padding:.8rem .95rem;display:grid;gap:.3rem}
.dtd-run-head {display:flex;align-items:baseline;gap:.6rem;flex-wrap:wrap}.dtd-run-head strong {font-size:1.02rem}.dtd-run-head .dtd-badge {margin-inline-start:auto}
.dtd-bar {display:flex;gap:3px;height:.4rem}.dtd-bar span {border-radius:99px;min-width:.4rem;background:var(--dtd-idle)}
.dtd-legend {display:flex;flex-wrap:wrap;gap:.25rem .9rem;font-size:.8rem}.dtd-legend span {display:inline-flex;align-items:center;gap:.3rem}
.dtd-dot {display:inline-block;flex:none;width:.5rem;height:.5rem;border-radius:2px;background:var(--dtd-idle)}
[data-tone=work]>.dtd-dot,.dtd-bar [data-dag-segment=work],.dtd-dot[data-tone=work] {background:var(--dtd-work)}
[data-tone=wait]>.dtd-dot,.dtd-bar [data-dag-segment=wait],.dtd-dot[data-tone=wait] {background:var(--dtd-wait)}
[data-tone=done]>.dtd-dot,.dtd-bar [data-dag-segment=done],.dtd-dot[data-tone=done] {background:var(--dtd-done)}
[data-tone=blocked]>.dtd-dot,.dtd-bar [data-dag-segment=blocked],.dtd-dot[data-tone=blocked] {background:var(--dtd-blocked)}
.dtd-badge.wait {background:color-mix(in srgb,var(--dtd-wait) 24%,transparent)}.dtd-badge.blocked {background:color-mix(in srgb,var(--dtd-blocked) 24%,transparent)}
.dtd-banner {display:flex;align-items:center;gap:.5rem;border-radius:.5rem;padding:.4rem .7rem;font-size:.86rem;background:color-mix(in srgb,var(--dtd-blocked) 12%,transparent)}
.dtd-fold {display:flex;align-items:center;gap:.6rem;flex-wrap:wrap;border-radius:.5rem;padding:.3rem .5rem;background:var(--dtd-card)}
.dtd-panel .dtd-fold button {border:0;padding:.2rem .3rem;font-weight:600}.dtd-fold .dtd-hint {margin-inline-start:auto}
.dtd-fold label {display:flex;align-items:center;gap:.4rem;margin-inline-start:auto;font-size:.83rem}
.dtd-ticket {border-color:var(--dtd-line);background:var(--dtd-card)}.dtd-ticket-head .dtd-dot {align-self:center}
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
.dtd-node[aria-pressed=true] {border-color:var(--dtd-wait);box-shadow:0 0 0 1px var(--dtd-wait)}
.dtd-node[data-dim=true] {opacity:.42}.dtd-canvas path[data-active=false] {opacity:.45}
.dtd-steps {display:flex;list-style:none;margin:.2rem 0;padding:0;gap:3px;font-size:.76rem}
.dtd-steps li {flex:1;min-width:0;text-align:center;padding-top:.3rem;border-top:3px solid var(--dtd-idle);opacity:.7;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dtd-steps [data-state=done] {border-color:var(--dtd-done);opacity:1}
.dtd-steps [data-state=current] {border-color:var(--dtd-work);opacity:1;font-weight:600}
.dtd-detail .dtd-run-head strong {font-size:.96rem}
.dtd-panel .dtd-preset:not(.dtd-rule) {border:1px solid color-mix(in srgb,currentColor 16%,transparent);border-radius:.55rem;padding:.5rem .75rem}
.dtd-preset-row {display:flex;flex-wrap:wrap;align-items:center;gap:.3rem .8rem}
.dtd-preset-row .dtd-actions {margin-inline-start:auto}
.dtd-preset-meta {font-size:.83rem;background:color-mix(in srgb,currentColor 7%,transparent);border-radius:.35rem;padding:.1rem .45rem}
`

    function draftFor(value) {
      return {
        maxWorkers: String(value.maxWorkers ?? 16),
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
    function ModelPicker({ agent, catalog, modify }) {
      const name = agent.id || '未命名'
      const providers = catalog?.providers ?? []
      const current = routeKey(agent.provider, agent.model)
      const known = providers.find((p) => p.id === agent.provider)?.models.find((m) => m.id === agent.model)
      const efforts = known?.efforts ?? []
      return h(
        'div',
        { className: 'dtd-grid' },
        h(
          'label',
          null,
          h('span', null, '模型'),
          h(
            'select',
            {
              'aria-label': name + ' 的模型',
              value: current,
              onChange: (e) =>
                modify((a) => {
                  const [provider, model] = e.target.value ? JSON.parse(e.target.value) : ['', '']
                  Object.assign(a, { provider, model, reasoningEffort: '' })
                }),
            },
            h('option', { value: '' }, '宿主默认'),
            current &&
              !known &&
              h(
                'option',
                { value: current },
                [agent.provider, agent.model].filter(Boolean).join('/') + '（当前目录中没有）',
              ),
            ...providers.map((p) =>
              h(
                'optgroup',
                { key: p.id, label: p.name },
                ...p.models.map((m) => h('option', { key: m.id, value: routeKey(p.id, m.id) }, m.name)),
              ),
            ),
          ),
        ),
        h(
          'label',
          null,
          h('span', null, '推理强度'),
          h(
            'select',
            {
              'aria-label': name + ' 的推理强度',
              value: agent.reasoningEffort,
              disabled: !efforts.length && !agent.reasoningEffort,
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
          ),
        ),
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
      const name = agent.id || '预设 ' + (index + 1)
      const [route, limit] = presetSummary(agent, catalog)
      const head = h(
        'div',
        { className: 'dtd-preset-row' },
        h('strong', null, name),
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

    const modes = { active: '运行中', paused: '已暂停', cancelled: '已取消' }
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
        else [label, tone] = ['可派工', 'neutral']
      }
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

    function Ticket({ ticket, view, open }) {
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
          h('strong', null, id),
          title && title !== id && h('span', null, title),
          h('span', { className: 'dtd-badge ' + view.tone }, view.label),
          chatButton(ticket, open),
        ),
        view.stage && h('p', { className: 'dtd-phase' }, view.stage),
        h(
          'p',
          { className: 'dtd-hint' },
          '上游：' +
            (dependsOn.length ? dependsOn.join('、') : '无') +
            '　执行尝试：' +
            (attempt ?? 0) +
            (ticket.agent ? '　Agent：' + ticket.agent : ''),
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
      const [pinned, setPinned] = useState(null)
      const counts = run.counts
      const complete = counts.INTEGRATED ?? 0
      const count = (s) => counts[s] ?? 0
      const attention = count('NEEDS_ATTENTION')
      const groups = [
        ['work', '进行中', count('RUNNING') + count('SUBMITTED') + count('PUBLISHING')],
        ['wait', '等待', count('PENDING')],
        ['blocked', '需要处理', attention],
        ['done', '已集成', complete],
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
              ...visible.map(({ ticket, view }) => h(Ticket, { key: ticket.id, ticket, view, open })),
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
        h(
          'span',
          { className: 'dtd-hint' },
          pinned ? '已固定 ' + pinned + ' · 再次点击取消' : '从左到右：上游合入后解锁 · 点击查看详情',
        ),
      )
      const mapBody = mapOpen && h(DependencyMap, { key: 'map', rows, pinned, setPinned, open })
      return h(
        'section',
        { className: 'dtd-section', 'aria-label': '运行详情' },
        h(
          'div',
          { className: 'dtd-card' },
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
          run.attached === false &&
            h('p', { className: 'dtd-hint' }, '持久记录 · 当前宿主未接管，本页显示最近记录的工单状态。'),
        ),
        h(
          'div',
          { className: 'dtd-section' },
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
        ...(compact ? [mapFold, mapBody, listFold, listBody] : [listFold, listBody, mapFold, mapBody]),
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

    const node = { width: 172, height: 76, gapX: 44, gapY: 14 }

    function dagLayout(tickets) {
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

    function DependencyMap({ rows, pinned, setPinned, open }) {
      if (!rows.length) return null
      const tickets = rows.map((r) => r.ticket)
      const layout = dagLayout(tickets)
      const urgent =
        rows.find((r) => r.ticket.status === 'NEEDS_ATTENTION') ??
        rows.find((r) => r.view.tone === 'work') ??
        rows.find((r) => r.ticket.status === 'PENDING') ??
        rows[0]
      const focus = rows.find((r) => r.ticket.id === pinned) ?? urgent
      const chain = chainOf(focus.ticket.id, tickets)
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
                  d: e.d,
                  'data-active': chain.has(e.from) && chain.has(e.to),
                }),
              ),
            ),
            ...rows.map(({ ticket, view }) => {
              const { x, y } = layout.at.get(ticket.id)
              return h(
                'button',
                {
                  key: ticket.id,
                  type: 'button',
                  className: 'dtd-node',
                  'data-dag-node': ticket.id,
                  'data-tone': view.tone,
                  'data-dim': !chain.has(ticket.id),
                  'aria-pressed': pinned === ticket.id,
                  title: [
                    ticket.id,
                    ticket.title !== ticket.id && ticket.title,
                    view.label,
                    view.stage,
                    ticket.agent && [ticket.agent, ticket.model].filter(Boolean).join(' / '),
                  ]
                    .filter(Boolean)
                    .join(' · '),
                  style: { left: x, top: y, width: node.width, height: node.height },
                  onClick: () => setPinned(pinned === ticket.id ? null : ticket.id),
                },
                h(
                  'span',
                  { className: 'dtd-node-head', 'data-tone': view.tone },
                  h('span', { className: 'dtd-dot' }),
                  ticket.id,
                  h('small', null, ticket.agent || view.label),
                ),
                ticket.title && ticket.title !== ticket.id && h('span', { className: 'dtd-node-title' }, ticket.title),
              )
            }),
          ),
        ),
        h(TicketDetail, { ...focus, tickets, open }),
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
    }

    // Live phase is only known for attached in-flight tickets; otherwise the
    // stepper is either fully done (integrated) or untouched.
    function stepStates(ticket) {
      const order = Object.keys(stages)
      const live = ['RUNNING', 'SUBMITTED', 'PUBLISHING'].includes(ticket.status)
      const current = live ? order.indexOf(ticket.livePhase?.stage) : -1
      return order.map((stage, i) => [
        stage,
        ticket.status === 'INTEGRATED' || i < current ? 'done' : i === current ? 'current' : 'todo',
      ])
    }

    function TicketDetail({ ticket, view, tickets, open }) {
      const downstream = tickets.filter((t) => t.dependsOn.includes(ticket.id)).map((t) => t.id)
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
          h('p', { className: 'dtd-hint' }, ticket.agent + ' · ' + (ticket.model || '宿主默认模型')),
        h(
          'ol',
          { className: 'dtd-steps', 'aria-label': '工单阶段' },
          ...stepStates(ticket).map(([stage, state]) =>
            h(
              'li',
              { key: stage, 'data-dag-step': stage, 'data-state': state, title: stages[stage] },
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
        chatButton(ticket, open) && h('div', { className: 'dtd-actions' }, chatButton(ticket, open)),
      )
    }

    const dashboardUrl = (key, sessionId) => {
      const query = new URLSearchParams()
      if (key) query.set('key', key)
      if (sessionId) query.set('parent', sessionId)
      const text = query.toString()
      return 'api/ticket-dag.dashboard' + (text ? '?' + text : '')
    }

    // Only one request at a time. A changed selection supersedes an older
    // response; unmount aborts the pending read and clears the next timer.
    // With sessionId (the conversation sidebar) only that captain's runs show.
    function Dashboard({ sessionId, openChild } = {}) {
      const [data, setData] = useState(null)
      const [selectedKey, setSelectedKey] = useState('')
      const [error, setError] = useState('')
      const [lastRead, setLastRead] = useState(null)
      const target = useRef('')
      const refresh = useRef(null)
      useEffect(() => {
        let disposed = false,
          active = null,
          timer,
          again = false
        async function poll() {
          clearTimeout(timer)
          if (disposed) return
          if (active) {
            again = true
            return
          }
          active = new AbortController()
          const key = target.current
          const timeout = setTimeout(() => active?.abort(), 12000)
          try {
            const response = await fetch(dashboardUrl(key, sessionId), { signal: active.signal, cache: 'no-store' })
            if (response.status === 404 && key && !disposed && key === target.current) {
              target.current = ''
              setSelectedKey('')
              setData(null)
              setLastRead(null)
              again = true
              return
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
            if (disposed || key !== target.current) return
            const selected = view.selected?.key ?? ''
            target.current = selected
            setSelectedKey(selected)
            setData(view)
            setError('')
            setLastRead(new Date())
          } catch (err) {
            if (!disposed && key === target.current) {
              setData(null)
              setLastRead(null)
              setError(
                err.name === 'AbortError'
                  ? '读取进度超时，将自动重试。'
                  : '进度暂不可用。' + (err.message ?? ''),
              )
            }
          } finally {
            clearTimeout(timeout)
            active = null
            if (!disposed) {
              timer = setTimeout(poll, again ? 0 : 2000)
              again = false
            }
          }
        }
        refresh.current = poll
        void poll()
        return () => {
          disposed = true
          clearTimeout(timer)
          active?.abort()
          refresh.current = null
        }
      }, [sessionId])
      function choose(event) {
        const key = event.target.value
        target.current = key
        setSelectedKey(key)
        setError('')
        setLastRead(null)
        void refresh.current?.()
      }
      const selected = data?.selected?.key === selectedKey ? data.selected : null
      return h(
        'section',
        { className: 'dtd-panel dtd-dashboard', 'aria-label': 'DAG 运行进度' },
        h('style', null, styles),
        h(
          'div',
          { className: 'dtd-head' },
          h('h3', null, '运行进度'),
          button('刷新进度', () => {
            void refresh.current?.()
          }),
        ),
        h(
          'p',
          { className: 'dtd-hint' },
          '每 2 秒检查运行状态。',
          lastRead && ' 最近更新 ' + lastRead.toLocaleTimeString('zh-CN'),
        ),
        error && h('p', { className: 'dtd-alert', role: 'status' }, error),
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
        data?.runs.length > 0 &&
          h(
            'label',
            null,
            '选择运行',
            h(
              'select',
              { value: selectedKey, onChange: choose, 'aria-label': '选择运行' },
              ...data.runs.map((run) =>
                h(
                  'option',
                  { key: run.key, value: run.key },
                  [run.runId, run.repoName, runMode(run)].filter(Boolean).join(' · '),
                ),
              ),
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
          h(RunProgress, { run: selected, key: selected.key, compact: Boolean(sessionId), openChild }),
        data?.runs.length > 0 && !selected && !error && h('p', { role: 'status' }, '正在读取所选运行…'),
      )
    }

    const tabId = 'dsh-ticket-dag/progress'
    const tabKind = 'ticket-dag'

    // Conversation header action. It appears once this conversation has started
    // a run, and opens the sidebar by itself when a new run appears while the
    // sidebar is collapsed.
    function BoardEntry({ sessionId, openBoard, isExpanded }) {
      const [runs, setRuns] = useState(null)
      useEffect(() => {
        let disposed = false,
          timer,
          known = null
        const ctrl = new AbortController()
        async function poll() {
          try {
            const response = await fetch(dashboardUrl('', sessionId), { signal: ctrl.signal, cache: 'no-store' })
            const view = response.ok ? await response.json() : null
            if (disposed || !Array.isArray(view?.runs)) return
            const fresh = view.runs.filter((run) => known && !known.has(run.key) && !run.complete)
            known = new Set(view.runs.map((run) => run.key))
            setRuns(view.runs)
            if (fresh.length && !isExpanded()) openBoard()
          } catch {
            // The next poll retries; the button keeps its last known state.
          } finally {
            if (!disposed) timer = setTimeout(poll, 5000)
          }
        }
        void poll()
        return () => {
          disposed = true
          clearTimeout(timer)
          ctrl.abort()
        }
      }, [sessionId])
      if (!runs?.length) return null
      return h(
        'button',
        {
          type: 'button',
          title: '在右侧栏查看这个对话的工单进度',
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
          onClick: () => openBoard(),
        },
        '查看工单',
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
        // Hosts without the conversation right sidebar keep the plugin-page board only.
        // Worker transcripts are one-shot subagent sessions under the captain.
        // Newer hosts list them in the parent's catalog first; older ones open by ID.
        let openChild = null
        ctx.inject?.(['sessions'], (scope) => {
          const sessions = scope.sessions
          openChild = async (parentSessionId, childSessionId) => {
            const workspace = scope.get?.('uiWorkspace')
            if (!sessions.open && workspace?.openSession) {
              workspace.openSession({ parentSessionId, childSessionId, mode: 'one-shot' })
              return
            }
            if (sessions.openSubagent && sessions.refreshSubagents) {
              await sessions.refreshSubagents(parentSessionId)
              const kept = sessions.subagentAddress?.(childSessionId)
              sessions.openSubagent(
                kept?.parentSessionId === parentSessionId ? kept : { parentSessionId, childSessionId, mode: 'one-shot' },
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
            native.sidebarRightTabs.register({ id: tabId, kind: tabKind, title: () => '工单进度' }),
          )
          native.effect(() =>
            native.slots.inject('sidebar.right.pane.tab', () =>
              // The pane gives the tab its height; this element owns the scrolling.
              native.slots.register({ name: 'sidebar.right.pane.tab', key: tabId }, ({ sessionId }) =>
                h(
                  'div',
                  { style: { height: '100%', overflowY: 'auto', padding: '0 .75rem 1.5rem', boxSizing: 'border-box' } },
                  h(Dashboard, { sessionId, openChild: (parent, child) => openChild?.(parent, child) }),
                ),
              ),
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
                    openBoard: () => native.sidebarRight.openTab(tabKind),
                    isExpanded: () => native.sidebarRight.isExpanded(),
                  }),
                },
                BoardEntry,
              ),
            ),
          )
        })
      },
    }
  },
})
