const express = require('express');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const path = require('path');
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
  // connect-src must include every CDN origin the pages load: once the service
  // worker intercepts those requests, its fetch() is checked against connect-src
  // (not style/script/font-src) — missing origins fail with ERR_FAILED on every
  // SW-controlled load, which renders the whole app unstyled.
  `connect-src 'self' ${RZP} https://lumberjack.razorpay.com https://fonts.googleapis.com https://fonts.gstatic.com https://cdn.jsdelivr.net https://cdnjs.cloudflare.com http://localhost:3000 https://desktop-s69biti.tail66553b.ts.net`,
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
const { authenticateToken, requireTenant, requireStaffRole, shellRedirectFor, shellForRole } = identity;


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

// ── [WHATSAPP-CLOUD] Public webhook + signed invoice PDF ─────────────────────
// Mounted BEFORE the JSON body parser (like the Razorpay webhook) so the webhook
// receiver gets the RAW body for X-Hub-Signature-256 verification, and BEFORE
// the auth mounts so Meta / the Cloud API can reach them un-authenticated.
const whatsappCloudController = require('./controllers/whatsappCloud.controller');
const invoicePdf = require('./lib/invoicePdf');

// Meta subscription handshake + inbound message / delivery-status callbacks.
app.get('/api/whatsapp/webhook', whatsappCloudController.webhookVerify);
app.post('/api/whatsapp/webhook', express.raw({ type: '*/*', limit: '2mb' }), whatsappCloudController.webhookReceive);

// The centralized Cloud API fetches the welcome invoice PDF from this signed,
// short-lived, un-authenticated link (it acts as our "cloud storage" media URL).
app.get('/whatsapp/invoice/:token', async (req, res) => {
  try {
    const parsed = invoicePdf.verifyInvoiceToken(req.params.token);
    if (!parsed) return res.status(403).type('text/plain').send('Invalid or expired invoice link.');
    const { tenant_id, invoice_id } = parsed;

    const inv = await getQuery(
      `SELECT i.*, m.full_name, m.phone, m.email, mp.name AS plan_name
         FROM invoices i
         LEFT JOIN members m ON i.member_id = m.id
         LEFT JOIN memberships ms ON i.membership_id = ms.id
         LEFT JOIN membership_plans mp ON ms.plan_id = mp.id
        WHERE i.id = ? AND i.tenant_id = ?`,
      [invoice_id, tenant_id]
    );
    if (!inv) return res.status(404).type('text/plain').send('Invoice not found.');

    const rows = await allQuery(
      `SELECT setting_key, setting_value FROM settings
        WHERE setting_key IN ('gym_name','support_phone','address','currency','gst_percent') AND tenant_id = ?`,
      [tenant_id]
    );
    const b = {}; rows.forEach((r) => { b[r.setting_key] = r.setting_value; });
    let cur = b.currency || '₹';
    if (cur && String(cur).trim().startsWith('{')) { try { cur = JSON.parse(cur).symbol || '₹'; } catch (e) { cur = '₹'; } }

    const pdf = invoicePdf.generateInvoicePdf({
      gymName: b.gym_name || 'Your Gym', gymAddress: b.address || '', gymPhone: b.support_phone || '',
      invoiceNumber: inv.invoice_number, dateStr: String(inv.created_at || '').slice(0, 10), status: inv.status,
      member: { name: inv.full_name, phone: inv.phone, email: inv.email, id: inv.member_id },
      planName: inv.plan_name || 'Membership', currency: cur,
      subtotal: inv.subtotal, tax: inv.tax_amount, taxPercent: b.gst_percent || null,
      total: inv.total_amount, amountDue: inv.amount_due != null ? inv.amount_due : inv.total_amount
    });

    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `inline; filename="Invoice-${inv.invoice_number || invoice_id}.pdf"`);
    res.set('Cache-Control', 'private, max-age=600');
    res.send(pdf);
  } catch (e) {
    console.error('[whatsapp invoice pdf]', e && e.message);
    res.status(500).type('text/plain').send('Could not render invoice.');
  }
});

app.use(express.json({ limit: '8mb' }));
app.use(express.urlencoded({ extended: true, limit: '8mb' }));
app.use(cookieParser());

// [H5] Scope CORS to an explicit allow-list (credentials enabled). Wildcard
// `cors()` reflected any origin AND allowed credentials, which let any website
// drive the API with the user's cookie. With no ALLOWED_ORIGINS configured we
// default to same-origin only (cross-origin browser calls are simply blocked).
// [CAPACITOR] In bundled APK mode the WebView origin is cross-origin to the
// API backend, so the Capacitor origins must be in the allowlist.
const CAPACITOR_ORIGINS = ['capacitor://localhost', 'https://localhost'];
const ALLOWED_ORIGINS = [...CAPACITOR_ORIGINS, ...(process.env.ALLOWED_ORIGINS || '').split(',').map(o => o.trim()).filter(Boolean)];
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

// [IDEMPOTENCY] Honor the offline outbox's Idempotency-Key so a mutation whose
// success response was lost (dropped connection) is NOT re-applied on retry.
// Placed after auth in each mount so req.tenant_id scopes the key. The first
// success is cached and replayed byte-for-byte on any later retry of that key.
// Transient 5xx are never cached — those SHOULD retry. Read methods bypass.
async function idempotency(req, res, next) {
  const key = req.headers['idempotency-key'];
  if (!key || ['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const scopedKey = `${req.tenant_id || 'anon'}:${String(key).slice(0, 200)}`;
  try {
    const seen = await getQuery('SELECT status, response FROM idempotency_keys WHERE key = ?', [scopedKey]);
    if (seen) {
      try { return res.status(seen.status).json(JSON.parse(seen.response)); }
      catch { return res.status(seen.status).end(); }
    }
  } catch (e) { return next(); } // storage hiccup: fail open rather than block writes
  const origJson = res.json.bind(res);
  res.json = (body) => {
    if (res.statusCode < 500) {
      runQuery('INSERT OR IGNORE INTO idempotency_keys (key, tenant_id, status, response) VALUES (?, ?, ?, ?)',
        [scopedKey, req.tenant_id || null, res.statusCode, JSON.stringify(body)]).catch(() => {});
    }
    return origJson(body);
  };
  next();
}

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
  // [ORG] Invitation acceptance + member-claim confirmation + org switcher.
  { route: '/join', dir: 'join_kinetic_enterprise' },
  { route: '/staff', dir: 'staff_management_kinetic_enterprise' },
  { route: '/tasks', dir: 'task_management_kinetic_enterprise' },
  { route: '/notifications', dir: 'notifications_kinetic_enterprise' },
  { route: '/equipment', dir: 'equipment_inventory_kinetic_enterprise' },
  // [ROLES] Role picker (multi-role accounts) + member shell stub.
  { route: '/select-role', dir: 'select_role_kinetic_enterprise' },
  { route: '/member', dir: 'member_area_kinetic_enterprise' },
  // [IDENTITY] Phone verification and platform role screens
  { route: '/verify-phone', dir: 'verify_phone' },
  { route: '/member-coming-soon', dir: 'member_coming_soon' }
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
// [IDENTITY] AUTHENTICATION APIs
// ==========================================
// Every /api/v1/auth/* endpoint now lives in routes/auth.js on top of the
// lib/identity services. Mounted WITHOUT the tenant/staff gates — identity is
// account-level, not tenant-scoped. (The tenant API below keeps those gates.)
app.use("/api/v1/auth", require("./routes/auth"));

// [ORG] Organization & Identity Graph API. Account-level (auth only) like /auth —
// members and pending invitees must reach /org/context, invitations and claims.
// Admin routes inside the router add requireTenant + a permission guard.
app.use('/api/v1/org', authenticateToken, require('./routes/org'));

// [U1] Member self-service API — the r5 mirror of the staff surface below.
// Mounted BEFORE the '/api/v1' staff router so /api/v1/member/* resolves here;
// requireMemberRole is fail-closed (staff/pending tokens get 403), and member
// tokens remain physically unable to reach any staff endpoint.
app.use('/api/v1/member', authenticateToken, requireTenant, identity.requireMemberRole, idempotency, require('./routes/member'));

// [GPS Attendance] Geofenced member checkin endpoint. Mounted before the staff-only router
// so it is accessible by both members (r5) and staff (r1-r4) via their authenticated token.
app.post('/api/v1/attendance/checkin', authenticateToken, requireTenant, idempotency, async (req, res) => {
  const { latitude, longitude, timestamp, isMocked, mocked } = req.body;
  let memberId = req.body.member_id;

  try {
    // 1. Resolve member context. If it's a member (r5), force their own linked member ID.
    if (req.user.role_id === 'r5') {
      const link = await getQuery(
        `SELECT member_id FROM user_roles
         WHERE user_id = ? AND tenant_id = ? AND role_id = 'r5'
           AND (status IS NULL OR status = 'active')`,
        [req.user.id, req.tenant_id]
      );
      if (!link || !link.member_id) {
        return res.status(403).json({ error: 'No active membership linked to this account.', code: 'NOT_LINKED' });
      }
      memberId = link.member_id;
    }

    if (!memberId) {
      return res.status(400).json({ error: 'Member ID is required.' });
    }

    // 2. Fetch member & check expiry
    const member = await getQuery(`SELECT * FROM members WHERE id = ? AND tenant_id = ?`, [memberId, req.tenant_id]);
    if (!member) {
      return res.status(404).json({ error: 'Member not found.' });
    }
    if (member.status === 'Expired') {
      return res.status(403).json({ error: 'Access card restricted. Membership has expired.' });
    }

    // 3. Validation and spoofing checks
    if (latitude === undefined || longitude === undefined || !timestamp) {
      return res.status(400).json({ error: 'Latitude, longitude, and timestamp are required.' });
    }

    if (isMocked || mocked) {
      return res.status(400).json({ error: 'Mock location/GPS spoofing detected.' });
    }

    const clientTime = Number(timestamp);
    const serverTime = Date.now();
    const bufferSeconds = 60;
    if (Math.abs(serverTime - clientTime) > bufferSeconds * 1000) {
      return res.status(400).json({ error: 'Spoofing/Replay check failed. Time synchronization mismatch.' });
    }

    // 4. Geofencing calculations
    const gym = await getQuery(`SELECT latitude, longitude, geofence_radius, gym_name FROM tenants WHERE id = ?`, [req.tenant_id]);
    if (!gym || gym.latitude === null || gym.longitude === null) {
      return res.status(500).json({ error: 'Gym geofence location is not configured.' });
    }

    function haversineDistance(lat1, lon1, lat2, lon2) {
      const R = 6371e3; // Earth's radius in meters
      const phi1 = (lat1 * Math.PI) / 180;
      const phi2 = (lat2 * Math.PI) / 180;
      const deltaPhi = ((lat2 - lat1) * Math.PI) / 180;
      const deltaLambda = ((lon2 - lon1) * Math.PI) / 180;
      const a = Math.sin(deltaPhi / 2) * Math.sin(deltaPhi / 2) +
                Math.cos(phi1) * Math.cos(phi2) *
                Math.sin(deltaLambda / 2) * Math.sin(deltaLambda / 2);
      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      return R * c;
    }

    const distance = haversineDistance(Number(latitude), Number(longitude), Number(gym.latitude), Number(gym.longitude));
    const radius = Number(gym.geofence_radius || 50);

    if (distance > radius) {
      return res.status(400).json({
        error: 'Geofence check failed. You must be physically inside the gym to check in.',
        distance: Math.round(distance),
        radius: radius
      });
    }

    // 5. Database state update
    const checkInId = 'a' + Date.now();
    await runQuery(`
      INSERT INTO attendance (id, tenant_id, member_id, check_in, access_method)
      VALUES (?, ?, ?, datetime('now', 'localtime'), 'GPS')
    `, [checkInId, req.tenant_id, member.id]);

    res.json({
      message: `Checked in successfully at ${gym.gym_name}. Welcome, ${member.full_name}!`,
      distance: Math.round(distance),
      check_in_time: new Date().toISOString()
    });

  } catch (err) {
    console.error('[GPS Checkin Error]:', err);
    res.status(500).json({ error: 'Internal validation failure.' });
  }
});

// [Health Connect Sync] Bulk synchronize client biometrics from Google Health Connect
app.post('/api/v1/health/sync', authenticateToken, requireTenant, async (req, res) => {
  const { biometrics } = req.body;
  if (!Array.isArray(biometrics)) {
    return res.status(400).json({ error: 'Biometrics array is required.' });
  }

  let memberId = req.body.member_id;

  try {
    // 1. Resolve member ID if calling user is a member (r5)
    if (req.user.role_id === 'r5') {
      const link = await getQuery(
        `SELECT member_id FROM user_roles
         WHERE user_id = ? AND tenant_id = ? AND role_id = 'r5'
           AND (status IS NULL OR status = 'active')`,
        [req.user.id, req.tenant_id]
      );
      if (!link || !link.member_id) {
        return res.status(403).json({ error: 'No active membership linked to this account.', code: 'NOT_LINKED' });
      }
      memberId = link.member_id;
    }

    if (!memberId) {
      return res.status(400).json({ error: 'Member ID is required.' });
    }

    // [SEC] Ownership guard — staff (r1-r4) may pass an arbitrary member_id, so
    // confirm it belongs to THIS tenant before writing (prevents cross-tenant IDOR).
    const ownSync = await getQuery('SELECT id FROM members WHERE id = ? AND tenant_id = ?', [memberId, req.tenant_id]);
    if (!ownSync) {
      return res.status(404).json({ error: 'Member not found.' });
    }

    // Group metric items by calendar date
    const dailyData = {};

    biometrics.forEach(item => {
      const ts = Number(item.timestamp) || Date.now();
      const dateStr = new Date(ts).toISOString().slice(0, 10); // YYYY-MM-DD
      
      if (!dailyData[dateStr]) {
        dailyData[dateStr] = {
          steps: null,
          sleep_minutes: null,
          heart_rate: [],
          calories: null,
          weight_kg: null,
          systolic: null,
          diastolic: null
        };
      }

      const day = dailyData[dateStr];
      const val = Number(item.value);

      if (isNaN(val)) return;

      switch (item.type) {
        case 'steps':
          day.steps = (day.steps || 0) + val;
          break;
        case 'calories':
          day.calories = (day.calories || 0) + val;
          break;
        case 'sleep':
          day.sleep_minutes = (day.sleep_minutes || 0) + val;
          break;
        case 'heart_rate':
          day.heart_rate.push(val);
          break;
        case 'weight':
          day.weight_kg = val;
          break;
        case 'blood_pressure':
          if (typeof item.value === 'string' && item.value.includes('/')) {
            const parts = item.value.split('/');
            day.systolic = Number(parts[0]) || null;
            day.diastolic = Number(parts[1]) || null;
          } else if (item.systolic && item.diastolic) {
            day.systolic = Number(item.systolic);
            day.diastolic = Number(item.diastolic);
          }
          break;
      }
    });

    // Upsert aggregated records into health_logs
    for (const logDate of Object.keys(dailyData)) {
      const data = dailyData[logDate];
      const avgHr = data.heart_rate.length 
        ? data.heart_rate.reduce((a, b) => a + b, 0) / data.heart_rate.length 
        : null;

      // Select existing log for this date to preserve other manually entered values (like water_ml)
      const existing = await getQuery(
        `SELECT * FROM health_logs WHERE tenant_id = ? AND member_id = ? AND log_date = ?`,
        [req.tenant_id, memberId, logDate]
      );

      if (existing) {
        const steps = data.steps !== null ? data.steps : (existing.steps || 0);
        const sleep_minutes = data.sleep_minutes !== null ? data.sleep_minutes : (existing.sleep_minutes || 0);
        const calories = data.calories !== null ? data.calories : (existing.calories || 0);
        const weight = data.weight_kg !== null ? data.weight_kg : existing.weight_kg;
        const hr = avgHr !== null ? avgHr : existing.heart_rate;
        const sys = data.systolic !== null ? data.systolic : existing.systolic;
        const dia = data.diastolic !== null ? data.diastolic : existing.diastolic;

        await runQuery(
          `UPDATE health_logs 
           SET steps = ?, sleep_minutes = ?, calories = ?, weight_kg = ?, heart_rate = ?, systolic = ?, diastolic = ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [steps, sleep_minutes, calories, weight, hr, sys, dia, existing.id]
        );
      } else {
        const steps = data.steps !== null ? data.steps : 0;
        const sleep_minutes = data.sleep_minutes !== null ? data.sleep_minutes : 0;
        const calories = data.calories !== null ? data.calories : 0;
        const weight = data.weight_kg;
        const hr = avgHr;
        const sys = data.systolic;
        const dia = data.diastolic;
        const id = 'hl_' + crypto.randomBytes(8).toString('hex');

        await runQuery(
          `INSERT INTO health_logs (id, tenant_id, member_id, log_date, steps, sleep_minutes, calories, weight_kg, heart_rate, systolic, diastolic, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
          [id, req.tenant_id, memberId, logDate, steps, sleep_minutes, calories, weight, hr, sys, dia]
        );
      }
    }

    res.json({ success: true, message: `Synchronized ${Object.keys(dailyData).length} days of metrics successfully.` });

  } catch (err) {
    console.error('[Health Sync Error]:', err);
    res.status(500).json({ error: 'Failed to synchronize biometrics.' });
  }
});

// [Health Connect Bind] Set permanently linked state in the DB
app.post('/api/v1/health/bind', authenticateToken, requireTenant, async (req, res) => {
  let memberId = req.body.member_id;

  try {
    if (req.user.role_id === 'r5') {
      const link = await getQuery(
        `SELECT member_id FROM user_roles
         WHERE user_id = ? AND tenant_id = ? AND role_id = 'r5'
           AND (status IS NULL OR status = 'active')`,
        [req.user.id, req.tenant_id]
      );
      if (!link || !link.member_id) {
        return res.status(403).json({ error: 'No active membership linked to this account.', code: 'NOT_LINKED' });
      }
      memberId = link.member_id;
    }

    if (!memberId) {
      return res.status(400).json({ error: 'Member ID is required.' });
    }

    // [SEC] Ownership guard — confirm the member belongs to THIS tenant, and
    // scope the UPDATE by tenant_id so staff can't flip another gym's member flag.
    const ownBind = await getQuery('SELECT id FROM members WHERE id = ? AND tenant_id = ?', [memberId, req.tenant_id]);
    if (!ownBind) {
      return res.status(404).json({ error: 'Member not found.' });
    }

    await runQuery(
      `UPDATE members SET health_connect_linked = 1 WHERE id = ? AND tenant_id = ?`,
      [memberId, req.tenant_id]
    );

    res.json({ success: true, message: 'Google Health Connect linked permanently.' });
  } catch (err) {
    console.error('[Health Bind Error]:', err);
    res.status(500).json({ error: 'Failed to bind Health Connect state.' });
  }
});

// Mount APIs with tenant isolation + the fail-closed staff-role gate: a
// member-role (or pending) token is physically rejected with 403 for EVERY
// endpoint in this router — the entire existing admin/tenant API surface.
const apiRouter = require('./routes/api');
app.use('/api/v1', authenticateToken, requireTenant, requireStaffRole, idempotency, apiRouter);

// [WHATSAPP-CLOUD] Centralized WhatsApp Cloud API. There is no per-gym QR/session
// anymore — the platform sends from ONE Gymflow-managed number and each gym only
// controls its own automation toggles. Same auth + tenant isolation as the rest
// of the API; mutations require the settings:write permission (owner/manager).
const whatsappRouter = require('./routes/whatsappCloud.routes');
app.use('/api/v1/whatsapp', authenticateToken, requireTenant, requireStaffRole, whatsappRouter);
// Also exposed at /api/whatsapp (no /v1 prefix) for the Android WebView.
app.use('/api/whatsapp', authenticateToken, requireTenant, requireStaffRole, whatsappRouter);

// [M6] Run automation scans (expiry alerts, payment-due tasks, absent-member
// alerts) on a background interval for ALL tenants instead of on every dashboard
// load. Idempotent: each scan checks for an existing alert/task before creating.
const AUTOMATION_INTERVAL_MS = Number(process.env.AUTOMATION_INTERVAL_MS) || 15 * 60 * 1000;
if (apiRouter.runAutomationScansForAllTenants) {
  // Self-scheduling loop (NOT setInterval): a scan run that outlasts the interval
  // must never overlap itself. The force=true all-tenants scan bypasses the
  // per-tenant throttle, and the dedup is a non-atomic check-then-insert, so an
  // overlapping run would double-send member-facing WhatsApp reminders. The next
  // tick is scheduled only after the current run fully settles.
  // ponytail: in-process guard; add a DB advisory lock if this ever runs multi-instance.
  let scanRunning = false;
  const scanLoop = async () => {
    if (!scanRunning) {
      scanRunning = true;
      try { await apiRouter.runAutomationScansForAllTenants(); }
      catch (e) { console.error('[automation] scan error:', e.message); }
      finally { scanRunning = false; }
    }
    setTimeout(scanLoop, AUTOMATION_INTERVAL_MS).unref();
  };
  setTimeout(scanLoop, 20 * 1000).unref();
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
const server = app.listen(PORT, '0.0.0.0', () => {
  const os = require('os');
  const nets = os.networkInterfaces();
  let lanIP = 'localhost';
  for (const iface of Object.values(nets)) {
    for (const cfg of iface) {
      if (cfg.family === 'IPv4' && !cfg.internal) { lanIP = cfg.address; break; }
    }
    if (lanIP !== 'localhost') break;
  }
  console.log(`Gym Flow management server running at:`);
  console.log(`  ➜  Local:   http://localhost:${PORT}`);
  console.log(`  ➜  Network: http://${lanIP}:${PORT}`);
});

// Graceful shutdown — close the HTTP server cleanly. The centralized WhatsApp
// Cloud API is stateless (plain HTTPS requests), so there are no per-gym browser
// sessions to tear down anymore.
let shuttingDown = false;
async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[shutdown] ${signal} received — closing server...`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 8000).unref();
}
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
