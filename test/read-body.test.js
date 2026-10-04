const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { readBody, BODY_LIMIT } = require('../lib/routes/helpers');

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function startBodyServer() {
  const server = http.createServer(async (req, res) => {
    try {
      const body = await readBody(req);
      const json = JSON.stringify(body);
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(json),
      });
      res.end(json);
    } catch (e) {
      const code = e && e.status ? e.status : 500;
      const json = JSON.stringify({ error: e.message });
      res.writeHead(code, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(json),
      });
      res.end(json);
    }
  });
  return server;
}

function request(port, { method = 'POST', body, splitAt } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/',
        method,
        headers: { 'Content-Type': 'application/json' },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      }
    );
    req.on('error', reject);
    if (body == null) {
      req.end();
      return;
    }
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
    if (splitAt == null) {
      req.end(buf);
      return;
    }
    req.write(buf.subarray(0, splitAt));
    setTimeout(() => req.end(buf.subarray(splitAt)), 20);
  });
}

describe('readBody', () => {
  it('reassembles UTF-8 characters split across chunks', async () => {
    const server = startBodyServer();
    const port = await listen(server);
    try {
      const s = '中文测试'.repeat(10);
      const payload = JSON.stringify({ s });
      const buf = Buffer.from(payload, 'utf8');
      const splitAt = Buffer.byteLength('{"s":"') + 1;
      assert.ok(splitAt > 0 && splitAt < buf.length);
      const r = await request(port, { body: buf, splitAt });
      assert.equal(r.status, 200);
      assert.equal(JSON.parse(r.body).s, s);
    } finally {
      await closeServer(server);
    }
  });

  it('rejects by byte size even when character count is under the limit', async () => {
    const server = startBodyServer();
    const port = await listen(server);
    try {
      const prefix = '{"s":"';
      const suffix = '"}';
      const overhead = Buffer.byteLength(prefix) + Buffer.byteLength(suffix);
      const n = Math.floor((BODY_LIMIT - overhead) / 3) + 1;
      const payload = prefix + '中'.repeat(n) + suffix;
      assert.ok(Buffer.byteLength(payload, 'utf8') > BODY_LIMIT);
      assert.ok(payload.length < BODY_LIMIT);
      const r = await request(port, { body: payload });
      assert.equal(r.status, 413);
    } finally {
      await closeServer(server);
    }
  });

  it('returns {} for empty body', async () => {
    const server = startBodyServer();
    const port = await listen(server);
    try {
      const r = await request(port, {});
      assert.equal(r.status, 200);
      assert.deepEqual(JSON.parse(r.body), {});
    } finally {
      await closeServer(server);
    }
  });

  it('returns 400 for invalid JSON', async () => {
    const server = startBodyServer();
    const port = await listen(server);
    try {
      const r = await request(port, { body: '{not json' });
      assert.equal(r.status, 400);
    } finally {
      await closeServer(server);
    }
  });
});
