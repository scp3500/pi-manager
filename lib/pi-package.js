/**
 * 定位本机的 @earendil-works/pi-coding-agent 安装目录。
 * prompt-structure 与 extension-tools 都要用，单独放一个模块避免循环依赖。
 *
 * 支持三种来源（按优先级）：
 *   1. env            —— 显式环境变量 PI_PKG_DIR
 *   2. managed-install —— pi.dev 托管安装：PI_MANAGED_INSTALL_ROOT/releases/<version>/…
 *   3. npm-global      —— 传统 npm 全局目录
 * 都不行时再退回 PATH 里的 pi 启动脚本（shim），从脚本文本反推包目录。
 * 全部探测失败返回 root=null，不抛异常。
 */
const fs = require('fs');
const path = require('path');
const { HOME, PI_AGENT_DIR } = require('./config');

const PI_PKG_REL = path.join('npm', 'node_modules', '@earendil-works', 'pi-coding-agent');
const PI_PKG_NAME = '@earendil-works/pi-coding-agent';
/** 托管安装里包所在的相对路径（releases/<version> 之下） */
const MANAGED_PKG_REL = path.join('node_modules', '@earendil-works', 'pi-coding-agent');
/** 从 shim 文本里认出的包目录片段（前后分隔符都用） */
const SHIM_PKG_RE = /node_modules[\\/]@earendil-works[\\/]pi-coding-agent/;
/** shim 里指代「脚本自己所在目录」的变量写法 */
const SHIM_DIR_VAR_RE = /^(%dp0%|%~dp0%|\$basedir|\$\{basedir\}|\.)$/i;

/** 默认用 node:fs / process.env；测试可注入替换 */
function makeIo(options) {
  const opts = options || {};
  return {
    env: opts.env || process.env,
    exists: opts.exists || fs.existsSync,
    readFile: opts.readFile || ((p) => fs.readFileSync(p, 'utf8')),
    readdir: opts.readdir || ((p) => fs.readdirSync(p)),
    stat: opts.stat || ((p) => fs.statSync(p)),
    whichPi: opts.whichPi || defaultWhichPi,
  };
}

function safeExists(io, p) {
  if (!p) return false;
  try {
    return !!io.exists(p);
  } catch {
    return false;
  }
}

function safeIsDir(io, p) {
  try {
    return !!io.stat(p).isDirectory();
  } catch {
    return false;
  }
}

function safeReadFile(io, p) {
  try {
    return io.readFile(p);
  } catch {
    return null;
  }
}

function safeReaddir(io, p) {
  try {
    return io.readdir(p) || [];
  } catch {
    return [];
  }
}

/**
 * 目录是不是 pi 包：必须含 dist/index.js；
 * 若能读到 package.json 且 name 明确是别的包，则视为不匹配。
 * 读文件/目录失败一律吞掉，只当没读到。
 */
function isValidPiDir(io, dir) {
  if (!dir || !safeExists(io, path.join(dir, 'dist', 'index.js'))) return false;
  const raw = safeReadFile(io, path.join(dir, 'package.json'));
  if (raw != null) {
    try {
      const pkg = JSON.parse(String(raw));
      if (pkg && typeof pkg.name === 'string' && pkg.name !== PI_PKG_NAME) return false;
    } catch {
      /* 非法 JSON / 空文件：仅凭 dist/index.js 认定 */
    }
  }
  return true;
}

/** 版本号解析：只取 x.y.z，其余（含 v 前缀）忽略 */
function parseSemver(name) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(name || ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** 版本目录名升序比较：semver 在前按数字段比，非 semver 排后面按名字典序 */
function compareReleaseNames(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (pa && pb) {
    for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
    return 0;
  }
  if (pa) return 1;
  if (pb) return -1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * 在托管安装根下挑出可用的包目录。
 * 优先 current-version 指的版本，其次 releases 下版本号最大的子目录。
 * @returns {{root:string, versionName:string}|null}
 */
function resolveManagedInstall(io, managedRoot) {
  if (!managedRoot) return null;
  const releasesDir = path.join(managedRoot, 'releases');

  let preferred = '';
  const currentRaw = safeReadFile(io, path.join(managedRoot, 'current-version'));
  if (currentRaw != null) preferred = String(currentRaw).trim();

  const names = safeReaddir(io, releasesDir)
    .filter((n) => typeof n === 'string' && n)
    .filter((n) => n !== preferred && safeIsDir(io, path.join(releasesDir, n)));
  names.sort((a, b) => compareReleaseNames(b, a)); // 降序：版本号大的先试

  // 释放目录本身也可能是包目录，或包铺在它的一层 node_modules 里，按顺序探测兜住
  const ordered = preferred ? [preferred, ...names] : names;
  for (const versionName of ordered) {
    const versionDir = path.join(releasesDir, versionName);
    const candidates = [
      path.join(versionDir, MANAGED_PKG_REL),
      versionDir,
      path.join(versionDir, 'node_modules'),
    ];
    for (const dir of candidates) {
      if (isValidPiDir(io, dir)) return { root: dir, versionName };
    }
  }
  return null;
}

/** 默认 PATH 查找：pi / pi.cmd / pi.ps1 / pi.exe，找不到返回 null */
function defaultWhichPi(env) {
  const e = env || process.env;
  const pathVar = e.PATH || e.Path || '';
  const names = process.platform === 'win32'
    ? ['pi.cmd', 'pi.exe', 'pi.ps1', 'pi']
    : ['pi'];
  for (const dir of String(pathVar).split(path.delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const full = path.join(dir, name);
      try {
        if (fs.existsSync(full) && fs.statSync(full).isFile()) return full;
      } catch {
        /* 单个 PATH 项不可读就跳过 */
      }
    }
  }
  return null;
}

/** 从 shim 文本里提取包目录；提取不到返回 null */
function shimPkgDirFromText(text, shimDir) {
  const m = SHIM_PKG_RE.exec(String(text || ''));
  if (!m) return null;
  const sep = /[\\/]/.exec(m[0])[0];
  // 取 node_modules 之前最后一段路径（被引号/空白分隔），兼容 %dp0% / $basedir / 绝对路径
  const chunks = String(text).slice(0, m.index).replace(/[\\/]+$/, '').split(/["'\s]+/).filter(Boolean);
  const segment = chunks[chunks.length - 1] || '';
  let base;
  if (!segment || SHIM_DIR_VAR_RE.test(segment)) {
    base = shimDir;
  } else {
    base = path.isAbsolute(segment) ? segment : path.resolve(shimDir, segment);
  }
  let dir = String(base).replace(/[\\/]+$/, '');
  for (const part of ['node_modules', '@earendil-works', 'pi-coding-agent']) dir += sep + part;
  return dir;
}

/**
 * shim 兜底：从 pi 启动脚本反推包目录。
 * 先按脚本文本里的 node_modules 片段找，提取不到就从脚本目录向上最多 5 层找同名包。
 */
function resolveShim(io) {
  let shim = null;
  try {
    shim = io.whichPi(io.env) || null;
  } catch {
    shim = null;
  }
  if (!shim) return null;
  const shimDir = path.dirname(shim);

  const fromText = shimPkgDirFromText(safeReadFile(io, shim), shimDir);
  if (fromText && isValidPiDir(io, fromText)) return { root: fromText, source: shim };

  let dir = shimDir;
  for (let depth = 0; depth <= 5; depth++) {
    const raw = safeReadFile(io, path.join(dir, 'package.json'));
    if (raw != null) {
      try {
        const pkg = JSON.parse(String(raw));
        if (pkg && pkg.name === PI_PKG_NAME && isValidPiDir(io, dir)) {
          return { root: dir, source: shim };
        }
      } catch {
        /* 非法 package.json：继续向上 */
      }
    }
    const parent = path.dirname(dir);
    if (!parent || parent === dir) break;
    dir = parent;
  }
  return null;
}

/** 依赖配置里的 HOME/PI_AGENT_DIR，但允许测试用注入的 env 覆盖，保证隔离 */
function npmGlobalCandidates(env) {
  const home = env.USERPROFILE || env.HOME || HOME;
  const agentDir = env.PI_AGENT_DIR || PI_AGENT_DIR;
  return [
    env.APPDATA ? path.join(env.APPDATA, PI_PKG_REL) : null,
    home ? path.join(home, 'AppData', 'Roaming', PI_PKG_REL) : null,
    agentDir ? path.join(agentDir, PI_PKG_REL) : null,
  ];
}

/**
 * 解析 pi 安装。
 * @param {object} [options] 可注入 { env, exists, readFile, readdir, stat, whichPi }，便于测试
 * @returns {{root:string|null, kind:'env'|'managed-install'|'npm-global'|'shim'|null, version:string, source:string|null}}
 */
function resolvePiInstall(options) {
  const io = makeIo(options);
  const env = io.env;
  const notFound = { root: null, kind: null, version: '', source: null };

  // a) 显式指定
  const envDir = env.PI_PKG_DIR;
  if (envDir && isValidPiDir(io, envDir)) {
    return { root: envDir, kind: 'env', version: piVersion(envDir), source: envDir };
  }

  // b) pi.dev 托管安装
  const managedRootRaw = env.PI_MANAGED_INSTALL_ROOT;
  if (managedRootRaw && String(managedRootRaw).trim()) {
    const managedRoot = path.resolve(String(managedRootRaw).trim());
    const hit = resolveManagedInstall(io, managedRoot);
    if (hit) {
      return {
        root: hit.root,
        kind: 'managed-install',
        version: piVersion(hit.root) || hit.versionName,
        source: hit.root,
      };
    }
  }

  // c) 传统 npm 全局目录（保留原顺序与判定）
  for (const dir of npmGlobalCandidates(env)) {
    if (isValidPiDir(io, dir)) {
      return { root: dir, kind: 'npm-global', version: piVersion(dir), source: dir };
    }
  }

  // d) PATH 里的 pi 启动脚本兜底
  const shim = resolveShim(io);
  if (shim) {
    return { root: shim.root, kind: 'shim', version: piVersion(shim.root), source: shim.source };
  }

  return notFound;
}

/** 兼容旧调用方：只要包目录 */
function resolvePiRoot() {
  return resolvePiInstall().root;
}

function piVersion(root) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version || '';
  } catch {
    return '';
  }
}

module.exports = { resolvePiInstall, resolvePiRoot, piVersion };
