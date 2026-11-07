// Which verification checks a candidate needs, from the files it changes. Pure:
// no I/O, so the coordinator, the simulation and the tests share one rule set.

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
