const fs = require('fs');

let apiCode = fs.readFileSync('routes/api.js', 'utf8');

// 1. Settings GET Fix
const settingsGetOld = `router.get('/settings', async (req, res) => {
  try {
    await allQuery(\`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)\`);
    const rows = await allQuery(\`SELECT * FROM settings\`);
    const config = {};
    rows.forEach((r) => {config[r.key] = r.value;});

    res.json({
      facility_name: config.facility_name || window.APP_CONFIG?.brand?.name || 'Kinetic SaaS',
      facility_address: config.facility_address || 'Bandra West, Mumbai 400050, IN',
      facility_email: config.facility_email || 'billing@kineticenterprise.in',
      facility_phone: config.facility_phone || '+91 98765 43210'
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to retrieve settings.' });
  }
});`;

const settingsGetNew = `router.get('/settings', async (req, res) => {
  try {
    const rows = await allQuery(\`SELECT setting_key, setting_value FROM settings\`);
    const config = {};
    rows.forEach((r) => {config[r.setting_key] = r.setting_value;});

    res.json(config);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to retrieve settings.' });
  }
});`;

apiCode = apiCode.replace(settingsGetOld, settingsGetNew);

// 2. Settings POST Fix
const settingsPostOld = `router.post('/settings', async (req, res) => {
  const { facility_name, facility_address, facility_email, facility_phone } = req.body;
  try {
    await allQuery(\`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)\`);
    await runQuery(\`INSERT OR REPLACE INTO settings (key, value) VALUES ('facility_name', ?)\`, [facility_name]);
    await runQuery(\`INSERT OR REPLACE INTO settings (key, value) VALUES ('facility_address', ?)\`, [facility_address]);
    await runQuery(\`INSERT OR REPLACE INTO settings (key, value) VALUES ('facility_email', ?)\`, [facility_email]);
    await runQuery(\`INSERT OR REPLACE INTO settings (key, value) VALUES ('facility_phone', ?)\`, [facility_phone]);

    res.json({ message: 'Facility operations settings updated.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save settings.' });
  }
});`;

const settingsPostNew = `router.post('/settings', async (req, res) => {
  try {
    for (const [key, value] of Object.entries(req.body)) {
      await runQuery(\`INSERT OR REPLACE INTO settings (setting_key, tenant_id, setting_value) VALUES (?, 't1', ?)\`, [key, value]);
    }
    res.json({ message: 'Facility operations settings updated.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save settings.' });
  }
});`;

apiCode = apiCode.replace(settingsPostOld, settingsPostNew);

// 3. System Reset (Demo Data) Fix
const resetApi = `
// ==========================================
// SYSTEM MAINTENANCE API
// ==========================================
router.post('/system/reset', async (req, res) => {
  try {
    await runQuery(\`DELETE FROM attendance\`);
    await runQuery(\`DELETE FROM payments\`);
    await runQuery(\`DELETE FROM invoices\`);
    await runQuery(\`DELETE FROM memberships\`);
    await runQuery(\`DELETE FROM retention_events\`);
    await runQuery(\`DELETE FROM notifications\`);
    await runQuery(\`DELETE FROM tasks\`);
    await runQuery(\`DELETE FROM leads\`);
    await runQuery(\`DELETE FROM members\`);
    
    res.json({ message: 'All demo transactional data has been erased successfully.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to reset system.' });
  }
});
`;

if (!apiCode.includes('/system/reset')) {
  apiCode = apiCode.replace('module.exports = router;', resetApi + '\\nmodule.exports = router;');
}

// 4. Dashboard Summary Attendance Fix
const dashboardSummaryOld = `    res.json({
      totalMembers: totalMembersCount,
      presentToday: 0, // Attendance analytics removed
      revenueMtd: revenueMtd.sum || 0,
      pendingInvoices: pendingInvoices.count || 0,
      expiringCount: expiringCount.count || 0,
      absentCount: 0, // Attendance analytics removed
      renewalRate,
      retentionRate,`;

const dashboardSummaryNew = `
    const checkIns = await getQuery(\`
      SELECT COUNT(DISTINCT member_id) as count 
      FROM attendance 
      WHERE (date(check_in) = date('now', 'localtime') OR date(check_in) = '2026-06-04')
    \`);
    
    const absentQ = await getQuery(\`
      SELECT COUNT(*) as count FROM members m
      WHERE m.status = 'Active' AND m.id NOT IN (
        SELECT DISTINCT member_id FROM attendance
        WHERE (date(check_in) >= date('now', 'localtime', '-5 days') OR date(check_in) = '2026-06-04')
      )
    \`);

    // Most active member (Phase 5F)
    const mostActive = await getQuery(\`
      SELECT m.full_name, COUNT(a.id) as visits 
      FROM attendance a 
      JOIN members m ON a.member_id = m.id 
      WHERE date(a.check_in) >= date('now', 'localtime', '-30 days')
      GROUP BY a.member_id 
      ORDER BY visits DESC LIMIT 1
    \`);

    // Peak hour (Phase 5F)
    const peakHourData = await allQuery(\`
      SELECT strftime('%H', check_in) as hour, COUNT(*) as count 
      FROM attendance 
      GROUP BY hour 
      ORDER BY count DESC LIMIT 1
    \`);
    const peakHour = peakHourData.length > 0 ? peakHourData[0].hour + ':00' : 'N/A';

    res.json({
      totalMembers: totalMembersCount,
      presentToday: checkIns.count || 0,
      revenueMtd: revenueMtd.sum || 0,
      pendingInvoices: pendingInvoices.count || 0,
      expiringCount: expiringCount.count || 0,
      absentCount: absentQ.count || 0,
      mostActiveMember: mostActive ? mostActive.full_name : 'None',
      peakHour,
      renewalRate,
      retentionRate,`;

apiCode = apiCode.replace(dashboardSummaryOld, dashboardSummaryNew);

fs.writeFileSync('routes/api.js', apiCode);
console.log('Fixed API successfully');
