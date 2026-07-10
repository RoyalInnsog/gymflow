// ============================================================================
// Gym Flow — Offline layer :: apiOffline.js
// The offline-first facade that BECOMES window.api. It is byte-compatible with
// the original ApiService (fetch / get / post / put / delete) so all 40 screens
// keep their exact code — they never learn that data now flows through the local
// DB and an offline outbox.
//
//   GET  -> serve from local DB / cache instantly; revalidate in background;
//           await network only when online AND the cache is stale.
//   WRITE-> registered entities are applied optimistically + queued offline;
//           online-only endpoints (auth, money, uploads) pass straight through
//           and are NEVER faked.
// ============================================================================
(function () {
  'use strict';

  var LDB = self.GymLocalDB;
  var NET = self.GymNetTransport;
  var REG = self.GymRouteRegistry;
  var OUTBOX = self.GymOutbox;
  var SYNC = self.GymSyncEngine;

  // Slow-changing endpoints stay "fresh" longer, so re-navigation is instant.
  var TTL_DEFAULT = 15000;
  var TTL_LONG = 60000;
  var LONG_TTL_RE = /^\/(plans|settings|templates|equipment|staff|analytics|dashboard|reports|roles|branches)/;

  function nowISO() { return new Date().toISOString().slice(0, 19).replace('T', ' '); }
  function uuid() {
    if (self.crypto && self.crypto.randomUUID) return self.crypto.randomUUID();
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }
  // On local infrastructure the server IS the host — a loaded page proves
  // reachability. navigator.onLine is unreliable inside Android WebViews (often
  // false on Wi-Fi), which wrongly forced writes (e.g. manual check-in) down the
  // "offline" path. Treat localhost / private subnets as always online so the
  // request hits the network directly. Mirrors networkWatcher.isLocalNetworkHost.
  function isLocalHost() {
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
  function isOnline() {
    if (isLocalHost()) return true;
    return self.GymNet ? self.GymNet.isOnline() : (navigator ? navigator.onLine : true);
  }
  function ttlFor(path) { return LONG_TTL_RE.test(path) ? TTL_LONG : TTL_DEFAULT; }

  // Build a real Response when possible (so .json()/.ok/.status behave natively),
  // with a minimal shim as a fallback.
  function jsonResponse(body, status) {
    status = status || 200;
    var text = JSON.stringify(body === undefined ? null : body);
    try {
      return Promise.resolve(new Response(text, {
        status: status, headers: { 'Content-Type': 'application/json' }
      }));
    } catch (e) {
      return Promise.resolve({
        ok: status >= 200 && status < 300, status: status,
        json: function () { return Promise.resolve(body); },
        text: function () { return Promise.resolve(text); },
        clone: function () { return this; }
      });
    }
  }

  function markClean(row) { var r = Object.assign({}, row); r._dirty = 0; r._deleted = 0; r._rev = row.updated_at || row.created_at || Date.now(); return r; }

  // ---- READ path ---------------------------------------------------------
  function parseQuery(endpoint) {
    var i = endpoint.indexOf('?');
    var out = {};
    if (i === -1) return out;
    endpoint.slice(i + 1).split('&').forEach(function (pair) {
      var kv = pair.split('=');
      if (kv[0]) out[decodeURIComponent(kv[0])] = decodeURIComponent(kv[1] || '');
    });
    return out;
  }

  function listFromStore(reg, endpoint) {
    var q = parseQuery(endpoint);
    var pred = null;
    if (reg.entity === 'members') {
      pred = function (m) {
        if (q.status && m.status !== q.status) return false;
        if (q.search) {
          var s = String(q.search).toLowerCase();
          return [m.full_name, m.phone, m.email].some(function (v) { return v && String(v).toLowerCase().indexOf(s) !== -1; });
        }
        return true;
      };
    }
    return LDB.listEntity(reg.entity, { predicate: pred });
  }

  function localReadResponse(endpoint, reg) {
    return LDB.getResponse('GET', endpoint, '').then(function (cached) {
      if (cached) return jsonResponse(cached.body, cached.status || 200);
      if (reg && reg.kind === 'list') return listFromStore(reg, endpoint).then(function (rows) { return jsonResponse(rows, 200); });
      if (reg && reg.kind === 'item') {
        var id = REG.lastPathSegment(endpoint);
        return LDB.getEntity(reg.entity, id).then(function (rec) { return rec ? jsonResponse(rec, 200) : null; });
      }
      return null;
    });
  }

  function networkRead(endpoint, options, reg) {
    return NET.fetch(endpoint, { method: 'GET', headers: options.headers }).then(function (res) {
      return res.clone().json().then(function (body) {
        if (res.ok) {
          LDB.putResponse('GET', endpoint, '', body, { status: res.status, ttl: ttlFor(REG.stripQuery(endpoint)) });
          // Warm the entity store for UNFILTERED registered lists only, so a
          // filtered fetch never overwrites the full local set with a subset.
          if (reg && reg.kind === 'list' && Array.isArray(body) && endpoint.indexOf('?') === -1) {
            LDB.bulkPutEntity(reg.entity, body.map(markClean)).catch(function () {});
          }
        }
        return res;
      }).catch(function () { return res; }); // non-JSON (file/export) — pass through, no cache
    });
  }

  function handleRead(endpoint, options) {
    var reg = REG.resolveRead(endpoint);
    if (!isOnline()) {
      return localReadResponse(endpoint, reg).then(function (r) {
        return r || jsonResponse(reg && reg.kind === 'list' ? [] : { error: 'Offline and not cached.' }, reg && reg.kind === 'list' ? 200 : 503);
      });
    }
    return LDB.getResponse('GET', endpoint, '').then(function (cached) {
      var fresh = cached && (Date.now() - cached.fetchedAt) < ttlFor(REG.stripQuery(endpoint));
      if (fresh) {
        networkRead(endpoint, options, reg).catch(function () {}); // background revalidate
        return jsonResponse(cached.body, cached.status || 200);
      }
      return networkRead(endpoint, options, reg).catch(function () {
        return localReadResponse(endpoint, reg).then(function (r) {
          return r || jsonResponse(reg && reg.kind === 'list' ? [] : { error: 'Unavailable offline.' }, reg && reg.kind === 'list' ? 200 : 503);
        });
      });
    });
  }

  // ---- WRITE path --------------------------------------------------------
  function buildOptimistic(entity, body, tempId) {
    var base = Object.assign({ id: tempId, _dirty: 1, _deleted: 0, created_at: nowISO() }, body);
    if (entity === 'members') {
      base.status = body.status || 'Active';
      base.full_name = body.full_name || '';
      if (body.end_date) {
        var d = Math.ceil((Date.parse(body.end_date) - Date.now()) / 86400000);
        base.daysLeft = d > 0 ? d : 0;
        base.end_date = body.end_date;
      }
    } else if (entity === 'attendance') {
      base.check_in = nowISO();
      base.access_method = 'manual';
    } else if (entity === 'member_health') {
      // Date-keyed on the server; stamp the key locally so the UI's
      // latest-row-per-day merge works before the sync collapses duplicates.
      base.log_date = body.log_date || nowISO().slice(0, 10);
      base.updated_at = nowISO();
    } else if (entity === 'member_sessions') {
      base.session_date = body.session_date || nowISO().slice(0, 10);
      if (!Array.isArray(base.completed)) base.completed = [];
    } else if (entity === 'member_prs') {
      base.achieved_on = body.achieved_on || nowISO().slice(0, 10);
    } else if (entity === 'member_measurements') {
      base.measured_on = body.measured_on || nowISO().slice(0, 10);
    } else if (entity === 'member_goals') {
      base.status = body.status || 'active';
    }
    return base;
  }

  // Returns a Promise<Response>. `w` is the resolved write rule.
  function handleWrite(method, endpoint, options, w) {
    var body = {};
    try { body = options.body ? JSON.parse(options.body) : {}; } catch (e) { body = {}; }
    var entity = w.entity, op = w.op;
    var tempId = null, entityId = null;

    var prep = Promise.resolve(null); // optimistic local mutation, resolves to member obj if relevant

    if (op === 'create') {
      // Attendance: prevent duplicate same-day check-ins locally.
      if (entity === 'attendance') {
        prep = LDB.listEntity('attendance', {
          predicate: function (a) {
            return a.member_id === body.member_id && (a.check_in || '').slice(0, 10) === nowISO().slice(0, 10);
          }
        }).then(function (dupes) {
          if (dupes && dupes.length) return { __dupe: true };
          tempId = 'local_' + uuid();
          var rec = buildOptimistic(entity, body, tempId);
          return LDB.getEntity('members', body.member_id).then(function (m) {
            if (m) rec.full_name = m.full_name;
            return LDB.putEntity(entity, rec).then(function () { return { member: m || { id: body.member_id } }; });
          });
        });
      } else {
        tempId = 'local_' + uuid();
        prep = LDB.putEntity(entity, buildOptimistic(entity, body, tempId));
      }
    } else if (op === 'update') {
      entityId = REG.lastPathSegment(endpoint);
      prep = LDB.getEntity(entity, entityId).then(function (rec) {
        var merged = Object.assign({}, rec || { id: entityId }, body, { _dirty: 1, _updatedLocal: Date.now() });
        return LDB.putEntity(entity, merged);
      });
    } else if (op === 'delete') {
      entityId = REG.lastPathSegment(endpoint);
      prep = LDB.getEntity(entity, entityId).then(function (rec) {
        if (rec && String(entityId).indexOf('local_') === 0) return LDB.deleteEntity(entity, entityId); // never-synced temp
        return LDB.putEntity(entity, Object.assign({}, rec || { id: entityId }, { _deleted: 1, _dirty: 1, _updatedLocal: Date.now() }));
      });
    }

    function synthSuccess(ctx) {
      var payload = { offline: true, message: 'Saved offline — will sync automatically.' };
      if (op === 'create' && entity === 'members') { payload.memberId = tempId; payload.id = tempId; }
      else if (op === 'create' && entity === 'attendance') { payload.message = 'Checked in (offline) — will sync.'; payload.member = ctx && ctx.member; }
      else if (op === 'create') { payload.id = tempId; }
      return jsonResponse(payload, 200);
    }

    function enqueue() {
      return OUTBOX.enqueue({
        method: method, endpoint: endpoint, body: options.body || null,
        entity: entity, entityId: entityId, tempId: tempId,
        priority: w.priority, conflictPolicy: w.conflictPolicy
      }).then(function () { if (self.GymNet) self.GymNet.refreshCounts(); });
    }

    function rollback() {
      if (op === 'create' && tempId) return LDB.deleteEntity(entity, tempId);
      if (SYNC && SYNC.PULL_ENDPOINT[entity]) return SYNC.pull(entity);
      return Promise.resolve();
    }

    // A write must bust any cached GET response for this entity's collection so an
    // immediate re-read reflects the change instead of serving a stale body within
    // the TTL window (this is what left the water widget showing the old total
    // until a reload). Online: the re-read revalidates from the network; offline:
    // it falls through to the optimistically-updated entity store.
    function invalidateReads() {
      if (!LDB.deleteResponsesByPrefix) return Promise.resolve();
      var base = REG.stripQuery(endpoint);
      if (op === 'update' || op === 'delete') base = base.replace(/\/[^\/]+$/, '');
      return LDB.deleteResponsesByPrefix(base).catch(function () {});
    }

    return prep.then(function (ctx) {
      if (ctx && ctx.__dupe) return jsonResponse({ message: 'Already checked in today.', duplicate: true, offline: !isOnline() }, 200);

      return invalidateReads().then(function () {
        if (!isOnline()) {
          return enqueue().then(function () { return synthSuccess(ctx); });
        }
        // Online: try the server now. Real validation errors must surface (rollback).
        var netOpts = { method: method, headers: options.headers };
        if (options.body != null) netOpts.body = options.body;
        return NET.fetch(endpoint, netOpts).then(function (res) {
          if (res.ok) {
            // Reconcile locally (fast), then refresh canonical rows in the
            // BACKGROUND so the write returns without waiting on a re-pull.
            var after = Promise.resolve();
            if (tempId) after = after.then(function () { return LDB.deleteEntity(entity, tempId); });
            if (op === 'update' && entityId) after = after.then(function () {
              return LDB.getEntity(entity, entityId).then(function (r) { if (r) { r._dirty = 0; return LDB.putEntity(entity, r); } });
            });
            if (op === 'delete' && entityId) after = after.then(function () { return LDB.deleteEntity(entity, entityId); });
            return after.then(function () {
              if (SYNC && SYNC.PULL_ENDPOINT[entity]) SYNC.pull(entity).catch(function () {});
              if (self.GymNet) self.GymNet.refreshCounts();
              return res;
            });
          }
          if (res.status >= 400 && res.status < 500) {
            // Validation/conflict from the server — undo optimism, surface the error.
            return rollback().then(function () { return res; });
          }
          // 5xx — keep optimism, queue for retry, report success to the UI.
          return enqueue().then(function () { return synthSuccess(ctx); });
        }).catch(function () {
          // Network dropped mid-write — queue and proceed optimistically.
          return enqueue().then(function () { return synthSuccess(ctx); });
        });
      });
    });
  }

  // ---- Facade (ApiService-compatible) -----------------------------------
  function OfflineApi() {
    this.baseUrl = NET.BASE_URL;
    this.cache = new Map();
  }

  OfflineApi.prototype.fetch = function (endpoint, options) {
    options = options || {};
    var method = (options.method || 'GET').toUpperCase();
    // Absolute URLs and anything before the DB is ready -> straight to network.
    if (endpoint.indexOf('http') === 0 || !LDB || !LDB.isScoped()) {
      return NET.fetch(endpoint, options);
    }
    try {
      if (method === 'GET') return handleRead(endpoint, options);
      var w = REG.resolveWrite(method, endpoint);
      if (!w) return NET.fetch(endpoint, options); // online-only / unknown -> passthrough, never faked
      return handleWrite(method, endpoint, options, w);
    } catch (e) {
      // Any facade error must never break a page — fall back to the network.
      return NET.fetch(endpoint, options);
    }
  };

  OfflineApi.prototype._json = function (response) {
    return Promise.resolve(response).then(function (r) {
      try { return r.json(); } catch (e) { return null; }
    }).catch(function () { return null; });
  };
  OfflineApi.prototype.get = function (endpoint, options) {
    var self_ = this; return this.fetch(endpoint, Object.assign({}, options, { method: 'GET' })).then(function (r) { return self_._json(r); });
  };
  OfflineApi.prototype.post = function (endpoint, data, options) {
    var self_ = this; return this.fetch(endpoint, Object.assign({}, options, { method: 'POST', body: JSON.stringify(data) })).then(function (r) { return self_._json(r); });
  };
  OfflineApi.prototype.put = function (endpoint, data, options) {
    var self_ = this; return this.fetch(endpoint, Object.assign({}, options, { method: 'PUT', body: JSON.stringify(data) })).then(function (r) { return self_._json(r); });
  };
  OfflineApi.prototype.delete = function (endpoint, options) {
    var self_ = this; return this.fetch(endpoint, Object.assign({}, options, { method: 'DELETE' })).then(function (r) { return self_._json(r); });
  };

  self.GymApiOffline = { OfflineApi: OfflineApi, create: function () { return new OfflineApi(); } };
})();
