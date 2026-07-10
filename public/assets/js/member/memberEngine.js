/*
 * Gym Flow — Member App · Phase U3
 * Member intelligence engine: Achievements, Notification rules, Recently-used.
 *
 * 100% client-side and offline. It DERIVES everything from data the offline
 * engine already syncs (sessions, attendance, PRs, health, goals) plus a little
 * device-local state in localStorage. It does NOT touch the repository layer,
 * the sync engine, IndexedDB, or the server — no new endpoints, no schema.
 *
 * Rule engine only — no AI. A future phase can register richer rules/badges by
 * appending to ACHIEVEMENTS / the rules() function; nothing else changes.
 */
window.GymMemberEngine = (function () {
  'use strict';

  var LS = {
    ach: 'gf.member.achievements',       // { achievementId: ISOunlockTimestamp }
    notifDismiss: 'gf.member.notifDismissed', // { ruleId: 'YYYY-MM-DD' }
    recent: 'gf.member.recentEx'          // [exerciseId, ...] most-recent first
  };

  function readJSON(k, d) { try { var v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } }
  function writeJSON(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function todayISO() { return new Date().toISOString().slice(0, 10); }

  // ── Recently-used exercises (Section 1) ──────────────────────────────────
  function trackExercise(id) {
    if (!id) return;
    var r = readJSON(LS.recent, []).filter(function (x) { return x !== id; });
    r.unshift(id);
    writeJSON(LS.recent, r.slice(0, 24));
  }
  function recentExercises() { return readJSON(LS.recent, []); }

  // ── Achievements (Section 6) ─────────────────────────────────────────────
  // ctx fields used by tests: sessions, streak, prs, attendance, monthAttendance,
  // plans, goalsDone, waterHit.
  var ACHIEVEMENTS = [
    { id: 'first_workout', icon: 'exercise', name: 'First Workout', desc: 'Complete your very first workout.', test: function (c) { return c.sessions >= 1; } },
    { id: 'first_plan', icon: 'assignment', name: 'The Plan', desc: 'Create your first workout plan.', test: function (c) { return c.plans >= 1; } },
    { id: 'workouts_10', icon: 'fitness_center', name: '10 Workouts', desc: 'Log 10 completed workouts.', test: function (c) { return c.sessions >= 10; } },
    { id: 'workouts_30', icon: 'sports_gymnastics', name: '30 Workouts', desc: 'Log 30 completed workouts.', test: function (c) { return c.sessions >= 30; } },
    { id: 'workouts_100', icon: 'military_tech', name: 'Century Club', desc: 'Log 100 completed workouts.', test: function (c) { return c.sessions >= 100; } },
    { id: 'streak_7', icon: 'local_fire_department', name: '7-Day Streak', desc: 'Attend the gym 7 days in a row.', test: function (c) { return c.streak >= 7; } },
    { id: 'streak_30', icon: 'whatshot', name: '30-Day Streak', desc: 'Attend the gym 30 days in a row.', test: function (c) { return c.streak >= 30; } },
    { id: 'attend_50', icon: 'event_available', name: 'Regular', desc: 'Check in to the gym 50 times.', test: function (c) { return c.attendance >= 50; } },
    { id: 'month_12', icon: 'calendar_month', name: 'Monthly Grind', desc: 'Attend 12+ times in one month.', test: function (c) { return c.monthAttendance >= 12; } },
    { id: 'first_pr', icon: 'trophy', name: 'First PR', desc: 'Set your first personal record.', test: function (c) { return c.prs >= 1; } },
    { id: 'pr_10', icon: 'workspace_premium', name: 'PR Machine', desc: 'Set 10 personal records.', test: function (c) { return c.prs >= 10; } },
    { id: 'goal_done', icon: 'flag', name: 'Goal Crusher', desc: 'Complete one of your goals.', test: function (c) { return c.goalsDone >= 1; } },
    { id: 'hydrated', icon: 'water_drop', name: 'Hydrated', desc: 'Hit your daily water target.', test: function (c) { return !!c.waterHit; } },
    { id: 'anniversary', icon: 'cake', name: 'One Year Strong', desc: 'One year since your membership began.', test: function (c) { return c.membershipDays >= 365; } }
  ];

  // Evaluate silently persists any newly-unlocked badges and returns the full
  // list (locked + unlocked) plus which were newly unlocked this call.
  function evaluate(ctx) {
    ctx = ctx || {};
    var unlocked = readJSON(LS.ach, {});
    var now = new Date().toISOString();
    var newly = [];
    ACHIEVEMENTS.forEach(function (a) {
      var pass = false;
      try { pass = !!a.test(ctx); } catch (e) {}
      if (pass && !unlocked[a.id]) { unlocked[a.id] = now; newly.push(a.id); }
    });
    if (newly.length) writeJSON(LS.ach, unlocked);
    var list = ACHIEVEMENTS.map(function (a) {
      return { id: a.id, icon: a.icon, name: a.name, desc: a.desc, unlocked: !!unlocked[a.id], at: unlocked[a.id] || null };
    });
    return { list: list, newly: newly, unlockedCount: Object.keys(unlocked).length, total: ACHIEVEMENTS.length };
  }

  // ── Notification rule engine (Section 7) ─────────────────────────────────
  // ctx: membershipDaysLeft, daysSinceWorkout, daysSinceAttendance, waterToday,
  //      waterTarget, activeGoals, notifyWorkout, notifyExpiry.
  function rules(ctx) {
    ctx = ctx || {};
    var out = [];
    function push(id, icon, tone, title, body) { out.push({ id: id, icon: icon, tone: tone, title: title, body: body }); }

    if (ctx.notifyExpiry !== false && ctx.membershipDaysLeft != null && ctx.membershipDaysLeft >= 0 && ctx.membershipDaysLeft <= 7)
      push('membership', 'card_membership', 'warning', 'Membership expiring',
        'Your membership ends in ' + ctx.membershipDaysLeft + ' day' + (ctx.membershipDaysLeft === 1 ? '' : 's') + '. Renew at the front desk.');

    if (ctx.notifyWorkout !== false && ctx.daysSinceWorkout != null && ctx.daysSinceWorkout >= 3)
      push('workout', 'exercise', 'info', 'Time to train',
        "It's been " + ctx.daysSinceWorkout + ' days since your last workout. Ready for the next one?');

    if (ctx.daysSinceAttendance != null && ctx.daysSinceAttendance >= 4)
      push('attendance', 'event_busy', 'info', 'We miss you',
        "You haven't checked in for " + ctx.daysSinceAttendance + ' days — keep your streak alive.');

    if (ctx.waterTarget && ctx.waterToday != null && ctx.waterToday < ctx.waterTarget * 0.5)
      push('hydration', 'water_drop', 'info', 'Stay hydrated',
        'You\'re at ' + (Math.round(ctx.waterToday / 100) / 10) + 'L of your ' + (ctx.waterTarget / 1000) + 'L goal today.');

    if (ctx.activeGoals >= 1)
      push('goal', 'flag', 'info', 'Keep chasing your goal',
        'You have ' + ctx.activeGoals + ' active goal' + (ctx.activeGoals === 1 ? '' : 's') + '. Log progress to stay on track.');

    var dismissed = readJSON(LS.notifDismiss, {});
    var today = todayISO();
    return out.filter(function (n) { return dismissed[n.id] !== today; });
  }
  // Snooze a reminder for the rest of the day.
  function dismiss(id) { var d = readJSON(LS.notifDismiss, {}); d[id] = todayISO(); writeJSON(LS.notifDismiss, d); }

  return {
    version: 1,
    trackExercise: trackExercise,
    recentExercises: recentExercises,
    evaluate: evaluate,
    achievementsTotal: ACHIEVEMENTS.length,
    rules: rules,
    dismiss: dismiss
  };
})();
