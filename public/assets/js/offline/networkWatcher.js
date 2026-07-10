// ============================================================================
// Gym Flow — Offline layer :: networkWatcher.js  (window.GymNet)
// Knows the connectivity + sync state and reflects it in a SUBTLE status pill.
// States: online | offline | syncing | pending(n) | conflict. On reconnect it
// automatically drains the outbox and refreshes hot data — the user never
// presses "Sync". The pill only appears when there is something to say, and is
// suppressed on focused-flow screens (wizards / payment) so it never intrudes.
// ============================================================================
(function () {
  'use strict';

  var HEARTBEAT_MS = 45000;
  var listeners = [];

  // Local-infrastructure / loopback bypass ---------------------------------
  // When the app is served from localhost or a private-subnet IP, the server IS
  // the host we're talking to — a rendered page already proves reachability. A
  // heartbeat blip or a flaky navigator.onLine flag must NOT flip us to a bogus
  // "Offline" state on LAN / on-prem deployments. Treat these hosts as always
  // online. Matches localhost, *.local, and the RFC-1918 private ranges
  // (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16) plus IPv6 loopback.
  function isLocalNetworkHost() {
    try {
      var h = ((self.location && self.location.hostname) || '').toLowerCase();
      if (!h) return false;
      if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0.0.0.0') return true;
      if (h.slice(-6) === '.local') return true;
      if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
      if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
      if (/^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
      return false;
    } catch (e) { return false; }
  }

  var state = {
    online: isLocalNetworkHost() ? true
          : ((typeof navigator !== 'undefined' && 'onLine' in navigator) ? navigator.onLine : true),
    syncing: false,
    pending: 0,
    conflicts: 0
  };

  // Routes that run a distraction-free flow: never show chrome here.
  var SUPPRESS_PATHS = [
    '/add-member', '/add-member-step-1', '/renew', '/receipt', '/payment-center',
    '/login', '/login-alt', '/signup', '/forgot-password', '/reset-password',
    '/verify-email', '/verify-phone', '/select-role', '/member-coming-soon'
  ];
  function suppressed() {
    if (self.__SUPPRESS_OFFLINE_PILL__) return true;
    var p = (self.location && self.location.pathname) || '';
    return SUPPRESS_PATHS.indexOf(p) !== -1;
  }

  function emit() {
    listeners.forEach(function (cb) { try { cb(getState()); } catch (e) {} });
    render();
  }
  function getState() { return Object.assign({}, state); }
  function isOnline() { return state.online; }
  function on(cb) { listeners.push(cb); return function () { listeners = listeners.filter(function (x) { return x !== cb; }); }; }

  function refreshCounts() {
    if (!self.GymOutbox) return Promise.resolve();
    return Promise.all([self.GymOutbox.pendingCount(), self.GymOutbox.conflicts()])
      .then(function (r) { state.pending = r[0]; state.conflicts = (r[1] || []).length; emit(); })
      .catch(function () {});
  }

  // Called by the sync engine as it works.
  function _onSync(phase) {
    state.syncing = (phase === 'syncing');
    if (phase === 'idle') refreshCounts(); else emit();
  }

  function setOnline(next) {
    // On local infrastructure we never report offline (see isLocalNetworkHost).
    if (isLocalNetworkHost()) next = true;
    if (state.online === next) return;
    state.online = next;
    emit();
    if (next && self.GymSyncEngine) {
      // Reconnected: automatically drain + refresh.
      self.GymSyncEngine.syncNow().then(refreshCounts).catch(function () {});
    }
  }

  function heartbeat() {
    if (!self.GymNetTransport) return;
    self.GymNetTransport.fetch('/auth/config', { method: 'GET' })
      .then(function (res) { setOnline(!!res); })
      .catch(function () { setOnline(false); });
  }

  // ---- Subtle status pill ------------------------------------------------
  var el = null;
  function ensureEl() {
    if (el || typeof document === 'undefined' || !document.body) return el;
    el = document.createElement('div');
    el.id = 'gym-net-pill';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.style.cssText = [
      'position:fixed', 'left:12px', 'bottom:76px', 'z-index:2147483000',
      'display:none', 'align-items:center', 'gap:6px',
      'padding:6px 10px', 'border-radius:9999px',
      'font:600 12px/1 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif',
      'color:#fff', 'background:#334155', 'box-shadow:0 4px 12px rgba(0,0,0,.18)',
      'pointer-events:none', 'transition:opacity .2s ease', 'opacity:0'
    ].join(';');
    document.body.appendChild(el);
    return el;
  }

  function render() {
    if (suppressed()) { if (el) { el.style.display = 'none'; } return; }
    var node = ensureEl();
    if (!node) return;
    var label = null, bg = '#334155', dot = '●';
    if (!state.online) { label = state.pending ? ('Offline · ' + state.pending + ' queued') : 'Offline'; bg = '#b45309'; }
    else if (state.syncing) { label = 'Syncing…'; bg = '#1d4ed8'; }
    else if (state.conflicts) { label = state.conflicts + ' need attention'; bg = '#b91c1c'; }
    else if (state.pending) { label = state.pending + ' pending'; bg = '#1d4ed8'; }

    if (label == null) {
      node.style.opacity = '0';
      self.setTimeout(function () { if (node.style.opacity === '0') node.style.display = 'none'; }, 220);
      return;
    }
    node.innerHTML = '<span style="font-size:9px">' + dot + '</span><span>' + label + '</span>';
    node.style.background = bg;
    node.style.display = 'flex';
    // force reflow-free fade-in
    self.requestAnimationFrame(function () { node.style.opacity = '1'; });
  }

  function start() {
    if (typeof self.addEventListener === 'function') {
      self.addEventListener('online', function () { setOnline(true); });
      self.addEventListener('offline', function () { setOnline(false); });
    }
    self.setInterval(heartbeat, HEARTBEAT_MS);
    refreshCounts();
    emit();
  }

  self.GymNet = {
    getState: getState,
    isOnline: isOnline,
    on: on,
    start: start,
    refreshCounts: refreshCounts,
    _onSync: _onSync,
    setOnline: setOnline
  };
})();
