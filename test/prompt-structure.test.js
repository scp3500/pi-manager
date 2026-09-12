const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { analyze, estimateTokens, detectPromptHooks, detectExtensionTools, discoverPromptFiles, isProjectTrusted, skillSourcePaths } = require('../lib/prompt-structure');

/** 复刻 pi buildSystemPrompt 的拼装标记，保证切分逻辑被测到的是真实格式 */
const CTX_OPEN = '\n\n<project_context>\n\n';
const SKILLS_START =
  '\n\nThe following skills provide specialized instructions for specific tasks.';
const CWD_MARK = '\nCurrent working directory: ';

function fixture(options = {}) {
  const head = options.head || 'You are an expert coding assistant operating inside pi.\n\nGuidelines:\n- Be concise\n- One\n';
  const append = options.append ? '\n\n' + options.append : '';
  const ctx = options.contextFiles
    ? CTX_OPEN +
      'Project-specific instructions and guidelines:\n\n' +
      options.contextFiles
        .map((f) => '<project_instructions path="' + f.path + '">\n' + f.content + '\n</project_instructions>\n\n')
        .join('') +
      '</project_context>\n'
    : '';
  const skills = options.skills
    ? SKILLS_START +
      '\nUse the read tool to load a skill file.\n\n<available_skills>\n' +
      options.skills
        .map(
          (s) =>
            '  <skill>\n    <name>' + s.name + '</name>\n    <description>' + (s.description || 'd') +
            '</description>\n    <location>/skills/' + s.name + '/SKILL.md</location>\n  </skill>'
        )
        .join('\n') +
      '\n</available_skills>'
    : '';
  const prompt = head + append + ctx + skills + CWD_MARK + '/work/dir';
  return { prompt, head, append: options.append || '', ctx, skills };
}

const FULL = {
  contextFiles: [
    { path: 'C:\\agent\\AGENTS.md', content: 'A'.repeat(400) },
    { path: 'C:\\proj\\AGENTS.md', content: 'B'.repeat(120) },
  ],
  skills: [
    { name: 'alpha', description: 'x'.repeat(30) },
    { name: 'beta', description: 'y'.repeat(10) },
  ],
};

describe('prompt-structure: 按拼装标记切分', () => {
  it('区块顺序与 key 与 pi 的拼装顺序一致', () => {
    const f = fixture(FULL);
    const r = analyze(f.prompt, { selectedTools: ['read', 'bash'], toolSnippets: { read: 'r', bash: 'b' } });
    assert.deepEqual(r.sections.map((s) => s.key), ['core', 'context', 'skills', 'cwd']);
    assert.equal(r.accountedChars, r.totalChars, '各区块字符数之和必须等于总长');
    assert.deepEqual(r.checks.filter((c) => c.level === 'warn'), []);
  });

  it('上下文文件逐个归因，且等于真实注入长度', () => {
    const f = fixture(FULL);
    const r = analyze(f.prompt, {});
    assert.equal(r.contextFiles.length, 2);
    assert.equal(r.contextFiles[0].label, 'C:\\agent\\AGENTS.md');
    assert.equal(r.contextFiles[0].chars, 400 + '<project_instructions path="C:\\agent\\AGENTS.md">\n\n</project_instructions>'.length);
    assert.ok(r.contextFiles[0].chars > r.contextFiles[1].chars);
  });

  it('技能块逐个归因并给出名字', () => {
    const r = analyze(fixture(FULL).prompt, {});
    assert.deepEqual(r.skills.map((s) => s.label), ['alpha', 'beta']);
    assert.ok(r.skills[0].chars > r.skills[1].chars);
  });

  it('append 段夹在头与上下文之间时能被切出来', () => {
    const f = fixture({ ...FULL, append: 'EXTRA APPEND TEXT' });
    const r = analyze(f.prompt, { appendSystemPrompt: 'EXTRA APPEND TEXT' });
    assert.deepEqual(r.sections.map((s) => s.key), ['core', 'append', 'context', 'skills', 'cwd']);
    assert.equal(r.accountedChars, r.totalChars);
  });

  it('customPrompt 与头完全一致时标记为 custom，并提示内置基础提示词已被替换', () => {
    const f = fixture({ head: 'CUSTOM SYSTEM PROMPT' });
    const r = analyze(f.prompt, { customPrompt: 'CUSTOM SYSTEM PROMPT' });
    assert.equal(r.sections[0].key, 'custom');
    assert.ok(r.checks.some((c) => c.text.includes('SYSTEM.md')));
  });

  it('缺少 <available_skills> 或尾注时仍保持自洽，不抛错', () => {
    const bare = 'ONLY BASE PROMPT';
    const r = analyze(bare, {});
    assert.equal(r.sections.length, 1);
    assert.equal(r.accountedChars, bare.length);
    assert.equal(r.skills.length, 0);
    assert.equal(r.contextFiles.length, 0);
  });

  it('切分自检失败会产出 warn（人为破坏标记）', () => {
    // 头里塞一个假的 <project_context> 序言，使 indexOf 找不到完整开标记 → 归因必然对不上
    const r = analyze('\n\n<project_context> 没有闭合的假标记', {});
    assert.equal(r.accountedChars, r.totalChars);
  });
});

describe('prompt-structure: 体检与统计', () => {
  it('未注入的技能会被点名（speak-zhouli 场景）', () => {
    const f = fixture(FULL);
    const r = analyze(f.prompt, {
      skills: [
        { name: 'alpha' },
        { name: 'beta' },
        { name: 'disabled-one' },
      ],
    });
    assert.deepEqual(r.skillsSkipped, ['disabled-one']);
    assert.ok(r.checks.some((c) => c.text.includes('disabled-one')));
  });

  it('工具缺 snippet 时提示不会出现在工具列表', () => {
    const r = analyze(fixture({}).prompt, {
      selectedTools: ['read', 'bash', 'grep'],
      toolSnippets: { read: 'r', bash: 'b' },
    });
    assert.deepEqual(r.tools.names, ['read', 'bash']);
    assert.equal(r.tools.visible, 2);
    assert.equal(r.tools.selected, 3);
    assert.ok(r.checks.some((c) => c.level === 'warn' && c.text.includes('grep')));
  });

  it('上下文文件超过 3 个给出合并建议', () => {
    const many = {
      contextFiles: [1, 2, 3, 4].map((i) => ({ path: 'f' + i + '.md', content: 'x' })),
    };
    const r = analyze(fixture(many).prompt, {});
    assert.ok(r.checks.some((c) => c.level === 'warn' && c.text.includes('考虑合并')));
  });

  it('标题按 Markdown 一级到六级统计', () => {
    const f = fixture({ head: '# 一\n## 二\n### 三\ntext' });
    const r = analyze(f.prompt, {});
    assert.deepEqual(r.headings, ['# 一', '## 二', '### 三']);
  });

  it('指南条数从 Guidelines 段读出', () => {
    const r = analyze(fixture({}).prompt, {});
    assert.equal(r.guidelines, 2);
  });

  it('token 估算对 ASCII 与 CJK 分别计价', () => {
    assert.equal(estimateTokens('a'.repeat(400)), 100);
    assert.ok(estimateTokens('中'.repeat(15)) >= 9);
    assert.equal(estimateTokens(''), 0);
  });
});

describe('prompt-structure: 扩展注入的实际位置', () => {
  const PREFIX = '<!-- prompt-prefix:start -->\nINJECTED RULES\n<!-- prompt-prefix:end -->';

  it('prompt-prefix 的前置块被单独归因，且排在第一位', () => {
    const base = fixture(FULL).prompt;
    const prompt = PREFIX + '\n\n' + base;
    const r = analyze(prompt, {
      prefixText: PREFIX,
      prefixItems: [
        { label: 'C:\docs\prompts\overload.md', chars: 200, tokens: 90, content: 'INJECTED RULES', note: '注入文件' },
      ],
    });
    assert.equal(r.sections[0].key, 'ext');
    assert.ok(r.sections[0].label.includes('prompt-prefix'));
    assert.equal(r.sections[0].tokens > 0, true);
    assert.deepEqual(r.sections.map((s) => s.key), ['ext', 'core', 'context', 'skills', 'cwd']);
    assert.equal(r.accountedChars, r.totalChars, '前置块 + 其余必须正好等于总长');
    assert.equal(r.sections[0].items.length, 1, '注入文件应作为子项');
  });

  it('前置块不在开头时给出警示且不误减其它区块', () => {
    const base = fixture(FULL).prompt;
    const r = analyze(base, { prefixText: PREFIX });
    assert.notEqual(r.sections[0].key, 'ext');
    assert.ok(r.checks.some((c) => c.level === 'warn' && c.text.includes('prompt-prefix')));
    assert.equal(r.accountedChars, r.totalChars);
  });

  it('未计入的扩展改写会进体检', () => {
    const r = analyze(fixture(FULL).prompt, {
      promptHooks: [{ name: 'other-ext', path: '/x/index.ts', accounted: false }],
    });
    assert.ok(r.checks.some((c) => c.level === 'warn' && c.text.includes('other-ext')));
    assert.equal(r.promptHooks.length, 1);
  });

  it('detectPromptHooks 只认同时含 before_agent_start 与 systemPrompt 的扩展', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-hooks-'));
    const mk = (name, body) => {
      fs.mkdirSync(path.join(tmp, name), { recursive: true });
      fs.writeFileSync(path.join(tmp, name, 'index.ts'), body, 'utf8');
    };
    mk('prompt-prefix', 'pi.on("before_agent_start", (e) => ({ systemPrompt: e.systemPrompt }))');
    mk('footer-only', 'pi.on("before_agent_start", () => {})');
    mk('prompt-reader', 'const s = ctx.getSystemPrompt();');
    try {
      const hooks = detectPromptHooks(tmp);
      assert.deepEqual(hooks.map((h) => h.name), ['prompt-prefix']);
      assert.equal(hooks[0].accounted, true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('prompt-structure: SYSTEM.md / APPEND_SYSTEM.md 发现规则', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-promptfiles-'));
  const agentDir = path.join(tmp, 'agent');
  const proj = path.join(tmp, 'proj');
  const trustFile = path.join(tmp, 'trust.json');
  fs.mkdirSync(path.join(proj, '.pi'), { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, 'SYSTEM.md'), 'GLOBAL SYSTEM', 'utf8');
  fs.writeFileSync(path.join(agentDir, 'APPEND_SYSTEM.md'), 'GLOBAL APPEND', 'utf8');
  fs.writeFileSync(path.join(proj, '.pi', 'SYSTEM.md'), 'PROJECT SYSTEM', 'utf8');
  fs.writeFileSync(path.join(proj, '.pi', 'APPEND_SYSTEM.md'), 'PROJECT APPEND', 'utf8');
  fs.writeFileSync(trustFile, JSON.stringify({}), 'utf8');

  const call = (cwd, trusted) =>
    discoverPromptFiles(cwd, { agentDir, trustFile, trusted });

  it('未信任项目：项目文件被忽略，退回全局文件', () => {
    const r = call(proj, false);
    assert.equal(r.trusted, false);
    assert.equal(r.system, path.join(agentDir, 'SYSTEM.md'));
    assert.equal(r.append, path.join(agentDir, 'APPEND_SYSTEM.md'));
  });

  it('已信任项目：项目文件优先于全局', () => {
    const r = call(proj, true);
    assert.equal(r.system, path.join(proj, '.pi', 'SYSTEM.md'));
    assert.equal(r.append, path.join(proj, '.pi', 'APPEND_SYSTEM.md'));
  });

  it('信任判定按 trust.json 就近命中，未记录则视为不信任', () => {
    fs.writeFileSync(trustFile, JSON.stringify({ [proj]: true }), 'utf8');
    assert.equal(isProjectTrusted(proj, trustFile), true);
    assert.equal(isProjectTrusted(path.join(proj, 'deep', 'er'), trustFile), true, '祖先目录的信任应生效');
    assert.equal(isProjectTrusted(path.join(tmp, 'other'), trustFile), false);
    fs.writeFileSync(trustFile, JSON.stringify({ [proj]: false }), 'utf8');
    assert.equal(isProjectTrusted(proj, trustFile), false, '显式 false 不应被祖先覆盖');
  });

  it('只有全局目录时仍然能找到文件（无需信任）', () => {
    const r = call(path.join(tmp, 'plain'), false);
    assert.equal(r.system, path.join(agentDir, 'SYSTEM.md'));
  });
});

describe('prompt-structure: 技能来源（除 loadSkills 默认目录外）', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-skillpaths-'));
  const home = path.join(tmp, 'home');
  const proj = path.join(tmp, 'work', 'proj');
  const extra = path.join(tmp, 'shared-skills');
  for (const d of [path.join(home, '.agents', 'skills'), path.join(proj, '.agents', 'skills'), extra, path.join(tmp, 'work', '.agents', 'skills')]) {
    fs.mkdirSync(d, { recursive: true });
  }
  const settingsFile = path.join(tmp, 'settings.json');
  fs.writeFileSync(settingsFile, JSON.stringify({ skills: [extra, path.join(tmp, 'nope')] }), 'utf8');

  it('合并 settings.skills、~/.agents/skills 与逐级祖先的 .agents/skills，且只保留存在的目录', () => {
    const paths = skillSourcePaths(proj, { home, settingsFile });
    assert.ok(paths.includes(extra), '缺少 settings.skills 路径');
    assert.ok(paths.includes(path.join(home, '.agents', 'skills')), '缺少用户级 .agents/skills');
    assert.ok(paths.includes(path.join(proj, '.agents', 'skills')), '缺少项目级 .agents/skills');
    assert.ok(paths.includes(path.join(tmp, 'work', '.agents', 'skills')), '缺少祖先级 .agents/skills');
    assert.ok(!paths.some((p) => p.includes('nope')), '不存在的目录不该返回');
  });
});

describe('prompt-structure: 技能来源去重', () => {
  it('cwd 在 HOME 下时 ~/.agents/skills 只出现一次', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-skilldedup-'));
    const home = path.join(tmp, 'home');
    fs.mkdirSync(path.join(home, '.agents', 'skills'), { recursive: true });
    const settingsFile = path.join(tmp, 'settings.json');
    fs.writeFileSync(settingsFile, JSON.stringify({ skills: [] }), 'utf8');
    try {
      const paths = skillSourcePaths(path.join(home, 'deep', 'er'), { home, settingsFile });
      const hit = paths.filter((p) => p === path.join(home, '.agents', 'skills'));
      assert.equal(hit.length, 1, '重复目录未去重: ' + paths.join(' | '));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('prompt-structure: provider 上报值对账', () => {
  it('pi 口径 = 字符 ÷ 4，与加权估算分开给出', () => {
    const f = fixture({ contextFiles: [{ path: 'a.md', content: '中'.repeat(100) }] });
    const r = analyze(f.prompt, {});
    assert.equal(r.piTokens, Math.ceil(f.prompt.length / 4));
    assert.ok(r.estTokens > r.piTokens, '中文多时加权估算应高于 pi 口径');
    assert.equal(r.sections.reduce((n, s) => n + s.piTokens, 0), r.sections.reduce((n, s) => n + s.piTokens, 0));
  });

  it('每个区块都同时带两种口径', () => {
    const r = analyze(fixture(FULL).prompt, {});
    for (const s of r.sections) {
      assert.equal(typeof s.tokens, 'number');
      assert.equal(typeof s.piTokens, 'number');
      assert.equal(s.piTokens, Math.ceil(s.content.length / 4));
    }
  });
});

describe('prompt-structure: 扩展注册的工具识别', () => {
  it('从扩展源码里扫出 registerTool 的名字，忽略没有注册工具的扩展', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-exttools-'));
    const mk = (name, body) => {
      fs.mkdirSync(path.join(tmp, name), { recursive: true });
      fs.writeFileSync(path.join(tmp, name, 'index.ts'), body, 'utf8');
    };
    mk('with-tools', 'pi.registerTool({ name: "todo", description: "t", parameters: P });\npi.registerTool({ name: "subagent", parameters: Q });');
    mk('no-tools', 'pi.on("agent_start", () => {});');
    fs.writeFileSync(path.join(tmp, 'top-level.ts'), 'pi.registerTool({ name: "extra" });', 'utf8');
    try {
      const names = detectExtensionTools(tmp).sort();
      assert.deepEqual(names, ['extra', 'subagent', 'todo']);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('prompt-structure: 工具探测的解析与降级', () => {
  it('解析子进程输出：取最后一行 JSON，过滤脏数据', () => {
    const { parseProbeOutput } = require('../lib/extension-tools');
    const out = 'noise line\n[{"name":"todo","chars":352},{"name":"subagent","chars":1797}]';
    assert.deepEqual(parseProbeOutput(out).map((t) => t.name), ['todo', 'subagent']);
    assert.equal(parseProbeOutput(''), null);
    assert.equal(parseProbeOutput('boom'), null);
    assert.deepEqual(parseProbeOutput('[{"chars":1}]'), [], '缺 name 应被过滤掉');
    assert.deepEqual(parseProbeOutput('[]'), []);
  });

  it('PROMPT_MAP_NO_PROBE=1 时直接返回 null（测试与离线场景不 spawn 子进程）', async () => {
    process.env.PROMPT_MAP_NO_PROBE = '1';
    const tools = require('../lib/extension-tools');
    tools.clearProbeCache();
    try {
      assert.equal(await tools.probeExtensionTools(), null);
    } finally {
      delete process.env.PROMPT_MAP_NO_PROBE;
      tools.clearProbeCache();
    }
  });
});
