const fs = require('fs');
const path = require('path');

function processFile(filePath) {
    if (!filePath.endsWith('.js')) return;
    if (filePath.includes('node_modules') || filePath.includes('scratch_')) return;
    
    let content = fs.readFileSync(filePath, 'utf8');
    let original = content;

    content = content.replace(/INSERT\s+OR\s+IGNORE\s+INTO\s+([A-Za-z0-9_]+)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/gi, (match, table, cols, vals) => {
        return `INSERT INTO ${table} (${cols}) VALUES (${vals}) ON CONFLICT DO NOTHING`;
    });

    content = content.replace(/INSERT\s+OR\s+REPLACE\s+INTO\s+([A-Za-z0-9_]+)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/gi, (match, table, cols, vals) => {
        const colArray = cols.split(',').map(c => c.trim());
        let conflictTarget = 'id';
        if (table === 'settings') conflictTarget = 'tenant_id, setting_key';
        if (table === 'discount_rules') conflictTarget = 'tenant_id, id';
        if (table === 'rate_limits') conflictTarget = 'key';
        if (table === 'templates') conflictTarget = 'id';
        
        const updateSets = colArray.filter(c => c !== 'id' && c !== 'tenant_id' && c !== 'key').map(c => `${c} = EXCLUDED.${c}`).join(', ');
        
        return `INSERT INTO ${table} (${cols}) VALUES (${vals}) ON CONFLICT (${conflictTarget}) DO UPDATE SET ${updateSets}`;
    });

    if (content !== original) {
        fs.writeFileSync(filePath, content);
        console.log("Updated", filePath);
    }
}

function walkDir(dir) {
    const files = fs.readdirSync(dir);
    for (const file of files) {
        const fullPath = path.join(dir, file);
        if (fs.statSync(fullPath).isDirectory()) {
            walkDir(fullPath);
        } else {
            processFile(fullPath);
        }
    }
}

walkDir(__dirname);
