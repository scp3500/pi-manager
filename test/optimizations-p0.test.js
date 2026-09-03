const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const os = require('os');

const { safePublicPath } = require('../server');
const usageApi = require('../lib/usage');
const openvl = require('../lib/openvl');
const { headRequest } = require('../lib/ops');

describe('safePublicPath malformed URI', () => {
  it('returns null without throwing on malformed percent-encoding', () => {
    let threw = false;
    let result;
    try {
      result = safePublicPath('/%E0%A4%A');
    } catch (e) {
      threw = true;
    }
    assert.equal(threw, false);
    assert.equal(result, null);
  });
});

describe('usage parseSessionFile skip giant non-usage lines', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-mgr-usage-'));
  const file = path.join(tmp, 'sess.jsonl');

  after(() => {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('skips huge payloads without usage/session/model_change and still parses usage', () => {
    const giant = JSON.stringify({
      type: 'message',
      message: {
        role: 'user',
        content: 'X'.repeat(200000),
      },
    });
    assert.ok(!giant.includes('"usage"'));
    assert.ok(!giant.includes('"session"'));
    assert.ok(!giant.includes('"model_change"'));

    const sessionLine = JSON.stringify({
      type: 'session',
      id: 's-test-1',
      cwd: '/tmp/demo',
    });
    const usageLine = JSON.stringify({
      type: 'message',
      timestamp: '2024-01-01T00:00:00.000Z',
      message: {
        role: 'assistant',
        provider: 'openai',
        model: 'gpt-test',
        timestamp: Date.parse('2024-01-01T00:00:00.000Z'),
        usage: {
          input: 11,
          output: 22,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 33,
          cost: { total: 0.01 },
        },
      },
    });

    fs.writeFileSync(file, [sessionLine, giant, usageLine].join('\n') + '\n', 'utf8');
    const started = Date.now();
    const { records, matched } = usageApi.parseSessionFile(file);
    const elapsed = Date.now() - started;
    assert.equal(matched, true);
    assert.ok(records.length >= 1);
    assert.equal(records[0].in, 11);
    assert.equal(records[0].out, 22);
    assert.equal(records[0].sid, 's-test-1');
    // Should finish quickly even with a 200KB+ line (skip without JSON.parse)
    assert.ok(elapsed < 2000, 'parse too slow: ' + elapsed + 'ms');
  });
});

describe('openvl.runDoctor async', () => {
  it('returns a Promise', async () => {
    const ret = openvl.runDoctor();
    assert.ok(ret && typeof ret.then === 'function');
    const result = await ret;
    assert.equal(typeof result, 'object');
    assert.equal(typeof result.ok, 'boolean');
    assert.equal(typeof result.output, 'string');
  });
});

describe('headRequest extraHeaders', () => {
  it('forwards extraHeaders to the outbound request', async () => {
    let sawAuth = '';
    let sawCustom = '';
    const probe = http.createServer((req, res) => {
      sawAuth = req.headers.authorization || '';
      sawCustom = req.headers['x-test-header'] || '';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
    await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const p = probe.address().port;
    try {
      const result = await headRequest('http://127.0.0.1:' + p + '/models', 3000, {
        Authorization: 'Bearer test-key-123',
        'x-test-header': 'pi-mgr',
      });
      assert.equal(result.ok, true);
      assert.equal(sawAuth, 'Bearer test-key-123');
      assert.equal(sawCustom, 'pi-mgr');
    } finally {
      await new Promise((resolve) => probe.close(resolve));
    }
  });
});
