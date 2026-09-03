/* Search + Health + Export UI for Pi Manager */

function ensureOpsState() {
  if (!state.searchHits) state.searchHits = null;
  if (!state.healthData) state.healthData = null;
  if (state.searchQ == null) state.searchQ = '';
  if (state.searchScope == null) state.searchScope = 'all';
}

let _searchTimer = null;
let _searchSeq = 0;

function getSearchScope() {
  const active = document.querySelector('#search-scope-row .scope-chip.active');
  return (active && active.dataset.scope) || state.searchScope || 'all';
}

function setSearchScope(scope) {
  state.searchScope = scope || 'all';
  document.querySelectorAll('#search-scope-row .scope-chip').forEach((chip) => {
    const on = chip.dataset.scope === state.searchScope;
    chip.classList.toggle('active', on);
    chip.setAttribute('aria-selected', on ? 'true' : 'false');
  });
}

function updateSearchClearBtn() {
  const inp = $('#search-q');
  const btn = $('#search-clear');
  if (!btn) return;
  const has = !!(inp && inp.value && inp.value.trim());
  btn.classList.toggle('hidden', !has);
}

function scheduleSearch() {
  ensureOpsState();
  updateSearchClearBtn();
  const q = ($('#search-q')?.value || '').trim();
  state.searchQ = q;
  const sum = $('#search-summary');
  const box = $('#search-results');
  if (!q) {
    state.searchHits = null;
    if (sum) sum.textContent = '输入至少 2 个字符，自动出结果';
    if (box) box.innerHTML = '';
    return;
  }
  if (q.length < 2) {
    state.searchHits = null;
    if (sum) sum.textContent = '再输入 ' + (2 - q.length) + ' 个字符…';
    if (box) box.innerHTML = '';
    return;
  }
  if (sum) sum.textContent = '搜索中…';
  clearTimeout(_searchTimer);
  _searchTimer = setTimeout(() => runSearch(q), 220);
}

async function runSearch(forceQ) {
  ensureOpsState();
  const q = (forceQ != null ? forceQ : $('#search-q')?.value || state.searchQ || '').trim();
  const scope = getSearchScope();
  state.searchQ = q;
  state.searchScope = scope;
  const box = $('#search-results');
  const sum = $('#search-summary');
  if (!q || q.length < 2) {
    if (sum) sum.textContent = '输入至少 2 个字符，自动出结果';
    if (box) box.innerHTML = '';
    return;
  }
  const seq = ++_searchSeq;
  if (sum) sum.textContent = '搜索中…';
  try {
    const data = await api(
      '/api/search?q=' +
        encodeURIComponent(q) +
        '&scope=' +
        encodeURIComponent(scope) +
        '&limit=50'
    );
    if (seq !== _searchSeq) return; // 过期响应
    state.searchHits = data;
    renderSearchResults();
  } catch (e) {
    if (seq !== _searchSeq) return;
    if (sum) sum.textContent = '失败：' + e.message;
    if (box) box.innerHTML = '';
  }
}

function searchSourceLabel(source) {
  const map = {
    prompts: '提示词',
    prompt: '提示词',
    agents: '子代理',
    agent: '子代理',
    skills: 'Skills',
    skill: 'Skills',
    memory: '记忆',
    knowledge: '知识库',
    all: '全部',
  };
  const key = String(source || '').toLowerCase();
  return map[key] || source || '其它';
}

function renderSearchResults() {
  const data = state.searchHits || {};
  const hits = data.hits || [];
  const sum = $('#search-summary');
  const box = $('#search-results');
  if (sum) {
    sum.innerHTML =
      '「' +
      esc(data.q || '') +
      '」· 范围 ' +
      esc(searchSourceLabel(data.scope || 'all')) +
      ' · <strong>' +
      (data.count ?? hits.length) +
      '</strong> 条';
  }
  if (!box) return;
  if (!hits.length) {
    box.innerHTML =
      '<div class="empty">' +
      '<p class="sess-empty-title">无匹配结果</p>' +
      '<p class="sess-empty-sub">换个关键词，或切换上方范围 chip 再试</p>' +
      '</div>';
    return;
  }
  // 按 source 分组，组内保持接口返回顺序
  const groups = [];
  const bySource = new Map();
  hits.forEach((h) => {
    const key = h.source || 'other';
    if (!bySource.has(key)) {
      bySource.set(key, []);
      groups.push(key);
    }
    bySource.get(key).push(h);
  });

  box.innerHTML = groups
    .map((src) => {
      const list = bySource.get(src) || [];
      const cards = list
        .map((h) => {
          const matchHint =
            h.match === 'name' ? '名称' : h.match === 'meta' ? '元数据' : h.match ? String(h.match) : '';
          const typeTag =
            '<span class="search-type-tag" data-source="' +
            esc(h.source || '') +
            '">' +
            esc(searchSourceLabel(h.source)) +
            (matchHint ? ' · ' + esc(matchHint) : '') +
            '</span>';
          return (
            '<article class="search-hit">' +
            '<div class="search-hit-head">' +
            typeTag +
            '<strong>' +
            esc(h.title || '') +
            '</strong>' +
            '</div>' +
            '<div class="search-hit-group">' +
            esc(h.group || '') +
            (h.line ? ' · 约第 ' + h.line + ' 行' : '') +
            '</div>' +
            (h.snippet
              ? '<pre class="search-snippet">' + esc(h.snippet) + '</pre>'
              : '') +
            '<div class="search-hit-actions">' +
            (h.href
              ? '<a class="btn ghost sm" href="' + esc(h.href) + '">打开相关页</a>'
              : '') +
            (h.path
              ? '<code class="muted mono" title="' +
                esc(h.path) +
                '">' +
                esc(h.path) +
                '</code>'
              : '') +
            '</div>' +
            '</article>'
          );
        })
        .join('');
      return cards;
    })
    .join('');
}

function enterSearchRoute() {
  ensureOpsState();
  if ($('#search-q') && state.searchQ != null) $('#search-q').value = state.searchQ;
  setSearchScope(state.searchScope || 'all');
  updateSearchClearBtn();
  if (typeof refreshIcons === 'function') refreshIcons();
  // 进入页面时：有字就直接搜，并聚焦输入框
  setTimeout(() => {
    const inp = $('#search-q');
    if (inp) {
      inp.focus();
      const len = inp.value.length;
      try { inp.setSelectionRange(len, len); } catch (_) {}
    }
    if ((state.searchQ || '').trim().length >= 2) runSearch(state.searchQ);
    else if (state.searchHits) renderSearchResults();
  }, 0);
}

async function loadHealth(force) {
  ensureOpsState();
  if (!force && state.healthData) {
    renderHealthPanel();
    return state.healthData;
  }
  try {
    const data = await api('/api/health');
    state.healthData = data;
    renderHealthPanel();
    return data;
  } catch (e) {
    state.healthData = { error: e.message };
    renderHealthPanel();
    throw e;
  }
}

function renderHealthPanel() {
  const host = $('#dash-health');
  if (!host) return;
  const data = state.healthData;
  if (!data) {
    host.innerHTML = '<p class="muted">尚未检查</p>';
    return;
  }
  if (data.error) {
    host.innerHTML = '<p class="muted">检查失败：' + esc(data.error) + '</p>';
    return;
  }
  const s = data.summary || {};
  const badge = s.healthy
    ? '<span class="badge ok">健康</span>'
    : '<span class="badge warn">有 ' + (s.fail || 0) + ' 项异常</span>';
  const fails = data.failures || [];
  const failHtml = fails.length
    ? '<ul class="health-fail-list">' +
      fails
        .slice(0, 12)
        .map((f) => '<li><code>' + esc(f.id) + '</code> · ' + esc(f.message) + '</li>')
        .join('') +
      (fails.length > 12 ? '<li class="muted">…共 ' + fails.length + ' 项</li>' : '') +
      '</ul>'
    : '<p class="muted">全部通过</p>';

  const conn = (data.connectivity || [])
    .map(
      (c) =>
        '<li>' +
        esc(c.providerId) +
        ': ' +
        (c.ok ? 'OK ' + c.status + ' · ' + c.ms + 'ms' : esc(c.error || 'fail')) +
        '</li>'
    )
    .join('');

  const okN = s.ok ?? 0;
  const totalN = s.total ?? 0;
  const when = esc((data.checkedAt || '').replace('T', ' ').slice(0, 19));

  host.innerHTML =
    '<div class="dash-tool-card-top">' +
    '<div class="dash-tool-card-titles">' +
    '<span class="dash-tool-k">健康检查</span>' +
    '<span class="dash-tool-title">本机配置体检</span>' +
    '</div>' +
    badge +
    '</div>' +
    '<div class="dash-tool-metric">' +
    '<em>' +
    okN +
    '</em><span class="dash-tool-metric-sep">/</span><span>' +
    totalN +
    '</span>' +
    '<span class="dash-tool-metric-unit">项通过</span>' +
    '</div>' +
    '<div class="dash-tool-meta muted">' +
    (when ? '检查于 ' + when : '尚未运行') +
    '</div>' +
    '<div class="dash-tool-detail">' +
    failHtml +
    (conn
      ? '<div class="dash-tool-subhead">连通性</div><ul class="health-fail-list">' +
        conn +
        '</ul>'
      : '') +
    '</div>' +
    '<div class="dash-tool-actions">' +
    '<button type="button" class="btn ghost sm" id="dash-health-run">重新检查</button>' +
    '</div>';
}

async function downloadExport() {
  try {
    const res = await fetch('/api/export?download=1');
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'HTTP ' + res.status);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download =
      'pi-manager-export-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showToast('已导出配置（密钥已脱敏）');
  } catch (e) {
    showToast('导出失败: ' + e.message, false);
  }
}

function bindOpsUI() {
  ensureOpsState();
  const inp = $('#search-q');
  if (inp && inp.dataset.bound !== '1') {
    inp.dataset.bound = '1';
    inp.addEventListener('input', () => scheduleSearch());
    inp.addEventListener('search', () => scheduleSearch()); // 点输入框原生清空
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        inp.value = '';
        scheduleSearch();
      }
    });
  }
  $('#search-clear')?.addEventListener('click', () => {
    if ($('#search-q')) $('#search-q').value = '';
    scheduleSearch();
    $('#search-q')?.focus();
  });
  document.querySelectorAll('#search-scope-row .scope-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      setSearchScope(chip.dataset.scope || 'all');
      const q = ($('#search-q')?.value || '').trim();
      if (q.length >= 2) runSearch(q);
    });
  });
  // dashboard buttons (delegated via re-bind after render — also global ids)
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (!(t instanceof Element)) return;
    if (t.id === 'dash-health-run' || t.closest?.('#dash-health-run')) {
      e.preventDefault();
      loadHealth(true)
        .then((d) => {
          const n = d?.summary?.fail ?? 0;
          showToast(n ? '健康检查：' + n + ' 项异常' : '健康检查全部通过');
        })
        .catch((err) => showToast('健康检查失败: ' + err.message, false));
    }
    if (t.id === 'dash-export' || t.closest?.('#dash-export')) {
      e.preventDefault();
      downloadExport();
    }
  });
}

// extend dashboard cards when dash-sessions renders
const _origRenderDashboard = typeof renderDashboard === 'function' ? renderDashboard : null;
if (_origRenderDashboard) {
  window.renderDashboard = function patchedRenderDashboard() {
    _origRenderDashboard();
    injectOpsIntoDashboard();
  };
}

function injectOpsIntoDashboard() {
  const root = $('#dash-root');
  if (!root) return;
  // avoid duplicate
  if ($('#dash-ops-extra')) return;

  const host = root.querySelector('.dash-apple') || root;
  const extra = document.createElement('section');
  extra.id = 'dash-ops-extra';
  extra.className = 'dash-section dash-ops-extra';
  extra.innerHTML =
    '<div class="dash-section-head">' +
    '<h2>维护</h2>' +
    '<span class="muted">体检 · 导出 · 搜索</span>' +
    '</div>' +
    '<div class="dash-tools">' +
    // health
    '<div class="dash-tool-card" id="dash-health">' +
    '<div class="dash-tool-card-top">' +
    '<div class="dash-tool-card-titles">' +
    '<span class="dash-tool-k">健康检查</span>' +
    '<span class="dash-tool-title">本机配置体检</span>' +
    '</div>' +
    '<span class="badge">未检查</span>' +
    '</div>' +
    '<p class="dash-tool-desc">检查配置文件、默认模型、供应商 Key/URL、工作区映射等是否正常。</p>' +
    '<div class="dash-tool-actions">' +
    '<button type="button" class="btn primary sm" id="dash-health-run">运行检查</button>' +
    '</div></div>' +
    // export
    '<div class="dash-tool-card dash-tool-export">' +
    '<div class="dash-tool-card-top">' +
    '<div class="dash-tool-card-titles">' +
    '<span class="dash-tool-k">配置导出</span>' +
    '<span class="dash-tool-title">备份快照</span>' +
    '</div>' +
    '<span class="dash-tool-chip">JSON</span>' +
    '</div>' +
    '<p class="dash-tool-desc">导出 models、settings、工作区、agents、skills。密钥已脱敏，$ENV 引用保留。</p>' +
    '<ul class="dash-tool-tags" aria-hidden="true">' +
    '<li>models</li><li>settings</li><li>workspaces</li><li>agents</li><li>skills</li>' +
    '</ul>' +
    '<div class="dash-tool-actions">' +
    '<button type="button" class="btn primary sm" id="dash-export">导出 JSON</button>' +
    '<a class="btn ghost sm" href="#/search">全局搜索</a>' +
    '</div></div>' +
    '</div>';

  host.appendChild(extra);
  if (state.healthData) renderHealthPanel();
}

function enterOpsRoute(route) {
  if (route === 'search') enterSearchRoute();
}

window.clearSearchTimer = function () {
  if (_searchTimer) {
    clearTimeout(_searchTimer);
    _searchTimer = null;
  }
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bindOpsUI);
} else {
  bindOpsUI();
}
