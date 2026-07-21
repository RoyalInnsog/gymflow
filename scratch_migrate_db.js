const fs = require('fs');

let content = fs.readFileSync('./database.js', 'utf8');

// Replace auto-increment
content = content.replace(/INTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT/gi, 'SERIAL PRIMARY KEY');

// Replace DATETIME with TIMESTAMP
content = content.replace(/DATETIME/g, 'TIMESTAMP');

// Replace INSERT OR IGNORE in create table block if any
// But mainly replace them in the insert functions.
content = content.replace(/INSERT\s+OR\s+IGNORE\s+INTO\s+(\w+)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/gi, (match, table, cols, vals) => {
    return `INSERT INTO ${table} (${cols}) VALUES (${vals}) ON CONFLICT DO NOTHING`;
});

// For INSERT OR REPLACE, it's tricky because we need the conflict target. 
// Typically it's 'id' or a unique constraint.
// We can try to guess it based on the table name or just leave it for manual fixing, 
// but manual fixing 50 occurrences is hard. 
// In GYM Flow, most tables have 'id' as PRIMARY KEY.
content = content.replace(/INSERT\s+OR\s+REPLACE\s+INTO\s+(\w+)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/gi, (match, table, cols, vals) => {
    const colArray = cols.split(',').map(c => c.trim());
    let conflictTarget = 'id';
    
    // Some exceptions
    if (table === 'settings') conflictTarget = 'tenant_id, setting_key';
    if (table === 'discount_rules') conflictTarget = 'tenant_id, id';
    if (table === 'rate_limits') conflictTarget = 'key';
    
    const updateSets = colArray.filter(c => c !== 'id' && c !== 'tenant_id').map(c => `${c} = EXCLUDED.${c}`).join(', ');
    
    return `INSERT INTO ${table} (${cols}) VALUES (${vals}) ON CONFLICT (${conflictTarget}) DO UPDATE SET ${updateSets}`;
});

fs.writeFileSync('./database_pg.js', content);
console.log("Written to database_pg.js");
