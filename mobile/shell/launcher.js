// Launcher boot logic — EXTERNAL file on purpose. The shell's CSP is
// `default-src 'self'` (no 'unsafe-inline'), so an inline <script> in
// index.html is refused by Chromium (Android WebView AND the desktop shell),
// leaving the splash stuck at "Starting up…". External same-origin scripts
// pass 'self'. Copied to www/launcher.js by build-www.js.
(function () {
  'use strict';
  var statusEl = document.getElementById('status');
  var spinEl = document.getElementById('spin');
  var errEl = document.getElementById('err');
  var errmsgEl = document.getElementById('errmsg');
  var retryEl = document.getElementById('retry');

  function showRetry(msg) {
    if (msg) errmsgEl.textContent = msg;
    spinEl.style.display = 'none';
    statusEl.style.display = 'none';
    errEl.style.display = 'block';
  }

  function go(path) { window.location.replace(path); }

  // A previous login on this device left a scoped offline DB — good enough
  // to open the app offline; the F4A layer serves cached data and queues
  // writes until the backend is reachable again.
  function hasOfflineScope() {
    try {
      var s = JSON.parse(localStorage.getItem('gymflow.scope') || 'null');
      return !!(s && s.tenantId);
    } catch (e) { return false; }
  }

  function routeFromSession(sess) {
    var user = (sess && sess.user) || {};
    if (sess && sess.pending_role_selection) return '/select-role';
    if (!user.phone_verified) return '/verify-phone';
    if (user.role_id === 'r5') return '/member';
    return '/dashboard';
  }

  function probe() {
    // capacitor-env.js already redirected this document to a bundled page
    // (extensionless-path fallback) — don't race it with a session probe.
    if (window.__ROUTED__) return;
    if (typeof window.api === 'undefined') {
      showRetry('App assets failed to load. Reinstall the app if this persists.');
      return;
    }
    spinEl.style.display = '';
    statusEl.style.display = '';
    statusEl.textContent = 'Checking your session…';
    errEl.style.display = 'none';

    window.api.fetch('/auth/session', { timeout: 12000 })
      .then(function (resp) {
        if (resp && resp.ok) {
          return resp.json().then(function (sess) { go(routeFromSession(sess)); });
        }
        if (resp && (resp.status === 401 || resp.status === 403)) {
          go('/login');
        } else {
          showRetry('The server responded unexpectedly. Try again in a moment.');
        }
      })
      .catch(function () {
        // Offline / server unreachable. Returning users still get the app
        // (cached data); a first run has nothing local to show yet.
        if (hasOfflineScope()) { go('/dashboard'); return; }
        showRetry('Couldn’t reach the server. Check your connection and try again.');
      });
  }

  retryEl.addEventListener('click', probe);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', probe);
  } else {
    probe();
  }
})();
