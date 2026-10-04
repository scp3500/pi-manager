const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

/**
 * Isolate ALL config paths before loading server / lib modules.
 * Must not touch real ~/.pi/agent or E:/pi_agent/pi_config.
 */
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-mgr-int-'));
const agentDir = path.join(tmpRoot, 'agent');
const configDir = path.join(tmpRoot, 'pi_config');
const agentsDir = path.join(configDir, 'agents');
const sessionsDir = path.join(agentDir, 'sessions');
const promptsDir = path.join(agentDir, 'prompts');
const openvlDir = path.join(tmpRoot, 'openvl');

fs.mkdirSync(agentsDir, { recursive: true });
fs.mkdirSync(sessionsDir, { recursive: true });
fs.mkdirSync(promptsDir, { recursive: true });
fs.mkdirSync(path.join(agentDir, 'skills'), { recursive: true });
fs.mkdirSync(path.join(agentDir, 'extensions'), { recursive: true });
fs.mkdirSync(path.join(agentDir, 'cache', 'manager-chat'), { recursive: true });
fs.mkdirSync(openvlDir, { recursive: true });

fs.writeFileSync(
  path.join(agentDir, 'models.json'),
  JSON.stringify({ providers: {} }, null, 2) + '\n',
  'utf8'
);
fs.writeFileSync(
  path.join(agentDir, 'settings.json'),
  JSON.stringify(
    {
      defaultProvider: 'demo',
      defaultModel: 'demo-model',
      defaultThinkingLevel: 'medium',
    },
    null,
    2
  ) + '\n',
  'utf8'
);
fs.writeFileSync(path.join(agentDir, 'AGENTS.md'), '# test agents md\n', 'utf8');
fs.writeFileSync(
  path.join(agentDir, 'pi-manager.json'),
  JSON.stringify(
    {
      workspaces: [
        {
          id: 'pi-home',
          name: 'Pi 标准目录',
          root: agentDir,
          builtin: true,
          map: {
            agents: 'agents',
            skills: 'skills',
            extensions: 'extensions',
            prompts: 'prompts',
            sessions: 'sessions',
          },
        },
      ],
      features: {
        prompt: true,
        skills: true,
        plugins: true,
        workspaces: true,
        memory: true,
        knowledge: true,
      },
      editor: { maxFileKB: 512, backup: true },
    },
    null,
    2
  ) + '\n',
  'utf8'
);
fs.writeFileSync(
  path.join(openvlDir, 'profiles.json'),
  JSON.stringify({ profiles: [], ollama: {} }, null, 2) + '\n',
  'utf8'
);
fs.writeFileSync(path.join(openvlDir, 'config.env'), 'OPENAI_API_KEY=\n', 'utf8');
fs.writeFileSync(
  path.join(openvlDir, 'package.json'),
  JSON.stringify({ name: 'openvl-test', version: '0.0.0' }) + '\n',
  'utf8'
);

// Fixture session: one assistant message carrying usage, so /api/usage has a
// non-empty aggregation to return. Guards the "route forgot to await the
// worker-backed collectUsage → `{}` → dashboard all zeros" regression.
const usageTs = Date.parse('2024-01-01T00:00:00.000Z');
fs.writeFileSync(
  path.join(sessionsDir, '2024-01-01T00-00-00-000Z_00000000-0000-7000-8000-000000000001.jsonl'),
  [
    JSON.stringify({
      type: 'session',
      id: '00000000-0000-7000-8000-000000000001',
      timestamp: '2024-01-01T00:00:00.000Z',
      cwd: tmpRoot,
    }),
    JSON.stringify({
      type: 'message',
      timestamp: '2024-01-01T00:00:00.000Z',
      message: {
        role: 'assistant',
        provider: 'demo',
        model: 'demo-model',
        timestamp: usageTs,
        usage: {
          input: 5,
          output: 6,
          totalTokens: 11,
          cost: { total: 0.02 },
        },
      },
    }),
  ].join('\n') + '\n',
  'utf8'
);

process.env.PI_AGENT_DIR = agentDir;
process.env.PI_CONFIG_DIR = configDir;
process.env.AGENTS_DIR = agentsDir;
process.env.MODELS_FILE = path.join(agentDir, 'models.json');
process.env.SETTINGS_FILE = path.join(agentDir, 'settings.json');
process.env.AGENTS_MD_FILE = path.join(agentDir, 'AGENTS.md');
process.env.PI_MANAGER_CONFIG = path.join(agentDir, 'pi-manager.json');
process.env.SESSIONS_DIR = sessionsDir;
process.env.PROMPTS_DIR = promptsDir;
process.env.OPENVL_PKG_DIR = openvlDir;
process.env.OPENVL_PROFILES_FILE = path.join(openvlDir, 'profiles.json');
process.env.OPENVL_ENV_FILE = path.join(openvlDir, 'config.env');
process.env.PI_MANAGER_USAGE_CACHE_DIR = path.join(tmpRoot, 'usage-cache');
process.env.PORT = '0';
process.env.PI_MANAGER_HOST = '127.0.0.1';
process.env.HOST = '127.0.0.1';

for (const key of Object.keys(require.cache)) {
  const n = key.replace(/\\/g, '/');
  if (n.includes('/pi-manager/lib/') || n.includes('/pi-manager/server.js')) {
    delete require.cache[key];
  }
}

const { server } = require('../server');

let baseUrl = '';

function request(method, urlPath, { headers } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlPath, baseUrl);
    const req = http.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        headers: Object.assign(
          {
            Host: '127.0.0.1',
            Accept: '*/*',
          },
          headers || {}
        ),
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          const text = buf.toString('utf8');
          let json = null;
          const ct = String(res.headers['content-type'] || '');
          if (ct.includes('application/json')) {
            try {
              json = JSON.parse(text);
            } catch {
              json = null;
            }
          }
          resolve({
            status: res.statusCode,
            headers: res.headers,
            text,
            json,
          });
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

describe('server integration (isolated tmp)', () => {
  before(async () => {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        baseUrl = 'http://127.0.0.1:' + addr.port;
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise((resolve) => {
      server.close(() => resolve());
    });
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('GET /api/meta', async () => {
    const res = await request('GET', '/api/meta');
    assert.equal(res.status, 200);
    assert.ok(res.json);
    assert.equal(res.json.modelsFile, process.env.MODELS_FILE);
    assert.equal(res.json.settingsFile, process.env.SETTINGS_FILE);
    assert.equal(res.json.agentsDir, process.env.AGENTS_DIR);
    assert.equal(res.json.agentsMdFile, process.env.AGENTS_MD_FILE);
    assert.equal(res.json.managerConfigFile, process.env.PI_MANAGER_CONFIG);
    assert.equal(typeof res.json.openvlAvailable, 'boolean');
    assert.ok('openvlProfilesFile' in res.json);
    assert.ok('openvlEnvFile' in res.json);
    assert.ok('port' in res.json);
  });

  it('GET /api/models', async () => {
    const res = await request('GET', '/api/models');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.json));
  });

  it('GET /api/agents', async () => {
    const res = await request('GET', '/api/agents');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.json));
  });

  it('GET /api/defaults', async () => {
    const res = await request('GET', '/api/defaults');
    assert.equal(res.status, 200);
    assert.ok(res.json);
    assert.ok('defaultProvider' in res.json);
    assert.ok('defaultModel' in res.json);
    assert.ok('defaultThinkingLevel' in res.json);
  });

  it('GET /api/categories', async () => {
    const res = await request('GET', '/api/categories');
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.json));
  });

  it('GET /api/tool-pool', async () => {
    const res = await request('GET', '/api/tool-pool');
    assert.equal(res.status, 200);
    assert.ok(res.json);
    assert.ok('builtins' in res.json);
    assert.ok('presets' in res.json);
  });

  it('GET /api/status', async () => {
    const res = await request('GET', '/api/status');
    assert.equal(res.status, 200);
    assert.ok(res.json);
    assert.ok(res.json.counts);
    assert.equal(typeof res.json.counts.providers, 'number');
    assert.equal(typeof res.json.counts.models, 'number');
    assert.equal(typeof res.json.counts.agents, 'number');
    assert.equal(typeof res.json.counts.skills, 'number');
    assert.ok(res.json.openvl);
    assert.equal(typeof res.json.openvl.available, 'boolean');
    assert.ok(res.json.defaults);
    assert.ok('defaultProvider' in res.json.defaults);
  });

  it('GET /api/runtime', async () => {
    const res = await request('GET', '/api/runtime');
    assert.equal(res.status, 200);
    assert.ok(res.json);
  });

  it('GET /api/usage', async () => {
    const res = await request('GET', '/api/usage');
    assert.equal(res.status, 200);
    assert.ok(res.json);
    // must be a real report, not a serialized Promise (`{}`)
    assert.equal(typeof res.json.requests, 'number');
    assert.ok(Array.isArray(res.json.models));
  });

  it('GET /api/usage?window=all aggregates fixture rows (no promise-serialized {})', async () => {
    const res = await request('GET', '/api/usage?window=all');
    assert.equal(res.status, 200);
    assert.ok(res.json && typeof res.json === 'object' && !Array.isArray(res.json));
    assert.equal(typeof res.json.requests, 'number');
    assert.ok(res.json.requests >= 1, 'fixture usage row must be aggregated');
    assert.equal(res.json.totalTokens, 11);
    assert.ok(Array.isArray(res.json.models));
    assert.ok(res.json.models.length >= 1, 'fixture model must show up');
    assert.ok(Array.isArray(res.json.byDay));
  });

  it('POST /api/usage/rebuild returns a freshly scanned report', async () => {
    const res = await request('POST', '/api/usage/rebuild?window=all');
    assert.equal(res.status, 200);
    assert.equal(typeof res.json.requests, 'number');
    assert.ok(res.json.requests >= 1, 'rebuild must rescan session files');
    assert.equal(res.json.totalTokens, 11);
    assert.equal(res.json.parsedFiles, 1, 'rebuild drops the index and re-parses');
  });

  it('GET /api/prompt-structure 重建系统提示词结构且切分无遗漏', async () => {
    const res = await request('GET', '/api/prompt-structure?cwd=' + encodeURIComponent(tmpRoot));
    // 隔离环境不强制依赖本机装了 pi 包；未装时路由返回 503，跳过断言
    if (res.status === 503) return;
    assert.equal(res.status, 200);
    assert.equal(typeof res.json.totalChars, 'number');
    assert.equal(res.json.accountedChars, res.json.totalChars, '区块字符数之和必须等于总长');
    assert.ok(Array.isArray(res.json.sections) && res.json.sections.length >= 1);
    assert.ok(Array.isArray(res.json.cwds) && res.json.cwds.length >= 1);
    assert.equal(typeof res.json.estTokens, 'number');
  });

  it('GET /api/sessions', async () => {
    const res = await request('GET', '/api/sessions');
    assert.equal(res.status, 200);
    assert.ok(res.json);
  });

  it('GET /api/workspaces', async () => {
    const res = await request('GET', '/api/workspaces');
    assert.equal(res.status, 200);
    assert.ok(res.json);
  });

  it('GET /api/prompts', async () => {
    const res = await request('GET', '/api/prompts');
    assert.equal(res.status, 200);
    assert.ok(res.json);
  });

  it('GET /api/skills', async () => {
    const res = await request('GET', '/api/skills');
    assert.equal(res.status, 200);
    assert.ok(res.json);
  });

  it('GET /api/plugins', async () => {
    const res = await request('GET', '/api/plugins');
    assert.equal(res.status, 200);
    assert.ok(res.json);
  });

  it('GET /api/manager-config', async () => {
    const res = await request('GET', '/api/manager-config');
    assert.equal(res.status, 200);
    assert.ok(res.json);
  });

  it('GET /api/features', async () => {
    const res = await request('GET', '/api/features');
    assert.equal(res.status, 200);
    assert.ok(res.json);
    assert.ok(res.json.features);
  });

  it('GET /api/chat/models', async () => {
    const res = await request('GET', '/api/chat/models');
    assert.equal(res.status, 200);
    assert.ok(res.json);
  });

  it('GET /api/chat/tools', async () => {
    const res = await request('GET', '/api/chat/tools');
    assert.equal(res.status, 200);
    assert.ok(res.json);
    assert.ok(Array.isArray(res.json.tools) || 'tools' in res.json);
  });

  it('GET /api/chat/sessions', async () => {
    const res = await request('GET', '/api/chat/sessions');
    assert.equal(res.status, 200);
    assert.ok(res.json);
  });

  it('GET /api/openvl/profiles', async () => {
    const res = await request('GET', '/api/openvl/profiles');
    assert.equal(res.status, 200);
    assert.ok(res.json);
  });

  it('unknown /api/does-not-exist -> 404', async () => {
    const res = await request('GET', '/api/does-not-exist');
    assert.equal(res.status, 404);
  });

  it('malformed percent path static -> 404', async () => {
    const res = await request('GET', '/%E0%A4%A');
    assert.equal(res.status, 404);
  });

  it('GET / -> 200 text/html', async () => {
    const res = await request('GET', '/');
    assert.equal(res.status, 200);
    assert.match(String(res.headers['content-type'] || ''), /text\/html/);
  });

  it('index.html has no inline scripts', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    assert.equal(/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), false);
  });

  it('GET /theme-init.js -> 200 javascript', async () => {
    const res = await request('GET', '/theme-init.js');
    assert.equal(res.status, 200);
    assert.match(String(res.headers['content-type'] || ''), /javascript/);
  });

  it('static JS resource -> 200 application/javascript', async () => {
    for (const file of ['/app.js', '/models-ui.js', '/agents-ui.js', '/openvl-ui.js']) {
      const res = await request('GET', file);
      assert.equal(res.status, 200, file + ' should return 200');
      assert.match(String(res.headers['content-type'] || ''), /application\/javascript/);
      assert.ok(res.text.length > 100, file + ' should not be empty');
    }
  });

  it('GET /style.css -> 200 with ETag', async () => {
    const res = await request('GET', '/style.css');
    assert.equal(res.status, 200);
    assert.ok(res.headers.etag);
    const etag = res.headers.etag;
    const again = await request('GET', '/style.css', { headers: { 'If-None-Match': etag } });
    assert.equal(again.status, 304);
    assert.equal(again.text, '');
  });

  it('HEAD /style.css -> 200 with Content-Length and empty body', async () => {
    const res = await request('HEAD', '/style.css');
    assert.equal(res.status, 200);
    assert.ok(Number(res.headers['content-length']) > 0);
    assert.equal(res.text, '');
  });

  it('GET /vendor/lucide.min.js -> short max-age, no debug header by default', async () => {
    const res = await request('GET', '/vendor/lucide.min.js');
    assert.equal(res.status, 200);
    assert.equal(res.headers['cache-control'], 'public, max-age=300');
    assert.equal(res.headers['x-static-cache'], undefined);
  });
});

