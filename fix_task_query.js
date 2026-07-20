const fs = require('fs');
let code = fs.readFileSync('routes/api.js', 'utf8');

code = code.replace(
  "SELECT * FROM tasks ORDER  WHERE tenant_id = '${req.tenant_id}' BY due_date ASC",
  "SELECT * FROM tasks WHERE tenant_id = '${req.tenant_id}' ORDER BY due_date ASC"
);

fs.writeFileSync('routes/api.js', code);
console.log('Fixed task syntax error');
