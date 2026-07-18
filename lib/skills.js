const fs = require('fs');
const path = require('path');
const { HOME, PI_AGENT_DIR } = require('./config');
const { readSettingsFile, writeSettingsFile } = require('./settings');
const { expandPath } = require('./manager-config');
const { listWorkspaces } = require('./workspaces');

const DISABLED_DIR_NAME = 'skills-disabled';

function expandSkillPath(p) {
  return expandPath(
    String(p || '')
      .replace(/^~\//, HOME + path.sep)
      .replace(/^~\\/, HOME + path.sep)
  );
}

function parseSkillFrontmatter(content) {
  const out = { name: '', description: '', disableModelInvocation: false };
  if (!content || !content.startsWith('---')) return out;
  const end = content.indexOf('\n---', 3);
  if (end < 0) return out;
  const fm = content.slice(3, end).trim();
  for (const line of fm.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2].trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (key === 'name') out.name = val;
    if (key === 'description') out.description = val;
    if (key === 'disable-model-invocation') {
      out.disableModelInvocation = val === 'true' || val === true || val === 'yes';
    }
  }
  return out;
}

function isSkillsRootDir(dir) {
  const base = path.basename(dir).toLowerCase();
  return base === 'skills' || base === 'skills-disabled';
}

function disabledSiblingDir(skillsDir) {
  // ~/.pi/agent/skills -> ~/.pi/agent/skills-disabled
  return path.join(path.dirname(skillsDir), DISABLED_DIR_NAME);
}

function enabledSiblingDir(disabledDir) {
  // ~/.pi/agent/skills-disabled -> ~/.pi/agent/skills
  return path.join(path.dirname(disabledDir), 'skills');
}

function readSkillMeta(skillDir, folderName) {
  const skillMd = path.join(skillDir, 'SKILL.md');
  let name = folderName;
  let description = '';
  let hasSkillMd = false;
  let disableModelInvocation = false;
  if (fs.existsSync(skillMd)) {
    hasSkillMd = true;
    try {
      const raw = fs.readFileSync(skillMd, 'utf8');
      const fm = parseSkillFrontmatter(raw);
      if (fm.name) name = fm.name;
      if (fm.description) description = fm.description;
      disableModelInvocation = !!fm.disableModelInvocation;
    } catch {
      /* ignore */
    }
  }
  return { name, description: description.slice(0, 300), hasSkillMd, disableModelInvocation };
}

function scanSkillsDir(dir, { enabled }) {
  const results = [];
  if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return results;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    if (ent.name.startsWith('.')) continue;
    if (ent.name === DISABLED_DIR_NAME) continue;
    const skillDir = path.join(dir, ent.name);
    const meta = readSkillMeta(skillDir, ent.name);
    results.push({
      id: ent.name,
      name: meta.name,
      description: meta.description,
      path: skillDir,
      hasSkillMd: meta.hasSkillMd,
      sourceDir: dir,
      enabled: !!enabled,
      disableModelInvocation: meta.disableModelInvocation,
      canToggle: isSkillsRootDir(dir) || path.basename(dir).toLowerCase() === DISABLED_DIR_NAME,
    });
  }
  return results;
}

function collectSkillDirs() {
  const dirs = new Set();
  const settings = readSettingsFile();
  const fromSettings = Array.isArray(settings.skills) ? settings.skills : [];
  for (const p of fromSettings) {
    dirs.add(expandSkillPath(p));
  }
  try {
    const ws = listWorkspaces();
    for (const w of ws.workspaces) {
      if (w.mapped && w.mapped.skills && w.mapped.skills.exists) {
        dirs.add(w.mapped.skills.path);
      }
    }
  } catch {
    /* ignore */
  }
  dirs.add(path.join(PI_AGENT_DIR, 'skills'));
  dirs.add(path.join(HOME, '.agents', 'skills'));
  return [...dirs].filter(Boolean);
}

function collectDisabledDirs(enabledDirs) {
  const dirs = new Set();
  for (const d of enabledDirs) {
    if (path.basename(d).toLowerCase() === 'skills') {
      dirs.add(disabledSiblingDir(d));
    }
  }
  // always include default locations
  dirs.add(path.join(PI_AGENT_DIR, DISABLED_DIR_NAME));
  dirs.add(path.join(HOME, '.agents', DISABLED_DIR_NAME));
  return [...dirs];
}

function listSkills() {
  const settings = readSettingsFile();
  const skillPaths = Array.isArray(settings.skills) ? settings.skills.map(String) : [];
  const enableSkillCommands = settings.enableSkillCommands !== false;
  const enabledDirs = collectSkillDirs();
  const disabledDirs = collectDisabledDirs(enabledDirs);
  const seen = new Set();
  const skills = [];

  for (const dir of enabledDirs) {
    for (const s of scanSkillsDir(dir, { enabled: true })) {
      const key = s.path.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      skills.push(s);
    }
  }
  for (const dir of disabledDirs) {
    for (const s of scanSkillsDir(dir, { enabled: false })) {
      const key = s.path.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      skills.push(s);
    }
  }

  skills.sort((a, b) => {
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return {
    skills,
    settings: {
      skills: skillPaths,
      enableSkillCommands,
    },
    scannedDirs: [
      ...enabledDirs.map((d) => ({ path: d, exists: fs.existsSync(d), role: 'enabled' })),
      ...disabledDirs.map((d) => ({ path: d, exists: fs.existsSync(d), role: 'disabled' })),
    ],
    note:
      '单个 skill 开关通过移动目录实现：启用=skills/<name>，禁用=skills-disabled/<name>。Pi 无官方 per-skill 配置项。',
  };
}

function updateSkillSettings(patch = {}) {
  const s = readSettingsFile();
  if (patch.skills !== undefined) {
    if (!Array.isArray(patch.skills)) throw new Error('skills must be an array');
    s.skills = patch.skills.map((x) => String(x).trim()).filter(Boolean);
  }
  if (patch.enableSkillCommands !== undefined) {
    s.enableSkillCommands = !!patch.enableSkillCommands;
  }
  writeSettingsFile(s);
  return listSkills();
}

function safeSkillFolderName(name) {
  const n = String(name || '').trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(n)) {
    throw new Error('invalid skill id');
  }
  if (n.includes('..') || n.includes('/') || n.includes('\\')) {
    throw new Error('invalid skill id');
  }
  return n;
}

function findSkillById(id) {
  const list = listSkills();
  const s = list.skills.find((x) => x.id === id || x.name === id);
  if (!s) throw new Error('not found');
  return s;
}

/**
 * Toggle skill by moving between skills/ and skills-disabled/
 * @param {string} id folder name
 * @param {boolean} enabled
 */
function setSkillEnabled(id, enabled) {
  const folder = safeSkillFolderName(id);
  const current = findSkillById(folder);
  if (!current.canToggle) {
    throw new Error('该 skill 不在可管理的 skills 目录中，无法开关');
  }
  if (current.enabled === !!enabled) {
    return listSkills();
  }

  const from = current.path;
  if (!fs.existsSync(from)) throw new Error('not found');

  let toDir;
  if (enabled) {
    // disabled -> skills
    if (path.basename(current.sourceDir).toLowerCase() === DISABLED_DIR_NAME) {
      toDir = enabledSiblingDir(current.sourceDir);
    } else {
      toDir = path.join(path.dirname(current.sourceDir), 'skills');
    }
  } else {
    // enabled -> skills-disabled
    if (path.basename(current.sourceDir).toLowerCase() === 'skills') {
      toDir = disabledSiblingDir(current.sourceDir);
    } else {
      toDir = path.join(path.dirname(current.sourceDir), DISABLED_DIR_NAME);
    }
  }

  if (!fs.existsSync(toDir)) {
    fs.mkdirSync(toDir, { recursive: true });
  }
  const to = path.join(toDir, folder);
  if (fs.existsSync(to)) {
    throw new Error('target already exists: ' + to);
  }

  // safety: both sides under same parent of agent/skills
  const fromParent = path.resolve(path.dirname(from));
  const toParent = path.resolve(toDir);
  // must stay under same grandparent (agent dir)
  const fromGrand = path.resolve(path.dirname(fromParent));
  const toGrand = path.resolve(path.dirname(toParent));
  if (fromGrand !== toGrand) {
    throw new Error('refuse to move across different roots');
  }

  fs.renameSync(from, to);
  return listSkills();
}

module.exports = {
  listSkills,
  updateSkillSettings,
  setSkillEnabled,
  scanSkillsDir,
  DISABLED_DIR_NAME,
};
