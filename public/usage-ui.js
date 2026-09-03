/* Usage dashboard — agent-usage style UI + multi-layer cache */

const USAGE_LS_KEY = 'pi-manager-usage-cache-v5-cny-label';

function ensureUsageState() {
  if (!state.usageData) state.usageData = null;
  // 默认全部历史（统一 CNY）；近 7 天只有 ~¥200，容易误以为总额错了
  if (state.usageWindow == null) state.usageWindow = 'all';
  // cost | tokens
  if (state.usageSort == null) state.usageSort = 'cost';
  // all | main | subagent
  if (state.usageScope == null) state.usageScope = 'all';
  if (!state._usageCharts) state._usageCharts = {};
  if (state._echartsLoading == null) state._echartsLoading = false;
  if (state._echartsReady == null) {
    state._echartsReady = typeof echarts !== 'undefined';
  }
}

function sortModels(models, sortBy) {
  const arr = Array.isArray(models) ? models.slice() : [];
  if (sortBy === 'tokens') {
    arr.sort(
      (a, b) =>
        (Number(b.totalTokens) || 0) - (Number(a.totalTokens) || 0) ||
        (Number(b.costTotal) || 0) - (Number(a.costTotal) || 0)
    );
  } else {
    arr.sort(
      (a, b) =>
        (Number(b.costTotal) || 0) - (Number(a.costTotal) || 0) ||
        (Number(b.totalTokens) || 0) - (Number(a.totalTokens) || 0)
    );
  }
  return arr;
}

function sortAgents(agents, sortBy) {
  const arr = Array.isArray(agents) ? agents.slice() : [];
  if (sortBy === 'tokens') {
    arr.sort(
      (a, b) =>
        (Number(b.totalTokens) || 0) - (Number(a.totalTokens) || 0) ||
        (Number(b.costTotal) || 0) - (Number(a.costTotal) || 0)
    );
  } else {
    arr.sort(
      (a, b) =>
        (Number(b.costTotal) || 0) - (Number(a.costTotal) || 0) ||
        (Number(b.totalTokens) || 0) - (Number(a.totalTokens) || 0)
    );
  }
  return arr;
}

function fmtTokens(n) {
  const v = Number(n) || 0;
  if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B';
  if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';
  return String(Math.round(v));
}

/** Cost display: sum jsonl totals, label as ¥ (no FX). */
function fmtCost(n, _currency) {
  const v = Number(n) || 0;
  let num;
  if (v >= 100) num = v.toFixed(2);
  else if (v >= 1) num = v.toFixed(3);
  else if (v >= 0.01) num = v.toFixed(4);
  else num = v.toFixed(5);
  return '¥' + num;
}

function fmtSummaryCost(summaryLike) {
  if (!summaryLike) return fmtCost(0);
  let n = summaryLike.costTotalCny;
  if (n == null) n = summaryLike.costTotal;
  if (n == null) n = summaryLike.cost;
  return fmtCost(n);
}

function fmtRowCost(amount, _currency) {
  return fmtCost(amount);
}

function fmtInt(n) {
  return new Intl.NumberFormat('en-US').format(Math.round(Number(n) || 0));
}

function usageQuery(window, force) {
  return (
    '/api/usage?window=' +
    encodeURIComponent(window) +
    (force ? '&force=1' : '')
  );
}

/** Prefer localStorage so cache survives tab/browser restart; fall back to sessionStorage. */
function usageLocalStoreGet() {
  try {
    const raw = localStorage.getItem(USAGE_LOCAL_KEY);
    if (raw) return raw;
  } catch {
    /* ignore */
  }
  try {
    return sessionStorage.getItem(USAGE_LOCAL_KEY);
  } catch {
    return null;
  }
}

function usageLocalStoreSet(raw) {
  try {
    localStorage.setItem(USAGE_LOCAL_KEY, raw);
    return;
  } catch {
    /* quota / private mode */
  }
  try {
    sessionStorage.setItem(USAGE_LOCAL_KEY, raw);
  } catch {
    /* ignore */
  }
}

function readLocalUsageCache(window) {
  try {
    const raw = usageLocalStoreGet();
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if (!obj || !obj.byWindow || !obj.byWindow[window]) return null;
    // client paint cache: 6h (server disk index is source of truth; network still soft-refreshes)
    if (obj.savedAt && Date.now() - obj.savedAt > 6 * 60 * 60_000) return null;
    return obj.byWindow[window];
  } catch {
    return null;
  }
}

function writeLocalUsageCache(window, data) {
  try {
    let obj = { savedAt: Date.now(), byWindow: {} };
    try {
      const raw = usageLocalStoreGet();
      if (raw) obj = Object.assign(obj, JSON.parse(raw));
    } catch {
      /* ignore */
    }
    if (!obj.byWindow) obj.byWindow = {};
    obj.byWindow[window] = data;
    obj.savedAt = Date.now();
    usageLocalStoreSet(JSON.stringify(obj));
  } catch {
    /* quota — ignore */
  }
}

/** CSS color (#rgb/#rrggbb/rgb()) → rgba(..., a) for chart tooltips */
function cssColorToRgba(color, alpha) {
  const c = String(color || '').trim();
  const a = alpha == null ? 0.96 : alpha;
  if (!c) return 'rgba(0, 0, 0, ' + a + ')';
  if (c.startsWith('rgba(')) return c;
  if (c.startsWith('rgb(')) {
    return c.replace(/^rgb\(/, 'rgba(').replace(/\)\s*$/, ', ' + a + ')');
  }
  let hex = c;
  if (hex[0] === '#') hex = hex.slice(1);
  if (hex.length === 3) {
    hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
  }
  if (/^[0-9a-fA-F]{6}$/.test(hex)) {
    const n = parseInt(hex, 16);
    const r = (n >> 16) & 255;
    const g = (n >> 8) & 255;
    const b = n & 255;
    return 'rgba(' + r + ', ' + g + ', ' + b + ', ' + a + ')';
  }
  // named / unresolved → black transparent (echarts still readable)
  return 'rgba(0, 0, 0, ' + a + ')';
}

function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return v || fallback || '';
}

/** Palette from theme --chart-1..12 (accent/ok/warn/danger + distinct hues) */
function usageChartColors() {
  const colors = [];
  for (let i = 1; i <= 12; i++) {
    const c = cssVar('--chart-' + i, '');
    if (c) colors.push(c);
  }
  if (colors.length) return colors;
  // extreme fallback
  return [
    cssVar('--accent', '#5aa2ff'),
    cssVar('--ok', '#22c55e'),
    cssVar('--warn', '#f59e0b'),
    cssVar('--danger', '#ef4444'),
    cssVar('--muted', '#64748b'),
  ];
}

function usageTheme() {
  const text = cssVar('--text', '#e5e7eb');
  const muted = cssVar('--muted', '#94a3b8');
  const grid = cssVar('--line', '#1e293b');
  const bg = cssVar('--bg-1', 'transparent');
  const bg2 = cssVar('--bg-2', bg);
  const accent = cssVar('--accent', '#5aa2ff');
  const ok = cssVar('--ok', '#22c55e');
  const warn = cssVar('--warn', '#f59e0b');
  const danger = cssVar('--danger', '#ef4444');
  const accentRgb = cssVar('--accent-rgb', '90, 162, 255');
  return {
    text,
    muted,
    grid,
    bg,
    accent,
    ok,
    warn,
    danger,
    accentSoft: 'rgba(' + accentRgb + ', 0.55)',
    tooltipBg: cssColorToRgba(bg2, 0.96),
    tooltipBorder: grid,
  };
}

function ensureEcharts() {
  return new Promise((resolve) => {
    if (typeof echarts !== 'undefined') {
      state._echartsReady = true;
      resolve(true);
      return;
    }
    if (state._echartsLoading) {
      const t0 = Date.now();
      const iv = setInterval(() => {
        if (typeof echarts !== 'undefined') {
          clearInterval(iv);
          state._echartsReady = true;
          resolve(true);
        } else if (Date.now() - t0 > 8000) {
          clearInterval(iv);
          resolve(false);
        }
      }, 50);
      return;
    }
    state._echartsLoading = true;
    const s = document.createElement('script');
    s.src = '/vendor/echarts.min.js';
    s.async = true;
    s.onload = () => {
      state._echartsLoading = false;
      state._echartsReady = typeof echarts !== 'undefined';
      resolve(state._echartsReady);
    };
    s.onerror = () => {
      state._echartsLoading = false;
      resolve(false);
    };
    document.head.appendChild(s);
  });
}

function getOrInitChart(id) {
  if (typeof echarts === 'undefined') return null;
  const el = document.getElementById(id);
  if (!el) return null;
  el.classList.remove('is-empty');
  if (!state._usageCharts) state._usageCharts = {};
  // reuse instance if same DOM node
  const existing = state._usageCharts[id];
  if (existing && existing.getDom && existing.getDom() === el) {
    return existing;
  }
  if (existing) {
    try {
      existing.dispose();
    } catch {
      /* ignore */
    }
  }
  const chart = echarts.init(el, null, { renderer: 'canvas' });
  state._usageCharts[id] = chart;
  return chart;
}

function setUsageChartEmpty(id, message) {
  const el = document.getElementById(id);
  if (!el) return;
  const existing = state._usageCharts && state._usageCharts[id];
  if (existing) {
    try {
      existing.dispose();
    } catch {
      /* ignore */
    }
    delete state._usageCharts[id];
  }
  el.classList.add('is-empty');
  el.innerHTML =
    '<div class="usage-chart-empty"><span class="muted">' +
    esc(message || '暂无数据') +
    '</span></div>';
}

function disposeUsageCharts() {
  const map = state._usageCharts || {};
  Object.keys(map).forEach((k) => {
    try {
      map[k].dispose();
    } catch {
      /* ignore */
    }
    delete map[k];
  });
}

async function loadUsage(force) {
  ensureUsageState();
  const root = $('#usage-root');
  const btn = $('#usage-refresh');
  if (btn) btn.classList.add('loading');

  // 1) instant paint from sessionStorage
  if (!force) {
    const local = readLocalUsageCache(state.usageWindow);
    if (local) {
      state.usageData = { ...local, cached: true, cacheLayer: 'session' };
      renderUsagePage();
    } else if (!state.usageData && root) {
      root.innerHTML =
        '<div class="empty"><p>统计中…（首次会建磁盘缓存，之后会快很多）</p></div>';
    }
  } else if (root && !state.usageData) {
    root.innerHTML = '<div class="empty"><p>强制刷新中…</p></div>';
  }

  try {
    const data = await api(usageQuery(state.usageWindow, force));
    state.usageData = data;
    state.usageFetchedAt = Date.now();
    writeLocalUsageCache(state.usageWindow, data);
    renderUsagePage();
    return data;
  } catch (e) {
    if (root && !state.usageData) {
      root.innerHTML =
        '<div class="empty"><p>加载失败：' + esc(e.message) + '</p></div>';
    } else if (typeof showToast === 'function') {
      showToast('用量刷新失败: ' + e.message, false);
    }
    throw e;
  } finally {
    if (btn) btn.classList.remove('loading');
  }
}

async function loadUsageQuiet(window) {
  ensureUsageState();
  const w = window || state.usageWindow || 'all';
  if (state.usageFetchedAt == null) state.usageFetchedAt = 0;
  if (state._usageQuietLoading == null) state._usageQuietLoading = false;

  // prefer local / memory cache for dash card
  if (!state.usageData) {
    const local = readLocalUsageCache(w);
    if (local) {
      state.usageData = { ...local, cached: true, cacheLayer: 'session' };
      state.usageWindow = w;
    }
  }

  // skip network if memory data is fresh (same window)
  const USAGE_SOFT_TTL_MS = 60_000;
  if (
    state.usageData &&
    state.usageWindow === w &&
    Date.now() - (state.usageFetchedAt || 0) < USAGE_SOFT_TTL_MS
  ) {
    return state.usageData;
  }
  if (state._usageQuietLoading) return state.usageData || null;
  state._usageQuietLoading = true;
  try {
    const data = await api(usageQuery(w, false));
    state.usageData = data;
    state.usageWindow = w;
    state.usageFetchedAt = Date.now();
    writeLocalUsageCache(w, data);
    return data;
  } catch {
    return state.usageData || null;
  } finally {
    state._usageQuietLoading = false;
  }
}

function usageDashHeroHtml() {
  ensureUsageState();
  const u = state.usageData;
  if (!u) {
    return (
      '<section class="dash-usage-hero is-loading">' +
      '<div class="dash-usage-hero-head">' +
      '<div><p class="dash-eyebrow">Usage</p><h2>用量概览</h2></div>' +
      '<a class="btn ghost sm" href="#/usage">完整分析</a></div>' +
      '<div class="dash-empty-block compact">' +
      '<p class="dash-empty-desc">正在汇总会话用量…</p>' +
      '</div></section>'
    );
  }

  // snapshots.* 与 global 均为统一 CNY 后的 summary
  const today = u.today || u.snapshots?.today || {};
  const week = u.snapshots?.week || {};
  const month = u.snapshots?.month || {};
  const all = u.global || u.snapshots?.all || {};
  // 若当前请求窗就是 all，顶栏 costTotal 与 global 一致
  const allView =
    u.window === 'all'
      ? {
          costTotal: u.costTotal,
          costTotalCny: u.costTotalCny != null ? u.costTotalCny : u.costTotal,
          totalTokens: u.totalTokens,
          requests: u.requests,
          costByCurrency: u.costByCurrency,
        }
      : all;
  const todayModels = sortModels(
    (u.today && u.today.models) || [],
    'cost'
  ).slice(0, 4);
  const topModels = sortModels(u.globalModels || u.models || [], 'cost').slice(
    0,
    5
  );
  const maxTop = topModels.reduce(
    (m, x) => Math.max(m, Number(x.costTotal) || 0),
    0
  );

  // tone: primary | secondary | tertiary | cache…
  const metric = (label, value, hint, tone) =>
    '<div class="dash-metric' +
    (tone ? ' is-' + tone : '') +
    '">' +
    '<div class="dash-metric-label">' +
    esc(label) +
    '</div>' +
    '<div class="dash-metric-value">' +
    value +
    '</div>' +
    (hint ? '<div class="dash-metric-hint">' + hint + '</div>' : '') +
    '</div>';

  const todayList = todayModels.length
    ? '<ul class="dash-usage-models">' +
      todayModels
        .map(
          (m) =>
            '<li><code>' +
            esc(m.key || m.model) +
            '</code><span>' +
            fmtRowCost(m.costTotal, m.currency) +
            '</span></li>'
        )
        .join('') +
      '</ul>'
    : '<p class="dash-empty-inline">今天还没有模型用量</p>';

  const bars = topModels.length
    ? '<div class="dash-usage-bars">' +
      topModels
        .map((m) => {
          const cost = Number(m.costTotal) || 0;
          const pct = maxTop > 0 ? Math.round((cost / maxTop) * 100) : 0;
          return (
            '<div class="dash-usage-bar-row">' +
            '<div class="dash-usage-bar-label" title="' +
            esc(m.key || '') +
            '">' +
            esc(m.key || m.model) +
            '</div>' +
            '<div class="dash-usage-bar-track"><i style="width:' +
            pct +
            '%"></i></div>' +
            '<div class="dash-usage-bar-val">' +
            fmtRowCost(cost, m.currency) +
            '</div></div>'
          );
        })
        .join('') +
      '</div>'
    : '<p class="dash-empty-inline">暂无模型排行</p>';

  const hitAllRaw =
    typeof cacheHitRate === 'function'
      ? cacheHitRate(u, 'all')
      : u.cacheHitRate != null
        ? Number(u.cacheHitRate).toFixed(1)
        : '—';
  const hitMain =
    typeof cacheHitRate === 'function'
      ? cacheHitRate(u, 'main')
      : u.mainCacheHitRate != null
        ? Number(u.mainCacheHitRate).toFixed(1)
        : '—';
  const hitSub =
    typeof cacheHitRate === 'function'
      ? cacheHitRate(u, 'subagent')
      : u.subagentCacheHitRate != null
        ? Number(u.subagentCacheHitRate).toFixed(1)
        : '—';

  // 档位影响数字色与极轻背景晕染
  const hitNum = parseFloat(hitAllRaw);
  let hitLevel = 'none';
  if (Number.isFinite(hitNum)) {
    if (hitNum >= 70) hitLevel = 'high';
    else if (hitNum >= 40) hitLevel = 'mid';
    else if (hitNum >= 15) hitLevel = 'low';
    else hitLevel = 'poor';
  }
  const hitTone = 'cache hit-' + hitLevel;

  return (
    '<section class="dash-usage-hero">' +
    '<div class="dash-usage-hero-head">' +
    '<div><p class="dash-eyebrow">Usage</p><h2>用量概览</h2></div>' +
    '<a class="btn ghost sm" href="#/usage">完整分析</a></div>' +
    '<div class="dash-metric-row">' +
    metric(
      '今日',
      fmtSummaryCost(today),
      fmtTokens(today.totalTokens) + ' · ' + fmtInt(today.requests) + ' 次',
      'primary'
    ) +
    metric(
      '缓存命中',
      hitAllRaw === '—' ? '—' : hitAllRaw + '%',
      '主 ' + hitMain + '% · 子 ' + hitSub + '%',
      hitTone
    ) +
    metric(
      '近 7 天',
      fmtSummaryCost(week),
      fmtTokens(week.totalTokens) + ' · ' + fmtInt(week.requests) + ' 次',
      'secondary'
    ) +
    metric(
      '全局',
      fmtSummaryCost(allView),
      fmtTokens(allView.totalTokens) + ' · ' + fmtInt(allView.requests) + ' 次',
      'secondary'
    ) +
    '</div>' +
    '<div class="dash-usage-split">' +
    '<div class="dash-usage-panel">' +
    '<div class="dash-usage-panel-head"><h3>今天用了谁</h3><span class="muted">' +
    fmtSummaryCost(today) +
    '</span></div>' +
    todayList +
    '</div>' +
    '<div class="dash-usage-panel">' +
    '<div class="dash-usage-panel-head"><h3>全局费用 Top</h3><span class="muted">分项·勿混加</span></div>' +
    bars +
    '</div>' +
    '<div class="dash-usage-panel compact">' +
    '<div class="dash-usage-panel-head"><h3>结构</h3></div>' +
    '<div class="dash-usage-kv">' +
    '<div><span>主会话</span><strong>' +
    fmtSummaryCost({
      costByCurrency: u.mainCostByCurrency,
      costTotal: u.mainCost,
      costMixed: u.costMixed,
    }) +
    '</strong></div>' +
    '<div><span>子代理</span><strong>' +
    fmtSummaryCost({
      costByCurrency: u.subagentCostByCurrency,
      costTotal: u.subagentCost,
      costMixed: u.costMixed,
    }) +
    '</strong></div>' +
    '<div><span>主会话 Tokens</span><strong>' +
    fmtTokens(u.mainTokens) +
    '</strong></div>' +
    '<div><span>子代理 Tokens</span><strong>' +
    fmtTokens(u.subagentTokens) +
    '</strong></div>' +
    '</div></div>' +
    '</div></section>'
  );
}

function usageDashCardHtml() {
  // keep a compact fallback if something still calls the old helper
  return usageDashHeroHtml();
}

function modelTable(models, emptyText, sortBy) {
  models = sortModels(models, sortBy || state.usageSort || 'cost');
  if (!models.length) {
    return (
      '<p class="muted usage-table-empty">' +
      esc(emptyText || '无记录') +
      '</p>'
    );
  }
  const byTokens = (sortBy || state.usageSort) === 'tokens';
  const maxBar = models.reduce(
    (m, x) =>
      Math.max(
        m,
        byTokens ? Number(x.totalTokens) || 0 : Number(x.costTotal) || 0
      ),
    0
  );
  const rows = models
    .map((m) => {
      const barVal = byTokens
        ? Number(m.totalTokens) || 0
        : Number(m.costTotal) || 0;
      const pct = maxBar > 0 ? Math.round((barVal / maxBar) * 100) : 0;
      const sub =
        m.subagentRequests > 0
          ? ' <span class="badge" title="含子代理 turns">sub ' +
            fmtInt(m.subagentRequests) +
            '</span>'
          : '';
      return (
        '<tr>' +
        '<td><code class="usage-model-id">' +
        esc(m.key || m.provider + '/' + m.model) +
        '</code>' +
        sub +
        '<div class="usage-mini-bar"><i style="width:' +
        pct +
        '%"></i></div></td>' +
        '<td class="num">' +
        fmtInt(m.requests) +
        '</td>' +
        '<td class="num">' +
        fmtTokens(m.totalTokens) +
        '</td>' +
        '<td class="num muted">' +
        fmtInt(m.input) +
        ' / ' +
        fmtInt(m.output) +
        '</td>' +
        '<td class="num">' +
        fmtRowCost(m.costTotal, m.currency) +
        '</td>' +
        '</tr>'
      );
    })
    .join('');
  return (
    '<div class="usage-table-wrap"><table class="table usage-table"><thead><tr>' +
    '<th>模型' +
    (byTokens ? ' · 按 Tokens' : ' · 按费用') +
    '</th><th class="num">请求</th><th class="num">Tokens</th><th class="num">In / Out</th><th class="num">费用</th>' +
    '</tr></thead><tbody>' +
    rows +
    '</tbody></table></div>'
  );
}

function agentTable(agents, emptyText, sortBy) {
  agents = sortAgents(agents, sortBy || state.usageSort || 'cost');
  if (!agents.length) {
    return (
      '<p class="muted usage-table-empty">' +
      esc(emptyText || '无子代理用量') +
      '</p>'
    );
  }
  const byTokens = (sortBy || state.usageSort) === 'tokens';
  const maxBar = agents.reduce(
    (m, x) =>
      Math.max(
        m,
        byTokens ? Number(x.totalTokens) || 0 : Number(x.costTotal) || 0
      ),
    0
  );
  const rows = agents
    .map((a) => {
      const barVal = byTokens
        ? Number(a.totalTokens) || 0
        : Number(a.costTotal) || 0;
      const pct = maxBar > 0 ? Math.round((barVal / maxBar) * 100) : 0;
      return (
        '<tr>' +
        '<td><strong>' +
        esc(a.agent) +
        '</strong>' +
        '<div class="usage-mini-bar"><i style="width:' +
        pct +
        '%"></i></div></td>' +
        '<td class="num">' +
        fmtInt(a.requests) +
        '</td>' +
        '<td class="num">' +
        fmtInt(a.models) +
        '</td>' +
        '<td class="num">' +
        fmtTokens(a.totalTokens) +
        '</td>' +
        '<td class="num">' +
        fmtRowCost(a.costTotal, a.currency) +
        '</td>' +
        '</tr>'
      );
    })
    .join('');
  return (
    '<div class="usage-table-wrap"><table class="table usage-table"><thead><tr>' +
    '<th>子代理</th><th class="num">Turns</th><th class="num">模型数</th><th class="num">Tokens</th><th class="num">费用</th>' +
    '</tr></thead><tbody>' +
    rows +
    '</tbody></table></div>'
  );
}

function providerTable(providers) {
  providers = Array.isArray(providers) ? providers : [];
  if (!providers.length) {
    return '<p class="muted usage-table-empty">无供应商数据</p>';
  }
  const rows = providers
    .map(
      (p) =>
        '<tr>' +
        '<td><strong>' +
        esc(p.provider) +
        '</strong></td>' +
        '<td class="num">' +
        fmtInt(p.requests) +
        '</td>' +
        '<td class="num">' +
        fmtInt(p.models) +
        '</td>' +
        '<td class="num">' +
        fmtTokens(p.totalTokens) +
        '</td>' +
        '<td class="num">' +
        fmtRowCost(p.costTotal, p.currency) +
        '</td>' +
        '</tr>'
    )
    .join('');
  return (
    '<div class="usage-table-wrap"><table class="table usage-table"><thead><tr>' +
    '<th>供应商</th><th class="num">请求</th><th class="num">模型数</th><th class="num">Tokens</th><th class="num">费用</th>' +
    '</tr></thead><tbody>' +
    rows +
    '</tbody></table></div>'
  );
}

function renderUsageCharts(u) {
  if (typeof echarts === 'undefined') return;
  const tc = usageTheme();
  const colors = usageChartColors();
  const sortBy = state.usageSort || 'cost';
  const byTokens = sortBy === 'tokens';
  const scope = state.usageScope || 'all';
  const models = sortModels(
    filterModelsByScope(u.models || [], scope).filter(
      (m) => (Number(m.costTotal) || 0) > 0 || (Number(m.totalTokens) || 0) > 0
    ),
    sortBy
  );
  const globalModels = sortModels(
    filterModelsByScope(u.globalModels || u.models || [], scope).filter(
      (m) =>
        byTokens
          ? (Number(m.totalTokens) || 0) > 0
          : (Number(m.costTotal) || 0) > 0
    ),
    sortBy
  );
  const byDay = u.byDay || [];
  const colorMap = {};
  models.forEach((m, i) => {
    colorMap[m.key] = colors[i % colors.length];
  });

  // 完整精度，避免 toFixed 累加后圆环合不拢；过小扇区并入「其他」
  const rawPie = models
    .map((m) => ({
      name: m.key,
      value: byTokens
        ? Number(m.totalTokens) || 0
        : Number(m.costTotal) || 0,
      itemStyle: { color: colorMap[m.key] },
    }))
    .filter((d) => d.value > 0)
    .sort((a, b) => b.value - a.value);
  const totalPie = rawPie.reduce((s, d) => s + d.value, 0);
  let pieData = rawPie;
  if (totalPie > 0 && rawPie.length > 1) {
    const major = [];
    let other = 0;
    rawPie.forEach((d) => {
      // <1.2% 的扇区合并，避免碎切片把环「撕开」
      if (d.value / totalPie < 0.012) other += d.value;
      else major.push(d);
    });
    if (other > 0) {
      major.push({
        name: '其他',
        value: other,
        itemStyle: { color: tc.muted },
      });
    }
    pieData = major;
  }
  if (!pieData.length) {
    setUsageChartEmpty('usage-chart-pie', '暂无模型占比数据');
  } else {
  const pie = getOrInitChart('usage-chart-pie');
  if (pie) {
    pie.setOption(
      {
        backgroundColor: 'transparent',
        animation: false,
        textStyle: { color: tc.text, fontFamily: 'inherit' },
        tooltip: {
          trigger: 'item',
          backgroundColor: tc.tooltipBg,
          borderColor: tc.tooltipBorder,
          borderWidth: 1,
          extraCssText:
            'box-shadow: 0 8px 24px rgba(0,0,0,0.18); border-radius: 8px;',
          textStyle: { color: tc.text, fontSize: 12 },
          formatter: (p) =>
            '<b style="color:' +
            tc.text +
            '">' +
            esc(p.name) +
            '</b><br/><span style="color:' +
            tc.muted +
            '">' +
            (byTokens ? fmtTokens(p.value) + ' tok' : fmtCost(p.value)) +
            ' (' +
            p.percent +
            '%)</span>',
        },
        legend: {
          type: 'scroll',
          top: 0,
          left: 'center',
          textStyle: { color: tc.muted, fontSize: 11 },
          pageTextStyle: { color: tc.muted },
          formatter: (name) =>
            name.length > 28 ? name.slice(0, 25) + '…' : name,
        },
        series: [
          {
            type: 'pie',
            radius: ['44%', '70%'],
            center: ['50%', '58%'],
            // 不要 border/pad/radius，否则扇区之间会留缝，看起来像没闭合
            padAngle: 0,
            itemStyle: {
              borderRadius: 0,
              borderWidth: 0,
            },
            emphasis: {
              scale: false,
              itemStyle: { shadowBlur: 0 },
            },
            label: {
              show: true,
              formatter: (p) => (p.percent >= 6 ? p.percent + '%' : ''),
              color: tc.muted,
              fontSize: 11,
            },
            labelLine: { length: 8, length2: 6 },
            data: pieData,
            stillShowZeroSum: false,
            minShowLabelAngle: 0,
          },
        ],
      },
      true
    );
  }
  }

  if (!byDay.length) {
    setUsageChartEmpty('usage-chart-cost', '暂无费用趋势');
    setUsageChartEmpty('usage-chart-tokens', '暂无 Token 组成');
  } else {
  const costChart = getOrInitChart('usage-chart-cost');
  if (costChart) {
    costChart.setOption(
      {
        backgroundColor: 'transparent',
        animation: false,
        textStyle: { color: tc.text, fontFamily: 'inherit' },
        grid: { left: 52, right: 16, top: 28, bottom: 36 },
        tooltip: {
          trigger: 'axis',
          backgroundColor: tc.tooltipBg,
          borderColor: tc.tooltipBorder,
          borderWidth: 1,
          extraCssText:
            'box-shadow: 0 8px 24px rgba(0,0,0,0.18); border-radius: 8px;',
          textStyle: { color: tc.text, fontSize: 12 },
          axisPointer: { type: 'shadow' },
          formatter: (params) => {
            const p = params[0];
            if (!p) return '';
            return (
              '<b style="color:' +
              tc.text +
              '">' +
              esc(p.axisValue) +
              '</b><br/><span style="color:' +
              tc.muted +
              '">费用 ' +
              (function () {
                const day = byDay[p.dataIndex];
                if (day && day.costByCurrency) return fmtSummaryCost(day);
                if (day && day.costMixed) return '混币';
                return fmtCost(p.value, day && day.costCurrency);
              })() +
              '<br/>Tokens ' +
              fmtTokens(byDay[p.dataIndex]?.totalTokens || 0) +
              '</span>'
            );
          },
        },
        xAxis: {
          type: 'category',
          data: byDay.map((d) => String(d.day).slice(5)),
          axisLabel: { color: tc.muted },
          axisLine: { lineStyle: { color: tc.grid } },
        },
        yAxis: {
          type: 'value',
          axisLabel: {
            color: tc.muted,
            formatter: (v) => '¥' + (Number(v) >= 1 ? Number(v).toFixed(2) : Number(v).toFixed(4)),
          },
          splitLine: { lineStyle: { color: tc.grid, type: 'dashed' } },
        },
        series: [
          {
            type: 'bar',
            data: byDay.map((d) => +Number(d.costTotal || 0).toFixed(4)),
            barMaxWidth: 36,
            itemStyle: {
              borderRadius: [6, 6, 0, 0],
              color: tc.accent,
            },
          },
        ],
      },
      true
    );
  }

  const tokChart = getOrInitChart('usage-chart-tokens');
  if (tokChart) {
    tokChart.setOption(
      {
        backgroundColor: 'transparent',
        animation: false,
        textStyle: { color: tc.text, fontFamily: 'inherit' },
        grid: { left: 52, right: 16, top: 36, bottom: 36 },
        tooltip: {
          trigger: 'axis',
          backgroundColor: tc.tooltipBg,
          borderColor: tc.tooltipBorder,
          borderWidth: 1,
          extraCssText:
            'box-shadow: 0 8px 24px rgba(0,0,0,0.18); border-radius: 8px;',
          textStyle: { color: tc.text, fontSize: 12 },
          axisPointer: { type: 'shadow' },
        },
        legend: { top: 0, textStyle: { color: tc.muted, fontSize: 11 } },
        xAxis: {
          type: 'category',
          data: byDay.map((d) => String(d.day).slice(5)),
          axisLabel: { color: tc.muted },
          axisLine: { lineStyle: { color: tc.grid } },
        },
        yAxis: {
          type: 'value',
          axisLabel: { color: tc.muted, formatter: (v) => fmtTokens(v) },
          splitLine: { lineStyle: { color: tc.grid, type: 'dashed' } },
        },
        series: [
          {
            name: 'Input',
            type: 'bar',
            stack: 'tok',
            barMaxWidth: 36,
            itemStyle: { color: tc.accent },
            data: byDay.map((d) => d.input || 0),
          },
          {
            name: 'Output',
            type: 'bar',
            stack: 'tok',
            barMaxWidth: 36,
            itemStyle: { color: tc.ok },
            data: byDay.map((d) => d.output || 0),
          },
        ],
      },
      true
    );
  }
  }

  const top = (globalModels.length ? globalModels : models)
    .slice(0, 10)
    .reverse();
  if (!top.length) {
    setUsageChartEmpty('usage-chart-rank', '暂无全局模型排行');
  } else {
  const rank = getOrInitChart('usage-chart-rank');
  if (rank) {
    rank.setOption(
      {
        backgroundColor: 'transparent',
        animation: false,
        grid: { left: 120, right: 48, top: 8, bottom: 8 },
        tooltip: {
          trigger: 'axis',
          axisPointer: { type: 'shadow' },
          backgroundColor: tc.tooltipBg,
          borderColor: tc.tooltipBorder,
          borderWidth: 1,
          extraCssText:
            'box-shadow: 0 8px 24px rgba(0,0,0,0.18); border-radius: 8px;',
          textStyle: { color: tc.text, fontSize: 12 },
          formatter: (params) => {
            const p = params[0];
            if (!p) return '';
            return (
              '<b style="color:' +
              tc.text +
              '">' +
              esc(p.name) +
              '</b><br/><span style="color:' +
              tc.muted +
              '">' +
              (byTokens ? fmtTokens(p.value) : fmtCost(p.value)) +
              '</span>'
            );
          },
        },
        xAxis: {
          type: 'value',
          axisLabel: {
            color: tc.muted,
            formatter: (v) =>
              byTokens
                ? fmtTokens(v)
                : Number(v) >= 1
                  ? Number(v).toFixed(2)
                  : Number(v).toFixed(4),
          },
          splitLine: { lineStyle: { color: tc.grid, type: 'dashed' } },
        },
        yAxis: {
          type: 'category',
          data: top.map((m) => m.key),
          axisLabel: {
            color: tc.muted,
            fontSize: 11,
            width: 110,
            overflow: 'truncate',
          },
        },
        series: [
          {
            type: 'bar',
            data: top.map((m, i) => ({
              value: byTokens
                ? Number(m.totalTokens) || 0
                : +Number(m.costTotal || 0).toFixed(4),
              itemStyle: {
                color: colors[(top.length - 1 - i) % colors.length],
                borderRadius: [0, 6, 6, 0],
              },
            })),
            barMaxWidth: 18,
            label: {
              show: true,
              position: 'right',
              color: tc.muted,
              fontSize: 11,
              formatter: (p) =>
                byTokens ? fmtTokens(p.value) : fmtCost(p.value),
            },
          },
        ],
      },
      true
    );
  }
  }
}

function cacheHitRate(u, scope) {
  // prefer backend-computed rates
  if (scope === 'main' && u.mainCacheHitRate != null) {
    return Number(u.mainCacheHitRate).toFixed(1);
  }
  if (scope === 'subagent' && u.subagentCacheHitRate != null) {
    return Number(u.subagentCacheHitRate).toFixed(1);
  }
  if (scope === 'all' && u.cacheHitRate != null) {
    return Number(u.cacheHitRate).toFixed(1);
  }
  let cr = 0;
  let inn = 0;
  if (scope === 'main') {
    cr = Number(u.mainCacheRead) || 0;
    inn = Number(u.mainInput) || 0;
  } else if (scope === 'subagent') {
    cr = Number(u.subagentCacheRead) || 0;
    inn = Number(u.subagentInput) || 0;
  } else {
    cr = Number(u.cacheRead) || 0;
    inn = Number(u.input) || 0;
  }
  const denom = cr + inn;
  if (!denom) return '0.0';
  return ((cr / denom) * 100).toFixed(1);
}

function filterModelsByScope(models, scope) {
  const arr = Array.isArray(models) ? models : [];
  if (scope === 'main') {
    return arr.filter((m) => (Number(m.mainRequests) || 0) > 0);
  }
  if (scope === 'subagent') {
    return arr.filter((m) => (Number(m.subagentRequests) || 0) > 0);
  }
  return arr;
}

function scopeKpis(u, scope) {
  if (scope === 'main') {
    return {
      cost: u.mainCost,
      costByCurrency: u.mainCostByCurrency,
      costMixed: u.costMixed,
      costCurrency: u.costCurrency,
      tokens: u.mainTokens,
      requests: u.mainRequests,
      cacheHit: cacheHitRate(u, 'main'),
      label: '主会话',
    };
  }
  if (scope === 'subagent') {
    return {
      cost: u.subagentCost,
      costByCurrency: u.subagentCostByCurrency,
      costMixed: u.costMixed,
      costCurrency: u.costCurrency,
      tokens: u.subagentTokens,
      requests: u.subagentRequests,
      cacheHit: cacheHitRate(u, 'subagent'),
      label: '子代理',
    };
  }
  return {
    cost: u.costTotal,
    costByCurrency: u.costByCurrency,
    costMixed: u.costMixed,
    costCurrency: u.costCurrency,
    tokens: u.totalTokens,
    requests: u.requests,
    cacheHit: cacheHitRate(u, 'all'),
    label: '全部',
  };
}

function statCard(label, value, tone) {
  return (
    '<div class="usage-stat-card tone-' +
    esc(tone || 'blue') +
    '">' +
    '<div class="label usage-stat-label">' +
    esc(label) +
    '</div>' +
    '<div class="value usage-stat-value">' +
    value +
    '</div></div>'
  );
}

function renderUsagePage() {
  const root = $('#usage-root');
  if (!root) return;
  ensureUsageState();
  const u = state.usageData;
  if (!u) {
    root.innerHTML = '<div class="empty"><p>加载中…</p></div>';
    return;
  }

  $$('#usage-presets .usage-preset').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.window === state.usageWindow);
  });

  const snaps = u.snapshots || {};
  const global = u.global || snaps.all || {};
  const todaySum = snaps.today || {};
  const todayModels = (u.today && u.today.models) || [];
  const globalModels =
    u.globalModels || (u.window === 'all' ? u.models : []) || [];
  const globalProviders =
    u.globalProviders || (u.window === 'all' ? u.providers : []) || [];
  const globalAgents = u.globalAgents || [];
  const windowAgents = u.agents || [];
  const sortBy = state.usageSort || 'cost';
  const byTokens = sortBy === 'tokens';
  const scope = state.usageScope || 'all';
  const kpis = scopeKpis(u, scope);
  const scopedModels = filterModelsByScope(u.models, scope);
  const scopedGlobalModels = filterModelsByScope(globalModels, scope);
  const scopedTodayModels = filterModelsByScope(todayModels, scope);

  const cacheLabel = u.cached
    ? u.cacheLayer === 'session'
      ? '浏览器缓存'
      : u.cacheLayer === 'report'
        ? '内存缓存'
        : '缓存'
    : u.cacheLayer === 'disk'
      ? '磁盘命中'
      : u.cacheLayer === 'mixed'
        ? '增量更新'
        : u.cacheLayer === 'full'
          ? '全量扫描'
          : '';

  root.innerHTML =
    '<div class="usage-toolbar-row">' +
    '<div class="usage-filters">' +
    '<div class="usage-sort usage-scope-group" role="group" aria-label="范围">' +
    '<span class="usage-filter-label">范围</span>' +
    '<button type="button" class="usage-scope-btn' +
    (scope === 'all' ? ' active' : '') +
    '" data-scope="all">全部</button>' +
    '<button type="button" class="usage-scope-btn' +
    (scope === 'main' ? ' active' : '') +
    '" data-scope="main">主会话</button>' +
    '<button type="button" class="usage-scope-btn' +
    (scope === 'subagent' ? ' active' : '') +
    '" data-scope="subagent">子代理</button>' +
    '</div>' +
    '<div class="usage-sort usage-sort-group" role="group" aria-label="排序">' +
    '<span class="usage-filter-label">排序</span>' +
    '<button type="button" class="usage-sort-btn' +
    (byTokens ? '' : ' active') +
    '" data-sort="cost">按费用</button>' +
    '<button type="button" class="usage-sort-btn' +
    (byTokens ? ' active' : '') +
    '" data-sort="tokens">按 Tokens</button>' +
    '</div></div>' +
    '<span class="muted usage-toolbar-meta">缓存命中 ' +
    kpis.cacheHit +
    '% · ' +
    esc(kpis.label) +
    (u.subagentRequests
      ? ' · 子代理 ' +
        fmtInt(u.subagentRequests) +
        ' turns / ' +
        fmtSummaryCost({
          costByCurrency: u.subagentCostByCurrency,
          costTotal: u.subagentCost,
          costMixed: u.costMixed,
        })
      : '') +
    '</span></div>' +
    '<p class="usage-cache-detail muted">费用 = jsonl 原值累加 · 显示 ¥</p>' +
    '<div class="usage-stats">' +
    statCard(kpis.label + '费用', fmtSummaryCost(kpis), 'blue') +
    statCard(kpis.label + ' Tokens', fmtTokens(kpis.tokens), 'green') +
    statCard('请求/Turns', fmtInt(kpis.requests), 'orange') +
    statCard('缓存命中率', kpis.cacheHit + '%', 'cyan') +
    statCard(
      '主会话缓存',
      cacheHitRate(u, 'main') + '%',
      'accent'
    ) +
    statCard(
      '子代理缓存',
      cacheHitRate(u, 'subagent') + '%',
      'purple'
    ) +
    statCard('会话数', fmtInt(u.sessions), 'pink') +
    '</div>' +
    '<div class="usage-cache-detail muted">' +
    'CacheRead/Input · 全部 ' +
    fmtTokens(u.cacheRead) +
    ' / ' +
    fmtTokens(u.input) +
    ' · 主会话 ' +
    fmtTokens(u.mainCacheRead) +
    ' / ' +
    fmtTokens(u.mainInput) +
    ' · 子代理 ' +
    fmtTokens(u.subagentCacheRead) +
    ' / ' +
    fmtTokens(u.subagentInput) +
    '</div>' +
    '<div class="usage-charts">' +
    '<div class="usage-chart-card span-2">' +
    '<div class="usage-chart-head"><h3>模型' +
    (byTokens ? ' Tokens' : '费用') +
    '占比 · ' +
    esc(u.windowLabel || '') +
    ' · ' +
    esc(kpis.label) +
    '</h3></div>' +
    '<div id="usage-chart-pie" class="usage-chart-el"></div></div>' +
    '<div class="usage-chart-card span-3">' +
    '<div class="usage-chart-head"><h3>费用趋势（按日）</h3></div>' +
    '<div id="usage-chart-cost" class="usage-chart-el"></div></div>' +
    '<div class="usage-chart-card span-3">' +
    '<div class="usage-chart-head"><h3>Token 组成（In / Out）</h3></div>' +
    '<div id="usage-chart-tokens" class="usage-chart-el"></div></div>' +
    '<div class="usage-chart-card span-2">' +
    '<div class="usage-chart-head"><h3>全局模型 Top · ' +
    (byTokens ? 'Tokens' : '费用') +
    '</h3></div>' +
    '<div id="usage-chart-rank" class="usage-chart-el"></div></div>' +
    '</div>' +
    '<div class="usage-panel">' +
    '<div class="usage-panel-head"><h3>今天 · 分模型</h3><span class="muted">' +
    esc(kpis.label) +
    '</span></div>' +
    modelTable(scopedTodayModels, '今天还没有用量', sortBy) +
    '</div>' +
    '<div class="usage-panel">' +
    '<div class="usage-panel-head"><h3>全局 · 分模型</h3><span class="muted">' +
    esc(kpis.label) +
    ' · ' +
    fmtInt(scopedGlobalModels.length) +
    ' 个</span></div>' +
    modelTable(scopedGlobalModels, '无历史用量', sortBy) +
    (scope !== 'subagent' && globalProviders.length
      ? '<h4 class="usage-subh">全局 · 按供应商</h4>' +
        providerTable(globalProviders)
      : '') +
    (scope !== 'main' && globalAgents.length
      ? '<h4 class="usage-subh">全局 · 子代理</h4>' +
        agentTable(globalAgents, '无子代理用量', sortBy)
      : '') +
    '</div>' +
    '<div class="usage-panel">' +
    '<div class="usage-panel-head"><h3>当前窗 · ' +
    esc(u.windowLabel || '') +
    '</h3><span class="muted">' +
    esc(kpis.label) +
    ' · ' +
    fmtTokens(kpis.tokens) +
    ' · ' +
    fmtSummaryCost(kpis) +
    (cacheLabel ? ' · ' + cacheLabel : '') +
    '</span></div>' +
    modelTable(scopedModels, '该范围无模型用量', sortBy) +
    (scope !== 'subagent'
      ? '<h4 class="usage-subh">按供应商</h4>' + providerTable(u.providers)
      : '') +
    (scope !== 'main' && windowAgents.length
      ? '<h4 class="usage-subh">子代理</h4>' +
        agentTable(windowAgents, '该范围无子代理用量', sortBy)
      : '') +
    '</div>' +
    '<p class="muted usage-foot">数据：' +
    esc(u.sessionDir || '') +
    (u.parsedFiles != null
      ? ' · 解析 ' +
        fmtInt(u.parsedFiles) +
        ' / 复用 ' +
        fmtInt(u.reusedFiles)
      : '') +
    ' · 含子代理 toolResult 汇总 · 磁盘缓存 usage-index-v2 · 费用=jsonl 原值累加 · 显示 ¥</p>';

  // charts: lazy load echarts then draw
  disposeUsageCharts(); // DOM recreated so old instances invalid
  ensureEcharts().then((ok) => {
    if (!ok) {
      document.querySelectorAll('#usage-root .usage-chart-el').forEach((el) => {
        el.classList.add('is-empty');
        el.innerHTML =
          '<div class="usage-chart-empty"><span class="muted">ECharts 未加载</span></div>';
      });
      return;
    }
    requestAnimationFrame(() => renderUsageCharts(u));
  });
}

function enterUsageRoute() {
  ensureUsageState();
  ensureEcharts();
  // 有内存数据：先渲染；API 数据 60s 内不重复请求
  const USAGE_SOFT_TTL_MS = 60_000;
  if (state.usageData) {
    renderUsagePage();
    if (Date.now() - (state.usageFetchedAt || 0) < USAGE_SOFT_TTL_MS) return;
  }
  loadUsage(false);
}

function bindUsageUI() {
  ensureUsageState();
  $('#usage-refresh')?.addEventListener('click', () => loadUsage(true));
  $('#usage-presets')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.usage-preset');
    if (!btn) return;
    state.usageWindow = btn.dataset.window || 'all';
    loadUsage(false); // use cache when switching windows
  });
  // sort / scope buttons live inside usage-root (re-rendered); delegate on page
  $('#page-usage')?.addEventListener('click', (e) => {
    const sortBtn = e.target.closest('.usage-sort-btn');
    if (sortBtn) {
      const next = sortBtn.dataset.sort === 'tokens' ? 'tokens' : 'cost';
      if (state.usageSort === next) return;
      state.usageSort = next;
      if (state.usageData) renderUsagePage();
      return;
    }
    const scopeBtn = e.target.closest('.usage-scope-btn');
    if (scopeBtn) {
      const next = scopeBtn.dataset.scope || 'all';
      if (!['all', 'main', 'subagent'].includes(next)) return;
      if (state.usageScope === next) return;
      state.usageScope = next;
      if (state.usageData) renderUsagePage();
    }
  });
  window.addEventListener('resize', () => {
    const map = state._usageCharts || {};
    Object.values(map).forEach((c) => {
      try {
        c.resize();
      } catch {
        /* ignore */
      }
    });
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bindUsageUI);
} else {
  bindUsageUI();
}
