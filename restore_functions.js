const fs = require('fs');
let code = fs.readFileSync('routes/api.js', 'utf8');

// The regex correctly finds await ( `...` ) or await ( `...`, [...] )
let replaced = code.replace(/await\s*\(\s*\`([\s\S]*?)\`\s*(?:,\s*(\[.*?\]))?\s*\)/g, (match, sql, params) => {
  let fnName = 'allQuery';
  let upperSql = sql.trim().toUpperCase();
  if (upperSql.startsWith('INSERT') || upperSql.startsWith('UPDATE') || upperSql.startsWith('DELETE')) {
    fnName = 'runQuery';
  } else if (upperSql.startsWith('SELECT')) {
    if (upperSql.includes('COUNT(*)') || (upperSql.includes('SUM(') && !upperSql.includes('GROUP BY'))) {
       fnName = 'getQuery';
    } else if (upperSql.includes(' ID = ?') || upperSql.includes(' LIMIT 1')) {
       fnName = 'getQuery';
    } else {
       fnName = 'allQuery';
    }
  }
  
  if (params) {
    return `await ${fnName}(\`${sql}\`, ${params})`;
  } else {
    return `await ${fnName}(\`${sql}\`)`;
  }
});

// There is one exception! line 508 has "id = ?" in lowercase, so I should do upperSql.includes(' ID = ?') 
fs.writeFileSync('routes/api.js', replaced);
console.log('Fixed function names successfully.');
