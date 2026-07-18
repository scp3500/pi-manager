/**
 * Built-in tools for Pi + common subagent presets.
 * Built-ins from pi docs: read, bash, edit, write, grep, find, ls
 */

const BUILTIN_TOOLS = [
  { id: 'read', label: 'read', desc: '读文件', group: 'readonly' },
  { id: 'grep', label: 'grep', desc: '内容搜索', group: 'readonly' },
  { id: 'find', label: 'find', desc: '找文件', group: 'readonly' },
  { id: 'ls', label: 'ls', desc: '列目录', group: 'readonly' },
  { id: 'bash', label: 'bash', desc: '执行命令', group: 'exec' },
  { id: 'edit', label: 'edit', desc: '精确改文件', group: 'write' },
  { id: 'write', label: 'write', desc: '写/覆盖文件', group: 'write' },
];

/** @type {Record<string, {label: string, desc: string, tools: string[]}>} */
const TOOL_PRESETS = {
  readonly: {
    label: '只读',
    desc: 'read + 搜索，不执行不改文件',
    tools: ['read', 'grep', 'find', 'ls'],
  },
  diagnose: {
    label: '诊断',
    desc: '只读 + bash，可复现/跑命令',
    tools: ['read', 'grep', 'find', 'ls', 'bash'],
  },
  research: {
    label: '调研',
    desc: 'bash + read（搜网页/跑脚本）',
    tools: ['bash', 'read'],
  },
  coding: {
    label: '写码',
    desc: '全套内置工具',
    tools: ['read', 'grep', 'find', 'ls', 'bash', 'edit', 'write'],
  },
  minimal: {
    label: '最小',
    desc: '仅 read',
    tools: ['read'],
  },
  none: {
    label: '不限制',
    desc: '不写 tools 字段（继承默认全开）',
    tools: [],
  },
};

function parseToolsString(s) {
  if (!s) return [];
  if (Array.isArray(s)) return s.map(String).map((t) => t.trim()).filter(Boolean);
  return String(s)
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
}

function serializeTools(list) {
  if (!list || !list.length) return '';
  return list.join(', ');
}

function matchPreset(tools) {
  const set = new Set(parseToolsString(tools));
  if (set.size === 0) return 'none';
  for (const [id, preset] of Object.entries(TOOL_PRESETS)) {
    if (id === 'none') continue;
    const p = new Set(preset.tools);
    if (p.size === set.size && [...p].every((t) => set.has(t))) return id;
  }
  return 'custom';
}

module.exports = {
  BUILTIN_TOOLS,
  TOOL_PRESETS,
  parseToolsString,
  serializeTools,
  matchPreset,
};
