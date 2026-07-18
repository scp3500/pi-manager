// ── console pages: prompt / skills / plugins / workspaces (+ files) ─────────

function ensureConsoleState() {
  if (state.promptContent === undefined) {
    state.promptContent = '';
    state.promptMeta = null;
    state.promptDirty = false;
    state.promptItems = [];
    state.currentPromptId = 'agents';
    state.promptMode = 'edit';
    state.skillsData = null;
    state.skillsDirty = false;
    state.pluginsData = null;
    state.pluginsDirty = false;
    state.workspaces = [];
    state.wsSuggestions = [];
    state.currentWsId = null;
    state.wsDetail = null;
    state.wsDirty = false;
    state.wsIsNew = false;
    state.wsTree = null;
    state.wsFilePath = '';
    state.wsFileMeta = null;
    state.wsFileDirty = false;
    state.wsSection = '';
    state.wsShowSettings = false;
  }
  if (!state.promptMode) state.promptMode = 'edit';
}

async function loadConsoleData() {
  ensureConsoleState();
  await Promise.all([loadPromptList(), loadSkillsPage(), loadPluginsPage(), loadWorkspaces()]);
}

function bindConsoleUI() {
  ensureConsoleState();
  // prompt
  $('#prompt-save')?.addEventListener('click', () => savePrompt());
  $('#prompt-reload')?.addEventListener('click', () => loadCurrentPrompt(true));
  $('#prompt-new')?.addEventListener('click', () => createPromptTemplate());
  $('#prompt-delete')?.addEventListener('click', () => deleteCurrentPrompt());
  $('#prompt-content')?.addEventListener('input', () => {
    setDirty('prompt', true);
    if (state.promptMode !== 'edit') renderPromptPreview();
  });
  document.querySelectorAll('#prompt-mode-switch .mode-btn').forEach((btn) => {
    btn.addEventListener('click', () => setPromptViewMode(btn.dataset.mode || 'edit'));
  });
  setPromptViewMode(state.promptMode || 'edit');
  // skills
  $('#skills-save')?.addEventListener('click', () => saveSkillsSettings());
  $('#skills-reload')?.addEventListener('click', () => loadSkillsPage(true));
  $('#skills-settings-form')?.addEventListener('input', () => setDirty('skills', true));
  // plugins
  $('#plugins-save')?.addEventListener('click', () => savePlugins());
  $('#plugins-reload')?.addEventListener('click', () => loadPluginsPage(true));
  $('#plugins-normalize')?.addEventListener('click', () => normalizePluginPaths());
  $('#plugins-form')?.addEventListener('input', () => setDirty('plugins', true));
  // 教程块「复制命令」：data-copy-target=预格式 id（插件/识图/子代理共用）
  document.addEventListener('click', async (e) => {
    const btn = e.target && e.target.closest && e.target.closest('[data-copy-target]');
    if (!btn) return;
    const id = btn.getAttribute('data-copy-target');
    if (!id) return;
    const el = document.getElementById(id);
    const text = (el && el.textContent) || '';
    if (!text.trim()) return;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
      showToast('已复制');
    } catch (err) {
      showToast('复制失败: ' + (err && err.message ? err.message : err), false);
    }
  });
  // workspaces
  $('#ws-new')?.addEventListener('click', () => openNewWorkspace());
  $('#ws-save-one')?.addEventListener('click', () => saveCurrentWorkspace());
  $('#ws-delete')?.addEventListener('click', () => deleteCurrentWorkspace());
  $('#ws-form')?.addEventListener('input', () => setDirty('workspaces', true));
  $('#ws-bootstrap')?.addEventListener('click', () => bootstrapLabWorkspace());
  // 映射表单 ↔ JSON 同步
  ['ws-map-memory', 'ws-map-knowledge', 'ws-map-tools', 'ws-map-docs'].forEach((id) => {
    $('#' + id)?.addEventListener('input', () => {
      syncMapFormToJson();
      setDirty('workspaces', true);
    });
  });
  $('#ws-map')?.addEventListener('blur', () => {
    try {
      syncJsonToMapForm(parseWsMapField());
    } catch {
      /* 无效 JSON 时不回填 */
    }
  });
  // 内容页开关（记忆/知识库）
  $('#feat-save')?.addEventListener('click', () => saveFeatureToggles());
  $('#feat-memory')?.addEventListener('change', () => {
    const st = $('#feat-status');
    if (st) st.textContent = '有未保存的开关变更，点「保存开关」';
  });
  $('#feat-knowledge')?.addEventListener('change', () => {
    const st = $('#feat-status');
    if (st) st.textContent = '有未保存的开关变更，点「保存开关」';
  });
}

// ── prompt multi-file ───────────────────────────────────────────────────────

async function loadPromptList() {
  try {
    const data = await api('/api/prompts');
    state.promptItems = data.items || [];
    renderPromptList();
    if (!state.currentPromptId) state.currentPromptId = 'agents';
    await loadCurrentPrompt(false);
  } catch (e) {
    // fallback legacy
    try {
      await loadCurrentPrompt(true);
    } catch (e2) {
      showToast('加载提示词失败: ' + e.message, false);
    }
  }
}

function renderPromptList() {
  const box = $('#prompt-list');
  if (!box) return;
  box.innerHTML = '';
  const items = state.promptItems || [];
  const groups = [];
  const seen = new Set();
  items.forEach((it) => {
    const g =
      it.group ||
      (it.kind === 'agents' ? '系统提示词' : it.kind === 'memory' ? '记忆规范' : 'Prompt 模板');
    if (!seen.has(g)) {
      seen.add(g);
      groups.push(g);
    }
  });
  groups.forEach((g) => {
    const head = document.createElement('div');
    head.className = 'side-head';
    head.textContent = g;
    box.appendChild(head);
    items
      .filter((it) => {
        const gg =
          it.group ||
          (it.kind === 'agents' ? '系统提示词' : it.kind === 'memory' ? '记忆规范' : 'Prompt 模板');
        return gg === g;
      })
      .forEach((it) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'side-item' + (state.currentPromptId === it.id ? ' active' : '');
        const tag =
          it.kind === 'agents'
            ? '<span class="badge accent">核心</span>'
            : it.kind === 'memory'
              ? '<span class="badge ok">记忆</span>'
              : '<span class="badge">模板</span>';
        btn.innerHTML =
          '<div class="si-title">' +
          esc(it.name) +
          '</div><div class="si-sub">' +
          esc(it.kind === 'memory' ? 'memory/pi' : it.kind === 'agents' ? '系统' : 'prompts/') +
          '</div><div class="si-tags">' +
          tag +
          '</div>';
        btn.addEventListener('click', () => selectPrompt(it.id, true));
        box.appendChild(btn);
      });
  });
}

async function selectPrompt(id, confirmLeave) {
  if (confirmLeave && state.promptDirty && state.currentPromptId !== id && !confirm('有未保存修改，切换？')) {
    return;
  }
  state.currentPromptId = id;
  await loadCurrentPrompt(true);
  renderPromptList();
}

function setPromptViewMode(mode) {
  ensureConsoleState();
  const next = mode === 'preview' || mode === 'split' ? mode : 'edit';
  state.promptMode = next;
  const view = $('#prompt-view');
  if (view) {
    view.classList.remove('mode-edit', 'mode-preview', 'mode-split');
    view.classList.add('mode-' + next);
  }
  document.querySelectorAll('#prompt-mode-switch .mode-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.mode === next);
  });
  if (next !== 'edit') renderPromptPreview();
}

function renderPromptPreview() {
  const ta = $('#prompt-content');
  const box = $('#prompt-preview');
  if (!box) return;
  const raw = ta?.value || '';
  if (!raw.trim()) {
    box.innerHTML = '<div class="md-empty">暂无内容</div>';
    return;
  }
  try {
    if (typeof marked !== 'undefined' && marked.parse) {
      if (marked.setOptions) marked.setOptions({ breaks: true, gfm: true });
      box.innerHTML = marked.parse(raw);
    } else {
      box.innerHTML = '<pre class="md-plain">' + esc(raw) + '</pre>';
    }
  } catch (e) {
    box.innerHTML = '<div class="md-empty">预览失败: ' + esc(e.message || String(e)) + '</div>';
  }
}

async function loadCurrentPrompt(force) {
  try {
    const id = state.currentPromptId || 'agents';
    const data = await api('/api/prompts/' + encodeURIComponent(id));
    state.promptMeta = data;
    state.currentPromptId = data.id || id;
    if (force || !state.promptDirty) {
      state.promptContent = data.content || '';
      state.promptOriginal = data.content || '';
      const ta = $('#prompt-content');
      if (ta) ta.value = state.promptContent;
      setDirty('prompt', false);
    }
    const title = $('#prompt-title');
    if (title) title.textContent = data.name || id;
    const pathEl = $('#prompt-path');
    if (pathEl) {
      const kindLabel =
        data.kind === 'agents' ? '系统提示词' : data.kind === 'memory' ? '记忆规范' : 'Prompt 模板';
      pathEl.textContent =
        kindLabel +
        ' · ' +
        (data.path || '') +
        (data.exists ? ' · ' + (data.size || 0) + ' bytes' : ' · (不存在，保存将创建)');
    }
    const del = $('#prompt-delete');
    if (del) del.disabled = data.kind === 'agents' || data.kind === 'memory';
    renderPromptBackups(data.backups || [], data.id);
    setPromptViewMode(state.promptMode || 'edit');
  } catch (e) {
    showToast('加载提示词失败: ' + e.message, false);
  }
}

// legacy name used by older code paths
async function loadPrompt(force) {
  return loadCurrentPrompt(force);
}

function renderPromptBackups(list, promptId) {
  const box = $('#prompt-backups');
  const cnt = $('#prompt-bak-count');
  if (cnt) cnt.textContent = String(list.length);
  if (!box) return;
  box.innerHTML = '';
  if (!list.length) {
    box.innerHTML = '<span class="muted">暂无备份</span>';
    return;
  }
  list.forEach((b) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'preset-chip';
    btn.textContent = b.name;
    btn.title = new Date(b.mtime).toLocaleString();
    btn.addEventListener('click', async () => {
      if (!confirm('用备份 ' + b.name + ' 覆盖当前文件？')) return;
      try {
        await api('/api/prompt/restore', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: b.name, id: promptId || state.currentPromptId }),
        });
        await loadCurrentPrompt(true);
        showToast('已恢复: ' + b.name);
      } catch (e) {
        showToast('恢复失败: ' + e.message, false);
      }
    });
    box.appendChild(btn);
  });
}

async function savePrompt() {
  try {
    const content = $('#prompt-content')?.value ?? '';
    const id = state.currentPromptId || 'agents';
    const original = state.promptOriginal != null ? state.promptOriginal : state.promptContent || '';
    if (typeof confirmDiffSave === 'function') {
      const ok = await confirmDiffSave('保存提示词 · ' + id, original, content);
      if (!ok) return;
    }
    await api('/api/prompts/' + encodeURIComponent(id), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    state.promptOriginal = content;
    state.promptContent = content;
    await loadPromptList();
    showToast('提示词已保存');
  } catch (e) {
    showToast('保存失败: ' + e.message, false);
    throw e;
  }
}

async function createPromptTemplate() {
  if (state.promptDirty && !confirm('有未保存修改，继续新建？')) return;
  const name = prompt('新模板文件名（.md）:', 'my-workflow.md');
  if (!name) return;
  try {
    const created = await api('/api/prompts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, content: '# ' + name.replace(/\.md$/, '') + '\n\n' }),
    });
    await loadPromptList();
    await selectPrompt(created.id, false);
    showToast('已创建: ' + created.name);
  } catch (e) {
    showToast('创建失败: ' + e.message, false);
  }
}

async function deleteCurrentPrompt() {
  const id = state.currentPromptId;
  if (!id || id === 'agents' || String(id).startsWith('memory:')) {
    showToast('只能删除 prompts 模板，不能删 AGENTS / 记忆规范', false);
    return;
  }
  if (!confirm('删除模板 "' + id + '"？会先备份。')) return;
  try {
    await api('/api/prompts/' + encodeURIComponent(id), { method: 'DELETE' });
    state.currentPromptId = 'agents';
    await loadPromptList();
    showToast('已删除');
  } catch (e) {
    showToast('删除失败: ' + e.message, false);
  }
}

// ── skills / plugins (unchanged logic) ──────────────────────────────────────

async function loadSkillsPage(force) {
  try {
    const data = await api('/api/skills');
    state.skillsData = data;
    if (force || !state.skillsDirty) {
      const en = $('#skills-enable-commands');
      if (en) en.checked = !!(data.settings && data.settings.enableSkillCommands);
      const ta = $('#skills-paths');
      if (ta) ta.value = ((data.settings && data.settings.skills) || []).join('\n');
      setDirty('skills', false);
    }
    const c = $('#skills-count');
    if (c) c.textContent = String((data.skills || []).length);
    renderSkillsList(data.skills || []);
    const sc = $('#skills-scanned');
    if (sc) {
      sc.textContent = (data.scannedDirs || [])
        .map((d) => (d.exists ? '✓ ' : '✗ ') + d.path)
        .join('\n');
    }
  } catch (e) {
    showToast('加载 Skills 失败: ' + e.message, false);
  }
}

function renderSkillsList(list) {
  const box = $('#skills-list');
  if (!box) return;
  box.innerHTML = '';
  if (!list.length) {
    box.innerHTML = '<div class="remote-empty">未扫描到 skill</div>';
    return;
  }
  const enabled = list.filter((s) => s.enabled);
  const disabled = list.filter((s) => !s.enabled);

  function section(title, items) {
    const head = document.createElement('div');
    head.className = 'side-head';
    head.textContent = title + ' · ' + items.length;
    box.appendChild(head);
    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'remote-empty';
      empty.textContent = '无';
      box.appendChild(empty);
      return;
    }
    items.forEach((s) => {
      const row = document.createElement('div');
      row.className = 'skill-row';
      const badges =
        (s.enabled ? '<span class="badge ok">启用</span>' : '<span class="badge warn">禁用</span>') +
        (s.hasSkillMd ? '' : '<span class="badge warn">无 SKILL.md</span>') +
        (s.disableModelInvocation ? '<span class="badge">仅 /skill</span>' : '') +
        (s.canToggle ? '' : '<span class="badge">只读位置</span>');
      row.innerHTML =
        '<div class="skill-main">' +
        '<div class="si-title">' +
        esc(s.name) +
        ' <span class="muted">' +
        esc(s.id) +
        '</span></div>' +
        '<div class="si-sub">' +
        esc(s.description || '') +
        '</div>' +
        '<div class="si-badges">' +
        badges +
        '</div>' +
        '<div class="si-path mono">' +
        esc(s.path) +
        '</div></div>';
      const actions = document.createElement('div');
      actions.className = 'skill-actions';
      if (s.canToggle) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn sm ' + (s.enabled ? 'ghost' : 'primary');
        btn.textContent = s.enabled ? '禁用' : '启用';
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          btn.disabled = true;
          try {
            await toggleSkill(s.id, !s.enabled);
          } finally {
            btn.disabled = false;
          }
        });
        actions.appendChild(btn);
      }
      row.appendChild(actions);
      box.appendChild(row);
    });
  }

  section('已启用', enabled);
  section('已禁用', disabled);
}

async function toggleSkill(id, enabled) {
  try {
    const data = await api('/api/skills/' + encodeURIComponent(id) + '/toggle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: !!enabled }),
    });
    state.skillsData = data;
    const c = $('#skills-count');
    if (c) c.textContent = String((data.skills || []).length);
    renderSkillsList(data.skills || []);
    const sc = $('#skills-scanned');
    if (sc) {
      sc.textContent = (data.scannedDirs || [])
        .map((d) => (d.exists ? '✓ ' : '✗ ') + d.path + (d.role ? ' [' + d.role + ']' : ''))
        .join('\n');
    }
    showToast((enabled ? '已启用: ' : '已禁用: ') + id);
  } catch (e) {
    showToast('切换失败: ' + e.message, false);
  }
}

async function saveSkillsSettings() {
  try {
    const enable = !!$('#skills-enable-commands')?.checked;
    const paths = ($('#skills-paths')?.value || '')
      .split(/\r?\n/)
      .map((x) => x.trim())
      .filter(Boolean);
    await api('/api/skills/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enableSkillCommands: enable, skills: paths }),
    });
    await loadSkillsPage(true);
    showToast('Skills 设置已保存');
  } catch (e) {
    showToast('保存失败: ' + e.message, false);
    throw e;
  }
}

async function loadPluginsPage(force) {
  try {
    const data = await api('/api/plugins');
    state.pluginsData = data;
    if (force || !state.pluginsDirty) {
      const p = $('#plugins-packages');
      if (p) p.value = (data.packages || []).join('\n');
      const e = $('#plugins-extensions');
      if (e) e.value = (data.extensions || []).join('\n');
      setDirty('plugins', false);
    }
    const hint = $('#plugins-path-hint');
    if (hint) {
      hint.textContent = data.needsNormalize
        ? '检测到绝对路径，建议点「路径便携化」写成 ~/.pi/agent/...' 
        : 'extensions 建议用 ~/.pi/agent/extensions/...；保存时会自动便携化。';
    }
    const dir = $('#plugins-local-dir');
    if (dir) dir.textContent = (data.local && data.local.dir) || '';
    const box = $('#plugins-local-list');
    if (box) {
      box.innerHTML = '';
      const items = (data.local && data.local.items) || [];
      if (!items.length) {
        box.innerHTML = '<div class="remote-empty">目录为空或不存在</div>';
      } else {
        items.forEach((it) => {
          const row = document.createElement('div');
          row.className = 'plugin-row';
          row.innerHTML =
            '<strong>' +
            esc(it.name) +
            '</strong><span class="badge">' +
            esc(it.type) +
            '</span><span class="mono">' +
            esc(it.path) +
            '</span>';
          box.appendChild(row);
        });
      }
    }
  } catch (e) {
    showToast('加载插件失败: ' + e.message, false);
  }
}

async function normalizePluginPaths() {
  try {
    const r = await api('/api/plugins/normalize-paths', { method: 'POST' });
    await loadPluginsPage(true);
    showToast(r.changed ? '已写成便携路径（~/...）' : '已经是便携路径，无需改动');
  } catch (e) {
    showToast('路径便携化失败: ' + e.message, false);
  }
}

async function savePlugins() {
  try {
    const packages = ($('#plugins-packages')?.value || '')
      .split(/\r?\n/)
      .map((x) => x.trim())
      .filter(Boolean);
    const extensions = ($('#plugins-extensions')?.value || '')
      .split(/\r?\n/)
      .map((x) => x.trim())
      .filter(Boolean);
    await api('/api/plugins', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ packages, extensions }),
    });
    await loadPluginsPage(true);
    showToast('插件设置已保存');
  } catch (e) {
    showToast('保存失败: ' + e.message, false);
    throw e;
  }
}

// ── workspaces + file browser ───────────────────────────────────────────────

async function loadWorkspaces() {
  try {
    const data = await api('/api/workspaces');
    state.workspaces = data.workspaces || [];
    state.wsSuggestions = data.suggestions || [];
    state.features = data.features || state.features || {};
    // 缺省视为开启（兼容旧 pi-manager.json）
    if (state.features.memory === undefined) state.features.memory = true;
    if (state.features.knowledge === undefined) state.features.knowledge = true;
    renderWorkspaceList();
    renderWsSuggestions();
    renderFeatureToggles();
    if (typeof updateCapabilityHints === 'function') updateCapabilityHints();
  } catch (e) {
    showToast('加载工作区失败: ' + e.message, false);
  }
}

function renderFeatureToggles() {
  const f = state.features || {};
  const m = $('#feat-memory');
  const k = $('#feat-knowledge');
  if (m) m.checked = f.memory !== false;
  if (k) k.checked = f.knowledge !== false;
  const st = $('#feat-status');
  if (st) {
    st.textContent =
      '记忆：' +
      (f.memory === false ? '关' : '开') +
      ' · 知识库：' +
      (f.knowledge === false ? '关' : '开') +
      ' · 关掉只影响对应页，不删映射';
  }
}

async function saveFeatureToggles() {
  try {
    const body = {
      memory: !!$('#feat-memory')?.checked,
      knowledge: !!$('#feat-knowledge')?.checked,
    };
    const data = await api('/api/features', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    state.features = data.features || body;
    renderFeatureToggles();
    if (typeof updateCapabilityHints === 'function') updateCapabilityHints();
    showToast('内容页开关已保存');
  } catch (e) {
    showToast('保存开关失败: ' + e.message, false);
  }
}

function renderWorkspaceList() {
  const box = $('#ws-list');
  if (!box) return;
  box.innerHTML = '';
  (state.workspaces || []).forEach((w) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'side-item' + (state.currentWsId === w.id && !state.wsIsNew ? ' active' : '');
    btn.innerHTML =
      '<div class="si-title">' +
      esc(w.name || w.id) +
      '</div>' +
      '<div class="si-sub">' +
      esc(w.root) +
      '</div>' +
      '<div class="si-tags">' +
      (w.builtin ? '<span class="badge accent">内置</span>' : '') +
      (w.rootExists ? '<span class="badge ok">存在</span>' : '<span class="badge warn">缺失</span>') +
      '</div>';
    btn.addEventListener('click', () => selectWorkspace(w.id, true));
    box.appendChild(btn);
  });
}

function renderWsSuggestions() {
  const box = $('#ws-suggestions');
  if (!box) return;
  box.innerHTML = '';
  const list = state.wsSuggestions || [];
  if (!list.length) {
    box.innerHTML =
      '<div class="empty-fallback compact" style="padding:10px 12px">' +
      '<p class="empty-desc" style="margin:0">没有可一键加入的目录。<strong>下一步：</strong>点上方「+ 工作区」，填写你本机的文件夹路径。</p>' +
      '</div>';
    return;
  }
  list.forEach((s) => {
    const already = (state.workspaces || []).some((w) => w.id === s.id || w.root === s.root);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'side-item';
    btn.disabled = already;
    btn.innerHTML =
      '<div class="si-title">' +
      esc(s.name) +
      '</div><div class="si-sub">' +
      esc(s.root) +
      '</div><div class="si-tags"><span class="badge">' +
      (already ? '已添加' : '一键加入') +
      '</span></div>';
    if (!already) {
      btn.addEventListener('click', async () => {
        try {
          await api('/api/workspaces/adopt', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: s.id }),
          });
          await loadWorkspaces();
          await selectWorkspace(s.id, false);
          showToast('已加入: ' + s.name);
        } catch (e) {
          showToast('加入失败: ' + e.message, false);
        }
      });
    }
    box.appendChild(btn);
  });
}

function showWsEmpty() {
  state.currentWsId = null;
  state.wsDetail = null;
  state.wsIsNew = false;
  $('#ws-empty')?.classList.remove('hidden');
  $('#ws-editor')?.classList.add('hidden');
  renderWorkspaceList();
}

async function selectWorkspace(id, confirmLeave) {
  if (
    confirmLeave &&
    (state.wsDirty || state.wsFileDirty) &&
    state.currentWsId !== id &&
    !confirm('有未保存修改，切换？')
  ) {
    return;
  }
  try {
    const w = await api('/api/workspaces/' + encodeURIComponent(id));
    state.currentWsId = id;
    state.wsDetail = w;
    state.wsIsNew = false;
    fillWsForm(w);
    $('#ws-empty')?.classList.add('hidden');
    $('#ws-editor')?.classList.remove('hidden');
    $('#ws-title').textContent = w.name || id;
    $('#ws-id').readOnly = true;
    $('#ws-delete').disabled = !!w.builtin;
    setDirty('workspaces', false);
    state.wsFileDirty = false;
    renderWorkspaceList();
  } catch (e) {
    showToast('读取工作区失败: ' + e.message, false);
  }
}

function openNewWorkspace() {
  if ((state.wsDirty || state.wsFileDirty) && !confirm('有未保存修改，继续新建？')) return;
  state.wsIsNew = true;
  state.currentWsId = null;
  state.wsDetail = null;
  fillWsForm({
    id: '',
    name: '',
    root: '',
    map: { memory: 'memory', knowledge: 'knowledge', tools: 'tools', docs: 'docs' },
    builtin: false,
    rootExists: false,
    mapped: {},
  });
  $('#ws-empty')?.classList.add('hidden');
  $('#ws-editor')?.classList.remove('hidden');
  $('#ws-title').textContent = '新建工作区';
  $('#ws-id').readOnly = false;
  $('#ws-delete').disabled = true;
  setDirty('workspaces', false);
  renderWorkspaceList();
  $('#ws-id')?.focus();
}

function toggleWsSettings() {
  state.wsShowSettings = !state.wsShowSettings;
  applyWsPanes();
  const btn = $('#ws-settings-toggle');
  if (btn) btn.textContent = state.wsShowSettings ? '返回内容' : '映射设置';
}

function applyWsPanes() {
  const browse = $('#ws-browse-pane');
  const settings = $('#ws-settings-pane');
  if (state.wsShowSettings || state.wsIsNew) {
    browse?.classList.add('hidden');
    settings?.classList.remove('hidden');
  } else {
    browse?.classList.remove('hidden');
    settings?.classList.add('hidden');
  }
}

function renderWsSections() {
  const box = $('#ws-sections');
  if (!box) return;
  box.innerHTML = '';
  const w = state.wsDetail;
  if (!w || !w.map) {
    box.innerHTML = '<div class="muted" style="padding:10px">先选工作区</div>';
    return;
  }
  const order = [
    'memory',
    'knowledge',
    'tools',
    'docs',
    'research',
    'runtime',
    'pi',
    'agents',
    'skills',
    'prompts',
  ];
  const keys = Object.keys(w.map || {});
  keys.sort((a, b) => {
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });
  const allBtn = document.createElement('button');
  allBtn.type = 'button';
  allBtn.className = 'side-item' + (state.wsSection === '' ? ' active' : '');
  allBtn.innerHTML = '<div class="si-title">全部 (root)</div><div class="si-sub">工作区根目录</div>';
  allBtn.addEventListener('click', () => selectWsSection(''));
  box.appendChild(allBtn);
  keys.forEach((k) => {
    const mapped = (w.mapped && w.mapped[k]) || {};
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'side-item' + (state.wsSection === k ? ' active' : '');
    const label =
      k === 'memory' ? '记忆' : k === 'knowledge' ? '知识库' : k === 'tools' ? '工具' : k === 'docs' ? '文档' : k;
    btn.innerHTML =
      '<div class="si-title">' +
      esc(label) +
      '</div><div class="si-sub">' +
      esc(mapped.rel || w.map[k] || k) +
      '</div><div class="si-tags">' +
      (mapped.exists ? '<span class="badge ok">存在</span>' : '<span class="badge warn">缺失</span>') +
      (k === 'memory' || k === 'knowledge' ? '<span class="badge accent">主</span>' : '') +
      '</div>';
    btn.addEventListener('click', () => selectWsSection(k));
    box.appendChild(btn);
  });
}

async function selectWsSection(section) {
  if (state.wsFileDirty && !confirm('当前文件未保存，切换分区？')) return;
  state.wsSection = section || '';
  state.wsShowSettings = false;
  applyWsPanes();
  renderWsSections();
  clearWsFileEditor();
  const stBtn = $('#ws-settings-toggle');
  if (stBtn) stBtn.textContent = '映射设置';
  const rel = section ? state.wsDetail?.map?.[section] || section : '';
  await loadWsTree(rel);
  const title = $('#ws-title');
  if (title && state.wsDetail) {
    const label =
      !section
        ? '全部'
        : section === 'memory'
          ? '记忆'
          : section === 'knowledge'
            ? '知识库'
            : section;
    title.textContent = (state.wsDetail.name || state.wsDetail.id) + ' · ' + label;
  }
}

function syncMapFormToJson() {
  let obj = {};
  try {
    obj = parseWsMapField();
  } catch {
    obj = {};
  }
  const setOrDel = (key, val) => {
    const v = String(val || '').trim();
    if (v) obj[key] = v;
    else delete obj[key];
  };
  setOrDel('memory', $('#ws-map-memory')?.value);
  setOrDel('knowledge', $('#ws-map-knowledge')?.value);
  setOrDel('tools', $('#ws-map-tools')?.value);
  setOrDel('docs', $('#ws-map-docs')?.value);
  const ta = $('#ws-map');
  if (ta) ta.value = JSON.stringify(obj, null, 2);
}

function syncJsonToMapForm(map) {
  const m = map || {};
  const set = (id, key) => {
    const el = document.getElementById(id);
    if (el) el.value = m[key] != null ? String(m[key]) : '';
  };
  set('ws-map-memory', 'memory');
  set('ws-map-knowledge', 'knowledge');
  set('ws-map-tools', 'tools');
  set('ws-map-docs', 'docs');
}

async function bootstrapLabWorkspace() {
  const root = prompt(
    '本机 lab 根路径（将创建 memory/ knowledge/ 并写映射）:',
    'D:/my-pi-lab'
  );
  if (root == null) return;
  const r = String(root).trim();
  if (!r) return showToast('根路径不能为空', false);
  const name = prompt('显示名称:', '我的工作区');
  if (name == null) return;
  try {
    const data = await api('/api/workspaces/bootstrap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        root: r,
        name: String(name).trim() || '我的工作区',
        seed: true,
        createDirs: true,
      }),
    });
    await loadWorkspaces();
    if (data.workspace && data.workspace.id) {
      await selectWorkspace(data.workspace.id, false);
    }
    showToast(
      'lab 已创建' +
        (data.createdDirs && data.createdDirs.length
          ? ' · 新建目录 ' + data.createdDirs.length
          : '') +
        (data.seeded && data.seeded.length ? ' · 种子 ' + data.seeded.length : '')
    );
  } catch (e) {
    showToast('创建失败: ' + e.message, false);
  }
}

function fillWsForm(w) {
  $('#ws-id').value = w.id || '';
  $('#ws-name').value = w.name || '';
  $('#ws-root').value = w.root || '';
  $('#ws-map').value = JSON.stringify(w.map || {}, null, 2);
  syncJsonToMapForm(w.map || {});
  $('#ws-meta').textContent = w.builtin
    ? '内置工作区（不可删除）' + (w.rootExists ? '' : ' · 根路径当前不存在')
    : w.rootExists
      ? '根路径存在'
      : '根路径不存在或不可访问';
  const box = $('#ws-mapped');
  if (box) {
    box.innerHTML = '';
    const mapped = w.mapped || {};
    const keys = Object.keys(mapped);
    if (!keys.length) {
      box.innerHTML = '<div class="remote-empty">无映射或根路径不可用</div>';
    } else {
      keys.forEach((k) => {
        const m = mapped[k];
        const row = document.createElement('div');
        row.className = 'remote-item';
        row.style.gridTemplateColumns = '100px 1fr auto';
        row.style.cursor = m.exists ? 'pointer' : 'default';
        row.innerHTML =
          '<strong>' +
          esc(k) +
          '</strong><span class="mono" style="font-size:12px">' +
          esc(m.path) +
          '</span><span class="badge ' +
          (m.exists ? 'ok' : 'warn') +
          '">' +
          (m.exists ? '存在' : '缺失') +
          '</span>';
        // 映射状态只读展示
        box.appendChild(row);
      });
    }
  }
}

function parseWsMapField() {
  const raw = ($('#ws-map')?.value || '').trim();
  if (!raw) return {};
  try {
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('map 必须是对象');
    return obj;
  } catch (e) {
    throw new Error('map JSON 无效: ' + e.message);
  }
}

async function saveCurrentWorkspace() {
  try {
    // if only file dirty, save file
    if (state.wsFileDirty && !state.wsDirty && state.wsFilePath) {
      await saveWsFile();
      return;
    }
    const payload = {
      name: ($('#ws-name').value || '').trim(),
      root: ($('#ws-root').value || '').trim(),
      map: parseWsMapField(),
    };
    if (state.wsIsNew) {
      const id = ($('#ws-id').value || '').trim();
      if (id) payload.id = id;
      if (!payload.root) throw new Error('root 必填');
      const created = await api('/api/workspaces', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      await loadWorkspaces();
      state.wsShowSettings = false;
      await selectWorkspace(created.id, false);
      showToast('工作区已创建');
    } else {
      if (!state.currentWsId) throw new Error('未选中工作区');
      await api('/api/workspaces/' + encodeURIComponent(state.currentWsId), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (state.wsFileDirty && state.wsFilePath) await saveWsFile();
      await loadWorkspaces();
      await selectWorkspace(state.currentWsId, false);
      showToast('工作区已保存');
    }
  } catch (e) {
    showToast('保存失败: ' + e.message, false);
    throw e;
  }
}

async function deleteCurrentWorkspace() {
  if (!state.currentWsId || state.wsIsNew) return;
  if (!confirm('删除工作区 "' + state.currentWsId + '"？')) return;
  try {
    await api('/api/workspaces/' + encodeURIComponent(state.currentWsId), { method: 'DELETE' });
    await loadWorkspaces();
    showWsEmpty();
    showToast('已删除');
  } catch (e) {
    showToast('删除失败: ' + e.message, false);
  }
}

async function loadWsTree(rel) {
  if (!state.currentWsId || state.wsIsNew) return;
  try {
    if (rel === undefined || rel === null) {
      const sec = state.wsSection;
      rel = sec ? state.wsDetail?.map?.[sec] || sec : '';
    }
    const q = rel ? '?path=' + encodeURIComponent(rel) + '&depth=3' : '?depth=2';
    const data = await api('/api/workspaces/' + encodeURIComponent(state.currentWsId) + '/tree' + q);
    state.wsTree = data;
    renderWsTree(data);
    const p = $('#ws-file-path');
    if (p) p.textContent = (data.path ? data.path + ' · ' : '') + data.count + ' 项';
  } catch (e) {
    const tree = $('#ws-tree');
    if (tree) tree.innerHTML = '<div class="remote-empty">树加载失败: ' + esc(e.message) + '</div>';
  }
}

function renderWsTree(data) {
  const box = $('#ws-tree');
  if (!box) return;
  box.innerHTML = '';
  if (!data || !data.children || !data.children.length) {
    box.innerHTML = '<div class="remote-empty">空目录</div>';
    return;
  }

  function addNodes(nodes, depth) {
    nodes.forEach((n) => {
      if (n.type === 'more') {
        const d = document.createElement('div');
        d.className = 'remote-empty';
        d.textContent = '… 已截断';
        box.appendChild(d);
        return;
      }
      const row = document.createElement('div');
      row.className = 'remote-item';
      row.style.gridTemplateColumns = '1fr auto';
      row.style.paddingLeft = 8 + depth * 12 + 'px';
      const icon = n.type === 'dir' ? '📁 ' : n.text ? '📄 ' : '📦 ';
      row.innerHTML =
        '<div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' +
        icon +
        esc(n.name) +
        (n.truncated ? ' …' : '') +
        '</div>' +
        (n.type === 'file'
          ? '<span class="badge">' + (n.size != null ? n.size : '') + '</span>'
          : '<span class="badge">dir</span>');
      if (n.type === 'dir') {
        row.style.cursor = 'pointer';
        row.addEventListener('click', () => loadWsTree(n.path));
      } else if (n.type === 'file' && n.text) {
        row.style.cursor = 'pointer';
        row.addEventListener('click', () => openWsFile(n.path));
      }
      box.appendChild(row);
      if (n.children && n.children.length) addNodes(n.children, depth + 1);
    });
  }
  // root up link
  if (data.path) {
    const up = document.createElement('div');
    up.className = 'remote-item';
    up.style.cursor = 'pointer';
    up.innerHTML = '<div>⬆ ..</div>';
    up.addEventListener('click', () => {
      const parent = data.path.split('/').slice(0, -1).join('/');
      loadWsTree(parent);
    });
    box.appendChild(up);
  }
  addNodes(data.children, 0);
}

function clearWsFileEditor() {
  state.wsFilePath = '';
  state.wsFileMeta = null;
  state.wsFileDirty = false;
  const ta = $('#ws-file-content');
  if (ta) {
    ta.value = '';
    ta.disabled = true;
  }
  const save = $('#ws-file-save');
  if (save) save.disabled = true;
  const meta = $('#ws-file-meta');
  if (meta) meta.textContent = '选择左侧文本文件预览/编辑';
}

async function openWsFile(relPath) {
  if (!state.currentWsId) return;
  if (state.wsFileDirty && !confirm('当前文件未保存，切换？')) return;
  try {
    const data = await api(
      '/api/workspaces/' +
        encodeURIComponent(state.currentWsId) +
        '/file?path=' +
        encodeURIComponent(relPath)
    );
    state.wsFilePath = data.path;
    state.wsFileMeta = data;
    state.wsFileDirty = false;
    const ta = $('#ws-file-content');
    if (ta) {
      ta.value = data.content != null ? data.content : '';
      ta.disabled = !data.editable;
    }
    const save = $('#ws-file-save');
    if (save) save.disabled = !data.editable;
    const meta = $('#ws-file-meta');
    if (meta) {
      meta.textContent =
        data.path +
        ' · ' +
        (data.size || 0) +
        ' bytes' +
        (data.editable ? ' · 可编辑' : ' · 只读' + (data.reason ? ' (' + data.reason + ')' : '')) +
        (data.truncated ? ' · 已截断预览' : '');
    }
  } catch (e) {
    showToast('打开文件失败: ' + e.message, false);
  }
}

async function saveWsFile() {
  if (!state.currentWsId || !state.wsFilePath) {
    showToast('没有打开的文件', false);
    return;
  }
  if (state.wsFileMeta && !state.wsFileMeta.editable) {
    showToast('该文件不可编辑', false);
    return;
  }
  try {
    const content = $('#ws-file-content')?.value ?? '';
    const data = await api(
      '/api/workspaces/' +
        encodeURIComponent(state.currentWsId) +
        '/file?path=' +
        encodeURIComponent(state.wsFilePath),
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      }
    );
    state.wsFileMeta = data;
    state.wsFileDirty = false;
    // if workspace form not dirty, clear global dirty
    if (!state.wsDirty) setDirty('workspaces', false);
    showToast('文件已保存');
  } catch (e) {
    showToast('保存文件失败: ' + e.message, false);
    throw e;
  }
}

// ── routing helpers ─────────────────────────────────────────────────────────

function enterConsoleRoute(next) {
  ensureConsoleState();
  const pages = ['prompt', 'skills', 'plugins', 'workspaces'];
  pages.forEach((p) => {
    $('#page-' + p)?.classList.toggle('hidden', next !== p);
  });
  if (next === 'prompt') loadPromptList();
  else if (next === 'skills') loadSkillsPage(false);
  else if (next === 'plugins') loadPluginsPage(false);
  else if (next === 'workspaces') {
    loadWorkspaces().then(() => {
      if (state.currentWsId) selectWorkspace(state.currentWsId, false);
      else if (state.workspaces[0]) selectWorkspace(state.workspaces[0].id, false);
      else showWsEmpty();
    });
  }
}

async function consoleGlobalSave(route) {
  if (route === 'prompt') {
    if (!state.promptDirty) {
      showToast('没有需要保存的修改');
      return true;
    }
    await savePrompt();
    return !state.promptDirty;
  }
  if (route === 'skills') {
    if (!state.skillsDirty) {
      showToast('没有需要保存的修改');
      return true;
    }
    await saveSkillsSettings();
    return !state.skillsDirty;
  }
  if (route === 'plugins') {
    if (!state.pluginsDirty) {
      showToast('没有需要保存的修改');
      return true;
    }
    await savePlugins();
    return !state.pluginsDirty;
  }
  if (route === 'workspaces') {
    if ($('#ws-editor')?.classList.contains('hidden')) {
      showToast('没有打开的工作区可保存', false);
      return false;
    }
    if (!state.wsDirty) {
      showToast('没有需要保存的修改');
      return true;
    }
    await saveCurrentWorkspace();
    return !state.wsDirty;
  }
  return false;
}

function isConsoleDirty() {
  ensureConsoleState();
  return !!(
    state.promptDirty ||
    state.skillsDirty ||
    state.pluginsDirty ||
    state.wsDirty ||
    state.wsFileDirty
  );
}

function routeHashFor(route) {
  const map = {
    dashboard: '#/dashboard',
    search: '#/search',
    sessions: '#/sessions',
    usage: '#/usage',
    runtime: '#/runtime',
    trash: '#/trash',
    models: '#/models',
    agents: '#/agents',
    openvl: '#/openvl',
    prompt: '#/prompt',
    skills: '#/skills',
    plugins: '#/plugins',
    guides: '#/guides',
    memory: '#/memory',
    knowledge: '#/knowledge',
    workspaces: '#/workspaces',
  };
  return map[route] || '#/dashboard';
}

let _guidePollTimer = null;
let _guideInstallStatus = null;

function setGuideStatus(el, text, kind) {
  if (!el) return;
  el.textContent = text || '';
  el.classList.remove('ok', 'warn', 'err', 'busy');
  if (kind) el.classList.add(kind);
}

function setGuideLog(pre, text, show) {
  if (!pre) return;
  pre.textContent = text || '';
  pre.classList.toggle('hidden', !show || !String(text || '').trim());
  if (show) pre.scrollTop = pre.scrollHeight;
}

async function refreshGuideInstallStatus() {
  try {
    const st = await api('/api/install/status');
    _guideInstallStatus = st;
    paintGuideInstallStatus(st);
    return st;
  } catch {
    return null;
  }
}

function paintGuideInstallStatus(st) {
  if (!st) return;
  const ov = $('#guide-openvl-status');
  const ag = $('#guide-agent-status');
  const pl = $('#guide-plugin-status');
  const ovBtn = $('#guide-install-openvl');
  const agBtn = $('#guide-install-agent');
  const plBtn = $('#guide-install-plugin');

  if (ov) {
    if (st.openvl && st.openvl.available) {
      setGuideStatus(ov, '已安装' + (st.openvl.pkgDir ? ' · ' + st.openvl.pkgDir : ''), 'ok');
      if (ovBtn) {
        ovBtn.disabled = false;
        ovBtn.textContent = '重新安装 / 更新 OpenVL';
      }
    } else if (!(st.tools && st.tools.npm)) {
      setGuideStatus(ov, '未检测到 npm，请先安装 Node.js', 'warn');
      if (ovBtn) ovBtn.disabled = true;
    } else {
      setGuideStatus(ov, '未检测到 OpenVL，可一键安装', 'warn');
      if (ovBtn) {
        ovBtn.disabled = false;
        ovBtn.textContent = '一键安装 OpenVL';
      }
    }
  }

  if (ag) {
    const n = (st.agents && st.agents.count) || 0;
    setGuideStatus(ag, '当前子代理 ' + n + ' 个 · 一键可创建 starter-helper 模板', n ? 'ok' : 'warn');
  }
  if (agBtn) agBtn.disabled = false;

  if (pl) {
    if (!(st.tools && st.tools.pi)) {
      setGuideStatus(pl, '未检测到 pi CLI，无法一键装包（请先安装 Pi）', 'warn');
      if (plBtn) plBtn.disabled = true;
    } else {
      setGuideStatus(pl, 'pi 可用，输入 npm:包名 后点安装', 'ok');
      if (plBtn) plBtn.disabled = false;
    }
  }

  // resume polling if a job is running
  const jobs = st.jobs || {};
  if (jobs.openvl && jobs.openvl.running) startGuidePoll('openvl');
  if (jobs.plugin && jobs.plugin.running) startGuidePoll('plugin');
}

function startGuidePoll(jobId) {
  stopGuidePoll();
  const tick = async () => {
    try {
      const job = await api('/api/install/jobs/' + encodeURIComponent(jobId));
      const logEl =
        jobId === 'openvl' ? $('#guide-openvl-log') : $('#guide-plugin-log');
      const stEl =
        jobId === 'openvl' ? $('#guide-openvl-status') : $('#guide-plugin-status');
      const btn =
        jobId === 'openvl' ? $('#guide-install-openvl') : $('#guide-install-plugin');
      setGuideLog(logEl, job.log || '', true);
      if (job.running) {
        setGuideStatus(stEl, '安装中… ' + (job.target || ''), 'busy');
        if (btn) btn.disabled = true;
        _guidePollTimer = setTimeout(tick, 900);
      } else {
        if (btn) btn.disabled = false;
        setGuideStatus(
          stEl,
          job.ok ? '安装完成' : '安装失败（exit ' + (job.code ?? '?') + '）',
          job.ok ? 'ok' : 'err'
        );
        if (typeof showToast === 'function') {
          showToast(job.ok ? '安装完成' : '安装失败，见日志', !!job.ok);
        }
        await refreshGuideInstallStatus();
        if (job.ok && jobId === 'openvl' && typeof loadOpenvl === 'function') {
          try {
            await loadOpenvl();
          } catch {
            /* ignore */
          }
        }
        if (job.ok && jobId === 'plugin' && typeof loadPluginsPage === 'function') {
          try {
            await loadPluginsPage(true);
          } catch {
            /* ignore */
          }
        }
      }
    } catch (e) {
      stopGuidePoll();
    }
  };
  tick();
}

function stopGuidePoll() {
  if (_guidePollTimer) {
    clearTimeout(_guidePollTimer);
    _guidePollTimer = null;
  }
}

async function runGuideInstallOpenvl() {
  const btn = $('#guide-install-openvl');
  const stEl = $('#guide-openvl-status');
  const logEl = $('#guide-openvl-log');
  try {
    if (btn) btn.disabled = true;
    setGuideStatus(stEl, '正在启动安装…', 'busy');
    setGuideLog(logEl, '', true);
    const res = await api('/api/install/openvl', { method: 'POST', body: '{}' });
    if (res.job) setGuideLog(logEl, res.job.log || '', true);
    startGuidePoll('openvl');
  } catch (e) {
    if (btn) btn.disabled = false;
    setGuideStatus(stEl, e.message || String(e), 'err');
    if (typeof showToast === 'function') showToast(e.message || String(e), false);
  }
}

async function runGuideInstallPlugin() {
  const spec = ($('#guide-plugin-spec')?.value || '').trim();
  const btn = $('#guide-install-plugin');
  const stEl = $('#guide-plugin-status');
  const logEl = $('#guide-plugin-log');
  if (!spec) {
    setGuideStatus(stEl, '请先填写 npm:包名', 'warn');
    return;
  }
  try {
    if (btn) btn.disabled = true;
    setGuideStatus(stEl, '正在启动安装…', 'busy');
    setGuideLog(logEl, '', true);
    const res = await api('/api/install/plugin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ spec }),
    });
    if (res.job) setGuideLog(logEl, res.job.log || '', true);
    startGuidePoll('plugin');
  } catch (e) {
    if (btn) btn.disabled = false;
    setGuideStatus(stEl, e.message || String(e), 'err');
    if (typeof showToast === 'function') showToast(e.message || String(e), false);
  }
}

async function runGuideCreateAgent() {
  const btn = $('#guide-install-agent');
  const stEl = $('#guide-agent-status');
  try {
    if (btn) btn.disabled = true;
    setGuideStatus(stEl, '创建中…', 'busy');
    const res = await api('/api/install/agent-starter', {
      method: 'POST',
      body: '{}',
    });
    setGuideStatus(stEl, res.message || '完成', res.ok ? 'ok' : 'err');
    if (typeof showToast === 'function') showToast(res.message || '完成', !!res.ok);
    if (typeof loadAgents === 'function') {
      try {
        await loadAgents();
      } catch {
        /* ignore */
      }
    }
    await refreshGuideInstallStatus();
  } catch (e) {
    setGuideStatus(stEl, e.message || String(e), 'err');
    if (typeof showToast === 'function') showToast(e.message || String(e), false);
  } finally {
    if (btn) btn.disabled = false;
  }
}

function enterGuidesRoute(topic) {
  const allowed = ['agents', 'openvl', 'plugins'];
  let t = String(topic || 'agents').toLowerCase();
  if (!allowed.includes(t)) t = 'agents';
  document.querySelectorAll('#guides-tabs .guides-tab').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.topic === t);
  });
  document.querySelectorAll('#page-guides .guide-panel').forEach((panel) => {
    panel.classList.toggle('hidden', panel.dataset.topic !== t);
  });
  if (location.hash === '#/guides' || location.hash === '#/guides/') {
    history.replaceState(null, '', '#/guides?topic=' + encodeURIComponent(t));
  }
  refreshGuideInstallStatus();
  if (typeof refreshIcons === 'function') refreshIcons();
}

function bindGuidesUI() {
  $('#guides-tabs')?.addEventListener('click', (e) => {
    const btn = e.target && e.target.closest && e.target.closest('.guides-tab');
    if (!btn) return;
    const topic = btn.dataset.topic || 'agents';
    location.hash = '#/guides?topic=' + encodeURIComponent(topic);
  });
  $('#guide-install-openvl')?.addEventListener('click', () => runGuideInstallOpenvl());
  $('#guide-install-plugin')?.addEventListener('click', () => runGuideInstallPlugin());
  $('#guide-install-agent')?.addEventListener('click', () => runGuideCreateAgent());
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bindGuidesUI);
} else {
  bindGuidesUI();
}

window.enterGuidesRoute = enterGuidesRoute;
