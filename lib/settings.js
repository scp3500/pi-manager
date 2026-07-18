const fs = require('fs');
const path = require('path');
const { SETTINGS_FILE } = require('./config');

const DEFAULT_KEYS = ['defaultProvider', 'defaultModel', 'defaultThinkingLevel'];

function readSettingsFile() {
  if (!fs.existsSync(SETTINGS_FILE)) {
    return {};
  }
  const raw = fs.readFileSync(SETTINGS_FILE, 'utf8');
  if (!raw.trim()) return {};
  try {
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('settings.json root must be an object');
    }
    return data;
  } catch (e) {
    if (e.message && e.message.startsWith('settings.json')) throw e;
    throw new Error('settings.json is not valid JSON: ' + e.message);
  }
}

/**
 * Atomic write of full settings object (preserves unrelated keys).
 */
function writeSettingsFile(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('invalid settings');
  }
  const dir = path.dirname(SETTINGS_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  // One backup
  if (fs.existsSync(SETTINGS_FILE)) {
    try {
      fs.copyFileSync(SETTINGS_FILE, SETTINGS_FILE + '.bak');
    } catch (e) {
      console.warn('settings backup failed:', e.message);
    }
  }
  const json = JSON.stringify(data, null, 2) + '\n';
  const tmp = SETTINGS_FILE + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, json, 'utf8');
  fs.renameSync(tmp, SETTINGS_FILE);
}

function getDefaults() {
  const s = readSettingsFile();
  return {
    defaultProvider: s.defaultProvider || '',
    defaultModel: s.defaultModel || '',
    defaultThinkingLevel: s.defaultThinkingLevel || '',
  };
}

/**
 * Patch only default* keys; leave everything else in settings.json alone.
 * @param {{defaultProvider?: string, defaultModel?: string, defaultThinkingLevel?: string}} patch
 */
function setDefaults(patch) {
  const s = readSettingsFile();
  for (const key of DEFAULT_KEYS) {
    if (patch[key] === undefined) continue;
    const v = patch[key];
    if (v == null || v === '') {
      delete s[key];
    } else {
      s[key] = String(v);
    }
  }
  writeSettingsFile(s);
  return getDefaults();
}

module.exports = {
  readSettingsFile,
  writeSettingsFile,
  getDefaults,
  setDefaults,
  DEFAULT_KEYS,
};
