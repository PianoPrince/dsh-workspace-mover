// dsh-workspace-mover — host half
//
// ① 跨工作区「真迁移」原始会话：物理搬移 session.jsonl.zstd、改写头部 cwd、
//    更新工作区注册表（侧边栏拖拽触发）。会话 id 与历史文件保持原样，
//    不产生副本，不消耗 token。
// ② 孤儿会话救援（v0.3）：扫描存储根分类失联/未挂账/幽灵档案，
//    relink 复用同一条迁移管线换路径重挂，attach 原地补记账。
//    针对官方讨论 #3012（项目文件夹移动后历史"消失"）的社区修复。
// ③ 工作区搬家向导（v0.5）：治 #3012 的病根——项目文件夹移动/改名后，
//    工作区注册记录里的 path 失效、成员会话头部 cwd 集体失效。向导把工作区
//    原地重定向到新路径（经实体统一写入通道 mutate 换 path，工作区 id、标题、
//    展示排序、归档位全部保持），再逐会话物理搬移+改写+清理常驻状态；
//    单文件各自备份回滚，中断可携原路径续跑。
//
// 热插拔约定：cordis.patch.yml 挂载，不改任何 dsh 源码；零 npm 依赖。
// 兼容：Node >= 22（zlib zstd*），dsh 0.1.1-rc.2。
//
// 内部接口使用声明：
// - ctx.workspaceRegistry 实体上的 attachSession/detachSession 为进程内公开方法，
//   但官方 RPC 未暴露跨工作区移动；本插件在进程内直接调用它们。
// - 工作区重定向使用 entity.mutate（官方实体的统一写入通道，负责 updatedAt 与
//   失效成员剪枝）。版本敏感点：mutate 按 sessionPaths 内存索引剪枝成员，
//   因此必须在换 path 之前，把所有受影响会话的三张索引预置成新路径——否则
//   全体成员会被当成失效记录而清空。mutate 不可用（宿主结构变化）时整个向导
//   在动第一个文件之前中止，并还原索引快照。
// - registry.headers / registry.sessionPaths 两张内存缓存索引的失效属于版本敏感操作，
//   全部包在 try/catch 中；失败时降级为「移动成功但需重启后归属刷新」。
// - 迁移常驻内存的空闲会话后，需删除 persistence.coordinator.states 里按旧 cwd
//   缓存的写入状态，否则该会话再追加事件会写回旧路径造成历史分叉；
//   删除后宿主会在下次 append 时从磁盘新位置重新 adopt（版本敏感，失败降级为重启建议）。
// - 常驻会话的进程内冻结头永远携带旧 cwd，attach 的 cwd 校验必然失败；
//   依赖官方「已记账 id 跳过校验」语义，先刷新 registry 三张索引并预置
//   target.record.sessionIds 再 attach（版本敏感，失败自动回滚）。

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, readdirSync, rmSync, statSync, cpSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { zstdDecompressSync, zstdCompressSync, constants } from 'node:zlib';
import { join, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';

const name = 'workspace-mover';
const inject = ['connection', 'workspaceRegistry', 'sessionPersistence'];

const CHANNEL = '/workspace-mover';
const ZSTD_MAGIC = 4247762216;
const ARTIFACT = 'session.jsonl.zstd';
const HISTORY_FILE = 'history.json';
const HISTORY_LIMIT = 100;

/** 路径等价判断：优先 realpath（大小写别名归一），目录缺失时退化为大小写不敏感字符串比较。 */
function samePath(a, b) {
	try {
		return realpathSync(a) === realpathSync(b);
	} catch {
		return String(a).toLowerCase() === String(b).toLowerCase();
	}
}

/** 防御性读取宿主服务：未注入或不可用时返回 undefined，不抛错。 */
function peekService(ctx, key) {
	try {
		return ctx.get?.(key);
	} catch {
		return undefined;
	}
}

//#region 存储布局编码 —— 与 @deepseek-ai/dsh-session-persistence-jsonl 语义一致的最小移植
function encodeSegment(raw) {
	if (raw.length === 0) throw new Error('cannot encode an empty path segment');
	if (raw === '.') return '~002E';
	if (raw === '..') return '~002E~002E';
	let out = '';
	for (let i = 0; i < raw.length; i++) {
		const code = raw.charCodeAt(i);
		const ch = String.fromCharCode(code);
		if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch;
		else out += '~' + code.toString(16).toUpperCase().padStart(4, '0');
	}
	return out;
}

function projectKey(cwd) {
	if (cwd.length === 0) throw new Error('cannot encode an empty project path');
	let readable = '';
	let separatorRun = false;
	for (let i = 0; i < cwd.length; i++) {
		const code = cwd.charCodeAt(i);
		const ch = String.fromCharCode(code);
		if (ch === '/' || ch === '\\' || ch === ':') {
			if (!separatorRun) readable += '-';
			separatorRun = true;
		} else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
			readable += ch;
			separatorRun = false;
		} else {
			readable += '~' + code.toString(16).toUpperCase().padStart(4, '0');
			separatorRun = false;
		}
	}
	return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`;
}

function sessionDir(root, cwd, id) {
	return join(root, projectKey(cwd), encodeSegment(id));
}

function artifactPath(root, cwd, id) {
	return join(sessionDir(root, cwd, id), ARTIFACT);
}
//#endregion

//#region zstd 拼接帧容器 —— 定位/改写首帧（会话头）
/** 扫描完整帧边界；返回 [start,end] 数组。损坏结构抛错。 */
export function scanFrames(buffer) {
	const frames = [];
	let offset = 0;
	while (offset < buffer.length) {
		const start = offset;
		if (buffer.length - offset < 4) throw new Error(`corrupt zstd log: truncated magic at ${offset}`);
		if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`corrupt zstd log: invalid frame magic at ${offset}`);
		offset += 4;
		if (offset === buffer.length) throw new Error('corrupt zstd log: torn frame descriptor');
		const descriptor = buffer.readUInt8(offset++);
		if ((descriptor & 24) !== 0) throw new Error(`corrupt zstd log: reserved header bit at ${offset - 1}`);
		const contentSizeFlag = descriptor >>> 6;
		const singleSegment = (descriptor & 32) !== 0;
		const checksum = (descriptor & 4) !== 0;
		const dictionaryFlag = descriptor & 3;
		const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
		const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : (1 << contentSizeFlag);
		const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
		if (buffer.length - offset < remainingHeaderBytes) throw new Error('corrupt zstd log: torn frame header');
		offset += remainingHeaderBytes;
		for (;;) {
			if (buffer.length - offset < 3) throw new Error('corrupt zstd log: torn block header');
			const blockHeader = buffer.readUIntLE(offset, 3);
			offset += 3;
			const lastBlock = (blockHeader & 1) !== 0;
			const blockType = (blockHeader >>> 1) & 3;
			const blockSize = blockHeader >>> 3;
			if (blockType === 3) throw new Error(`corrupt zstd log: reserved block type at ${offset - 3}`);
			const payloadBytes = blockType === 1 ? 1 : blockSize;
			if (buffer.length - offset < payloadBytes) throw new Error('corrupt zstd log: torn block payload');
			offset += payloadBytes;
			if (lastBlock) break;
		}
		if (checksum) {
			if (buffer.length - offset < 4) throw new Error('corrupt zstd log: torn checksum');
			offset += 4;
		}
		frames.push([start, offset]);
	}
	return frames;
}

/** 解出首帧（必须恰好一行 JSON 会话头）。 */
export function readHeader(buf) {
	const frames = scanFrames(buf);
	if (frames.length < 1) throw new Error('empty session artifact');
	const [s, e] = frames[0];
	const text = zstdDecompressSync(buf.subarray(s, e)).toString('utf8');
	if (text.length === 0 || text.charCodeAt(text.length - 1) !== 10) throw new Error('first frame is not one newline-terminated header line');
	if (text.indexOf('\n') !== text.length - 1) throw new Error('first frame carries more than the header line');
	return JSON.parse(text);
}

/** 用新 cwd 重写首帧并拼回其余帧（字节级保留）。返回新 Buffer。 */
export function rewriteHeaderCwd(buf, nextCwd) {
	const header = readHeader(buf);
	const frames = scanFrames(buf);
	header.cwd = nextCwd;
	const newFrame0 = zstdCompressSync(Buffer.from(JSON.stringify(header) + '\n', 'utf8'), {
		params: { [constants.ZSTD_c_checksumFlag]: 1 }
	});
	return Buffer.concat([newFrame0, buf.subarray(frames[0][1])]);
}

function sleepSync(ms) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Windows 怪癖防御：目录内刚发生文件改名后立刻改名目录会瞬时 EPERM。
 * 指数退避重试；仍失败返回 false（调用方走复制+删除兜底）。
 */
function renameWithRetry(src, dst, attempts = 6) {
	for (let i = 0; i < attempts; i++) {
		try {
			renameSync(src, dst);
			return true;
		} catch (err) {
			const code = err?.code;
			if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') throw err;
			if (i === attempts - 1) return false;
			sleepSync(20 * 2 ** i);
		}
	}
	return false;
}

function atomicWrite(path, buffer) {
	const tmp = `${path}.wsm-tmp`;
	writeFileSync(tmp, buffer);
	if (!renameWithRetry(tmp, path)) {
		try { rmSync(tmp, { force: true }); } catch { /* ignore */ }
		throw new Error(`atomic publish failed for ${path}`);
	}
}

/**
 * 目录搬运：优先改名（同卷瞬时），退化为递归复制+删除。
 * 保守覆盖策略：目标目录只允许"不存在"或"空"——非空内容一律拒绝，绝不误删外来目录；
 * 复制失败只清理本次创建的目标目录，源目录不动，重试幂等。
 * renameImpl / copyImpl 可注入（测试模拟改名失败与复制中途失败）。
 */
function moveDir(srcDir, dstDir, hooks = {}) {
	const { copyImpl = cpSync, renameImpl = renameWithRetry } = hooks;
	mkdirSync(dirname(dstDir), { recursive: true });
	let renamed = false;
	try {
		renamed = renameImpl(srcDir, dstDir);
	} catch (err) {
		if (err?.code !== 'EEXIST' && err?.code !== 'ENOTEMPTY') throw err;
		// rename 撞上已存在的目标：落入下方兜底（复查非空后拒绝）
	}
	if (renamed) return 'rename';
	if (existsSync(dstDir) && readdirSync(dstDir).length > 0) {
		// 非空目标拒绝覆盖：外来目录零损伤。若为进程中断留下的残骸，
		// 其中只会是本会话自己的文件（id 全局唯一），可手动删除后重试。
		throw new Error(`destination directory not empty (refusing to overwrite unknown content): ${dstDir}`);
	}
	let owned = false; // 目标目录由本次调用创建时，失败才负责清理
	try {
		if (existsSync(dstDir)) rmSync(dstDir, { recursive: true, force: true }); // 空目录
		mkdirSync(dstDir, { recursive: true });
		owned = true;
		copyImpl(srcDir, dstDir, { recursive: true });
	} catch (err) {
		if (owned) { try { rmSync(dstDir, { recursive: true, force: true }); } catch { /* 尽力清理 */ } }
		throw err;
	}
	rmSync(srcDir, { recursive: true, force: true });
	return 'copy';
}
//#endregion

//#region 备份管理（$DSH_HOME/workspace-mover/backups，保留最近 20 份）
function backupDir() {
	const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
	return join(home, 'workspace-mover', 'backups');
}

function stashBackup(id, buf) {
	try {
		const dir = backupDir();
		mkdirSync(dir, { recursive: true });
		atomicWrite(join(dir, `${id}.${Date.now()}.zstd`), buf);
		// 前缀收紧到 `${id}.`：相邻 id（如 session-x 与 session-x-1）的备份互不误删
		const keep = readdirSync(dir).filter((f) => f.startsWith(`${id}.`)).sort();
		while (keep.length > 20) rmSync(join(dir, keep.shift()), { force: true });
	} catch (err) {
		throw new Error(`backup failed (refusing to move without a stash): ${err?.message ?? err}`);
	}
}

function historyPath() {

	const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
	return join(home, 'workspace-mover', HISTORY_FILE);
}

function readHistory() {
	try {
		const value = JSON.parse(readFileSync(historyPath(), 'utf8'));
		return Array.isArray(value) ? value : [];
	} catch {
		return [];
	}
}

function writeHistory(entries) {
	const path = historyPath();
	mkdirSync(dirname(path), { recursive: true });
	atomicWrite(path, Buffer.from(JSON.stringify(entries.slice(-HISTORY_LIMIT), null, 2) + '\n', 'utf8'));
}

function rememberMove(result, sourceWorkspaceId, targetWorkspaceId) {
	const entry = {
		id: `${result.sessionId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
		sessionId: String(result.sessionId),
		title: result.title,
		sourceWorkspaceId: sourceWorkspaceId ?? null,
		targetWorkspaceId,
		from: result.from.cwd,
		to: result.to.cwd,
		movedAt: new Date().toISOString()
	};
	const history = readHistory();
	history.push(entry);
	writeHistory(history);
	return entry;
}

/** 批量移动聚合成一条历史：多选可跨组，来源工作区按会话各自记录。 */
function rememberBatchMove(movedItems, targetWorkspaceId, targetPath) {
	const entry = {
		id: `batch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
		batch: true,
		targetWorkspaceId,
		to: targetPath ?? null,
		movedAt: new Date().toISOString(),
		sessions: movedItems.map((item) => ({
			sessionId: String(item.sessionId),
			title: item.title,
			from: item.fromCwd,
			sourceWorkspaceId: item.sourceWorkspaceId ?? null
		}))
	};
	const history = readHistory();
	history.push(entry);
	writeHistory(history);
	return entry;
}

async function listHistory() {
	return { items: readHistory().reverse() };
}

async function undoMove(ctx, historyId) {
	if (typeof historyId !== 'string' || historyId.length === 0) throw new Error('historyId required');
	const history = readHistory();
	const index = history.findIndex((entry) => entry.id === historyId);
	if (index < 0) throw new Error(`move history '${historyId}' not found`);
	const entry = history[index];
	if (entry.batch) return undoBatchMove(ctx, history, index, entry, historyId);
	if (!entry.sourceWorkspaceId) throw new Error('original workspace is no longer available; choose a target workspace in Session Repair');
	const result = await moveSession(ctx, {
		sessionId: entry.sessionId,
		targetWorkspaceId: entry.sourceWorkspaceId,
		recordHistory: false
	});
	history.splice(index, 1);
	writeHistory(history);
	return { ...result, undone: true, historyId };
}

/** 批量撤回：逐个送回各自来源；成功的从记录中移除，失败保留以便再次撤回。 */
async function undoBatchMove(ctx, history, index, entry, historyId) {
	const results = [];
	const remaining = [];
	for (const item of entry.sessions ?? []) {
		if (!item.sourceWorkspaceId) {
			remaining.push(item);
			results.push({ sessionId: item.sessionId, ok: false, error: 'original workspace is no longer available; choose a target workspace in Session Repair' });
			continue;
		}
		try {
			await moveSession(ctx, {
				sessionId: item.sessionId,
				targetWorkspaceId: item.sourceWorkspaceId,
				recordHistory: false
			});
			results.push({ sessionId: item.sessionId, ok: true });
		} catch (err) {
			remaining.push(item);
			results.push({ sessionId: item.sessionId, ok: false, error: err?.message ?? String(err) });
		}
	}
	if (remaining.length > 0) {
		entry.sessions = remaining;
		writeHistory(history);
	} else {
		history.splice(index, 1);
		writeHistory(history);
	}
	const undoneCount = results.filter((r) => r.ok).length;
	return { undone: true, batch: true, historyId, results, undoneCount, failedCount: results.length - undoneCount };
}
//#endregion

//#region RPC 信封（与 dsh rpcErrorSchema 兼容）
const ok = (value) => ({ ok: true, value });
const failBadRequest = (message, details = {}) => ({
	ok: false,
	error: { code: 'bad-request', message, details: { issues: [{ message }], ...details } }
});
//#endregion

/**
 * 迁移一个空闲会话到目标工作区。
 * 顺序：detach → 备份 → 改写+搬运（失败自动还原）→ 缓存失效 → attach（失败自动回滚）。
 */
async function moveSession(ctx, { sessionId, targetWorkspaceId, sessionTitle, recordHistory = true }) {
	const registry = ctx.workspaceRegistry;
	const persistence = ctx.sessionPersistence;
	if (!registry || !persistence) throw new Error('workspace registry or session persistence service unavailable');

	// ---- 目标实体 ----
	const target = registry.get(targetWorkspaceId);
	if (target === undefined) throw new Error(`unknown workspace '${targetWorkspaceId}'`);
	const targetPath = target.path;

	// ---- 运行状态检查：仅拒绝回合进行中的会话 ----
	// sessions.get(id) 对所有常驻内存会话都返回对象（含空闲），不能作为判据；
	// 与宿主一致的真实判据是 agents.get(id)?.status === 'running'。
	assertNotRunning(ctx, sessionId);
	const materialized = peekService(ctx, 'sessions')?.get?.(sessionId) !== undefined;

	// ---- 从磁盘取权威头（不依赖注册表缓存）----
	const headers = await persistence.list();
	const meta = headers.find((h) => String(h.id) === String(sessionId));
	if (meta === undefined) throw new Error(`session '${sessionId}' not found in session persistence`);
	const sourceCwd = meta.cwd;
	const title = typeof sessionTitle === 'string' && sessionTitle.trim()
		? sessionTitle.trim()
		: (typeof meta.title === 'string' && meta.title.trim() ? meta.title.trim() : '未命名会话');
	if (sourceCwd === undefined) throw new Error('session header carries no cwd');
	if (samePath(sourceCwd, targetPath)) {
		// 磁盘头已指向目标：若目标工作区还没记账它（历史遗留的未归组会话），
		// 自动补上归属而不是报错——用户意图就是「让它归到这个组」。
		let accounted = false;
		try { accounted = [...target.record.sessionIds].includes(String(sessionId)); } catch { /* ignore */ }
		if (!accounted) {
			const r = await attachUnregistered(ctx, sessionId);
			ctx.logger?.info?.(`workspace-mover: self-healed accounting for ${sessionId} -> ${r.workspaceId}`);
			return {
				moved: false,
				attached: true,
				sessionId,
				from: { cwd: sourceCwd },
				to: { cwd: targetPath, workspaceId: targetWorkspaceId },
				cacheInvalidated: true,
				restartHint: null
			};
		}
		throw new Error('session already belongs to the target workspace');
	}

	// ---- 源工作区实体（可能无主： Ungrouped）----
	let sourceEntity;
	for (const entity of registry.list()) {
		try {
			if (samePath(entity.path, sourceCwd)) { sourceEntity = entity; break; }
		} catch { /* skip missing dirs */ }
	}

	// ---- 文件路径 ----
	const root = persistence.root;
	if (typeof root !== 'string' || root.length === 0) throw new Error('session persistence backend exposes no root');
	const srcArtifact = artifactPath(root, sourceCwd, sessionId);
	const dstArtifact = artifactPath(root, targetPath, sessionId);
	if (!existsSync(srcArtifact)) throw new Error(`session artifact missing: ${srcArtifact}`);
	if (existsSync(dstArtifact)) throw new Error(`destination artifact already exists: ${dstArtifact}`);

	// ---- detach（纯记账；失败不阻断）----
	try { await sourceEntity?.detachSession?.(sessionId); } catch (err) {
		ctx.logger?.warn?.(`workspace-mover: pre-detach failed (continuing): ${err?.message ?? err}`);
	}

	// ---- 备份 → 改写 → 搬运 ----
	const original = readFileSync(srcArtifact);
	stashBackup(String(sessionId), original);
	const rewritten = rewriteHeaderCwd(original, targetPath);

	try {
		atomicWrite(srcArtifact, rewritten);
	} catch (err) {
		try { await sourceEntity?.attachSession?.(sessionId); } catch { /* ignore */ }
		throw new Error(`move failed while rewriting header: ${err?.message ?? err}`);
	}

	try {
		const how = moveDir(dirname(srcArtifact), dirname(dstArtifact));
		if (how !== 'rename') ctx.logger?.info?.('workspace-mover: directory rename fell back to copy+delete');
		// 源项目目录空了就顺手清掉（listProjectDirs 容忍缺失）
		try {
			const srcProject = dirname(dirname(srcArtifact));
			if (existsSync(srcProject) && readdirSync(srcProject).length === 0) rmSync(srcProject, { recursive: true });
		} catch { /* ignore */ }
	} catch (err) {
		// 搬运失败：把改写后的文件退回原文，再抛出
		atomicWrite(srcArtifact, original);
		throw new Error(`move failed at relocate step: ${err?.message ?? err}`);
	}

	// ---- 内存一致性收尾（版本敏感，降级安全）----
	// ① 注册表缓存：让侧边栏立即按新归属分组。
	// ② 常驻会话的持久化写入状态：coordinator 缓存了旧 cwd 的 meta，
	//    必须删除以迫使宿主从磁盘新位置重新 adopt，避免后续追加写回旧路径。
	let restartHint = null;
	let cacheInvalidated = true;
	// 先留底原索引项，attach 失败时才能完整还原移动前的内存状态
	const priorHeader = registry.headers?.get?.(sessionId);
	const priorSessionPath = registry.sessionPaths?.get?.(sessionId);
	try {
		registry.headers?.delete?.(sessionId);
		registry.sessionPaths?.delete?.(sessionId);
		registry.invalidSessionPaths?.delete?.(sessionId);
	} catch (err) {
		cacheInvalidated = false;
		ctx.logger?.warn?.(`workspace-mover: cache invalidation failed, restart required: ${err?.message ?? err}`);
	}
	if (materialized) {
		try {
			persistence.coordinator?.states?.delete?.(String(sessionId));
		} catch (err) {
			ctx.logger?.warn?.(`workspace-mover: persistence state cleanup failed, restart recommended: ${err?.message ?? err}`);
			restartHint = 'a harness restart is recommended to fully re-bind this session';
		}
	}
	if (!cacheInvalidated && restartHint === null) {
		restartHint = 'sidebar grouping may need a harness restart to refresh';
	}

	// ---- 常驻会话：预置注册表成员资格（绕开冻结头的旧 cwd 校验）----
	// readSessionHeader 对常驻会话永远返回进程内冻结头（旧 cwd），attach 的
	// cwd 校验必然失败且无法从外部纠正；官方语义是「已记账的 id 跳过 cwd
	// 校验」——而等价事实（磁盘头已改写、物理位置与新路径一致）本插件已亲自
	// 保证，因此先刷新索引并记账，再走正常 attach 落账。
	let preseeded = false;
	if (materialized) {
		try {
			registry.headers?.set?.(sessionId, { ...meta, cwd: targetPath });
			registry.invalidSessionPaths?.delete?.(sessionId);
			registry.sessionPaths?.set?.(sessionId, targetPath);
			if (!target.record.sessionIds.includes(sessionId)) {
				target.record.sessionIds.unshift(sessionId);
				preseeded = true;
			}
		} catch (err) {
			ctx.logger?.warn?.(`workspace-mover: registry pre-seed failed, falling back to plain attach: ${err?.message ?? err}`);
		}
	}

	// ---- attach 到目标（校验新头 + 持久化记账）----
	try {
		await target.attachSession(sessionId);
	} catch (err) {
		// 自动回滚：撤销预置 → 原件放回源目录 → 重新挂回源工作区
		try {
			if (preseeded) {
				const at = target.record.sessionIds.indexOf(sessionId);
				if (at >= 0) target.record.sessionIds.splice(at, 1);
			}
			if (materialized) {
				if (priorSessionPath === undefined) registry.sessionPaths?.delete?.(sessionId);
				else registry.sessionPaths?.set?.(sessionId, priorSessionPath);
				if (priorHeader === undefined) registry.headers?.delete?.(sessionId);
				else registry.headers?.set?.(sessionId, priorHeader);
			}
			rmSync(dirname(dstArtifact), { recursive: true, force: true });
			mkdirSync(dirname(srcArtifact), { recursive: true });
			writeFileSync(srcArtifact, original);
			// 索引无需再清：非常驻路径在收尾时已清空、由源 attach 重新记账；
			// 常驻路径上一段已按移动前快照还原。
			await sourceEntity?.attachSession?.(sessionId);
		} catch (rollbackErr) {
			throw new Error(`move failed during attach (${err?.message ?? err}) AND rollback failed (${rollbackErr?.message ?? rollbackErr}). Original bytes stashed under ${backupDir()}`);
		}
		throw new Error(`move failed during target attach, rolled back cleanly: ${err?.message ?? err}`);
	}

	// ---- 进程内热修：常驻头换新 / @ 搜索缓存失效 / 投影缓存身份对齐 ----
	if (materialized && retargetLiveHeader(ctx, sessionId, targetPath) === null) {
		restartHint = restartHint ?? 'a harness restart is recommended to fully re-bind this session';
	}
	invalidateFileReferenceSearches(ctx, sourceCwd);
	await realignProjectionIdentity(ctx, sessionId, targetPath);

	const result = {
		moved: true,
		sessionId,
		title,
		from: { cwd: sourceCwd },
		to: { cwd: targetPath, workspaceId: targetWorkspaceId },
		cacheInvalidated,
		restartHint
	};
	if (recordHistory) {
		try {
			const historyEntry = rememberMove(result, sourceEntity?.id, targetWorkspaceId);
			result.historyId = historyEntry.id;
		} catch (err) {
			ctx.logger?.warn?.(`workspace-mover: move history write failed: ${err?.message ?? err}`);
		}
	}
	return result;
}

/** 列出工作区与各自会话（供拖拽目标解析）。 */
async function listWorkspaces(ctx) {
	const registry = ctx.workspaceRegistry;
	if (!registry) throw new Error('workspace registry unavailable');
	const items = registry.list().map((entity) => ({
		workspaceId: entity.id,
		path: entity.path,
		title: entity.title,
		status: undefined,
		sessionIds: (() => { try { return [...entity.sessionIds]; } catch { return []; } })(),
		// 原始记账数（含归档与幽灵成员）：空工作区判定必须看原始账本，藏了成员的组不能算空
		rawSessionCount: (() => { try { return entity.record.sessionIds.length; } catch { return undefined; } })()
	}));
	let archivedSessionIds = [];
	try { archivedSessionIds = [...registry.archivedSessionIds]; } catch { /* ignore */ }
	return { items, archivedSessionIds };
}

//#region 孤儿会话救援（v0.3）：扫描分类 + 批量重挂
const SCAN_MAX_ITEMS = 400;

function dirExists(p) {
	if (typeof p !== 'string' || p.length === 0) return false;
	try {
		return statSync(p).isDirectory();
	} catch {
		return false;
	}
}

/**
 * 从投影缓存读会话标题（只读、防御性解析）。侧边栏显示的标题（官方自动命名/重命名）
 * 存在投影缓存里，磁盘档案头对这类会话是空的——标题必须以这里为准才能与侧边栏一致；
 * 文件缺失或形状不符时返回空映射，调用方退化为档案头标题。
 */
function readProjectionTitles() {
	const map = new Map();
	try {
		const base = process.env.DSH_HOME ?? join(homedir(), '.dsh');
		const parsed = JSON.parse(readFileSync(join(base, 'storages', 'session_projcache.json'), 'utf8'));
		const sessions = parsed?.tables?.sessions;
		if (sessions && typeof sessions === 'object') {
			for (const [id, entry] of Object.entries(sessions)) {
				const val = entry?.rows?.title?.val;
				if (typeof val === 'string' && val.trim()) map.set(String(id), val.trim());
			}
		}
	} catch { /* 投影缓存不可读：标题退化为档案头 */ }
	return map;
}

/**
 * 扫描存储根下的全部会话档案并分类：
 * - orphaned    头部 cwd 指向的目录已不存在（项目文件夹被移动/改名/删除，官方讨论 #3012）
 * - unregistered cwd 仍有效但没有任何工作区记账它（bootstrap 只跑一次、agent 内部 fork 不注册等）
 * - misfiled    cwd 匹配某工作区，但记账在别的工作区（克隆工具、路径漂移、改名后重建分组）
 * - ok          归属健康（记账方恰好是 cwd 匹配的工作区）
 * - unreadable  档案损坏，解不出会话头
 * 另返回 ghosts：注册表记了账但磁盘档案缺失的幽灵 id。
 */
async function scanSessions(ctx) {
	const registry = ctx.workspaceRegistry;
	const persistence = ctx.sessionPersistence;
	if (!registry || !persistence) throw new Error('workspace registry or session persistence service unavailable');
	const root = persistence.root;
	if (typeof root !== 'string' || root.length === 0) throw new Error('session persistence backend exposes no root');

	const entities = registry.list();
	let archived = new Set();
	try { archived = new Set([...registry.archivedSessionIds]); } catch { /* ignore */ }
	const projectionTitles = readProjectionTitles();

	const items = [];
	const seenArtifacts = new Set();
	let total = 0;
	for (const proj of readdirSync(root)) {
		if (!(proj.startsWith('--') && proj.endsWith('--'))) continue; // 只认 projectKey 目录
		const projPath = join(root, proj);
		if (!dirExists(projPath)) continue;
		for (const idDir of readdirSync(projPath)) {
			const artifact = join(projPath, idDir, ARTIFACT);
			let st;
			try { st = statSync(artifact); } catch { continue; }
			if (!st.isFile()) continue;
			total++;
			seenArtifacts.add(artifact);
			if (items.length >= SCAN_MAX_ITEMS) continue;
			let header = null;
			try { header = readHeader(readFileSync(artifact)); } catch { header = null; }
			const sessionId = String(header?.id ?? idDir);
			const cwd = typeof header?.cwd === 'string' ? header.cwd : null;
			const alive = dirExists(cwd);
			const matching = cwd ? entities.find((e) => { try { return samePath(e.path, cwd); } catch { return false; } }) : undefined;
			// 记账方按原始 record 计算（公开 getter 会过滤掉幽灵 id）；
			// 「误放」= 有记账方但不是 cwd 匹配的那个工作区（克隆工具、路径漂移、改名后重建分组）。
			const owners = entities.filter((e) => {
				try { return [...e.record.sessionIds].includes(sessionId); } catch { return false; }
			});
			const correctlyOwned = owners.length === 1 && matching !== undefined && owners[0].id === matching.id;
			const status = header === null ? 'unreadable'
				: !alive ? 'orphaned'
				: matching === undefined ? 'unregistered' // cwd 有效但没有任何分组认领这个路径
				: owners.length === 0 ? 'unregistered' // 有匹配分组但无人记账
				: correctlyOwned ? 'ok'
				: 'misfiled'; // 记账方存在但不是 cwd 匹配的分组
			items.push({
				sessionId,
				title: projectionTitles.get(sessionId)
					?? (typeof header?.title === 'string' && header.title.trim() ? header.title.trim() : '未命名会话'),
				cwd,
				status,
				targetWorkspaceId: matching?.id ?? null,
				homeWorkspaceId: matching?.id ?? null,
				homeTitle: matching?.title ?? null,
				homePath: matching?.path ?? null,
				ownerWorkspaceIds: owners.map((e) => e.id),
				sizeBytes: st.size,
				mtimeMs: st.mtimeMs,
				archived: archived.has(sessionId)
			});
		}
	}

	const ghosts = [];
	for (const entity of entities) {
		let ids = [];
		// 幽灵正是「有账无档」的 id，而官方公开的 sessionIds getter 会把它们
		// 按索引过滤掉——必须遍历原始记账 record.sessionIds 才能看见它们。
		try { ids = [...entity.record.sessionIds]; } catch { continue; }
		for (const id of ids) {
			try {
				if (!existsSync(artifactPath(root, entity.path, id))) ghosts.push({ workspaceId: entity.id, sessionId: String(id) });
			} catch { /* skip */ }
		}
	}

	items.sort((a, b) => b.mtimeMs - a.mtimeMs);
	return {
		root,
		scanned: total,
		truncated: total > items.length,
		counts: items.reduce((acc, it) => { acc[it.status] = (acc[it.status] ?? 0) + 1; return acc; }, {}),
		items,
		ghosts
	};
}

/** 仅拒绝回合进行中的会话（与宿主 UI「进行中」徽标同款判据）。 */
function assertNotRunning(ctx, sessionId) {
	if (peekService(ctx, 'agents')?.get?.(sessionId)?.status === 'running') {
		throw new Error('session is currently running; wait for its turn to finish before moving');
	}
}

//#region 迁移后的进程内热修（版本敏感，全部 fail-soft）

/**
 * 换掉常驻会话对象上的冻结旧头。官方 header 是 deepFreeze 的纯对象，
 * 但 live.session.header 是普通实例属性——重启后宿主本来就会从磁盘新头
 * 重建，这里等价地原地换成新值的冻结克隆。@ 文件引用、未来的 attach
 * cwd 校验等一切读取 live 头的消费方随即拿到新 cwd。
 */
function retargetLiveHeader(ctx, sessionId, nextCwd) {
	try {
		const live = peekService(ctx, 'sessions')?.get?.(sessionId);
		if (!live || typeof live.header !== 'object' || live.header === null) return false;
		if (typeof live.header.cwd === 'string' && samePath(live.header.cwd, nextCwd)) return false;
		const nextHeader = { ...live.header, cwd: nextCwd };
		try { Object.freeze(nextHeader); } catch { /* 冻结失败无害 */ }
		live.header = nextHeader;
		return true;
	} catch (err) {
		ctx.logger?.warn?.(`workspace-mover: live header retarget failed for ${sessionId}: ${err?.message ?? err}`);
		return null;
	}
}

/** 清空以旧路径为根的 @ 文件引用搜索缓存（下一次 @ 会按新头重建根目录）。 */
function invalidateFileReferenceSearches(ctx, stalePath) {
	try {
		const searches = peekService(ctx, 'fileReferences')?.searches;
		if (!(searches instanceof Map)) return;
		for (const [agent, search] of [...searches]) {
			const root = search?.root ?? agent?.session?.header?.cwd;
			if (typeof root === 'string' && samePath(root, stalePath)) {
				try { search.dispose?.(); } catch { /* ignore */ }
				searches.delete(agent);
			}
		}
	} catch (err) {
		ctx.logger?.warn?.(`workspace-mover: file-reference invalidation failed: ${err?.message ?? err}`);
	}
}

/**
 * 对齐投影缓存检查点的日志身份（identity.cwd）。缓存以 {createdAt, cwd}
 * 绑定日志生命周期，cwd 不对齐会在下次冷启动时整条废弃——标题投影随之
 * 懒重建，侧栏在会话被打开前回退显示分组名。
 */
async function realignProjectionIdentity(ctx, sessionId, nextCwd) {
	try {
		const table = peekService(ctx, 'sessionProjectionCache')?.table;
		if (typeof table?.update !== 'function') return;
		await table.update(String(sessionId), (rec) =>
			rec?.identity ? { ...rec, identity: { ...rec.identity, cwd: nextCwd } } : rec
		);
	} catch (err) {
		ctx.logger?.warn?.(`workspace-mover: projection identity alignment failed for ${sessionId}: ${err?.message ?? err}`);
	}
}
//#endregion

/** 把一个「cwd 有效但无人记账」的会话挂接到路径匹配的现有工作区。 */
async function attachUnregistered(ctx, sessionId) {	const registry = ctx.workspaceRegistry;
	const persistence = ctx.sessionPersistence;
	if (!registry || !persistence) throw new Error('workspace registry or session persistence service unavailable');
	assertNotRunning(ctx, sessionId);
	const headers = await persistence.list();
	const meta = headers.find((h) => String(h.id) === String(sessionId));
	if (meta === undefined) throw new Error(`session '${sessionId}' not found in session persistence`);
	if (meta.cwd === undefined) throw new Error('session header carries no cwd');
	const entity = registry.list().find((e) => { try { return samePath(e.path, meta.cwd); } catch { return false; } });
	if (!entity) throw new Error(`no workspace accounts path '${meta.cwd}' — create that workspace first, then retry`);
	await entity.attachSession(sessionId);
	return { workspaceId: entity.id, path: entity.path };
}

/** 批量迁移入口：逐会话复用 moveSession（各自独立备份/回滚，单条失败不牵连其余）；历史聚合成一条。 */
async function moveManySessions(ctx, { sessions, targetWorkspaceId } = {}) {
	if (!Array.isArray(sessions) || sessions.length === 0) throw new Error('sessions must be a non-empty array');
	if (sessions.length > 50) throw new Error(`too many sessions in one batch (max 50, got ${sessions.length})`);
	if (typeof targetWorkspaceId !== 'string' || targetWorkspaceId.length === 0) throw new Error('targetWorkspaceId required');
	const registry = ctx.workspaceRegistry;
	const results = [];
	const moved = [];
	let movedCount = 0;
	let attachedCount = 0;
	for (const item of sessions) {
		const sessionId = item?.sessionId;
		if (typeof sessionId !== 'string' || sessionId.length === 0) {
			results.push({ sessionId: null, ok: false, error: 'sessionId required' });
			continue;
		}
		try {
			const result = await moveSession(ctx, {
				sessionId,
				targetWorkspaceId,
				sessionTitle: typeof item.sessionTitle === 'string' ? item.sessionTitle : undefined,
				recordHistory: false
			});
			if (result.attached) attachedCount += 1; else movedCount += 1;
			let sourceWorkspaceId = null;
			try {
				sourceWorkspaceId = registry?.list?.().find((e) => { try { return samePath(e.path, result.from.cwd); } catch { return false; } })?.id ?? null;
			} catch { sourceWorkspaceId = null; }
			moved.push({ sessionId, title: result.title, fromCwd: result.from.cwd, sourceWorkspaceId });
			results.push({ sessionId, ok: true, moved: result.moved, to: result.to.cwd, title: result.title });
		} catch (err) {
			results.push({ sessionId, ok: false, error: err?.message ?? String(err) });
		}
	}
	let historyId = null;
	if (moved.length > 0) {
		try {
			const target = registry?.list?.().find((e) => e.id === targetWorkspaceId);
			historyId = rememberBatchMove(moved, targetWorkspaceId, target?.path ?? null).id;
		} catch (err) {
			ctx.logger?.warn?.(`workspace-mover: batch move history write failed: ${err?.message ?? err}`);
		}
	}
	return { results, movedCount, attachedCount, failedCount: results.length - movedCount - attachedCount, historyId };
}

/**
 * 误放归位：会话的真实目录（header cwd）匹配某工作区，但记账在别处。
 * 摘掉所有错误记账方，再由 attachUnregistered 补上正确归属。
 * 磁盘文件本就在正确位置（cwd 未漂移），无需备份/搬运/改写。
 */
async function homeMisfiledSession(ctx, sessionId) {
	const registry = ctx.workspaceRegistry;
	const persistence = ctx.sessionPersistence;
	if (!registry || !persistence) throw new Error('workspace registry or session persistence service unavailable');
	assertNotRunning(ctx, sessionId);
	const headers = await persistence.list();
	const meta = headers.find((h) => String(h.id) === String(sessionId));
	if (meta === undefined) throw new Error(`session '${sessionId}' not found in session persistence`);
	if (meta.cwd === undefined) throw new Error('session header carries no cwd');
	const home = registry.list().find((e) => { try { return samePath(e.path, meta.cwd); } catch { return false; } });
	if (!home) throw new Error(`no workspace accounts path '${meta.cwd}'`);
	for (const entity of registry.list()) {
		if (entity.id === home.id) continue;
		let listed = false;
		try { listed = [...entity.record.sessionIds].includes(String(sessionId)); } catch { /* ignore */ }
		if (!listed) continue;
		try {
			await entity.detachSession(sessionId);
			ctx.logger?.info?.(`workspace-mover: detached misfiled ${sessionId} from ${entity.id}`);
		} catch (err) {
			ctx.logger?.warn?.(`workspace-mover: detach misfiled failed (continuing): ${err?.message ?? err}`);
		}
	}
	const r = await attachUnregistered(ctx, sessionId);
	return { sessionId, ok: true, homedTo: r.workspaceId };
}

/** 批量修复入口：relink（换路径真迁移）+ attach（原地补记账）+ home（误放归位）。 */
async function repairSessions(ctx, actions = []) {
	if (!Array.isArray(actions)) throw new Error('actions must be an array');
	if (actions.length > 50) throw new Error('too many actions in one batch (max 50)');
	const results = [];
	for (const action of actions) {
		const sessionId = action?.sessionId;
		const label = String(sessionId ?? '?');
		try {
			if (action.kind === 'relink') {
				const result = await moveSession(ctx, { sessionId, targetWorkspaceId: action.targetWorkspaceId });
				results.push({ sessionId, ok: true, moved: true, to: result.to.cwd });
			} else if (action.kind === 'attach') {
				const r = await attachUnregistered(ctx, sessionId);
				results.push({ sessionId, ok: true, attachedTo: r.workspaceId });
			} else if (action.kind === 'home') {
				results.push(await homeMisfiledSession(ctx, sessionId));
			} else {
				results.push({ sessionId, ok: false, error: `unknown kind '${action.kind}'` });
			}
		} catch (err) {
			results.push({ sessionId, ok: false, error: err?.message ?? String(err) });
		}
	}
	return { results };
}
//#endregion

//#region 工作区搬家向导（v0.5）：体检 + 注册表原地重定向 + 成员批量迁移
const REPOINT_MAX_SESSIONS = 200;

/** 规范化一个必须真实存在的目录；失败抛用户可读错误。与官方 realpath 唯一性约定一致。 */
function canonicalDir(p, label) {
	if (typeof p !== 'string' || p.trim().length === 0) throw new Error(`${label}不能为空`);
	const trimmed = p.trim();
	let canonical;
	try { canonical = realpathSync(trimmed); } catch (err) {
		throw new Error(`${label} '${trimmed}' 不存在或无法访问（${err?.code ?? err?.message ?? err}）`);
	}
	if (!statSync(canonical).isDirectory()) throw new Error(`${label} '${canonical}' 不是目录`);
	return canonical;
}

/** 工作区体检：逐个实体给出官方 status 判定（ok / missing-dir）与原始记账数。 */
async function auditWorkspaces(ctx) {
	const registry = ctx.workspaceRegistry;
	const persistence = ctx.sessionPersistence;
	if (!registry || !persistence) throw new Error('workspace registry or session persistence service unavailable');
	const items = [];
	for (const entity of registry.list()) {
		let status = dirExists(entity.path) ? 'ok' : 'missing-dir';
		try {
			if (typeof entity.status === 'function') status = await entity.status();
		} catch { /* 保持 stat 兜底结果 */ }
		let memberCount = 0;
		try { memberCount = entity.record.sessionIds.length; } catch { /* ignore */ }
		items.push({ workspaceId: entity.id, title: entity.title, path: entity.path, status, memberCount });
	}
	return { items };
}

//#region 归档会话管理 + 打开文件夹（v0.8）

/** 归档集合读取：registry 缺成员（老版本宿主）时返回空数组，不抛错。 */
function readArchivedIds(registry) {
	try {
		const ids = registry.archivedSessionIds;
		return Array.isArray(ids) ? ids.map(String) : [...ids].map(String);
	} catch {
		return [];
	}
}

/**
 * 列出已归档会话。标题/cwd 复用 scanSessions（投影缓存标题优先、档案头兜底，
 * 与侧边栏显示一致）；归属取自原始记账（官方归档从不摘记账槽，所以归属工作区仍在）；
 * cwd 匹配到别的工作区的行给出归位建议。
 */
async function listArchivedSessions(ctx) {
	const registry = ctx.workspaceRegistry;
	if (!registry) throw new Error('workspace registry unavailable');
	const archivedIds = new Set(readArchivedIds(registry));
	if (archivedIds.size === 0) return { items: [], truncated: false };
	const scan = await scanSessions(ctx);
	const items = [];
	for (const it of scan.items) {
		if (!archivedIds.has(it.sessionId)) continue;
		const ownerId = (it.ownerWorkspaceIds ?? [])[0] ?? null;
		const ownerEntity = ownerId ? registry.get(ownerId) : null;
		const suggestId = it.homeWorkspaceId && (!ownerId || it.homeWorkspaceId !== ownerId) ? it.homeWorkspaceId : null;
		items.push({
			sessionId: it.sessionId,
			title: it.title,
			cwd: it.cwd,
			ownerWorkspaceId: ownerId,
			ownerTitle: ownerEntity?.title ?? null,
			suggestedWorkspaceId: suggestId,
			suggestedTitle: suggestId ? it.homeTitle ?? null : null
		});
	}
	items.sort((a, b) => String(a.title).localeCompare(String(b.title), 'zh'));
	return { items, truncated: scan.truncated };
}

/**
 * 取消归档：走官方 registry 的持久状态写通道（与官方 archiveSession 同款
 * enqueueOperation + setState，域 schema 校验兜底），把 id 从 registry 全局归档集移除；
 * 归档从不摘记账槽，取消后自动回到原工作区原位置。带 targetWorkspaceId 且 ≠ 归属时，
 * 接着走常规迁移（备份/历史/撤销/防运行中全套保护）。
 */
async function unarchiveSession(ctx, { sessionId, targetWorkspaceId } = {}) {
	if (typeof sessionId !== 'string' || sessionId.length === 0) throw new Error('sessionId required');
	const registry = ctx.workspaceRegistry;
	if (!registry) throw new Error('workspace registry unavailable');
	const archivedIds = readArchivedIds(registry);
	if (!archivedIds.includes(sessionId)) throw new Error(`session '${sessionId}' is not archived`);
	if (typeof registry.enqueueOperation !== 'function' || typeof registry.setState !== 'function' || typeof registry.requireState !== 'function') {
		throw new Error('host workspace registry exposes no state mutation API; unarchive is unsupported on this DSH version');
	}
	await registry.enqueueOperation(async () => {
		const state = registry.requireState();
		await registry.setState({
			...state,
			archivedSessionIds: state.archivedSessionIds.filter((id) => String(id) !== sessionId)
		});
	});
	let moved = null;
	if (typeof targetWorkspaceId === 'string' && targetWorkspaceId.length > 0) {
		const owner = registry.list().find((e) => {
			try { return [...e.record.sessionIds].includes(sessionId); } catch { return false; }
		});
		if (!owner || owner.id !== targetWorkspaceId) {
			moved = await moveSession(ctx, { sessionId, targetWorkspaceId });
		}
	}
	return { unarchived: true, sessionId, moved };
}

/**
 * 用系统文件管理器打开目录；spawn 可注入（测试用）。不等待、不校验退出码。
 * Windows 上后台进程直接开窗不会置前（无前台激活权），且 ShellExecute 类方案
 * （PowerShell Shell.Application.Open / Start-Process）从宿主进程里会静默失效——
 * 实测唯一可靠链路：explorer.exe 开窗后约 0.8s，经 WScript AppActivate 按标题拉前台。
 */
export function openInFileManager(path, spawnFn = spawn) {
	if (process.platform === 'win32') {
		const title = basename(path.replace(/[\\/]+$/, ''));
		const child = spawnFn(String.raw`C:\Windows\explorer.exe`, [path], { detached: true, stdio: 'ignore' });
		child?.unref?.();
		const timer = setTimeout(() => {
			try {
				const act = spawnFn('powershell.exe', ['-NoProfile', '-Command', `$ws = New-Object -ComObject WScript.Shell; $null = $ws.AppActivate('${title.replace(/'/g, "''")}')`], { detached: true, stdio: 'ignore' });
				act?.unref?.();
			} catch { /* 置前失败只影响前台，不影响开窗本身 */ }
		}, 800);
		timer?.unref?.();
		return 'explorer.exe';
	}
	const command = process.platform === 'darwin' ? 'open' : 'xdg-open';
	const child = spawnFn(command, [path], { detached: true, stdio: 'ignore' });
	child?.unref?.();
	return command;
}

/** 用系统文件管理器打开某个已注册工作区的目录（workspaceId 或 path 必须命中注册表，防任意路径打开）。 */
async function openWorkspaceFolder(ctx, { workspaceId, path } = {}) {
	const registry = ctx.workspaceRegistry;
	if (!registry) throw new Error('workspace registry unavailable');
	const entities = registry.list();
	let entity = null;
	if (typeof workspaceId === 'string' && workspaceId.length > 0) {
		entity = entities.find((e) => e.id === workspaceId) ?? null;
		if (!entity && typeof path === 'string' && path.length > 0) {
			entity = entities.find((e) => { try { return samePath(e.path, path); } catch { return false; } }) ?? null;
		}
	} else if (typeof path === 'string' && path.length > 0) {
		entity = entities.find((e) => { try { return samePath(e.path, path); } catch { return false; } }) ?? null;
	}
	if (!entity) throw new Error('target does not belong to any registered workspace');
	if (!dirExists(entity.path)) throw new Error(`workspace directory does not exist: ${entity.path}`);
	const command = openInFileManager(entity.path);
	return { opened: true, workspaceId: entity.id, path: entity.path, command };
}

/**
 * 工作区原地搬家。fromPath 是失效的旧登记路径，newPath 是磁盘上的新家：
 * ① 盘点「头部 cwd 指向旧路径的磁盘会话 ∪ 实体原始记账」；
 * ② 预置注册表三张索引到新路径（防 mutate 失效剪枝清空名单）→ 经统一写入通道换 path；
 * ③ 逐会话备份+改写+物理搬移+常驻状态清理，单文件失败只影响自己，中断可用
 *    同参数续跑（实体 path 已是新路径时自动跳过改写，仅清扫残留散件）。
 */
async function repointWorkspace(ctx, { workspaceId, fromPath, newPath, dryRun = false }) {
	const registry = ctx.workspaceRegistry;
	const persistence = ctx.sessionPersistence;
	if (!registry || !persistence) throw new Error('workspace registry or session persistence service unavailable');
	if (typeof workspaceId !== 'string' || workspaceId.length === 0) throw new Error('workspaceId required');

	const entity = registry.get(workspaceId);
	if (!entity) throw new Error(`unknown workspace '${workspaceId}'`);

	const targetCanon = canonicalDir(newPath, '新路径');
	const stalePath = typeof fromPath === 'string' && fromPath.trim().length > 0 ? fromPath.trim() : entity.path;

	// 已经搬过的实体允许携带旧路径进来续跑（resume）；否则校验传参一致
	const resumeMode = samePath(entity.path, targetCanon);
	if (!resumeMode && !samePath(stalePath, entity.path)) {
		throw new Error(`workspace '${entity.title}' 目前登记在 '${entity.path}'，与传入的失效路径 '${stalePath}' 不一致`);
	}
	for (const other of registry.list()) {
		if (other.id === workspaceId) continue;
		if (samePath(other.path, targetCanon)) {
			throw new Error(`新路径已被工作区「${other.title}」占用（${other.path}），不能搬过去`);
		}
	}

	// ---- 盘点：磁盘上头部仍指旧路径的会话 ∪ 实体原始记账（含档案损坏者）----
	const headers = await persistence.list();
	const byId = new Map();
	const addAffected = (id, title) => { if (id !== undefined && !byId.has(String(id))) byId.set(String(id), title); };
	for (const header of headers) {
		if (typeof header?.cwd !== 'string' || !samePath(header.cwd, stalePath)) continue;
		addAffected(header.id, typeof header.title === 'string' && header.title.trim() ? header.title.trim() : null);
	}
	try { for (const id of entity.record.sessionIds) addAffected(id, registry.headers?.get?.(id)?.title ?? null); } catch { /* 记账不可读时以磁盘扫描为准 */ }

	const affected = [...byId.entries()].map(([sessionId, title]) => ({ sessionId, title }));
	if (affected.length > REPOINT_MAX_SESSIONS) {
		throw new Error(`该工作区牵涉 ${affected.length} 个会话，超出单次上限 ${REPOINT_MAX_SESSIONS}；请分批处理`);
	}

	const root = persistence.root;
	if (typeof root !== 'string' || root.length === 0) throw new Error('session persistence backend exposes no root');

	if (dryRun) return { dryRun: true, from: stalePath, to: targetCanon, resumeMode, count: affected.length, items: affected };

	// ---- 进行中的会话只跳过「物理搬移」，不跳过索引预置（否则 mutate 剪枝会清掉它们）----
	const runningIds = new Set(
		affected.map((it) => it.sessionId)
			.filter((id) => peekService(ctx, 'agents')?.get?.(id)?.status === 'running')
	);

	// ---- 预置索引（全部受影响会话）→ mutate 换 path（失败整体中止：文件一个都还没动）----
	let pathUpdated = false;
	if (!resumeMode) {
		if (typeof entity.mutate !== 'function') {
			throw new Error('宿主的工作区实体缺少统一写入通道 mutate，无法安全重定向（可能是版本变化）；尚未改动任何文件');
		}
		const priorHeaders = new Map();
		const priorPaths = new Map();
		const priorInvalid = new Map();
		for (const { sessionId, title } of affected) {
			try {
				priorHeaders.set(sessionId, registry.headers?.get?.(sessionId));
				priorPaths.set(sessionId, registry.sessionPaths?.get?.(sessionId));
				priorInvalid.set(sessionId, registry.invalidSessionPaths?.get?.(sessionId));
				registry.headers?.set?.(sessionId, { ...(registry.headers?.get?.(sessionId) ?? {}), id: sessionId, cwd: targetCanon, ...(title ? { title } : {}) });
				registry.invalidSessionPaths?.delete?.(sessionId);
				registry.sessionPaths?.set?.(sessionId, targetCanon);
			} catch (err) {
				ctx.logger?.warn?.(`workspace-mover: index pre-seed failed for ${sessionId}: ${err?.message ?? err}`);
			}
		}
		try {
			await entity.mutate((record) => ({
				...record,
				path: targetCanon,
				// 标题跟随文件夹改名：仅当标题仍是旧文件夹名（官方 create 的默认值）时同步；
				// 用户自定义过的标题原样保留
				...(typeof record.title === 'string' && record.title.length > 0
					&& record.title.toLowerCase() === basename(stalePath).toLowerCase()
					? { title: basename(targetCanon) }
					: {})
			}));
			pathUpdated = true;
			// 剪枝保护网：mutate 若因索引预置失败清掉了某些成员，立即按官方
			// attach 语义补回（头部已被预置成新路径，校验必过），失败则记入 skipped。
			try {
				for (const { sessionId } of affected) {
					let accounted = false;
					try { accounted = entity.record.sessionIds.includes(sessionId); } catch { /* ignore */ }
					if (!accounted) await entity.attachSession(sessionId);
				}
			} catch (err) {
				ctx.logger?.warn?.(`workspace-mover: post-mutate reattach failed: ${err?.message ?? err}`);
			}
		} catch (err) {
			try {
				for (const [id, v] of priorHeaders) { if (v === undefined) registry.headers?.delete?.(id); else registry.headers?.set?.(id, v); }
				for (const [id, v] of priorPaths) { if (v === undefined) registry.sessionPaths?.delete?.(id); else registry.sessionPaths?.set?.(id, v); }
				for (const [id, v] of priorInvalid) { if (v === undefined) registry.invalidSessionPaths?.delete?.(id); else registry.invalidSessionPaths?.set?.(id, v); }
			} catch (restoreErr) {
				ctx.logger?.warn?.(`workspace-mover: index restore after abort failed (restart recommended): ${restoreErr?.message ?? restoreErr}`);
			}
			throw new Error(`重定向失败，已中止（未改动任何文件）：${err?.message ?? err}`);
		}
	}

	// ---- 逐会话：备份 → 改写头帧 → 物理搬移 → 清理常驻写入状态 ----
	const moved = [];
	const skipped = [...runningIds].map((sessionId) => ({
		sessionId,
		title: affected.find((it) => it.sessionId === sessionId)?.title ?? null,
		error: '会话正在进行中，已跳过'
	}));
	for (const { sessionId, title } of affected) {
		if (runningIds.has(sessionId)) continue; // 已在 skipped 中
		try {
			assertNotRunning(ctx, sessionId);
			const meta = headers.find((h) => String(h?.id) === String(sessionId));
			const srcArtifact = artifactPath(root, typeof meta?.cwd === 'string' ? meta.cwd : stalePath, sessionId);
			if (!existsSync(srcArtifact)) throw new Error(`档案缺失：${srcArtifact}`);
			const dstArtifact = artifactPath(root, targetCanon, sessionId);
			if (existsSync(dstArtifact)) throw new Error(`目标位置已有同名档案：${dstArtifact}`);

			const original = readFileSync(srcArtifact);
			stashBackup(String(sessionId), original);
			atomicWrite(srcArtifact, rewriteHeaderCwd(original, targetCanon));
			try {
				moveDir(dirname(srcArtifact), dirname(dstArtifact));
			} catch (err) {
				atomicWrite(srcArtifact, original);
				throw new Error(`物理搬移失败：${err?.message ?? err}`);
			}
			try {
				const srcProject = dirname(dirname(srcArtifact));
				if (existsSync(srcProject) && readdirSync(srcProject).length === 0) rmSync(srcProject, { recursive: true });
			} catch { /* ignore */ }

			let restartHint = null;
			try {
				if (peekService(ctx, 'sessions')?.get?.(sessionId) !== undefined) {
					persistence.coordinator?.states?.delete?.(String(sessionId));
				}
			} catch (err) {
				restartHint = '本次会话需重启 Harness 后才会完全写入新位置';
				ctx.logger?.warn?.(`workspace-mover: persistence state cleanup failed for ${sessionId}: ${err?.message ?? err}`);
			}
			// 旧路径散件（从未记账）落位后补挂账；已记账成员为幂等跳过
			try {
				if (!entity.record.sessionIds.includes(sessionId)) await entity.attachSession(sessionId);
			} catch (err) {
				throw new Error(`迁移完成但补挂账失败（可在会话修复面板重试）：${err?.message ?? err}`);
			}
			// 进程内热修：常驻头换新 / 投影缓存身份对齐（@ 缓存在批末统一失效）
			retargetLiveHeader(ctx, sessionId, targetCanon);
			await realignProjectionIdentity(ctx, sessionId, targetCanon);
			moved.push({ sessionId, title, restartHint });
		} catch (err) {
			skipped.push({ sessionId, title, error: err?.message ?? String(err) });
		}
	}

	// 批末统一失效以旧路径为根的 @ 文件引用搜索缓存
	invalidateFileReferenceSearches(ctx, stalePath);

	return { dryRun: false, from: stalePath, to: targetCanon, resumeMode, pathUpdated, movedCount: moved.length, moved, skipped };
}
//#endregion

//#region 会话回收站 + 备份管理（v0.9）

function pluginDataDir() {
	return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'workspace-mover');
}

function recycleDir() {
	return join(pluginDataDir(), 'recycle');
}

const TRASH_MANIFEST = 'wsm-manifest.json';

function dirSizeSync(dir) {
	let total = 0;
	for (const f of readdirSync(dir)) {
		const p = join(dir, f);
		let st;
		try { st = statSync(p); } catch { continue; }
		if (st.isDirectory()) total += dirSizeSync(p);
		else if (st.isFile()) total += st.size;
	}
	return total;
}

/** 定位会话档案：注册表索引 → 记账方路径 → persistence 头部，全部落空则抛错。 */
async function locateArtifact(ctx, sessionId) {
	const registry = ctx.workspaceRegistry;
	const persistence = ctx.sessionPersistence;
	if (!registry || !persistence) throw new Error('workspace registry or session persistence service unavailable');
	const root = persistence.root;
	const candidates = [];
	try { const p = registry.sessionPaths?.get?.(sessionId); if (typeof p === 'string' && p) candidates.push(p); } catch { /* ignore */ }
	for (const e of registry.list()) {
		try { if ([...e.record.sessionIds].includes(sessionId)) candidates.push(e.path); } catch { /* ignore */ }
	}
	try { const h = registry.headers?.get?.(sessionId); if (typeof h?.cwd === 'string') candidates.push(h.cwd); } catch { /* ignore */ }
	try {
		for (const meta of await persistence.list()) {
			if (String(meta?.id) === String(sessionId) && typeof meta?.cwd === 'string') candidates.push(meta.cwd);
		}
	} catch { /* ignore */ }
	for (const cwd of candidates) {
		const artifact = artifactPath(root, cwd, sessionId);
		if (existsSync(artifact)) return { artifact, cwd };
	}
	throw new Error(`session archive not found for '${sessionId}'`);
}

/** 投影缓存读取/删除/回写：老宿主缺 API 时全部降级为 no-op（官方语义：陈旧条目无害）。 */
function projectionTable(ctx) {
	try { return peekService(ctx, 'sessionProjectionCache')?.table ?? null; } catch { return null; }
}

function captureProjection(ctx, sessionId) {
	try {
		const table = projectionTable(ctx);
		if (typeof table?.get !== 'function') return null;
		return table.get(String(sessionId)) ?? null;
	} catch { return null; }
}

async function dropProjection(ctx, sessionId) {
	try {
		const table = projectionTable(ctx);
		if (typeof table?.delete !== 'function') return;
		await table.delete(String(sessionId));
	} catch (err) {
		ctx.logger?.warn?.(`workspace-mover: projection entry removal failed for ${sessionId} (stale entry is harmless): ${err?.message ?? err}`);
	}
}

async function writeProjection(ctx, sessionId, record, cwd) {
	try {
		const table = projectionTable(ctx);
		if (!table || typeof table.put !== 'function' || !record?.identity || !record?.rows) return;
		await table.put(String(sessionId), { ...record.identity, cwd }, record.rows);
	} catch (err) {
		ctx.logger?.warn?.(`workspace-mover: projection restore failed for ${sessionId} (title will rebuild lazily): ${err?.message ?? err}`);
	}
}

/** 归档集变更（fail-soft）：宿主缺持久写通道时跳过并返回 false，文件操作照常。 */
async function modifyArchiveSet(ctx, sessionId, add) {
	const registry = ctx.workspaceRegistry;
	if (!registry || typeof registry.enqueueOperation !== 'function' || typeof registry.setState !== 'function' || typeof registry.requireState !== 'function') {
		ctx.logger?.warn?.(`workspace-mover: host registry exposes no state mutation API; archive set change skipped for ${sessionId}`);
		return false;
	}
	try {
		await registry.enqueueOperation(async () => {
			const state = registry.requireState();
			const ids = [...(state.archivedSessionIds ?? [])].map(String);
			const next = add
				? (ids.includes(sessionId) ? ids : [...ids, sessionId])
				: ids.filter((id) => id !== sessionId);
			await registry.setState({ ...state, archivedSessionIds: next });
		});
		return true;
	} catch (err) {
		ctx.logger?.warn?.(`workspace-mover: archive set change failed for ${sessionId}: ${err?.message ?? err}`);
		return false;
	}
}

/** 从所有记账方摘除会话（moveSession 的 owners 扫描同款），返回被摘实体。 */
async function detachEverywhere(ctx, sessionId) {
	const registry = ctx.workspaceRegistry;
	const owners = registry.list().filter((e) => {
		try { return [...e.record.sessionIds].includes(sessionId); } catch { return false; }
	});
	for (const entity of owners) {
		try { await entity.detachSession(sessionId); } catch (err) {
			ctx.logger?.warn?.(`workspace-mover: detach failed for ${sessionId} on ${entity.id}: ${err?.message ?? err}`);
		}
	}
	return owners;
}

/** 清空注册表三张内存索引（moveSession 收尾同款）。 */
function forgetSessionIndexes(registry, sessionId) {
	try { registry.headers?.delete?.(sessionId); } catch { /* ignore */ }
	try { registry.sessionPaths?.delete?.(sessionId); } catch { /* ignore */ }
	try { registry.invalidSessionPaths?.delete?.(sessionId); } catch { /* ignore */ }
}

/** 删除会话 → 回收站：拒绝常驻内存会话，四件套清理（文件/记账/投影/索引），manifest 记录全部还原信息。 */
async function deleteSessionToTrash(ctx, { sessionId } = {}) {
	if (typeof sessionId !== 'string' || sessionId.length === 0) throw new Error('sessionId required');
	const registry = ctx.workspaceRegistry;
	const persistence = ctx.sessionPersistence;
	if (!registry || !persistence) throw new Error('workspace registry or session persistence service unavailable');
	if (peekService(ctx, 'sessions')?.get?.(sessionId) !== undefined) {
		throw new Error('session is resident in memory (open in the harness); close it or restart the harness before deleting');
	}
	assertNotRunning(ctx, sessionId);
	const { artifact, cwd: artifactCwd } = await locateArtifact(ctx, sessionId);
	const header = readHeader(readFileSync(artifact));
	const archived = readArchivedIds(registry).includes(sessionId);
	const projection = captureProjection(ctx, sessionId);
	const owners = await detachEverywhere(ctx, sessionId);
	forgetSessionIndexes(registry, sessionId);
	if (archived) await modifyArchiveSet(ctx, sessionId, false);
	const entryDir = join(recycleDir(), `${Date.now()}-${String(sessionId).replace(/[^A-Za-z0-9._-]/g, '_')}`);
	mkdirSync(entryDir, { recursive: true });
	let how = 'rename';
	try {
		how = moveDir(dirname(artifact), join(entryDir, 'session'));
	} catch (err) {
		try { rmSync(entryDir, { recursive: true, force: true }); } catch { /* ignore */ }
		throw new Error(`move to recycle failed: ${err?.message ?? err}`);
	}
	const manifest = {
		version: 1,
		sessionId: String(sessionId),
		title: typeof header?.title === 'string' && header.title.trim() ? header.title.trim() : null,
		cwd: artifactCwd ?? header?.cwd ?? null,
		ownerWorkspaceId: owners[0]?.id ?? null,
		ownerTitle: owners[0]?.title ?? null,
		archived,
		deletedAt: new Date().toISOString(),
		projection
	};
	writeFileSync(join(entryDir, TRASH_MANIFEST), JSON.stringify(manifest, null, 2));
	await dropProjection(ctx, String(sessionId));
	return { deleted: true, sessionId: String(sessionId), title: manifest.title, how };
}

function readTrashEntry(entryDir) {
	const manifestPath = join(entryDir, TRASH_MANIFEST);
	if (!existsSync(manifestPath)) return null;
	try { return JSON.parse(readFileSync(manifestPath, 'utf8')); } catch { return null; }
}

async function listTrash(ctx) {
	const dir = recycleDir();
	if (!dirExists(dir)) return { items: [], dir };
	const items = [];
	for (const entry of readdirSync(dir)) {
		const entryDir = join(dir, entry);
		if (!dirExists(entryDir)) continue;
		const manifest = readTrashEntry(entryDir);
		if (!manifest?.sessionId) continue;
		items.push({
			entry,
			sessionId: String(manifest.sessionId),
			title: manifest.title ?? null,
			cwd: manifest.cwd ?? null,
			ownerWorkspaceId: manifest.ownerWorkspaceId ?? null,
			ownerTitle: manifest.ownerTitle ?? null,
			archived: Boolean(manifest.archived),
			deletedAt: manifest.deletedAt ?? null,
			sizeBytes: dirSizeSync(join(entryDir, 'session'))
		});
	}
	items.sort((a, b) => (a.deletedAt < b.deletedAt ? 1 : -1));
	return { items, dir };
}

/** 从回收站还原：默认回原路径；给 targetWorkspaceId 时先移回原位再走完整 moveSession 管线。 */
async function restoreFromTrash(ctx, { sessionId, targetWorkspaceId } = {}) {
	if (typeof sessionId !== 'string' || sessionId.length === 0) throw new Error('sessionId required');
	const registry = ctx.workspaceRegistry;
	const persistence = ctx.sessionPersistence;
	if (!registry || !persistence) throw new Error('workspace registry or session persistence service unavailable');
	const dir = recycleDir();
	if (!dirExists(dir)) throw new Error(`no trashed session '${sessionId}'`);
	let entryDir = null;
	let manifest = null;
	for (const entry of readdirSync(dir)) {
		const candidate = join(dir, entry);
		const m = readTrashEntry(candidate);
		if (m && String(m.sessionId) === String(sessionId)) { entryDir = candidate; manifest = m; break; }
	}
	if (!entryDir) throw new Error(`no trashed session '${sessionId}'`);
	const sessionDir = join(entryDir, 'session');
	const artifactInTrash = join(sessionDir, ARTIFACT);
	if (!existsSync(artifactInTrash)) throw new Error(`trashed archive missing for '${sessionId}'`);
	if (peekService(ctx, 'sessions')?.get?.(sessionId) !== undefined) {
		throw new Error('a live session with this id already exists; restart the harness before restoring');
	}
	let existingPath = null;
	try { existingPath = registry.sessionPaths?.get?.(sessionId); } catch { /* ignore */ }
	if (existingPath) throw new Error('session id already exists in the workspace registry');
	const header = readHeader(readFileSync(artifactInTrash));
	const originalCwd = typeof header?.cwd === 'string' ? header.cwd : manifest.cwd;
	if (typeof originalCwd !== 'string' || originalCwd.length === 0) throw new Error('trashed manifest carries no original path');
	const originalArtifact = artifactPath(persistence.root, originalCwd, sessionId);
	let destPath = originalCwd;
	let targetEntity = registry.list().find((e) => { try { return samePath(e.path, originalCwd); } catch { return false; } }) ?? null;
	if (typeof targetWorkspaceId === 'string' && targetWorkspaceId.length > 0) {
		targetEntity = registry.get(targetWorkspaceId);
		if (!targetEntity) throw new Error(`unknown workspace '${targetWorkspaceId}'`);
		destPath = targetEntity.path;
	}
	if (existsSync(originalArtifact)) {
		if (!targetEntity || samePath(targetEntity.path, originalCwd)) {
			throw new Error(`original location is occupied by an archive with the same id: ${originalArtifact}; pass targetWorkspaceId to restore elsewhere`);
		}
	} else if (!targetEntity) {
		throw new Error(`original location '${originalCwd}' has no registered workspace; pass targetWorkspaceId to restore into one`);
	}
	// 先移回原位（头 cwd 与原位一致，attach 校验天然通过）
	const bytes = readFileSync(artifactInTrash);
	moveDir(sessionDir, dirname(originalArtifact));
	let restored = { restored: true, sessionId: String(sessionId), cwd: originalCwd, workspaceId: targetEntity?.id ?? null, moved: null };
	try {
		if (targetEntity && !samePath(originalCwd, destPath)) {
			// 原位只是中转：直接走现有 moveSession 全管线（备份/改写/热修/记账全套）
			restored.moved = await moveSession(ctx, { sessionId, targetWorkspaceId: targetEntity.id, sessionTitle: manifest.title ?? undefined });
			restored.cwd = restored.moved?.to?.cwd ?? destPath;
		} else if (targetEntity) {
			await targetEntity.attachSession(sessionId);
		}
		await writeProjection(ctx, String(sessionId), manifest.projection, restored.cwd);
		if (manifest.archived) await modifyArchiveSet(ctx, String(sessionId), true);
	} catch (err) {
		ctx.logger?.warn?.(`workspace-mover: restore of ${sessionId} landed unaccounted at ${restored.cwd}: ${err?.message ?? err}`);
		restored.warning = 'restored but not accounted; use the rescue panel to file it into a group';
	}
	try { rmSync(entryDir, { recursive: true, force: true }); } catch { /* ignore */ }
	return restored;
}

/** 彻底删除：rm 回收站条目。all=true 清空。 */
async function purgeTrash(ctx, { sessionId, all } = {}) {
	const dir = recycleDir();
	if (!dirExists(dir)) return { purged: 0 };
	let purged = 0;
	for (const entry of readdirSync(dir)) {
		const entryDir = join(dir, entry);
		if (!dirExists(entryDir)) continue;
		const manifest = readTrashEntry(entryDir);
		if (all || (typeof sessionId === 'string' && manifest?.sessionId === String(sessionId))) {
			rmSync(entryDir, { recursive: true, force: true });
			purged++;
		}
	}
	return { purged };
}

/** 备份聚合清单：按会话分组（文件名 `${id}.${ts}.zstd`），附投影标题与总占用。 */
async function listBackups(ctx) {
	const dir = backupDir();
	if (!dirExists(dir)) return { items: [], totalBytes: 0, dir };
	const titles = readProjectionTitles();
	const groups = new Map();
	for (const name of readdirSync(dir)) {
		const m = /^(.+)\.(\d+)\.zstd$/.exec(name);
		if (!m) continue;
		const [, id, ts] = m;
		let sizeBytes = 0;
		try { sizeBytes = statSync(join(dir, name)).size; } catch { continue; }
		const g = groups.get(id) ?? { sessionId: id, title: titles.get(id) ?? null, count: 0, totalBytes: 0, oldest: Number(ts), newest: Number(ts), files: [] };
		g.count++;
		g.totalBytes += sizeBytes;
		g.oldest = Math.min(g.oldest, Number(ts));
		g.newest = Math.max(g.newest, Number(ts));
		g.files.push({ name, ts: Number(ts), sizeBytes });
		groups.set(id, g);
	}
	const items = [...groups.values()].map((g) => ({
		...g,
		files: g.files.sort((x, y) => y.ts - x.ts).map(({ name, ts, sizeBytes }) => ({ name, ts, sizeBytes }))
	}));
	items.sort((a, b) => b.newest - a.newest);
	return { items, totalBytes: items.reduce((sum, it) => sum + it.totalBytes, 0), dir };
}

/** 从备份恢复会话：默认回备份里的原 cwd；占用/缺分组时给 targetWorkspaceId。回读校验。 */
async function restoreBackup(ctx, { sessionId, fileName, targetWorkspaceId } = {}) {
	if (typeof sessionId !== 'string' || sessionId.length === 0) throw new Error('sessionId required');
	const registry = ctx.workspaceRegistry;
	const persistence = ctx.sessionPersistence;
	if (!registry || !persistence) throw new Error('workspace registry or session persistence service unavailable');
	const dir = backupDir();
	if (peekService(ctx, 'sessions')?.get?.(sessionId) !== undefined) {
		throw new Error('a live session with this id exists; restart the harness before restoring');
	}
	let existingPath = null;
	try { existingPath = registry.sessionPaths?.get?.(sessionId); } catch { /* ignore */ }
	if (existingPath) throw new Error('session id already exists in the workspace registry');
	let path2 = null;
	if (typeof fileName === 'string' && fileName.length > 0) {
		if (!fileName.startsWith(`${sessionId}.`)) throw new Error('backup file does not belong to the given session');
		path2 = join(dir, basename(fileName));
	} else {
		const candidates = dirExists(dir)
			? readdirSync(dir).filter((f) => f.startsWith(`${sessionId}.`)).sort()
			: [];
		if (candidates.length === 0) throw new Error(`no backups found for '${sessionId}'`);
		path2 = join(dir, candidates[candidates.length - 1]);
	}
	if (!existsSync(path2)) throw new Error(`backup file not found: ${path2}`);
	const bytes = readFileSync(path2);
	const header = readHeader(bytes);
	if (String(header?.id) !== String(sessionId)) throw new Error(`backup header id mismatch: ${header?.id}`);
	const backupCwd = typeof header?.cwd === 'string' ? header.cwd : null;
	if (!backupCwd) throw new Error('backup header carries no cwd');
	let destCwd = backupCwd;
	let targetEntity = registry.list().find((e) => { try { return samePath(e.path, backupCwd); } catch { return false; } }) ?? null;
	if (typeof targetWorkspaceId === 'string' && targetWorkspaceId.length > 0) {
		targetEntity = registry.get(targetWorkspaceId);
		if (!targetEntity) throw new Error(`unknown workspace '${targetWorkspaceId}'`);
		destCwd = targetEntity.path;
	}
	if (!targetEntity) throw new Error(`backup cwd '${backupCwd}' has no registered workspace; pass targetWorkspaceId to restore into one`);
	const dstArtifact = artifactPath(persistence.root, destCwd, sessionId);
	if (existsSync(dstArtifact)) throw new Error(`destination artifact already exists: ${dstArtifact}`);
	const final = samePath(backupCwd, destCwd) ? bytes : rewriteHeaderCwd(bytes, destCwd);
	let created = false;
	try {
		mkdirSync(dirname(dstArtifact), { recursive: true });
		atomicWrite(dstArtifact, final);
		created = existsSync(dstArtifact);
		// 回读校验：id 与 cwd 双确认后才挂账
		const verify = readHeader(readFileSync(dstArtifact));
		if (String(verify?.id) !== String(sessionId) || !verify?.cwd || !samePath(verify.cwd, destCwd)) {
			throw new Error('restore verification failed (header round-trip mismatch)');
		}
		await targetEntity.attachSession(sessionId);
	} catch (err) {
		if (created) { try { rmSync(dirname(dstArtifact), { recursive: true, force: true }); } catch { /* ignore */ } }
		throw err;
	}
	return { restored: true, sessionId: String(sessionId), cwd: destCwd, workspaceId: targetEntity.id, fromBackup: basename(path2) };
}

/** 删除备份：fileName 指定单份；省略则清空该会话全部备份。 */
async function deleteBackup(ctx, { sessionId, fileName } = {}) {
	if (typeof sessionId !== 'string' || sessionId.length === 0) throw new Error('sessionId required');
	const dir = backupDir();
	if (!dirExists(dir)) return { deleted: 0 };
	let targets = [];
	if (typeof fileName === 'string' && fileName.length > 0) {
		if (!fileName.startsWith(`${sessionId}.`)) throw new Error('backup file does not belong to the given session');
		targets = [basename(fileName)];
	} else {
		targets = readdirSync(dir).filter((f) => f.startsWith(`${sessionId}.`));
	}
	let deleted = 0;
	for (const name of targets) {
		try { rmSync(join(dir, name), { force: true }); deleted++; } catch { /* ignore */ }
	}
	return { deleted };
}

export function apply(ctx) {
	const logger = ctx.logger ?? console;
	if (!ctx?.connection?.rpc?.handle) {
		logger.warn?.('workspace-mover: DSH Host Connection RPC unavailable — plugin idle | 无 Connection RPC，插件未启用');
		return;
	}

	const dispose = ctx.connection.rpc.handle(CHANNEL, async (endpoint, payload = {}, signal) => {
		if (signal?.aborted) return { ok: false, error: { code: 'cancelled', message: 'cancelled', details: {} } };
		try {
			switch (endpoint) {
				case 'mover.status':
					return ok({
						ready: Boolean(ctx.workspaceRegistry && ctx.sessionPersistence),
						channel: CHANNEL
					});
				case 'mover.workspaces':
					return ok(await listWorkspaces(ctx));
				case 'mover.history':
					return ok(await listHistory());
				case 'mover.undo':
					try {
						return ok(await undoMove(ctx, payload?.historyId));
					} catch (err) {
						return failBadRequest(err?.message ?? String(err));
					}
				case 'mover.scan':
					return ok(await scanSessions(ctx));
				case 'mover.repair': {
					try {
						return ok(await repairSessions(ctx, payload?.actions));
					} catch (err) {
						return failBadRequest(err?.message ?? String(err));
					}
				}
				case 'mover.move': {
					const sessionId = payload?.sessionId;
					const targetWorkspaceId = payload?.targetWorkspaceId;
					if (typeof sessionId !== 'string' || sessionId.length === 0) return failBadRequest('sessionId required');
					if (typeof targetWorkspaceId !== 'string' || targetWorkspaceId.length === 0) return failBadRequest('targetWorkspaceId required');
					try {
						const result = await moveSession(ctx, { sessionId, targetWorkspaceId, sessionTitle: payload?.sessionTitle });
						logger.info?.(`workspace-mover: moved ${sessionId} -> ${result.to.cwd}`);
						return ok(result);
					} catch (err) {
						logger.warn?.(`workspace-mover: MOVE FAILED sessionId=${sessionId} target=${targetWorkspaceId}: ${err?.message ?? err}`);
						return failBadRequest(err?.message ?? String(err));
					}
				}
				case 'mover.moveMany': {
					try {
						return ok(await moveManySessions(ctx, payload ?? {}));
					} catch (err) {
						logger.warn?.(`workspace-mover: MOVE MANY FAILED target=${payload?.targetWorkspaceId}: ${err?.message ?? err}`);
						return failBadRequest(err?.message ?? String(err));
					}
				}
				case 'mover.ws.audit':
					return ok(await auditWorkspaces(ctx));
				case 'mover.archived':
					return ok(await listArchivedSessions(ctx));
				case 'mover.unarchive': {
					try {
						return ok(await unarchiveSession(ctx, payload ?? {}));
					} catch (err) {
						logger.warn?.(`workspace-mover: UNARCHIVE FAILED session=${payload?.sessionId}: ${err?.message ?? err}`);
						return failBadRequest(err?.message ?? String(err));
					}
				}
				case 'mover.openFolder': {
					try {
						return ok(await openWorkspaceFolder(ctx, payload ?? {}));
					} catch (err) {
						logger.warn?.(`workspace-mover: OPEN FOLDER FAILED ${payload?.workspaceId ?? payload?.path}: ${err?.message ?? err}`);
						return failBadRequest(err?.message ?? String(err));
					}
				}
				case 'mover.session.delete': {
					try {
						return ok(await deleteSessionToTrash(ctx, payload ?? {}));
					} catch (err) {
						logger.warn?.(`workspace-mover: DELETE FAILED session=${payload?.sessionId}: ${err?.message ?? err}`);
						return failBadRequest(err?.message ?? String(err));
					}
				}
				case 'mover.trash.list':
					return ok(await listTrash(ctx));
				case 'mover.trash.restore': {
					try {
						return ok(await restoreFromTrash(ctx, payload ?? {}));
					} catch (err) {
						logger.warn?.(`workspace-mover: TRASH RESTORE FAILED session=${payload?.sessionId}: ${err?.message ?? err}`);
						return failBadRequest(err?.message ?? String(err));
					}
				}
				case 'mover.trash.purge': {
					try {
						return ok(await purgeTrash(ctx, payload ?? {}));
					} catch (err) {
						return failBadRequest(err?.message ?? String(err));
					}
				}
				case 'mover.backups.list':
					return ok(await listBackups(ctx));
				case 'mover.backups.restore': {
					try {
						return ok(await restoreBackup(ctx, payload ?? {}));
					} catch (err) {
						logger.warn?.(`workspace-mover: BACKUP RESTORE FAILED session=${payload?.sessionId}: ${err?.message ?? err}`);
						return failBadRequest(err?.message ?? String(err));
					}
				}
				case 'mover.backups.deleteOne': {
					try {
						return ok(await deleteBackup(ctx, payload ?? {}));
					} catch (err) {
						return failBadRequest(err?.message ?? String(err));
					}
				}
				case 'mover.repoint': {
					try {
						return ok(await repointWorkspace(ctx, payload ?? {}));
					} catch (err) {
						logger.warn?.(`workspace-mover: REPOINT FAILED ws=${payload?.workspaceId}: ${err?.message ?? err}`);
						return failBadRequest(err?.message ?? String(err));
					}
				}
				default:
					return failBadRequest(`unknown endpoint '${endpoint}'`);
			}
		} catch (err) {
			return failBadRequest(err?.message ?? String(err));
		}
	}, { authority: 'loopback' });

	ctx.effect?.(() => () => { try { dispose?.(); } catch { /* ignore */ } }, 'workspace-mover: rpc dispose');
}

export { name, inject, CHANNEL, projectKey, encodeSegment, sessionDir, artifactPath, moveDir, stashBackup };
