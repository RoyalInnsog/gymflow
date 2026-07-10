/*
 * Gym Flow — Member App · Phase U4A · On-device AI Platform
 * window.GymAI
 *
 * A privacy-first, OFFLINE intelligence engine for the Member App. It reasons
 * over a compact, structured "Health Memory" (never raw DB records) and returns
 * natural-language summaries, analysis, explanations and suggestions.
 *
 * Architecture (each a plug-in point for heavier models later):
 *   GymAI.runtime  — non-blocking, cancellable execution + timing (single reuse)
 *   GymAI.models   — Model Manager (local reasoning model + LLM/cloud slots)
 *   GymAI.context  — Context Engine (understands the current screen)
 *   GymAI.memory   — Health Memory (structured, compressed, on-device)
 *   GymAI.prompt   — Prompt Engine (structured intent → text, for future LLM/cloud)
 *   GymAI.service  — AI Service (the feature methods used by the UI)
 *
 * The default "model" (local-v1) is a deterministic reasoning engine — fast,
 * explainable, 100% offline. A future phase can register a real on-device LLM
 * or an optional cloud provider WITHOUT changing any calling code: the UI only
 * ever talks to GymAI.service.* and renders the same structured result shape.
 *
 * Result shape (rendered by the shell's renderAIResult):
 *   { title, subtitle?, blocks:[
 *       {type:'list',  heading, tone?, items:[{icon?,text,tone?}]}
 *     | {type:'text',  heading?, text, tone?}
 *     | {type:'stats', items:[{label,value}]}
 *     | {type:'score', label, value, max, confidence, note?}
 *     ], disclaimer?, source? }
 *
 * SAFETY: never diagnoses; medical topics always carry a disclaimer and defer
 * to professionals. Never modifies user data — it only explains and suggests.
 */
window.GymAI = (function () {
  'use strict';

  // ───────────────────────── persistence ─────────────────────────
  var LS = { enabled: 'gf.member.ai.enabled', model: 'gf.member.ai.model', cloud: 'gf.member.ai.cloud', stats: 'gf.member.ai.stats' };
  function lsGet(k, d) { try { var v = localStorage.getItem(k); return v == null ? d : v; } catch (e) { return d; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function jGet(k, d) { try { var v = JSON.parse(localStorage.getItem(k)); return v == null ? d : v; } catch (e) { return d; } }
  function jSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }

  function isEnabled() { return lsGet(LS.enabled, '1') !== '0'; }
  function setEnabled(on) { lsSet(LS.enabled, on ? '1' : '0'); }

  // ───────────────────────── Model Manager ─────────────────────────
  var MODELS = [
    { id: 'local-v1', name: 'GymFlow Local', kind: 'on-device', size_mb: 2, status: 'ready',
      description: 'Fast on-device reasoning engine. Runs fully offline — no data ever leaves your phone.' },
    { id: 'llm-advanced', name: 'Advanced On-Device Model', kind: 'on-device', size_mb: 0, status: 'not-installed',
      description: 'Optional larger language model for richer explanations. Download when available.' },
    { id: 'cloud', name: 'Cloud AI', kind: 'cloud', size_mb: 0, status: 'disabled',
      description: 'Optional cloud provider. Off by default — offline AI always stays primary.' }
  ];
  var Models = {
    all: function () { var a = Models.active(); return MODELS.map(function (m) { return { id: m.id, name: m.name, kind: m.kind, size_mb: m.size_mb, status: m.status, description: m.description, active: m.id === a }; }); },
    active: function () { return lsGet(LS.model, 'local-v1'); },
    setActive: function (id) { var m = Models.get(id); if (m && (m.status === 'ready' || id === 'local-v1')) { lsSet(LS.model, id); return true; } return false; },
    get: function (id) { return MODELS.filter(function (m) { return m.id === id; })[0] || null; },
    stats: function () { return jGet(LS.stats, { runs: 0, lastMs: 0, avgMs: 0 }); },
    recordRun: function (ms) { var s = Models.stats(); s.runs++; s.lastMs = ms; s.avgMs = Math.round((s.avgMs * (s.runs - 1) + ms) / s.runs); jSet(LS.stats, s); },
    resetStats: function () { jSet(LS.stats, { runs: 0, lastMs: 0, avgMs: 0 }); },
    // Real LLM backend plugs in here (WebLLM/WebGPU in-WebView, OR a native
    // MediaPipe Gemma bridge exposed by the APK). Shape:
    //   { id, name, ready:bool, generate:function(prompt,{onToken,signal})->Promise<string> }
    _backend: null,
    registerBackend: function (b) { Models._backend = b; if (b && b.id) lsSet(LS.model, b.id); },
    unregisterBackend: function () { Models._backend = null; lsSet(LS.model, 'local-v1'); },
    backend: function () { return Models._backend || null; },
    backendReady: function () { return !!(Models._backend && Models._backend.ready); }
  };

  // ───────────────────────── Runtime ─────────────────────────
  // Non-blocking + cancellable. Yields to the UI, then runs the (fast,
  // deterministic) task off the critical path. Records inference time.
  var Runtime = {
    status: 'idle',
    _yield: function (cb) { (window.requestIdleCallback || function (f) { return setTimeout(function () { f(); }, 16); })(cb); },
    run: function (taskFn) {
      var cancelled = false;
      var t0 = (window.performance && performance.now) ? performance.now() : Date.now();
      Runtime.status = 'inferring';
      var p = new Promise(function (resolve, reject) {
        Runtime._yield(function () {
          if (cancelled) { Runtime.status = 'ready'; reject({ cancelled: true }); return; }
          try {
            var out = taskFn();
            var t1 = (window.performance && performance.now) ? performance.now() : Date.now();
            Models.recordRun(Math.max(1, Math.round(t1 - t0)));
            Runtime.status = 'ready';
            resolve(out);
          } catch (e) { Runtime.status = 'ready'; reject(e); }
        });
      });
      p.cancel = function () { cancelled = true; };
      return p;
    },
    unload: function () { Runtime.status = 'idle'; } // called on app close to release
  };

  // ───────────────────────── Health Memory ─────────────────────────
  // Structured, compressed snapshot. Set by the shell from data the offline
  // engine already syncs — NEVER raw records.
  var _memory = null;
  var Memory = {
    set: function (m) { _memory = m || null; return _memory; },
    get: function () { return _memory; },
    has: function () { return !!_memory; }
  };

  // ───────────────────────── Context Engine ─────────────────────────
  var SCREEN_FOCUS = {
    home: 'your day at a glance', workout: 'your training', attendance: 'your gym visits',
    progress: 'your body & performance trends', goals: 'your goals', measurements: 'your measurements',
    nutrition: 'your nutrition', achievements: 'your achievements', profile: 'your profile', settings: 'settings', insights: 'your insights'
  };
  var Context = {
    forScreen: function (screen, extra) {
      screen = screen || 'home';
      return { screen: screen, focus: SCREEN_FOCUS[screen] || 'your fitness', extra: extra || {}, at: Date.now() };
    }
  };

  // ───────────────────────── helpers ─────────────────────────
  function n(v) { var x = Number(v); return isFinite(x) ? x : 0; }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function has(v) { return v !== null && v !== undefined && v !== ''; }
  function plural(k, w) { return k + ' ' + w + (k === 1 ? '' : 's'); }
  function li(text, tone, icon) { return { text: text, tone: tone || 'neutral', icon: icon || null }; }
  function M() { return _memory || {}; }

  // ───────────────────────── Reasoning (the "model") ─────────────────────────
  var Reason = {};

  Reason.todaySummary = function () {
    var m = M(), w = m.workouts || {}, nut = m.nutrition || {}, hyd = m.hydration || {}, att = m.attendance || {}, body = m.body || {};
    var items = [];
    // workout today
    if (w.todayLogged) items.push(li('Workout completed', 'good', 'check_circle'));
    else if (w.plannedToday) items.push(li('Today\'s workout not logged yet', 'warn', 'exercise'));
    // attendance
    if (att.todayCheckedIn) items.push(li('Checked in at the gym', 'good', 'check_circle'));
    else if (att.daysSinceLast != null && att.daysSinceLast >= 1) items.push(li('No check-in yet today', 'neutral', 'event_available'));
    // hydration
    if (hyd.targetMl) {
      if (hyd.todayMl >= hyd.targetMl) items.push(li('Water goal reached', 'good', 'water_drop'));
      else items.push(li('Water at ' + Math.round((hyd.todayMl / hyd.targetMl) * 100) + '% of goal', hyd.todayMl >= hyd.targetMl * 0.6 ? 'neutral' : 'warn', 'water_drop'));
    }
    // protein
    if (nut.proteinTarget) {
      if (nut.todayProtein >= nut.proteinTarget) items.push(li('Protein target met', 'good', 'egg'));
      else items.push(li('Protein below target (' + Math.round(nut.todayProtein) + '/' + nut.proteinTarget + 'g)', 'warn', 'egg'));
    }
    // weight
    if (has(body.weightTrendKg)) {
      var d = n(body.weightTrendKg);
      items.push(li(Math.abs(d) < 0.3 ? 'Weight stable' : 'Weight ' + (d < 0 ? 'down ' : 'up ') + Math.abs(d).toFixed(1) + ' kg this week', 'neutral', 'monitor_weight'));
    }
    if (!items.length) items.push(li('Log a workout, water or weight to get your first summary.', 'neutral', 'info'));
    var suggestions = Reason._quickSuggestions(m);
    var blocks = [{ type: 'list', heading: 'Today', items: items }];
    if (suggestions.length) blocks.push({ type: 'list', heading: 'Quick suggestions', tone: 'accent', items: suggestions });
    return { title: 'Today\'s summary', blocks: blocks, source: 'on-device' };
  };

  Reason._quickSuggestions = function (m) {
    var out = [], w = m.workouts || {}, nut = m.nutrition || {}, hyd = m.hydration || {};
    if (nut.proteinTarget && nut.todayProtein < nut.proteinTarget) out.push(li('Add ~' + Math.max(10, Math.round(nut.proteinTarget - nut.todayProtein)) + 'g protein — a shake or dal/eggs closes the gap.', 'accent', 'restaurant'));
    if (hyd.targetMl && hyd.todayMl < hyd.targetMl * 0.6) out.push(li('You\'re behind on water — keep a bottle nearby.', 'accent', 'water_drop'));
    if (w.daysSince != null && w.daysSince >= 3) out.push(li('It\'s been ' + w.daysSince + ' days since training — even a short session keeps momentum.', 'accent', 'exercise'));
    return out.slice(0, 3);
  };

  Reason.weekly = function () {
    var m = M(), att = m.attendance || {}, w = m.workouts || {}, nut = m.nutrition || {}, hyd = m.hydration || {}, body = m.body || {}, goals = m.goals || [];
    var wins = [], weak = [], sugg = [], risk = [];
    // attendance
    if (has(att.perWeek)) { if (att.perWeek >= 4) wins.push(li('Strong attendance — ' + att.perWeek + ' visits/week.', 'good')); else if (att.perWeek <= 1) risk.push(li('Low attendance (' + att.perWeek + '/week) — consistency is slipping.', 'bad')); }
    if (att.streak >= 3) wins.push(li(att.streak + '-day check-in streak going.', 'good'));
    // workouts
    if (has(w.perWeek)) { if (w.perWeek >= 3) wins.push(li(w.perWeek + ' workouts logged this week.', 'good')); else if (w.perWeek === 0) risk.push(li('No workouts logged this week.', 'bad')); }
    if (w.weakGroups && w.weakGroups.length) weak.push(li('Under-trained: ' + w.weakGroups.join(', ') + '. Add a session this week.', 'warn'));
    // protein
    if (nut.proteinTarget && has(nut.avgProtein)) { if (nut.avgProtein >= nut.proteinTarget * 0.9) wins.push(li('Protein on point (~' + Math.round(nut.avgProtein) + 'g/day).', 'good')); else { weak.push(li('Protein averaging ' + Math.round(nut.avgProtein) + 'g vs ' + nut.proteinTarget + 'g target.', 'warn')); sugg.push(li('Aim for a protein source at every meal.', 'accent')); } }
    // hydration
    if (hyd.hitDays7 != null) { if (hyd.hitDays7 >= 5) wins.push(li('Hydration solid (' + hyd.hitDays7 + '/7 days).', 'good')); else weak.push(li('Water goal hit only ' + hyd.hitDays7 + '/7 days.', 'warn')); }
    // weight vs goal
    if (has(body.weightTrendKg) && goals.length) {
      var g0 = goals[0];
      if (g0 && (g0.type === 'lose_weight') && n(body.weightTrendKg) > 0.2) risk.push(li('Weight ticked up while chasing a fat-loss goal.', 'bad'));
    }
    if (!wins.length) wins.push(li('Log a few days of data to surface your wins.', 'neutral'));
    if (!sugg.length) sugg.push(li('Keep your current routine — it\'s working.', 'accent'));
    var blocks = [
      { type: 'list', heading: 'Wins', tone: 'good', items: wins },
      { type: 'list', heading: 'Weak spots', tone: 'warn', items: weak.length ? weak : [li('Nothing major this week.', 'neutral')] },
      { type: 'list', heading: 'Suggestions', tone: 'accent', items: sugg }
    ];
    if (risk.length) blocks.push({ type: 'list', heading: 'Risk areas', tone: 'bad', items: risk });
    return { title: 'Your week', subtitle: 'Last 7 days', blocks: blocks, source: 'on-device' };
  };

  Reason.monthly = function () {
    var m = M(), att = m.attendance || {}, w = m.workouts || {}, str = m.strength || {}, body = m.body || {}, goals = m.goals || [], ach = m.achievements || {};
    var blocks = [];
    var stats = [];
    if (has(att.monthCount)) stats.push({ label: 'Gym visits', value: att.monthCount });
    if (has(w.monthCount)) stats.push({ label: 'Workouts', value: w.monthCount });
    if (has(str.prsMonth)) stats.push({ label: 'New PRs', value: str.prsMonth });
    if (has(body.weightTrendMonthKg)) stats.push({ label: 'Weight Δ', value: (n(body.weightTrendMonthKg) >= 0 ? '+' : '') + n(body.weightTrendMonthKg).toFixed(1) + 'kg' });
    if (stats.length) blocks.push({ type: 'stats', items: stats });

    var prog = [];
    if (has(w.perWeek)) prog.push(li('Averaging ' + w.perWeek + ' workouts/week ' + (w.perWeek >= 3 ? '— a strong, sustainable rhythm.' : '— room to add one more.'), w.perWeek >= 3 ? 'good' : 'warn'));
    if (has(att.perWeek)) prog.push(li('Attendance ~' + att.perWeek + '/week.', att.perWeek >= 3 ? 'good' : 'neutral'));
    if (str.prsMonth) prog.push(li(plural(str.prsMonth, 'strength PR') + ' this month — you\'re getting stronger.', 'good'));
    if (has(body.weightTrendMonthKg)) { var dm = n(body.weightTrendMonthKg); prog.push(li(Math.abs(dm) < 0.5 ? 'Body weight held steady.' : 'Body weight ' + (dm < 0 ? 'down' : 'up') + ' ' + Math.abs(dm).toFixed(1) + ' kg.', 'neutral')); }
    blocks.push({ type: 'list', heading: 'Progress', items: prog.length ? prog : [li('Keep logging to build a monthly picture.', 'neutral')] });

    // goal completion
    var goalItems = [];
    (goals || []).forEach(function (g) { if (has(g.progressPct)) goalItems.push(li(g.title + ' — ' + g.progressPct + '% there' + (g.remain ? ' (' + g.remain + ')' : ''), g.progressPct >= 80 ? 'good' : 'neutral')); });
    if (ach.monthUnlocked) goalItems.push(li(plural(ach.monthUnlocked, 'new achievement') + ' unlocked.', 'good'));
    if (goalItems.length) blocks.push({ type: 'list', heading: 'Goals & milestones', items: goalItems });

    // recovery estimate reference
    var rec = Reason.recovery();
    var recBlock = rec.blocks[0];
    blocks.push({ type: 'text', heading: 'Recovery', text: recBlock.label + ': ' + recBlock.value + '/100 (' + (recBlock.note || '') + ')', tone: 'neutral' });
    return { title: 'Your month', subtitle: 'Last 30 days', blocks: blocks, source: 'on-device' };
  };

  Reason.recovery = function () {
    var m = M(), w = m.workouts || {}, str = m.strength || {};
    var score = 70, inputs = 0;
    if (has(w.last3Count)) { inputs++; if (w.last3Count >= 3) score -= 22; else if (w.last3Count === 2) score -= 10; }
    if (has(w.daysSince)) { inputs++; if (w.daysSince >= 2) score += 14; if (w.daysSince >= 4) score += 6; if (w.daysSince === 0) score -= 6; }
    if (has(w.last7Volume)) { inputs++; if (w.last7Volume > 25000) score -= 12; else if (w.last7Volume > 15000) score -= 6; }
    if (str.prLast3) { inputs++; score -= 8; }
    if (has(m.attendance && m.attendance.perWeek)) { inputs++; if (m.attendance.perWeek >= 5) score -= 5; }
    score = clamp(Math.round(score), 5, 100);
    var readiness = score >= 75 ? 'Ready to train' : score >= 55 ? 'Train as planned' : score >= 35 ? 'Take it easier' : 'Prioritise rest';
    var confidence = inputs >= 4 ? 'High' : inputs >= 2 ? 'Medium' : 'Low';
    var advice = score >= 75 ? 'Recovery looks good — a hard session is well-supported.'
      : score >= 55 ? 'Moderate readiness — train, but leave a rep or two in reserve.'
      : score >= 35 ? 'Signs of fatigue — reduce volume or pick lighter accessory work.'
      : 'High fatigue signals — a rest or mobility day will pay off.';
    return {
      title: 'Recovery', blocks: [
        { type: 'score', label: readiness, value: score, max: 100, confidence: confidence, note: readiness },
        { type: 'text', heading: 'Advice', text: advice, tone: 'accent' },
        { type: 'text', heading: 'Confidence', text: confidence + ' — estimated from workout frequency, volume, rest days and recent PRs (no wearable data).', tone: 'neutral' }
      ], source: 'on-device'
    };
  };

  Reason.patterns = function () {
    var m = M(), w = m.workouts || {}, att = m.attendance || {}, nut = m.nutrition || {}, body = m.body || {};
    var found = [];
    if (w.daysSince != null && w.daysSince >= 4) found.push(li('Missed-workout pattern — ' + w.daysSince + ' days since your last session.', 'warn', 'exercise'));
    if (att.perWeek != null && att.perWeek <= 1) found.push(li('Low attendance — around ' + att.perWeek + ' visit/week lately.', 'warn', 'event_busy'));
    if (nut.proteinTarget && nut.avgProtein != null && nut.avgProtein < nut.proteinTarget * 0.8) found.push(li('Low-protein pattern — averaging under 80% of target.', 'warn', 'egg'));
    if (body.weightPlateau) found.push(li('Weight plateau — little change over the last few weeks.', 'neutral', 'trending_flat'));
    if (w.weakGroups && w.weakGroups.length) found.push(li((w.weakGroups.indexOf('Legs') !== -1 ? 'Skipped leg day — ' : 'Under-trained ') + w.weakGroups.join(', ') + '.', 'warn', 'directions_walk'));
    if (w.scheduleIrregular) found.push(li('Irregular schedule — training days vary a lot week to week.', 'neutral', 'schedule'));
    if (str_declining(m)) found.push(li('Performance dip — recent working weights trending down.', 'warn', 'trending_down'));
    var sugg = [];
    if (found.length) {
      if (w.weakGroups && w.weakGroups.length) sugg.push(li('Schedule your under-trained muscle group first next week.', 'accent'));
      if (w.daysSince >= 4) sugg.push(li('Book a fixed training time — habit beats motivation.', 'accent'));
      if (nut.proteinTarget && nut.avgProtein < nut.proteinTarget * 0.8) sugg.push(li('Prep a high-protein snack for busy days.', 'accent'));
    }
    if (!found.length) found.push(li('No concerning patterns — you\'re on track. 👏', 'good', 'check_circle'));
    var blocks = [{ type: 'list', heading: 'Patterns detected', items: found }];
    if (sugg.length) blocks.push({ type: 'list', heading: 'How to improve', tone: 'accent', items: sugg });
    return { title: 'Pattern check', blocks: blocks, source: 'on-device' };
  };
  function str_declining(m) { return !!(m.strength && m.strength.declining); }

  Reason.insights = function () {
    var today = Reason.todaySummary();
    var week = Reason.weekly();
    var rec = Reason.recovery();
    var pat = Reason.patterns();
    var m = M(), goals = m.goals || [];
    var blocks = [];
    blocks.push({ type: 'text', heading: 'Today', text: (today.blocks[0].items[0] || {}).text || '—', tone: 'neutral' });
    // weekly wins/risks condensed
    var winsBlock = week.blocks[0];
    if (winsBlock && winsBlock.items.length) blocks.push({ type: 'list', heading: 'This week', items: winsBlock.items.slice(0, 2) });
    var riskBlock = week.blocks.filter(function (b) { return b.heading === 'Risk areas'; })[0];
    if (riskBlock) blocks.push({ type: 'list', heading: 'Current risks', tone: 'bad', items: riskBlock.items });
    // goals
    if (goals.length) { var gi = []; goals.slice(0, 3).forEach(function (g) { gi.push(li(g.title + (has(g.progressPct) ? ' — ' + g.progressPct + '%' : ''), g.progressPct >= 80 ? 'good' : 'neutral')); }); blocks.push({ type: 'list', heading: 'Current goal' + (goals.length > 1 ? 's' : ''), items: gi }); }
    // recovery
    var rb = rec.blocks[0]; blocks.push({ type: 'score', label: rb.label, value: rb.value, max: 100, confidence: rb.confidence });
    // suggestions
    var patSugg = pat.blocks.filter(function (b) { return b.heading === 'How to improve'; })[0];
    if (patSugg) blocks.push({ type: 'list', heading: 'Suggestions', tone: 'accent', items: patSugg.items });
    return { title: 'Insights', blocks: blocks, source: 'on-device' };
  };

  Reason.explainExercise = function (ex) {
    if (!ex) return { title: 'Exercise', blocks: [{ type: 'text', text: 'Exercise not found.', tone: 'neutral' }] };
    var m = M(), fav = (m.workouts && m.workouts.favoriteExercises) || [];
    var why = 'A ' + (ex.mechanic ? ex.mechanic.toLowerCase() : '') + ' movement for the ' + (ex.primary_muscle || 'target muscle').toLowerCase() + '. ' +
      (ex.mechanic === 'Compound' ? 'Compounds like this build the most overall strength and muscle for your time.' : 'Isolation work like this sharpens a specific muscle once the big lifts are done.');
    var blocks = [
      { type: 'text', heading: 'Why this exercise', text: why, tone: 'neutral' },
      { type: 'text', heading: 'Muscles worked', text: (ex.target_muscles || [ex.primary_muscle]).join(', ') + '.', tone: 'neutral' }
    ];
    if (ex.common_mistakes && ex.common_mistakes.length) blocks.push({ type: 'list', heading: 'Common mistakes', tone: 'warn', items: ex.common_mistakes.map(function (t) { return li(t, 'warn'); }) });
    if (ex.tips && ex.tips.length) blocks.push({ type: 'list', heading: 'Tips', tone: 'accent', items: ex.tips.map(function (t) { return li(t, 'accent'); }) });
    // warm-up / cooldown / alternatives via library
    var alts = Reason._alternatives(ex);
    if (alts.length) blocks.push({ type: 'list', heading: 'Alternatives', items: alts.map(function (a) { return li(a, 'neutral'); }) });
    blocks.push({ type: 'text', heading: 'Warm-up', text: '1–2 light sets at ~50% before your working weight; add a mobility drill for the ' + (ex.primary_muscle || 'target').toLowerCase() + '.', tone: 'neutral' });
    blocks.push({ type: 'text', heading: 'Cooldown', text: 'Gentle stretch of the ' + (ex.target_muscles || [ex.primary_muscle]).join(' & ').toLowerCase() + ' for 30–60s.', tone: 'neutral' });
    if (fav.indexOf(ex.id) !== -1) blocks.unshift({ type: 'text', text: 'One of your go-to exercises. 💪', tone: 'good' });
    return { title: ex.name, blocks: blocks, source: 'on-device' };
  };
  Reason._alternatives = function (ex) {
    if (!window.GymExerciseLibrary || !ex) return [];
    return window.GymExerciseLibrary.search({ category: ex.category })
      .filter(function (e) { return e.id !== ex.id && e.equipment !== ex.equipment; })
      .slice(0, 3).map(function (e) { return e.name + ' (' + e.equipment + ')'; });
  };

  Reason.prExplain = function (pr) {
    if (!pr) return { title: 'Personal record', blocks: [{ type: 'text', text: 'Log a PR to see what it means.', tone: 'neutral' }] };
    return { title: 'PR — ' + (pr.exercise || 'lift'), blocks: [
      { type: 'text', text: 'You lifted ' + n(pr.weight_kg) + ' kg × ' + (pr.reps || 1) + '. Estimated 1-rep max ≈ ' + Math.round(n(pr.weight_kg) * (1 + (pr.reps || 1) / 30)) + ' kg (Epley).', tone: 'good' },
      { type: 'text', heading: 'What it means', text: 'A new PR shows real strength adaptation. Progress it slowly — small weekly jumps beat big risky ones.', tone: 'accent' }
    ], source: 'on-device' };
  };

  Reason.analyzeGoal = function (goal) {
    if (!goal) return { title: 'Goal', blocks: [{ type: 'text', text: 'No goal selected.', tone: 'neutral' }] };
    var m = M(), att = m.attendance || {}, w = m.workouts || {};
    var blocks = [];
    if (has(goal.progressPct)) blocks.push({ type: 'score', label: goal.title, value: goal.progressPct, max: 100, confidence: 'Medium', note: goal.remain || '' });
    else blocks.push({ type: 'text', heading: goal.title, text: 'Set a numeric target to track visual progress.', tone: 'neutral' });
    var analysis = [];
    if (has(w.perWeek)) analysis.push(li('Training ' + w.perWeek + '×/week — ' + (w.perWeek >= 3 ? 'a solid base for this goal.' : 'consider one more session to accelerate.'), w.perWeek >= 3 ? 'good' : 'warn'));
    if (has(att.perWeek)) analysis.push(li('Gym attendance ~' + att.perWeek + '/week.', 'neutral'));
    if (goal.type === 'lose_weight' && m.nutrition && m.nutrition.avgCalories) analysis.push(li('Fat loss is driven by a calorie deficit — keep intake consistent and protein high.', 'accent'));
    if (goal.type === 'gain_muscle') analysis.push(li('Muscle gain needs progressive overload + enough protein and a slight surplus.', 'accent'));
    if (goal.type === 'strength') analysis.push(li('Strength responds to heavier loads at lower reps — prioritise the big compounds.', 'accent'));
    blocks.push({ type: 'list', heading: 'Analysis', items: analysis.length ? analysis : [li('Log workouts and weight to analyse this goal.', 'neutral')] });
    blocks.push({ type: 'text', text: 'AI never changes your goals — you\'re always in control.', tone: 'neutral' });
    return { title: 'Goal analysis', blocks: blocks, source: 'on-device' };
  };

  Reason.explainChart = function (kind) {
    var m = M(), body = m.body || {}, att = m.attendance || {}, w = m.workouts || {};
    var text = '', tone = 'neutral';
    if (kind === 'weight') text = has(body.weightTrendKg) ? ('Your weight is ' + (Math.abs(n(body.weightTrendKg)) < 0.3 ? 'stable' : (n(body.weightTrendKg) < 0 ? 'trending down' : 'trending up')) + ' (' + (n(body.weightTrendKg) >= 0 ? '+' : '') + n(body.weightTrendKg).toFixed(1) + ' kg over ~7 days). Weight naturally fluctuates day to day — the trend line matters more than any single point.') : 'Log your weight a few times to reveal a trend.';
    else if (kind === 'attendance') text = has(att.perWeek) ? ('You\'re visiting the gym about ' + att.perWeek + '×/week. ' + (att.perWeek >= 3 ? 'That consistency is exactly what drives results.' : 'Nudging this up is the single biggest lever right now.')) : 'Check in a few times to chart your attendance.';
    else if (kind === 'workout') text = has(w.perWeek) ? ('Workout consistency is ~' + w.perWeek + '/week. ' + (w.perWeek >= 3 ? 'Great rhythm — keep it steady.' : 'Aim for a repeatable weekly minimum.')) : 'Finish a few workouts to chart consistency.';
    else if (kind === 'measurements') text = 'Measurements change slower than the scale. Track the same spots monthly and watch the direction, not the daily number.';
    else text = 'This chart shows your recent trend. Look at the overall direction rather than individual points.';
    return { title: 'What this chart shows', blocks: [{ type: 'text', text: text, tone: tone }], source: 'on-device' };
  };

  Reason.nutritionReview = function () {
    var m = M(), nut = m.nutrition || {};
    var blocks = [], items = [];
    if (has(nut.todayCalories)) items.push({ label: 'Calories', value: Math.round(nut.todayCalories) + (nut.calorieTarget ? ' / ' + nut.calorieTarget : '') });
    if (has(nut.todayProtein)) items.push({ label: 'Protein', value: Math.round(nut.todayProtein) + 'g' + (nut.proteinTarget ? ' / ' + nut.proteinTarget + 'g' : '') });
    if (items.length) blocks.push({ type: 'stats', items: items });
    var notes = [];
    if (nut.proteinTarget && has(nut.todayProtein)) { if (nut.todayProtein >= nut.proteinTarget) notes.push(li('Protein target met — great for recovery and muscle.', 'good')); else notes.push(li('Protein is ' + Math.round(nut.proteinTarget - nut.todayProtein) + 'g short. Try eggs, dal, paneer, chicken or a shake.', 'warn')); }
    if (nut.calorieTarget && has(nut.todayCalories)) { var diff = nut.todayCalories - nut.calorieTarget; if (Math.abs(diff) < 150) notes.push(li('Calories close to target.', 'good')); else notes.push(li('Calories ' + (diff > 0 ? 'over' : 'under') + ' by ~' + Math.abs(Math.round(diff)) + '. ' + (diff > 0 ? 'Lean protein + veg keeps you full for fewer calories.' : 'Add a balanced snack if training hard.'), 'neutral')); }
    if (!notes.length) notes.push(li('Log today\'s calories and protein for a review.', 'neutral'));
    blocks.push({ type: 'list', heading: 'Review', items: notes });
    blocks.push({ type: 'list', heading: 'Healthy swaps', tone: 'accent', items: [li('Fried → grilled or air-fried.', 'accent'), li('Sugary drink → water / black coffee.', 'accent'), li('Refined carbs → whole grains + protein.', 'accent')] });
    return { title: 'Nutrition review', blocks: blocks, source: 'on-device' };
  };

  // Manual meal estimate (no camera): rough per-item macros from a tiny lookup.
  Reason.estimateMeal = function (text) {
    var q = String(text || '').toLowerCase();
    var table = [
      { k: ['egg'], cal: 78, p: 6 }, { k: ['chicken', 'breast'], cal: 165, p: 31 }, { k: ['paneer'], cal: 265, p: 18 },
      { k: ['dal', 'lentil'], cal: 180, p: 12 }, { k: ['rice'], cal: 200, p: 4 }, { k: ['roti', 'chapati'], cal: 120, p: 3 },
      { k: ['milk'], cal: 120, p: 8 }, { k: ['banana'], cal: 105, p: 1 }, { k: ['oats'], cal: 150, p: 5 },
      { k: ['whey', 'shake', 'protein'], cal: 120, p: 24 }, { k: ['curd', 'yogurt', 'dahi'], cal: 100, p: 9 }, { k: ['peanut', 'nuts'], cal: 200, p: 8 }
    ];
    var cal = 0, p = 0, hits = [];
    table.forEach(function (row) { if (row.k.some(function (w) { return q.indexOf(w) !== -1; })) { cal += row.cal; p += row.p; hits.push(row.k[0]); } });
    var conf = hits.length ? (hits.length >= 2 ? 'Medium' : 'Low') : 'Low';
    var blocks = [
      { type: 'stats', items: [{ label: 'Est. calories', value: cal ? '~' + cal : '—' }, { label: 'Est. protein', value: p ? '~' + p + 'g' : '—' }] },
      { type: 'text', heading: 'Confidence', text: conf + (hits.length ? ' — recognised: ' + hits.join(', ') + '.' : ' — add foods like "2 eggs, rice, dal" for an estimate.'), tone: 'neutral' },
      { type: 'text', text: 'These are rough estimates. Review and adjust before saving — you\'re always in control.', tone: 'warn' }
    ];
    return { title: 'Meal estimate', blocks: blocks, estimate: { calories: cal, protein: p, confidence: conf }, source: 'on-device' };
  };

  Reason.achievementInsight = function (a) {
    if (!a) return { title: 'Achievement', blocks: [{ type: 'text', text: 'Keep training to unlock more.', tone: 'neutral' }] };
    var why = {
      streak_7: 'You\'ve trained for seven days running. Consistency like this is the strongest predictor of long-term results.',
      streak_30: 'A 30-day streak is elite consistency — the habit is now doing the work for you.',
      workouts_100: '100 workouts logged. This is what long-term transformation is built on.',
      first_pr: 'Your first personal record — proof your training is producing real strength.',
      goal_done: 'You completed a goal you set for yourself. Set the next one to keep momentum.',
      anniversary: 'A full year as a member. Showing up for a year is a bigger deal than any single session.'
    }[a.id] || ('You unlocked "' + a.name + '". Small wins compound — keep stacking them.');
    return { title: a.name, blocks: [{ type: 'text', text: why, tone: 'good' }], source: 'on-device' };
  };

  Reason.accountability = function () {
    var m = M(), w = m.workouts || {}, nut = m.nutrition || {}, att = m.attendance || {};
    var out = [];
    if (w.trainsToday && !w.todayLogged) out.push(li('You usually train on ' + w.todayName + '. Today is ' + w.todayName + ' and no workout is logged yet.', 'warn', 'exercise'));
    if (nut.proteinTarget && nut.weekProteinPct != null && nut.weekProteinPct >= 70 && nut.weekProteinPct < 100) out.push(li('You\'ve reached ' + nut.weekProteinPct + '% of your weekly protein goal — finish strong.', 'accent', 'egg'));
    if (att.daysSinceLast != null && att.daysSinceLast >= 3) out.push(li('It\'s been ' + att.daysSinceLast + ' days since your last check-in.', 'neutral', 'event_available'));
    return out;
  };

  // Native coach — routes a question to the right reasoning + a short answer.
  Reason.coach = function (question, screen) {
    var q = String(question || '').toLowerCase().trim();
    var route = function (kw) { return kw.some(function (w) { return q.indexOf(w) !== -1; }); };
    if (!q) return { title: 'Coach', blocks: [{ type: 'text', text: 'Ask me to explain, analyse, or suggest — about your training, nutrition, recovery or goals.', tone: 'neutral' }], source: 'on-device' };
    var res;
    if (route(['recover', 'rest', 'sore', 'tired', 'fatigue', 'ready'])) res = Reason.recovery();
    else if (route(['week', 'this week'])) res = Reason.weekly();
    else if (route(['month'])) res = Reason.monthly();
    else if (route(['goal'])) res = (M().goals && M().goals[0]) ? Reason.analyzeGoal(M().goals[0]) : { title: 'Goals', blocks: [{ type: 'text', text: 'Add a goal in your profile and I\'ll analyse it.', tone: 'neutral' }] };
    else if (route(['protein', 'eat', 'calorie', 'nutrition', 'diet', 'meal', 'food'])) res = Reason.nutritionReview();
    else if (route(['pattern', 'wrong', 'problem', 'stuck', 'plateau'])) res = Reason.patterns();
    else if (route(['improve', 'better', 'suggest', 'advice', 'tip', 'should'])) res = Reason.patterns();
    else if (route(['motivat', 'lazy', 'give up', 'demotivat', 'why bother'])) res = { title: 'Coach', blocks: [{ type: 'text', text: 'You\'ve already put in the work to get here — ' + ((M().workouts || {}).total || 0) + ' workouts and counting. You don\'t need a perfect day, just the next one. Show up and let momentum do the rest. 💪', tone: 'accent' }] };
    else if (route(['today', 'summary', 'how am i'])) res = Reason.todaySummary();
    else res = { title: 'Coach', blocks: [{ type: 'text', text: 'I can help with your training, nutrition, recovery, goals and progress. Try: "analyse my week", "am I recovered?", "how\'s my protein?", or "how do I improve?"', tone: 'neutral' }] };
    res.subtitle = 'On ' + (SCREEN_FOCUS[screen] || 'your fitness');
    return res;
  };

  // ───────────────────────── Prompt Engine ─────────────────────────
  // Structured intent (also renders to text for a future LLM / cloud provider).
  var Prompt = {
    build: function (task, ctx) { return { task: task, screen: ctx && ctx.screen, memory: Memory.get(), at: Date.now() }; },
    toText: function (p) {
      var m = p.memory || {};
      return 'Task: ' + p.task + '\nScreen: ' + (p.screen || 'home') + '\nMember memory (structured, on-device): ' + JSON.stringify(m).slice(0, 4000);
    }
  };

  // ───────────────────────── AI Service (public feature API) ─────────────────────────
  // Each returns a cancellable Promise<result>. Non-blocking. Offline.
  function svc(taskName, fn) {
    return function (arg) {
      if (!isEnabled()) return Promise.reject({ disabled: true });
      // (Prompt is built for a future LLM/cloud backend; local model runs fn.)
      Prompt.build(taskName, Context.forScreen((_memory && _memory._screen) || 'home'));
      return Runtime.run(function () { return fn(arg); });
    };
  }
  function nowMs() { return (window.performance && performance.now) ? performance.now() : Date.now(); }
  // Real neural generation through the registered backend (LLM). Rejects with
  // {noBackend:true} if no model is loaded — callers fall back to reasoning.
  function generate(prompt, opts) {
    opts = opts || {};
    if (!isEnabled()) return Promise.reject({ disabled: true });
    var b = Models.backend();
    if (!(b && b.ready && b.generate)) return Promise.reject({ noBackend: true });
    var t0 = nowMs();
    Runtime.status = 'inferring';
    return Promise.resolve(b.generate(prompt, opts)).then(function (txt) {
      Models.recordRun(Math.max(1, Math.round(nowMs() - t0)));
      Runtime.status = 'ready';
      return txt;
    }, function (e) { Runtime.status = 'ready'; throw e; });
  }

  var Service = {
    // Native chat — real on-device LLM when a model is loaded; otherwise the
    // lightweight reasoning fallback (a fallback, never presented as the model).
    chat: function (question, screen, opts) {
      if (!isEnabled()) return Promise.reject({ disabled: true });
      if (Models.backendReady()) {
        var sys = 'You are Gym Flow Coach, a concise, supportive on-device fitness assistant. Use the member context to personalise advice. Keep answers short and practical. Never give medical diagnoses; suggest seeing a professional when relevant.';
        var ctx = JSON.stringify(Memory.get() || {}).slice(0, 3500);
        var prompt = sys + '\n\nMember context (private, on-device):\n' + ctx + '\n\nCurrent screen: ' + (screen || 'home') + '\nUser: ' + question + '\nCoach:';
        return generate(prompt, opts).then(function (txt) { return { text: String(txt || '').trim(), source: (Models.backend() || {}).id || 'llm' }; });
      }
      return Runtime.run(function () { return Reason.coach(question, screen); });
    },
    usingRealModel: function () { return Models.backendReady(); },
    todaySummary: svc('today', function () { return Reason.todaySummary(); }),
    analyzeWeek: svc('week', function () { return Reason.weekly(); }),
    analyzeMonth: svc('month', function () { return Reason.monthly(); }),
    recovery: svc('recovery', function () { return Reason.recovery(); }),
    detectPatterns: svc('patterns', function () { return Reason.patterns(); }),
    insights: svc('insights', function () { return Reason.insights(); }),
    explainExercise: svc('exercise', function (ex) { return Reason.explainExercise(ex); }),
    explainPR: svc('pr', function (pr) { return Reason.prExplain(pr); }),
    analyzeGoal: svc('goal', function (g) { return Reason.analyzeGoal(g); }),
    explainChart: svc('chart', function (k) { return Reason.explainChart(k); }),
    nutritionReview: svc('nutrition', function () { return Reason.nutritionReview(); }),
    estimateMeal: svc('meal', function (t) { return Reason.estimateMeal(t); }),
    achievementInsight: svc('achievement', function (a) { return Reason.achievementInsight(a); }),
    coach: function (question, screen) { if (!isEnabled()) return Promise.reject({ disabled: true }); return Runtime.run(function () { return Reason.coach(question, screen); }); },
    // synchronous, cheap — for inline badges/reminders (no sheet)
    accountabilitySync: function () { return isEnabled() ? Reason.accountability() : []; },
    todaySummarySync: function () { return isEnabled() ? Reason.todaySummary() : null; }
  };

  return {
    version: '4A',
    isEnabled: isEnabled, setEnabled: setEnabled,
    runtime: Runtime, models: Models, memory: Memory, context: Context, prompt: Prompt, service: Service,
    generate: generate,
    // convenience
    available: function () { return isEnabled() && Memory.has(); },
    usingRealModel: function () { return Models.backendReady(); }
  };
})();
