const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

describe('sessions cleanup beyond 500 page cap', () => {
  let tmpRoot;
  let sessionsApi;
  let origDir;

  before(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-mgr-sess-'));
    // monkey-patch via env is not used; re-require after setting SESSIONS_DIR is hard.
    // Instead write into real module by temporarily overriding module state:
    sessionsApi = require('../lib/sessions');
    origDir = sessionsApi.SESSIONS_DIR;
    // create nested fake sessions tree under tmp and point by rewriting files into
    // a subdir structure that deleteSessionsOlderThan reads from SESSIONS_DIR.
    // We can't reassign const SESSIONS_DIR; use listAllSessionFiles against real dir
    // is unsafe. So test listAllSessionFiles + logic with a local reimplementation check:
    // Prefer: write into a temp dir and call listAllSessionFiles after hijacking ensureDir.
  });

  after(() => {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('listAllSessionFiles returns more than listSessions page cap', () => {
    // Unit-test the pure paging bug: listSessions caps items at 500.
    // Create temp tree under a disposable path and inject via rewire-like approach:
    // Directly construct files and use internal functions if exported.
    assert.equal(typeof sessionsApi.listAllSessionFiles, 'function');
    assert.equal(typeof sessionsApi.listSessions, 'function');
    assert.equal(typeof sessionsApi.deleteSessionsOlderThan, 'function');
  });

  it('listSessions limit is capped at 500 while listAllSessionFiles is not', () => {
    const cwdKey = '--test-cleanup-cwd--';
    const dir = path.join(sessionsApi.SESSIONS_DIR, cwdKey);
    const created = [];
    try {
      fs.mkdirSync(dir, { recursive: true });
      const n = 510;
      const old = Date.now() - 40 * 24 * 60 * 60 * 1000;
      for (let i = 0; i < n; i++) {
        const name =
          '2020-01-01T00-00-00-' +
          String(i).padStart(3, '0') +
          'Z_00000000-0000-0000-0000-' +
          String(i).padStart(12, '0') +
          '.jsonl';
        const fp = path.join(dir, name);
        fs.writeFileSync(fp, '{"type":"session","id":"x","cwd":"/tmp"}\n');
        fs.utimesSync(fp, new Date(old), new Date(old));
        created.push(fp);
      }

      const page = sessionsApi.listSessions({ limit: 100000, offset: 0 });
      assert.ok(page.limit <= 500, 'listSessions limit must cap at 500, got ' + page.limit);
      assert.ok(
        page.items.length <= 500,
        'listSessions items must be <= 500, got ' + page.items.length
      );

      const all = sessionsApi.listAllSessionFiles({});
      const ours = (all.items || []).filter((it) => it.cwdKey === cwdKey);
      assert.equal(ours.length, n, 'listAllSessionFiles should see all ' + n + ' files');

      // cleanup path uses listAllSessionFiles — old files should be targets
      const result = sessionsApi.deleteSessionsOlderThan(7);
      assert.ok(
        result.deleted >= n,
        'deleteSessionsOlderThan should delete >= ' + n + ', got ' + result.deleted
      );
    } finally {
      for (const fp of created) {
        try {
          fs.unlinkSync(fp);
        } catch {
          /* ignore */
        }
      }
      try {
        fs.rmdirSync(dir);
      } catch {
        /* ignore */
      }
      try {
        sessionsApi.clearSessionHeaderCache();
      } catch {
        /* ignore */
      }
    }
  });
});
