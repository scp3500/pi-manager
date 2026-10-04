/**
 * Bind / Host / Origin guards for local console.
 */
const { URL } = require('url');

function parseBindHost() {
  // Default loopback only. Allow 0.0.0.0 / :: only via explicit env.
  const raw = (process.env.PI_MANAGER_HOST || process.env.HOST || '127.0.0.1').trim();
  return raw || '127.0.0.1';
}

/**
 * Host 头 / socket 地址 → 主机名：剥掉端口，IPv6 剥掉方括号。
 * '[::1]:3001' → '::1'，'::1' → '::1'，'127.0.0.1:3001' → '127.0.0.1'。
 */
function hostNameOf(host) {
  const h = String(host == null ? '' : host).trim().toLowerCase();
  if (!h) return '';
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    if (end > 0) return h.slice(1, end);
  }
  // 冒号超过一个 = 没有端口的裸 IPv6，不能再按 ':' 切
  if ((h.match(/:/g) || []).length > 1) return h;
  const i = h.indexOf(':');
  return i === -1 ? h : h.slice(0, i);
}

const LOOPBACK_NAMES = new Set([
  '127.0.0.1',
  'localhost',
  '::1',
  '0:0:0:0:0:0:0:1',
  '::ffff:127.0.0.1',
  '::ffff:7f00:1',
]);

function isLoopbackHost(host) {
  return LOOPBACK_NAMES.has(hostNameOf(host));
}

/** 请求来源 socket 地址是否本机（mapError 用它决定要不要回详细文案）。 */
function isLoopbackAddress(addr) {
  return LOOPBACK_NAMES.has(hostNameOf(addr));
}

function requestHost(req) {
  const raw = req.headers.host || '';
  return String(raw).split(',')[0].trim();
}

/**
 * @returns {null|string} error message if blocked
 */
function checkRequestSecurity(req, { bindHost, port }) {
  const method = (req.method || 'GET').toUpperCase();
  const host = requestHost(req);
  if (!host) return 'missing Host';

  // Reject obvious Host header injection / rebinding away from this service.
  const hostName = hostNameOf(host);
  const allowedHosts = new Set(['localhost', '127.0.0.1', '::1']);
  if (bindHost && bindHost !== '0.0.0.0' && bindHost !== '::') {
    allowedHosts.add(hostNameOf(bindHost));
  }
  // When explicitly listening on all interfaces, still only accept loopback Host by default
  // unless PI_MANAGER_ALLOW_REMOTE=1
  const allowRemote = process.env.PI_MANAGER_ALLOW_REMOTE === '1';
  if (!allowRemote && !allowedHosts.has(hostName) && !isLoopbackHost(hostName)) {
    return 'Host not allowed';
  }
  if (!allowRemote && !isLoopbackHost(hostName) && bindHost === '127.0.0.1') {
    return 'Host not allowed';
  }

  // CSRF-ish: mutating methods need same-origin Origin or no Origin (same-site navigation / curl).
  if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
    const origin = req.headers.origin;
    if (origin) {
      try {
        const o = new URL(origin);
        const oHost = (o.hostname || '').toLowerCase();
        const allowedOrigins = String(process.env.PI_MANAGER_ALLOWED_ORIGINS || '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        if (!(allowedOrigins.includes(origin) || allowedOrigins.includes(o.origin))) {
          if (!allowRemote && !isLoopbackHost(oHost)) return 'Origin not allowed';
          const reqName = hostName;
          if (oHost !== reqName && !(isLoopbackHost(oHost) && isLoopbackHost(reqName))) {
            return 'Origin host mismatch';
          }
          const originPort = o.port !== '' ? o.port : o.protocol === 'https:' ? '443' : '80';
          if (String(port) && String(originPort) !== String(port)) {
            return 'Origin port mismatch';
          }
        }
      } catch {
        return 'invalid Origin';
      }
    }
  }
  return null;
}

function securityHeaders() {
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'",
  };
}

module.exports = {
  parseBindHost,
  hostNameOf,
  isLoopbackHost,
  isLoopbackAddress,
  checkRequestSecurity,
  securityHeaders,
  requestHost,
};
