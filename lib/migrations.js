'use strict';

/**
 * Pi 1.0.3 迁移体检：provider key `azure-openai-responses` 改名为 `azure`。
 *
 * 受影响的位置（api 协议名不变，仍是 azure-openai-responses）：
 *   - auth.json 顶层键
 *   - models.json 的 providers 键
 *   - settings.json 的 defaultProvider / enabledModels 条目 / modelThinkingLevels 键
 *
 * 读/写默认路径时复用 models.js / settings.js 的 helper（自带 .bak 与原子写）；
 * 显式传入别的路径（测试隔离）时用同形态的 JSON 原子写，不碰真实配置。
 */

const fs = require('fs');
const path = require('path');
const config = require('./config');
const { readModelsFile, writeModelsFile } = require('./models');
const { readSettingsFile, writeSettingsFile } = require('./settings');

const OLD_PROVIDER = 'azure-openai-responses';
const NEW_PROVIDER = 'azure';

function hasOwn(obj, key) {
  return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
}

/** 是否指向旧 provider key（'azure-openai-responses' 或 'azure-openai-responses/…'）。 */
function isOldRef(v) {
  return typeof v === 'string' && (v === OLD_PROVIDER || v.startsWith(OLD_PROVIDER + '/'));
}

/** 把引用里的 provider 前缀换成新 key，其余部分（模型 id 等）原样保留。 */
function renameRef(v) {
  return String(v).replace(OLD_PROVIDER, NEW_PROVIDER);
}

function resolvePaths(opts) {
  const o = opts || {};
  return {
    modelsFile: o.modelsFile || config.MODELS_FILE,
    settingsFile: o.settingsFile || config.SETTINGS_FILE,
    authFile: o.authFile || config.AUTH_FILE,
  };
}

function samePath(a, b) {
  const na = path.resolve(String(a));
  const nb = path.resolve(String(b));
  return process.platform === 'win32' ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

/** 沿用原文件的缩进（拿不到就用 2 空格）。 */
function detectIndent(raw) {
  const m = /^([ \t]+)"/m.exec(String(raw || '').replace(/\r\n/g, '\n'));
  return m ? m[1] : '  ';
}

/**
 * 通用 JSON 对象读取：文件不存在 / 空文件 / 解析失败都不抛。
 * @returns {{ data: Object|null, raw: string, warning: string }}
 */
function readObject(file, label) {
  if (!fs.existsSync(file)) return { data: null, raw: '', warning: '' };
  let raw = '';
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return { data: null, raw: '', warning: label + ' 读不了（已跳过）：' + file + ' · ' + e.message };
  }
  if (!raw.trim()) return { data: null, raw, warning: '' };
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    return {
      data: null,
      raw,
      warning: label + ' 不是合法 JSON（已跳过）：' + file + ' · ' + e.message,
    };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { data: null, raw, warning: label + ' 根节点不是 JSON 对象（已跳过）：' + file };
  }
  return { data, raw, warning: '' };
}

/** models.json：默认路径用 models.js 的 helper，其余路径用通用读。 */
function readModelsAt(file) {
  if (!samePath(file, config.MODELS_FILE)) return readObject(file, 'models.json');
  if (!fs.existsSync(file)) return { data: null, raw: '', warning: '' };
  try {
    return { data: readModelsFile(), raw: '', warning: '' };
  } catch (e) {
    return { data: null, raw: '', warning: 'models.json 读不了（已跳过）：' + file + ' · ' + e.message };
  }
}

/** settings.json：默认路径用 settings.js 的 helper，其余路径用通用读。 */
function readSettingsAt(file) {
  if (!samePath(file, config.SETTINGS_FILE)) return readObject(file, 'settings.json');
  if (!fs.existsSync(file)) return { data: null, raw: '', warning: '' };
  try {
    return { data: readSettingsFile(), raw: '', warning: '' };
  } catch (e) {
    return { data: null, raw: '', warning: 'settings.json 读不了（已跳过）：' + file + ' · ' + e.message };
  }
}

/**
 * 原子写：临时文件 + rename，可选 .bak 备份与保留原文件权限位。
 * JSON 缩进沿用 sourceRaw 的写法（默认 2 空格 + 结尾换行）。
 */
function writeJsonAtomic(file, data, opts) {
  const o = opts || {};
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  let mode = null;
  const existed = fs.existsSync(file);
  if (existed) {
    if (o.keepMode) {
      try {
        mode = fs.statSync(file).mode & 0o777;
      } catch {
        mode = null;
      }
    }
    if (o.backup !== false) {
      try {
        fs.copyFileSync(file, file + '.bak');
      } catch (e) {
        console.warn('backup failed:', e.message);
      }
    }
  }

  const pad = o.indent || detectIndent(o.sourceRaw);
  const tmp = file + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(data, null, pad) + '\n', 'utf8');
  if (mode != null) {
    try {
      fs.chmodSync(tmp, mode);
    } catch {
      /* Windows 上尽力而为 */
    }
  }
  fs.renameSync(tmp, file);
}

/** 默认路径交给 writeModelsFile（滚动备份 + 原子写），显式路径用通用写。 */
function writeModelsAt(file, data, raw) {
  if (samePath(file, config.MODELS_FILE)) {
    writeModelsFile(data);
    return;
  }
  writeJsonAtomic(file, data, { backup: true, sourceRaw: raw });
}

/** 默认路径交给 writeSettingsFile（.bak + 原子写），显式路径用通用写。 */
function writeSettingsAt(file, data, raw) {
  if (samePath(file, config.SETTINGS_FILE)) {
    writeSettingsFile(data);
    return;
  }
  writeJsonAtomic(file, data, { backup: true, sourceRaw: raw });
}

function conflictDetail(where, target) {
  return where + ' 里已有 ' + target + '，需人工合并；该处保持原样，不覆盖已有配置';
}

/**
 * 体检：找出所有残留的旧 provider key。
 * @param {{modelsFile?: string, settingsFile?: string, authFile?: string}} [opts]
 * @returns {{items: Array, count: number, warnings: string[]}}
 */
function detectMigrations(opts) {
  const { modelsFile, settingsFile, authFile } = resolvePaths(opts);
  const items = [];
  const warnings = [];

  // 1) models.json providers 键
  const m = readModelsAt(modelsFile);
  if (m.warning) warnings.push(m.warning);
  if (m.data) {
    const providers =
      m.data.providers && typeof m.data.providers === 'object' && !Array.isArray(m.data.providers)
        ? m.data.providers
        : null;
    if (providers && hasOwn(providers, OLD_PROVIDER)) {
      const conflict = hasOwn(providers, NEW_PROVIDER);
      items.push({
        id: 'models:providers:' + OLD_PROVIDER,
        file: modelsFile,
        where: 'models.json 的 providers 键',
        from: OLD_PROVIDER,
        to: NEW_PROVIDER,
        detail: conflict
          ? '供应商 azure-openai-responses 需改名为 azure，但 providers 里已有 azure，' +
            conflictDetail('models.json 的 providers', NEW_PROVIDER)
          : '供应商 azure-openai-responses 需改名为 azure（api 协议名不变）',
        canAutoFix: !conflict,
      });
    }
  }

  // 2) settings.json 三处
  const s = readSettingsAt(settingsFile);
  if (s.warning) warnings.push(s.warning);
  if (s.data) {
    if (s.data.defaultProvider === OLD_PROVIDER) {
      items.push({
        id: 'settings:defaultProvider',
        file: settingsFile,
        where: 'settings.json 的 defaultProvider',
        from: OLD_PROVIDER,
        to: NEW_PROVIDER,
        detail: '默认 Provider 指向旧 key，需改为 azure',
        canAutoFix: true,
      });
    }

    const enabled = Array.isArray(s.data.enabledModels) ? s.data.enabledModels : null;
    if (enabled) {
      for (const v of enabled) {
        if (!isOldRef(v)) continue;
        const to = renameRef(v);
        const conflict = enabled.includes(to);
        items.push({
          id: 'settings:enabledModels:' + v,
          file: settingsFile,
          where: 'settings.json 的 enabledModels 条目',
          from: v,
          to,
          detail: conflict
            ? 'enabledModels 条目 ' + v + ' 需改成 ' + to + '，但 ' +
              conflictDetail('settings.json 的 enabledModels', to)
            : 'enabledModels 条目 ' + v + ' 需改成 ' + to,
          canAutoFix: !conflict,
        });
      }
    }

    const tlm = s.data.modelThinkingLevels;
    if (tlm && typeof tlm === 'object' && !Array.isArray(tlm)) {
      for (const k of Object.keys(tlm)) {
        if (!isOldRef(k)) continue;
        const to = renameRef(k);
        const conflict = hasOwn(tlm, to);
        items.push({
          id: 'settings:modelThinkingLevels:' + k,
          file: settingsFile,
          where: 'settings.json 的 modelThinkingLevels 键',
          from: k,
          to,
          detail: conflict
            ? 'modelThinkingLevels 键 ' + k + ' 需改成 ' + to + '，但 ' +
              conflictDetail('settings.json 的 modelThinkingLevels', to)
            : 'modelThinkingLevels 键 ' + k + ' 需改成 ' + to,
          canAutoFix: !conflict,
        });
      }
    }
  }

  // 3) auth.json 顶层键
  const a = readObject(authFile, 'auth.json');
  if (a.warning) warnings.push(a.warning);
  if (a.data && hasOwn(a.data, OLD_PROVIDER)) {
    const conflict = hasOwn(a.data, NEW_PROVIDER);
    items.push({
      id: 'auth:' + OLD_PROVIDER,
      file: authFile,
      where: 'auth.json 的顶层键',
      from: OLD_PROVIDER,
      to: NEW_PROVIDER,
      detail: conflict
        ? '登录凭据挂在旧 key 下，但 auth.json 里已有 azure 键，' +
          conflictDetail('auth.json', NEW_PROVIDER)
        : '登录凭据挂在旧 provider key 下，需改名为 azure',
      canAutoFix: !conflict,
    });
  }

  return { items, count: items.length, warnings };
}

/**
 * 执行迁移：只改这次改名涉及的键，其它键与缩进原样保留。
 * 幂等：没有残留时 changed 为空且不写任何文件。
 * @param {{modelsFile?: string, settingsFile?: string, authFile?: string}} [opts]
 * @returns {{ok: boolean, changed: Array, conflicts: Array, skipped: Array}}
 */
function applyAzureRename(opts) {
  const { modelsFile, settingsFile, authFile } = resolvePaths(opts);
  const changed = [];
  const conflicts = [];
  const skipped = [];

  // 1) models.json providers 键（键改名，位置保持）
  const m = readModelsAt(modelsFile);
  if (m.warning) {
    skipped.push({ file: modelsFile, where: 'models.json', reason: m.warning });
  } else if (m.data) {
    const providers =
      m.data.providers && typeof m.data.providers === 'object' && !Array.isArray(m.data.providers)
        ? m.data.providers
        : null;
    if (providers && hasOwn(providers, OLD_PROVIDER)) {
      if (hasOwn(providers, NEW_PROVIDER)) {
        conflicts.push({
          id: 'models:providers:' + OLD_PROVIDER,
          file: modelsFile,
          where: 'models.json 的 providers 键',
          from: OLD_PROVIDER,
          to: NEW_PROVIDER,
          detail: 'azure 已存在，需人工合并；models.json 未改动',
        });
      } else {
        const next = {};
        for (const [k, v] of Object.entries(providers)) {
          next[k === OLD_PROVIDER ? NEW_PROVIDER : k] = v;
        }
        m.data.providers = next;
        writeModelsAt(modelsFile, m.data, m.raw);
        changed.push({
          id: 'models:providers:' + OLD_PROVIDER,
          file: modelsFile,
          where: 'models.json 的 providers 键',
          from: OLD_PROVIDER,
          to: NEW_PROVIDER,
          detail: 'providers 键已改名（参数、模型列表原样保留）',
        });
      }
    }
  }

  // 2) settings.json 三处
  const s = readSettingsAt(settingsFile);
  if (s.warning) {
    skipped.push({ file: settingsFile, where: 'settings.json', reason: s.warning });
  } else if (s.data) {
    let touched = false;

    if (s.data.defaultProvider === OLD_PROVIDER) {
      s.data.defaultProvider = NEW_PROVIDER;
      touched = true;
      changed.push({
        id: 'settings:defaultProvider',
        file: settingsFile,
        where: 'settings.json 的 defaultProvider',
        from: OLD_PROVIDER,
        to: NEW_PROVIDER,
        detail: 'defaultProvider 已改为 azure',
      });
    }

    const enabled = Array.isArray(s.data.enabledModels) ? s.data.enabledModels : null;
    if (enabled) {
      let anyEntry = false;
      const nextEnabled = enabled.map((v) => {
        if (!isOldRef(v)) return v;
        const to = renameRef(v);
        if (enabled.includes(to)) {
          conflicts.push({
            id: 'settings:enabledModels:' + v,
            file: settingsFile,
            where: 'settings.json 的 enabledModels 条目',
            from: v,
            to,
            detail: 'azure 条目已存在，需人工合并；该条目保持原样',
          });
          return v;
        }
        anyEntry = true;
        changed.push({
          id: 'settings:enabledModels:' + v,
          file: settingsFile,
          where: 'settings.json 的 enabledModels 条目',
          from: v,
          to,
          detail: 'enabledModels 条目已改名',
        });
        return to;
      });
      if (anyEntry) {
        s.data.enabledModels = nextEnabled;
        touched = true;
      }
    }

    const tlm = s.data.modelThinkingLevels;
    if (tlm && typeof tlm === 'object' && !Array.isArray(tlm)) {
      let anyKey = false;
      const nextTlm = {};
      for (const [k, v] of Object.entries(tlm)) {
        if (!isOldRef(k)) {
          nextTlm[k] = v;
          continue;
        }
        const to = renameRef(k);
        if (hasOwn(tlm, to)) {
          conflicts.push({
            id: 'settings:modelThinkingLevels:' + k,
            file: settingsFile,
            where: 'settings.json 的 modelThinkingLevels 键',
            from: k,
            to,
            detail: 'azure 键已存在，需人工合并；该键保持原样',
          });
          nextTlm[k] = v;
          continue;
        }
        nextTlm[to] = v;
        anyKey = true;
        changed.push({
          id: 'settings:modelThinkingLevels:' + k,
          file: settingsFile,
          where: 'settings.json 的 modelThinkingLevels 键',
          from: k,
          to,
          detail: 'modelThinkingLevels 键已改名（档位映射原样保留）',
        });
      }
      if (anyKey) {
        s.data.modelThinkingLevels = nextTlm;
        touched = true;
      }
    }

    if (touched) writeSettingsAt(settingsFile, s.data, s.raw);
  }

  // 3) auth.json 顶层键（保留权限位与其它键）
  const a = readObject(authFile, 'auth.json');
  if (a.warning) {
    skipped.push({ file: authFile, where: 'auth.json', reason: a.warning });
  } else if (a.data && hasOwn(a.data, OLD_PROVIDER)) {
    if (hasOwn(a.data, NEW_PROVIDER)) {
      conflicts.push({
        id: 'auth:' + OLD_PROVIDER,
        file: authFile,
        where: 'auth.json 的顶层键',
        from: OLD_PROVIDER,
        to: NEW_PROVIDER,
        detail: 'azure 已存在，需人工合并；auth.json 未改动',
      });
    } else {
      const next = {};
      for (const [k, v] of Object.entries(a.data)) {
        next[k === OLD_PROVIDER ? NEW_PROVIDER : k] = v;
      }
      writeJsonAtomic(authFile, next, { backup: true, keepMode: true, sourceRaw: a.raw });
      changed.push({
        id: 'auth:' + OLD_PROVIDER,
        file: authFile,
        where: 'auth.json 的顶层键',
        from: OLD_PROVIDER,
        to: NEW_PROVIDER,
        detail: 'auth.json 顶层键已改名（其它键与权限位保留）',
      });
    }
  }

  return {
    ok: conflicts.length === 0 && skipped.length === 0,
    changed,
    conflicts,
    skipped,
  };
}

module.exports = {
  detectMigrations,
  applyAzureRename,
  OLD_PROVIDER,
  NEW_PROVIDER,
  isOldRef,
  renameRef,
};
