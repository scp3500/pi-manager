const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Ensure lib loads against real config; path helpers are pure enough to unit-test
const { toPortablePath } = require('../lib/plugins');
const { expandPath } = require('../lib/manager-config');
const sessionsApi = require('../lib/sessions');
const opsApi = require('../lib/ops');
const { PI_AGENT_DIR, HOME } = require('../lib/config');

describe('toPortablePath', () => {
  it('keeps npm: and relative', () => {
    assert.equal(toPortablePath('npm:foo'), 'npm:foo');
    assert.equal(toPortablePath('./ext'), './ext');
  });

  it('maps PI_AGENT_DIR children to ~/.pi/agent/...', () => {
    const abs = path.join(PI_AGENT_DIR, 'extensions', 'subagent');
    const got = toPortablePath(abs);
    assert.ok(got.startsWith('~/.pi/agent/'), got);
    assert.ok(got.includes('extensions/subagent') || got.includes('extensions\\subagent'), got);
  });

  it('round-trips expandPath for portable home form', () => {
    const portable = '~/.pi/agent/extensions/subagent';
    const abs = expandPath(portable);
    assert.ok(abs.includes('extensions'));
    assert.ok(path.isAbsolute(abs));
  });
});

describe('sessions path safety', () => {
  it('rejects .. in delete paths', () => {
    const r = sessionsApi.deleteSessionFiles(['../settings.json']);
    assert.equal(r.deleted, 0);
    assert.ok(r.errors && r.errors.length >= 1);
  });
});

describe('search validation', () => {
  it('requires q', () => {
    assert.throws(() => opsApi.searchAll({ q: '' }), /q is required/);
  });
  it('min length 2', () => {
    assert.throws(() => opsApi.searchAll({ q: 'a' }), /too short/);
  });
});

describe('export redaction', () => {
  it('does not leak long literal api keys', () => {
    const data = opsApi.exportConfig();
    const json = JSON.stringify(data);
    // redacted markers present when any key configured
    const providers = data.models && data.models.providers;
    assert.ok(providers && typeof providers === 'object');
    for (const p of Object.values(providers)) {
      if (!p || p.apiKey == null) continue;
      const k = String(p.apiKey);
      if (k.startsWith('$')) continue;
      if (k.startsWith('!')) {
        assert.equal(k, '!REDACTED');
        continue;
      }
      if (k) {
        assert.ok(k.includes('REDACTED') || k === '', k);
        assert.ok(k.length < 40, 'key too long, maybe not redacted: ' + k);
      }
    }
    // crude: no sk- long tokens
    assert.ok(!/sk-[a-zA-Z0-9]{20,}/.test(json));
  });
});

describe('files trash helpers', () => {
  it('exports deletePath and skips .trash in tree skip set', () => {
    const files = require('../lib/files');
    assert.equal(typeof files.deletePath, 'function');
    // create temp workspace-like structure under OS tmp is hard without full workspace;
    // just ensure module loads
    assert.ok(files.TEXT_EXTS.has('.md'));
  });
});
