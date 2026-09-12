/**
 * 定位本机的 @earendil-works/pi-coding-agent 安装目录。
 * prompt-structure 与 extension-tools 都要用，单独放一个模块避免循环依赖。
 */
const fs = require('fs');
const path = require('path');
const { HOME, PI_AGENT_DIR } = require('./config');

const PI_PKG_REL = path.join('npm', 'node_modules', '@earendil-works', 'pi-coding-agent');

function resolvePiRoot() {
  const candidates = [
    process.env.PI_PKG_DIR,
    process.env.APPDATA ? path.join(process.env.APPDATA, PI_PKG_REL) : null,
    path.join(HOME, 'AppData', 'Roaming', PI_PKG_REL),
    path.join(PI_AGENT_DIR, PI_PKG_REL),
  ];
  for (const dir of candidates) {
    if (dir && fs.existsSync(path.join(dir, 'dist', 'index.js'))) return dir;
  }
  return null;
}

function piVersion(root) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version || '';
  } catch {
    return '';
  }
}

module.exports = { resolvePiRoot, piVersion };
