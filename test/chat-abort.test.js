const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { abortOnClientClose } = require('../lib/routes/helpers');

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function collectFirstChunk(req) {
  return new Promise((resolve, reject) => {
    req.on('error', reject);
    req.on('response', (res) => {
      res.once('data', (chunk) => resolve({ res, chunk }));
    });
  });
}

describe('abortOnClientClose', () => {
  it('aborts when the client drops the connection after the body is read', async () => {
    const ac = new AbortController();
    let aborted = false;
    const abortWait = new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('abort timeout')), 2000);
      ac.signal.addEventListener('abort', () => {
        aborted = true;
        clearTimeout(t);
        resolve();
      });
    });

    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('event: meta\ndata: {}\n\n');
        abortOnClientClose(res, ac);
      });
    });

    const port = await listen(server);
    try {
      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path: '/',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      req.write('{"ok":true}');
      req.end();
      await collectFirstChunk(req);
      req.destroy();
      await abortWait;
      assert.equal(ac.signal.aborted, true);
      assert.equal(aborted, true);
    } finally {
      await closeServer(server);
    }
  });

  it('does not abort when the server ends the response normally', async () => {
    const ac = new AbortController();
    let closed = false;

    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        abortOnClientClose(res, ac);
        res.write('event: meta\ndata: {}\n\n');
        res.end();
      });
    });

    const port = await listen(server);
    try {
      await new Promise((resolve, reject) => {
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port,
            path: '/',
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
          },
          (res) => {
            res.on('data', () => {});
            res.on('end', () => {
              closed = true;
              resolve();
            });
          }
        );
        req.on('error', reject);
        req.write('{"ok":true}');
        req.end();
      });
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(closed, true);
      assert.equal(ac.signal.aborted, false);
    } finally {
      await closeServer(server);
    }
  });
});
