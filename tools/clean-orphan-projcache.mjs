#!/usr/bin/env node
/**
 * 清理「孤儿投影缓存」：storages/session_projcache/sessions/<id>.json 里，
 * 那些在任何项目目录下都已经没有对应会话目录的记录。
 *
 * 为什么安全：DSH 自己的文档写明投影缓存是**派生读模型**（"a malformed or stale
 * record reads as absent"），它由会话日志重建；对应的会话日志都没了，这条记录就
 * 只是占位垃圾。插件永远不碰真实会话目录，本脚本也只删这一类缓存文件。
 *
 * 默认**只列不删**（dry-run）。要真删必须显式加 --apply：
 *
 *   node tools/clean-orphan-projcache.mjs                 # 列出来看看
 *   node tools/clean-orphan-projcache.mjs --apply         # 真的删
 *   node tools/clean-orphan-projcache.mjs --home D:\x\.dsh --apply
 *
 * 退出码：0 = 正常（含"没有孤儿"）；1 = 参数/路径错误。
 */
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const homeFlag = args.indexOf('--home')
const home = homeFlag === -1
  ? (process.env.DSH_HOME && process.env.DSH_HOME !== '' ? process.env.DSH_HOME : join(homedir(), '.dsh'))
  : args[homeFlag + 1]

if (home === undefined || home === '') {
  console.error('用法：node tools/clean-orphan-projcache.mjs [--home <DSH_HOME>] [--apply]')
  process.exit(1)
}

const sessionsRoot = join(home, 'sessions')
const cacheDir = join(home, 'storages', 'session_projcache', 'sessions')

if (!existsSync(cacheDir)) {
  console.log(`没有投影缓存目录，无需清理：${cacheDir}`)
  process.exit(0)
}

/** sessions 根下所有项目目录里的会话段名，去掉可选的 `session-` 前缀（两种拼写都算）。 */
const onDisk = new Set()
let projectCount = 0
if (existsSync(sessionsRoot)) {
  for (const project of readdirSync(sessionsRoot)) {
    const projectPath = join(sessionsRoot, project)
    let isDir = false
    try {
      isDir = statSync(projectPath).isDirectory()
    } catch {
      isDir = false
    }
    if (!isDir) continue
    projectCount += 1
    for (const segment of readdirSync(projectPath)) {
      const bare = segment.startsWith('session-') ? segment.slice('session-'.length) : segment
      onDisk.add(bare)
    }
  }
}

const files = readdirSync(cacheDir).filter((name) => name.endsWith('.json'))
const orphans = []
for (const name of files) {
  const bare = name.slice(0, -'.json'.length)
  const normalized = bare.startsWith('session-') ? bare.slice('session-'.length) : bare
  if (!onDisk.has(normalized)) orphans.push(name)
}

console.log(`DSH_HOME        : ${home}`)
console.log(`项目目录        : ${projectCount} 个（${onDisk.size} 个会话段）`)
console.log(`投影缓存记录    : ${files.length} 条`)
console.log(`孤儿（无会话目录）: ${orphans.length} 条\n`)

for (const name of orphans) console.log(`  ${name}`)

if (orphans.length === 0) {
  console.log('\n没有孤儿记录，什么都不用做。')
  process.exit(0)
}

if (!apply) {
  console.log('\n（dry-run：一个字节都没删。确认无误后加 --apply 真删）')
  process.exit(0)
}

let removed = 0
for (const name of orphans) {
  try {
    rmSync(join(cacheDir, name), { force: true })
    removed += 1
  } catch (error) {
    console.error(`  删除失败 ${name}: ${String(error?.message ?? error)}`)
  }
}
console.log(`\n已删除 ${removed}/${orphans.length} 条孤儿记录，剩下的 ${files.length - removed} 条都有对应会话。`)
