const path = require('path');

/**
 * Agent names: 1–64 chars, alphanumerics / underscore / hyphen only.
 * @param {*} name
 * @returns {boolean}
 */
function validateAgentName(name) {
  if (typeof name !== 'string') return false;
  if (name.length === 0 || name.length > 64) return false;
  return /^[a-zA-Z0-9_-]+$/.test(name);
}

/**
 * Resolve agent file path under baseDir; reject path traversal.
 * @param {string} baseDir
 * @param {string} name - without .md
 * @returns {string}
 * @throws {Error} 'invalid path'
 */
function safeAgentPath(baseDir, name) {
  if (!validateAgentName(name)) {
    throw new Error('invalid path');
  }
  const resolvedBase = path.resolve(baseDir);
  const resolvedPath = path.resolve(path.join(baseDir, name + '.md'));
  const prefix = resolvedBase.endsWith(path.sep)
    ? resolvedBase
    : resolvedBase + path.sep;
  if (!resolvedPath.startsWith(prefix)) {
    throw new Error('invalid path');
  }
  return resolvedPath;
}

module.exports = { validateAgentName, safeAgentPath };
