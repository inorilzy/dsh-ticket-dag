import test from 'node:test'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { reply } from './fixtures/provider.mjs'
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const binPath = process.env.DSH_TEST_BIN
const chrome = process.env.DSH_TEST_CHROME
const driver = process.env.DSH_TEST_PUPPETEER
const project = resolve(import.meta.dirname, '..')
const maxLabel = '最大并发工单数'
const timeoutLabel = '验收超时（毫秒）'
const saveLabel = '保存配置'
const exampleButton = '补入示例验收项'
// A cross-platform assertion the review shows as an exact argv: A.txt only
// exists in a candidate checkout once the integrated A ticket has landed.
const fixtureCheck = "process.exitCode = require('fs').existsSync('A.txt') ? 0 : 1"

async function openBundle(page) {
  // On first launch DSH can show its preview notice before the sidebar is interactive.
  await page.waitForSelector('button[aria-label="插件"]', { visible: true })
  const intro = await page.$('::-p-aria(继续[role="button"])')
  if (intro) {
    await intro.click()
    await page.waitForFunction(() => !document.querySelector('[role="dialog"]'))
  }
  await page.locator('button[aria-label="插件"]').click()
  await page.locator('button[aria-label="查看 dsh-ticket-dag"]').click()
}

async function openPanel(page) {
  await openBundle(page)
  await page.locator('button[aria-label="配置 dsh-ticket-dag"]').click()
  await page.waitForSelector('input[aria-label="' + maxLabel + '"]', { visible: true })
}

const button = (name) => '::-p-aria(' + name + '[role="button"])'
const field = (label, section = '') => section + ' [aria-label="' + label + '"]'

async function input(page, label, value, section = '') {
  const handle = await page.waitForSelector(field(label, section).trim(), { visible: true })
  await handle.click({ clickCount: 3 })
  await page.keyboard.press('Backspace')
  await handle.type(value)
}

// Only the model transport is simulated. The Web host runs real agents, Git and SQLite.
async function modelFixture(t) {
  const calls = new Set()
  const toolErrors = []
  const gates = { A: Promise.withResolvers(), B: Promise.withResolvers(), C: Promise.withResolvers() }
  // A and B are the submitted plan; B waits for A and has no command of its own,
  // so it still runs A's integrated cumulative check. C is appended while staged.
  const manifest = {
    specId: 'web-test',
    maxWorkers: 2,
    tickets: [
      { id: 'A', title: 'Dashboard A', prompt: 'LOCAL-WORKER-A', dependsOn: [], verify: ['captain-check'], agent: 'implementer' },
      { id: 'B', title: 'Dashboard B', prompt: 'LOCAL-WORKER-B', dependsOn: ['A'], verify: [], agent: 'implementer' },
    ],
    // A captain-written command that needs the user's review; the space-bearing
    // and empty arguments prove the panel keeps each argv boundary.
    checks: { 'captain-check': [['node', '-e', fixtureCheck, 'two words', '']] },
  }
  const appended = [
    { id: 'C', title: 'Dashboard C', prompt: 'LOCAL-WORKER-C', dependsOn: ['A'], verify: ['captain-check'], agent: 'implementer' },
  ]
  const server = createServer(async (req, res) => {
    try {
      let input = ''
      for await (const chunk of req) input += chunk
      const data = JSON.parse(input)
      const text = JSON.stringify(data.messages)
      // Keep local tool diagnostics only. Never log the raw request or credentials.
      for (const message of data.messages ?? [])
        for (const part of Array.isArray(message.content) ? message.content : []) {
          if (part.type === 'tool_result' && part.is_error)
            toolErrors.push(JSON.stringify(part.content).slice(-650))
        }
      // A second captain turn appends to the still-staged plan. This changes the
      // plan revision the review shows and must invalidate the earlier approval.
      if (
        text.includes('APPEND-WEB-CAPTAIN') &&
        !calls.has('append') &&
        data.tools?.some((t) => t.name === 'dag_add')
      ) {
        calls.add('append')
        return reply(res, 'dag_add', { runId: 'web-board', tickets: appended })
      }
      if (
        text.includes('ROOT-WEB-CAPTAIN') &&
        !calls.has('captain') &&
        data.tools?.some((t) => t.name === 'dag_run')
      ) {
        calls.add('captain')
        return reply(res, 'dag_run', { runId: 'web-board', manifest })
      }
      const id = text.match(/LOCAL-WORKER-([ABC])/)?.[1]
      if (
        !text.includes('ROOT-WEB-CAPTAIN') &&
        id &&
        !calls.has(id) &&
        data.tools?.some((t) => t.name === 'bash')
      ) {
        calls.add(id)
        await gates[id].promise
        return reply(res, 'bash', {
          description: 'Commit the local dashboard test fixture',
          command:
            (id === 'A' ? '' : 'test -f A.txt && ') +
            'echo done > ' +
            id +
            '.txt && git add ' +
            id +
            '.txt && git commit -m fixture -m ' +
            "'DAG-Run: web-board\nDAG-Ticket: " +
            id +
            "\nDAG-Attempt: 1\nDAG-Complete: yes'",
        })
      }
      reply(res)
    } catch (error) {
      res.writeHead(500)
      res.end(String(error))
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => {
    for (const gate of Object.values(gates)) gate.resolve()
    server.closeAllConnections()
    server.close()
  })
  return { gates, calls, toolErrors, url: 'http://127.0.0.1:' + server.address().port }
}

// Use DSH's authenticated Web Gateway to start a real top-level session without automating chat layout.
async function remote(page, method, request) {
  const result = await page.evaluate(
    async ({ method, request }) => {
      const res = await fetch('api/' + method, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: crypto.randomUUID(),
          method,
          payload: { args: { request } },
        }),
      })
      if (!res.ok) throw Error(method + ': HTTP ' + res.status)
      return (await res.json()).result
    },
    { method, request },
  )
  assert.ok(result.ok, method + ': ' + JSON.stringify(result.error))
  return result.value
}

test(
  'real DSH Web: review the captain plan, approve the exact commands, append, integrate and reload',
  {
    skip: !(binPath && chrome && driver) && 'Set DSH_TEST_BIN, DSH_TEST_CHROME and DSH_TEST_PUPPETEER',
    timeout: 300000,
  },
  async (t) => {
    const puppeteer = (await import(pathToFileURL(resolve(driver)).href)).default
    const root = mkdtempSync(join(tmpdir(), 'dsh-panel-web-'))
    t.after(() => rmSync(root, { force: true, recursive: true }))
    const fixture = await modelFixture(t)
    const repo = join(root, 'repo')
    mkdirSync(repo)
    const git = (...args) =>
      execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
    git('init', '-q', '-b', 'main')
    git('config', 'user.name', 'Dashboard Fixture')
    git('config', 'user.email', 'fixture@example.invalid')
    git('commit', '-q', '--allow-empty', '-m', 'base')
    const env = {
      ...process.env,
      DSH_HOME: root,
      DSH_TELEMETRY_MODE: 'OFF',
      DEEPSEEK_API_KEY: 'local-fixture-only',
      DEEPSEEK_BASE_URL: fixture.url,
      DSH_PERMISSION_MODE: 'danger-full-access',
      NO_PROXY: '127.0.0.1',
    }
    const hostBin = resolve(binPath)
    const tarball =
      process.env.DSH_TEST_TARBALL ??
      join(
        root,
        execFileSync('npm', ['pack', project, '--pack-destination', root, '--silent'], {
          encoding: 'utf8',
        }).trim(),
      )
    execFileSync(process.execPath, [hostBin, 'plugin', '--profile', 'web', 'add', resolve(tarball)], {
      cwd: root,
      env,
      stdio: 'pipe',
    })
    const host = spawn(process.execPath, [hostBin, '--profile', 'web', '--no-open', '--port', '0'], {
      cwd: root,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const exited = once(host, 'exit')
    t.after(async () => {
      if (host.exitCode === null && host.signalCode === null) host.kill()
      await exited
    })
    let buf = ''
    host.stdout.on('data', (chunk) => {
      buf += chunk.toString()
    })
    host.stderr.on('data', (chunk) => {
      buf += chunk.toString()
    })
    let url
    for (let tick = 0; tick < 300 && host.exitCode === null; tick++) {
      url = buf.match(/^dsh web: (https?:\/\/[^\s]+)/m)?.[1]
      if (url) break
      await delay(100)
    }
    assert.ok(url, 'DSH web startup: ' + buf.replace(/token=[^\s]+/g, 'token=[redacted]').slice(-1000))
    const browser = await puppeteer.launch({
      executablePath: chrome,
      headless: true,
      args: [
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--lang=zh-CN',
        ...(process.getuid?.() === 0 ? ['--no-sandbox'] : []),
      ],
    })
    t.after(() => browser.close())
    const page = await browser.newPage()
    await page.setViewport({ width: 1200, height: 850 })
    page.setDefaultTimeout(12000)
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'language', { get: () => 'zh-CN' })
      Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh'] })
    })
    await page.goto(url)
    await openPanel(page)
    assert.equal(await page.$eval(field(maxLabel).trim(), (el) => el.value), '16')
    assert.equal(await page.$eval(field(timeoutLabel).trim(), (el) => el.value), '120000')

    const yml = createRequire(hostBin)('js-yaml')
    const cfgPath = join(root, 'profiles', 'web', 'cordis.patch.yml')
    const before = readFileSync(cfgPath, 'utf8')
    await input(page, maxLabel, '33')
    await page.locator(button(saveLabel)).click()
    await page.waitForFunction(() =>
      document.querySelector('.dtd-panel [role="alert"]')?.textContent.includes('32'),
    )
    assert.equal(readFileSync(cfgPath, 'utf8'), before)
    await page.locator(button('丢弃修改')).click()
    assert.equal(await page.$eval(field(maxLabel).trim(), (el) => el.value), '16')

    await input(page, maxLabel, '6')
    await input(page, timeoutLabel, '24680')
    await page.locator(button('添加验收项')).click()
    await input(page, '验收项 ID', 'custom')
    await input(page, '命令 1 的程序', 'node')
    await page.locator(button('添加参数')).click()
    await input(page, '命令 1 的参数 1', '-e')
    await page.locator(button('添加参数')).click()
    await input(page, '命令 1 的参数 2', fixtureCheck)
    await page.locator(button(exampleButton)).click()
    assert.equal(await page.$$eval('[aria-label="验收项 ID"]', (items) => items.length), 4)
    assert.equal(readFileSync(cfgPath, 'utf8'), before, 'editing must not change the profile')
    await page.locator(button(saveLabel)).click()
    await page.waitForFunction(() =>
      document.querySelector('.dtd-panel [role="status"]')?.textContent.includes('已保存'),
    )

    const rows = yml.load(readFileSync(cfgPath, 'utf8'))
    const effective = rows.find((row) => row.id === 'dsh-ticket-dag').config
    const demo = yml.load(readFileSync(join(project, 'examples', 'profile.patch.yml'), 'utf8'))[0].config
      .checks
    assert.deepEqual(effective, {
      maxWorkers: 6,
      checkTimeoutMs: 24680,
      checks: { custom: [['node', '-e', fixtureCheck]], ...demo },
    })
    // A fresh browser tab acquires the readback through settings, without React's in-memory draft.
    const second = await browser.newPage()
    await second.setViewport({ width: 1240, height: 900 })
    await second.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'language', { get: () => 'zh-CN' })
      Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh'] })
    })
    await second.goto(new URL('/', url).href)
    await openPanel(second)
    assert.equal(await second.$eval(field(maxLabel).trim(), (el) => el.value), '6')
    assert.equal(await second.$eval(field(timeoutLabel).trim(), (el) => el.value), '24680')
    assert.deepEqual(
      await second.$$eval('[aria-label="验收项 ID"]', (items) => items.map((el) => el.value).sort()),
      ['custom', 'greeting', 'normalize', 'welcome'],
    )
    if (process.env.DSH_TEST_UI_SCREENSHOT)
      await second.screenshot({ path: resolve(process.env.DSH_TEST_UI_SCREENSHOT) })
    // ---- Real captain conversation -> side review -> approve -> integrate ----
    // The board lives only in the conversation right sidebar now: this replaces
    // the retired plugin-detail board entry the old test waited on.
    const third = await browser.newPage()
    await third.setViewport({ width: 1240, height: 900 })
    await third.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'language', { get: () => 'zh-CN' })
      Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh'] })
    })
    await third.goto(url)
    const { workspace } = await remote(third, 'workspace/create', { path: repo })
    const { sessionId } = await remote(third, 'session/create', { workspaceId: workspace.workspaceId })
    await remote(third, 'session/selectModel', {
      sessionId,
      provider: 'deepseek-official',
      model: 'deepseek-v4-pro',
      reasoningEffort: 'off',
    })
    // Open this captain conversation on load, exactly as reopening the tab does.
    await third.evaluateOnNewDocument(
      ({ workspaceId, sessionId }) => {
        localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId }))
        localStorage.setItem(
          'dsh.workspace.view.v5',
          JSON.stringify({
            groupBy: 'workspace',
            orderBy: 'updated',
            groupExpansion: { [workspaceId]: true },
            sessionOrderByAccount: { [workspaceId]: [sessionId], __flat_session_order__: [sessionId] },
          }),
        )
      },
      { workspaceId: workspace.workspaceId, sessionId },
    )
    await third.reload()
    await third.locator('[data-composer-input]').first().waitFor({ timeout: 30000 })

    const dashboard = (parent) =>
      third.evaluate(async (parent) => {
        const res = await fetch(
          'api/ticket-dag.dashboard' + (parent ? '?parent=' + encodeURIComponent(parent) : ''),
          { cache: 'no-store' },
        )
        return { status: res.status, body: await res.json().catch(() => null) }
      }, parent)
    const planReaching = async (predicate) => {
      let last
      for (let i = 0; i < 200; i++) {
        last = await dashboard(sessionId)
        if (last.status === 200 && last.body?.selected && predicate(last.body.selected)) return last.body
        await delay(150)
      }
      throw Error('dashboard never reached the expected plan: ' + JSON.stringify(last))
    }

    await remote(third, 'session/prompt', {
      sessionId,
      requestId: randomUUID(),
      mode: 'queue',
      content: [{ type: 'text', text: 'ROOT-WEB-CAPTAIN. Submit the plan, then stop for my review.' }],
    })
    // The durable dag_run card and the conversation-header entry appear once staged.
    await third.waitForSelector('[data-dag-run-card="web-board"]', { visible: true })
    await third.locator(button('查看工单')).click()
    await third.locator('::-p-aria(工单 · web-board[role="tab"])').click()
    await third.waitForSelector('[aria-label="执行前计划审查"]', { visible: true })

    const first = await planReaching(
      (run) => run.mode === 'staged' && run.tickets.some((t) => t.id === 'A'),
    )
    const revision1 = first.selected.revision
    const runKey = first.selected.key
    const firstTickets = new Map(first.selected.tickets.map((t) => [t.id, t]))
    assert.ok(/^[0-9a-f]{64}$/.test(revision1), 'the review carries an opaque plan revision')
    assert.deepEqual(firstTickets.get('B').dependsOn, ['A'], 'B waits for A')
    assert.deepEqual(firstTickets.get('B').verify, [], 'B has no command of its own')
    await third.waitForSelector('[data-dag-task="A"]', { visible: true })
    await third.waitForSelector('[data-dag-task="B"]', { visible: true })

    // The panel shows every manual command as an exact argv, including the
    // space-bearing and the empty argument.
    const expectedArgv = ['node', '-e', fixtureCheck, 'two words', '']
      .map((arg) => (/^[\p{L}\p{N}_@%+=:,./-]+$/u.test(arg) ? arg : JSON.stringify(arg)))
      .join(' ')
    assert.deepEqual(
      await third.$$eval('[data-dag-check="captain-check"] .dtd-check-cmd', (items) =>
        items.map((el) => el.textContent),
      ),
      [expectedArgv],
      'the review shows the full command and exact parameters',
    )
    assert.match(
      await third.$eval('[data-dag-check="captain-check"]', (el) => el.textContent),
      /队长编写，需你确认/,
    )
    assert.equal(
      await third.$eval('[data-dag-check="captain-check"] [data-dag-check-users]', (el) => el.textContent),
      '工单：A',
    )

    // A captain append while the plan is still staged changes the revision: the
    // approval bound to the earlier plan must be refused, and the refreshed
    // review must be confirmed again.
    await remote(third, 'session/prompt', {
      sessionId,
      requestId: randomUUID(),
      mode: 'queue',
      content: [{ type: 'text', text: 'APPEND-WEB-CAPTAIN. Add ticket C to the plan under review.' }],
    })
    const secondPlan = await planReaching(
      (run) =>
        run.mode === 'staged' &&
        run.tickets.some((t) => t.id === 'C') &&
        run.revision !== revision1,
    )
    assert.notEqual(secondPlan.selected.revision, revision1, 'appending changes the plan revision')
    const stale = await third.evaluate(
      async ({ key, revision, choices }) => {
        const res = await fetch('api/ticket-dag.approve', {
          method: 'POST',
          // The host refuses an approval without the plugin header.
          headers: { 'content-type': 'application/json', 'x-dsh-ticket-dag': '1' },
          body: JSON.stringify({ key, action: 'approve', revision, choices }),
        })
        return { status: res.status, body: (await res.text()).trim() }
      },
      { key: runKey, revision: revision1, choices: secondPlan.selected.tickets.map((t) => ({ id: t.id })) },
    )
    assert.equal(stale.status, 409, 'a stale revision is refused before dispatch')
    assert.match(stale.body, /plan changed|Refresh the plan/i)
    // The review refreshed to the current plan; C is visible and A is still staged.
    await third.waitForSelector('[data-dag-task="C"]', { visible: true })
    assert.equal((await planReaching((run) => run.mode === 'staged')).selected.tickets.length, 3)

    // Confirm the refreshed plan from the real review button and watch dispatch.
    await third.locator(button('确认并启动')).click()
    await third.waitForFunction(() => !document.querySelector('[aria-label="执行前计划审查"]'), {
      timeout: 20000,
    })
    async function waitForProgress(id, text, integrated) {
      try {
        await third.waitForFunction(
          (id, text, value) =>
            document.querySelector('[data-dag-ticket="' + id + '"]')?.innerText.includes(text) &&
            document.querySelector('progress[aria-label="已集成工单"]')?.value === value,
          { timeout: 30000 },
          id,
          text,
          integrated,
        )
      } catch (error) {
        throw Error(
          'Waiting for ' +
            id +
            '/' +
            text +
            '. Model calls: ' +
            [...fixture.calls] +
            '. Tool errors: ' +
            JSON.stringify(fixture.toolErrors.slice(-3)) +
            '. Page: ' +
            (await third.evaluate(() => document.body.innerText)).slice(-800) +
            '. Host: ' +
            buf.replace(/token=[^\s]+/g, 'token=[redacted]').slice(-700),
          { cause: error },
        )
      }
    }
    await waitForProgress('A', '执行中', 0)
    assert.ok((await third.$eval('[data-dag-ticket="B"]', (e) => e.innerText)).includes('等待依赖'))
    assert.ok((await third.$eval('[data-dag-ticket="C"]', (e) => e.innerText)).includes('等待依赖'))
    if (process.env.DSH_TEST_BOARD_SCREENSHOT)
      await third.screenshot({ path: resolve(process.env.DSH_TEST_BOARD_SCREENSHOT) })
    fixture.gates.A.resolve()
    await waitForProgress('B', '执行中', 1)
    await waitForProgress('C', '执行中', 1)
    fixture.gates.B.resolve()
    fixture.gates.C.resolve()
    await waitForProgress('B', '已集成', 3)
    await waitForProgress('C', '已集成', 3)
    assert.equal(git('show', 'integration/web-board:B.txt'), 'done')
    assert.equal(git('show', 'integration/web-board:C.txt'), 'done')

    // The durable conversation card reflects the current snapshot: finished,
    // three tickets, one member.
    const card = await third.$eval('[data-dag-run-card="web-board"]', (el) => el.innerText)
    assert.match(card, /已完成/)
    assert.match(card, /3 张工单/)
    assert.match(card, /实现者 · 3 张/)

    // Reloading the page keeps the same completed run in its own sidebar tab.
    await third.reload()
    await third.locator('[data-composer-input]').first().waitFor({ timeout: 30000 })
    await third.waitForSelector('[data-dag-run-card="web-board"]', { visible: true })
    assert.match(await third.$eval('[data-dag-run-card="web-board"]', (el) => el.innerText), /已完成/)
    await third.locator(button('查看工单')).click()
    await third.locator('::-p-aria(工单 · web-board[role="tab"])').click()
    await waitForProgress('B', '已集成', 3)
    t.diagnostic('The 工单 · web-board right-sidebar tab reloaded the same completed run.')
    t.diagnostic(
      'Review showed the exact captain argv and the empty/space arguments; the appended plan refused the stale revision with 409 and needed a fresh confirm.',
    )
    t.diagnostic(
      'A ran with B and C waiting, B and C ran after A integrated, and 3/3 integrated; the final Git tree contains B and C.',
    )
    t.diagnostic(
      'Chromium round-trip verified for DSH ' +
        JSON.parse(readFileSync(join(dirname(hostBin), '..', 'package.json'))).version,
    )
  },
)
