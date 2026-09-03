const { BODY_LIMIT } = require('../config');
const { securityHeaders } = require('../http-security');

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
    let body = '';
    let exceeded = false;
    req.on('data', (chunk) => {
      if (exceeded) return;
      body += chunk;
      if (body.length > BODY_LIMIT) {
        exceeded = true;
        body = '';
        reject(Object.assign(new Error('body too large'), { status: 413 }));
      }
    });
    req.on('end', () => {
      if (exceeded) return;
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
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

function mapError(res, e) {
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
  res.write('event: ' + event + '\n');
  res.write('data: ' + JSON.stringify(data == null ? {} : data) + '\n\n');
}

module.exports = {
  BODY_LIMIT,
  sendJson,
  sendError,
  readBody,
  decodeSeg,
  mapError,
  writeSse,
};
