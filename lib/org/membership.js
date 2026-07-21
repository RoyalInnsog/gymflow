/*
 * [ORG] Organization membership lifecycle over the user_roles junction (which IS
 * "organization membership"). Join, suspend, reactivate, role-change, remove/leave,
 * ownership transfer — each guarded server-side and written to membership_history.
 * The last active owner of an org can never be removed, suspended or demoted.
 */
const { getQuery, runQuery, allQuery } = require('../../database');
const audit = require('./audit');
const sessions = require('../identity/sessions');

const OWNER_ROLE_ID = 'r1';

// [SEC] A privilege change (suspend/remove/demote/transfer) must take effect
// immediately, not only when the affected user's ≤1h access token next refreshes.
// Revoking their sessions forces a fresh sign-in that re-reads current roles and
// permissions from the DB. Best-effort — never let it break the admin action.
async function revokeUserSessions(userId, reason) {
  try { await sessions.revokeAllSessions(userId, { reason }); }
  catch (e) { console.error('[org] session revoke after membership change failed:', e.message); }
}

function urId(userId, tenantId, roleId) {
  return 'ur_' + userId + '_' + tenantId + '_' + roleId;
}

async function countActiveOwners(tenantId, exceptUserId = null) {
  const rows = await allQuery(
    `SELECT user_id FROM user_roles WHERE tenant_id = ? AND role_id = ? AND status = 'active'`,
    [tenantId, OWNER_ROLE_ID]);
  return rows.filter(r => r.user_id !== exceptUserId).length;
}

// Grant (or reactivate) a membership. Idempotent — never creates a duplicate row.
async function grantMembership({ userId, tenantId, roleId, memberId = null, invitedBy = null, actorUserId = null }) {
  const existing = await getQuery(
    `SELECT id, status FROM user_roles WHERE user_id = ? AND tenant_id = ? AND role_id = ?`,
    [userId, tenantId, roleId]);
  if (existing) {
    if (existing.status !== 'active') {
      await runQuery(`UPDATE user_roles SET status = 'active', suspended_at = NULL, left_at = NULL WHERE id = ?`, [existing.id]);
      await audit.membershipHistory({ tenantId, userId, action: 'reactivated', toRole: roleId, actorUserId });
    }
    if (memberId) await runQuery(`UPDATE user_roles SET member_id = ? WHERE id = ?`, [memberId, existing.id]);
    return { id: existing.id, created: false };
  }
  const id = urId(userId, tenantId, roleId);
  await runQuery(
    `INSERT INTO user_roles (id, user_id, tenant_id, role_id, member_id, status, invited_by, joined_at) VALUES (?, ?, ?, ?, ?, 'active', ?, CURRENT_TIMESTAMP) ON CONFLICT DO NOTHING`,
    [id, userId, tenantId, roleId, memberId, invitedBy]);
  await audit.membershipHistory({ tenantId, userId, action: 'joined', toRole: roleId, actorUserId: actorUserId || invitedBy });
  return { id, created: true };
}

async function listOrgMembers(tenantId) {
  return allQuery(
    `SELECT ur.user_id, ur.role_id, ur.status, ur.joined_at, ur.member_id,
            r.name AS role_name, u.full_name, u.email, u.phone
       FROM user_roles ur
       JOIN roles r ON r.id = ur.role_id
       JOIN users u ON u.id = ur.user_id
      WHERE ur.tenant_id = ?
      ORDER BY (ur.role_id = 'r1') DESC, ur.joined_at ASC`, [tenantId]);
}

async function changeRole({ tenantId, userId, newRoleId, actorUserId }) {
  const current = await getQuery(
    `SELECT id, role_id FROM user_roles WHERE user_id = ? AND tenant_id = ? AND status = 'active' ORDER BY (role_id='r1') DESC LIMIT 1`,
    [userId, tenantId]);
  if (!current) return { ok: false, code: 'NOT_MEMBER', error: 'That account is not a member of this organization.' };
  if (current.role_id === OWNER_ROLE_ID && newRoleId !== OWNER_ROLE_ID && await countActiveOwners(tenantId, userId) === 0) {
    return { ok: false, code: 'LAST_OWNER', error: 'You cannot change the role of the only owner. Transfer ownership first.' };
  }
  const role = await getQuery(`SELECT id FROM roles WHERE id = ? AND (tenant_id IS NULL OR tenant_id = ?)`, [newRoleId, tenantId]);
  if (!role) return { ok: false, code: 'BAD_ROLE', error: 'That role does not exist for this organization.' };
  // Re-key the row so its deterministic id stays consistent (user,tenant,role).
  await runQuery(`DELETE FROM user_roles WHERE id = ?`, [current.id]);
  await grantMembership({ userId, tenantId, roleId: newRoleId, actorUserId });
  await audit.membershipHistory({ tenantId, userId, action: 'role_changed', fromRole: current.role_id, toRole: newRoleId, actorUserId });
  await revokeUserSessions(userId, 'role_changed');
  return { ok: true };
}

async function setStatus({ tenantId, userId, status, actorUserId }) {
  const rows = await allQuery(`SELECT id, role_id FROM user_roles WHERE user_id = ? AND tenant_id = ?`, [userId, tenantId]);
  if (rows.length === 0) return { ok: false, code: 'NOT_MEMBER', error: 'That account is not a member of this organization.' };
  const isOwner = rows.some(r => r.role_id === OWNER_ROLE_ID);
  if (isOwner && status !== 'active' && await countActiveOwners(tenantId, userId) === 0) {
    return { ok: false, code: 'LAST_OWNER', error: 'You cannot suspend or remove the only owner. Transfer ownership first.' };
  }
  const col = status === 'suspended' ? 'suspended_at' : (status === 'left' ? 'left_at' : null);
  for (const r of rows) {
    await runQuery(`UPDATE user_roles SET status = ?${col ? `, ${col} = CURRENT_TIMESTAMP` : ''} WHERE id = ?`, [status, r.id]);
  }
  const action = status === 'suspended' ? 'suspended' : (status === 'active' ? 'reactivated' : (status === 'left' ? 'left' : 'removed'));
  await audit.membershipHistory({ tenantId, userId, action, actorUserId });
  // Suspending/removing revokes access now; reactivating needs no revoke.
  if (status !== 'active') await revokeUserSessions(userId, 'membership_' + status);
  return { ok: true };
}

async function removeMembership({ tenantId, userId, actorUserId }) {
  const rows = await allQuery(`SELECT id, role_id FROM user_roles WHERE user_id = ? AND tenant_id = ?`, [userId, tenantId]);
  if (rows.length === 0) return { ok: false, code: 'NOT_MEMBER', error: 'That account is not a member of this organization.' };
  if (rows.some(r => r.role_id === OWNER_ROLE_ID) && await countActiveOwners(tenantId, userId) === 0) {
    return { ok: false, code: 'LAST_OWNER', error: 'You cannot remove the only owner. Transfer ownership first.' };
  }
  await runQuery(`DELETE FROM user_roles WHERE user_id = ? AND tenant_id = ?`, [userId, tenantId]);
  await audit.membershipHistory({ tenantId, userId, action: 'removed', actorUserId });
  await revokeUserSessions(userId, 'membership_removed');
  return { ok: true };
}

// Ownership transfer: promote the target to Owner, demote the current owner to
// the given fallback role (default Manager). Atomic-ish; keeps at least one owner
// at all times, and updates tenants.owner_user_id (the display/billing owner).
async function transferOwnership({ tenantId, fromUserId, toUserId, demoteToRoleId = 'r2', actorUserId }) {
  if (fromUserId === toUserId) return { ok: false, code: 'SAME_USER', error: 'That account is already the owner.' };
  const target = await getQuery(`SELECT id FROM user_roles WHERE user_id = ? AND tenant_id = ? AND status = 'active'`, [toUserId, tenantId]);
  if (!target) return { ok: false, code: 'NOT_MEMBER', error: 'The new owner must already be a member of this organization.' };
  await grantMembership({ userId: toUserId, tenantId, roleId: OWNER_ROLE_ID, actorUserId });
  // Demote previous owner (unless they are also being kept as owner explicitly).
  await runQuery(`DELETE FROM user_roles WHERE user_id = ? AND tenant_id = ? AND role_id = 'r1'`, [fromUserId, tenantId]);
  await grantMembership({ userId: fromUserId, tenantId, roleId: demoteToRoleId, actorUserId });
  await runQuery(`UPDATE tenants SET owner_user_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [toUserId, tenantId]);
  await audit.membershipHistory({ tenantId, userId: toUserId, action: 'ownership_transferred', toRole: OWNER_ROLE_ID, actorUserId });
  await audit.membershipHistory({ tenantId, userId: fromUserId, action: 'role_changed', fromRole: OWNER_ROLE_ID, toRole: demoteToRoleId, actorUserId });
  // The demoted owner must lose owner powers immediately; the new owner re-scopes
  // on next sign-in. Revoke both so neither keeps a stale privilege in their token.
  await revokeUserSessions(fromUserId, 'ownership_transferred');
  await revokeUserSessions(toUserId, 'ownership_transferred');
  return { ok: true };
}

module.exports = {
  OWNER_ROLE_ID, grantMembership, listOrgMembers, changeRole, setStatus, removeMembership,
  transferOwnership, countActiveOwners
};
