const fs = require('fs');
let code = fs.readFileSync('routes/api.js', 'utf8');

const exportSnippet = `
// 6. Report Export System
router.get('/export/:type', async (req, res) => {
  try {
    const type = req.params.type;
    let data = [];
    let fields = [];
    
    if (type === 'revenue') {
      data = await allQuery("SELECT id, invoice_number, member_id, total_amount, status, created_at FROM invoices");
      fields = ['id', 'invoice_number', 'member_id', 'total_amount', 'status', 'created_at'];
    } else if (type === 'members') {
      data = await allQuery("SELECT id, full_name, phone, email, status, created_at FROM members");
      fields = ['id', 'full_name', 'phone', 'email', 'status', 'created_at'];
    } else if (type === 'activity') {
      data = await allQuery("SELECT id, user_id, action, table_name, created_at FROM activity_logs");
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
    
    data.forEach(row => {
      const values = fields.map(f => {
        const val = row[f] === null ? '' : String(row[f]);
        return '"' + val.replace(/"/g, '""') + '"';
      });
      csvRows.push(values.join(','));
    });
    
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', \\\`attachment; filename="\${type}_report.csv"\\\`);
    res.send(csvRows.join('\\n'));
  } catch(err) {
    res.status(500).send(err.message);
  }
});
`;

code = code.replace('module.exports = router;', exportSnippet + '\\nmodule.exports = router;');
fs.writeFileSync('routes/api.js', code);
console.log('Export API added.');
