const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

/** 最小 DOM 替身：只实现 promptmap-ui.js 真正用到的接口 */
function element(id) {
  const classes = new Set();
  const el = {
    id,
    innerHTML: '',
    textContent: '',
    value: '',
    dataset: {},
    style: {},
    options: [],
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c),
      toggle: (c, on) => (on === undefined ? (classes.has(c) ? classes.delete(c) : classes.add(c)) : on ? classes.add(c) : classes.delete(c)),
    },
    _classes: classes,
    _listeners: {},
    addEventListener(name, fn) {
      (el._listeners[name] = el._listeners[name] || []).push(fn);
    },
    scrollIntoView() {},
    focus() {},
    setAttribute(name, v) {
      el[name] = v;
    },
    remove() {},
    closest: () => null,
    querySelector: () => null,
  };
  return el;
}

function harness(data) {
  const root = element('pm-root');
  const sel = element('pm-cwd');
  const nodes = {
    'pm-root': root,
    'pm-cwd': sel,
    'pm-refresh': element('pm-refresh'),
    'pm-search': element('pm-search'),
    'pm-expand-all': element('pm-expand-all'),
  };
  // 懒加载正文的宿主：真实 DOM 里由 innerHTML 生成，替身用注册表按选择器命中
  const blockBodies = {};
  const subBodies = {};
  const els = {};
  for (const s of data.sections) {
    const body = element('body-' + s.key);
    const head = element('head-' + s.key);
    const block = element('block-' + s.key);
    block.querySelector = (q) => (q.includes('pm-block-body') ? body : head);
    blockBodies[s.key] = body;
    els[s.key] = { block, body, head };
    (s.items || []).forEach((_, i) => {
      const key = s.key + ':' + i;
      const subBody = element('subbody-' + key);
      const subHead = element('subhead-' + key);
      const sub = element('sub-' + key);
      sub.querySelector = (q) => (q.includes('pm-sub-body') ? subBody : subHead);
      subBodies[key] = subBody;
      els[key] = { sub, subBody, subHead };
    });
  }
  const copied = [];
  const ctx = {
    console,
    setTimeout: (fn) => fn(),
    clearTimeout() {},
    addEventListener() {},
    removeEventListener() {},
    Intl,
    URLSearchParams,
    document: {
      readyState: 'complete',
      getElementById: (id) => nodes[id] || null,
      querySelectorAll: () => [],
      createElement: () => element('created'),
      querySelector: (selector) => {
        const m = /data-key="([^"]+)"/.exec(selector);
        if (!m) return null;
        const rec = els[m[1]];
        if (!rec) return null;
        // 带 -body 的选择器取正文宿主，否则取容器元素；子块与区块用 key 里有无 ':' 区分
        const wantsBody = /pm-(block|sub)-body/.test(selector);
        const isSub = m[1].includes(':');
        if (wantsBody) return (isSub ? rec.subBody : rec.body) || null;
        return (isSub ? rec.sub : rec.block) || null;
      },
      addEventListener() {},
    },
    navigator: { clipboard: { writeText: (t) => { copied.push(t); return Promise.resolve(); } } },
    state: {},
    esc: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    showToast: () => {},
    refreshIcons: () => {},
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/promptmap-ui.js'), 'utf8'), ctx, {
    filename: 'promptmap-ui.js',
  });
  return { ctx, root, sel, blockBodies, subBodies, copied, nodes, fire(name, value) {
    const el = nodes[name];
    const fns = (el && el._listeners) || {};
    for (const fn of fns[value.event] || []) fn(value.payload);
  } };
}

const REPORT = {
  generatedAt: '2026-09-12T00:00:00.000Z',
  cwd: 'E:\\proj\\demo',
  piVersion: '0.85.1',
  customPromptFile: null,
  appendPromptFile: 'C:\Users\33795\.pi\agent\APPEND_SYSTEM.md',
  totalChars: 1000,
  totalLines: 40,
  estTokens: 500,
  piTokens: 380,
  accountedChars: 1000,
  extensionTools: ['subagent', 'todo'],
  reportedUsage: {
    tokens: 8803,
    input: 7090,
    output: 177,
    cacheRead: 1536,
    cacheWrite: 0,
    model: 'deepseek-flash',
    cumulative: false,
    perTurnApprox: null,
  },
  toolsSchema: {
    items: [
      { name: 'read', chars: 653, tokens: 163, piTokens: 164 },
      { name: 'bash', chars: 512, tokens: 128, piTokens: 128 },
    ],
    chars: 1165,
    tokens: 291,
    piTokens: 292,
    extensionItems: [
      { name: 'subagent', chars: 1797, tokens: 450, piTokens: 450, fromExtension: true },
      { name: 'todo', chars: 352, tokens: 88, piTokens: 88, fromExtension: true },
    ],
    extensionChars: 2149,
    extensionTokens: 538,
    extensionPiTokens: 538,
    extensionToolsNotCounted: false,
  },
  promptPrefix: {
    enabled: true,
    chars: 2262,
    truncated: false,
    files: ['C:\\Users\\33795\\.pi\\docs\\prompts\\overload.md'],
    off: [],
    allCount: 2,
    missingDirs: [],
  },
  promptHooks: [
    { name: 'prompt-prefix', path: 'C:\\Users\\33795\\.pi\\agent\\extensions\\prompt-prefix\\index.ts', accounted: true },
    { name: 'other-ext', path: 'C:\\x\\other-ext\\index.ts', accounted: false },
  ],
  sections: [
    { key: 'ext', label: '扩展注入 · prompt-prefix（前置）', chars: 220, tokens: 100, lines: 6, tokenShare: 0.2, content: 'INJECTED RULES', items: [{ label: 'overload.md', chars: 200, tokens: 90, content: 'INJECTED RULES', note: '注入文件' }] },
    { key: 'core', label: '内置基础提示词', chars: 200, tokens: 100, lines: 10, tokenShare: 0.2, content: 'BASE LINE ONE\nBASE LINE TWO', items: [] },
    {
      key: 'context',
      label: '项目上下文 <project_context>',
      chars: 700,
      tokens: 280,
      lines: 25,
      tokenShare: 0.56,
      content: 'CTX RAW',
      items: [
        { label: '<img src=x onerror=alert(1)>.md', chars: 680, tokens: 370, contentChars: 670, contentTokens: 365, content: 'PROJECT RULE ALPHA\nPROJECT RULE BETA', note: '按 size+mtime 注入' },
        { label: '<project_context> 包装标签', chars: 20, tokens: 10, note: '包装' },
      ],
    },
    {
      key: 'skills',
      label: '技能清单 <available_skills>',
      chars: 90,
      tokens: 18,
      lines: 5,
      tokenShare: 0.036,
      content: 'SKILLS RAW',
      items: [{ label: 'dokobot', chars: 80, tokens: 18, description: 'browse the web with a real chrome browser', fileChars: 437, fileTokens: 129 }],
    },
    { key: 'cwd', label: '工作目录尾注', chars: 10, tokens: 2, lines: 1, tokenShare: 0.004, content: 'CWD /x', items: [] },
  ],
  contextFiles: [{ label: '<img src=x onerror=alert(1)>.md', chars: 680, tokens: 370 }],
  skills: [{ label: 'dokobot', chars: 80, tokens: 18 }],
  skillsSkipped: ['speak-zhouli'],
  skillsLoaded: 3,
  tools: { selected: 4, visible: 4, names: ['read', 'bash', 'edit', 'write'] },
  headings: ['# 标题一', '## 标题二'],
  guidelines: 10,
  checks: [
    { level: 'warn', text: '已启用但无 snippet、不会出现在工具列表里：grep' },
    { level: 'info', text: '未注入提示词的技能 1 个：speak-zhouli' },
  ],
  cwds: [{ cwd: 'E:\\proj\\demo', label: 'demo' }],
};

function loaded(report) {
  const h = harness(report);
  h.ctx.state.promptMapData = report;
  h.ctx.state.promptMapCwd = report.cwd;
  h.ctx.renderPromptMap();
  return h;
}

describe('promptmap-ui: Stats 与 tokens 单位', () => {
  it('头图以 tokens 为主单位，字符/行数作次要信息', () => {
    const h = loaded(REPORT);
    const html = h.root.innerHTML;
    assert.ok(html.includes('500'), 'token 总数缺失');
    assert.ok(html.includes('>tokens<'), 'tokens 单位缺失');
    assert.ok(html.includes('1,000 字符'), '字符数缺失');
    assert.ok(html.includes('40 行'), '行数缺失');
    assert.ok(html.includes('切分自检通过'), '自检状态缺失');
    assert.ok(html.includes('APPEND_SYSTEM.md'), '未显示追加提示词文件');
    assert.ok(html.includes('pi 口径 380 tokens'), '缺少 pi 口径数字');
    assert.ok(h.sel.innerHTML.includes('E:\\proj\\demo'), 'cwd 选择器未填充');
  });

  it('构成网格正好 50 格，格数按 token 占比分配', () => {
    const h = loaded(REPORT);
    const cells = h.root.innerHTML.match(/class="pm-cell"/g) || [];
    assert.equal(cells.length, 50, '网格格数应为 50');
    // context 占 76% ≈ 38 格，核心 20% ≈ 10 格
    const keys = h.ctx.pmCells(REPORT);
    assert.equal(keys.length, 50);
    assert.equal(keys.filter((k) => k === 'context').length, 28);
    assert.equal(keys.filter((k) => k === 'core').length, 10);
    assert.equal(keys.filter((k) => k === 'ext').length, 10);
  });

  it('图例按 token 列出每类占比', () => {
    const h = loaded(REPORT);
    const rows = h.root.innerHTML.match(/class="pm-legend-row"/g) || [];
    assert.equal(rows.length, 5, '图例应含扩展注入一类');
    assert.ok(h.root.innerHTML.includes('56.0%'), '占比未按 token 计算');
    assert.ok(h.root.innerHTML.includes('扩展注入'), '缺少扩展注入类');
  });
});

describe('promptmap-ui: 分区块与展开', () => {
  it('每个区块一块，含 token 数与占比条，但正文默认不渲染', () => {
    const h = loaded(REPORT);
    const html = h.root.innerHTML;
    const blocks = html.match(/class="pm-block tone-/g) || [];
    assert.equal(blocks.length, 5, '区块数量应与分类一致');
    assert.ok(html.includes('data-key="core"'));
    assert.ok(html.includes('100<small>tokens</small>'), '区块 token 数缺失');
    assert.ok(html.includes('20.0%'), '区块占比缺失');
    assert.ok(!html.includes('BASE LINE ONE'), '正文不该在未展开时渲染');
  });

  it('展开区块后才渲染带行号的正文，重复展开不重复插入', () => {
    const h = loaded(REPORT);
    h.ctx.pmToggle('core');
    const body = h.blockBodies.core;
    assert.equal(body.dataset.filled, '1');
    assert.ok(body.innerHTML.includes('pm-ln-no'), '缺少行号');
    assert.ok(body.innerHTML.includes('BASE LINE ONE'));
    const first = body.innerHTML;
    h.ctx.pmToggle('core'); // 收起
    h.ctx.pmToggle('core'); // 再展开
    assert.equal(body.innerHTML, first, '重复展开不应重建正文');
  });

  it('上下文块按文件拆成子块，展开子块才加载该文件正文', () => {
    const h = loaded(REPORT);
    // 子块本身也懒生成：未展开父块时不应出现
    assert.ok(!h.root.innerHTML.includes('pm-sub'), '未展开时不该生成子块');
    h.ctx.pmToggle('context');
    const inner = h.blockBodies.context.innerHTML;
    assert.equal((inner.match(/class="pm-sub[ "]/g) || []).length, 1, '包装标签不该成为子块');
    assert.ok(inner.includes('文件正文 365 tokens'), '未显示文件正文字数');
    h.ctx.pmToggle('context:0');
    assert.ok(h.subBodies['context:0'].innerHTML.includes('PROJECT RULE ALPHA'), '子块正文未加载');
  });

  it('技能子块给出 SKILL.md 体积与按需读取说明', () => {
    const h = loaded(REPORT);
    h.ctx.pmToggle('skills');
    assert.ok(h.blockBodies.skills.innerHTML.includes('SKILL.md 437 字符'), '缺少 SKILL.md 体积');
    assert.ok(h.blockBodies.skills.innerHTML.includes('按需读取'), '缺少按需读取提示');
  });

  it('复制按钮取整块原文', async () => {
    const h = loaded(REPORT);
    await h.ctx.pmCopy('context');
    assert.equal(h.copied[0], 'CTX RAW');
  });
});

describe('promptmap-ui: 一次请求的固定开销', () => {
  it('列出系统提示词与各内置工具定义，并按 pi 口径给合计', () => {
    const h = loaded(REPORT);
    const html = h.root.innerHTML;
    assert.ok(html.includes('一次请求的固定开销'), '缺少开销卡片');
    assert.ok(html.includes('工具定义 · read'), '缺少 read 工具定义');
    assert.ok(html.includes('工具定义 · bash'), '缺少 bash 工具定义');
    // 380（提示词）+ 164 + 128（内置）+ 450 + 88（扩展）= 1210
    assert.ok(html.includes('1,210'), '合计未按 pi 口径相加');
    assert.ok(html.includes('工具定义 · subagent'), '扩展工具未进列表');
    assert.ok(html.includes('工具定义 · todo'));
    assert.ok(html.includes('内置'), '缺内置标记');
    assert.ok(html.includes('扩展'), '缺扩展标记');
  });

  it('和 provider 上报值对账，并给出差额来源', () => {
    const h = loaded(REPORT);
    assert.ok(h.root.innerHTML.includes('8,803'), '缺少上报值');
    assert.ok(h.root.innerHTML.includes('含工具与消息'), '缺少口径说明');
    assert.ok(h.root.innerHTML.includes('deepseek-flash'));
  });

  it('cacheRead 为累计计数时改用单轮增量提示', () => {
    const cum = { ...REPORT, reportedUsage: { ...REPORT.reportedUsage, tokens: 426990, cumulative: true, perTurnApprox: 1280 } };
    const h = loaded(cum);
    assert.ok(h.root.innerHTML.includes('累计计数器'), '未标记累计');
    assert.ok(h.root.innerHTML.includes('1,280'), '未给单轮增量');
  });

  it('扩展工具探测失败时，退化成点名提示', () => {
    const partial = {
      ...REPORT,
      toolsSchema: { ...REPORT.toolsSchema, extensionItems: [], extensionPiTokens: 0, extensionTokens: 0 },
      extensionTools: ['subagent', 'todo'],
    };
    const h = loaded(partial);
    assert.ok(h.root.innerHTML.includes('未能取到 schema'), '未提示探测失败');
    assert.ok(h.root.innerHTML.includes('subagent、todo'));
  });

  it('缺工具定义数据时不渲染该卡片', () => {
    const noTools = { ...REPORT, toolsSchema: undefined };
    const h = loaded(noTools);
    assert.ok(!h.root.innerHTML.includes('一次请求的固定开销'));
  });
});

describe('promptmap-ui: 扩展改写', () => {
  it('已计入的扩展给出注入文件与开关状态', () => {
    const h = loaded(REPORT);
    const html = h.root.innerHTML;
    assert.ok(html.includes('扩展改写'), '缺少扩展改写卡片');
    assert.ok(html.includes('prompt-prefix'));
    assert.ok(html.includes('已计入上方分类'));
    assert.ok(html.includes('开局注入') || html.includes('前置注入'), '缺少注入说明');
    assert.ok(html.includes('overload.md'), '缺少注入文件');
  });

  it('未计入的扩展标记为未计入', () => {
    const h = loaded(REPORT);
    assert.ok(h.root.innerHTML.includes('other-ext'));
    assert.ok(h.root.innerHTML.includes('未计入'));
  });

  it('扩展注入块本身也是一个可展开区块', () => {
    const h = loaded(REPORT);
    assert.ok(h.root.innerHTML.includes('data-key="ext"'));
    h.ctx.pmToggle('ext');
    const inner = h.blockBodies.ext.innerHTML;
    assert.ok(inner.includes('pm-sub'), '注入文件应为可展开子块');
    assert.ok(inner.includes('overload.md'));
  });
});

describe('promptmap-ui: 搜索与异常', () => {
  it('搜索命中行高亮、未命中行不渲染，并统计命中数', () => {
    const h = loaded(REPORT);
    // 走真实事件处理器：搜索会自动展开区块与子块，让任何位置的命中都可见
    h.fire('pm-search', { event: 'input', payload: { target: { value: 'alpha' } } });
    const body = h.subBodies['context:0'];
    assert.ok(body, '子块正文宿主缺失');
    assert.ok(body.innerHTML.includes('PROJECT RULE ALPHA'), '命中行应保留');
    assert.ok(!body.innerHTML.includes('PROJECT RULE BETA'), '未命中行不该渲染');
    assert.ok(body.innerHTML.includes('is-hit'), '命中行未标记');
    assert.equal(body.innerHTML.match(/pm-line is-hit/g).length, 1, '命中行数不符');
  });

  it('无匹配时给出空提示而不是空白', () => {
    const h = loaded(REPORT);
    h.fire('pm-search', { event: 'input', payload: { target: { value: 'zzz-not-exist' } } });
    assert.ok(h.blockBodies.core.innerHTML.includes('没有匹配的行'), '缺少空提示');
  });

  it('路径与内容一律转义，不注入 HTML', () => {
    const h = loaded(REPORT);
    h.ctx.pmToggle('context');
    assert.ok(!h.blockBodies.context.innerHTML.includes('<img src=x'), '子块路径未转义');
    assert.ok(h.blockBodies.context.innerHTML.includes('&lt;img'), '未按 HTML 转义输出');
  });

  it('接口返回空数据时报错，不静默画 0', async () => {
    const h = harness(REPORT);
    let toast = '';
    h.ctx.api = async () => ({});
    h.ctx.showToast = (msg, ok) => {
      toast = msg + '|' + ok;
    };
    const r = await h.ctx.loadPromptMap(false);
    assert.equal(r, null);
    assert.ok(toast.includes('结构接口返回空数据'), '未提示空数据: ' + toast);
    assert.ok(h.root.innerHTML.includes('分析失败'), '未渲染失败态');
  });

  it('自检未通过时头图给出警示态', () => {
    const h = loaded({ ...REPORT, accountedChars: 900 });
    assert.ok(h.root.innerHTML.includes('切分自检未通过'));
    assert.ok(h.root.innerHTML.includes('pm-warn'));
  });
});
