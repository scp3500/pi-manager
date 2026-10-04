const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const {
  PI_AGENT_DIR,
  MODELS_FILE,
  SETTINGS_FILE,
  AGENTS_MD_FILE,
  MANAGER_CONFIG_FILE,
  AGENTS_DIR,
  OPENVL_AVAILABLE,
  OPENVL_PKG_DIR,
} = require('./config');
const { maskApiKey } = require('./model-security');
const { listProviders, listAllModels, readModelsFile } = require('./models');
const { resolveApiKey } = require('./fetch-models');
const { getDefaults, readSettingsFile } = require('./settings');
const { listAgents } = require('./agents');
const { listSkills } = require('./skills');
const promptApi = require('./prompt');
const { listWorkspaces, contentReady } = require('./workspaces');
const { readManagerConfig } = require('./manager-config');
const { TEXT_EXTS } = require('./files');
const sessionsApi = require('./sessions');

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '__pycache__',
  '.venv',
  'venv',
  'dist',
  'build',
  '.cache',
  'sessions',
  'npm',
]);

const HOME = process.env.USERPROFILE || process.env.HOME || '';

function clip(s, n) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  if (t.length <= n) return t;
  return t.slice(0, n - 1) + '…';
}

function expandUserPath(p) {
  return String(p || '')
    .replace(/^~\//, HOME + path.sep)
    .replace(/^~\\/, HOME + path.sep)
    .replace(/%USERPROFILE%/gi, HOME);
}

function isTextPath(filePath) {
  const base = path.basename(filePath);
  if (base === 'AGENTS.md' || base === 'SKILL.md' || base === 'README') return true;
  const ext = path.extname(filePath).toLowerCase();
  return TEXT_EXTS.has(ext) || base.endsWith('.md');
}

function walkTextFiles(root, { maxFiles = 400, maxDepth = 6 } = {}) {
  const out = [];
  if (!root || !fs.existsSync(root)) return out;

  function rec(dir, depth) {
    if (out.length >= maxFiles || depth > maxDepth) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (out.length >= maxFiles) return;
      const name = ent.name;
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue;
        if (name.startsWith('.') && name !== '.pi') continue;
        if (name.includes('.bak')) continue;
        rec(path.join(dir, name), depth + 1);
        continue;
      }
      if (!ent.isFile()) continue;
      if (/\.bak(\.\d+)?$/i.test(name) || name.startsWith('tmp_')) continue;
      const abs = path.join(dir, name);
      if (!isTextPath(abs)) continue;
      try {
        const st = fs.statSync(abs);
        if (st.size > 512 * 1024) continue;
        out.push({ abs, size: st.size, mtime: st.mtimeMs });
      } catch {
        /* ignore */
      }
    }
  }
  rec(path.resolve(root), 0);
  return out;
}

function readSnippet(abs, query, maxBytes = 120_000) {
  let text;
  try {
    text = fs.readFileSync(abs).slice(0, maxBytes).toString('utf8');
  } catch {
    return { matched: false };
  }
  const q = query.toLowerCase();
  const idx = text.toLowerCase().indexOf(q);
  if (idx < 0) return { matched: false };
  const start = Math.max(0, idx - 60);
  const end = Math.min(text.length, idx + query.length + 100);
  let snip = text.slice(start, end).replace(/\s+/g, ' ');
  if (start > 0) snip = '…' + snip;
  if (end < text.length) snip += '…';
  return {
    matched: true,
    snippet: snip,
    lineHint: text.slice(0, idx).split(/\r?\n/).length,
  };
}

function collectPromptFiles() {
  const fileList = [];
  try {
    const pf = promptApi.listPromptFiles();
    for (const it of pf.items || []) {
      if (!it.path) continue;
      if (it.exists === false) continue;
      if (!fs.existsSync(it.path)) continue;
      fileList.push({
        abs: it.path,
        title: it.name || path.basename(it.path),
        kind: it.kind === 'memory' ? 'memory' : 'prompts',
        href: it.kind === 'memory' ? '#/agents' : '#/prompt',
        group: it.group || '提示词',
        workspaceId: it.workspaceId,
      });
    }
  } catch {
    if (fs.existsSync(AGENTS_MD_FILE)) {
      fileList.push({
        abs: AGENTS_MD_FILE,
        title: 'AGENTS.md',
        kind: 'prompts',
        href: '#/prompt',
        group: '系统提示词',
      });
    }
  }
  return fileList;
}

/**
 * @param {{ q: string, scope?: string, limit?: number }} opts
 */
function searchAll(opts = {}) {
  const q = String(opts.q || '').trim();
  if (!q) {
    const err = new Error('q is required');
    err.status = 400;
    throw err;
  }
  if (q.length < 2) {
    const err = new Error('q too short (min 2)');
    err.status = 400;
    throw err;
  }
  const limit = Math.min(100, Math.max(1, Number(opts.limit) || 40));
  const scope = String(opts.scope || 'all');
  const ql = q.toLowerCase();
  const hits = [];

  function pushHit(hit) {
    if (hits.length >= limit) return false;
    hits.push(hit);
    return hits.length < limit;
  }

  if (scope === 'all' || scope === 'prompts') {
    for (const f of collectPromptFiles()) {
      if (hits.length >= limit) break;
      if (scope === 'prompts' && f.kind === 'memory') continue;
      const nameHit = f.title.toLowerCase().includes(ql);
      const body = readSnippet(f.abs, q);
      if (!nameHit && !body.matched) continue;
      pushHit({
        source: f.kind,
        title: f.title,
        path: f.abs,
        group: f.group,
        href: f.href,
        match: nameHit && !body.matched ? 'name' : 'content',
        snippet: body.matched ? body.snippet : '(文件名匹配)',
        line: body.lineHint || null,
        workspaceId: f.workspaceId,
      });
    }
  }

  if ((scope === 'all' || scope === 'agents') && hits.length < limit) {
    try {
      for (const a of listAgents()) {
        if (hits.length >= limit) break;
        const name = a.name || '';
        const desc = a.description || '';
        const model = a.model || '';
        const filePath = path.join(AGENTS_DIR, (a.filename || name + '.md'));
        const hay = (name + ' ' + desc + ' ' + model).toLowerCase();
        let snip = '';
        let match = '';
        if (hay.includes(ql)) {
          match = 'meta';
          snip = clip(desc || model || name, 160);
        } else if (fs.existsSync(filePath)) {
          const body = readSnippet(filePath, q);
          if (!body.matched) continue;
          match = 'content';
          snip = body.snippet;
        } else continue;
        pushHit({
          source: 'agents',
          title: name,
          path: filePath,
          group: '子代理' + (a.category ? ' · ' + a.category : ''),
          href: '#/agents',
          match,
          snippet: snip,
          meta: { model, description: clip(desc, 120) },
        });
      }
    } catch {
      /* ignore */
    }
  }

  if ((scope === 'all' || scope === 'skills') && hits.length < limit) {
    try {
      for (const s of listSkills().skills || []) {
        if (hits.length >= limit) break;
        const hay = (s.name + ' ' + (s.description || '') + ' ' + (s.id || '')).toLowerCase();
        if (!hay.includes(ql)) continue;
        pushHit({
          source: 'skills',
          title: s.name,
          path: s.path,
          group: s.enabled ? 'Skills · 启用' : 'Skills · 禁用',
          href: '#/skills',
          match: 'meta',
          snippet: clip(s.description || '', 180),
          meta: { enabled: !!s.enabled },
        });
      }
    } catch {
      /* ignore */
    }
  }

  function searchMapped(mapKey, source, href) {
    if (hits.length >= limit) return;
    try {
      const cfg = readManagerConfig();
      const ready = contentReady(mapKey, cfg.features || {});
      if (!ready.ready || !ready.path) return;
      for (const f of walkTextFiles(ready.path, { maxFiles: 500, maxDepth: 8 })) {
        if (hits.length >= limit) break;
        const base = path.basename(f.abs);
        const rel = path.relative(ready.path, f.abs).replace(/\\/g, '/');
        const nameHit = (base + ' ' + rel).toLowerCase().includes(ql);
        const body = readSnippet(f.abs, q);
        if (!nameHit && !body.matched) continue;
        pushHit({
          source,
          title: rel || base,
          path: f.abs,
          group: (ready.name || mapKey) + ' · ' + mapKey,
          href,
          match: nameHit && !body.matched ? 'name' : 'content',
          snippet: body.matched ? body.snippet : '(文件名匹配)',
          line: body.lineHint || null,
          workspaceId: ready.workspaceId,
          relPath: rel,
        });
      }
    } catch {
      /* ignore */
    }
  }

  if (scope === 'all' || scope === 'memory') searchMapped('memory', 'memory', '#/memory');
  if (scope === 'all' || scope === 'knowledge') searchMapped('knowledge', 'knowledge', '#/knowledge');

  return { q, scope, limit, count: hits.length, hits };
}

function redactSettings(settings) {
  const s = { ...(settings || {}) };
  for (const k of Object.keys(s)) {
    if (/key|token|secret|password/i.test(k) && typeof s[k] === 'string') s[k] = '***';
  }
  return s;
}

function redactModelsConfig(config) {
  const c = JSON.parse(JSON.stringify(config || { providers: {} }));
  for (const [id, p] of Object.entries(c.providers || {})) {
    if (!p || typeof p !== 'object') continue;
    const raw = (config.providers || {})[id]?.apiKey;
    const info = maskApiKey(raw);
    if (!info.configured) {
      p.apiKey = '';
    } else if (info.kind === 'env' && String(raw).startsWith('$')) {
      p.apiKey = String(raw); // keep env ref
    } else if (info.kind === 'command') {
      p.apiKey = '!REDACTED';
    } else {
      p.apiKey = '***REDACTED***';
    }
    p._apiKeyMeta = info;
  }
  return c;
}

function exportConfig() {
  const modelsRaw = readModelsFile();
  const settings = readSettingsFile();
  const manager = readManagerConfig();
  const defaults = getDefaults();
  const agents = listAgents().map((a) => ({
    name: a.name,
    description: a.description || '',
    model: a.model || '',
    thinking: a.thinking || '',
    tools: a.tools || '',
    category: a.category || '',
  }));
  let skillsSummary = [];
  try {
    skillsSummary = (listSkills().skills || []).map((s) => ({
      name: s.name,
      enabled: !!s.enabled,
      description: clip(s.description || '', 200),
      path: s.path,
    }));
  } catch {
    skillsSummary = [];
  }

  return {
    exportedAt: new Date().toISOString(),
    version: 1,
    note: 'API keys redacted (env $VAR kept). Re-enter secrets after moving machines.',
    piAgentDir: PI_AGENT_DIR,
    defaults,
    settings: redactSettings(settings),
    models: redactModelsConfig(modelsRaw),
    manager: {
      features: manager.features,
      editor: manager.editor,
      workspaces: (manager.workspaces || []).map((w) => ({
        id: w.id,
        name: w.name,
        root: w.root,
        builtin: !!w.builtin,
        map: w.map || {},
      })),
    },
    agents,
    skills: skillsSummary,
    workspaces: (listWorkspaces().workspaces || []).map((w) => ({
      id: w.id,
      name: w.name,
      root: w.root,
      builtin: !!w.builtin,
      map: w.map || {},
      rootExists: !!w.rootExists,
    })),
    paths: {
      models: MODELS_FILE,
      settings: SETTINGS_FILE,
      agentsMd: AGENTS_MD_FILE,
      manager: MANAGER_CONFIG_FILE,
      agentsDir: AGENTS_DIR,
    },
    openvl: {
      available: !!OPENVL_AVAILABLE,
      pkgDir: OPENVL_PKG_DIR || null,
    },
  };
}

function headRequest(urlStr, timeoutMs = 5000, extraHeaders = {}) {
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(urlStr);
    } catch {
      resolve({ ok: false, error: 'invalid url', ms: 0 });
      return;
    }
    const lib = u.protocol === 'https:' ? https : http;
    const started = Date.now();
    const req = lib.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method: 'GET',
        timeout: timeoutMs,
        headers: {
          Accept: 'application/json',
          'User-Agent': 'pi-manager-health/1',
          ...(extraHeaders || {}),
        },
      },
      (res) => {
        res.resume();
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 500,
          status: res.statusCode,
          ms: Date.now() - started,
        });
      }
    );
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, error: 'timeout', ms: Date.now() - started });
    });
    req.on('error', (e) => {
      resolve({ ok: false, error: e.message, ms: Date.now() - started });
    });
    req.end();
  });
}

async function runHealth() {
  const checks = [];
  const defaults = getDefaults();

  function add(id, ok, message, extra) {
    checks.push({ id, ok: !!ok, message, ...(extra || {}) });
  }

  add('models.json', fs.existsSync(MODELS_FILE), MODELS_FILE);
  add('settings.json', fs.existsSync(SETTINGS_FILE), SETTINGS_FILE);
  add('AGENTS.md', fs.existsSync(AGENTS_MD_FILE), AGENTS_MD_FILE);
  add('agents_dir', fs.existsSync(AGENTS_DIR), AGENTS_DIR);
  add(
    'default_model',
    !!(defaults.defaultProvider && defaults.defaultModel),
    defaults.defaultProvider
      ? defaults.defaultProvider + '/' + defaults.defaultModel
      : '未设置默认模型'
  );

  let providers = [];
  try {
    providers = listProviders();
  } catch (e) {
    add('providers', false, e.message);
  }

  const modelsCfg = readModelsFile();
  const connectivity = [];

  const toProbe = [];
  for (const p of providers) {
    const full = (modelsCfg.providers || {})[p.id] || {};
    const keyInfo = maskApiKey(full.apiKey);
    const baseUrl = full.baseUrl || p.baseUrl || '';
    add(
      'provider_key:' + p.id,
      keyInfo.configured,
      keyInfo.configured ? p.id + ' · ' + keyInfo.masked : p.id + ' · API Key 未配置',
      { providerId: p.id, kind: keyInfo.kind }
    );
    if (baseUrl) {
      let probeUrl = String(baseUrl).replace(/\/+$/, '');
      if (!/\/models$/i.test(probeUrl)) probeUrl += '/models';
      toProbe.push({ providerId: p.id, full, baseUrl, probeUrl });
    } else {
      add('provider_url:' + p.id, false, p.id + ' · baseUrl 为空', { providerId: p.id });
    }
  }

  const probePlans = await Promise.all(
    toProbe.map(async (item) => {
      let apiKey = '';
      try {
        apiKey = (await resolveApiKey(item.full.apiKey)) || '';
      } catch {
        apiKey = '';
      }
      const headers = {};
      if (apiKey) {
        if (/google-generative-ai/i.test(String(item.full.api || ''))) {
          headers['x-goog-api-key'] = apiKey;
        } else if (item.full.authHeader === false) {
          headers['x-api-key'] = apiKey;
        } else {
          headers.Authorization = 'Bearer ' + apiKey;
        }
      }
      return {
        providerId: item.providerId,
        baseUrl: item.baseUrl,
        probeUrl: item.probeUrl,
        headers,
      };
    })
  );

  const probeResults = await Promise.allSettled(
    probePlans.map((plan) => headRequest(plan.probeUrl, 6000, plan.headers))
  );
  for (let i = 0; i < probePlans.length; i++) {
    const plan = probePlans[i];
    const settled = probeResults[i];
    const result =
      settled.status === 'fulfilled'
        ? settled.value
        : { ok: false, error: settled.reason?.message || String(settled.reason), ms: 0 };
    connectivity.push({ ...plan, ...result });
    add(
      'provider_url:' + plan.providerId,
      !!result.ok,
      result.ok
        ? plan.providerId + ' · HTTP ' + result.status + ' · ' + result.ms + 'ms'
        : plan.providerId + ' · ' + (result.error || 'HTTP ' + result.status),
      { providerId: plan.providerId, ms: result.ms, status: result.status }
    );
  }

  try {
    const settings = readSettingsFile();
    for (const e of Array.isArray(settings.extensions) ? settings.extensions : []) {
      const abs = path.resolve(expandUserPath(e));
      add('extension:' + path.basename(abs), fs.existsSync(abs), abs);
    }
    for (const sp of Array.isArray(settings.skills) ? settings.skills : []) {
      const abs = path.resolve(expandUserPath(sp));
      add('skills_path', fs.existsSync(abs), abs);
    }
  } catch (e) {
    add('settings_parse', false, e.message);
  }

  try {
    for (const w of listWorkspaces().workspaces || []) {
      add('workspace_root:' + w.id, !!w.rootExists, w.root || w.id);
      if (w.map) {
        for (const [k, rel] of Object.entries(w.map)) {
          const m = w.mapped && w.mapped[k];
          add('map:' + w.id + ':' + k, !!(m && m.exists), (m && m.path) || rel);
        }
      }
    }
  } catch (e) {
    add('workspaces', false, e.message);
  }

  add('openvl', !!OPENVL_AVAILABLE, OPENVL_AVAILABLE ? OPENVL_PKG_DIR : '未安装 OpenVL');

  try {
    const sess = sessionsApi.getSessionsSummary();
    add(
      'sessions',
      !!sess.exists,
      sess.exists ? sess.total + ' 个 · ' + (sess.totalSizeLabel || '') : 'sessions 目录不存在'
    );
  } catch (e) {
    add('sessions', false, e.message);
  }

  const okCount = checks.filter((c) => c.ok).length;
  const bad = checks.filter((c) => !c.ok);

  return {
    checkedAt: new Date().toISOString(),
    summary: {
      total: checks.length,
      ok: okCount,
      fail: bad.length,
      healthy: bad.length === 0,
    },
    defaults,
    counts: {
      providers: providers.length,
      models: listAllModels().length,
      agents: listAgents().length,
    },
    connectivity,
    checks,
    failures: bad,
  };
}

module.exports = {
  searchAll,
  exportConfig,
  runHealth,
  headRequest,
};
