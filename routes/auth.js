/*
 * [IDENTITY] All /api/v1/auth endpoints. Mounted WITHOUT the tenant/staff gates
 * (identity is account-level, not tenant-level); the tenant-scoped API keeps its
 * own fail-closed middleware stack in server.js.
 *
 * Design contract: IDENTITY_PLATFORM.md. Error responses are { error, code? }
 * with stable codes; enumeration-sensitive endpoints return one generic shape.
 */
const express = require('express');
const bcrypt = require('bcryptjs');
const { getQuery, runQuery, seedTenantDefaults } = require('../database');
const emailService = require('../lib/emailService');
const core = require('../lib/identity/core');
const sessions = require('../lib/identity/sessions');
const account = require('../lib/identity/account');
const events = require('../lib/identity/events');
const { refreshWithCookie } = require('../lib/identity/refresh');

const router = express.Router();
const PORT = process.env.PORT || 3000;
const { authLimiter, sensitiveLimiter, authenticateToken } = core;

// ---------------------------------------------------------------------------
// Shared: finalize a login — session row, cookies, device recognition, events.
// Used identically by the password and Google paths so they can never diverge.
// ---------------------------------------------------------------------------
async function issueLogin(req, res, user, roles, remember, meta) {
  await runQuery(`UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?`, [user.id]);

  const device = await sessions.recognizeDevice(req, res, user);
  if (device.isNew) {
    await events.record({ userId: user.id, email: user.email, event: 'new_device', req, meta });
    if (core.EMAIL_ENABLED) {
      const ua = core.parseUserAgent(req.headers['user-agent']);
      emailService.sendSecurityAlert(user.email, 'New sign-in to your GYM Flow account',
        [`A sign-in from a new device was just detected.`,
         `Device: ${ua.label} · IP: ${req.ip || 'unknown'}`],
        user.tenant_id).catch(() => {});
    }
  }
  await events.record({ userId: user.id, email: user.email, event: 'login', req, meta });

  if (roles.length === 1) {
    const { sid, refreshToken } = await sessions.createSession({ user, remember, req, role: roles[0] });
    const token = core.signScopedToken(user, roles[0], remember, sid);
    await sessions.touchAccess(sid, core.verifyToken(token).jti);
    core.setAuthCookie(req, res, token, remember, false);
    core.setRefreshCookie(req, res, refreshToken, remember);
    return { redirect: core.shellForRole(roles[0].role_id), role: roles[0] };
  }

  // Multi-role: pending token → picker. The session row exists already so the
  // device/IP context is recorded; select-role scopes it.
  const { sid, refreshToken } = await sessions.createSession({ user, remember, req, role: null });
  core.setAuthCookie(req, res, core.signPendingToken(user, remember, sid), remember, true);
  core.setRefreshCookie(req, res, refreshToken, remember);
  return { redirect: '/select-role', role: null };
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------
router.post('/login', authLimiter, async (req, res) => {
  const email = core.normalizeEmail(req.body && req.body.email);
  const { password, remember } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }
  try {
    // [SEC] Per-email lockout across ALL IPs (the per-IP limiter can't see a
    // distributed credential-stuffing run). Same copy as the limiter → no
    // enumeration signal.
    if (await events.isLockedOut(email)) {
      return res.status(429).json({ error: 'Too many attempts. Please wait a few minutes and try again.', code: 'LOCKED' });
    }

    const user = await getQuery(`SELECT * FROM users WHERE email = ?`, [email]);

    // [SEC] Constant-ish-time auth: bcrypt.compare always runs — against a decoy
    // hash when the email is unknown OR the account has no password (Google-only).
    const match = await bcrypt.compare(password, (user && user.password_hash) ? user.password_hash : core.DUMMY_PW_HASH);
    if (!user || !match || !user.password_set) {
      await events.record({ userId: user ? user.id : null, email, event: 'login_failed', req });
      return res.status(401).json({ error: 'Invalid credentials.' });
    }

    if (!core.isAccountActive(user)) {
      return res.status(403).json({ error: 'This account has been suspended.' });
    }

    // Verification is only enforceable when email delivery is configured —
    // otherwise every signup would be a permanent dead end.
    if (core.EMAIL_ENABLED && !user.email_verified) {
      return res.status(403).json({ error: 'Please verify your email address before logging in.', verificationRequired: true });
    }

    const roles = await core.getUserRoles(user.id);
    if (roles.length === 0) {
      return res.status(403).json({ error: 'This account has no active access. Please contact your gym.' });
    }

    const out = await issueLogin(req, res, user, roles, !!remember, { provider: 'password' });
    return res.json({
      message: out.role ? 'Authorization successful.' : 'Select a role to continue.',
      redirect: out.redirect,
      user: out.role ? { email: user.email, role_id: out.role.role_id } : { email: user.email },
      roles: core.rolesForClient(roles)
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Internal system authorization failure.' });
  }
});

// ---------------------------------------------------------------------------
// Signup (password identity). Creates the global account + its first gym.
// ---------------------------------------------------------------------------
router.post('/signup', authLimiter, async (req, res) => {
  const { full_name, password, phone } = req.body || {};
  const email = core.normalizeEmail(req.body && req.body.email);
  if (!full_name || !email || !password) return res.status(400).json({ error: 'All fields are required.' });
  const policy = account.checkPasswordPolicy(password, email);
  if (!policy.ok) return res.status(400).json({ error: policy.error, code: policy.code });
  if (!core.isValidEmail(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });
  // Phone is required at registration — it is (with email) the linking key for
  // the member-claim flow. Captured now, verified later via OTP.
  const normPhone = core.normalizePhone(phone);
  if (!normPhone) return res.status(400).json({ error: 'A valid phone number (10-15 digits) is required.' });

  try {
    const existingUser = await getQuery('SELECT id FROM users WHERE email = ?', [email]);
    if (existingUser) return res.status(400).json({ error: 'Email already exists.', code: 'EMAIL_IN_USE' });

    const hash = await account.hashPassword(password);
    const userId = core.newId('u');
    const tenantId = core.newId('t');
    const gymName = full_name.split(' ')[0] + "'s Gym";
    const subdomain = full_name.toLowerCase().replace(/[^a-z0-9]/g, '') + Math.floor(Math.random() * 1000);
    const trialStart = new Date().toISOString();
    // 7-day PRO trial from signup; lapses to the free Basic plan (never a lockout).
    const trialEnd = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    await runQuery(`INSERT INTO tenants (id, gym_name, subdomain, owner_user_id, subscription_plan, trial_start, trial_end, subscription_status) VALUES (?, ?, ?, ?, 'trial', ?, ?, 'trial')`,
      [tenantId, gymName, subdomain, userId, trialStart, trialEnd]);

    // Without email delivery, verification is impossible → account starts usable.
    const initialVerified = core.EMAIL_ENABLED ? 0 : 1;
    await runQuery(`INSERT INTO users (id, role_id, tenant_id, email, password_hash, full_name, phone, email_verified, status, password_set) VALUES (?, 'r1', ?, ?, ?, ?, ?, ?, 'active', 1)`,
      [userId, tenantId, email, hash, full_name, normPhone, initialVerified]);

    await runQuery(`INSERT INTO user_roles (id, user_id, tenant_id, role_id) VALUES (?, ?, ?, 'r1') ON CONFLICT DO NOTHING`,
      ['ur_' + userId + '_' + tenantId + '_r1', userId, tenantId]);
    await seedTenantDefaults(tenantId, gymName);
    await events.record({ userId, email, event: 'signup', req, meta: { provider: 'password' } });

    if (!core.EMAIL_ENABLED) {
      return res.status(201).json({ message: 'Account created. You can sign in now.', verificationPending: false });
    }

    const vToken = await account.createEmailVerification(userId, email, 'signup');
    const emailResult = await emailService.sendVerificationEmail(email, vToken, tenantId, PORT);
    if (!emailResult.success) {
      return res.status(201).json({
        message: 'Account created, but we could not send the verification email. Use Resend Verification to try again.',
        verificationPending: true,
        emailFailed: true
      });
    }
    res.status(201).json({ message: 'Signup successful. Please verify email.', verificationPending: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create account.' });
  }
});

// ---------------------------------------------------------------------------
// Email verification (signup links AND change-email confirmation links)
// ---------------------------------------------------------------------------
router.get('/verify-email', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).json({ error: 'Missing token' });
  try {
    const result = await account.consumeEmailVerification(String(token), req);
    if (!result.ok) return res.status(400).json({ error: result.error, code: result.code });
    if (result.purpose === 'change') {
      // The address changed → every session was revoked; the user signs in fresh.
      if (core.EMAIL_ENABLED && result.oldEmail) {
        emailService.sendSecurityAlert(result.oldEmail, 'Your GYM Flow email address was changed',
          [`The sign-in email for your account is now ${result.newEmail}.`,
           `If you did not request this, contact support immediately.`], null).catch(() => {});
      }
      return res.json({ message: 'Email address updated. Please sign in with your new email.', purpose: 'change' });
    }
    res.json({ message: result.alreadyVerified ? 'This email is already verified.' : 'Email verified successfully.', alreadyVerified: !!result.alreadyVerified });
  } catch (err) {
    console.error('Verify-email error:', err);
    res.status(500).json({ error: 'Failed to verify email.' });
  }
});

// Always-200 (never reveals whether the account exists); NON-refunding limiter —
// a refunding one would be no limit at all on an always-success endpoint.
router.post('/resend-verification', sensitiveLimiter, async (req, res) => {
  const email = core.normalizeEmail(req.body && req.body.email);
  if (!email) return res.status(400).json({ error: 'Email required' });
  try {
    const user = await getQuery('SELECT id, tenant_id, email_verified FROM users WHERE email = ?', [email]);
    if (user && !user.email_verified && core.EMAIL_ENABLED) {
      const vToken = await account.createEmailVerification(user.id, email, 'signup');
      await emailService.sendVerificationEmail(email, vToken, user.tenant_id, PORT);
    }
    res.json({ message: 'If that account exists and is unverified, a new verification email has been sent.' });
  } catch (err) {
    console.error('Resend verification error:', err);
    res.status(500).json({ error: 'Failed to resend verification email.' });
  }
});

// ---------------------------------------------------------------------------
// Password reset (recovery)
// ---------------------------------------------------------------------------
router.post('/forgot-password', sensitiveLimiter, async (req, res) => {
  const email = core.normalizeEmail(req.body && req.body.email);
  if (!email) return res.status(400).json({ error: 'Email required' });
  try {
    const user = await getQuery('SELECT id, tenant_id FROM users WHERE email = ?', [email]);
    if (user) {
      const resetToken = await account.createPasswordReset(user.id);
      await events.record({ userId: user.id, email, event: 'reset_requested', req });
      const emailResult = await emailService.sendPasswordReset(email, resetToken, user.tenant_id, PORT);
      // [SEC] Never surface send success/failure — that is an enumeration oracle.
      if (!emailResult.success) {
        console.error('[forgot-password] reset email dispatch failed for an existing account.');
      }
    }
    res.json({ message: 'Reset link sent if email exists.' });
  } catch (err) {
    console.error('[forgot-password] error:', err && err.message);
    res.status(500).json({ error: 'Error processing request.' });
  }
});

router.post('/reset-password', authLimiter, async (req, res) => {
  const { token, password } = req.body || {};
  if (!token || !password) return res.status(400).json({ error: 'Token and password required' });
  try {
    const handle = await account.findPasswordReset(String(token));
    if (!handle) return res.status(400).json({ error: 'Invalid or expired token.', code: 'TOKEN_EXPIRED' });

    const user = await getQuery('SELECT * FROM users WHERE id = ?', [handle.userId]);
    if (!user) return res.status(400).json({ error: 'Invalid or expired token.', code: 'TOKEN_EXPIRED' });

    const policy = account.checkPasswordPolicy(password, user.email);
    if (!policy.ok) return res.status(400).json({ error: policy.error, code: policy.code });
    if (await account.isPasswordReused(user.id, password, user.password_set ? user.password_hash : null)) {
      return res.status(400).json({ error: 'That password was used recently. Please choose a different one.', code: 'PASSWORD_REUSE' });
    }

    await account.markPasswordResetUsed(handle);
    // [SEC] A password reset ends every existing session — a hijacked session
    // must not survive the victim recovering their account.
    await account.applyNewPassword(user.id, password, {
      oldHash: user.password_set ? user.password_hash : null,
      exceptSid: null,
      reason: 'password_reset'
    });
    await events.record({ userId: user.id, email: user.email, event: 'password_reset', req });
    if (core.EMAIL_ENABLED) {
      emailService.sendSecurityAlert(user.email, 'Your GYM Flow password was reset',
        ['Your password was just reset and all devices were signed out.'], user.tenant_id).catch(() => {});
    }
    res.json({ message: 'Password updated successfully.' });
  } catch (err) {
    console.error('Reset-password error:', err);
    res.status(500).json({ error: 'Error resetting password.' });
  }
});

// Phone OTP-based password recovery
router.post('/forgot-password-otp', sensitiveLimiter, async (req, res) => {
  const normPhone = core.normalizePhone(req.body && req.body.phone);
  if (!normPhone) return res.status(400).json({ error: 'A valid phone number is required.' });
  try {
    // [SEC] Always-200 (like /forgot-password): never reveal whether a phone maps
    // to an account. Only a real account gets an OTP generated/stored/sent; the
    // response shape is identical either way, so this is not an enumeration oracle.
    const user = await getQuery(`SELECT id, email, tenant_id FROM users WHERE phone = ?`, [normPhone]);
    let otp = null;
    if (user) {
      otp = String(Math.floor(100000 + Math.random() * 900000));
      const otpHash = core.sha256(otp);
      const expiresAt = core.sqlTime(10 * 60 * 1000); // 10 minutes
      await runQuery(`INSERT INTO phone_verifications (id, user_id, phone, otp_hash, expires_at) VALUES (?, ?, ?, ?, ?)`,
        [core.newId('pv'), user.id, normPhone, otpHash, expiresAt]);
      await events.record({ userId: user.id, email: user.email, event: 'forgot_password_otp_sent', req, meta: { phone: normPhone } });
    }

    res.json({
      success: true,
      cooldown: 60,
      // Dev-only convenience; absent in production so both branches are identical there.
      ...((!core.IS_PROD && otp) ? { devCode: otp } : {})
    });
  } catch (err) {
    console.error('forgot-password-otp error:', err);
    res.status(500).json({ error: 'Failed to request OTP code.' });
  }
});

router.post('/reset-password-otp', authLimiter, async (req, res) => {
  const normPhone = core.normalizePhone(req.body && req.body.phone);
  const { code, password } = req.body || {};
  if (!normPhone || !code || !password) {
    return res.status(400).json({ error: 'Phone, OTP code, and new password are required.' });
  }
  try {
    const user = await getQuery(`SELECT * FROM users WHERE phone = ?`, [normPhone]);
    // [SEC] Unknown phone returns the SAME generic response as a missing/wrong OTP
    // so this endpoint can't be used to enumerate which phones have accounts.
    if (!user) return res.status(400).json({ error: 'Incorrect code. Please request a new one.', code: 'OTP_INVALID' });

    const policy = account.checkPasswordPolicy(password, user.email);
    if (!policy.ok) return res.status(400).json({ error: policy.error, code: policy.code });

    const row = await getQuery(
      `SELECT * FROM phone_verifications WHERE user_id = ? AND phone = ? AND verified_at IS NULL ORDER BY created_at DESC LIMIT 1`,
      [user.id, normPhone]);

    if (!row) return res.status(400).json({ error: 'Incorrect code. Please request a new one.', code: 'OTP_INVALID' });
    if (core.parseSqlTime(row.expires_at) < Date.now()) return res.status(400).json({ error: 'That code has expired. Please request a new code.', code: 'OTP_EXPIRED' });
    if (row.attempts >= 5) return res.status(400).json({ error: 'Too many incorrect attempts. Please request a new code.', code: 'OTP_ATTEMPTS' });

    if (core.sha256(String(code).trim()) !== row.otp_hash) {
      await runQuery(`UPDATE phone_verifications SET attempts = attempts + 1 WHERE id = ?`, [row.id]);
      const left = 5 - row.attempts - 1;
      return res.status(400).json({ error: left <= 0 ? 'Too many incorrect attempts. Please request a new code.' : 'Incorrect code. Please try again.', code: 'OTP_INVALID' });
    }

    // Mark OTP as verified
    await runQuery(`UPDATE phone_verifications SET verified_at = CURRENT_TIMESTAMP WHERE id = ?`, [row.id]);

    // Check reuse
    if (await account.isPasswordReused(user.id, password, user.password_set ? user.password_hash : null)) {
      return res.status(400).json({ error: 'That password was used recently. Please choose a different one.', code: 'PASSWORD_REUSE' });
    }

    // Set new password
    await account.applyNewPassword(user.id, password, {
      oldHash: user.password_set ? user.password_hash : null,
      exceptSid: null,
      reason: 'password_reset_otp'
    });

    // Automatically mark user phone as verified since they verified via OTP!
    await runQuery(`UPDATE users SET phone_verified = 1, phone_verified_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [user.id]);

    await events.record({ userId: user.id, email: user.email, event: 'password_reset_otp', req });

    res.json({ message: 'Password updated successfully.' });
  } catch (err) {
    console.error('reset-password-otp error:', err);
    res.status(500).json({ error: 'Failed to reset password.' });
  }
});

// ---------------------------------------------------------------------------
// Password change / set (authenticated)
// ---------------------------------------------------------------------------
router.post('/change-password', authLimiter, authenticateToken, async (req, res) => {
  const { current_password, new_password } = req.body || {};
  if (!current_password || !new_password) return res.status(400).json({ error: 'Current and new password are required.' });
  try {
    const user = await getQuery('SELECT * FROM users WHERE id = ?', [req.user.id]);
    if (!user) return res.status(404).json({ error: 'Account not found.' });
    if (!user.password_set) return res.status(400).json({ error: 'This account has no password yet. Use Set Password instead.', code: 'PASSWORD_NOT_SET' });

    const match = await bcrypt.compare(current_password, user.password_hash || core.DUMMY_PW_HASH);
    if (!match) return res.status(400).json({ error: 'Current password is incorrect.', code: 'WRONG_PASSWORD' });

    const policy = account.checkPasswordPolicy(new_password, user.email);
    if (!policy.ok) return res.status(400).json({ error: policy.error, code: policy.code });
    if (await account.isPasswordReused(user.id, new_password, user.password_hash)) {
      return res.status(400).json({ error: 'That password was used recently. Please choose a different one.', code: 'PASSWORD_REUSE' });
    }

    // Other sessions die; the one making the change stays signed in.
    await account.applyNewPassword(user.id, new_password, { oldHash: user.password_hash, exceptSid: req.user.sid || null, reason: 'password_changed' });
    await events.record({ userId: user.id, email: user.email, event: 'password_changed', req });
    if (core.EMAIL_ENABLED) {
      emailService.sendSecurityAlert(user.email, 'Your GYM Flow password was changed',
        ['Your password was just changed. Other devices were signed out.'], user.tenant_id).catch(() => {});
    }
    res.json({ message: 'Password changed. Other devices were signed out.' });
  } catch (err) {
    console.error('Change-password error:', err);
    res.status(500).json({ error: 'Failed to change password.' });
  }
});

// Case 4: a Google-only account adds a password → both login methods work.
router.post('/set-password', authLimiter, authenticateToken, async (req, res) => {
  const { new_password } = req.body || {};
  if (!new_password) return res.status(400).json({ error: 'New password is required.' });
  try {
    const user = await getQuery('SELECT * FROM users WHERE id = ?', [req.user.id]);
    if (!user) return res.status(404).json({ error: 'Account not found.' });
    if (user.password_set) return res.status(409).json({ error: 'A password is already set. Use Change Password instead.', code: 'PASSWORD_ALREADY_SET' });

    const policy = account.checkPasswordPolicy(new_password, user.email);
    if (!policy.ok) return res.status(400).json({ error: policy.error, code: policy.code });

    await account.applyNewPassword(user.id, new_password, { oldHash: null, exceptSid: req.user.sid || null, reason: 'password_set' });
    await events.record({ userId: user.id, email: user.email, event: 'password_set', req });
    res.json({ message: 'Password set. You can now sign in with email and password too.' });
  } catch (err) {
    console.error('Set-password error:', err);
    res.status(500).json({ error: 'Failed to set password.' });
  }
});

// Case 5: change sign-in email — verified via a link to the NEW address; the
// old address is notified when the change commits (in /verify-email above).
router.post('/change-email', authLimiter, authenticateToken, async (req, res) => {
  const newEmail = core.normalizeEmail(req.body && req.body.new_email);
  const { current_password } = req.body || {};
  if (!newEmail || !core.isValidEmail(newEmail)) return res.status(400).json({ error: 'Please enter a valid email address.' });
  if (!core.EMAIL_ENABLED) return res.status(503).json({ error: 'Email delivery is not configured on this server, so email changes cannot be verified.', code: 'EMAIL_DISABLED' });
  try {
    const user = await getQuery('SELECT * FROM users WHERE id = ?', [req.user.id]);
    if (!user) return res.status(404).json({ error: 'Account not found.' });
    if (user.password_set) {
      const match = await bcrypt.compare(String(current_password || ''), user.password_hash || core.DUMMY_PW_HASH);
      if (!match) return res.status(400).json({ error: 'Current password is incorrect.', code: 'WRONG_PASSWORD' });
    }
    if (newEmail === core.normalizeEmail(user.email)) return res.status(400).json({ error: 'That is already your email address.' });
    const clash = await getQuery('SELECT id FROM users WHERE email = ?', [newEmail]);
    if (clash) return res.status(400).json({ error: 'That email address is already in use.', code: 'EMAIL_IN_USE' });

    const token = await account.createEmailVerification(user.id, newEmail, 'change');
    await emailService.sendEmailChangeVerification(newEmail, token, user.tenant_id, PORT);
    await events.record({ userId: user.id, email: user.email, event: 'email_change_requested', req, meta: { to: newEmail } });
    if (core.EMAIL_ENABLED) {
      emailService.sendSecurityAlert(user.email, 'Email change requested on your GYM Flow account',
        [`A request was made to change your sign-in email to ${newEmail}.`,
         'If this was not you, change your password immediately.'], user.tenant_id).catch(() => {});
    }
    res.json({ message: 'Verification link sent to the new address.', verificationPending: true });
  } catch (err) {
    console.error('Change-email error:', err);
    res.status(500).json({ error: 'Failed to request email change.' });
  }
});

// ---------------------------------------------------------------------------
// Sessions & tokens
// ---------------------------------------------------------------------------
router.post('/refresh', async (req, res) => {
  try {
    const decoded = await refreshWithCookie(req, res);
    if (!decoded) return res.status(401).json({ error: 'Session expired. Please sign in again.' });
    res.json({ ok: true });
  } catch (err) {
    console.error('Refresh error:', err);
    res.status(500).json({ error: 'Failed to refresh session.' });
  }
});

// Logout revokes the access token AND the session row (durable) — a copied
// token or refresh cookie is dead after this.
router.post('/logout', async (req, res) => {
  const token = req.cookies.auth_token;
  try {
    if (token) {
      try {
        const decoded = core.verifyToken(token);
        core.revokeToken(decoded);
        if (decoded.sid) await sessions.revokeSession(decoded.sid, 'logout');
        await events.record({ userId: decoded.id, email: decoded.email, event: 'logout', req });
      } catch (e) { /* already invalid/expired — nothing to revoke */ }
    }
  } catch (err) {
    console.error('Logout error:', err);
  }
  core.clearAuthCookies(res);
  res.json({ message: 'Session terminated successfully.' });
});

router.post('/logout-all', authenticateToken, async (req, res) => {
  try {
    const revoked = await sessions.revokeAllSessions(req.user.id, { exceptSid: req.user.sid || null, reason: 'logout_all' });
    await events.record({ userId: req.user.id, email: req.user.email, event: 'logout_all', req, meta: { revoked } });
    res.json({ message: 'Signed out on all other devices.', revoked });
  } catch (err) {
    console.error('Logout-all error:', err);
    res.status(500).json({ error: 'Failed to sign out other devices.' });
  }
});

router.get('/sessions', authenticateToken, async (req, res) => {
  try {
    res.json({ sessions: await sessions.listSessions(req.user.id, req.user.sid || null) });
  } catch (err) {
    console.error('Sessions list error:', err);
    res.status(500).json({ error: 'Failed to load sessions.' });
  }
});

router.delete('/sessions/:id', authenticateToken, async (req, res) => {
  try {
    const row = await getQuery(`SELECT id, user_id FROM auth_sessions WHERE id = ?`, [req.params.id]);
    if (!row || row.user_id !== req.user.id) return res.status(404).json({ error: 'Session not found.' });
    await sessions.revokeSession(row.id, 'user_revoked');
    await events.record({ userId: req.user.id, email: req.user.email, event: 'session_revoked', req, meta: { sid: row.id } });
    if (req.user.sid === row.id) core.clearAuthCookies(res);
    res.json({ message: 'Session signed out.' });
  } catch (err) {
    console.error('Session revoke error:', err);
    res.status(500).json({ error: 'Failed to revoke session.' });
  }
});

router.get('/devices', authenticateToken, async (req, res) => {
  try {
    res.json({ devices: await sessions.listDevices(req.user.id, req) });
  } catch (err) {
    console.error('Devices list error:', err);
    res.status(500).json({ error: 'Failed to load devices.' });
  }
});

router.delete('/devices/:id', authenticateToken, async (req, res) => {
  try {
    const ok = await sessions.forgetDevice(req.user.id, req.params.id);
    if (!ok) return res.status(404).json({ error: 'Device not found.' });
    res.json({ message: 'Device forgotten.' });
  } catch (err) {
    console.error('Device forget error:', err);
    res.status(500).json({ error: 'Failed to forget device.' });
  }
});

// ---------------------------------------------------------------------------
// Security summary (one call for the Security Center)
// ---------------------------------------------------------------------------
router.get('/security', authenticateToken, async (req, res) => {
  try {
    const user = await getQuery('SELECT email, email_verified, phone, phone_verified_at, password_set FROM users WHERE id = ?', [req.user.id]);
    if (!user) return res.status(404).json({ error: 'Account not found.' });
    const providers = await account.getProviders(req.user.id);
    const google = providers.find(p => p.provider === 'google');
    res.json({
      email: user.email,
      email_verified: !!user.email_verified,
      phone: user.phone || null,
      phone_verified: !!user.phone_verified_at,
      password_set: !!user.password_set,
      google_available: core.GOOGLE_ENABLED,
      email_enabled: core.EMAIL_ENABLED,
      providers: { google: { linked: !!google, email: google ? google.email : null } },
      events: await events.recentEvents(req.user.id, 15)
    });
  } catch (err) {
    console.error('Security summary error:', err);
    res.status(500).json({ error: 'Failed to load security summary.' });
  }
});

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------
router.post('/select-role', authLimiter, authenticateToken, async (req, res) => {
  const { tenant_id, role_id } = req.body || {};
  if (!tenant_id || !role_id) return res.status(400).json({ error: 'tenant_id and role_id are required.' });
  try {
    const user = await getQuery(`SELECT * FROM users WHERE id = ?`, [req.user.id]);
    if (!core.isAccountActive(user)) return res.status(403).json({ error: 'This account has been suspended.' });

    // The pair is re-verified against user_roles — a client cannot grant itself
    // a role it does not hold. Selection is a token exchange, not a mutation.
    const roles = await core.getUserRoles(user.id);
    const role = roles.find(r => r.tenant_id === tenant_id && r.role_id === role_id);
    if (!role) return res.status(403).json({ error: 'You do not hold that role.' });

    core.revokeToken(req.authToken);
    const remember = !!req.user.remember;
    const sid = req.user.sid || null;
    if (sid) await sessions.scopeSession(sid, role);
    const token = core.signScopedToken(user, role, remember, sid);
    if (sid) await sessions.touchAccess(sid, core.verifyToken(token).jti);
    core.setAuthCookie(req, res, token, remember, false);
    res.json({
      message: 'Role selected.',
      redirect: core.shellForRole(role.role_id),
      role: { tenant_id: role.tenant_id, role_id: role.role_id, role_name: role.role_name, gym_name: role.gym_name }
    });
  } catch (err) {
    console.error('Select-role error:', err);
    res.status(500).json({ error: 'Failed to select role.' });
  }
});

// First-time platform role selection (Admin / Gym Owner vs Member).
router.post('/platform-role', authLimiter, authenticateToken, async (req, res) => {
  const { role } = req.body || {};
  if (role !== 'ADMIN' && role !== 'MEMBER') {
    return res.status(400).json({ error: 'Invalid platform role selection.' });
  }
  try {
    const user = await getQuery(`SELECT * FROM users WHERE id = ?`, [req.user.id]);
    if (!user) return res.status(404).json({ error: 'Account not found.' });

    // Validate phone verification first
    if (!user.phone_verified_at) {
      return res.status(403).json({ error: 'Phone verification is required before selecting a platform role.', code: 'PHONE_UNVERIFIED' });
    }

    // Only allow setting platform role ONCE
    if (user.platform_role) {
      return res.status(400).json({ error: 'Platform role has already been selected.', code: 'ROLE_ALREADY_SELECTED' });
    }

    await runQuery(`UPDATE users SET platform_role = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [role, req.user.id]);

    const updatedUser = { ...user, platform_role: role };
    const remember = !!req.user.remember;
    const sid = req.user.sid || null;

    let token;
    let redirect;

    if (role === 'MEMBER') {
      const roles = await core.getUserRoles(req.user.id);
      const activeRole = roles[0] || null;
      if (activeRole) {
        token = core.signScopedToken(updatedUser, activeRole, remember, sid);
      } else {
        token = core.signPendingToken(updatedUser, remember, sid);
      }
      redirect = '/member-coming-soon';
    } else {
      const roles = await core.getUserRoles(req.user.id);
      const activeRole = roles[0] || null;
      if (activeRole && roles.length === 1) {
        if (sid) await sessions.scopeSession(sid, activeRole);
        token = core.signScopedToken(updatedUser, activeRole, remember, sid);
        redirect = core.shellForRole(activeRole.role_id);
      } else {
        token = core.signPendingToken(updatedUser, remember, sid);
        redirect = '/select-role';
      }
    }

    core.setAuthCookie(req, res, token, remember, false);
    await events.record({ userId: req.user.id, email: user.email, event: 'platform_role_selected', req, meta: { role } });

    res.json({ message: 'Platform role saved successfully.', redirect });
  } catch (err) {
    console.error('Platform role selection error:', err);
    res.status(500).json({ error: 'Failed to save platform role.' });
  }
});

// ---------------------------------------------------------------------------
// Phone (verification factor — NEVER a login credential)
// ---------------------------------------------------------------------------

// Legacy add-once backfill (kept for older clients; records the phone unverified).
router.post('/phone', authLimiter, authenticateToken, async (req, res) => {
  const normPhone = core.normalizePhone(req.body && req.body.phone);
  if (!normPhone) return res.status(400).json({ error: 'A valid phone number (10-15 digits) is required.' });
  try {
    const user = await getQuery(`SELECT id, phone FROM users WHERE id = ?`, [req.user.id]);
    if (!user) return res.status(404).json({ error: 'Account not found.' });
    if (user.phone) return res.status(409).json({ error: 'A phone number is already linked to this account.' });
    await runQuery(`UPDATE users SET phone = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [normPhone, user.id]);
    res.json({ message: 'Phone number linked to your account.', phone: normPhone });
  } catch (err) {
    console.error('Phone backfill error:', err);
    res.status(500).json({ error: 'Failed to save phone number.' });
  }
});

router.post('/phone/request-otp', sensitiveLimiter, authenticateToken, async (req, res) => {
  const normPhone = core.normalizePhone(req.body && req.body.phone);
  if (!normPhone) return res.status(400).json({ error: 'A valid phone number (10-15 digits) is required.' });
  try {
    const user = await getQuery('SELECT * FROM users WHERE id = ?', [req.user.id]);
    if (!user) return res.status(404).json({ error: 'Account not found.' });
    // Replacing an already-verified phone is a security-sensitive change (Case 7):
    // it requires the password when the account has one.
    if (user.phone_verified_at && user.phone && user.phone !== normPhone && user.password_set) {
      const match = await bcrypt.compare(String((req.body && req.body.current_password) || ''), user.password_hash || core.DUMMY_PW_HASH);
      if (!match) return res.status(400).json({ error: 'Enter your password to change a verified phone number.', code: 'WRONG_PASSWORD' });
    }
    const result = await account.requestPhoneOtp(user.id, normPhone);
    if (!result.ok) return res.status(429).json({ error: result.error, code: result.code });
    await events.record({ userId: user.id, email: user.email, event: 'otp_sent', req, meta: { phone: normPhone } });
    res.json({
      message: 'Verification code sent.',
      cooldown: 60,
      // Surface a usable code whenever codes are undeliverable: the fixed test
      // code while test-OTP mode is active (even in production — otherwise the
      // deployed prototype can never verify a phone), else the real code in dev.
      ...(account.testOtpActive() ? { devCode: '000000' }
        : (core.IS_PROD ? {} : { devCode: result.otp }))
    });
  } catch (err) {
    console.error('Request-otp error:', err);
    res.status(500).json({ error: 'Failed to send verification code.' });
  }
});

router.post('/phone/verify-otp', authLimiter, authenticateToken, async (req, res) => {
  const normPhone = core.normalizePhone(req.body && req.body.phone);
  const code = req.body && req.body.code;
  if (!normPhone || !code) return res.status(400).json({ error: 'Phone and code are required.' });
  try {
    const result = await account.verifyPhoneOtp(req.user.id, normPhone, code);
    if (!result.ok) return res.status(400).json({ error: result.error, code: result.code });
    await events.record({ userId: req.user.id, email: req.user.email, event: 'phone_verified', req, meta: { phone: normPhone } });

    // Update session cookies with updated phone_verified state
    const user = await getQuery(`SELECT * FROM users WHERE id = ?`, [req.user.id]);
    const remember = !!req.user.remember;
    const sid = req.user.sid || null;
    let token;
    if (req.user.pending_role_selection) {
      token = core.signPendingToken(user, remember, sid);
    } else {
      const roles = await core.getUserRoles(req.user.id);
      const activeRole = roles.find(r => r.tenant_id === req.user.tenant_id && r.role_id === req.user.role_id) || roles[0];
      if (activeRole) {
        token = core.signScopedToken(user, activeRole, remember, sid);
      } else {
        token = core.signPendingToken(user, remember, sid);
      }
    }
    core.setAuthCookie(req, res, token, remember, false);

    res.json({ message: 'Phone number verified.', phone_verified: true });
  } catch (err) {
    console.error('Verify-otp error:', err);
    res.status(500).json({ error: 'Failed to verify code.' });
  }
});

// ---------------------------------------------------------------------------
// Provider config + Google OAuth (login, signup and account linking)
// ---------------------------------------------------------------------------
router.get('/config', (req, res) => {
  res.json({ google: core.GOOGLE_ENABLED, emailVerification: core.EMAIL_ENABLED });
});

// Step 1 — redirect to Google's consent screen. intent=link ties the round trip
// to the CURRENT signed-in account instead of performing a sign-in.
router.get('/google', authLimiter, (req, res) => {
  if (!core.GOOGLE_ENABLED) return res.status(503).json({ error: 'Google sign-in is not configured on this server.' });
  let linkUid = null;
  if (req.query.intent === 'link') {
    try {
      const decoded = core.verifyToken(req.cookies.auth_token);
      linkUid = decoded.id;
    } catch (e) {
      return res.redirect('/login');
    }
  }
  const state = core.randomToken(16);
  res.cookie('g_oauth_state', JSON.stringify({ v: state, intent: linkUid ? 'link' : 'login', uid: linkUid }),
    { httpOnly: true, sameSite: 'lax', maxAge: 10 * 60 * 1000, secure: core.IS_PROD });
  const params = new URLSearchParams({
    client_id: core.GOOGLE_CLIENT_ID,
    redirect_uri: `${core.APP_BASE_URL}/api/v1/auth/google/callback`,
    response_type: 'code',
    scope: 'openid email profile',
    access_type: 'online',
    include_granted_scopes: 'true',
    prompt: 'select_account',
    state
  });
  res.redirect('https://accounts.google.com/o/oauth2/v2/auth?' + params.toString());
});

// Step 2 — Google's redirect: verify state, exchange code, resolve the account
// (sub → email → create), or link to the signed-in account in link mode.
router.get('/google/callback', async (req, res) => {
  if (!core.GOOGLE_ENABLED) return res.redirect('/login');
  const { code, state } = req.query;
  let stateData = null;
  try { stateData = JSON.parse(req.cookies.g_oauth_state || 'null'); } catch (e) { /* fall through */ }
  res.clearCookie('g_oauth_state');
  if (!code || !state || !stateData || state !== stateData.v) {
    return res.redirect('/login?error=google_state');
  }
  const linking = stateData.intent === 'link';
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: String(code),
        client_id: core.GOOGLE_CLIENT_ID,
        client_secret: core.GOOGLE_CLIENT_SECRET,
        redirect_uri: `${core.APP_BASE_URL}/api/v1/auth/google/callback`,
        grant_type: 'authorization_code'
      })
    });
    const tokens = await tokenRes.json();
    if (!tokens.access_token) return res.redirect(linking ? '/security?error=google_link' : '/login?error=google_token');

    const profileRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` }
    });
    const profile = await profileRes.json();
    const email = core.normalizeEmail(profile.email);
    const sub = profile.sub;
    // Only a Google-verified email may link/merge accounts — an unverified
    // address would be an account-takeover vector.
    if (!sub || !email || profile.email_verified === false) {
      return res.redirect(linking ? '/security?error=google_link' : '/login?error=google_email');
    }

    // ---- Link mode: attach Google to the CURRENT signed-in account ----
    if (linking) {
      let current;
      try { current = core.verifyToken(req.cookies.auth_token); } catch (e) { return res.redirect('/login'); }
      if (current.id !== stateData.uid) return res.redirect('/security?error=google_link');
      const existing = await account.findByProvider('google', sub);
      if (existing && existing.user_id !== current.id) return res.redirect('/security?error=google_in_use');
      await account.linkProvider(current.id, 'google', sub, email);
      await events.record({ userId: current.id, email: current.email, event: 'provider_linked', req, meta: { provider: 'google' } });
      if (core.EMAIL_ENABLED) {
        emailService.sendSecurityAlert(current.email, 'Google sign-in connected to your GYM Flow account',
          [`Google account ${email} can now sign in to your account.`], null).catch(() => {});
      }
      return res.redirect('/security?linked=google');
    }

    // ---- Login mode: resolve by provider uid first (survives Google-side email
    // changes), then by verified email (auto-link — never a duplicate account),
    // then provision a brand-new account + gym. ----
    let user = null;
    const prov = await account.findByProvider('google', sub);
    if (prov) {
      user = await getQuery(`SELECT * FROM users WHERE id = ?`, [prov.user_id]);
      await account.touchProvider('google', sub);
    }
    if (!user) {
      user = await getQuery(`SELECT * FROM users WHERE email = ?`, [email]);
      if (user) {
        // Case 3: existing email account chooses Google later → link, never fork.
        await account.linkProvider(user.id, 'google', sub, email);
        // Google has verified this mailbox — that satisfies our verification too.
        if (!user.email_verified) await runQuery(`UPDATE users SET email_verified = 1 WHERE id = ?`, [user.id]);
        await events.record({ userId: user.id, email, event: 'provider_linked', req, meta: { provider: 'google', auto: true } });
      }
    }
    if (!user) {
      // Case 2: first Google sign-in → new global account + its first gym.
      // No password: password_hash stays NULL until an explicit set-password.
      const userId = core.newId('u');
      const tenantId = core.newId('t');
      const fullName = profile.name || email.split('@')[0];
      const gymName = (fullName.split(' ')[0] || 'My') + "'s Gym";
      const subdomain = fullName.toLowerCase().replace(/[^a-z0-9]/g, '') + Math.floor(Math.random() * 1000);
      const trialStart = new Date().toISOString();
      // 7-day PRO trial from signup; lapses to the free Basic plan (never a lockout).
    const trialEnd = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
      await runQuery(`INSERT INTO tenants (id, gym_name, subdomain, owner_user_id, subscription_plan, trial_start, trial_end, subscription_status) VALUES (?, ?, ?, ?, 'trial', ?, ?, 'trial')`,
        [tenantId, gymName, subdomain, userId, trialStart, trialEnd]);
      await runQuery(`INSERT INTO users (id, role_id, tenant_id, email, password_hash, full_name, email_verified, status, password_set) VALUES (?, 'r1', ?, ?, NULL, ?, 1, 'active', 0)`,
        [userId, tenantId, email, fullName]);
      await runQuery(`INSERT INTO user_roles (id, user_id, tenant_id, role_id) VALUES (?, ?, ?, 'r1') ON CONFLICT DO NOTHING`,
        ['ur_' + userId + '_' + tenantId + '_r1', userId, tenantId]);
      await account.linkProvider(userId, 'google', sub, email);
      await seedTenantDefaults(tenantId, gymName);
      await events.record({ userId, email, event: 'signup', req, meta: { provider: 'google' } });
      user = await getQuery(`SELECT * FROM users WHERE id = ?`, [userId]);
    }

    // Same single source of truth as the password path (the old OAuth-only
    // && check let suspended accounts through — fixed).
    if (!core.isAccountActive(user)) return res.redirect('/login?error=suspended');

    const roles = await core.getUserRoles(user.id);
    if (roles.length === 0) return res.redirect('/login?error=suspended');
    const out = await issueLogin(req, res, user, roles, false, { provider: 'google' });
    return res.redirect(out.redirect);
  } catch (err) {
    console.error('Google OAuth callback error:', err);
    res.redirect(linking ? '/security?error=google_link' : '/login?error=google');
  }
});

router.delete('/providers/google', authenticateToken, async (req, res) => {
  try {
    const result = await account.unlinkProvider(req.user.id, 'google');
    if (!result.ok) return res.status(result.code === 'LAST_LOGIN_METHOD' ? 409 : 400).json({ error: result.error, code: result.code });
    await events.record({ userId: req.user.id, email: req.user.email, event: 'provider_unlinked', req, meta: { provider: 'google' } });
    if (core.EMAIL_ENABLED) {
      emailService.sendSecurityAlert(req.user.email, 'Google sign-in disconnected from your GYM Flow account',
        ['Google can no longer be used to sign in to this account.'], null).catch(() => {});
    }
    res.json({ message: 'Google disconnected.' });
  } catch (err) {
    console.error('Provider unlink error:', err);
    res.status(500).json({ error: 'Failed to disconnect provider.' });
  }
});

// ---------------------------------------------------------------------------
// Session check (used by every authenticated page shell)
// ---------------------------------------------------------------------------
router.get('/session', authenticateToken, async (req, res) => {
  try {
    const tenant = req.user.tenant_id
      ? await getQuery(`SELECT id, gym_name, subscription_plan, trial_start, trial_end, subscription_status, tour_completed, onboarding_completed, tutorial_step FROM tenants WHERE id = ?`, [req.user.tenant_id])
      : null;
    const roles = await core.getUserRoles(req.user.id);
    const userRow = await getQuery(`SELECT phone, phone_verified, phone_verified_at, email_verified, password_set, platform_role FROM users WHERE id = ?`, [req.user.id]);
    res.json({
      user: { ...req.user, phone: (userRow && userRow.phone) || null, platform_role: (userRow && userRow.platform_role) || null, phone_verified: userRow ? userRow.phone_verified : 0 },
      pending_role_selection: !!req.user.pending_role_selection,
      roles: core.rolesForClient(roles),
      security: userRow ? {
        email_verified: !!userRow.email_verified,
        phone_verified: !!userRow.phone_verified_at,
        password_set: !!userRow.password_set
      } : null,
      tenant: tenant || { subscription_plan: 'trial', subscription_status: 'trial', tour_completed: 0, onboarding_completed: 0, tutorial_step: 0 }
    });
  } catch (err) {
    res.json({
      user: req.user,
      pending_role_selection: !!req.user.pending_role_selection,
      roles: [],
      security: null,
      tenant: { subscription_plan: 'trial', subscription_status: 'trial', tour_completed: 0, onboarding_completed: 0, tutorial_step: 0 }
    });
  }
});

module.exports = router;
