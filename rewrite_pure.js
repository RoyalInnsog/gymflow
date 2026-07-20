const fs = require('fs');

let code = fs.readFileSync('./routes/api.js', 'utf8');

// We want to replace queries in allQuery, runQuery, getQuery
const regex = /(runQuery|getQuery|allQuery)\s*\(\s*`([\s\S]*?)`\s*(?:,\s*(\[.*?\]))?\s*\)/g;

const tablesToProtect = [
  'settings', 'branches', 'staff', 'members', 'membership_plans', 
  'memberships', 'attendance', 'invoices', 'payments', 'notifications', 
  'campaigns', 'leads', 'tasks', 'retention_events', 'equipment', 
  'reports', 'activity_logs', 'templates'
];

const protectedTableRegex = new RegExp(`\\b(${tablesToProtect.join('|')})\\b`, 'i');

let replaced = code.replace(regex, (match, fnName, sql, params) => {
  if (!protectedTableRegex.test(sql)) {
    return match; // Ignore non-protected queries
  }

  // We need to inject req.tenant_id into SQL string
  let newSql = sql;
  let newParams = params ? params.trim() : '[]';

  // Helper to add param
  const addParam = () => {
    if (newParams === '[]') {
      newParams = '[req.tenant_id]';
    } else {
      // e.g. [id, name] -> [req.tenant_id, id, name]
      newParams = newParams.replace(/^\[/, '[req.tenant_id, ');
    }
  };

  const addParamEnd = () => {
    if (newParams === '[]') {
      newParams = '[req.tenant_id]';
    } else {
      newParams = newParams.replace(/\]$/, ', req.tenant_id]');
    }
  };

  // 1. SELECT
  if (newSql.match(/^\s*SELECT\b/i)) {
    if (!newSql.match(/\bWHERE\b/i)) {
      newSql = newSql.replace(/(\bFROM\s+[a-z_]+\s*(?:as\s+[a-z_]+)?\s*(?:[a-z_]+)?\s*)/i, "$1 WHERE tenant_id = ? ");
    } else {
      newSql = newSql.replace(/(\bWHERE\b)/i, "$1 tenant_id = ? AND");
    }
    addParam();
  }
  // 2. DELETE
  else if (newSql.match(/^\s*DELETE\b/i)) {
    if (!newSql.match(/\bWHERE\b/i)) {
      newSql += " WHERE tenant_id = ?";
    } else {
      newSql = newSql.replace(/(\bWHERE\b)/i, "$1 tenant_id = ? AND");
    }
    addParam();
  }
  // 3. UPDATE
  else if (newSql.match(/^\s*UPDATE\b/i)) {
    if (!newSql.match(/\bWHERE\b/i)) {
      newSql += " WHERE tenant_id = ?";
    } else {
      newSql = newSql.replace(/(\bWHERE\b)/i, "$1 tenant_id = ? AND");
    }
    addParamEnd(); // For UPDATE SET x=?, WHERE tenant_id=?, the tenant_id param must be at the end!
  }
  // 4. INSERT
  else if (newSql.match(/^\s*INSERT\b/i)) {
    newSql = newSql.replace(/(\([^)]+)\)/, "$1, tenant_id)");
    newSql = newSql.replace(/(VALUES\s*\([^)]+)\)/i, "$1, ?)");
    addParamEnd();
  }

  return `${fnName}(\`${newSql}\`, ${newParams})`;
});

fs.writeFileSync('./routes/api_updated.js', replaced);
console.log("Rewrite completed successfully via pure regex.");
