const fs = require('fs');
const path = require('path');
let code = fs.readFileSync('routes/api.js', 'utf8');

const backupSnippet = `
// ==========================================
// BACKUP & RESTORE APIs
// ==========================================
const path = require('path');
const fsModule = require('fs');

router.post('/backup/create', (req, res) => {
  try {
    const dbPath = path.join(__dirname, '..', 'database.db');
    if (!fsModule.existsSync(dbPath)) return res.status(404).send('Database not found');
    
    const backupName = 'backup_' + Date.now() + '.db';
    const backupPath = path.join(__dirname, '..', backupName);
    fsModule.copyFileSync(dbPath, backupPath);
    
    // Log Activity
    logActivity(req.body.staff_id || 'u1', 'BACKUP_CREATE', 'system', backupName, { file: backupName });
    
    res.json({ success: true, message: 'Backup created', file: backupName });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/backup/list', (req, res) => {
  try {
    const dir = path.join(__dirname, '..');
    const files = fsModule.readdirSync(dir)
      .filter(f => f.startsWith('backup_') && f.endsWith('.db'))
      .map(f => {
         const stats = fsModule.statSync(path.join(dir, f));
         return {
           name: f,
           size: (stats.size / 1024 / 1024).toFixed(2) + ' MB',
           created: stats.birthtime
         };
      })
      .sort((a,b) => b.created - a.created);
    res.json(files);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/backup/download/:file', (req, res) => {
  const file = req.params.file;
  if (!file.startsWith('backup_')) return res.status(400).send('Invalid file');
  const filePath = path.join(__dirname, '..', file);
  if (!fsModule.existsSync(filePath)) return res.status(404).send('File not found');
  res.download(filePath);
});
`;

code = code.replace('module.exports = router;', backupSnippet + '\nmodule.exports = router;');
fs.writeFileSync('routes/api.js', code);
console.log('Backup API added.');
