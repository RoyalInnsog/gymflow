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

// [C4 FIX] JWT secret strictly loaded from environment variable.
const JWT_SECRET = process.env.JWT_SECRET;
const WEAK_SECRETS = ['password', 'secret', 'changeme', 'default', '123456', 'kinetic-dev-secret-do-not-use-in-production'];
// [AUTH FIX] Email verification is only meaningful when a provider is configured.
const EMAIL_ENABLED = !!process.env.EMAIL_API_KEY;

// [Google OAuth] Standard OAuth2 (authorization code) sign-in. Enabled only when
// credentials are configured; the login page hides the button otherwise.
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_ENABLED = !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);
const APP_BASE_URL = (process.env.APP_BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, '');

if (!JWT_SECRET || JWT_SECRET.length < 32 || WEAK_SECRETS.includes(JWT_SECRET.toLowerCase())) {
  console.error('FATAL: JWT_SECRET environment variable is either missing, less than 32 characters, or insecurely weak.');
  console.error('Please configure a strong random string (>= 32 chars) for JWT_SECRET in your environment.');
  process.exit(1);
}


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

// [H6] Dependency-free in-memory rate limiter for auth/sensitive endpoints. Caps
// brute-force attempts per IP+route within a sliding window. (For multi-instance
// deployments swap the Map for a shared store such as Redis.)
function rateLimit({ windowMs, max, message }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (now - v.start > windowMs) hits.delete(k);
  }, windowMs).unref();
  return (req, res, next) => {
    const key = `${req.ip}:${req.path}`;
    const now = Date.now();
    let rec = hits.get(key);
    if (!rec || now - rec.start > windowMs) { rec = { start: now, count: 0 }; hits.set(key, rec); }
    if (rec.count >= max) {
      const retryAfter = Math.ceil((rec.start + windowMs - now) / 1000);
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({ error: message || 'Too many requests. Please try again later.' });
    }
    rec.count++;
    // Only failed/blocked attempts count toward the limit — a successful login or
    // valid reset must not lock out legitimate users who share an office/NAT IP.
    res.on('finish', () => { if (res.statusCode < 400 && rec.count > 0) rec.count--; });
    next();
  };
}
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: 'Too many attempts. Please wait a few minutes and try again.' });

// [H8] Token revocation list (jti -> expiry epoch ms). Logout / suspension add the
// token's jti here so authenticateToken rejects it even though the JWT is still
// cryptographically valid. Entries self-expire when the underlying token would.
const revokedTokens = new Map();
function revokeToken(payload) {
  if (payload && payload.jti) revokedTokens.set(payload.jti, (payload.exp || 0) * 1000 || Date.now() + 30 * 24 * 60 * 60 * 1000);
}
setInterval(() => {
  const now = Date.now();
  for (const [jti, exp] of revokedTokens) if (exp < now) revokedTokens.delete(jti);
}, 60 * 60 * 1000).unref();

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

// Authentication middleware
function authenticateToken(req, res, next) {
  const token = req.cookies.auth_token;
  if (!token) {
    return res.status(401).json({ error: 'Unauthorized access. Session token required.' });
  }

  jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] }, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid or expired session token.' });
    }
    // [H8] Reject tokens that have been revoked (logout / suspension).
    if (user && user.jti && revokedTokens.has(user.jti)) {
      return res.status(401).json({ error: 'Session has been revoked. Please log in again.' });
    }
    req.user = user;
    req.authToken = user; // expose decoded payload (incl. jti) for logout revocation
    next();
  });
}

// Tenant isolation middleware
function requireTenant(req, res, next) {
  if (!req.user || !req.user.tenant_id) {
    return res.status(403).json({ error: 'Tenant isolation violation. Valid tenant required.' });
  }
  req.tenant_id = req.user.tenant_id;
  next();
}

// Redirect root to dashboard
app.get('/', (req, res) => {
  const token = req.cookies.auth_token;
  if (token) {
    res.redirect('/dashboard');
  } else {
    res.redirect('/login');
  }
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
  { route: '/staff', dir: 'staff_management_kinetic_enterprise' },
  { route: '/tasks', dir: 'task_management_kinetic_enterprise' },
  { route: '/notifications', dir: 'notifications_kinetic_enterprise' },
  { route: '/equipment', dir: 'equipment_inventory_kinetic_enterprise' }
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
      const token = req.cookies.auth_token;
      if (!token) {
        return res.redirect('/login');
      }
      try {
        jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
      } catch (err) {
        res.clearCookie('auth_token');
        return res.redirect('/login');
      }
    }

    res.sendFile(path.join(__dirname, p.dir, 'code.html'));
  });
});

// [C3 FIX] Daily-closing print view is the only screen-folder file the UI opens
// directly. Serve it via an explicit authenticated route instead of static root.
app.get('/daily_closing_report_kinetic_enterprise/print.html', (req, res) => {
  const token = req.cookies.auth_token;
  if (!token) return res.redirect('/login');
  try {
    jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
  } catch (err) {
    res.clearCookie('auth_token');
    return res.redirect('/login');
  }
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
    const user = await getQuery(`SELECT users.*, roles.permissions FROM users JOIN roles ON users.role_id = roles.id WHERE email = ?`, [email]);
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
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

    const token = jwt.sign(
      { id: user.id, email: user.email, role_id: user.role_id, tenant_id: user.tenant_id, permissions: JSON.parse(user.permissions), jti: crypto.randomBytes(16).toString('hex') },
      JWT_SECRET,
      { expiresIn: remember ? '30d' : '8h' }
    );

    // [H5] Cookie hardening: SameSite=Lax stops the cookie riding cross-site
    // requests (CSRF), and Secure is enabled automatically in production (HTTPS).
    res.cookie('auth_token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: remember ? 30 * 24 * 60 * 60 * 1000 : 8 * 60 * 60 * 1000
    });

    res.json({ message: 'Authorization successful.', user: { email: user.email, role_id: user.role_id } });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Internal system authorization failure.' });
  }
});

app.post('/api/v1/auth/signup', authLimiter, async (req, res) => {
  const { full_name, email, password } = req.body;
  if (!full_name || !email || !password) return res.status(400).json({ error: 'All fields are required.' });
  // [M3] Minimum password policy.
  if (String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(email))) return res.status(400).json({ error: 'Please enter a valid email address.' });

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
    await runQuery(`INSERT INTO users (id, role_id, tenant_id, email, password_hash, full_name, email_verified, status, verification_token) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
      [userId, 'r1', tenantId, email, hash, full_name, initialVerified, hashedVToken]); // r1 = System Owner

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
      if (!emailResult.success) {
        return res.status(502).json({ error: 'Failed to dispatch password reset email.' });
      }
    }
    res.json({ message: 'Reset link sent if email exists.' });
  } catch (err) {
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
      const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
      revokeToken(decoded);
    } catch (e) { /* already invalid/expired — nothing to revoke */ }
  }
  res.clearCookie('auth_token');
  res.json({ message: 'Session terminated successfully.' });
});

// Public auth-config: lets the login page know which providers to show.
app.get('/api/v1/auth/config', (req, res) => {
  res.json({ google: GOOGLE_ENABLED, emailVerification: EMAIL_ENABLED });
});

// ==========================================
// GOOGLE OAUTH (standard account-picker sign-in)
// ==========================================
function issueAuthCookie(res, user) {
  const token = jwt.sign(
    { id: user.id, email: user.email, role_id: user.role_id, tenant_id: user.tenant_id, permissions: JSON.parse(user.permissions || '[]'), jti: crypto.randomBytes(16).toString('hex') },
    JWT_SECRET,
    { expiresIn: '8h' }
  );
  res.cookie('auth_token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 8 * 60 * 60 * 1000
  });
}

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

    let user = await getQuery(`SELECT users.*, roles.permissions FROM users JOIN roles ON users.role_id = roles.id WHERE email = ?`, [email]);
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
      await seedTenantDefaults(tenantId, gymName);
      user = await getQuery(`SELECT users.*, roles.permissions FROM users JOIN roles ON users.role_id = roles.id WHERE id = ?`, [userId]);
    }

    if (!user.is_active && user.status !== 'active') return res.redirect('/login?error=suspended');
    await runQuery(`UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?`, [user.id]);
    issueAuthCookie(res, user);
    res.redirect('/dashboard');
  } catch (err) {
    console.error('Google OAuth callback error:', err);
    res.redirect('/login?error=google');
  }
});

// Session Check API
app.get('/api/v1/auth/session', authenticateToken, async (req, res) => {
  try {
    const tenant = await getQuery(`SELECT subscription_plan, trial_start, trial_end, subscription_status, tour_completed, onboarding_completed FROM tenants WHERE id = ?`, [req.user.tenant_id]);
    res.json({ 
      user: req.user,
      tenant: tenant || { subscription_plan: 'trial', subscription_status: 'trial', tour_completed: 0, onboarding_completed: 0 }
    });
  } catch (err) {
    res.json({ 
      user: req.user,
      tenant: { subscription_plan: 'trial', subscription_status: 'trial', tour_completed: 0, onboarding_completed: 0 }
    });
  }
});

// Mount APIs with tenant isolation
const apiRouter = require('./routes/api');
app.use('/api/v1', authenticateToken, requireTenant, apiRouter);

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
app.listen(PORT, () => {
  console.log(`Gym Flow management server running at http://localhost:${PORT}`);
});
