const express = require('express');
const router = express.Router();
const { getQuery, runQuery, allQuery } = require('../database');
const { PLANS, isRazorpayConfigured, createOrder, verifyPaymentSignature, fetchOrder, cancelSubscription } = require('../lib/razorpay');
const { getTodayString, getLastNDaysString, getNextNDaysString } = require('../lib/dateUtils');
const engine = require('../lib/membershipEngine');
// [WHATSAPP-CLOUD] The centralized Meta WhatsApp Cloud API is now the SINGLE
// sender for the whole platform (replaces the old per-tenant whatsapp-web.js
// service + outbound queue). `waSettings` holds each gym's automation toggles;
// `waAutomations` runs the gym-configurable workers.
const whatsappCloud = require('../services/whatsappCloud.service');
const waSettings = require('../services/whatsappSettings');
const waAutomations = require('../services/whatsappAutomations');

// ==========================================
// VALIDATION & SANITIZATION HELPERS
// ==========================================
const escapeLike = (str) => String(str || '').replace(/[%_\\]/g, c => '\\' + c);
const isValidDate = (str) => /^\d{4}-\d{2}-\d{2}$/.test(String(str || ''));
const toInteger = (val, fallback = null) => { const num = parseInt(val, 10); return isNaN(num) ? fallback : num; };
const toNumeric = (val, fallback = 0) => { const num = parseFloat(val); return isNaN(num) ? fallback : num; };
const whitelist = (val, allowed, fallback) => allowed.includes(val) ? val : fallback;

// ==========================================
// [H2] ROLE-BASED ACCESS CONTROL (RBAC)
// ==========================================
// The JWT carries the user's role permissions (set at login from roles.permissions).
// Owners hold the wildcard "all" and always pass. Sub-staff (Manager/Trainer/Admin)
// only pass when they hold one of the required permission strings. authenticateToken
// + requireTenant already ran (mounted in server.js), so req.user is trusted here.
// Apply to admin/owner-only mutations so a low-privilege staff token can't escalate.
function authorize(...required) {
  return (req, res, next) => {
    const perms = (req.user && Array.isArray(req.user.permissions)) ? req.user.permissions : [];
    if (perms.includes('all')) return next();
    if (required.length === 0 || required.some(p => perms.includes(p))) return next();
    return res.status(403).json({ error: 'You do not have permission to perform this action.' });
  };
}

// ==========================================
// [TIER GATE] SUBSCRIPTION FEATURE GATING (writes only)
// ==========================================
// Blocks a MUTATION when the tenant's plan lacks a capability, returning a
// clear upgrade hint (never a hard block on GET reads — read-gating turned
// premium pages into broken shells; see the checkSubscription note). The
// client mirrors this with nav hiding + an upsell overlay (planGate.js), so
// this is the authoritative server backstop against deep-linked writes.
function requireFeature(flag, label) {
  return (req, res, next) => {
    const plan = (req.subscription && req.subscription.subscription_plan) || 'trial';
    const limits = PLAN_LIMITS[plan] || PLAN_LIMITS.trial;
    if (limits[flag]) return next();
    return res.status(403).json({
      error: `${label} is available on the Pro plan. Upgrade in Settings to unlock it.`,
      upgradeRequired: true,
      feature: flag
    });
  };
}

// ==========================================
// [GST-CONFIG] TAX CONFIGURATION (settings-driven, never hardcoded)
// ==========================================
// GST is configured per-tenant in Settings → Business Rules → Tax Settings.
// settings.gst_enabled = 'true'|'false', settings.gst_percent = number.
// When disabled (or unset) tax is 0 and total = base price. This is the single
// source of truth for tax on memberships, renewals, invoices and receipts.
async function getTaxConfig(tenantId) {
  const rows = await allQuery(
    `SELECT setting_key, setting_value FROM settings
      WHERE setting_key IN ('gst_enabled','gst_percent') AND tenant_id = ?`,
    [tenantId]
  );
  const map = {};
  rows.forEach(r => { map[r.setting_key] = r.setting_value; });
  const enabled = map.gst_enabled === 'true';
  const percent = enabled ? (parseFloat(map.gst_percent) || 0) : 0;
  return { enabled, percent };
}

// Round to 2 decimals to avoid floating point dust in money values.
function computeTax(subtotal, taxCfg) {
  if (!taxCfg || !taxCfg.enabled || !taxCfg.percent) return 0;
  return Math.round(subtotal * (taxCfg.percent / 100) * 100) / 100;
}

// [SEC] Resolve the renewal discount SERVER-SIDE from the tenant's configured
// discount_rules (the 'loyalty' rule, matching the renew screen's own logic).
// Returns a rupee amount clamped to [0, planPrice]; a disabled/missing rule yields
// 0. The client may DISPLAY a discount but must never define the amount that is
// actually charged — trusting a client `discount_amount` let a crafted request zero
// out any renewal regardless of whether a rule was enabled.
async function resolveRenewalDiscount(tenantId, planPrice) {
  const price = Number(planPrice) || 0;
  if (price <= 0) return 0;
  const rule = await getQuery(
    `SELECT enabled, discount_type, amount, percent
       FROM discount_rules WHERE tenant_id = ? AND id = 'loyalty'`,
    [tenantId]
  );
  if (!rule || !rule.enabled) return 0;
  let discount = rule.discount_type === 'percent'
    ? Math.round(price * (Number(rule.percent) || 0) / 100 * 100) / 100
    : (Number(rule.amount) || 0);
  if (!Number.isFinite(discount) || discount < 0) discount = 0;
  if (discount > price) discount = price;
  return discount;
}

// ==========================================
// [M4/L7] COLLISION-SAFE IDS & MONOTONIC INVOICE NUMBERS
// ==========================================
// Bare `Date.now()` ids collide when two requests land in the same millisecond
// (bulk import, concurrent renewals). `uid()` appends base36 time + random so
// ids are unique even under concurrency. Use it for every PK we mint.
function uid(prefix = '') {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// Per-tenant, per-year monotonic invoice counter. The old `RCPT-<year>-<random
// 100-999>` scheme had only 900 values/year/tenant and collided often. This uses
// an atomic upsert (INSERT ... ON CONFLICT ... RETURNING) on a single shared
// sqlite connection, so each call returns a distinct, gap-free sequence value.
async function nextInvoiceNumber(tenantId, prefix = 'RCPT') {
  const year = new Date().getFullYear();
  const row = await getQuery(
    `INSERT INTO invoice_sequences (tenant_id, year, last_value)
       VALUES (?, ?, 1)
     ON CONFLICT(tenant_id, year) DO UPDATE SET last_value = last_value + 1
     RETURNING last_value`,
    [tenantId, year]
  );
  const seq = (row && row.last_value) || 1;
  return `${prefix}-${year}-${String(seq).padStart(5, '0')}`;
}

// ==========================================
// SAAS PLAN LIMITS & MIDDLEWARE
// ==========================================
// [BILLING] Plan tiers/prices/allowances now live in the single-source catalog
// (lib/billingPlans.js). PLAN_LIMITS is the flat, back-compat view keyed by BOTH
// canonical (basic/pro/enterprise_low/enterprise_high) and legacy (trial/
// enterprise) names, so every existing PLAN_LIMITS[plan] lookup still resolves.
const billing = require('../lib/billingState');
const { PLAN_LIMITS, PLAN_PRICES, PURCHASABLE_PLANS, resolvePlan, getPlan } = require('../lib/billingPlans');

async function checkSubscription(req, res, next) {
  try {
    // Exclude signup and login endpoints from tenant check (actually they are handled in server.js, but let's be safe)
    if (!req.tenant_id) return next();

    const tenant = await getQuery("SELECT subscription_plan, trial_end, subscription_status FROM tenants WHERE id = ? ", [req.tenant_id]);
    if (!tenant) {
      return res.status(404).json({ error: "Tenant not found." });
    }

    req.subscription = tenant;

    const plan = req.subscription.subscription_plan || 'trial';
    const limits = PLAN_LIMITS[plan];

    const now = new Date();
    const isTrialExpired = plan === 'trial' && now > new Date(tenant.trial_end);
    // Endpoints an EXPIRED tenant must STILL be able to reach so they can convert —
    // start checkout, confirm a payment, submit a UPI reference, or downgrade. The
    // old gate exempted only /subscription/change, which silently 403'd the actual
    // checkout endpoints and locked expired trials out of ever paying us.
    const BILLING_PATHS = new Set([
      '/subscription/change',
      '/subscription/create-order',
      '/subscription/verify-payment',
      '/subscription/submit-upi-payment'
    ]);
    if (isTrialExpired) {
      // A lapsed PRO trial falls back to the free Basic plan (the catalog model)
      // instead of locking the tenant out: the gym keeps operating, premium
      // features gate via PLAN_LIMITS.basic, and no blocking "trial expired"
      // popup is shown. Self-healing on the next request rather than a cron, so
      // a tenant is never stuck in the expired state.
      await billing.downgradeToBasic(req.tenant_id, 'Free trial expired — moved to the free Basic plan.');
      req.subscription = { ...tenant, subscription_plan: 'basic', subscription_status: 'active' };
    } else if (tenant.subscription_status === 'expired') {
      if (req.method !== 'GET' && !BILLING_PATHS.has(req.path)) {
        return res.status(403).json({
          error: "Your subscription has expired. Please renew your plan in settings to restore access.",
          trialExpired: true
        });
      }
    }

    // NOTE: Feature read-gating for Analytics / Marketing / Activity Log was removed
    // — hard 403s turned those screens into broken shells (and the page redirect was
    // a navigation bug). The Business Intelligence, Marketing Center and Activity Log
    // pages now render real data for every plan. Re-introduce gating, if needed, as an
    // in-page upsell rather than a blocking 403. The trial-expiry WRITE block above
    // still protects against using the product after the trial lapses.

    next();
  } catch (err) {
    console.error("Subscription validation error:", err);
    res.status(500).json({ error: "Internal subscription verification failure." });
  }
}

router.use(checkSubscription);













// Activity Logger Utility
async function logActivity(userId, tenantId, action, table, recordId, details = {}) {
  try {
    const id = 'act_' + Date.now() + Math.floor(Math.random() * 1000);
    // [FIX] 7 columns require 7 placeholders — the old INSERT had only 6, so every
    // activity-log write threw "7 values for 6 columns" and was silently swallowed.
    await runQuery(`
      INSERT INTO activity_logs (id, tenant_id, user_id, action, table_name, record_id, new_values)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [id, tenantId || null, userId || 'u1', action, table, recordId, JSON.stringify(details)]);
  } catch (err) {
    console.error('Failed to log activity:', err.message);
  }
}


// Template Resolver Helper
// [FIX] Templates are seeded globally (tenant_id IS NULL) as defaults; a tenant may
// override one by inserting its own row. Prefer the tenant's own template, then fall
// back to the global default — otherwise every real tenant got an empty message body.
async function resolveTemplate(templateId, data, tenantId) {
  const lookup = (id) => getQuery(
    "SELECT message_body FROM templates WHERE id = ? AND (tenant_id = ? OR tenant_id IS NULL) ORDER BY (tenant_id IS NULL) ASC LIMIT 1",
    [id, tenantId]);
  let tpl = await lookup(templateId);
  if (!tpl) {
    let fallbackId = templateId;
    if (templateId === 'whatsapp_expiry') fallbackId = 'expiry';
    else if (templateId === 'whatsapp_expiry_reminder') fallbackId = 'expiry';
    else if (templateId === 'whatsapp_retention') fallbackId = 'inactive';
    else if (templateId === 'whatsapp_payment_due') fallbackId = 'payment';
    tpl = await lookup(fallbackId);
  }
  if (!tpl) return '';
  let msg = tpl.message_body;
  const settings = await allQuery("SELECT * FROM settings WHERE tenant_id = ? ", [tenantId]);
  const sMap = {};
  settings.forEach((s) => sMap[s.setting_key] = s.setting_value);
  const brand = sMap['gym_name'] || 'Kinetic Enterprise';
  const supportPhone = sMap['support_phone'] || '';
  const supportEmail = sMap['support_email'] || '';
  const gymAddress = sMap['address'] || '';

  msg = msg.replace(/{{gym_name}}/g, brand).replace(/{gym_name}/g, brand);
  msg = msg.replace(/{{support_phone}}/g, supportPhone).replace(/{support_phone}/g, supportPhone);
  msg = msg.replace(/{{support_email}}/g, supportEmail).replace(/{support_email}/g, supportEmail);
  msg = msg.replace(/{{address}}/g, gymAddress).replace(/{address}/g, gymAddress);

  for (let k in data) {
    msg = msg.replace(new RegExp('{{' + k + '}}', 'g'), data[k] || '')
             .replace(new RegExp('{' + k + '}', 'g'), data[k] || '');
  }
  return msg;
}

// [WHATSAPP-CLOUD] Dispatch a message through the centralized Meta WhatsApp Cloud
// API. There is no per-gym connection anymore: the platform is either configured
// (ready for everyone) or not. On success the outbox row is marked Delivered and
// the Cloud message id (wamid) stored; on failure it is marked Failed with a clear
// reason (never a fake "Delivered").
//   opts.wait  = true  -> await the terminal result (single, user-initiated sends)
//   opts.wait  = false -> fire-and-forget (cron + bulk); the row updates async
//   opts.media = { link, filename, caption } -> send a document (e.g. invoice PDF)
async function dispatchWhatsApp(tenantId, normalizedPhone, message, notificationId, { wait = false, media = null } = {}) {
  // [BILLING] Ledger-based quota enforced across every send path (manual, bulk,
  // cron). remaining = max(0, allowance - used) + extra_credits. Basic has no
  // WhatsApp at all; a paid gym at zero remaining is blocked with an out-of-credits
  // signal the dashboard turns into the exhaustion modal.
  try {
    const state = await billing.getBillingState(tenantId);
    if (!state.limits.allowWhatsApp || (state.allowance + state.extraCredits) <= 0) {
      await runQuery(
        `UPDATE notifications SET delivery_status = 'Failed', failure_reason = ? WHERE id = ? AND tenant_id = ?`,
        ['WhatsApp messaging is a Pro feature. Upgrade your plan to enable it.', notificationId, tenantId]);
      return { success: false, error: 'WhatsApp messaging is not available on your plan.' };
    }
    if (state.remaining <= 0) {
      await runQuery(
        `UPDATE notifications SET delivery_status = 'Failed', failure_reason = ? WHERE id = ? AND tenant_id = ?`,
        ['Out of WhatsApp credits. Add wallet credits or upgrade your plan.', notificationId, tenantId]);
      return { success: false, error: 'Out of WhatsApp credits. Add wallet credits or upgrade your plan.', outOfCredits: true };
    }
  } catch (e) { /* quota lookup failed — fall through to the configuration check */ }

  if (!whatsappCloud.isConfigured()) {
    await runQuery(
      `UPDATE notifications SET delivery_status = 'Failed', failure_reason = ? WHERE id = ? AND tenant_id = ?`,
      ['WhatsApp service is not configured on the platform yet.', notificationId, tenantId]
    );
    return { success: false, error: 'WhatsApp service is not configured on the platform.' };
  }

  // Perform the real send and write the terminal delivery state to the outbox row.
  const doSend = async () => {
    const result = (media && media.link)
      ? await whatsappCloud.sendDocument(normalizedPhone, media.link, media.filename, media.caption || message)
      : await whatsappCloud.sendText(normalizedPhone, message);
    if (result.success) {
      await runQuery(
        `UPDATE notifications SET delivery_status = 'Delivered', provider_message_id = ?, failure_reason = NULL WHERE id = ? AND tenant_id = ?`,
        [result.messageId || null, notificationId, tenantId]);
      // [BILLING] Consume one message from the ledger (allowance first, then a
      // purchased top-up credit). Best-effort — never fail a delivered send on it.
      try { await billing.consumeWhatsAppCredit(tenantId, 1); } catch (e) { /* ledger best-effort */ }
    } else {
      await runQuery(
        `UPDATE notifications SET delivery_status = 'Failed', failure_reason = ? WHERE id = ? AND tenant_id = ?`,
        [result.error || 'Send failed.', notificationId, tenantId]);
    }
    return result;
  };

  if (wait) {
    const r = await doSend();
    return { success: r.success, messageId: r.messageId, error: r.error };
  }
  // Fire-and-forget: return immediately; the row updates when the send settles.
  doSend().catch((e) => console.error('[whatsapp-cloud] async send error:', e && e.message));
  return { success: true, queued: true };
}

// [WHATSAPP-CLOUD] Give the automation workers the single dispatch path (plan
// gating + outbox logging live here) and the public base URL for invoice PDFs.
waAutomations.init({
  dispatch: dispatchWhatsApp,
  publicBaseUrl: () => process.env.APP_BASE_URL || process.env.RENDER_EXTERNAL_URL || ''
});

// [M6] Per-tenant throttle (the old single global `lastScanTime` let one tenant's
// scan suppress every other tenant's scan for 10s — automations silently skipped).
const lastScanByTenant = new Map();
async function runAutomationScans(tenantId, force = false) {
  const now = Date.now();
  const last = lastScanByTenant.get(tenantId) || 0;
  if (!force && now - last < 10000) {
    return; // Throttle scans to every 10 seconds per tenant
  }
  lastScanByTenant.set(tenantId, now);

  // [WHATSAPP-CLOUD] The "Fee Reminder" automation toggle gates every outbound
  // WhatsApp fee/expiry/payment message for this gym. Internal admin alerts and
  // follow-up tasks are ALWAYS created (they're not WhatsApp); only the member-
  // facing WhatsApp send is skipped when the gym has fee reminders switched off.
  const feeReminderOn = await waSettings.isFeatureEnabled(tenantId, 'fee_reminder');

  try {
    // 1. Membership Expiry Scan
    const activeMemberships = await allQuery(`
      SELECT ms.id as membership_id, ms.member_id, ms.end_date, m.full_name, m.phone 
      FROM memberships ms
      JOIN members m ON ms.member_id = m.id
      WHERE ms.status = 'Active'
     AND ms.tenant_id = ? `, [tenantId]);

    const todayForScan = getTodayString();

    for (const ms of activeMemberships) {
      const daysLeft = engine.remainingDays(ms.end_date, todayForScan);

      if (daysLeft < 0) {
        // Expired membership: update status
        await runQuery(`UPDATE memberships SET status = 'Expired' WHERE id = ? AND tenant_id = ? `, [ms.membership_id, tenantId]);
        await runQuery(`UPDATE members SET status = 'Expired' WHERE id = ? AND tenant_id = ? `, [ms.member_id, tenantId]);

        // Insert admin notification if not exists
        const alertExists = await getQuery(`SELECT id FROM notifications WHERE type = 'Membership' AND title = 'Membership Expired' AND message LIKE ? ESCAPE '\\' AND tenant_id = ? `, [`%${escapeLike(ms.member_id)}%`, tenantId]);
        if (!alertExists) {
          const ntId = 'nt' + Date.now() + Math.floor(Math.random() * 1000);
          await runQuery(`
            INSERT INTO notifications (id, tenant_id, type, priority, title, message, is_read)
            VALUES (?, ?, 'Membership', 'Critical', 'Membership Expired', ?, 0)
          `, [ntId, tenantId, `Membership for ${ms.full_name} (${ms.member_id}) expired on ${ms.end_date}.`]);

          // Automatically log WhatsApp outbox alert (only when Fee Reminders are ON)
          if (feeReminderOn) {
          const whatsappMsg = await resolveTemplate('whatsapp_expiry', { member_name: ms.full_name, end_date: ms.end_date }, tenantId);
          const normalizedPhone = whatsappCloud.validateAndNormalizePhone(ms.phone);
          const ntIdOutbox = 'nt_out' + Date.now() + Math.floor(Math.random() * 1000);

          if (!normalizedPhone) {
            await runQuery(`
              INSERT INTO notifications (id, tenant_id, type, priority, title, message, is_read, recipient_name, recipient_phone, delivery_status, campaign_source)
              VALUES (?, ?, 'Membership', 'Critical', 'WhatsApp: Membership Expired', ?, 1, ?, ?, 'Failed', 'Auto Expiry Reminder')
            `, [ntIdOutbox, tenantId, whatsappMsg, ms.full_name, ms.phone || '']);
          } else {
            await runQuery(`
              INSERT INTO notifications (id, tenant_id, type, priority, title, message, is_read, recipient_name, recipient_phone, delivery_status, campaign_source)
              VALUES (?, ?, 'Membership', 'Critical', 'WhatsApp: Membership Expired', ?, 1, ?, ?, 'Pending', 'Auto Expiry Reminder')
            `, [ntIdOutbox, tenantId, whatsappMsg, ms.full_name, normalizedPhone]);
            await dispatchWhatsApp(tenantId, normalizedPhone, whatsappMsg, ntIdOutbox);
          }
          }
        }

        // Insert task if not exists
        const taskExists = await getQuery(`SELECT id FROM tasks WHERE title LIKE ? ESCAPE '\\' AND status = 'Pending' AND tenant_id = ? `, [`%${escapeLike(ms.full_name)}%`, tenantId]);
        if (!taskExists) {
          const tId = 't' + Date.now() + Math.floor(Math.random() * 1000);
          await runQuery(`
            INSERT INTO tasks (id, tenant_id, title, detail, priority, due_date, status)
            VALUES (?, ?, ?, ?, 'High', datetime('now', '+1 day'), 'Pending')
          `, [tId, tenantId, `Renew Membership: ${ms.full_name}`, `Membership expired on ${ms.end_date}. Contact at ${ms.phone} to renew.`]);
        }
      } else if (daysLeft === 7 || daysLeft === 3 || daysLeft === 1) {
        let priority = 'Medium';
        let title = '';
        let taskPriority = 'Medium';

        if (daysLeft === 7) {
          priority = 'Medium';
          title = 'Membership Expiry in 7 Days';
          taskPriority = 'Medium';
        } else if (daysLeft === 3) {
          priority = 'High';
          title = 'Membership Expiry in 3 Days';
          taskPriority = 'High';
        } else if (daysLeft === 1) {
          priority = 'Critical';
          title = 'Membership Expiry Tomorrow';
          taskPriority = 'High';
        }

        // Check alert
        const alertExists = await getQuery(`SELECT id FROM notifications WHERE type = 'Membership' AND title = ? AND message LIKE ? ESCAPE '\\' AND tenant_id = ? `, [title, `%${escapeLike(ms.member_id)}%`, tenantId]);
        if (!alertExists) {
          const ntId = 'nt' + Date.now() + Math.floor(Math.random() * 1000);
          await runQuery(`
            INSERT INTO notifications (id, tenant_id, type, priority, title, message, is_read)
            VALUES (?, ?, 'Membership', ?, ?, ?, 0)
          `, [ntId, tenantId, priority, title, `Membership for ${ms.full_name} (${ms.member_id}) will expire on ${ms.end_date}.`]);

          // Automatically log WhatsApp outbox reminder (only when Fee Reminders are ON)
          if (feeReminderOn) {
          const whatsappMsg = await resolveTemplate('whatsapp_expiry_reminder', { member_name: ms.full_name, days_left: daysLeft, end_date: ms.end_date }, tenantId);
          const normalizedPhone = whatsappCloud.validateAndNormalizePhone(ms.phone);
          const ntIdOutbox = 'nt_out' + Date.now() + Math.floor(Math.random() * 1000);

          if (!normalizedPhone) {
            await runQuery(`
              INSERT INTO notifications (id, tenant_id, type, priority, title, message, is_read, recipient_name, recipient_phone, delivery_status, campaign_source)
              VALUES (?, ?, 'Membership', ?, ?, ?, 1, ?, ?, 'Failed', 'Auto Expiry Reminder')
            `, [ntIdOutbox, tenantId, priority, `WhatsApp: Expiry ${daysLeft}d`, whatsappMsg, ms.full_name, ms.phone || '']);
          } else {
            await runQuery(`
              INSERT INTO notifications (id, tenant_id, type, priority, title, message, is_read, recipient_name, recipient_phone, delivery_status, campaign_source)
              VALUES (?, ?, 'Membership', ?, ?, ?, 1, ?, ?, 'Pending', 'Auto Expiry Reminder')
            `, [ntIdOutbox, tenantId, priority, `WhatsApp: Expiry ${daysLeft}d`, whatsappMsg, ms.full_name, normalizedPhone]);
            await dispatchWhatsApp(tenantId, normalizedPhone, whatsappMsg, ntIdOutbox);
          }
          }
        }

        // Check task
        const taskTitle = `Follow up: ${ms.full_name} (${daysLeft} days to expiry)`;
        const taskExists = await getQuery(`SELECT id FROM tasks WHERE title = ? AND status = 'Pending' AND tenant_id = ? `, [taskTitle, tenantId]);
        if (!taskExists) {
          const tId = 't' + Date.now() + Math.floor(Math.random() * 1000);
          await runQuery(`
            INSERT INTO tasks (id, tenant_id, title, detail, priority, due_date, status)
            VALUES (?, ?, ?, ?, ?, datetime('now', '+1 day'), 'Pending')
          `, [tId, tenantId, taskTitle, `Membership expiring on ${ms.end_date}. Call ${ms.phone}.`, taskPriority]);
        }
      }
    }

    // 2. Inactive Members Scan
    const activeMembers = await allQuery(`
      SELECT m.id, m.full_name, m.phone, m.created_at, MAX(a.check_in) as last_visit
      FROM members m
      LEFT JOIN attendance a ON m.id = a.member_id
      WHERE m.status = 'Active'
       AND m.tenant_id = ? GROUP BY m.id
    `, [tenantId]);

    for (const m of activeMembers) {
      let absenceDays = 0;
      if (m.last_visit) {
        const lastVisitDate = new Date(m.last_visit);
        absenceDays = Math.floor((new Date() - lastVisitDate) / (1000 * 60 * 60 * 24));
      } else {
        const joinDate = new Date(m.created_at);
        absenceDays = Math.floor((new Date() - joinDate) / (1000 * 60 * 60 * 24));
      }

      if (absenceDays < 0) absenceDays = 0;

      let threshold = 0;
      let priority = '';
      let title = '';
      let taskPriority = '';

      if (absenceDays >= 30) {
        threshold = 30;
        priority = 'Critical';
        title = 'Critical Absence (30+ Days)';
        taskPriority = 'High';
      } else if (absenceDays >= 20) {
        threshold = 20;
        priority = 'High';
        title = 'High Priority Absence (20+ Days)';
        taskPriority = 'High';
      } else if (absenceDays >= 10) {
        threshold = 10;
        priority = 'Medium';
        title = 'Warning Absence (10+ Days)';
        taskPriority = 'Medium';
      } else if (absenceDays >= 5) {
        threshold = 5;
        priority = 'Low';
        title = 'Absence Notice (5+ Days)';
        taskPriority = 'Low';
      }

      if (threshold > 0) {
        const lastVisitCheck = m.last_visit || m.created_at;
        const alertExists = await getQuery(`SELECT id FROM notifications WHERE type = 'Attendance' AND title = ? AND message LIKE ? ESCAPE '\\' AND created_at > ? AND tenant_id = ? `, [title, `%${escapeLike(m.id)}%`, lastVisitCheck, tenantId]);

        if (!alertExists) {
          const ntId = 'nt' + Date.now() + Math.floor(Math.random() * 1000);
          await runQuery(`
            INSERT INTO notifications (id, tenant_id, type, priority, title, message, is_read)
            VALUES (?, ?, 'Attendance', ?, ?, ?, 0)
          `, [ntId, tenantId, priority, title, `${m.full_name} (${m.id}) has been absent for ${absenceDays} days. Last visit: ${m.last_visit || 'Never'}.`]);

          // Automatically log WhatsApp outbox warning
          const whatsappMsg = await resolveTemplate('whatsapp_retention', { member_name: m.full_name, absence_days: absenceDays }, tenantId);
          const normalizedPhone = whatsappCloud.validateAndNormalizePhone(m.phone);
          const ntIdOutbox = 'nt_out' + Date.now() + Math.floor(Math.random() * 1000);
          
          if (!normalizedPhone) {
            await runQuery(`
              INSERT INTO notifications (id, tenant_id, type, priority, title, message, is_read, recipient_name, recipient_phone, delivery_status, campaign_source)
              VALUES (?, ?, 'Attendance', ?, ?, ?, 1, ?, ?, 'Failed', 'Auto Absence Recovery')
            `, [ntIdOutbox, tenantId, priority, `WhatsApp: Absent ${threshold}d`, whatsappMsg, m.full_name, m.phone || '']);
          } else {
            await runQuery(`
              INSERT INTO notifications (id, tenant_id, type, priority, title, message, is_read, recipient_name, recipient_phone, delivery_status, campaign_source)
              VALUES (?, ?, 'Attendance', ?, ?, ?, 1, ?, ?, 'Pending', 'Auto Absence Recovery')
            `, [ntIdOutbox, tenantId, priority, `WhatsApp: Absent ${threshold}d`, whatsappMsg, m.full_name, normalizedPhone]);
            await dispatchWhatsApp(tenantId, normalizedPhone, whatsappMsg, ntIdOutbox);
          }
        }

        const taskTitle = `Retention Call: ${m.full_name} (${threshold}+ Days Absent)`;
        const taskExists = await getQuery(`SELECT id FROM tasks WHERE title = ? AND status = 'Pending' AND tenant_id = ? `, [taskTitle, tenantId]);
        if (!taskExists) {
          const tId = 't' + Date.now() + Math.floor(Math.random() * 1000);
          await runQuery(`
            INSERT INTO tasks (id, tenant_id, title, detail, priority, due_date, status)
            VALUES (?, ?, ?, ?, ?, datetime('now', '+1 day'), 'Pending')
          `, [tId, tenantId, taskTitle, `Member absent for ${absenceDays} days. Contact at ${m.phone}.`, taskPriority]);
        }
      }
    }

    // 3. Overdue Payments Scan
    const unpaidInvoices = await allQuery(`
      SELECT i.id as invoice_id, i.invoice_number, i.total_amount, i.created_at, m.id as member_id, m.full_name, m.phone 
      FROM invoices i
      JOIN members m ON i.member_id = m.id
      WHERE i.status = 'Unpaid'
     AND i.tenant_id = ? `, [tenantId]);

    for (const inv of unpaidInvoices) {
      const createdDate = new Date(inv.created_at);
      const daysSince = Math.floor((new Date() - createdDate) / (1000 * 60 * 60 * 24));

      if (daysSince >= 1) {
        const alertTitle = 'Overdue Payment';
        const alertExists = await getQuery(`SELECT id FROM notifications WHERE type = 'Payments' AND title = ? AND message LIKE ? ESCAPE '\\' AND tenant_id = ? `, [alertTitle, `%Invoice #${escapeLike(inv.invoice_number)}%`, tenantId]);

        if (!alertExists) {
          const ntId = 'nt' + Date.now() + Math.floor(Math.random() * 1000);
          await runQuery(`
            INSERT INTO notifications (id, tenant_id, type, priority, title, message, is_read)
            VALUES (?, ?, 'Payments', 'High', 'Overdue Payment', ?, 0)
          `, [ntId, tenantId, `Payment of ₹${inv.total_amount} is overdue from ${inv.full_name} (${inv.member_id}) for Invoice #${inv.invoice_number}.`]);

          // Automatically log WhatsApp outbox overdue warning (only when Fee Reminders are ON)
          if (feeReminderOn) {
          const whatsappMsg = await resolveTemplate('whatsapp_payment_due', { member_name: inv.full_name, amount: inv.total_amount, invoice_number: inv.invoice_number }, tenantId);
          const normalizedPhone = whatsappCloud.validateAndNormalizePhone(inv.phone);
          const ntIdOutbox = 'nt_out' + Date.now() + Math.floor(Math.random() * 1000);

          if (!normalizedPhone) {
            await runQuery(`
              INSERT INTO notifications (id, tenant_id, type, priority, title, message, is_read, recipient_name, recipient_phone, delivery_status, campaign_source)
              VALUES (?, ?, 'Payments', 'High', 'WhatsApp: Overdue Payment', ?, 1, ?, ?, 'Failed', 'Auto Payment Collection')
            `, [ntIdOutbox, tenantId, whatsappMsg, inv.full_name, inv.phone || '']);
          } else {
            await runQuery(`
              INSERT INTO notifications (id, tenant_id, type, priority, title, message, is_read, recipient_name, recipient_phone, delivery_status, campaign_source)
              VALUES (?, ?, 'Payments', 'High', 'WhatsApp: Overdue Payment', ?, 1, ?, ?, 'Pending', 'Auto Payment Collection')
            `, [ntIdOutbox, tenantId, whatsappMsg, inv.full_name, normalizedPhone]);
            await dispatchWhatsApp(tenantId, normalizedPhone, whatsappMsg, ntIdOutbox);
          }
          }
        }

        const taskTitle = `Collect Payment: ${inv.full_name} (Invoice #${inv.invoice_number})`;
        const taskExists = await getQuery(`SELECT id FROM tasks WHERE title = ? AND status = 'Pending' AND tenant_id = ? `, [taskTitle, tenantId]);
        if (!taskExists) {
          const tId = 't' + Date.now() + Math.floor(Math.random() * 1000);
          await runQuery(`
            INSERT INTO tasks (id, tenant_id, title, detail, priority, due_date, status)
            VALUES (?, ?, ?, ?, ?, datetime('now', '+2 days'), 'Pending')
          `, [tId, tenantId, taskTitle, `Unpaid invoice of ₹${inv.total_amount}. Contact at ${inv.phone} to collect.`, 'High']);
        }
      }
    }

    // 4. [WHATSAPP-CLOUD] Gym-configurable automations. Each worker independently
    // checks its own toggle in gym_whatsapp_settings and aborts if OFF:
    //   • Health Check-in  — caring nudge when a member is absent 3–4 days
    //   • Festival Greetings — broadcast on a calendar festival date
    await waAutomations.runForTenant(tenantId);
  } catch (err) {
    console.error('Automation Scan Error:', err);
  }
}










// ==========================================
// [GEOFENCE] GPS COMPLIANCE ATTENDANCE
// ==========================================
// Server-authoritative geofencing. The client NEVER decides whether it is
// "inside" — it only reports raw coordinates and the server recomputes the
// great-circle (Haversine) distance to the gym and enforces the radius. This
// is the anti-spoof boundary: a forged "isInside:true" flag is meaningless
// because the client flag is ignored entirely.

const FEET_PER_METER = 3.280839895;

// Great-circle distance between two lat/lng points, in METERS.
function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000; // Earth radius (m)
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const isFiniteNum = (v) => typeof v === 'number' && isFinite(v);
const inLatRange = (v) => isFiniteNum(v) && v >= -90 && v <= 90;
const inLonRange = (v) => isFiniteNum(v) && v >= -180 && v <= 180;





































// ==========================================
// [DISCOUNT-FIX] DISCOUNT SETTINGS API
// ==========================================
// 5 fixed rule ids. Any other id is rejected so the renewal flow always reads
// from a known set. The server is the source of truth — clients may display
// the resolved discounts but never define them.
const ALLOWED_DISCOUNT_IDS = new Set([
  'loyalty', 'student', 'corporate', 'promotional', 'custom'
]);
const ALLOWED_DISCOUNT_TYPES = new Set(['amount', 'percent']);































// ==========================================
// BACKUP & RESTORE APIs
// ==========================================
const path = require('path');
const fsModule = require('fs');

// [M7] Backups must live OUTSIDE the web root so they can never be downloaded
// statically. `data/` is excluded from express.static (which only serves public/).
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(__dirname, '..', 'data', 'backups');





const multer = require('multer');
// [M5] Force a safe extension from the (trusted) mimetype rather than the
// attacker-controlled original filename, which could carry .php/.html/.svg etc.
const ALLOWED_IMAGE_TYPES = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' };
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const dir = path.join(__dirname, '../public/assets/uploads/logos');
    if (!fsModule.existsSync(dir)) {
      fsModule.mkdirSync(dir, { recursive: true });
    }
    cb(null, dir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = ALLOWED_IMAGE_TYPES[file.mimetype] || '.png';
    cb(null, 'logo-' + uniqueSuffix + ext);
  }
});
// [M5] Cap size at 2 MB and reject anything that is not a PNG/JPEG/WebP image.
const upload = multer({
  storage: storage,
  limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_IMAGE_TYPES[file.mimetype]) return cb(null, true);
    cb(new Error('Only PNG, JPEG or WebP images are allowed.'));
  }
});










// [M6] Run automation scans for every tenant — invoked on a background interval
// (see server.js) instead of on the dashboard/tasks/notifications request path, so
// page loads stay fast and scans run reliably for all tenants, not just whoever
// happened to load a page in the last 10 seconds.
async function runAutomationScansForAllTenants() {
  try {
    const tenants = await allQuery(`SELECT id FROM tenants WHERE id != 't1'`);
    for (const t of tenants) {
      try { await runAutomationScans(t.id, true); }
      catch (e) { console.error('[automation] scan failed for tenant', t.id, '-', e.message); }
    }
  } catch (e) {
    console.error('[automation] could not enumerate tenants:', e.message);
  }
}

module.exports = router;
module.exports.runAutomationScansForAllTenants = runAutomationScansForAllTenants;