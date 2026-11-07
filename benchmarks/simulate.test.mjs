import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { CONFIGS, simulate } from './simulate.mjs'

const script = fileURLToPath(new URL('simulate.mjs', import.meta.url))

test('each and f finish the 8-ticket simulation with sensible numbers', { timeout: 300000 }, async () => {
  const each = await simulate('each', { slowSeconds: 0.2, timeoutS: 240 })
  const f = await simulate('f', { slowSeconds: 0.2, timeoutS: 240 })
  for (const r of [each, f]) {
    assert.equal(r.outcome, 'completed', JSON.stringify(r))
    assert.equal(r.integrated, 8)
    // S1a and S1b edit the same line: whichever lands second conflicts at least once.
    assert.ok(r.conflicts >= 1, r.config + ' conflicts')
    assert.ok(r.attempts >= 10, r.config + ' attempts: 8 tickets + a conflict retry + a logic fix')
    // The logic error is caught by the lane check of L itself and fixed before it lands.
    assert.equal(r.foundAt, 'lane')
    assert.equal(r.located, 'L')
    assert.equal(r.finalLogic, 'ok')
    assert.ok(r.checkFailures >= 1)
  }
  assert.deepEqual(each.integration, { mode: 'each', selectChecksByFiles: false })
  assert.deepEqual(f.integration, { mode: 'each', selectChecksByFiles: true })
  assert.equal(each.skippedChecks, 0)
  // The docs-only ticket D skips slow under F.
  assert.ok(f.skippedChecks > 0)
  assert.ok(f.checkRuns < each.checkRuns + f.skippedChecks)
})

test('a and af catch the logic error in the final check and locate ticket L', { timeout: 300000 }, async () => {
  for (const name of ['a', 'af']) {
    const r = await simulate(name, { slowSeconds: 0.2, timeoutS: 240 })
    assert.equal(r.outcome, 'completed', JSON.stringify(r))
    assert.deepEqual(r.integration, { mode: 'end', selectChecksByFiles: name === 'af' })
    // 8 tickets plus the automatically appended fix-L-1. captainRetries is not asserted: the known
    // parallel git worktree add race (docs/integration-modes-plan.md section 1) can need one retry.
    assert.equal(r.tickets, 9)
    assert.equal(r.integrated, 9)
    assert.equal(r.foundAt, 'final')
    assert.equal(r.located, 'L')
    assert.equal(r.finalLogic, 'ok')
    assert.ok(r.conflicts >= 1)
  }
})

test('e and aef catch the logic error on the worker side or in the final check and locate ticket L', { timeout: 300000 }, async () => {
  for (const name of ['e', 'aef']) {
    const r = await simulate(name, { slowSeconds: 0.2, timeoutS: 240 })
    assert.equal(r.outcome, 'completed', JSON.stringify(r))
    assert.deepEqual(r.integration, { mode: name === 'e' ? 'worker' : 'worker-end', selectChecksByFiles: name === 'aef' })
    // L's worker-side check fails and goes back to L, so usually no fix ticket is appended; the final
    // check of aef may still append one if a merge order slips the error past the worker side.
    assert.ok(r.integrated === r.tickets && r.tickets >= 8, JSON.stringify(r))
    assert.ok(['worker', 'final'].includes(r.foundAt), r.foundAt)
    assert.equal(r.located, 'L')
    assert.equal(r.finalLogic, 'ok')
    assert.ok(r.conflicts >= 1)
    assert.ok(r.checkFailures >= 1)
  }
})

test('b runs merge trains, catches the logic error in a train and locates ticket L', { timeout: 300000 }, async () => {
  const r = await simulate('b', { slowSeconds: 0.2, timeoutS: 240 })
  assert.equal(r.outcome, 'completed', JSON.stringify(r))
  assert.deepEqual(r.integration, { mode: 'train', selectChecksByFiles: false })
  assert.equal(r.integrated, 8)
  assert.equal(r.tickets, 8)
  assert.equal(r.foundAt, 'train')
  assert.equal(r.located, 'L')
  assert.equal(r.finalLogic, 'ok')
  assert.ok(r.conflicts >= 1)
  assert.ok(r.trains >= 1)
})

test('the CLI prints a table for the chosen configs and refuses unknown ones', { timeout: 300000 }, () => {
  assert.deepEqual(Object.keys(CONFIGS), ['each', 'f', 'a', 'af', 'e', 'aef', 'b'])
  const out = spawnSync(process.execPath, [script, '--slow-seconds', '0.1', '--only', 'f'], { encoding: 'utf8' })
  assert.equal(out.status, 0, out.stderr)
  assert.match(out.stdout, /^\| 配置 \| 集成模式 \|/)
  assert.match(out.stdout, /\n\| f \| each\+F \| 完成 8\/8 \|/)
  const bad = spawnSync(process.execPath, [script, '--only', 'zzz'], { encoding: 'utf8' })
  assert.equal(bad.status, 1)
  assert.match(bad.stderr, /unknown config zzz/)
})
