const fs = require('fs');
const file = 'routes/api.js';
let code = fs.readFileSync(file, 'utf8');

// Function to strip out routes
function removeRoutes(endpoints) {
  endpoints.forEach(ep => {
    const regexStr = `router\\.(get|post|put|delete)\\('${ep}'[\\s\\S]*?(?=router\\.[a-z]+\\(|module\\.exports)`;
    const regex = new RegExp(regexStr, 'g');
    code = code.replace(regex, '');
  });
}

// Strip out old routes
removeRoutes([
  '/settings', '/settings/public',
  '/plans', '/plans/:id', 
  '/branches', '/branches/:id',
  '/staff', '/staff/:id', '/staff/:id/role', '/staff/:id/suspend',
  '/templates', '/templates/:id'
]);

// Prepare new robust routes
const newRoutes = `
// ==========================================
// PHASE 5C - BUSINESS CONTROL CENTER APIs
// ==========================================

// --- SETTINGS ---
router.get('/settings', async (req, res) => {
  try {
    const rows = await allQuery(req, \`SELECT * FROM settings WHERE tenant_id = '\${req.tenant_id}'\`);
    const settings = {};
    rows.forEach(r => { settings[r.setting_key] = r.setting_value; });
    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

router.post('/settings', async (req, res) => {
  try {
    const keys = Object.keys(req.body);
    for (const key of keys) {
      const val = req.body[key];
      const exists = await getQuery(req, \`SELECT setting_key FROM settings WHERE setting_key = ? AND tenant_id = '\${req.tenant_id}'\`, [key]);
      if (exists) {
        await runQuery(req, \`UPDATE settings SET setting_value = ? WHERE setting_key = ? AND tenant_id = '\${req.tenant_id}'\`, [String(val), key]);
      } else {
        await runQuery(req, \`INSERT INTO settings (setting_key, setting_value, tenant_id) VALUES (?, ?, '\${req.tenant_id}')\`, [key, String(val)]);
      }
    }
    
    // Auto-update tenant table if gym_name changes
    if (req.body.gym_name) {
      await runQuery(req, \`UPDATE tenants SET gym_name = ? WHERE id = '\${req.tenant_id}'\`, [req.body.gym_name]);
    }
    res.json({ message: 'Settings updated successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

router.get('/settings/public', async (req, res) => {
  try {
    const rows = await allQuery(req, \`SELECT * FROM settings WHERE setting_key IN ('gym_name', 'logo_url', 'support_phone') AND tenant_id = '\${req.tenant_id}'\`);
    const publicSettings = {};
    rows.forEach(r => { publicSettings[r.setting_key] = r.setting_value; });
    res.json(publicSettings);
  } catch (err) {
    res.status(500).json({ error: 'Failed' });
  }
});

// --- PLANS ---
router.get('/plans', async (req, res) => {
  try {
    const plans = await allQuery(req, \`SELECT * FROM membership_plans WHERE tenant_id = '\${req.tenant_id}' ORDER BY duration_months ASC, duration_days ASC\`);
    res.json(plans);
  } catch (err) {
    res.status(500).json({ error: 'Failed to retrieve plans.' });
  }
});

router.post('/plans', async (req, res) => {
  const id = 'p_' + Date.now();
  const { name, duration_months, duration_days, price, joining_fee, freeze_allowed, pt_included, is_active, description } = req.body;
  try {
    await runQuery(req, \`INSERT INTO membership_plans (id, name, duration_months, duration_days, price, joining_fee, freeze_allowed, pt_included, is_active, description, tenant_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '\${req.tenant_id}')\`, 
      [id, name, duration_months || 0, duration_days || 0, price, joining_fee || 0, freeze_allowed || 0, pt_included || 0, is_active !== undefined ? is_active : 1, description || '']);
    res.json({ message: 'Plan created' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create plan' });
  }
});

router.put('/plans/:id', async (req, res) => {
  const { name, duration_months, duration_days, price, joining_fee, freeze_allowed, pt_included, is_active, description } = req.body;
  try {
    await runQuery(req, \`UPDATE membership_plans SET name = ?, duration_months = ?, duration_days = ?, price = ?, joining_fee = ?, freeze_allowed = ?, pt_included = ?, is_active = ?, description = ? WHERE id = ? AND tenant_id = '\${req.tenant_id}'\`, 
      [name, duration_months || 0, duration_days || 0, price, joining_fee || 0, freeze_allowed || 0, pt_included || 0, is_active !== undefined ? is_active : 1, description || '', req.params.id]);
    res.json({ message: 'Plan updated' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update plan' });
  }
});

router.delete('/plans/:id', async (req, res) => {
  try {
    await runQuery(req, \`DELETE FROM membership_plans WHERE id = ? AND tenant_id = '\${req.tenant_id}'\`, [req.params.id]);
    res.json({ message: 'Plan deleted' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete plan' });
  }
});

// --- STAFF ---
router.get('/staff', async (req, res) => {
  try {
    const staffList = await allQuery(req, \`SELECT * FROM staff WHERE tenant_id = '\${req.tenant_id}'\`);
    res.json(staffList);
  } catch (err) {
    res.status(500).json({ error: 'Failed to retrieve staff' });
  }
});

router.post('/staff', async (req, res) => {
  const { name, role, email, phone, branch_id } = req.body;
  if (!name || !email) return res.status(400).json({ error: 'Name and email are required.' });
  const id = 's_' + Date.now();
  try {
    await runQuery(req, \`INSERT INTO staff (id, name, role, email, phone, branch_id, status, tenant_id) VALUES (?, ?, ?, ?, ?, ?, 'Active', '\${req.tenant_id}')\`, 
      [id, name, role || 'Trainer', email, phone || '', branch_id || null]);
    res.json({ message: 'Staff added successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to add staff' });
  }
});

router.put('/staff/:id/role', async (req, res) => {
  const { role } = req.body;
  try {
    await runQuery(req, \`UPDATE staff SET role = ? WHERE id = ? AND tenant_id = '\${req.tenant_id}'\`, [role, req.params.id]);
    res.json({ message: 'Staff role updated' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update role' });
  }
});

router.put('/staff/:id/suspend', async (req, res) => {
  try {
    await runQuery(req, \`UPDATE staff SET status = 'Suspended' WHERE id = ? AND tenant_id = '\${req.tenant_id}'\`, [req.params.id]);
    res.json({ message: 'Staff suspended' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to suspend staff' });
  }
});

// --- BRANCHES ---
router.get('/branches', async (req, res) => {
  try {
    const branches = await allQuery(req, \`SELECT * FROM branches WHERE tenant_id = '\${req.tenant_id}'\`);
    res.json(branches);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch branches' });
  }
});

router.post('/branches', async (req, res) => {
  const id = 'b_' + Date.now();
  const { name, address, phone, manager_id, status } = req.body;
  try {
    await runQuery(req, \`INSERT INTO branches (id, name, address, phone, manager_id, status, tenant_id) VALUES (?, ?, ?, ?, ?, ?, '\${req.tenant_id}')\`, 
      [id, name, address || '', phone || '', manager_id || null, status || 'Active']);
    res.json({ message: 'Branch created' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create branch' });
  }
});

router.put('/branches/:id', async (req, res) => {
  const { name, address, phone, manager_id, status } = req.body;
  try {
    await runQuery(req, \`UPDATE branches SET name = ?, address = ?, phone = ?, manager_id = ?, status = ? WHERE id = ? AND tenant_id = '\${req.tenant_id}'\`,
      [name, address || '', phone || '', manager_id || null, status || 'Active', req.params.id]);
    res.json({ message: 'Branch updated' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update branch' });
  }
});

router.delete('/branches/:id', async (req, res) => {
  try {
    await runQuery(req, \`DELETE FROM branches WHERE id = ? AND tenant_id = '\${req.tenant_id}'\`, [req.params.id]);
    res.json({ message: 'Branch deleted' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete branch' });
  }
});

// --- TEMPLATES ---
router.get('/templates', async (req, res) => {
  try {
    const templates = await allQuery(req, \`SELECT * FROM templates WHERE tenant_id = '\${req.tenant_id}' ORDER BY created_at ASC\`);
    res.json(templates);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch templates' });
  }
});

router.post('/templates', async (req, res) => {
  const id = 'tpl_' + Date.now();
  const { name, message_body } = req.body;
  try {
    await runQuery(req, \`INSERT INTO templates (id, name, message_body, tenant_id) VALUES (?, ?, ?, '\${req.tenant_id}')\`, 
      [id, name, message_body]);
    res.json({ message: 'Template created' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create template' });
  }
});

router.put('/templates/:id', async (req, res) => {
  const { name, message_body } = req.body;
  try {
    await runQuery(req, \`UPDATE templates SET name = ?, message_body = ? WHERE id = ? AND tenant_id = '\${req.tenant_id}'\`, 
      [name, message_body, req.params.id]);
    res.json({ message: 'Template updated' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update template' });
  }
});

router.delete('/templates/:id', async (req, res) => {
  try {
    await runQuery(req, \`DELETE FROM templates WHERE id = ? AND tenant_id = '\${req.tenant_id}'\`, [req.params.id]);
    res.json({ message: 'Template deleted' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete template' });
  }
});

`;

code = code.replace('module.exports = router;', newRoutes + '\nmodule.exports = router;');

fs.writeFileSync(file, code);
console.log('API routes refactored successfully.');
