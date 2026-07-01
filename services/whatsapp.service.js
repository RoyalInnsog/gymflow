/**
 * WhatsApp Service — real, free WhatsApp automation via whatsapp-web.js
 * -----------------------------------------------------------------------------
 * Replaces the previous Meta Cloud-API abstraction. Messages are sent from the
 * manager's OWN WhatsApp account after a one-time QR scan. Sessions are persisted
 * with LocalAuth so the QR survives server restarts.
 *
 * The app is multi-tenant, so this module manages ONE whatsapp-web.js Client per
 * tenant (keyed by tenant id). Each gym scans its own QR and sends from its own
 * number. Clients are created lazily (only when a tenant connects) and previously
 * authenticated tenants are restored automatically on boot.
 *
 * Status state machine (exposed to the frontend):
 *   INITIALIZING     — client booting / Chromium launching
 *   WAITING_FOR_QR   — QR generated, waiting for the manager to scan
 *   CONNECTED        — authenticated & ready to send
 *   DISCONNECTED     — not connected (never started, logged out, or dropped)
 */

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const session = require('./whatsapp.session');

const STATUS = {
  INITIALIZING: 'INITIALIZING',
  WAITING_FOR_QR: 'WAITING_FOR_QR',
  CONNECTED: 'CONNECTED',
  DISCONNECTED: 'DISCONNECTED'
};

// tenantId -> { client, status, qr, qrDataUrl, lastError, info, reconnectTimer, reconnectAttempts, ready }
const sessions = new Map();

const MAX_RECONNECT_ATTEMPTS = 5;

function getEntry(tenantId) {
  let entry = sessions.get(tenantId);
  if (!entry) {
    entry = {
      client: null,
      status: STATUS.DISCONNECTED,
      qr: null,
      qrDataUrl: null,
      lastError: null,
      info: null,
      reconnectTimer: null,
      reconnectAttempts: 0,
      ready: false
    };
    sessions.set(tenantId, entry);
  }
  return entry;
}

/**
 * Validate & normalize a phone number to a WhatsApp-friendly digits-only string.
 * Defaults bare 10-digit numbers to India (+91). Returns null when invalid.
 */
function validateAndNormalizePhone(phone) {
  if (!phone) return null;
  let numeric = String(phone).replace(/\D/g, '');
  if (numeric.length < 10) return null;
  if (numeric.length === 10) numeric = '91' + numeric;
  return numeric;
}

function wireEvents(tenantId, client) {
  const entry = getEntry(tenantId);

  client.on('qr', async (qr) => {
    entry.qr = qr;
    entry.status = STATUS.WAITING_FOR_QR;
    entry.ready = false;
    try {
      entry.qrDataUrl = await qrcode.toDataURL(qr, { margin: 1, scale: 6 });
    } catch (e) {
      entry.qrDataUrl = null;
    }
    console.log(`[whatsapp][${tenantId}] QR generated — waiting for scan.`);
  });

  client.on('loading_screen', (percent) => {
    if (entry.status !== STATUS.CONNECTED) entry.status = STATUS.INITIALIZING;
  });

  client.on('authenticated', () => {
    entry.qr = null;
    entry.qrDataUrl = null;
    entry.status = STATUS.INITIALIZING;
    console.log(`[whatsapp][${tenantId}] Authenticated — finalizing session.`);
  });

  client.on('auth_failure', (msg) => {
    entry.status = STATUS.DISCONNECTED;
    entry.ready = false;
    entry.lastError = 'Authentication failed: ' + msg;
    console.error(`[whatsapp][${tenantId}] Auth failure:`, msg);
  });

  client.on('ready', () => {
    entry.status = STATUS.CONNECTED;
    entry.ready = true;
    entry.qr = null;
    entry.qrDataUrl = null;
    entry.lastError = null;
    entry.reconnectAttempts = 0;
    try { entry.info = client.info ? { wid: client.info.wid && client.info.wid._serialized, pushname: client.info.pushname } : null; } catch (e) {}
    console.log(`[whatsapp][${tenantId}] CONNECTED — ready to send.`);
    // Let the queue know it can drain any pending jobs.
    if (module.exports.onReady) module.exports.onReady(tenantId);
  });

  client.on('change_state', (state) => {
    if (state === 'CONNECTED') {
      entry.status = STATUS.CONNECTED;
      entry.ready = true;
    } else if (entry.status === STATUS.CONNECTED && state !== 'CONNECTED') {
      // Lost the connected state (e.g. phone offline / conflict).
      entry.ready = false;
    }
  });

  client.on('disconnected', (reason) => {
    entry.status = STATUS.DISCONNECTED;
    entry.ready = false;
    entry.lastError = 'Disconnected: ' + reason;
    console.warn(`[whatsapp][${tenantId}] Disconnected (${reason}) — scheduling reconnect.`);
    scheduleReconnect(tenantId, reason);
  });
}

// Auto-reconnect with backoff. A LOGOUT reason means the user unlinked the device
// (or session was deleted): do NOT silently reconnect — that would loop forever.
function scheduleReconnect(tenantId, reason) {
  const entry = getEntry(tenantId);
  if (entry.reconnectTimer) return;
  if (String(reason).toUpperCase().includes('LOGOUT')) {
    // Session is gone; require a fresh connect (QR) initiated by the manager.
    cleanupClient(tenantId).catch(() => {});
    return;
  }
  if (entry.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    console.error(`[whatsapp][${tenantId}] Max reconnect attempts reached; giving up until manual reconnect.`);
    return;
  }
  const attempt = ++entry.reconnectAttempts;
  const delay = Math.min(30000, 5000 * attempt);
  entry.reconnectTimer = setTimeout(async () => {
    entry.reconnectTimer = null;
    console.log(`[whatsapp][${tenantId}] Reconnect attempt ${attempt}...`);
    try {
      await cleanupClient(tenantId, { keepEntry: true });
      await initialize(tenantId);
    } catch (e) {
      console.error(`[whatsapp][${tenantId}] Reconnect failed:`, e.message);
      scheduleReconnect(tenantId, reason);
    }
  }, delay);
}

async function cleanupClient(tenantId, { keepEntry = false } = {}) {
  const entry = sessions.get(tenantId);
  if (!entry) return;
  if (entry.reconnectTimer) { clearTimeout(entry.reconnectTimer); entry.reconnectTimer = null; }
  if (entry.client) {
    try { await entry.client.destroy(); } catch (e) { /* already gone */ }
  }
  entry.client = null;
  entry.ready = false;
  if (!keepEntry) {
    entry.status = STATUS.DISCONNECTED;
    entry.qr = null;
    entry.qrDataUrl = null;
  }
}

/**
 * Create & initialize a client for a tenant (idempotent). Returns immediately;
 * connection progress is observed via getStatus()/getQr().
 */
async function initialize(tenantId) {
  session.ensureSessionRoot();
  const entry = getEntry(tenantId);

  if (entry.client && (entry.status === STATUS.CONNECTED || entry.status === STATUS.INITIALIZING || entry.status === STATUS.WAITING_FOR_QR)) {
    return entry.status; // already running
  }

  entry.status = STATUS.INITIALIZING;
  entry.lastError = null;

  const client = new Client({
    authStrategy: new LocalAuth({
      clientId: session.sanitizeClientId(tenantId),
      dataPath: session.SESSION_ROOT
    }),
    puppeteer: session.puppeteerOptions(),
    webVersionCache: { type: 'local', path: session.CACHE_ROOT }
  });

  entry.client = client;
  wireEvents(tenantId, client);

  client.initialize().catch((err) => {
    entry.status = STATUS.DISCONNECTED;
    entry.lastError = 'Initialization error: ' + (err && err.message);
    console.error(`[whatsapp][${tenantId}] initialize() failed:`, err && err.message);
  });

  return entry.status;
}

/** Public: start/connect a tenant's WhatsApp (used by the Connect button). */
async function connect(tenantId) {
  return initialize(tenantId);
}

/** Public: fully disconnect & wipe the tenant's session (forces a new QR next time). */
async function disconnect(tenantId) {
  const entry = sessions.get(tenantId);
  if (entry && entry.client) {
    try { await entry.client.logout(); } catch (e) { /* may already be logged out */ }
  }
  await cleanupClient(tenantId);
  const e2 = getEntry(tenantId);
  e2.status = STATUS.DISCONNECTED;
  e2.reconnectAttempts = 0;
  return STATUS.DISCONNECTED;
}

function getStatus(tenantId) {
  const entry = sessions.get(tenantId);
  if (!entry) {
    return { status: STATUS.DISCONNECTED, connected: false, lastError: null, info: null };
  }
  return {
    status: entry.status,
    connected: entry.status === STATUS.CONNECTED && entry.ready,
    lastError: entry.lastError,
    info: entry.info
  };
}

function getQr(tenantId) {
  const entry = sessions.get(tenantId);
  if (!entry) return { status: STATUS.DISCONNECTED, qr: null };
  return { status: entry.status, qr: entry.qrDataUrl };
}

function isConnected(tenantId) {
  const entry = sessions.get(tenantId);
  return !!(entry && entry.status === STATUS.CONNECTED && entry.ready && entry.client);
}

/**
 * Send a single message NOW (no queue). Throws on failure so the queue can apply
 * its retry policy. `phone` may be raw; it is normalized here.
 * Returns { messageId }.
 */
async function sendMessageNow(tenantId, phone, messageText) {
  const entry = sessions.get(tenantId);
  if (!entry || !entry.client || entry.status !== STATUS.CONNECTED || !entry.ready) {
    const err = new Error('WhatsApp is not connected for this account.');
    err.code = 'NOT_CONNECTED';
    throw err;
  }
  const normalized = validateAndNormalizePhone(phone);
  if (!normalized) {
    const err = new Error('Invalid phone number format.');
    err.code = 'INVALID_PHONE';
    throw err;
  }

  // Confirm the number is actually on WhatsApp before sending.
  let chatId;
  try {
    const numberId = await entry.client.getNumberId(normalized);
    if (!numberId) {
      const err = new Error('This number is not registered on WhatsApp.');
      err.code = 'NOT_ON_WHATSAPP';
      throw err;
    }
    chatId = numberId._serialized;
  } catch (e) {
    if (e.code) throw e;
    // getNumberId can throw if the session drops mid-call.
    const err = new Error('Could not verify recipient on WhatsApp: ' + e.message);
    err.code = 'LOOKUP_FAILED';
    throw err;
  }

  const sent = await entry.client.sendMessage(chatId, messageText);
  return { messageId: sent && sent.id ? sent.id._serialized : null };
}

/**
 * On boot, re-initialize every tenant that has a persisted session so connected
 * gyms reconnect automatically WITHOUT a new QR. Non-blocking.
 */
function restorePersistedSessions() {
  const ids = session.listPersistedTenantIds();
  if (!ids.length) {
    console.log('[whatsapp] No persisted sessions to restore.');
    return;
  }
  console.log(`[whatsapp] Restoring ${ids.length} persisted session(s): ${ids.join(', ')}`);
  ids.forEach((tenantId) => {
    initialize(tenantId).catch((e) => console.error(`[whatsapp][${tenantId}] restore failed:`, e.message));
  });
}

/** Graceful shutdown — destroy all clients so Chromium processes don't linger. */
async function shutdown() {
  const ids = Array.from(sessions.keys());
  await Promise.all(ids.map((id) => cleanupClient(id).catch(() => {})));
}

module.exports = {
  STATUS,
  validateAndNormalizePhone,
  connect,
  disconnect,
  initialize,
  getStatus,
  getQr,
  isConnected,
  sendMessageNow,
  restorePersistedSessions,
  shutdown,
  // Set by the queue module so the service can trigger a drain on (re)connect.
  onReady: null
};
