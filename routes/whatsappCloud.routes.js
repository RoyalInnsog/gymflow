/**
 * WhatsApp Cloud API Routes (gym-facing settings dashboard)
 * -----------------------------------------------------------------------------
 * Mounted in server.js at `/api/v1/whatsapp` and `/api/whatsapp` BEHIND
 * authenticateToken + requireTenant + requireStaffRole. Mutations additionally
 * require the `settings:write` permission (owner/manager/admin) — mirroring the
 * rest of the Settings surface, so plain staff tokens can't flip automations.
 *
 * The PUBLIC webhook (/api/whatsapp/webhook) is NOT mounted here — it is wired
 * un-authenticated in server.js because Meta calls it directly.
 */

const express = require('express');
const router = express.Router();
const controller = require('../controllers/whatsappCloud.controller');

// Local RBAC gate (mirrors authorize() in routes/api.js).
function authorize(...required) {
  return async (req, res, next) => {
    try {
      let perms = [];
      if (req.tenant_id && req.user && req.user.id) {
        const { getQuery, allQuery } = require('../database');
        const rows = await allQuery(
          `SELECT r.permissions FROM user_roles ur 
           JOIN roles r ON r.id = ur.role_id 
           WHERE ur.user_id = ? AND ur.tenant_id = ? AND (ur.status IS NULL OR ur.status = 'active')`, 
          [req.user.id, req.tenant_id]
        );
        if (rows.length > 0) {
          for (const row of rows) {
            try { perms.push(...JSON.parse(row.permissions || '[]')); } catch(e){}
          }
        } else {
          const legacy = await getQuery(
            `SELECT r.permissions FROM users JOIN roles r ON r.id = users.role_id WHERE users.id = ? AND users.tenant_id = ?`,
            [req.user.id, req.tenant_id]
          );
          if (legacy) try { perms = JSON.parse(legacy.permissions || '[]'); } catch(e){}
        }
      } else {
        perms = (req.user && Array.isArray(req.user.permissions)) ? req.user.permissions : [];
      }
      
      if (perms.includes('all')) return next();
      if (required.length === 0 || required.some(p => perms.includes(p))) return next();
      return res.status(403).json({ error: 'You do not have permission to perform this action.' });
    } catch (err) {
      console.error('[Authz] Error:', err);
      return res.status(403).json({ error: 'Permission check failed.' });
    }
  };
}
const requireManager = authorize('settings:write');

// Reads — manager/admin only (keeps masked credentials off staff tokens).
router.get('/status', requireManager, controller.getStatus);
router.get('/settings', requireManager, controller.getSettings);

// Mutations — manager/admin only.
router.put('/settings', requireManager, controller.updateSettings);
router.post('/test', requireManager, controller.sendTest);
router.post('/festival/send', requireManager, controller.sendFestival);

module.exports = router;
