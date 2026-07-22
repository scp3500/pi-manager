const fs = require('fs');
const path = require('path');
const { PI_AGENT_DIR, BACKUP_KEEP } = require('./config');

const SESSIONS_DIR =
  process.env.SESSIONS_DIR || path.join(PI_AGENT_DIR, 'sessions');

const TMP_NAME_RE = /^tmp[_-]/i;
const BAK_NAME_RE = /\.bak(\.\d+)?$/i;

function ensureDir(dir) {
  if (!fs.existsSync(dir)) return false;
  return fs.statSync(dir).isDirectory();
}

function formatBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return v + ' B';
  if (v < 1024 * 1024) return (v / 1024).toFixed(1) + ' KB';
  if (v < 1024 * 1024 * 1024) return (v / (1024 * 1024)).toFixed(1) + ' MB';
  return (v / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

function safeJoinUnder(root, relParts) {
  const rootResolved = path.resolve(root);
  const target = path.resolve(rootResolved, ...relParts);
  const prefix = rootResolved.endsWith(path.sep) ? rootResolved : rootResolved + path.sep;
  if (target !== rootResolved && !target.startsWith(prefix)) {
    const err = new Error('path escapes root');
    err.status = 400;
    throw err;
  }
  return target;
}

/** Header cache: avoid re-reading first line when mtime+size unchanged */
const headerCache = new Map(); // absPath -> { mtimeMs, size, header }
const HEADER_CACHE_MAX = 4000;

function readSessionHeader(filePath, stHint) {
  const out = { cwd: null, id: null, version: null, firstTimestamp: null };
  let mtimeMs = stHint && stHint.mtimeMs;
  let size = stHint && stHint.size;
  try {
    if (mtimeMs == null || size == null) {
      const st = fs.statSync(filePath);
      mtimeMs = st.mtimeMs;
      size = st.size;
    }
  } catch {
    return out;
  }
  const hit = headerCache.get(filePath);
  if (hit && hit.mtimeMs === mtimeMs && hit.size === size) {
    return { ...hit.header };
  }
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(4096);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      const text = buf.slice(0, n).toString('utf8');
      const line = text.split(/\r?\n/).find((l) => l.trim());
      if (line) {
        const obj = JSON.parse(line);
        if (obj && typeof obj === 'object') {
          if (obj.type === 'session') {
            out.cwd = obj.cwd || null;
            out.id = obj.id || null;
            out.version = obj.version ?? null;
            out.firstTimestamp = obj.timestamp || null;
          } else if (obj.cwd) {
            out.cwd = obj.cwd;
          }
        }
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    /* ignore parse errors */
  }
  if (headerCache.size >= HEADER_CACHE_MAX) {
    // drop oldest ~25%
    let i = 0;
    const drop = Math.floor(HEADER_CACHE_MAX / 4);
    for (const k of headerCache.keys()) {
      headerCache.delete(k);
      if (++i >= drop) break;
    }
  }
  headerCache.set(filePath, { mtimeMs, size, header: { ...out } });
  return out;
}

function clearSessionHeaderCache() {
  headerCache.clear();
}

function parseSessionFileName(name) {
  // 2026-05-18T06-52-34-082Z_019e39db-....jsonl
  const m = String(name).match(
    /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)_([0-9a-fA-F-]+)\.jsonl$/
  );
  if (!m) return { startedAt: null, sessionId: null };
  const raw = m[1];
  // convert 2026-05-18T06-52-34-082Z -> 2026-05-18T06:52:34.082Z
  const iso = raw.replace(
    /^(\d{4}-\d{2}-\d{2}T)(\d{2})-(\d{2})-(\d{2})-(\d{3}Z)$/,
    '$1$2:$3:$4.$5'
  );
  return { startedAt: iso, sessionId: m[2] };
}

function decodeCwdKey(key) {
  // --C--Users-33795-- => C:/Users/33795 roughly; keep key readable
  if (!key) return '';
  return String(key)
    .replace(/^--+/, '')
    .replace(/--+$/, '')
    .replace(/--/g, '/')
    .replace(/-/g, (ch, i, s) => {
      // keep UUID-like intact; this is best-effort display only
      return ch;
    });
}

/**
 * Enumerate all session files (readdir+stat only, no header IO, no page cap).
 * Used by cleanup so old sessions beyond listSessions' 500 page limit still delete.
 */
function listAllSessionFiles({ cwd } = {}) {
  const root = SESSIONS_DIR;
  if (!ensureDir(root)) {
    return { sessionsDir: root, exists: false, total: 0, totalBytes: 0, items: [] };
  }

  const items = [];
  let totalBytes = 0;
  let dirs;
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true });
  } catch (e) {
    const err = new Error('cannot read sessions dir: ' + e.message);
    err.status = 500;
    throw err;
  }

  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const cwdKey = d.name;
    if (cwd && cwdKey !== cwd && !cwdKey.includes(cwd)) continue;
    const dirPath = path.join(root, cwdKey);
    let files;
    try {
      files = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      continue;
    }
    const cwdGuess = decodeCwdKey(cwdKey);
    for (const f of files) {
      if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
      const fp = path.join(dirPath, f.name);
      let st;
      try {
        st = fs.statSync(fp);
      } catch {
        continue;
      }
      const parsed = parseSessionFileName(f.name);
      const mtimeMs = st.mtimeMs;
      const size = st.size;
      totalBytes += size;
      items.push({
        id: parsed.sessionId || f.name,
        fileName: f.name,
        cwdKey,
        cwd: cwdGuess,
        path: fp,
        relPath: path.join(cwdKey, f.name),
        size,
        sizeLabel: formatBytes(size),
        mtime: new Date(mtimeMs).toISOString(),
        mtimeMs,
        startedAt: parsed.startedAt,
      });
    }
  }

  items.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return {
    sessionsDir: root,
    exists: true,
    total: items.length,
    totalBytes,
    totalSizeLabel: formatBytes(totalBytes),
    items,
  };
}

function listSessions({ cwd, limit, offset, q } = {}) {
  const root = SESSIONS_DIR;
  if (!ensureDir(root)) {
    return {
      sessionsDir: root,
      exists: false,
      total: 0,
      totalBytes: 0,
      groups: [],
      items: [],
    };
  }

  /** Lightweight first pass: readdir + stat only (no header IO) */
  const items = [];
  let totalBytes = 0;
  const groupsMap = new Map();

  let dirs;
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true });
  } catch (e) {
    const err = new Error('cannot read sessions dir: ' + e.message);
    err.status = 500;
    throw err;
  }

  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const cwdKey = d.name;
    if (cwd && cwdKey !== cwd && !cwdKey.includes(cwd)) continue;
    const dirPath = path.join(root, cwdKey);
    let files;
    try {
      files = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      continue;
    }
    let groupBytes = 0;
    let groupCount = 0;
    let groupLatest = 0;
    const cwdGuess = decodeCwdKey(cwdKey);

    for (const f of files) {
      if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
      const fp = path.join(dirPath, f.name);
      let st;
      try {
        st = fs.statSync(fp);
      } catch {
        continue;
      }
      const parsed = parseSessionFileName(f.name);
      const mtimeMs = st.mtimeMs;
      const size = st.size;
      // disk total is always full-tree (independent of q)
      totalBytes += size;

      const item = {
        id: parsed.sessionId || f.name,
        fileName: f.name,
        cwdKey,
        cwd: cwdGuess,
        path: fp,
        relPath: path.join(cwdKey, f.name),
        size,
        sizeLabel: formatBytes(size),
        mtime: new Date(mtimeMs).toISOString(),
        mtimeMs,
        startedAt: parsed.startedAt,
      };

      if (q) {
        const qq = String(q).toLowerCase();
        const hay = (item.cwd + ' ' + item.fileName + ' ' + item.id + ' ' + cwdKey).toLowerCase();
        if (!hay.includes(qq)) continue;
      }
      // group stats follow filtered items (search-consistent)
      groupBytes += size;
      groupCount += 1;
      if (mtimeMs > groupLatest) groupLatest = mtimeMs;
      items.push(item);
    }

    if (groupCount > 0 || !q) {
      groupsMap.set(cwdKey, {
        cwdKey,
        cwd: cwdGuess,
        count: groupCount,
        bytes: groupBytes,
        sizeLabel: formatBytes(groupBytes),
        latestMtime: groupLatest ? new Date(groupLatest).toISOString() : null,
      });
    }
  }

  items.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const groups = [...groupsMap.values()].sort((a, b) => {
    const ta = a.latestMtime ? Date.parse(a.latestMtime) : 0;
    const tb = b.latestMtime ? Date.parse(b.latestMtime) : 0;
    return tb - ta;
  });

  const off = Math.max(0, Number(offset) || 0);
  const lim = Math.min(500, Math.max(1, Number(limit) || 100));
  const page = items.slice(off, off + lim);

  // Enrich only the returned page with session headers (cached by mtime+size)
  for (const item of page) {
    const header = readSessionHeader(item.path, {
      mtimeMs: item.mtimeMs,
      size: item.size,
    });
    if (header.id) item.id = header.id;
    if (header.cwd) item.cwd = header.cwd;
    if (header.firstTimestamp) item.startedAt = header.firstTimestamp;
    // keep group cwd accurate when we have a real header
    const g = groupsMap.get(item.cwdKey);
    if (g && header.cwd) g.cwd = header.cwd;
  }

  return {
    sessionsDir: root,
    exists: true,
    total: items.length,
    totalBytes,
    totalSizeLabel: formatBytes(totalBytes),
    offset: off,
    limit: lim,
    groups,
    items: page,
  };
}

function deleteSessionFiles(relPaths) {
  if (!Array.isArray(relPaths) || !relPaths.length) {
    const err = new Error('paths required');
    err.status = 400;
    throw err;
  }
  if (!ensureDir(SESSIONS_DIR)) {
    const err = new Error('sessions dir missing');
    err.status = 404;
    throw err;
  }

  const deleted = [];
  const errors = [];
  let freed = 0;

  for (const rel of relPaths) {
    const relNorm = String(rel || '').replace(/\\/g, '/');
    if (!relNorm || relNorm.includes('..')) {
      errors.push({ path: rel, error: 'invalid path' });
      continue;
    }
    const parts = relNorm.split('/').filter(Boolean);
    try {
      const abs = safeJoinUnder(SESSIONS_DIR, parts);
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
        errors.push({ path: rel, error: 'not found' });
        continue;
      }
      if (!abs.endsWith('.jsonl')) {
        errors.push({ path: rel, error: 'only .jsonl allowed' });
        continue;
      }
      const size = fs.statSync(abs).size;
      fs.unlinkSync(abs);
      freed += size;
      deleted.push(relNorm);

      // remove empty cwd folder
      const parent = path.dirname(abs);
      try {
        if (fs.readdirSync(parent).length === 0) fs.rmdirSync(parent);
      } catch {
        /* ignore */
      }
    } catch (e) {
      errors.push({ path: rel, error: e.message });
    }
  }

  return {
    deleted: deleted.length,
    freed,
    freedLabel: formatBytes(freed),
    paths: deleted,
    errors,
  };
}

function deleteSessionsOlderThan(days) {
  const d = Number(days);
  if (!Number.isFinite(d) || d < 0) {
    const err = new Error('days must be >= 0');
    err.status = 400;
    throw err;
  }
  const cutoff = Date.now() - d * 24 * 60 * 60 * 1000;
  // full enum — listSessions page cap is 500 and would skip older files
  const all = listAllSessionFiles({});
  const targets = (all.items || [])
    .filter((it) => it.mtimeMs < cutoff)
    .map((it) => it.relPath);
  if (!targets.length) {
    return { deleted: 0, freed: 0, freedLabel: formatBytes(0), paths: [], errors: [] };
  }
  return deleteSessionFiles(targets);
}

function listJunkFiles() {
  const tmp = [];
  const bak = [];
  let tmpBytes = 0;
  let bakBytes = 0;

  let names;
  try {
    names = fs.readdirSync(PI_AGENT_DIR);
  } catch (e) {
    const err = new Error('cannot read PI_AGENT_DIR: ' + e.message);
    err.status = 500;
    throw err;
  }

  for (const name of names) {
    const abs = path.join(PI_AGENT_DIR, name);
    let st;
    try {
      st = fs.statSync(abs);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;

    if (TMP_NAME_RE.test(name)) {
      tmp.push({
        name,
        path: abs,
        size: st.size,
        sizeLabel: formatBytes(st.size),
        mtime: st.mtime.toISOString(),
        kind: 'tmp',
      });
      tmpBytes += st.size;
      continue;
    }
    if (BAK_NAME_RE.test(name)) {
      bak.push({
        name,
        path: abs,
        size: st.size,
        sizeLabel: formatBytes(st.size),
        mtime: st.mtime.toISOString(),
        kind: 'bak',
      });
      bakBytes += st.size;
    }
  }

  tmp.sort((a, b) => a.name.localeCompare(b.name));
  bak.sort((a, b) => a.name.localeCompare(b.name));

  return {
    piAgentDir: PI_AGENT_DIR,
    tmp,
    bak,
    tmpBytes,
    bakBytes,
    tmpSizeLabel: formatBytes(tmpBytes),
    bakSizeLabel: formatBytes(bakBytes),
    backupKeep: BACKUP_KEEP,
  };
}

/**
 * modes:
 *  - tmp: delete tmp_* files in PI_AGENT_DIR
 *  - bak: delete .bak / .bak.N (option keepLatest: keep .bak only for each base)
 *  - bak_old: only delete .bak.N (N>=1), keep plain .bak
 */
function cleanupJunk({ mode = 'tmp', dryRun = false } = {}) {
  const junk = listJunkFiles();
  let targets = [];

  if (mode === 'tmp') {
    targets = junk.tmp;
  } else if (mode === 'bak') {
    targets = junk.bak;
  } else if (mode === 'bak_old') {
    targets = junk.bak.filter((f) => /\.bak\.\d+$/i.test(f.name));
  } else if (mode === 'all') {
    targets = [...junk.tmp, ...junk.bak.filter((f) => /\.bak\.\d+$/i.test(f.name))];
  } else {
    const err = new Error('mode must be tmp | bak | bak_old | all');
    err.status = 400;
    throw err;
  }

  if (dryRun) {
    const bytes = targets.reduce((s, t) => s + t.size, 0);
    return {
      dryRun: true,
      mode,
      count: targets.length,
      freed: bytes,
      freedLabel: formatBytes(bytes),
      files: targets.map((t) => t.name),
    };
  }

  const deleted = [];
  const errors = [];
  let freed = 0;
  for (const t of targets) {
    try {
      // only allow files directly under PI_AGENT_DIR
      const abs = safeJoinUnder(PI_AGENT_DIR, [t.name]);
      if (!fs.existsSync(abs)) {
        errors.push({ name: t.name, error: 'not found' });
        continue;
      }
      const size = fs.statSync(abs).size;
      fs.unlinkSync(abs);
      freed += size;
      deleted.push(t.name);
    } catch (e) {
      errors.push({ name: t.name, error: e.message });
    }
  }

  return {
    dryRun: false,
    mode,
    count: deleted.length,
    freed,
    freedLabel: formatBytes(freed),
    files: deleted,
    errors,
  };
}

function getSessionsSummary() {
  const listed = listSessions({ limit: 5, offset: 0 });
  return {
    sessionsDir: listed.sessionsDir,
    exists: listed.exists,
    total: listed.total,
    totalBytes: listed.totalBytes,
    totalSizeLabel: listed.totalSizeLabel || formatBytes(listed.totalBytes || 0),
    groupCount: (listed.groups || []).length,
    recent: (listed.items || []).slice(0, 5).map((it) => ({
      id: it.id,
      cwd: it.cwd,
      sizeLabel: it.sizeLabel,
      mtime: it.mtime,
      relPath: it.relPath,
    })),
  };
}

function getJunkSummary() {
  const j = listJunkFiles();
  return {
    tmpCount: j.tmp.length,
    bakCount: j.bak.length,
    tmpBytes: j.tmpBytes,
    bakBytes: j.bakBytes,
    tmpSizeLabel: j.tmpSizeLabel,
    bakSizeLabel: j.bakSizeLabel,
  };
}

module.exports = {
  SESSIONS_DIR,
  listSessions,
  listAllSessionFiles,
  deleteSessionFiles,
  deleteSessionsOlderThan,
  listJunkFiles,
  cleanupJunk,
  getSessionsSummary,
  getJunkSummary,
  formatBytes,
  clearSessionHeaderCache,
  readSessionHeader,
};
