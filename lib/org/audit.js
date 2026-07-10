/*
 * [ORG] Audit writers for the organization graph. Best-effort — an audit failure
 * must never break the operation it records. Three streams:
 *   - org_audit_logs: who did what to which target inside an org (admin actions).
 *   - membership_history: the join/suspend/leave/transfer story of a membership.
 *   - claim_history: a member-claim's state transitions.
 */
const { runQuery } = require('../../database');
const crypto = require('crypto');

const id = (p) => p + '_' + crypto.randomBytes(9).toString('base64url');

async function orgAudit({ tenantId, actorUserId = null, action, targetType = null, targetId = null, meta = null, req = null }) {
  try {
    await runQuery(
      `INSERT INTO org_audit_logs (id, tenant_id, actor_user_id, action, target_type, target_id, meta, ip)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id('oa'), tenantId, actorUserId, action, targetType, targetId,
       meta ? JSON.stringify(meta) : null, req ? (req.ip || null) : null]);
  } catch (e) { console.error('[org] org_audit write failed:', e.message); }
}

async function membershipHistory({ tenantId, userId, action, fromRole = null, toRole = null, actorUserId = null, meta = null }) {
  try {
    await runQuery(
      `INSERT INTO membership_history (id, tenant_id, user_id, action, from_role, to_role, actor_user_id, meta)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id('mh'), tenantId, userId, action, fromRole, toRole, actorUserId, meta ? JSON.stringify(meta) : null]);
  } catch (e) { console.error('[org] membership_history write failed:', e.message); }
}

async function claimHistory({ claimId, action, actorUserId = null, meta = null }) {
  try {
    await runQuery(
      `INSERT INTO claim_history (id, claim_id, action, actor_user_id, meta) VALUES (?, ?, ?, ?, ?)`,
      [id('ch'), claimId, action, actorUserId, meta ? JSON.stringify(meta) : null]);
  } catch (e) { console.error('[org] claim_history write failed:', e.message); }
}

module.exports = { orgAudit, membershipHistory, claimHistory, newId: id };
