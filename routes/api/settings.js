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
// Group: settings
// ---------------------------------------------------------------------------

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
// SETTINGS API
// ==========================================
router.get('/settings', async (req, res) => {
  try {
    const rows = await allQuery(`SELECT setting_key, setting_value FROM settings WHERE tenant_id = ? `, [req.tenant_id]);
    const config = {};
    rows.forEach((r) => {config[r.setting_key] = r.setting_value;});

    // Also pull geofencing parameters from tenants table
    const tenantDetails = await getQuery(`SELECT latitude, longitude, geofence_radius FROM tenants WHERE id = ?`, [req.tenant_id]);
    if (tenantDetails) {
      if (tenantDetails.latitude !== null) config.latitude = tenantDetails.latitude;
      if (tenantDetails.longitude !== null) config.longitude = tenantDetails.longitude;
      if (tenantDetails.geofence_radius !== null) config.geofence_radius = tenantDetails.geofence_radius;
    }

    res.json(config);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to retrieve settings.' });
  }
});

router.post('/settings', authorize('settings:write'), async (req, res) => {
  try {
    const { latitude, longitude, geofence_radius, ...otherSettings } = req.body;
    
    // Update the tenants table if geofencing settings are provided
    if (latitude !== undefined || longitude !== undefined || geofence_radius !== undefined) {
      let updateFields = [];
      let updateValues = [];
      if (latitude !== undefined) { updateFields.push('latitude = ?'); updateValues.push(latitude || null); }
      if (longitude !== undefined) { updateFields.push('longitude = ?'); updateValues.push(longitude || null); }
      if (geofence_radius !== undefined) { updateFields.push('geofence_radius = ?'); updateValues.push(geofence_radius || 50); }
      
      if (updateFields.length > 0) {
        updateValues.push(req.tenant_id);
        await runQuery(`UPDATE tenants SET ${updateFields.join(', ')} WHERE id = ?`, updateValues);
      }
    }

    // Persist under the authenticated tenant
    for (const [key, value] of Object.entries(otherSettings)) {
      await runQuery(
        `INSERT INTO settings (setting_key, tenant_id, setting_value) VALUES (?, ?, ?) ON CONFLICT (tenant_id, setting_key) DO UPDATE SET setting_key = EXCLUDED.setting_key, setting_value = EXCLUDED.setting_value`,
        [key, req.tenant_id, value === undefined || value === null ? '' : String(value)]
      );
    }
    res.json({ message: 'Facility operations settings updated.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save settings.' });
  }
});

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

module.exports = router;
