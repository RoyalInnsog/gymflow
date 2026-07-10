/**
 * Centralized WhatsApp Cloud API Service
 * =============================================================================
 * This is the SINGLE, platform-wide WhatsApp sender for Gymflow. It replaces the
 * old per-tenant whatsapp-web.js layer: instead of every gym scanning a QR and
 * sending from their own phone, ALL gyms' automated messages are dispatched from
 * ONE Gymflow-owned Meta WhatsApp Cloud API business number.
 *
 * Individual gyms never see or manage these credentials — they only flip their
 * own automation toggles (see services/whatsappSettings.js). The credentials are
 * "system managed" and configured once, here, via environment variables.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  ⚙️  CLOUD API CONFIGURATION  (fill these in .env — placeholders below)
 * ─────────────────────────────────────────────────────────────────────────────
 *   WHATSAPP_CLOUD_ACCESS_TOKEN     Permanent/system access token (Bearer).
 *   WHATSAPP_CLOUD_PHONE_NUMBER_ID  The Cloud API phone-number id (NOT the number).
 *   WHATSAPP_CLOUD_APP_SECRET       App secret — used to verify inbound webhook
 *                                   signatures (X-Hub-Signature-256).
 *   WHATSAPP_CLOUD_VERIFY_TOKEN     Arbitrary string echoed back during the
 *                                   webhook subscription handshake.
 *   WHATSAPP_CLOUD_API_VERSION      Graph API version (default: v21.0).
 *
 * Until real values are provided, isConfigured() returns false and every send is
 * short-circuited to a clean "not configured" failure (never a fake success).
 * =============================================================================
 */

const crypto = require('crypto');

// ── Placeholder configuration block ─────────────────────────────────────────
// Values resolve from env at call time (so a restart is enough to apply new
// creds). Legacy WHATSAPP_PHONE_ID / WHATSAPP_API_TOKEN names are accepted as a
// fallback so an existing deployment isn't orphaned by the new naming.
const CONFIG = {
  get accessToken() {
    return process.env.WHATSAPP_CLOUD_ACCESS_TOKEN
        || process.env.WHATSAPP_API_TOKEN
        || '';   // e.g. "EAAG...ZDZD"  (paste the permanent token here via env)
  },
  get phoneNumberId() {
    return process.env.WHATSAPP_CLOUD_PHONE_NUMBER_ID
        || process.env.WHATSAPP_PHONE_ID
        || '';   // e.g. "123456789012345"
  },
  get appSecret() {
    return process.env.WHATSAPP_CLOUD_APP_SECRET || '';   // e.g. "0123456789abcdef..."
  },
  get verifyToken() {
    return process.env.WHATSAPP_CLOUD_VERIFY_TOKEN || 'gymflow_whatsapp_webhook';
  },
  get apiVersion() {
    return process.env.WHATSAPP_CLOUD_API_VERSION || 'v21.0';
  }
};

const DEFAULT_COUNTRY_CODE = '91'; // India — bare 10-digit numbers default here.

/** True once the platform credentials are present (token + phone number id). */
function isConfigured() {
  return Boolean(CONFIG.accessToken && CONFIG.phoneNumberId);
}

/**
 * Back-compat shim for the old per-tenant `isConnected(tenantId)` check. With the
 * centralized Cloud API there is no per-gym connection — the platform is either
 * configured (ready for everyone) or not. The tenantId arg is ignored.
 */
function isConnected() {
  return isConfigured();
}

/**
 * Validate & normalize a phone number to the digits-only E.164 form the Cloud API
 * expects (no leading '+'). Bare 10-digit numbers default to India. Returns null
 * when the input can't be a valid mobile number.
 */
function validateAndNormalizePhone(phone) {
  if (!phone) return null;
  let numeric = String(phone).replace(/\D/g, '');
  if (numeric.length < 10) return null;
  if (numeric.length === 10) numeric = DEFAULT_COUNTRY_CODE + numeric;
  // Reject absurd lengths (E.164 max is 15 digits).
  if (numeric.length > 15) return null;
  return numeric;
}

/** A masked, safe-to-return view of the config for admin UIs (never leaks secrets). */
function getPublicStatus() {
  const token = CONFIG.accessToken;
  const pid = CONFIG.phoneNumberId;
  const mask = (v, keep = 4) =>
    !v ? '' : (v.length <= keep ? '•'.repeat(v.length) : '•'.repeat(Math.max(4, v.length - keep)) + v.slice(-keep));
  return {
    configured: isConfigured(),
    managed: true,                 // credentials are system-managed, not per-gym
    apiVersion: CONFIG.apiVersion,
    accessTokenMasked: mask(token),
    phoneNumberIdMasked: mask(pid),
    appSecretConfigured: Boolean(CONFIG.appSecret)
  };
}

// ── Low-level Graph API POST ────────────────────────────────────────────────
async function postToGraph(payload) {
  if (!isConfigured()) {
    return { success: false, error: 'WhatsApp Cloud API is not configured on the platform yet.', code: 'NOT_CONFIGURED' };
  }

  const url = `https://graph.facebook.com/${CONFIG.apiVersion}/${CONFIG.phoneNumberId}/messages`;

  // A hard timeout so a hung Graph connection can never wedge a cron worker.
  const controller = (typeof AbortController === 'function') ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), 20000) : null;

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${CONFIG.accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload),
      ...(controller ? { signal: controller.signal } : {})
    });

    let data = {};
    try { data = await response.json(); } catch (_) { /* non-JSON error body */ }

    if (response.ok && data && Array.isArray(data.messages) && data.messages.length) {
      return { success: true, messageId: data.messages[0].id };
    }

    const apiErr = data && data.error;
    const message = (apiErr && apiErr.message) || `Provider rejected the request (HTTP ${response.status}).`;
    console.error('[whatsappCloud] send failed:', message, apiErr || '');
    return {
      success: false,
      error: message,
      code: (apiErr && (apiErr.code || apiErr.type)) || 'PROVIDER_ERROR'
    };
  } catch (err) {
    if (err && err.name === 'AbortError') {
      return { success: false, error: 'WhatsApp provider timed out.', code: 'TIMEOUT' };
    }
    console.error('[whatsappCloud] network error:', err && err.message);
    return { success: false, error: 'Network failure contacting WhatsApp provider.', code: 'NETWORK' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Send a plain text WhatsApp message.
 * NOTE: business-initiated messages outside the 24h customer-service window must
 * use a pre-approved template (sendTemplate). Text is correct for replies and for
 * the automation types where an approved template body is mirrored here.
 * @returns {Promise<{success:boolean, messageId?:string, error?:string, code?:string}>}
 */
async function sendText(toPhone, messageText) {
  const to = validateAndNormalizePhone(toPhone);
  if (!to) return { success: false, error: 'Invalid phone number format.', code: 'INVALID_PHONE' };
  if (!messageText || !String(messageText).trim()) {
    return { success: false, error: 'Message body is empty.', code: 'EMPTY_BODY' };
  }
  return postToGraph({
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'text',
    text: { preview_url: false, body: String(messageText) }
  });
}

/**
 * Send a document (e.g. the welcome invoice PDF) by public link, with an optional
 * text caption. `mediaLink` must be an HTTPS URL the Cloud API can fetch.
 */
async function sendDocument(toPhone, mediaLink, filename, caption) {
  const to = validateAndNormalizePhone(toPhone);
  if (!to) return { success: false, error: 'Invalid phone number format.', code: 'INVALID_PHONE' };
  if (!mediaLink) return { success: false, error: 'Missing document link.', code: 'NO_MEDIA' };
  return postToGraph({
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'document',
    document: {
      link: mediaLink,
      filename: filename || 'document.pdf',
      ...(caption ? { caption: String(caption) } : {})
    }
  });
}

/**
 * Send an approved template message (business-initiated, outside the 24h window).
 * components follow the Cloud API shape. Kept available for gyms/automations that
 * graduate to fully-approved templates.
 */
async function sendTemplate(toPhone, templateName, languageCode = 'en', components = []) {
  const to = validateAndNormalizePhone(toPhone);
  if (!to) return { success: false, error: 'Invalid phone number format.', code: 'INVALID_PHONE' };
  if (!templateName) return { success: false, error: 'Missing template name.', code: 'NO_TEMPLATE' };
  return postToGraph({
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'template',
    template: {
      name: templateName,
      language: { code: languageCode },
      ...(components && components.length ? { components } : {})
    }
  });
}

// ── Webhook helpers ─────────────────────────────────────────────────────────

/**
 * Verify the subscription handshake Meta performs on the webhook GET endpoint.
 * Returns the challenge string to echo back, or null to reject (403).
 */
function verifyWebhookSubscription(query) {
  const mode = query['hub.mode'];
  const token = query['hub.verify_token'];
  const challenge = query['hub.challenge'];
  if (mode === 'subscribe' && token && token === CONFIG.verifyToken) {
    return challenge;
  }
  return null;
}

/**
 * Verify the X-Hub-Signature-256 header on an inbound webhook POST. `rawBody` must
 * be the exact raw request bytes/string (not the parsed object). When no app
 * secret is configured we cannot verify — return false so the caller can decide.
 */
function verifyWebhookSignature(rawBody, signatureHeader) {
  const secret = CONFIG.appSecret;
  if (!secret || !signatureHeader) return false;
  try {
    const expected = 'sha256=' + crypto
      .createHmac('sha256', secret)
      .update(rawBody || '', 'utf8')
      .digest('hex');
    const a = Buffer.from(expected);
    const b = Buffer.from(String(signatureHeader));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch (e) {
    return false;
  }
}

module.exports = {
  CONFIG,
  isConfigured,
  isConnected,          // back-compat shim (tenantId ignored)
  validateAndNormalizePhone,
  getPublicStatus,
  sendText,
  sendDocument,
  sendTemplate,
  verifyWebhookSubscription,
  verifyWebhookSignature
};
