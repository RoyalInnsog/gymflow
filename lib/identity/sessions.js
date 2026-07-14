/*
 * [IDENTITY] DB-backed sessions with rotating refresh tokens + trusted devices.
 * One auth_sessions row per login. The access JWT stays stateless (1 h TTL,
 * carries sid); durability and revocation live here and are enforced at every
 * refresh. Refresh tokens are opaque 256-bit values stored only as sha256.
 */
const { getQuery, runQuery, allQuery } = require('../../database');
const core = require('./core');

const ROTATION_GRACE_MS = 30 * 1000; // concurrent-refresh grace window

// Create a session at login. Returns { sid, refreshToken } — the caller signs
// the access token with the sid and sets both cookies.
async function createSession({ user, remember, req, role }) {
  const sid = core.newId('sess');
  const refreshToken = core.randomToken(32);
  const ua = core.parseUserAgent(req.headers['user-agent']);
  const ttl = remember ? core.SESSION_REMEMBER_TTL_MS : core.SESSION_TTL_MS;
  await runQuery(
    `INSERT INTO auth_sessions (id, user_id, refresh_hash, remember, browser, os, device_label, ip, user_agent, scoped_tenant, scoped_role, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [sid, user.id, core.sha256(refreshToken), remember ? 1 : 0, ua.browser, ua.os, ua.label,
     req.ip || null, String(req.headers['user-agent'] || '').slice(0, 512),
     role ? role.tenant_id : null, role ? role.role_id : null,
     core.sqlTime(ttl)]
  );
  return { sid, refreshToken };
}

// Role selection is a token exchange; persist the chosen scope so refresh can
// re-derive the same claims (with FRESH permissions from the roles table).
async function scopeSession(sid, role) {
  await runQuery(`UPDATE auth_sessions SET scoped_tenant = ?, scoped_role = ? WHERE id = ?`, [role.tenant_id, role.role_id, sid]);
}

// Rotate a refresh token. Returns { session, refreshToken } on success or
// { error } with a reason. Reuse of a rotated-out token beyond the grace window
// is treated as theft: the whole session is revoked.
async function rotateRefresh(rawToken) {
  if (!rawToken) return { error: 'missing' };
  const hash = core.sha256(rawToken);
  let session = await getQuery(`SELECT * FROM auth_sessions WHERE refresh_hash = ?`, [hash]);
  if (!session) {
    const prev = await getQuery(`SELECT * FROM auth_sessions WHERE refresh_prev_hash = ?`, [hash]);
    if (!prev) return { error: 'unknown' };
    const rotatedAt = core.parseSqlTime(prev.rotated_at);
    if (prev.revoked_at || Date.now() - rotatedAt > ROTATION_GRACE_MS) {
      await revokeSession(prev.id, 'refresh_reuse');
      return { error: 'reuse', session: prev };
    }
    session = prev; // concurrent refresh inside the grace window — rotate again
  }
  if (session.revoked_at) return { error: 'revoked' };
  if (core.parseSqlTime(session.expires_at) < Date.now()) return { error: 'expired' };

  const next = core.randomToken(32);
  await runQuery(
    `UPDATE auth_sessions
        SET refresh_prev_hash = refresh_hash, refresh_hash = ?, rotated_at = CURRENT_TIMESTAMP, last_active = CURRENT_TIMESTAMP
      WHERE id = ?`,
    [core.sha256(next), session.id]
  );
  return { session, refreshToken: next };
}

async function touchAccess(sid, jti) {
  await runQuery(`UPDATE auth_sessions SET jti = ?, last_active = CURRENT_TIMESTAMP WHERE id = ?`, [jti, sid]);
}

async function revokeSession(sid, reason) {
  await runQuery(`UPDATE auth_sessions SET revoked_at = CURRENT_TIMESTAMP, revoke_reason = ? WHERE id = ? AND revoked_at IS NULL`, [reason || 'revoked', sid]);
  core.revokeSidLocal(sid);
}

// Revoke every session of an account (password reset, logout-all, suspension).
// exceptSid keeps the caller's own session alive when appropriate.
async function revokeAllSessions(userId, { exceptSid = null, reason = 'revoked' } = {}) {
  const rows = await allQuery(`SELECT id FROM auth_sessions WHERE user_id = ? AND revoked_at IS NULL`, [userId]);
  let revoked = 0;
  for (const r of rows) {
    if (exceptSid && r.id === exceptSid) continue;
    await revokeSession(r.id, reason);
    revoked++;
  }
  return revoked;
}

async function listSessions(userId, currentSid) {
  const rows = await allQuery(
    `SELECT id, browser, os, device_label, ip, created_at, last_active, remember
       FROM auth_sessions
      WHERE user_id = ? AND revoked_at IS NULL AND expires_at > CURRENT_TIMESTAMP
      ORDER BY last_active DESC`, [userId]);
  return rows.map(r => ({ ...r, remember: !!r.remember, current: r.id === currentSid }));
}

// ---------------------------------------------------------------------------
// Trusted devices — long-lived per-browser cookie; a login from a device the
// account has never seen produces a security event (and an alert email upstream).
// ---------------------------------------------------------------------------
async function recognizeDevice(req, res, user) {
  const raw = req.cookies.device_token;
  const ua = core.parseUserAgent(req.headers['user-agent']);
  if (raw) {
    const existing = await getQuery(
      `SELECT id FROM trusted_devices WHERE user_id = ? AND token_hash = ? AND revoked_at IS NULL`,
      [user.id, core.sha256(raw)]);
    if (existing) {
      await runQuery(`UPDATE trusted_devices SET last_seen = CURRENT_TIMESTAMP WHERE id = ?`, [existing.id]);
      return { isNew: false, deviceId: existing.id };
    }
  }
  const known = await getQuery(`SELECT COUNT(*) AS c FROM trusted_devices WHERE user_id = ?`, [user.id]);
  const token = raw || core.randomToken(24);
  const id = core.newId('dev');
  await runQuery(
    `INSERT OR IGNORE INTO trusted_devices (id, user_id, token_hash, browser, os, first_ip)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, user.id, core.sha256(token), ua.browser, ua.os, req.ip || null]);
  if (!raw) core.setDeviceCookie(req, res, token);
  // "New device" is only meaningful once the account has a device history —
  // the very first login should not alarm anyone.
  return { isNew: known.c > 0, deviceId: id, firstEver: known.c === 0 };
}

async function listDevices(userId, req) {
  const raw = req.cookies.device_token;
  const currentHash = raw ? core.sha256(raw) : null;
  const rows = await allQuery(
    `SELECT id, token_hash, browser, os, first_ip, created_at, last_seen
       FROM trusted_devices WHERE user_id = ? AND revoked_at IS NULL
      ORDER BY last_seen DESC`, [userId]);
  return rows.map(r => ({
    id: r.id, browser: r.browser, os: r.os, first_ip: r.first_ip,
    created_at: r.created_at, last_seen: r.last_seen, current: r.token_hash === currentHash
  }));
}

async function forgetDevice(userId, deviceId) {
  const r = await runQuery(`UPDATE trusted_devices SET revoked_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ? AND revoked_at IS NULL`, [deviceId, userId]);
  return r.changes > 0;
}

module.exports = {
  createSession, scopeSession, rotateRefresh, touchAccess,
  revokeSession, revokeAllSessions, listSessions,
  recognizeDevice, listDevices, forgetDevice
};
