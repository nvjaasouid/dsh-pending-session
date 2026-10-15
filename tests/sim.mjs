// dsh-pending-session 无头模拟测试：桩掉浏览器环境与 DSH 服务，跑通核心状态机。
import fs from 'node:fs';
import vm from 'node:vm';

// ---------------- 存储桩 ----------------
const localStorageData = new Map();
globalThis.localStorage = {
  getItem: (k) => (localStorageData.has(k) ? localStorageData.get(k) : null),
  setItem: (k, v) => localStorageData.set(k, String(v)),
  removeItem: (k) => localStorageData.delete(k),
};

const idbData = new Map();
globalThis.indexedDB = {
  open() {
    return {
      result: {
        objectStoreNames: { contains: () => true },
        createObjectStore: () => {},
        transaction: () => ({
          objectStore: () => ({
            put: (v, k) => idbData.set(k, v),
            get: (k) => ({ onsuccess: null, result: idbData.get(k) }),
            delete: (k) => idbData.delete(k),
          }),
          oncomplete: null,
          onerror: null,
        }),
      },
      onupgradeneeded: null,
      onsuccess: null,
      onerror: null,
    };
  },
};

// ---------------- React 桩 ----------------
const React = {
  memo: (f) => f,
  createElement: (type, props, ...children) => ({ type, props, children }),
  Fragment: Symbol('Fragment'),
  useRef: () => ({ current: null }),
  useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
  useEffect: () => {},
};

// ---------------- primitives 桩 ----------------
const primitives = new Proxy({}, {
  get: (_t, prop) => () => null,
});

// ---------------- store 桩（近似 createSnapshotStore 语义） ----------------
function createSnapshotStore(init) {
  let state = init;
  const listeners = new Set();
  return {
    getSnapshot: () => state,
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    set: (next) => { state = next; for (const fn of [...listeners]) fn(); },
    update: () => {},
  };
}

// ---------------- 会话/服务桩 ----------------
let rows = {};
let mainId = undefined;
const archived = new Set();

function makeRow(id, blank, updatedAt, cwd, title) {
  return { id, blank, updatedAt, cwd, title, displayTitle: title ?? id, running: false, retainedBy: {} };
}
function publishList() {
  const byId = {};
  const ids = [];
  for (const [id, row] of Object.entries(rows)) {
    byId[id] = { ...row, retainedBy: { ...row.retainedBy, mainView: id === mainId ? 1 : 0 } };
    ids.push(id);
  }
  sessions.list.set({ ids, byId, phase: 'ready', projectionsBySession: {} });
}

const shells = new Map();
function shellFor(id) {
  if (!shells.has(id)) {
    const store = createSnapshotStore({ draft: '', attachmentIds: [] });
    const shell = {
      state: store,
      actions: { setDraft: (t) => store.set({ ...store.getSnapshot(), draft: t }), addAttachments: () => true, removeAttachment: () => true, submit: () => {} },
      addAttachments: (ids) => { store.set({ ...store.getSnapshot(), attachmentIds: [...store.getSnapshot().attachmentIds, ...ids] }); return true; },
    };
    shells.set(id, shell);
  }
  return shells.get(id);
}
const conversation = {
  input: { for: (scoped) => shellFor(scoped && scoped.__id !== undefined ? scoped.__id : mainId) },
  draftAttachments: new Map(),
  createDrafts: (_sid, files) => files.map((f) => { const d = { id: 'd' + Math.random().toString(36).slice(2, 8), kind: 'file', file: f }; conversation.draftAttachments.set(d.id, d); return d; }),
};

const scopedCtxFor = (id) => ({ __id: id, get: (n) => (n === 'conversation' ? conversation : undefined) });
// 模拟客户端本地引用计数：counts 里的条数每读一次递减（模拟切走后被释放）
const simRetain = { counts: new Map(), reads: 0 };
const sessions = {
  list: createSnapshotStore({ ids: [], byId: {}, phase: 'pending', projectionsBySession: {} }),
  scope: (id) => (rows[id] ? scopedCtxFor(id) : undefined),
  using: async (_id, _o, fn) => fn({ binding: { session: { rename: () => ({ ok: true }) } } }),
  retainInfo: (id) => ({
    getSnapshot: () => {
      const held = simRetain.counts.get(id) || 0;
      simRetain.reads += 1;
      if (held > 0) simRetain.counts.set(id, held - 1);
      return { referenceCount: held, retainedBy: held > 0 ? { mainView: held } : {} };
    },
  }),
  create: async ({ workspaceId, sessionId }) => {
    const id = sessionId ?? 's' + Math.random().toString(36).slice(2, 8);
    rows[id] = makeRow(id, true, Date.now(), 'C:/ws', null);
    return id;
  },
};
const workspaces = {
  list: createSnapshotStore({ items: [{ workspaceId: 'w1', path: 'C:/ws', sessionIds: [] }], pinnedSessionIds: [], archivedSessionIds: [], phase: 'ready' }),
  archiveSession: (id) => { archived.add(id); rows[id] && (rows[id].archived = true); },
};
// 捕获插槽注册，便于直接调用插件提供的动词（重命名等）
const slotRegistrations = [];
const slotStub = {
  provideRoot: () => {},
  register: (options) => { slotRegistrations.push({ options }); return () => {}; },
  inject: (_key, cb) => {
    const out = cb();
    // 菜单项用 generator 注册，需要跑完迭代
    if (out && typeof out.next === 'function') {
      let step = out.next();
      while (!step.done) step = out.next();
    }
  },
};
function slotVerb(id, prop) {
  const reg = slotRegistrations.filter((r) => r.options && r.options.id === id).pop();
  if (reg === undefined || typeof reg.options.inject !== 'function') return undefined;
  const props = reg.options.inject(undefined);
  return props === undefined ? undefined : props[prop];
}

const ctx = {
  sessions, workspaces,
  slots: slotStub,
  locale: { register: () => () => {}, bind: () => (k) => k },
  effect: (fn) => fn(),
  on: () => () => {},
  get: (n) => (n === 'conversation' ? conversation : n === 'uiWorkspace' ? { startSession: () => {} } : undefined),
};

// ---------------- 载入插件 ----------------
const code = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8');

let lastSandbox = null;
let simFetchImpl = null;
let simProbeCalls = 0;
function loadPlugin() {
  let spec = null;
  const sandbox = {
    window: { __ModuleLoader__: { load: (s) => { spec = s; } }, addEventListener: () => {} },
    console, React, primitives, indexedDB: globalThis.indexedDB, localStorage: globalThis.localStorage,
    File: class File { constructor(bits, name, opts) { this.bits = bits; this.name = name; this.type = opts?.type || ''; this.size = bits[0]?.length || 0; } arrayBuffer() { return Promise.resolve(this.bits[0]); } },
    Blob: class Blob { constructor(bits, opts) { this.bits = bits; this.type = opts?.type || ''; this.size = bits[0]?.length || 0; } },
    setTimeout: (fn) => { fn(); return 0; },
    clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
    Symbol, Object, Array, JSON, Math, Date, Promise, Set, Map, WeakSet, String, Number, Boolean, RegExp, Error, Intl,
  };
  // fetch 是访问器：测试照旧写 `sandbox.fetch = stub`，但插件发出的「可删性探针」
  // （body 里带 expectedTotal）会被自动识别并回 409（计划不匹配＝可删），
  // 这样测试桩只需要关心真实删除请求。
  Object.defineProperty(sandbox, 'fetch', {
    configurable: true,
    get: () => async (url, init) => {
      const body = init && typeof init.body === 'string' ? JSON.parse(init.body) : {};
      if (body.expectedTotal !== undefined) {
        simProbeCalls += 1;
        return { ok: false, status: 409, json: async () => ({ error: 'plan-mismatch' }) };
      }
      if (typeof simFetchImpl !== 'function') throw new Error('sim: no archive plugin');
      const response = await simFetchImpl(url, init);
      // 测试桩沿用「第三方响应形状」{results,freedBytes}；打到我们自己的端点时补上
      // ok:true，等价于我们自己的宿主半边响应，让自家删除器直接成功。
      if (String(url).includes('dsh-pending-session/delete') && response && typeof response.json === 'function') {
        const originalJson = response.json;
        return {
          ...response,
          json: async () => {
            const parsed = await originalJson();
            if (parsed && typeof parsed === 'object' && parsed.ok === undefined && Array.isArray(parsed.results)) {
              return { ok: true, results: parsed.results, freedBytes: parsed.freedBytes };
            }
            return parsed;
          },
        };
      }
      return response;
    },
    set: (impl) => { simFetchImpl = impl; },
  });
  lastSandbox = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'client.js' });
  const plugin = spec.factory((name) => (name === 'react' ? React : name === '@deepseek-ai/dsh-client-ui-primitives' ? primitives : name === '@deepseek-ai/dsh-client-store' ? { createSnapshotStore } : undefined));
  return plugin;
}

// ---------------- 断言 ----------------
let pass = 0, fail = 0;
function assert(cond, label) {
  if (cond) { pass++; console.log('  ✓', label); }
  else { fail++; console.log('  ✗ FAIL:', label); }
}
function registryEntries() {
  const raw = localStorage.getItem('dsh.pending-session.registry.v1');
  return raw ? JSON.parse(raw).entries : {};
}
function patchedRows() {
  return sessions.list.getSnapshot().byId;
}
const tick = () => new Promise((r) => setTimeout(r, 5));

// ---- 场景 ----
console.log('== boot: apply ==');
const plugin1 = loadPlugin();
plugin1.apply(ctx);

// 初始化：一个空白新会话 B1 作为主会话
const B1 = await sessions.create({ workspaceId: 'w1' });
rows[B1].cwd = 'C:/ws';
mainId = B1;
publishList();

// 用户输入草稿文本
shellFor(B1).state.set({ draft: '待办：写周报', attachmentIds: [] });

// 派生视图：B1 仍是 blank（新会话占位），cwd 被隔离
let rowB1 = patchedRows()[B1];
assert(rowB1.blank === true && rowB1.cwd === '', '带草稿的主会话：仍是新会话占位 + cwd 隔离（防复用）');

// 模拟「新会话」按钮的 reuseOrCreateBlank：应跳过 B1（cwd 不匹配）
const reuse = Object.values(patchedRows()).find((r) => r.blank && r.cwd === 'C:/ws');
assert(reuse === undefined, '点击新会话不会复用带草稿的 B1');

// 离开 B1 → 点击另一个对话 C
const C = await sessions.create({ workspaceId: 'w1' });
rows[C].cwd = 'C:/ws';
rows[C].blank = false;
rows[C].updatedAt = Date.now() - 100000;
rows[C].title = '旧对话';
mainId = C;
publishList();

const entries1 = registryEntries();
assert(entries1[B1] !== undefined, '离开后生成待执行条目（B1）');
assert(entries1[B1]?.text === '待办：写周报', '条目记录草稿文本');
assert(entries1[B1]?.name === '待执行', '默认名称「待执行」');
const rowB1After = patchedRows()[B1];
assert(rowB1After.blank === false && rowB1After.title === '待执行', '派生视图：待执行条目可见（非 blank、标题待执行）');
assert(rowB1After.updatedAt >= entries1[B1].createdAt, '时间=创建时间');

// 回归：getSnapshot 必须返回稳定引用（React useSyncExternalStore 要求）。
// 每次新建对象会触发 "getSnapshot should be cached" 无限渲染，
// 导致侧边栏整个不显示记录。
const g1 = sessions.list.getSnapshot();
const g2 = sessions.list.getSnapshot();
assert(g1 === g2, 'getSnapshot 无变化时返回同一对象（引用稳定）');
assert(g1.byId[B1] !== undefined && g1.byId[B1].blank === false, '缓存快照仍是投影后的内容');
publishList();
const g3 = sessions.list.getSnapshot();
const g4 = sessions.list.getSnapshot();
assert(g3 === g4, '底层变更后引用重新稳定');
assert(g3.byId[B1] !== undefined, '变更后投影内容仍完整');

// 规则 6：再创建一个待执行
mainId = B1; publishList();
shellFor(B1).state.set({ draft: '另一个草稿', attachmentIds: [] });
const D = await sessions.create({ workspaceId: 'w1' });
rows[D].cwd = 'C:/ws'; rows[D].blank = true;
mainId = D; publishList();
const entries2 = registryEntries();
assert(entries2[B1] !== undefined, 'B1 条目仍存在（修改不新建）');
assert(entries2[B1].createdAt === entries1[B1].createdAt, '修改不改变创建时间');

// D 里输入草稿并离开到 C
shellFor(D).state.set({ draft: 'D 的草稿', attachmentIds: [] });
mainId = C; publishList();
const entries3 = registryEntries();
assert(entries3[D] !== undefined, '第二个待执行并存（D）');
assert(Object.keys(entries3).length === 2, '允许多个待执行并存');

// 回归：离开后连续列表变更（模拟大会话打开期间的投影/状态更新），
// 曾触发 handleMainSwitch 重入无限递归（栈溢出 + 条目被误删）
for (let i = 0; i < 25; i++) publishList();
const entriesStress = registryEntries();
assert(entriesStress[B1] !== undefined && entriesStress[D] !== undefined, '连续列表变更后两个待执行条目都存活（无递归误删）');

// 重命名：走对话框注册的真实动词，验证写入注册表 + 名称账本
const renameVerb = slotVerb('pending-rename-dialog', 'commitRename');
assert(typeof renameVerb === 'function', '重命名动词可从插槽注册取得');
await renameVerb(B1, '我的待办');
const entriesRenamed = registryEntries();
assert(entriesRenamed[B1] !== undefined && entriesRenamed[B1].name === '我的待办', '重命名写入注册表条目');
const ledgerData = JSON.parse(localStorage.getItem('dsh.pending-session.names.v1') || '{}');
assert(ledgerData[B1] !== undefined && ledgerData[B1].name === '我的待办', '重命名写入名称账本');
const rowRenamed = patchedRows()[B1];
assert(rowRenamed.title === '我的待办', '侧边栏投影标题跟随新名字');

// 宿主改名跟随：用户用 DSH 原生「重命名」改了会话标题，条目名字也应跟着变
rows[B1].title = '原生改的名';
publishList();
const entriesHostRename = registryEntries();
assert(entriesHostRename[B1] !== undefined && entriesHostRename[B1].name === '原生改的名', '宿主标题变化被采纳为条目名字');
const ledgerHost = JSON.parse(localStorage.getItem('dsh.pending-session.names.v1') || '{}');
assert(ledgerHost[B1] !== undefined && ledgerHost[B1].name === '原生改的名', '宿主改名同步写入名称账本');
rows[B1].title = undefined;

// 回归（用户实测 bug）：归档待执行条目必须保留（能在归档视图里找回并恢复），
// 旧实现会在归档时删除条目并清草稿，导致归档后彻底找不到
const wsBefore = workspaces.list.getSnapshot();
workspaces.list.set({ ...wsBefore, archivedSessionIds: [B1] });
const entriesArchived = registryEntries();
assert(entriesArchived[B1] !== undefined, '归档后条目仍在（不再被删除）');
assert(patchedRows()[B1] !== undefined && patchedRows()[B1].blank === false, '归档条目仍投影为非 blank 行（归档视图可见）');
workspaces.list.set({ ...wsBefore, archivedSessionIds: [] });
assert(registryEntries()[B1] !== undefined, '取消归档后条目仍在（恢复正常视图）');

// 执行 B1：行 blank 变 false（需连续两次列表变更确认，防瞬时翻转误删）
rows[B1].blank = false;
rows[B1].updatedAt = Date.now();
rows[B1].title = '转正后的标题';
publishList();
publishList();
const entries4 = registryEntries();
assert(entries4[B1] === undefined, '执行后条目移除（转正）');
assert(patchedRows()[B1].blank === false && patchedRows()[B1].title === '转正后的标题', '转正后是普通对话行');
assert(patchedRows()[B1].updatedAt === rows[B1].updatedAt, '转正后按发送时间排序');

// 回归：engaged 泄漏（客户端 blank 假翻转、无真实消息）不得删除条目——用新会话 E
const E = await sessions.create({ workspaceId: 'w1' });
rows[E].cwd = 'C:/ws'; rows[E].blank = true; rows[E].updatedAt = Date.now();
mainId = E; publishList();
shellFor(E).state.set({ draft: 'E 的草稿', attachmentIds: [] });
mainId = C; publishList();
assert(registryEntries()[E] !== undefined, 'E 生成待执行条目');
// 假翻转：blank 翻 false 但 updatedAt 不变（无事件产生）
rows[E].blank = false;
publishList();
publishList();
publishList();
const entriesLeak = registryEntries();
assert(entriesLeak[E] !== undefined, 'engaged 泄漏（假翻转无消息）不删除条目');
// 真实发送：updatedAt 前移 → 转正删除
rows[E].updatedAt = Date.now() + 5000;
rows[E].title = 'E 转正';
publishList();
publishList();
const entriesReal = registryEntries();
assert(entriesReal[E] === undefined, '真实发送（活动时间前移）后条目转正删除');

// 规则 10：清空 D 草稿后离开 → 自动删除
mainId = D; publishList();
shellFor(D).state.set({ draft: '', attachmentIds: [] });
mainId = C; publishList();
const entries5 = registryEntries();
assert(entries5[D] === undefined, '清空草稿离开后条目自动删除');
await tick();
assert(archived.has(D), '自动删除 = 等同手动删除（归档）');

// 再次创建并验证条目可重建
mainId = D; publishList();
rows[D].blank = true; rows[D].updatedAt = Date.now();
shellFor(D).state.set({ draft: '改名草稿', attachmentIds: [] });
mainId = C; publishList();
const entries6 = registryEntries();
assert(entries6[D] !== undefined, '再次创建条目（D）');

console.log('== 重启模拟（规则 7/8）==');
// 模拟退出时的活动草稿
localStorage.setItem('dsh.pending-session.active.v1', JSON.stringify({ sessionId: D, savedAt: Date.now() - 5000, text: '退出时的草稿', manifest: [] }));
// 清空 registry，重新 apply（新插件实例）
localStorage.setItem('dsh.pending-session.registry.v1', JSON.stringify({ entries: {} }));
rows[D].blank = true;
sessions.list = createSnapshotStore({ ids: [], byId: {}, phase: 'pending', projectionsBySession: {} });
mainId = D;
publishList();
const plugin2 = loadPlugin();
plugin2.apply(ctx);
const entries7 = registryEntries();
assert(entries7[D] !== undefined, '重启后：退出时的活动草稿显示为待执行（规则 8）');
assert(entries7[D].text === '退出时的草稿', '重启后：草稿文本仍在（规则 7）');

// 孤儿收养：未登记的空白会话带原生草稿（如插件更新前/崩溃遗留）→ 自动转待执行
const X = await sessions.create({ workspaceId: 'w1' });
rows[X].cwd = 'C:/ws';
rows[X].blank = true;
rows[X].updatedAt = Date.now();
localStorage.setItem('dsh.conversation.' + X, JSON.stringify({ draft: '孤儿草稿', view: null, viewRequest: null }));
mainId = C;
publishList();
const entries8 = registryEntries();
assert(entries8[X] !== undefined, '孤儿空白会话（带原生草稿）自动登记为待执行');
assert(entries8[X].text === '孤儿草稿', '收养的条目保留草稿文本');

// 所有权令牌：陈旧实例（令牌失效）的写盘必须被屏蔽，不得覆盖/污染磁盘注册表
const ownerBefore = localStorage.getItem('dsh.pending-session.owner.v1');
const Y = await sessions.create({ workspaceId: 'w1' });
rows[Y].cwd = 'C:/ws';
rows[Y].blank = true;
rows[Y].updatedAt = Date.now();
localStorage.setItem('dsh.conversation.' + Y, JSON.stringify({ draft: 'Y的草稿', view: null, viewRequest: null }));
localStorage.setItem('dsh.pending-session.owner.v1', 'stale-fake-token');
publishList(); // 触发收养尝试；saveRegistry 应被 owned() 屏蔽
const diskDuringStale = JSON.parse(localStorage.getItem('dsh.pending-session.registry.v1'));
assert(diskDuringStale.entries[X] !== undefined, '陈旧实例写盘被屏蔽：既有条目未被覆盖');
assert(diskDuringStale.entries[Y] === undefined, '陈旧实例写盘被屏蔽：其收养结果未落盘');
localStorage.setItem('dsh.pending-session.owner.v1', ownerBefore);
// 恢复所有权后：正常离开路径可以落盘（离开 Y → C 生成条目）
mainId = Y; publishList();
shellFor(Y).state.set({ draft: 'Y的草稿', attachmentIds: [] });
mainId = C; publishList();
const diskAfterRestore = JSON.parse(localStorage.getItem('dsh.pending-session.registry.v1'));
assert(diskAfterRestore.entries[Y] !== undefined, '恢复所有权后离开路径正常落盘');

// 回归（用户实测 bug）：注册表被清空后重新收养，名字必须从账本恢复，
// 不能退回默认「待执行」
localStorage.setItem('dsh.pending-session.names.v1', JSON.stringify({ [Y]: { name: '我的自定义名', createdAt: Date.now() - 5000 } }));
localStorage.setItem('dsh.pending-session.registry.v1', JSON.stringify({ entries: {} }));
localStorage.setItem('dsh.conversation.' + Y, JSON.stringify({ draft: 'Y的草稿', view: null, viewRequest: null }));
rows[Y].blank = true;
sessions.list = createSnapshotStore({ ids: [], byId: {}, phase: 'pending', projectionsBySession: {} });
mainId = C;
publishList();
const plugin4 = loadPlugin();
plugin4.apply(ctx);
const entriesLedger = registryEntries();
assert(entriesLedger[Y] !== undefined, '清空后重新收养成功');
assert(entriesLedger[Y] !== undefined && entriesLedger[Y].name === '我的自定义名', '收养时从名称账本恢复自定义名字');
assert(patchedRows()[Y] !== undefined && patchedRows()[Y].title === '我的自定义名', '侧边栏显示恢复后的自定义名字');

// 删除待执行 → 先弹确认框，确认后走「会话归档管理」插件的物理删除接口
const deleteVerb = slotVerb('pending-banner', 'deletePending');
const commitDelete = slotVerb('delete-session-dialog', 'commitDelete');
assert(typeof deleteVerb === 'function', '删除按钮动词可从插槽注册取得');
assert(typeof commitDelete === 'function', '删除确认动词可从插槽注册取得');
const Z = await sessions.create({ workspaceId: 'w1' });
rows[Z].cwd = 'C:/ws'; rows[Z].blank = true; rows[Z].updatedAt = Date.now();
mainId = Z; publishList();
shellFor(Z).state.set({ draft: '要删掉的草稿', attachmentIds: [] });
mainId = C; publishList();
assert(registryEntries()[Z] !== undefined, 'Z 生成待执行条目');
const deleteCalls = [];
lastSandbox.fetch = async (url, init) => {
  deleteCalls.push({ url, init });
  return { ok: true, status: 200, json: async () => ({ results: [{ id: Z, status: 'ok' }], freedBytes: 42 }) };
};
deleteVerb(Z, '要删掉的草稿');
assert(registryEntries()[Z] !== undefined, '点删除只弹确认框，确认前不删');
assert(deleteCalls.length === 0, '确认前不发删除请求');
await commitDelete(Z);
await new Promise((r) => setTimeout(r, 30));
assert(registryEntries()[Z] === undefined, '删除后条目移除');
assert(deleteCalls.length === 1, '删除只发一次请求');
assert(String(deleteCalls[0].url).includes('dsh-pending-session/delete'), '删除走我们自己的删除端点（不看第三方保护判定）');
assert(JSON.parse(deleteCalls[0].init.body).ids[0] === Z, '请求体携带正确的会话 id');
assert(archived.has(Z) !== true, '物理删除成功时不退回归档');

// 接口不可用（未安装/异常）→ 退回 DSH 原生归档，删除语义不落空
const W = await sessions.create({ workspaceId: 'w1' });
rows[W].cwd = 'C:/ws'; rows[W].blank = true; rows[W].updatedAt = Date.now();
mainId = W; publishList();
shellFor(W).state.set({ draft: '回退草稿', attachmentIds: [] });
mainId = C; publishList();
assert(registryEntries()[W] !== undefined, 'W 生成待执行条目');
lastSandbox.fetch = async () => { throw new Error('sim: endpoint missing'); };
deleteVerb(W, '回退草稿');
await commitDelete(W);
await new Promise((r) => setTimeout(r, 30));
assert(registryEntries()[W] === undefined, '回退路径同样移除条目');
assert(archived.has(W) === true, '物理删除不可用时退回原生归档');

// 普通会话（没有待执行条目）也能通过同一条路径删除
const V = await sessions.create({ workspaceId: 'w1' });
rows[V].cwd = 'C:/ws'; rows[V].blank = false; rows[V].updatedAt = Date.now();
const deleteCalls2 = [];
lastSandbox.fetch = async (url, init) => {
  deleteCalls2.push({ url, init });
  return { ok: true, status: 200, json: async () => ({ results: [{ id: V, status: 'ok' }], freedBytes: 7 }) };
};
await commitDelete(V);
await new Promise((r) => setTimeout(r, 30));
assert(deleteCalls2.length === 1 && JSON.parse(deleteCalls2[0].init.body).ids[0] === V, '普通会话也能通过同一路径删除');
assert(registryEntries()[V] === undefined, '删除普通会话不影响待执行注册表');

// 受保护会话（运行中/被占用）：宿主跳过删除 → 条目必须保留，不能「条目没了会话还在」
const U = await sessions.create({ workspaceId: 'w1' });
rows[U].cwd = 'C:/ws'; rows[U].blank = true; rows[U].updatedAt = Date.now();
mainId = U; publishList();
shellFor(U).state.set({ draft: '运行中的草稿', attachmentIds: [] });
mainId = C; publishList();
assert(registryEntries()[U] !== undefined, 'U 生成待执行条目');
lastSandbox.fetch = async () => ({
  ok: true, status: 200,
  json: async () => ({ results: [{ id: U, status: 'skipped', reason: 'running' }], freedBytes: 0 }),
});
await commitDelete(U);
await new Promise((r) => setTimeout(r, 30));
assert(registryEntries()[U] !== undefined, '宿主跳过删除时条目保留（不会出现会话还在但条目消失）');
const outcomeU = await commitDelete(U);
assert(outcomeU !== undefined && outcomeU.deleted === false, '被拒绝时把原因交回确认框（不再静默失败）');

// not-found：磁盘上没有该会话的存储（只有草稿、从未落盘的空白会话就是这种）
// → 视为「已无可删数据」并清理条目，否则用户点了删除会毫无反应
const T = await sessions.create({ workspaceId: 'w1' });
rows[T].cwd = 'C:/ws'; rows[T].blank = true; rows[T].updatedAt = Date.now();
mainId = T; publishList();
shellFor(T).state.set({ draft: '只有草稿没落盘', attachmentIds: [] });
mainId = C; publishList();
assert(registryEntries()[T] !== undefined, 'T 生成待执行条目');
lastSandbox.fetch = async () => ({
  ok: true, status: 200,
  json: async () => ({ results: [{ id: T, status: 'skipped', reason: 'not-found' }], freedBytes: 0 }),
});
const outcomeT = await commitDelete(T);
await new Promise((r) => setTimeout(r, 30));
assert(outcomeT !== undefined && outcomeT.deleted === true, 'not-found 视为删除成功（磁盘本就没有存储）');
assert(registryEntries()[T] === undefined, 'not-found 后条目被清理');

// attached：宿主仍持有 → 自动等待重试，第二次成功
const S = await sessions.create({ workspaceId: 'w1' });
rows[S].cwd = 'C:/ws'; rows[S].blank = true; rows[S].updatedAt = Date.now();
mainId = S; publishList();
shellFor(S).state.set({ draft: '等待释放的草稿', attachmentIds: [] });
mainId = C; publishList();
assert(registryEntries()[S] !== undefined, 'S 生成待执行条目');
let attachedCalls = 0;
lastSandbox.fetch = async () => {
  attachedCalls += 1;
  return attachedCalls === 1
    ? { ok: true, status: 200, json: async () => ({ results: [{ id: S, status: 'skipped', reason: 'attached' }], freedBytes: 0 }) }
    : { ok: true, status: 200, json: async () => ({ results: [{ id: S, status: 'ok' }], freedBytes: 5 }) };
};
const outcomeS = await commitDelete(S);
await new Promise((r) => setTimeout(r, 30));
assert(attachedCalls === 1, '自家删除器对宿主拒绝不做无谓重试');
assert(outcomeS !== undefined && outcomeS.deleted === false, '被宿主拒绝时如实返回失败（不谎报成功）');
assert(registryEntries()[S] !== undefined, '被拒时条目保留（不会出现会话还在但条目消失）');

// 本地引用未归零（如主会话的 mainView 持有）：先等它归零再删，而不是硬删被拒
const R = await sessions.create({ workspaceId: 'w1' });
rows[R].cwd = 'C:/ws'; rows[R].blank = true; rows[R].updatedAt = Date.now();
mainId = R; publishList();
shellFor(R).state.set({ draft: '被持有的草稿', attachmentIds: [] });
mainId = C; publishList();
assert(registryEntries()[R] !== undefined, 'R 生成待执行条目');
simRetain.counts.set(R, 3); // 模拟仍被本地持有
simRetain.reads = 0;
let deleteCallsR = 0;
lastSandbox.fetch = async () => {
  deleteCallsR += 1;
  return { ok: true, status: 200, json: async () => ({ results: [{ id: R, status: 'ok' }], freedBytes: 3 }) };
};
const outcomeR = await commitDelete(R);
await new Promise((r) => setTimeout(r, 30));
assert(simRetain.reads >= 2, '删除前会轮询本地引用计数');
assert(outcomeR !== undefined && outcomeR.deleted === true, '引用归零后删除成功');
assert(deleteCallsR === 1 && registryEntries()[R] === undefined, '只删一次并清理条目');

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
