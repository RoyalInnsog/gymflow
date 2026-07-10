// ============================================================================
// Gym Flow — Offline layer :: outbox.js
// The durable, PRIORITY-ordered queue of mutations made while offline (or that
// failed to reach the server). Items drain HIGH -> NORMAL -> LOW, FIFO within a
// level, so an attendance check-in beats a bulk member edit. Each item carries
// an idempotency key so a retry can never double-apply on the server.
// ============================================================================
(function () {
  'use strict';

  var LDB = self.GymLocalDB;
  var STORE = '__outbox';

  var BASE_BACKOFF_MS = 3000;    // first retry after ~3s
  var MAX_BACKOFF_MS = 5 * 60 * 1000; // capped at 5 minutes

  function uuid() {
    if (self.crypto && self.crypto.randomUUID) return self.crypto.randomUUID();
    return 'ob_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
  }

  // opts: { method, endpoint, body, entity, entityId, tempId, priority, conflictPolicy }
  function enqueue(opts) {
    var scope = LDB.getScope();
    var item = {
      id: uuid(),
      priority: opts.priority != null ? opts.priority : 1, // NORMAL
      method: opts.method,
      endpoint: opts.endpoint,
      body: opts.body != null ? opts.body : null,
      entity: opts.entity || null,
      entityId: opts.entityId != null ? opts.entityId : null,
      tempId: opts.tempId || null,
      conflictPolicy: opts.conflictPolicy || null,
      idempotencyKey: uuid(),
      attempts: 0,
      nextAttemptAt: Date.now(),
      status: 'pending', // pending | conflict | failed
      lastError: null,
      tenant_id: scope.tenantId,
      user_id: scope.userId || 'default',
      createdAt: Date.now()
    };
    return LDB.rawPut(STORE, item).then(function () { return item; });
  }

  // All scoped items, sorted for draining (priority asc, then createdAt asc).
  function all() {
    return LDB.rawListScoped(STORE, null).then(function (items) {
      return items.sort(function (a, b) {
        if (a.priority !== b.priority) return a.priority - b.priority;
        return a.createdAt - b.createdAt;
      });
    });
  }

  function pendingCount() {
    return LDB.rawListScoped(STORE, function (i) { return i.status !== 'conflict'; })
      .then(function (items) { return items.length; });
  }

  function conflicts() {
    return LDB.rawListScoped(STORE, function (i) { return i.status === 'conflict'; });
  }

  // The next drainable item: highest priority, ready (nextAttemptAt passed),
  // not parked in a conflict state.
  function nextReady() {
    var now = Date.now();
    return all().then(function (items) {
      for (var i = 0; i < items.length; i++) {
        var it = items[i];
        if (it.status === 'pending' && it.nextAttemptAt <= now) return it;
      }
      return null;
    });
  }

  function remove(id) { return LDB.rawDelete(STORE, id); }

  function update(item) { return LDB.rawPut(STORE, item); }

  function backoff(item, error) {
    item.attempts += 1;
    item.lastError = error ? String(error && error.message ? error.message : error) : null;
    var delay = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * Math.pow(2, item.attempts - 1));
    delay = delay + Math.floor(Math.random() * 1000); // jitter
    item.nextAttemptAt = Date.now() + delay;
    item.status = 'pending';
    return update(item);
  }

  function markConflict(item, reason) {
    item.status = 'conflict';
    item.lastError = reason || 'Conflict';
    return update(item);
  }

  self.GymOutbox = {
    enqueue: enqueue,
    all: all,
    pendingCount: pendingCount,
    conflicts: conflicts,
    nextReady: nextReady,
    remove: remove,
    update: update,
    backoff: backoff,
    markConflict: markConflict
  };
})();
