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
// 兼容：Node >= 22（zlib zstd*），dsh 0.1.5-rc.1。
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

import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, readdirSync, rmSync, statSync, cpSync, statfsSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { zstdDecompressSync, zstdCompressSync, constants } from 'node:zlib';
import { join, dirname, basename } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { Config, POLICY_FIELDS, buildConfig, attachConfig } from './config.js';

const name = 'workspace-mover';
// tools/approval 由 dsh-tools / dsh-user-approval 提供（dsh-base 默认挂载）；
// 缺失时 Inject.resolve 填 null，agent 工具与审批门相应降级。
const inject = ['workspaceRegistry', 'sessionPersistence', 'tools', 'approval'];

const CHANNEL = '/workspace-mover';
const ZSTD_MAGIC = 4247762216;
/** Current write generation: DSH 0.1.5 treats the highest canonical generation as source of truth. */
const CURRENT_GENERATION = 3;
const HISTORY_FILE = 'history.json';

//#region 可调策略
/**
 * 策略读取：**在使用点调用**（与官方 Config 文档"按需读 .get()"的建议一致，
 * 不在模块顶层冻结），优先级为 插件 Config → 环境变量 → 代码默认值。
 *
 * 环境变量是本插件持有的兜底通道：官方 Config 需要 schemastery（宿主 loader 提供，
 * 插件目录下不可解析），所以任何静态 import 都可能打断 boot。这里只做纯读取，
 * Config 接入见 lib/config.js。
 */
const POLICY_DEFAULTS = {
	historyLimit: 100,
	backupKeep: 20,
	batchLimit: 50,
	repointLimit: 200,
	scanLimit: 400,
	cleanupDays: 30
};
/** 环境变量名 → 策略键。 */
const POLICY_ENV = {
	DSH_WORKSPACE_MOVER_HISTORY_LIMIT: 'historyLimit',
	DSH_WORKSPACE_MOVER_BACKUP_KEEP: 'backupKeep',
	DSH_WORKSPACE_MOVER_BATCH_LIMIT: 'batchLimit',
	DSH_WORKSPACE_MOVER_REPOINT_LIMIT: 'repointLimit',
	DSH_WORKSPACE_MOVER_SCAN_LIMIT: 'scanLimit',
	DSH_WORKSPACE_MOVER_CLEANUP_DAYS: 'cleanupDays'
};

/** 解析一个正整数策略值；非法/越界一律回退默认（配置错误不应让功能不可用）。 */
function resolvePolicy(key, min, max) {
	const raw = process.env[Object.keys(POLICY_ENV).find((env) => POLICY_ENV[env] === key)];
	if (raw !== undefined && String(raw).trim() !== '') {
		const n = Number(String(raw).trim());
		if (Number.isFinite(n) && Number.isInteger(n) && n >= min && n <= max) return n;
	}
	return POLICY_DEFAULTS[key];
}

/** 历史保留条数。 */
const historyLimit = () => resolvePolicy('historyLimit', 1, 10000);
/** 每个会话保留的迁移备份份数。 */
const backupKeep = () => resolvePolicy('backupKeep', 1, 1000);
/** 单批移动/修复上限。 */
const batchLimit = () => resolvePolicy('batchLimit', 1, 500);
/** 单个工作区搬家上限。 */
const repointLimit = () => resolvePolicy('repointLimit', 1, 5000);
/** 救援扫描解析上限。 */
const scanLimit = () => resolvePolicy('scanLimit', 1, 100000);
/** 数据清理默认天数。 */
const cleanupDays = () => resolvePolicy('cleanupDays', 1, 3650);
//#endregion


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

/** Official naming: v0 = session.jsonl[.zstd]; vN = session.vN.jsonl[.zstd]. */
function generationLogFilename(version, compression = 'zstd') {
	const base = Number(version) === 0 ? 'session.jsonl' : `session.v${Number(version)}.jsonl`;
	return compression === 'zstd' ? `${base}.zstd` : base;
}

function parseGenerationLogFilename(filename) {
	const name = String(filename ?? '');
	let compression = 'none';
	let stem = name;
	if (stem.endsWith('.zstd')) {
		compression = 'zstd';
		stem = stem.slice(0, -5);
	}
	if (stem === 'session.jsonl') return { version: 0, compression, name };
	const m = /^session\.v([1-9][0-9]*)\.jsonl$/.exec(stem);
	if (!m) return null;
	return { version: Number(m[1]), compression, name };
}

function listGenerationArtifacts(dir) {
	if (!existsSync(dir)) return [];
	try { if (!statSync(dir).isDirectory()) return []; } catch { return []; }
	const out = [];
	for (const entry of readdirSync(dir)) {
		const parsed = parseGenerationLogFilename(entry);
		if (!parsed) continue;
		const path = join(dir, entry);
		try {
			if (!statSync(path).isFile()) continue;
		} catch {
			continue;
		}
		out.push({ ...parsed, path });
	}
	return out.sort((a, b) => b.version - a.version || a.name.localeCompare(b.name));
}

function findHighestArtifact(dir, compression = 'zstd') {
	const entries = listGenerationArtifacts(dir);
	const encodings = new Set(entries.map((entry) => entry.compression));
	if (encodings.size > 1) {
		const err = new Error(`mixed session compression encodings under: ${dir}`);
		err.code = 'unsupported';
		throw err;
	}
	if (entries.length > 0 && !encodings.has(compression)) {
		const actual = [...encodings][0];
		const err = new Error(`session compression ${actual} does not match configured ${compression} under: ${dir}`);
		err.code = 'unsupported';
		throw err;
	}
	return entries[0] ?? null;
}

function preferredArtifactName(compression = 'zstd') {
	return generationLogFilename(CURRENT_GENERATION, compression);
}

/** Resolve the highest generation in a session directory; fall back to the default write name. */
function artifactPath(root, cwd, id, compression = 'zstd') {
	const dir = sessionDir(root, cwd, id);
	const found = findHighestArtifact(dir, compression);
	return found?.path ?? join(dir, preferredArtifactName(compression));
}

function persistenceCompression(persistence) {
	return persistence?.compression === 'none' ? 'none' : 'zstd';
}


// DSH 0.1.5 returns persistence.list() snapshots as { header, revision, sizeBytes }.
// Keep accepting the older flat { id, cwd, ... } shape used by earlier hosts/tests.
function persistenceHeader(snapshot) {
	const header = snapshot?.header;
	return header && typeof header === typeof {} ? header : snapshot;
}

async function listPersistenceHeaders(persistence) {
	const snapshots = await persistence.list();
	if (!Array.isArray(snapshots)) return [];
	return snapshots.map(persistenceHeader).filter((header) => header && typeof header === typeof {});
}
function findDestinationArtifact(dir, compression) {
	try {
		if (existsSync(dir) && !statSync(dir).isDirectory()) {
			const err = new Error(`target is not a directory: ${dir}`);
			err.code = 'ENOTDIR';
			throw err;
		}
		return findHighestArtifact(dir, compression);
	} catch (err) {
		if (['ENOTDIR', 'EACCES', 'EPERM'].includes(err?.code)) {
			const e = new Error(`target not writable: ${dir}`);
			e.code = 'not-writable';
			throw e;
		}
		throw err;
	}
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
export function readHeader(buf, compression = 'zstd') {
	if (compression === 'none') {
		const end = buf.indexOf(10);
		if (end < 0) throw new Error('first line is not newline-terminated');
		if (end === 0) throw new Error('empty session artifact');
		return JSON.parse(buf.subarray(0, end).toString('utf8'));
	}
	const frames = scanFrames(buf);
	if (frames.length < 1) throw new Error('empty session artifact');
	const [s, e] = frames[0];
	const text = zstdDecompressSync(buf.subarray(s, e)).toString('utf8');
	if (text.length === 0 || text.charCodeAt(text.length - 1) !== 10) throw new Error('first frame is not one newline-terminated header line');
	if (text.indexOf('\n') !== text.length - 1) throw new Error('first frame carries more than the header line');
	return JSON.parse(text);
}

/** 用新 cwd 重写首帧并拼回其余帧（字节级保留）。返回新 Buffer。 */
export function rewriteHeaderCwd(buf, nextCwd, compression = 'zstd') {
	if (compression === 'none') {
		const end = buf.indexOf(10);
		if (end < 0) throw new Error('first line is not newline-terminated');
		const header = readHeader(buf, 'none');
		header.cwd = nextCwd;
		return Buffer.concat([Buffer.from(JSON.stringify(header) + '\n', 'utf8'), buf.subarray(end + 1)]);
	}
	const header = readHeader(buf, 'zstd');
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

/**
 * 迁移后一致性校验：目标档案可回读、id 与 cwd 双确认。
 * 复制路径的静默截断、头改写遗漏都会在这里现形。
 */
function verifyRelocatedArtifact(dstArtifact, sessionId, expectedCwd, compression = 'zstd') {
	const header = readHeader(readFileSync(dstArtifact), compression);
	if (String(header?.id) !== String(sessionId)) {
		throw new Error(`header id mismatch: expected '${sessionId}', got '${header?.id}'`);
	}
	if (typeof header?.cwd !== 'string' || !samePath(header.cwd, expectedCwd)) {
		throw new Error(`header cwd mismatch: expected '${expectedCwd}', got '${header?.cwd}'`);
	}
	return true;
}
//#endregion

//#region 备份管理（$DSH_HOME/workspace-mover/backups，保留最近 20 份）
function backupDir() {
	const home = process.env.DSH_HOME ?? join(homedir(), '.dsh');
	return join(home, 'workspace-mover', 'backups');
}

/**
 * 备份文件名：`${id}.${epochMs}[-seq].zstd`。
 *
 * 为什么需要 `-seq`：毫秒时间戳不足以区分同一毫秒内的两次备份，而 Linux 的时钟/文件系统
 * 时间戳粒度比 Windows 粗得多，连续两次 stash 极可能落在同一毫秒。此时文件名相撞，
 * 第二次会**覆盖**第一次——用户配置的保留份数（backupKeep）于是静默失效，实际只留下
 * 一份。这不是假设：CI 的 ubuntu / macos 作业就是这样挂掉的。
 *
 * 命名规则：
 * - 无 `-seq`：`atomicWrite` 的 temp+rename 是覆盖语义，等于"同毫秒最后一次胜出"，
 *   同时把该毫秒的文件数限制为 1（保留原有测试断言的"同毫秒覆盖"行为，也避免浪费空间）。
 * - 带 `-seq`：该毫秒已被占用时递增，保证每次调用都留下独立的备份文件。
 * 两种形态的排序都保持近似的"旧→新"顺序（`-` = 0x2D < `.` = 0x2E，所以 `ts` 排在
 * `ts-seq` 之前，`ts-seq2` 又排在 `ts-seq10` 之前——同一毫秒内顺序仅影响裁剪，不影响正确性）。
 */
function backupPath(id) {
	const dir = backupDir();
	const ts = Date.now();
	const base = join(dir, `${id}.${ts}.zstd`);
	if (!existsSync(base)) return base;
	for (let seq = 2; seq < 1000; seq++) {
		const candidate = join(dir, `${id}.${ts}-${seq}.zstd`);
		if (!existsSync(candidate)) return candidate;
	}
	// 极端情况：同一毫秒 1000 次备份。退化为加序号强制唯一，绝不覆盖既有备份。
	return join(dir, `${id}.${ts}-${Math.random().toString(36).slice(2, 8)}.zstd`);
}

function stashBackup(id, buf) {
	try {
		const dir = backupDir();
		mkdirSync(dir, { recursive: true });
		atomicWrite(backupPath(id), buf);
		// 前缀收紧到 `${id}.`：相邻 id（如 session-x 与 session-x-1）的备份互不误删
		const keep = readdirSync(dir).filter((f) => f.startsWith(`${id}.`)).sort();
		while (keep.length > backupKeep()) rmSync(join(dir, keep.shift()), { force: true });
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
	atomicWrite(path, Buffer.from(JSON.stringify(entries.slice(-historyLimit()), null, 2) + '\n', 'utf8'));
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
const fail = (code, message, details = {}) => ({
	ok: false,
	error: { code, message, details: { issues: [{ message }], ...details } }
});
const failBadRequest = (message, details = {}) => fail('bad-request', message, details);

//#region 并发防护（v1.4）：try-acquire 锁，绝不等待——占用即 busy
const busyKeys = new Map(); // 'session:<id>' | 'workspace:<id>'

function busyError(key) {
	const [kind, id] = key.split(':');
	const err = new Error(kind === 'session'
		? `session '${id}' is busy: another operation is in flight`
		: `workspace '${id}' is busy: a bulk operation is in flight`);
	err.code = 'busy';
	return err;
}

/** 一次性获取一组锁；任一被占即整体失败（已获取的立即释放），返回释放函数。 */
function acquireLocks(...keys) {
	const held = [];
	try {
		for (const key of keys) {
			if (busyKeys.has(key)) throw busyError(key);
			busyKeys.set(key, true);
			held.push(key);
		}
	} catch (err) {
		for (const k of held) busyKeys.delete(k);
		throw err;
	}
	return () => { for (const k of held) busyKeys.delete(k); };
}

/** 把抛出的异常映射为稳定错误码（客户端按 code 决定交互，不再匹配英文文案）。 */
function mapError(err) {
	const msg = String(err?.message ?? err);
	if (err?.code === 'ENOTDIR') return fail('not-writable', `target not writable: ${msg}`);
	if (err?.code && err.code !== 'bad-request') return fail(err.code, msg);
	let code = 'internal-error';
	if (/running|resident in memory|is busy/.test(msg)) code = 'busy';
	else if (/already belongs|already exists|not empty \(refusing/.test(msg)) code = 'conflict';
	else if (/not writable/.test(msg)) code = 'not-writable';
	else if (/insufficient disk space/.test(msg)) code = 'insufficient-space';
	else if (/backup failed, nothing was changed/.test(msg)) code = 'backup-failed';
	else if (/rolled back|rollback|verification failed|move failed|manifest write failed|restore verification|relocate step/.test(msg)) code = 'rollback-failed';
	else if (/unsupported|no state mutation API/.test(msg)) code = 'unsupported';
	else if (/corrupt|mismatch|unreadable|does not match its schema|trashed archive missing|archive missing/.test(msg)) code = 'corrupt-artifact';
	else if (/not found|not archived|not found in session persistence|no trashed session|no backups found|unknown endpoint|unknown workspace|no workspace accounts|no registered workspace/.test(msg)) code = 'not-found';
	else if (/required|must be|too many|invalid|cannot be empty|no matching/.test(msg)) code = 'invalid-input';
	return fail(code, msg);
}
//#endregion

/** 入口封装：会话锁 + 源/目标工作区锁（try-acquire，占用即 busy）。 */
async function moveSessionEntry(ctx, payload = {}, hooks = {}) {
	const sessionId = validId(payload?.sessionId, 'sessionId');
	const targetWorkspaceId = validId(payload?.targetWorkspaceId, 'targetWorkspaceId');
	const release = acquireLocks(
		`session:${sessionId}`,
		`workspace:${targetWorkspaceId}`
	);
	try {
		return await moveSession(ctx, { ...payload, sessionId, targetWorkspaceId }, hooks);
	} finally {
		release();
	}
}

/**
 * 迁移一个空闲会话到目标工作区（核心实现，不含锁；入口请走 moveSessionEntry）。
 * 顺序：备份 → 预检 → detach → 改写+搬运（失败自动还原）→ 缓存失效 → attach（失败自动回滚）。
 * stashImpl 可注入（测试模拟备份失败）。
 */
async function moveSession(ctx, { sessionId, targetWorkspaceId, sessionTitle, recordHistory = true }, hooks = {}) {
	const { stashImpl = stashBackup } = hooks;
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
	const liveSession = peekService(ctx, 'sessions')?.get?.(sessionId);
	const materialized = liveSession !== undefined;
	const priorLiveHeader = liveSession?.header;

	// ---- 从磁盘取权威头（不依赖注册表缓存）----
	const headers = await listPersistenceHeaders(persistence);
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
		const accounted = rawRecordSessionIds(target).includes(String(sessionId));
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
	const compression = persistenceCompression(persistence);
	const srcDir = sessionDir(root, sourceCwd, sessionId);
	const dstDir = sessionDir(root, targetPath, sessionId);
	const srcFound = findHighestArtifact(srcDir, compression);
	if (!srcFound) throw new Error(`session artifact missing under: ${srcDir}`);
	const srcArtifact = srcFound.path;
	if (findDestinationArtifact(dstDir, compression)) throw new Error(`destination artifact already exists under: ${dstDir}`);
	const dstArtifact = join(dstDir, srcFound.name);

	// ---- 备份先行：备份失败 = 零副作用（尚未触碰记账/索引/目标路径）----
	const original = readFileSync(srcArtifact);
	try {
		stashImpl(String(sessionId), original);
	} catch (err) {
		const e = new Error(`backup failed, nothing was changed: ${err?.message ?? err}`);
		e.code = 'backup-failed';
		throw e;
	}

	// ---- 预检（在改动任何记账之前；任何失败都不落地）----
	const warnings = [];
	const allOwners = listOwners(registry, sessionId);
	if (allOwners.length > 1) {
		// 双记账：移动时把多余归属一并摘除，否则会残留幽灵记账
		warnings.push('double-accounted');
		ctx.logger?.warn?.(`workspace-mover: session ${sessionId} is accounted by ${allOwners.length} workspaces; extra owners will be detached`);
	}
	try {
		const probeDir = dirname(dstArtifact);
		mkdirSync(probeDir, { recursive: true });
		const probe = join(probeDir, `.wsm-probe-${Date.now()}`);
		writeFileSync(probe, Buffer.alloc(0));
		rmSync(probe, { force: true });
	} catch (err) {
		// 源头挂码：底层 EEXIST 文案含 "already exists"，交给 mapError 正则会误判为 conflict
		const e = new Error(`target not writable: ${err?.message ?? err}`);
		e.code = 'not-writable';
		throw e;
	}
	try {
		// 提示性检查（Windows 下与实际写入存在竞态）：不通过则尽早失败（此时零改动），
		// 通过也不构成保证——真正的兜底是复制失败清理 + 迁移后回读校验。
		const st = statfsSync(dirname(dstArtifact));
		const needed = Math.max(Number(st.bsize) || 4096, statSync(srcArtifact).size * 2);
		if (typeof st.bfree === 'number' && st.bfree * Number(st.bsize || 4096) < needed) {
			const e = new Error(`insufficient disk space at target (need ~${needed} bytes, free ~${st.bfree * Number(st.bsize || 4096)})`);
			e.code = 'insufficient-space';
			throw e;
		}
	} catch (err) {
		if (err?.code === 'insufficient-space' || /insufficient disk space/.test(String(err?.message ?? err))) throw err;
		ctx.logger?.warn?.(`workspace-mover: disk space check skipped: ${err?.message ?? err}`);
	}

	// ---- detach（纯记账；失败不阻断）——双记账会话把多余归属一并摘除，避免移动后残留幽灵 ----
	await detachEverywhere(ctx, sessionId);

	// ---- 改写 → 搬运 ----
	const rewritten = rewriteHeaderCwd(original, targetPath, compression);

	try {
		atomicWrite(srcArtifact, rewritten);
	} catch (err) {
		for (const e of allOwners) { try { if (!rawRecordSessionIds(e).includes(String(sessionId))) await e.attachSession?.(sessionId); } catch { /* ignore */ } }
		throw new Error(`move failed while rewriting header: ${err?.message ?? err}`);
	}

	try {
		const how = moveDir(dirname(srcArtifact), dirname(dstArtifact));
		// 迁移后一致性校验：目标档案可回读、id/cwd 双确认。失败视同搬运失败，整体回退。
		try {
			verifyRelocatedArtifact(dstArtifact, sessionId, targetPath, compression);
		} catch (verifyErr) {
			try { moveDir(dirname(dstArtifact), dirname(srcArtifact)); } catch { /* 尽力移回 */ }
			throw new Error(`post-move verification failed: ${verifyErr?.message ?? verifyErr}`);
		}
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

	// ---- 常驻会话：先修正进程内 live header，再走官方 attach 写路径 ----
	// DSH 0.1.5 的 WorkspaceEntity.attachSession() 只有在目标快照尚未记账时
	// 才会读取 header 并经 mutate 发出 domain/changed。不能直接预置
	// target.record.sessionIds，否则 attach 变成 no-op，WorkspaceFeed 不会推送目标
	// 工作区的更新帧，浏览器就会暂时把会话显示在“未分组”。
	try {
		if (materialized) {
			const retargeted = retargetLiveHeader(ctx, sessionId, targetPath);
			if (retargeted === null) throw new Error('live session header retarget failed');
		}
		await target.attachSession(sessionId);
	} catch (err) {
		// 自动回滚：还原 live header 与索引 → 原件放回源目录 → 重新挂回源工作区
		try {
			if (materialized && liveSession) liveSession.header = priorLiveHeader;
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
			for (const e of allOwners) {
				try { if (!rawRecordSessionIds(e).includes(String(sessionId))) await e.attachSession?.(sessionId); } catch { /* ignore */ }
			}
		} catch (rollbackErr) {
			recordRecovery(ctx, {
				kind: 'move', phase: 'attach-rollback', sessionId: String(sessionId),
				source: sourceCwd, target: targetPath, backup: backupDir(),
				lastError: `attach failed (${err?.message ?? err}) AND rollback failed (${rollbackErr?.message ?? rollbackErr})`
			});
			throw new Error(`move failed during attach (${err?.message ?? err}) AND rollback failed (${rollbackErr?.message ?? rollbackErr}). Original bytes stashed under ${backupDir()}`);
		}
		throw new Error(`move failed during target attach, rolled back cleanly: ${err?.message ?? err}`);
	}

	// ---- 进程内热修：@ 搜索缓存失效 / 投影缓存身份对齐 ----
	invalidateFileReferenceSearches(ctx, sourceCwd);
	await realignProjectionIdentity(ctx, sessionId, targetPath);

	// ---- registry 单一归属收尾：任何双记账残留在此清零 ----
	try {
		const extras = listOwners(registry, sessionId).filter((e) => e.id !== targetWorkspaceId);
		for (const e of extras) {
			await e.detachSession?.(sessionId);
			ctx.logger?.warn?.(`workspace-mover: post-move cleanup detached stale owner ${e.id} for ${sessionId}`);
		}
	} catch { /* ignore */ }

	const result = {
		moved: true,
		verified: true,
		sessionId,
		title,
		from: { cwd: sourceCwd },
		to: { cwd: targetPath, workspaceId: targetWorkspaceId },
		cacheInvalidated,
		restartHint,
		warnings
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
		rawSessionCount: (() => { try { return rawRecordSessionIds(entity).length; } catch { return undefined; } })()
	}));
	let archivedSessionIds = [];
	try { archivedSessionIds = [...registry.archivedSessionIds]; } catch { /* ignore */ }
	return { items, archivedSessionIds };
}

//#region 孤儿会话救援（v0.3）：扫描分类 + 批量重挂
const SCAN_MAX_ITEMS = 400; // 默认值（导出用于测试/文档）；实际生效扫描上限见 scanLimit()

function dirExists(p) {
	if (typeof p !== 'string' || p.length === 0) return false;
	try {
		return statSync(p).isDirectory();
	} catch {
		return false;
	}
}

/**
 * 存储布局自证（只读，永不抛错）。
 *
 * 本插件的整条管线都建立在两个**未文档化**的假设上：
 *   ① `persistence.root` 存在（`SessionPersistence` 的文档化接口只有 create/open/stat/list）；
 *   ② 目录布局等于本地复刻的 `projectKey` / `encodeSegment`（见上面的"最小移植"注释）。
 * 宿主一旦改变其中任何一项，`sessionDir()` 会静默指向不存在的路径，表现为
 * "所有会话都找不到"而没有任何线索。
 *
 * 这里用真实会话反推一次目录：从 persistence.list() 拿 header，算出它**应该**在的位置，
 * 再用 findHighestArtifact 验证该位置确实有档案。对不上就是 degraded。
 *
 * @returns {{status:'ok'|'degraded'|'empty'|'unavailable', checked:number, path?:string, reason?:string}}
 */
async function verifyStorageLayout(ctx) {
	const persistence = ctx?.sessionPersistence;
	if (!persistence) return { status: 'unavailable', checked: 0, reason: 'session persistence service unavailable' };
	const root = persistence.root;
	if (typeof root !== 'string' || root.length === 0) {
		return { status: 'degraded', checked: 0, reason: 'persistence backend exposes no root' };
	}
	let headers;
	try {
		headers = await listPersistenceHeaders(persistence);
	} catch (err) {
		return { status: 'unavailable', checked: 0, reason: `persistence.list() failed: ${err?.message ?? err}` };
	}
	if (headers.length === 0) return { status: 'empty', checked: 0, path: root };
	const compression = persistenceCompression(persistence);
	// 取最新几条做样本：编码边界（多字节/分隔符/驱动器号）更容易在其中一条上暴露
	const sample = headers.slice(0, 5);
	for (const header of sample) {
		const { id, cwd } = header;
		if (id === undefined || typeof cwd !== 'string' || cwd.length === 0) continue;
		const expectedDir = sessionDir(root, cwd, id);
		try {
			if (findHighestArtifact(expectedDir, compression)) {
				return { status: 'ok', checked: sample.length, path: root };
			}
		} catch (err) {
			// 混合压缩编码等显式拒绝：布局本身可能是对的，但当前配置读不了它
			return { status: 'degraded', checked: sample.length, path: root, reason: `cannot read derived directory: ${err?.message ?? err}` };
		}
	}
	return {
		status: 'degraded',
		checked: sample.length,
		path: root,
		reason: 'no session archive found at the layout this plugin derives — the host storage layout may have changed'
	};
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
	const compression = persistenceCompression(persistence);

	const entities = registry.list();
	let archived = new Set();
	try { archived = new Set([...registry.archivedSessionIds]); } catch { /* ignore */ }
	const projectionTitles = readProjectionTitles();

	const items = [];
	const seenArtifacts = new Set();
	const metas = [];
	let total = 0;
	// 第一遍：只收集元数据（含超限），按 mtime 降序后仅解析最新 SCAN_MAX_ITEMS 条——
	// 旧实现"目录序先到先得"会在大库下把最新会话截掉。
	for (const proj of readdirSync(root)) {
		if (!(proj.startsWith('--') && proj.endsWith('--'))) continue; // 只认 projectKey 目录
		const projPath = join(root, proj);
		if (!dirExists(projPath)) continue;
		for (const idDir of readdirSync(projPath)) {
			const found = findHighestArtifact(join(projPath, idDir), compression);
			if (!found) continue;
			const artifact = found.path;
			let st;
			try { st = statSync(artifact); } catch { continue; }
			if (!st.isFile()) continue;
			total++;
			metas.push({ artifact, idDir, st });
		}
	}
	metas.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
	const selected = metas.slice(0, scanLimit());
	for (const { artifact, idDir, st } of selected) {
		seenArtifacts.add(artifact);
		let header = null;
		try { header = readHeader(readFileSync(artifact), compression); } catch { header = null; }
		const sessionId = String(header?.id ?? idDir);
		const cwd = typeof header?.cwd === 'string' ? header.cwd : null;
		const alive = dirExists(cwd);
		const matching = cwd ? entities.find((e) => { try { return samePath(e.path, cwd); } catch { return false; } }) : undefined;
		// 记账方按原始 record 计算（公开 getter 会过滤掉幽灵 id）；
		// 「误放」= 有记账方但不是 cwd 匹配的那个工作区（克隆工具、路径漂移、改名后重建分组）。
		const owners = entities.filter((e) => {
			try { return rawRecordSessionIds(e).includes(String(sessionId)); } catch { return false; }
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

	const ghosts = [];
	for (const entity of entities) {
		let ids = [];
		// 幽灵正是「有账无档」的 id，而官方公开的 sessionIds getter 会把它们
		// 按索引过滤掉——必须遍历原始记账 record.sessionIds 才能看见它们。
		try { ids = rawRecordSessionIds(entity); } catch { continue; }
		for (const id of ids) {
			try {
				if (!existsSync(artifactPath(root, entity.path, id, compression))) ghosts.push({ workspaceId: entity.id, sessionId: String(id) });
			} catch { /* skip */ }
		}
	}

	items.sort((a, b) => b.mtimeMs - a.mtimeMs);
	return {
		root,
		scanned: total,
		scannedParsed: items.length,
		truncated: total > items.length,
		recoveryCount: recoveryCount(),
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
	const headers = await listPersistenceHeaders(persistence);
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
	if (sessions.length > batchLimit()) throw new Error(`too many sessions in one batch (max ${batchLimit()}, got ${sessions.length})`);
	if (typeof targetWorkspaceId !== 'string' || targetWorkspaceId.length === 0) throw new Error('targetWorkspaceId required');
	// 批内去重：同一会话在一次批量里只处理一次
	const seenIds = new Set();
	sessions = sessions.filter((item) => {
		const sid = String(item?.sessionId ?? '');
		if (!sid || seenIds.has(sid)) return false;
		seenIds.add(sid);
		return true;
	});
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
			const result = await moveSessionEntry(ctx, {
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
	let taskId = null;
	try {
		taskId = recordMoveManyTask(ctx, { targetWorkspaceId, results, moved })?.id ?? null;
	} catch (err) {
		ctx.logger?.warn?.(`workspace-mover: task record write failed: ${err?.message ?? err}`);
	}
	return { results, movedCount, attachedCount, failedCount: results.length - movedCount - attachedCount, historyId, taskId };
}

//#region 迁移任务中心（v1.2，记录式）
// 任务 = 已执行批量的持久化记录 + 逐项可重试状态。不是后台队列：
// 重试在 RPC 内同步执行，逐项隔离失败；来源位置在重试时实时解析
// （记录里的 sourceCwd 仅作展示），因此用户在批后手动搬动过会话也不会用错路径。
const TASKS_FILE = 'tasks.json';
const TASKS_LIMIT = 50;

function tasksPath() {
	return join(pluginDataDir(), TASKS_FILE);
}

function readTasks() {
	try {
		const value = JSON.parse(readFileSync(tasksPath(), 'utf8'));
		return Array.isArray(value?.tasks) ? value.tasks : [];
	} catch {
		return [];
	}
}

function writeTasks(tasks) {
	mkdirSync(dirname(tasksPath()), { recursive: true });
	atomicWrite(tasksPath(), Buffer.from(JSON.stringify({ version: 1, tasks: tasks.slice(0, TASKS_LIMIT) }, null, 2) + '\n', 'utf8'));
}

/** 批量迁移完成后落任务记录：done/failed 逐项带来源与目标路径、最后错误与最后尝试时间。 */
function recordMoveManyTask(ctx, { targetWorkspaceId, results, moved }) {
	const target = ctx.workspaceRegistry?.list?.().find((e) => e.id === targetWorkspaceId);
	const items = [];
	for (const r of results) {
		if (r.sessionId === null) continue;
		items.push({
			sessionId: String(r.sessionId),
			title: r.title ?? null,
			sourceCwd: moved.find((mv) => mv.sessionId === r.sessionId)?.fromCwd ?? null,
			targetCwd: target?.path ?? null,
			state: r.ok ? 'done' : 'failed',
			error: r.ok ? null : (r.error ?? 'unknown'),
			lastAttemptAt: new Date().toISOString()
		});
	}
	if (items.length === 0) return null;
	const tasks = readTasks();
	const task = {
		id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
		kind: 'moveMany',
		targetWorkspaceId,
		targetPath: target?.path ?? null,
		createdAt: new Date().toISOString(),
		items
	};
	tasks.unshift(task);
	writeTasks(tasks);
	return task;
}

async function listTasks() {
	const tasks = readTasks();
	return {
		items: tasks.map((t) => ({
			id: t.id,
			kind: t.kind,
			targetWorkspaceId: t.targetWorkspaceId,
			targetPath: t.targetPath,
			createdAt: t.createdAt,
			done: t.items.filter((i) => i.state === 'done').length,
			failed: t.items.filter((i) => i.state === 'failed').length,
			skipped: t.items.filter((i) => i.state === 'skipped').length,
			total: t.items.length,
			items: t.items
		}))
	};
}

/**
 * 仅重试未成功项：失败/跳过的逐项再迁移（同步、逐项隔离）。
 * 来源位置实时解析（moveSession 按 persistence 头定位），不用记录时的旧路径；
 * 报"already belongs to the target workspace"的按完成处理（幂等）；
 * 成功项补记批量历史，撤回能力与常规批量一致。
 */
async function retryTask(ctx, { taskId } = {}) {
	if (typeof taskId !== 'string' || taskId.length === 0) throw new Error('taskId required');
	const tasks = readTasks();
	const task = tasks.find((t) => t.id === taskId);
	if (!task) throw new Error(`task '${taskId}' not found`);
	if (task.kind !== 'moveMany') throw new Error(`task kind '${task.kind}' is not retryable`);
	const retryable = task.items.filter((it) => it.state !== 'done').slice(0, 50);
	const results = [];
	const movedNow = [];
	for (const item of retryable) {
		const attemptAt = new Date().toISOString();
		try {
			const result = await moveSessionEntry(ctx, { sessionId: item.sessionId, targetWorkspaceId: task.targetWorkspaceId, sessionTitle: item.title ?? undefined, recordHistory: false });
			item.state = 'done';
			item.error = null;
			item.lastError = null;
			item.lastAttemptAt = attemptAt;
			item.targetCwd = result.to?.cwd ?? item.targetCwd;
			movedNow.push({ sessionId: item.sessionId, title: item.title, fromCwd: result.from?.cwd ?? null, sourceWorkspaceId: null });
			results.push({ sessionId: item.sessionId, ok: true });
		} catch (err) {
			const msg = String(err?.message ?? err);
			item.lastAttemptAt = attemptAt;
			item.lastError = msg;
			if (/already belongs to the target workspace/.test(msg)) {
				item.state = 'done';
				item.error = null;
				results.push({ sessionId: item.sessionId, ok: true });
			} else {
				item.state = 'failed';
				item.error = msg;
				results.push({ sessionId: item.sessionId, ok: false, error: msg });
			}
		}
	}
	if (movedNow.length > 0) {
		try { rememberBatchMove(movedNow, task.targetWorkspaceId, task.targetPath); } catch (err) { ctx.logger?.warn?.(`workspace-mover: retry history write failed: ${err?.message ?? err}`); }
	}
	writeTasks(tasks);
	return {
		retried: retryable.length,
		fixedCount: results.filter((r) => r.ok).length,
		failedCount: results.filter((r) => !r.ok).length,
		results,
		items: task.items
	};
}

/** 清除任务记录（仅记录本身，不影响任何已迁移会话）。 */
async function forgetTask(ctx, { taskId, all } = {}) {
	const tasks = readTasks();
	const before = tasks.length;
	const kept = all ? [] : tasks.filter((t) => t.id !== taskId);
	writeTasks(kept);
	return { forgotten: before - kept.length };
}

/**
 * 数据保护：按时间清理回收站条目与备份（两项独立判定，互不影响）。
 * dryRun=true 只统计不删除，供确认框展示将释放的数量与空间。
 */
async function cleanupOldData(ctx, { days, dryRun = false } = {}) {
	// 注意：不能写 `{ days = 30 }`——解构默认值会把 undefined 变成 30，
	// 于是下面的策略回退永远看不到"未传值"，策略配置被默认值静默遮蔽。
	const keepDays = Math.min(3650, Math.max(1, days === undefined ? cleanupDays() : (Number(days) || cleanupDays()))); // 输入钳制：1–3650 天
	const cutoff = Date.now() - keepDays * 86400000;
	let freedBytes = 0;
	let recyclePurged = 0;
	let backupDeleted = 0;
	const rdir = recycleDir();
	if (dirExists(rdir)) {
		for (const entry of readdirSync(rdir)) {
			const entryDir = join(rdir, entry);
			if (!dirExists(entryDir)) continue;
			const manifest = readTrashEntry(entryDir);
			if (!manifest?.sessionId) continue;
			const ts = Number.isFinite(Date.parse(manifest.deletedAt ?? '')) ? Date.parse(manifest.deletedAt) : 0;
			if (ts >= cutoff) continue;
			const size = dirSizeSync(join(entryDir, 'session'));
			if (dryRun) { recyclePurged++; freedBytes += size; continue; }
			try { rmSync(entryDir, { recursive: true, force: true }); recyclePurged++; freedBytes += size; } catch { /* 单项失败不影响其余 */ }
		}
	}
	const bdir = backupDir();
	if (dirExists(bdir)) {
		for (const name of readdirSync(bdir)) {
			// 兼容同毫秒去重后缀：`${id}.${ts}.zstd` 与 `${id}.${ts}-${seq}.zstd`
			const m = /^(.+)\.(\d+)(?:-\d+)?\.zstd$/.exec(name);
			if (!m) continue;
			const ts = Number(m[2]);
			if (!(ts < cutoff)) continue;
			let size = 0;
			try { size = statSync(join(bdir, name)).size; } catch { continue; }
			if (dryRun) { backupDeleted++; freedBytes += size; continue; }
			try { rmSync(join(bdir, name), { force: true }); backupDeleted++; freedBytes += size; } catch { /* 单项失败不影响其余 */ }
		}
	}
	return { recyclePurged, backupDeleted, freedBytes, dryRun: Boolean(dryRun) };
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
	const headers = await listPersistenceHeaders(persistence);
	const meta = headers.find((h) => String(h.id) === String(sessionId));
	if (meta === undefined) throw new Error(`session '${sessionId}' not found in session persistence`);
	if (meta.cwd === undefined) throw new Error('session header carries no cwd');
	const home = registry.list().find((e) => { try { return samePath(e.path, meta.cwd); } catch { return false; } });
	if (!home) throw new Error(`no workspace accounts path '${meta.cwd}'`);
	for (const entity of registry.list()) {
		if (entity.id === home.id) continue;
		let listed = false;
		try { listed = rawRecordSessionIds(entity).includes(String(sessionId)); } catch { /* ignore */ }
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
	if (actions.length > batchLimit()) throw new Error(`too many actions in one batch (max ${batchLimit()})`);
	const results = [];
	for (const action of actions) {
		const sessionId = action?.sessionId;
		const label = String(sessionId ?? '?');
		try {
			if (action.kind === 'relink') {
				const result = await moveSessionEntry(ctx, { sessionId, targetWorkspaceId: action.targetWorkspaceId });
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
const REPOINT_MAX_SESSIONS = 200; // 默认值；实际生效上限见 repointLimit()

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
		try { memberCount = rawRecordSessionIds(entity).length; } catch { /* ignore */ }
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
	// 归档会话通常很旧，而扫描只解析按 mtime 排序的前 SCAN_MAX_ITEMS 条——
	// 大库上它们会整体从本列表消失。把"扫过多少 / 共多少"如实带出去，
	// 让 UI 能说明"这里不是全部"，而不是静默展示一个残缺清单。
	return {
		items,
		truncated: scan.truncated,
		scannedParsed: scan.scannedParsed ?? scan.items.length,
		scannedTotal: scan.scanned,
		archivedTotal: archivedIds.size
	};
}

/**
 * 取消归档。优先使用官方文档化的 `registry.unarchiveSession(sessionId)`——
 * 它的语义与本插件一致（归档从不摘记账槽，因此取消后自动回到原工作区原位置，
 * 且不需要会话存在性检查）。官方接口不可用时回退到等价的持久状态写通道
 * （enqueueOperation + setState，与官方 archiveSession 同款）。
 * 带 targetWorkspaceId 且 ≠ 归属时，接着走常规迁移（备份/历史/撤销/防运行中全套保护）。
 */
async function unarchiveSession(ctx, { sessionId, targetWorkspaceId } = {}) {
	if (typeof sessionId !== 'string' || sessionId.length === 0) throw new Error('sessionId required');
	const registry = ctx.workspaceRegistry;
	if (!registry) throw new Error('workspace registry unavailable');
	const archivedIds = readArchivedIds(registry);
	if (!archivedIds.includes(sessionId)) throw new Error(`session '${sessionId}' is not archived`);

	if (typeof registry.unarchiveSession === 'function') {
		// 官方通道：去掉归档集里的 id 即完成任务（记账槽原样保留）。
		await registry.unarchiveSession(sessionId);
	} else {
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
	}

	let moved = null;
	if (typeof targetWorkspaceId === 'string' && targetWorkspaceId.length > 0) {
		const owner = registry.list().find((e) => {
			try { return rawRecordSessionIds(e).includes(String(sessionId)); } catch { return false; }
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
/** 入口封装：工作区锁（try-acquire，占用即 busy）——与 moveSessionEntry 的目标工作区锁同键。 */
async function repointWorkspace(ctx, payload = {}) {
	const workspaceId = validId(payload?.workspaceId, 'workspaceId');
	const release = acquireLocks(`workspace:${workspaceId}`);
	try {
		return await repointWorkspaceLocked(ctx, payload);
	} finally {
		release();
	}
}

async function repointWorkspaceLocked(ctx, { workspaceId, fromPath, newPath, dryRun = false }) {
	const registry = ctx.workspaceRegistry;
	const persistence = ctx.sessionPersistence;
	if (!registry || !persistence) throw new Error('workspace registry or session persistence service unavailable');

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
	const headers = await listPersistenceHeaders(persistence);
	const byId = new Map();
	const addAffected = (id, title) => { if (id !== undefined && !byId.has(String(id))) byId.set(String(id), title); };
	for (const header of headers) {
		if (typeof header?.cwd !== 'string' || !samePath(header.cwd, stalePath)) continue;
		addAffected(header.id, typeof header.title === 'string' && header.title.trim() ? header.title.trim() : null);
	}
	try { for (const id of rawRecordSessionIds(entity)) addAffected(id, registry.headers?.get?.(id)?.title ?? null); } catch { /* 记账不可读时以磁盘扫描为准 */ }

	const affected = [...byId.entries()].map(([sessionId, title]) => ({ sessionId, title }));
	if (affected.length > repointLimit()) {
		throw new Error(`该工作区牵涉 ${affected.length} 个会话，超出单次上限 ${repointLimit()}；请分批处理`);
	}

	const root = persistence.root;
	const compression = persistenceCompression(persistence);
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
			await entity.mutate((record) => ({ ...record, path: targetCanon }));
			pathUpdated = true;
			// 标题跟随文件夹改名：仅当标题仍是旧文件夹名（官方 create 的默认值）时同步，
			// 用户自定义过的标题原样保留。走官方 entity.setTitle，与 mutate 解耦——
			// 标题同步失败不应影响已经完成的 path 重定向。
			try {
				const currentTitle = entity.title;
				if (typeof currentTitle === 'string' && currentTitle.length > 0
					&& currentTitle.toLowerCase() === basename(stalePath).toLowerCase()
					&& typeof entity.setTitle === 'function') {
					await entity.setTitle(basename(targetCanon));
				}
			} catch (err) {
				ctx.logger?.warn?.(`workspace-mover: title sync after repoint failed (path is already updated): ${err?.message ?? err}`);
			}
			// 剪枝保护网：mutate 若因索引预置失败清掉了某些成员，立即按官方
			// attach 语义补回（头部已被预置成新路径，校验必过），失败则记入 skipped。
			try {
				for (const { sessionId } of affected) {
					let accounted = false;
					try { accounted = rawRecordSessionIds(entity).includes(String(sessionId)); } catch { /* ignore */ }
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
			const srcArtifact = artifactPath(root, typeof meta?.cwd === 'string' ? meta.cwd : stalePath, sessionId, compression);
			if (!existsSync(srcArtifact)) throw new Error(`档案缺失：${srcArtifact}`);
			const dstArtifact = artifactPath(root, targetCanon, sessionId, compression);
			if (existsSync(dstArtifact)) throw new Error(`目标位置已有同名档案：${dstArtifact}`);

			const original = readFileSync(srcArtifact);
			stashBackup(String(sessionId), original);
			atomicWrite(srcArtifact, rewriteHeaderCwd(original, targetCanon, compression));
			try {
				moveDir(dirname(srcArtifact), dirname(dstArtifact));
				// 迁移后一致性校验（同 moveSession），失败视同搬移失败回退源字节
				try {
					verifyRelocatedArtifact(dstArtifact, sessionId, targetCanon, compression);
				} catch (verifyErr) {
					throw new Error(`物理搬移校验失败：${verifyErr?.message ?? verifyErr}`);
				}
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
				if (!rawRecordSessionIds(entity).includes(String(sessionId))) await entity.attachSession(sessionId);
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

const RECOVERY_FILE = 'recovery.json';

/** 回滚也失败时的兜底：写持久化恢复记录，供体检面板提示"需要人工恢复"。fail-soft。 */
function recordRecovery(ctx, entry) {
	try {
		const p = join(pluginDataDir(), RECOVERY_FILE);
		let list = [];
		try {
			const parsed = JSON.parse(readFileSync(p, 'utf8'));
			if (Array.isArray(parsed?.records)) list = parsed.records;
		} catch { /* 首次或损坏：重建 */ }
		list.unshift({ ...entry, id: `rec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, createdAt: new Date().toISOString() });
		atomicWrite(p, Buffer.from(JSON.stringify({ version: 1, records: list.slice(0, 50) }, null, 2) + '\n', 'utf8'));
		ctx.logger?.warn?.(`workspace-mover: RECOVERY RECORD written (${entry.kind}/${entry.phase}) for ${entry.sessionId ?? entry.workspaceId ?? '?'}`);
	} catch (err) {
		ctx.logger?.warn?.(`workspace-mover: recovery record write failed: ${err?.message ?? err}`);
	}
}

function recoveryCount() {
	try {
		const parsed = JSON.parse(readFileSync(join(pluginDataDir(), RECOVERY_FILE), 'utf8'));
		return Array.isArray(parsed?.records) ? parsed.records.length : 0;
	} catch {
		return 0;
	}
}

function recycleDir() {
	return join(pluginDataDir(), 'recycle');
}

const TRASH_MANIFEST = 'wsm-manifest.json';

function dirSizeSync(dir) {
	let total = 0;
	let names = [];
	try { names = readdirSync(dir); } catch { return 0; } // 目录缺失（如已还原的陈旧回收条目）按 0 计
	for (const f of names) {
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
	const compression = persistenceCompression(persistence);
	const candidates = [];
	try { const p = registry.sessionPaths?.get?.(sessionId); if (typeof p === 'string' && p) candidates.push(p); } catch { /* ignore */ }
	for (const e of registry.list()) {
		try { if (rawRecordSessionIds(e).includes(String(sessionId))) candidates.push(e.path); } catch { /* ignore */ }
	}
	try { const h = registry.headers?.get?.(sessionId); if (typeof h?.cwd === 'string') candidates.push(h.cwd); } catch { /* ignore */ }
	try {
		for (const meta of await listPersistenceHeaders(persistence)) {
			if (String(meta?.id) === String(sessionId) && typeof meta?.cwd === 'string') candidates.push(meta.cwd);
		}
	} catch { /* ignore */ }
	for (const cwd of candidates) {
		const artifact = artifactPath(root, cwd, sessionId, compression);
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
		// 注意：table 是底层 KvTable，put(key, value) 两参——value 必须是完整 {identity, rows}；
		// 服务层的 put(id, identity, rows) 三参签名在这里不可用（会整条写坏，域重开时崩）。
		await table.put(String(sessionId), { identity: { ...record.identity, cwd }, rows: record.rows });
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

/**
 * 注册表实体上是否存在某个官方文档化的方法（只读探测，永不抛错）。
 * 用于 mover.status 的能力位：官方接口缺失时插件会静默回退到等价实现，
 * 从外部看不出差异，因此必须显式可观测。
 */
function hasEntityApi(registry, method) {
	try {
		const first = registry?.list?.()?.[0];
		return typeof first?.[method] === 'function';
	} catch {
		return false;
	}
}

/** 非空字符串 id 校验（≤300 字符）。 */
function validId(value, name = 'id') {	if (typeof value !== 'string' || value.length === 0 || value.length > 300) {
		throw new Error(`${name} must be a non-empty string of at most 300 characters`);
	}
	return value;
}

/**
 * 读取工作区实体的**原始**记账名单（含幽灵 id）。
 *
 * 这是本插件唯一允许触碰的私有成员：官方公开的 `sessionIds` getter 会按
 * canonical-cwd 索引过滤掉"有账无档"的幽灵 id，而救援扫描正是要看见它们。
 * 官方 `Workspace` 接口没有等价的未过滤视图，因此这里集中收敛为一个访问器——
 * 未来宿主改变内部结构时只需改这一处，而不是散落全文件的 15 个 `try/catch`。
 * 读取失败返回空数组（与"无记账"同义，调用方按只读处理）。
 */
function rawRecordSessionIds(entity) {
	try {
		const ids = entity?.record?.sessionIds;
		return Array.isArray(ids) ? ids.map(String) : [...ids].map(String);
	} catch {
		return [];
	}
}

/** 扫描所有记账该会话的实体（只读，不改动）。 */
function listOwners(registry, sessionId) {
	return registry.list().filter((e) => rawRecordSessionIds(e).includes(String(sessionId)));
}

/** 从所有记账方摘除会话（moveSession 的 owners 扫描同款），返回被摘实体。 */
async function detachEverywhere(ctx, sessionId) {
	const owners = listOwners(ctx.workspaceRegistry, sessionId);
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
/**
 * 删除会话 → 回收站。顺序刻意"物理移动先行"：
 * ① 移动目录到回收站（失败 = 零副作用，记账/索引/投影/归档原样）；
 * ② manifest 落盘（失败 = 原样搬回，同样零副作用）；
 * ③ 记账/索引/归档/投影清理（此后任何单项失败只降级为 warn——文件已安全入站，
 *    最坏情况是可见的幽灵记账，可从回收站还原或用救援面板修复）。
 * moveImpl / writeManifestImpl 可注入（测试模拟移动与落盘失败）。
 */
/** 入口封装：会话锁（try-acquire，占用即 busy）。 */
async function deleteSessionToTrash(ctx, payload = {}, hooks = {}) {
	const sessionId = validId(payload?.sessionId, 'sessionId');
	const release = acquireLocks(`session:${sessionId}`);
	try {
		return await deleteSessionToTrashLocked(ctx, sessionId, { ...hooks, purgeBackups: payload?.purgeBackups === true });
	} finally {
		release();
	}
}

async function deleteSessionToTrashLocked(ctx, sessionId, hooks = {}) {
	const { moveImpl = moveDir, writeManifestImpl = (path, manifest) => writeFileSync(path, JSON.stringify(manifest, null, 2)), purgeBackups = false } = hooks;
	const registry = ctx.workspaceRegistry;
	const persistence = ctx.sessionPersistence;
	if (!registry || !persistence) throw new Error('workspace registry or session persistence service unavailable');
	if (peekService(ctx, 'sessions')?.get?.(sessionId) !== undefined) {
		throw new Error('session is resident in memory (it may remain resident even when not focused; archiving does not unload it); close it or restart the harness before deleting');
	}
	assertNotRunning(ctx, sessionId);
	const compression = persistenceCompression(persistence);
	const { artifact, cwd: artifactCwd } = await locateArtifact(ctx, sessionId);
	const header = readHeader(readFileSync(artifact), compression);
	const archived = readArchivedIds(registry).includes(sessionId);
	const projection = captureProjection(ctx, sessionId);
	const owners = listOwners(registry, sessionId);
	const entryDir = join(recycleDir(), `${Date.now()}-${String(sessionId).replace(/[^A-Za-z0-9._-]/g, '_')}`);
	mkdirSync(entryDir, { recursive: true });
	// ① 物理移动先行
	let how = 'rename';
	try {
		how = moveImpl(dirname(artifact), join(entryDir, 'session'));
	} catch (err) {
		try { rmSync(entryDir, { recursive: true, force: true }); } catch { /* ignore */ }
		throw new Error(`move to recycle failed (nothing was changed): ${err?.message ?? err}`);
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
	// ② manifest 落盘；失败原样搬回，回收站不留不可见条目
	try {
		writeManifestImpl(join(entryDir, TRASH_MANIFEST), manifest);
	} catch (err) {
		try { moveDir(join(entryDir, 'session'), dirname(artifact)); } catch (backErr) {
			recordRecovery(ctx, {
				kind: 'delete', phase: 'manifest-rollback', sessionId: String(sessionId),
				source: dirname(artifact), target: entryDir, backup: null,
				lastError: `manifest write failed (${err?.message ?? err}) AND move-back failed (${backErr?.message ?? backErr}) — files remain under ${entryDir}`
			});
			ctx.logger?.warn?.(`workspace-mover: manifest write failed AND move-back failed for ${sessionId}: ${backErr?.message ?? backErr} — files remain under ${entryDir}`);
		}
		try { rmSync(entryDir, { recursive: true, force: true }); } catch { /* ignore */ }
		throw new Error(`manifest write failed, session moved back: ${err?.message ?? err}`);
	}
	// ③ 四件套清理（文件已安全入站；单项失败降级为 warn）
	await detachEverywhere(ctx, sessionId);
	forgetSessionIndexes(registry, sessionId);
	if (archived) await modifyArchiveSet(ctx, sessionId, false);
	await dropProjection(ctx, String(sessionId));
	// 可选：连同该会话的迁移备份一起清掉（默认保留——回收站还原后仍可能要用）。
	let backupsDeleted = 0;
	if (purgeBackups) backupsDeleted = (await deleteBackup(ctx, { sessionId: String(sessionId) })).deleted;
	return { deleted: true, sessionId: String(sessionId), title: manifest.title, how, backupsDeleted };
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
/** 入口封装：会话锁（try-acquire，占用即 busy）。 */
async function restoreFromTrash(ctx, payload = {}) {
	const sessionId = validId(payload?.sessionId, 'sessionId');
	const release = acquireLocks(`session:${sessionId}`);
	try {
		return await restoreFromTrashLocked(ctx, sessionId, payload?.targetWorkspaceId);
	} finally {
		release();
	}
}

async function restoreFromTrashLocked(ctx, sessionId, targetWorkspaceId) {
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
	const compression = persistenceCompression(persistence);
	const sessionDir = join(entryDir, 'session');
	const foundInTrash = findHighestArtifact(sessionDir, compression);
	if (!foundInTrash) throw new Error(`trash entry has no session artifact: ${entryDir}`);
	const artifactInTrash = foundInTrash.path;
	if (!existsSync(artifactInTrash)) throw new Error(`trashed archive missing for '${sessionId}'`);
	if (peekService(ctx, 'sessions')?.get?.(sessionId) !== undefined) {
		throw new Error('a live session with this id already exists; restart the harness before restoring');
	}
	let existingPath = null;
	try { existingPath = registry.sessionPaths?.get?.(sessionId); } catch { /* ignore */ }
	if (existingPath) throw new Error('session id already exists in the workspace registry');
	const header = readHeader(readFileSync(artifactInTrash), compression);
	const originalCwd = typeof header?.cwd === 'string' ? header.cwd : manifest.cwd;
	if (typeof originalCwd !== 'string' || originalCwd.length === 0) throw new Error('trashed manifest carries no original path');
	const originalArtifact = artifactPath(persistence.root, originalCwd, sessionId, compression);
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
async function purgeTrash(ctx, { sessionId, all, purgeBackups = false } = {}) {
	const dir = recycleDir();
	if (!dirExists(dir)) return { purged: 0, backupsDeleted: 0 };
	let purged = 0;
	let backupsDeleted = 0;
	for (const entry of readdirSync(dir)) {
		const entryDir = join(dir, entry);
		if (!dirExists(entryDir)) continue;
		const manifest = readTrashEntry(entryDir);
		if (all || (typeof sessionId === 'string' && manifest?.sessionId === String(sessionId))) {
			rmSync(entryDir, { recursive: true, force: true });
			purged++;
			// 彻底删除（不可还原）时才顺带清备份：留在回收站里的会话仍可能靠备份兜底。
			if (purgeBackups && manifest?.sessionId) {
				try { backupsDeleted += (await deleteBackup(ctx, { sessionId: String(manifest.sessionId) })).deleted; }
				catch { /* 备份清理失败不影响回收站条目已删除的事实 */ }
			}
		}
	}
	return { purged, backupsDeleted };
}

/**
 * 备份聚合清单：按会话分组（文件名 `${id}.${ts}.zstd`），附投影标题与总占用。
 *
 * 额外标注孤儿组：会话已被彻底删除（或档案已不存在）时，它历次迁移留下的备份
 * 不会再被任何操作引用——`stashBackup` 的 20 份裁剪只在"再次备份同一会话"时触发，
 * 所以这些字节会永久留在磁盘上。标出来用户才可能清掉。
 */
async function listBackups(ctx) {
	const dir = backupDir();
	if (!dirExists(dir)) return { items: [], totalBytes: 0, dir, orphanBytes: 0, orphanGroups: 0 };
	const titles = readProjectionTitles();
	const groups = new Map();
	for (const name of readdirSync(dir)) {
		// 兼容同毫秒去重后缀：`${id}.${ts}.zstd` 与 `${id}.${ts}-${seq}.zstd`
		const m = /^(.+)\.(\d+)(?:-\d+)?\.zstd$/.exec(name);
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

	// 存活集合：注册表原始记账 ∪ 持久化档案头。任一命中都视为"会话仍在"。
	const alive = new Set();
	try {
		for (const entity of ctx.workspaceRegistry?.list?.() ?? []) {
			for (const id of rawRecordSessionIds(entity)) alive.add(String(id));
		}
	} catch { /* 注册表不可用：只靠档案头判断 */ }
	try {
		for (const header of await listPersistenceHeaders(ctx.sessionPersistence)) {
			if (header?.id !== undefined) alive.add(String(header.id));
		}
	} catch { /* 持久化不可用：只靠记账判断 */ }

	const items = [...groups.values()].map((g) => ({
		...g,
		orphan: !alive.has(String(g.sessionId)),
		files: g.files.sort((x, y) => y.ts - x.ts).map(({ name, ts, sizeBytes }) => ({ name, ts, sizeBytes }))
	}));
	items.sort((a, b) => b.newest - a.newest);
	const orphanItems = items.filter((it) => it.orphan);
	return {
		items,
		totalBytes: items.reduce((sum, it) => sum + it.totalBytes, 0),
		orphanGroups: orphanItems.length,
		orphanBytes: orphanItems.reduce((sum, it) => sum + it.totalBytes, 0),
		dir
	};
}

/** 从备份恢复会话：默认回备份里的原 cwd；占用/缺分组时给 targetWorkspaceId。回读校验。 */
/** 入口封装：会话锁（try-acquire，占用即 busy）。 */
async function restoreBackup(ctx, payload = {}) {
	const sessionId = validId(payload?.sessionId, 'sessionId');
	const release = acquireLocks(`session:${sessionId}`);
	try {
		return await restoreBackupLocked(ctx, sessionId, payload?.fileName, payload?.targetWorkspaceId);
	} finally {
		release();
	}
}

async function restoreBackupLocked(ctx, sessionId, fileName, targetWorkspaceId) {
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
	const compression = persistenceCompression(persistence);
	const bytes = readFileSync(path2);
	const header = readHeader(bytes, compression);
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
	const dstDir = sessionDir(persistence.root, destCwd, sessionId);
	if (findDestinationArtifact(dstDir, compression)) throw new Error(`destination artifact already exists under: ${dstDir}`);
	const dstArtifact = join(dstDir, preferredArtifactName(compression));
	const final = samePath(backupCwd, destCwd) ? bytes : rewriteHeaderCwd(bytes, destCwd, compression);
	let created = false;
	try {
		mkdirSync(dstDir, { recursive: true });
		atomicWrite(dstArtifact, final);
		created = existsSync(dstArtifact);
		// 回读校验：id 与 cwd 双确认后才挂账
		const verify = readHeader(readFileSync(dstArtifact), compression);
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

/**
 * 一键修复：扫描 → 分类 → 逐项修复可自动修复项。
 * 挂错 → 归位；未记账且有路径匹配分组 → 补账；孤儿/损坏/无匹配分组的未记账 → 跳过并说明原因。
 * 全部只动记账（home/attach 不搬文件），复用 repairSessions 的逐项隔离。
 */
async function repairAllSessions(ctx) {
	const scan = await scanSessions(ctx);
	const actions = [];
	const skipped = [];
	for (const it of scan.items) {
		if (it.status === 'misfiled') {
			actions.push({ sessionId: it.sessionId, kind: 'home' });
		} else if (it.status === 'unregistered' && it.targetWorkspaceId) {
			actions.push({ sessionId: it.sessionId, kind: 'attach' });
		} else if (it.status === 'unregistered' || it.status === 'orphaned') {
			skipped.push({ sessionId: it.sessionId, title: it.title, status: it.status, reason: 'needs-target-workspace' });
		} else if (it.status === 'unreadable') {
			skipped.push({ sessionId: it.sessionId, title: it.title, status: it.status, reason: 'unreadable' });
		}
		// ok：无需处理
	}
	const { results } = actions.length > 0 ? await repairSessions(ctx, actions) : { results: [] };
	const fixed = results.filter((r) => r.ok);
	const failed = results.filter((r) => !r.ok).map((r) => ({ sessionId: r.sessionId ?? null, error: r.error ?? 'unknown' }));
	return {
		fixedCount: fixed.length,
		failedCount: failed.length,
		skippedCount: skipped.length,
		fixed,
		failed,
		skipped,
		counts: scan.counts
	};
}

//#region agent tools（v2.1）：把救援/迁移能力暴露给模型
// 注册的是裸 ToolDefinition 对象（零依赖）：dsh-tools 的 register 只要求
// { name, description, parameters(JSON Schema), output:{schema, render}, execute }；
// defineTool 只是参数校验语法糖，execute 内自行做轻校验即可。
// 变更类工具统一走 ctx.approval.request（dsh-user-approval，dsh-base 默认挂载）
// 弹用户确认——与面板 confirm 同级的人审；接缝缺失时降级为模型对话纪律。

/** 通过审批接缝请求用户确认；未获准（denied/cancelled/unavailable）一律抛错拒绝。 */
async function approveOrThrow(ctx, exec, toolName, reason) {
	const approval = ctx?.approval;
	if (!exec?.agent || typeof approval?.request !== 'function') return; // 无审批接缝（如无 UI 宿主）：由模型对话纪律兜底
	let outcome;
	try {
		outcome = await approval.request({ agent: exec.agent, toolName, reason, signal: exec.signal });
	} catch (err) {
		// request 在回合外等异常情况会抛错：按未批准处理，不静默放行
		throw new Error(`${toolName} approval could not be requested (${err?.message ?? err}); use the rescue panel in settings instead`);
	}
	if (outcome !== 'allowed-once') {
		throw new Error(`user did not approve this ${toolName} call (outcome: ${outcome ?? 'unavailable'}); ask the user first and only retry after they agree, or use the rescue panel in settings`);
	}
}

/** 统一把 dispatch 的 {ok:false,error} 信封转成模型可见的异常（错误码随行）。 */
async function callDispatch(dispatchRef, endpoint, payload, signal) {
	if (typeof dispatchRef?.fn !== 'function') throw new Error('workspace-mover RPC is not mounted on this host; the rescue panel is unavailable too');
	const res = await dispatchRef.fn(endpoint, payload ?? {}, signal);
	if (!res?.ok) {
		const err = new Error(`[${res?.error?.code ?? 'internal-error'}] ${res?.error?.message ?? 'request failed'}`);
		err.code = res?.error?.code;
		throw err;
	}
	return res.value;
}

const JSON_TEXT = (args, value) => [{ type: 'text', text: JSON.stringify(value) }];
const LIST_MAX_SESSIONS = 40;

/**
 * 构造四个 agent 工具（复用 RPC dispatch：锁、错误码、事务语义与面板完全一致）：
 * - mover_list_sessions   只读：会话/分组清单，供模型把用户口中的名字解析成精确 id
 * - mover_move_session    迁移单个会话（审批门）
 * - mover_repair_sessions 一键修复（审批门，只动记账不动文件）
 * - mover_doctor          只读自检（无审批门）
 */
function createAgentTools(ctx, dispatchRef) {
	const SIGNAL_NOTE = 'Cancellation is cooperative: the in-flight step finishes rolling back to a consistent state before stopping.';
	const tools = [
		{
			name: 'mover_list_sessions',
			description: 'List DSH workspace groups and their sessions for the workspace-mover plugin. Read-only. Returns workspace ids/titles/paths, per-session id/title/path/rescue status (ok / orphaned / unregistered / misfiled / unreadable), aggregate counts, and how many records need manual recovery. Use it to resolve a user-named group or conversation into the exact ids required by mover_move_session and mover_repair_sessions.',
			parameters: { type: 'object', properties: {}, additionalProperties: false },
			output: { schema: { type: 'object' }, render: JSON_TEXT },
			isConcurrencySafe: () => true,
			timeoutMs: 30000,
			async execute(args, exec) {
				const scan = await callDispatch(dispatchRef, 'mover.scan', {}, exec?.signal);
				const ws = await callDispatch(dispatchRef, 'mover.workspaces', {}, exec?.signal);
				const sessions = (scan.items ?? []).slice(0, LIST_MAX_SESSIONS).map((it) => ({
					sessionId: it.sessionId,
					title: it.title,
					cwd: it.cwd,
					status: it.status,
					ownerWorkspaceIds: it.ownerWorkspaceIds ?? []
				}));
				return {
					workspaces: (ws.items ?? []).map((w) => ({
						workspaceId: w.workspaceId,
						title: w.title,
						path: w.path,
						sessionCount: Array.isArray(w.sessionIds) ? w.sessionIds.length : undefined
					})),
					sessions,
					counts: scan.counts ?? {},
					scanned: scan.scanned,
					truncated: Boolean(scan.truncated) || (scan.items?.length ?? 0) > LIST_MAX_SESSIONS,
					recoveryCount: scan.recoveryCount ?? 0,
					ghosts: (scan.ghosts ?? []).slice(0, 20)
				};
			}
		},
		{
			name: 'mover_move_session',
			description: `Move one DSH session into another workspace group with full protection: byte-level backup is taken before anything changes, then the session header is rewritten, the archive directory is moved atomically, the result is verified by re-reading, and any failure rolls everything back automatically. The session keeps its id and full history; a post-move record enables one-click undo. ${SIGNAL_NOTE} Ask the user to confirm the target group before calling, then pass the exact ids from mover_list_sessions.`,
			parameters: {
				type: 'object',
				properties: {
					sessionId: { type: 'string', description: 'Exact session id from mover_list_sessions' },
					targetWorkspaceId: { type: 'string', description: 'Exact workspace id of the destination group from mover_list_sessions' },
					sessionTitle: { type: 'string', description: 'Optional display title used in move history; omit to use the session\'s own title' }
				},
				required: ['sessionId', 'targetWorkspaceId'],
				additionalProperties: false
			},
			output: { schema: { type: 'object' }, render: JSON_TEXT },
			timeoutMs: 120000,
			async execute(args, exec) {
				const sessionId = validId(args?.sessionId, 'sessionId');
				const targetWorkspaceId = validId(args?.targetWorkspaceId, 'targetWorkspaceId');
				await approveOrThrow(ctx, exec, 'mover_move_session', `Move session "${sessionId}" into workspace group "${targetWorkspaceId}" (files are moved on disk with automatic backup and rollback).`);
				return await callDispatch(dispatchRef, 'mover.move', { sessionId, targetWorkspaceId, sessionTitle: typeof args?.sessionTitle === 'string' ? args.sessionTitle : undefined }, exec?.signal);
			}
		},
		{
			name: 'mover_repair_sessions',
			description: `Run one workspace-mover repair pass across all detected session issues: misfiled sessions are re-homed to the group matching their folder, unregistered sessions with a matching group get accounted. Accounting-only — no session files are moved. Anything needing a human decision (orphaned, damaged archives, no matching group) is skipped with a stated reason, and results report fixed / skipped / failed. ${SIGNAL_NOTE} Ask the user to confirm before calling.`,
			parameters: { type: 'object', properties: {}, additionalProperties: false },
			output: { schema: { type: 'object' }, render: JSON_TEXT },
			timeoutMs: 120000,
			async execute(args, exec) {
				await approveOrThrow(ctx, exec, 'mover_repair_sessions', 'Run a workspace-mover repair pass (accounting-only fixes for misfiled / unregistered sessions; no files are moved).');
				return await callDispatch(dispatchRef, 'mover.repairAll', {}, exec?.signal);
			}
		},
		{
			name: 'mover_doctor',
			description: `Run the workspace-mover self-check (read-only diagnostics): host services (registry / persistence / projection cache / archive channel / agents / approval seam), agent-tool registration, data directories (recycle bin, backups, move history, tasks), pending manual-recovery records, and workspace folder presence. Returns per-check pass / warn / fail states with details and a summary — use it after a DSH upgrade or when a feature misbehaves, to see what is degraded before attempting anything else. No user approval needed; nothing is modified.`,
			parameters: { type: 'object', properties: {}, additionalProperties: false },
			output: { schema: { type: 'object' }, render: JSON_TEXT },
			isConcurrencySafe: () => true,
			timeoutMs: 30000,
			async execute(args, exec) {
				return await callDispatch(dispatchRef, 'mover.doctor', {}, exec?.signal);
			}
		}
	];
	return tools;
}

/** 宿主带 dsh-tools 时注册；逐工具隔离失败（一个失败不影响其余），缺服务时静默跳过。 */
function registerAgentTools(ctx, dispatchRef, logger, agentToolsState = { registered: false }) {
	if (typeof ctx?.tools?.register !== 'function') return;
	for (const tool of createAgentTools(ctx, dispatchRef)) {
		try {
			ctx.tools.register(tool);
			agentToolsState.registered = true;
		} catch (err) {
			logger?.warn?.(`workspace-mover: agent tool '${tool?.name}' registration failed: ${err?.message ?? err}`);
		}
	}
}
//#endregion

//#region doctor（v2.2）：只读自检——服务、数据目录、恢复记录、工作区路径
// 纯 ok(value)，无锁无变更；刻意不跑全量 scan，保证秒级返回。
async function runDoctor(ctx, agentToolsState) {
	const checks = [];
	const add = (id, state, detail = '') => checks.push({ id, state, detail });
	const pass = (id, detail) => add(id, 'pass', detail);
	const warn = (id, detail) => add(id, 'warn', detail);
	const fail = (id, detail) => add(id, 'fail', detail);

	const registry = ctx?.workspaceRegistry;
	const persistence = ctx?.sessionPersistence;

	if (!registry) fail('host-registry', 'workspace registry service unavailable');
	else {
		let count = 0;
		try { count = registry.list().length; } catch { /* list 失败按 0 报告 */ }
		pass('host-registry', `${count} workspaces`);
	}

	if (!persistence) fail('host-persistence', 'session persistence service unavailable');
	else if (typeof persistence.root === 'string' && dirExists(persistence.root)) pass('host-persistence', String(persistence.root));
	else fail('host-persistence', `sessions root missing: ${persistence.root ?? '(none)'}`);

	const projection = projectionTable(ctx);
	const projectionRead = typeof projection?.get === 'function';
	const projectionWrite = projectionRead && typeof projection?.put === 'function' && typeof projection?.delete === 'function';
	if (projectionWrite) pass('host-projection', 'read + write');
	else if (projectionRead) warn('host-projection', 'read-only — projection title restore degraded');
	else warn('host-projection', 'absent — projection title restore degraded');

	if (typeof registry?.enqueueOperation === 'function') pass('host-archive', 'archive-set channel ready');
	else warn('host-archive', 'archive-set changes degraded');

	if (peekService(ctx, 'agents')) pass('host-agents', 'running-state checks active');
	else warn('host-agents', 'running-state checks degraded');

	if (typeof ctx?.approval?.request === 'function') pass('host-approval', 'approval seam ready');
	else warn('host-approval', 'agent approval seam absent — conversational moves rely on model discipline');

	if (agentToolsState?.registered) pass('agent-tools', 'registered with dsh-tools');
	else warn('agent-tools', 'not registered — dsh-tools absent on this host');

	try { const trash = await listTrash(ctx); pass('data-recycle', `${trash.items.length} entries`); }
	catch (err) { fail('data-recycle', String(err?.message ?? err).slice(0, 140)); }

	try {
		const backups = await listBackups(ctx);
		const orphanNote = backups.orphanGroups > 0 ? `, ${backups.orphanGroups} orphan group(s) (${backups.orphanBytes} bytes)` : '';
		pass('data-backups', `${backups.items.length} session groups${orphanNote}`);
	}
	catch (err) { fail('data-backups', String(err?.message ?? err).slice(0, 140)); }

	try { const history = await listHistory(); pass('data-history', `${history.items?.length ?? 0} records`); }
	catch (err) { fail('data-history', String(err?.message ?? err).slice(0, 140)); }

	try { const tasks = await listTasks(); pass('data-tasks', `${tasks.items?.length ?? 0} records`); }
	catch (err) { fail('data-tasks', String(err?.message ?? err).slice(0, 140)); }

	const recovered = recoveryCount();
	if (recovered === 0) pass('recovery', 'no manual-recovery records');
	else warn('recovery', `${recovered} record(s) need manual review — see the rescue panel`);

	// 存储布局自证：把"所有会话突然都找不到"提前变成一条可见的降级提示。
	try {
		const layout = await verifyStorageLayout(ctx);
		if (layout.status === 'ok') pass('data-layout', `derived directory verified (${layout.checked} sample(s))`);
		else if (layout.status === 'empty') warn('data-layout', 'no stored sessions to verify against (fresh install?)');
		else if (layout.status === 'unavailable') warn('data-layout', layout.reason ?? 'storage layout cannot be verified');
		else warn('data-layout', `storage layout may have changed — ${layout.reason ?? 'no archive found at the derived path'}`);
	} catch (err) {
		warn('data-layout', String(err?.message ?? err).slice(0, 140));
	}

	if (!registry) warn('workspaces', 'skipped — registry unavailable');
	else {
		let total = 0;
		let missing = [];
		try {
			for (const entity of registry.list()) {
				total++;
				try { if (!dirExists(entity.path)) missing.push(String(entity.id)); }
				catch { missing.push(String(entity.id)); }
			}
		} catch { /* 同上 */ }
		if (total === 0) warn('workspaces', 'no registered workspaces');
		else if (missing.length === 0) pass('workspaces', `${total} paths all present`);
		else warn('workspaces', `${missing.length}/${total} folders missing: ${missing.slice(0, 5).join(', ')}`);
	}

	const summary = { pass: 0, warn: 0, fail: 0 };
	for (const c of checks) summary[c.state]++;
	return { checks, summary, generatedAt: new Date().toISOString() };
}
//#endregion

export function apply(ctx) {
	const logger = ctx.logger ?? console;
	const dispatchRef = { fn: null }; // agent 工具在调用期才用到 dispatch，挂载时序无关
	const agentToolsState = { registered: false };
	const mount = (owner) => {
		const connection = owner?.connection;
		if (!connection?.rpc?.handle) return;
		// DSH 0.1.5's rpc getter keeps the Connection service context; rebind it
		// to this injected web context so rpc.handle() can register on webServer.
		const rawConnection = connection[Symbol.for('cordis.original')] ?? connection;
		const scopedConnection = rawConnection?.[Symbol.for('cordis.extend')]?.({ ctx: owner }) ?? connection;
		const dispatch = async (endpoint, payload = {}, signal) => {
		if (signal?.aborted) return { ok: false, error: { code: 'cancelled', message: 'cancelled', details: {} } };
		try {
			switch (endpoint) {
				case 'mover.status': {
					const projection = projectionTable(ctx);
					const layout = await verifyStorageLayout(ctx);
					const capabilities = {
						registry: Boolean(ctx.workspaceRegistry),
						persistence: Boolean(ctx.sessionPersistence),
						projectionRead: typeof projection?.get === 'function',
						projectionWrite: typeof projection?.put === 'function' && typeof projection?.delete === 'function',
						archiveChannel: typeof ctx.workspaceRegistry?.enqueueOperation === 'function',
						// v2.2 起优先使用的官方文档化接口。是否走官方通道必须**可观测**：
						// 缺失时会静默回退到等价实现（功能不变），但从外部看不出差异。
						unarchiveApi: typeof ctx.workspaceRegistry?.unarchiveSession === 'function',
						setTitleApi: hasEntityApi(ctx.workspaceRegistry, 'setTitle'),
						coordinatorStates: Boolean(peekService(ctx, 'sessionPersistence')?.coordinator?.states),
						fileReferences: Boolean(peekService(ctx, 'fileReferences')),
						agents: Boolean(peekService(ctx, 'agents')),
						storageLayout: layout.status
					};
					const degradedFeatures = [];
					if (!capabilities.projectionWrite) degradedFeatures.push('projection-title-restore');
					if (!capabilities.archiveChannel) degradedFeatures.push('archive-set-changes');
					if (!capabilities.unarchiveApi) degradedFeatures.push('unarchive-official-api');
					if (!capabilities.setTitleApi) degradedFeatures.push('set-title-official-api');
					if (!capabilities.coordinatorStates) degradedFeatures.push('resident-hotfix');
					if (!capabilities.fileReferences) degradedFeatures.push('file-reference-cleanup');
					if (layout.status === 'degraded') degradedFeatures.push('storage-layout');
					return ok({
						ready: Boolean(capabilities.registry && capabilities.persistence),
						channel: CHANNEL,
						capabilities,
						degradedFeatures,
						storageLayout: layout,
						agentTools: agentToolsState.registered,
						recoveryCount: recoveryCount()
					});
				}
				case 'mover.doctor':
					return ok(await runDoctor(ctx, agentToolsState));
				case 'mover.workspaces':
					return ok(await listWorkspaces(ctx));
				case 'mover.history':
					return ok(await listHistory());
				case 'mover.undo':
					try {
						return ok(await undoMove(ctx, payload?.historyId));
					} catch (err) {
						return mapError(err);
					}
				case 'mover.scan':
					return ok(await scanSessions(ctx));
				case 'mover.repair': {
					try {
						return ok(await repairSessions(ctx, payload?.actions));
					} catch (err) {
						return mapError(err);
					}
				}
				case 'mover.move': {
					try {
						const sessionId = payload?.sessionId;
						const targetWorkspaceId = payload?.targetWorkspaceId;
						if (typeof sessionId !== 'string' || sessionId.length === 0) throw new Error('sessionId required');
						if (typeof targetWorkspaceId !== 'string' || targetWorkspaceId.length === 0) throw new Error('targetWorkspaceId required');
						const result = await moveSessionEntry(ctx, { sessionId, targetWorkspaceId, sessionTitle: payload?.sessionTitle });
						logger.info?.(`workspace-mover: moved ${sessionId} -> ${result.to.cwd}`);
						return ok(result);
					} catch (err) {
						logger.warn?.(`workspace-mover: MOVE FAILED sessionId=${payload?.sessionId} target=${payload?.targetWorkspaceId}: ${err?.message ?? err}`);
						return mapError(err);
					}
				}
				case 'mover.moveMany': {
					try {
						return ok(await moveManySessions(ctx, payload ?? {}));
					} catch (err) {
						logger.warn?.(`workspace-mover: MOVE MANY FAILED target=${payload?.targetWorkspaceId}: ${err?.message ?? err}`);
						return mapError(err);
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
						return mapError(err);
					}
				}
				case 'mover.openFolder': {
					try {
						return ok(await openWorkspaceFolder(ctx, payload ?? {}));
					} catch (err) {
						logger.warn?.(`workspace-mover: OPEN FOLDER FAILED ${payload?.workspaceId ?? payload?.path}: ${err?.message ?? err}`);
						return mapError(err);
					}
				}
				case 'mover.session.delete': {
					try {
						return ok(await deleteSessionToTrash(ctx, payload ?? {}));
					} catch (err) {
						logger.warn?.(`workspace-mover: DELETE FAILED session=${payload?.sessionId}: ${err?.message ?? err}`);
						return mapError(err);
					}
				}
				case 'mover.trash.list':
					return ok(await listTrash(ctx));
				case 'mover.trash.restore': {
					try {
						return ok(await restoreFromTrash(ctx, payload ?? {}));
					} catch (err) {
						logger.warn?.(`workspace-mover: TRASH RESTORE FAILED session=${payload?.sessionId}: ${err?.message ?? err}`);
						return mapError(err);
					}
				}
				case 'mover.trash.purge': {
					try {
						return ok(await purgeTrash(ctx, payload ?? {}));
					} catch (err) {
						return mapError(err);
					}
				}
				case 'mover.backups.list':
					return ok(await listBackups(ctx));
				case 'mover.backups.restore': {
					try {
						return ok(await restoreBackup(ctx, payload ?? {}));
					} catch (err) {
						logger.warn?.(`workspace-mover: BACKUP RESTORE FAILED session=${payload?.sessionId}: ${err?.message ?? err}`);
						return mapError(err);
					}
				}
				case 'mover.backups.deleteOne': {
					try {
						return ok(await deleteBackup(ctx, payload ?? {}));
					} catch (err) {
						return mapError(err);
					}
				}
				case 'mover.repairAll': {
					try {
						return ok(await repairAllSessions(ctx));
					} catch (err) {
						logger.warn?.(`workspace-mover: REPAIR ALL FAILED: ${err?.message ?? err}`);
						return mapError(err);
					}
				}
				case 'mover.tasks.list':
					return ok(await listTasks());
				case 'mover.tasks.retry': {
					try {
						return ok(await retryTask(ctx, payload ?? {}));
					} catch (err) {
						logger.warn?.(`workspace-mover: TASK RETRY FAILED ${payload?.taskId}: ${err?.message ?? err}`);
						return mapError(err);
					}
				}
				case 'mover.tasks.forget': {
					try {
						return ok(await forgetTask(ctx, payload ?? {}));
					} catch (err) {
						return mapError(err);
					}
				}
				case 'mover.data.cleanup': {
					try {
						return ok(await cleanupOldData(ctx, payload ?? {}));
					} catch (err) {
						return mapError(err);
					}
				}
				case 'mover.repoint': {
					try {
						return ok(await repointWorkspace(ctx, payload ?? {}));
					} catch (err) {
						logger.warn?.(`workspace-mover: REPOINT FAILED ws=${payload?.workspaceId}: ${err?.message ?? err}`);
						return mapError(err);
					}
				}
				default:
					return failBadRequest(`unknown endpoint '${endpoint}'`);
			}
		} catch (err) {
			return mapError(err);
		}
		};
		dispatchRef.fn = dispatch;
		const dispose = scopedConnection.rpc.handle(CHANNEL, dispatch, { authority: 'loopback' });
		owner.effect?.(() => () => { try { dispose?.(); } catch { /* ignore */ } }, 'workspace-mover: rpc dispose');
	};

	if (typeof ctx.inject === 'function') {
		ctx.inject(['connection', 'webServer'], (webCtx) => mount(webCtx));
	} else {
		mount(ctx);
	}

	registerAgentTools(ctx, dispatchRef, logger, agentToolsState);

	// 官方 Config：**暂不注册**，只导出构造能力。
	//
	// 官方 schema 来自 @deepseek-ai/schemastery，由宿主 loader 提供；本插件目录下
	// 实测无法解析该模块（npm 上的 schemastery 也没有 .volatile）。而静态 import
	// 一个不可解析的模块会打断 **boot**（官方记录的 bundle 层事故类别）。
	//
	// 因此这里刻意不向任何未文档化的服务名做 inject——那只会让 fiber 处于半装载
	// 状态。setup 已经就绪：宿主一旦提供文档化的 schema 接缝，把构造器交给
	// lib/config.js 的 buildConfig() 即可（已单测覆盖）。在此之前，全部策略都由
	// 环境变量（见 resolvePolicy）与代码默认值驱动，功能完整。
}

export { name, inject, CHANNEL, projectKey, encodeSegment, sessionDir, artifactPath, generationLogFilename, parseGenerationLogFilename, listGenerationArtifacts, findHighestArtifact, preferredArtifactName, moveDir, stashBackup, verifyRelocatedArtifact, deleteSessionToTrash, moveSession, moveSessionEntry, validId, SCAN_MAX_ITEMS, POLICY_DEFAULTS, resolvePolicy, verifyStorageLayout, rawRecordSessionIds, historyLimit, backupKeep, batchLimit, repointLimit, scanLimit, cleanupDays, Config, POLICY_FIELDS, buildConfig, attachConfig };
