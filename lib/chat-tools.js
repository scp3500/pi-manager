/**
 * Manager chat tools (read + confirm-gated write).
 */
const crypto = require('crypto');
const { getDefaults, setDefaults } = require('./settings');
const { listAllModels, listProviders, providerExists, getModel } = require('./models');
const usageApi = require('./usage');
const opsApi = require('./ops');
const sessionsApi = require('./sessions');
const filesApi = require('./files');
const workspaces = require('./workspaces');
const runtimeApi = require('./runtime');

/** @type {Map<string, { name: string, args: object, createdAt: number }>} */
const pendingWrites = new Map();
const PENDING_TTL_MS = 10 * 60 * 1000;

function newConfirmId() {
  return crypto.randomBytes(12).toString('hex');
}

function purgePending() {
  const now = Date.now();
  for (const [id, p] of pendingWrites) {
    if (now - p.createdAt > PENDING_TTL_MS) pendingWrites.delete(id);
  }
}

function stageWrite(name, args) {
  purgePending();
  const id = newConfirmId();
  pendingWrites.set(id, { name, args: args || {}, createdAt: Date.now() });
  return id;
}

const TOOLS = [
  {
    name: 'help',
    description: '列出可用只读命令与工具',
    slash: ['/help', '/?'],
    callable: false,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_defaults',
    description: '读取 Pi settings 中的默认模型（defaultProvider / defaultModel / thinking）',
    slash: ['/defaults', '/default'],
    callable: true,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'list_models_brief',
    description: '列出已配置的供应商与模型摘要（来自 models.json）',
    slash: ['/models', '/model'],
    callable: true,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'usage_summary',
    description: '汇总 Pi 会话用量与费用。window: today|week|month|all。准确简洁回报数据即可。',
    slash: ['/usage', '/cost'],
    callable: true,
    parameters: {
      type: 'object',
      properties: {
        window: {
          type: 'string',
          enum: ['today', 'week', 'month', 'all'],
          description: '时间窗口，默认 today',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'health_check',
    description: '运行本机 Pi Manager 健康检查：配置文件、默认模型、供应商 Key/URL、工作区映射等',
    slash: ['/health', '/status'],
    callable: true,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'search_workspace',
    description: '在提示词、记忆、知识库、子代理、Skills 等文本中全文搜索关键词（至少 2 字）',
    slash: ['/search', '/find'],
    callable: true,
    parameters: {
      type: 'object',
      properties: {
        q: { type: 'string', description: '搜索关键词' },
        limit: { type: 'integer', description: '最多返回条数，默认 12' },
      },
      required: ['q'],
      additionalProperties: false,
    },
  },
  {
    name: 'sessions_brief',
    description: 'Pi 终端会话目录数量、总体积与最近会话摘要（非 Manager 内嵌聊天）',
    slash: ['/sessions', '/session'],
    callable: true,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'set_default_model',
    description:
      '将 Pi 默认模型改为指定 provider + model（写 settings.json）。需要用户确认后才会真正写入。',
    slash: ['/set-default', '/setdefault'],
    callable: true,
    write: true,
    parameters: {
      type: 'object',
      properties: {
        provider: { type: 'string', description: '供应商 id，如 mzhcloud' },
        model: { type: 'string', description: '模型 id，如 grok-4.5' },
        thinkingLevel: {
          type: 'string',
          description: '可选思考级别，如 high / medium / low / off',
        },
      },
      required: ['provider', 'model'],
      additionalProperties: false,
    },
  },
  {
    name: 'cleanup_junk',
    description:
      '清理 Pi 配置目录下临时/备份垃圾文件。mode: tmp|bak|bak_old|all。默认先 dryRun 预览；真正删除需用户确认。',
    slash: ['/cleanup'],
    callable: true,
    write: true,
    parameters: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['tmp', 'bak', 'bak_old', 'all'],
          description: 'tmp 临时文件；bak 全部备份；bak_old 滚动备份；all=tmp+bak_old',
        },
        dryRun: {
          type: 'boolean',
          description: 'true 仅预览（默认 true）；false 表示准备删除（仍需用户确认）',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'runtime_brief',
    description:
      '查看当前活跃/最近的 Pi 终端会话（基于 jsonl 写入时间启发式，非进程实时），含模型与子代理痕迹',
    slash: ['/runtime', '/windows'],
    callable: true,
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'list_trash',
    description: '列出工作区回收站（.trash）条目，便于还原',
    slash: ['/trash'],
    callable: true,
    parameters: {
      type: 'object',
      properties: {
        workspaceId: {
          type: 'string',
          description: '工作区 id，默认第一个可用工作区',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'restore_trash',
    description: '从回收站还原指定 stamp。需要用户确认后才会还原。',
    slash: ['/restore'],
    callable: true,
    write: true,
    parameters: {
      type: 'object',
      properties: {
        workspaceId: { type: 'string', description: '工作区 id' },
        stamp: { type: 'string', description: '回收站条目 stamp' },
      },
      required: ['stamp'],
      additionalProperties: false,
    },
  },
];

function listTools() {
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    slash: t.slash,
    callable: t.callable !== false,
    write: !!t.write,
  }));
}

/** OpenAI-compatible tools array for chat completions function calling */
function openAITools() {
  return TOOLS.filter((t) => t.callable !== false).map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters || { type: 'object', properties: {} },
    },
  }));
}

function isCallableTool(name) {
  const t = TOOLS.find((x) => x.name === name);
  return !!(t && t.callable !== false);
}

function isWriteTool(name) {
  const t = TOOLS.find((x) => x.name === name);
  return !!(t && t.write);
}

function defaultWorkspaceId(preferred) {
  if (preferred) return String(preferred);
  try {
    const list = workspaces.listWorkspaces && workspaces.listWorkspaces();
    const arr = (list && list.workspaces) || list || [];
    if (Array.isArray(arr) && arr[0]) return arr[0].id;
  } catch {
    /* ignore */
  }
  return 'pi-home';
}

/**
 * Parse leading slash command.
 * @returns {{ name: string, args: object, raw: string } | null}
 */
function parseSlash(content) {
  const text = String(content || '').trim();
  if (!text.startsWith('/')) return null;
  const m = text.match(/^\/([a-zA-Z0-9_?]+)(?:\s+([\s\S]*))?$/);
  if (!m) return null;
  const cmd = m[1].toLowerCase();
  const rest = (m[2] || '').trim();

  for (const t of TOOLS) {
    for (const s of t.slash) {
      const key = s.slice(1).toLowerCase();
      if (cmd === key || (key === '?' && cmd === '?')) {
        return { name: t.name, args: argsForTool(t.name, rest), raw: text };
      }
    }
  }
  return { name: 'unknown', args: { cmd, rest }, raw: text };
}

function argsForTool(name, rest) {
  if (name === 'usage_summary') {
    const w = (rest || 'today').toLowerCase();
    const window = ['today', 'week', 'month', 'all'].includes(w) ? w : 'today';
    return { window };
  }
  if (name === 'search_workspace') {
    return { q: rest, limit: 12 };
  }
  if (name === 'set_default_model') {
    // /set-default provider/model [thinking]
    const parts = String(rest || '').trim().split(/\s+/).filter(Boolean);
    const pm = parts[0] || '';
    if (pm.includes('/')) {
      const i = pm.indexOf('/');
      return {
        provider: pm.slice(0, i),
        model: pm.slice(i + 1),
        thinkingLevel: parts[1] || undefined,
      };
    }
    return { provider: parts[0] || '', model: parts[1] || '', thinkingLevel: parts[2] };
  }
  if (name === 'cleanup_junk') {
    const mode = (rest || 'tmp').trim() || 'tmp';
    return { mode, dryRun: true };
  }
  if (name === 'list_trash') {
    return rest ? { workspaceId: rest } : {};
  }
  if (name === 'restore_trash') {
    const parts = String(rest || '').trim().split(/\s+/).filter(Boolean);
    if (parts.length >= 2) return { workspaceId: parts[0], stamp: parts[1] };
    return { stamp: parts[0] || '' };
  }
  return rest ? { text: rest } : {};
}

async function runTool(name, args = {}) {
  const started = Date.now();
  try {
    let data;
    switch (name) {
      case 'help':
        data = {
          commands: TOOLS.map((t) => ({
            slash: t.slash[0],
            aliases: t.slash.slice(1),
            description: t.description,
            write: !!t.write,
          })),
          note: '写操作会先预览并需点「确认执行」；也可用自然语言让模型自动调工具。',
        };
        break;
      case 'get_defaults':
        data = getDefaults();
        break;
      case 'list_models_brief': {
        const models = listAllModels();
        const providers = listProviders().map((p) => ({
          id: p.id,
          name: p.name || p.id,
          modelCount: (p.models && p.models.length) || 0,
          baseUrl: p.baseUrl || '',
        }));
        data = {
          defaults: getDefaults(),
          providerCount: providers.length,
          modelCount: models.length,
          providers,
          models: models.slice(0, 40).map((m) => ({
            id: m.id,
            name: m.name,
            reasoning: !!m.reasoning,
          })),
          truncated: models.length > 40,
        };
        break;
      }
      case 'usage_summary': {
        const window = args.window || 'today';
        const report = usageApi.collectUsage({ window });
        data = {
          window: report.window,
          windowLabel: report.windowLabel,
          costTotal: report.costTotal,
          totalTokens: report.totalTokens,
          input: report.input,
          output: report.output,
          cacheRead: report.cacheRead,
          cacheHitRate: report.cacheHitRate,
          requests: report.requests,
          sessions: report.sessions,
          mainCost: report.mainCost,
          subagentCost: report.subagentCost,
          snapshots: report.snapshots,
          topModels: (report.models || []).slice(0, 8).map((m) => ({
            id: m.id || m.model || m.key,
            cost: m.costTotal ?? m.cost,
            tokens: m.totalTokens ?? m.tokens,
            requests: m.requests,
          })),
          note: '',
        };
        break;
      }
      case 'health_check': {
        const h = await opsApi.runHealth();
        data = {
          healthy: h.summary.healthy,
          ok: h.summary.ok,
          fail: h.summary.fail,
          total: h.summary.total,
          defaults: h.defaults,
          counts: h.counts,
          failures: (h.failures || []).slice(0, 20).map((c) => ({
            id: c.id,
            message: c.message,
          })),
          checkedAt: h.checkedAt,
        };
        break;
      }
      case 'search_workspace': {
        const q = String(args.q || args.text || '').trim();
        if (!q || q.length < 2) {
          const err = new Error('搜索词至少 2 个字符，例如 /search 用量');
          err.status = 400;
          throw err;
        }
        const r = opsApi.searchAll({ q, limit: args.limit || 12, scope: args.scope || 'all' });
        data = {
          q,
          total: r.total != null ? r.total : (r.hits || r.results || []).length,
          hits: (r.hits || r.results || r.items || []).slice(0, 12).map((hit) => ({
            source: hit.source,
            title: hit.title,
            path: hit.path,
            snippet: hit.snippet,
            href: hit.href,
            match: hit.match,
          })),
        };
        break;
      }
      case 'sessions_brief': {
        let summary = null;
        if (typeof sessionsApi.getSessionsSummary === 'function') {
          summary = sessionsApi.getSessionsSummary();
        } else {
          const list = sessionsApi.listSessions({ limit: 5 });
          summary = {
            exists: list.exists !== false,
            total: list.total,
            totalSizeLabel: list.totalSizeLabel || formatBytes(list.totalBytes || 0),
            sessionsDir: list.sessionsDir,
          };
        }
        const list = sessionsApi.listSessions({ limit: 8, offset: 0 });
        data = {
          ...summary,
          recent: (list.items || []).slice(0, 8).map((it) => ({
            id: it.id || it.sessionId,
            cwd: it.cwd || it.cwdKey,
            name: it.name || it.fileName,
            sizeLabel: it.sizeLabel || formatBytes(it.size || it.bytes || 0),
            mtime: it.mtime || it.updatedAt,
          })),
        };
        break;
      }
      case 'runtime_brief': {
        const brief = runtimeApi.runtimeBriefText();
        data = {
          text: brief.text,
          totals: brief.data && brief.data.totals,
          thresholds: brief.data && brief.data.thresholds,
          active: (brief.data && brief.data.active) || [],
          recent: (brief.data && brief.data.recent) || [],
        };
        break;
      }
      case 'list_trash': {
        const workspaceId = defaultWorkspaceId(args.workspaceId);
        const listed = filesApi.listTrash(workspaceId);
        data = {
          workspaceId,
          count: listed.count || (listed.items || []).length,
          items: (listed.items || []).slice(0, 20).map((it) => ({
            stamp: it.stamp,
            originalRel: it.originalRel,
            type: it.type,
            size: it.size,
            mtime: it.mtime,
          })),
        };
        break;
      }
      case 'set_default_model': {
        const provider = String(args.provider || '').trim();
        const model = String(args.model || '').trim();
        if (!provider || !model) {
          const err = new Error('需要 provider 与 model，例如 /set-default mzhcloud/grok-4.5');
          err.status = 400;
          throw err;
        }
        if (!providerExists(provider)) {
          const err = new Error('供应商不存在: ' + provider);
          err.status = 400;
          throw err;
        }
        try {
          getModel(provider, model);
        } catch {
          const err = new Error('模型不存在: ' + provider + '/' + model);
          err.status = 400;
          throw err;
        }
        const before = getDefaults();
        const after = {
          defaultProvider: provider,
          defaultModel: model,
          defaultThinkingLevel:
            args.thinkingLevel != null && args.thinkingLevel !== ''
              ? String(args.thinkingLevel)
              : before.defaultThinkingLevel || '',
        };
        const confirmId = stageWrite('set_default_model', {
          provider,
          model,
          thinkingLevel: args.thinkingLevel,
        });
        data = {
          needsConfirm: true,
          confirmId,
          action: 'set_default_model',
          before,
          after,
          diffKind: 'settings',
          diffOld: formatDefaultsBlock(before),
          diffNew: formatDefaultsBlock(after),
          summary:
            '将默认模型从 ' +
            (before.defaultProvider || '?') +
            '/' +
            (before.defaultModel || '?') +
            ' 改为 ' +
            provider +
            '/' +
            model,
        };
        break;
      }
      case 'cleanup_junk': {
        const mode = String(args.mode || 'tmp');
        const dryRun = args.dryRun !== false; // default true
        const preview = sessionsApi.cleanupJunk({ mode, dryRun: true });
        const files = preview.files || [];
        const listText =
          files.length > 0
            ? files.map((f) => '- ' + f).join('\n')
            : '(没有匹配文件)';
        if (dryRun && (preview.count || 0) === 0) {
          data = {
            ...preview,
            needsConfirm: false,
            diffKind: 'list',
            diffOld: '将删除的文件：\n(无)',
            diffNew: '将删除的文件：\n' + listText,
            summary: '没有可清理的文件（mode=' + mode + '）',
          };
        } else {
          const confirmId = stageWrite('cleanup_junk', { mode, dryRun: false });
          data = {
            ...preview,
            needsConfirm: true,
            confirmId,
            action: 'cleanup_junk',
            preview,
            diffKind: 'list',
            diffOld: '当前：保留这些垃圾文件\n' + listText,
            diffNew:
              '确认后：删除 ' +
              (preview.count || 0) +
              ' 个文件（' +
              (preview.freedLabel || '') +
              '）\n' +
              listText,
            summary:
              '将删除 ' +
              (preview.count || 0) +
              ' 个文件（' +
              (preview.freedLabel || '') +
              '），mode=' +
              mode,
          };
        }
        break;
      }
      case 'restore_trash': {
        const workspaceId = defaultWorkspaceId(args.workspaceId);
        const stamp = String(args.stamp || '').trim();
        if (!stamp) {
          const err = new Error('需要 stamp，可先 /trash 查看');
          err.status = 400;
          throw err;
        }
        const listed = filesApi.listTrash(workspaceId);
        const item = (listed.items || []).find((x) => x.stamp === stamp || x.legacyName === stamp);
        const confirmId = stageWrite('restore_trash', { workspaceId, stamp });
        const rel = (item && item.originalRel) || stamp;
        data = {
          needsConfirm: true,
          confirmId,
          action: 'restore_trash',
          workspaceId,
          stamp,
          item: item || null,
          diffKind: 'path',
          diffOld:
            '回收站\n  workspace: ' +
            workspaceId +
            '\n  stamp: ' +
            stamp +
            '\n  path: ' +
            rel +
            (item && item.type ? '\n  type: ' + item.type : ''),
          diffNew:
            '还原后\n  workspace: ' +
            workspaceId +
            '\n  restored: ' +
            rel +
            '\n  从 .trash 移回原路径',
          summary: '将从回收站还原 ' + rel + '（工作区 ' + workspaceId + '）',
        };
        break;
      }
      case 'unknown': {
        const err = new Error('未知命令 /' + (args.cmd || '') + '，输入 /help 查看');
        err.status = 400;
        throw err;
      }
      default: {
        const err = new Error('未知工具: ' + name);
        err.status = 400;
        throw err;
      }
    }
    return {
      ok: true,
      name,
      args,
      ms: Date.now() - started,
      data,
      text: formatToolText(name, data),
      needsConfirm: !!(data && data.needsConfirm),
      confirmId: data && data.confirmId,
    };
  } catch (e) {
    return {
      ok: false,
      name,
      args,
      ms: Date.now() - started,
      error: e.message || String(e),
      text: '工具失败: ' + (e.message || e),
    };
  }
}

function formatBytes(n) {
  const x = Number(n) || 0;
  if (x < 1024) return x + ' B';
  if (x < 1024 * 1024) return (x / 1024).toFixed(1) + ' KB';
  return (x / 1024 / 1024).toFixed(1) + ' MB';
}

function formatDefaultsBlock(d) {
  const o = d || {};
  return [
    'defaultProvider: ' + (o.defaultProvider || ''),
    'defaultModel: ' + (o.defaultModel || ''),
    'defaultThinkingLevel: ' + (o.defaultThinkingLevel || ''),
  ].join('\n');
}

function formatToolText(name, data) {
  if (!data) return '';
  if (name === 'help') {
    return (
      '可用命令：\n' +
      data.commands.map((c) => `• ${c.slash} — ${c.description}`).join('\n') +
      '\n\n' +
      (data.note || '写操作需在界面确认后才会执行。')
    );
  }
  if (data.needsConfirm) {
    return (
      (data.summary || '待确认写操作') +
      '\n确认后才会执行。confirmId=' +
      (data.confirmId || '')
    );
  }
  if (name === 'runtime_brief') {
    return data.text || JSON.stringify(data.totals || {});
  }
  if (name === 'list_trash') {
    if (!data.items || !data.items.length) return '回收站为空（' + data.workspaceId + '）';
    return (
      '回收站 ' +
      data.workspaceId +
      ' · ' +
      data.count +
      ' 条：\n' +
      data.items
        .map((it, i) => `${i + 1}. ${it.stamp} → ${it.originalRel || '(未知)'} (${it.type || 'file'})`)
        .join('\n')
    );
  }
  if (name === 'get_defaults') {
    const p = data.defaultProvider || '（空）';
    const m = data.defaultModel || '（空）';
    const t = data.defaultThinkingLevel || '（未设）';
    return `默认模型：${p}/${m}\n思考级别：${t}`;
  }
  if (name === 'list_models_brief') {
    const lines = [
      `供应商 ${data.providerCount} · 模型 ${data.modelCount}`,
      `默认：${data.defaults.defaultProvider || '?'}/${data.defaults.defaultModel || '?'}`,
      '',
      '模型列表（最多 40）：',
      ...data.models.map((m) => `• ${m.id}${m.reasoning ? ' · think' : ''}`),
    ];
    if (data.truncated) lines.push('…已截断');
    return lines.join('\n');
  }
  if (name === 'usage_summary') {
    const s = data.snapshots || {};
    const fmt = (x) => (x == null ? '-' : Number(x).toFixed(4));
    return [
      `用量窗口：${data.windowLabel || data.window}`,
      `费用合计：${fmt(data.costTotal)}`,
      `Tokens：${data.totalTokens || 0}（in ${data.input || 0} / out ${data.output || 0}）`,
      `请求 ${data.requests || 0} · 会话 ${data.sessions || 0} · 缓存命中 ${(data.cacheHitRate || 0).toFixed?.(1) ?? data.cacheHitRate}%`,
      `主会话费用 ${fmt(data.mainCost)} · 子代理 ${fmt(data.subagentCost)}`,
      s.today ? `今日费用 ${fmt(s.today.costTotal)} · 本周 ${fmt(s.week && s.week.costTotal)}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }
  if (name === 'health_check') {
    const head = data.healthy
      ? `健康：全部通过（${data.ok}/${data.total}）`
      : `健康：${data.fail} 项异常（${data.ok}/${data.total} 通过）`;
    const fails = (data.failures || [])
      .map((f) => `• ${f.id}: ${f.message}`)
      .join('\n');
    return [
      head,
      `默认：${(data.defaults && data.defaults.defaultProvider) || '?'}/${(data.defaults && data.defaults.defaultModel) || '?'}`,
      data.counts
        ? `规模：供应商 ${data.counts.providers} · 模型 ${data.counts.models} · 子代理 ${data.counts.agents}`
        : '',
      fails ? '失败项：\n' + fails : '',
    ]
      .filter(Boolean)
      .join('\n');
  }
  if (name === 'search_workspace') {
    if (!data.hits || !data.hits.length) return `未找到与「${data.q}」相关的内容`;
    return (
      `搜索「${data.q}」· ${data.hits.length} 条：\n` +
      data.hits
        .map((h, i) => `${i + 1}. [${h.source}] ${h.title}\n   ${String(h.snippet || '').slice(0, 120)}`)
        .join('\n')
    );
  }
  if (name === 'sessions_brief') {
    return [
      `Pi 会话目录：${data.exists === false ? '不存在' : '存在'}`,
      data.total != null ? `数量：${data.total} · 体积：${data.totalSizeLabel || '-'}` : '',
      data.sessionsDir ? `路径：${data.sessionsDir}` : '',
      data.recent && data.recent.length
        ? '最近：\n' + data.recent.map((r) => `• ${r.name || r.id} ${r.sizeLabel || ''}`).join('\n')
        : '',
    ]
      .filter(Boolean)
      .join('\n');
  }
  return JSON.stringify(data, null, 2);
}

function toolsSystemAppendix() {
  return [
    '',
    '【工具】可通过 function calling 调用；用户也可用斜杠命令。',
    '只读：',
    TOOLS.filter((t) => t.callable !== false && !t.write)
      .map((t) => `- ${t.name}（${t.slash[0]}）`)
      .join('\n'),
    '写操作（会返回 needsConfirm，须等用户在界面确认后才真正执行，不要声称已写入）：',
    TOOLS.filter((t) => t.write)
      .map((t) => `- ${t.name}（${t.slash[0]}）`)
      .join('\n'),
    '需要真实数据时优先调工具；不要编造用量数字。禁止 shell 与任意路径写入。',
  ].join('\n');
}

async function confirmWrite(confirmId) {
  purgePending();
  const id = String(confirmId || '').trim();
  const pending = pendingWrites.get(id);
  if (!pending) {
    const err = new Error('确认已过期或不存在，请重新发起操作');
    err.status = 400;
    throw err;
  }
  pendingWrites.delete(id);
  const started = Date.now();
  const { name, args } = pending;
  let data;
  switch (name) {
    case 'set_default_model': {
      const patch = {
        defaultProvider: args.provider,
        defaultModel: args.model,
      };
      if (args.thinkingLevel != null && args.thinkingLevel !== '') {
        patch.defaultThinkingLevel = String(args.thinkingLevel);
      }
      data = { applied: setDefaults(patch), action: name };
      break;
    }
    case 'cleanup_junk': {
      data = {
        ...sessionsApi.cleanupJunk({ mode: args.mode || 'tmp', dryRun: false }),
        action: name,
      };
      break;
    }
    case 'restore_trash': {
      const workspaceId = defaultWorkspaceId(args.workspaceId);
      data = {
        ...filesApi.restoreTrash(workspaceId, args.stamp),
        workspaceId,
        action: name,
      };
      break;
    }
    default: {
      const err = new Error('未知写操作: ' + name);
      err.status = 400;
      throw err;
    }
  }
  return {
    ok: true,
    name,
    args,
    ms: Date.now() - started,
    data,
    text: formatConfirmText(name, data),
  };
}

function rejectWrite(confirmId) {
  const id = String(confirmId || '').trim();
  const had = pendingWrites.delete(id);
  return { ok: true, rejected: had, confirmId: id };
}

function formatConfirmText(name, data) {
  if (name === 'set_default_model') {
    const a = data.applied || {};
    return `已设置默认模型：${a.defaultProvider || '?'}/${a.defaultModel || '?'}`;
  }
  if (name === 'cleanup_junk') {
    return `已清理 ${data.count || (data.deleted && data.deleted.length) || 0} 个文件，释放 ${data.freedLabel || formatBytes(data.freed || 0)}`;
  }
  if (name === 'restore_trash') {
    return '已还原：' + (data.originalRel || data.path || data.stamp || '完成');
  }
  return JSON.stringify(data);
}

module.exports = {
  TOOLS,
  listTools,
  openAITools,
  isCallableTool,
  isWriteTool,
  parseSlash,
  runTool,
  confirmWrite,
  rejectWrite,
  formatToolText,
  toolsSystemAppendix,
};
