const express = require('express');
const router = express.Router();
const { getQuery, runQuery, allQuery } = require('../../database');
const { authorize, requireFeature, checkSubscription, getTaxConfig, computeTax, resolveRenewalDiscount, uid, nextInvoiceNumber } = require('../../lib/apiUtils');

// Temporary aliases for missing dependencies
const { PLANS, isRazorpayConfigured, createOrder, verifyPaymentSignature, fetchOrder, cancelSubscription } = require('../../lib/razorpay');
const { getTodayString, getLastNDaysString, getNextNDaysString } = require('../../lib/dateUtils');
const engine = require('../../lib/membershipEngine');
const whatsappCloud = require('../../services/whatsappCloud.service');
const waSettings = require('../../services/whatsappSettings');
const waAutomations = require('../../services/whatsappAutomations');
const { PLAN_LIMITS, PLAN_PRICES, PURCHASABLE_PLANS, resolvePlan, getPlan } = require('../../lib/billingPlans');
const billing = require('../../lib/billingState');

// ---------------------------------------------------------------------------
// Group: billing
// ---------------------------------------------------------------------------

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

    // [BILLING] Authoritative WhatsApp credit ledger (allowance/used/extra/remaining).
    const state = await billing.getBillingState(req.tenant_id);

    res.json({
      plan: state.plan,
      planLabel: state.planLabel,
      status: tenant.subscription_status || state.status || 'active',
      trialEnd: tenant.trial_end,
      trialDaysLeft,
      multiGym: state.multiGym,
      // Authoritative credit ledger (preferred by the UI + dashboard modal).
      whatsapp: {
        allowance: state.allowance,
        used: state.used,
        extraCredits: state.extraCredits,
        remaining: state.remaining,
        topUpCap: state.topUpCap === Infinity ? null : state.topUpCap,
        extraPurchasedThisCycle: state.extraPurchasedThisCycle
      },
      usage: {
        members: {
          current: currentMembers,
          limit: limits.maxMembers
        },
        // Back-compat shape: current = used this cycle, limit = allowance + top-ups.
        whatsapp: {
          current: state.used,
          limit: state.allowance + state.extraCredits
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
  // Only FREE transitions are allowed here (downgrade to the free Basic tier). Any
  // PAID tier (pro / enterprise_low / enterprise_high, or the legacy aliases) must
  // go through signature-verified checkout — the client can never self-grant it.
  const FREE_TARGETS = new Set(['basic', 'trial']);
  const canonical = resolvePlan(plan);
  if (!plan || (!FREE_TARGETS.has(plan) && !PURCHASABLE_PLANS.includes(canonical))) {
    return res.status(400).json({ error: 'Invalid plan selected.' });
  }
  if (!FREE_TARGETS.has(plan)) {
    return res.status(402).json({
      error: 'Paid plans must be activated through checkout. Start a payment to upgrade.',
      requiresPayment: true,
      plan
    });
  }

  try {
    // Downgrade to the free Basic tier — routes through the billing ledger so the
    // WhatsApp allowance drops to 0 and multi-gym is revoked.
    await billing.downgradeToBasic(req.tenant_id, 'Self-service downgrade to Basic.');
    res.json({ message: 'Subscription moved to the free Basic plan.', plan: 'basic' });
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
      INSERT INTO subscriptions (id, tenant_id, plan, status, razorpay_subscription_id, next_billing_date, updated_at) VALUES (?, ?, ?, 'active', ?, ?, CURRENT_TIMESTAMP) ON CONFLICT (id) DO UPDATE SET plan = EXCLUDED.plan, status = EXCLUDED.status, razorpay_subscription_id = EXCLUDED.razorpay_subscription_id, next_billing_date = EXCLUDED.next_billing_date, updated_at = EXCLUDED.updated_at
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
    // [BILLING FIX] member_id/membership_id are NULL (not the 'SaaS' string):
    // payments/invoices carry FKs to members/memberships, and no such row exists,
    // so 'SaaS' threw SQLITE_CONSTRAINT *after* the plan was already activated —
    // customer charged + upgraded but shown a 500, and the idempotency payments
    // row never landed so retries duplicated history. NULL satisfies the FK; the
    // 'SaaS' sentinel was write-only (nothing filters on it — SaaS rows are keyed
    // by the INV-SAAS invoice_number).
    await runQuery(`
      INSERT INTO invoices (id, tenant_id, member_id, membership_id, invoice_number, subtotal, tax_amount, total_amount, status) VALUES (?, ?, NULL, NULL, ?, ?, 0, ?, 'Paid') ON CONFLICT (id) DO UPDATE SET member_id = EXCLUDED.member_id, membership_id = EXCLUDED.membership_id, invoice_number = EXCLUDED.invoice_number, subtotal = EXCLUDED.subtotal, tax_amount = EXCLUDED.tax_amount, total_amount = EXCLUDED.total_amount, status = EXCLUDED.status
    `, [invId, req.tenant_id, invNo, price, price]);
    await runQuery(`
      INSERT INTO payments (id, tenant_id, invoice_id, member_id, amount, method, transaction_reference, status) VALUES (?, ?, ?, NULL, ?, 'Razorpay', ?, 'Successful') ON CONFLICT (id) DO UPDATE SET invoice_id = EXCLUDED.invoice_id, member_id = EXCLUDED.member_id, amount = EXCLUDED.amount, method = EXCLUDED.method, transaction_reference = EXCLUDED.transaction_reference, status = EXCLUDED.status
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
    // [BILLING FIX] NULL member/membership (not 'SaaS'): invoices carries FKs to
    // members/memberships; the 'SaaS' string violated them on a fresh-schema DB.
    await runQuery(`
      INSERT INTO invoices (id, tenant_id, member_id, membership_id, invoice_number, subtotal, tax_amount, total_amount, status)
      VALUES (?, ?, NULL, NULL, ?, ?, 0, ?, 'Unpaid')
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
  // Desk-confirmed collection (staff watched the member pay by cash or scan the
  // UPI QR). These settle immediately as Successful — no online Razorpay order,
  // so the invoice never gets stuck on a Pending baseline.
  const manual = req.body.manual === true || req.body.manual === 'true';

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

    // Online gateway path ONLY for non-manual Card/UPI: creates a Pending order
    // that a Razorpay webhook/verify flips to Successful.
    if ((method === 'Card' || method === 'UPI') && !manual) {
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
      // Cash, or a desk-confirmed manual UPI/Card collection → settle now.
      const prefix = method === 'UPI' ? 'UPI' : method === 'Card' ? 'CARD' : 'CASH';
      // [FIX] Append a random suffix (uid) so two cash collections in the same
      // millisecond can't collide on the GLOBALLY-UNIQUE transaction_reference and
      // 500 across tenants. (Pure Date.now() collided under concurrency.)
      const txnRef = uid(prefix + '/');
      await runQuery(`
        INSERT INTO payments (id, tenant_id, invoice_id, member_id, amount, method, transaction_reference, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'Successful')
      `, [payId, req.tenant_id, invoice_id, invoice.member_id, payAmount, method, txnRef]);

      await runQuery(`UPDATE invoices SET status = 'Paid' WHERE id = ? AND tenant_id = ? `, [invoice_id, req.tenant_id]);

      if (invoice.membership_id) {
        await runQuery(`UPDATE memberships SET status = 'Active' WHERE id = ? AND tenant_id = ? `, [invoice.membership_id, req.tenant_id]);
        await runQuery(`UPDATE members SET status = 'Active' WHERE id = ? AND tenant_id = ? `, [invoice.member_id, req.tenant_id]);
      }

      return res.json({ message: 'Payment recorded successfully.', transactionReference: txnRef, method: method, status: 'Successful' });
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
         AND (is_deleted = 0 OR is_deleted IS NULL)
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

// Plans — GET handled above in the PLANS API section

router.post('/plans', async (req, res) => {
  const id = 'p_' + Date.now();
  const { name, duration_months, duration_days, price, joining_fee, freeze_allowed, pt_included, is_active } = req.body;
  if (!name || name.trim() === '') {
    return res.status(400).json({ error: 'Plan name is required.' });
  }
  try {
    // [TIER GATE] Free/Basic run a single operational plan; the multi-package
    // builder is a Pro capability. Block the creation of a 2nd tenant-owned plan
    // for plans without advanced analytics (i.e. trial/basic). Pro/Enterprise
    // are unlimited.
    const plan = (req.subscription && req.subscription.subscription_plan) || 'trial';
    const limits = PLAN_LIMITS[plan] || PLAN_LIMITS.trial;
    if (!limits.allowAdvancedAnalytics) {
      const owned = await getQuery(
        `SELECT COUNT(*) as count FROM membership_plans
          WHERE tenant_id = ? AND (is_deleted = 0 OR is_deleted IS NULL)`, [req.tenant_id]);
      if ((owned.count || 0) >= 1) {
        return res.status(403).json({
          error: 'Your plan supports a single membership package. Upgrade to Pro to build multiple packages.',
          upgradeRequired: true, feature: 'multiPlan'
        });
      }
    }

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
    // Soft-delete (archive) instead of a destructive DELETE: membership_plans is
    // referenced by memberships/invoices, so a hard delete fails on FK
    // constraints ("Failed to delete plan"). Flag is_deleted=1 and clear
    // is_active so the plan drops out of every active list; historical
    // memberships that reference it still resolve their plan name.
    const result = await runQuery(
      `UPDATE membership_plans SET is_deleted = 1, is_active = 0
        WHERE id=? AND tenant_id=? AND (is_deleted = 0 OR is_deleted IS NULL)`,
      [req.params.id, req.tenant_id]
    );
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Plan not found or access denied.' });
    }
    res.json({ message: 'Plan archived' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete plan.' });
  }
});

module.exports = router;
