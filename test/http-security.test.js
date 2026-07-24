const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseBindHost,
  checkRequestSecurity,
  isLoopbackHost,
} = require('../lib/http-security');

describe('http-security', () => {
  it('default bind host is loopback', () => {
    const prev = process.env.PI_MANAGER_HOST;
    delete process.env.PI_MANAGER_HOST;
    delete process.env.HOST;
    assert.equal(parseBindHost(), '127.0.0.1');
    if (prev != null) process.env.PI_MANAGER_HOST = prev;
  });

  it('allows loopback Host on GET', () => {
    const err = checkRequestSecurity(
      { method: 'GET', headers: { host: '127.0.0.1:3001' } },
      { bindHost: '127.0.0.1', port: 3001 }
    );
    assert.equal(err, null);
  });

  it('rejects non-loopback Host by default', () => {
    const err = checkRequestSecurity(
      { method: 'GET', headers: { host: 'evil.example:3001' } },
      { bindHost: '127.0.0.1', port: 3001 }
    );
    assert.ok(err);
  });

  it('rejects foreign Origin on POST', () => {
    const err = checkRequestSecurity(
      {
        method: 'POST',
        headers: { host: '127.0.0.1:3001', origin: 'https://evil.example' },
      },
      { bindHost: '127.0.0.1', port: 3001 }
    );
    assert.ok(err);
  });

  it('isLoopbackHost', () => {
    assert.equal(isLoopbackHost('127.0.0.1'), true);
    assert.equal(isLoopbackHost('localhost'), true);
    assert.equal(isLoopbackHost('192.168.1.1'), false);
  });
});
