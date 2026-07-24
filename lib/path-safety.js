/**
 * Path containment helpers for workspace file APIs.
 * Blocks `..` and symlink/junction escape outside the root.
 */
const fs = require('fs');
const path = require('path');

function lexicalUnderRoot(root, relPath) {
  const rootAbs = path.resolve(root);
  const rel = String(relPath || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '');
  if (rel.includes('\0')) {
    const err = new Error('invalid path');
    err.status = 400;
    throw err;
  }
  if (rel.split('/').some((p) => p === '..')) {
    const err = new Error('invalid path');
    err.status = 400;
    throw err;
  }
  const abs = path.resolve(rootAbs, rel);
  const prefix = rootAbs.endsWith(path.sep) ? rootAbs : rootAbs + path.sep;
  if (abs !== rootAbs && !abs.startsWith(prefix)) {
    const err = new Error('invalid path');
    err.status = 400;
    throw err;
  }
  return {
    rootAbs,
    abs,
    rel: path.relative(rootAbs, abs).replace(/\\/g, '/') || '',
  };
}

function sameOrUnder(rootReal, candidateReal) {
  const a = path.resolve(rootReal);
  const b = path.resolve(candidateReal);
  if (a === b) return true;
  const prefix = a.endsWith(path.sep) ? a : a + path.sep;
  return b.startsWith(prefix);
}

function realpathExisting(p) {
  try {
    return fs.realpathSync(p);
  } catch (e) {
    const err = new Error('path not accessible: ' + (e && e.message ? e.message : e));
    err.status = 400;
    throw err;
  }
}

/**
 * Resolve relPath under root with canonical (realpath) re-check.
 * - Target may not exist if allowMissing=true (for create); then nearest existing
 *   ancestor is realpath'd and must stay under root.
 * - Final node that is a symlink is allowed only if realpath still under root
 *   (callers may still refuse symlink delete separately).
 */
function resolveUnderRoot(root, relPath, opts = {}) {
  const allowMissing = !!opts.allowMissing;
  const { rootAbs, abs, rel } = lexicalUnderRoot(root, relPath);

  if (!fs.existsSync(rootAbs)) {
    const err = new Error('root does not exist: ' + rootAbs);
    err.status = 400;
    throw err;
  }
  const rootReal = realpathExisting(rootAbs);
  if (!fs.statSync(rootReal).isDirectory()) {
    const err = new Error('root is not a directory');
    err.status = 400;
    throw err;
  }

  if (fs.existsSync(abs)) {
    const realAbs = realpathExisting(abs);
    if (!sameOrUnder(rootReal, realAbs)) {
      const err = new Error('path escapes root (symlink)');
      err.status = 400;
      throw err;
    }
    return { rootAbs, rootReal, abs, realAbs, rel };
  }

  if (!allowMissing) {
    const err = new Error('not found');
    err.status = 404;
    throw err;
  }

  // Nearest existing ancestor must stay inside root after realpath.
  let probe = path.dirname(abs);
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  if (!fs.existsSync(probe)) {
    const err = new Error('invalid path');
    err.status = 400;
    throw err;
  }
  const probeReal = realpathExisting(probe);
  if (!sameOrUnder(rootReal, probeReal)) {
    const err = new Error('path escapes root (symlink)');
    err.status = 400;
    throw err;
  }
  return { rootAbs, rootReal, abs, realAbs: null, rel };
}

/**
 * Ensure no symlink appears on the path from root to abs (final may be file).
 * Used for hard-delete trees.
 */
function assertNoSymlinkInTree(rootAbs, abs) {
  const rootReal = realpathExisting(rootAbs);
  function walk(dir) {
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const child = path.join(dir, name);
      let st;
      try {
        st = fs.lstatSync(child);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) {
        const err = new Error('refusing symlink in tree');
        err.status = 400;
        throw err;
      }
      if (st.isDirectory()) {
        const real = realpathExisting(child);
        if (!sameOrUnder(rootReal, real)) {
          const err = new Error('path escapes root (symlink)');
          err.status = 400;
          throw err;
        }
        walk(child);
      }
    }
  }
  let st;
  try {
    st = fs.lstatSync(abs);
  } catch {
    return;
  }
  if (st.isSymbolicLink()) {
    const err = new Error('refusing symlink');
    err.status = 400;
    throw err;
  }
  if (st.isDirectory()) walk(abs);
}

module.exports = {
  lexicalUnderRoot,
  resolveUnderRoot,
  sameOrUnder,
  realpathExisting,
  assertNoSymlinkInTree,
};
