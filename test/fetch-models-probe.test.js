const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const os = require('os');

// config.js 在模块加载时读取 MODELS_FILE，必须先于 require 设置
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-mgr-probe-'));
process.env.MODELS_FILE = path.join(tmp, 'models.json');
process.env.PI_AGENT_DIR = tmp;

const { testProviderConnection } = require('../lib/fetch-models');

describe('testProviderConnection 跟随模型级 API 覆盖', () => {
  let server;
  let port;
  const hits = [];

  async function startServer() {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        let parsed = {};
        try {
          parsed = body ? JSON.parse(body) : {};
        } catch {
          /* ignore */
        }
        hits.push({
          url: req.url,
          method: req.method,
          headers: req.headers,
          body: parsed,
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
  }

  before(async () => {
    await startServer();
    fs.writeFileSync(
      process.env.MODELS_FILE,
      JSON.stringify(
        {
          providers: {
            'test-go': {
              baseUrl: 'http://127.0.0.1:' + port + '/v1',
              api: 'openai-completions',
              apiKey: 'sk-test',
              headers: { 'X-Provider': '1' },
              models: [
                { id: 'muse-x', api: 'openai-responses' },
                { id: 'muse-y', api: 'google-generative-ai' },
                { id: 'plain-m', headers: { 'X-Model': 'm' } },
              ],
            },
          },
        },
        null,
        2
      ),
      'utf8'
    );
  });

  after(() => {
    try {
      server && server.close();
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('模型级 api: openai-responses 覆盖 → 探测走 /v1/responses + input[] 流式 payload', async () => {
    hits.length = 0;
    const r = await testProviderConnection('test-go', { model: 'muse-x' });
    assert.equal(r.ok, true);
    assert.equal(r.api, 'openai-responses');
    assert.match(r.endpoint, /\/v1\/responses$/);

    const hit = hits.find((h) => h.url.includes('/responses'));
    assert.ok(hit, '应请求 /responses endpoint');
    assert.equal(hit.body.model, 'muse-x');
    assert.ok(Array.isArray(hit.body.input), 'responses payload 应含 input 数组');
    assert.equal(hit.body.input[0].role, 'user');
    assert.equal(hit.body.stream, true, 'responses 探测应流式');
    assert.equal(hit.body.messages, undefined, '不应使用 chat 格式');
    assert.equal(hit.headers.authorization, 'Bearer sk-test');
  });

  it('模型级 api: google-generative-ai 覆盖 → 走 :generateContent + x-goog-api-key', async () => {
    hits.length = 0;
    const r = await testProviderConnection('test-go', { model: 'muse-y' });
    assert.equal(r.ok, true);
    assert.equal(r.api, 'google-generative-ai');
    assert.match(r.endpoint, /\/models\/muse-y:generateContent$/);

    const hit = hits.find((h) => h.url.includes('generateContent'));
    assert.ok(hit, '应请求 generateContent endpoint');
    assert.ok(Array.isArray(hit.body.contents), 'gemini payload 应含 contents');
    assert.equal(hit.headers['x-goog-api-key'], 'sk-test');
    assert.equal(hit.headers.authorization, undefined);
  });

  it('无模型级覆盖 → 按 provider 默认格式 + 模型级 headers 合并', async () => {
    hits.length = 0;
    const r = await testProviderConnection('test-go', { model: 'plain-m' });
    assert.equal(r.ok, true);
    assert.equal(r.api, 'openai-completions');
    assert.match(r.endpoint, /\/v1\/chat\/completions$/);

    const hit = hits.find((h) => h.url.includes('chat/completions'));
    assert.ok(hit, '应请求 chat completions endpoint');
    assert.equal(hit.body.model, 'plain-m');
    assert.ok(Array.isArray(hit.body.messages), 'chat payload 应含 messages');
    assert.equal(hit.body.stream, false);
    assert.equal(hit.headers['x-provider'], '1');
    assert.equal(hit.headers['x-model'], 'm', '模型级 headers 应合并到请求头');
  });

  it('未指定 model → 默认取第一个模型（有覆盖时跟随覆盖格式）', async () => {
    hits.length = 0;
    const r = await testProviderConnection('test-go');
    assert.equal(r.ok, true);
    assert.match(r.endpoint, /\/v1\/responses$/);
    assert.equal(r.api, 'openai-responses');
  });
});
