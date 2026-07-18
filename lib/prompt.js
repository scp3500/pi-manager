const fs = require('fs');
const path = require('path');
const { AGENTS_MD_FILE, PI_AGENT_DIR, BACKUP_KEEP } = require('./config');

function getAgentsPath() {
  return process.env.AGENTS_MD_FILE || AGENTS_MD_FILE;
}

function getPromptsDir() {
  return process.env.PROMPTS_DIR || path.join(PI_AGENT_DIR, 'prompts');
}

function listBackups(filePath) {
  const list = [];
  const bak0 = filePath + '.bak';
  if (fs.existsSync(bak0)) {
    const st = fs.statSync(bak0);
    list.push({ name: path.basename(bak0), path: bak0, mtime: st.mtimeMs, size: st.size });
  }
  for (let i = 1; i < BACKUP_KEEP; i++) {
    const p = filePath + '.bak.' + i;
    if (fs.existsSync(p)) {
      const st = fs.statSync(p);
      list.push({ name: path.basename(p), path: p, mtime: st.mtimeMs, size: st.size });
    }
  }
  return list;
}

function backupFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const bak0 = filePath + '.bak';
  for (let i = BACKUP_KEEP - 1; i >= 1; i--) {
    const from = i === 1 ? bak0 : filePath + '.bak.' + (i - 1);
    const to = filePath + '.bak.' + i;
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
    fs.copyFileSync(filePath, bak0);
  } catch (e) {
    console.warn('prompt backup failed:', e.message);
  }
}

function readTextFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return {
      path: filePath,
      exists: false,
      content: '',
      mtime: null,
      size: 0,
      backups: listBackups(filePath),
    };
  }
  const st = fs.statSync(filePath);
  if (!st.isFile()) throw new Error('not a file');
  return {
    path: filePath,
    exists: true,
    content: fs.readFileSync(filePath, 'utf8'),
    mtime: st.mtimeMs,
    size: st.size,
    backups: listBackups(filePath),
  };
}

function writeTextFile(filePath, content) {
  if (typeof content !== 'string') throw new Error('content must be string');
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  backupFile(filePath);
  const tmp = filePath + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, filePath);
  return readTextFile(filePath);
}

/** Legacy: AGENTS.md only */
function readPrompt() {
  const data = readTextFile(getAgentsPath());
  return { ...data, id: 'agents', kind: 'agents' };
}

function writePrompt(content) {
  return { ...writeTextFile(getAgentsPath(), content), id: 'agents', kind: 'agents' };
}

function restoreBackup(name, filePath) {
  const target = filePath || getAgentsPath();
  const allowed = listBackups(target).map((b) => b.name);
  if (!allowed.includes(name)) throw new Error('backup not found');
  const bakPath = path.join(path.dirname(target), name);
  if (!fs.existsSync(bakPath)) throw new Error('backup not found');
  if (!bakPath.startsWith(target + '.bak')) throw new Error('invalid path');
  backupFile(target);
  fs.copyFileSync(bakPath, target);
  return readTextFile(target);
}

function safePromptName(name) {
  const n = String(name || '').trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}\.md$/.test(n)) {
    throw new Error('invalid prompt name (expect like foo.md)');
  }
  if (n.includes('..')) throw new Error('invalid prompt name');
  return n;
}

function listMemoryRuntimeDocs() {
  // memory/pi 下的运行规范：本质是提示词/规则，不是普通笔记
  const items = [];
  try {
    const { readManagerConfig } = require('./manager-config');
    const cfg = readManagerConfig();
    for (const w of cfg.workspaces || []) {
      if (!w.root || !w.map || !w.map.memory) continue;
      const memRoot = path.join(w.root, w.map.memory);
      const piDir = path.join(memRoot, 'pi');
      if (!fs.existsSync(piDir) || !fs.statSync(piDir).isDirectory()) continue;
      let names;
      try {
        names = fs.readdirSync(piDir).filter((f) => f.endsWith('.md') && !f.includes('.bak'));
      } catch {
        continue;
      }
      // 优先规范类文件，再带经验笔记
      const preferred = [
        'AGENTS_PLAN.md',
        'AGENTS_SUBAGENT.md',
        'LEARNINGS.md',
        'cli-communication.md',
        'rag-query.md',
      ];
      const ordered = [
        ...preferred.filter((n) => names.includes(n)),
        ...names.filter((n) => !preferred.includes(n)).sort(),
      ];
      for (const name of ordered) {
        const fp = path.join(piDir, name);
        try {
          const st = fs.statSync(fp);
          if (!st.isFile()) continue;
          items.push({
            id: 'memory:' + w.id + ':' + name,
            kind: 'memory',
            name,
            path: fp,
            exists: true,
            size: st.size,
            mtime: st.mtimeMs,
            workspaceId: w.id,
            group: '记忆规范 · ' + (w.name || w.id),
          });
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* ignore */
  }
  return items;
}

function listPromptFiles() {
  const agents = getAgentsPath();
  const promptsDir = getPromptsDir();
  const items = [
    {
      id: 'agents',
      kind: 'agents',
      name: 'AGENTS.md',
      path: agents,
      exists: fs.existsSync(agents),
      size: fs.existsSync(agents) ? fs.statSync(agents).size : 0,
      mtime: fs.existsSync(agents) ? fs.statSync(agents).mtimeMs : null,
      group: '系统提示词',
    },
  ];
  if (fs.existsSync(promptsDir) && fs.statSync(promptsDir).isDirectory()) {
    const names = fs
      .readdirSync(promptsDir)
      .filter((f) => f.endsWith('.md') && !f.includes('.bak'))
      .sort();
    for (const name of names) {
      const fp = path.join(promptsDir, name);
      try {
        const st = fs.statSync(fp);
        if (!st.isFile()) continue;
        items.push({
          id: 'prompt:' + name,
          kind: 'prompt',
          name,
          path: fp,
          exists: true,
          size: st.size,
          mtime: st.mtimeMs,
          group: 'Prompt 模板',
        });
      } catch {
        /* ignore */
      }
    }
  }
  items.push(...listMemoryRuntimeDocs());
  return {
    agentsPath: agents,
    promptsDir,
    promptsDirExists: fs.existsSync(promptsDir),
    items,
  };
}

function resolvePromptTarget(id) {
  if (!id || id === 'agents' || id === 'AGENTS.md') {
    return { id: 'agents', kind: 'agents', path: getAgentsPath(), name: 'AGENTS.md' };
  }
  const raw = String(id);
  // memory:<workspaceId>:<filename.md>
  if (raw.startsWith('memory:')) {
    const rest = raw.slice('memory:'.length);
    const idx = rest.indexOf(':');
    if (idx < 0) throw new Error('invalid memory prompt id');
    const wsId = rest.slice(0, idx);
    const name = safePromptName(rest.slice(idx + 1));
    const { readManagerConfig } = require('./manager-config');
    const cfg = readManagerConfig();
    const w = (cfg.workspaces || []).find((x) => x.id === wsId);
    if (!w || !w.root || !w.map || !w.map.memory) throw new Error('workspace memory map not found');
    const abs = path.resolve(path.join(w.root, w.map.memory, 'pi', name));
    const root = path.resolve(path.join(w.root, w.map.memory, 'pi'));
    if (!abs.startsWith(root + path.sep) && abs !== root) throw new Error('invalid path');
    return { id: raw, kind: 'memory', path: abs, name, workspaceId: wsId };
  }
  let name = raw;
  if (name.startsWith('prompt:')) name = name.slice('prompt:'.length);
  name = safePromptName(name.endsWith('.md') ? name : name + '.md');
  const fp = path.join(getPromptsDir(), name);
  const dir = path.resolve(getPromptsDir());
  const abs = path.resolve(fp);
  if (!abs.startsWith(dir + path.sep) && abs !== dir) throw new Error('invalid path');
  return { id: 'prompt:' + name, kind: 'prompt', path: abs, name };
}

function readPromptById(id) {
  const t = resolvePromptTarget(id);
  const data = readTextFile(t.path);
  return { ...data, id: t.id, kind: t.kind, name: t.name };
}

function writePromptById(id, content) {
  const t = resolvePromptTarget(id);
  // creating new prompt file is allowed in prompts dir
  if (t.kind === 'prompt') {
    const dir = getPromptsDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
  const data = writeTextFile(t.path, content);
  return { ...data, id: t.id, kind: t.kind, name: t.name };
}

function restorePromptById(id, bakName) {
  const t = resolvePromptTarget(id);
  const data = restoreBackup(bakName, t.path);
  return { ...data, id: t.id, kind: t.kind, name: t.name };
}

function createPromptFile(name, content = '') {
  const t = resolvePromptTarget(name.endsWith('.md') ? name : name + '.md');
  if (t.kind !== 'prompt') throw new Error('cannot create AGENTS via this endpoint');
  if (fs.existsSync(t.path)) throw new Error('target name already exists');
  const dir = getPromptsDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(t.path, content || '', 'utf8');
  return readPromptById(t.id);
}

function deletePromptFile(id) {
  const t = resolvePromptTarget(id);
  if (t.kind !== 'prompt') throw new Error('cannot delete AGENTS.md here');
  if (!fs.existsSync(t.path)) throw new Error('not found');
  backupFile(t.path);
  fs.unlinkSync(t.path);
  return { ok: true, id: t.id };
}

module.exports = {
  readPrompt,
  writePrompt,
  restoreBackup,
  getPromptPath: getAgentsPath,
  listPromptFiles,
  readPromptById,
  writePromptById,
  restorePromptById,
  createPromptFile,
  deletePromptFile,
  getPromptsDir,
};
