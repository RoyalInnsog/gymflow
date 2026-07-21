/**
 * Per-Gym WhatsApp Automation Settings
 * =============================================================================
 * Every gym independently controls WHICH automated WhatsApp messages go out from
 * the centralized platform number, and can customize each message body. This
 * module is the single read/write surface for the `gym_whatsapp_settings` table
 * and exposes the toggle gate used by the automation workers.
 *
 * Dynamic variables supported in every template body:
 *   {{member_name}}  {{gym_name}}  {{amount_due}}  {{days_absent}}
 *   {{festival_name}}  {{plan_name}}  {{invoice_number}}  {{expiry_date}}
 * (single-brace {var} forms are also accepted, matching the rest of the app.)
 * =============================================================================
 */

const { getQuery, runQuery } = require('../database');

// The four automation categories, in UI order.
const FEATURES = ['fee_reminder', 'festival_greetings', 'health_check', 'welcome_invoice'];

// Sensible, friendly default bodies. Gyms may override any of these.
const DEFAULT_TEMPLATES = {
  fee_reminder:
    'Hi {{member_name}}, this is a friendly reminder from *{{gym_name}}*. Your membership fee of *{{amount_due}}* is due (expiry: {{expiry_date}}). Please renew soon to keep your access active. 💪',
  festival_greetings:
    'Dear {{member_name}}, warm *{{festival_name}}* greetings from all of us at *{{gym_name}}*! 🎉 Wishing you health, strength and happiness. Keep crushing your goals! 🏆',
  health_check:
    'Hey {{member_name}}, we noticed you haven\'t checked in at *{{gym_name}}* for *{{days_absent}}* days. Everything okay? 🤗 We\'d love to see you back — reply if there\'s anything we can help with!',
  welcome_invoice:
    'Welcome to *{{gym_name}}*, {{member_name}}! 🎉 We\'re thrilled to have you. Your membership invoice *{{invoice_number}}* ({{amount_due}}) is attached. Let\'s get started on your fitness journey! 💪'
};

// Column names on the table for each feature's toggle / template.
const TOGGLE_COL = {
  fee_reminder: 'fee_reminder_enabled',
  festival_greetings: 'festival_greetings_enabled',
  health_check: 'health_check_enabled',
  welcome_invoice: 'welcome_invoice_enabled'
};
const TEMPLATE_COL = {
  fee_reminder: 'fee_reminder_template',
  festival_greetings: 'festival_greetings_template',
  health_check: 'health_check_template',
  welcome_invoice: 'welcome_invoice_template'
};

function uid(prefix = 'wa_') {
  return prefix + require('crypto').randomUUID().replace(/-/g, '');
}

/** Shape a raw DB row (or nothing) into a fully-defaulted settings object. */
function shape(row) {
  row = row || {};
  return {
    tenant_id: row.tenant_id || null,
    api_key_placeholder: row.api_key_placeholder || null,
    toggles: {
      fee_reminder: Boolean(row.fee_reminder_enabled),
      festival_greetings: Boolean(row.festival_greetings_enabled),
      health_check: Boolean(row.health_check_enabled),
      welcome_invoice: Boolean(row.welcome_invoice_enabled)
    },
    templates: {
      fee_reminder: row.fee_reminder_template || DEFAULT_TEMPLATES.fee_reminder,
      festival_greetings: row.festival_greetings_template || DEFAULT_TEMPLATES.festival_greetings,
      health_check: row.health_check_template || DEFAULT_TEMPLATES.health_check,
      welcome_invoice: row.welcome_invoice_template || DEFAULT_TEMPLATES.welcome_invoice
    },
    updated_at: row.updated_at || null
  };
}

/**
 * Return this gym's settings, lazily creating the row (all toggles OFF by
 * default, per spec) the first time it's requested.
 */
async function getSettings(tenantId) {
  let row = await getQuery(`SELECT * FROM gym_whatsapp_settings WHERE tenant_id = ?`, [tenantId]);
  if (!row) {
    try {
      await runQuery(
        `INSERT INTO gym_whatsapp_settings (id, tenant_id) VALUES (?, ?)`,
        [uid(), tenantId]
      );
    } catch (e) {
      // Another concurrent request may have created it — ignore and re-read.
    }
    row = await getQuery(`SELECT * FROM gym_whatsapp_settings WHERE tenant_id = ?`, [tenantId]);
  }
  return shape(row);
}

/**
 * The toggle gate used by every automation worker. Reads the single boolean for a
 * feature. Fail-closed: any error or missing row means "disabled".
 */
async function isFeatureEnabled(tenantId, feature) {
  const col = TOGGLE_COL[feature];
  if (!col) return false;
  try {
    const row = await getQuery(
      `SELECT ${col} AS enabled FROM gym_whatsapp_settings WHERE tenant_id = ?`,
      [tenantId]
    );
    return Boolean(row && row.enabled);
  } catch (e) {
    return false;
  }
}

/** Resolve the (possibly customized) template body for a feature. */
async function getTemplate(tenantId, feature) {
  const s = await getSettings(tenantId);
  return (s.templates && s.templates[feature]) || DEFAULT_TEMPLATES[feature] || '';
}

/**
 * Upsert a gym's settings. `patch` may contain:
 *   toggles:   { fee_reminder, festival_greetings, health_check, welcome_invoice } (booleans)
 *   templates: { <same keys> } (strings; empty/blank restores the default)
 *   api_key_placeholder: string|null
 * Only provided keys are changed. Returns the fresh, shaped settings.
 */
async function updateSettings(tenantId, patch = {}) {
  await getSettings(tenantId); // guarantee the row exists

  const sets = [];
  const params = [];

  if (patch.toggles && typeof patch.toggles === 'object') {
    for (const f of FEATURES) {
      if (Object.prototype.hasOwnProperty.call(patch.toggles, f)) {
        sets.push(`${TOGGLE_COL[f]} = ?`);
        params.push(patch.toggles[f] ? 1 : 0);
      }
    }
  }

  if (patch.templates && typeof patch.templates === 'object') {
    for (const f of FEATURES) {
      if (Object.prototype.hasOwnProperty.call(patch.templates, f)) {
        const val = String(patch.templates[f] == null ? '' : patch.templates[f]).trim();
        sets.push(`${TEMPLATE_COL[f]} = ?`);
        // Blank -> NULL so the default body transparently applies again.
        params.push(val ? val.slice(0, 4000) : null);
      }
    }
  }

  if (Object.prototype.hasOwnProperty.call(patch, 'api_key_placeholder')) {
    sets.push(`api_key_placeholder = ?`);
    const v = patch.api_key_placeholder;
    params.push(v == null || v === '' ? null : String(v).slice(0, 512));
  }

  if (sets.length) {
    sets.push(`updated_at = CURRENT_TIMESTAMP`);
    params.push(tenantId);
    await runQuery(
      `UPDATE gym_whatsapp_settings SET ${sets.join(', ')} WHERE tenant_id = ?`,
      params
    );
  }

  return getSettings(tenantId);
}

module.exports = {
  FEATURES,
  DEFAULT_TEMPLATES,
  getSettings,
  updateSettings,
  isFeatureEnabled,
  getTemplate
};
