const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { maskApiKey } = require('./model-security');
const {
  OPENVL_PKG_DIR,
  OPENVL_AVAILABLE,
  OPENVL_PROFILES_FILE,
  OPENVL_ENV_FILE,
  OPENVL_ENV_MIRRORS,
  BACKUP_KEEP,
} = require('./config');

function requireAvailable() {
  if (!OPENVL_AVAILABLE || !OPENVL_PKG_DIR || !OPENVL_PROFILES_FILE) {
    const err = new Error(
      '未检测到 OpenVL。可执行: npm install -g @scp3500/openvl\n或设置环境变量 OPENVL_PKG_DIR 指向安装目录'
    );
    err.code = 'OPENVL_UNAVAILABLE';
    throw err;
  }
}

function emptyProfiles() {
  return {
    profiles: [
      {
        id: 'default',
        name: '默认配置',
        api_key: '',
        api_base: '',
        model: '',
        models: [],
        active: true,
      },
    ],
    ollama: {
      url: 'http://127.0.0.1:11434',
      model: 'openbmb/minicpm-v4.6',
      backend: 'ollama',
    },
  };
}

function readEnvFile(filePath) {
  const out = { api_key: '', api_base: '', model: '', api_type: '' };
  if (!fs.existsSync(filePath)) return out;
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const s = line.trim();
      if (s.startsWith('VISION_API_KEY=') && !s.includes('你的')) {
        const v = s.slice('VISION_API_KEY='.length).trim();
        if (v) out.api_key = v;
      } else if (s.startsWith('VISION_API_BASE=')) {
        const v = s.slice('VISION_API_BASE='.length).trim();
        if (v) out.api_base = v.replace(/\/+$/, '');
      } else if (s.startsWith('VISION_MODEL=')) {
        const v = s.slice('VISION_MODEL='.length).trim();
        if (v) out.model = v;
      } else if (s.startsWith('VISION_API_TYPE=')) {
        const v = s.slice('VISION_API_TYPE='.length).trim();
        if (v) out.api_type = v;
      }
    }
  } catch {
    /* ignore */
  }
  return out;
}

function findEnvFiles() {
  const files = [];
  const candidates = [OPENVL_ENV_FILE, ...OPENVL_ENV_MIRRORS];
  for (const f of candidates) {
    if (f && fs.existsSync(f) && !files.includes(f)) files.push(f);
  }
  return files;
}

function migrateProfile(p) {
  if (!p || typeof p !== 'object') return p;
  if (!Array.isArray(p.models) || !p.models.length) {
    const m = p.model ? String(p.model) : '';
    p.models = m ? [m] : [];
  }
  if (!p.model && p.models.length) p.model = p.models[0];
  if (!p.id) p.id = 'p_' + Date.now().toString(36);
  if (!p.name) p.name = '未命名';
  p.active = !!p.active;
  p.api_key = p.api_key == null ? '' : String(p.api_key);
  p.api_base = p.api_base == null ? '' : String(p.api_base).replace(/\/+$/, '');
  p.model = p.model == null ? '' : String(p.model);
  p.api_type = p.api_type == null ? '' : String(p.api_type);
  p.models = p.models.map((m) => String(m).trim()).filter(Boolean);
  return p;
}

function seedFromEnv(data) {
  const files = findEnvFiles();
  if (!files.length) return data;
  let api_key = '';
  let api_base = '';
  let model = '';
  for (const f of files) {
    const c = readEnvFile(f);
    if (c.api_key) api_key = c.api_key;
    if (c.api_base) api_base = c.api_base;
    if (c.model) model = c.model;
  }
  if (!data.profiles || !data.profiles.length) {
    data.profiles = [
      {
        id: 'default',
        name: '默认配置',
        api_key,
        api_base,
        model,
        models: model ? [model] : [],
        active: true,
      },
    ];
  } else {
    const active = data.profiles.find((p) => p.active) || data.profiles[0];
    if (active) {
      if (!active.api_key && api_key) active.api_key = api_key;
      if (!active.api_base && api_base) active.api_base = api_base;
      if (!active.model && model) {
        active.model = model;
        if (!active.models.includes(model)) active.models.push(model);
      }
    }
  }
  return data;
}

function readProfilesFile() {
  requireAvailable();
  if (!fs.existsSync(OPENVL_PROFILES_FILE)) {
    const data = seedFromEnv(emptyProfiles());
    writeProfilesFile(data);
    return data;
  }
  try {
    const raw = fs.readFileSync(OPENVL_PROFILES_FILE, 'utf8');
    if (!raw.trim()) {
      const data = seedFromEnv(emptyProfiles());
      writeProfilesFile(data);
      return data;
    }
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') throw new Error('profiles.json root must be object');
    if (!Array.isArray(data.profiles) || !data.profiles.length) {
      data.profiles = emptyProfiles().profiles;
    }
    data.profiles = data.profiles.map(migrateProfile);
    if (!data.profiles.some((p) => p.active) && data.profiles.length) {
      data.profiles[0].active = true;
    }
    if (!data.ollama || typeof data.ollama !== 'object') {
      data.ollama = emptyProfiles().ollama;
    }
    return data;
  } catch (e) {
    if (e.message && e.message.includes('must be')) throw e;
    throw new Error('profiles.json is not valid JSON: ' + e.message);
  }
}

function writeProfilesFile(data) {
  requireAvailable();
  if (!data || typeof data !== 'object') throw new Error('invalid profiles data');
  if (!Array.isArray(data.profiles)) throw new Error('profiles must be an array');

  const dir = path.dirname(OPENVL_PROFILES_FILE);
  // 只在 OpenVL 已安装目录里写；不凭空 mkdir 一个假安装
  if (!fs.existsSync(dir)) {
    throw new Error('OpenVL 目录不存在: ' + dir);
  }

  if (fs.existsSync(OPENVL_PROFILES_FILE)) {
    const bak0 = OPENVL_PROFILES_FILE + '.bak';
    for (let i = BACKUP_KEEP - 1; i >= 1; i--) {
      const from = i === 1 ? bak0 : OPENVL_PROFILES_FILE + '.bak.' + (i - 1);
      const to = OPENVL_PROFILES_FILE + '.bak.' + i;
      if (fs.existsSync(from)) {
        try {
          fs.renameSync(from, to);
        } catch {
          try {
            fs.copyFileSync(from, to);
          } catch {
            /* ignore */
          }
        }
      }
    }
    try {
      fs.copyFileSync(OPENVL_PROFILES_FILE, bak0);
    } catch (e) {
      console.warn('openvl profiles backup failed:', e.message);
    }
  }

  const json = JSON.stringify(data, null, 2) + '\n';
  const tmp = OPENVL_PROFILES_FILE + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, json, 'utf8');
  fs.renameSync(tmp, OPENVL_PROFILES_FILE);
}

function syncToEnv(profile) {
  if (!profile) return;
  const content =
    '# 当前配置（由 Pi Manager 管理）\n' +
    'VISION_API_KEY=' +
    (profile.api_key || '') +
    '\n' +
    'VISION_API_BASE=' +
    (profile.api_base || '') +
    '\n' +
    'VISION_MODEL=' +
    (profile.model || '') +
    '\n' +
    (profile.api_type ? 'VISION_API_TYPE=' + profile.api_type + '\n' : '');

  const targets = new Set([OPENVL_ENV_FILE, ...OPENVL_ENV_MIRRORS]);
  for (const file of targets) {
    if (!file) continue;
    try {
      const dir = path.dirname(file);
      if (!fs.existsSync(dir)) continue; // only write if skill/pkg dir exists
      fs.writeFileSync(file, content, 'utf8');
    } catch (e) {
      console.warn('sync config.env failed:', file, e.message);
    }
  }
}

function getActiveProfile(data) {
  const list = data.profiles || [];
  let active = list.find((p) => p.active);
  if (!active && list.length) {
    list[0].active = true;
    writeProfilesFile(data);
    active = list[0];
  }
  return active || null;
}

function publicProfile(p, { revealKey = true } = {}) {
  const masked = maskApiKey(p.api_key);
  return {
    id: p.id,
    name: p.name,
    api_base: p.api_base || '',
    model: p.model || '',
    models: Array.isArray(p.models) ? p.models.slice() : [],
    apiType: p.api_type || '',
    active: !!p.active,
    // 本地控制台默认返回真实 Key；列表等场景可传 revealKey:false
    apiKey: revealKey ? p.api_key || '' : undefined,
    apiKeyMasked: masked,
    hasKey: !!masked.configured,
  };
}

function listProfiles({ revealKey = true } = {}) {
  if (!OPENVL_AVAILABLE) {
    return {
      available: false,
      profiles: [],
      active: null,
      ollama: { url: 'http://127.0.0.1:11434', model: 'openbmb/minicpm-v4.6', backend: 'ollama' },
      paths: {
        profilesFile: '',
        envFile: '',
        mirrors: [],
        pkgDir: '',
      },
      hint: '未检测到 OpenVL。安装: npm install -g @scp3500/openvl，或设置 OPENVL_PKG_DIR',
    };
  }
  const data = readProfilesFile();
  const active = getActiveProfile(data);
  return {
    available: true,
    profiles: data.profiles.map((p) => publicProfile(p, { revealKey })),
    active: active ? active.id : null,
    ollama: {
      url: (data.ollama && data.ollama.url) || 'http://127.0.0.1:11434',
      model: (data.ollama && data.ollama.model) || 'openbmb/minicpm-v4.6',
      backend: (data.ollama && data.ollama.backend) || 'ollama',
    },
    paths: {
      profilesFile: OPENVL_PROFILES_FILE,
      envFile: OPENVL_ENV_FILE,
      mirrors: OPENVL_ENV_MIRRORS.filter((f) => fs.existsSync(path.dirname(f))),
      pkgDir: OPENVL_PKG_DIR,
    },
  };
}

function getProfile(id, { revealKey = true } = {}) {
  const data = readProfilesFile();
  const p = data.profiles.find((x) => x.id === id);
  if (!p) {
    const err = new Error('not found');
    throw err;
  }
  return publicProfile(p, { revealKey });
}

function newId() {
  return 'p_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function createProfile(body = {}) {
  const data = readProfilesFile();
  const name = (body.name || '未命名').trim() || '未命名';
  const model = body.model != null ? String(body.model).trim() : '';
  let models = Array.isArray(body.models)
    ? body.models.map((m) => String(m).trim()).filter(Boolean)
    : [];
  if (!models.length && model) models = [model];
  const p = migrateProfile({
    id: body.id && /^[a-zA-Z0-9_.-]{1,64}$/.test(body.id) ? body.id : newId(),
    name,
    api_key: body.api_key != null ? String(body.api_key) : body.apiKey != null ? String(body.apiKey) : '',
    api_base: body.api_base != null ? String(body.api_base) : body.apiBase != null ? String(body.apiBase) : '',
    model: model || (models[0] || ''),
    models,
    active: true,
  });
  if (data.profiles.some((x) => x.id === p.id)) {
    throw new Error('target id already exists');
  }
  for (const x of data.profiles) x.active = false;
  data.profiles.push(p);
  writeProfilesFile(data);
  syncToEnv(p);
  return publicProfile(p, { revealKey: true });
}

function updateProfile(id, body = {}) {
  const data = readProfilesFile();
  const p = data.profiles.find((x) => x.id === id);
  if (!p) throw new Error('not found');

  if (body.name != null) p.name = String(body.name).trim() || p.name;

  // api key: keep if empty / __KEEP__
  if (body.api_key !== undefined || body.apiKey !== undefined) {
    const v = body.api_key !== undefined ? body.api_key : body.apiKey;
    if (v !== '' && v !== null && v !== undefined && v !== '__KEEP__') {
      p.api_key = String(v);
    }
  }
  if (body.api_base !== undefined || body.apiBase !== undefined) {
    const v = body.api_base !== undefined ? body.api_base : body.apiBase;
    p.api_base = String(v || '').replace(/\/+$/, '');
  }
  if (Array.isArray(body.models)) {
    p.models = body.models.map((m) => String(m).trim()).filter(Boolean);
  }
  if (body.model !== undefined) {
    p.model = String(body.model || '').trim();
    if (p.model && !p.models.includes(p.model)) p.models.push(p.model);
  }
  if (!p.model && p.models.length) p.model = p.models[0];
  if (p.model && !p.models.includes(p.model)) p.models.unshift(p.model);

  writeProfilesFile(data);
  if (p.active) syncToEnv(p);
  return publicProfile(p, { revealKey: true });
}

function switchProfile(id) {
  const data = readProfilesFile();
  const p = data.profiles.find((x) => x.id === id);
  if (!p) throw new Error('not found');
  for (const x of data.profiles) x.active = x.id === id;
  writeProfilesFile(data);
  syncToEnv(p);
  return listProfiles();
}

function deleteProfile(id) {
  const data = readProfilesFile();
  if (data.profiles.length <= 1) throw new Error('至少保留一个配置');
  const idx = data.profiles.findIndex((x) => x.id === id);
  if (idx < 0) throw new Error('not found');
  const wasActive = data.profiles[idx].active;
  data.profiles.splice(idx, 1);
  if (wasActive && data.profiles.length) {
    data.profiles[0].active = true;
    syncToEnv(data.profiles[0]);
  }
  writeProfilesFile(data);
  return listProfiles();
}

function updateOllama(body = {}) {
  const data = readProfilesFile();
  if (!data.ollama) data.ollama = emptyProfiles().ollama;
  if (body.url != null) data.ollama.url = String(body.url).replace(/\/+$/, '');
  if (body.model != null) data.ollama.model = String(body.model);
  if (body.backend != null) data.ollama.backend = String(body.backend);
  writeProfilesFile(data);
  return {
    url: data.ollama.url,
    model: data.ollama.model,
    backend: data.ollama.backend,
  };
}

async function checkOllama(opts = {}) {
  const data = readProfilesFile();
  const url = (opts.url || (data.ollama && data.ollama.url) || 'http://127.0.0.1:11434').replace(
    /\/+$/,
    ''
  );
  const backend = opts.backend || (data.ollama && data.ollama.backend) || 'ollama';
  try {
    if (backend === 'llamacpp') {
      const r = await fetch(url + '/v1/models', { signal: AbortSignal.timeout(5000) });
      if (!r.ok) return { ok: false, error: 'HTTP ' + r.status, backend, url };
      const info = await r.json();
      const models = (info.data || info.models || []).map((m) => m.id || m.name || '');
      return { ok: true, version: 'llama.cpp', models, backend, url };
    }
    const r = await fetch(url + '/api/version', { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return { ok: false, error: 'HTTP ' + r.status, backend, url };
    const info = await r.json();
    return { ok: true, version: info.version || '', backend, url };
  } catch (e) {
    return { ok: false, error: (e.message || String(e)).slice(0, 120), backend, url };
  }
}

/**
 * 从视觉 API 地址推导可能的 /models 探测 URL 列表。
 * 中转常见：
 * - .../v1/chat/completions → .../v1/models
 * - .../v1/responses → .../v1/models
 * - .../api/v1/ai/openai/<channel>/v1/responses → 渠道 /models 常 404，回退到 origin/v1/models
 */
function candidateModelsUrls(apiBase) {
  let raw = String(apiBase || '').trim();
  if (!raw) return [];
  if (!/^https?:\/\//i.test(raw)) raw = 'https://' + raw;
  const out = [];
  const add = (u) => {
    const s = String(u || '').replace(/\/+$/, '');
    if (s && !out.includes(s)) out.push(s);
  };

  let u = raw.replace(/\/+$/, '');
  if (/\/models$/i.test(u)) add(u);
  // strip leaf endpoints
  let base = u
    .replace(/\/chat\/completions$/i, '')
    .replace(/\/completions$/i, '')
    .replace(/\/responses$/i, '')
    .replace(/\/+$/, '');
  add(base + '/models');

  try {
    const url = new URL(base.startsWith('http') ? base : raw);
    const origin = url.origin;
    add(origin + '/v1/models');
    add(origin + '/api/v1/models');

    // walk up path segments: /a/b/c/v1 → try each prefix + /models and + /v1/models
    const parts = url.pathname.split('/').filter(Boolean);
    for (let i = parts.length; i >= 1; i--) {
      const prefix = origin + '/' + parts.slice(0, i).join('/');
      if (/\/v1$/i.test(prefix)) add(prefix + '/models');
      add(prefix + '/v1/models');
      add(prefix + '/models');
    }
  } catch {
    /* ignore bad url */
  }
  return out;
}

async function fetchModelsJson(url, apiKey) {
  const headers = { Accept: 'application/json' };
  if (apiKey) headers.Authorization = 'Bearer ' + apiKey;
  const r = await fetch(url, {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(12000),
  });
  let text = '';
  try {
    text = await r.text();
  } catch {
    text = '';
  }
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  if (!r.ok) {
    let detail = '';
    if (payload) {
      detail =
        (payload.error && (payload.error.message || payload.error.type)) ||
        payload.message ||
        '';
    }
    if (!detail) detail = String(text || '').slice(0, 120);
    const err = new Error('HTTP ' + r.status + (detail ? ': ' + detail : ''));
    err.status = r.status;
    throw err;
  }
  if (payload == null) throw new Error('响应不是 JSON');
  return payload;
}

function normalizeModelsPayload(payload) {
  let list = [];
  if (Array.isArray(payload)) list = payload;
  else if (payload && Array.isArray(payload.data)) list = payload.data;
  else if (payload && Array.isArray(payload.models)) list = payload.models;
  return list;
}

async function listRemoteModels(opts = {}) {
  requireAvailable();
  const data = readProfilesFile();
  let p = null;
  if (opts.id) {
    p = data.profiles.find((x) => x.id === opts.id);
    if (!p) throw new Error('profile not found');
  } else {
    p = getActiveProfile(data);
  }
  const apiBase = (opts.api_base != null ? String(opts.api_base) : p.api_base || '').trim();
  let apiKey = opts.api_key != null ? String(opts.api_key) : p.api_key || '';
  if (apiKey === '__KEEP__' || apiKey === '') apiKey = p.api_key || '';
  if (!apiBase) throw new Error('API 地址为空');
  if (!apiKey) throw new Error('API Key 未配置');

  const candidates = candidateModelsUrls(apiBase);
  if (!candidates.length) throw new Error('无法从 API 地址推导 /models');

  const tried = [];
  let lastErr = null;
  let payload = null;
  let url = '';
  for (const cand of candidates) {
    try {
      payload = await fetchModelsJson(cand, apiKey);
      const list = normalizeModelsPayload(payload);
      // 有的网关 200 但空列表，继续试下一个更通用的
      if (!list.length) {
        tried.push(cand + ' → 空列表');
        lastErr = new Error('空模型列表');
        continue;
      }
      url = cand;
      lastErr = null;
      break;
    } catch (e) {
      tried.push(cand + ' → ' + (e.message || e));
      lastErr = e;
    }
  }
  if (!url || !payload) {
    throw new Error(
      '检测失败（已尝试 ' +
        candidates.length +
        ' 个地址）。常见原因：中转不提供 /models，或地址是渠道专属路径。\n' +
        tried.slice(0, 6).join('\n')
    );
  }

  const list = normalizeModelsPayload(payload);
  const localSet = new Set(
    (Array.isArray(p.models) ? p.models : []).map(String).concat(p.model ? [String(p.model)] : [])
  );
  const models = [];
  const seen = new Set();
  for (const item of list) {
    let id = '';
    let name = '';
    if (typeof item === 'string') id = item;
    else if (item && typeof item === 'object') {
      id = String(item.id || item.name || item.model || '').trim();
      name = String(item.name || item.id || '').trim();
    }
    if (!id || seen.has(id)) continue;
    seen.add(id);
    models.push({
      id,
      name: name || id,
      local: localSet.has(id),
    });
  }
  models.sort((a, b) => a.id.localeCompare(b.id));
  return {
    url,
    tried,
    profileId: p.id,
    count: models.length,
    models,
  };
}

/**
 * 连通检测：可测「当前生效」或表单草稿（id + api_base/api_key/model 覆盖）。
 * 200/400/422/429 视为链路可达；401/403 视为密钥/权限问题。
 */
async function testApi(opts = {}) {
  const data = readProfilesFile();
  let p = null;
  if (opts.id) {
    p = data.profiles.find((x) => x.id === opts.id) || null;
  }
  if (!p) p = getActiveProfile(data);

  let apiBase = (opts.api_base != null ? String(opts.api_base) : (p && p.api_base) || '').trim();
  let apiKey = opts.api_key != null ? String(opts.api_key) : (p && p.api_key) || '';
  if (apiKey === '__KEEP__' || apiKey === '') apiKey = (p && p.api_key) || '';
  // 掩码保护
  if (/^[•·.]+$/.test(String(apiKey).trim())) apiKey = (p && p.api_key) || '';
  const model =
    (opts.model != null ? String(opts.model) : (p && p.model) || '').trim() || 'test';

  if (!apiBase) return { ok: false, error: 'API 地址为空' };
  if (!apiKey) return { ok: false, error: 'API Key 未配置' };

  try {
    const base = apiBase.replace(/\/+$/, '');
    // 尊重 profile 的 apiType；与 openvl 1.1.79 规则一致：URL 已带完整 endpoint 时 URL 优先
    const forcedType = (opts.api_type != null ? String(opts.api_type) : (p && p.api_type) || '').trim().toLowerCase();
    const urlIsResponses = /\/responses$/i.test(base);
    const isResponses = urlIsResponses ? true : forcedType === 'responses';
    const payload = isResponses
      ? {
          model,
          input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
          max_output_tokens: 1,
          stream: true,
        }
      : {
          model,
          messages: [{ role: 'user', content: 'hi' }],
          max_tokens: 1,
          stream: false,
        };
    const r = await fetch(base, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(12000),
    });
    if (r.status === 200) {
      return {
        ok: true,
        status: 200,
        message: '正常',
        endpoint: base,
        profileId: p && p.id,
      };
    }
    if ([400, 401, 403, 404, 422, 429].includes(r.status)) {
      let detail = '';
      try {
        const j = await r.json();
        detail =
          (j.error && (j.error.message || j.error.type)) || j.message || '';
      } catch {
        /* ignore */
      }
      const ok = r.status !== 401 && r.status !== 403;
      return {
        ok,
        status: r.status,
        message: detail ? r.status + ' (' + String(detail).slice(0, 80) + ')' : String(r.status),
        error: ok ? undefined : detail || 'auth failed',
        endpoint: base,
        profileId: p && p.id,
      };
    }
    return {
      ok: false,
      status: r.status,
      error: 'HTTP ' + r.status,
      endpoint: base,
      profileId: p && p.id,
    };
  } catch (e) {
    return {
      ok: false,
      error: (e.message || String(e)).slice(0, 160),
      endpoint: apiBase,
      profileId: p && p.id,
    };
  }
}

async function testActiveApi() {
  return testApi({});
}

function runDoctor() {
  if (!OPENVL_AVAILABLE) {
    return {
      ok: false,
      output: '未检测到 OpenVL。安装: npm install -g @scp3500/openvl',
    };
  }
  const visionPy = path.join(OPENVL_PKG_DIR, 'scripts', 'vision.py');
  if (!fs.existsSync(visionPy)) {
    return { ok: false, output: '找不到 vision.py: ' + visionPy };
  }
  const r = spawnSync('python', ['-X', 'utf8', visionPy, 'doctor'], {
    encoding: 'utf8',
    timeout: 20000,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
  const out = ((r.stdout || '') + (r.stderr || '')).trim();
  return {
    ok: r.status === 0,
    output: out || (r.error ? String(r.error) : '无输出'),
    status: r.status,
  };
}

module.exports = {
  listProfiles,
  getProfile,
  createProfile,
  updateProfile,
  switchProfile,
  deleteProfile,
  updateOllama,
  checkOllama,
  listRemoteModels,
  testApi,
  testActiveApi,
  runDoctor,
  readProfilesFile,
  writeProfilesFile,
  syncToEnv,
  isAvailable: () => !!OPENVL_AVAILABLE,
};
