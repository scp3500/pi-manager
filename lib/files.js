const fs = require('fs');
const path = require('path');
const { readManagerConfig } = require('./manager-config');
const { getWorkspace } = require('./workspaces');
const { BACKUP_KEEP } = require('./config');
const {
  resolveUnderRoot: resolveUnderRootSafe,
  assertNoSymlinkInTree,
} = require('./path-safety');

const TEXT_EXTS = new Set([
  '.md',
  '.txt',
  '.json',
  '.jsonl',
  '.js',
  '.cjs',
  '.mjs',
  '.ts',
  '.tsx',
  '.jsx',
  '.css',
  '.html',
  '.htm',
  '.yml',
  '.yaml',
  '.toml',
  '.ini',
  '.env',
  '.py',
  '.sh',
  '.bat',
  '.cmd',
  '.ps1',
  '.xml',
  '.svg',
  '.csv',
  '.log',
  '.gitignore',
]);

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '__pycache__',
  '.venv',
  'venv',
  'dist',
  'build',
  '.cache',
  '.trash',
]);

function editorLimits() {
  const cfg = readManagerConfig();
  const maxFileKB = Number((cfg.editor && cfg.editor.maxFileKB) || 512);
  return {
    maxFileKB: Number.isFinite(maxFileKB) && maxFileKB > 0 ? maxFileKB : 512,
    backup: cfg.editor ? cfg.editor.backup !== false : true,
  };
}

/** @param {{ allowMissing?: boolean }} [opts] */
function resolveUnderRoot(root, relPath, opts) {
  return resolveUnderRootSafe(root, relPath, opts);
}

function workspaceRoot(workspaceId) {
  const w = getWorkspace(workspaceId);
  if (!w.rootExists) throw new Error('root does not exist: ' + w.root);
  return w.root;
}

function isTextFile(filePath) {
  const base = path.basename(filePath);
  if (base === 'AGENTS.md' || base === 'SKILL.md' || base === 'README') return true;
  const ext = path.extname(filePath).toLowerCase();
  if (!ext && base.startsWith('.')) return true;
  return TEXT_EXTS.has(ext);
}

function listTree(workspaceId, relPath = '', opts = {}) {
  const root = workspaceRoot(workspaceId);
  const { abs, rel } = resolveUnderRoot(root, relPath);
  if (!fs.existsSync(abs)) throw new Error('not found');
  const st = fs.statSync(abs);
  if (!st.isDirectory()) throw new Error('not a directory');

  const maxDepth = opts.maxDepth != null ? Number(opts.maxDepth) : 3;
  const maxEntries = opts.maxEntries != null ? Number(opts.maxEntries) : 400;
  let count = 0;

  function build(dirAbs, dirRel, depth) {
    const list = [];
    let names;
    try {
      names = fs.readdirSync(dirAbs);
    } catch {
      return list;
    }
    // single lstat pass, then sort dirs first — avoids double-stat per name
    const entries = [];
    for (const name of names) {
      if (name === '.' || name === '..') continue;
      if (name.endsWith('.bak') || /\.bak\.\d+$/.test(name)) continue;
      const childAbs = path.join(dirAbs, name);
      let cst;
      try {
        cst = fs.lstatSync(childAbs);
      } catch {
        continue;
      }
      if (cst.isSymbolicLink()) continue;
      entries.push({ name, childAbs, cst });
    }
    entries.sort((a, b) => {
      const ad = a.cst.isDirectory();
      const bd = b.cst.isDirectory();
      if (ad !== bd) return ad ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const { name, childAbs, cst } of entries) {
      if (count >= maxEntries) {
        list.push({ name: '…', path: dirRel, type: 'more', truncated: true });
        break;
      }
      const childRel = dirRel ? dirRel + '/' + name : name;
      if (cst.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue;
        count++;
        const node = { name, path: childRel, type: 'dir' };
        if (depth < maxDepth) node.children = build(childAbs, childRel, depth + 1);
        else node.truncated = true;
        list.push(node);
      } else if (cst.isFile()) {
        count++;
        list.push({
          name,
          path: childRel,
          type: 'file',
          size: cst.size,
          mtime: cst.mtimeMs,
          text: isTextFile(childAbs),
        });
      }
    }
    return list;
  }

  const children = build(abs, rel, 1);
  return {
    workspaceId,
    root,
    path: rel,
    maxDepth,
    count,
    truncated: count >= maxEntries,
    children,
  };
}

function backupFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const bak0 = filePath + '.bak';
  for (let i = BACKUP_KEEP - 1; i >= 1; i--) {
    const from = i === 1 ? bak0 : filePath + '.bak.' + (i - 1);
    const to = filePath + '.bak.' + i;
    if (fs.existsSync(from)) {
      try {
        fs.renameSync(from, to);
      } catch {
        try {
          fs.copyFileSync(from, to);
        } catch {
          /* ignore */
        }
      }
    }
  }
  try {
    fs.copyFileSync(filePath, bak0);
  } catch (e) {
    console.warn('file backup failed:', e.message);
  }
}

function readFileInWorkspace(workspaceId, relPath) {
  const root = workspaceRoot(workspaceId);
  const { abs, rel } = resolveUnderRoot(root, relPath);
  if (!fs.existsSync(abs)) throw new Error('not found');
  const st = fs.statSync(abs);
  if (!st.isFile()) throw new Error('not a file');
  const limits = editorLimits();
  const maxBytes = limits.maxFileKB * 1024;
  const text = isTextFile(abs);
  if (!text) {
    return {
      workspaceId,
      path: rel,
      abs,
      exists: true,
      text: false,
      size: st.size,
      mtime: st.mtimeMs,
      content: null,
      editable: false,
      reason: 'binary or unsupported extension',
    };
  }
  if (st.size > maxBytes) {
    const fd = fs.openSync(abs, 'r');
    const buf = Buffer.alloc(Math.min(st.size, maxBytes));
    fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    return {
      workspaceId,
      path: rel,
      abs,
      exists: true,
      text: true,
      size: st.size,
      mtime: st.mtimeMs,
      content: buf.toString('utf8'),
      truncated: true,
      editable: false,
      reason: 'file larger than maxFileKB=' + limits.maxFileKB,
      maxFileKB: limits.maxFileKB,
    };
  }
  return {
    workspaceId,
    path: rel,
    abs,
    exists: true,
    text: true,
    size: st.size,
    mtime: st.mtimeMs,
    content: fs.readFileSync(abs, 'utf8'),
    truncated: false,
    editable: true,
    maxFileKB: limits.maxFileKB,
  };
}

function writeFileInWorkspace(workspaceId, relPath, content) {
  if (typeof content !== 'string') throw new Error('content must be string');
  const root = workspaceRoot(workspaceId);
  const { abs, rel } = resolveUnderRoot(root, relPath, { allowMissing: true });
  if (!isTextFile(abs)) throw new Error('file type not editable');
  const limits = editorLimits();
  const maxBytes = limits.maxFileKB * 1024;
  const size = Buffer.byteLength(content, 'utf8');
  if (size > maxBytes) throw new Error('content exceeds maxFileKB=' + limits.maxFileKB);
  const dir = path.dirname(abs);
  if (!fs.existsSync(dir)) throw new Error('parent directory does not exist');
  if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) throw new Error('path is directory');
  if (limits.backup) backupFile(abs);
  const tmp = abs + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, abs);
  return readFileInWorkspace(workspaceId, rel);
}

function assertSafeName(name) {
  const n = String(name || '').trim();
  if (!n || n === '.' || n === '..') throw new Error('invalid name');
  if (/[\\/\0]/.test(n) || n.includes('..')) throw new Error('invalid name');
  if (!/^[\w\u4e00-\u9fff][\w\u4e00-\u9fff .()\[\]_\-+@#%~]{0,120}$/.test(n)) {
    // 允许中文文件名与常见符号；拒绝奇怪控制符
    if (/[<>:"|?*]/.test(n)) throw new Error('invalid name');
  }
  return n;
}

function mkdirInWorkspace(workspaceId, relPath) {
  const root = workspaceRoot(workspaceId);
  const { abs, rel } = resolveUnderRoot(root, relPath, { allowMissing: true });
  if (fs.existsSync(abs)) {
    if (!fs.statSync(abs).isDirectory()) throw new Error('path exists and is not a directory');
    return { workspaceId, path: rel, type: 'dir', existed: true };
  }
  fs.mkdirSync(abs, { recursive: true });
  return { workspaceId, path: rel, type: 'dir', existed: false };
}

function createFileInWorkspace(workspaceId, relPath, content = '') {
  const root = workspaceRoot(workspaceId);
  const { abs, rel } = resolveUnderRoot(root, relPath, { allowMissing: true });
  if (!isTextFile(abs)) throw new Error('file type not allowed');
  if (fs.existsSync(abs)) throw new Error('already exists');
  const dir = path.dirname(abs);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const text = typeof content === 'string' ? content : '';
  const limits = editorLimits();
  if (Buffer.byteLength(text, 'utf8') > limits.maxFileKB * 1024) {
    throw new Error('content exceeds maxFileKB=' + limits.maxFileKB);
  }
  fs.writeFileSync(abs, text, 'utf8');
  return readFileInWorkspace(workspaceId, rel);
}

function trashStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return (
    d.getFullYear() +
    p(d.getMonth() + 1) +
    p(d.getDate()) +
    '-' +
    p(d.getHours()) +
    p(d.getMinutes()) +
    p(d.getSeconds()) +
    '-' +
    Math.random().toString(36).slice(2, 6)
  );
}

/**
 * Move path into workspace `.trash/` instead of permanent delete.
 * Layout: `.trash/<stamp>__<rel-with-slashes-as-__>/` for dirs, or file beside stamp prefix.
 */
function deleteInWorkspace(workspaceId, relPath, opts = {}) {
  const hard = !!opts.hard;
  const root = workspaceRoot(workspaceId);
  const { abs, rel } = resolveUnderRoot(root, relPath);
  if (!rel) throw new Error('cannot delete workspace root');
  if (rel === '.trash' || rel.startsWith('.trash/') || rel.startsWith('.trash\\')) {
    throw new Error('cannot delete inside .trash via API');
  }
  if (!fs.existsSync(abs)) throw new Error('not found');
  const st = fs.lstatSync(abs);
  if (st.isSymbolicLink()) throw new Error('refusing symlink');

  if (hard) {
    assertNoSymlinkInTree(root, abs);
    if (st.isDirectory()) {
      const names = fs.readdirSync(abs);
      if (names.length > 50) throw new Error('directory too large to delete here');
      fs.rmSync(abs, { recursive: true, force: false });
      return { workspaceId, path: rel, deleted: true, type: 'dir', hard: true };
    }
    if (st.isFile()) {
      const limits = editorLimits();
      if (limits.backup && isTextFile(abs)) backupFile(abs);
      fs.unlinkSync(abs);
      return { workspaceId, path: rel, deleted: true, type: 'file', hard: true };
    }
    throw new Error('unsupported type');
  }

  // soft delete → .trash/<stamp>/{__meta.json, payload}
  const trashRoot = path.join(root, '.trash');
  if (!fs.existsSync(trashRoot)) fs.mkdirSync(trashRoot, { recursive: true });
  const stamp = trashStamp();
  const bucket = path.join(trashRoot, stamp);
  if (fs.existsSync(bucket)) throw new Error('trash name collision, retry');
  fs.mkdirSync(bucket, { recursive: true });
  const type = st.isDirectory() ? 'dir' : 'file';
  const payload = path.join(bucket, 'payload');
  fs.renameSync(abs, payload);
  const meta = {
    originalRel: rel.replace(/\\/g, '/'),
    type,
    deletedAt: new Date().toISOString(),
    stamp,
  };
  fs.writeFileSync(path.join(bucket, '__meta.json'), JSON.stringify(meta, null, 2), 'utf8');
  return {
    workspaceId,
    path: rel,
    deleted: true,
    trashed: true,
    trashPath: path.relative(root, bucket).replace(/\\/g, '/'),
    stamp,
    type,
    hard: false,
  };
}

function listTrash(workspaceId) {
  const root = workspaceRoot(workspaceId);
  const trashRoot = path.join(root, '.trash');
  if (!fs.existsSync(trashRoot) || !fs.statSync(trashRoot).isDirectory()) {
    return { workspaceId, trashDir: trashRoot, exists: false, items: [] };
  }
  const items = [];
  let entries;
  try {
    entries = fs.readdirSync(trashRoot, { withFileTypes: true });
  } catch (e) {
    throw new Error('cannot read trash: ' + e.message);
  }

  for (const ent of entries) {
    const name = ent.name;
    const full = path.join(trashRoot, name);

    // New layout: .trash/<stamp>/__meta.json + payload
    if (ent.isDirectory()) {
      const metaPath = path.join(full, '__meta.json');
      const payload = path.join(full, 'payload');
      if (fs.existsSync(metaPath)) {
        let meta = {};
        try {
          meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        } catch {
          meta = {};
        }
        let size = 0;
        let type = meta.type || 'file';
        try {
          const st = fs.statSync(payload);
          size = st.isDirectory() ? 0 : st.size;
          type = st.isDirectory() ? 'dir' : 'file';
        } catch {
          /* missing payload */
        }
        items.push({
          stamp: meta.stamp || name,
          layout: 'bucket',
          trashPath: path.relative(root, full).replace(/\\/g, '/'),
          originalRel: meta.originalRel || '',
          type,
          size,
          deletedAt: meta.deletedAt || null,
          mtime: fs.statSync(full).mtime.toISOString(),
        });
        continue;
      }
    }

    // Legacy flat: .trash/<stamp>__<safeRel>
    if (ent.isFile() || ent.isDirectory()) {
      const m = String(name).match(/^(\d{8}-\d{6}-[a-z0-9]+)__(.+)$/i);
      if (!m) continue;
      const stamp = m[1];
      const originalRel = m[2].replace(/__/g, '/');
      let size = 0;
      let type = ent.isDirectory() ? 'dir' : 'file';
      try {
        const st = fs.statSync(full);
        size = st.isFile() ? st.size : 0;
        type = st.isDirectory() ? 'dir' : 'file';
      } catch {
        /* ignore */
      }
      items.push({
        stamp,
        layout: 'legacy',
        trashPath: path.relative(root, full).replace(/\\/g, '/'),
        originalRel,
        type,
        size,
        deletedAt: null,
        mtime: fs.statSync(full).mtime.toISOString(),
        legacyName: name,
      });
    }
  }

  items.sort((a, b) => String(b.mtime).localeCompare(String(a.mtime)));
  return {
    workspaceId,
    trashDir: trashRoot,
    exists: true,
    count: items.length,
    items,
  };
}

function restoreTrash(workspaceId, stampOrPath) {
  const root = workspaceRoot(workspaceId);
  const trashRoot = path.join(root, '.trash');
  const key = String(stampOrPath || '').trim().replace(/\\/g, '/');
  if (!key || key.includes('..')) throw new Error('invalid trash id');

  // accept stamp or .trash/stamp or legacy name
  let bucketRel = key.startsWith('.trash/') ? key : null;
  let legacyAbs = null;
  let stamp = key.replace(/^\.trash\//, '');

  if (!bucketRel) {
    const bucket = path.join(trashRoot, stamp);
    if (fs.existsSync(path.join(bucket, '__meta.json'))) {
      bucketRel = path.relative(root, bucket).replace(/\\/g, '/');
    } else {
      // legacy file name might be full name
      const legacy = path.join(trashRoot, stamp);
      if (fs.existsSync(legacy)) {
        legacyAbs = legacy;
      } else {
        // try find by stamp prefix
        const listed = listTrash(workspaceId).items || [];
        const hit = listed.find((x) => x.stamp === stamp || x.trashPath === key || x.legacyName === stamp);
        if (!hit) throw new Error('trash item not found');
        if (hit.layout === 'legacy') {
          legacyAbs = path.join(root, hit.trashPath);
          stamp = hit.stamp;
        } else {
          bucketRel = hit.trashPath;
        }
      }
    }
  }

  if (legacyAbs) {
    const base = path.basename(legacyAbs);
    const m = base.match(/^(\d{8}-\d{6}-[a-z0-9]+)__(.+)$/i);
    const originalRel = m ? m[2].replace(/__/g, '/') : base;
    const dest = resolveUnderRoot(root, originalRel, { allowMissing: true });
    if (fs.existsSync(dest.abs)) throw new Error('target exists: ' + originalRel);
    const parent = path.dirname(dest.abs);
    if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
    fs.renameSync(legacyAbs, dest.abs);
    return { workspaceId, restored: true, path: dest.rel, from: 'legacy' };
  }

  const bucketAbs = path.join(root, bucketRel);
  const metaPath = path.join(bucketAbs, '__meta.json');
  const payload = path.join(bucketAbs, 'payload');
  if (!fs.existsSync(metaPath) || !fs.existsSync(payload)) throw new Error('trash item incomplete');
  let meta;
  try {
    meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  } catch (e) {
    throw new Error('bad trash meta: ' + e.message);
  }
  const originalRel = String(meta.originalRel || '').replace(/\\/g, '/');
  if (!originalRel) throw new Error('missing originalRel');
  const dest = resolveUnderRoot(root, originalRel, { allowMissing: true });
  if (fs.existsSync(dest.abs)) throw new Error('target exists: ' + originalRel);
  const parent = path.dirname(dest.abs);
  if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
  fs.renameSync(payload, dest.abs);
  // remove bucket leftovers
  try {
    fs.rmSync(bucketAbs, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  return {
    workspaceId,
    restored: true,
    path: dest.rel,
    type: meta.type || 'file',
    from: 'bucket',
  };
}

function purgeTrash(workspaceId, stampOrPath) {
  const root = workspaceRoot(workspaceId);
  const trashRoot = path.join(root, '.trash');
  if (!fs.existsSync(trashRoot)) {
    return { workspaceId, purged: 0, items: [] };
  }

  const listed = listTrash(workspaceId).items || [];
  let targets = listed;
  if (stampOrPath) {
    const key = String(stampOrPath).trim().replace(/\\/g, '/');
    targets = listed.filter(
      (x) =>
        x.stamp === key ||
        x.trashPath === key ||
        x.trashPath === '.trash/' + key ||
        x.legacyName === key
    );
    if (!targets.length) throw new Error('trash item not found');
  }

  const purged = [];
  for (const t of targets) {
    const abs = path.join(root, t.trashPath);
    try {
      fs.rmSync(abs, { recursive: true, force: true });
      purged.push(t.trashPath);
    } catch (e) {
      purged.push(t.trashPath + ' (error: ' + e.message + ')');
    }
  }
  // remove empty .trash
  try {
    if (fs.existsSync(trashRoot) && fs.readdirSync(trashRoot).length === 0) {
      fs.rmdirSync(trashRoot);
    }
  } catch {
    /* ignore */
  }
  return { workspaceId, purged: purged.length, items: purged };
}

function renameInWorkspace(workspaceId, fromRel, toRel) {
  const root = workspaceRoot(workspaceId);
  const from = resolveUnderRoot(root, fromRel);
  const to = resolveUnderRoot(root, toRel, { allowMissing: true });
  if (!from.rel || !to.rel) throw new Error('cannot rename workspace root');
  if (!fs.existsSync(from.abs)) throw new Error('not found');
  if (fs.existsSync(to.abs)) throw new Error('target exists');
  const parent = path.dirname(to.abs);
  if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
  fs.renameSync(from.abs, to.abs);
  return {
    workspaceId,
    from: from.rel,
    to: to.rel,
    type: fs.statSync(to.abs).isDirectory() ? 'dir' : 'file',
  };
}

module.exports = {
  listTree,
  readFile: readFileInWorkspace,
  writeFile: writeFileInWorkspace,
  mkdir: mkdirInWorkspace,
  createFile: createFileInWorkspace,
  deletePath: deleteInWorkspace,
  renamePath: renameInWorkspace,
  listTrash,
  restoreTrash,
  purgeTrash,
  isTextFile,
  resolveUnderRoot,
  editorLimits,
  TEXT_EXTS,
  assertSafeName,
};
