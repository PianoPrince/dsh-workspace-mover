// dsh-workspace-mover — client-half tests against a hand-rolled DOM stub.
//
// 为什么手写而不是引入 jsdom/happy-dom：本仓库刻意保持零 devDependencies，
// CI 直接跑 `node --test`（见 package.json）。客户端半只需要 document /
// MutationObserver / navigator / window.confirm 的一小部分能力，这里按需实现，
// 顺带让"注册了哪些监听器"变成可断言的事实——这正是 teardown 缺陷的回归网。
//
// 测试策略：只经**公开出口**驱动（注册进 document 的事件 + RPC 调用记录），
// 不触碰闭包内部的私有函数。因此断言的是"用户操作后发往宿主的 payload"，
// 而不是实现细节。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

//#region 迷你 DOM

/** 解析 injectOverlay 使用的那一小撮 HTML：标签 + 类名/属性 + 文本。 */
function parseHTML(html) {
  const root = { childNodes: [], nodeType: 11 }; // fragment
  const stack = [root];
  const re = /<\/?([a-zA-Z][\w-]*)((?:\s+[\w-]+(?:="[^"]*")?)*)\s*\/?>|([^<]+)/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const [full, tag, attrs, text] = m;
    if (text !== undefined) {
      const parent = stack[stack.length - 1];
      if (parent === root || text.trim()) parent.childNodes.push({ nodeType: 3, _text: text, parentNode: parent });
      continue;
    }
    if (full.startsWith('</')) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const el = createElement(tag);
    for (const a of attrs ? attrs.matchAll(/([\w-]+)(?:="([^"]*)")?/g) : []) {
      if (a[1] === 'class') el.className = a[2] ?? '';
      else el.setAttribute(a[1], a[2] ?? '');
    }
    const parent = stack[stack.length - 1];
    el.parentNode = parent === root ? null : parent;
    parent.childNodes.push(el);
    if (!full.endsWith('/>')) stack.push(el);
  }
  // flatten fragment
  const frag = { childNodes: root.childNodes, nodeType: 11 };
  return frag;
}

function matches(el, selector) {
  if (!el || el.nodeType !== 1) return false;
  const parts = selector.trim().split(/\s+/);
  if (parts.length > 1) {
    // descendant combinator
    const [head, ...rest] = parts;
    if (!matches(el, rest.join(' '))) return false;
    for (let p = el.parentNode; p; p = p.parentNode) if (matches(p, head)) return true;
    return false;
  }
  const s = parts[0];
  if (s.startsWith('.')) return String(el.className ?? '').trim().split(/\s+/).includes(s.slice(1));
  if (s.startsWith('#')) return el.id === s.slice(1);
  const attr = /^([a-zA-Z][\w-]*)?((?:\[[^\]]+\])+)$/.exec(s);
  if (attr) {
    const tag = attr[1];
    if (tag && el.tagName?.toLowerCase() !== tag.toLowerCase()) return false;
    for (const a of attr[2].matchAll(/\[([\w-]+)(?:=["']?([^"'\]]*)["']?)?\]/g)) {
      const v = el.getAttribute(a[1]);
      if (v === null) return false;
      if (a[2] !== undefined && v !== a[2]) return false;
    }
    return true;
  }
  return el.tagName?.toLowerCase() === s.toLowerCase();
}

function matchesSelectorList(el, selector) {
  // 支持 `A, B` 与 `A > B`（本仓库只用到这些形态）
  return selector.split(',').some((one) => {
    const sel = one.trim();
    if (sel.includes('>')) {
      const [parentSel, childSel] = sel.split('>').map((x) => x.trim());
      return matches(el, childSel) && matches(el.parentNode, parentSel);
    }
    return matches(el, sel);
  });
}

function descendants(node, out = []) {
  for (const c of node.childNodes ?? []) {
    if (c.nodeType === 1) {
      out.push(c);
      descendants(c, out);
    }
  }
  return out;
}

function createElement(tag) {
  const el = {
    nodeType: 1,
    tagName: String(tag).toUpperCase(),
    childNodes: [],
    parentNode: null,
    className: '',
    id: '',
    style: {},
    dataset: {},
    _attrs: new Map(),
    _listeners: [],
    _removed: false,
    // 挂到已连接树上才有布局；stub 用 _connected 简化
    get offsetParent() {
      let p = this.parentNode;
      while (p) { if (p._connected) return p; p = p.parentNode; }
      return null;
    },
    get isConnected() {
      let p = this;
      while (p) { if (p._connected) return true; p = p.parentNode; }
      return false;
    },
    get textContent() {
      let s = '';
      for (const c of this.childNodes) {
        if (c.nodeType === 3) s += c._text;
        else if (c.nodeType === 1) s += c.textContent;
      }
      return s;
    },
    set textContent(v) {
      this.childNodes = [];
      if (v !== '' && v != null) this.childNodes.push({ nodeType: 3, _text: String(v), parentNode: this });
    },
    set innerHTML(html) {
      this.childNodes = [];
      for (const c of parseHTML(html).childNodes) {
        c.parentNode = this;
        this.childNodes.push(c);
      }
    },
    get innerHTML() {
      const render = (node) => {
        if (node.nodeType === 3) return node._text;
        const cls = String(node.className ?? '').trim();
        const attrs = [...node._attrs.entries()].map(([k, v]) => ` ${k}="${v}"`).join('');
        const open = `<${node.tagName.toLowerCase()}${cls ? ` class="${cls}"` : ''}${attrs}>`;
        return `${open}${node.childNodes.map(render).join('')}</${node.tagName.toLowerCase()}>`;
      };
      return this.childNodes.map(render).join('');
    },
    setAttribute(name, value) { this._attrs.set(String(name), String(value)); },
    getAttribute(name) { return this._attrs.has(String(name)) ? this._attrs.get(String(name)) : null; },
    removeAttribute(name) { this._attrs.delete(String(name)); },
    appendChild(child) {
      child.parentNode = this;
      if (child._connected === undefined) child._connected = this._connected;
      this.childNodes.push(child);
      return child;
    },
    append(...nodes) { for (const n of nodes) this.appendChild(n); },
    remove() {
      this._removed = true;
      if (this.parentNode) this.parentNode.childNodes = this.parentNode.childNodes.filter((c) => c !== this);
    },
    before(ref) {
      const p = ref.parentNode;
      if (!p) return;
      p.childNodes.splice(p.childNodes.indexOf(ref), 0, this);
      this.parentNode = p;
    },
    after(ref) {
      const p = ref.parentNode;
      if (!p) return;
      p.childNodes.splice(p.childNodes.indexOf(ref) + 1, 0, this);
      this.parentNode = p;
    },
    replaceWith(next) {
      const p = this.parentNode;
      if (!p) return;
      p.childNodes.splice(p.childNodes.indexOf(this), 1, next);
      next.parentNode = p;
    },
    contains(other) {
      for (let p = other; p; p = p.parentNode) if (p === this) return true;
      return false;
    },
    closest(selector) {
      for (let p = this; p; p = p.parentNode) if (matchesSelectorList(p, selector)) return p;
      return null;
    },
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; },
    querySelectorAll(selector) { return descendants(this).filter((el) => matchesSelectorList(el, selector)); },
    addEventListener(type, fn) { this._listeners.push({ type, fn }); },
    removeEventListener(type, fn) {
      this._listeners = this._listeners.filter((l) => !(l.type === type && l.fn === fn));
    },
    get classList() {
      const self = this;
      const tokens = () => String(self.className ?? '').split(/\s+/).filter(Boolean);
      const write = (next) => { self.className = [...new Set(next)].join(' '); };
      return {
        add(...names) { write([...tokens(), ...names]); },
        remove(...names) { write(tokens().filter((t) => !names.includes(t))); },
        contains(name) { return tokens().includes(name); },
        toggled(name, on) { if (on) this.add(name); else this.remove(name); },
      };
    },
    focus() { doc.activeElement = this; },
  };
  return el;
}

function createTextNode(text) { return { nodeType: 3, _text: String(text), parentNode: null }; }

const doc = {
  nodeType: 9,
  _connected: true,
  activeElement: null,
  documentElement: null,
  childNodes: [],
  _listeners: [],
  createElement,
  createTextNode,
  get head() { return this._head; },
  get body() { return this._body; },
  addEventListener(type, fn, capture) { this._listeners.push({ type, fn, capture: Boolean(capture) }); },
  removeEventListener(type, fn, capture) {
    this._listeners = this._listeners.filter((l) => !(l.type === type && l.fn === fn && l.capture === Boolean(capture)));
  },
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; },
  querySelectorAll(selector) { return descendants(this).filter((el) => matchesSelectorList(el, selector)); },
  getElementById(id) {
    return descendants(this).find((el) => el.id === id || el.getAttribute('id') === id) ?? null;
  },
  dispatchEvent(event) { dispatch(event); return true; },
};
doc._head = createElement('head');
doc._body = createElement('body');
doc._head._connected = true;
doc._body._connected = true;
doc.childNodes.push(doc._head, doc._body);

/** 事件派发：捕获阶段（祖先 → 目标）→ 目标 → 冒泡（目标 → 祖先）。 */
function dispatch(event) {
  const path = [];
  for (let p = event.target; p; p = p.parentNode) path.push(p);
  if (path[path.length - 1] !== doc) path.push(doc);
  event.preventDefault = event.preventDefault ?? (() => { event.defaultPrevented = true; });
  event.stopImmediatePropagation = event.stopImmediatePropagation ?? (() => { event._stopped = true; });
  event.stopPropagation = event.stopPropagation ?? (() => { event._stopped = true; });
  // capture: root..target
  for (const node of [...path].reverse()) {
    for (const l of [...(node._listeners ?? [])]) {
      if (l.type !== event.type) continue;
      if (!l.capture) continue;
      event.currentTarget = node;
      l.fn.call(node, event);
      if (event._stopped) return;
    }
  }
  // bubble: target..root
  for (const node of path) {
    for (const l of [...(node._listeners ?? [])]) {
      if (l.type !== event.type) continue;
      if (l.capture) continue;
      event.currentTarget = node;
      l.fn.call(node, event);
      if (event._stopped) return;
    }
  }
}

class MutationObserverStub {
  constructor(cb) { this.cb = cb; this._target = null; }
  observe(target) { this._target = target; observers.push(this); }
  disconnect() { this._target = null; const i = observers.indexOf(this); if (i >= 0) observers.splice(i, 1); }
  /** 测试驱动：模拟一批 addedNodes。 */
  trigger(added) { if (this._target) this.cb([{ addedNodes: added }], this); }
}
const observers = [];

//#endregion

//#region React shim（client.js 只用 createElement / Fragment / useState / useEffect）

const reactShim = {
  Fragment: Symbol('Fragment'),
  createElement(tag, props, ...children) {
    return { $$typeof: 'el', type: tag, props: { ...(props ?? {}), children: children.length > 1 ? children : children[0] } };
  },
  useState(init) { return [typeof init === 'function' ? init() : init, () => {}]; },
  useEffect() {},
};

//#endregion

//#region 模块装载

let mod = null;
const rpcCalls = [];
let rpcResponder = () => ({ ok: true, value: {} });

function setResponder(fn) { rpcResponder = fn; }

before(async () => {
  globalThis.document = doc;
  globalThis.MutationObserver = MutationObserverStub;
  globalThis.Node = { ELEMENT_NODE: 1 };
  globalThis.Element = function Element() {};
  globalThis.KeyboardEvent = class { constructor(type, init = {}) { Object.assign(this, { type, ...init }); } };
  globalThis.PointerEvent = class { constructor(type, init = {}) { Object.assign(this, { type, ...init }); } };
  // Node 22 的 globalThis.navigator 是只读 getter，必须用 defineProperty 覆盖。
  Object.defineProperty(globalThis, 'navigator', {
    value: { language: 'zh-CN' },
    writable: true,
    configurable: true,
  });
  globalThis.window = {
    confirm: () => true,
    addEventListener() {},
    removeEventListener() {},
  };
  const loader = {
    // client.js 的 factory 既写 module.exports 也把它 return 出来；
    // 取返回值最稳（与官方 __ModuleLoader__ 的约定一致）。
    load(entry) {
      mod = entry.factory((name) => {
        if (name === 'react') return reactShim;
        throw new Error(`unexpected require(${name})`);
      });
    },
  };
  globalThis.window.__ModuleLoader__ = loader;

  await import('../client/client.js');
  assert.ok(mod && typeof mod.apply === 'function', 'client module must export apply()');
});

after(() => {
  for (const o of observers.slice()) o.disconnect();
});

/** 构造一个可用的 ctx（connection.rpc.call 记录到 rpcCalls）。 */
function makeCtx() {
  return {
    connection: {
      rpc: {
        async call(_channel, endpoint, payload) {
          rpcCalls.push({ endpoint, payload });
          return rpcResponder(endpoint, payload);
        },
      },
    },
    get: () => undefined,
    slots: undefined,
    effect(fn) {
      const dispose = typeof fn === 'function' ? fn() : undefined;
      effects.push(dispose);
      return dispose;
    },
  };
}
const effects = [];
let ctx = null;

/** 模拟宿主废弃本插件 fiber：执行 teardown，之后再装载应当重新生效。 */
function unmount() {
  for (const dispose of effects.splice(0)) {
    if (typeof dispose === 'function') dispose();
  }
}

function resetDom() {
  unmount();
  doc._body.childNodes = [];
  doc._listeners = [];
  rpcCalls.length = 0;
  for (const o of observers.slice()) o.disconnect();
  if (globalThis.window.__wsmDebug !== undefined) delete globalThis.window.__wsmDebug;
}

function mount() {
  ctx = makeCtx();
  mod.apply(ctx);
  return ctx;
}

/** 造一个工作区标题行。 */
function header(title, expanded = true) {
  const el = createElement('div');
  el.setAttribute('role', 'treeitem');
  el.setAttribute('aria-expanded', String(expanded));
  el.textContent = title;
  return el;
}

/** 造一个会话行；id 通过 fiber 上的 node 暴露（官方权威通道）。 */
function sessionRow(title, id, { hidden = false, fiberNode = true } = {}) {
  const el = createElement('div');
  el.setAttribute('role', 'treeitem');
  el.setAttribute('aria-selected', 'false');
  el.textContent = title;
  if (hidden) el._hidden = true; // 用 offsetParent 表达不可见
  if (fiberNode && id) {
    Object.defineProperty(el, '__reactFiber$t', { value: { memoizedProps: { node: { id, blank: false, updatedAt: 1 } }, return: null } });
  }
  return el;
}

/** 把行挂进 body（维护可见性：_hidden 的行 offsetParent 为 null）。 */
function attach(...els) {
  for (const el of els) doc._body.appendChild(el);
  // 让 _hidden 行的 offsetParent 返回 null
  for (const el of descendants(doc._body)) {
    if (el._hidden) {
      Object.defineProperty(el, 'offsetParent', { get: () => null, configurable: true });
      // 递归隐藏子行
    }
  }
}

//#endregion

//#region 夹具：一个工作区 + N 个会话行

function fixture({ rows, workspaces, scanItems }) {
  attach(header('proj-alpha'), ...rows);
  const ws = workspaces ?? [
    { workspaceId: 'wid-a', path: 'C:/proj-alpha', title: 'proj-alpha', sessionIds: rows.map((r) => r._sid).filter(Boolean) },
    { workspaceId: 'wid-b', path: 'C:/proj-beta', title: 'proj-beta', sessionIds: [] },
  ];
  setResponder((endpoint) => {
    if (endpoint === 'mover.workspaces') return { ok: true, value: { items: ws, archivedSessionIds: [] } };
    if (endpoint === 'mover.scan') return { ok: true, value: { items: scanItems ?? [], counts: {}, scanned: 0, truncated: false } };
    if (endpoint === 'mover.move' || endpoint === 'mover.moveMany') return { ok: true, value: { movedCount: 1, attachedCount: 0, failedCount: 0, results: [] } };
    return { ok: true, value: {} };
  });
  return { ws };
}

/** 走一遍真实拖拽序列：dragstart → dragover(target) → drop(target) → 点确认。 */
async function dragDrop(sourceRow, targetHeader, dataTransferId, options = {}) {
  const dt = { getData: (type) => (type === 'text/plain' ? dataTransferId : '') };
  dispatch({ type: 'dragstart', target: sourceRow, dataTransfer: dt });
  await Promise.resolve();
  dispatch({ type: 'dragover', target: targetHeader, dataTransfer: dt, preventDefault() {}, stopImmediatePropagation() {} });
  await new Promise((r) => setTimeout(r, 0)); // 等 dragover 里的 fetchWorkspaces
  dispatch({ type: 'drop', target: targetHeader, dataTransfer: dt, preventDefault() {}, stopImmediatePropagation() {} });
  await new Promise((r) => setTimeout(r, 0));
  // drop 处理是 async：确认框会 await，必须在这里驱动。
  if (options.confirm !== false) {
    const overlay = doc._body.querySelector('.wsm-overlay');
    const ok = overlay?.querySelector('.wsm-ok');
    if (ok) dispatch({ type: 'click', target: ok });
    await new Promise((r) => setTimeout(r, 0));
  }
}

/** 上次 drop 留下的确认框文本（用于断言"跳过了几行"这类提示）。 */
function lastDialogText() {
  const overlay = doc._body.querySelector('.wsm-overlay');
  return overlay ? overlay.textContent : null;
}

function moveCalls() {
  return rpcCalls.filter((c) => c.endpoint === 'mover.move' || c.endpoint === 'mover.moveMany');
}

//#endregion

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

test('模块导出 apply / inject，且 apply 不抛错', () => {
  resetDom();
  mount();
  assert.deepEqual(mod.inject, ['connection', 'slots']);
});

test('热重载：卸载再装载不得让 document 监听器净增长（teardown 回归）', () => {
  resetDom();
  mount();
  const afterFirst = doc._listeners.length;
  assert.ok(afterFirst > 0, '首次 apply 必须注册监听器');
  unmount();
  assert.equal(doc._listeners.length, 0, 'teardown 必须释放全部 document 监听器');
  mount();
  assert.equal(doc._listeners.length, afterFirst,
    `重新装载后监听器数量应与首次相同：${afterFirst} -> ${doc._listeners.length}`);
});

test('未卸载就重复装载时不得叠加第二份监听器（防重复实例）', () => {
  resetDom();
  mount();
  const afterFirst = doc._listeners.length;
  mount(); // 宿主若未废弃旧 fiber 就再次调用 apply
  assert.equal(doc._listeners.length, afterFirst,
    `重复 apply 不得叠加：${afterFirst} -> ${doc._listeners.length}`);
});

test('拖拽跨组移动：经权威 fiber 通道解析出正确 sessionId', async () => {
  resetDom();
  mount();
  const row = sessionRow('Alpha discussion', 'session-aaa');
  const beta = header('proj-beta');
  fixture({ rows: [row] });
  attach(beta);
  await dragDrop(row, beta, 'session-aaa');
  const calls = moveCalls();
  assert.equal(calls.length, 1, '应当恰好发起一次移动');
  assert.equal(calls[0].payload.sessionId, 'session-aaa');
  assert.equal(calls[0].payload.targetWorkspaceId, 'wid-b');
});

test('兜底映射错配时不得把错配 id 当成真实会话移动（P2 回归）', async () => {
  resetDom();
  mount();
  const row1 = sessionRow('行一', null, { fiberNode: false });
  const row2 = sessionRow('行二', 'session-bbb');
  const beta = header('proj-beta');
  fixture({
    rows: [row1, row2],
    workspaces: [
      { workspaceId: 'wid-a', path: 'C:/proj-alpha', title: 'proj-alpha', sessionIds: ['session-aaa', 'session-bbb'] },
      { workspaceId: 'wid-b', path: 'C:/proj-beta', title: 'proj-beta', sessionIds: [] },
    ],
    scanItems: [
      { sessionId: 'session-aaa', title: '完全不同的标题甲' },
      { sessionId: 'session-bbb', title: '完全不同的标题乙' },
    ],
  });
  attach(beta);
  window.confirm = () => true;
  await dragDrop(row1, beta, 'session-bbb');
  const ids = moveCalls().flatMap((c) => (c.payload.sessions ?? [c.payload]).map((s) => s?.sessionId)).filter(Boolean);
  // 兜底映射会把行二错配到 remaining 的第一个 id（session-aaa）。它绝不能出现在 payload 里。
  assert.ok(!ids.includes('session-aaa'),
    `错配出的 id 绝不能进入移动清单（实际 ids: ${JSON.stringify(ids)}）`);
  assert.ok(ids.includes('session-bbb'), `拖起行的权威 id 必须被移动（实际 ids: ${JSON.stringify(ids)}）`);
});

test('工作区解析必须自证：标题与路径都不匹配时不得按 DOM 序号回退（P3.1 回归）', async () => {
  resetDom();
  mount();
  const row = sessionRow('Alpha discussion', 'session-aaa');
  // 侧边栏只剩一个分组，且它的行文本与注册表里任何 title/path 都不匹配
  //（例如分组标题被插件改写）。注册表第 0 项是目录已失效的 wid-hidden。
  // 旧实现会回退到「DOM 序号 0」= wid-hidden，把会话搬进一个不存在的目录分组。
  const orphanHeader = header('某个侧边栏私有标题');
  fixture({
    rows: [row],
    workspaces: [
      { workspaceId: 'wid-hidden', path: 'C:/gone', title: '已失效分组', sessionIds: [] },
      { workspaceId: 'wid-b', path: 'C:/proj-beta', title: 'proj-beta', sessionIds: [] },
    ],
  });
  attach(orphanHeader);
  await dragDrop(row, orphanHeader, 'session-aaa');
  const calls = moveCalls();
  assert.notEqual(calls[0]?.payload?.targetWorkspaceId, 'wid-hidden',
    '不得把 DOM 第 0 项当作目标（那是注册表里的失效分组）');
  assert.equal(calls.length, 0, '标题与路径都不匹配时必须中止，不得按序号回退');
});

test('弹窗 Escape 关闭并释放 keydown 监听器', async () => {
  resetDom();
  mount();
  const row = sessionRow('Alpha discussion', 'session-aaa');
  const beta = header('proj-beta');
  fixture({ rows: [row] });
  attach(beta);
  window.confirm = () => true;
  const dt = { getData: () => 'session-aaa' };
  dispatch({ type: 'dragstart', target: row, dataTransfer: dt });
  dispatch({ type: 'dragover', target: beta, dataTransfer: dt, preventDefault() {}, stopImmediatePropagation() {} });
  await new Promise((r) => setTimeout(r, 0));
  dispatch({ type: 'drop', target: beta, dataTransfer: dt, preventDefault() {}, stopImmediatePropagation() {} });
  await new Promise((r) => setTimeout(r, 0));
  const overlay = doc._body.querySelector('.wsm-overlay');
  assert.ok(overlay, '应当出现确认弹窗');
  const before = doc._listeners.length;
  dispatch({ type: 'keydown', target: doc._body, key: 'Escape' });
  assert.equal(doc._body.querySelector('.wsm-overlay'), null, 'Escape 应关闭弹窗');
  assert.equal(doc._listeners.length, before - 1, '关闭后应移除 keydown 监听器');
  assert.equal(moveCalls().length, 0, '取消后不得发起移动');
});

test('弹窗具有可访问名称，且焦点落在弹窗内（aria-labelledby 指向标题）', async () => {
  resetDom();
  mount();
  const row = sessionRow('Alpha discussion', 'session-aaa');
  const beta = header('proj-beta');
  fixture({ rows: [row] });
  attach(beta);
  window.confirm = () => true;
  const dt = { getData: () => 'session-aaa' };
  dispatch({ type: 'dragstart', target: row, dataTransfer: dt });
  dispatch({ type: 'dragover', target: beta, dataTransfer: dt, preventDefault() {}, stopImmediatePropagation() {} });
  await new Promise((r) => setTimeout(r, 0));
  dispatch({ type: 'drop', target: beta, dataTransfer: dt, preventDefault() {}, stopImmediatePropagation() {} });
  await new Promise((r) => setTimeout(r, 0));

  // 弹窗此刻仍然打开——在它关闭之前完成可达性断言。
  const card = doc._body.querySelector('.wsm-card');
  assert.ok(card, '应当出现弹窗卡片');
  assert.equal(card.getAttribute('role'), 'dialog');
  assert.equal(card.getAttribute('aria-modal'), 'true');
  const labelledBy = card.getAttribute('aria-labelledby');
  assert.ok(labelledBy, 'role=dialog 必须有 aria-labelledby');
  const title = doc.getElementById(labelledBy);
  assert.ok(title, `aria-labelledby="${labelledBy}" 必须指向真实存在的标题元素`);
  assert.ok(title.textContent.length > 0, '标题元素必须有可读文本');
  assert.ok(card.contains(doc.activeElement), '打开弹窗后焦点必须落在弹窗内');

  // 收尾：关闭弹窗，避免影响后续用例
  dispatch({ type: 'click', target: doc._body.querySelector('.wsm-cancel') });
  await new Promise((r) => setTimeout(r, 0));
});

test('RPC 失败矩阵：busy / rollback-failed / 抛错 都不重试', async () => {
  for (const scenario of [
    { name: 'busy', res: { ok: false, error: { code: 'busy', message: 'session is busy' } } },
    { name: 'rollback-failed', res: { ok: false, error: { code: 'rollback-failed', message: 'rolled back' } } },
    { name: 'throw', throw: new Error('cannot get required service "connection" in inactive context') },
  ]) {
    resetDom();
    mount();
    const row = sessionRow('Alpha discussion', 'session-aaa');
    const beta = header('proj-beta');
    fixture({ rows: [row] });
    attach(beta);
    window.confirm = () => true;
    const base = rpcResponder;
    setResponder((endpoint, payload) => {
      if (endpoint === 'mover.move') {
        if (scenario.throw) throw scenario.throw;
        return scenario.res;
      }
      return base(endpoint, payload);
    });
    await dragDrop(row, beta, 'session-aaa');
    assert.equal(moveCalls().length, 1, `${scenario.name}: 失败后不得重试`);
    // 不抛到调用方（toast 呈现即可）
    assert.ok(true, `${scenario.name}: 未把异常抛给宿主`);
  }
});

test('空 value / 空 results 不抛错', async () => {
  resetDom();
  mount();
  const row = sessionRow('Alpha discussion', 'session-aaa');
  const beta = header('proj-beta');
  fixture({ rows: [row] });
  attach(beta);
  window.confirm = () => true;
  setResponder((endpoint, payload) => {
    if (endpoint === 'mover.move') return { ok: true, value: undefined };
    if (endpoint === 'mover.workspaces') return { ok: true, value: { items: [
      { workspaceId: 'wid-a', path: 'C:/proj-alpha', title: 'proj-alpha', sessionIds: ['session-aaa'] },
      { workspaceId: 'wid-b', path: 'C:/proj-beta', title: 'proj-beta', sessionIds: [] },
    ] } };
    if (endpoint === 'mover.scan') return { ok: true, value: { items: [], counts: {} } };
    return { ok: true, value: {} };
  });
  await dragDrop(row, beta, 'session-aaa');
  assert.equal(moveCalls().length, 1);
});
