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
  return generatedSignature === signature;
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

module.exports = {
  razorpay,
  PLANS,
  isRazorpayConfigured,
  createOrder,
  verifyPaymentSignature,
  createCustomer,
  createSubscription,
  updateSubscription,
  cancelSubscription,
};
