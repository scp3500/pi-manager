const fs = require('fs');
const path = require('path');
const { AGENTS_DIR } = require('./config');
const { validateAgentName, safeAgentPath } = require('./agent-security');
const { parseFrontmatter, serializeFrontmatter } = require('./frontmatter');
const { resolveCategory } = require('./categories');

/**
 * @returns {Array<{filename: string, name: string, description: string, tools: string, model: string, category: string, categorySource: string}>}
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
      result.push({
        filename,
        name,
        description: data.description || '',
        tools: data.tools || '',
        model: data.model || '',
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
 * @returns {{filename: string, name: string, description: string, tools: string, model: string, category: string, categorySource: string, prompt: string}}
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
  return {
    filename: path.basename(filePath),
    name: agentName,
    description: data.description || '',
    tools: data.tools || '',
    model: data.model || '',
    thinking: data.thinking || data.thinkingLevel || '',
    category: resolveCategory(agentName, explicit),
    categorySource: explicit ? 'explicit' : 'inferred',
    prompt: body,
  };
}

/**
 * Create or overwrite an agent file.
 * @param {string} name
 * @param {{description?: string, tools?: string, model?: string, category?: string}} data
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
  const fmData = { name, ...data };
  // normalize empty category away
  if (fmData.category === '' || fmData.category == null) {
    delete fmData.category;
  }
  // thinking：仅写入 frontmatter 供记录；Pi 官方 subagent 扩展当前未必读取
  if (fmData.thinkingLevel && !fmData.thinking) {
    fmData.thinking = fmData.thinkingLevel;
  }
  delete fmData.thinkingLevel;
  if (fmData.thinking === '' || fmData.thinking == null) {
    delete fmData.thinking;
  }
  const content = serializeFrontmatter(fmData, body);
  fs.writeFileSync(filePath, content, 'utf8');
}

/**
 * Rename then rewrite: write new → delete old (if different).
 * Prefer fs.rename when content-identical rename; here content usually changes.
 * @param {string} oldName
 * @param {string} newName
 * @param {{description?: string, tools?: string, model?: string}} data
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
};
