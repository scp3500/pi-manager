const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * MUST isolate sessions dir: never touch real ~/.pi/agent/sessions.
 */
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-mgr-sess-'));
const sessionsDir = path.join(tmpRoot, 'sessions');
fs.mkdirSync(sessionsDir, { recursive: true });

const realSessionsHint = path.join(
  process.env.USERPROFILE || process.env.HOME || '',
  '.pi',
  'agent',
  'sessions'
);

process.env.SESSIONS_DIR = sessionsDir;
process.env.PI_AGENT_DIR = path.join(tmpRoot, 'agent');

for (const key of Object.keys(require.cache)) {
  const n = key.replace(/\\/g, '/');
  if (n.includes('/pi-manager/lib/')) {
    delete require.cache[key];
  }
}

const sessionsApi = require('../lib/sessions');

describe('sessions cleanup beyond 500 page cap (isolated tmp)', () => {
  after(() => {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('uses env SESSIONS_DIR, not real agent sessions', () => {
    assert.equal(sessionsApi.getSessionsDir(), sessionsDir);
    assert.ok(!sessionsApi.getSessionsDir().startsWith(realSessionsHint) || realSessionsHint === sessionsDir);
  });

  it('listSessions limit is capped at 500 while listAllSessionFiles is not', () => {
    const cwdKey = '--test-cleanup-cwd--';
    const dir = path.join(sessionsDir, cwdKey);
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
    }

    // real dir must not gain our cwdKey
    if (fs.existsSync(realSessionsHint) && realSessionsHint !== sessionsDir) {
      assert.ok(
        !fs.existsSync(path.join(realSessionsHint, cwdKey)),
        'must not write into real sessions dir'
      );
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

    const result = sessionsApi.deleteSessionsOlderThan(7);
    assert.ok(
      result.deleted >= n,
      'deleteSessionsOlderThan should delete >= ' + n + ', got ' + result.deleted
    );

    const left = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')) : [];
    assert.equal(left.length, 0, 'tmp session files should be gone');

    if (fs.existsSync(realSessionsHint) && realSessionsHint !== sessionsDir) {
      assert.ok(
        !fs.existsSync(path.join(realSessionsHint, cwdKey)),
        'cleanup must not create real sessions cwdKey'
      );
    }

    try {
      sessionsApi.clearSessionHeaderCache();
    } catch {
      /* ignore */
    }
  });
});
