/*
 * [IDENTITY] Refresh-token exchange, shared by the POST /auth/refresh endpoint
 * and the page shell's inline refresh (an expired access cookie on a page load
 * silently rotates instead of bouncing the user to /login).
 */
const { getQuery } = require('../../database');
const core = require('./core');
const sessions = require('./sessions');

// Rotate the refresh cookie into a fresh scoped access token. Returns the new
// decoded access claims, or null (with auth cookies cleared) when the session
// cannot be continued. Permissions are re-read from the roles table at every
// refresh, so permission/role changes propagate within the access TTL.
async function refreshWithCookie(req, res) {
  const raw = req.cookies.refresh_token;
  if (!raw) return null;
  const r = await sessions.rotateRefresh(raw);
  if (r.error) {
    core.clearAuthCookies(res);
    return null;
  }
  const session = r.session;
  const user = await getQuery(`SELECT * FROM users WHERE id = ?`, [session.user_id]);
  if (!core.isAccountActive(user)) {
    await sessions.revokeSession(session.id, 'suspended');
    core.clearAuthCookies(res);
    return null;
  }
  // Pending (role-picker) sessions do not refresh — the picker token is
  // deliberately short-lived; an expired one means signing in again.
  if (!session.scoped_role || !session.scoped_tenant) {
    await sessions.revokeSession(session.id, 'pending_expired');
    core.clearAuthCookies(res);
    return null;
  }
  const roles = await core.getUserRoles(user.id);
  const role = roles.find(x => x.tenant_id === session.scoped_tenant && x.role_id === session.scoped_role);
  if (!role) {
    await sessions.revokeSession(session.id, 'role_removed');
    core.clearAuthCookies(res);
    return null;
  }
  const remember = !!session.remember;
  const token = core.signScopedToken(user, role, remember, session.id);
  const decoded = core.verifyToken(token);
  core.setAuthCookie(req, res, token, remember, false);
  core.setRefreshCookie(req, res, r.refreshToken, remember);
  await sessions.touchAccess(session.id, decoded.jti);
  return decoded;
}

// Page-shell auth: verify the access cookie; when absent/expired/revoked, fall
// back to an inline refresh. Returns decoded claims or null.
async function resolvePageAuth(req, res) {
  const token = req.cookies.auth_token;
  if (token) {
    try {
      const decoded = core.verifyToken(token);
      const revoked = (decoded.jti && core.revokedTokens.has(decoded.jti)) ||
                      (decoded.sid && core.revokedSids.has(decoded.sid));
      if (!revoked) return decoded;
    } catch (e) { /* expired or invalid — attempt refresh below */ }
  }
  try {
    return await refreshWithCookie(req, res);
  } catch (e) {
    console.error('[identity] inline refresh failed:', e.message);
    return null;
  }
}

module.exports = { refreshWithCookie, resolvePageAuth };
