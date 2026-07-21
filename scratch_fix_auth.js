const fs = require('fs');

let content = fs.readFileSync('./lib/identity/core.js', 'utf8');

// I need to put back what was deleted, exactly at the spot.
// It deleted the end of authenticateToken, requireTenant, MEMBER_ROLE_ID and STAFF_ROLE_IDS.

const deletedCode = `  });
}

function requireTenant(req, res, next) {
  if (!req.user || !req.user.tenant_id) {
    return res.status(403).json({ error: 'Tenant isolation violation. Valid tenant required.' });
  }
  req.tenant_id = req.user.tenant_id;
  
  // RLS Context injection
  const { tenantContext } = require('../../database');
  if (tenantContext) {
    tenantContext.run(req.tenant_id, () => {
      next();
    });
  } else {
    next();
  }
}

// [ROLES] Server-side role spine. Role is decided server-side and baked into the
// JWT at login / select-role; the client can never choose a role.
const MEMBER_ROLE_ID = 'r5';
const STAFF_ROLE_IDS = new Set(['r1', 'r2', 'r3', 'r4']);`;

content = content.replace(/req\.authToken = user; \/\/ decoded payload \(incl\. jti\/sid\) for logout revocation\n    next\(\);\n\n\/\/ \[SEC\] Fail-closed staff gate for the ENTIRE tenant-scoped API surface\./s, `req.authToken = user; // decoded payload (incl. jti/sid) for logout revocation
    next();
${deletedCode}

// [SEC] Fail-closed staff gate for the ENTIRE tenant-scoped API surface.`);

fs.writeFileSync('./lib/identity/core.js', content);
console.log("Fixed core.js");
