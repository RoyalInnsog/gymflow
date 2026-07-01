/**
 * WhatsApp Controller
 * -----------------------------------------------------------------------------
 * Thin request handlers for WhatsApp connection management. All business logic
 * lives in services/. Every handler is tenant-scoped (req.tenant_id) so one gym
 * can never touch another gym's WhatsApp session.
 *
 * Mounted by server.js at BOTH:
 *   /api/v1/whatsapp/*   (JSON API used by the Settings UI)
 *   /api/whatsapp/*      (so the Android WebView can open /api/whatsapp/qr directly)
 *
 * The QR is generated as a Base64 PNG Data URL inside services/whatsapp.service.js
 * (via the `qrcode` library) and cached in memory per tenant — never printed to a
 * terminal, so it renders on any screen including the mobile WebView.
 */

const service = require('../services/whatsapp.service');
const queue = require('../services/whatsapp.queue');

// GET /whatsapp/status  -> current connection state for this tenant.
async function getStatus(req, res) {
  try {
    const s = service.getStatus(req.tenant_id);
    res.json({
      status: s.status,                 // INITIALIZING | WAITING_FOR_QR | CONNECTED | DISCONNECTED
      connected: s.connected,
      info: s.info,
      lastError: s.lastError,
      pending: queue.pendingCount(req.tenant_id)
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to read WhatsApp status.' });
  }
}

// GET /whatsapp/qr
//   - Top-level browser/WebView navigation (Accept: text/html) -> a scannable
//     HTML page that shows the QR image and auto-updates to "Connected".
//   - Programmatic clients (fetch with Accept: application/json) -> JSON
//     { status, qr } where `qr` is a Base64 PNG Data URL (or null).
async function getQr(req, res) {
  try {
    const wantsHtml = (req.headers.accept || '').includes('text/html');
    if (wantsHtml) {
      // The page drives itself via the JSON endpoints under this same mount path.
      return res.type('html').send(renderQrPage(req.baseUrl || '/api/whatsapp'));
    }
    const { status, qr } = service.getQr(req.tenant_id);
    res.json({ status, qr: qr || null });
  } catch (err) {
    res.status(500).json({ error: 'Failed to read WhatsApp QR.' });
  }
}

// POST /whatsapp/connect  -> start the client / (re)generate a QR.
async function connect(req, res) {
  try {
    const status = await service.connect(req.tenant_id);
    res.json({ status, message: 'WhatsApp client initializing. Poll /whatsapp/qr then /whatsapp/status.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to start WhatsApp client: ' + err.message });
  }
}

// POST /whatsapp/disconnect  -> log out & wipe the session (new QR next time).
async function disconnect(req, res) {
  try {
    await service.disconnect(req.tenant_id);
    res.json({ status: service.STATUS.DISCONNECTED, message: 'WhatsApp disconnected.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to disconnect WhatsApp: ' + err.message });
  }
}

// Self-contained, mobile-first HTML page for scanning the QR on-device. Inline
// CSS/JS only (passes the app CSP: script-src/style-src 'unsafe-inline', img-src
// data:). It polls the JSON endpoints under `base` and flips to a success state
// the instant the scan completes — no page refresh, no terminal needed.
function renderQrPage(base) {
  const BASE = String(base).replace(/"/g, '');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<title>Link WhatsApp · Gym Flow</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
    background:#0b1020; color:#e6e9f2; font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif; padding:20px; }
  .card { width:100%; max-width:380px; background:#141a2e; border:1px solid #243; border-radius:18px;
    padding:24px; text-align:center; box-shadow:0 12px 40px rgba(0,0,0,.45); }
  h1 { font-size:20px; margin:0 0 4px; }
  .sub { margin:0 0 18px; color:#9aa3bd; font-size:14px; min-height:18px; }
  .qrbox { width:260px; height:260px; margin:0 auto 18px; background:#fff; border-radius:14px;
    display:flex; align-items:center; justify-content:center; overflow:hidden; }
  .qrbox img { width:100%; height:100%; object-fit:contain; }
  .spinner { width:46px; height:46px; border:5px solid #d7def0; border-top-color:#16c8ee; border-radius:50%;
    animation:spin 1s linear infinite; }
  @keyframes spin { to { transform:rotate(360deg); } }
  .done { color:#16a34a; font-size:54px; line-height:1.1; font-weight:700; }
  ol.steps { text-align:left; color:#c7cde0; font-size:13px; line-height:1.7; padding-left:20px; margin:0 0 14px; }
  ol.steps b { color:#fff; }
  .status { font-size:12px; color:#7b86a6; margin:0; }
  .status b { color:#16c8ee; }
</style>
</head>
<body>
  <div class="card">
    <h1>Link WhatsApp</h1>
    <p class="sub" id="hint">Starting WhatsApp session…</p>
    <div class="qrbox">
      <div id="spinner" class="spinner"></div>
      <img id="qr" alt="WhatsApp QR code" style="display:none">
      <div id="done" class="done" style="display:none">&#10003;</div>
    </div>
    <ol class="steps">
      <li>Open <b>WhatsApp</b> on your phone</li>
      <li>Tap <b>Settings &rarr; Linked Devices</b></li>
      <li>Tap <b>Link a Device</b> and scan the code above</li>
    </ol>
    <p class="status">Status: <b id="status">&hellip;</b></p>
  </div>
<script>
(function(){
  var BASE = "${BASE}";
  var qrImg = document.getElementById('qr');
  var spinner = document.getElementById('spinner');
  var done = document.getElementById('done');
  var statusEl = document.getElementById('status');
  var hint = document.getElementById('hint');
  var stopped = false;

  function getJSON(url, opts){
    opts = opts || {};
    opts.headers = Object.assign({ 'Accept':'application/json', 'Content-Type':'application/json' }, opts.headers||{});
    opts.credentials = 'include';
    return fetch(url, opts).then(function(r){ return r.json().catch(function(){ return {}; }); });
  }
  function showQr(d){ qrImg.src=d; qrImg.style.display='block'; spinner.style.display='none'; done.style.display='none';
    hint.textContent='Scan this code to link your WhatsApp.'; }
  function showSpinner(){ spinner.style.display='block'; qrImg.style.display='none'; done.style.display='none'; }
  function showDone(){ done.style.display='block'; qrImg.style.display='none'; spinner.style.display='none';
    hint.textContent='Connected! Your WhatsApp is linked. You can close this page.'; }

  async function tick(){
    if (stopped) return;
    try {
      var st = await getJSON(BASE + '/status');
      statusEl.textContent = st.status || '…';
      if (st.connected) { showDone(); stopped = true; return; }
      var q = await getJSON(BASE + '/qr');
      if (q && q.qr) showQr(q.qr); else showSpinner();
    } catch (e) { /* transient — keep polling */ }
    setTimeout(tick, 2500);
  }
  // Ensure a client is running (generates a QR if needed), then poll.
  getJSON(BASE + '/connect', { method:'POST' }).catch(function(){}).then(tick);
})();
</script>
</body>
</html>`;
}

module.exports = { getStatus, getQr, connect, disconnect };
