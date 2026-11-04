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
  const gates = { A: Promise.withResolvers(), B: Promise.withResolvers() }
  const manifest = {
    specId: 'web-test',
    maxWorkers: 2,
    tickets: ['A', 'B'].map((id) => ({
      id,
      title: 'Dashboard ' + id,
      prompt: 'LOCAL-WORKER-' + id,
      dependsOn: id === 'B' ? ['A'] : [],
      verify: ['custom'],
    })),
  }
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
      const id = text.match(/LOCAL-WORKER-([AB])/)?.[1]
      if (
        text.includes('ROOT-WEB-CAPTAIN') &&
        !calls.has('captain') &&
        data.tools?.some((t) => t.name === 'dag_run')
      ) {
        calls.add('captain')
        return reply(res, 'dag_run', { runId: 'web-board', manifest })
      }
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
            (id === 'B' ? 'test -f A.txt && ' : '') +
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
    gates.A.resolve()
    gates.B.resolve()
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
  'real DSH Web: discover the panel, edit commands, validate and persist the profile',
  {
    skip: !(binPath && chrome && driver) && 'Set DSH_TEST_BIN, DSH_TEST_CHROME and DSH_TEST_PUPPETEER',
    timeout: 180000,
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
    const fixtureCheck = "process.exitCode = require('fs').existsSync('A.txt') ? 0 : 1"
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
    // Verify automatic dashboard updates while the fake model holds each real worker's HTTP request.
    await second.reload()
    await openBundle(second)
    await second.waitForFunction(() => document.body.innerText.includes('暂无运行记录'))
    const { workspace } = await remote(second, 'workspace/create', { path: repo })
    const { sessionId } = await remote(second, 'session/create', { workspaceId: workspace.workspaceId })
    await remote(second, 'session/selectModel', {
      sessionId,
      provider: 'deepseek-official',
      model: 'deepseek-v4-pro',
      reasoningEffort: 'off',
    })
    await remote(second, 'session/prompt', {
      sessionId,
      requestId: randomUUID(),
      mode: 'queue',
      content: [{ type: 'text', text: 'ROOT-WEB-CAPTAIN. Run the approved test.' }],
    })
    async function waitForProgress(id, text, integrated) {
      try {
        await second.waitForFunction(
          (id, text, value) =>
            document.querySelector('[data-dag-ticket="' + id + '"]')?.innerText.includes(text) &&
            document.querySelector('progress[aria-label="已集成工单"]')?.value === value,
          { timeout: 25000 },
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
            (await second.evaluate(() => document.body.innerText)).slice(-800) +
            '. Host: ' +
            buf.replace(/token=[^\s]+/g, 'token=[redacted]').slice(-700),
          { cause: error },
        )
      }
    }
    await waitForProgress('A', '执行中', 0)
    assert.ok((await second.$eval('[data-dag-ticket="B"]', (e) => e.innerText)).includes('等待依赖'))
    if (process.env.DSH_TEST_BOARD_SCREENSHOT)
      await second.screenshot({ path: resolve(process.env.DSH_TEST_BOARD_SCREENSHOT) })
    fixture.gates.A.resolve()
    await waitForProgress('B', '执行中', 1)
    fixture.gates.B.resolve()
    await waitForProgress('B', '已集成', 2)
    assert.equal(git('show', 'integration/web-board:B.txt'), 'done')
    await second.reload()
    // The board opens from the conversation header into its own right-sidebar tab.
    await second.locator(button('查看工单')).click()
    await second.locator('::-p-aria(工单 · web-board[role="tab"])').click()
    await waitForProgress('B', '已集成', 2)
    t.diagnostic('The 工单 · web-board right-sidebar tab reloaded the same completed run.')
    t.diagnostic(
      'Dashboard observed A running with B waiting, B running after A integrated, and 2/2 integrated; final Git tree contains B.',
    )
    t.diagnostic(
      'Chromium round-trip verified for DSH ' +
        JSON.parse(readFileSync(join(dirname(hostBin), '..', 'package.json'))).version,
    )
  },
)
