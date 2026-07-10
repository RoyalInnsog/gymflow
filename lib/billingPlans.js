/**
 * Billing Plan Catalog — single source of truth for tiers, prices, WhatsApp
 * allowances and feature gates.
 * =============================================================================
 * Tiers (spec 2026-07-10):
 *   basic            ₹0     free-for-life   0 WhatsApp    (no GPS/WhatsApp/CRM/Attendance)
 *   pro              ₹499   /month          200 WhatsApp  top-up cap 100/cycle
 *   enterprise_low   ₹999   /month          500 WhatsApp  + multi-gym
 *   enterprise_high  ₹3999  /month          1500 WhatsApp + multi-gym
 *
 * `trial` is a 7-day trial of PRO — same features/allowance as pro, but with
 * subscription_status = 'trial' (downgraded to basic on expiry if unpaid).
 *
 * Legacy aliases (existing rows/endpoints referenced these): 'enterprise' →
 * enterprise_low, 'trial' → pro-level access. resolvePlan() normalizes them.
 * =============================================================================
 */

// Canonical catalog. flags gate WRITE endpoints (reads stay open, per the app's
// "no read-403 broken shells" rule). topUpCap = max purchasable extra credits per
// billing cycle (0 = top-ups not allowed; Infinity = unlimited).
const PLAN_CATALOG = {
  basic: {
    key: 'basic',
    label: 'Basic',
    price: 0,
    whatsappAllowance: 0,
    maxMembers: 500,
    topUpCap: 0,
    multiGym: false,
    razorpayPlanEnv: null,           // free — no recurring mandate
    flags: {
      allowGPS: false,
      allowWhatsApp: false,
      allowCRM: false,
      allowAttendance: false,
      allowMarketing: false,
      allowAdvancedAnalytics: false,
      allowMultiBranch: false,
      allowStaffAccounts: false
    }
  },
  pro: {
    key: 'pro',
    label: 'Pro',
    price: 499,
    whatsappAllowance: 200,
    maxMembers: Infinity,
    topUpCap: 100,                   // hard-cap top-ups so Pro can't out-buy Enterprise
    multiGym: false,
    razorpayPlanEnv: 'RAZORPAY_PLAN_PRO',
    flags: {
      allowGPS: true,
      allowWhatsApp: true,
      allowCRM: true,
      allowAttendance: true,
      allowMarketing: true,
      allowAdvancedAnalytics: true,
      allowMultiBranch: false,
      allowStaffAccounts: false
    }
  },
  enterprise_low: {
    key: 'enterprise_low',
    label: 'Enterprise',
    price: 999,
    whatsappAllowance: 500,
    maxMembers: Infinity,
    topUpCap: Infinity,
    multiGym: true,
    razorpayPlanEnv: 'RAZORPAY_PLAN_ENTERPRISE_LOW',
    flags: {
      allowGPS: true,
      allowWhatsApp: true,
      allowCRM: true,
      allowAttendance: true,
      allowMarketing: true,
      allowAdvancedAnalytics: true,
      allowMultiBranch: true,
      allowStaffAccounts: true
    }
  },
  enterprise_high: {
    key: 'enterprise_high',
    label: 'Enterprise+',
    price: 3999,
    whatsappAllowance: 1500,
    maxMembers: Infinity,
    topUpCap: Infinity,
    multiGym: true,
    razorpayPlanEnv: 'RAZORPAY_PLAN_ENTERPRISE_HIGH',
    flags: {
      allowGPS: true,
      allowWhatsApp: true,
      allowCRM: true,
      allowAttendance: true,
      allowMarketing: true,
      allowAdvancedAnalytics: true,
      allowMultiBranch: true,
      allowStaffAccounts: true
    }
  }
};

// The paid tiers a gym can subscribe to (basic is free / a downgrade target).
const PURCHASABLE_PLANS = ['pro', 'enterprise_low', 'enterprise_high'];
const ALL_PLAN_KEYS = ['basic', 'pro', 'enterprise_low', 'enterprise_high'];

/**
 * Normalize any historical/alias plan name to a canonical catalog key.
 *   'trial'      -> 'pro'   (trial IS a Pro trial; status carries 'trial')
 *   'enterprise' -> 'enterprise_low'
 *   unknown/null -> 'basic'
 */
function resolvePlan(plan) {
  const p = String(plan || '').toLowerCase();
  if (p === 'trial') return 'pro';
  if (p === 'enterprise') return 'enterprise_low';
  if (PLAN_CATALOG[p]) return p;
  return 'basic';
}

/** The catalog entry for a (possibly aliased) plan name. Never throws. */
function getPlan(plan) {
  return PLAN_CATALOG[resolvePlan(plan)];
}

/**
 * Flat limits object in the shape the rest of the app already consumes
 * (PLAN_LIMITS[plan].allowWhatsApp / maxWhatsAppMessages / maxMembers / ...).
 * Kept for drop-in back-compat with existing gating code.
 */
function getLimits(plan) {
  const c = getPlan(plan);
  return {
    ...c.flags,
    maxMembers: c.maxMembers,
    maxWhatsAppMessages: c.whatsappAllowance,
    topUpCap: c.topUpCap,
    multiGym: c.multiGym,
    price: c.price
  };
}

// Back-compat map keyed by BOTH canonical and legacy names, so any existing
// `PLAN_LIMITS[plan]` lookup (plan possibly 'trial'/'enterprise') still resolves.
const PLAN_LIMITS = {
  trial: getLimits('trial'),
  basic: getLimits('basic'),
  pro: getLimits('pro'),
  enterprise: getLimits('enterprise'),
  enterprise_low: getLimits('enterprise_low'),
  enterprise_high: getLimits('enterprise_high')
};

const PLAN_PRICES = {
  basic: 0,
  pro: 499,
  enterprise: 999,
  enterprise_low: 999,
  enterprise_high: 3999
};

function whatsappAllowanceFor(plan) {
  return getPlan(plan).whatsappAllowance;
}

module.exports = {
  PLAN_CATALOG,
  PLAN_LIMITS,
  PLAN_PRICES,
  PURCHASABLE_PLANS,
  ALL_PLAN_KEYS,
  resolvePlan,
  getPlan,
  getLimits,
  whatsappAllowanceFor
};
