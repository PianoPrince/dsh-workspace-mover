// Retain the public create/resume disposer. Never close a borrowed persistence
// writer or rewrite an immutable live Session header.
import { AsyncLocalStorage } from 'node:async_hooks';
const migrationContext = new AsyncLocalStorage();
const original = Symbol.for('cordis.original');
const runtimes = new WeakMap();
const raw = (value) => value?.[original] ?? value;

function blocked() {
	const error = new Error('This session is being migrated; retry after migration completes.');
	error.code = 'migration-in-progress';
	return error;
}

export function installLifecycle(ctx, owner) {
	const agents = raw(owner.agents);
	if (!agents || runtimes.has(agents)) return;
	const runtime = { handles: new Map(), moving: new Set() };
	runtimes.set(agents, runtime);
	const restore = [];
	for (const method of ['create', 'resume']) {
		const fn = agents[method];
		if (typeof fn !== 'function') continue;
		const wrapped = async function (options, ...args) {
			const id = options?.resumeSessionId ?? options?.sessionId;
			if (runtime.moving.has(id) && migrationContext.getStore() !== runtime) throw blocked();
			const handle = await Reflect.apply(fn, this, [options, ...args]);
			const agent = raw(handle?.agent);
			if (agent && typeof handle.dispose === 'function') {
				const guards = [];
				runtime.handles.set(agent.id, { handle, agent, guards });
				// Requests that already resolved the old Agent must also be refused
				// while its lifecycle is draining or after it has been replaced.
				for (const entry of ['send', 'runMaintenance']) {
					const action = agent[entry];
					if (typeof action !== 'function') continue;
					const guarded = function (...params) {
						if (runtime.moving.has(agent.id) || raw(agents.get(agent.id)) !== agent) throw blocked();
						return Reflect.apply(action, this, params);
					};
					agent[entry] = guarded;
					guards.push(() => { if (agent[entry] === guarded) agent[entry] = action; });
				}
			}
			return handle;
		};
		agents[method] = wrapped;
		restore.push(() => { if (agents[method] === wrapped) agents[method] = fn; });
	}
	owner.on?.('agent/disposed', ({ agent }) => {
		if (runtime.handles.get(agent.id)?.agent === raw(agent)) runtime.handles.delete(agent.id);
	});
	owner.effect(() => () => {
		for (const entry of runtime.handles.values()) for (const undo of entry.guards) undo();
		runtime.handles.clear();
		for (const undo of restore.reverse()) undo();
		runtimes.delete(agents);
	}, 'workspace-mover: restore lifecycle observers');
}

export function lifecycleFor(ctx, id) {
	const agents = raw(typeof ctx.get === 'function' ? ctx.get('agents') : ctx.agents);
	const runtime = agents && runtimes.get(agents);
	const entry = runtime?.handles.get(id);
	return entry && raw(agents.get(id)) === entry.agent ? { ...entry, runtime, agents } : null;
}

export async function withReleasedSession(ctx, id, stopRunning, operation) {
	const owned = lifecycleFor(ctx, id);
	if (!owned) return operation();
	const { handle, agent, runtime } = owned;
	if (agent.status === 'running' && !stopRunning) {
		const error = new Error('Session is running. Confirm stop and move, or cancel migration.');
		error.code = 'stop-required';
		throw error;
	}
	if (agent.session.header?.parentSession || agent.session.header?.origin === 'subagent') {
		throw new Error('Live subagent migration is unsupported; stop its owning task first.');
	}
	runtime.moving.add(id);
	let result;
	let failure;
	try {
		await handle.dispose(); // owns cancel → drain → close → unregister
		result = await operation();
	} catch (error) {
		failure = error;
	} finally {
		runtime.handles.delete(id);
		try {
			const controller = ctx.get?.('sessionController');
			if (typeof controller?.resolveAgent === 'function') {
				const restored = await migrationContext.run(runtime, () => controller.resolveAgent(id));
				if (restored?.error) throw restored.error;
			}
		} catch (error) {
			failure = new Error(`${failure ? failure.message : 'Files migrated successfully'}; session reload failed: ${error.message}`, { cause: error });
		} finally {
			runtime.moving.delete(id);
		}
	}
	if (failure) throw failure;
	return result;
}
