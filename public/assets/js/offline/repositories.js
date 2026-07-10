// ============================================================================
// Gym Flow — Offline layer :: repositories.js  (window.GymRepos)
// The stable, feature-facing data API. Screens (and every FUTURE module — Member
// App, health tracking, wearables, etc.) should talk to these repositories, not
// to fetch/window.api. Each repository hides WHERE data comes from (local DB vs
// outbox vs network) so the UI never knows or cares.
//
// Reads resolve instantly from the local DB and trigger a background refresh.
// Writes go through the offline facade (window.api), which applies them
// optimistically and queues them when offline.
// ============================================================================
(function () {
  'use strict';

  var LDB = self.GymLocalDB;
  var SYNC = self.GymSyncEngine;

  function api() { return self.api; } // the offline facade
  function refresh(entity) { if (SYNC) SYNC.pull(entity).catch(function () {}); }

  var MemberRepository = {
    list: function (opts) {
      opts = opts || {};
      var pred = null;
      if (opts.status) pred = function (m) { return m.status === opts.status; };
      if (opts.search) {
        var q = String(opts.search).toLowerCase();
        var base = pred;
        pred = function (m) {
          if (base && !base(m)) return false;
          return [m.full_name, m.phone, m.email].some(function (v) { return v && String(v).toLowerCase().indexOf(q) !== -1; });
        };
      }
      refresh('members');
      return LDB.listEntity('members', { predicate: pred });
    },
    get: function (id) { return LDB.getEntity('members', id); },
    create: function (data) { return api().post('/members', data); },
    update: function (id, data) { return api().put('/members/' + id, data); },
    remove: function (id) { return api().delete('/members/' + id); }
  };

  var AttendanceRepository = {
    logs: function () { refresh('attendance'); return LDB.listEntity('attendance', {}); },
    forMember: function (memberId) {
      refresh('attendance');
      return LDB.listEntity('attendance', { predicate: function (a) { return a.member_id === memberId; } });
    },
    checkIn: function (memberId) { return api().post('/attendance/check-in', { member_id: memberId }); }
  };

  var PaymentRepository = {
    // Money is server-authoritative — reads may serve cache, collection is online-only.
    pending: function () { return api().get('/finance/pending'); },
    summary: function () { return api().get('/finance/summary'); },
    transactions: function () { return api().get('/finance/transactions'); }
  };

  var DashboardRepository = {
    summary: function () { return api().get('/dashboard/summary'); },
    executive: function () { return api().get('/analytics/executive-summary'); }
  };

  var PlanRepository = {
    list: function () { refresh('plans'); return LDB.listEntity('plans', {}); },
    remote: function () { return api().get('/plans'); }
  };

  var SettingsRepository = {
    get: function () { return api().get('/settings'); },
    discounts: function () { return api().get('/settings/discounts'); }
  };

  var NotificationRepository = {
    list: function () { refresh('notifications'); return LDB.listEntity('notifications', {}); }
  };

  var TaskRepository = {
    list: function () { refresh('tasks'); return LDB.listEntity('tasks', {}); },
    create: function (data) { return api().post('/tasks', data); },
    update: function (id, data) { return api().put('/tasks/' + id, data); },
    remove: function (id) { return api().delete('/tasks/' + id); }
  };

  var LeadRepository = { list: function () { refresh('leads'); return LDB.listEntity('leads', {}); } };
  var StaffRepository = { list: function () { refresh('staff'); return LDB.listEntity('staff', {}); } };
  var EquipmentRepository = { list: function () { refresh('equipment'); return LDB.listEntity('equipment', {}); } };

  // [U1] Member App — the ONLY data API member screens may talk to. Reads are
  // local-first (instant) with a background refresh; writes ride the offline
  // facade (optimistic + outbox). Future modules (Health Connect, wearables,
  // GPS attendance) plug in behind these same methods.
  function memberList(entity, sort) {
    refresh(entity);
    return LDB.listEntity(entity, {}).then(function (rows) {
      if (sort) rows.sort(sort);
      return rows;
    });
  }
  function byDateDesc(field) {
    return function (a, b) {
      return String(b[field] || b.created_at || '').localeCompare(String(a[field] || a.created_at || ''));
    };
  }
  function _todayStr() {
    var n = new Date();
    return n.getFullYear() + '-' + String(n.getMonth() + 1).padStart(2, '0') + '-' + String(n.getDate()).padStart(2, '0');
  }

  var MemberSelfRepository = {
    // Composite snapshots (generic response cache — instant after first load).
    overview: function () { return api().get('/member/overview'); },
    profile: function () { return api().get('/member/profile'); },

    workouts: {
      list: function () { return memberList('member_workouts', byDateDesc('created_at')); },
      create: function (data) { return api().post('/member/workouts', data); },
      update: function (id, data) { return api().put('/member/workouts/' + id, data); },
      remove: function (id) { return api().delete('/member/workouts/' + id); }
    },
    sessions: {
      list: function () { return memberList('member_sessions', byDateDesc('session_date')); },
      log: function (data) { return api().post('/member/sessions', data); }
    },
    prs: {
      list: function () { return memberList('member_prs', byDateDesc('achieved_on')); },
      add: function (data) { return api().post('/member/prs', data); },
      remove: function (id) { return api().delete('/member/prs/' + id); }
    },
    attendance: {
      list: function () { return memberList('member_attendance', byDateDesc('check_in')); }
    },
    health: {
      list: function () { return api().get('/member/health?log_date=' + _todayStr()); },
      log: function (data) { return api().post('/member/health', data); }
    },
    measurements: {
      list: function () { return memberList('member_measurements', byDateDesc('measured_on')); },
      add: function (data) { return api().post('/member/measurements', data); },
      remove: function (id) { return api().delete('/member/measurements/' + id); }
    },
    goals: {
      list: function () { return memberList('member_goals', byDateDesc('created_at')); },
      add: function (data) { return api().post('/member/goals', data); },
      update: function (id, data) { return api().put('/member/goals/' + id, data); },
      remove: function (id) { return api().delete('/member/goals/' + id); }
    }
  };

  self.GymRepos = {
    Member: MemberRepository,
    Attendance: AttendanceRepository,
    Payment: PaymentRepository,
    Dashboard: DashboardRepository,
    Plan: PlanRepository,
    Settings: SettingsRepository,
    Notification: NotificationRepository,
    Task: TaskRepository,
    Lead: LeadRepository,
    Staff: StaffRepository,
    Equipment: EquipmentRepository,
    MemberSelf: MemberSelfRepository
  };
})();
