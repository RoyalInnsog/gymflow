const fs = require('fs');
let code = fs.readFileSync('routes/api.js', 'utf8');

const tablesToProtect = [
  'settings', 'branches', 'staff', 'members', 'membership_plans', 
  'memberships', 'attendance', 'invoices', 'payments', 'notifications', 
  'campaigns', 'leads', 'tasks', 'retention_events', 'equipment', 
  'reports', 'activity_logs', 'templates'
];
const protectedTableRegex = new RegExp('\\b(' + tablesToProtect.join('|') + ')\\b', 'i');

const regex = /(runQuery|getQuery|allQuery)\s*\(\s*\`([\s\S]*?)\`\s*(?:,\s*(\[.*?\]))?\s*\)/g;

let replaced = code.replace(regex, (match, fnName, sql, params) => {
  if (!protectedTableRegex.test(sql)) {
    return match;
  }

  let newSql = sql;
  let newParams = params ? params.trim() : '';

  if (newSql.match(/^\s*SELECT\b/i)) {
    if (!newSql.match(/\bWHERE\b/i)) {
      newSql = newSql.replace(/(\bFROM\s+[a-z_]+\s*(?:as\s+[a-z_]+)?\s*(?:[a-z_]+)?\s*)/i, "$1 WHERE tenant_id = '${req.tenant_id}' ");
    } else {
      newSql = newSql.replace(/(\bWHERE\b)/i, "$1 tenant_id = '${req.tenant_id}' AND ");
    }
  }
  else if (newSql.match(/^\s*DELETE\b/i)) {
    if (!newSql.match(/\bWHERE\b/i)) {
      newSql += " WHERE tenant_id = '${req.tenant_id}'";
    } else {
      newSql = newSql.replace(/(\bWHERE\b)/i, "$1 tenant_id = '${req.tenant_id}' AND ");
    }
  }
  else if (newSql.match(/^\s*UPDATE\b/i)) {
    if (!newSql.match(/\bWHERE\b/i)) {
      newSql += " WHERE tenant_id = '${req.tenant_id}'";
    } else {
      newSql = newSql.replace(/(\bWHERE\b)/i, "$1 tenant_id = '${req.tenant_id}' AND ");
    }
  }
  else if (newSql.match(/^\s*INSERT\b/i)) {
    newSql = newSql.replace(/(\([^)]+)\)/, "$1, tenant_id)");
    newSql = newSql.replace(/(VALUES\s*\([^)]+)\)/i, "$1, '${req.tenant_id}')");
  }

  if (newParams) {
    return `${fnName}(\n\`${newSql}\`\n, ${newParams})`;
  } else {
    return `${fnName}(\n\`${newSql}\`\n)`;
  }
});

fs.writeFileSync('routes/api.js', replaced);
console.log('Restored isolation successfully.');
