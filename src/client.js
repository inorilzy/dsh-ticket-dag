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
`

    function draftFor(value) {
      return {
        maxWorkers: String(value.maxWorkers ?? 16),
        checkTimeoutMs: String(value.checkTimeoutMs ?? 120000),
        rules: Object.entries(value.checks ?? {}).map(([id, commands]) => ({ id, commands })),
      }
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
        if (
          !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(id) ||
          id.includes('..') ||
          id.endsWith('.') ||
          id.toLowerCase().endsWith('.lock') ||
          /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(id)
        ) {
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

    function Editor({ form }) {
      const [edit, setEdit] = useState(null)
      const [notice, setNotice] = useState(null)
      const [busy, setBusy] = useState(false)
      const inFlight = useRef(false)
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
          h('h3', null, '工单调度配置'),
          h(
            'p',
            { className: 'dtd-hint' },
            '这些设置保存在当前 DSH profile 中。每轮任务仍可在工单清单里指定更低的并发数。',
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
              '最大并发工单数',
              draft.maxWorkers,
              (v) =>
                change((d) => {
                  d.maxWorkers = v
                }),
              '可设 1–32。实际并发还受 DSH 子智能体上限限制。',
              32,
            ),
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
        if (mode === 'cancelled') label = '运行已取消'
        else if (missing.length) label = '等待依赖'
        else if (mode === 'paused') label = '暂停派工'
        else if (ticket.retryAt > Date.now()) label = '等待退避重试'
        else label = '可派工'
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

    function Ticket({ ticket, view }) {
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
          { className: 'dtd-ticket-head' },
          h('strong', null, id),
          title && title !== id && h('span', null, title),
          h('span', { className: 'dtd-badge ' + view.tone }, view.label),
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

    function RunProgress({ run }) {
      const [filter, setFilter] = useState('all')
      const byId = new Map(run.tickets.map((t) => [t.id, t]))
      const rows = run.tickets.map((ticket) => ({ ticket, view: ticketView(ticket, byId, run.mode) }))
      const counts = run.counts
      const complete = counts.INTEGRATED ?? 0
      const count = (s) => counts[s] ?? 0
      const chips = [
        ['待派工', count('PENDING')],
        ['执行中', count('RUNNING')],
        ['集成中', count('SUBMITTED') + count('PUBLISHING')],
        ['需要处理', count('NEEDS_ATTENTION')],
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
      return h(
        'section',
        { className: 'dtd-section', 'aria-label': '运行详情' },
        h(
          'div',
          { className: 'dtd-head' },
          h('strong', null, run.runId),
          h(
            'span',
            { className: 'dtd-badge ' + (count('NEEDS_ATTENTION') ? 'blocked' : 'neutral') },
            runMode(run),
          ),
        ),
        h(
          'p',
          { className: 'dtd-hint' },
          [run.repoName, run.specId, run.integrationRef].filter(Boolean).join(' · '),
        ),
        run.attached === false &&
          h('p', { className: 'dtd-hint' }, '持久记录 · 当前宿主未接管，本页显示最近记录的工单状态。'),
        h('p', null, '已集成 ', h('strong', null, complete + ' / ' + run.total), ' 张工单'),
        h('progress', { max: run.total || 1, value: complete, 'aria-label': '已集成工单' }),
        h(
          'div',
          { className: 'dtd-counts' },
          ...chips.map(([title, value]) => h('span', { key: title }, title, ' ', h('strong', null, value))),
        ),
        run.diagnostic && h('p', { className: 'dtd-alert' }, run.diagnostic),
        h(
          'label',
          null,
          '筛选工单',
          h(
            'select',
            { 'aria-label': '筛选工单', value: filter, onChange: (e) => setFilter(e.target.value) },
            h('option', { value: 'all' }, '全部工单'),
            h('option', { value: 'working' }, '执行或集成中'),
            h('option', { value: 'waiting' }, '等待依赖'),
            h('option', { value: 'blocked' }, '需要处理'),
          ),
        ),
        visible.length
          ? h(
              'ul',
              { className: 'dtd-tickets' },
              ...visible.map(({ ticket, view }) => h(Ticket, { key: ticket.id, ticket, view })),
            )
          : h('p', { className: 'dtd-hint' }, '当前没有符合筛选条件的工单。'),
      )
    }

    // Only one request at a time. A changed selection supersedes an older
    // response; unmount aborts the pending read and clears the next timer.
    function Dashboard() {
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
            const url = 'api/ticket-dag.dashboard' + (key ? '?key=' + encodeURIComponent(key) : '')
            const response = await fetch(url, { signal: active.signal, cache: 'no-store' })
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
      }, [])
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
            h('h4', null, '暂无运行记录'),
            h(
              'p',
              { className: 'dtd-hint' },
              '在项目的队长会话里用 dag_run 启动一轮工单，进度会显示在这里。',
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
        selected && selected.available !== false && h(RunProgress, { run: selected, key: selected.key }),
        data?.runs.length > 0 && !selected && !error && h('p', { role: 'status' }, '正在读取所选运行…'),
      )
    }

    function Panel({ view, form }) {
      if (view === 'summary') return '并发工单、验收超时与验收命令。'
      if (!form || form.state.status !== 'ready' || !form.state.value || form.state.revision === undefined) {
        return h(
          'p',
          { role: 'status' },
          form?.state.status === 'loading' ? '正在读取插件配置…' : '宿主配置暂不可用，请确认插件已启用。',
        )
      }
      return h(Editor, { form })
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(() =>
          ctx.slots.inject('plugins.tab', () =>
            ctx.slots.register(
              { name: 'plugins.tab', id: 'ticket-dag-progress', order: 60, label: () => '工单进度' },
              Dashboard,
            ),
          ),
        )
        ctx.effect(() =>
          ctx.slots.inject('plugins.bundle.config', () =>
            ctx.slots.register({ name: 'plugins.bundle.config', key: 'dsh-ticket-dag' }, Dashboard),
          ),
        )
        ctx.effect(() =>
          ctx.slots.inject('plugins.row.config', () =>
            ctx.slots.register({ name: 'plugins.row.config', key: 'dsh-ticket-dag#dsh-ticket-dag' }, Panel),
          ),
        )
      },
    }
  },
})
