const crypto = require('crypto');

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

function sign(payload, secret) {
  const data = base64url(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${sig}`;
}

function verify(token, secret) {
  if (!token || !token.includes('.')) return null;
  const [data, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  // Constant-time compare to avoid timing attacks
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString());
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  header.split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    out[k] = decodeURIComponent(v);
  });
  return out;
}

const SESSION_COOKIE = 'eon_session';
const STATE_COOKIE = 'eon_oauth_state';

function getSession(req) {
  const secret = process.env.SESSION_SECRET;
  if (!secret) return null;
  const cookies = parseCookies(req);
  return verify(cookies[SESSION_COOKIE], secret);
}

function setCookie(res, name, value, opts = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${opts.path || '/'}`);
  parts.push('HttpOnly');
  parts.push('Secure');
  parts.push(`SameSite=${opts.sameSite || 'Lax'}`);
  if (opts.maxAge) parts.push(`Max-Age=${opts.maxAge}`);
  const existing = res.getHeader('Set-Cookie');
  const cookieStr = parts.join('; ');
  if (existing) {
    res.setHeader('Set-Cookie', Array.isArray(existing) ? [...existing, cookieStr] : [existing, cookieStr]);
  } else {
    res.setHeader('Set-Cookie', cookieStr);
  }
}

function clearCookie(res, name) {
  setCookie(res, name, '', { maxAge: 0 });
}

module.exports = { sign, verify, parseCookies, getSession, setCookie, clearCookie, SESSION_COOKIE, STATE_COOKIE };
