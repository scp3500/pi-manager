const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { resolveUnderRoot } = require('../lib/path-safety');

describe('path-safety resolveUnderRoot', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-mgr-path-'));
  const root = path.join(tmp, 'root');
  const outside = path.join(tmp, 'outside');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret', 'utf8');
  fs.writeFileSync(path.join(root, 'ok.txt'), 'ok', 'utf8');

  after(() => {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('allows normal relative path', () => {
    const r = resolveUnderRoot(root, 'ok.txt');
    assert.equal(fs.readFileSync(r.abs, 'utf8'), 'ok');
  });

  it('rejects .. traversal', () => {
    assert.throws(() => resolveUnderRoot(root, '../outside/secret.txt'), /invalid path/);
  });

  it('rejects symlink that escapes root when present', () => {
    const link = path.join(root, 'escape-link');
    try {
      fs.symlinkSync(outside, link, 'junction');
    } catch (e) {
      // Windows may need privilege for symlink; junction usually works
      try {
        fs.symlinkSync(outside, link, 'dir');
      } catch (e2) {
        // skip if OS forbids
        return;
      }
    }
    assert.throws(() => resolveUnderRoot(root, 'escape-link/secret.txt'), /escape|invalid|symlink/i);
  });

  it('allowMissing keeps create path under root', () => {
    const r = resolveUnderRoot(root, 'new/file.txt', { allowMissing: true });
    assert.ok(r.abs.includes(path.join('new', 'file.txt')) || r.rel === 'new/file.txt');
  });
});
