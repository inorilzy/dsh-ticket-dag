// node --test checks/unit/ 把目录当作入口解析到这个文件；它按文件名顺序导入同目录
// 全部 .mjs 检查文件。文件名刻意不匹配 node --test 的默认发现规则，
// 所以在别的仓库里跑无参数的 node --test 不会误跑到这些检查。
import { readdirSync } from 'node:fs'

const here = new URL('./', import.meta.url)
for (const name of readdirSync(here).filter((f) => f.endsWith('.mjs')).sort()) {
  await import(new URL(name, here))
}
