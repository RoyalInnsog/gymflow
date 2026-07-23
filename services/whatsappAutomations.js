/**
 * WhatsApp Automation Workers (centralized Cloud API)
 * =============================================================================
 * The four gym-configurable automations. EVERY worker follows the same contract
 * demanded by the spec:
 *
 *   1. First query gym_whatsapp_settings for this gym's toggle.
 *   2. If the toggle is OFF, abort immediately (return { skipped: true }).
 *   3. Otherwise render the (possibly customized) template and dispatch through
 *      the centralized Cloud API.
 *
 * Actual delivery + plan-quota gating + outbox logging is delegated to the
 * `dispatch` function injected from routes/api.js (init()), so there is exactly
 * ONE send path for the whole platform and no circular require.
 *
 *   ── fee_reminder ──  gated in the api.js expiry/payment scan (see runAutomationScans)
 *   ── health_check ──  runHealthCheckins()      absent 3–4 days -> wellness nudge
 *   ── festival     ──  runFestivalGreetings()   calendar date or manual trigger
 *   ── welcome_invoice ── sendWelcomeInvoice()   on member creation + invoice PDF
 * =============================================================================
 */

const { getQuery, runQuery, allQuery } = require('../database');
const cloud = require('./whatsappCloud.service');
const waSettings = require('./whatsappSettings');
const invoicePdf = require('../lib/invoicePdf');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function uid(prefix = 'nt_out') {
  return prefix + require('crypto').randomUUID().replace(/-/g, '');
}

// ── Injected dependencies (wired once at boot from routes/api.js) ────────────
let deps = {
  // async (tenantId, normalizedPhone, message, notificationId, { wait, media }) => { success, ... }
  dispatch: async () => ({ success: false, error: 'dispatch not initialized' }),
  // Public HTTPS base URL the Cloud API can fetch invoice PDFs from.
  publicBaseUrl: () => (process.env.APP_BASE_URL || process.env.RENDER_EXTERNAL_URL || '')
};
function init(injected) { deps = { ...deps, ...injected }; }

// Fixed-date Indian festivals (MM-DD). Movable feasts (Diwali/Holi/Eid) shift each
// year — a couple of known 2026 dates are included; use the manual trigger (or
// update this map yearly) for the rest.
const FESTIVAL_CALENDAR = {
  '01-01': 'New Year',
  '01-14': 'Makar Sankranti / Pongal',
  '01-26': 'Republic Day',
  '03-03': 'Holi',            // 2026
  '08-15': 'Independence Day',
  '10-02': 'Gandhi Jayanti',
  '11-08': 'Diwali',          // 2026
  '12-25': 'Christmas'
};

// ── Shared helpers ───────────────────────────────────────────────────────────

/** Replace {{var}} and {var} placeholders. */
function renderTemplate(body, vars) {
  let msg = String(body == null ? '' : body);
  for (const k in vars) {
    const v = vars[k] == null ? '' : String(vars[k]);
    msg = msg
      .replace(new RegExp('{{\\s*' + k + '\\s*}}', 'g'), v)
      .replace(new RegExp('{\\s*' + k + '\\s*}', 'g'), v);
  }
  return msg;
}

/** Per-gym brand fields pulled from the settings table (with sane defaults). */
async function getBrand(tenantId) {
  const rows = await allQuery(
    `SELECT setting_key, setting_value FROM settings
      WHERE setting_key IN ('gym_name','support_phone','address','currency') AND tenant_id = ?`,
    [tenantId]
  );
  const m = {};
  rows.forEach((r) => { m[r.setting_key] = r.setting_value; });
  let sym = m.currency || '₹';
  // `currency` may be stored as JSON like {"symbol":"₹","code":"INR"}.
  if (sym && sym.trim().startsWith('{')) {
    try { sym = JSON.parse(sym).symbol || '₹'; } catch (e) { sym = '₹'; }
  }
  return {
    gymName: m.gym_name || 'Your Gym',
    phone: m.support_phone || '',
    address: m.address || '',
    currencySymbol: sym || '₹'
  };
}

/**
 * Insert an outbox notification row and dispatch it. Invalid phones are logged as
 * Failed (never silently dropped), matching the rest of the app's outbox.
 * @returns {Promise<{success:boolean, skipped?:boolean, error?:string}>}
 */
async function logAndSend(tenantId, { phone, name, message, source, title, priority = 'Medium', media = null, wait = true }) {
  const normalized = cloud.validateAndNormalizePhone(phone);
  const ntId = uid('nt_out');

  if (!normalized) {
    await runQuery(
      `INSERT INTO notifications (id, tenant_id, type, priority, title, message, is_read, recipient_name, recipient_phone, delivery_status, campaign_source)
       VALUES (?, ?, 'WhatsApp', ?, ?, ?, 1, ?, ?, 'Failed', ?)`,
      [ntId, tenantId, priority, title, message, name || '', phone || '', source]
    );
    return { success: false, error: 'Invalid phone number.' };
  }

  await runQuery(
    `INSERT INTO notifications (id, tenant_id, type, priority, title, message, is_read, recipient_name, recipient_phone, delivery_status, campaign_source)
     VALUES (?, ?, 'WhatsApp', ?, ?, ?, 1, ?, ?, 'Pending', ?)`,
    [ntId, tenantId, priority, title, message, name || '', normalized, source]
  );

  return deps.dispatch(tenantId, normalized, message, ntId, { wait, media });
}

// ── Automation 3: Health Check-in (absent 3–4 consecutive days) ──────────────
async function runHealthCheckins(tenantId) {
  if (!(await waSettings.isFeatureEnabled(tenantId, 'health_check'))) return { skipped: true };

  const template = await waSettings.getTemplate(tenantId, 'health_check');
  const brand = await getBrand(tenantId);

  const members = await allQuery(
    `SELECT m.id, m.full_name, m.phone, m.created_at, MAX(a.check_in) AS last_visit
       FROM members m
       LEFT JOIN attendance a ON m.id = a.member_id
      WHERE m.status = 'Active' AND m.tenant_id = ?
      GROUP BY m.id`,
    [tenantId]
  );

  const now = Date.now();
  let sent = 0;
  for (const m of members) {
    const anchor = m.last_visit || m.created_at;
    if (!anchor) continue;
    const absenceDays = Math.floor((now - new Date(anchor).getTime()) / 86400000);
    // Spec: caring nudge when absent for 3–4 consecutive days.
    if (absenceDays < 3 || absenceDays > 4) continue;

    // Idempotent per absence streak: only one nudge since the anchoring visit.
    const already = await getQuery(
      `SELECT id FROM notifications
        WHERE tenant_id = ? AND campaign_source = 'Auto Health Check-in'
          AND recipient_name = ? AND created_at > ? LIMIT 1`,
      [tenantId, m.full_name, anchor]
    );
    if (already) continue;

    const message = renderTemplate(template, {
      member_name: m.full_name,
      gym_name: brand.gymName,
      days_absent: absenceDays
    });
    const res = await logAndSend(tenantId, {
      phone: m.phone, name: m.full_name, message,
      source: 'Auto Health Check-in', title: 'WhatsApp: Health Check-in', priority: 'Low'
    });
    if (res && res.success !== false) sent++;
    await sleep(400); // gentle pacing
  }
  return { skipped: false, sent };
}

// ── Automation 2: Festival Greetings ─────────────────────────────────────────
async function runFestivalGreetings(tenantId, { force = false, festivalName = null, todayStr = null } = {}) {
  if (!(await waSettings.isFeatureEnabled(tenantId, 'festival_greetings'))) return { skipped: true, reason: 'disabled' };

  const today = todayStr || new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const mmdd = today.slice(5);
  const festival = festivalName || FESTIVAL_CALENDAR[mmdd];
  if (!festival) return { skipped: true, reason: 'no-festival-today' };

  // One broadcast per festival per day per gym (unless an admin forces a resend).
  const markerSource = `Festival Greeting Marker: ${festival} ${today}`;
  if (!force) {
    const marker = await getQuery(
      `SELECT id FROM notifications WHERE tenant_id = ? AND campaign_source = ? LIMIT 1`,
      [tenantId, markerSource]
    );
    if (marker) return { skipped: true, reason: 'already-sent' };
  }

  const template = await waSettings.getTemplate(tenantId, 'festival_greetings');
  const brand = await getBrand(tenantId);

  // Drop the marker up-front so a mid-run restart can't double-broadcast.
  await runQuery(
    `INSERT INTO notifications (id, tenant_id, type, priority, title, message, is_read, delivery_status, campaign_source)
     VALUES (?, ?, 'WhatsApp', 'Low', ?, ?, 1, 'Sent', ?)`,
    [uid('nt_mk'), tenantId, `Festival: ${festival}`, `${festival} greetings broadcast for ${today}.`, markerSource]
  );

  const members = await allQuery(
    `SELECT id, full_name, phone FROM members WHERE status = 'Active' AND tenant_id = ?`,
    [tenantId]
  );

  let sent = 0;
  for (const m of members) {
    const message = renderTemplate(template, {
      member_name: m.full_name,
      gym_name: brand.gymName,
      festival_name: festival
    });
    const res = await logAndSend(tenantId, {
      phone: m.phone, name: m.full_name, message,
      source: `Festival: ${festival}`, title: `WhatsApp: ${festival} Greeting`, priority: 'Low'
    });
    if (res && res.success !== false) sent++;
    await sleep(300);
  }
  return { skipped: false, festival, recipients: members.length, sent };
}

// ── Automation 4: New Member Welcome + Invoice PDF ───────────────────────────
async function sendWelcomeInvoice(tenantId, { memberId }) {
  if (!(await waSettings.isFeatureEnabled(tenantId, 'welcome_invoice'))) return { skipped: true };

  const member = await getQuery(
    `SELECT id, full_name, phone, email, created_at FROM members WHERE id = ? AND tenant_id = ?`,
    [memberId, tenantId]
  );
  if (!member || !member.phone) return { skipped: true, reason: 'no-member-or-phone' };

  // Most-recent invoice for this member (created alongside the membership).
  const invoice = await getQuery(
    `SELECT i.id, i.invoice_number, i.subtotal, i.tax_amount, i.total_amount, i.amount_due, i.status, i.created_at,
            mp.name AS plan_name
       FROM invoices i
       LEFT JOIN memberships ms ON i.membership_id = ms.id
       LEFT JOIN membership_plans mp ON ms.plan_id = mp.id
      WHERE i.member_id = ? AND i.tenant_id = ?
      ORDER BY i.created_at DESC LIMIT 1`,
    [memberId, tenantId]
  );

  const template = await waSettings.getTemplate(tenantId, 'welcome_invoice');
  const brand = await getBrand(tenantId);
  const cur = brand.currencySymbol;
  const total = invoice ? Number(invoice.total_amount || 0) : 0;
  const amountDue = invoice ? Number(invoice.amount_due != null ? invoice.amount_due : invoice.total_amount || 0) : 0;

  const message = renderTemplate(template, {
    member_name: member.full_name,
    gym_name: brand.gymName,
    amount_due: `${cur}${amountDue.toLocaleString('en-IN')}`,
    invoice_number: invoice ? invoice.invoice_number : '',
    plan_name: invoice ? (invoice.plan_name || 'Membership') : 'Membership'
  });

  // Attach the invoice PDF via a signed public link (the Cloud API fetches it).
  let media = null;
  const base = (typeof deps.publicBaseUrl === 'function' ? deps.publicBaseUrl() : deps.publicBaseUrl) || '';
  if (invoice && base && /^https?:\/\//i.test(base)) {
    const token = invoicePdf.signInvoiceToken({ tenant_id: tenantId, invoice_id: invoice.id });
    // No .pdf extension in the URL — the token contains a dot; the payload's
    // `filename` + the route's application/pdf Content-Type name the download.
    const link = `${base.replace(/\/+$/, '')}/whatsapp/invoice/${token}`;
    media = { link, filename: `Invoice-${invoice.invoice_number || member.id}.pdf`, caption: message };
  }

  return logAndSend(tenantId, {
    phone: member.phone, name: member.full_name, message,
    source: 'Auto Welcome Onboarding', title: 'WhatsApp: Welcome + Invoice',
    priority: 'Medium', media, wait: false
  });
}

/** Convenience: run the recurring per-tenant workers (called by the scan loop). */
async function runForTenant(tenantId) {
  const out = {};
  try { out.health = await runHealthCheckins(tenantId); }
  catch (e) { out.health = { error: e.message }; }
  try { out.festival = await runFestivalGreetings(tenantId); }
  catch (e) { out.festival = { error: e.message }; }
  return out;
}

module.exports = {
  init,
  renderTemplate,
  getBrand,
  logAndSend,
  runHealthCheckins,
  runFestivalGreetings,
  sendWelcomeInvoice,
  runForTenant,
  FESTIVAL_CALENDAR
};
