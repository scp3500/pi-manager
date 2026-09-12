const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
window.$ = $;
window.$$ = $$;

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

const TLM_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const AGENT_TASK_TYPES = ['planning', 'analysis', 'explore', 'verification', 'development'];
const AGENT_SP_MODES = ['append', 'replace'];
const AGENT_BOOL_TRIPLE = ['', 'true', 'false'];

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
  providerDirty: false,
  modelDirty: false,
  providerRevision: 0,
  modelRevision: 0,
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

// ── boot ────────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", async () => {
  initTheme();
  bindThemeUI();
  bindHelpAndOnboarding();
  bindNav();
  if (typeof bindModelsUI === "function") bindModelsUI();
  if (typeof bindAgentsUI === "function") bindAgentsUI();
  if (typeof bindOpenvlUI === "function") bindOpenvlUI();
  if (typeof bindConsoleUI === "function") bindConsoleUI();
  if (typeof bindContentPages === "function") bindContentPages();
  bindGlobalSave();
  if (typeof buildTlmGrid === "function") buildTlmGrid();
  void loadMeta().then(() => {
    if (typeof updateCapabilityHints === 'function') updateCapabilityHints();
  });
  window.addEventListener('hashchange', () => { void routeFromHash(); });
  await routeFromHash();
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

let routeGeneration = 0;
const routeLoads = new Map();

async function loadRouteData(route) {
  const loaders = {
    models: ['loadProviders', 'loadDefaults', 'loadFlatModels'],
    agents: ['loadAgents', 'loadCategories', 'loadToolPool', 'loadFlatModels', 'loadWorkspaces'],
    openvl: ['loadOpenvl'],
  }[route] || [];
  if (!loaders.length) return;
  if (!routeLoads.has(route)) {
    const task = Promise.allSettled(loaders.map((name) =>
      Promise.resolve().then(() => typeof window[name] === 'function' ? window[name]() : undefined)
    )).then((results) => {
      results.forEach((result, i) => {
        if (result.status === 'rejected') console.warn('[route] ' + loaders[i], result.reason);
      });
    }).finally(() => routeLoads.delete(route));
    routeLoads.set(route, task);
  }
  await routeLoads.get(route);
}

async function routeFromHash() {
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
  else if (pathOnly.startsWith('promptmap')) next = 'promptmap';
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
  if (state.route && next !== state.route) {
    if (state.route === 'runtime' && typeof window.stopRuntimeTimer === 'function') {
      window.stopRuntimeTimer();
    }
    if (state.route === 'search' && typeof window.clearSearchTimer === 'function') {
      window.clearSearchTimer();
    }
  }
  state.route = next;
  const generation = ++routeGeneration;
  $$('#nav-tabs .tab[data-route]').forEach((tab) =>
    tab.classList.toggle('active', tab.dataset.route === next)
  );
  $$('#nav-more-menu .nav-more-item').forEach((item) =>
    item.classList.toggle('active', item.dataset.route === next)
  );
  const moreRoutes = {
    openvl: 1,
    prompt: 1,
    promptmap: 1,
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
  ['prompt', 'promptmap', 'skills', 'plugins', 'memory', 'knowledge', 'workspaces'].forEach((pg) => {
    $('#page-' + pg)?.classList.toggle('hidden', next !== pg);
  });
  updateGlobalSaveUI();
  await loadRouteData(next);
  if (generation !== routeGeneration) return;
  if (next === 'guides') {
    if (typeof enterGuidesRoute === 'function') enterGuidesRoute(query.topic || query.t || '');
  } else if (next === 'dashboard' || next === 'sessions') {
    if (typeof enterDashRoute === 'function') enterDashRoute(next);
  } else if (next === 'usage') {
    if (typeof enterUsageRoute === 'function') enterUsageRoute();
  } else if (next === 'promptmap') {
    if (typeof enterPromptMapRoute === 'function') enterPromptMapRoute();
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

async function api(path, opts = {}) {
  const { timeoutMs = 30000, signal, ...requestOpts } = opts;
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('请求超时')), timeoutMs);
  try {
    const res = await fetch(path, { ...requestOpts, signal: controller.signal });
    const text = await res.text();
    let data = {};
    if (text) {
      try {
        data = JSON.parse(text);
      } catch (error) {
        if (controller.signal.aborted) throw error;
        // A 200 whose body isn't JSON used to be silently coerced to {} — that is
        // exactly how a broken endpoint renders as "all zeros" instead of an error.
        if (res.ok) throw new Error('响应不是合法 JSON（HTTP ' + res.status + '）');
      }
    }
    if (!res.ok && res.status !== 202) throw new Error(data.error || 'HTTP ' + res.status);
    return data;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
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
  if (kind === 'provider' || kind === 'model') {
    state[kind + 'Dirty'] = dirty;
    if (dirty) state[kind + 'Revision']++;
    kind = 'models';
    dirty = state.providerDirty || state.modelDirty;
  } else if (kind === 'models') {
    state.providerDirty = dirty;
    state.modelDirty = dirty;
  }
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
 * Provider and model saves have independent dirty flags and success results.
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

    if (state.route !== 'models') return false;
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

    // A model failure must not be hidden by a successful provider save.
    if (providerOpen && (state.providerDirty || !state.currentProviderId)) {
      if (!(await saveProvider())) return false;
    }
    if (modelOpen && state.modelDirty) {
      if (!(await saveModel())) return false;
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


// ── core exports & backward compatibility ────────────────────────────────────

window.PiManagerCore = {
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
  defaultThinkingLevelMap,
  maskDots,
  isKeyMaskValue,
  api,
  showToast,
  setDirty,
  markDirty: setDirty,
  isAnyDirty,
  updateGlobalSaveUI,
  parseJsonField,
  loadMeta,
};
Object.assign(window, window.PiManagerCore);
