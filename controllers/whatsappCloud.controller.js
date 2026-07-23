/**
 * WhatsApp Cloud API Controller
 * =============================================================================
 * Thin request handlers for the gym-facing WhatsApp automation dashboard plus the
 * platform webhook. Business logic lives in services/:
 *   - services/whatsappCloud.service.js   (centralized sender + webhook crypto)
 *   - services/whatsappSettings.js        (per-gym toggles + templates)
 *   - services/whatsappAutomations.js     (workers)
 *
 * Settings routes are tenant-scoped (req.tenant_id) and manager-gated in the
 * router. The webhook routes are PUBLIC (Meta calls them) and are verified by the
 * subscription verify-token (GET) and the app-secret signature (POST).
 * =============================================================================
 */

const cloud = require('../services/whatsappCloud.service');
const waSettings = require('../services/whatsappSettings');
const automations = require('../services/whatsappAutomations');
const { runQuery } = require('../database');

// GET /whatsapp/status — lightweight, for the Settings page to poll.
async function getStatus(req, res) {
  try {
    res.json(cloud.getPublicStatus());
  } catch (err) {
    res.status(500).json({ error: 'Failed to read WhatsApp status.' });
  }
}

// GET /whatsapp/settings — this gym's toggles + templates + masked system config.
async function getSettings(req, res) {
  try {
    const settings = await waSettings.getSettings(req.tenant_id);
    res.json({
      system: cloud.getPublicStatus(),          // system-managed credential status (masked)
      toggles: settings.toggles,
      templates: settings.templates,
      defaults: waSettings.DEFAULT_TEMPLATES,
      api_key_placeholder: settings.api_key_placeholder || '',
      updated_at: settings.updated_at
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load WhatsApp settings.' });
  }
}

// PUT /whatsapp/settings — persist toggles / templates / reserved placeholder.
async function updateSettings(req, res) {
  try {
    const { toggles, templates, api_key_placeholder } = req.body || {};
    const patch = {};
    if (toggles && typeof toggles === 'object') patch.toggles = toggles;
    if (templates && typeof templates === 'object') patch.templates = templates;
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'api_key_placeholder')) {
      patch.api_key_placeholder = api_key_placeholder;
    }
    const updated = await waSettings.updateSettings(req.tenant_id, patch);
    res.json({
      message: 'WhatsApp automation settings saved.',
      toggles: updated.toggles,
      templates: updated.templates
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save WhatsApp settings.' });
  }
}

// POST /whatsapp/test — send a one-off test message to verify the integration.
async function sendTest(req, res) {
  try {
    if (!cloud.isConfigured()) {
      return res.status(409).json({ error: 'The platform WhatsApp service is not configured yet. Please contact support.' });
    }
    const { phone, message } = req.body || {};
    if (!phone) return res.status(400).json({ error: 'A recipient phone number is required.' });

    const body = (message && String(message).trim())
      || 'Test message from Gymflow WhatsApp automation. If you received this, your setup works! ✅';

    const result = await cloud.sendText(phone, body);

    // Audit the test in the outbox.
    const ntId = 'nt_test' + Date.now().toString(36);
    const normalized = cloud.validateAndNormalizePhone(phone) || phone;
    await runQuery(
      `INSERT INTO notifications (id, tenant_id, type, priority, title, message, is_read, recipient_phone, delivery_status, failure_reason, campaign_source, provider_message_id)
       VALUES (?, ?, 'WhatsApp', 'Low', 'WhatsApp: Test Message', ?, 1, ?, ?, ?, 'Manual Test', ?)`,
      [ntId, req.tenant_id, body, normalized, result.success ? 'Delivered' : 'Failed', result.success ? null : (result.error || 'Send failed'), result.messageId || null]
    );

    if (!result.success) return res.status(502).json({ error: result.error || 'Failed to send test message.' });
    res.json({ message: 'Test message sent.', messageId: result.messageId });
  } catch (err) {
    res.status(500).json({ error: 'Failed to send test message.' });
  }
}

// POST /whatsapp/festival/send — manually broadcast a festival greeting now.
async function sendFestival(req, res) {
  try {
    if (!cloud.isConfigured()) {
      return res.status(409).json({ error: 'The platform WhatsApp service is not configured yet.' });
    }
    if (!(await waSettings.isFeatureEnabled(req.tenant_id, 'festival_greetings'))) {
      return res.status(409).json({ error: 'Enable Festival Greetings first, then send.' });
    }
    const festivalName = (req.body && req.body.festivalName && String(req.body.festivalName).trim()) || 'Festival';
    const result = await automations.runFestivalGreetings(req.tenant_id, { force: true, festivalName });
    res.json({ message: `Festival greetings dispatched to ${result.sent || 0} member(s).`, ...result });
  } catch (err) {
    res.status(500).json({ error: 'Failed to dispatch festival greetings.' });
  }
}

// ── PUBLIC webhook (mounted un-authenticated in server.js) ───────────────────

// GET /api/whatsapp/webhook — Meta subscription handshake.
function webhookVerify(req, res) {
  const challenge = cloud.verifyWebhookSubscription(req.query || {});
  if (challenge) return res.status(200).type('text/plain').send(String(challenge));
  return res.sendStatus(403);
}

// POST /api/whatsapp/webhook — inbound messages & delivery status callbacks.
// Mounted with express.raw so `req.body` is the raw Buffer for signature checks.
async function webhookReceive(req, res) {
  try {
    const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : (typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {}));
    const signature = req.headers['x-hub-signature-256'];

    // [SEC] Fail CLOSED. Without a configured app secret the sender can't be
    // verified, so reject rather than trust an unauthenticated payload (this
    // matches the Razorpay webhook, which refuses when its secret is absent).
    if (!cloud.CONFIG.appSecret || !cloud.verifyWebhookSignature(raw, signature)) {
      return res.sendStatus(401);
    }

    let payload = {};
    try { payload = JSON.parse(raw); } catch (e) { payload = {}; }

    // Reflect delivery-status callbacks into the outbox where we can match a wamid.
    try {
      const entries = (payload && payload.entry) || [];
      for (const entry of entries) {
        for (const change of (entry.changes || [])) {
          const statuses = (change.value && change.value.statuses) || [];
          for (const st of statuses) {
            const mapped = st.status === 'read' || st.status === 'delivered' ? 'Delivered'
              : st.status === 'failed' ? 'Failed' : null;
            if (mapped && st.id) {
              await runQuery(
                `UPDATE notifications SET delivery_status = ? WHERE provider_message_id = ?`,
                [mapped, st.id]
              );
            }
          }
        }
      }
    } catch (e) { /* best-effort status sync — never fail the webhook */ }

    // Always 200 quickly so Meta doesn't retry.
    res.sendStatus(200);
  } catch (err) {
    res.sendStatus(200);
  }
}

module.exports = {
  getStatus,
  getSettings,
  updateSettings,
  sendTest,
  sendFestival,
  webhookVerify,
  webhookReceive
};
