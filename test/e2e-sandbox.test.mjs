// 端到端沙箱测试：假注册表 + 假持久化 + 真实文件系统，完整走 mover.move 流程。
// 覆盖：status / 正常迁移 / 同工作区拒绝 / 未知目标 / attach 失败自动回滚。
// 备份目录通过 DSH_HOME 重定向到临时区，不污染真实环境。
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { zstdCompressSync, constants } from 'node:zlib';

import { apply, scanFrames, readHeader, artifactPath } from '../lib/index.js';

const OPTS = { params: { [constants.ZSTD_c_checksumFlag]: 1 } };
const DEAD = 'E:\\wsm-dead-path'; // 刻意不存在的路径（孤儿分类用）
let A; // 每次用例指向真实临时目录（健康会话要求 cwd 在磁盘上存在）
let B;
let root;
let ctx, entityA, entityB;

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

/** 模拟 dsh 工作区实体：record 快照 + 记账，attach 对已记账 id 跳过校验（官方语义）。 */
function makeEntity(id, path) {
  const record = { path, sessionIds: [] };
  return {
    id,
    path,
    get record() { return record; },
    get sessionIds() { return [...record.sessionIds]; },
    attached: [],
    detached: [],
    failAttach: false,
    async attachSession(sid) {
      if (this.failAttach) throw new Error('simulated attach failure');
      this.attached.push(sid);
      record.sessionIds.unshift(sid);
    },
    async detachSession(sid) {
      this.detached.push(sid);
      record.sessionIds = record.sessionIds.filter((x) => x !== sid);
    }
  };
}

beforeEach(() => {
  root = makeRoot();
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

  entityA = makeEntity('wid-a', A);
  entityB = makeEntity('wid-b', B);
  const registry = {
    entities: new Map([['wid-a', entityA], ['wid-b', entityB]]),
    headers: new Map(),
    sessionPaths: new Map(),
    invalidSessionPaths: new Map(),
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
  // ok：A 下已注册的 session-aaa（beforeEach 已建）
  entityA.record.sessionIds.push('session-aaa');
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
