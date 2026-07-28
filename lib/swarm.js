const fs = require('fs');
const path = require('path');
const { SWARM_CONFIG_FILE, BACKUP_KEEP } = require('./config');
const { readModelsFile } = require('./models');

const KINDS = new Set(['investigator', 'implementer', 'reviewer']);
const TOOLS = new Set(['read', 'grep', 'find', 'ls']);
const THINKING = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const PRESETS = [
  {
    id: 'investigator',
    name: '调查者',
    kind: 'investigator',
    description: '定位问题、收集证据并提出可验证假设',
    capabilities: ['development', 'investigation'],
    tools: ['read', 'grep', 'find', 'ls'],
    thinkingLevel: 'high',
  },
  {
    id: 'implementer',
    name: '实现者',
    kind: 'implementer',
    description: '根据证据输出受控文件变更',
    capabilities: ['development', 'implementation'],
    tools: ['read', 'grep', 'find', 'ls'],
    thinkingLevel: 'high',
  },
  {
    id: 'reviewer-primary',
    name: '主评审',
    kind: 'reviewer',
    description: '独立检查正确性、回归和验收覆盖',
    capabilities: ['development', 'review'],
    tools: ['read', 'grep', 'find', 'ls'],
    thinkingLevel: 'high',
  },
  {
    id: 'reviewer-secondary',
    name: '复核评审',
    kind: 'reviewer',
    description: '从不同模型或视角独立复核风险',
    capabilities: ['development', 'review'],
    tools: ['read', 'grep', 'find', 'ls'],
    thinkingLevel: 'medium',
  },
];

function emptySwarmConfig() {
  return {
    version: 1,
    roles: [],
    verification: { executable: 'npm', args: ['test'], timeoutMs: 120000 },
    commitMessage: 'chore: apply pi-swarm changes',
  };
}

function readSwarmConfig() {
  if (!fs.existsSync(SWARM_CONFIG_FILE)) return emptySwarmConfig();
  let value;
  try {
    value = JSON.parse(fs.readFileSync(SWARM_CONFIG_FILE, 'utf8'));
  } catch (e) {
    throw new Error('swarm.json is not valid JSON: ' + e.message);
  }
  return validateConfig(value);
}

function writeSwarmConfig(value) {
  const config = validateConfig(value);
  const dir = path.dirname(SWARM_CONFIG_FILE);
  fs.mkdirSync(dir, { recursive: true });
  rotateBackups();
  const tmp = SWARM_CONFIG_FILE + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, SWARM_CONFIG_FILE);
  return config;
}

function validateConfig(value) {
  if (!value || typeof value !== 'object' || value.version !== 1) {
    throw new Error('swarm config version must be 1');
  }
  if (!Array.isArray(value.roles) || value.roles.length < 3 || value.roles.length > 5) {
    throw new Error('swarm roles must contain 3 to 5 people');
  }
  const roles = value.roles.map(validateRole);
  if (new Set(roles.map((role) => role.id)).size !== roles.length) {
    throw new Error('swarm role ids must be unique');
  }
  for (const kind of KINDS) {
    if (![...roles].some((role) => role.kind === kind)) throw new Error('swarm role kind is required: ' + kind);
  }
  const verification = value.verification;
  if (!verification || typeof verification !== 'object') throw new Error('verification is required');
  const executable = requiredId(verification.executable, 'verification executable');
  if (!Array.isArray(verification.args) || !verification.args.every((arg) => typeof arg === 'string')) {
    throw new Error('verification args must be an array');
  }
  const timeoutMs = positiveInt(verification.timeoutMs, 'verification timeoutMs');
  const commitMessage = requiredText(value.commitMessage, 'commit message');
  return { version: 1, roles, verification: { executable, args: [...verification.args], timeoutMs }, commitMessage };
}

function validateRole(value) {
  if (!value || typeof value !== 'object') throw new Error('each swarm role must be an object');
  const id = requiredId(value.id, 'role id');
  const kind = String(value.kind || '');
  if (!KINDS.has(kind)) throw new Error('invalid swarm role kind');
  const capabilities = stringList(value.capabilities, 'capabilities');
  if (!capabilities.length) throw new Error('role capabilities are required');
  const tools = stringList(value.tools, 'tools');
  if (tools.some((tool) => !TOOLS.has(tool))) throw new Error('swarm roles only allow read, grep, find, and ls');
  const thinkingLevel = String(value.thinkingLevel || 'medium');
  if (!THINKING.has(thinkingLevel)) throw new Error('invalid role thinking level');
  return {
    id,
    name: requiredText(value.name, 'role name'),
    kind,
    description: requiredText(value.description, 'role description'),
    capabilities,
    model: validateModelBinding(value.model),
    tools,
    thinkingLevel,
    contextCapacity: positiveInt(value.contextCapacity, 'context capacity'),
    maxActiveMissions: positiveInt(value.maxActiveMissions, 'max active missions'),
  };
}

function validateModelBinding(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.fallbacks)) {
    throw new Error('role model binding is required');
  }
  return { primary: modelFromReference(value.primary), fallbacks: value.fallbacks.map(modelFromReference) };
}

function modelFromReference(value) {
  const ref = typeof value === 'string' ? value : value && value.provider + '/' + value.modelId;
  const slash = String(ref || '').indexOf('/');
  if (slash < 1) throw new Error('model must use provider/model format');
  const provider = ref.slice(0, slash);
  const modelId = ref.slice(slash + 1);
  const models = readModelsFile();
  const entry = models.providers?.[provider]?.models?.find((model) => model && model.id === modelId);
  if (!entry) throw new Error('swarm model does not exist in Pi models.json: ' + ref);
  const cost = entry.cost;
  const rates = cost && {
    input: Number(cost.input) || 0,
    output: Number(cost.output) || 0,
    ...(cost.cacheRead == null ? {} : { cacheRead: Number(cost.cacheRead) || 0 }),
    ...(cost.cacheWrite == null ? {} : { cacheWrite: Number(cost.cacheWrite) || 0 }),
  };
  const free = rates && Object.values(rates).every((rate) => rate === 0);
  return {
    provider,
    modelId,
    costClass: free ? 'free' : rates ? 'paid' : 'unknown',
    ...(rates ? { cost: rates } : {}),
  };
}

function rotateBackups() {
  if (!fs.existsSync(SWARM_CONFIG_FILE)) return;
  const first = SWARM_CONFIG_FILE + '.bak';
  for (let index = BACKUP_KEEP - 1; index >= 1; index -= 1) {
    const from = index === 1 ? first : SWARM_CONFIG_FILE + '.bak.' + (index - 1);
    const to = SWARM_CONFIG_FILE + '.bak.' + index;
    if (fs.existsSync(from)) fs.copyFileSync(from, to);
  }
  fs.copyFileSync(SWARM_CONFIG_FILE, first);
}

function requiredText(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(name + ' is required');
  return value.trim();
}

function requiredId(value, name) {
  const text = requiredText(value, name);
  if (!/^[a-zA-Z0-9_.-]+$/.test(text)) throw new Error(name + ' contains invalid characters');
  return text;
}

function stringList(value, name) {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string' && item.trim())) {
    throw new Error(name + ' must be a string array');
  }
  return [...new Set(value.map((item) => item.trim()))];
}

function positiveInt(value, name) {
  if (!Number.isInteger(value) || value < 1) throw new Error(name + ' must be a positive integer');
  return value;
}

module.exports = { PRESETS, emptySwarmConfig, readSwarmConfig, writeSwarmConfig, validateConfig, modelFromReference };
