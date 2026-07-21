const fs = require('fs');

let content = fs.readFileSync('./database.js', 'utf8');

// List of tenant-specific tables in GYM_Flow
const tenantTables = [
  'settings',
  'discount_rules',
  'members',
  'member_measurements',
  'member_attendance',
  'member_documents',
  'memberships',
  'subscriptions',
  'subscription_history',
  'invoices',
  'payments',
  'plans',
  'expenses',
  'billing_events',
  'whatsapp_templates',
  'notifications',
  'background_jobs',
  'user_roles'
];

let rlsCommands = `\n    // ============================================================
    // ROW LEVEL SECURITY (RLS)
    // ============================================================
`;

for (const table of tenantTables) {
  rlsCommands += `    try { await runQuery('ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY'); } catch (e) {}\n`;
  rlsCommands += `    try { await runQuery(\`
      CREATE POLICY tenant_isolation_policy ON ${table}
      USING (tenant_id = current_setting('app.current_tenant_id'));
    \`); } catch (e) {}\n`;
  
  // Also we need to bypass RLS for admin user / setup queries. 
  // Postgres allows BYPASSRLS on roles, but for simplicity, the policy can allow it if the setting is empty,
  // or we just assume every API request will have a tenant.
}

content = content.replace(/\/\/ Seed basic permissions/g, rlsCommands + '\n    // Seed basic permissions');

fs.writeFileSync('./database.js', content);
console.log("Added RLS to database.js");
