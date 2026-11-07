import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { promisify } from 'node:util'
import { builtinAgents, repairAgent } from '../src/agents.mjs'
import { Coordinator } from '../src/coordinator.mjs'

const exec = promisify(execFile)
const env = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
}
const git = async (cwd, ...args) => (await exec('git', args, { cwd, env })).stdout.trim()

async function repo(t) {
  const root = await mkdtemp(join(tmpdir(), 'dag-presets-'))
  const cwd = join(root, 'project')
  await mkdir(cwd)
  await git(cwd, 'init', '-q', '-b', 'main')
  await git(cwd, 'config', 'user.name', 'fixture')
  await git(cwd, 'config', 'user.email', 'fixture@example.invalid')
  await git(cwd, 'commit', '--allow-empty', '-qm', 'seed')
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }))
  return cwd
}
// L writes bug.txt=bad, a fix-* ticket writes bug.txt=ok, others write src/<id>.txt.
function worker(seen) {
  return async (job) => ({
    dispose: async () => {},
    result: (async () => {
      seen.push(job)
      const fix = job.ticketId.startsWith('fix-')
      const file = fix || job.ticketId === 'L' ? 'bug.txt' : 'src/' + job.ticketId + '.txt'
      await mkdir(dirname(join(job.cwd, file)), { recursive: true })
      await writeFile(join(job.cwd, file), fix ? 'ok\n' : job.ticketId === 'L' ? 'bad\n' : job.ticketId + '\n')
      await git(job.cwd, 'add', '--', file)
      const trailers = ['DAG-Run: ' + job.runId, 'DAG-Ticket: ' + job.ticketId, 'DAG-Attempt: ' + job.attempt, 'DAG-Complete: yes']
      await git(job.cwd, 'commit', '-qm', 'Deliver ' + job.ticketId, '-m', trailers.join('\n'))
      return { ok: true }
    })(),
  })
}
const pass = [[process.execPath, '-e', 'process.exit(0)']]
const slow = [
  [
    process.execPath,
    '-e',
    "const fs=require('fs');if(fs.existsSync('bug.txt')&&fs.readFileSync('bug.txt','utf8').trim()==='bad'){console.error('bug.txt is bad');process.exit(1)}",
  ],
]
async function completed(co, q) {
  const deadline = Date.now() + 90000
  while (Date.now() < deadline) {
    const s = await co.status(q)
    if (s.counts.NEEDS_ATTENTION || s.diagnostic) throw Error(JSON.stringify(s.tickets.map((r) => [r.id, r.status, r.message])))
    if (s.complete) return s
    await sleep(40)
  }
  throw Error('Timeout: run complete')
}

test('the built-in presets are graded by judgement and name a suggested tier, with no model chosen', () => {
  assert.deepEqual(Object.keys(builtinAgents), ['architect', 'debugger', 'implementer', 'frontend', 'scribe', 'verifier'])
  for (const [id, preset] of Object.entries(builtinAgents)) {
    assert.match(preset.description, /建议(高智力|普通|便宜)模型/, id)
    assert.equal(preset.provider + preset.model + preset.reasoningEffort, '', id + ' leaves the route to the user')
  }
  assert.equal(builtinAgents.verifier.maxConcurrent, 1)
  assert.ok(Object.hasOwn(builtinAgents, repairAgent))
})

test('every worker gets the shared working rules and its declared files; a fix ticket goes to debugger', { timeout: 150000 }, async (t) => {
  const cwd = await repo(t)
  const seen = []
  const agents = {
    implementer: { instructions: 'Build it.', provider: 'acme', model: 'mid-1' },
    debugger: { instructions: 'Find the cause.', provider: 'acme', model: 'deep-2', reasoningEffort: 'high' },
  }
  const co = new Coordinator({
    checks: { fast: pass, slow },
    checkMeta: { fast: { files: ['**'], fast: true }, slow: { files: ['**'] } },
    integrationMode: 'end',
    agents,
    launch: worker(seen),
    notify: async () => true,
  })
  const q = { cwd, parentId: 'captain', runId: 'presets' }
  try {
    await co.start({
      ...q,
      manifest: {
        spec_id: 'presets',
        max_workers: 2,
        tickets: [
          { id: 'A', title: 'A', verify: ['fast'], agent: 'implementer', files: ['src/A.txt'] },
          { id: 'L', title: 'L', depends_on: ['A'], verify: ['slow'], agent: 'implementer' },
        ],
      },
    })
    await completed(co, q)
    const prompt = (id) => seen.find((j) => j.ticketId === id).prompt
    for (const id of ['A', 'L', 'fix-L-1']) {
      assert.match(prompt(id), /Working rules:/, id)
      assert.match(prompt(id), /smallest change/, id)
      assert.match(prompt(id), /Do not weaken assertions/, id)
    }
    assert.match(prompt('A'), /declares the files it changes: \["src\/A\.txt"\]/)
    assert.doesNotMatch(prompt('L'), /declares the files/, 'a ticket without files gets no files rule')
    // The located culprit used implementer; its repair goes to debugger with debugger's own route.
    const fix = seen.find((j) => j.ticketId === 'fix-L-1')
    assert.match(fix.prompt, /Role \(debugger\): Find the cause\./)
    assert.deepEqual(
      [fix.agentOptions?.provider, fix.agentOptions?.model, fix.agentOptions?.reasoningEffort],
      ['acme', 'deep-2', 'high'],
    )
  } finally {
    await co.close()
  }
})

test('a repair keeps the route the user approved for debugger in this run; without debugger it keeps the culprit preset', () => {
  const co = new Coordinator({
    agents: { debugger: { instructions: 'Find the cause.', provider: 'acme', model: 'deep-2', reasoningEffort: 'high' } },
    launch: async () => {},
  })
  const run = (tickets) => ({ db: { tickets: () => tickets } })
  const culprit = { id: 'L', agent: 'implementer', agentSpec: { instructions: 'Build it.', model: 'mid-1' } }
  assert.deepEqual(co._repairOwner(run([culprit]), culprit), {
    agent: 'debugger',
    spec: { instructions: 'Find the cause.', provider: 'acme', model: 'deep-2', reasoningEffort: 'high' },
  })
  // The user picked another model for debugger at approval: the fix follows that choice.
  const chosen = { id: 'D', agent: 'debugger', agentSpec: { instructions: 'Find the cause.', provider: 'other', model: 'big-3' } }
  assert.deepEqual(co._repairOwner(run([culprit, chosen]), culprit), {
    agent: 'debugger',
    spec: { instructions: 'Find the cause.', provider: 'other', model: 'big-3' },
  })
  const plain = new Coordinator({ agents: {}, launch: async () => {} })
  assert.deepEqual(plain._repairOwner(run([culprit]), culprit), { agent: 'implementer', spec: culprit.agentSpec })
  assert.equal(plain._repairOwner(run([]), { id: 'L' }), null)
})
