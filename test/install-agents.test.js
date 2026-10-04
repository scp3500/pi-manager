const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-mgr-install-agents-'));
const agentsDir = path.join(tmpRoot, 'agents');
fs.mkdirSync(agentsDir, { recursive: true });

process.env.AGENTS_DIR = agentsDir;

function clearModule(rel) {
  const abs = require.resolve(rel);
  delete require.cache[abs];
}

clearModule('../lib/config');
clearModule('../lib/models');
clearModule('../lib/frontmatter');
clearModule('../lib/agent-security');
clearModule('../lib/categories');
clearModule('../lib/agents');
clearModule('../lib/install');

const install = require('../lib/install');
const { AGENTS_DIR } = require('../lib/config');

describe('install starter agent paths', () => {
  after(() => {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('createStarterAgent writes under AGENTS_DIR and reports that path', () => {
    const first = install.createStarterAgent();
    assert.equal(first.created, true);
    assert.ok(first.path);
    assert.equal(fs.existsSync(first.path), true);
    const prefix = AGENTS_DIR.endsWith(path.sep) ? AGENTS_DIR : AGENTS_DIR + path.sep;
    assert.ok(path.resolve(first.path).startsWith(prefix));

    const second = install.createStarterAgent();
    assert.equal(second.created, false);
    assert.equal(second.path, first.path);
  });

  it('status().agents.dir matches AGENTS_DIR', () => {
    assert.equal(install.status().agents.dir, AGENTS_DIR);
  });
});
