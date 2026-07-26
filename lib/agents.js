const fs = require('fs');
const path = require('path');
const { AGENTS_DIR } = require('./config');
const { validateAgentName, safeAgentPath } = require('./agent-security');
const { parseFrontmatter, serializeFrontmatter } = require('./frontmatter');
const { resolveCategory } = require('./categories');
const { TLM_LEVELS } = require('./models');

/**
 * @param {string} level
 * @returns {boolean}
 */
function isValidThinking(level) {
  return typeof level === 'string' && level !== '' && TLM_LEVELS.includes(level);
}

/**
 * Split a model spec into pure model + thinking level.
 * Only splits on the **last** colon when the tail is a known TLM level.
 * @param {string|null|undefined} spec
 * @returns {{ model: string, thinking: string }}
 */
function parseModelSpec(spec) {
  const s = spec == null ? '' : String(spec);
  if (!s) return { model: '', thinking: '' };
  const idx = s.lastIndexOf(':');
  if (idx === -1) return { model: s, thinking: '' };
  const tail = s.slice(idx + 1);
  if (TLM_LEVELS.includes(tail)) {
    return { model: s.slice(0, idx), thinking: tail };
  }
  return { model: s, thinking: '' };
}

/**
 * Compose pure model + thinking into a disk model string.
 * Empty/invalid thinking returns pure model; valid thinking returns `model:thinking`.
 * @param {string|null|undefined} model
 * @param {string|null|undefined} thinking
 * @returns {string}
 */
function composeModelSpec(model, thinking) {
  const m = model == null ? '' : String(model);
  const t = thinking == null ? '' : String(thinking);
  if (!t || !TLM_LEVELS.includes(t)) return m;
  return m + ':' + t;
}

/**
 * Normalize model/thinking from frontmatter data for API responses.
 * Priority: valid model suffix > valid standalone thinking > valid thinkingLevel > empty.
 * Illegal standalone fields are ignored.
 * @param {Object} data
 * @returns {{ model: string, thinking: string }}
 */
function normalizeModelThinking(data) {
  const d = data && typeof data === 'object' ? data : {};
  const parsed = parseModelSpec(d.model || '');
  let thinking = parsed.thinking;
  if (!thinking) {
    const t = d.thinking != null ? String(d.thinking) : '';
    if (isValidThinking(t)) thinking = t;
  }
  if (!thinking) {
    const t = d.thinkingLevel != null ? String(d.thinkingLevel) : '';
    if (isValidThinking(t)) thinking = t;
  }
  return { model: parsed.model, thinking };
}

/**
 * @returns {Array<{filename: string, name: string, description: string, tools: string, model: string, thinking: string, category: string, categorySource: string}>}
 */
function listAgents() {
  if (!fs.existsSync(AGENTS_DIR)) {
    return [];
  }
  const files = fs.readdirSync(AGENTS_DIR);
  const mdFiles = files.filter((f) => f.endsWith('.md')).sort();
  const result = [];

  for (const filename of mdFiles) {
    try {
      const filePath = path.join(AGENTS_DIR, filename);
      const content = fs.readFileSync(filePath, 'utf8');
      const { data } = parseFrontmatter(content);
      const name = filename.replace(/\.md$/, '');
      const explicit = data.category || '';
      const category = resolveCategory(name, explicit);
      const { model, thinking } = normalizeModelThinking(data);
      result.push({
        filename,
        name,
        description: data.description || '',
        tools: data.tools || '',
        model,
        thinking,
        category,
        categorySource: explicit ? 'explicit' : 'inferred',
      });
    } catch (e) {
      console.warn('Failed to read agent file:', filename, e.message);
    }
  }
  return result;
}

/**
 * @param {string} name
 * @returns {{filename: string, name: string, description: string, tools: string, model: string, thinking: string, category: string, categorySource: string, prompt: string}}
 */
function readAgent(name) {
  if (!validateAgentName(name)) {
    throw new Error('invalid agent name');
  }
  const filePath = safeAgentPath(AGENTS_DIR, name);
  if (!fs.existsSync(filePath)) {
    throw new Error('not found');
  }
  const content = fs.readFileSync(filePath, 'utf8');
  const { data, body } = parseFrontmatter(content);
  const agentName = path.basename(filePath, '.md');
  const explicit = data.category || '';
  const { model, thinking } = normalizeModelThinking(data);
  return {
    filename: path.basename(filePath),
    name: agentName,
    description: data.description || '',
    tools: data.tools || '',
    model,
    thinking,
    category: resolveCategory(agentName, explicit),
    categorySource: explicit ? 'explicit' : 'inferred',
    prompt: body,
  };
}

/**
 * Create or overwrite an agent file.
 * Disk source of truth for thinking is the model suffix (`model:level`).
 * Standalone `thinking` / `thinkingLevel` fields are never written.
 * @param {string} name
 * @param {{description?: string, tools?: string, model?: string, thinking?: string, thinkingLevel?: string, category?: string}} data
 * @param {string} body
 */
function writeAgent(name, data, body) {
  if (!validateAgentName(name)) {
    throw new Error('invalid agent name');
  }
  if (!fs.existsSync(AGENTS_DIR)) {
    fs.mkdirSync(AGENTS_DIR, { recursive: true });
  }
  const filePath = safeAgentPath(AGENTS_DIR, name);
  const fmData = { name, ...(data && typeof data === 'object' ? data : {}) };
  // normalize empty category away
  if (fmData.category === '' || fmData.category == null) {
    delete fmData.category;
  }

  const modelRaw = fmData.model != null ? String(fmData.model) : '';
  const thinkingInput = fmData.thinking != null ? String(fmData.thinking) : '';
  const thinkingLevelInput =
    fmData.thinkingLevel != null ? String(fmData.thinkingLevel) : '';

  // Non-empty independent fields must be legal (server mapError matches "must be")
  if (thinkingInput && !isValidThinking(thinkingInput)) {
    throw new Error(
      'thinking must be one of: ' + TLM_LEVELS.join('|')
    );
  }
  if (thinkingLevelInput && !isValidThinking(thinkingLevelInput)) {
    throw new Error(
      'thinkingLevel must be one of: ' + TLM_LEVELS.join('|')
    );
  }

  // Suffix on model wins over independent thinking fields
  const parsed = parseModelSpec(modelRaw);
  let thinking = parsed.thinking;
  if (!thinking) {
    thinking = thinkingInput || thinkingLevelInput || '';
  }

  if (thinking && !parsed.model) {
    throw new Error('model must be set when thinking is set');
  }

  if (parsed.model) {
    fmData.model = composeModelSpec(parsed.model, thinking);
  } else if (fmData.model === '' || fmData.model == null) {
    delete fmData.model;
  }

  // Unconditionally strip independent thinking fields from disk frontmatter
  delete fmData.thinking;
  delete fmData.thinkingLevel;

  const content = serializeFrontmatter(fmData, body);
  fs.writeFileSync(filePath, content, 'utf8');
}

/**
 * Rename then rewrite: write new → delete old (if different).
 * Prefer fs.rename when content-identical rename; here content usually changes.
 * @param {string} oldName
 * @param {string} newName
 * @param {{description?: string, tools?: string, model?: string, thinking?: string, thinkingLevel?: string, category?: string}} data
 * @param {string} body
 */
function renameAgent(oldName, newName, data, body) {
  if (!validateAgentName(oldName) || !validateAgentName(newName)) {
    throw new Error('invalid agent name');
  }
  if (oldName === newName) {
    writeAgent(newName, data, body);
    return;
  }

  const oldPath = safeAgentPath(AGENTS_DIR, oldName);
  const newPath = safeAgentPath(AGENTS_DIR, newName);

  if (!fs.existsSync(oldPath)) {
    throw new Error('not found');
  }
  if (fs.existsSync(newPath)) {
    throw new Error('target name already exists');
  }

  // Write new first so a crash leaves both (recoverable) rather than none.
  writeAgent(newName, data, body);
  try {
    fs.unlinkSync(oldPath);
  } catch (e) {
    // Best-effort rollback of the new file if old cannot be removed.
    try {
      fs.unlinkSync(newPath);
    } catch (_) {
      /* ignore */
    }
    throw new Error('failed to delete old agent: ' + e.message);
  }
}

/**
 * @param {string} name
 */
function deleteAgent(name) {
  if (!validateAgentName(name)) {
    throw new Error('invalid agent name');
  }
  const filePath = safeAgentPath(AGENTS_DIR, name);
  if (!fs.existsSync(filePath)) {
    throw new Error('not found');
  }
  fs.unlinkSync(filePath);
}

function agentExists(name) {
  if (!validateAgentName(name)) return false;
  try {
    return fs.existsSync(safeAgentPath(AGENTS_DIR, name));
  } catch {
    return false;
  }
}

module.exports = {
  listAgents,
  readAgent,
  writeAgent,
  renameAgent,
  deleteAgent,
  agentExists,
  parseModelSpec,
  composeModelSpec,
};
