// dsh-workspace-mover — client half（source-as-product，无需构建）
//
// 在侧边栏工作区树上启用「跨工作区拖拽迁移会话」：
// - 拖起一个会话行（div[role=treeitem][aria-selected]）→ 悬停到其他工作区的标题行
//   （div[role=treeitem][aria-expanded]）→ 松手弹出确认框 → 调用 host RPC 执行真迁移。
// - 只依赖语义化 ARIA 属性定位行，不碰官方 CSS-module 哈希类名，升级更抗造。
// - 官方同组内拖拽排序完全不受影响（我们的 drop 处理只拦截「跨组」场景）。
window.__ModuleLoader__.load({
	id: "dsh-workspace-mover",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const React = require("react");

		const CHANNEL = "/workspace-mover";
		const STYLE_ID = "dsh-workspace-mover-style";

		const STRINGS = {
			zh: {
				confirmTitle: "跨工作区移动会话",
				target: "目标工作区",
				session: "会话",
				hint: "将物理搬移原始会话档案并改写归属；历史记录原样保留，不产生副本。",
				move: "移动",
				cancel: "取消",
				moving: "正在移动…",
				done: "✓ 已移动到「{title}」；若侧边栏未自动刷新，请手动刷新页面",
				rolledBack: "已自动回滚：{msg}",
				failed: "移动失败：{msg}",
				noTarget: "无法识别目标工作区（侧边栏结构变化？）",
				ungroupedUnsupported: "暂不支持移动到「未分组」",
				staleList: "工作区列表与侧边栏不一致，请重试",
				restartHint: "缓存失效失败：归属可能需要重启 Harness 后才刷新",
				rescueSection: "会话修复",
				rescueTitle: "会话修复",
				rescueShort: "扫描全部会话档案，找回在侧边栏里「消失」或没有分组的会话。",
				rescueDetail: "两种常见情况：\n\n① 路径失效 —— 会话原来所在的文件夹被移动、改名或删除，侧边栏里就看不到它了（文件其实还在）。选一个分组点「移入该分组」，完整历史会原样搬过去。\n\n② 未归组 —— 会话文件完好，只是还没归入任何工作区分组。点「归入分组」即可修好，文件不会移动。\n\n每次操作前都会自动备份，失败自动回滚。",
				scan: "重新扫描",
				scanning: "扫描中…",
				scannedN: "共 {n} 个会话档案",
				orphanedCaption: "找不到原文件夹的会话",
				unregCaption: "还没归入分组的会话",
				stalePath: "路径失效",
				ungroupedBadge: "未归组",
				unreadable: "无法读取",
				ghostsTitle: "名单里有、但文件已不在的记录",
				ghostsHelp: "侧边栏的分组名单里记着这些会话，但对应的记录文件已经不在磁盘上（通常是被手动删除的）。一般不影响使用；重启 Harness 后通常会自动清理。",
				helpPath: "会话原来的文件夹被移动、改名或删除，所以侧边栏看不到它。选择一个分组，历史会原样迁移过去，会话 ID 保持不变。",
				helpUnreg: "会话文件完好，只是还没有归属到任何工作区分组。点击按钮即可归入匹配的分组，文件不会移动。",
				pickTarget: "请先在下拉框选择要移入的分组",
				relinkBtn: "移入该分组",
				attachBtn: "归入分组",
				relinked: "✓ 已迁入「{title}」，历史原样保留",
				attachedMsg: "✓ 已归入「{ws}」",
				selfHealed: "✓ 它本来就属于这个分组，已自动补好归属记录",
				allClear: "一切正常，没有需要修复的会话。",
				allWorkspaces: "选择要移入的分组…",
				historySection: "最近移动",
				historyHelp: "这里记录最近的跨工作区移动。点「撤回」会把会话移回原来的分组；撤回也会自动备份，失败不会丢数据。",
				undoBtn: "撤回",
				undoConfirm: "确定把这个会话移回原来的分组吗？",
				undone: "✓ 已撤回移动",
				historyEmpty: "还没有移动记录。",
				unnamedSession: "未命名会话",
				wsSection: "工作区体检",
				wsHelp: "「路径失效」表示这个分组登记的文件夹已经在磁盘上被移动、改名或删除——它名下的会话也因此从侧边栏消失。在新路径栏填入文件夹现在的位置并点「搬家」：工作区原地改指向，名下全部会话连同仍留在旧位置的失联散件一起原样搬过去；每一步都先备份、失败自动回滚。中途被打断也不必重来：空闲后用同样的新路径再跑一次，向导只处理剩余部分。",
				wsBadges: "路径失效",
				wsMemberLine: "{n} 个会话记账在此",
				wsNewPathPh: "新路径：文件夹现在所在的完整路径",
				wizardBtn: "搬家",
				wsNeedPath: "请先在右侧输入框填写新的文件夹路径",
				wizardConfirm: "把「{title}」搬到这里吗？\n\n{from}\n→ {to}\n\n将原样迁移 {count} 个会话（ID 与历史不变），全程有备份保护。",
				wizardDone: "✓ 「{title}」已搬家，{n} 个会话已就位",
				wizardSkippedTail: "；另有 {n} 个本次跳过（运行中或异常），稍后用同样操作可续跑",
				batchConfirmTitle: "批量移动会话",
				batchHint: "将把 {count} 个会话真迁移到目标工作区；每个会话独立备份，失败自动回滚且不影响其余。",
				batchMove: "全部移动",
				batchDone: "✓ 成功 {n} 个",
				batchFailTail: "；{n} 个未移动（详见结果）",
				pickHint: "已选 {n} 个会话 · Ctrl+点击行可多选 · 拖到目标工作区标题行批量移动 · Esc 清空",
				pickCleared: "已清空多选",
				pickEscHint: "按 Esc 清空多选（输入框聚焦时无效）",
				groupMoveTitle: "把「{title}」的会话移到…",
				groupMoveHint: "整组会话将真迁移到目标分组；运行中的会话会被跳过并在结果中说明。",
				groupMoveEmpty: "这个分组下没有可移动的会话。"
			},
			en: {
				confirmTitle: "Move session across workspaces",
				target: "Target workspace",
				session: "Session",
				hint: "Physically relocates the original session archive; history stays intact, no copy is made.",
				move: "Move",
				cancel: "Cancel",
				moving: "Moving…",
				done: "✓ Moved to \"{title}\"; refresh the page if the sidebar does not update",
				rolledBack: "Rolled back automatically: {msg}",
				failed: "Move failed: {msg}",
				noTarget: "Cannot resolve target workspace (sidebar layout changed?)",
				ungroupedUnsupported: "Moving to \"Ungrouped\" is not supported yet",
				staleList: "Workspace list out of sync with the sidebar; try again",
				restartHint: "Cache invalidation failed: grouping may need a harness restart",
				rescueSection: "Session Repair",
				rescueTitle: "Session Repair",
				rescueShort: "Scan all session archives and recover conversations that vanished from the sidebar or lack a group.",
				rescueDetail: "Two common cases:\n\n① Stale path — the folder a session lived in was moved, renamed or deleted, so the sidebar can no longer show it (the file is still there). Pick a group and click \"Move there\"; the full history travels over with its ID intact.\n\n② Ungrouped — the session file is fine but belongs to no workspace group. One click files it into the matching group without touching any file.\n\nEvery operation is backed up first and rolled back automatically on failure.",
				scan: "Rescan",
				scanning: "Scanning…",
				scannedN: "{n} session archives",
				orphanedCaption: "Sessions whose original folder is gone",
				unregCaption: "Sessions not in any group yet",
				stalePath: "Stale path",
				ungroupedBadge: "Ungrouped",
				unreadable: "Unreadable",
				ghostsTitle: "Listed in groups but missing on disk",
				ghostsHelp: "These sessions are still recorded in group rosters, but their files are gone from disk (usually deleted by hand). Harmless in general; a harness restart normally cleans them up.",
				helpPath: "The folder this session lived in was moved, renamed or deleted, so the sidebar cannot show it. Pick a group — history moves over as-is and the session ID stays the same.",
				helpUnreg: "The session file is fine but no workspace claims it yet. Click to file it into the matching group; files are not moved.",
				pickTarget: "Pick a target group in the dropdown first",
				relinkBtn: "Move there",
				attachBtn: "File into group",
				relinked: "✓ Moved into \"{title}\"; history preserved as-is",
				attachedMsg: "✓ Filed under \"{ws}\"",
				selfHealed: "✓ It already belonged to this group; its accounting was repaired automatically",
				allClear: "All good — nothing to repair.",
				allWorkspaces: "Pick a group to move into…",
				historySection: "Recent moves",
				historyHelp: "These are recent cross-workspace moves. Undo sends a session back to its original group and uses the same backup and rollback protection.",
				undoBtn: "Undo",
				undoConfirm: "Send this session back to its original group?",
				undone: "✓ Move undone",
				historyEmpty: "No move history yet.",
				unnamedSession: "Untitled session",
				wsSection: "Workspace health",
				wsHelp: "\"Missing folder\" means the directory this group points to was moved, renamed or deleted on disk — which is also why its sessions vanished from the sidebar. Type the folder's current location and press \"Move home\": the workspace is re-pointed in place and every session under it — including stranded ones still at the old path — travels over intact. Each step backs up first and rolls back automatically. If the run is ever interrupted, simply run it again with the same new path; the wizard picks up only what remains.",
				wsBadges: "Missing folder",
				wsMemberLine: "{n} sessions accounted here",
				wsNewPathPh: "New path: full path of the folder's current location",
				wizardBtn: "Move home",
				wsNeedPath: "Type the new folder path into the input first",
				wizardConfirm: "Move \"{title}\" here?\n\n{from}\n→ {to}\n\n{count} sessions will be migrated as-is (IDs and history unchanged), with backup protection throughout.",
				wizardDone: "✓ \"{title}\" moved home — {n} sessions in place",
				wizardSkippedTail: "; {n} skipped this run (running or unusual) — repeat later with the same inputs to finish",
				batchConfirmTitle: "Move sessions in bulk",
				batchHint: "{count} sessions will be truly moved to the target workspace; each is backed up independently and failures roll back without touching the rest.",
				batchMove: "Move all",
				batchDone: "✓ {n} moved",
				batchFailTail: "; {n} not moved (see results)",
				pickHint: "{n} sessions picked · Ctrl+click rows to multi-select · drag onto a workspace header to move in bulk · Esc to clear",
				pickCleared: "Selection cleared",
				pickEscHint: "Press Esc to clear the multi-selection (not while typing in the composer)",
				groupMoveTitle: "Move sessions of \"{title}\" to…",
				groupMoveHint: "The whole group will be truly moved to the target; running sessions are skipped and noted in the result.",
				groupMoveEmpty: "No movable sessions in this group."
			}
		};
		const lang = (navigator.language || "en").toLowerCase().startsWith("zh") ? "zh" : "en";
		const t = (key, vars) => {
			let s = STRINGS[lang][key] ?? key;
			for (const [k, v] of Object.entries(vars ?? {})) s = s.replaceAll(`{${k}}`, String(v));
			return s;
		};

		function ensureStyle() {
			if (document.getElementById(STYLE_ID)) return;
			const style = document.createElement("style");
			style.id = STYLE_ID;
			// 全部颜色走宿主 dsw 设计令牌（定义在 body 上、随设置里的外观切换即时
			// 重解析），仅在令牌缺失时回退到浅色常量；无需监听主题变化。
			style.textContent = `
.wsm-drop-hint{outline:2px dashed var(--dsw-alias-state-business-primary,#4176e6)!important;outline-offset:-2px;border-radius:8px}
.wsm-picked{outline:2px solid var(--dsw-alias-state-business-primary,#4176e6)!important;outline-offset:-2px;border-radius:8px;background:var(--dsw-alias-interactive-bg-selected,rgba(65,118,230,.12))!important}
.wsm-pick-badge{flex:none;font-size:10px;line-height:1;padding:2px 6px;border-radius:99px;background:var(--dsw-alias-state-business-primary,#4176e6);color:var(--dsw-alias-label-primary-foreground,#fff);pointer-events:none}
.wsm-batch-count{position:fixed;left:12px;bottom:12px;z-index:2147483500;background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-primary,#111);border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));border-radius:10px;padding:8px 14px;font-size:12.5px;box-shadow:0 8px 24px rgba(0,0,0,.15)}
.wsm-overlay{position:fixed;inset:0;background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.35));z-index:2147483000;display:flex;align-items:center;justify-content:center;font-family:inherit}
.wsm-card{background:var(--dsw-specific-menu,#fff);color:var(--dsw-alias-label-primary,#111);
 border:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.12));border-radius:14px;min-width:340px;max-width:440px;
 padding:18px 20px;box-shadow:0 12px 40px rgba(0,0,0,.25)}
.wsm-title{font-size:15px;font-weight:600;margin-bottom:12px}
.wsm-row{font-size:13px;line-height:20px;margin:6px 0;word-break:break-all}
.wsm-label{color:var(--dsw-alias-label-secondary,#777)}
.wsm-hint{font-size:12px;color:var(--dsw-alias-label-tertiary,#999);margin-top:10px;line-height:17px}
.wsm-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:16px}
.wsm-btn{appearance:none;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.15));background:transparent;color:var(--dsw-alias-label-primary,#111);
 border-radius:8px;padding:6px 14px;font-size:13px;cursor:pointer}
.wsm-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05))}
.wsm-btn.primary{background:var(--dsw-alias-button-primary-fill,#111);color:var(--dsw-alias-label-primary-foreground,#fff);border-color:transparent}
.wsm-btn.primary:hover{background:var(--dsw-alias-button-primary-hover,#333)}
.wsm-btn:disabled{opacity:.5;cursor:default}
.wsm-toast{position:fixed;left:50%;transform:translateX(-50%);bottom:28px;z-index:2147483600;
 background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-primary,#111);
 border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));border-radius:10px;padding:9px 16px;font-size:13px;
 box-shadow:0 8px 24px rgba(0,0,0,.2);max-width:70vw}
.wsm-toast.err{border-color:var(--dsw-alias-state-error-primary,#dc2626)}
.wsm-panel{color:var(--dsw-alias-label-primary,#111)}
.wsm-panel h3{font-size:14px;font-weight:600;margin:0 0 8px}
.wsm-scanrow{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:10px 0 12px}
.wsm-btn.small{padding:4px 10px;font-size:12px}
.wsm-list{display:flex;flex-direction:column;gap:6px;margin-bottom:14px}
.wsm-item{display:flex;gap:8px;align-items:center;font-size:12.5px;padding:6px 9px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1));border-radius:8px;background:var(--dsw-alias-bg-layer-1,#fafafa)}
.wsm-mono{font-family:ui-monospace,Consolas,Menlo,monospace}
.wsm-badge{flex:none;font-size:11px;padding:1px 7px;border-radius:99px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.15));color:var(--dsw-alias-label-secondary,#666)}
.wsm-badge.err{color:var(--dsw-alias-state-error-primary,#dc2626);border-color:currentColor}
.wsm-cwd{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary,#999)}
.wsm-select{font:inherit;font-size:12px;background:var(--dsw-specific-input-major,#fff);color:var(--dsw-alias-label-primary,#111);border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.15));border-radius:6px;padding:3px 6px;max-width:220px}
.wsm-input{flex:1.4;min-width:170px;font:inherit;font-size:12px;background:var(--dsw-specific-input-major,#fff);color:var(--dsw-alias-label-primary,#111);border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.15));border-radius:6px;padding:3px 7px}
.wsm-input::placeholder{color:var(--dsw-alias-label-tertiary,#999)}
.wsm-note{margin-top:8px;font-size:12.5px;color:var(--dsw-alias-label-secondary,#666);white-space:pre-wrap;word-break:break-all}
.wsm-caption{display:flex;align-items:center;gap:5px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary,#666);margin-bottom:6px}
.wsm-help{flex:none;display:inline-flex;width:15px;height:15px;border-radius:50%;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.2));align-items:center;justify-content:center;font-size:10px;font-weight:400;color:var(--dsw-alias-label-tertiary,#999);cursor:help;user-select:none}
.wsm-history{margin-top:16px;padding-top:12px;border-top:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1))}
`;
			document.head.appendChild(style);
		}

		function toast(text, isError) {
			const el = document.createElement("div");
			el.className = "wsm-toast" + (isError ? " err" : "");
			el.textContent = text;
			document.body.appendChild(el);
			setTimeout(() => el.remove(), isError ? 7000 : 4200);
		}

		/** 行元素判定：会话行 vs 工作区标题行（基于 ARIA 语义，非哈希类名）。 */
		const sessionRow = (el) => el?.closest?.('div[role="treeitem"][aria-selected]');
		const headerRow = (el) => el?.closest?.('div[role="treeitem"][aria-expanded]');

			function injectOverlay() {
				const overlay = document.createElement("div");
				overlay.className = "wsm-overlay";
				overlay.innerHTML = `
<div class="wsm-card" role="dialog" aria-modal="true">
  <div class="wsm-title"></div>
  <div class="wsm-row"><span class="wsm-label"></span> <b class="wsm-session"></b></div>
  <div class="wsm-row"><span class="wsm-label"></span> <b class="wsm-target"></b></div>
  <div class="wsm-hint"></div>
  <div class="wsm-actions">
    <button class="wsm-btn wsm-cancel"></button>
    <button class="wsm-btn primary wsm-ok"></button>
  </div>
</div>`;
				const [rowS, rowT] = overlay.querySelectorAll(".wsm-row > .wsm-label");
				rowS.textContent = t("session") + "：";
				rowT.textContent = t("target") + "：";
				overlay.querySelector(".wsm-cancel").textContent = t("cancel");
				// 标题/正文/确认按钮文案由 confirmMove 按单条或批量场景写入
				return overlay;
			}

			function confirmMove({ sessionId, sessionTitle, workspace, batchCount }) {
				return new Promise((resolve) => {
					const overlay = injectOverlay();
					const okBtn = overlay.querySelector(".wsm-ok");
					overlay.querySelector(".wsm-title").textContent = batchCount ? t("batchConfirmTitle") : t("confirmTitle");
					overlay.querySelector(".wsm-session").textContent = batchCount
						? t("scannedN", { n: batchCount })
						: (sessionTitle || t("unnamedSession"));
					overlay.querySelector(".wsm-target").textContent = `${workspace.title}（${workspace.path}）`;
					overlay.querySelector(".wsm-hint").textContent = batchCount ? t("batchHint", { count: batchCount }) : t("hint");
					okBtn.textContent = batchCount ? t("batchMove") : t("move");
					const close = (value) => { overlay.remove(); document.removeEventListener("keydown", onKey); resolve(value); };
					const onKey = (e) => { if (e.key === "Escape") close(null); };
					document.addEventListener("keydown", onKey);
					overlay.addEventListener("click", (e) => { if (e.target === overlay) close(null); });
					overlay.querySelector(".wsm-cancel").addEventListener("click", () => close(null));
					okBtn.addEventListener("click", () => close(true));
					document.body.appendChild(overlay);
				});
			}

			/** 整组搬移对话框：选目标分组 → 确认。resolve(workspaceId) 或 resolve(null)。 */
			function confirmGroupMove({ workspace, workspaces, count }) {
				return new Promise((resolve) => {
					const overlay = injectOverlay();
					overlay.querySelector(".wsm-title").textContent = t("groupMoveTitle", { title: workspace.title });
					overlay.querySelector(".wsm-session").textContent = t("scannedN", { n: count });
					overlay.querySelector(".wsm-hint").textContent = t("groupMoveHint");
					const targetRow = overlay.querySelectorAll(".wsm-row")[1];
					targetRow.querySelector(".wsm-target").replaceWith((() => {
						const select = document.createElement("select");
						select.className = "wsm-select";
						select.style.maxWidth = "260px";
						select.append(new Option(t("allWorkspaces"), ""));
						for (const w of workspaces) {
							if (w.workspaceId === workspace.workspaceId) continue;
							select.append(new Option(`${w.title}（${w.path}）`, w.workspaceId));
						}
						return select;
					})());
					const okBtn = overlay.querySelector(".wsm-ok");
					okBtn.textContent = t("batchMove");
					okBtn.disabled = true;
					const select = overlay.querySelector("select.wsm-select");
					select.addEventListener("change", () => { okBtn.disabled = !select.value; });
					const close = (value) => { overlay.remove(); document.removeEventListener("keydown", onKey); resolve(value); };
					const onKey = (e) => { if (e.key === "Escape") close(null); };
					document.addEventListener("keydown", onKey);
					overlay.addEventListener("click", (e) => { if (e.target === overlay) close(null); });
					overlay.querySelector(".wsm-cancel").addEventListener("click", () => close(null));
					okBtn.addEventListener("click", () => close(select.value || null));
					document.body.appendChild(overlay);
					select.focus();
				});
			}

		//#region v0.3 设置页「会话修复」面板
		const { useState, useEffect } = React;
		const h = (tag, props, ...children) => React.createElement(tag, props ?? null, ...children);

		function shortId(id) {
			return String(id ?? "?").slice(0, 13) + "…";
		}

		function rowTitle(row, sessionId) {
			const text = row?.textContent?.replace(/\s+/g, " ").trim();
			return text && text !== sessionId ? text : t("unnamedSession");
		}

		/** 「?」悬浮说明按钮：hover/长按显示白话解释，不占版面。 */
		const HelpDot = ({ text }) => h("span", { className: "wsm-help", title: text }, "?");

		function Caption({ text, help }) {
			return h("div", { className: "wsm-caption" }, text, help ? h(HelpDot, { text: help }) : null);
		}

		function RescuePanel({ rpcCall }) {
			const [scan, setScan] = useState(null);
			const [workspaces, setWorkspaces] = useState([]);
			const [audit, setAudit] = useState(null);
			const [wsInputs, setWsInputs] = useState({});
			const [busy, setBusy] = useState(false);
			const [picked, setPicked] = useState({});
			const [note, setNote] = useState("");
			const [history, setHistory] = useState([]);

			const call = async (endpoint, payload) => {
				const res = await rpcCall(endpoint, payload ?? {});
				if (!res?.ok) throw new Error(res?.error?.message ?? endpoint);
				return res.value;
			};

			const runScan = async () => {
				setBusy(true);
				try {
					const [s, w, h, a] = await Promise.all([call("mover.scan"), call("mover.workspaces"), call("mover.history"), call("mover.ws.audit")]);
					setScan(s);
					setWorkspaces(w.items ?? []);
					setHistory(h.items ?? []);
					setAudit(a);
				} catch (err) {
					setNote(t("failed", { msg: err?.message ?? err }));
				} finally {
					setBusy(false);
				}
			};

			useEffect(() => { void runScan(); }, []);

			const relink = async (item) => {
				const target = picked[item.sessionId];
				if (!target) return void setNote(t("pickTarget"));
				setBusy(true);
				setNote("");
				try {
					const res = await rpcCall("mover.move", { sessionId: item.sessionId, sessionTitle: item.title, targetWorkspaceId: target });
					if (!res?.ok) throw new Error(res?.error?.message ?? "move failed");
					const wsTitle = workspaces.find((w) => w.workspaceId === target)?.title ?? "";
					setNote(res.value?.attached ? t("selfHealed") : t("relinked", { title: wsTitle }));
					await runScan();
				} catch (err) {
					setNote(t("failed", { msg: err?.message ?? err }));
				} finally {
					setBusy(false);
				}
			};

			const attach = async (item) => {
				setBusy(true);
				setNote("");
				try {
					const res = await call("mover.repair", { actions: [{ sessionId: item.sessionId, kind: "attach" }] });
					const r = res.results?.[0];
					if (!r?.ok) throw new Error(r?.error ?? "attach failed");
					const wsTitle = workspaces.find((w) => w.workspaceId === r.attachedTo)?.title ?? r.attachedTo ?? "";
					setNote(t("attachedMsg", { ws: wsTitle }));
					await runScan();
				} catch (err) {
					setNote(t("failed", { msg: err?.message ?? err }));
				} finally {
					setBusy(false);
				}
			};

			const undo = async (entry) => {
				if (!window.confirm(t("undoConfirm"))) return;
				setBusy(true);
				setNote("");
				try {
					const result = await call("mover.undo", { historyId: entry.id });
					setNote(t("undone"));
					await runScan();
				} catch (err) {
					setNote(t("failed", { msg: err?.message ?? err }));
				} finally {
					setBusy(false);
				}
			};

			// 工作区搬家向导：dryRun 盘点 → 原生确认框亮出起讫与数量 → 执行
			const repoint = async (row) => {
				const nextPath = String(wsInputs[row.workspaceId] ?? "").trim();
				if (!nextPath) return void setNote(t("wsNeedPath"));
				setBusy(true);
				setNote("");
				try {
					const dry = await call("mover.repoint", { workspaceId: row.workspaceId, fromPath: row.path, newPath: nextPath, dryRun: true });
					if (!window.confirm(t("wizardConfirm", { title: row.title, from: row.path, to: nextPath, count: dry.count }))) return;
					const res = await call("mover.repoint", { workspaceId: row.workspaceId, fromPath: row.path, newPath: nextPath });
					let message = t("wizardDone", { title: row.title, n: res.movedCount });
					if (res.skipped?.length > 0) message += t("wizardSkippedTail", { n: res.skipped.length });
					setNote(message);
					await runScan();
				} catch (err) {
					setNote(t("failed", { msg: err?.message ?? err }));
				} finally {
					setBusy(false);
				}
			};

			const items = scan?.items ?? [];
			const orphaned = items.filter((it) => it.status === "orphaned");
			const unregistered = items.filter((it) => it.status === "unregistered");
			const brokenWorkspaces = (audit?.items ?? []).filter((it) => it.status !== "ok");
			const counts = scan?.counts ?? {};
			const summaryParts = [
				["orphaned", t("stalePath")],
				["unregistered", t("ungroupedBadge")],
				["unreadable", t("unreadable")]
			].filter(([k]) => (counts[k] ?? 0) > 0).map(([k, label]) => `${label} ${counts[k]}`);

			return h("div", { className: "wsm-panel" },
				h("h3", null, t("rescueTitle"), " ", h(HelpDot, { text: t("rescueDetail") })),
				h("div", { style: { fontSize: "12.5px", lineHeight: "19px", color: "var(--dsw-alias-label-secondary,#666)" } },
					t("rescueShort")),
				h("div", { className: "wsm-scanrow" },
					h("button", { className: "wsm-btn small primary", disabled: busy, onClick: () => void runScan() }, busy ? t("scanning") : t("scan")),
					scan ? h("span", { style: { fontSize: "12.5px", color: "var(--dsw-alias-label-tertiary,#999)" } },
						t("scannedN", { n: scan.scanned }) + (summaryParts.length ? ` · ${summaryParts.join(" · ")}` : ""))
						: null
				),
				brokenWorkspaces.length > 0 ? h(Caption, { text: t("wsSection"), help: t("wsHelp") }) : null,
				brokenWorkspaces.length > 0 ? h("div", { className: "wsm-list" },
					brokenWorkspaces.map((row) => h("div", { className: "wsm-item", key: row.workspaceId },
						h("span", { className: "wsm-badge err" }, t("wsBadges")),
						h("b", { title: t("wsMemberLine", { n: row.memberCount }) }, row.title),
						h("span", { className: "wsm-cwd", title: row.path }, row.path),
						h("input",
							{
								className: "wsm-input", placeholder: t("wsNewPathPh"), disabled: busy,
								value: wsInputs[row.workspaceId] ?? "",
								onChange: (e) => setWsInputs((p) => ({ ...p, [row.workspaceId]: e.target.value }))
							}
						),
						h("button", { className: "wsm-btn small primary", disabled: busy, onClick: () => void repoint(row) }, t("wizardBtn"))
					))
				) : null,
				orphaned.length > 0 ? h(Caption, { text: t("orphanedCaption"), help: t("helpPath") }) : null,
				orphaned.length > 0 ? h("div", { className: "wsm-list" },
					orphaned.map((it) => h("div", { className: "wsm-item", key: it.sessionId },
							h("span", { className: "wsm-mono" }, it.title || t("unnamedSession")),
						it.archived ? h("span", { className: "wsm-badge" }, "archived") : null,
						h("span", { className: "wsm-cwd" }, it.cwd ?? "?"),
						h("select",
							{ className: "wsm-select", value: picked[it.sessionId] ?? "", onChange: (e) => setPicked((p) => ({ ...p, [it.sessionId]: e.target.value })) },
							h("option", { value: "" }, t("allWorkspaces")),
							workspaces.map((w) => h("option", { key: w.workspaceId, value: w.workspaceId }, `${w.title}（${w.path}）`))
						),
						h("button", { className: "wsm-btn small primary", disabled: busy || !picked[it.sessionId], onClick: () => void relink(it) }, t("relinkBtn"))
					))
				) : null,
				unregistered.length > 0 ? h(Caption, { text: t("unregCaption"), help: t("helpUnreg") }) : null,
				unregistered.length > 0 ? h("div", { className: "wsm-list" },
					unregistered.map((it) => h("div", { className: "wsm-item", key: it.sessionId },
							h("span", { className: "wsm-mono" }, it.title || t("unnamedSession")),
						it.archived ? h("span", { className: "wsm-badge" }, "archived") : null,
						h("span", { className: "wsm-cwd" }, it.cwd ?? "?"),
						h("button",
							{ className: "wsm-btn small", disabled: busy || !it.targetWorkspaceId, title: it.targetWorkspaceId ? undefined : t("allWorkspaces"), onClick: () => void attach(it) },
							t("attachBtn")
						)
					))
				) : null,
				h("div", { className: "wsm-history" },
					h(Caption, { text: t("historySection"), help: t("historyHelp") }),
					history.length > 0 ? h("div", { className: "wsm-list" }, history.slice(0, 20).map((entry) =>
						h("div", { className: "wsm-item", key: entry.id },
							h("span", { className: "wsm-mono" }, entry.title || t("unnamedSession")),
							h("span", { className: "wsm-cwd", title: `${entry.sessionId}: ${entry.from} → ${entry.to}` }, `${entry.from} → ${entry.to}`),
							h("button", { className: "wsm-btn small", disabled: busy || !entry.sourceWorkspaceId, title: entry.sourceWorkspaceId ? undefined : t("historyHelp"), onClick: () => void undo(entry) }, t("undoBtn"))
						)
					)) : h("div", { className: "wsm-note" }, t("historyEmpty"))
				),
				scan && orphaned.length === 0 && unregistered.length === 0 && items.length > 0
					? h("div", { className: "wsm-note" }, t("allClear"))
					: null,
				scan && scan.ghosts.length > 0 ? h("div", { style: { marginTop: "4px" } },
					h(Caption, { text: `${t("ghostsTitle")} (${scan.ghosts.length})`, help: t("ghostsHelp") }),
					h("div", { className: "wsm-list" },
						scan.ghosts.slice(0, 20).map((g) => h("div", { className: "wsm-item", key: `${g.workspaceId}/${g.sessionId}` },
							h("span", { className: "wsm-badge" }, g.workspaceId.slice(0, 8)),
							h("span", { className: "wsm-mono" }, shortId(g.sessionId))
						))
					)
				) : null,
				note ? h("div", { className: "wsm-note" }, note) : null
			);
		}

		function registerRescuePanel(ctx, rpcCall) {
			// 宿主无槽位系统时静默跳过（拖拽功能不受影响）
			if (typeof ctx.slots?.inject !== "function" || typeof ctx.slots?.register !== "function") return;
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "workspace-mover-rescue",
				order: 60,
				label: () => t("rescueSection"),
				inject: () => ({ rpcCall })
			}, RescuePanel));
		}
		//#endregion

		// slots：设置页「会话救援」面板需要；未注入时访问 ctx.slots 会被宿主拒绝
		var inject = ["connection", "slots"];

		function apply(ctx) {
			const rpcCall = (endpoint, payload) => ctx.connection.rpc.call(CHANNEL, endpoint, payload ?? {});
			let dragging = null; // {el, els, id} —— id 在 drop 阶段解析
			let wsCache = null; // {items, at}

			ensureStyle();

			// 状态仅作诊断：不硬性禁用拖拽（避免启动期竞态导致永久失效）。
			void rpcCall("mover.status").catch((err) => {
				console.warn("[workspace-mover] status probe failed (will retry per move):", err);
			});

			async function fetchWorkspaces() {
				if (wsCache && Date.now() - wsCache.at < 3000) return wsCache.items;
				const res = await rpcCall("mover.workspaces");
				if (!res?.ok) throw new Error(res?.error?.message ?? "workspace list unavailable");
				wsCache = { items: res.value.items, at: Date.now() };
				return wsCache.items;
			}

			function clearHints() {
				for (const el of document.querySelectorAll(".wsm-drop-hint")) el.classList.remove("wsm-drop-hint");
			}

			//#region 插件自建多选（宿主侧边栏没有多选模型）
			// Ctrl/Cmd+点击加入/移出、Shift+点击组内范围选择；拖动任一选中行 = 整批拖动。
			// 选中集存行元素（判定同步、零延迟）；会话 id 在点击/投放时经「分组对齐 +
			// 标题消歧」解析：组内 DOM 行顺序对齐 workspace.sessionIds 顺序，行文本与
			// mover.scan 的标题贪心匹配——躲开隐藏空白会话造成的纯序错位，失配退化为顺序。
			let pickBadge = null;
			const pickedRows = new Set();
			let lastPickedRow = null;
			let scanCache = null;

			async function fetchScan() {
				if (scanCache && Date.now() - scanCache.at < 5000) return scanCache.value;
				const res = await rpcCall("mover.scan");
				if (!res?.ok) throw new Error(res?.error?.message ?? "scan unavailable");
				scanCache = { value: res.value, at: Date.now() };
				return scanCache.value;
			}

			function visibleTreeitems() {
				return [...document.querySelectorAll('div[role="treeitem"]')].filter((el) => el.offsetParent !== null);
			}

			function validPickedRows() {
				for (const el of [...pickedRows]) {
					if (!el.isConnected || el.offsetParent === null) pickedRows.delete(el);
				}
				return [...pickedRows];
			}

			function refreshPickVisuals() {
				for (const el of document.querySelectorAll(".wsm-picked")) el.classList.remove("wsm-picked");
				for (const el of document.querySelectorAll(".wsm-pick-badge")) el.remove();
				const rows = validPickedRows();
				if (rows.length === 0) {
					pickBadge?.remove(); pickBadge = null;
					return;
				}
				for (const row of rows) row.classList.add("wsm-picked");
				pickBadge?.remove();
				pickBadge = document.createElement("div");
				pickBadge.className = "wsm-batch-count";
				pickBadge.textContent = t("pickHint", { n: rows.length });
				document.body.appendChild(pickBadge);
			}

			function clearSelection(quiet) {
				pickedRows.clear();
				lastPickedRow = null;
				refreshPickVisuals();
				if (!quiet) toast(t("pickCleared"));
			}

			/** 组标题行 → 其下可见会话行（DOM 顺序）。 */
			function groupSessionRows(header) {
				const all = visibleTreeitems();
				const at = all.indexOf(header);
				if (at < 0) return [];
				let end = all.length;
				for (let i = at + 1; i < all.length; i++) {
					if (headerRow(all[i])) { end = i; break; }
				}
				return all.slice(at + 1, end).filter((el) => sessionRow(el));
			}

			/**
			 * 把一组会话行对齐到 workspace.sessionIds：两指针顺序消费 + 行文本与
			 * scan 标题贪心匹配（空白会话被官方隐藏时不至于整体错位）。结果缓存进
			 * row.dataset.wsmId；返回 row→id 映射。
			 */
			async function mapGroupRows(ws, groupRows) {
				const titleOf = new Map();
				try {
					const scan = await fetchScan();
					for (const it of scan.items ?? []) titleOf.set(String(it.sessionId), String(it.title ?? "").replace(/\s+/g, " ").trim());
				} catch { /* scan 不可用时退化为纯顺序对齐 */ }
				const remaining = (ws.sessionIds ?? []).map(String);
				const out = new Map();
				for (const row of groupRows) {
					if (remaining.length === 0) break;
					const text = (row.textContent ?? "").replace(/\s+/g, " ").trim();
					let hit = -1;
					if (text && text !== t("unnamedSession")) {
						hit = remaining.findIndex((id) => { const tt = titleOf.get(id); return tt && tt.length > 0 && (tt === text || text.includes(tt) || tt.includes(text)); });
					}
					if (hit < 0) hit = 0;
					const id = remaining.splice(hit, 1)[0];
					row.dataset.wsmId = id;
					out.set(row, id);
				}
				return out;
			}

			/** 解析单个行元素（含所在组）的会话 id；解析失败返回 null。 */
			async function resolveRowId(rowEl) {
				if (rowEl?.dataset?.wsmId) return rowEl.dataset.wsmId;
				const items = await fetchWorkspaces();
				const header = (() => {
					const all = visibleTreeitems();
					const at = all.indexOf(rowEl);
					for (let i = at - 1; i >= 0; i--) if (headerRow(all[i])) return all[i];
					return null;
				})();
				if (!header) return null;
				const ws = resolveWorkspace(header, items);
				if (!ws) return null;
				const mapping = await mapGroupRows(ws, groupSessionRows(header));
				return mapping.get(rowEl) ?? null;
			}

			// Ctrl/Cmd+点击：加入/移出；Shift+点击：组内范围选择。普通点击不干预。
			document.addEventListener("click", async (e) => {
				const row = sessionRow(e.target);
				if (!row) return;
				const meta = e.ctrlKey || e.metaKey;
				if (!meta && !e.shiftKey) return;
				e.preventDefault();
				e.stopImmediatePropagation();
				try {
					const items = await fetchWorkspaces();
					const header = (() => {
						const all = visibleTreeitems();
						const at = all.indexOf(row);
						for (let i = at - 1; i >= 0; i--) if (headerRow(all[i])) return all[i];
						return null;
					})();
					const ws = header ? resolveWorkspace(header, items) : null;
					if (!ws) return void toast(t("noTarget"), true);
					const groupRows = groupSessionRows(header);
					const mapping = await mapGroupRows(ws, groupRows);
					if (meta) {
						if (pickedRows.has(row)) pickedRows.delete(row);
						else if (mapping.has(row)) { pickedRows.add(row); lastPickedRow = row; }
					} else if (e.shiftKey && lastPickedRow && groupRows.includes(lastPickedRow)) {
						const from = groupRows.indexOf(lastPickedRow);
						const to = groupRows.indexOf(row);
						for (const r of groupRows.slice(Math.min(from, to), Math.max(from, to) + 1)) {
							if (mapping.has(r)) pickedRows.add(r);
						}
					} else if (mapping.has(row)) {
						pickedRows.add(row);
						lastPickedRow = row;
					}
					refreshPickVisuals();
				} catch (err) {
					toast(t("failed", { msg: err?.message ?? err }), true);
				}
			}, true);

			// Esc 清空多选（输入框聚焦时不拦截，避免打断输入中的取消行为）
			document.addEventListener("keydown", (e) => {
				if (e.key !== "Escape" || pickedRows.size === 0) return;
				const el = document.activeElement;
				if (el?.tagName === "INPUT" || el?.tagName === "TEXTAREA" || el?.isContentEditable) return;
				clearSelection();
			});
			//#endregion

			/** 把 DOM 里第 i 个工作区标题行映射到注册表第 i 项（渲染顺序即注册表顺序）。 */
			function headerIndex(rowEl) {
				const rows = [...document.querySelectorAll('div[role="treeitem"][aria-expanded]')]
					.filter((el) => el.offsetParent !== null);
				return rows.indexOf(rowEl);
			}

			function resolveWorkspace(rowEl, items) {
				const text = rowEl?.textContent?.replace(/\s+/g, " ").trim() || "";
				if (/ungrouped|未分组/i.test(text)) return null;
				const byText = items.find((item) => {
					const title = String(item.title ?? "").trim();
					const path = String(item.path ?? "").trim();
					return (title && text.includes(title)) || (path && text.includes(path));
				});
				if (byText) return byText;
				const idx = headerIndex(rowEl);
				return idx >= 0 && idx < items.length ? items[idx] : null;
			}

			// dragstart：只做「元素判定」——拖起已多选的行 = 整批拖动，否则单选。
			// id 一律留到 drop 阶段解析（dataTransfer 只携带拖起这一行的 id）。
			document.addEventListener("dragstart", (e) => {
				try {
					const row = sessionRow(e.target);
					if (!row) { dragging = null; return; }
					const picked = validPickedRows();
					const els = picked.length > 1 && picked.includes(row) ? picked : [row];
					dragging = { els, el: row, id: null };
				} catch { dragging = null; }
			});

			document.addEventListener("dragover", (e) => {
				clearHints();
				if (!dragging) return;
				const header = headerRow(e.target);
				if (!header) return;
				e.preventDefault(); // 允许在此投放（没有它 drop 根本不会触发）
				header.classList.add("wsm-drop-hint");
			}, true);

			document.addEventListener("drop", async (e) => {
				const current = dragging;
				dragging = null;
				clearHints();
				if (!current) return;
				const header = headerRow(e.target);
				if (!header) return;
				// 只拦截「拖到某个工作区标题行」的场景；其余交还官方逻辑
				e.preventDefault();
				e.stopImmediatePropagation();

				// drop 事件的 dataTransfer 处于 readonly 模式，读取有保证（拖起这一行的 id）
				let draggedId = null;
				try {
					const transfer = e.dataTransfer;
					const candidates = [
						transfer?.getData("text/plain"),
						transfer?.getData("text/uri-list"),
						transfer?.getData("application/x-dsh-session-id")
					].filter(Boolean);
					draggedId = candidates.map((value) => String(value).trim().split(/[\r\n]/)[0]).find(Boolean) || null;
				} catch { draggedId = null; }
				if (!draggedId) {
					return void toast(t("failed", { msg: "unrecognized drag payload: empty" }), true);
				}

				let workspace = null;
				try {
					const items = await fetchWorkspaces();
					workspace = resolveWorkspace(header, items);
					if (!workspace) return void toast(t("staleList"), true);
				} catch (err) {
					return void toast(t("failed", { msg: err?.message ?? err }), true);
				}
				if (!workspace) return void toast(t("noTarget"), true);

				// ---- 组装移动清单：拖起行必有 id；多选行逐个经分组对齐解析 ----
				const picked = (current.els ?? [current.el]).filter((el) => el?.isConnected);
				const sessions = [];
				const seen = new Set();
				const push = (id, title) => {
					const key = String(id);
					if (!key || seen.has(key)) return;
					seen.add(key);
					sessions.push({ sessionId: key, sessionTitle: title || t("unnamedSession") });
				};
				if (picked.length > 1) {
					for (const el of picked) {
						if (el === current.el) continue; // 拖起行用 dataTransfer 的权威 id
						try { push(await resolveRowId(el), rowTitle(el, "")); } catch { /* 解析失败跳过 */ }
					}
				}
				// 权威 id 放首位；若某选中行被误映射到同一 id 会被去重吞掉
				push(draggedId, rowTitle(current.el, draggedId));

				if (sessions.length > 50) {
					return void toast(t("failed", { msg: `too many sessions in one batch (max 50, got ${sessions.length})` }), true);
				}

				// ---- 单选：原有确认与 mover.move 路径 ----
				if (sessions.length === 1) {
					const { sessionId, sessionTitle } = sessions[0];
					const confirmed = await confirmMove({ sessionId, sessionTitle, workspace });
					if (!confirmed) return;
					try {
						const res = await rpcCall("mover.move", { sessionId, sessionTitle, targetWorkspaceId: workspace.workspaceId });
						if (res?.ok) {
							toast(res.value?.attached ? t("selfHealed") : t("done", { title: workspace.title }));
							try { void ctx.get?.("workspaces")?.refresh?.(); } catch { /* ignore */ }
							if (res.value?.restartHint) setTimeout(() => toast(t("restartHint"), true), 1200);
						} else {
							const msg = res?.error?.message ?? "unknown";
							const text = (/roll/i.test(msg) ? t("rolledBack", { msg }) : t("failed", { msg }));
							toast(text, true);
						}
					} catch (err) {
						toast(t("failed", { msg: err?.message ?? err }), true);
					}
					return;
				}

				// ---- 多选：批量确认 + mover.moveMany（逐条独立备份回滚）----
				const confirmed = await confirmMove({ workspace, batchCount: sessions.length });
				if (!confirmed) return;
				try {
					const res = await rpcCall("mover.moveMany", { sessions, targetWorkspaceId: workspace.workspaceId });
					if (!res?.ok) {
						const msg = res?.error?.message ?? "unknown";
						return void toast((/roll/i.test(msg) ? t("rolledBack", { msg }) : t("failed", { msg })), true);
					}
					const { movedCount, attachedCount, failedCount } = res.value ?? {};
					const okCount = (movedCount ?? 0) + (attachedCount ?? 0);
					let message = t("batchDone", { n: okCount });
					if ((failedCount ?? 0) > 0) message += t("batchFailTail", { n: failedCount });
					toast(message);
					clearSelection(true);
					try { void ctx.get?.("workspaces")?.refresh?.(); } catch { /* ignore */ }
				} catch (err) {
					toast(t("failed", { msg: err?.message ?? err }), true);
				}
			}, true);

			document.addEventListener("dragend", () => { dragging = null; clearHints(); });

			// 工作区标题行右键：整组搬移（未分组/无法识别的行不干预，保留原生菜单）
			document.addEventListener("contextmenu", (e) => {
				const header = headerRow(e.target);
				if (!header) return;
				void (async () => {
					try {
						const items = await fetchWorkspaces();
						const workspace = resolveWorkspace(header, items);
						if (!workspace) return; // 未分组或识别失败：交还原生行为
						e.preventDefault();
						e.stopImmediatePropagation();
						const ids = (workspace.sessionIds ?? []).map(String);
						if (ids.length === 0) return void toast(t("groupMoveEmpty"), true);
						const targetId = await confirmGroupMove({ workspace, workspaces: items, count: ids.length });
						if (!targetId) return;
						const res = await rpcCall("mover.moveMany", {
							sessions: ids.map((id) => ({ sessionId: id })),
							targetWorkspaceId: targetId
						});
						if (!res?.ok) {
							const msg = res?.error?.message ?? "unknown";
							return void toast((/roll/i.test(msg) ? t("rolledBack", { msg }) : t("failed", { msg })), true);
						}
						const { movedCount, attachedCount, failedCount } = res.value ?? {};
						const okCount = (movedCount ?? 0) + (attachedCount ?? 0);
						let message = t("batchDone", { n: okCount });
						if ((failedCount ?? 0) > 0) message += t("batchFailTail", { n: failedCount });
						toast(message);
						try { void ctx.get?.("workspaces")?.refresh?.(); } catch { /* ignore */ }
					} catch (err) {
						toast(t("failed", { msg: err?.message ?? err }), true);
					}
				})();
			});

			registerRescuePanel(ctx, rpcCall);
		}

		module.exports = { inject, apply };
		return module.exports;
	}
});
