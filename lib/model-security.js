/**
 * Provider / model ids: 1–64 chars, alphanumerics / underscore / hyphen / dot / slash.
 * Slash allowed only for model ids (provider/model style is not used as filesystem path).
 * @param {*} id
 * @param {{allowSlash?: boolean}} [opts]
 * @returns {boolean}
 */
function validateId(id, opts = {}) {
  if (typeof id !== 'string') return false;
  if (id.length === 0 || id.length > 128) return false;
  if (opts.allowSlash) {
    return /^[a-zA-Z0-9_./-]+$/.test(id) && !id.includes('..') && !id.startsWith('/') && !id.endsWith('/');
  }
  return /^[a-zA-Z0-9_.-]+$/.test(id) && !id.includes('..');
}

function validateProviderId(id) {
  return validateId(id, { allowSlash: false });
}

function validateModelId(id) {
  // Upstream model ids may include slashes (e.g. openrouter/anthropic/claude)
  return validateId(id, { allowSlash: true });
}

/**
 * Mask API key for UI display.
 * 列表/预览：不返回任何 key 片段、命令全文或 env 名（仅 kind + 是否已配置）。
 * @param {string|undefined|null} key
 * @returns {{ configured: boolean, kind: string, masked: string }}
 */
function maskApiKey(key) {
  if (key == null || key === '') {
    return { configured: false, kind: 'empty', masked: '' };
  }
  const s = String(key);
  if (s.startsWith('!')) {
    return { configured: true, kind: 'command', masked: '已配置 (命令)' };
  }
  if (s.startsWith('$')) {
    return { configured: true, kind: 'env', masked: '已配置 (环境变量)' };
  }
  return { configured: true, kind: 'literal', masked: '已配置' };
}

module.exports = {
  validateId,
  validateProviderId,
  validateModelId,
  maskApiKey,
};
