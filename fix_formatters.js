const fs = require('fs');
let code = fs.readFileSync('dashboard_kinetic_enterprise/code.html', 'utf8');

code = code.replace(
  "const fmt = v => v != null ? '₹' + Number(v).toLocaleString('en-IN') : '—';",
  "const fmt = v => (v != null && !Number.isNaN(Number(v))) ? '₹' + Number(v).toLocaleString('en-IN') : '—';"
);

code = code.replace(
  "const pct = v => v != null ? v + '%' : '—';",
  "const pct = v => (v != null && !Number.isNaN(Number(v))) ? v + '%' : '—';"
);

fs.writeFileSync('dashboard_kinetic_enterprise/code.html', code);
console.log('Fixed dashboard formatters');
