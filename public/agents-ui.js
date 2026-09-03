/* Agents & Workflows UI for Pi Manager */
(function () {
  const {
    state,
    $,
    $$,
    esc,
    TLM_LEVELS,
    AGENT_TASK_TYPES,
    AGENT_SP_MODES,
    AGENT_BOOL_TRIPLE,
    parseModelSpec,
    composeModelSpec,
    api,
    showToast,
    setDirty,
    updateGlobalSaveUI,
    parseJsonField,
  } = window.PiManagerCore || window;

  async function loadAgents() {
    try {
      state.agents = await api('/api/agents');
    } catch (e) {
      showToast('加载子代理失败: ' + e.message, false);
      state.agents = [];
    }
    const c = $('#agents-count');
    if (c) c.textContent = String(state.agents.length);
    // 同步加载工作流规范列表（pi_config/workflows）
    if (typeof loadWorkflowDocs === 'function') {
      await loadWorkflowDocs();
    }
  }

  async function loadCategories() {
    try {
      state.categories = await api('/api/categories');
    } catch {
      state.categories = [
        { id: 'dev', label: '开发', order: 1, color: '#5aa2ff' },
        { id: 'research', label: '研究', order: 2, color: '#3fb950' },
        { id: 'debug', label: '调试', order: 3, color: '#ffb454' },
        { id: 'org', label: '组织', order: 5, color: '#26c6b8' },
        { id: 'other', label: '其他', order: 9, color: '#8b98a9' },
      ];
    }
    fillCategorySelect();
    renderCategoryFilters();
  }

  function fillCategorySelect(selected) {
    const sel = $('#a-category');
    if (!sel) return;
    const cur = selected != null ? selected : sel.value;
    sel.innerHTML = '';
    state.categories
      .slice()
      .sort((a, b) => (a.order || 0) - (b.order || 0))
      .forEach((c) => {
        const o = document.createElement('option');
        o.value = c.id;
        o.textContent = c.label + ' (' + c.id + ')';
        if (c.id === cur) o.selected = true;
        sel.appendChild(o);
      });
  }

  function renderCategoryFilters() {
    const box = $('#agent-cat-filters');
    if (!box) return;
    const counts = {};
    state.agents.forEach((a) => {
      const c = a.category || 'other';
      counts[c] = (counts[c] || 0) + 1;
    });
    const chips = [
      { id: 'all', label: '全部', color: '#8b98a9', count: state.agents.length },
      ...state.categories
        .slice()
        .sort((a, b) => (a.order || 0) - (b.order || 0))
        .map((c) => ({ ...c, count: counts[c.id] || 0 })),
    ];
    box.innerHTML = chips
      .map(
        (c) => `
      <button type="button" class="cat-filter ${state.agentCategoryFilter === c.id ? 'active' : ''}" data-cat="${esc(c.id)}">
        <span class="dot" style="background:${esc(c.color || '#8b98a9')}"></span>${esc(c.label)}
        <span class="muted">${c.count}</span>
      </button>`
      )
      .join('');
    box.querySelectorAll('[data-cat]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.agentCategoryFilter = btn.dataset.cat;
        renderCategoryFilters();
        renderAgentList();
      });
    });
  }

  function categoryMeta(id) {
    return (
      state.categories.find((c) => c.id === id) || {
        id: 'other',
        label: '其他',
        color: '#8b98a9',
      }
    );
  }

  async function loadToolPool() {
    try {
      state.toolPool = await api('/api/tool-pool');
    } catch {
      state.toolPool = {
        builtins: [
          { id: 'read', label: 'read', desc: '读文件', group: 'readonly' },
          { id: 'grep', label: 'grep', desc: '内容搜索', group: 'readonly' },
          { id: 'find', label: 'find', desc: '找文件', group: 'readonly' },
          { id: 'ls', label: 'ls', desc: '列目录', group: 'readonly' },
          { id: 'bash', label: 'bash', desc: '执行命令', group: 'exec' },
          { id: 'edit', label: 'edit', desc: '精确改文件', group: 'write' },
          { id: 'write', label: 'write', desc: '写/覆盖文件', group: 'write' },
        ],
        presets: {
          readonly: { label: '只读', desc: 'read+搜索', tools: ['read', 'grep', 'find', 'ls'] },
          diagnose: { label: '诊断', desc: '只读+bash', tools: ['read', 'grep', 'find', 'ls', 'bash'] },
          coding: {
            label: '写码',
            desc: '全套',
            tools: ['read', 'grep', 'find', 'ls', 'bash', 'edit', 'write'],
          },
          none: { label: '不限制', desc: '不写 tools', tools: [] },
        },
      };
    }
    renderToolPresets();
    renderToolPool();
  }

  function renderToolPresets() {
    const box = $('#a-tool-presets');
    if (!box) return;
    const presets = state.toolPool.presets || {};
    const entries = Object.entries(presets);
    box.innerHTML =
      entries
        .map(
          ([id, p]) => `
      <button type="button" class="preset-chip" data-preset="${esc(id)}">
        ${esc(p.label || id)}
        <span class="pd">${esc(p.desc || '')}</span>
      </button>`
        )
        .join('') +
      `<button type="button" class="preset-chip" data-preset="custom">自定义<span class="pd">从池子勾选</span></button>`;
    box.querySelectorAll('[data-preset]').forEach((btn) => {
      btn.addEventListener('click', () => applyToolPreset(btn.dataset.preset));
    });
    highlightToolPreset();
  }

  function renderToolPool() {
    const box = $('#a-tool-pool');
    if (!box) return;
    const tools = state.toolPool.builtins || [];
    box.innerHTML = tools
      .map((t) => {
        const on = state.selectedTools.has(t.id);
        return `
        <label class="tool-chip ${on ? 'on' : ''}" data-tool="${esc(t.id)}">
          <input type="checkbox" ${on ? 'checked' : ''} data-tool="${esc(t.id)}">
          <span>
            <div class="tn">${esc(t.label || t.id)}</div>
            <div class="td">${esc(t.desc || '')}</div>
          </span>
        </label>`;
      })
      .join('');
    box.querySelectorAll('input[type=checkbox]').forEach((inp) => {
      inp.addEventListener('change', () => {
        if (inp.checked) state.selectedTools.add(inp.dataset.tool);
        else state.selectedTools.delete(inp.dataset.tool);
        state.activeToolPreset = detectToolPreset();
        highlightToolPreset();
        syncToolsHidden();
        setDirty('agents', true);
        // recolor chips
        box.querySelectorAll('.tool-chip').forEach((chip) => {
          chip.classList.toggle('on', state.selectedTools.has(chip.dataset.tool));
        });
      });
    });
    syncToolsHidden();
  }

  function applyToolPreset(presetId) {
    const presets = state.toolPool.presets || {};
    if (presetId === 'custom') {
      state.activeToolPreset = 'custom';
      highlightToolPreset();
      return;
    }
    const p = presets[presetId];
    if (!p) return;
    state.selectedTools = new Set(p.tools || []);
    state.activeToolPreset = presetId;
    // clear custom extras when applying pure preset
    if (presetId !== 'none') {
      // keep custom field as-is only if user wants — clear for clean preset
      // leave custom tools field alone
    }
    renderToolPool();
    highlightToolPreset();
    syncToolsHidden();
    setDirty('agents', true);
  }

  function detectToolPreset() {
    const builtins = new Set((state.toolPool.builtins || []).map((t) => t.id));
    const selectedBuiltin = [...state.selectedTools].filter((t) => builtins.has(t)).sort();
    const customExtra = ($('#a-tools-custom')?.value || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (customExtra.length) return 'custom';
    if (selectedBuiltin.length === 0) return 'none';
    for (const [id, p] of Object.entries(state.toolPool.presets || {})) {
      if (id === 'none') continue;
      const pt = [...(p.tools || [])].sort();
      if (pt.length === selectedBuiltin.length && pt.every((t, i) => t === selectedBuiltin[i])) {
        return id;
      }
    }
    return 'custom';
  }

  function highlightToolPreset() {
    $$('#a-tool-presets .preset-chip').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.preset === state.activeToolPreset);
    });
  }

  function syncToolsHidden() {
    const custom = ($('#a-tools-custom')?.value || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const all = [...new Set([...state.selectedTools, ...custom])];
    $('#a-tools').value = all.join(', ');
    const sum = $('#a-tools-summary');
    if (sum) {
      if (!all.length) sum.textContent = '不限制（不写 tools 字段）';
      else sum.textContent = all.length + ' 项 · ' + all.join(', ');
    }
  }

  function setToolsFromString(toolsStr) {
    const list = (toolsStr || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const builtinIds = new Set((state.toolPool.builtins || []).map((t) => t.id));
    state.selectedTools = new Set(list.filter((t) => builtinIds.has(t)));
    const extras = list.filter((t) => !builtinIds.has(t));
    if ($('#a-tools-custom')) $('#a-tools-custom').value = extras.join(', ');
    state.activeToolPreset = detectToolPreset();
    renderToolPool();
    highlightToolPreset();
    syncToolsHidden();
  }

  function bindAgentsUI() {
    $('#agent-new').addEventListener('click', openNewAgent);
    $('#agent-save').addEventListener('click', saveAgent);
    $('#agent-delete').addEventListener('click', deleteAgent);
    $('#agent-form').addEventListener('input', (e) => {
      if (e.target && e.target.id === 'a-tools-custom') {
        state.activeToolPreset = detectToolPreset();
        highlightToolPreset();
        syncToolsHidden();
      }
      setDirty('agents', true);
    });
    // 侧栏：子代理 / 工作流 分段
    document.querySelectorAll('#agent-side-switch .side-switch-btn').forEach((btn) => {
      btn.addEventListener('click', () => setAgentSideView(btn.dataset.side || 'agents'));
    });
    // 工作流规范
    $('#workflow-save')?.addEventListener('click', () => saveWorkflowDoc());
    $('#workflow-reload')?.addEventListener('click', () => loadWorkflowDoc(true));
    $('#wf-content')?.addEventListener('input', () => {
      setDirty('workflow', true);
      if (state.workflowMode !== 'edit') renderWorkflowPreview();
    });
    document.querySelectorAll('#wf-mode-switch .mode-btn').forEach((btn) => {
      btn.addEventListener('click', () => setWorkflowMode(btn.dataset.mode || 'edit'));
    });
    // 默认侧栏视图
    if (!state.agentSideView) state.agentSideView = 'agents';
    setAgentSideView(state.agentSideView, true);
    // Ctrl+S 统一由 bindGlobalSave 处理
  }

  function setAgentSideView(view, silent) {
    const next = view === 'workflow' ? 'workflow' : 'agents';
    // 未保存切换提示（仅从内容区角度看：侧栏切换不强制清编辑器）
    if (!silent && state.agentSideView && state.agentSideView !== next) {
      if (next === 'workflow' && state.agentsDirty && !confirm('子代理有未保存修改，仍切换到工作流？')) return;
      if (next === 'agents' && state.workflowDirty && !confirm('工作流规范有未保存修改，仍切换到子代理？')) return;
    }
    state.agentSideView = next;
    document.querySelectorAll('#agent-side-switch .side-switch-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.side === next);
    });
    $('#agent-side-agents')?.classList.toggle('hidden', next !== 'agents');
    $('#agent-side-workflow')?.classList.toggle('hidden', next !== 'workflow');
    // 顶栏「+ 子代理」仅在子代理视图显示
    const newBtn = $('#agent-new');
    if (newBtn) newBtn.classList.toggle('hidden', next !== 'agents');
    // 分类过滤仅子代理有意义
    const filters = $('#agent-cat-filters');
    if (filters) filters.classList.toggle('hidden', next !== 'agents');
    // 空状态文案
    const emptyText = $('#agent-empty-text');
    if (emptyText) {
      emptyText.innerHTML =
        next === 'workflow'
          ? '选择左侧工作流规范（如 <strong>子代理工作流</strong>）进行编辑'
          : '选择左侧子代理，或新建一个';
    }
    // 切换到工作流且当前没打开规范时，显示 empty；打开规范则保持编辑器
    if (next === 'workflow') {
      if (typeof loadWorkflowDocs === 'function') loadWorkflowDocs();
      if (state.currentWorkflowId && state.agentPanel === 'workflow') {
        $('#agent-empty')?.classList.add('hidden');
        $('#workflow-editor')?.classList.remove('hidden');
        $('#agent-editor')?.classList.add('hidden');
      } else if (!state.currentWorkflowId) {
        $('#workflow-editor')?.classList.add('hidden');
        $('#agent-editor')?.classList.add('hidden');
        $('#agent-empty')?.classList.remove('hidden');
      }
    } else {
      if (state.currentAgentName && state.agentPanel === 'agent') {
        $('#agent-empty')?.classList.add('hidden');
        $('#agent-editor')?.classList.remove('hidden');
        $('#workflow-editor')?.classList.add('hidden');
      } else if (!state.currentAgentName) {
        $('#agent-editor')?.classList.add('hidden');
        $('#workflow-editor')?.classList.add('hidden');
        $('#agent-empty')?.classList.remove('hidden');
      }
    }
  }

  const WORKFLOW_DOCS = [
    {
      id: null, // filled by API match
      name: 'AGENTS_SUBAGENT.md',
      title: '子代理工作流',
      blurb: '开发 / 研究 / 调试流程、并行、停不停、指令模板',
      preferred: true,
    },
    {
      name: 'AGENTS_PLAN.md',
      title: '计划模式',
      blurb: 'plan 模式如何写计划、审查与执行',
    },
    {
      name: 'LEARNINGS.md',
      title: '跨会话经验',
      blurb: '仅用户明确要求时读取的经验汇总',
    },
    {
      name: 'cli-communication.md',
      title: 'CLI 通讯',
      blurb: '子代理/CLI 工具通讯约定',
    },
    {
      name: 'rag-query.md',
      title: 'RAG 查询',
      blurb: 'LightRAG 语义检索用法',
    },
  ];

  async function loadWorkflowDocs() {
    try {
      const data = await api('/api/prompts');
      const items = (data.items || []).filter((it) => it.kind === 'memory');
      state.workflowItems = items;
      // 若当前选中的规范已不存在，清空
      if (state.currentWorkflowId && !items.some((x) => x.id === state.currentWorkflowId)) {
        state.currentWorkflowId = null;
      }
      renderWorkflowList();
    } catch (e) {
      const box = $('#agent-workflow-list');
      if (box) box.innerHTML = '<div class="tree-empty">加载规范失败: ' + esc(e.message) + '</div>';
    }
  }


  async function showBuiltinWorkflowTemplate() {
    try {
      // 优先读包内模板（经静态服务）
      let text = '';
      try {
        const r = await fetch('/templates/workflow/AGENTS_SUBAGENT.md');
        if (r.ok) text = await r.text();
      } catch (_) {}
      if (!text) {
        text =
          '# 子代理工作流（内置说明）\n\n' +
          '开发：planner → 确认 → worker → reviewer\n' +
          '研究：planner → researcher 并行 → 主 Agent 综合\n' +
          '调试：investigator → planner → worker → 验证\n\n' +
          '并行用 tasks 数组；共享文件勿并发写。\n';
      }
      state.agentPanel = 'workflow';
      state.currentWorkflowId = null;
      state.workflowMeta = { name: 'AGENTS_SUBAGENT.md', path: '(内置模板·只读)', kind: 'template' };
      state.workflowContent = text;
      const ta = document.getElementById('wf-content');
      if (ta) {
        ta.value = text;
        ta.disabled = true;
      }
      const title = document.getElementById('wf-title');
      if (title) title.textContent = '内置工作流说明（只读）';
      const meta = document.getElementById('wf-meta');
      if (meta) {
        meta.textContent =
          '内置模板 · 不可保存。配置 pi_config/workflows 后可在此编辑你自己的 AGENTS_SUBAGENT.md';
      }
      const save = document.getElementById('workflow-save');
      if (save) save.disabled = true;
      const usage = document.getElementById('wf-usage');
      if (usage) {
        usage.classList.remove('hidden');
        usage.open = true;
      }
      document.getElementById('agent-empty')?.classList.add('hidden');
      document.getElementById('agent-editor')?.classList.add('hidden');
      document.getElementById('workflow-editor')?.classList.remove('hidden');
      if (typeof setWorkflowMode === 'function') setWorkflowMode(state.workflowMode || 'preview');
    } catch (e) {
      showToast('打开模板失败: ' + e.message, false);
    }
  }

  function renderWorkflowList() {
    const box = $('#agent-workflow-list');
    if (!box) return;
    box.innerHTML = '';
    const items = state.workflowItems || [];
    // 只展示规范类，不把会话笔记塞进侧栏（笔记去「记忆」页）
    const preferredNames = WORKFLOW_DOCS.map((d) => d.name);
    const ordered = preferredNames
      .map((n) => items.find((it) => it.name === n))
      .filter(Boolean);

    if (!ordered.length) {
      box.innerHTML =
        '<div class="empty-fallback compact">' +
        '<p class="empty-title" style="font-size:14px;margin:0 0 6px">这里还没有可编辑的规则文件</p>' +
        '<p class="empty-desc" style="margin:0 0 8px"><strong>原因：</strong>还没配置「记忆」文件夹，或其中没有 pi 规则文档。</p>' +
        '<p class="empty-desc" style="margin:0 0 8px"><strong>你仍可：</strong>在左侧「子代理」列表里正常编辑子代理。</p>' +
        '<p class="empty-desc" style="margin:0 0 8px"><strong>若要编辑规则：</strong>去「工作区」指定记忆文件夹并保存，再回来。</p>' +
        '<div class="empty-actions">' +
        '<a class="btn primary sm" href="#/workspaces">去工作区</a>' +
        '<button type="button" class="btn ghost sm" id="wf-show-template">查看内置说明（只读）</button>' +
        '</div></div>';
      box.querySelector('#wf-show-template')?.addEventListener('click', () => showBuiltinWorkflowTemplate());
      return;
    }

    ordered.forEach((it) => {
      const meta = WORKFLOW_DOCS.find((d) => d.name === it.name) || {
        title: it.name.replace(/\.md$/, ''),
        blurb: 'pi_config/workflows',
      };
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className =
        'side-item workflow-item' +
        (state.currentWorkflowId === it.id && state.agentPanel === 'workflow' ? ' active' : '');
      const tag =
        it.name === 'AGENTS_SUBAGENT.md'
          ? '<span class="badge accent">核心流程</span>'
          : it.name === 'AGENTS_PLAN.md'
            ? '<span class="badge ok">计划</span>'
            : '<span class="badge">规范</span>';
      btn.innerHTML =
        '<div class="si-title">' +
        esc(meta.title || it.name) +
        '</div><div class="si-sub">' +
        esc(meta.blurb || it.name) +
        '</div><div class="si-tags">' +
        tag +
        '</div>';
      btn.addEventListener('click', () => selectWorkflow(it.id, true));
      box.appendChild(btn);
    });
  }

  async function selectWorkflow(id, confirmLeave) {
    if (
      confirmLeave &&
      state.workflowDirty &&
      state.currentWorkflowId &&
      state.currentWorkflowId !== id &&
      !confirm('规范有未保存修改，切换？')
    ) {
      return;
    }
    if (
      confirmLeave &&
      state.agentsDirty &&
      state.agentPanel === 'agent' &&
      !confirm('子代理有未保存修改，切换？')
    ) {
      return;
    }
    state.agentPanel = 'workflow';
    state.agentSideView = 'workflow';
    state.currentWorkflowId = id;
    state.currentAgentName = null;
    // 同步侧栏分段 UI（silent，避免二次 confirm）
    document.querySelectorAll('#agent-side-switch .side-switch-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.side === 'workflow');
    });
    $('#agent-side-agents')?.classList.add('hidden');
    $('#agent-side-workflow')?.classList.remove('hidden');
    $('#agent-new')?.classList.add('hidden');
    $('#agent-cat-filters')?.classList.add('hidden');
    await loadWorkflowDoc(true);
    $('#agent-empty')?.classList.add('hidden');
    $('#agent-editor')?.classList.add('hidden');
    $('#workflow-editor')?.classList.remove('hidden');
    renderWorkflowList();
    renderAgentList();
  }

  async function loadWorkflowDoc(force) {
    const id = state.currentWorkflowId;
    if (!id) return;
    try {
      const data = await api('/api/prompts/' + encodeURIComponent(id));
      state.workflowMeta = data;
      if (force || !state.workflowDirty) {
        state.workflowContent = data.content || '';
        const ta = $('#wf-content');
        if (ta) {
          ta.value = state.workflowContent;
          ta.disabled = false;
        }
        const save = $('#workflow-save');
        if (save) save.disabled = false;
        setDirty('workflow', false);
      }
      const title = $('#wf-title');
      const meta = WORKFLOW_DOCS.find((d) => d.name === data.name);
      if (title) title.textContent = (meta && meta.title) || data.name || '工作流规范';
      const metaEl = $('#wf-meta');
      if (metaEl) {
        metaEl.innerHTML =
          '<div><strong>文件</strong> ' +
          esc(data.path || '') +
          '</div><div class="muted" style="margin-top:4px">' +
          esc((meta && meta.blurb) || 'pi_config/workflows 运行规范 · 按需 read，非全文注入系统提示词') +
          '</div>';
      }
      // 核心流程文件显示可折叠用法速查
      const usage = $('#wf-usage');
      if (usage) {
        usage.classList.toggle('hidden', data.name !== 'AGENTS_SUBAGENT.md');
        if (data.name !== 'AGENTS_SUBAGENT.md') usage.open = false;
      }
      setWorkflowMode(state.workflowMode || 'edit');
    } catch (e) {
      showToast('读取规范失败: ' + e.message, false);
    }
  }

  function setWorkflowMode(mode) {
    const next =
      mode === 'preview' || mode === 'split' ? mode : 'edit';
    state.workflowMode = next;
    const view = $('#wf-view');
    if (view) {
      view.classList.remove('mode-edit', 'mode-preview', 'mode-split', 'hidden');
      view.classList.add('mode-' + next);
    }
    document.querySelectorAll('#wf-mode-switch .mode-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.mode === next);
    });
    if (next !== 'edit') renderWorkflowPreview();
  }

  function renderWorkflowPreview() {
    const ta = $('#wf-content');
    const box = $('#wf-preview');
    if (!box) return;
    const raw = ta?.value || '';
    if (!raw.trim()) {
      box.innerHTML = '<div class="md-empty">暂无内容</div>';
      return;
    }
    try {
      if (typeof renderSafeMarkdown === 'function') {
        box.innerHTML = renderSafeMarkdown(raw);
      } else {
        box.innerHTML = '<pre class="md-plain">' + esc(raw) + '</pre>';
      }
    } catch (e) {
      box.innerHTML = '<div class="md-empty">预览失败: ' + esc(e.message || String(e)) + '</div>';
    }
  }

  async function saveWorkflowDoc() {
    const id = state.currentWorkflowId;
    if (!id) {
      showToast('没有打开的规范', false);
      return;
    }
    try {
      const content = $('#wf-content')?.value ?? '';
      await api('/api/prompts/' + encodeURIComponent(id), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      state.workflowContent = content;
      setDirty('workflow', false);
      showToast('工作流规范已保存');
      await loadWorkflowDocs();
    } catch (e) {
      showToast('保存规范失败: ' + e.message, false);
    }
  }

  function fillAgentModelSelect(selected) {
    const sel = $('#a-model');
    sel.innerHTML = '<option value="">(默认模型)</option>';
    const groups = {};
    state.flatModels.forEach((m) => {
      if (!groups[m.providerId]) groups[m.providerId] = [];
      groups[m.providerId].push(m);
    });
    Object.keys(groups)
      .sort()
      .forEach((g) => {
        const og = document.createElement('optgroup');
        og.label = g;
        groups[g].forEach((m) => {
          const o = document.createElement('option');
          o.value = m.id;
          o.textContent = (m.name || m.modelId) + ' (' + m.id + ')';
          if (m.id === selected) o.selected = true;
          og.appendChild(o);
        });
        sel.appendChild(og);
      });
    if (selected && !Array.from(sel.options).some((o) => o.value === selected)) {
      const o = document.createElement('option');
      o.value = selected;
      o.textContent = selected + ' (当前)';
      o.selected = true;
      sel.insertBefore(o, sel.firstChild);
    }
  }

  function renderAgentList() {
    const box = $('#agent-list');
    box.innerHTML = '';
    $('#agents-count').textContent = String(state.agents.length);
    renderCategoryFilters();

    let agents = state.agents.slice();
    if (state.agentCategoryFilter && state.agentCategoryFilter !== 'all') {
      agents = agents.filter((a) => (a.category || 'other') === state.agentCategoryFilter);
    }

    // group by category order
    const groups = new Map();
    agents.forEach((a) => {
      const cat = a.category || 'other';
      if (!groups.has(cat)) groups.set(cat, []);
      groups.get(cat).push(a);
    });

    const ordered = state.categories
      .slice()
      .sort((a, b) => (a.order || 0) - (b.order || 0))
      .map((c) => c.id);
    // append unknown cats
    for (const k of groups.keys()) {
      if (!ordered.includes(k)) ordered.push(k);
    }

    ordered.forEach((catId) => {
      const list = groups.get(catId);
      if (!list || !list.length) return;
      const meta = categoryMeta(catId);
      const head = document.createElement('div');
      head.className = 'side-group';
      head.innerHTML = `<span class="dot" style="background:${esc(meta.color || '#8b98a9')}"></span>${esc(meta.label)} <span class="cnt">${list.length}</span>`;
      box.appendChild(head);

      list
        .slice()
        .sort((a, b) => String(a.name).localeCompare(String(b.name)))
        .forEach((a) => {
          const name = a.name || a.filename?.replace(/\.md$/, '');
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className =
            'side-item' + (name === state.currentAgentName ? ' active' : '');
          const parsed = parseModelSpec(a.model || '');
          const pureModel = parsed.model || '';
          const thinking = parsed.thinking || a.thinking || '';
          btn.innerHTML = `
            <div class="si-title">${esc(name)}</div>
            <div class="si-sub">${esc(a.description || '无描述')}</div>
            ${a.taskType ? `<span class="chip">${esc(a.taskType)}</span>` : ''}
            <div class="si-tags">
              <span class="badge accent">${esc(pureModel || '默认模型')}</span>
              ${thinking ? `<span class="badge">${esc(thinking)}</span>` : ''}
              ${
                a.relativePath && a.relativePath !== a.filename
                  ? `<span class="badge">${esc(a.relativePath)}</span>`
                  : ''
              }
              ${
                a.categorySource === 'inferred'
                  ? '<span class="badge">自动分类</span>'
                  : ''
              }
            </div>`;
          btn.addEventListener('click', () => selectAgent(name, true));
          box.appendChild(btn);
        });
    });

    if (!agents.length) {
      const empty = document.createElement('div');
      empty.className = 'side-list-empty';
      empty.textContent = '该分类下暂无子代理';
      box.appendChild(empty);
    }
  }

  function showAgentEmpty() {
    state.currentAgentName = null;
    state.agentDetail = null;
    state.agentPanel = null;
    state.currentWorkflowId = null;
    $('#agent-empty')?.classList.remove('hidden');
    $('#agent-editor')?.classList.add('hidden');
    $('#workflow-editor')?.classList.add('hidden');
    renderAgentList();
    renderWorkflowList();
  }

  async function selectAgent(name, confirmLeave) {
    if (
      confirmLeave &&
      state.agentsDirty &&
      state.currentAgentName &&
      state.currentAgentName !== name &&
      !confirm('有未保存修改，切换？')
    ) {
      return;
    }
    if (
      confirmLeave &&
      state.workflowDirty &&
      state.agentPanel === 'workflow' &&
      !confirm('规范有未保存修改，切换？')
    ) {
      return;
    }
    try {
      state.agentDetail = await api('/api/agents/' + encodeURIComponent(name));
    } catch (e) {
      showToast('读取子代理失败: ' + e.message, false);
      return;
    }
    state.agentPanel = 'agent';
    state.agentSideView = 'agents';
    state.currentWorkflowId = null;
    state.currentAgentName = name;
    document.querySelectorAll('#agent-side-switch .side-switch-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.side === 'agents');
    });
    $('#agent-side-agents')?.classList.remove('hidden');
    $('#agent-side-workflow')?.classList.add('hidden');
    $('#agent-new')?.classList.remove('hidden');
    $('#agent-cat-filters')?.classList.remove('hidden');
    fillAgentForm(state.agentDetail);
    $('#agent-empty')?.classList.add('hidden');
    $('#workflow-editor')?.classList.add('hidden');
    $('#agent-editor')?.classList.remove('hidden');
    $('#a-title').textContent =
      name + (state.agentDetail.relativePath ? ' · ' + state.agentDetail.relativePath : '');
    setDirty('agents', false);
    renderAgentList();
    renderWorkflowList();
  }

  function openNewAgent() {
    if (state.agentsDirty && !confirm('有未保存修改，继续新建？')) return;
    if (state.workflowDirty && !confirm('规范有未保存修改，继续新建？')) return;
    state.agentPanel = 'agent';
    state.currentWorkflowId = null;
    state.currentAgentName = null;
    state.agentDetail = { name: '', description: '', tools: '', model: '', prompt: '' };
    fillAgentForm(state.agentDetail);
    $('#agent-empty')?.classList.add('hidden');
    $('#workflow-editor')?.classList.add('hidden');
    $('#agent-editor')?.classList.remove('hidden');
    $('#a-title').textContent = '新建子代理';
    setDirty('agents', false);
    renderAgentList();
    renderWorkflowList();
    $('#a-name')?.focus();
  }

  function fillAgentForm(a) {
    $('#a-name').value = a.name || '';
    $('#a-description').value = a.description || '';
    $('#a-prompt').value = a.prompt || '';
    // 防御性拆分：后端可能返回纯 model+thinking，或尚未迁移的完整 spec
    const parsed = parseModelSpec(a.model || '');
    // 合法后缀优先于独立 thinking 字段
    const thinking = parsed.thinking || a.thinking || '';
    fillAgentModelSelect(parsed.model || '');
    const th = $('#a-thinking');
    if (th) th.value = thinking;
    fillCategorySelect(a.category || 'other');
    const src = $('#a-category-source');
    if (src) {
      src.value =
        a.categorySource === 'explicit'
          ? '已写入 frontmatter'
          : '按名称自动识别（保存后写入文件）';
    }
    setToolsFromString(a.tools || '');
    // 高级行为字段（缺省置空）
    const tt = $('#a-task-type');
    if (tt) tt.value = a.taskType || '';
    const sm = $('#a-sp-mode');
    if (sm) sm.value = a.systemPromptMode || '';
    const ic = $('#a-inherit-ctx');
    if (ic) ic.value = a.inheritProjectContext || '';
    const is = $('#a-inherit-skills');
    if (is) is.value = a.inheritSkills || '';
    const fb = $('#a-fallback-models');
    if (fb) {
      fb.value = Array.isArray(a.fallbackModels)
        ? a.fallbackModels.join(', ')
        : (a.fallbackModels || '');
    }
  }

  async function saveAgent() {
    try {
      syncToolsHidden();
      const pureModel = ($('#a-model') && $('#a-model').value) || '';
      const thinking = ($('#a-thinking') && $('#a-thinking').value) || '';
      if (thinking && !TLM_LEVELS.includes(thinking)) {
        return showToast('思考档位无效，请选择合法档或留空', false);
      }
      if (thinking && !pureModel.trim()) {
        return showToast('请先选择模型或清空思考档', false);
      }
      // 高级行为字段读取与预校验（非法值不发请求）
      const taskType = ($('#a-task-type') && $('#a-task-type').value) || '';
      const systemPromptMode = ($('#a-sp-mode') && $('#a-sp-mode').value) || '';
      const inheritProjectContext = ($('#a-inherit-ctx') && $('#a-inherit-ctx').value) || '';
      const inheritSkills = ($('#a-inherit-skills') && $('#a-inherit-skills').value) || '';
      const fallbackModels = ($('#a-fallback-models') && $('#a-fallback-models').value) || '';
      if (taskType && !AGENT_TASK_TYPES.includes(taskType)) {
        return showToast('任务类型无效: ' + taskType + '（仅支持 planning/analysis/explore/verification/development 或留空）', false);
      }
      if (systemPromptMode && !AGENT_SP_MODES.includes(systemPromptMode)) {
        return showToast('子代理模式无效: ' + systemPromptMode + '（仅支持 append/replace）', false);
      }
      if (!AGENT_BOOL_TRIPLE.includes(inheritProjectContext)) {
        return showToast('继承上下文取值无效: ' + inheritProjectContext + '（仅 true/false/留空）', false);
      }
      if (!AGENT_BOOL_TRIPLE.includes(inheritSkills)) {
        return showToast('继承技能取值无效: ' + inheritSkills + '（仅 true/false/留空）', false);
      }
      // 后备模型逐项校验 provider/model 形态（复用 parseModelSpec 剥离可选 :档位 后缀）
      const badFallback = String(fallbackModels)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .find((entry) => {
          const m = parseModelSpec(entry).model.trim();
          return !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(m);
        });
      if (badFallback) {
        return showToast('后备模型无效: ' + badFallback + '（应为 provider/model，可带 :档位 后缀）', false);
      }
      // compose 后 model 为完整 spec（provider/id:high）；thinking 空串由后端删独立字段
      const payload = {
        name: $('#a-name').value.trim(),
        description: $('#a-description').value,
        category: $('#a-category').value,
        tools: $('#a-tools').value,
        model: composeModelSpec(pureModel, thinking),
        thinking: '',
        prompt: $('#a-prompt').value,
        taskType,
        systemPromptMode,
        inheritProjectContext,
        inheritSkills,
        fallbackModels,
      };
      if (!payload.name) return showToast('名称不能为空', false);
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(payload.name)) {
        return showToast('名称仅限字母数字 _ -，最长 64', false);
      }
      const isNew = !state.currentAgentName;
      if (isNew) {
        await api('/api/agents', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
      } else {
        await api('/api/agents/' + encodeURIComponent(state.currentAgentName), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
      }
      state.currentAgentName = payload.name;
      await loadAgents();
      await selectAgent(payload.name, false);
      setDirty('agents', false);
      showToast('子代理已保存');
    } catch (e) {
      showToast('保存失败: ' + e.message, false);
    }
  }

  async function deleteAgent() {
    if (!state.currentAgentName) {
      showAgentEmpty();
      return;
    }
    if (!confirm('删除子代理 "' + state.currentAgentName + '"？')) return;
    try {
      await api('/api/agents/' + encodeURIComponent(state.currentAgentName), {
        method: 'DELETE',
      });
      showToast('已删除');
      await loadAgents();
      showAgentEmpty();
    } catch (e) {
      showToast('删除失败: ' + e.message, false);
    }
  }

  window.PiManager = window.PiManager || {};
  window.PiManager.agents = {
    bindAgentsUI,
    loadAgents,
    loadCategories,
    loadToolPool,
    renderAgentList,
    showAgentEmpty,
    selectAgent,
    openNewAgent,
    saveAgent,
    deleteAgent,
    renderCategoryFilters,
    fillCategorySelect,
    renderToolPresets,
    renderToolPool,
    setAgentSideView,
    loadWorkflowDocs,
    renderWorkflowList,
    selectWorkflow,
    loadWorkflowDoc,
    setWorkflowMode,
    renderWorkflowPreview,
    saveWorkflowDoc,
    showBuiltinWorkflowTemplate,
  };
  // 挂载旧式 window.* 兼容导出供 app.js 路由分发及 console-ui 等调用：
  Object.assign(window, window.PiManager.agents);
})();
