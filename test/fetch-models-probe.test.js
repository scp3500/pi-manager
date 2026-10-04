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

const { testProviderConnection, knownAnthropicBaseUrl } = require('../lib/fetch-models');

describe('knownAnthropicBaseUrl 补齐厂商 anthropic 前缀', () => {
  it('DeepSeek 根路径 / 带 /v1 / 带 /v1/messages 都归一到 /anthropic/v1/messages', () => {
    for (const b of [
      'https://api.deepseek.com',
      'https://api.deepseek.com/',
      'https://api.deepseek.com/v1',
      'https://api.deepseek.com/v1/messages',
    ]) {
      const r = knownAnthropicBaseUrl(b);
      assert.ok(r, b + ' 应给出补全结果');
      assert.equal(r.endpoint, 'https://api.deepseek.com/anthropic/v1/messages', b);
      assert.equal(r.baseUrl, 'https://api.deepseek.com/anthropic', b);
    }
  });

  it('已带前缀 → 返回 null（不重复纠偏）', () => {
    assert.equal(knownAnthropicBaseUrl('https://api.deepseek.com/anthropic'), null);
    assert.equal(knownAnthropicBaseUrl('https://api.deepseek.com/anthropic/v1'), null);
  });

  it('未知厂商 → null，不猜测', () => {
    assert.equal(knownAnthropicBaseUrl('https://api.anthropic.com'), null);
    assert.equal(knownAnthropicBaseUrl('not a url'), null);
  });
});

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
            'test-anthropic': {
              // 无 /v1 后缀：验证 anthropic 分支会自己拼 /v1/messages
              baseUrl: 'http://127.0.0.1:' + port,
              api: 'anthropic-messages',
              apiKey: 'sk-ant-test',
              models: [{ id: 'claude-x' }],
            },
            'test-anthropic-bare': {
              baseUrl: 'http://127.0.0.1:' + port + '/anthropic',
              api: 'anthropic-messages',
              apiKey: 'sk-ant-test',
              models: [{ id: 'claude-y' }],
            },
            'test-unsupported': {
              baseUrl: 'http://127.0.0.1:' + port + '/v1',
              api: 'mistral-conversations',
              apiKey: 'sk-test',
              models: [{ id: 'm-un' }],
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

  it('api: anthropic-messages → 走 /v1/messages + anthropic-version，不再降级成 chat/completions', async () => {
    hits.length = 0;
    const r = await testProviderConnection('test-anthropic', { model: 'claude-x' });
    assert.equal(r.ok, true);
    assert.equal(r.api, 'anthropic-messages');
    assert.equal(r.apiUsed, 'anthropic-messages');
    assert.match(r.endpoint, /\/v1\/messages$/);
    assert.doesNotMatch(r.endpoint, /chat\/completions/);

    const hit = hits.find((h) => h.url.includes('/v1/messages'));
    assert.ok(hit, '应请求 /v1/messages endpoint');
    assert.equal(hit.body.model, 'claude-x');
    assert.equal(hit.body.max_tokens, 1);
    assert.ok(Array.isArray(hit.body.messages), 'anthropic payload 应含 messages');
    assert.equal(hit.body.input, undefined, '不应使用 responses 格式');
    assert.equal(hit.body.stream, undefined, 'anthropic 探测不需要 stream');
    assert.equal(hit.headers['anthropic-version'], '2023-06-01');
    assert.equal(hit.headers.authorization, 'Bearer sk-ant-test');
  });

  it('anthropic baseUrl 带额外路径 → 规范化为 /v1/messages，不吞掉同名段', async () => {
    hits.length = 0;
    const r = await testProviderConnection('test-anthropic-bare', { model: 'claude-y' });
    assert.equal(r.ok, true);
    assert.match(r.endpoint, /\/v1\/messages$/);
  });

  it('未实现协议 → 显式 ok:false，不允许静默降级出假绿灯', async () => {
    hits.length = 0;
    const r = await testProviderConnection('test-unsupported', { model: 'm-un' });
    assert.equal(r.ok, false);
    assert.equal(r.supported, false);
    assert.equal(r.api, 'mistral-conversations');
    assert.equal(r.apiUsed, null);
    assert.match(r.error, /暂不支持探测/);
    assert.equal(hits.length, 0, '不支持探测时不应发出任何请求');
  });
});
