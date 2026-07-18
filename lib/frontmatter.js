/**
 * Sanitize a frontmatter value for safe serialization.
 * @param {*} v
 * @returns {string}
 */
function sanitizeFmValue(v) {
  if (v == null || v === '') return '';
  const s = String(v);
  const flat = s.replace(/\n/g, ' ');
  if (/[:#]/.test(flat) || flat !== flat.trim() || flat.startsWith('"')) {
    const escaped = flat.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return '"' + escaped + '"';
  }
  return flat;
}

/**
 * Parse simple YAML-like frontmatter from agent file content.
 * @param {string} text
 * @returns {{ data: Object, body: string }}
 */
function parseFrontmatter(text) {
  const normalized = String(text || '').replace(/\r\n/g, '\n');

  if (!normalized.startsWith('---\n')) {
    return { data: {}, body: normalized };
  }

  const lines = normalized.split('\n');
  let endIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      endIndex = i;
      break;
    }
  }

  if (endIndex === -1) {
    return { data: {}, body: normalized };
  }

  const data = {};
  for (let i = 1; i < endIndex; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) continue;
    const key = line.slice(0, colonIndex).trim();
    let value = line.slice(colonIndex + 1).trim();
    if (!key) continue;
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
    data[key] = value;
  }

  const body = lines.slice(endIndex + 1).join('\n');
  return { data, body };
}

/**
 * Serialize frontmatter + body.
 * @param {Object} data
 * @param {string} body
 * @returns {string}
 */
function serializeFrontmatter(data, body) {
  if (!data || typeof data !== 'object') data = {};
  if (typeof body !== 'string') body = '';

  const orderedKeys = ['name', 'description', 'category', 'tools', 'model', 'thinking'];
  const usedKeys = new Set();
  const lines = [];

  for (const key of orderedKeys) {
    if (key in data && data[key] != null && data[key] !== '') {
      lines.push(key + ': ' + sanitizeFmValue(data[key]));
      usedKeys.add(key);
    }
  }

  for (const key of Object.keys(data)) {
    if (!usedKeys.has(key) && data[key] != null && data[key] !== '') {
      lines.push(key + ': ' + sanitizeFmValue(data[key]));
    }
  }

  const frontmatter =
    lines.length > 0
      ? '---\n' + lines.join('\n') + '\n---\n'
      : '---\n---\n';
  return frontmatter + body;
}

module.exports = { parseFrontmatter, serializeFrontmatter, sanitizeFmValue };
