const fs = require('fs');
const path = require('path');
const {
  readManagerConfig,
  writeManagerConfig,
  normalizeWorkspace,
  suggestCustomRoots,
  expandPath,
  isDangerousRoot,
} = require('./manager-config');

function listWorkspaces() {
  const cfg = readManagerConfig();
  return {
    workspaces: cfg.workspaces.map(publicWorkspace),
    suggestions: suggestCustomRoots().map((s) => ({
      ...s,
      exists: fs.existsSync(s.root),
    })),
    configFile: cfg.configFile,
    exists: !!cfg._exists,
    features: cfg.features,
    editor: cfg.editor,
  };
}

function publicWorkspace(w) {
  const rootExists = fs.existsSync(w.root) && fs.statSync(w.root).isDirectory();
  const mapped = {};
  if (rootExists && w.map) {
    for (const [k, rel] of Object.entries(w.map)) {
      const abs = path.join(w.root, rel);
      mapped[k] = {
        rel,
        path: abs,
        exists: fs.existsSync(abs),
      };
    }
  }
  return {
    id: w.id,
    name: w.name,
    root: w.root,
    builtin: !!w.builtin,
    map: w.map || {},
    rootExists,
    mapped,
  };
}

function getWorkspace(id) {
  const cfg = readManagerConfig();
  const w = cfg.workspaces.find((x) => x.id === id);
  if (!w) throw new Error('not found');
  return publicWorkspace(w);
}

function createWorkspace(body = {}) {
  const cfg = readManagerConfig();
  const id =
    (body.id && String(body.id).trim()) ||
    'ws_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  if (cfg.workspaces.some((w) => w.id === id)) throw new Error('target id already exists');
  const ws = normalizeWorkspace(
    {
      id,
      name: body.name || id,
      root: body.root,
      builtin: false,
      map: body.map || {},
    },
    { allowMissingRoot: false }
  );
  cfg.workspaces.push(ws);
  writeManagerConfig(cfg);
  return publicWorkspace(ws);
}

function updateWorkspace(id, body = {}) {
  const cfg = readManagerConfig();
  const idx = cfg.workspaces.findIndex((w) => w.id === id);
  if (idx < 0) throw new Error('not found');
  const cur = cfg.workspaces[idx];
  const next = normalizeWorkspace(
    {
      id: cur.id,
      name: body.name != null ? body.name : cur.name,
      root: body.root != null ? body.root : cur.root,
      builtin: cur.builtin,
      map: body.map != null ? body.map : cur.map,
    },
    { allowMissingRoot: true }
  );
  // builtin 不允许改 id / 取消 builtin；root 可改但警告由 UI 负责
  if (cur.builtin) {
    next.builtin = true;
    next.id = cur.id;
  }
  cfg.workspaces[idx] = next;
  writeManagerConfig(cfg);
  return publicWorkspace(next);
}

function deleteWorkspace(id) {
  const cfg = readManagerConfig();
  const w = cfg.workspaces.find((x) => x.id === id);
  if (!w) throw new Error('not found');
  if (w.builtin) throw new Error('cannot delete builtin workspace');
  cfg.workspaces = cfg.workspaces.filter((x) => x.id !== id);
  writeManagerConfig(cfg);
  return listWorkspaces();
}

function adoptSuggestion(id) {
  const sug = suggestCustomRoots().find((s) => s.id === id);
  if (!sug) throw new Error('not found');
  return createWorkspace(sug);
}

function resolveMappedPath(workspaceId, mapKey) {
  const w = getWorkspace(workspaceId);
  if (!w.rootExists) throw new Error('root does not exist: ' + w.root);
  const entry = w.mapped[mapKey];
  if (!entry) throw new Error('map key not found: ' + mapKey);
  return entry.path;
}

function contentReady(mapKey, features) {
  const enabled = features && features[mapKey] !== false;
  if (!enabled) {
    return { ready: false, reason: 'feature_off', enabled: false };
  }
  const list = listWorkspaces().workspaces || [];
  const hit = list.find((w) => w.rootExists && w.map && w.map[mapKey]);
  if (!hit) {
    const anyMap = list.find((w) => w.map && w.map[mapKey]);
    if (anyMap && !anyMap.rootExists) {
      return {
        ready: false,
        reason: 'root_missing',
        enabled: true,
        workspaceId: anyMap.id,
        rel: anyMap.map[mapKey],
      };
    }
    if (list.length === 0) return { ready: false, reason: 'no_workspace', enabled: true };
    return { ready: false, reason: 'no_map', enabled: true };
  }
  const mapped = hit.mapped && hit.mapped[mapKey];
  if (!mapped || !mapped.exists) {
    return {
      ready: false,
      reason: 'path_missing',
      enabled: true,
      workspaceId: hit.id,
      name: hit.name,
      rel: hit.map[mapKey],
      path: mapped && mapped.path,
    };
  }
  return {
    ready: true,
    reason: null,
    enabled: true,
    workspaceId: hit.id,
    name: hit.name,
    rel: hit.map[mapKey],
    path: mapped.path,
  };
}

function getStatus() {
  const cfg = readManagerConfig();
  const features = cfg.features || {};
  const list = listWorkspaces();
  const memory = contentReady('memory', features);
  const knowledge = contentReady('knowledge', features);
  let workflow = { ready: false, reason: 'no_memory' };
  if (memory.ready && memory.path) {
    const piDir = path.join(memory.path, 'pi');
    const hasPi =
      fs.existsSync(piDir) &&
      fs.statSync(piDir).isDirectory() &&
      fs.readdirSync(piDir).some((f) => f.endsWith('.md'));
    workflow = hasPi
      ? { ready: true, reason: null, path: piDir }
      : { ready: false, reason: 'no_pi_docs', path: piDir };
  } else if (memory.reason === 'feature_off') {
    workflow = { ready: false, reason: 'feature_off' };
  } else {
    workflow = { ready: false, reason: memory.reason || 'no_memory' };
  }
  return {
    features,
    configFile: cfg.configFile,
    workspaces: (list.workspaces || []).map((w) => ({
      id: w.id,
      name: w.name,
      rootExists: w.rootExists,
      builtin: w.builtin,
      hasMemoryMap: !!(w.map && w.map.memory),
      hasKnowledgeMap: !!(w.map && w.map.knowledge),
    })),
    suggestions: list.suggestions || [],
    memory,
    knowledge,
    workflow,
  };
}

/**
 * 一键创建 lab：建目录 + 默认 map + 可选种子文件
 * body: { root, name?, id?, seed?: boolean, createDirs?: boolean }
 */
function bootstrapWorkspace(body = {}) {
  const rootRaw = body.root != null ? String(body.root).trim() : '';
  if (!rootRaw) throw new Error('root is required');
  const root = expandPath(rootRaw);
  const createDirs = body.createDirs !== false;
  const seed = body.seed !== false;

  // Validate BEFORE any filesystem writes (dangerous roots / id / map).
  if (isDangerousRoot(root)) throw new Error('dangerous root path refused: ' + root);
  const idProbe =
    (body.id && String(body.id).trim()) ||
    'lab_' + Date.now().toString(36);
  const nameProbe = (body.name && String(body.name).trim()) || '我的工作区';
  const mapProbe =
    body.map && typeof body.map === 'object'
      ? body.map
      : { memory: 'memory', knowledge: 'knowledge' };
  normalizeWorkspace(
    {
      id: idProbe,
      name: nameProbe,
      root,
      builtin: false,
      map: mapProbe,
    },
    { allowMissingRoot: true }
  );

  if (!fs.existsSync(root)) {
    if (!createDirs) throw new Error('root does not exist: ' + root);
    fs.mkdirSync(root, { recursive: true });
  }
  if (!fs.statSync(root).isDirectory()) throw new Error('root is not a directory');

  const dirs = ['memory', 'knowledge', path.join('memory', 'pi')];
  const created = [];
  for (const d of dirs) {
    const abs = path.join(root, d);
    if (!fs.existsSync(abs)) {
      fs.mkdirSync(abs, { recursive: true });
      created.push(d.replace(/\\/g, '/'));
    }
  }

  const seeded = [];
  if (seed) {
    const memReadme = path.join(root, 'memory', 'README.md');
    if (!fs.existsSync(memReadme)) {
      fs.writeFileSync(
        memReadme,
        '# 记忆\n\n会话经验与笔记。平台规范可放在 `pi/`。\n',
        'utf8'
      );
      seeded.push('memory/README.md');
    }
    const kbReadme = path.join(root, 'knowledge', 'README.md');
    if (!fs.existsSync(kbReadme)) {
      fs.writeFileSync(
        kbReadme,
        '# 知识库\n\n长期文档与 wiki。可用 `rg` 或 LightRAG 检索。\n',
        'utf8'
      );
      seeded.push('knowledge/README.md');
    }
    const sub = path.join(root, 'memory', 'pi', 'AGENTS_SUBAGENT.md');
    if (!fs.existsSync(sub)) {
      const tpl = path.join(__dirname, '..', 'templates', 'workflow', 'AGENTS_SUBAGENT.md');
      let bodyTxt =
        '# 子代理工作流（种子）\n\n请按需扩展。完整规范可从已有 lab 复制。\n\n## 并行\n用 `tasks` 数组，不要并发写同一共享文件。\n';
      if (fs.existsSync(tpl)) {
        try {
          bodyTxt = fs.readFileSync(tpl, 'utf8');
        } catch {
          /* keep default */
        }
      }
      fs.writeFileSync(sub, bodyTxt, 'utf8');
      seeded.push('memory/pi/AGENTS_SUBAGENT.md');
    }
  }

  // reuse validated probe values (do not re-roll id after writes)
  const id = idProbe;
  const name = nameProbe;
  const map = mapProbe;

  const cfg = readManagerConfig();
  let ws;
  if (cfg.workspaces.some((w) => w.id === id)) {
    ws = updateWorkspace(id, { name, root, map });
  } else {
    ws = createWorkspace({ id, name, root, map });
  }
  return {
    workspace: ws,
    createdDirs: created,
    seeded,
    root,
  };
}

module.exports = {
  listWorkspaces,
  getWorkspace,
  createWorkspace,
  updateWorkspace,
  deleteWorkspace,
  adoptSuggestion,
  resolveMappedPath,
  expandPath,
  getStatus,
  bootstrapWorkspace,
  contentReady,
};
