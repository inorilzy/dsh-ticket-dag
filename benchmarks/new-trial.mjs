#!/usr/bin/env node
// node benchmarks/new-trial.mjs <目标目录>
//
// 为一轮集成模式对比实验建一个全新的坦克战役基线仓库：复制 seed，把 spec 放到
// .scratch/tank-arena/，把冻结清单放到根目录 manifest.json，用固定作者、固定日期提交到 main。
// 每轮的 HEAD SHA 都相同，所以不同模式比较的是同一个起点。只用 Node 标准库和 git。
import { execFileSync } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const kit = join(dirname(fileURLToPath(import.meta.url)), 'tank-arena')
// 固定身份与日期，让提交对象逐字节相同；改动它们会改变基准 SHA。
const FIXED = {
  GIT_AUTHOR_NAME: 'Ferrowake Bench',
  GIT_AUTHOR_EMAIL: 'bench@ferrowake.invalid',
  GIT_AUTHOR_DATE: '2026-01-01T00:00:00+00:00',
  GIT_COMMITTER_NAME: 'Ferrowake Bench',
  GIT_COMMITTER_EMAIL: 'bench@ferrowake.invalid',
  GIT_COMMITTER_DATE: '2026-01-01T00:00:00+00:00',
}
const MESSAGE = 'Ferrowake tank-arena benchmark baseline\n'

function fail(message) {
  console.error('new-trial: ' + message)
  process.exit(1)
}

function git(cwd, args) {
  // 不读用户和系统级配置，避免签名、钩子模板或全局属性改变提交内容。
  const env = { ...process.env, ...FIXED, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull(), GIT_TERMINAL_PROMPT: '0' }
  // 从钩子或另一个 git 进程里启动时，这些变量会把命令指向外层仓库。
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_COMMON_DIR']) delete env[name]
  return execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}
const devNull = () => (process.platform === 'win32' ? 'NUL' : '/dev/null')

// 逐文件复制；按文本处理并统一为 LF，即使本仓库被以 CRLF 检出也得到相同的 blob。
function copyTree(from, to) {
  for (const name of readdirSync(from).sort()) {
    const src = join(from, name)
    const dst = join(to, name)
    if (statSync(src).isDirectory()) {
      mkdirSync(dst, { recursive: true })
      copyTree(src, dst)
    } else {
      mkdirSync(dirname(dst), { recursive: true })
      writeFileSync(dst, readFileSync(src, 'utf8').replace(/\r\n/g, '\n'))
    }
  }
}

const arg = process.argv[2]
if (!arg || process.argv.length > 3) fail('usage: node benchmarks/new-trial.mjs <target-directory>')
const target = resolve(arg)
let info = null
try {
  info = statSync(target)
} catch (err) {
  if (err.code !== 'ENOENT') throw err
}
if (info && !info.isDirectory()) fail(target + ' exists and is not a directory')
if (info && readdirSync(target).length) fail(target + ' already exists and is not empty; pick a new directory')
mkdirSync(target, { recursive: true })

copyTree(join(kit, 'seed'), target)
copyTree(join(kit, 'spec'), join(target, '.scratch', 'tank-arena'))
writeFileSync(join(target, 'manifest.json'), readFileSync(join(kit, 'manifest.json'), 'utf8').replace(/\r\n/g, '\n'))

let sha
try {
  git(target, ['init', '--quiet', '--initial-branch=main'])
  git(target, ['config', 'core.autocrlf', 'false'])
  git(target, ['config', 'core.eol', 'lf'])
  git(target, ['config', 'commit.gpgsign', 'false'])
  git(target, ['add', '--all'])
  git(target, ['commit', '--quiet', '--no-verify', '-m', MESSAGE])
  sha = git(target, ['rev-parse', 'HEAD'])
} catch (err) {
  fail('git failed: ' + String(err.stderr || err.message).trim())
}

const shown = relative(process.cwd(), target) || '.'
console.log('HEAD ' + sha)
console.log(`Trial repository ready at ${target}

Next:
  1. Open a DeepSeek Harness session in ${shown}.
  2. Start the run with the frozen manifest: dag_run with the contents of manifest.json
     (do not re-split the spec; .scratch/tank-arena/ is there for workers to read).
  3. Checks per ticket: fast = node --test checks/unit/, soak = node checks/soak.mjs (60 s by default).`)
