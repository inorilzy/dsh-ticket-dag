import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { importTickets, parseSpecRef, writeback } from '../src/tracker.mjs'
import { normalizeManifest } from '../src/store.mjs'

const api = 'https://api.github.com/repos/o/r'
const issue = (number, title, body = '', state = 'open') => ({
  number,
  title,
  body,
  state,
  html_url: 'https://github.com/o/r/issues/' + number,
  repository_url: api,
})
const body = (what, criteria) =>
  '## Parent\n\nhttps://github.com/o/r/issues/1\n\n## What to build\n\n' + what +
  '\n\n## Acceptance criteria\n\n' + criteria.map((c) => '- [ ] ' + c).join('\n') + '\n'

// A fake gh answering the API paths the importer asks for; anything else is a 404.
function fakeGh({ parent, children, blockedBy = {}, others = {}, noSubIssues = false, search = [] }) {
  const calls = []
  const gh = async (cwd, args) => {
    calls.push(args)
    const path = args.find((a) => a.startsWith('repos/') || a === 'search/issues')
    const notFound = () => Object.assign(new Error('gh api failed: HTTP 404'), { notFound: true })
    if (args[0] === 'repo') return { nameWithOwner: 'o/r' }
    if (path === 'search/issues') return [{ items: search }]
    if (path === 'repos/o/r/issues/' + parent.number) return parent
    if (path.startsWith('repos/o/r/issues/' + parent.number + '/sub_issues')) {
      if (noSubIssues) throw notFound()
      return [children]
    }
    const dep = /^repos\/o\/r\/issues\/(\d+)\/dependencies\/blocked_by/.exec(path)
    if (dep) return blockedBy[dep[1]] ?? []
    const other = /^repos\/([^/]+\/[^/]+)\/issues\/(\d+)$/.exec(path)
    if (other && others[other[1] + '#' + other[2]]) return others[other[1] + '#' + other[2]]
    throw notFound()
  }
  return { gh, calls }
}

test('spec references: issue numbers, URLs and local paths', () => {
  assert.deepEqual(parseSpecRef('#1'), { kind: 'github', repo: undefined, number: 1 })
  assert.deepEqual(parseSpecRef('12', 'o/r'), { kind: 'github', repo: 'o/r', number: 12 })
  assert.deepEqual(parseSpecRef('https://github.com/a/b/issues/7'), { kind: 'github', repo: 'a/b', number: 7 })
  assert.deepEqual(parseSpecRef('.scratch/feat'), { kind: 'local', path: '.scratch/feat' })
  assert.throws(() => parseSpecRef('#1', 'not a repo'), /owner\/name/)
  assert.throws(() => parseSpecRef(''), /spec/)
})

test('GitHub sub-issues with native blocked-by edges import as a declared DAG that dag_run accepts', async () => {
  const children = [
    issue(2, '[T01] P1 · Trusted Git', body('Resolve git.', ['git is absolute', 'no hijack'])),
    issue(3, '[T02] P1 · Show checks', body('Show all.', ['all commands shown'])),
    issue(4, '[T03] P1 · Bind revision', body('Revision.', ['409 on stale'])),
    issue(5, '[T04] Integrate', body('Final.', ['all pass'])),
    issue(6, '[T05] Done already', body('x', ['y']), 'closed'),
  ]
  const blocked = (n) => ({ number: n, state: n === 6 ? 'closed' : 'open', repository_url: api, html_url: 'https://github.com/o/r/issues/' + n })
  const { gh } = fakeGh({
    parent: issue(1, '[Spec] Review fixes', '## Problem Statement\n\nThings.'),
    children,
    blockedBy: { 4: [blocked(3)], 5: [blocked(2), blocked(4), blocked(6)] },
  })
  const out = await importTickets({ cwd: '/repo', spec: '#1', gh })
  assert.equal(out.dependencyMode, 'declared')
  assert.equal(out.manifest.spec_id, 'gh-1')
  assert.deepEqual(out.manifest.tickets.map((t) => [t.id, t.title, t.depends_on]), [
    ['T01', 'P1 · Trusted Git', []],
    ['T02', 'P1 · Show checks', []],
    ['T03', 'P1 · Bind revision', ['T02']],
    // The closed T05 counts as satisfied and is left out.
    ['T04', 'Integrate', ['T01', 'T03']],
  ])
  assert.deepEqual(out.skipped, [{ ref: '#6', title: '[T05] Done already', reason: 'issue is closed' }])
  assert.deepEqual(out.manifest.tickets[0].acceptance, ['git is absolute', 'no hijack'])
  assert.match(out.manifest.tickets[0].prompt, /issues\/2[\s\S]*Parent spec: https:\/\/github.com\/o\/r\/issues\/1[\s\S]*Resolve git\./)
  assert.deepEqual(out.manifest.tickets[2].source, { kind: 'github', repo: 'o/r', number: 4, url: 'https://github.com/o/r/issues/4' })
  // The draft is a valid manifest as is, and the source survives normalization.
  const manifest = normalizeManifest(out.manifest)
  assert.deepEqual(manifest.tickets[3].dependsOn, ['T01', 'T03'])
  assert.equal(manifest.tickets[3].source.number, 5)
})

test('GitHub "Blocked by" body lines count as declared edges when native dependencies are absent', async () => {
  const { gh } = fakeGh({
    parent: issue(10, 'Spec'),
    children: [
      issue(11, 'First slice', body('a', ['a'])),
      issue(12, 'Second slice', body('b', ['b']) + '\n## Blocked by\n\n- #11\n'),
      issue(13, 'Third slice', 'Blocked by: None (can start immediately)\n' + body('c', ['c'])),
    ],
  })
  const out = await importTickets({ cwd: '/repo', spec: 'https://github.com/o/r/issues/10', gh })
  assert.equal(out.dependencyMode, 'declared')
  // Titles without a [tag] fall back to the issue number.
  assert.deepEqual(out.manifest.tickets.map((t) => [t.id, t.depends_on]), [
    ['gh-11', []],
    ['gh-12', ['gh-11']],
    ['gh-13', []],
  ])
})

test('GitHub tickets without any edge report mode none; no children report no-tickets', async () => {
  const none = await importTickets({
    cwd: '/repo',
    spec: '#1',
    gh: fakeGh({ parent: issue(1, 'S'), children: [issue(2, 'A', body('a', ['a'])), issue(3, 'B', body('b', ['b']))] }).gh,
  })
  assert.equal(none.dependencyMode, 'none')
  assert.match(none.guidance, /Infer depends_on/)
  const empty = await importTickets({ cwd: '/repo', spec: '#1', gh: fakeGh({ parent: issue(1, 'S', 'spec body'), children: [] }).gh })
  assert.equal(empty.dependencyMode, 'no-tickets')
  assert.equal(empty.spec.body, 'spec body')
  assert.deepEqual(empty.manifest.tickets, [])
})

test('an open blocker outside the spec is an error; a closed one is satisfied', async () => {
  const outside = (state) => ({ number: 99, state, repository_url: api, html_url: 'https://github.com/o/r/issues/99' })
  const open = fakeGh({ parent: issue(1, 'S'), children: [issue(2, 'A')], blockedBy: { 2: [outside('open')] } })
  await assert.rejects(importTickets({ cwd: '/repo', spec: '#1', gh: open.gh }), /#2 is blocked by .*99, which is open/)
  const closed = fakeGh({ parent: issue(1, 'S'), children: [issue(2, 'A')], blockedBy: { 2: [outside('closed')] } })
  const out = await importTickets({ cwd: '/repo', spec: '#1', gh: closed.gh })
  assert.deepEqual(out.manifest.tickets[0].depends_on, [])
  assert.equal(out.dependencyMode, 'declared')
})

test('without sub-issues, children are found by a "Part of #N" line', async () => {
  const { gh } = fakeGh({
    parent: issue(1, 'S'),
    noSubIssues: true,
    search: [issue(3, 'B', 'Part of #1\n\nBlocked by: #2'), issue(2, 'A', 'Part of #1'), issue(4, 'C', 'mentions Part of #1 later')],
  })
  const out = await importTickets({ cwd: '/repo', spec: '#1', gh })
  assert.deepEqual(out.manifest.tickets.map((t) => [t.id, t.depends_on]), [['gh-2', []], ['gh-3', ['gh-2']]])
  assert.match(out.warnings[0], /Part of #1/)
})

async function scratch(t, files) {
  const root = await mkdtemp(join(tmpdir(), 'dag-tracker-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const [name, text] of Object.entries(files)) {
    await mkdir(join(root, name, '..'), { recursive: true })
    await writeFile(join(root, name), text)
  }
  return root
}
const local = (n, title, blocked, status = 'ready-for-agent') =>
  '# ' + n + ': ' + title + '\n\n**What to build:** ' + title + '\n\n**Blocked by:** ' + blocked +
  '\n\n**Status:** ' + status + '\n\n- [ ] ' + title + ' works\n'

test('local .scratch tickets import their Blocked by lines and skip resolved ones', async (t) => {
  const root = await scratch(t, {
    '.scratch/login-flow/spec.md': '# Login flow\n\nDetails.',
    '.scratch/login-flow/issues/01-schema.md': local('01', 'Schema', 'None (can start immediately)'),
    '.scratch/login-flow/issues/02-api.md': local('02', 'API', '01'),
    '.scratch/login-flow/issues/03-ui.md': local('03', 'UI', '01, 02'),
    '.scratch/login-flow/issues/04-old.md': local('04', 'Old', 'None', 'resolved'),
    '.scratch/login-flow/issues/05-after-old.md': local('05', 'After old', '04'),
  })
  for (const spec of ['.scratch/login-flow', '.scratch/login-flow/spec.md', '.scratch/login-flow/issues']) {
    const out = await importTickets({ cwd: root, spec })
    assert.equal(out.dependencyMode, 'declared')
    assert.equal(out.manifest.spec_id, 'login-flow')
    assert.equal(out.spec.title, 'Login flow')
    assert.deepEqual(out.manifest.tickets.map((x) => [x.id, x.title, x.depends_on]), [
      ['T01', 'Schema', []],
      ['T02', 'API', ['T01']],
      ['T03', 'UI', ['T01', 'T02']],
      ['T05', 'After old', []],
    ])
    assert.equal(out.skipped[0].reason, 'status is resolved')
    assert.deepEqual(out.manifest.tickets[1].acceptance, ['API works'])
    assert.equal(out.manifest.tickets[1].source.kind, 'local')
    normalizeManifest(out.manifest)
  }
})

test('local tickets without Blocked by lines report none; a spec alone reports no-tickets; unknown blockers fail', async (t) => {
  const root = await scratch(t, {
    'a/spec.md': '# A',
    'a/issues/01-x.md': '# 01: X\n\n- [ ] x',
    'a/issues/02-y.md': '# 02: Y\n\n- [ ] y',
    'b/spec.md': '# B only',
    'c/issues/01-x.md': local('01', 'X', '07'),
  })
  assert.equal((await importTickets({ cwd: root, spec: 'a' })).dependencyMode, 'none')
  const b = await importTickets({ cwd: root, spec: 'b' })
  assert.equal(b.dependencyMode, 'no-tickets')
  assert.equal(b.spec.body, '# B only')
  await assert.rejects(importTickets({ cwd: root, spec: 'c' }), /blocked by 7, which is not a ticket/)
  await assert.rejects(importTickets({ cwd: root, spec: 'missing' }), /No such spec path/)
})

test('writeback comments, optionally closes, and ignores local tickets', async () => {
  const calls = []
  const gh = async (_cwd, args) => (calls.push(args), null)
  const source = { kind: 'github', repo: 'o/r', number: 4 }
  const base = { cwd: '/repo', runId: 'r1', ref: 'refs/heads/integration/r1', landedSha: 'abc', gh }
  assert.deepEqual(await writeback({ ...base, source, mode: 'comment' }), { status: 'commented', target: 'o/r#4' })
  assert.deepEqual(calls[0].slice(0, 4), ['issue', 'comment', '4', '--repo'])
  assert.match(calls[0].at(-1), /integration\/r1.*abc/)
  assert.equal(calls.length, 1)
  await writeback({ ...base, source, mode: 'close' })
  assert.deepEqual(calls.at(-1), ['issue', 'close', '4', '--repo', 'o/r', '--reason', 'completed'])
  assert.equal((await writeback({ ...base, source: { kind: 'local', path: 'x' }, mode: 'close' })).status, 'skipped')
})
