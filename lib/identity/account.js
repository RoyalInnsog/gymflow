/*
 * [IDENTITY] Account lifecycle: email verification (signup + change-email),
 * password policy/reset/change/history, phone OTP, and provider linking.
 * Every one-time credential is stored hashed, expires, and is single-use.
 */
const bcrypt = require('bcryptjs');
const { getQuery, runQuery, allQuery } = require('../../database');
const core = require('./core');
const sessions = require('./sessions');
const events = require('./events');

const BCRYPT_ROUNDS = 10;
const EMAIL_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // verification links: 24 h
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000;      // password reset: 1 h
const OTP_TTL_MS = 10 * 60 * 1000;              // phone OTP: 10 min
const OTP_MAX_ATTEMPTS = 5;
const OTP_RESEND_COOLDOWN_MS = 60 * 1000;
const OTP_DAILY_LIMIT = 5;
const PASSWORD_HISTORY_DEPTH = 3;

// ---------------------------------------------------------------------------
// Password policy — length + a denylist of the most-stuffed passwords + must
// not contain the account's own email local part. (NIST-style: no arbitrary
// composition rules; the strength meter guides users client-side.)
// ---------------------------------------------------------------------------
const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password123', '12345678', '123456789', '1234567890',
  'qwerty123', 'qwertyuiop', '11111111', '00000000', 'abcd1234', 'iloveyou',
  'admin123', 'welcome1', 'letmein1', 'sunshine', 'football', 'baseball',
  'monkey123', 'dragon123', 'superman', 'michael1', 'shadow123', 'master123',
  'passw0rd', 'p@ssw0rd', 'gymflow123', 'fitness123', 'india@123', 'admin@123'
]);
function checkPasswordPolicy(password, email) {
  const pw = String(password || '');
  if (pw.length < 8) return { ok: false, error: 'Password must be at least 8 characters.', code: 'WEAK_PASSWORD' };
  if (pw.length > 128) return { ok: false, error: 'Password is too long (max 128 characters).', code: 'WEAK_PASSWORD' };
  if (COMMON_PASSWORDS.has(pw.toLowerCase())) return { ok: false, error: 'That password is too common. Please choose something harder to guess.', code: 'WEAK_PASSWORD' };
  const local = core.normalizeEmail(email).split('@')[0];
  if (local && local.length >= 4 && pw.toLowerCase().includes(local)) {
    return { ok: false, error: 'Password must not contain your email address.', code: 'WEAK_PASSWORD' };
  }
  return { ok: true };
}

async function hashPassword(password) {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

// Reuse check: current hash + last N history entries.
async function isPasswordReused(userId, newPassword, currentHash) {
  if (currentHash && await bcrypt.compare(newPassword, currentHash)) return true;
  const rows = await allQuery(
    `SELECT password_hash FROM password_history WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`,
    [userId, PASSWORD_HISTORY_DEPTH]);
  for (const r of rows) {
    if (await bcrypt.compare(newPassword, r.password_hash)) return true;
  }
  return false;
}

// Apply a password change: update hash, archive the old one, revoke sessions.
async function applyNewPassword(userId, newPassword, { oldHash = null, exceptSid = null, reason = 'password_changed' } = {}) {
  const hash = await hashPassword(newPassword);
  if (oldHash) {
    await runQuery(`INSERT INTO password_history (id, user_id, password_hash) VALUES (?, ?, ?)`,
      [core.newId('ph'), userId, oldHash]);
  }
  await runQuery(
    `UPDATE users SET password_hash = ?, password_set = 1, password_changed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [hash, userId]);
  return sessions.revokeAllSessions(userId, { exceptSid, reason });
}

// ---------------------------------------------------------------------------
// Email verification (purpose: 'signup' | 'change'). A new token supersedes the
// user's previous unused tokens of the same purpose.
// ---------------------------------------------------------------------------
async function createEmailVerification(userId, email, purpose = 'signup') {
  const token = core.randomToken(32);
  await runQuery(`DELETE FROM email_verifications WHERE user_id = ? AND purpose = ? AND used_at IS NULL`, [userId, purpose]);
  await runQuery(
    `INSERT INTO email_verifications (id, user_id, email, purpose, token_hash, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [core.newId('ev'), userId, core.normalizeEmail(email), purpose, core.sha256(token),
     core.sqlTime(EMAIL_TOKEN_TTL_MS)]);
  return token;
}

// Consume a verification token. Handles: invalid, expired, already-used,
// signup-verify, and change-email (with a last-second uniqueness re-check and
// full session revocation on address change). Legacy fallback covers links sent
// before this table existed (users.verification_token).
async function consumeEmailVerification(rawToken, req) {
  const hash = core.sha256(rawToken);
  const row = await getQuery(`SELECT * FROM email_verifications WHERE token_hash = ?`, [hash]);
  if (!row) {
    const legacy = await getQuery(`SELECT id FROM users WHERE verification_token = ?`, [hash]);
    if (legacy) {
      await runQuery(`UPDATE users SET email_verified = 1, verification_token = NULL WHERE id = ?`, [legacy.id]);
      await events.record({ userId: legacy.id, event: 'email_verified', req });
      return { ok: true, purpose: 'signup' };
    }
    return { ok: false, code: 'TOKEN_INVALID', error: 'Invalid or expired token' };
  }
  if (row.used_at) {
    const user = await getQuery(`SELECT email_verified FROM users WHERE id = ?`, [row.user_id]);
    if (row.purpose === 'signup' && user && user.email_verified) {
      return { ok: true, alreadyVerified: true, purpose: 'signup' };
    }
    return { ok: false, code: 'TOKEN_USED', error: 'This link has already been used.' };
  }
  if (core.parseSqlTime(row.expires_at) < Date.now()) {
    return { ok: false, code: 'TOKEN_EXPIRED', error: 'This link has expired. Please request a new one.', purpose: row.purpose };
  }
  await runQuery(`UPDATE email_verifications SET used_at = CURRENT_TIMESTAMP WHERE id = ?`, [row.id]);

  if (row.purpose === 'change') {
    const clash = await getQuery(`SELECT id FROM users WHERE email = ? AND id <> ?`, [row.email, row.user_id]);
    if (clash) return { ok: false, code: 'EMAIL_IN_USE', error: 'That email address is already in use.' };
    const old = await getQuery(`SELECT email FROM users WHERE id = ?`, [row.user_id]);
    await runQuery(`UPDATE users SET email = ?, email_verified = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [row.email, row.user_id]);
    await sessions.revokeAllSessions(row.user_id, { reason: 'email_changed' });
    await events.record({ userId: row.user_id, event: 'email_changed', req, meta: { from: old && old.email, to: row.email } });
    return { ok: true, purpose: 'change', oldEmail: old && old.email, newEmail: row.email };
  }

  await runQuery(`UPDATE users SET email_verified = 1, verification_token = NULL WHERE id = ?`, [row.user_id]);
  await events.record({ userId: row.user_id, event: 'email_verified', req });
  return { ok: true, purpose: 'signup' };
}

// ---------------------------------------------------------------------------
// Password reset — dedicated single-use rows; a new request supersedes old ones.
// ---------------------------------------------------------------------------
async function createPasswordReset(userId) {
  const token = core.randomToken(32);
  await runQuery(`DELETE FROM password_reset_tokens WHERE user_id = ? AND used_at IS NULL`, [userId]);
  await runQuery(
    `INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)`,
    [core.newId('prt'), userId, core.sha256(token), core.sqlTime(RESET_TOKEN_TTL_MS)]);
  return token;
}

// Two-step consumption: find first (so a policy rejection on the new password
// does not burn the single-use link), mark used only when the reset commits.
async function findPasswordReset(rawToken) {
  const hash = core.sha256(rawToken);
  const row = await getQuery(
    `SELECT * FROM password_reset_tokens WHERE token_hash = ? AND used_at IS NULL AND expires_at > datetime('now')`,
    [hash]);
  if (row) return { id: row.id, userId: row.user_id, legacy: false };
  // Legacy fallback: reset links issued before this table existed.
  const legacy = await getQuery(`SELECT id FROM users WHERE reset_token = ? AND token_expiry > CURRENT_TIMESTAMP`, [hash]);
  if (legacy) return { id: null, userId: legacy.id, legacy: true };
  return null;
}
async function markPasswordResetUsed(handle) {
  if (handle.legacy) {
    await runQuery(`UPDATE users SET reset_token = NULL, token_expiry = NULL WHERE id = ?`, [handle.userId]);
  } else {
    await runQuery(`UPDATE password_reset_tokens SET used_at = CURRENT_TIMESTAMP WHERE id = ?`, [handle.id]);
  }
}

// ---------------------------------------------------------------------------
// Phone OTP — phone is a verification factor, never a login credential.
// Delivery is pluggable; without a configured SMS provider the code goes to the
// server log (and back to the UI as devCode outside production).
// ---------------------------------------------------------------------------
async function requestPhoneOtp(userId, phone) {
  const recent = await getQuery(
    `SELECT COUNT(*) AS c FROM phone_verifications WHERE user_id = ? AND created_at > datetime('now', '-60 seconds')`, [userId]);
  if (recent.c > 0) {
    return { ok: false, code: 'OTP_COOLDOWN', error: 'Please wait a minute before requesting another code.' };
  }
  const daily = await getQuery(
    `SELECT COUNT(*) AS c FROM phone_verifications WHERE user_id = ? AND created_at > datetime('now', '-1 day')`, [userId]);
  if (daily.c >= OTP_DAILY_LIMIT) {
    return { ok: false, code: 'OTP_DAILY_LIMIT', error: 'Daily verification limit reached. Please try again tomorrow.' };
  }
  // 6-digit code from a crypto source (rejection-free modulo is overkill for a
  // 5-attempt-capped, 10-minute code).
  const otp = String(100000 + (parseInt(core.randomToken(4), 16) % 900000));
  await runQuery(`DELETE FROM phone_verifications WHERE user_id = ? AND verified_at IS NULL`, [userId]);
  await runQuery(
    `INSERT INTO phone_verifications (id, user_id, phone, otp_hash, expires_at) VALUES (?, ?, ?, ?, ?)`,
    [core.newId('pv'), userId, phone, core.sha256(otp), core.sqlTime(OTP_TTL_MS)]);
  await deliverOtp(phone, otp);
  return { ok: true, otp };
}

// Transport abstraction: today console/dev; an SMS/WhatsApp provider plugs in
// here (env OTP_PROVIDER) without touching any caller.
async function deliverOtp(phone, code) {
  const provider = process.env.OTP_PROVIDER || 'console';
  if (provider === 'console') {
    console.log(`[identity] OTP for ${phone}: ${code} (no SMS provider configured — OTP_PROVIDER=console)`);
    return { delivered: false };
  }
  console.warn(`[identity] Unknown OTP_PROVIDER "${provider}" — falling back to console log. OTP for ${phone}: ${code}`);
  return { delivered: false };
}

async function verifyPhoneOtp(userId, phone, codeInput) {
  const row = await getQuery(
    `SELECT * FROM phone_verifications WHERE user_id = ? AND phone = ? AND verified_at IS NULL ORDER BY created_at DESC LIMIT 1`,
    [userId, phone]);
  if (!row) return { ok: false, code: 'OTP_INVALID', error: 'Incorrect code. Please try again.' };
  if (core.parseSqlTime(row.expires_at) < Date.now()) return { ok: false, code: 'OTP_EXPIRED', error: 'That code has expired. Please request a new one.' };
  if (row.attempts >= OTP_MAX_ATTEMPTS) return { ok: false, code: 'OTP_ATTEMPTS', error: 'Too many incorrect attempts. Please request a new code.' };
  if (core.sha256(String(codeInput || '').trim()) !== row.otp_hash) {
    await runQuery(`UPDATE phone_verifications SET attempts = attempts + 1 WHERE id = ?`, [row.id]);
    const left = OTP_MAX_ATTEMPTS - row.attempts - 1;
    return { ok: false, code: left <= 0 ? 'OTP_ATTEMPTS' : 'OTP_INVALID', error: left <= 0 ? 'Too many incorrect attempts. Please request a new code.' : 'Incorrect code. Please try again.' };
  }
  await runQuery(`UPDATE phone_verifications SET verified_at = CURRENT_TIMESTAMP WHERE id = ?`, [row.id]);
  await runQuery(`UPDATE users SET phone = ?, phone_verified = 1, phone_verified_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [phone, userId]);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Provider linking (external IdPs; a password is users.password_set, not a row).
// ---------------------------------------------------------------------------
async function getProviders(userId) {
  return allQuery(`SELECT provider, provider_uid, email, created_at, last_used_at FROM identity_providers WHERE user_id = ?`, [userId]);
}
async function findByProvider(provider, providerUid) {
  return getQuery(`SELECT * FROM identity_providers WHERE provider = ? AND provider_uid = ?`, [provider, providerUid]);
}
async function linkProvider(userId, provider, providerUid, email) {
  await runQuery(
    `INSERT OR IGNORE INTO identity_providers (id, user_id, provider, provider_uid, email, last_used_at)
     VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
    [core.newId('idp'), userId, provider, providerUid, core.normalizeEmail(email)]);
}
async function touchProvider(provider, providerUid) {
  await runQuery(`UPDATE identity_providers SET last_used_at = CURRENT_TIMESTAMP WHERE provider = ? AND provider_uid = ?`, [provider, providerUid]);
}
// Unlink refuses to strand the account without any login method.
async function unlinkProvider(userId, provider) {
  const user = await getQuery(`SELECT password_set FROM users WHERE id = ?`, [userId]);
  if (!user || !user.password_set) return { ok: false, code: 'LAST_LOGIN_METHOD', error: 'Set a password first so you can still sign in after disconnecting.' };
  const r = await runQuery(`DELETE FROM identity_providers WHERE user_id = ? AND provider = ?`, [userId, provider]);
  return r.changes > 0 ? { ok: true } : { ok: false, code: 'NOT_LINKED', error: 'That provider is not connected.' };
}

module.exports = {
  BCRYPT_ROUNDS, checkPasswordPolicy, hashPassword, isPasswordReused, applyNewPassword,
  createEmailVerification, consumeEmailVerification,
  createPasswordReset, findPasswordReset, markPasswordResetUsed,
  requestPhoneOtp, verifyPhoneOtp,
  getProviders, findByProvider, linkProvider, touchProvider, unlinkProvider
};
