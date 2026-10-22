// Host-service lifecycle tests: which services the plugin requires, and how the optional
// ones (dsh-tools, dsh-user-approval) are picked up on a cordis-style host.
//
// The fake host below models three cordis 4.x rules the plugin depends on. The real
// framework is not importable in CI, so the rules are reproduced, not the framework:
//   1. every name in a plugin's `inject` is REQUIRED: apply runs only once all are present;
//   2. ctx.get(name) returns the service or undefined and never throws;
//   3. ctx.inject(names, cb) runs cb in a child context once all names exist, exposes them
//      as properties, and disposes the child's effects (reverse order) when one is removed;
//      the callback runs again with a fresh child when the service comes back.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import * as plugin from '../lib/index.js';

const CHANNEL = '/workspace-mover';
const REQUIRED = ['workspaceRegistry', 'sessionPersistence'];
const AGENT_TOOLS = ['mover_list_sessions', 'mover_move_session', 'mover_repair_sessions', 'mover_doctor', 'mover_create_workspace', 'mover_rename_workspace'];
const TOOL = Object.freeze({ RENAME: 'mover_rename_workspace', MOVE: 'mover_move_session' });
const RM_TREE = { recursive: true, force: true, maxRetries: 3 };

const hosts = [];
afterEach(() => { for (const host of hosts.splice(0)) host.dispose(); });

/** A minimal fiber: effects registered while active, cleaned up in reverse order. */
function makeFiber() {
	const cleanups = [];
	return {
		effect(register) {
			const cleanup = register();
			if (typeof cleanup === 'function') cleanups.push(cleanup);
		},
		dispose() { while (cleanups.length) { try { cleanups.pop()(); } catch { /* best effort */ } } }
	};
}

/** Cordis-like host: required inject gate (rule 1), get (rule 2), nested inject (rule 3). */
function makeCordisHost(initial) {
	const services = new Map(Object.entries(initial));
	const watchers = []; // { names, callback, fiber? }
	const rootFiber = makeFiber();

	const childCtx = (names, fiber) => {
		const ctx = { effect: fiber.effect, get: (key) => services.get(key) };
		for (const key of names) {
			const value = services.get(key);
			// A registration made through a child context is that child's effect (dsh-tools
			// `register` returns a disposer tied to the calling fiber).
			ctx[key] = key === 'tools' ? { ...value, register: (def) => { const off = value.register(def); fiber.effect(() => off); return off; } } : value;
		}
		return ctx;
	};

	const refresh = () => {
		for (const w of watchers) {
			const ready = w.names.every((n) => services.has(n));
			if (ready && !w.fiber) {
				w.fiber = makeFiber();
				w.callback(childCtx(w.names, w.fiber));
			} else if (!ready && w.fiber) {
				w.fiber.dispose();
				w.fiber = undefined;
			}
		}
	};

	const ctx = {
		logger: { info() {}, warn() {}, error() {}, debug() {} },
		get: (key) => services.get(key),
		effect: rootFiber.effect,
		inject(names, callback) { watchers.push({ names, callback }); refresh(); }
	};

	return {
		ctx,
		provide(name, value) { services.set(name, value); refresh(); },
		remove(name) { services.delete(name); refresh(); },
		dispose() { for (const w of watchers) w.fiber?.dispose(); rootFiber.dispose(); }
	};
}

function makeEntity(id, path, title, log) {
	const record = { path, title, sessionIds: [] };
	return {
		id,
		get path() { return record.path; },
		get title() { return record.title; },
		get sessionIds() { return [...record.sessionIds]; },
		get record() { return record; },
		async setTitle(next) { log.push(next); record.title = next; },
		async status() { return 'ok'; },
		async attachSession() {},
		async detachSession() {}
	};
}

function makeTools() {
	const registered = new Map();
	return {
		registered,
		register(def) {
			assert.equal(registered.has(def.name), false, `${def.name} registered twice without being disposed`);
			registered.set(def.name, def);
			return () => registered.delete(def.name);
		}
	};
}

function makeApproval(outcome) {
	const calls = [];
	return { calls, outcome, async request(req) { calls.push(req); return this.outcome; } };
}

/**
 * Mount the plugin on a cordis-like host providing only the required services plus the
 * web transport. Applies the plugin only when its declared `inject` is satisfied (rule 1),
 * exactly as cordis would.
 */
function mountCordis() {
	const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'wsm-hostsvc-')));
	const dirs = { home: join(root, 'home'), store: join(root, 'store'), a: join(root, 'alpha'), b: join(root, 'beta') };
	for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
	const previousHome = process.env.DSH_HOME;
	process.env.DSH_HOME = dirs.home;

	const titles = [];
	const entities = [makeEntity('wid-a', dirs.a, basename(dirs.a), titles), makeEntity('wid-b', dirs.b, basename(dirs.b), titles)];
	const registry = { list: () => [...entities], get: (id) => entities.find((e) => e.id === id), archivedSessionIds: [] };
	let dispatch;
	const host = makeCordisHost({
		workspaceRegistry: registry,
		sessionPersistence: { root: dirs.store, compression: 'zstd', async list() { return []; } },
		connection: { rpc: { handle(channel, fn) { if (channel === CHANNEL) dispatch = fn; return () => {}; } } },
		webServer: {}
	});
	const ctx = { ...host.ctx, workspaceRegistry: registry, sessionPersistence: host.ctx.get('sessionPersistence') };

	const satisfied = plugin.inject.every((name) => host.ctx.get(name) !== undefined);
	if (satisfied) plugin.apply(ctx);

	const handle = {
		...host,
		satisfied,
		registry,
		titles,
		rpc: (endpoint, payload) => { assert.equal(typeof dispatch, 'function', 'RPC channel not mounted'); return dispatch(endpoint, payload ?? {}); },
		async doctorState(id) { return (await handle.rpc('mover.doctor')).value.checks.find((c) => c.id === id)?.state; },
		async agentTools() { return (await handle.rpc('mover.status')).value.agentTools; },
		dispose() {
			host.dispose();
			if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome;
			rmSync(root, RM_TREE);
		}
	};
	hosts.push(handle);
	return handle;
}

function makeExec(callId = 'call-1') {
	return { agent: { session: {} }, callId, signal: new AbortController().signal };
}

//#region 1. required services
test('inject names only the services the plugin cannot run without', () => {
	assert.deepEqual([...plugin.inject].sort(), [...REQUIRED].sort());
	assert.equal(plugin.inject.includes('tools'), false, 'tools must be optional: cordis deactivates the whole plugin when an injected service is missing');
	assert.equal(plugin.inject.includes('approval'), false, 'approval must be optional for the same reason');
});
//#endregion

//#region 2. no optional services
test('without dsh-tools and dsh-user-approval the plugin still mounts and the rescue RPC answers', async () => {
	const host = mountCordis();
	assert.equal(host.satisfied, true, 'required services alone satisfy inject');
	const status = await host.rpc('mover.status');
	assert.equal(status.ok, true, JSON.stringify(status.error));
	assert.equal(status.value.agentTools, false);
	assert.equal(await host.doctorState('host-approval'), 'warn');
	assert.equal(await host.doctorState('agent-tools'), 'warn');
});
//#endregion

//#region 3. tools follow the tools service (state transitions)
test('agent tools register with dsh-tools, unregister when it goes, and re-register once when it returns', async () => {
	const host = mountCordis();
	const tools = makeTools();

	assert.equal(await host.agentTools(), false, 'S0: no tools service');

	host.provide('tools', tools);
	assert.deepEqual([...tools.registered.keys()].sort(), [...AGENT_TOOLS].sort(), 'S1: all six registered');
	assert.equal(await host.agentTools(), true);
	assert.equal(await host.doctorState('agent-tools'), 'pass');

	host.remove('tools');
	assert.equal(tools.registered.size, 0, 'S2: every registration disposed with the service');
	assert.equal(await host.agentTools(), false);
	assert.equal((await host.rpc('mover.status')).ok, true, 'plugin stays active without tools');

	host.provide('tools', tools); // register() asserts no duplicate
	assert.deepEqual([...tools.registered.keys()].sort(), [...AGENT_TOOLS].sort(), 'S3: registered again exactly once each');
	assert.equal(await host.agentTools(), true);
});
//#endregion

//#region 4. approval is read at call time
test('rename reads approval per call: absent → refused; added → asks; removed → refused again', async () => {
	const host = mountCordis();
	const tools = makeTools();
	host.provide('tools', tools);
	const rename = tools.registered.get(TOOL.RENAME);

	const originalTitle = host.registry.get('wid-a').title;
	await assert.rejects(rename.execute({ workspaceId: 'wid-a', name: 'First' }, makeExec('call-1')), /approval could not be requested/);
	assert.equal(host.registry.get('wid-a').title, originalTitle);
	assert.equal(await host.doctorState('host-approval'), 'warn');

	// Approval appears later, without re-mounting the plugin.
	const approval = makeApproval('rejected');
	host.provide('approval', approval);
	assert.equal(await host.doctorState('host-approval'), 'pass');
	await assert.rejects(rename.execute({ workspaceId: 'wid-a', name: 'Second' }, makeExec('call-2')));
	assert.equal(approval.calls.length, 1, 'asked exactly once');
	assert.equal(host.registry.get('wid-a').title, originalTitle, 'rejected → unchanged');

	approval.outcome = 'allowed-once';
	const third = await rename.execute({ workspaceId: 'wid-a', name: 'Third' }, makeExec('call-3'));
	assert.equal(approval.calls.length, 2);
	assert.equal(third.title, 'Third');

	host.remove('approval');
	await assert.rejects(rename.execute({ workspaceId: 'wid-a', name: 'Fourth' }, makeExec('call-4')), /approval could not be requested/);
	assert.equal(approval.calls.length, 2, 'no prompt once the service is gone');
	assert.equal(host.registry.get('wid-a').title, 'Third');
	assert.deepEqual(host.titles, ['Third'], 'setTitle only after approval');
});
//#endregion

//#region 5. callId is forwarded
for (const [toolName, args] of [
	[TOOL.RENAME, { workspaceId: 'wid-a', name: 'Renamed' }],
	[TOOL.MOVE, { sessionId: 'session-unknown', targetWorkspaceId: 'wid-b' }]
]) {
	test(`${toolName} approval request carries the tool call's callId (ACP answerer ignores requests without one)`, async () => {
		const host = mountCordis();
		const tools = makeTools();
		host.provide('tools', tools);
		const approval = makeApproval('rejected'); // rejected: nothing on disk is touched
		host.provide('approval', approval);
		const exec = makeExec(`call-${toolName}`);

		await assert.rejects(tools.registered.get(toolName).execute(args, exec));

		assert.equal(approval.calls.length, 1);
		const req = approval.calls[0];
		assert.equal(req.callId, exec.callId);
		assert.equal(req.agent, exec.agent);
		assert.equal(req.toolName, toolName);
		assert.equal(typeof req.reason, 'string');
		assert.equal(req.signal, exec.signal);
		assert.equal(host.registry.get('wid-a').title, basename(host.registry.get('wid-a').path), 'nothing renamed');
	});
}
//#endregion

//#region 6. non-cordis hosts
test('a host without inject still gets tools from ctx.tools and approval from ctx.approval', async () => {
	const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'wsm-hostsvc-plain-')));
	const a = join(root, 'alpha');
	mkdirSync(a);
	const previousHome = process.env.DSH_HOME;
	process.env.DSH_HOME = join(root, 'home');
	const fiber = makeFiber();
	try {
		const titles = [];
		const entity = makeEntity('wid-a', a, 'alpha', titles);
		const tools = makeTools();
		const approval = makeApproval('allowed-once');
		const ctx = {
			workspaceRegistry: { list: () => [entity], get: (id) => (id === 'wid-a' ? entity : undefined), archivedSessionIds: [] },
			sessionPersistence: { root: join(root, 'store'), compression: 'zstd', async list() { return []; } },
			logger: { info() {}, warn() {} },
			get: () => undefined,
			effect: fiber.effect,
			connection: { rpc: { handle() { return () => {}; } } },
			tools,
			approval
		};
		plugin.apply(ctx);
		assert.deepEqual([...tools.registered.keys()].sort(), [...AGENT_TOOLS].sort());
		const value = await tools.registered.get(TOOL.RENAME).execute({ workspaceId: 'wid-a', name: 'Renamed' }, makeExec('call-plain'));
		assert.equal(approval.calls.length, 1);
		assert.equal(approval.calls[0].callId, 'call-plain');
		assert.equal(value.title, 'Renamed');
	} finally {
		fiber.dispose();
		if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome;
		rmSync(root, RM_TREE);
	}
});
//#endregion
