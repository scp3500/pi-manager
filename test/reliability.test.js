const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

/** fetch Response double. Real Responses expose text(), which api() prefers so it
 *  can tell an empty body apart from an invalid one instead of coercing both to {}. */
function jsonResponse(body, { ok = true, status = 200 } = {}) {
  const payload = body === undefined ? {} : body;
  return { ok, status, text: async () => JSON.stringify(payload), json: async () => payload };
}

function frontend() {
  const elements = new Map();
  function element() {
    const classes = new Set();
    return {
      value: '', textContent: '', innerHTML: '', dataset: {}, style: {}, options: [],
      classList: { contains: (c) => classes.has(c), add: (c) => classes.add(c), remove: (c) => classes.delete(c), toggle(c, on) { if (on) classes.add(c); else classes.delete(c); } },
      addEventListener() {}, appendChild() {}, querySelector() { return element(); }, querySelectorAll: () => [],
      scrollIntoView() {}, focus() {}, setAttribute() {}, remove() {},
    };
  }
  const get = (id) => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
  const events = {};
  const context = {
    console, setTimeout, clearTimeout, AbortController, URLSearchParams,
    document: { querySelector: get, querySelectorAll: () => [], getElementById: (id) => get('#' + id), createElement: element, body: element(), documentElement: element(), addEventListener: (name, fn) => { events[name] = fn; } },
    location: { hash: '#/dashboard' }, history: { replaceState() {} }, localStorage: { getItem: () => '1' },
    confirm: () => false, fetch: async () => jsonResponse({}),
    addEventListener() {},
  };
  context.window = context;
  vm.createContext(context);
  for (const file of ['app.js', 'models-ui.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '../public', file), 'utf8'), context);
  context.showToast = () => {};
  return { context, get, events };
}

test('global save keeps model dirty and reports failure when model PUT fails', async () => {
  const { context: c, get } = frontend();
  c.state.route = 'models';
  c.state.currentProviderId = 'demo';
  c.state.providerDetail = { id: 'demo', models: [] };
  c.state.selectedModelId = 'm';
  get('#p-id').value = 'demo'; get('#m-id').value = 'm';
  c.setDirty('provider', true); c.setDirty('model', true);
  c.state.modelsDirty = true;
  c.fetch = async (url, opts) => {
    if (url.endsWith('/models/m')) return jsonResponse({ error: 'test failure' }, { ok: false, status: 500 });
    const data = opts ? { id: 'demo', models: [] } : [];
    return jsonResponse(data);
  };
  assert.equal(await c.globalSave(), false);
  assert.equal(c.state.modelsDirty, true);
});

test('saving provider does not clear unsaved model edits', async () => {
  const { context: c, get } = frontend();
  c.state.currentProviderId = 'demo'; c.state.providerDetail = { id: 'demo', models: [] };
  get('#p-id').value = 'demo';
  c.setDirty('provider', true); c.setDirty('model', true); c.state.modelsDirty = true;
  c.fetch = async (_url, opts) => jsonResponse(opts ? { id: 'demo', models: [] } : []);
  await c.saveProvider();
  assert.equal(c.state.modelsDirty, true);
});

test('switching models respects rejection and preserves form', () => {
  const { context: c, get } = frontend();
  c.state.currentProviderId = 'demo';
  c.state.providerDetail = { models: [{ id: 'a' }, { id: 'b' }] };
  c.state.selectedModelId = 'a'; get('#m-name').value = 'unsaved';
  c.setDirty('model', true); c.state.modelsDirty = true;
  c.openModelEditor('b');
  assert.equal(c.state.selectedModelId, 'a');
  assert.equal(get('#m-name').value, 'unsaved');
});

test('api aborts a hung request at its deadline', async () => {
  const { context: c } = frontend();
  c.fetch = (_url, opts) => new Promise((_resolve, reject) => {
    opts?.signal?.addEventListener('abort', () => reject(opts.signal.reason));
  });
  const result = await Promise.race([
    c.api('/api/test', { timeoutMs: 10 }).then(() => 'resolved', () => 'aborted'),
    new Promise((resolve) => setTimeout(() => resolve('hung'), 100)),
  ]);
  assert.equal(result, 'aborted');
});

test('global save persists provider and model when both succeed', async () => {
  const { context: c, get } = frontend();
  c.state.route = 'models';
  c.state.currentProviderId = 'demo';
  c.state.providerDetail = { id: 'demo', models: [] };
  c.state.selectedModelId = 'm';
  get('#p-id').value = 'demo'; get('#m-id').value = 'm';
  c.setDirty('provider', true); c.setDirty('model', true); c.state.modelsDirty = true;
  const calls = [];
  c.fetch = async (url, opts) => {
    calls.push([opts?.method, url]);
    if (url.endsWith('/models/m')) return jsonResponse({ model: { id: 'm' } });
    if (opts?.method === 'PUT') return jsonResponse({ id: 'demo', models: [{ id: 'm' }] });
    return jsonResponse([]);
  };
  assert.equal(await c.globalSave(), true);
  assert.equal(c.state.modelsDirty, false);
  assert.ok(calls.some(([m, u]) => m === 'PUT' && u.endsWith('/providers/demo')));
  assert.ok(calls.some(([m, u]) => m === 'PUT' && u.endsWith('/models/m')));
});

test('stale provider response cannot overwrite a newer selection', async () => {
  const { context: c } = frontend();
  c.state.route = 'models';
  const delays = { slow: 60, fast: 5 };
  c.fetch = async (url) => new Promise((resolve) => setTimeout(
    () => resolve(jsonResponse({ id: url.split('/').pop(), models: [] })),
    delays[url.split('/').pop()]
  ));
  const slow = c.selectProvider('slow', false);
  const fast = c.selectProvider('fast', false);
  await Promise.all([slow, fast]);
  assert.equal(c.state.providerDetail.id, 'fast');
  assert.equal(c.state.currentProviderId, 'fast');
});

test('dashboard boot does not request unrelated models or openvl', async () => {
  const { context: c, events } = frontend();
  let unrelated = 0;
  c.loadProviders = async () => { unrelated++; };
  c.loadOpenvl = async () => { unrelated++; };
  await events.DOMContentLoaded();
  assert.equal(unrelated, 0);
  assert.equal(c.state.route, 'dashboard');
});

test('usage refresh aggregates four windows only once', () => {
  const filename = path.join(__dirname, '../lib/usage.js');
  const { createRequire } = require('node:module');
  const c = { require: createRequire(filename), module: { exports: {} }, process, console };
  vm.createContext(c);
  vm.runInContext(fs.readFileSync(filename, 'utf8'), c);
  vm.runInContext('loadAllRecords = () => ({ records: [], source: "test" }); var calls = 0; const originalAggregate = aggregateWindow; aggregateWindow = (...args) => { calls++; return originalAggregate(...args); };', c);
  c.module.exports.collectUsage();
  assert.equal(c.calls, 4);
});

test('tree count and truncation reflect the completed traversal', () => {
  const filename = path.join(__dirname, '../lib/files.js');
  const mockFs = { existsSync: () => true, statSync: () => ({ isDirectory: () => true }), readdirSync: () => ['one.md', 'two.md'], lstatSync: () => ({ isSymbolicLink: () => false, isDirectory: () => false, isFile: () => true, size: 1, mtimeMs: 0 }) };
  const c = { require: (id) => id === 'fs' ? mockFs : id === 'path' ? path : id === './workspaces' ? { getWorkspace: () => ({ rootExists: true, root: 'mock' }) } : id === './path-safety' ? { resolveUnderRoot: () => ({ abs: 'mock', rel: '' }) } : {}, module: { exports: {} } };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), c);
  const result = c.module.exports.listTree('mock', '', { maxEntries: 1 });
  assert.equal(result.count, 1);
  assert.equal(result.truncated, true);
});

test('usage worker scans sessions off the main thread and restarts after close', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-mgr-worker-'));
  const sessions = path.join(tmp, 'sessions');
  fs.mkdirSync(sessions, { recursive: true });
  const line = JSON.stringify({ type: 'message', timestamp: '2024-01-01T00:00:00.000Z', message: { role: 'assistant', provider: 'p', model: 'm', timestamp: Date.parse('2024-01-01T00:00:00.000Z'), usage: { input: 5, output: 6, totalTokens: 11, cost: { total: 0.02 } } } });
  fs.writeFileSync(path.join(sessions, 'a.jsonl'), line + '\n');
  process.env.SESSIONS_DIR = sessions;
  process.env.PI_MANAGER_USAGE_CACHE_DIR = path.join(tmp, 'cache');
  const { createRequire } = require('node:module');
  const req = createRequire(path.join(__dirname, '../lib/usage-service.js'));
  // fresh module instance for this process
  delete req.cache[req.resolve('../lib/usage-service')];
  const service = req('../lib/usage-service');
  try {
    const report = await service.collectUsage({ window: 'all' });
    assert.equal(report.global.requests, 1);
    assert.equal(report.global.costTotal, 0.02);
    await service.clearUsageCache();
    await service.closeUsageWorker();
    const again = await service.collectUsage({ window: 'all' });
    assert.equal(again.global.requests, 1);
    await service.closeUsageWorker();
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});
