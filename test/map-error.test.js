const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { mapError } = require('../lib/routes/helpers');

function fakeRes() {
  return {
    statusCode: 0,
    body: '',
    writeHead(code, headers) {
      this.statusCode = code;
      this.headers = headers;
    },
    end(body) {
      this.body = body || '';
    },
  };
}

describe('mapError', () => {
  function quiet(fn) {
    const prev = console.error;
    console.error = () => {};
    try {
      return fn();
    } finally {
      console.error = prev;
    }
  }

  it('uses e.status when it is an HTTP error code', () => {
    const a = fakeRes();
    mapError(a, Object.assign(new Error('conflict'), { status: 409 }));
    assert.equal(a.statusCode, 409);

    const b = fakeRes();
    mapError(b, Object.assign(new Error('bad'), { status: 400 }));
    assert.equal(b.statusCode, 400);
  });

  it('keeps 5xx diagnostics for loopback requests only', () => {
    quiet(() => {
      const local = fakeRes();
      local.req = { socket: { remoteAddress: '127.0.0.1' } };
      mapError(local, Object.assign(new Error('session file corrupt: boom'), { status: 500 }));
      assert.equal(local.statusCode, 500);
      assert.match(JSON.parse(local.body).error, /corrupt/);

      const ipv6Local = fakeRes();
      ipv6Local.req = { socket: { remoteAddress: '::1' } };
      mapError(ipv6Local, Object.assign(new Error('cannot read sessions dir'), { status: 500 }));
      assert.match(JSON.parse(ipv6Local.body).error, /cannot read/);

      const remote = fakeRes();
      remote.req = { socket: { remoteAddress: '192.168.1.20' } };
      mapError(remote, Object.assign(new Error('internal path E:\\secret'), { status: 500 }));
      assert.equal(remote.statusCode, 500);
      assert.equal(JSON.parse(remote.body).error, 'Internal error');

      const unknown = fakeRes();
      mapError(unknown, Object.assign(new Error('no socket info'), { status: 503 }));
      assert.equal(JSON.parse(unknown.body).error, 'Internal error');
    });
  });

  it('falls back to message matching and 500', () => {
    const a = fakeRes();
    mapError(a, new Error('not found'));
    assert.equal(a.statusCode, 404);

    const b = fakeRes();
    const err = console.error;
    console.error = () => {};
    try {
      mapError(b, new Error('totally unexpected boom'));
      assert.equal(b.statusCode, 500);
    } finally {
      console.error = err;
    }
  });
});
