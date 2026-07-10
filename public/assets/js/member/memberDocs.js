/*
 * Gym Flow — Member App · Phase U3 · Section 5
 * Member Documents — optional personal document/photo storage.
 *
 * ARCHITECTURE ONLY: a fully-working OFFLINE local store today, structured so a
 * future phase can sync these to the Admin app. It uses its OWN IndexedDB
 * database (`gymflow_member_docs`) so it does NOT touch the offline engine's
 * `gymflow` DB, the repository layer, or the sync engine. Files never leave the
 * device in U3.
 *
 * Future extension points (prepared): a record carries id/category/name/type/
 * size/created_at + the data URL; a sync layer only has to upload `dataUrl` and
 * stamp a server id — the UI already reads everything else.
 */
window.GymMemberDocs = (function () {
  'use strict';

  var DB_NAME = 'gymflow_member_docs', STORE = 'docs', VERSION = 1;
  var MAX_BYTES = 6 * 1024 * 1024; // 6 MB per file — keeps IndexedDB healthy
  // 'Identity Document' is intentionally GENERIC — a future phase can specialise
  // it (Aadhaar / passport / etc.) without changing this store's schema.
  var CATEGORIES = ['Profile Photo', 'Progress Photo', 'Transformation Photo', 'Medical Certificate', 'Fitness Assessment', 'Identity Document', 'Other'];
  var CATEGORY_ICON = {
    'Profile Photo': 'account_circle', 'Progress Photo': 'photo_camera', 'Transformation Photo': 'compare',
    'Medical Certificate': 'medical_information', 'Fitness Assessment': 'assignment', 'Identity Document': 'badge', 'Other': 'description'
  };

  var dbp = null;
  function open() {
    if (dbp) return dbp;
    dbp = new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, VERSION);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          var os = db.createObjectStore(STORE, { keyPath: 'id' });
          os.createIndex('created_at', 'created_at');
        }
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
    return dbp;
  }

  // Metadata only (no dataUrl) so lists stay light.
  function list() {
    return open().then(function (db) {
      return new Promise(function (resolve) {
        var out = [];
        var req = db.transaction(STORE).objectStore(STORE).openCursor();
        req.onsuccess = function () {
          var c = req.result;
          if (c) {
            var v = c.value;
            out.push({ id: v.id, category: v.category, name: v.name, type: v.type, size: v.size, created_at: v.created_at });
            c.continue();
          } else {
            out.sort(function (a, b) { return String(b.created_at).localeCompare(String(a.created_at)); });
            resolve(out);
          }
        };
        req.onerror = function () { resolve([]); };
      });
    }).catch(function () { return []; });
  }

  function get(id) {
    return open().then(function (db) {
      return new Promise(function (resolve) {
        var r = db.transaction(STORE).objectStore(STORE).get(id);
        r.onsuccess = function () { resolve(r.result || null); };
        r.onerror = function () { resolve(null); };
      });
    }).catch(function () { return null; });
  }

  function add(file, category) {
    return new Promise(function (resolve, reject) {
      if (!file) { reject(new Error('No file selected.')); return; }
      if (file.size > MAX_BYTES) { reject(new Error('File is too large (max 6 MB).')); return; }
      var fr = new FileReader();
      fr.onload = function () {
        var rec = {
          id: 'doc_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
          category: CATEGORIES.indexOf(category) !== -1 ? category : 'Other',
          name: String(file.name || 'document').slice(0, 160),
          type: file.type || '', size: file.size || 0,
          dataUrl: fr.result, created_at: new Date().toISOString()
        };
        open().then(function (db) {
          var req = db.transaction(STORE, 'readwrite').objectStore(STORE).add(rec);
          req.onsuccess = function () { resolve(rec); };
          req.onerror = function () { reject(req.error); };
        }).catch(reject);
      };
      fr.onerror = function () { reject(fr.error || new Error('Could not read file.')); };
      fr.readAsDataURL(file);
    });
  }

  function remove(id) {
    return open().then(function (db) {
      return new Promise(function (resolve) {
        var r = db.transaction(STORE, 'readwrite').objectStore(STORE).delete(id);
        r.onsuccess = function () { resolve(true); };
        r.onerror = function () { resolve(false); };
      });
    }).catch(function () { return false; });
  }

  return {
    categories: CATEGORIES.slice(),
    categoryIcon: function (c) { return CATEGORY_ICON[c] || 'description'; },
    list: list, get: get, add: add, remove: remove
  };
})();
