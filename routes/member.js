/*
 * [U1] Member self-service API. Mounted at /api/v1/member behind
 * authenticateToken + requireTenant + requireMemberRole (r5 only) — the mirror
 * image of the staff surface: a staff token is 403 here exactly like a member
 * token is 403 on /api/v1/*. See MEMBER_APP_U1.md.
 *
 * Contracts the offline layer depends on:
 *   • Every list GET returns a FLAT ARRAY of rows with an `id` — that is the
 *     shape the entity stores in public/assets/js/offline expect.
 *   • POST /health upserts by (tenant, member, log_date), so offline replays of
 *     the same day can never create server-side duplicates.
 *   • tenant_id and member_id ALWAYS come from the token / user_roles link —
 *     never from the request body.
 */
const express = require('express');
const { getQuery, runQuery, allQuery } = require('../database');
const { newId } = require('../lib/identity/core');
const engine = require('../lib/membershipEngine');
const { getTodayString } = require('../lib/dateUtils');

const router = express.Router();

// ---- small validators -------------------------------------------------------
function num(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function str(v, max) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (!s) return null;
  return s.slice(0, max || 500);
}
// 'YYYY-MM-DD' or null. Rejects garbage so date-keyed upserts stay sane.
function dateStr(v) {
  const s = str(v, 10);
  return s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}
function parseJsonArray(text) {
  try { const a = JSON.parse(text || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; }
}
// Exercises come from the client as a doc; sanitize field-by-field, cap at 50.
function sanitizeExercises(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 50).map(e => ({
    name: str(e && e.name, 120) || 'Exercise',
    muscle: str(e && e.muscle, 60),
    // [U2] Stable slug of the built-in Exercise Library entry (when picked from
    // the catalogue) so the app can re-hydrate rich detail / future media.
    library_id: str(e && e.library_id, 80),
    // [U3] Set typing (normal|warmup|dropset) + superset grouping (run id).
    set_type: str(e && e.set_type, 12),
    superset_group: str(e && e.superset_group, 8),
    sets: num(e && e.sets) || 0,
    reps: num(e && e.reps) || 0,
    weight_kg: num(e && e.weight_kg) || 0,
    rest_sec: num(e && e.rest_sec) || 0,
    notes: str(e && e.notes, 300)
  }));
}

// ---- member context ---------------------------------------------------------
// Resolve the members-row this account is linked to (user_roles.member_id, set
// by the F2 claim flow). Data endpoints require the link; /overview and
// /profile degrade gracefully so the shell can render a "finish linking" state.
router.use(async (req, res, next) => {
  try {
    const row = await getQuery(
      `SELECT member_id FROM user_roles
        WHERE user_id = ? AND tenant_id = ? AND role_id = 'r5'
          AND (status IS NULL OR status = 'active')`,
      [req.user.id, req.tenant_id]
    );
    if (!row) return res.status(403).json({ error: 'No active membership in this gym.', code: 'NOT_MEMBER' });
    req.member_id = row.member_id || null;
    next();
  } catch (err) {
    console.error('Member context error:', err);
    res.status(500).json({ error: 'Failed to resolve member context.' });
  }
});

function requireLinked(req, res, next) {
  if (!req.member_id) return res.status(403).json({ error: 'This account is not linked to a member profile yet.', code: 'NOT_LINKED' });
  next();
}

// ---- helpers over existing data ----------------------------------------------
async function latestMembership(tenantId, memberId) {
  return getQuery(
    `SELECT ms.id, ms.plan_id, ms.start_date, ms.end_date, ms.status, mp.name AS plan_name
       FROM memberships ms
       LEFT JOIN membership_plans mp ON mp.id = ms.plan_id
      WHERE ms.tenant_id = ? AND ms.member_id = ?
      ORDER BY ms.end_date DESC LIMIT 1`,
    [tenantId, memberId]
  );
}

// Consecutive-day streak from attendance, counted back from today (a gap of one
// day before today is allowed — "yesterday's streak" survives until midnight).
async function attendanceStreak(tenantId, memberId) {
  const rows = await allQuery(
    `SELECT DISTINCT date(check_in) AS d FROM attendance
      WHERE tenant_id = ? AND member_id = ? ORDER BY d DESC LIMIT 120`,
    [tenantId, memberId]
  );
  if (!rows.length) return 0;
  const days = rows.map(r => r.d);
  const today = getTodayString();
  const oneDay = 86400000;
  let cursor = Date.parse(today);
  if (days[0] !== today) {
    cursor -= oneDay; // streak may end yesterday
    if (days[0] !== new Date(cursor).toISOString().slice(0, 10)) return 0;
  }
  let streak = 0;
  for (const d of days) {
    if (d === new Date(cursor).toISOString().slice(0, 10)) { streak++; cursor -= oneDay; }
    else break;
  }
  return streak;
}

// ---- overview ----------------------------------------------------------------
router.get('/overview', async (req, res) => {
  try {
    const tenant = await getQuery(`SELECT gym_name, latitude, longitude, geofence_radius FROM tenants WHERE id = ?`, [req.tenant_id]);
    if (!req.member_id) {
      return res.json({
        linked: false,
        gym_name: (tenant && tenant.gym_name) || '',
        gym_latitude: tenant ? tenant.latitude : null,
        gym_longitude: tenant ? tenant.longitude : null,
        geofence_radius: tenant ? tenant.geofence_radius : null,
        member: null
      });
    }
    const member = await getQuery(
      `SELECT m.id, m.full_name, m.photo_url, m.weight_kg, m.height_cm, m.status, m.primary_trainer_id,
              m.health_connect_linked, s.name AS trainer_name
         FROM members m LEFT JOIN staff s ON s.id = m.primary_trainer_id
        WHERE m.id = ? AND m.tenant_id = ?`,
      [req.member_id, req.tenant_id]
    );
    if (!member) {
      return res.json({
        linked: false,
        gym_name: (tenant && tenant.gym_name) || '',
        gym_latitude: tenant ? tenant.latitude : null,
        gym_longitude: tenant ? tenant.longitude : null,
        geofence_radius: tenant ? tenant.geofence_radius : null,
        member: null
      });
    }

    const ms = await latestMembership(req.tenant_id, req.member_id);
    const today = getTodayString();
    const daysLeft = ms && ms.end_date ? engine.remainingDays(ms.end_date, today) : null;
    const streak = await attendanceStreak(req.tenant_id, req.member_id);
    const todayLog = await getQuery(
      `SELECT * FROM health_logs WHERE tenant_id = ? AND member_id = ? AND log_date = ?`,
      [req.tenant_id, req.member_id, today]
    );
    const checkedIn = await getQuery(
      `SELECT id FROM attendance WHERE tenant_id = ? AND member_id = ? AND date(check_in) = ? LIMIT 1`,
      [req.tenant_id, req.member_id, today]
    );

    res.json({
      linked: true,
      gym_name: (tenant && tenant.gym_name) || '',
      gym_latitude: tenant ? tenant.latitude : null,
      gym_longitude: tenant ? tenant.longitude : null,
      geofence_radius: tenant ? tenant.geofence_radius : null,
      member: { id: member.id, full_name: member.full_name, photo_url: member.photo_url, status: member.status, health_connect_linked: member.health_connect_linked ? 1 : 0 },
      trainer_name: member.trainer_name || null,
      membership: ms ? {
        plan_name: ms.plan_name || 'Membership',
        start_date: ms.start_date, end_date: ms.end_date,
        status: ms.status, days_left: daysLeft
      } : null,
      streak,
      today: {
        checked_in: !!checkedIn,
        health: todayLog || null
      }
    });
  } catch (err) {
    console.error('Member overview error:', err);
    res.status(500).json({ error: 'Failed to load overview.' });
  }
});

// ---- profile -----------------------------------------------------------------
router.get('/profile', async (req, res) => {
  try {
    const tenant = await getQuery(`SELECT gym_name FROM tenants WHERE id = ?`, [req.tenant_id]);
    if (!req.member_id) return res.json({ linked: false, gym_name: (tenant && tenant.gym_name) || '' });
    const member = await getQuery(
      `SELECT m.id, m.full_name, m.phone, m.email, m.dob, m.gender, m.photo_url,
              m.height_cm, m.weight_kg, m.bmi, m.status, m.created_at,
              m.emergency_contact_name, m.emergency_contact_phone,
              s.name AS trainer_name, s.phone AS trainer_phone
         FROM members m LEFT JOIN staff s ON s.id = m.primary_trainer_id
        WHERE m.id = ? AND m.tenant_id = ?`,
      [req.member_id, req.tenant_id]
    );
    const ms = await latestMembership(req.tenant_id, req.member_id);
    res.json({
      linked: true,
      gym_name: (tenant && tenant.gym_name) || '',
      account_email: req.user.email,
      member: member || null,
      membership: ms ? Object.assign({}, ms, { days_left: ms.end_date ? engine.remainingDays(ms.end_date, getTodayString()) : null }) : null
    });
  } catch (err) {
    console.error('Member profile error:', err);
    res.status(500).json({ error: 'Failed to load profile.' });
  }
});

// ---- attendance (read-only in U1; check-in stays staff/QR-side) ---------------
router.get('/attendance', requireLinked, async (req, res) => {
  try {
    const rows = await allQuery(
      `SELECT id, check_in, check_out, access_method
         FROM attendance
        WHERE tenant_id = ? AND member_id = ? AND check_in >= datetime('now', '-365 days')
        ORDER BY check_in DESC`,
      [req.tenant_id, req.member_id]
    );
    res.json(rows);
  } catch (err) {
    console.error('Member attendance error:', err);
    res.status(500).json({ error: 'Failed to load attendance.' });
  }
});

// ---- workout plans -------------------------------------------------------------
function planToClient(row) {
  const out = Object.assign({}, row, { exercises: parseJsonArray(row.exercises_json) });
  delete out.exercises_json;
  return out;
}

router.get('/workouts', requireLinked, async (req, res) => {
  try {
    const rows = await allQuery(
      `SELECT * FROM workout_plans WHERE tenant_id = ? AND member_id = ? ORDER BY created_at DESC`,
      [req.tenant_id, req.member_id]
    );
    res.json(rows.map(planToClient));
  } catch (err) {
    console.error('Member workouts error:', err);
    res.status(500).json({ error: 'Failed to load workouts.' });
  }
});

router.post('/workouts', requireLinked, async (req, res) => {
  try {
    const name = str(req.body && req.body.name, 120);
    if (!name) return res.status(400).json({ error: 'Workout name is required.' });
    const id = newId('wp');
    const exercises = sanitizeExercises(req.body.exercises);
    await runQuery(
      `INSERT INTO workout_plans (id, tenant_id, member_id, name, description, day_of_week, exercises_json, created_by, is_active)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'member', 1)`,
      [id, req.tenant_id, req.member_id, name, str(req.body.description, 500), str(req.body.day_of_week, 10), JSON.stringify(exercises)]
    );
    const row = await getQuery(`SELECT * FROM workout_plans WHERE id = ?`, [id]);
    res.status(201).json(planToClient(row));
  } catch (err) {
    console.error('Member workout create error:', err);
    res.status(500).json({ error: 'Failed to create workout.' });
  }
});

router.put('/workouts/:id', requireLinked, async (req, res) => {
  try {
    const existing = await getQuery(
      `SELECT * FROM workout_plans WHERE id = ? AND tenant_id = ? AND member_id = ?`,
      [req.params.id, req.tenant_id, req.member_id]
    );
    if (!existing) return res.status(404).json({ error: 'Workout not found.' });
    const name = str(req.body && req.body.name, 120) || existing.name;
    const exercises = req.body.exercises !== undefined ? sanitizeExercises(req.body.exercises) : parseJsonArray(existing.exercises_json);
    await runQuery(
      `UPDATE workout_plans
          SET name = ?, description = ?, day_of_week = ?, exercises_json = ?,
              is_active = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND tenant_id = ? AND member_id = ?`,
      [name,
       req.body.description !== undefined ? str(req.body.description, 500) : existing.description,
       req.body.day_of_week !== undefined ? str(req.body.day_of_week, 10) : existing.day_of_week,
       JSON.stringify(exercises),
       req.body.is_active !== undefined ? (req.body.is_active ? 1 : 0) : existing.is_active,
       req.params.id, req.tenant_id, req.member_id]
    );
    const row = await getQuery(`SELECT * FROM workout_plans WHERE id = ?`, [req.params.id]);
    res.json(planToClient(row));
  } catch (err) {
    console.error('Member workout update error:', err);
    res.status(500).json({ error: 'Failed to update workout.' });
  }
});

router.delete('/workouts/:id', requireLinked, async (req, res) => {
  try {
    const r = await runQuery(
      `DELETE FROM workout_plans WHERE id = ? AND tenant_id = ? AND member_id = ?`,
      [req.params.id, req.tenant_id, req.member_id]
    );
    if (!r || !r.changes) return res.status(404).json({ error: 'Workout not found.' });
    res.json({ message: 'Workout deleted.' });
  } catch (err) {
    console.error('Member workout delete error:', err);
    res.status(500).json({ error: 'Failed to delete workout.' });
  }
});

// ---- workout sessions (history) -----------------------------------------------
router.get('/sessions', requireLinked, async (req, res) => {
  try {
    const rows = await allQuery(
      `SELECT * FROM workout_sessions WHERE tenant_id = ? AND member_id = ?
        ORDER BY session_date DESC, created_at DESC LIMIT 300`,
      [req.tenant_id, req.member_id]
    );
    res.json(rows.map(r => {
      const out = Object.assign({}, r, { completed: parseJsonArray(r.completed_json) });
      delete out.completed_json;
      return out;
    }));
  } catch (err) {
    console.error('Member sessions error:', err);
    res.status(500).json({ error: 'Failed to load sessions.' });
  }
});

router.post('/sessions', requireLinked, async (req, res) => {
  try {
    const id = newId('ws');
    const completed = Array.isArray(req.body && req.body.completed)
      ? req.body.completed.slice(0, 100).map(c => str(c, 160)).filter(Boolean)
      : [];
    await runQuery(
      `INSERT INTO workout_sessions (id, tenant_id, member_id, plan_id, plan_name, session_date, duration_min, completed_json, total_volume_kg, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, req.tenant_id, req.member_id,
       str(req.body.plan_id, 60), str(req.body.plan_name, 120),
       dateStr(req.body.session_date) || getTodayString(),
       num(req.body.duration_min) || 0, JSON.stringify(completed),
       num(req.body.total_volume_kg) || 0, str(req.body.notes, 500)]
    );
    const row = await getQuery(`SELECT * FROM workout_sessions WHERE id = ?`, [id]);
    res.status(201).json(row);
  } catch (err) {
    console.error('Member session create error:', err);
    res.status(500).json({ error: 'Failed to log session.' });
  }
});

// ---- personal records ----------------------------------------------------------
router.get('/prs', requireLinked, async (req, res) => {
  try {
    const rows = await allQuery(
      `SELECT * FROM personal_records WHERE tenant_id = ? AND member_id = ?
        ORDER BY achieved_on DESC, created_at DESC`,
      [req.tenant_id, req.member_id]
    );
    res.json(rows);
  } catch (err) {
    console.error('Member PRs error:', err);
    res.status(500).json({ error: 'Failed to load personal records.' });
  }
});

router.post('/prs', requireLinked, async (req, res) => {
  try {
    const exercise = str(req.body && req.body.exercise, 120);
    const weight = num(req.body && req.body.weight_kg);
    if (!exercise || weight === null) return res.status(400).json({ error: 'Exercise and weight are required.' });
    const id = newId('pr');
    await runQuery(
      `INSERT INTO personal_records (id, tenant_id, member_id, exercise, weight_kg, reps, achieved_on)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, req.tenant_id, req.member_id, exercise, weight, num(req.body.reps) || 1, dateStr(req.body.achieved_on) || getTodayString()]
    );
    res.status(201).json(await getQuery(`SELECT * FROM personal_records WHERE id = ?`, [id]));
  } catch (err) {
    console.error('Member PR create error:', err);
    res.status(500).json({ error: 'Failed to save personal record.' });
  }
});

router.delete('/prs/:id', requireLinked, async (req, res) => {
  try {
    const r = await runQuery(
      `DELETE FROM personal_records WHERE id = ? AND tenant_id = ? AND member_id = ?`,
      [req.params.id, req.tenant_id, req.member_id]
    );
    if (!r || !r.changes) return res.status(404).json({ error: 'Record not found.' });
    res.json({ message: 'Record deleted.' });
  } catch (err) {
    console.error('Member PR delete error:', err);
    res.status(500).json({ error: 'Failed to delete record.' });
  }
});

// ---- health logs (manual only in U1) --------------------------------------------
router.get('/health', requireLinked, async (req, res) => {
  try {
    const logDate = dateStr(req.query.log_date) || getTodayString();
    const rows = await allQuery(
      `SELECT * FROM health_logs WHERE tenant_id = ? AND member_id = ? AND log_date = ?`,
      [req.tenant_id, req.member_id, logDate]
    );
    res.json(rows);
  } catch (err) {
    console.error('Member health error:', err);
    res.status(500).json({ error: 'Failed to load health logs.' });
  }
});

// Upsert by (tenant, member, log_date): offline replays and multi-taps of the
// same day's log converge to ONE row. Only fields present in the body change.
router.post('/health', requireLinked, async (req, res) => {
  try {
    const logDate = dateStr(req.body && req.body.log_date) || getTodayString();
    const id = newId('hl');
    await runQuery(
      `INSERT INTO health_logs (id, tenant_id, member_id, log_date, weight_kg, water_ml, calories, protein_g, notes, steps, sleep_minutes, heart_rate, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(tenant_id, member_id, log_date) DO UPDATE SET
         weight_kg     = COALESCE(excluded.weight_kg,     health_logs.weight_kg),
         water_ml      = COALESCE(excluded.water_ml,      health_logs.water_ml),
         calories      = COALESCE(excluded.calories,      health_logs.calories),
         protein_g     = COALESCE(excluded.protein_g,     health_logs.protein_g),
         notes         = COALESCE(excluded.notes,         health_logs.notes),
         steps         = COALESCE(excluded.steps,         health_logs.steps),
         sleep_minutes = COALESCE(excluded.sleep_minutes, health_logs.sleep_minutes),
         heart_rate    = COALESCE(excluded.heart_rate,    health_logs.heart_rate),
         updated_at = CURRENT_TIMESTAMP`,
      [id, req.tenant_id, req.member_id, logDate,
       num(req.body.weight_kg), num(req.body.water_ml), num(req.body.calories), num(req.body.protein_g), str(req.body.notes, 500),
       num(req.body.steps), num(req.body.sleep_minutes), num(req.body.heart_rate)]
    );
    const row = await getQuery(
      `SELECT * FROM health_logs WHERE tenant_id = ? AND member_id = ? AND log_date = ?`,
      [req.tenant_id, req.member_id, logDate]
    );
    res.status(201).json(row);
  } catch (err) {
    console.error('Member health upsert error:', err);
    res.status(500).json({ error: 'Failed to save health log.' });
  }
});

// Persist the Health Connect link flag server-side (source of truth mirrored by
// /overview). Set after a real native permission grant; cleared on unlink.
router.post('/health-connect', requireLinked, async (req, res) => {
  try {
    const b = req.body || {};
    const linked = (b.linked === true || b.linked === 1 || b.linked === '1' || b.linked === 'true') ? 1 : 0;
    await runQuery(
      `UPDATE members SET health_connect_linked = ? WHERE id = ? AND tenant_id = ?`,
      [linked, req.member_id, req.tenant_id]
    );
    res.json({ linked: !!linked });
  } catch (err) {
    console.error('Member Health Connect link error:', err);
    res.status(500).json({ error: 'Failed to update Health Connect link.' });
  }
});

// ---- body measurements ------------------------------------------------------------
router.get('/measurements', requireLinked, async (req, res) => {
  try {
    const rows = await allQuery(
      `SELECT * FROM body_measurements WHERE tenant_id = ? AND member_id = ?
        ORDER BY measured_on DESC, created_at DESC LIMIT 200`,
      [req.tenant_id, req.member_id]
    );
    res.json(rows);
  } catch (err) {
    console.error('Member measurements error:', err);
    res.status(500).json({ error: 'Failed to load measurements.' });
  }
});

router.post('/measurements', requireLinked, async (req, res) => {
  try {
    const id = newId('bm');
    await runQuery(
      `INSERT INTO body_measurements (id, tenant_id, member_id, measured_on, chest_cm, waist_cm, hips_cm, biceps_cm, thigh_cm, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, req.tenant_id, req.member_id, dateStr(req.body && req.body.measured_on) || getTodayString(),
       num(req.body.chest_cm), num(req.body.waist_cm), num(req.body.hips_cm),
       num(req.body.biceps_cm), num(req.body.thigh_cm), str(req.body.notes, 500)]
    );
    res.status(201).json(await getQuery(`SELECT * FROM body_measurements WHERE id = ?`, [id]));
  } catch (err) {
    console.error('Member measurement create error:', err);
    res.status(500).json({ error: 'Failed to save measurement.' });
  }
});

router.delete('/measurements/:id', requireLinked, async (req, res) => {
  try {
    const r = await runQuery(
      `DELETE FROM body_measurements WHERE id = ? AND tenant_id = ? AND member_id = ?`,
      [req.params.id, req.tenant_id, req.member_id]
    );
    if (!r || !r.changes) return res.status(404).json({ error: 'Measurement not found.' });
    res.json({ message: 'Measurement deleted.' });
  } catch (err) {
    console.error('Member measurement delete error:', err);
    res.status(500).json({ error: 'Failed to delete measurement.' });
  }
});

// ---- goals ---------------------------------------------------------------------
router.get('/goals', requireLinked, async (req, res) => {
  try {
    const rows = await allQuery(
      `SELECT * FROM member_goals WHERE tenant_id = ? AND member_id = ? ORDER BY created_at DESC`,
      [req.tenant_id, req.member_id]
    );
    res.json(rows);
  } catch (err) {
    console.error('Member goals error:', err);
    res.status(500).json({ error: 'Failed to load goals.' });
  }
});

router.post('/goals', requireLinked, async (req, res) => {
  try {
    const title = str(req.body && req.body.title, 160);
    if (!title) return res.status(400).json({ error: 'Goal title is required.' });
    const id = newId('gl');
    await runQuery(
      `INSERT INTO member_goals (id, tenant_id, member_id, title, target_value, status)
       VALUES (?, ?, ?, ?, ?, 'active')`,
      [id, req.tenant_id, req.member_id, title, str(req.body.target_value, 120)]
    );
    res.status(201).json(await getQuery(`SELECT * FROM member_goals WHERE id = ?`, [id]));
  } catch (err) {
    console.error('Member goal create error:', err);
    res.status(500).json({ error: 'Failed to create goal.' });
  }
});

router.put('/goals/:id', requireLinked, async (req, res) => {
  try {
    const existing = await getQuery(
      `SELECT * FROM member_goals WHERE id = ? AND tenant_id = ? AND member_id = ?`,
      [req.params.id, req.tenant_id, req.member_id]
    );
    if (!existing) return res.status(404).json({ error: 'Goal not found.' });
    const status = str(req.body && req.body.status, 20);
    await runQuery(
      `UPDATE member_goals SET title = ?, target_value = ?, status = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND tenant_id = ? AND member_id = ?`,
      [str(req.body.title, 160) || existing.title,
       req.body.target_value !== undefined ? str(req.body.target_value, 120) : existing.target_value,
       (status === 'active' || status === 'done' || status === 'archived') ? status : existing.status,
       req.params.id, req.tenant_id, req.member_id]
    );
    res.json(await getQuery(`SELECT * FROM member_goals WHERE id = ?`, [req.params.id]));
  } catch (err) {
    console.error('Member goal update error:', err);
    res.status(500).json({ error: 'Failed to update goal.' });
  }
});

router.delete('/goals/:id', requireLinked, async (req, res) => {
  try {
    const r = await runQuery(
      `DELETE FROM member_goals WHERE id = ? AND tenant_id = ? AND member_id = ?`,
      [req.params.id, req.tenant_id, req.member_id]
    );
    if (!r || !r.changes) return res.status(404).json({ error: 'Goal not found.' });
    res.json({ message: 'Goal deleted.' });
  } catch (err) {
    console.error('Member goal delete error:', err);
    res.status(500).json({ error: 'Failed to delete goal.' });
  }
});

// ---- nutrition / diet (meal ledger + AI photo scan) ----------------------------
// Meals are ONLINE-ONLY writes (unregistered in the offline route registry, so
// the shim passes them through — never faked). The daily calories/protein totals
// in health_logs remain the client's job: after each meal write it accumulates
// through the offline-first health repo, so Home/Progress stay consistent.
router.get('/nutrition', requireLinked, async (req, res) => {
  try {
    const logDate = dateStr(req.query.log_date) || getTodayString();
    const rows = await allQuery(
      `SELECT * FROM nutrition_logs WHERE tenant_id = ? AND member_id = ? AND log_date = ?
        ORDER BY created_at DESC`,
      [req.tenant_id, req.member_id, logDate]
    );
    res.json(rows);
  } catch (err) {
    console.error('Member nutrition list error:', err);
    res.status(500).json({ error: 'Failed to load meals.' });
  }
});

router.post('/nutrition', requireLinked, async (req, res) => {
  try {
    const b = req.body || {};
    const calories = num(b.calories);
    if (calories === null || calories < 0 || calories > 10000) {
      return res.status(400).json({ error: 'Calories must be between 0 and 10000.' });
    }
    const items = Array.isArray(b.items) ? b.items.slice(0, 12).map(i => ({
      name: str(i && i.name, 120) || 'Item',
      portion: str(i && i.portion, 80),
      calories: num(i && i.calories) || 0,
      protein_g: num(i && i.protein_g) || 0,
      carbs_g: num(i && i.carbs_g) || 0,
      fat_g: num(i && i.fat_g) || 0
    })) : [];
    const id = newId('nl');
    await runQuery(
      `INSERT INTO nutrition_logs (id, tenant_id, member_id, log_date, name, portion, calories, protein_g, carbs_g, fat_g, source, items_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, req.tenant_id, req.member_id,
       dateStr(b.log_date) || getTodayString(),
       str(b.name, 120) || 'Meal', str(b.portion, 80),
       Math.round(calories), num(b.protein_g) || 0, num(b.carbs_g) || 0, num(b.fat_g) || 0,
       b.source === 'photo' ? 'photo' : 'manual',
       items.length ? JSON.stringify(items) : null]
    );
    res.status(201).json(await getQuery(`SELECT * FROM nutrition_logs WHERE id = ?`, [id]));
  } catch (err) {
    console.error('Member nutrition create error:', err);
    res.status(500).json({ error: 'Failed to log meal.' });
  }
});

router.delete('/nutrition/:id', requireLinked, async (req, res) => {
  try {
    const r = await runQuery(
      `DELETE FROM nutrition_logs WHERE id = ? AND tenant_id = ? AND member_id = ?`,
      [req.params.id, req.tenant_id, req.member_id]
    );
    if (!r || !r.changes) return res.status(404).json({ error: 'Meal not found.' });
    res.json({ message: 'Meal deleted.' });
  } catch (err) {
    console.error('Member nutrition delete error:', err);
    res.status(500).json({ error: 'Failed to delete meal.' });
  }
});

// AI photo scan — proxies to Gemini via lib/nutritionAI (key stays server-side).
// ponytail: in-memory per-member daily scan cap; move to a DB counter if the app
// ever runs multi-instance.
const SCAN_CAP_PER_DAY = 25;
const scanCounts = new Map(); // member_id -> { day, count }
router.post('/nutrition/analyze', requireLinked, async (req, res) => {
  try {
    const today = getTodayString();
    const c = scanCounts.get(req.member_id);
    const count = (c && c.day === today) ? c.count : 0;
    if (count >= SCAN_CAP_PER_DAY) {
      return res.status(429).json({ error: `Daily scan limit reached (${SCAN_CAP_PER_DAY}/day) — log this one manually.` });
    }

    const raw = String((req.body && req.body.image) || '');
    // Accept a data URL ("data:image/jpeg;base64,....") or bare base64 + mime.
    let mime = str(req.body && req.body.mime, 30) || 'image/jpeg';
    let base64 = raw;
    const m = raw.match(/^data:([a-z/+.-]+);base64,(.+)$/i);
    if (m) { mime = m[1].toLowerCase(); base64 = m[2]; }
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(mime)) {
      return res.status(400).json({ error: 'Use a JPEG, PNG or WebP photo.' });
    }
    if (base64.length < 100 || base64.length > 6 * 1024 * 1024) {
      return res.status(400).json({ error: 'Photo is missing or too large.' });
    }

    const result = await require('../lib/nutritionAI').analyzeFoodImage(base64, mime);
    scanCounts.set(req.member_id, { day: today, count: count + 1 });
    res.json(result);
  } catch (err) {
    if (err && err.status) return res.status(err.status).json({ error: err.message });
    console.error('Member nutrition analyze error:', err);
    res.status(500).json({ error: 'Failed to analyze the photo.' });
  }
});

// Unknown /member/* paths end HERE with a clean 404 instead of falling through
// to the staff router (which would answer 403 and confuse the client).
router.use((req, res) => res.status(404).json({ error: 'Not found.' }));

module.exports = router;
