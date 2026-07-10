/*
 * [ORG] Organization & Identity Graph API. Mounted at /api/v1/org with
 * authenticateToken only (like /api/v1/auth) — identity/org membership is
 * account-level. Admin routes add requireTenant + a permission guard INSIDE the
 * router, so a member-role token can still reach the account-level endpoints
 * (context, invitations, claims) that it legitimately needs.
 *
 * Org SWITCHING reuses POST /auth/select-role (F1) — not duplicated here.
 * Design contract: ORG_PLATFORM.md. Errors: { error, code? }.
 */
const express = require('express');
const { getQuery, runQuery, allQuery } = require('../database');
const core = require('../lib/identity/core');
const perms = require('../lib/org/permissions');
const invitations = require('../lib/org/invitations');
const claims = require('../lib/org/claims');
const membership = require('../lib/org/membership');
const audit = require('../lib/org/audit');

const router = express.Router();
const { requireTenant, authorize } = core;

// ---------------------------------------------------------------------------
// ACCOUNT-LEVEL (auth only) — the switcher, pending invitations & claims.
// ---------------------------------------------------------------------------

// One call the app shell makes on load: current org, all orgs, and anything
// pending that needs the user's attention.
router.get('/context', async (req, res) => {
  try {
    const roles = await core.getUserRoles(req.user.id);
    const current = roles.find(r => r.tenant_id === req.user.tenant_id && r.role_id === req.user.role_id) || null;
    const pendingInvites = await invitations.pendingForEmail(req.user.email);
    const pendingClaims = await claims.findCandidateMatches(req.user.id);
    res.json({
      current: current ? { tenant_id: current.tenant_id, role_id: current.role_id, role_name: current.role_name, gym_name: current.gym_name } : null,
      organizations: core.rolesForClient(roles),
      pending_invitations: pendingInvites.map(i => ({
        id: i.id, tenant_id: i.tenant_id, gym_name: i.gym_name, role_name: i.role_name,
        invited_by_name: i.invited_by_name, expires_at: i.expires_at
      })),
      pending_claims: pendingClaims,
      linked_member_count: roles.filter(r => r.member_id).length
    });
  } catch (err) {
    console.error('Org context error:', err);
    res.status(500).json({ error: 'Failed to load organization context.' });
  }
});

router.get('/organizations', async (req, res) => {
  try {
    res.json({ organizations: core.rolesForClient(await core.getUserRoles(req.user.id)) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load organizations.' });
  }
});

router.get('/invitations/pending', async (req, res) => {
  try {
    const list = await invitations.pendingForEmail(req.user.email);
    res.json({ invitations: list.map(i => ({ id: i.id, gym_name: i.gym_name, role_name: i.role_name, invited_by_name: i.invited_by_name, expires_at: i.expires_at })) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load invitations.' });
  }
});

router.post('/invitations/:id/accept', async (req, res) => {
  try {
    const r = await invitations.accept({ invitationId: req.params.id, user: req.user });
    if (!r.ok) return res.status(r.code === 'INVITE_EXPIRED' ? 410 : 400).json({ error: r.error, code: r.code });
    res.json({ message: 'Invitation accepted. Switch to the organization to get started.', tenant_id: r.tenant_id, role_id: r.role_id });
  } catch (err) {
    console.error('Invite accept error:', err);
    res.status(500).json({ error: 'Failed to accept invitation.' });
  }
});

router.post('/invitations/:id/reject', async (req, res) => {
  try {
    const r = await invitations.reject({ invitationId: req.params.id, user: req.user });
    if (!r.ok) return res.status(400).json({ error: r.error, code: r.code });
    res.json({ message: 'Invitation declined.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to decline invitation.' });
  }
});

router.get('/claims/pending', async (req, res) => {
  try {
    res.json({ claims: await claims.findCandidateMatches(req.user.id) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load claim suggestions.' });
  }
});

// "Yes, I belong to this gym."
router.post('/claims/accept', async (req, res) => {
  const { tenant_id, member_id } = req.body || {};
  if (!tenant_id || !member_id) return res.status(400).json({ error: 'tenant_id and member_id are required.' });
  try {
    const r = await claims.submitClaim({ user: req.user, tenantId: tenant_id, memberId: member_id });
    if (!r.ok) return res.status(400).json({ error: r.error, code: r.code });
    res.json({ message: r.linked ? 'You are now linked to this gym.' : r.message, status: r.status, linked: r.linked });
  } catch (err) {
    console.error('Claim accept error:', err);
    res.status(500).json({ error: 'Failed to submit claim.' });
  }
});

// "Not now."
router.post('/claims/dismiss', async (req, res) => {
  const { tenant_id, member_id } = req.body || {};
  if (!tenant_id || !member_id) return res.status(400).json({ error: 'tenant_id and member_id are required.' });
  try {
    await claims.dismissClaim({ user: req.user, tenantId: tenant_id, memberId: member_id });
    res.json({ message: 'Dismissed.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to dismiss.' });
  }
});

// ---------------------------------------------------------------------------
// ORG-ADMIN (auth + current tenant + permission). Acts on req.user.tenant_id —
// the org the token is currently scoped to; one org can never act on another.
// ---------------------------------------------------------------------------
const canInvite = [requireTenant, authorize('staff:invite', 'staff:write')];
const canManageMembers = [requireTenant, authorize('staff:write', 'org:manage')];
const canManageRoles = [requireTenant, authorize('roles:manage')];
const canApproveClaims = [requireTenant, authorize('members:claim:approve', 'members:write')];

router.post('/invitations', canInvite, async (req, res) => {
  const { email, role_id } = req.body || {};
  if (!email || !role_id) return res.status(400).json({ error: 'email and role_id are required.' });
  try {
    const r = await invitations.createInvitation({ tenantId: req.tenant_id, email, roleId: role_id, invitedBy: req.user.id });
    if (!r.ok) return res.status(400).json({ error: r.error, code: r.code });
    res.status(201).json({ message: `Invitation sent to ${email}.`, id: r.id, role_name: r.role_name });
  } catch (err) {
    console.error('Create invite error:', err);
    res.status(500).json({ error: 'Failed to create invitation.' });
  }
});

router.get('/invitations', canInvite, async (req, res) => {
  try { res.json({ invitations: await invitations.listForOrg(req.tenant_id) }); }
  catch (err) { res.status(500).json({ error: 'Failed to load invitations.' }); }
});

router.delete('/invitations/:id', canInvite, async (req, res) => {
  try {
    const r = await invitations.revoke({ invitationId: req.params.id, tenantId: req.tenant_id, actorUserId: req.user.id });
    if (!r.ok) return res.status(404).json({ error: r.error, code: r.code });
    res.json({ message: 'Invitation revoked.' });
  } catch (err) { res.status(500).json({ error: 'Failed to revoke invitation.' }); }
});

router.get('/members', canManageMembers, async (req, res) => {
  try {
    const members = await membership.listOrgMembers(req.tenant_id);
    res.json({ members: members.map(m => ({
      user_id: m.user_id, role_id: m.role_id, role_name: m.role_name, status: m.status,
      joined_at: m.joined_at, full_name: m.full_name, email: m.email, phone: m.phone,
      is_you: m.user_id === req.user.id, linked_member: !!m.member_id
    })) });
  } catch (err) { res.status(500).json({ error: 'Failed to load organization members.' }); }
});

router.patch('/members/:userId/role', canManageMembers, async (req, res) => {
  const { role_id } = req.body || {};
  if (!role_id) return res.status(400).json({ error: 'role_id is required.' });
  try {
    const r = await membership.changeRole({ tenantId: req.tenant_id, userId: req.params.userId, newRoleId: role_id, actorUserId: req.user.id });
    if (!r.ok) return res.status(r.code === 'LAST_OWNER' ? 409 : 400).json({ error: r.error, code: r.code });
    await audit.orgAudit({ tenantId: req.tenant_id, actorUserId: req.user.id, action: 'member_role_changed', targetType: 'user', targetId: req.params.userId, meta: { role_id }, req });
    res.json({ message: 'Role updated.' });
  } catch (err) { res.status(500).json({ error: 'Failed to change role.' }); }
});

router.post('/members/:userId/suspend', canManageMembers, async (req, res) => {
  try {
    const r = await membership.setStatus({ tenantId: req.tenant_id, userId: req.params.userId, status: 'suspended', actorUserId: req.user.id });
    if (!r.ok) return res.status(r.code === 'LAST_OWNER' ? 409 : 400).json({ error: r.error, code: r.code });
    res.json({ message: 'Member suspended.' });
  } catch (err) { res.status(500).json({ error: 'Failed to suspend member.' }); }
});

router.post('/members/:userId/reactivate', canManageMembers, async (req, res) => {
  try {
    const r = await membership.setStatus({ tenantId: req.tenant_id, userId: req.params.userId, status: 'active', actorUserId: req.user.id });
    if (!r.ok) return res.status(400).json({ error: r.error, code: r.code });
    res.json({ message: 'Member reactivated.' });
  } catch (err) { res.status(500).json({ error: 'Failed to reactivate member.' }); }
});

router.delete('/members/:userId', canManageMembers, async (req, res) => {
  try {
    const r = await membership.removeMembership({ tenantId: req.tenant_id, userId: req.params.userId, actorUserId: req.user.id });
    if (!r.ok) return res.status(r.code === 'LAST_OWNER' ? 409 : 400).json({ error: r.error, code: r.code });
    await audit.orgAudit({ tenantId: req.tenant_id, actorUserId: req.user.id, action: 'member_removed', targetType: 'user', targetId: req.params.userId, req });
    res.json({ message: 'Member removed from organization.' });
  } catch (err) { res.status(500).json({ error: 'Failed to remove member.' }); }
});

router.post('/ownership/transfer', [requireTenant, authorize('org:manage')], async (req, res) => {
  const { to_user_id, demote_role_id } = req.body || {};
  if (!to_user_id) return res.status(400).json({ error: 'to_user_id is required.' });
  try {
    const r = await membership.transferOwnership({ tenantId: req.tenant_id, fromUserId: req.user.id, toUserId: to_user_id, demoteToRoleId: demote_role_id || 'r2', actorUserId: req.user.id });
    if (!r.ok) return res.status(400).json({ error: r.error, code: r.code });
    await audit.orgAudit({ tenantId: req.tenant_id, actorUserId: req.user.id, action: 'ownership_transferred', targetType: 'user', targetId: to_user_id, req });
    res.json({ message: 'Ownership transferred. You are now a manager of this organization.' });
  } catch (err) { console.error('Ownership transfer error:', err); res.status(500).json({ error: 'Failed to transfer ownership.' }); }
});

// Roles & permissions (custom-role foundation).
router.get('/roles', [requireTenant, authorize('roles:manage', 'staff:write')], async (req, res) => {
  try {
    const rows = await allQuery(
      `SELECT id, name, description, is_system, tenant_id FROM roles WHERE tenant_id IS NULL OR tenant_id = ? ORDER BY is_system DESC, name`,
      [req.tenant_id]);
    const map = await perms.resolvePermissionsForRoles(rows.map(r => r.id));
    res.json({ roles: rows.map(r => ({ id: r.id, name: r.name, description: r.description, is_system: !!r.is_system, custom: r.tenant_id === req.tenant_id, permissions: map[r.id] || [] })) });
  } catch (err) { res.status(500).json({ error: 'Failed to load roles.' }); }
});

router.get('/permissions', [requireTenant, authorize('roles:manage', 'staff:write')], async (req, res) => {
  try { res.json({ permissions: await perms.catalog() }); }
  catch (err) { res.status(500).json({ error: 'Failed to load permissions.' }); }
});

router.post('/roles', canManageRoles, async (req, res) => {
  const { name, description, permissions: keys } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Role name is required.' });
  try {
    const id = 'role_' + core.randomToken(8);
    await runQuery(`INSERT INTO roles (id, name, permissions, tenant_id, is_system, description) VALUES (?, ?, '[]', ?, 0, ?)`,
      [id, name, req.tenant_id, description || null]);
    const applied = await perms.setRolePermissions(id, Array.isArray(keys) ? keys : []);
    await audit.orgAudit({ tenantId: req.tenant_id, actorUserId: req.user.id, action: 'role_created', targetType: 'role', targetId: id, meta: { name }, req });
    res.status(201).json({ message: 'Custom role created.', id, permissions: applied });
  } catch (err) { console.error('Create role error:', err); res.status(500).json({ error: 'Failed to create role.' }); }
});

router.put('/roles/:id/permissions', canManageRoles, async (req, res) => {
  const { permissions: keys } = req.body || {};
  try {
    const role = await getQuery(`SELECT id, is_system, tenant_id FROM roles WHERE id = ?`, [req.params.id]);
    if (!role) return res.status(404).json({ error: 'Role not found.' });
    if (role.is_system || role.tenant_id !== req.tenant_id) return res.status(403).json({ error: 'System roles cannot be edited.', code: 'ROLE_PROTECTED' });
    const applied = await perms.setRolePermissions(role.id, Array.isArray(keys) ? keys : []);
    await audit.orgAudit({ tenantId: req.tenant_id, actorUserId: req.user.id, action: 'role_permissions_updated', targetType: 'role', targetId: role.id, req });
    res.json({ message: 'Permissions updated.', permissions: applied });
  } catch (err) { res.status(500).json({ error: 'Failed to update permissions.' }); }
});

// Member-claim admin queue (manual approval for medium-confidence claims).
router.get('/claims', canApproveClaims, async (req, res) => {
  try { res.json({ claims: await claims.pendingForOrg(req.tenant_id) }); }
  catch (err) { res.status(500).json({ error: 'Failed to load claims.' }); }
});

router.post('/claims/:id/approve', canApproveClaims, async (req, res) => {
  try {
    const r = await claims.approve({ claimId: req.params.id, tenantId: req.tenant_id, actorUserId: req.user.id });
    if (!r.ok) return res.status(r.code === 'CLAIM_TAKEN' ? 409 : 400).json({ error: r.error, code: r.code });
    res.json({ message: 'Claim approved — the account is now linked to the member.' });
  } catch (err) { res.status(500).json({ error: 'Failed to approve claim.' }); }
});

router.post('/claims/:id/reject', canApproveClaims, async (req, res) => {
  try {
    const r = await claims.adminReject({ claimId: req.params.id, tenantId: req.tenant_id, actorUserId: req.user.id });
    if (!r.ok) return res.status(400).json({ error: r.error, code: r.code });
    res.json({ message: 'Claim rejected.' });
  } catch (err) { res.status(500).json({ error: 'Failed to reject claim.' }); }
});

module.exports = router;
