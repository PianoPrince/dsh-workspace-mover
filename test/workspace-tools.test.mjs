// Black-box integration + system tests for workspace create / rename:
//   agent tools  mover_create_workspace / mover_rename_workspace
//   RPC          mover.ws.create / mover.ws.rename (channel /workspace-mover)
//   doctor       check id `host-sandbox-policy`
//
// Every expected outcome is derived from the feature contract, NOT from lib/index.js.
// Techniques: Equivalence Partitioning + Boundary Value Analysis on `name` / `directory` /
// `workspaceId`, a Decision Table for the rename confirmation gate (sandbox mode x approval
// seam x agent presence x outcome), and State Transition sequences over the registry.
//
// The fake registry models the DSH 0.2.1 `ctx.workspaceRegistry` contract on purpose:
// create(path, title?) canonicalizes through fs.promises.realpath, rejects relative /
// missing / non-directory paths, and RETURNS THE EXISTING ENTITY (no throw, title untouched)
// for an already-owned canonical path — so "directory already in use" can only be detected by
// the plugin, never by a host error. Duplicate titles are allowed by the registry itself, so
// title uniqueness is entirely the plugin's rule.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, lstatSync, rmSync, realpathSync, symlinkSync } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname, basename, isAbsolute, parse } from 'node:path';
import { zstdCompressSync, constants as zlibConstants } from 'node:zlib';
import { apply, artifactPath, readHeader } from '../lib/index.js';

//#region test data
const TOOL = Object.freeze({
  LIST: 'mover_list_sessions',
  MOVE: 'mover_move_session',
  REPAIR: 'mover_repair_sessions',
  DOCTOR: 'mover_doctor',
  CREATE: 'mover_create_workspace',
  RENAME: 'mover_rename_workspace'
});
const RPC = Object.freeze({ CREATE: 'mover.ws.create', RENAME: 'mover.ws.rename', DOCTOR: 'mover.doctor' });
const RPC_CHANNEL = '/workspace-mover';
const CODE = Object.freeze({ INVALID: 'invalid-input', NOT_FOUND: 'not-found', CONFLICT: 'conflict' });
const MODE = Object.freeze({ FULL: 'danger-full-access', WRITE: 'workspace-write', READ: 'read-only' });
/** Non-mode sandboxPolicy shapes (a plain MODE string means "service present, resolve returns that mode"). */
const SANDBOX = Object.freeze({ ABSENT: 'absent', NO_RESOLVE: 'no-resolve', THROWS: 'throws', EMPTY_RESULT: 'empty-result' });
const OUTCOME = Object.freeze({ ALLOWED: 'allowed-once', REJECTED: 'rejected', CANCELLED: 'cancelled', UNAVAILABLE: 'unavailable' });
/** Non-outcome approval seam shapes (a plain OUTCOME string means "request resolves to that outcome"). */
const APPROVAL = Object.freeze({ ABSENT: 'absent', NO_REQUEST: 'no-request', THROWS: 'throws' });
const DOCTOR_CHECK_ID = 'host-sandbox-policy';
const CHECK_STATE = Object.freeze({ PASS: 'pass', WARN: 'warn' });
const WS = Object.freeze({ A: { id: 'wid-a', title: 'Alpha' }, B: { id: 'wid-b', title: 'Beta' } });
const NEW_TITLE = 'Gamma';
const SECOND_NEW_TITLE = 'Delta';
const SESSION_ID = 'session-aaa';
const CALLER_SESSION = { id: 'session-caller' };
const OTHER_SESSION = { id: 'session-other' };
const ZSTD_OPTS = { params: { [zlibConstants.ZSTD_c_checksumFlag]: 1 } };
const ARTIFACT_NAME = /^session(?:\.v[1-9][0-9]*)?\.jsonl\.zstd$/;
/** Root of the temp volume: '/' on POSIX, e.g. 'C:\' on Windows (a bare '/' is not fully qualified there). */
const FS_ROOT = parse(tmpdir()).root;
/**
 * Directory-link types to try, in order. Unprivileged Windows refuses 'dir' symlinks with EPERM, while
 * junctions need no privilege and resolve the same way through native realpath; POSIX ignores the type.
 */
const SYMLINK_TYPES = process.platform === 'win32' ? ['dir', 'junction'] : ['dir'];
const SYMLINK_FALLBACK_CODE = 'EPERM';
/**
 * Teardown: Windows can transiently refuse to delete fresh temp entries (EBUSY / EPERM / ENOTEMPTY while another
 * process such as antivirus still holds a handle); retry instead of failing an otherwise passing test.
 */
const RM_TREE_OPTS = Object.freeze({ recursive: true, force: true, maxRetries: 3 });
//#endregion

//#region fake host
const hosts = [];

afterEach(() => {
  for (const host of hosts.splice(0)) host.dispose();
});

function makeEntity(id, path, title, spies) {
  const now = new Date().toISOString();
  const record = { path, title, sessionIds: [], createdAt: now, updatedAt: now };
  return {
    id,
    get path() { return record.path; },
    get title() { return record.title; },
    get sessionIds() { return [...record.sessionIds]; },
    get record() { return record; },
    async status() {
      try { return (await stat(record.path)).isDirectory() ? 'ok' : 'missing-dir'; } catch { return 'missing-dir'; }
    },
    async setTitle(next) {
      spies.setTitle.push({ id, title: next });
      record.title = next;
      record.updatedAt = new Date().toISOString();
    },
    async mutate(fn) {
      spies.mutate.push(id);
      Object.assign(record, fn(record), { updatedAt: new Date().toISOString() });
    },
    async attachSession(sid) { if (!record.sessionIds.includes(sid)) record.sessionIds.unshift(sid); },
    async detachSession(sid) { record.sessionIds = record.sessionIds.filter((x) => x !== sid); }
  };
}

function makeRegistry(spies) {
  const order = [];
  return {
    headers: new Map(),
    sessionPaths: new Map(),
    invalidSessionPaths: new Map(),
    list() { return [...order]; },
    get(id) { return order.find((entity) => entity.id === id); },
    async create(path, title) {
      spies.create.push({ path, title });
      if (typeof path !== 'string' || !isAbsolute(path)) throw new TypeError(`Workspace path is not fully qualified: '${path}'`);
      const canonical = await realpath(path); // ENOENT propagates, like the host
      if (!(await stat(canonical)).isDirectory()) throw new Error(`cannot create a workspace at '${canonical}': path is not a directory`);
      const existing = order.find((entity) => entity.path === canonical);
      if (existing) return existing;
      const entity = makeEntity(randomUUID(), canonical, title ?? basename(canonical), spies);
      order.unshift(entity);
      return entity;
    },
    /** Test-only: append a pre-existing workspace. */
    seed(entity) { order.push(entity); return entity; }
  };
}

function makeSandboxPolicy(kind, calls) {
  if (kind === SANDBOX.ABSENT) return undefined;
  if (kind === SANDBOX.NO_RESOLVE) return {};
  return {
    resolve(request) {
      calls.push(request);
      if (kind === SANDBOX.THROWS) throw new Error('simulated sandbox policy failure');
      if (kind === SANDBOX.EMPTY_RESULT) return undefined;
      if (typeof kind === 'function') return { mode: kind(request), root: FS_ROOT };
      return { mode: kind, root: FS_ROOT };
    }
  };
}

function makeApproval(kind, calls, probe) {
  if (kind === APPROVAL.ABSENT) return undefined;
  if (kind === APPROVAL.NO_REQUEST) return {};
  return {
    async request(req) {
      calls.push({ req, ...probe() });
      if (kind === APPROVAL.THROWS) throw new Error('simulated approval seam failure');
      return typeof kind === 'function' ? kind(req) : kind;
    }
  };
}

function makePersistence(storeRoot) {
  return {
    root: storeRoot,
    compression: 'zstd',
    async list() {
      const headers = [];
      if (!existsSync(storeRoot)) return headers;
      for (const project of readdirSync(storeRoot)) {
        const projectDir = join(storeRoot, project);
        if (!lstatSync(projectDir).isDirectory()) continue;
        for (const sessionDirName of readdirSync(projectDir)) {
          const dir = join(projectDir, sessionDirName);
          const name = readdirSync(dir).filter((n) => ARTIFACT_NAME.test(n)).sort().at(-1);
          if (name) headers.push(readHeader(readFileSync(join(dir, name))));
        }
      }
      return headers;
    }
  };
}

function makeArtifact(header) {
  const head = zstdCompressSync(Buffer.from(JSON.stringify(header) + '\n', 'utf8'), ZSTD_OPTS);
  const event = zstdCompressSync(Buffer.from(JSON.stringify({ seq: 1, text: 'hello' }) + '\n', 'utf8'), ZSTD_OPTS);
  return Buffer.concat([head, event]);
}

/** Recursive, content-bearing listing: proves "no folder or file was created/changed". */
function snapshotTree(dir) {
  const out = [];
  const walk = (current, rel) => {
    for (const name of readdirSync(current).sort()) {
      const full = join(current, name);
      const relName = rel ? `${rel}/${name}` : name;
      if (lstatSync(full).isDirectory()) {
        out.push(`${relName}/`);
        walk(full, relName);
      } else {
        out.push(`${relName}:${readFileSync(full).toString('base64')}`);
      }
    }
  };
  walk(dir, '');
  return out;
}

/**
 * Mount the plugin on a fresh fake host with real temp folders.
 * Layout: <root>/fx/{alpha(=A, has notes.txt + sub/), beta(=B), free, free2, plain.txt},
 * <root>/links (symlinks), <root>/home (DSH_HOME), <root>/store (session persistence).
 * Workspace A owns one real session archive so "sessions untouched" is observable.
 */
function mountHost({ sandbox = MODE.WRITE, approval = OUTCOME.ALLOWED, tools = true } = {}) {
  // Native realpath, matching the registry's fs.promises.realpath: the JS realpathSync keeps Windows 8.3
  // short names (C:\Users\RUNNER~1\...) and caller letter case, so every expected path would then differ
  // from the stored canonical one. Children joined below are created with exact case, so they stay canonical.
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'wsm-wstools-')));
  const fx = join(root, 'fx');
  const paths = {
    root,
    fx,
    A: join(fx, 'alpha'),
    B: join(fx, 'beta'),
    sub: join(fx, 'alpha', 'sub'),
    free: join(fx, 'free'),
    free2: join(fx, 'free2'),
    file: join(fx, 'plain.txt'),
    links: join(root, 'links'),
    home: join(root, 'home'),
    store: join(root, 'store')
  };
  for (const dir of [paths.A, paths.B, paths.sub, paths.free, paths.free2, paths.links, paths.home, paths.store]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(paths.A, 'notes.txt'), 'alpha notes');
  writeFileSync(paths.file, 'plain file');
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = paths.home;

  const spies = { setTitle: [], mutate: [], create: [], approval: [], resolve: [] };
  const registry = makeRegistry(spies);
  const entityA = registry.seed(makeEntity(WS.A.id, paths.A, WS.A.title, spies));
  const entityB = registry.seed(makeEntity(WS.B.id, paths.B, WS.B.title, spies));

  const sessionArtifact = artifactPath(paths.store, paths.A, SESSION_ID);
  mkdirSync(dirname(sessionArtifact), { recursive: true });
  const sessionHeader = { type: 'session', id: SESSION_ID, cwd: paths.A, title: 'Alpha discussion' };
  writeFileSync(sessionArtifact, makeArtifact(sessionHeader));
  entityA.record.sessionIds.push(SESSION_ID);
  registry.headers.set(SESSION_ID, sessionHeader);
  registry.sessionPaths.set(SESSION_ID, paths.A);

  const sandboxPolicy = makeSandboxPolicy(sandbox, spies.resolve);
  const registered = [];
  const cleanups = [];
  const handlers = new Map();
  const ctx = {
    workspaceRegistry: registry,
    sessionPersistence: makePersistence(paths.store),
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    get: (key) => (key === 'sandboxPolicy' ? sandboxPolicy : undefined),
    effect(register) {
      const cleanup = register();
      if (typeof cleanup === 'function') cleanups.push(cleanup);
    },
    connection: { rpc: { handle(channel, handler) { handlers.set(channel, handler); return () => {}; } } }
  };
  if (tools) ctx.tools = { register: (def) => { registered.push(def); return () => {}; } };
  const approvalService = makeApproval(approval, spies.approval, () => ({
    setTitleCountAtRequest: spies.setTitle.length,
    titleAtRequest: entityA.title
  }));
  if (approvalService !== undefined) ctx.approval = approvalService;

  apply(ctx);

  const host = {
    ctx,
    paths,
    spies,
    registry,
    entityA,
    entityB,
    registered,
    sessionArtifact,
    sessionBytes: readFileSync(sessionArtifact),
    tool(name) {
      const def = registered.find((d) => d.name === name);
      assert.ok(def, `tool ${name} is not registered (registered: ${registered.map((d) => d.name).join(', ')})`);
      return def;
    },
    /** Tool lookup is synchronous so a missing tool fails loudly instead of masquerading as a rejection. */
    runTool(name, args, exec = makeExec()) {
      const def = host.tool(name);
      return Promise.resolve().then(() => def.execute(args, exec));
    },
    async rpc(endpoint, payload) {
      const dispatch = handlers.get(RPC_CHANNEL);
      assert.equal(typeof dispatch, 'function', `RPC channel ${RPC_CHANNEL} not handled`);
      return await dispatch(endpoint, payload ?? {});
    },
    snapshot() {
      return registry.list().map((e) => ({ id: e.id, path: e.path, title: e.title, sessionIds: [...e.sessionIds] }));
    },
    fxTree() { return snapshotTree(fx); },
    dispose() {
      for (const cleanup of cleanups) { try { cleanup(); } catch { /* best effort */ } }
      if (previousHome === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = previousHome;
      rmSync(root, RM_TREE_OPTS);
    }
  };
  hosts.push(host);
  return host;
}

function makeExec({ agent = true } = {}) {
  const signal = new AbortController().signal;
  const callId = `call-${randomUUID()}`;
  return agent ? { agent: { id: 'agent-caller', session: CALLER_SESSION }, signal, callId } : { signal, callId };
}

const outcomeOf = (value) => () => value;
//#endregion

//#region assertions
async function expectToolCode(promise, code) {
  let caught;
  await assert.rejects(promise, (err) => { caught = err; return true; });
  assert.ok(caught instanceof Error, `expected an Error, got ${String(caught)}`);
  assert.equal(caught.code, code, `error.code (message: ${caught.message})`);
  assert.ok(String(caught.message).startsWith(`[${code}] `), `message should start with "[${code}] ": ${caught.message}`);
  return caught;
}

async function expectToolCodeIn(promise, codes) {
  let caught;
  await assert.rejects(promise, (err) => { caught = err; return true; });
  assert.ok(caught instanceof Error, `expected an Error, got ${String(caught)}`);
  assert.ok(codes.includes(caught.code), `error.code ${caught.code} not in ${codes.join('|')} (message: ${caught.message})`);
  return caught;
}

function expectRpcCode(res, code) {
  assert.equal(res?.ok, false, `expected failure ${code}, got ${JSON.stringify(res)}`);
  assert.equal(res.error?.code, code, JSON.stringify(res));
  assert.equal(typeof res.error.message, 'string');
}

function expectRpcOk(res) {
  assert.equal(res?.ok, true, `expected ok, got ${JSON.stringify(res)}`);
  return res.value;
}

/** Registry, titles, sessions, and fixture folders exactly as before; nothing retitled. */
function assertNothingChanged(host, before, tree) {
  assert.deepEqual(host.snapshot(), before, 'registry state unchanged');
  assert.deepEqual(host.spies.setTitle, [], 'setTitle never called');
  assert.deepEqual(host.fxTree(), tree, 'no folder or file created/changed on disk');
}

/** Exactly one new workspace with the canonical path and the trimmed title. */
function assertCreated(host, before, value, { path, title }) {
  const after = host.snapshot();
  assert.equal(after.length, before.length + 1, 'registry gained exactly one workspace');
  const added = after.filter((w) => !before.some((b) => b.id === w.id));
  assert.equal(added.length, 1, 'exactly one new id');
  assert.equal(added[0].path, path, 'stored path is the canonical directory');
  assert.equal(added[0].title, title, 'stored title is the trimmed name');
  for (const old of before) assert.deepEqual(after.find((w) => w.id === old.id), old, `existing workspace ${old.id} untouched`);
  assert.equal(typeof value, 'object');
  assert.equal(value.workspaceId, added[0].id, 'result.workspaceId');
  assert.equal(value.title, title, 'result.title');
  assert.equal(value.path, path, 'result.path');
}

/** Workspace A renamed to `title`; folder, sessions and the other workspace untouched. */
function assertRenamedA(host, value, tree, title) {
  assert.equal(value.workspaceId, WS.A.id);
  assert.equal(value.path, host.paths.A);
  assert.equal(value.previousTitle, WS.A.title);
  assert.equal(value.title, title);
  assert.equal(value.changed, true);
  assert.equal(host.entityA.title, title, 'registry title changed');
  assert.deepEqual(host.spies.setTitle, [{ id: WS.A.id, title }], 'setTitle(trimmedName) called exactly once');
  assert.equal(host.entityA.path, host.paths.A, 'folder path untouched');
  assert.deepEqual(host.entityA.sessionIds, [SESSION_ID], 'sessions untouched');
  assert.equal(host.entityB.title, WS.B.title, 'other workspace untouched');
  assert.equal(host.registry.list().length, 2, 'no workspace added/removed');
  assert.deepEqual(host.fxTree(), tree, 'folder contents untouched');
  assert.deepEqual(readFileSync(host.sessionArtifact), host.sessionBytes, 'session archive bytes untouched');
}

function assertRenameNotApplied(host, tree) {
  assert.equal(host.entityA.title, WS.A.title, 'title unchanged');
  assert.deepEqual(host.spies.setTitle, [], 'setTitle never called');
  assert.equal(host.entityB.title, WS.B.title);
  assert.deepEqual(host.fxTree(), tree);
}

function trySymlink(t, target, linkPath) {
  let lastErr;
  for (const type of SYMLINK_TYPES) {
    try {
      symlinkSync(target, linkPath, type);
      return true;
    } catch (err) {
      lastErr = err;
      if (err.code !== SYMLINK_FALLBACK_CODE) break;
    }
  }
  t.skip(`symlinks unavailable here: ${lastErr.code}`);
  return false;
}
//#endregion

//#region registration (system)
test('system: apply registers create + rename next to the four existing tools, with JSON-schema required args', () => {
  const host = mountHost();
  const names = host.registered.map((d) => d.name);
  for (const name of Object.values(TOOL)) assert.ok(names.includes(name), `missing ${name} in ${names.join(', ')}`);
  assert.equal(new Set(names).size, names.length, 'tool names are unique');
  const create = host.tool(TOOL.CREATE);
  const rename = host.tool(TOOL.RENAME);
  assert.deepEqual([...create.parameters.required].sort(), ['directory', 'name']);
  assert.deepEqual([...rename.parameters.required].sort(), ['name', 'workspaceId']);
  assert.ok(create.parameters.properties?.name && create.parameters.properties?.directory, 'create schema declares name + directory');
  assert.ok(rename.parameters.properties?.workspaceId && rename.parameters.properties?.name, 'rename schema declares workspaceId + name');
  for (const def of [create, rename]) {
    assert.equal(def.parameters.type, 'object', `${def.name}.parameters.type`);
    assert.equal(typeof def.description, 'string');
    assert.ok(def.description.trim().length > 0, `${def.name}.description non-empty`);
    assert.equal(typeof def.execute, 'function', `${def.name}.execute`);
    assert.equal(typeof def.output?.render, 'function', `${def.name}.output.render`);
    assert.equal(typeof def.output?.schema, 'object', `${def.name}.output.schema`);
  }
});
//#endregion

//#region mover_create_workspace — name (EP / BVA)
const INVALID_NAMES = [
  { label: 'missing', omit: true },
  { label: 'non-string number', value: 42 },
  { label: 'null', value: null },
  { label: 'empty string (length 0)', value: '' },
  { label: 'single space (trims to length 0)', value: ' ' },
  { label: 'tabs/newlines only', value: ' \t\n ' }
];
for (const c of INVALID_NAMES) {
  test(`create tool EP name ${c.label} -> invalid-input, registry and disk unchanged`, async () => {
    const host = mountHost();
    const before = host.snapshot();
    const tree = host.fxTree();
    const args = { directory: host.paths.free };
    if (!c.omit) args.name = c.value;
    await expectToolCode(host.runTool(TOOL.CREATE, args), CODE.INVALID);
    assertNothingChanged(host, before, tree);
  });
}

const VALID_NAMES = [
  { label: 'BVA single character', value: 'x', title: 'x' },
  { label: 'BVA single character padded by spaces', value: ' x ', title: 'x' },
  { label: 'surrounding whitespace is trimmed, inner kept', value: '  New Workspace\t', title: 'New Workspace' },
  { label: 'case differs from existing "Alpha" (exact match only)', value: 'alpha', title: 'alpha' },
  { label: 'prefix of existing "Alpha" is a different name', value: 'Alph', title: 'Alph' }
];
for (const c of VALID_NAMES) {
  test(`create tool EP/BVA name ${c.label} -> created with title "${c.title}"`, async () => {
    const host = mountHost();
    const before = host.snapshot();
    const value = await host.runTool(TOOL.CREATE, { name: c.value, directory: host.paths.free });
    assertCreated(host, before, value, { path: host.paths.free, title: c.title });
  });
}

for (const name of [WS.A.title, `  ${WS.B.title}  `, `\t${WS.A.title}\n`]) {
  test(`create tool name ${JSON.stringify(name)} equals an existing title after trim -> conflict, registry unchanged`, async () => {
    const host = mountHost();
    const before = host.snapshot();
    const tree = host.fxTree();
    await expectToolCode(host.runTool(TOOL.CREATE, { name, directory: host.paths.free }), CODE.CONFLICT);
    assertNothingChanged(host, before, tree);
  });
}
//#endregion

//#region mover_create_workspace — directory (EP / BVA)
const INVALID_DIRECTORIES = [
  { label: 'relative bare name', dir: () => 'free', code: CODE.INVALID },
  { label: 'relative ./ path', dir: () => './fx/free', code: CODE.INVALID },
  { label: 'empty string', dir: () => '', code: CODE.INVALID },
  { label: 'missing argument', omit: true, code: CODE.INVALID },
  { label: 'non-string number', dir: () => 42, code: CODE.INVALID },
  { label: 'absolute path to a regular file', dir: (p) => p.file, code: CODE.INVALID },
  { label: 'absolute nonexistent leaf', dir: (p) => join(p.fx, 'missing'), code: CODE.NOT_FOUND },
  { label: 'absolute nonexistent nested path', dir: (p) => join(p.fx, 'missing', 'deeper'), code: CODE.NOT_FOUND }
];
for (const c of INVALID_DIRECTORIES) {
  test(`create tool EP directory ${c.label} -> ${c.code}; nothing created on disk`, async () => {
    const host = mountHost();
    const before = host.snapshot();
    const tree = host.fxTree();
    const args = { name: NEW_TITLE };
    if (!c.omit) args.directory = c.dir(host.paths);
    await expectToolCode(host.runTool(TOOL.CREATE, args), c.code);
    assertNothingChanged(host, before, tree);
    assert.equal(existsSync(join(host.paths.fx, 'missing')), false, 'tool never creates the missing folder');
  });
}

const SAME_FOLDER_SPELLINGS = [
  { label: 'exact canonical path', dir: (p) => p.A },
  { label: 'trailing slash', dir: (p) => `${p.A}/` },
  { label: 'trailing /. segment', dir: (p) => `${p.A}/.` },
  { label: '.. segment through a sibling', dir: (p) => `${p.B}/../alpha` },
  { label: '.. segment through its own sub-folder', dir: (p) => `${p.sub}/..` },
  { label: 'symlink to the workspace folder', link: true }
];
for (const c of SAME_FOLDER_SPELLINGS) {
  test(`create tool directory already used (${c.label}) -> conflict; no new workspace, existing title untouched`, async (t) => {
    const host = mountHost();
    let directory;
    if (c.link) {
      directory = join(host.paths.links, 'to-alpha');
      if (!trySymlink(t, host.paths.A, directory)) return;
    } else {
      directory = c.dir(host.paths);
    }
    const before = host.snapshot();
    const tree = host.fxTree();
    await expectToolCode(host.runTool(TOOL.CREATE, { name: NEW_TITLE, directory }), CODE.CONFLICT);
    assertNothingChanged(host, before, tree);
    assert.equal(host.entityA.title, WS.A.title, 'owner of the folder keeps its title');
  });
}

// BVA on folder identity: "same folder" is the host registry's canonical identity (native realpath), so the
// A path with its last segment upper-cased IS folder A on a case-insensitive filesystem (APFS / NTFS defaults)
// and simply does not exist on a case-sensitive one (Linux), where it is an absolute nonexistent path.
test('create tool BVA case-variant spelling of an existing workspace folder -> conflict if case-insensitive, not-found if case-sensitive', async (t) => {
  const host = mountHost();
  const { A } = host.paths;
  const directory = join(dirname(A), basename(A).toUpperCase());
  const exists = existsSync(directory);
  if (exists && realpathSync.native(directory) !== realpathSync.native(A)) {
    t.skip('the upper-cased spelling exists but native realpath does not identify it with folder A');
    return;
  }
  const before = host.snapshot();
  const tree = host.fxTree();
  await expectToolCode(host.runTool(TOOL.CREATE, { name: NEW_TITLE, directory }), exists ? CODE.CONFLICT : CODE.NOT_FOUND);
  assertNothingChanged(host, before, tree);
  assert.equal(host.entityA.title, WS.A.title, 'owner of the folder keeps its title');
});

const DIFFERENT_FOLDERS = [
  { label: 'sub-folder of an existing workspace', dir: (p) => p.sub, canonical: (p) => p.sub },
  { label: 'parent folder of existing workspaces', dir: (p) => p.fx, canonical: (p) => p.fx },
  { label: 'unused sibling folder', dir: (p) => p.free, canonical: (p) => p.free },
  { label: 'unused folder with trailing slash', dir: (p) => `${p.free}/`, canonical: (p) => p.free },
  { label: 'unused folder via .. segment', dir: (p) => `${p.A}/../free`, canonical: (p) => p.free },
  { label: 'symlink to an unused folder', link: true, canonical: (p) => p.free }
];
for (const c of DIFFERENT_FOLDERS) {
  test(`create tool different folder (${c.label}) -> created at the canonical path`, async (t) => {
    const host = mountHost();
    let directory;
    if (c.link) {
      directory = join(host.paths.links, 'to-free');
      if (!trySymlink(t, host.paths.free, directory)) return;
    } else {
      directory = c.dir(host.paths);
    }
    const before = host.snapshot();
    const tree = host.fxTree();
    const value = await host.runTool(TOOL.CREATE, { name: `  ${NEW_TITLE} `, directory });
    assertCreated(host, before, value, { path: c.canonical(host.paths), title: NEW_TITLE });
    assert.deepEqual(host.fxTree(), tree, 'create never writes into the folder');
  });
}

test('create tool when both name and directory collide -> conflict, registry unchanged', async () => {
  const host = mountHost();
  const before = host.snapshot();
  const tree = host.fxTree();
  await expectToolCode(host.runTool(TOOL.CREATE, { name: WS.B.title, directory: host.paths.A }), CODE.CONFLICT);
  assertNothingChanged(host, before, tree);
});

test('create tool with invalid name AND nonexistent directory is rejected (either input code), registry unchanged', async () => {
  const host = mountHost();
  const before = host.snapshot();
  const tree = host.fxTree();
  await expectToolCodeIn(host.runTool(TOOL.CREATE, { name: '   ', directory: join(host.paths.fx, 'missing') }), [CODE.INVALID, CODE.NOT_FOUND]);
  assertNothingChanged(host, before, tree);
});

// Decision: create is never approval-gated, whatever the sandbox mode, even if the seam would refuse.
for (const sandbox of [MODE.READ, MODE.WRITE, MODE.FULL, SANDBOX.ABSENT]) {
  test(`create tool never asks for approval (sandbox ${sandbox}, seam would reject)`, async () => {
    const host = mountHost({ sandbox, approval: OUTCOME.REJECTED });
    const before = host.snapshot();
    const value = await host.runTool(TOOL.CREATE, { name: NEW_TITLE, directory: host.paths.free });
    assertCreated(host, before, value, { path: host.paths.free, title: NEW_TITLE });
    assert.equal(host.spies.approval.length, 0, 'approval.request not called');
  });
}

test('state transition (create): S0 -> create -> S1; reused folder / reused name rejected in S1; distinct -> S2', async () => {
  const host = mountHost();
  const s0 = host.snapshot();
  const first = await host.runTool(TOOL.CREATE, { name: NEW_TITLE, directory: host.paths.free });
  assertCreated(host, s0, first, { path: host.paths.free, title: NEW_TITLE });
  const s1 = host.snapshot();
  const tree = host.fxTree();

  // folder now owned by the freshly created workspace
  await expectToolCode(host.runTool(TOOL.CREATE, { name: SECOND_NEW_TITLE, directory: `${host.paths.free}/` }), CODE.CONFLICT);
  assertNothingChanged(host, s1, tree);
  assert.equal(host.registry.get(first.workspaceId).title, NEW_TITLE, 'new owner keeps its title');

  // title now taken by the freshly created workspace
  await expectToolCode(host.runTool(TOOL.CREATE, { name: ` ${NEW_TITLE} `, directory: host.paths.free2 }), CODE.CONFLICT);
  assertNothingChanged(host, s1, tree);

  const second = await host.runTool(TOOL.CREATE, { name: SECOND_NEW_TITLE, directory: host.paths.free2 });
  assertCreated(host, s1, second, { path: host.paths.free2, title: SECOND_NEW_TITLE });
  assert.equal(host.registry.list().length, 4);
});
//#endregion

//#region mover_rename_workspace — validation before approval (EP / BVA)
const RENAME_VALIDATION = [
  { label: 'unknown workspaceId', args: { workspaceId: 'wid-nope', name: NEW_TITLE }, code: CODE.NOT_FOUND },
  { label: 'empty workspaceId', args: { workspaceId: '', name: NEW_TITLE }, code: CODE.INVALID },
  { label: 'missing workspaceId', args: { name: NEW_TITLE }, code: CODE.INVALID },
  { label: 'empty name', args: { workspaceId: WS.A.id, name: '' }, code: CODE.INVALID },
  { label: 'whitespace-only name', args: { workspaceId: WS.A.id, name: ' \t ' }, code: CODE.INVALID },
  { label: 'missing name', args: { workspaceId: WS.A.id }, code: CODE.INVALID },
  { label: 'name equals another workspace title', args: { workspaceId: WS.A.id, name: WS.B.title }, code: CODE.CONFLICT },
  { label: 'name equals another workspace title after trim', args: { workspaceId: WS.A.id, name: `  ${WS.B.title}\n` }, code: CODE.CONFLICT },
  { label: 'unknown workspaceId with blank name', args: { workspaceId: 'wid-nope', name: '  ' }, codes: [CODE.NOT_FOUND, CODE.INVALID] },
  { label: 'non-string workspaceId', args: { workspaceId: 42, name: NEW_TITLE }, codes: [CODE.INVALID, CODE.NOT_FOUND] },
  { label: 'non-string name', args: { workspaceId: WS.A.id, name: 42 }, codes: [CODE.INVALID] }
];
for (const c of RENAME_VALIDATION) {
  test(`rename tool ${c.label} -> ${c.code ?? c.codes.join('|')} before any approval prompt`, async () => {
    const host = mountHost({ sandbox: MODE.WRITE, approval: OUTCOME.ALLOWED });
    const before = host.snapshot();
    const tree = host.fxTree();
    const call = host.runTool(TOOL.RENAME, c.args);
    if (c.code) await expectToolCode(call, c.code);
    else await expectToolCodeIn(call, c.codes);
    assert.equal(host.spies.approval.length, 0, 'approval must not be requested for invalid input');
    assertNothingChanged(host, before, tree);
  });
}

for (const name of [WS.A.title, `  ${WS.A.title}  `, `\t${WS.A.title}\n`]) {
  test(`rename tool to current title ${JSON.stringify(name)} -> no-op: changed false, no prompt, setTitle not called`, async () => {
    const host = mountHost({ sandbox: MODE.WRITE, approval: OUTCOME.REJECTED });
    const before = host.snapshot();
    const tree = host.fxTree();
    const value = await host.runTool(TOOL.RENAME, { workspaceId: WS.A.id, name });
    assert.equal(value.changed, false);
    assert.equal(value.workspaceId, WS.A.id);
    assert.equal(host.spies.approval.length, 0, 'no approval for a no-op');
    assertNothingChanged(host, before, tree);
  });
}

// BVA on "exactly equals": a case-only difference is neither a no-op nor a conflict.
for (const c of [
  { label: 'own title in another case is a real rename', name: 'alpha' },
  { label: 'other workspace title in another case is not a conflict', name: 'beta' }
]) {
  test(`rename tool ${c.label} -> renamed after one approval`, async () => {
    const host = mountHost({ sandbox: MODE.WRITE, approval: OUTCOME.ALLOWED });
    const tree = host.fxTree();
    const value = await host.runTool(TOOL.RENAME, { workspaceId: WS.A.id, name: c.name });
    assert.equal(host.spies.approval.length, 1);
    assertRenamedA(host, value, tree, c.name);
  });
}
//#endregion

//#region mover_rename_workspace — confirmation decision table
// Columns: sandbox (service / mode) | approval seam | exec.agent | -> prompts | result.
// Rename A "Alpha" -> "  Gamma  " (trimmed "Gamma") in every rule.
const callerOnlyFullAccess = (req) => (req?.session === CALLER_SESSION ? MODE.FULL : MODE.WRITE);
const otherOnlyFullAccess = (req) => (req?.session === OTHER_SESSION ? MODE.FULL : MODE.WRITE);
const RENAME_DECISIONS = [
  { id: 'D01', sandbox: MODE.FULL, approval: OUTCOME.ALLOWED, prompts: 0, renamed: true, why: 'full access renames without approval' },
  { id: 'D02', sandbox: MODE.FULL, approval: OUTCOME.REJECTED, prompts: 0, renamed: true, why: 'full access never consults a refusing seam' },
  { id: 'D03', sandbox: MODE.FULL, approval: APPROVAL.ABSENT, prompts: 0, renamed: true, why: 'full access, no seam' },
  { id: 'D04', sandbox: callerOnlyFullAccess, approval: OUTCOME.REJECTED, prompts: 0, renamed: true, checkSession: true, why: 'policy resolved for the CALLING session grants full access' },
  { id: 'D05', sandbox: otherOnlyFullAccess, approval: OUTCOME.ALLOWED, prompts: 1, renamed: true, checkSession: true, why: 'full access of another session does not count' },
  { id: 'D06', sandbox: MODE.WRITE, approval: OUTCOME.ALLOWED, prompts: 1, renamed: true, why: 'workspace-write + allowed-once' },
  { id: 'D07', sandbox: MODE.READ, approval: OUTCOME.ALLOWED, prompts: 1, renamed: true, why: 'read-only + allowed-once' },
  { id: 'D08', sandbox: SANDBOX.ABSENT, approval: OUTCOME.ALLOWED, prompts: 1, renamed: true, why: 'no sandboxPolicy service + allowed-once' },
  { id: 'D09', sandbox: SANDBOX.THROWS, approval: OUTCOME.ALLOWED, prompts: 1, renamed: true, why: 'resolve throws + allowed-once' },
  { id: 'D10', sandbox: SANDBOX.NO_RESOLVE, approval: OUTCOME.ALLOWED, prompts: 1, renamed: true, why: 'service without resolve + allowed-once' },
  { id: 'D11', sandbox: SANDBOX.EMPTY_RESULT, approval: OUTCOME.ALLOWED, prompts: 1, renamed: true, why: 'resolve returns nothing + allowed-once' },
  { id: 'D12', sandbox: () => 'DANGER-FULL-ACCESS', approval: OUTCOME.ALLOWED, prompts: 1, renamed: true, why: 'BVA: mode must equal "danger-full-access" exactly' },
  { id: 'D13', sandbox: MODE.WRITE, approval: OUTCOME.REJECTED, prompts: 1, renamed: false, why: 'rejected' },
  { id: 'D14', sandbox: MODE.WRITE, approval: OUTCOME.CANCELLED, prompts: 1, renamed: false, why: 'cancelled' },
  { id: 'D15', sandbox: MODE.WRITE, approval: OUTCOME.UNAVAILABLE, prompts: 1, renamed: false, why: 'unavailable' },
  { id: 'D16', sandbox: MODE.WRITE, approval: outcomeOf('denied'), prompts: 1, renamed: false, why: 'unknown outcome value' },
  { id: 'D17', sandbox: MODE.WRITE, approval: outcomeOf(undefined), prompts: 1, renamed: false, why: 'undefined outcome' },
  { id: 'D18', sandbox: MODE.WRITE, approval: outcomeOf('ALLOWED-ONCE'), prompts: 1, renamed: false, why: 'BVA: grant must equal "allowed-once" exactly' },
  { id: 'D19', sandbox: MODE.WRITE, approval: APPROVAL.THROWS, prompts: 1, renamed: false, why: 'request throws' },
  { id: 'D20', sandbox: MODE.READ, approval: OUTCOME.REJECTED, prompts: 1, renamed: false, why: 'read-only + rejected' },
  { id: 'D21', sandbox: SANDBOX.ABSENT, approval: OUTCOME.REJECTED, prompts: 1, renamed: false, why: 'no sandboxPolicy + rejected' },
  { id: 'D22', sandbox: SANDBOX.THROWS, approval: OUTCOME.CANCELLED, prompts: 1, renamed: false, why: 'resolve throws + cancelled' },
  { id: 'D23', sandbox: MODE.WRITE, approval: APPROVAL.ABSENT, prompts: 0, renamed: false, why: 'host without approval service refuses' },
  { id: 'D24', sandbox: MODE.WRITE, approval: APPROVAL.NO_REQUEST, prompts: 0, renamed: false, why: 'approval service without request() refuses' },
  { id: 'D25', sandbox: MODE.WRITE, approval: OUTCOME.REJECTED, agent: false, prompts: 0, renamed: false, why: 'no exec.agent refuses' },
  { id: 'D26', sandbox: SANDBOX.ABSENT, approval: APPROVAL.ABSENT, prompts: 0, renamed: false, why: 'neither service present' }
];
for (const rule of RENAME_DECISIONS) {
  test(`rename decision ${rule.id}: ${rule.why} -> ${rule.prompts} prompt(s), ${rule.renamed ? 'renamed' : 'refused, title unchanged'}`, async () => {
    const host = mountHost({ sandbox: rule.sandbox, approval: rule.approval });
    const tree = host.fxTree();
    const exec = makeExec({ agent: rule.agent !== false });
    const call = host.runTool(TOOL.RENAME, { workspaceId: WS.A.id, name: `  ${NEW_TITLE}  ` }, exec);

    if (rule.renamed) {
      const value = await call;
      assertRenamedA(host, value, tree, NEW_TITLE);
    } else {
      await assert.rejects(call, (err) => err instanceof Error);
      assertRenameNotApplied(host, tree);
    }

    assert.equal(host.spies.approval.length, rule.prompts, 'approval.request call count');
    if (rule.prompts === 1) {
      const [{ req, setTitleCountAtRequest, titleAtRequest }] = host.spies.approval;
      assert.equal(req.agent, exec.agent, 'request.agent is exec.agent');
      assert.equal(req.toolName, TOOL.RENAME, 'request.toolName');
      assert.ok(req.signal === exec.signal || req.signal instanceof AbortSignal, 'request.signal forwards the call signal');
      assert.equal(typeof req.reason, 'string');
      assert.ok(req.reason.includes(WS.A.title) && req.reason.includes(NEW_TITLE), `reason names both titles: ${req.reason}`);
      assert.equal(setTitleCountAtRequest, 0, 'approval asked BEFORE renaming');
      assert.equal(titleAtRequest, WS.A.title);
    }
    if (rule.checkSession) {
      assert.ok(host.spies.resolve.some((req) => req?.session === CALLER_SESSION), 'sandboxPolicy.resolve({ session: exec.agent.session })');
    }
  });
}
//#endregion

//#region mover_rename_workspace — state transitions
test('state transition (rename): Alpha -> Gamma -> Gamma(no-op) -> Beta(conflict) -> Alpha(freed title) ', async () => {
  const host = mountHost({ sandbox: MODE.WRITE, approval: OUTCOME.ALLOWED });

  const toGamma = await host.runTool(TOOL.RENAME, { workspaceId: WS.A.id, name: NEW_TITLE });
  assert.equal(toGamma.changed, true);
  assert.equal(host.entityA.title, NEW_TITLE);
  assert.equal(host.spies.approval.length, 1);

  const noop = await host.runTool(TOOL.RENAME, { workspaceId: WS.A.id, name: ` ${NEW_TITLE} ` });
  assert.equal(noop.changed, false);
  assert.equal(host.spies.approval.length, 1, 'no prompt for the no-op');

  await expectToolCode(host.runTool(TOOL.RENAME, { workspaceId: WS.A.id, name: WS.B.title }), CODE.CONFLICT);
  assert.equal(host.entityA.title, NEW_TITLE);
  assert.equal(host.spies.approval.length, 1, 'no prompt for the conflict');

  const back = await host.runTool(TOOL.RENAME, { workspaceId: WS.A.id, name: WS.A.title });
  assert.equal(back.changed, true);
  assert.equal(back.previousTitle, NEW_TITLE);
  assert.equal(back.title, WS.A.title);
  assert.equal(host.entityA.title, WS.A.title);
  assert.equal(host.spies.approval.length, 2);
  assert.deepEqual(host.spies.setTitle.map((c) => c.title), [NEW_TITLE, WS.A.title]);

  // the title "Gamma" was released and "Beta" is still held
  await expectToolCode(host.runTool(TOOL.RENAME, { workspaceId: WS.A.id, name: WS.B.title }), CODE.CONFLICT);
  const reuse = await host.runTool(TOOL.CREATE, { name: NEW_TITLE, directory: host.paths.free });
  assert.equal(reuse.title, NEW_TITLE, 'freed title can be used by a new workspace');
});

test('state transition (rename): refused attempt keeps state, a later approved retry renames', async () => {
  const outcomes = [OUTCOME.REJECTED, OUTCOME.ALLOWED];
  const host = mountHost({ sandbox: MODE.READ, approval: () => outcomes.shift() });
  const tree = host.fxTree();
  await assert.rejects(host.runTool(TOOL.RENAME, { workspaceId: WS.A.id, name: NEW_TITLE }), (err) => err instanceof Error);
  assertRenameNotApplied(host, tree);
  const value = await host.runTool(TOOL.RENAME, { workspaceId: WS.A.id, name: NEW_TITLE });
  assert.equal(host.spies.approval.length, 2);
  assertRenamedA(host, value, tree, NEW_TITLE);
});
//#endregion

//#region RPC mover.ws.create / mover.ws.rename (integration)
const RPC_CREATE_FAILURES = [
  { label: 'blank name', payload: (p) => ({ name: '  ', directory: p.free }), code: CODE.INVALID },
  { label: 'missing name', payload: (p) => ({ directory: p.free }), code: CODE.INVALID },
  { label: 'relative directory', payload: () => ({ name: NEW_TITLE, directory: 'fx/free' }), code: CODE.INVALID },
  { label: 'nonexistent directory', payload: (p) => ({ name: NEW_TITLE, directory: join(p.fx, 'missing') }), code: CODE.NOT_FOUND },
  { label: 'regular file', payload: (p) => ({ name: NEW_TITLE, directory: p.file }), code: CODE.INVALID },
  { label: 'existing title', payload: (p) => ({ name: ` ${WS.A.title} `, directory: p.free }), code: CODE.CONFLICT },
  { label: 'folder in use (trailing slash)', payload: (p) => ({ name: NEW_TITLE, directory: `${p.B}/` }), code: CODE.CONFLICT },
  { label: 'folder in use (.. segment)', payload: (p) => ({ name: NEW_TITLE, directory: `${p.A}/../beta` }), code: CODE.CONFLICT }
];
for (const c of RPC_CREATE_FAILURES) {
  test(`rpc mover.ws.create ${c.label} -> { ok:false, code:${c.code} }, registry unchanged`, async () => {
    const host = mountHost();
    const before = host.snapshot();
    const tree = host.fxTree();
    expectRpcCode(await host.rpc(RPC.CREATE, c.payload(host.paths)), c.code);
    assertNothingChanged(host, before, tree);
  });
}

test('rpc mover.ws.create via symlink to an existing workspace folder -> conflict', async (t) => {
  const host = mountHost();
  const link = join(host.paths.links, 'to-beta');
  if (!trySymlink(t, host.paths.B, link)) return;
  const before = host.snapshot();
  const tree = host.fxTree();
  expectRpcCode(await host.rpc(RPC.CREATE, { name: NEW_TITLE, directory: link }), CODE.CONFLICT);
  assertNothingChanged(host, before, tree);
});

test('rpc mover.ws.create success -> { ok:true, value:{ workspaceId, title, path } }, no approval', async () => {
  const host = mountHost({ sandbox: MODE.READ, approval: OUTCOME.REJECTED });
  const before = host.snapshot();
  const value = expectRpcOk(await host.rpc(RPC.CREATE, { name: `\t${NEW_TITLE} `, directory: `${host.paths.free}/` }));
  assertCreated(host, before, value, { path: host.paths.free, title: NEW_TITLE });
  assert.equal(host.spies.approval.length, 0);
});

const RPC_RENAME_FAILURES = [
  { label: 'unknown workspaceId', payload: { workspaceId: 'wid-nope', name: NEW_TITLE }, code: CODE.NOT_FOUND },
  { label: 'empty workspaceId', payload: { workspaceId: '', name: NEW_TITLE }, code: CODE.INVALID },
  { label: 'blank name', payload: { workspaceId: WS.A.id, name: '   ' }, code: CODE.INVALID },
  { label: "another workspace's title", payload: { workspaceId: WS.A.id, name: ` ${WS.B.title} ` }, code: CODE.CONFLICT }
];
for (const dryRun of [true, false]) {
  for (const c of RPC_RENAME_FAILURES) {
    test(`rpc mover.ws.rename (dryRun ${dryRun}) ${c.label} -> ${c.code}, nothing written`, async () => {
      const host = mountHost();
      const before = host.snapshot();
      const tree = host.fxTree();
      expectRpcCode(await host.rpc(RPC.RENAME, { ...c.payload, dryRun }), c.code);
      assertNothingChanged(host, before, tree);
      assert.equal(host.spies.approval.length, 0);
    });
  }
}

test('rpc mover.ws.rename dryRun:true returns the plan and writes nothing', async () => {
  const host = mountHost({ sandbox: MODE.READ, approval: OUTCOME.REJECTED });
  const before = host.snapshot();
  const tree = host.fxTree();
  const value = expectRpcOk(await host.rpc(RPC.RENAME, { workspaceId: WS.A.id, name: `  ${NEW_TITLE}  `, dryRun: true }));
  assert.equal(value.workspaceId, WS.A.id);
  assert.equal(value.path, host.paths.A);
  assert.equal(value.previousTitle, WS.A.title);
  assert.equal(value.title, NEW_TITLE);
  assert.equal(value.changed, true);
  assert.equal(value.dryRun, true);
  assertNothingChanged(host, before, tree);
  assert.equal(host.spies.approval.length, 0);
});

test('rpc mover.ws.rename dryRun:true to the current title -> changed:false plan', async () => {
  const host = mountHost();
  const before = host.snapshot();
  const tree = host.fxTree();
  const value = expectRpcOk(await host.rpc(RPC.RENAME, { workspaceId: WS.A.id, name: ` ${WS.A.title} `, dryRun: true }));
  assert.equal(value.changed, false);
  assert.equal(value.dryRun, true);
  assertNothingChanged(host, before, tree);
});

for (const dryRun of [undefined, false]) {
  test(`rpc mover.ws.rename dryRun ${dryRun} renames with no approval gate (read-only sandbox, refusing seam)`, async () => {
    const host = mountHost({ sandbox: MODE.READ, approval: OUTCOME.REJECTED });
    const tree = host.fxTree();
    const payload = { workspaceId: WS.A.id, name: ` ${NEW_TITLE} ` };
    if (dryRun !== undefined) payload.dryRun = dryRun;
    const value = expectRpcOk(await host.rpc(RPC.RENAME, payload));
    assertRenamedA(host, value, tree, NEW_TITLE);
    assert.equal(host.spies.approval.length, 0, 'RPC has no approval gate');
  });
}

test('rpc mover.ws.rename to the current title (non-dry) -> changed:false and setTitle not called', async () => {
  const host = mountHost();
  const before = host.snapshot();
  const tree = host.fxTree();
  const value = expectRpcOk(await host.rpc(RPC.RENAME, { workspaceId: WS.A.id, name: WS.A.title }));
  assert.equal(value.changed, false);
  assertNothingChanged(host, before, tree);
});
//#endregion

//#region doctor host-sandbox-policy
const DOCTOR_CASES = [
  { sandbox: MODE.FULL, state: CHECK_STATE.PASS, label: 'resolve present (full access)' },
  { sandbox: MODE.READ, state: CHECK_STATE.PASS, label: 'resolve present (read-only)' },
  { sandbox: SANDBOX.THROWS, state: CHECK_STATE.PASS, label: 'resolve present even if it throws when called' },
  { sandbox: SANDBOX.NO_RESOLVE, state: CHECK_STATE.WARN, label: 'service without resolve' },
  { sandbox: SANDBOX.ABSENT, state: CHECK_STATE.WARN, label: 'service absent' }
];
for (const c of DOCTOR_CASES) {
  test(`doctor ${DOCTOR_CHECK_ID}: ${c.label} -> ${c.state}`, async () => {
    const host = mountHost({ sandbox: c.sandbox });
    const value = expectRpcOk(await host.rpc(RPC.DOCTOR));
    const check = value.checks.find((entry) => entry.id === DOCTOR_CHECK_ID);
    assert.ok(check, `doctor lacks ${DOCTOR_CHECK_ID}: ${value.checks.map((entry) => entry.id).join(', ')}`);
    assert.equal(check.state, c.state);
  });
}
//#endregion

//#region system: an agent's end-to-end conversation
test('system: agent lists, creates, renames, re-checks conflicts and runs doctor; folders and sessions untouched', async () => {
  const host = mountHost({ sandbox: MODE.WRITE, approval: OUTCOME.ALLOWED });
  const tree = host.fxTree();
  const exec = makeExec();

  const listed = await host.runTool(TOOL.LIST, {}, exec);
  assert.ok(listed.workspaces.some((w) => w.workspaceId === WS.A.id));
  assert.ok(listed.workspaces.some((w) => w.workspaceId === WS.B.id));

  const createArgs = { name: ` ${NEW_TITLE} `, directory: host.paths.free };
  const created = await host.runTool(TOOL.CREATE, createArgs, exec);
  assert.equal(created.title, NEW_TITLE);
  assert.equal(created.path, host.paths.free);
  assert.equal(host.registry.list().length, 3);
  assert.equal(host.spies.approval.length, 0, 'create did not prompt');
  assert.ok(Array.isArray(host.tool(TOOL.CREATE).output.render(createArgs, created)), 'create output renders to content blocks');

  const relisted = await host.runTool(TOOL.LIST, {}, exec);
  const listedNew = relisted.workspaces.find((w) => w.workspaceId === created.workspaceId);
  assert.ok(listedNew, 'new workspace visible to mover_list_sessions');
  assert.ok(JSON.stringify(listedNew).includes(NEW_TITLE));

  const renameArgs = { workspaceId: created.workspaceId, name: SECOND_NEW_TITLE };
  const renamed = await host.runTool(TOOL.RENAME, renameArgs, exec);
  assert.equal(renamed.changed, true);
  assert.equal(renamed.previousTitle, NEW_TITLE);
  assert.equal(renamed.title, SECOND_NEW_TITLE);
  assert.equal(renamed.path, host.paths.free);
  assert.equal(host.registry.get(created.workspaceId).title, SECOND_NEW_TITLE);
  assert.equal(host.spies.approval.length, 1, 'rename prompted once');
  assert.ok(host.spies.approval[0].req.reason.includes(NEW_TITLE) && host.spies.approval[0].req.reason.includes(SECOND_NEW_TITLE));
  assert.ok(Array.isArray(host.tool(TOOL.RENAME).output.render(renameArgs, renamed)), 'rename output renders to content blocks');

  const afterRename = await host.runTool(TOOL.LIST, {}, exec);
  assert.ok(JSON.stringify(afterRename.workspaces.find((w) => w.workspaceId === created.workspaceId)).includes(SECOND_NEW_TITLE));

  // released vs held titles across both tools
  const recreated = await host.runTool(TOOL.CREATE, { name: NEW_TITLE, directory: host.paths.free2 }, exec);
  assert.equal(recreated.title, NEW_TITLE, 'released title is reusable');
  await expectToolCode(host.runTool(TOOL.CREATE, { name: SECOND_NEW_TITLE, directory: host.paths.sub }, exec), CODE.CONFLICT);
  await expectToolCode(host.runTool(TOOL.RENAME, { workspaceId: WS.A.id, name: SECOND_NEW_TITLE }, exec), CODE.CONFLICT);
  await expectToolCode(host.runTool(TOOL.CREATE, { name: 'Epsilon', directory: `${host.paths.free}/` }, exec), CODE.CONFLICT);
  assert.equal(host.spies.approval.length, 1, 'failed validations never prompted');
  assert.equal(host.registry.list().length, 4);

  const doctor = await host.runTool(TOOL.DOCTOR, {}, exec);
  assert.ok(JSON.stringify(doctor).includes(DOCTOR_CHECK_ID), 'mover_doctor reports host-sandbox-policy');

  assert.deepEqual(host.fxTree(), tree, 'no folder or file created/changed under the fixtures');
  assert.deepEqual(readFileSync(host.sessionArtifact), host.sessionBytes, 'session archive untouched');
  assert.equal(readHeader(readFileSync(host.sessionArtifact)).cwd, host.paths.A);
  assert.deepEqual(host.entityA.sessionIds, [SESSION_ID]);
  assert.equal(host.entityA.title, WS.A.title);
  assert.equal(host.entityB.title, WS.B.title);
});

test('system: without dsh-tools the RPC endpoints still create and rename', async () => {
  const host = mountHost({ tools: false });
  assert.equal(host.registered.length, 0);
  const created = expectRpcOk(await host.rpc(RPC.CREATE, { name: NEW_TITLE, directory: host.paths.free }));
  const renamed = expectRpcOk(await host.rpc(RPC.RENAME, { workspaceId: created.workspaceId, name: SECOND_NEW_TITLE }));
  assert.equal(renamed.changed, true);
  assert.equal(host.registry.get(created.workspaceId).title, SECOND_NEW_TITLE);
  assert.equal(host.registry.get(created.workspaceId).path, host.paths.free);
});
//#endregion
