const { getProvider, providerExists } = require('./models');
const { validateProviderId } = require('./model-security');
const { resolveApiKey, clearApiKeyCache } = require('./api-key');

/**
 * Build OpenAI-compatible models URL from provider baseUrl.
 * baseUrl is usually .../v1  →  .../v1/models
 * @param {string} baseUrl
 */
function modelsEndpoint(baseUrl) {
  let u = String(baseUrl || '').trim();
  if (!u) throw new Error('baseUrl 为空');
  // strip trailing slash
  u = u.replace(/\/+$/, '');
  // if already ends with /models, keep
  if (/\/models$/i.test(u)) return u;
  // strip leaf chat/responses if user pasted full endpoint
  u = u
    .replace(/\/chat\/completions$/i, '')
    .replace(/\/completions$/i, '')
    .replace(/\/responses$/i, '')
    .replace(/\/+$/, '');
  return u + '/models';
}

function candidateModelsEndpoints(baseUrl) {
  let raw = String(baseUrl || '').trim();
  if (!raw) return [];
  if (!/^https?:\/\//i.test(raw)) raw = 'https://' + raw;
  const out = [];
  const add = (u) => {
    const s = String(u || '').replace(/\/+$/, '');
    if (s && !out.includes(s)) out.push(s);
  };
  add(modelsEndpoint(raw));
  try {
    let base = raw.replace(/\/+$/, '');
    base = base
      .replace(/\/chat\/completions$/i, '')
      .replace(/\/completions$/i, '')
      .replace(/\/responses$/i, '')
      .replace(/\/models$/i, '')
      .replace(/\/+$/, '');
    const url = new URL(base);
    add(url.origin + '/v1/models');
    add(url.origin + '/api/v1/models');
    const parts = url.pathname.split('/').filter(Boolean);
    for (let i = parts.length; i >= 1; i--) {
      const prefix = url.origin + '/' + parts.slice(0, i).join('/');
      if (/\/v1$/i.test(prefix)) add(prefix + '/models');
      add(prefix + '/v1/models');
      add(prefix + '/models');
    }
  } catch {
    /* ignore */
  }
  return out;
}

function assertHeaderSafe(value, label) {
  const s = String(value == null ? '' : value);
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 255) {
      throw new Error(
        (label || 'header') +
          ' 含非 Latin1 字符（可能是密钥掩码 ••• 被误传）。请清空 Key 框后重试，或重新粘贴真实 Key。'
      );
    }
  }
  return s;
}

/**
 * Normalize remote /models response into [{id, name, owned_by, raw}]
 * @param {any} data
 */
function normalizeModelsPayload(data) {
  let list = [];
  if (Array.isArray(data)) list = data;
  else if (data && Array.isArray(data.data)) list = data.data;
  else if (data && Array.isArray(data.models)) list = data.models;
  else if (data && typeof data === 'object') {
    // some proxies return { model: "a,b,c" } or map
    if (typeof data.model === 'string') {
      list = data.model.split(/[,\s]+/).filter(Boolean).map((id) => ({ id }));
    }
  }

  const out = [];
  const seen = new Set();
  for (const item of list) {
    let id = '';
    let name = '';
    let owned_by = '';
    if (typeof item === 'string') {
      id = item;
      name = item;
    } else if (item && typeof item === 'object') {
      id = item.id || item.model || item.name || '';
      name = item.name || item.id || id;
      owned_by = item.owned_by || item.ownedBy || item.publisher || '';
    }
    id = String(id || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name: String(name || id),
      owned_by: String(owned_by || ''),
      raw: item,
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Guess simple defaults from remote model metadata when present.
 * @param {any} raw
 */
function guessDefaults(raw) {
  const g = {
    contextWindow: undefined,
    maxTokens: undefined,
    reasoning: undefined,
  };
  if (!raw || typeof raw !== 'object') return g;
  // common fields across OpenRouter / LiteLLM / various proxies
  const ctx =
    raw.context_length ||
    raw.contextLength ||
    raw.max_model_len ||
    raw.max_context_length ||
    (raw.top_provider && raw.top_provider.context_length);
  if (ctx && Number.isFinite(Number(ctx))) g.contextWindow = Number(ctx);

  const maxOut =
    raw.max_output_tokens ||
    raw.max_output ||
    raw.max_completion_tokens ||
    (raw.top_provider && raw.top_provider.max_completion_tokens);
  if (maxOut && Number.isFinite(Number(maxOut))) g.maxTokens = Number(maxOut);

  if (raw.reasoning != null) g.reasoning = !!raw.reasoning;
  else if (raw.supported_parameters && Array.isArray(raw.supported_parameters)) {
    g.reasoning = raw.supported_parameters.some((p) =>
      /reasoning|thinking/i.test(String(p))
    );
  }
  return g;
}

/**
 * Fetch remote model list for a saved provider.
 * @param {string} providerId
 * @param {{baseUrl?: string, apiKey?: string, authHeader?: boolean, headers?: object}} [override]
 */
async function fetchRemoteModels(providerId, override = {}) {
  if (!validateProviderId(providerId) && providerId !== '__draft__') {
    // allow draft only with full override
    if (!override.baseUrl) throw new Error('invalid provider id');
  }

  let baseUrl = override.baseUrl;
  let apiKeyRaw = override.apiKey;
  let authHeader = override.authHeader;
  let extraHeaders = override.headers;

  if (providerId && providerId !== '__draft__') {
    // 内部调用需要真实 Key；getProvider 默认脱敏为空字符串
    const p = getProvider(providerId, { revealKey: true });
    baseUrl = baseUrl || p.baseUrl;
    if (apiKeyRaw == null || apiKeyRaw === '' || apiKeyRaw === '__KEEP__') {
      apiKeyRaw = p.apiKey;
    }
    if (authHeader == null) authHeader = p.authHeader;
    if (!extraHeaders) extraHeaders = p.headers || {};
  }

  if (!baseUrl) throw new Error('baseUrl 为空，无法拉取');

  // codex backend usually has no OpenAI /models
  if (/chatgpt\.com\/backend-api\/codex/i.test(baseUrl)) {
    throw new Error('Codex 后端不支持标准 /models 拉取，请手动添加模型 ID');
  }

  // 占位掩码保护（即使前端漏了）
  if (typeof apiKeyRaw === 'string' && /^[•·.]+$/.test(apiKeyRaw.trim())) {
    apiKeyRaw = '__KEEP__';
    if (providerId && providerId !== '__draft__') {
      try {
        apiKeyRaw = getProvider(providerId, { revealKey: true }).apiKey;
      } catch {
        apiKeyRaw = '';
      }
    } else {
      apiKeyRaw = '';
    }
  }

  const apiKey = await resolveApiKey(apiKeyRaw);
  assertHeaderSafe(apiKey, 'API Key');

  const headersBase = {
    Accept: 'application/json',
    ...(extraHeaders && typeof extraHeaders === 'object' ? extraHeaders : {}),
  };
  // sanitize custom headers
  for (const [k, v] of Object.entries(headersBase)) {
    if (v != null) headersBase[k] = assertHeaderSafe(v, 'Header ' + k);
  }
  const useBearer = authHeader !== false;
  if (apiKey && useBearer && !headersBase.Authorization && !headersBase.authorization) {
    headersBase.Authorization = 'Bearer ' + apiKey;
  } else if (apiKey && !useBearer && !headersBase['x-api-key'] && !headersBase['api-key']) {
    headersBase['x-api-key'] = apiKey;
  }

  const candidates = candidateModelsEndpoints(baseUrl);
  if (!candidates.length) throw new Error('无法推导 /models 地址');

  const tried = [];
  let lastErr = null;
  let data = null;
  let url = '';

  for (const cand of candidates) {
    try {
      let res;
      try {
        res = await fetch(cand, {
          method: 'GET',
          headers: headersBase,
          signal: AbortSignal.timeout(20000),
        });
      } catch (e) {
        throw new Error('请求失败: ' + (e.message || e));
      }
      const text = await res.text();
      let parsed;
      try {
        parsed = text ? JSON.parse(text) : {};
      } catch {
        throw new Error('返回非 JSON (HTTP ' + res.status + '): ' + text.slice(0, 160));
      }
      if (!res.ok) {
        const msg =
          (parsed && (parsed.error?.message || parsed.error || parsed.message)) ||
          text.slice(0, 160) ||
          res.statusText;
        throw new Error('HTTP ' + res.status + ': ' + msg);
      }
      const list = normalizeModelsPayload(parsed);
      if (!list.length) {
        tried.push(cand + ' → 空列表');
        lastErr = new Error('空模型列表');
        continue;
      }
      data = parsed;
      url = cand;
      lastErr = null;
      break;
    } catch (e) {
      tried.push(cand + ' → ' + (e.message || e));
      lastErr = e;
    }
  }

  if (!data || !url) {
    throw new Error(
      '检测失败（已尝试 ' +
        candidates.length +
        ' 个地址）\n' +
        tried.slice(0, 6).join('\n') +
        (lastErr ? '' : '')
    );
  }

  const models = normalizeModelsPayload(data).map((m) => ({
    ...m,
    guess: guessDefaults(m.raw),
  }));

  return {
    url,
    tried,
    count: models.length,
    models,
  };
}

/**
 * 供应商连通检测：用表单/已存 baseUrl+key 发最小 chat 请求。
 * 200/400/422/429 视为链路可达；401/403 视为密钥问题。
 */
async function testProviderConnection(providerId, override = {}) {
  let baseUrl = override.baseUrl;
  let apiKeyRaw = override.apiKey;
  let authHeader = override.authHeader;
  let extraHeaders = override.headers;
  let modelId = override.model;
  let apiType = override.api;

  if (providerId && providerId !== '__draft__' && providerExists(providerId)) {
    const p = getProvider(providerId, { revealKey: true });
    baseUrl = baseUrl || p.baseUrl;
    if (apiKeyRaw == null || apiKeyRaw === '' || apiKeyRaw === '__KEEP__') apiKeyRaw = p.apiKey;
    if (authHeader == null) authHeader = p.authHeader;
    if (!extraHeaders) extraHeaders = p.headers || {};
    if (!modelId) {
      const models = p.models || [];
      modelId = (models[0] && models[0].id) || 'test';
    }
    // 模型级 API 覆盖优先：与 Pi 实际调用一致（model.api > 表单/override.api > provider.api）
    const modelDef = (p.models || []).find((m) => m && m.id === modelId) || null;
    if (modelDef && modelDef.api) apiType = modelDef.api;
    else if (!apiType) apiType = p.api || 'openai-completions';
    // 模型级 headers 覆盖合并（模型优先，与 Pi 调用一致）
    if (modelDef && modelDef.headers && typeof modelDef.headers === 'object') {
      extraHeaders = { ...(extraHeaders || {}), ...modelDef.headers };
    }
  }

  if (typeof apiKeyRaw === 'string' && /^[•·.]+$/.test(apiKeyRaw.trim())) {
    if (providerId && providerExists(providerId)) {
      try {
        apiKeyRaw = getProvider(providerId, { revealKey: true }).apiKey;
      } catch {
        apiKeyRaw = '';
      }
    } else apiKeyRaw = '';
  }

  baseUrl = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!baseUrl) return { ok: false, error: 'Base URL 为空' };
  if (/chatgpt\.com\/backend-api\/codex/i.test(baseUrl) || /codex-responses/i.test(String(apiType || ''))) {
    // codex 无标准 chat；改测 /models 是否可达太弱，直接说明
    return {
      ok: false,
      error: 'Codex 类后端不支持标准 chat 探测，请用「获取模型」或实际对话验证',
      endpoint: baseUrl,
    };
  }

  if (/google-generative-ai/i.test(String(apiType || ''))) {
    // gemini 原生格式：走 /models/:id:generateContent，探钆逻辑在下方 isGemini 分支统一处理
  }

  const apiKey = await resolveApiKey(apiKeyRaw);
  if (!apiKey) return { ok: false, error: 'API Key 未配置' };
  try {
    assertHeaderSafe(apiKey, 'API Key');
  } catch (e) {
    return { ok: false, error: e.message };
  }

  // 推导请求 endpoint（按 api 类型；codex 分支已提前 return）
  const apiTypeNorm = String(apiType || '').toLowerCase();
  const isGemini = /google-generative-ai/i.test(apiTypeNorm);
  const wantsResponses = apiTypeNorm.includes('responses');
  let endpoint = baseUrl;
  if (isGemini) {
    endpoint = baseUrl + '/models/' + encodeURIComponent(modelId || 'test') + ':generateContent';
  } else if (/\/chat\/completions$/i.test(endpoint) || /\/responses$/i.test(endpoint)) {
    // already full endpoint（以 URL 为准）
  } else if (/\/v1$/i.test(endpoint) || /\/v1\//i.test(endpoint)) {
    endpoint = endpoint.replace(/\/+$/, '') + (wantsResponses ? '/responses' : '/chat/completions');
  } else {
    endpoint = endpoint.replace(/\/+$/, '') + (wantsResponses ? '/v1/responses' : '/v1/chat/completions');
  }

  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    ...(extraHeaders && typeof extraHeaders === 'object' ? extraHeaders : {}),
  };
  for (const [k, v] of Object.entries(headers)) {
    try {
      if (v != null) headers[k] = assertHeaderSafe(v, 'Header ' + k);
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }
  if (isGemini) {
    headers['x-goog-api-key'] = apiKey;
  } else if (authHeader !== false) headers.Authorization = 'Bearer ' + apiKey;
  else headers['x-api-key'] = apiKey;

  // payload 按 api 类型；gemini 走 contents；responses 与真实调用一致走流式（部分中转只接受 stream=true）
  const isResponses = !isGemini && (wantsResponses || /\/responses$/i.test(endpoint));
  const apiUsed = isGemini ? 'google-generative-ai' : isResponses ? 'openai-responses' : 'openai-completions';
  const payload = isGemini
    ? {
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        generationConfig: { maxOutputTokens: 1 },
      }
    : isResponses
    ? {
        model: modelId || 'test',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
        max_output_tokens: 1,
        stream: true,
      }
    : {
        model: modelId || 'test',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1,
        stream: false,
      };

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30000),
    });
    let detail = '';
    try {
      const j = await res.json();
      detail =
        (j.error && (j.error.message || j.error.type || j.error)) ||
        j.message ||
        '';
      if (detail && typeof detail === 'object') detail = JSON.stringify(detail).slice(0, 120);
      else detail = String(detail || '').slice(0, 120);
    } catch {
      /* ignore */
    }
    if (res.status === 200) {
      return {
        ok: true,
        status: 200,
        message: '正常',
        endpoint,
        model: isGemini ? modelId : payload.model,
        api: apiUsed,
      };
    }
    if ([400, 404, 422, 429].includes(res.status)) {
      return {
        ok: true,
        status: res.status,
        message: detail ? res.status + ' (' + detail + ')' : String(res.status),
        endpoint,
        model: isGemini ? modelId : payload.model,
        api: apiUsed,
      };
    }
    if ([401, 403].includes(res.status)) {
      const hint =
        authHeader === false
          ? '（当前为 x-api-key；多数 OpenAI 兼容站需勾选 authHeader/Bearer）'
          : '（Bearer 被拒：检查 Key 是否过期/复制完整）';
      return {
        ok: false,
        status: res.status,
        error: (detail || '认证失败') + ' ' + hint,
        endpoint,
        model: isGemini ? modelId : payload.model,
        api: apiUsed,
        authMode: isGemini ? 'x-goog-api-key' : authHeader === false ? 'x-api-key' : 'bearer',
      };
    }
    return {
      ok: false,
      status: res.status,
      error: detail || 'HTTP ' + res.status,
      endpoint,
      model: isGemini ? modelId : payload.model,
      api: apiUsed,
    };
  } catch (e) {
    return { ok: false, error: (e.message || String(e)).slice(0, 160), endpoint, api: apiUsed };
  }
}

module.exports = {
  resolveApiKey,
  clearApiKeyCache,
  assertHeaderSafe,
  modelsEndpoint,
  candidateModelsEndpoints,
  normalizeModelsPayload,
  guessDefaults,
  fetchRemoteModels,
  testProviderConnection,
};
