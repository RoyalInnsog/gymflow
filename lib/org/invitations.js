/*
 * [ORG] Staff invitation handshake. Owner/manager invites by email + role; the
 * invitee accepts on their next login. Server re-validates every step — the client
 * never asserts which org/role it is joining. Accepting is idempotent: it never
 * creates a duplicate membership or a duplicate staff record.
 */
const { getQuery, runQuery, allQuery } = require('../../database');
const core = require('../identity/core');
const membership = require('./membership');
const audit = require('./audit');

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Create (or replace the pending) invitation for (org, email). Returns the raw
// token so a caller with email delivery can send a link; detection also works at
// login without the link.
async function createInvitation({ tenantId, email, roleId, invitedBy }) {
  const normEmail = core.normalizeEmail(email);
  if (!core.isValidEmail(normEmail)) return { ok: false, code: 'BAD_EMAIL', error: 'Enter a valid email address.' };
  const role = await getQuery(`SELECT id, name FROM roles WHERE id = ? AND (tenant_id IS NULL OR tenant_id = ?)`, [roleId, tenantId]);
  if (!role) return { ok: false, code: 'BAD_ROLE', error: 'That role does not exist for this organization.' };

  // Already an active member with that email? Then there's nothing to invite.
  const existingMember = await getQuery(
    `SELECT ur.id FROM user_roles ur JOIN users u ON u.id = ur.user_id
      WHERE ur.tenant_id = ? AND u.email = ? AND ur.status = 'active'`, [tenantId, normEmail]);
  if (existingMember) return { ok: false, code: 'ALREADY_MEMBER', error: 'That email already belongs to a member of this organization.' };

  // One pending invite per (org, email): supersede any prior pending one.
  await runQuery(`UPDATE invitations SET status = 'revoked', decided_at = CURRENT_TIMESTAMP
                   WHERE tenant_id = ? AND email = ? AND status = 'pending'`, [tenantId, normEmail]);
  const token = core.randomToken(24);
  const id = 'inv_' + core.randomToken(8);
  await runQuery(
    `INSERT INTO invitations (id, tenant_id, email, role_id, token_hash, status, invited_by, expires_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
    [id, tenantId, normEmail, roleId, core.sha256(token), invitedBy, core.sqlTime(INVITE_TTL_MS)]);
  await audit.orgAudit({ tenantId, actorUserId: invitedBy, action: 'invitation_created', targetType: 'email', targetId: normEmail, meta: { role_id: roleId } });
  return { ok: true, id, token, role_name: role.name };
}

// Pending, unexpired invitations addressed to this account's email (with a lazy
// expire pass so stale ones self-correct).
async function pendingForEmail(email) {
  const normEmail = core.normalizeEmail(email);
  await runQuery(`UPDATE invitations SET status = 'expired' WHERE status = 'pending' AND expires_at < CURRENT_TIMESTAMP`);
  return allQuery(
    `SELECT i.id, i.tenant_id, i.role_id, i.expires_at, i.created_at,
            t.gym_name, r.name AS role_name, iu.full_name AS invited_by_name
       FROM invitations i
       JOIN tenants t ON t.id = i.tenant_id
       JOIN roles r ON r.id = i.role_id
       LEFT JOIN users iu ON iu.id = i.invited_by
      WHERE i.email = ? AND i.status = 'pending'
      ORDER BY i.created_at DESC`, [normEmail]);
}

async function listForOrg(tenantId) {
  await runQuery(`UPDATE invitations SET status = 'expired' WHERE status = 'pending' AND expires_at < CURRENT_TIMESTAMP`);
  return allQuery(
    `SELECT i.id, i.email, i.role_id, i.status, i.expires_at, i.created_at, r.name AS role_name
       FROM invitations i JOIN roles r ON r.id = i.role_id
      WHERE i.tenant_id = ? ORDER BY i.created_at DESC`, [tenantId]);
}

// Accept an invitation as the signed-in account. Validates ownership by email,
// pending state and expiry; then grants the membership + a staff HR row. Never
// duplicates either.
async function accept({ invitationId, user }) {
  const inv = await getQuery(`SELECT * FROM invitations WHERE id = ?`, [invitationId]);
  if (!inv) return { ok: false, code: 'NOT_FOUND', error: 'Invitation not found.' };
  if (core.normalizeEmail(inv.email) !== core.normalizeEmail(user.email)) {
    return { ok: false, code: 'WRONG_EMAIL', error: 'This invitation was sent to a different email address.' };
  }
  if (inv.status === 'accepted') return { ok: false, code: 'ALREADY_ACCEPTED', error: 'You have already accepted this invitation.' };
  if (inv.status !== 'pending') return { ok: false, code: 'INVITE_INACTIVE', error: 'This invitation is no longer active.' };
  if (core.parseSqlTime(inv.expires_at) < Date.now()) {
    await runQuery(`UPDATE invitations SET status = 'expired' WHERE id = ?`, [inv.id]);
    return { ok: false, code: 'INVITE_EXPIRED', error: 'This invitation has expired. Ask the gym to send a new one.' };
  }

  await membership.grantMembership({ userId: user.id, tenantId: inv.tenant_id, roleId: inv.role_id, invitedBy: inv.invited_by });

  // Mirror into the staff HR roster if not already present (no duplicate staff).
  const existingStaff = await getQuery(`SELECT id FROM staff WHERE tenant_id = ? AND user_id = ?`, [inv.tenant_id, user.id]);
  if (!existingStaff) {
    const role = await getQuery(`SELECT name FROM roles WHERE id = ?`, [inv.role_id]);
    const acct = await getQuery(`SELECT full_name, email, phone FROM users WHERE id = ?`, [user.id]);
    await runQuery(
      `INSERT INTO staff (id, tenant_id, user_id, name, role, email, phone, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active')`,
      ['stf_' + core.randomToken(8), inv.tenant_id, user.id, (acct && acct.full_name) || user.email,
       (role && role.name) || 'Staff', (acct && acct.email) || user.email, (acct && acct.phone) || null]);
  }

  await runQuery(`UPDATE invitations SET status = 'accepted', accepted_by_user_id = ?, decided_at = CURRENT_TIMESTAMP WHERE id = ?`, [user.id, inv.id]);
  await audit.orgAudit({ tenantId: inv.tenant_id, actorUserId: user.id, action: 'invitation_accepted', targetType: 'user', targetId: user.id, meta: { role_id: inv.role_id } });
  return { ok: true, tenant_id: inv.tenant_id, role_id: inv.role_id };
}

async function reject({ invitationId, user }) {
  const inv = await getQuery(`SELECT * FROM invitations WHERE id = ?`, [invitationId]);
  if (!inv) return { ok: false, code: 'NOT_FOUND', error: 'Invitation not found.' };
  if (core.normalizeEmail(inv.email) !== core.normalizeEmail(user.email)) {
    return { ok: false, code: 'WRONG_EMAIL', error: 'This invitation was sent to a different email address.' };
  }
  if (inv.status !== 'pending') return { ok: false, code: 'INVITE_INACTIVE', error: 'This invitation is no longer active.' };
  await runQuery(`UPDATE invitations SET status = 'rejected', decided_at = CURRENT_TIMESTAMP WHERE id = ?`, [inv.id]);
  await audit.orgAudit({ tenantId: inv.tenant_id, actorUserId: user.id, action: 'invitation_rejected', targetType: 'user', targetId: user.id });
  return { ok: true };
}

async function revoke({ invitationId, tenantId, actorUserId }) {
  const r = await runQuery(`UPDATE invitations SET status = 'revoked', decided_at = CURRENT_TIMESTAMP
                             WHERE id = ? AND tenant_id = ? AND status = 'pending'`, [invitationId, tenantId]);
  if (!r.changes) return { ok: false, code: 'NOT_FOUND', error: 'No pending invitation to revoke.' };
  await audit.orgAudit({ tenantId, actorUserId, action: 'invitation_revoked', targetType: 'invitation', targetId: invitationId });
  return { ok: true };
}

module.exports = { createInvitation, pendingForEmail, listForOrg, accept, reject, revoke };
