const { getQuery, runQuery, allQuery } = require('../database');
const billing = require('./billingState');
const { PLAN_LIMITS } = require('./billingPlans');

const escapeLike = (str) => String(str || '').replace(/[%_\\]/g, c => '\\' + c);
const isValidDate = (str) => /^\d{4}-\d{2}-\d{2}$/.test(String(str || ''));
const toInteger = (val, fallback = null) => { const num = parseInt(val, 10); return isNaN(num) ? fallback : num; };
const toNumeric = (val, fallback = 0) => { const num = parseFloat(val); return isNaN(num) ? fallback : num; };
const whitelist = (val, allowed, fallback) => allowed.includes(val) ? val : fallback;

function authorize(...required) {
  return async (req, res, next) => {
    try {
      let perms = [];
      if (req.tenant_id && req.user && req.user.id) {
        const { getQuery, allQuery } = require('../database');
        const rows = await allQuery(
          `SELECT r.permissions FROM user_roles ur 
           JOIN roles r ON r.id = ur.role_id 
           WHERE ur.user_id = ? AND ur.tenant_id = ? AND (ur.status IS NULL OR ur.status = 'active')`, 
          [req.user.id, req.tenant_id]
        );
        if (rows.length > 0) {
          for (const row of rows) {
            try { perms.push(...JSON.parse(row.permissions || '[]')); } catch(e){}
          }
        } else {
          const legacy = await getQuery(
            `SELECT r.permissions FROM users JOIN roles r ON r.id = users.role_id WHERE users.id = ? AND users.tenant_id = ?`,
            [req.user.id, req.tenant_id]
          );
          if (legacy) try { perms = JSON.parse(legacy.permissions || '[]'); } catch(e){}
        }
      } else {
        perms = (req.user && Array.isArray(req.user.permissions)) ? req.user.permissions : [];
      }
      
      if (perms.includes('all')) return next();
      if (required.length === 0 || required.some(p => perms.includes(p))) return next();
      return res.status(403).json({ error: 'You do not have permission to perform this action.' });
    } catch (err) {
      console.error('[Authz] Error:', err);
      return res.status(403).json({ error: 'Permission check failed.' });
    }
  };
}

function requireFeature(flag, label) {
  return (req, res, next) => {
    const plan = (req.subscription && req.subscription.subscription_plan) || 'trial';
    const limits = PLAN_LIMITS[plan] || PLAN_LIMITS.trial;
    if (limits[flag]) return next();
    return res.status(403).json({
      error: label + ' is available on the Pro plan. Upgrade in Settings to unlock it.',
      upgradeRequired: true,
      feature: flag
    });
  };
}

async function getTaxConfig(tenantId) {
  const rows = await allQuery("SELECT setting_key, setting_value FROM settings WHERE setting_key IN ('gst_enabled','gst_percent') AND tenant_id = ?", [tenantId]);
  const map = {};
  rows.forEach(r => { map[r.setting_key] = r.setting_value; });
  const enabled = map.gst_enabled === 'true';
  const percent = enabled ? (parseFloat(map.gst_percent) || 0) : 0;
  return { enabled, percent };
}

function computeTax(subtotal, taxCfg) {
  if (!taxCfg || !taxCfg.enabled || !taxCfg.percent) return 0;
  return Math.round(subtotal * (taxCfg.percent / 100) * 100) / 100;
}

async function resolveRenewalDiscount(tenantId, planPrice) {
  const price = Number(planPrice) || 0;
  if (price <= 0) return 0;
  const rule = await getQuery("SELECT enabled, discount_type, amount, percent FROM discount_rules WHERE tenant_id = ? AND id = 'loyalty'", [tenantId]);
  if (!rule || !rule.enabled) return 0;
  let discount = rule.discount_type === 'percent'
    ? Math.round(price * (Number(rule.percent) || 0) / 100 * 100) / 100
    : (Number(rule.amount) || 0);
  if (!Number.isFinite(discount) || discount < 0) discount = 0;
  if (discount > price) discount = price;
  return discount;
}

function uid(prefix = '') {
  return prefix + require('crypto').randomUUID().replace(/-/g, '');
}

async function nextInvoiceNumber(tenantId, prefix = 'RCPT') {
  const year = new Date().getFullYear();
  const row = await getQuery("INSERT INTO invoice_sequences (tenant_id, year, last_value) VALUES (?, ?, 1) ON CONFLICT(tenant_id, year) DO UPDATE SET last_value = last_value + 1 RETURNING last_value", [tenantId, year]);
  const seq = (row && row.last_value) || 1;
  return prefix + '-' + year + '-' + String(seq).padStart(5, '0');
}

async function checkSubscription(req, res, next) {
  try {
    if (!req.tenant_id) return next();
    const tenant = await getQuery("SELECT subscription_plan, trial_end, subscription_status FROM tenants WHERE id = ? ", [req.tenant_id]);
    if (!tenant) return res.status(404).json({ error: "Tenant not found." });
    req.subscription = tenant;
    const plan = req.subscription.subscription_plan || 'trial';
    const now = new Date();
    const isTrialExpired = plan === 'trial' && now > new Date(tenant.trial_end);
    const BILLING_PATHS = new Set(['/subscription/change', '/subscription/create-order', '/subscription/verify-payment', '/subscription/submit-upi-payment']);
    if (isTrialExpired) {
      await billing.downgradeToBasic(req.tenant_id, 'Free trial expired — moved to the free Basic plan.');
      req.subscription = { ...tenant, subscription_plan: 'basic', subscription_status: 'active' };
    } else if (tenant.subscription_status === 'expired') {
      if (req.method !== 'GET' && !BILLING_PATHS.has(req.path)) {
        return res.status(403).json({ error: "Your subscription has expired. Please renew your plan in settings to restore access.", trialExpired: true });
      }
    }
    next();
  } catch (err) {
    console.error('Subscription check error:', err);
    res.status(500).json({ error: 'Internal subscription check failed.' });
  }
}



async function logActivity(userId, tenantId, action, table, recordId, details = {}) {
  try {
    const id = uid('act_');
    const { runQuery } = require('../database');
    await runQuery(`
      INSERT INTO activity_logs (id, tenant_id, user_id, action, table_name, record_id, new_values)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [id, tenantId || null, userId || 'u1', action, table, recordId, JSON.stringify(details)]);
  } catch (err) {
    console.error('Failed to log activity:', err.message);
  }
}

async function resolveTemplate(templateId, data, tenantId) {
  const { getQuery, allQuery } = require('../database');
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

Object.assign(exports, {
  escapeLike,
  isValidDate,
  toInteger,
  toNumeric,
  whitelist,
  authorize,
  requireFeature,
  checkSubscription,
  getTaxConfig,
  computeTax,
  resolveRenewalDiscount,
  uid,
  nextInvoiceNumber,
  resolveTemplate,
  logActivity,
  ALLOWED_DISCOUNT_IDS: new Set(['loyalty', 'student', 'corporate', 'promotional', 'custom']),
  ALLOWED_DISCOUNT_TYPES: new Set(['amount', 'percent']),
  FEET_PER_METER: 3.280839895,
  isFiniteNum: (v) => typeof v === 'number' && isFinite(v),
  inLatRange: (v) => typeof v === 'number' && isFinite(v) && v >= -90 && v <= 90,
  inLonRange: (v) => typeof v === 'number' && isFinite(v) && v >= -180 && v <= 180
});
