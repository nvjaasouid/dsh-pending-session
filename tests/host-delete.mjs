/**
 * 宿主半边（index.js）无头测试：假 DSH_HOME + 假 webServer.register 走真实删除处理器。
 * 铁律：绝不触碰真实 DSH_HOME —— 所有路径都在 mkdtemp 出来的临时目录里。
 */
import fs from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { createDeleteHandler } from '../index.js';

const out = { pass: 0, fail: 0 };
// 源码级断言用：实现方式的约定（死代码不许复活、索引必须原子写）
const indexSource = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
function assert(cond, label) {
  if (cond) { out.pass++; console.log('  ✓', label); }
  else { out.fail++; console.log('  ✗ FAIL:', label); }
}

/** 造一个假 DSH_HOME：会话目录 + projcache 两种拼写 + 聚合索引。 */
function makeHome(sessionId, opts = {}) {
  const home = fs.mkdtempSync(join(os.tmpdir(), 'dps-host-'));
  const bare = sessionId.replace(/^session-/, '');
  const projectDir = join(home, 'sessions', '--C-fake-workspace--');
  fs.mkdirSync(join(projectDir, sessionId), { recursive: true });
  fs.writeFileSync(join(projectDir, sessionId, 'events.jsonl.zstd'), 'x'.repeat(64));
  const projDir = join(home, 'storages', 'session_projcache', 'sessions');
  fs.mkdirSync(projDir, { recursive: true });
  if (opts.projSpelling !== 'none') {
    const name = opts.projSpelling === 'bare' ? bare : sessionId;
    fs.writeFileSync(join(projDir, name + '.json'), JSON.stringify({ version: 7, record: { rows: { title: { val: 'T' } } } }));
  }
  if (opts.index !== false) {
    fs.writeFileSync(join(home, 'storages', 'session_projcache.json'), JSON.stringify({
      tables: { sessions: { [sessionId]: { rows: { title: { val: 'T' } } }, 'other-session': { rows: {} } } },
    }));
  }
  return { home, bare, projDir, index: join(home, 'storages', 'session_projcache.json') };
}

/**
 * 最小 req 桩：handler 只用到 method / socket.remoteAddress / headers / on()。
 * 默认带 content-type: application/json —— M3 之后没有它一律 403（真实客户端
 * 的 fetch 本来就会带这个头）。
 */
function makeReq(ids, opts = {}) {
  const listeners = {};
  const req = {
    method: opts.method ?? 'POST',
    socket: { remoteAddress: opts.remoteAddress ?? '127.0.0.1' },
    headers: Object.assign(
      { host: '127.0.0.1:19387', 'content-type': 'application/json' },
      opts.headers ?? {},
    ),
    on(event, cb) { listeners[event] = cb; return req; },
    destroy() {},
  };
  for (const [key, value] of Object.entries(opts.headers ?? {})) {
    if (value === undefined) delete req.headers[key];
  }
  return {
    req,
    fire() {
      const payload = Buffer.from(JSON.stringify({ ids }), 'utf8');
      listeners.data?.(payload);
      listeners.end?.();
    },
  };
}

async function callHandler(handler, ids, opts = {}) {
  const { req, fire } = makeReq(ids, opts);
  let status = 0;
  let body = null;
  const res = {
    writeHead(code) { status = code; },
    end(text) { body = JSON.parse(text); },
  };
  const done = handler(req, res);
  fire();
  await done;
  return { status, body };
}

/** 假 workspaceRegistry：记录 mutate 是否被调用，并真的摘除 id。 */
function makeRegistry() {
  const entity = {
    sessionIds: [],
    mutated: 0,
    async mutate(fn) { this.mutated++; this.record = fn({ sessionIds: this.sessionIds }); },
  };
  return { registry: { list: () => [entity] }, entity };
}

export async function runHostTests() {
  console.log('\n== 宿主半边：index.js 删除端点（临时 DSH_HOME）==');

  // ---- 用例 1：删目录 + 删 projcache（session- 前缀拼写）+ 清理索引 + 摘记账 ----
  const id1 = 'session-11111111-2222-3333-4444-555555555555';
  const h1 = makeHome(id1);
  const reg1 = makeRegistry();
  reg1.entity.sessionIds = [id1, 'keep-me'];
  const ctx1 = { get: (name) => (name === 'workspaceRegistry' ? reg1.registry : undefined) };
  const handler1 = createDeleteHandler(ctx1);
  const savedHome = process.env.DSH_HOME;
  process.env.DSH_HOME = h1.home;
  const r1 = await callHandler(handler1, [id1]);
  process.env.DSH_HOME = savedHome;
  const row1 = r1.body?.results?.[0];
  assert(r1.status === 200 && r1.body.ok === true, '删除端点返回 ok');
  assert(row1?.status === 'ok', '会话删除成功');
  assert(row1?.removedDirs === 1, '会话目录被删除（回报删除数量）');
  assert(row1?.removedProjcache === true, '投影缓存文件被删除（P0-①）');
  assert(fs.existsSync(join(h1.projDir, id1 + '.json')) === false, '磁盘上投影缓存确实没了');
  assert(row1?.removedProjcacheIndex === true, '聚合索引里的该会话行被删除');
  const indexAfter = JSON.parse(fs.readFileSync(h1.index, 'utf8'));
  assert(indexAfter.tables.sessions[id1] === undefined, '索引里 target 已摘除');
  assert(indexAfter.tables.sessions['other-session'] !== undefined, '索引里其他会话不动');
  assert(fs.readdirSync(join(h1.home, 'storages')).every((name) => name.endsWith('.tmp') === false), 'M-d：索引落地后不留临时文件');
  assert(reg1.entity.mutated === 1 && reg1.entity.record.sessionIds.indexOf('keep-me') !== -1, '工作区记账只摘除目标会话');
  fs.rmSync(h1.home, { recursive: true, force: true });

  // ---- 用例 2：另一种拼写（裸 uuid 文件名）也要删掉 ----
  const id2 = 'session-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const h2 = makeHome(id2, { projSpelling: 'bare', index: false });
  const handler2 = createDeleteHandler({ get: () => undefined });
  process.env.DSH_HOME = h2.home;
  const r2 = await callHandler(handler2, [id2]);
  process.env.DSH_HOME = savedHome;
  assert(r2.body?.results?.[0]?.removedProjcache === true, '裸 uuid 拼写的投影缓存也被删除');
  assert(fs.existsSync(join(h2.projDir, h2.bare + '.json')) === false, '裸 uuid 投影文件确实没了');
  fs.rmSync(h2.home, { recursive: true, force: true });

  // ---- 用例 3：投影缓存目录/索引都不要动到目录之外的东西 ----
  const id3 = 'session-99999999-8888-7777-6666-555555555555';
  const h3 = makeHome(id3, { projSpelling: 'none', index: false });
  const neighbor = join(h3.projDir, 'someone-else.json');
  fs.writeFileSync(neighbor, '{}');
  const handler3 = createDeleteHandler({ get: () => undefined });
  process.env.DSH_HOME = h3.home;
  const r3 = await callHandler(handler3, [id3]);
  process.env.DSH_HOME = savedHome;
  assert(r3.body?.results?.[0]?.status === 'ok', '没有投影文件的会话也能删（删目录）');
  assert(r3.body?.results?.[0]?.removedProjcache === false, '没有对应投影文件时如实在结果里标 false');
  assert(fs.existsSync(neighbor) === true, '同目录其他会话的投影文件不受影响');
  fs.rmSync(h3.home, { recursive: true, force: true });

  // ---- 用例 4：什么都没有 → skipped/not-found（客户端据此区分语义）----
  const id4 = 'session-00000000-0000-0000-0000-000000000000';
  const h4 = fs.mkdtempSync(join(os.tmpdir(), 'dps-host-'));
  fs.mkdirSync(join(h4, 'sessions'), { recursive: true });
  fs.mkdirSync(join(h4, 'storages'), { recursive: true });
  fs.writeFileSync(join(h4, 'storages', 'session_projcache.json'), JSON.stringify({ tables: { sessions: {} } }));
  const handler4 = createDeleteHandler({ get: () => undefined });
  process.env.DSH_HOME = h4.home;
  const r4 = await callHandler(handler4, [id4]);
  process.env.DSH_HOME = savedHome;
  assert(r4.body?.results?.[0]?.status === 'skipped' && r4.body.results[0].reason === 'not-found', '磁盘上无存储 → skipped/not-found');
  fs.rmSync(h4, { recursive: true, force: true });

  // ---- 用例 5（M-a）：不再有 sqlite 分支 —— 不处理 rdb，也不谎报 removedRdb ----
  // 旧代码判 application_id=1146308688 / user_version=1 再 delete from t_sessions，
  // 而真实 DSH 的派生索引是 1146308689 / user_version=8 / persisted_sessions + fts5
  // persisted_docs，全 asar 都没有 t_sessions 这张表 → 那段是永不生效的死代码。
  const id5 = 'session-12345678-1234-1234-1234-123456789abc';
  const h5 = makeHome(id5, { projSpelling: 'none', index: false });
  fs.writeFileSync(join(h5.home, 'sessions', 'sessions.sqlite'), 'not-a-real-db');
  const handler5 = createDeleteHandler({ get: () => undefined });
  process.env.DSH_HOME = h5.home;
  const r5 = await callHandler(handler5, [id5]);
  process.env.DSH_HOME = savedHome;
  const row5 = r5.body?.results?.[0];
  assert(row5?.status === 'ok' && row5?.removedDirs === 1, 'M-a：没有任何 sqlite 处理，会话目录照样删掉');
  assert(row5?.removedRdb === undefined, 'M-a：结果里不再有 removedRdb（不假装处理过 sqlite）');
  assert(fs.existsSync(join(h5.home, 'sessions', 'sessions.sqlite')) === true, 'M-a：未知的 sqlite 文件一个字节都不动（不删、不改 schema）');
  assert(indexSource.includes('delete from t_sessions') === false && indexSource.includes('DatabaseSync') === false, 'M-a：index.js 里不再留永不生效的 rdb 死代码（不 prepare、不开 sqlite 连接）');
  assert(indexSource.includes('1146308689') === true, 'M-a：注释里如实写明真实 schema（application_id=1146308689）');
  fs.rmSync(h5.home, { recursive: true, force: true });

  // ---- 用例 6（M-b）：宿主按调用方传入的原样 id 回显（裸 uuid 不改写成 session-<uuid>）----
  const bare6 = '12345678-1234-1234-1234-123456789abc';
  const h6 = makeHome('session-' + bare6, { projSpelling: 'none', index: false });
  const handler6 = createDeleteHandler({ get: () => undefined });
  process.env.DSH_HOME = h6.home;
  const r6 = await callHandler(handler6, [bare6]);
  process.env.DSH_HOME = savedHome;
  assert(r6.body?.results?.[0]?.id === bare6, 'M-b：裸 uuid 原样回显（客户端按 id 匹配才不会落空）');
  assert(r6.body?.results?.[0]?.status === 'ok', 'M-b：裸 uuid 会话照样删得掉');
  assert(fs.existsSync(join(h6.home, 'sessions', '--C-fake-workspace--', 'session-' + bare6)) === false, 'M-b：裸 uuid 会话目录真的没了');
  fs.rmSync(h6.home, { recursive: true, force: true });

  // ---- 用例 7：同名会话同时存在于多个项目目录 → 全部删掉并回报数量 ----
  const id7 = 'session-abcdefab-1234-1234-1234-123456789abc';
  const h7 = makeHome(id7, { projSpelling: 'none', index: false });
  const secondProject = join(h7.home, 'sessions', '--C-other-workspace--', id7);
  fs.mkdirSync(secondProject, { recursive: true });
  fs.writeFileSync(join(secondProject, 'events.jsonl.zstd'), 'y'.repeat(32));
  const handler7 = createDeleteHandler({ get: () => undefined });
  process.env.DSH_HOME = h7.home;
  const r7 = await callHandler(handler7, [id7]);
  process.env.DSH_HOME = savedHome;
  assert(r7.body?.results?.[0]?.removedDirs === 2, '同名会话在所有项目目录里都被删除（不再只删第一个命中的）');
  assert(fs.existsSync(secondProject) === false, '第二个项目目录确实没了');
  fs.rmSync(h7.home, { recursive: true, force: true });

  // ---- 用例 8：聚合索引写失败（目标不可替换）也不留半截 JSON、不留临时文件 ----
  const id8 = 'session-87654321-4321-4321-4321-cba987654321';
  const h8 = makeHome(id8);
  const handler8 = createDeleteHandler({ get: () => undefined });
  process.env.DSH_HOME = h8.home;
  fs.chmodSync(h8.index, 0o444); // 只读：rename 无法覆盖（Windows 上必失败；平台允许时则照常替换）
  const r8 = await callHandler(handler8, [id8]);
  process.env.DSH_HOME = savedHome;
  assert(r8.body?.results?.[0]?.status === 'ok', 'M-d：索引写不进去也不影响会话删除结论');
  let indexParsed = null;
  try { indexParsed = JSON.parse(fs.readFileSync(h8.index, 'utf8')); } catch { indexParsed = null; }
  assert(indexParsed !== null, 'M-d：索引始终是完整 JSON（原子写：不留半截文件）');
  assert(fs.readdirSync(join(h8.home, 'storages')).every((name) => name.includes('.dps-') === false), 'M-d：写失败也不留临时文件');
  assert(indexSource.includes('renameSync(tempPath, indexPath)') && indexSource.includes('.dps-'), 'M-d：聚合索引走「临时文件 + rename」原子写（不是整文件重写）');
  fs.chmodSync(h8.index, 0o666);
  fs.rmSync(h8.home, { recursive: true, force: true });

  // ---- 用例 9：路径安全（带分隔符/.. 的 id 被拒）----
  const h9 = fs.mkdtempSync(join(os.tmpdir(), 'dps-host-'));
  const handler9 = createDeleteHandler({ get: () => undefined });
  process.env.DSH_HOME = h9;
  const r9 = await callHandler(handler9, ['../../etc/passwd', 'a/b']);
  process.env.DSH_HOME = savedHome;
  assert(r9.status === 400 && r9.body.ok === false, '非法 id 一律拒绝（路径安全）');
  fs.rmSync(h9, { recursive: true, force: true });

  // ---- 用例 10（M3）：跨站 no-preflight 请求一律 403，且一个字节都不删 ----
  const id10 = 'session-77777777-7777-7777-7777-777777777777';
  const h10 = makeHome(id10);
  const handler10 = createDeleteHandler({ get: () => undefined });
  const dir10 = join(h10.home, 'sessions', '--C-fake-workspace--', id10);
  process.env.DSH_HOME = h10.home;
  const denied = [
    ['缺 content-type', { headers: { 'content-type': undefined } }],
    ['text/plain（跨站简单请求）', { headers: { 'content-type': 'text/plain' } }],
    ['表单编码', { headers: { 'content-type': 'application/x-www-form-urlencoded' } }],
    ['sec-fetch-site: cross-site', { headers: { 'sec-fetch-site': 'cross-site' } }],
    ['origin 与 host 不同源', { headers: { origin: 'http://evil.example' } }],
    ['origin 无法解析', { headers: { origin: 'null' } }],
  ];
  let deniedOk = 0;
  for (const [label, opts] of denied) {
    const r = await callHandler(handler10, [id10], opts);
    if (r.status === 403 && r.body.ok === false) deniedOk += 1;
    else console.log('    – 未被拒绝:', label, r.status);
  }
  process.env.DSH_HOME = savedHome;
  assert(deniedOk === denied.length, `跨站/非 JSON 请求全部 403（${deniedOk}/${denied.length}）`);
  assert(fs.existsSync(dir10) === true, '被拒请求没有删掉任何东西（会话目录还在）');

  // 同源的真实客户端请求必须照旧放行
  const sameOrigin = [
    ['sec-fetch-site: same-origin', { headers: { 'sec-fetch-site': 'same-origin' } }],
    ['sec-fetch-site: none', { headers: { 'sec-fetch-site': 'none' } }],
    ['origin 与 host 一致', { headers: { origin: 'http://127.0.0.1:19387' } }],
    ['带 charset 的 JSON', { headers: { 'content-type': 'application/json; charset=utf-8' } }],
  ];
  let allowedOk = 0;
  for (const [, opts] of sameOrigin) {
    const h = makeHome(id10, { projSpelling: 'none', index: false });
    process.env.DSH_HOME = h.home;
    const r = await callHandler(createDeleteHandler({ get: () => undefined }), [id10], opts);
    process.env.DSH_HOME = savedHome;
    if (r.status === 200 && r.body?.results?.[0]?.status === 'ok') allowedOk += 1;
    fs.rmSync(h.home, { recursive: true, force: true });
  }
  assert(allowedOk === sameOrigin.length, `同源 JSON 请求照旧放行（${allowedOk}/${sameOrigin.length}）`);
  fs.rmSync(h10.home, { recursive: true, force: true });

  return out;
}
