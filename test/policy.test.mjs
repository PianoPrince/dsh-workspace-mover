// dsh-workspace-mover — 可调策略（环境变量通道）的行为测试。
//
// 策略在使用点读取（见 lib/index.js 的 resolvePolicy），因此可以按用例设置环境变量、
// 走真实 RPC 路径观察效果。这里不测 lib/config.js 的 schema（它依赖宿主 loader 提供的
// schemastery，本环境不可解析——那正是走守卫式动态解析的原因）。
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, rmSync, realpathSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { zstdCompressSync, zstdDecompressSync, constants } from 'node:zlib';
import { apply, artifactPath, stashBackup, sessionDir, generationLogFilename, Config, POLICY_FIELDS, buildConfig, attachConfig } from '../lib/index.js';

let root;
let A;
let B;
let ctx;
let rpcHandler;

const ENV_KEYS = [
  'DSH_WORKSPACE_MOVER_HISTORY_LIMIT',
  'DSH_WORKSPACE_MOVER_BACKUP_KEEP',
  'DSH_WORKSPACE_MOVER_BATCH_LIMIT',
  'DSH_WORKSPACE_MOVER_REPOINT_LIMIT',
  'DSH_WORKSPACE_MOVER_SCAN_LIMIT',
  'DSH_WORKSPACE_MOVER_CLEANUP_DAYS'
];

/** 单个 zstd 帧 + 一行 JSON 头（与 e2e 夹具同构）。 */
function makeArtifact(header) {
  return zstdCompressSync(Buffer.from(JSON.stringify(header) + '\n', 'utf8'), {
    params: { [constants.ZSTD_c_checksumFlag]: 1 }
  });
}

function makeRoot() {
  const base = realpathSync(tmpdir());
  let lastErr;
  for (let i = 0; i < 5; i++) {
    try { return mkdtempSync(join(base, 'wsm-policy-')); } catch (err) { lastErr = err; }
  }
  throw lastErr;
}

function makeEntity(id, path, hostRef) {
  const record = { path, title: id, sessionIds: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  return {
    id,
    get path() { return record.path; },
    get title() { return record.title; },
    get record() { return record; },
    get sessionIds() { return [...record.sessionIds].filter((sid) => hostRef.sessionPath(String(sid)) === record.path); },
    async status() { return existsSync(record.path) ? 'ok' : 'missing-dir'; },
    async mutate(fn) { Object.assign(record, fn(record)); },
    async setTitle(next) { record.title = String(next); },
    async attachSession(sid) {
      if (record.sessionIds.includes(sid)) return;
      record.sessionIds.unshift(sid);
      hostRef.onWorkspaceChanged?.(id, record);
    },
    async detachSession(sid) { record.sessionIds = record.sessionIds.filter((x) => x !== sid); }
  };
}

beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  root = realpathSync(makeRoot());
  A = join(root, 'proj-alpha');
  B = join(root, 'proj-beta');
  mkdirSync(A, { recursive: true });
  mkdirSync(B, { recursive: true });
  process.env.DSH_HOME = root;

  const sharedIndex = { headers: new Map(), sessionPaths: new Map(), invalidSessionPaths: new Map() };
  const hostRef = { ...sharedIndex, sessionPath: (id) => sharedIndex.sessionPaths.get(String(id)) };
  const entityA = makeEntity('wid-a', A, hostRef);
  const entityB = makeEntity('wid-b', B, hostRef);
  const registry = {
    ...sharedIndex,
    entities: new Map([['wid-a', entityA], ['wid-b', entityB]]),
    get(id) { return this.entities.get(id); },
    list() { return [...this.entities.values()]; }
  };
  const persistence = {
    root,
    async list() {
      const out = [];
      if (!existsSync(root)) return out;
      for (const proj of readdirSync(root)) {
        if (!(proj.startsWith('--') && proj.endsWith('--'))) continue;
        for (const idDir of readdirSync(join(root, proj))) {
          const dir = join(root, proj, idDir);
          const names = existsSync(dir) ? readdirSync(dir).filter((n) => n === 'session.jsonl.zstd' || /^session\.v[1-9][0-9]*\.jsonl\.zstd$/.test(n)) : [];
          if (!names.length) continue;
          try {
            const names2 = names.sort((a, b) => {
              const va = a === 'session.jsonl.zstd' ? 0 : Number(/^session\.v([0-9]+)/.exec(a)[1]);
              const vb = b === 'session.jsonl.zstd' ? 0 : Number(/^session\.v([0-9]+)/.exec(b)[1]);
              return vb - va;
            });
            out.push(JSON.parse(zstdDecompressSync(readFileSync(join(dir, names2[0]))).toString('utf8').split('\n')[0]));
          } catch { /* skip */ }
        }
      }
      return out;
    }
  };
  rpcHandler = null;
  ctx = {
    workspaceRegistry: registry,
    sessionPersistence: persistence,
    logger: { info() {}, warn() {} },
    get: () => undefined,
    connection: { rpc: { handle(_ch, h) { rpcHandler = h; return () => {}; } } }
  };
});

afterEach(() => {
  delete process.env.DSH_HOME;
  for (const k of ENV_KEYS) delete process.env[k];
  rmSync(root, { recursive: true, force: true });
});

async function call(endpoint, payload) {
  return await rpcHandler(endpoint, payload ?? {});
}

/** 建一个可迁移的会话（归属 A）。 */
function seedSession(id) {
  const p = artifactPath(root, A, id);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, makeArtifact({ type: 'session', id, cwd: A, title: id }));
  ctx.workspaceRegistry.sessionPaths.set(id, A);
  ctx.workspaceRegistry.get('wid-a').record.sessionIds.push(id);
  return id;
}

test('默认策略：单批上限 50（未设环境变量时第 51 个被拒）', async () => {
  apply(ctx);
  const sessions = Array.from({ length: 51 }, (_, i) => ({ sessionId: `s-${i}` }));
  const res = await call('mover.moveMany', { sessions, targetWorkspaceId: 'wid-b' });
  assert.equal(res.ok, false);
  assert.match(res.error.message, /max 50/);
});

test('DSH_WORKSPACE_MOVER_BATCH_LIMIT 收紧单批上限', async () => {
  process.env.DSH_WORKSPACE_MOVER_BATCH_LIMIT = '2';
  apply(ctx);
  const ok = await call('mover.moveMany', {
    sessions: [{ sessionId: seedSession('m-1') }, { sessionId: seedSession('m-2') }],
    targetWorkspaceId: 'wid-b'
  });
  assert.equal(ok.ok, true, JSON.stringify(ok));

  const tooMany = await call('mover.moveMany', {
    sessions: [{ sessionId: 'x-1' }, { sessionId: 'x-2' }, { sessionId: 'x-3' }],
    targetWorkspaceId: 'wid-b'
  });
  assert.equal(tooMany.ok, false);
  assert.match(tooMany.error.message, /max 2/, `应使用策略值 2: ${tooMany.error.message}`);
});

test('DSH_WORKSPACE_MOVER_BACKUP_KEEP 控制每会话备份保留份数', async () => {
  process.env.DSH_WORKSPACE_MOVER_BACKUP_KEEP = '3';
  apply(ctx);
  const dir = join(root, 'workspace-mover', 'backups');
  for (let i = 0; i < 6; i++) stashBackup('session-keep', Buffer.from(`v${i}`));
  const kept = readdirSync(dir).filter((f) => f.startsWith('session-keep.'));
  assert.equal(kept.length, 3, `策略值 3 应只保留 3 份，实际 ${kept.length}`);
});

test('非法环境变量回退默认值（配置错误不应让功能不可用）', async () => {
  for (const bad of ['0', '-5', 'abc', '999999']) {
    process.env.DSH_WORKSPACE_MOVER_BATCH_LIMIT = bad;
    apply(ctx);
    const res = await call('mover.moveMany', {
      sessions: Array.from({ length: 51 }, (_, i) => ({ sessionId: `s-${i}` })),
      targetWorkspaceId: 'wid-b'
    });
    assert.equal(res.ok, false, `bad=${bad} 应仍然拒绝超限批次`);
    assert.match(res.error.message, /max 50/, `bad=${bad} 应回退默认 50: ${res.error.message}`);
  }
});

test('mover.data.cleanup 在未传 days 时使用策略默认天数', async () => {
  process.env.DSH_WORKSPACE_MOVER_CLEANUP_DAYS = '1';
  apply(ctx);
  // dryRun 只统计：建一个"昨天之前"的回收站条目，策略 1 天内应被计入
  const entryDir = join(root, 'workspace-mover', 'recycle', 'old-entry');
  mkdirSync(join(entryDir, 'session'), { recursive: true });
  writeFileSync(join(entryDir, 'wsm-manifest.json'), JSON.stringify({
    version: 1, sessionId: 'session-old', deletedAt: new Date(Date.now() - 2 * 86400000).toISOString()
  }));
  const res = await call('mover.data.cleanup', { dryRun: true });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.value.recyclePurged, 1, '2 天前的条目在"1 天"策略下应被计入待清理');
});

//#region 守卫式 Config 接入（schemastery 由宿主 loader 提供，插件不主动 import）

test('Config 恒为 undefined：插件不静态 import schemastery（否则 boot 有风险）', () => {
  assert.equal(Config, undefined);
});

test('buildConfig：注入 schema 构造器后能构造出全部策略字段', () => {
  const calls = [];
  const makeNode = () => {
    const node = {
      step: (n) => { calls.push(['step', n]); return node; },
      min: (n) => { calls.push(['min', n]); return node; },
      max: (n) => { calls.push(['max', n]); return node; },
      default: (n) => { calls.push(['default', n]); return node; },
      // 故意不提供 volatile：部分版本没有该方法，必须能优雅退化
    };
    return node;
  };
  const z = {
    number: () => makeNode(),
    object: (shape) => ({ shape, kind: 'object' })
  };
  const schema = buildConfig(z);
  assert.ok(schema, '应构造出 schema');
  assert.equal(schema.kind, 'object');
  assert.deepEqual(Object.keys(schema.shape).sort(), POLICY_FIELDS.map((f) => f.key).sort());
  // 每个字段都必须被默认值 + 上下界约束过
  for (const { key, def, max } of POLICY_FIELDS) {
    assert.ok(schema.shape[key], `缺少字段 ${key}`);
    assert.ok(calls.some(([k, v]) => k === 'default' && v === def), `${key} 应设默认值 ${def}`);
    assert.ok(calls.some(([k, v]) => k === 'max' && v === max), `${key} 应设上限 ${max}`);
  }
});

test('buildConfig：构造器不可用时返回 undefined，绝不抛错', () => {
  assert.equal(buildConfig(undefined), undefined);
  assert.equal(buildConfig(null), undefined);
  assert.equal(buildConfig({}), undefined, '缺 z.object / z.number');
  assert.equal(buildConfig({ object: () => ({}), number: 'not-a-function' }), undefined);
  assert.equal(attachConfig(undefined), undefined);
  assert.equal(attachConfig({ default: {} }), undefined);
});

test('buildConfig：字段链式调用中途抛错时整体降级为 undefined', () => {
  const z = {
    number: () => ({ step() { throw new Error('boom'); } }),
    object: (shape) => ({ shape })
  };
  assert.equal(buildConfig(z), undefined, '构造失败必须降级而不是打断启动');
});

test('attachConfig 支持 { default: z } 形态的模块对象', () => {
  const node = { step: () => node, min: () => node, max: () => node, default: () => node };
  const z = { number: () => node, object: (shape) => ({ shape }) };
  const viaModule = attachConfig({ default: z });
  const viaDirect = attachConfig(z);
  assert.ok(viaModule && viaDirect);
  assert.deepEqual(Object.keys(viaModule.shape), Object.keys(viaDirect.shape));
});
//#endregion

