// ── 提示词结构页 ────────────────────────────────────────────────────────────
// 信息架构参考 pi-context-inspector（pi.dev/packages/pi-context-inspector）：
// Stats 放 token 总数 + 10×5 用量网格；内容按分类分块，每块可展开看原文，
// 支持搜索与复制。单位统一 tokens，字符/行数只作次要信息；颜色只走 --chart-*。
//
// 正文一律「展开时才渲染」，避免首次进入就把整份提示词铺成 DOM。

const PM_TONE = { ext: 4, core: 1, append: 2, context: 3, skills: 5, cwd: 12 };
const PM_ICON = {
  ext: 'plug',
  core: 'braces',
  append: 'plus-circle',
  context: 'folder-tree',
  skills: 'sparkles',
  cwd: 'map-pin',
};
const PM_CELLS = 50; // 10 × 5，每格 2%

function ensurePromptMapState() {
  if (!state.promptMapData) state.promptMapData = null;
  if (!state.promptMapCwd) state.promptMapCwd = '';
  if (!state.promptMapLoading) state.promptMapLoading = false;
  if (state.promptMapQuery == null) state.promptMapQuery = '';
  if (!state.promptMapOpen) state.promptMapOpen = {};
}

function pmInt(n) {
  return new Intl.NumberFormat('en-US').format(Math.round(Number(n) || 0));
}

function pmEsc(s) {
  return typeof esc === 'function' ? esc(String(s == null ? '' : s)) : String(s == null ? '' : s);
}

async function loadPromptMap(force) {
  ensurePromptMapState();
  const root = document.getElementById('pm-root');
  const btn = document.getElementById('pm-refresh');
  if (state.promptMapLoading) return state.promptMapData;
  state.promptMapLoading = true;
  if (btn) btn.classList.add('loading');
  if (force && root && !state.promptMapData) root.innerHTML = '<div class="empty"><p>重新分析中…</p></div>';
  try {
    const cwd = state.promptMapCwd || '';
    const data = await api('/api/prompt-structure' + (cwd ? '?cwd=' + encodeURIComponent(cwd) : ''), {
      timeoutMs: 30000,
    });
    if (!data || typeof data.totalChars !== 'number') throw new Error('结构接口返回空数据');
    state.promptMapData = data;
    state.promptMapCwd = data.cwd;
    state.promptMapOpen = {};
    renderPromptMap();
    return data;
  } catch (e) {
    if (root) root.innerHTML = '<div class="empty"><p>分析失败：' + pmEsc(e.message) + '</p></div>';
    if (typeof showToast === 'function') showToast('提示词结构分析失败: ' + e.message, false);
    return null;
  } finally {
    state.promptMapLoading = false;
    if (btn) btn.classList.remove('loading');
  }
}

function pmCwdOptions(data) {
  const list = (data && data.cwds) || [];
  const current = (data && data.cwd) || state.promptMapCwd;
  const has = list.some((c) => c.cwd === current);
  const all = has || !current ? list : [{ cwd: current, label: current }].concat(list);
  return all
    .map(
      (c) =>
        '<option value="' + pmEsc(c.cwd) + '"' + (c.cwd === current ? ' selected' : '') + '>' +
        pmEsc(c.label) + ' — ' + pmEsc(c.cwd) + '</option>'
    )
    .join('');
}

/** 10×5 = 50 格，按 token 占比分配（最大余数法，保证正好填满） */
function pmCells(d) {
  const total = d.estTokens || 1;
  const rows = (d.sections || []).map((s) => {
    const exact = ((s.tokens || 0) / total) * PM_CELLS;
    return { key: s.key, cells: Math.floor(exact), rest: exact - Math.floor(exact), tokens: s.tokens || 0 };
  });
  let used = rows.reduce((n, r) => n + r.cells, 0);
  const byRest = [...rows].sort((a, b) => b.rest - a.rest || b.tokens - a.tokens);
  let i = 0;
  while (used < PM_CELLS && byRest.length) {
    byRest[i % byRest.length].cells += 1;
    used += 1;
    i += 1;
  }
  const spans = [];
  for (const r of rows) for (let k = 0; k < r.cells; k++) spans.push(r.key);
  return spans.slice(0, PM_CELLS);
}

function pmStatsHtml(d) {
  const ok = d.accountedChars === d.totalChars;
  const cells = pmCells(d)
    .map((key) => '<span class="pm-cell" style="--pm-tone:var(--chart-' + (PM_TONE[key] || 1) + ')"></span>')
    .join('');
  const legend = (d.sections || [])
    .map(
      (s) =>
        '<li class="pm-legend-row" data-key="' + pmEsc(s.key) + '">' +
        '<span class="pm-chip" style="--pm-tone:var(--chart-' + (PM_TONE[s.key] || 1) + ')"></span>' +
        '<span class="pm-legend-name">' + pmEsc(s.label.split('（')[0]) + '</span>' +
        '<span class="pm-legend-tok">' + pmInt(s.tokens) + '</span>' +
        '<span class="pm-legend-pct">' + ((s.tokenShare || 0) * 100).toFixed(1) + '%</span>' +
        '</li>'
    )
    .join('');
  return (
    '<section class="pm-stats">' +
    '<div class="pm-stats-main">' +
    '<p class="pm-eyebrow"><i data-lucide="box"></i> System Prompt</p>' +
    '<div class="pm-total"><span class="pm-total-num">' + pmInt(d.estTokens) + '</span>' +
    '<span class="pm-total-unit">tokens</span></div>' +
    '<p class="pm-total-sub">' + pmInt(d.totalChars) + ' 字符 · ' + pmInt(d.totalLines) + ' 行 · ' +
    '<span class="' + (ok ? 'pm-ok' : 'pm-warn') + '">' + (ok ? '切分自检通过' : '切分自检未通过') + '</span></p>' +
    '<p class="pm-total-sub pm-alt">pi 口径 ' + pmInt(d.piTokens) + ' tokens（字符 ÷ 4，状态栏用的就是这个）</p>' +
    '<p class="pm-cwd-line"><i data-lucide="folder-root"></i><code>' + pmEsc(d.cwd) + '</code>' +
    '<span class="pm-pi-ver">pi ' + pmEsc(d.piVersion) + '</span></p>' +
    (d.customPromptFile
      ? '<p class="pm-cwd-line pm-custom"><i data-lucide="file-warning"></i>自定义提示词（替换内置）：<code>' +
        pmEsc(d.customPromptFile) + '</code></p>'
      : '') +
    (d.appendPromptFile
      ? '<p class="pm-cwd-line"><i data-lucide="file-plus"></i>追加提示词文件（不替换）：<code>' +
        pmEsc(d.appendPromptFile) + '</code></p>'
      : '') +
    '<p class="pm-note">本页主数字按「ASCII 4 字符 / token、CJK 1.5 字符 / token」加权；pi 自己的估算（状态栏、上下文占用）是纯字符 ÷ 4，中文偏多时低于真实值</p>' +
    ((d.notes || []).length
      ? '<ul class="pm-notes">' + d.notes.map((n) => '<li>' + pmEsc(n) + '</li>').join('') + '</ul>'
      : '') +
    '</div>' +
    '<div class="pm-stats-side">' +
    '<div class="pm-grid-wrap">' +
    '<div class="pm-grid-head"><span>构成网格</span><span class="muted">' + PM_CELLS + ' 格 × 2%</span></div>' +
    '<div class="pm-cells">' + cells + '</div>' +
    '</div>' +
    '<ul class="pm-legend">' + legend + '</ul>' +
    '</div>' +
    '</section>'
  );
}

/** 带行号的正文；搜索时只保留命中行 */
function pmLinesHtml(text, key) {
  const lines = String(text == null ? '' : text).split('\n');
  const q = (state.promptMapQuery || '').trim().toLowerCase();
  let hits = 0;
  let body = '';
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    const hit = !!q && ln.toLowerCase().indexOf(q) >= 0;
    if (q && !hit) continue;
    if (hit) hits += 1;
    body +=
      '<div class="pm-line' + (hit ? ' is-hit' : '') + '">' +
      '<span class="pm-ln-no">' + (i + 1) + '</span>' +
      '<span class="pm-ln-text">' + (ln ? pmEsc(ln) : '&nbsp;') + '</span>' +
      '</div>';
  }
  const empty = q && hits === 0 ? '<div class="pm-line-empty">没有匹配的行</div>' : '';
  return '<div class="pm-pre" data-key="' + pmEsc(key) + '" data-hits="' + hits + '">' + body + empty + '</div>';
}

function pmItemsOf(section) {
  return ((section && section.items) || []).filter((it) => it.note !== '包装');
}

/** 分类块内的子块（上下文文件 / 技能），同样懒加载 */
function pmSubHtml(section, it, index) {
  const key = section.key + ':' + index;
  const open = !!state.promptMapOpen[key];
  const extra =
    it.fileTokens > 0
      ? 'SKILL.md ' + pmInt(it.fileChars) + ' 字符 ≈ ' + pmInt(it.fileTokens) + ' tokens（按需读取才进上下文）'
      : it.contentTokens != null
        ? '文件正文 ' + pmInt(it.contentTokens) + ' tokens'
        : '';
  return (
    '<div class="pm-sub' + (open ? ' is-open' : '') + '" data-key="' + pmEsc(key) + '">' +
    '<button type="button" class="pm-sub-head" aria-expanded="' + (open ? 'true' : 'false') + '">' +
    '<i data-lucide="chevron-right" class="pm-chev"></i>' +
    '<span class="pm-sub-name">' + pmEsc(it.label) + '</span>' +
    '<span class="pm-sub-tok">' + pmInt(it.tokens) + '<small>tokens</small></span>' +
    '</button>' +
    (extra ? '<p class="pm-sub-meta">' + pmEsc(extra) + '</p>' : '') +
    '<div class="pm-sub-body' + (open ? '' : ' hidden') + '"></div>' +
    '</div>'
  );
}

function pmSectionInner(section) {
  const items = pmItemsOf(section);
  if (!items.length) return pmLinesHtml(section.content, section.key);
  return items.map((it, i) => pmSubHtml(section, it, i)).join('');
}

function pmSectionsOf(d) {
  return (d && d.sections) || [];
}

function pmFindItem(key) {
  const parts = String(key).split(':');
  const sec = pmSectionsOf(state.promptMapData).find((s) => s.key === parts[0]);
  if (!sec) return null;
  if (parts.length === 1) return sec;
  return pmItemsOf(sec)[Number(parts[1])] || null;
}

function pmBlockHtml(section) {
  const key = section.key;
  const open = !!state.promptMapOpen[key];
  const tone = PM_TONE[key] || 1;
  const meta =
    pmInt(section.chars) + ' 字符 · ' + pmInt(section.lines) + ' 行' +
    (pmItemsOf(section).length ? ' · ' + pmItemsOf(section).length + ' 项' : '');
  return (
    '<article class="pm-block tone-' + tone + (open ? ' is-open' : '') + '" data-key="' + pmEsc(key) + '"' +
    ' style="--pm-tone:var(--chart-' + tone + ')">' +
    '<header class="pm-block-head">' +
    '<button type="button" class="pm-block-toggle" aria-expanded="' + (open ? 'true' : 'false') + '">' +
    '<i data-lucide="' + (PM_ICON[key] || 'square') + '" class="pm-block-icon"></i>' +
    '<i data-lucide="chevron-right" class="pm-chev"></i>' +
    '<span class="pm-chip"></span>' +
    '<span class="pm-block-name">' + pmEsc(section.label) + '</span>' +
    '<span class="pm-block-tok">' + pmInt(section.tokens) + '<small>tokens</small></span>' +
    '<span class="pm-block-pct">' + ((section.tokenShare || 0) * 100).toFixed(1) + '%</span>' +
    '</button>' +
    '<button type="button" class="pm-icon-btn" data-act="copy" title="复制该块原文"><i data-lucide="copy"></i></button>' +
    '</header>' +
    '<div class="pm-block-bar"><i style="width:' + Math.max(0.4, (section.tokenShare || 0) * 100).toFixed(2) + '%"></i></div>' +
    '<p class="pm-block-meta">' + pmEsc(meta) + '</p>' +
    '<div class="pm-block-body' + (open ? '' : ' hidden') + '"></div>' +
    '</article>'
  );
}

function pmBlocksHtml(d) {
  return '<section class="pm-blocks">' + pmSectionsOf(d).map(pmBlockHtml).join('') + '</section>';
}

function pmOverheadHtml(d) {
  const t = d.toolsSchema;
  if (!t || !t.items || !t.items.length) return '';
  const ext = t.extensionItems || [];
  const toolsPi = t.piTokens + (t.extensionPiTokens || 0);
  const toolsWeighted = t.tokens + (t.extensionTokens || 0);
  const sum = (d.piTokens || 0) + toolsPi;
  const sumWeighted = (d.estTokens || 0) + toolsWeighted;
  const rows = [
    { name: '系统提示词（本页统计）', pi: d.piTokens, weighted: d.estTokens, tag: '' },
    ...t.items.map((i) => ({ name: '工具定义 · ' + i.name, pi: i.piTokens, weighted: i.tokens, tag: '内置' })),
    ...ext.map((i) => ({ name: '工具定义 · ' + i.name, pi: i.piTokens, weighted: i.tokens, tag: '扩展' })),
  ]
    .map(
      (r) =>
        '<li class="pm-ov-row"><span class="pm-ov-dot" style="--pm-tone:var(--chart-' +
        (r.tag === '扩展' ? 4 : r.tag === '内置' ? 6 : 1) + ')"></span>' +
        '<div class="pm-ov-body"><div class="pm-ov-name">' + pmEsc(r.name) +
        (r.tag ? '<span class="pm-tag">' + pmEsc(r.tag) + '</span>' : '') + '</div>' +
        '<div class="pm-ov-bar"><i style="width:' +
        Math.max(2, (r.pi / sum) * 100).toFixed(2) + '%"></i></div></div>' +
        '<span class="pm-ov-val">' + pmInt(r.pi) + '<small>pi 口径</small>' +
        '<em>' + pmInt(r.weighted) + ' 加权</em></span></li>'
    )
    .join('');
  const missing = (d.extensionTools || []).filter((n) => !ext.some((e) => e.name === n));
  return (
    '<section class="pm-card" id="pm-card-overhead">' +
    '<div class="pm-card-head"><h3>一次请求的固定开销</h3>' +
    '<p class="pm-card-hint">pi 口径 ' + pmInt(sum) + ' · 加权 ' + pmInt(sumWeighted) + ' · 右列为加权</p></div>' +
    '<ul class="pm-ov">' + rows + '</ul>' +
    pmReportedRow(d, sum) +
    '<p class="pm-note">合计 <b>' + pmInt(sum) + '</b> tokens（pi 口径）＝ 系统提示词 + 全部工具定义（含扩展注册的）。'
      + (missing.length
          ? '以下扩展工具未能取到 schema（探测失败），未计入：<b>' + pmEsc(missing.join('、')) + '</b>。'
          : '')
      + 'pi 状态栏的数字还包含消息历史，所以会略高。</p></section>'
  );
}

/** 和 provider 上报值对账：pi 状态栏取的就是这个数（input + output + cacheRead + cacheWrite） */
function pmReportedRow(d, sum) {
  const u = d.reportedUsage;
  if (!u) return '';
  const label = u.cumulative
    ? 'pi 上报（该 provider 的 cacheRead 似为累计计数器）'
    : 'pi 上报（最近一次会话，含工具与消息）';
  const hint = u.cumulative
    ? '单轮增量 ≈' + pmInt(u.perTurnApprox || 0) + ' tokens，更接近真实上下文'
    : '比本页合计多出的部分 = 扩展工具 + 消息历史';
  return (
    '<div class="pm-reported">' +
    '<div class="pm-reported-main">' +
    '<span class="pm-reported-num">' + pmInt(u.tokens) + '</span>' +
    '<span class="pm-reported-unit">tokens</span>' +
    '</div>' +
    '<div class="pm-reported-meta">' +
    '<p>' + pmEsc(label) + '</p>' +
    '<p class="muted">in ' + pmInt(u.input) + ' · out ' + pmInt(u.output) + ' · cacheRead ' + pmInt(u.cacheRead) +
    (u.model ? ' · ' + pmEsc(u.model) : '') + '</p>' +
    '<p class="muted">' + pmEsc(hint) + '</p>' +
    '</div></div>'
  );
}

function pmChecksHtml(d) {
  const checks = d.checks || [];
  const body = checks.length
    ? checks
        .map(
          (c) =>
            '<li class="pm-check is-' + pmEsc(c.level) + '">' +
            '<i data-lucide="' + (c.level === 'warn' ? 'triangle-alert' : 'info') + '"></i>' +
            '<span>' + pmEsc(c.text) + '</span></li>'
        )
        .join('')
    : '<li class="pm-check is-ok"><i data-lucide="check"></i><span>没有发现需要注意的结构问题</span></li>';
  return (
    '<section class="pm-card"><div class="pm-card-head"><h3>体检</h3>' +
    '<p class="pm-card-hint">' + (checks.length ? checks.length + ' 条' : '全部通过') + '</p></div>' +
    '<ul class="pm-checks">' + body + '</ul></section>'
  );
}

function pmHeadingsHtml(d) {
  const hs = d.headings || [];
  if (!hs.length) return '';
  return (
    '<details class="pm-card pm-headings"><summary><i data-lucide="list-tree"></i> Markdown 标题' +
    ' <span class="muted">' + hs.length + '</span></summary><ul>' +
    hs.slice(0, 80).map((h) => '<li><code>' + pmEsc(h) + '</code></li>').join('') +
    '</ul></details>'
  );
}

function pmHooksHtml(d) {
  const hooks = d.promptHooks || [];
  const pre = d.promptPrefix;
  if (!hooks.length && !pre) {
    return (
      '<section class="pm-card"><div class="pm-card-head"><h3>扩展改写</h3>' +
      '<p class="pm-card-hint">未发现会改写系统提示词的扩展</p></div></section>'
    );
  }
  const rows = hooks
    .map((hk) => {
      const detail = [];
      if (hk.accounted && pre) {
        detail.push(
          '前置注入 ' + pmInt(pre.chars) + ' 字符 · ' +
            (pre.enabled ? '开关开启' : '开关关闭（当前不注入）') +
            (pre.truncated ? ' · 已达 maxBytes 被截断' : '')
        );
        if (pre.files && pre.files.length) {
          detail.push(pre.files.map((f) => f.split(/[\\/]/).pop()).join('、'));
        }
        if (pre.off && pre.off.length) detail.push('未注入 ' + pre.off.length + ' 个（单文件开关 off）');
        if (pre.missingDirs && pre.missingDirs.length) detail.push('目录缺失：' + pre.missingDirs.join('、'));
        if (pre.error) detail.push('读取失败：' + pre.error);
      }
      return (
        '<li class="pm-hook ' + (hk.accounted ? 'is-ok' : 'is-warn') + '">' +
        '<i data-lucide="' + (hk.accounted ? 'plug-zap' : 'triangle-alert') + '"></i>' +
        '<div class="pm-hook-body">' +
        '<div class="pm-hook-head"><b>' + pmEsc(hk.name) + '</b>' +
        '<span class="pm-hook-tag">' + (hk.accounted ? '已计入上方分类' : '未计入') + '</span></div>' +
        (detail.length ? '<p class="pm-hook-detail">' + pmEsc(detail.join(' · ')) + '</p>' : '') +
        '<p class="pm-hook-path" title="' + pmEsc(hk.path) + '">' + pmEsc(hk.path) + '</p>' +
        '</div></li>'
      );
    })
    .join('');
  return (
    '<section class="pm-card"><div class="pm-card-head"><h3>扩展改写</h3>' +
    '<p class="pm-card-hint">在 before_agent_start 里动系统提示词的扩展</p></div>' +
    '<ul class="pm-hooks">' + rows + '</ul></section>'
  );
}

function renderPromptMap() {
  ensurePromptMapState();
  const d = state.promptMapData;
  const root = document.getElementById('pm-root');
  const sel = document.getElementById('pm-cwd');
  if (sel && d) sel.innerHTML = pmCwdOptions(d);
  if (!root || !d) return;
  root.innerHTML =
    pmStatsHtml(d) + pmBlocksHtml(d) + pmOverheadHtml(d) + pmHooksHtml(d) + pmChecksHtml(d) + pmHeadingsHtml(d);
  if (typeof refreshIcons === 'function') refreshIcons(root);
  // 已处于展开态的块（切换 cwd 或搜索后重建）需要立刻补上正文
  for (const key of Object.keys(state.promptMapOpen)) {
    if (state.promptMapOpen[key]) pmFill(key);
  }
}

/** 懒加载：只有展开时才把正文塞进 DOM */
function pmFill(key) {
  const el = document.querySelector(
    '.pm-block[data-key="' + key + '"] .pm-block-body, .pm-sub[data-key="' + key + '"] .pm-sub-body'
  );
  if (!el || el.dataset.filled === '1') return;
  const item = pmFindItem(key);
  if (!item) return;
  if (String(key).indexOf(':') >= 0) {
    el.innerHTML = pmLinesHtml(item.content != null ? item.content : item.description || '', key);
  } else {
    el.innerHTML = pmSectionInner(item);
  }
  el.dataset.filled = '1';
  if (typeof refreshIcons === 'function') refreshIcons(el);
}

function pmToggle(key) {
  const open = !state.promptMapOpen[key];
  state.promptMapOpen[key] = open;
  const el = document.querySelector(
    '.pm-block[data-key="' + key + '"], .pm-sub[data-key="' + key + '"]'
  );
  if (!el) return;
  el.classList.toggle('is-open', open);
  const body = el.querySelector('.pm-block-body, .pm-sub-body');
  const head = el.querySelector('.pm-block-toggle, .pm-sub-head');
  if (head) head.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (!body) return;
  body.classList.toggle('hidden', !open);
  if (open) pmFill(key);
}

async function pmCopy(key) {
  const item = pmFindItem(key);
  if (!item) return;
  const text = item.content != null ? item.content : '';
  try {
    await navigator.clipboard.writeText(text);
    if (typeof showToast === 'function') showToast('已复制 ' + pmInt(text.length) + ' 字符原文', true);
  } catch {
    if (typeof showToast === 'function') showToast('复制失败', false);
  }
}

function bindPromptMapUI() {
  ensurePromptMapState();
  document.getElementById('pm-refresh')?.addEventListener('click', () => loadPromptMap(true));
  document.getElementById('pm-cwd')?.addEventListener('change', (e) => {
    state.promptMapCwd = e.target.value || '';
    state.promptMapData = null;
    loadPromptMap(false);
  });
  document.getElementById('pm-search')?.addEventListener('input', (e) => {
    state.promptMapQuery = e.target.value || '';
    const d = state.promptMapData;
    if (!d) return;
    // 搜索要能看到任何位置的命中：区块与子块一并展开（清空搜索时全部收起）
    const on = !!state.promptMapQuery;
    state.promptMapOpen = {};
    for (const s of pmSectionsOf(d)) {
      if (!on) continue;
      state.promptMapOpen[s.key] = true;
      pmItemsOf(s).forEach((_, i) => {
        state.promptMapOpen[s.key + ':' + i] = true;
      });
    }
    renderPromptMap();
  });
  document.getElementById('pm-expand-all')?.addEventListener('click', () => {
    const d = state.promptMapData;
    if (!d) return;
    const anyClosed = pmSectionsOf(d).some((s) => !state.promptMapOpen[s.key]);
    for (const s of pmSectionsOf(d)) state.promptMapOpen[s.key] = anyClosed;
    renderPromptMap();
  });
  document.getElementById('pm-root')?.addEventListener('click', (e) => {
    const copyBtn = e.target.closest('[data-act="copy"]');
    if (copyBtn) {
      const block = copyBtn.closest('.pm-block');
      if (block) pmCopy(block.dataset.key);
      return;
    }
    const legendRow = e.target.closest('.pm-legend-row');
    if (legendRow) {
      const key = legendRow.dataset.key;
      const block = document.querySelector('.pm-block[data-key="' + key + '"]');
      if (block) {
        if (!state.promptMapOpen[key]) pmToggle(key);
        block.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      return;
    }
    const subHead = e.target.closest('.pm-sub-head');
    if (subHead) {
      const sub = subHead.closest('.pm-sub');
      if (sub) pmToggle(sub.dataset.key);
      return;
    }
    const head = e.target.closest('.pm-block-toggle');
    if (head) {
      const block = head.closest('.pm-block');
      if (block) pmToggle(block.dataset.key);
    }
  });
}

function enterPromptMapRoute() {
  ensurePromptMapState();
  if (state.promptMapData && state.promptMapData.cwd === state.promptMapCwd) {
    renderPromptMap();
    return;
  }
  loadPromptMap(false);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bindPromptMapUI);
} else {
  bindPromptMapUI();
}
