const Razorpay = require("razorpay");
const { getQuery, runQuery } = require("../database");
const crypto = require("crypto");

let razorpay = null;
const hasRazorpayKeys = !!(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);

if (hasRazorpayKeys) {
  try {
    razorpay = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET,
    });
  } catch (err) {
    console.error("Failed to initialize Razorpay SDK:", err);
  }
}

const PLANS = {
  FREE_TRIAL: {
    id: "plan_trial",
    price: 0,
    interval: "daily",
    amount: 0,
    members_limit: 50,
  },
  BASIC: {
    id: "plan_basic",
    price: 299,
    interval: "monthly",
    amount: 299 * 100,
    members_limit: 500,
  },
  PRO: {
    id: "plan_pro",
    price: 499,
    interval: "monthly",
    amount: 499 * 100,
    members_limit: Infinity,
  },
  ENTERPRISE: {
    id: "plan_enterprise",
    price: 999,
    interval: "monthly",
    amount: 999 * 100,
    members_limit: Infinity,
  },
};

function isRazorpayConfigured() {
  return !!razorpay;
}

async function createOrder(amountRupees, receiptId, notes) {
  if (!razorpay) {
    throw new Error("Razorpay is not configured on this server.");
  }
  try {
    const order = await razorpay.orders.create({
      amount: Math.round(amountRupees * 100), // amount in paise
      currency: "INR",
      receipt: receiptId,
      // [C6] notes (tenant_id, plan) flow back on the webhook so plan activation
      // can be attributed to the right tenant server-side.
      ...(notes ? { notes } : {}),
    });
    return order;
  } catch (error) {
    console.error("Razorpay Create Order Error:", error);
    throw error;
  }
}

function verifyPaymentSignature(orderId, paymentId, signature) {
  if (!hasRazorpayKeys) {
    throw new Error("Razorpay keys are not configured on this server.");
  }
  const generatedSignature = crypto
    .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
    .update(orderId + "|" + paymentId)
    .digest("hex");
  // Constant-time compare to avoid leaking the signature byte-by-byte via timing.
  const a = Buffer.from(generatedSignature);
  const b = Buffer.from(String(signature || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// [SEC] Fetch the authoritative order from Razorpay. Used at payment verification
// to read the amount and the server-set notes (tenant_id, plan) so the plan that
// gets activated comes from what was actually ordered/paid — never from the client.
async function fetchOrder(orderId) {
  if (!razorpay) throw new Error("Razorpay is not configured on this server.");
  return await razorpay.orders.fetch(orderId);
}

async function createCustomer(tenant_id, email, phone) {
  if (!razorpay) throw new Error("Razorpay is not configured on this server.");
  try {
    const tenant = await getQuery("SELECT razorpay_customer_id FROM tenants WHERE id = ?", [tenant_id]);
    if (tenant && tenant.razorpay_customer_id) {
      return tenant.razorpay_customer_id;
    }

    const customer = await razorpay.customers.create({
      name: email, 
      email: email,
      contact: phone,
    });

    await runQuery("UPDATE tenants SET razorpay_customer_id = ? WHERE id = ?", [customer.id, tenant_id]);
    return customer.id;
  } catch (error) {
    console.error("Razorpay Create Customer Error:", error);
    throw error;
  }
}

async function createSubscription(tenant_id, planKey, customerId) {
  if (!razorpay) throw new Error("Razorpay is not configured on this server.");
  try {
    const plan = PLANS[planKey];
    if (!plan) throw new Error("Invalid plan key");

    const subscription = await razorpay.subscriptions.create({
      plan_id: plan.id,
      customer_notify: 1,
      total_count: 12,
    });

    return subscription;
  } catch (error) {
    console.error("Razorpay Create Subscription Error:", error);
    throw error;
  }
}

async function updateSubscription(subscriptionId, newPlanId) {
  if (!razorpay) throw new Error("Razorpay is not configured on this server.");
  try {
    return await razorpay.subscriptions.update(subscriptionId, {
      plan_id: newPlanId,
    });
  } catch (error) {
    console.error("Razorpay Update Subscription Error:", error);
    throw error;
  }
}

async function cancelSubscription(subscriptionId) {
  if (!razorpay) throw new Error("Razorpay is not configured on this server.");
  try {
    return await razorpay.subscriptions.cancel(subscriptionId);
  } catch (error) {
    console.error("Razorpay Cancel Subscription Error:", error);
    throw error;
  }
}

// [AutoPay] Create a recurring Razorpay subscription mandate for a billing-plan
// tier. Resolves the tier via the billingPlans catalog, reads the pre-created
// Razorpay plan id from the env var named by `razorpayPlanEnv` (e.g.
// RAZORPAY_PLAN_PRO). THROWS if Razorpay isn't configured or the env plan id is
// missing so the caller can fall back to a one-time order.
async function createSubscriptionMandate(tenantId, plan, { totalCount = 12, notes } = {}) {
  const { getPlan } = require("./billingPlans");
  if (!razorpay) throw new Error("Razorpay is not configured on this server.");
  const catalog = getPlan(plan);
  if (!catalog || !catalog.razorpayPlanEnv) {
    throw new Error(`Plan '${plan}' has no recurring Razorpay mandate configured.`);
  }
  const planId = process.env[catalog.razorpayPlanEnv];
  if (!planId) {
    throw new Error(`Razorpay plan id (${catalog.razorpayPlanEnv}) is not configured on this server.`);
  }
  const subscription = await razorpay.subscriptions.create({
    plan_id: planId,
    total_count: totalCount,
    customer_notify: 1,
    ...(notes ? { notes } : {}),
  });
  return subscription;
}

// [AutoPay] Verify a Razorpay subscription authentication signature. For
// subscriptions Razorpay signs `razorpay_payment_id + '|' + razorpay_subscription_id`
// (note the order differs from a one-time order's order_id|payment_id). Constant-time
// compared to avoid leaking the signature via timing.
function verifySubscriptionSignature(subscriptionId, paymentId, signature) {
  if (!hasRazorpayKeys) {
    throw new Error("Razorpay keys are not configured on this server.");
  }
  const generatedSignature = crypto
    .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
    .update(paymentId + "|" + subscriptionId)
    .digest("hex");
  const a = Buffer.from(generatedSignature);
  const b = Buffer.from(String(signature || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = {
  razorpay,
  PLANS,
  isRazorpayConfigured,
  createOrder,
  verifyPaymentSignature,
  fetchOrder,
  createCustomer,
  createSubscription,
  createSubscriptionMandate,
  verifySubscriptionSignature,
  updateSubscription,
  cancelSubscription,
};
