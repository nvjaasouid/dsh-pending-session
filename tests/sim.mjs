// dsh-pending-session 无头模拟测试：桩掉浏览器环境与 DSH 服务，跑通核心状态机。
import fs from 'node:fs';
import vm from 'node:vm';
// 宿主半边（index.js）的删除端点用例：假 DSH_HOME + 假 webServer 注册，绝不用真实 .dsh
import { runHostTests } from './host-delete.mjs';

// ---------------- 存储桩 ----------------
const localStorageData = new Map();
globalThis.localStorage = {
  getItem: (k) => (localStorageData.has(k) ? localStorageData.get(k) : null),
  setItem: (k, v) => localStorageData.set(k, String(v)),
  removeItem: (k) => localStorageData.delete(k),
};

const idbData = new Map();
// 故障开关：验证「IndexedDB 出错时必须告警，不能静默吞掉」的路径
const idbFault = { put: false, delete: false };
// 请求桩：赋上 onsuccess/oncomplete 之后异步触发一次（真实 IndexedDB 就是这样回调的）。
// 纯同步桩会让插件里 promise 的 settle 时机和真实环境不一致，恢复/回收路径测不出来。
function makeIdbRequest(result) {
  let onSuccess = null;
  const req = { result, onerror: null, onupgradeneeded: null };
  Object.defineProperty(req, 'onsuccess', {
    configurable: true,
    get: () => onSuccess,
    set: (fn) => { onSuccess = fn; queueMicrotask(() => { try { onSuccess?.(); } catch (_e) { /* ignore */ } }); },
  });
  return req;
}
globalThis.indexedDB = {
  open() {
    const req = {
      result: {
        objectStoreNames: { contains: () => true },
        createObjectStore: () => {},
        transaction: () => {
          let faulted = false;
          const tx = {
            objectStore: () => ({
              put: (v, k) => { if (idbFault.put) { faulted = true; return; } idbData.set(k, v); },
              get: (k) => makeIdbRequest(idbData.get(k)),
              delete: (k) => { if (idbFault.delete) { faulted = true; return; } idbData.delete(k); },
            }),
            oncomplete: null,
            onerror: null,
            error: new Error('sim: indexeddb fault'),
          };
          // 写事务：赋上 oncomplete 后异步完成（有故障开关时改走 onerror）
          Object.defineProperty(tx, 'oncomplete', {
            configurable: true,
            get: () => tx.__done,
            set: (fn) => {
              tx.__done = fn;
              queueMicrotask(() => { try { if (faulted) tx.onerror?.(); else fn?.(); } catch (_e) { /* ignore */ } });
            },
          });
          return tx;
        },
      },
      onupgradeneeded: null,
      onsuccess: null,
      onerror: null,
    };
    Object.defineProperty(req, 'onsuccess', {
      configurable: true,
      get: () => req.__ok,
      set: (fn) => { req.__ok = fn; queueMicrotask(() => { try { fn?.(); } catch (_e) { /* ignore */ } }); },
    });
    return req;
  },
};

// ---------------- 可控假时钟 ----------------
// 插件里所有等待（防抖落盘、删除前等宿主释放 / 等新主会话就位）都走 setTimeout。
// 旧的同步桩（`fn()` 立刻执行、ms 直接丢掉）会让「等了几轮」「等够窗口才放弃」
// 这些分支根本测不出来，也把「异步 RPC 晚一步完成」的真实时序掩盖掉了。
// 这里换成按到期时间排序的假时钟：虚拟毫秒照走量、回调按到期顺序执行，
// 于是「startSession 过 1.2s 才切走」这类情形可以被确定性地覆盖。
// 注意：虚拟时间只决定定时器的执行顺序，Date.now() 仍是真实时钟（插件里的
// 时间戳与超时判定照旧用真表），避免测试里两套时间互相打架。
const clock = {
  now: 0,
  seq: 0,
  pending: new Map(),
  setTimeout(fn, ms) {
    const id = ++clock.seq;
    clock.pending.set(id, { id, at: clock.now + (Number(ms) || 0), fn });
    queueMicrotask(() => clock.__drain());
    return id;
  },
  clearTimeout(id) { clock.pending.delete(id); },
  /** 反复取出「最早到期」的定时器、把虚拟时间推到它的到期点再执行。 */
  __drain() {
    for (let guard = 0; guard < 10000; guard += 1) {
      let next = null;
      for (const timer of clock.pending.values()) {
        if (next === null || timer.at < next.at || (timer.at === next.at && timer.id < next.id)) next = timer;
      }
      if (next === null) return;
      clock.pending.delete(next.id);
      clock.now = Math.max(clock.now, next.at);
      try { next.fn(); } catch (_e) { /* 插件自己会记日志 */ }
    }
  },
};
/** 测试侧：把动作安排到假时钟上（例如「1.2s 之后主会话才切走」）。 */
function later(ms, fn) { return clock.setTimeout(fn, ms); }

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
// 所有 stub store 都登记在册：模拟「页面重启」时统一清空监听者，
// 等价于旧页面连同它的订阅一起消失（否则旧实例会继续参与状态机）。
const simStores = [];
function createSnapshotStore(init) {
  let state = init;
  const listeners = new Set();
  const store = {
    getSnapshot: () => state,
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    set: (next) => { state = next; for (const fn of [...listeners]) fn(); },
    update: () => {},
  };
  store.__dropListeners = () => listeners.clear();
  simStores.push(store);
  return store;
}
function dropAllListeners() {
  for (const store of simStores) store.__dropListeners();
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
// 通知嵌套深度：1 = 测试自己 publishList，2 = 插件在 handleMainSwitch 内部
// recomputeDerived 触发的那一层（补跑用例要精确地打在这一层上）
let notifyDepth = 0;
let rawListSet = null;
function instrumentListSet() {
  if (rawListSet !== null) return;
  rawListSet = sessions.list.set;
  sessions.list.set = (next) => {
    notifyDepth += 1;
    try { rawListSet(next); } finally { notifyDepth -= 1; }
  };
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
// 宿主会话元数据投影桩：插件用 hostBlank(id) 作为「是不是空白会话」的权威信号
// （客户端列表行的 blank 会被 engaged 泄漏污染）。只有宿主真正物化（出现过事件流）
// 过的会话才有这个投影，其余返回 undefined —— 插件据此退回「列表行 + 时间前移」的判据。
const hostMaterialized = new Set();
const bindingStubFor = (id) => ({
  session: {
    projections: {
      faceOf: (key) => (key !== 'sessionListMetadata' || !hostMaterialized.has(id) ? undefined : {
        getSnapshot: () => (rows[id] === undefined ? undefined : { blank: rows[id].blank === true }),
      }),
    },
  },
});
// 模拟客户端本地引用计数：counts 里的条数每读一次递减（模拟切走后被释放）
const simRetain = { counts: new Map(), reads: 0 };
const sessions = {
  list: createSnapshotStore({ ids: [], byId: {}, phase: 'pending', projectionsBySession: {} }),
  scope: (id) => (rows[id] ? scopedCtxFor(id) : undefined),
  binding: (id) => bindingStubFor(id),
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
  register: (options, component) => { slotRegistrations.push({ options, component }); return () => {}; },
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
/** 取某个插槽注册的组件 + 它的注入 props（M7 横幅渲染断言用）。 */
function slotComponent(id) {
  const reg = slotRegistrations.filter((r) => r.options && r.options.id === id).pop();
  return reg === undefined ? undefined : { component: reg.component, props: reg.options.inject(undefined) };
}

// 捕获插件写出的 console.warn（M4：静默失效必须首次告警，且不刷屏），其余照旧转发
const simWarns = [];
const simConsole = {
  log: (...a) => console.log(...a),
  info: (...a) => console.info(...a),
  debug: (...a) => console.debug(...a),
  error: (...a) => console.error(...a),
  warn: (...a) => { simWarns.push(a); },
};
// 捕获 locale.register 的词典（M1：新的原因码文案）
let simDict = { zh: {}, en: {} };
// 捕获 ctx.effect 的清理函数（M5：dispose 后的行为）
const simEffects = [];

const ctx = {
  sessions, workspaces,
  slots: slotStub,
  locale: { register: (_ns, dict) => { simDict = dict; return () => {}; }, bind: () => (k) => k },
  effect: (fn) => {
    const dispose = fn();
    if (typeof dispose === 'function') simEffects.push(dispose);
    return dispose;
  },
  on: () => () => {},
  get: (n) => (n === 'conversation' ? conversation : n === 'uiWorkspace' ? { startSession: () => {} } : undefined),
};

// ---------------- 载入插件 ----------------
// 真实 bundle 里 APPLIED / idbPromise 都是模块级状态：同一页面重复 apply 必须短路
// （HMR 重挂载），且 IndexedDB 连接复用。但测试要模拟「进程重启」，得让新实例真的
// 从头跑起来 —— 通过插件自带的测试钩子 __dpsResetRuntime 复位，只影响测试沙箱。
const code = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8');
// 告警里必须能对上当前 BUILD：从源码里直接抽，省得每次升版都手动改断言（漏了就假绿）
const BUILD = (code.match(/var BUILD = "([^"]+)"/) || [])[1];

let lastSandbox = null;
let simFetchImpl = null;
function loadPlugin(globals) {
  let spec = null;
  const sandbox = {
    window: { __ModuleLoader__: { load: (s) => { spec = s; } }, addEventListener: () => {} },
    console: simConsole, React, primitives, indexedDB: globalThis.indexedDB, localStorage: globalThis.localStorage,
    // 默认沙箱没有 DOM（显式写出来，免得将来 Node 全局加了个 document 让样式路径悄悄变样）
    document: undefined,
    File: class File { constructor(bits, name, opts) { this.bits = bits; this.name = name; this.type = opts?.type || ''; this.size = bits[0]?.length || 0; } arrayBuffer() { return Promise.resolve(this.bits[0] ?? new Uint8Array(0)); } },
    Blob: class Blob { constructor(bits, opts) { this.bits = bits; this.type = opts?.type || ''; this.size = bits[0]?.length || 0; } },
    setTimeout: (fn, ms) => clock.setTimeout(fn, ms),
    clearTimeout: (id) => clock.clearTimeout(id), setInterval: () => 0, clearInterval: () => {},
    Symbol, Object, Array, JSON, Math, Date, Promise, Set, Map, WeakSet, String, Number, Boolean, RegExp, Error, Intl,
  };
  // fetch 是访问器：测试照旧写 `sandbox.fetch = stub`。打到我们自己的端点时补上
  // ok:true，等价于我们自己的宿主半边响应，让自家删除器直接成功。
  Object.defineProperty(sandbox, 'fetch', {
    configurable: true,
    get: () => async (url, init) => {
      if (typeof simFetchImpl !== 'function') throw new Error('sim: no delete endpoint');
      const response = await simFetchImpl(url, init);
      // 测试桩沿用自己的响应形状 {results,freedBytes}；打到我们自己的端点时补上 ok:true
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
  // 可选注入的沙箱全局（例如 document）：必须在 vm.createContext 之前落进去
  if (globals !== undefined) Object.assign(sandbox, globals);
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'client.js' });
  const plugin = spec.factory((name) => {
    if (name === 'react') return React;
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitives;
    // F1 之后插件不再 require 基座外的模块：一旦有人加回来，这条会当场炸出来
    // （官方规范：基座外的请求必须写进 dsh.client.external，否则某些版本直接抛
    //  "missed the module table"，整个插件静默失效）
    throw new Error(`sim: 插件 require 了基座外的模块 ${name}（应就地实现或写进 dsh.client.external）`);
  });
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
/** journal 的原始文本：M-c 断言「整条序列化后不含用户内容」用。 */
function journalText() {
  return localStorage.getItem('dsh.pending-session.journal.v1') || '[]';
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
const renameVerb = slotVerb('dps.pending-rename-dialog', 'commitRename');
assert(typeof renameVerb === 'function', '重命名动词可从插槽注册取得');
await renameVerb(B1, '我的待办');
const entriesRenamed = registryEntries();
assert(entriesRenamed[B1] !== undefined && entriesRenamed[B1].name === '我的待办', '重命名写入注册表条目');
const ledgerData = JSON.parse(localStorage.getItem('dsh.pending-session.names.v1') || '{}');
assert(ledgerData[B1] !== undefined && ledgerData[B1].name === '我的待办', '重命名写入名称账本');
const rowRenamed = patchedRows()[B1];
assert(rowRenamed.title === '我的待办', '侧边栏投影标题跟随新名字');
// M-c：journal 是取证日志、长期留在 localStorage —— 会话名（用户内容）一个字都不许写进去。
// 断言要针对「整条 journal 序列化后的文本」，只查草稿正文太窄（旧版本正是从 rename/adopt
// 的 name 字段把名字写进去的）。
assert(journalText().indexOf('我的待办') === -1, 'M-c：改名后整条 journal 序列化不含该名字');
assert(JSON.parse(localStorage.getItem('dsh.pending-session.journal.v1') || '[]').some((e) => e.op === 'rename' && typeof e.nameLen === 'number'), 'M-c：journal 里只记名字长度（够排障、不含内容）');

// 宿主改名跟随：用户用 DSH 原生「重命名」改了会话标题，条目名字也应跟着变
rows[B1].title = '原生改的名';
publishList();
const entriesHostRename = registryEntries();
assert(entriesHostRename[B1] !== undefined && entriesHostRename[B1].name === '原生改的名', '宿主标题变化被采纳为条目名字');
const ledgerHost = JSON.parse(localStorage.getItem('dsh.pending-session.names.v1') || '{}');
assert(ledgerHost[B1] !== undefined && ledgerHost[B1].name === '原生改的名', '宿主改名同步写入名称账本');
assert(journalText().indexOf('原生改的名') === -1, 'M-c：宿主改名路径也不把名字写进 journal');
rows[B1].title = undefined;

// 回归（用户实测 bug）：归档待执行条目必须保留（能在归档视图里找回并恢复），
// 旧实现会在归档时删除条目并清草稿，导致归档后彻底找不到
const wsBefore = workspaces.list.getSnapshot();
workspaces.list.set({ ...wsBefore, archivedSessionIds: [B1] });
const entriesArchived = registryEntries();
assert(entriesArchived[B1] !== undefined, '归档后条目仍在（不再被删除）');
assert(patchedRows()[B1] !== undefined && patchedRows()[B1].blank === false, '归档条目仍投影为非 blank 行（归档视图可见）');
// m3：归档可见的 journal 只在首次记录 —— 订阅会被工作区列表的任意变化触发，
// 每次触发都记一条会把 journal 刷屏（300 条上限很快被同一件事挤满）
workspaces.list.set({ ...workspaces.list.getSnapshot(), archivedSessionIds: [B1] });
workspaces.list.set({ ...workspaces.list.getSnapshot(), archivedSessionIds: [B1] });
const archLogs = JSON.parse(localStorage.getItem('dsh.pending-session.journal.v1') || '[]')
  .filter((e) => e.op === 'archived-visible' && e.id === B1);
assert(archLogs.length === 1, '归档可见的 journal 只记首次（重复触发不刷屏）');
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

// m4：两个「连续两次确认」的计数器不再互相污染 ——
// 旧实现共用一个 Map，一次「行消失」+ 一次「疑似已执行」就凑够 2 次，条目被误删
const P = await sessions.create({ workspaceId: 'w1' });
rows[P].cwd = 'C:/ws'; rows[P].blank = true; rows[P].updatedAt = Date.now();
mainId = P; publishList();
shellFor(P).state.set({ draft: 'P 的草稿', attachmentIds: [] });
mainId = C; publishList();
assert(registryEntries()[P] !== undefined, 'P 生成待执行条目');
const pRow = rows[P];
delete rows[P];
publishList(); // 「行消失」1 次
// 行回来且像是「已执行」（无宿主投影判据时看行 blank + 时间前移）；
// 标题留空，避免触发 adoptHostTitle 的改名路径再重算一次（那是另一条链）
rows[P] = makeRow(P, false, Date.now() + 100000, 'C:/ws', null);
publishList(); // 「疑似已执行」1 次
assert(registryEntries()[P] !== undefined, '行消失 1 次 + 已执行 1 次不凑成确认（计数器分离）');
// 真实连续两次才会删：行再消失一次
delete rows[P];
publishList();
publishList();
assert(registryEntries()[P] === undefined, '两次连续「行消失」才确认删除（语义不变）');
rows[P] = pRow;

// m1：写原生 conversation 键时只覆盖 draft，保留原有 view/viewRequest
const Q1 = await sessions.create({ workspaceId: 'w1' });
rows[Q1].cwd = 'C:/ws'; rows[Q1].blank = true; rows[Q1].updatedAt = Date.now();
mainId = Q1; publishList();
localStorage.setItem('dsh.conversation.' + Q1, JSON.stringify({ draft: '旧的', view: 'messages', viewRequest: { tab: 'x' } }));
shellFor(Q1).state.set({ draft: 'm1 的草稿', attachmentIds: [] });
mainId = C; publishList();
const q1Stored = JSON.parse(localStorage.getItem('dsh.conversation.' + Q1) || 'null');
assert(q1Stored !== null && q1Stored.draft === 'm1 的草稿', 'm1：原生草稿键里的文本被更新');
assert(q1Stored !== null && q1Stored.view === 'messages' && q1Stored.viewRequest?.tab === 'x', 'm1：原有 view/viewRequest 被保留（不被清成 null）');
// 键损坏时退回完整结构，不能把写入整条丢掉
localStorage.setItem('dsh.conversation.' + Q1, '{不是 JSON');
mainId = Q1; publishList();
shellFor(Q1).state.set({ draft: '第二次草稿', attachmentIds: [] });
mainId = C; publishList();
const q1Broken = JSON.parse(localStorage.getItem('dsh.conversation.' + Q1) || 'null');
assert(q1Broken !== null && q1Broken.draft === '第二次草稿', 'm1：键解析失败时退回 {draft,view,viewRequest} 结构写入');

// M2：重入窗口里发生的主会话切换必须补跑一次（那次离开的草稿不能丢）
const M2 = await sessions.create({ workspaceId: 'w1' });
rows[M2].cwd = 'C:/ws'; rows[M2].blank = true; rows[M2].updatedAt = Date.now();
const M2TARGET = await sessions.create({ workspaceId: 'w1' });
rows[M2TARGET].cwd = 'C:/ws'; rows[M2TARGET].blank = false; rows[M2TARGET].updatedAt = Date.now();
rows[M2TARGET].title = 'M2 目标会话';
mainId = C; publishList(); // 先让插件的主会话跟踪稳定在 C
shellFor(M2).state.set({ draft: 'M2 的草稿', attachmentIds: [] });
let m2Armed = true;
const m2Listener = () => {
  if (!m2Armed) return;
  m2Armed = false;
  // 切换处理过程中（投影重算触发的通知里）主会话又变了：
  // 这次切换正落在 handleMainSwitch 的重入窗口里
  mainId = M2TARGET;
  publishList();
};
sessions.list.subscribe(m2Listener);
mainId = M2;
publishList();
assert(m2Armed === false, 'M2：切换过程中确实发生了重入（测试前提成立）');
const m2Entries = registryEntries();
assert(m2Entries[M2] !== undefined, 'M2：重入窗口里的切换被补跑（离开的草稿登记为待执行）');
assert(m2Entries[M2]?.text === 'M2 的草稿', 'M2：补跑用的是真实的前一个主会话');
mainId = C; publishList();

// 轻微：补跑超限（SWITCH_CATCHUP_MAX=4）时不能把 pendingSwitchTo 直接丢掉就完事 ——
// handledMain 必须强制对齐 lastMain。这里让「切换处理过程中触发的通知里再切一次」，
// 把补跑次数顶到上限：notifyDepth === 2 正好是 handleMainSwitch 内部 recomputeDerived
// 触发的那一层通知（深度 1 是测试自己的 publishList，深度 3 是补切本身）。
const spinTargets = [];
for (let i = 0; i < 8; i += 1) {
  const id = 'spin-session-' + i;
  rows[id] = makeRow(id, true, Date.now(), 'C:/ws', null);
  spinTargets.push(id);
}
const spinDraft = 'spin 最后的草稿';
let spinIndex = 0;
let spinDone = false;
instrumentListSet(); // 打开通知深度计数（补跑用例要精确打在「切换处理中」那一层）
const spinListener = () => {
  if (spinDone || notifyDepth !== 2) return;
  while (spinIndex < spinTargets.length && spinTargets[spinIndex] === mainId) spinIndex += 1;
  if (spinIndex >= spinTargets.length) { spinDone = true; return; }
  const next = spinTargets[spinIndex];
  spinIndex += 1;
  mainId = next;
  publishList();
};
sessions.list.subscribe(spinListener);
mainId = C; publishList();
mainId = spinTargets[0]; publishList(); // 从这里开始，每次补跑都触发一次新的切换
spinDone = true;
sessions.list.set = rawListSet;
const spinLogs = JSON.parse(localStorage.getItem('dsh.pending-session.journal.v1') || '[]');
assert(spinLogs.some((e) => e.op === 'switch-catchup-drop'), '补跑超限时记一条 journal（可见，不静默）');
assert(simWarns.some((args) => String(args[0]).includes(' switchCatchup: ')), '补跑超限时首次告警一次');
// 对齐是否真的生效：超限之后在「插件当前认定的主会话」里打草稿再离开，条目必须登记出来。
// 若 handledMain 停在中间值，from 会算到别的会话上 → 这次离开的草稿直接丢了。
const spinCurrent = mainId;
shellFor(spinCurrent).state.set({ draft: spinDraft, attachmentIds: [] });
mainId = C; publishList();
assert(registryEntries()[spinCurrent] !== undefined, '补跑超限后 handledMain 已对齐 lastMain（下一次切换的 from 不错位）');
assert(registryEntries()[spinCurrent]?.text === spinDraft, '对齐后离开判定落在正确的会话上（草稿没丢）');

console.log('== 重启模拟（规则 7/8）==');
// 模拟退出时的活动草稿：退出时活动的是一个空白新会话 K（还没有待执行条目）。
// 不能用 C 之类的普通会话：C 是非空白会话，新语义下必须被拒绝登记（见下面 P0-③ 用例）。
const K = 'restart-blank-session';
rows[K] = makeRow(K, true, Date.now(), 'C:/ws', null);
mainId = K;
publishList();
const entriesBeforeRestart = registryEntries();
localStorage.setItem('dsh.pending-session.active.v1', JSON.stringify({ sessionId: K, savedAt: Date.now() - 5000, text: '退出时的草稿', manifest: [] }));
// 清空 registry，重新 apply（新插件实例）
localStorage.setItem('dsh.pending-session.registry.v1', JSON.stringify({ entries: {} }));
// 新实例启动：宿主尚未物化任何会话（投影未就绪）。
// 真实重启顺序是「页面新建 store → 插件挂载 → 宿主列表回填并派发」，
// 所以 store 必须先在 apply 之前建好，否则新实例会绑到一个立刻被替换掉的旧 store。
// 而 active 里的退出草稿也要等列表就绪、确认它确实是空白会话后才能登记（P0-③）。
hostMaterialized.clear();
localStorage.setItem('dsh.pending-session.owner.v1', 'restart-fake-token'); // 旧实例已不在（重启）
dropAllListeners(); // 旧页面连同它的订阅一起消失
sessions.list = createSnapshotStore({ ids: [], byId: {}, phase: 'pending', projectionsBySession: {} });
const plugin2 = loadPlugin();
plugin2.__dpsResetRuntime(); // 模拟新进程：模块级状态（APPLIED / idbPromise）复位
plugin2.apply(ctx);
mainId = K;
publishList();
const entries7 = registryEntries();
assert(entriesBeforeRestart[K] === undefined, '重启前 K 还没有待执行条目');
assert(entries7[K] !== undefined, '重启后：退出时的活动草稿显示为待执行（规则 8）');
assert(entries7[K].text === '退出时的草稿', '重启后：草稿文本仍在（规则 7）');
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
// M-c：历史版本把会话名（用户内容）写进了 journal 的 rename/adopt 记录。新实例载入
// journal 时必须把旧记录里的名字剥掉（只留长度），否则名字会永久留在 localStorage 里。
const legacyName = '历史遗留的自定义名';
localStorage.setItem('dsh.pending-session.journal.v1', JSON.stringify([
  { t: 1, build: '0.1.0-r27', op: 'rename', id: Y, name: legacyName },
  { t: 2, build: '0.1.0-r27', op: 'adopt', id: Y, name: legacyName },
]));
const plugin4 = loadPlugin();
plugin4.apply(ctx);
assert(journalText().indexOf(legacyName) === -1, 'M-c：载入时剥掉历史 journal 里的会话名');
assert(JSON.parse(localStorage.getItem('dsh.pending-session.journal.v1') || '[]').some((e) => e.op === 'rename' && e.nameLen === legacyName.length), 'M-c：历史记录只保留名字长度');
const entriesLedger = registryEntries();
assert(entriesLedger[Y] !== undefined, '清空后重新收养成功');
assert(entriesLedger[Y] !== undefined && entriesLedger[Y].name === '我的自定义名', '收养时从名称账本恢复自定义名字');
assert(patchedRows()[Y] !== undefined && patchedRows()[Y].title === '我的自定义名', '侧边栏显示恢复后的自定义名字');

// 删除待执行 → 先弹确认框，确认后走「会话归档管理」插件的物理删除接口
const deleteVerb = slotVerb('dps.pending-banner', 'deletePending');
const commitDelete = slotVerb('dps.delete-session-dialog', 'commitDelete');
assert(typeof deleteVerb === 'function', '删除按钮动词可从插槽注册取得');
assert(typeof commitDelete === 'function', '删除确认动词可从插槽注册取得');
const Z = await sessions.create({ workspaceId: 'w1' });
rows[Z].cwd = 'C:/ws'; rows[Z].blank = true; rows[Z].updatedAt = Date.now();
mainId = Z; publishList();
shellFor(Z).state.set({ draft: '要删掉的草稿', attachmentIds: [] });
mainId = C; publishList();
assert(registryEntries()[Z] !== undefined, 'Z 生成待执行条目');
// 给 Z 起个自定义名：删除路径上名字会经过 rename / delete 两处 journal，最能考验「不写用户内容」
await renameVerb(Z, 'Z 的自定义名');
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
// P1-⑥ / P1-④：删除时账本与 IndexedDB 字节都要回收，journal 不得留下用户内容
assert((JSON.parse(localStorage.getItem('dsh.pending-session.names.v1') || '{}')[Z]) === undefined, '删除后名称账本里的会话名被清掉');
assert(JSON.parse(localStorage.getItem('dsh.pending-session.journal.v1') || '[]').every((e) => JSON.stringify(e).indexOf('要删掉的草稿') === -1), 'journal 不再记录会话名/草稿内容');
assert(journalText().indexOf('Z 的自定义名') === -1, 'M-c：删除后整条 journal 序列化不含该会话名（含 rename/delete 全部记录）');
const ledgerAfterZ = JSON.parse(localStorage.getItem('dsh.pending-session.names.v1') || '{}');
assert(typeof ledgerAfterZ === 'object', '账本仍可正常读写');
// m4：saveRegistry 的 journal 只记条目数，不把全部 session id 写进去（膨胀 + 多留用户数据）
const saveLogs = JSON.parse(localStorage.getItem('dsh.pending-session.journal.v1') || '[]').filter((e) => e.op === 'save');
assert(saveLogs.length > 0 && saveLogs.every((e) => e.ids === undefined && typeof e.count === 'number'), 'm4：saveRegistry 的 journal 只记 count');

// P1-④：附件字节在 aid 重映射后要丢掉旧 key（否则每次打开待执行都复制一份）
const restoreVerb = slotVerb('dps.pending-banner', 'restorePending');
const G = await sessions.create({ workspaceId: 'w1' });
rows[G].cwd = 'C:/ws'; rows[G].blank = true; rows[G].updatedAt = Date.now();
mainId = G; publishList();
// 会话里已有附件：先捕获字节（IndexedDB），离开时条目才会带上 manifest
const gFile = new File([new Uint8Array([1, 2, 3])], 'a.txt', { type: 'text/plain' });
const gDraft = conversation.createDrafts(G, [gFile])[0];
shellFor(G).addAttachments([gDraft.id]);
shellFor(G).state.set({ draft: '带附件的草稿', attachmentIds: [gDraft.id] });
mainId = C; publishList();
const gEntry = registryEntries()[G];
assert(gEntry !== undefined && gEntry.attachments.length === 1, 'G 条目带上附件 manifest');
// 字节直接预置进 IndexedDB 桩（真实链路由 captureBlobs 写入，这里只验证恢复+回收）
idbData.set(gEntry.attachments[0].aid, { bytes: [1, 2, 3], name: 'a.txt', mediaType: 'text/plain', kind: 'file' });
// 重新打开条目：输入框附件清空，走恢复路径（会把字节复制成新的 draft aid）
shellFor(G).state.set({ draft: '', attachmentIds: [] });
assert(typeof restoreVerb === 'function', '附件恢复动词可从插槽注册取得');
restoreVerb(G, registryEntries()[G]);
await new Promise((r) => setTimeout(r, 30));
const gAfter = registryEntries()[G];
assert(gAfter !== undefined && gAfter.attachments.length === 1, '恢复后附件条目仍在');
assert(gAfter.attachments[0].aid !== gEntry.attachments[0].aid, '附件恢复后注册表记的是新 aid（P1-④）');
assert(idbData.has(gEntry.attachments[0].aid) === false, '旧 aid 的字节已回收（不无限复制）');

// S1：镜像在草稿阶段就把附件字节写进 IndexedDB；若该会话「从未变成待执行条目」
// （用户直接发送，之后又删掉这个会话），旧实现没有任何回收路径 —— 字节永久滞留，
// 每写一个新草稿就再涨一份。这里逐段复现并断言字节最终被回收。
const S1 = await sessions.create({ workspaceId: 'w1' });
rows[S1].cwd = 'C:/ws'; rows[S1].blank = true; rows[S1].updatedAt = Date.now();
mainId = S1; publishList();
const s1File = new File([new Uint8Array([7, 7, 7])], 'pic.png', { type: 'image/png' });
const s1Draft = conversation.createDrafts(S1, [s1File])[0];
shellFor(S1).addAttachments([s1Draft.id]);
shellFor(S1).state.set({ draft: '', attachmentIds: [s1Draft.id] }); // 只粘了图，没打字
await tick(); // 等镜像的防抖保存跑完（captureBlobs 才真正写进 IndexedDB）
assert(idbData.has(s1Draft.id) === true, 'S1：草稿阶段字节已写进 IndexedDB（测试前提成立）');
assert(registryEntries()[S1] === undefined, 'S1：还没离开会话，尚未成为条目');
// 用户直接发送（不切走）：宿主 blank 翻 false + 时间前移 → 转正
rows[S1].blank = false; rows[S1].updatedAt = Date.now() + 5000; publishList(); publishList();
await tick();
assert(registryEntries()[S1] === undefined, 'S1：直接发送不会登记条目');
// 随后用户删掉这个会话（它从来不是条目，registry 里查无此人）
const s1Calls = [];
lastSandbox.fetch = async (url, init) => {
  s1Calls.push({ url, init });
  return { ok: true, status: 200, json: async () => ({ results: [{ id: S1, status: 'ok' }], freedBytes: 3 }) };
};
const outcomeS1 = await commitDelete(S1);
await new Promise((r) => setTimeout(r, 30));
assert(outcomeS1 !== undefined && outcomeS1.deleted === true, 'S1：会话删除成功');
assert(s1Calls.length === 1 && JSON.parse(s1Calls[0].init.body).ids[0] === S1, 'S1：走的是自家删除端点');
assert(idbData.has(s1Draft.id) === false, 'S1：镜像写下的附件字节被回收（不再永久滞留在 IndexedDB）');
assert(localStorage.getItem('dsh.pending-session.active.v1') === null, 'S1：被删会话的 active 草稿镜像也被清掉（下次启动不会再捡回来）');

// S1（第二条回收路径）：草稿带附件 → 用户直接发送 → 切走（没成为条目）→ 字节同样回收，
// 不必等到用户把会话删掉（否则「挂着不管」的会话会一直占着 IndexedDB）
const S1B = await sessions.create({ workspaceId: 'w1' });
rows[S1B].cwd = 'C:/ws'; rows[S1B].blank = true; rows[S1B].updatedAt = Date.now();
mainId = S1B; publishList();
const s1bFile = new File([new Uint8Array([8, 8, 8])], 'sent.png', { type: 'image/png' });
const s1bDraft = conversation.createDrafts(S1B, [s1bFile])[0];
shellFor(S1B).addAttachments([s1bDraft.id]);
shellFor(S1B).state.set({ draft: '', attachmentIds: [s1bDraft.id] });
await tick();
assert(idbData.has(s1bDraft.id) === true, 'S1：发送前字节已写进 IndexedDB（测试前提）');
rows[S1B].blank = false; rows[S1B].updatedAt = Date.now() + 5000; publishList(); publishList();
mainId = C; publishList(); // 发送后切走：它不会成为条目
await tick();
assert(registryEntries()[S1B] === undefined, 'S1：发送过的会话不会被登记为条目');
assert(idbData.has(s1bDraft.id) === false, 'S1：发送后切走就回收字节（不必等删除）');

// S1（第三条回收路径）：转正时把镜像账上遗留的旧 aid 也回收 ——
// 条目 manifest 只保留离开那一刻还在的附件，被换掉的旧附件字节只挂在镜像账上
const S1C = await sessions.create({ workspaceId: 'w1' });
rows[S1C].cwd = 'C:/ws'; rows[S1C].blank = true; rows[S1C].updatedAt = Date.now();
mainId = S1C; publishList();
const s1cOldFile = new File([new Uint8Array([1, 1])], 'old.txt', { type: 'text/plain' });
const s1cOld = conversation.createDrafts(S1C, [s1cOldFile])[0];
shellFor(S1C).addAttachments([s1cOld.id]);
shellFor(S1C).state.set({ draft: '', attachmentIds: [s1cOld.id] });
await tick(); // 镜像先记下旧附件
const s1cNewFile = new File([new Uint8Array([2, 2])], 'new.txt', { type: 'text/plain' });
const s1cNew = conversation.createDrafts(S1C, [s1cNewFile])[0];
shellFor(S1C).addAttachments([s1cNew.id]);
shellFor(S1C).state.set({ draft: '换过附件的草稿', attachmentIds: [s1cNew.id] }); // 旧附件已被移除
await tick();
mainId = C; publishList();
await tick(); // 等条目创建时的字节落盘（真实时序里「发送」发生在很久之后）
const s1cEntry = registryEntries()[S1C];
assert(s1cEntry !== undefined && s1cEntry.attachments.length === 1 && s1cEntry.attachments[0].aid === s1cNew.id, 'S1：条目 manifest 只留离开时还在的附件');
assert(idbData.has(s1cOld.id) === true, 'S1：被换掉的旧附件字节仍在（只挂在镜像账上）');
rows[S1C].blank = false; rows[S1C].updatedAt = Date.now() + 5000; publishList(); publishList();
await tick();
await tick();
assert(registryEntries()[S1C] === undefined, 'S1：发送后转正（条目移除）');
assert(idbData.has(s1cNew.id) === false, 'S1：转正后条目附件的字节被回收');
assert(idbData.has(s1cOld.id) === false, 'S1：转正后镜像账上遗留的旧 aid 也被回收（否则永久滞留）');

// 轻微：active.v1 里留着的记录，即使内存镜像已经切到别的会话，删除时也要一并清掉 ——
// 真实时序：切到一个非空白会话（不写 active）后，active.v1 里仍是上一个会话的记录
const ACT = await sessions.create({ workspaceId: 'w1' });
rows[ACT].cwd = 'C:/ws'; rows[ACT].blank = true; rows[ACT].updatedAt = Date.now();
mainId = ACT; publishList();
shellFor(ACT).state.set({ draft: 'ACT 的草稿', attachmentIds: [] });
await tick(); // 防抖落盘 → active.v1 记下 ACT
assert((JSON.parse(localStorage.getItem('dsh.pending-session.active.v1') || 'null') || {}).sessionId === ACT, '轻微：active.v1 里记着 ACT（测试前提）');
mainId = C; publishList(); // 切到非空白会话：内存镜像不再指向 ACT（active.v1 里的记录留着）
await new Promise((r) => setTimeout(r, 30));
assert((JSON.parse(localStorage.getItem('dsh.pending-session.active.v1') || 'null') || {}).sessionId === ACT, '轻微：切走后内存镜像已不在 ACT，但 active.v1 仍是 ACT（测试前提）');
lastSandbox.fetch = async (url, init) => ({
  ok: true, status: 200,
  json: async () => ({ results: [{ id: JSON.parse(init.body).ids[0], status: 'ok' }], freedBytes: 1 }),
});
await commitDelete(ACT);
await new Promise((r) => setTimeout(r, 30));
assert(localStorage.getItem('dsh.pending-session.active.v1') === null, '轻微：删除时按盘上记录清掉 active.v1（不靠内存镜像）');

// M7：超过 64MB 的附件不再被静默丢弃 —— manifest 保留 missing 占位项，
// 只带大附件的草稿照样登记为待执行（用户看得见），横幅上直说没保存
const O = await sessions.create({ workspaceId: 'w1' });
rows[O].cwd = 'C:/ws'; rows[O].blank = true; rows[O].updatedAt = Date.now();
mainId = O; publishList();
const bigFile = new File([new Uint8Array([9])], 'big.bin', { type: 'application/octet-stream' });
Object.defineProperty(bigFile, 'size', { value: 64 * 1024 * 1024 + 1 });
const oDraft = conversation.createDrafts(O, [bigFile])[0];
shellFor(O).addAttachments([oDraft.id]);
shellFor(O).state.set({ draft: '', attachmentIds: [oDraft.id] }); // 只有超大附件，没有文本
mainId = C; publishList();
const oEntry = registryEntries()[O];
assert(oEntry !== undefined, '只有超大附件的草稿也会登记为待执行（不再静默丢弃）');
assert(oEntry !== undefined && oEntry.attachments.length === 1, '超限附件在 manifest 里留下占位项');
assert(oEntry !== undefined && oEntry.attachments[0].missing === true, '占位项带 missing 标记');
assert(oEntry !== undefined && oEntry.attachments[0].size > 64 * 1024 * 1024, '占位项保留文件大小（横幅要报数）');
assert(idbData.has(oEntry.attachments[0].aid) === false, '超限附件的字节不会写进 IndexedDB');
// 恢复附件时跳过 missing 项（取不到字节 ≠ 崩溃），占位项原样保留
restoreVerb(O, registryEntries()[O]);
await new Promise((r) => setTimeout(r, 30));
const oAfter = registryEntries()[O];
assert(oAfter !== undefined && oAfter.attachments.length === 1 && oAfter.attachments[0].missing === true, '恢复时跳过 missing 项并原样保留占位');
// 横幅上多一行提示（渲染真实组件，用假 t 把 {n} 替换出来）
const bannerReg = slotComponent('dps.pending-banner');
const bannerState = bannerReg.props.hooks.pending;
const bannerDict = { 'banner.oversize': '⚠️ 有 {n} 个附件过大未保存' };
const bannerEl = bannerReg.component(Object.assign({}, bannerReg.props, {
  sessionId: O,
  usePending: (sel) => sel(bannerState.getSnapshot()),
  useInput: (sel) => sel({ draft: '' }),
  t: (key) => bannerDict[key] || key,
}));
const bannerExtra = bannerEl === null ? null : bannerEl.children[1];
assert(bannerExtra !== null && bannerExtra !== undefined && String(bannerExtra.children[0]).indexOf('有 1 个附件过大未保存') !== -1,
  '横幅显示「有 1 个附件过大未保存」');
const normalEl = bannerReg.component(Object.assign({}, bannerReg.props, {
  sessionId: G,
  usePending: (sel) => sel(bannerState.getSnapshot()),
  useInput: (sel) => sel({ draft: '' }),
  t: (key) => bannerDict[key] || key,
}));
assert(normalEl === null || normalEl.children[1] === null, '没有超限附件的条目不多显示那行提示');

// P1-⑥：执行转正（发送）时同样要清掉账本，不把用户会话名永久留在本地
const F2 = await sessions.create({ workspaceId: 'w1' });
rows[F2].cwd = 'C:/ws'; rows[F2].blank = true; rows[F2].updatedAt = Date.now();
mainId = F2; publishList();
shellFor(F2).state.set({ draft: '要转正的草稿', attachmentIds: [] });
mainId = C; publishList();
await renameVerb(F2, '转正前的名字');
assert(JSON.parse(localStorage.getItem('dsh.pending-session.names.v1'))[F2] !== undefined, '转正前账本里有该会话名');
rows[F2].blank = false;
rows[F2].updatedAt = Date.now() + 5000;
publishList();
publishList();
assert(registryEntries()[F2] === undefined, '转正后条目移除');
assert(JSON.parse(localStorage.getItem('dsh.pending-session.names.v1'))[F2] === undefined, '转正后账本里的会话名被清掉');


// S2：接口不可用（装了插件但没重启 dsh / 未安装）→ 只能按归档处理。
// 归档 ≠ 删除：绝不能报成功，否则用户以为删干净了，实际一个字都没删。
const W = await sessions.create({ workspaceId: 'w1' });
rows[W].cwd = 'C:/ws'; rows[W].blank = true; rows[W].updatedAt = Date.now();
mainId = W; publishList();
shellFor(W).state.set({ draft: '回退草稿', attachmentIds: [] });
mainId = C; publishList();
assert(registryEntries()[W] !== undefined, 'W 生成待执行条目');
const fallbackUrls = [];
lastSandbox.fetch = async (url) => { fallbackUrls.push(String(url)); throw new Error('sim: endpoint missing'); };
deleteVerb(W, '回退草稿');
const outcomeW = await commitDelete(W);
await new Promise((r) => setTimeout(r, 30));
assert(fallbackUrls.length === 1 && fallbackUrls[0].includes('dsh-pending-session/delete'), 'M6：端点不可用时只试自家端点，不再调用第三方删除接口');
assert(archived.has(W) === true, '物理删除不可用时退回原生归档');
assert(outcomeW !== undefined && outcomeW.deleted === false && outcomeW.reason === 'archive', 'S2：归档不再谎报成功（deleted:false + reason:archive）');
assert(registryEntries()[W] !== undefined, 'S2：会话还在，条目就不能先没（被删对象仍在时保留条目）');
assert(typeof plugin1.__dpsDeleteReasonKey === 'function' && plugin1.__dpsDeleteReasonKey('archive') === 'dialog.deleteArchived', 'S2：archive 原因码走归档文案分支');
assert(simDict.zh['dialog.deleteArchived'] !== undefined && simDict.zh['dialog.deleteArchived'].includes('归档') && simDict.en['dialog.deleteArchived'] !== undefined, 'S2：词典补了归档提示的中英文案');
assert(simDict.zh['dialog.deleteArchived'].includes('重启 dsh'), 'S2：归档提示告诉用户重启 dsh 才能真删');
// M-f：其余原因码也要各归各位，不能再一律显示「仍被 DSH 进程持有」
const reasonKey = plugin1.__dpsDeleteReasonKey;
assert(reasonKey('no-storage') === 'dialog.deleteNoStorage' && simDict.zh['dialog.deleteNoStorage'] !== undefined && simDict.en['dialog.deleteNoStorage'] !== undefined, 'M-f：no-storage 有专门文案（不再误报「仍被进程持有」）');
assert(reasonKey('storage-error') === 'dialog.deleteStorageError' && simDict.zh['dialog.deleteStorageError'] !== undefined, 'M-f：storage-error 有专门文案');
assert(reasonKey('disposed') === 'dialog.deleteDisposed' && simDict.zh['dialog.deleteDisposed'] !== undefined, 'M-f：disposed 有专门文案');
assert(reasonKey('archive-error') === 'dialog.deleteArchiveFailed' && simDict.zh['dialog.deleteArchiveFailed'] !== undefined, 'M-f：归档也失败时有专门文案');
assert(reasonKey('held') === 'dialog.deleteBlocked' && reasonKey(undefined) === 'dialog.deleteBlocked', 'M-f：held/未知原因仍落到「被进程持有」文案');
// 归档回退发生在真实删除流程里（先切走/等释放都过了），重试一次仍然只归档、仍不报成功
const outcomeW2 = await commitDelete(W);
assert(outcomeW2 !== undefined && outcomeW2.deleted === false && outcomeW2.reason === 'archive', 'S2：再点一次仍然是「已归档」而不是「已删除」（不因重试改变语义）');

// 普通会话（没有待执行条目）也能通过同一条路径删除
const V = await sessions.create({ workspaceId: 'w1' });
rows[V].cwd = 'C:/ws'; rows[V].blank = false; rows[V].updatedAt = Date.now();
// m2：普通会话的原生草稿键同样是残留用户内容，删除后必须无条件清掉
localStorage.setItem('dsh.conversation.' + V, JSON.stringify({ draft: '普通会话的残留草稿', view: null, viewRequest: null }));
const deleteCalls2 = [];
lastSandbox.fetch = async (url, init) => {
  deleteCalls2.push({ url, init });
  return { ok: true, status: 200, json: async () => ({ results: [{ id: V, status: 'ok' }], freedBytes: 7 }) };
};
await commitDelete(V);
await new Promise((r) => setTimeout(r, 30));
assert(deleteCalls2.length === 1 && JSON.parse(deleteCalls2[0].init.body).ids[0] === V, '普通会话也能通过同一路径删除');
assert(registryEntries()[V] === undefined, '删除普通会话不影响待执行注册表');
assert(localStorage.getItem('dsh.conversation.' + V) === null, 'm2：普通会话删除后原生草稿键被清掉');

// M1：失去所有权的标签页（另一个 dsh 窗口在管待执行）不得真删会话
const M1X = await sessions.create({ workspaceId: 'w1' });
rows[M1X].cwd = 'C:/ws'; rows[M1X].blank = true; rows[M1X].updatedAt = Date.now();
mainId = M1X; publishList();
shellFor(M1X).state.set({ draft: '别的窗口不许删的草稿', attachmentIds: [] });
mainId = C; publishList();
assert(registryEntries()[M1X] !== undefined, 'M1X 生成待执行条目');
const ownerToken = localStorage.getItem('dsh.pending-session.owner.v1');
localStorage.setItem('dsh.pending-session.owner.v1', 'another-window-token');
let notOwnerCalls = 0;
lastSandbox.fetch = async () => {
  notOwnerCalls += 1;
  return { ok: true, status: 200, json: async () => ({ results: [{ id: M1X, status: 'ok' }], freedBytes: 1 }) };
};
const outcomeNotOwner = await commitDelete(M1X);
await new Promise((r) => setTimeout(r, 30));
assert(notOwnerCalls === 0, 'M1：非所有者标签页一个删除请求都不发（真删必须拒绝）');
assert(outcomeNotOwner !== undefined && outcomeNotOwner.deleted === false && outcomeNotOwner.reason === 'not-owner', 'M1：返回 {deleted:false, reason:not-owner} 交给确认框');
assert(registryEntries()[M1X] !== undefined, 'M1：被拒后条目保留');
localStorage.setItem('dsh.pending-session.owner.v1', ownerToken);
assert(simDict.zh['dialog.deleteNotOwner'] !== undefined && simDict.en['dialog.deleteNotOwner'] !== undefined, 'M1：词典补了 deleteNotOwner 的中英文案');
assert(simDict.zh['banner.oversize'] !== undefined && simDict.en['banner.oversize'] !== undefined, 'M7：词典补了超大附件提示的中英文案');

// M8：删除「当前正在看的会话」时，先切走没生效就不能把它从投影里藏掉
// （a）uiWorkspace 不可用 → 连 removedIds 都不加
const M8A = await sessions.create({ workspaceId: 'w1' });
rows[M8A].cwd = 'C:/ws'; rows[M8A].blank = true; rows[M8A].updatedAt = Date.now();
mainId = M8A; publishList();
shellFor(M8A).state.set({ draft: 'M8A 的草稿', attachmentIds: [] });
lastSandbox.fetch = async (url, init) => {
  return { ok: true, status: 200, json: async () => ({ results: [{ id: JSON.parse(init.body).ids[0], status: 'ok' }], freedBytes: 1 }) };
};
const ctxGet = ctx.get;
ctx.get = (n) => (n === 'uiWorkspace' ? undefined : ctxGet(n));
const outcomeM8A = await commitDelete(M8A);
ctx.get = ctxGet;
await new Promise((r) => setTimeout(r, 30));
const snapM8A = sessions.list.getSnapshot();
assert(outcomeM8A !== undefined && outcomeM8A.deleted === true, 'M8：切不走也仍然删掉了会话本身');
assert(snapM8A.byId[M8A] !== undefined && snapM8A.ids.indexOf(M8A) !== -1, 'M8：uiWorkspace 不可用时当前会话那一行不被藏掉（byId + ids）');
// 之后切走也不该被记进 removedIds：那一行交给宿主自己收敛，不由我们藏
shellFor(M8A).state.set({ draft: '', attachmentIds: [] });
mainId = C; publishList();
await new Promise((r) => setTimeout(r, 10));
const snapM8A2 = sessions.list.getSnapshot();
assert(snapM8A2.ids.indexOf(M8A) !== -1 && snapM8A2.byId[M8A] !== undefined, 'M8：切走没生效过的那次删除不把 id 记进 removedIds（切走后行仍在）');
// （b）uiWorkspace 可用但没真切走 → 投影层也要跳过当前主会话
const M8B = await sessions.create({ workspaceId: 'w1' });
rows[M8B].cwd = 'C:/ws'; rows[M8B].blank = true; rows[M8B].updatedAt = Date.now();
mainId = M8B; publishList();
shellFor(M8B).state.set({ draft: 'M8B 的草稿', attachmentIds: [] });
await commitDelete(M8B);
await new Promise((r) => setTimeout(r, 30));
const snapM8B = sessions.list.getSnapshot();
assert(snapM8B.byId[M8B] !== undefined && snapM8B.ids.indexOf(M8B) !== -1, 'M8：先切走没生效时，投影也不隐藏当前主会话行（byId + ids）');
// M-e：「切走没生效」必须来自「新主会话没就位」的判据，而不是把 startSession 的返回当真
const m8bLogs = JSON.parse(localStorage.getItem('dsh.pending-session.journal.v1') || '[]');
const m8bPrep = m8bLogs.filter((e) => e.op === 'delete-prep' && e.id === M8B).pop();
assert(m8bPrep !== undefined && m8bPrep.left === false, 'M-e：startSession 发起即返回但没切走 → 判为「未切走」（left:false）');
assert(m8bLogs.some((e) => e.op === 'keep-row' && e.id === M8B), 'M-e：未切走的删除不把该行记进 removedIds（journal keep-row）');

// M-e：uiWorkspace.startSession 真实语义是「发起即返回、RPC 异步完成」（宿主繁忙时
// 要过一会儿新主会话才就位）。假时钟把切走安排到 1.2s 之后 —— 插件必须等新主会话
// 就位再收工，而不是一次读完就判「没切走」（旧实现的 1.5s 窗口 + 同步 setTimeout 桩
// 恰好把这条时序掩盖掉了）。
const ME = await sessions.create({ workspaceId: 'w1' });
rows[ME].cwd = 'C:/ws'; rows[ME].blank = true; rows[ME].updatedAt = Date.now();
mainId = ME; publishList();
shellFor(ME).state.set({ draft: 'M-e 的草稿', attachmentIds: [] });
mainId = C; publishList();
assert(registryEntries()[ME] !== undefined, 'M-e：ME 生成待执行条目');
mainId = ME; publishList(); // 回到 ME：删除的就是「当前正在看的会话」
lastSandbox.fetch = async (url, init) => {
  return { ok: true, status: 200, json: async () => ({ results: [{ id: JSON.parse(init.body).ids[0], status: 'ok' }], freedBytes: 1 }) };
};
let meLeaveCalls = 0;
let meSwitchArmed = false;
ctx.get = (n) => (n === 'uiWorkspace' ? {
  startSession: () => {
    meLeaveCalls += 1;
    // 真实的 startSession 就是「发起即返回」：宿主忙完才切走。这里把落地挂钩到
    // 「插件已经轮询过引用计数」，模拟「切走比第一次判定晚一步完成」
    meSwitchArmed = true;
  },
} : ctxGet(n));
const meRetainInfo = sessions.retainInfo;
sessions.retainInfo = (id) => {
  const inner = meRetainInfo(id);
  return {
    getSnapshot: () => {
      const snap = inner.getSnapshot();
      if (meSwitchArmed && id === ME && simRetain.reads >= 5) {
        meSwitchArmed = false;
        later(0, () => { mainId = C; publishList(); }); // 异步 RPC 落地
      }
      return snap;
    },
  };
};
simRetain.counts.delete(ME);
simRetain.reads = 0;
const outcomeME = await commitDelete(ME);
ctx.get = ctxGet;
sessions.retainInfo = meRetainInfo;
await new Promise((r) => setTimeout(r, 30));
assert(meLeaveCalls === 1, 'M-e：删除前确实发起了切走');
assert(outcomeME !== undefined && outcomeME.deleted === true, 'M-e：切走稍晚完成也不误报 held（不是假拒绝）');
// 旧实现第一轮读到 count=0 就收工（reads=1）；新实现要等新主会话就位，会一直轮询到它落地
assert(simRetain.reads >= 5, 'M-e：等到新主会话就位才收工（不是读一次就走）');
assert(sessions.list.getSnapshot().ids.indexOf(ME) === -1, 'M-e：真切走之后，被删会话的行立刻从投影消失');
assert(registryEntries()[ME] === undefined, 'M-e：条目同时清理干净');

// M-b：宿主回显的 id 拼写可能与调用方传入的不同（裸 uuid ↔ session-<uuid>）。
// 客户端必须两侧规范化后比较 —— 否则 ownDelete 匹配不到结果 → 返回 undefined →
// 真删除被降级成归档，而用户看到的却是「删除成功」。实测机器上确实有裸 uuid 会话目录。
const bareId = '5f0b7c22-1a2b-4c3d-9e8f-0a1b2c3d4e5f';
const BU = await sessions.create({ workspaceId: 'w1', sessionId: bareId });
rows[BU].cwd = 'C:/ws'; rows[BU].blank = false; rows[BU].updatedAt = Date.now();
mainId = C; publishList();
const bareCalls = [];
lastSandbox.fetch = async (url, init) => {
  bareCalls.push({ url, init });
  return { ok: true, status: 200, json: async () => ({ results: [{ id: 'session-' + bareId, status: 'ok' }], freedBytes: 9 }) };
};
const outcomeBare = await commitDelete(bareId);
await new Promise((r) => setTimeout(r, 30));
assert(bareCalls.length === 1 && JSON.parse(bareCalls[0].init.body).ids[0] === bareId, 'M-b：裸 uuid 会话走自家删除端点');
assert(outcomeBare !== undefined && outcomeBare.deleted === true && outcomeBare.via === 'own', 'M-b：宿主回显规范化拼写也认得出来（真删除不被降级成归档）');
assert(archived.has(bareId) !== true, 'M-b：匹配成功就不退回归档');
// 反向：调用方传 session-<uuid>，宿主回显裸 uuid
const CAN = 'session-9c8d7e6f-5a4b-3c2d-1e0f-aabbccddeeff';
const CANu = await sessions.create({ workspaceId: 'w1', sessionId: CAN });
rows[CANu].cwd = 'C:/ws'; rows[CANu].blank = false; rows[CANu].updatedAt = Date.now();
mainId = C; publishList();
lastSandbox.fetch = async () => ({
  ok: true, status: 200,
  json: async () => ({ results: [{ id: CAN.slice('session-'.length), status: 'ok' }], freedBytes: 4 }),
});
const outcomeCan = await commitDelete(CAN);
await new Promise((r) => setTimeout(r, 30));
assert(outcomeCan !== undefined && outcomeCan.deleted === true && outcomeCan.via === 'own', 'M-b：反向（传 session- 前缀、回显裸 uuid）同样认得出来');
// 后续用例依赖「按请求回显自己的 id」的桩，这里恢复回去
lastSandbox.fetch = async (url, init) => ({
  ok: true, status: 200,
  json: async () => ({ results: [{ id: JSON.parse(init.body).ids[0], status: 'ok' }], freedBytes: 1 }),
});
// 反向保护：删的不是当前会话时，行照旧立刻从投影里消失（M8 的例外只针对主会话）
const M8C = await sessions.create({ workspaceId: 'w1' });
rows[M8C].cwd = 'C:/ws'; rows[M8C].blank = false; rows[M8C].updatedAt = Date.now();
mainId = C; publishList();
await commitDelete(M8C);
await new Promise((r) => setTimeout(r, 30));
const snapM8C = sessions.list.getSnapshot();
assert(snapM8C.ids.indexOf(M8C) === -1 && snapM8C.byId[M8C] === undefined, 'M8：非当前会话删除后行立刻从投影消失（原语义保留）');

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

// P0-②：普通会话（非条目）报 not-found 不算成功 —— 否则会话还在却报删除成功
const N = await sessions.create({ workspaceId: 'w1' });
rows[N].cwd = 'C:/ws'; rows[N].blank = false; rows[N].updatedAt = Date.now();
mainId = C; publishList();
let deleteCallsN = 0;
lastSandbox.fetch = async () => {
  deleteCallsN += 1;
  return { ok: true, status: 200, json: async () => ({ results: [{ id: N, status: 'skipped', reason: 'not-found' }], freedBytes: 0 }) };
};
const outcomeN = await commitDelete(N);
await new Promise((r) => setTimeout(r, 30));
assert(deleteCallsN === 1, '普通会话走自家删除器（只请求一次）');
assert(outcomeN !== undefined && outcomeN.deleted === false, '普通会话 not-found 不算成功（P0-②）');
assert(outcomeN.reason === 'no-storage', '普通会话 not-found 返回 no-storage 原因码');

// 悬空引用（存储被外部删掉、workspace 记账还留着 → 界面上那行删不掉、点开报 ENOENT）：
// 宿主摘掉记账并回 prunedStale:true，客户端必须跟着把它从界面清掉
const GHOST = await sessions.create({ workspaceId: 'w1' });
rows[GHOST].cwd = 'C:/ws'; rows[GHOST].blank = false; rows[GHOST].updatedAt = Date.now();
mainId = C; publishList();
let ghostBody = null;
lastSandbox.fetch = async (url, init) => {
  ghostBody = JSON.parse(init.body);
  return { ok: true, status: 200, json: async () => ({ results: [{ id: GHOST, status: 'skipped', reason: 'not-found', prunedStale: true }], freedBytes: 0 }) };
};
const outcomeGhost = await commitDelete(GHOST);
await new Promise((r) => setTimeout(r, 30));
assert(ghostBody !== null && ghostBody.pruneStale === true, '删除请求带上 pruneStale（授权宿主清理悬空记账）');
assert(outcomeGhost !== undefined && outcomeGhost.deleted === true, '悬空引用被摘掉后视为删除成功（行能真正消失）');
assert(patchedRows()[GHOST] === undefined, '被摘掉的那行不再出现在侧边栏投影里');
const journalGhost = JSON.parse(localStorage.getItem('dsh.pending-session.journal.v1') || '[]');
assert(journalGhost.some((e) => e.op === 'delete-stale-pruned' && e.id === GHOST), 'journal 记下 delete-stale-pruned（便于事后取证）');

// journal 写放大修复：普通对话里镜像处理器每次状态变化都会走到「非空白」分支，
// 以前每键记一次 skip-non-blank（实测把 300 条环形容量挤满、冲掉真正的增删记录），
// 现在同一个会话只记首次；换会话重新开始镜像时复位（每个会话各能记一条）
const NB1 = await sessions.create({ workspaceId: 'w1' });
rows[NB1].cwd = 'C:/ws'; rows[NB1].blank = false; rows[NB1].updatedAt = Date.now();
mainId = C; publishList();
mainId = NB1; publishList(); // 进入非空白会话 → 开始镜像
for (let i = 0; i < 4; i += 1) {
  shellFor(NB1).state.set({ draft: '普通会话里打字 ' + i, attachmentIds: [] }); // 模拟连续击键
}
const skipOf = (sid) => JSON.parse(localStorage.getItem('dsh.pending-session.journal.v1') || '[]')
  .filter((e) => e.op === 'skip-non-blank' && e.id === sid).length;
assert(skipOf(NB1) === 1, 'journal：非空白会话反复变化（模拟击键）只记一条 skip-non-blank');

const NB2 = await sessions.create({ workspaceId: 'w1' });
rows[NB2].cwd = 'C:/ws'; rows[NB2].blank = false; rows[NB2].updatedAt = Date.now();
mainId = C; publishList();
mainId = NB2; publishList(); // 换会话 → 复位
shellFor(NB2).state.set({ draft: '另一个普通会话里打字', attachmentIds: [] });
assert(skipOf(NB2) === 1 && skipOf(NB1) === 1, 'journal：换到另一个非空白会话后仍各记一条（记忆位按会话复位）');

// P0-③：非空白会话不会被登记为待执行（普通会话带草稿离开也不行）
const M = await sessions.create({ workspaceId: 'w1' });rows[M].cwd = 'C:/ws'; rows[M].blank = false; rows[M].updatedAt = Date.now();
mainId = M; publishList();
shellFor(M).state.set({ draft: '普通会话里的草稿', attachmentIds: [] });
mainId = C; publishList();
assert(registryEntries()[M] === undefined, '非空白会话不被登记为待执行（P0-③）');
assert(patchedRows()[M].blank === false && patchedRows()[M].cwd === 'C:/ws', '非空白会话的行未被投影改写成假待执行');
// 顺带：普通会话（非空白）不配写 active 镜像，写过的也要被清掉，否则下次启动会反复误建
rows[M].blank = false;
mainId = C; publishList(); // 此时 M 已非空白：离开路径会把 active 记录摘掉
localStorage.setItem('dsh.pending-session.active.v1', JSON.stringify({ sessionId: M, savedAt: Date.now(), text: '普通会话的草稿', manifest: [] }));
mainId = M; publishList();  // 进 M：镜像看到 non-blank，应立刻清理这条 active 记录
assert(localStorage.getItem('dsh.pending-session.active.v1') === null, '非空白会话的 active 镜像被清掉（不再误建）');
mainId = C; publishList();
assert(registryEntries()[M] === undefined, '清理镜像后依然不登记 M');

// 宿主拒绝（attached）：自家删除器如实回失败，不做无谓重试（也不再转投第三方接口）
const S = await sessions.create({ workspaceId: 'w1' });
rows[S].cwd = 'C:/ws'; rows[S].blank = true; rows[S].updatedAt = Date.now();
mainId = S; publishList();
shellFor(S).state.set({ draft: '等待释放的草稿', attachmentIds: [] });
mainId = C; publishList();
assert(registryEntries()[S] !== undefined, 'S 生成待执行条目');
let attachedCalls = 0;
const attachedUrls = [];
lastSandbox.fetch = async (url) => {
  attachedCalls += 1;
  attachedUrls.push(String(url));
  return attachedCalls === 1
    ? { ok: true, status: 200, json: async () => ({ results: [{ id: S, status: 'skipped', reason: 'attached' }], freedBytes: 0 }) }
    : { ok: true, status: 200, json: async () => ({ results: [{ id: S, status: 'ok' }], freedBytes: 5 }) };
};
const outcomeS = await commitDelete(S);
await new Promise((r) => setTimeout(r, 30));
assert(attachedCalls === 1, '自家删除器对宿主拒绝不做无谓重试');
assert(attachedUrls.every((u) => u.includes('dsh-pending-session/delete')), 'M6：被拒时也不会转投第三方删除接口');
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

// P0-⑤：宿主仍持有（引用计数不归零）→ 一个字节都不许删，如实报「仍被持有」
const H = await sessions.create({ workspaceId: 'w1' });
rows[H].cwd = 'C:/ws'; rows[H].blank = true; rows[H].updatedAt = Date.now();
mainId = H; publishList();
shellFor(H).state.set({ draft: '一直被持有的草稿', attachmentIds: [] });
mainId = C; publishList();
assert(registryEntries()[H] !== undefined, 'H 生成待执行条目');
simRetain.counts.set(H, 999); // 模拟宿主一直持有（重启前都不会释放）
simRetain.reads = 0;
let deleteCallsH = 0;
lastSandbox.fetch = async () => {
  deleteCallsH += 1;
  return { ok: true, status: 200, json: async () => ({ results: [{ id: H, status: 'ok' }], freedBytes: 1 }) };
};
const outcomeH = await commitDelete(H);
await new Promise((r) => setTimeout(r, 30));
assert(simRetain.reads >= 2, '删除前轮询本地引用计数（held 判定用）');
assert(deleteCallsH === 0, '宿主仍持有时一个删除请求都不发（不碰文件）');
assert(outcomeH !== undefined && outcomeH.deleted === false && outcomeH.reason === 'held', 'held 时不删，返回 held 让确认框提示重启');
assert(registryEntries()[H] !== undefined, 'held 时条目保留（不会出现会话还在但条目消失）');
simRetain.counts.delete(H);

// M4：关键读取（hostBlank）首次失败必须告警一次，带 BUILD 版本号；重复失败不刷屏
simWarns.length = 0;
const bindingStub = sessions.binding;
sessions.binding = () => { throw new Error('sim: binding unavailable'); };
publishList();
publishList();
publishList();
sessions.binding = bindingStub;
const hostBlankWarns = simWarns.filter((args) => String(args[0]).includes(' hostBlank: '));
assert(hostBlankWarns.length === 1, 'M4：hostBlank 读取失败只告警一次（不刷屏）');
assert(String(hostBlankWarns[0]?.[0] || '').includes(BUILD), 'M4：告警带上 BUILD 版本号');

// M5：dispose（卸载/HMR）之后旧实例必须停手 —— 延迟续跑短路、不再动宿主
const disposePlugin = simEffects.pop();
assert(typeof disposePlugin === 'function', 'M5：能取到插件注册的 dispose');
disposePlugin();
let disposedCalls = 0;
lastSandbox.fetch = async () => {
  disposedCalls += 1;
  return { ok: true, status: 200, json: async () => ({ results: [{ id: M8B, status: 'ok' }], freedBytes: 1 }) };
};
const outcomeDisposed = await commitDelete(M8B);
await new Promise((r) => setTimeout(r, 30));
assert(disposedCalls === 0, 'M5：dispose 后一个删除请求都不发');
assert(outcomeDisposed !== undefined && outcomeDisposed.deleted === false && outcomeDisposed.reason === 'disposed', 'M5：dispose 后删除直接短路返回');
simEffects.length = 0; // 旧实例的清理函数已在上面取用，后续用例各自记录

// 轻微：插槽注册失败不能静默（旧实现只有 tryRun，失败后对应 UI 整块消失且毫无提示）
const slotInjectStub = slotStub.inject;
let slotInjectCalls = 0;
slotStub.inject = () => { slotInjectCalls += 1; throw new Error('sim: slot registry unavailable'); };
simWarns.length = 0;
const plugin5 = loadPlugin();
plugin5.apply(ctx);
slotStub.inject = slotInjectStub;
const slotWarns = simWarns.filter((args) => String(args[0]).includes(' slot:'));
assert(slotInjectCalls === 5, '轻微：5 个插槽注册逐个尝试（失败也要一个个试）');
assert(slotWarns.length === 4, '轻微：每个插槽首次失败各告警一次（shell.overlay 两次注册共用一个 key）');
assert(slotWarns.some((args) => String(args[0]).includes('slot:conversation.input.dock')), '轻微：告警带上插槽 id');
assert(slotWarns.every((args) => String(args[0]).includes(BUILD)), '轻微：插槽告警带 BUILD 版本号');
// 插槽挂不上也不影响状态机：条目照常登记
const IS = await sessions.create({ workspaceId: 'w1' });
rows[IS].cwd = 'C:/ws'; rows[IS].blank = true; rows[IS].updatedAt = Date.now();
mainId = IS; publishList();
shellFor(IS).state.set({ draft: '插槽坏了的草稿', attachmentIds: [] });
mainId = C; publishList();
assert(registryEntries()[IS] !== undefined, '轻微：插槽注册失败不影响条目状态机');

// 轻微：附件字节回收失败不能静默（旧实现 .catch(()=>{}) 把 IndexedDB 故障整个吞掉）。
// 上面那个实例插槽全失败（也就没有对话框注册），这里重新挂一个实例来取动词。
const plugin5b = loadPlugin();
plugin5b.apply(ctx);
const deleteVerb5 = slotVerb('dps.pending-banner', 'deletePending');
const commitDelete5 = slotVerb('dps.delete-session-dialog', 'commitDelete');
idbFault.delete = true;
simWarns.length = 0;
const D1 = await sessions.create({ workspaceId: 'w1' });
rows[D1].cwd = 'C:/ws'; rows[D1].blank = true; rows[D1].updatedAt = Date.now();
mainId = D1; publishList();
const d1File = new File([new Uint8Array([5, 5])], 'd1.txt', { type: 'text/plain' });
const d1Draft = conversation.createDrafts(D1, [d1File])[0];
shellFor(D1).addAttachments([d1Draft.id]);
shellFor(D1).state.set({ draft: 'D1 的草稿', attachmentIds: [d1Draft.id] });
mainId = C; publishList();
assert(registryEntries()[D1]?.attachments.length === 1, '轻微：D1 条目带附件（回收路径才会被走到）');
lastSandbox.fetch = async (url, init) => ({
  ok: true, status: 200,
  json: async () => ({ results: [{ id: JSON.parse(init.body).ids[0], status: 'ok' }], freedBytes: 2 }),
});
deleteVerb5(D1, 'D1 的草稿');
await commitDelete5(D1);
await new Promise((r) => setTimeout(r, 30));
const dropWarns = simWarns.filter((args) => String(args[0]).includes(' dropBlobs: '));
assert(dropWarns.length === 1, '轻微：字节回收失败告警一次（不再静默吞掉）');
// 第二份失败同样只喊一次（warnOnce 去重，不刷屏）
const D2 = await sessions.create({ workspaceId: 'w1' });
rows[D2].cwd = 'C:/ws'; rows[D2].blank = true; rows[D2].updatedAt = Date.now();
mainId = D2; publishList();
const d2File = new File([new Uint8Array([6, 6])], 'd2.txt', { type: 'text/plain' });
const d2Draft = conversation.createDrafts(D2, [d2File])[0];
shellFor(D2).addAttachments([d2Draft.id]);
shellFor(D2).state.set({ draft: 'D2 的草稿', attachmentIds: [d2Draft.id] });
mainId = C; publishList();
deleteVerb5(D2, 'D2 的草稿');
await commitDelete5(D2);
await new Promise((r) => setTimeout(r, 30));
assert(simWarns.filter((args) => String(args[0]).includes(' dropBlobs: ')).length === 1, '轻微：重复失败不刷屏（warnOnce 去重）');
idbFault.delete = false;

// 轻微：restorePatch 只在「当前 getSnapshot 仍是本实例装的包装」时才还原 ——
// HMR 时序里新实例已经装好自己的投影，旧实例 dispose 不能把新的拆掉
const HM = await sessions.create({ workspaceId: 'w1' });
rows[HM].cwd = 'C:/ws'; rows[HM].blank = true; rows[HM].updatedAt = Date.now();
mainId = HM; publishList();
shellFor(HM).state.set({ draft: 'HMR 投影草稿', attachmentIds: [] });
mainId = C; publishList();
assert(registryEntries()[HM] !== undefined, '轻微：HM 生成待执行条目');
const effectsBefore6 = simEffects.length;
const plugin6 = loadPlugin();
plugin6.apply(ctx);
const disposers6 = simEffects.slice(effectsBefore6); // [词典注销, 真正 dispose]
const plugin7 = loadPlugin();
plugin7.apply(ctx);
disposers6[disposers6.length - 1](); // 旧实例（plugin6）卸载
publishList();
assert(patchedRows()[HM] !== undefined && patchedRows()[HM].blank === false, '轻微：旧实例 dispose 不拆掉新实例的投影（HM 行仍是投影后的样子）');
assert(sessions.list.getSnapshot() === sessions.list.getSnapshot(), '轻微：还原被跳过后投影仍然是稳定引用（React 不炸）');

/** 取最近一个实例登记在册的清理函数（dispose）。 */
function lastDisposer() { return simEffects[simEffects.length - 1]; }

// 轻微（A3）：插槽 id 必须带包名前缀 —— 官方插槽契约写明「复用同名 id 会顶掉那一格」，
// 通用词（delete-session / pending-banner 之类）会被 DSH 新版本或第三方插件静默互相顶掉。
const DPS_IDS = ['dps.pending-banner', 'dps.pending-mark', 'dps.delete-session', 'dps.pending-rename-dialog', 'dps.delete-session-dialog'];
const registeredIds = slotRegistrations.map((r) => r.options.id);
assert(DPS_IDS.every((id) => registeredIds.includes(id)), 'A3：五个插槽注册 id 全部带 dps. 包名前缀');
const legacyIds = ['pending-banner', 'pending-mark', 'delete-session', 'pending-rename-dialog', 'delete-session-dialog'];
assert(legacyIds.every((id) => registeredIds.includes(id) === false), 'A3：不再注册无前缀的通用 id（不会顶掉别人的那一格）');

// 轻微（A3/应用卫生）：默认沙箱没有 document → 样式注入必须安静跳过，不能抛、也不能去建样式
assert(simWarns.filter((args) => String(args[0]).includes(' styles: ')).length === 0, '样式：无 DOM 环境下不注入、不告警');

// 轻微：样式是页面级资源 —— 必须由 apply 注入、并在 dispose 时摘掉（旧实现只加不删）
const headChildren = [];
let styleRemoved = 0;
const styleElementStub = {
  dataset: {},
  set textContent(text) { this._text = text; },
  get textContent() { return this._text; },
  parentNode: { removeChild: () => { styleRemoved += 1; } },
};
const pluginStyle = loadPlugin({
  // 样式走沙箱全局 document（插件的页面级 API），不是 ctx 属性
  document: {
    head: { appendChild: (el) => { headChildren.push(el); } },
    querySelector: () => null,
    createElement: () => styleElementStub,
  },
});
pluginStyle.apply(ctx);
assert(headChildren.length === 1 && headChildren[0].dataset.pluginCss === 'dsh-pending-session/style', '样式：apply 时注入到 <head>（带 pluginCss 标记）');
assert(headChildren[0].textContent.includes('.dps-bar'), '样式：注入的是插件 CSS 本体');
lastDisposer()();
assert(styleRemoved === 1, '样式：dispose 时把注入的 <style> 摘掉（不再永久残留）');

// 轻微：依赖没就绪时不能置位 APPLIED —— 否则后续重试全被短路，插件到刷新为止都不注册
simWarns.length = 0;
const plugin8 = loadPlugin();
const effectsBefore8 = simEffects.length; // 必须在上面 dispose 之前取：dispose 会把最后一个 effect 弹出去
plugin8.apply(Object.assign({}, ctx, { locale: undefined })); // 缺一个依赖
const depsWarns = simWarns.filter((args) => String(args[0]).includes(' apply:deps: '));
assert(effectsBefore8 === simEffects.length, '依赖缺失：这一次 apply 什么都没注册');
assert(depsWarns.length === 1, '依赖缺失：首次告警一次（静默失效查不出来）');
assert(depsWarns.every((args) => String(args[0]).includes(BUILD)), '依赖缺失：告警带 BUILD 版本号');
const effectsBefore8b = simEffects.length;
plugin8.apply(ctx); // 依赖补齐后必须还能正常 apply
assert(simEffects.length === effectsBefore8b + 3, '依赖缺失后重试仍能装上（字典 + 样式 + dispose 三个 effect）');

// 轻微（F1）：不依赖基座外的 Harness Client 包（dsh-client-store）—— 插件自带的快照 store
// 必须满足 React 的三条硬要求：快照稳定引用、subscribe 返回退订函数、set 同步通知全部监听者
const storeProbe = simStores[simStores.length - 1];
assert(storeProbe !== undefined && storeProbe.getSnapshot() === storeProbe.getSnapshot(), 'F1：自带 store 的快照是稳定引用（React 不会无限渲染）');
let storeNotified = 0;
const storeUnsub = storeProbe.subscribe(() => { storeNotified += 1; });
storeProbe.set({ entries: { x: 1 }, renameRequest: null, deleteRequest: null });
assert(storeNotified === 1 && storeProbe.getSnapshot().entries.x === 1, 'F1：set 同步通知监听者并换掉快照');
storeUnsub();
storeProbe.set({ entries: {}, renameRequest: null, deleteRequest: null });
assert(storeNotified === 1, 'F1：退订之后不再收到通知');

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
const hostResult = await runHostTests();
console.log(`宿主用例: ${hostResult.pass} 通过, ${hostResult.fail} 失败`);
console.log(`合计: ${pass + hostResult.pass} 通过, ${fail + hostResult.fail} 失败`);
process.exit(fail + hostResult.fail === 0 ? 0 : 1);
