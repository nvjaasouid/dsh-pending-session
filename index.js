/**
 * dsh-pending-session —— 宿主半边：自带一套「删除会话」实现。
 *
 * 为什么不复用第三方归档插件：它把「宿主进程内存里活着的会话」（attached）
 * 一律拒绝删除，而 DSH 本次运行中点开过的会话就会一直是这种状态，两边都没有
 * 关闭接口 —— 结果是用户根本删不掉自己刚看过的会话。
 *
 * 这里自实现删除，只做数据层的事（不碰运行中的会话对象）：
 *   1. 删 <DSH_HOME>/sessions/<项目key>/<会话段>/ 整个目录（旧 jsonl.zstd 布局）。
 *      同一会话可能同时存在于多个项目目录里（工作区改名、归档副本等），全部删掉，
 *      并在结果里回报删除数量（removedDirs）
 *   2. 删 <DSH_HOME>/storages/session_projcache/sessions/<id>.json 投影缓存
 *      （标题/创建时间/cwd 的来源，不删的话「真删除」后侧边栏还能把它列出来）
 *      与其聚合索引 <DSH_HOME>/storages/session_projcache.json 里的对应行
 *   3. 从工作区注册表的 sessionIds 记账里摘掉该会话
 * 安全约束：所有路径 realpath 校验必须落在 sessions / projcache 根目录内，绝不跟随
 * 逃逸的符号链接；共享附件目录（<DSH_HOME>/attachments）一律不动。
 *
 * 明确不处理（宁可诚实，不留永不生效的代码）：sqlite 持久化检索索引。
 * DSH 的 session-query 派生读模型 schema 是 application_id=1146308689 /
 * user_version=8 / 表 persisted_sessions + fts5 persisted_docs；本仓库任何版本
 * 都没有过 t_sessions 这张表（旧代码判 1146308688/user_version=1 再 delete
 * from t_sessions，是永不生效的死代码，已删除）。该索引由会话日志重建，删掉日志
 * 后 DSH 自己会收敛；若将来 DSH 把它变成权威存储，删除路径必须另行清理
 * （见 README「安全与数据」）。
 *
 * 路由：POST /api/dsh-pending-session/delete  body { ids: string[] }
 *      仅接受回环来源的同源请求（见 isSameOriginRequest）；返回
 *      { ok, results: [{ id, status, reason?, removedDirs, removedProjcache?,
 *      removedProjcacheIndex?, registryTouched?, freedBytes }] }。
 *      results[].id 按调用方传入的原样拼写回显（不改写 session- 前缀）：
 *      客户端按 id 匹配结果，改写拼写会让裸 uuid 会话永远匹配不上。
 */
import { existsSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'

export const name = 'pending-session'

/** webServer 用于注册路由；workspaceRegistry 用于清理工作区记账（缺失则跳过该步）。 */
export const inject = ['webServer']

const ROUTE_PATH = '/api/dsh-pending-session/delete'
const BODY_MAX_BYTES = 200_000
/** 会话 id 白名单：`session-<uuid>` 或裸 `<uuid>`，不区分大小写。 */
const SESSION_ID_PATTERN = /^(?:session-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function dshHome() {
  const env = process.env.DSH_HOME
  return typeof env === 'string' && env !== '' ? env : join(homedir(), '.dsh')
}

/** 会话段的规范化：DSH 存储以 `session-<uuid>` 或裸 `<uuid>` 命名。 */
function canonicalId(id) {
  return id.startsWith('session-') ? id : `session-${id}`
}

/** 会话 id 的裸 uuid 拼写（去掉可选的 `session-` 前缀）。 */
function bareId(id) {
  return id.startsWith('session-') ? id.slice('session-'.length) : id
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

/**
 * 在 sessions 根目录下按段名找出该会话的**全部**目录（realpath 校验不逃逸）。
 * 同名会话可能同时存在于多个项目目录里（工作区改名/归档残留），只删第一个命中的
 * 会把副本留在盘上 —— 用户看到的仍是「删了却还在」。返回去重后的 realpath 数组。
 */
function findSessionDirs(sessionsRoot, id) {
  if (!existsSync(sessionsRoot)) return []
  let rootReal
  try {
    rootReal = realpathSync(sessionsRoot)
  } catch {
    return []
  }
  let projects
  try {
    projects = readdirSync(sessionsRoot)
  } catch {
    return []
  }
  const found = []
  const seen = new Set()
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
      if (seen.has(real)) continue // 两种拼写指向同一目录时只删一次
      seen.add(real)
      found.push(real)
    }
  }
  return found
}

/**
 * 删该会话的投影缓存：per-session 文件 + 聚合索引里的行。
 * 实测布局（两种拼写并存）：
 *   <DSH_HOME>/storages/session_projcache/sessions/<id>.json         内容 { version, record }
 *   <DSH_HOME>/storages/session_projcache.json                       形如 { tables: { sessions: { <id>: {...} } } }
 * 索引可能不存在（harness 自己决定何时落盘），存在才改；改不动不算失败。
 * 路径安全：先对目录做 realpath 校验，文件名只由已过滤的 id 拼出，不会逃逸。
 * @returns { removed: boolean, removedIndex: boolean }
 */
function deleteProjcache(home, id) {
  const outcome = { removed: false, removedIndex: false, indexTouched: false }
  const sessionDirRoot = join(home, 'storages', 'session_projcache', 'sessions')
  let dirReal
  try {
    if (existsSync(sessionDirRoot)) dirReal = realpathSync(sessionDirRoot)
  } catch {
    dirReal = undefined
  }
  if (dirReal !== undefined) {
    for (const spelling of segmentCandidates(id)) {
      const file = join(dirReal, `${spelling}.json`)
      try {
        if (!existsSync(file)) continue
        unlinkSync(file)
        outcome.removed = true
      } catch {
        // 单个文件删不掉不阻塞整体删除（可能被 harness 同时写着）
      }
    }
  }
  const indexPath = join(home, 'storages', 'session_projcache.json')
  try {
    if (existsSync(indexPath)) {
      const parsed = JSON.parse(readFileSync(indexPath, 'utf8'))
      const sessions = parsed?.tables?.sessions
      if (sessions !== null && typeof sessions === 'object') {
        let touched = false
        for (const spelling of segmentCandidates(id)) {
          if (Object.prototype.hasOwnProperty.call(sessions, spelling)) {
            delete sessions[spelling]
            touched = true
          }
        }
        if (touched) {
          outcome.indexTouched = true
          // 原子写：先写临时文件再 rename 覆盖。整文件重写一旦写到一半崩掉/被杀，
          // 索引就剩半截 JSON —— harness 读不出来，整批会话的标题/时间一起消失。
          // rename 在同一目录内是原子替换；失败则原文件不动，并清掉临时文件。
          const tempPath = `${indexPath}.dps-${process.pid}.tmp`
          try {
            writeFileSync(tempPath, JSON.stringify(parsed))
            renameSync(tempPath, indexPath)
            outcome.removedIndex = true
          } catch {
            try {
              unlinkSync(tempPath)
            } catch {
              // 临时文件不存在（或删不掉）都不影响删除结论
            }
          }
        }
      }
    }
  } catch {
    // 索引损坏/被占用：留给 harness 自己收敛，不影响删除结论
  }
  return outcome
}

/**
 * 把一个会话从工作区记账（workspaceRegistry 的实体 sessionIds）里摘掉。
 * 一条会话可能同时出现在多个实体里，全部摘；返回是否真的动过。
 * 记账清理失败不阻塞数据删除：会话数据已经删了，行会在下次扫描时收敛。
 */
async function pruneWorkspaceRegistry(ctx, id) {
  let touched = false
  try {
    const registry = ctx.get('workspaceRegistry') ?? ctx.workspaceRegistry
    if (registry === undefined || registry === null || typeof registry.list !== 'function') return false
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
      touched = true
    }
  } catch {
    return touched
  }
  return touched
}

/** 只接受回环来源；隧道/局域网一律拒绝。 */
function isLoopback(req) {
  const address = req.socket?.remoteAddress ?? ''
  const okAddress = address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
  if (!okAddress) return false
  const host = String(req.headers?.host ?? '')
  return host === '' || /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host)
}

/**
 * 同源校验：本端点会真删文件，光看回环地址 + Host 挡不住跨站请求 ——
 * 浏览器对「no-preflight 的跨站请求」（<form> 提交、text/plain 的 fetch、
 * sendBeacon 等）不做 CORS 校验，任意网页都能借用户的回环地址 POST 进来，
 * 删掉用户的会话。所以要求：
 *   - content-type 必须含 application/json：真实客户端 fetch 会带这个头；而跨站
 *     简单请求只允许 text/plain、application/x-www-form-urlencoded、
 *     multipart/form-data 三种值，凑不出 application/json，因此过不了这一关；
 *   - 若带 sec-fetch-site（现代浏览器会带），必须是 same-origin / none；
 *   - 若带 origin，其 host 必须与 host 头一致（即同源）。
 */
function isSameOriginRequest(req) {
  const headers = req.headers ?? {}
  const contentType = String(headers['content-type'] ?? '')
  if (!contentType.toLowerCase().includes('application/json')) return false
  const site = String(headers['sec-fetch-site'] ?? '').toLowerCase()
  if (site !== '' && site !== 'same-origin' && site !== 'none') return false
  const origin = String(headers.origin ?? '')
  if (origin === '') return true
  let originHost
  try {
    originHost = new URL(origin).host
  } catch {
    return false // 解析不了的 origin（含 "null"）按不同源处理
  }
  return originHost.toLowerCase() === String(headers.host ?? '').toLowerCase()
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

/**
 * 该会话是否**正在运行**（agent 有在跑的 turn）。
 *
 * 这是端点自己的第二道闸门：同源校验只证明"请求来自本页"，证不了"删它不会毁掉
 * 正在产生的输出"。客户端 UI 也会拦一次（行 running 标志），但那一道在客户端，
 * 端点作为对外暴露的破坏性能力必须自证。
 *
 * 判定用宿主公开服务 `ctx.agents.get(sessionId)?.status === 'running'`（DSH 自己的
 * 归档准入用的就是同一个判据）。服务缺失/抛错一律返回 false —— 不能因为读不到
 * 状态就把删除全禁掉，那会让插件在没有 agents 服务的 profile 里彻底不可用。
 */
function isSessionRunning(ctx, id) {
  try {
    const agents = (typeof ctx?.get === 'function' ? ctx.get('agents') : undefined) ?? ctx?.agents
    if (agents === undefined || agents === null || typeof agents.get !== 'function') return false
    const agent = agents.get(id) ?? agents.get(canonicalId(id))
    return agent !== undefined && agent !== null && agent.status === 'running'
  } catch {
    return false
  }
}

/** 路由处理器：拆成独立导出，便于用假 DSH_HOME 做无头测试（不注册真实路由）。 */
export function createDeleteHandler(ctx) {
  return async (req, res) => {
      if (!isLoopback(req)) {
        writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' })
        return
      }
      if (req.method !== 'POST') {
        writeJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      // 破坏性端点：必须是同源页面发来的 JSON 请求，否则一个字节都不碰
      if (!isSameOriginRequest(req)) {
        writeJson(res, 403, { ok: false, error: 'forbidden: cross-site request' })
        return
      }
      const body = await readJsonBody(req)
      const rawIds = body !== null && typeof body === 'object' && Array.isArray(body.ids) ? body.ids : []
      // pruneStale：调用方确认「这条行在界面上还在、但存储已经没了，请把悬空引用一起清掉」。
      // 只有明确要求时才会摘记账，见下面的 not-found 分支。
      const pruneStale = body !== null && typeof body === 'object' && body.pruneStale === true
      const requests = []
      for (const value of rawIds) {
        if (typeof value !== 'string' || value === '' || value.length > 200) continue
        if (value.includes('/') || value.includes('\\') || value.includes('..')) continue // 路径安全
        // 白名单：只认会话 id 的形状（`session-<uuid>` / 裸 `<uuid>`）。破坏性端点不接受
        // 任意目录名 —— 否则一个受控的 id（哪怕同源伪造）就能删掉 sessions 下同名目录。
        if (!SESSION_ID_PATTERN.test(value)) continue
        // original 用于回显（原样拼写），canonical 用于内部查找（两种拼写都试）
        requests.push({ original: value, canonical: canonicalId(value) })
      }
      if (requests.length === 0) {
        writeJson(res, 400, { ok: false, error: 'no session ids' })
        return
      }

      const home = dshHome()
      const sessionsRoot = join(home, 'sessions')
      const results = []

      for (const request of requests) {
        const id = request.canonical
        // 正在跑的会话：先拒，连一个字节都不碰（第二道自我闸门，见 isSessionRunning）
        let running = false
        try {
          running = isSessionRunning(ctx, bareId(id))
        } catch {
          running = false
        }
        if (running) {
          results.push({ id: request.original, status: 'failed', reason: 'running', removedDirs: 0, freedBytes: 0 })
          continue
        }
        let freedBytes = 0
        let removedDirs = 0
        let failedDirs = 0
        let failureDetail = ''
        for (const dir of findSessionDirs(sessionsRoot, id)) {
          try {
            freedBytes += dirSize(dir)
            rmSync(dir, { recursive: true, force: true })
            removedDirs += 1
          } catch (error) {
            // 单个副本删失败不阻塞其余副本：能删多少删多少，最后按结果如实回报
            failedDirs += 1
            failureDetail = String(error?.message ?? error).slice(0, 200)
          }
        }
        if (removedDirs === 0 && failedDirs > 0) {
          results.push({ id: request.original, status: 'failed', reason: 'storage-error', detail: failureDetail, removedDirs: 0, freedBytes: 0 })
          continue
        }
        const projcache = deleteProjcache(home, id)

        if (removedDirs === 0 && !projcache.removed && !projcache.removedIndex) {
          // 磁盘上**没有**该会话的任何存储。这里有两种截然不同的局面：
          //   a) 从未落盘的空白会话（正常）：什么都没删，如实回报 not-found，不动记账；
          //   b) 存储被外部删掉了、但 workspace 记账还留着它（悬空引用）：侧边栏照样显示
          //      一行「未分组」，点开报 ENOENT —— 行删不掉、也进不去，用户被卡住。
          // b 只有调用方明确要求（pruneStale）时才处理：判据要同时满足「两种拼写都没有
          // 目录」「per-session 投影缓存也没有」「聚合索引里也没有该行」，只要有一处还在，
          // 就不动记账（那条血泪教训：存储还在时摘记账 = 会话掉进未分组却还活着）。
          const absentEverywhere = !projcache.indexTouched
          let registryTouched = false
          if (pruneStale && absentEverywhere) {
            registryTouched = await pruneWorkspaceRegistry(ctx, id)
          }
          results.push({
            id: request.original,
            status: 'skipped',
            reason: 'not-found',
            prunedStale: registryTouched,
            freedBytes: 0,
          })
          continue
        }

        // 只有确实删掉了存储，才摘工作区记账（第三方同款 mutate 路径）
        let registryTouched = false
        registryTouched = await pruneWorkspaceRegistry(ctx, id)

        {
          results.push({
            id: request.original,
            status: 'ok',
            removedDirs,
            failedDirs,
            removedProjcache: projcache.removed || projcache.removedIndex,
            removedProjcacheIndex: projcache.removedIndex,
            registryTouched,
            freedBytes,
          })
        }
      }

      writeJson(res, 200, { ok: true, results })
  }
}

export function apply(ctx) {
  const webServer = ctx.get('webServer') ?? ctx.webServer
  if (webServer === undefined || typeof webServer.register !== 'function') return

  const dispose = webServer.register({ kind: 'exact', path: ROUTE_PATH, handler: createDeleteHandler(ctx) })

  ctx.effect(() => () => {
    try {
      dispose?.()
    } catch {
      // 关闭期间路由 fiber 可能已消失
    }
  }, 'dsh-pending-session: delete route')
}
