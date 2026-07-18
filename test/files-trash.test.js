const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-mgr-trash-'));
const agentDir = path.join(tmpRoot, 'agent');
const labRoot = path.join(tmpRoot, 'lab');
const memDir = path.join(labRoot, 'memory');
fs.mkdirSync(memDir, { recursive: true });
fs.mkdirSync(agentDir, { recursive: true });

process.env.PI_AGENT_DIR = agentDir;
process.env.PI_MANAGER_CONFIG = path.join(agentDir, 'pi-manager.json');
process.env.MODELS_FILE = path.join(agentDir, 'models.json');
process.env.SETTINGS_FILE = path.join(agentDir, 'settings.json');
process.env.AGENTS_DIR = path.join(agentDir, 'agents');
process.env.AGENTS_MD_FILE = path.join(agentDir, 'AGENTS.md');

fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({ providers: {} }));
fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({}));
fs.writeFileSync(
  path.join(agentDir, 'pi-manager.json'),
  JSON.stringify({
    workspaces: [
      {
        id: 'lab',
        name: 'lab',
        root: labRoot,
        builtin: false,
        map: { memory: 'memory' },
      },
    ],
    features: { memory: true, knowledge: true },
    editor: { maxFileKB: 512, backup: true },
  })
);

for (const key of Object.keys(require.cache)) {
  if (key.replace(/\\/g, '/').includes('/pi-manager/lib/')) {
    delete require.cache[key];
  }
}

const filesApi = require('../lib/files');

describe('workspace soft delete → .trash', () => {
  after(() => {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('moves file into bucket trash and can restore', () => {
    const rel = 'memory/note.md';
    fs.writeFileSync(path.join(labRoot, rel), '# hello trash\n', 'utf8');
    const r = filesApi.deletePath('lab', rel);
    assert.equal(r.deleted, true);
    assert.equal(r.trashed, true);
    assert.ok(r.trashPath.startsWith('.trash/'), r.trashPath);
    assert.ok(!fs.existsSync(path.join(labRoot, rel)));
    assert.ok(fs.existsSync(path.join(labRoot, r.trashPath, '__meta.json')));
    assert.ok(fs.existsSync(path.join(labRoot, r.trashPath, 'payload')));

    const listed = filesApi.listTrash('lab');
    assert.ok(listed.count >= 1);
    const item = listed.items.find((x) => x.originalRel === rel);
    assert.ok(item);

    const restored = filesApi.restoreTrash('lab', item.stamp);
    assert.equal(restored.restored, true);
    assert.equal(restored.path, rel);
    assert.ok(fs.existsSync(path.join(labRoot, rel)));
    assert.match(fs.readFileSync(path.join(labRoot, rel), 'utf8'), /hello trash/);
  });

  it('purges trash item', () => {
    const rel = 'memory/purge-me.md';
    fs.writeFileSync(path.join(labRoot, rel), 'x\n', 'utf8');
    const r = filesApi.deletePath('lab', rel);
    const purged = filesApi.purgeTrash('lab', r.stamp);
    assert.equal(purged.purged, 1);
    const listed = filesApi.listTrash('lab');
    assert.ok(!listed.items.find((x) => x.stamp === r.stamp));
  });

  it('refuses deleting workspace root', () => {
    assert.throws(() => filesApi.deletePath('lab', ''), /cannot delete workspace root/);
  });

  it('refuses path traversal', () => {
    assert.throws(() => filesApi.deletePath('lab', '../outside'), /invalid path/);
  });
});
