/**
 * Task-oriented session activity from Pi jsonl.
 * Infers: current user task, in-flight tools, parallel vs serial, todo, subagents.
 * Not process-level; "running" = open toolCall without toolResult (or just finished).
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { PI_AGENT_DIR } = require('./config');

const SESSIONS_DIR =
  process.env.SESSIONS_DIR || path.join(PI_AGENT_DIR, 'sessions');

const ACTIVE_MS = 5 * 60 * 1000;
const RECENT_MS = 30 * 60 * 1000;
/** Runtime cache: aligned with frontend soft poll (~3–5s) */
const MEM_TTL_MS = 2500;
const MAX_SESSIONS_DETAIL = 12;
const MAX_FULL_PARSE = 6; // full tool-graph parse for newest N
/** Only tail-read huge jsonl; enough for recent tool graph */
const PARSE_TAIL_BYTES = 1.5 * 1024 * 1024;
const PARSE_CACHE_MAX = 24;

// Phase windows (jsonl is not stream-realtime; prefer "maybe live" over false stopped)
const AFTER_ASSISTANT_STOP_MS = 25 * 1000; // assistant 行写入后 ≈ 整轮结束
const AFTER_TOOL_RESULT_LIVE_MS = 3 * 60 * 1000; // 工具返回后常有长思考，勿急判停
const AFTER_USER_LIVE_MS = 5 * 60 * 1000; // 用户发完到首包，可卡很久
const AFTER_THINKING_LIVE_MS = 3 * 60 * 1000;
const AFTER_TOOLCALL_RACE_MS = 90 * 1000;

let cache = null;
let processProbeCache = { expires: 0, data: null };
const PROCESS_PROBE_TTL_MS = 1500;
/** per-file parse cache: abs -> { mtimeMs, size, task } */
const parseCache = new Map();

function formatBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return v + ' B';
  if (v < 1024 * 1024) return (v / 1024).toFixed(1) + ' KB';
  if (v < 1024 * 1024 * 1024) return (v / (1024 * 1024)).toFixed(1) + ' MB';
  return (v / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

function formatAge(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return s + 's 前';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm 前';
  const h = Math.floor(m / 60);
  if (h < 48) return h + 'h 前';
  return Math.floor(h / 24) + 'd 前';
}

function decodeCwdKey(key) {
  if (!key) return '';
  return String(key).replace(/^--+/, '').replace(/--+$/, '').replace(/--/g, '/');
}

function parseSessionFileName(name) {
  const m = String(name).match(
    /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)_([0-9a-fA-F-]+)\.jsonl$/
  );
  if (!m) return { startedAt: null, sessionId: null };
  const iso = m[1].replace(
    /^(\d{4}-\d{2}-\d{2}T)(\d{2})-(\d{2})-(\d{2})-(\d{3}Z)$/,
    '$1$2:$3:$4.$5'
  );
  return { startedAt: iso, sessionId: m[2] };
}

function clip(s, n) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  if (t.length <= n) return t;
  return t.slice(0, n) + '…';
}

function textFromContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((p) => {
      if (typeof p === 'string') return p;
      if (!p || typeof p !== 'object') return '';
      if (p.type === 'text') return p.text || '';
      return p.text || p.content || '';
    })
    .join(' ');
}

/** User messages that are control phrases or pasted runtime UI — not a real task. */
function isNoiseUserMessage(t) {
  const s = String(t || '').trim();
  if (!s) return true;
  // pure control / ack
  if (
    /^(批准执行|继续|继续吧|好|好的|行|行吧|可以|ok|OK|嗯|搞吧|开始吧|没问题|就这样)$/i.test(
      s
    )
  ) {
    return true;
  }
  // pasted runtime page dump
  if (
    /在干活/.test(s) &&
    (/在想\/在说/.test(s) || /停了，等你/.test(s) || /刚才用了/.test(s))
  ) {
    return true;
  }
  if (/^运行\s*\n/.test(s) && /\d+\s*\n\s*在干活/.test(s)) return true;
  // mostly JSON tool dump
  if (/^\{[\s\S]*"action"\s*:/.test(s) && s.length < 200) return true;
  return false;
}

function summarizeTodoArgs(args) {
  if (!args || typeof args !== 'object') return 'Todo';
  const action = String(args.action || '').toLowerCase();
  if (action === 'toggle') {
    const id = args.id != null ? String(args.id) : '?';
    return '勾完 #' + id;
  }
  if (action === 'add') {
    return '添加 · ' + clip(args.text || args.title || '', 48);
  }
  if (action === 'list' || action === 'get') return '查看列表';
  if (action === 'clear') return '清空列表';
  if (action === 'update' || action === 'edit') {
    return '更新 #' + (args.id != null ? args.id : '?') + (args.text ? ' · ' + clip(args.text, 36) : '');
  }
  if (Array.isArray(args.todos)) return '同步 ' + args.todos.length + ' 项';
  if (args.text) return clip(args.text, 48);
  return clip(action || 'Todo', 40);
}

function summarizeArgs(name, args) {
  if (!args || typeof args !== 'object') return '';
  try {
    if (name === 'bash' || name === 'shell') return clip(args.command || '', 100);
    if (name === 'read') return clip(args.path || '', 100);
    if (name === 'edit' || name === 'write') return clip(args.path || '', 100);
    if (name === 'subagent') {
      if (Array.isArray(args.tasks) && args.tasks.length) {
        return (
          '并行 ×' +
          args.tasks.length +
          ' · ' +
          args.tasks
            .map((t) => (t && (t.agent || t.name)) || '?')
            .slice(0, 6)
            .join('、')
        );
      }
      const agent = args.agent || args.name || '子代理';
      const task = args.task || args.prompt || args.text || '';
      return clip(agent + (task ? ' · ' + task : ''), 100);
    }
    if (name === 'todo') return summarizeTodoArgs(args);
    return clip(JSON.stringify(args), 80);
  } catch {
    return '';
  }
}

function listSessionFiles() {
  const root = SESSIONS_DIR;
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    return { root, files: [] };
  }
  const files = [];
  let dirs;
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return { root, files: [] };
  }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const cwdKey = d.name;
    const dirPath = path.join(root, cwdKey);
    let ents;
    try {
      ents = fs.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const f of ents) {
      if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
      const abs = path.join(dirPath, f.name);
      let st;
      try {
        st = fs.statSync(abs);
      } catch {
        continue;
      }
      const parsed = parseSessionFileName(f.name);
      files.push({
        abs,
        cwdKey,
        fileName: f.name,
        relPath: path.join(cwdKey, f.name).replace(/\\/g, '/'),
        mtimeMs: st.mtimeMs,
        size: st.size,
        sessionId: parsed.sessionId,
        startedAt: parsed.startedAt,
      });
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return { root, files };
}

const PARSE_HEAD_BYTES = 256 * 1024;

function readFileSlice(filePath, start, len) {
  const buf = Buffer.alloc(len);
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    fs.readSync(fd, buf, 0, len, start);
  } finally {
    if (fd != null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
  return buf.toString('utf8');
}

/** Drop partial first line when reading mid-file; drop partial last line for head. */
function alignJsonlSlice(text, { dropFirst = false, dropLast = false } = {}) {
  let out = text;
  if (dropFirst) {
    const nl = out.indexOf('\n');
    if (nl >= 0) out = out.slice(nl + 1);
  }
  if (dropLast) {
    const nl = out.lastIndexOf('\n');
    if (nl >= 0) out = out.slice(0, nl + 1);
  }
  return out;
}

/**
 * Read full file, or head+tail for large jsonl.
 * headText: early lines (for unpaired toolCall recovery); text: full or tail body.
 */
function readSessionTextForParse(filePath) {
  let st;
  try {
    st = fs.statSync(filePath);
  } catch (e) {
    return { text: '', headText: '', size: 0, mtimeMs: 0, tailed: false, error: e.message };
  }
  const size = st.size;
  const mtimeMs = st.mtimeMs;
  if (size <= PARSE_TAIL_BYTES) {
    try {
      const text = fs.readFileSync(filePath, 'utf8');
      return { text, headText: '', size, mtimeMs, tailed: false };
    } catch (e) {
      return { text: '', headText: '', size, mtimeMs, tailed: false, error: e.message };
    }
  }
  try {
    const headLen = Math.min(PARSE_HEAD_BYTES, size);
    let headText = readFileSlice(filePath, 0, headLen);
    // if head is not whole file, drop partial last line
    if (headLen < size) headText = alignJsonlSlice(headText, { dropLast: true });

    const tailStart = Math.max(0, size - PARSE_TAIL_BYTES);
    let text = readFileSlice(filePath, tailStart, size - tailStart);
    // drop partial first line when mid-file
    if (tailStart > 0) text = alignJsonlSlice(text, { dropFirst: true });

    // avoid double-counting when head and tail overlap (small files already handled)
    // if head ends after tailStart, shrink head to pre-tail region only
    if (tailStart < headLen) {
      // overlap: only use head bytes strictly before tailStart
      const headOnly = readFileSlice(filePath, 0, tailStart);
      headText = alignJsonlSlice(headOnly, { dropLast: true });
    }

    return { text, headText, size, mtimeMs, tailed: true };
  } catch (e) {
    return { text: '', headText: '', size, mtimeMs, tailed: true, error: e.message };
  }
}

/**
 * Scan jsonl text for open toolCalls only (pending map).
 * Does not update toolCounts / recentDone / phase fields.
 * @param {string} text
 * @param {Map<string, any>} pending
 */
function scanPendingToolCalls(text, pending) {
  if (!text) return;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (!o || typeof o !== 'object' || o.type !== 'message') continue;
    const msg = o.message || {};
    const role = msg.role;
    const content = msg.content;
    if (role === 'assistant' && Array.isArray(content)) {
      for (const part of content) {
        if (!part || part.type !== 'toolCall' || !part.id) continue;
        const name = part.name || 'tool';
        pending.set(part.id, {
          id: part.id,
          name,
          arguments: part.arguments || {},
          summary: summarizeArgs(name, part.arguments || {}),
          at: o.timestamp || null,
          batchId: 0,
          batchSize: 1,
          turn: 0,
          fromHead: true,
        });
      }
    } else if (role === 'toolResult') {
      const cid = msg.toolCallId;
      if (cid) pending.delete(cid);
    }
  }
}

/**
 * Full parse for task view (mtime+size cached; large files tail-read).
 */
function parseSessionTasks(filePath) {
  let stMeta;
  try {
    stMeta = fs.statSync(filePath);
  } catch (e) {
    return { error: e.message || String(e) };
  }
  const hit = parseCache.get(filePath);
  if (
    hit &&
    hit.mtimeMs === stMeta.mtimeMs &&
    hit.size === stMeta.size &&
    hit.task
  ) {
    return hit.task;
  }

  let cwd = null;
  let sessionId = null;
  let provider = '';
  let modelId = '';
  let thinkingLevel = '';
  let lastUser = '';
  let lastTaskUser = ''; // last non-noise user message (for display goal)
  let lastAssistantText = '';
  let lastTimestamp = null;
  let lastEventKind = '';

  /** @type {Map<string, any>} */
  const pending = new Map();
  const toolCounts = Object.create(null);
  const recentDone = [];
  let doneToolCount = 0;
  let lastTodo = null;
  const subagentHistory = [];
  let assistantTurn = 0;
  let lastBatchId = 0;
  let openSinceTurn = 0;

  let lineNo = 0;
  try {
    const loaded = readSessionTextForParse(filePath);
    if (loaded.error && !loaded.text) {
      return { error: loaded.error };
    }
    // Large files: recover unpaired toolCalls from file head before tail parse
    if (loaded.tailed && loaded.headText) {
      scanPendingToolCalls(loaded.headText, pending);
    }
    const text = loaded.text;
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) continue;
      lineNo++;
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      if (!o || typeof o !== 'object') continue;
      if (o.timestamp) lastTimestamp = o.timestamp;

      if (o.type === 'session') {
        cwd = o.cwd || cwd;
        sessionId = o.id || sessionId;
        continue;
      }
      if (o.type === 'model_change') {
        provider = o.provider || provider;
        modelId = o.modelId || modelId;
        continue;
      }
      if (o.type === 'thinking_level_change') {
        thinkingLevel = o.thinkingLevel || thinkingLevel;
        continue;
      }
      if (o.type !== 'message') continue;

      const msg = o.message || {};
      const role = msg.role;
      const content = msg.content;

      if (role === 'user') {
        const t = clip(textFromContent(content), 240);
        if (t) {
          lastUser = t;
          lastEventKind = 'user';
          if (!isNoiseUserMessage(t)) lastTaskUser = t;
        }
      } else if (role === 'assistant') {
        const t = clip(textFromContent(content), 200);
        if (t) lastAssistantText = t;
        let hasThinking = false;
        let hasText = false;
        let hasCalls = false;
        if (Array.isArray(content)) {
          for (const p of content) {
            if (!p || typeof p !== 'object') continue;
            if (p.type === 'thinking' || p.type === 'reasoning') hasThinking = true;
            if (p.type === 'text' && (p.text || '').trim()) hasText = true;
            if (p.type === 'toolCall' && p.id) hasCalls = true;
          }
        } else if (t) {
          hasText = true;
        }
        // phase of this assistant message (before tool results)
        if (hasCalls) lastEventKind = 'toolCall';
        else if (hasThinking && !hasText) lastEventKind = 'thinking';
        else if (hasText) lastEventKind = 'assistant';
        else lastEventKind = 'assistant';

        if (Array.isArray(content)) {
          const calls = content.filter((p) => p && p.type === 'toolCall' && p.id);
          if (calls.length) {
            assistantTurn += 1;
            lastBatchId = assistantTurn;
            openSinceTurn = assistantTurn;
            for (const part of calls) {
              const name = part.name || 'tool';
              toolCounts[name] = (toolCounts[name] || 0) + 1;
              const entry = {
                id: part.id,
                name,
                arguments: part.arguments || {},
                summary: summarizeArgs(name, part.arguments || {}),
                at: o.timestamp || null,
                batchId: lastBatchId,
                batchSize: calls.length,
                turn: assistantTurn,
              };
              pending.set(part.id, entry);
              if (name === 'subagent') {
                const args = part.arguments || {};
                const parallelTasks = Array.isArray(args.tasks) ? args.tasks : null;
                subagentHistory.push({
                  callId: part.id,
                  at: o.timestamp || null,
                  mode: parallelTasks && parallelTasks.length > 1 ? 'parallel' : 'single',
                  agent: args.agent || (parallelTasks && parallelTasks[0] && parallelTasks[0].agent) || '',
                  task: clip(args.task || args.prompt || '', 120),
                  tasks: parallelTasks
                    ? parallelTasks.map((t) => ({
                        agent: (t && (t.agent || t.name)) || '?',
                        task: clip((t && (t.task || t.prompt || t.text)) || '', 80),
                      }))
                    : null,
                  status: 'running',
                });
              }
            }
          }
        }
      } else if (role === 'toolResult') {
        lastEventKind = 'toolResult';
        const cid = msg.toolCallId;
        const name = msg.toolName || (pending.get(cid) && pending.get(cid).name) || 'tool';
        const was = pending.get(cid);
        if (cid) pending.delete(cid);
        const err = !!(msg.isError || msg.error);
        doneToolCount += 1;
        recentDone.push({
          id: cid,
          name,
          summary: was ? was.summary : '',
          ok: !err,
          at: o.timestamp || null,
        });
        if (recentDone.length > 12) recentDone.shift();

        if (name === 'todo' && msg.details) {
          lastTodo = msg.details;
        }
        if (name === 'subagent') {
          // mark matching history
          const hit = subagentHistory.find((s) => s.callId === cid);
          const details = msg.details || {};
          const results = Array.isArray(details.results) ? details.results : [];
          if (hit) {
            hit.status = err ? 'error' : 'done';
            hit.results = results.map((r) => ({
              agent: (r && (r.agent || r.name)) || hit.agent || 'subagent',
              status: r && r.error ? 'error' : 'done',
              error: r && r.error ? clip(String(r.error), 100) : null,
            }));
          } else {
            subagentHistory.push({
              callId: cid,
              at: o.timestamp || null,
              mode: results.length > 1 ? 'parallel' : 'single',
              agent: '',
              task: '',
              tasks: null,
              status: err ? 'error' : 'done',
              results: results.map((r) => ({
                agent: (r && (r.agent || r.name)) || 'subagent',
                status: r && r.error ? 'error' : 'done',
              })),
            });
          }
        }
      }
    }
  } catch (e) {
    return { error: e.message };
  }

  const allPending = [...pending.values()].sort((a, b) =>
    (a.at || '').localeCompare(b.at || '')
  );
  // Stale open toolCalls: session crashed/interrupted mid-tool — not really running
  const STALE_TOOL_MS = ACTIVE_MS; // 5 min
  const nowMs = Date.now();
  function callAgeMs(t) {
    if (!t.at) return Infinity;
    const ts = Date.parse(t.at);
    if (Number.isNaN(ts)) return Infinity;
    return nowMs - ts;
  }
  const openTools = allPending.filter((t) => callAgeMs(t) <= STALE_TOOL_MS);
  const staleTools = allPending.filter((t) => callAgeMs(t) > STALE_TOOL_MS);
  const openBatches = new Map();
  for (const t of openTools) {
    const k = t.batchId || 0;
    if (!openBatches.has(k)) openBatches.set(k, []);
    openBatches.get(k).push(t);
  }
  let parallelOpen = 0;
  let serialOpen = 0;
  for (const [, batch] of openBatches) {
    if (batch.length > 1) parallelOpen += batch.length;
    else serialOpen += 1;
  }

  // concurrency label for current open work
  let concurrency = 'idle';
  if (openTools.length === 0) {
    concurrency = 'idle';
  } else if (openTools.length === 1) {
    concurrency = 'serial'; // single in-flight tool
  } else {
    // multiple open: same batch => parallel; different turns => mixed/serial pipeline
    const batchIds = new Set(openTools.map((t) => t.batchId));
    if (batchIds.size === 1 && openTools[0].batchSize > 1) concurrency = 'parallel';
    else if (batchIds.size === 1) concurrency = 'serial';
    else concurrency = 'mixed'; // multiple waves still open (unusual)
  }

  // subagent open?
  const openSubagents = openTools.filter((t) => t.name === 'subagent');
  let subagentMode = null;
  if (openSubagents.length) {
    const a = openSubagents[0].arguments || {};
    if (Array.isArray(a.tasks) && a.tasks.length > 1) subagentMode = 'parallel';
    else if (openSubagents.length > 1) subagentMode = 'parallel';
    else subagentMode = 'serial';
  } else if (subagentHistory.length) {
    const last = subagentHistory[subagentHistory.length - 1];
    subagentMode = last.mode || null;
  }

  const todoList =
    lastTodo && Array.isArray(lastTodo.todos)
      ? lastTodo.todos.map((t) => ({
          id: t.id,
          text: t.text || '',
          done: !!t.done,
        }))
      : [];
  // only keep currently open todos for UI/API consumers that care about "current"
  const todoOpen = todoList.filter((t) => !t.done);
  const todoDone = todoList.filter((t) => t.done);

  const taskResult = {
    cwd,
    sessionId,
    provider,
    modelId,
    model: provider && modelId ? provider + '/' + modelId : modelId || provider || '',
    thinkingLevel,
    lastUser,
    // display goal: skip 批准执行 / 继续 / pasted 运行页
    lastTaskUser: lastTaskUser || '',
    lastAssistantText,
    lastTimestamp,
    lastEventKind,
    openTools,
    openCount: openTools.length,
    staleTools,
    staleCount: staleTools.length,
    doneToolCount,
    parallelOpen,
    serialOpen,
    concurrency,
    recentDone: recentDone.slice(-8),
    toolCounts,
    // progress for UI:
    // - if unfinished todos remain → todo progress
    // - else if tools activity → tools progress
    // - if todos all done but tools still open → tools progress (more accurate "now")
    progress: (() => {
      const openN = openTools.length;
      const toolsTotal = doneToolCount + openN;
      const toolsProgress =
        toolsTotal > 0
          ? {
              kind: 'tools',
              done: doneToolCount,
              total: toolsTotal,
              pct: (() => {
                let p = Math.floor((doneToolCount / toolsTotal) * 100);
                if (openN > 0 && p >= 100) p = 99;
                return p;
              })(),
              label: doneToolCount + ' 完成 · ' + openN + ' 进行中',
              current: openTools[0]
                ? openTools[0].name +
                  (openTools[0].summary ? ' · ' + openTools[0].summary : '')
                : '',
            }
          : null;

      if (todoOpen.length > 0 && todoList.length > 0) {
        return {
          kind: 'todo',
          done: todoDone.length,
          total: todoList.length,
          pct: Math.round((todoDone.length / todoList.length) * 100),
          label: todoDone.length + '/' + todoList.length + ' 步骤',
          current: todoOpen[0].text,
        };
      }
      if (toolsProgress) return toolsProgress;
      if (todoList.length > 0) {
        return {
          kind: 'todo',
          done: todoDone.length,
          total: todoList.length,
          pct: 100,
          label: todoDone.length + '/' + todoList.length + ' 步骤',
          current: '已全部完成',
        };
      }
      return { kind: 'none', done: 0, total: 0, pct: 0, label: '', current: '' };
    })(),
    todo: {
      total: todoList.length,
      done: todoDone.length,
      open: todoOpen.length,
      // items = only unfinished (current) todos
      items: todoOpen,
      allItems: todoList,
      focus: todoOpen[0] || null,
    },
    subagents: {
      mode: subagentMode,
      open: openSubagents.map((t) => ({
        id: t.id,
        summary: t.summary,
        arguments: t.arguments,
        at: t.at,
      })),
      recent: subagentHistory.slice(-8),
    },
    lines: lineNo,
  };

  if (parseCache.size >= PARSE_CACHE_MAX) {
    let i = 0;
    const drop = Math.floor(PARSE_CACHE_MAX / 4) || 1;
    for (const k of parseCache.keys()) {
      parseCache.delete(k);
      if (++i >= drop) break;
    }
  }
  parseCache.set(filePath, {
    mtimeMs: stMeta.mtimeMs,
    size: stMeta.size,
    task: taskResult,
  });
  return taskResult;
}

/**
 * Detect live pi-coding-agent processes.
 * jsonl has no exit event; without this, exited sessions stay "running" for minutes.
 * Multi-window caveat: we only know "any pi alive", not which session file maps to which PID.
 */
function listPiProcesses() {
  const now = Date.now();
  if (processProbeCache.data && processProbeCache.expires > now) {
    return processProbeCache.data;
  }

  const matches = [];
  try {
    if (process.platform === 'win32') {
      // PowerShell is more reliable than wmic for long CommandLine on modern Windows.
      const ps =
        "Get-CimInstance Win32_Process -Filter \"name='node.exe'\" | " +
        'Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress';
      const out = execFileSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', ps],
        { encoding: 'utf8', timeout: 4000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 }
      ).trim();
      if (out) {
        let rows = JSON.parse(out);
        if (!Array.isArray(rows)) rows = rows ? [rows] : [];
        for (const r of rows) {
          const cmd = String(r.CommandLine || '');
          if (!/pi-coding-agent|@earendil-works[\\/]pi-coding-agent/i.test(cmd)) continue;
          // skip manager/server noise if any
          if (/pi-manager|tools[\\/]scripts[\\/]pi-manager/i.test(cmd)) continue;
          matches.push({
            pid: Number(r.ProcessId) || 0,
            cmd: cmd.slice(0, 240),
          });
        }
      }
    } else {
      const out = execFileSync('ps', ['-ax', '-o', 'pid=,command='], {
        encoding: 'utf8',
        timeout: 3000,
        maxBuffer: 2 * 1024 * 1024,
      });
      for (const line of out.split(/\r?\n/)) {
        const m = line.trim().match(/^(\d+)\s+(.+)$/);
        if (!m) continue;
        const cmd = m[2];
        if (!/pi-coding-agent|@earendil-works[\/]pi-coding-agent/i.test(cmd)) continue;
        if (/pi-manager|tools[\/]scripts[\/]pi-manager/i.test(cmd)) continue;
        matches.push({ pid: Number(m[1]) || 0, cmd: cmd.slice(0, 240) });
      }
    }
  } catch {
    // probe failed — leave unknown; callers keep jsonl-only classification
    processProbeCache = {
      expires: now + PROCESS_PROBE_TTL_MS,
      data: { ok: false, count: 0, pids: [], processes: [] },
    };
    return processProbeCache.data;
  }

  const data = {
    ok: true,
    count: matches.length,
    pids: matches.map((m) => m.pid).filter(Boolean),
    processes: matches,
  };
  processProbeCache = { expires: now + PROCESS_PROBE_TTL_MS, data };
  return data;
}

/** When no pi process is alive, demote inferred live phases to exited. */
function applyProcessLiveness(phaseInfo, task, piLive) {
  if (!piLive || !piLive.ok) return phaseInfo; // probe failed: keep jsonl inference
  if (piLive.count > 0) return phaseInfo; // some pi still running; cannot map PID→session

  // No pi-coding-agent process at all → nothing is truly running
  if (
    phaseInfo.status === 'running' ||
    phaseInfo.phase === 'tools' ||
    phaseInfo.phase === 'subagent' ||
    phaseInfo.phase === 'thinking' ||
    phaseInfo.phase === 'answering'
  ) {
    return {
      status: 'recent',
      phase: 'exited',
      phaseLabel: '已退出',
      liveHint: '本机没有 Pi 进程，jsonl 还停在中途',
    };
  }
  if (phaseInfo.status === 'active' || phaseInfo.phase === 'stopped') {
    return {
      status: 'recent',
      phase: 'exited',
      phaseLabel: '已退出',
      liveHint: '',
    };
  }
  return phaseInfo;
}

/**
 * Prefer event timestamp over file mtime (mtime can lag or jump with partial flush).
 */
function activityAgeMs(task, mtimeMs, now) {
  let eventMs = 0;
  if (task && task.lastTimestamp) {
    const t = Date.parse(task.lastTimestamp);
    if (!Number.isNaN(t)) eventMs = t;
  }
  // max(event, mtime) as "last known activity" — never older than file touch
  const last = Math.max(eventMs || 0, mtimeMs || 0);
  return Math.max(0, now - last);
}

/**
 * phase: tools | subagent | thinking | answering | stopped | idle
 *
 * Important: Pi often writes the full assistant message only when the turn
 * (or tool batch) finishes. During streaming/thinking the jsonl may be quiet.
 * So after user / toolResult we keep "live" for minutes; after a completed
 * assistant text with no open tools we stop quickly (message already flushed).
 */
function classifyPhase(task, mtimeMs, now) {
  const age = activityAgeMs(task, mtimeMs, now);
  const hasOpen = (task.openCount || 0) > 0;
  const kind = task.lastEventKind || '';

  if (hasOpen) {
    const onlySub =
      task.openTools &&
      task.openTools.length > 0 &&
      task.openTools.every((t) => t.name === 'subagent');
    return {
      status: 'running',
      phase: onlySub ? 'subagent' : 'tools',
      phaseLabel: onlySub ? '子代理在跑' : '在调工具',
      liveHint: age > 60_000 ? '这步工具已经跑挺久了，可能还在干活' : '',
    };
  }

  // —— no open tools: use last event kind + grace windows ——

  // User just sent → agent may be thinking/streaming for a long time with no jsonl writes
  if (kind === 'user' && age <= AFTER_USER_LIVE_MS) {
    return {
      status: 'running',
      phase: 'thinking',
      phaseLabel: age < 15_000 ? '已收到，准备中' : '思考 / 生成中',
      liveHint:
        age > 20_000
          ? '界面可能暂时没动静，多半还在想或在慢慢输出'
          : '',
    };
  }

  // Tool finished → model usually continues; do NOT mark stopped after 12s
  if (kind === 'toolResult' && age <= AFTER_TOOL_RESULT_LIVE_MS) {
    return {
      status: 'running',
      phase: 'thinking',
      phaseLabel: '工具跑完了，还在继续',
      liveHint: age > 30_000 ? '看起来像卡住，其实多半还在想下一句' : '',
    };
  }

  if (kind === 'thinking' && age <= AFTER_THINKING_LIVE_MS) {
    return {
      status: 'running',
      phase: 'thinking',
      phaseLabel: '在想',
      liveHint: '',
    };
  }

  // toolCall logged but not in openTools (race / partial parse)
  if (kind === 'toolCall' && age <= AFTER_TOOLCALL_RACE_MS) {
    return {
      status: 'running',
      phase: 'tools',
      phaseLabel: '在调工具',
      liveHint: '',
    };
  }

  // Assistant message is usually written when the model finishes that chunk/turn.
  // Short window as "刚输出"; then treat as stopped waiting for user.
  if (kind === 'assistant') {
    if (age <= AFTER_ASSISTANT_STOP_MS) {
      return {
        status: 'running',
        phase: 'answering',
        phaseLabel: age <= 8_000 ? '刚说完' : '这轮回复结束了',
        liveHint: '',
      };
    }
    if (age <= ACTIVE_MS) {
      return {
        status: 'active',
        phase: 'stopped',
        phaseLabel: '停了，等你说话',
        liveHint: '',
      };
    }
  }

  // user event older than live window, or unknown quiet
  if (age <= ACTIVE_MS) {
    return {
      status: 'active',
      phase: 'stopped',
      phaseLabel: kind === 'user' ? '可能卡住或中断了' : '停了，等下一轮',
      liveHint: kind === 'user' ? '已经很久没动静，先按停下算' : '',
    };
  }
  if (age <= RECENT_MS) {
    return { status: 'recent', phase: 'stopped', phaseLabel: '已结束', liveHint: '' };
  }
  return { status: 'idle', phase: 'idle', phaseLabel: '空闲', liveHint: '' };
}

function collectRuntime(opts = {}) {
  const force = !!opts.force;
  const now = Date.now();
  if (!force && cache && cache.expires > now) {
    return { ...cache.data, cached: true };
  }

  const { root, files } = listSessionFiles();
  const detailN = Math.min(MAX_SESSIONS_DETAIL, Math.max(3, Number(opts.limit) || 10));
  const fullN = Math.min(MAX_FULL_PARSE, detailN);
  const piLive = listPiProcesses();

  // Prefer fully parsing recently touched files
  const candidates = files.slice(0, Math.max(fullN * 3, detailN));
  const sessions = [];

  for (let i = 0; i < candidates.length && sessions.length < detailN; i++) {
    const f = candidates[i];
    const age = now - f.mtimeMs;
    // skip very old for full parse budget except fill
    const doFull = i < fullN || age <= RECENT_MS;
    if (!doFull && sessions.length >= 5) continue;

    let task = null;
    if (doFull) {
      task = parseSessionTasks(f.abs);
      if (task.error) task = null;
    }

    let phaseInfo;
    if (task) {
      phaseInfo = classifyPhase(task, f.mtimeMs, now);
    } else if (age <= ACTIVE_MS) {
      phaseInfo = { status: 'active', phase: 'stopped', phaseLabel: '刚活跃' };
    } else if (age <= RECENT_MS) {
      phaseInfo = { status: 'recent', phase: 'stopped', phaseLabel: '已结束' };
    } else {
      phaseInfo = { status: 'idle', phase: 'idle', phaseLabel: '空闲' };
    }
    phaseInfo = applyProcessLiveness(phaseInfo, task, piLive);

    // No live pi: open tools are stale leftovers, not in-flight work
    let openTools = (task && task.openTools) || [];
    let openCount = (task && task.openCount) || 0;
    let concurrency = (task && task.concurrency) || 'idle';
    let progress = (task && task.progress) || null;
    if (piLive.ok && piLive.count === 0 && openCount > 0) {
      openTools = [];
      openCount = 0;
      concurrency = 'idle';
      if (progress && progress.kind === 'tools') {
        progress = {
          ...progress,
          done: progress.total || progress.done || 0,
          pct: 100,
          label: (progress.done || 0) + ' 完成 · 进程已退出',
          current: '',
        };
      }
    }

    const status = phaseInfo.status;

    // only keep running/active/recent by default; allow a couple idle for context
    if (status === 'idle' && sessions.filter((s) => s.status === 'idle').length >= 3) {
      continue;
    }

    sessions.push({
      id: (task && task.sessionId) || f.sessionId,
      fileName: f.fileName,
      relPath: f.relPath,
      cwd: (task && task.cwd) || decodeCwdKey(f.cwdKey),
      cwdKey: f.cwdKey,
      mtime: new Date(f.mtimeMs).toISOString(),
      mtimeMs: f.mtimeMs,
      ageMs: age,
      ageLabel: formatAge(age),
      size: f.size,
      sizeLabel: formatBytes(f.size),
      status,
      phase: phaseInfo.phase,
      phaseLabel: phaseInfo.phaseLabel,
      liveHint: phaseInfo.liveHint || '',
      activityAgeMs: task
        ? activityAgeMs(task, f.mtimeMs, now)
        : age,
      model: (task && task.model) || '',
      // task view
      // 真正任务文案：过滤「批准执行 / 继续 / 粘贴的运行页」
      currentTask: (task && task.lastTaskUser) || '',
      lastUserRaw: (task && task.lastUser) || '',
      running: status === 'running',
      concurrency: concurrency || (status === 'running' ? 'unknown' : 'idle'),
      openTools,
      openCount,
      openToolNames: openTools.map((t) => t.name),
      doneToolCount: (task && task.doneToolCount) || 0,
      progress: progress || {
        kind: 'none',
        done: 0,
        total: 0,
        pct: 0,
        label: '',
        current: '',
      },
      recentDone: (task && task.recentDone) || [],
      todo: (task && task.todo) || { total: 0, done: 0, open: 0, items: [], focus: null },
      subagents: (task && task.subagents) || { mode: null, open: [], recent: [] },
      lastAssistantText: (task && task.lastAssistantText) || '',
      lastEventKind: (task && task.lastEventKind) || '',
      toolCounts: (task && task.toolCounts) || {},
    });
  }

  // sort: running first, then active, recent, idle
  const rank = { running: 0, active: 1, recent: 2, idle: 3 };
  sessions.sort((a, b) => {
    const dr = (rank[a.status] ?? 9) - (rank[b.status] ?? 9);
    if (dr !== 0) return dr;
    return b.mtimeMs - a.mtimeMs;
  });

  const running = sessions.filter((s) => s.status === 'running');
  const active = sessions.filter((s) => s.status === 'active');
  const recent = sessions.filter((s) => s.status === 'recent');

  const focus = running[0] || active[0] || sessions[0] || null;

  const data = {
    scannedAt: new Date(now).toISOString(),
    sessionsDir: root,
    exists: fs.existsSync(root),
    view: 'tasks',
    piProcesses: {
      ok: piLive.ok,
      count: piLive.count,
      pids: piLive.pids,
    },
    thresholds: {
      activeMs: ACTIVE_MS,
      recentMs: RECENT_MS,
      note:
        'running=有未完成的 toolCall；并行=同一助手回合多个 toolCall 或 subagent.tasks[]；基于 jsonl 推断；无 Pi 进程时降为已退出',
    },
    totals: {
      files: files.length,
      shown: sessions.length,
      running: running.length,
      active: active.length,
      recent: recent.length,
      openTools: sessions.reduce((n, s) => n + (s.openCount || 0), 0),
      piProcesses: piLive.count,
    },
    focus,
    sessions,
    running,
  };

  cache = { expires: now + MEM_TTL_MS, data };
  return { ...data, cached: false };
}

function clearRuntimeCache() {
  cache = null;
  parseCache.clear();
}

function runtimeBriefText() {
  const r = collectRuntime({ limit: 10 });
  const lines = [];
  lines.push(
    `运行中 ${r.totals.running} · 近活跃 ${r.totals.active} · 打开中工具 ${r.totals.openTools}`
  );
  lines.push(r.thresholds.note);
  const focus = r.focus;
  if (!focus) {
    lines.push('当前没有可展示的会话任务。');
    return { text: lines.join('\n'), data: r };
  }
  lines.push('');
  lines.push(
    `焦点会话 [${focus.status}] ${focus.cwd || ''} · ${focus.model || '?'} · ${focus.ageLabel}`
  );
  if (focus.currentTask) lines.push(`用户任务：${focus.currentTask}`);
  if (focus.todo && focus.todo.focus) {
    lines.push(
      `Todo 焦点：${focus.todo.focus.text}（${focus.todo.done}/${focus.todo.total} 完成）`
    );
  }
  lines.push(`并发：${focus.concurrency} · 进行中工具 ${focus.openCount}`);
  for (const t of focus.openTools || []) {
    lines.push(`  → ${t.name}${t.batchSize > 1 ? ' ∥' + t.batchSize : ''}: ${t.summary || ''}`);
  }
  if (focus.subagents && focus.subagents.open && focus.subagents.open.length) {
    lines.push(`子代理进行中（${focus.subagents.mode || '?'}）：`);
    for (const s of focus.subagents.open) {
      lines.push(`  → ${s.summary || s.id}`);
    }
  } else if (focus.subagents && focus.subagents.recent && focus.subagents.recent.length) {
    const last = focus.subagents.recent[focus.subagents.recent.length - 1];
    lines.push(`最近子代理：${last.mode || ''} ${last.status || ''} ${last.agent || ''} ${last.task || ''}`);
  }
  return { text: lines.join('\n'), data: r };
}

module.exports = {
  collectRuntime,
  clearRuntimeCache,
  runtimeBriefText,
  parseSessionTasks,
  listPiProcesses,
  SESSIONS_DIR,
  ACTIVE_MS,
  RECENT_MS,
};
