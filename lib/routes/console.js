const { OPENVL_AVAILABLE } = require('../config');
const { getDefaults } = require('../settings');
const {
  listProviders,
  listAllModels,
} = require('../models');
const { listAgents } = require('../agents');
const {
  readManagerConfig,
  writeManagerConfig,
  updateFeatures,
} = require('../manager-config');
const workspaces = require('../workspaces');
const promptApi = require('../prompt');
const skillsApi = require('../skills');
const pluginsApi = require('../plugins');
const filesApi = require('../files');
const sessionsApi = require('../sessions');
const opsApi = require('../ops');
const usageApi = require('../usage-service');
const runtimeApi = require('../runtime');
const installApi = require('../install');
const {
  sendJson,
  sendError,
  readBody,
  decodeSeg,
  mapError,
} = require('./helpers');

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
      const result = sessionsApi.deleteSessionFiles(paths);
      // drop stale header / runtime parse entries after disk changes
      sessionsApi.clearSessionHeaderCache();
      runtimeApi.clearRuntimeCache();
      sendJson(res, 200, result);
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
      const result = sessionsApi.deleteSessionsOlderThan(days);
      sessionsApi.clearSessionHeaderCache();
      runtimeApi.clearRuntimeCache();
      sendJson(res, 200, result);
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


function warmupUsageCache() {
  usageApi.collectUsage({ window: 'all', force: false })
    .then(() => console.log('  usage:    cache warmed'))
    .catch((e) =>
      console.log('  usage:    warm failed: ' + (e && e.message ? e.message : e))
  );
}

module.exports = { handleConsoleApi, warmupUsageCache };
