import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')

// The shipped headless profile is data. This locks the approval choice the SDK
// smoke installs, without a YAML dependency or a real DSH host.
function ticketDagBlock(text) {
  const block = text
    .replace(/\r\n/g, '\n')
    .split(/^- id: /m)
    .find((part) => part.startsWith('dsh-ticket-dag\n'))
  assert.ok(block, 'examples/profile.patch.yml must contain the dsh-ticket-dag block')
  return block
}

test('the headless example turns requireApproval off for its trusted profile checks', () => {
  const block = ticketDagBlock(readFileSync(join(root, 'examples', 'profile.patch.yml'), 'utf8'))
  const hello = JSON.parse(readFileSync(join(root, 'examples', 'hello.json'), 'utf8'))
  assert.match(
    block,
    /^ {2}config:\n(?: {4}#.*\n| {4}[a-zA-Z][a-zA-Z0-9]*:.*\n)* {4}requireApproval: false\n/m,
    'the SDK example must explicitly set requireApproval: false',
  )
  const ids = [...block.matchAll(/^ {6}([a-z0-9-]+):\n/gm)].map((match) => match[1])
  const used = [...new Set(hello.tickets.flatMap((ticket) => ticket.verify ?? []))]
  assert.ok(used.length > 0, 'the first-run manifest must name profile checks')
  for (const id of used) assert.ok(ids.includes(id), id + ' is not a profile check in the headless example')
  assert.equal(hello.checks, undefined, 'the first-run manifest must not bring its own commands')
})

test('first-run docs state the headless limit and how to approve a manifest command', () => {
  const readme = readFileSync(join(root, 'README.md'), 'utf8')
  const firstRun = readme.slice(readme.indexOf('## 安装与首次运行'), readme.indexOf('## 运行进度'))
  assert.match(firstRun, /requireApproval: false/)
  assert.match(firstRun, /派工、集成，并在完成时通知队长/)
  const checks = readme.slice(readme.indexOf('**验收（可选）。**'), readme.indexOf('| 工具 |'))
  assert.match(checks, /requireApproval: false/)
  assert.match(checks, /不会派工，也不会执行这些命令/)
  assert.match(checks, /dag_resume/)
  assert.match(checks, /确认并启动/)
  assert.match(checks, /写入配置就是批准/)
})
