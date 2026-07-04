const express = require('express');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const path = require('path');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
require('dotenv').config();
const { initializeDatabase, getQuery, runQuery, allQuery, seedTenantDefaults } = require('./database');
const emailService = require('./lib/emailService');

const app = express();
const PORT = process.env.PORT || 3000;

// [REL] Trust the reverse proxy / load balancer so req.ip reflects the REAL client
// IP (the per-IP auth rate limiter keys on it) and Express can see the forwarded
// protocol. Without this, every request behind a proxy shares the proxy's IP, which
// turns the auth limiter into a single global bucket that locks out all users at
// once. Configurable: TRUST_PROXY=1 (first hop), 'true', or a subnet/list. Defaults
// off for direct/local deployments where req.ip is already the client.
if (process.env.TRUST_PROXY) {
  const tp = process.env.TRUST_PROXY.trim();
  app.set('trust proxy', tp === 'true' ? true : (isNaN(Number(tp)) ? tp : Number(tp)));
}

// [SEC] Do not advertise the server framework/version (info disclosure).
app.disable('x-powered-by');

// [SEC] Security response headers applied to EVERY response (pages, API, static
// assets, webhook). Hand-rolled to avoid adding a dependency.
//   * CSP locks the origins that may load scripts/styles/fonts/images/frames and
//     blocks <base> hijacking, plugin objects, and clickjacking (frame-ancestors).
//     Inline scripts/handlers and Tailwind's CDN JIT require 'unsafe-inline'/'eval',
//     so script-src keeps those but still restricts WHICH external origins load.
//     Razorpay's checkout origins are whitelisted so payments keep working exactly
//     as before. Set DISABLE_CSP=true to ship only the non-CSP headers if a future
//     page needs a new origin.
//   * Payment Permissions-Policy / COOP are deliberately left permissive
//     (same-origin-allow-popups, payment unrestricted) so the Razorpay popup/iframe
//     flow is never severed.
const RZP = 'https://*.razorpay.com';
const CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  `img-src 'self' data: blob: https://lh3.googleusercontent.com ${RZP}`,
  "font-src 'self' data: https://fonts.gstatic.com https://cdnjs.cloudflare.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://cdn.tailwindcss.com",
  `script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.tailwindcss.com https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://checkout.razorpay.com`,
  `connect-src 'self' ${RZP} https://lumberjack.razorpay.com`,
  `frame-src https://checkout.razorpay.com https://api.razorpay.com ${RZP}`
].join('; ');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), usb=()');
  if (process.env.DISABLE_CSP !== 'true') {
    res.setHeader('Content-Security-Policy', CSP);
  }
  // HSTS only in production (over HTTPS); browsers ignore it on plain-HTTP localhost.
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  }
  next();
});

// [IDENTITY] All identity primitives — JWT config (including the fatal
// weak-secret boot check), cookie policy, auth middleware, the server-side role
// spine and the rate limiters — live in lib/identity (see IDENTITY_PLATFORM.md).
// Auth ENDPOINTS live in routes/auth.js, mounted further below.
const identity = require('./lib/identity/core');
const { resolvePageAuth } = require('./lib/identity/refresh');
const {
  authenticateToken, requireTenant, requireStaffRole, shellRedirectFor, shellForRole, authLimiter, GOOGLE_ENABLED, EMAIL_ENABLED,
  getUserRoles, setAuthCookie, signScopedToken, signPendingToken, rolesForClient, verifyToken, revokeToken, DUMMY_PW_HASH
} = identity;


// Member/staff photos are uploaded inline as base64 data URLs (front-end caps
// each image at ~2 MB → ~2.7 MB base64), so the default 100kb body limit would
// reject any submission with a photo (413 → "Onboarding database offline").
// [C6] Razorpay webhook — the SERVER-AUTHORITATIVE source of paid subscription
// state. Mounted BEFORE express.json with a raw body so the HMAC signature can be
// verified against the exact bytes Razorpay sent. Plan upgrades/downgrades happen
// here (and in the signature-verified /subscription/verify-payment), never from a
// plain client request. Idempotent via billing_events.razorpay_event_id (UNIQUE).
const PLAN_PRICES = { basic: 299, pro: 499, enterprise: 999 };
async function applyBillingEvent(evt) {
  const type = evt.event || '';
  const subEntity = evt.payload && evt.payload.subscription && evt.payload.subscription.entity;
  const payEntity = evt.payload && evt.payload.payment && evt.payload.payment.entity;
  const notes = (subEntity && subEntity.notes) || (payEntity && payEntity.notes) || {};
  const tenantId = notes.tenant_id;
  const plan = notes.plan;
  const rzpSubId = subEntity && subEntity.id;
  const rzpPayId = payEntity && payEntity.id;
  if (!tenantId) return { handled: false, reason: 'no tenant_id in notes' };

  const ACTIVATE = ['subscription.charged', 'subscription.activated', 'subscription.authenticated', 'order.paid', 'payment.captured'];
  const CANCEL = ['subscription.halted', 'subscription.cancelled', 'subscription.completed', 'subscription.paused'];

  if (ACTIVATE.includes(type) && ['basic', 'pro', 'enterprise'].includes(plan)) {
    const nextBilling = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    const cur = await getQuery('SELECT subscription_plan FROM tenants WHERE id = ?', [tenantId]);
    await runQuery("UPDATE tenants SET subscription_plan = ?, subscription_status = 'active', next_billing_date = ? WHERE id = ?", [plan, nextBilling, tenantId]);
    await runQuery(`INSERT OR REPLACE INTO subscriptions (id, tenant_id, plan, status, razorpay_subscription_id, next_billing_date, updated_at)
                    VALUES (?, ?, ?, 'active', ?, ?, CURRENT_TIMESTAMP)`,
      ['sub_' + tenantId, tenantId, plan, rzpSubId || rzpPayId || null, nextBilling]);
    await runQuery(`INSERT INTO subscription_history (id, tenant_id, from_plan, to_plan, action, razorpay_subscription_id, razorpay_payment_id, amount, notes)
                    VALUES (?, ?, ?, ?, 'webhook_activate', ?, ?, ?, 'Activated via verified Razorpay webhook.')`,
      ['sh_' + crypto.randomBytes(8).toString('hex'), tenantId, cur ? cur.subscription_plan : null, plan, rzpSubId || null, rzpPayId || null, PLAN_PRICES[plan] || 0]);
    return { handled: true, action: 'activate', tenantId, plan };
  }

  if (CANCEL.includes(type)) {
    await runQuery("UPDATE tenants SET subscription_status = 'cancelled', cancelled_at = CURRENT_TIMESTAMP WHERE id = ?", [tenantId]);
    await runQuery("UPDATE subscriptions SET status = 'cancelled', cancelled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE tenant_id = ?", [tenantId]);
    await runQuery(`INSERT INTO subscription_history (id, tenant_id, from_plan, to_plan, action, razorpay_subscription_id, notes)
                    VALUES (?, ?, ?, 'trial', 'webhook_cancel', ?, 'Cancelled/halted via Razorpay webhook.')`,
      ['sh_' + crypto.randomBytes(8).toString('hex'), tenantId, plan || null, rzpSubId || null]);
    return { handled: true, action: 'cancel', tenantId };
  }
  return { handled: false, reason: 'unhandled event type: ' + type };
}

app.post('/webhooks/razorpay', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) return res.status(503).json({ error: 'Webhook not configured.' });
  const signature = req.headers['x-razorpay-signature'];
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');
  const expected = crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const sigBuf = Buffer.from(String(signature || ''));
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return res.status(400).json({ error: 'Invalid signature.' });
  }

  let evt;
  try { evt = JSON.parse(raw.toString('utf8')); } catch { return res.status(400).json({ error: 'Malformed payload.' }); }

  // Idempotency: a duplicate delivery (same event id) is acknowledged but not re-applied.
  const eventId = req.headers['x-razorpay-event-id'] || evt.id || (evt.event + '_' + (evt.created_at || Date.now()));
  try {
    const inserted = await runQuery(
      `INSERT OR IGNORE INTO billing_events (id, tenant_id, event_type, razorpay_event_id, payload, status)
       VALUES (?, ?, ?, ?, ?, 'received')`,
      ['be_' + crypto.randomBytes(8).toString('hex'), null, evt.event || null, eventId, raw.toString('utf8')]);
    if (!inserted || inserted.changes === 0) {
      return res.json({ ok: true, duplicate: true }); // already processed
    }
    const result = await applyBillingEvent(evt);
    await runQuery("UPDATE billing_events SET status = ?, tenant_id = ? WHERE razorpay_event_id = ?",
      [result.handled ? 'processed' : 'ignored', result.tenantId || null, eventId]);
    return res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[razorpay webhook] processing error:', err);
    return res.status(500).json({ error: 'Webhook processing failed.' });
  }
});

app.use(express.json({ limit: '8mb' }));
app.use(express.urlencoded({ extended: true, limit: '8mb' }));
app.use(cookieParser());

// [H5] Scope CORS to an explicit allow-list (credentials enabled). Wildcard
// `cors()` reflected any origin AND allowed credentials, which let any website
// drive the API with the user's cookie. With no ALLOWED_ORIGINS configured we
// default to same-origin only (cross-origin browser calls are simply blocked).
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(o => o.trim()).filter(Boolean);
app.use(cors({
  origin: ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS : false,
  credentials: true
}));

// [H5] CSRF defense: verify the Origin/Referer of every state-changing request is
// same-origin (or in the allow-list). Combined with the SameSite=Lax cookie below
// this blocks cross-site requests from riding the user's session. Non-browser
// callers (no Origin/Referer header, e.g. curl/server-to-server) are unaffected.
function verifyCsrfOrigin(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.headers.origin;
  const referer = req.headers.referer;
  const source = origin || referer;
  if (!source) return next(); // not a browser form/fetch; nothing to forge with
  let host;
  try { host = new URL(source).host; } catch { return res.status(403).json({ error: 'Bad request origin.' }); }
  const allowedHosts = new Set([req.headers.host, ...ALLOWED_ORIGINS.map(o => { try { return new URL(o).host; } catch { return o; } })]);
  if (allowedHosts.has(host)) return next();
  return res.status(403).json({ error: 'Cross-site request blocked.' });
}
app.use(verifyCsrfOrigin);

// [C3 FIX] Serve ONLY the dedicated public directory — never the repository root.
// This prevents unauthenticated download of database.db, .env, source files, and backups.
// dotfiles:'deny' returns 403 for any dotfile that slips under public/.
app.use(express.static(path.join(__dirname, 'public'), { dotfiles: 'deny' }));

// Initialize database
initializeDatabase().then(() => {
  console.log('Database initialized successfully.');
}).catch((err) => {
  console.error('Failed to initialize database:', err);
});

// Redirect root to the shell the token's role belongs to (inline-refreshing an
// expired access cookie against the session store first).
app.get('/', async (req, res) => {
  const decoded = await resolvePageAuth(req, res);
  if (!decoded) return res.redirect('/login');
  if (decoded.pending_role_selection) return res.redirect('/select-role');
  return res.redirect(shellForRole(decoded.role_id));
});

// ==========================================
// CLEAN FRONTEND ROUTES
// ==========================================

const pages = [
  { route: '/login', dir: 'login_kinetic_enterprise' },
  { route: '/login-alt', dir: 'elite_performance_gym_management' },
  { route: '/signup', dir: 'signup_kinetic_enterprise' },
  { route: '/forgot-password', dir: 'forgot_password_kinetic_enterprise' },
  { route: '/reset-password', dir: 'reset_password_kinetic_enterprise' },
  { route: '/verify-email', dir: 'verify_email_kinetic_enterprise' },
  { route: '/dashboard', dir: 'dashboard_kinetic_enterprise' },
  { route: '/bi', dir: 'business_intelligence_kinetic_enterprise' },
  { route: '/members', dir: 'member_directory_kinetic_enterprise' },
  { route: '/member-profile', dir: 'member_profile_kinetic_enterprise' },
  { route: '/member-communication', dir: 'member_profile_communication_kinetic_enterprise' },
  { route: '/member-timeline', dir: 'member_timeline_kinetic_enterprise' },
  { route: '/member-qr', dir: 'member_qr_card_kinetic_enterprise' },
  { route: '/add-member', dir: 'add_member_kinetic_enterprise' },
  { route: '/add-member-step-1', dir: 'add_member_step_1_kinetic_enterprise' },
  { route: '/attendance', dir: 'attendance_kinetic_enterprise' },
  { route: '/finance', dir: 'finance_kinetic_enterprise' },
  { route: '/payment-center', dir: 'payment_center_kinetic_enterprise' },
  { route: '/payment-recovery', dir: 'payment_recovery_kinetic_enterprise' },
  { route: '/activity-log', dir: 'activity_log_kinetic_enterprise' },
  { route: '/renew', dir: 'renew_membership_kinetic_enterprise' },
  { route: '/receipt', dir: 'membership_receipt_kinetic_enterprise' },
  { route: '/daily-closing', dir: 'daily_closing_report_kinetic_enterprise' },
  { route: '/marketing', dir: 'marketing_kinetic_enterprise' },
  { route: '/expiry-management', dir: 'expiry_management_kinetic_enterprise' },
  { route: '/retention', dir: 'retention_dashboard_kinetic_enterprise' },
  { route: '/lead-crm', dir: 'lead_crm_kinetic_enterprise' },
  { route: '/settings', dir: 'settings_kinetic_enterprise' },
  // [IDENTITY] Account Security Center (sessions, providers, verification).
  { route: '/security', dir: 'security_center_kinetic_enterprise' },
  { route: '/staff', dir: 'staff_management_kinetic_enterprise' },
  { route: '/tasks', dir: 'task_management_kinetic_enterprise' },
  { route: '/notifications', dir: 'notifications_kinetic_enterprise' },
  { route: '/equipment', dir: 'equipment_inventory_kinetic_enterprise' },
  // [ROLES] Role picker (multi-role accounts) + member shell stub.
  { route: '/select-role', dir: 'select_role_kinetic_enterprise' },
  { route: '/member', dir: 'member_area_kinetic_enterprise' }
];

// Direct page redirects (Phase 2.5 route consolidation)
app.get('/executive-dashboard', (req, res) => res.redirect('/dashboard'));
app.get('/business-dashboard', (req, res) => res.redirect('/dashboard'));

const publicRoutes = ['/login', '/login-alt', '/signup', '/forgot-password', '/reset-password', '/verify-email'];

// NOTE: Premium screens (Analytics / Marketing Center / Activity Log) are NOT
// hard-redirected away anymore. A server-side redirect to /settings made the
// "More → Analytics/Marketing" navigation jump to the wrong page, which read as a
// routing bug. Feature gating, if desired, should be an in-page upsell — not a
// redirect that hijacks navigation. (Supersedes the earlier M8 page redirect.)
pages.forEach(p => {
  app.get(p.route, async (req, res) => {
    if (!publicRoutes.includes(p.route)) {
      // [IDENTITY] Verify the access cookie, silently rotating via the refresh
      // session when it has merely expired — users are not bounced to /login
      // every access-TTL. Hard failures (revoked/expired session) still redirect.
      const decoded = await resolvePageAuth(req, res);
      if (!decoded) return res.redirect('/login');
      // [ROLES] Keep each token inside its own shell (members → /member,
      // pending → /select-role, staff → the existing admin app, unchanged).
      const shellRedirect = shellRedirectFor(decoded, p.route);
      if (shellRedirect) return res.redirect(shellRedirect);
    }

    res.sendFile(path.join(__dirname, p.dir, 'code.html'));
  });
});

// [C3 FIX] Daily-closing print view is the only screen-folder file the UI opens
// directly. Serve it via an explicit authenticated route instead of static root.
app.get('/daily_closing_report_kinetic_enterprise/print.html', async (req, res) => {
  const decoded = await resolvePageAuth(req, res);
  if (!decoded) return res.redirect('/login');
  // [ROLES] Staff-only print view — member/pending tokens go back to their shell.
  const shellRedirect = shellRedirectFor(decoded, '/daily-closing');
  if (shellRedirect) return res.redirect(shellRedirect);
  res.sendFile(path.join(__dirname, 'daily_closing_report_kinetic_enterprise', 'print.html'));
});

// ==========================================
// AUTHENTICATION APIs
// ==========================================

// Login API
app.post('/api/v1/auth/login', authLimiter, async (req, res) => {
  const { email, password, remember } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }

  try {
    // [ROLES] No role JOIN here — the role(s) come from user_roles below, so an
    // identity whose only role lives in user_roles (no legacy primary) still works.
    const user = await getQuery(`SELECT * FROM users WHERE email = ?`, [email]);

    // [SEC] Constant-ish-time auth: always run bcrypt.compare (against a dummy hash
    // when the email is unknown) so response timing can't be used to enumerate which
    // emails are registered. The error message is identical for "no such user" and
    // "wrong password".
    const match = await bcrypt.compare(password, user ? user.password_hash : DUMMY_PW_HASH);
    if (!user || !match) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }

    if (!user.is_active || user.status !== 'active') {
      return res.status(403).json({ error: 'This account has been suspended.' });
    }

    // [AUTH FIX] Only enforce email verification when email delivery is actually
    // configured. Without EMAIL_API_KEY no verification mail can ever be sent, so a
    // hard verify-gate permanently locks out everyone who signs up. When email is
    // unavailable we treat accounts as usable (soft gate) instead of a dead end.
    if (EMAIL_ENABLED && !user.email_verified) {
      return res.status(403).json({ error: 'Please verify your email address before logging in.', verificationRequired: true });
    }

    // Update last login
    await runQuery(`UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?`, [user.id]);

    // [ROLES] Role is decided SERVER-SIDE from user_roles — never from the
    // request. Exactly one role → scoped token straight into that shell.
    // Multiple roles → pending token that can only reach the picker.
    const roles = await getUserRoles(user.id);
    if (roles.length === 0) {
      return res.status(403).json({ error: 'This account has no active access. Please contact your gym.' });
    }

    if (roles.length === 1) {
      // [H5] Cookie hardening (SameSite=Lax + Secure in production) lives in setAuthCookie.
      setAuthCookie(res, signScopedToken(user, roles[0], remember), remember, false);
      return res.json({
        message: 'Authorization successful.',
        redirect: shellForRole(roles[0].role_id),
        user: { email: user.email, role_id: roles[0].role_id },
        roles: rolesForClient(roles)
      });
    }

    setAuthCookie(res, signPendingToken(user, remember), false, true);
    res.json({
      message: 'Select a role to continue.',
      redirect: '/select-role',
      user: { email: user.email },
      roles: rolesForClient(roles)
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Internal system authorization failure.' });
  }
});

app.post('/api/v1/auth/signup', authLimiter, async (req, res) => {
  const { full_name, email, password, phone } = req.body;
  if (!full_name || !email || !password) return res.status(400).json({ error: 'All fields are required.' });
  // [M3] Minimum password policy.
  if (String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(email))) return res.status(400).json({ error: 'Please enter a valid email address.' });
  // [ROLES] Phone is required at registration — it is (with email) the linking
  // key for the future member-claim flow.
  const normPhone = identity.normalizePhone(phone);
  if (!normPhone) return res.status(400).json({ error: 'A valid phone number (10-15 digits) is required.' });

  try {
    const existingUser = await getQuery('SELECT id FROM users WHERE email = ?', [email]);
    if (existingUser) return res.status(400).json({ error: 'Email already exists.' });
    
    const hash = await bcrypt.hash(password, 10);
    const userId = 'u_' + Date.now();
    const vToken = crypto.randomBytes(32).toString('hex');
    const hashedVToken = crypto.createHash('sha256').update(vToken).digest('hex');
    
    const trialStart = new Date().toISOString();
    const trialEnd = new Date(Date.now() + 21 * 24 * 60 * 60 * 1000).toISOString(); // 21 days
    
    const tenantId = 't_' + Date.now() + Math.floor(Math.random() * 1000);
    const gymName = full_name.split(' ')[0] + "'s Gym";
    const subdomain = full_name.toLowerCase().replace(/[^a-z0-9]/g, '') + Math.floor(Math.random() * 1000);
    
    await runQuery(`INSERT INTO tenants (id, gym_name, subdomain, owner_user_id, subscription_plan, trial_start, trial_end, subscription_status) VALUES (?, ?, ?, ?, 'trial', ?, ?, 'trial')`, 
      [tenantId, gymName, subdomain, userId, trialStart, trialEnd]);
    
    // [AUTH FIX] When email delivery is not configured, verification is impossible,
    // so create the owner already-verified — otherwise every signup is a dead end.
    const initialVerified = EMAIL_ENABLED ? 0 : 1;

    // Create owner user
    await runQuery(`INSERT INTO users (id, role_id, tenant_id, email, password_hash, full_name, phone, email_verified, status, verification_token) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
      [userId, 'r1', tenantId, email, hash, full_name, normPhone, initialVerified, hashedVToken]); // r1 = System Owner

    // [ROLES] Mirror the owner role into user_roles (multi-role source of truth).
    await runQuery(`INSERT OR IGNORE INTO user_roles (id, user_id, tenant_id, role_id) VALUES (?, ?, ?, 'r1')`,
      ['ur_' + userId + '_' + tenantId + '_r1', userId, tenantId]);

    // Seed the FULL per-tenant default settings + discount-rule scaffold (not just
    // gym_name/currency) so a new gym's dashboards, reminders, GST and payment
    // toggles all have real values from day one.
    await seedTenantDefaults(tenantId, gymName);

    // No email provider configured → account is usable immediately.
    if (!EMAIL_ENABLED) {
      return res.status(201).json({ message: 'Account created. You can sign in now.', verificationPending: false });
    }

    const emailResult = await emailService.sendVerificationEmail(email, vToken, tenantId, PORT);
    if (!emailResult.success) {
      // [H4] Do NOT strand the user with a dead 502. The account exists; tell the
      // UI verification is pending and offer a resend path instead of "contact support".
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

app.get('/api/v1/auth/verify-email', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).json({ error: 'Missing token' });
  try {
    const hashedToken = crypto.createHash('sha256').update(token).digest('hex');
    const user = await getQuery('SELECT id FROM users WHERE verification_token = ?', [hashedToken]);
    if (!user) return res.status(400).json({ error: 'Invalid or expired token' });
    
    await runQuery(`UPDATE users SET email_verified = 1, verification_token = NULL WHERE id = ?`, [user.id]);
    res.json({ message: 'Email verified successfully.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to verify email.' });
  }
});

// [H4] Resend verification email for an unverified account. Always responds 200
// (does not reveal whether the email exists) and is rate-limited against abuse.
app.post('/api/v1/auth/resend-verification', authLimiter, async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });
  try {
    const user = await getQuery('SELECT id, tenant_id, email_verified FROM users WHERE email = ?', [email]);
    if (user && !user.email_verified) {
      const vToken = crypto.randomBytes(32).toString('hex');
      const hashedVToken = crypto.createHash('sha256').update(vToken).digest('hex');
      await runQuery('UPDATE users SET verification_token = ? WHERE id = ?', [hashedVToken, user.id]);
      await emailService.sendVerificationEmail(email, vToken, user.tenant_id, PORT);
    }
    res.json({ message: 'If that account exists and is unverified, a new verification email has been sent.' });
  } catch (err) {
    console.error('Resend verification error:', err);
    res.status(500).json({ error: 'Failed to resend verification email.' });
  }
});

app.post('/api/v1/auth/forgot-password', authLimiter, async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });
  try {
    const user = await getQuery('SELECT id FROM users WHERE email = ?', [email]);
    if (user) {
      const resetToken = crypto.randomBytes(32).toString('hex');
      const hashedResetToken = crypto.createHash('sha256').update(resetToken).digest('hex');
      const expiry = new Date(Date.now() + 3600000).toISOString(); // 1 hr
      await runQuery('UPDATE users SET reset_token = ?, token_expiry = ? WHERE id = ?', [hashedResetToken, expiry, user.id]);
      
      const emailResult = await emailService.sendPasswordReset(email, resetToken, user.tenant_id, PORT);
      // [SEC] Do NOT surface send success/failure to the caller — a 502 only for
      // existing accounts is an enumeration oracle. Log server-side and always return
      // the same generic response below.
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

app.post('/api/v1/auth/reset-password', authLimiter, async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) return res.status(400).json({ error: 'Token and password required' });
  // [M3] Enforce the same minimum password policy on reset.
  if (String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  try {
    const hashedToken = crypto.createHash('sha256').update(token).digest('hex');
    const user = await getQuery('SELECT id FROM users WHERE reset_token = ? AND token_expiry > CURRENT_TIMESTAMP', [hashedToken]);
    if (!user) return res.status(400).json({ error: 'Invalid or expired token.' });
    
    const hash = await bcrypt.hash(password, 10);
    await runQuery('UPDATE users SET password_hash = ?, reset_token = NULL, token_expiry = NULL WHERE id = ?', [hash, user.id]);
    res.json({ message: 'Password updated successfully.' });
  } catch (err) {
    res.status(500).json({ error: 'Error resetting password.' });
  }
});

// Logout API
// [H8] Actually revoke the token (add its jti to the deny-list) instead of only
// clearing the cookie — a copied/stolen token is now rejected after logout.
app.post('/api/v1/auth/logout', (req, res) => {
  const token = req.cookies.auth_token;
  if (token) {
    try {
      const decoded = verifyToken(token);
      revokeToken(decoded);
    } catch (e) { /* already invalid/expired — nothing to revoke */ }
  }
  res.clearCookie('auth_token');
  res.json({ message: 'Session terminated successfully.' });
});

// [ROLES] Finalize (or switch) the active role for a multi-role account.
// The client only names a (tenant_id, role_id) pair — the pair is re-verified
// against user_roles in the DB before any scoped token is issued, so a client
// cannot grant itself a role it does not hold. The previous token (pending or
// scoped) is revoked: role selection is a token exchange, not a mutation.
app.post('/api/v1/auth/select-role', authLimiter, authenticateToken, async (req, res) => {
  const { tenant_id, role_id } = req.body || {};
  if (!tenant_id || !role_id) return res.status(400).json({ error: 'tenant_id and role_id are required.' });
  try {
    const user = await getQuery(`SELECT * FROM users WHERE id = ?`, [req.user.id]);
    if (!isAccountActive(user)) return res.status(403).json({ error: 'This account has been suspended.' });

    const roles = await getUserRoles(user.id);
    const role = roles.find(r => r.tenant_id === tenant_id && r.role_id === role_id);
    if (!role) return res.status(403).json({ error: 'You do not hold that role.' });

    revokeToken(req.authToken);
    const remember = !!req.user.remember;
    setAuthCookie(res, signScopedToken(user, role, remember), remember, false);
    res.json({
      message: 'Role selected.',
      redirect: shellForRole(role.role_id),
      role: { tenant_id: role.tenant_id, role_id: role.role_id, role_name: role.role_name, gym_name: role.gym_name }
    });
  } catch (err) {
    console.error('Select-role error:', err);
    res.status(500).json({ error: 'Failed to select role.' });
  }
});

// [ROLES] One-time phone backfill for accounts created before phone was
// captured at registration. Add-once: refuses to overwrite an existing phone
// (the linking key must not be silently re-pointable from a session).
app.post('/api/v1/auth/phone', authLimiter, authenticateToken, async (req, res) => {
  const normPhone = identity.normalizePhone(req.body && req.body.phone);
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

// Public auth-config: lets the login page know which providers to show.
app.get('/api/v1/auth/config', (req, res) => {
  res.json({ google: GOOGLE_ENABLED, emailVerification: EMAIL_ENABLED });
});

// ==========================================
// GOOGLE OAUTH (standard account-picker sign-in)
// ==========================================
// Token issuing is shared with the password path (signScopedToken /
// signPendingToken + setAuthCookie) so the two sign-in paths can never diverge
// on role handling.

// Step 1 — redirect to Google's consent screen. prompt=select_account forces the
// familiar Google account picker that standard apps show.
app.get('/api/v1/auth/google', authLimiter, (req, res) => {
  if (!GOOGLE_ENABLED) return res.status(503).json({ error: 'Google sign-in is not configured on this server.' });
  const state = crypto.randomBytes(16).toString('hex');
  res.cookie('g_oauth_state', state, { httpOnly: true, sameSite: 'lax', maxAge: 10 * 60 * 1000, secure: process.env.NODE_ENV === 'production' });
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: `${APP_BASE_URL}/api/v1/auth/google/callback`,
    response_type: 'code',
    scope: 'openid email profile',
    access_type: 'online',
    include_granted_scopes: 'true',
    prompt: 'select_account',
    state
  });
  res.redirect('https://accounts.google.com/o/oauth2/v2/auth?' + params.toString());
});

// Step 2 — handle Google's redirect: verify state, exchange code, find/create the
// user+tenant, issue our own session cookie, then land on the dashboard.
app.get('/api/v1/auth/google/callback', async (req, res) => {
  if (!GOOGLE_ENABLED) return res.redirect('/login');
  const { code, state } = req.query;
  if (!code || !state || state !== req.cookies.g_oauth_state) {
    res.clearCookie('g_oauth_state');
    return res.redirect('/login?error=google_state');
  }
  res.clearCookie('g_oauth_state');
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: String(code),
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: `${APP_BASE_URL}/api/v1/auth/google/callback`,
        grant_type: 'authorization_code'
      })
    });
    const tokens = await tokenRes.json();
    if (!tokens.access_token) return res.redirect('/login?error=google_token');

    const profileRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` }
    });
    const profile = await profileRes.json();
    const email = (profile.email || '').toLowerCase();
    if (!email || profile.email_verified === false) return res.redirect('/login?error=google_email');

    let user = await getQuery(`SELECT * FROM users WHERE email = ?`, [email]);
    if (!user) {
      // First Google sign-in → provision a new tenant + owner (already verified).
      const userId = 'u_' + Date.now();
      const tenantId = 't_' + Date.now() + Math.floor(Math.random() * 1000);
      const fullName = profile.name || email.split('@')[0];
      const gymName = (fullName.split(' ')[0] || 'My') + "'s Gym";
      const subdomain = fullName.toLowerCase().replace(/[^a-z0-9]/g, '') + Math.floor(Math.random() * 1000);
      const trialStart = new Date().toISOString();
      const trialEnd = new Date(Date.now() + 21 * 24 * 60 * 60 * 1000).toISOString();
      const randomPw = await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 10);
      await runQuery(`INSERT INTO tenants (id, gym_name, subdomain, owner_user_id, subscription_plan, trial_start, trial_end, subscription_status) VALUES (?, ?, ?, ?, 'trial', ?, ?, 'trial')`,
        [tenantId, gymName, subdomain, userId, trialStart, trialEnd]);
      await runQuery(`INSERT INTO users (id, role_id, tenant_id, email, password_hash, full_name, email_verified, status) VALUES (?, 'r1', ?, ?, ?, ?, 1, 'active')`,
        [userId, tenantId, email, randomPw, fullName]);
      // [ROLES] Mirror the owner role into user_roles. Google supplies no phone
      // number — these accounts add it later via the one-time /auth/phone backfill.
      await runQuery(`INSERT OR IGNORE INTO user_roles (id, user_id, tenant_id, role_id) VALUES (?, ?, ?, 'r1')`,
        ['ur_' + userId + '_' + tenantId + '_r1', userId, tenantId]);
      await seedTenantDefaults(tenantId, gymName);
      user = await getQuery(`SELECT * FROM users WHERE id = ?`, [userId]);
    }

    if (!user.is_active && user.status !== 'active') return res.redirect('/login?error=suspended');
    await runQuery(`UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?`, [user.id]);

    // [ROLES] Same server-side role decision as the password path.
    const roles = await getUserRoles(user.id);
    if (roles.length === 0) return res.redirect('/login?error=suspended');
    if (roles.length === 1) {
      setAuthCookie(res, signScopedToken(user, roles[0], false), false, false);
      return res.redirect(shellForRole(roles[0].role_id));
    }
    setAuthCookie(res, signPendingToken(user, false), false, true);
    res.redirect('/select-role');
  } catch (err) {
    console.error('Google OAuth callback error:', err);
    res.redirect('/login?error=google');
  }
});

// Session Check API
app.get('/api/v1/auth/session', authenticateToken, async (req, res) => {
  try {
    // id + gym_name ride along so the setup wizard can prefill and key its
    // per-tenant resume draft. Both are the tenant's own data — no leak.
    const tenant = req.user.tenant_id
      ? await getQuery(`SELECT id, gym_name, subscription_plan, trial_start, trial_end, subscription_status, tour_completed, onboarding_completed, tutorial_step FROM tenants WHERE id = ?`, [req.user.tenant_id])
      : null;
    // [ROLES] Every role this identity holds and which tenant it belongs to —
    // fresh from the DB, so the picker/member stub always show server truth.
    const roles = await getUserRoles(req.user.id);
    const userRow = await getQuery(`SELECT phone FROM users WHERE id = ?`, [req.user.id]);
    res.json({
      user: { ...req.user, phone: (userRow && userRow.phone) || null },
      pending_role_selection: !!req.user.pending_role_selection,
      roles: rolesForClient(roles),
      tenant: tenant || { subscription_plan: 'trial', subscription_status: 'trial', tour_completed: 0, onboarding_completed: 0, tutorial_step: 0 }
    });
  } catch (err) {
    res.json({
      user: req.user,
      pending_role_selection: !!req.user.pending_role_selection,
      roles: [],
      tenant: { subscription_plan: 'trial', subscription_status: 'trial', tour_completed: 0, onboarding_completed: 0, tutorial_step: 0 }
    });
  }
});

// Mount APIs with tenant isolation + the fail-closed staff-role gate: a
// member-role (or pending) token is physically rejected with 403 for EVERY
// endpoint in this router — the entire existing admin/tenant API surface.
const apiRouter = require('./routes/api');
app.use('/api/v1', authenticateToken, requireTenant, requireStaffRole, apiRouter);

// [WHATSAPP] Real WhatsApp automation (whatsapp-web.js). Connection management
// lives in its own router but reuses the SAME auth + tenant isolation as the rest
// of the API, so QR/status/connect are manager/admin-only and tenant-scoped.
const whatsappService = require('./services/whatsapp.service');
require('./services/whatsapp.queue'); // wires the service->queue resume hook
const whatsappRouter = require('./routes/whatsapp.routes');
app.use('/api/v1/whatsapp', authenticateToken, requireTenant, requireStaffRole, whatsappRouter);
// Also expose the SAME router at /api/whatsapp so the Android WebView can open
// /api/whatsapp/qr directly (it returns a scannable HTML page) without the /v1
// prefix. Same auth + tenant isolation; the QR is resolved from the logged-in
// manager's session cookie.
app.use('/api/whatsapp', authenticateToken, requireTenant, requireStaffRole, whatsappRouter);

// Restore any gym that already linked WhatsApp so it reconnects WITHOUT a new QR
// after a server restart (LocalAuth session persistence). Non-blocking.
// WHATSAPP_ENABLED=false disables this on hosts that can't run headless Chromium
// (e.g. Render's free tier) so the server never tries to launch a browser there.
if (process.env.WHATSAPP_ENABLED !== 'false') {
  setTimeout(() => {
    try { whatsappService.restorePersistedSessions(); }
    catch (e) { console.error('[whatsapp] session restore error:', e.message); }
  }, 5 * 1000);
} else {
  console.log('[whatsapp] Disabled (WHATSAPP_ENABLED=false) — skipping session restore.');
}

// [M6] Run automation scans (expiry alerts, payment-due tasks, absent-member
// alerts) on a background interval for ALL tenants instead of on every dashboard
// load. Idempotent: each scan checks for an existing alert/task before creating.
const AUTOMATION_INTERVAL_MS = Number(process.env.AUTOMATION_INTERVAL_MS) || 15 * 60 * 1000;
if (apiRouter.runAutomationScansForAllTenants) {
  setTimeout(() => apiRouter.runAutomationScansForAllTenants().catch(e => console.error('[automation] initial scan error:', e.message)), 20 * 1000);
  setInterval(() => apiRouter.runAutomationScansForAllTenants().catch(e => console.error('[automation] scan error:', e.message)), AUTOMATION_INTERVAL_MS).unref();
}

// ==========================================
// [L4] CENTRAL ERROR HANDLER
// ==========================================
// Catch body-parser failures (e.g. malformed JSON, oversized payloads) and any
// error bubbling out of a route so the client gets a clean JSON message instead
// of an Express HTML stack trace. The full error is logged server-side only.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  console.error('[Unhandled error]', req.method, req.originalUrl, '-', err && err.stack ? err.stack : err);
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request payload too large.' });
  }
  if (err && (err.type === 'entity.parse.failed' || err instanceof SyntaxError)) {
    return res.status(400).json({ error: 'Malformed request body.' });
  }
  res.status(err.status || 500).json({ error: 'An unexpected error occurred. Please try again.' });
});

// ==========================================
// START SERVER
// ==========================================
const server = app.listen(PORT, () => {
  console.log(`Gym Flow management server running at http://localhost:${PORT}`);
});

// [WHATSAPP] Graceful shutdown — destroy all WhatsApp/Chromium clients so headless
// browser processes are not orphaned when the server stops.
let shuttingDown = false;
async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[shutdown] ${signal} received — closing WhatsApp clients...`);
  try { await whatsappService.shutdown(); } catch (e) { /* best effort */ }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 8000).unref();
}
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
