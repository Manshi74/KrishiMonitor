import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const COOKIE_NAME = 'km_owner';
const MAX_AGE_SECONDS = 60 * 60 * 24 * 90;
export function sessionIsConfigured() {
  return typeof process.env.SESSION_SECRET === 'string' && Buffer.byteLength(process.env.SESSION_SECRET) >= 32;
}
function signature(ownerId) {
  return createHmac('sha256', process.env.SESSION_SECRET).update(ownerId).digest('base64url');
}
function readCookie(header, key) {
  for (const part of String(header || '').split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== key) continue;
    return part.slice(separator + 1).trim();
  }
  return '';
}
export function getOwnerSession(req, res) {
  if (!sessionIsConfigured()) throw Object.assign(new Error('Set SESSION_SECRET to at least 32 characters to enable private database records.'), { status: 503 });
  const cookie = readCookie(req.headers.cookie, COOKIE_NAME);
  const separator = cookie.lastIndexOf('.');
  if (separator > 0) {
    const ownerId = cookie.slice(0, separator);
    const supplied = Buffer.from(cookie.slice(separator + 1));
    const expected = Buffer.from(signature(ownerId));
    if (/^[A-Za-z0-9_-]{40,50}$/.test(ownerId) && supplied.length === expected.length && timingSafeEqual(supplied, expected)) return ownerId;
  }
  const ownerId = randomBytes(32).toString('base64url');
  const secure = req.secure || process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.append('Set-Cookie', `${COOKIE_NAME}=${ownerId}.${signature(ownerId)}; Path=/; Max-Age=${MAX_AGE_SECONDS}; HttpOnly; SameSite=Lax${secure}`);
  return ownerId;
}
