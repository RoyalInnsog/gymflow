const fs = require('fs');

let content = fs.readFileSync('./database_pg.js', 'utf8');

// Replace libSQL import with pg
content = content.replace(/const\s+\{\s*createClient\s*\}\s*=\s*require\('@libsql\/client'\);/, "const { Pool } = require('pg');");

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

// Replace runQuery
content = content.replace(/async function runQuery\(sql, params = \[\]\) \{[\s\S]*?return \{[\s\S]*?changes: rs\.rowsAffected,[\s\S]*?lastID: rs\.lastInsertRowid != null \? Number\(rs\.lastInsertRowid\) : undefined,[\s\S]*?\};\n\}/, `async function runQuery(sql, params = []) {
  // Translate ? to $1, $2, etc.
  let counter = 1;
  const pgSql = sql.replace(/\\?/g, () => '$' + counter++);
  const rs = await db.query(pgSql, normArgs(params));
  return {
    changes: rs.rowCount,
    lastID: undefined, // Postgres uses RETURNING id for last insert
  };
}`);

// Replace getQuery
content = content.replace(/async function getQuery\(sql, params = \[\]\) \{[\s\S]*?const rs = await db\.execute\(\{ sql, args: normArgs\(params\) \}\);[\s\S]*?return rowsToObjects\(rs\)\[0\];\n\}/, `async function getQuery(sql, params = []) {
  let counter = 1;
  const pgSql = sql.replace(/\\?/g, () => '$' + counter++);
  const rs = await db.query(pgSql, normArgs(params));
  return rs.rows[0];
}`);

// Replace allQuery
content = content.replace(/async function allQuery\(sql, params = \[\]\) \{[\s\S]*?const rs = await db\.execute\(\{ sql, args: normArgs\(params\) \}\);[\s\S]*?return rowsToObjects\(rs\);\n\}/, `async function allQuery(sql, params = []) {
  let counter = 1;
  const pgSql = sql.replace(/\\?/g, () => '$' + counter++);
  const rs = await db.query(pgSql, normArgs(params));
  return rs.rows;
}`);

// Remove rowsToObjects because pg returns rows natively as objects
content = content.replace(/function rowsToObjects\(rs\) \{[\s\S]*?\}\n/, '');

// Fix normArgs to not break on pg
content = content.replace(/function normArgs\(params\) \{[\s\S]*?\}\n/, `function normArgs(params) {
  return params.map((p) => {
    if (p === undefined) return null;
    return p;
  });
}`);

fs.writeFileSync('./database.js', content);
console.log("Written to database.js");
