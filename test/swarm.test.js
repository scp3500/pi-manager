const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-manager-swarm-'));
process.env.PI_AGENT_DIR = root;
process.env.MODELS_FILE = path.join(root, 'models.json');
process.env.SWARM_CONFIG_FILE = path.join(root, 'swarm.json');

for (const modulePath of ['../lib/config', '../lib/models', '../lib/swarm']) {
  delete require.cache[require.resolve(modulePath)];
}

const { PRESETS, readSwarmConfig, writeSwarmConfig } = require('../lib/swarm');

function modelConfig() {
  return {
    providers: {
      configured: {
        apiKey: 'secret-not-for-swarm',
        models: [
          {
            id: 'model-a',
            contextWindow: 100000,
            cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
          },
          { id: 'free-model', cost: { input: 0, output: 0 } },
        ],
      },
    },
  };
}

function config() {
  const roles = PRESETS.map((preset) => ({
    ...preset,
    capabilities: [...preset.capabilities],
    tools: [...preset.tools],
    model: { primary: 'configured/model-a', fallbacks: ['configured/free-model'] },
    contextCapacity: 100000,
    maxActiveMissions: 1,
  }));
  return {
    version: 1,
    roles,
    verification: { executable: 'npm', args: ['test'], timeoutMs: 120000 },
    commitMessage: 'chore: swarm result',
  };
}

describe('swarm manager config', () => {
  before(() => fs.writeFileSync(process.env.MODELS_FILE, JSON.stringify(modelConfig()), 'utf8'));
  beforeEach(() => {
    for (const file of fs.readdirSync(root)) {
      if (file.startsWith('swarm.json')) fs.rmSync(path.join(root, file), { force: true });
    }
  });
  after(() => fs.rmSync(root, { recursive: true, force: true }));

  it('starts empty with four reusable role presets', () => {
    assert.equal(readSwarmConfig().roles.length, 0);
    assert.deepEqual(PRESETS.map((preset) => preset.kind), ['investigator', 'implementer', 'reviewer', 'reviewer']);
  });

  it('stores model references as bounded bindings without copying credentials', () => {
    const saved = writeSwarmConfig(config());
    assert.equal(saved.roles[0].model.primary.provider, 'configured');
    assert.equal(saved.roles[0].model.primary.modelId, 'model-a');
    assert.equal(saved.roles[0].model.primary.costClass, 'paid');
    assert.equal(saved.roles[0].model.fallbacks[0].costClass, 'free');
    const raw = fs.readFileSync(process.env.SWARM_CONFIG_FILE, 'utf8');
    assert.ok(!raw.includes('secret-not-for-swarm'));
    assert.deepEqual(readSwarmConfig(), saved);
  });

  it('rejects missing models and mutating tools', () => {
    const missing = config();
    missing.roles[0].model.primary = 'configured/missing';
    assert.throws(() => writeSwarmConfig(missing), /does not exist/);
    const mutating = config();
    mutating.roles[0].tools.push('bash');
    assert.throws(() => writeSwarmConfig(mutating), /only allow/);
  });

  it('renders a roster editor instead of expanding every role form at once', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    const ui = fs.readFileSync(path.join(__dirname, '..', 'public', 'swarm-ui.js'), 'utf8');
    assert.match(html, /id="swarm-role-list"/);
    assert.match(html, /id="swarm-role-editor"/);
    assert.match(html, /data-swarm-panel="delivery"/);
    assert.match(ui, /data-fallback/);
    assert.doesNotMatch(ui, /multiple>/);
  });

  it('creates a rolling backup on update', () => {
    writeSwarmConfig(config());
    const updated = config();
    updated.commitMessage = 'fix: second';
    writeSwarmConfig(updated);
    assert.ok(fs.existsSync(process.env.SWARM_CONFIG_FILE + '.bak'));
  });
});
