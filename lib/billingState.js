/**
 * Billing State & Enforcement
 * =============================================================================
 * The authoritative, server-side read/write surface for a tenant's subscription
 * ledger (plan tier + WhatsApp credit accounting) plus the feature-gate
 * middleware. Everything billing-related funnels through here so there is ONE
 * definition of "how many messages can this gym still send" and "can this gym
 * use feature X".
 *
 * Credit model (Model B — credits deplete, they don't resurrect):
 *   remaining = max(0, allowance - used) + extra_credits
 *   on send:  if allowance not exhausted -> used++      (counts against the plan)
 *             else if extra_credits > 0  -> extra_credits--   (spends a top-up)
 *   on renew: used -> 0, allowance -> plan allowance, extra_credits CARRIES OVER,
 *             extra_credits_this_cycle -> 0 (the Pro top-up cap is per-cycle).
 * =============================================================================
 */

const { getQuery, runQuery, allQuery } = require('../database');
const { resolvePlan, getPlan, getLimits } = require('./billingPlans');
const crypto = require('crypto');

function nowIso() { return new Date().toISOString(); }
function periodEndIso(days = 30) { return new Date(Date.now() + days * 86400000).toISOString(); }

/** Lazily create the per-tenant subscriptions row (mirrors the boot backfill). */
async function ensureSubscriptionRow(tenantId) {
  let row = await getQuery(`SELECT * FROM subscriptions WHERE tenant_id = ?`, [tenantId]);
  if (row) return row;
  const t = await getQuery(`SELECT subscription_plan, subscription_status, trial_end FROM tenants WHERE id = ?`, [tenantId]);
  const canonical = resolvePlan(t && t.subscription_plan);
  const plan = getPlan(canonical);
  const status = (t && t.subscription_status) || (String(t && t.subscription_plan) === 'trial' ? 'trial' : 'active');
  try {
    await runQuery(
      `INSERT INTO subscriptions (id, tenant_id, plan, status, plan_type, subscription_status,
         whatsapp_message_allowance, whatsapp_message_used, whatsapp_extra_credits, extra_credits_this_cycle,
         has_multiple_gyms, trial_ends_at, current_period_start, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) ON CONFLICT DO NOTHING`,
      ['sub_' + tenantId, tenantId, canonical, status, canonical, status,
       plan.whatsappAllowance, plan.multiGym ? 1 : 0, (t && t.trial_end) || null]
    );
  } catch (e) { /* concurrent insert — fall through to re-read */ }
  return getQuery(`SELECT * FROM subscriptions WHERE tenant_id = ?`, [tenantId]);
}

/**
 * The merged, authoritative billing state for a tenant.
 * @returns {Promise<{plan, planLabel, status, price, allowance, used, extraCredits,
 *   remaining, multiGym, topUpCap, extraPurchasedThisCycle, trialEndsAt, limits,
 *   razorpaySubscriptionId}>}
 */
async function getBillingState(tenantId) {
  const sub = await ensureSubscriptionRow(tenantId);
  const t = await getQuery(
    `SELECT subscription_plan, subscription_status, trial_end, razorpay_subscription_id FROM tenants WHERE id = ?`,
    [tenantId]
  );
  // tenants.subscription_plan is the fast gating read; keep it authoritative for tier.
  const canonical = resolvePlan((t && t.subscription_plan) || (sub && sub.plan_type) || (sub && sub.plan));
  const catalog = getPlan(canonical);
  const allowance = (sub && sub.whatsapp_message_allowance != null) ? sub.whatsapp_message_allowance : catalog.whatsappAllowance;
  const used = (sub && sub.whatsapp_message_used) || 0;
  const extraCredits = (sub && sub.whatsapp_extra_credits) || 0;
  const remaining = Math.max(0, allowance - used) + extraCredits;
  return {
    plan: canonical,
    planLabel: catalog.label,
    status: (t && t.subscription_status) || (sub && sub.subscription_status) || 'active',
    price: catalog.price,
    allowance,
    used,
    extraCredits,
    remaining,
    multiGym: !!(catalog.multiGym),
    topUpCap: catalog.topUpCap,
    extraPurchasedThisCycle: (sub && sub.extra_credits_this_cycle) || 0,
    trialEndsAt: (t && t.trial_end) || (sub && sub.trial_ends_at) || null,
    razorpaySubscriptionId: (t && t.razorpay_subscription_id) || (sub && sub.razorpay_subscription_id) || null,
    limits: getLimits(canonical)
  };
}

/** remaining = max(0, allowance - used) + extra_credits */
function whatsappRemaining(state) {
  if (!state) return 0;
  return Math.max(0, (state.allowance || 0) - (state.used || 0)) + (state.extraCredits || 0);
}

/**
 * Consume ONE WhatsApp message from the ledger (allowance first, then a top-up
 * credit). Atomic-ish two-step on the single shared sqlite connection. Returns the
 * new remaining, or -1 if nothing was available (caller should have pre-checked).
 */
async function consumeWhatsAppCredit(tenantId, n = 1) {
  const sub = await ensureSubscriptionRow(tenantId);
  let allowance = sub.whatsapp_message_allowance || 0;
  let used = sub.whatsapp_message_used || 0;
  let credits = sub.whatsapp_extra_credits || 0;
  for (let i = 0; i < n; i++) {
    if (used < allowance) used += 1;
    else if (credits > 0) credits -= 1;
    else break; // exhausted
  }
  await runQuery(
    `UPDATE subscriptions SET whatsapp_message_used = ?, whatsapp_extra_credits = ?, updated_at = CURRENT_TIMESTAMP WHERE tenant_id = ?`,
    [used, credits, tenantId]
  );
  return Math.max(0, allowance - used) + credits;
}

/** Add purchased top-up credits (and track the per-cycle purchase toward the cap). */
async function addCredits(tenantId, qty) {
  await ensureSubscriptionRow(tenantId);
  const q = Math.max(0, Math.floor(Number(qty) || 0));
  if (!q) return getBillingState(tenantId);
  await runQuery(
    `UPDATE subscriptions
        SET whatsapp_extra_credits = COALESCE(whatsapp_extra_credits, 0) + ?,
            extra_credits_this_cycle = COALESCE(extra_credits_this_cycle, 0) + ?,
            updated_at = CURRENT_TIMESTAMP
      WHERE tenant_id = ?`,
    [q, q, tenantId]
  );
  return getBillingState(tenantId);
}

/**
 * Activate/renew a paid plan: set the tier active on BOTH tenants (gating read)
 * and subscriptions (ledger), and reset the billing cycle (used -> 0, allowance
 * -> plan allowance, per-cycle top-up counter -> 0). extra_credits carry over.
 */
async function activatePlan(tenantId, plan, opts = {}) {
  const canonical = resolvePlan(plan);
  const catalog = getPlan(canonical);
  const nextBilling = periodEndIso(30);
  const status = 'active';

  await runQuery(
    `UPDATE tenants SET subscription_plan = ?, subscription_status = 'active', next_billing_date = ?,
        razorpay_subscription_id = COALESCE(?, razorpay_subscription_id) WHERE id = ?`,
    [canonical, nextBilling, opts.rzpSubId || null, tenantId]
  );

  await ensureSubscriptionRow(tenantId);
  await runQuery(
    `UPDATE subscriptions
        SET plan = ?, plan_type = ?, status = 'active', subscription_status = ?,
            whatsapp_message_allowance = ?, whatsapp_message_used = 0, extra_credits_this_cycle = 0,
            has_multiple_gyms = ?, next_billing_date = ?, current_period_start = CURRENT_TIMESTAMP,
            razorpay_subscription_id = COALESCE(?, razorpay_subscription_id), updated_at = CURRENT_TIMESTAMP
      WHERE tenant_id = ?`,
    [canonical, canonical, status, catalog.whatsappAllowance, catalog.multiGym ? 1 : 0, nextBilling,
     opts.rzpSubId || null, tenantId]
  );

  await runQuery(
    `INSERT INTO subscription_history (id, tenant_id, from_plan, to_plan, action, razorpay_subscription_id, razorpay_payment_id, amount, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ['sh_' + crypto.randomBytes(8).toString('hex'), tenantId, null, canonical, opts.action || 'activate',
     opts.rzpSubId || null, opts.rzpPayId || null, catalog.price, opts.notes || 'Plan activated.']
  );
  return getBillingState(tenantId);
}

/**
 * Renewal (subscription.charged) — new billing period on the SAME plan: reset the
 * usage counters without changing the tier. extra_credits carry over.
 */
async function renewCycle(tenantId, plan) {
  const canonical = resolvePlan(plan);
  const catalog = getPlan(canonical);
  await ensureSubscriptionRow(tenantId);
  await runQuery(
    `UPDATE subscriptions
        SET whatsapp_message_used = 0, extra_credits_this_cycle = 0,
            whatsapp_message_allowance = ?, current_period_start = CURRENT_TIMESTAMP,
            next_billing_date = ?, updated_at = CURRENT_TIMESTAMP
      WHERE tenant_id = ?`,
    [catalog.whatsappAllowance, periodEndIso(30), tenantId]
  );
}

/** Drop a tenant to the free Basic tier (halted/cancelled/trial-expired). */
async function downgradeToBasic(tenantId, reason = 'Downgraded to Basic.') {
  const catalog = getPlan('basic');
  await runQuery(
    `UPDATE tenants SET subscription_plan = 'basic', subscription_status = 'active',
        razorpay_subscription_id = NULL WHERE id = ?`,
    [tenantId]
  );
  await ensureSubscriptionRow(tenantId);
  await runQuery(
    `UPDATE subscriptions
        SET plan = 'basic', plan_type = 'basic', status = 'active', subscription_status = 'active',
            whatsapp_message_allowance = ?, has_multiple_gyms = 0,
            razorpay_subscription_id = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE tenant_id = ?`,
    [catalog.whatsappAllowance, tenantId]
  );
  await runQuery(
    `INSERT INTO subscription_history (id, tenant_id, from_plan, to_plan, action, notes)
     VALUES (?, ?, ?, 'basic', 'downgrade', ?)`,
    ['sh_' + crypto.randomBytes(8).toString('hex'), tenantId, null, reason]
  );
}

/**
 * Daily cron: any tenant whose Pro trial has lapsed WITHOUT an active paid
 * Razorpay subscription is dropped to Basic. Idempotent.
 * @returns {Promise<number>} number downgraded.
 */
async function downgradeExpiredTrials() {
  const now = nowIso();
  const rows = await allQuery(
    `SELECT id FROM tenants
      WHERE (subscription_status = 'trial' OR subscription_plan = 'trial')
        AND trial_end IS NOT NULL AND trial_end < ?
        AND (razorpay_subscription_id IS NULL OR razorpay_subscription_id = '')`,
    [now]
  );
  let count = 0;
  for (const r of rows) {
    try { await downgradeToBasic(r.id, 'Free trial expired without an active subscription.'); count++; }
    catch (e) { console.error('[billing] trial downgrade failed for', r.id, '-', e.message); }
  }
  if (count) console.log(`[billing] Downgraded ${count} expired trial(s) to Basic.`);
  return count;
}

/**
 * Feature-gate middleware factory. Blocks a WRITE when the tenant's plan lacks the
 * capability, returning 403 with an upgrade hint (reads are never gated here — the
 * app's rule is no read-403 "broken shells"; the client shows an in-page upsell).
 * `feature` is a catalog flag: allowGPS | allowWhatsApp | allowCRM | allowAttendance
 * | allowMarketing | allowMultiBranch | allowStaffAccounts | allowAdvancedAnalytics.
 */
function verifySubscriptionBilling(feature, label) {
  return (req, res, next) => {
    const plan = (req.subscription && req.subscription.subscription_plan) || 'trial';
    const limits = getLimits(plan);
    if (limits[feature]) return next();
    return res.status(403).json({
      error: `${label || 'This feature'} is not available on the ${getPlan(plan).label} plan. Upgrade to unlock it.`,
      upgradeRequired: true,
      feature
    });
  };
}

module.exports = {
  ensureSubscriptionRow,
  getBillingState,
  whatsappRemaining,
  consumeWhatsAppCredit,
  addCredits,
  activatePlan,
  renewCycle,
  downgradeToBasic,
  downgradeExpiredTrials,
  verifySubscriptionBilling
};
