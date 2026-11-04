import test from 'node:test'
import { reply } from './fixtures/provider.mjs'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn, execFileSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { once } from 'node:events'

const binPath = process.env.DSH_TEST_BIN
const project = resolve(import.meta.dirname, '..')
const supportedHosts = JSON.parse(readFileSync(join(project, 'package.json'))).engines.dsh.split(/\s*\|\|\s*/)
const hostVersion = binPath
  ? JSON.parse(readFileSync(join(dirname(realpathSync(binPath)), '..', 'package.json'))).version
  : ''
const smokeId = 'dsh-fixture'
const rollingTest = process.env.DSH_TEST_ROLLING === '1'
function runManifest(workers) {
  const ids =
    workers === 1
      ? ['A']
      : Array.from({ length: workers + 2 }, (_, i) => 'T' + String(i + 1).padStart(2, '0'))
  const tickets = ids.map((id, i) => ({
    id,
    title: 'Local fixture ' + id,
    prompt: 'CHILD-FIXTURE-' + id,
    dependsOn: workers > 1 && i === ids.length - 1 ? [ids[0], ids[1]] : [],
    verify: ['fixture-file'],
  }))
  return { specId: smokeId, baseRef: 'main', maxWorkers: workers, tickets }
}

const cases = [
  { workers: 1, title: 'one ticket and idle captain wake' },
  { workers: 16, title: '16 workers, rolling refill and a dependent ticket' },
]
for (const { workers, title } of cases)
  test(
    'real DSH ' + hostVersion + ' SDK: ' + title,
    {
      skip: !binPath
        ? 'Set DSH_TEST_BIN to the locally installed @deepseek-ai/dsh/lib/bin.js'
        : workers > 1 && !rollingTest
          ? 'Set DSH_TEST_ROLLING=1 for the 16-worker load test'
          : false,
      timeout: 180000,
    },
    async (t) => {
      const manifest = runManifest(workers),
        ids = manifest.tickets.map((t) => t.id),
        last = ids.at(-1)
      const workerCalls = new Map()
      let refillWhileSlow = false,
        slowFinished = false,
        active = 0,
        peak = 0
      const bin = realpathSync(binPath)
      assert.ok(
        supportedHosts.includes(hostVersion),
        'Host version must be one of the package’s tested exact versions',
      )
      const root = mkdtempSync(join(tmpdir(), 'dsh-ticket-dag-smoke-'))
      t.after(() => rmSync(root, { recursive: true, force: true }))
      const repo = join(root, 'repo'),
        home = join(root, 'dsh')
      mkdirSync(repo)
      mkdirSync(home)
      const git = (...args) =>
        execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
      git('init', '-q', '-b', 'main')
      git('config', 'user.name', 'Local Fixture')
      git('config', 'user.email', 'fixture@example.invalid')
      git('commit', '-q', '--allow-empty', '-m', 'base')
      const main = git('rev-parse', 'main')
      let childSessionId,
        sentRevival = false,
        blockedRevival = false
      let captainRequests = 0,
        childRequests = 0,
        sawDagTool = false,
        fixtureError,
        receivedNotice = false,
        captainIdle = false
      const notifications = []
      const server = createServer(async (req, res) => {
        try {
          if (req.method !== 'POST' || !req.url.endsWith('/v1/messages'))
            throw Error('Unexpected fixture request: ' + req.url)
          let raw = ''
          for await (const chunk of req) raw += chunk
          const data = JSON.parse(raw),
            isCaptain = JSON.stringify(data.messages).includes('ROOT-DAG-SMOKE')
          if (isCaptain) {
            sawDagTool ||= data.tools.some((t) => t.name === 'dag_run')
            if (
              ++captainRequests > 1 &&
              JSON.stringify(data.messages).includes('REVIVE-RETIRED-SMOKE') &&
              !sentRevival
            ) {
              sentRevival = true
              return reply(res, 'send_message', {
                agent_id: childSessionId,
                message: 'Try to continue the old task.',
              })
            }
            if (captainRequests === 1) return reply(res, 'dag_run', { manifest, runId: smokeId })
          } else {
            const id = JSON.stringify(data.messages).match(/CHILD-FIXTURE-(A|T\d+)/)?.[1]
            if (!ids.includes(id)) throw Error('Unknown worker fixture assignment')
            childRequests++
            const count = (workerCalls.get(id) ?? 0) + 1
            workerCalls.set(id, count)
            if (count !== 1) return reply(res)
            if (workers > 1) {
              if (id === ids[workers]) refillWhileSlow = !slowFinished
              const until = Date.now() + 45000
              while (workerCalls.size < workers && Date.now() < until) await delay(50)
              if (id === ids[0]) {
                while (!refillWhileSlow && Date.now() < until) await delay(50)
                if (!refillWhileSlow)
                  throw Error('No rolling refill while the first ticket was still running')
              }
            }
            for (let i = 0; i < 100 && !captainIdle; i++) await delay(30)
            // These commands and filenames are fixed locally; no remote model controls this test.
            return reply(res, 'bash', {
              description: 'Commit the fixed local smoke fixture',
              command:
                (workers > 1 && id === last ? 'test -f T01.txt && test -f T02.txt && ' : '') +
                'printf fixture > ' +
                id +
                '.txt && git add -- ' +
                id +
                '.txt && git commit -m fixture -m ' +
                "'DAG-Run: dsh-fixture\nDAG-Ticket: " +
                id +
                "\nDAG-Attempt: 1\nDAG-Complete: yes'",
            })
          }
          reply(res)
        } catch (err) {
          fixtureError = err
          res.writeHead(500)
          res.end('fixture failed')
        }
      })
      server.listen(0, '127.0.0.1')
      await once(server, 'listening')
      t.after(() => {
        server.closeAllConnections()
        server.close()
      })
      const env = {
        PATH: process.env.PATH,
        HOME: root,
        DSH_HOME: home,
        DEEPSEEK_API_KEY: 'local-fixture-only',
        DEEPSEEK_BASE_URL: 'http://127.0.0.1:' + server.address().port,
        DSH_TELEMETRY_MODE: 'OFF',
        DSH_PERMISSION_MODE: 'danger-full-access',
        NO_PROXY: '127.0.0.1',
        TERM: 'dumb',
      }
      const tarball =
        process.env.DSH_TEST_TARBALL ??
        join(
          root,
          execFileSync('npm', ['pack', project, '--pack-destination', root, '--silent'], {
            cwd: root,
            env,
            encoding: 'utf8',
          }).trim(),
        )
      execFileSync(process.execPath, [bin, 'plugin', '--profile', 'sdk', 'add', resolve(tarball)], {
        env,
        cwd: repo,
        stdio: 'pipe',
      })
      const profile = join(home, 'profiles', 'sdk')
      const profileConfig = JSON.parse(readFileSync(join(profile, 'package.json')))
      assert.ok(profileConfig.dsh.profile.bundles.includes('dsh-ticket-dag'))
      writeFileSync(
        join(profile, 'cordis.patch.yml'),
        JSON.stringify([
          {
            id: 'dsh-ticket-dag',
            config: {
              maxWorkers: workers,
              checks: { 'fixture-file': [['git', 'diff', '--check', 'HEAD^', 'HEAD']] },
            },
          },
          { id: 'subagent', config: { maxActiveSubagents: workers } },
          { id: 'session-telemetry-otel', disabled: true },
        ]),
      )
      const cp = spawn(process.execPath, [bin, '--profile', 'sdk'], {
        cwd: repo,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      const exit = once(cp, 'exit')
      let stderr = '',
        next = 0
      t.after(async () => {
        if (cp.exitCode === null && cp.signalCode === null) cp.kill()
        await exit
      })
      cp.stderr.on('data', (d) => {
        stderr = (stderr + d).slice(-6000)
      })
      const pending = new Map()
      const stdout = createInterface({ input: cp.stdout })
      stdout.on('line', (line) => {
        let frame
        try {
          frame = JSON.parse(line)
        } catch {
          return
        }
        if (frame.id != null) {
          const slot = pending.get(frame.id)
          if (!slot) return
          pending.delete(frame.id)
          frame.error ? slot.reject(Error(JSON.stringify(frame.error))) : slot.resolve(frame.result)
        } else if (frame.method === 'session.event') {
          const event = frame.params.event
          if (
            frame.params.sessionId === childSessionId &&
            event.type === 'turn/end' &&
            event.data.reason.kind === 'blocked'
          )
            blockedRevival = true
          if (event.type === 'tool/result') notifications.push(JSON.stringify(event.data).slice(0, 1400))
          if (frame.params.sessionId === 'captain' && event.type === 'turn/end') captainIdle = true
          if (frame.params.sessionId === 'captain' && event.type === 'agent/inbox/spliced') {
            receivedNotice ||= event.data.inserted.some((m) => m.source?.kind === 'dsh-ticket-dag')
          }
        } else if (frame.method === 'subagent.started') {
          childSessionId ??= frame.params.childSessionId
          active++
          peak = Math.max(peak, active)
        } else if (frame.method === 'subagent.finished') {
          active--
          if (workerCalls.size > 0 && workerCalls.get(ids[0]) >= 2) slowFinished = true
          notifications.push(frame.params)
        }
      })
      const ask = (method, params) =>
        new Promise((resolve, reject) => {
          const id = ++next
          pending.set(id, { resolve, reject })
          cp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
        })
      cp.once('exit', () => {
        for (const slot of pending.values()) slot.reject(Error('DSH exited: ' + stderr))
      })
      await ask('initialize', {
        cwd: repo,
        provider: 'deepseek-official',
        model: 'deepseek-v4-pro',
        reasoningEffort: 'off',
        maxTokens: 2000,
      })
      await ask('session/prompt', {
        sessionId: 'captain',
        contentBlocks: [{ type: 'text', text: 'ROOT-DAG-SMOKE approved. Run the fixture.' }],
      })
      for (
        let i = 0;
        i < (workers === 1 ? 500 : 1500) &&
        !(receivedNotice && captainRequests >= 3 && workerCalls.size === ids.length);
        i++
      ) {
        if (fixtureError) throw fixtureError
        const failedTool = notifications.find((n) => typeof n === 'string' && n.includes('"isError":true'))
        if (failedTool) throw Error('DSH tool failed: ' + failedTool + ' ' + stderr)
        if (cp.exitCode !== null) throw Error('DSH exited: ' + stderr)
        await delay(75)
      }
      const diagnostics = JSON.stringify({
        captainRequests,
        childRequests,
        workers: [...workerCalls.keys()],
        peak,
        notifications: notifications.slice(-7),
        stderr,
      })
      assert.ok(sawDagTool && childRequests >= 2 && receivedNotice && captainRequests >= 3, diagnostics)
      assert.ok(
        notifications.some((n) => n?.stopReason === 'completed'),
        diagnostics,
      )
      if (workers > 1) {
        assert.equal(peak, workers, diagnostics)
        assert.ok(refillWhileSlow, diagnostics)
        assert.equal(workerCalls.get(last), 2)
      }
      for (const id of ids) {
        assert.equal(git('show', 'integration/' + smokeId + ':' + id + '.txt'), 'fixture')
        assert.equal(existsSync(join(repo, id + '.txt')), false)
      }
      assert.equal(git('rev-parse', 'main'), main)
      if (workers === 1) {
        const before = childRequests
        await ask('session/prompt', {
          sessionId: 'captain',
          contentBlocks: [{ type: 'text', text: 'REVIVE-RETIRED-SMOKE' }],
        })
        for (let i = 0; i < 100 && !blockedRevival; i++) await delay(50)
        assert.ok(
          sentRevival && blockedRevival,
          'Expected DSH to block a cold-resumed retired child. ' + JSON.stringify(notifications.slice(-4)),
        )
        assert.equal(childRequests, before, 'Retired child reached the model endpoint')
      }
      t.diagnostic(
        'Verified ' +
          ids.length +
          ' tickets; peak real subagents ' +
          peak +
          (workers > 1 ? ', observed rolling refill before slow task ended' : '') +
          ', Git integration and captain inbox.',
      )
      await ask('shutdown', {})
    },
  )
