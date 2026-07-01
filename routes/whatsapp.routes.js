/**
 * WhatsApp Routes
 * -----------------------------------------------------------------------------
 * Mounted in server.js under `/api/v1/whatsapp` BEHIND authenticateToken +
 * requireTenant, so every request here already has a verified user and tenant.
 * Connection management additionally requires the `settings:write` permission
 * (owner/manager/admin), matching the rest of the Settings surface — staff
 * tokens cannot generate a QR, reconnect, or disconnect.
 */

const express = require('express');
const router = express.Router();
const controller = require('../controllers/whatsapp.controller');

// Local copy of the RBAC gate (mirrors authorize() in routes/api.js). Owners hold
// the wildcard "all"; managers/admins are granted via the required permission.
function authorize(...required) {
  return (req, res, next) => {
    const perms = (req.user && Array.isArray(req.user.permissions)) ? req.user.permissions : [];
    if (perms.includes('all')) return next();
    if (required.length === 0 || required.some((p) => perms.includes(p))) return next();
    return res.status(403).json({ error: 'You do not have permission to manage WhatsApp.' });
  };
}

const requireManager = authorize('settings:write');

// Read state — manager/admin only.
router.get('/status', requireManager, controller.getStatus);
router.get('/qr', requireManager, controller.getQr);

// Mutations — manager/admin only.
router.post('/connect', requireManager, controller.connect);
router.post('/disconnect', requireManager, controller.disconnect);

module.exports = router;
