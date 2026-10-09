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
				misfiledCaption: "挂错分组的会话",
				misfiledHelp: "这些会话的真实文件夹属于另一个分组，却被记在别的分组名下（常见于克隆式迁移工具或改名后重建分组）。点「归位」只修正归属记录，文件不动。",
				misfiledLabel: "挂错分组",
				homeBtn: "归位",
				homeAllBtn: "全部归位",
				homeAllDone: "✓ 已归位 {n} 个会话",
				homedMsg: "✓ 已归位到「{ws}」",
				mergeDeleteConfirm: "整组 {count} 个会话已迁入「{target}」，源分组「{title}」已空。删除这个空分组吗？",
				mergeDone: "已删除空分组「{title}」",
				groupMoveMenu: "整组迁移…",
				stalePath: "路径失效",
				ungroupedBadge: "未归组",
				unreadable: "无法读取",
				ghostsTitle: "名单里有、但文件已不在的记录",
				ghostsHelp: "侧边栏的分组名单里记着这些会话，但对应的记录文件已经不在磁盘上（通常是被手动删除的）。一般不影响使用；重启 Harness 后通常会自动清理。",
				helpPath: "会话原来的文件夹被移动、改名或删除，所以侧边栏看不到它。选择一个分组，历史会原样迁移过去，会话 ID 保持不变。",
				helpUnreg: "会话文件完好，只是还没有归属到任何工作区分组。点击按钮即可归入匹配的分组，文件不会移动。",
				pickTarget: "请先在下拉框选择要移入的分组",
				idUnresolved: "无法识别要移动的会话（侧边栏结构或标题有变化），已取消本次移动。请刷新页面后重试。",
				idUnresolvedPartial: "有 {n} 行无法识别，将被跳过——本次只移动能确认身份的会话。",
				batchTooMany: "单次最多移动 {max} 个会话（本次 {n} 个）",
				dragPayloadBad: "无法读取拖拽内容（宿主版本变化？），已取消本次移动",
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
		batchEntryTitle: "批量移动 {n} 个会话",
		batchUndoPartial: "；{n} 个未能撤回（可重试）",
				pickHint: "已选 {n} 个会话 · Ctrl+点击行可多选 · 拖到目标工作区标题行批量移动 · Esc 清空",
				pickCleared: "已清空多选",
				groupMoveTitle: "把「{title}」的会话移到…",
				groupMoveHint: "整组会话将真迁移到目标分组；运行中的会话会被跳过并在结果中说明。",
				groupMoveEmpty: "这个分组下没有可移动的会话。",
				openFolderMenu: "打开文件夹",
				archivedCaption: "已归档的会话",
				archivedHelp: "这些会话被官方「归档」后从侧边栏消失，但文件和分组归属都还在。点「恢复」回到原来的分组，或选「恢复到…」换一个分组；恢复不会动文件。",
				archiveTruncated: "注意：扫描只解析了最新 {parsed} / {total} 个会话档案，较旧的归档会话可能不在此列表中。",
				restoreBtn: "恢复",
				restoreToBtn: "恢复到…",
				restorePickTitle: "把「{title}」恢复到…",
				restoreDone: "✓ 已恢复到「{ws}」",
				ownerGoneBadge: "原分组已删除",
				emptyWsCaption: "空分组",
				emptyWsHelp: "这些分组名下一个会话都没有（归档的、名单里的幽灵记录都算成员，绝不会误报）。删除只移除分组登记，不影响任何会话。",
				emptyWsDelete: "删除",
				emptyWsDeleteAll: "全部删除",
				emptyWsConfirmOne: "删除空分组「{title}」？\n\n{path}\n\n只移除分组登记，不影响任何会话。",
				emptyWsConfirmAll: "删除全部 {n} 个空分组？\n\n只移除分组登记，不影响任何会话。",
				emptyWsDone: "✓ 已删除 {n} 个空分组",
				emptyWsStale: "「{title}」刚刚有了新成员，已跳过",
				deleteBtn: "删除",
				deleteConfirm: "把「{title}」移入回收站？\n\n回收站里的会话随时可以还原或彻底删除。",
				deletedMsg: "✓ 已移入回收站",
				trashCaption: "回收站",
				trashHelp: "被删除的会话完整保留在这里（文件、标题、归属信息），可还原到原位置或任意其他分组；只有「彻底删除」才会真正清掉磁盘文件。",
				purgeBtn: "彻底删除",
				purgeConfirm: "彻底删除「{title}」？此操作不可撤销。",
				purgeAllBtn: "清空回收站",
				purgeAllConfirm: "彻底删除回收站里的全部 {n} 个会话？此操作不可撤销。",
				purgedMsg: "✓ 已彻底删除 {n} 项",
				purgeBackupsToo: "这个会话还有 {n} 份迁移备份。一并删除吗？\n\n（会话已不存在，这些备份不会再被用到；保留则可在备份列表里单独恢复或清理。）",
				purgeBackupsDone: "（含 {n} 份备份）",
				backupsCaption: "备份",
				backupsHelp: "每次迁移前自动生成的字节级备份都在这里。可以把会话恢复回备份时的原位置（若那里没有同 id 会话），或恢复到任意其他分组。",
				backupMeta: "{n} 份 · {size} · {range}",
				backupDeleteBtn: "删除备份",
				backupDeleteConfirm: "删除「{title}」的 {n} 份备份？删除后无法再从备份恢复。",
				backupDeletedMsg: "✓ 已删除 {n} 份备份",
				backupOrphanBadge: "孤儿",
				backupOrphanHelp: "这个会话的档案已经不存在了（通常是被彻底删除）。这些备份不会被任何操作再引用，可以安全清理。",
				backupOrphanSummary: "孤儿备份：{n} 组 · {size}（会话已不存在）",
				backupOrphanCleanup: "清理孤儿备份",
				backupOrphanConfirm: "删除 {n} 组孤儿备份（{size}）？这些会话已不存在，删除后无法从备份恢复。",
				backupOrphanPartial: "✓ 已删除 {n} 份，{f} 组失败（可重试）",
				residentRefuse: "该会话当前没有焦点也可能仍驻留在 Harness 内存中（归档只隐藏，不会卸载）。DSH 0.1.5 没有公开的按 ID 卸载接口，请重启 Harness 释放常驻会话后再删除。",
				sessionBusy: "该会话正在处理中（可能有迁移 / 还原 / 删除操作尚未完成），请稍后再试。",
				contextStale: "插件上下文已失效（客户端热重载导致）。请刷新页面（或重启应用）后重试，功能会自动恢复。",
				recoveryNote: "检测到 {n} 条自动回滚也失败的记录，需人工确认：会话文件与备份均保留在原处，未丢失。请勿手动清理 pluginData 目录，查看 recovery.json 或联系开发者处理。",
				doctorBtn: "自检",
				doctorChecking: "自检中…",
				doctorSummary: "自检完成：{pass} 通过 · {warn} 警告 · {fail} 失败",
				doctorHostRegistry: "工作区注册表服务",
				doctorHostPersistence: "会话持久化服务",
				doctorHostProjection: "投影缓存",
				doctorHostArchive: "归档通道",
				doctorHostAgents: "Agents 服务",
				doctorHostApproval: "审批接缝",
				doctorAgentTools: "Agent 工具",
				doctorDataRecycle: "回收站",
				doctorDataBackups: "备份目录",
				doctorDataHistory: "移动历史",
				doctorDataTasks: "任务记录",
				doctorRecovery: "恢复记录",
				doctorDataLayout: "存储布局",
				doctorWorkspaces: "工作区路径",
				repairAllBtn: "一键修复",
				repairAllDone: "✓ 已修复 {n} · 跳过 {s} · 失败 {f}",
				skipNeedsTarget: "需选择目标分组",
				filterPh: "筛选：标题 / 会话 ID / 路径…",
				tasksCaption: "迁移任务",
				tasksHelp: "批量迁移的持久化记录：完成 / 失败逐项可查。失败项可一键重试——按会话当前位置重新迁移，不会用记录里的旧路径；清除记录不影响已迁移的会话。",
				taskRetryBtn: "重试失败项",
				taskRetryDone: "✓ 重试完成：成功 {n} · 失败 {f}",
				taskForgetBtn: "清除记录",
				taskForgetConfirm: "清除这条任务记录？（不影响已迁移的会话）",
				taskForgottenMsg: "✓ 已清除记录",
				dataSummary: "数据保护：回收站 {r} 项（{rSize}）· 备份 {b} 份（{bSize}）",
				dataCleanupBtn: "清理 30 天前的数据",
				dataCleanupConfirm: "将清理 {r} 个回收站条目和 {b} 份备份（删除于 30 天前），释放 {size}。继续？",
				dataCleanedMsg: "✓ 已清理 {r} 个回收站条目、{b} 份备份，释放 {size}"
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
				misfiledCaption: "Sessions filed under the wrong group",
				misfiledHelp: "These sessions live in a folder that belongs to another group but are recorded elsewhere (common with clone-style movers or groups recreated after a folder rename). \"Home\" only fixes the bookkeeping; files are not touched.",
				misfiledLabel: "Misfiled",
				homeBtn: "Home",
				homeAllBtn: "Home all",
				homeAllDone: "✓ {n} sessions homed",
				homedMsg: "✓ Homed to \"{ws}\"",
				mergeDeleteConfirm: "{count} sessions moved to \"{target}\" and the source group \"{title}\" is now empty. Delete this empty group?",
				mergeDone: "Deleted empty group \"{title}\"",
				groupMoveMenu: "Move whole group…",
				stalePath: "Stale path",
				ungroupedBadge: "Ungrouped",
				unreadable: "Unreadable",
				ghostsTitle: "Listed in groups but missing on disk",
				ghostsHelp: "These sessions are still recorded in group rosters, but their files are gone from disk (usually deleted by hand). Harmless in general; a harness restart normally cleans them up.",
				helpPath: "The folder this session lived in was moved, renamed or deleted, so the sidebar cannot show it. Pick a group — history moves over as-is and the session ID stays the same.",
				helpUnreg: "The session file is fine but no workspace claims it yet. Click to file it into the matching group; files are not moved.",
				pickTarget: "Pick a target group in the dropdown first",
				idUnresolved: "Could not identify the session to move (sidebar structure or titles changed); this move was cancelled. Refresh the page and try again.",
				idUnresolvedPartial: "{n} row(s) could not be identified and will be skipped — this move only carries the sessions whose identity was confirmed.",
				batchTooMany: "At most {max} sessions per move (this one had {n})",
				dragPayloadBad: "Could not read the dragged content (host version change?); this move was cancelled",
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
		batchEntryTitle: "{n} sessions (batch move)",
		batchUndoPartial: "; {n} not undone (retry available)",
				pickHint: "{n} sessions picked · Ctrl+click rows to multi-select · drag onto a workspace header to move in bulk · Esc to clear",
				pickCleared: "Selection cleared",
				groupMoveTitle: "Move sessions of \"{title}\" to…",
				groupMoveHint: "The whole group will be truly moved to the target; running sessions are skipped and noted in the result.",
				groupMoveEmpty: "No movable sessions in this group.",
				openFolderMenu: "Open folder",
				archivedCaption: "Archived sessions",
				archivedHelp: "These sessions were hidden by the official \"archive\" action, but their files and group membership are intact. \"Restore\" sends them back to the original group, or \"Restore to…\" picks another one; restoring never touches files.",
				archiveTruncated: "Note: the scan parsed only the newest {parsed} of {total} session archives, so older archived sessions may be missing from this list.",
				restoreBtn: "Restore",
				restoreToBtn: "Restore to…",
				restorePickTitle: "Restore \"{title}\" to…",
				restoreDone: "✓ Restored to \"{ws}\"",
				ownerGoneBadge: "Original group deleted",
				emptyWsCaption: "Empty groups",
				emptyWsHelp: "These groups hold no sessions at all (archived ones and ghost roster entries count as members, so this never misreports). Deleting only removes the group registration; no session is touched.",
				emptyWsDelete: "Delete",
				emptyWsDeleteAll: "Delete all",
				emptyWsConfirmOne: "Delete empty group \"{title}\"?\n\n{path}\n\nOnly the group registration is removed; no session is touched.",
				emptyWsConfirmAll: "Delete all {n} empty groups?\n\nOnly the group registration is removed; no session is touched.",
				emptyWsDone: "✓ Deleted {n} empty group(s)",
				emptyWsStale: "\"{title}\" gained members just now; skipped",
				deleteBtn: "Delete",
				deleteConfirm: "Move \"{title}\" to the recycle bin?\n\nTrashed sessions can be restored or purged at any time.",
				deletedMsg: "✓ Moved to the recycle bin",
				trashCaption: "Recycle bin",
				trashHelp: "Deleted sessions are kept here whole (files, title, membership). Restore them to the original spot or any other group; only \"Purge\" actually deletes files from disk.",
				purgeBtn: "Purge",
				purgeConfirm: "Purge \"{title}\"? This cannot be undone.",
				purgeAllBtn: "Empty recycle bin",
				purgeAllConfirm: "Purge all {n} sessions in the recycle bin? This cannot be undone.",
				purgedMsg: "✓ Purged {n} item(s)",
				purgeBackupsToo: "This session still has {n} migration backup copy(ies). Delete them too?\n\n(The session no longer exists, so those backups will not be used again; keeping them lets you restore or clean them separately from the backup list.)",
				purgeBackupsDone: " (including {n} backup copy(ies))",
				backupsCaption: "Backups",
				backupsHelp: "Every move creates a byte-level backup first; they are all listed here. Restore a session back to where the backup was taken (if no session with the same id lives there), or into any other group.",
				backupMeta: "{n} copies · {size} · {range}",
				backupDeleteBtn: "Delete backups",
				backupDeleteConfirm: "Delete the {n} backup copies of \"{title}\"? They cannot be restored from afterwards.",
				backupDeletedMsg: "✓ Deleted {n} backup copy(ies)",
				backupOrphanBadge: "Orphan",
				backupOrphanHelp: "This session's archive no longer exists (usually purged). These backups are no longer referenced by any operation and can be cleaned safely.",
				backupOrphanSummary: "Orphan backups: {n} group(s) · {size} (session no longer exists)",
				backupOrphanCleanup: "Clean orphan backups",
				backupOrphanConfirm: "Delete {n} orphan backup group(s) ({size})? Those sessions no longer exist, so they cannot be restored from these backups afterwards.",
				backupOrphanPartial: "✓ Deleted {n}; {f} group(s) failed (retry available)",
				residentRefuse: "This session may remain resident in harness memory even when it is not focused (archiving hides it but does not unload it). DSH 0.1.5 exposes no public unload-by-ID API; restart the harness to release it, then delete it again.",
				sessionBusy: "This session is busy: a move / restore / delete is still in flight. Try again in a moment.",
				contextStale: "The plugin context went stale (client-side hot reload). Refresh the page (or restart the app) and the features will work again.",
				recoveryNote: "{n} record(s) need manual recovery: automatic rollback also failed. Session files and backups are all kept in place — nothing was lost. Do not clean the pluginData directory by hand; inspect recovery.json or contact the developer.",
				doctorBtn: "Doctor",
				doctorChecking: "Running checks…",
				doctorSummary: "Doctor finished: {pass} pass · {warn} warn · {fail} fail",
				doctorHostRegistry: "Workspace registry service",
				doctorHostPersistence: "Session persistence service",
				doctorHostProjection: "Projection cache",
				doctorHostArchive: "Archive channel",
				doctorHostAgents: "Agents service",
				doctorHostApproval: "Approval seam",
				doctorAgentTools: "Agent tools",
				doctorDataRecycle: "Recycle bin",
				doctorDataBackups: "Backups",
				doctorDataHistory: "Move history",
				doctorDataTasks: "Task records",
				doctorRecovery: "Recovery records",
				doctorDataLayout: "Storage layout",
				doctorWorkspaces: "Workspace paths",
				repairAllBtn: "Fix all",
				repairAllDone: "✓ Fixed {n} · skipped {s} · failed {f}",
				skipNeedsTarget: "needs a target group",
				filterPh: "Filter: title / session id / path…",
				tasksCaption: "Move tasks",
				tasksHelp: "Persistent records of bulk moves: every done / failed item is inspectable. Failed items can be retried in one click — retried from where each session currently lives, never from a stale recorded path; clearing a record never touches moved sessions.",
				taskRetryBtn: "Retry failed",
				taskRetryDone: "✓ Retry finished: {n} succeeded · {f} failed",
				taskForgetBtn: "Clear record",
				taskForgetConfirm: "Clear this task record? (moved sessions are not touched)",
				taskForgottenMsg: "✓ Record cleared",
				dataSummary: "Data protection: recycle bin {r} items ({rSize}) · backups {b} copies ({bSize})",
				dataCleanupBtn: "Clean data older than 30 days",
				dataCleanupConfirm: "This will purge {r} recycle entries and {b} backups (older than 30 days), freeing {size}. Continue?",
				dataCleanedMsg: "✓ Purged {r} recycle entries and {b} backups, freed {size}"
			}
		};
		const lang = (navigator.language || "en").toLowerCase().startsWith("zh") ? "zh" : "en";
		// 词条漂移防护：新增文案只补一种语言时，缺失的那一侧会静默回退成 key
		//（界面上直接显示 idUnresolved 这样的标识符）。启动时对账一次并告警。
		(() => {
			const keysOf = (l) => new Set(Object.keys(STRINGS[l] ?? {}));
			const zhKeys = keysOf("zh");
			const enKeys = keysOf("en");
			const onlyZh = [...zhKeys].filter((k) => !enKeys.has(k));
			const onlyEn = [...enKeys].filter((k) => !zhKeys.has(k));
			if (onlyZh.length || onlyEn.length) {
				console.warn("[workspace-mover] i18n key drift — missing in en:", onlyZh, "missing in zh:", onlyEn);
			}
		})();
		const t = (key, vars) => {
			let s = STRINGS[lang][key] ?? key;
			for (const [k, v] of Object.entries(vars ?? {})) s = s.replaceAll(`{${k}}`, String(v));
			return s;
		};
		// 桌面版热重载后旧 fiber 上的服务访问会抛 cordis 的 "inactive context"——
		// 换成可操作的提示文案，而不是让用户面对内部术语。
		const errMsg = (err) => {
			const raw = String(err?.message ?? err);
			return /inactive context/.test(raw) ? t("contextStale") : raw;
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
 /* 桌面版主题的 --dsw-specific-menu 是半透明玻璃色，浮层会和底层文字重叠——
    支持相对颜色语法的浏览器强制 alpha=1（不透明），旧内核保留上一行原样 */
 background:rgb(from var(--dsw-specific-menu,#fff) r g b / 1);
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
.wsm-badge.warn{color:var(--dsw-alias-state-warning-primary,#d97706);border-color:currentColor}
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

		/**
		 * 解析官方侧边栏的视图 store 实例（含 actions.syncSessionOrderAccount 与 getSnapshot）。
		 * 正式通道：sidebar.workspaces 槽位注册项自带 store 句柄，经 ctx.slots.resolveStore 取实例；
		 * 槽位通道不可用时兜底走 React fiber 爬升找官方组件 props。全部 fail-soft。
		 */
		function resolveViewStore(ctx) {
			try {
				const entry = ctx.slots?.entries?.("sidebar.workspaces")?.find?.((e) => e?.store);
				if (entry) return ctx.slots.resolveStore(entry.store);
			} catch { /* ignore */ }
			try {
				const anchor = document.querySelector('div[role="treeitem"][aria-expanded]');
				const fiberKey = anchor && Object.keys(anchor).find((k) => k.startsWith("__reactFiber$"));
				if (!fiberKey) return null;
				for (let fiber = anchor[fiberKey]; fiber; fiber = fiber.return) {
					const p = fiber.memoizedProps;
					if (p && typeof p.syncSessionOrderAccount === "function") {
						return {
							actions: { syncSessionOrderAccount: p.syncSessionOrderAccount },
							getSnapshot: () => ({
								orderBy: p.orderBy,
								groupBy: undefined,
								sessionOrderByAccount: p.sessionOrderByAccount,
								sessionUpdatedAtByAccount: p.sessionUpdatedAtByAccount
							})
						};
					}
				}
			} catch { /* ignore */ }
			return null;
		}

		/** 复刻官方 compareSessionRecency：updatedAt 降序，id 升序平局裁决。 */
		function recencyCompare(stamps) {
			return (a, b) => {
				const av = stamps?.[a] ?? Number.NEGATIVE_INFINITY;
				const bv = stamps?.[b] ?? Number.NEGATIVE_INFINITY;
				if (av !== bv) return bv - av;
				return a < b ? -1 : 1;
			};
		}

		/**
		 * 官方侧边栏为每个工作区维护「最近更新」排序账本（sessionOrderByAccount / sessionUpdatedAtByAccount）；
		 * 新移入的会话必然不在账本里，会被官方"活跃提升"策略错误置顶，且账本记住该顺序。
		 * 经官方 store action 修正该工作区的账本：成员时间戳齐全时直接写入正确的最近更新顺序
		 * （成员 = 账本现有顺序 ∪ 本次移入的会话；官方同步后账本时间戳覆盖全部非空白成员），
		 * 否则清空账本让官方 reconcile 全量重排（等价于用户手动切换一次排序）。
		 */
		function scheduleRecencyFix(ctx, workspaceId, movedIds = []) {
			if (!workspaceId) return;
			const attempt = () => {
				try {
					const view = resolveViewStore(ctx);
					if (!view) {
						console.debug("[workspace-mover] recency fix: view store not found");
						return;
					}
					const snap = view.getSnapshot();
					// flat 模式没有跨组"提升"行为；手动排序绝不能动用户自定义顺序
					if (snap.orderBy !== "updated" || snap.groupBy === "flat") return;
					const stamps = snap.sessionUpdatedAtByAccount?.[workspaceId];
					const members = [...new Set([...(snap.sessionOrderByAccount?.[workspaceId] ?? []), ...movedIds])];
					if (members.length > 0 && stamps && members.every((id) => Object.hasOwn(stamps, id))) {
						// 时间戳齐全：直接写入正确的「最近更新」顺序
						const order = [...members].sort(recencyCompare(stamps));
						const updatedAt = {};
						for (const id of members) updatedAt[id] = stamps[id];
						view.actions.syncSessionOrderAccount(workspaceId, order, updatedAt);
						console.debug("[workspace-mover] recency fix: rewrote order for", workspaceId);
					} else {
						// 变更帧尚未处理完（账本缺新会话的时间戳）：清空账本，官方 reconcile 全量重排
						view.actions.syncSessionOrderAccount(workspaceId, [], {});
						console.debug("[workspace-mover] recency fix: wiped account for", workspaceId);
					}
				} catch (err) {
					console.debug("[workspace-mover] recency fix failed:", err?.message ?? err);
				}
			};
			// 工作区变更帧可能晚于 RPC 返回；多试几次覆盖竞态，最后一试必然在帧落地后
			attempt();
			setTimeout(attempt, 400);
			setTimeout(attempt, 1200);
		}

			/**
			 * DSH 0.1.5 的工作区 feed 是最终来源，但批量迁移会先收到源组移除帧，
			 * 目标组 upsert 可能在下一个微任务才到达。用公开的 no-op reorder API
			 * 取回宿主确认的完整目标投影，避免界面短暂把会话放进“未分组”。
			 */
			async function reconcileWorkspaceProjection(ctx, workspaceId, sessionIds = []) {
				const ids = [...new Set((Array.isArray(sessionIds) ? sessionIds : [])
					.map((id) => String(id ?? "")).filter(Boolean))];
				if (!workspaceId || ids.length === 0) return false;
				const workspaces = ctx?.get?.("workspaces");
				const list = workspaces?.list;
				const ready = () => {
					try {
						const snapshot = list?.getSnapshot?.();
						const item = snapshot?.items?.find?.((candidate) => String(candidate.workspaceId) === String(workspaceId));
						const members = new Set((item?.sessionIds ?? []).map((id) => String(id)));
						return Boolean(item) && ids.every((id) => members.has(id));
					} catch {
						return false;
					}
				};
				if (ready()) return true;
				if (typeof workspaces?.insertSessionBefore !== "function") return false;
				try {
					// beforeSessionId === sessionId 是官方定义的幂等 no-op，仍返回完整 WorkspaceView。
					await workspaces.insertSessionBefore(workspaceId, ids[0], ids[0]);
					return ready();
				} catch (err) {
					console.debug("[workspace-mover] projection reconcile skipped:", err?.message ?? err);
					return false;
				}
			}

			/** 弹窗实例计数：为 aria-labelledby 生成稳定且唯一的关联 id。 */
			let overlaySeq = 0;

			function injectOverlay() {
				const uid = `wsm-title-${++overlaySeq}`;
				const overlay = document.createElement("div");
				overlay.className = "wsm-overlay";
				overlay.innerHTML = `
<div class="wsm-card" role="dialog" aria-modal="true" aria-labelledby="${uid}">
  <div class="wsm-title" id="${uid}"></div>
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

			/**
			 * 挂载弹窗并补齐可达性：焦点进入弹窗、Tab 在弹窗内循环、
			 * 背景点击关闭。`onKey` 是各调用方自己的 Escape 处理（用于释放监听器）。
			 * 必须**先 append 再 focus**——未挂到文档上的元素在浏览器里无法聚焦。
			 */
			function openDialog(overlay, close) {
				overlay.addEventListener("click", (e) => { if (e.target === overlay) close(null); });
				document.body.appendChild(overlay);
				const card = overlay.querySelector(".wsm-card");
				const focusables = [...card.querySelectorAll("button:not(:disabled)")];
				(focusables.find((b) => b.classList.contains("primary")) ?? focusables[0] ?? card)?.focus?.();
				overlay.addEventListener("keydown", (e) => {
					if (e.key !== "Tab" || focusables.length === 0) return;
					const at = focusables.indexOf(document.activeElement);
					const next = e.shiftKey
						? (at <= 0 ? focusables.length - 1 : at - 1)
						: (at === -1 || at === focusables.length - 1 ? 0 : at + 1);
					// 自管焦点：避免 Tab 跑到弹窗背后的侧边栏/输入框
					focusables[next]?.focus?.();
				});
			}

			function confirmMove({ sessionId, sessionTitle, workspace, batchCount, unresolvedCount }) {
				return new Promise((resolve) => {
					const overlay = injectOverlay();
					const okBtn = overlay.querySelector(".wsm-ok");
					overlay.querySelector(".wsm-title").textContent = batchCount ? t("batchConfirmTitle") : t("confirmTitle");
					overlay.querySelector(".wsm-session").textContent = batchCount
						? t("scannedN", { n: batchCount })
						: (sessionTitle || t("unnamedSession"));
					overlay.querySelector(".wsm-target").textContent = `${workspace.title}（${workspace.path}）`;
					const hint = overlay.querySelector(".wsm-hint");
					hint.textContent = batchCount ? t("batchHint", { count: batchCount }) : t("hint");
					// 有行无法识别时必须如实说明——用户点"确认"之前要知道这次只搬走了一部分。
					if (unresolvedCount > 0) {
						const warn = document.createElement("div");
						warn.className = "wsm-hint";
						warn.textContent = t("idUnresolvedPartial", { n: unresolvedCount });
						hint.after(warn);
					}
					okBtn.textContent = batchCount ? t("batchMove") : t("move");
					document.addEventListener("keydown", onKey);
					function onKey(e) { if (e.key === "Escape") close(null); }
					function close(value) {
						overlay.remove();
						document.removeEventListener("keydown", onKey);
						resolve(value);
					}
					overlay.querySelector(".wsm-cancel").addEventListener("click", () => close(null));
					okBtn.addEventListener("click", () => close(true));
					openDialog(overlay, close);
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
					document.addEventListener("keydown", onKey);
					function onKey(e) { if (e.key === "Escape") close(null); }
					function close(value) {
						overlay.remove();
						document.removeEventListener("keydown", onKey);
						resolve(value);
					}
					overlay.querySelector(".wsm-cancel").addEventListener("click", () => close(null));
					okBtn.addEventListener("click", () => close(select.value || null));
					openDialog(overlay, close);
					okBtn.focus();
				});
			}

			/** 归档恢复目标选择对话框：列出全部分组（默认选中归位建议）。resolve(workspaceId) 或 resolve(null)。 */
			function pickRestoreTarget({ item, workspaces, suggestId }) {
				return new Promise((resolve) => {
					const overlay = injectOverlay();
					overlay.querySelector(".wsm-title").textContent = t("restorePickTitle", { title: item.title || t("unnamedSession") });
					overlay.querySelector(".wsm-session").textContent = item.ownerTitle ?? t("ownerGoneBadge");
					overlay.querySelector(".wsm-hint").textContent = item.cwd ?? "";
					const targetRow = overlay.querySelectorAll(".wsm-row")[1];
					targetRow.querySelector(".wsm-target").replaceWith((() => {
						const select = document.createElement("select");
						select.className = "wsm-select";
						select.style.maxWidth = "260px";
						select.append(new Option(t("allWorkspaces"), ""));
						for (const w of workspaces) {
							select.append(new Option(`${w.title}（${w.path}）`, w.workspaceId));
						}
						if (suggestId) select.value = suggestId;
						return select;
					})());
					const okBtn = overlay.querySelector(".wsm-ok");
					okBtn.textContent = t("restoreBtn");
					okBtn.disabled = true;
					const select = overlay.querySelector("select.wsm-select");
					select.addEventListener("change", () => { okBtn.disabled = !select.value; });
					document.addEventListener("keydown", onKey);
					function onKey(e) { if (e.key === "Escape") close(null); }
					function close(value) {
						overlay.remove();
						document.removeEventListener("keydown", onKey);
						resolve(value);
					}
					overlay.querySelector(".wsm-cancel").addEventListener("click", () => close(null));
					okBtn.addEventListener("click", () => close(select.value || null));
					if (select.value) okBtn.disabled = false;
					openDialog(overlay, close);
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

		function fmtBytes(n) {
			if (!Number.isFinite(n) || n <= 0) return "0 B";
			if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`;
			if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
			return `${n} B`;
		}

		function fmtRange(item) {
			const from = item.oldest ? new Date(item.oldest).toLocaleDateString() : "";
			const to = item.newest ? new Date(item.newest).toLocaleDateString() : "";
			return from === to ? from : `${from} ~ ${to}`;
		}

		/** 「?」悬浮说明按钮：hover/长按显示白话解释，不占版面。 */
		const HelpDot = ({ text }) => h("span", { className: "wsm-help", title: text }, "?");

		function Caption({ text, help }) {
			return h("div", { className: "wsm-caption" }, text, help ? h(HelpDot, { text: help }) : null);
		}

		function RescuePanel({ rpcCall, ctx }) {
			const [scan, setScan] = useState(null);
			const [workspaces, setWorkspaces] = useState([]);
			const [audit, setAudit] = useState(null);
			const [wsInputs, setWsInputs] = useState({});
			const [busy, setBusy] = useState(false);
			const [picked, setPicked] = useState({});
			const [note, setNote] = useState("");
			const [history, setHistory] = useState([]);
			const [archived, setArchived] = useState(null);
			const [trash, setTrash] = useState(null);
			const [backups, setBackups] = useState(null);
			const [tasks, setTasks] = useState(null);
			const [doctor, setDoctor] = useState(null);
			const [query, setQuery] = useState("");

			const call = async (endpoint, payload) => {
				const res = await rpcCall(endpoint, payload ?? {});
				if (!res?.ok) {
					// v1.4 错误码协议：code 随异常一起抛出，客户端按 code 决定交互（文案仅兜底）
					const err = new Error(res?.error?.message ?? endpoint);
					err.code = res?.error?.code;
					throw err;
				}
				return res.value;
			};

			// 面板改动落账后主动重拉工作区基线（公开 API）：实时变更帧链路偶发不落地，
			// 不重拉的话侧边栏可能把会话先归到「未分组」，要刷新网页才归位。
			const refreshWorkspaces = () => { try { ctx?.get?.("workspaces")?.refresh?.(); } catch { /* ignore */ } };

			const runScan = async () => {
				setBusy(true);
				try {
					const [s, w, h, a, ar, tr, bp, tk] = await Promise.all([call("mover.scan"), call("mover.workspaces"), call("mover.history"), call("mover.ws.audit"), call("mover.archived"), call("mover.trash.list"), call("mover.backups.list"), call("mover.tasks.list")]);
					setScan(s);
					setWorkspaces(w.items ?? []);
					setHistory(h.items ?? []);
					setAudit(a);
					setArchived(ar);
					setTrash(tr);
					setBackups(bp);
					setTasks(tk);
				} catch (err) {
					setNote(t("failed", { msg: errMsg(err) }));
				} finally {
					setBusy(false);
				}
			};

			useEffect(() => { void runScan(); }, []);

			// 自检（v2.2）：只读诊断，结果常驻面板直到下次运行或重新扫描
			const runDoctorNow = async () => {
				setBusy(true);
				setNote(t("doctorChecking"));
				try {
					const value = await call("mover.doctor");
					setDoctor(value);
					setNote(t("doctorSummary", value.summary));
				} catch (err) {
					setNote(t("failed", { msg: errMsg(err) }));
				} finally {
					setBusy(false);
				}
			};

			const relink = async (item) => {
				const target = picked[item.sessionId];
				if (!target) return void setNote(t("pickTarget"));
				setBusy(true);
				setNote("");
				try {
					const res = await rpcCall("mover.move", { sessionId: item.sessionId, sessionTitle: item.title, targetWorkspaceId: target });
					if (!res?.ok) {
						const err = new Error(res?.error?.message ?? "move failed");
						err.code = res?.error?.code;
						throw err;
					}
					const wsTitle = workspaces.find((w) => w.workspaceId === target)?.title ?? "";
					setNote(res.value?.attached ? t("selfHealed") : t("relinked", { title: wsTitle }));
					refreshWorkspaces();
					scheduleRecencyFix(ctx, target, [item.sessionId]);
					await runScan();
				} catch (err) {
					failNote(err);
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
					refreshWorkspaces();
					scheduleRecencyFix(ctx, r.attachedTo, [item.sessionId]);
					await runScan();
				} catch (err) {
					failNote(err);
				} finally {
					setBusy(false);
				}
			};

			// 误放归位：只修正记账归属（磁盘文件本就在正确位置），不动文件
			const homeOne = async (it) => {
				setBusy(true);
				setNote("");
				try {
					const res = await call("mover.repair", { actions: [{ sessionId: it.sessionId, kind: "home" }] });
					const r = res.results?.[0];
					if (!r?.ok) throw new Error(r?.error ?? "home failed");
					const wsTitle = workspaces.find((w) => w.workspaceId === r.homedTo)?.title ?? r.homedTo ?? "";
					setNote(t("homedMsg", { ws: wsTitle }));
					refreshWorkspaces();
					scheduleRecencyFix(ctx, r.homedTo, [it.sessionId]);
					await runScan();
				} catch (err) {
					failNote(err);
				} finally {
					setBusy(false);
				}
			};

			const homeAll = async (list) => {
				setBusy(true);
				setNote("");
				try {
					const res = await call("mover.repair", { actions: list.map((it) => ({ sessionId: it.sessionId, kind: "home" })) });
					const okN = (res.results ?? []).filter((r) => r.ok).length;
					const failN = (res.results ?? []).length - okN;
					let msg = t("homeAllDone", { n: okN });
					if (failN > 0) msg += t("batchFailTail", { n: failN });
					setNote(msg);
					refreshWorkspaces();
					const homes = [...new Set((res.results ?? []).filter((r) => r.ok).map((r) => r.homedTo))];
					for (const wid of homes) scheduleRecencyFix(ctx, wid, list.map((it) => it.sessionId));
					await runScan();
				} catch (err) {
					failNote(err);
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
					let noteText = t("undone");
					if ((result?.failedCount ?? 0) > 0) noteText += t("batchUndoPartial", { n: result.failedCount });
					setNote(noteText);
					// 撤回同样会把会话变回原分组的"账本新面孔"，一并修正「最近更新」排序
					const movedBack = new Set((result?.results ?? []).filter((r) => r.ok).map((r) => String(r.sessionId)));
					const perWorkspace = new Map();
					const addBack = (wid, sids) => {
						if (!wid) return;
						const arr = perWorkspace.get(wid) ?? [];
						for (const sid of sids) arr.push(String(sid));
						perWorkspace.set(wid, arr);
					};
					if (entry.batch) {
						for (const s of entry.sessions ?? []) {
							if (movedBack.has(String(s.sessionId))) addBack(s.sourceWorkspaceId, [s.sessionId]);
						}
					} else {
						addBack(result?.to?.workspaceId ?? entry.sourceWorkspaceId, [result?.sessionId ?? entry.sessionId]);
					}
					for (const [wid, sids] of perWorkspace) scheduleRecencyFix(ctx, wid, sids);
					refreshWorkspaces();
					await runScan();
				} catch (err) {
					failNote(err);
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
					failNote(err);
				} finally {
					setBusy(false);
				}
			};

			// 归档恢复：从 registry 全局归档集移除（记账槽未动，自动回原分组原位置）；
			// 带 targetWorkspaceId 且 ≠ 归属时，宿主顺路走常规迁移（备份/撤销全套保护）。
			const restoreOne = async (item, targetWorkspaceId) => {
				setBusy(true);
				setNote("");
				try {
					await call("mover.unarchive", { sessionId: item.sessionId, targetWorkspaceId: targetWorkspaceId || undefined });
					const wid = targetWorkspaceId || item.ownerWorkspaceId;
					const wsTitle = workspaces.find((w) => w.workspaceId === wid)?.title ?? "";
					setNote(t("restoreDone", { ws: wsTitle || "?" }));
					if (wid) scheduleRecencyFix(ctx, wid, [item.sessionId]);
					refreshWorkspaces();
					await runScan();
				} catch (err) {
					failNote(err);
				} finally {
					setBusy(false);
				}
			};

			const restoreTo = async (item) => {
				const targetId = await pickRestoreTarget({ item, workspaces, suggestId: item.suggestedWorkspaceId });
				if (!targetId) return;
				await restoreOne(item, targetId);
			};

			// 空分组删除：动手前重拉一次原始记账，仍为空才删（防扫描与点击之间刚建了会话）。
			// 官方 workspaces.delete() 成功即 resolve（void）、失败 reject，没有 {ok} 信封。
			const deleteEmptyOne = async (ws) => {
				if (!window.confirm(t("emptyWsConfirmOne", { title: ws.title, path: ws.path }))) return;
				setBusy(true);
				setNote("");
				try {
					const fresh = await call("mover.workspaces");
					const current = (fresh.items ?? []).find((it) => it.workspaceId === ws.workspaceId);
					if (!current || (current.rawSessionCount ?? 0) !== 0) {
						setNote(t("emptyWsStale", { title: ws.title }));
						return;
					}
					await ctx?.get?.("workspaces")?.delete?.(ws.workspaceId);
					setNote(t("emptyWsDone", { n: 1 }));
					refreshWorkspaces();
					await runScan();
				} catch (err) {
					failNote(err);
				} finally {
					setBusy(false);
				}
			};

			const deleteEmptyAll = async (list) => {
				if (!window.confirm(t("emptyWsConfirmAll", { n: list.length }))) return;
				setBusy(true);
				setNote("");
				try {
					const fresh = await call("mover.workspaces");
					let n = 0;
					for (const ws of list) {
						const current = (fresh.items ?? []).find((it) => it.workspaceId === ws.workspaceId);
						if (!current || (current.rawSessionCount ?? 0) !== 0) continue;
						try {
							await ctx?.get?.("workspaces")?.delete?.(ws.workspaceId);
							n++;
						} catch { /* 单个失败不影响其余 */ }
					}
					setNote(n > 0 ? t("emptyWsDone", { n }) : t("emptyWsStale", { title: list[0]?.title ?? "?" }));
					refreshWorkspaces();
					await runScan();
				} catch (err) {
					failNote(err);
				} finally {
					setBusy(false);
				}
			};

			// 失败双通道：面板底部 note + toast 浮层（note 在长列表里容易被错过）
			const failNote = (err) => {
				const raw = String(err?.message ?? err);
				const stale = /inactive context/.test(raw);
				const resident = /resident in memory/.test(raw);
				const busy = (err?.code === "busy" || resident) && !stale;
				const msg = stale ? t("contextStale")
					: !busy ? t("failed", { msg: raw })
					: resident ? t("residentRefuse") : t("sessionBusy");
				setNote(msg);
				toast(msg, true);
			};

			// 删除会话 → 回收站（四件套清理，manifest 可还原）
			const deleteToTrash = async (item) => {
				if (!window.confirm(t("deleteConfirm", { title: item.title || t("unnamedSession") }))) return;
				setBusy(true);
				setNote("");
				try {
					await call("mover.session.delete", { sessionId: item.sessionId });
					setNote(t("deletedMsg"));
					refreshWorkspaces();
					await runScan();
				} catch (err) {
					failNote(err);
				} finally {
					setBusy(false);
				}
			};

			// 回收站还原：先试原位置（最忠实），原位置被占/无分组时打开选择器换目标
			const trashRestore = async (item) => {
				setBusy(true);
				setNote("");
				try {
					const res = await call("mover.trash.restore", { sessionId: item.sessionId });
					const wsTitle = workspaces.find((w) => w.workspaceId === res?.workspaceId)?.title ?? res?.workspaceId ?? "";
					setNote(t("restoreDone", { ws: wsTitle }));
					if (res?.workspaceId) scheduleRecencyFix(ctx, res.workspaceId, [item.sessionId]);
					refreshWorkspaces();
					await runScan();
				} catch (err) {
					const msg = String(err?.message ?? err);
					// code 优先（conflict/not-found），英文文案正则保留为旧宿主兜底
					const needsPicker = err?.code === "conflict" || /no registered workspace|already exists/.test(msg);
					if (!needsPicker) {
						setNote(t("failed", { msg }));
						return;
					}
					setBusy(false);
					const targetId = await pickRestoreTarget({ item, workspaces, suggestId: item.ownerWorkspaceId });
					if (!targetId) return;
					setBusy(true);
					try {
						const res2 = await call("mover.trash.restore", { sessionId: item.sessionId, targetWorkspaceId: targetId });
						const wsTitle = workspaces.find((w) => w.workspaceId === res2?.workspaceId)?.title ?? res2?.workspaceId ?? "";
						setNote(t("restoreDone", { ws: wsTitle }));
						if (res2?.workspaceId) scheduleRecencyFix(ctx, res2.workspaceId, [item.sessionId]);
						refreshWorkspaces();
						await runScan();
					} catch (err2) {
						failNote(err2);
					} finally {
						setBusy(false);
					}
				}
			};

			const trashRestoreTo = async (item) => {
				const targetId = await pickRestoreTarget({ item, workspaces, suggestId: item.ownerWorkspaceId });
				if (!targetId) return;
				setBusy(true);
				setNote("");
				try {
					const res = await call("mover.trash.restore", { sessionId: item.sessionId, targetWorkspaceId: targetId });
					const wsTitle = workspaces.find((w) => w.workspaceId === res?.workspaceId)?.title ?? res?.workspaceId ?? "";
					setNote(t("restoreDone", { ws: wsTitle }));
					if (res?.workspaceId) scheduleRecencyFix(ctx, res.workspaceId, [item.sessionId]);
					refreshWorkspaces();
					await runScan();
				} catch (err) {
					failNote(err);
				} finally {
					setBusy(false);
				}
			};

			const purgeOne = async (item) => {
				if (!window.confirm(t("purgeConfirm", { title: item.title || t("unnamedSession") }))) return;
				// 彻底删除不可撤销：顺便问一句要不要把该会话的迁移备份也清掉
				//（这些备份此刻已无还原对象，留着只会变成孤儿字节）。
				const purgeBackups = item.backupCount > 0
					? window.confirm(t("purgeBackupsToo", { n: item.backupCount }))
					: false;
				setBusy(true);
				setNote("");
				try {
					const res = await call("mover.trash.purge", { sessionId: item.sessionId, purgeBackups });
					let msg = t("purgedMsg", { n: res?.purged ?? 1 });
					if ((res?.backupsDeleted ?? 0) > 0) msg += t("purgeBackupsDone", { n: res.backupsDeleted });
					setNote(msg);
					await runScan();
				} catch (err) {
					failNote(err);
				} finally {
					setBusy(false);
				}
			};

			const purgeAll = async (list) => {
				if (!window.confirm(t("purgeAllConfirm", { n: list.length }))) return;
				setBusy(true);
				setNote("");
				try {
					const res = await call("mover.trash.purge", { all: true });
					setNote(t("purgedMsg", { n: res?.purged ?? list.length }));
					await runScan();
				} catch (err) {
					failNote(err);
				} finally {
					setBusy(false);
				}
			};

			// 备份恢复：默认回备份时的原位置；原位置缺分组/被占时打开选择器换目标
			const backupRestore = async (item) => {
				setBusy(true);
				setNote("");
				const finish = (res) => {
					const wsTitle = workspaces.find((w) => w.workspaceId === res?.workspaceId)?.title ?? res?.workspaceId ?? "";
					setNote(t("restoreDone", { ws: wsTitle }));
					if (res?.workspaceId) scheduleRecencyFix(ctx, res.workspaceId, [item.sessionId]);
					refreshWorkspaces();
					return runScan();
				};
				try {
					finish(await call("mover.backups.restore", { sessionId: item.sessionId }));
				} catch (err) {
					const msg = String(err?.message ?? err);
					// code 优先（conflict/not-found），英文文案正则保留为旧宿主兜底
					const needsPicker = err?.code === "conflict" || /no registered workspace|already exists/.test(msg);
					if (!needsPicker) {
						setNote(t("failed", { msg }));
						return;
					}
					setBusy(false);
					const normalized = (p) => String(p ?? "").replace(/[\\/]+$/, "").toLowerCase();
					const suggestId = workspaces.find((w) => normalized(w.path) === normalized(item.cwd))?.workspaceId ?? null;
					const targetId = await pickRestoreTarget({ item, workspaces, suggestId });
					if (!targetId) return;
					setBusy(true);
					try {
						finish(await call("mover.backups.restore", { sessionId: item.sessionId, targetWorkspaceId: targetId }));
					} catch (err2) {
						failNote(err2);
					} finally {
						setBusy(false);
					}
					return;
				}
				setBusy(false);
			};

			const backupDelete = async (item) => {
				if (!window.confirm(t("backupDeleteConfirm", { title: item.title || item.sessionId, n: item.count }))) return;
				setBusy(true);
				setNote("");
				try {
					const res = await call("mover.backups.deleteOne", { sessionId: item.sessionId });
					setNote(t("backupDeletedMsg", { n: res?.deleted ?? 0 }));
					await runScan();
				} catch (err) {
					failNote(err);
				} finally {
					setBusy(false);
				}
			};

			/**
			 * 清理全部孤儿备份组的字节。孤儿 = 会话档案已不存在，这些备份不会被
			 * 任何操作再引用；逐组调用既有端点，不新增 RPC 面。
			 */
			const backupDeleteOrphans = async () => {
				const orphans = (backupItems ?? []).filter((it) => it.orphan);
				if (orphans.length === 0) return;
				if (!window.confirm(t("backupOrphanConfirm", { n: orphans.length, size: fmtBytes(backups?.orphanBytes ?? 0) }))) return;
				setBusy(true);
				setNote("");
				let deleted = 0;
				let failed = 0;
				for (const item of orphans) {
					try {
						const res = await call("mover.backups.deleteOne", { sessionId: item.sessionId });
						deleted += res?.deleted ?? 0;
					} catch { failed++; }
				}
				setNote(failed > 0 ? t("backupOrphanPartial", { n: deleted, f: failed }) : t("backupDeletedMsg", { n: deleted }));
				setBusy(false);
				await runScan();
			};

			// 一键修复：可自动修复项（挂错归位 / 未记账补账）逐项处理，只动记账不搬文件
			const repairAll = async () => {
				setBusy(true);
				setNote("");
				try {
					const res = await call("mover.repairAll");
					setNote(t("repairAllDone", { n: res.fixedCount, s: res.skippedCount, f: res.failedCount }));
					const perWs = new Map();
					for (const r of res.fixed ?? []) {
						const wid = r.homedTo ?? r.attachedTo;
						if (wid) perWs.set(wid, [...(perWs.get(wid) ?? []), r.sessionId]);
					}
					for (const [wid, ids] of perWs) scheduleRecencyFix(ctx, wid, ids);
					refreshWorkspaces();
					await runScan();
				} catch (err) {
					failNote(err);
				} finally {
					setBusy(false);
				}
			};

			// 任务重试：只处理记录里未成功的项（当前位置实时解析，逐项隔离失败）
			const taskRetry = async (task) => {
				setBusy(true);
				setNote("");
				try {
					const res = await call("mover.tasks.retry", { taskId: task.id });
					setNote(t("taskRetryDone", { n: res.fixedCount, f: res.failedCount }));
					const perWs = new Map();
					for (const r of res.results ?? []) {
						if (!r.ok) continue;
						const item = (task.items ?? []).find((i) => i.sessionId === r.sessionId);
						const wid = task.targetWorkspaceId;
						if (wid) perWs.set(wid, [...(perWs.get(wid) ?? []), r.sessionId]);
					}
					for (const [wid, ids] of perWs) scheduleRecencyFix(ctx, wid, ids);
					refreshWorkspaces();
					await runScan();
				} catch (err) {
					failNote(err);
				} finally {
					setBusy(false);
				}
			};

			const taskForget = async (task) => {
				if (!window.confirm(t("taskForgetConfirm"))) return;
				setBusy(true);
				setNote("");
				try {
					await call("mover.tasks.forget", { taskId: task.id });
					setNote(t("taskForgottenMsg"));
					await runScan();
				} catch (err) {
					failNote(err);
				} finally {
					setBusy(false);
				}
			};

			// 数据保护：按时间清理回收站与备份（dryRun 先出数字，确认后才真删）
			const dataCleanup = async () => {
				setBusy(true);
				setNote("");
				try {
					const preview = await call("mover.data.cleanup", { days: 30, dryRun: true });
					if (!preview.recyclePurged && !preview.backupDeleted) {
						setNote(t("dataCleanedMsg", { r: 0, b: 0, size: fmtBytes(0) }));
						return;
					}
					setBusy(false);
					const size = fmtBytes(preview.freedBytes);
					if (!window.confirm(t("dataCleanupConfirm", { r: preview.recyclePurged, b: preview.backupDeleted, size }))) return;
					setBusy(true);
					const res = await call("mover.data.cleanup", { days: 30 });
					setNote(t("dataCleanedMsg", { r: res.recyclePurged, b: res.backupDeleted, size: fmtBytes(res.freedBytes) }));
					await runScan();
				} catch (err) {
					failNote(err);
				} finally {
					setBusy(false);
				}
			};

			const items = scan?.items ?? [];
			const orphaned = items.filter((it) => it.status === "orphaned");
			const unregistered = items.filter((it) => it.status === "unregistered");
			const misfiled = items.filter((it) => it.status === "misfiled");
			const brokenWorkspaces = (audit?.items ?? []).filter((it) => it.status !== "ok");
			const emptyWorkspaces = workspaces.filter((w) => (w.rawSessionCount ?? 0) === 0);
			const archivedItems = archived?.items ?? [];
			const backupItems = backups?.items ?? [];
			// 回收站条目补上"该会话还有几份迁移备份"：彻底删除时顺带清理它们。
			const backupCountById = new Map(backupItems.map((it) => [String(it.sessionId), it.count]));
			const trashItems = (trash?.items ?? []).map((it) => ({
				...it,
				backupCount: backupCountById.get(String(it.sessionId)) ?? 0
			}));
			const taskItems = tasks?.items ?? [];
			// 面板筛选：标题 / 会话 ID / 路径 / 归属分组，命中任一即保留
			const q = query.trim().toLowerCase();
			const matchesQuery = (it) => {
				if (!q) return true;
				return [it.title, it.sessionId, it.cwd, it.homeTitle, it.ownerTitle].some((v) => String(v ?? "").toLowerCase().includes(q));
			};
			const orphanedV = orphaned.filter(matchesQuery);
			const unregisteredV = unregistered.filter(matchesQuery);
			const misfiledV = misfiled.filter(matchesQuery);
			const archivedV = archivedItems.filter(matchesQuery);
			const trashV = trashItems.filter(matchesQuery);
			const backupV = backupItems.filter(matchesQuery);
			const taskV = taskItems.filter((it) => matchesQuery({ ...it, title: null, cwd: it.targetPath }));
			const capCount = (shown, total) => (q ? `${shown}/${total}` : `${total}`);
			const counts = scan?.counts ?? {};
			const summaryParts = [
				["orphaned", t("stalePath")],
				["unregistered", t("ungroupedBadge")],
				["misfiled", t("misfiledLabel")],
				["unreadable", t("unreadable")]
			].filter(([k]) => (counts[k] ?? 0) > 0).map(([k, label]) => `${label} ${counts[k]}`);

			return h("div", { className: "wsm-panel" },
				h("h3", null, t("rescueTitle"), " ", h(HelpDot, { text: t("rescueDetail") })),
				h("div", { style: { fontSize: "12.5px", lineHeight: "19px", color: "var(--dsw-alias-label-secondary,#666)" } },
					t("rescueShort")),
				h("div", { className: "wsm-scanrow" },
					h("button", { className: "wsm-btn small primary", disabled: busy, onClick: () => void runScan() }, busy ? t("scanning") : t("scan")),
					h("button", { className: "wsm-btn small", disabled: busy, onClick: () => void repairAll() }, t("repairAllBtn")),
					h("button", { className: "wsm-btn small", disabled: busy, onClick: () => { setDoctor(null); void runDoctorNow(); } }, busy ? t("doctorChecking") : t("doctorBtn")),
					h("input",
						{
							className: "wsm-input", placeholder: t("filterPh"), value: query, disabled: busy,
							onChange: (e) => setQuery(e.target.value), style: { maxWidth: "170px" }
						}
					),
					scan ? h("span", { style: { fontSize: "12.5px", color: "var(--dsw-alias-label-tertiary,#999)" } },
						t("scannedN", { n: scan.scanned }) + (summaryParts.length ? ` · ${summaryParts.join(" · ")}` : ""))
						: null
				),
				doctor ? h("div", { className: "wsm-list", style: { marginTop: "8px" } },
					doctor.checks.map((c) => h("div", { className: "wsm-item", key: c.id },
						h("span", { className: "wsm-badge" + (c.state === "fail" ? " err" : c.state === "warn" ? " warn" : "") },
							c.state === "pass" ? "✓" : c.state === "warn" ? "⚠" : "✗"),
						h("span", { className: "wsm-cwd", title: c.detail }, t(`doctor${c.id.split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join("")}`) + (c.detail ? ` — ${c.detail}` : ""))
					))
				) : null,
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
				orphaned.length > 0 ? h(Caption, { text: `${t("orphanedCaption")} (${capCount(orphanedV.length, orphaned.length)})`, help: t("helpPath") }) : null,
				orphanedV.length > 0 ? h("div", { className: "wsm-list" },
					orphanedV.map((it) => h("div", { className: "wsm-item", key: it.sessionId },
							h("span", { className: "wsm-mono" }, it.title || t("unnamedSession")),
						it.archived ? h("span", { className: "wsm-badge" }, "archived") : null,
						h("span", { className: "wsm-cwd" }, it.cwd ?? "?"),
						h("select",
							{ className: "wsm-select", value: picked[it.sessionId] ?? "", onChange: (e) => setPicked((p) => ({ ...p, [it.sessionId]: e.target.value })) },
							h("option", { value: "" }, t("allWorkspaces")),
							workspaces.map((w) => h("option", { key: w.workspaceId, value: w.workspaceId }, `${w.title}（${w.path}）`))
						),
						h("button", { className: "wsm-btn small primary", disabled: busy || !picked[it.sessionId], onClick: () => void relink(it) }, t("relinkBtn")),
						h("button", { className: "wsm-btn small", disabled: busy, onClick: () => void deleteToTrash(it) }, t("deleteBtn"))
					))
				) : null,
				unregistered.length > 0 ? h(Caption, { text: `${t("unregCaption")} (${capCount(unregisteredV.length, unregistered.length)})`, help: t("helpUnreg") }) : null,
				unregisteredV.length > 0 ? h("div", { className: "wsm-list" },
					unregisteredV.map((it) => h("div", { className: "wsm-item", key: it.sessionId },
							h("span", { className: "wsm-mono" }, it.title || t("unnamedSession")),
						it.archived ? h("span", { className: "wsm-badge" }, "archived") : null,
						h("span", { className: "wsm-cwd" }, it.cwd ?? "?"),
						it.targetWorkspaceId
							// 有路径匹配的分组：一键原地补账
							? h("button", { className: "wsm-btn small", disabled: busy, onClick: () => void attach(it) }, t("attachBtn"))
							// 分组本身已被删除（或从未注册）：和失联会话一样真迁移到任意分组
							: h(React.Fragment, null,
								h("select",
									{ className: "wsm-select", value: picked[it.sessionId] ?? "", onChange: (e) => setPicked((p) => ({ ...p, [it.sessionId]: e.target.value })) },
									h("option", { value: "" }, t("allWorkspaces")),
									workspaces.map((w) => h("option", { key: w.workspaceId, value: w.workspaceId }, `${w.title}（${w.path}）`))
								),
								h("button", { className: "wsm-btn small primary", disabled: busy || !picked[it.sessionId], onClick: () => void relink(it) }, t("relinkBtn"))
							),
						h("button", { className: "wsm-btn small", disabled: busy, onClick: () => void deleteToTrash(it) }, t("deleteBtn"))
					))
				) : null,
				misfiled.length > 0 ? h(Caption, { text: `${t("misfiledCaption")} (${capCount(misfiledV.length, misfiled.length)})`, help: t("misfiledHelp") }) : null,
				misfiled.length > 1 ? h("div", { className: "wsm-scanrow" },
					h("button", { className: "wsm-btn small primary", disabled: busy, onClick: () => void homeAll(misfiledV.length > 0 ? misfiledV : misfiled) }, t("homeAllBtn"))
				) : null,
				misfiledV.length > 0 ? h("div", { className: "wsm-list" },
					misfiledV.map((it) => {
							const ownerNames = (it.ownerWorkspaceIds ?? [])
								.map((wid) => workspaces.find((w) => w.workspaceId === wid)?.title ?? wid.slice(0, 8))
								.join("/") || "?";
							return h("div", { className: "wsm-item", key: it.sessionId },
								h("span", { className: "wsm-mono" }, it.title || t("unnamedSession")),
								it.archived ? h("span", { className: "wsm-badge" }, "archived") : null,
								h("span", { className: "wsm-cwd", title: `${it.homePath ?? it.cwd ?? "?"}` }, `${ownerNames} → ${it.homeTitle ?? "?"}`),
								h("button", { className: "wsm-btn small primary", disabled: busy, onClick: () => void homeOne(it) }, t("homeBtn")),
								h("button", { className: "wsm-btn small", disabled: busy, onClick: () => void deleteToTrash(it) }, t("deleteBtn"))
							);
						})
					) : null,
				archivedItems.length > 0 ? h(Caption, { text: `${t("archivedCaption")} (${capCount(archivedV.length, archivedItems.length)})`, help: t("archivedHelp") }) : null,
				// 扫描只解析最新 400 条档案，而归档会话通常很旧：大库上这里可能不是全部。
				archived?.truncated && archivedV.length > 0
					? h("div", { className: "wsm-note" }, t("archiveTruncated", { parsed: archived.scannedParsed ?? 0, total: archived.scannedTotal ?? 0 }))
					: null,
				archivedV.length > 0 ? h("div", { className: "wsm-list" },
					archivedV.map((it) => h("div", { className: "wsm-item", key: it.sessionId },
						h("span", { className: "wsm-mono" }, it.title || t("unnamedSession")),
						it.suggestedWorkspaceId ? h("span", { className: "wsm-badge" }, t("misfiledLabel")) : null,
						h("span", { className: "wsm-cwd", title: it.cwd ?? "" },
							it.ownerTitle ? it.ownerTitle : t("ownerGoneBadge")),
						h("button",
							{
								className: "wsm-btn small primary", disabled: busy || !it.ownerWorkspaceId,
								title: it.ownerWorkspaceId ? undefined : t("ownerGoneBadge"),
								onClick: () => void restoreOne(it)
							},
							t("restoreBtn")),
						h("button", { className: "wsm-btn small", disabled: busy, onClick: () => void restoreTo(it) }, t("restoreToBtn")),
						h("button", { className: "wsm-btn small", disabled: busy, onClick: () => void deleteToTrash(it) }, t("deleteBtn"))
					))
				) : null,
				trashItems.length + backupItems.length > 0 ? h("div", { className: "wsm-scanrow" },
					h("span", { style: { fontSize: "12.5px", color: "var(--dsw-alias-label-secondary,#666)" } },
						t("dataSummary", { r: trashItems.length, rSize: fmtBytes(trashItems.reduce((s, it) => s + (it.sizeBytes ?? 0), 0)), b: backupItems.length, bSize: fmtBytes(backupItems.reduce((s, it) => s + (it.totalBytes ?? 0), 0)) })),
					h("button", { className: "wsm-btn small", disabled: busy, onClick: () => void dataCleanup() }, t("dataCleanupBtn"))
				) : null,
				trashItems.length > 0 ? h(Caption, { text: `${t("trashCaption")} (${capCount(trashV.length, trashItems.length)})`, help: t("trashHelp") }) : null,
				trashItems.length > 1 ? h("div", { className: "wsm-scanrow" },
					h("button", { className: "wsm-btn small", disabled: busy, onClick: () => void purgeAll(trashItems) }, t("purgeAllBtn"))
				) : null,
				trashV.length > 0 ? h("div", { className: "wsm-list" },
					trashV.map((it) => h("div", { className: "wsm-item", key: it.entry },
						h("span", { className: "wsm-mono" }, it.title || t("unnamedSession")),
						h("span", { className: "wsm-cwd", title: it.cwd ?? "" }, it.ownerTitle || t("ownerGoneBadge")),
						h("span", { className: "wsm-cwd" }, it.deletedAt ? new Date(it.deletedAt).toLocaleDateString() : ""),
						h("button", { className: "wsm-btn small primary", disabled: busy, onClick: () => void trashRestore(it) }, t("restoreBtn")),
						h("button", { className: "wsm-btn small", disabled: busy, onClick: () => void trashRestoreTo(it) }, t("restoreToBtn")),
						h("button", { className: "wsm-btn small", disabled: busy, onClick: () => void purgeOne(it) }, t("purgeBtn"))
					))
				) : null,
				emptyWorkspaces.length > 0 ? h(Caption, { text: `${t("emptyWsCaption")} (${emptyWorkspaces.length})`, help: t("emptyWsHelp") }) : null,
				emptyWorkspaces.length > 1 ? h("div", { className: "wsm-scanrow" },
					h("button", { className: "wsm-btn small", disabled: busy, onClick: () => void deleteEmptyAll(emptyWorkspaces) }, t("emptyWsDeleteAll"))
				) : null,
				emptyWorkspaces.length > 0 ? h("div", { className: "wsm-list" },
					emptyWorkspaces.map((w) => h("div", { className: "wsm-item", key: w.workspaceId },
						h("b", null, w.title),
						h("span", { className: "wsm-cwd", title: w.path }, w.path),
						h("button", { className: "wsm-btn small", disabled: busy, onClick: () => void deleteEmptyOne(w) }, t("emptyWsDelete"))
					))
				) : null,
				h("div", { className: "wsm-history" },
					h(Caption, { text: t("historySection"), help: t("historyHelp") }),
					history.length > 0 ? h("div", { className: "wsm-list" }, history.slice(0, 20).map((entry) => {
						const isBatch = Boolean(entry.batch);
						const undoable = isBatch
							? (entry.sessions ?? []).some((s) => s.sourceWorkspaceId)
							: Boolean(entry.sourceWorkspaceId);
						return h("div", { className: "wsm-item", key: entry.id },
							h("span", { className: "wsm-mono" },
								isBatch ? t("batchEntryTitle", { n: entry.sessions?.length ?? 0 }) : (entry.title || t("unnamedSession"))),
							h("span", { className: "wsm-cwd", title: isBatch ? t("batchEntryTitle", { n: entry.sessions?.length ?? 0 }) : `${entry.sessionId}: ${entry.from} → ${entry.to}` },
								isBatch ? (entry.to ? `→ ${entry.to}` : "") : `${entry.from} → ${entry.to}`),
							h("button", { className: "wsm-btn small", disabled: busy || !undoable, title: undoable ? undefined : t("historyHelp"), onClick: () => void undo(entry) }, t("undoBtn"))
						);
					})) : h("div", { className: "wsm-note" }, t("historyEmpty"))
				),
				backupItems.length > 0 ? h(Caption, { text: `${t("backupsCaption")} (${capCount(backupV.length, backupItems.length)})`, help: t("backupsHelp") }) : null,
				// 孤儿备份：会话已不存在，这些字节不会被任何操作再引用，只能手动清。
				backups?.orphanGroups > 0
					? h("div", { className: "wsm-scanrow" },
						h("span", { style: { fontSize: "12.5px", color: "var(--dsw-alias-label-secondary,#666)" } },
							t("backupOrphanSummary", { n: backups.orphanGroups, size: fmtBytes(backups.orphanBytes ?? 0) })),
						h("button", { className: "wsm-btn small", disabled: busy, onClick: () => void backupDeleteOrphans() }, t("backupOrphanCleanup")))
					: null,
				backupV.length > 0 ? h("div", { className: "wsm-list" },
					backupV.map((it) => h("div", { className: "wsm-item", key: it.sessionId },
						h("span", { className: "wsm-mono" }, it.title || t("unnamedSession")),
						it.orphan ? h("span", { className: "wsm-badge warn", title: t("backupOrphanHelp") }, t("backupOrphanBadge")) : null,
						h("span", { className: "wsm-cwd", title: it.cwd ?? "" }, t("backupMeta", { n: it.count, size: fmtBytes(it.totalBytes), range: fmtRange(it) })),
						h("button", { className: "wsm-btn small primary", disabled: busy, onClick: () => void backupRestore(it) }, t("restoreBtn")),
						h("button", { className: "wsm-btn small", disabled: busy, onClick: () => void backupDelete(it) }, t("backupDeleteBtn"))
					))
				) : null,
				taskItems.length > 0 ? h(Caption, { text: `${t("tasksCaption")} (${capCount(taskV.length, taskItems.length)})`, help: t("tasksHelp") }) : null,
				taskV.length > 0 ? h("div", { className: "wsm-list" },
					taskV.map((it) => h("div", { className: "wsm-item", key: it.id },
						h("span", { className: "wsm-cwd" }, it.createdAt ? new Date(it.createdAt).toLocaleString() : ""),
						h("span", { className: "wsm-cwd", title: it.targetPath ?? "" }, `✓${it.done} ✗${it.failed} ⏸${it.skipped} / ${it.total}`),
						it.failed + it.skipped > 0
							? h("button", { className: "wsm-btn small primary", disabled: busy, onClick: () => void taskRetry(it) }, t("taskRetryBtn"))
							: null,
						h("button", { className: "wsm-btn small", disabled: busy, onClick: () => void taskForget(it) }, t("taskForgetBtn"))
					))
				) : null,
				scan && (scan.recoveryCount ?? 0) > 0
					? h("div", { className: "wsm-note", style: { color: "var(--dsw-alias-state-error-primary,#dc2626)", marginTop: "10px" } }, t("recoveryNote", { n: scan.recoveryCount }))
					: null,
				scan && orphaned.length === 0 && unregistered.length === 0 && items.length > 0 && (scan.recoveryCount ?? 0) === 0
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
				inject: () => ({ rpcCall, ctx })
			}, RescuePanel));
		}
		//#endregion

		// slots：设置页「会话救援」面板需要；未注入时访问 ctx.slots 会被宿主拒绝
		var inject = ["connection", "slots"];

		// 同一 bundle 被重复装载时（宿主热重载/重组）防止叠加实例。
		// 前一个实例在 teardown 里把它复位，因此"装载→卸载→再装载"仍能正常工作。
		let applied = false;

		function apply(ctx) {
			if (applied) return;
			applied = true;
			// 在 apply（上下文必然活跃）时立即捕获 connection 服务实例本身，而不是持有 ctx
			// 做惰性访问：桌面版会在热重载 / 客户端重组时废弃本插件的旧 fiber，此后
			// ctx.connection 会抛 "cannot get required service 'connection' in inactive context"
			//（cordis 对已失活 fiber 的 inject 属性一律拒绝）。捕获到的实例由提供方
			// 插件（dsh-client-connection）持有，不受本插件 fiber 存亡影响。
			let connection = null;
			try { connection = ctx.connection; } catch { /* 上下文未就绪：rpcCall 内兜底重取 */ }
			const rpcCall = (endpoint, payload) => {
				if (!connection) {
					try { connection = ctx.connection; } catch { /* 仍然失活：走下面的友好报错 */ }
				}
				if (!connection) throw new Error(t("contextStale"));
				return connection.rpc.call(CHANNEL, endpoint, payload ?? {});
			};
			let dragging = null; // {el, els, id, target} —— id/target 在 drop 阶段解析
			let wsCache = null; // {items, at}

			// 统一登记本插件挂到 document / window 上的监听器与 observer。
			// 必须成对释放：桌面版热重载会废弃旧 fiber 并重新装载客户端半，
			// 不释放就会叠加第二份监听器——重复确认框、重复 RPC，
			// 两份闭包还会互相擦掉对方的多选高亮。
			const disposers = [];
			const listen = (type, fn, options) => {
				document.addEventListener(type, fn, options);
				disposers.push(() => document.removeEventListener(type, fn, options));
			};

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
			// 选中集存行元素（判定同步、零延迟）；会话 id 在点击/投放时解析：
			// 优先走权威通道 rowSessionId（React fiber 上的 node.id），不可用时退化为
			// 「组内对齐 + 标题匹配」——且**匹配不上就不猜**，无法确认的行会被跳过并告知用户。
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
			 * 行元素 → 会话 id（权威通道）：官方 SessionNodeItem 渲染行时把整个
			 * node 对象（含 id）作为 prop 传入，dragstart 写入 dataTransfer 的
			 * 正是这个 node.id。沿 fiber 爬升取最近一个带 node.id 的组件 props，
			 * 不依赖任何顺序对齐——空白/归档会话被官方隐藏也不会错位。
			 */
			function rowSessionId(rowEl) {
				try {
					const fiberKey = Object.keys(rowEl).find((k) => k.startsWith("__reactFiber$"));
					if (!fiberKey) return null;
					for (let fiber = rowEl[fiberKey]; fiber; fiber = fiber.return) {
						const node = fiber.memoizedProps?.node;
						if (node && typeof node.id === "string" && node.id.length > 0
							&& (node.blank !== undefined || node.updatedAt !== undefined)) {
							return node.id;
						}
					}
				} catch { /* ignore */ }
				return null;
			}

			/**
			 * 把一组会话行对齐到 ws.sessionIds。仅在权威通道（rowSessionId）不可用时使用。
			 *
			 * 关键安全约定：**匹配不上就不猜**。旧实现在标题匹配失败时直接取
			 * `remaining` 里的下一个 id，而官方侧边栏会隐藏空白/归档行，于是整组错位一格、
			 * 批量拖拽会搬走另一组合法会话。现在无法确定的行一律计入 unresolved，
			 * 由调用方决定跳过还是中止。
			 *
			 * 返回 { map, unresolved }；map 为 row → id。
			 */
			async function mapGroupRows(ws, groupRows) {
				const titleOf = new Map();
				try {
					const scan = await fetchScan();
					for (const it of scan.items ?? []) titleOf.set(String(it.sessionId), String(it.title ?? "").replace(/\s+/g, " ").trim());
				} catch { /* scan 不可用时无法按标题匹配，只能精确匹配或放弃 */ }
				const remaining = (ws.sessionIds ?? []).map(String);
				const out = new Map();
				const unresolved = [];
				for (const row of groupRows) {
					if (remaining.length === 0) { unresolved.push(row); continue; }
					const text = (row.textContent ?? "").replace(/\s+/g, " ").trim();
					let hit = -1;
					if (text && text !== t("unnamedSession")) {
						// 先精确，再"标题被行文本包含"（行文本通常更短，只带徽章/时间）
						hit = remaining.findIndex((id) => titleOf.get(id) === text);
						if (hit < 0) {
							hit = remaining.findIndex((id) => {
								const tt = titleOf.get(id);
								return tt && tt.length > 0 && text.includes(tt);
							});
						}
					}
					if (hit < 0) { unresolved.push(row); continue; }
					const id = remaining.splice(hit, 1)[0];
					if (id === undefined) { unresolved.push(row); continue; }
					row.dataset.wsmId = id;
					out.set(row, id);
				}
				return { map: out, unresolved };
			}

			/** 解析单个行元素（含所在组）的会话 id；权威走 rowSessionId，失败退回组内对齐（不猜）。 */
			async function resolveRowId(rowEl) {
				const authoritative = rowSessionId(rowEl);
				if (authoritative) return authoritative;
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
				const { map } = await mapGroupRows(ws, groupSessionRows(header));
				return map.get(rowEl) ?? null;
			}

			// Ctrl/Cmd+点击：加入/移出；Shift+点击：组内范围选择。普通点击不干预。
			listen("click", async (e) => {
			const row = sessionRow(e.target);
			if (!row) return;
			const meta = e.ctrlKey || e.metaKey;
			if (!meta && !e.shiftKey) {
				// 普通点击会话行 = 官方跳转语义；顺带静默退出多选，避免残留"已选 X 个"
				if (pickedRows.size > 0) clearSelection(true);
				return;
			}
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
					if (!ws) return void toast(t("staleList"), true);
					const groupRows = groupSessionRows(header);
					const { map: mapping } = await mapGroupRows(ws, groupRows);
				if (meta) {
					if (pickedRows.has(row)) pickedRows.delete(row);
					else if (mapping.has(row) || rowSessionId(row)) {
							// 开始新一轮选择时自动带上当前打开的会话（官方仅给打开行标 aria-selected），
							// 免得"正开着 A、Ctrl+点 B"要多点一次 A
							if (pickedRows.size === 0) {
								const open = [...document.querySelectorAll('div[role="treeitem"][aria-selected="true"]')]
									.find((el) => el.offsetParent !== null && el !== row);
								if (open) pickedRows.add(open);
							}
							pickedRows.add(row);
							lastPickedRow = row;
						}
					} else if (e.shiftKey && lastPickedRow && groupRows.includes(lastPickedRow)) {
						const from = groupRows.indexOf(lastPickedRow);
						const to = groupRows.indexOf(row);
						for (const r of groupRows.slice(Math.min(from, to), Math.max(from, to) + 1)) {
						if (mapping.has(r) || rowSessionId(r)) pickedRows.add(r);
					}
				} else if (mapping.has(row) || rowSessionId(row)) {
						pickedRows.add(row);
						lastPickedRow = row;
					}
					refreshPickVisuals();
				} catch (err) {
					toast(t("failed", { msg: errMsg(err) }), true);
				}
			}, true);

			// Esc 清空多选：输入框聚焦时不清空（与 pickHint 的文案一致），
			// 也不消费事件——官方输入的取消行为不受影响。
			listen("keydown", (e) => {
				if (e.key !== "Escape" || pickedRows.size === 0) return;
				const el = document.activeElement;
				const tag = el?.tagName?.toLowerCase?.();
				if (el?.isContentEditable || tag === "input" || tag === "textarea" || tag === "select") return;
				clearSelection();
			});
			//#endregion

			/** 把 DOM 里第 i 个工作区标题行映射到注册表第 i 项（渲染顺序即注册表顺序）。 */
			function normalizeHeaderText(value) {
				return String(value ?? "").replace(/\s+/g, " ").trim();
			}

			function headerText(rowEl) {
				return normalizeHeaderText([
					rowEl?.getAttribute?.("aria-label"),
					rowEl?.getAttribute?.("title"),
					rowEl?.textContent
				].filter(Boolean).join(" "));
			}

			function isUngroupedHeader(rowEl) {
				return /^(?:ungrouped|未分组)(?:\s|$)/i.test(headerText(rowEl));
			}

			function visibleWorkspaceHeaders() {
				return [...document.querySelectorAll('div[role="treeitem"][aria-expanded]')]
					.filter((el) => el.offsetParent !== null && !isUngroupedHeader(el));
			}

			/** 行标题文本是否命中某个注册表工作区的 title 或 path（大小写不敏感）。 */
			function headerMatchesWorkspace(text, item) {
				const lower = String(text ?? "").toLocaleLowerCase();
				const title = normalizeHeaderText(item?.title).toLocaleLowerCase();
				const path = normalizeHeaderText(item?.path).toLocaleLowerCase();
				return Boolean((title && lower.includes(title)) || (path && lower.includes(path)));
			}

			/**
			 * 行元素 → 注册表工作区。
			 * 只用**可自证**的凭据：标题/路径命中，或标题与路径同时为空时的序号等价
			 * （两者都无值意味着该实体没有可显示的标识，序号是唯一可用信息）。
			 * 官方侧边栏会隐藏目录已失效的分组，而 registry.list() 仍包含它们——
			 * 因此「DOM 第 i 项 = 注册表第 i 项」是错的，绝不能作为无条件兜底，
			 * 否则侧边栏少显示一项就会把会话搬进相邻分组。
			 */
			function resolveWorkspace(rowEl, items) {
				const list = Array.isArray(items) ? items : [];
				if (!rowEl || isUngroupedHeader(rowEl)) return null;
				const text = headerText(rowEl);
				const byText = list.find((item) => headerMatchesWorkspace(text, item));
				if (byText) return byText;
				const unidentifiable = list.filter((item) => !normalizeHeaderText(item?.title) && !normalizeHeaderText(item?.path));
				if (unidentifiable.length === 1) return unidentifiable[0];
				return null;
			}

			// dragstart：只做「元素判定」——拖起已多选的行 = 整批拖动，否则单选。
			// id 一律留到 drop 阶段解析（dataTransfer 只携带拖起这一行的 id）。
			listen("dragstart", (e) => {
				try {
					const row = sessionRow(e.target);
					if (!row) { dragging = null; return; }
					const picked = validPickedRows();
					const els = picked.length > 1 && picked.includes(row) ? picked : [row];
					dragging = { els, el: row, id: null, target: null };
				} catch { dragging = null; }
			});

			listen("dragover", (e) => {
				clearHints();
				if (!dragging) return;
				const header = headerRow(e.target);
				if (!header || isUngroupedHeader(header)) return;
				e.preventDefault(); // 允许在此投放（没有它 drop 根本不会触发）
				header.classList.add("wsm-drop-hint");
				if (!dragging.target || dragging.target.header !== header) {
					dragging.target = { header, workspaceId: null };
					void fetchWorkspaces().then((items) => {
						if (dragging?.target?.header !== header) return;
						const target = resolveWorkspace(header, items);
						dragging.target.workspaceId = target?.workspaceId ?? null;
					}).catch(() => { /* drop 阶段会再次解析并报告错误 */ });
				}
			}, true);

			listen("drop", async (e) => {
				const current = dragging;
				dragging = null;
				clearHints();
				if (!current) return;
				const header = headerRow(e.target) ?? current.target?.header;
				if (!header || isUngroupedHeader(header)) return;
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
					return void toast(t("failed", { msg: t("dragPayloadBad") }), true);
				}

				let workspace = null;
				try {
					let items = await fetchWorkspaces();
					workspace = resolveWorkspace(header, items);
					if (!workspace && current.target?.workspaceId) {
						workspace = items.find((item) => String(item.workspaceId) === String(current.target.workspaceId)) ?? null;
					}
					if (!workspace) {
						wsCache = null;
						items = await fetchWorkspaces();
						workspace = resolveWorkspace(header, items);
						if (!workspace && current.target?.workspaceId) {
							workspace = items.find((item) => String(item.workspaceId) === String(current.target.workspaceId)) ?? null;
						}
					}
				} catch (err) {
					return void toast(t("failed", { msg: errMsg(err) }), true);
				}
				if (!workspace) return void toast(t("staleList"), true);

				// ---- 组装移动清单：拖起行必有 id；多选行逐个经分组对齐解析 ----
				// 解析不出 id 的行**绝不猜测**（见 mapGroupRows 的安全约定）：
				// 要么整体中止，要么在确认框里如实说明跳过了几行。
				const picked = (current.els ?? [current.el]).filter((el) => el?.isConnected);
				const sessions = [];
				const seen = new Set();
				let unresolvedCount = 0;
				const push = (id, title) => {
					const key = String(id);
					if (!key || seen.has(key)) return;
					seen.add(key);
					sessions.push({ sessionId: key, sessionTitle: title || t("unnamedSession") });
				};
				if (picked.length > 1) {
					for (const el of picked) {
						if (el === current.el) continue; // 拖起行用 dataTransfer 的权威 id
						try {
							const id = await resolveRowId(el);
							if (id) push(id, rowTitle(el, ""));
							else unresolvedCount += 1;
						} catch { unresolvedCount += 1; }
					}
				}
				// 权威 id 放首位；若某选中行被误映射到同一 id 会被去重吞掉
				const beforePush = sessions.length;
				push(draggedId, rowTitle(current.el, draggedId));
				if (sessions.length === beforePush) unresolvedCount += 1; // 连拖起行都没解析出来

				if (unresolvedCount > 0 && sessions.length === 0) {
					return void toast(t("idUnresolved"), true);
				}

				if (sessions.length > 50) {
					return void toast(t("failed", { msg: t("batchTooMany", { max: 50, n: sessions.length }) }), true);
				}

				// ---- 单选：原有确认与 mover.move 路径 ----
				if (sessions.length === 1) {
					const { sessionId, sessionTitle } = sessions[0];
					const confirmed = await confirmMove({ sessionId, sessionTitle, workspace, unresolvedCount });
					if (!confirmed) return;
					try {
						const res = await rpcCall("mover.move", { sessionId, sessionTitle, targetWorkspaceId: workspace.workspaceId });
						if (res?.ok) {
							await reconcileWorkspaceProjection(ctx, workspace.workspaceId, [sessionId]);
							toast(res.value?.attached ? t("selfHealed") : t("done", { title: workspace.title }));
							scheduleRecencyFix(ctx, workspace.workspaceId, [sessionId]);
							if (res.value?.restartHint) setTimeout(() => toast(t("restartHint"), true), 1200);
						} else {
							const msg = res?.error?.message ?? "unknown";
							const rolled = res?.error?.code === "rollback-failed" || /roll/i.test(msg);
							const text = (rolled ? t("rolledBack", { msg }) : t("failed", { msg }));
							toast(text, true);
						}
					} catch (err) {
						toast(t("failed", { msg: errMsg(err) }), true);
					}
					return;
				}

				// ---- 多选：批量确认 + mover.moveMany（逐条独立备份回滚）----
				const confirmed = await confirmMove({ workspace, batchCount: sessions.length, unresolvedCount });
				if (!confirmed) return;
				try {
					const res = await rpcCall("mover.moveMany", { sessions, targetWorkspaceId: workspace.workspaceId });
					if (!res?.ok) {
						const msg = res?.error?.message ?? "unknown";
						const rolled = res?.error?.code === "rollback-failed" || /roll/i.test(msg);
						return void toast((rolled ? t("rolledBack", { msg }) : t("failed", { msg })), true);
					}
					const { movedCount, attachedCount, failedCount } = res.value ?? {};
					const okCount = (movedCount ?? 0) + (attachedCount ?? 0);
					const movedIds = (res.value?.results ?? []).filter((item) => item?.ok).map((item) => item.sessionId).filter(Boolean);
					await reconcileWorkspaceProjection(ctx, workspace.workspaceId, movedIds);
					let message = t("batchDone", { n: okCount });
					if ((failedCount ?? 0) > 0) message += t("batchFailTail", { n: failedCount });
					toast(message);
					clearSelection(true);
					scheduleRecencyFix(ctx, workspace.workspaceId, sessions.map((s) => s.sessionId));
				} catch (err) {
					toast(t("failed", { msg: errMsg(err) }), true);
				}
			}, true);

			listen("dragend", () => { dragging = null; clearHints(); });

			// 整组迁移 + 分组合并：入口在官方组标题的「⋯」菜单（注入「整组迁移…」项）。
			// 不再拦截浏览器右键——官方菜单同样在右键/⋯按钮打开，拦截会与之冲突。

			/** 从指定标题行发起整组迁移；全部成员迁入且源分组已空时，提供删除空分组（= 合并）。 */
			async function runGroupMoveFlow(header) {
				try {
					const items = await fetchWorkspaces();
					const workspace = resolveWorkspace(header, items);
					if (!workspace) return void toast(t("groupMoveEmpty"), true);
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
						const rolled = res?.error?.code === "rollback-failed" || /roll/i.test(msg);
						return void toast((rolled ? t("rolledBack", { msg }) : t("failed", { msg })), true);
					}
					const { movedCount, attachedCount, failedCount } = res.value ?? {};
					const okCount = (movedCount ?? 0) + (attachedCount ?? 0);
					const movedIds = (res.value?.results ?? []).filter((item) => item?.ok).map((item) => item.sessionId).filter(Boolean);
					await reconcileWorkspaceProjection(ctx, targetId, movedIds);
					let message = t("batchDone", { n: okCount });
					if ((failedCount ?? 0) > 0) message += t("batchFailTail", { n: failedCount });
					toast(message);
					scheduleRecencyFix(ctx, targetId, ids);
					// 合并：全部成员迁入且源分组已空时，提供删除空分组（逐级确认，失败不影响迁移结果）
					try {
						const fresh = await fetchWorkspaces();
						const source = fresh.find((w) => w.workspaceId === workspace.workspaceId);
						const targetTitle = fresh.find((w) => w.workspaceId === targetId)?.title ?? targetId;
						if (source && (source.sessionIds ?? []).length === 0
							&& window.confirm(t("mergeDeleteConfirm", { count: okCount, title: workspace.title, target: targetTitle }))) {
							// 官方 delete 成功即 resolve（void）、失败 reject
							await ctx.get?.("workspaces")?.delete?.(workspace.workspaceId);
							toast(t("mergeDone", { title: workspace.title }));
						}
					} catch { /* 合并删除为可选步骤，失败静默 */ }
				} catch (err) {
					toast(t("failed", { msg: errMsg(err) }), true);
				}
			}

			// 记录「⋯」按钮点击所在的标题行（标题行内唯一带 aria-label 的按钮），
			// 随后出现的菜单 portal 即属于这个分组；1 秒内未出现菜单则作废。
			let menuHeaderRow = null;
			listen("click", (e) => {
				const header = headerRow(e.target);
				if (!header) return;
				const btn = e.target.closest?.("button[aria-label]");
				if (!btn || !header.contains(btn)) return;
				menuHeaderRow = header;
				setTimeout(() => { menuHeaderRow = null; }, 1000);
			}, true);

			// 向官方菜单 portal 注入两项（克隆官方项的样式类，插在危险项之前）：
			// 「整组迁移…」= 批量移动 + 可选合并删除；「打开文件夹」= 系统文件管理器打开该分组目录。
			function injectGroupMoveItem(menu, items, header) {
				const model = items[0];
				const makeItem = (label, onClick) => {
					const el = document.createElement(model.tagName === "BUTTON" ? "button" : "div");
					el.type = "button";
					el.className = model.className;
					el.setAttribute("role", "menuitem");
					el.textContent = label;
					el.addEventListener("click", (e) => {
						e.preventDefault();
						e.stopPropagation();
						menuHeaderRow = null;
						// 关闭官方菜单：Escape + 菜单外部 pointerdown 双保险
						document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
						document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
						onClick();
					}, true);
					return el;
				};
				const groupItem = makeItem(t("groupMoveMenu"), () => void runGroupMoveFlow(header));
				const openItem = makeItem(t("openFolderMenu"), async () => {
					try {
						const list = await fetchWorkspaces();
						const ws = resolveWorkspace(header, list);
						if (!ws) return void toast(t("staleList"), true);
						const res = await rpcCall("mover.openFolder", { workspaceId: ws.workspaceId, path: ws.path });
						if (!res?.ok) toast(t("failed", { msg: res?.error?.message ?? "open failed" }), true);
					} catch (err) {
						toast(t("failed", { msg: errMsg(err) }), true);
					}
				});
				const danger = items.find((it) => /danger/i.test(it.className || ""));
				const anchor = danger && danger !== items[0] ? danger : items[items.length - 1];
				anchor.before(groupItem);
				groupItem.after(openItem);
			}

			const menuObserver = new MutationObserver((muts) => {
				if (!menuHeaderRow || !menuHeaderRow.isConnected) return;
				for (const m of muts) {
					for (const node of m.addedNodes) {
						if (!(node instanceof Element)) continue;
						const candidates = node.getAttribute?.("role") === "menu" ? [node]
							: [...(node.querySelectorAll?.('[role="menu"]') ?? [])];
						const menu = candidates[candidates.length - 1];
						if (!menu || menu.dataset.wsmInjected) continue;
						const items = [...menu.querySelectorAll('[role="menuitem"]')];
						if (items.length < 2) continue;
						menu.dataset.wsmInjected = "1";
						const header = menuHeaderRow;
						menuHeaderRow = null;
						injectGroupMoveItem(menu, items, header);
						return;
					}
				}
			});
			menuObserver.observe(document.body, { childList: true, subtree: true });
			disposers.push(() => { try { menuObserver.disconnect(); } catch { /* ignore */ } });

			// 诊断句柄：控制台用 window.__wsmDebug 检查「最近更新」排序修复通道（排障用）
			const priorDebug = window.__wsmDebug;
			try {
				window.__wsmDebug = {
					view: () => { const v = resolveViewStore(ctx); return v ? v.getSnapshot() : null; },
					resolveViewStore: () => resolveViewStore(ctx),
					fix: (id, moved) => scheduleRecencyFix(ctx, id, moved),
					rowId: (el) => rowSessionId(el),
					trash: () => rpcCall(CHANNEL, "mover.trash.list"),
					backups: () => rpcCall(CHANNEL, "mover.backups.list")
				};
			} catch { /* ignore */ }

			registerRescuePanel(ctx, rpcCall);

			// teardown：宿主废弃本 fiber（桌面版热重载 / 客户端重组）时释放全部监听器。
			// 没有这一步，重新装载会叠加第二份监听器，且旧闭包连同 pickedRows /
			// dragging / 缓存永远不会被回收。
			if (typeof ctx.effect === "function") {
				ctx.effect(() => () => {
					applied = false;
					for (const dispose of disposers.splice(0)) {
						try { dispose(); } catch { /* 单个失败不影响其余 */ }
					}
					try { if (window.__wsmDebug && priorDebug === undefined) delete window.__wsmDebug; } catch { /* ignore */ }
				}, "workspace-mover: client listeners");
			}
		}

		module.exports = { inject, apply };
		return module.exports;
	}
});
