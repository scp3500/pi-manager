const path = require('path');
const fs = require('fs');

const HOME = process.env.USERPROFILE || process.env.HOME || '';
const PI_AGENT_DIR = process.env.PI_AGENT_DIR || path.join(HOME, '.pi', 'agent');
const PI_CONFIG_DIR = process.env.PI_CONFIG_DIR || path.resolve('E:/pi_agent/pi_config');

function openvlCandidates() {
  const appData = process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming');
  return [
    path.join(appData, 'npm', 'node_modules', '@scp3500', 'openvl'),
    path.join(HOME, '.pi', 'agent', 'skills', 'openvl'),
    path.join(HOME, '.agents', 'skills', 'openvl'),
  ];
}

function isOpenvlDir(dir) {
  if (!dir) return false;
  return (
    fs.existsSync(path.join(dir, 'package.json')) ||
    fs.existsSync(path.join(dir, 'config.env')) ||
    fs.existsSync(path.join(dir, 'profiles.json')) ||
    fs.existsSync(path.join(dir, 'scripts', 'vision.py'))
  );
}

function resolveOpenvlPkgDir() {
  if (process.env.OPENVL_PKG_DIR) {
    const forced = process.env.OPENVL_PKG_DIR;
    // 显式指定时：目录存在即可（允许尚未写 config.env 的新装）
    return fs.existsSync(forced) ? forced : null;
  }
  for (const c of openvlCandidates()) {
    if (isOpenvlDir(c)) return c;
  }
  return null; // 未安装
}

const OPENVL_PKG_DIR = resolveOpenvlPkgDir();
const OPENVL_AVAILABLE = !!OPENVL_PKG_DIR;
const OPENVL_PROFILES_FILE = process.env.OPENVL_PROFILES_FILE
  ? process.env.OPENVL_PROFILES_FILE
  : OPENVL_PKG_DIR
    ? path.join(OPENVL_PKG_DIR, 'profiles.json')
    : '';
const OPENVL_ENV_FILE = process.env.OPENVL_ENV_FILE
  ? process.env.OPENVL_ENV_FILE
  : OPENVL_PKG_DIR
    ? path.join(OPENVL_PKG_DIR, 'config.env')
    : '';
const OPENVL_ENV_MIRRORS = [
  path.join(HOME, '.pi', 'agent', 'skills', 'openvl', 'config.env'),
  path.join(HOME, '.agents', 'skills', 'openvl', 'config.env'),
].filter((p) => p && p !== OPENVL_ENV_FILE);

module.exports = {
  HOME,
  PI_AGENT_DIR,
  PI_CONFIG_DIR,
  AGENTS_DIR: process.env.AGENTS_DIR || path.join(PI_CONFIG_DIR, 'agents'),
  MODELS_FILE: process.env.MODELS_FILE || path.join(PI_AGENT_DIR, 'models.json'),
  SETTINGS_FILE: process.env.SETTINGS_FILE || path.join(PI_AGENT_DIR, 'settings.json'),
  AGENTS_MD_FILE: process.env.AGENTS_MD_FILE || path.join(PI_AGENT_DIR, 'AGENTS.md'),
  MANAGER_CONFIG_FILE:
    process.env.PI_MANAGER_CONFIG || path.join(PI_AGENT_DIR, 'pi-manager.json'),
  OPENVL_PKG_DIR,
  OPENVL_AVAILABLE,
  OPENVL_PROFILES_FILE,
  OPENVL_ENV_FILE,
  OPENVL_ENV_MIRRORS,
  PORT: Number(process.env.PORT) || 3001,
  BODY_LIMIT: 2 * 1024 * 1024,
  BACKUP_KEEP: 5,
};
