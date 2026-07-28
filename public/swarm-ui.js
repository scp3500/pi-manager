function bindSwarmUI() {
  $('#swarm-reset-presets')?.addEventListener('click', () => {
    const model = preferredSwarmModel();
    if (!model) return showToast('请先在「模型」页添加可用模型', false);
    state.swarmConfig.roles = state.swarmPresets.map((preset) => roleFromPreset(preset, model));
    renderSwarmRoles();
    setDirty('swarm', true);
  });
  $('#swarm-add-role')?.addEventListener('click', () => {
    if ((state.swarmConfig.roles || []).length >= 5) return showToast('最多配置 5 人', false);
    const model = preferredSwarmModel();
    if (!model) return showToast('请先在「模型」页添加可用模型', false);
    const preset = state.swarmPresets.find((item) => item.kind === 'reviewer') || state.swarmPresets[0];
    const role = roleFromPreset(preset, model);
    let index = 2;
    while (state.swarmConfig.roles.some((item) => item.id === role.id)) role.id = preset.id + '-' + index++;
    state.swarmConfig.roles.push(role);
    renderSwarmRoles();
    setDirty('swarm', true);
  });
  $('#swarm-roles')?.addEventListener('input', handleSwarmRoleInput);
  $('#swarm-roles')?.addEventListener('change', handleSwarmRoleInput);
  $('#swarm-roles')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-swarm-remove]');
    if (!button) return;
    state.swarmConfig.roles.splice(Number(button.dataset.swarmRemove), 1);
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
  const root = $('#swarm-roles');
  if (!root || !state.swarmConfig) return;
  const roles = state.swarmConfig.roles || [];
  $('#swarm-empty')?.classList.toggle('hidden', roles.length > 0);
  const models = state.flatModels || [];
  root.innerHTML = roles.map((role, index) => {
    const primary = modelRef(role.model?.primary);
    const fallbacks = new Set((role.model?.fallbacks || []).map(modelRef));
    const tools = new Set(role.tools || []);
    return `
      <article class="swarm-role" data-role-index="${index}">
        <div class="swarm-role-head">
          <i data-lucide="${role.kind === 'reviewer' ? 'shield-check' : role.kind === 'implementer' ? 'code-2' : 'search'}"></i>
          <strong>${esc(role.name || role.id)}</strong>
          <button type="button" class="btn ghost sm icon-btn" data-swarm-remove="${index}" title="移除角色" aria-label="移除角色"><i data-lucide="trash-2"></i></button>
        </div>
        <div class="form-grid">
          <label><span>ID</span><input data-field="id" value="${esc(role.id)}"></label>
          <label><span>职责</span><select data-field="kind">
            ${kindOption('investigator', '调查', role.kind)}
            ${kindOption('implementer', '实现', role.kind)}
            ${kindOption('reviewer', '评审', role.kind)}
          </select></label>
          <label><span>名称</span><input data-field="name" value="${esc(role.name)}"></label>
          <label><span>思考档位</span><select data-field="thinkingLevel">${TLM_LEVELS.map((level) => `<option value="${level}"${role.thinkingLevel === level ? ' selected' : ''}>${level}</option>`).join('')}</select></label>
        </div>
        <label><span>说明</span><input data-field="description" value="${esc(role.description)}"></label>
        <label><span>主模型</span><select data-field="primary">${modelOptions(models, primary)}</select></label>
        <label><span>Fallback（可多选，只会向同价或更便宜回退）</span><select class="swarm-fallback" data-field="fallbacks" multiple>${modelOptions(models, '', fallbacks)}</select></label>
        <label><span>能力（逗号分隔）</span><input data-field="capabilities" value="${esc((role.capabilities || []).join(', '))}"></label>
        <div class="swarm-tool-row" aria-label="只读工具">
          ${['read', 'grep', 'find', 'ls'].map((tool) => `<label><input type="checkbox" data-tool="${tool}"${tools.has(tool) ? ' checked' : ''}><span>${tool}</span></label>`).join('')}
        </div>
        <div class="form-grid">
          <label><span>上下文容量</span><input type="number" min="1" data-field="contextCapacity" value="${Number(role.contextCapacity) || 128000}"></label>
          <label><span>最大并行任务</span><input type="number" min="1" data-field="maxActiveMissions" value="${Number(role.maxActiveMissions) || 1}"></label>
        </div>
      </article>`;
  }).join('');
  if (typeof refreshIcons === 'function') refreshIcons(root);
}

function collectSwarmRoles() {
  return $$('.swarm-role', $('#swarm-roles')).map((card) => {
    const field = (name) => card.querySelector(`[data-field="${name}"]`);
    const fallbacks = [...field('fallbacks').selectedOptions].map((option) => option.value);
    return {
      id: field('id').value.trim(),
      name: field('name').value.trim(),
      kind: field('kind').value,
      description: field('description').value.trim(),
      capabilities: field('capabilities').value.split(',').map((item) => item.trim()).filter(Boolean),
      model: { primary: field('primary').value, fallbacks },
      tools: [...card.querySelectorAll('[data-tool]:checked')].map((input) => input.dataset.tool),
      thinkingLevel: field('thinkingLevel').value,
      contextCapacity: Number(field('contextCapacity').value),
      maxActiveMissions: Number(field('maxActiveMissions').value),
    };
  });
}

function handleSwarmRoleInput() {
  setDirty('swarm', true);
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

function modelOptions(models, selected, selectedSet) {
  if (!models.length) return '<option value="">先在模型页添加模型</option>';
  return models.map((model) => {
    const active = selectedSet ? selectedSet.has(model.id) : model.id === selected;
    return `<option value="${esc(model.id)}"${active ? ' selected' : ''}>${esc(model.id)}${model.name && model.name !== model.modelId ? ' · ' + esc(model.name) : ''}</option>`;
  }).join('');
}

function kindOption(value, label, selected) {
  return `<option value="${value}"${value === selected ? ' selected' : ''}>${label}</option>`;
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
