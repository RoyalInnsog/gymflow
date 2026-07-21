const fs = require('fs');

let content = fs.readFileSync('./database_pg.js', 'utf8');

// Replace the top imports and driver config
content = content.replace(/const\s+\{\s*createClient\s*\}\s*=\s*require\('@libsql\/client'\);/, "const { Pool } = require('pg');\nconst { AsyncLocalStorage } = require('async_hooks');\nconst tenantContext = new AsyncLocalStorage();");

// Replace buildDbConfig
content = content.replace(/function buildDbConfig\(\) \{[\s\S]*?\n\}/, `function buildDbConfig() {
  return {
    connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/gymflow',
    ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false }
  };
}`);

// Replace db init
content = content.replace(/const usingTurso = !!process\.env\.TURSO_DATABASE_URL;[\s\S]*?const db = createClient\(buildDbConfig\(\)\);[\s\S]*?console\.log\(.*?\);/, `const usingPg = true;
const db = new Pool(buildDbConfig());
console.log('Connected to PostgreSQL database.');`);

// Replace PRAGMA foreign keys
content = content.replace(/db\.execute\('PRAGMA foreign_keys = ON'\)\.catch\(\(\) => \{\}\);/, '// PRAGMA foreign_keys = ON not needed for pg');

content = content.replace(/function normArgs\(params\) \{[\s\S]*?\}\n/, `function normArgs(params) {
  return params.map((p) => {
    if (p === undefined) return null;
    return p;
  });
}`);

content = content.replace(/function rowsToObjects\(rs\) \{[\s\S]*?\}\n/, '');

// Replace runQuery getQuery allQuery
const newWrappers = `// Wraps a query to apply the RLS tenant ID if we are inside a tenant context
async function executeWithRls(pgSql, params) {
  const tenantId = tenantContext.getStore();
  const client = await db.connect();
  try {
    if (tenantId) {
      await client.query("SET LOCAL app.current_tenant_id = $1", [tenantId]);
    }
    const rs = await client.query(pgSql, normArgs(params));
    return rs;
  } finally {
    client.release();
  }
}

async function runQuery(sql, params = []) {
  let counter = 1;
  const pgSql = sql.replace(/\\?/g, () => '$' + counter++);
  const rs = await executeWithRls(pgSql, params);
  return { changes: rs.rowCount, lastID: undefined };
}

async function getQuery(sql, params = []) {
  let counter = 1;
  const pgSql = sql.replace(/\\?/g, () => '$' + counter++);
  const rs = await executeWithRls(pgSql, params);
  return rs.rows[0];
}

async function allQuery(sql, params = []) {
  let counter = 1;
  const pgSql = sql.replace(/\\?/g, () => '$' + counter++);
  const rs = await executeWithRls(pgSql, params);
  return rs.rows;
}`;

content = content.replace(/async function runQuery[\s\S]*?async function allQuery.*?return rowsToObjects\(rs\);\n\}/, newWrappers);

// Append tenantContext to module.exports
content = content.replace(/module\.exports\s*=\s*\{/, 'module.exports = {\n  tenantContext,');

// Re-run the RLS script logic on the content
const tenantTables = [
  'settings', 'discount_rules', 'members', 'member_measurements', 'member_attendance',
  'member_documents', 'memberships', 'subscriptions', 'subscription_history', 'invoices',
  'payments', 'plans', 'expenses', 'billing_events', 'whatsapp_templates', 'notifications',
  'background_jobs', 'user_roles'
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
}

content = content.replace(/\/\/ Seed basic permissions/g, rlsCommands + '\n    // Seed basic permissions');

fs.writeFileSync('./database.js', content);
console.log("Completely rebuilt database.js with RLS");
