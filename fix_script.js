const fs = require('fs');
let py = fs.readFileSync('rewrite_sqlglot.py', 'utf8');
py = py.replace("open('routes/api_updated.js'", "open('routes/api.js'");
py = py.replace("open('routes/api_fully_isolated.js'", "open('routes/api_tenant.js'");
fs.writeFileSync('rewrite_sqlglot.py', py);
