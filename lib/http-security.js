/**
 * Bind / Host / Origin guards for local console.
 */
const { URL } = require('url');

function parseBindHost() {
  // Default loopback only. Allow 0.0.0.0 / :: only via explicit env.
  const raw = (process.env.PI_MANAGER_HOST || process.env.HOST || '127.0.0.1').trim();
  return raw || '127.0.0.1';
}

function isLoopbackHost(host) {
  if (!host) return false;
  const h = String(host).split(':')[0].toLowerCase().replace(/^\[|\]$/g, '');
  return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '0:0:0:0:0:0:0:1';
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
  const hostName = host.split(':')[0].toLowerCase().replace(/^\[|\]$/g, '');
  const allowedHosts = new Set(['localhost', '127.0.0.1', '::1']);
  if (bindHost && bindHost !== '0.0.0.0' && bindHost !== '::') {
    allowedHosts.add(String(bindHost).toLowerCase().replace(/^\[|\]$/g, ''));
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
        if (!allowRemote && !isLoopbackHost(oHost)) return 'Origin not allowed';
        // Origin host must match request Host (ignore port mismatch only if both loopback)
        const reqName = hostName;
        if (oHost !== reqName && !(isLoopbackHost(oHost) && isLoopbackHost(reqName))) {
          return 'Origin host mismatch';
        }
        if (String(port) && o.port && String(o.port) !== String(port) && o.port !== '') {
          // allow empty default ports
          if (!(isLoopbackHost(oHost) && isLoopbackHost(reqName))) {
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
  isLoopbackHost,
  checkRequestSecurity,
  securityHeaders,
  requestHost,
};
