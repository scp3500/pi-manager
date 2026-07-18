/**
 * Manager embedded chat — session storage (isolated from Pi sessions jsonl).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PI_AGENT_DIR } = require('./config');
const { listAllModels } = require('./models');
const { getDefaults } = require('./settings');

const CHAT_DIR = path.join(PI_AGENT_DIR, 'cache', 'manager-chat');
const INDEX_FILE = path.join(CHAT_DIR, 'index.json');

const ID_RE = /^[a-f0-9-]{8,64}$/i;

function ensureDir() {
  if (!fs.existsSync(CHAT_DIR)) fs.mkdirSync(CHAT_DIR, { recursive: true });
}

function newId() {
  return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
}

function nowIso() {
  return new Date().toISOString();
}

function validateSessionId(id) {
  const s = String(id || '').trim();
  if (!ID_RE.test(s)) {
    const err = new Error('invalid session id');
    err.status = 400;
    throw err;
  }
  return s;
}

function sessionPath(id) {
  const safe = validateSessionId(id);
  const file = path.resolve(CHAT_DIR, safe + '.json');
  const prefix = CHAT_DIR.endsWith(path.sep) ? CHAT_DIR : CHAT_DIR + path.sep;
  if (!file.startsWith(prefix) && file !== path.join(CHAT_DIR, safe + '.json')) {
    const err = new Error('invalid path');
    err.status = 400;
    throw err;
  }
  return file;
}

function readIndex() {
  ensureDir();
  if (!fs.existsSync(INDEX_FILE)) return { sessions: [], lastProvider: '', lastModel: '' };
  try {
    const data = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8'));
    if (!data || typeof data !== 'object') return { sessions: [], lastProvider: '', lastModel: '' };
    if (!Array.isArray(data.sessions)) data.sessions = [];
    if (data.lastProvider == null) data.lastProvider = '';
    if (data.lastModel == null) data.lastModel = '';
    return data;
  } catch {
    return { sessions: [], lastProvider: '', lastModel: '' };
  }
}

function writeIndex(index) {
  ensureDir();
  const json = JSON.stringify(index, null, 2) + '\n';
  const tmp = INDEX_FILE + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, json, 'utf8');
  fs.renameSync(tmp, INDEX_FILE);
}

function atomicWriteJson(file, obj) {
  ensureDir();
  const json = JSON.stringify(obj, null, 2) + '\n';
  const tmp = file + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, json, 'utf8');
  fs.renameSync(tmp, file);
}

function listChatModels() {
  const models = listAllModels();
  const defaults = getDefaults();
  const last = getLastUsedModel();
  const preferred = resolveDefaultModel('', '');
  return {
    models,
    defaults: {
      provider: defaults.defaultProvider || '',
      model: defaults.defaultModel || '',
    },
    lastUsed: {
      provider: last.provider || '',
      model: last.model || '',
    },
    preferred: {
      provider: preferred.provider || '',
      model: preferred.model || '',
    },
  };
}

function getLastUsedModel() {
  const index = readIndex();
  return {
    provider: String(index.lastProvider || '').trim(),
    model: String(index.lastModel || '').trim(),
  };
}

function setLastUsedModel(provider, model) {
  const p = String(provider || '').trim();
  const m = String(model || '').trim();
  if (!p || !m) return getLastUsedModel();
  const index = readIndex();
  index.lastProvider = p;
  index.lastModel = m;
  writeIndex(index);
  return { provider: p, model: m };
}

function resolveDefaultModel(provider, model) {
  const defaults = getDefaults();
  const last = getLastUsedModel();
  let p = String(provider || last.provider || defaults.defaultProvider || '').trim();
  let m = String(model || last.model || defaults.defaultModel || '').trim();
  if ((!p || !m) && modelsHasAny()) {
    const first = listAllModels()[0];
    if (first) {
      if (!p) p = first.providerId;
      if (!m) m = first.modelId;
    }
  }
  return { provider: p, model: m };
}

function modelsHasAny() {
  return listAllModels().length > 0;
}

function listSessions() {
  const index = readIndex();
  const sessions = (index.sessions || [])
    .slice()
    .sort((a, b) => {
      if (!!b.pinned !== !!a.pinned) return b.pinned ? 1 : -1;
      return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
    });
  return { sessions };
}

function createSession(opts = {}) {
  const { provider, model } = resolveDefaultModel(opts.provider, opts.model);
  const id = newId();
  const ts = nowIso();
  const session = {
    id,
    title: String(opts.title || '').trim() || '新对话',
    provider,
    model,
    systemPrompt: null,
    createdAt: ts,
    updatedAt: ts,
    messages: [],
  };
  atomicWriteJson(sessionPath(id), session);

  const index = readIndex();
  index.sessions.unshift({
    id,
    title: session.title,
    provider,
    model,
    createdAt: ts,
    updatedAt: ts,
    pinned: false,
  });
  writeIndex(index);
  return session;
}

function getSession(id) {
  const file = sessionPath(id);
  if (!fs.existsSync(file)) {
    const err = new Error('not found');
    err.status = 404;
    throw err;
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    const err = new Error('session file corrupt: ' + e.message);
    err.status = 500;
    throw err;
  }
}

function saveSession(session) {
  if (!session || !session.id) throw new Error('invalid session');
  session.updatedAt = nowIso();
  atomicWriteJson(sessionPath(session.id), session);

  const index = readIndex();
  const entry = {
    id: session.id,
    title: session.title || '新对话',
    provider: session.provider || '',
    model: session.model || '',
    createdAt: session.createdAt || session.updatedAt,
    updatedAt: session.updatedAt,
    pinned: false,
  };
  const i = index.sessions.findIndex((s) => s.id === session.id);
  if (i >= 0) {
    entry.pinned = !!index.sessions[i].pinned;
    entry.createdAt = index.sessions[i].createdAt || entry.createdAt;
    index.sessions[i] = entry;
  } else {
    index.sessions.unshift(entry);
  }
  // remember last used model globally for new sessions
  if (session.provider && session.model) {
    index.lastProvider = String(session.provider);
    index.lastModel = String(session.model);
  }
  writeIndex(index);
  return session;
}

function patchSession(id, patch = {}) {
  const session = getSession(id);
  if (patch.title != null) session.title = String(patch.title).trim() || session.title;
  if (patch.provider != null) session.provider = String(patch.provider).trim();
  if (patch.model != null) session.model = String(patch.model).trim();
  if (patch.pinned != null) {
    const index = readIndex();
    const i = index.sessions.findIndex((s) => s.id === session.id);
    if (i >= 0) {
      index.sessions[i].pinned = !!patch.pinned;
      writeIndex(index);
    }
  }
  return saveSession(session);
}

function deleteSession(id) {
  const file = sessionPath(id);
  if (fs.existsSync(file)) fs.unlinkSync(file);
  const index = readIndex();
  index.sessions = (index.sessions || []).filter((s) => s.id !== id);
  writeIndex(index);
  return { ok: true, id };
}

function appendMessage(session, msg) {
  if (!session.messages) session.messages = [];
  session.messages.push(msg);
  return saveSession(session);
}

function updateMessage(session, messageId, patch) {
  const m = (session.messages || []).find((x) => x.id === messageId);
  if (!m) {
    const err = new Error('message not found');
    err.status = 404;
    throw err;
  }
  Object.assign(m, patch);
  return saveSession(session);
}

/** Truncate messages after a message id (inclusive remove after, keep the id itself unless dropFrom=true). */
function truncateAfter(session, messageId, { dropFrom = false } = {}) {
  const msgs = session.messages || [];
  const idx = msgs.findIndex((m) => m.id === messageId);
  if (idx < 0) {
    const err = new Error('message not found');
    err.status = 404;
    throw err;
  }
  session.messages = msgs.slice(0, dropFrom ? idx : idx + 1);
  return saveSession(session);
}

/** Remove message and everything after it. */
function truncateFrom(session, messageId) {
  return truncateAfter(session, messageId, { dropFrom: true });
}

function makeMessage(role, content, extra = {}) {
  return {
    id: newId(),
    role,
    content: content == null ? '' : String(content),
    reasoning: '',
    createdAt: nowIso(),
    finishedAt: null,
    usage: null,
    status: 'done',
    error: null,
    tools: [],
    ...extra,
  };
}

function DEFAULT_SYSTEM_PROMPT() {
  let toolsAppendix = '';
  try {
    toolsAppendix = require('./chat-tools').toolsSystemAppendix();
  } catch {
    toolsAppendix = '';
  }
  return [
    '你是 Pi Manager 控制台内嵌助手，帮助用户了解与管理本机 Pi 配置、模型、用量与资源。',
    '你可以正常聊天；改配置/删文件/执行命令请引导用户用控制台页面或终端 Pi，不要假装已修改。',
    '回答简洁、准确；报用量/费用时只给数据，不要展开币种或换汇说明。',
    '复杂编码与文件操作应建议用户使用终端 Pi Coding Agent。',
    toolsAppendix,
  ]
    .filter(Boolean)
    .join('\n');
}

module.exports = {
  CHAT_DIR,
  listChatModels,
  listSessions,
  createSession,
  getSession,
  saveSession,
  patchSession,
  deleteSession,
  appendMessage,
  updateMessage,
  truncateAfter,
  truncateFrom,
  makeMessage,
  newId,
  nowIso,
  resolveDefaultModel,
  getLastUsedModel,
  setLastUsedModel,
  DEFAULT_SYSTEM_PROMPT,
};
