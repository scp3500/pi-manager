const fs = require('fs');
const path = require('path');
const { AGENTS_DIR } = require('./config');
const { validateAgentName } = require('./agent-security');
const { parseFrontmatter, serializeFrontmatter } = require('./frontmatter');
const { resolveCategory, CATEGORY_IDS } = require('./categories');
const { TLM_LEVELS } = require('./models');

const TASK_TYPES = ['planning', 'analysis', 'explore', 'verification', 'development'];
const SP_MODES = ['append', 'replace'];

function isValidThinking(level) {
  return typeof level === 'string' && level !== '' && TLM_LEVELS.includes(level);
}

function parseModelSpec(spec) {
  const s = spec == null ? '' : String(spec);
  if (!s) return { model: '', thinking: '' };
  const idx = s.lastIndexOf(':');
  if (idx === -1) return { model: s, thinking: '' };
  const tail = s.slice(idx + 1);
  return TLM_LEVELS.includes(tail)
    ? { model: s.slice(0, idx), thinking: tail }
    : { model: s, thinking: '' };
}

function composeModelSpec(model, thinking) {
  const m = model == null ? '' : String(model);
  const t = thinking == null ? '' : String(thinking);
  return !t || !TLM_LEVELS.includes(t) ? m : m + ':' + t;
}

function normalizeModelThinking(data) {
  const d = data && typeof data === 'object' ? data : {};
  const parsed = parseModelSpec(d.model || '');
  let thinking = parsed.thinking;
  if (!thinking && isValidThinking(String(d.thinking || ''))) thinking = String(d.thinking);
  if (!thinking && isValidThinking(String(d.thinkingLevel || ''))) thinking = String(d.thinkingLevel);
  return { model: parsed.model, thinking };
}

function isInside(baseDir, candidate) {
  const base = path.resolve(baseDir);
  const target = path.resolve(candidate);
  const prefix = base.endsWith(path.sep) ? base : base + path.sep;
  return target.startsWith(prefix);
}

function collectAgentFiles(dir = AGENTS_DIR) {
  const root = path.resolve(dir);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return [];

  const files = [];
  const walk = (current) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const target = path.join(current, entry.name);
      if (!isInside(root, target)) continue;
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        walk(target);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        files.push(target);
      }
    }
  };
  walk(root);
  return files;
}

function readAgentEntry(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const { data, body } = parseFrontmatter(content);
  const fallbackName = path.basename(filePath, '.md');
  const name = data.name || fallbackName;
  if (!validateAgentName(name)) throw new Error('invalid agent name in file: ' + filePath);
  const explicit = data.category || '';
  const { model, thinking } = normalizeModelThinking(data);
  return {
    id: path.relative(AGENTS_DIR, filePath).replace(/\\/g, '/').replace(/\.md$/, ''),
    filename: path.basename(filePath),
    relativePath: path.relative(AGENTS_DIR, filePath).replace(/\\/g, '/'),
    directory: path.relative(AGENTS_DIR, path.dirname(filePath)).replace(/\\/g, '/') || '.',
    filePath,
    name,
    description: data.description || '',
    tools: data.tools || '',
    model,
    thinking,
    taskType: data.taskType || '',
    systemPromptMode: data.systemPromptMode || '',
    inheritProjectContext: data.inheritProjectContext || '',
    inheritSkills: data.inheritSkills || '',
    fallbackModels: data.fallbackModels || '',
    category: resolveCategory(name, explicit),
    categorySource: explicit ? 'explicit' : 'inferred',
    prompt: body,
  };
}

function listAgents() {
  const result = [];
  for (const filePath of collectAgentFiles()) {
    try {
      const entry = readAgentEntry(filePath);
      delete entry.filePath;
      delete entry.prompt;
      result.push(entry);
    } catch (e) {
      console.warn('Failed to read agent file:', filePath, e.message);
    }
  }
  return result.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

function findAgentEntry(name) {
  if (!validateAgentName(name)) throw new Error('invalid agent name');
  const matches = [];
  for (const filePath of collectAgentFiles()) {
    try {
      const entry = readAgentEntry(filePath);
      if (entry.name === name) matches.push(entry);
    } catch {
      /* ignored here; listAgents reports malformed files */
    }
  }
  if (matches.length === 0) throw new Error('not found');
  if (matches.length > 1) throw new Error('duplicate agent name: ' + name);
  return matches[0];
}

function categoryDir(name, data) {
  const category = resolveCategory(name, data && data.category);
  const folder = CATEGORY_IDS.has(category) ? category : 'other';
  const dir = path.join(AGENTS_DIR, folder);
  if (!isInside(AGENTS_DIR, dir)) throw new Error('invalid path');
  return dir;
}

function agentPathFor(name, data) {
  const dir = categoryDir(name, data);
  const filePath = path.join(dir, name + '.md');
  if (!isInside(AGENTS_DIR, filePath)) throw new Error('invalid path');
  return filePath;
}

function buildAgentContent(name, data, body) {
  const fmData = { name, ...(data && typeof data === 'object' ? data : {}) };
  if (fmData.category === '' || fmData.category == null) delete fmData.category;

  const modelRaw = fmData.model != null ? String(fmData.model) : '';
  const thinkingInput = fmData.thinking != null ? String(fmData.thinking) : '';
  const thinkingLevelInput = fmData.thinkingLevel != null ? String(fmData.thinkingLevel) : '';
  if (thinkingInput && !isValidThinking(thinkingInput)) {
    throw new Error('thinking must be one of: ' + TLM_LEVELS.join('|'));
  }
  if (thinkingLevelInput && !isValidThinking(thinkingLevelInput)) {
    throw new Error('thinkingLevel must be one of: ' + TLM_LEVELS.join('|'));
  }

  const parsed = parseModelSpec(modelRaw);
  const thinking = parsed.thinking || thinkingInput || thinkingLevelInput || '';
  if (thinking && !parsed.model) throw new Error('model must be set when thinking is set');
  if (parsed.model) fmData.model = composeModelSpec(parsed.model, thinking);
  else if (fmData.model === '' || fmData.model == null) delete fmData.model;
  delete fmData.thinking;
  delete fmData.thinkingLevel;

  // taskType / systemPromptMode: non-empty must be one of the allowed values
  const taskType = fmData.taskType != null ? String(fmData.taskType) : '';
  if (taskType && !TASK_TYPES.includes(taskType)) {
    throw new Error('taskType must be one of: ' + TASK_TYPES.join('|') + ', got: ' + taskType);
  }
  if (!taskType) delete fmData.taskType;

  const spMode = fmData.systemPromptMode != null ? String(fmData.systemPromptMode) : '';
  if (spMode && !SP_MODES.includes(spMode)) {
    throw new Error('systemPromptMode must be one of: ' + SP_MODES.join('|') + ', got: ' + spMode);
  }
  if (!spMode) delete fmData.systemPromptMode;

  // inheritProjectContext / inheritSkills: only empty / true / false
  for (const key of ['inheritProjectContext', 'inheritSkills']) {
    const v = fmData[key] != null ? String(fmData[key]) : '';
    if (v && v !== 'true' && v !== 'false') {
      throw new Error(key + ' must be empty, true or false, got: ' + v);
    }
    if (!v) delete fmData[key];
  }

  // fallbackModels: comma-separated model specs; drop empty items, validate each shape
  const fbRaw = fmData.fallbackModels != null ? String(fmData.fallbackModels) : '';
  const fbItems = [];
  for (const item of fbRaw.split(',')) {
    const trimmed = item.trim();
    if (!trimmed) continue;
    if (!parseModelSpec(trimmed).model) {
      throw new Error('fallbackModels contains invalid model spec: "' + trimmed + '"');
    }
    fbItems.push(trimmed);
  }
  if (fbItems.length > 0) fmData.fallbackModels = fbItems.join(',');
  else delete fmData.fallbackModels;

  return serializeFrontmatter(fmData, body);
}

function atomicWrite(filePath, content) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = filePath + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, filePath);
}

function writeAgent(name, data, body) {
  if (!validateAgentName(name)) throw new Error('invalid agent name');
  let existing = null;
  try {
    existing = findAgentEntry(name);
  } catch (e) {
    if (e.message !== 'not found') throw e;
  }

  const target = agentPathFor(name, data);
  if (existing && existing.filePath !== target && fs.existsSync(target)) {
    throw new Error('target name already exists');
  }
  if (!existing && fs.existsSync(target)) throw new Error('target name already exists');

  atomicWrite(target, buildAgentContent(name, data, body));
  if (existing && existing.filePath !== target) fs.unlinkSync(existing.filePath);
}

function renameAgent(oldName, newName, data, body) {
  if (!validateAgentName(oldName) || !validateAgentName(newName)) {
    throw new Error('invalid agent name');
  }
  if (oldName === newName) return writeAgent(newName, data, body);
  const oldEntry = findAgentEntry(oldName);
  try {
    findAgentEntry(newName);
    throw new Error('target name already exists');
  } catch (e) {
    if (e.message !== 'not found') throw e;
  }

  const target = agentPathFor(newName, data);
  if (fs.existsSync(target)) throw new Error('target name already exists');
  atomicWrite(target, buildAgentContent(newName, data, body));
  try {
    fs.unlinkSync(oldEntry.filePath);
  } catch (e) {
    try {
      fs.unlinkSync(target);
    } catch {
      /* ignore rollback failure */
    }
    throw new Error('failed to delete old agent: ' + e.message);
  }
}

function readAgent(name) {
  const entry = findAgentEntry(name);
  const { filePath, ...publicEntry } = entry;
  return publicEntry;
}

function deleteAgent(name) {
  const entry = findAgentEntry(name);
  fs.unlinkSync(entry.filePath);
}

function agentExists(name) {
  if (!validateAgentName(name)) return false;
  try {
    findAgentEntry(name);
    return true;
  } catch {
    return false;
  }
}

function agentFilePath(name) {
  return findAgentEntry(name).filePath;
}

module.exports = {
  listAgents,
  readAgent,
  writeAgent,
  renameAgent,
  deleteAgent,
  agentExists,
  agentPathFor,
  agentFilePath,
  collectAgentFiles,
  parseModelSpec,
  composeModelSpec,
  TASK_TYPES,
  SP_MODES,
};
