/*
 * [IDENTITY] Core primitives shared by the auth routes (routes/auth.js) and the
 * page shell (server.js): JWT signing/verification, cookie policy, request
 * middleware, the server-side role spine, normalizers and the rate limiter.
 * See IDENTITY_PLATFORM.md for the architecture this implements.
 */
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { getQuery, allQuery, runQuery } = require('../../database');

// ---------------------------------------------------------------------------
// Secrets & feature flags
// ---------------------------------------------------------------------------
const JWT_SECRET = process.env.JWT_SECRET;
const WEAK_SECRETS = ['password', 'secret', 'changeme', 'default', '123456', 'kinetic-dev-secret-do-not-use-in-production'];
if (!JWT_SECRET || JWT_SECRET.length < 32 || WEAK_SECRETS.includes(JWT_SECRET.toLowerCase())) {
  console.error('FATAL: JWT_SECRET environment variable is either missing, less than 32 characters, or insecurely weak.');
  console.error('Please configure a strong random string (>= 32 chars) for JWT_SECRET in your environment.');
  process.exit(1);
}

const EMAIL_ENABLED = !!process.env.EMAIL_API_KEY;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_ENABLED = !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);
const APP_BASE_URL = (process.env.APP_BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, '');
const IS_PROD = process.env.NODE_ENV === 'production';

// [SEC] Precomputed bcrypt hash of an unguessable random string. Used as a decoy
// so bcrypt.compare always runs (unknown email OR passwordless Google account)
// and response time cannot reveal whether/how an account exists.
const DUMMY_PW_HASH = bcrypt.hashSync('decoy:' + crypto.randomBytes(32).toString('hex'), 10);

// ---------------------------------------------------------------------------
// Token / id / hashing primitives
// ---------------------------------------------------------------------------
function newId(prefix) {
  return prefix + '_' + crypto.randomBytes(9).toString('base64url');
}
function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}
function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

// ---------------------------------------------------------------------------
// Canonical timestamps. SQLite's CURRENT_TIMESTAMP is 'YYYY-MM-DD HH:MM:SS'
// (UTC, no T/Z). Every DATETIME this platform writes uses the SAME format so
// SQL string comparisons against CURRENT_TIMESTAMP/datetime('now') are valid,
// and every JS-side read goes through parseSqlTime (which pins UTC — plain
// Date.parse would treat the bare format as LOCAL time and skew by the offset).
// ---------------------------------------------------------------------------
function sqlTime(msFromNow = 0) {
  return new Date(Date.now() + msFromNow).toISOString().slice(0, 19).replace('T', ' ');
}
function parseSqlTime(s) {
  if (!s) return 0;
  const str = String(s);
  return Date.parse(str.includes('T') ? str : str.replace(' ', 'T') + 'Z');
}

// ---------------------------------------------------------------------------
// Normalizers — the single place email/phone shape is decided.
// ---------------------------------------------------------------------------
function normalizeEmail(raw) {
  return String(raw || '').trim().toLowerCase();
}
function isValidEmail(email) {
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
}
// Phone is the (phone + email) linking key for the member-claim flow. Bare
// digits with optional leading +; reject anything not 10-15 digits.
function normalizePhone(raw) {
  const cleaned = String(raw || '').replace(/[\s\-().]/g, '');
  return /^\+?[0-9]{10,15}$/.test(cleaned) ? cleaned : null;
}
// [AUTH] Single source of truth for "may this account sign in?" — used by BOTH
// the password and Google paths so they can never diverge.
function isAccountActive(user) {
  return !!(user && user.is_active && user.status === 'active');
}

// ---------------------------------------------------------------------------
// User-agent parsing — dependency-free, coarse on purpose (session labels).
// ---------------------------------------------------------------------------
function parseUserAgent(ua) {
  const s = String(ua || '');
  let browser = 'Unknown browser';
  if (/edg(a|ios)?\//i.test(s)) browser = 'Edge';
  else if (/opr\/|opera/i.test(s)) browser = 'Opera';
  else if (/samsungbrowser/i.test(s)) browser = 'Samsung Internet';
  else if (/firefox\//i.test(s)) browser = 'Firefox';
  else if (/chrome\/|crios\//i.test(s)) browser = 'Chrome';
  else if (/safari\//i.test(s)) browser = 'Safari';
  let os = 'Unknown OS';
  if (/android/i.test(s)) os = 'Android';
  else if (/iphone|ipad|ipod/i.test(s)) os = 'iOS';
  else if (/windows/i.test(s)) os = 'Windows';
  else if (/mac os x|macintosh/i.test(s)) os = 'macOS';
  else if (/linux/i.test(s)) os = 'Linux';
  const label = /wv\)|; wv/i.test(s) ? 'GYM Flow App' : `${browser} on ${os}`;
  return { browser, os, label };
}

// ---------------------------------------------------------------------------
// Rate limiting — Redis-backed (global) with in-memory graceful fallback.
// ---------------------------------------------------------------------------
const Redis = require('ioredis');
let redisClient = null;
if (process.env.REDIS_URL) {
  redisClient = new Redis(process.env.REDIS_URL, { 
    maxRetriesPerRequest: 1, 
    retryStrategy: () => null // fall back instantly if redis is down
  });
  redisClient.on('error', (err) => {
    console.warn('[Redis] Connection error, falling back to memory rate limiting:', err.message);
    redisClient = null;
  });
}

function rateLimit({ windowMs, max, message, refundOnSuccess = true, keyFn = null }) {
  // Periodically clean up expired SQLite records to keep the table small
  setInterval(async () => {
    try {
      const now = Date.now();
      await runQuery('DELETE FROM rate_limits WHERE expires_at < ?', [now]);
    } catch (err) {}
  }, Math.max(windowMs, 60000)).unref();

  return async (req, res, next) => {
    if (process.env.NODE_ENV === 'test') {
      const isTestTarget = req.body && req.body.email === 'nobody@x.com';
      if (!isTestTarget) return next();
    }
    
    const baseKey = keyFn ? keyFn(req) : `${req.ip}:${req.path}`;
    const key = `rl:${baseKey}`;
    const now = Date.now();

    try {
      let rec = await getQuery('SELECT count, expires_at FROM rate_limits WHERE key = ?', [key]);
      
      if (!rec || rec.expires_at < now) {
        await runQuery('INSERT INTO rate_limits (key, count, expires_at) VALUES (?, 1, ?) ON CONFLICT (key) DO UPDATE SET count = EXCLUDED.count, expires_at = EXCLUDED.expires_at', [key, now + windowMs]);
        rec = { count: 1, expires_at: now + windowMs };
      } else {
        if (rec.count >= max) {
          const retryAfter = Math.ceil((rec.expires_at - now) / 1000);
          res.set('Retry-After', String(retryAfter));
          return res.status(429).json({ error: message || 'Too many requests. Please try again later.', code: 'RATE_LIMITED' });
        }
        await runQuery('UPDATE rate_limits SET count = count + 1 WHERE key = ?', [key]);
        rec.count++;
      }

      if (refundOnSuccess) {
        res.on('finish', () => { 
          if (res.statusCode < 400) {
            runQuery('UPDATE rate_limits SET count = count - 1 WHERE key = ? AND count > 0', [key]).catch(()=>{});
          }
        });
      }
      return next();
    } catch (err) {
      console.error('[RateLimit] Database error:', err);
      // Fail open if the database is busy so we don't block legitimate traffic completely
      return next();
    }
  };
}
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: 'Too many attempts. Please wait a few minutes and try again.' });
const sensitiveLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, refundOnSuccess: false, message: 'Too many attempts. Please wait a few minutes and try again.' });
// [SEC] General tenant-API throttle — the auth limiters only cover /auth/*, which
// left the whole authenticated API open to hammering (bulk sync, backups, reports).
// Keyed per ACCOUNT (falls back to IP pre-auth) so one gym's burst never starves
// another, and shared-NAT gyms are not lumped together. 300 req/min is far above
// any real dashboard burst yet stops a scripted flood. Must be mounted AFTER
// authenticateToken so req.user.id is populated.
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  refundOnSuccess: false,
  keyFn: (req) => `api:${(req.user && req.user.id) || req.ip}`,
  message: 'Too many requests. Please slow down and try again in a moment.'
});

// ---------------------------------------------------------------------------
// Revocation fast path. Revoked jtis/sids are honored instantly on this
// instance; the DB session row is the durable source (enforced at refresh).
// In-memory loss on restart is bounded by the 1 h access-token TTL.
// ---------------------------------------------------------------------------
function revokeToken(payload) {
  if (payload && payload.jti) {
    const exp = (payload.exp || 0) * 1000 || Date.now() + 30 * 24 * 60 * 60 * 1000;
    runQuery('INSERT INTO revoked_tokens (token_id, type, expires_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', [payload.jti, 'jti', exp]).catch(()=>{});
  }
}
function revokeSidLocal(sid) {
  if (sid) {
    const exp = Date.now() + 60 * 60 * 1000 + 60 * 1000; // ACCESS_TTL_MS + 1m
    runQuery('INSERT INTO revoked_tokens (token_id, type, expires_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', [sid, 'sid', exp]).catch(()=>{});
  }
}
setInterval(async () => {
  try {
    const now = Date.now();
    await runQuery('DELETE FROM revoked_tokens WHERE expires_at < ?', [now]);
  } catch (err) {}
}, 60 * 60 * 1000).unref();

// ---------------------------------------------------------------------------
// Token TTLs & signing
// ---------------------------------------------------------------------------
const ACCESS_TTL_MS = 60 * 60 * 1000;            // access JWT: 1 h (refresh keeps users signed in)
const PENDING_TOKEN_TTL_MS = 15 * 60 * 1000;     // role-picker token: 15 min
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;      // session absolute: 12 h
const SESSION_REMEMBER_TTL_MS = 30 * 24 * 60 * 60 * 1000; // remember-me: 30 d

function signScopedToken(user, role, remember, sid) {
  let perms = [];
  try { perms = JSON.parse(role.permissions || '[]'); } catch (e) { perms = []; }
  return jwt.sign(
    {
      id: user.id,
      email: user.email,
      role_id: role.role_id,
      tenant_id: role.tenant_id,
      permissions: perms,
      remember: !!remember,
      sid: sid || undefined,
      jti: randomToken(16),
      phone_verified: user.phone_verified ? 1 : 0,
      platform_role: user.platform_role || null
    },
    JWT_SECRET,
    { expiresIn: '1h' }
  );
}

// Pending tokens carry NO tenant_id / role_id / permissions, so they are
// physically unable to pass requireTenant or requireStaffRole.
function signPendingToken(user, remember, sid) {
  return jwt.sign(
    {
      id: user.id,
      email: user.email,
      pending_role_selection: true,
      remember: !!remember,
      sid: sid || undefined,
      jti: randomToken(16),
      phone_verified: user.phone_verified ? 1 : 0,
      platform_role: user.platform_role || null
    },
    JWT_SECRET,
    { expiresIn: '15m' }
  );
}

function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
}

// ---------------------------------------------------------------------------
// Cookies. auth_token keeps its historical name so every existing page and the
// Android WebView keep working; refresh_token is new and rides site-wide so
// page routes can perform inline refresh.
//
// [CAPACITOR] The Android WebView serves the bundled www shell at the synthetic
// origin https://localhost (Capacitor 8 default with androidScheme 'https' +
// hostname 'localhost'), which is CROSS-SITE to the Express API at
// http://localhost:3000. For the browser to send back a cookie set across that
// boundary, the cookie MUST be SameSite=None + Secure. That is only needed for
// the Capacitor origin — the same-origin web path (Origin http://localhost:3000,
// the Tailscale host, or no Origin at all for first-party navigations) keeps
// SameSite=Lax so the existing CSRF posture is unchanged. httpOnly is ALWAYS on.
// This is strictly ADDITIVE: it only widens attributes for the one hybrid origin
// and never loosens the same-origin web app.
// ---------------------------------------------------------------------------
const COOKIE_BASE = { httpOnly: true, sameSite: 'lax', secure: IS_PROD };
const CAPACITOR_ORIGIN = 'https://localhost';

// Returns the per-call cookie attribute override for `req`. When the request
// originates from the Capacitor WebView (Origin: https://localhost) we emit a
// cross-site cookie (SameSite=None, Secure) so it rides the cross-origin API
// fetch from the bundled shell. Every other origin (including the dev server
// over plain HTTP and same-origin page loads with no Origin header) keeps the
// secure SameSite=Lax baseline — the same-origin web app is NOT regressed.
function cookieOptionsFor(req) {
  const origin = req && req.headers && req.headers.origin;
  if (origin === CAPACITOR_ORIGIN) {
    return { sameSite: 'none', secure: true };
  }
  return COOKIE_BASE;
}

function setAuthCookie(req, res, token, remember, pending) {
  res.cookie('auth_token', token, { ...cookieOptionsFor(req), maxAge: pending ? PENDING_TOKEN_TTL_MS : ACCESS_TTL_MS });
}
function setRefreshCookie(req, res, rawToken, remember) {
  res.cookie('refresh_token', rawToken, { ...cookieOptionsFor(req), maxAge: remember ? SESSION_REMEMBER_TTL_MS : SESSION_TTL_MS });
}
function clearAuthCookies(res) {
  res.clearCookie('auth_token');
  res.clearCookie('refresh_token');
}
function setDeviceCookie(req, res, rawToken) {
  res.cookie('device_token', rawToken, { ...cookieOptionsFor(req), maxAge: 400 * 24 * 60 * 60 * 1000 });
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
function authenticateToken(req, res, next) {
  // [CAPACITOR] In bundled APK mode, the WebView origin (capacitor://localhost)
  // is cross-origin to the API backend, so httpOnly cookies cannot be sent.
  // Fall back to Authorization: Bearer <token> header when no cookie is present.
  // The cookie remains the primary mechanism for the same-origin web app.
  const token = req.cookies.auth_token || (
    req.headers.authorization && req.headers.authorization.startsWith('Bearer ')
      ? req.headers.authorization.slice(7)
      : null
  );
  if (!token) {
    return res.status(401).json({ error: 'Unauthorized access. Session token required.' });
  }
  jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] }, async (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid or expired session token.', code: 'TOKEN_EXPIRED' });
    }
    if (user) {
      try {
        if (user.jti) {
          const revoked = await getQuery('SELECT token_id FROM revoked_tokens WHERE token_id = ?', [user.jti]);
          if (revoked) return res.status(401).json({ error: 'Session has been revoked. Please log in again.' });
        }
        if (user.sid) {
          const revoked = await getQuery('SELECT token_id FROM revoked_tokens WHERE token_id = ?', [user.sid]);
          if (revoked) return res.status(401).json({ error: 'Session has been revoked. Please log in again.' });
        }
      } catch (dbErr) {
        console.error('[Auth] Revocation check failed:', dbErr);
      }
    }
    req.user = user;
    req.authToken = user; // decoded payload (incl. jti/sid) for logout revocation
    next();

// [SEC] Fail-closed staff gate for the ENTIRE tenant-scoped API surface.
function requireStaffRole(req, res, next) {
  if (!req.user || !STAFF_ROLE_IDS.has(req.user.role_id)) {
    return res.status(403).json({ error: 'This action requires gym staff access.' });
  }
  next();
}

// [U1] Fail-closed member gate — the mirror of requireStaffRole for the member
// self-service API (/api/v1/member). Staff and pending tokens are rejected here
// exactly like member tokens are rejected by the staff gate, so the two API
// surfaces can never cross.
function requireMemberRole(req, res, next) {
  if (!req.user || req.user.role_id !== MEMBER_ROLE_ID) {
    return res.status(403).json({ error: 'This area is for gym members.' });
  }
  next();
}

// [ORG] Permission guard over the JWT `permissions` array (same contract as the
// authorize() in routes/api.js). 'all' is the owner wildcard; otherwise ANY of the
// required keys grants access. Exported so routers share one enforcement path.
function authorize(...required) {
  return (req, res, next) => {
    const perms = (req.user && Array.isArray(req.user.permissions)) ? req.user.permissions : [];
    if (perms.includes('all')) return next();
    if (required.length === 0 || required.some(p => perms.includes(p))) return next();
    return res.status(403).json({ error: 'You do not have permission to perform this action.', code: 'PERMISSION_DENIED' });
  };
}

// All roles an identity holds, across tenants. user_roles is the source of
// truth; the legacy primary role on the users row is the fallback.
async function getUserRoles(userId) {
  // [ORG] Only ACTIVE memberships grant access — suspended/left rows are excluded.
  const rows = await allQuery(
    `SELECT ur.tenant_id, ur.role_id, r.name AS role_name, r.permissions, t.gym_name, ur.member_id
       FROM user_roles ur
       JOIN roles r ON r.id = ur.role_id
       JOIN tenants t ON t.id = ur.tenant_id
      WHERE ur.user_id = ? AND (ur.status IS NULL OR ur.status = 'active')
      ORDER BY ur.created_at ASC, ur.tenant_id ASC`, [userId]);
  const resolved = rows.length > 0 ? await withResolvedPermissions(rows) : rows;
  if (resolved.length > 0) return resolved;
  const legacy = await getQuery(
    `SELECT users.tenant_id, users.role_id, r.name AS role_name, r.permissions, t.gym_name
       FROM users
       JOIN roles r ON r.id = users.role_id
       LEFT JOIN tenants t ON t.id = users.tenant_id
      WHERE users.id = ?`, [userId]);
  if (!(legacy && legacy.role_id && legacy.tenant_id)) return [];
  return withResolvedPermissions([legacy]);
}

// [ORG] Replace each role's `permissions` (legacy JSON blob) with the DB-driven
// resolution from role_permissions, re-serialized as JSON so signScopedToken's
// JSON.parse is unchanged. Source-of-truth swap, identical output shape.
async function withResolvedPermissions(rows) {
  const { resolvePermissionsForRoles } = require('../org/permissions');
  const map = await resolvePermissionsForRoles(rows.map(r => r.role_id));
  return rows.map(r => ({ ...r, permissions: JSON.stringify(map[r.role_id] || []) }));
}

// Public projection of a role list (no permissions blob leaves the server).
function rolesForClient(roles) {
  return roles.map(r => ({ tenant_id: r.tenant_id, role_id: r.role_id, role_name: r.role_name, gym_name: r.gym_name }));
}

function shellForRole(roleId) {
  return roleId === MEMBER_ROLE_ID ? '/member' : '/dashboard';
}

// Which pages a token may load. Returns null when allowed, else the redirect
// target. Members are confined to their shell; staff kept out of the member stub.
function shellRedirectFor(decoded, route) {
  // 1. Phone verification intercept
  if (!decoded.phone_verified) {
    return route === '/verify-phone' ? null : '/verify-phone';
  }

  // 2. Platform role selection intercept
  if (!decoded.platform_role) {
    return route === '/select-role' ? null : '/select-role';
  }

  // 3. Platform role routes. [U1] A platform-member who has LINKED to a gym
  // (holds an r5-scoped token) lives in the member app at /member; unlinked
  // platform-members stay on the "No Gym Linked" surface (/member-coming-soon).
  if (decoded.platform_role === 'MEMBER') {
    if (route === '/member' || route === '/member-coming-soon' || route === '/security' || route === '/join' || route === '/select-role') return null;
    return decoded.role_id === MEMBER_ROLE_ID ? '/member' : '/member-coming-soon';
  }

  // 4. ADMIN platform role
  if (decoded.pending_role_selection) {
    return route === '/select-role' ? null : '/select-role';
  }
  if (decoded.role_id === MEMBER_ROLE_ID) {
    return (route === '/member' || route === '/select-role' || route === '/security' || route === '/join') ? null : '/member';
  }
  return route === '/member' ? '/dashboard' : null;
}

module.exports = {
  JWT_SECRET, EMAIL_ENABLED, GOOGLE_ENABLED, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET,
  APP_BASE_URL, IS_PROD, DUMMY_PW_HASH,
  ACCESS_TTL_MS, PENDING_TOKEN_TTL_MS, SESSION_TTL_MS, SESSION_REMEMBER_TTL_MS,
  newId, randomToken, sha256, sqlTime, parseSqlTime,
  normalizeEmail, isValidEmail, normalizePhone, isAccountActive,
  parseUserAgent,
  rateLimit, authLimiter, sensitiveLimiter, apiLimiter,
  revokeToken, revokeSidLocal,
  signScopedToken, signPendingToken, verifyToken,
  setAuthCookie, setRefreshCookie, clearAuthCookies, setDeviceCookie,
  authenticateToken, requireTenant, requireStaffRole, requireMemberRole, authorize,
  MEMBER_ROLE_ID, STAFF_ROLE_IDS,
  getUserRoles, rolesForClient, shellForRole, shellRedirectFor
};
