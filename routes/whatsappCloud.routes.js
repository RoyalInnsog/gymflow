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
  return (req, res, next) => {
    const perms = (req.user && Array.isArray(req.user.permissions)) ? req.user.permissions : [];
    if (perms.includes('all')) return next();
    if (required.length === 0 || required.some((p) => perms.includes(p))) return next();
    return res.status(403).json({ error: 'You do not have permission to manage WhatsApp automation.' });
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
