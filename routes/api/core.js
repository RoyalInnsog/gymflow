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
// Group: core
// ---------------------------------------------------------------------------

// ==========================================
// ONBOARDING API
// ==========================================

router.post('/onboarding/complete-tour', async (req, res) => {
  try {
    await runQuery("UPDATE tenants SET tour_completed = 1 WHERE id = ? ", [req.tenant_id]);
    res.json({ message: 'Tour completed successfully.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update tour status.' });
  }
});

router.post('/onboarding/complete-setup', async (req, res) => {
  const { 
    gym_name, logo_url, address, support_phone, support_email, 
    currency, tax_rate_percent, payment_methods, 
    opening_time, closing_time, plans 
  } = req.body;
  
  try {
    // 7-day PRO trial clock (re)starts when setup completes; lapses to free Basic.
    const trialEnd = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

    // 1. Update tenants table.
    // [SEC] Only stamp the trial window on the FIRST onboarding. The CASE guards
    // mean re-POSTing /onboarding/complete-setup can no longer reset trial_end to
    // now+7d on every call (which was an infinite-free-trial business-logic flaw).
    await runQuery(`
      UPDATE tenants
      SET onboarding_completed = 1,
          gym_name = ?,
          logo_url = ?,
          opening_time = ?,
          closing_time = ?,
          trial_start = CASE WHEN onboarding_completed = 1 THEN trial_start ELSE CURRENT_TIMESTAMP END,
          trial_end   = CASE WHEN onboarding_completed = 1 THEN trial_end   ELSE ? END
      WHERE id = ?`, [gym_name, logo_url, opening_time, closing_time, trialEnd, req.tenant_id]);

    // 2. Insert Settings using EAV
    const settingsToSave = {
      gym_name, logo_url, address, support_phone, support_email,
      currency, tax_rate_percent,
      enable_cash: payment_methods?.includes('cash') ? 'true' : 'false',
      enable_upi: payment_methods?.includes('upi') ? 'true' : 'false',
      enable_card: payment_methods?.includes('card') ? 'true' : 'false',
      enable_bank_transfer: payment_methods?.includes('bank_transfer') ? 'true' : 'false'
    };

    for (const [key, value] of Object.entries(settingsToSave)) {
      if (value !== undefined && value !== null) {
        await runQuery(`
          INSERT INTO settings (setting_key, tenant_id, setting_value, created_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP) ON CONFLICT (tenant_id, setting_key) DO UPDATE SET setting_key = EXCLUDED.setting_key, setting_value = EXCLUDED.setting_value, created_at = EXCLUDED.created_at
        `, [key, req.tenant_id, String(value)]);
      }
    }

    // 3. Insert Initial Membership Plans
    // [SEC/DoS] Hard-cap the client-provided array so a payload of 500k "plans"
    // can't lock the CPU + DB in this insert loop. A real gym needs a handful.
    if (plans && Array.isArray(plans)) {
      if (plans.length > 50) {
        return res.status(400).json({ error: 'Too many plans submitted (max 50).' });
      }
      for (const p of plans) {
        if (p.name && p.name.trim() !== '') {
          // uid() (base36 time + random) — bare Date.now() collided across the
          // fast loop iterations, producing duplicate plan PKs.
          const planId = uid('p_');
          await runQuery(`
            INSERT INTO membership_plans 
            (id, tenant_id, name, duration_months, duration_days, price, joining_fee, freeze_allowed, pt_included, is_active)
            VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 1)
          `, [
            planId, 
            req.tenant_id, 
            p.name.trim(), 
            p.duration_months || 0, 
            p.duration_days || 0, 
            p.price || 0, 
            p.joining_fee || 0
          ]);
        }
      }
    }
    
    res.json({ message: 'Onboarding completed successfully.', trialEnd });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to complete onboarding setup.' });
  }
});

router.post('/onboarding/restart-tour', async (req, res) => {
  try {
    // Restart only the guided product tour — do NOT wipe completed business setup
    // (onboarding_completed). Resets the resume index so it replays from the start.
    await runQuery("UPDATE tenants SET tour_completed = 0, tutorial_step = 0 WHERE id = ? ", [req.tenant_id]);
    res.json({ message: 'Tour restarted successfully.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to restart tour.' });
  }
});

// [TUTORIAL] Persist the guided-tour resume index so the tour continues exactly
// where the user left off after a reload or browser restart. Clamped to a sane
// range; the client also calls /onboarding/complete-tour when it finishes.
router.post('/onboarding/tutorial-progress', async (req, res) => {
  const step = Math.max(0, Math.min(99, parseInt(req.body && req.body.step, 10) || 0));
  try {
    await runQuery("UPDATE tenants SET tutorial_step = ? WHERE id = ?", [step, req.tenant_id]);
    res.json({ message: 'Progress saved.', step });
  } catch (err) {
    console.error('tutorial-progress error:', err && err.message);
    res.status(500).json({ error: 'Failed to save tutorial progress.' });
  }
});

// ==========================================
// CRM LEADS API
// ==========================================

// Get Kanban Board leads
router.get('/crm/leads', async (req, res) => {
  try {
    const leads = await allQuery(`SELECT * FROM leads WHERE tenant_id = ? `, [req.tenant_id]);
    res.json(leads);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database query error.' });
  }
});

// Create new lead
router.post('/crm/leads', requireFeature('allowCRM', 'Leads CRM'), async (req, res) => {
  // Feature gating removed — the Lead CRM screen is available to all plans so the
  // page is fully functional (was: 403 for trial/basic, which broke the screen).
  const { full_name, phone, email, channel, note } = req.body;

  if (!full_name || !phone) {
    return res.status(400).json({ error: 'Lead name and contact number are required.' });
  }

  const id = 'l' + Date.now();
  try {
    await runQuery(`
      INSERT INTO leads (id, tenant_id, full_name, phone, email, acquisition_channel, note, stage)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'New')
    `, [id, req.tenant_id, full_name, phone, email, channel || 'Walk-in', note]);

    res.status(201).json({ message: 'Lead captured successfully.', leadId: id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create lead.' });
  }
});

// Update lead stage
router.put('/crm/leads/:id/stage', async (req, res) => {
  const { stage } = req.body;

  if (!stage) {
    return res.status(400).json({ error: 'New stage value is required.' });
  }

  try {
    await runQuery(`UPDATE leads SET stage = ? WHERE id = ? AND tenant_id = ? `, [stage, req.params.id, req.tenant_id]);
    res.json({ message: 'Lead pipeline stage updated.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update pipeline stage.' });
  }
});

// ==========================================
// TASKS API
// ==========================================

// Get task checklist
router.get('/tasks', async (req, res) => {
  try {
    // [M6] Automation scans moved off the request path to a background interval.
    const tasks = await allQuery(`SELECT * FROM tasks  WHERE tenant_id = ? ORDER BY due_date ASC`, [req.tenant_id]);
    res.json(tasks);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database query error.' });
  }
});

// Toggle task status
router.put('/tasks/:id', async (req, res) => {
  const { status } = req.body;
  try {
    await runQuery(`UPDATE tasks SET status = ? WHERE id = ? AND tenant_id = ? `, [status, req.params.id, req.tenant_id]);
    res.json({ message: 'Task updated.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update task.' });
  }
});

// ==========================================
// NOTIFICATIONS API
// ==========================================

// Get active alerts
router.get('/notifications', async (req, res) => {
  try {
    // [M6] Automation scans moved off the request path to a background interval.
    const alerts = await allQuery(`SELECT * FROM notifications  WHERE tenant_id = ? ORDER BY created_at DESC`, [req.tenant_id]);
    res.json(alerts);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database query error.' });
  }
});

// Mark alert read
router.put('/notifications/:id/read', async (req, res) => {
  try {
    await runQuery(`UPDATE notifications SET is_read = 1 WHERE id = ? AND tenant_id = ? `, [req.params.id, req.tenant_id]);
    res.json({ message: 'Alert dismissed.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error.' });
  }
});

// ==========================================
// EQUIPMENT FLEET API
// ==========================================

// Get assets
router.get('/equipment', async (req, res) => {
  try {
    const items = await allQuery(`SELECT * FROM equipment WHERE tenant_id = ? `, [req.tenant_id]);
    res.json(items);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database query error.' });
  }
});

router.post('/equipment', async (req, res) => {
  const { name, zone, model_id } = req.body;
  if (!name) return res.status(400).json({ error: 'Asset name is required.' });

  const id = 'eq' + Date.now();
  try {
    await runQuery(`
      INSERT INTO equipment (id, tenant_id, asset_id, name, zone, health_status, last_serviced_at, warranty_expiry_date)
      VALUES (?, ?, ?, ?, ?, 'Healthy', '${getTodayString()}', '${(() => { let d = new Date(); d.setFullYear(d.getFullYear() + 1); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); })()}')
    `, [id, req.tenant_id, model_id || 'AST-' + Math.floor(100 + Math.random() * 900), name, zone || 'Main Floor']);
    res.status(201).json({ message: 'Equipment asset registered.', assetId: id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to register equipment.' });
  }
});

router.post('/tasks', async (req, res) => {
  const { title, detail, priority } = req.body;
  if (!title) return res.status(400).json({ error: 'Task title is required.' });

  const id = 't' + Date.now();
  try {
    await runQuery(`
      INSERT INTO tasks (id, tenant_id, title, detail, priority, due_date, status)
      VALUES (?, ?, ?, ?, ?, datetime('now', '+1 day'), 'Pending')
    `, [id, req.tenant_id, title, detail || '', priority || 'Medium']);
    res.status(201).json({ message: 'Task added to checklist.', taskId: id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to insert task.' });
  }
});

// 3. Activity Logs
router.get('/activity-logs', async (req, res) => {
  try {
    const logs = await allQuery(`
      SELECT a.*, u.email as user_email
      FROM activity_logs a
      LEFT JOIN users u ON a.user_id = u.id
      WHERE a.tenant_id = ?
      ORDER BY a.created_at DESC
      LIMIT 100
    `, [req.tenant_id]);
    res.json(logs);
  } catch (err) {
    console.error('[activity-logs] error:', err && err.message);
    res.status(500).json({ error: 'Failed to load activity logs.' });
  }
});

// 6. Report Export System
router.get('/export/:type', authorize('settings:write'), async (req, res) => {
  try {
    // [C1 FIX] Strict validation for export type
    const type = whitelist(req.params.type, ['revenue', 'members', 'activity'], null);
    if (!type) {
      return res.status(400).send('Invalid export type');
    }

    let data = [];
    let fields = [];

    if (type === 'revenue') {
      data = await allQuery("SELECT id, invoice_number, member_id, total_amount, status, created_at FROM invoices WHERE tenant_id = ? ", [req.tenant_id]);
      fields = ['id', 'invoice_number', 'member_id', 'total_amount', 'status', 'created_at'];
    } else if (type === 'members') {
      data = await allQuery("SELECT id, full_name, phone, email, status, created_at FROM members WHERE tenant_id = ? ", [req.tenant_id]);
      fields = ['id', 'full_name', 'phone', 'email', 'status', 'created_at'];
    } else if (type === 'activity') {
      data = await allQuery("SELECT id, user_id, action, table_name, created_at FROM activity_logs WHERE tenant_id = ?", [req.tenant_id]);
      fields = ['id', 'user_id', 'action', 'table_name', 'created_at'];
    } else {
      return res.status(400).send('Invalid export type');
    }

    if (data.length === 0) {
      return res.send('No data available');
    }

    // Quick CSV Generation
    const csvRows = [];
    csvRows.push(fields.join(','));

    data.forEach((row) => {
      const values = fields.map((f) => {
        const val = row[f] === null ? '' : String(row[f]);
        return '"' + val.replace(/"/g, '""') + '"';
      });
      csvRows.push(values.join(','));
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${type}_report.csv"`);
    res.send(csvRows.join('\n'));
  } catch (err) {
    console.error('[export] error:', err && err.message);
    res.status(500).send('Export failed.');
  }
});

router.post('/backup/create', authorize('settings:write'), async (req, res) => {
  try {
    const tables = ['members', 'memberships', 'attendance', 'payments', 'invoices', 'leads', 'tasks', 'notifications', 'membership_plans'];
    const backupData = { tenant_id: req.tenant_id, timestamp: new Date().toISOString(), data: {} };
    
    for (const table of tables) {
      backupData.data[table] = await allQuery(`SELECT * FROM ${table} WHERE tenant_id = ?`, [req.tenant_id]);
    }

    const backupName = `backup_${req.tenant_id}_${Date.now()}.json`;
    fsModule.mkdirSync(BACKUP_DIR, { recursive: true });
    const backupPath = path.join(BACKUP_DIR, backupName);
    fsModule.writeFileSync(backupPath, JSON.stringify(backupData, null, 2));

    res.json({ success: true, message: 'Backup created', file: backupName });
  } catch (err) {
    console.error('[backup/create] error:', err && err.message);
    res.status(500).json({ error: 'Failed to create backup.' });
  }
});

router.get('/backup/list', authorize('settings:write'), (req, res) => {
  try {
    const dir = BACKUP_DIR;
    if (!fsModule.existsSync(dir)) return res.json([]);
    const files = fsModule.readdirSync(dir).
    filter((f) => f.startsWith(`backup_${req.tenant_id}_`) && f.endsWith('.json')).
    map((f) => {
      const stats = fsModule.statSync(path.join(dir, f));
      return {
        name: f,
        size: (stats.size / 1024 / 1024).toFixed(2) + ' MB',
        created: stats.birthtime
      };
    }).
    sort((a, b) => b.created - a.created);
    res.json(files);
  } catch (err) {
    console.error('[backup/list] error:', err && err.message);
    res.status(500).json({ error: 'Failed to list backups.' });
  }
});

router.get('/backup/download/:file', authorize('settings:write'), (req, res) => {
  // [M7] basename() strips any path-traversal; the tenant prefix check enforces
  // that a tenant can only fetch its own backups.
  const file = path.basename(req.params.file);
  if (!file.startsWith(`backup_${req.tenant_id}_`) || !file.endsWith('.json')) return res.status(403).send('Access denied');
  const filePath = path.join(BACKUP_DIR, file);
  if (!fsModule.existsSync(filePath)) return res.status(404).send('File not found');
  res.download(filePath);
});

module.exports = router;
