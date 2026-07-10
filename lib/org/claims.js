/*
 * [ORG] Member claim system — links a logging-in account to an existing member
 * profile it matches by email/phone, so a gym's own members aren't re-created as
 * empty new accounts. Confidence gates the outcome: a high-confidence (email+phone)
 * user-confirmed claim auto-links; a medium-confidence (single field) claim waits
 * for manual admin approval. Never silently merges; never duplicates.
 */
const { getQuery, runQuery, allQuery } = require('../../database');
const core = require('../identity/core');
const membership = require('./membership');
const audit = require('./audit');

const MEMBER_ROLE_ID = 'r5';

function scoreMatch(member, acct) {
  const emailMatch = !!(member.email && acct.email && member.email.toLowerCase() === acct.email.toLowerCase());
  const acctPhone = core.normalizePhone(acct.phone);
  const memPhone = core.normalizePhone(member.phone);
  const phoneMatch = !!(acctPhone && memPhone && acctPhone === memPhone);
  if (!emailMatch && !phoneMatch) return null;
  const basis = emailMatch && phoneMatch ? 'both' : (emailMatch ? 'email' : 'phone');
  return { basis, confidence: basis === 'both' ? 'high' : 'medium', emailMatch, phoneMatch };
}

// Candidate member profiles this account could claim: matched by email/phone, in
// orgs the account is not already a member of, with no existing claim on record.
async function findCandidateMatches(userId) {
  const acct = await getQuery(`SELECT id, email, phone FROM users WHERE id = ?`, [userId]);
  if (!acct) return [];
  const acctPhone = core.normalizePhone(acct.phone);
  const candidates = await allQuery(
    `SELECT m.id AS member_id, m.tenant_id, m.full_name, m.email, m.phone, t.gym_name
       FROM members m JOIN tenants t ON t.id = m.tenant_id
      WHERE ( (m.email IS NOT NULL AND lower(m.email) = lower(?)) OR (m.phone IS NOT NULL AND m.phone = ?) )
        AND m.tenant_id NOT IN (SELECT tenant_id FROM user_roles WHERE user_id = ? AND status = 'active')
        AND NOT EXISTS (SELECT 1 FROM member_claims mc WHERE mc.member_id = m.id AND mc.user_id = ?)
      LIMIT 20`,
    [acct.email, acct.phone || '__none__', userId, userId]);
  const out = [];
  for (const m of candidates) {
    const score = scoreMatch(m, acct) || (acctPhone ? scoreMatch(m, { ...acct, phone: acctPhone }) : null);
    if (!score) continue;
    out.push({
      tenant_id: m.tenant_id, gym_name: m.gym_name, member_id: m.member_id,
      member_name: m.full_name, match_basis: score.basis, confidence: score.confidence
    });
  }
  return out;
}

// Internal: create the account↔member link (r5 membership carrying member_id).
async function linkMember({ userId, tenantId, memberId, actorUserId }) {
  await membership.grantMembership({ userId, tenantId, roleId: MEMBER_ROLE_ID, memberId, actorUserId });
}

// The user clicked "Yes, I belong to this gym". Re-verify the match server-side
// (never trust the client), then auto-link (high) or open a pending claim (medium).
async function submitClaim({ user, tenantId, memberId }) {
  const member = await getQuery(`SELECT * FROM members WHERE id = ? AND tenant_id = ?`, [memberId, tenantId]);
  if (!member) return { ok: false, code: 'NOT_FOUND', error: 'That member profile was not found.' };
  const acct = await getQuery(`SELECT id, email, phone FROM users WHERE id = ?`, [user.id]);
  const score = scoreMatch(member, acct);
  if (!score) return { ok: false, code: 'NO_MATCH', error: 'This profile does not match your account details.' };

  const already = await getQuery(`SELECT id, status FROM member_claims WHERE tenant_id = ? AND member_id = ? AND user_id = ?`, [tenantId, memberId, user.id]);
  if (already && already.status === 'accepted') return { ok: false, code: 'CLAIM_TAKEN', error: 'You have already claimed this profile.' };
  const linkedElsewhere = await getQuery(`SELECT id FROM user_roles WHERE tenant_id = ? AND member_id = ? AND status = 'active'`, [tenantId, memberId]);
  if (linkedElsewhere) return { ok: false, code: 'CLAIM_TAKEN', error: 'This member profile is already linked to an account.' };

  const autoAccept = score.confidence === 'high';
  const claimId = already ? already.id : 'clm_' + core.randomToken(8);
  const status = autoAccept ? 'accepted' : 'pending';
  if (already) {
    await runQuery(`UPDATE member_claims SET status = ?, match_basis = ?, confidence = ?, decided_at = ${autoAccept ? 'CURRENT_TIMESTAMP' : 'NULL'} WHERE id = ?`,
      [status, score.basis, score.confidence, claimId]);
  } else {
    await runQuery(
      `INSERT INTO member_claims (id, tenant_id, member_id, user_id, status, match_basis, confidence, decided_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ${autoAccept ? 'CURRENT_TIMESTAMP' : 'NULL'})`,
      [claimId, tenantId, memberId, user.id, status, score.basis, score.confidence]);
  }
  await audit.claimHistory({ claimId, action: autoAccept ? 'auto_accepted' : 'submitted', actorUserId: user.id, meta: { basis: score.basis } });

  if (autoAccept) {
    await linkMember({ userId: user.id, tenantId, memberId, actorUserId: user.id });
    await audit.orgAudit({ tenantId, actorUserId: user.id, action: 'member_claim_linked', targetType: 'member', targetId: memberId });
    return { ok: true, status: 'accepted', linked: true };
  }
  return { ok: true, status: 'pending', linked: false, message: 'Your request was sent to the gym for confirmation.' };
}

// "Not now" — record a rejected claim so this profile isn't offered again.
async function dismissClaim({ user, tenantId, memberId }) {
  const existing = await getQuery(`SELECT id FROM member_claims WHERE tenant_id = ? AND member_id = ? AND user_id = ?`, [tenantId, memberId, user.id]);
  const claimId = existing ? existing.id : 'clm_' + core.randomToken(8);
  if (existing) {
    await runQuery(`UPDATE member_claims SET status = 'rejected', decided_at = CURRENT_TIMESTAMP WHERE id = ?`, [claimId]);
  } else {
    await runQuery(`INSERT INTO member_claims (id, tenant_id, member_id, user_id, status, decided_at) VALUES (?, ?, ?, ?, 'rejected', CURRENT_TIMESTAMP)`,
      [claimId, tenantId, memberId, user.id]);
  }
  await audit.claimHistory({ claimId, action: 'dismissed', actorUserId: user.id });
  return { ok: true };
}

// Admin approval queue for medium-confidence claims.
async function pendingForOrg(tenantId) {
  return allQuery(
    `SELECT mc.id, mc.member_id, mc.user_id, mc.match_basis, mc.confidence, mc.created_at,
            m.full_name AS member_name, u.email AS account_email, u.full_name AS account_name
       FROM member_claims mc
       JOIN members m ON m.id = mc.member_id
       JOIN users u ON u.id = mc.user_id
      WHERE mc.tenant_id = ? AND mc.status = 'pending'
      ORDER BY mc.created_at ASC`, [tenantId]);
}

async function approve({ claimId, tenantId, actorUserId }) {
  const claim = await getQuery(`SELECT * FROM member_claims WHERE id = ? AND tenant_id = ?`, [claimId, tenantId]);
  if (!claim) return { ok: false, code: 'NOT_FOUND', error: 'Claim not found.' };
  if (claim.status !== 'pending') return { ok: false, code: 'CLAIM_INACTIVE', error: 'This claim is no longer pending.' };
  const linkedElsewhere = await getQuery(`SELECT id FROM user_roles WHERE tenant_id = ? AND member_id = ? AND status = 'active'`, [tenantId, claim.member_id]);
  if (linkedElsewhere) return { ok: false, code: 'CLAIM_TAKEN', error: 'This member profile is already linked to an account.' };
  await runQuery(`UPDATE member_claims SET status = 'accepted', decided_by = ?, decided_at = CURRENT_TIMESTAMP WHERE id = ?`, [actorUserId, claimId]);
  await linkMember({ userId: claim.user_id, tenantId, memberId: claim.member_id, actorUserId });
  await audit.claimHistory({ claimId, action: 'approved', actorUserId });
  await audit.orgAudit({ tenantId, actorUserId, action: 'member_claim_approved', targetType: 'member', targetId: claim.member_id });
  return { ok: true };
}

async function adminReject({ claimId, tenantId, actorUserId }) {
  const claim = await getQuery(`SELECT * FROM member_claims WHERE id = ? AND tenant_id = ?`, [claimId, tenantId]);
  if (!claim) return { ok: false, code: 'NOT_FOUND', error: 'Claim not found.' };
  if (claim.status !== 'pending') return { ok: false, code: 'CLAIM_INACTIVE', error: 'This claim is no longer pending.' };
  await runQuery(`UPDATE member_claims SET status = 'rejected', decided_by = ?, decided_at = CURRENT_TIMESTAMP WHERE id = ?`, [actorUserId, claimId]);
  await audit.claimHistory({ claimId, action: 'admin_rejected', actorUserId });
  return { ok: true };
}

module.exports = { findCandidateMatches, submitClaim, dismissClaim, pendingForOrg, approve, adminReject };
