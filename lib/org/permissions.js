/*
 * [ORG] Database-driven RBAC resolution. The effective permission-key array for a
 * role comes from the normalized role_permissions table; it falls back to the
 * role's legacy permissions JSON only for a role the backfill hasn't populated.
 * This is the ONLY place permission resolution lives — getUserRoles calls it, so
 * the JWT `permissions` array and every authorize() call site stay unchanged.
 */
const { allQuery, getQuery, runQuery } = require('../../database');
const crypto = require('crypto');

async function resolvePermissions(roleId) {
  const rows = await allQuery(`SELECT permission_key FROM role_permissions WHERE role_id = ?`, [roleId]);
  if (rows.length > 0) return rows.map(r => r.permission_key);
  const role = await getQuery(`SELECT permissions FROM roles WHERE id = ?`, [roleId]);
  if (role && role.permissions) { try { return JSON.parse(role.permissions); } catch (e) { return []; } }
  return [];
}

// Resolve several roles in one round trip (used when projecting a user's whole
// role list). Returns { roleId: [keys...] }.
async function resolvePermissionsForRoles(roleIds) {
  const ids = [...new Set(roleIds)].filter(Boolean);
  if (!ids.length) return {};
  const placeholders = ids.map(() => '?').join(',');
  const rows = await allQuery(
    `SELECT role_id, permission_key FROM role_permissions WHERE role_id IN (${placeholders})`, ids);
  const map = {};
  for (const id of ids) map[id] = [];
  for (const r of rows) map[r.role_id].push(r.permission_key);
  for (const id of ids) {
    if (map[id].length === 0) {
      const role = await getQuery(`SELECT permissions FROM roles WHERE id = ?`, [id]);
      if (role && role.permissions) { try { map[id] = JSON.parse(role.permissions); } catch (e) { /* keep [] */ } }
    }
  }
  return map;
}

// The assignable catalog (for a custom-role editor). 'all' is intentionally
// omitted — it is the owner wildcard, not an à-la-carte permission.
async function catalog() {
  return allQuery(`SELECT key, label, category, description FROM permissions WHERE key <> 'all' ORDER BY category, label`);
}

// Replace a role's permission set (custom roles only; system roles are protected
// by the caller). Rewrites role_permissions and mirrors into the legacy JSON so
// any code still reading roles.permissions stays consistent.
async function setRolePermissions(roleId, keys) {
  const clean = [...new Set((keys || []).filter(k => typeof k === 'string' && k))];
  await runQuery(`DELETE FROM role_permissions WHERE role_id = ?`, [roleId]);
  for (const key of clean) {
    await runQuery(`INSERT INTO role_permissions (id, role_id, permission_key) VALUES (?, ?, ?) ON CONFLICT DO NOTHING`,
      ['rp_' + crypto.randomBytes(6).toString('hex'), roleId, key]);
  }
  await runQuery(`UPDATE roles SET permissions = ? WHERE id = ?`, [JSON.stringify(clean), roleId]);
  return clean;
}

module.exports = { resolvePermissions, resolvePermissionsForRoles, catalog, setRolePermissions };
