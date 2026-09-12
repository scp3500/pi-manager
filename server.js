const http = require('http');
const fs = require('fs');
const path = require('path');
const {
  AGENTS_DIR,
  MODELS_FILE,
  SETTINGS_FILE,
  OPENVL_PROFILES_FILE,
  OPENVL_ENV_FILE,
  OPENVL_AVAILABLE,
  MANAGER_CONFIG_FILE,
  AGENTS_MD_FILE,
  PORT,
} = require('./lib/config');
const {
  parseBindHost,
  checkRequestSecurity,
  securityHeaders,
} = require('./lib/http-security');
const BIND_HOST = parseBindHost();
const { sendJson, sendError } = require('./lib/routes/helpers');
const { handleAgentsApi } = require('./lib/routes/agents');
const { handleModelsApi } = require('./lib/routes/models');
const { handleOpenvlApi } = require('./lib/routes/openvl');
const { handleConsoleApi, warmupUsageCache } = require('./lib/routes/console');
const { closeUsageWorker } = require('./lib/usage-service');
const promptStructureApi = require('./lib/prompt-structure');
const { handleChatApi } = require('./lib/routes/chat');

const PUBLIC_DIR = path.resolve(__dirname, 'public');
const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function safePublicPath(urlPath) {
  let rel;
  try {
    rel = decodeURIComponent(urlPath).replace(/^\/+/, '');
  } catch {
    return null;
  }
  const filePath = path.resolve(path.join(PUBLIC_DIR, rel || 'index.html'));
  const prefix = PUBLIC_DIR.endsWith(path.sep) ? PUBLIC_DIR : PUBLIC_DIR + path.sep;
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(prefix)) return null;
  return filePath;
}

/** Small static file cache (mtime+size). Caps memory for public assets. */
const staticCache = new Map(); // path -> { mtimeMs, size, type, content }
const STATIC_CACHE_MAX = 80;
const STATIC_CACHE_MAX_BYTES = 512 * 1024; // skip caching files larger than 512KB

function serveStatic(res, urlPath) {
  const filePath = safePublicPath(urlPath);
  if (!filePath) return sendError(res, 404, 'Not Found');
  const ext = path.extname(filePath);
  const type = STATIC_TYPES[ext];
  if (!type) return sendError(res, 404, 'Not Found');
  try {
    const st = fs.statSync(filePath);
    if (!st.isFile()) return sendError(res, 404, 'Not Found');
    const hit = staticCache.get(filePath);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
      res.writeHead(200, {
        'Content-Type': hit.type,
        'Cache-Control': 'no-cache',
        'X-Static-Cache': 'HIT',
        ...securityHeaders(),
      });
      res.end(hit.content);
      return;
    }
    const content = fs.readFileSync(filePath);
    if (st.size <= STATIC_CACHE_MAX_BYTES) {
      if (staticCache.size >= STATIC_CACHE_MAX) {
        let i = 0;
        const drop = Math.floor(STATIC_CACHE_MAX / 4) || 1;
        for (const k of staticCache.keys()) {
          staticCache.delete(k);
          if (++i >= drop) break;
        }
      }
      staticCache.set(filePath, {
        mtimeMs: st.mtimeMs,
        size: st.size,
        type,
        content,
      });
    }
    res.writeHead(200, {
      'Content-Type': type,
      'Cache-Control': 'no-cache',
      'X-Static-Cache': 'MISS',
      ...securityHeaders(),
    });
    res.end(content);
  } catch {
    sendError(res, 404, 'Not Found');
  }
}

async function handleApi(req, res, pathname) {
  const method = req.method;
  if (await handleAgentsApi(req, res, pathname, method)) return true;
  if (await handleModelsApi(req, res, pathname, method)) return true;
  if (await handleOpenvlApi(req, res, pathname, method)) return true;
  if (await handleConsoleApi(req, res, pathname, method)) return true;
  if (await handleChatApi(req, res, pathname, method)) return true;
  if (pathname.startsWith('/api/')) {
    sendError(res, 404, 'Not Found');
    return true;
  }
  return false;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://localhost');
    const pathname = url.pathname;

    const secErr = checkRequestSecurity(req, { bindHost: BIND_HOST, port: PORT });
    if (secErr) {
      sendError(res, 403, secErr);
      return;
    }

    if (await handleApi(req, res, pathname)) return;

    if (req.method === 'GET' || req.method === 'HEAD') {
      if (
        pathname === '/' ||
        pathname === '/models' ||
        pathname === '/agents' ||
        pathname === '/openvl' ||
        pathname === '/prompt' ||
        pathname === '/memory' ||
        pathname === '/knowledge' ||
        pathname === '/skills' ||
        pathname === '/plugins' ||
        pathname === '/workspaces'
      ) {
        serveStatic(res, '/index.html');
        return;
      }
      const ext = path.extname(pathname);
      if (STATIC_TYPES[ext]) {
        serveStatic(res, pathname);
        return;
      }
    }
    sendError(res, 404, 'Not Found');
  } catch (e) {
    console.error(e);
    if (!res.headersSent) sendError(res, 500, 'Internal error');
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error('Port ' + PORT + ' is already in use');
    process.exit(1);
  }
  throw err;
});

// Leave a trail when the process dies unexpectedly (no idle auto-exit in this app).
function logFatal(kind, err) {
  const msg =
    '[' +
    new Date().toISOString() +
    '] ' +
    kind +
    ': ' +
    (err && err.stack ? err.stack : String(err && err.message ? err.message : err));
  console.error(msg);
  try {
    const logDir = path.join(__dirname, 'logs');
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(path.join(logDir, 'server-fatal.log'), msg + '\n', 'utf8');
  } catch {
    /* ignore */
  }
}
process.on('uncaughtException', (err) => {
  logFatal('uncaughtException', err);
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  logFatal('unhandledRejection', err);
  // do not exit: a single rejected promise shouldn't kill the console
});

let shuttingDown = false;
/** Terminate the usage worker thread, then drain the HTTP server.
 * The 2s fallback matters on Windows: keep-alive sockets from an open browser
 * tab otherwise keep `server.close()` from ever reaching its callback. */
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  closeUsageWorker()
    .catch(() => {})
    .finally(() => {
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 2000).unref();
    });
}
process.on('SIGTERM', () => {
  console.log('[' + new Date().toISOString() + '] SIGTERM, shutting down');
  shutdown();
});
process.on('SIGINT', () => {
  console.log('[' + new Date().toISOString() + '] SIGINT, shutting down');
  shutdown();
});

module.exports = { safePublicPath, server, PORT, BIND_HOST };

if (require.main === module) {
  server.listen(PORT, BIND_HOST, () => {
    console.log('Pi Manager');
    console.log('  bind:     ' + BIND_HOST + ':' + PORT);
    console.log('  http://localhost:' + PORT);
    console.log('  models:   ' + MODELS_FILE);
    console.log('  settings: ' + SETTINGS_FILE);
    console.log('  agents:   ' + AGENTS_DIR);
    console.log('  prompt:   ' + AGENTS_MD_FILE);
    console.log('  manager:  ' + MANAGER_CONFIG_FILE);
    console.log(
      '  openvl:   ' + (OPENVL_AVAILABLE ? OPENVL_PROFILES_FILE : '(未安装)')
    );
    // warm usage disk index into memory so first /api/usage after restart is fast
    setImmediate(() => {
      warmupUsageCache();
      // pi 包首次 import 约 5s，预热后首个页面打开即秒开
      promptStructureApi
        .warm()
        .then((r) => console.log('  prompt:   ' + (r.ok ? 'structure warm' : 'skip ' + r.error)));
    });
    console.log('  pid:      ' + process.pid);
  });
}
