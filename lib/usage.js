/**
 * Pi session token/cost stats.
 * Parser/aggregation adapted from:
 * - pi-token-stats (reaishijie) MIT
 * - pi-tracker session-parser / windowStartMs (alpertarhan) MIT
 *
 * Caching:
 * - memory: records + reports (TTL)
 * - disk: per-file mtime/size incremental parse index
 *   ~/.pi/agent/cache/usage-index.json
 */
const fs = require('fs');
const path = require('path');
const { PI_AGENT_DIR, MODELS_FILE } = require('./config');

/**
 * Cost = same as pi-powerline-footer: sum of usage.cost.total as written to jsonl.
 * No FX (no ×7.2). Unit is whatever models.json put into that float at write time.
 * costByCurrency is diagnostic only (USD/CNY/OTHER labels from costUnit).
 */
const USD_TO_CNY = Number(process.env.USAGE_USD_CNY_RATE) || 7.2; // kept for optional note only

let _unitMapCache = { mtimeMs: -1, byKey: new Map(), byProvider: new Map() };

function loadCostUnitMaps() {
  let st;
  try {
    st = fs.statSync(MODELS_FILE);
  } catch {
    return _unitMapCache;
  }
  if (st.mtimeMs === _unitMapCache.mtimeMs && _unitMapCache.byKey.size) {
    return _unitMapCache;
  }
  const byKey = new Map();
  const byProvider = new Map();
  try {
    const raw = JSON.parse(fs.readFileSync(MODELS_FILE, 'utf8'));
    const providers = raw.providers || {};
    for (const [pid, p] of Object.entries(providers)) {
      const units = new Set();
      for (const m of p.models || []) {
        if (!m || typeof m !== 'object') continue;
        const unit = String(m.costUnit || '');
        const cur = currencyFromUnit(unit, pid);
        byKey.set(pid + '/' + m.id, cur);
        units.add(cur);
      }
      // provider default = majority / first known
      if (units.size === 1) byProvider.set(pid, [...units][0]);
      else if (units.size > 1) byProvider.set(pid, 'MIXED');
      else byProvider.set(pid, currencyFromUnit('', pid));
    }
  } catch {
    /* keep previous or empty */
  }
  _unitMapCache = { mtimeMs: st.mtimeMs, byKey, byProvider };
  return _unitMapCache;
}

function currencyFromUnit(unit, provider) {
  const u = String(unit || '');
  if (/CNY/i.test(u)) return 'CNY';
  if (/USD/i.test(u) || /GoQuota/i.test(u)) return 'USD';
  // provider fallbacks when costUnit missing / as_configured
  const p = String(provider || '').toLowerCase();
  if (p === 'mzhcloud' || p.startsWith('mzh')) return 'CNY';
  if (
    p === 'opencode-go' ||
    p === 'deepseek' ||
    p === 'ohmygpt' ||
    p === 'codex' ||
    p.startsWith('subagent:opencode') ||
    p.startsWith('subagent:deepseek') ||
    p.startsWith('subagent:ohmygpt')
  ) {
    return 'USD';
  }
  if (p.startsWith('subagent:mzh')) return 'CNY';
  if (p.startsWith('subagent')) return 'OTHER';
  if (/as_configured/i.test(u)) return 'OTHER';
  return 'OTHER';
}

function resolveRecordCurrency(r) {
  const maps = loadCostUnitMaps();
  const key = r.key || r.provider + '/' + r.model;
  if (maps.byKey.has(key)) return maps.byKey.get(key);
  // model id only
  for (const [k, cur] of maps.byKey) {
    if (k.endsWith('/' + r.model)) return cur;
  }
  if (maps.byProvider.has(r.provider)) {
    const c = maps.byProvider.get(r.provider);
    if (c && c !== 'MIXED') return c;
  }
  return currencyFromUnit('', r.provider);
}

function emptyCostByCurrency() {
  return { USD: 0, CNY: 0, OTHER: 0 };
}

function addCostByCurrency(bucket, currency, amount) {
  const cur = bucket[currency] != null ? currency : 'OTHER';
  bucket[cur] = (bucket[cur] || 0) + (Number(amount) || 0);
}

function finalizeCostMeta(summary) {
  const b = summary.costByCurrency || emptyCostByCurrency();
  const parts = Object.entries(b).filter(([, v]) => (Number(v) || 0) > 0);
  summary.costCurrencies = parts.map(([k]) => k);
  summary.costMixedNative = parts.length > 1;
  // Raw sum (no FX). UI always labels as ¥ per user preference.
  summary.costMixed = false;
  summary.costCurrency = 'CNY';
  summary.usdToCny = null;
  summary.costTotalCny = summary.costTotal;
  return summary;
}

const SESSIONS_DIR =
  process.env.SESSIONS_DIR ||
  process.env.PI_CODING_AGENT_SESSION_DIR ||
  path.join(
    process.env.PI_CODING_AGENT_DIR || PI_AGENT_DIR,
    'sessions'
  );

const CACHE_DIR =
  process.env.PI_MANAGER_USAGE_CACHE_DIR ||
  path.join(
    process.env.PI_CODING_AGENT_DIR || PI_AGENT_DIR,
    'cache'
  );
const DISK_CACHE_PATH = path.join(CACHE_DIR, 'usage-index-v2.json');

const DAY_MS = 24 * 60 * 60 * 1000;
const MEM_TTL_MS = 5 * 60_000; // 5 min memory
// v2: include subagent toolResult usage
const DISK_VERSION = 2;

/** @type {{ expires: number, fingerprint: string, records: object[], filesScanned: number, filesMatched: number, scannedAt: number, sessionDir: string } | null} */
let recordCache = null;
/** @type {Map<string, { expires: number, data: object }>} */
const reportCache = new Map();

function ensureCacheDir() {
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
  } catch {
    /* ignore */
  }
}

function walkJsonlFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const result = [];
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry);
      let st;
      try {
        st = fs.statSync(fullPath);
      } catch {
        continue;
      }
      if (st.isDirectory()) stack.push(fullPath);
      else if (st.isFile() && entry.endsWith('.jsonl')) result.push(fullPath);
    }
  }
  return result;
}

function pad2(n) {
  return n < 10 ? '0' + n : String(n);
}

function dayKeyFromTs(ts) {
  if (ts == null || !Number.isFinite(ts)) return null;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  return (
    d.getFullYear() +
    '-' +
    pad2(d.getMonth() + 1) +
    '-' +
    pad2(d.getDate())
  );
}

function windowStartMs(window, now = new Date()) {
  switch (window) {
    case 'today':
      return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    case 'week':
      return now.getTime() - 7 * DAY_MS;
    case 'month':
      return now.getTime() - 30 * DAY_MS;
    case 'all':
      return 0;
    default:
      return 0;
  }
}

function parseWindow(input) {
  if (input == null || input === '') return 'week';
  const s = String(input).trim().toLowerCase();
  if (s === 'today' || s === 'day' || s === '1') return 'today';
  if (s === 'week' || s === '7') return 'week';
  if (s === 'month' || s === '30') return 'month';
  if (s === 'all' || s === '0') return 'all';
  const n = Number(s);
  if (Number.isFinite(n)) {
    if (n === 0) return 'all';
    if (n === 1) return 'today';
    if (n <= 7) return 'week';
    if (n <= 30) return 'month';
    return 'all';
  }
  return 'week';
}

function windowLabel(window) {
  return (
    {
      today: '今天',
      week: '最近 7 天',
      month: '最近 30 天',
      all: '全部',
    }[window] || window
  );
}

function sessionIdFromPath(file) {
  const base = path.basename(file, path.extname(file));
  return base || 'unknown';
}

function extractAssistantUsage(entry, fileSid, cwd, currentModel) {
  if (entry && entry.type === 'message' && entry.message) {
    const msg = entry.message;
    if (msg.role !== 'assistant' || !msg.usage) return null;
    const ts =
      (typeof msg.timestamp === 'number' ? msg.timestamp : null) ??
      (entry.timestamp ? Date.parse(entry.timestamp) : null);
    const provider = msg.provider || 'unknown';
    const model = msg.model || currentModel || 'unknown';
    return {
      ts: Number.isFinite(ts) ? ts : 0,
      sid: fileSid,
      cwd: cwd || '',
      provider,
      model,
      key: provider + '/' + model,
      in: Number(msg.usage.input) || 0,
      out: Number(msg.usage.output) || 0,
      cR: Number(msg.usage.cacheRead) || 0,
      cW: Number(msg.usage.cacheWrite) || 0,
      reasoning: Number(msg.usage.reasoning) || 0,
      tot:
        Number(msg.usage.totalTokens) ||
        (Number(msg.usage.input) || 0) +
          (Number(msg.usage.output) || 0) +
          (Number(msg.usage.cacheRead) || 0) +
          (Number(msg.usage.cacheWrite) || 0),
      cost:
        msg.usage.cost && msg.usage.cost.total != null
          ? Number(msg.usage.cost.total) || 0
          : (Number(msg.usage.cost?.input) || 0) +
            (Number(msg.usage.cost?.output) || 0) +
            (Number(msg.usage.cost?.cacheRead) || 0) +
            (Number(msg.usage.cost?.cacheWrite) || 0),
      costKnown: !!(msg.usage.cost && msg.usage.cost.total != null),
    };
  }
  if (entry && entry.role === 'assistant' && entry.usage) {
    const ts =
      (typeof entry.timestamp === 'number' ? entry.timestamp : null) ??
      (typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : null);
    const provider = entry.provider || 'unknown';
    const model = entry.model || currentModel || 'unknown';
    return {
      ts: Number.isFinite(ts) ? ts : 0,
      sid: fileSid,
      cwd: cwd || '',
      provider,
      model,
      key: provider + '/' + model,
      in: Number(entry.usage.input) || 0,
      out: Number(entry.usage.output) || 0,
      cR: Number(entry.usage.cacheRead) || 0,
      cW: Number(entry.usage.cacheWrite) || 0,
      reasoning: Number(entry.usage.reasoning) || 0,
      tot:
        Number(entry.usage.totalTokens) ||
        (Number(entry.usage.input) || 0) +
          (Number(entry.usage.output) || 0) +
          (Number(entry.usage.cacheRead) || 0) +
          (Number(entry.usage.cacheWrite) || 0),
      cost:
        entry.usage.cost && entry.usage.cost.total != null
          ? Number(entry.usage.cost.total) || 0
          : 0,
      costKnown: !!(entry.usage.cost && entry.usage.cost.total != null),
    };
  }
  return null;
}

/**
 * Subagent extension runs with --no-session; usage is rolled into parent
 * toolResult details.results[].usage (see ~/.pi/agent/extensions/subagent).
 */
function extractSubagentUsage(entry, fileSid, cwd) {
  if (!entry || entry.type !== 'message' || !entry.message) return [];
  const msg = entry.message;
  if (msg.role !== 'toolResult') return [];
  const toolName = String(msg.toolName || '').toLowerCase();
  if (toolName !== 'subagent') return [];
  const details = msg.details;
  if (!details || !Array.isArray(details.results)) return [];

  const ts =
    (typeof msg.timestamp === 'number' ? msg.timestamp : null) ??
    (entry.timestamp ? Date.parse(entry.timestamp) : null);
  const tsNum = Number.isFinite(ts) ? ts : 0;
  const out = [];

  for (const r of details.results) {
    if (!r || typeof r !== 'object') continue;
    const usage = r.usage;
    if (!usage || typeof usage !== 'object') continue;

    const input = Number(usage.input) || 0;
    const output = Number(usage.output) || 0;
    const cR = Number(usage.cacheRead) || 0;
    const cW = Number(usage.cacheWrite) || 0;
    const tot =
      Number(usage.totalTokens) ||
      Number(usage.contextTokens) ||
      input + output + cR + cW;
    // subagent aggregates cost as a number, not { total }
    const cost =
      typeof usage.cost === 'number'
        ? usage.cost
        : usage.cost && usage.cost.total != null
          ? Number(usage.cost.total) || 0
          : 0;
    // skip empty failed stubs
    if (!input && !output && !cR && !cW && !cost) continue;

    const agentName = r.agent ? String(r.agent) : 'subagent';
    let model = r.model ? String(r.model) : 'unknown';
    // model may already be "provider/id"
    let provider = 'subagent';
    if (model.includes('/')) {
      const parts = model.split('/');
      provider = 'subagent:' + parts[0];
      model = parts.slice(1).join('/') || model;
    }
    const turns = Math.max(1, Number(usage.turns) || 1);

    out.push({
      ts: tsNum,
      sid: fileSid,
      cwd: cwd || '',
      provider,
      model,
      key: provider + '/' + model,
      agent: agentName,
      source: 'subagent',
      // expand turns so request count closer to real assistant turns
      requests: turns,
      in: input,
      out: output,
      cR,
      cW,
      reasoning: 0,
      tot,
      cost,
      costKnown: cost > 0 || usage.cost != null,
    });
  }
  return out;
}

/** Parse one session file into usage records. */
function parseSessionFile(file) {
  let content;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch {
    return { records: [], matched: false };
  }
  let cwd = '';
  let sid = sessionIdFromPath(file);
  let currentModel = '';
  const records = [];
  // line-by-line without split whole huge array when possible
  let start = 0;
  while (start <= content.length) {
    let end = content.indexOf('\n', start);
    if (end === -1) end = content.length;
    let line = content.slice(start, end);
    start = end + 1;
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (!line) {
      if (end === content.length) break;
      continue;
    }
    if (!line.includes('"usage"') && !line.includes('"session"') && !line.includes('"model_change"')) {
      if (end === content.length) break;
      continue;
    }
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      if (end === content.length) break;
      continue;
    }
    if (entry.type === 'session') {
      if (typeof entry.cwd === 'string') cwd = entry.cwd;
      if (entry.id) sid = String(entry.id);
    } else if (entry.type === 'model_change') {
      if (entry.modelId) currentModel = String(entry.modelId);
    } else {
      const rec = extractAssistantUsage(entry, sid, cwd, currentModel);
      if (rec && rec.model !== 'delivery-mirror') {
        rec.source = 'main';
        rec.requests = 1;
        records.push(rec);
      }
      const subRecs = extractSubagentUsage(entry, sid, cwd);
      for (const r of subRecs) records.push(r);
    }
    if (end === content.length) break;
  }
  return { records, matched: records.length > 0 };
}

function loadDiskIndex() {
  try {
    if (!fs.existsSync(DISK_CACHE_PATH)) return null;
    const raw = fs.readFileSync(DISK_CACHE_PATH, 'utf8');
    const obj = JSON.parse(raw);
    if (!obj || obj.version !== DISK_VERSION) return null;
    if (!obj.files || typeof obj.files !== 'object') return null;
    return obj;
  } catch {
    return null;
  }
}

function saveDiskIndex(index) {
  try {
    ensureCacheDir();
    const tmp = DISK_CACHE_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(index), 'utf8');
    fs.renameSync(tmp, DISK_CACHE_PATH);
  } catch {
    /* ignore disk write errors */
  }
}

/** Last successfully written disk fingerprint — skip rewrite when unchanged. */
let lastDiskWriteFingerprint = null;

function fileFingerprint(files) {
  // cheap fingerprint: count + total size + max mtime
  let totalSize = 0;
  let maxMtime = 0;
  for (const f of files) {
    try {
      const st = fs.statSync(f);
      totalSize += st.size;
      if (st.mtimeMs > maxMtime) maxMtime = st.mtimeMs;
    } catch {
      /* ignore */
    }
  }
  return files.length + ':' + totalSize + ':' + Math.floor(maxMtime);
}

/**
 * Incremental load: reuse per-file parsed records when mtime+size unchanged.
 */
function loadAllRecords(force) {
  const now = Date.now();
  const files = walkJsonlFiles(SESSIONS_DIR);
  const fingerprint = fileFingerprint(files);

  if (
    !force &&
    recordCache &&
    recordCache.expires > now &&
    recordCache.fingerprint === fingerprint
  ) {
    return { ...recordCache, source: 'memory' };
  }

  let disk = force ? null : loadDiskIndex();
  if (disk && disk.sessionDir && disk.sessionDir !== SESSIONS_DIR) disk = null;

  const filesMap = (disk && disk.files) || {};
  const nextFiles = {};
  const records = [];
  let filesMatched = 0;
  let reused = 0;
  let parsed = 0;

  for (const file of files) {
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      continue;
    }
    const meta = filesMap[file];
    if (
      meta &&
      meta.size === st.size &&
      meta.mtimeMs === st.mtimeMs &&
      Array.isArray(meta.records)
    ) {
      // reuse
      for (const r of meta.records) records.push(r);
      if (meta.records.length) filesMatched += 1;
      nextFiles[file] = meta;
      reused += 1;
      continue;
    }
    const { records: recs, matched } = parseSessionFile(file);
    parsed += 1;
    if (matched) filesMatched += 1;
    for (const r of recs) records.push(r);
    nextFiles[file] = {
      size: st.size,
      mtimeMs: st.mtimeMs,
      records: recs,
    };
  }

  // Only rewrite ~multi-MB disk index when something actually re-parsed or first write
  const index = {
    version: DISK_VERSION,
    sessionDir: SESSIONS_DIR,
    updatedAt: now,
    files: nextFiles,
  };
  const shouldWriteDisk =
    force ||
    parsed > 0 ||
    lastDiskWriteFingerprint !== fingerprint ||
    !fs.existsSync(DISK_CACHE_PATH);
  if (shouldWriteDisk) {
    try {
      saveDiskIndex(index);
      lastDiskWriteFingerprint = fingerprint;
    } catch {
      /* ignore */
    }
  } else if (disk && disk.updatedAt) {
    // keep prior disk stamp; memory still refreshed below
    lastDiskWriteFingerprint = fingerprint;
  }

  recordCache = {
    expires: now + MEM_TTL_MS,
    fingerprint,
    records,
    filesScanned: files.length,
    filesMatched,
    scannedAt: now,
    sessionDir: SESSIONS_DIR,
    reused,
    parsed,
  };
  // reports depend on records
  reportCache.clear();
  return {
    ...recordCache,
    source: parsed ? (reused ? 'mixed' : 'full') : disk ? 'disk' : 'full',
  };
}

function emptySummary() {
  return {
    requests: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    totalTokens: 0,
    /** raw sum of cost floats — ONLY use when !costMixed */
    costTotal: 0,
    costByCurrency: emptyCostByCurrency(),
    costMixed: false,
    costCurrency: null,
    costCurrencies: [],
    sessions: 0,
    models: 0,
    // main vs subagent splits
    mainRequests: 0,
    mainInput: 0,
    mainOutput: 0,
    mainCacheRead: 0,
    mainCacheWrite: 0,
    mainTokens: 0,
    mainCost: 0,
    mainCostByCurrency: emptyCostByCurrency(),
    subagentRequests: 0,
    subagentInput: 0,
    subagentOutput: 0,
    subagentCacheRead: 0,
    subagentCacheWrite: 0,
    subagentTokens: 0,
    subagentCost: 0,
    subagentCostByCurrency: emptyCostByCurrency(),
  };
}

function cacheHitPct(cacheRead, input) {
  const cr = Number(cacheRead) || 0;
  const inn = Number(input) || 0;
  const denom = cr + inn;
  if (!denom) return 0;
  return (cr / denom) * 100;
}

function aggregateWindow(records, startMs) {
  const summary = emptySummary();
  const modelMap = new Map();
  const providerMap = new Map();
  const agentMap = new Map();
  const dayMap = new Map();
  const sessionSet = new Set();

  for (const r of records) {
    if (r.ts < startMs) continue;
    if (startMs > 0 && !r.ts) continue;

    const reqN = Math.max(1, Number(r.requests) || 1);
    summary.requests += reqN;
    summary.input += r.in;
    summary.output += r.out;
    summary.cacheRead += r.cR;
    summary.cacheWrite += r.cW;
    summary.reasoning += r.reasoning || 0;
    summary.totalTokens += r.tot;
    const cur = r.currency || resolveRecordCurrency(r);
    r.currency = cur;
    // powerline-footer style: cost += usage.cost.total (no FX)
    const costRaw = Number(r.cost) || 0;
    r.costCny = costRaw;
    summary.costTotal += costRaw;
    addCostByCurrency(summary.costByCurrency, cur, costRaw);
    if (r.source === 'subagent') {
      summary.subagentRequests += reqN;
      summary.subagentInput += r.in;
      summary.subagentOutput += r.out;
      summary.subagentCacheRead += r.cR;
      summary.subagentCacheWrite += r.cW;
      summary.subagentTokens += r.tot;
      summary.subagentCost += costRaw;
      addCostByCurrency(summary.subagentCostByCurrency, cur, costRaw);
    } else {
      summary.mainRequests += reqN;
      summary.mainInput += r.in;
      summary.mainOutput += r.out;
      summary.mainCacheRead += r.cR;
      summary.mainCacheWrite += r.cW;
      summary.mainTokens += r.tot;
      summary.mainCost += costRaw;
      addCostByCurrency(summary.mainCostByCurrency, cur, costRaw);
    }
    if (r.sid) sessionSet.add(r.sid);

    let m = modelMap.get(r.key);
    if (!m) {
      m = {
        provider: r.provider,
        model: r.model,
        key: r.key,
        requests: 0,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 0,
        totalTokens: 0,
        costTotal: 0,
        mainRequests: 0,
        subagentRequests: 0,
      };
      modelMap.set(r.key, m);
    }
    m.requests += reqN;
    m.input += r.in;
    m.output += r.out;
    m.cacheRead += r.cR;
    m.cacheWrite += r.cW;
    m.reasoning += r.reasoning || 0;
    m.totalTokens += r.tot;
    m.costTotal += costRaw;
    m.costNative = (m.costNative || 0) + costRaw;
    if (!m.nativeCurrency) m.nativeCurrency = cur;
    else if (m.nativeCurrency !== cur) m.nativeCurrency = 'MIXED';
    m.currency = 'CNY'; // display label only
    if (r.source === 'subagent') m.subagentRequests += reqN;
    else m.mainRequests += reqN;

    let p = providerMap.get(r.provider);
    if (!p) {
      p = {
        provider: r.provider,
        requests: 0,
        totalTokens: 0,
        costTotal: 0,
        costNative: 0,
        currency: cur,
        nativeCurrency: cur,
        models: 0,
      };
      providerMap.set(r.provider, p);
    }
    p.requests += reqN;
    p.totalTokens += r.tot;
    p.costTotal += costRaw;
    p.costNative = (p.costNative || 0) + costRaw;
    if (p.nativeCurrency && p.nativeCurrency !== cur) p.nativeCurrency = 'MIXED';
    else if (!p.nativeCurrency) p.nativeCurrency = cur;
    p.currency = 'CNY';

    if (r.source === 'subagent' && r.agent) {
      let a = agentMap.get(r.agent);
      if (!a) {
        a = {
          agent: r.agent,
          requests: 0,
          totalTokens: 0,
          costTotal: 0,
          models: new Set(),
        };
        agentMap.set(r.agent, a);
      }
      a.requests += reqN;
      a.totalTokens += r.tot;
      a.costTotal += costRaw;
      a.currency = 'CNY';
      a.nativeCurrency = cur;
      a.models.add(r.key);
    }

    const dk = dayKeyFromTs(r.ts);
    if (dk) {
      let d = dayMap.get(dk);
      if (!d) {
        d = {
          day: dk,
          requests: 0,
          input: 0,
          output: 0,
          totalTokens: 0,
          costTotal: 0,
        };
        dayMap.set(dk, d);
      }
      d.requests += reqN;
      d.input += r.in;
      d.output += r.out;
      d.totalTokens += r.tot;
      d.costTotal += costRaw;
      if (!d.costByCurrency) d.costByCurrency = emptyCostByCurrency();
      addCostByCurrency(d.costByCurrency, cur, costRaw);
    }
  }

  finalizeCostMeta(summary);
  for (const d of dayMap.values()) {
    if (!d.costByCurrency) d.costByCurrency = emptyCostByCurrency();
    const parts = Object.entries(d.costByCurrency).filter(([, v]) => v > 0);
    d.costMixed = false;
    d.costCurrency = 'CNY';
    d.usdToCny = null;
  }

  const modelsPerProvider = new Map();
  for (const m of modelMap.values()) {
    modelsPerProvider.set(
      m.provider,
      (modelsPerProvider.get(m.provider) || 0) + 1
    );
  }
  for (const p of providerMap.values()) {
    p.models = modelsPerProvider.get(p.provider) || 0;
  }

  summary.sessions = sessionSet.size;
  summary.models = modelMap.size;
  summary.cacheHitRate = cacheHitPct(summary.cacheRead, summary.input);
  summary.mainCacheHitRate = cacheHitPct(
    summary.mainCacheRead,
    summary.mainInput
  );
  summary.subagentCacheHitRate = cacheHitPct(
    summary.subagentCacheRead,
    summary.subagentInput
  );

  const models = [...modelMap.values()].sort(
    (a, b) => b.costTotal - a.costTotal || b.totalTokens - a.totalTokens
  );
  const providers = [...providerMap.values()].sort(
    (a, b) => b.costTotal - a.costTotal || b.totalTokens - a.totalTokens
  );
  const agents = [...agentMap.values()]
    .map((a) => ({
      agent: a.agent,
      requests: a.requests,
      totalTokens: a.totalTokens,
      costTotal: a.costTotal,
      models: a.models.size,
    }))
    .sort((a, b) => b.costTotal - a.costTotal || b.totalTokens - a.totalTokens);
  const byDay = [...dayMap.values()].sort((a, b) =>
    a.day < b.day ? -1 : a.day > b.day ? 1 : 0
  );

  return { summary, models, providers, agents, byDay };
}

function aggregateWindows(packed, now) {
  return Object.fromEntries(['today', 'week', 'month', 'all'].map((window) =>
    [window, aggregateWindow(packed.records, windowStartMs(window, now))]
  ));
}

function buildReport(packed, window, now, detailMap) {
  const { all, today, week, month } = detailMap;
  const detail = detailMap[window] || week;

  return {
    window,
    windowLabel: windowLabel(window),
    days:
      window === 'today' ? 1 : window === 'week' ? 7 : window === 'month' ? 30 : 0,
    fromTime: windowStartMs(window, now) || null,
    toTime: now.getTime(),
    sessionDir: packed.sessionDir,
    filesScanned: packed.filesScanned,
    filesMatched: packed.filesMatched,
    scannedAt: packed.scannedAt,
    cacheSource: packed.source || null,
    reusedFiles: packed.reused || 0,
    parsedFiles: packed.parsed || 0,

    global: all.summary,
    today: {
      ...today.summary,
      models: today.models,
      providers: today.providers,
      agents: today.agents,
    },
    snapshots: {
      today: today.summary,
      week: week.summary,
      month: month.summary,
      all: all.summary,
    },

    requests: detail.summary.requests,
    input: detail.summary.input,
    output: detail.summary.output,
    cacheRead: detail.summary.cacheRead,
    cacheWrite: detail.summary.cacheWrite,
    reasoning: detail.summary.reasoning,
    totalTokens: detail.summary.totalTokens,
    costTotal: detail.summary.costTotal,
    costTotalCny: detail.summary.costTotal,
    costByCurrency: detail.summary.costByCurrency || emptyCostByCurrency(),
    costMixed: !!detail.summary.costMixed,
    costMixedNative: !!detail.summary.costMixedNative,
    costCurrency: detail.summary.costCurrency || null,
    costCurrencies: detail.summary.costCurrencies || [],
    usdToCny: null,
    sessions: detail.summary.sessions,
    subagentRequests: detail.summary.subagentRequests || 0,
    subagentCost: detail.summary.subagentCost || 0,
    subagentCostByCurrency: detail.summary.subagentCostByCurrency || emptyCostByCurrency(),
    mainCostByCurrency: detail.summary.mainCostByCurrency || emptyCostByCurrency(),
    subagentTokens: detail.summary.subagentTokens || 0,
    subagentInput: detail.summary.subagentInput || 0,
    subagentCacheRead: detail.summary.subagentCacheRead || 0,
    mainRequests: detail.summary.mainRequests || 0,
    mainCost: detail.summary.mainCost || 0,
    mainTokens: detail.summary.mainTokens || 0,
    mainInput: detail.summary.mainInput || 0,
    mainCacheRead: detail.summary.mainCacheRead || 0,
    cacheHitRate: detail.summary.cacheHitRate || 0,
    mainCacheHitRate: detail.summary.mainCacheHitRate || 0,
    subagentCacheHitRate: detail.summary.subagentCacheHitRate || 0,
    models: detail.models,
    providers: detail.providers,
    agents: detail.agents,
    byDay: detail.byDay,
    globalModels: all.models,
    globalProviders: all.providers,
    globalAgents: all.agents,
  };
}

function collectUsage(opts = {}) {
  const force = !!opts.force;
  const window = parseWindow(opts.window != null ? opts.window : opts.days);
  const now = new Date();
  const cacheKey = window; // force does not change key; force only bypasses

  if (!force) {
    const hit = reportCache.get(cacheKey);
    if (hit && hit.expires > Date.now()) {
      return { ...hit.data, cached: true, cacheLayer: 'report' };
    }
  }

  const packed = loadAllRecords(force);
  const detailMap = aggregateWindows(packed, now);
  const data = buildReport(packed, window, now, detailMap);
  data.cached = false;
  data.cacheLayer = packed.source || 'full';

  reportCache.set(cacheKey, {
    expires: Date.now() + MEM_TTL_MS,
    data,
  });
  // also precompute sibling windows into report cache (cheap vs parse)
  for (const w of ['today', 'week', 'month', 'all']) {
    if (w === window) continue;
    if (!force && reportCache.has(w) && reportCache.get(w).expires > Date.now()) {
      continue;
    }
    const sibling = buildReport(packed, w, now, detailMap);
    sibling.cached = false;
    sibling.cacheLayer = packed.source || 'full';
    reportCache.set(w, { expires: Date.now() + MEM_TTL_MS, data: sibling });
  }

  return data;
}

function clearUsageCache() {
  recordCache = null;
  reportCache.clear();
  lastDiskWriteFingerprint = null;
  try {
    if (fs.existsSync(DISK_CACHE_PATH)) fs.unlinkSync(DISK_CACHE_PATH);
  } catch {
    /* ignore */
  }
}

module.exports = {
  collectUsage,
  clearUsageCache,
  SESSIONS_DIR,
  DISK_CACHE_PATH,
  parseWindow,
  windowStartMs,
  parseSessionFile,
};
