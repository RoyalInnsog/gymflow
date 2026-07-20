const express = require('express');
const router = express.Router();
const { getQuery, runQuery, allQuery } = require('../../database');
const { authorize, requireFeature, checkSubscription, getTaxConfig, computeTax, resolveRenewalDiscount, uid, nextInvoiceNumber } = require('../../lib/apiUtils');

// Temporary aliases for missing dependencies
const { PLANS, isRazorpayConfigured, createOrder, verifyPaymentSignature, fetchOrder, cancelSubscription } = require('../../lib/razorpay');
const { getTodayString, getLastNDaysString, getNextNDaysString } = require('../../lib/dateUtils');
const engine = require('../../lib/membershipEngine');
const whatsappCloud = require('../../services/whatsappCloud.service');
const waSettings = require('../../services/whatsappSettings');
const waAutomations = require('../../services/whatsappAutomations');
const { PLAN_LIMITS, PLAN_PRICES, PURCHASABLE_PLANS, resolvePlan, getPlan } = require('../../lib/billingPlans');
const billing = require('../../lib/billingState');

// ---------------------------------------------------------------------------
// Group: members
// ---------------------------------------------------------------------------

// ==========================================
// MEMBERS API
// ==========================================

// Get member roster
router.get('/members', async (req, res) => {
  const { status, search } = req.query;
  let sql = `
    SELECT m.*, ms.end_date, ms.start_date, p.name as plan_name, p.price as plan_price
    FROM members m
    LEFT JOIN (
      SELECT m1.member_id, m1.plan_id, m1.start_date, m1.end_date, m1.status
      FROM memberships m1
      JOIN (
        SELECT member_id, MAX(created_at) as max_created
        FROM memberships
        WHERE status = 'Active' OR status = 'Expired'
        GROUP BY member_id
      ) m2 ON m1.member_id = m2.member_id AND m1.created_at = m2.max_created
    ) ms ON m.id = ms.member_id
    LEFT JOIN membership_plans p ON ms.plan_id = p.id
    WHERE m.tenant_id = ?
  `;
  // [C1 FIX] Scope all member queries to the authenticated tenant
  const params = [req.tenant_id];

  const allowedStatuses = ['Active', 'Expired', 'Frozen'];
  if (status && allowedStatuses.includes(status)) {
    sql += ` AND m.status = ?`;
    params.push(status);
  }

  if (search) {
    const escapedSearch = escapeLike(search);
    sql += ` AND (m.full_name LIKE ? ESCAPE '\\' OR m.phone LIKE ? ESCAPE '\\' OR m.email LIKE ? ESCAPE '\\')`;
    params.push(`%${escapedSearch}%`, `%${escapedSearch}%`, `%${escapedSearch}%`);
  }

  try {
    const members = await allQuery(sql, params);
    const augmented = members.map((m) => {
      let daysLeft = 0;
      if (m.end_date) {
        daysLeft = engine.remainingDays(m.end_date, getTodayString());
        if (daysLeft < 0) daysLeft = 0;
      }
      return { ...m, daysLeft };
    });
    res.json(augmented);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database query error.' });
  }
});

// Get specific member profile details
router.get('/members/:id', async (req, res) => {
  try {
    // [C1 FIX] Scope member lookup to the authenticated tenant
    const member = await getQuery(`SELECT * FROM members WHERE id = ? AND tenant_id = ?`, [req.params.id, req.tenant_id]);
    if (!member) {
      return res.status(404).json({ error: 'Member not found.' });
    }

    // Get current active or latest membership
    const membership = await getQuery(`
      SELECT m.*, p.name as plan_name, p.price, p.duration_months 
      FROM memberships m 
      LEFT JOIN membership_plans p ON m.plan_id = p.id 
      WHERE m.member_id = ?
       AND m.tenant_id = ? ORDER BY m.created_at DESC LIMIT 1
    `, [member.id, req.tenant_id]);

    // Build database-driven timeline
    const dbTimeline = [];
    const gymNameRow = await getQuery(`SELECT setting_value FROM settings WHERE setting_key = 'gym_name' AND tenant_id = ?`, [req.tenant_id]);
    const gymName = gymNameRow ? gymNameRow.setting_value : 'Gym Flow';

    // 1. Joined event
    dbTimeline.push({
      date: member.created_at ? member.created_at.split(' ')[0] : 'N/A',
      type: 'System',
      title: 'Joined',
      details: `Profile created for ${member.full_name}. Welcome to ${gymName}!`
    });

    // 2. Attendance history
    const attEvents = await allQuery(`SELECT check_in, check_out FROM attendance WHERE member_id = ?  AND tenant_id = ? ORDER BY check_in DESC`, [member.id, req.tenant_id]);
    attEvents.forEach((a) => {
      const checkInDate = a.check_in ? a.check_in.split(' ')[0] : 'N/A';
      dbTimeline.push({
        date: checkInDate,
        type: 'Attendance',
        title: 'Gym Workout Session',
        details: `Checked in at ${a.check_in}.${a.check_out ? ' Checked out at ' + a.check_out + '.' : ' Completed workout.'}`
      });
    });

    // 3. Membership activations/renewals
    const msEvents = await allQuery(`SELECT m.created_at, m.start_date, m.end_date, m.renewal_count, p.name 
       FROM memberships m 
       JOIN membership_plans p ON m.plan_id = p.id 
       WHERE m.member_id = ?  AND m.tenant_id = ? ORDER BY m.created_at DESC`, [member.id, req.tenant_id]);
    msEvents.forEach((m) => {
      const dateStr = m.created_at ? m.created_at.split(' ')[0] : 'N/A';
      dbTimeline.push({
        date: dateStr,
        type: 'Membership',
        title: m.renewal_count > 0 ? 'Membership Renewed' : 'Membership Plan Activated',
        details: `Plan: ${m.name}. Duration: ${m.start_date} to ${m.end_date}.`
      });
    });

    // 4. Payments
    const payEvents = await allQuery(`SELECT p.created_at, p.amount, p.method, p.transaction_reference, i.invoice_number 
       FROM payments p 
       LEFT JOIN invoices i ON p.invoice_id = i.id 
       WHERE p.member_id = ?  AND p.tenant_id = ? ORDER BY p.created_at DESC`, [member.id, req.tenant_id]);
    payEvents.forEach((p) => {
      const dateStr = p.created_at ? p.created_at.split(' ')[0] : 'N/A';
      dbTimeline.push({
        date: dateStr,
        type: 'Payment',
        title: 'Payment Received',
        details: `Amount: ₹${Number(p.amount).toLocaleString()}. Paid via ${p.method} (Invoice #${p.invoice_number || 'N/A'}, Txn: ${p.transaction_reference || 'N/A'}).`
      });
    });

    // 5. Retention Events
    const retEvents = await allQuery(`SELECT created_at, risk_level, contact_channel, notes, outcome 
       FROM retention_events WHERE member_id = ?  AND tenant_id = ? ORDER BY created_at DESC`, [member.id, req.tenant_id]);
    retEvents.forEach((r) => {
      const dateStr = r.created_at ? r.created_at.split(' ')[0] : 'N/A';
      dbTimeline.push({
        date: dateStr,
        type: 'Retention',
        title: 'Retention Contact Logs',
        details: `Risk Level: ${r.risk_level}. Channel: ${r.contact_channel}. Outcome: ${r.outcome}. Notes: ${r.notes}`
      });
    });

    // 6. Communications (Notifications)
    const commEvents = await allQuery(`
      SELECT created_at, title, message 
      FROM notifications 
      WHERE (recipient_name = ? OR message LIKE ? OR message LIKE ?)
       AND tenant_id = ? ORDER BY created_at DESC
    `, [member.full_name, `%${member.full_name}%`, `%${member.id}%`, req.tenant_id]);
    commEvents.forEach((c) => {
      const dateStr = c.created_at ? c.created_at.split(' ')[0] : 'N/A';
      dbTimeline.push({
        date: dateStr,
        type: 'Communication',
        title: c.title,
        details: c.message
      });
    });

    // Sort timeline descending by date
    dbTimeline.sort((a, b) => new Date(b.date) - new Date(a.date));

    // Limit to recent 30 events for performance
    const timeline = dbTimeline.slice(0, 30);

    // Get communication logs
    const communications = commEvents;

    res.json({ member, membership, timeline, communications });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database query error.' });
  }
});

// Create member
router.post('/members', async (req, res) => {
  const plan = req.subscription.subscription_plan || 'trial';
  const limits = PLAN_LIMITS[plan];
  
  try {
    const memberCountRow = await getQuery("SELECT COUNT(*) as count FROM members WHERE tenant_id = ?", [req.tenant_id]);
    const currentMembers = memberCountRow.count || 0;
    if (currentMembers >= limits.maxMembers) {
      return res.status(403).json({
        error: `Member limit reached. Your plan (${plan.toUpperCase()}) allows a maximum of ${limits.maxMembers} members. Please upgrade in settings.`
      });
    }
  } catch (err) {
    return res.status(500).json({ error: 'Failed to verify member plan limits.' });
  }
  const { full_name, phone, email, dob, gender, emergency_contact_name, emergency_contact_phone, height_cm, weight_kg, bmi, plan_id, start_date, end_date, photo_url } = req.body;

  if (!full_name || !phone) {
    return res.status(400).json({ error: 'Name and Phone Number are required.' });
  }

  // Duplicate member protection (per-tenant, scoped to req.tenant_id)
  // Phone is always checked (required). Email only when not empty.
  const normalizedPhone = String(phone).trim();
  const trimmedEmail = (email == null) ? '' : String(email).trim();
  if (!normalizedPhone) {
    return res.status(400).json({ error: 'Phone Number is required.' });
  }
  const existingPhone = await getQuery(
    `SELECT id, full_name FROM members WHERE tenant_id = ? AND phone = ? LIMIT 1`,
    [req.tenant_id, normalizedPhone]
  );
  if (existingPhone) {
    return res.status(400).json({
      error: `A member with phone "${normalizedPhone}" already exists (ID: ${existingPhone.id}, Name: ${existingPhone.full_name}).`
    });
  }
  if (trimmedEmail) {
    const existingEmail = await getQuery(
      `SELECT id, full_name FROM members WHERE tenant_id = ? AND email = ? LIMIT 1`,
      [req.tenant_id, trimmedEmail]
    );
    if (existingEmail) {
      return res.status(400).json({
        error: `A member with email "${trimmedEmail}" already exists (ID: ${existingEmail.id}, Name: ${existingEmail.full_name}).`
      });
    }
  }

  // Server-side date validation (runs even if client skips it)
  if (start_date && !/^\d{4}-\d{2}-\d{2}$/.test(start_date)) {
    return res.status(400).json({ error: 'start_date must be in YYYY-MM-DD format.' });
  }
  if (end_date && !/^\d{4}-\d{2}-\d{2}$/.test(end_date)) {
    return res.status(400).json({ error: 'end_date must be in YYYY-MM-DD format.' });
  }
  if (start_date && end_date) {
    const startTs = new Date(start_date).getTime();
    const endTs   = new Date(end_date).getTime();
    if (isNaN(startTs) || isNaN(endTs)) {
      return res.status(400).json({ error: 'One or both membership dates are invalid.' });
    }
    // [M5] Allow a same-day (1-day) pass (start == end); only reject end BEFORE start.
    if (startTs > endTs) {
      return res.status(400).json({ error: 'end_date cannot be before start_date.' });
    }
    // [H5] Reject absurd durations (e.g. end_date 9999-12-31). Cap at 5 years so a
    // forged far-future date can't create an effectively permanent membership.
    const MAX_DURATION_MS = 5 * 366 * 24 * 60 * 60 * 1000;
    if (endTs - startTs > MAX_DURATION_MS) {
      return res.status(400).json({ error: 'Membership duration cannot exceed 5 years.' });
    }
  }

  if (!plan_id) {
    return res.status(400).json({ error: 'Membership plan selection is required.' });
  }

  // [M4] collision-safe id (bare Date.now() collided on concurrent inserts).
  const id = uid('m');
  
  try {
    await runQuery('BEGIN TRANSACTION');

    await runQuery(`
      INSERT INTO members (id, tenant_id, full_name, phone, email, dob, gender, photo_url, emergency_contact_name, emergency_contact_phone, height_cm, weight_kg, bmi, status, onboarding_step)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Active', 6)
    `, [id, req.tenant_id, full_name, normalizedPhone, trimmedEmail || null, dob, gender, (photo_url || null), emergency_contact_name, emergency_contact_phone, height_cm, weight_kg, bmi]);

    const plan = await getQuery(`SELECT * FROM membership_plans WHERE id = ? AND tenant_id = ? `, [plan_id, req.tenant_id]);
    if (!plan) {
      throw new Error('Invalid membership plan selected.');
    }

    const msId = uid('ms_');

    // Use provided dates or calculate from plan duration (via the shared
    // MembershipEngine — pure calendar-day math, no UTC/local mixing).
    let membershipStart = start_date;
    let membershipEnd = end_date;

    if (!membershipStart) {
      membershipStart = getTodayString();
    }

    if (!membershipEnd) {
      membershipEnd = engine.computeEndDate(membershipStart, plan);
    }

    await runQuery(`
      INSERT INTO memberships (id, tenant_id, member_id, plan_id, start_date, end_date, status)
      VALUES (?, ?, ?, ?, ?, ?, 'Active')
    `, [msId, req.tenant_id, id, plan_id, membershipStart, membershipEnd]);
    
    // Create invoice for membership
    const invoiceId = uid('inv_');
    const invoiceNumber = await nextInvoiceNumber(req.tenant_id, 'INV');
    const subtotal = plan.price || 0;
    const taxCfg = await getTaxConfig(req.tenant_id);
    const taxAmount = computeTax(subtotal, taxCfg);
    const totalAmount = subtotal + taxAmount;
    
    await runQuery(`
      INSERT INTO invoices (id, tenant_id, member_id, membership_id, invoice_number, subtotal, tax_amount, total_amount, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Unpaid')
    `, [invoiceId, req.tenant_id, id, msId, invoiceNumber, subtotal, taxAmount, totalAmount]);

    // Log activity
    await logActivity(req.user?.id || 'u1', req.tenant_id, 'CREATE', 'members', id, { full_name, phone });

    await runQuery('COMMIT');

    // [WHATSAPP-CLOUD] New Member Onboarding: welcome message + invoice PDF.
    // Fire-and-forget so it never delays or fails the member-creation response;
    // the worker itself is a no-op unless the gym enabled the welcome_invoice
    // toggle in gym_whatsapp_settings.
    waAutomations.sendWelcomeInvoice(req.tenant_id, { memberId: id })
      .catch((e) => console.error('[whatsapp-cloud] welcome-invoice failed:', e && e.message));

    res.status(201).json({ message: 'Member created successfully.', memberId: id });
  } catch (err) {
    await runQuery('ROLLBACK');
    console.error(err);
    // Database-level unique constraint backstop (in case two requests race past the
    // application check above). Translate the SQLITE_CONSTRAINT into HTTP 400.
    if (err && err.code === 'SQLITE_CONSTRAINT' && /idx_unique_(phone|email)_per_tenant/i.test(err.message || '')) {
      const field = /email/i.test(err.message) ? 'email' : 'phone';
      return res.status(400).json({
        error: `A member with this ${field} already exists for your gym.`
      });
    }
    // [SEC] Do not echo raw err.message (could expose SQL/internal detail). The
    // known validation/constraint cases are handled above with clean messages.
    res.status(500).json({ error: 'Failed to create member.' });
  }
});

// Update member profile
router.put('/members/:id', async (req, res) => {
  const { full_name, phone, email, dob, gender, emergency_contact_name, emergency_contact_phone, height_cm, weight_kg, bmi, status } = req.body;
  const memberId = req.params.id;

  if (!full_name || !phone) {
    return res.status(400).json({ error: 'Name and Phone Number are required.' });
  }

  // Duplicate member protection (per-tenant) — exclude the member being updated.
  const normalizedPhone = String(phone).trim();
  const trimmedEmail = (email == null) ? '' : String(email).trim();
  if (!normalizedPhone) {
    return res.status(400).json({ error: 'Phone Number is required.' });
  }
  const dupPhone = await getQuery(
    `SELECT id, full_name FROM members WHERE tenant_id = ? AND phone = ? AND id != ? LIMIT 1`,
    [req.tenant_id, normalizedPhone, memberId]
  );
  if (dupPhone) {
    return res.status(400).json({
      error: `A member with phone "${normalizedPhone}" already exists (ID: ${dupPhone.id}, Name: ${dupPhone.full_name}).`
    });
  }
  if (trimmedEmail) {
    const dupEmail = await getQuery(
      `SELECT id, full_name FROM members WHERE tenant_id = ? AND email = ? AND id != ? LIMIT 1`,
      [req.tenant_id, trimmedEmail, memberId]
    );
    if (dupEmail) {
      return res.status(400).json({
        error: `A member with email "${trimmedEmail}" already exists (ID: ${dupEmail.id}, Name: ${dupEmail.full_name}).`
      });
    }
  }

  try {
    // [C2 FIX] Scope update to the authenticated tenant to prevent cross-tenant overwrites
    const result = await runQuery(`
      UPDATE members
      SET full_name = ?, phone = ?, email = ?, dob = ?, gender = ?,
          emergency_contact_name = ?, emergency_contact_phone = ?,
          height_cm = ?, weight_kg = ?, bmi = ?, status = ?
      WHERE id = ? AND tenant_id = ?
    `, [full_name, normalizedPhone, trimmedEmail || null, dob, gender, emergency_contact_name, emergency_contact_phone, height_cm, weight_kg, bmi, status || 'Active', memberId, req.tenant_id]);

    if (result.changes === 0) {
      return res.status(404).json({ error: 'Member not found or access denied.' });
    }

    res.json({ message: 'Member profile updated successfully.' });
  } catch (err) {
    console.error(err);
    if (err && err.code === 'SQLITE_CONSTRAINT' && /idx_unique_(phone|email)_per_tenant/i.test(err.message || '')) {
      const field = /email/i.test(err.message) ? 'email' : 'phone';
      return res.status(400).json({
        error: `A member with this ${field} already exists for your gym.`
      });
    }
    res.status(500).json({ error: 'Failed to update member profile.' });
  }
});

// Delete member and associated records
router.delete('/members/:id', authorize('members:write'), async (req, res) => {
  const memberId = req.params.id;
  try {
    // [C3 FIX] Verify the member belongs to the authenticated tenant before deleting anything.
    // This prevents cross-tenant data destruction via a crafted DELETE request.
    const member = await getQuery(
      `SELECT id FROM members WHERE id = ? AND tenant_id = ?`,
      [memberId, req.tenant_id]
    );
    if (!member) {
      return res.status(404).json({ error: 'Member not found or access denied.' });
    }

    await runQuery(`DELETE FROM attendance WHERE member_id = ? AND tenant_id = ? `, [memberId, req.tenant_id]);
    await runQuery(`DELETE FROM payments WHERE member_id = ? AND tenant_id = ? `, [memberId, req.tenant_id]);
    await runQuery(`DELETE FROM invoices WHERE member_id = ? AND tenant_id = ? `, [memberId, req.tenant_id]);
    await runQuery(`DELETE FROM memberships WHERE member_id = ? AND tenant_id = ? `, [memberId, req.tenant_id]);
    await runQuery(`DELETE FROM retention_events WHERE member_id = ? AND tenant_id = ? `, [memberId, req.tenant_id]);
    await runQuery(`DELETE FROM members WHERE id = ? AND tenant_id = ?`, [memberId, req.tenant_id]);

    res.json({ message: 'Member and all associated records deleted successfully.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to delete member.' });
  }
});

// ==========================================
// ATTENDANCE API
// ==========================================

// Get summary
router.get('/attendance/summary', async (req, res) => {
  try {
    // [H2 FIX] Use getQuery (single row) and bind the date — allQuery returns an
    // array, so reading presentResult.count off it was always undefined ("present" stuck at 0).
    const presentResult = await getQuery(`
      SELECT COUNT(DISTINCT member_id) as count
      FROM attendance
      WHERE date(check_in) = ? AND tenant_id = ?`, [getTodayString(), req.tenant_id]);
    const totalResult = await getQuery(`SELECT COUNT(*) as count FROM members WHERE status = 'Active' AND tenant_id = ? `, [req.tenant_id]);

    const total = totalResult.count || 0;
    const present = Math.min(presentResult.count || 0, total);
    const capPercent = total > 0 ? Math.min(Math.round(present / total * 100), 100) : 0;

    res.json({
      present: present,
      total: total,
      capacityPercent: capPercent
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database query error.' });
  }
});

// Get logs
router.get('/attendance/logs', async (req, res) => {
  try {
    // [FIX] allQuery — this returns a list of recent check-ins; getQuery would
    // have returned only the single most-recent row.
    const logs = await allQuery(`
      SELECT a.*, m.full_name, m.photo_url
      FROM attendance a
      JOIN members m ON a.member_id = m.id
       WHERE a.tenant_id = ? ORDER BY a.check_in DESC LIMIT 15
    `, [req.tenant_id]);
    res.json(logs);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database query error.' });
  }
});

// Log check-in
router.post('/attendance/check-in', billing.verifySubscriptionBilling('allowAttendance', 'Attendance tracking'), async (req, res) => {
  const { phone, member_id } = req.body;
  let member;

  try {
    if (phone) {
      // [FIX] getQuery — phone lookup must yield a single member object; allQuery
      // returned an array, so member.status/.id/.full_name were all undefined.
      member = await getQuery(`SELECT * FROM members WHERE phone = ? AND tenant_id = ? `, [phone, req.tenant_id]);
    } else if (member_id) {
      member = await getQuery(`SELECT * FROM members WHERE id = ? AND tenant_id = ? `, [member_id, req.tenant_id]);
    }

    if (!member) {
      return res.status(404).json({ error: 'Member not found or unauthorized.' });
    }

    if (member.status === 'Expired') {
      return res.status(403).json({ error: 'Access card restricted. Membership has expired.' });
    }

    const checkInId = 'a' + Date.now();
    await runQuery(`
      INSERT INTO attendance (id, tenant_id, member_id, check_in, access_method)
      VALUES (?, ?, ?, datetime('now', 'localtime'), 'Manual')
    `, [checkInId, req.tenant_id, member.id]);

    res.json({ message: `Access granted. Welcome, ${member.full_name}.`, member });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Check-in validation failure.' });
  }
});

// Read the tenant's geofence configuration.
router.get('/attendance/geofence', async (req, res) => {
  try {
    const t = await getQuery(
      `SELECT latitude, longitude, geofence_radius, geofence_enabled, geofence_unit
         FROM tenants WHERE id = ?`, [req.tenant_id]);
    if (!t) return res.status(404).json({ error: 'Tenant not found.' });
    const unit = t.geofence_unit === 'ft' ? 'ft' : 'm';
    const radiusM = toNumeric(t.geofence_radius, 50);
    res.json({
      enabled: !!t.geofence_enabled,
      latitude: t.latitude != null ? Number(t.latitude) : null,
      longitude: t.longitude != null ? Number(t.longitude) : null,
      radiusMeters: radiusM,
      unit,
      // Convenience: radius already expressed in the admin's chosen unit.
      radiusDisplay: unit === 'ft' ? Math.round(radiusM * FEET_PER_METER) : Math.round(radiusM)
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load geofence configuration.' });
  }
});

// Save the tenant's geofence configuration (owner / attendance-managers only).
router.post('/attendance/geofence', authorize('attendance:write'), billing.verifySubscriptionBilling('allowGPS', 'GPS geofencing'), async (req, res) => {
  try {
    const { latitude, longitude } = req.body;
    const enabled = req.body.enabled ? 1 : 0;
    const unit = whitelist(req.body.unit, ['m', 'ft'], 'm');

    const lat = toNumeric(latitude, NaN);
    const lon = toNumeric(longitude, NaN);
    if (!inLatRange(lat) || !inLonRange(lon)) {
      return res.status(400).json({ error: 'Valid latitude (-90..90) and longitude (-180..180) are required.' });
    }

    // Radius is submitted in the chosen unit; persist canonically in metres.
    const radiusInput = toNumeric(req.body.radius, NaN);
    if (!isFiniteNum(radiusInput) || radiusInput <= 0) {
      return res.status(400).json({ error: 'Radius must be a positive number.' });
    }
    let radiusMeters = unit === 'ft' ? radiusInput / FEET_PER_METER : radiusInput;
    // Clamp to a sane band (5 m .. 5 km) to stop absurd or accidental values.
    radiusMeters = Math.min(Math.max(radiusMeters, 5), 5000);

    await runQuery(
      `UPDATE tenants
          SET latitude = ?, longitude = ?, geofence_radius = ?, geofence_enabled = ?, geofence_unit = ?
        WHERE id = ?`,
      [lat, lon, radiusMeters, enabled, unit, req.tenant_id]);

    res.json({
      message: 'Geofence configuration saved.',
      enabled: !!enabled, latitude: lat, longitude: lon,
      radiusMeters: Math.round(radiusMeters), unit,
      radiusDisplay: unit === 'ft' ? Math.round(radiusMeters * FEET_PER_METER) : Math.round(radiusMeters)
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save geofence configuration.' });
  }
});

// Automated geofenced check-in. The client posts RAW coordinates only; the
// server resolves the member, recomputes distance with Haversine and records
// attendance only when genuinely within the perimeter. Idempotent per day.
router.post('/attendance/geo-check-in', billing.verifySubscriptionBilling('allowGPS', 'GPS check-in'), async (req, res) => {
  try {
    const { phone, member_id, latitude, longitude, accuracy } = req.body;

    const lat = toNumeric(latitude, NaN);
    const lon = toNumeric(longitude, NaN);
    if (!inLatRange(lat) || !inLonRange(lon)) {
      return res.status(400).json({ error: 'Valid device coordinates are required.' });
    }

    const t = await getQuery(
      `SELECT latitude, longitude, geofence_radius, geofence_enabled
         FROM tenants WHERE id = ?`, [req.tenant_id]);
    if (!t) return res.status(404).json({ error: 'Tenant not found.' });
    if (!t.geofence_enabled) {
      return res.status(409).json({ error: 'Geofenced check-in is not enabled for this gym.' });
    }
    if (!inLatRange(Number(t.latitude)) || !inLonRange(Number(t.longitude))) {
      return res.status(409).json({ error: 'Gym location is not configured yet.' });
    }

    // Resolve member (same rules as manual check-in).
    let member = null;
    if (phone) {
      member = await getQuery(`SELECT * FROM members WHERE phone = ? AND tenant_id = ?`, [phone, req.tenant_id]);
    } else if (member_id) {
      member = await getQuery(`SELECT * FROM members WHERE id = ? AND tenant_id = ?`, [member_id, req.tenant_id]);
    }
    if (!member) return res.status(404).json({ error: 'Member not found or unauthorized.' });
    if (member.status === 'Expired') {
      return res.status(403).json({ error: 'Access card restricted. Membership has expired.' });
    }

    // ── Anti-spoof core: server computes distance from raw coordinates. Any
    //    client-side "inside" flag is intentionally never read.
    const radiusMeters = toNumeric(t.geofence_radius, 50);
    const distance = haversineMeters(Number(t.latitude), Number(t.longitude), lat, lon);
    // Allow the reported GPS accuracy as slack (capped) so a legitimate member
    // at the edge with a weak fix isn't wrongly rejected, without opening a
    // large spoof window.
    const slack = Math.min(Math.max(toNumeric(accuracy, 0), 0), 50);
    const within = distance <= (radiusMeters + slack);

    if (!within) {
      return res.status(422).json({
        error: 'You are outside the gym check-in zone.',
        distanceMeters: Math.round(distance),
        radiusMeters: Math.round(radiusMeters),
        within: false
      });
    }

    // Idempotent: one geofence check-in per member per day.
    const existing = await getQuery(
      `SELECT id FROM attendance
        WHERE member_id = ? AND tenant_id = ? AND date(check_in) = ?`,
      [member.id, req.tenant_id, getTodayString()]);
    if (existing) {
      return res.json({
        message: `Already checked in today, ${member.full_name}.`,
        within: true, duplicate: true, distanceMeters: Math.round(distance)
      });
    }

    const checkInId = 'a' + Date.now();
    await runQuery(
      `INSERT INTO attendance (id, tenant_id, member_id, check_in, access_method)
       VALUES (?, ?, ?, datetime('now', 'localtime'), 'Geofence')`,
      [checkInId, req.tenant_id, member.id]);

    res.json({
      message: `Auto check-in confirmed. Welcome, ${member.full_name}.`,
      within: true, duplicate: false,
      distanceMeters: Math.round(distance), radiusMeters: Math.round(radiusMeters),
      member: { id: member.id, full_name: member.full_name }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Geofenced check-in failure.' });
  }
});

// ==========================================
// MEMBERSHIP RENEWALS API
// ==========================================
router.post('/memberships/renew', authorize('payments:write'), async (req, res) => {
  const { member_id, plan_id, discount_amount, payment_method } = req.body;

  if (!member_id || !plan_id) {
    return res.status(400).json({ error: 'Member ID and Plan ID are required for renewal.' });
  }

  try {
    const member = await getQuery(`SELECT * FROM members WHERE id = ? AND tenant_id = ? `, [member_id, req.tenant_id]);
    const plan = await getQuery(`SELECT * FROM membership_plans WHERE id = ? AND tenant_id = ? `, [plan_id, req.tenant_id]);

    if (!member || !plan) {
      return res.status(404).json({ error: 'Member or Plan not found.' });
    }

    // Determine start/end using the shared MembershipEngine (pure calendar-day
    // math — chains onto the active membership's end date, or starts today if
    // lapsed; honours day-based plans, e.g. 7-day trials, as well as month-based).
    const currentMs = await getQuery(`SELECT end_date FROM memberships WHERE member_id = ? AND tenant_id = ? AND status = 'Active' ORDER BY end_date DESC LIMIT 1`, [member_id, req.tenant_id]);
    const startStr = engine.nextRenewalStart(currentMs && currentMs.end_date, getTodayString());
    const endStr = engine.computeEndDate(startStr, plan);

    // [SEC] Discount is SERVER-AUTHORITATIVE: recomputed from the tenant's enabled
    // discount_rules (the 'loyalty' rule), NEVER trusted from the client body. The
    // old code clamped a client-supplied `discount_amount` to [0, price], which still
    // let a crafted request apply the full price as a discount and renew for free.
    // `discount_amount` from the body is now ignored.
    const discount = await resolveRenewalDiscount(req.tenant_id, plan.price || 0);
    const subtotal = Math.max(0, (plan.price || 0) - discount);
    const taxCfg = await getTaxConfig(req.tenant_id);
    const taxAmount = computeTax(subtotal, taxCfg);
    const totalAmount = subtotal + taxAmount;

    // [M2 FIX] renewal_count is the number of prior memberships this member has,
    // not a hard-coded 1.
    const priorMs = await getQuery(
      `SELECT COUNT(*) as c FROM memberships WHERE member_id = ? AND tenant_id = ?`,
      [member_id, req.tenant_id]);
    const renewalCount = (priorMs && priorMs.c) || 0;

    // [M4 FIX] collision-safe ids + monotonic per-tenant receipt number.
    const msId = uid('ms_');
    const invoiceId = uid('inv_');
    const paymentId = uid('pay_');
    const invoiceNum = await nextInvoiceNumber(req.tenant_id, 'RCPT');

    const isOnline = (payment_method === 'Card');
    const initialStatus = isOnline ? 'Pending' : 'Active';
    const initialInvStatus = isOnline ? 'Unpaid' : 'Paid';
    const initialPayStatus = isOnline ? 'Pending' : 'Successful';

    // 1. Create Membership (Pending or Active)
    await runQuery(`
      INSERT INTO memberships (id, tenant_id, member_id, plan_id, start_date, end_date, status, renewal_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [msId, req.tenant_id, member_id, plan_id, startStr, endStr, initialStatus, renewalCount]);

    // 2. Create Invoice (Unpaid or Paid)
    await runQuery(`
      INSERT INTO invoices (id, tenant_id, member_id, membership_id, invoice_number, subtotal, tax_amount, total_amount, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [invoiceId, req.tenant_id, member_id, msId, invoiceNum, subtotal, taxAmount, totalAmount, initialInvStatus]);

    if (isOnline) {
      const order = await createOrder(totalAmount, invoiceNum);
      await runQuery(`
        INSERT INTO payments (id, tenant_id, invoice_id, member_id, amount, method, status)
        VALUES (?, ?, ?, ?, ?, ?, 'Pending')
      `, [paymentId, req.tenant_id, invoiceId, member_id, totalAmount, payment_method]);

      return res.status(201).json({
        message: 'Order created. Complete checkout.',
        orderId: order.id,
        paymentId: paymentId,
        invoiceNumber: invoiceNum,
        totalAmount,
        currency: order.currency,
        key_id: process.env.RAZORPAY_KEY_ID
      });
    } else {
      const txnRef = (payment_method || 'Cash').toUpperCase() + '/' + Date.now();
      await runQuery(`
        INSERT INTO payments (id, tenant_id, invoice_id, member_id, amount, method, transaction_reference, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'Successful')
      `, [paymentId, req.tenant_id, invoiceId, member_id, totalAmount, payment_method || 'Cash', txnRef]);

      await runQuery(`UPDATE members SET status = 'Active' WHERE id = ? AND tenant_id = ? `, [member_id, req.tenant_id]);

      return res.status(201).json({
        message: `Membership renewed successfully (${payment_method || 'Cash'}).`,
        invoiceNumber: invoiceNum,
        totalAmount
      });
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Renewal processing failure.' });
  }
});

router.post('/memberships/renew/verify', authorize('payments:write'), async (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature, payment_id } = req.body;
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature || !payment_id) {
    return res.status(400).json({ error: 'Missing signature.' });
  }

  try {
    const verified = verifyPaymentSignature(razorpay_order_id, razorpay_payment_id, razorpay_signature);
    if (!verified) {
      await runQuery(`UPDATE payments SET status = 'Failed' WHERE id = ? AND tenant_id = ?`, [payment_id, req.tenant_id]);
      return res.status(400).json({ error: 'Invalid signature.' });
    }

    const payment = await getQuery(`SELECT * FROM payments WHERE id = ? AND status = 'Pending' AND tenant_id = ?`, [payment_id, req.tenant_id]);
    if (!payment) return res.status(400).json({ error: 'Payment not found or already processed.' });

    await runQuery(`UPDATE payments SET status = 'Successful', transaction_reference = ? WHERE id = ? AND tenant_id = ?`, [razorpay_payment_id, payment_id, req.tenant_id]);
    
    const invoice = await getQuery(`SELECT * FROM invoices WHERE id = ? AND tenant_id = ?`, [payment.invoice_id, req.tenant_id]);
    if (invoice) {
      await runQuery(`UPDATE invoices SET status = 'Paid' WHERE id = ? AND tenant_id = ?`, [invoice.id, req.tenant_id]);
      if (invoice.membership_id) {
        await runQuery(`UPDATE memberships SET status = 'Active' WHERE id = ? AND tenant_id = ?`, [invoice.membership_id, req.tenant_id]);
        await runQuery(`UPDATE members SET status = 'Active' WHERE id = ? AND tenant_id = ?`, [invoice.member_id, req.tenant_id]);
      }
    }
    
    res.json({ success: true, message: 'Payment verified successfully.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Verification failed.' });
  }
});

// Extend an existing membership's end date by a number of months and/or days
// (e.g. goodwill extension, freeze compensation) without going through the
// full renewal/payment flow.
router.post('/memberships/:id/extend', authorize('payments:write'), async (req, res) => {
  const { id } = req.params;
  const daysRaw = req.body && req.body.days;
  const monthsRaw = req.body && req.body.months;

  const days = daysRaw === undefined || daysRaw === null || daysRaw === '' ? 0 : Number(daysRaw);
  const months = monthsRaw === undefined || monthsRaw === null || monthsRaw === '' ? 0 : Number(monthsRaw);

  if (!Number.isInteger(days) || !Number.isInteger(months) ||
      days < 0 || days > 366 || months < 0 || months > 24 ||
      (days === 0 && months === 0)) {
    return res.status(400).json({ error: 'Provide integer days (0-366) and/or months (0-24), with at least one greater than 0.' });
  }

  try {
    const ms = await getQuery(`SELECT * FROM memberships WHERE id = ? AND tenant_id = ? `, [id, req.tenant_id]);
    if (!ms) {
      return res.status(404).json({ error: 'Membership not found.' });
    }

    const newEnd = engine.extendEnd(ms.end_date, { months, days });
    await runQuery(`UPDATE memberships SET end_date = ? WHERE id = ? AND tenant_id = ? `, [newEnd, id, req.tenant_id]);

    const remaining = engine.remainingDays(newEnd, getTodayString());
    if (ms.status === 'Expired' && remaining >= 0) {
      await runQuery(`UPDATE memberships SET status = 'Active' WHERE id = ? AND tenant_id = ? `, [id, req.tenant_id]);
      await runQuery(`UPDATE members SET status = 'Active' WHERE id = ? AND tenant_id = ? `, [ms.member_id, req.tenant_id]);
    }

    await logActivity(req.user?.id || 'u1', req.tenant_id, 'UPDATE', 'memberships', id, { extended_days: days, extended_months: months });

    res.json({ message: 'Membership extended successfully.', end_date: newEnd, remaining_days: remaining });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to extend membership.' });
  }
});

module.exports = router;
