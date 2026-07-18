const http = require('http');
const fs = require('fs');
const path = require('path');
const {
  AGENTS_DIR,
  MODELS_FILE,
  SETTINGS_FILE,
  OPENVL_PROFILES_FILE,
  OPENVL_ENV_FILE,
  OPENVL_AVAILABLE,
  MANAGER_CONFIG_FILE,
  AGENTS_MD_FILE,
  PORT,
  BODY_LIMIT,
} = require('./lib/config');
const { validateProviderId, validateModelId } = require('./lib/model-security');
const { validateAgentName } = require('./lib/agent-security');
const {
  listProviders,
  getProvider,
  providerExists,
  upsertProvider,
  deleteProvider,
  upsertModel,
  deleteModel,
  listAllModels,
  readModelsFile,
  writeModelsFile,
} = require('./lib/models');
const { getDefaults, setDefaults } = require('./lib/settings');
const {
  listAgents,
  readAgent,
  writeAgent,
  renameAgent,
  deleteAgent,
  agentExists,
} = require('./lib/agents');
const { BUILTIN_TOOLS, TOOL_PRESETS } = require('./lib/tools');
const { CATEGORIES } = require('./lib/categories');
const { fetchRemoteModels, testProviderConnection } = require('./lib/fetch-models');
const openvl = require('./lib/openvl');
const {
  readManagerConfig,
  writeManagerConfig,
  updateFeatures,
} = require('./lib/manager-config');
const workspaces = require('./lib/workspaces');
const promptApi = require('./lib/prompt');
const skillsApi = require('./lib/skills');
const pluginsApi = require('./lib/plugins');
const filesApi = require('./lib/files');
const sessionsApi = require('./lib/sessions');
const opsApi = require('./lib/ops');
const usageApi = require('./lib/usage');
const runtimeApi = require('./lib/runtime');
const chatApi = require('./lib/chat');
const chatClient = require('./lib/chat-client');
const chatTools = require('./lib/chat-tools');
const installApi = require('./lib/install');

/** @type {Map<string, AbortController>} */
const chatAbortMap = new Map();

const PUBLIC_DIR = path.resolve(__dirname, 'public');
const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function sendError(res, code, message) {
  sendJson(res, code, { error: message });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let exceeded = false;
    req.on('data', (chunk) => {
      if (exceeded) return;
      body += chunk;
      if (body.length > BODY_LIMIT) {
        exceeded = true;
        body = '';
        reject(Object.assign(new Error('body too large'), { status: 413 }));
      }
    });
    req.on('end', () => {
      if (exceeded) return;
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(Object.assign(new Error('Invalid JSON body'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function safePublicPath(urlPath) {
  const rel = decodeURIComponent(urlPath).replace(/^\/+/, '');
  const filePath = path.resolve(path.join(PUBLIC_DIR, rel || 'index.html'));
  const prefix = PUBLIC_DIR.endsWith(path.sep) ? PUBLIC_DIR : PUBLIC_DIR + path.sep;
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(prefix)) return null;
  return filePath;
}

function serveStatic(res, urlPath) {
  const filePath = safePublicPath(urlPath);
  if (!filePath) return sendError(res, 404, 'Not Found');
  const ext = path.extname(filePath);
  const type = STATIC_TYPES[ext];
  if (!type) return sendError(res, 404, 'Not Found');
  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': type });
    res.end(content);
  } catch {
    sendError(res, 404, 'Not Found');
  }
}

function decodeSeg(seg) {
  try {
    return decodeURIComponent(seg);
  } catch {
    return null;
  }
}

function mapError(res, e) {
  const msg = e && e.message ? e.message : 'Internal error';
  const notFound = [
    'not found',
    'model not found',
    'invalid provider id',
    'invalid model id',
    'invalid agent name',
    'invalid path',
  ];
  if (notFound.includes(msg)) {
    sendError(res, msg.startsWith('invalid') ? 400 : 404, msg === 'not found' || msg === 'model not found' ? 'Not Found' : msg);
    return;
  }
  if (
    msg === 'target id already exists' ||
    msg === 'model already exists' ||
    msg === 'target model id already exists' ||
    msg === 'target name already exists' ||
    msg === 'Agent already exists' ||
    msg === 'provider already exists'
  ) {
    sendError(res, 409, msg);
    return;
  }
  if (
    msg.includes('valid JSON') ||
    msg.includes('must be') ||
    msg.startsWith('failed to delete old agent') ||
    msg.includes('does not exist') ||
    msg.includes('refused') ||
    msg.includes('required') ||
    msg.includes('cannot delete') ||
    msg.includes('invalid workspace') ||
    msg.includes('dangerous') ||
    msg.includes('backup not found') ||
    msg.includes('map key')
  ) {
    sendError(res, msg.startsWith('failed') ? 500 : 400, msg);
    return;
  }
  console.error(e);
  sendError(res, 500, 'Internal error');
}

// ── Agents API (from subagent-manager) ──────────────────────────────────────

async function handleAgentsApi(req, res, pathname, method) {
  if (method === 'GET' && pathname === '/api/agents') {
    try {
      sendJson(res, 200, listAgents());
    } catch (e) {
      mapError(res, e);
    }
    return true;
  }

  if (method === 'POST' && pathname === '/api/agents') {
    try {
      const body = await readBody(req);
      const name = body && body.name;
      if (!name) return sendError(res, 400, 'name is required'), true;
      if (!validateAgentName(name)) return sendError(res, 400, 'invalid agent name'), true;
      if (agentExists(name)) return sendError(res, 409, 'Agent already exists'), true;
      writeAgent(
        name,
        {
          description: body.description,
          category: body.category,
          tools: body.tools,
          model: body.model,
          thinking: body.thinking,
        },
        body.prompt || ''
      );
      sendJson(res, 201, { ok: true, name });
    } catch (e) {
      if (e.status) sendError(res, e.status, e.message);
      else mapError(res, e);
    }
    return true;
  }

  if (pathname.startsWith('/api/agents/')) {
    const rest = pathname.slice('/api/agents/'.length);
    if (!rest || rest.includes('/')) return false;
    const name = decodeSeg(rest);
    if (name == null) return sendError(res, 400, 'invalid agent name'), true;

    if (method === 'GET') {
      try {
        sendJson(res, 200, readAgent(name));
      } catch (e) {
        mapError(res, e);
      }
      return true;
    }
    if (method === 'PUT') {
      try {
        const body = await readBody(req);
        readAgent(name);
        const newName = (body.name || name).trim();
        if (!validateAgentName(newName)) return sendError(res, 400, 'invalid new name'), true;
        const fields = {
          description: body.description,
          category: body.category,
          tools: body.tools,
          model: body.model,
          thinking: body.thinking,
        };
        const prompt = body.prompt || '';
        if (newName !== name) renameAgent(name, newName, fields, prompt);
        else writeAgent(name, fields, prompt);
        sendJson(res, 200, { ok: true, name: newName });
      } catch (e) {
        if (e.status) sendError(res, e.status, e.message);
        else mapError(res, e);
      }
      return true;
    }
    if (method === 'DELETE') {
      try {
        deleteAgent(name);
        sendJson(res, 200, { ok: true });
      } catch (e) {
        mapError(res, e);
      }
      return true;
    }
  }
  return false;
}

// ── Models API ──────────────────────────────────────────────────────────────

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
        if (e.status) sendError(res, e.status, e.message);
        else mapError(res, e);
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

  if (pathname === '/api/config') {
    if (method === 'GET') {
      try {
        sendJson(res, 200, readModelsFile());
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
        if (e.status) sendError(res, e.status, e.message);
        else mapError(res, e);
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
        if (e.status) sendError(res, e.status, e.message);
        else mapError(res, e);
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
          sendJson(res, 200, getProvider(providerId));
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
          if (e.status) sendError(res, e.status, e.message);
          else mapError(res, e);
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
              reasoning: !!item.reasoning,
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
        if (e.status) sendError(res, e.status, e.message);
        else mapError(res, e);
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
        if (e.status) sendError(res, e.status, e.message);
        else mapError(res, e);
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
          if (e.status) sendError(res, e.status, e.message);
          else mapError(res, e);
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

// ── OpenVL / 识图 API ───────────────────────────────────────────────────────

async function handleOpenvlApi(req, res, pathname, method) {
  if (!pathname.startsWith('/api/openvl')) return false;

  // GET 列表允许在未安装时返回 available:false；其它写/测操作返回 503
  const isListGet = method === 'GET' && pathname === '/api/openvl/profiles';
  const isDoctor = method === 'GET' && pathname === '/api/openvl/doctor';
  if (!OPENVL_AVAILABLE && !isListGet && !isDoctor) {
    sendError(
      res,
      503,
      '未检测到 OpenVL。安装: npm install -g @scp3500/openvl，或设置 OPENVL_PKG_DIR'
    );
    return true;
  }

  // GET /api/openvl/profiles
  if (method === 'GET' && pathname === '/api/openvl/profiles') {
    try {
      sendJson(res, 200, openvl.listProfiles());
    } catch (e) {
      mapError(res, e);
    }
    return true;
  }

  // POST /api/openvl/profiles  新建
  if (method === 'POST' && pathname === '/api/openvl/profiles') {
    try {
      const body = await readBody(req);
      sendJson(res, 201, openvl.createProfile(body || {}));
    } catch (e) {
      if (e.status) sendError(res, e.status, e.message);
      else mapError(res, e);
    }
    return true;
  }

  // POST /api/openvl/profiles/switch  {id}
  if (method === 'POST' && pathname === '/api/openvl/profiles/switch') {
    try {
      const body = await readBody(req);
      if (!body || !body.id) return sendError(res, 400, 'id is required'), true;
      sendJson(res, 200, openvl.switchProfile(body.id));
    } catch (e) {
      if (e.status) sendError(res, e.status, e.message);
      else mapError(res, e);
    }
    return true;
  }

  // GET|PUT|DELETE /api/openvl/profiles/:id
  if (pathname.startsWith('/api/openvl/profiles/')) {
    const rest = pathname.slice('/api/openvl/profiles/'.length);
    if (!rest || rest.includes('/')) {
      // fall through to other openvl routes
    } else {
      const id = decodeSeg(rest);
      if (id == null) return sendError(res, 400, 'invalid id'), true;
      if (method === 'GET') {
        try {
          const reveal = (req.url || '').includes('reveal=1');
          sendJson(res, 200, openvl.getProfile(id, { revealKey: reveal }));
        } catch (e) {
          mapError(res, e);
        }
        return true;
      }
      if (method === 'PUT') {
        try {
          const body = await readBody(req);
          sendJson(res, 200, openvl.updateProfile(id, body || {}));
        } catch (e) {
          if (e.status) sendError(res, e.status, e.message);
          else mapError(res, e);
        }
        return true;
      }
      if (method === 'DELETE') {
        try {
          sendJson(res, 200, openvl.deleteProfile(id));
        } catch (e) {
          mapError(res, e);
        }
        return true;
      }
    }
  }

  // GET|PUT /api/openvl/ollama
  if (pathname === '/api/openvl/ollama') {
    if (method === 'GET') {
      try {
        const data = openvl.listProfiles();
        sendJson(res, 200, data.ollama);
      } catch (e) {
        mapError(res, e);
      }
      return true;
    }
    if (method === 'PUT' || method === 'POST') {
      try {
        const body = await readBody(req);
        sendJson(res, 200, openvl.updateOllama(body || {}));
      } catch (e) {
        if (e.status) sendError(res, e.status, e.message);
        else mapError(res, e);
      }
      return true;
    }
  }

  // POST /api/openvl/ollama/check
  if (method === 'POST' && pathname === '/api/openvl/ollama/check') {
    try {
      const body = await readBody(req);
      sendJson(res, 200, await openvl.checkOllama(body || {}));
    } catch (e) {
      sendError(res, 502, e.message || String(e));
    }
    return true;
  }

  // POST /api/openvl/test  连通检测（可用 body 覆盖当前编辑中的地址/Key/model）
  if (method === 'POST' && pathname === '/api/openvl/test') {
    try {
      const body = await readBody(req);
      sendJson(res, 200, await openvl.testApi(body || {}));
    } catch (e) {
      sendError(res, 502, e.message || String(e));
    }
    return true;
  }

  // POST /api/openvl/remote-models  检测视觉接口可用模型
  if (method === 'POST' && pathname === '/api/openvl/remote-models') {
    try {
      const body = await readBody(req);
      sendJson(res, 200, await openvl.listRemoteModels(body || {}));
    } catch (e) {
      sendError(res, 502, e.message || String(e));
    }
    return true;
  }

  // GET /api/openvl/doctor
  if (method === 'GET' && pathname === '/api/openvl/doctor') {
    try {
      sendJson(res, 200, openvl.runDoctor());
    } catch (e) {
      sendError(res, 500, e.message || String(e));
    }
    return true;
  }

  sendError(res, 404, 'Not Found');
  return true;
}

// ── Console APIs: workspaces / prompt / skills / plugins ─────────────────────

async function handleConsoleApi(req, res, pathname, method) {
  // manager config
  if (pathname === '/api/manager-config') {
    if (method === 'GET') {
      try {
        sendJson(res, 200, readManagerConfig());
      } catch (e) {
        mapError(res, e);
      }
      return true;
    }
    if (method === 'PUT') {
      try {
        const body = await readBody(req);
        sendJson(res, 200, writeManagerConfig(body || {}));
      } catch (e) {
        if (e.status) sendError(res, e.status, e.message);
        else mapError(res, e);
      }
      return true;
    }
  }

  // features 开关（记忆/知识库等），不必整份覆盖 pi-manager.json
  if (pathname === '/api/features') {
    if (method === 'GET') {
      try {
        const cfg = readManagerConfig();
        sendJson(res, 200, { features: cfg.features || {}, configFile: cfg.configFile });
      } catch (e) {
        mapError(res, e);
      }
      return true;
    }
    if (method === 'PUT' || method === 'PATCH') {
      try {
        const body = await readBody(req);
        const partial = body && body.features ? body.features : body || {};
        const out = updateFeatures(partial);
        sendJson(res, 200, { features: out.features, configFile: out.configFile });
      } catch (e) {
        if (e.status) sendError(res, e.status, e.message);
        else mapError(res, e);
      }
      return true;
    }
  }

  // status / readiness (+ dashboard extras)
  if (method === 'GET' && pathname === '/api/status') {
    try {
      const st = workspaces.getStatus();
      st.openvl = {
        available: !!OPENVL_AVAILABLE,
        hint: OPENVL_AVAILABLE
          ? null
          : '未检测到 OpenVL。可 npm install -g @scp3500/openvl 或设置 OPENVL_PKG_DIR',
      };
      try {
        const defs = getDefaults();
        st.defaults = {
          defaultProvider: defs.defaultProvider || null,
          defaultModel: defs.defaultModel || null,
          defaultThinkingLevel: defs.defaultThinkingLevel || null,
        };
      } catch {
        st.defaults = null;
      }
      try {
        const sk = skillsApi.listSkills();
        const skillArr = Array.isArray(sk) ? sk : sk && Array.isArray(sk.skills) ? sk.skills : [];
        st.counts = {
          providers: listProviders().length,
          models: listAllModels().length,
          agents: listAgents().length,
          skills: skillArr.length,
        };
      } catch {
        st.counts = { providers: 0, models: 0, agents: 0, skills: 0 };
      }
      try {
        st.sessions = sessionsApi.getSessionsSummary();
      } catch (e) {
        st.sessions = { exists: false, error: e.message };
      }
      try {
        st.junk = sessionsApi.getJunkSummary();
      } catch (e) {
        st.junk = { error: e.message };
      }
      sendJson(res, 200, st);
    } catch (e) {
      mapError(res, e);
    }
    return true;
  }

  // runtime overview (sessions jsonl activity + subagent tail)
  if (method === 'GET' && pathname === '/api/runtime') {
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      const force = url.searchParams.get('force');
      const limit = url.searchParams.get('limit');
      sendJson(
        res,
        200,
        runtimeApi.collectRuntime({
          force: force === '1' || force === 'true',
          limit: limit != null ? Number(limit) : undefined,
        })
      );
    } catch (e) {
      if (e.status) sendError(res, e.status, e.message);
      else mapError(res, e);
    }
    return true;
  }

  // usage / token stats (pi-token-stats + pi-tracker style windows)
  if (method === 'GET' && pathname === '/api/usage') {
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      const window =
        url.searchParams.get('window') ||
        url.searchParams.get('days') ||
        'week';
      const force = url.searchParams.get('force');
      sendJson(
        res,
        200,
        usageApi.collectUsage({
          window,
          force: force === '1' || force === 'true',
        })
      );
    } catch (e) {
      if (e.status) sendError(res, e.status, e.message);
      else mapError(res, e);
    }
    return true;
  }

  // sessions
  if (method === 'GET' && pathname === '/api/sessions') {
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      const cwd = url.searchParams.get('cwd') || '';
      const q = url.searchParams.get('q') || '';
      const limit = url.searchParams.get('limit');
      const offset = url.searchParams.get('offset');
      sendJson(
        res,
        200,
        sessionsApi.listSessions({
          cwd: cwd || undefined,
          q: q || undefined,
          limit: limit != null ? Number(limit) : undefined,
          offset: offset != null ? Number(offset) : undefined,
        })
      );
    } catch (e) {
      if (e.status) sendError(res, e.status, e.message);
      else mapError(res, e);
    }
    return true;
  }
  if (method === 'POST' && pathname === '/api/sessions/delete') {
    try {
      const body = await readBody(req);
      const paths = body && body.paths;
      sendJson(res, 200, sessionsApi.deleteSessionFiles(paths));
    } catch (e) {
      if (e.status) sendError(res, e.status, e.message);
      else mapError(res, e);
    }
    return true;
  }
  if (method === 'POST' && pathname === '/api/sessions/cleanup') {
    try {
      const body = await readBody(req);
      const days = body && body.days != null ? Number(body.days) : 7;
      sendJson(res, 200, sessionsApi.deleteSessionsOlderThan(days));
    } catch (e) {
      if (e.status) sendError(res, e.status, e.message);
      else mapError(res, e);
    }
    return true;
  }

  // junk cleanup (tmp_*, .bak.N)
  if (method === 'GET' && pathname === '/api/cleanup/junk') {
    try {
      sendJson(res, 200, sessionsApi.listJunkFiles());
    } catch (e) {
      if (e.status) sendError(res, e.status, e.message);
      else mapError(res, e);
    }
    return true;
  }
  if (method === 'POST' && pathname === '/api/cleanup/junk') {
    try {
      const body = await readBody(req);
      sendJson(
        res,
        200,
        sessionsApi.cleanupJunk({
          mode: (body && body.mode) || 'tmp',
          dryRun: !!(body && body.dryRun),
        })
      );
    } catch (e) {
      if (e.status) sendError(res, e.status, e.message);
      else mapError(res, e);
    }
    return true;
  }

  // search / export / health
  if (method === 'GET' && pathname === '/api/search') {
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      sendJson(
        res,
        200,
        opsApi.searchAll({
          q: url.searchParams.get('q') || '',
          scope: url.searchParams.get('scope') || 'all',
          limit: url.searchParams.get('limit')
            ? Number(url.searchParams.get('limit'))
            : undefined,
        })
      );
    } catch (e) {
      if (e.status) sendError(res, e.status, e.message);
      else mapError(res, e);
    }
    return true;
  }
  if (method === 'GET' && pathname === '/api/export') {
    try {
      const data = opsApi.exportConfig();
      const url = new URL(req.url || '/', 'http://localhost');
      const download = url.searchParams.get('download');
      if (download === '1' || download === 'true') {
        const body = JSON.stringify(data, null, 2);
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Disposition':
            'attachment; filename="pi-manager-export-' +
            new Date().toISOString().slice(0, 10) +
            '.json"',
        });
        res.end(body);
        return true;
      }
      sendJson(res, 200, data);
    } catch (e) {
      if (e.status) sendError(res, e.status, e.message);
      else mapError(res, e);
    }
    return true;
  }
  if (method === 'GET' && pathname === '/api/health') {
    try {
      const data = await opsApi.runHealth();
      sendJson(res, 200, data);
    } catch (e) {
      if (e.status) sendError(res, e.status, e.message);
      else mapError(res, e);
    }
    return true;
  }

  // workspaces
  if (method === 'GET' && pathname === '/api/workspaces') {
    try {
      sendJson(res, 200, workspaces.listWorkspaces());
    } catch (e) {
      mapError(res, e);
    }
    return true;
  }
  if (method === 'POST' && pathname === '/api/workspaces') {
    try {
      const body = await readBody(req);
      sendJson(res, 201, workspaces.createWorkspace(body || {}));
    } catch (e) {
      if (e.status) sendError(res, e.status, e.message);
      else mapError(res, e);
    }
    return true;
  }
  if (method === 'POST' && pathname === '/api/workspaces/bootstrap') {
    try {
      const body = await readBody(req);
      sendJson(res, 201, workspaces.bootstrapWorkspace(body || {}));
    } catch (e) {
      if (e.status) sendError(res, e.status, e.message);
      else mapError(res, e);
    }
    return true;
  }
  if (method === 'POST' && pathname === '/api/workspaces/adopt') {
    try {
      const body = await readBody(req);
      if (!body || !body.id) return sendError(res, 400, 'id is required'), true;
      sendJson(res, 201, workspaces.adoptSuggestion(body.id));
    } catch (e) {
      mapError(res, e);
    }
    return true;
  }
  if (pathname.startsWith('/api/workspaces/')) {
    const rest = pathname.slice('/api/workspaces/'.length);
    if (!rest) return sendError(res, 404, 'Not Found'), true;
    const parts = rest.split('/').filter(Boolean);
    const id = decodeSeg(parts[0]);
    if (id == null) return sendError(res, 400, 'invalid id'), true;

    // GET /api/workspaces/:id/tree?path=&depth=
    if (parts.length === 2 && parts[1] === 'tree' && method === 'GET') {
      try {
        const url = new URL(req.url || '/', 'http://localhost');
        const rel = url.searchParams.get('path') || '';
        const depth = url.searchParams.get('depth');
        sendJson(
          res,
          200,
          filesApi.listTree(id, rel, {
            maxDepth: depth != null ? Number(depth) : 3,
          })
        );
      } catch (e) {
        mapError(res, e);
      }
      return true;
    }

    // GET|PUT|POST|DELETE /api/workspaces/:id/file?path=
    if (parts.length === 2 && parts[1] === 'file') {
      try {
        const url = new URL(req.url || '/', 'http://localhost');
        const rel = url.searchParams.get('path') || '';
        if (method === 'GET') {
          if (!rel) return sendError(res, 400, 'path is required'), true;
          sendJson(res, 200, filesApi.readFile(id, rel));
          return true;
        }
        if (method === 'PUT') {
          if (!rel) return sendError(res, 400, 'path is required'), true;
          const body = await readBody(req);
          if (body == null || body.content === undefined) {
            return sendError(res, 400, 'content is required'), true;
          }
          sendJson(res, 200, filesApi.writeFile(id, rel, String(body.content)));
          return true;
        }
        if (method === 'POST') {
          const body = await readBody(req);
          const target = rel || (body && body.path) || '';
          if (!target) return sendError(res, 400, 'path is required'), true;
          const kind = (body && body.kind) || 'file';
          if (kind === 'dir') {
            sendJson(res, 201, filesApi.mkdir(id, target));
          } else {
            sendJson(
              res,
              201,
              filesApi.createFile(id, target, body && body.content != null ? String(body.content) : '')
            );
          }
          return true;
        }
        if (method === 'DELETE') {
          if (!rel) return sendError(res, 400, 'path is required'), true;
          const hard =
            url.searchParams.get('hard') === '1' ||
            url.searchParams.get('hard') === 'true';
          sendJson(res, 200, filesApi.deletePath(id, rel, { hard }));
          return true;
        }
      } catch (e) {
        if (e.status) sendError(res, e.status, e.message);
        else mapError(res, e);
      }
      return true;
    }

    // trash: list / restore / purge
    if (parts.length === 2 && parts[1] === 'trash' && method === 'GET') {
      try {
        sendJson(res, 200, filesApi.listTrash(id));
      } catch (e) {
        if (e.status) sendError(res, e.status, e.message);
        else mapError(res, e);
      }
      return true;
    }
    if (parts.length === 2 && parts[1] === 'trash-restore' && method === 'POST') {
      try {
        const body = await readBody(req);
        const stamp = (body && (body.stamp || body.path || body.trashPath)) || '';
        if (!stamp) return sendError(res, 400, 'stamp is required'), true;
        sendJson(res, 200, filesApi.restoreTrash(id, stamp));
      } catch (e) {
        if (e.status) sendError(res, e.status, e.message);
        else mapError(res, e);
      }
      return true;
    }
    if (parts.length === 2 && parts[1] === 'trash-purge' && method === 'POST') {
      try {
        const body = await readBody(req);
        const stamp = body && (body.stamp || body.path || body.trashPath);
        sendJson(res, 200, filesApi.purgeTrash(id, stamp || null));
      } catch (e) {
        if (e.status) sendError(res, e.status, e.message);
        else mapError(res, e);
      }
      return true;
    }

    // POST /api/workspaces/:id/rename  { from, to }
    if (parts.length === 2 && parts[1] === 'rename' && method === 'POST') {
      try {
        const body = await readBody(req);
        if (!body || !body.from || !body.to) {
          return sendError(res, 400, 'from and to are required'), true;
        }
        sendJson(res, 200, filesApi.renamePath(id, body.from, body.to));
      } catch (e) {
        if (e.status) sendError(res, e.status, e.message);
        else mapError(res, e);
      }
      return true;
    }

    if (parts.length === 1) {
      if (method === 'GET') {
        try {
          sendJson(res, 200, workspaces.getWorkspace(id));
        } catch (e) {
          mapError(res, e);
        }
        return true;
      }
      if (method === 'PUT') {
        try {
          const body = await readBody(req);
          sendJson(res, 200, workspaces.updateWorkspace(id, body || {}));
        } catch (e) {
          if (e.status) sendError(res, e.status, e.message);
          else mapError(res, e);
        }
        return true;
      }
      if (method === 'DELETE') {
        try {
          sendJson(res, 200, workspaces.deleteWorkspace(id));
        } catch (e) {
          mapError(res, e);
        }
        return true;
      }
    }
  }

  // prompt list / create
  if (pathname === '/api/prompts') {
    if (method === 'GET') {
      try {
        sendJson(res, 200, promptApi.listPromptFiles());
      } catch (e) {
        mapError(res, e);
      }
      return true;
    }
    if (method === 'POST') {
      try {
        const body = await readBody(req);
        if (!body || !body.name) return sendError(res, 400, 'name is required'), true;
        sendJson(
          res,
          201,
          promptApi.createPromptFile(String(body.name), body.content != null ? String(body.content) : '')
        );
      } catch (e) {
        mapError(res, e);
      }
      return true;
    }
  }

  // prompt by id: agents | prompt:foo.md | foo.md
  if (pathname.startsWith('/api/prompts/')) {
    const rest = pathname.slice('/api/prompts/'.length);
    if (!rest || rest.includes('/')) {
      // allow prompt:name.md encoded
    }
    const id = decodeSeg(rest);
    if (id == null) return sendError(res, 400, 'invalid id'), true;
    if (method === 'GET') {
      try {
        sendJson(res, 200, promptApi.readPromptById(id));
      } catch (e) {
        mapError(res, e);
      }
      return true;
    }
    if (method === 'PUT') {
      try {
        const body = await readBody(req);
        if (body == null || body.content === undefined) {
          return sendError(res, 400, 'content is required'), true;
        }
        sendJson(res, 200, promptApi.writePromptById(id, String(body.content)));
      } catch (e) {
        if (e.status) sendError(res, e.status, e.message);
        else mapError(res, e);
      }
      return true;
    }
    if (method === 'DELETE') {
      try {
        sendJson(res, 200, promptApi.deletePromptFile(id));
      } catch (e) {
        mapError(res, e);
      }
      return true;
    }
  }

  // prompt (AGENTS.md) — 兼容旧接口
  if (pathname === '/api/prompt') {
    if (method === 'GET') {
      try {
        sendJson(res, 200, promptApi.readPrompt());
      } catch (e) {
        mapError(res, e);
      }
      return true;
    }
    if (method === 'PUT') {
      try {
        const body = await readBody(req);
        if (body == null || body.content === undefined) {
          return sendError(res, 400, 'content is required'), true;
        }
        sendJson(res, 200, promptApi.writePrompt(String(body.content)));
      } catch (e) {
        if (e.status) sendError(res, e.status, e.message);
        else mapError(res, e);
      }
      return true;
    }
  }
  if (method === 'POST' && pathname === '/api/prompt/restore') {
    try {
      const body = await readBody(req);
      if (!body || !body.name) return sendError(res, 400, 'name is required'), true;
      if (body.id) {
        sendJson(res, 200, promptApi.restorePromptById(String(body.id), String(body.name)));
      } else {
        sendJson(res, 200, promptApi.restoreBackup(String(body.name)));
      }
    } catch (e) {
      mapError(res, e);
    }
    return true;
  }

  // skills
  if (pathname === '/api/skills') {
    if (method === 'GET') {
      try {
        sendJson(res, 200, skillsApi.listSkills());
      } catch (e) {
        mapError(res, e);
      }
      return true;
    }
  }
  if (pathname === '/api/skills/settings') {
    if (method === 'PUT' || method === 'POST') {
      try {
        const body = await readBody(req);
        sendJson(res, 200, skillsApi.updateSkillSettings(body || {}));
      } catch (e) {
        if (e.status) sendError(res, e.status, e.message);
        else mapError(res, e);
      }
      return true;
    }
  }
  // POST /api/skills/:id/toggle  {enabled:true|false}
  if (pathname.startsWith('/api/skills/') && pathname.endsWith('/toggle') && method === 'POST') {
    try {
      const mid = pathname.slice('/api/skills/'.length, -'/toggle'.length);
      const id = decodeSeg(mid.replace(/\/$/, ''));
      if (id == null || !id) return sendError(res, 400, 'invalid id'), true;
      const body = await readBody(req);
      if (body == null || body.enabled === undefined) {
        return sendError(res, 400, 'enabled is required'), true;
      }
      sendJson(res, 200, skillsApi.setSkillEnabled(id, !!body.enabled));
    } catch (e) {
      if (e.status) sendError(res, e.status, e.message);
      else mapError(res, e);
    }
    return true;
  }

  // plugins
  if (pathname === '/api/plugins') {
    if (method === 'GET') {
      try {
        sendJson(res, 200, pluginsApi.listPlugins());
      } catch (e) {
        mapError(res, e);
      }
      return true;
    }
    if (method === 'PUT') {
      try {
        const body = await readBody(req);
        sendJson(res, 200, pluginsApi.updatePlugins(body || {}));
      } catch (e) {
        if (e.status) sendError(res, e.status, e.message);
        else mapError(res, e);
      }
      return true;
    }
  }
  if (method === 'POST' && pathname === '/api/plugins/normalize-paths') {
    try {
      sendJson(res, 200, pluginsApi.normalizeSettingsPaths());
    } catch (e) {
      if (e.status) sendError(res, e.status, e.message);
      else mapError(res, e);
    }
    return true;
  }

  // guides one-click install (whitelist only)
  if (method === 'GET' && pathname === '/api/install/status') {
    try {
      sendJson(res, 200, installApi.status());
    } catch (e) {
      mapError(res, e);
    }
    return true;
  }
  if (method === 'GET' && pathname.startsWith('/api/install/jobs/')) {
    try {
      const id = decodeURIComponent(pathname.slice('/api/install/jobs/'.length));
      const job = installApi.getJob(id);
      if (!job) sendError(res, 404, 'job not found');
      else sendJson(res, 200, job);
    } catch (e) {
      mapError(res, e);
    }
    return true;
  }
  if (method === 'POST' && pathname === '/api/install/openvl') {
    try {
      const running = installApi.getJob('openvl');
      if (running && running.running) {
        sendJson(res, 200, { started: false, job: running });
        return true;
      }
      const p = installApi.installOpenvl();
      p.catch(() => {});
      sendJson(res, 202, { started: true, job: installApi.getJob('openvl') });
    } catch (e) {
      if (e.status) sendError(res, e.status, e.message);
      else mapError(res, e);
    }
    return true;
  }
  if (method === 'POST' && pathname === '/api/install/plugin') {
    try {
      const body = await readBody(req);
      const spec = (body && (body.spec || body.package || body.name)) || '';
      const running = installApi.getJob('plugin');
      if (running && running.running) {
        sendJson(res, 200, { started: false, job: running });
        return true;
      }
      const p = installApi.installPlugin(spec);
      p.catch(() => {});
      sendJson(res, 202, { started: true, job: installApi.getJob('plugin') });
    } catch (e) {
      if (e.status) sendError(res, e.status, e.message);
      else mapError(res, e);
    }
    return true;
  }
  if (method === 'POST' && pathname === '/api/install/agent-starter') {
    try {
      sendJson(res, 200, installApi.createStarterAgent());
    } catch (e) {
      if (e.status) sendError(res, e.status, e.message);
      else mapError(res, e);
    }
    return true;
  }

  return false;
}

function writeSse(res, event, data) {
  res.write('event: ' + event + '\n');
  res.write('data: ' + JSON.stringify(data == null ? {} : data) + '\n\n');
}

async function handleChatApi(req, res, pathname, method) {
  if (!pathname.startsWith('/api/chat')) return false;

  // GET /api/chat/models
  if (method === 'GET' && pathname === '/api/chat/models') {
    try {
      sendJson(res, 200, chatApi.listChatModels());
    } catch (e) {
      mapError(res, e);
    }
    return true;
  }

  // GET /api/chat/tools
  if (method === 'GET' && pathname === '/api/chat/tools') {
    try {
      sendJson(res, 200, { tools: chatTools.listTools() });
    } catch (e) {
      mapError(res, e);
    }
    return true;
  }

  // POST /api/chat/tools/run  { name, args }
  if (method === 'POST' && pathname === '/api/chat/tools/run') {
    try {
      const body = await readBody(req);
      const name = body && body.name;
      if (!name) {
        sendError(res, 400, 'name required');
        return true;
      }
      const result = await chatTools.runTool(String(name), body.args || {});
      sendJson(res, result.ok ? 200 : 400, result);
    } catch (e) {
      if (e.status) sendError(res, e.status, e.message);
      else mapError(res, e);
    }
    return true;
  }

  // POST /api/chat/tools/confirm  { confirmId }
  if (method === 'POST' && pathname === '/api/chat/tools/confirm') {
    try {
      const body = await readBody(req);
      const confirmId = body && body.confirmId;
      if (!confirmId) {
        sendError(res, 400, 'confirmId required');
        return true;
      }
      const result = await chatTools.confirmWrite(String(confirmId));
      sendJson(res, 200, result);
    } catch (e) {
      if (e.status) sendError(res, e.status, e.message);
      else mapError(res, e);
    }
    return true;
  }

  // POST /api/chat/tools/reject  { confirmId }
  if (method === 'POST' && pathname === '/api/chat/tools/reject') {
    try {
      const body = await readBody(req);
      sendJson(res, 200, chatTools.rejectWrite(body && body.confirmId));
    } catch (e) {
      if (e.status) sendError(res, e.status, e.message);
      else mapError(res, e);
    }
    return true;
  }

  // GET /api/chat/sessions
  if (method === 'GET' && pathname === '/api/chat/sessions') {
    try {
      sendJson(res, 200, chatApi.listSessions());
    } catch (e) {
      mapError(res, e);
    }
    return true;
  }

  // POST /api/chat/sessions
  if (method === 'POST' && pathname === '/api/chat/sessions') {
    try {
      const body = await readBody(req);
      const session = chatApi.createSession(body || {});
      sendJson(res, 200, session);
    } catch (e) {
      if (e.status) sendError(res, e.status, e.message);
      else mapError(res, e);
    }
    return true;
  }

  // /api/chat/sessions/:id[...]
  if (pathname.startsWith('/api/chat/sessions/')) {
    const rest = pathname.slice('/api/chat/sessions/'.length);
    const parts = rest.split('/').filter(Boolean);
    const id = decodeSeg(parts[0]);
    if (!id) {
      sendError(res, 400, 'invalid session id');
      return true;
    }
    const action = parts[1] || '';

    // GET session
    if (method === 'GET' && !action) {
      try {
        sendJson(res, 200, chatApi.getSession(id));
      } catch (e) {
        if (e.status) sendError(res, e.status, e.message);
        else mapError(res, e);
      }
      return true;
    }

    // PATCH session meta
    if ((method === 'PATCH' || method === 'PUT') && !action) {
      try {
        const body = await readBody(req);
        sendJson(res, 200, chatApi.patchSession(id, body || {}));
      } catch (e) {
        if (e.status) sendError(res, e.status, e.message);
        else mapError(res, e);
      }
      return true;
    }

    // DELETE session
    if (method === 'DELETE' && !action) {
      try {
        // abort any in-flight generation
        const ac = chatAbortMap.get(id);
        if (ac) {
          try {
            ac.abort();
          } catch {
            /* ignore */
          }
          chatAbortMap.delete(id);
        }
        sendJson(res, 200, chatApi.deleteSession(id));
      } catch (e) {
        if (e.status) sendError(res, e.status, e.message);
        else mapError(res, e);
      }
      return true;
    }

    // POST truncate  { messageId, mode: 'from'|'after' }
    if (method === 'POST' && action === 'truncate') {
      try {
        const body = await readBody(req);
        const messageId = body && body.messageId;
        if (!messageId) {
          sendError(res, 400, 'messageId required');
          return true;
        }
        let session = chatApi.getSession(id);
        const mode = body.mode === 'after' ? 'after' : 'from';
        if (mode === 'after') session = chatApi.truncateAfter(session, messageId);
        else session = chatApi.truncateFrom(session, messageId);
        sendJson(res, 200, session);
      } catch (e) {
        if (e.status) sendError(res, e.status, e.message);
        else mapError(res, e);
      }
      return true;
    }

    // PATCH message content  /sessions/:id/message/:mid
    if (method === 'PATCH' && action === 'message') {
      try {
        const mid = decodeSeg(parts[2] || '');
        if (!mid) {
          sendError(res, 400, 'message id required');
          return true;
        }
        const body = await readBody(req);
        let session = chatApi.getSession(id);
        const content = body && body.content != null ? String(body.content) : null;
        if (content == null) {
          sendError(res, 400, 'content required');
          return true;
        }
        session = chatApi.updateMessage(session, mid, { content, status: 'done', error: null });
        // drop everything after this message
        session = chatApi.truncateAfter(session, mid);
        sendJson(res, 200, session);
      } catch (e) {
        if (e.status) sendError(res, e.status, e.message);
        else mapError(res, e);
      }
      return true;
    }

    // POST stop
    if (method === 'POST' && action === 'stop') {
      const ac = chatAbortMap.get(id);
      if (ac) {
        try {
          ac.abort();
        } catch {
          /* ignore */
        }
        chatAbortMap.delete(id);
        sendJson(res, 200, { ok: true, stopped: true });
      } else {
        sendJson(res, 200, { ok: true, stopped: false });
      }
      return true;
    }

    // POST messages → SSE stream
    if (method === 'POST' && action === 'messages') {
      let body;
      try {
        body = await readBody(req);
      } catch (e) {
        sendError(res, e.status || 400, e.message || 'bad body');
        return true;
      }
      const content = body && body.content != null ? String(body.content).trim() : '';
      if (!content) {
        sendError(res, 400, 'content required');
        return true;
      }

      let session;
      try {
        session = chatApi.getSession(id);
      } catch (e) {
        if (e.status) sendError(res, e.status, e.message);
        else mapError(res, e);
        return true;
      }

      // persist model selection for this session (and last-used global)
      let modelDirty = false;
      if (body.provider != null && String(body.provider).trim()) {
        const p = String(body.provider).trim();
        if (p !== session.provider) modelDirty = true;
        session.provider = p;
      }
      if (body.model != null && String(body.model).trim()) {
        const m = String(body.model).trim();
        if (m !== session.model) modelDirty = true;
        session.model = m;
      }
      if (!session.provider || !session.model) {
        const d = chatApi.resolveDefaultModel(session.provider, session.model);
        if (d.provider !== session.provider || d.model !== session.model) modelDirty = true;
        session.provider = d.provider;
        session.model = d.model;
      }
      if (modelDirty || (session.provider && session.model)) {
        // always save model onto session before generation so reload keeps it
        chatApi.saveSession(session);
      }

      // slash tools: no upstream model required
      const slash = chatTools.parseSlash(content);
      if (slash) {
        const userMsg = chatApi.makeMessage('user', content, { status: 'done' });
        const toolResult = await chatTools.runTool(slash.name, slash.args || {});
        const assistantMsg = chatApi.makeMessage('assistant', toolResult.text || '', {
          status: toolResult.ok ? 'done' : 'error',
          error: toolResult.ok ? null : toolResult.error,
          finishedAt: chatApi.nowIso(),
          tools: [
            {
              id: chatApi.newId(),
              name: toolResult.name,
              input: toolResult.args || {},
              output: toolResult.data != null ? toolResult.data : null,
              approval: 'auto',
              status: toolResult.ok ? 'done' : 'error',
              ms: toolResult.ms,
              error: toolResult.error || null,
            },
          ],
        });
        session.messages = session.messages || [];
        session.messages.push(userMsg, assistantMsg);
        if ((session.messages.filter((m) => m.role === 'user').length === 1) &&
            (!session.title || session.title === '新对话')) {
          session.title = slash.name === 'unknown' ? content.slice(0, 16) : slash.name;
        }
        chatApi.saveSession(session);

        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        if (typeof res.flushHeaders === 'function') res.flushHeaders();
        writeSse(res, 'meta', {
          sessionId: session.id,
          userMessageId: userMsg.id,
          messageId: assistantMsg.id,
          provider: session.provider,
          model: session.model,
          tool: true,
        });
        writeSse(res, 'tool', {
          name: toolResult.name,
          ok: toolResult.ok,
          ms: toolResult.ms,
          args: toolResult.args,
          data: toolResult.data,
          error: toolResult.error || null,
          text: toolResult.text,
        });
        if (toolResult.text) writeSse(res, 'delta', { text: toolResult.text });
        writeSse(res, 'done', {
          messageId: assistantMsg.id,
          content: toolResult.text || '',
          reasoning: '',
          usage: null,
          title: session.title,
          status: toolResult.ok ? 'done' : 'error',
          tool: true,
        });
        res.end();
        return true;
      }

      if (!session.provider || !session.model) {
        sendError(res, 400, '未配置模型，请先在「模型」页添加并设置默认');
        return true;
      }

      // abort previous for same session
      const prev = chatAbortMap.get(id);
      if (prev) {
        try {
          prev.abort();
        } catch {
          /* ignore */
        }
      }
      const ac = new AbortController();
      chatAbortMap.set(id, ac);

      const userMsg = chatApi.makeMessage('user', content, { status: 'done' });
      session.messages = session.messages || [];
      session.messages.push(userMsg);

      const assistantMsg = chatApi.makeMessage('assistant', '', {
        status: 'streaming',
        finishedAt: null,
      });
      session.messages.push(assistantMsg);
      chatApi.saveSession(session);

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      if (typeof res.flushHeaders === 'function') res.flushHeaders();

      writeSse(res, 'meta', {
        sessionId: session.id,
        userMessageId: userMsg.id,
        messageId: assistantMsg.id,
        provider: session.provider,
        model: session.model,
      });

      const systemPrompt = session.systemPrompt || chatApi.DEFAULT_SYSTEM_PROMPT();
      // history without the empty streaming assistant placeholder
      const history = session.messages.filter((m) => m.id !== assistantMsg.id);

      let fullText = '';
      let fullReasoning = '';
      let usage = null;
      let aborted = false;

      const onAbort = () => {
        aborted = true;
      };
      ac.signal.addEventListener('abort', onAbort);
      req.on('close', () => {
        if (!ac.signal.aborted) {
          try {
            ac.abort();
          } catch {
            /* ignore */
          }
        }
      });

      const collectedTools = [];
      try {
        const openaiTools = chatTools.openAITools();
        const result = await chatClient.runChatWithTools({
          providerId: session.provider,
          model: session.model,
          messages: history,
          systemPrompt,
          signal: ac.signal,
          tools: openaiTools,
          maxSteps: 4,
          executeTool: async (name, args) => {
            if (!chatTools.isCallableTool(name)) {
              return {
                ok: false,
                name,
                args,
                error: '工具不可用或不允许: ' + name,
                text: '工具不可用或不允许: ' + name,
                data: null,
                ms: 0,
              };
            }
            return chatTools.runTool(name, args || {});
          },
          onEvent: (ev) => {
            if (aborted || res.writableEnded) return;
            if (ev.type === 'delta') {
              if (ev.text) {
                fullText += ev.text;
                writeSse(res, 'delta', { text: ev.text });
              }
              if (ev.reasoning) {
                fullReasoning += ev.reasoning;
                writeSse(res, 'delta', { reasoning: ev.reasoning });
              }
            } else if (ev.type === 'usage' && ev.usage) {
              usage = ev.usage;
              writeSse(res, 'usage', ev.usage);
            } else if (ev.type === 'tool_call') {
              writeSse(res, 'tool', {
                phase: 'call',
                id: ev.id,
                name: ev.name,
                args: ev.args,
                ok: true,
              });
            } else if (ev.type === 'tool_result') {
              collectedTools.push({
                id: ev.id,
                name: ev.name,
                input: ev.args,
                output: ev.data != null ? ev.data : null,
                approval: 'auto',
                status: ev.ok ? 'done' : 'error',
                ms: ev.ms,
                error: ev.error || null,
              });
              writeSse(res, 'tool', {
                phase: 'result',
                id: ev.id,
                name: ev.name,
                ok: ev.ok,
                ms: ev.ms,
                args: ev.args,
                data: ev.data,
                error: ev.error || null,
                text: ev.text,
              });
            }
          },
        });
        if (result) {
          // fullText/reasoning already accumulated via onEvent deltas; prefer final
          if (result.content != null && result.content !== '') fullText = result.content;
          if (result.reasoning) fullReasoning = result.reasoning;
          if (result.usage) usage = result.usage;
          if (result.tools && result.tools.length && !collectedTools.length) {
            for (const t of result.tools) collectedTools.push(t);
          }
        }

        // reload & persist (keep provider/model from this request)
        const keepProvider = session.provider;
        const keepModel = session.model;
        session = chatApi.getSession(id);
        if (keepProvider) session.provider = keepProvider;
        if (keepModel) session.model = keepModel;
        const a = (session.messages || []).find((m) => m.id === assistantMsg.id);
        if (a) {
          a.content = fullText;
          a.reasoning = fullReasoning;
          a.usage = usage;
          a.tools = collectedTools;
          a.status = aborted && !fullText ? 'partial' : 'done';
          a.finishedAt = chatApi.nowIso();
          if (aborted && fullText) a.status = 'partial';
        }
        // auto title on first exchange
        let newTitle = null;
        const userCount = (session.messages || []).filter((m) => m.role === 'user').length;
        if (userCount === 1 && (!session.title || session.title === '新对话')) {
          try {
            newTitle = await chatClient.generateTitle({
              providerId: session.provider,
              model: session.model,
              userText: content,
              assistantText: fullText,
              signal: undefined,
            });
            if (newTitle) session.title = newTitle;
          } catch {
            session.title = chatClient.fallbackTitle(content);
            newTitle = session.title;
          }
        }
        chatApi.saveSession(session);

        if (!res.writableEnded) {
          writeSse(res, 'done', {
            messageId: assistantMsg.id,
            content: fullText,
            reasoning: fullReasoning,
            usage,
            title: session.title,
            status: aborted ? 'partial' : 'done',
          });
          res.end();
        }
      } catch (e) {
        const isAbort = e && (e.name === 'AbortError' || /aborted|canceled/i.test(String(e.message || '')));
        try {
          const keepProvider = session.provider;
          const keepModel = session.model;
          session = chatApi.getSession(id);
          if (keepProvider) session.provider = keepProvider;
          if (keepModel) session.model = keepModel;
          const a = (session.messages || []).find((m) => m.id === assistantMsg.id);
          if (a) {
            a.content = fullText;
            a.reasoning = fullReasoning;
            a.usage = usage;
            a.status = isAbort ? 'partial' : 'error';
            a.error = isAbort ? (fullText ? null : 'stopped') : String(e.message || e).slice(0, 300);
            a.finishedAt = chatApi.nowIso();
          }
          chatApi.saveSession(session);
        } catch {
          /* ignore save error */
        }
        if (!res.writableEnded) {
          if (isAbort) {
            writeSse(res, 'done', {
              messageId: assistantMsg.id,
              content: fullText,
              reasoning: fullReasoning,
              usage,
              status: 'partial',
              stopped: true,
            });
          } else {
            writeSse(res, 'error', { message: String(e.message || e).slice(0, 300) });
          }
          res.end();
        }
      } finally {
        ac.signal.removeEventListener('abort', onAbort);
        if (chatAbortMap.get(id) === ac) chatAbortMap.delete(id);
      }
      return true;
    }

    sendError(res, 404, 'Not Found');
    return true;
  }

  sendError(res, 404, 'Not Found');
  return true;
}

async function handleApi(req, res, pathname) {
  const method = req.method;
  if (await handleAgentsApi(req, res, pathname, method)) return true;
  if (await handleModelsApi(req, res, pathname, method)) return true;
  if (await handleOpenvlApi(req, res, pathname, method)) return true;
  if (await handleConsoleApi(req, res, pathname, method)) return true;
  if (await handleChatApi(req, res, pathname, method)) return true;
  if (pathname.startsWith('/api/')) {
    sendError(res, 404, 'Not Found');
    return true;
  }
  return false;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://localhost');
    const pathname = url.pathname;

    if (await handleApi(req, res, pathname)) return;

    if (req.method === 'GET' || req.method === 'HEAD') {
      if (
        pathname === '/' ||
        pathname === '/models' ||
        pathname === '/agents' ||
        pathname === '/openvl' ||
        pathname === '/prompt' ||
        pathname === '/memory' ||
        pathname === '/knowledge' ||
        pathname === '/skills' ||
        pathname === '/plugins' ||
        pathname === '/workspaces'
      ) {
        serveStatic(res, '/index.html');
        return;
      }
      const ext = path.extname(pathname);
      if (STATIC_TYPES[ext]) {
        serveStatic(res, pathname);
        return;
      }
    }
    sendError(res, 404, 'Not Found');
  } catch (e) {
    console.error(e);
    if (!res.headersSent) sendError(res, 500, 'Internal error');
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error('Port ' + PORT + ' is already in use');
    process.exit(1);
  }
  throw err;
});

// Leave a trail when the process dies unexpectedly (no idle auto-exit in this app).
function logFatal(kind, err) {
  const msg =
    '[' +
    new Date().toISOString() +
    '] ' +
    kind +
    ': ' +
    (err && err.stack ? err.stack : String(err && err.message ? err.message : err));
  console.error(msg);
  try {
    const logDir = path.join(__dirname, 'logs');
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(path.join(logDir, 'server-fatal.log'), msg + '\n', 'utf8');
  } catch {
    /* ignore */
  }
}
process.on('uncaughtException', (err) => {
  logFatal('uncaughtException', err);
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  logFatal('unhandledRejection', err);
  // do not exit: a single rejected promise shouldn't kill the console
});
process.on('SIGTERM', () => {
  console.log('[' + new Date().toISOString() + '] SIGTERM, shutting down');
  server.close(() => process.exit(0));
});
process.on('SIGINT', () => {
  console.log('[' + new Date().toISOString() + '] SIGINT, shutting down');
  server.close(() => process.exit(0));
});

server.listen(PORT, () => {
  console.log('Pi Manager');
  console.log('  http://localhost:' + PORT);
  console.log('  models:   ' + MODELS_FILE);
  console.log('  settings: ' + SETTINGS_FILE);
  console.log('  agents:   ' + AGENTS_DIR);
  console.log('  prompt:   ' + AGENTS_MD_FILE);
  console.log('  manager:  ' + MANAGER_CONFIG_FILE);
  console.log(
    '  openvl:   ' + (OPENVL_AVAILABLE ? OPENVL_PROFILES_FILE : '(未安装)')
  );
  console.log('  pid:      ' + process.pid);
});
