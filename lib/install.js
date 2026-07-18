/**
 * One-click install helpers for Guides page.
 * Whitelist-only: never run arbitrary shell from the browser.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { PI_AGENT_DIR, OPENVL_AVAILABLE, OPENVL_PKG_DIR } = require('./config');
const agentsApi = require('./agents');

const RUN_TIMEOUT_MS = 8 * 60_000;

/** @type {Map<string, {running:boolean, startedAt:number, finishedAt?:number, ok?:boolean, code?:number, log:string, target?:string}>} */
const jobs = new Map();

function whichSync(cmd) {
  try {
    const { execFileSync } = require('child_process');
    if (process.platform === 'win32') {
      const out = execFileSync('where', [cmd], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 5000,
      });
      const line = String(out)
        .split(/\r?\n/)
        .map((s) => s.trim())
        .find(Boolean);
      return line || null;
    }
    const out = execFileSync('which', [cmd], { encoding: 'utf8', timeout: 5000 });
    return String(out).trim() || null;
  } catch {
    return null;
  }
}

function appendLog(job, chunk) {
  const s = String(chunk || '');
  if (!s) return;
  job.log = (job.log + s).slice(-120_000);
}

function runJob(id, file, args, opts = {}) {
  const existing = jobs.get(id);
  if (existing && existing.running) {
    const err = new Error('已有安装任务进行中，请稍候');
    err.status = 409;
    throw err;
  }
  const job = {
    id,
    running: true,
    startedAt: Date.now(),
    ok: undefined,
    code: undefined,
    log: '',
    target: opts.target || args.join(' '),
    cmd: file + ' ' + args.join(' '),
  };
  jobs.set(id, job);

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(file, args, {
        env: { ...process.env, ...(opts.env || {}) },
        cwd: opts.cwd || process.cwd(),
        windowsHide: true,
        shell: false,
      });
    } catch (e) {
      job.running = false;
      job.finishedAt = Date.now();
      job.ok = false;
      job.code = -1;
      appendLog(job, String(e.message || e) + '\n');
      resolve(snapshot(job));
      return;
    }

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      appendLog(job, '\n[timeout] 安装超时，已中止\n');
    }, opts.timeoutMs || RUN_TIMEOUT_MS);

    child.stdout.on('data', (d) => appendLog(job, d));
    child.stderr.on('data', (d) => appendLog(job, d));
    child.on('error', (e) => {
      appendLog(job, '\n[error] ' + (e.message || e) + '\n');
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      job.running = false;
      job.finishedAt = Date.now();
      job.code = code == null ? -1 : code;
      job.ok = job.code === 0;
      if (!job.ok && !job.log.trim()) {
        appendLog(job, '进程退出码 ' + job.code + '\n');
      }
      resolve(snapshot(job));
    });
  });
}

function snapshot(job) {
  return {
    id: job.id,
    running: job.running,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt || null,
    ok: job.ok,
    code: job.code,
    target: job.target,
    cmd: job.cmd,
    log: job.log,
    ms: (job.finishedAt || Date.now()) - job.startedAt,
  };
}

function getJob(id) {
  const j = jobs.get(id);
  return j ? snapshot(j) : null;
}

function status() {
  const npm = whichSync(process.platform === 'win32' ? 'npm.cmd' : 'npm');
  const pi = whichSync(process.platform === 'win32' ? 'pi.cmd' : 'pi');
  let agentCount = 0;
  try {
    agentCount = (agentsApi.listAgents() || []).length;
  } catch {
    agentCount = 0;
  }
  return {
    tools: {
      npm: !!npm,
      npmPath: npm || '',
      pi: !!pi,
      piPath: pi || '',
    },
    openvl: {
      available: !!OPENVL_AVAILABLE,
      pkgDir: OPENVL_PKG_DIR || '',
    },
    agents: {
      dir: path.join(PI_AGENT_DIR, 'agents'),
      count: agentCount,
    },
    jobs: {
      openvl: getJob('openvl'),
      plugin: getJob('plugin'),
      agentStarter: getJob('agent-starter'),
    },
  };
}

function installOpenvl() {
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  if (!whichSync(npmCmd) && !whichSync('npm')) {
    const err = new Error('未找到 npm，请先安装 Node.js 并加入 PATH');
    err.status = 400;
    throw err;
  }
  const file = whichSync(npmCmd) || whichSync('npm') || npmCmd;
  // runJob returns a Promise; validation above is sync
  return runJob('openvl', file, ['install', '-g', '@scp3500/openvl'], {
    target: '@scp3500/openvl',
  });
}

/** Only npm:name or npm:@scope/name with optional @version */
function parseAllowedNpmSpec(raw) {
  const s = String(raw || '').trim();
  // accept with or without npm: prefix
  const body = s.startsWith('npm:') ? s.slice(4) : s;
  // @scope/pkg@1.2.3 or pkg@1.2.3 or pkg
  if (!/^(@[a-zA-Z0-9._-]+\/)?[a-zA-Z0-9._-]+(@[a-zA-Z0-9._-]+)?$/.test(body)) {
    return null;
  }
  return 'npm:' + body;
}

function installPlugin(spec) {
  const allowed = parseAllowedNpmSpec(spec);
  if (!allowed) {
    const err = new Error(
      '仅支持 npm 包一键安装，格式如 npm:@scope/pkg 或 pkg-name（可带 @version）'
    );
    err.status = 400;
    throw err;
  }
  const piCmd = process.platform === 'win32' ? 'pi.cmd' : 'pi';
  const file = whichSync(piCmd) || whichSync('pi');
  if (!file) {
    const err = new Error('未找到 pi CLI。请先安装 Pi Coding Agent 并确保 pi 在 PATH 中');
    err.status = 400;
    throw err;
  }
  return runJob('plugin', file, ['install', allowed], { target: allowed });
}

const STARTER_AGENT = {
  name: 'starter-helper',
  description: '通用助手子代理（Pi Manager 一键创建的入门模板）',
  category: 'general',
  model: '',
  thinking: '',
  tools: ['read', 'bash', 'edit', 'write'],
  prompt: `你是主 Agent 派出的子代理助手。

规则：
1. 只完成任务描述中的目标，不扩展范围。
2. 改文件前先 read；改完简要说明改了什么。
3. 输出用简洁中文：结论 + 关键路径/命令；需要时再附细节。
4. 不要请求用户密钥，不要执行破坏性命令（rm -rf / format 等）。
`,
};

function createStarterAgent() {
  const name = STARTER_AGENT.name;
  if (agentsApi.agentExists(name)) {
    return {
      ok: true,
      created: false,
      name,
      message: '示例子代理已存在：' + name,
      path: path.join(PI_AGENT_DIR, 'agents', name + '.md'),
    };
  }
  agentsApi.writeAgent(
    name,
    {
      description: STARTER_AGENT.description,
      tools: STARTER_AGENT.tools.join(', '),
      model: STARTER_AGENT.model || '',
      category: STARTER_AGENT.category || '',
    },
    STARTER_AGENT.prompt.trim() + '\n'
  );
  return {
    ok: true,
    created: true,
    name,
    message: '已创建示例子代理：' + name,
    path: path.join(PI_AGENT_DIR, 'agents', name + '.md'),
  };
}

module.exports = {
  status,
  getJob,
  installOpenvl,
  installPlugin,
  createStarterAgent,
  parseAllowedNpmSpec,
};
