const { OPENVL_AVAILABLE } = require('../config');
const openvl = require('../openvl');
const {
  sendJson,
  sendError,
  readBody,
  decodeSeg,
  mapError,
} = require('./helpers');

async function handleOpenvlApi(req, res, pathname, method) {
  if (!pathname.startsWith('/api/openvl')) return false;

  // GET 列表允许在未安装时返回 available:false；其它写/测操作返回 503
  const isListGet = method === 'GET' && pathname === '/api/openvl/profiles';
  const isDoctor = method === 'GET' && pathname === '/api/openvl/doctor';
  if (!OPENVL_AVAILABLE && !isListGet && !isDoctor) {
    sendError(
      res,
      503,
      '未检测到 OpenVL。安装: npm install -g @scp3500/openvl，或设置 OPENVL_PKG_DIR'
    );
    return true;
  }

  // GET /api/openvl/profiles
  if (method === 'GET' && pathname === '/api/openvl/profiles') {
    try {
      sendJson(res, 200, openvl.listProfiles());
    } catch (e) {
      mapError(res, e);
    }
    return true;
  }

  // POST /api/openvl/profiles  新建
  if (method === 'POST' && pathname === '/api/openvl/profiles') {
    try {
      const body = await readBody(req);
      sendJson(res, 201, openvl.createProfile(body || {}));
    } catch (e) {
      mapError(res, e);
    }
    return true;
  }

  // POST /api/openvl/profiles/switch  {id}
  if (method === 'POST' && pathname === '/api/openvl/profiles/switch') {
    try {
      const body = await readBody(req);
      if (!body || !body.id) return sendError(res, 400, 'id is required'), true;
      sendJson(res, 200, openvl.switchProfile(body.id));
    } catch (e) {
      mapError(res, e);
    }
    return true;
  }

  // GET|PUT|DELETE /api/openvl/profiles/:id
  if (pathname.startsWith('/api/openvl/profiles/')) {
    const rest = pathname.slice('/api/openvl/profiles/'.length);
    if (!rest || rest.includes('/')) {
      // fall through to other openvl routes
    } else {
      const id = decodeSeg(rest);
      if (id == null) return sendError(res, 400, 'invalid id'), true;
      if (method === 'GET') {
        try {
          // 本地默认返回真实 Key；?redact=1 才脱敏
          const redact = (req.url || '').includes('redact=1');
          sendJson(res, 200, openvl.getProfile(id, { revealKey: !redact }));
        } catch (e) {
          mapError(res, e);
        }
        return true;
      }
      if (method === 'PUT') {
        try {
          const body = await readBody(req);
          sendJson(res, 200, openvl.updateProfile(id, body || {}));
        } catch (e) {
          mapError(res, e);
        }
        return true;
      }
      if (method === 'DELETE') {
        try {
          sendJson(res, 200, openvl.deleteProfile(id));
        } catch (e) {
          mapError(res, e);
        }
        return true;
      }
    }
  }

  // GET|PUT /api/openvl/ollama
  if (pathname === '/api/openvl/ollama') {
    if (method === 'GET') {
      try {
        const data = openvl.listProfiles();
        sendJson(res, 200, data.ollama);
      } catch (e) {
        mapError(res, e);
      }
      return true;
    }
    if (method === 'PUT' || method === 'POST') {
      try {
        const body = await readBody(req);
        sendJson(res, 200, openvl.updateOllama(body || {}));
      } catch (e) {
        mapError(res, e);
      }
      return true;
    }
  }

  // POST /api/openvl/ollama/check
  if (method === 'POST' && pathname === '/api/openvl/ollama/check') {
    try {
      const body = await readBody(req);
      sendJson(res, 200, await openvl.checkOllama(body || {}));
    } catch (e) {
      sendError(res, 502, e.message || String(e));
    }
    return true;
  }

  // POST /api/openvl/test  连通检测（可用 body 覆盖当前编辑中的地址/Key/model）
  if (method === 'POST' && pathname === '/api/openvl/test') {
    try {
      const body = await readBody(req);
      sendJson(res, 200, await openvl.testApi(body || {}));
    } catch (e) {
      sendError(res, 502, e.message || String(e));
    }
    return true;
  }

  // POST /api/openvl/remote-models  检测视觉接口可用模型
  if (method === 'POST' && pathname === '/api/openvl/remote-models') {
    try {
      const body = await readBody(req);
      sendJson(res, 200, await openvl.listRemoteModels(body || {}));
    } catch (e) {
      sendError(res, 502, e.message || String(e));
    }
    return true;
  }

  // GET /api/openvl/doctor
  if (method === 'GET' && pathname === '/api/openvl/doctor') {
    try {
      sendJson(res, 200, await openvl.runDoctor());
    } catch (e) {
      sendError(res, 500, e.message || String(e));
    }
    return true;
  }

  sendError(res, 404, 'Not Found');
  return true;
}

module.exports = { handleOpenvlApi };
