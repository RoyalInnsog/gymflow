// ============================================================================
// Gym Flow — Offline layer :: idb.js
// A tiny Promise wrapper over IndexedDB. No external dependencies.
//
// This is the ONLY module (besides localdb.js) that touches the raw IndexedDB
// API. Keeping it isolated is what makes the storage layer replaceable later
// (Capacitor SQLite, OPFS, etc.) without changing repositories or the UI.
// ============================================================================
(function () {
  'use strict';

  function promisifyRequest(request) {
    return new Promise(function (resolve, reject) {
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error); };
    });
  }

  // Resolve when the transaction fully commits (not just when the request
  // succeeds) so callers can trust the write is durable before continuing.
  function promisifyTxn(txn) {
    return new Promise(function (resolve, reject) {
      txn.oncomplete = function () { resolve(); };
      txn.onabort = function () { reject(txn.error || new Error('Transaction aborted')); };
      txn.onerror = function () { reject(txn.error); };
    });
  }

  // Open (or upgrade) a database. `onUpgrade(db, oldVersion, txn)` runs inside
  // the versionchange transaction so stores/indexes can be created.
  function openDatabase(name, version, onUpgrade) {
    return new Promise(function (resolve, reject) {
      if (!self.indexedDB) { reject(new Error('IndexedDB unavailable')); return; }
      var req = self.indexedDB.open(name, version);
      req.onupgradeneeded = function (event) {
        try {
          if (typeof onUpgrade === 'function') {
            onUpgrade(req.result, event.oldVersion, req.transaction);
          }
        } catch (e) { reject(e); }
      };
      req.onsuccess = function () {
        var db = req.result;
        // Another tab requested a newer version — close so it isn't blocked.
        db.onversionchange = function () { try { db.close(); } catch (e) {} };
        resolve(db);
      };
      req.onerror = function () { reject(req.error); };
      req.onblocked = function () { /* another connection is open; will retry */ };
    });
  }

  // Run a function with a store handle inside a fresh transaction and resolve
  // with its result once the transaction commits.
  function withStore(db, storeName, mode, fn) {
    return new Promise(function (resolve, reject) {
      var result;
      var txn;
      try {
        txn = db.transaction(storeName, mode);
      } catch (e) { reject(e); return; }
      var store = txn.objectStore(storeName);
      Promise.resolve()
        .then(function () { return fn(store, txn); })
        .then(function (r) { result = r; })
        .catch(function (e) { try { txn.abort(); } catch (_) {} reject(e); });
      txn.oncomplete = function () { resolve(result); };
      txn.onabort = function () { reject(txn.error || new Error('Transaction aborted')); };
      txn.onerror = function () { reject(txn.error); };
    });
  }

  // Cursor walk over an index (or whole store), collecting rows that pass an
  // optional predicate. `range` is an IDBKeyRange or null.
  function cursorCollect(source, range, predicate) {
    return new Promise(function (resolve, reject) {
      var out = [];
      var req = source.openCursor(range || null);
      req.onsuccess = function () {
        var cursor = req.result;
        if (!cursor) { resolve(out); return; }
        var value = cursor.value;
        if (!predicate || predicate(value)) out.push(value);
        cursor.continue();
      };
      req.onerror = function () { reject(req.error); };
    });
  }

  self.GymIDB = {
    promisifyRequest: promisifyRequest,
    promisifyTxn: promisifyTxn,
    openDatabase: openDatabase,
    withStore: withStore,
    cursorCollect: cursorCollect
  };
})();
