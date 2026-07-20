const fs = require('fs');
let code = fs.readFileSync('routes/api.js', 'utf8');

// 1. Fix member creation
code = code.replace(
  'INSERT INTO members (id, full_name, phone, email, dob, gender, emergency_contact_name, emergency_contact_phone, height_cm, weight_kg, bmi, status, onboarding_step)',
  'INSERT INTO members (id, tenant_id, full_name, phone, email, dob, gender, emergency_contact_name, emergency_contact_phone, height_cm, weight_kg, bmi, status, onboarding_step)'
);
code = code.replace(
  "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Active', 6)\\n    `, [id, full_name, phone",
  "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Active', 6)\\n    `, [id, req.tenant_id, full_name, phone"
);

// 2. Fix membership creation
code = code.replace(
  'INSERT INTO memberships (id, member_id, plan_id, start_date, end_date, status)',
  'INSERT INTO memberships (id, tenant_id, member_id, plan_id, start_date, end_date, status)'
);
code = code.replace(
  "VALUES (?, ?, ?, ?, ?, 'Active')\\n        `, [msId, id, plan_id",
  "VALUES (?, ?, ?, ?, ?, ?, 'Active')\\n        `, [msId, req.tenant_id, id, plan_id"
);

fs.writeFileSync('routes/api.js', code);
console.log('Member creation fixed.');
