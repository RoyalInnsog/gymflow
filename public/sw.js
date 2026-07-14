// ============================================================================
// Gym Flow — Service Worker (PWA layer). Transparent to the application.
//   • Cache-first  : static assets (JS/CSS/fonts/icons/images) -> instant start
//   • Network-first: navigations + /api GETs (IndexedDB is still the UI's source)
//   • Background Sync: replays the offline outbox even with no tab open; falls
//     back to the in-page reconnect drain where Background Sync is unavailable.
//   • Versioned caches with automatic cleanup on activate.
// Never caches or replays non-GET requests except the explicit outbox replay.
// ============================================================================
'use strict';

// NOTE: a service worker's CSP is captured from the sw.js response headers at
// install time. Whenever the CSP in server.js changes, bump CACHE_VERSION so
// the byte-changed script installs a fresh SW that picks up the new CSP.
var CACHE_VERSION = 'v15';
var STATIC_CACHE = 'gymflow-static-' + CACHE_VERSION;
var RUNTIME_CACHE = 'gymflow-runtime-' + CACHE_VERSION;

var PRECACHE = [
  '/manifest.webmanifest',
  '/assets/css/shared.css',
  '/assets/css/tailwind.css',
  '/assets/js/designSystem.js',
  '/assets/js/api.js',
  '/assets/js/membershipEngine.js',
  '/assets/js/utils.js',
  '/assets/js/appShell.js',
  '/assets/js/offline/idb.js',
  '/assets/js/offline/localdb.js',
  '/assets/js/offline/netTransport.js',
  '/assets/js/offline/routeRegistry.js',
  '/assets/js/offline/outbox.js',
  '/assets/js/offline/syncEngine.js',
  '/assets/js/offline/networkWatcher.js',
  '/assets/js/offline/repositories.js',
  '/assets/js/offline/apiOffline.js',
  '/assets/js/offline/offlineBootstrap.js',
  '/assets/js/member/exerciseLibrary.js',
  '/assets/js/member/memberEngine.js',
  '/assets/js/member/memberDocs.js',
  '/assets/js/member/memberAI.js',
  '/assets/js/member/memberLLM.js',
  '/assets/img/icon-192.png',
  '/assets/img/icon-512.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(STATIC_CACHE).then(function (cache) {
      // Best-effort: a single missing file must not abort the whole install.
      return Promise.all(PRECACHE.map(function (url) {
        return cache.add(url).catch(function () {});
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k !== STATIC_CACHE && k !== RUNTIME_CACHE) return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

function isStaticAsset(url) {
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') return true;
  return /\.(?:js|css|woff2?|ttf|otf|png|jpg|jpeg|gif|svg|webp|ico|webmanifest|json)(?:\?.*)?$/i.test(url.pathname);
}

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return; // writes are owned by the app + outbox

  var url = new URL(req.url);
  var sameOrigin = url.origin === self.location.origin;

  // API GETs: network-first, fall back to whatever we last cached.
  if (sameOrigin && url.pathname.indexOf('/api/') === 0) {
    event.respondWith(
      fetch(req).then(function (res) {
        var copy = res.clone();
        caches.open(RUNTIME_CACHE).then(function (c) { c.put(req, copy); });
        return res;
      }).catch(function () { return caches.match(req); })
    );
    return;
  }

  // Navigations: network-first so users get fresh HTML online, cached shell
  // offline. Successful SAME-URL responses are stored at runtime (auth pages
  // can't be precached at install — following their login redirect would poison
  // the cache), so an offline cold start serves the last good shell. Member
  // routes fall back to the member shell, everything else to /dashboard — an
  // offline member must never be dumped into the (staff) dashboard shell.
  if (req.mode === 'navigate') {
    var fallback = url.pathname.indexOf('/member') === 0 ? '/member' : '/dashboard';
    event.respondWith(
      fetch(req).then(function (res) {
        if (res && res.ok && !res.redirected) {
          var copy = res.clone();
          caches.open(RUNTIME_CACHE).then(function (c) { c.put(req, copy); });
        }
        return res;
      }).catch(function () {
        return caches.match(req).then(function (m) { return m || caches.match(fallback); });
      })
    );
    return;
  }

  // Static assets: instant startup + self-updating.
  //  • Cross-origin (CDN/fonts): cache-first (opaque, rarely changes).
  //  • Same-origin JS/CSS/img/etc: Network-First with cache fallback.
  //    This ensures we always load the newest assets when online, preventing
  //    UI/script mismatches after new deployments, while keeping it fast and offline-ready.
  if (isStaticAsset(url)) {
    if (!sameOrigin) {
      event.respondWith(
        caches.match(req).then(function (cached) {
          return cached || fetch(req).then(function (res) {
            if (res && (res.ok || res.type === 'opaque')) {
              var copy = res.clone();
              caches.open(STATIC_CACHE).then(function (c) { c.put(req, copy); });
            }
            return res;
          });
        })
      );
      return;
    }
    event.respondWith(
      fetch(req).then(function (res) {
        if (res && res.ok) {
          var copy = res.clone();
          caches.open(STATIC_CACHE).then(function (c) { c.put(req, copy); });
        }
        return res;
      }).catch(function () {
        return caches.match(req);
      })
    );
  }
});

// ---- Background Sync: replay the outbox with no tab open --------------------
self.addEventListener('sync', function (event) {
  if (event.tag === 'gymflow-outbox') {
    event.waitUntil(replayOutbox());
  }
});

self.addEventListener('message', function (event) {
  if (event.data === 'gymflow-skip-waiting') self.skipWaiting();
  if (event.data === 'gymflow-purge-runtime') {
    event.waitUntil(
      caches.delete(RUNTIME_CACHE).then(function () {
        return caches.open(RUNTIME_CACHE);
      })
    );
  }
});

function openGymDB() {
  return new Promise(function (resolve, reject) {
    var req = indexedDB.open('gymflow'); // no version -> never triggers upgrade
    req.onsuccess = function () { resolve(req.result); };
    req.onerror = function () { reject(req.error); };
  });
}

function replayOutbox() {
  return openGymDB().then(function (db) {
    if (!db.objectStoreNames.contains('__outbox')) { db.close(); return; }
    return new Promise(function (resolve) {
      var items = [];
      var tx = db.transaction('__outbox', 'readonly');
      var cur = tx.objectStore('__outbox').openCursor();
      cur.onsuccess = function () {
        var c = cur.result;
        if (c) { if (c.value.status === 'pending') items.push(c.value); c.continue(); }
        else resolve(items);
      };
      cur.onerror = function () { resolve(items); };
    }).then(function (items) {
      items.sort(function (a, b) { return (a.priority - b.priority) || (a.createdAt - b.createdAt); });
      var chain = Promise.resolve();
      items.forEach(function (it) {
        chain = chain.then(function () {
          return fetch('/api/v1' + it.endpoint, {
            method: it.method, credentials: 'include',
            headers: { 'Content-Type': 'application/json', 'Idempotency-Key': it.idempotencyKey },
            body: it.body != null ? (typeof it.body === 'string' ? it.body : JSON.stringify(it.body)) : undefined
          }).then(function (res) {
            if (res.ok) {
              return new Promise(function (done) {
                var tx2 = db.transaction('__outbox', 'readwrite');
                tx2.objectStore('__outbox').delete(it.id);
                tx2.oncomplete = function () { done(); };
                tx2.onerror = function () { done(); };
              });
            }
          }).catch(function () { /* still offline — leave queued */ });
        });
      });
      return chain.then(function () { db.close(); });
    });
  }).catch(function () {});
}
