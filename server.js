const express = require('express');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const path = require('path');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
// [C4 FIX] Load environment variables from .env before anything else reads process.env
require('dotenv').config();
const { initializeDatabase, getQuery, runQuery, allQuery } = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;
// [C4 FIX] JWT secret loaded from environment variable.
// Set JWT_SECRET in a .env file or your deployment environment.
// The fallback string is for local development only and must NOT be used in production.
const JWT_SECRET = process.env.JWT_SECRET || 'kinetic-dev-secret-do-not-use-in-production';
const SECURITY_ENABLED = true; // Set to true to re-enable authentication screens and session checks

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(cors());

// Serve static assets inside screen folders (like images or specific style assets)
app.use(express.static(__dirname));

// Initialize database
initializeDatabase().then(() => {
  console.log('Database initialized successfully.');
}).catch((err) => {
  console.error('Failed to initialize database:', err);
});

// Authentication middleware
function authenticateToken(req, res, next) {
  if (!SECURITY_ENABLED) {
    // Trusted local owner device mode bypass
    req.user = { id: 'u1', email: 'admin@kinetic.app', role_id: 'r1', tenant_id: 't1', permissions: ['all'] };
    return next();
  }

  const token = req.cookies.auth_token;
  if (!token) {
    return res.status(401).json({ error: 'Unauthorized access. Session token required.' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid or expired session token.' });
    }
    req.user = user;
    next();
  });
}

// Tenant isolation middleware
function requireTenant(req, res, next) {
  if (!req.user || !req.user.tenant_id) {
    return res.status(403).json({ error: 'Tenant isolation violation. Valid tenant required.' });
  }
  req.tenant_id = req.user.tenant_id;
  next();
}

// Redirect root to dashboard
app.get('/', (req, res) => {
  if (!SECURITY_ENABLED) {
    return res.redirect('/dashboard');
  }
  const token = req.cookies.auth_token;
  if (token) {
    res.redirect('/dashboard');
  } else {
    res.redirect('/login');
  }
});

// ==========================================
// CLEAN FRONTEND ROUTES
// ==========================================

const pages = [
  { route: '/login', dir: 'login_kinetic_enterprise' },
  { route: '/login-alt', dir: 'elite_performance_gym_management' },
  { route: '/signup', dir: 'signup_kinetic_enterprise' },
  { route: '/forgot-password', dir: 'forgot_password_kinetic_enterprise' },
  { route: '/reset-password', dir: 'reset_password_kinetic_enterprise' },
  { route: '/verify-email', dir: 'verify_email_kinetic_enterprise' },
  { route: '/dashboard', dir: 'dashboard_kinetic_enterprise' },
  { route: '/bi', dir: 'business_intelligence_kinetic_enterprise' },
  { route: '/members', dir: 'member_directory_kinetic_enterprise' },
  { route: '/member-profile', dir: 'member_profile_kinetic_enterprise' },
  { route: '/member-communication', dir: 'member_profile_communication_kinetic_enterprise' },
  { route: '/member-timeline', dir: 'member_timeline_kinetic_enterprise' },
  { route: '/member-qr', dir: 'member_qr_card_kinetic_enterprise' },
  { route: '/add-member', dir: 'add_member_kinetic_enterprise' },
  { route: '/add-member-step-1', dir: 'add_member_step_1_kinetic_enterprise' },
  { route: '/attendance', dir: 'attendance_kinetic_enterprise' },
  { route: '/finance', dir: 'finance_kinetic_enterprise' },
  { route: '/payment-center', dir: 'payment_center_kinetic_enterprise' },
  { route: '/payment-recovery', dir: 'payment_recovery_kinetic_enterprise' },
  { route: '/activity-log', dir: 'activity_log_kinetic_enterprise' },
  { route: '/renew', dir: 'renew_membership_kinetic_enterprise' },
  { route: '/receipt', dir: 'membership_receipt_kinetic_enterprise' },
  { route: '/daily-closing', dir: 'daily_closing_report_kinetic_enterprise' },
  { route: '/marketing', dir: 'marketing_kinetic_enterprise' },
  { route: '/expiry-management', dir: 'expiry_management_kinetic_enterprise' },
  { route: '/retention', dir: 'retention_dashboard_kinetic_enterprise' },
  { route: '/lead-crm', dir: 'lead_crm_kinetic_enterprise' },
  { route: '/settings', dir: 'settings_kinetic_enterprise' },
  { route: '/staff', dir: 'staff_management_kinetic_enterprise' },
  { route: '/tasks', dir: 'task_management_kinetic_enterprise' },
  { route: '/notifications', dir: 'notifications_kinetic_enterprise' },
  { route: '/equipment', dir: 'equipment_inventory_kinetic_enterprise' }
];

// Direct page redirects (Phase 2.5 route consolidation)
app.get('/executive-dashboard', (req, res) => res.redirect('/dashboard'));
app.get('/business-dashboard', (req, res) => res.redirect('/dashboard'));

const publicRoutes = ['/login', '/login-alt', '/signup', '/forgot-password', '/reset-password', '/verify-email'];

pages.forEach(p => {
  app.get(p.route, (req, res) => {
    if (!SECURITY_ENABLED && publicRoutes.includes(p.route)) {
      return res.redirect('/dashboard');
    }

    if (SECURITY_ENABLED && !publicRoutes.includes(p.route)) {
      const token = req.cookies.auth_token;
      if (!token) {
        return res.redirect('/login');
      }
      try {
        jwt.verify(token, JWT_SECRET);
      } catch (err) {
        res.clearCookie('auth_token');
        return res.redirect('/login');
      }
    }

    res.sendFile(path.join(__dirname, p.dir, 'code.html'));
  });
});

// ==========================================
// AUTHENTICATION APIs
// ==========================================

// Login API
app.post('/api/v1/auth/login', async (req, res) => {
  const { email, password, remember } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }

  try {
    const user = await getQuery(`SELECT users.*, roles.permissions FROM users JOIN roles ON users.role_id = roles.id WHERE email = ?`, [email]);
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      return res.status(401).json({ error: 'Invalid credentials.' });
    }

    if (!user.is_active || user.status !== 'active') {
      return res.status(403).json({ error: 'This account has been suspended.' });
    }

    if (!user.email_verified) {
      return res.status(403).json({ error: 'Please verify your email address before logging in.' });
    }

    // Update last login
    await runQuery(`UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?`, [user.id]);

    const token = jwt.sign(
      { id: user.id, email: user.email, role_id: user.role_id, tenant_id: user.tenant_id, permissions: JSON.parse(user.permissions) },
      JWT_SECRET,
      { expiresIn: remember ? '30d' : '8h' }
    );

    // Save cookie
    res.cookie('auth_token', token, {
      httpOnly: true,
      secure: false, // Set to true if HTTPS is enabled
      maxAge: remember ? 30 * 24 * 60 * 60 * 1000 : 8 * 60 * 60 * 1000
    });

    res.json({ message: 'Authorization successful.', user: { email: user.email, role_id: user.role_id } });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Internal system authorization failure.' });
  }
});

app.post('/api/v1/auth/signup', async (req, res) => {
  const { full_name, email, password } = req.body;
  if (!full_name || !email || !password) return res.status(400).json({ error: 'All fields are required.' });
  
  try {
    const existingUser = await getQuery('SELECT id FROM users WHERE email = ?', [email]);
    if (existingUser) return res.status(400).json({ error: 'Email already exists.' });
    
    const hash = await bcrypt.hash(password, 10);
    const userId = 'u_' + Date.now();
    const vToken = crypto.randomBytes(32).toString('hex');
    
    const trialStart = new Date().toISOString();
    const trialEnd = new Date(Date.now() + 21 * 24 * 60 * 60 * 1000).toISOString(); // 21 days
    
    const tenantId = 't_' + Date.now() + Math.floor(Math.random() * 1000);
    const gymName = full_name.split(' ')[0] + "'s Gym";
    const subdomain = full_name.toLowerCase().replace(/[^a-z0-9]/g, '') + Math.floor(Math.random() * 1000);
    
    await runQuery(`INSERT INTO tenants (id, gym_name, subdomain, owner_user_id, subscription_plan, trial_start, trial_end, subscription_status) VALUES (?, ?, ?, ?, 'trial', ?, ?, 'trial')`, 
      [tenantId, gymName, subdomain, userId, trialStart, trialEnd]);
    
    // Create owner user
    await runQuery(`INSERT INTO users (id, role_id, tenant_id, email, password_hash, full_name, email_verified, status, verification_token) VALUES (?, ?, ?, ?, ?, ?, 0, 'active', ?)`, 
      [userId, 'r1', tenantId, email, hash, full_name, vToken]); // r1 = System Owner
      
    // Seed initial settings
    await runQuery(`INSERT INTO settings (tenant_id, setting_key, setting_value) VALUES (?, 'gym_name', ?)`, [tenantId, gymName]);
    await runQuery(`INSERT INTO settings (tenant_id, setting_key, setting_value) VALUES (?, 'currency', '₹')`, [tenantId]);
      
    console.log(`[SIMULATED EMAIL] To: ${email} | Subject: Verify Account | Link: http://localhost:${PORT}/verify-email?token=${vToken}`);
    res.json({ message: 'Signup successful. Please verify email.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create account.' });
  }
});

app.get('/api/v1/auth/verify-email', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).json({ error: 'Missing token' });
  try {
    const user = await getQuery('SELECT id FROM users WHERE verification_token = ?', [token]);
    if (!user) return res.status(400).json({ error: 'Invalid or expired token' });
    
    await runQuery(`UPDATE users SET email_verified = 1, verification_token = NULL WHERE id = ?`, [user.id]);
    res.json({ message: 'Email verified successfully.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to verify email.' });
  }
});

app.post('/api/v1/auth/forgot-password', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });
  try {
    const user = await getQuery('SELECT id FROM users WHERE email = ?', [email]);
    if (user) {
      const resetToken = crypto.randomBytes(32).toString('hex');
      const expiry = new Date(Date.now() + 3600000).toISOString(); // 1 hr
      await runQuery('UPDATE users SET reset_token = ?, token_expiry = ? WHERE id = ?', [resetToken, expiry, user.id]);
      console.log(`[SIMULATED EMAIL] To: ${email} | Subject: Reset Password | Link: http://localhost:${PORT}/reset-password?token=${resetToken}`);
    }
    res.json({ message: 'Reset link sent if email exists.' });
  } catch (err) {
    res.status(500).json({ error: 'Error processing request.' });
  }
});

app.post('/api/v1/auth/reset-password', async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) return res.status(400).json({ error: 'Token and password required' });
  try {
    const user = await getQuery('SELECT id FROM users WHERE reset_token = ? AND token_expiry > CURRENT_TIMESTAMP', [token]);
    if (!user) return res.status(400).json({ error: 'Invalid or expired token.' });
    
    const hash = await bcrypt.hash(password, 10);
    await runQuery('UPDATE users SET password_hash = ?, reset_token = NULL, token_expiry = NULL WHERE id = ?', [hash, user.id]);
    res.json({ message: 'Password updated successfully.' });
  } catch (err) {
    res.status(500).json({ error: 'Error resetting password.' });
  }
});

// Logout API
app.post('/api/v1/auth/logout', (req, res) => {
  res.clearCookie('auth_token');
  res.json({ message: 'Session terminated successfully.' });
});

// Session Check API
app.get('/api/v1/auth/session', authenticateToken, async (req, res) => {
  try {
    const tenant = await getQuery(`SELECT subscription_plan, trial_start, trial_end, subscription_status FROM tenants WHERE id = ?`, [req.user.tenant_id]);
    res.json({ 
      user: req.user,
      tenant: tenant || { subscription_plan: 'trial', subscription_status: 'trial' }
    });
  } catch (err) {
    res.json({ 
      user: req.user,
      tenant: { subscription_plan: 'trial', subscription_status: 'trial' }
    });
  }
});

// Mount APIs with tenant isolation
const apiRouter = require('./routes/api');
app.use('/api/v1', authenticateToken, requireTenant, apiRouter);

// ==========================================
// START SERVER
// ==========================================
// Dev server trigger restart comment
app.listen(PORT, () => {
  console.log(`JSB Fitness Gym Management running at http://localhost:${PORT}`);
});
