const fs = require('fs');
const path = require('path');
const { HOME, PI_AGENT_DIR, MANAGER_CONFIG_FILE, BACKUP_KEEP } = require('./config');

const DANGEROUS_ROOTS = [
  path.parse(HOME || 'C:\\').root, // drive root like C:\
];

function expandPath(p) {
  if (p == null) return '';
  let s = String(p).trim();
  if (!s) return '';
  // env-style placeholders
  s = s.replace(/%USERPROFILE%/gi, HOME).replace(/%HOME%/gi, HOME);
  if (s.startsWith('~/') || s === '~') {
    s = path.join(HOME, s.slice(1).replace(/^[\\/]/, ''));
  }
  if (s.startsWith('~\\')) {
    s = path.join(HOME, s.slice(2));
  }
  return path.resolve(s);
}

function defaultConfig() {
  return {
    workspaces: [
      {
        id: 'pi-home',
        name: 'Pi 标准目录',
        root: PI_AGENT_DIR,
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
      // 内容页开关：关掉后记忆/知识库走「未启用」空状态（便于自测与多用户场景）
      memory: true,
      knowledge: true,
    },
    editor: {
      maxFileKB: 512,
      backup: true,
    },
  };
}

function normalizeMap(map) {
  const out = {};
  if (!map || typeof map !== 'object' || Array.isArray(map)) return out;
  for (const [k, v] of Object.entries(map)) {
    const key = String(k).trim();
    if (!key || !/^[a-zA-Z0-9_-]{1,32}$/.test(key)) continue;
    let rel = String(v == null ? '' : v).trim().replace(/\\/g, '/');
    if (!rel || rel.includes('..') || path.isAbsolute(rel) || rel.startsWith('/')) continue;
    rel = rel.replace(/^(\.\/)+/, '').replace(/\/+$/, '');
    if (!rel) continue;
    out[key] = rel;
  }
  return out;
}

function isDangerousRoot(absRoot) {
  if (!absRoot) return true;
  const n = path.resolve(absRoot);
  const lower = n.toLowerCase();
  // Windows system dirs
  if (/^[a-z]:\\windows(\\|$)/i.test(n)) return true;
  if (/^[a-z]:\\program files/i.test(n)) return true;
  if (/^[a-z]:\\$/i.test(n)) return true; // drive root
  if (lower === path.resolve('/').toLowerCase()) return true;
  return false;
}

function normalizeWorkspace(ws, { allowMissingRoot = false } = {}) {
  if (!ws || typeof ws !== 'object') throw new Error('workspace must be object');
  const id = String(ws.id || '').trim();
  if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(id)) throw new Error('invalid workspace id');
  const name = String(ws.name || id).trim() || id;
  const rootRaw = ws.root == null ? '' : String(ws.root).trim();
  if (!rootRaw) throw new Error('workspace root is required');
  const root = expandPath(rootRaw);
  if (isDangerousRoot(root)) throw new Error('dangerous root path refused: ' + root);
  if (!allowMissingRoot && !fs.existsSync(root)) {
    throw new Error('root does not exist: ' + root);
  }
  if (fs.existsSync(root) && !fs.statSync(root).isDirectory()) {
    throw new Error('root is not a directory: ' + root);
  }
  return {
    id,
    name,
    root,
    builtin: !!ws.builtin,
    map: normalizeMap(ws.map),
  };
}

function readManagerConfig() {
  if (!fs.existsSync(MANAGER_CONFIG_FILE)) {
    const cfg = defaultConfig();
    // 不自动写盘，等用户首次保存；返回内存默认
    return { ...cfg, _exists: false, configFile: MANAGER_CONFIG_FILE };
  }
  try {
    const raw = fs.readFileSync(MANAGER_CONFIG_FILE, 'utf8');
    if (!raw.trim()) {
      return { ...defaultConfig(), _exists: true, configFile: MANAGER_CONFIG_FILE };
    }
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') throw new Error('pi-manager.json root must be object');
    const base = defaultConfig();
    const workspaces = Array.isArray(data.workspaces)
      ? data.workspaces.map((w) => {
          try {
            return normalizeWorkspace(w, { allowMissingRoot: true });
          } catch {
            return null;
          }
        }).filter(Boolean)
      : base.workspaces;
    // ensure builtin pi-home present
    if (!workspaces.some((w) => w.id === 'pi-home')) {
      workspaces.unshift(base.workspaces[0]);
    }
    return {
      workspaces,
      features: normalizeFeatures({ ...base.features, ...(data.features || {}) }),
      editor: { ...base.editor, ...(data.editor || {}) },
      _exists: true,
      configFile: MANAGER_CONFIG_FILE,
    };
  } catch (e) {
    if (e.message && e.message.includes('must be')) throw e;
    throw new Error('pi-manager.json is not valid JSON: ' + e.message);
  }
}


function normalizeFeatures(features) {
  const base = defaultConfig().features;
  const f = features && typeof features === 'object' ? features : {};
  const out = { ...base };
  for (const k of Object.keys(base)) {
    if (Object.prototype.hasOwnProperty.call(f, k)) out[k] = !!f[k];
  }
  // allow known extra keys that default may gain later
  for (const k of ['memory', 'knowledge', 'prompt', 'skills', 'plugins', 'workspaces']) {
    if (Object.prototype.hasOwnProperty.call(f, k)) out[k] = !!f[k];
  }
  return out;
}

function updateFeatures(partial) {
  const cfg = readManagerConfig();
  const next = normalizeFeatures({ ...cfg.features, ...(partial || {}) });
  return writeManagerConfig({
    workspaces: cfg.workspaces,
    features: next,
    editor: cfg.editor,
  });
}

function writeManagerConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') throw new Error('invalid config');
  const workspaces = Array.isArray(cfg.workspaces)
    ? cfg.workspaces.map((w) => normalizeWorkspace(w, { allowMissingRoot: true }))
    : defaultConfig().workspaces;

  const out = {
    workspaces: workspaces.map((w) => ({
      id: w.id,
      name: w.name,
      root: w.root,
      builtin: !!w.builtin,
      map: w.map || {},
    })),
    features: normalizeFeatures(cfg.features),
    editor: cfg.editor || defaultConfig().editor,
  };

  const dir = path.dirname(MANAGER_CONFIG_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  if (fs.existsSync(MANAGER_CONFIG_FILE)) {
    const bak0 = MANAGER_CONFIG_FILE + '.bak';
    for (let i = BACKUP_KEEP - 1; i >= 1; i--) {
      const from = i === 1 ? bak0 : MANAGER_CONFIG_FILE + '.bak.' + (i - 1);
      const to = MANAGER_CONFIG_FILE + '.bak.' + i;
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
      fs.copyFileSync(MANAGER_CONFIG_FILE, bak0);
    } catch (e) {
      console.warn('manager config backup failed:', e.message);
    }
  }

  const json = JSON.stringify(out, null, 2) + '\n';
  const tmp = MANAGER_CONFIG_FILE + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, json, 'utf8');
  fs.renameSync(tmp, MANAGER_CONFIG_FILE);
  return { ...out, _exists: true, configFile: MANAGER_CONFIG_FILE };
}

function suggestCustomRoots() {
  // 仅提示，不自动写入
  const candidates = [];
  const ePi = expandPath('E:/pi_agent');
  if (fs.existsSync(ePi) && fs.statSync(ePi).isDirectory()) {
    candidates.push({
      id: 'pi-agent-lab',
      name: 'Pi 工作区 (E:/pi_agent)',
      root: ePi,
      map: {
        memory: 'memory',
        knowledge: 'knowledge',
        tools: 'tools',
        docs: 'docs',
        research: 'research',
        runtime: 'runtime',
      },
    });
  }
  return candidates;
}

module.exports = {
  normalizeFeatures,
  updateFeatures,
  expandPath,
  defaultConfig,
  normalizeWorkspace,
  normalizeMap,
  isDangerousRoot,
  readManagerConfig,
  writeManagerConfig,
  suggestCustomRoots,
  MANAGER_CONFIG_FILE,
};
