const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { detectMigrations, applyAzureRename } = require('../lib/migrations');

const OLD = 'azure-openai-responses';
const NEW = 'azure';
const migrationsModule = require.resolve('../lib/migrations');

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pi-mgr-migr-'));
}

function writeJson(file, obj, indent = 2) {
  fs.writeFileSync(file, JSON.stringify(obj, null, indent) + '\n', 'utf8');
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function raw(file) {
  return fs.readFileSync(file, 'utf8');
}

/**
 * 每个用例一个临时目录 + 显式传三个路径，绝不碰真实 ~/.pi。
 * files: { models, settings, auth } 任一为 null 表示不创建该文件。
 * 值可以是对象（按 indent 写）或字符串（原样写，用来造坏 JSON）。
 */
function fixture(files = {}) {
  const dir = mkTmp();
  const paths = {
    dir,
    modelsFile: path.join(dir, 'models.json'),
    settingsFile: path.join(dir, 'settings.json'),
    authFile: path.join(dir, 'auth.json'),
  };
  const pairs = [
    ['models', paths.modelsFile],
    ['settings', paths.settingsFile],
    ['auth', paths.authFile],
  ];
  for (const [key, file] of pairs) {
    const v = files[key];
    if (v == null) continue;
    if (typeof v === 'string') fs.writeFileSync(file, v, 'utf8');
    else writeJson(file, v, files.indent || 2);
  }
  return paths;
}

function cleanup(paths) {
  fs.rmSync(paths.dir, { recursive: true, force: true });
}

const fullFixture = (indent = 2) =>
  fixture({
    indent,
    models: {
      providers: {
        keep: { baseUrl: 'https://keep.test/v1', api: 'openai-completions' },
        [OLD]: { baseUrl: 'https://azure.test', api: OLD, models: [{ id: 'gpt-4o' }] },
        zzz: { api: 'anthropic-messages' },
      },
    },
    settings: {
      defaultProvider: OLD,
      defaultModel: 'gpt-4o',
      enabledModels: [OLD, OLD + '/gpt-4o', 'keep/other'],
      modelThinkingLevels: { [OLD]: 'high', [OLD + '/gpt-4o']: 'low', 'keep/other': 'medium' },
      someOtherKey: { a: 1 },
    },
    auth: { [OLD]: { type: 'oauth', access: 'x' }, antigravity: { type: 'oauth' } },
  });

describe('detectMigrations 检测', () => {
  it('models.json providers 键命中', () => {
    const p = fixture({ models: { providers: { [OLD]: { api: OLD }, keep: {} } } });
    try {
      const r = detectMigrations(p);
      assert.equal(r.count, 1);
      const it0 = r.items[0];
      assert.equal(it0.id, 'models:providers:' + OLD);
      assert.equal(it0.file, p.modelsFile);
      assert.equal(it0.where, 'models.json 的 providers 键');
      assert.equal(it0.from, OLD);
      assert.equal(it0.to, NEW);
      assert.equal(it0.canAutoFix, true);
      assert.match(it0.detail, /azure/);
    } finally {
      cleanup(p);
    }
  });

  it('settings.json 三个位置各自命中（defaultProvider / enabledModels / modelThinkingLevels）', () => {
    const p = fixture({
      settings: {
        defaultProvider: OLD,
        enabledModels: [OLD, OLD + '/gpt-4o', 'keep/other'],
        modelThinkingLevels: { [OLD]: 'high', [OLD + '/gpt-4o']: 'low' },
      },
    });
    try {
      const r = detectMigrations(p);
      assert.equal(r.count, 5);
      const ids = r.items.map((i) => i.id);
      assert.ok(ids.includes('settings:defaultProvider'));
      assert.ok(ids.includes('settings:enabledModels:' + OLD));
      assert.ok(ids.includes('settings:enabledModels:' + OLD + '/gpt-4o'));
      assert.ok(ids.includes('settings:modelThinkingLevels:' + OLD));
      assert.ok(ids.includes('settings:modelThinkingLevels:' + OLD + '/gpt-4o'));
      for (const it of r.items) assert.equal(it.file, p.settingsFile);

      const enabled = r.items.find((i) => i.id === 'settings:enabledModels:' + OLD + '/gpt-4o');
      assert.equal(enabled.from, OLD + '/gpt-4o');
      assert.equal(enabled.to, NEW + '/gpt-4o');
      assert.equal(enabled.canAutoFix, true);

      const dp = r.items.find((i) => i.id === 'settings:defaultProvider');
      assert.equal(dp.to, NEW);
    } finally {
      cleanup(p);
    }
  });

  it('auth.json 顶层键命中', () => {
    const p = fixture({ auth: { [OLD]: { type: 'oauth' }, antigravity: { type: 'oauth' } } });
    try {
      const r = detectMigrations(p);
      assert.equal(r.count, 1);
      assert.deepEqual(
        { id: r.items[0].id, file: r.items[0].file, where: r.items[0].where },
        { id: 'auth:' + OLD, file: p.authFile, where: 'auth.json 的顶层键' }
      );
      assert.equal(r.items[0].canAutoFix, true);
      assert.deepEqual(r.warnings, []);
    } finally {
      cleanup(p);
    }
  });

  it('本机现状：只有 antigravity 键时 count 为 0（不报错、不显示空框）', () => {
    const p = fixture({
      models: { providers: { antigravity: { api: 'google-generative-ai' } } },
      settings: { defaultProvider: 'antigravity' },
      auth: { antigravity: { type: 'oauth' } },
    });
    try {
      const r = detectMigrations(p);
      assert.deepEqual(r, { items: [], count: 0, warnings: [] });
    } finally {
      cleanup(p);
    }
  });

  it('文件缺失 / 空文件 / JSON 损坏都不抛，warnings 有记录', () => {
    const missing = fixture({});
    try {
      assert.deepEqual(detectMigrations(missing), { items: [], count: 0, warnings: [] });
      const applied = applyAzureRename(missing);
      assert.deepEqual(applied, { ok: true, changed: [], conflicts: [], skipped: [] });
      // 文件缺失时不写、不创建任何文件
      assert.deepEqual(fs.readdirSync(missing.dir), []);
    } finally {
      cleanup(missing);
    }

    const broken = fixture({
      models: '{ "providers": {',
      settings: '',
      auth: '{ "azure-openai-responses": ',
    });
    try {
      const r = detectMigrations(broken);
      assert.equal(r.count, 0);
      assert.equal(r.warnings.length, 2);
      assert.match(r.warnings.join('\n'), /models\.json 不是合法 JSON/);
      assert.match(r.warnings.join('\n'), /auth\.json 不是合法 JSON/);
    } finally {
      cleanup(broken);
    }
  });

  it('非 JSON 对象结构（数组 / 字符串 / providers 是数组）不崩', () => {
    const p = fixture({ models: '[]', settings: '"nope"', auth: 'null' });
    try {
      const r = detectMigrations(p);
      assert.equal(r.count, 0);
      assert.equal(r.warnings.length, 3);
    } finally {
      cleanup(p);
    }

    const q = fixture({ models: { providers: [OLD] }, settings: { enabledModels: 'oops' } });
    try {
      const before = { m: raw(q.modelsFile), s: raw(q.settingsFile) };
      const r = detectMigrations(q);
      assert.equal(r.count, 0);
      assert.equal(applyAzureRename(q).changed.length, 0);
      assert.equal(raw(q.modelsFile), before.m);
      assert.equal(raw(q.settingsFile), before.s);
      assert.ok(!fs.existsSync(q.modelsFile + '.bak'));
    } finally {
      cleanup(q);
    }
  });

  it('目标键已存在时 canAutoFix 为 false', () => {
    const p = fixture({
      models: { providers: { [OLD]: {}, [NEW]: {} } },
      settings: { enabledModels: [NEW, OLD], modelThinkingLevels: { [NEW]: 'high', [OLD]: 'low' } },
      auth: { [OLD]: { type: 'oauth' }, [NEW]: { type: 'oauth' } },
    });
    try {
      const r = detectMigrations(p);
      for (const it of r.items) assert.equal(it.canAutoFix, false, it.id);
      assert.deepEqual(
        r.items.map((i) => i.id).sort(),
        ['auth:' + OLD, 'models:providers:' + OLD].concat([
          'settings:enabledModels:' + OLD,
          'settings:modelThinkingLevels:' + OLD,
        ]).sort()
      );
    } finally {
      cleanup(p);
    }
  });
});

describe('applyAzureRename 迁移', () => {
  it('三个文件都改名成功，其它键与缩进风格保持，.bak 生成', () => {
    const p = fullFixture(4);
    try {
      const before = {
        models: raw(p.modelsFile),
        settings: raw(p.settingsFile),
        auth: raw(p.authFile),
      };
      assert.match(before.models, /\n {4}"providers"/);

      const r = applyAzureRename(p);
      assert.equal(r.ok, true);
      assert.equal(r.conflicts.length, 0);
      assert.equal(r.skipped.length, 0);
      assert.equal(r.changed.length, 7);

      const models = readJson(p.modelsFile);
      assert.ok(!(OLD in models.providers));
      assert.ok(models.providers[NEW]);
      assert.equal(models.providers[NEW].api, OLD); // api 协议名不变
      assert.deepEqual(models.providers[NEW].models, [{ id: 'gpt-4o' }]);
      assert.deepEqual(models.providers.keep, {
        baseUrl: 'https://keep.test/v1',
        api: 'openai-completions',
      });
      assert.deepEqual(models.providers.zzz, { api: 'anthropic-messages' });
      // 键改名后位置保持（keep, azure, zzz）
      assert.deepEqual(Object.keys(models.providers), ['keep', NEW, 'zzz']);
      // 缩进风格沿用原文件（4 空格）
      assert.match(raw(p.modelsFile), /\n {4}"providers"/);

      const settings = readJson(p.settingsFile);
      assert.equal(settings.defaultProvider, NEW);
      assert.deepEqual(settings.enabledModels, [NEW, NEW + '/gpt-4o', 'keep/other']);
      assert.deepEqual(settings.modelThinkingLevels, {
        [NEW]: 'high',
        [NEW + '/gpt-4o']: 'low',
        'keep/other': 'medium',
      });
      assert.equal(settings.defaultModel, 'gpt-4o');
      assert.deepEqual(settings.someOtherKey, { a: 1 });
      assert.match(raw(p.settingsFile), /\n {4}"defaultProvider"/);

      const auth = readJson(p.authFile);
      assert.ok(!(OLD in auth));
      assert.deepEqual(auth[NEW], { type: 'oauth', access: 'x' });
      assert.deepEqual(auth.antigravity, { type: 'oauth' });

      for (const f of [p.modelsFile, p.settingsFile, p.authFile]) {
        assert.ok(fs.existsSync(f + '.bak'), f + '.bak 未生成');
      }
      assert.equal(raw(p.modelsFile + '.bak'), before.models);
      assert.equal(raw(p.authFile + '.bak'), before.auth);
    } finally {
      cleanup(p);
    }
  });

  it('auth.json 写回后权限位不变', () => {
    const p = fixture({ auth: { [OLD]: { type: 'oauth' }, keep: 1 } });
    try {
      fs.chmodSync(p.authFile, 0o600);
      const before = fs.statSync(p.authFile).mode & 0o777;
      const r = applyAzureRename(p);
      assert.equal(r.changed.length, 1);
      assert.equal(fs.statSync(p.authFile).mode & 0o777, before);
    } finally {
      cleanup(p);
    }
  });

  it('幂等：第二次调用 changed 为空且内容 / mtime 不变', () => {
    const p = fullFixture();
    try {
      assert.equal(applyAzureRename(p).changed.length, 7);
      const snap = [p.modelsFile, p.settingsFile, p.authFile].map((f) => ({
        f,
        text: raw(f),
        mtime: fs.statSync(f).mtimeMs,
      }));
      const second = applyAzureRename(p);
      assert.deepEqual(second, { ok: true, changed: [], conflicts: [], skipped: [] });
      for (const s of snap) {
        assert.equal(raw(s.f), s.text, s.f + ' 内容被改了');
        assert.equal(fs.statSync(s.f).mtimeMs, s.mtime, s.f + ' 被重新写了');
      }
    } finally {
      cleanup(p);
    }
  });

  it('冲突：已存在 azure 键时记 conflicts、不覆盖、不改文件', () => {
    const p = fixture({
      models: { providers: { [OLD]: { api: OLD }, [NEW]: { api: 'openai-completions' } } },
      settings: { enabledModels: [NEW, OLD], defaultProvider: 'keep' },
      auth: { [OLD]: { type: 'oauth' }, [NEW]: { type: 'oauth', access: 'new' } },
    });
    try {
      const before = {
        models: raw(p.modelsFile),
        settings: raw(p.settingsFile),
        auth: raw(p.authFile),
      };
      const r = applyAzureRename(p);
      assert.equal(r.ok, false);
      assert.equal(r.changed.length, 0);
      assert.equal(r.conflicts.length, 3);
      for (const c of r.conflicts) {
        assert.match(c.detail, /人工合并/);
      }
      assert.equal(raw(p.modelsFile), before.models);
      assert.equal(raw(p.settingsFile), before.settings);
      assert.equal(raw(p.authFile), before.auth);
      assert.deepEqual(readJson(p.authFile)[NEW], { type: 'oauth', access: 'new' });
      for (const f of [p.modelsFile, p.settingsFile, p.authFile]) {
        assert.ok(!fs.existsSync(f + '.bak'), f + '.bak 不该生成');
      }
    } finally {
      cleanup(p);
    }
  });

  it('部分冲突：冲突项留原样，别的项照常迁移', () => {
    const p = fixture({
      models: { providers: { [OLD]: { api: OLD } } },
      settings: {
        defaultProvider: OLD,
        modelThinkingLevels: { [NEW]: 'high', [OLD]: 'low' },
      },
      auth: { [OLD]: { type: 'oauth' } },
    });
    try {
      const r = applyAzureRename(p);
      assert.equal(r.changed.length, 3); // models / defaultProvider / auth
      assert.equal(r.conflicts.length, 1); // modelThinkingLevels
      assert.equal(r.ok, false);
      const settings = readJson(p.settingsFile);
      assert.equal(settings.defaultProvider, NEW);
      assert.deepEqual(settings.modelThinkingLevels, { [NEW]: 'high', [OLD]: 'low' });
      assert.ok(readJson(p.modelsFile).providers[NEW]);
      assert.ok(readJson(p.authFile)[NEW]);
    } finally {
      cleanup(p);
    }
  });

  it('无法解析的文件记入 skipped 且不动它', () => {
    const p = fixture({ models: '{ oops', auth: { [OLD]: 1 } });
    try {
      const r = applyAzureRename(p);
      assert.equal(r.skipped.length, 1);
      assert.equal(r.skipped[0].where, 'models.json');
      assert.match(r.skipped[0].reason, /不是合法 JSON/);
      assert.equal(r.ok, false);
      assert.equal(raw(p.modelsFile), '{ oops');
      assert.ok(readJson(p.authFile)[NEW]);
    } finally {
      cleanup(p);
    }
  });
});

describe('默认路径（环境变量指向临时目录）复用 models.js / settings.js helper', () => {
  it('detect + apply 在默认路径上工作，且生成 .bak', () => {
    const dir = mkTmp();
    const modelsFile = path.join(dir, 'models.json');
    const settingsFile = path.join(dir, 'settings.json');
    const authFile = path.join(dir, 'auth.json');
    writeJson(modelsFile, { providers: { [OLD]: { api: OLD, models: [{ id: 'm1' }] } } });
    writeJson(settingsFile, { defaultProvider: OLD, enabledModels: [OLD] });
    writeJson(authFile, { [OLD]: { type: 'oauth' } });
    try {
      const script = `
        const m = require(${JSON.stringify(migrationsModule)});
        const before = m.detectMigrations();
        const res = m.applyAzureRename();
        process.stdout.write(JSON.stringify({ count: before.count, res }));
      `;
      const r = spawnSync(process.execPath, ['-e', script], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PI_AGENT_DIR: dir,
          MODELS_FILE: modelsFile,
          SETTINGS_FILE: settingsFile,
          AUTH_FILE: authFile,
        },
      });
      assert.equal(r.status, 0, r.stderr || r.stdout);
      const out = JSON.parse(r.stdout);
      assert.equal(out.count, 4);
      assert.equal(out.res.ok, true);
      assert.equal(out.res.changed.length, 4);
      assert.deepEqual(out.res.conflicts, []);
      assert.ok(fs.existsSync(modelsFile + '.bak'));
      assert.ok(fs.existsSync(settingsFile + '.bak'));
      assert.ok(fs.existsSync(authFile + '.bak'));
      assert.ok(readJson(modelsFile).providers[NEW]);
      assert.equal(readJson(settingsFile).defaultProvider, NEW);
      assert.ok(readJson(authFile)[NEW]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('路由 /api/migrations 契约', () => {
  it('detectMigrations 返回 { items, count }，items 字段可用于 UI 与去重', () => {
    const p = fullFixture();
    try {
      const r = detectMigrations(p);
      assert.equal(r.items.length, r.count);
      const ids = new Set(r.items.map((i) => i.id));
      assert.equal(ids.size, r.items.length, 'id 必须唯一（去重用）');
      for (const it of r.items) {
        assert.equal(typeof it.id, 'string');
        assert.ok(path.isAbsolute(it.file), 'file 必须是绝对路径');
        assert.equal(typeof it.where, 'string');
        assert.equal(typeof it.from, 'string');
        assert.equal(typeof it.to, 'string');
        assert.equal(typeof it.detail, 'string');
        assert.equal(typeof it.canAutoFix, 'boolean');
      }
    } finally {
      cleanup(p);
    }
  });
});
