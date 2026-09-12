/**
 * 扩展工具定义探测（子进程）
 *
 * 目的：把「一次请求的固定开销」算全。pi 会把工具定义（JSON schema）随请求一起发，
 * 内置四个来自 pi 自己，扩展注册的（subagent、todo 等）只有跑一遍扩展才知道 schema 尺寸。
 *
 * 做法：Node 子进程 + ESM 解析钩子（把 @earendil-works/* 与 typebox 指到 pi 自带依赖）
 * → mock 掉 pi API → import 扩展入口并调用其工厂函数 → 收集 registerTool 的定义。
 *
 * 约束：
 *  - 只在独立子进程里执行第三方扩展代码，主进程不受影响；
 *  - 超时/报错一律返回 null，调用方退化成「只列工具名」；
 *  - 结果缓存 5 分钟；PROMPT_MAP_NO_PROBE=1 可整体关闭（测试用）。
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { pathToFileURL } = require('url');
const { PI_AGENT_DIR } = require('./config');

const PROBE_DIR = path.join(__dirname, 'probe');
const PROBE_FILES = ['extension-tools.mjs', 'prompt-hooks.mjs', 'register-hooks.mjs'];
const TTL_MS = 5 * 60_000;
const TIMEOUT_MS = 25_000;

let cache = { expires: 0, data: null };

function probeDisabled() {
  return !!process.env.PROMPT_MAP_NO_PROBE;
}

/** 扩展入口文件：目录取 index.ts，顶层取 *.ts/*.js/*.mjs（与 pi 的发现规则一致） */
function extensionEntries(extDir) {
  const dir = extDir || path.join(PI_AGENT_DIR, 'extensions');
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      const idx = path.join(dir, e.name, 'index.ts');
      if (fs.existsSync(idx)) out.push(idx);
    } else if (/\.(ts|js|mjs)$/.test(e.name)) {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

function parseProbeOutput(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  const line = text.split(String.fromCharCode(10)).filter(Boolean).pop();
  try {
    const parsed = JSON.parse(line);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((t) => t && t.name && Number.isFinite(t.chars));
  } catch {
    return null;
  }
}

/**
 * @returns {Promise<Array<{name:string,chars:number,hasSchema:boolean}>|null>} null 表示探测不可用
 */
function probeExtensionTools(extDir) {
  if (probeDisabled()) return Promise.resolve(null);
  if (cache.expires > Date.now()) return Promise.resolve(cache.data);

  const files = extensionEntries(extDir);
  if (!files.length) {
    cache = { expires: Date.now() + TTL_MS, data: [] };
    return Promise.resolve([]);
  }
  // pi 包目录：从自身位置向上找 node_modules/@earendil-works/pi-coding-agent
  const pkgRoot = require('./pi-package').resolvePiRoot();
  if (!pkgRoot) return Promise.resolve(null);

  const runner = path.join(PROBE_DIR, 'extension-tools.mjs');
  const register = path.join(PROBE_DIR, 'register-hooks.mjs');
  for (const f of PROBE_FILES) {
    if (!fs.existsSync(path.join(PROBE_DIR, f))) return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    execFile(
      process.execPath,
      // --import 需要 URL，不能给 Windows 相对路径
      ['--import', pathToFileURL(register).href, runner],
      {
        cwd: PROBE_DIR,
        timeout: TIMEOUT_MS,
        windowsHide: true,
        env: {
          ...process.env,
          PI_PROBE_PKG: pkgRoot,
          PI_PROBE_FILES: JSON.stringify(files),
        },
      },
      (error, stdout, stderr) => {
        if (process.env.PROMPT_MAP_DEBUG) {
          if (stderr) process.stderr.write(String(stderr));
          if (error) process.stderr.write('[probe] ' + error.message + String.fromCharCode(10));
        }
        const data = error && !stdout ? null : parseProbeOutput(stdout);
        cache = { expires: Date.now() + TTL_MS, data };
        resolve(data);
      }
    );
  });
}

function clearProbeCache() {
  cache = { expires: 0, data: null };
}

module.exports = { probeExtensionTools, parseProbeOutput, extensionEntries, clearProbeCache };
