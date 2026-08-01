const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

const TLM_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/**
 * 拆分 model spec 中的 thinking 后缀（只认最后一个合法档位，如 provider/id:high）。
 * 与 Pi CLI `--model sonnet:high` 及后端 parse 规则一致；非档位冒号（如 :exacto）保留在 model 内。
 * @param {string} spec
 * @returns {{ model: string, thinking: string }}
 */
function parseModelSpec(spec) {
  const s = String(spec ?? '').trim();
  if (!s) return { model: '', thinking: '' };
  const i = s.lastIndexOf(':');
  if (i <= 0) return { model: s, thinking: '' };
  const suffix = s.slice(i + 1);
  if (TLM_LEVELS.includes(suffix)) {
    return { model: s.slice(0, i), thinking: suffix };
  }
  return { model: s, thinking: '' };
}

/**
 * 合成 model + :thinking 后缀；thinking 空则返回纯 model。
 * @param {string} model
 * @param {string} thinking
 * @returns {string}
 */
function composeModelSpec(model, thinking) {
  const m = String(model ?? '').trim();
  const t = String(thinking ?? '').trim();
  if (!m) return '';
  if (!t || !TLM_LEVELS.includes(t)) return m;
  return m + ':' + t;
}

/**
 * 新建/导入默认思考档位映射（全量覆盖，避免漏档）。
 * 偏保守：off→none；xhigh/max 收到 high（多数供应商无更高档）。
 * 编辑器里仍可改成恒等或其它厂商值。
 */
function defaultThinkingLevelMap() {
  return {
    off: 'none',
    minimal: 'minimal',
    low: 'low',
    medium: 'medium',
    high: 'high',
    xhigh: 'high',
    max: 'high',
  };
}

const state = {
  route: 'models',
  meta: {},
  providers: [],
  flatModels: [],
  defaults: {},
  currentProviderId: null,
  providerDetail: null,
  selectedModelId: null,
  keepApiKey: true,
  keyVisible: false,
  modelsDirty: false,
  agents: [],
  currentAgentName: null,
  agentDetail: null,
  agentsDirty: false,
  toolPool: { builtins: [], presets: {} },
  selectedTools: new Set(),
  activeToolPreset: 'custom',
  categories: [],
  agentCategoryFilter: 'all',
  remoteModels: [],
  remoteModelsUrl: '',
  remoteSelected: new Set(),
  remoteFilter: '',
  // 每个供应商独立：远程列表 / 勾选 / 过滤 / 面板是否展开
  remoteByProvider: {},
  // openvl
  openvlProfiles: [],
  openvlActive: null,
  openvlOllama: { url: '', model: '', backend: 'ollama' },
  openvlPaths: {},
  currentOpenvlId: null,
  openvlView: 'profile', // profile | ollama
  openvlDetail: null,
  openvlModels: [],
  openvlKeepKey: true,
  openvlKeyVisible: false,
  openvlDirty: false,
  openvlAvailable: true,
  openvlHint: '',
  promptContent: '',
  promptMeta: null,
  promptDirty: false,
  skillsData: null,
  skillsDirty: false,
  pluginsData: null,
  pluginsDirty: false,
  workspaces: [],
  wsSuggestions: [],
  currentWsId: null,
  wsDetail: null,
  wsDirty: false,
  wsIsNew: false,
  wsTree: null,
  wsFilePath: '',
  wsFileMeta: null,
  wsFileDirty: false,
  memDirty: false,
  kbDirty: false,
};


function maskDots(len) {
  const n = Math.max(6, Math.min(Number(len) || 8, 24));
  return '•'.repeat(n);
}

function isKeyMaskValue(v) {
  return typeof v === 'string' && /^•+$/.test(v);
}

// ── boot ────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  initTheme();
  bindThemeUI();
  bindHelpAndOnboarding();
  bindNav();
  bindModelsUI();
  bindAgentsUI();
  bindOpenvlUI();
  if (typeof bindConsoleUI === 'function') bindConsoleUI();
  if (typeof bindContentPages === 'function') bindContentPages();
  bindGlobalSave();
  buildTlmGrid();
  await Promise.all([
    loadMeta(),
    loadProviders(),
    loadDefaults(),
    loadFlatModels(),
    loadAgents(),
    loadToolPool(),
    loadCategories(),
    loadOpenvl(),
    typeof loadConsoleData === 'function' ? loadConsoleData() : Promise.resolve(),
  ]);
  if (typeof updateCapabilityHints === 'function') updateCapabilityHints();
  routeFromHash();
  window.addEventListener('hashchange', routeFromHash);
  maybeShowOnboarding();
});

// ── theme ───────────────────────────────────────────────────────────────────

const THEME_KEY = 'pi-manager-theme';
const THEMES = [
  'default',
  'midnight',
  'aurora',
  'orchid',
  'amber',
  'miku',
  'light',
  'paper',
  'rose',
  'miku-light',
];
const THEME_LABELS = {
  default: '默认蓝',
  midnight: '午夜',
  aurora: '极光',
  orchid: '紫雾',
  amber: '琥珀',
  miku: '初音',
  light: '浅色',
  paper: '纸感',
  rose: '玫瑰',
  'miku-light': '初音浅色',
};

function initTheme() {
  let theme = 'default';
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved && THEMES.includes(saved)) theme = saved;
  } catch (_) { /* ignore */ }
  applyTheme(theme);
}

function syncThemePickerUI(theme) {
  const sel = $('#theme-select');
  if (sel && sel.value !== theme) sel.value = theme;
  const label = $('#theme-select-label');
  if (label) label.textContent = THEME_LABELS[theme] || theme;
  $$('.theme-menu-item').forEach((btn) => {
    const on = btn.getAttribute('data-theme-value') === theme;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-selected', on ? 'true' : 'false');
  });
}

function closeThemeMenu() {
  const menu = $('#theme-menu');
  const btn = $('#theme-select-btn');
  if (menu) menu.classList.add('hidden');
  if (btn) btn.setAttribute('aria-expanded', 'false');
}

function openThemeMenu() {
  const menu = $('#theme-menu');
  const btn = $('#theme-select-btn');
  if (!menu || !btn) return;
  menu.classList.remove('hidden');
  btn.setAttribute('aria-expanded', 'true');
  if (typeof refreshIcons === 'function') refreshIcons(menu);
}

function applyTheme(theme) {
  if (!THEMES.includes(theme)) theme = 'default';
  document.documentElement.setAttribute('data-theme', theme);
  syncThemePickerUI(theme);
  // 用量图表 tooltip/系列色读 CSS 变量，换主题后立刻重画
  if (
    typeof state !== 'undefined' &&
    state.route === 'usage' &&
    state.usageData &&
    typeof renderUsageCharts === 'function'
  ) {
    requestAnimationFrame(() => {
      try {
        renderUsageCharts(state.usageData);
      } catch (_) {
        /* ignore */
      }
    });
  }
}

function bindThemeUI() {
  const btn = $('#theme-select-btn');
  const menu = $('#theme-menu');
  const sel = $('#theme-select');
  // 自定义菜单（避免原生 optgroup 白字）
  if (btn && menu) {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (menu.classList.contains('hidden')) openThemeMenu();
      else closeThemeMenu();
    });
    menu.addEventListener('click', (e) => {
      const item = e.target.closest('.theme-menu-item');
      if (!item) return;
      e.preventDefault();
      const theme = item.getAttribute('data-theme-value');
      if (!theme) return;
      applyTheme(theme);
      try {
        localStorage.setItem(THEME_KEY, theme);
      } catch (_) {
        /* ignore */
      }
      closeThemeMenu();
    });
    document.addEventListener('click', (e) => {
      const wrap = $('#theme-picker');
      if (!wrap || wrap.contains(e.target)) return;
      closeThemeMenu();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeThemeMenu();
    });
  }
  // 原生 select 仍同步（无障碍 / 旧路径）
  if (sel) {
    sel.addEventListener('change', () => {
      const theme = sel.value;
      applyTheme(theme);
      try {
        localStorage.setItem(THEME_KEY, theme);
      } catch (_) {
        /* ignore */
      }
    });
  }
}

// ── onboarding / help ───────────────────────────────────────────────────────

const ONBOARD_KEY = 'pi-manager-onboarding-done';

const ONBOARD_STEPS = [
  {
    kicker: '先做什么',
    title: '先配模型，就能用起来',
    body: '打开「模型」：填接口地址和密钥 → 添加模型 → 设为默认。子代理、提示词、Skills 都靠这一步，不需要额外文件夹。',
  },
  {
    kicker: '子代理',
    title: '需要时再管子代理',
    body: '「子代理」里改名称、模型、工具和说明即可。侧栏「工作流」是协作规则文档：只有配置了记忆文件夹后才会出现可编辑文件；没有也不影响改子代理。',
  },
  {
    kicker: '提示词',
    title: '改全局说明文字',
    body: '「提示词」编辑 Pi 的总说明和模板，可预览 Markdown。保存后，在 Pi 里按需要 /reload。',
  },
  {
    kicker: '记忆 / 知识库',
    title: '要管笔记时再开',
    body: '想在网页里改记忆或知识库文件，才需要「工作区」：指定本机文件夹，并写明 memory / knowledge 对应哪个子目录。没配时这两页会写清原因和按钮，其它功能照常用。',
  },
  {
    kicker: '工作区',
    title: '映射怎么做',
    body: '1）根路径=本机大文件夹；2）其下建 memory、knowledge 等子文件夹；3）映射框用 JSON 写 "memory":"memory"（值是相对路径，不要写盘符）；4）保存后看「映射状态」是否存在；5）再打开记忆/知识库页。建议列表为空时手动「+ 工作区」即可。',
  },
];

let onboardIndex = 0;
let helpOpen = false;

function isOnboardingDone() {
  try { return localStorage.getItem(ONBOARD_KEY) === '1'; } catch (_) { return false; }
}

function markOnboardingDone() {
  try { localStorage.setItem(ONBOARD_KEY, '1'); } catch (_) { /* ignore */ }
}

function maybeShowOnboarding() {
  if (!isOnboardingDone()) openOnboarding(0);
}

function openOnboarding(start = 0) {
  closeHelpPanel();
  onboardIndex = Math.max(0, Math.min(start, ONBOARD_STEPS.length - 1));
  renderOnboarding();
  const overlay = $('#onboard-overlay');
  if (overlay) overlay.classList.remove('hidden');
}

function closeOnboarding(done) {
  const overlay = $('#onboard-overlay');
  if (overlay) overlay.classList.add('hidden');
  if (done) markOnboardingDone();
}

function renderOnboarding() {
  const step = ONBOARD_STEPS[onboardIndex];
  if (!step) return;
  const total = ONBOARD_STEPS.length;
  const kicker = $('#onboard-kicker');
  const title = $('#onboard-title');
  const body = $('#onboard-body');
  const prev = $('#onboard-prev');
  const next = $('#onboard-next');
  const dots = $('#onboard-steps');

  if (kicker) kicker.textContent = `${step.kicker} · ${onboardIndex + 1} / ${total}`;
  if (title) title.textContent = step.title;
  if (body) body.textContent = step.body;
  if (prev) prev.classList.toggle('hidden', onboardIndex === 0);
  if (next) next.textContent = onboardIndex >= total - 1 ? '完成' : '下一步';

  if (dots) {
    dots.innerHTML = '';
    for (let i = 0; i < total; i++) {
      const d = document.createElement('span');
      d.className = 'onboard-dot' + (i === onboardIndex ? ' active' : i < onboardIndex ? ' done' : '');
      dots.appendChild(d);
    }
  }
}

function openHelpPanel() {
  const panel = $('#help-panel');
  const btn = $('#help-btn');
  if (!panel) return;
  panel.classList.remove('hidden');
  btn?.classList.add('active');
  helpOpen = true;
}

function closeHelpPanel() {
  const panel = $('#help-panel');
  const btn = $('#help-btn');
  if (!panel) return;
  panel.classList.add('hidden');
  btn?.classList.remove('active');
  helpOpen = false;
}

function toggleHelpPanel() {
  if (helpOpen) closeHelpPanel();
  else openHelpPanel();
}

function bindHelpAndOnboarding() {
  $('#help-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleHelpPanel();
  });
  $('#help-close')?.addEventListener('click', () => closeHelpPanel());
  $('#help-replay')?.addEventListener('click', () => {
    closeHelpPanel();
    openOnboarding(0);
  });

  $('#onboard-skip')?.addEventListener('click', () => closeOnboarding(true));
  $('#onboard-prev')?.addEventListener('click', () => {
    if (onboardIndex > 0) {
      onboardIndex -= 1;
      renderOnboarding();
    }
  });
  $('#onboard-next')?.addEventListener('click', () => {
    if (onboardIndex >= ONBOARD_STEPS.length - 1) {
      closeOnboarding(true);
      return;
    }
    onboardIndex += 1;
    renderOnboarding();
  });

  // 点遮罩空白处不强制关闭，避免误关；Esc 关闭帮助或完成跳过引导
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const overlay = $('#onboard-overlay');
    if (overlay && !overlay.classList.contains('hidden')) {
      closeOnboarding(true);
      return;
    }
    if (helpOpen) closeHelpPanel();
  });

  document.addEventListener('click', (e) => {
    if (!helpOpen) return;
    const panel = $('#help-panel');
    const btn = $('#help-btn');
    if (!panel || panel.classList.contains('hidden')) return;
    if (panel.contains(e.target) || btn?.contains(e.target)) return;
    closeHelpPanel();
  });
}

function bindNav() {
  $$('#nav-tabs .tab').forEach((el) => {
    el.addEventListener('click', (e) => {
      // allow normal hash navigation
    });
  });
}

function routeFromHash() {
  const rawHash = location.hash || '#/dashboard';
  const h = rawHash.replace(/^#\/?/, '');
  const pathOnly = h.split(/[?#]/)[0] || '';
  const qIdx = h.indexOf('?');
  const query = {};
  if (qIdx >= 0) {
    try {
      const sp = new URLSearchParams(h.slice(qIdx + 1));
      sp.forEach((v, k) => {
        query[k] = v;
      });
    } catch {
      /* ignore bad query */
    }
  }
  let next = 'dashboard';
  if (pathOnly.startsWith('dashboard') || pathOnly === '' || pathOnly === '/') next = 'dashboard';
  else if (pathOnly.startsWith('search')) next = 'search';
  else if (pathOnly.startsWith('sessions')) next = 'sessions';
  else if (pathOnly.startsWith('usage')) next = 'usage';
  else if (pathOnly.startsWith('runtime')) next = 'runtime';
  else if (pathOnly.startsWith('trash')) next = 'trash';
  else if (pathOnly.startsWith('agents')) next = 'agents';
  else if (pathOnly.startsWith('openvl')) next = 'openvl';
  else if (pathOnly.startsWith('prompt')) next = 'prompt';
  else if (pathOnly.startsWith('skills')) next = 'skills';
  else if (pathOnly.startsWith('plugins')) next = 'plugins';
  else if (pathOnly.startsWith('guides')) next = 'guides';
  else if (pathOnly.startsWith('memory')) next = 'memory';
  else if (pathOnly.startsWith('knowledge')) next = 'knowledge';
  else if (pathOnly.startsWith('workspaces')) next = 'workspaces';
  else if (pathOnly.startsWith('models')) next = 'models';
  if (state.route && next !== state.route && isAnyDirty()) {
    const ok = confirm('有未保存修改。确定离开当前页？\n（可先点右上角「保存」）');
    if (!ok) {
      const keep = typeof routeHashFor === 'function' ? routeHashFor(state.route) : '#/dashboard';
      if (location.hash !== keep) history.replaceState(null, '', keep);
      $$('#nav-tabs .tab[data-route]').forEach((tab) =>
        tab.classList.toggle('active', tab.dataset.route === state.route)
      );
      $$('#nav-more-menu .nav-more-item').forEach((item) =>
        item.classList.toggle('active', item.dataset.route === state.route)
      );
      return;
    }
  }
  state.route = next;
  $$('#nav-tabs .tab[data-route]').forEach((tab) =>
    tab.classList.toggle('active', tab.dataset.route === next)
  );
  $$('#nav-more-menu .nav-more-item').forEach((item) =>
    item.classList.toggle('active', item.dataset.route === next)
  );
  const moreRoutes = {
    openvl: 1,
    prompt: 1,
    knowledge: 1,
    skills: 1,
    plugins: 1,
    guides: 1,
    sessions: 1,
    trash: 1,
    workspaces: 1,
  };
  $('#nav-more-btn')?.classList.toggle('active', !!moreRoutes[next]);
  if (typeof refreshIcons === 'function') refreshIcons(document.getElementById('nav-tabs'));
  if (typeof closeNavMore === 'function') closeNavMore();
  $('#page-models')?.classList.toggle('hidden', next !== 'models');
  $('#page-agents')?.classList.toggle('hidden', next !== 'agents');
  $('#page-openvl')?.classList.toggle('hidden', next !== 'openvl');
  $('#page-dashboard')?.classList.toggle('hidden', next !== 'dashboard');
  $('#page-sessions')?.classList.toggle('hidden', next !== 'sessions');
  $('#page-usage')?.classList.toggle('hidden', next !== 'usage');
  $('#page-runtime')?.classList.toggle('hidden', next !== 'runtime');
  $('#page-search')?.classList.toggle('hidden', next !== 'search');
  $('#page-trash')?.classList.toggle('hidden', next !== 'trash');
  $('#page-guides')?.classList.toggle('hidden', next !== 'guides');
  ['prompt', 'skills', 'plugins', 'memory', 'knowledge', 'workspaces'].forEach((pg) => {
    $('#page-' + pg)?.classList.toggle('hidden', next !== pg);
  });
  if (next === 'guides') {
    if (typeof enterGuidesRoute === 'function') enterGuidesRoute(query.topic || query.t || '');
  } else if (next === 'dashboard' || next === 'sessions') {
    if (typeof enterDashRoute === 'function') enterDashRoute(next);
  } else if (next === 'usage') {
    if (typeof enterUsageRoute === 'function') enterUsageRoute();
  } else if (next === 'runtime') {
    if (typeof enterRuntimeRoute === 'function') enterRuntimeRoute();
  } else if (next === 'search') {
    if (typeof enterOpsRoute === 'function') enterOpsRoute(next);
  } else if (next === 'trash') {
    if (typeof enterTrashRoute === 'function') enterTrashRoute();
  } else if (next === 'models') {
    renderProviderList();
    // 支持 #/models?provider=xxx&model=yyy（总览「管理」直达默认供应商）
    const focusProvider =
      query.provider ||
      query.p ||
      state.pendingModelsProvider ||
      state.currentProviderId ||
      (state.defaults && state.defaults.defaultProvider) ||
      '';
    const focusModel =
      query.model ||
      query.m ||
      state.pendingModelsModel ||
      '';
    state.pendingModelsProvider = null;
    state.pendingModelsModel = null;
    if (focusProvider) {
      Promise.resolve(selectProvider(focusProvider, false)).then(() => {
        if (focusModel && typeof openModelEditor === 'function') {
          const models =
            (state.providerDetail && state.providerDetail.models) || [];
          if (models.some((m) => m && m.id === focusModel)) {
            openModelEditor(focusModel);
          }
        }
      });
    } else if (state.currentProviderId) {
      selectProvider(state.currentProviderId, false);
    } else {
      showProviderEmpty();
    }
  } else if (next === 'agents') {
    if (typeof loadWorkflowDocs === 'function') loadWorkflowDocs();
    renderAgentList();
    if (typeof renderWorkflowList === 'function') renderWorkflowList();
    if (state.agentPanel === 'workflow' && state.currentWorkflowId) {
      selectWorkflow(state.currentWorkflowId, false);
    } else if (state.currentAgentName) {
      selectAgent(state.currentAgentName, false);
    } else {
      showAgentEmpty();
    }
  } else if (next === 'openvl') {
    renderOpenvlList();
    if (state.openvlAvailable === false) showOpenvlEmpty();
    else if (state.openvlView === 'ollama') selectOpenvlOllama(false);
    else if (state.currentOpenvlId) selectOpenvlProfile(state.currentOpenvlId, false);
    else if (state.openvlActive) selectOpenvlProfile(state.openvlActive, false);
    else if (state.openvlProfiles[0]) selectOpenvlProfile(state.openvlProfiles[0].id, false);
    else showOpenvlEmpty();
  } else if (next === 'memory' || next === 'knowledge') {
    if (typeof enterContentPage === 'function') enterContentPage(next);
  } else if (typeof enterConsoleRoute === 'function') {
    enterConsoleRoute(next);
  }
  updateGlobalSaveUI();
}

// ── api / toast ─────────────────────────────────────────────────────────────

async function api(path, opts) {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  // 202 Accepted used by long-running install jobs
  if (!res.ok && res.status !== 202) throw new Error(data.error || 'HTTP ' + res.status);
  return data;
}

function showToast(msg, ok = true) {
  const el = document.createElement('div');
  el.className = 'toast ' + (ok ? 'toast-ok' : 'toast-err');
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 280);
  }, 2400);
}

function setDirty(kind, dirty) {
  const map = {
    models: ['modelsDirty', 'models-dirty'],
    agents: ['agentsDirty', 'agents-dirty'],
    workflow: ['workflowDirty', 'workflow-dirty'],
    openvl: ['openvlDirty', 'openvl-dirty'],
    prompt: ['promptDirty', 'prompt-dirty'],
    skills: ['skillsDirty', 'skills-dirty'],
    plugins: ['pluginsDirty', 'plugins-dirty'],
    memory: ['memDirty', 'mem-dirty'],
    knowledge: ['kbDirty', 'kb-dirty'],
    workspaces: ['wsDirty', 'ws-dirty'],
  };
  const entry = map[kind];
  if (entry) {
    state[entry[0]] = dirty;
    const el = document.getElementById(entry[1]);
    if (el) {
      el.textContent = dirty ? '已修改' : '已保存';
      el.className = 'status ' + (dirty ? 'dirty' : 'saved');
      // workflow 状态条默认 hidden，有打开规范时显示
      if (kind === 'workflow') el.classList.toggle('hidden', false);
    }
  } else {
    state.agentsDirty = dirty;
    const el = $('#agents-dirty');
    if (el) {
      el.textContent = dirty ? '已修改' : '已保存';
      el.className = 'status ' + (dirty ? 'dirty' : 'saved');
    }
  }
  // 顶栏 agents-dirty 与 workflow 同步提示
  if (kind === 'workflow' || kind === 'agents') {
    const ad = $('#agents-dirty');
    if (ad && state.agentPanel === 'workflow') {
      ad.textContent = state.workflowDirty ? '规范已修改' : '规范已保存';
      ad.className = 'status ' + (state.workflowDirty ? 'dirty' : 'saved');
    }
  }
  updateGlobalSaveUI();
}

function isAnyDirty() {
  return !!(
    state.modelsDirty ||
    state.agentsDirty ||
    state.workflowDirty ||
    state.openvlDirty ||
    state.promptDirty ||
    state.skillsDirty ||
    state.pluginsDirty ||
    state.wsDirty ||
    state.wsFileDirty ||
    state.memDirty ||
    state.kbDirty ||
    state.mem?.dirty ||
    state.kb?.dirty
  );
}

function updateGlobalSaveUI() {
  const dirty = isAnyDirty();
  const badge = $('#global-dirty');
  const btn = $('#global-save');
  if (badge) {
    if (dirty) {
      const parts = [];
      if (state.modelsDirty) parts.push('模型');
      if (state.agentsDirty) parts.push('子代理');
      if (state.openvlDirty) parts.push('识图');
      if (state.promptDirty) parts.push('提示词');
      if (state.skillsDirty) parts.push('Skills');
      if (state.pluginsDirty) parts.push('插件');
      if (state.memDirty || state.mem?.dirty) parts.push('记忆');
      if (state.kbDirty || state.kb?.dirty) parts.push('知识库');
      if (state.wsDirty || state.wsFileDirty) parts.push('工作区');
      badge.textContent = '未保存 · ' + parts.join('+');
      badge.className = 'status dirty shell-dirty';
    } else {
      badge.textContent = '已保存';
      badge.className = 'status saved shell-dirty';
    }
  }
  if (btn) {
    btn.disabled = !dirty;
    btn.classList.toggle('pulse', dirty);
    // 保留图标结构，只改 .btn-label（壳 class 钩子）
    const label = btn.querySelector('.btn-label');
    const text = dirty ? '保存' : '已保存';
    if (label) {
      label.textContent = text;
    } else {
      btn.innerHTML = '<i data-lucide="save"></i><span class="btn-label">' + text + '</span>';
      if (typeof refreshIcons === 'function') refreshIcons();
    }
  }
}

/**
 * 顶栏全局保存。
 * - Agents 页：保存当前 Agent
 * - 模型页：若供应商+模型都打开，两者都存（先供应商后模型）；只开一个就存一个
 * 注意 modelsDirty 是共享标记，所以「两者都开」时必须都调用保存，不能看中间 dirty 状态。
 */
async function globalSave() {
  try {
    if (state.route === 'agents') {
      // 工作流规范优先（当前面板）
      if (state.agentPanel === 'workflow') {
        if ($('#workflow-editor')?.classList.contains('hidden')) {
          showToast('没有打开的规范可保存', false);
          return false;
        }
        if (!state.workflowDirty) {
          showToast('没有需要保存的修改');
          return true;
        }
        await saveWorkflowDoc();
        updateGlobalSaveUI();
        return !state.workflowDirty;
      }
      if ($('#agent-editor')?.classList.contains('hidden')) {
        showToast('没有打开的子代理可保存', false);
        return false;
      }
      if (!state.agentsDirty) {
        showToast('没有需要保存的修改');
        return true;
      }
      await saveAgent();
      updateGlobalSaveUI();
      return !state.agentsDirty;
    }

    if (state.route === 'openvl') {
      if (state.openvlView === 'ollama') {
        if (!state.openvlDirty) {
          showToast('没有需要保存的修改');
          return true;
        }
        await saveOpenvlOllama();
        updateGlobalSaveUI();
        return !state.openvlDirty;
      }
      if ($('#openvl-editor')?.classList.contains('hidden')) {
        showToast('没有打开的识图配置可保存', false);
        return false;
      }
      if (!state.openvlDirty) {
        showToast('没有需要保存的修改');
        return true;
      }
      await saveOpenvlProfile();
      updateGlobalSaveUI();
      return !state.openvlDirty;
    }

    if (['memory', 'knowledge'].includes(state.route)) {
      if (typeof contentGlobalSave === 'function') {
        const ok = await contentGlobalSave(state.route);
        updateGlobalSaveUI();
        return ok;
      }
    }

    if (['prompt', 'skills', 'plugins', 'workspaces'].includes(state.route)) {
      if (typeof consoleGlobalSave === 'function') {
        const ok = await consoleGlobalSave(state.route);
        updateGlobalSaveUI();
        return ok;
      }
    }

    const modelOpen =
      !$('#model-editor').classList.contains('hidden') && !!state.selectedModelId;
    const providerOpen = !$('#provider-editor').classList.contains('hidden');

    if (!modelOpen && !providerOpen) {
      showToast('没有打开的供应商/模型可保存', false);
      return false;
    }
    if (!state.modelsDirty) {
      showToast('没有需要保存的修改');
      return true;
    }

    // 先供应商（新建供应商时模型依赖它），再模型
    if (providerOpen) await saveProvider();
    if (modelOpen) {
      const mid = ($('#m-id').value || '').trim();
      // 新建模型还没填 ID 时跳过，避免只改供应商时被模型校验挡住
      if (mid) await saveModel();
    }

    updateGlobalSaveUI();
    return !state.modelsDirty;
  } catch (e) {
    showToast('保存失败: ' + e.message, false);
    return false;
  }
}

function bindGlobalSave() {
  $('#global-save')?.addEventListener('click', () => {
    globalSave();
  });

  // 统一 Ctrl/Cmd+S
  document.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (!mod || e.key.toLowerCase() !== 's') return;
    e.preventDefault();
    globalSave();
  });

  // 关页/刷新拦截
  window.addEventListener('beforeunload', (e) => {
    if (!isAnyDirty()) return;
    e.preventDefault();
    e.returnValue = '';
  });

  updateGlobalSaveUI();
}

function parseJsonField(text, label) {
  const t = (text || '').trim();
  if (!t) return undefined;
  try {
    return JSON.parse(t);
  } catch (e) {
    throw new Error(label + ' JSON 无效: ' + e.message);
  }
}

// ── shared loaders ──────────────────────────────────────────────────────────

async function loadMeta() {
  try {
    state.meta = await api('/api/meta');
    const el = $('#header-meta');
    // 顶栏不展示本机路径；仅保留 title 供悬停排查（元素本身 CSS 隐藏）
    if (el) el.textContent = '';
    el.title =
      'models: ' +
      (state.meta.modelsFile || '') +
      '\nsettings: ' +
      (state.meta.settingsFile || '') +
      '\nagents: ' +
      (state.meta.agentsDir || '') +
      '\nopenvl: ' +
      (state.meta.openvlProfilesFile || '') +
      '\nprompt: ' +
      (state.meta.agentsMdFile || '') +
      '\nmanager: ' +
      (state.meta.managerConfigFile || '');
  } catch {
    /* ignore */
  }
}

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
      setDirty('models', true);
    });
    custom.addEventListener('input', () => setDirty('models', true));
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
  setDirty('models', true);
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

// ── tool permissions UI ─────────────────────────────────────────────────────

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

// ── defaults bar ────────────────────────────────────────────────────────────

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
    if (document.activeElement === $('#p-apiKey')) {
      // 用户改了输入框：不再视为「保持原值」
      state.keepApiKey = false;
      state.keyIsPlaceholder = false;
    }
    setDirty('models', true);
  });
  $('#p-apiKey')?.addEventListener('focus', () => {
    // 点进圆点占位时清空，方便直接输入新 key
    if (state.keyIsPlaceholder && !state.keyVisible) {
      $('#p-apiKey').value = '';
      state.keyIsPlaceholder = false;
      state.keepApiKey = false;
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
  $('#model-form').addEventListener('input', () => setDirty('models', true));
  $('#m-cost-zero')?.addEventListener('click', () => {
    ['#m-cost-input', '#m-cost-output', '#m-cost-cacheRead', '#m-cost-cacheWrite'].forEach(
      (id) => ($(id).value = '0')
    );
    setDirty('models', true);
  });
  $('#m-tlm-clear')?.addEventListener('click', clearTlmForm);
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

async function selectProvider(id, confirmLeave) {
  if (
    confirmLeave &&
    state.modelsDirty &&
    state.currentProviderId &&
    state.currentProviderId !== id &&
    !confirm('有未保存修改，切换？')
  ) {
    return;
  }
  try {
    state.providerDetail = await api('/api/providers/' + encodeURIComponent(id));
  } catch (e) {
    showToast('读取失败: ' + e.message, false);
    return;
  }
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
  if (state.modelsDirty && !confirm('有未保存修改，继续新建？')) return;
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
      return '<option value="' + esc(id) + '">' + esc(id) + '</option>';
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

function openModelEditor(modelId) {
  if (!state.currentProviderId && !state.providerDetail) {
    return showToast('请先保存供应商', false);
  }
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
  try {
    const id = $('#p-id').value.trim();
    if (!id) return showToast('供应商 ID 不能为空', false);
    if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(id)) {
      return showToast('ID 仅限字母数字 _ . -', false);
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
    state.keepApiKey = true;
    fillProviderForm(result);
    renderModelTable();
    $('#p-title').textContent = result.id;
    setDirty('models', false);
    showToast('供应商已保存');
    await loadProviders();
    await loadFlatModels();
    renderProviderList();
  } catch (e) {
    showToast('保存失败: ' + e.message, false);
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
  if (!state.currentProviderId) return showToast('请先保存供应商', false);
  try {
    const modelId = $('#m-id').value.trim();
    if (!modelId) return showToast('Model ID 不能为空', false);
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
    openModelEditor(result.model.id);
    setDirty('models', false);
    showToast('模型已保存');
    await loadProviders();
    await loadFlatModels();
    renderProviderList();
  } catch (e) {
    showToast('保存模型失败: ' + e.message, false);
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
    setDirty('models', false);
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
    '<p class="muted" id="provider-test-modal-desc">选择一个已添加的模型，向当前 Base URL 发送最小请求。</p>' +
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
      st.textContent = r.ok
        ? '检测通过 ✓ ' + (r.message || ('HTTP ' + (r.status || ''))) + md + ep
        : '检测失败: ' + (r.error || r.message || 'unknown') + md + ep;
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

// ── agents UI ───────────────────────────────────────────────────────────────

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
  const next = mode === 'preview' || mode === 'split' ? mode : 'edit';
  state.workflowMode = next;
  const view = $('#wf-view');
  if (view) {
    view.classList.remove('mode-edit', 'mode-preview', 'mode-split');
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
    // compose 后 model 为完整 spec（provider/id:high）；thinking 空串由后端删独立字段
    const payload = {
      name: $('#a-name').value.trim(),
      description: $('#a-description').value,
      category: $('#a-category').value,
      tools: $('#a-tools').value,
      model: composeModelSpec(pureModel, thinking),
      thinking: '',
      prompt: $('#a-prompt').value,
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

// ── openvl UI ───────────────────────────────────────────────────────────────

async function loadOpenvl() {
  try {
    const data = await api('/api/openvl/profiles');
    state.openvlAvailable = data.available !== false;
    state.openvlProfiles = data.profiles || [];
    state.openvlActive = data.active || null;
    state.openvlOllama = data.ollama || { url: '', model: '', backend: 'ollama' };
    state.openvlPaths = data.paths || {};
    state.openvlHint = data.hint || '';
  } catch (e) {
    state.openvlAvailable = false;
    state.openvlProfiles = [];
    state.openvlHint = e.message || String(e);
    console.warn('loadOpenvl failed', e);
  }
  if (typeof updateCapabilityHints === 'function') updateCapabilityHints();
}

function bindOpenvlUI() {
  $('#openvl-new')?.addEventListener('click', () => createOpenvlProfile());
  $('#openvl-clone')?.addEventListener('click', () => cloneOpenvlProfile());
  $('#openvl-save')?.addEventListener('click', () => saveOpenvlProfile());
  $('#openvl-delete')?.addEventListener('click', () => deleteOpenvlProfile());
  $('#openvl-activate')?.addEventListener('click', () => activateOpenvlProfile());
  $('#openvl-test')?.addEventListener('click', () => testOpenvlApi());
  $('#ov-toggle-key')?.addEventListener('click', () => toggleOpenvlKey());
  $('#ov-model-add')?.addEventListener('click', () => addOpenvlModel());
  $('#ov-model-detect')?.addEventListener('click', () => fetchOpenvlModels());
  $('#ov-remote-close')?.addEventListener('click', () => {
    $('#ov-remote-models-panel')?.classList.add('hidden');
  });
  $('#ov-remote-import-new')?.addEventListener('click', () => importOpenvlRemoteModels('new'));
  $('#ov-remote-import-sel')?.addEventListener('click', () => importOpenvlRemoteModels('selected'));
  $('#ov-remote-select-new')?.addEventListener('click', () => selectOpenvlRemote('new'));
  $('#ov-remote-select-none')?.addEventListener('click', () => selectOpenvlRemote('none'));
  $('#ov-remote-filter')?.addEventListener('input', (e) => {
    state.openvlRemoteFilter = e.target.value || '';
    renderOpenvlRemoteModelsList();
  });
  $('#ov-remote-hide-local')?.addEventListener('change', (e) => {
    state.openvlRemoteHideLocal = !!e.target.checked;
    renderOpenvlRemoteModelsList();
  });
  $('#ov-model')?.addEventListener('change', () => setDirty('openvl', true));
  $('#openvl-form')?.addEventListener('input', (e) => {
    if (e.target && e.target.id === 'ov-apiKey') {
      state.openvlKeepKey = false;
      state.openvlKeyPlaceholder = false;
    }
    setDirty('openvl', true);
  });
  $('#ov-apiKey')?.addEventListener('focus', () => {
    if (state.openvlKeyPlaceholder && !state.openvlKeyVisible) {
      $('#ov-apiKey').value = '';
      state.openvlKeyPlaceholder = false;
      state.openvlKeepKey = false;
    }
  });
  $('#openvl-form')?.addEventListener('change', () => setDirty('openvl', true));
  $('#openvl-ollama-item')?.addEventListener('click', () => selectOpenvlOllama(true));
  $('#openvl-ollama-save')?.addEventListener('click', () => saveOpenvlOllama());
  $('#openvl-ollama-check')?.addEventListener('click', () => checkOpenvlOllama());
  $('#openvl-ollama-form')?.addEventListener('input', () => setDirty('openvl', true));
  $('#ov-backend')?.addEventListener('change', () => {
    const v = $('#ov-backend').value;
    if (v === 'llamacpp') {
      if (!$('#ov-ollama-url').value || $('#ov-ollama-url').value.includes('11434')) {
        $('#ov-ollama-url').value = 'http://127.0.0.1:8080';
      }
      if (!$('#ov-ollama-model').value || $('#ov-ollama-model').value.includes('minicpm')) {
        $('#ov-ollama-model').value = 'MiniCPM-V-4.6-Q4_K_M.gguf';
      }
    } else if (!$('#ov-ollama-url').value || $('#ov-ollama-url').value.includes('8080')) {
      $('#ov-ollama-url').value = 'http://127.0.0.1:11434';
    }
    setDirty('openvl', true);
  });
}

function renderOpenvlList() {
  const box = $('#openvl-list');
  if (!box) return;
  box.innerHTML = '';
  if (state.openvlAvailable === false) {
    const empty = document.createElement('div');
    empty.className = 'side-list-empty';
    empty.textContent = '未安装识图组件';
    box.appendChild(empty);
  } else if (!state.openvlProfiles.length) {
    const empty = document.createElement('div');
    empty.className = 'side-list-empty';
    empty.textContent = '暂无配置';
    box.appendChild(empty);
  }
  state.openvlProfiles.forEach((p) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className =
      'side-item' +
      (state.openvlView === 'profile' && state.currentOpenvlId === p.id ? ' active' : '');
    btn.innerHTML =
      '<div class="si-title">' +
      esc(p.name || p.id) +
      '</div>' +
      '<div class="si-sub">' +
      esc(p.model || p.api_base || '未配置模型') +
      '</div>' +
      '<div class="si-tags">' +
      (p.active ? '<span class="badge ok">当前</span>' : '') +
      (p.hasKey ? '<span class="badge accent">key</span>' : '<span class="badge warn">无 key</span>') +
      '</div>';
    btn.addEventListener('click', () => selectOpenvlProfile(p.id, true));
    box.appendChild(btn);
  });
  const oItem = $('#openvl-ollama-item');
  if (oItem) oItem.classList.toggle('active', state.openvlView === 'ollama');
}

function showOpenvlEmpty() {
  state.currentOpenvlId = null;
  state.openvlDetail = null;
  state.openvlView = 'profile';
  $('#openvl-empty')?.classList.remove('hidden');
  $('#openvl-editor')?.classList.add('hidden');
  $('#openvl-ollama-editor')?.classList.add('hidden');
  const msg = $('#openvl-empty-msg');
  if (msg) {
    if (state.openvlAvailable === false) {
      msg.innerHTML =
        '<div class="empty-fallback">' +
        '<p class="empty-kicker">本页需要额外组件</p>' +
        '<p class="empty-title">还不能用识图</p>' +
        '<p class="empty-desc"><strong>原因：</strong>本机没找到 OpenVL（识图工具）。</p>' +
        '<p class="empty-desc"><strong>影响：</strong>只有本页不可用；模型、子代理、提示词等照常。</p>' +
        '<p class="empty-desc"><strong>若要启用：</strong>' +
        esc(state.openvlHint || '终端执行 npm install -g @scp3500/openvl，或设置 OPENVL_PKG_DIR 指向安装目录，然后刷新本页。') +
        '</p>' +
        '<div class="empty-actions">' +
        '<a class="btn primary sm" href="#/guides?topic=openvl">查看识图教程</a>' +
        '<a class="btn ghost sm" href="https://www.npmjs.com/package/@scp3500/openvl" target="_blank" rel="noopener noreferrer">npm 安装</a>' +
        '<a class="btn ghost sm" href="#/models">去模型</a>' +
        '</div></div>';
    } else {
      msg.innerHTML =
        '<p>选择左侧配置，或新建一个</p>' +
        '<p class="page-hint-inline">日常用云端 profile；本地备用已折叠在侧栏高级区</p>' +
        '<div class="empty-actions">' +
        '<a class="btn primary sm" href="#/guides?topic=openvl">查看识图教程</a>' +
        '</div>';
    }
  }
  // 未安装时禁用写操作按钮
  const disabled = state.openvlAvailable === false;
  ['openvl-new', 'openvl-clone', 'openvl-save', 'openvl-delete', 'openvl-activate', 'openvl-test'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.disabled = disabled;
  });
  renderOpenvlList();
}

async function selectOpenvlProfile(id, confirmLeave) {
  if (
    confirmLeave &&
    state.openvlDirty &&
    ((state.openvlView === 'profile' && state.currentOpenvlId && state.currentOpenvlId !== id) ||
      state.openvlView === 'ollama') &&
    !confirm('有未保存修改，切换？')
  ) {
    return;
  }
  try {
    const p = state.openvlProfiles.find((x) => x.id === id);
    if (!p) throw new Error('not found');
    state.openvlView = 'profile';
    state.currentOpenvlId = id;
    state.openvlDetail = p;
    state.openvlModels = Array.isArray(p.models) ? p.models.slice() : [];
    if (p.model && !state.openvlModels.includes(p.model)) state.openvlModels.unshift(p.model);
    fillOpenvlForm(p);
    $('#openvl-empty')?.classList.add('hidden');
    $('#openvl-editor')?.classList.remove('hidden');
    $('#openvl-ollama-editor')?.classList.add('hidden');
    $('#ov-title').textContent = p.name || id;
    ['openvl-new', 'openvl-clone', 'openvl-save', 'openvl-delete', 'openvl-activate', 'openvl-test'].forEach((id2) => {
      const el = document.getElementById(id2);
      if (el) el.disabled = false;
    });
    setDirty('openvl', false);
    renderOpenvlList();
  } catch (e) {
    showToast('读取识图配置失败: ' + e.message, false);
  }
}

function selectOpenvlOllama(confirmLeave) {
  if (
    confirmLeave &&
    state.openvlDirty &&
    state.openvlView !== 'ollama' &&
    !confirm('有未保存修改，切换？')
  ) {
    return;
  }
  state.openvlView = 'ollama';
  state.currentOpenvlId = null;
  $('#openvl-empty')?.classList.add('hidden');
  $('#openvl-editor')?.classList.add('hidden');
  $('#openvl-ollama-editor')?.classList.remove('hidden');
  const o = state.openvlOllama || {};
  $('#ov-backend').value = o.backend || 'ollama';
  $('#ov-ollama-url').value = o.url || 'http://127.0.0.1:11434';
  $('#ov-ollama-model').value = o.model || 'openbmb/minicpm-v4.6';
  const st = $('#ov-ollama-status');
  if (st) {
    st.textContent = '未检查';
    st.className = 'hint-block';
  }
  setDirty('openvl', false);
  renderOpenvlList();
}

function fillOpenvlForm(p) {
  const hasKey = !!(p.hasKey || (p.apiKey && String(p.apiKey).length));
  state.openvlKeepKey = hasKey;
  state.openvlKeyVisible = false;
  state.openvlKeyPlaceholder = hasKey;
  state.openvlStoredKey = hasKey ? String(p.apiKey || '') : '';
  $('#ov-name').value = p.name || '';
  $('#ov-active-label').value = p.active ? '当前生效（已同步 config.env）' : '未激活';
  $('#ov-apiKey').type = 'password';
  if (hasKey) {
    const len = state.openvlStoredKey ? state.openvlStoredKey.length : 12;
    $('#ov-apiKey').value = maskDots(len);
    $('#ov-apiKey').placeholder = '';
  } else {
    $('#ov-apiKey').value = '';
    $('#ov-apiKey').placeholder = 'sk-…';
  }
  $('#ov-toggle-key').textContent = '显示';
  $('#ov-apiBase').value = p.api_base || '';
  $('#ov-api-type').value = p.apiType || '';
  renderOpenvlModels(p.model || '');
  const paths = state.openvlPaths || {};
  $('#ov-paths').textContent =
    'profiles: ' +
    (paths.profilesFile || state.meta.openvlProfilesFile || '') +
    '\nenv: ' +
    (paths.envFile || state.meta.openvlEnvFile || '') +
    (paths.mirrors && paths.mirrors.length
      ? '\nmirrors:\n  ' + paths.mirrors.join('\n  ')
      : '');
  const st = $('#openvl-status');
  if (st) {
    st.className = 'hint-block' + (p.active ? ' ok' : '');
    st.textContent = p.active
      ? '此配置当前生效，保存后会同步到 config.env'
      : '此配置未激活。保存只改 profiles；点「设为当前」才会写 config.env';
  }
}

function renderOpenvlModels(current) {
  const sel = $('#ov-model');
  const tags = $('#ov-model-tags');
  const models = state.openvlModels || [];
  if (sel) {
    sel.innerHTML = '';
    if (!models.length) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = '(无模型)';
      sel.appendChild(opt);
    } else {
      models.forEach((m) => {
        const opt = document.createElement('option');
        opt.value = m;
        opt.textContent = m;
        if (m === current) opt.selected = true;
        sel.appendChild(opt);
      });
      if (current && !models.includes(current) && models.length) sel.value = models[0];
    }
  }
  if (tags) {
    tags.innerHTML = '';
    const cur = current || (sel && sel.value) || '';
    models.forEach((m) => {
      const span = document.createElement('span');
      span.className = 'ov-tag' + (m === cur ? ' active' : '');
      span.appendChild(document.createTextNode(m + ' '));
      span.addEventListener('click', () => {
        if (sel) sel.value = m;
        renderOpenvlModels(m);
        setDirty('openvl', true);
      });
      const x = document.createElement('span');
      x.className = 'x';
      x.textContent = '×';
      x.title = '删除 ' + m;
      x.addEventListener('click', (e) => {
        e.stopPropagation();
        removeOpenvlModel(m);
      });
      span.appendChild(x);
      tags.appendChild(span);
    });
  }
  const cnt = $('#ov-models-count');
  if (cnt) cnt.textContent = String(models.length);
}

function addOpenvlModel() {
  const input = $('#ov-model-new');
  const m = (input?.value || '').trim();
  if (!m) {
    showToast('输入模型名', false);
    return;
  }
  if (!state.openvlModels.includes(m)) state.openvlModels.push(m);
  if (input) input.value = '';
  renderOpenvlModels(m);
  setDirty('openvl', true);
}

function removeOpenvlModel(m) {
  if (state.openvlModels.length <= 1) {
    showToast('至少保留一个模型', false);
    return;
  }
  state.openvlModels = state.openvlModels.filter((x) => x !== m);
  const cur = $('#ov-model')?.value;
  renderOpenvlModels(cur === m ? state.openvlModels[0] : cur);
  setDirty('openvl', true);
}

function toggleOpenvlKey() {
  const inp = $('#ov-apiKey');
  if (!inp) return;
  if (!state.openvlKeyVisible) {
    state.openvlKeyVisible = true;
    inp.type = 'text';
    $('#ov-toggle-key').textContent = '隐藏';
    if (state.openvlKeyPlaceholder) {
      inp.value = state.openvlStoredKey || '';
      state.openvlKeyPlaceholder = false;
      state.openvlKeepKey = true;
    }
  } else {
    state.openvlKeyVisible = false;
    inp.type = 'password';
    $('#ov-toggle-key').textContent = '显示';
    if (
      state.openvlKeepKey &&
      state.openvlStoredKey &&
      inp.value === state.openvlStoredKey
    ) {
      inp.value = maskDots(state.openvlStoredKey ? state.openvlStoredKey.length : 12);
      state.openvlKeyPlaceholder = true;
    } else if (state.openvlKeepKey && !inp.value && state.openvlStoredKey) {
      inp.value = maskDots(state.openvlStoredKey.length);
      state.openvlKeyPlaceholder = true;
    }
  }
}

async function saveOpenvlProfile() {
  if (!state.currentOpenvlId) {
    showToast('没有选中的配置', false);
    return;
  }
  try {
    const body = {
      name: ($('#ov-name').value || '').trim(),
      api_base: ($('#ov-apiBase').value || '').trim(),
      api_type: ($('#ov-api-type').value || '').trim(),
      model: ($('#ov-model').value || '').trim(),
      models: state.openvlModels.slice(),
    };
    const keyVal = ($('#ov-apiKey').value || '').trim();
    if (
      state.openvlKeyPlaceholder ||
      isKeyMaskValue(keyVal) ||
      (state.openvlKeepKey &&
        (keyVal === '' || keyVal === state.openvlStoredKey))
    ) {
      body.api_key = '__KEEP__';
    } else {
      body.api_key = keyVal;
    }

    await api('/api/openvl/profiles/' + encodeURIComponent(state.currentOpenvlId), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    await loadOpenvl();
    await selectOpenvlProfile(state.currentOpenvlId, false);
    setDirty('openvl', false);
    showToast('识图配置已保存');
  } catch (e) {
    showToast('保存失败: ' + e.message, false);
    throw e;
  }
}

async function createOpenvlProfile() {
  if (state.openvlDirty && !confirm('有未保存修改，继续新建？')) return;
  const name = prompt('新配置名称:', '新配置');
  if (!name) return;
  try {
    const p = await api('/api/openvl/profiles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    await loadOpenvl();
    await selectOpenvlProfile(p.id, false);
    showToast('已创建: ' + name);
  } catch (e) {
    showToast('创建失败: ' + e.message, false);
  }
}

async function cloneOpenvlProfile() {
  if (!state.currentOpenvlId) {
    showToast('先选择一个配置', false);
    return;
  }
  const src = state.openvlProfiles.find((x) => x.id === state.currentOpenvlId);
  if (!src) return;
  const name = prompt('复制为:', (src.name || src.id) + ' (复制)');
  if (!name) return;
  try {
    let key = '';
    try {
      const full = await api(
        '/api/openvl/profiles/' + encodeURIComponent(src.id) + '?reveal=1'
      );
      key = full.apiKey || '';
    } catch {
      /* ignore */
    }
    const p = await api('/api/openvl/profiles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        api_key: key,
        api_base: src.api_base || '',
        model: src.model || '',
        models: src.models || [],
      }),
    });
    await loadOpenvl();
    await selectOpenvlProfile(p.id, false);
    showToast('已复制: ' + name);
  } catch (e) {
    showToast('复制失败: ' + e.message, false);
  }
}

async function activateOpenvlProfile() {
  if (!state.currentOpenvlId) return;
  if (state.openvlDirty) {
    const ok = confirm('有未保存修改。先保存再设为当前？');
    if (ok) await saveOpenvlProfile();
  }
  try {
    await api('/api/openvl/profiles/switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: state.currentOpenvlId }),
    });
    await loadOpenvl();
    await selectOpenvlProfile(state.currentOpenvlId, false);
    showToast('已设为当前配置并同步 config.env');
  } catch (e) {
    showToast('切换失败: ' + e.message, false);
  }
}

async function deleteOpenvlProfile() {
  if (!state.currentOpenvlId) return;
  if (state.openvlProfiles.length <= 1) {
    showToast('至少保留一个配置', false);
    return;
  }
  const p = state.openvlProfiles.find((x) => x.id === state.currentOpenvlId);
  if (!confirm('删除配置 "' + (p?.name || state.currentOpenvlId) + '"？')) return;
  try {
    const data = await api('/api/openvl/profiles/' + encodeURIComponent(state.currentOpenvlId), {
      method: 'DELETE',
    });
    await loadOpenvl();
    const next = data.active || (state.openvlProfiles[0] && state.openvlProfiles[0].id);
    if (next) await selectOpenvlProfile(next, false);
    else showOpenvlEmpty();
    showToast('已删除');
  } catch (e) {
    showToast('删除失败: ' + e.message, false);
  }
}

async function testOpenvlApi() {
  const st = $('#openvl-status');
  const btn = $('#openvl-test');
  if (!state.currentOpenvlId) return showToast('请先选择配置', false);
  if (btn) {
    btn.disabled = true;
    btn.textContent = '检测中…';
  }
  if (st) {
    st.className = 'hint-block warn';
    st.textContent = '正在检测…（使用当前表单里的地址 / Key / 模型）';
  }
  try {
    let apiKey = ($('#ov-apiKey')?.value || '').trim();
    if (state.openvlKeyPlaceholder || isKeyMaskValue(apiKey) || (state.openvlKeepKey && !apiKey)) {
      apiKey = '__KEEP__';
    }
    const body = {
      id: state.currentOpenvlId,
      api_base: ($('#ov-apiBase')?.value || '').trim() || undefined,
      api_key: apiKey || undefined,
      model: ($('#ov-model')?.value || '').trim() || undefined,
    };
    const r = await api('/api/openvl/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (st) {
      st.className = 'hint-block ' + (r.ok ? 'ok' : 'err');
      const ep = r.endpoint ? ' · ' + r.endpoint : '';
      st.textContent = r.ok
        ? '检测通过 ✓ ' + (r.message || ('HTTP ' + (r.status || ''))) + ep
        : '检测失败: ' + (r.error || r.message || 'unknown') + ep;
    }
    showToast(
      r.ok ? '检测通过' : '检测失败: ' + (r.error || r.message || ''),
      r.ok
    );
  } catch (e) {
    if (st) {
      st.className = 'hint-block err';
      st.textContent = '检测失败: ' + e.message;
    }
    showToast('检测失败: ' + e.message, false);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '检测';
    }
  }
}

function filteredOpenvlRemoteModels() {
  let list = state.openvlRemoteModels || [];
  if (state.openvlRemoteHideLocal) list = list.filter((m) => !m.local);
  const q = (state.openvlRemoteFilter || '').trim().toLowerCase();
  if (!q) return list;
  return list.filter(
    (m) =>
      m.id.toLowerCase().includes(q) || (m.name || '').toLowerCase().includes(q)
  );
}

function renderOpenvlRemoteModelsList() {
  const box = $('#ov-remote-models-list');
  if (!box) return;
  const list = filteredOpenvlRemoteModels();
  if (!list.length) {
    box.innerHTML =
      '<div class="remote-empty">' +
      ((state.openvlRemoteModels || []).length ? '无匹配项' : '暂无结果，点「获取模型」') +
      '</div>';
    return;
  }
  box.innerHTML = list
    .map((m) => {
      const checked = state.openvlRemoteSelected?.has(m.id) ? ' checked' : '';
      return (
        '<label class="ov-fetch-item' +
        (m.local ? ' is-local' : '') +
        '">' +
        '<input type="checkbox" class="ov-remote-check" data-id="' +
        esc(m.id) +
        '"' +
        checked +
        (m.local ? ' disabled' : '') +
        '>' +
        '<div class="ov-fetch-main">' +
        '<div class="ov-fetch-id mono">' +
        esc(m.id) +
        '</div>' +
        (m.name && m.name !== m.id
          ? '<div class="ov-fetch-sub">' + esc(m.name) + '</div>'
          : '') +
        '</div>' +
        (m.local
          ? '<span class="badge ok">已有</span>'
          : '<span class="badge accent">新</span>') +
        '</label>'
      );
    })
    .join('');
  box.querySelectorAll('.ov-remote-check').forEach((el) => {
    el.addEventListener('change', () => {
      if (!state.openvlRemoteSelected) state.openvlRemoteSelected = new Set();
      if (el.checked) state.openvlRemoteSelected.add(el.dataset.id);
      else state.openvlRemoteSelected.delete(el.dataset.id);
    });
  });
}

function selectOpenvlRemote(mode) {
  const list = state.openvlRemoteModels || [];
  if (!state.openvlRemoteSelected) state.openvlRemoteSelected = new Set();
  if (mode === 'none') state.openvlRemoteSelected = new Set();
  else if (mode === 'new') {
    state.openvlRemoteSelected = new Set(list.filter((m) => !m.local).map((m) => m.id));
  }
  renderOpenvlRemoteModelsList();
}

async function fetchOpenvlModels() {
  if (!state.currentOpenvlId) return showToast('请先选择配置', false);
  const btn = $('#ov-model-detect');
  const st = $('#openvl-status');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '获取中…';
  }
  if (st) {
    st.className = 'hint-block warn';
    st.textContent = '正在获取模型列表…';
  }
  try {
    let apiKey = ($('#ov-apiKey')?.value || '').trim();
    if (state.openvlKeyPlaceholder || isKeyMaskValue(apiKey)) apiKey = '__KEEP__';
    if (!apiKey && state.openvlKeepKey) apiKey = '__KEEP__';
    const body = {
      id: state.currentOpenvlId,
      api_base: ($('#ov-apiBase')?.value || '').trim() || undefined,
      api_key: apiKey || undefined,
    };
    const data = await api('/api/openvl/remote-models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    state.openvlRemoteModels = data.models || [];
    state.openvlRemoteFilter = '';
    state.openvlRemoteHideLocal = false;
    if ($('#ov-remote-filter')) $('#ov-remote-filter').value = '';
    if ($('#ov-remote-hide-local')) $('#ov-remote-hide-local').checked = false;
    // 默认全不选，避免误导入
    state.openvlRemoteSelected = new Set();
    const panel = $('#ov-remote-models-panel');
    panel?.classList.remove('hidden');
    const meta = $('#ov-remote-meta');
    if (meta) {
      const localN = state.openvlRemoteModels.filter((m) => m.local).length;
      const newN = state.openvlRemoteModels.length - localN;
      meta.textContent =
        state.openvlRemoteModels.length +
        ' 个 · 新 ' +
        newN +
        (localN ? ' · 已有 ' + localN : '') +
        (data.url ? ' · ' + data.url : '');
    }
    renderOpenvlRemoteModelsList();
    if (st) {
      st.className = 'hint-block ok';
      st.textContent =
        '已获取 ' +
        state.openvlRemoteModels.length +
        ' 个模型' +
        (data.url ? '（' + data.url + '）' : '') +
        '。勾选后点「导入勾选」，再保存配置。';
    }
    showToast('获取到 ' + state.openvlRemoteModels.length + ' 个模型');
  } catch (e) {
    if (st) {
      st.className = 'hint-block err';
      st.textContent = '获取模型失败: ' + e.message;
    }
    showToast('获取失败: ' + e.message, false);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '获取模型';
    }
  }
}

function importOpenvlRemoteModels(mode) {
  const list = state.openvlRemoteModels || [];
  if (!list.length) return showToast('没有可导入的模型', false);
  let ids = [];
  if (mode === 'new') {
    ids = list.filter((m) => !m.local).map((m) => m.id);
  } else {
    // selected
    ids = list
      .filter((m) => state.openvlRemoteSelected?.has(m.id) && !m.local)
      .map((m) => m.id);
  }
  if (!ids.length) {
    return showToast(
      mode === 'new' ? '没有新的模型可导入' : '请先勾选要导入的新模型',
      false
    );
  }
  const set = new Set(state.openvlModels || []);
  let added = 0;
  ids.forEach((id) => {
    if (!set.has(id)) {
      set.add(id);
      added++;
    }
  });
  state.openvlModels = [...set];
  renderOpenvlModels();
  setDirty('openvl', true);
  state.openvlRemoteModels = list.map((m) => ({
    ...m,
    local: set.has(m.id),
  }));
  state.openvlRemoteSelected = new Set(
    state.openvlRemoteModels.filter((m) => !m.local).map((m) => m.id)
  );
  renderOpenvlRemoteModelsList();
  const st = $('#openvl-status');
  if (st) {
    st.className = 'hint-block ' + (added ? 'ok' : 'warn');
    st.textContent = added
      ? '已加入 ' + added + ' 个模型到列表，请点右上角「保存」写入配置。'
      : '没有新增（可能都已在列表中）。';
  }
  showToast(added ? '已加入 ' + added + ' 个，记得保存' : '没有新增');
}

async function saveOpenvlOllama() {
  try {
    const body = {
      backend: $('#ov-backend').value,
      url: ($('#ov-ollama-url').value || '').trim(),
      model: ($('#ov-ollama-model').value || '').trim(),
    };
    state.openvlOllama = await api('/api/openvl/ollama', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    setDirty('openvl', false);
    showToast('本地备用配置已保存');
  } catch (e) {
    showToast('保存失败: ' + e.message, false);
    throw e;
  }
}

async function checkOpenvlOllama() {
  const st = $('#ov-ollama-status');
  if (st) st.textContent = '检查中…';
  try {
    const r = await api('/api/openvl/ollama/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: ($('#ov-ollama-url').value || '').trim(),
        backend: $('#ov-backend').value,
      }),
    });
    if (st) {
      st.textContent = r.ok
        ? '连接正常 · ' + (r.version || '') + (r.models && r.models[0] ? ' · ' + r.models[0] : '')
        : '失败: ' + (r.error || 'unknown');
      st.className = 'hint-block ' + (r.ok ? 'ok' : 'err');
    }
    showToast(r.ok ? '本地服务在线' : '本地服务离线', r.ok);
  } catch (e) {
    if (st) {
      st.textContent = '请求失败: ' + e.message;
      st.className = 'hint-block err';
    }
  }
}
