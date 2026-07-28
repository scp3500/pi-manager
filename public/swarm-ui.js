function bindSwarmUI() {
  $('#swarm-reset-presets')?.addEventListener('click', () => {
    const model = preferredSwarmModel();
    if (!model) return showToast('请先在「模型」页添加可用模型', false);
    state.swarmConfig.roles = state.swarmPresets.map((preset) => roleFromPreset(preset, model));
    state.currentSwarmRoleIndex = 0;
    state.swarmPanel = 'roles';
    renderSwarmRoles();
    setDirty('swarm', true);
  });

  $('#swarm-add-role')?.addEventListener('click', () => {
    syncCurrentSwarmRole();
    if ((state.swarmConfig.roles || []).length >= 5) return showToast('团队最多 5 人', false);
    const model = preferredSwarmModel();
    if (!model) return showToast('请先在「模型」页添加可用模型', false);
    const preset = state.swarmPresets.find((item) => item.kind === 'reviewer') || state.swarmPresets[0];
    const role = roleFromPreset(preset, model);
    let index = 2;
    while (state.swarmConfig.roles.some((item) => item.id === role.id)) role.id = preset.id + '-' + index++;
    state.swarmConfig.roles.push(role);
    state.currentSwarmRoleIndex = state.swarmConfig.roles.length - 1;
    state.swarmPanel = 'roles';
    renderSwarmRoles();
    setDirty('swarm', true);
  });

  $('#swarm-side-switch')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-swarm-panel]');
    if (!button) return;
    syncCurrentSwarmRole();
    state.swarmPanel = button.dataset.swarmPanel;
    renderSwarmRoles();
  });

  $('#swarm-role-list')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-swarm-role]');
    if (!button) return;
    syncCurrentSwarmRole();
    state.currentSwarmRoleIndex = Number(button.dataset.swarmRole);
    state.swarmPanel = 'roles';
    renderSwarmRoles();
  });

  $('#swarm-role-editor')?.addEventListener('input', handleSwarmRoleInput);
  $('#swarm-role-editor')?.addEventListener('change', (event) => {
    handleSwarmRoleInput(event);
    if (event.target.matches('[data-field="primary"]')) {
      const capacity = modelContext(event.target.value);
      const input = $('#swarm-role-editor [data-field="contextCapacity"]');
      if (capacity && input) {
        input.value = capacity;
        syncCurrentSwarmRole();
      }
    }
    updateSwarmFallbackSummary();
  });
  $('#swarm-role-editor')?.addEventListener('click', (event) => {
    const remove = event.target.closest('[data-swarm-remove-current]');
    if (!remove) return;
    if (state.swarmConfig.roles.length <= 3) return showToast('团队至少保留 3 人', false);
    state.swarmConfig.roles.splice(state.currentSwarmRoleIndex, 1);
    state.currentSwarmRoleIndex = Math.min(state.currentSwarmRoleIndex, state.swarmConfig.roles.length - 1);
    renderSwarmRoles();
    setDirty('swarm', true);
  });

  for (const id of ['swarm-verify-executable', 'swarm-verify-args', 'swarm-verify-timeout', 'swarm-commit-message']) {
    $('#' + id)?.addEventListener('input', () => setDirty('swarm', true));
  }
}

async function loadSwarmConfig() {
  try {
    const [config, presets] = await Promise.all([api('/api/swarm'), api('/api/swarm/presets')]);
    state.swarmConfig = config;
    state.swarmPresets = presets;
    state.currentSwarmRoleIndex = 0;
    state.swarmPanel = 'roles';
    fillSwarmSettings();
    renderSwarmRoles();
    setDirty('swarm', false);
  } catch (error) {
    showToast('加载集群配置失败: ' + error.message, false);
  }
}

function enterSwarmRoute() {
  renderSwarmRoles();
  fillSwarmSettings();
}

async function saveSwarmConfig() {
  const roles = collectSwarmRoles();
  if (roles.length < 3 || roles.length > 5) throw new Error('需要配置 3–5 人');
  for (const kind of ['investigator', 'implementer', 'reviewer']) {
    if (!roles.some((role) => role.kind === kind)) throw new Error('缺少角色: ' + kind);
  }
  const config = {
    version: 1,
    roles,
    verification: {
      executable: $('#swarm-verify-executable').value.trim(),
      args: splitCommandArgs($('#swarm-verify-args').value),
      timeoutMs: Number($('#swarm-verify-timeout').value),
    },
    commitMessage: $('#swarm-commit-message').value.trim(),
  };
  state.swarmConfig = await api('/api/swarm', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
  renderSwarmRoles();
  setDirty('swarm', false);
  showToast('集群配置已保存');
  return true;
}

function renderSwarmRoles() {
  if (!state.swarmConfig) return;
  const roles = state.swarmConfig.roles || [];
  if (!Number.isInteger(state.currentSwarmRoleIndex)) state.currentSwarmRoleIndex = 0;
  if (state.currentSwarmRoleIndex >= roles.length) state.currentSwarmRoleIndex = Math.max(0, roles.length - 1);
  if (!state.swarmPanel) state.swarmPanel = 'roles';

  renderSwarmRoster();
  $$('#swarm-side-switch [data-swarm-panel]').forEach((button) => {
    const active = button.dataset.swarmPanel === state.swarmPanel;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', active ? 'true' : 'false');
  });

  const empty = $('#swarm-empty');
  const roleEditor = $('#swarm-role-editor');
  const deliveryEditor = $('#swarm-delivery-editor');
  const showDelivery = state.swarmPanel === 'delivery';
  empty?.classList.toggle('hidden', roles.length > 0 || showDelivery);
  roleEditor?.classList.toggle('hidden', roles.length === 0 || showDelivery);
  deliveryEditor?.classList.toggle('hidden', !showDelivery);
  if (roles.length > 0 && !showDelivery) renderSwarmRoleEditor(roles[state.currentSwarmRoleIndex]);
  if (typeof refreshIcons === 'function') refreshIcons($('#page-swarm'));
}

function renderSwarmRoster() {
  const roles = state.swarmConfig?.roles || [];
  const list = $('#swarm-role-list');
  if (!list) return;
  $('#swarm-count').textContent = roles.length;
  $('#swarm-roster-count').textContent = roles.length;
  $('#swarm-reviewer-count').textContent = roles.filter((role) => role.kind === 'reviewer').length;
  if (!roles.length) {
    list.innerHTML = '<div class="side-list-empty">恢复预设或添加一名成员</div>';
    return;
  }
  list.innerHTML = roles.map((role, index) => {
    const active = state.swarmPanel === 'roles' && state.currentSwarmRoleIndex === index;
    const model = modelRef(role.model?.primary);
    return `<button type="button" class="side-item swarm-roster-item${active ? ' active' : ''}" data-swarm-role="${index}">
      <span class="swarm-roster-icon role-${esc(role.kind)}"><i data-lucide="${roleIcon(role.kind)}"></i></span>
      <span class="swarm-roster-copy">
        <span class="si-title">${esc(role.name || role.id)}</span>
        <span class="si-sub">${esc(kindLabel(role.kind))} · ${esc(shortModel(model))}</span>
      </span>
      <i class="swarm-roster-chevron" data-lucide="chevron-right"></i>
    </button>`;
  }).join('');
  if (typeof refreshIcons === 'function') refreshIcons(list);
}

function renderSwarmRoleEditor(role) {
  const root = $('#swarm-role-editor-body');
  if (!root || !role) return;
  const models = state.flatModels || [];
  const primary = modelRef(role.model?.primary);
  const fallbacks = new Set((role.model?.fallbacks || []).map(modelRef));
  const tools = new Set(role.tools || []);
  const canRemove = (state.swarmConfig.roles || []).length > 3;
  root.innerHTML = `
    <div class="content-head swarm-editor-head">
      <div class="swarm-editor-title">
        <span class="swarm-editor-icon role-${esc(role.kind)}"><i data-lucide="${roleIcon(role.kind)}"></i></span>
        <div><span class="swarm-editor-kicker">${esc(kindLabel(role.kind))}</span><h2>${esc(role.name || role.id)}</h2></div>
      </div>
      <div class="content-actions">
        <span class="badge accent">${esc(role.thinkingLevel || '默认')} thinking</span>
        <button type="button" class="btn danger sm icon-btn" data-swarm-remove-current title="移除成员" aria-label="移除成员"${canRemove ? '' : ' disabled'}><i data-lucide="trash-2"></i></button>
      </div>
    </div>
    <form class="fields swarm-role-form" autocomplete="off">
      <div class="grid-2">
        <label>名称
          <input data-field="name" value="${esc(role.name)}">
        </label>
        <label>职责
          <select data-field="kind">
            ${kindOption('investigator', '调查', role.kind)}
            ${kindOption('implementer', '实现', role.kind)}
            ${kindOption('reviewer', '评审', role.kind)}
          </select>
        </label>
      </div>
      <label>标识
        <input data-field="id" value="${esc(role.id)}" spellcheck="false">
      </label>
      <label>职责说明
        <textarea data-field="description" rows="2">${esc(role.description)}</textarea>
      </label>

      <div class="block-lite swarm-config-block">
        <div class="block-head">
          <i data-lucide="cpu"></i>
          <div><h3>模型策略</h3><p class="muted">复用 Pi 已有 Provider 凭据，只保存模型引用。</p></div>
        </div>
        <div class="grid-2">
          <label>主模型
            <select data-field="primary">${modelOptions(models, primary)}</select>
          </label>
          <label>思考档位
            <select data-field="thinkingLevel">${TLM_LEVELS.map((level) => `<option value="${level}"${role.thinkingLevel === level ? ' selected' : ''}>${level}</option>`).join('')}</select>
          </label>
        </div>
        <details class="swarm-fallback-picker">
          <summary><span>Fallback 模型</span><strong id="swarm-fallback-summary">${fallbackSummary(fallbacks)}</strong><i data-lucide="chevron-down"></i></summary>
          <div class="swarm-model-options">
            ${models.map((model) => `<label class="swarm-model-option"><input type="checkbox" data-fallback value="${esc(model.id)}"${fallbacks.has(model.id) ? ' checked' : ''}><span><b>${esc(model.modelId || model.id)}</b><small>${esc(model.provider || '')}</small></span></label>`).join('') || '<p class="muted">先在模型页添加模型</p>'}
          </div>
        </details>
      </div>

      <div class="block-lite swarm-config-block">
        <div class="block-head">
          <i data-lucide="wrench"></i>
          <div><h3>能力与工具</h3><p class="muted">Worker 只会加载这里明确授权的只读工具。</p></div>
        </div>
        <label>能力标签
          <input data-field="capabilities" value="${esc((role.capabilities || []).join(', '))}" placeholder="development, review">
        </label>
        <div class="tool-pool swarm-tool-pool">
          ${['read', 'grep', 'find', 'ls'].map((tool) => `<label class="tool-chip${tools.has(tool) ? ' on' : ''}"><input type="checkbox" data-tool="${tool}"${tools.has(tool) ? ' checked' : ''}><span><span class="tn">${tool}</span><span class="td">${toolDescription(tool)}</span></span></label>`).join('')}
        </div>
      </div>

      <details class="adv swarm-advanced">
        <summary>运行边界</summary>
        <div class="grid-2">
          <label>上下文容量
            <input type="number" min="1" data-field="contextCapacity" value="${Number(role.contextCapacity) || 128000}">
          </label>
          <label>最大并行任务
            <input type="number" min="1" data-field="maxActiveMissions" value="${Number(role.maxActiveMissions) || 1}">
          </label>
        </div>
      </details>
    </form>`;
}

function collectSwarmRoles() {
  syncCurrentSwarmRole();
  return (state.swarmConfig.roles || []).map((role) => JSON.parse(JSON.stringify(role)));
}

function syncCurrentSwarmRole() {
  if (state.swarmPanel === 'delivery') return;
  const editor = $('#swarm-role-editor');
  const role = state.swarmConfig?.roles?.[state.currentSwarmRoleIndex];
  if (!editor || !role || editor.classList.contains('hidden')) return;
  const field = (name) => editor.querySelector(`[data-field="${name}"]`);
  if (!field('id')) return;
  role.id = field('id').value.trim();
  role.name = field('name').value.trim();
  role.kind = field('kind').value;
  role.description = field('description').value.trim();
  role.capabilities = field('capabilities').value.split(',').map((item) => item.trim()).filter(Boolean);
  role.model = {
    primary: field('primary').value,
    fallbacks: [...editor.querySelectorAll('[data-fallback]:checked')].map((input) => input.value),
  };
  role.tools = [...editor.querySelectorAll('[data-tool]:checked')].map((input) => input.dataset.tool);
  role.thinkingLevel = field('thinkingLevel').value;
  role.contextCapacity = Number(field('contextCapacity').value);
  role.maxActiveMissions = Number(field('maxActiveMissions').value);
}

function handleSwarmRoleInput(event) {
  syncCurrentSwarmRole();
  const chip = event?.target?.closest('.tool-chip');
  if (chip) chip.classList.toggle('on', event.target.checked);
  renderSwarmRoster();
  setDirty('swarm', true);
}

function updateSwarmFallbackSummary() {
  const selected = new Set([...$$('#swarm-role-editor [data-fallback]:checked')].map((input) => input.value));
  const summary = $('#swarm-fallback-summary');
  if (summary) summary.textContent = fallbackSummary(selected);
}

function roleFromPreset(preset, model) {
  return {
    ...JSON.parse(JSON.stringify(preset)),
    model: { primary: model, fallbacks: [] },
    contextCapacity: modelContext(model) || 128000,
    maxActiveMissions: 1,
  };
}

function preferredSwarmModel() {
  const preferred = [state.defaults?.defaultProvider, state.defaults?.defaultModel].filter(Boolean).join('/');
  if (preferred && state.flatModels.some((model) => model.id === preferred)) return preferred;
  return state.flatModels[0]?.id || '';
}

function modelContext(ref) {
  return state.flatModels.find((model) => model.id === ref)?.contextWindow;
}

function modelRef(model) {
  if (typeof model === 'string') return model;
  return model?.provider && model?.modelId ? model.provider + '/' + model.modelId : '';
}

function modelOptions(models, selected) {
  if (!models.length) return '<option value="">先在模型页添加模型</option>';
  return models.map((model) => `<option value="${esc(model.id)}"${model.id === selected ? ' selected' : ''}>${esc(model.id)}${model.name && model.name !== model.modelId ? ' · ' + esc(model.name) : ''}</option>`).join('');
}

function kindOption(value, label, selected) {
  return `<option value="${value}"${value === selected ? ' selected' : ''}>${label}</option>`;
}

function kindLabel(kind) {
  return { investigator: '调查', implementer: '实现', reviewer: '独立评审' }[kind] || kind;
}

function roleIcon(kind) {
  return { investigator: 'search', implementer: 'code-2', reviewer: 'shield-check' }[kind] || 'bot';
}

function shortModel(ref) {
  const parts = String(ref || '未绑定模型').split('/');
  return parts.at(-1);
}

function fallbackSummary(selected) {
  return selected.size ? `已选 ${selected.size} 个` : '未设置';
}

function toolDescription(tool) {
  return { read: '读取文件', grep: '检索内容', find: '定位文件', ls: '浏览目录' }[tool] || '';
}

function fillSwarmSettings() {
  const config = state.swarmConfig;
  if (!config) return;
  $('#swarm-verify-executable').value = config.verification?.executable || 'npm';
  $('#swarm-verify-args').value = (config.verification?.args || ['test']).join(' ');
  $('#swarm-verify-timeout').value = config.verification?.timeoutMs || 120000;
  $('#swarm-commit-message').value = config.commitMessage || 'chore: apply pi-swarm changes';
}

function splitCommandArgs(value) {
  return String(value || '').trim().split(/\s+/).filter(Boolean);
}
