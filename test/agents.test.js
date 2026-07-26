const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-mgr-agents-'));
const agentsDir = path.join(tmpRoot, 'agents');
fs.mkdirSync(agentsDir, { recursive: true });

// Isolate AGENTS_DIR before loading modules that capture it at require-time.
process.env.AGENTS_DIR = agentsDir;

function clearModule(rel) {
  const abs = require.resolve(rel);
  delete require.cache[abs];
}

clearModule('../lib/config');
clearModule('../lib/models');
clearModule('../lib/frontmatter');
clearModule('../lib/agent-security');
clearModule('../lib/categories');
clearModule('../lib/agents');

const {
  parseModelSpec,
  composeModelSpec,
  listAgents,
  readAgent,
  writeAgent,
} = require('../lib/agents');
const { AGENTS_DIR } = require('../lib/config');
const { TLM_LEVELS } = require('../lib/models');

function agentPath(name) {
  return path.join(agentsDir, name + '.md');
}

function writeRaw(name, content) {
  fs.writeFileSync(agentPath(name), content, 'utf8');
}

function readRaw(name) {
  return fs.readFileSync(agentPath(name), 'utf8');
}

function wipeAgents() {
  for (const f of fs.readdirSync(agentsDir)) {
    fs.unlinkSync(path.join(agentsDir, f));
  }
}

describe('agents model/thinking split', () => {
  before(() => {
    assert.equal(AGENTS_DIR, agentsDir);
    assert.ok(!agentsDir.includes(path.join('.pi', 'agent', 'agents')));
  });

  after(() => {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  beforeEach(() => {
    wipeAgents();
  });

  describe('parseModelSpec / composeModelSpec', () => {
    it('parses all seven TLM levels', () => {
      for (const level of TLM_LEVELS) {
        assert.deepEqual(parseModelSpec('provider/id:' + level), {
          model: 'provider/id',
          thinking: level,
        });
        assert.equal(composeModelSpec('provider/id', level), 'provider/id:' + level);
      }
    });

    it('handles empty / no colon', () => {
      assert.deepEqual(parseModelSpec(''), { model: '', thinking: '' });
      assert.deepEqual(parseModelSpec(null), { model: '', thinking: '' });
      assert.deepEqual(parseModelSpec('openai/gpt-4'), {
        model: 'openai/gpt-4',
        thinking: '',
      });
      assert.equal(composeModelSpec('openai/gpt-4', ''), 'openai/gpt-4');
      assert.equal(composeModelSpec('openai/gpt-4', null), 'openai/gpt-4');
      assert.equal(composeModelSpec('', ''), '');
    });

    it('splits only on last colon when tail is a level', () => {
      assert.deepEqual(parseModelSpec('foo:variant:high'), {
        model: 'foo:variant',
        thinking: 'high',
      });
      assert.equal(composeModelSpec('foo:variant', 'high'), 'foo:variant:high');
    });

    it('does not split illegal tails', () => {
      assert.deepEqual(parseModelSpec('foo:turbo'), {
        model: 'foo:turbo',
        thinking: '',
      });
      assert.deepEqual(parseModelSpec('provider/id:extreme'), {
        model: 'provider/id:extreme',
        thinking: '',
      });
    });

    it('compose ignores invalid thinking', () => {
      assert.equal(composeModelSpec('m', 'turbo'), 'm');
      assert.equal(composeModelSpec('m', 'HIGH'), 'm');
    });
  });

  describe('write/read/list migration', () => {
    it('writes A-format model:thinking and returns split fields', () => {
      writeAgent(
        'agent-a',
        {
          description: 'A format',
          tools: 'read',
          model: 'prov/m',
          thinking: 'high',
        },
        'body-a\n'
      );
      const raw = readRaw('agent-a');
      // sanitizeFmValue quotes values containing ':'
      assert.match(raw, /^model: "?prov\/m:high"?$/m);
      assert.ok(!/^thinking:/m.test(raw), raw);
      assert.ok(!/^thinkingLevel:/m.test(raw), raw);

      const got = readAgent('agent-a');
      assert.equal(got.model, 'prov/m');
      assert.equal(got.thinking, 'high');
      assert.equal(got.prompt, 'body-a\n');

      const listed = listAgents().find((a) => a.name === 'agent-a');
      assert.ok(listed);
      assert.equal(listed.model, 'prov/m');
      assert.equal(listed.thinking, 'high');
    });

    it('clears thinking when writing empty thinking over suffixed model', () => {
      writeAgent(
        'agent-clear',
        { model: 'prov/m:high', thinking: '' },
        'x\n'
      );
      // First write with suffix already on model
      let raw = readRaw('agent-clear');
      // model had suffix → kept high (suffix priority); empty thinking does not clear suffix
      assert.match(raw, /model: "?prov\/m:high"?/);

      // Explicit clear: pure model + empty thinking
      writeAgent('agent-clear', { model: 'prov/m', thinking: '' }, 'x\n');
      raw = readRaw('agent-clear');
      assert.match(raw, /^model: prov\/m$/m);
      assert.ok(!/^thinking:/m.test(raw), raw);
      assert.ok(!/^thinkingLevel:/m.test(raw), raw);
      const got = readAgent('agent-clear');
      assert.equal(got.model, 'prov/m');
      assert.equal(got.thinking, '');
    });

    it('migrates legacy standalone thinking field on read and write', () => {
      writeRaw(
        'legacy',
        [
          '---',
          'name: legacy',
          'description: old',
          'model: openai/gpt',
          'thinking: medium',
          '---',
          'prompt here\n',
        ].join('\n')
      );
      const before = readAgent('legacy');
      assert.equal(before.model, 'openai/gpt');
      assert.equal(before.thinking, 'medium');

      writeAgent(
        'legacy',
        {
          description: before.description,
          model: before.model,
          thinking: before.thinking,
        },
        before.prompt
      );
      const raw = readRaw('legacy');
      assert.match(raw, /^model: "?openai\/gpt:medium"?$/m);
      assert.ok(!/^thinking:/m.test(raw), raw);
      assert.ok(!/^thinkingLevel:/m.test(raw), raw);

      const after = readAgent('legacy');
      assert.equal(after.model, 'openai/gpt');
      assert.equal(after.thinking, 'medium');
    });

    it('migrates legacy thinkingLevel field', () => {
      writeRaw(
        'legacy-level',
        [
          '---',
          'name: legacy-level',
          'model: p/m',
          'thinkingLevel: low',
          '---',
          'b\n',
        ].join('\n')
      );
      const got = readAgent('legacy-level');
      assert.equal(got.model, 'p/m');
      assert.equal(got.thinking, 'low');
    });

    it('suffix on model wins over independent thinking', () => {
      writeAgent(
        'conflict',
        { model: 'p/m:high', thinking: 'low' },
        'c\n'
      );
      const raw = readRaw('conflict');
      assert.match(raw, /^model: "?p\/m:high"?$/m);
      assert.ok(!/^thinking:/m.test(raw), raw);
      const got = readAgent('conflict');
      assert.equal(got.model, 'p/m');
      assert.equal(got.thinking, 'high');
    });

    it('rejects illegal thinking with must be', () => {
      assert.throws(
        () => writeAgent('bad', { model: 'p/m', thinking: 'turbo' }, 'x'),
        /must be/
      );
      assert.throws(
        () =>
          writeAgent('bad', { model: 'p/m', thinkingLevel: 'turbo' }, 'x'),
        /must be/
      );
      assert.ok(!fs.existsSync(agentPath('bad')));
    });

    it('rejects thinking without model with must be', () => {
      assert.throws(
        () => writeAgent('only-think', { thinking: 'high' }, 'x'),
        /must be/
      );
      assert.throws(
        () => writeAgent('only-think', { model: '', thinking: 'high' }, 'x'),
        /must be/
      );
      assert.ok(!fs.existsSync(agentPath('only-think')));
    });

    it('ignores illegal legacy standalone thinking on read', () => {
      writeRaw(
        'bad-legacy',
        [
          '---',
          'name: bad-legacy',
          'model: p/m',
          'thinking: turbo',
          '---',
          'b\n',
        ].join('\n')
      );
      const got = readAgent('bad-legacy');
      assert.equal(got.model, 'p/m');
      assert.equal(got.thinking, '');
    });

    it('listAgents includes thinking field', () => {
      writeAgent('listed', { model: 'a/b:minimal', description: 'd' }, 'p');
      const row = listAgents().find((a) => a.name === 'listed');
      assert.equal(row.thinking, 'minimal');
      assert.equal(row.model, 'a/b');
    });
  });
});
