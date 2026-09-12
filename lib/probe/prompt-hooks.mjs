/**
 * ESM 解析钩子：把扩展里的 @earendil-works/* 与 typebox 指向 pi 自带的那份依赖。
 *
 * 不用 import.meta.resolve 的二参（node 24 下不可用），直接按目录读 package.json
 * 的 exports / module / main 选入口，等价于 pi 自己的解析结果。
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const PKG = process.env.PI_PROBE_PKG;
if (!PKG) throw new Error('PI_PROBE_PKG required');
const DEPS_ROOT = path.join(PKG, 'node_modules');
const MAPPED = /^(@earendil-works\/|typebox$)/;

function pickEntry(pkg, subpath) {
  const ex = pkg.exports;
  const pick = (v) => {
    if (typeof v === 'string') return v;
    if (v && typeof v === 'object') return pick(v.import ?? v.default ?? v.require ?? null);
    return null;
  };
  if (ex && typeof ex === 'object') {
    if (subpath) {
      if (ex[subpath] !== undefined) return pick(ex[subpath]);
      // 处理 "./providers/*" 这类通配子路径
      for (const [key, val] of Object.entries(ex)) {
        const star = key.indexOf('*');
        if (star < 0) continue;
        const prefix = key.slice(0, star);
        const suffix = key.slice(star + 1);
        if (subpath.startsWith(prefix) && subpath.endsWith(suffix)) {
          const mid = subpath.slice(prefix.length, subpath.length - suffix.length);
          const target = pick(val);
          if (target) return target.replace('*', mid);
        }
      }
      return null;
    }
    const entry = pick(ex['.'] !== undefined ? ex['.'] : ex);
    if (entry) return entry;
  }
  return subpath ? null : pkg.module || pkg.main || 'index.js';
}

export async function resolve(specifier, context, next) {
  if (MAPPED.test(specifier)) {
    const [scope, name, ...rest] = specifier.split('/');
    // pi 包自身不在它自己的 node_modules 里，直接指向安装目录
    const pkgDir =
      specifier === '@earendil-works/pi-coding-agent'
        ? PKG
        : name
          ? path.join(DEPS_ROOT, scope, name)
          : path.join(DEPS_ROOT, scope);
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
      const subpath = rest.length ? './' + rest.join('/') : '';
      const entry = pickEntry(pkg, subpath);
      if (entry) return { url: pathToFileURL(path.join(pkgDir, entry)).href, shortCircuit: true };
      for (const ext of ['.js', '.mjs', '/index.js']) {
        const guess = path.join(pkgDir, subpath.replace(/^\.\//, '') + ext);
        if (fs.existsSync(guess)) return { url: pathToFileURL(guess).href, shortCircuit: true };
      }
    } catch {
      /* 落回默认解析 */
    }
  }
  return next(specifier, context);
}
