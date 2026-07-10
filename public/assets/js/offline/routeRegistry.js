// ============================================================================
// Gym Flow — Offline layer :: routeRegistry.js
// The single place where per-endpoint offline behavior is declared. It maps an
// (method, endpoint) pair to:
//   • whether a GET resolves from an entity store (list/item) or the generic cache
//   • whether a write is optimistic (queued offline) or online-only (never faked)
//   • the entity's conflict policy, sync policy and outbox priority.
// Anything not registered falls back to safe defaults: GET -> generic cache,
// write -> online-only passthrough. So new endpoints can never silently fake a
// mutation; they simply require connectivity until explicitly opted in.
// ============================================================================
(function () {
  'use strict';

  var PRIORITY = { HIGH: 0, NORMAL: 1, LOW: 2 };

  // ---- Online-only: writes here are NEVER queued or optimistically applied.
  // Money, auth, subscription state, real-time device links and server-side
  // file processing must hit the server live. Offline, they fail through the
  // normal error path (same as today) — we never fabricate their result.
  var ONLINE_ONLY = [
    /^\/auth\//,
    /^\/subscription\//,
    /^\/finance\/collect/,
    /^\/whatsapp\//,
    /^\/settings\/upload-logo/,
    /^\/backup/,
    /^\/export/,
    /^\/reports\/export/,
    /^\/org\/.*\/(accept|reject|claim)/
  ];

  // ---- Conflict policy per entity (dispatched by the sync engine).
  var CONFLICT = {
    members: 'lww',                 // last-write-wins (record level)
    attendance: 'dedupe-checkin',   // unique member+day; duplicate is a no-op
    invoices: 'server-authoritative',
    payments: 'server-authoritative',
    finance: 'server-authoritative',
    settings: 'server-wins',
    tasks: 'latest-edit-wins',
    leads: 'latest-edit-wins',
    notifications: 'latest-edit-wins',
    plans: 'server-wins',
    staff: 'server-wins',
    equipment: 'lww',
    // [U1] Member app entities (self-scoped /member/* API). The server upserts
    // health by (member, log_date), so replays converge — lww is safe there.
    member_workouts: 'latest-edit-wins',
    member_sessions: 'latest-edit-wins',
    member_prs: 'latest-edit-wins',
    member_attendance: 'server-wins',   // members never write attendance in U1
    member_health: 'lww',
    member_measurements: 'latest-edit-wins',
    member_goals: 'latest-edit-wins'
  };

  // ---- Smart bootstrap sync policy per entity (keeps large gyms fast).
  var SYNC_POLICY = {
    members:        { mode: 'full' },
    plans:          { mode: 'full' },
    settings:       { mode: 'full' },
    discount_rules: { mode: 'full' },
    staff:          { mode: 'full' },
    equipment:      { mode: 'full' },
    tasks:          { mode: 'full' },
    leads:          { mode: 'full' },
    attendance:     { mode: 'recent', days: 90 },
    invoices:       { mode: 'recent', days: 90 },
    payments:       { mode: 'recent', days: 90 },
    notifications:  { mode: 'latestN', limit: 100 },
    dashboard:      { mode: 'snapshot' },
    // [U1] Member app entities — small per-member datasets, so mostly full.
    member_workouts:     { mode: 'full' },
    member_sessions:     { mode: 'recent', days: 180 },
    member_prs:          { mode: 'full' },
    member_attendance:   { mode: 'recent', days: 365 },
    member_health:       { mode: 'recent', days: 365 },
    member_measurements: { mode: 'full' },
    member_goals:        { mode: 'full' }
  };

  // ---- READ rules: which GET endpoints resolve from an entity store.
  // `kind`: 'list' (array of rows) or 'item' (single row by :id). Everything
  // else uses the generic response cache automatically.
  var READ_RULES = [
    { re: /^\/members\/[^/]+$/, entity: 'members', kind: 'item' },
    { re: /^\/members(\?.*)?$/, entity: 'members', kind: 'list' },
    { re: /^\/plans(\?.*)?$/, entity: 'plans', kind: 'list' },
    { re: /^\/tasks(\?.*)?$/, entity: 'tasks', kind: 'list' },
    { re: /^\/notifications(\?.*)?$/, entity: 'notifications', kind: 'list' },
    { re: /^\/crm\/leads(\?.*)?$/, entity: 'leads', kind: 'list' },
    { re: /^\/equipment(\?.*)?$/, entity: 'equipment', kind: 'list' },
    { re: /^\/staff(\?.*)?$/, entity: 'staff', kind: 'list' },
    { re: /^\/templates(\?.*)?$/, entity: 'templates', kind: 'list' },
    // [U1] Member app lists. /member/overview and /member/profile are composite
    // snapshots and intentionally ride the generic response cache instead.
    { re: /^\/member\/workouts(\?.*)?$/, entity: 'member_workouts', kind: 'list' },
    { re: /^\/member\/sessions(\?.*)?$/, entity: 'member_sessions', kind: 'list' },
    { re: /^\/member\/prs(\?.*)?$/, entity: 'member_prs', kind: 'list' },
    { re: /^\/member\/attendance(\?.*)?$/, entity: 'member_attendance', kind: 'list' },
    { re: /^\/member\/health(\?.*)?$/, entity: 'member_health', kind: 'list' },
    { re: /^\/member\/measurements(\?.*)?$/, entity: 'member_measurements', kind: 'list' },
    { re: /^\/member\/goals(\?.*)?$/, entity: 'member_goals', kind: 'list' }
  ];

  // ---- WRITE rules: which mutations are applied optimistically + queued.
  // Only entities listed here are ever handled offline. idFrom: how to recover
  // the record id for update/delete ('path' = last path segment).
  var WRITE_RULES = [
    { method: 'POST',   re: /^\/members$/,          entity: 'members', op: 'create', priority: PRIORITY.NORMAL },
    { method: 'PUT',    re: /^\/members\/[^/]+$/,   entity: 'members', op: 'update', priority: PRIORITY.NORMAL, idFrom: 'path' },
    { method: 'DELETE', re: /^\/members\/[^/]+$/,   entity: 'members', op: 'delete', priority: PRIORITY.NORMAL, idFrom: 'path' },
    { method: 'POST',   re: /^\/attendance\/check-in$/, entity: 'attendance', op: 'create', priority: PRIORITY.HIGH },
    { method: 'POST',   re: /^\/tasks$/,            entity: 'tasks', op: 'create', priority: PRIORITY.NORMAL },
    { method: 'PUT',    re: /^\/tasks\/[^/]+$/,     entity: 'tasks', op: 'update', priority: PRIORITY.NORMAL, idFrom: 'path' },
    { method: 'DELETE', re: /^\/tasks\/[^/]+$/,     entity: 'tasks', op: 'delete', priority: PRIORITY.NORMAL, idFrom: 'path' },
    // [U1] Member app writes — all local-first + queued. Auth, payments and org
    // accept/reject stay online-only via ONLINE_ONLY above; never faked.
    { method: 'POST',   re: /^\/member\/workouts$/,          entity: 'member_workouts', op: 'create', priority: PRIORITY.NORMAL },
    { method: 'PUT',    re: /^\/member\/workouts\/[^/]+$/,   entity: 'member_workouts', op: 'update', priority: PRIORITY.NORMAL, idFrom: 'path' },
    { method: 'DELETE', re: /^\/member\/workouts\/[^/]+$/,   entity: 'member_workouts', op: 'delete', priority: PRIORITY.NORMAL, idFrom: 'path' },
    { method: 'POST',   re: /^\/member\/sessions$/,          entity: 'member_sessions', op: 'create', priority: PRIORITY.HIGH },
    { method: 'POST',   re: /^\/member\/prs$/,               entity: 'member_prs', op: 'create', priority: PRIORITY.NORMAL },
    { method: 'DELETE', re: /^\/member\/prs\/[^/]+$/,        entity: 'member_prs', op: 'delete', priority: PRIORITY.NORMAL, idFrom: 'path' },
    { method: 'POST',   re: /^\/member\/health$/,            entity: 'member_health', op: 'create', priority: PRIORITY.HIGH },
    { method: 'POST',   re: /^\/member\/measurements$/,      entity: 'member_measurements', op: 'create', priority: PRIORITY.NORMAL },
    { method: 'DELETE', re: /^\/member\/measurements\/[^/]+$/, entity: 'member_measurements', op: 'delete', priority: PRIORITY.NORMAL, idFrom: 'path' },
    { method: 'POST',   re: /^\/member\/goals$/,             entity: 'member_goals', op: 'create', priority: PRIORITY.NORMAL },
    { method: 'PUT',    re: /^\/member\/goals\/[^/]+$/,      entity: 'member_goals', op: 'update', priority: PRIORITY.NORMAL, idFrom: 'path' },
    { method: 'DELETE', re: /^\/member\/goals\/[^/]+$/,      entity: 'member_goals', op: 'delete', priority: PRIORITY.NORMAL, idFrom: 'path' }
  ];

  function stripQuery(endpoint) {
    var i = endpoint.indexOf('?');
    return i === -1 ? endpoint : endpoint.slice(0, i);
  }

  function isOnlineOnly(endpoint) {
    var path = stripQuery(endpoint);
    return ONLINE_ONLY.some(function (re) { return re.test(path); });
  }

  function resolveRead(endpoint) {
    for (var i = 0; i < READ_RULES.length; i++) {
      if (READ_RULES[i].re.test(endpoint)) {
        var r = READ_RULES[i];
        return { entity: r.entity, kind: r.kind, conflictPolicy: CONFLICT[r.entity] || 'server-wins' };
      }
    }
    return null; // -> generic response cache
  }

  function resolveWrite(method, endpoint) {
    if (isOnlineOnly(endpoint)) return null; // passthrough, never faked
    var path = stripQuery(endpoint);
    for (var i = 0; i < WRITE_RULES.length; i++) {
      var w = WRITE_RULES[i];
      if (w.method === method && w.re.test(path)) {
        return {
          entity: w.entity, op: w.op, priority: w.priority,
          idFrom: w.idFrom || null,
          conflictPolicy: CONFLICT[w.entity] || 'lww'
        };
      }
    }
    return null; // -> passthrough (safe default for unknown writes)
  }

  function lastPathSegment(endpoint) {
    var path = stripQuery(endpoint).replace(/\/+$/, '');
    return path.slice(path.lastIndexOf('/') + 1);
  }

  self.GymRouteRegistry = {
    PRIORITY: PRIORITY,
    SYNC_POLICY: SYNC_POLICY,
    CONFLICT: CONFLICT,
    isOnlineOnly: isOnlineOnly,
    resolveRead: resolveRead,
    resolveWrite: resolveWrite,
    lastPathSegment: lastPathSegment,
    stripQuery: stripQuery
  };
})();
