const fs = require('fs');

let content = fs.readFileSync('./database.js', 'utf8');

// The file was mangled. Let's find the wrong block at line 844 and remove it.
content = content.replace(/function normArgs\(params\).*?\/\/ PER-TENANT DEFAULTS\s*\/\/ ============================================================/s, '');

// Now let's inject it correctly at the top, after the db connection logic
content = content.replace(/console\.log\('Connected to PostgreSQL database\.'\);\s*\n/, `console.log('Connected to PostgreSQL database.');

function normArgs(params) {
  return params.map((p) => {
    if (p === undefined) return null;
    return p;
  });
}

async function runQuery(sql, params = []) {
  let counter = 1;
  const pgSql = sql.replace(/\\?/g, () => '$' + counter++);
  const rs = await db.query(pgSql, normArgs(params));
  return {
    changes: rs.rowCount,
    lastID: undefined, 
  };
}

async function getQuery(sql, params = []) {
  let counter = 1;
  const pgSql = sql.replace(/\\?/g, () => '$' + counter++);
  const rs = await db.query(pgSql, normArgs(params));
  return rs.rows[0];
}

async function allQuery(sql, params = []) {
  let counter = 1;
  const pgSql = sql.replace(/\\?/g, () => '$' + counter++);
  const rs = await db.query(pgSql, normArgs(params));
  return rs.rows;
}

// ============================================================
// PER-TENANT DEFAULTS
// ============================================================
`);

fs.writeFileSync('./database.js', content);
console.log("Fixed database.js");
