// ============================================================================
// Gym Flow — Offline layer :: localdb.js
// The local database: a SINGLE IndexedDB database ("gymflow") with LOGICAL
// namespacing. Every record carries tenant_id + user_id; every read is filtered
// by the active scope. Repositories and the UI never see scoping — this module
// stamps and filters transparently, so switching accounts isolates data with
// zero cross-tenant/user leakage, and logout can purge just the current user.
//
// This is the only place (with idb.js) that knows about IndexedDB, keeping the
// storage engine replaceable behind a stable API.
// ============================================================================
(function () {
  'use strict';

  var IDB = self.GymIDB;
  var DB_NAME = 'gymflow';
  // v2: [U1] member app entity stores. onUpgrade is incremental (only creates
  // stores that don't exist yet), so existing v1 databases upgrade in place.
  var DB_VERSION = 2;
  var SCOPE_LS_KEY = 'gymflow.scope';

  // Entity stores mirror the server's sync-relevant tables. Extra indexes are
  // declared where a repository needs to query by a foreign key.
  var ENTITY_STORES = {
    members:        { extra: [] },
    memberships:    { extra: ['member_id'] },
    plans:          { extra: [] },
    attendance:     { extra: ['member_id'] },
    invoices:       { extra: ['member_id'] },
    payments:       { extra: ['member_id'] },
    tasks:          { extra: [] },
    notifications:  { extra: [] },
    leads:          { extra: [] },
    equipment:      { extra: [] },
    staff:          { extra: [] },
    settings:       { extra: [] },
    templates:      { extra: [] },
    discount_rules: { extra: [] },
    // [U1] Member app (self-scoped /member/* API)
    member_workouts:     { extra: [] },
    member_sessions:     { extra: [] },
    member_prs:          { extra: [] },
    member_attendance:   { extra: [] },
    member_health:       { extra: ['log_date'] },
    member_measurements: { extra: [] },
    member_goals:        { extra: [] }
  };
  var ENTITY_NAMES = Object.keys(ENTITY_STORES);

  var db = null;
  var scope = { tenantId: null, userId: null };

  // Load any persisted scope so an OFFLINE cold-start opens the right namespace
  // before the identity endpoints can be reached.
  try {
    var saved = JSON.parse(self.localStorage.getItem(SCOPE_LS_KEY) || 'null');
    if (saved && saved.tenantId) scope = { tenantId: saved.tenantId, userId: saved.userId || 'default' };
  } catch (e) {}

  function onUpgrade(database) {
    ENTITY_NAMES.forEach(function (name) {
      var store = database.objectStoreNames.contains(name)
        ? null
        : database.createObjectStore(name, { keyPath: 'id' });
      if (!store) return;
      store.createIndex('by_scope', ['tenant_id', 'user_id'], { unique: false });
      ENTITY_STORES[name].extra.forEach(function (field) {
        store.createIndex(field, field, { unique: false });
      });
    });

    if (!database.objectStoreNames.contains('__responses')) {
      var r = database.createObjectStore('__responses', { keyPath: 'key' });
      r.createIndex('by_scope', ['tenant_id', 'user_id'], { unique: false });
    }
    if (!database.objectStoreNames.contains('__outbox')) {
      var o = database.createObjectStore('__outbox', { keyPath: 'id' });
      o.createIndex('by_scope', ['tenant_id', 'user_id'], { unique: false });
      o.createIndex('by_status', 'status', { unique: false });
    }
    if (!database.objectStoreNames.contains('__meta')) {
      database.createObjectStore('__meta', { keyPath: 'key' });
    }
  }

  var readyPromise = null;
  function init() {
    if (readyPromise) return readyPromise;
    readyPromise = IDB.openDatabase(DB_NAME, DB_VERSION, onUpgrade).then(function (opened) {
      db = opened;
      return true;
    });
    return readyPromise;
  }

  // ---- Scope -------------------------------------------------------------
  function setScope(tenantId, userId) {
    scope = { tenantId: tenantId || null, userId: userId || 'default' };
    try { self.localStorage.setItem(SCOPE_LS_KEY, JSON.stringify(scope)); } catch (e) {}
    return scope;
  }
  function getScope() { return { tenantId: scope.tenantId, userId: scope.userId }; }
  function isScoped() { return !!scope.tenantId; }

  function stamp(record) {
    var out = Object.assign({}, record);
    // Preserve the server's tenant_id when present; always bind to the active user bucket.
    out.tenant_id = out.tenant_id || scope.tenantId;
    out.user_id = scope.userId || 'default';
    return out;
  }

  function scopeRange() {
    return self.IDBKeyRange.only([scope.tenantId, scope.userId || 'default']);
  }

  // ---- Entity CRUD (scoped) ---------------------------------------------
  function assertEntity(name) {
    if (!ENTITY_STORES[name]) throw new Error('Unknown entity store: ' + name);
  }

  function putEntity(name, record) {
    assertEntity(name);
    return init().then(function () {
      return IDB.withStore(db, name, 'readwrite', function (store) {
        return IDB.promisifyRequest(store.put(stamp(record)));
      });
    });
  }

  function bulkPutEntity(name, records) {
    assertEntity(name);
    if (!records || !records.length) return init().then(function () { return 0; });
    return init().then(function () {
      return IDB.withStore(db, name, 'readwrite', function (store) {
        records.forEach(function (rec) { store.put(stamp(rec)); });
        return records.length;
      });
    });
  }

  function getEntity(name, id) {
    assertEntity(name);
    return init().then(function () {
      return IDB.withStore(db, name, 'readonly', function (store) {
        return IDB.promisifyRequest(store.get(id));
      });
    }).then(function (rec) {
      // Defense in depth: never return a record outside the active scope.
      if (!rec) return null;
      if (rec.tenant_id !== scope.tenantId || rec.user_id !== (scope.userId || 'default')) return null;
      return rec;
    });
  }

  // List scoped records. opts: { index, value, predicate, includeDeleted }
  function listEntity(name, opts) {
    assertEntity(name);
    opts = opts || {};
    return init().then(function () {
      return IDB.withStore(db, name, 'readonly', function (store) {
        var source, range;
        if (opts.index && store.indexNames.contains(opts.index)) {
          source = store.index(opts.index);
          range = opts.value != null ? self.IDBKeyRange.only(opts.value) : null;
        } else {
          source = store.index('by_scope');
          range = scopeRange();
        }
        var pred = function (v) {
          if (v.tenant_id !== scope.tenantId || v.user_id !== (scope.userId || 'default')) return false;
          if (!opts.includeDeleted && v._deleted) return false;
          return opts.predicate ? opts.predicate(v) : true;
        };
        return IDB.cursorCollect(source, range, pred);
      });
    });
  }

  function deleteEntity(name, id) {
    assertEntity(name);
    return init().then(function () {
      return IDB.withStore(db, name, 'readwrite', function (store) {
        return IDB.promisifyRequest(store.delete(id));
      });
    });
  }

  // ---- Generic store access (used by outbox.js) --------------------------
  function rawPut(storeName, record) {
    return init().then(function () {
      return IDB.withStore(db, storeName, 'readwrite', function (store) {
        return IDB.promisifyRequest(store.put(record));
      });
    });
  }
  function rawGet(storeName, key) {
    return init().then(function () {
      return IDB.withStore(db, storeName, 'readonly', function (store) {
        return IDB.promisifyRequest(store.get(key));
      });
    });
  }
  function rawDelete(storeName, key) {
    return init().then(function () {
      return IDB.withStore(db, storeName, 'readwrite', function (store) {
        return IDB.promisifyRequest(store.delete(key));
      });
    });
  }
  function rawListScoped(storeName, predicate) {
    return init().then(function () {
      return IDB.withStore(db, storeName, 'readonly', function (store) {
        var source = store.indexNames.contains('by_scope') ? store.index('by_scope') : store;
        var range = store.indexNames.contains('by_scope') ? scopeRange() : null;
        return IDB.cursorCollect(source, range, function (v) {
          if (v.tenant_id !== scope.tenantId || v.user_id !== (scope.userId || 'default')) return false;
          return predicate ? predicate(v) : true;
        });
      });
    });
  }

  // ---- Generic response cache -------------------------------------------
  function responseKey(method, endpoint, query) {
    return [scope.tenantId, scope.userId || 'default', (method || 'GET').toUpperCase(), endpoint, query || ''].join('|');
  }
  function getResponse(method, endpoint, query) {
    return rawGet('__responses', responseKey(method, endpoint, query)).then(function (rec) {
      if (!rec) return null;
      if (rec.tenant_id !== scope.tenantId || rec.user_id !== (scope.userId || 'default')) return null;
      return rec;
    });
  }
  function putResponse(method, endpoint, query, body, meta) {
    meta = meta || {};
    var rec = {
      key: responseKey(method, endpoint, query),
      tenant_id: scope.tenantId,
      user_id: scope.userId || 'default',
      endpoint: endpoint,
      query: query || '',
      method: (method || 'GET').toUpperCase(),
      body: body,
      status: meta.status != null ? meta.status : 200,
      etag: meta.etag || null,
      fetchedAt: Date.now(),
      ttl: meta.ttl != null ? meta.ttl : null,
      cacheVersion: meta.cacheVersion || CACHE_VERSION
    };
    return rawPut('__responses', rec).then(function () { return rec; });
  }
  // Drop every cached GET response whose endpoint begins with `endpointPrefix`
  // (scoped to the active tenant/user). Called after a write so the next read
  // revalidates instead of serving a stale body inside the TTL window.
  function deleteResponsesByPrefix(endpointPrefix) {
    if (!endpointPrefix) return Promise.resolve();
    return rawListScoped('__responses', function (rec) {
      return rec && typeof rec.endpoint === 'string' && rec.endpoint.indexOf(endpointPrefix) === 0;
    }).then(function (rows) {
      return Promise.all(rows.map(function (rec) { return rawDelete('__responses', rec.key); }));
    }).catch(function () {});
  }
  var CACHE_VERSION = 1;

  // ---- Meta (scoped by key prefix) --------------------------------------
  function metaKey(key) { return (scope.tenantId || '_') + '|' + (scope.userId || 'default') + '|' + key; }
  function getMeta(key) {
    return rawGet('__meta', metaKey(key)).then(function (rec) { return rec ? rec.value : null; });
  }
  function setMeta(key, value) {
    return rawPut('__meta', { key: metaKey(key), value: value });
  }

  // ---- Scoped purge (logout on a shared device) -------------------------
  function purgeScope() {
    return init().then(function () {
      var stores = ENTITY_NAMES.concat(['__responses', '__outbox']);
      return Promise.all(stores.map(function (name) {
        return IDB.withStore(db, name, 'readwrite', function (store) {
          var source = store.indexNames.contains('by_scope') ? store.index('by_scope') : store;
          var range = store.indexNames.contains('by_scope') ? scopeRange() : null;
          return new Promise(function (resolve, reject) {
            var req = source.openCursor(range);
            req.onsuccess = function () {
              var cur = req.result;
              if (!cur) { resolve(); return; }
              var v = cur.value;
              if (v.tenant_id === scope.tenantId && v.user_id === (scope.userId || 'default')) {
                store.delete(v.id != null ? v.id : v.key);
              }
              cur.continue();
            };
            req.onerror = function () { reject(req.error); };
          });
        });
      })).then(function () {
        scope = { tenantId: null, userId: null };
        try {
          self.localStorage.removeItem(SCOPE_LS_KEY);
        } catch (e) {}
        if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
          navigator.serviceWorker.controller.postMessage('gymflow-purge-runtime');
        }
      });
    });
  }

  self.GymLocalDB = {
    init: init,
    ENTITY_NAMES: ENTITY_NAMES,
    CACHE_VERSION: CACHE_VERSION,
    setScope: setScope,
    getScope: getScope,
    isScoped: isScoped,
    // entities
    putEntity: putEntity,
    bulkPutEntity: bulkPutEntity,
    getEntity: getEntity,
    listEntity: listEntity,
    deleteEntity: deleteEntity,
    // generic
    rawPut: rawPut,
    rawGet: rawGet,
    rawDelete: rawDelete,
    rawListScoped: rawListScoped,
    // response cache
    getResponse: getResponse,
    putResponse: putResponse,
    deleteResponsesByPrefix: deleteResponsesByPrefix,
    // meta
    getMeta: getMeta,
    setMeta: setMeta,
    // lifecycle
    purgeScope: purgeScope
  };
})();
