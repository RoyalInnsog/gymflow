const db = require('./database');

(async () => {
  const userId = 'u_1781861248032';
  const roles = await db.allQuery(
    `SELECT ur.tenant_id, ur.role_id, r.name AS role_name, r.permissions, t.gym_name
       FROM user_roles ur
       JOIN roles r ON r.id = ur.role_id
       JOIN tenants t ON t.id = ur.tenant_id
      WHERE ur.user_id = ?`, [userId]);
  console.log('User roles:', roles);
  // Also check the user row
  const user = await db.getQuery(`SELECT * FROM users WHERE id = ?`, [userId]);
  console.log('User:', user);
})();