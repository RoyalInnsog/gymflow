// ============================================================================
// Gym Flow — Offline layer :: offlineBootstrap.js
// The entry point that turns everything on. It:
//   1. installs the offline facade as window.api (behind window.__OFFLINE_FIRST__),
//   2. resolves the account's identity (tenant + user) to scope the local DB,
//   3. starts the network watcher and runs the smart initial sync,
//   4. registers the service worker (PWA app-shell + offline startup).
// If anything here fails, window.api quietly falls back to the legacy network
// client, so the app behaves exactly as before — the migration is reversible.
// ============================================================================
(function () {
  'use strict';

  if (self.__GYM_OFFLINE_BOOTED__) return;
  self.__GYM_OFFLINE_BOOTED__ = true;

  // Master kill-switch. Default ON. Disable via window.__OFFLINE_FIRST__ = false
  // (set before this script) OR localStorage['gymflow.offline'] = 'off' (a
  // persistent, user/QA-togglable rollback). Either keeps the legacy ApiService.
  var killed = self.__OFFLINE_FIRST__ === false;
  try { if (self.localStorage.getItem('gymflow.offline') === 'off') killed = true; } catch (e) {}
  if (killed) return;

  var LDB = self.GymLocalDB, NET = self.GymNetTransport, SYNC = self.GymSyncEngine, GymNet = self.GymNet;
  if (!LDB || !NET || !self.GymApiOffline) return; // dependencies missing -> keep legacy window.api

  // 1) Install the facade. It passes through to the network until the DB is
  //    scoped, so nothing breaks during the async identity handshake.
  try { self.api = self.GymApiOffline.create(); } catch (e) { return; }

  function simpleHash(str) {
    var h = 0; str = String(str);
    for (var i = 0; i < str.length; i++) { h = (h * 31 + str.charCodeAt(i)) | 0; }
    return 'u_' + (h >>> 0).toString(36);
  }

  function resolveIdentity() {
    return Promise.all([
      NET.fetch('/auth/session', { method: 'GET' }).then(function (r) { return r && r.ok ? r.json() : null; }).catch(function () { return null; }),
      NET.fetch('/auth/security', { method: 'GET' }).then(function (r) { return r && r.ok ? r.json() : null; }).catch(function () { return null; })
    ]).then(function (res) {
      var sess = res[0], sec = res[1];
      var tenantId = sess && sess.tenant && sess.tenant.id;
      if (!tenantId) return null;
      var userId = sec && sec.email ? simpleHash(sec.email) : 'default';
      return { tenantId: tenantId, userId: userId };
    }).catch(function () { return null; });
  }

  function startRuntime() {
    if (GymNet) GymNet.start();
    // Warm the cache + drain anything queued, but only when we can reach the server.
    if (SYNC && (!GymNet || GymNet.isOnline())) {
      SYNC.push().then(function () { return SYNC.bootstrap(); }).catch(function () {});
    }
  }

  // 2) Scope the DB. Prefer a freshly-resolved identity; fall back to the scope
  //    persisted from a previous session so an OFFLINE cold-start still works.
  LDB.init().then(function () {
    return resolveIdentity();
  }).then(function (id) {
    var persisted = LDB.getScope();
    if (id) {
      // Account switch on this device: isolate by re-scoping (no cross-user leak).
      LDB.setScope(id.tenantId, id.userId);
    } else if (!persisted.tenantId) {
      // Not logged in and nothing cached — leave unscoped (facade stays passthrough).
      return;
    }
    startRuntime();
  }).catch(function () { /* keep passthrough */ });

  // 3) Register the service worker (app shell + offline startup). Secure-context
  //    only (localhost counts); failures are non-fatal.
  if ('serviceWorker' in navigator) {
    self.addEventListener('load', function () {
      navigator.serviceWorker.register('/sw.js').catch(function () { /* no PWA, app still works */ });
    });

    // Auto-update page when the active service worker updates/changes
    var refreshing = false;
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (!refreshing) {
        refreshing = true;
        self.location.reload();
      }
    });
  }

  // Expose a tiny logout hook so the app can purge the current user's cache on a
  // shared device (call from the existing logout handler if desired).
  self.GymOffline = {
    purgeCurrentUser: function () { return LDB.purgeScope(); },
    syncNow: function () { return SYNC ? SYNC.syncNow() : Promise.resolve(); },
    setIdentity: function (tenantId, userId) { LDB.setScope(tenantId, userId); }
  };
})();
