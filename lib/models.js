const fs = require('fs');
const path = require('path');
const { MODELS_FILE, BACKUP_KEEP } = require('./config');
const { validateProviderId, validateModelId, maskApiKey } = require('./model-security');

function emptyConfig() {
  return { providers: {} };
}

/**
 * @returns {{providers: Object}}
 */
function readModelsFile() {
  if (!fs.existsSync(MODELS_FILE)) {
    return emptyConfig();
  }
  const raw = fs.readFileSync(MODELS_FILE, 'utf8');
  if (!raw.trim()) return emptyConfig();
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new Error('models.json is not valid JSON: ' + e.message);
  }
  if (!data || typeof data !== 'object') {
    throw new Error('models.json root must be an object');
  }
  if (!data.providers || typeof data.providers !== 'object') {
    data.providers = {};
  }
  return data;
}

/**
 * Atomic write with rolling backups.
 * @param {{providers: Object}} config
 */
function writeModelsFile(config) {
  if (!config || typeof config !== 'object') {
    throw new Error('invalid config');
  }
  if (!config.providers || typeof config.providers !== 'object') {
    throw new Error('config.providers is required');
  }

  const dir = path.dirname(MODELS_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Rolling backup: models.json.bak, .bak.1 … .bak.N-1
  if (fs.existsSync(MODELS_FILE)) {
    const bak0 = MODELS_FILE + '.bak';
    for (let i = BACKUP_KEEP - 1; i >= 1; i--) {
      const from = i === 1 ? bak0 : MODELS_FILE + '.bak.' + (i - 1);
      const to = MODELS_FILE + '.bak.' + i;
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
      fs.copyFileSync(MODELS_FILE, bak0);
    } catch (e) {
      console.warn('backup failed:', e.message);
    }
  }

  const json = JSON.stringify(config, null, 2) + '\n';
  const tmp = MODELS_FILE + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, json, 'utf8');
  fs.renameSync(tmp, MODELS_FILE);
}

/**
 * Summarize a provider for list UI (no full key).
 */
function summarizeProvider(id, provider) {
  const p = provider || {};
  const models = Array.isArray(p.models) ? p.models : [];
  const keyInfo = maskApiKey(p.apiKey);
  return {
    id,
    baseUrl: p.baseUrl || '',
    api: p.api || '',
    modelCount: models.length,
    models: models.map((m) => ({
      id: m.id,
      name: m.name || m.id,
      reasoning: !!m.reasoning,
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
    })),
    // 列表只暴露是否配置，不带任何 key / 命令预览
    apiKey: {
      configured: keyInfo.configured,
      kind: keyInfo.kind,
      masked: keyInfo.masked,
    },
    hasCompat: !!(p.compat && Object.keys(p.compat).length),
    hasHeaders: !!(p.headers && Object.keys(p.headers).length),
    hasModelOverrides: !!(p.modelOverrides && Object.keys(p.modelOverrides).length),
  };
}

function listProviders() {
  const config = readModelsFile();
  return Object.keys(config.providers)
    .sort()
    .map((id) => summarizeProvider(id, config.providers[id]));
}

/**
 * Full provider for edit.
 * By default apiKey is empty (UI uses __KEEP__ / reveal=1 like OpenVL).
 * @param {string} id
 * @param {{ revealKey?: boolean }} [opts]
 */
function getProvider(id, opts = {}) {
  if (!validateProviderId(id)) throw new Error('invalid provider id');
  const config = readModelsFile();
  const provider = config.providers[id];
  if (!provider) throw new Error('not found');
  const reveal = !!opts.revealKey;
  return {
    id,
    baseUrl: provider.baseUrl || '',
    api: provider.api || '',
    apiKey: reveal && provider.apiKey != null ? String(provider.apiKey) : '',
    apiKeyMasked: maskApiKey(provider.apiKey),
    headers: provider.headers || {},
    authHeader: provider.authHeader,
    compat: provider.compat || {},
    modelOverrides: provider.modelOverrides || {},
    models: Array.isArray(provider.models) ? provider.models : [],
  };
}

/** Redact secrets from models.json for GET /api/config */
function redactModelsConfig(config) {
  const src = config && typeof config === 'object' ? config : { providers: {} };
  const providers = {};
  const raw = src.providers && typeof src.providers === 'object' ? src.providers : {};
  for (const [id, p] of Object.entries(raw)) {
    const copy = p && typeof p === 'object' ? { ...p } : {};
    if (Object.prototype.hasOwnProperty.call(copy, 'apiKey')) {
      const info = maskApiKey(copy.apiKey);
      copy.apiKey = info.configured ? '__REDACTED__' : '';
      copy.apiKeyMasked = info;
    }
    providers[id] = copy;
  }
  return { ...src, providers };
}

function providerExists(id) {
  if (!validateProviderId(id)) return false;
  const config = readModelsFile();
  return Object.prototype.hasOwnProperty.call(config.providers, id);
}

/**
 * Create or replace a whole provider object.
 * @param {string} id
 * @param {Object} body - provider fields
 * @param {{ renameFrom?: string }} [opts]
 */
function upsertProvider(id, body, opts = {}) {
  if (!validateProviderId(id)) throw new Error('invalid provider id');
  const config = readModelsFile();

  if (opts.renameFrom && opts.renameFrom !== id) {
    if (!validateProviderId(opts.renameFrom)) throw new Error('invalid provider id');
    if (!config.providers[opts.renameFrom]) throw new Error('not found');
    if (config.providers[id]) throw new Error('target id already exists');
  }

  const prev =
    (opts.renameFrom && config.providers[opts.renameFrom]) ||
    config.providers[id] ||
    {};

  const next = {
    ...prev,
  };

  if (body.baseUrl !== undefined) next.baseUrl = body.baseUrl || undefined;
  if (body.api !== undefined) next.api = body.api || undefined;
  if (body.apiKey !== undefined) {
    // Empty string clears; special sentinel keeps previous
    if (body.apiKey === '__KEEP__') {
      /* keep prev.apiKey */
    } else if (body.apiKey === '' || body.apiKey == null) {
      delete next.apiKey;
    } else {
      next.apiKey = String(body.apiKey);
    }
  }
  if (body.headers !== undefined) {
    if (!body.headers || Object.keys(body.headers).length === 0) delete next.headers;
    else next.headers = body.headers;
  }
  if (body.authHeader !== undefined) {
    if (body.authHeader) next.authHeader = true;
    else delete next.authHeader;
  }
  if (body.compat !== undefined) {
    if (!body.compat || Object.keys(body.compat).length === 0) delete next.compat;
    else next.compat = body.compat;
  }
  if (body.modelOverrides !== undefined) {
    if (!body.modelOverrides || Object.keys(body.modelOverrides).length === 0) {
      delete next.modelOverrides;
    } else {
      next.modelOverrides = body.modelOverrides;
    }
  }
  if (body.models !== undefined) {
    if (!Array.isArray(body.models)) throw new Error('models must be an array');
    next.models = body.models;
  }

  // Clean undefined keys
  for (const k of Object.keys(next)) {
    if (next[k] === undefined) delete next[k];
  }

  if (opts.renameFrom && opts.renameFrom !== id) {
    delete config.providers[opts.renameFrom];
  }
  config.providers[id] = next;
  writeModelsFile(config);
  return getProvider(id);
}

function deleteProvider(id) {
  if (!validateProviderId(id)) throw new Error('invalid provider id');
  const config = readModelsFile();
  if (!config.providers[id]) throw new Error('not found');
  delete config.providers[id];
  writeModelsFile(config);
}

function getModel(providerId, modelId) {
  if (!validateProviderId(providerId)) throw new Error('invalid provider id');
  if (!validateModelId(modelId)) throw new Error('invalid model id');
  const config = readModelsFile();
  const provider = config.providers[providerId];
  if (!provider) throw new Error('not found');
  const models = Array.isArray(provider.models) ? provider.models : [];
  const model = models.find((m) => m && m.id === modelId);
  if (!model) throw new Error('model not found');
  return { providerId, model };
}

/**
 * Upsert a model under a provider. If body.id differs from modelId, rename.
 */
function upsertModel(providerId, modelId, body) {
  if (!validateProviderId(providerId)) throw new Error('invalid provider id');
  const newId = (body && body.id) || modelId;
  if (!validateModelId(newId)) throw new Error('invalid model id');

  const config = readModelsFile();
  const provider = config.providers[providerId];
  if (!provider) throw new Error('not found');
  if (!Array.isArray(provider.models)) provider.models = [];

  const idx = provider.models.findIndex((m) => m && m.id === modelId);
  const isNew = modelId == null || modelId === '' || idx === -1;

  if (isNew) {
    if (provider.models.some((m) => m && m.id === newId)) {
      throw new Error('model already exists');
    }
  } else if (newId !== modelId) {
    if (provider.models.some((m) => m && m.id === newId)) {
      throw new Error('target model id already exists');
    }
  }

  // Build model object: prefer full replace from body.model or body fields
  let model;
  if (body.model && typeof body.model === 'object') {
    model = { ...body.model, id: newId };
  } else {
    const prev = idx >= 0 ? { ...provider.models[idx] } : { id: newId };
    model = { ...prev, id: newId };
    const fields = [
      'name',
      'api',
      'reasoning',
      'thinkingLevelMap',
      'input',
      'contextWindow',
      'maxTokens',
      'cost',
      'compat',
      'headers',
    ];
    for (const f of fields) {
      if (body[f] !== undefined) {
        if (body[f] === null || body[f] === '') {
          delete model[f];
        } else {
          model[f] = body[f];
        }
      }
    }
  }

  if (!model.id) throw new Error('model id required');

  if (isNew) {
    provider.models.push(model);
  } else {
    provider.models[idx] = model;
  }

  writeModelsFile(config);
  return { providerId, model };
}

function deleteModel(providerId, modelId) {
  if (!validateProviderId(providerId)) throw new Error('invalid provider id');
  if (!validateModelId(modelId)) throw new Error('invalid model id');
  const config = readModelsFile();
  const provider = config.providers[providerId];
  if (!provider) throw new Error('not found');
  if (!Array.isArray(provider.models)) throw new Error('model not found');
  const next = provider.models.filter((m) => m && m.id !== modelId);
  if (next.length === provider.models.length) throw new Error('model not found');
  provider.models = next;
  writeModelsFile(config);
}

/**
 * Flat model list for selectors: providerId/modelId
 */
function listAllModels() {
  const config = readModelsFile();
  const out = [];
  for (const [providerId, provider] of Object.entries(config.providers || {})) {
    const models = (provider && provider.models) || [];
    for (const m of models) {
      if (!m || !m.id) continue;
      out.push({
        id: providerId + '/' + m.id,
        providerId,
        modelId: m.id,
        name: m.name || m.id,
        reasoning: !!m.reasoning,
      });
    }
  }
  return out;
}

/** Pi thinking levels (UI + default map). Keep in sync with public/app.js TLM_LEVELS. */
const TLM_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/**
 * Default thinkingLevelMap for new/imported models.
 * Conservative: off→none; xhigh/max→high (many providers lack higher tiers).
 */
function defaultThinkingLevelMap() {
  return {
    off: 'none',
    minimal: 'minimal',
    low: 'low',
    medium: 'medium',
    high: 'high',
    xhigh: 'high',
    max: 'high',
  };
}

module.exports = {
  readModelsFile,
  writeModelsFile,
  listProviders,
  getProvider,
  redactModelsConfig,
  providerExists,
  upsertProvider,
  deleteProvider,
  getModel,
  upsertModel,
  deleteModel,
  listAllModels,
  summarizeProvider,
  TLM_LEVELS,
  defaultThinkingLevelMap,
};
