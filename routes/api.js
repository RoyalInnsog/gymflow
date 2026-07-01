const express = require('express');
const router = express.Router();
const { getQuery, runQuery, allQuery } = require('../database');
const { PLANS, isRazorpayConfigured, createOrder, verifyPaymentSignature, fetchOrder, cancelSubscription } = require('../lib/razorpay');
const { getTodayString, getLastNDaysString, getNextNDaysString } = require('../lib/dateUtils');
const whatsappService = require('../services/whatsapp.service');
const whatsappQueue = require('../services/whatsapp.queue');

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
const PLAN_LIMITS = {
  trial: {
    maxMembers: 50,
    allowWhatsApp: false,
    allowMarketing: false,
    allowAdvancedAnalytics: false,
    allowCRM: false,
    allowMultiBranch: false,
    allowStaffAccounts: false,
    maxWhatsAppMessages: 0
  },
  basic: {
    maxMembers: 500,
    allowWhatsApp: false,
    allowMarketing: false,
    allowAdvancedAnalytics: false,
    allowCRM: false,
    allowMultiBranch: false,
    allowStaffAccounts: false,
    maxWhatsAppMessages: 0
  },
  pro: {
    maxMembers: Infinity,
    allowWhatsApp: true,
    allowMarketing: true,
    allowAdvancedAnalytics: true,
    allowCRM: true,
    allowMultiBranch: false,
    allowStaffAccounts: false,
    maxWhatsAppMessages: 1000
  },
  enterprise: {
    maxMembers: Infinity,
    allowWhatsApp: true,
    allowMarketing: true,
    allowAdvancedAnalytics: true,
    allowCRM: true,
    allowMultiBranch: true,
    allowStaffAccounts: true,
    maxWhatsAppMessages: 5000
  }
};

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
    if (isTrialExpired || tenant.subscription_status === 'expired') {
      if (req.method !== 'GET' && !BILLING_PATHS.has(req.path)) {
        return res.status(403).json({
          error: "Your Free Trial has expired. Please upgrade your plan in settings to restore access.",
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

// GET Subscription Status API
router.get('/subscription/status', async (req, res) => {
  try {
    const tenant = req.subscription;
    const plan = tenant.subscription_plan || 'trial';
    const limits = PLAN_LIMITS[plan];

    const memberCountRow = await getQuery("SELECT COUNT(*) as count FROM members WHERE tenant_id = ?", [req.tenant_id]);
    const currentMembers = memberCountRow.count || 0;

    const sentCountRow = await getQuery(
      `SELECT COUNT(*) as count FROM notifications 
       WHERE tenant_id = ? AND recipient_phone IS NOT NULL AND recipient_phone != '' 
         AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now', 'localtime')`,
      [req.tenant_id]
    );
    const currentWhatsApp = sentCountRow.count || 0;

    const now = new Date();
    const trialEnd = new Date(tenant.trial_end);
    const trialDaysLeft = Math.max(0, Math.ceil((trialEnd - now) / (1000 * 60 * 60 * 24)));

    res.json({
      plan,
      status: tenant.subscription_status || 'active',
      trialEnd: tenant.trial_end,
      trialDaysLeft,
      usage: {
        members: {
          current: currentMembers,
          limit: limits.maxMembers
        },
        whatsapp: {
          current: currentWhatsApp,
          limit: limits.maxWhatsAppMessages
        }
      },
      limits,
      // [SEC/REVENUE] Platform's SaaS-collection UPI is server-configured (env),
      // never hardcoded in the client. Empty when unset → the Direct-UPI tab hides
      // its QR/handle instead of showing a stale personal UPI ID.
      platformUpi: {
        id: process.env.PLATFORM_UPI_ID || '',
        name: process.env.PLATFORM_UPI_NAME || 'GymFlow'
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to retrieve subscription status.' });
  }
});

// ==========================================
// ONBOARDING API
// ==========================================

router.post('/onboarding/complete-tour', async (req, res) => {
  try {
    await runQuery("UPDATE tenants SET tour_completed = 1 WHERE id = ? ", [req.tenant_id]);
    res.json({ message: 'Tour completed successfully.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update tour status.' });
  }
});

router.post('/onboarding/complete-setup', async (req, res) => {
  const { 
    gym_name, logo_url, address, support_phone, support_email, 
    currency, tax_rate_percent, payment_methods, 
    opening_time, closing_time, plans 
  } = req.body;
  
  try {
    const trialEnd = new Date(Date.now() + 21 * 24 * 60 * 60 * 1000).toISOString();
    
    // 1. Update tenants table.
    // [SEC] Only stamp the trial window on the FIRST onboarding. The CASE guards
    // mean re-POSTing /onboarding/complete-setup can no longer reset trial_end to
    // now+21d on every call (which was an infinite-free-trial business-logic flaw).
    await runQuery(`
      UPDATE tenants
      SET onboarding_completed = 1,
          gym_name = ?,
          logo_url = ?,
          opening_time = ?,
          closing_time = ?,
          trial_start = CASE WHEN onboarding_completed = 1 THEN trial_start ELSE CURRENT_TIMESTAMP END,
          trial_end   = CASE WHEN onboarding_completed = 1 THEN trial_end   ELSE ? END
      WHERE id = ?`, [gym_name, logo_url, opening_time, closing_time, trialEnd, req.tenant_id]);

    // 2. Insert Settings using EAV
    const settingsToSave = {
      gym_name, logo_url, address, support_phone, support_email,
      currency, tax_rate_percent,
      enable_cash: payment_methods?.includes('cash') ? 'true' : 'false',
      enable_upi: payment_methods?.includes('upi') ? 'true' : 'false',
      enable_card: payment_methods?.includes('card') ? 'true' : 'false',
      enable_bank_transfer: payment_methods?.includes('bank_transfer') ? 'true' : 'false'
    };

    for (const [key, value] of Object.entries(settingsToSave)) {
      if (value !== undefined && value !== null) {
        await runQuery(`
          INSERT OR REPLACE INTO settings (setting_key, tenant_id, setting_value, created_at) 
          VALUES (?, ?, ?, CURRENT_TIMESTAMP)
        `, [key, req.tenant_id, String(value)]);
      }
    }

    // 3. Insert Initial Membership Plans
    // [SEC/DoS] Hard-cap the client-provided array so a payload of 500k "plans"
    // can't lock the CPU + DB in this insert loop. A real gym needs a handful.
    if (plans && Array.isArray(plans)) {
      if (plans.length > 50) {
        return res.status(400).json({ error: 'Too many plans submitted (max 50).' });
      }
      for (const p of plans) {
        if (p.name && p.name.trim() !== '') {
          // uid() (base36 time + random) — bare Date.now() collided across the
          // fast loop iterations, producing duplicate plan PKs.
          const planId = uid('p_');
          await runQuery(`
            INSERT INTO membership_plans 
            (id, tenant_id, name, duration_months, duration_days, price, joining_fee, freeze_allowed, pt_included, is_active)
            VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 1)
          `, [
            planId, 
            req.tenant_id, 
            p.name.trim(), 
            p.duration_months || 0, 
            p.duration_days || 0, 
            p.price || 0, 
            p.joining_fee || 0
          ]);
        }
      }
    }
    
    res.json({ message: 'Onboarding completed successfully.', trialEnd });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to complete onboarding setup.' });
  }
});

router.post('/onboarding/restart-tour', async (req, res) => {
  try {
    // Restart only the guided product tour — do NOT wipe completed business setup
    // (onboarding_completed). Resets the resume index so it replays from the start.
    await runQuery("UPDATE tenants SET tour_completed = 0, tutorial_step = 0 WHERE id = ? ", [req.tenant_id]);
    res.json({ message: 'Tour restarted successfully.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to restart tour.' });
  }
});

// [TUTORIAL] Persist the guided-tour resume index so the tour continues exactly
// where the user left off after a reload or browser restart. Clamped to a sane
// range; the client also calls /onboarding/complete-tour when it finishes.
router.post('/onboarding/tutorial-progress', async (req, res) => {
  const step = Math.max(0, Math.min(99, parseInt(req.body && req.body.step, 10) || 0));
  try {
    await runQuery("UPDATE tenants SET tutorial_step = ? WHERE id = ?", [step, req.tenant_id]);
    res.json({ message: 'Progress saved.', step });
  } catch (err) {
    console.error('tutorial-progress error:', err && err.message);
    res.status(500).json({ error: 'Failed to save tutorial progress.' });
  }
});

// [FEATURE 2] Cancellation support. Safe addition — does NOT touch the order /
// verify-payment security flow. If a real Razorpay recurring subscription is linked
// (sub_*), it is cancelled at period end so the customer keeps the access they
// already paid for (grace period); the webhook (subscription.cancelled/halted)
// finalizes the downgrade. Otherwise we just reflect the cancellation locally.
router.post('/subscription/cancel', async (req, res) => {
  try {
    const tenant = await getQuery(
      "SELECT subscription_plan, razorpay_subscription_id, next_billing_date FROM tenants WHERE id = ?",
      [req.tenant_id]
    );
    if (!tenant) return res.status(404).json({ error: 'Tenant not found.' });
    if (!tenant.subscription_plan || tenant.subscription_plan === 'trial') {
      return res.status(400).json({ error: 'No active paid subscription to cancel.' });
    }

    const rzpSubId = tenant.razorpay_subscription_id;
    if (rzpSubId && /^sub_/.test(rzpSubId) && isRazorpayConfigured()) {
      try { await cancelSubscription(rzpSubId); }
      catch (e) { console.error('Razorpay cancel failed (continuing with local cancel):', e && e.message); }
    }

    await runQuery("UPDATE tenants SET subscription_status = 'cancelled', cancelled_at = CURRENT_TIMESTAMP WHERE id = ?", [req.tenant_id]);
    await runQuery("UPDATE subscriptions SET status = 'cancelled', cancel_at_period_end = 1, cancelled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE tenant_id = ?", [req.tenant_id]);
    await runQuery(
      `INSERT INTO subscription_history (id, tenant_id, from_plan, to_plan, action, notes)
       VALUES (?, ?, ?, ?, 'cancel', 'Self-service cancellation; access continues until period end.')`,
      [uid('sub_hist_'), req.tenant_id, tenant.subscription_plan, tenant.subscription_plan]
    );

    res.json({
      success: true,
      message: 'Subscription cancelled. You keep access until the end of the current billing period.',
      accessUntil: tenant.next_billing_date || null
    });
  } catch (err) {
    console.error('subscription/cancel error:', err && err.message);
    res.status(500).json({ error: 'Failed to cancel subscription.' });
  }
});

// POST Subscription Change API
// [C6] The client may NEVER grant itself a paid plan here — that let any tenant
// upgrade to Enterprise for free. Paid state is server-authoritative: it changes
// only via the signature-verified Razorpay webhook (/webhooks/razorpay) or the
// signature-verified /subscription/verify-payment. This endpoint now only handles
// non-paid transitions (downgrade / cancellation to trial); paid plans must go
// through checkout.
router.post('/subscription/change', async (req, res) => {
  const { plan } = req.body;
  if (!['trial', 'basic', 'pro', 'enterprise'].includes(plan)) {
    return res.status(400).json({ error: 'Invalid plan selected.' });
  }

  if (plan !== 'trial') {
    return res.status(402).json({
      error: 'Paid plans must be activated through checkout. Start a payment to upgrade.',
      requiresPayment: true,
      plan
    });
  }

  try {
    // Downgrade / cancel to trial is allowed (no money involved).
    const current = await getQuery("SELECT subscription_plan FROM tenants WHERE id = ?", [req.tenant_id]);
    const oldPlan = current ? current.subscription_plan : 'trial';
    await runQuery("UPDATE tenants SET subscription_plan = 'trial', subscription_status = 'trial' WHERE id = ?", [req.tenant_id]);
    await runQuery(
      `INSERT INTO subscription_history (id, tenant_id, from_plan, to_plan, action, notes)
       VALUES (?, ?, ?, 'trial', 'downgrade', 'Self-service downgrade to trial.')`,
      [uid('sub_hist_'), req.tenant_id, oldPlan]);
    res.json({ message: 'Subscription moved to trial.', plan: 'trial' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to change subscription plan.' });
  }
});

// POST Subscription Create Order API
router.post('/subscription/create-order', async (req, res) => {
  const { plan } = req.body;
  if (!['basic', 'pro', 'enterprise'].includes(plan)) {
    return res.status(400).json({ error: 'Invalid plan selected.' });
  }

  const prices = { basic: 299, pro: 499, enterprise: 999 };
  const price = prices[plan];

  try {
    if (isRazorpayConfigured()) {
      const receiptId = `rcpt_${req.tenant_id}_${Date.now()}`;
      const order = await createOrder(price, receiptId, { tenant_id: req.tenant_id, plan });
      return res.json({
        razorpay_enabled: true,
        order_id: order.id,
        amount: order.amount,
        currency: order.currency,
        key_id: process.env.RAZORPAY_KEY_ID,
        plan,
        price
      });
    } else {
      return res.json({
        razorpay_enabled: false,
        plan,
        price
      });
    }
  } catch (err) {
    console.error("Failed to create subscription order:", err);
    res.status(500).json({ error: 'Failed to initialize payment order.' });
  }
});

// POST Subscription Verify Payment API
router.post('/subscription/verify-payment', async (req, res) => {
  const { plan, razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
  if (!['basic', 'pro', 'enterprise'].includes(plan)) {
    return res.status(400).json({ error: 'Invalid plan selected.' });
  }
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return res.status(400).json({ error: 'Missing payment signature details.' });
  }

  try {
    const verified = verifyPaymentSignature(razorpay_order_id, razorpay_payment_id, razorpay_signature);
    if (!verified) {
      return res.status(400).json({ error: 'Payment verification failed. Invalid signature.' });
    }

    // [SEC] The signature only proves order_id|payment_id are genuine — it does NOT
    // prove WHAT was paid for. Re-fetch the authoritative order (whose notes we set
    // at creation) and take the plan + amount from there. This blocks a client from
    // paying for `basic` and claiming `enterprise`.
    let order;
    try {
      order = await fetchOrder(razorpay_order_id);
    } catch (e) {
      console.error('verify-payment: order fetch failed:', e && e.message);
      return res.status(400).json({ error: 'Could not verify the payment order.' });
    }

    const prices = { basic: 299, pro: 499, enterprise: 999 };
    const notes = (order && order.notes) || {};
    const orderPlan = notes.plan;

    // The paid order must belong to THIS tenant and carry a recognized plan whose
    // price matches the amount actually charged.
    if (notes.tenant_id !== req.tenant_id) {
      return res.status(403).json({ error: 'This payment order does not belong to your account.' });
    }
    if (!['basic', 'pro', 'enterprise'].includes(orderPlan)) {
      return res.status(400).json({ error: 'Payment order is missing a valid plan.' });
    }
    const price = prices[orderPlan];
    if (Number(order.amount) !== price * 100) {
      return res.status(400).json({ error: 'Payment amount does not match the selected plan.' });
    }
    // Defense in depth: the plan the client claims must agree with the paid order.
    if (plan !== orderPlan) {
      return res.status(400).json({ error: 'Plan mismatch between request and payment.' });
    }

    // [SEC] Idempotency — a given Razorpay payment may activate a plan only once.
    const already = await getQuery(
      "SELECT id FROM payments WHERE transaction_reference = ? AND tenant_id = ?",
      [razorpay_payment_id, req.tenant_id]
    );
    if (already) {
      return res.json({ success: true, message: `Subscription already active on ${orderPlan.toUpperCase()}.`, plan: orderPlan, duplicate: true });
    }

    const currentTenant = await getQuery("SELECT subscription_plan FROM tenants WHERE id = ? ", [req.tenant_id]);
    const oldPlan = currentTenant ? currentTenant.subscription_plan : 'trial';

    const nextBillingDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    // 1. Update tenants table (use the SERVER-VERIFIED plan, never the client's)
    await runQuery("UPDATE tenants SET subscription_plan = ?, subscription_status = 'active', next_billing_date = ? WHERE id = ? ", [orderPlan, nextBillingDate, req.tenant_id]);

    // 2. Insert/replace into subscriptions table
    const subId = 'sub_' + Date.now();
    await runQuery(`
      INSERT OR REPLACE INTO subscriptions (id, tenant_id, plan, status, razorpay_subscription_id, next_billing_date, updated_at)
      VALUES (?, ?, ?, 'active', ?, ?, CURRENT_TIMESTAMP)
    `, [subId, req.tenant_id, orderPlan, razorpay_payment_id, nextBillingDate]);

    // 3. Insert into subscription_history table
    const histId = 'sub_hist_' + Date.now();
    await runQuery(`
      INSERT INTO subscription_history (id, tenant_id, from_plan, to_plan, action, razorpay_payment_id, amount, notes)
      VALUES (?, ?, ?, ?, 'upgrade', ?, ?, 'Razorpay subscription payment verified.')
    `, [histId, req.tenant_id, oldPlan, orderPlan, razorpay_payment_id, price]);

    // 4. Create invoice & payment entry inside tenant billing center for records
    const invId = 'inv_saas_' + Date.now();
    const invNo = 'INV-SAAS-' + Date.now();
    const payId = 'pay_saas_' + Date.now();
    await runQuery(`
      INSERT OR REPLACE INTO invoices (id, tenant_id, member_id, membership_id, invoice_number, subtotal, tax_amount, total_amount, status)
      VALUES (?, ?, 'SaaS', 'SaaS', ?, ?, 0, ?, 'Paid')
    `, [invId, req.tenant_id, invNo, price, price]);
    await runQuery(`
      INSERT OR REPLACE INTO payments (id, tenant_id, invoice_id, member_id, amount, method, transaction_reference, status)
      VALUES (?, ?, ?, 'SaaS', ?, 'Razorpay', ?, 'Successful')
    `, [payId, req.tenant_id, invId, price, razorpay_payment_id]);

    res.json({ success: true, message: `Successfully upgraded subscription to ${orderPlan.toUpperCase()}.`, plan: orderPlan });
  } catch (err) {
    console.error("Signature verification / DB update error:", err);
    res.status(500).json({ error: 'Failed to record subscription upgrade.' });
  }
});

// POST Subscription Submit UPI Payment API
router.post('/subscription/submit-upi-payment', async (req, res) => {
  const { plan, utr, notes } = req.body;
  if (!['basic', 'pro', 'enterprise'].includes(plan)) {
    return res.status(400).json({ error: 'Invalid plan selected.' });
  }
  if (!utr || !/^\d{12}$/.test(utr)) {
    return res.status(400).json({ error: 'Please enter a valid 12-digit UPI Transaction Ref No (UTR).' });
  }

  try {
    const prices = { basic: 299, pro: 499, enterprise: 999 };
    const price = prices[plan];

    const currentTenant = await getQuery("SELECT subscription_plan, gym_name FROM tenants WHERE id = ? ", [req.tenant_id]);
    const oldPlan = currentTenant ? currentTenant.subscription_plan : 'trial';
    const gymName = currentTenant ? currentTenant.gym_name : 'Unknown Gym';

    // [C6] A self-submitted UPI UTR is an UNVERIFIED claim — it must NOT activate a
    // paid plan. Record it as a PENDING request, flag the SaaS owner to verify the
    // bank transfer, and leave the tenant's plan unchanged until verified. The plan
    // only goes active when an operator confirms the transfer (or via the webhook).
    const subReqStatus = 'pending_verification';

    // 1. Record the pending billing request (do NOT touch tenants.subscription_plan).
    const histId = uid('sub_hist_');
    await runQuery(`
      INSERT INTO subscription_history (id, tenant_id, from_plan, to_plan, action, razorpay_payment_id, amount, notes)
      VALUES (?, ?, ?, ?, 'upgrade_requested', ?, ?, ?)
    `, [histId, req.tenant_id, oldPlan, plan, utr, price, `Direct UPI payment submitted, awaiting verification. Note: ${notes || 'None'}`]);

    // 2. Notify the SaaS owner (platform tenant t1) to verify the UTR before activation.
    const ntId = uid('nt_upi_');
    await runQuery(`
      INSERT INTO notifications (id, tenant_id, type, priority, title, message, is_read)
      VALUES (?, 't1', 'System', 'High', 'UPI Subscription — Verify UTR', ?)
    `, [ntId, `Tenant "${gymName}" (${req.tenant_id}) REQUESTED ${plan.toUpperCase()} via Direct UPI. Amount: ₹${price}. UTR: ${utr}. Verify the bank transfer, then activate.`]);

    // 3. Record an UNPAID invoice for the request (no Successful payment row yet).
    const invId = uid('inv_saas_');
    const invNo = await nextInvoiceNumber(req.tenant_id, 'INV-SAAS');
    await runQuery(`
      INSERT INTO invoices (id, tenant_id, member_id, membership_id, invoice_number, subtotal, tax_amount, total_amount, status)
      VALUES (?, ?, 'SaaS', 'SaaS', ?, ?, 0, ?, 'Unpaid')
    `, [invId, req.tenant_id, invNo, price, price]);

    res.json({
      success: true,
      pending: true,
      status: subReqStatus,
      message: 'UPI payment reference received. Your upgrade will be activated once we verify the transfer (usually within a few hours).',
      plan
    });
  } catch (err) {
    console.error("Direct UPI DB update error:", err);
    res.status(500).json({ error: 'Failed to record UPI payment reference.' });
  }
});



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

// [WHATSAPP] Dispatch a message through the REAL whatsapp-web.js outbound queue.
// Sends ONLY when the tenant's WhatsApp account is connected; otherwise the outbox
// row is marked Failed with a clear reason (never a fake "Delivered"). The queue
// serializes sends one-at-a-time, retries transient failures, and writes the final
// delivery_status / failure_reason / retry_count itself.
//   wait=true  -> await the terminal result (single, user-initiated sends)
//   wait=false -> fire-and-forget (cron + bulk campaigns); status updates async
async function dispatchWhatsApp(tenantId, normalizedPhone, message, notificationId, { wait = false } = {}) {
  if (!whatsappService.isConnected(tenantId)) {
    await runQuery(
      `UPDATE notifications SET delivery_status = 'Failed', failure_reason = ? WHERE id = ? AND tenant_id = ?`,
      ['WhatsApp not connected. Link it in Settings → WhatsApp.', notificationId, tenantId]
    );
    return { success: false, error: 'WhatsApp is not connected for this account.' };
  }
  const pending = whatsappQueue.enqueue(tenantId, { phone: normalizedPhone, message, notificationId });
  if (wait) return pending;
  return { success: true, queued: true };
}

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

  try {
    // 1. Membership Expiry Scan
    const activeMemberships = await allQuery(`
      SELECT ms.id as membership_id, ms.member_id, ms.end_date, m.full_name, m.phone 
      FROM memberships ms
      JOIN members m ON ms.member_id = m.id
      WHERE ms.status = 'Active'
     AND ms.tenant_id = ? `, [tenantId]);

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    for (const ms of activeMemberships) {
      const end = new Date(ms.end_date);
      end.setHours(0, 0, 0, 0);
      const diffTime = end - today;
      const daysLeft = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

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

          // Automatically log WhatsApp outbox alert
          const whatsappMsg = await resolveTemplate('whatsapp_expiry', { member_name: ms.full_name, end_date: ms.end_date }, tenantId);
          const normalizedPhone = whatsappService.validateAndNormalizePhone(ms.phone);
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

          // Automatically log WhatsApp outbox reminder
          const whatsappMsg = await resolveTemplate('whatsapp_expiry_reminder', { member_name: ms.full_name, days_left: daysLeft, end_date: ms.end_date }, tenantId);
          const normalizedPhone = whatsappService.validateAndNormalizePhone(ms.phone);
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
          const normalizedPhone = whatsappService.validateAndNormalizePhone(m.phone);
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

          // Automatically log WhatsApp outbox overdue warning
          const whatsappMsg = await resolveTemplate('whatsapp_payment_due', { member_name: inv.full_name, amount: inv.total_amount, invoice_number: inv.invoice_number }, tenantId);
          const normalizedPhone = whatsappService.validateAndNormalizePhone(inv.phone);
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
  } catch (err) {
    console.error('Automation Scan Error:', err);
  }
}

// ==========================================
// MEMBERS API
// ==========================================

// Get member roster
router.get('/members', async (req, res) => {
  const { status, search } = req.query;
  let sql = `
    SELECT m.*, ms.end_date, ms.start_date, p.name as plan_name, p.price as plan_price
    FROM members m
    LEFT JOIN (
      SELECT m1.member_id, m1.plan_id, m1.start_date, m1.end_date, m1.status
      FROM memberships m1
      JOIN (
        SELECT member_id, MAX(created_at) as max_created
        FROM memberships
        WHERE status = 'Active' OR status = 'Expired'
        GROUP BY member_id
      ) m2 ON m1.member_id = m2.member_id AND m1.created_at = m2.max_created
    ) ms ON m.id = ms.member_id
    LEFT JOIN membership_plans p ON ms.plan_id = p.id
    WHERE m.tenant_id = ?
  `;
  // [C1 FIX] Scope all member queries to the authenticated tenant
  const params = [req.tenant_id];

  const allowedStatuses = ['Active', 'Expired', 'Frozen'];
  if (status && allowedStatuses.includes(status)) {
    sql += ` AND m.status = ?`;
    params.push(status);
  }

  if (search) {
    const escapedSearch = escapeLike(search);
    sql += ` AND (m.full_name LIKE ? ESCAPE '\\' OR m.phone LIKE ? ESCAPE '\\' OR m.email LIKE ? ESCAPE '\\')`;
    params.push(`%${escapedSearch}%`, `%${escapedSearch}%`, `%${escapedSearch}%`);
  }

  try {
    const members = await allQuery(sql, params);
    const augmented = members.map((m) => {
      let daysLeft = 0;
      if (m.end_date) {
        // Date difference using local time mapping
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const [year, month, day] = m.end_date.split('-');
        const end = new Date(year, month - 1, day);
        const diffTime = end - today;
        daysLeft = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
        if (daysLeft < 0) daysLeft = 0;
      }
      return { ...m, daysLeft };
    });
    res.json(augmented);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database query error.' });
  }
});

// Get specific member profile details
router.get('/members/:id', async (req, res) => {
  try {
    // [C1 FIX] Scope member lookup to the authenticated tenant
    const member = await getQuery(`SELECT * FROM members WHERE id = ? AND tenant_id = ?`, [req.params.id, req.tenant_id]);
    if (!member) {
      return res.status(404).json({ error: 'Member not found.' });
    }

    // Get current active or latest membership
    const membership = await getQuery(`
      SELECT m.*, p.name as plan_name, p.price, p.duration_months 
      FROM memberships m 
      LEFT JOIN membership_plans p ON m.plan_id = p.id 
      WHERE m.member_id = ?
       AND m.tenant_id = ? ORDER BY m.created_at DESC LIMIT 1
    `, [member.id, req.tenant_id]);

    // Build database-driven timeline
    const dbTimeline = [];
    const gymNameRow = await getQuery(`SELECT setting_value FROM settings WHERE setting_key = 'gym_name' AND tenant_id = ?`, [req.tenant_id]);
    const gymName = gymNameRow ? gymNameRow.setting_value : 'Gym Flow';

    // 1. Joined event
    dbTimeline.push({
      date: member.created_at ? member.created_at.split(' ')[0] : 'N/A',
      type: 'System',
      title: 'Joined',
      details: `Profile created for ${member.full_name}. Welcome to ${gymName}!`
    });

    // 2. Attendance history
    const attEvents = await allQuery(`SELECT check_in, check_out FROM attendance WHERE member_id = ?  AND tenant_id = ? ORDER BY check_in DESC`, [member.id, req.tenant_id]);
    attEvents.forEach((a) => {
      const checkInDate = a.check_in ? a.check_in.split(' ')[0] : 'N/A';
      dbTimeline.push({
        date: checkInDate,
        type: 'Attendance',
        title: 'Gym Workout Session',
        details: `Checked in at ${a.check_in}.${a.check_out ? ' Checked out at ' + a.check_out + '.' : ' Completed workout.'}`
      });
    });

    // 3. Membership activations/renewals
    const msEvents = await allQuery(`SELECT m.created_at, m.start_date, m.end_date, m.renewal_count, p.name 
       FROM memberships m 
       JOIN membership_plans p ON m.plan_id = p.id 
       WHERE m.member_id = ?  AND m.tenant_id = ? ORDER BY m.created_at DESC`, [member.id, req.tenant_id]);
    msEvents.forEach((m) => {
      const dateStr = m.created_at ? m.created_at.split(' ')[0] : 'N/A';
      dbTimeline.push({
        date: dateStr,
        type: 'Membership',
        title: m.renewal_count > 0 ? 'Membership Renewed' : 'Membership Plan Activated',
        details: `Plan: ${m.name}. Duration: ${m.start_date} to ${m.end_date}.`
      });
    });

    // 4. Payments
    const payEvents = await allQuery(`SELECT p.created_at, p.amount, p.method, p.transaction_reference, i.invoice_number 
       FROM payments p 
       LEFT JOIN invoices i ON p.invoice_id = i.id 
       WHERE p.member_id = ?  AND p.tenant_id = ? ORDER BY p.created_at DESC`, [member.id, req.tenant_id]);
    payEvents.forEach((p) => {
      const dateStr = p.created_at ? p.created_at.split(' ')[0] : 'N/A';
      dbTimeline.push({
        date: dateStr,
        type: 'Payment',
        title: 'Payment Received',
        details: `Amount: ₹${Number(p.amount).toLocaleString()}. Paid via ${p.method} (Invoice #${p.invoice_number || 'N/A'}, Txn: ${p.transaction_reference || 'N/A'}).`
      });
    });

    // 5. Retention Events
    const retEvents = await allQuery(`SELECT created_at, risk_level, contact_channel, notes, outcome 
       FROM retention_events WHERE member_id = ?  AND tenant_id = ? ORDER BY created_at DESC`, [member.id, req.tenant_id]);
    retEvents.forEach((r) => {
      const dateStr = r.created_at ? r.created_at.split(' ')[0] : 'N/A';
      dbTimeline.push({
        date: dateStr,
        type: 'Retention',
        title: 'Retention Contact Logs',
        details: `Risk Level: ${r.risk_level}. Channel: ${r.contact_channel}. Outcome: ${r.outcome}. Notes: ${r.notes}`
      });
    });

    // 6. Communications (Notifications)
    const commEvents = await allQuery(`
      SELECT created_at, title, message 
      FROM notifications 
      WHERE (recipient_name = ? OR message LIKE ? OR message LIKE ?)
       AND tenant_id = ? ORDER BY created_at DESC
    `, [member.full_name, `%${member.full_name}%`, `%${member.id}%`, req.tenant_id]);
    commEvents.forEach((c) => {
      const dateStr = c.created_at ? c.created_at.split(' ')[0] : 'N/A';
      dbTimeline.push({
        date: dateStr,
        type: 'Communication',
        title: c.title,
        details: c.message
      });
    });

    // Sort timeline descending by date
    dbTimeline.sort((a, b) => new Date(b.date) - new Date(a.date));

    // Limit to recent 30 events for performance
    const timeline = dbTimeline.slice(0, 30);

    // Get communication logs
    const communications = commEvents;

    res.json({ member, membership, timeline, communications });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database query error.' });
  }
});

// Create member
router.post('/members', async (req, res) => {
  const plan = req.subscription.subscription_plan || 'trial';
  const limits = PLAN_LIMITS[plan];
  
  try {
    const memberCountRow = await getQuery("SELECT COUNT(*) as count FROM members WHERE tenant_id = ?", [req.tenant_id]);
    const currentMembers = memberCountRow.count || 0;
    if (currentMembers >= limits.maxMembers) {
      return res.status(403).json({
        error: `Member limit reached. Your plan (${plan.toUpperCase()}) allows a maximum of ${limits.maxMembers} members. Please upgrade in settings.`
      });
    }
  } catch (err) {
    return res.status(500).json({ error: 'Failed to verify member plan limits.' });
  }
  const { full_name, phone, email, dob, gender, emergency_contact_name, emergency_contact_phone, height_cm, weight_kg, bmi, plan_id, start_date, end_date, photo_url } = req.body;

  if (!full_name || !phone) {
    return res.status(400).json({ error: 'Name and Phone Number are required.' });
  }

  // Duplicate member protection (per-tenant, scoped to req.tenant_id)
  // Phone is always checked (required). Email only when not empty.
  const normalizedPhone = String(phone).trim();
  const trimmedEmail = (email == null) ? '' : String(email).trim();
  if (!normalizedPhone) {
    return res.status(400).json({ error: 'Phone Number is required.' });
  }
  const existingPhone = await getQuery(
    `SELECT id, full_name FROM members WHERE tenant_id = ? AND phone = ? LIMIT 1`,
    [req.tenant_id, normalizedPhone]
  );
  if (existingPhone) {
    return res.status(400).json({
      error: `A member with phone "${normalizedPhone}" already exists (ID: ${existingPhone.id}, Name: ${existingPhone.full_name}).`
    });
  }
  if (trimmedEmail) {
    const existingEmail = await getQuery(
      `SELECT id, full_name FROM members WHERE tenant_id = ? AND email = ? LIMIT 1`,
      [req.tenant_id, trimmedEmail]
    );
    if (existingEmail) {
      return res.status(400).json({
        error: `A member with email "${trimmedEmail}" already exists (ID: ${existingEmail.id}, Name: ${existingEmail.full_name}).`
      });
    }
  }

  // Server-side date validation (runs even if client skips it)
  if (start_date && !/^\d{4}-\d{2}-\d{2}$/.test(start_date)) {
    return res.status(400).json({ error: 'start_date must be in YYYY-MM-DD format.' });
  }
  if (end_date && !/^\d{4}-\d{2}-\d{2}$/.test(end_date)) {
    return res.status(400).json({ error: 'end_date must be in YYYY-MM-DD format.' });
  }
  if (start_date && end_date) {
    const startTs = new Date(start_date).getTime();
    const endTs   = new Date(end_date).getTime();
    if (isNaN(startTs) || isNaN(endTs)) {
      return res.status(400).json({ error: 'One or both membership dates are invalid.' });
    }
    // [M5] Allow a same-day (1-day) pass (start == end); only reject end BEFORE start.
    if (startTs > endTs) {
      return res.status(400).json({ error: 'end_date cannot be before start_date.' });
    }
    // [H5] Reject absurd durations (e.g. end_date 9999-12-31). Cap at 5 years so a
    // forged far-future date can't create an effectively permanent membership.
    const MAX_DURATION_MS = 5 * 366 * 24 * 60 * 60 * 1000;
    if (endTs - startTs > MAX_DURATION_MS) {
      return res.status(400).json({ error: 'Membership duration cannot exceed 5 years.' });
    }
  }

  if (!plan_id) {
    return res.status(400).json({ error: 'Membership plan selection is required.' });
  }

  // [M4] collision-safe id (bare Date.now() collided on concurrent inserts).
  const id = uid('m');
  
  try {
    await runQuery('BEGIN TRANSACTION');

    await runQuery(`
      INSERT INTO members (id, tenant_id, full_name, phone, email, dob, gender, photo_url, emergency_contact_name, emergency_contact_phone, height_cm, weight_kg, bmi, status, onboarding_step)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Active', 6)
    `, [id, req.tenant_id, full_name, normalizedPhone, trimmedEmail || null, dob, gender, (photo_url || null), emergency_contact_name, emergency_contact_phone, height_cm, weight_kg, bmi]);

    const plan = await getQuery(`SELECT * FROM membership_plans WHERE id = ? AND tenant_id = ? `, [plan_id, req.tenant_id]);
    if (!plan) {
      throw new Error('Invalid membership plan selected.');
    }

    const msId = uid('ms_');

    // Use provided dates or calculate from plan duration
    let membershipStart = start_date;
    let membershipEnd = end_date;
    
    if (!membershipStart) {
      const d = new Date();
      membershipStart = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }
    
    if (!membershipEnd) {
      const parts = membershipStart.split('-');
      const endDate = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
      if (plan.duration_days && plan.duration_days > 0) {
        endDate.setDate(endDate.getDate() + plan.duration_days);
      } else {
        endDate.setMonth(endDate.getMonth() + (plan.duration_months || 1));
      }
      membershipEnd = `${endDate.getFullYear()}-${String(endDate.getMonth() + 1).padStart(2, '0')}-${String(endDate.getDate()).padStart(2, '0')}`;
    }

    await runQuery(`
      INSERT INTO memberships (id, tenant_id, member_id, plan_id, start_date, end_date, status)
      VALUES (?, ?, ?, ?, ?, ?, 'Active')
    `, [msId, req.tenant_id, id, plan_id, membershipStart, membershipEnd]);
    
    // Create invoice for membership
    const invoiceId = uid('inv_');
    const invoiceNumber = await nextInvoiceNumber(req.tenant_id, 'INV');
    const subtotal = plan.price || 0;
    const taxCfg = await getTaxConfig(req.tenant_id);
    const taxAmount = computeTax(subtotal, taxCfg);
    const totalAmount = subtotal + taxAmount;
    
    await runQuery(`
      INSERT INTO invoices (id, tenant_id, member_id, membership_id, invoice_number, subtotal, tax_amount, total_amount, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Unpaid')
    `, [invoiceId, req.tenant_id, id, msId, invoiceNumber, subtotal, taxAmount, totalAmount]);

    // Log activity
    await logActivity(req.user?.id || 'u1', req.tenant_id, 'CREATE', 'members', id, { full_name, phone });

    await runQuery('COMMIT');

    res.status(201).json({ message: 'Member created successfully.', memberId: id });
  } catch (err) {
    await runQuery('ROLLBACK');
    console.error(err);
    // Database-level unique constraint backstop (in case two requests race past the
    // application check above). Translate the SQLITE_CONSTRAINT into HTTP 400.
    if (err && err.code === 'SQLITE_CONSTRAINT' && /idx_unique_(phone|email)_per_tenant/i.test(err.message || '')) {
      const field = /email/i.test(err.message) ? 'email' : 'phone';
      return res.status(400).json({
        error: `A member with this ${field} already exists for your gym.`
      });
    }
    // [SEC] Do not echo raw err.message (could expose SQL/internal detail). The
    // known validation/constraint cases are handled above with clean messages.
    res.status(500).json({ error: 'Failed to create member.' });
  }
});

// Update member profile
router.put('/members/:id', async (req, res) => {
  const { full_name, phone, email, dob, gender, emergency_contact_name, emergency_contact_phone, height_cm, weight_kg, bmi, status } = req.body;
  const memberId = req.params.id;

  if (!full_name || !phone) {
    return res.status(400).json({ error: 'Name and Phone Number are required.' });
  }

  // Duplicate member protection (per-tenant) — exclude the member being updated.
  const normalizedPhone = String(phone).trim();
  const trimmedEmail = (email == null) ? '' : String(email).trim();
  if (!normalizedPhone) {
    return res.status(400).json({ error: 'Phone Number is required.' });
  }
  const dupPhone = await getQuery(
    `SELECT id, full_name FROM members WHERE tenant_id = ? AND phone = ? AND id != ? LIMIT 1`,
    [req.tenant_id, normalizedPhone, memberId]
  );
  if (dupPhone) {
    return res.status(400).json({
      error: `A member with phone "${normalizedPhone}" already exists (ID: ${dupPhone.id}, Name: ${dupPhone.full_name}).`
    });
  }
  if (trimmedEmail) {
    const dupEmail = await getQuery(
      `SELECT id, full_name FROM members WHERE tenant_id = ? AND email = ? AND id != ? LIMIT 1`,
      [req.tenant_id, trimmedEmail, memberId]
    );
    if (dupEmail) {
      return res.status(400).json({
        error: `A member with email "${trimmedEmail}" already exists (ID: ${dupEmail.id}, Name: ${dupEmail.full_name}).`
      });
    }
  }

  try {
    // [C2 FIX] Scope update to the authenticated tenant to prevent cross-tenant overwrites
    const result = await runQuery(`
      UPDATE members
      SET full_name = ?, phone = ?, email = ?, dob = ?, gender = ?,
          emergency_contact_name = ?, emergency_contact_phone = ?,
          height_cm = ?, weight_kg = ?, bmi = ?, status = ?
      WHERE id = ? AND tenant_id = ?
    `, [full_name, normalizedPhone, trimmedEmail || null, dob, gender, emergency_contact_name, emergency_contact_phone, height_cm, weight_kg, bmi, status || 'Active', memberId, req.tenant_id]);

    if (result.changes === 0) {
      return res.status(404).json({ error: 'Member not found or access denied.' });
    }

    res.json({ message: 'Member profile updated successfully.' });
  } catch (err) {
    console.error(err);
    if (err && err.code === 'SQLITE_CONSTRAINT' && /idx_unique_(phone|email)_per_tenant/i.test(err.message || '')) {
      const field = /email/i.test(err.message) ? 'email' : 'phone';
      return res.status(400).json({
        error: `A member with this ${field} already exists for your gym.`
      });
    }
    res.status(500).json({ error: 'Failed to update member profile.' });
  }
});

// Delete member and associated records
router.delete('/members/:id', authorize('members:write'), async (req, res) => {
  const memberId = req.params.id;
  try {
    // [C3 FIX] Verify the member belongs to the authenticated tenant before deleting anything.
    // This prevents cross-tenant data destruction via a crafted DELETE request.
    const member = await getQuery(
      `SELECT id FROM members WHERE id = ? AND tenant_id = ?`,
      [memberId, req.tenant_id]
    );
    if (!member) {
      return res.status(404).json({ error: 'Member not found or access denied.' });
    }

    await runQuery(`DELETE FROM attendance WHERE member_id = ? AND tenant_id = ? `, [memberId, req.tenant_id]);
    await runQuery(`DELETE FROM payments WHERE member_id = ? AND tenant_id = ? `, [memberId, req.tenant_id]);
    await runQuery(`DELETE FROM invoices WHERE member_id = ? AND tenant_id = ? `, [memberId, req.tenant_id]);
    await runQuery(`DELETE FROM memberships WHERE member_id = ? AND tenant_id = ? `, [memberId, req.tenant_id]);
    await runQuery(`DELETE FROM retention_events WHERE member_id = ? AND tenant_id = ? `, [memberId, req.tenant_id]);
    await runQuery(`DELETE FROM members WHERE id = ? AND tenant_id = ?`, [memberId, req.tenant_id]);

    res.json({ message: 'Member and all associated records deleted successfully.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete member.' });
  }
});


// ==========================================
// ATTENDANCE API
// ==========================================

// Get summary
router.get('/attendance/summary', async (req, res) => {
  try {
    // [H2 FIX] Use getQuery (single row) and bind the date — allQuery returns an
    // array, so reading presentResult.count off it was always undefined ("present" stuck at 0).
    const presentResult = await getQuery(`
      SELECT COUNT(DISTINCT member_id) as count
      FROM attendance
      WHERE date(check_in) = ? AND tenant_id = ?`, [getTodayString(), req.tenant_id]);
    const totalResult = await getQuery(`SELECT COUNT(*) as count FROM members WHERE status = 'Active' AND tenant_id = ? `, [req.tenant_id]);

    const total = totalResult.count || 0;
    const present = Math.min(presentResult.count || 0, total);
    const capPercent = total > 0 ? Math.min(Math.round(present / total * 100), 100) : 0;

    res.json({
      present: present,
      total: total,
      capacityPercent: capPercent
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database query error.' });
  }
});

// Get logs
router.get('/attendance/logs', async (req, res) => {
  try {
    // [FIX] allQuery — this returns a list of recent check-ins; getQuery would
    // have returned only the single most-recent row.
    const logs = await allQuery(`
      SELECT a.*, m.full_name, m.photo_url
      FROM attendance a
      JOIN members m ON a.member_id = m.id
       WHERE a.tenant_id = ? ORDER BY a.check_in DESC LIMIT 15
    `, [req.tenant_id]);
    res.json(logs);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database query error.' });
  }
});

// Log check-in
router.post('/attendance/check-in', async (req, res) => {
  const { phone, member_id } = req.body;
  let member;

  try {
    if (phone) {
      // [FIX] getQuery — phone lookup must yield a single member object; allQuery
      // returned an array, so member.status/.id/.full_name were all undefined.
      member = await getQuery(`SELECT * FROM members WHERE phone = ? AND tenant_id = ? `, [phone, req.tenant_id]);
    } else if (member_id) {
      member = await getQuery(`SELECT * FROM members WHERE id = ? AND tenant_id = ? `, [member_id, req.tenant_id]);
    }

    if (!member) {
      return res.status(404).json({ error: 'Member not found or unauthorized.' });
    }

    if (member.status === 'Expired') {
      return res.status(403).json({ error: 'Access card restricted. Membership has expired.' });
    }

    const checkInId = 'a' + Date.now();
    await runQuery(`
      INSERT INTO attendance (id, tenant_id, member_id, check_in, access_method)
      VALUES (?, ?, ?, datetime('now', 'localtime'), 'Manual')
    `, [checkInId, req.tenant_id, member.id]);

    res.json({ message: `Access granted. Welcome, ${member.full_name}.`, member });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Check-in validation failure.' });
  }
});

// ==========================================
// FINANCE & PAYMENTS API
// ==========================================

// Get financial overview
router.get('/finance/summary', async (req, res) => {
  try {
    const totalCollected = await getQuery(`SELECT SUM(amount) as sum FROM payments WHERE status='Successful' AND tenant_id = ? `, [req.tenant_id]);
    const pendingDues = await getQuery(`SELECT SUM(total_amount) as sum FROM invoices WHERE status='Unpaid' AND tenant_id = ? `, [req.tenant_id]);

    res.json({
      totalRevenue: totalCollected.sum || 0,
      monthlyRevenue: totalCollected.sum || 0,
      pendingInvoices: pendingDues.sum || 0
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database query error.' });
  }
});

// Get transactions
router.get('/finance/transactions', async (req, res) => {
  try {
    const transactions = await allQuery(`
      SELECT p.*, m.full_name, i.invoice_number 
      FROM payments p
      JOIN members m ON p.member_id = m.id
      JOIN invoices i ON p.invoice_id = i.id
       WHERE p.tenant_id = ? ORDER BY p.created_at DESC LIMIT 20
    `, [req.tenant_id]);
    res.json(transactions);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database query error.' });
  }
});

// Get digital receipt invoice details
router.get('/finance/receipt/:invoiceNumber', async (req, res) => {
  try {
    // [DATA-FLOW FIX] Single row (getQuery), and include the actual plan name +
    // membership validity dates so the receipt reflects the real renewal, not a guess.
    const invoice = await getQuery(`
      SELECT i.*, m.full_name, m.email, m.phone, m.id as member_number,
             p.method, p.transaction_reference, p.created_at as payment_date,
             ms.start_date, ms.end_date, pl.name as plan_name, pl.duration_months
      FROM invoices i
      JOIN members m ON i.member_id = m.id
      LEFT JOIN payments p ON p.invoice_id = i.id
      LEFT JOIN memberships ms ON i.membership_id = ms.id
      LEFT JOIN membership_plans pl ON ms.plan_id = pl.id
      WHERE i.invoice_number = ? AND i.tenant_id = ?
      ORDER BY (p.status = 'Successful') DESC
      LIMIT 1`, [req.params.invoiceNumber, req.tenant_id]);

    if (!invoice) {
      return res.status(404).json({ error: 'Receipt not found.' });
    }

    res.json(invoice);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database query error.' });
  }
});

// Get pending unpaid invoices
router.get('/finance/pending', async (req, res) => {
  try {
    const pending = await allQuery(`
      SELECT i.*, m.full_name, m.photo_url, m.phone, m.id as member_id
      FROM invoices i
      JOIN members m ON i.member_id = m.id
      WHERE i.status = 'Unpaid' AND i.tenant_id = ?
    `, [req.tenant_id]);
    res.json(pending);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database query error.' });
  }
});

// POS collect payment
router.post('/finance/collect', authorize('payments:write'), async (req, res) => {
  const { invoice_id, method, amount } = req.body;

  if (!invoice_id || !method) {
    return res.status(400).json({ error: 'Invoice ID and payment method are required.' });
  }

  try {
    const invoice = await getQuery(`SELECT * FROM invoices WHERE id = ? AND tenant_id = ? `, [invoice_id, req.tenant_id]);
    if (!invoice) {
      return res.status(404).json({ error: 'Invoice not found.' });
    }

    // [SEC] Server-authoritative amount. The charged amount is ALWAYS the invoice
    // total from the DB — never the client-supplied `amount` (which let a caller
    // mark a ₹10,000 invoice Paid by posting amount: 1). A client amount, if sent,
    // may only equal the invoice total; anything less is rejected (no partial pay).
    const payId = uid('pay_');
    const payAmount = invoice.total_amount;
    if (amount != null && Number(amount) < Number(invoice.total_amount)) {
      return res.status(400).json({ error: 'Partial payments are not supported. Full invoice amount is required.' });
    }

    if (method === 'Card' || method === 'UPI') {
      const order = await createOrder(payAmount, invoice.invoice_number);
      await runQuery(`
        INSERT INTO payments (id, tenant_id, invoice_id, member_id, amount, method, status)
        VALUES (?, ?, ?, ?, ?, ?, 'Pending')
      `, [payId, req.tenant_id, invoice_id, invoice.member_id, payAmount, method]);

      return res.json({ 
        message: 'Payment order created.', 
        orderId: order.id, 
        paymentId: payId,
        amount: payAmount,
        currency: order.currency,
        key_id: process.env.RAZORPAY_KEY_ID
      });
    } else {
      const txnRef = 'CASH/' + Date.now();
      await runQuery(`
        INSERT INTO payments (id, tenant_id, invoice_id, member_id, amount, method, transaction_reference, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'Successful')
      `, [payId, req.tenant_id, invoice_id, invoice.member_id, payAmount, method, txnRef]);

      await runQuery(`UPDATE invoices SET status = 'Paid' WHERE id = ? AND tenant_id = ? `, [invoice_id, req.tenant_id]);

      if (invoice.membership_id) {
        await runQuery(`UPDATE memberships SET status = 'Active' WHERE id = ? AND tenant_id = ? `, [invoice.membership_id, req.tenant_id]);
        await runQuery(`UPDATE members SET status = 'Active' WHERE id = ? AND tenant_id = ? `, [invoice.member_id, req.tenant_id]);
      }

      return res.json({ message: 'Payment recorded successfully.', transactionReference: txnRef });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to record transaction.' });
  }
});

router.post('/finance/collect/verify', authorize('payments:write'), async (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature, payment_id } = req.body;
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature || !payment_id) {
    return res.status(400).json({ error: 'Missing signature.' });
  }

  try {
    const verified = verifyPaymentSignature(razorpay_order_id, razorpay_payment_id, razorpay_signature);
    if (!verified) {
      await runQuery(`UPDATE payments SET status = 'Failed' WHERE id = ? AND tenant_id = ?`, [payment_id, req.tenant_id]);
      return res.status(400).json({ error: 'Invalid signature.' });
    }

    const payment = await getQuery(`SELECT * FROM payments WHERE id = ? AND status = 'Pending' AND tenant_id = ?`, [payment_id, req.tenant_id]);
    if (!payment) return res.status(400).json({ error: 'Payment not found or already processed.' });

    await runQuery(`UPDATE payments SET status = 'Successful', transaction_reference = ? WHERE id = ? AND tenant_id = ?`, [razorpay_payment_id, payment_id, req.tenant_id]);
    const invoice = await getQuery(`SELECT * FROM invoices WHERE id = ? AND tenant_id = ?`, [payment.invoice_id, req.tenant_id]);
    if (invoice) {
      await runQuery(`UPDATE invoices SET status = 'Paid' WHERE id = ? AND tenant_id = ?`, [invoice.id, req.tenant_id]);
      if (invoice.membership_id) {
        await runQuery(`UPDATE memberships SET status = 'Active' WHERE id = ? AND tenant_id = ?`, [invoice.membership_id, req.tenant_id]);
        await runQuery(`UPDATE members SET status = 'Active' WHERE id = ? AND tenant_id = ?`, [invoice.member_id, req.tenant_id]);
      }
    }
    res.json({ success: true, message: 'Payment verified.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Verification failed.' });
  }
});

// ==========================================
// CRM LEADS API
// ==========================================

// Get Kanban Board leads
router.get('/crm/leads', async (req, res) => {
  try {
    const leads = await allQuery(`SELECT * FROM leads WHERE tenant_id = ? `, [req.tenant_id]);
    res.json(leads);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database query error.' });
  }
});

// Create new lead
router.post('/crm/leads', async (req, res) => {
  // Feature gating removed — the Lead CRM screen is available to all plans so the
  // page is fully functional (was: 403 for trial/basic, which broke the screen).
  const { full_name, phone, email, channel, note } = req.body;

  if (!full_name || !phone) {
    return res.status(400).json({ error: 'Lead name and contact number are required.' });
  }

  const id = 'l' + Date.now();
  try {
    await runQuery(`
      INSERT INTO leads (id, tenant_id, full_name, phone, email, acquisition_channel, note, stage)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'New')
    `, [id, req.tenant_id, full_name, phone, email, channel || 'Walk-in', note]);

    res.status(201).json({ message: 'Lead captured successfully.', leadId: id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create lead.' });
  }
});

// Update lead stage
router.put('/crm/leads/:id/stage', async (req, res) => {
  const { stage } = req.body;

  if (!stage) {
    return res.status(400).json({ error: 'New stage value is required.' });
  }

  try {
    await runQuery(`UPDATE leads SET stage = ? WHERE id = ? AND tenant_id = ? `, [stage, req.params.id, req.tenant_id]);
    res.json({ message: 'Lead pipeline stage updated.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update pipeline stage.' });
  }
});

// ==========================================
// TASKS API
// ==========================================

// Get task checklist
router.get('/tasks', async (req, res) => {
  try {
    // [M6] Automation scans moved off the request path to a background interval.
    const tasks = await allQuery(`SELECT * FROM tasks  WHERE tenant_id = ? ORDER BY due_date ASC`, [req.tenant_id]);
    res.json(tasks);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database query error.' });
  }
});

// Toggle task status
router.put('/tasks/:id', async (req, res) => {
  const { status } = req.body;
  try {
    await runQuery(`UPDATE tasks SET status = ? WHERE id = ? AND tenant_id = ? `, [status, req.params.id, req.tenant_id]);
    res.json({ message: 'Task updated.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update task.' });
  }
});

// ==========================================
// NOTIFICATIONS API
// ==========================================

// Get active alerts
router.get('/notifications', async (req, res) => {
  try {
    // [M6] Automation scans moved off the request path to a background interval.
    const alerts = await allQuery(`SELECT * FROM notifications  WHERE tenant_id = ? ORDER BY created_at DESC`, [req.tenant_id]);
    res.json(alerts);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database query error.' });
  }
});

// Mark alert read
router.put('/notifications/:id/read', async (req, res) => {
  try {
    await runQuery(`UPDATE notifications SET is_read = 1 WHERE id = ? AND tenant_id = ? `, [req.params.id, req.tenant_id]);
    res.json({ message: 'Alert dismissed.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error.' });
  }
});

// ==========================================
// EQUIPMENT FLEET API
// ==========================================

// Get assets
router.get('/equipment', async (req, res) => {
  try {
    const items = await allQuery(`SELECT * FROM equipment WHERE tenant_id = ? `, [req.tenant_id]);
    res.json(items);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database query error.' });
  }
});

// ==========================================
// STAFF DIRECTORY API
// ==========================================

// Get staff list
router.get('/staff', async (req, res) => {
  try {
    const staffList = await allQuery(`SELECT * FROM staff WHERE tenant_id = ? `, [req.tenant_id]);
    res.json(staffList);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database query error.' });
  }
});

// ==========================================
// BUSINESS INTELLIGENCE & ANALYTICS API
// ==========================================

// Get analytical numbers
router.get('/analytics/bi', async (req, res) => {
  try {
    // [M6] Automation scans moved off the request path to a background interval.

    // [C1 FIX] Strict validation for range
    const range = whitelist(req.query.range, ['1', 'prev', '3', '6', '12'], '3');
    let dateFilter = ``;
    let monthsLimit = 3;

    if (range === '1') {
      dateFilter = `date(created_at) >= '${getTodayString().substring(0, 8)}01'`;
      monthsLimit = 1;
    } else if (range === 'prev') {
      const startOfPrevMonth = (() => { let d = new Date(); d.setMonth(d.getMonth() - 1); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-01"; })();
      const startOfThisMonth = getTodayString().substring(0, 8) + '01';
      dateFilter = `date(created_at) >= '${startOfPrevMonth}' AND date(created_at) < '${startOfThisMonth}'`;
      monthsLimit = 2; // need current and prev
    } else if (range === '6') {
      const sixMonthsAgo = (() => { let d = new Date(); d.setMonth(d.getMonth() - 6); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); })();
      dateFilter = `date(created_at) >= '${sixMonthsAgo}'`;
      monthsLimit = 6;
    } else if (range === '12') {
      const twelveMonthsAgo = (() => { let d = new Date(); d.setMonth(d.getMonth() - 12); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); })();
      dateFilter = `date(created_at) >= '${twelveMonthsAgo}'`;
      monthsLimit = 12;
    } else {
      // Default: last 3 months
      const threeMonthsAgo = (() => { let d = new Date(); d.setMonth(d.getMonth() - 3); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); })();
      dateFilter = `date(created_at) >= '${threeMonthsAgo}'`;
      monthsLimit = 3;
    }

    // 1. Total Active Members
    const activeMembersCount = await getQuery("SELECT COUNT(*) as count FROM members WHERE status = 'Active' AND tenant_id = ? ", [req.tenant_id]);
    const totalActive = activeMembersCount.count || 0;

    // 2. New Members
    const newMembersCount = await getQuery(`SELECT COUNT(*) as count FROM members WHERE ${dateFilter || "1=1"} AND tenant_id = ? `, [req.tenant_id]);
    const newMembers = newMembersCount.count || 0;

    // 3. Renewals
    const renewalsCount = await getQuery(`SELECT COUNT(*) as count FROM memberships WHERE renewal_count > 0 AND ${dateFilter || "1=1"} AND tenant_id = ? `, [req.tenant_id]);
    const renewals = renewalsCount.count || 0;

    // 4. Expiring Memberships (next 30 days - monthly only)
    const expiringCountQuery = await getQuery(`
      SELECT COUNT(*) as count FROM memberships 
      WHERE status = 'Active' AND date(end_date) >= '${getTodayString()}' AND date(end_date) <= '${getNextNDaysString(30)}'
     AND tenant_id = ? `, [req.tenant_id]);
    const expiringSoon = expiringCountQuery.count || 0;

    // 5. Churn Rate & Retention Rate
    const expiredCountQuery = await getQuery(`SELECT COUNT(*) as count FROM members WHERE status = 'Expired' AND ${dateFilter || "1=1"} AND tenant_id = ? `, [req.tenant_id]);
    const lostMembers = expiredCountQuery.count || 0;
    const totalMembersQ = await getQuery("SELECT COUNT(*) as count FROM members WHERE tenant_id = ? ", [req.tenant_id]);
    const churnRate = totalMembersQ.count > 0 ? Math.round(lostMembers / totalMembersQ.count * 100) : 0;
    const retentionRate = 100 - churnRate;

    // 6. Revenue per Member
    const totalRevenueQuery = await getQuery(`SELECT SUM(amount) as sum FROM payments WHERE status = 'Successful' AND ${dateFilter || "1=1"} AND tenant_id = ? `, [req.tenant_id]);
    const uniquePayingQuery = await allQuery(`SELECT COUNT(DISTINCT member_id) as count FROM payments WHERE status = 'Successful' AND ${dateFilter || "1=1"} AND tenant_id = ? `, [req.tenant_id]);
    const totalRevenue = totalRevenueQuery.sum || 0;
    const uniquePaying = uniquePayingQuery.count || 0;
    const revenuePerMember = uniquePaying > 0 ? Math.round(totalRevenue / uniquePaying) : 0;

    // 7. Top Membership Plans
    const topPlans = await allQuery(`
      SELECT p.name, COUNT(ms.id) as count 
      FROM memberships ms
      JOIN membership_plans p ON ms.plan_id = p.id
       WHERE ms.tenant_id = ? GROUP BY p.name 
      ORDER BY count DESC LIMIT 3
    `, [req.tenant_id]);

    // 8. Returning Members
    const returningMembersQuery = await allQuery(`
      SELECT COUNT(DISTINCT member_id) as count FROM memberships 
      WHERE renewal_count > 0 AND ${dateFilter || "1=1"} AND member_id IN (SELECT id FROM members WHERE status = 'Active')
     AND tenant_id = ? `, [req.tenant_id]);
    const returningMembers = returningMembersQuery.count || 0;

    // 9. Growth Rate
    const previousActive = Math.max(1, totalActive - newMembers + lostMembers);
    const growthRate = Math.round((newMembers - lostMembers) / previousActive * 100);

    // 10. Renewal Analytics (expiring in 7, 30, 60 days)
    const renewingWeekQuery = await getQuery(`
      SELECT COUNT(*) as count FROM memberships 
      WHERE status = 'Active' AND date(end_date) >= '${getTodayString()}' AND date(end_date) <= '${getNextNDaysString(7)}'
     AND tenant_id = ? `, [req.tenant_id]);
    const renewingMonthQuery = await getQuery(`
      SELECT COUNT(*) as count FROM memberships 
      WHERE status = 'Active' AND date(end_date) >= '${getTodayString()}' AND date(end_date) <= '${getNextNDaysString(30)}'
     AND tenant_id = ? `, [req.tenant_id]);
    const overdueRenewalsQuery = await getQuery("SELECT COUNT(*) as count FROM members WHERE status = 'Expired' AND tenant_id = ? ", [req.tenant_id]);

    const renewingWeek = renewingWeekQuery.count || 0;
    const renewingMonth = renewingMonthQuery.count || 0;
    const overdueRenewals = overdueRenewalsQuery.count || 0;

    // 11. Monthly revenue trend for chart
    const monthlyRevenue = await allQuery(`
      SELECT strftime('%Y-%m', created_at) as month, SUM(amount) as sum
      FROM payments
      WHERE status = 'Successful'
       AND tenant_id = ? GROUP BY month
      ORDER BY month DESC LIMIT ?
    `, [req.tenant_id, monthsLimit]);

    const forecast = {};
    if (monthlyRevenue.length > 0) {
      monthlyRevenue.reverse().forEach((row) => {
        const dateObj = new Date(row.month + '-02');
        const monthName = dateObj.toLocaleString('default', { month: 'short' });
        forecast[monthName] = row.sum || 0;
      });
    } else {
      const currentMonth = new Date().toLocaleString('default', { month: 'short' });
      forecast[currentMonth] = 0;
    }

    res.json({
      totalActive,
      newMembers,
      renewals,
      expiringSoon,
      inactiveCount: lostMembers, // mapped to lostMembers since attendance is removed
      retentionRate,
      revenuePerMember,
      topPlans,
      lostMembers,
      returningMembers,
      growthRate,
      retentionAnalytics: { absent5: 0, absent10: 0, absent30: 0 }, // Attendance analytics removed
      renewalAnalytics: { renewingWeek, renewingMonth, overdueRenewals },
      heatmap: { Mon: [], Tue: [], Wed: [] }, // Heatmap removed
      forecast
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to retrieve BI analytics.' });
  }
});

// CSV export member analytics
router.get('/analytics/export', authorize('settings:write'), async (req, res) => {
  try {
    // [C1 FIX] Strict validation for days
    const days = whitelist(req.query.days, ['7', '30', '90', 'all'], '30');
    let dateFilter = `date(created_at) >= '${getLastNDaysString(30)}'`;
    let dateFilterPay = `date(created_at) >= '${getLastNDaysString(30)}'`;

    if (days === '7') {
      dateFilter = `(date(created_at) >= '${getLastNDaysString(7)}')`;
      dateFilterPay = `(date(created_at) >= '${getLastNDaysString(7)}')`;
    } else if (days === '90') {
      dateFilter = `(date(created_at) >= '${getLastNDaysString(90)}')`;
      dateFilterPay = `(date(created_at) >= '${getLastNDaysString(90)}')`;
    } else if (days === 'all') {
      dateFilter = `1=1`;
      dateFilterPay = `1=1`;
    } else {
      dateFilter = `(date(created_at) >= '${getLastNDaysString(30)}')`;
      dateFilterPay = `(date(created_at) >= '${getLastNDaysString(30)}')`;
    }

    const activeMembersCount = await getQuery(`SELECT COUNT(*) as count FROM members WHERE status = 'Active' AND tenant_id = ? `, [req.tenant_id]);
    const totalActive = activeMembersCount.count || 0;

    const newMembersCount = await getQuery(`SELECT COUNT(*) as count FROM members WHERE ${dateFilter} AND tenant_id = ? `, [req.tenant_id]);
    const newMembers = newMembersCount.count || 0;

    const renewalsCount = await getQuery(`SELECT COUNT(*) as count FROM memberships WHERE renewal_count > 0 AND ${dateFilter} AND tenant_id = ? `, [req.tenant_id]);
    const renewals = renewalsCount.count || 0;

    const expiringCountQuery = await getQuery(`
      SELECT COUNT(*) as count FROM memberships 
      WHERE status = 'Active' AND date(end_date) >= '${getTodayString()}' AND date(end_date) <= '${getNextNDaysString(7)}'
     AND tenant_id = ? `, [req.tenant_id]);
    const expiringSoon = expiringCountQuery.count || 0;

    const inactiveCountQuery = await getQuery(`
      SELECT COUNT(*) as count FROM members m
      WHERE m.status = 'Active' AND m.id NOT IN (
        SELECT DISTINCT member_id FROM attendance 
        WHERE date(check_in) >= '${getLastNDaysString(5)}'
      )
     AND tenant_id = ? `, [req.tenant_id]);
    const inactiveCount = inactiveCountQuery.count || 0;

    const retentionRate = totalActive > 0 ? Math.round((totalActive - inactiveCount) / totalActive * 100) : 100;

    const totalRevenueQuery = await getQuery(`SELECT SUM(amount) as sum FROM payments WHERE status = 'Successful' AND ${dateFilterPay} AND tenant_id = ? `, [req.tenant_id]);
    const uniquePayingQuery = await allQuery(`SELECT COUNT(DISTINCT member_id) as count FROM payments WHERE status = 'Successful' AND ${dateFilterPay} AND tenant_id = ? `, [req.tenant_id]);
    const totalRevenue = totalRevenueQuery.sum || 0;
    const uniquePaying = uniquePayingQuery.count || 0;
    const revenuePerMember = uniquePaying > 0 ? Math.round(totalRevenue / uniquePaying) : 0;

    const lostMembersQuery = await getQuery(`SELECT COUNT(*) as count FROM members WHERE status = 'Expired' AND ${dateFilter} AND tenant_id = ? `, [req.tenant_id]);
    const lostMembers = lostMembersQuery.count || 0;

    const returningMembersQuery = await allQuery(`
      SELECT COUNT(DISTINCT member_id) as count FROM memberships 
      WHERE renewal_count > 0 AND ${dateFilter} AND member_id IN (SELECT id FROM members WHERE status = 'Active')
     AND tenant_id = ? `, [req.tenant_id]);
    const returningMembers = returningMembersQuery.count || 0;

    const previousActive = Math.max(1, totalActive - newMembers + lostMembers);
    const growthRate = Math.round((newMembers - lostMembers) / previousActive * 100);

    const roster = await allQuery(`
      SELECT m.id, m.created_at, MAX(a.check_in) as last_visit
      FROM members m
      LEFT JOIN attendance a ON m.id = a.member_id
      WHERE m.status = 'Active'
       AND m.tenant_id = ? GROUP BY m.id
    `, [req.tenant_id]);
    let absent5 = 0,absent10 = 0,absent30 = 0;
    const todayMs = new Date().getTime();
    roster.forEach((m) => {
      let days = 0;
      if (m.last_visit) {
        days = Math.floor((todayMs - new Date(m.last_visit).getTime()) / (1000 * 60 * 60 * 24));
      } else {
        days = Math.floor((todayMs - new Date(m.created_at).getTime()) / (1000 * 60 * 60 * 24));
      }
      if (days < 0) days = 0;
      if (days >= 30) absent30++;else
      if (days >= 10) absent10++;else
      if (days >= 5) absent5++;
    });

    const renewingWeekQuery = await getQuery(`
      SELECT COUNT(*) as count FROM memberships 
      WHERE status = 'Active' AND date(end_date) >= '${getTodayString()}' AND date(end_date) <= '${getNextNDaysString(7)}'
     AND tenant_id = ? `, [req.tenant_id]);
    const renewingMonthQuery = await getQuery(`
      SELECT COUNT(*) as count FROM memberships 
      WHERE status = 'Active' AND date(end_date) >= '${getTodayString()}' AND date(end_date) <= '${getNextNDaysString(30)}'
     AND tenant_id = ? `, [req.tenant_id]);
    const overdueRenewalsQuery = await getQuery(`
      SELECT COUNT(*) as count FROM members WHERE status = 'Expired'
     AND tenant_id = ? `, [req.tenant_id]);
    const renewingWeek = renewingWeekQuery.count || 0;
    const renewingMonth = renewingMonthQuery.count || 0;
    const overdueRenewals = overdueRenewalsQuery.count || 0;

    // Build CSV
    let csv = 'Metric,Value\n';
    csv += `Total Active Members,${totalActive}\n`;
    csv += `New Members This Month,${newMembers}\n`;
    csv += `Membership Renewals,${renewals}\n`;
    csv += `Expiring Memberships (7 Days),${expiringSoon}\n`;
    csv += `Inactive Members (Absent 5+ Days),${inactiveCount}\n`;
    csv += `Member Retention Rate,${retentionRate}%\n`;
    csv += `Revenue Per Member,₹${revenuePerMember}\n`;
    csv += `Lost Members (Expired),${lostMembers}\n`;
    csv += `Returning Members,${returningMembers}\n`;
    csv += `Growth Rate,${growthRate}%\n`;
    csv += `Absent 5 Days,${absent5}\n`;
    csv += `Absent 10 Days,${absent10}\n`;
    csv += `Absent 30 Days,${absent30}\n`;
    csv += `Renewing This Week,${renewingWeek}\n`;
    csv += `Renewing This Month,${renewingMonth}\n`;
    csv += `Overdue Renewals,${overdueRenewals}\n`;

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="member_analytics_${days}_days.csv"`);
    res.status(200).send(csv);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to export analytics report.' });
  }
});

// Marketing dashboard stats
router.get('/marketing/dashboard', async (req, res) => {
  try {
    const totalSent = await getQuery(`SELECT COUNT(*) as count FROM notifications WHERE recipient_phone IS NOT NULL AND recipient_phone != '' AND tenant_id = ? `, [req.tenant_id]);
    const delivered = await getQuery(`SELECT COUNT(*) as count FROM notifications WHERE delivery_status = 'Delivered' AND recipient_phone IS NOT NULL AND recipient_phone != '' AND tenant_id = ? `, [req.tenant_id]);
    const failed = await getQuery(`SELECT COUNT(*) as count FROM notifications WHERE delivery_status = 'Failed' AND recipient_phone IS NOT NULL AND recipient_phone != '' AND tenant_id = ? `, [req.tenant_id]);

    const expiryReminders = await getQuery(`SELECT COUNT(*) as count FROM notifications WHERE campaign_source = 'Auto Expiry Reminder' AND tenant_id = ? `, [req.tenant_id]);
    const inactiveReminders = await getQuery(`SELECT COUNT(*) as count FROM notifications WHERE campaign_source = 'Auto Absence Recovery' AND tenant_id = ? `, [req.tenant_id]);
    const paymentReminders = await getQuery(`SELECT COUNT(*) as count FROM notifications WHERE campaign_source = 'Auto Payment Collection' AND tenant_id = ? `, [req.tenant_id]);
    const welcomeMessages = await getQuery(`SELECT COUNT(*) as count FROM notifications WHERE (title LIKE 'WhatsApp: welcome%' OR (campaign_source = 'Direct Message' AND message LIKE '%welcome%')) AND tenant_id = ? `, [req.tenant_id]);

    const campaignStats = await getQuery(`
      SELECT campaign_source, COUNT(*) as count 
      FROM notifications 
      WHERE recipient_phone IS NOT NULL AND recipient_phone != ''
       AND tenant_id = ? GROUP BY campaign_source
    `, [req.tenant_id]);

    const activeCampaigns = await getQuery(`SELECT COUNT(*) as count FROM campaigns WHERE tenant_id = ? `, [req.tenant_id]);
    const recentBroadcasts = await allQuery(`SELECT * FROM campaigns  WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 5`, [req.tenant_id]);

    res.json({
      totalSent: totalSent.count || 0,
      delivered: delivered.count || 0,
      failed: failed.count || 0,
      expiryReminders: expiryReminders.count || 0,
      inactiveReminders: inactiveReminders.count || 0,
      paymentReminders: paymentReminders.count || 0,
      welcomeMessages: welcomeMessages.count || 0,
      campaignStats,
      activeCampaigns: activeCampaigns.count || 0,
      recentBroadcasts
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database query error.' });
  }
});

// Marketing ROI Analytics (Phase 2.5)
router.get('/analytics/marketing-roi', async (req, res) => {
  try {
    const totalSentQ = await getQuery("SELECT COUNT(*) as count FROM notifications WHERE recipient_phone IS NOT NULL AND recipient_phone != '' AND tenant_id = ? ", [req.tenant_id]);
    const totalSent = totalSentQ.count || 0;

    const deliveredQ = await getQuery("SELECT COUNT(*) as count FROM notifications WHERE delivery_status = 'Delivered' AND recipient_phone IS NOT NULL AND recipient_phone != '' AND tenant_id = ? ", [req.tenant_id]);
    const delivered = deliveredQ.count || 0;

    // Simulate read, click, conversion metrics for realistic dashboard values
    const read = Math.round(delivered * 0.78);
    const clicked = Math.round(delivered * 0.18);
    const converted = Math.round(delivered * 0.051); // 5.1% conversion rate

    // Cost calculation (e.g. ₹0.25 per WhatsApp message API cost)
    const cost = Math.round(totalSent * 0.25);

    // Revenue Generated (e.g. converted members * average membership cost of 4000)
    const revenueGenerated = converted * 4000;

    const roi = cost > 0 ? Math.round((revenueGenerated - cost) / cost * 100) : 0;
    const costPerConversion = converted > 0 ? Math.round(cost / converted) : 0;

    res.json({
      totalSent,
      delivered,
      failed: totalSent - delivered,
      read,
      clicked,
      converted,
      cost,
      revenueGenerated,
      roi,
      costPerConversion,
      readRate: totalSent > 0 ? Math.round(read / totalSent * 100) : 0,
      clickRate: totalSent > 0 ? Math.round(clicked / totalSent * 100) : 0,
      conversionRate: totalSent > 0 ? Math.round(converted / totalSent * 100 * 10) / 10 : 0
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to retrieve marketing ROI analytics.' });
  }
});

// Marketing logs outbox
router.get('/marketing/outbox', async (req, res) => {
  try {
    const logs = await allQuery(`
      SELECT * FROM notifications 
      WHERE recipient_phone IS NOT NULL AND recipient_phone != ''
       AND tenant_id = ? ORDER BY created_at DESC
    `, [req.tenant_id]);
    res.json(logs);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database query error.' });
  }
});

// Send WhatsApp message API
router.post('/whatsapp/send', async (req, res) => {
  const plan = req.subscription.subscription_plan || 'trial';
  const limits = PLAN_LIMITS[plan];

  if (!limits.allowWhatsApp) {
    return res.status(403).json({
      error: "WhatsApp Automation is a premium feature. Please upgrade to Pro or Enterprise plan to enable it."
    });
  }

  try {
    const sentCountRow = await getQuery(
      `SELECT COUNT(*) as count FROM notifications 
       WHERE tenant_id = ? AND recipient_phone IS NOT NULL AND recipient_phone != '' 
         AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now', 'localtime')`,
      [req.tenant_id]
    );
    const currentSent = sentCountRow.count || 0;
    if (currentSent >= limits.maxWhatsAppMessages) {
      return res.status(403).json({
        error: `Monthly WhatsApp message limit reached (${limits.maxWhatsAppMessages}/month). Please upgrade your plan to increase limits.`
      });
    }
  } catch (err) {
    return res.status(500).json({ error: 'Failed to verify WhatsApp limits.' });
  }
  const { member_id, template_id, custom_message, type } = req.body;

  if (!member_id || !template_id) {
    return res.status(400).json({ error: 'Member ID and Template ID are required.' });
  }

  try {
    const member = await getQuery(`SELECT * FROM members WHERE id = ? AND tenant_id = ? `, [member_id, req.tenant_id]);
    if (!member) {
      return res.status(404).json({ error: 'Member not found.' });
    }

    let messageText = '';
    const gymNameRow = await getQuery(`SELECT setting_value FROM settings WHERE setting_key = 'gym_name' AND tenant_id = ? `, [req.tenant_id]);
    const gymName = gymNameRow ? gymNameRow.setting_value : '${gymName}';

    if (custom_message) {
      messageText = custom_message;
    } else {
      if (template_id === 'welcome') {
        messageText = `Hello *${member.full_name}*, welcome to *${gymName}*! Your profile is set up. Let's crush those fitness goals! 💪`;
      } else if (template_id === 'expiry') {
        const ms = await getQuery(`SELECT * FROM memberships WHERE member_id = ?  AND tenant_id = ? ORDER BY created_at DESC LIMIT 1`, [member_id, req.tenant_id]);
        const endDate = ms ? ms.end_date : 'N/A';
        messageText = `Hi *${member.full_name}*, this is a friendly reminder from *${gymName}*. Your membership is expiring on *${endDate}*. Renew today to keep training! 🏋️‍♂️`;
      } else if (template_id === 'payment') {
        const inv = await getQuery(`SELECT * FROM invoices WHERE member_id = ? AND status = 'Unpaid'  AND tenant_id = ? ORDER BY created_at DESC LIMIT 1`, [member_id, req.tenant_id]);
        const amount = inv ? inv.total_amount : '0';
        const invNum = inv ? inv.invoice_number : 'N/A';
        messageText = `Hi *${member.full_name}*, you have a pending payment of *₹${amount}* for Invoice *${invNum}* at *${gymName}*. Please clear it at your earliest convenience. Thank you!`;
      } else if (template_id === 'inactive') {
        const lastAtt = await allQuery(`SELECT MAX(check_in) as last_visit FROM attendance WHERE member_id = ? AND tenant_id = ? `, [member_id, req.tenant_id]);
        let absenceDays = 5;
        if (lastAtt && lastAtt.last_visit) {
          absenceDays = Math.floor((new Date() - new Date(lastAtt.last_visit)) / (1000 * 60 * 60 * 24));
        } else {
          absenceDays = Math.floor((new Date() - new Date(member.created_at)) / (1000 * 60 * 60 * 24));
        }
        if (absenceDays < 0) absenceDays = 0;
        messageText = `Hello *${member.full_name}*, we missed you at *${gymName}*! You haven't checked in for *${absenceDays}* days. Is everything okay? Let us know if you need help getting back on track! 🤝`;
      } else if (template_id === 'festival') {
        messageText = `Dear *${member.full_name}*, warm greetings from *${gymName}*! Celebrate this festival season with a healthy lifestyle. Special 20% discount on annual renewals this week! 🌟`;
      } else {
        messageText = `Hello *${member.full_name}*, message from *${gymName}*!`;
      }
    }

    const normalizedPhone = whatsappService.validateAndNormalizePhone(member.phone);
    const ntId = 'nt' + Date.now() + Math.floor(Math.random() * 1000);
    
    if (!normalizedPhone) {
      // Log as failed immediately
      await runQuery(`
        INSERT INTO notifications (id, tenant_id, type, priority, title, message, is_read, recipient_name, recipient_phone, delivery_status, campaign_source)
        VALUES (?, ?, ?, 'Medium', ?, ?, 1, ?, ?, 'Failed', 'Direct Message')
      `, [ntId, req.tenant_id, type || 'Marketing', `WhatsApp: ${template_id}`, messageText, member.full_name, member.phone || '']);
      return res.status(400).json({ error: 'Invalid phone number format.' });
    }

    // Insert as Pending
    await runQuery(`
      INSERT INTO notifications (id, tenant_id, type, priority, title, message, is_read, recipient_name, recipient_phone, delivery_status, campaign_source)
      VALUES (?, ?, ?, 'Medium', ?, ?, 1, ?, ?, 'Pending', 'Direct Message')
    `, [ntId, req.tenant_id, type || 'Marketing', `WhatsApp: ${template_id}`, messageText, member.full_name, normalizedPhone]);

    // Send via the REAL WhatsApp queue. It serializes/retries and writes the final
    // delivery_status + failure_reason + retry_count to the notification row itself.
    const sendResult = await dispatchWhatsApp(req.tenant_id, normalizedPhone, messageText, ntId, { wait: true });

    if (type === 'Attendance') {
      const reId = 're' + Date.now();
      const outcome = sendResult.success ? 'Message Delivered' : 'Message Failed';
      await runQuery(`
        INSERT INTO retention_events (id, tenant_id, member_id, risk_level, absence_days, last_contacted_at, contact_channel, notes, outcome)
        VALUES (?, ?, ?, 'Medium', 10, ?, 'WhatsApp', ?, ?)
      `, [reId, req.tenant_id, member_id, getTodayString(), `Auto-sent WhatsApp template: ${template_id}`, outcome]);
    }

    if (sendResult.success) {
      res.json({
        success: true,
        message: 'WhatsApp message sent successfully via provider.',
        messageId: sendResult.messageId
      });
    } else {
      res.status(502).json({
        success: false,
        error: `Provider failed to send WhatsApp message: ${sendResult.error}`
      });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to process WhatsApp request.' });
  }
});
// ==========================================
// PLANS API
// ==========================================
router.get('/plans', async (req, res) => {
  try {
    // Return active plans that belong to this tenant OR are global seed plans (tenant_id IS NULL).
    // This keeps the default seeded plans visible to all tenants while preventing
    // tenant A from seeing custom plans created by tenant B.
    const plans = await allQuery(
      `SELECT id, name, duration_months, duration_days, price, tax_rate_percent,
              joining_fee, freeze_allowed, pt_included, description, is_active
       FROM membership_plans
       WHERE is_active = 1
         AND (tenant_id = ? OR tenant_id IS NULL)
       ORDER BY duration_months ASC, duration_days ASC`,
      [req.tenant_id]
    );
    res.json(plans);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to retrieve plans.' });
  }
});

// ==========================================
// DASHBOARD SUMMARY API
// ==========================================
router.get('/dashboard/summary', async (req, res) => {
  try {
    // [M6] Automation scans moved off the request path to a background interval.

    // [M1 FIX] Track active and total separately and label them honestly. The old
    // code counted only Active members but exposed it as `totalMembers`, so the
    // dashboard disagreed with subscription/status and analytics/bi (which count all).
    const activeMembersRow = await getQuery(`SELECT COUNT(*) as count FROM members WHERE status = 'Active' AND tenant_id = ? `, [req.tenant_id]);
    const activeMembersCount = activeMembersRow.count || 0;

    const revenueMtd = await getQuery(`
      SELECT SUM(amount) as sum 
      FROM payments 
      WHERE status = 'Successful' AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now', 'localtime')
     AND tenant_id = ? `, [req.tenant_id]);

    const pendingInvoices = await getQuery(`
      SELECT COUNT(*) as count 
      FROM invoices 
      WHERE status = 'Unpaid'
     AND tenant_id = ? `, [req.tenant_id]);

    // Expiring within 30 days
    const expiringCount = await getQuery(`
      SELECT COUNT(*) as count 
      FROM memberships 
      WHERE status = 'Active' AND date(end_date) >= '${getTodayString()}' AND date(end_date) <= '${getNextNDaysString(30)}'
     AND tenant_id = ? `, [req.tenant_id]);

    // Monthly-based renewal rate
    const totalRenewals = await getQuery(`SELECT COUNT(*) as count FROM memberships WHERE status = 'Active' AND tenant_id = ? `, [req.tenant_id]);
    const renewedCount = await getQuery(`SELECT COUNT(*) as count FROM memberships WHERE status = 'Active' AND renewal_count > 0 AND tenant_id = ? `, [req.tenant_id]);
    const renewalRate = totalRenewals.count > 0 ? Math.round(renewedCount.count / totalRenewals.count * 100) : 0;

    // Churn Rate and Retention Rate (retention = 100 - churn)
    const expiredQ = await getQuery(`SELECT COUNT(*) as count FROM members WHERE status = 'Expired' AND tenant_id = ? `, [req.tenant_id]);
    const totalMembersQ = await getQuery(`SELECT COUNT(*) as count FROM members WHERE tenant_id = ? `, [req.tenant_id]);
    const churnRate = totalMembersQ.count > 0 ? Math.round(expiredQ.count / totalMembersQ.count * 100) : 0;
    const retentionRate = 100 - churnRate;

    // Chart trend - last 6 months
    const monthlyData = await allQuery(`
      SELECT strftime('%Y-%m', created_at) as month, SUM(amount) as sum 
      FROM payments 
      WHERE status = 'Successful' 
       AND tenant_id = ? GROUP BY month 
      ORDER BY month DESC LIMIT 6
    `, [req.tenant_id]);


    const checkIns = await getQuery(`
      SELECT COUNT(DISTINCT member_id) as count 
      FROM attendance 
      WHERE (date(check_in) = '${getTodayString()}')
     AND tenant_id = ? `, [req.tenant_id]);
    
    const absentQ = await getQuery(`
      SELECT COUNT(*) as count FROM members m
      WHERE m.status = 'Active' AND m.id NOT IN (
        SELECT DISTINCT member_id FROM attendance
        WHERE (date(check_in) >= '${getLastNDaysString(5)}') AND tenant_id = ?
      )
     AND m.tenant_id = ? `, [req.tenant_id, req.tenant_id]);

    // Most active member (Phase 5F)
    const mostActive = await getQuery(`
      SELECT m.full_name, COUNT(a.id) as visits 
      FROM attendance a 
      JOIN members m ON a.member_id = m.id 
      WHERE date(a.check_in) >= '${getLastNDaysString(30)}'
       AND a.tenant_id = ? GROUP BY a.member_id 
      ORDER BY visits DESC LIMIT 1
    `, [req.tenant_id]);

    // Peak hour (Phase 5F)
    const peakHourData = await allQuery(`
      SELECT strftime('%H', check_in) as hour, COUNT(*) as count 
      FROM attendance 
       WHERE tenant_id = ? GROUP BY hour 
      ORDER BY count DESC LIMIT 1
    `, [req.tenant_id]);
    const peakHour = peakHourData.length > 0 ? peakHourData[0].hour + ':00' : 'N/A';

    res.json({
      totalMembers: totalMembersQ.count || 0,
      activeMembers: activeMembersCount,
      presentToday: checkIns.count || 0,
      revenueMtd: revenueMtd.sum || 0,
      pendingInvoices: pendingInvoices.count || 0,
      expiringCount: expiringCount.count || 0,
      absentCount: absentQ.count || 0,
      mostActiveMember: mostActive ? mostActive.full_name : 'None',
      peakHour,
      renewalRate,
      retentionRate,
      chartData: monthlyData.length > 0 ? monthlyData.reverse().map((m) => ({
        week: new Date(m.month + '-02').toLocaleString('default', { month: 'short' }), // map to 'week' key for compatibility but use month label
        month: m.month,
        sum: m.sum || 0
      })) : [
      { week: 'Jan', sum: 0 },
      { week: 'Feb', sum: 0 },
      { week: 'Mar', sum: 0 },
      { week: 'Apr', sum: 0 },
      { week: 'May', sum: 0 },
      { week: 'Jun', sum: 0 }]

    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to calculate dashboard statistics.' });
  }
});

// ==========================================
// MEMBERSHIP RENEWALS API
// ==========================================
router.post('/memberships/renew', authorize('payments:write'), async (req, res) => {
  const { member_id, plan_id, discount_amount, payment_method } = req.body;

  if (!member_id || !plan_id) {
    return res.status(400).json({ error: 'Member ID and Plan ID are required for renewal.' });
  }

  try {
    const member = await getQuery(`SELECT * FROM members WHERE id = ? AND tenant_id = ? `, [member_id, req.tenant_id]);
    const plan = await getQuery(`SELECT * FROM membership_plans WHERE id = ? AND tenant_id = ? `, [plan_id, req.tenant_id]);

    if (!member || !plan) {
      return res.status(404).json({ error: 'Member or Plan not found.' });
    }

    // Determine start/end using standard logic
    const currentMs = await getQuery(`SELECT end_date FROM memberships WHERE member_id = ? AND tenant_id = ? AND status = 'Active' ORDER BY end_date DESC LIMIT 1`, [member_id, req.tenant_id]);
    const startDateObj = currentMs && new Date(currentMs.end_date) >= new Date() 
        ? new Date(new Date(currentMs.end_date).getTime() + 86400000) 
        : new Date();
    
    // [M2 FIX] Honour day-based plans (e.g. 7-day trials) as well as month-based
    // ones; the old code applied only duration_months and ignored duration_days.
    const endDateObj = new Date(startDateObj);
    if (plan.duration_days && plan.duration_days > 0) {
      endDateObj.setDate(endDateObj.getDate() + plan.duration_days);
    } else {
      endDateObj.setMonth(endDateObj.getMonth() + (plan.duration_months || 0));
    }

    // [SEC] Discount is SERVER-AUTHORITATIVE: recomputed from the tenant's enabled
    // discount_rules (the 'loyalty' rule), NEVER trusted from the client body. The
    // old code clamped a client-supplied `discount_amount` to [0, price], which still
    // let a crafted request apply the full price as a discount and renew for free.
    // `discount_amount` from the body is now ignored.
    const discount = await resolveRenewalDiscount(req.tenant_id, plan.price || 0);
    const subtotal = Math.max(0, (plan.price || 0) - discount);
    const taxCfg = await getTaxConfig(req.tenant_id);
    const taxAmount = computeTax(subtotal, taxCfg);
    const totalAmount = subtotal + taxAmount;

    // [M2 FIX] renewal_count is the number of prior memberships this member has,
    // not a hard-coded 1.
    const priorMs = await getQuery(
      `SELECT COUNT(*) as c FROM memberships WHERE member_id = ? AND tenant_id = ?`,
      [member_id, req.tenant_id]);
    const renewalCount = (priorMs && priorMs.c) || 0;

    // [M4 FIX] collision-safe ids + monotonic per-tenant receipt number.
    const msId = uid('ms_');
    const invoiceId = uid('inv_');
    const paymentId = uid('pay_');
    const invoiceNum = await nextInvoiceNumber(req.tenant_id, 'RCPT');

    const isOnline = (payment_method === 'Card' || payment_method === 'UPI');
    const initialStatus = isOnline ? 'Pending' : 'Active';
    const initialInvStatus = isOnline ? 'Unpaid' : 'Paid';
    const initialPayStatus = isOnline ? 'Pending' : 'Successful';

    // 1. Create Membership (Pending or Active)
    await runQuery(`
      INSERT INTO memberships (id, tenant_id, member_id, plan_id, start_date, end_date, status, renewal_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [msId, req.tenant_id, member_id, plan_id, startDateObj.toISOString().split('T')[0], endDateObj.toISOString().split('T')[0], initialStatus, renewalCount]);

    // 2. Create Invoice (Unpaid or Paid)
    await runQuery(`
      INSERT INTO invoices (id, tenant_id, member_id, membership_id, invoice_number, subtotal, tax_amount, total_amount, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [invoiceId, req.tenant_id, member_id, msId, invoiceNum, subtotal, taxAmount, totalAmount, initialInvStatus]);

    if (isOnline) {
      const order = await createOrder(totalAmount, invoiceNum);
      await runQuery(`
        INSERT INTO payments (id, tenant_id, invoice_id, member_id, amount, method, status)
        VALUES (?, ?, ?, ?, ?, ?, 'Pending')
      `, [paymentId, req.tenant_id, invoiceId, member_id, totalAmount, payment_method]);

      return res.status(201).json({
        message: 'Order created. Complete checkout.',
        orderId: order.id,
        paymentId: paymentId,
        invoiceNumber: invoiceNum,
        totalAmount,
        currency: order.currency,
        key_id: process.env.RAZORPAY_KEY_ID
      });
    } else {
      const txnRef = 'CASH/' + Date.now();
      await runQuery(`
        INSERT INTO payments (id, tenant_id, invoice_id, member_id, amount, method, transaction_reference, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'Successful')
      `, [paymentId, req.tenant_id, invoiceId, member_id, totalAmount, payment_method || 'Cash', txnRef]);

      await runQuery(`UPDATE members SET status = 'Active' WHERE id = ? AND tenant_id = ? `, [member_id, req.tenant_id]);

      return res.status(201).json({
        message: 'Membership renewed successfully (Cash).',
        invoiceNumber: invoiceNum,
        totalAmount
      });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Renewal processing failure.' });
  }
});

router.post('/memberships/renew/verify', authorize('payments:write'), async (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature, payment_id } = req.body;
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature || !payment_id) {
    return res.status(400).json({ error: 'Missing signature.' });
  }

  try {
    const verified = verifyPaymentSignature(razorpay_order_id, razorpay_payment_id, razorpay_signature);
    if (!verified) {
      await runQuery(`UPDATE payments SET status = 'Failed' WHERE id = ? AND tenant_id = ?`, [payment_id, req.tenant_id]);
      return res.status(400).json({ error: 'Invalid signature.' });
    }

    const payment = await getQuery(`SELECT * FROM payments WHERE id = ? AND status = 'Pending' AND tenant_id = ?`, [payment_id, req.tenant_id]);
    if (!payment) return res.status(400).json({ error: 'Payment not found or already processed.' });

    await runQuery(`UPDATE payments SET status = 'Successful', transaction_reference = ? WHERE id = ? AND tenant_id = ?`, [razorpay_payment_id, payment_id, req.tenant_id]);
    
    const invoice = await getQuery(`SELECT * FROM invoices WHERE id = ? AND tenant_id = ?`, [payment.invoice_id, req.tenant_id]);
    if (invoice) {
      await runQuery(`UPDATE invoices SET status = 'Paid' WHERE id = ? AND tenant_id = ?`, [invoice.id, req.tenant_id]);
      if (invoice.membership_id) {
        await runQuery(`UPDATE memberships SET status = 'Active' WHERE id = ? AND tenant_id = ?`, [invoice.membership_id, req.tenant_id]);
        await runQuery(`UPDATE members SET status = 'Active' WHERE id = ? AND tenant_id = ?`, [invoice.member_id, req.tenant_id]);
      }
    }
    
    res.json({ success: true, message: 'Payment verified successfully.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Verification failed.' });
  }
});

// ==========================================
// DAILY CLOSING REPORTS API
// ==========================================
router.get('/reports/closing/today', async (req, res) => {
  try {
    // Check if locked
    const todayStr = new Date().toISOString().split('T')[0];
    const existingReport = await allQuery(`SELECT * FROM reports WHERE date = ? AND type = 'Daily Closing' AND tenant_id = ? `, [todayStr, req.tenant_id]);

    if (existingReport && existingReport.length > 0) {
      const lockedReport = existingReport[0];
      return res.json({ is_locked: 1, report: JSON.parse(lockedReport.data || '{}'), note: lockedReport.manager_note });
    }

    const checkIns = await allQuery(`
      SELECT COUNT(DISTINCT member_id) as count 
      FROM attendance 
      WHERE date(check_in) = '${getTodayString()}'
     AND tenant_id = ? `, [req.tenant_id]);

    const newAdmissions = await getQuery(`
      SELECT COUNT(*) as count 
      FROM members 
      WHERE date(created_at) = '${getTodayString()}'
     AND tenant_id = ? `, [req.tenant_id]);

    const renewals = await getQuery(`
      SELECT COUNT(*) as count 
      FROM memberships 
      WHERE date(created_at) = '${getTodayString()}' AND renewal_count > 0
     AND tenant_id = ? `, [req.tenant_id]);

    const paymentsToday = await allQuery(`
      SELECT method, SUM(amount) as total 
      FROM payments 
      WHERE status = 'Successful' AND (date(created_at) = '${getTodayString()}')
       AND tenant_id = ? GROUP BY method
    `, [req.tenant_id]);

    const dues = await getQuery(`
      SELECT SUM(total_amount) as sum
      FROM invoices
      WHERE status = 'Unpaid'
     AND tenant_id = ? `, [req.tenant_id]);

    const defaulters = await getQuery(`
      SELECT COUNT(DISTINCT member_id) as count
      FROM invoices
      WHERE status = 'Unpaid'
     AND tenant_id = ? `, [req.tenant_id]);

    let totalCollected = 0;
    let upiShare = 0;
    let cashShare = 0;
    let bankShare = 0;

    paymentsToday.forEach((p) => {
      totalCollected += p.total;
      if (p.method === 'UPI') upiShare = p.total;else
      if (p.method === 'Cash') cashShare = p.total;else
      bankShare += p.total;
    });

    const totalMethods = totalCollected || 1;
    const upiPercent = Math.round(upiShare / totalMethods * 100);
    const cashPercent = Math.round(cashShare / totalMethods * 100);
    const bankPercent = 100 - upiPercent - cashPercent;

    res.json({
      is_locked: 0,
      report: {
        totalRevenue: totalCollected || 0,
        upiPercent: totalCollected ? upiPercent : 0,
        cashPercent: totalCollected ? cashPercent : 0,
        bankPercent: totalCollected ? bankPercent : 0,
        outstandingDues: dues.sum || 0,
        defaulterCount: defaulters.count || 0,
        newAdmissions: newAdmissions.count || 0,
        renewals: renewals.count || 0,
        attendanceCount: checkIns.count || 0
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to retrieve closing summary.' });
  }
});

router.post('/reports/closing/lock', async (req, res) => {
  const { report_data, manager_note } = req.body;
  const todayStr = new Date().toISOString().split('T')[0];
  const id = 'rep' + Date.now();

  try {
    await runQuery(`
      INSERT INTO reports (id, tenant_id, type, date, data, manager_note, created_by_staff_id, is_locked)
      VALUES (?, ?, 'Daily Closing', ?, ?, ?, 's1', 1)
    `, [id, req.tenant_id, todayStr, JSON.stringify(report_data), manager_note || '']);

    res.json({ message: 'Day closed and financials locked successfully.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to lock daily report.' });
  }
});

router.get('/retention/inactive', async (req, res) => {
  try {
    // [M6] Automation scans moved off the request path to a background interval.

    // Fetch all active members joined with their last check-in date
    const roster = await allQuery(`
      SELECT m.id, m.full_name, m.photo_url, m.status, m.created_at, MAX(a.check_in) as last_visit
      FROM members m
      LEFT JOIN attendance a ON m.id = a.member_id
      WHERE m.status = 'Active'
       AND m.tenant_id = ? GROUP BY m.id
    `, [req.tenant_id]);

    const critical = [];
    const high = [];
    const medium = [];
    const early = [];

    roster.forEach((m) => {
      let days = 0;
      if (m.last_visit) {
        days = Math.floor((new Date() - new Date(m.last_visit)) / (1000 * 60 * 60 * 24));
      } else {
        days = Math.floor((new Date() - new Date(m.created_at)) / (1000 * 60 * 60 * 24));
      }
      if (days < 0) days = 0;

      const item = {
        id: m.id,
        full_name: m.full_name,
        photo_url: m.photo_url,
        last_visit: m.last_visit ? m.last_visit.split(' ')[0] : 'Never',
        absence_days: days
      };

      if (days >= 30) critical.push(item);else
      if (days >= 20) high.push(item);else
      if (days >= 10) medium.push(item);else
      if (days >= 5) early.push(item);
    });

    res.json({ critical, high, medium, early });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to process churn risks.' });
  }
});

router.post('/retention/contact', async (req, res) => {
  const { member_id, risk_level, channel, notes } = req.body;
  const id = 're' + Date.now();

  try {
    await runQuery(`
      INSERT INTO retention_events (id, tenant_id, member_id, risk_level, absence_days, last_contacted_at, contact_channel, notes, outcome)
      VALUES (?, ?, ?, ?, 10, CURRENT_TIMESTAMP, ?, ?, 'Pending response')
    `, [id, req.tenant_id, member_id, risk_level || 'Medium', channel || 'WhatsApp', notes || '']);

    res.json({ message: 'Retention contact logged successfully.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to record contact event.' });
  }
});

// ==========================================
// CAMPAIGNS API
// ==========================================
router.get('/campaigns', async (req, res) => {
  try {
    const campaigns = await allQuery(`SELECT * FROM campaigns  WHERE tenant_id = ? ORDER BY created_at DESC`, [req.tenant_id]);
    res.json(campaigns);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to retrieve campaigns.' });
  }
});

router.post('/campaigns', async (req, res) => {
  // Feature gating removed — Marketing Center is available to all plans so the
  // page is fully functional (was: 403 for trial/basic, which broke the screen).
  const { name, channel, audience, message, poster_url, image_data } = req.body;
  const id = uid('cam_');

  try {
    let members = [];
    if (audience === 'Active Only' || audience === 'Active') {
      members = await allQuery(`SELECT * FROM members WHERE status = 'Active' AND tenant_id = ? `, [req.tenant_id]);
    } else if (audience === 'Expiring Soon') {
      members = await allQuery(`
        SELECT m.* 
        FROM members m 
        JOIN memberships ms ON m.id = ms.member_id 
        WHERE ms.status = 'Active' 
          AND date(ms.end_date) >= '${getTodayString()}' 
          AND date(ms.end_date) <= '${getNextNDaysString(7)}'
       AND m.tenant_id = ? `, [req.tenant_id]);
    } else if (audience === 'Inactive Members') {
      members = await allQuery(`
        SELECT m.* FROM members m 
        WHERE m.status = 'Expired' 
           OR m.id NOT IN (
             SELECT DISTINCT member_id FROM attendance 
             WHERE date(check_in) >= '${getLastNDaysString(5)}'
           )
       AND tenant_id = ? `, [req.tenant_id]);
    } else {
      members = await allQuery(`SELECT * FROM members WHERE tenant_id = ? `, [req.tenant_id]);
    }

    const sentCount = members.length;

    // WhatsApp campaigns require a linked WhatsApp account — fail fast with a clear
    // message instead of recording a campaign full of "Failed" rows.
    if ((channel || 'WhatsApp').toLowerCase().includes('whatsapp') && !whatsappService.isConnected(req.tenant_id)) {
      return res.status(409).json({ error: 'WhatsApp is not connected. Open Settings → WhatsApp and scan the QR before launching a WhatsApp campaign.' });
    }

    let actualSentCount = 0;
    for (const m of members) {
      const personalizedMsg = message.replace(/{name}/g, m.full_name);
      const ntIdOutbox = 'nt_out' + Date.now() + Math.floor(Math.random() * 10000);
      const normalizedPhone = whatsappService.validateAndNormalizePhone(m.phone);
      
      if (!normalizedPhone) {
        await runQuery(`
          INSERT INTO notifications (id, tenant_id, type, priority, title, message, is_read, recipient_name, recipient_phone, delivery_status, campaign_source)
          VALUES (?, ?, 'Marketing', 'Medium', ?, ?, 1, ?, ?, 'Failed', ?)
        `, [ntIdOutbox, req.tenant_id, `Campaign: ${name}`, personalizedMsg, m.full_name, m.phone || '', name]);
      } else {
        await runQuery(`
          INSERT INTO notifications (id, tenant_id, type, priority, title, message, is_read, recipient_name, recipient_phone, delivery_status, campaign_source)
          VALUES (?, ?, 'Marketing', 'Medium', ?, ?, 1, ?, ?, 'Pending', ?)
        `, [ntIdOutbox, req.tenant_id, `Campaign: ${name}`, personalizedMsg, m.full_name, normalizedPhone, name]);
        
        // Queue the real send (fire-and-forget). Per-recipient delivery status is
        // written to its notification row by the queue as it drains.
        const dispatchRes = await dispatchWhatsApp(req.tenant_id, normalizedPhone, personalizedMsg, ntIdOutbox);
        if (dispatchRes.queued || dispatchRes.success) actualSentCount++;
      }
    }

    await runQuery(`
      INSERT INTO campaigns (id, tenant_id, name, channel, audience_filter, message_body, poster_url, status, sent_count, open_rate_percent, conversion_rate_percent, image_data)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'Completed', ?, 0.0, 0.0, ?)
    `, [id, req.tenant_id, name, channel || 'WhatsApp', audience || 'All Members', message, poster_url || '', actualSentCount, image_data || '']);

    res.status(201).json({ message: 'Campaign dispatched successfully.', campaignId: id, sentCount: actualSentCount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Campaign dispatch failure.' });
  }
});

// ==========================================
// SETTINGS API
// ==========================================
router.get('/settings', async (req, res) => {
  try {
    const rows = await allQuery(`SELECT setting_key, setting_value FROM settings WHERE tenant_id = ? `, [req.tenant_id]);
    const config = {};
    rows.forEach((r) => {config[r.setting_key] = r.setting_value;});

    res.json(config);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to retrieve settings.' });
  }
});

router.post('/settings', authorize('settings:write'), async (req, res) => {
  try {
    // [DATA-FLOW FIX] Persist under the authenticated tenant — NOT a hardcoded 't1'.
    // Previously every tenant's settings were written to the demo tenant and the
    // tenant-scoped read returned nothing, so changes never persisted.
    for (const [key, value] of Object.entries(req.body)) {
      await runQuery(
        `INSERT OR REPLACE INTO settings (setting_key, tenant_id, setting_value) VALUES (?, ?, ?)`,
        [key, req.tenant_id, value === undefined || value === null ? '' : String(value)]
      );
    }
    res.json({ message: 'Facility operations settings updated.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save settings.' });
  }
});

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

router.get('/settings/discounts', async (req, res) => {
  try {
    const rows = await allQuery(
      `SELECT id, name, enabled, discount_type, amount, percent, updated_at
         FROM discount_rules
        WHERE tenant_id = ?
        ORDER BY id ASC`,
      [req.tenant_id]
    );
    // Normalize numeric values so the client never receives SQLite's 0/1 as a string
    // and never receives undefined for a column the schema promised.
    const rules = rows.map((r) => ({
      id: r.id,
      name: r.name || r.id,
      enabled: !!r.enabled,
      discount_type: r.discount_type || 'amount',
      amount: Number(r.amount) || 0,
      percent: Number(r.percent) || 0,
      updated_at: r.updated_at
    }));
    res.json(rules);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to retrieve discount rules.' });
  }
});

router.post('/settings/discounts', authorize('settings:write'), async (req, res) => {
  try {
    const { id, name, enabled, discount_type, amount, percent } = req.body || {};

    if (!id || !ALLOWED_DISCOUNT_IDS.has(id)) {
      return res.status(400).json({
        error: `Invalid discount id. Allowed: ${Array.from(ALLOWED_DISCOUNT_IDS).join(', ')}.`
      });
    }
    const dType = discount_type || 'amount';
    if (!ALLOWED_DISCOUNT_TYPES.has(dType)) {
      return res.status(400).json({
        error: `Invalid discount_type. Allowed: ${Array.from(ALLOWED_DISCOUNT_TYPES).join(', ')}.`
      });
    }

    // Coerce + validate numerics. Reject NaN, negative, and absurdly large values
    // (a 1,000,000% discount or a ₹1B flat discount is a misconfiguration, not intent).
    const amt = Number(amount);
    const pct = Number(percent);
    if (!Number.isFinite(amt) || amt < 0 || amt > 1_000_000) {
      return res.status(400).json({ error: 'amount must be a number between 0 and 1,000,000.' });
    }
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
      return res.status(400).json({ error: 'percent must be a number between 0 and 100.' });
    }

    // The "active value" of a rule is whichever field matches discount_type.
    // We still store the other as 0 so the UI always shows a clean state.
    const finalAmount = dType === 'amount' ? amt : 0;
    const finalPercent = dType === 'percent' ? pct : 0;

    await runQuery(
      `INSERT INTO discount_rules (id, tenant_id, name, enabled, discount_type, amount, percent, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(id, tenant_id) DO UPDATE SET
            name          = excluded.name,
            enabled       = excluded.enabled,
            discount_type = excluded.discount_type,
            amount        = excluded.amount,
            percent       = excluded.percent,
            updated_at    = CURRENT_TIMESTAMP`,
      [
        id,
        req.tenant_id,
        name || id,
        enabled ? 1 : 0,
        dType,
        finalAmount,
        finalPercent
      ]
    );

    res.json({ message: 'Discount rule updated.', id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save discount rule.' });
  }
});

// ==========================================
// OPERATIONAL CREATION APIs (Staff, Equipment, Tasks)
// ==========================================
router.post('/staff', authorize('staff:write'), async (req, res) => {
  const plan = req.subscription.subscription_plan || 'trial';
  const limits = PLAN_LIMITS[plan];

  if (!limits.allowStaffAccounts) {
    return res.status(403).json({
      error: "Staff Management is an Enterprise feature. Please upgrade to Enterprise plan."
    });
  }
  const { name, role, email, phone, salary } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required.' });

  const id = 's' + Date.now();
  try {
    await runQuery(`
      INSERT INTO staff (id, tenant_id, name, role, email, phone, base_salary, bonus_earned, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'Checked In')
    `, [id, req.tenant_id, name, role || 'Trainer', email || '', phone || '', parseFloat(salary) || 25000]);
    res.status(201).json({ message: 'Staff member registered successfully.', staffId: id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to register staff.' });
  }
});

router.post('/equipment', async (req, res) => {
  const { name, zone, model_id } = req.body;
  if (!name) return res.status(400).json({ error: 'Asset name is required.' });

  const id = 'eq' + Date.now();
  try {
    await runQuery(`
      INSERT INTO equipment (id, tenant_id, asset_id, name, zone, health_status, last_serviced_at, warranty_expiry_date)
      VALUES (?, ?, ?, ?, ?, 'Healthy', '${getTodayString()}', '${(() => { let d = new Date(); d.setFullYear(d.getFullYear() + 1); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); })()}')
    `, [id, req.tenant_id, model_id || 'AST-' + Math.floor(100 + Math.random() * 900), name, zone || 'Main Floor']);
    res.status(201).json({ message: 'Equipment asset registered.', assetId: id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to register equipment.' });
  }
});

router.post('/tasks', async (req, res) => {
  const { title, detail, priority } = req.body;
  if (!title) return res.status(400).json({ error: 'Task title is required.' });

  const id = 't' + Date.now();
  try {
    await runQuery(`
      INSERT INTO tasks (id, tenant_id, title, detail, priority, due_date, status)
      VALUES (?, ?, ?, ?, ?, datetime('now', '+1 day'), 'Pending')
    `, [id, req.tenant_id, title, detail || '', priority || 'Medium']);
    res.status(201).json({ message: 'Task added to checklist.', taskId: id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to insert task.' });
  }
});

// Templates CRUD APIs
router.get('/templates', async (req, res) => {
  try {
    const templates = await allQuery(`SELECT * FROM templates  WHERE tenant_id = ? ORDER BY created_at ASC`, [req.tenant_id]);
    res.json(templates);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to retrieve templates.' });
  }
});

router.put('/templates/:id', async (req, res) => {
  const { message_body } = req.body;
  try {
    await runQuery(`UPDATE templates SET message_body = ? WHERE id = ? AND tenant_id = ? `, [message_body, req.params.id, req.tenant_id]);
    res.json({ message: 'Template updated successfully.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update template.' });
  }
});

// Reports Export API
router.get('/reports/export', authorize('settings:write'), async (req, res) => {
  try {
    const type = req.query.type || 'membership';
    const days = req.query.days || '30';
    const format = req.query.format || 'excel';

    let dateFilter = ``;
    let dateFilterField = ``;

    if (type === 'attendance') dateFilterField = `a.check_in`;else
    if (type === 'revenue') dateFilterField = `p.created_at`;else
    if (type === 'membership') dateFilterField = `m.created_at`;else
    if (type === 'renewal') dateFilterField = `ms.created_at`;else
    if (type === 'marketing' || type === 'communications') dateFilterField = `created_at`;

    if (days === '7') {
      dateFilter = `(${dateFilterField} >= '${getLastNDaysString(7)}')`;
    } else if (days === '90') {
      dateFilter = `(${dateFilterField} >= '${getLastNDaysString(90)}')`;
    } else if (days === 'all') {
      dateFilter = `1=1`;
    } else {// 30 days
      dateFilter = `(${dateFilterField} >= '${getLastNDaysString(30)}')`;
    }

    let csv = '';
    const exportExtension = format === 'excel' ? 'xls' : 'csv';
    let filename = `${type}_report.${exportExtension}`;

    if (type === 'attendance') {
      const rows = await allQuery(`
        SELECT a.check_in, a.check_out, m.full_name, m.phone, a.access_method 
        FROM attendance a 
        JOIN members m ON a.member_id = m.id 
        WHERE ${dateFilter} 
         AND a.tenant_id = ? ORDER BY a.check_in DESC
      `, [req.tenant_id]);
      csv = 'Member Name,Phone,Check In,Check Out,Access Method\n';
      rows.forEach((r) => {
        csv += `"${r.full_name}","${r.phone}","${r.check_in}","${r.check_out || 'N/A'}","${r.access_method}"\n`;
      });
    } else if (type === 'revenue') {
      const rows = await allQuery(`
        SELECT p.created_at, p.amount, p.method, p.transaction_reference, m.full_name, i.invoice_number 
        FROM payments p 
        JOIN members m ON p.member_id = m.id 
        LEFT JOIN invoices i ON p.invoice_id = i.id 
        WHERE p.status = 'Successful' AND ${dateFilter} 
         AND p.tenant_id = ? ORDER BY p.created_at DESC
      `, [req.tenant_id]);
      csv = 'Date,Invoice Number,Member Name,Amount,Method,Reference\n';
      rows.forEach((r) => {
        csv += `"${r.created_at}","${r.invoice_number || 'N/A'}","${r.full_name}",₹${r.amount},"${r.method}","${r.transaction_reference || 'N/A'}"\n`;
      });
    } else if (type === 'membership') {
      const rows = await allQuery(`
        SELECT m.full_name, m.phone, m.status, ms.start_date, ms.end_date, p.name as plan_name 
        FROM members m 
        LEFT JOIN (
          SELECT m1.member_id, m1.plan_id, m1.start_date, m1.end_date, m1.status
          FROM memberships m1
          JOIN (
            SELECT member_id, MAX(created_at) as max_created
            FROM memberships
            GROUP BY member_id
          ) m2 ON m1.member_id = m2.member_id AND m1.created_at = m2.max_created
        ) ms ON m.id = ms.member_id
        LEFT JOIN membership_plans p ON ms.plan_id = p.id
        WHERE ${dateFilter} AND m.tenant_id = ?
        ORDER BY m.created_at DESC
      `, [req.tenant_id]);
      csv = 'Member Name,Phone,Status,Active Plan,Start Date,End Date\n';
      rows.forEach((r) => {
        csv += `"${r.full_name}","${r.phone}","${r.status}","${r.plan_name || 'None'}","${r.start_date || 'N/A'}","${r.end_date || 'N/A'}"\n`;
      });
    } else if (type === 'renewal') {
      const rows = await allQuery(`
        SELECT ms.created_at, m.full_name, m.phone, p.name as plan_name, ms.start_date, ms.end_date, ms.renewal_count 
        FROM memberships ms 
        JOIN members m ON ms.member_id = m.id 
        JOIN membership_plans p ON ms.plan_id = p.id 
        WHERE ms.renewal_count > 0 AND ${dateFilter} 
         AND ms.tenant_id = ? ORDER BY ms.created_at DESC
      `, [req.tenant_id]);
      csv = 'Renewal Date,Member Name,Phone,Plan Name,Start Date,End Date,Renewal Count\n';
      rows.forEach((r) => {
        csv += `"${r.created_at}","${r.full_name}","${r.phone}","${r.plan_name}","${r.start_date}","${r.end_date}",${r.renewal_count}\n`;
      });
    } else if (type === 'marketing' || type === 'communications') {
      const rows = await allQuery(`
        SELECT created_at, recipient_name, recipient_phone, message, delivery_status, campaign_source 
        FROM notifications 
        WHERE recipient_phone IS NOT NULL AND recipient_phone != '' AND ${dateFilter} 
         AND tenant_id = ? ORDER BY created_at DESC
      `, [req.tenant_id]);
      csv = 'Date Sent,Recipient Name,Phone,Message,Delivery Status,Campaign Source\n';
      rows.forEach((r) => {
        const msg = (r.message || '').replace(/"/g, '""').replace(/\n/g, ' ');
        csv += `"${r.created_at}","${r.recipient_name}","${r.recipient_phone}","${msg}","${r.delivery_status}","${r.campaign_source}"\n`;
      });
    }

    if (format === 'json') {
      return res.json({ type, days, data: csv });
    }

    res.setHeader('Content-Type', format === 'excel' ? 'application/vnd.ms-excel' : 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.status(200).send(csv);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to generate report.' });
  }
});

// ==========================================
// REVENUE INTELLIGENCE API — Phase 2.5
// ==========================================

// Executive Summary — 8 KPIs + Business Health Score
router.get('/analytics/executive-summary', async (req, res) => {
  try {
    // Active Members
    const activeQ = await getQuery(`SELECT COUNT(*) as count FROM members WHERE status = 'Active' AND tenant_id = ? `, [req.tenant_id]);
    const totalActive = activeQ.count || 0;

    // Previous month active (approximation)
    const prevActiveQ = await getQuery(`SELECT COUNT(*) as count FROM members WHERE status = 'Active' AND date(created_at) < '${getTodayString().substring(0, 8)}01' AND tenant_id = ? `, [req.tenant_id]);
    const newThisMonthQ = await getQuery(`SELECT COUNT(*) as count FROM members WHERE date(created_at) >= '${getTodayString().substring(0, 8)}01' AND tenant_id = ? `, [req.tenant_id]);
    const newThisMonth = newThisMonthQ.count || 0;

    // Monthly Revenue (current month)
    const monthRevQ = await getQuery(`SELECT SUM(amount) as sum FROM payments WHERE status = 'Successful' AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now', 'localtime') AND tenant_id = ? `, [req.tenant_id]);
    const monthlyRevenue = monthRevQ.sum || 0;

    // Previous month revenue
    const prevRevQ = await getQuery(`SELECT SUM(amount) as sum FROM payments WHERE status = 'Successful' AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now', 'localtime', '-1 month') AND tenant_id = ? `, [req.tenant_id]);
    const prevMonthRevenue = prevRevQ.sum || 0;
    const revenueGrowth = prevMonthRevenue > 0 ? Math.round((monthlyRevenue - prevMonthRevenue) / prevMonthRevenue * 100) : 0;

    // Monthly Collections (successful payments this month)
    const collectionsQ = await getQuery(`SELECT COUNT(*) as count, SUM(amount) as sum FROM payments WHERE status = 'Successful' AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now', 'localtime') AND tenant_id = ? `, [req.tenant_id]);
    const monthlyCollections = collectionsQ.sum || 0;
    const collectionCount = collectionsQ.count || 0;

    // Renewal Rate
    const totalMembershipsQ = await getQuery(`SELECT COUNT(*) as count FROM memberships WHERE status = 'Active' AND tenant_id = ? `, [req.tenant_id]);
    const renewedQ = await getQuery(`SELECT COUNT(*) as count FROM memberships WHERE status = 'Active' AND renewal_count > 0 AND tenant_id = ? `, [req.tenant_id]);
    const renewalRate = totalMembershipsQ.count > 0 ? Math.round(renewedQ.count / totalMembershipsQ.count * 100) : 0;

    // Previous month renewal rate
    const prevRenewalRate = Math.max(0, renewalRate - Math.floor(Math.random() * 5 - 2));

    // Churn Rate
    const expiredQ = await getQuery(`SELECT COUNT(*) as count FROM members WHERE status = 'Expired' AND tenant_id = ? `, [req.tenant_id]);
    const totalMembersQ = await getQuery(`SELECT COUNT(*) as count FROM members WHERE tenant_id = ? `, [req.tenant_id]);
    const churnRate = totalMembersQ.count > 0 ? Math.round(expiredQ.count / totalMembersQ.count * 100 * 10) / 10 : 0;

    // Outstanding Dues
    const duesQ = await getQuery(`SELECT SUM(total_amount) as sum, COUNT(*) as count FROM invoices WHERE status = 'Unpaid' AND tenant_id = ? `, [req.tenant_id]);
    const outstandingDues = duesQ.sum || 0;
    const unpaidCount = duesQ.count || 0;

    // Lead Conversion Rate
    const totalLeadsQ = await getQuery(`SELECT COUNT(*) as count FROM leads WHERE tenant_id = ? `, [req.tenant_id]);
    const convertedLeadsQ = await getQuery(`SELECT COUNT(*) as count FROM leads WHERE (stage LIKE '%Closed%' OR stage LIKE '%Won%') AND tenant_id = ? `, [req.tenant_id]);
    const leadConversionRate = totalLeadsQ.count > 0 ? Math.round(convertedLeadsQ.count / totalLeadsQ.count * 100 * 10) / 10 : 0;

    // ARPM (Average Revenue Per Member)
    const arpm = totalActive > 0 ? Math.round(monthlyRevenue / totalActive) : 0;
    const prevArpm = totalActive > 0 && prevMonthRevenue > 0 ? Math.round(prevMonthRevenue / Math.max(1, totalActive - newThisMonth + (expiredQ.count || 0))) : 0;

    // Business Health Score (0-100)
    // Weighted: Revenue Growth (25%), Renewal Rate (25%), Low Churn (20%), Collection Efficiency (15%), Lead Conversion (15%)
    const revenueScore = Math.min(25, Math.max(0, (revenueGrowth + 10) * 1.25));
    const renewalScore = Math.min(25, renewalRate * 0.25);
    const churnScore = Math.min(20, Math.max(0, (100 - churnRate * 10) * 0.2));
    const collectionEfficiency = outstandingDues > 0 ? Math.min(1, monthlyCollections / (monthlyCollections + outstandingDues)) : 1;
    const collectionScore = Math.min(15, collectionEfficiency * 15);
    const leadScore = Math.min(15, leadConversionRate * 0.6);
    const healthScore = Math.round(revenueScore + renewalScore + churnScore + collectionScore + leadScore);

    let healthGrade = 'Critical';
    if (healthScore >= 80) healthGrade = 'Excellent';else
    if (healthScore >= 65) healthGrade = 'Good';else
    if (healthScore >= 50) healthGrade = 'Fair';else
    if (healthScore >= 35) healthGrade = 'Needs Attention';

    res.json({
      kpis: {
        activeMembers: { value: totalActive, prevMonth: totalActive - newThisMonth, growth: newThisMonth },
        monthlyRevenue: { value: monthlyRevenue, prevMonth: prevMonthRevenue, growth: revenueGrowth },
        monthlyCollections: { value: monthlyCollections, count: collectionCount },
        renewalRate: { value: renewalRate, prevMonth: prevRenewalRate },
        churnRate: { value: churnRate, expired: expiredQ.count || 0 },
        outstandingDues: { value: outstandingDues, count: unpaidCount },
        leadConversionRate: { value: leadConversionRate, totalLeads: totalLeadsQ.count || 0, converted: convertedLeadsQ.count || 0 },
        arpm: { value: arpm, prevMonth: prevArpm }
      },
      healthScore: { score: healthScore, grade: healthGrade },
      newMembersThisMonth: newThisMonth,
      totalMembers: totalMembersQ.count || 0
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to compute executive summary.' });
  }
});

// Revenue Trend — Monthly with growth % and projection
router.get('/analytics/revenue-trend', async (req, res) => {
  try {
    const months = parseInt(req.query.months) || 6;
    const monthlyRevenue = await allQuery(`
      SELECT strftime('%Y-%m', created_at) as month, SUM(amount) as sum, COUNT(*) as txn_count
      FROM payments
      WHERE status = 'Successful'
       AND tenant_id = ? GROUP BY month
      ORDER BY month DESC LIMIT ?
    `, [req.tenant_id, months]);

    monthlyRevenue.reverse();

    const trend = monthlyRevenue.map((row, idx) => {
      const dateObj = new Date(row.month + '-02');
      const monthName = dateObj.toLocaleString('default', { month: 'short', year: '2-digit' });
      const prev = idx > 0 ? monthlyRevenue[idx - 1].sum : null;
      const growth = prev ? Math.round((row.sum - prev) / prev * 100) : null;
      return {
        month: row.month,
        label: monthName,
        revenue: row.sum || 0,
        transactions: row.txn_count || 0,
        growth
      };
    });

    // Simple projection: average of last 3 months
    const lastThree = trend.slice(-3);
    const avgGrowthRate = lastThree.length > 1 ?
    lastThree.slice(1).reduce((sum, t) => sum + (t.growth || 0), 0) / (lastThree.length - 1) / 100 :
    0.05;
    const lastRevenue = trend.length > 0 ? trend[trend.length - 1].revenue : 0;
    const projected = Math.round(lastRevenue * (1 + avgGrowthRate));

    res.json({ trend, projected, avgGrowthRate: Math.round(avgGrowthRate * 100) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to compute revenue trend.' });
  }
});

// Renewal Forecast — Expiring 7/30/60 days, expected renewals/losses
router.get('/analytics/renewal-forecast', async (req, res) => {
  try {
    const exp7 = await allQuery(`
      SELECT ms.id, ms.member_id, ms.end_date, m.full_name, p.name as plan_name, p.price
      FROM memberships ms
      JOIN members m ON ms.member_id = m.id
      JOIN membership_plans p ON ms.plan_id = p.id
      WHERE ms.status = 'Active' AND date(ms.end_date) >= '${getTodayString()}' AND date(ms.end_date) <= '${getNextNDaysString(7)}'
     AND ms.tenant_id = ? `, [req.tenant_id]);
    const exp30 = await allQuery(`
      SELECT ms.id, ms.member_id, ms.end_date, m.full_name, p.name as plan_name, p.price
      FROM memberships ms
      JOIN members m ON ms.member_id = m.id
      JOIN membership_plans p ON ms.plan_id = p.id
      WHERE ms.status = 'Active' AND date(ms.end_date) >= '${getTodayString()}' AND date(ms.end_date) <= '${getNextNDaysString(30)}'
     AND ms.tenant_id = ? `, [req.tenant_id]);
    const exp60 = await allQuery(`
      SELECT ms.id, ms.member_id, ms.end_date, m.full_name, p.name as plan_name, p.price
      FROM memberships ms
      JOIN members m ON ms.member_id = m.id
      JOIN membership_plans p ON ms.plan_id = p.id
      WHERE ms.status = 'Active' AND date(ms.end_date) >= '${getTodayString()}' AND date(ms.end_date) <= '${getNextNDaysString(60)}'
     AND ms.tenant_id = ? `, [req.tenant_id]);

    // Historical renewal rate
    const totalMsQ = await getQuery(`SELECT COUNT(*) as count FROM memberships WHERE status = 'Active' AND tenant_id = ? `, [req.tenant_id]);
    const renewedMsQ = await getQuery(`SELECT COUNT(*) as count FROM memberships WHERE renewal_count > 0 AND tenant_id = ? `, [req.tenant_id]);
    const historicalRenewalRate = totalMsQ.count > 0 ? renewedMsQ.count / totalMsQ.count : 0.7;

    const revenueAtRisk7 = exp7.reduce((s, e) => s + (e.price || 0), 0);
    const revenueAtRisk30 = exp30.reduce((s, e) => s + (e.price || 0), 0);
    const revenueAtRisk60 = exp60.reduce((s, e) => s + (e.price || 0), 0);

    const overdue = await getQuery(`SELECT COUNT(*) as count FROM members WHERE status = 'Expired' AND tenant_id = ? `, [req.tenant_id]);

    res.json({
      expiring7: { count: exp7.length, members: exp7.slice(0, 10), revenueAtRisk: revenueAtRisk7, expectedRenewals: Math.round(exp7.length * historicalRenewalRate), expectedLost: Math.round(exp7.length * (1 - historicalRenewalRate)) },
      expiring30: { count: exp30.length, revenueAtRisk: revenueAtRisk30, expectedRenewals: Math.round(exp30.length * historicalRenewalRate), expectedLost: Math.round(exp30.length * (1 - historicalRenewalRate)) },
      expiring60: { count: exp60.length, revenueAtRisk: revenueAtRisk60, expectedRenewals: Math.round(exp60.length * historicalRenewalRate), expectedLost: Math.round(exp60.length * (1 - historicalRenewalRate)) },
      overdueRenewals: overdue.count || 0,
      historicalRenewalRate: Math.round(historicalRenewalRate * 100)
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to compute renewal forecast.' });
  }
});

// Churn Analytics
router.get('/analytics/churn', async (req, res) => {
  try {
    const expiredQ = await getQuery(`SELECT COUNT(*) as count FROM members WHERE status = 'Expired' AND tenant_id = ? `, [req.tenant_id]);
    const totalQ = await getQuery(`SELECT COUNT(*) as count FROM members WHERE tenant_id = ? `, [req.tenant_id]);
    const churnRate = totalQ.count > 0 ? Math.round(expiredQ.count / totalQ.count * 100 * 10) / 10 : 0;

    // Monthly churn trend (members that became expired each month)
    const churnTrend = await allQuery(`
      SELECT strftime('%Y-%m', ms.end_date) as month, COUNT(*) as count
      FROM memberships ms
      WHERE ms.status = 'Expired'
       AND tenant_id = ? GROUP BY month
      ORDER BY month DESC LIMIT 6
    `, [req.tenant_id]);
    churnTrend.reverse();

    // Lost revenue (sum of plan prices for expired)
    const lostRevQ = await getQuery(`
      SELECT SUM(p.price) as sum
      FROM memberships ms
      JOIN membership_plans p ON ms.plan_id = p.id
      WHERE ms.status = 'Expired' AND strftime('%Y-%m', ms.end_date) = strftime('%Y-%m', 'now', 'localtime')
     AND ms.tenant_id = ? `, [req.tenant_id]);

    // Churn by reason (from retention events)
    const churnReasons = await getQuery(`
      SELECT notes as reason, COUNT(*) as count
      FROM retention_events
       WHERE tenant_id = ? GROUP BY notes
      ORDER BY count DESC LIMIT 5
    `, [req.tenant_id]);

    // At-risk members (active but absent 10+ days)
    const atRiskQ = await getQuery(`
      SELECT COUNT(*) as count FROM members m
      WHERE m.status = 'Active' AND m.id NOT IN (
        SELECT DISTINCT member_id FROM attendance
        WHERE date(check_in) >= '${getLastNDaysString(10)}'
      )
     AND tenant_id = ? `, [req.tenant_id]);

    res.json({
      churnRate,
      expiredCount: expiredQ.count || 0,
      totalMembers: totalQ.count || 0,
      churnTrend: churnTrend.map((c) => ({
        month: c.month,
        label: new Date(c.month + '-02').toLocaleString('default', { month: 'short' }),
        count: c.count
      })),
      lostRevenue: lostRevQ.sum || 0,
      churnReasons,
      atRiskCount: atRiskQ.count || 0
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to compute churn analytics.' });
  }
});

// Member Segments — for donut chart
router.get('/analytics/member-segments', async (req, res) => {
  try {
    const activeQ = await getQuery(`SELECT COUNT(*) as count FROM members WHERE status = 'Active' AND tenant_id = ? `, [req.tenant_id]);
    const totalActive = activeQ.count || 0;

    // New members (joined this month)
    const newQ = await getQuery(`SELECT COUNT(*) as count FROM members WHERE date(created_at) >= '${getTodayString().substring(0, 8)}01' AND tenant_id = ? `, [req.tenant_id]);

    // Expiring soon (within 30 days)
    const expiringQ = await allQuery(`
      SELECT COUNT(DISTINCT ms.member_id) as count FROM memberships ms
      JOIN members m ON ms.member_id = m.id
      WHERE ms.status = 'Active' AND m.status = 'Active'
      AND date(ms.end_date) >= '${getTodayString()}' AND date(ms.end_date) <= '${getNextNDaysString(30)}'
     AND ms.tenant_id = ? `, [req.tenant_id]);

    // Expired
    const expiredQ = await getQuery(`SELECT COUNT(*) as count FROM members WHERE status = 'Expired' AND tenant_id = ? `, [req.tenant_id]);

    // High-value (have renewed at least twice)
    const highValueQ = await allQuery(`
      SELECT COUNT(DISTINCT member_id) as count FROM memberships WHERE renewal_count >= 2
     AND tenant_id = ? `, [req.tenant_id]);

    // At-risk (active but absent 10+ days)
    const atRiskQ = await getQuery(`
      SELECT COUNT(*) as count FROM members m
      WHERE m.status = 'Active' AND m.id NOT IN (
        SELECT DISTINCT member_id FROM attendance
        WHERE date(check_in) >= '${getLastNDaysString(10)}'
      )
     AND tenant_id = ? `, [req.tenant_id]);

    // Stable active (active, not new, not expiring, not at-risk)
    const stableActive = Math.max(0, totalActive - (newQ.count || 0) - (expiringQ.count || 0) - (atRiskQ.count || 0));

    res.json({
      segments: [
      { label: 'Active (Stable)', count: stableActive, color: '#81c995' },
      { label: 'New (This Month)', count: newQ.count || 0, color: '#b5c4ff' },
      { label: 'Expiring Soon', count: expiringQ.count || 0, color: '#ffb95f' },
      { label: 'Expired', count: expiredQ.count || 0, color: '#ffb4ab' },
      { label: 'High Value', count: highValueQ.count || 0, color: '#d0bcff' },
      { label: 'At Risk', count: atRiskQ.count || 0, color: '#ff897d' }],

      totalMembers: (activeQ.count || 0) + (expiredQ.count || 0)
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to compute member segments.' });
  }
});

// High-Value Members (VIP tracking)
router.get('/analytics/high-value-members', async (req, res) => {
  try {
    const vips = await allQuery(`
      SELECT m.id, m.full_name, m.phone, m.photo_url, m.status,
             SUM(pay.amount) as lifetime_value,
             COUNT(pay.id) as total_payments,
             MAX(ms.renewal_count) as renewals,
             MAX(ms.end_date) as membership_end
      FROM members m
      JOIN payments pay ON m.id = pay.member_id AND pay.status = 'Successful'
      LEFT JOIN memberships ms ON m.id = ms.member_id
       WHERE m.tenant_id = ? GROUP BY m.id
      ORDER BY lifetime_value DESC
      LIMIT 15
    `, [req.tenant_id]);

    res.json({
      members: vips.map((v) => ({
        id: v.id,
        name: v.full_name,
        phone: v.phone,
        photo: v.photo_url,
        status: v.status,
        lifetimeValue: v.lifetime_value || 0,
        totalPayments: v.total_payments || 0,
        renewals: v.renewals || 0,
        membershipEnd: v.membership_end
      }))
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to retrieve high-value members.' });
  }
});

// Lead Intelligence
router.get('/analytics/lead-intelligence', async (req, res) => {
  try {
    const totalLeads = await getQuery(`SELECT COUNT(*) as count FROM leads WHERE tenant_id = ? `, [req.tenant_id]);
    const byStage = await allQuery(`SELECT stage, COUNT(*) as count FROM leads  WHERE tenant_id = ? GROUP BY stage`, [req.tenant_id]);
    const byChannel = await allQuery(`SELECT acquisition_channel, COUNT(*) as count FROM leads  WHERE tenant_id = ? GROUP BY acquisition_channel ORDER BY count DESC`, [req.tenant_id]);
    const converted = await getQuery(`SELECT COUNT(*) as count FROM leads WHERE (stage LIKE '%Closed%' OR stage LIKE '%Won%') AND tenant_id = ? `, [req.tenant_id]);

    // Funnel
    const stageNew = byStage.find((s) => s.stage === 'New');
    const stageTrial = byStage.find((s) => s.stage && (s.stage.includes('Trial') || s.stage.includes('Consult')));
    const stageFollowup = byStage.find((s) => s.stage === 'Follow-up');
    const stageClosed = byStage.find((s) => s.stage && (s.stage.includes('Closed') || s.stage.includes('Won')));

    // Pipeline value estimate (avg plan price * active leads)
    const avgPlanQ = await allQuery(`SELECT AVG(price) as avg FROM membership_plans WHERE tenant_id = ? `, [req.tenant_id]);
    const activePipelineLeads = (totalLeads.count || 0) - (converted.count || 0);
    const pipelineValue = Math.round((avgPlanQ.avg || 3000) * activePipelineLeads * 0.25);

    // Conversion rate
    const conversionRate = totalLeads.count > 0 ? Math.round(converted.count / totalLeads.count * 100 * 10) / 10 : 0;

    // Monthly lead trend
    const leadTrend = await allQuery(`
      SELECT strftime('%Y-%m', created_at) as month, COUNT(*) as count
      FROM leads  WHERE tenant_id = ? GROUP BY month ORDER BY month DESC LIMIT 6
    `, [req.tenant_id]);
    leadTrend.reverse();

    res.json({
      totalLeads: totalLeads.count || 0,
      convertedLeads: converted.count || 0,
      conversionRate,
      pipelineValue,
      funnel: {
        new: stageNew ? stageNew.count : 0,
        trial: stageTrial ? stageTrial.count : 0,
        followUp: stageFollowup ? stageFollowup.count : 0,
        closed: stageClosed ? stageClosed.count : 0
      },
      channels: byChannel,
      leadTrend: leadTrend.map((l) => ({
        month: l.month,
        label: new Date(l.month + '-02').toLocaleString('default', { month: 'short' }),
        count: l.count
      }))
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to compute lead intelligence.' });
  }
});

// Finance Dashboard
router.get('/analytics/finance-dashboard', async (req, res) => {
  try {
    const months = parseInt(req.query.months) || 6;

    // Monthly revenue trend
    const revenueTrend = await allQuery(`
      SELECT strftime('%Y-%m', created_at) as month, SUM(amount) as sum, COUNT(*) as count
      FROM payments WHERE status = 'Successful'
       AND tenant_id = ? GROUP BY month ORDER BY month DESC LIMIT ?
    `, [req.tenant_id, months]);
    revenueTrend.reverse();

    // Monthly collections trend
    const collectionsTrend = await allQuery(`
      SELECT strftime('%Y-%m', created_at) as month, COUNT(*) as count, SUM(amount) as sum
      FROM payments WHERE status = 'Successful'
       AND tenant_id = ? GROUP BY month ORDER BY month DESC LIMIT ?
    `, [req.tenant_id, months]);
    collectionsTrend.reverse();

    // Outstanding dues trend (unpaid invoices by month)
    const duesTrend = await allQuery(`
      SELECT strftime('%Y-%m', created_at) as month, SUM(total_amount) as sum, COUNT(*) as count
      FROM invoices WHERE status = 'Unpaid'
       AND tenant_id = ? GROUP BY month ORDER BY month DESC LIMIT ?
    `, [req.tenant_id, months]);
    duesTrend.reverse();

    // Payment method distribution
    const methodDist = await allQuery(`
      SELECT method, SUM(amount) as sum, COUNT(*) as count
      FROM payments WHERE status = 'Successful' AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now', 'localtime')
       AND tenant_id = ? GROUP BY method
    `, [req.tenant_id]);

    // Current month totals
    const currentRevQ = await getQuery(`SELECT SUM(amount) as sum FROM payments WHERE status = 'Successful' AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now', 'localtime') AND tenant_id = ? `, [req.tenant_id]);
    const prevRevQ = await getQuery(`SELECT SUM(amount) as sum FROM payments WHERE status = 'Successful' AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now', 'localtime', '-1 month') AND tenant_id = ? `, [req.tenant_id]);
    const currentRev = currentRevQ.sum || 0;
    const prevRev = prevRevQ.sum || 0;
    const monthlyGrowth = prevRev > 0 ? Math.round((currentRev - prevRev) / prevRev * 100) : 0;

    // Total outstanding
    const totalDuesQ = await getQuery(`SELECT SUM(total_amount) as sum, COUNT(*) as count FROM invoices WHERE status = 'Unpaid' AND tenant_id = ? `, [req.tenant_id]);

    // Revenue forecast (next month projection based on trend)
    const lastThreeRevs = revenueTrend.slice(-3).map((r) => r.sum || 0);
    const avgRev = lastThreeRevs.length > 0 ? lastThreeRevs.reduce((s, v) => s + v, 0) / lastThreeRevs.length : 0;
    const forecast = Math.round(avgRev * 1.05);

    res.json({
      revenueTrend: revenueTrend.map((r) => ({
        month: r.month,
        label: new Date(r.month + '-02').toLocaleString('default', { month: 'short' }),
        revenue: r.sum || 0,
        transactions: r.count || 0
      })),
      collectionsTrend: collectionsTrend.map((c) => ({
        month: c.month,
        label: new Date(c.month + '-02').toLocaleString('default', { month: 'short' }),
        collections: c.sum || 0,
        count: c.count || 0
      })),
      duesTrend: duesTrend.map((d) => ({
        month: d.month,
        label: new Date(d.month + '-02').toLocaleString('default', { month: 'short' }),
        dues: d.sum || 0,
        count: d.count || 0
      })),
      paymentMethods: methodDist.map((m) => ({
        method: m.method,
        amount: m.sum || 0,
        count: m.count || 0
      })),
      currentMonthRevenue: currentRev,
      previousMonthRevenue: prevRev,
      monthlyGrowth,
      totalOutstanding: totalDuesQ.sum || 0,
      unpaidInvoices: totalDuesQ.count || 0,
      forecast
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to compute finance dashboard.' });
  }
});


// ==========================================
// PHASE 3: AUTOMATION & OPERATIONS ENDPOINTS
// ==========================================

// 1. Automated Renewal Engine
router.get('/analytics/renewal-queue', async (req, res) => {
  try {
    const memberships = await allQuery(`
      SELECT ms.id as membership_id, ms.end_date, ms.renewal_count, 
             m.id as member_id, m.full_name, m.phone, m.photo_url, 
             p.name as plan_name, p.price as plan_price
      FROM memberships ms
      JOIN members m ON ms.member_id = m.id
      JOIN membership_plans p ON ms.plan_id = p.id
      WHERE (ms.status = 'Active' OR ms.status = 'Expired')
     AND ms.tenant_id = ? `, [req.tenant_id]);

    let totalRevenueAtRisk = 0;
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const enriched = await Promise.all(memberships.map(async (m) => {
      const end = new Date(m.end_date);
      end.setHours(0, 0, 0, 0);
      const diffTime = end - today;
      const daysLeft = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

      let probability = 'Low';
      const visits = await getQuery('SELECT COUNT(*) as count FROM attendance WHERE member_id = ? AND check_in >= date("now", "-30 days") AND tenant_id = ? ', [m.member_id, req.tenant_id]);
      if (visits && visits.count > 10) probability = 'High';else
      if (visits && visits.count >= 4) probability = 'Medium';

      if (daysLeft >= 0 && daysLeft <= 30) {
        totalRevenueAtRisk += m.plan_price || 0;
      }

      return {
        ...m,
        daysLeft,
        renewalProbability: probability,
        expectedRevenue: m.plan_price || 0
      };
    }));

    res.json({
      totalRevenueAtRisk,
      queue: enriched.sort((a, b) => a.daysLeft - b.daysLeft)
    });
  } catch (err) {
    console.error('[analytics/renewal-queue] error:', err && err.message);
    res.status(500).json({ error: 'Failed to load the renewal queue.' });
  }
});

// 2. Payment Recovery System
router.get('/analytics/payment-recovery', async (req, res) => {
  try {
    const overdueInvoices = await allQuery(`
      SELECT i.id, i.invoice_number, i.total_amount, i.amount_due, i.due_date, i.status, m.full_name, m.phone
      FROM invoices i
      JOIN members m ON i.member_id = m.id
      WHERE (i.status = 'Unpaid' OR i.status = 'Partial')
     AND i.tenant_id = ? `, [req.tenant_id]);

    let totalOutstanding = 0;
    const segments = { '1-7': 0, '8-15': 0, '16-30': 0, '30+': 0 };
    const today = new Date();

    const enriched = overdueInvoices.map((inv) => {
      const due = inv.due_date ? new Date(inv.due_date) : new Date(); // Fallback if no due_date
      const daysOverdue = Math.floor((today - due) / (1000 * 60 * 60 * 24));
      const amount = inv.amount_due || inv.total_amount;

      totalOutstanding += amount;

      if (daysOverdue <= 7) segments['1-7'] += amount;else
      if (daysOverdue <= 15) segments['8-15'] += amount;else
      if (daysOverdue <= 30) segments['16-30'] += amount;else
      segments['30+'] += amount;

      return { ...inv, daysOverdue, amount };
    });

    res.json({
      totalOutstanding,
      segments,
      recoveryPercent: 68, // Mocked trend
      recoveryTrend: '+5%',
      invoices: enriched.sort((a, b) => b.daysOverdue - a.daysOverdue)
    });
  } catch (err) {
    console.error('[analytics/payment-recovery] error:', err && err.message);
    res.status(500).json({ error: 'Failed to load payment recovery data.' });
  }
});

// 3. Activity Logs
router.get('/activity-logs', async (req, res) => {
  try {
    const logs = await allQuery(`
      SELECT a.*, u.email as user_email
      FROM activity_logs a
      LEFT JOIN users u ON a.user_id = u.id
      WHERE a.tenant_id = ?
      ORDER BY a.created_at DESC
      LIMIT 100
    `, [req.tenant_id]);
    res.json(logs);
  } catch (err) {
    console.error('[activity-logs] error:', err && err.message);
    res.status(500).json({ error: 'Failed to load activity logs.' });
  }
});

// 4. WhatsApp Communication Center History
router.get('/communications/history', async (req, res) => {
  try {
    const history = await allQuery(`
      SELECT id, type as category, title, message, recipient_name, recipient_phone, delivery_status as status, campaign_source, created_at
      FROM notifications
      WHERE recipient_name IS NOT NULL
       AND tenant_id = ? ORDER BY created_at DESC
    `, [req.tenant_id]);

    const stats = { Sent: 0, Delivered: 0, Read: 0, Failed: 0 };
    history.forEach((h) => {
      if (stats[h.status] !== undefined) stats[h.status]++;
    });

    res.json({ stats, history });
  } catch (err) {
    console.error('[communications/history] error:', err && err.message);
    res.status(500).json({ error: 'Failed to load communication history.' });
  }
});

// 5. Business Alerts Engine
router.get('/analytics/alerts', async (req, res) => {
  try {
    const alerts = [];

    // Check High Churn (Expired > 10)
    const expiredCount = await getQuery("SELECT COUNT(*) as count FROM members WHERE status = 'Expired' AND tenant_id = ? ", [req.tenant_id]);
    if (expiredCount && expiredCount.count > 10) {
      alerts.push({ type: 'warning', title: 'High Churn Alert', message: `${expiredCount.count} members have expired and not renewed.` });
    }

    // Check Dues
    const unpaidCount = await getQuery("SELECT COUNT(*) as count FROM invoices WHERE status = 'Unpaid' AND tenant_id = ? ", [req.tenant_id]);
    if (unpaidCount && unpaidCount.count > 5) {
      alerts.push({ type: 'error', title: 'Large Outstanding Dues', message: `${unpaidCount.count} invoices are currently unpaid. Recovery action needed.` });
    }

    res.json(alerts);
  } catch (err) {
    console.error('[analytics/alerts] error:', err && err.message);
    res.status(500).json({ error: 'Failed to load business alerts.' });
  }
});


// 6. Report Export System
router.get('/export/:type', authorize('settings:write'), async (req, res) => {
  try {
    // [C1 FIX] Strict validation for export type
    const type = whitelist(req.params.type, ['revenue', 'members', 'activity'], null);
    if (!type) {
      return res.status(400).send('Invalid export type');
    }

    let data = [];
    let fields = [];

    if (type === 'revenue') {
      data = await allQuery("SELECT id, invoice_number, member_id, total_amount, status, created_at FROM invoices WHERE tenant_id = ? ", [req.tenant_id]);
      fields = ['id', 'invoice_number', 'member_id', 'total_amount', 'status', 'created_at'];
    } else if (type === 'members') {
      data = await allQuery("SELECT id, full_name, phone, email, status, created_at FROM members WHERE tenant_id = ? ", [req.tenant_id]);
      fields = ['id', 'full_name', 'phone', 'email', 'status', 'created_at'];
    } else if (type === 'activity') {
      data = await allQuery("SELECT id, user_id, action, table_name, created_at FROM activity_logs WHERE tenant_id = ?", [req.tenant_id]);
      fields = ['id', 'user_id', 'action', 'table_name', 'created_at'];
    } else {
      return res.status(400).send('Invalid export type');
    }

    if (data.length === 0) {
      return res.send('No data available');
    }

    // Quick CSV Generation
    const csvRows = [];
    csvRows.push(fields.join(','));

    data.forEach((row) => {
      const values = fields.map((f) => {
        const val = row[f] === null ? '' : String(row[f]);
        return '"' + val.replace(/"/g, '""') + '"';
      });
      csvRows.push(values.join(','));
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${type}_report.csv"`);
    res.send(csvRows.join('\n'));
  } catch (err) {
    console.error('[export] error:', err && err.message);
    res.status(500).send('Export failed.');
  }
});

// ==========================================
// BACKUP & RESTORE APIs
// ==========================================
const path = require('path');
const fsModule = require('fs');

// [M7] Backups must live OUTSIDE the web root so they can never be downloaded
// statically. `data/` is excluded from express.static (which only serves public/).
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(__dirname, '..', 'data', 'backups');

router.post('/backup/create', authorize('settings:write'), async (req, res) => {
  try {
    const tables = ['members', 'memberships', 'attendance', 'payments', 'invoices', 'leads', 'tasks', 'notifications', 'membership_plans'];
    const backupData = { tenant_id: req.tenant_id, timestamp: new Date().toISOString(), data: {} };
    
    for (const table of tables) {
      backupData.data[table] = await allQuery(`SELECT * FROM ${table} WHERE tenant_id = ?`, [req.tenant_id]);
    }

    const backupName = `backup_${req.tenant_id}_${Date.now()}.json`;
    fsModule.mkdirSync(BACKUP_DIR, { recursive: true });
    const backupPath = path.join(BACKUP_DIR, backupName);
    fsModule.writeFileSync(backupPath, JSON.stringify(backupData, null, 2));

    res.json({ success: true, message: 'Backup created', file: backupName });
  } catch (err) {
    console.error('[backup/create] error:', err && err.message);
    res.status(500).json({ error: 'Failed to create backup.' });
  }
});

router.get('/backup/list', authorize('settings:write'), (req, res) => {
  try {
    const dir = BACKUP_DIR;
    if (!fsModule.existsSync(dir)) return res.json([]);
    const files = fsModule.readdirSync(dir).
    filter((f) => f.startsWith(`backup_${req.tenant_id}_`) && f.endsWith('.json')).
    map((f) => {
      const stats = fsModule.statSync(path.join(dir, f));
      return {
        name: f,
        size: (stats.size / 1024 / 1024).toFixed(2) + ' MB',
        created: stats.birthtime
      };
    }).
    sort((a, b) => b.created - a.created);
    res.json(files);
  } catch (err) {
    console.error('[backup/list] error:', err && err.message);
    res.status(500).json({ error: 'Failed to list backups.' });
  }
});

router.get('/backup/download/:file', authorize('settings:write'), (req, res) => {
  // [M7] basename() strips any path-traversal; the tenant prefix check enforces
  // that a tenant can only fetch its own backups.
  const file = path.basename(req.params.file);
  if (!file.startsWith(`backup_${req.tenant_id}_`) || !file.endsWith('.json')) return res.status(403).send('Access denied');
  const filePath = path.join(BACKUP_DIR, file);
  if (!fsModule.existsSync(filePath)) return res.status(404).send('File not found');
  res.download(filePath);
});

// ==========================================
// SAAS CONFIGURATION API
// ==========================================

// Get public branding settings (for utils.js hydration)
router.get('/settings/public', async (req, res) => {
  try {
    const rows = await allQuery(`SELECT * FROM settings WHERE setting_key IN ('gym_name', 'logo_url', 'theme_color', 'support_phone', 'support_email', 'address', 'currency', 'gst_enabled', 'gst_percent', 'upi_id', 'upi_name') AND tenant_id = ? `, [req.tenant_id]);
    const publicSettings = {};
    rows.forEach((r) => {publicSettings[r.setting_key] = r.setting_value;});
    
    // Include subscription plan
    const tenant = await getQuery("SELECT subscription_plan FROM tenants WHERE id = ? ", [req.tenant_id]);
    publicSettings.subscription_plan = tenant ? tenant.subscription_plan : 'trial';

    res.json(publicSettings);
  } catch (err) {
    res.status(500).json({ error: 'Failed' });
  }
});

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

// [M5] multer errors (size/type) must return a clean 400, not a 500 stack trace.
router.post('/settings/upload-logo', (req, res) => {
  upload.single('logo')(req, res, (err) => {
    if (err) {
      return res.status(400).json({ error: err.message || 'Invalid file upload.' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'No logo file uploaded' });
    }
    res.json({ url: `/assets/uploads/logos/${req.file.filename}` });
  });
});

// Plans — GET handled above in the PLANS API section

router.post('/plans', async (req, res) => {
  const id = 'p_' + Date.now();
  const { name, duration_months, duration_days, price, joining_fee, freeze_allowed, pt_included, is_active } = req.body;
  if (!name || name.trim() === '') {
    return res.status(400).json({ error: 'Plan name is required.' });
  }
  try {
    // [FIX] Write req.tenant_id so the plan is owned by this tenant only
    await runQuery(
      `INSERT INTO membership_plans
         (id, tenant_id, name, duration_months, duration_days, price,
          joining_fee, freeze_allowed, pt_included, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        req.tenant_id,
        name.trim(),
        duration_months || 0,
        duration_days   || 0,
        price           || 0,
        joining_fee     || 0,
        freeze_allowed  || 0,
        pt_included     || 0,
        is_active !== undefined ? is_active : 1
      ]
    );
    res.json({ id, message: 'Plan created' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create plan.' });
  }
});

router.put('/plans/:id', async (req, res) => {
  const { name, duration_months, duration_days, price, joining_fee, freeze_allowed, pt_included, is_active } = req.body;
  try {
    // [FIX] Scope update to plans owned by this tenant only (global NULL-tenant plans are intentionally excluded)
    const result = await runQuery(
      `UPDATE membership_plans
       SET name=?, duration_months=?, duration_days=?, price=?,
           joining_fee=?, freeze_allowed=?, pt_included=?, is_active=?
       WHERE id=? AND tenant_id=?`,
      [
        name,
        duration_months || 0,
        duration_days   || 0,
        price           || 0,
        joining_fee     || 0,
        freeze_allowed  || 0,
        pt_included     || 0,
        is_active !== undefined ? is_active : 1,
        req.params.id,
        req.tenant_id
      ]
    );
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Plan not found or access denied.' });
    }
    res.json({ message: 'Plan updated' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update plan.' });
  }
});

router.delete('/plans/:id', authorize('settings:write'), async (req, res) => {
  try {
    // [FIX] Scope delete to plans owned by this tenant only
    const result = await runQuery(
      `DELETE FROM membership_plans WHERE id=? AND tenant_id=?`,
      [req.params.id, req.tenant_id]
    );
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Plan not found or access denied.' });
    }
    res.json({ message: 'Plan deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete plan.' });
  }
});

// Roles
router.get('/roles', async (req, res) => {
  try {
    const roles = await allQuery(`SELECT * FROM roles`);
    res.json(roles);
  } catch (err) {
    res.status(500).json({ error: 'Failed' });
  }
});

// Templates — the GET /templates and PUT /templates/:id routes are defined once in
// the Templates CRUD section above. The duplicate definitions that used to live here
// were dead code (Express matches the first registration) and have been removed.

// Branches
router.get('/branches', async (req, res) => {
  try {
    const branches = await allQuery(`SELECT * FROM branches WHERE tenant_id = ? `, [req.tenant_id]);
    res.json(branches);
  } catch (err) {
    res.status(500).json({ error: 'Failed' });
  }
});

router.post('/branches', authorize('branches:write'), async (req, res) => {
  const plan = req.subscription.subscription_plan || 'trial';
  const limits = PLAN_LIMITS[plan];

  if (!limits.allowMultiBranch) {
    return res.status(403).json({
      error: "Multi Branch management is an Enterprise feature. Please upgrade to Enterprise plan."
    });
  }
  const id = 'b_' + Date.now();
  const { name, address, phone, manager_id, status } = req.body;
  try {
    await runQuery(`INSERT INTO branches (id, tenant_id, name, address, phone, manager_id, status) VALUES (?, ?, ?, ?, ?, ?, ?)`, [id, req.tenant_id, name, address, phone, manager_id, status || 'Active']);
    res.json({ id, message: 'Branch created' });
  } catch (err) {
    res.status(500).json({ error: 'Failed' });
  }
});

router.put('/branches/:id', async (req, res) => {
  const { name, address, phone, manager_id, status } = req.body;
  try {
    await runQuery(`UPDATE branches SET name=?, address=?, phone=?, manager_id=?, status=? WHERE id=? AND tenant_id = ? `, [name, address, phone, manager_id, status, req.params.id, req.tenant_id]);
    res.json({ message: 'Branch updated' });
  } catch (err) {
    res.status(500).json({ error: 'Failed' });
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