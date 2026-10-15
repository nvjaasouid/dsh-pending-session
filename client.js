/**
 * dsh-pending-session —— 浏览器半边（client bundle）。
 *
 * 「待执行」会话草稿：
 *   1. 带合格草稿（非空白文本 或 任意附件）的新会话被离开时，生成侧边栏条目
 *      「待执行」（记录创建时间），与其他对话记录并列、按时间排序；
 *   2. 点进条目 = 回到该新会话的原生界面（空白输入框），草稿文本/附件原样恢复；
 *   3. 点发送 → 立刻转正为普通对话记录（记发送时间、置顶）；
 *   4. 点进后只查看/编辑（不发送）不改时间、不改位置；重命名只改名；
 *   5. 支持多个并存、支持删除；清空草稿后离开 = 自动删除该条目；
 *   6. 条目、草稿文本（localStorage）、附件字节（IndexedDB）本地持久化，
 *      重启后仍在；退出时活动新会话的合格草稿，下次启动自动显示为待执行。
 *
 * 实现要点（全部走公开的插槽/服务契约，不改 DSH 核心）：
 *   - 「待执行」条目本体就是真实存在的 blank session（新会话本来就是会话）；
 *   - 通过派生包装 sessions.list 的快照，把待执行会话投影为可见的非 blank 行
 *     （标题=名称、时间=创建时间），并借 cwd 投影让「新会话」不再复用带草稿的
 *     旧 blank session（点击新会话才会真正开一张空白的新会话）；
 *   - 通过 conversation 服务的 input shell 读取/播种草稿与附件；
 *   - 会话列表变化（离开/执行/删除）驱动状态机。
 */
window.__ModuleLoader__.load({
	id: "dsh-pending-session",
	factory: (require) => {
		"use strict";
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		var React = require("react");
		// 只 require 冻结模块表（PLATFORM_MODULES）里的 react 与 ui-primitives —— 官方
		// 客户端插件规范把 ui-primitives 明确列成 Module Loader 包的隐式基座；
		// 基座外的 Harness Client 包（例如 dsh-client-store）一律不 require，免得某个
		// dsh 版本没把它种进模块表时直接抛 "missed the module table"。
		var primitives = require("@deepseek-ai/dsh-client-ui-primitives");

		/**
		 * 极简快照 store（就地实现，替代 @deepseek-ai/dsh-client-store 的 createSnapshotStore）。
		 *
		 * 插件只用到它的三个语义：getSnapshot 返回**稳定引用**（React 的
		 * useSyncExternalStore 要求，每次都新建对象会无限渲染）、subscribe 监听、
		 * set 立即同步通知 —— 本插件的状态唯一来源是 registry/ledger，store 只是
		 * 「UI 读得到 + 变了就通知」的广播层，不需要 Immer/持久化/动作中间件。
		 */
		function createSnapshotStore(initial) {
			var state = initial;
			var listeners = new Set();
			return {
				getSnapshot: function () { return state; },
				subscribe: function (listener) {
					listeners.add(listener);
					return function () { listeners.delete(listener); };
				},
				set: function (next) {
					state = next;
					var snapshot = Array.from(listeners);
					for (var i = 0; i < snapshot.length; i++) {
						try { snapshot[i](); } catch (error) { console.error("[dsh-pending-session] store listener failed:", error); }
					}
				}
			};
		}

		// ---------------------------------------------------------------- 常量
		var NS = "pending";
		var DEFAULT_NAME = "待执行";
		var BUILD = "0.1.0-r33";
		var JOURNAL_KEY = "dsh.pending-session.journal.v1";
		/** 名称账本：sessionId -> { name, createdAt }，与注册表分开持久化。
		 *  注册表条目一旦被清空/重建（收养、重启时序等），名字与创建时间仍能恢复。 */
		var LEDGER_KEY = "dsh.pending-session.names.v1";
		/** 我们自己的删除端点（宿主半边 index.js 实现）：删存储目录 + rdb 行 +
		 *  工作区记账，不做「宿主是否持有」的保护判定（第三方会因此拒绝删刚看过的会话）。
		 *  不可用时不再调用任何第三方删除接口，直接退回 DSH 原生归档（见 archiveFallback）。 */
		var OWN_DELETE_PATH = "api/dsh-pending-session/delete";
		var OWNER_KEY = "dsh.pending-session.owner.v1";
		var BOOT_TOKEN = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
		var LS_REGISTRY = "dsh.pending-session.registry.v1";
		var LS_ACTIVE = "dsh.pending-session.active.v1";
		var CONVERSATION_KEY = "dsh.conversation.";
		var IDB_NAME = "dsh-pending-session";
		var IDB_STORE = "attachments";
		var MAX_ATTACHMENT_BYTES = 64 * 1024 * 1024; // 单附件上限 64MB（超限只留占位项，见 draftManifest）
		var DEBOUNCE_MS = 400;
		var SWEEP_MS = 2000;
		/** 正式删除前轮询本地引用归零的最大次数（切走主会话后通常在数百毫秒内释放）。 */
		var DELETE_ATTEMPTS = 20;
		/** 正式删除前要求本地引用归零的等待窗口：约 5s 内轮询（拿不到释放就不删）。
		 *  窗口必须容得下「切走主会话」的异步 RPC —— uiWorkspace.startSession 是
		 *  发起即返回，宿主繁忙时 1.5s 内新主会话还没就位，会误报「仍被进程持有」。 */
		var DELETE_RELEASE_WINDOW_MS = 5000;
		/** 普通会话被宿主报 not-found 时的原因码（交给确认框显示，不谎报成功）。 */
		var NO_STORAGE_REASON = "no-storage";
		/** 宿主删除端点不可用时退回原生归档的原因码：归档 ≠ 删除，绝不谎报成功。 */
		var ARCHIVE_REASON = "archive";
		/** 这些原因码原样交给确认框：追加引用来源会把它弄花，文案就走错分支。 */
		var VERBATIM_REASONS = [NO_STORAGE_REASON, ARCHIVE_REASON, "archive-error", "missing-seam", "disposed", "running", "not-owner"];

		// ---------------------------------------------------------------- 词典
		var zh = {
			"badge.aria": "待执行",
			"menu.rename": "重命名待执行",
			"menu.delete": "删除待执行",
			"menu.deleteSession": "删除会话",
			"banner.label": "待执行",
			"banner.hint": "发送即转正为普通对话",
			"banner.created": "创建于",
			"action.rename": "重命名",
			"action.delete": "删除",
			"dialog.title": "重命名待执行",
			"dialog.cancel": "取消",
			"dialog.confirm": "确定",
			"dialog.close": "关闭",
			"dialog.field": "名称",
			"dialog.deleteTitle": "删除会话",
			"dialog.deleteBody": "会话日志、投影缓存与工作区记录都会被清除，且无法恢复。",
			"dialog.deleteConfirm": "删除",
			"dialog.deleteBlocked": "删除被拒绝：会话仍被 DSH 进程持有，请先切换到其他会话（或重启 DSH）后再试。",
			"dialog.deleteRunning": "该会话正在运行（agent 输出中），请先停止它再删除。",
			"dialog.deleteNotOwner": "另一个 dsh 窗口正在管理待执行，请在那个窗口操作。",
			"dialog.deleteNoStorage": "删除被拒绝：磁盘上找不到该会话的存储（可能早已不存在）。",
			"dialog.deleteStorageError": "删除失败：读写会话存储出错，稍后再试。",
			"dialog.deleteDisposed": "删除已取消：插件刚被卸载/热更新，请重试。",
			"dialog.deleteArchived": "⚠️ 宿主删除端点不可用，已按归档处理（会话仍在，可在归档会话里找回）；重启 dsh 后可真正删除。",
			"dialog.deleteArchiveFailed": "删除失败：宿主删除端点不可用，退回系统原生归档也没成功，请稍后重试。",
			"banner.oversize": "⚠️ 有 {n} 个附件过大未保存"
		};
		var en = {
			"badge.aria": "Pending",
			"menu.rename": "Rename pending",
			"menu.delete": "Delete pending",
			"menu.deleteSession": "Delete conversation",
			"banner.label": "Pending",
			"banner.hint": "Send to turn it into a normal conversation",
			"banner.created": "Created",
			"action.rename": "Rename",
			"action.delete": "Delete",
			"dialog.title": "Rename pending",
			"dialog.cancel": "Cancel",
			"dialog.confirm": "OK",
			"dialog.close": "Close",
			"dialog.field": "Name",
			"dialog.deleteTitle": "Delete conversation",
			"dialog.deleteBody": "The session log, projection cache and workspace record will be removed. This cannot be undone.",
			"dialog.deleteConfirm": "Delete",
			"dialog.deleteBlocked": "Deletion refused: the session is still held by the DSH process. Switch to another session (or restart DSH) and retry.",
			"dialog.deleteRunning": "This session is currently running. Stop it before deleting.",
			"dialog.deleteNotOwner": "Another dsh window is managing Pending items — please do it in that window.",
			"dialog.deleteNoStorage": "Deletion refused: no stored data for this session could be found on disk (it may already be gone).",
			"dialog.deleteStorageError": "Deletion failed: reading or writing the session store failed. Please retry later.",
			"dialog.deleteDisposed": "Deletion cancelled: the plugin was just unloaded or hot-reloaded. Please retry.",
			"dialog.deleteArchived": "⚠️ The host delete endpoint is unavailable, so this was handled as archive (the session still exists and can be restored from archived sessions); restart dsh to delete it for real.",
			"dialog.deleteArchiveFailed": "Deletion failed: the host delete endpoint is unavailable and the native archive fallback also failed. Please retry.",
			"banner.oversize": "⚠️ {n} attachment(s) too large to save"
		};

		// ---------------------------------------------------------------- 样式
		var CSS = [
			".dps-dock{box-sizing:border-box;width:calc(100% - 2*var(--dsh-composer-side-clearance,0px) - 4*var(--dsh-composer-dock-inset,0px));margin:0 auto}",
			".dps-bar{box-sizing:border-box;width:100%;max-width:calc(var(--dsh-composer-card-max-width,800px) - 4*var(--dsh-composer-dock-inset,0px));margin:0 auto;height:34px;display:flex;align-items:center;gap:8px;padding:0 6px 0 12px;border-radius:var(--dsw-radius-md);border:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-specific-menu);color:var(--dsw-alias-label-primary);font-size:12px;line-height:20px;box-shadow:var(--dsw-elevation-panel)}",
			".dps-glyph{flex:none;display:inline-flex;color:var(--dsw-alias-label-tertiary)}",
			".dps-label{flex:none;font-weight:500}",
			".dps-name{flex:none;max-width:40%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary-dimmed)}",
			".dps-meta{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary)}",
			".dps-oversize{box-sizing:border-box;width:100%;max-width:calc(var(--dsh-composer-card-max-width,800px) - 4*var(--dsh-composer-dock-inset,0px));margin:2px auto 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}",
			".dps-actions{flex:none;display:flex;align-items:center;gap:2px}",
			".dps-iconBtn{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border:0;background:transparent;border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-tertiary);cursor:pointer;padding:0}",
			".dps-iconBtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
			".dps-iconBtn:disabled{opacity:.5;cursor:default}",
			".dps-renameInput{box-sizing:border-box;width:100%;height:32px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);padding:0 10px;font-size:13px;line-height:20px;outline:none}",
			".dps-renameInput:focus{border-color:var(--dsw-alias-state-business-primary)}",
			".dps-leading{display:inline-flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-tertiary)}",
			".dps-deleteBody{display:flex;flex-direction:column;gap:6px;font-size:13px;line-height:1.6}",
			".dps-deleteName{font-weight:600;word-break:break-all}",
			".dps-deleteError{color:var(--dsw-alias-label-error, #d92d20);font-size:12px;line-height:1.5}",
			".dps-deleteHint{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary)}"
		].join("\n");
		var styleTagId = "dsh-pending-session/style";
		/** 本实例插进 <head> 的样式标签（dispose 时摘掉，见 apply 的清理 effect）。 */
		var styleElement = null;
		/**
		 * 注入插件样式。必须在 apply 里调用、并把摘除挂进 ctx.effect —— 样式是页面级
		 * 资源，factory 作用域只加不删会把 CSS 永久留在已禁用/已卸载的插件页面里。
		 * @returns 摘除函数（未注入时为空操作）
		 */
		function insertStyles() {
			if (typeof document === "undefined" || document.head === undefined) return function () {};
			if (styleElement !== null) return function () {};
			var existing = null;
			try { existing = document.querySelector("style[data-plugin-css=" + JSON.stringify(styleTagId) + "]"); } catch (_eq) { existing = null; }
			if (existing !== null && existing !== undefined) return function () {};
			try {
				var styleTag = document.createElement("style");
				styleTag.dataset.plugin = "dsh-pending-session";
				styleTag.dataset.pluginCss = styleTagId;
				styleTag.textContent = CSS;
				document.head.appendChild(styleTag);
				styleElement = styleTag;
			} catch (error) {
				// 样式注入失败不影响功能：组件不依赖这些类名也能用（只损失外观）
				warnOnce("styles", "插件样式注入失败（界面沿用宿主默认样式）", error);
				return function () {};
			}
			return function () {
				try {
					if (styleElement !== null && styleElement.parentNode !== null) styleElement.parentNode.removeChild(styleElement);
				} catch (_er) { /* ignore */ }
				styleElement = null;
			};
		}

		// ---------------------------------------------------------------- 小工具
		function tryRun(fn) {
			try { return fn(); } catch (_e) { return undefined; }
		}

		/**
		 * 首次失败才告警：tryRun / 裸 catch 会把真实故障吞掉（功能静默不可用），
		 * 完全不吭声根本查不出来；但轮询路径每秒都在重试，每次都喊又会刷屏。
		 * 每个 key 只喊一次，带上 BUILD 便于对照版本。
		 */
		var warnedOnce = new Set();
		function warnOnce(key, message, error) {
			if (warnedOnce.has(key)) return;
			warnedOnce.add(key);
			try {
				var head = "[dsh-pending-session] " + BUILD + " " + key + ": " + message;
				if (error === undefined) console.warn(head);
				else console.warn(head, error);
			} catch (_e) { /* 告警失败不影响功能 */ }
		}

		function isQualified(text, manifest) {
			return (typeof text === "string" && text.trim() !== "") || (Array.isArray(manifest) && manifest.length > 0);
		}

		/** 会话 id 的规范拼写：DSH 存储里 `session-<uuid>` 与裸 `<uuid>` 两种都存在。 */
		function canonicalSessionId(id) {
			return id.indexOf("session-") === 0 ? id : "session-" + id;
		}

		function sameManifest(left, right) {
			if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
			for (var i = 0; i < left.length; i++) {
				if (left[i].aid !== right[i].aid || left[i].size !== right[i].size) return false;
			}
			return true;
		}

		function formatTime(ts) {
			try { return new Date(ts).toLocaleString(); } catch (_e) { return ""; }
		}

		// ---------------------------------------------------------------- IndexedDB（附件字节）
		var idbPromise = null;
		function openIdb() {
			if (idbPromise !== null) return idbPromise;
			idbPromise = new Promise(function (resolve, reject) {
				try {
					var req = indexedDB.open(IDB_NAME, 1);
					req.onupgradeneeded = function () {
						try {
							if (!req.result.objectStoreNames.contains(IDB_STORE)) req.result.createObjectStore(IDB_STORE);
						} catch (_e) { /* ignore */ }
					};
					req.onsuccess = function () { resolve(req.result); };
					req.onerror = function () { reject(req.error || new Error("indexedDB open failed")); };
				} catch (error) { reject(error); }
			});
			return idbPromise;
		}
		function idbPut(key, value) {
			return openIdb().then(function (db) {
				return new Promise(function (resolve, reject) {
					var tx = db.transaction(IDB_STORE, "readwrite");
					var store = tx.objectStore(IDB_STORE);
					store.put(value, key);
					tx.oncomplete = function () { resolve(); };
					tx.onerror = function () { reject(tx.error || new Error("idb put failed")); };
				});
			});
		}
		function idbGet(key) {
			return openIdb().then(function (db) {
				return new Promise(function (resolve, reject) {
					var tx = db.transaction(IDB_STORE, "readonly");
					var req = tx.objectStore(IDB_STORE).get(key);
					req.onsuccess = function () { resolve(req.result); };
					req.onerror = function () { reject(req.error || new Error("idb get failed")); };
				});
			});
		}
		function idbDelete(key) {
			return openIdb().then(function (db) {
				return new Promise(function (resolve, reject) {
					var tx = db.transaction(IDB_STORE, "readwrite");
					var store = tx.objectStore(IDB_STORE);
					store.delete(key);
					tx.oncomplete = function () { resolve(); };
					tx.onerror = function () { reject(tx.error || new Error("idb delete failed")); };
				});
			});
		}

		// ---------------------------------------------------------------- localStorage 注册表
		function loadRegistry() {
			var entries = {};
			try {
				var raw = localStorage.getItem(LS_REGISTRY);
				if (raw !== null) {
					var parsed = JSON.parse(raw);
					if (parsed && typeof parsed === "object" && parsed.entries && typeof parsed.entries === "object") {
						entries = parsed.entries;
					}
				}
			} catch (error) {
				console.error("[dsh-pending-session] registry load failed:", error);
			}
			return { entries: entries };
		}
		function saveRegistry(registry) {
			if (!owned()) return;
			try {
				localStorage.setItem(LS_REGISTRY, JSON.stringify({ entries: registry.entries }));
				// journal 只记条目数：把全部 session id 写进去会让 journal 迅速膨胀，
				// 也会把用户数据留得更久（排查用不到逐个 id）
				journalPush({ op: "save", count: Object.keys(registry.entries).length });
			} catch (error) {
				console.error("[dsh-pending-session] registry save failed:", error);
			}
		}
		function loadActive() {
			try {
				var raw = localStorage.getItem(LS_ACTIVE);
				if (raw === null) return null;
				var parsed = JSON.parse(raw);
				if (parsed && typeof parsed === "object" && typeof parsed.sessionId === "string") return parsed;
			} catch (_e) { /* ignore */ }
			return null;
		}
		/** 最近一次写进 active 镜像的会话 id：用于确认非空白会话时定点清理记录。 */
		var lastActiveId = null;
		function saveActive(value) {
			if (!owned()) return;
			try {
				if (value === null || value === undefined) {
					localStorage.removeItem(LS_ACTIVE);
					lastActiveId = null;
				} else {
					localStorage.setItem(LS_ACTIVE, JSON.stringify(value));
					if (typeof value.sessionId === "string") lastActiveId = value.sessionId;
				}
			} catch (_e) { /* ignore */ }
		}
		function writeConversationDraft(sessionId, text) {
			if (!owned()) return;
			try {
				// 只覆盖 draft：原生 conversation store 把 view/viewRequest 也存在同一个键里，
				// 整体重写会把原生 UI 状态清成 null。解析不了才退回完整结构。
				var parsed = null;
				try {
					var raw = localStorage.getItem(CONVERSATION_KEY + sessionId);
					parsed = raw === null ? null : JSON.parse(raw);
				} catch (_ep) { parsed = null; }
				var next = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
					? Object.assign({}, parsed, { draft: text })
					: { draft: text, view: null, viewRequest: null };
				localStorage.setItem(CONVERSATION_KEY + sessionId, JSON.stringify(next));
			} catch (_e) { /* ignore */ }
		}
		function clearConversationDraft(sessionId) {
			if (!owned()) return;
			try { localStorage.removeItem(CONVERSATION_KEY + sessionId); } catch (_e) { /* ignore */ }
		}
		/** 读取原生 conversation store 持久化的草稿文本（localStorage）。 */
		function readStoredDraft(sessionId) {
			try {
				var raw = localStorage.getItem(CONVERSATION_KEY + sessionId);
				if (raw === null) return null;
				var parsed = JSON.parse(raw);
				return parsed && typeof parsed.draft === "string" ? parsed.draft : null;
			} catch (_e) { return null; }
		}
		/** 取证日志：每次条目增删改都记录原因，便于定位异常。
		 *  历史版本把会话名（用户内容）写进了 journal；载入时统一剥掉，只留长度 ——
		 *  否则用户改过名的旧记录会永久留在 localStorage 里。 */
		function loadJournal() {
			try {
				var raw = localStorage.getItem(JOURNAL_KEY);
				if (raw === null) return [];
				var parsed = JSON.parse(raw);
				if (!Array.isArray(parsed)) return [];
				var scrubbed = false;
				for (var i = 0; i < parsed.length; i++) {
					var entry = parsed[i];
					if (entry !== null && typeof entry === "object" && typeof entry.name === "string") {
						entry.nameLen = entry.name.length;
						delete entry.name;
						scrubbed = true;
					}
				}
				if (scrubbed) {
					try { localStorage.setItem(JOURNAL_KEY, JSON.stringify(parsed)); } catch (_ew) { /* ignore */ }
				}
				return parsed;
			} catch (_e) { return []; }
		}
		var journal = loadJournal();
		/** 名称账本（见 LEDGER_KEY 注释）。 */
		function loadLedger() {
			try {
				var raw = localStorage.getItem(LEDGER_KEY);
				if (raw === null) return {};
				var parsed = JSON.parse(raw);
				return parsed !== null && typeof parsed === "object" ? parsed : {};
			} catch (_e) { return {}; }
		}
		function saveLedger(ledger) {
			if (!owned()) return;
			try { localStorage.setItem(LEDGER_KEY, JSON.stringify(ledger)); } catch (_e) { /* ignore */ }
		}
		/** 记住一个条目的名字与创建时间（改名、创建、收养都调用）。 */
		function rememberName(ledger, sessionId, name, createdAt) {
			try {
				if (typeof sessionId !== "string" || sessionId === "") return;
				var known = ledger[sessionId];
				ledger[sessionId] = {
					name: typeof name === "string" && name.trim() !== "" ? name : (known && known.name) || DEFAULT_NAME,
					createdAt: typeof createdAt === "number" && createdAt > 0 ? createdAt : (known && known.createdAt) || Date.now()
				};
				saveLedger(ledger);
			} catch (_e) { /* ignore */ }
		}
		/** 读取账本里的名字/创建时间（不存在则返回 undefined）。 */
		function ledgerOf(ledger, sessionId) {
			try {
				var known = ledger[sessionId];
				return known !== null && typeof known === "object" ? known : undefined;
			} catch (_e) { return undefined; }
		}
		/**
		 * 所有权令牌：HMR 重挂载/多实例并存时，只有最新 apply 的实例可以写盘。
		 * 旧实例（可能持陈旧注册表）的写操作一律作废，防止整体覆盖丢失条目。
		 */
		function claimOwnership() {
			try { localStorage.setItem(OWNER_KEY, BOOT_TOKEN); } catch (_e) { /* ignore */ }
		}
		function owned() {
			try { return localStorage.getItem(OWNER_KEY) === BOOT_TOKEN; } catch (_e) { return true; }
		}
		function journalPush(entry) {
			if (!owned()) return;
			try {
				var safe = Object.assign({ t: Date.now(), build: BUILD }, entry);
				// journal 长期留在 localStorage：名字是用户内容（用户起的标题），
				// 一律不写原文，只留长度 —— 调用方照旧传 name，在这里统一转义，
				// 免得漏掉某个入口又把用户内容写进去
				if (typeof safe.name === "string") safe.nameLen = safe.name.length;
				delete safe.name;
				journal.push(safe);
				if (journal.length > 300) journal.splice(0, journal.length - 300);
				localStorage.setItem(JOURNAL_KEY, JSON.stringify(journal));
			} catch (_e) { /* ignore */ }
		}

		// ---------------------------------------------------------------- 组件
		/** 打开待执行条目时显示在输入框上方的横幅（重命名 / 删除 / 提示）。 */
		var PendingBanner = React.memo(function PendingBanner(props) {
			var sessionId = props.sessionId;
			var useInput = props.useInput;
			var inputActions = props.inputActions;
			var usePending = props.usePending;
			var openRename = props.openRename;
			var deletePending = props.deletePending;
			var restorePending = props.restorePending;
			var t = props.t;

			var entry = usePending(function (s) { return s.entries[sessionId]; });
			var draftValue = useInput(function (s) { return s.draft; });
			var seededRef = React.useRef(false);

			React.useEffect(function () {
				if (entry === undefined || seededRef.current) return;
				seededRef.current = true;
				// 文本：输入框为空时按注册表播种（原生机制通常已恢复，这里兜底）
				if (draftValue === "" && entry.text !== "") {
					try { inputActions.setDraft(entry.text); } catch (_e) { /* ignore */ }
				}
				// 附件：按注册表恢复（IndexedDB 字节 → 新草稿附件）
				restorePending(sessionId, entry);
			}, [entry === undefined ? null : entry.sessionId]);

			if (entry === undefined) return null;
			// 超过 64MB 的附件只留占位项（missing），字节不在本地：横幅上直说，
			// 免得用户以为附件还在、发送时才发现少了东西
			var oversize = 0;
			if (Array.isArray(entry.attachments)) {
				for (var oi = 0; oi < entry.attachments.length; oi++) {
					if (entry.attachments[oi] !== null && entry.attachments[oi].missing === true) oversize += 1;
				}
			}
			return React.createElement("div", { className: "dps-dock", "data-pending-banner": "" },
				React.createElement("div", { className: "dps-bar" },
					React.createElement("span", { className: "dps-glyph" },
						React.createElement(primitives.IconClockOutlineRegular, { size: 14 })),
					React.createElement("span", { className: "dps-label" }, t("banner.label")),
					React.createElement("span", { className: "dps-name", title: entry.name }, entry.name),
					React.createElement("span", { className: "dps-meta" },
						t("banner.created") + " " + formatTime(entry.createdAt) + " · " + t("banner.hint")),
					React.createElement("div", { className: "dps-actions" },
						React.createElement(primitives.Tooltip, {
							portal: true,
							label: t("action.rename"),
							side: "bottom",
							delayMs: 500,
							children: React.createElement("button", {
								type: "button",
								className: "dps-iconBtn",
								"aria-label": t("action.rename"),
								onClick: function () { openRename(sessionId, entry.name); },
								children: React.createElement(primitives.IconEditOutlineRegular, { size: 14 })
							})
						}),
						React.createElement(primitives.Tooltip, {
							portal: true,
							label: t("action.delete"),
							side: "bottom",
							delayMs: 500,
							children: React.createElement("button", {
								type: "button",
								className: "dps-iconBtn",
								"aria-label": t("action.delete"),
								onClick: function () { deletePending(sessionId, entry.name); },
								children: React.createElement(primitives.IconTrashOutlineRegular, { size: 14 })
							})
						})
					)
				),
				oversize === 0 ? null : React.createElement("div", { className: "dps-oversize" },
					t("banner.oversize").replace("{n}", String(oversize)))
			);
		});

		/** 侧边栏行首的时钟角标（仅待执行条目显示）。 */
		var PendingRowLeading = React.memo(function PendingRowLeading(props) {
			var sessionId = props.sessionId;
			var usePending = props.usePending;
			var t = props.t;
			var isPending = usePending(function (s) { return s.entries[sessionId] !== undefined; });
			if (!isPending) return null;
			return React.createElement("span", { className: "dps-leading", "aria-label": t("badge.aria"), title: t("badge.aria") },
				React.createElement(primitives.IconClockOutlineRegular, { size: 14 }));
		});

		/** 行「…」菜单：删除会话（对待执行条目同样适用；真删除，带确认框）。 */
		var DeleteSessionMenuItem = React.memo(function DeleteSessionMenuItem(props) {
			var sessionId = props.sessionId;
			var displayTitle = props.displayTitle;
			var useMenuOpenState = props.useMenuOpenState;
			var usePending = props.usePending;
			var requestDelete = props.requestDelete;
			var t = props.t;
			var setMenuOpenState = useMenuOpenState()[1];
			var pendingEntry = usePending(function (s) { return s.entries[sessionId]; });
			if (typeof sessionId !== "string" || sessionId === "") return null;
			return React.createElement(primitives.MenuItemButton, {
				icon: React.createElement(primitives.IconTrashOutlineRegular, {}),
				onSelect: function () {
					setMenuOpenState(false);
					requestDelete(sessionId, pendingEntry !== undefined ? pendingEntry.name : (displayTitle || ""));
				},
				children: t(pendingEntry !== undefined ? "menu.delete" : "menu.deleteSession")
			});
		});

		/** 删除失败原因码 → 词典键：按原因给对应的实话，不要一律说「被进程持有」。 */
		function deleteReasonKey(reason) {
			if (reason === "running") return "dialog.deleteRunning";
			if (reason === "not-owner") return "dialog.deleteNotOwner";
			if (reason === NO_STORAGE_REASON) return "dialog.deleteNoStorage";
			if (reason === "storage-error") return "dialog.deleteStorageError";
			if (reason === "disposed") return "dialog.deleteDisposed";
			if (reason === ARCHIVE_REASON) return "dialog.deleteArchived";
			if (reason === "archive-error" || reason === "missing-seam") return "dialog.deleteArchiveFailed";
			return "dialog.deleteBlocked";
		}

		/** 删除确认对话框（shell.overlay）：破坏性操作必须显式确认。 */
		var DeleteConfirmDialog = React.memo(function DeleteConfirmDialog(props) {
			var usePending = props.usePending;
			var request = usePending(function (s) { return s.deleteRequest; });
			if (request === null || request === undefined) return null;
			return React.createElement(DeleteConfirmForm, {
				key: request.sessionId,
				request: request,
				settleDelete: props.settleDelete,
				commitDelete: props.commitDelete,
				t: props.t
			});
		});

		var DeleteConfirmForm = React.memo(function DeleteConfirmForm(props) {
			var request = props.request;
			var settleDelete = props.settleDelete;
			var commitDelete = props.commitDelete;
			var t = props.t;
			var busyState = React.useState(false);
			var busy = busyState[0];
			var setBusy = busyState[1];
			var errorState = React.useState(null);
			var error = errorState[0];
			var setError = errorState[1];
			var close = function () {
				if (busy) return;
				settleDelete();
			};
			var confirm = function () {
				if (busy) return;
				setBusy(true);
				setError(null);
				Promise.resolve().then(function () {
					return commitDelete(request.sessionId);
				}).then(function (outcome) {
					setBusy(false);
					if (outcome !== undefined && outcome.deleted === false) {
						// 没删成（仍被进程持有 / 正在运行 / 端点不可用只能归档）：留在对话框里说明原因。
						// 归档尤其不能静默当成功 —— 用户会以为删干净了，实际会话还在；
						// 这里刻意不自动关框（关掉就没有任何地方能把这个结果告诉用户了），
						// 用户读完按「取消」/关闭即可，重启 dsh 后再删一次。
						setError(outcome.reason || "unknown");
						return;
					}
					settleDelete();
				}).catch(function (reason) {
					setBusy(false);
					setError(reason instanceof Error ? reason.message : String(reason));
				});
			};
			// 归档不是失败：用提示样式（而非红色错误）说明「已按归档处理」
			var archived = error === ARCHIVE_REASON;
			return React.createElement(primitives.Modal, {
				open: true,
				onClose: close,
				closeLabel: t("dialog.close"),
				title: t("dialog.deleteTitle"),
				footer: React.createElement(React.Fragment, null,
					React.createElement(primitives.Button, { variant: "outline", disabled: busy, onClick: close }, t("dialog.cancel")),
					React.createElement(primitives.Button, { variant: "primary", disabled: busy, onClick: confirm }, t("dialog.deleteConfirm"))),
				children: React.createElement("div", { className: "dps-deleteBody" },
					request.title !== undefined && request.title !== ""
						? React.createElement("div", { className: "dps-deleteName" }, request.title)
						: null,
					React.createElement("div", null, t("dialog.deleteBody")),
					error === null ? null : React.createElement("div", { className: archived ? "dps-deleteHint" : "dps-deleteError" },
						archived
							? t("dialog.deleteArchived")
							: t(deleteReasonKey(error)) + " (" + error + ")"))
			});
		});

		/** 重命名对话框（shell.overlay）：包装层只做路由；表单按请求 key 全新挂载，
		 *  草稿在挂载时从请求播种（与 DSH 原生 RenameForm 同款，不依赖 effect）。 */
		var PendingRenameDialog = React.memo(function PendingRenameDialog(props) {
			var usePending = props.usePending;
			var request = usePending(function (s) { return s.renameRequest; });
			if (request === null) return null;
			return React.createElement(PendingRenameForm, {
				key: request.sessionId,
				request: request,
				settleRename: props.settleRename,
				commitRename: props.commitRename,
				t: props.t
			});
		});

		/** 单个请求的表单：草稿从请求播种，提交中/错误状态随请求结束一起消失。 */
		var PendingRenameForm = React.memo(function PendingRenameForm(props) {
			var request = props.request;
			var settleRename = props.settleRename;
			var commitRename = props.commitRename;
			var t = props.t;
			var draftState = React.useState(typeof request.name === "string" ? request.name : "");
			var draft = draftState[0];
			var setDraft = draftState[1];
			var busyState = React.useState(false);
			var renaming = busyState[0];
			var setRenaming = busyState[1];
			var trimmed = (draft || "").trim();
			var blocked = renaming || trimmed === "";
			var close = function () {
				if (renaming) return;
				settleRename();
			};
			var confirm = function () {
				if (blocked) return;
				setRenaming(true);
				Promise.resolve().then(function () {
					return commitRename(request.sessionId, trimmed);
				}).catch(function (_e) { /* ignore */ }).then(function () {
					setRenaming(false);
					settleRename();
				});
			};
			return React.createElement(primitives.Modal, {
				open: true,
				onClose: close,
				closeLabel: t("dialog.close"),
				title: t("dialog.title"),
				footer: React.createElement(React.Fragment, null,
					React.createElement(primitives.Button, { variant: "outline", disabled: renaming, onClick: close }, t("dialog.cancel")),
					React.createElement(primitives.Button, { variant: "primary", disabled: blocked, onClick: confirm }, t("dialog.confirm"))),
				children: React.createElement("input", {
					className: "dps-renameInput",
					value: draft,
					"aria-label": t("dialog.field"),
					"data-modal-autofocus": true,
					disabled: renaming,
					onFocus: function (e) { try { e.target.select(); } catch (_e) { /* ignore */ } },
					onChange: function (e) { setDraft(e.target.value); },
					onKeyDown: function (e) {
						if (e.key === "Enter") confirm();
						if (e.key === "Escape") close();
					}
				})
			});
		});

		// ---------------------------------------------------------------- 插件主体
		var APPLIED = false;
		function apply(ctx) {
			if (APPLIED) return;
			var sessions = ctx.sessions;
			var workspaces = ctx.workspaces;
			var slots = ctx.slots;
			var locale = ctx.locale;
			if (!sessions || !workspaces || !slots || !locale) {
				// 依赖没就绪就**不能**置位 APPLIED：否则后续重试（connection/reset、HMR、
				// 宿主晚挂）全被短路，插件到页面刷新为止都不会再注册，而且毫无提示
				warnOnce("apply:deps", "客户端服务未就绪（sessions/workspaces/slots/locale）：本次不注册，等重试", undefined);
				return;
			}
			APPLIED = true;
			claimOwnership();
			// 外部探针（排障脚本/用户）会读这个键确认当前页面跑的是哪个 build，保留。
			try { localStorage.setItem("dsh.pending-session.build", BUILD); } catch (_e) { /* ignore */ }

			ctx.effect(function () { return locale.register(NS, { zh: zh, en: en }); }, "dsh-pending-session: dictionaries");

			// 插件样式随 apply 注入、随 dispose 摘掉（页面级资源归 ctx.effect 管）
			var removeStyles = insertStyles();
			ctx.effect(function () { return removeStyles; }, "dsh-pending-session: styles");

			// ---- 卸载/热更新门闸 ----
			// dispose 之后旧实例必须彻底停手：否则延迟续跑（转正改名、附件恢复重试、
			// 删除重试链）还会动盘、动宿主，与新实例打架。
			var disposed = false;
			var timerIds = new Set(); // 登记本实例排的 setTimeout，dispose 时统一清掉
			/** 登记式 setTimeout：dispose 后不再续跑，定时器也不会悬挂。 */
			function schedule(fn, ms) {
				if (disposed) return 0;
				var id = setTimeout(function () {
					timerIds.delete(id);
					if (disposed) return;
					try { fn(); } catch (error) {
						console.error("[dsh-pending-session] scheduled task failed:", error);
					}
				}, ms);
				timerIds.add(id);
				return id;
			}
			/** 登记式等待：dispose 会清掉计时器，等待中的续跑就此停住（不会再动盘、动宿主）。 */
			function wait(ms) {
				return new Promise(function (resolve) {
					if (disposed) { resolve(); return; }
					schedule(resolve, ms);
				});
			}

			// ---- 状态 ----
			var registry = loadRegistry(); // { entries: { [sessionId]: entry } }（可变，不进 store）
			var ledger = loadLedger(); // sessionId -> { name, createdAt }（名字/时间的事实来源）
			var activeMirror = { value: null }; // 当前主会话的实时草稿镜像（内存，同步更新）
			/** 刚被我们删掉的会话 id：投影里直接摘掉，界面立刻生效（宿主内存里的残影等重启自然消失）。 */
			var removedIds = new Set();
			var state = createSnapshotStore({ entries: {}, renameRequest: null, deleteRequest: null }); // UI 只读快照

			/** 发布 UI 快照；patch 里给出的字段被改写，其余保持不变。 */
			function publishState(patch) {
				var snap = state.getSnapshot();
				state.set(Object.assign({
					entries: Object.assign({}, registry.entries),
					renameRequest: snap.renameRequest,
					deleteRequest: snap.deleteRequest
				}, patch || {}));
			}
			publishState();

			// 退出时活动新会话的合格草稿 → 启动即转待执行（规则 8）
			// 注意不能在这里直接登记：启动瞬间会话列表还没就绪、宿主投影也没物化，
			// 两条「空白」证据都拿不到 —— 旧实现正是因此把普通会话也当成待执行。
			// 改成先挂起、等列表就绪（onListChange）且确认空白后再登记。
			var activeAtExit = loadActive();
			var pendingExitActive = activeAtExit !== null && typeof activeAtExit.sessionId === "string" &&
				isQualified(activeAtExit.text, activeAtExit.manifest)
				? activeAtExit
				: null;
			var applyExitActive = function () {
				if (pendingExitActive === null) return false;
				var sid = pendingExitActive.sessionId;
				var state = isBlankSession(sid);
				if (state === false) {
					// 只有「宿主明确说它不空白」才算证据；列表还没就绪（快照为空）时的
					// 否定是假否定，必须留着等下一次列表变化，否则每次启动都白扔镜像。
					if (hostBlank(sid) !== false) return false;
					pendingExitActive = null;
					activeMirror.value = null;
					saveActive(null);
					journalPush({ op: "skip-non-blank", id: sid, reason: "boot" });
					return false;
				}
				if (state !== true) return false; // 还拿不到证据：留到下一次列表变化再试
				var mirror = { sessionId: sid, savedAt: pendingExitActive.savedAt, text: pendingExitActive.text, manifest: Array.isArray(pendingExitActive.manifest) ? pendingExitActive.manifest : [] };
				var knownExit = ledgerOf(ledger, sid);
				registry.entries[sid] = {
					sessionId: sid,
					createdAt: knownExit !== undefined ? knownExit.createdAt : (typeof pendingExitActive.savedAt === "number" ? pendingExitActive.savedAt : Date.now()),
					name: knownExit !== undefined ? knownExit.name : DEFAULT_NAME,
					text: typeof pendingExitActive.text === "string" ? pendingExitActive.text : "",
					attachments: mirror.manifest,
					workspaceId: workspaceIdOf(sid)
				};
				rememberName(ledger, sid, registry.entries[sid].name, registry.entries[sid].createdAt);
				// 镜像也要接上：否则下一轮 onListChange 的重算会把投影里那条
				// 「正在编辑的新会话」cwd 隔离撤掉，新会话按钮又会复用它
				activeMirror.value = mirror;
				lastSavedManifest = mirror.manifest;
				// 这批字节是上一个页面会话写进 IndexedDB 的，继续挂在这条账上（S1）
				noteMirrorBlobs(sid, mirror.manifest);
				pendingExitActive = null;
				saveActive(null);
				journalPush({ op: "create", id: sid, reason: "exit-active" });
				saveRegistry(registry);
				publishState(null);
				recomputeDerived();
				return true;
			};
			saveActive(null);
			publishState(null);
			journalPush({ op: "boot", entries: Object.keys(registry.entries) });

			// ---- conversation / shell 访问 ----
			function rootConversation() {
				return ctx.get("conversation");
			}
			function shellFor(id) {
				try {
					var scoped = sessions.scope(id);
					if (scoped === undefined) return undefined;
					var conv = scoped.get("conversation");
					if (conv === undefined || !conv.input) return undefined;
					return conv.input.for(scoped);
				} catch (error) {
					// 拿不到输入 shell = 草稿镜像与附件恢复整条链不可用，不能静默
					warnOnce("shellFor", "输入 shell 读取失败（草稿镜像/附件恢复不可用）", error);
					return undefined;
				}
			}
			function readDraft(id) {
				return tryRun(function () {
					var shell = shellFor(id);
					if (shell === undefined) return undefined;
					var snap = shell.state.getSnapshot();
					return { text: snap.draft, attachmentIds: snap.attachmentIds || [] };
				});
			}
			function draftManifest(conv, attachmentIds) {
				var manifest = [];
				var oversize = 0;
				for (var i = 0; i < attachmentIds.length; i++) {
					var aid = attachmentIds[i];
					try {
						var d = conv && conv.draftAttachments ? conv.draftAttachments.get(aid) : undefined;
						if (d === undefined || !d.file) continue;
						var kind = d.kind === "image" ? "image" : "file";
						var name = d.file.name || "attachment";
						// 超过 64MB：字节不落 IndexedDB，但保留占位项（missing）——否则
						// 「只有超大附件的草稿」会被判成不合格、条目根本不建，附件被静默丢弃
						if (typeof d.file.size === "number" && d.file.size > MAX_ATTACHMENT_BYTES) {
							oversize += 1;
							manifest.push({
								aid: "oversize-" + oversize,
								kind: kind,
								name: name,
								mediaType: d.file.type || "",
								size: d.file.size,
								missing: true
							});
						} else {
							manifest.push({
								aid: aid,
								kind: kind,
								name: name,
								mediaType: d.file.type || "",
								size: typeof d.file.size === "number" ? d.file.size : 0
							});
						}
					} catch (_e) { /* skip broken draft */ }
				}
				return manifest;
			}
			function captureBlobs(conv, manifest) {
				if (!conv || !conv.draftAttachments) return Promise.resolve();
				var jobs = [];
				for (var i = 0; i < manifest.length; i++) {
					(function (m) {
						// missing（超限占位项）没有字节可取：它不是被丢弃，而是从来没进过本地缓存
						if (m.missing === true) return;
						jobs.push(tryRun(function () {
							var d = conv.draftAttachments.get(m.aid);
							if (d === undefined || !d.file) return Promise.resolve();
							return d.file.arrayBuffer().then(function (bytes) {
								return idbPut(m.aid, { bytes: bytes, name: m.name, mediaType: m.mediaType, kind: m.kind });
							});
						}) || Promise.resolve());
					})(manifest[i]);
				}
				return Promise.allSettled(jobs).then(function (results) {
					for (var j = 0; j < results.length; j++) {
						if (results[j].status === "rejected") console.error("[dsh-pending-session] blob capture failed:", results[j].reason);
					}
				});
			}
			function dropBlobs(manifest) {
				var jobs = [];
				for (var i = 0; i < manifest.length; i++) {
					// 占位项没写过字节，不必去删（避免多一次无意义的事务）
					if (manifest[i].missing === true) continue;
					(function (aid) {
						jobs.push(idbDelete(aid).catch(function (error) {
							// 回收失败 = 字节永久占着空间（本地存储无限膨胀），不能静默
							warnOnce("dropBlobs", "附件字节回收失败（IndexedDB 删除出错）", error);
						}));
					})(manifest[i].aid);
				}
				return Promise.allSettled(jobs);
			}
			/**
			 * 镜像持有的 aid 记账：sessionId -> aid[]。
			 * 草稿阶段（还没离开、还没成为条目）字节就已经写进 IndexedDB 了；该会话若
			 * 从未变成条目 —— 用户直接发送、之后又删掉它 —— 光靠 registry 里的条目
			 * 没有任何回收路径，字节会永久滞留，且每写一次新草稿就再涨一份。
			 * 记账点与 captureBlobs 同一处（见 startMirroring 的防抖保存），
			 * 所以「记了账」必然对应「字节写过」（取并集，宁可多记不可漏记）。
			 */
			var mirrorBlobs = new Map();
			function noteMirrorBlobs(sessionId, manifest) {
				if (typeof sessionId !== "string" || sessionId === "") return;
				try {
					var known = mirrorBlobs.get(sessionId) || [];
					for (var i = 0; i < manifest.length; i++) {
						if (manifest[i].missing === true) continue; // 占位项没字节
						if (known.indexOf(manifest[i].aid) === -1) known.push(manifest[i].aid);
					}
					if (known.length > 0) mirrorBlobs.set(sessionId, known);
				} catch (_e) { /* ignore */ }
			}
			/** 回收镜像为某会话写下的字节（会话转正/删除/确认没成为条目时调用；重复调用无害）。 */
			function dropMirrorBlobs(sessionId) {
				var known = mirrorBlobs.get(sessionId);
				if (known === undefined) return Promise.resolve([]);
				mirrorBlobs.delete(sessionId);
				var jobs = [];
				for (var i = 0; i < known.length; i++) {
					(function (aid) {
						jobs.push(idbDelete(aid).catch(function (error) {
							warnOnce("dropMirrorBlobs", "镜像附件字节回收失败（IndexedDB 删除出错）", error);
						}));
					})(known[i]);
				}
				return Promise.allSettled(jobs);
			}
			function workspaceIdOf(sessionId) {
				try {
					var items = workspaces.list.getSnapshot().items;
					for (var i = 0; i < items.length; i++) {
						var w = items[i];
						if (Array.isArray(w.sessionIds) && w.sessionIds.indexOf(sessionId) !== -1) return w.workspaceId;
					}
					return undefined;
				} catch (error) {
					// 读不到工作区归属：待执行的 cwd 隔离与「删除后切到哪个工作区」都会失灵
					warnOnce("workspaceIdOf", "工作区列表读取失败：工作区归属不可用", error);
					return undefined;
				}
			}

			/**
			 * 该会话「是不是空白会话」（返回 true/false，拿不到时保守判为 false）。
			 * 只有空白会话才配当待执行条目、才配写 active 镜像：
			 *   - 宿主投影明确 blank=false → 判非空白（普通会话，绝不登记）；
			 *   - 宿主投影没材料化但列表行说 blank=true → 判空白（新会话首次离开时
			 *     常见的「投影还没就绪」）；
			 *   - 两个信号都拿不到 → 判非空白（不写，宁可漏记也不误建）。
			 */
			function isBlankSession(id) {
				if (typeof id !== "string" || id === "") return false;
				var hb = hostBlank(id);
				if (hb === false) return false;
				if (hb === true) return true;
				var row = rawSnapshot().byId[id];
				if (row !== undefined && row.blank === true) return true;
				return false;
			}
			/**
			 * 把（已确认非空白的）会话从 active 镜像里摘掉，避免下次启动反复误建条目。
			 * 以「盘上记录里的 sessionId」为准：HMR/多实例下内存里的 lastActiveId
			 * 可能已经被别的会话改写，只看它会漏清。
			 */
			function cleanupActive(id) {
				try {
					var stored = loadActive();
					if (stored !== null && stored.sessionId === id) saveActive(null);
					if (lastActiveId === id) lastActiveId = null;
				} catch (_e) { /* ignore */ }
			}
			function persistEntry(entry, conv) {
				// 只有空白会话才配当「待执行」条目：普通会话落进注册表会把真实对话记录
				// 投影成 blank:false/title/cwd:"" 的假行，且会被反复误建（不自愈的根因）。
				if (isBlankSession(entry.sessionId) === false) {
					journalPush({ op: "skip-non-blank", id: entry.sessionId, reason: "persist" });
					cleanupActive(entry.sessionId);
					return Promise.resolve();
				}
				var existed = registry.entries[entry.sessionId] !== undefined;
				// 名字/创建时间以账本为准：条目若被清空重建，改名与时间仍能恢复
				var known = ledgerOf(ledger, entry.sessionId);
				if (!existed && known !== undefined) {
					entry = Object.assign({}, entry, { name: known.name || entry.name, createdAt: known.createdAt || entry.createdAt });
				}
				registry.entries[entry.sessionId] = entry;
				saveRegistry(registry);
				publishState();
				writeConversationDraft(entry.sessionId, entry.text);
				rememberName(ledger, entry.sessionId, entry.name, entry.createdAt);
				journalPush({ op: existed ? "update" : "create", id: entry.sessionId, reason: "leave" });
				var capture = captureBlobs(conv, entry.attachments);
				recomputeDerived();
				return capture;
			}
			/**
			 * 物理删除不可用时的回退：DSH 原生归档（可恢复，不会丢数据）。
			 * 归档**不是删除**，绝不能报成功：旧实现返回 deleted:true，调用方只看
			 * deleted!==false 就关对话框，用户看到和真删除一样的结果，实际一个字都没删
			 * （典型触发：装了插件但没重启 dsh → 宿主端点不存在）。这里如实回
			 * deleted:false + reason:"archive"，由确认框显示「已按归档处理」的提示。
			 */
			function archiveFallback(sessionId, detail) {
				journalPush({ op: "archive-fallback", id: sessionId, detail: String(detail || "").slice(0, 120) });
				if (typeof workspaces.archiveSession === "function") {
					return Promise.resolve().then(function () {
						return workspaces.archiveSession(sessionId);
					}).then(function () {
						return { deleted: false, via: "archive", reason: ARCHIVE_REASON };
					}).catch(function (error) {
						console.warn("[dsh-pending-session] archive failed:", error);
						return { deleted: false, via: "archive-failed", reason: "archive-error" };
					});
				}
				return { deleted: false, via: "archive-unavailable", reason: "missing-seam" };
			}
			/**
			 * 会话善后：物理删除（reason === "manual"，用户点删除）走我们自己的宿主端点
			 * （index.js），端点不可用时退回 DSH 原生归档；非手动（规则 10 自动清理）
			 * 一律只归档，可恢复。
			 * 返回 { deleted, via, reason }：deleted=false 表示会话仍在（受保护或已归档），
			 * 调用方据此决定是否清理本地条目——绝不能「会话还在但条目没了」。
			 */
			function disposeSession(sessionId, reason) {
				var physical = reason === "manual";
				if (!physical) return Promise.resolve(archiveFallback(sessionId, "non-manual"));
				return attemptPhysicalDelete(sessionId);
			}
			/** 我们自己的删除器（宿主半边 index.js）。返回 undefined = 端点不可用，退回原生归档。 */
			function ownDelete(sessionId) {
				return Promise.resolve().then(function () {
					if (typeof fetch !== "function") return undefined;
					return fetch(OWN_DELETE_PATH, {
						method: "POST",
						headers: { "content-type": "application/json" },
						// pruneStale：用户明确要求删这一行 → 如果盘上真的已经没有它任何存储，
						// 请把 workspace 记账里的悬空引用一并摘掉（否则界面上那行永远删不掉）
						body: JSON.stringify({ ids: [sessionId], pruneStale: true })
					});
				}).then(function (response) {
					if (response === undefined || response.ok === false) return undefined;
					return response.json().then(function (body) {
						if (body === null || typeof body !== "object" || body.ok !== true || !Array.isArray(body.results)) return undefined;
						var row = null;
						for (var i = 0; i < body.results.length; i++) {
							var item = body.results[i];
							// 两侧都规范化后比较：宿主可能把裸 uuid 回显成 `session-<uuid>`
							// （反之亦然），直接比字符串会让裸 uuid 会话永远匹配不上 →
							// ownDelete 返回 undefined → 真删除被降级成归档，用户还以为是删成功
							if (item !== null && typeof item === "object" && canonicalSessionId(String(item.id)) === canonicalSessionId(sessionId)) {
								row = item;
								break;
							}
						}
						if (row === null) return undefined;
						if (row.status === "ok") {
							journalPush({ op: "own-delete", id: sessionId });
							return { deleted: true, via: "own" };
						}
						if (String(row.reason || "") === "not-found") {
							// 「什么都没删」只有在确实没有存储时才等于成功。宿主只在
							// 「两种拼写的目录都没有 + per-session 投影缓存没有 + 聚合索引里也没有」
							// 时才回 not-found，所以：
							//   - 待执行条目 / 空白会话（本就可能没落盘）→ 算成功；
							//   - 行的存储被外部删掉的悬空引用（点了删除、界面上还留着、点开报
							//     ENOENT）→ 宿主已按我们的 pruneStale 要求把 workspace 记账摘掉，
							//     这里必须跟着把行/条目清掉，否则用户永远删不掉这一行。
							var pruned = row.prunedStale === true;
							if (pruned || treatNotfoundAsSuccess(sessionId)) {
								journalPush({ op: pruned ? "delete-stale-pruned" : "delete-absent", id: sessionId });
								return { deleted: true, via: "absent" };
							}
							journalPush({ op: "delete-no-storage", id: sessionId });
							return { deleted: false, via: "refused", reason: NO_STORAGE_REASON };
						}
						journalPush({ op: "delete-blocked", id: sessionId, reason: String(row.reason || row.status) });
						return { deleted: false, via: "refused", reason: String(row.reason || row.status) };
					});
				}).catch(function () { return undefined; });
			}
			/**
			 * 宿主报 not-found（磁盘上没东西可删）时，能否算删成功：
			 *   待执行条目（用户点过删除的待执行）或空白会话 → 本来就没落盘，算成功；
			 *   普通会话 → 不认（真删除必须真的删掉东西）。
			 */
			function treatNotfoundAsSuccess(sessionId) {
				try {
					if (registry.entries[sessionId] !== undefined) return true;
					if (isBlankSession(sessionId)) return true;
				} catch (_e) { /* ignore */ }
				return false;
			}
			/**
			 * 先用自己的删除器；端点不可用（未装宿主半边 / 非回环 / 响应不是预期结构）
			 * 时退回 DSH 原生归档 —— 与 README 的承诺一致，不再调用任何第三方删除接口。
			 */
			function attemptPhysicalDelete(sessionId) {
				return ownDelete(sessionId).then(function (own) {
					if (own !== undefined) return own;
					return archiveFallback(sessionId, "own-endpoint-unavailable");
				});
			}
			/**
			 * 读某个会话当前被谁持有（客户端本地引用计数，纯读、无副作用）。
			 * 宿主只在本地引用归零后才会释放该会话，所以删除前要等它归零。
			 */
			function retainSources(sessionId) {
				try {
					var info = sessions.retainInfo(sessionId).getSnapshot();
					var by = info !== undefined && info !== null && info.retainedBy ? info.retainedBy : {};
					var parts = [];
					for (var key in by) {
						if (by[key] > 0) parts.push(key + "×" + by[key]);
					}
					return {
						count: info !== undefined && info !== null && typeof info.referenceCount === "number" ? info.referenceCount : 0,
						text: parts.join(",")
					};
				} catch (error) {
					// 读不到引用计数：删除前的「宿主已释放」硬闸门失效，必须吭声
					warnOnce("retainInfo", "会话引用计数读取失败：删除前的宿主释放判定不可用", error);
					return { count: 0, text: "" };
				}
			}
			/** 等本地引用归零（例如切走主会话后 ui-workspace 会释放 mainView 持有）。 */
			function waitRelease(sessionId, attempts) {
				var state = retainSources(sessionId);
				if (state.count === 0 || attempts <= 0 || disposed) return Promise.resolve(state);
				return wait(250).then(function () { return waitRelease(sessionId, attempts - 1); });
			}
			/**
			 * 该会话是否还占着主视图（主会话行）。
			 * 删除「当前正在看的会话」时用来判断「先切走」是否真的生效。
			 */
			function mainStillHere(sessionId) {
				try {
					return mainIdOf(rawSnapshot()) === sessionId;
				} catch (_e) {
					return true; // 读不到就当它还在：宁可少删一次，也不藏掉正在用的那一行
				}
			}
			/**
			 * 硬性要求宿主已释放：约 5s 窗口内轮询本地引用计数（纯读，最多 DELETE_ATTEMPTS
			 * 次），计数没归零就把最后一次读数交回调用方 —— 调用方据此放弃删除。
			 * waitLeave 为真（删的是主会话）时还要等「新主会话就位」：uiWorkspace.startSession
			 * 是发起即返回、RPC 异步完成的，只看调用没抛错会把没切走当成切走了（假成功 →
			 * 投影藏掉用户还在看的那一行）。返回最后一次读数，附 left（是否已不再被主视图持有）。
			 */
			function waitForRelease(sessionId, waitLeave) {
				var deadline = Date.now() + DELETE_RELEASE_WINDOW_MS;
				var poll = function (attempts) {
					return waitRelease(sessionId, 1).then(function (state) {
						var left = !waitLeave || !mainStillHere(sessionId);
						// 引用归零 + 已切走才算等到；次数/时间任一用尽就收手，把现状交回调用方
						if ((state.count === 0 && left) || attempts <= 0 || disposed || Date.now() >= deadline) {
							state.left = left;
							return state;
						}
						return wait(250).then(function () { return poll(attempts - 1); });
					});
				};
				return poll(DELETE_ATTEMPTS);
			}
			/**
			 * 血泪教训（用户实测 A/B 得出）：绝不要为了「让宿主释放会话」而调用
			 * sessions.using/retain。它会把会话在宿主上物化（打开），而释放并不会
			 * 让宿主关闭它 —— 该会话从此永久 attached，之后连删除都会一直失败。
			 * 删除路径只允许只读操作：retainInfo 读引用。
			 */
			/**
			 * 删除一个会话（普通对话或待执行条目都适用）：先切走主会话并确认宿主已
			 * 释放（本地引用归零），再物理删除（我们自己的端点，失败则回退归档），
			 * 最后做本地清理。宿主仍持有时宁可不删，也不动文件。
			 * 非所有者标签页（另一个 dsh 窗口在管待执行）一律拒绝，不动宿主。
			 */
			function performDelete(sessionId) {
				if (!owned()) {
					// 多标签页：失去所有权的标签页仍能走到这里（它自己的 UI 还指着旧状态），
					// 真删的破坏性动作必须直接拒绝，而不是「写盘被挡、删除照发」
					return Promise.resolve({ deleted: false, reason: "not-owner" });
				}
				if (disposed) return Promise.resolve({ deleted: false, reason: "disposed" });
				var wasMain = mainIdOf(rawSnapshot()) === sessionId;
				var targetRow = rawSnapshot().byId[sessionId];
				if (targetRow !== undefined && targetRow.running === true) {
					// 正在跑 agent 的会话：删它的存储会毁掉正在进行的输出，必须先停
					journalPush({ op: "delete-refused-running", id: sessionId });
					return Promise.resolve({ deleted: false, reason: "running" });
				}
				var entry = registry.entries[sessionId];
				var workspaceId = (entry !== undefined && entry.workspaceId) || workspaceIdOf(sessionId);
				var uiWorkspace = ctx.get("uiWorkspace");
				var leaveOk = false; // 「先切走」是否真的执行到位（见下）
				// 不能只看 startSession 没抛错 —— 它是
				// 「发起即返回、RPC 异步完成」，宿主繁忙时那一刻主会话还没换。真正的判据是
				// 「新主会话已就位」（waitForRelease 的 waitLeave），没就位就不能把当前
				// 会话那一行从投影里藏掉。
				var leaveFirst = wasMain && uiWorkspace && typeof uiWorkspace.startSession === "function"
					? Promise.resolve().then(function () {
						try {
							return uiWorkspace.startSession(workspaceId);
						} catch (error) {
							warnOnce("startSession", "删除前切走主会话失败：删除后不隐藏该行", error);
							return undefined;
						}
					}).then(function (started) {
						// 返回 promise 就等它落地（落地 ≠ 已就位，就位仍以主会话 id 为准）
						if (started !== null && typeof started === "object" && typeof started.then === "function") {
							return Promise.resolve(started).catch(function (error) {
								warnOnce("startSession:async", "删除前切走主会话的异步调用失败：删除后不隐藏该行", error);
								return undefined;
							});
						}
						return undefined;
					})
					: Promise.resolve();
				return leaveFirst.then(function () {
					// 硬闸门：宿主还持有该会话（本地引用计数未归零）就绝不碰文件；
					// 同时等到「新主会话就位」或被证明等不到
					return waitForRelease(sessionId, wasMain);
				}).then(function (held) {
					leaveOk = !wasMain || held.left === true;
					journalPush({ op: "delete-prep", id: sessionId, held: held.text, count: held.count, left: leaveOk });
					if (held.count > 0) {
						return { deleted: false, reason: "held", held: held.text };
					}
					// 等待期间插件被卸载/HMR：不再向宿主发任何请求
					if (disposed) return { deleted: false, reason: "disposed" };
					return disposeSession(sessionId, "manual").then(function (outcome) {
						if (outcome !== undefined && outcome.deleted === false && VERBATIM_REASONS.indexOf(String(outcome.reason)) === -1) {
							// 只有「宿主仍持有」这类原因才追加引用来源；no-storage / archive /
							// disposed 是另一回事（追加会把原因码弄花，确认框就显示错文案）
							outcome.reason = (outcome.reason || "unknown") + " / held: " + (held.text === "" ? "none" : held.text);
						}
						return outcome;
					});
				}).then(function (outcome) {
					if (outcome !== undefined && outcome.deleted === false) {
						// 宿主仍持有（例如会话正在运行）：保留条目，并把原因交给确认框显示
						console.warn("[dsh-pending-session] session not deleted:", sessionId, outcome.reason);
						return { deleted: false, reason: outcome.reason || "unknown" };
					}
					// 删除成功：立刻把它从投影里摘掉（宿主内存里的残影等重启自然消失）。
					// 删的是「当前正在看的会话」且先切走没生效时不能摘：把当前会话行
					// 藏起来会让列表失去主视图（见 project 里的 mainId 保护）。
					if (leaveOk) removedIds.add(sessionId);
					else journalPush({ op: "keep-row", id: sessionId, reason: "leave-failed" });
					// 原生草稿键要无条件清掉：普通会话（没有注册表条目）同样会留残留草稿
					clearConversationDraft(sessionId);
					// 镜像在草稿阶段写下的附件字节同样无条件回收：这类会话可能从未变成
					// 条目，除了这里没有别的回收路径（S1：否则字节永久滞留、越攒越多）
					dropMirrorBlobs(sessionId);
					// active.v1 里若还留着被删会话的草稿文本，一并清掉（下次启动不该再捡回来）
					cleanupActive(sessionId);
					if (activeMirror.value !== null && activeMirror.value.sessionId === sessionId) {
						// 内存镜像还指着已删会话：清空并落盘，免得下一次击键又把它写回 active.v1
						activeMirror.value = null;
						saveActive(null);
					}
					var live = registry.entries[sessionId];
					if (live !== undefined) {
						delete registry.entries[sessionId];
						saveRegistry(registry);
						publishState();
						dropBlobs(live.attachments);
						// 账本/journal 不得永久留着用户内容（名字）；条目都没了，名字也没用
						if (ledger[sessionId] !== undefined) {
							delete ledger[sessionId];
							saveLedger(ledger);
						}
						journalPush({ op: "delete", id: sessionId, reason: "manual" });
					}
					recomputeDerived();
					return { deleted: true, via: outcome === undefined ? "unknown" : outcome.via };
				});
			}
			function removeEntry(sessionId, archiveSession, navigateAway, reason) {
				var entry = registry.entries[sessionId];
				if (entry === undefined) return Promise.resolve();
				var workspaceId = entry.workspaceId;
				delete registry.entries[sessionId];
				saveRegistry(registry);
				publishState();
				clearConversationDraft(sessionId);
				journalPush({ op: "delete", id: sessionId, reason: reason || "manual" });
				// 先排程副作用（归档/跳转），再重算派生视图：
				// 即使重算途中抛错，删除语义也已完成
				var jobs = [dropBlobs(entry.attachments)];
				if (archiveSession) {
					// 手动删除 → 物理删除（真删会话）；规则 10 自动清理 → 仅归档（可恢复）
					// 但归档同样是动宿主：非所有者标签页不得执行（见 performDelete 同款判定）
					if (owned() && !disposed) jobs.push(disposeSession(sessionId, reason || "manual"));
					else journalPush({ op: "archive-skipped", id: sessionId, reason: owned() ? "disposed" : "not-owner" });
				}
				if (navigateAway && (mainIdOf(rawSnapshot()) === sessionId)) {
					var uiWorkspace = ctx.get("uiWorkspace");
					if (uiWorkspace && typeof uiWorkspace.startSession === "function") {
						jobs.push(Promise.resolve().then(function () {
							try { uiWorkspace.startSession(workspaceId); } catch (_e) { /* ignore */ }
						}));
					}
				}
				recomputeDerived();
				return Promise.allSettled(jobs);
			}
			function commitRename(sessionId, name) {
				var entry = registry.entries[sessionId];
				var trimmed = (name || "").trim();
				if (trimmed === "") return Promise.resolve();
				if (entry === undefined) {
					// 条目可能刚被清空重建：账本仍记名字，先补上条目再改名
					var known = ledgerOf(ledger, sessionId);
					if (known === undefined) {
						journalPush({ op: "rename-miss", id: sessionId, name: trimmed });
						return Promise.resolve();
					}
					registry.entries[sessionId] = {
						sessionId: sessionId,
						createdAt: known.createdAt || Date.now(),
						name: known.name || DEFAULT_NAME,
						text: readStoredDraft(sessionId) || "",
						attachments: [],
						workspaceId: workspaceIdOf(sessionId)
					};
					entry = registry.entries[sessionId];
				}
				registry.entries[sessionId] = Object.assign({}, entry, { name: trimmed });
				saveRegistry(registry);
				publishState();
				recomputeDerived();
				rememberName(ledger, sessionId, trimmed, registry.entries[sessionId].createdAt);
				journalPush({ op: "rename", id: sessionId, name: trimmed });
				// 顺手把宿主会话标题也改了：转正后若自动命名未覆盖，则保留用户命名
				return Promise.resolve().then(function () {
					return sessions.using(sessionId, { source: "pendingRename" }, function (reference) {
						return reference.binding.session.rename(trimmed);
					});
				}).catch(function (_e) { /* 标题可后补，不阻塞 */ });
			}

			// ---- 派生会话列表（待执行行投影） ----
			var patchedStores = new WeakSet();
			var patchedRecords = [];
			var rawGet = null;

			function mainIdOf(snap) {
				try {
					var byId = snap.byId;
					for (var id in byId) {
						var row = byId[id];
						if (row && (row.retainedBy && row.retainedBy.mainView || 0) > 0) return id;
					}
				} catch (_e) { /* ignore */ }
				return undefined;
			}
			function rawSnapshot() {
				if (rawGet === null) return { byId: {}, ids: [] };
				var snap = tryRun(rawGet);
				if (snap === undefined || snap === null) {
					// 原始快照读不到 = 整个投影/状态机失去输入，绝不能不吭声
					warnOnce("rawSnapshot", "会话列表原始快照读取失败：侧边栏投影不可用", sessions.list);
					return { byId: {}, ids: [] };
				}
				return snap;
			}
			function project(snap) {
				// 已被我们删掉的会话：宿主内存里可能还留着它（行会一直显示到重启），
				// 这里直接从投影里摘掉，让删除立刻在界面上生效。
				// 例外：当前主会话那一行不能摘 —— 它还在前台被使用，藏掉等于让列表
				// 失去主视图（先切走没生效时就会出现这种局面）。
				var keepMain = mainIdOf(snap);
				if (removedIds.size > 0 && snap !== null && typeof snap === "object" && Array.isArray(snap.ids)) {
					var keptIds = [];
					for (var ri = 0; ri < snap.ids.length; ri++) {
						if (!removedIds.has(snap.ids[ri]) || snap.ids[ri] === keepMain) keptIds.push(snap.ids[ri]);
					}
					if (keptIds.length !== snap.ids.length) {
						var keptById = {};
						for (var rk in snap.byId) {
							if (!removedIds.has(rk) || rk === keepMain) keptById[rk] = snap.byId[rk];
						}
						snap = Object.assign({}, snap, { ids: keptIds, byId: keptById });
					}
				}
				var entries = registry.entries;
				var hasEntries = false;
				for (var k in entries) { hasEntries = true; break; }
				var main = mainIdOf(snap);
				if (!hasEntries && main === undefined) return snap;
				var mirror = activeMirror.value;
				var mirrorQualified = mirror !== null && mirror.sessionId !== undefined &&
					isQualified(mirror.text, mirror.manifest || mirror.attachmentIds);
				var next = {};
				var patched = false;
				for (var id in snap.byId) {
					var row = snap.byId[id];
					var entry = entries[id];
					if (entry !== undefined) {
						// 待执行：可见的非 blank 行（标题=名称、时间=创建时间、cwd 隔离复用）
						next[id] = Object.assign({}, row, {
							blank: false,
							title: entry.name,
							displayTitle: entry.name,
							updatedAt: Math.max(row.updatedAt || 0, entry.createdAt || 0),
							cwd: ""
						});
						patched = true;
					} else if (row && row.blank === true && id === main && mirrorQualified) {
						// 正在编辑的带草稿新会话：仍是「新会话」占位行，但 cwd 隔离，
						// 让「新会话」按钮不再复用它（否则点击新会话会回到同一草稿）
						next[id] = Object.assign({}, row, { cwd: "" });
						patched = true;
					} else {
						next[id] = row;
					}
				}
				if (!patched) return snap;
				return Object.assign({}, snap, { byId: next });
			}
			// 投影缓存：key = (原始快照引用, 投影版本)。
			// React 的 useSyncExternalStore 要求 getSnapshot 返回稳定引用——每次
			// 都新建对象会触发 "getSnapshot should be cached" 无限渲染并让侧边栏
			// 整个渲染失败；而纯缓存派生 store 又会慢一拍（导航卡住）。两者兼顾：
			// 原始状态变了或投影输入（注册表/镜像）变了才重建，其余时刻返回同一对象。
			var cacheRaw = null;
			var cacheVersion = -1;
			var cacheProjected = null;
			var projectionVersion = 0;
			function projectedSnapshot() {
				if (rawGet === null) return undefined;
				var raw = rawGet();
				if (raw === undefined || raw === null) return raw;
				if (raw === cacheRaw && cacheVersion === projectionVersion && cacheProjected !== null) {
					return cacheProjected;
				}
				var next = project(raw);
				cacheRaw = raw;
				cacheVersion = projectionVersion;
				cacheProjected = next;
				return next;
			}
			function recomputeDerived() {
				// 投影输入变了（注册表/镜像）：让缓存失效并触发一次通知，
				// 订阅者重读 getSnapshot 即得到重建后的新对象
				projectionVersion++;
				try {
					var store = sessions.list;
					if (store && typeof store.set === "function" && rawGet !== null) {
						// 传浅拷贝：zustand 对 Object.is 相等的 state 不派发通知
						store.set(Object.assign({}, rawGet()));
					}
				} catch (_e) { /* ignore */ }
			}
			function installPatch() {
				try {
					var store = sessions.list;
					if (!store || typeof store.getSnapshot !== "function") {
						// 没有 store 就没有投影：整个插件的可见性都靠它，必须吭声（每次扫描会重试）
						warnOnce("installPatch:store", "sessions.list 不可用：侧边栏投影未安装", store);
						return;
					}
					if (patchedStores.has(store)) return;
					patchedStores.add(store);
					// 自愈：优先用 store 上记录的「已知原始方法」，避免重挂载时层层叠加
					var origGet = store.__dpsOriginalGet && typeof store.__dpsOriginalGet === "function"
						? store.__dpsOriginalGet
						: store.getSnapshot.bind(store);
					if (store.__dpsOriginalGet === undefined) {
						store.__dpsOriginalGet = origGet;
					}
					// 关键：只替换 getSnapshot 为「带缓存的按需投影」，不替换 subscribe。
					// 早于本插件订阅的消费者（ui-session 等）在通知里读 getSnapshot，
					// 原始引用已变 → 立即拿到最新投影（不会慢一拍）；而重复读取在无变化
					// 时返回同一对象（满足 React 引用稳定性）。
					var wrapper = function () {
						try { return projectedSnapshot(); } catch (_e) { return origGet(); }
					};
					// 记下包装函数本身：还原时要确认当前装的还是它（见 restorePatch）
					patchedRecords.push({ store: store, origGet: origGet, wrapper: wrapper });
					rawGet = function () { return origGet(); };
					store.getSnapshot = wrapper;
				} catch (error) {
					// 投影安装失败 = 待执行条目在侧边栏根本不可见，属于致命静默失效，必须吭声
					warnOnce("installPatch", "会话列表投影安装失败", error);
				}
			}
			/** 卸载/热更新前还原被包装的 store 方法，避免残留投影。 */
			function restorePatch() {
				for (var i = 0; i < patchedRecords.length; i++) {
					var rec = patchedRecords[i];
					try {
						// 只在「当前方法仍是本实例装上去的那个包装」时才还原：HMR 时序里
						// 新实例可能已经装上它自己的投影，无条件还原会把新实例的投影拆掉
						// （侧边栏里待执行条目随即消失）
						if (rec.store.getSnapshot !== rec.wrapper) continue;
						rec.store.getSnapshot = rec.origGet;
					} catch (_e) { /* ignore */ }
				}
				patchedRecords = [];
				patchedStores = new WeakSet();
				rawGet = null;
				cacheRaw = null;
				cacheProjected = null;
				cacheVersion = -1;
			}
			installPatch();
			ctx.on("connection/reset", function () { installPatch(); });
			var sweepTimer = setInterval(function () {
				if (disposed) return; // 卸载/HMR 之后不再扫（旧实例不得再动盘、动投影）
				installPatch();
				// 镜像挂载失败（shell 尚未物化）时重试
				if (lastMain !== undefined && !mirrorActive && shellFor(lastMain) !== undefined) {
					startMirroring(lastMain);
				}
			}, SWEEP_MS);

			// ---- 主会话切换观察（离开 = 创建/更新/删除条目） ----
			var lastMain = undefined;
			var mirrorDispose = function () {};
			var mirrorActive = false;
			var saveTimer = 0;
			var lastSavedManifest = null;
			/** 本轮镜像里是否已经记过「非空白，跳过镜像」（见下方 handler：不能每键记一次）。 */
			var skipLogged = false;

			function startMirroring(id) {
				mirrorDispose();
				mirrorDispose = function () {};
				mirrorActive = false;
				skipLogged = false;
				if (id === undefined) return;
				var shell = shellFor(id);
				if (shell === undefined) return;
				mirrorActive = true;
				var wasQualified = false;
				var handler = function () {
					var snap = shell.state.getSnapshot();
					var conv = rootConversation();
					var manifest = draftManifest(conv, snap.attachmentIds || []);
					// 只有空白会话才配写「退出时的活动草稿」镜像：非空白会话（普通对话）
					// 写进去，下次启动就会把它当成待执行反复误建。
					if (isBlankSession(id) === false) {
						activeMirror.value = null;
						cleanupActive(id);
						// 这个分支在普通对话里**每次状态变化都会走到**（打字时每键一次）：
						// 每次都记 = 每键写一次 localStorage，而且会把 journal 的 300 条
						// 环形容量挤满、冲掉真正有用的增删改记录。同一个会话只记第一次。
						if (!skipLogged) {
							skipLogged = true;
							journalPush({ op: "skip-non-blank", id: id, reason: "mirror" });
						}
						return;
					}
					activeMirror.value = {
						sessionId: id,
						savedAt: Date.now(),
						text: snap.draft,
						attachmentIds: snap.attachmentIds || [],
						manifest: manifest
					};
					// 合格状态翻转会影响派生视图（cwd 隔离/待执行投影）：只在翻转时重算，
					// 避免每次击键都触发整个侧边栏重渲染
					var qualified = isQualified(snap.draft, manifest);
					if (qualified !== wasQualified) {
						wasQualified = qualified;
						recomputeDerived();
					}
					clearTimeout(saveTimer);
					saveTimer = schedule(function () {
						var mirror = activeMirror.value;
						if (mirror === null || mirror.sessionId !== id) return;
						saveActive({ sessionId: mirror.sessionId, savedAt: mirror.savedAt, text: mirror.text, manifest: mirror.manifest });
						if (!sameManifest(mirror.manifest, lastSavedManifest)) {
							lastSavedManifest = mirror.manifest;
							captureBlobs(conv, mirror.manifest);
							// 记账必须和采样同一处：镜像持有的字节，只有这里能回收（S1）
							noteMirrorBlobs(id, mirror.manifest);
						}
					}, DEBOUNCE_MS);
				};
				mirrorDispose = shell.state.subscribe(handler);
				handler();
			}

			// 「行消失」与「已执行（转正）」各自计数：共用一个 Map 会互相污染
			// （一次消失 + 一次疑似转正就凑够两次确认，条目被误删）
			var rowMissingStrikes = new Map();
			var executedStrikes = new Map();
			/**
			 * 权威 blank 信号：宿主会话的 sessionListMetadata 投影（真实事件驱动）。
			 * 客户端列表行的 blank 会被「engaged 泄漏」污染（发送启动但未产出任何
			 * 事件的会话会永久显示非 blank），不能作为转正判据。
			 * @returns true/false，或 undefined（投影不可用）。
			 */
			function hostBlank(id) {
				try {
					var binding = sessions.binding(id);
					var face = binding && binding.session && binding.session.projections.faceOf("sessionListMetadata");
					var snap = face && face.getSnapshot();
					if (snap && typeof snap.blank === "boolean") return snap.blank;
				} catch (error) {
					// 读不到权威投影就只剩「列表行 + 时间前移」的弱判据，转正判定会变糙
					warnOnce("hostBlank", "宿主 blank 投影读取失败：转正判定退回弱判据", error);
				}
				return undefined;
			}
			function reconcile(snap) {
				// 列表未就绪（pending 阶段）时 byId 为空，绝不能当作“会话消失”清理
				if (!snap || snap.phase !== "ready") return;
				var changed = false;
				for (var id in registry.entries) {
					var row = snap.byId[id];
					var entry = registry.entries[id];
					if (row === undefined) {
						// 会话从列表消失：连续两次观察才确认删除
						var missing = (rowMissingStrikes.get(id) || 0) + 1;
						rowMissingStrikes.set(id, missing);
						if (missing < 2) continue;
						rowMissingStrikes.delete(id);
						delete registry.entries[id];
						changed = true;
						journalPush({ op: "delete", id: id, reason: "row-missing" });
						continue;
					}
					rowMissingStrikes.delete(id); // 行回来了：消失计数清零
					var hb = hostBlank(id);
					var executed;
					if (hb === false) {
						// 权威投影：宿主确实产生了事件 → 转正
						executed = true;
					} else if (hb === undefined) {
						// 投影不可用：要求列表行非 blank 且活动时间真实前移（真实消息证据）
						executed = row.blank === false && (row.updatedAt || 0) > (entry.createdAt || 0);
					} else {
						executed = false;
					}
					if (executed) {
						var strikes = (executedStrikes.get(id) || 0) + 1;
						executedStrikes.set(id, strikes);
						if (strikes < 2) continue;
						executedStrikes.delete(id);
						// 已执行转正：立刻转为普通对话记录
						var customName = entry.name !== DEFAULT_NAME ? entry.name : undefined;
						delete registry.entries[id];
						// 转正即从「待执行」毕业：账本里的名字与 IndexedDB 字节都不必再留
						// （历史 op=rename 的 journal 条目里的 name 由旧版本写出，不再新增）
						if (ledger[id] !== undefined) {
							delete ledger[id];
							saveLedger(ledger);
						}
						dropBlobs(entry.attachments || []);
						// 镜像记账里可能还有条目 manifest 之外的历史 aid（改过附件的那几版）：
						// 转正即毕业，这批字节也一并回收，别留在 IndexedDB 里
						dropMirrorBlobs(id);
						changed = true;
						journalPush({ op: "delete", id: id, reason: "executed" });
						if (customName !== undefined) {
							// 延迟重命名，尽量落在自动命名之后（dispose 后不再续跑）
							schedule(function () {
								if (disposed) return;
								tryRun(function () {
									return sessions.using(id, { source: "pendingExecuteRename" }, function (reference) {
										return reference.binding.session.rename(customName);
									});
								});
							}, 2000);
						}
					} else {
						executedStrikes.delete(id);
					}
				}
				if (changed) {
					saveRegistry(registry);
					publishState();
					recomputeDerived();
				}
			}

			// 主会话切换：inSwitch 用于挡住「处理过程中同步触发的重入」。
			// 但重入时发生的那次切换是真实切换，不能整段丢掉（丢掉 = 离开的那次
			// 草稿不登记）——把待处理的 to 暂存下来，当前这次处理完再补跑。
			var inSwitch = false;
			var handledMain = undefined; // 本实例「已处理完」的主会话，离开判定的 from 只认它
			var hasPendingSwitch = false;
			var pendingSwitchTo = undefined;
			var SWITCH_CATCHUP_MAX = 4; // 补跑上限：异常情况下也不允许无限递归
			function handleMainSwitch(to) {
				if (inSwitch) {
					hasPendingSwitch = true;
					pendingSwitchTo = to;
					return;
				}
				inSwitch = true;
				try {
					var catchup = 0;
					for (;;) {
						// from 取「上一次处理完的值」而不是调用方已前移的 lastMain：
						// 重入时 lastMain 早已指向新主会话，用它会把离开判定算错
						var from = handledMain;
						handledMain = to;
						if (from !== undefined && from !== null) {
					var row = rawSnapshot().byId[from];
					var entry = registry.entries[from];
					// 离开判定不依赖 raw 行的 blank（会话服务读改写会瞬时污染它）：
					// 已登记待执行，或确为空白会话，都按离开处理
					if (row !== undefined && (entry !== undefined || row.blank === true)) {
						var live = readDraft(from);
						var mirror = activeMirror.value && activeMirror.value.sessionId === from ? activeMirror.value : null;
						var text;
						var manifest;
						var conv = rootConversation();
						if (live !== undefined) {
							text = live.text;
							manifest = draftManifest(conv, live.attachmentIds);
						} else if (mirror !== null) {
							text = mirror.text;
							manifest = mirror.manifest || [];
						} else if (entry !== undefined) {
							text = entry.text;
							manifest = entry.attachments;
						} else {
							text = "";
							manifest = [];
						}
						if (isQualified(text, manifest)) {
							if (entry !== undefined) {
								// 修改：时间与位置不变，仅更新内容
								var stale = entry.attachments.filter(function (m) {
									return !manifest.some(function (n) { return n.aid === m.aid; });
								});
								dropBlobs(stale);
								persistEntry(Object.assign({}, entry, { text: text, attachments: manifest }), conv);
							} else {
								// 创建：记离开时间为创建时间
								persistEntry({
									sessionId: from,
									createdAt: Date.now(),
									name: DEFAULT_NAME,
									text: text,
									attachments: manifest,
									workspaceId: workspaceIdOf(from)
								}, conv);
							}
						} else if (entry !== undefined) {
							// 规则 10：清空到只剩空白且无附件，离开 = 删除条目
							removeEntry(from, true, false, "rule10");
						}
					}
				}
				// 离开的会话若「没成为条目」（用户直接发送 / 草稿本来就不合格）：镜像阶段
				// 写下的附件字节再没有别的回收路径，这里顺手收掉，别长期挂在 IndexedDB 里（S1）
				if (from !== undefined && from !== null && from !== to && registry.entries[from] === undefined) {
					dropMirrorBlobs(from);
				}
				activeMirror.value = null;
				lastSavedManifest = null;
				startMirroring(to);
				// 主会话变了（cwd 隔离的目标随之变化）：让投影缓存失效并重新通知
				recomputeDerived();
						if (!hasPendingSwitch || disposed) break;
						if (catchup >= SWITCH_CATCHUP_MAX) {
							// 补跑超限时不能把 handledMain 停在中间值：它一旦与 lastMain 错位，
							// 之后任何一次切换的 from 都会算到错误的会话上（离开判定失效）
							handledMain = lastMain;
							journalPush({ op: "switch-catchup-drop", to: String(pendingSwitchTo) });
							warnOnce("switchCatchup", "主会话切换补跑次数超限：丢弃剩余切换", pendingSwitchTo);
							break;
						}
						catchup += 1;
						to = pendingSwitchTo;
						hasPendingSwitch = false;
						pendingSwitchTo = undefined;
					}
				} finally {
					inSwitch = false;
					hasPendingSwitch = false;
					pendingSwitchTo = undefined;
				}
			}

			/**
			 * 跟随宿主标题改名：用户若通过 DSH 原生「重命名」改了会话标题，
			 * 把新标题采纳为待执行条目的名字（两条改名入口都生效）。
			 * 待执行条目的行标题由插件投影覆盖，所以 raw 行的 title 只在宿主改名时变化。
			 */
			function adoptHostTitle(snap) {
				if (!snap || snap.phase !== "ready") return;
				var changed = false;
				for (var id in registry.entries) {
					var row = snap.byId[id];
					if (row === undefined) continue;
					var hostTitle = typeof row.title === "string" ? row.title.trim() : "";
					if (hostTitle === "") continue;
					var entry = registry.entries[id];
					if (hostTitle === entry.name) continue;
					registry.entries[id] = Object.assign({}, entry, { name: hostTitle });
					rememberName(ledger, id, hostTitle, entry.createdAt);
					changed = true;
					journalPush({ op: "rename", id: id, name: hostTitle, source: "host" });
				}
				if (changed) {
					saveRegistry(registry);
					publishState();
					recomputeDerived();
				}
			}

			var scannedBlanks = new Set();			/**
			 * 收养「孤儿」空白会话：非当前、未登记的 blank 会话若原生草稿存储里
			 * 有合格文本（例如插件更新前/崩溃时留下的草稿），自动登记为待执行，
			 * 避免原生「新会话」复用逻辑把它当作空会话带回旧草稿。
			 */
			function adoptOrphanBlanks(snap) {
				if (!snap || snap.phase !== "ready") return;
				var current = mainIdOf(snap);
				var changed = false;
				for (var id in snap.byId) {
					var row = snap.byId[id];
					if (!row || row.blank !== true) continue;
					// 列表行的 blank 会被 engaged 泄漏污染 → 宿主投影明确说「非空白」就不要
					// （投影拿不到时按列表行算，保证「带回滚痕迹的空白会话」仍能被收养）
					if (hostBlank(id) === false) continue;
					if (registry.entries[id] !== undefined) continue;
					if (scannedBlanks.has(id)) continue;
					if (id === current) continue; // 当前主会话由镜像/离开路径处理
					scannedBlanks.add(id);
					var draft = readStoredDraft(id);
					if (draft === null || draft.trim() === "") continue;
					var knownOrphan = ledgerOf(ledger, id);
					registry.entries[id] = {
						sessionId: id,
						createdAt: knownOrphan !== undefined ? knownOrphan.createdAt : (row.updatedAt || Date.now()),
						name: knownOrphan !== undefined ? knownOrphan.name : DEFAULT_NAME,
						text: draft,
						attachments: [],
						workspaceId: workspaceIdOf(id)
					};
					rememberName(ledger, id, registry.entries[id].name, registry.entries[id].createdAt);
					changed = true;
					journalPush({ op: "adopt", id: id, name: registry.entries[id].name });
				}
				if (changed) {
					saveRegistry(registry);
					publishState();
					recomputeDerived();
				}
			}

			function onListChange() {
				try {
					var snap = rawSnapshot();
					reconcile(snap);
					applyExitActive();
					adoptOrphanBlanks(snap);
					adoptHostTitle(snap);
					var main = mainIdOf(snap);
					if (main !== lastMain) {
						// 先占位再执行：handleMainSwitch 里同步触发的派生视图重算
						// 会重入本回调；重入时那次切换由 handleMainSwitch 暂存并补跑
						lastMain = main;
						handleMainSwitch(main);
					}
				} catch (error) {
					console.error("[dsh-pending-session] list handler failed:", error);
				}
			}
			var listUnsub = sessions.list.subscribe(onListChange);

			// 归档（原生「归档」或行菜单）不再删除条目：与其他会话一致，归档只是在
			// 默认视图里隐藏，条目与草稿都保留，用户可在「归档会话」视图里找回并恢复。
			// 这里只做一次可见性刷新，让投影把归档行交给归档过滤器处理。
			var archivedLogged = new Set(); // 已记过「归档可见」的条目 id（防 journal 刷屏）
			var workspacesUnsub = workspaces.list.subscribe(function () {
				try {
					var arch = workspaces.list.getSnapshot().archivedSessionIds || [];
					var set = new Set(arch);
					var changed = false;
					for (var id in registry.entries) {
						if (set.has(id)) {
							changed = true;
							// 该订阅会被工作区列表的任意变化触发：每个 id 只记首次，
							// 否则 journal 会被同一件事反复刷屏（300 条上限很快被挤满）
							if (!archivedLogged.has(id)) {
								archivedLogged.add(id);
								journalPush({ op: "archived-visible", id: id });
							}
						}
					}
					if (changed) recomputeDerived();
				} catch (_e) { /* ignore */ }
			});

			// 退出前尽量同步落盘
			var beforeUnloadHandler = null;
			if (typeof window !== "undefined") {
				beforeUnloadHandler = function () {
					var mirror = activeMirror.value;
					if (mirror !== null && mirror.sessionId !== undefined) {
						saveActive({ sessionId: mirror.sessionId, savedAt: Date.now(), text: mirror.text, manifest: mirror.manifest });
					}
				};
				window.addEventListener("beforeunload", beforeUnloadHandler);
			}

			// ---- 打开待执行条目时恢复附件 ----
			function restorePending(sessionId, entry, attempt) {
				if (disposed) return; // 卸载/HMR 后旧实例不得再续跑
				if (!entry || !Array.isArray(entry.attachments) || entry.attachments.length === 0) return;
				var tries = attempt === undefined ? 0 : attempt;
				if (tries > 3) return;
				try {
					var conv = rootConversation();
					if (conv === undefined) return;
					var shell = shellFor(sessionId);
					if (shell === undefined) {
						// shell 可能晚于横幅物化：稍后重试（定时器登记在册，dispose 即作废）
						schedule(function () { restorePending(sessionId, entry, tries + 1); }, 500);
						return;
					}
					var current = shell.state.getSnapshot().attachmentIds || [];
					// missing（超限占位项）没有字节可取：不参与「已就位」判定，也不去 IndexedDB 找
					var restorable = entry.attachments.filter(function (m) { return m.missing !== true; });
					var storedAids = restorable.map(function (m) { return m.aid; });
					for (var i = 0; i < current.length; i++) {
						if (storedAids.indexOf(current[i]) !== -1) return; // 已就位
					}
					if (restorable.length === 0) return;
					var pending = restorable.slice();
					(function attempt() {
						var jobs = pending.map(function (m) { return idbGet(m.aid); });
						Promise.all(jobs).then(function (records) {
							var files = [];
							var olds = [];
							for (var j = 0; j < records.length; j++) {
								var rec = records[j];
								if (rec === undefined || !rec.bytes) continue;
								var file;
								try {
									file = new File([rec.bytes], rec.name || pending[j].name, { type: rec.mediaType || pending[j].mediaType || "" });
								} catch (_e) {
									file = new Blob([rec.bytes], { type: rec.mediaType || "" });
								}
								files.push(file);
								olds.push(pending[j].aid);
							}
							if (files.length === 0) return;
							var drafts = conv.createDrafts(sessionId, files);
							var ids = drafts.map(function (d) { return d.id; });
							var shell2 = shellFor(sessionId);
							if (shell2 === undefined) return;
							if (!shell2.addAttachments(ids)) return;
							// 更新注册表里的 aid 映射（下次离开时按新 id 采集字节）
							var map = {};
							for (var k = 0; k < olds.length; k++) map[olds[k]] = ids[k];
							var nextAttachments = entry.attachments.map(function (m) {
								return map[m.aid] === undefined ? m : Object.assign({}, m, { aid: map[m.aid] });
							});
							var live = registry.entries[sessionId];
							if (live !== undefined) {
								registry.entries[sessionId] = Object.assign({}, live, { attachments: nextAttachments });
								saveRegistry(registry);
								publishState();
							}
							// 字节已复制成新 aid：旧 manifest 的字节不再被引用，不回收就会
							// 每打开一次条目多留一份（IndexedDB 无限膨胀）
							dropBlobs(entry.attachments);
						}).catch(function (error) {
							console.error("[dsh-pending-session] attachment restore failed:", error);
						});
					})();
				} catch (error) {
					console.error("[dsh-pending-session] attachment restore failed:", error);
				}
			}

			// ---- 插槽注册 ----
			/** 插槽挂不上 = 对应那块 UI 整块不出现（静默失效），首次失败必须吭声（M4 同款）。 */
			function injectSlot(slotName, register) {
				try {
					slots.inject(slotName, register);
				} catch (error) {
					warnOnce("slot:" + slotName, "插槽注册失败（该处 UI 不可用）", error);
				}
			}
			injectSlot("conversation.input.dock", function () {
				return slots.register({
					name: "conversation.input.dock",
					id: "dps.pending-banner",
					order: 5,
					locale: NS,
					inject: function (sessionId) {
						return {
							hooks: { pending: state },
							restorePending: restorePending,
							openRename: function (sid, name) {
								publishState({ renameRequest: { sessionId: sid, name: name } });
							},
							requestDelete: function (sid, title) {
								publishState({ deleteRequest: { sessionId: sid, title: title || "" } });
							},
							deletePending: function (sid, title) {
								publishState({ deleteRequest: { sessionId: sid, title: title || "" } });
							}
						};
					}
				}, PendingBanner);
			});
			injectSlot("sidebar.session.row.leading", function () {
				return slots.register({
					name: "sidebar.session.row.leading",
					id: "dps.pending-mark",
					order: 10,
					locale: NS,
					inject: function () {
						return { hooks: { pending: state } };
					}
				}, PendingRowLeading);
			});
			injectSlot("sidebar.workspaces.session.menu.item", function* () {
				// 重命名不再单独提供菜单项：DSH 原生「重命名」（以及双击行标题）
				// 已由 adoptHostTitle 同步到条目名字。这里提供统一的「删除会话」，
				// 对所有会话可用（待执行条目显示为「删除待执行」）。
				yield slots.register({
					name: "sidebar.workspaces.session.menu.item",
					id: "dps.delete-session",
					order: 460,
					locale: NS,
					inject: function () {
						return {
							hooks: { pending: state },
							requestDelete: function (sid, title) {
								publishState({ deleteRequest: { sessionId: sid, title: title || "" } });
							}
						};
					}
				}, DeleteSessionMenuItem);
			});
			injectSlot("shell.overlay", function () {
				return slots.register({
					name: "shell.overlay",
					id: "dps.pending-rename-dialog",
					locale: NS,
					inject: function () {
						return {
							hooks: { pending: state },
							settleRename: function () {
								publishState({ renameRequest: null });
							},
							commitRename: commitRename
						};
					}
				}, PendingRenameDialog);
			});
			injectSlot("shell.overlay", function () {
				return slots.register({
					name: "shell.overlay",
					id: "dps.delete-session-dialog",
					locale: NS,
					inject: function () {
						return {
							hooks: { pending: state },
							settleDelete: function () {
								publishState({ deleteRequest: null });
							},
							commitDelete: performDelete
						};
					}
				}, DeleteConfirmDialog);
			});

			// ---- 清理 ----
			ctx.effect(function () {
				return function () {
					// 先置位再收尾：这之后所有延迟续跑（schedule/wait 与各处 disposed 判定）
					// 一律短路，HMR/卸载后的旧实例不会再动盘、动宿主
					disposed = true;
					clearInterval(sweepTimer);
					clearTimeout(saveTimer);
					timerIds.forEach(function (id) {
						try { clearTimeout(id); } catch (_e) { /* ignore */ }
					});
					timerIds.clear();
					mirrorDispose();
					// 卸载前落盘一次
					var mirror = activeMirror.value;
					if (mirror !== null && mirror.sessionId !== undefined) {
						saveActive({ sessionId: mirror.sessionId, savedAt: Date.now(), text: mirror.text, manifest: mirror.manifest });
					}
					activeMirror.value = null;
					// 还原被包装的 sessions.list 并切断订阅，避免残留派生视图
					try { listUnsub(); } catch (_e) { /* ignore */ }
					try { workspacesUnsub(); } catch (_e) { /* ignore */ }
					if (beforeUnloadHandler !== null && typeof window !== "undefined") {
						try { window.removeEventListener("beforeunload", beforeUnloadHandler); } catch (_e) { /* ignore */ }
					}
					restorePatch();
					// 样式是页面级资源：本实例卸载时一并摘掉（removeStyles 幂等，重复调无害）
					removeStyles();
				};
			}, "dsh-pending-session: dispose");

			// 初始触发（列表可能已就绪）
			onListChange();
		}

		/** 客户端注入（cordis fiber inject）。 */
		var inject = ["slots", "sessions", "workspaces", "locale"];

		// 仅供无头测试模拟「页面重启」：真实重载后模块级缓存一律重建。
		exports.__dpsResetRuntime = function () {
			APPLIED = false;
			idbPromise = null;
			journal = loadJournal();
			warnedOnce.clear();
		};

		// 仅供无头测试：删除原因码 → 词典键（确认框文案走哪个分支）。
		exports.__dpsDeleteReasonKey = deleteReasonKey;

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
