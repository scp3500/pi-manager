const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const { resolvePiConfigDir, LEGACY_CONFIG_DIR, PI_CONFIG_DIR } = require('../lib/config');

const HOME = process.env.USERPROFILE || process.env.HOME || '';
const DEFAULT_CONFIG_DIR = path.join(HOME, '.pi', 'config');

describe('PI_CONFIG_DIR 解析', () => {
  it('显式环境变量优先', () => {
    assert.equal(resolvePiConfigDir('C:\\custom\\cfg', () => true), 'C:\\custom\\cfg');
    assert.equal(resolvePiConfigDir('C:\\custom\\cfg', () => false), 'C:\\custom\\cfg');
  });

  it('未设环境变量时优先认本机历史目录', () => {
    assert.equal(LEGACY_CONFIG_DIR, 'E:\\pi_agent\\pi_config');
    assert.equal(resolvePiConfigDir(undefined, (p) => p === LEGACY_CONFIG_DIR), LEGACY_CONFIG_DIR);
  });

  it('历史目录不存在时落到 ~/.pi/config', () => {
    assert.equal(
      resolvePiConfigDir(undefined, (p) => p === DEFAULT_CONFIG_DIR),
      DEFAULT_CONFIG_DIR
    );
  });

  it('都不存在时也给出可创建的默认路径', () => {
    assert.equal(resolvePiConfigDir(undefined, () => false), DEFAULT_CONFIG_DIR);
  });

  it('实际解析出的目录要么存在，要么就是未设环境变量时的默认值', () => {
    if (process.env.PI_CONFIG_DIR) {
      assert.equal(PI_CONFIG_DIR, process.env.PI_CONFIG_DIR);
      return;
    }
    assert.ok(
      fs.existsSync(PI_CONFIG_DIR) || PI_CONFIG_DIR === DEFAULT_CONFIG_DIR,
      'unexpected resolved dir: ' + PI_CONFIG_DIR
    );
  });
});
