const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const modelsModule = require.resolve('../lib/models');

function runModelsScript(modelsFile) {
  const script = `
    const fs = require('fs');
    const models = require(${JSON.stringify(modelsModule)});
    models.upsertProvider('test-provider', {
      baseUrl: 'https://example.test/v1',
      apiKey: 'test-key',
      authHeader: false
    });
    const savedFalse = JSON.parse(fs.readFileSync(${JSON.stringify(modelsFile)}, 'utf8'));
    if (savedFalse.providers['test-provider'].authHeader !== false) process.exit(11);
    if (models.getProvider('test-provider').authHeader !== false) process.exit(12);
    models.upsertProvider('test-provider', { authHeader: true });
    const savedTrue = JSON.parse(fs.readFileSync(${JSON.stringify(modelsFile)}, 'utf8'));
    if (savedTrue.providers['test-provider'].authHeader !== true) process.exit(13);
  `;
  return spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    env: { ...process.env, MODELS_FILE: modelsFile },
  });
}

describe('provider authHeader persistence', () => {
  it('round-trips explicit false and true values', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-mgr-models-'));
    const modelsFile = path.join(dir, 'models.json');
    try {
      const result = runModelsScript(modelsFile);
      assert.equal(result.status, 0, result.stderr || result.stdout);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
