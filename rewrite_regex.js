const fs = require('fs');

let code = fs.readFileSync('./routes/api.js', 'utf8');

// List of all business tables to secure
const tables = [
  'settings', 'branches', 'staff', 'members', 'membership_plans', 
  'memberships', 'attendance', 'invoices', 'payments', 'notifications', 
  'campaigns', 'leads', 'tasks', 'retention_events', 'equipment', 
  'reports', 'activity_logs', 'templates'
];

// Helper to determine if a string contains any of our tables
const hasTable = (str) => tables.some(t => new RegExp(`\\b${t}\\b`, 'i').test(str));

let lines = code.split('\n');

for (let i = 0; i < lines.length; i++) {
  let line = lines[i];

  if (!hasTable(line)) continue;
  
  // Skip if it already has req.tenant_id
  if (line.includes('req.tenant_id')) continue;

  // 1. Simple SELECT * FROM table -> SELECT * FROM table WHERE tenant_id = ?
  if (line.match(/SELECT\s+(.+?)\s+FROM\s+([a-zA-Z_]+)\s*["'`]?\s*[,)]?/i)) {
    // It's a select.
    if (!line.match(/WHERE/i)) {
      lines[i] = line.replace(/(FROM\s+[a-zA-Z_]+)/i, "$1 WHERE tenant_id = ?");
    } else {
      lines[i] = line.replace(/(WHERE)\s/i, "$1 tenant_id = ? AND ");
    }
    
    // Inject req.tenant_id into params
    if (lines[i].includes(']')) {
      lines[i] = lines[i].replace(/\[(.*?)\]/, (match, p1) => {
        return p1.trim() === '' ? '[req.tenant_id]' : `[req.tenant_id, ${p1}]`;
      });
    } else {
      // no params array, need to add it
      lines[i] = lines[i].replace(/\)\s*;?\s*$/, ", [req.tenant_id]);");
    }
    continue;
  }

  // 2. UPDATE table SET ...
  if (line.match(/UPDATE\s+([a-zA-Z_]+)\s+SET/i)) {
    if (!line.match(/WHERE/i)) {
      lines[i] = line.replace(/(SET\s+.*?)(["'`]?\s*[,)])/, "$1 WHERE tenant_id = ?$2");
    } else {
      lines[i] = line.replace(/(WHERE)\s/i, "$1 tenant_id = ? AND ");
    }

    if (lines[i].includes(']')) {
      lines[i] = lines[i].replace(/\[(.*?)\]/, (match, p1) => {
        // Find position of the new parameter. For UPDATE, WHERE is at the end, so tenant_id goes at the end of params.
        // Wait, if it was WHERE tenant_id = ? AND ..., then tenant_id is the FIRST param of the WHERE clause.
        // But SET has params too! UPDATE table SET a = ? WHERE tenant_id = ? AND b = ?
        // This regex approach is extremely complex for UPDATE.
        return match;
      });
    }
  }
}
