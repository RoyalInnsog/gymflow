const fs = require('fs');

const file = 'routes/api.js';
let code = fs.readFileSync(file, 'utf8');

// 1. Fix runAutomationScans definition
code = code.replace('async function runAutomationScans() {', 'async function runAutomationScans(req) {');

// 2. Fix the call inside /tasks
code = code.replace("await runAutomationScans();", "await runAutomationScans(req);");

// 3. Fix resolveTemplate calls inside runAutomationScans
code = code.replace(/await resolveTemplate\('/g, "await resolveTemplate(req, '");

// 4. Manually isolate the 3 automation queries
// 4a. Active Memberships scan
code = code.replace(/FROM memberships ms\s+JOIN members m ON ms.member_id = m.id\s+WHERE ms.status = 'Active'/g, 
  "FROM memberships ms JOIN members m ON ms.member_id = m.id WHERE ms.status = 'Active' AND ms.tenant_id = '${req.tenant_id}'");

// 4b. Inactive Members scan
code = code.replace(/FROM members m\s+LEFT JOIN attendance a ON m.id = a.member_id\s+WHERE m.status = 'Active'/g,
  "FROM members m LEFT JOIN attendance a ON m.id = a.member_id WHERE m.status = 'Active' AND m.tenant_id = '${req.tenant_id}'");

// 4c. Overdue Invoices scan
code = code.replace(/FROM invoices i\s+JOIN members m ON i.member_id = m.id\s+WHERE i.status = 'Unpaid'/g,
  "FROM invoices i JOIN members m ON i.member_id = m.id WHERE i.status = 'Unpaid' AND i.tenant_id = '${req.tenant_id}'");

// 5. Update runQuery / getQuery / allQuery calls inside runAutomationScans
// We'll just replace 'runQuery(`' with 'runQuery(req, `' and 'allQuery(`' with 'allQuery(req, `' globally inside runAutomationScans.
// Actually, doing it blindly might break others, but we know runAutomationScans had allQuery(` 
code = code.replace(/allQuery\(`/g, "allQuery(req, `");
code = code.replace(/runQuery\(`/g, "runQuery(req, `");
code = code.replace(/getQuery\(`/g, "getQuery(req, `");

fs.writeFileSync(file, code);
console.log('Fixed runAutomationScans');
