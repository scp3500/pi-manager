const { BODY_LIMIT } = require('../config');
const { securityHeaders, isLoopbackAddress } = require('../http-security');

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...securityHeaders(),
  });
  res.end(body);
}

function sendError(res, code, message) {
  sendJson(res, code, { error: message });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let exceeded = false;
    req.on('data', (chunk) => {
      if (exceeded) return;
      size += chunk.length;
      if (size > BODY_LIMIT) {
        exceeded = true;
        chunks.length = 0;
        reject(Object.assign(new Error('body too large'), { status: 413 }));
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (exceeded) return;
      if (size === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks, size).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('Invalid JSON body'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function decodeSeg(seg) {
  try {
    return decodeURIComponent(seg);
  } catch {
    return null;
  }
}

/** res.req.socket.remoteAddress 是否本机；拿不到就当远程（保守）。 */
function isLoopbackRequest(res) {
  const req = res && res.req;
  const addr = req && req.socket ? req.socket.remoteAddress : '';
  return isLoopbackAddress(addr);
}

function mapError(res, e) {
  if (e && Number.isInteger(e.status) && e.status >= 400 && e.status < 600) {
    if (e.status >= 500) {
      console.error(e);
      // 诊断文案（含路径、底层 fs 报错）只对本机请求回；远程只给通用文案
      const detail = isLoopbackRequest(res)
        ? String(e.message || 'Error').slice(0, 300)
        : 'Internal error';
      sendError(res, e.status, detail);
      return;
    }
    sendError(res, e.status, e.message || 'Error');
    return;
  }
  const msg = e && e.message ? e.message : 'Internal error';
  const notFound = [
    'not found',
    'model not found',
    'invalid provider id',
    'invalid model id',
    'invalid agent name',
    'invalid path',
  ];
  if (notFound.includes(msg)) {
    sendError(
      res,
      msg.startsWith('invalid') ? 400 : 404,
      msg === 'not found' || msg === 'model not found' ? 'Not Found' : msg
    );
    return;
  }
  if (
    msg === 'target id already exists' ||
    msg === 'model already exists' ||
    msg === 'target model id already exists' ||
    msg === 'target name already exists' ||
    msg === 'Agent already exists' ||
    msg === 'provider already exists'
  ) {
    sendError(res, 409, msg);
    return;
  }
  if (
    msg.includes('valid JSON') ||
    msg.includes('must be') ||
    msg.startsWith('failed to delete old agent') ||
    msg.includes('does not exist') ||
    msg.includes('refused') ||
    msg.includes('required') ||
    msg.includes('cannot delete') ||
    msg.includes('invalid workspace') ||
    msg.includes('dangerous') ||
    msg.includes('backup not found') ||
    msg.includes('map key')
  ) {
    sendError(res, msg.startsWith('failed') ? 500 : 400, msg);
    return;
  }
  console.error(e);
  sendError(res, 500, 'Internal error');
}

function writeSse(res, event, data) {
  if (res.writableEnded || res.destroyed) return;
  try {
    res.write('event: ' + event + '\n');
    res.write('data: ' + JSON.stringify(data == null ? {} : data) + '\n\n');
  } catch {
    /* ignore */
  }
}

function abortOnClientClose(res, ac) {
  res.on('close', () => {
    if (!res.writableEnded && !ac.signal.aborted) {
      try {
        ac.abort();
      } catch {
        /* ignore */
      }
    }
  });
}

module.exports = {
  BODY_LIMIT,
  sendJson,
  sendError,
  readBody,
  decodeSeg,
  mapError,
  writeSse,
  abortOnClientClose,
};
