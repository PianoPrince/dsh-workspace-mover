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

/** 让出 5ms：备份名以毫秒时间戳排序，用例需要可预测的先后顺序。 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
  // 每次备份之间推进时钟：备份名以毫秒时间戳排序，同一毫秒在 Windows 上会互相覆盖
  //（这正是本用例最初在 Linux CI 上暴露的差异），显式等待让断言与平台无关。
  for (let i = 0; i < 6; i++) {
    stashBackup('session-keep', Buffer.from(`v${i}`));
    await sleep(5);
  }
  const kept = readdirSync(dir).filter((f) => f.startsWith('session-keep.'));
  assert.equal(kept.length, 3, `策略值 3 应只保留 3 份，实际 ${kept.length}`);
  // 保留的必须是**最新**的 3 份
  const newest = readFileSync(join(dir, kept.sort().at(-1))).toString();
  assert.equal(newest, 'v5', `保留的应是最新内容，实际 ${newest}`);
});

test('同一毫秒内的连续备份不得互相覆盖（Linux CI 暴露的差异回归）', async () => {
  apply(ctx);
  const dir = join(root, 'workspace-mover', 'backups');
  // 不推进时钟：模拟 Linux 上更粗的时钟粒度——两次 stash 极可能落在同一毫秒。
  for (let i = 0; i < 5; i++) stashBackup('session-ms', Buffer.from(`m${i}`));
  const files = readdirSync(dir).filter((f) => f.startsWith('session-ms.'));
  const contents = files.map((f) => readFileSync(join(dir, f)).toString());
  // 关键：每次备份都必须留下独立文件，而不是被后一次静默覆盖。
  // 旧实现在同一毫秒会塌缩成 1 份（Windows 时钟粒度粗，掩盖了这个问题；Linux CI 直接挂掉）。
  assert.equal(files.length, 5,
    `同毫秒的 5 次备份应留下 5 份，实际 ${files.length} 份：${JSON.stringify(files)}`);
  assert.deepEqual([...contents].sort(), ['m0', 'm1', 'm2', 'm3', 'm4'],
    `每份备份的内容都必须保留，实际：${JSON.stringify([...contents].sort())}`);
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

//#region peer 范围的预发布语义（曾导致宿主判定"与 0.2.0-rc.2 不兼容"）
//
// 这里自带一份最小 semver 判定，而不是 import dsh-market：CI 不安装它。
// 刻意复刻 npm 的预发布规则——**按 `||` 集合逐条判定**：带预发布标签的版本，只有在
// 某个集合中「存在一个比较符，其 major.minor.patch 与该版本完全相同**且自身也带
// 预发布标签**」时，才继续逐条比较；否则该集合直接不匹配。
// （dsh-market 的 lib/check.js → satisfiesRange 是同一实现，宿主判定用 includePrerelease。）

function parseSemver(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(v));
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ? m[4].split('.') : [] };
}
function comparePre(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i], y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn && yn) return Number(x) - Number(y) || 0;
    if (xn) return -1;
    if (yn) return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}
function cmp(a, b) {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  if (a.pre.length === 0 && b.pre.length === 0) return 0;
  if (a.pre.length === 0) return 1;
  if (b.pre.length === 0) return -1;
  return comparePre(a.pre, b.pre);
}
function parseComparator(part) {
  const m = /^(>=|<=|>|<|=)?\s*(.+)$/.exec(String(part).trim());
  if (!m) return null;
  const v = parseSemver(m[2]);
  return v ? { op: m[1] ?? '=', v } : null;
}
function satisfiesSet(version, parts, includePrerelease) {
  const v = parseSemver(version);
  if (!v) return null;
  const comps = parts.map(parseComparator);
  if (comps.some((c) => c === null)) return null;
  if (v.pre.length > 0 && !includePrerelease) {
    // 预发布准入（npm 默认）：集合里必须有一个比较符与该版本 tuple 相同且自带预发布
    const admits = comps.some((c) => c.v.major === v.major && c.v.minor === v.minor
      && c.v.patch === v.patch && c.v.pre.length > 0);
    if (!admits) return false;
  }
  for (const c of comps) {
    const d = cmp(v, c.v);
    if (c.op === '>' && !(d > 0)) return false;
    if (c.op === '>=' && !(d >= 0)) return false;
    if (c.op === '<' && !(d < 0)) return false;
    if (c.op === '<=' && !(d <= 0)) return false;
    if (c.op === '=' && d !== 0) return false;
  }
  return true;
}
/**
 * 宿主/发现路径**始终**以 includePrerelease=true 评估（DSH 的每条发布线本身都是预发布）。
 *
 * `*` 在此处按"匹配一切"处理，与 dsh-market 在它自己实际使用的模式（includePrerelease）
 * 下的结果一致。唯一的已知差异：该实现在默认模式下对预发布版本返回 false（它把 `*`
 * 交给比较符解析，于是预发布准入规则把它挡掉）。本插件只关心宿主真正使用的评估路径，
 * 因此这里不复制那个差异——但如实记录在此，避免以后被误读为"与宿主完全同构"。
 */
function satisfiesRange(version, range, includePrerelease = false) {
  if (String(range).trim() === '*') return true;
  return String(range).split('||')
    .some((alt) => satisfiesSet(version, alt.trim().split(/\s+/).filter(Boolean), includePrerelease));
}

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('peer 范围不与任何 DSH 版本判为不兼容（0.2.0-rc.2 事故回归）', () => {
  const HOST = /^@deepseek-ai\/dsh(?:-|$)/;
  const VERSIONS = ['0.1.5-rc.1', '0.1.5-rc.2', '0.1.6-alpha.2', '0.1.7-rc.1', '0.1.7-rc.2',
    '0.2.0-rc.1', '0.2.0-rc.2', '0.2.0', '0.3.0-rc.1', '1.0.0'];
  for (const v of VERSIONS) {
    const decls = [];
    const engine = satisfiesRange(v, pkg.engines.dsh, true);
    if (engine !== null) decls.push(['engines.dsh', engine]);
    for (const [name, range] of Object.entries(pkg.peerDependencies ?? {})) {
      if (!HOST.test(name)) continue; // 与 dsh-market 同一套过滤
      const r = satisfiesRange(v, range, true);
      if (r === null) continue;
      decls.push([name, r]);
    }
    assert.ok(!decls.some(([, r]) => r === false),
      `DSH ${v} 被判为不兼容：${JSON.stringify(decls.filter(([, r]) => r === false))}`);
  }
});

test('peer 范围不得使用 <X.Y.Z-0 这类会吃掉整条预发布线的上界', () => {
  // 锁定事故根因：0.2.0-rc.2 > 0.2.0-0，所以 <0.2.0-0 排除所有 0.2.0 预发布。
  assert.ok(cmp(parseSemver('0.2.0-rc.2'), parseSemver('0.2.0-0')) > 0,
    '-0 哨兵必须小于真实预发布——这正是上界失效的原因');
  // 关键：即使按宿主那套 includePrerelease 评估，旧写法仍然不匹配
  assert.equal(satisfiesRange('0.2.0-rc.2', '>=0.1.0-rc.1 <0.2.0-0', true), false,
    '旧写法在 includePrerelease 下也必须判为不匹配，否则本回归测试失效');
  assert.equal(satisfiesRange('0.2.0-rc.2', '>=0.0.1-rc.1 <0.1.0 || >=0.1.0-rc.1 <0.2.0-0', true), false,
    '这正是被宿主报为不兼容的那个范围');
  assert.equal(satisfiesRange('0.2.0-rc.2', '*', true), true, '现行写法必须匹配');

  for (const [name, range] of Object.entries(pkg.peerDependencies ?? {})) {
    assert.ok(!/<\d+\.\d+\.\d+-0/.test(range),
      `${name} 的范围 "${range}" 使用了 <X.Y.Z-0 上界，会排除整条预发布线`);
  }
});

test('engines.dsh 仍是真实下限：比下限更老的宿主必须判为不兼容', () => {
  // 宽松不等于没有下限——下限由 engines 承担，必须真的挡住更老的宿主。
  for (const older of ['0.1.4', '0.1.0', '0.0.9', '0.0.1']) {
    assert.equal(satisfiesRange(older, pkg.engines.dsh), false, `${older} 必须低于下限`);
  }
  // 下限本身必须成立。
  assert.equal(satisfiesRange('0.1.5-rc.1', pkg.engines.dsh), true);
  // 注意：npm 默认语义下，跨 tuple 的预发布（0.2.0-rc.2 vs >=0.1.5-rc.1）本来就**不**被
  // 接纳——这正是宿主在发现路径上显式传 includePrerelease 的原因。所以按宿主那套评估，
  // 真实的 0.2.0-rc.2 必须通过（见上一条用例的版本矩阵）。
  assert.equal(satisfiesRange('0.2.0-rc.2', pkg.engines.dsh, true), true,
    'includePrerelease（宿主用法）下 0.2.0-rc.2 必须满足下限');
});
//#endregion

