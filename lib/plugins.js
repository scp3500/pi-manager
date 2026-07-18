const fs = require('fs');
const path = require('path');
const { HOME, PI_AGENT_DIR } = require('./config');
const { readSettingsFile, writeSettingsFile } = require('./settings');
const { expandPath } = require('./manager-config');

/**
 * Convert absolute/user paths to portable form for settings.json.
 * - under PI_AGENT_DIR → ~/.pi/agent/<rel>
 * - under HOME → ~/<rel>
 * - npm: and relative ./ keep as-is
 */
function toPortablePath(p) {
  const raw = String(p || '').trim();
  if (!raw) return '';
  if (raw.startsWith('npm:') || raw.startsWith('./') || raw.startsWith('../')) return raw;
  // already portable home form
  if (raw.startsWith('~/') || raw === '~') return raw.replace(/\\/g, '/');
  if (raw.startsWith('~\\')) return '~/' + raw.slice(2).replace(/\\/g, '/');

  let abs;
  try {
    abs = expandPath(raw);
  } catch {
    return raw.replace(/\\/g, '/');
  }
  const absN = path.resolve(abs);
  const piN = path.resolve(PI_AGENT_DIR);
  const homeN = path.resolve(HOME || '');

  const prefix = (root) => {
    const r = root.endsWith(path.sep) ? root : root + path.sep;
    return absN === root || absN.startsWith(r);
  };

  if (piN && prefix(piN)) {
    const rel = path.relative(piN, absN).replace(/\\/g, '/');
    return rel ? '~/.pi/agent/' + rel : '~/.pi/agent';
  }
  if (homeN && prefix(homeN)) {
    const rel = path.relative(homeN, absN).replace(/\\/g, '/');
    return rel ? '~/' + rel : '~';
  }
  return absN.replace(/\\/g, '/');
}

function expandPluginPath(p) {
  const raw = String(p || '').trim();
  if (!raw) return '';
  if (raw.startsWith('npm:')) return raw;
  // ~/.pi/agent/... is under HOME
  return expandPath(raw);
}

function listLocalExtensions() {
  const dir = path.join(PI_AGENT_DIR, 'extensions');
  const out = [];
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    return { dir, exists: false, items: out };
  }
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { dir, exists: true, items: out };
  }
  for (const ent of entries) {
    if (ent.name.startsWith('.')) continue;
    const full = path.join(dir, ent.name);
    out.push({
      name: ent.name,
      path: full,
      portable: toPortablePath(full),
      type: ent.isDirectory() ? 'dir' : 'file',
    });
  }
  return { dir, exists: true, items: out };
}

function listPlugins() {
  const s = readSettingsFile();
  const packages = Array.isArray(s.packages) ? s.packages.map(String) : [];
  const rawExt = Array.isArray(s.extensions) ? s.extensions.map(String) : [];
  const extensions = rawExt.map((p) => toPortablePath(p));
  const needsNormalize = rawExt.some((p, i) => p !== extensions[i]);
  return {
    packages,
    extensions,
    extensionsRaw: rawExt,
    needsNormalize,
    local: listLocalExtensions(),
  };
}

/**
 * @param {{packages?: string[], extensions?: string[]}} patch
 */
function updatePlugins(patch = {}) {
  const s = readSettingsFile();
  if (patch.packages !== undefined) {
    if (!Array.isArray(patch.packages)) throw new Error('packages must be an array');
    s.packages = patch.packages.map((x) => String(x).trim()).filter(Boolean);
  }
  if (patch.extensions !== undefined) {
    if (!Array.isArray(patch.extensions)) throw new Error('extensions must be an array');
    s.extensions = patch.extensions
      .map((x) => String(x).trim())
      .filter(Boolean)
      .map((p) => {
        if (p.startsWith('npm:') || p.startsWith('./')) return p;
        return toPortablePath(p);
      });
  }
  writeSettingsFile(s);
  return listPlugins();
}

/** Rewrite extensions (and skills paths) in settings to portable form. */
function normalizeSettingsPaths() {
  const s = readSettingsFile();
  let changed = false;
  if (Array.isArray(s.extensions)) {
    const next = s.extensions.map((p) => toPortablePath(String(p)));
    if (JSON.stringify(next) !== JSON.stringify(s.extensions)) {
      s.extensions = next;
      changed = true;
    }
  }
  if (Array.isArray(s.skills)) {
    const next = s.skills.map((p) => {
      const t = String(p).trim();
      if (t.startsWith('npm:') || t.startsWith('./')) return t;
      return toPortablePath(t);
    });
    if (JSON.stringify(next) !== JSON.stringify(s.skills)) {
      s.skills = next;
      changed = true;
    }
  }
  if (changed) writeSettingsFile(s);
  return { changed, plugins: listPlugins(), skills: s.skills || [] };
}

module.exports = {
  listPlugins,
  updatePlugins,
  listLocalExtensions,
  toPortablePath,
  expandPluginPath,
  normalizeSettingsPaths,
};
