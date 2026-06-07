const fs = require('fs');
let code = fs.readFileSync('routes/api.js', 'utf8');

code = code.replace(
  "const existingReport = await allQuery(\n`SELECT * FROM reports WHERE tenant_id = '${req.tenant_id}' AND  date = ? AND type = 'Daily Closing'`",
  "const existingReport = await getQuery(\n`SELECT * FROM reports WHERE tenant_id = '${req.tenant_id}' AND  date = ? AND type = 'Daily Closing'`"
);

code = code.replace(
  "const existingReport = await allQuery(\n`SELECT * FROM reports WHERE tenant_id = '${req.tenant_id}' AND  id = ?`",
  "const existingReport = await getQuery(\n`SELECT * FROM reports WHERE tenant_id = '${req.tenant_id}' AND  id = ?`"
);

fs.writeFileSync('routes/api.js', code);
console.log('Fixed reports getQuery');
