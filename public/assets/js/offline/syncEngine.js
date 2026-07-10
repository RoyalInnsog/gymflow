// ============================================================================
// Gym Flow — Offline layer :: syncEngine.js
// Orchestrates data movement between the local DB and the server:
//   • bootstrap()  — smart initial sync (per-entity policy: full / recent / latestN)
//   • pull(entity) — download + merge, honoring per-entity conflict policy
//   • push()       — drain the priority Outbox with idempotency + backoff
//   • syncNow()    — push then refresh high-value entities (reconnect/interval)
// The UI never calls this directly; the facade and network watcher do.
// ============================================================================
(function () {
  'use strict';

  var LDB = self.GymLocalDB;
  var NET = self.GymNetTransport;
  var OUTBOX = self.GymOutbox;
  var REG = self.GymRouteRegistry;

  // entity -> list endpoint used to pull it. Settings is intentionally absent:
  // it is a key/value object (not id-keyed rows) and is served server-wins via
  // the generic response cache.
  var PULL_ENDPOINT = {
    members: '/members',
    plans: '/plans',
    tasks: '/tasks',
    attendance: '/attendance/logs',
    notifications: '/notifications',
    leads: '/crm/leads',
    equipment: '/equipment',
    staff: '/staff',
    templates: '/templates',
    discount_rules: '/settings/discounts',
    // [U1] Member app entities (self-scoped API).
    member_workouts: '/member/workouts',
    member_sessions: '/member/sessions',
    member_prs: '/member/prs',
    member_attendance: '/member/attendance',
    member_health: '/member/health',
    member_measurements: '/member/measurements',
    member_goals: '/member/goals'
  };

  // Entities warmed on login and refreshed on reconnect/interval. The member
  // shell sets self.__GYM_APP_SCOPE__ = 'member' BEFORE these scripts load, so a
  // member session bootstraps its own entities (staff endpoints would 403 for an
  // r5 token anyway). Admin pages don't set the flag — their lists are unchanged.
  var IS_MEMBER_SCOPE = self.__GYM_APP_SCOPE__ === 'member';
  var MEMBER_ENTITIES = ['member_workouts', 'member_sessions', 'member_prs', 'member_attendance', 'member_health', 'member_measurements', 'member_goals'];
  var BOOTSTRAP_ENTITIES = IS_MEMBER_SCOPE ? MEMBER_ENTITIES : ['members', 'plans', 'tasks', 'attendance', 'notifications'];
  var HOT_ENTITIES = IS_MEMBER_SCOPE ? MEMBER_ENTITIES : ['members', 'attendance', 'tasks', 'notifications', 'plans'];

  function notify(state, extra) {
    if (self.GymNet && typeof self.GymNet._onSync === 'function') {
      try { self.GymNet._onSync(state, extra || {}); } catch (e) {}
    }
  }

  function rowDate(entity, row) {
    var v = row.check_in || row.log_date || row.session_date || row.measured_on ||
            row.created_at || row.date || row.due_date || row.updated_at;
    var t = v ? Date.parse(v) : NaN;
    return isNaN(t) ? 0 : t;
  }

  // Apply a server list into an entity store per policy + conflict rules.
  function applyPull(entity, rows, policy) {
    if (!Array.isArray(rows)) return Promise.resolve(0);
    var conflict = (REG.CONFLICT[entity] || 'server-wins');
    var serverWins = conflict === 'server-wins' || conflict === 'server-authoritative';

    // Client-trim to honor the sync policy even if the server ignores params.
    var trimmed = rows.filter(function (r) { return r && r.id != null; });
    if (policy && policy.mode === 'recent' && policy.days) {
      var cutoff = Date.now() - policy.days * 86400000;
      trimmed = trimmed.filter(function (r) { return rowDate(entity, r) >= cutoff; });
    } else if (policy && policy.mode === 'latestN' && policy.limit) {
      trimmed = trimmed.slice().sort(function (a, b) { return rowDate(entity, b) - rowDate(entity, a); }).slice(0, policy.limit);
    }

    var serverIds = {};
    var chain = Promise.resolve();
    trimmed.forEach(function (row) {
      serverIds[row.id] = true;
      chain = chain.then(function () {
        return LDB.getEntity(entity, row.id).then(function (local) {
          // Keep a locally-edited record until its outbox push reconciles it,
          // unless this entity is server-authoritative.
          if (local && local._dirty && !serverWins) return;
          var merged = Object.assign({}, row);
          merged._rev = row.updated_at || row.created_at || Date.now();
          merged._dirty = 0;
          merged._deleted = 0;
          return LDB.putEntity(entity, merged);
        });
      });
    });

    // Prune non-dirty local rows the server no longer has — only for FULL pulls,
    // where `trimmed` is the authoritative complete set.
    if (policy && policy.mode === 'full') {
      chain = chain.then(function () {
        return LDB.listEntity(entity, { includeDeleted: true }).then(function (locals) {
          var dels = locals.filter(function (l) { return !serverIds[l.id] && !l._dirty; });
          return Promise.all(dels.map(function (l) { return LDB.deleteEntity(entity, l.id); }));
        });
      });
    }
    return chain.then(function () { return trimmed.length; });
  }

  // Pull one entity from the server and merge it locally. Best-effort: a network
  // failure resolves to 0 (offline) rather than throwing.
  function pull(entity) {
    var endpoint = PULL_ENDPOINT[entity];
    if (!endpoint) return Promise.resolve(0);
    var policy = REG.SYNC_POLICY[entity] || { mode: 'full' };
    return NET.fetch(endpoint, { method: 'GET' }).then(function (res) {
      if (!res.ok) return 0;
      return res.json().then(function (body) {
        var rows = Array.isArray(body) ? body : (body && Array.isArray(body.data) ? body.data : null);
        // Refresh the generic cache too so the exact-endpoint read is warm.
        LDB.putResponse('GET', endpoint, '', body, { status: res.status });
        if (rows == null) return 0;
        return applyPull(entity, rows, policy);
      });
    }).catch(function () { return 0; });
  }

  // ---- Push (drain the outbox) ------------------------------------------
  function reconcileSuccess(item) {
    // On success we discard any optimistic temp row and re-pull the entity so
    // canonical (server-computed) fields land locally. For deletes we hard-remove.
    var entity = item.entity;
    var p = Promise.resolve();
    if (item.tempId) p = p.then(function () { return LDB.deleteEntity(entity, item.tempId); });
    if (item.op === 'delete' && item.entityId) p = p.then(function () { return LDB.deleteEntity(entity, item.entityId); });
    if (item.op === 'update' && item.entityId) {
      p = p.then(function () {
        return LDB.getEntity(entity, item.entityId).then(function (rec) {
          if (rec) { rec._dirty = 0; return LDB.putEntity(entity, rec); }
        });
      });
    }
    return p.then(function () { return OUTBOX.remove(item.id); })
            .then(function () { if (entity && PULL_ENDPOINT[entity]) return pull(entity); });
  }

  var pushing = false;
  function push() {
    if (pushing) return Promise.resolve({ skipped: true });
    pushing = true;
    var summary = { pushed: 0, conflicts: 0 };
    var guard = 0;

    function step() {
      if (guard++ > 200) return Promise.resolve();
      return OUTBOX.nextReady().then(function (item) {
        if (!item) return;
        var opts = {
          method: item.method,
          headers: { 'Idempotency-Key': item.idempotencyKey }
        };
        if (item.body != null) opts.body = typeof item.body === 'string' ? item.body : JSON.stringify(item.body);
        return NET.fetch(item.endpoint, opts).then(function (res) {
          if (res.ok) {
            summary.pushed++;
            return reconcileSuccess(item).then(step);
          }
          if (res.status >= 400 && res.status < 500) {
            // Validation/conflict — do not retry blindly; park for review.
            summary.conflicts++;
            return res.json().catch(function () { return {}; }).then(function (b) {
              return OUTBOX.markConflict(item, (b && b.error) || ('HTTP ' + res.status));
            }).then(step);
          }
          // 5xx — transient; back off and let the next ready item proceed.
          return OUTBOX.backoff(item, 'HTTP ' + res.status).then(step);
        }).catch(function (err) {
          // Network failure => we are offline. Back off and stop this pass.
          return OUTBOX.backoff(item, err);
        });
      });
    }

    notify('syncing', {});
    return step().then(function () {
      pushing = false;
      notify('idle', summary);
      return summary;
    }).catch(function (e) {
      pushing = false;
      notify('idle', {});
      return summary;
    });
  }

  // ---- Bootstrap + syncNow ----------------------------------------------
  function bootstrap() {
    notify('syncing', {});
    return Promise.all(BOOTSTRAP_ENTITIES.map(function (e) { return pull(e).catch(function () { return 0; }); }))
      .then(function () { return LDB.setMeta('bootstrap.at', Date.now()); })
      .then(function () { notify('idle', {}); return true; })
      .catch(function () { notify('idle', {}); return false; });
  }

  function syncNow() {
    return push().then(function (summary) {
      return Promise.all(HOT_ENTITIES.map(function (e) { return pull(e).catch(function () { return 0; }); }))
        .then(function () { return summary; });
    });
  }

  self.GymSyncEngine = {
    pull: pull,
    push: push,
    bootstrap: bootstrap,
    syncNow: syncNow,
    PULL_ENDPOINT: PULL_ENDPOINT
  };
})();
