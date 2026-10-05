/* Models & Providers UI for Pi Manager */
(function () {
  const {
    state, $, $$, esc, TLM_LEVELS, parseModelSpec, composeModelSpec, defaultThinkingLevelMap,
    maskDots, isKeyMaskValue, api, showToast, setDirty, updateGlobalSaveUI, parseJsonField
  } = window.PiManagerCore || window;

async function loadProviders() {
  try {
    state.providers = await api('/api/providers');
  } catch (e) {
    showToast('加载供应商失败: ' + e.message, false);
    state.providers = [];
  }
}

async function loadDefaults() {
  try {
    state.defaults = await api('/api/defaults');
  } catch {
    state.defaults = {};
  }
}

async function loadFlatModels() {
  try {
    state.flatModels = await api('/api/models');
  } catch {
    state.flatModels = [];
  }
}

// ── Pi 1.0.3 provider key 迁移体检（azure-openai-responses → azure） ──────────

/** 「稍后」只用 sessionStorage 一个 key：只隐藏本次会话，新开页面/重启后会再提示。 */
const MIGRATION_DISMISS_KEY = 'pi-manager-migration-dismissed';
let migrationItems = [];
let migrationSessionDismissed = false;

function migrationStore() {
  try {
    return window.sessionStorage || null;
  } catch {
    return null;
  }
}

function isMigrationDismissed() {
  if (migrationSessionDismissed) return true;
  const st = migrationStore();
  try {
    return !!st && st.getItem(MIGRATION_DISMISS_KEY) === '1';
  } catch {
    return false;
  }
}

function clearMigrationDismiss() {
  migrationSessionDismissed = false;
  const st = migrationStore();
  try {
    if (st) st.removeItem(MIGRATION_DISMISS_KEY);
  } catch {
    /* ignore */
  }
}

/** 人话描述：写了几处、分别在哪个文件的哪个位置。 */
function describeMigrations(items) {
  const places = [];
  for (const it of items) {
    const name = String(it.file || '').split(/[\\/]/).pop() || String(it.file || '');
    const where = String(it.where || '').replace(/^[^ ]+\s*的\s*/, '');
    const one = name + ' 的 ' + where;
    if (!places.includes(one)) places.push(one);
  }
  return (
    '检测到 ' +
    items.length +
    ' 处 Pi 1.0.3 旧 provider key：azure-openai-responses → azure（' +
    places.join('；') +
    '）'
  );
}

function hideMigrationBanner() {
  const box = $('#migration-banner');
  if (!box) return;
  box.style.display = 'none';
  box.style.color = '';
  box.className = 'hint-block';
}

function renderMigrationBanner(items) {
  const box = $('#migration-banner');
  if (!box) return;
  const txt = $('#migration-text');
  if (txt) txt.textContent = describeMigrations(items);
  const apply = $('#migration-apply');
  if (apply) apply.disabled = !items.some((it) => it.canAutoFix);
  box.style.color = '';
  box.className = 'hint-block';
  box.style.display = '';
}

/** 迁移/体检后把冲突与跳过的文件说明写进提示条（不说「已全部完成」）。 */
function showMigrationNotice(changedCount, conflicts, skipped) {
  const box = $('#migration-banner');
  const bits = [];
  if (changedCount) bits.push('已迁移 ' + changedCount + ' 处');
  for (const c of conflicts) {
    bits.push('冲突 · ' + (c.where || c.file) + '：' + (c.detail || c.from + ' → ' + c.to));
  }
  for (const k of skipped) {
    bits.push('跳过 · ' + (k.where || k.file) + '：' + (k.reason || '读取失败'));
  }
  const msg = bits.join('；');
  if (!box) return;
  const txt = $('#migration-text');
  if (txt) txt.textContent = msg;
  box.className = 'hint-block warn';
  box.style.color = 'var(--warn)';
  box.style.display = '';
}

async function loadMigrations() {
  try {
    const data = await api('/api/migrations');
    migrationItems = (data && data.items) || [];
    if (!migrationItems.length || isMigrationDismissed()) {
      hideMigrationBanner();
      return;
    }
    renderMigrationBanner(migrationItems);
  } catch {
    // 体检失败不影响模型页其它功能：保持隐藏，不弹错
    hideMigrationBanner();
  }
}

async function applyMigrationUI() {
  const btn = $('#migration-apply');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '迁移中…';
  }
  try {
    const result = await api('/api/migrations/azure-rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const changed = (result && result.changed) || [];
    const conflicts = (result && result.conflicts) || [];
    const skipped = (result && result.skipped) || [];

    // 用户主动迁移后解除「稍后」，让重新体检的结果照实显示
    clearMigrationDismiss();
    await loadProviders();
    await loadDefaults();
    await loadFlatModels();
    renderProviderList();
    await loadMigrations();

    if (conflicts.length || skipped.length) {
      showMigrationNotice(changed.length, conflicts, skipped);
      showToast(
        '迁移 ' + changed.length + ' 处，' + conflicts.length + ' 处冲突需人工处理',
        false
      );
    } else if (changed.length) {
      showToast('已迁移 ' + changed.length + ' 处旧 provider key');
    } else {
      showToast('没有需要迁移的配置');
    }
  } catch (e) {
    showToast('迁移失败: ' + e.message, false);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '一键迁移';
    }
  }
}

function dismissMigrationBanner() {
  migrationSessionDismissed = true;
  const st = migrationStore();
  try {
    if (st) st.setItem(MIGRATION_DISMISS_KEY, '1');
  } catch {
    /* ignore */
  }
  hideMigrationBanner();
}

function buildTlmGrid() {
  const box = $('#m-tlm-grid');
  if (!box) return;
  box.innerHTML = TLM_LEVELS.map(
    (lv) => `
    <div class="tlm-item" data-level="${lv}">
      <label>${lv}
        <select id="m-tlm-${lv}">
          <option value="">(默认/省略)</option>
          <option value="__null__">禁用</option>
          <option value="__custom__">自定义…</option>
          <option value="${lv}">${lv}</option>
          <option value="none">none</option>
          <option value="low">low</option>
          <option value="medium">medium</option>
          <option value="high">high</option>
          <option value="max">max</option>
        </select>
        <input id="m-tlm-${lv}-custom" class="hidden" placeholder="provider 值" spellcheck="false">
      </label>
    </div>`
  ).join('');
  TLM_LEVELS.forEach((lv) => {
    const sel = $(`#m-tlm-${lv}`);
    const custom = $(`#m-tlm-${lv}-custom`);
    sel.addEventListener('change', () => {
      custom.classList.toggle('hidden', sel.value !== '__custom__');
      if (sel.value === '__custom__') custom.focus();
      setDirty('model', true);
    });
    custom.addEventListener('input', () => setDirty('model', true));
  });
}

function readTlmFromForm() {
  const out = {};
  let any = false;
  for (const lv of TLM_LEVELS) {
    const sel = $(`#m-tlm-${lv}`);
    if (!sel) continue;
    const v = sel.value;
    if (!v) continue;
    any = true;
    if (v === '__null__') out[lv] = null;
    else if (v === '__custom__') {
      const c = ($(`#m-tlm-${lv}-custom`).value || '').trim();
      if (c) out[lv] = c;
      else any = any; // keep any if other fields set
    } else out[lv] = v;
  }
  return any ? out : undefined;
}

function fillTlmForm(map) {
  for (const lv of TLM_LEVELS) {
    const sel = $(`#m-tlm-${lv}`);
    const custom = $(`#m-tlm-${lv}-custom`);
    if (!sel) continue;
    custom.classList.add('hidden');
    custom.value = '';
    if (!map || !(lv in map)) {
      sel.value = '';
      continue;
    }
    const v = map[lv];
    if (v === null) {
      sel.value = '__null__';
    } else if (typeof v === 'string') {
      const known = [lv, 'none', 'low', 'medium', 'high', 'max'];
      if ([...sel.options].some((o) => o.value === v)) {
        sel.value = v;
      } else {
        sel.value = '__custom__';
        custom.classList.remove('hidden');
        custom.value = v;
      }
    } else {
      sel.value = '';
    }
  }
}

function clearTlmForm() {
  fillTlmForm(null);
  setDirty('model', true);
}

function readCostFromForm() {
  const num = (id) => {
    const v = $(id).value;
    if (v === '' || v == null) return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const cost = {};
  const input = num('#m-cost-input');
  const output = num('#m-cost-output');
  const cacheRead = num('#m-cost-cacheRead');
  const cacheWrite = num('#m-cost-cacheWrite');
  if (input !== undefined) cost.input = input;
  if (output !== undefined) cost.output = output;
  if (cacheRead !== undefined) cost.cacheRead = cacheRead;
  if (cacheWrite !== undefined) cost.cacheWrite = cacheWrite;
  const tiers = parseJsonField($('#m-cost-tiers').value, 'Cost tiers');
  if (tiers !== undefined) cost.tiers = tiers;
  return Object.keys(cost).length ? cost : undefined;
}

function fillCostForm(cost) {
  const c = cost || {};
  $('#m-cost-input').value = c.input != null ? c.input : '';
  $('#m-cost-output').value = c.output != null ? c.output : '';
  $('#m-cost-cacheRead').value = c.cacheRead != null ? c.cacheRead : '';
  $('#m-cost-cacheWrite').value = c.cacheWrite != null ? c.cacheWrite : '';
  $('#m-cost-tiers').value =
    c.tiers && c.tiers.length ? JSON.stringify(c.tiers, null, 2) : '';
}

function renderDefaultsBar() {
  const pSel = $('#d-provider');
  const mSel = $('#d-model');
  const tSel = $('#d-thinking');
  const curP = state.defaults.defaultProvider || '';
  const curM = state.defaults.defaultModel || '';
  const curT = state.defaults.defaultThinkingLevel || '';

  pSel.innerHTML = '<option value="">—</option>';
  state.providers.forEach((p) => {
    const o = document.createElement('option');
    o.value = p.id;
    o.textContent = p.id;
    if (p.id === curP) o.selected = true;
    pSel.appendChild(o);
  });
  if (curP && !state.providers.some((p) => p.id === curP)) {
    const o = document.createElement('option');
    o.value = curP;
    o.textContent = curP + ' (当前)';
    o.selected = true;
    pSel.appendChild(o);
  }
  fillDefaultModels(curP || pSel.value, curM);
  tSel.value = curT;
}

function fillDefaultModels(providerId, selectedModel) {
  const mSel = $('#d-model');
  mSel.innerHTML = '<option value="">—</option>';
  const list = providerId
    ? state.flatModels.filter((m) => m.providerId === providerId)
    : state.flatModels;
  list.forEach((m) => {
    const o = document.createElement('option');
    o.value = m.modelId;
    o.textContent = (m.name || m.modelId) + ' · ' + m.modelId;
    if (m.modelId === selectedModel) o.selected = true;
    mSel.appendChild(o);
  });
  if (selectedModel && !Array.from(mSel.options).some((o) => o.value === selectedModel)) {
    const o = document.createElement('option');
    o.value = selectedModel;
    o.textContent = selectedModel + ' (当前)';
    o.selected = true;
    mSel.appendChild(o);
  }
}

// ── models UI ───────────────────────────────────────────────────────────────

function bindModelsUI() {
  $('#d-provider').addEventListener('change', () => fillDefaultModels($('#d-provider').value, ''));
  $('#defaults-save').addEventListener('click', saveDefaults);
  $('#provider-new').addEventListener('click', () => openNewProvider());
  $('#provider-save').addEventListener('click', saveProvider);
  $('#provider-delete').addEventListener('click', deleteProvider);
  $('#provider-test')?.addEventListener('click', testProviderUI);
  $('#provider-form').addEventListener('input', () => {
    setDirty('provider', true);
  });
  // API Key 输入框：圆点只是掩码，不等于「用户改过 key」。
  // 点进去不清空（清空看着就像 key 没了），只全选，直接敲字即覆盖。
  $('#p-apiKey')?.addEventListener('focus', () => {
    const inp = $('#p-apiKey');
    if (inp && state.keyIsPlaceholder && !state.keyVisible) {
      // 等浏览器默认聚焦行为走完再全选
      setTimeout(() => {
        try {
          inp.select();
        } catch {
          /* ignore */
        }
      }, 0);
    }
  });
  $('#p-apiKey')?.addEventListener('input', () => {
    const inp = $('#p-apiKey');
    if (!inp) return;
    if (state.keyIsPlaceholder && !state.keyVisible) {
      // 在掩码基础上开始打字：丢掉圆点，只留真实输入
      inp.value = inp.value.replace(/[•·]/g, '');
      state.keyIsPlaceholder = false;
    }
    // 真的敲了字才算「改过 key」，之后保存才采用输入框的值
    state.keepApiKey = false;
  });
  $('#p-apiKey')?.addEventListener('blur', () => {
    // 点进来又没输入任何东西：恢复圆点占位，避免看上去像 key 没了
    const inp = $('#p-apiKey');
    if (
      inp &&
      !state.keyVisible &&
      state.keepApiKey &&
      state.storedApiKey &&
      inp.value.trim() === ''
    ) {
      inp.value = maskDots(state.storedApiKey.length);
      state.keyIsPlaceholder = true;
    }
  });
  $('#toggle-key').addEventListener('click', toggleKey);
  $('#model-new').addEventListener('click', () => openModelEditor('__new__'));
  $('#model-save').addEventListener('click', saveModel);
  $('#model-delete').addEventListener('click', deleteModel);
  $('#model-fetch')?.addEventListener('click', fetchRemoteModelsUI);
  $('#remote-close')?.addEventListener('click', closeRemotePanel);
  $('#remote-select-all')?.addEventListener('click', () => selectRemote('all'));
  $('#remote-select-none')?.addEventListener('click', () => selectRemote('none'));
  $('#remote-select-new')?.addEventListener('click', () => selectRemote('new'));
  $('#remote-import')?.addEventListener('click', importSelectedRemoteModels);
  $('#remote-filter')?.addEventListener('input', (e) => {
    state.remoteFilter = e.target.value || '';
    renderRemoteModelsList();
  });
  $('#model-form').addEventListener('input', () => setDirty('model', true));
  $('#m-cost-zero')?.addEventListener('click', () => {
    ['#m-cost-input', '#m-cost-output', '#m-cost-cacheRead', '#m-cost-cacheWrite'].forEach(
      (id) => ($(id).value = '0')
    );
    setDirty('model', true);
  });
  $('#m-tlm-clear')?.addEventListener('click', clearTlmForm);
  buildSamplingGrid();
  $('#m-spl-clear')?.addEventListener('click', clearSamplingForm);
  // Pi 1.0.3 迁移提示条（默认隐藏，count>0 才显示）
  $('#migration-apply')?.addEventListener('click', applyMigrationUI);
  $('#migration-dismiss')?.addEventListener('click', dismissMigrationBanner);
  void loadMigrations();
  // Ctrl+S 统一由 bindGlobalSave 处理
}

async function saveDefaults() {
  try {
    state.defaults = await api('/api/defaults', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        defaultProvider: $('#d-provider').value,
        defaultModel: $('#d-model').value,
        defaultThinkingLevel: $('#d-thinking').value,
      }),
    });
    showToast('默认模型已保存');
    renderProviderList();
  } catch (e) {
    showToast('保存默认失败: ' + e.message, false);
  }
}

function renderProviderList() {
  renderDefaultsBar();
  const box = $('#provider-list');
  box.innerHTML = '';
  const defP = state.defaults.defaultProvider || '';
  state.providers.forEach((p) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className =
      'side-item' + (p.id === state.currentProviderId ? ' active' : '');
    btn.innerHTML = `
      <div class="si-title">${esc(p.id)}${p.id === defP ? ' <span class="badge accent">默认</span>' : ''}</div>
      <div class="si-sub">${esc(p.baseUrl || '(无 URL)')}</div>
      <div class="si-tags">
        <span class="badge">${esc(p.api || '?')}</span>
        <span class="badge">${p.modelCount} 模型</span>
        ${
          p.apiKey?.configured
            ? '<span class="badge ok">已配置</span>'
            : '<span class="badge warn">无 key</span>'
        }
      </div>`;
    btn.addEventListener('click', () => selectProvider(p.id, true));
    box.appendChild(btn);
  });
}

function showProviderEmpty() {
  state.currentProviderId = null;
  state.providerDetail = null;
  state.selectedModelId = null;
  $('#provider-empty').classList.remove('hidden');
  $('#provider-editor').classList.add('hidden');
  $('#model-editor').classList.add('hidden');
  renderProviderList();
}

let providerSelection = 0;
async function selectProvider(id, confirmLeave) {
  if (state.providerSaving || state.modelSaving) return;
  if (
    confirmLeave &&
    state.modelsDirty &&
    state.currentProviderId &&
    state.currentProviderId !== id &&
    !confirm('有未保存修改，切换？')
  ) {
    return;
  }
  const selection = ++providerSelection;
  const route = state.route;
  let detail;
  try {
    detail = await api('/api/providers/' + encodeURIComponent(id));
  } catch (e) {
    showToast('读取失败: ' + e.message, false);
    return;
  }
  if (selection !== providerSelection || state.route !== route) return;
  state.providerDetail = detail;
  // 切换前保存当前供应商的远程勾选状态
  if (state.currentProviderId && state.currentProviderId !== id) {
    persistRemoteStateForProvider(state.currentProviderId);
  }
  state.currentProviderId = id;
  state.selectedModelId = null;
  state.keyVisible = false;
  fillProviderForm(state.providerDetail);
  renderModelTable();
  fillProviderTestModelSelect();
  restoreRemoteStateForProvider(id);
  $('#model-editor').classList.add('hidden');
  $('#provider-empty').classList.add('hidden');
  $('#provider-editor').classList.remove('hidden');
  $('#p-title').textContent = id;
  setDirty('models', false);
  renderProviderList();
}

function openNewProvider() {
  if (state.providerSaving || state.modelSaving) return;
  if (state.modelsDirty && !confirm('有未保存修改，继续新建？')) return;
  ++providerSelection;
  if (state.currentProviderId) persistRemoteStateForProvider(state.currentProviderId);
  state.currentProviderId = null;
  restoreRemoteStateForProvider(null);
  state.providerDetail = {
    id: '',
    baseUrl: '',
    api: 'openai-completions',
    apiKey: '',
    apiKeyMasked: { configured: false },
    headers: {},
    compat: {},
    models: [],
    // OpenAI 兼容默认 Bearer；未勾选才走 x-api-key
    authHeader: true,
  };
  state.selectedModelId = null;
  state.keyVisible = false;
  fillProviderForm(state.providerDetail);
  renderModelTable();
  fillProviderTestModelSelect();
  $('#model-editor').classList.add('hidden');
  $('#provider-empty').classList.add('hidden');
  $('#provider-editor').classList.remove('hidden');
  $('#p-title').textContent = '新建供应商';
  setDirty('models', false);
  renderProviderList();
  $('#p-id').focus();
}

function fillProviderForm(p) {
  $('#p-id').value = p.id || '';
  $('#p-baseUrl').value = p.baseUrl || '';
  $('#p-api').value = p.api || 'openai-completions';
  // 已配置：隐藏态用 •••••• 占位，不展示真实 key；显示时才填入明文
  state.keyVisible = false;
  $('#p-apiKey').type = 'password';
  $('#toggle-key').textContent = '显示';
  const hasKey = !!(p.apiKeyMasked?.configured || (p.apiKey && String(p.apiKey).length));
  state.keepApiKey = hasKey;
  state.keyIsPlaceholder = hasKey;
  state.storedApiKey = hasKey ? String(p.apiKey || '') : '';
  if (hasKey) {
    const len = state.storedApiKey ? state.storedApiKey.length : 12;
    $('#p-apiKey').value = maskDots(len);
    $('#p-apiKey').placeholder = '';
  } else {
    $('#p-apiKey').value = '';
    $('#p-apiKey').placeholder = 'sk-… / $ENV / !cmd';
  }
  // 缺省/未写字段 = Bearer（与 chat-client: authHeader !== false 一致）
  $('#p-authHeader').checked = p.authHeader !== false;
  $('#p-compat').value =
    p.compat && Object.keys(p.compat).length ? JSON.stringify(p.compat, null, 2) : '';
  $('#p-headers').value =
    p.headers && Object.keys(p.headers).length ? JSON.stringify(p.headers, null, 2) : '';
}

function fillProviderTestModelSelect(preferredId) {
  const sel = $('#provider-test-model');
  if (!sel) return;
  const models =
    (state.providerDetail && Array.isArray(state.providerDetail.models)
      ? state.providerDetail.models
      : []) || [];
  const prev = preferredId || sel.value || '';
  if (!models.length) {
    sel.innerHTML = '<option value="">（无已添加模型）</option>';
    sel.disabled = true;
    return;
  }
  sel.disabled = false;
  sel.innerHTML = models
    .map((m) => {
      const id = m && m.id ? String(m.id) : '';
      if (!id) return '';
      const label = m.api ? id + ' · api: ' + m.api : id;
      return '<option value="' + esc(id) + '">' + esc(label) + '</option>';
    })
    .filter(Boolean)
    .join('');
  if (prev && models.some((m) => m && m.id === prev)) sel.value = prev;
  else sel.selectedIndex = 0;
}

function renderModelTable() {
  const tbody = $('#model-tbody');
  tbody.innerHTML = '';
  const models = state.providerDetail?.models || [];
  fillProviderTestModelSelect();
  if (!models.length) {
    tbody.innerHTML =
      '<tr><td colspan="6" class="cell-empty">暂无模型</td></tr>';
    return;
  }
  const defP = state.defaults.defaultProvider || '';
  const defM = state.defaults.defaultModel || '';
  models.forEach((m) => {
    const tr = document.createElement('tr');
    if (m.id === state.selectedModelId) tr.classList.add('active');
    const isDef = state.currentProviderId === defP && m.id === defM;
    const costIn = m.cost && m.cost.input != null ? m.cost.input : '—';
    const costOut = m.cost && m.cost.output != null ? m.cost.output : '—';
    tr.innerHTML = `
      <td><strong>${esc(m.id)}</strong>${isDef ? ' <span class="badge accent">默认</span>' : ''}</td>
      <td>${esc(m.name || '')}</td>
      <td class="muted">${m.contextWindow ?? '—'} / ${m.maxTokens ?? '—'}</td>
      <td class="muted">${esc(String(costIn))} / ${esc(String(costOut))}</td>
      <td>${m.reasoning ? '<span class="badge ok">yes</span>' : '<span class="badge">no</span>'}</td>
      <td class="row-actions"><button type="button" class="btn ghost sm" data-edit="${esc(m.id)}">编辑</button></td>`;
    tr.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      openModelEditor(m.id);
    });
    tr.querySelector('[data-edit]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      openModelEditor(m.id);
    });
    tbody.appendChild(tr);
  });
}

function openModelEditor(modelId, saved = false) {
  if (!saved && (state.modelSaving || state.providerSaving)) return;
  if (!saved && state.modelDirty &&
      !confirm('模型有未保存修改，确定放弃并切换？')) return;
  if (modelId !== '__new__' && !(state.providerDetail?.models || []).some((m) => m.id === modelId)) return;
  if (!state.currentProviderId && !state.providerDetail) {
    return showToast('请先保存供应商', false);
  }
  setDirty('model', false);
  state.selectedModelId = modelId;
  $('#model-editor').classList.remove('hidden');
  if (modelId === '__new__') {
    $('#m-title').textContent = '新建模型';
    fillModelForm({
      id: '',
      name: '',
      reasoning: true,
      contextWindow: 128000,
      maxTokens: 16384,
      input: ['text'],
      thinkingLevelMap: defaultThinkingLevelMap(),
    });
    $('#model-delete').classList.add('hidden');
  } else {
    const m = (state.providerDetail.models || []).find((x) => x.id === modelId);
    if (!m) return;
    $('#m-title').textContent = '编辑 · ' + m.id;
    fillModelForm(m);
    $('#model-delete').classList.remove('hidden');
  }
  renderModelTable();
  $('#model-editor').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

/**
 * samplingParams / samplingParamsByThinkingLevel 校验（Pi 1.0.2+）。
 * 只对 openai-completions / openai-responses / azure-openai-responses 生效，
 * 其他协议 Pi 会忽略这两个字段。
 */
function validateSamplingParams(obj, label) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error(label + ' 必须是 JSON 对象');
  }
  return obj;
}

/** 键名必须是 Pi 思考档位（非 thinkingLevelMap 里的厂商值），值必须是对象。 */
function validateSamplingByThinkingLevel(obj, label) {
  validateSamplingParams(obj, label);
  for (const lv of Object.keys(obj)) {
    if (!TLM_LEVELS.includes(lv)) {
      throw new Error(
        label + ' 的键必须是 ' + TLM_LEVELS.join(' / ') + '，收到 "' + lv + '"'
      );
    }
    const params = obj[lv];
    if (!params || typeof params !== 'object' || Array.isArray(params)) {
      throw new Error(label + '["' + lv + '"] 必须是 JSON 对象');
    }
  }
  return obj;
}

/** 采样参数（Pi 1.0.2+）里做成一格一格的常用键，其他键走 JSON 输入。 */
const SPL_QUICK = ['temperature', 'top_p', 'top_k'];

function buildSamplingGrid() {
  const box = $('#m-spl-grid');
  if (!box) return;
  box.innerHTML = TLM_LEVELS.map(
    (lv) => `
    <div class="spl-item" data-level="${lv}">
      <span class="spl-lv">${lv}</span>
      <div class="spl-qs">
        ${SPL_QUICK.map(
          (k) =>
            `<input id="m-spl-${lv}-${k}" data-level="${lv}" data-key="${k}" type="number" step="any" placeholder="${k}" spellcheck="false">`
        ).join('')}
      </div>
      <input id="m-spl-${lv}-json" class="spl-json" placeholder='其他键 {"min_p":0.05}' spellcheck="false">
    </div>`
  ).join('');
}

/** 把对象里不属于常用键的部分抽成 JSON 文本，保证手写的罕见键不丢。 */
function splRest(obj, pretty) {
  const rest = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (!SPL_QUICK.includes(k)) rest[k] = v;
  }
  return Object.keys(rest).length ? JSON.stringify(rest, null, pretty ? 2 : 0) : '';
}

function fillSamplingForm(samplingParams, samplingByLevel) {
  const base = samplingParams && typeof samplingParams === 'object' ? samplingParams : {};
  for (const k of SPL_QUICK) {
    const el = $('#m-spl-' + k);
    if (el) el.value = base[k] != null ? String(base[k]) : '';
  }
  const extra = $('#m-spl-extra');
  if (extra) extra.value = splRest(base, true);

  const byLevel = samplingByLevel && typeof samplingByLevel === 'object' ? samplingByLevel : {};
  for (const lv of TLM_LEVELS) {
    const raw = byLevel[lv];
    const one = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    for (const k of SPL_QUICK) {
      const el = $('#m-spl-' + lv + '-' + k);
      if (el) el.value = one[k] != null ? String(one[k]) : '';
    }
    const j = $('#m-spl-' + lv + '-json');
    if (j) j.value = splRest(one, false);
  }
}

function clearSamplingForm() {
  fillSamplingForm(null, null);
  setDirty('model', true);
}

/**
 * 读表单 → { samplingParams, samplingParamsByThinkingLevel }。
 * 没内容时返回 undefined，saveModel 会发空串让服务端删键。
 */
function readSamplingFromForm() {
  const val = (id) => {
    const el = $(id);
    return el && el.value != null ? String(el.value) : '';
  };
  const num = (v, label) => {
    const t = v.trim();
    if (t === '') return undefined;
    const n = Number(t);
    if (!Number.isFinite(n)) throw new Error(label + ' 必须是数字');
    return n;
  };

  const base = {};
  for (const k of SPL_QUICK) {
    const n = num(val('#m-spl-' + k), k);
    if (n !== undefined) base[k] = n;
  }
  const extra = parseJsonField(val('#m-spl-extra'), '其他参数');
  if (extra !== undefined) {
    validateSamplingParams(extra, '其他参数');
    for (const [k, v] of Object.entries(extra)) {
      if (base[k] === undefined) base[k] = v; // 上面的输入框优先
    }
  }

  const byLevel = {};
  for (const lv of TLM_LEVELS) {
    const one = {};
    for (const k of SPL_QUICK) {
      const n = num(val('#m-spl-' + lv + '-' + k), lv + '.' + k);
      if (n !== undefined) one[k] = n;
    }
    const j = parseJsonField(val('#m-spl-' + lv + '-json'), lv + ' 其他键');
    if (j !== undefined) {
      validateSamplingParams(j, lv + ' 其他键');
      for (const [k, v] of Object.entries(j)) {
        if (one[k] === undefined) one[k] = v;
      }
    }
    if (Object.keys(one).length) byLevel[lv] = one;
  }

  return {
    samplingParams: Object.keys(base).length ? base : undefined,
    samplingParamsByThinkingLevel: Object.keys(byLevel).length ? byLevel : undefined,
  };
}

function fillModelForm(m) {
  $('#m-id').value = m.id || '';
  $('#m-name').value = m.name || '';
  $('#m-contextWindow').value = m.contextWindow != null ? m.contextWindow : '';
  $('#m-maxTokens').value = m.maxTokens != null ? m.maxTokens : '';
  $('#m-reasoning').checked = !!m.reasoning;
  $('#m-api').value = m.api || '';
  const input = Array.isArray(m.input) ? m.input : ['text'];
  $('#m-input').value = input.includes('image') ? 'text,image' : 'text';
  fillCostForm(m.cost);
  fillTlmForm(m.thinkingLevelMap || null);
  // also map legacy compat.reasoningEffortMap into tlm display if no tlm
  if (!m.thinkingLevelMap && m.compat && m.compat.reasoningEffortMap) {
    fillTlmForm(m.compat.reasoningEffortMap);
  }
  $('#m-compat').value = m.compat ? JSON.stringify(m.compat, null, 2) : '';
  fillSamplingForm(m.samplingParams, m.samplingParamsByThinkingLevel);
  $('#m-headers').value = m.headers ? JSON.stringify(m.headers, null, 2) : '';
}

function toggleKey() {
  const inp = $('#p-apiKey');
  if (!inp) return;
  if (!state.keyVisible) {
    // 显示：本地详情已带真实 Key，直接从 storedApiKey 填入
    state.keyVisible = true;
    inp.type = 'text';
    $('#toggle-key').textContent = '隐藏';
    if (state.keyIsPlaceholder) {
      inp.value = state.storedApiKey || '';
      state.keyIsPlaceholder = false;
      state.keepApiKey = true;
    }
  } else {
    // 隐藏：若内容仍是已存 key 且未改，恢复圆点；用户改过的内容则 password 遮罩
    state.keyVisible = false;
    inp.type = 'password';
    $('#toggle-key').textContent = '显示';
    if (state.keepApiKey && state.storedApiKey && inp.value === state.storedApiKey) {
      inp.value = maskDots(state.storedApiKey.length);
      state.keyIsPlaceholder = true;
    } else if (state.keepApiKey && !inp.value && state.storedApiKey) {
      inp.value = maskDots(state.storedApiKey.length);
      state.keyIsPlaceholder = true;
    } else {
      state.keyIsPlaceholder = false;
    }
  }
}

async function saveProvider() {
  if (state.providerSaving) return false;
  state.providerSaving = true;
  const revision = state.providerRevision;
  try {
    const id = $('#p-id').value.trim();
    if (!id) { showToast('供应商 ID 不能为空', false); return false; }
    if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(id)) {
      showToast('ID 仅限字母数字 _ . -', false);
      return false;
    }
    const body = {
      id,
      baseUrl: $('#p-baseUrl').value.trim(),
      api: $('#p-api').value,
      authHeader: $('#p-authHeader').checked,
      compat: parseJsonField($('#p-compat').value, 'Compat') || {},
      headers: parseJsonField($('#p-headers').value, 'Headers') || {},
    };
    const keyVal = ($('#p-apiKey').value || '').trim();
    if (
      state.keyIsPlaceholder ||
      isKeyMaskValue(keyVal) ||
      (state.keepApiKey && state.currentProviderId && keyVal === '')
    ) {
      body.apiKey = '__KEEP__';
    } else if (
      keyVal === '' &&
      state.currentProviderId &&
      state.storedApiKey &&
      state.providerDetail?.apiKeyMasked?.configured
    ) {
      // 既有 key 且用户在输入框里手动清空：确认后再删，避免误操作丢密钥
      if (!confirm('API Key 输入框为空，保存会清空已配置的密钥。确定要清空吗？')) {
        return false;
      }
      body.apiKey = '';
    } else {
      body.apiKey = keyVal;
    }
    if (Array.isArray(state.providerDetail?.models)) body.models = state.providerDetail.models;

    let result;
    if (!state.currentProviderId) {
      result = await api('/api/providers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } else {
      result = await api('/api/providers/' + encodeURIComponent(state.currentProviderId), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    }
    state.currentProviderId = result.id;
    state.providerDetail = result;
    if (state.providerRevision === revision) {
      state.keepApiKey = true;
      fillProviderForm(result);
      setDirty('provider', false);
    }
    renderModelTable();
    $('#p-title').textContent = result.id;
    showToast('供应商已保存');
    await loadProviders();
    await loadFlatModels();
    renderProviderList();
    return !state.providerDirty;
  } catch (e) {
    showToast('保存失败: ' + e.message, false);
    return false;
  } finally {
    state.providerSaving = false;
  }
}

async function deleteProvider() {
  if (!state.currentProviderId) {
    showProviderEmpty();
    return;
  }
  if (!confirm('删除供应商 "' + state.currentProviderId + '" 及全部模型？')) return;
  try {
    await api('/api/providers/' + encodeURIComponent(state.currentProviderId), {
      method: 'DELETE',
    });
    showToast('已删除');
    await loadProviders();
    await loadFlatModels();
    showProviderEmpty();
  } catch (e) {
    showToast('删除失败: ' + e.message, false);
  }
}

async function saveModel() {
  if (state.modelSaving || state.providerSaving) return false;
  if (!state.currentProviderId) { showToast('请先保存供应商', false); return false; }
  state.modelSaving = true;
  const revision = state.modelRevision;
  try {
    const modelId = $('#m-id').value.trim();
    if (!modelId) { showToast('Model ID 不能为空', false); return false; }
    const body = {
      id: modelId,
      name: $('#m-name').value.trim() || undefined,
      reasoning: $('#m-reasoning').checked,
      contextWindow: $('#m-contextWindow').value
        ? Number($('#m-contextWindow').value)
        : undefined,
      maxTokens: $('#m-maxTokens').value ? Number($('#m-maxTokens').value) : undefined,
      input: $('#m-input').value === 'text,image' ? ['text', 'image'] : ['text'],
    };
    const apiOverride = $('#m-api').value;
    if (apiOverride) body.api = apiOverride;
    else body.api = ''; // clear override

    const cost = readCostFromForm();
    if (cost !== undefined) body.cost = cost;
    else body.cost = ''; // allow clear

    const tlm = readTlmFromForm();
    if (tlm !== undefined) body.thinkingLevelMap = tlm;
    else body.thinkingLevelMap = ''; // clear

    const compat = parseJsonField($('#m-compat').value, 'Compat');
    if (compat !== undefined) body.compat = compat;
    else body.compat = '';

    const spl = readSamplingFromForm();
    if (spl.samplingParams !== undefined) body.samplingParams = spl.samplingParams;
    else body.samplingParams = ''; // clear

    if (spl.samplingParamsByThinkingLevel !== undefined) {
      body.samplingParamsByThinkingLevel = spl.samplingParamsByThinkingLevel;
    } else body.samplingParamsByThinkingLevel = ''; // clear

    const headers = parseJsonField($('#m-headers').value, 'Headers');
    if (headers !== undefined) body.headers = headers;
    else body.headers = '';

    const isNew = state.selectedModelId === '__new__' || !state.selectedModelId;
    let result;
    if (isNew) {
      result = await api(
        '/api/providers/' + encodeURIComponent(state.currentProviderId) + '/models',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      );
    } else {
      result = await api(
        '/api/providers/' +
          encodeURIComponent(state.currentProviderId) +
          '/models/' +
          encodeURIComponent(state.selectedModelId),
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }
      );
    }
    state.providerDetail = await api(
      '/api/providers/' + encodeURIComponent(state.currentProviderId)
    );
    state.selectedModelId = result.model.id;
    if (state.modelRevision === revision) {
      openModelEditor(result.model.id, true);
      setDirty('model', false);
    }
    showToast('模型已保存');
    await loadProviders();
    await loadFlatModels();
    renderProviderList();
    return !state.modelDirty;
  } catch (e) {
    showToast('保存模型失败: ' + e.message, false);
    return false;
  } finally {
    state.modelSaving = false;
  }
}

async function deleteModel() {
  if (!state.currentProviderId || !state.selectedModelId || state.selectedModelId === '__new__') {
    return;
  }
  if (!confirm('删除模型 "' + state.selectedModelId + '"？')) return;
  try {
    await api(
      '/api/providers/' +
        encodeURIComponent(state.currentProviderId) +
        '/models/' +
        encodeURIComponent(state.selectedModelId),
      { method: 'DELETE' }
    );
    state.providerDetail = await api(
      '/api/providers/' + encodeURIComponent(state.currentProviderId)
    );
    state.selectedModelId = null;
    $('#model-editor').classList.add('hidden');
    renderModelTable();
    setDirty('model', false);
    showToast('模型已删除');
    await loadProviders();
    await loadFlatModels();
    renderProviderList();
  } catch (e) {
    showToast('删除失败: ' + e.message, false);
  }
}

// ── remote models fetch / import ────────────────────────────────────────────

function closeRemotePanel() {
  persistRemoteStateForProvider(state.currentProviderId);
  $('#remote-models-panel')?.classList.add('hidden');
}

function persistRemoteStateForProvider(providerId) {
  if (!providerId) return;
  const panelOpen = !$('#remote-models-panel')?.classList.contains('hidden');
  state.remoteByProvider[providerId] = {
    models: state.remoteModels || [],
    url: state.remoteModelsUrl || '',
    selected: [...(state.remoteSelected || [])],
    filter: state.remoteFilter || '',
    panelOpen,
  };
}

function restoreRemoteStateForProvider(providerId) {
  const cached = providerId ? state.remoteByProvider[providerId] : null;
  if (!cached) {
    state.remoteModels = [];
    state.remoteModelsUrl = '';
    state.remoteSelected = new Set();
    state.remoteFilter = '';
    if ($('#remote-filter')) $('#remote-filter').value = '';
    $('#remote-models-panel')?.classList.add('hidden');
    const meta = $('#remote-models-meta');
    if (meta) meta.textContent = '';
    const box = $('#remote-models-list');
    if (box) box.innerHTML = '';
    return;
  }
  state.remoteModels = Array.isArray(cached.models) ? cached.models : [];
  state.remoteModelsUrl = cached.url || '';
  state.remoteSelected = new Set(Array.isArray(cached.selected) ? cached.selected : []);
  state.remoteFilter = cached.filter || '';
  if ($('#remote-filter')) $('#remote-filter').value = state.remoteFilter;
  const meta = $('#remote-models-meta');
  if (meta) {
    const localN = state.remoteModels.filter((m) => m.local).length;
    meta.textContent = state.remoteModels.length
      ? '· ' +
        state.remoteModels.length +
        ' 个' +
        (localN ? '（已有 ' + localN + '）' : '') +
        (state.remoteModelsUrl ? ' · ' + state.remoteModelsUrl : '')
      : '';
  }
  if (cached.panelOpen && state.remoteModels.length) {
    $('#remote-models-panel')?.classList.remove('hidden');
    renderRemoteModelsList();
  } else {
    $('#remote-models-panel')?.classList.add('hidden');
  }
}

function ensureProviderTestModal() {
  let modal = document.getElementById('provider-test-modal');
  if (modal) return modal;
  modal = document.createElement('div');
  modal.id = 'provider-test-modal';
  modal.className = 'modal-overlay hidden';
  modal.innerHTML =
    '<div class="modal-card provider-test-modal-card" role="dialog" aria-modal="true">' +
    '<div class="modal-head">' +
    '<strong id="provider-test-modal-title">检测供应商</strong>' +
    '<button type="button" class="btn ghost sm" id="provider-test-modal-close">关闭</button>' +
    '</div>' +
    '<div class="provider-test-modal-body">' +
    '<p class="muted" id="provider-test-modal-desc">选择一个已添加的模型，按该模型的 API 格式（含模型级覆盖）向 Base URL 发送最小请求。</p>' +
    '<label class="provider-test-model-field">模型' +
    '<select id="provider-test-model"></select>' +
    '</label>' +
    '<div id="provider-test-modal-status" class="hint-block">选择模型后点「开始检测」</div>' +
    '</div>' +
    '<div class="modal-actions">' +
    '<button type="button" class="btn ghost sm" id="provider-test-modal-cancel">取消</button>' +
    '<button type="button" class="btn primary sm" id="provider-test-modal-run">开始检测</button>' +
    '</div></div>';
  document.body.appendChild(modal);

  const hide = () => modal.classList.add('hidden');
  modal.addEventListener('click', (e) => {
    if (e.target === modal) hide();
  });
  $('#provider-test-modal-close')?.addEventListener('click', hide);
  $('#provider-test-modal-cancel')?.addEventListener('click', hide);
  $('#provider-test-modal-run')?.addEventListener('click', () => runProviderTestFromModal());
  return modal;
}

function openProviderTestModal() {
  if (!state.currentProviderId && !state.providerDetail) {
    return showToast('请先选择或保存供应商', false);
  }
  const models = (state.providerDetail && state.providerDetail.models) || [];
  if (!models.length) {
    return showToast('请先添加模型，或点「获取模型」导入后再检测', false);
  }
  ensureProviderTestModal();
  fillProviderTestModelSelect();
  const title = $('#provider-test-modal-title');
  if (title) {
    title.textContent =
      '检测 · ' + (state.currentProviderId || state.providerDetail.id || '供应商');
  }
  const st = $('#provider-test-modal-status');
  if (st) {
    st.className = 'hint-block';
    st.textContent = '选择模型后点「开始检测」';
  }
  const runBtn = $('#provider-test-modal-run');
  if (runBtn) {
    runBtn.disabled = false;
    runBtn.textContent = '开始检测';
  }
  $('#provider-test-modal')?.classList.remove('hidden');
  if (typeof refreshIcons === 'function') refreshIcons();
}

async function runProviderTestFromModal() {
  if (!state.currentProviderId) {
    return showToast('请先保存供应商', false);
  }
  const selectedModel = ($('#provider-test-model')?.value || '').trim();
  const st = $('#provider-test-modal-status');
  const runBtn = $('#provider-test-modal-run');
  if (!selectedModel) {
    if (st) {
      st.className = 'hint-block warn';
      st.textContent = '请先选择一个已添加的模型';
    }
    return showToast('请先选择模型', false);
  }
  if (runBtn) {
    runBtn.disabled = true;
    runBtn.textContent = '检测中…';
  }
  if (st) {
    st.className = 'hint-block warn';
    st.textContent = '正在检测… model=' + selectedModel;
  }
  try {
    const formBase = ($('#p-baseUrl').value || '').trim();
    let formKey = ($('#p-apiKey').value || '').trim();
    if (state.keyIsPlaceholder || isKeyMaskValue(formKey) || (state.keepApiKey && !formKey)) {
      formKey = '__KEEP__';
    }
    let formHeaders;
    try {
      formHeaders = parseJsonField($('#p-headers').value, 'Headers');
    } catch (e) {
      if (st) {
        st.className = 'hint-block err';
        st.textContent = e.message;
      }
      return showToast(e.message, false);
    }
    const r = await api(
      '/api/providers/' + encodeURIComponent(state.currentProviderId) + '/test',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          baseUrl: formBase || undefined,
          apiKey: formKey || '__KEEP__',
          // 与对话一致：勾选或未写 = Bearer；仅明确取消勾选才 x-api-key
          authHeader: $('#p-authHeader')?.checked !== false,
          headers: formHeaders,
          model: selectedModel,
          api: $('#p-api')?.value,
        }),
      }
    );
    if (st) {
      st.className = 'hint-block ' + (r.ok ? 'ok' : 'err');
      const ep = r.endpoint ? ' · ' + r.endpoint : '';
      const md = r.model ? ' · model ' + r.model : '';
      // api = 配置里选的协议；apiUsed = 本次实探发出去的协议。两者不一致必须显式暴露。
      const au = r.api
        ? r.apiUsed && r.apiUsed !== r.api
          ? ' · api ' + r.api + '（实探 ' + r.apiUsed + '）'
          : ' · api ' + r.api
        : r.apiUsed
        ? ' · api ' + r.apiUsed
        : '';
      const weak =
        r.ok && r.weak
          ? ' ⚠ 弱通过（404：该路径不存在，通常 Base URL 少了路径前缀，如 /anthropic，只能证明可达）'
          : '';
      const bHint = r.baseUrlHint ? ' → Base URL 建议改为 ' + r.baseUrlHint : '';
      st.textContent = r.ok
        ? '检测通过 ✓ ' + (r.message || ('HTTP ' + (r.status || ''))) + md + au + ep + weak + bHint
        : '检测失败: ' + (r.error || r.message || 'unknown') + md + au + ep + bHint;
    }
    // 同步到页面状态条（若存在）
    const pageSt = $('#provider-status');
    if (pageSt) {
      pageSt.style.display = '';
      pageSt.className = 'hint-block ' + (r.ok ? 'ok' : 'err');
      pageSt.textContent = st ? st.textContent : '';
    }
    showToast(r.ok ? '检测通过' : '检测失败: ' + (r.error || r.message || ''), r.ok);
  } catch (e) {
    if (st) {
      st.className = 'hint-block err';
      st.textContent = '检测失败: ' + e.message;
    }
    showToast('检测失败: ' + e.message, false);
  } finally {
    if (runBtn) {
      runBtn.disabled = false;
      runBtn.textContent = '开始检测';
    }
  }
}

async function testProviderUI() {
  openProviderTestModal();
}

async function fetchRemoteModelsUI() {
  if (!state.currentProviderId) {
    return showToast('请先保存供应商，再获取模型', false);
  }
  const btn = $('#model-fetch');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '获取中…';
  }
  try {
    // 若表单有未保存 baseUrl/key，用 POST 覆盖试拉；否则 GET 用已存配置
    const formBase = ($('#p-baseUrl').value || '').trim();
    let formKey = ($('#p-apiKey').value || '').trim();
    // 圆点占位 / 掩码绝不能当真实 key 发出（ByteString 会炸：• = 8226）
    if (
      state.keyIsPlaceholder ||
      isKeyMaskValue(formKey) ||
      (state.keepApiKey && !formKey)
    ) {
      formKey = '';
    }
    const formAuth = $('#p-authHeader')?.checked !== false;
    let formHeaders;
    try {
      formHeaders = parseJsonField($('#p-headers').value, 'Headers');
    } catch (e) {
      return showToast(e.message, false);
    }

    const savedBase = state.providerDetail?.baseUrl || '';
    const headersChanged =
      formHeaders && JSON.stringify(formHeaders) !== JSON.stringify(state.providerDetail?.headers || {});
    const savedAuth = state.providerDetail?.authHeader !== false;
    const useOverride =
      (formBase && formBase !== savedBase) ||
      !!formKey ||
      !!headersChanged ||
      formAuth !== savedAuth;

    let data;
    if (useOverride) {
      data = await api(
        '/api/providers/' + encodeURIComponent(state.currentProviderId) + '/remote-models',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            baseUrl: formBase || undefined,
            // 未改 key 时显式保持已存密钥
            apiKey: formKey || '__KEEP__',
            authHeader: formAuth,
            headers: formHeaders,
          }),
        }
      );
    } else {
      data = await api(
        '/api/providers/' + encodeURIComponent(state.currentProviderId) + '/remote-models'
      );
    }

    state.remoteModels = data.models || [];
    state.remoteModelsUrl = data.url || '';
    // 默认全不选，避免一键误导入；各供应商独立勾选状态
    state.remoteSelected = new Set();
    state.remoteFilter = '';
    if ($('#remote-filter')) $('#remote-filter').value = '';
    $('#remote-models-panel')?.classList.remove('hidden');
    const meta = $('#remote-models-meta');
    if (meta) {
      const localN = state.remoteModels.filter((m) => m.local).length;
      meta.textContent =
        '· ' +
        state.remoteModels.length +
        ' 个' +
        (localN ? '（已有 ' + localN + '）' : '') +
        (data.url ? ' · ' + data.url : '');
    }
    renderRemoteModelsList();
    persistRemoteStateForProvider(state.currentProviderId);
    showToast('获取到 ' + state.remoteModels.length + ' 个模型（默认未勾选）');
  } catch (e) {
    showToast('获取失败: ' + e.message, false);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '获取模型';
    }
  }
}

function filteredRemoteModels() {
  const q = (state.remoteFilter || '').trim().toLowerCase();
  if (!q) return state.remoteModels;
  return state.remoteModels.filter(
    (m) =>
      m.id.toLowerCase().includes(q) ||
      (m.name || '').toLowerCase().includes(q) ||
      (m.owned_by || '').toLowerCase().includes(q)
  );
}

function renderRemoteModelsList() {
  const box = $('#remote-models-list');
  if (!box) return;
  const list = filteredRemoteModels();
  if (!list.length) {
    box.innerHTML = '<div class="remote-empty">无匹配模型</div>';
    return;
  }
  box.innerHTML = list
    .map((m) => {
      const checked = state.remoteSelected.has(m.id);
      const guessBits = [];
      if (m.guess?.contextWindow) guessBits.push('ctx ' + m.guess.contextWindow);
      if (m.guess?.maxTokens) guessBits.push('max ' + m.guess.maxTokens);
      return `
      <label class="remote-item ${m.local ? 'local' : ''}" data-id="${esc(m.id)}">
        <input type="checkbox" data-remote-id="${esc(m.id)}" ${checked ? 'checked' : ''}>
        <span>
          <div class="rid">${esc(m.id)}</div>
          <div class="rsub">${esc(m.name || '')}${m.owned_by ? ' · ' + esc(m.owned_by) : ''}${guessBits.length ? ' · ' + esc(guessBits.join(' / ')) : ''}</div>
        </span>
        <span class="rtags">
          ${m.local ? '<span class="badge ok">已有</span>' : '<span class="badge accent">新</span>'}
          ${m.guess?.reasoning ? '<span class="badge">R</span>' : ''}
        </span>
      </label>`;
    })
    .join('');

  box.querySelectorAll('input[type=checkbox][data-remote-id]').forEach((inp) => {
    inp.addEventListener('change', () => {
      const id = inp.dataset.remoteId;
      if (inp.checked) state.remoteSelected.add(id);
      else state.remoteSelected.delete(id);
      persistRemoteStateForProvider(state.currentProviderId);
    });
  });
}

function selectRemote(mode) {
  const list = filteredRemoteModels();
  if (mode === 'all') {
    list.forEach((m) => state.remoteSelected.add(m.id));
  } else if (mode === 'none') {
    list.forEach((m) => state.remoteSelected.delete(m.id));
  } else if (mode === 'new') {
    list.forEach((m) => {
      if (m.local) state.remoteSelected.delete(m.id);
      else state.remoteSelected.add(m.id);
    });
  }
  persistRemoteStateForProvider(state.currentProviderId);
  renderRemoteModelsList();
}

async function importSelectedRemoteModels() {
  if (!state.currentProviderId) return showToast('请先保存供应商', false);
  const selected = state.remoteModels.filter((m) => state.remoteSelected.has(m.id));
  if (!selected.length) return showToast('请先勾选要导入的模型', false);

  const skipExisting = $('#remote-skip-existing')?.checked !== false;
  const payload = {
    skipExisting,
    models: selected.map((m) => ({
      id: m.id,
      name: m.name || m.id,
      reasoning: m.guess?.reasoning != null ? !!m.guess.reasoning : true,
      contextWindow: m.guess?.contextWindow,
      maxTokens: m.guess?.maxTokens,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      thinkingLevelMap: defaultThinkingLevelMap(),
    })),
  };

  const btn = $('#remote-import');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '导入中…';
  }
  try {
    const result = await api(
      '/api/providers/' + encodeURIComponent(state.currentProviderId) + '/import-models',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }
    );
    state.providerDetail = result.provider || (await api(
      '/api/providers/' + encodeURIComponent(state.currentProviderId)
    ));
    renderModelTable();
    await loadProviders();
    await loadFlatModels();
    renderProviderList();

    // refresh local flags in remote list
    const localIds = new Set((state.providerDetail.models || []).map((m) => m.id));
    state.remoteModels = state.remoteModels.map((m) => ({
      ...m,
      local: localIds.has(m.id),
    }));
    // clear selection of imported
    (result.imported || []).forEach((id) => state.remoteSelected.delete(id));
    persistRemoteStateForProvider(state.currentProviderId);
    renderRemoteModelsList();

    const msg =
      '导入 ' +
      (result.imported || []).length +
      '，跳过 ' +
      (result.skipped || []).length +
      (result.failed?.length ? '，失败 ' + result.failed.length : '');
    showToast(msg, !(result.failed && result.failed.length));
  } catch (e) {
    showToast('导入失败: ' + e.message, false);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '导入选中';
    }
  }
}

  window.PiManager = window.PiManager || {};
  window.PiManager.models = {
    bindModelsUI, loadProviders, loadDefaults, loadFlatModels, renderDefaultsBar, saveDefaults,
    renderProviderList, showProviderEmpty, selectProvider, openNewProvider, saveProvider, deleteProvider,
    renderModelTable, openModelEditor, saveModel, deleteModel,
    buildTlmGrid, fillTlmForm, readTlmFromForm, fillCostForm, readCostFromForm,
    validateSamplingParams, validateSamplingByThinkingLevel,
    buildSamplingGrid, fillSamplingForm, readSamplingFromForm,
    renderRemoteModelsList, selectRemote, fetchRemoteModelsUI, importSelectedRemoteModels,
    testProviderUI, closeRemotePanel,
    loadMigrations, applyMigrationUI, dismissMigrationBanner
  };
  // 挂载旧式 window.* 兼容导出供 app.js 路由分发及 console-ui 等调用：
  Object.assign(window, window.PiManager.models);
})();
