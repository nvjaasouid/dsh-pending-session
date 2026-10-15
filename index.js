/**
 * dsh-pending-session —— 宿主半边：自带一套「删除会话」实现。
 *
 * 为什么不复用第三方归档插件：它把「宿主进程内存里活着的会话」（attached）
 * 一律拒绝删除，而 DSH 本次运行中点开过的会话就会一直是这种状态，两边都没有
 * 关闭接口 —— 结果是用户根本删不掉自己刚看过的会话。
 *
 * 这里自实现删除，只做数据层的事（不碰运行中的会话对象）：
 *   1. 删 <DSH_HOME>/sessions/<项目key>/<会话段>/ 整个目录（旧 jsonl.zstd 布局）
 *   2. 若用 session-rdb（sqlite）存储，删 t_sessions 对应行（外键级联）
 *   3. 从工作区注册表的 sessionIds 记账里摘掉该会话
 * 安全约束：所有路径 realpath 校验必须落在 sessions 根目录内，绝不跟随逃逸的
 * 符号链接；共享附件目录（<DSH_HOME>/attachments）一律不动。
 *
 * 路由：POST /api/dsh-pending-session/delete  body { ids: string[] }
 *      仅接受回环请求；返回 { ok, results: [{ id, status, reason?, freedBytes }] }
 */
import { existsSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'

export const name = 'pending-session'

/** webServer 用于注册路由；workspaceRegistry 用于清理工作区记账（缺失则跳过该步）。 */
export const inject = ['webServer']

const ROUTE_PATH = '/api/dsh-pending-session/delete'
const BODY_MAX_BYTES = 200_000

function dshHome() {
  const env = process.env.DSH_HOME
  return typeof env === 'string' && env !== '' ? env : join(homedir(), '.dsh')
}

/** 会话段的规范化：DSH 存储以 `session-<uuid>` 或裸 `<uuid>` 命名。 */
function canonicalId(id) {
  return id.startsWith('session-') ? id : `session-${id}`
}

/** 段目录名的候选写法：DSH 实测**保留** `session-` 前缀，另一种布局会去掉，两种都试。 */
function segmentCandidates(id) {
  const canonical = canonicalId(id)
  return [canonical, canonical.slice('session-'.length)]
}

/** child 是否等于 root 或位于其下（词法比较，均已 resolve）。 */
function inside(root, child) {
  const r = resolve(root)
  const c = resolve(child)
  return c === r || c.startsWith(r + sep)
}

function dirSize(path) {
  let total = 0
  let entries
  try {
    entries = readdirSync(path)
  } catch {
    return 0
  }
  for (const entry of entries) {
    try {
      const info = statSync(join(path, entry))
      total += info.isDirectory() ? dirSize(join(path, entry)) : info.size
    } catch {
      // 读不到的条目按 0 计
    }
  }
  return total
}

/** 在 sessions 根目录下按段名找到该会话的目录（realpath 校验不逃逸）。 */
function findSessionDir(sessionsRoot, id) {
  if (!existsSync(sessionsRoot)) return undefined
  let rootReal
  try {
    rootReal = realpathSync(sessionsRoot)
  } catch {
    return undefined
  }
  let projects
  try {
    projects = readdirSync(sessionsRoot)
  } catch {
    return undefined
  }
  for (const segment of segmentCandidates(id)) {
    for (const project of projects) {
      const candidate = join(sessionsRoot, project, segment)
      let info
      try {
        info = statSync(candidate)
      } catch {
        continue
      }
      if (!info.isDirectory()) continue
      let real
      try {
        real = realpathSync(candidate)
      } catch {
        continue
      }
      if (!inside(rootReal, real)) continue // 逃逸的符号链接：不管理
      return real
    }
  }
  return undefined
}

/** 删 session-rdb（sqlite）里的行；返回是否删掉了行。 */
function deleteRdbRow(dbPath, id) {
  if (!existsSync(dbPath)) return false
  let db
  try {
    // node:sqlite 在 Node 22.19+/24 可用；不可用时静默跳过。
    const { DatabaseSync } = require('node:sqlite')
    db = new DatabaseSync(dbPath)
    const appId = db.prepare('pragma application_id').get()
    const userVersion = db.prepare('pragma user_version').get()
    if (appId?.application_id !== 1146308688 || userVersion?.user_version !== 1) return false
    const result = db.prepare('delete from t_sessions where f_session_id = ?').run(id)
    return Number(result.changes) > 0
  } catch {
    return false
  } finally {
    try {
      db?.close()
    } catch {
      // 关闭失败无关紧要
    }
  }
}

/** 只接受回环来源；隧道/局域网一律拒绝。 */
function isLoopback(req) {
  const address = req.socket?.remoteAddress ?? ''
  const okAddress = address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
  if (!okAddress) return false
  const host = String(req.headers?.host ?? '')
  return host === '' || /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host)
}

function readJsonBody(req) {
  return new Promise((resolveBody) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > BODY_MAX_BYTES) {
        req.destroy()
        resolveBody(undefined)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        resolveBody(undefined)
      }
    })
    req.on('error', () => resolveBody(undefined))
  })
}

function writeJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(text)
}

export function apply(ctx) {
  const webServer = ctx.get('webServer') ?? ctx.webServer
  if (webServer === undefined || typeof webServer.register !== 'function') return

  const dispose = webServer.register({
    kind: 'exact',
    path: ROUTE_PATH,
    handler: async (req, res) => {
      if (!isLoopback(req)) {
        writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' })
        return
      }
      if (req.method !== 'POST') {
        writeJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      const body = await readJsonBody(req)
      const rawIds = body !== null && typeof body === 'object' && Array.isArray(body.ids) ? body.ids : []
      const ids = []
      for (const value of rawIds) {
        if (typeof value !== 'string' || value === '' || value.length > 200) continue
        if (value.includes('/') || value.includes('\\') || value.includes('..')) continue // 路径安全
        ids.push(canonicalId(value))
      }
      if (ids.length === 0) {
        writeJson(res, 400, { ok: false, error: 'no session ids' })
        return
      }

      const home = dshHome()
      const sessionsRoot = join(home, 'sessions')
      const results = []

      for (const id of ids) {
        let freedBytes = 0
        let removedDir = false
        const dir = findSessionDir(sessionsRoot, id)
        if (dir !== undefined) {
          try {
            freedBytes += dirSize(dir)
            rmSync(dir, { recursive: true, force: true })
            removedDir = true
          } catch (error) {
            results.push({ id, status: 'failed', reason: 'storage-error', detail: String(error?.message ?? error).slice(0, 200), freedBytes: 0 })
            continue
          }
        }
        const removedRdb =
          deleteRdbRow(join(sessionsRoot, 'sessions.sqlite'), id) ||
          deleteRdbRow(join(home, 'sessions.sqlite'), id)

        if (!removedDir && !removedRdb) {
          // 磁盘上本来就没有该会话的存储（例如只有草稿、从未落盘的空白会话）：
          // 什么都别动，尤其不要摘工作区记账——否则会话会掉进「未分组」却还活着。
          results.push({ id, status: 'skipped', reason: 'not-found', freedBytes: 0 })
          continue
        }

        // 只有确实删掉了存储，才摘工作区记账（第三方同款 mutate 路径）
        let registryTouched = false
        try {
          const registry = ctx.get('workspaceRegistry') ?? ctx.workspaceRegistry
          if (registry !== undefined && typeof registry.list === 'function') {
            for (const entity of registry.list() ?? []) {
              if (entity === null || typeof entity !== 'object') continue
              if (typeof entity.mutate !== 'function') continue
              const list = Array.isArray(entity.sessionIds) ? entity.sessionIds : []
              if (!list.some((value) => canonicalId(String(value)) === id)) continue
              await entity.mutate((record) => ({
                ...record,
                sessionIds: (Array.isArray(record?.sessionIds) ? record.sessionIds : []).filter(
                  (value) => canonicalId(String(value)) !== id,
                ),
              }))
              registryTouched = true
            }
          }
        } catch {
          // 记账清理失败不阻塞数据删除：会话数据已删，行会在下次扫描时收敛
        }

        {
          results.push({ id, status: 'ok', removedDir, removedRdb, registryTouched, freedBytes })
        }
      }

      writeJson(res, 200, { ok: true, results })
    },
  })

  ctx.effect(() => () => {
    try {
      dispose?.()
    } catch {
      // 关闭期间路由 fiber 可能已消失
    }
  }, 'dsh-pending-session: delete route')
}
