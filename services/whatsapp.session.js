/**
 * WhatsApp Session & Puppeteer Configuration
 * -----------------------------------------------------------------------------
 * Centralizes every environment-driven knob for the whatsapp-web.js client so the
 * service/queue layers never hardcode paths, timeouts, or Chromium flags.
 *
 * Sessions are persisted on disk via whatsapp-web.js `LocalAuth`. Each tenant gets
 * its own auth folder keyed by tenant id, so a logged-in gym survives server
 * restarts and is NEVER asked to re-scan the QR unless its session is deleted.
 */

const path = require('path');
const fs = require('fs');

// Root folder that holds one sub-folder per tenant session. Kept OUTSIDE the
// public/ web root and git-ignored so session credentials are never served or
// committed (security requirement: "Never expose session files publicly").
const SESSION_ROOT = process.env.WHATSAPP_SESSION_PATH
  ? path.resolve(process.env.WHATSAPP_SESSION_PATH)
  : path.join(__dirname, '..', '.wwebjs_auth');

// Cache folder whatsapp-web.js uses for the WhatsApp Web build it injects.
const CACHE_ROOT = process.env.WHATSAPP_CACHE_PATH
  ? path.resolve(process.env.WHATSAPP_CACHE_PATH)
  : path.join(__dirname, '..', '.wwebjs_cache');

const HEADLESS = process.env.WHATSAPP_HEADLESS !== 'false'; // default true
const EXECUTABLE_PATH = process.env.WHATSAPP_PUPPETEER_EXECUTABLE_PATH || undefined;

// Tunables (all overridable via .env, never hardcoded at call sites).
const SEND_DELAY_MS = parseInt(process.env.WHATSAPP_SEND_DELAY_MS, 10) || 3000;
const MAX_RETRIES = parseInt(process.env.WHATSAPP_MAX_RETRIES, 10) || 3;
const RETRY_DELAY_MS = parseInt(process.env.WHATSAPP_RETRY_DELAY_MS, 10) || 5000;

function ensureSessionRoot() {
  try {
    if (!fs.existsSync(SESSION_ROOT)) fs.mkdirSync(SESSION_ROOT, { recursive: true });
  } catch (e) {
    console.error('[whatsapp] Failed to create session root:', e.message);
  }
}

// LocalAuth names each session folder `session-<clientId>`. We use the tenant id
// (sanitized) as the clientId so one server can host many gyms, each with its own
// WhatsApp account.
function sanitizeClientId(tenantId) {
  return String(tenantId || 'default').replace(/[^a-zA-Z0-9_-]/g, '_');
}

function sessionDirFor(tenantId) {
  return path.join(SESSION_ROOT, 'session-' + sanitizeClientId(tenantId));
}

// True when a tenant has previously authenticated (auth folder exists on disk).
// Used on boot to silently restore connected gyms without prompting for a QR.
function hasPersistedSession(tenantId) {
  try {
    return fs.existsSync(sessionDirFor(tenantId));
  } catch (e) {
    return false;
  }
}

// List tenant ids that have a persisted session folder, so we can re-initialize
// them on server startup.
function listPersistedTenantIds() {
  try {
    if (!fs.existsSync(SESSION_ROOT)) return [];
    return fs.readdirSync(SESSION_ROOT, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.startsWith('session-'))
      .map((d) => d.name.replace(/^session-/, ''));
  } catch (e) {
    return [];
  }
}

// Puppeteer launch options. The --no-sandbox family is required to run headless
// Chromium as a service user on most Linux hosts; harmless on Windows/macOS.
function puppeteerOptions() {
  return {
    headless: HEADLESS,
    executablePath: EXECUTABLE_PATH,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu'
    ]
  };
}

module.exports = {
  SESSION_ROOT,
  CACHE_ROOT,
  SEND_DELAY_MS,
  MAX_RETRIES,
  RETRY_DELAY_MS,
  ensureSessionRoot,
  sanitizeClientId,
  sessionDirFor,
  hasPersistedSession,
  listPersistedTenantIds,
  puppeteerOptions
};
