const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const USAGE_FILE = path.join(__dirname, '../lib/usage.js');

/** Sandbox lib/usage.js with a mock fs so the aggregation hot path can be
 *  counted without touching the real disk. */
function loadUsageSandbox({ statSync, readFileSync }) {
  const sandbox = {
    require: (id) => {
      if (id === 'fs') {
        return {
          statSync,
          readFileSync,
          existsSync: () => false,
          writeFileSync: () => {},
          renameSync: () => {},
          unlinkSync: () => {},
          mkdirSync: () => {},
        };
      }
      if (id === 'path') return path;
      if (id === './config') {
        return { PI_AGENT_DIR: 'agent', MODELS_FILE: 'C:/sandbox/models.json' };
      }
      return {};
    },
    module: { exports: {} },
    process,
    console,
    __dirname: path.dirname(USAGE_FILE),
    __filename: USAGE_FILE,
  };
  vm.runInNewContext(fs.readFileSync(USAGE_FILE, 'utf8'), sandbox, { filename: USAGE_FILE });
  return sandbox;
}

describe('usage aggregation cost', () => {
  test('models.json is stat-ed O(1), not once per record', () => {
    const RECORDS = 400;
    let modelStats = 0;
    const sandbox = loadUsageSandbox({
      statSync: (p) => {
        if (String(p).endsWith('models.json')) modelStats += 1;
        return { size: 1, mtimeMs: 1234 };
      },
      readFileSync: () =>
        JSON.stringify({ providers: { p: { models: [{ id: 'm', costUnit: 'CNY' }] } } }),
    });

    // Stub only the disk reader; keep the real aggregation under test.
    vm.runInContext(
      [
        'const recs = [];',
        'for (let i = 0; i < ' + RECORDS + '; i++) {',
        "  recs.push({ ts: 1700000000000, sid: 's' + i, provider: 'p', model: 'm', key: 'p/m',",
        '    in: 1, out: 1, cR: 0, cW: 0, reasoning: 0, tot: 2, cost: 0.01 });',
        '}',
        "loadAllRecords = () => ({ records: recs, source: 'test', sessionDir: 'x',",
        '  filesScanned: 1, reused: 0, parsed: 0 });',
      ].join('\n'),
      sandbox
    );

    const report = sandbox.module.exports.collectUsage({ window: 'all' });
    assert.equal(report.requests, RECORDS);
    // pre-fix: one statSync(MODELS_FILE) per record (20k syscalls on a real install)
    assert.ok(
      modelStats <= 2,
      'models.json stat-ed ' + modelStats + ' times for ' + RECORDS + ' records'
    );
  });
});

describe('usage disk index reuse (real fs, isolated tmp)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-mgr-usecache-'));
  const sessions = path.join(tmp, 'sessions');
  fs.mkdirSync(sessions, { recursive: true });

  const usageLine = (ts, total) =>
    JSON.stringify({
      type: 'message',
      timestamp: new Date(ts).toISOString(),
      message: {
        role: 'assistant',
        provider: 'p',
        model: 'm',
        timestamp: ts,
        usage: { input: 5, output: 6, totalTokens: total, cost: { total: 0.02 } },
      },
    });

  fs.writeFileSync(
    path.join(sessions, 'a.jsonl'),
    usageLine(Date.parse('2024-01-01T00:00:00.000Z'), 11) + '\n',
    'utf8'
  );
  fs.writeFileSync(
    path.join(sessions, 'b.jsonl'),
    usageLine(Date.parse('2024-01-02T00:00:00.000Z'), 13) + '\n',
    'utf8'
  );
  fs.writeFileSync(
    path.join(tmp, 'models.json'),
    JSON.stringify({ providers: { p: { models: [{ id: 'm', costUnit: 'CNY' }] } } }),
    'utf8'
  );

  process.env.PI_AGENT_DIR = path.join(tmp, 'agent');
  process.env.SESSIONS_DIR = sessions;
  process.env.MODELS_FILE = path.join(tmp, 'models.json');
  process.env.PI_MANAGER_USAGE_CACHE_DIR = path.join(tmp, 'cache');

  let usage = null;
  const getUsage = () => (usage = usage || require('../lib/usage'));

  test('first collect parses every file and writes the index', () => {
    const first = getUsage().collectUsage({ window: 'all' });
    assert.equal(first.requests, 2);
    assert.equal(first.totalTokens, 24);
    assert.equal(first.parsedFiles, 2);
    assert.ok(fs.existsSync(require('../lib/usage').DISK_CACHE_PATH));
  });

  test('force refresh reuses the disk index instead of re-parsing everything', () => {
    const forced = getUsage().collectUsage({ window: 'all', force: true });
    assert.equal(forced.requests, 2);
    assert.equal(forced.totalTokens, 24);
    // pre-fix: force threw the index away and re-parsed ~440MB on every click
    assert.equal(forced.parsedFiles, 0, 'force must not discard the disk index');
    assert.equal(forced.reusedFiles, 2);
  });

  test('clearUsageCache then rebuild re-parses from scratch with identical numbers', () => {
    const u = getUsage();
    u.clearUsageCache();
    assert.ok(!fs.existsSync(u.DISK_CACHE_PATH), 'clear must drop the disk index');
    const rebuilt = u.collectUsage({ window: 'all', force: true });
    assert.equal(rebuilt.parsedFiles, 2, 'rebuild must rescan every file');
    assert.equal(rebuilt.requests, 2);
    assert.equal(rebuilt.totalTokens, 24);
    assert.equal(rebuilt.costTotal, 0.04);
    assert.ok(fs.existsSync(u.DISK_CACHE_PATH), 'rebuild must rewrite the index');
  });

  test('index cache dirtied by a changed file is re-parsed, unchanged ones reused', () => {
    const before = getUsage().collectUsage({ window: 'all', force: true });
    assert.equal(before.parsedFiles, 0);
    fs.appendFileSync(
      path.join(sessions, 'b.jsonl'),
      usageLine(Date.parse('2024-01-03T00:00:00.000Z'), 7) + '\n',
      'utf8'
    );
    const after = getUsage().collectUsage({ window: 'all', force: true });
    assert.equal(after.parsedFiles, 1, 'only the touched file should re-parse');
    assert.equal(after.reusedFiles, 1);
    assert.equal(after.requests, 3);
    assert.equal(after.totalTokens, 31);
  });
});

describe('usage index belongs to one SESSIONS_DIR', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-mgr-usage-dir-'));
  const first = path.join(tmp, 'sessions-a');
  const second = path.join(tmp, 'sessions-b');
  fs.mkdirSync(first, { recursive: true });
  fs.mkdirSync(second, { recursive: true });
  const line = (ts, total) =>
    JSON.stringify({
      type: 'message',
      timestamp: new Date(ts).toISOString(),
      message: {
        role: 'assistant',
        provider: 'p',
        model: 'm',
        timestamp: ts,
        usage: { input: 1, output: 1, totalTokens: total, cost: { total: 0.01 } },
      },
    });
  fs.writeFileSync(path.join(first, 'a.jsonl'), line(Date.parse('2024-02-01T00:00:00Z'), 11) + '\n', 'utf8');
  fs.writeFileSync(
    path.join(second, 'a.jsonl'),
    line(Date.parse('2024-02-01T00:00:00Z'), 11) + '\n' + line(Date.parse('2024-02-02T00:00:00Z'), 22) + '\n',
    'utf8'
  );
  fs.writeFileSync(
    path.join(tmp, 'models.json'),
    JSON.stringify({ providers: { p: { models: [{ id: 'm', costUnit: 'CNY' }] } } }),
    'utf8'
  );

  // one cache dir for both, so the second run reads the first run's index
  process.env.PI_AGENT_DIR = path.join(tmp, 'agent');
  process.env.MODELS_FILE = path.join(tmp, 'models.json');
  process.env.PI_MANAGER_USAGE_CACHE_DIR = path.join(tmp, 'cache');

  function freshUsage(sessionDir) {
    process.env.SESSIONS_DIR = sessionDir;
    for (const key of Object.keys(require.cache)) {
      const n = key.replace(/\\/g, '/');
      if (/\/pi-manager\/lib\/(usage|config)\.js$/.test(n)) delete require.cache[key];
    }
    return require('../lib/usage');
  }

  test('an index pointing at another SESSIONS_DIR is discarded, not reused', () => {
    const a = freshUsage(first).collectUsage({ window: 'all' });
    assert.equal(a.requests, 1);
    assert.equal(a.totalTokens, 11);

    // same cache dir, different session dir: the stale index must not be trusted
    const b = freshUsage(second).collectUsage({ window: 'all' });
    assert.equal(b.requests, 2);
    assert.equal(b.totalTokens, 33);
    assert.equal(b.parsedFiles, 1, 'the new session dir must be scanned');
    assert.equal(b.reusedFiles, 0);
  });
});
