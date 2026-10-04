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

  it('isLoopbackHost strips ports and IPv6 brackets', () => {
    assert.equal(isLoopbackHost('127.0.0.1:3001'), true);
    assert.equal(isLoopbackHost('::1'), true);
    assert.equal(isLoopbackHost('[::1]'), true);
    assert.equal(isLoopbackHost('[::1]:3001'), true);
    assert.equal(isLoopbackHost('[::ffff:127.0.0.1]:3001'), true);
    assert.equal(isLoopbackHost('[2001:db8::1]:3001'), false);
  });

  it('allows IPv6 loopback Host header on GET', () => {
    const err = checkRequestSecurity(
      { method: 'GET', headers: { host: '[::1]:3001' } },
      { bindHost: '127.0.0.1', port: 3001 }
    );
    assert.equal(err, null);
  });

  it('allows IPv6 loopback Origin on POST when port matches', () => {
    const err = checkRequestSecurity(
      {
        method: 'POST',
        headers: { host: '[::1]:3001', origin: 'http://[::1]:3001' },
      },
      { bindHost: '127.0.0.1', port: 3001 }
    );
    assert.equal(err, null);
  });

  it('allows same-port loopback Origin with different hostname', () => {
    const err = checkRequestSecurity(
      {
        method: 'POST',
        headers: { host: '127.0.0.1:3001', origin: 'http://localhost:3001' },
      },
      { bindHost: '127.0.0.1', port: 3001 }
    );
    assert.equal(err, null);
  });

  it('rejects other local ports on POST', () => {
    const err = checkRequestSecurity(
      {
        method: 'POST',
        headers: { host: '127.0.0.1:3001', origin: 'http://localhost:3000' },
      },
      { bindHost: '127.0.0.1', port: 3001 }
    );
    assert.ok(err);
  });

  it('allows listed extra origins', () => {
    const prev = process.env.PI_MANAGER_ALLOWED_ORIGINS;
    process.env.PI_MANAGER_ALLOWED_ORIGINS = 'http://localhost:3000';
    try {
      const err = checkRequestSecurity(
        {
          method: 'POST',
          headers: { host: '127.0.0.1:3001', origin: 'http://localhost:3000' },
        },
        { bindHost: '127.0.0.1', port: 3001 }
      );
      assert.equal(err, null);
    } finally {
      if (prev == null) delete process.env.PI_MANAGER_ALLOWED_ORIGINS;
      else process.env.PI_MANAGER_ALLOWED_ORIGINS = prev;
    }
  });

  it('allows POST without Origin', () => {
    const err = checkRequestSecurity(
      { method: 'POST', headers: { host: '127.0.0.1:3001' } },
      { bindHost: '127.0.0.1', port: 3001 }
    );
    assert.equal(err, null);
  });
});
