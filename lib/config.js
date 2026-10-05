const path = require('path');
const fs = require('fs');

const HOME = process.env.USERPROFILE || process.env.HOME || '';
const PI_AGENT_DIR = process.env.PI_AGENT_DIR || path.join(HOME, '.pi', 'agent');

/** 本机历史共享配置根（start.bat / start-bg.ps1 一直显式设的那个）。 */
const LEGACY_CONFIG_DIR = 'E:\\pi_agent\\pi_config';
const DEFAULT_CONFIG_DIR = path.join(HOME, '.pi', 'config');

/**
 * 共享配置根：显式环境变量 > 本机历史目录（存在才认）> ~/.pi/config。
 * 没了这层回退，直接 `node server.js` / `npm start` 会静默落到空的 ~/.pi/config，
 * 子代理页显示 0 个 agent，新建的也落到错地方。
 * @param {string|undefined} env PI_CONFIG_DIR 原值
 * @param {(p: string) => boolean} exists 便于测试注入
 */
function resolvePiConfigDir(env, exists) {
  const isDir = exists || fs.existsSync;
  for (const c of [env, LEGACY_CONFIG_DIR, DEFAULT_CONFIG_DIR]) {
    if (c && isDir(c)) return c;
  }
  return env || DEFAULT_CONFIG_DIR;
}

const PI_CONFIG_DIR = resolvePiConfigDir(process.env.PI_CONFIG_DIR);

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
  resolvePiConfigDir,
  LEGACY_CONFIG_DIR,
  HOME,
  PI_AGENT_DIR,
  PI_CONFIG_DIR,
  AGENTS_DIR: process.env.AGENTS_DIR || path.join(PI_CONFIG_DIR, 'agents'),
  MODELS_FILE: process.env.MODELS_FILE || path.join(PI_AGENT_DIR, 'models.json'),
  SETTINGS_FILE: process.env.SETTINGS_FILE || path.join(PI_AGENT_DIR, 'settings.json'),
  AUTH_FILE: process.env.AUTH_FILE || path.join(PI_AGENT_DIR, 'auth.json'),
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
