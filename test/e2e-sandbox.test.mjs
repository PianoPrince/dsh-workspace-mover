// 端到端沙箱测试：假注册表 + 假持久化 + 真实文件系统，完整走 mover.move 流程。
// 覆盖：status / 正常迁移 / 同工作区拒绝 / 未知目标 / attach 失败自动回滚。
// 备份目录通过 DSH_HOME 重定向到临时区，不污染真实环境。
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, renameSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { zstdCompressSync, constants } from 'node:zlib';

import { apply, scanFrames, readHeader, artifactPath, openInFileManager } from '../lib/index.js';

const OPTS = { params: { [constants.ZSTD_c_checksumFlag]: 1 } };
const DEAD = 'E:\\wsm-dead-path'; // 刻意不存在的路径（孤儿分类用）
let A; // 每次用例指向真实临时目录（健康会话要求 cwd 在磁盘上存在）
let B;
let root;
let ctx, entityA, entityB, sharedIndex;

/** 测试根目录：优先 WSM_TEST_ROOT（受限环境下 Temp 可能禁止目录重命名），否则退回系统 Temp。 */
function makeRoot() {
  const candidates = [
    process.env.WSM_TEST_ROOT ? join(process.env.WSM_TEST_ROOT, 'wsm-e2e-') : null,
    join(tmpdir(), 'wsm-e2e-')
  ].filter(Boolean);
  let lastErr;
  for (const base of candidates) {
    try { return mkdtempSync(base); } catch (err) { lastErr = err; }
  }
  throw lastErr;
}

function makeArtifact(header) {
  const head = zstdCompressSync(Buffer.from(JSON.stringify(header) + '\n', 'utf8'), OPTS);
  const ev = zstdCompressSync(Buffer.from(JSON.stringify({ seq: 1 }) + '\n', 'utf8'), OPTS);
  return Buffer.concat([head, ev]);
}

/**
 * 模拟 dsh 工作区实体：record 快照 + 记账，attach 对已记账 id 跳过校验（官方语义）。
 * mutate 复刻官方统一写入通道的两个关键行为：调用 fn 生成新快照后，
 * 按「索引中的会话 cwd === 新 path」剪枝成员（对应 WorkspaceEntity.mutate）；
 * status 对应官方 missing-dir 判定。
 */
function makeEntity(id, path, hostRef) {
  const record = { path, title: id, sessionIds: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  return {
    id,
    // 官方语义：path / title 都是读取 record 的实时 getter（mutate 换路径/标题后立即生效）
    get path() { return record.path; },
    get title() { return record.title; },
    get record() { return record; },
    get sessionIds() { return [...record.sessionIds].filter((sid) => hostRef.sessionPath(String(sid)) === record.path); },
    attached: [],
    detached: [],
    failAttach: false,
    async status() { return existsSync(record.path) ? 'ok' : 'missing-dir'; },
    async mutate(fn) {
      // 官方语义：整体换新快照（本插件借此同步改写 path/title），随后按索引剪枝成员
      const changed = fn(record);
      const pruned = changed.sessionIds.filter((sid) => hostRef.sessionPath(String(sid)) === changed.path);
      Object.assign(record, changed, {
        sessionIds: pruned,
        updatedAt: new Date().toISOString()
      });
    },
    async attachSession(sid) {
      if (this.failAttach) throw new Error('simulated attach failure');
      if (!record.sessionIds.includes(sid)) {
        // 官方语义：未记账 id 需通过「头部 cwd 规范化后 === path」校验，
        // 并经 rememberSessionPath 回填三张索引后才挂账
        const header = readHeader(readFileSync(findArtifact(sid)));
        let canonical;
        try { canonical = realpathSync(header.cwd); } catch {
          throw new Error(`cwd does not resolve: '${header.cwd}'`);
        }
        if (canonical.toLowerCase() !== record.path.toLowerCase()) throw new Error(`cwd resolves elsewhere: '${header.cwd}'`);
        sharedIndex.headers.set(String(sid), header);
        sharedIndex.sessionPaths.set(String(sid), canonical);
        sharedIndex.invalidSessionPaths.delete(String(sid));
      }
      this.attached.push(sid);
      record.sessionIds.unshift(sid);
    },
    async detachSession(sid) {
      this.detached.push(sid);
      record.sessionIds = record.sessionIds.filter((x) => x !== sid);
    }
  };
}

/** 按存储布局约定在磁盘上找某会话的档案位置。 */
function findArtifact(sessionId) {
  for (const proj of readdirSync(root)) {
    if (!(proj.startsWith('--') && proj.endsWith('--'))) continue;
    const candidate = join(root, proj, sessionId, 'session.jsonl.zstd');
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`artifact for ${sessionId} not found`);
}

beforeEach(() => {
  // 生产环境中 cwd 一律是 realpath 规范化后的 canonical 路径（官方注册表
  // 的唯一性约定）；macOS 的 Temp 位于 /var → /private/var 符号链接下，
  // 夹具若用未规范化路径会与 canonical 比对失配，因此创建后立即归一。
  root = realpathSync(makeRoot());
  A = join(root, 'proj-alpha');
  B = join(root, 'proj-beta');
  mkdirSync(A, { recursive: true });
  mkdirSync(B, { recursive: true });
  process.env.DSH_HOME = root; // 备份重定向

  // 会话 session-aaa 归属 A（真实 zstd 帧结构）
  const srcArtifact = artifactPath(root, A, 'session-aaa');
  mkdirSync(dirname(srcArtifact), { recursive: true });
  mkdirSync(dirname(artifactPath(root, B, 'placeholder')), { recursive: true });
  writeFileSync(srcArtifact, makeArtifact({ type: 'session', id: 'session-aaa', cwd: A, title: 'Alpha discussion' }));

  // 三张内存索引先于实体创建（实体 mutate 的成员剪枝按此判定）；
  // 官方实体持有的是 { sessionPath(id) } 形态的宿主引用
  sharedIndex = { headers: new Map(), sessionPaths: new Map(), invalidSessionPaths: new Map() };
  const hostRef = { ...sharedIndex, sessionPath: (id) => sharedIndex.sessionPaths.get(String(id)) };

  entityA = makeEntity('wid-a', A, hostRef);
  entityB = makeEntity('wid-b', B, hostRef);
  const registry = {
    ...sharedIndex,
    entities: new Map([['wid-a', entityA], ['wid-b', entityB]]),
    get(id) { return this.entities.get(id); },
    list() { return [...this.entities.values()]; }
  };
  const persistence = {
    root,
    async list() {
      // 动态扫描 root（与真实后端一致）：遍历 projectKey 目录读头部
      const out = [];
      if (!existsSync(root)) return out;
      for (const proj of readdirSync(root)) {
        if (!(proj.startsWith('--') && proj.endsWith('--'))) continue;
        const projPath = join(root, proj);
        for (const idDir of readdirSync(projPath)) {
          const f = join(projPath, idDir, 'session.jsonl.zstd');
          if (!existsSync(f)) continue;
          try { out.push(readHeader(readFileSync(f))); } catch { /* skip */ }
        }
      }
      return out;
    }
  };
  let rpcHandler = null;
  ctx = {
    workspaceRegistry: registry,
    sessionPersistence: persistence,
    logger: { info() {}, warn() {} },
    get: () => undefined,
    connection: { rpc: { handle(_ch, h) { rpcHandler = h; return () => {}; } } }
  };
  ctx.__rpc = () => rpcHandler;
});

afterEach(() => {
  delete process.env.DSH_HOME;
  rmSync(root, { recursive: true, force: true });
});

async function call(endpoint, payload) {
  return await ctx.__rpc()(endpoint, payload ?? {});
}

test('mover.status 就绪', async () => {
  apply(ctx);
  const res = await call('mover.status');
  assert.equal(res.ok, true);
  assert.equal(res.value.ready, true);
});

test('正常迁移：文件物理搬移 + 头部改写 + 双向记账 + 有备份', async () => {
  apply(ctx);
  entityA.record.sessionIds.push('session-aaa');
  const before = readFileSync(artifactPath(root, A, 'session-aaa'));

  const res = await call('mover.move', { sessionId: 'session-aaa', targetWorkspaceId: 'wid-b' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.value.moved, true);
  assert.equal(res.value.title, 'Alpha discussion');
  assert.equal(res.value.cacheInvalidated, true);

  assert.ok(!existsSync(artifactPath(root, A, 'session-aaa')), 'source artifact gone');
  const movedBuf = readFileSync(artifactPath(root, B, 'session-aaa'));
  assert.equal(readHeader(movedBuf).cwd, B);

  // 其余帧字节保留
  const fo = scanFrames(before), fn = scanFrames(movedBuf);
  assert.equal(fn.length, fo.length);
  for (let i = 1; i < fo.length; i++) {
    assert.ok(before.subarray(fo[i][0], fo[i][1]).equals(movedBuf.subarray(fn[i][0], fn[i][1])), `frame ${i} preserved`);
  }

  // 记账
  assert.deepEqual(entityB.attached, ['session-aaa']);
  assert.deepEqual(entityA.detached, ['session-aaa']);
  assert.deepEqual(entityA.sessionIds, []);

  // 备份落在 $DSH_HOME/workspace-mover/backups
  const backups = join(root, 'workspace-mover', 'backups');
  assert.ok(existsSync(backups));
  assert.ok(readdirSync(backups).some((f) => f.startsWith('session-aaa')));
});

test('移动历史：可查询并一键撤回到原工作区', async () => {
  apply(ctx);
  entityA.record.sessionIds.push('session-aaa');

  const moved = await call('mover.move', { sessionId: 'session-aaa', targetWorkspaceId: 'wid-b' });
  assert.equal(moved.ok, true, JSON.stringify(moved));
  assert.ok(moved.value.historyId);

  const listed = await call('mover.history');
  assert.equal(listed.ok, true);
  assert.equal(listed.value.items[0].id, moved.value.historyId);
  assert.equal(listed.value.items[0].sourceWorkspaceId, 'wid-a');
  assert.equal(listed.value.items[0].targetWorkspaceId, 'wid-b');
  assert.equal(listed.value.items[0].title, 'Alpha discussion');

  const undone = await call('mover.undo', { historyId: moved.value.historyId });
  assert.equal(undone.ok, true, JSON.stringify(undone));
  assert.equal(undone.value.undone, true);
  assert.ok(existsSync(artifactPath(root, A, 'session-aaa')));
  assert.ok(!existsSync(artifactPath(root, B, 'session-aaa')));
  assert.deepEqual(entityA.sessionIds, ['session-aaa']);
  assert.deepEqual(entityB.sessionIds, []);

  const after = await call('mover.history');
  assert.deepEqual(after.value.items, []);
});

test('同工作区移动被拒绝', async () => {
  apply(ctx);
  entityA.record.sessionIds.push('session-aaa'); // 已记账：真·重复移动
  const res = await call('mover.move', { sessionId: 'session-aaa', targetWorkspaceId: 'wid-a' });
  assert.equal(res.ok, false);
  assert.match(res.error.message, /already belongs/);
});

test('磁盘已属目标但未记账时自动补账（自愈）', async () => {
  apply(ctx);
  // cwd=A、无人记账的会话拖到 wid-a（它自己的真实归属路径）
  const dir = artifactPath(root, A, 'session-selfheal');
  mkdirSync(dirname(dir), { recursive: true });
  writeFileSync(dir, makeArtifact({ type: 'session', id: 'session-selfheal', cwd: A }));

  const res = await call('mover.move', { sessionId: 'session-selfheal', targetWorkspaceId: 'wid-a' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.value.attached, true);
  assert.equal(res.value.moved, false);
  assert.ok(entityA.attached.includes('session-selfheal'), 'accounting repaired');
  assert.ok(existsSync(dir), 'file untouched');
});

test('未知目标工作区被拒绝', async () => {
  apply(ctx);
  const res = await call('mover.move', { sessionId: 'session-aaa', targetWorkspaceId: 'nope' });
  assert.equal(res.ok, false);
  assert.match(res.error.message, /unknown workspace/i);
});

test('attach 失败 → 自动回滚到源目录并重新挂账', async () => {
  apply(ctx);
  entityB.failAttach = true;
  entityA.record.sessionIds.push('session-aaa');
  const originalBytes = readFileSync(artifactPath(root, A, 'session-aaa'));

  const res = await call('mover.move', { sessionId: 'session-aaa', targetWorkspaceId: 'wid-b' });
  assert.equal(res.ok, false);
  assert.match(res.error.message, /rolled back cleanly/i);
  assert.ok(existsSync(artifactPath(root, A, 'session-aaa')), 'artifact restored at source');
  assert.ok(!existsSync(artifactPath(root, B, 'session-aaa')), 'destination cleaned up');
  assert.deepEqual(readFileSync(artifactPath(root, A, 'session-aaa')), originalBytes, 'bytes identical after rollback');
  assert.deepEqual(entityB.attached, []);
  assert.ok(entityA.attached.includes('session-aaa'), 're-attached to source');
});

test('常驻内存但空闲的会话允许迁移：刷新索引 + 预置记账 + 清理持久化状态', async () => {
  apply(ctx);
  const staleState = { meta: { cwd: A }, cursor: 1, owner: {} };
  ctx.sessionPersistence.coordinator = { states: new Map([['session-aaa', staleState]]) };
  // 模拟注册表三张索引里的旧 cwd 缓存（宿主启动时由 live header 写入）
  ctx.workspaceRegistry.headers.set('session-aaa', { id: 'session-aaa', cwd: A });
  ctx.workspaceRegistry.sessionPaths.set('session-aaa', A);
  ctx.get = (key) => {
    if (key === 'agents') return { get: () => ({ status: 'idle' }) };
    if (key === 'sessions') return { get: () => ({ id: 'session-aaa', header: { cwd: A } }) };
    return undefined;
  };
  entityA.record.sessionIds.push('session-aaa');

  const res = await call('mover.move', { sessionId: 'session-aaa', targetWorkspaceId: 'wid-b' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.ok(!ctx.sessionPersistence.coordinator.states.has('session-aaa'), 'stale state deleted so host re-adopts from disk');
  assert.ok(existsSync(artifactPath(root, B, 'session-aaa')));
  // 预置记账生效：目标实体持有会话，索引指向新路径
  assert.ok(entityB.record.sessionIds.includes('session-aaa'), 'pre-seeded membership attached');
  assert.equal(entityB.attached.includes('session-aaa'), true, 'attach still called to persist membership');
  assert.equal(ctx.workspaceRegistry.sessionPaths.get('session-aaa'), B, 'sessionPaths points at target');
  assert.equal(ctx.workspaceRegistry.headers.get('session-aaa').cwd, B, 'headers cache refreshed');
});

test('常驻会话 attach 失败时撤销预置记账并回滚', async () => {
  apply(ctx);
  entityB.failAttach = true;
  ctx.get = (key) => {
    if (key === 'agents') return { get: () => ({ status: 'idle' }) };
    if (key === 'sessions') return { get: () => ({ id: 'session-aaa', header: { cwd: A } }) };
    return undefined;
  };
  ctx.workspaceRegistry.headers.set('session-aaa', { id: 'session-aaa', cwd: A });
  ctx.workspaceRegistry.sessionPaths.set('session-aaa', A);
  entityA.record.sessionIds.push('session-aaa');

  const res = await call('mover.move', { sessionId: 'session-aaa', targetWorkspaceId: 'wid-b' });
  assert.equal(res.ok, false);
  assert.match(res.error.message, /rolled back cleanly/i);
  // 预置已撤销
  assert.ok(!entityB.record.sessionIds.includes('session-aaa'), 'pre-seed undone');
  assert.equal(ctx.workspaceRegistry.sessionPaths.get('session-aaa'), A, 'prior sessionPath restored');
  assert.equal(ctx.workspaceRegistry.headers.get('session-aaa').cwd, A, 'prior header restored');
  // 文件与源记账恢复
  assert.ok(existsSync(artifactPath(root, A, 'session-aaa')), 'artifact restored at source');
  assert.ok(entityA.attached.includes('session-aaa'), 're-attached to source');
});

test('回合进行中的会话被拒绝', async () => {
  apply(ctx);
  ctx.get = (key) => {
    if (key === 'agents') return { get: () => ({ status: 'running' }) };
    return undefined;
  };

  const res = await call('mover.move', { sessionId: 'session-aaa', targetWorkspaceId: 'wid-b' });
  assert.equal(res.ok, false);
  assert.match(res.error.message, /currently running/);
  assert.ok(existsSync(artifactPath(root, A, 'session-aaa')), 'nothing moved');
});

// ---- v0.3 孤儿救援：扫描分类 + 批量修复 ----

test('mover.scan 分类 orphaned / unregistered / ok，并检出幽灵记账', async () => {
  apply(ctx);
  // ok：A 下已注册的 session-aaa（beforeEach 已建）；生产环境启动期会把健康成员写入索引
  entityA.record.sessionIds.push('session-aaa');
  sharedIndex.headers.set('session-aaa', { id: 'session-aaa', cwd: A });
  sharedIndex.sessionPaths.set('session-aaa', realpathSync(A));
  // unregistered：cwd=A 有效但无人记账
  const unregDir = artifactPath(root, A, 'session-unreg');
  mkdirSync(dirname(unregDir), { recursive: true });
  writeFileSync(unregDir, makeArtifact({ type: 'session', id: 'session-unreg', cwd: A }));
  // orphaned：cwd 指向已不存在的目录
  const orphanDir = artifactPath(root, DEAD, 'session-orphan');
  mkdirSync(dirname(orphanDir), { recursive: true });
  writeFileSync(orphanDir, makeArtifact({ type: 'session', id: 'session-orphan', cwd: DEAD }));
  // ghost：记账了但磁盘无档案
  entityB.record.sessionIds.push('session-ghost');

  const res = await call('mover.scan', {});
  assert.equal(res.ok, true, JSON.stringify(res));
  const byId = Object.fromEntries(res.value.items.map((it) => [it.sessionId, it]));
  assert.equal(byId['session-aaa'].status, 'ok');
  assert.equal(byId['session-unreg'].status, 'unregistered');
  assert.equal(byId['session-unreg'].targetWorkspaceId, 'wid-a');
  assert.equal(byId['session-orphan'].status, 'orphaned');
  assert.deepEqual(res.value.ghosts, [{ workspaceId: 'wid-b', sessionId: 'session-ghost' }]);
  assert.equal(res.value.scanned, 3);
});

test('mover.repair attach：原地补记账到路径匹配的工作区', async () => {
  apply(ctx);
  const unregDir = artifactPath(root, A, 'session-unreg');
  mkdirSync(dirname(unregDir), { recursive: true });
  writeFileSync(unregDir, makeArtifact({ type: 'session', id: 'session-unreg', cwd: A }));

  const res = await call('mover.repair', { actions: [{ sessionId: 'session-unreg', kind: 'attach' }] });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.value.results[0].ok, true);
  assert.equal(res.value.results[0].attachedTo, 'wid-a');
  assert.ok(entityA.attached.includes('session-unreg'));
});

// ---- v0.7 误放会话：misfiled 分类 + 一键归位 ----

test('mover.scan 识别误放会话：记账在 A、目录属于 B', async () => {
  apply(ctx);
  // 磁盘文件与头部 cwd 都指向 B（文件本就在正确位置），但记账挂在 A 名下
  const misDir = artifactPath(root, B, 'session-mis');
  mkdirSync(dirname(misDir), { recursive: true });
  writeFileSync(misDir, makeArtifact({ type: 'session', id: 'session-mis', cwd: B, title: 'Misfiled talk' }));
  entityA.record.sessionIds.push('session-mis');

  const res = await call('mover.scan', {});
  assert.equal(res.ok, true, JSON.stringify(res));
  const it = res.value.items.find((i) => i.sessionId === 'session-mis');
  assert.equal(it.status, 'misfiled');
  assert.equal(it.homeWorkspaceId, 'wid-b');
  assert.equal(it.homeTitle, 'wid-b');
  assert.equal(it.homePath, B);
  assert.deepEqual(it.ownerWorkspaceIds, ['wid-a']);
  assert.equal(res.value.counts.misfiled, 1);
});

test('mover.repair home：从错误记账方摘账并补到正确分组（文件不动）', async () => {
  apply(ctx);
  const misDir = artifactPath(root, B, 'session-mis');
  mkdirSync(dirname(misDir), { recursive: true });
  writeFileSync(misDir, makeArtifact({ type: 'session', id: 'session-mis', cwd: B, title: 'Misfiled talk' }));
  entityA.record.sessionIds.push('session-mis');

  const res = await call('mover.repair', { actions: [{ sessionId: 'session-mis', kind: 'home' }] });
  assert.equal(res.ok, true, JSON.stringify(res));
  const r = res.value.results[0];
  assert.equal(r.ok, true);
  assert.equal(r.homedTo, 'wid-b');
  assert.ok(!entityA.record.sessionIds.includes('session-mis'), '错误记账已摘除');
  assert.ok(entityB.record.sessionIds.includes('session-mis'), '正确分组已补账');
  assert.ok(existsSync(misDir), '磁盘文件原样不动');
  // 归位后再扫描应归类为 ok
  const scan = await call('mover.scan', {});
  assert.equal(scan.value.items.find((i) => i.sessionId === 'session-mis').status, 'ok');
});

test('mover.repair home：双重记账时摘掉所有错误方，只留正确分组', async () => {
  apply(ctx);
  const misDir = artifactPath(root, B, 'session-mis');
  mkdirSync(dirname(misDir), { recursive: true });
  writeFileSync(misDir, makeArtifact({ type: 'session', id: 'session-mis', cwd: B }));
  entityA.record.sessionIds.push('session-mis');
  entityB.record.sessionIds.push('session-mis');

  const res = await call('mover.repair', { actions: [{ sessionId: 'session-mis', kind: 'home' }] });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.value.results[0].ok, true);
  assert.ok(!entityA.record.sessionIds.includes('session-mis'), '多余记账已摘除');
  assert.ok(entityB.record.sessionIds.includes('session-mis'), '正确分组保持记账');
});

test('mover.repair relink：失联会话换路径真迁移（复用迁移管线）', async () => {
  apply(ctx);
  const orphanDir = artifactPath(root, DEAD, 'session-orphan');
  mkdirSync(dirname(orphanDir), { recursive: true });
  writeFileSync(orphanDir, makeArtifact({ type: 'session', id: 'session-orphan', cwd: DEAD }));

  const res = await call('mover.repair', {
    actions: [{ sessionId: 'session-orphan', kind: 'relink', targetWorkspaceId: 'wid-b' }]
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.value.results[0].ok, true);
  assert.equal(res.value.results[0].to, B);
  assert.ok(!existsSync(orphanDir), 'old artifact gone');
  const movedBuf = readFileSync(artifactPath(root, B, 'session-orphan'));
  assert.equal(readHeader(movedBuf).cwd, B);
});

test('mover.repair：attach 无匹配工作区时报错、未知 kind 报错、坏批次整体拒绝', async () => {
  apply(ctx);
  const noWs = await call('mover.repair', { actions: [{ sessionId: 'session-nofile', kind: 'attach' }] });
  assert.equal(noWs.ok, true); // 批量端点逐条返回结果而非整包失败
  assert.equal(noWs.value.results[0].ok, false);

  const badKind = await call('mover.repair', { actions: [{ sessionId: 'x', kind: 'wat' }] });
  assert.equal(badKind.value.results[0].ok, false);
  assert.match(badKind.value.results[0].error, /unknown kind/);

  const tooMany = await call('mover.repair', { actions: Array.from({ length: 51 }, (_, i) => ({ sessionId: `s${i}`, kind: 'attach' })) });
  assert.equal(tooMany.ok, false);
});

// ---- v0.5 工作区搬家向导：体检 + 原地重定向 ----

/** 模拟「用户已在磁盘把项目文件夹改名」的现实场景，并登记一个已记账成员。 */
function setupMovedFolder() {
  entityA.record.sessionIds.push('session-aaa');
  sharedIndex.headers.set('session-aaa', { id: 'session-aaa', cwd: A, title: 'Alpha discussion' });
  sharedIndex.sessionPaths.set('session-aaa', realpathSync(A));
  const moved = A + '-moved';
  renameSync(A, moved);
  return moved;
}

test('mover.ws.audit：官方 status 判定 missing-dir，记账数取原始名单', async () => {
  apply(ctx);
  entityA.record.sessionIds.push('session-aaa');
  renameSync(A, A + '-moved');

  const res = await call('mover.ws.audit');
  assert.equal(res.ok, true, JSON.stringify(res));
  const byId = Object.fromEntries(res.value.items.map((it) => [it.workspaceId, it]));
  assert.equal(byId['wid-a'].status, 'missing-dir');
  assert.equal(byId['wid-a'].path, A, '失效路径原样暴露给体检面板');
  assert.equal(byId['wid-a'].memberCount, 1, '原始记账数（含索引已失联的成员）');
  assert.equal(byId['wid-b'].status, 'ok');
});

test('搬家向导：dryRun 只盘点；执行后换 path、成员原地迁移、散件补挂账', async () => {
  apply(ctx);
  const moved = setupMovedFolder();
  // 一只从未被记账的散件也留在旧路径（cwd=A 且目录已被搬走）
  const strayDir = artifactPath(root, A, 'session-stray');
  mkdirSync(dirname(strayDir), { recursive: true });
  writeFileSync(strayDir, makeArtifact({ type: 'session', id: 'session-stray', cwd: A }));

  const dry = await call('mover.repoint', { workspaceId: 'wid-a', newPath: moved, dryRun: true });
  assert.equal(dry.ok, true, JSON.stringify(dry));
  assert.equal(dry.value.count, 2);
  assert.deepEqual(dry.value.items.map((i) => i.sessionId).sort(), ['session-aaa', 'session-stray']);
  assert.ok(existsSync(artifactPath(root, A, 'session-aaa')), 'dryRun 不动任何文件');

  const res = await call('mover.repoint', { workspaceId: 'wid-a', newPath: moved });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.value.pathUpdated, true);
  assert.equal(res.value.movedCount, 2);
  assert.deepEqual(res.value.skipped, []);

  const canon = realpathSync(moved);
  assert.equal(entityA.record.path, canon, '注册表路径已重定向（工作区 id 不变）');
  assert.ok(entityA.record.sessionIds.includes('session-aaa'), '成员通过 mutate 剪枝存活（索引预置生效）');
  assert.ok(entityA.record.sessionIds.includes('session-stray'), '散件补挂账进同一工作区');

  const newArtifact = readFileSync(artifactPath(root, canon, 'session-aaa'));
  assert.equal(readHeader(newArtifact).cwd, canon, '头部 cwd 改写为新家');
  assert.ok(!existsSync(artifactPath(root, A, 'session-aaa')), '旧位置档案清空');

  const after = await call('mover.ws.audit');
  const row = after.value.items.find((it) => it.workspaceId === 'wid-a');
  assert.equal(row.status, 'ok', '搬家后体检转绿');
});

test('新路径被其他工作区占用时拒绝，且不动任何文件', async () => {
  apply(ctx);
  setupMovedFolder();
  const before = readFileSync(artifactPath(root, A, 'session-aaa'));

  const res = await call('mover.repoint', { workspaceId: 'wid-a', newPath: B });
  assert.equal(res.ok, false);
  assert.match(res.error.message, /占用/);
  assert.equal(entityA.record.path, A, 'path 未变');
  assert.deepEqual(readFileSync(artifactPath(root, A, 'session-aaa')), before, '字节未动');
});

test('宿主实体缺少 mutate 写入通道时整体中止并还原索引快照', async () => {
  apply(ctx);
  setupMovedFolder();
  const priorHeader = sharedIndex.headers.get('session-aaa');
  delete entityA.mutate;

  const res = await call('mover.repoint', { workspaceId: 'wid-a', newPath: A + '-moved' });
  assert.equal(res.ok, false);
  assert.match(res.error.message, /mutate/);
  assert.ok(!/[\\/]proj-alpha-moved[\\/]/.test(findArtifact('session-aaa')), '文件留在原地');
  assert.equal(sharedIndex.headers.get('session-aaa'), priorHeader, 'headers 快照还原');
  assert.equal(
    String(sharedIndex.sessionPaths.get('session-aaa')).toLowerCase(),
    A.toLowerCase(),
    'sessionPaths 还原为改名前的 canonical（realpath 与原路径一致）'
  );
});

test('逐会话失败只影响自己：目标撞车者跳过，其余完成；清理障碍后续跑收尾', async () => {
  apply(ctx);
  const moved = setupMovedFolder();
  entityA.record.sessionIds.push('session-blocker');
  mkdirSync(dirname(artifactPath(root, A, 'session-blocker')), { recursive: true });
  writeFileSync(artifactPath(root, A, 'session-blocker'),
    makeArtifact({ type: 'session', id: 'session-blocker', cwd: A }));
  sharedIndex.headers.set('session-blocker', { id: 'session-blocker', cwd: A });
  sharedIndex.sessionPaths.set('session-blocker', A); // canonical 即改名前的原路径
  // 预先在新家放置同名档案制造撞车
  mkdirSync(dirname(artifactPath(root, moved, 'session-blocker')), { recursive: true });
  writeFileSync(artifactPath(root, moved, 'session-blocker'), makeArtifact({ type: 'session', id: 'x', cwd: moved }));

  const first = await call('mover.repoint', { workspaceId: 'wid-a', fromPath: A, newPath: moved });
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.deepEqual(first.value.moved.map((m) => m.sessionId), ['session-aaa'], '健康成员照常迁移');
  assert.equal(first.value.skipped.length, 1);
  assert.equal(first.value.skipped[0].sessionId, 'session-blocker');
  assert.match(first.value.skipped[0].error, /已有同名档案/);

  rmSync(dirname(artifactPath(root, moved, 'session-blocker')), { recursive: true, force: true });

  const second = await call('mover.repoint', { workspaceId: 'wid-a', fromPath: A, newPath: moved });
  assert.equal(second.ok, true, JSON.stringify(second));
  assert.equal(second.value.pathUpdated, false, 'resume 模式不再重复改写 path');
  assert.equal(second.value.movedCount, 1);
  assert.equal(second.value.moved[0].sessionId, 'session-blocker');
  assert.ok(existsSync(artifactPath(root, realpathSync(moved), 'session-blocker')));
});

test('进行中的会话整批跳过；path 已换好，空闲后携原路径续跑即可收尾', async () => {
  apply(ctx);
  setupMovedFolder();
  ctx.get = (key) => (key === 'agents' ? { get: () => ({ status: 'running' }) } : undefined);

  const dry = await call('mover.repoint', { workspaceId: 'wid-a', newPath: A + '-moved', dryRun: true });
  assert.equal(dry.value.count, 1, '盘点仍如实报告总数');

  const res = await call('mover.repoint', { workspaceId: 'wid-a', newPath: A + '-moved' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.value.movedCount, 0);
  assert.equal(res.value.skipped[0].sessionId, 'session-aaa');
  assert.match(res.value.skipped[0].error, /进行中/);
  assert.equal(entityA.record.path, realpathSync(A + '-moved'), 'path 换好了；等会话空闲后再续跑清扫');
  assert.ok(entityA.record.sessionIds.includes('session-aaa'), '进行中成员不被剪枝清掉（预置覆盖全部受影响会话）');
});

// ---- v0.6 批量迁移：mover.moveMany ----

test('moveMany：多个会话一次迁移到同一目标，逐条返回结果与汇总', async () => {
  apply(ctx);
  entityA.record.sessionIds.push('session-aaa');
  // 同组再来一个会话
  const dir2 = artifactPath(root, A, 'session-bbb');
  mkdirSync(dirname(dir2), { recursive: true });
  writeFileSync(dir2, makeArtifact({ type: 'session', id: 'session-bbb', cwd: A, title: 'Beta talk' }));

  const res = await call('mover.moveMany', {
    sessions: [
      { sessionId: 'session-aaa', sessionTitle: 'Alpha discussion' },
      { sessionId: 'session-bbb' }
    ],
    targetWorkspaceId: 'wid-b'
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.value.movedCount, 2);
  assert.equal(res.value.failedCount, 0);
  assert.deepEqual(res.value.results.map((r) => r.sessionId).sort(), ['session-aaa', 'session-bbb']);
  assert.ok(res.value.results.every((r) => r.ok));
  assert.ok(!existsSync(artifactPath(root, A, 'session-aaa')));
  assert.ok(existsSync(artifactPath(root, B, 'session-bbb')));
  assert.equal(readHeader(readFileSync(artifactPath(root, B, 'session-bbb'))).cwd, B);
  // 历史聚合成一条批量记录（不再逐条落账），可整批撤回
  assert.ok(res.value.historyId);
  const history = await call('mover.history');
  assert.equal(history.value.items.length, 1);
  const batchEntry = history.value.items[0];
  assert.equal(batchEntry.id, res.value.historyId);
  assert.equal(batchEntry.batch, true);
  assert.equal(batchEntry.targetWorkspaceId, 'wid-b');
  assert.equal(batchEntry.to, B);
  assert.equal(batchEntry.sessions.length, 2);
  const bySession = Object.fromEntries(batchEntry.sessions.map((s) => [s.sessionId, s]));
  assert.equal(bySession['session-aaa'].sourceWorkspaceId, 'wid-a');
  assert.equal(bySession['session-aaa'].from, A);
  assert.equal(bySession['session-bbb'].sourceWorkspaceId, 'wid-a');
});

test('moveMany：坏会话只影响自己，其余照常完成', async () => {
  apply(ctx);
  entityA.record.sessionIds.push('session-aaa');
  const res = await call('mover.moveMany', {
    sessions: [
      { sessionId: 'session-ghost' }, // 不存在
      { sessionId: 'session-aaa' }
    ],
    targetWorkspaceId: 'wid-b'
  });
  assert.equal(res.ok, true);
  assert.equal(res.value.movedCount, 1);
  assert.equal(res.value.failedCount, 1);
  const byId = Object.fromEntries(res.value.results.map((r) => [r.sessionId, r]));
  assert.equal(byId['session-ghost'].ok, false);
  assert.match(byId['session-ghost'].error, /not found/);
  assert.equal(byId['session-aaa'].ok, true);
  // 有失败项时只把成功的聚合成一条
  const history = await call('mover.history');
  assert.equal(history.value.items.length, 1);
  assert.deepEqual(history.value.items[0].sessions.map((s) => s.sessionId), ['session-aaa']);
});

test('moveMany 历史聚合成一条：整批一键撤回到各自来源', async () => {
  apply(ctx);
  entityA.record.sessionIds.push('session-aaa');
  const dir2 = artifactPath(root, A, 'session-bbb');
  mkdirSync(dirname(dir2), { recursive: true });
  writeFileSync(dir2, makeArtifact({ type: 'session', id: 'session-bbb', cwd: A, title: 'Beta talk' }));

  const res = await call('mover.moveMany', {
    sessions: [{ sessionId: 'session-aaa' }, { sessionId: 'session-bbb' }],
    targetWorkspaceId: 'wid-b'
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.ok(res.value.historyId);

  const undone = await call('mover.undo', { historyId: res.value.historyId });
  assert.equal(undone.ok, true, JSON.stringify(undone));
  assert.equal(undone.value.undone, true);
  assert.equal(undone.value.batch, true);
  assert.equal(undone.value.undoneCount, 2);
  assert.equal(undone.value.failedCount, 0);
  assert.ok(existsSync(artifactPath(root, A, 'session-aaa')), 'session-aaa 回到 A');
  assert.ok(existsSync(artifactPath(root, A, 'session-bbb')), 'session-bbb 回到 A');
  assert.ok(!existsSync(artifactPath(root, B, 'session-aaa')));
  assert.ok(!existsSync(artifactPath(root, B, 'session-bbb')));
  assert.ok(entityA.sessionIds.includes('session-aaa'));
  assert.ok(entityA.sessionIds.includes('session-bbb'));
  const after = await call('mover.history');
  assert.deepEqual(after.value.items, [], '整批撤回后记录清空');
});

test('批量撤回部分失败：来源已失效的会话保留在记录中，其余照常撤回', async () => {
  apply(ctx);
  entityA.record.sessionIds.push('session-aaa');
  const moved = await call('mover.move', { sessionId: 'session-aaa', targetWorkspaceId: 'wid-b' });
  assert.equal(moved.ok, true, JSON.stringify(moved));

  // 直接构造一条批量历史：一个来源有效（wid-a），一个来源工作区已不存在（wid-gone）
  const historyDir = join(root, 'workspace-mover');
  mkdirSync(historyDir, { recursive: true });
  writeFileSync(join(historyDir, 'history.json'), JSON.stringify([{
    id: 'batch-crafted',
    batch: true,
    targetWorkspaceId: 'wid-b',
    to: B,
    movedAt: new Date().toISOString(),
    sessions: [
      { sessionId: 'session-aaa', title: 'Alpha discussion', from: A, sourceWorkspaceId: 'wid-a' },
      { sessionId: 'session-gone', title: 'Lost', from: A, sourceWorkspaceId: 'wid-gone' }
    ]
  }], null, 2));

  const undone = await call('mover.undo', { historyId: 'batch-crafted' });
  assert.equal(undone.ok, true, JSON.stringify(undone));
  assert.equal(undone.value.undoneCount, 1);
  assert.equal(undone.value.failedCount, 1);
  assert.ok(existsSync(artifactPath(root, A, 'session-aaa')), '有效来源的会话被撤回');
  // 记录保留失败项，可再次撤回
  const after = await call('mover.history');
  assert.equal(after.value.items.length, 1);
  assert.deepEqual(after.value.items[0].sessions.map((s) => s.sessionId), ['session-gone']);
});

test('moveMany：空列表 / 超上限 / 缺 target 整批拒绝', async () => {
  apply(ctx);
  const empty = await call('mover.moveMany', { sessions: [], targetWorkspaceId: 'wid-b' });
  assert.equal(empty.ok, false);
  const tooMany = await call('mover.moveMany', {
    sessions: Array.from({ length: 51 }, (_, i) => ({ sessionId: `s${i}` })),
    targetWorkspaceId: 'wid-b'
  });
  assert.equal(tooMany.ok, false);
  const noTarget = await call('mover.moveMany', { sessions: [{ sessionId: 'session-aaa' }] });
  assert.equal(noTarget.ok, false);
});

// ---- v0.5.1 三项热修回归 ----

test('标题同步：默认名（=旧文件夹名）跟随改名，自定义标题原样保留', async () => {
  apply(ctx);
  setupMovedFolder();
  const moved = A + '-moved';

  entityA.record.title = 'proj-alpha';           // 官方 create 的默认值 = 文件夹名 → 应跟随改为 proj-alpha-moved
  await call('mover.repoint', { workspaceId: 'wid-a', newPath: moved });
  assert.equal(entityA.record.title, 'proj-alpha-moved', '默认名同步为新文件夹名');

  apply(ctx);
  setupMovedFolder2();
  entityA.record.title = '我的项目';              // 用户自定义过 → 不动
  await call('mover.repoint', { workspaceId: 'wid-a', newPath: A + '-moved' });
  assert.equal(entityA.record.title, '我的项目', '自定义标题保留');
});

/** 独立夹具：避免用例间复用同一目录名导致的前置污染。 */
function setupMovedFolder2() {
  const dir = join(root, 'ws-t2');
  mkdirSync(dir, { recursive: true });
  const artifact = artifactPath(root, dir, 'session-t2');
  mkdirSync(dirname(artifact), { recursive: true });
  writeFileSync(artifact, makeArtifact({ type: 'session', id: 'session-t2', cwd: dir }));
  const ent = makeEntity('wid-t2', dir, { ...sharedIndex, sessionPath: (id) => sharedIndex.sessionPaths.get(String(id)) });
  ctx.workspaceRegistry.entities.set('wid-t2', ent);
  sharedIndex.sessionPaths.set('session-t2', realpathSync(dir));
  renameSync(dir, dir + '-moved');
  return dir;
}

test('常驻会话热修：冻结头原地换新、@ 搜索缓存按旧根清除、投影检查点身份对齐', async () => {
  apply(ctx);
  const moved = setupMovedFolder();

  const liveHeader = Object.freeze({ id: 'session-aaa', cwd: A });
  const liveSession = { header: liveHeader };
  let disposed = 0;
  const agent = { session: liveSession };
  const searches = new Map([[agent, { root: A, dispose() { disposed += 1; } }]]);
  const applied = [];
  const projTable = {
    async update(id, fn) {
      const next = fn({ identity: { createdAt: 1720000000000, cwd: A }, rows: { k: { ver: 1, seq: 5, val: {} } } });
      applied.push([id, next]);
      return next;
    }
  };
  ctx.get = (key) => {
    if (key === 'agents') return { get: () => ({ status: 'idle' }) };
    if (key === 'sessions') return { get: (id) => (String(id) === 'session-aaa' ? liveSession : undefined) };
    if (key === 'fileReferences') return { searches };
    if (key === 'sessionProjectionCache') return { table: projTable };
    return undefined;
  };

  const res = await call('mover.repoint', { workspaceId: 'wid-a', newPath: moved });
  assert.equal(res.ok, true, JSON.stringify(res));

  const canon = realpathSync(moved);
  assert.notEqual(liveSession.header, liveHeader, 'live 头已替换而非原地改写');
  assert.equal(liveSession.header.cwd, canon, 'live 头指向新家');
  assert.ok(Object.isFrozen(liveSession.header), '替换后的头保持官方冻结语义');
  assert.equal(disposed, 1, '以旧路径为根的 @ 搜索被 dispose');
  assert.ok(!searches.has(agent), '缓存条目删除，下次 @ 按新头重建');
  assert.equal(applied.length, 1);
  assert.equal(applied[0][0], 'session-aaa');
  assert.equal(applied[0][1].identity.cwd, canon, '投影检查点 identity.cwd 对齐');
  assert.equal(applied[0][1].identity.createdAt, 1720000000000, 'createdAt 不变（同一日志生命周期）');
});

test('宿主缺少 fileReferences/sessionProjectionCache 服务时热修静默降级', async () => {
  apply(ctx);
  setupMovedFolder();
  ctx.get = () => undefined;

  const res = await call('mover.repoint', { workspaceId: 'wid-a', newPath: A + '-moved' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.value.movedCount, 1);
});

//#region v0.8：空分组原始记账 / 归档管理 / 打开文件夹

/** 模拟官方 registry 的持久状态写通道（archiveSession 同款 enqueueOperation + setState）。 */
function stubRegistryState() {
  const registry = ctx.workspaceRegistry;
  registry.requireState = () => ({
    initialized: true,
    workspaceIds: [...registry.entities.keys()],
    archivedSessionIds: registry.archivedSessionIds
  });
  registry.setState = async (next) => { registry.archivedSessionIds = next.archivedSessionIds; };
  registry.enqueueOperation = (fn) => fn();
}

test('mover.workspaces 暴露原始记账数：归档与幽灵成员都算数（空分组判定的依据）', async () => {
  apply(ctx);
  sharedIndex.sessionPaths.set('session-aaa', A);
  entityA.record.sessionIds.push('session-aaa');
  // B 记账了两个幽灵 id（磁盘无档案）+ 一个归档 id
  entityB.record.sessionIds.push('ghost-1', 'ghost-2', 'archived-1');
  ctx.workspaceRegistry.archivedSessionIds = ['archived-1'];

  const res = await call('mover.workspaces');
  assert.equal(res.ok, true);
  const a = res.value.items.find((it) => it.workspaceId === 'wid-a');
  const b = res.value.items.find((it) => it.workspaceId === 'wid-b');
  assert.equal(a.rawSessionCount, 1);
  assert.equal(b.rawSessionCount, 3);
  // 公开 getter 会按索引过滤幽灵 id —— 这正是要用原始记账判定空分组的原因
  assert.deepEqual(b.sessionIds, []);
});

test('mover.archived 列出归档会话：归属取自原始记账，cwd 挂错时给出归位建议', async () => {
  apply(ctx);
  sharedIndex.sessionPaths.set('session-aaa', A);
  entityA.record.sessionIds.push('session-aaa');
  // session-bbb：文件在 B、记账在 A（挂错）→ 归档后建议归位到 B
  const bArtifact = artifactPath(root, B, 'session-bbb');
  mkdirSync(dirname(bArtifact), { recursive: true });
  writeFileSync(bArtifact, makeArtifact({ type: 'session', id: 'session-bbb', cwd: B, title: 'Beta talk' }));
  sharedIndex.sessionPaths.set('session-bbb', B);
  entityA.record.sessionIds.push('session-bbb');
  ctx.workspaceRegistry.archivedSessionIds = ['session-aaa', 'session-bbb'];

  const res = await call('mover.archived');
  assert.equal(res.ok, true, JSON.stringify(res));
  const items = res.value.items;
  assert.equal(items.length, 2);
  const aaa = items.find((it) => it.sessionId === 'session-aaa');
  assert.equal(aaa.title, 'Alpha discussion');
  assert.equal(aaa.ownerWorkspaceId, 'wid-a');
  assert.equal(aaa.suggestedWorkspaceId, null);
  const bbb = items.find((it) => it.sessionId === 'session-bbb');
  assert.equal(bbb.ownerWorkspaceId, 'wid-a');
  assert.equal(bbb.suggestedWorkspaceId, 'wid-b');
  assert.equal(bbb.suggestedTitle, 'wid-b');
});

test('mover.unarchive 取消归档：归档集移除、账本不动、无迁移', async () => {
  apply(ctx);
  entityA.record.sessionIds.push('session-aaa');
  ctx.workspaceRegistry.archivedSessionIds = ['session-aaa', 'session-other'];
  stubRegistryState();

  const res = await call('mover.unarchive', { sessionId: 'session-aaa' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.value.unarchived, true);
  assert.equal(res.value.moved, null);
  assert.deepEqual(ctx.workspaceRegistry.archivedSessionIds, ['session-other']);
  assert.deepEqual(entityA.record.sessionIds, ['session-aaa']);
  assert.equal(entityA.attached.length, 0);
});

test('mover.unarchive 带目标且 ≠ 归属：先出归档集再走完整迁移（备份 + 可撤销）', async () => {
  apply(ctx);
  entityA.record.sessionIds.push('session-aaa');
  ctx.workspaceRegistry.archivedSessionIds = ['session-aaa'];
  stubRegistryState();

  const res = await call('mover.unarchive', { sessionId: 'session-aaa', targetWorkspaceId: 'wid-b' });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.value.moved.moved, true);
  assert.deepEqual(ctx.workspaceRegistry.archivedSessionIds, []);
  assert.ok(existsSync(artifactPath(root, B, 'session-aaa')), 'artifact moved to B');
  assert.ok(!existsSync(artifactPath(root, A, 'session-aaa')), 'source artifact gone');
  assert.ok(existsSync(join(root, 'workspace-mover', 'backups')), 'backup created');

  const listed = await call('mover.history');
  assert.equal(listed.value.items.length, 1);
  const undone = await call('mover.undo', { historyId: listed.value.items[0].id });
  assert.equal(undone.ok, true);
  assert.ok(existsSync(artifactPath(root, A, 'session-aaa')));
});

test('mover.unarchive 拒绝：未归档的会话；registry 缺状态写通道', async () => {
  apply(ctx);
  const miss = await call('mover.unarchive', { sessionId: 'session-aaa' });
  assert.equal(miss.ok, false);
  assert.match(miss.error.message, /not archived/);

  // 归档集里有它，但 registry 没有官方写通道（老版本宿主容错）
  ctx.workspaceRegistry.archivedSessionIds = ['session-aaa'];
  const res = await call('mover.unarchive', { sessionId: 'session-aaa' });
  assert.equal(res.ok, false);
  assert.match(res.error.message, /no state mutation API/);
});

test('mover.openFolder 只允许已注册工作区路径；openInFileManager 按平台拼装命令', async () => {
  apply(ctx);
  // 未注册路径拒绝（不触发任何 spawn）
  const stranger = join(root, 'stranger');
  mkdirSync(stranger, { recursive: true });
  const bad = await call('mover.openFolder', { path: stranger });
  assert.equal(bad.ok, false);
  assert.match(bad.error.message, /does not belong/);

  // 注册了但目录已消失同样拒绝
  const ghost = makeEntity('wid-ghost', join(root, 'ghost-dir'), { ...sharedIndex, sessionPath: (id) => sharedIndex.sessionPaths.get(String(id)) });
  ctx.workspaceRegistry.entities.set('wid-ghost', ghost);
  const missing = await call('mover.openFolder', { workspaceId: 'wid-ghost' });
  assert.equal(missing.ok, false);
  assert.match(missing.error.message, /does not exist/);

  // 平台命令拼装（spawn 注入 fake，不真开窗口）：Windows 走 Shell COM 置前，其余平台原生命令
  const calls = [];
  const fakeChild = { unref() {} };
  const cmd = openInFileManager(A, (command, args, opts) => { calls.push([command, args, opts]); return fakeChild; });
  if (process.platform === 'win32') {
    assert.equal(cmd, 'powershell.exe');
    assert.deepEqual(calls[0][0], 'powershell.exe');
    assert.deepEqual(calls[0][1], ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', `(New-Object -ComObject Shell.Application).Open('${A}')`]);
    assert.deepEqual(calls[0][2], { detached: true, stdio: 'ignore' });
    // 路径里的单引号必须翻倍转义（PowerShell 单引号字符串规则）
    const calls2 = [];
    openInFileManager("E:\\od'd IR", (command, args) => { calls2.push(args); return fakeChild; });
    assert.match(calls2[0][4], /Open\('E:\\od''d IR'\)/);
  } else {
    const expected = process.platform === 'darwin' ? 'open' : 'xdg-open';
    assert.equal(cmd, expected);
    assert.deepEqual(calls[0][0], expected);
    assert.deepEqual(calls[0][1], [A]);
    assert.deepEqual(calls[0][2], { detached: true, stdio: 'ignore' });
  }
});
