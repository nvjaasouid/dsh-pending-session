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
		var primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		var storeLib = require("@deepseek-ai/dsh-client-store");
		var createSnapshotStore = storeLib.createSnapshotStore;

		// ---------------------------------------------------------------- 常量
		var NS = "pending";
		var DEFAULT_NAME = "待执行";
		var BUILD = "0.1.0-r25";
		var JOURNAL_KEY = "dsh.pending-session.journal.v1";
		/** 名称账本：sessionId -> { name, createdAt }，与注册表分开持久化。
		 *  注册表条目一旦被清空/重建（收养、重启时序等），名字与创建时间仍能恢复。 */
		var LEDGER_KEY = "dsh.pending-session.names.v1";
		/** 我们自己的删除端点（宿主半边 index.js 实现）：删存储目录 + rdb 行 +
		 *  工作区记账，不做「宿主是否持有」的保护判定（第三方会因此拒绝删刚看过的会话）。 */
		var OWN_DELETE_PATH = "api/dsh-pending-session/delete";
		/** 第三方归档插件的删除端点：仅在我们自己的端点不可用时兜底。 */
		var ARCHIVE_DELETE_PATH = "api/dsh-session-archive/delete";
		var OWNER_KEY = "dsh.pending-session.owner.v1";
		var BOOT_TOKEN = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
		var LS_REGISTRY = "dsh.pending-session.registry.v1";
		var LS_ACTIVE = "dsh.pending-session.active.v1";
		var CONVERSATION_KEY = "dsh.conversation.";
		var IDB_NAME = "dsh-pending-session";
		var IDB_STORE = "attachments";
		var MAX_ATTACHMENT_BYTES = 64 * 1024 * 1024; // 单附件上限 64MB
		var DEBOUNCE_MS = 400;
		var SWEEP_MS = 2000;
		/** 物理删除：宿主仍持有时等待重试的次数与间隔（切走主会话后通常在数百毫秒内释放）。 */
		var DELETE_ATTEMPTS = 6;
		var DELETE_RETRY_MS = 700;

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
			"dialog.deleteRunning": "该会话正在运行（agent 输出中），请先停止它再删除。"
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
			"dialog.deleteRunning": "This session is currently running. Stop it before deleting."
		};

		// ---------------------------------------------------------------- 样式
		var CSS = [
			".dps-dock{box-sizing:border-box;width:calc(100% - 2*var(--dsh-composer-side-clearance,0px) - 4*var(--dsh-composer-dock-inset,0px));margin:0 auto}",
			".dps-bar{box-sizing:border-box;width:100%;max-width:calc(var(--dsh-composer-card-max-width,800px) - 4*var(--dsh-composer-dock-inset,0px));margin:0 auto;height:34px;display:flex;align-items:center;gap:8px;padding:0 6px 0 12px;border-radius:var(--dsw-radius-md);border:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-specific-menu);color:var(--dsw-alias-label-primary);font-size:12px;line-height:20px;box-shadow:var(--dsw-elevation-panel)}",
			".dps-glyph{flex:none;display:inline-flex;color:var(--dsw-alias-label-tertiary)}",
			".dps-label{flex:none;font-weight:500}",
			".dps-name{flex:none;max-width:40%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary-dimmed)}",
			".dps-meta{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary)}",
			".dps-actions{flex:none;display:flex;align-items:center;gap:2px}",
			".dps-iconBtn{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border:0;background:transparent;border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-tertiary);cursor:pointer;padding:0}",
			".dps-iconBtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
			".dps-iconBtn:disabled{opacity:.5;cursor:default}",
			".dps-renameInput{box-sizing:border-box;width:100%;height:32px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);padding:0 10px;font-size:13px;line-height:20px;outline:none}",
			".dps-renameInput:focus{border-color:var(--dsw-alias-state-business-primary)}",
			".dps-leading{display:inline-flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-tertiary)}",
			".dps-deleteBody{display:flex;flex-direction:column;gap:6px;font-size:13px;line-height:1.6}",
			".dps-deleteName{font-weight:600;word-break:break-all}",
			".dps-deleteError{color:var(--dsw-alias-label-error, #d92d20);font-size:12px;line-height:1.5}"
		].join("\n");
		var styleTagId = "dsh-pending-session/style";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(styleTagId) + "]") === null) {
			try {
				var styleTag = document.createElement("style");
				styleTag.dataset.plugin = "dsh-pending-session";
				styleTag.dataset.pluginCss = styleTagId;
				styleTag.textContent = CSS;
				document.head.appendChild(styleTag);
			} catch (_e) { /* 样式失败不影响功能 */ }
		}

		// ---------------------------------------------------------------- 小工具
		function tryRun(fn) {
			try { return fn(); } catch (_e) { return undefined; }
		}

		function isQualified(text, manifest) {
			return (typeof text === "string" && text.trim() !== "") || (Array.isArray(manifest) && manifest.length > 0);
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

		function delay(ms) {
			return new Promise(function (resolve) { setTimeout(resolve, ms); });
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
				journalPush({ op: "save", count: Object.keys(registry.entries).length, ids: Object.keys(registry.entries) });
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
		function saveActive(value) {
			if (!owned()) return;
			try {
				if (value === null || value === undefined) localStorage.removeItem(LS_ACTIVE);
				else localStorage.setItem(LS_ACTIVE, JSON.stringify(value));
			} catch (_e) { /* ignore */ }
		}
		function writeConversationDraft(sessionId, text) {
			if (!owned()) return;
			try {
				localStorage.setItem(CONVERSATION_KEY + sessionId, JSON.stringify({ draft: text, view: null, viewRequest: null }));
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
		/** 取证日志：每次条目增删改都记录原因，便于定位异常。 */
		function loadJournal() {
			try {
				var raw = localStorage.getItem(JOURNAL_KEY);
				if (raw === null) return [];
				var parsed = JSON.parse(raw);
				return Array.isArray(parsed) ? parsed : [];
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
				journal.push(Object.assign({ t: Date.now(), build: BUILD }, entry));
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
				)
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
						// 宿主拒绝（仍被进程持有/正在运行）：留在对话框里说明原因
						setError(outcome.reason || "unknown");
						return;
					}
					settleDelete();
				}).catch(function (reason) {
					setBusy(false);
					setError(reason instanceof Error ? reason.message : String(reason));
				});
			};
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
					error === null ? null : React.createElement("div", { className: "dps-deleteError" },
						t(error === "running" ? "dialog.deleteRunning" : "dialog.deleteBlocked") + " (" + error + ")"))
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
			APPLIED = true;
			claimOwnership();
			try { localStorage.setItem("dsh.pending-session.build", BUILD); } catch (_e) { /* ignore */ }
			var sessions = ctx.sessions;
			var workspaces = ctx.workspaces;
			var slots = ctx.slots;
			var locale = ctx.locale;
			if (!sessions || !workspaces || !slots || !locale) return;

			ctx.effect(function () { return locale.register(NS, { zh: zh, en: en }); }, "dsh-pending-session: dictionaries");

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
			var activeAtExit = loadActive();
			if (activeAtExit !== null && typeof activeAtExit.sessionId === "string" &&
				isQualified(activeAtExit.text, activeAtExit.manifest)) {
				var knownExit = ledgerOf(ledger, activeAtExit.sessionId);
				registry.entries[activeAtExit.sessionId] = {
					sessionId: activeAtExit.sessionId,
					createdAt: knownExit !== undefined ? knownExit.createdAt : (typeof activeAtExit.savedAt === "number" ? activeAtExit.savedAt : Date.now()),
					name: knownExit !== undefined ? knownExit.name : DEFAULT_NAME,
					text: typeof activeAtExit.text === "string" ? activeAtExit.text : "",
					attachments: Array.isArray(activeAtExit.manifest) ? activeAtExit.manifest : [],
					workspaceId: undefined
				};
				rememberName(ledger, activeAtExit.sessionId, registry.entries[activeAtExit.sessionId].name, registry.entries[activeAtExit.sessionId].createdAt);
				saveRegistry(registry);
				journalPush({ op: "create", id: activeAtExit.sessionId, reason: "exit-active" });
			}
			saveActive(null);
			publishState(null);
			journalPush({ op: "boot", entries: Object.keys(registry.entries) });

			// ---- conversation / shell 访问 ----
			function rootConversation() {
				return ctx.get("conversation");
			}
			function shellFor(id) {
				return tryRun(function () {
					var scoped = sessions.scope(id);
					if (scoped === undefined) return undefined;
					var conv = scoped.get("conversation");
					if (conv === undefined || !conv.input) return undefined;
					return conv.input.for(scoped);
				});
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
				for (var i = 0; i < attachmentIds.length; i++) {
					var aid = attachmentIds[i];
					try {
						var d = conv && conv.draftAttachments ? conv.draftAttachments.get(aid) : undefined;
						if (d === undefined || !d.file) continue;
						if (typeof d.file.size === "number" && d.file.size > MAX_ATTACHMENT_BYTES) continue;
						manifest.push({
							aid: aid,
							kind: d.kind === "image" ? "image" : "file",
							name: d.file.name || "attachment",
							mediaType: d.file.type || "",
							size: typeof d.file.size === "number" ? d.file.size : 0
						});
					} catch (_e) { /* skip broken draft */ }
				}
				return manifest;
			}
			function captureBlobs(conv, manifest) {
				if (!conv || !conv.draftAttachments) return Promise.resolve();
				var jobs = [];
				for (var i = 0; i < manifest.length; i++) {
					(function (m) {
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
					(function (aid) { jobs.push(idbDelete(aid).catch(function () {})); })(manifest[i].aid);
				}
				return Promise.allSettled(jobs);
			}
			function workspaceIdOf(sessionId) {
				return tryRun(function () {
					var items = workspaces.list.getSnapshot().items;
					for (var i = 0; i < items.length; i++) {
						var w = items[i];
						if (Array.isArray(w.sessionIds) && w.sessionIds.indexOf(sessionId) !== -1) return w.workspaceId;
					}
					return undefined;
				});
			}

			function persistEntry(entry, conv) {
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
				journalPush({ op: existed ? "update" : "create", id: entry.sessionId, reason: "leave", name: entry.name });
				var capture = captureBlobs(conv, entry.attachments);
				recomputeDerived();
				return capture;
			}
			/** 物理删除不可用时的回退：DSH 原生归档（可恢复，不会丢数据）。 */
			function archiveFallback(sessionId, detail) {
				journalPush({ op: "archive-fallback", id: sessionId, detail: String(detail || "").slice(0, 120) });
				if (typeof workspaces.archiveSession === "function") {
					return Promise.resolve().then(function () {
						return workspaces.archiveSession(sessionId);
					}).then(function () {
						return { deleted: true, via: "archive" };
					}).catch(function (error) {
						console.warn("[dsh-pending-session] archive failed:", error);
						return { deleted: false, via: "archive-failed", reason: "archive-error" };
					});
				}
				return { deleted: false, via: "archive-unavailable", reason: "missing-seam" };
			}
			/**
			 * 会话善后：优先调用「会话归档管理」插件
			 * （@linxin666/dsh-session-archive）的物理删除接口，真正删掉会话日志、
			 * 投影缓存、工作区记账与活会话；接口不可用（未安装 / 非回环 / 忙 / 响应
			 * 不是预期结构）时退回 DSH 原生归档。
			 * 返回 { deleted, via, reason }：deleted=false 表示会话仍在（受保护或已归档），
			 * 调用方据此决定是否清理本地条目——绝不能「会话还在但条目没了」。
			 */
			function disposeSession(sessionId, reason) {
				var physical = reason === "manual";
				if (!physical) return Promise.resolve(archiveFallback(sessionId, "non-manual"));
				return attemptPhysicalDelete(sessionId, DELETE_ATTEMPTS);
			}
			/**
			 * 物理删除一次尝试；`attached`（宿主进程仍持有该会话）会等待后重试，
			 * `not-found`（磁盘上没有该会话的存储——只有草稿的空白会话就是这种）
			 * 视为「已无可删数据」直接成功，避免用户点了删除却毫无反应。
			 */
			/** 我们自己的删除器（宿主半边 index.js）。返回 undefined = 端点不可用，走第三方兜底。 */
			function ownDelete(sessionId) {
				return Promise.resolve().then(function () {
					if (typeof fetch !== "function") return undefined;
					return fetch(OWN_DELETE_PATH, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ ids: [sessionId] })
					});
				}).then(function (response) {
					if (response === undefined || response.ok === false) return undefined;
					return response.json().then(function (body) {
						if (body === null || typeof body !== "object" || body.ok !== true || !Array.isArray(body.results)) return undefined;
						var row = null;
						for (var i = 0; i < body.results.length; i++) {
							var item = body.results[i];
							if (item !== null && typeof item === "object" && item.id === sessionId) { row = item; break; }
						}
						if (row === null) return undefined;
						if (row.status === "ok") {
							journalPush({ op: "own-delete", id: sessionId });
							return { deleted: true, via: "own" };
						}
						if (String(row.reason || "") === "not-found") {
							journalPush({ op: "delete-absent", id: sessionId });
							return { deleted: true, via: "absent" };
						}
						journalPush({ op: "delete-blocked", id: sessionId, reason: String(row.reason || row.status) });
						return { deleted: false, via: "refused", reason: String(row.reason || row.status) };
					});
				}).catch(function () { return undefined; });
			}
			/** 先用自己的删除器；端点不可用时退回第三方（其不可用则归档）。 */
			function attemptPhysicalDelete(sessionId, attemptsLeft) {
				return ownDelete(sessionId).then(function (own) {
					if (own !== undefined) return own;
					return archiveDelete(sessionId, attemptsLeft);
				});
			}
			function archiveDelete(sessionId, attemptsLeft) {
				var current = mainIdOf(rawSnapshot());
				var payload = current === undefined || current === sessionId
					? { ids: [sessionId] }
					: { ids: [sessionId], currentSessionId: current };
				return Promise.resolve().then(function () {
					if (typeof fetch !== "function") throw new Error("fetch unavailable");
					return fetch(ARCHIVE_DELETE_PATH, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(payload)
					});
				}).then(function (response) {
					if (response === undefined || response.ok === false) {
						throw new Error("http " + (response === undefined ? "none" : String(response.status)));
					}
					return response.json();
				}).then(function (body) {
					// 只认归档管理插件的真实响应结构，避免被 SPA 404 回退页面骗过
					var valid = body !== null && typeof body === "object" &&
						Array.isArray(body.results) && typeof body.freedBytes === "number";
					if (!valid) throw new Error("unexpected delete response");
					var result = null;
					for (var i = 0; i < body.results.length; i++) {
						var row = body.results[i];
						if (row !== null && typeof row === "object" && row.id === sessionId) { result = row; break; }
					}
					if (result === null) throw new Error("no result for session");
					if (result.status === "ok") {
						journalPush({ op: "physical-delete", id: sessionId });
						return { deleted: true, via: "physical" };
					}
					var why = String(result.reason || result.status);
					if (why === "not-found") {
						// 磁盘上没有存储（例如只有草稿、从未落盘的空白会话）：没有可删的东西
						journalPush({ op: "delete-absent", id: sessionId });
						return { deleted: true, via: "absent" };
					}
					if (why === "attached" && attemptsLeft > 0) {
						// 宿主进程还持有：等它释放（切走主会话后通常几百毫秒内释放）
						return delay(DELETE_RETRY_MS).then(function () {
							return archiveDelete(sessionId, attemptsLeft - 1);
						});
					}
					journalPush({ op: "delete-blocked", id: sessionId, reason: why });
					return { deleted: false, via: "refused", reason: why };
				}).catch(function (error) {
					return archiveFallback(sessionId, error && error.message ? error.message : error);
				});
			}
			/**
			 * 读某个会话当前被谁持有（客户端本地引用计数，纯读、无副作用）。
			 * 宿主只在本地引用归零后才会释放该会话，所以删除前要等它归零。
			 */
			function retainSources(sessionId) {
				var state = tryRun(function () {
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
				});
				return state === undefined ? { count: 0, text: "" } : state;
			}
			/** 等本地引用归零（例如切走主会话后 ui-workspace 会释放 mainView 持有）。 */
			function waitRelease(sessionId, attempts) {
				var state = retainSources(sessionId);
				if (state.count === 0 || attempts <= 0) return Promise.resolve(state);
				return delay(250).then(function () { return waitRelease(sessionId, attempts - 1); });
			}
			/**
			 * 血泪教训（用户实测 A/B 得出）：绝不要为了「让宿主释放会话」而调用
			 * sessions.using/retain。它会把会话在宿主上物化（打开），而释放并不会
			 * 让宿主关闭它 —— 该会话从此永久 attached，连归档插件自己的删除也一起
			 * 失败。这里只允许只读操作：retainInfo 读引用、以及 expectedTotal:0 的
			 * 只读探测（计划不匹配即中止，不会真删）。
			 */
			/** 只读探测：该会话此刻是否可删（计划不匹配会 409 中止，绝不真删）。 */
			function canDeleteNow(sessionId) {
				return Promise.resolve().then(function () {
					if (typeof fetch !== "function") return false;
					return fetch(ARCHIVE_DELETE_PATH, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ ids: [sessionId], expectedTotal: 0 })
					});
				}).then(function (response) {
					// 409 = 有可删目标（宿主不再持有），其余情况都视为还不能删
					return response !== undefined && response.status === 409;
				}).catch(function () { return false; });
			}
			/** 关闭 + 等待宿主释放（可删）为止。 */
			function waitDeletable(sessionId, attempts) {
				return canDeleteNow(sessionId).then(function (ready) {
					if (ready || attempts <= 0) return ready;
					return delay(300).then(function () { return waitDeletable(sessionId, attempts - 1); });
				});
			}
			/**
			 * 删除一个会话（普通对话或待执行条目都适用）：先切走主会话并等本地引用
			 * 归零，再物理删除（归档管理插件，失败则回退归档），最后做本地清理。
			 */
			function performDelete(sessionId) {
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
				var leaveFirst = wasMain && uiWorkspace && typeof uiWorkspace.startSession === "function"
					? Promise.resolve().then(function () {
						try { uiWorkspace.startSession(workspaceId); } catch (_e) { /* ignore */ }
						return undefined;
					})
					: Promise.resolve();
				return leaveFirst.then(function () {
					return waitRelease(sessionId, 3);
				}).then(function (held) {
					// 不再等第三方插件的「可删」判定：我们自己删，直接执行（省掉那 1.5 秒轮询）
					journalPush({ op: "delete-prep", id: sessionId, held: held.text, count: held.count });
					return disposeSession(sessionId, "manual").then(function (outcome) {
						if (outcome !== undefined && outcome.deleted === false) {
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
					// 删除成功：立刻把它从投影里摘掉（宿主内存里的残影等重启自然消失）
					removedIds.add(sessionId);
					var live = registry.entries[sessionId];
					if (live !== undefined) {
						delete registry.entries[sessionId];
						saveRegistry(registry);
						publishState();
						clearConversationDraft(sessionId);
						dropBlobs(live.attachments);
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
					jobs.push(disposeSession(sessionId, reason || "manual"));
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
				return tryRun(rawGet) || { byId: {}, ids: [] };
			}
			function project(snap) {
				// 已被我们删掉的会话：宿主内存里可能还留着它（行会一直显示到重启），
				// 这里直接从投影里摘掉，让删除立刻在界面上生效。
				if (removedIds.size > 0 && snap !== null && typeof snap === "object" && Array.isArray(snap.ids)) {
					var keptIds = [];
					for (var ri = 0; ri < snap.ids.length; ri++) {
						if (!removedIds.has(snap.ids[ri])) keptIds.push(snap.ids[ri]);
					}
					if (keptIds.length !== snap.ids.length) {
						var keptById = {};
						for (var rk in snap.byId) {
							if (!removedIds.has(rk)) keptById[rk] = snap.byId[rk];
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
					if (!store || typeof store.getSnapshot !== "function") return;
					if (patchedStores.has(store)) return;
					patchedStores.add(store);
					// 自愈：优先用 store 上记录的「已知原始方法」，避免重挂载时层层叠加
					var origGet = store.__dpsOriginalGet && typeof store.__dpsOriginalGet === "function"
						? store.__dpsOriginalGet
						: store.getSnapshot.bind(store);
					if (store.__dpsOriginalGet === undefined) {
						store.__dpsOriginalGet = origGet;
					}
					patchedRecords.push({ store: store, origGet: origGet });
					rawGet = function () { return origGet(); };
					// 关键：只替换 getSnapshot 为「带缓存的按需投影」，不替换 subscribe。
					// 早于本插件订阅的消费者（ui-session 等）在通知里读 getSnapshot，
					// 原始引用已变 → 立即拿到最新投影（不会慢一拍）；而重复读取在无变化
					// 时返回同一对象（满足 React 引用稳定性）。
					store.getSnapshot = function () {
						try { return projectedSnapshot(); } catch (_e) { return origGet(); }
					};
				} catch (_e) { /* ignore */ }
			}
			/** 卸载/热更新前还原被包装的 store 方法，避免残留投影。 */
			function restorePatch() {
				for (var i = 0; i < patchedRecords.length; i++) {
					var rec = patchedRecords[i];
					try {
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

			function startMirroring(id) {
				mirrorDispose();
				mirrorDispose = function () {};
				mirrorActive = false;
				if (id === undefined) return;
				var shell = shellFor(id);
				if (shell === undefined) return;
				mirrorActive = true;
				var wasQualified = false;
				var handler = function () {
					var snap = shell.state.getSnapshot();
					var conv = rootConversation();
					var manifest = draftManifest(conv, snap.attachmentIds || []);
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
					saveTimer = setTimeout(function () {
						var mirror = activeMirror.value;
						if (mirror === null || mirror.sessionId !== id) return;
						saveActive({ sessionId: mirror.sessionId, savedAt: mirror.savedAt, text: mirror.text, manifest: mirror.manifest });
						if (!sameManifest(mirror.manifest, lastSavedManifest)) {
							lastSavedManifest = mirror.manifest;
							captureBlobs(conv, mirror.manifest);
						}
					}, DEBOUNCE_MS);
				};
				mirrorDispose = shell.state.subscribe(handler);
				handler();
			}

			var blankStrikes = new Map();
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
				} catch (_e) { /* ignore */ }
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
						var missing = (blankStrikes.get(id) || 0) + 1;
						blankStrikes.set(id, missing);
						if (missing < 2) continue;
						blankStrikes.delete(id);
						delete registry.entries[id];
						changed = true;
						journalPush({ op: "delete", id: id, reason: "row-missing" });
						continue;
					}
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
						var strikes = (blankStrikes.get(id) || 0) + 1;
						blankStrikes.set(id, strikes);
						if (strikes < 2) continue;
						blankStrikes.delete(id);
						// 已执行转正：立刻转为普通对话记录
						var customName = entry.name !== DEFAULT_NAME ? entry.name : undefined;
						delete registry.entries[id];
						changed = true;
						journalPush({ op: "delete", id: id, reason: "executed" });
						if (customName !== undefined) {
							// 延迟重命名，尽量落在自动命名之后
							setTimeout(function () {
								tryRun(function () {
									return sessions.using(id, { source: "pendingExecuteRename" }, function (reference) {
										return reference.binding.session.rename(customName);
									});
								});
							}, 2000);
						}
					} else {
						blankStrikes.delete(id);
					}
				}
				if (changed) {
					saveRegistry(registry);
					publishState();
					recomputeDerived();
				}
			}

			var inSwitch = false;
			function handleMainSwitch(from, to) {
				if (inSwitch) return;
				inSwitch = true;
				try {
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
				activeMirror.value = null;
				lastSavedManifest = null;
				startMirroring(to);
				// 主会话变了（cwd 隔离的目标随之变化）：让投影缓存失效并重新通知
				recomputeDerived();
				} finally {
					inSwitch = false;
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
					adoptOrphanBlanks(snap);
					adoptHostTitle(snap);
					var main = mainIdOf(snap);
					if (main !== lastMain) {
						var previous = lastMain;
						// 先占位再执行：handleMainSwitch 里同步触发的派生视图重算
						// 会重入本回调，占位后重入直接短路，避免无限递归
						lastMain = main;
						handleMainSwitch(previous, main);
					}
				} catch (error) {
					console.error("[dsh-pending-session] list handler failed:", error);
				}
			}
			var listUnsub = sessions.list.subscribe(onListChange);

			// 归档（原生「归档」或行菜单）不再删除条目：与其他会话一致，归档只是在
			// 默认视图里隐藏，条目与草稿都保留，用户可在「归档会话」视图里找回并恢复。
			// 这里只做一次可见性刷新，让投影把归档行交给归档过滤器处理。
			var workspacesUnsub = workspaces.list.subscribe(function () {
				try {
					var arch = workspaces.list.getSnapshot().archivedSessionIds || [];
					var set = new Set(arch);
					var changed = false;
					for (var id in registry.entries) {
						if (set.has(id)) {
							changed = true;
							journalPush({ op: "archived-visible", id: id });
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
				if (!entry || !Array.isArray(entry.attachments) || entry.attachments.length === 0) return;
				var tries = attempt === undefined ? 0 : attempt;
				if (tries > 3) return;
				try {
					var conv = rootConversation();
					if (conv === undefined) return;
					var shell = shellFor(sessionId);
					if (shell === undefined) {
						// shell 可能晚于横幅物化：稍后重试
						setTimeout(function () { restorePending(sessionId, entry, tries + 1); }, 500);
						return;
					}
					var current = shell.state.getSnapshot().attachmentIds || [];
					var storedAids = entry.attachments.map(function (m) { return m.aid; });
					for (var i = 0; i < current.length; i++) {
						if (storedAids.indexOf(current[i]) !== -1) return; // 已就位
					}
					var pending = entry.attachments.slice();
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
						}).catch(function (error) {
							console.error("[dsh-pending-session] attachment restore failed:", error);
						});
					})();
				} catch (error) {
					console.error("[dsh-pending-session] attachment restore failed:", error);
				}
			}

			// ---- 插槽注册 ----
			tryRun(function () {
				slots.inject("conversation.input.dock", function () {
					return slots.register({
						name: "conversation.input.dock",
						id: "pending-banner",
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
			});
			tryRun(function () {
				slots.inject("sidebar.session.row.leading", function () {
					return slots.register({
						name: "sidebar.session.row.leading",
						id: "pending-mark",
						order: 10,
						locale: NS,
						inject: function () {
							return { hooks: { pending: state } };
						}
					}, PendingRowLeading);
				});
			});
			tryRun(function () {
				slots.inject("sidebar.workspaces.session.menu.item", function* () {
					// 重命名不再单独提供菜单项：DSH 原生「重命名」（以及双击行标题）
					// 已由 adoptHostTitle 同步到条目名字。这里提供统一的「删除会话」，
					// 对所有会话可用（待执行条目显示为「删除待执行」）。
					yield slots.register({
						name: "sidebar.workspaces.session.menu.item",
						id: "delete-session",
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
			});
			tryRun(function () {
				slots.inject("shell.overlay", function () {
					return slots.register({
						name: "shell.overlay",
						id: "pending-rename-dialog",
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
			});
			tryRun(function () {
				slots.inject("shell.overlay", function () {
					return slots.register({
						name: "shell.overlay",
						id: "delete-session-dialog",
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
			});

			// ---- 清理 ----
			ctx.effect(function () {
				return function () {
					clearInterval(sweepTimer);
					clearTimeout(saveTimer);
					mirrorDispose();
					// 卸载前落盘一次
					var mirror = activeMirror.value;
					if (mirror !== null && mirror.sessionId !== undefined) {
						saveActive({ sessionId: mirror.sessionId, savedAt: Date.now(), text: mirror.text, manifest: mirror.manifest });
					}
					// 还原被包装的 sessions.list 并切断订阅，避免残留派生视图
					try { listUnsub(); } catch (_e) { /* ignore */ }
					try { workspacesUnsub(); } catch (_e) { /* ignore */ }
					if (beforeUnloadHandler !== null && typeof window !== "undefined") {
						try { window.removeEventListener("beforeunload", beforeUnloadHandler); } catch (_e) { /* ignore */ }
					}
					restorePatch();
				};
			}, "dsh-pending-session: dispose");

			// 初始触发（列表可能已就绪）
			onListChange();
		}

		/** 客户端注入（cordis fiber inject）。 */
		var inject = ["slots", "sessions", "workspaces", "locale"];

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
