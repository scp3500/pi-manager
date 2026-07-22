const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const runtimeApi = require('../lib/runtime');

describe('runtime large jsonl head+tail pending recovery', () => {
  it('keeps early unpaired toolCall when file > PARSE_TAIL_BYTES', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-mgr-rt-'));
    const fp = path.join(dir, 'big.jsonl');
    try {
      const lines = [];
      // timestamps must be within ACTIVE_MS (5min) or open tools are classified stale
      const t0 = new Date(Date.now() - 60_000).toISOString();
      const t1 = new Date(Date.now() - 50_000).toISOString();
      const t2 = new Date(Date.now() - 40_000).toISOString();
      const t3 = new Date(Date.now() - 5_000).toISOString();
      lines.push(
        JSON.stringify({
          type: 'session',
          id: 'sess-tail-test',
          cwd: '/tmp/test',
          timestamp: t0,
        })
      );
      // early long-running toolCall near the head
      lines.push(
        JSON.stringify({
          type: 'message',
          timestamp: t1,
          message: {
            role: 'assistant',
            content: [
              {
                type: 'toolCall',
                id: 'call_early_bash',
                name: 'bash',
                arguments: { command: 'sleep 999' },
              },
            ],
          },
        })
      );
      // pad middle so total > 1.5MB
      const pad = JSON.stringify({
        type: 'message',
        timestamp: t2,
        message: { role: 'user', content: [{ type: 'text', text: 'pad '.repeat(200) }] },
      });
      while (Buffer.byteLength(lines.join('\n') + '\n', 'utf8') < 1.6 * 1024 * 1024) {
        lines.push(pad);
      }
      // recent noise at tail without resolving early tool
      lines.push(
        JSON.stringify({
          type: 'message',
          timestamp: t3,
          message: { role: 'user', content: [{ type: 'text', text: 'status?' }] },
        })
      );
      fs.writeFileSync(fp, lines.join('\n') + '\n', 'utf8');
      assert.ok(fs.statSync(fp).size > 1.5 * 1024 * 1024);

      runtimeApi.clearRuntimeCache();
      const task = runtimeApi.parseSessionTasks(fp);
      assert.ok(!task.error, task.error);
      assert.ok(
        (task.openCount || 0) >= 1,
        'expected open tool from head, openCount=' + task.openCount
      );
      const names = (task.openTools || []).map((t) => t.name);
      assert.ok(names.includes('bash'), 'openTools should include bash, got ' + names.join(','));
    } finally {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      runtimeApi.clearRuntimeCache();
    }
  });
});
