/* Dashboard + Sessions pages for Pi Manager */

function ensureDashState() {
  if (!state.dashStatus) state.dashStatus = null;
  if (!state.sessData) state.sessData = null;
  if (!state.sessSelected) state.sessSelected = new Set();
  if (state.sessOffset == null) state.sessOffset = 0;
  if (state.sessLimit == null) state.sessLimit = 80;
  if (state.sessQ == null) state.sessQ = '';
  if (state.dashFetchedAt == null) state.dashFetchedAt = 0;
  if (state.sessFetchedAt == null) state.sessFetchedAt = 0;
  if (state._dashLoading == null) state._dashLoading = false;
  if (state._sessLoading == null) state._sessLoading = false;
}

/** Soft cache TTL: switch tabs should not flash empty / re-fetch every time */
const DASH_SOFT_TTL_MS = 45_000;
const SESS_SOFT_TTL_MS = 30_000;

async function loadDashboard(force) {
  ensureDashState();
  const root = $('#dash-root');
  if (!root) return;

  const now = Date.now();
  const hasCache = !!state.dashStatus;
  const fresh =
    hasCache && !force && now - (state.dashFetchedAt || 0) < DASH_SOFT_TTL_MS;

  // Always paint cache first — no blank flash when switching tabs
  if (hasCache) {
    renderDashboard();
    if (fresh) {
      // usage may still be missing on first paint of session
      if (typeof loadUsageQuiet === 'function' && !state.usageData) {
        loadUsageQuiet(state.usageWindow || 'all').then(() => {
          if (state.route === 'dashboard') renderDashboard();
        });
      }
      return;
    }
  } else if (!state._dashLoading) {
    root.innerHTML = '<div class="empty"><p>加载中…</p></div>';
  }

  if (state._dashLoading && !force) return;
  state._dashLoading = true;
  try {
    const st = await api('/api/status');
    state.dashStatus = st;
    state.dashFetchedAt = Date.now();
    if (state.route === 'dashboard') renderDashboard();
    if (typeof loadUsageQuiet === 'function') {
      loadUsageQuiet(state.usageWindow || 'all').then(() => {
        if (state.route === 'dashboard') renderDashboard();
      });
    }
  } catch (e) {
    if (!state.dashStatus && root) {
      root.innerHTML =
        '<div class="empty"><p>加载失败：' + esc(e.message) + '</p></div>';
    } else if (typeof showToast === 'function') {
      showToast('总览刷新失败: ' + e.message, false);
    }
  } finally {
    state._dashLoading = false;
  }
}

function readyBadge(ok, labelOk, labelBad) {
  if (ok) return '<span class="badge ok">' + esc(labelOk || '就绪') + '</span>';
  return '<span class="badge warn">' + esc(labelBad || '未就绪') + '</span>';
}

function dashPill(ok, okText, badText) {
  return (
    '<span class="dash-pill ' +
    (ok ? 'ok' : 'warn') +
    '">' +
    esc(ok ? okText || '就绪' : badText || '未就绪') +
    '</span>'
  );
}

function dashTile(opts) {
  const {
    title,
    value,
    sub,
    pill,
    href,
    actionHtml,
    wide,
    className,
  } = opts || {};
  // 统一 tile 头 / 值 / 脚：top(label+pill) → value → foot(sub) → actions
  const inner =
    '<div class="dash-tile-top">' +
    '<span class="dash-tile-label">' +
    esc(title || '') +
    '</span>' +
    (pill || '') +
    '</div>' +
    '<div class="dash-tile-value">' +
    (value || '') +
    '</div>' +
    (sub ? '<div class="dash-tile-foot"><div class="dash-tile-sub">' + sub + '</div></div>' : '') +
    (actionHtml
      ? '<div class="dash-tile-actions">' + actionHtml + '</div>'
      : '');
  if (href) {
    return (
      '<a class="dash-tile' +
      (wide ? ' wide' : '') +
      (className ? ' ' + className : '') +
      '" href="' +
      esc(href) +
      '">' +
      inner +
      '</a>'
    );
  }
  return (
    '<div class="dash-tile' +
    (wide ? ' wide' : '') +
    (className ? ' ' + className : '') +
    '">' +
    inner +
    '</div>'
  );
}

function renderDashboard() {
  const root = $('#dash-root');
  if (!root) return;
  const st = state.dashStatus || {};
  const d = st.defaults || {};
  const counts = st.counts || {};
  const sess = st.sessions || {};
  const junk = st.junk || {};
  const mem = st.memory || {};
  const kb = st.knowledge || {};
  const wf = st.workflow || {};
  const openvl = st.openvl || {};

  const modelReady = !!(d.defaultProvider && d.defaultModel);
  const modelName = d.defaultModel || '未设置';
  const providerName = d.defaultProvider || '—';
  const thinking = d.defaultThinkingLevel || '';
  // 点「管理」直达当前默认供应商（并尽量选中默认模型）
  const modelsHref = modelReady
    ? '#/models?provider=' +
      encodeURIComponent(d.defaultProvider) +
      '&model=' +
      encodeURIComponent(d.defaultModel)
    : d.defaultProvider
      ? '#/models?provider=' + encodeURIComponent(d.defaultProvider)
      : '#/models';

  const usageHero =
    typeof usageDashHeroHtml === 'function'
      ? usageDashHeroHtml()
      : typeof usageDashCardHtml === 'function'
        ? usageDashCardHtml()
        : '';

  root.innerHTML =
    '<div class="dash-apple">' +
    '<section class="dash-top">' +
    '<div class="dash-top-left">' +
    '<p class="dash-eyebrow">Dashboard</p>' +
    '<h1 class="dash-page-title">总览</h1>' +
    '<p class="dash-page-desc">本机 Pi 配置、用量与资源状态</p>' +
    '</div>' +
    '<div class="dash-top-right">' +
    '<a class="btn ghost sm" href="#/usage">用量详情</a>' +
    '<a class="btn ghost sm" href="#/models">模型</a>' +
    '</div></section>' +
    // default model: full-width primary CTA under title
    '<a class="dash-model-card' +
    (modelReady ? '' : ' is-empty') +
    '" href="' +
    modelsHref +
    '">' +
    '<div class="dash-model-card-main">' +
    '<span class="dash-model-card-k">默认模型</span>' +
    '<span class="dash-model-card-name">' +
    esc(modelName) +
    '</span>' +
    '<span class="dash-model-card-meta">' +
    '<span class="dash-model-tag">' +
    esc(providerName) +
    '</span>' +
    (thinking
      ? '<span class="dash-model-tag soft">thinking ' +
        esc(thinking) +
        '</span>'
      : '') +
    (modelReady
      ? ''
      : '<span class="dash-model-tag warn">点击配置</span>') +
    '</span></div>' +
    '<span class="dash-model-card-go" aria-hidden="true">' +
    '<span class="dash-model-card-go-label">管理</span>' +
    '<span class="dash-model-card-go-arrow">→</span>' +
    '</span></a>' +
    // usage focus
    usageHero +
    // status bento
    '<section class="dash-section">' +
    '<div class="dash-section-head">' +
    '<h2>状态</h2>' +
    '<span class="muted">本机配置一览</span>' +
    '</div>' +
    '<div class="dash-bento">' +
    dashTile({
      title: '规模',
      value:
        '<span class="dash-inline-nums">' +
        '<em>' +
        esc(String(counts.providers ?? '—')) +
        '</em><i>供应商</i>' +
        '<em>' +
        esc(String(counts.models ?? '—')) +
        '</em><i>模型</i></span>',
      sub:
        '子代理 ' +
        esc(String(counts.agents ?? '—')) +
        ' · Skills ' +
        esc(String(counts.skills ?? '—')),
      href: '#/models',
    }) +
    dashTile({
      title: '会话',
      value: sess.exists
        ? esc(String(sess.total ?? 0))
        : '—',
      sub: sess.exists
        ? esc(sess.totalSizeLabel || '0 B') +
          ' · ' +
          esc(String(sess.groupCount ?? 0)) +
          ' 个目录'
        : '会话目录不存在',
      pill: sess.exists
        ? dashPill(true, '就绪', '')
        : dashPill(false, '', '无目录'),
      href: '#/sessions',
    }) +
    dashTile({
      title: '识图 OpenVL',
      value: openvl.available ? '可用' : '未就绪',
      sub: openvl.available
        ? '本机已检测到 OpenVL'
        : esc(openvl.hint || '未安装'),
      pill: dashPill(!!openvl.available, 'OK', '缺少'),
      href: '#/openvl',
    }) +
    dashTile({
      title: '记忆',
      value: mem.ready ? '已连接' : '未配置',
      sub: esc(
        mem.ready
          ? mem.path || mem.name || '就绪'
          : mem.reason || '未配置'
      ),
      pill: dashPill(!!mem.ready, '就绪', '未就绪'),
      href: '#/memory',
    }) +
    dashTile({
      title: '知识库',
      value: kb.ready ? '已连接' : '未配置',
      sub: esc(
        kb.ready ? kb.path || kb.name || '就绪' : kb.reason || '未配置'
      ),
      pill: dashPill(!!kb.ready, '就绪', '未就绪'),
      href: '#/knowledge',
    }) +
    dashTile({
      title: '工作流',
      value: wf.ready ? '可用' : '依赖记忆',
      sub: esc(wf.ready ? wf.path || 'pi_config/workflows' : wf.reason || '未配置工作流'),
      pill: dashPill(!!wf.ready, '就绪', '未就绪'),
      href: '#/agents',
    }) +
    dashTile({
      title: '临时文件',
      value:
        esc(String(junk.tmpCount ?? 0)) +
        ' <span class="dash-unit">tmp</span>',
      sub:
        esc(junk.tmpSizeLabel || '0 B') +
        ' · bak ' +
        esc(String(junk.bakCount ?? 0)) +
        '（' +
        esc(junk.bakSizeLabel || '0 B') +
        '）',
      pill:
        junk.tmpCount || junk.bakCount
          ? dashPill(false, '', '可清理')
          : dashPill(true, '干净', ''),
      actionHtml:
        '<button type="button" class="btn ghost sm" id="dash-clean-tmp">清 tmp</button>' +
        '<button type="button" class="btn ghost sm" id="dash-clean-bak-old">清旧 bak</button>',
      className: 'dash-tile-actions-visible',
    }) +
    '</div></section>' +
    // recent
    '<section class="dash-section">' +
    '<div class="dash-section-head">' +
    '<h2>最近会话</h2>' +
    '<a class="dash-link" href="#/sessions">全部</a>' +
    '</div>' +
    '<div class="dash-recent-card">' +
    renderRecentSessions(sess.recent || []) +
    '</div></section>' +
    '</div>';

  $('#dash-clean-tmp')?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    runJunkCleanup('tmp');
  });
  $('#dash-clean-bak-old')?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    runJunkCleanup('bak_old');
  });
}

function card(title, bodyHtml, badgeHtml, actionsHtml) {
  // legacy helper still used elsewhere if any
  return (
    '<div class="dash-card block">' +
    '<div class="dash-card-head">' +
    '<strong>' +
    esc(title) +
    '</strong>' +
    (badgeHtml || '') +
    '</div>' +
    '<div class="dash-card-body">' +
    bodyHtml +
    '</div>' +
    (actionsHtml
      ? '<div class="dash-card-actions">' + actionsHtml + '</div>'
      : '') +
    '</div>'
  );
}

function renderRecentSessions(list) {
  if (!list.length) {
    return (
      '<div class="dash-empty-block">' +
      '<p class="dash-empty-title">暂无会话</p>' +
      '<p class="dash-empty-desc">还没有本机会话记录。可到会话页查看，或打开运行页观察活动。</p>' +
      '<div class="dash-empty-actions">' +
      '<a class="btn primary sm" href="#/sessions">打开会话</a>' +
      '<a class="btn ghost sm" href="#/runtime">查看运行</a>' +
      '</div></div>'
    );
  }
  return (
    '<ul class="dash-recent-list">' +
    list
      .map((it) => {
        const time = esc((it.mtime || '').replace('T', ' ').slice(0, 19));
        const size = esc(it.sizeLabel || '');
        const cwd = esc(it.cwd || '—');
        // 状态点：有路径视为就绪会话
        const ok = !!(it.cwd || it.path || it.id);
        return (
          '<li class="dash-recent-item">' +
          '<span class="dash-recent-dot' +
          (ok ? ' ok' : '') +
          '" aria-hidden="true"></span>' +
          '<div class="dash-recent-main">' +
          '<span class="dash-recent-cwd" title="' +
          cwd +
          '">' +
          cwd +
          '</span>' +
          (size
            ? '<span class="dash-recent-size">' + size + '</span>'
            : '') +
          '</div>' +
          '<time class="dash-recent-time">' +
          time +
          '</time></li>'
        );
      })
      .join('') +
    '</ul>'
  );
}

async function runJunkCleanup(mode) {
  const labels = {
    tmp: '临时文件 tmp_*',
    bak_old: '滚动备份 .bak.N（保留 .bak）',
    bak: '全部 .bak',
    all: 'tmp + 旧 bak',
  };
  if (!confirm('确认清理：' + (labels[mode] || mode) + '？')) return;
  try {
    const r = await api('/api/cleanup/junk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode, dryRun: false }),
    });
    showToast(
      '已清理 ' + r.count + ' 个文件，释放 ' + (r.freedLabel || formatLocalBytes(r.freed))
    );
    await loadDashboard(true);
  } catch (e) {
    showToast('清理失败: ' + e.message, false);
  }
}

function formatLocalBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return v + ' B';
  if (v < 1024 * 1024) return (v / 1024).toFixed(1) + ' KB';
  return (v / (1024 * 1024)).toFixed(1) + ' MB';
}

// ── sessions page ───────────────────────────────────────────────────────────

async function loadSessionsPage(force) {
  ensureDashState();
  const tbody = $('#sess-tbody');
  if (!tbody) return;

  const now = Date.now();
  const hasCache = !!state.sessData;
  const fresh =
    hasCache && !force && now - (state.sessFetchedAt || 0) < SESS_SOFT_TTL_MS;

  if (hasCache) {
    renderSessionsTable();
    if (fresh) return;
  } else {
    tbody.innerHTML =
      '<tr><td colspan="6" class="muted sess-empty-cell"><div class="sess-empty-inline"><p class="sess-empty-title">加载中…</p></div></td></tr>';
  }

  if (state._sessLoading && !force) return;
  state._sessLoading = true;
  try {
    const q = encodeURIComponent(state.sessQ || '');
    const data = await api(
      '/api/sessions?limit=' +
        state.sessLimit +
        '&offset=' +
        state.sessOffset +
        (state.sessQ ? '&q=' + q : '')
    );
    state.sessData = data;
    state.sessFetchedAt = Date.now();
    // keep selection only when soft-refreshing same page
    if (force) state.sessSelected = new Set();
    if (state.route === 'sessions') renderSessionsTable();
  } catch (e) {
    if (!state.sessData) {
      tbody.innerHTML =
        '<tr><td colspan="6" class="muted sess-empty-cell"><div class="sess-empty-inline">' +
        '<p class="sess-empty-title">加载失败</p>' +
        '<p class="sess-empty-sub">' +
        esc(e.message) +
        '</p></div></td></tr>';
      const sum = $('#sess-summary');
      if (sum) sum.textContent = '加载失败';
    } else if (typeof showToast === 'function') {
      showToast('会话列表刷新失败: ' + e.message, false);
    }
  } finally {
    state._sessLoading = false;
  }
}

function renderSessionsTable() {
  ensureDashState();
  const data = state.sessData || {};
  const items = data.items || [];
  const sum = $('#sess-summary');
  if (sum) {
    sum.innerHTML =
      '目录：<code>' +
      esc(data.sessionsDir || '') +
      '</code> · 共 <strong>' +
      (data.total ?? 0) +
      '</strong> 个 · ' +
      esc(data.totalSizeLabel || '0 B') +
      ' · 本页 ' +
      items.length;
  }
  const tbody = $('#sess-tbody');
  if (!tbody) return;
  if (!items.length) {
    const emptyHint = state.sessQ
      ? '没有匹配「' + esc(state.sessQ) + '」的会话'
      : '还没有历史会话';
    tbody.innerHTML =
      '<tr><td colspan="6" class="muted sess-empty-cell"><div class="sess-empty-inline">' +
      '<p class="sess-empty-title">没有会话</p>' +
      '<p class="sess-empty-sub">' +
      emptyHint +
      '</p></div></td></tr>';
  } else {
    tbody.innerHTML = items
      .map((it) => {
        const selected = state.sessSelected.has(it.relPath);
        const checked = selected ? ' checked' : '';
        return (
          '<tr data-rel="' +
          esc(it.relPath) +
          '"' +
          (selected ? ' class="is-selected"' : '') +
          '>' +
          '<td class="sess-check-col"><input type="checkbox" class="sess-check" data-rel="' +
          esc(it.relPath) +
          '"' +
          checked +
          ' aria-label="选择会话"></td>' +
          '<td class="nowrap">' +
          esc((it.mtime || '').replace('T', ' ').slice(0, 19)) +
          '</td>' +
          '<td class="nowrap">' +
          esc(it.sizeLabel || '') +
          '</td>' +
          '<td class="sess-path" title="' +
          esc(it.cwd || '') +
          '">' +
          esc(it.cwd || it.cwdKey || '') +
          '</td>' +
          '<td class="mono">' +
          esc((it.id || '').slice(0, 13)) +
          '…</td>' +
          '<td class="mono muted">' +
          esc(it.fileName || '') +
          '</td>' +
          '</tr>'
        );
      })
      .join('');
  }

  const footer = $('#sess-footer');
  if (footer) {
    const total = data.total || 0;
    const off = data.offset || 0;
    const lim = data.limit || state.sessLimit;
    const canPrev = off > 0;
    const canNext = off + lim < total;
    const pageEnd = Math.min(off + items.length, total);
    const pageLabel =
      total === 0
        ? '0 / 0'
        : off +
          1 +
          '–' +
          pageEnd +
          ' / ' +
          total;
    footer.innerHTML =
      '<button type="button" class="btn ghost sm" id="sess-prev"' +
      (canPrev ? '' : ' disabled') +
      '>上一页</button>' +
      '<span class="sess-page-meta">' +
      pageLabel +
      '</span>' +
      '<button type="button" class="btn ghost sm" id="sess-next"' +
      (canNext ? '' : ' disabled') +
      '>下一页</button>';
    $('#sess-prev')?.addEventListener('click', () => {
      state.sessOffset = Math.max(0, off - lim);
      loadSessionsPage(true);
    });
    $('#sess-next')?.addEventListener('click', () => {
      state.sessOffset = off + lim;
      loadSessionsPage(true);
    });
  }

  $$('.sess-check').forEach((el) => {
    el.addEventListener('change', () => {
      const rel = el.dataset.rel;
      if (el.checked) state.sessSelected.add(rel);
      else state.sessSelected.delete(rel);
      const row = el.closest('tr');
      if (row) row.classList.toggle('is-selected', el.checked);
      syncSessCheckAll();
    });
  });
  syncSessCheckAll();
}

function syncSessCheckAll() {
  const all = $('#sess-check-all');
  if (!all) return;
  const boxes = $$('.sess-check');
  if (!boxes.length) {
    all.checked = false;
    all.indeterminate = false;
    return;
  }
  const n = boxes.filter((b) => b.checked).length;
  all.checked = n === boxes.length;
  all.indeterminate = n > 0 && n < boxes.length;
}

async function deleteSelectedSessions() {
  ensureDashState();
  const paths = [...state.sessSelected];
  if (!paths.length) {
    showToast('请先勾选会话', false);
    return;
  }
  if (!confirm('确认永久删除选中的 ' + paths.length + ' 个会话文件？\n会话不走 .trash，删除后不可恢复。')) return;
  if (!confirm('再次确认：永久删除 ' + paths.length + ' 个会话')) return;
  try {
    const r = await api('/api/sessions/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths }),
    });
    showToast('已删除 ' + r.deleted + '，释放 ' + (r.freedLabel || ''));
    state.sessSelected = new Set();
    await loadSessionsPage(true);
    if (state.route === 'dashboard') await loadDashboard(true);
  } catch (e) {
    showToast('删除失败: ' + e.message, false);
  }
}

async function cleanupSessionsByDays() {
  const days = Number($('#sess-days')?.value || 30);
  if (!confirm('确认永久删除 ' + days + ' 天前的全部会话？\n会话不走 .trash，删除后不可恢复。')) return;
  if (!confirm('再次确认：清理 >' + days + ' 天会话')) return;
  try {
    const r = await api('/api/sessions/cleanup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ days }),
    });
    showToast('已删除 ' + r.deleted + '，释放 ' + (r.freedLabel || ''));
    await loadSessionsPage(true);
    if (state.route === 'dashboard') await loadDashboard(true);
  } catch (e) {
    showToast('清理失败: ' + e.message, false);
  }
}

function bindDashSessionsUI() {
  ensureDashState();
  $('#dash-refresh')?.addEventListener('click', () => loadDashboard(true));
  $('#sess-refresh')?.addEventListener('click', () => loadSessionsPage(true));
  $('#sess-delete-selected')?.addEventListener('click', () => deleteSelectedSessions());
  $('#sess-cleanup-old')?.addEventListener('click', () => cleanupSessionsByDays());
  $('#sess-check-all')?.addEventListener('change', (e) => {
    const on = e.target.checked;
    $$('.sess-check').forEach((b) => {
      b.checked = on;
      const rel = b.dataset.rel;
      if (on) state.sessSelected.add(rel);
      else state.sessSelected.delete(rel);
      const row = b.closest('tr');
      if (row) row.classList.toggle('is-selected', on);
    });
  });
  let qTimer = null;
  $('#sess-q')?.addEventListener('input', (e) => {
    clearTimeout(qTimer);
    qTimer = setTimeout(() => {
      state.sessQ = e.target.value.trim();
      state.sessOffset = 0;
      loadSessionsPage(true);
    }, 280);
  });
}

function enterDashRoute(route) {
  // soft enter: paint cache, background refresh if TTL expired
  if (route === 'dashboard') loadDashboard(false);
  else if (route === 'sessions') loadSessionsPage(false);
}

// hook boot if DOM already ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bindDashSessionsUI);
} else {
  bindDashSessionsUI();
}
