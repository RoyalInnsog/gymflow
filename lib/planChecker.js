// Centralized subscription / plan checker.
//
// Single source of truth for "what does this tenant's plan allow?".
// Both the API middleware and the UI status endpoint read from here so
// feature gating and the displayed badge never drift apart.
//
// Plan tiers:
//   trial       — 50 members, 21-day auto-expiry, no premium features.
//   basic       — 500 members, attendance/payments/reports.
//   pro         — unlimited members, WhatsApp + marketing + analytics.
//   enterprise  — adds multi-branch + staff accounts on top of pro.
//
// The `tenants` row is the source of truth; the `subscriptions` table
// is the billing ledger. When a Razorpay webhook fires, this module
// keeps both in sync.

const { getQuery } = require('../database');

const PLAN_LIMITS = {
  trial: {
    label: 'Free Trial',
    priceRupees: 0,
    durationDays: 21,
    maxMembers: 50,
    features: {
      attendance: true,
      payments: true,
      reports: true,
      whatsappAutomation: false,
      marketing: false,
      analytics: false,
      multiBranch: false,
      staffAccounts: false
    }
  },
  basic: {
    label: 'Basic',
    priceRupees: 299,
    durationDays: 30,
    maxMembers: 500,
    features: {
      attendance: true,
      payments: true,
      reports: true,
      whatsappAutomation: false,
      marketing: false,
      analytics: false,
      multiBranch: false,
      staffAccounts: false
    }
  },
  pro: {
    label: 'Pro',
    priceRupees: 499,
    durationDays: 30,
    maxMembers: Infinity,
    features: {
      attendance: true,
      payments: true,
      reports: true,
      whatsappAutomation: true,
      marketing: true,
      analytics: true,
      multiBranch: false,
      staffAccounts: false
    }
  },
  enterprise: {
    label: 'Enterprise',
    priceRupees: 999,
    durationDays: 30,
    maxMembers: Infinity,
    features: {
      attendance: true,
      payments: true,
      reports: true,
      whatsappAutomation: true,
      marketing: true,
      analytics: true,
      multiBranch: true,
      staffAccounts: true
    }
  }
};

const FEATURE_TO_PLAN_FLAG = {
  attendance: 'features.attendance',
  payments: 'features.payments',
  reports: 'features.reports',
  whatsappAutomation: 'features.whatsappAutomation',
  marketing: 'features.marketing',
  analytics: 'features.analytics',
  multiBranch: 'features.multiBranch',
  staffAccounts: 'features.staffAccounts'
};

function getPlanLimits(plan) {
  return PLAN_LIMITS[plan] || PLAN_LIMITS.trial;
}

// Return the effective plan/status for a tenant. Trial expiry is
// computed live (no cron needed) so the badge flips to "expired" the
// moment the 21 days run out.
async function getTenantSubscriptionState(tenantId) {
  const tenant = await getQuery(
    `SELECT id, subscription_plan, subscription_status, trial_start, trial_end,
            razorpay_customer_id, razorpay_subscription_id, next_billing_date
       FROM tenants WHERE id = ?`,
    [tenantId]
  );
  if (!tenant) return null;

  let plan = tenant.subscription_plan || 'trial';
  let status = tenant.subscription_status || 'trial';

  // Trial auto-expiry check.
  const now = new Date();
  if (plan === 'trial' && tenant.trial_end && now > new Date(tenant.trial_end)) {
    status = 'expired';
  }

  const limits = getPlanLimits(plan);
  const trialDaysLeft = tenant.trial_end
    ? Math.max(0, Math.ceil((new Date(tenant.trial_end) - now) / (1000 * 60 * 60 * 24)))
    : 0;

  // Days remaining for paid plans: derived from next_billing_date.
  const billingDaysLeft = tenant.next_billing_date
    ? Math.max(0, Math.ceil((new Date(tenant.next_billing_date) - now) / (1000 * 60 * 60 * 24)))
    : 0;

  return {
    tenantId,
    plan,
    status,
    limits,
    trialEnd: tenant.trial_end,
    trialDaysLeft,
    nextBillingDate: tenant.next_billing_date,
    billingDaysLeft,
    razorpayCustomerId: tenant.razorpay_customer_id,
    razorpaySubscriptionId: tenant.razorpay_subscription_id
  };
}

function isFeatureEnabled(plan, feature) {
  const limits = getPlanLimits(plan);
  return Boolean(limits.features[feature]);
}

// Throws a 403-shaped error object so callers can pass it through
// Express's res.status(...).json(...) cleanly.
function featureGuard(plan, feature) {
  if (isFeatureEnabled(plan, feature)) return null;
  return {
    status: 403,
    body: {
      error: `This feature requires an upgrade. The "${feature}" capability is not included in your current plan.`,
      feature,
      currentPlan: plan,
      upgradeRequired: true
    }
  };
}

module.exports = {
  PLAN_LIMITS,
  FEATURE_TO_PLAN_FLAG,
  getPlanLimits,
  getTenantSubscriptionState,
  isFeatureEnabled,
  featureGuard
};
