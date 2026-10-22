// Opt-in check against an extracted, already installed DSH runtime. No downloads.
// DSH_TEST_NODE_MODULES must point to that runtime's node_modules directory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as mover from '../lib/index.js';

const modules = process.env.DSH_TEST_NODE_MODULES;
const load = (name) => import(pathToFileURL(join(resolve(modules), '@deepseek-ai', name, 'lib/index.js')).href);

test('installed DSH: real Cordis/tools lifecycle and JSONL write → queue → close → move → resume',
  { skip: !modules, timeout: 60000 }, async () => {
    const { Context } = await load('cordis');
    const persistencePlugin = await load('dsh-session-persistence-jsonl');
    const { ToolRuntime } = await load('dsh-tools');
    const home = mkdtempSync(join(tmpdir(), 'wsm-installed-'));
    const previousHome = process.env.DSH_HOME;
    process.env.DSH_HOME = home;
    const root = new Context();
    const A = join(home, 'A'), B = join(home, 'B');
    mkdirSync(A); mkdirSync(B);
    const entities = ['a', 'b'].map((id, i) => {
      const record = { path: [A, B][i], title: id, sessionIds: [] };
      return { id, record, get path() { return record.path; }, get title() { return record.title; },
        get sessionIds() { return [...record.sessionIds]; }, async status() { return 'ok'; },
        async setTitle(title) { record.title = title; },
        async attachSession(id) { if (!record.sessionIds.includes(id)) record.sessionIds.push(id); },
        async detachSession(id) { record.sessionIds = record.sessionIds.filter((x) => x !== id); } };
    });
    let dispatch;
    let backend, plugin, tools;
    try {
      root.provide('workspaceRegistry', { get: (id) => entities.find((e) => e.id === id), list: () => entities });
      root.provide('connection', { rpc: { handle(_channel, handler) { dispatch = handler; return () => { dispatch = undefined; }; } } });
      root.provide('webServer', {});
      root.provide('systemPrompt', { tools() {} });
      backend = root.plugin(persistencePlugin, { root: join(home, 'sessions'), compression: 'zstd' });
      await backend.await();
      plugin = root.plugin(mover);
      await plugin.await();
      await new Promise(setImmediate);
      assert.equal(typeof dispatch, 'function', 'RPC mounts without tools or approval');
      tools = root.plugin({ name: 'test-tools-provider', apply(ctx) { new ToolRuntime(ctx); } });
      await tools.await();
      await root.fiber.flush?.();
      // Give nested inject fibers a turn to settle.
      await new Promise(setImmediate);
      assert.equal((await dispatch('mover.status', {})).value.agentTools, true);
      await tools.dispose();
      await new Promise(setImmediate);
      assert.equal((await dispatch('mover.status', {})).value.agentTools, false);

      const store = root.get('sessionPersistence');
      const id = 'session-installed-test';
      entities[0].record.sessionIds.push(id);
      const writer = await store.create({ id, cwd: A, version: 4, createdAt: Date.now(), isSeeded: false, delegationDepth: 0 });
      const initial = { type: 'working-directory/change', seq: 0, time: Date.now(), data: { cwd: A } };
      await writer.append([initial]);
      const source = mover.artifactPath(store.root, A, id);
      const bytes = readFileSync(source);
      const queued = await dispatch('mover.move', { sessionId: id, targetWorkspaceId: 'b' });
      assert.equal(queued.error.code, 'busy');
      assert.deepEqual(readFileSync(source), bytes);
      await writer.append([{ ...initial, seq: 1, time: Date.now() }]);
      root.emit('session/event', { id }, { ...initial, seq: 2, time: Date.now() });
      // Dispose the consumer while its task is waiting. The task must survive
      // a fresh plugin and backend instance without relying on an in-memory queue.
      await plugin.dispose(); plugin = undefined;
      const closing = writer.close();
      await closing;
      await backend.dispose(); backend = undefined;
      backend = root.plugin(persistencePlugin, { root: join(home, 'sessions'), compression: 'zstd' });
      await backend.await();
      plugin = root.plugin(mover);
      await plugin.await();
      await new Promise(setImmediate);
      let task;
      for (let attempt = 0; attempt < 80; attempt++) {
        task = (await dispatch('mover.migrations.list', {})).value.items.find((item) => item.id === queued.error.details.queueTaskId);
        if (task?.state === 'done') break;
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.equal(task?.state, 'done', JSON.stringify(task));
      const reloadedStore = root.get('sessionPersistence');
      assert.equal((await reloadedStore.stat(id)).header.cwd, B);
      const resumed = await reloadedStore.open(id, 'write');
      const before = await resumed.read();
      assert.equal(before.events.length, 4, 'two direct events, drained live event and migration cwd event');
      await resumed.append([{ ...initial, seq: before.events.length, time: Date.now(), data: { cwd: B } }]);
      await resumed.close();
      const reader = await reloadedStore.open(id, 'read');
      const after = await reader.read();
      assert.equal(after.events.length, 5);
      assert.equal(after.events.at(-1).data.cwd, B);
      await reader.close();
      const bytesAfter = readFileSync(mover.artifactPath(reloadedStore.root, B, id));
      await dispatch('mover.migrations.retry', { taskId: queued.error.details.queueTaskId });
      assert.deepEqual(readFileSync(mover.artifactPath(reloadedStore.root, B, id)), bytesAfter, 'completed task cannot duplicate cwd events');
      // Reload both plugins to discard process caches, then read again.
      await plugin.dispose(); plugin = undefined;
      await backend.dispose(); backend = undefined;
      backend = root.plugin(persistencePlugin, { root: join(home, 'sessions'), compression: 'zstd' });
      await backend.await();
      const coldReader = await root.get('sessionPersistence').open(id, 'read');
      assert.equal((await coldReader.read()).events.length, 5);
      assert.equal(coldReader.header.cwd, B);
      await coldReader.close();
    } finally {
      await plugin?.dispose();
      await tools?.dispose();
      await backend?.dispose();
      if (previousHome === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = previousHome;
      rmSync(home, { recursive: true, force: true, maxRetries: 3 });
    }
  });
