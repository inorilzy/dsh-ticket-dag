import assert from 'node:assert/strict'
import { test } from 'node:test'
import { globToRegExp, selectChecks } from '../src/selection.mjs'

const matches = (glob, path) => globToRegExp(glob).test(path)

test('globs: ** spans directories, * and ? stay within one segment, braces list alternatives', () => {
  assert.ok(matches('**', 'a/b/c.js'))
  assert.ok(matches('**', 'top.txt'))
  assert.ok(matches('src/**', 'src/a/b.js'))
  assert.ok(!matches('src/**', 'srcx/a.js'))
  assert.ok(!matches('src/**', 'docs/src/a.js'))
  assert.ok(matches('**/*.md', 'README.md'), '**/ also matches no directory')
  assert.ok(matches('**/*.md', 'docs/a/b.md'))
  assert.ok(matches('src/**/test.js', 'src/test.js'))
  assert.ok(matches('src/**/test.js', 'src/x/y/test.js'))
  assert.ok(matches('*.md', 'README.md'))
  assert.ok(!matches('*.md', 'docs/a.md'), '* does not cross /')
  assert.ok(matches('checks/?.mjs', 'checks/a.mjs'))
  assert.ok(!matches('checks/?.mjs', 'checks/ab.mjs'))
  assert.ok(matches('checks/{soak,harness}.mjs', 'checks/soak.mjs'))
  assert.ok(matches('checks/{soak,harness}.mjs', 'checks/harness.mjs'))
  assert.ok(!matches('checks/{soak,harness}.mjs', 'checks/unit.mjs'))
  assert.ok(matches('{src,lib}/**/*.{js,mjs}', 'lib/a/b.mjs'))
  assert.ok(!matches('{src,lib}/**/*.{js,mjs}', 'lib/a/b.ts'))
})

test('globs treat regex characters literally and refuse empty patterns', () => {
  assert.ok(matches('a.b', 'a.b'))
  assert.ok(!matches('a.b', 'axb'))
  assert.ok(matches('x(1)+[y]$.txt', 'x(1)+[y]$.txt'))
  assert.ok(matches('a{b', 'a{b'), 'an unmatched brace is literal')
  assert.ok(matches('logic-bug.txt', 'logic-bug.txt'))
  assert.throws(() => globToRegExp(''), /non-empty/)
  assert.throws(() => globToRegExp(42), /non-empty/)
})

const meta = {
  fast: { files: ['**'], fast: true },
  slow: { files: ['src/**', 'logic-bug.txt'], fast: false },
}

test('a check runs only when a changed file matches one of its globs', () => {
  assert.deepEqual(selectChecks(['fast', 'slow'], meta, ['docs/guide.md']), {
    run: ['fast'],
    skipped: ['slow'],
    fallback: null,
  })
  assert.deepEqual(selectChecks(['fast', 'slow'], meta, ['docs/guide.md', 'src/a.txt']), {
    run: ['fast', 'slow'],
    skipped: [],
    fallback: null,
  })
  assert.deepEqual(selectChecks(['slow', 'fast'], meta, ['logic-bug.txt']).run, ['slow', 'fast'], 'order is kept')
})

test('a check without files always runs, and then an unclaimed file needs no fallback', () => {
  const partial = { slow: { files: ['src/**'] } }
  assert.deepEqual(selectChecks(['unit', 'slow'], partial, ['docs/a.md']), {
    run: ['unit'],
    skipped: ['slow'],
    fallback: null,
  })
  // An empty files list is the same as none: always run.
  assert.deepEqual(selectChecks(['x'], { x: { files: [], fast: true } }, ['a']).run, ['x'])
  assert.deepEqual(selectChecks(['x'], undefined, ['a']).run, ['x'])
})

test('no diff, or a change no declared check claims, runs everything', () => {
  assert.deepEqual(selectChecks(['fast', 'slow'], meta, null), { run: ['fast', 'slow'], skipped: [], fallback: 'no-diff' })
  assert.deepEqual(selectChecks(['fast', 'slow'], meta, []), { run: ['fast', 'slow'], skipped: [], fallback: 'no-diff' })
  const scoped = { a: { files: ['src/**'] }, b: { files: ['test/**'] } }
  assert.deepEqual(selectChecks(['a', 'b'], scoped, ['src/x.js', 'package.json']), {
    run: ['a', 'b'],
    skipped: [],
    fallback: 'unclaimed:package.json',
  })
  assert.deepEqual(selectChecks(['a', 'b'], scoped, ['src/x.js']), { run: ['a'], skipped: ['b'], fallback: null })
  assert.deepEqual(selectChecks([], scoped, ['src/x.js']), { run: [], skipped: [], fallback: null })
})
