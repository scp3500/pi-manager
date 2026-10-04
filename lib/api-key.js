const { exec } = require('child_process');

const API_KEY_CMD_TTL_MS = 5 * 60_000;
// 密钥命令的输出上限。默认 1MB 对有的密码管理器 json dump 不够，超了会被 exec 当失败。
const API_KEY_CMD_MAX_BUFFER = 4 * 1024 * 1024;
/** @type {Map<string, {value: string, expires: number} | {pending: Promise<string>}>} */
const apiKeyCmdCache = new Map();

function runApiKeyCommand(cmd) {
  return new Promise((resolve, reject) => {
    exec(
      cmd,
      { encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: API_KEY_CMD_MAX_BUFFER },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error('apiKey 命令执行失败: ' + (stderr || err.message || err)));
          return;
        }
        resolve(String(stdout || '').trim());
      }
    );
  });
}

/**
 * Resolve apiKey value from models.json:
 * - plain string
 * - $ENV_VAR
 * - !shell command
 * @param {string} raw
 * @returns {Promise<string>}
 */
async function resolveApiKey(raw) {
  const s = raw == null ? '' : String(raw).trim();
  if (!s) return '';

  if (s.startsWith('$') && s.length > 1 && !s.includes(' ')) {
    const name = s.slice(1);
    return process.env[name] || '';
  }

  if (s.startsWith('!')) {
    const cmd = s.slice(1).trim();
    if (!cmd) return '';
    const hit = apiKeyCmdCache.get(cmd);
    if (hit && hit.pending) return hit.pending;
    if (hit && hit.expires > Date.now()) return hit.value;
    const pending = runApiKeyCommand(cmd);
    apiKeyCmdCache.set(cmd, { pending });
    try {
      const value = await pending;
      apiKeyCmdCache.set(cmd, { value, expires: Date.now() + API_KEY_CMD_TTL_MS });
      return value;
    } catch (e) {
      apiKeyCmdCache.delete(cmd);
      throw e;
    }
  }

  return s;
}

function clearApiKeyCache() {
  apiKeyCmdCache.clear();
}

module.exports = {
  resolveApiKey,
  clearApiKeyCache,
};
