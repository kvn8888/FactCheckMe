import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { ApiError } from './errors.mjs';

const COOKIE_NAME = 'factcheckme_session';
const SESSION_SECONDS = 8 * 60 * 60;
const hashPattern = /^scrypt\$([a-f0-9]{32})\$([a-f0-9]{128})$/;

// This helper is used by the explicit, local password setup script, never at startup.
export function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  return `scrypt$${salt}$${scryptSync(password, salt, 64).toString('hex')}`;
}

export function createAuth({ env = process.env, now = () => Date.now() } = {}) {
  const platformProtected = () => env.VERCEL === '1' && env.VERCEL_AUTH_PROTECTED === 'true';
  const configured = () => platformProtected() || Boolean(hashPattern.test(env.APP_PASSWORD_HASH || '') &&
    typeof env.APP_SESSION_SECRET === 'string' && env.APP_SESSION_SECRET.length >= 32);
  const requireConfiguration = () => {
    if (!configured()) throw new ApiError(503, 'auth_not_configured', 'Private sign-in is not configured. Ask the owner to finish setup.');
  };
  const sign = (payload) => createHmac('sha256', `${env.APP_SESSION_SECRET}:${env.APP_PASSWORD_HASH}`).update(payload).digest('base64url');
  const authenticated = (req) => {
    if (platformProtected()) return true;
    if (!configured()) return false;
    const cookie = String(req.headers.cookie || '').split(';').map((part) => part.trim()).find((part) => part.startsWith(`${COOKIE_NAME}=`));
    if (!cookie || cookie.length > 2048) return false;
    const [payload, signature, extra] = cookie.slice(COOKIE_NAME.length + 1).split('.');
    if (!payload || !signature || extra) return false;
    const expected = sign(payload);
    if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return false;
    try {
      const value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      return value.sub === 'owner' && Number.isSafeInteger(value.exp) && value.exp > now() / 1000 && value.exp <= now() / 1000 + SESSION_SECONDS;
    } catch { return false; }
  };
  const cookie = (value, maxAge) => `${COOKIE_NAME}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${env.VERCEL || env.NODE_ENV === 'production' ? '; Secure' : ''}`;
  return {
    configured,
    mode: () => platformProtected() ? 'vercel' : 'password',
    authenticated,
    require(req) {
      requireConfiguration();
      if (!authenticated(req)) throw new ApiError(401, 'sign_in_required', 'Sign in to use FactCheckMe.');
    },
    login(password) {
      requireConfiguration();
      if (platformProtected()) throw new ApiError(400, 'platform_auth', 'Sign-in is managed by Vercel.');
      if (typeof password !== 'string' || password.length < 1 || password.length > 1024) throw new ApiError(401, 'invalid_credentials', 'Incorrect password.');
      const [, salt, expected] = env.APP_PASSWORD_HASH.match(hashPattern);
      const actual = scryptSync(password, salt, 64);
      if (!timingSafeEqual(actual, Buffer.from(expected, 'hex'))) throw new ApiError(401, 'invalid_credentials', 'Incorrect password.');
      const payload = Buffer.from(JSON.stringify({ sub: 'owner', exp: Math.floor(now() / 1000) + SESSION_SECONDS })).toString('base64url');
      return cookie(`${payload}.${sign(payload)}`, SESSION_SECONDS);
    },
    logout() { return cookie('', 0); },
  };
}

export function requireSameOrigin(req, env = process.env) {
  let actual;
  try { actual = new URL(String(req.headers.origin)); } catch { throw new ApiError(403, 'origin_required', 'A same-origin request is required.'); }
  const protocol = env.VERCEL || env.NODE_ENV === 'production' ? 'https' : 'http';
  const expected = env.APP_ORIGIN || `${protocol}://${req.headers.host}`;
  if (actual.origin !== expected) throw new ApiError(403, 'origin_denied', 'Cross-origin requests are not allowed.');
}

// Defense in depth per warm function instance. Enable Vercel Authentication for
// ALL deployments and platform-level rate limits; this is not a global limiter.
export function createRateLimiter({ now = () => Date.now() } = {}) {
  const buckets = new Map();
  return (key, max, windowMs) => {
    const time = now();
    if (buckets.size > 2000) for (const [id, bucket] of buckets) if (bucket.until <= time) buckets.delete(id);
    if (!buckets.has(key) && buckets.size >= 5000) throw new ApiError(429, 'rate_limited', 'Too many requests. Try again later.');
    let bucket = buckets.get(key);
    if (!bucket || bucket.until <= time) { bucket = { count: 0, until: time + windowMs }; buckets.set(key, bucket); }
    if (++bucket.count > max) throw new ApiError(429, 'rate_limited', 'Too many requests. Try again later.');
  };
}
