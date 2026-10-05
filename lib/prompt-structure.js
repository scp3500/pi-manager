/**
 * 系统提示词结构分析
 *
 * 直接复用 pi 自己的拼装器与资源加载器，保证「结构」不是猜的：
 *   buildSystemPrompt()            dist/core/system-prompt.js
 *   loadProjectContextFiles()      dist/index.js（AGENTS.md 发现：agent 目录 + cwd 逐级祖先）
 *   loadSkills()                   dist/index.js
 *   <tool>ToolSystemPromptContribution  dist/core/tools/*.js（snippet / guidelines）
 *
 * 拼装顺序（见 buildSystemPrompt 实现）：
 *   [自定义提示词 | 内置基础提示词] → [--append-system-prompt]
 *   → <project_context>…</project_context> → <available_skills>…</available_skills>
 *   → "\nCurrent working directory: <cwd>"
 * 各段都带确定标记，所以按标记切分即可精确归因，无需启发式。
 */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { HOME, PI_AGENT_DIR, SETTINGS_FILE } = require('./config');

const CWD_MARK = '\nCurrent working directory: ';
const CTX_OPEN = '\n\n<project_context>\n\n';
const SKILLS_START = '\n\nThe following skills provide specialized instructions for specific tasks.';
const FILE_RE = /<project_instructions path="([^"]*)">\n([\s\S]*?)\n<\/project_instructions>/g;
const SKILL_RE = / {2}<skill>\n {4}<name>([\s\S]*?)<\/name>\n {4}<description>([\s\S]*?)<\/description>\n {4}<location>([\s\S]*?)<\/location>/g;
const TOOL_NAMES = ['read', 'bash', 'edit', 'write'];
const { resolvePiInstall, resolvePiRoot, piVersion } = require('./pi-package');

let piCache = null;

/** 懒加载 pi 的拼装器（ESM，只能动态 import）；失败返回 null 由调用方降级 */
async function loadPi() {
  if (piCache) return piCache;
  const install = resolvePiInstall();
  const root = install.root;
  if (!root) return null;
  const abs = (rel) => pathToFileURL(path.join(root, rel)).href;
  const [pkg, sysPrompt] = await Promise.all([
    import(abs('dist/index.js')),
    import(abs('dist/core/system-prompt.js')),
  ]);
  const contributions = {};
  for (const name of TOOL_NAMES) {
    try {
      const mod = await import(abs('dist/core/tools/' + name + '.js'));
      contributions[name] = mod[name + 'ToolSystemPromptContribution'] || { snippet: '', guidelines: [] };
    } catch {
      contributions[name] = { snippet: '', guidelines: [] };
    }
  }
  piCache = {
    root,
    // 安装来源（env / managed-install / npm-global / shim），前端用来标注
    installKind: install.kind,
    installRoot: install.root,
    version: piVersion(root),
    loadProjectContextFiles: pkg.loadProjectContextFiles,
    loadSkills: pkg.loadSkills,
    createCodingTools: pkg.createCodingTools,
    buildSystemPrompt: sysPrompt.buildSystemPrompt,
    contributions,
  };
  return piCache;
}

/**
 * pi 自己的口径（dist/bundle 里 estimateTextTokens）：**纯字符数 ÷ 4**，不分中英文。
 * 要和 pi 状态栏 / 上下文占用对齐就用这个数；下面的 estimateTokens 是中文加权的更贴近真实值。
 */
function estimateTokensPi(text) {
  return Math.ceil(String(text || '').length / 4);
}

/** CJK 加权估算：ASCII 约 4 字符 1 token，CJK / 全角约 1.5 字符 1 token */
function estimateTokens(text) {
  let wide = 0;
  for (const ch of text) if ((ch.codePointAt(0) ?? 0) > 0x2e80) wide++;
  return Math.round((text.length - wide) / 4 + wide / 1.5);
}

function makeSection(key, label, text, items) {
  return {
    key,
    label,
    chars: text.length,
    tokens: estimateTokens(text),
    piTokens: estimateTokensPi(text),
    lines: text ? text.split('\n').length : 0,
    content: text,
    items: items || [],
  };
}

/**
 * 按 pi 的拼装标记切分系统提示词。
 * 返回的 sections 字符数之和恒等于提示词总长（analyze 里带自检）。
 */
function analyze(systemPrompt, options) {
  const s = systemPrompt;
  const opts = options || {};
  const checks = [];
  const sections = [];

  // 扩展前置块：prompt-prefix 在 before_agent_start 里把整块插在系统提示词最前面
  const prefixText = opts.prefixText || '';
  let body = s;
  if (prefixText && s.startsWith(prefixText)) {
    const rest0 = s.slice(prefixText.length);
    const gapMatch = rest0.match(/^\n+/);
    const gapLen = gapMatch ? gapMatch[0].length : 0;
    sections.push(
      makeSection(
        'ext',
        '扩展注入 · prompt-prefix（前置）',
        s.slice(0, prefixText.length + gapLen),
        (opts.prefixItems || []).slice()
      )
    );
    body = s.slice(prefixText.length + gapLen);
  } else if (prefixText) {
    checks.push({ level: 'warn', text: 'prompt-prefix 已启用但它的块不在提示词开头，本次未计入' });
  }

  const cwdIdx = body.lastIndexOf(CWD_MARK);
  const cwdTail = cwdIdx >= 0 ? body.slice(cwdIdx) : '';
  if (cwdIdx >= 0) body = body.slice(0, cwdIdx);

  const skillsIdx = body.lastIndexOf(SKILLS_START);
  const skillsBlock = skillsIdx >= 0 ? body.slice(skillsIdx) : '';
  if (skillsIdx >= 0) body = body.slice(0, skillsIdx);

  const ctxIdx = body.indexOf(CTX_OPEN);
  const ctxBlock = ctxIdx >= 0 ? body.slice(ctxIdx) : '';
  if (ctxIdx >= 0) body = body.slice(0, ctxIdx);

  const append = opts.appendSystemPrompt || '';
  let appendBlock = '';
  if (append) {
    const aIdx = body.lastIndexOf(append);
    if (aIdx >= 0) {
      appendBlock = body.slice(aIdx);
      body = body.slice(0, aIdx);
    } else {
      checks.push({ level: 'warn', text: 'appendSystemPrompt 未出现在最终提示词中' });
    }
  }

  const head = body;
  const isCustom = !!opts.customPrompt && head.trim() === String(opts.customPrompt).trim();
  sections.push(
    makeSection(
      isCustom ? 'custom' : 'core',
      isCustom ? '自定义提示词（替换了内置基础提示词）' : '内置基础提示词（角色 + 工具 + 指南 + 文档路径）',
      head
    )
  );
  if (isCustom) {
    checks.push({ level: 'info', text: '检测到 SYSTEM.md：内置基础提示词被整体替换，工具/指南/文档路径段不存在' });
  }
  if (appendBlock) sections.push(makeSection('append', '追加提示词（--append-system-prompt）', appendBlock));

  const contextFiles = [];
  if (ctxBlock) {
    let matched = 0;
    let m;
    FILE_RE.lastIndex = 0;
    while ((m = FILE_RE.exec(ctxBlock)) !== null) {
      matched += m[0].length;
      const body = m[0];
      contextFiles.push({
        label: m[1],
        chars: body.length,
        tokens: estimateTokens(body),
        contentChars: m[2].length,
        contentTokens: estimateTokens(m[2]),
        content: m[2],
        note: '按 size+mtime 注入',
      });
    }
    const overhead = ctxBlock.length - matched;
    if (overhead > 0) {
      contextFiles.push({
        label: '<project_context> 包装标签',
        chars: overhead,
        tokens: estimateTokens('<project_context></project_context>'),
        note: '包装',
      });
    }
    sections.push(makeSection('context', '项目上下文 <project_context>', ctxBlock, contextFiles));
  }

  const skills = [];
  if (skillsBlock) {
    let m;
    SKILL_RE.lastIndex = 0;
    while ((m = SKILL_RE.exec(skillsBlock)) !== null) {
      const start = m.index;
      const end = skillsBlock.indexOf('</skill>', start);
      const len = end >= 0 ? end + '</skill>'.length + 1 - start : m[0].length;
      const block = skillsBlock.slice(start, start + len);
      const filePath = m[3];
      let fileChars = 0;
      let fileTokens = 0;
      try {
        fileChars = fs.statSync(filePath).size;
        fileTokens = Math.round(fileChars / 3.4); // SKILL.md 多为 ASCII + 中文，粗估
      } catch {
        /* 文件不可读时留空 */
      }
      skills.push({
        label: m[1],
        chars: block.length,
        tokens: estimateTokens(block),
        description: m[2],
        filePath,
        fileChars,
        fileTokens,
      });
    }
    sections.push(makeSection('skills', '技能清单 <available_skills>', skillsBlock, skills));
  }
  if (cwdTail) sections.push(makeSection('cwd', '工作目录尾注', cwdTail));

  const selected = opts.selectedTools || [];
  const visible = selected.filter((n) => !!(opts.toolSnippets || {})[n]);
  if (selected.length > visible.length) {
    const hidden = selected.filter((n) => !(opts.toolSnippets || {})[n]);
    checks.push({ level: 'warn', text: `已启用但无 snippet、不会出现在工具列表里：${hidden.join(', ')}` });
  }

  const injected = new Set(skills.map((i) => i.label));
  const skipped = (opts.skills || []).filter((sk) => !injected.has(sk.name));
  const skippedNames = skipped.map((sk) => sk.name);
  if (skipped.length) {
    checks.push({
      level: 'info',
      text: `未注入提示词的技能 ${skipped.length} 个（disable-model-invocation 或缺少 read/bash）：${skipped.map((sk) => sk.name).join(', ')}`,
    });
  }

  const headings = (s.match(/^#{1,6} .+$/gm) || []).map((h) => h.trim());
  const guidelineMatch = head.match(/\nGuidelines:\n([\s\S]*?)(\n\n|$)/);
  const guidelines = guidelineMatch ? (guidelineMatch[1].match(/^- /gm) || []).length : 0;

  const realFiles = contextFiles.filter((i) => i.note !== '包装');
  if (realFiles.length > 3) {
    checks.push({ level: 'warn', text: `上下文文件 ${realFiles.length} 个，考虑合并以降低噪声` });
  }
  if (head.length > 24000) {
    checks.push({ level: 'info', text: '基础提示词偏长（>24k 字符），检查是否混入了本该放上下文文件的内容' });
  }
  if (realFiles.length > 1) {
    checks.push({
      level: 'info',
      text: `注入顺序即注意力顺序：先 ${path.basename(realFiles[0].label)}，最后 ${path.basename(realFiles[realFiles.length - 1].label)}（离末尾最近）`,
    });
  }
  if (skills.length) {
    const biggest = [...skills].sort((a, b) => b.chars - a.chars)[0];
    checks.push({ level: 'info', text: `技能描述最长的是 ${biggest.label}（${biggest.chars} 字符），描述越长越占常驻预算` });
  }

  const totalChars = s.length;
  const accounted = sections.reduce((n, sec) => n + sec.chars, 0);
  if (accounted !== totalChars) {
    checks.push({ level: 'warn', text: `切分自检未通过：归因 ${accounted} / 总计 ${totalChars}` });
  }

  const hooks = (opts.promptHooks || []).filter((hk) => !hk.accounted);
  if (hooks.length) {
    checks.push({
      level: 'warn',
      text: `${hooks.length} 个扩展会改写系统提示词但未计入本页：${hooks.map((hk) => hk.name).join(', ')}`,
    });
  }

  const totalT = sections.reduce((n, sec) => n + sec.tokens, 0);
  return {
    totalChars,
    totalLines: s.split('\n').length,
    estTokens: estimateTokens(s),
    piTokens: estimateTokensPi(s),
    accountedChars: accounted,
    sectionTokens: totalT,
    sections: sections.map((sec) => ({
      ...sec,
      share: totalChars ? sec.chars / totalChars : 0,
      tokenShare: totalT ? sec.tokens / totalT : 0,
      items: sec.items || [],
    })),
    contextFiles: realFiles,
    skills,
    skillsSkipped: skippedNames,
    skillsLoaded: (opts.skills || []).length,
    promptHooks: opts.promptHooks || [],
    tools: { selected: selected.length, visible: visible.length, names: visible },
    headings,
    guidelines,
    checks,
  };
}

/**
 * 已知的「在 before_agent_start 里改写系统提示词」扩展。
 * prompt-prefix 是可精确计入的：它自己的 lib.ts 零 pi 依赖，直接调它的 buildBlock()
 * 拿真实产物，不重写一遍逻辑。
 */
const PROMPT_PREFIX_EXT = 'prompt-prefix';
const PREFIX_TTL_MS = 2000;
let prefixCache = { expires: 0, data: null };

async function loadPromptPrefix() {
  if (prefixCache.expires > Date.now()) return prefixCache.data;
  const libPath = path.join(PI_AGENT_DIR, 'extensions', PROMPT_PREFIX_EXT, 'lib.ts');
  let data = null;
  if (fs.existsSync(libPath)) {
    try {
      const mod = await import(pathToFileURL(libPath).href);
      const r = await mod.buildBlock(true);
      const sep = r.cfg.separator || '\n\n---\n\n';
      const start = mod.MARK_START;
      const end = mod.MARK_END;
      let items = [];
      if (r.text && r.text.startsWith(start) && r.text.endsWith(end)) {
        const inner = r.text.slice(start.length + 1, r.text.length - end.length - 1);
        const chunks = inner.split(sep);
        if (chunks.length === r.used.length) {
          items = chunks.map((c, i) => ({
            label: r.used[i],
            chars: c.length,
            tokens: estimateTokens(c),
            content: c,
            note: '注入文件',
          }));
          const wrap = r.text.length - chunks.reduce((n, c) => n + c.length, 0);
          if (wrap > 0) items.push({ label: '标记与分隔符', chars: wrap, tokens: 2, note: '包装' });
        }
      }
      data = {
        enabled: !!r.cfg.enabled,
        text: r.text || '',
        chars: r.chars || 0,
        truncated: !!r.truncated,
        files: r.used || [],
        off: r.off || [],
        all: r.all || [],
        missingDirs: r.missingDirs || [],
        items,
        libPath,
      };
    } catch (error) {
      data = { enabled: false, text: '', chars: 0, error: error.message, libPath, items: [] };
    }
  }
  prefixCache = { expires: Date.now() + PREFIX_TTL_MS, data };
  return data;
}

/** 扫描已安装扩展，找出会改写系统提示词的（本页只能精确计入 prompt-prefix） */
/**
 * 扩展注册的额外工具（pi.registerTool）。它们的 schema 也随请求发送，
 * 但本页无法安全地执行扩展代码取真实 schema，只静态列出名字，供人工计入差额。
 */
function detectExtensionTools(extDir) {
  const dir = extDir || path.join(PI_AGENT_DIR, 'extensions');
  const names = new Set();
  const scanFile = (file) => {
    let src;
    try {
      src = fs.readFileSync(file, 'utf8');
    } catch {
      return;
    }
    const re = /registerTool\s*\(\s*\{[\s\S]{0,400}?name:\s*["'`]([^"'`]+)["'`]/g;
    let m;
    while ((m = re.exec(src)) !== null) names.add(m[1]);
  };
  const walk = (d) => {
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        const idx = path.join(full, 'index.ts');
        if (fs.existsSync(idx)) scanFile(idx);
      } else if (/\.(ts|js|mjs)$/.test(e.name)) {
        scanFile(full);
      }
    }
  };
  walk(dir);
  return [...names];
}

function detectPromptHooks(extDir) {
  const dir = extDir || path.join(PI_AGENT_DIR, 'extensions');
  const seen = new Set();
  const out = [];
  const inspect = (file, name) => {
    if (!file || seen.has(file)) return;
    seen.add(file);
    let src = '';
    try {
      src = fs.readFileSync(file, 'utf8');
    } catch {
      return;
    }
    if (!/before_agent_start/.test(src) || !/systemPrompt/.test(src)) return;
    out.push({
      name,
      path: file,
      accounted: name === PROMPT_PREFIX_EXT,
    });
  };
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const idx = path.join(dir, entry.name, 'index.ts');
        if (fs.existsSync(idx)) inspect(idx, entry.name);
      } else if (/\.(ts|js|mjs)$/.test(entry.name)) {
        inspect(path.join(dir, entry.name), entry.name.replace(/\.[^.]+$/, ''));
      }
    }
  } catch {
    /* 无扩展目录 */
  }
  try {
    const settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    for (const p of Array.isArray(settings.extensions) ? settings.extensions : []) {
      const abs = path.resolve(String(p).replace(/^~(?=[\\/]|$)/, HOME));
      if (!fs.existsSync(abs)) continue;
      const isDir = fs.statSync(abs).isDirectory();
      inspect(isDir ? path.join(abs, 'index.ts') : abs, path.basename(abs).replace(/\.[^.]+$/, ''));
    }
  } catch {
    /* 无 settings */
  }
  return out;
}

/** 候选工作目录：工作区根 + 近期会话 cwd，供前端选择器使用 */
function candidateCwds() {
  const out = [];
  const seen = new Set();
  const push = (dir, label) => {
    if (!dir || seen.has(dir) || !fs.existsSync(dir)) return;
    seen.add(dir);
    out.push({ cwd: dir, label: label || path.basename(dir) || dir });
  };
  try {
    const ws = require('./workspaces').listWorkspaces();
    for (const w of (ws && ws.workspaces) || []) {
      if (w.root) push(w.root, w.rootExists === false ? w.name + '（缺失）' : w.name);
    }
  } catch {
    /* ignore */
  }
  try {
    const sessions = require('./sessions').listSessions({ limit: 60 });
    for (const it of (sessions && sessions.items) || []) {
      if (it && it.cwd) push(it.cwd);
    }
  } catch {
    /* ignore */
  }
  push(HOME, '用户主目录');
  return out.slice(0, 20);
}

/**
 * pi 的系统提示词文件发现规则（见 docs/usage.md「System Prompt Files」）：
 *   替换内置：<cwd>/.pi/SYSTEM.md（需项目被信任）> ~/.pi/agent/SYSTEM.md
 *   追加不替换：<cwd>/.pi/APPEND_SYSTEM.md（需信任）> ~/.pi/agent/APPEND_SYSTEM.md
 * 另有 --system-prompt / --append-system-prompt 启动参数（逐次会话，控制台看不到）。
 */
const TRUST_FILE = path.join(PI_AGENT_DIR, 'trust.json');

/** trust.json 形如 {"<canonical dir>": true}；就近的已保存决定生效（当前目录 → 逐级父目录） */
function isProjectTrusted(cwd, trustFile) {
  let table;
  try {
    table = JSON.parse(fs.readFileSync(trustFile || TRUST_FILE, 'utf8'));
  } catch {
    return false;
  }
  let dir = path.resolve(cwd);
  for (;;) {
    if (table[dir] !== undefined) return !!table[dir];
    const parent = path.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

/**
 * pi 的技能来源（除 loadSkills 自带的 agentDir/skills 与 <cwd>/.pi/skills 之外）：
 *   1. settings.json 的 skills 路径数组
 *   2. 用户级 ~/.agents/skills（Agent Skills 标准目录）
 *   3. 项目级 <dir>/.agents/skills，从 cwd 逐级向上
 * 以上由 pi 的 package-manager 合入，光调 loadSkills 会漏掉。
 */
function skillSourcePaths(cwd, opts) {
  const o = opts || {};
  const home = o.home || HOME;
  const paths = [];
  try {
    const settings = JSON.parse(fs.readFileSync(o.settingsFile || SETTINGS_FILE, 'utf8'));
    for (const p of Array.isArray(settings.skills) ? settings.skills : []) {
      paths.push(path.resolve(String(p).replace(/^~(?=[\/]|$)/, home)));
    }
  } catch {
    /* 无 settings */
  }
  paths.push(path.join(home, '.agents', 'skills'));
  let dir = path.resolve(cwd);
  const seen = new Set();
  for (;;) {
    const cand = path.join(dir, '.agents', 'skills');
    if (!seen.has(cand)) {
      seen.add(cand);
      paths.push(cand);
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // ~/.agents/skills 与 cwd 逐级祖先可能指向同一目录，去重后再返回
  return [...new Set(paths)].filter((p) => fs.existsSync(p));
}

function discoverPromptFiles(cwd, opts) {
  const o = opts || {};
  const agentDir = o.agentDir || PI_AGENT_DIR;
  const trusted = o.trusted != null ? !!o.trusted : isProjectTrusted(cwd, o.trustFile);
  const find = (name) => {
    const project = path.join(cwd, '.pi', name);
    if (trusted && fs.existsSync(project)) return project;
    const global = path.join(agentDir, name);
    return fs.existsSync(global) ? global : null;
  };
  return { trusted, system: find('SYSTEM.md'), append: find('APPEND_SYSTEM.md') };
}

const REPORT_TTL_MS = 10_000;
const CWD_TTL_MS = 60_000;
const reportCache = new Map();
let cwdCache = { expires: 0, data: [] };

/** 候选目录要扫会话头，单独缓存久一点 */
function candidateCwdsCached() {
  if (cwdCache.expires > Date.now()) return cwdCache.data;
  const data = candidateCwds();
  cwdCache = { expires: Date.now() + CWD_TTL_MS, data };
  return data;
}

function clearReportCache() {
  reportCache.clear();
  cwdCache = { expires: 0, data: [] };
}

/**
 * 按 pi 的真实规则重建系统提示词并发起结构分析。
 * 注意：不含其它扩展在 before_agent_start 里的改写（那些是逐轮的）。
 */
/**
 * pi 状态栏的口径：provider 上报的当次用量 = input + output + cacheRead + cacheWrite
 * （见 dist 里的 calculateContextTokens）。它包含工具定义与消息历史，必然高于系统提示词本身，
 * 所以用来和本页的本地估算对账。
 *
 * 实现：走 sessions 的目录索引拿 cwd，只读文件尾部（会话可能几百 MB，不能整份读），
 * 从后往前找最后一条带 usage 的 assistant 消息。
 */
const TAIL_BYTES = 128 * 1024;

function readFileTail(file, bytes) {
  const st = fs.statSync(file);
  const start = Math.max(0, st.size - bytes);
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(st.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    return buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

/** 取文件尾部最近的若干条 assistant usage（会话可能几百 MB，不能整份读） */
function recentAssistantUsages(sessionFile, want) {
  let text;
  try {
    text = readFileTail(sessionFile, TAIL_BYTES);
  } catch {
    return [];
  }
  const lines = text.split(String.fromCharCode(10));
  const out = [];
  for (let i = lines.length - 1; i >= 0 && out.length < want; i--) {
    if (!lines[i]) continue;
    let obj;
    try {
      obj = JSON.parse(lines[i]);
    } catch {
      continue; // 尾部首行可能被截断
    }
    const msg = obj && obj.message;
    if (!msg || msg.role !== 'assistant' || !msg.usage) continue;
    const u = msg.usage;
    const tokens = u.totalTokens || (u.input || 0) + (u.output || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0);
    if (!tokens) continue;
    out.push({
      tokens,
      input: u.input || 0,
      output: u.output || 0,
      cacheRead: u.cacheRead || 0,
      cacheWrite: u.cacheWrite || 0,
      model: msg.model || msg.responseModel || '',
    });
  }
  return out; // 返回值按时间倒序
}

function latestReportedUsage(cwd) {
  let items = [];
  try {
    items = require('./sessions').listSessions({ limit: 80 }).items || [];
  } catch {
    return null;
  }
  const wanted = cwd ? path.resolve(cwd).toLowerCase() : '';
  for (const it of items) {
    if (!it || !it.path) continue;
    if (wanted && it.cwd && path.resolve(it.cwd).toLowerCase() !== wanted) continue;
    const usages = recentAssistantUsages(it.path, 2);
    if (!usages.length) continue;
    const last = usages[0];
    const prev = usages[1];
    // 部分供应商（如本机的 deepseek 中转）上报的 cacheRead 是会话累计值：
    // 连续两轮递增即判定为累计，此时 tokens 不能当上下文用量，改用增量近似。
    const cumulative = !!(prev && last.cacheRead > 0 && last.cacheRead > prev.cacheRead);
    const delta = cumulative ? Math.abs(last.cacheRead - prev.cacheRead) : 0;
    return {
      ...last,
      sessionFile: it.path,
      at: it.mtime ? new Date(it.mtime).toISOString() : null,
      cumulative,
      perTurnApprox: cumulative && delta > 0 ? delta : null,
    };
  }
  return null;
}

async function buildReport(input) {
  const opts = input || {};
  const pi = await loadPi();
  if (!pi) {
    const err = new Error('未找到 @earendil-works/pi-coding-agent，无法重建系统提示词');
    err.status = 503;
    throw err;
  }
  const cwd = path.resolve(opts.cwd || HOME);
  if (!fs.existsSync(cwd)) {
    const err = new Error('目录不存在：' + cwd);
    err.status = 400;
    throw err;
  }
  const cacheKey = cwd + '|' + (opts.useCustomPrompt === false ? '0' : '1');
  const hit = reportCache.get(cacheKey);
  if (hit && hit.expires > Date.now()) return hit.data;

  const contextFiles = pi.loadProjectContextFiles({ cwd, agentDir: PI_AGENT_DIR });
  const skillSources = skillSourcePaths(cwd);
  const loaded = pi.loadSkills({
    cwd,
    agentDir: PI_AGENT_DIR,
    skillPaths: skillSources,
    includeDefaults: true,
  });
  const skills = loaded.skills || [];

  const toolSnippets = {};
  const promptGuidelines = [];
  for (const name of TOOL_NAMES) {
    const c = pi.contributions[name] || {};
    if (c.snippet) toolSnippets[name] = c.snippet;
    if (Array.isArray(c.guidelines)) promptGuidelines.push(...c.guidelines);
  }

  const found = discoverPromptFiles(cwd);
  const customSource = opts.useCustomPrompt === false ? null : found.system;
  const appendSource = found.append;
  const prefix = await loadPromptPrefix();
  const promptHooks = detectPromptHooks();
  const options = {
    cwd,
    selectedTools: TOOL_NAMES,
    toolSnippets,
    promptGuidelines,
    contextFiles,
    skills,
    customPrompt: customSource ? fs.readFileSync(customSource, 'utf8') : undefined,
    appendSystemPrompt: appendSource
      ? fs.readFileSync(appendSource, 'utf8')
      : opts.appendSystemPrompt || undefined,
  };

  const basePrompt = pi.buildSystemPrompt(options);

  // 工具定义的 JSON schema 随请求单独发送（不在系统提示词里），pi 估算上下文时会把它算进去
  let toolsSchema = { items: [], chars: 0, tokens: 0, piTokens: 0, extensionToolsNotCounted: true };
  try {
    const defs = pi.createCodingTools ? pi.createCodingTools(cwd) : [];
    const items = defs.map((t) => {
      const payload = JSON.stringify({ name: t.name, description: t.description, parameters: t.parameters });
      return {
        name: t.name,
        chars: payload.length,
        tokens: estimateTokens(payload),
        piTokens: estimateTokensPi(payload),
      };
    });
    toolsSchema = {
      items,
      chars: items.reduce((n, i) => n + i.chars, 0),
      tokens: items.reduce((n, i) => n + i.tokens, 0),
      piTokens: items.reduce((n, i) => n + i.piTokens, 0),
      extensionToolsNotCounted: true,
    };
  } catch {
    /* 拿不到工具定义就不展示这一块 */
  }

  // 扩展注册的工具：跑一遍扩展拿真实 schema（子进程，失败则退化成只列名字）
  try {
    const probed = await require('./extension-tools').probeExtensionTools();
    if (Array.isArray(probed) && probed.length) {
      const ext = probed.map((t) => ({
        name: t.name,
        chars: t.chars,
        // 扩展 schema 是 ASCII 的 JSON，加权与 pi 口径一致（chars / 4）
        tokens: Math.ceil(t.chars / 4),
        piTokens: Math.ceil(t.chars / 4),
        fromExtension: true,
      }));
      toolsSchema = {
        ...toolsSchema,
        extensionItems: ext,
        extensionChars: ext.reduce((n, i) => n + i.chars, 0),
        extensionTokens: ext.reduce((n, i) => n + i.tokens, 0),
        extensionPiTokens: ext.reduce((n, i) => n + i.piTokens, 0),
        extensionToolsNotCounted: false,
      };
    }
  } catch {
    /* 探测失败：保留「只列名字」的提示 */
  }
  // prompt-prefix 的前置块排在 buildSystemPrompt 产物之前（它的 handler 就是这么拼的）
  const usePrefix = !!(prefix && prefix.text);
  const systemPrompt = usePrefix ? prefix.text + '\n\n' + basePrompt : basePrompt;
  const report = {
    generatedAt: new Date().toISOString(),
    cwd,
    piPackage: pi.root,
    piVersion: pi.version,
    piInstallKind: pi.installKind || null,
    piInstallRoot: pi.installRoot || pi.root,
    customPromptFile: customSource,
    appendPromptFile: appendSource,
    skillSources,
    toolsSchema,
    extensionTools: detectExtensionTools(),
    reportedUsage: latestReportedUsage(cwd),
    projectTrusted: found.trusted,
    skillLoadDiagnostics: (loaded.diagnostics || []).length,
    promptPrefix: prefix
      ? {
          enabled: !!prefix.enabled,
          chars: prefix.chars,
          truncated: !!prefix.truncated,
          files: prefix.files,
          off: prefix.off,
          allCount: (prefix.all || []).length,
          missingDirs: prefix.missingDirs,
          error: prefix.error,
        }
      : null,
    ...analyze(systemPrompt, { ...options, prefixText: usePrefix ? prefix.text : '', prefixItems: (prefix && prefix.items) || [], promptHooks }),
    cwds: candidateCwdsCached(),
    notes: [
      '按 pi 的默认拼装规则重建；prompt-prefix 的前置块已按其 buildBlock() 的真实产物计入',
      '工具集按 pi 默认的 read / bash / edit / write 计算；扩展注册的额外工具（如 subagent）未计入工具定义之和',
      '本页只统计系统提示词：一次请求还要加上工具定义与消息历史，pi 状态栏的数字包含后两者',
      '其它扩展在 before_agent_start 中的逐轮改写未计入（列表见下方“扩展改写”）',
    ],
  };
  reportCache.set(cacheKey, { expires: Date.now() + REPORT_TTL_MS, data: report });
  return report;
}

/** 启动时预热：pi 包首次 import 约 5s，不预热会让页面第一次打开很慢 */
async function warm(cwd) {
  try {
    await buildReport({ cwd: cwd || HOME });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

module.exports = {
  buildReport,
  latestReportedUsage,
  warm,
  analyze,
  estimateTokens,
  estimateTokensPi,
  candidateCwds,
  detectPromptHooks,
  detectExtensionTools,
  discoverPromptFiles,
  skillSourcePaths,
  isProjectTrusted,
  loadPromptPrefix,
  clearReportCache,
  resolvePiRoot,
};
