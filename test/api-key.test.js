const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { resolveApiKey, clearApiKeyCache } = require('../lib/api-key');

const CMD_ABC = '!node -e "console.log(\'abc\')"';
const CMD_NOW = '!node -e "console.log(Date.now())"';
const CMD_FAIL = '!node -e "process.exit(1)"';
const CMD_SLOW = '!node -e "setTimeout(()=>console.log(1),300)"';
const CMD_BIG = '!node -e "process.stdout.write(\'k\'.repeat(1200000))"';

describe('resolveApiKey', () => {
  beforeEach(() => {
    clearApiKeyCache();
  });

  it('returns plain strings and env vars', async () => {
    assert.equal(await resolveApiKey('plain'), 'plain');
    assert.equal(await resolveApiKey(''), '');
    assert.equal(await resolveApiKey(null), '');
    process.env.PI_MGR_APIKEY_TEST = 'from-env';
    assert.equal(await resolveApiKey('$PI_MGR_APIKEY_TEST'), 'from-env');
    delete process.env.PI_MGR_APIKEY_TEST;
  });

  it('runs !command and returns stdout', async () => {
    assert.equal(await resolveApiKey(CMD_ABC), 'abc');
  });

  it('caches successful command output', async () => {
    const a = await resolveApiKey(CMD_NOW);
    const b = await resolveApiKey(CMD_NOW);
    assert.equal(a, b);
    await new Promise((r) => setTimeout(r, 5));
    clearApiKeyCache();
    const c = await resolveApiKey(CMD_NOW);
    assert.notEqual(c, a);
  });

  it('dedupes concurrent calls for the same command', async () => {
    const [a, b] = await Promise.all([resolveApiKey(CMD_NOW), resolveApiKey(CMD_NOW)]);
    assert.equal(a, b);
  });

  it('does not cache failures', async () => {
    await assert.rejects(() => resolveApiKey(CMD_FAIL));
    await assert.rejects(() => resolveApiKey(CMD_FAIL));
  });

  it('does not block the event loop', async () => {
    let ticks = 0;
    const timer = setInterval(() => {
      ticks += 1;
    }, 20);
    try {
      const out = await resolveApiKey(CMD_SLOW);
      assert.equal(out, '1');
      assert.ok(ticks >= 5, 'expected event-loop ticks, got ' + ticks);
    } finally {
      clearInterval(timer);
    }
  });

  it('accepts command output larger than the default 1MB maxBuffer', async () => {
    const out = await resolveApiKey(CMD_BIG);
    assert.equal(out.length, 1200000);
  });
});
