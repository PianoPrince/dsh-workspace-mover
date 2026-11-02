import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as mover from '../lib/index.js';
import { installLifecycle, lifecycleFor, withReleasedSession } from '../lib/lifecycle.js';

test('live lifecycle: explicit stop, request exclusion, failure recovery and unload', async () => {
	const entries = new Map();
	let teardown;
	const agents = {
		get: (id) => entries.get(id),
		async resume({ resumeSessionId: id }) {
			const agent = { id, status: 'running', session: { header: {} }, send() { return 'sent'; } };
			entries.set(id, agent);
			return { agent, async dispose() { await teardown?.(); entries.delete(id); } };
		}
	};
	let off;
	const ctx = { agents, get: (key) => key === 'agents' ? agents : null };
	installLifecycle(ctx, { agents, effect(fn) { off = fn(); } });
	const { agent } = await agents.resume({ resumeSessionId: 'a' });
	await assert.rejects(withReleasedSession(ctx, 'a', false, () => assert.fail()), { code: 'stop-required' });
	assert.equal(agent.send(), 'sent');
	teardown = async () => {
		assert.throws(() => agent.send(), { code: 'migration-in-progress' });
		await assert.rejects(agents.resume({ resumeSessionId: 'a' }), { code: 'migration-in-progress' });
	};
	await assert.rejects(withReleasedSession(ctx, 'a', true, () => { throw new Error('disk failure'); }), /disk failure/);
	assert.equal(lifecycleFor(ctx, 'a'), null);
	assert.throws(() => agent.send(), { code: 'migration-in-progress' });
	const next = await agents.resume({ resumeSessionId: 'a' });
	assert.equal(next.agent.send(), 'sent');
	off();
	assert.equal(lifecycleFor(ctx, 'a'), null);
});

test('delete lifecycle: no reload on success, restore after failure only when archive survives', async () => {
	const entries = new Map();
	let reloads = 0;
	let teardown;
	const agents = {
		get: (id) => entries.get(id),
		async resume({ resumeSessionId: id }) {
			const agent = { id, status: 'idle', session: { header: {} }, send() {} };
			entries.set(id, agent);
			return { agent, async dispose() { entries.delete(id); } };
		}
	};
	const ctx = { get: (key) => key === 'agents' ? agents : key === 'sessionController' ? {
		async resolveAgent(id) { reloads++; return agents.resume({ resumeSessionId: id }); }
	} : null };
	installLifecycle(ctx, { agents, effect(fn) { teardown = fn(); } });
	try {
		await agents.resume({ resumeSessionId: 'delete' });
		await withReleasedSession(ctx, 'delete', false, () => 'deleted', { reloadOnSuccess: false });
		assert.equal(entries.has('delete'), false);
		assert.equal(reloads, 0, 'never recreate the deleted conversation');
		await agents.resume({ resumeSessionId: 'rollback' });
		await assert.rejects(withReleasedSession(ctx, 'rollback', false, () => { throw new Error('rollback complete'); },
			{ reloadOnSuccess: false, canReload: () => true }), /rollback complete/);
		assert.equal(reloads, 1);
		assert.ok(entries.has('rollback'));
		await assert.rejects(withReleasedSession(ctx, 'rollback', false, () => { throw new Error('archive unavailable'); },
			{ reloadOnSuccess: false, canReload: () => false }), /archive unavailable/);
		assert.equal(reloads, 1, 'failed physical rollback must not create a blank session');
	} finally { teardown(); }
});

const modules = process.env.DSH_TEST_NODE_MODULES;
const load = (name) => import(pathToFileURL(join(resolve(modules), '@deepseek-ai', name, 'lib/index.js')).href);

test('installed LocaleRuntime: bind follows locale changes and disposers unregister dictionaries',
	{ skip: !modules }, () => {
	const file = join(resolve(modules), '@deepseek-ai/dsh-client-locale/lib/client.js');
	let exported;
	runInNewContext(readFileSync(file, 'utf8'), {
		window: { __ModuleLoader__: { load({ factory }) { exported = factory(() => ({})); } } },
		navigator: { language: 'zh-CN', languages: ['zh-CN'] }, console
	});
	const locale = new exported.LocaleRuntime({ emit() {} }, undefined, { languages: ['en'], preference: 'en' });
	const stop = locale.register('test-mover', { en: { title: 'Move {n}' }, zh: { title: '移动 {n}' } });
	const t = locale.bind('test-mover');
	assert.equal(t('title', { n: 2 }), 'Move 2');
	let changed = 0;
	const unsubscribe = locale.subscribe(() => changed++);
	locale.setLocale('zh');
	assert.equal(t('title', { n: 2 }), '移动 2');
	assert.equal(changed, 1);
	unsubscribe(); stop();
	assert.equal(t('title'), 'title');
});

test('installed client Controller: a Provider reference keeps the removed generation alive until released',
	{ skip: !modules, timeout: 10000 }, async () => {
	const cordis = await load('cordis');
	// Execute installed client logic, exposing the otherwise bundle-local class
	// only inside this test. Renderer stores/transport are inert fixtures; actual
	// Controller retention, scope retirement and Session flags are unmodified.
	const file = join(resolve(modules), '@deepseek-ai/dsh-api-session-controller/lib/client.js');
	const source = readFileSync(file, 'utf8').replace('exports.apply = apply;', 'exports.__ClientSessions = ClientSessions; exports.apply = apply;');
	let exports;
	const store = {
		notifySubscribers(listeners) { for (const listener of [...listeners]) listener(); },
		createSnapshotStore(initial) {
			let value = initial;
			const listeners = new Set();
			return { getSnapshot: () => value,
				subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
				set(next) { value = next; store.notifySubscribers(listeners); } };
		}
	};
	runInNewContext(source, { window: { __ModuleLoader__: { load({ factory }) {
		exports = factory((name) => {
			if (name === '@deepseek-ai/cordis') return cordis;
			if (name === '@deepseek-ai/dsh-client-store') return store;
			if (name === '@deepseek-ai/dsh-api-gateway/client') return { RemoteJournalStream: class {} };
			throw new Error(`Unexpected client dependency: ${name}`);
		});
	} } }, console, AbortController, AbortSignal, queueMicrotask, setTimeout, clearTimeout });
	const root = new cordis.Context();
	try {
		let listed = [];
		let listCalls = 0;
		const client = new exports.__ClientSessions(root, { session: {
			async list() { listCalls++; return { ok: true, value: { items: listed } }; }
		} });
		const id = 'session-retained-view';
		const summary = { sessionId: id, blank: false, running: false, agentAvailable: true, updatedAt: 1 };
		client.handleSessionAdded(summary);
		const main = client.retainAgentScope(id);
		const provider = client.retainAgentScope(id);
		const previous = main.binding;
		client.handleSessionRemoved(id);
		client.handleSessionAdded(summary);
		assert.equal(previous.session.getSnapshot().removed, true, 'host resume does not clear the flag');
		main.release();
		const premature = client.retainAgentScope(id);
		assert.equal(premature.binding, previous, 'immediate reopen reuses the removed instance');
		premature.release();
		await new Promise((resolve) => {
			const stop = client.retainInfo(id).subscribe(() => {
				if (client.binding(id) !== previous) { stop(); resolve(); }
			});
			setTimeout(() => provider.release(), 0);
		});
		const fresh = client.retainAgentScope(id);
		assert.notEqual(fresh.binding, previous);
		assert.equal(fresh.binding.session.getSnapshot().removed, false);
		fresh.release();
		client.handleSessionRemoved(id);
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.equal(client.list.getSnapshot().ids.includes(id), false);
		listed = [summary];
		await client.refresh();
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.equal(listCalls, 1);
		assert.equal(client.list.getSnapshot().ids.includes(id), true,
			'public refresh restores cold archive metadata without an Agent-created event or restart');
	} finally {
		await root.fiber.dispose();
	}
});

test('installed DSH AgentLoop: dispose writer, physical move, resume same session and append',
	{ skip: !modules, timeout: 30000 }, async () => {
	const { Context } = await load('cordis');
	const { default: Agents } = await load('dsh-agent');
	const { default: Sessions } = await load('dsh-session');
	const { default: Projections } = await load('dsh-session-projection');
	const { default: Loop } = await load('dsh-agent-loop');
	const persistence = await load('dsh-session-persistence-jsonl');
	const home = mkdtempSync(join(tmpdir(), 'wsm-live-'));
	const prior = process.env.DSH_HOME;
	process.env.DSH_HOME = home;
	const root = new Context();
	const a = join(home, 'a'), b = join(home, 'b');
	mkdirSync(a); mkdirSync(b);
	const groups = ['a', 'b'].map((id, i) => ({ id, path: [a,b][i], record: { sessionIds: [] },
		async attachSession(id) { this.record.sessionIds.push(id); },
		async detachSession(id) { this.record.sessionIds = this.record.sessionIds.filter((x) => x !== id); } }));
	try {
		root.provide('workspaceRegistry', { list: () => groups, get: (id) => groups.find((x) => x.id === id) });
		root.provide('llm', {});
		root.provide('tools', {});
		root.provide('systemPrompt', { variable() {}, assemble() { return []; } });
		for (const plugin of [Sessions, Agents, Projections]) await root.plugin(plugin).await();
		await root.plugin(persistence, { root: join(home, 'sessions'), compression: 'zstd' }).await();
		await root.plugin({ name: 'lifecycle-observer', inject: ['agents'], apply(ctx) { installLifecycle(ctx, ctx); } }).await();
		await root.plugin(Loop, { agents: [], maxParallelToolCalls: 1 }).await();
		const agents = root.get('agents');
		root.provide('sessionController', { async resolveAgent(id) {
			return { agent: agents.get(id) ?? (await agents.resume({ resumeSessionId: id, agentOptions: {} })).agent };
		} });
		const id = 'session-live-test';
		const first = await agents.create({ sessionId: id, meta: { cwd: a }, agentOptions: {} });
		first.agent.session.append('working-directory/change', { cwd: a });
		groups[0].record.sessionIds.push(id);
		assert.ok(lifecycleFor(root, id), 'real public lifecycle handle was captured');
		const moved = await mover.moveSessionEntry(root, { sessionId: id, targetWorkspaceId: 'b' });
		assert.equal(moved.verified, true);
		assert.equal(root.get('sessions').get(id).header.cwd, b, 'controller restores from the actual target');
		const resumed = lifecycleFor(root, id).handle;
		assert.equal(resumed.agent.session.header.cwd, b);
		resumed.agent.session.append('working-directory/change', { cwd: b });
		const attach = groups[0].attachSession;
		groups[0].attachSession = async () => { throw new Error('injected attach failure'); };
		await assert.rejects(mover.moveSessionEntry(root, { sessionId: id, targetWorkspaceId: 'a' }), /rolled back cleanly/);
		assert.equal(agents.get(id).session.header.cwd, b, 'failed move reloads the original workspace');
		groups[0].attachSession = attach;
		const recovered = lifecycleFor(root, id).handle;
		recovered.agent.session.append('working-directory/change', { cwd: b });
		await recovered.dispose();
		const read = await root.get('sessionPersistence').open(id, 'read');
		assert.equal((await read.read()).events.at(-1).data.cwd, b);
		await read.close();
		// Exercise cancellation of a real running driver without a model call.
		const active = await agents.resume({ resumeSessionId: id, agentOptions: {} });
		let entered;
		const started = new Promise((resolve) => { entered = resolve; });
		const off = root.on('agent/pre-step', async ({ signal }) => {
			entered();
			await new Promise((resolve) => {
				if (signal.aborted) resolve();
				else signal.addEventListener('abort', resolve, { once: true });
			});
			return { kind: 'reject' };
		});
		active.agent.followup({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'test' }] });
		await started;
		assert.equal(active.agent.status, 'running');
		await assert.rejects(mover.moveSessionEntry(root, { sessionId: id, targetWorkspaceId: 'a' }), { code: 'stop-required' });
		assert.equal(active.agent.status, 'running', 'refusal does not stop the task');
		const back = await mover.moveSessionEntry(root, { sessionId: id, targetWorkspaceId: 'a', stopRunning: true });
		assert.equal(back.verified, true);
		assert.equal(agents.get(id).session.header.cwd, a);
		off();
		const again = lifecycleFor(root, id).handle;
		assert.equal(again.agent.session.header.cwd, a);
		const deleted = await mover.deleteSessionToTrash(root, { sessionId: id });
		assert.equal(deleted.deleted, true);
		assert.equal(agents.get(id), undefined, 'deleted Agent is not reloaded');
		assert.equal(root.get('sessions').get(id), undefined, 'real Session writer is released');
		assert.equal(lifecycleFor(root, id), null);
	} finally {
		await root.fiber.dispose();
		if (prior === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = prior;
		rmSync(home, { recursive: true, force: true, maxRetries: 3 });
	}
});
