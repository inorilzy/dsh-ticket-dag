import assert from 'node:assert/strict'
import test from 'node:test'
import { burn, checkInvariants, inputFor, soakSeconds, unusedBalanceKeys } from '../harness.mjs'

test('inputFor depends only on seed and tick, and stays in range', () => {
  for (const tick of [0, 1, 44, 45, 899]) {
    const a = inputFor(7, tick)
    assert.deepEqual(a, inputFor(7, tick))
    for (const v of [a.move.x, a.move.y, a.aim.x, a.aim.y]) assert.ok(v >= -1 && v <= 1)
  }
  assert.notDeepEqual(
    Array.from({ length: 90 }, (_, t) => inputFor(1, t)),
    Array.from({ length: 90 }, (_, t) => inputFor(2, t)),
  )
})

test('burn is deterministic', () => {
  assert.equal(burn(1000), burn(1000))
  assert.notEqual(burn(1000), burn(1001))
})

test('soakSeconds defaults to 60 and rejects bad values', () => {
  assert.equal(soakSeconds({}), 60)
  assert.equal(soakSeconds({ BENCH_SOAK_SECONDS: '1.5' }), 1.5)
  assert.throws(() => soakSeconds({ BENCH_SOAK_SECONDS: '0' }), RangeError)
  assert.throws(() => soakSeconds({ BENCH_SOAK_SECONDS: 'x' }), RangeError)
})

test('checkInvariants reports out-of-range hp, resources, embedded entities and unregistered events', () => {
  const view = {
    entities: [
      { id: 1, kind: 'tank', x: 16, y: 16, radius: 12, hp: 120, maxHp: 100 },
      { id: 2, kind: 'tank', x: 80, y: 16, radius: 12, hp: 50, maxHp: 100 },
      { id: 3, kind: 'shell', x: 80, y: 16, radius: 2, solid: false },
    ],
    terrain: { isBlocked: (x) => x >= 64 },
    resources: { ammo: { value: -1, max: 10 } },
    emittedEvents: ['tank:moved', 'ghost:event'],
  }
  const problems = checkInvariants(view, new Set(['tank:moved']))
  assert.equal(problems.length, 4)
  assert.match(problems.join('\n'), /hp 120/)
  assert.match(problems.join('\n'), /entity 2 .*embedded/)
  assert.match(problems.join('\n'), /resource ammo/)
  assert.match(problems.join('\n'), /ghost:event/)
  assert.deepEqual(checkInvariants({ entities: [] }, null), [])
})

test('unusedBalanceKeys only judges keys of registered systems', () => {
  const keys = ['tank.speed', 'tank.turn', 'shell.speed', 'meta.version']
  assert.deepEqual(unusedBalanceKeys(keys, ['tank.speed'], ['tank']), ['tank.turn'])
})
