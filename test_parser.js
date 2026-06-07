const { Parser } = require('node-sql-parser');
const parser = new Parser();

const sql1 = `SELECT ms.id as membership_id, ms.member_id, ms.end_date, m.full_name, m.phone 
      FROM memberships ms
      JOIN members m ON ms.member_id = m.id
      WHERE ms.status = 'Active'`;

try {
  let ast = parser.astify(sql1);
  
  // Inject into WHERE
  const tenantCond = {
    type: 'binary_expr',
    operator: '=',
    left: { type: 'column_ref', table: 'ms', column: 'tenant_id' },
    right: { type: 'string', value: 't1' }
  };
  
  if (ast[0].where) {
    ast[0].where = {
      type: 'binary_expr',
      operator: 'AND',
      left: tenantCond,
      right: ast[0].where
    };
  } else {
    ast[0].where = tenantCond;
  }
  
  let newSql = parser.sqlify(ast);
  console.log("Original:", sql1);
  console.log("Rewritten:", newSql);
} catch (e) {
  console.error("Parse error:", e);
}
