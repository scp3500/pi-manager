// ── 记忆 / 知识库 独立页（工作区只做设定） ─────────────────────────────────

function ensureContentState() {
  if (!state.contentReady) {
    state.contentReady = true;
    state.mem = { wsId: '', path: '', dirty: false, meta: null, relRoot: 'memory', mode: 'edit' };
    state.kb = { wsId: '', path: '', dirty: false, meta: null, relRoot: 'knowledge', mode: 'edit' };
  }
  // 兼容旧 state
  if (state.mem && !state.mem.mode) state.mem.mode = 'edit';
  if (state.kb && !state.kb.mode) state.kb.mode = 'edit';
}

function pickContentWorkspace(preferMapKey) {
  const list = state.workspaces || [];
  // 优先：任意已存在 root 且带对应 map 的工作区（不绑定特定 id / 盘符）
  const withMap = list.find((w) => w.rootExists && w.map && w.map[preferMapKey]);
  if (withMap) return withMap;
  // 回退：有 map 但 root 缺失（用于展示「路径不存在」）
  const mappedMissing = list.find((w) => w.map && w.map[preferMapKey]);
  if (mappedMissing) return mappedMissing;
  return list.find((w) => w.rootExists) || list[0] || null;
}

/** 内容映射是否可用（已配置且目录存在） */
function isContentFeatureEnabled(preferMapKey) {
  const f = state.features || {};
  if (preferMapKey === 'knowledge') return f.knowledge !== false;
  return f.memory !== false;
}

function contentMapReady(preferMapKey) {
  if (!isContentFeatureEnabled(preferMapKey)) {
    return { ready: false, disabled: true, workspace: null };
  }
  const w = pickContentWorkspace(preferMapKey);
  if (!w || !w.rootExists || !w.map || !w.map[preferMapKey]) return { ready: false, workspace: w || null };
  const exists = !!(w.mapped && w.mapped[preferMapKey] && w.mapped[preferMapKey].exists);
  return {
    ready: exists,
    workspace: w,
    rel: w.map[preferMapKey],
  };
}

/**
 * 工具栏提示：已就绪用户看操作说明；未就绪才看配置引导。
 * 避免「你已经配好了还一直说可选/去配置」。
 */
function updateCapabilityHints() {
  const mem = contentMapReady('memory');
  const kb = contentMapReady('knowledge');

  const setHint = (id, text) => {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  };

  // 工具栏只说「现在怎样 + 我该点哪」；术语留给空状态详细说明
  if (mem.disabled) {
    setHint('hint-memory', '已关闭 · 在「工作区」打开「启用记忆」开关可恢复');
  } else if (mem.ready) {
    setHint(
      'hint-memory',
      '已连接「' +
        (mem.workspace.name || mem.workspace.id) +
        '」· 点左侧文件即可编辑'
    );
  } else {
    setHint('hint-memory', '还不能用 · 请先到「工作区」指定记忆文件夹');
  }

  if (kb.disabled) {
    setHint('hint-knowledge', '已关闭 · 在「工作区」打开「启用知识库」开关可恢复');
  } else if (kb.ready) {
    setHint(
      'hint-knowledge',
      '已连接「' +
        (kb.workspace.name || kb.workspace.id) +
        '」· 点左侧文件即可编辑'
    );
  } else {
    setHint('hint-knowledge', '还不能用 · 请先到「工作区」指定知识库文件夹');
  }

  if (mem.ready) {
    setHint('hint-agents', '左侧选子代理编辑；也可切到「工作流」改协作规则');
  } else {
    setHint('hint-agents', '左侧选子代理即可编辑（「工作流」规则需先配记忆文件夹）');
  }

  const list = state.workspaces || [];
  const hasExtra = list.some(
    (w) =>
      w.rootExists &&
      w.map &&
      (w.map.memory || w.map.knowledge) &&
      w.id !== 'pi-home'
  );
  if (hasExtra || (mem.ready && kb.ready)) {
    setHint('hint-workspaces', '在这里改文件夹对应关系 · 记忆/知识库已能打开');
  } else if (list.length > 1 || list.some((w) => !w.builtin)) {
    setHint('hint-workspaces', '选中左侧工作区，在映射里填 memory / knowledge 文件夹名并保存');
  } else {
    setHint('hint-workspaces', '点「+ 工作区」添加本机文件夹；没有「建议」也可以');
  }

  if (state.openvlAvailable === false) {
    setHint('hint-openvl', '本页需要先安装识图组件 · 其它功能照常');
  } else if (state.openvlAvailable === true) {
    setHint('hint-openvl', '左侧选配置，可设为当前并测试是否连通');
  }
}

/** 记忆/知识库未就绪：白话说明问题 + 下一步（不堆术语） */
function renderContentFallback(kind, reason) {
  const empty = kind === 'knowledge' ? $('#kb-empty') : $('#mem-empty');
  const editor = kind === 'knowledge' ? $('#kb-editor') : $('#mem-editor');
  const tree = kind === 'knowledge' ? $('#kb-tree') : $('#mem-tree');
  const label = kind === 'knowledge' ? $('#kb-ws-label') : $('#mem-ws-label');
  const key = kind === 'knowledge' ? 'knowledge' : 'memory';
  const title = kind === 'knowledge' ? '知识库' : '记忆';
  const folderHint = kind === 'knowledge' ? 'knowledge' : 'memory';
  if (tree) tree.innerHTML = '';
  empty?.classList.remove('hidden');
  editor?.classList.add('hidden');
  if (label) label.textContent = '未就绪';

  let headline = '还不能打开' + title;
  let why = '';
  let next = '';
  if (reason === 'feature_off') {
    why = '「' + title + '」页开关当前是关闭的（映射配置还在，没有删除）。';
    next =
      '打开「工作区」→「内容页开关」勾选启用「' +
      title +
      '」→「保存开关」→ 回本页点「重新检测」。';
  } else if (reason === 'no_workspace') {
    why = '还没有可用的工作区，程序不知道' + title + '在哪个文件夹。';
    next =
      '「工作区」→「+ 工作区」→ 根路径填本机大文件夹 → 映射里写 <code>"' +
      key +
      '": "' +
      folderHint +
      '"</code>（值=该大文件夹下的子目录名）→ 保存 → 确认「映射状态」为存在 → 回本页刷新。页面上有「怎么映射？」说明。';
  } else if (reason === 'no_map') {
    why = '工作区有了，但映射里还没有 ' + title + ' 这一项。';
    next =
      '「工作区」→ 点左侧对应工作区 → 在映射 JSON 增加一行 <code>"' +
      key +
      '": "' +
      folderHint +
      '"</code> → 保存。注意值是相对根路径，例如子文件夹就叫 ' +
      folderHint +
      ' 就写 "' +
      folderHint +
      '"，不要写 D:/...。';
  } else if (reason === 'root_missing') {
    why = '根路径在这台电脑上不存在（写错、盘符变了、或用了别人的路径）。';
    next = '「工作区」→ 把根路径改成你本机真实文件夹 → 保存。映射一般不用改。';
  } else if (reason === 'path_missing') {
    why = '根路径在，但映射指向的子文件夹还没建出来。';
    next =
      '到根路径下新建文件夹 <code>' +
      folderHint +
      '</code>（名字要和映射里的值一致）→ 回本页刷新；或改映射里的值去对已有文件夹。';
  } else {
    why = '当前没有可用的' + title + '文件夹配置。';
    next = '到「工作区」按「怎么映射？」检查根路径和映射 JSON，保存后再来。';
  }

  if (empty) {
    empty.innerHTML =
      '<div class="empty empty-fallback">' +
      '<p class="empty-kicker">本页暂时不可用 · 其它页一般不受影响</p>' +
      '<p class="empty-title">' +
      esc(headline) +
      '</p>' +
      '<p class="empty-desc"><strong>原因：</strong>' +
      why +
      '</p>' +
      '<p class="empty-desc"><strong>下一步：</strong>' +
      next +
      '</p>' +
      '<p class="empty-desc">模型、子代理、提示词不依赖本页，可照常使用。</p>' +
      '<div class="empty-actions">' +
      '<a class="btn primary sm" href="#/workspaces">去工作区</a>' +
      '<a class="btn ghost sm" href="#/models">去模型</a>' +
      '<button type="button" class="btn ghost sm" data-fallback-reload="' +
      esc(kind) +
      '">我配好了，重新检测</button>' +
      '</div>' +
      '</div>';
    empty.querySelector('[data-fallback-reload]')?.addEventListener('click', () => {
      enterContentPage(kind);
    });
  }
}

function bindContentPages() {
  ensureContentState();
  $('#mem-reload')?.addEventListener('click', () => enterContentPage('memory'));
  $('#kb-reload')?.addEventListener('click', () => enterContentPage('knowledge'));
  $('#mem-save')?.addEventListener('click', () => saveContentFile('memory'));
  $('#kb-save')?.addEventListener('click', () => saveContentFile('knowledge'));
  $('#mem-content')?.addEventListener('input', () => {
    state.mem.dirty = true;
    setDirty('memory', true);
    const b = $('#mem-save');
    if (b) b.disabled = false;
    if (state.mem.mode !== 'edit') renderMarkdownPreview('memory');
  });
  $('#kb-content')?.addEventListener('input', () => {
    state.kb.dirty = true;
    setDirty('knowledge', true);
    const b = $('#kb-save');
    if (b) b.disabled = false;
    if (state.kb.mode !== 'edit') renderMarkdownPreview('knowledge');
  });
  // 文件 CRUD
  $('#mem-new-file')?.addEventListener('click', () => contentCreate('memory', 'file'));
  $('#mem-new-dir')?.addEventListener('click', () => contentCreate('memory', 'dir'));
  $('#mem-rename')?.addEventListener('click', () => contentRename('memory'));
  $('#mem-delete')?.addEventListener('click', () => contentDelete('memory'));
  $('#kb-new-file')?.addEventListener('click', () => contentCreate('knowledge', 'file'));
  $('#kb-new-dir')?.addEventListener('click', () => contentCreate('knowledge', 'dir'));
  $('#kb-rename')?.addEventListener('click', () => contentRename('knowledge'));
  $('#kb-delete')?.addEventListener('click', () => contentDelete('knowledge'));
  // 模式切换：编辑 / 预览 / 分栏
  document.querySelectorAll('.mode-switch .mode-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const kind = btn.dataset.kind === 'knowledge' ? 'knowledge' : 'memory';
      const mode = btn.dataset.mode || 'edit';
      setContentViewMode(kind, mode);
    });
  });
  // 初始模式 UI
  setContentViewMode('memory', state.mem.mode || 'edit');
  setContentViewMode('knowledge', state.kb.mode || 'edit');
}

function contentParentDir(kind) {
  const st = kind === 'knowledge' ? state.kb : state.mem;
  if (st.path) {
    const parts = String(st.path).replace(/\\/g, '/').split('/');
    parts.pop();
    return parts.join('/') || st.relRoot;
  }
  return st.treeData && st.treeData.path ? st.treeData.path : st.relRoot;
}

function updateContentFileActions(kind) {
  const st = kind === 'knowledge' ? state.kb : state.mem;
  const has = !!(st.path && st.wsId);
  const pre = kind === 'knowledge' ? 'kb' : 'mem';
  const ren = document.getElementById(pre + '-rename');
  const del = document.getElementById(pre + '-delete');
  if (ren) ren.disabled = !has;
  if (del) del.disabled = !has;
}

async function contentCreate(kind, type) {
  const st = kind === 'knowledge' ? state.kb : state.mem;
  if (!st.wsId) return showToast('工作区未就绪', false);
  const parent = contentParentDir(kind);
  const hint = type === 'dir' ? '新文件夹名' : '新文件名（建议 .md）';
  const def = type === 'dir' ? 'notes' : 'untitled.md';
  const name = prompt(hint + '（将创建在 ' + parent + '/ 下）:', def);
  if (name == null) return;
  const n = String(name).trim();
  if (!n) return;
  const rel = (parent ? parent.replace(/\/+$/, '') + '/' : '') + n.replace(/^\/+/, '');
  try {
    await api(
      '/api/workspaces/' +
        encodeURIComponent(st.wsId) +
        '/file?path=' +
        encodeURIComponent(rel),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: type === 'dir' ? 'dir' : 'file',
          content: type === 'dir' ? undefined : '# ' + n.replace(/\.md$/i, '') + '\n\n',
        }),
      }
    );
    showToast(type === 'dir' ? '文件夹已创建' : '文件已创建');
    await loadContentTree(kind);
    if (type !== 'dir') await openContentFile(kind, rel, n);
  } catch (e) {
    showToast('创建失败: ' + e.message, false);
  }
}

async function contentRename(kind) {
  const st = kind === 'knowledge' ? state.kb : state.mem;
  if (!st.wsId || !st.path) return showToast('请先打开一个文件', false);
  const base = st.path.split('/').pop();
  const name = prompt('新名称（同目录）:', base);
  if (name == null) return;
  const n = String(name).trim();
  if (!n || n === base) return;
  const parent = st.path.split('/').slice(0, -1).join('/');
  const to = (parent ? parent + '/' : '') + n;
  try {
    await api('/api/workspaces/' + encodeURIComponent(st.wsId) + '/rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: st.path, to }),
    });
    showToast('已重命名');
    st.path = to;
    await loadContentTree(kind);
    await openContentFile(kind, to, n);
  } catch (e) {
    showToast('重命名失败: ' + e.message, false);
  }
}

async function contentDelete(kind) {
  const st = kind === 'knowledge' ? state.kb : state.mem;
  if (!st.wsId || !st.path) return showToast('请先打开一个文件', false);
  const msg1 =
    '将「' + st.path + '」移入工作区 .trash/ ？\n（可从 .trash 目录手动找回，不是系统回收站）';
  if (!confirm(msg1)) return;
  if (!confirm('再次确认移入 .trash：\n' + st.path)) return;
  try {
    const r = await api(
      '/api/workspaces/' +
        encodeURIComponent(st.wsId) +
        '/file?path=' +
        encodeURIComponent(st.path),
      { method: 'DELETE' }
    );
    showToast(r && r.trashPath ? '已移入 .trash/' + r.trashPath.replace(/^\.trash\//, '') : '已移入 .trash');
    st.path = '';
    const empty = kind === 'knowledge' ? $('#kb-empty') : $('#mem-empty');
    const editor = kind === 'knowledge' ? $('#kb-editor') : $('#mem-editor');
    empty?.classList.remove('hidden');
    editor?.classList.add('hidden');
    updateContentFileActions(kind);
    await loadContentTree(kind);
  } catch (e) {
    showToast('删除失败: ' + e.message, false);
  }
}

function renderKbShortcuts() {
  const box = $('#kb-shortcuts');
  if (!box) return;
  const st = state.kb;
  box.innerHTML = '';
  if (!st.wsId || !st.relRoot) return;
  const items = [
    { label: '根目录', path: st.relRoot },
    { label: 'wiki', path: st.relRoot.replace(/\/+$/, '') + '/wiki' },
    { label: 'pi', path: st.relRoot.replace(/\/+$/, '') + '/pi' },
    { label: 'study', path: st.relRoot.replace(/\/+$/, '') + '/study' },
  ];
  items.forEach((it) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn ghost sm';
    b.textContent = it.label;
    b.title = it.path;
    b.addEventListener('click', async () => {
      try {
        const data = await api(
          '/api/workspaces/' +
            encodeURIComponent(st.wsId) +
            '/tree?path=' +
            encodeURIComponent(it.path) +
            '&depth=3'
        );
        st.treeData = data;
        st.expanded = st.expanded || new Set();
        (data.children || []).forEach((n) => {
          if (n.type === 'dir') st.expanded.add(n.path);
        });
        renderContentTree('knowledge');
        showToast('已跳到 ' + it.label);
      } catch (e) {
        showToast(it.label + ' 不可用: ' + e.message, false);
      }
    });
    box.appendChild(b);
  });
}

function setContentViewMode(kind, mode) {
  ensureContentState();
  const st = kind === 'knowledge' ? state.kb : state.mem;
  const next = mode === 'preview' || mode === 'split' ? mode : 'edit';
  st.mode = next;
  const view = kind === 'knowledge' ? $('#kb-view') : $('#mem-view');
  if (view) {
    view.classList.remove('mode-edit', 'mode-preview', 'mode-split');
    view.classList.add('mode-' + next);
  }
  const switchEl = kind === 'knowledge' ? $('#kb-mode-switch') : $('#mem-mode-switch');
  if (switchEl) {
    switchEl.querySelectorAll('.mode-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.mode === next);
    });
  }
  if (next !== 'edit') renderMarkdownPreview(kind);
}

function renderMarkdownPreview(kind) {
  const ta = kind === 'knowledge' ? $('#kb-content') : $('#mem-content');
  const box = kind === 'knowledge' ? $('#kb-preview') : $('#mem-preview');
  if (!box) return;
  const raw = ta?.value || '';
  if (!raw.trim()) {
    box.innerHTML = '<div class="md-empty">暂无内容</div>';
    return;
  }
  try {
    if (typeof renderSafeMarkdown === 'function') {
      box.innerHTML = renderSafeMarkdown(raw);
    } else if (typeof marked !== 'undefined' && marked.parse) {
      box.innerHTML = '<pre class="md-plain">' + esc(raw) + '</pre>';
    } else {
      box.innerHTML = '<pre class="md-plain">' + esc(raw) + '</pre>';
    }
  } catch (e) {
    box.innerHTML = '<div class="md-empty">预览失败: ' + esc(e.message || String(e)) + '</div>';
  }
}

async function enterContentPage(kind) {
  ensureContentState();
  if (!state.workspaces || !state.workspaces.length) {
    try {
      await loadWorkspaces();
    } catch {
      /* ignore */
    }
  }
  const key = kind === 'knowledge' ? 'knowledge' : 'memory';
  const st = kind === 'knowledge' ? state.kb : state.mem;
  const w = pickContentWorkspace(key);
  const label = kind === 'knowledge' ? $('#kb-ws-label') : $('#mem-ws-label');
  const tree = kind === 'knowledge' ? $('#kb-tree') : $('#mem-tree');
  const empty = kind === 'knowledge' ? $('#kb-empty') : $('#mem-empty');
  const editor = kind === 'knowledge' ? $('#kb-editor') : $('#mem-editor');

  // 总开关（不删映射，仅隐藏能力，便于自测空状态）
  if (!isContentFeatureEnabled(key)) {
    renderContentFallback(kind, 'feature_off');
    return;
  }
  // 分层判断：无工作区 / 无 map / root 缺失 / 映射路径不存在
  if (!w) {
    renderContentFallback(kind, 'no_workspace');
    return;
  }
  if (!w.map || !w.map[key]) {
    renderContentFallback(kind, 'no_map');
    return;
  }
  if (!w.rootExists) {
    renderContentFallback(kind, 'root_missing');
    return;
  }
  if (!(w.mapped && w.mapped[key] && w.mapped[key].exists)) {
    renderContentFallback(kind, 'path_missing');
    return;
  }

  st.wsId = w.id;
  st.relRoot = w.map[key];
  if (label) label.textContent = (w.name || w.id) + ' / ' + st.relRoot;
  empty?.classList.add('hidden');
  // 已就绪：工具栏显示当前映射，而不是「去配置」
  if (typeof updateCapabilityHints === 'function') updateCapabilityHints();
  if (kind === 'knowledge') renderKbShortcuts();
  updateContentFileActions(kind);
  // keep editor if same file open; still refresh tree
  await loadContentTree(kind);
}

async function loadContentTree(kind) {
  const st = kind === 'knowledge' ? state.kb : state.mem;
  const treeBox = kind === 'knowledge' ? $('#kb-tree') : $('#mem-tree');
  if (!st.wsId || !treeBox) return;
  if (!st.expanded) st.expanded = new Set();
  // 默认展开根下第一层目录名集合用 path
  try {
    const data = await api(
      '/api/workspaces/' +
        encodeURIComponent(st.wsId) +
        '/tree?path=' +
        encodeURIComponent(st.relRoot) +
        '&depth=4'
    );
    st.treeData = data;
    // 首次：自动展开根层目录
    if (!st._expandedInit) {
      st._expandedInit = true;
      (data.children || []).forEach((n) => {
        if (n.type === 'dir') st.expanded.add(n.path);
      });
    }
    renderContentTree(kind);
  } catch (e) {
    treeBox.innerHTML = '<div class="tree-empty">加载失败: ' + esc(e.message) + '</div>';
  }
}

function renderContentTree(kind) {
  const box = kind === 'knowledge' ? $('#kb-tree') : $('#mem-tree');
  if (!box) return;
  box.innerHTML = '';
  const st = kind === 'knowledge' ? state.kb : state.mem;
  const data = st.treeData;
  if (!st.expanded) st.expanded = new Set();
  if (!data || !data.children || !data.children.length) {
    box.innerHTML = '<div class="tree-empty">空目录</div>';
    return;
  }

  function toggleDir(path) {
    if (st.expanded.has(path)) st.expanded.delete(path);
    else st.expanded.add(path);
    renderContentTree(kind);
  }

  async function ensureDirChildren(node) {
    // 若目录被截断或没有 children，懒加载一层
    if (node.type !== 'dir') return;
    if (node.children && node.children.length && !node.truncated) return;
    try {
      const data2 = await api(
        '/api/workspaces/' +
          encodeURIComponent(st.wsId) +
          '/tree?path=' +
          encodeURIComponent(node.path) +
          '&depth=2'
      );
      node.children = data2.children || [];
      node.truncated = false;
      node._loaded = true;
    } catch (e) {
      showToast('展开失败: ' + e.message, false);
    }
  }

  function addNodes(nodes, depth) {
    nodes.forEach((n) => {
      if (n.type === 'more') {
        const d = document.createElement('div');
        d.className = 'tree-empty';
        d.textContent = '…';
        box.appendChild(d);
        return;
      }
      const isDir = n.type === 'dir';
      const isText = n.type === 'file' && n.text;
      const open = isDir && st.expanded.has(n.path);
      const active = !isDir && st.path === n.path;

      const row = document.createElement('button');
      row.type = 'button';
      row.className =
        'tree-row' +
        (isDir ? ' is-dir' : isText ? ' is-file' : ' is-bin') +
        (open ? ' open' : '') +
        (active ? ' active' : '');
      row.style.setProperty('--depth', String(depth));

      if (isDir) {
        row.innerHTML =
          '<span class="tree-chevron" aria-hidden="true"></span>' +
          '<span class="tree-label">' +
          esc(n.name) +
          '</span>';
        row.title = n.path;
        row.addEventListener('click', async () => {
          if (!open) await ensureDirChildren(n);
          toggleDir(n.path);
        });
      } else {
        row.innerHTML =
          '<span class="tree-dot" aria-hidden="true"></span>' +
          '<span class="tree-label">' +
          esc(n.name) +
          '</span>' +
          (n.size != null ? '<span class="tree-meta">' + esc(formatSize(n.size)) + '</span>' : '');
        row.title = n.path;
        if (isText) {
          row.addEventListener('click', () => openContentFile(kind, n.path, n.name));
        } else {
          row.disabled = true;
        }
      }
      box.appendChild(row);

      if (isDir && open && n.children && n.children.length) {
        addNodes(n.children, depth + 1);
      }
    });
  }

  addNodes(data.children, 0);
}

function formatSize(n) {
  const x = Number(n) || 0;
  if (x < 1024) return x + ' B';
  if (x < 1024 * 1024) return (x / 1024).toFixed(1) + ' KB';
  return (x / 1024 / 1024).toFixed(1) + ' MB';
}

async function openContentFile(kind, relPath, name) {
  const st = kind === 'knowledge' ? state.kb : state.mem;
  if (st.dirty && !confirm('当前文件未保存，切换？')) return;
  try {
    const data = await api(
      '/api/workspaces/' +
        encodeURIComponent(st.wsId) +
        '/file?path=' +
        encodeURIComponent(relPath)
    );
    st.path = data.path;
    st.meta = data;
    st.originalContent = data.content != null ? data.content : '';
    st.dirty = false;
    setDirty(kind, false);

    const empty = kind === 'knowledge' ? $('#kb-empty') : $('#mem-empty');
    const editor = kind === 'knowledge' ? $('#kb-editor') : $('#mem-editor');
    const title = kind === 'knowledge' ? $('#kb-title') : $('#mem-title');
    const meta = kind === 'knowledge' ? $('#kb-meta') : $('#mem-meta');
    const ta = kind === 'knowledge' ? $('#kb-content') : $('#mem-content');
    const save = kind === 'knowledge' ? $('#kb-save') : $('#mem-save');

    empty?.classList.add('hidden');
    editor?.classList.remove('hidden');
    if (title) title.textContent = name || data.path;
    if (meta) {
      meta.textContent =
        data.path +
        ' · ' +
        formatSize(data.size || 0) +
        (data.editable ? ' · 可编辑' : ' · 只读' + (data.reason ? ' (' + data.reason + ')' : ''));
    }
    if (ta) {
      ta.value = data.content != null ? data.content : '';
      ta.disabled = !data.editable;
      // 跟随主题变量，不写死深色
      ta.style.background = '';
      ta.style.color = '';
      ta.style.webkitTextFillColor = '';
    }
    if (save) save.disabled = !data.editable;
    // 打开文件后按当前模式刷新预览，并重绘树高亮
    setContentViewMode(kind, st.mode || 'edit');
    renderContentTree(kind);
    updateContentFileActions(kind);
  } catch (e) {
    showToast('打开失败: ' + e.message, false);
  }
}

async function saveContentFile(kind) {
  const st = kind === 'knowledge' ? state.kb : state.mem;
  if (!st.wsId || !st.path) {
    showToast('没有打开的文件', false);
    return;
  }
  if (st.meta && !st.meta.editable) {
    showToast('该文件不可编辑', false);
    return;
  }
  try {
    const ta = kind === 'knowledge' ? $('#kb-content') : $('#mem-content');
    const content = ta?.value ?? '';
    const original = st.originalContent != null ? st.originalContent : '';
    if (typeof confirmDiffSave === 'function') {
      const ok = await confirmDiffSave(
        '保存' + (kind === 'knowledge' ? '知识库' : '记忆') + ' · ' + st.path,
        original,
        content
      );
      if (!ok) return;
    }
    const data = await api(
      '/api/workspaces/' +
        encodeURIComponent(st.wsId) +
        '/file?path=' +
        encodeURIComponent(st.path),
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      }
    );
    st.meta = data;
    st.originalContent = content;
    st.dirty = false;
    setDirty(kind, false);
    const save = kind === 'knowledge' ? $('#kb-save') : $('#mem-save');
    if (save) save.disabled = true;
    showToast((kind === 'knowledge' ? '知识库' : '记忆') + '已保存');
  } catch (e) {
    showToast('保存失败: ' + e.message, false);
    throw e;
  }
}

async function contentGlobalSave(route) {
  if (route === 'memory') {
    if (!state.mem?.dirty) {
      showToast('没有需要保存的修改');
      return true;
    }
    await saveContentFile('memory');
    return !state.mem.dirty;
  }
  if (route === 'knowledge') {
    if (!state.kb?.dirty) {
      showToast('没有需要保存的修改');
      return true;
    }
    await saveContentFile('knowledge');
    return !state.kb.dirty;
  }
  return false;
}
