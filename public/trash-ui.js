/* Trash list / restore / purge UI */

function ensureTrashState() {
  if (!state.trashWsId) state.trashWsId = '';
  if (!state.trashData) state.trashData = null;
}

async function loadTrashPage(force) {
  ensureTrashState();
  await fillTrashWorkspaceSelect();
  if (!state.trashWsId) {
    const sum = $('#trash-summary');
    const list = $('#trash-list');
    if (sum) sum.textContent = '没有可用工作区';
    if (list) {
      list.innerHTML =
        '<tr><td colspan="5" class="muted sess-empty-cell"><div class="sess-empty-inline">' +
        '<p class="sess-empty-title">没有可用工作区</p>' +
        '<p class="sess-empty-sub">请先在工作区页添加并确认 root 存在</p>' +
        '</div></td></tr>';
    }
    return;
  }
  if (!force && state.trashData && state.trashData.workspaceId === state.trashWsId) {
    renderTrashList();
    return;
  }
  const list = $('#trash-list');
  if (list) {
    list.innerHTML =
      '<tr><td colspan="5" class="muted sess-empty-cell"><div class="sess-empty-inline">' +
      '<p class="sess-empty-title">加载中…</p></div></td></tr>';
  }
  try {
    const data = await api(
      '/api/workspaces/' + encodeURIComponent(state.trashWsId) + '/trash'
    );
    state.trashData = data;
    renderTrashList();
  } catch (e) {
    if ($('#trash-summary')) $('#trash-summary').textContent = '加载失败: ' + e.message;
    if (list) {
      list.innerHTML =
        '<tr><td colspan="5" class="muted sess-empty-cell"><div class="sess-empty-inline">' +
        '<p class="sess-empty-title">加载失败</p>' +
        '<p class="sess-empty-sub">' +
        esc(e.message) +
        '</p></div></td></tr>';
    }
  }
}

async function fillTrashWorkspaceSelect() {
  const sel = $('#trash-ws');
  if (!sel) return;
  try {
    if (!state.workspaces || !state.workspaces.length) {
      const data = await api('/api/workspaces');
      state.workspaces = data.workspaces || [];
    }
  } catch (_) {
    /* ignore */
  }
  const wss = (state.workspaces || []).filter((w) => w.rootExists);
  const prev = state.trashWsId || sel.value;
  sel.innerHTML = wss
    .map(function (w) {
      return (
        '<option value="' +
        esc(w.id) +
        '">' +
        esc(w.name || w.id) +
        '</option>'
      );
    })
    .join('');
  if (!wss.length) {
    state.trashWsId = '';
    return;
  }
  if (prev && wss.some(function (w) { return w.id === prev; })) state.trashWsId = prev;
  else state.trashWsId = wss[0].id;
  sel.value = state.trashWsId;
}

function formatTrashSize(n) {
  const x = Number(n) || 0;
  if (x < 1024) return x + ' B';
  if (x < 1024 * 1024) return (x / 1024).toFixed(1) + ' KB';
  return (x / 1024 / 1024).toFixed(1) + ' MB';
}

function renderTrashList() {
  const data = state.trashData || {};
  const items = data.items || [];
  const sum = $('#trash-summary');
  if (sum) {
    sum.innerHTML =
      '工作区 <code>' +
      esc(data.workspaceId || state.trashWsId) +
      '</code> · ' +
      (data.exists
        ? '<strong>' + (data.count || items.length) + '</strong> 项'
        : '无 .trash 目录') +
      (data.trashDir
        ? ' · <span class="muted mono">' + esc(data.trashDir) + '</span>'
        : '');
  }
  const box = $('#trash-list');
  if (!box) return;
  if (!items.length) {
    box.innerHTML =
      '<tr><td colspan="5" class="muted sess-empty-cell"><div class="sess-empty-inline">' +
      '<p class="sess-empty-title">回收站为空</p>' +
      '<p class="sess-empty-sub">软删除的文件会出现在这里，可还原或永久清空</p>' +
      '</div></td></tr>';
    return;
  }
  box.innerHTML = items
    .map(function (it) {
      const when = String(it.deletedAt || it.mtime || '')
        .replace('T', ' ')
        .slice(0, 19);
      const pathLabel = it.originalRel || it.legacyName || it.stamp || '';
      const typeLabel =
        esc(it.type || 'file') +
        (it.layout === 'legacy' ? ' · 旧格式' : '');
      return (
        '<tr data-stamp="' +
        esc(it.stamp) +
        '">' +
        '<td class="nowrap">' +
        esc(when) +
        '</td>' +
        '<td class="sess-path" title="' +
        esc(it.trashPath || pathLabel) +
        '">' +
        esc(pathLabel) +
        '</td>' +
        '<td class="nowrap"><span class="search-type-tag" data-source="' +
        esc(it.type || 'file') +
        '">' +
        typeLabel +
        '</span></td>' +
        '<td class="nowrap">' +
        (it.size ? esc(formatTrashSize(it.size)) : '—') +
        '</td>' +
        '<td class="sess-actions">' +
        '<button type="button" class="btn primary sm trash-restore" data-stamp="' +
        esc(it.stamp) +
        '">还原</button>' +
        '<button type="button" class="btn danger sm trash-purge" data-stamp="' +
        esc(it.stamp) +
        '">永久删除</button>' +
        '</td>' +
        '</tr>'
      );
    })
    .join('');

  box.querySelectorAll('.trash-restore').forEach(function (btn) {
    btn.addEventListener('click', function () {
      restoreTrashItem(btn.dataset.stamp);
    });
  });
  box.querySelectorAll('.trash-purge').forEach(function (btn) {
    btn.addEventListener('click', function () {
      purgeTrashItem(btn.dataset.stamp);
    });
  });
}

async function restoreTrashItem(stamp) {
  if (!state.trashWsId || !stamp) return;
  if (!confirm('还原到原路径？若目标已存在会失败。\n' + stamp)) return;
  try {
    const r = await api(
      '/api/workspaces/' + encodeURIComponent(state.trashWsId) + '/trash-restore',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stamp: stamp }),
      }
    );
    showToast('已还原: ' + (r.path || ''));
    await loadTrashPage(true);
  } catch (e) {
    showToast('还原失败: ' + e.message, false);
  }
}

async function purgeTrashItem(stamp) {
  if (!state.trashWsId || !stamp) return;
  if (!confirm('永久删除该回收项？不可恢复。\n' + stamp)) return;
  if (!confirm('再次确认永久删除')) return;
  try {
    await api(
      '/api/workspaces/' + encodeURIComponent(state.trashWsId) + '/trash-purge',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stamp: stamp }),
      }
    );
    showToast('已永久删除');
    await loadTrashPage(true);
  } catch (e) {
    showToast('删除失败: ' + e.message, false);
  }
}

async function purgeAllTrash() {
  if (!state.trashWsId) return;
  if (!confirm('清空该工作区回收站全部内容？不可恢复。')) return;
  if (!confirm('再次确认：清空 .trash')) return;
  try {
    const r = await api(
      '/api/workspaces/' + encodeURIComponent(state.trashWsId) + '/trash-purge',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }
    );
    showToast('已清空 ' + (r.purged || 0) + ' 项');
    await loadTrashPage(true);
  } catch (e) {
    showToast('清空失败: ' + e.message, false);
  }
}

function bindTrashUI() {
  ensureTrashState();
  if ($('#trash-refresh')) {
    $('#trash-refresh').addEventListener('click', function () {
      loadTrashPage(true);
    });
  }
  if ($('#trash-purge-all')) {
    $('#trash-purge-all').addEventListener('click', function () {
      purgeAllTrash();
    });
  }
  if ($('#trash-ws')) {
    $('#trash-ws').addEventListener('change', function (e) {
      state.trashWsId = e.target.value;
      loadTrashPage(true);
    });
  }
}

function enterTrashRoute() {
  loadTrashPage(true);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bindTrashUI);
} else {
  bindTrashUI();
}
