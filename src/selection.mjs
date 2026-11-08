// Which verification checks a candidate needs, from the files it changes, and
// which tickets declare overlapping files. Pure: no I/O, so the coordinator, the
// dashboard, the simulation and the tests share one rule set.

/**
 * A path glob as an anchored RegExp over '/'-separated repository paths.
 * Supports ** (any depth, including none when followed by /), * and ? (within
 * one path segment) and {a,b} alternatives. Written here instead of
 * path.matchesGlob, which still prints an experimental warning on Node 22.
 * A glob without a slash matches only at the repository root (*.md is not
 * docs/a.md); write **\/*.md for any depth.
 */
export function globToRegExp(glob) {
  if (typeof glob !== 'string' || !glob.trim() || glob.includes('\0'))
    throw new TypeError('a file glob must be non-empty text')
  return new RegExp('^' + translate(glob) + '$')
}

function translate(glob) {
  let out = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++
        if (glob[i + 1] === '/') {
          i++
          out += '(?:.*/)?'
        } else out += '.*'
      } else out += '[^/]*'
    } else if (c === '?') out += '[^/]'
    else if (c === '{') {
      const end = closing(glob, i)
      // An unmatched brace is a literal character, as in most shells.
      if (end < 0) {
        out += '\\{'
        continue
      }
      out += '(?:' + alternatives(glob.slice(i + 1, end)).map(translate).join('|') + ')'
      i = end
    } else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return out
}

function closing(glob, open) {
  let depth = 0
  for (let i = open; i < glob.length; i++) {
    if (glob[i] === '{') depth++
    else if (glob[i] === '}' && --depth === 0) return i
  }
  return -1
}

function alternatives(body) {
  const parts = []
  let depth = 0
  let start = 0
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '{') depth++
    else if (body[i] === '}') depth--
    else if (body[i] === ',' && depth === 0) {
      parts.push(body.slice(start, i))
      start = i + 1
    }
  }
  parts.push(body.slice(start))
  return parts
}

// Braces are expanded before segments are compared, so only * and ? are wildcards here.
const wild = /[*?]/
// Brace expansion past this many alternatives is treated as matching anything,
// so a pathological glob widens a warning instead of stalling dag_run.
const expandLimit = 64

// The alternatives a glob stands for, or null past expandLimit. An unmatched
// brace is literal and the braces after it still expand, as in translate().
function expand(glob, from = 0) {
  let open = glob.indexOf('{', from)
  while (open >= 0 && closing(glob, open) < 0) open = glob.indexOf('{', open + 1)
  if (open < 0) return [glob]
  const end = closing(glob, open)
  const out = []
  for (const part of alternatives(glob.slice(open + 1, end))) {
    // Rescanned from open: the expanded part may hold nested braces.
    const rest = expand(glob.slice(0, open) + part + glob.slice(end + 1), open)
    if (rest === null) return null
    for (const item of rest) {
      out.push(item)
      if (out.length > expandLimit) return null
    }
  }
  return out
}

// Whether two single path segments can name the same segment. Exact for
// literals and for a literal against a pattern; for two patterns it compares
// the literal text before the first and after the last wildcard, which can
// report an overlap that does not exist but never misses one.
function segmentsMeet(a, b) {
  const aw = wild.test(a),
    bw = wild.test(b)
  if (!aw && !bw) return a === b
  if (!aw) return globToRegExp(b).test(a)
  if (!bw) return globToRegExp(a).test(b)
  const head = (s) => s.slice(0, s.search(/[*?]/))
  const tail = (s) => s.slice(Math.max(s.lastIndexOf('*'), s.lastIndexOf('?')) + 1)
  const [ha, hb, ta, tb] = [head(a), head(b), tail(a), tail(b)]
  return (ha.startsWith(hb) || hb.startsWith(ha)) && (ta.endsWith(tb) || tb.endsWith(ta))
}

// Memoized on (i, j): without it several ** segments backtrack exponentially.
function pathsMeet(a, b) {
  const seen = new Map()
  const meet = (i, j) => {
    const key = i * (b.length + 1) + j
    if (seen.has(key)) return seen.get(key)
    let result
    if (i === a.length && j === b.length) result = true
    else if (a[i] === '**') result = meet(i + 1, j) || (j < b.length && meet(i, j + 1))
    else if (b[j] === '**') result = meet(i, j + 1) || (i < a.length && meet(i + 1, j))
    else if (i === a.length || j === b.length) result = false
    // ** inside a segment (a**b) crosses separators; assume it can match.
    else if (a[i].includes('**') || b[j].includes('**')) result = true
    else result = segmentsMeet(a[i], b[j]) && meet(i + 1, j + 1)
    seen.set(key, result)
    return result
  }
  return meet(0, 0)
}

/** Whether two file globs (globToRegExp syntax) can name a common path. */
export function globsOverlap(a, b) {
  if (a === b) return true
  const left = expand(a),
    right = expand(b)
  if (!left || !right) return true
  return left.some((x) => right.some((y) => pathsMeet(x.split('/'), y.split('/'))))
}

/**
 * Ticket pairs that declare overlapping files and may run at the same time.
 * A warning for the captain and the plan review, never a refusal: two tickets
 * that edit different parts of one file often merge cleanly.
 * @param tickets - [{ id, dependsOn, files?, status? }] in plan order.
 * @returns [{ tickets: [a, b], files: [glob or 'globA ↔ globB'] }]; a pair
 *   ordered by a transitive dependency, a ticket without files, and a ticket
 *   already integrated or cancelled are left out.
 */
export function fileOverlaps(tickets) {
  const byId = new Map(tickets.map((t) => [t.id, t]))
  const ancestors = new Map()
  const above = (id, trail = new Set()) => {
    if (ancestors.has(id)) return ancestors.get(id)
    const set = new Set()
    if (trail.has(id)) return set
    trail.add(id)
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      set.add(dep)
      for (const up of above(dep, trail)) set.add(up)
    }
    ancestors.set(id, set)
    return set
  }
  const open = tickets.filter(
    (t) => Array.isArray(t.files) && t.files.length && t.status !== 'INTEGRATED' && t.status !== 'CANCELLED',
  )
  const out = []
  for (let i = 0; i < open.length; i++) {
    for (let j = i + 1; j < open.length; j++) {
      const a = open[i],
        b = open[j]
      if (above(a.id).has(b.id) || above(b.id).has(a.id)) continue
      const files = []
      for (const x of a.files)
        for (const y of b.files) {
          if (!globsOverlap(x, y)) continue
          const label = x === y ? x : x + ' ↔ ' + y
          if (!files.includes(label)) files.push(label)
        }
      if (files.length) out.push({ tickets: [a.id, b.id], files })
    }
  }
  return out
}

/** Changed paths no glob in files covers, in changed order. */
export function undeclaredFiles(files, changed) {
  const patterns = files.map(globToRegExp)
  return changed.filter((f) => !patterns.some((p) => p.test(f)))
}

/**
 * Pick the checks a candidate must run.
 * @param checkIds - the accumulated check IDs, in run order.
 * @param checkMeta - { id: { files: glob[], fast } }; an ID without files always runs.
 * @param changedFiles - paths the candidate changes, or null when unknown.
 * @returns { run, skipped, fallback } with run and skipped in checkIds order;
 *   fallback names why everything runs ('no-diff', 'unclaimed:<file>') or is null.
 */
export function selectChecks(checkIds, checkMeta, changedFiles) {
  const ids = [...checkIds]
  if (!Array.isArray(changedFiles) || !changedFiles.length) return { run: ids, skipped: [], fallback: 'no-diff' }
  const scoped = new Map()
  for (const id of ids) {
    const files = checkMeta && Object.hasOwn(checkMeta, id) ? checkMeta[id]?.files : undefined
    if (Array.isArray(files) && files.length) scoped.set(id, files.map(globToRegExp))
  }
  const claims = (patterns, file) => patterns.some((p) => p.test(file))
  // With no check that always runs, a change no declared glob covers would go
  // entirely unverified: run everything instead.
  if (ids.length && scoped.size === ids.length) {
    const unclaimed = changedFiles.find((f) => ![...scoped.values()].some((patterns) => claims(patterns, f)))
    if (unclaimed !== undefined) return { run: ids, skipped: [], fallback: 'unclaimed:' + unclaimed }
  }
  const run = []
  const skipped = []
  for (const id of ids) {
    const patterns = scoped.get(id)
    if (!patterns || changedFiles.some((f) => claims(patterns, f))) run.push(id)
    else skipped.push(id)
  }
  return { run, skipped, fallback: null }
}
