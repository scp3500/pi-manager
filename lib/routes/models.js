const {
  MODELS_FILE,
  SETTINGS_FILE,
  AGENTS_DIR,
  AGENTS_MD_FILE,
  MANAGER_CONFIG_FILE,
  OPENVL_PROFILES_FILE,
  OPENVL_ENV_FILE,
  OPENVL_AVAILABLE,
  PORT,
} = require('../config');
const { validateProviderId, validateModelId } = require('../model-security');
const {
  listProviders,
  getProvider,
  redactModelsConfig,
  providerExists,
  upsertProvider,
  deleteProvider,
  upsertModel,
  deleteModel,
  listAllModels,
  readModelsFile,
  writeModelsFile,
  defaultThinkingLevelMap,
} = require('../models');
const { getDefaults, setDefaults } = require('../settings');
const { detectMigrations, applyAzureRename } = require('../migrations');
const { BUILTIN_TOOLS, TOOL_PRESETS } = require('../tools');
const { CATEGORIES } = require('../categories');
const { fetchRemoteModels, testProviderConnection } = require('../fetch-models');
const {
  sendJson,
  sendError,
  readBody,
  decodeSeg,
  mapError,
} = require('./helpers');

async function handleModelsApi(req, res, pathname, method) {
  if (method === 'GET' && pathname === '/api/meta') {
    sendJson(res, 200, {
      modelsFile: MODELS_FILE,
      settingsFile: SETTINGS_FILE,
      agentsDir: AGENTS_DIR,
      agentsMdFile: AGENTS_MD_FILE,
      managerConfigFile: MANAGER_CONFIG_FILE,
      openvlAvailable: !!OPENVL_AVAILABLE,
      openvlProfilesFile: OPENVL_PROFILES_FILE || '',
      openvlEnvFile: OPENVL_ENV_FILE || '',
      port: PORT,
    });
    return true;
  }

  if (method === 'GET' && pathname === '/api/tool-pool') {
    sendJson(res, 200, {
      builtins: BUILTIN_TOOLS,
      presets: TOOL_PRESETS,
    });
    return true;
  }

  if (method === 'GET' && pathname === '/api/categories') {
    sendJson(res, 200, CATEGORIES);
    return true;
  }

  if (pathname === '/api/defaults') {
    if (method === 'GET') {
      try {
        sendJson(res, 200, getDefaults());
      } catch (e) {
        mapError(res, e);
      }
      return true;
    }
    if (method === 'PUT') {
      try {
        const body = await readBody(req);
        sendJson(res, 200, setDefaults(body || {}));
      } catch (e) {
        mapError(res, e);
      }
      return true;
    }
  }

  if (method === 'GET' && pathname === '/api/models') {
    try {
      sendJson(res, 200, listAllModels());
    } catch (e) {
      mapError(res, e);
    }
    return true;
  }

  // Pi 1.0.3 provider key 迁移体检（必须排在 /api/providers* 分支之前）
  if (method === 'GET' && pathname === '/api/migrations') {
    try {
      sendJson(res, 200, detectMigrations());
    } catch (e) {
      mapError(res, e);
    }
    return true;
  }

  if (method === 'POST' && pathname === '/api/migrations/azure-rename') {
    try {
      const body = await readBody(req);
      if (Array.isArray(body) || (body && typeof body !== 'object')) {
        sendError(res, 400, 'invalid body');
        return true;
      }
      if (body && Object.keys(body).length) {
        sendError(res, 400, 'unexpected parameters');
        return true;
      }
      sendJson(res, 200, applyAzureRename());
    } catch (e) {
      mapError(res, e);
    }
    return true;
  }

  if (pathname === '/api/config') {
    if (method === 'GET') {
      try {
        // 本地 loopback 控制台：默认返回真实配置；?redact=1 才脱敏
        const raw = readModelsFile();
        const url = new URL(req.url || '/', 'http://localhost');
        const redact = url.searchParams.get('redact') === '1';
        sendJson(res, 200, redact ? redactModelsConfig(raw) : raw);
      } catch (e) {
        mapError(res, e);
      }
      return true;
    }
    if (method === 'PUT') {
      try {
        const body = await readBody(req);
        writeModelsFile(body);
        sendJson(res, 200, { ok: true });
      } catch (e) {
        mapError(res, e);
      }
      return true;
    }
  }

  if (pathname === '/api/providers') {
    if (method === 'GET') {
      try {
        sendJson(res, 200, listProviders());
      } catch (e) {
        mapError(res, e);
      }
      return true;
    }
    if (method === 'POST') {
      try {
        const body = await readBody(req);
        const id = body && body.id;
        if (!id) return sendError(res, 400, 'id is required'), true;
        if (!validateProviderId(id)) return sendError(res, 400, 'invalid provider id'), true;
        if (providerExists(id)) return sendError(res, 409, 'provider already exists'), true;
        const result = upsertProvider(id, {
          baseUrl: body.baseUrl,
          api: body.api || 'openai-completions',
          apiKey: body.apiKey,
          headers: body.headers,
          authHeader: body.authHeader,
          compat: body.compat,
          models: body.models || [],
        });
        sendJson(res, 201, result);
      } catch (e) {
        mapError(res, e);
      }
      return true;
    }
  }

  if (pathname.startsWith('/api/providers/')) {
    const rest = pathname.slice('/api/providers/'.length);
    const parts = rest.split('/').filter(Boolean);
    if (!parts.length) return sendError(res, 404, 'Not Found'), true;

    const providerId = decodeSeg(parts[0]);
    if (providerId == null) return sendError(res, 400, 'invalid provider id'), true;

    if (parts.length === 1) {
      if (method === 'GET') {
        try {
          // 默认返回真实 Key；?redact=1 才脱敏
          const url = new URL(req.url || '/', 'http://localhost');
          const redact = url.searchParams.get('redact') === '1';
          sendJson(res, 200, getProvider(providerId, { revealKey: !redact }));
        } catch (e) {
          mapError(res, e);
        }
        return true;
      }
      if (method === 'PUT') {
        try {
          const body = await readBody(req);
          const newId = (body.id || providerId).trim();
          if (!validateProviderId(newId)) return sendError(res, 400, 'invalid provider id'), true;
          const result = upsertProvider(newId, body, {
            renameFrom: newId !== providerId ? providerId : undefined,
          });
          sendJson(res, 200, result);
        } catch (e) {
          mapError(res, e);
        }
        return true;
      }
      if (method === 'DELETE') {
        try {
          deleteProvider(providerId);
          sendJson(res, 200, { ok: true });
        } catch (e) {
          mapError(res, e);
        }
        return true;
      }
    }

    // POST /api/providers/:id/test  连通检测（可用表单草稿覆盖）
    if (parts.length === 2 && parts[1] === 'test' && method === 'POST') {
      try {
        const body = await readBody(req);
        sendJson(
          res,
          200,
          await testProviderConnection(providerId, {
            baseUrl: body && body.baseUrl,
            apiKey: body && body.apiKey,
            authHeader: body && body.authHeader,
            headers: body && body.headers,
            model: body && body.model,
            api: body && body.api,
          })
        );
      } catch (e) {
        sendError(res, 502, e.message || String(e));
      }
      return true;
    }

    // GET /api/providers/:id/remote-models  从供应商 baseUrl/models 拉取
    if (parts.length === 2 && parts[1] === 'remote-models' && method === 'GET') {
      try {
        const result = await fetchRemoteModels(providerId);
        // annotate already-local
        let localIds = new Set();
        try {
          const p = getProvider(providerId);
          localIds = new Set((p.models || []).map((m) => m.id));
        } catch {
          /* ignore */
        }
        sendJson(res, 200, {
          ...result,
          models: result.models.map((m) => ({
            id: m.id,
            name: m.name,
            owned_by: m.owned_by,
            guess: m.guess,
            local: localIds.has(m.id),
          })),
        });
      } catch (e) {
        sendError(res, 502, e.message || String(e));
      }
      return true;
    }

    // POST /api/providers/:id/remote-models  用草稿 baseUrl/apiKey 试拉（未保存供应商）
    if (parts.length === 2 && parts[1] === 'remote-models' && method === 'POST') {
      try {
        const body = await readBody(req);
        const result = await fetchRemoteModels(providerId, {
          baseUrl: body.baseUrl,
          apiKey: body.apiKey,
          authHeader: body.authHeader,
          headers: body.headers,
        });
        let localIds = new Set();
        try {
          if (providerExists(providerId)) {
            const p = getProvider(providerId);
            localIds = new Set((p.models || []).map((m) => m.id));
          }
        } catch {
          /* ignore */
        }
        sendJson(res, 200, {
          ...result,
          models: result.models.map((m) => ({
            id: m.id,
            name: m.name,
            owned_by: m.owned_by,
            guess: m.guess,
            local: localIds.has(m.id),
          })),
        });
      } catch (e) {
        sendError(res, 502, e.message || String(e));
      }
      return true;
    }

    // POST /api/providers/:id/import-models  批量导入选中的远程模型
    if (parts.length === 2 && parts[1] === 'import-models' && method === 'POST') {
      try {
        const body = await readBody(req);
        const items = Array.isArray(body.models) ? body.models : [];
        if (!items.length) return sendError(res, 400, 'models 不能为空'), true;
        const skipExisting = body.skipExisting !== false;
        const imported = [];
        const skipped = [];
        const failed = [];

        let existing = new Set();
        try {
          const p = getProvider(providerId);
          existing = new Set((p.models || []).map((m) => m.id));
        } catch (e) {
          return sendError(res, 404, e.message || 'provider not found'), true;
        }

        for (const item of items) {
          const id = (item && (item.id || item.model) ? String(item.id || item.model) : '').trim();
          if (!id) {
            failed.push({ id: '', error: 'empty id' });
            continue;
          }
          if (!validateModelId(id)) {
            failed.push({ id, error: 'invalid model id' });
            continue;
          }
          if (skipExisting && existing.has(id)) {
            skipped.push(id);
            continue;
          }
          try {
            const payload = {
              id,
              name: (item.name && String(item.name)) || id,
              reasoning: item.reasoning != null ? !!item.reasoning : true,
              input: Array.isArray(item.input) ? item.input : ['text'],
            };
            if (item.contextWindow != null && item.contextWindow !== '')
              payload.contextWindow = Number(item.contextWindow);
            if (item.maxTokens != null && item.maxTokens !== '')
              payload.maxTokens = Number(item.maxTokens);
            if (item.cost && typeof item.cost === 'object') payload.cost = item.cost;
            // defaults for cost if missing
            if (!payload.cost) {
              payload.cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
            }
            // 默认补全思考档位映射，避免新建/导入后漏档
            if (item.thinkingLevelMap && typeof item.thinkingLevelMap === 'object') {
              payload.thinkingLevelMap = item.thinkingLevelMap;
            } else {
              payload.thinkingLevelMap = defaultThinkingLevelMap();
            }
            upsertModel(providerId, existing.has(id) ? id : null, payload);
            existing.add(id);
            imported.push(id);
          } catch (e) {
            failed.push({ id, error: e.message || String(e) });
          }
        }

        sendJson(res, 200, {
          ok: true,
          imported,
          skipped,
          failed,
          provider: getProvider(providerId),
        });
      } catch (e) {
        mapError(res, e);
      }
      return true;
    }

    if (parts.length === 2 && parts[1] === 'models' && method === 'POST') {
      try {
        const body = await readBody(req);
        if (!body.id) return sendError(res, 400, 'model id is required'), true;
        if (!validateModelId(body.id)) return sendError(res, 400, 'invalid model id'), true;
        sendJson(res, 201, upsertModel(providerId, null, body));
      } catch (e) {
        mapError(res, e);
      }
      return true;
    }

    if (parts.length >= 3 && parts[1] === 'models') {
      const modelId = decodeSeg(parts.slice(2).join('/'));
      if (modelId == null) return sendError(res, 400, 'invalid model id'), true;
      if (method === 'PUT') {
        try {
          const body = await readBody(req);
          sendJson(res, 200, upsertModel(providerId, modelId, body || {}));
        } catch (e) {
          mapError(res, e);
        }
        return true;
      }
      if (method === 'DELETE') {
        try {
          deleteModel(providerId, modelId);
          sendJson(res, 200, { ok: true });
        } catch (e) {
          mapError(res, e);
        }
        return true;
      }
    }
  }

  return false;
}

module.exports = { handleModelsApi };
