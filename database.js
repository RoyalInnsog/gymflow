const { createClient } = require('@libsql/client');
const { pathToFileURL } = require('url');
const path = require('path');
const bcrypt = require('bcryptjs');

// ---------------------------------------------------------------------------
// Database connection.
//
// Cloud (free hosting like Render, which has NO persistent disk): set
//   TURSO_DATABASE_URL (libsql://...) and TURSO_AUTH_TOKEN. Data then lives in
//   Turso — a hosted, SQLite-compatible database — so it survives every
//   restart, spin-down and redeploy.
//
// Local dev (your PC): leave those unset and it opens an on-disk SQLite file
//   exactly like before (libSQL reads the same .db format), so nothing changes
//   when you run `node server.js` locally. DATABASE_PATH still overrides the file.
// ---------------------------------------------------------------------------
function buildDbConfig() {
  if (process.env.TURSO_DATABASE_URL) {
    return { url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN };
  }
  const file = process.env.DATABASE_PATH
    ? path.resolve(process.env.DATABASE_PATH)
    : path.resolve(__dirname, 'database.db');
  return { url: pathToFileURL(file).href };
}

const usingTurso = !!process.env.TURSO_DATABASE_URL;
const db = createClient(buildDbConfig());
console.log(`Connected to the database (${usingTurso ? 'Turso cloud' : 'local SQLite file'}).`);

// Enforce referential integrity (SQLite/libSQL leave foreign keys off by
// default). Best-effort; harmless if the host manages it server-side.
db.execute('PRAGMA foreign_keys = ON').catch(() => {});

// libSQL is stricter than node-sqlite3 about bind values: undefined and JS
// booleans throw. Normalize to what the old driver tolerated (undefined -> NULL,
// boolean -> 0/1) so none of the existing call sites need to change.
function normArgs(params) {
  return params.map((p) => {
    if (p === undefined) return null;
    if (typeof p === 'boolean') return p ? 1 : 0;
    return p;
  });
}

// libSQL returns array-like Row objects; normalize to plain {column: value}
// objects so the rest of the app sees exactly what the old sqlite3 driver gave.
function rowsToObjects(rs) {
  return rs.rows.map((row) => {
    const obj = {};
    for (const col of rs.columns) obj[col] = row[col];
    return obj;
  });
}

// runQuery keeps the old sqlite3 result shape: { changes, lastID }.
async function runQuery(sql, params = []) {
  const rs = await db.execute({ sql, args: normArgs(params) });
  return {
    changes: rs.rowsAffected,
    lastID: rs.lastInsertRowid != null ? Number(rs.lastInsertRowid) : undefined,
  };
}

async function getQuery(sql, params = []) {
  const rs = await db.execute({ sql, args: normArgs(params) });
  return rowsToObjects(rs)[0];
}

async function allQuery(sql, params = []) {
  const rs = await db.execute({ sql, args: normArgs(params) });
  return rowsToObjects(rs);
}

// ============================================================
// PER-TENANT DEFAULTS
// ============================================================
// Real data, not demo data: every tenant needs its own copy of the operational
// settings the app reads strictly by tenant_id (reminder windows, payment-method
// toggles, GST config, etc.) and the discount-rule scaffold. Signup used to seed
// only gym_name + currency, so real tenants were missing renewal/payment/GST
// settings and the dashboards/automations silently fell back to nothing.
const DEFAULT_TENANT_SETTINGS = [
  ['logo_url', ''], ['cover_image', ''], ['theme_color', ''],
  ['support_phone', ''], ['support_email', ''], ['website', ''],
  ['gst_number', ''], ['address', ''], ['city', ''], ['state', ''], ['country', 'India'],
  ['renewal_reminder_days', '7,15,30'],
  ['absent_member_alerts', '3,5,10,30'],
  ['payment_reminder_rules', '1,7,15,30'],
  ['renewal_forecast_window', '30,60,90'],
  ['gst_enabled', 'false'], ['gst_percent', '18'],
  ['upi_id', ''], ['upi_name', ''],
  ['account_name', ''], ['bank_name', ''], ['account_number', ''], ['ifsc', ''],
  ['enable_cash', 'true'], ['enable_upi', 'true'], ['enable_card', 'true'], ['enable_bank_transfer', 'true']
];

const DEFAULT_DISCOUNT_RULES = [
  ['loyalty', 'Loyalty Discount'],
  ['student', 'Student Discount'],
  ['corporate', 'Corporate Discount'],
  ['promotional', 'Promotional Discount'],
  ['custom', 'Custom Discount']
];

// Idempotent (INSERT OR IGNORE) so it can backfill existing tenants on boot and
// seed brand-new ones at signup without ever clobbering a tenant's own edits.
async function seedTenantDefaults(tenantId, gymName) {
  await runQuery(`INSERT INTO settings (tenant_id, setting_key, setting_value) VALUES (?, 'gym_name', ?) ON CONFLICT DO NOTHING`, [tenantId, gymName || 'My Gym']);
  await runQuery(`INSERT INTO settings (tenant_id, setting_key, setting_value) VALUES (?, 'currency', '₹') ON CONFLICT DO NOTHING`, [tenantId]);
  for (const [k, v] of DEFAULT_TENANT_SETTINGS) {
    await runQuery(`INSERT INTO settings (tenant_id, setting_key, setting_value) VALUES (?, ?, ?) ON CONFLICT DO NOTHING`, [tenantId, k, v]);
  }
  for (const [ruleId, ruleName] of DEFAULT_DISCOUNT_RULES) {
    await runQuery(
      `INSERT INTO discount_rules (id, tenant_id, name, enabled, discount_type, amount, percent) VALUES (?, ?, ?, 0, 'amount', 0, 0) ON CONFLICT DO NOTHING`,
      [ruleId, tenantId, ruleName]
    );
  }
}

async function initializeDatabase() {
  {
    // -1. Tenants table
    await runQuery(`
      CREATE TABLE IF NOT EXISTS tenants (
        id TEXT PRIMARY KEY,
        gym_name TEXT,
        subdomain TEXT UNIQUE,
        owner_user_id TEXT,
        subscription_plan TEXT,
        subscription_status TEXT DEFAULT 'trial',
        trial_start TIMESTAMP,
        trial_end TIMESTAMP,
        status TEXT DEFAULT 'active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Onboarding columns
    try { await runQuery(`ALTER TABLE tenants ADD COLUMN tour_completed INTEGER DEFAULT 0`); } catch (e) {}
    try { await runQuery(`ALTER TABLE tenants ADD COLUMN onboarding_completed INTEGER DEFAULT 0`); } catch (e) {}
    // [TUTORIAL] Resume index for the guided product tour (0 = not started).
    try { await runQuery(`ALTER TABLE tenants ADD COLUMN tutorial_step INTEGER DEFAULT 0`); } catch (e) {}
    try { await runQuery(`ALTER TABLE tenants ADD COLUMN recommended_plan TEXT`); } catch (e) {}
    try { await runQuery(`ALTER TABLE tenants ADD COLUMN gym_type TEXT`); } catch (e) {}
    try { await runQuery(`ALTER TABLE tenants ADD COLUMN opening_time TEXT`); } catch (e) {}
    try { await runQuery(`ALTER TABLE tenants ADD COLUMN closing_time TEXT`); } catch (e) {}
    try { await runQuery(`ALTER TABLE tenants ADD COLUMN staff_count INTEGER`); } catch (e) {}
    try { await runQuery(`ALTER TABLE tenants ADD COLUMN expected_members INTEGER`); } catch (e) {}
    try { await runQuery(`ALTER TABLE tenants ADD COLUMN logo_url TEXT`); } catch (e) {}
    try { await runQuery(`ALTER TABLE tenants ADD COLUMN cover_url TEXT`); } catch (e) {}
    try { await runQuery(`ALTER TABLE tenants ADD COLUMN latitude REAL`); } catch (e) {}
    try { await runQuery(`ALTER TABLE tenants ADD COLUMN longitude REAL`); } catch (e) {}
    try { await runQuery(`ALTER TABLE tenants ADD COLUMN geofence_radius INTEGER DEFAULT 50`); } catch (e) {}

    // 0. Settings table
    await runQuery(`
      CREATE TABLE IF NOT EXISTS settings (
        setting_key TEXT,
        tenant_id TEXT,
        setting_value TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (setting_key, tenant_id)
      )
    `);

    // 0.1 Branches table
    await runQuery(`
      CREATE TABLE IF NOT EXISTS branches (
        id TEXT PRIMARY KEY,
        tenant_id TEXT,
        name TEXT,
        address TEXT,
        phone TEXT,
        manager_id TEXT,
        status TEXT DEFAULT 'Active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 1. Roles table
    await runQuery(`
      CREATE TABLE IF NOT EXISTS roles (
        id TEXT PRIMARY KEY,
        name TEXT UNIQUE,
        permissions TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    // [ORG] Org-scoped custom roles. tenant_id NULL = global system role (r1–r5);
    // non-NULL = a role an owner created for their own org. is_system protects the
    // built-ins from edit/delete. permissions JSON is kept for back-compat but the
    // normalized role_permissions table (below) is now the source of truth.
    try { await runQuery(`ALTER TABLE roles ADD COLUMN tenant_id TEXT`); } catch (e) {}
    try { await runQuery(`ALTER TABLE roles ADD COLUMN is_system INTEGER DEFAULT 0`); } catch (e) {}
    try { await runQuery(`ALTER TABLE roles ADD COLUMN description TEXT`); } catch (e) {}

    // 2. Users table
    await runQuery(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        role_id TEXT,
        email TEXT UNIQUE,
        password_hash TEXT,
        full_name TEXT,
        tenant_id TEXT,
        email_verified INTEGER DEFAULT 0,
        trial_start TIMESTAMP,
        trial_end TIMESTAMP,
        subscription_status TEXT DEFAULT 'active',
        status TEXT DEFAULT 'active',
        verification_token TEXT,
        reset_token TEXT,
        token_expiry TIMESTAMP,
        is_active INTEGER DEFAULT 1,
        last_login TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (role_id) REFERENCES roles (id)
      )
    `);

    // Add Phase 5A new fields to existing users table via ALTER
    try { await runQuery(`ALTER TABLE users ADD COLUMN full_name TEXT`); } catch (e) {}
    try { await runQuery(`ALTER TABLE users ADD COLUMN tenant_id TEXT`); } catch (e) {}
    try { await runQuery(`ALTER TABLE users ADD COLUMN email_verified INTEGER DEFAULT 0`); } catch (e) {}
    try { await runQuery(`ALTER TABLE users ADD COLUMN trial_start TIMESTAMP`); } catch (e) {}
    try { await runQuery(`ALTER TABLE users ADD COLUMN trial_end TIMESTAMP`); } catch (e) {}
    try { await runQuery(`ALTER TABLE users ADD COLUMN subscription_status TEXT DEFAULT 'active'`); } catch (e) {}
    try { await runQuery(`ALTER TABLE users ADD COLUMN status TEXT DEFAULT 'active'`); } catch (e) {}
    try { await runQuery(`ALTER TABLE users ADD COLUMN verification_token TEXT`); } catch (e) {}
    try { await runQuery(`ALTER TABLE users ADD COLUMN reset_token TEXT`); } catch (e) {}
    try { await runQuery(`ALTER TABLE users ADD COLUMN token_expiry TIMESTAMP`); } catch (e) {}
    try { await runQuery(`ALTER TABLE users ADD COLUMN updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP`); } catch (e) {}
    // [ROLES] phone is captured at registration (and add-once via /auth/phone for
    // older accounts). phone + email together are the linking key the FUTURE
    // member-claim flow will use to match a login identity to a members row.
    try { await runQuery(`ALTER TABLE users ADD COLUMN phone TEXT`); } catch (e) {}
    // [IDENTITY] Account-level security state. password_set distinguishes a real
    // password from the legacy random hash Google-provisioned accounts received;
    // new Google-only accounts get password_hash = NULL + password_set = 0 and
    // gain a password only through the explicit set-password flow.
    try { await runQuery(`ALTER TABLE users ADD COLUMN phone_verified_at TIMESTAMP`); } catch (e) {}
    try { await runQuery(`ALTER TABLE users ADD COLUMN password_set INTEGER DEFAULT 1`); } catch (e) {}
    try { await runQuery(`ALTER TABLE users ADD COLUMN password_changed_at TIMESTAMP`); } catch (e) {}

    let usersNeedMigration = false;
    try {
      await getQuery(`SELECT platform_role FROM users LIMIT 1`);
    } catch (e) {
      usersNeedMigration = true;
    }
    try { await runQuery(`ALTER TABLE users ADD COLUMN platform_role TEXT`); } catch (e) {}
    try { await runQuery(`ALTER TABLE users ADD COLUMN phone_verified INTEGER DEFAULT 0`); } catch (e) {}
    if (usersNeedMigration) {
      console.log('[migration] Backfilling platform_role = ADMIN and phone_verified = 1 for all existing accounts.');
      await runQuery(`UPDATE users SET platform_role = 'ADMIN', phone_verified = 1, phone_verified_at = COALESCE(phone_verified_at, CURRENT_TIMESTAMP)`);
    }

    // 2b. [ROLES] user_roles — one identity can hold MULTIPLE roles across
    // tenants (e.g. Owner of gym A and Member of gym B), so role is a junction
    // row, never a single global flag. users.role_id/users.tenant_id remain as
    // the legacy primary role and are mirrored here by the backfill below.
    // member_id stays NULL until the future member-claim flow links the identity
    // to its members row for that tenant.
    await runQuery(`
      CREATE TABLE IF NOT EXISTS user_roles (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        role_id TEXT NOT NULL,
        member_id TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (user_id, tenant_id, role_id),
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
        FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE,
        FOREIGN KEY (role_id) REFERENCES roles (id)
      )
    `);
    // One-time repair: a user_roles created by an early build lacked ON DELETE
    // CASCADE, which made user/tenant deletes fail against referencing role rows.
    // Rebuild with the correct FKs, preserving rows. Runs once, only when needed.
    try {
      const urSql = await getQuery(`SELECT sql FROM sqlite_master WHERE type='table' AND name='user_roles'`);
      if (urSql && !/ON DELETE CASCADE/i.test(urSql.sql)) {
        console.log('[migration] Rebuilding user_roles with ON DELETE CASCADE.');
        await runQuery('PRAGMA foreign_keys=OFF');
        await runQuery('BEGIN');
        await runQuery(`
          CREATE TABLE user_roles_new (
            id TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            tenant_id TEXT NOT NULL,
            role_id TEXT NOT NULL,
            member_id TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE (user_id, tenant_id, role_id),
            FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
            FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE,
            FOREIGN KEY (role_id) REFERENCES roles (id)
          )
        `);
        await runQuery(`INSERT INTO user_roles_new (id, user_id, tenant_id, role_id, member_id, created_at)
                        SELECT id, user_id, tenant_id, role_id, member_id, created_at FROM user_roles`);
        await runQuery('DROP TABLE user_roles');
        await runQuery('ALTER TABLE user_roles_new RENAME TO user_roles');
        await runQuery('COMMIT');
        await runQuery('PRAGMA foreign_keys=ON');
      }
    } catch (e) {
      console.error('[migration] user_roles cascade migration failed:', e.message);
      try { await runQuery('ROLLBACK'); } catch (_) {}
    }
    await runQuery(`CREATE INDEX IF NOT EXISTS idx_user_roles_user ON user_roles(user_id)`);
    await runQuery(`CREATE INDEX IF NOT EXISTS idx_user_roles_tenant ON user_roles(tenant_id)`);
    // [ORG] Membership lifecycle on the account↔org↔role junction. user_roles IS
    // "organization membership" — status gates access (only 'active' grants it),
    // and invited_by/joined_at/suspended_at/left_at + membership_history give the
    // full join/suspend/transfer/leave story without a parallel table.
    try { await runQuery(`ALTER TABLE user_roles ADD COLUMN status TEXT DEFAULT 'active'`); } catch (e) {}
    try { await runQuery(`ALTER TABLE user_roles ADD COLUMN invited_by TEXT`); } catch (e) {}
    try { await runQuery(`ALTER TABLE user_roles ADD COLUMN joined_at TIMESTAMP`); } catch (e) {}
    try { await runQuery(`ALTER TABLE user_roles ADD COLUMN suspended_at TIMESTAMP`); } catch (e) {}
    try { await runQuery(`ALTER TABLE user_roles ADD COLUMN left_at TIMESTAMP`); } catch (e) {}
    await runQuery(`CREATE INDEX IF NOT EXISTS idx_user_roles_member ON user_roles(member_id)`);

    // 3. Staff table
    await runQuery(`
      CREATE TABLE IF NOT EXISTS staff (
        id TEXT PRIMARY KEY,
        tenant_id TEXT,
        user_id TEXT,
        name TEXT,
        role TEXT,
        email TEXT,
        phone TEXT,
        branch_id TEXT,
        base_salary REAL,
        bonus_earned REAL,
        status TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users (id)
      )
    `);

    // 4. Members table
    await runQuery(`
      CREATE TABLE IF NOT EXISTS members (
        id TEXT PRIMARY KEY,
        tenant_id TEXT,
        full_name TEXT,
        phone TEXT,
        email TEXT,
        dob TEXT,
        gender TEXT,
        photo_url TEXT,
        emergency_contact_name TEXT,
        emergency_contact_phone TEXT,
        height_cm REAL,
        weight_kg REAL,
        bmi REAL,
        branch_id TEXT,
        onboarding_step INTEGER DEFAULT 1,
        status TEXT,
        primary_trainer_id TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (primary_trainer_id) REFERENCES staff (id)
      )
    `);

    // 5. Membership Plans table
    await runQuery(`
      CREATE TABLE IF NOT EXISTS membership_plans (
        id TEXT PRIMARY KEY,
        tenant_id TEXT,
        name TEXT,
        duration_months INTEGER,
        duration_days INTEGER DEFAULT 0,
        price REAL,
        tax_rate_percent REAL DEFAULT 18.00,
        joining_fee REAL DEFAULT 0,
        freeze_allowed INTEGER DEFAULT 0,
        pt_included INTEGER DEFAULT 0,
        is_active INTEGER DEFAULT 1,
        description TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    try { await runQuery(`ALTER TABLE membership_plans ADD COLUMN duration_days INTEGER DEFAULT 0`); } catch (e) {}
    try { await runQuery(`ALTER TABLE membership_plans ADD COLUMN joining_fee REAL DEFAULT 0`); } catch (e) {}
    try { await runQuery(`ALTER TABLE membership_plans ADD COLUMN freeze_allowed INTEGER DEFAULT 0`); } catch (e) {}
    try { await runQuery(`ALTER TABLE membership_plans ADD COLUMN pt_included INTEGER DEFAULT 0`); } catch (e) {}
    try { await runQuery(`ALTER TABLE membership_plans ADD COLUMN is_active INTEGER DEFAULT 1`); } catch (e) {}
    // Soft-delete flag: plans are referenced by memberships/invoices, so a hard
    // DELETE trips FK constraints. Archived plans set is_deleted=1 and are
    // excluded from every active listing while history still resolves.
    try { await runQuery(`ALTER TABLE membership_plans ADD COLUMN is_deleted INTEGER DEFAULT 0`); } catch (e) {}

    // 6. Memberships table
    await runQuery(`
      CREATE TABLE IF NOT EXISTS memberships (
        id TEXT PRIMARY KEY,
        tenant_id TEXT,
        member_id TEXT,
        plan_id TEXT,
        start_date TEXT,
        end_date TEXT,
        status TEXT,
        renewal_count INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (member_id) REFERENCES members (id),
        FOREIGN KEY (plan_id) REFERENCES membership_plans (id)
      )
    `);

    // Background Job Queue (Message Queue)
    await runQuery(`
      CREATE TABLE IF NOT EXISTS background_jobs (
        id TEXT PRIMARY KEY,
        tenant_id TEXT,
        type TEXT NOT NULL,
        payload TEXT,
        status TEXT DEFAULT 'pending',
        error TEXT,
        attempts INTEGER DEFAULT 0,
        locked_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);


    // 7. Attendance table
    await runQuery(`
      CREATE TABLE IF NOT EXISTS attendance (
        id TEXT PRIMARY KEY,
        tenant_id TEXT,
        member_id TEXT,
        check_in TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        check_out TIMESTAMP,
        verified_by_staff_id TEXT,
        access_method TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (member_id) REFERENCES members (id),
        FOREIGN KEY (verified_by_staff_id) REFERENCES staff (id)
      )
    `);

    // 8. Invoices table
    await runQuery(`
      CREATE TABLE IF NOT EXISTS invoices (
        id TEXT PRIMARY KEY,
        tenant_id TEXT,
        member_id TEXT,
        membership_id TEXT,
        invoice_number TEXT,
        subtotal REAL,
        tax_amount REAL,
        total_amount REAL,
        status TEXT,
        pdf_url TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (member_id) REFERENCES members (id),
        FOREIGN KEY (membership_id) REFERENCES memberships (id)
      )
    `);

    // 8b. [M4] Per-tenant, per-year monotonic invoice counter (atomic via
    // INSERT ... ON CONFLICT ... RETURNING) so receipt numbers never collide.
    await runQuery(`
      CREATE TABLE IF NOT EXISTS invoice_sequences (
        tenant_id TEXT NOT NULL,
        year INTEGER NOT NULL,
        last_value INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (tenant_id, year)
      )
    `);

    // 8c. [M4/L3] Legacy schema drift: older databases created invoices with a
    // GLOBAL `invoice_number TEXT UNIQUE`. Per-tenant receipt sequences (INV-2026-
    // 00001) are meant to restart per gym, so two tenants' first invoice collide on
    // a global unique. Rebuild the table so uniqueness is per-tenant
    // (UNIQUE(tenant_id, invoice_number)). Runs once, only when the old constraint
    // is detected; preserves all existing invoice rows.
    try {
      const invSql = await getQuery(`SELECT sql FROM sqlite_master WHERE type='table' AND name='invoices'`);
      if (invSql && /invoice_number\s+TEXT\s+UNIQUE/i.test(invSql.sql)) {
        console.log('[migration] Rebuilding invoices: global invoice_number UNIQUE -> per-tenant.');
        const cols = (await allQuery(`PRAGMA table_info(invoices)`)).map(c => c.name);
        const colList = cols.join(', ');
        await runQuery('PRAGMA foreign_keys=OFF');
        await runQuery('BEGIN');
        await runQuery(`
          CREATE TABLE invoices_new (
            id TEXT PRIMARY KEY,
            tenant_id TEXT,
            member_id TEXT,
            membership_id TEXT,
            invoice_number TEXT,
            subtotal REAL,
            tax_amount REAL,
            total_amount REAL,
            status TEXT,
            pdf_url TEXT,
            due_date TIMESTAMP,
            amount_due REAL,
            applied_discounts TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
          )
        `);
        // Copy only columns that exist in both tables (intersection by name).
        const newCols = ['id','tenant_id','member_id','membership_id','invoice_number','subtotal','tax_amount','total_amount','status','pdf_url','due_date','amount_due','applied_discounts','created_at'];
        const shared = newCols.filter(c => cols.includes(c));
        await runQuery(`INSERT INTO invoices_new (${shared.join(', ')}) SELECT ${shared.join(', ')} FROM invoices`);
        await runQuery('DROP TABLE invoices');
        await runQuery('ALTER TABLE invoices_new RENAME TO invoices');
        await runQuery('COMMIT');
        await runQuery('PRAGMA foreign_keys=ON');
        await runQuery(`CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_invoice_per_tenant ON invoices(tenant_id, invoice_number)`);
        console.log('[migration] invoices rebuilt with per-tenant invoice_number uniqueness.');
      } else {
        await runQuery(`CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_invoice_per_tenant ON invoices(tenant_id, invoice_number)`);
      }
    } catch (e) {
      console.error('[migration] invoices uniqueness migration failed:', e.message);
      try { await runQuery('ROLLBACK'); } catch (_) {}
    }

    // 9. Payments table
    await runQuery(`
      CREATE TABLE IF NOT EXISTS payments (
        id TEXT PRIMARY KEY,
        tenant_id TEXT,
        invoice_id TEXT,
        member_id TEXT,
        amount REAL,
        method TEXT,
        transaction_reference TEXT,
        status TEXT,
        processed_by_staff_id TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (invoice_id) REFERENCES invoices (id),
        FOREIGN KEY (member_id) REFERENCES members (id),
        FOREIGN KEY (processed_by_staff_id) REFERENCES staff (id)
      )
    `);

    // 10. Notifications table
    await runQuery(`
      CREATE TABLE IF NOT EXISTS notifications (
        id TEXT PRIMARY KEY,
        tenant_id TEXT,
        type TEXT,
        priority TEXT,
        title TEXT,
        message TEXT,
        is_read INTEGER DEFAULT 0,
        target_role_id TEXT,
        target_user_id TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (target_role_id) REFERENCES roles (id),
        FOREIGN KEY (target_user_id) REFERENCES users (id)
      )
    `);

    // Schema alterations for WhatsApp outbox logging
    try { await runQuery(`ALTER TABLE notifications ADD COLUMN recipient_name TEXT`); } catch (e) {}
    try { await runQuery(`ALTER TABLE notifications ADD COLUMN recipient_phone TEXT`); } catch (e) {}
    try { await runQuery(`ALTER TABLE notifications ADD COLUMN delivery_status TEXT DEFAULT 'Sent'`); } catch (e) {}
    try { await runQuery(`ALTER TABLE notifications ADD COLUMN campaign_source TEXT`); } catch (e) {}
    // [WHATSAPP] Real-send delivery logging: why a send failed and how many retries
    // the outbound queue performed before reaching a terminal state.
    try { await runQuery(`ALTER TABLE notifications ADD COLUMN failure_reason TEXT`); } catch (e) {}
    try { await runQuery(`ALTER TABLE notifications ADD COLUMN retry_count INTEGER DEFAULT 0`); } catch (e) {}
    // [WHATSAPP-CLOUD] Store the Cloud API message id (wamid) so inbound delivery-
    // status webhooks can reconcile the matching outbox row.
    try { await runQuery(`ALTER TABLE notifications ADD COLUMN provider_message_id TEXT`); } catch (e) {}
    try { await runQuery(`ALTER TABLE campaigns ADD COLUMN image_data TEXT`); } catch (e) {}
    
    // Schema alterations for Phase 3
    try { await runQuery(`ALTER TABLE invoices ADD COLUMN due_date TIMESTAMP`); } catch (e) {}
    try { await runQuery(`ALTER TABLE invoices ADD COLUMN amount_due REAL`); } catch (e) {}

    // [DISCOUNT-FIX] Persist the exact discount line-items that were applied to an
    // invoice. Stored as a JSON string snapshot so historical receipts keep showing
    // what was charged even if a rule is later edited or disabled.
    try { await runQuery(`ALTER TABLE invoices ADD COLUMN applied_discounts TEXT`); } catch (e) {}

    // 11. Campaigns table
    await runQuery(`
      CREATE TABLE IF NOT EXISTS campaigns (
        id TEXT PRIMARY KEY,
        tenant_id TEXT,
        name TEXT,
        channel TEXT,
        audience_filter TEXT,
        message_body TEXT,
        poster_url TEXT,
        status TEXT,
        sent_count INTEGER DEFAULT 0,
        open_rate_percent REAL DEFAULT 0.0,
        conversion_rate_percent REAL DEFAULT 0.0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 12. Leads table
    await runQuery(`
      CREATE TABLE IF NOT EXISTS leads (
        id TEXT PRIMARY KEY,
        tenant_id TEXT,
        full_name TEXT,
        phone TEXT,
        email TEXT,
        acquisition_channel TEXT,
        note TEXT,
        stage TEXT,
        trial_status TEXT,
        assigned_staff_id TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (assigned_staff_id) REFERENCES staff (id)
      )
    `);

    // 13. Tasks table
    await runQuery(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        tenant_id TEXT,
        title TEXT,
        detail TEXT,
        priority TEXT,
        due_date TIMESTAMP,
        status TEXT,
        assigned_staff_id TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (assigned_staff_id) REFERENCES staff (id)
      )
    `);

    // 14. Retention Events table
    await runQuery(`
      CREATE TABLE IF NOT EXISTS retention_events (
        id TEXT PRIMARY KEY,
        tenant_id TEXT,
        member_id TEXT,
        risk_level TEXT,
        absence_days INTEGER,
        last_contacted_at TIMESTAMP,
        contact_channel TEXT,
        notes TEXT,
        outcome TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (member_id) REFERENCES members (id)
      )
    `);

    // 15. Equipment table
    await runQuery(`
      CREATE TABLE IF NOT EXISTS equipment (
        id TEXT PRIMARY KEY,
        tenant_id TEXT,
        asset_id TEXT,
        name TEXT,
        zone TEXT,
        health_status TEXT,
        last_serviced_at TEXT,
        warranty_expiry_date TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 16. Reports table
    await runQuery(`
      CREATE TABLE IF NOT EXISTS reports (
        id TEXT PRIMARY KEY,
        tenant_id TEXT,
        type TEXT,
        date TEXT,
        data TEXT,
        manager_note TEXT,
        created_by_staff_id TEXT,
        is_locked INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (created_by_staff_id) REFERENCES staff (id)
      )
    `);

    // 17. Activity Logs table
    await runQuery(`
      CREATE TABLE IF NOT EXISTS activity_logs (
        id TEXT PRIMARY KEY,
        tenant_id TEXT,
        user_id TEXT,
        action TEXT,
        table_name TEXT,
        record_id TEXT,
        old_values TEXT,
        new_values TEXT,
        ip_address TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users (id)
      )
    `);

    // Add indexes for optimization
    await runQuery(`CREATE INDEX IF NOT EXISTS idx_members_status_branch ON members(status, branch_id)`);
    await runQuery(`CREATE INDEX IF NOT EXISTS idx_memberships_dates ON memberships(start_date, end_date)`);
    await runQuery(`CREATE INDEX IF NOT EXISTS idx_attendance_time ON attendance(check_in)`);
    await runQuery(`CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications(is_read) WHERE is_read = 0`);
    await runQuery(`CREATE INDEX IF NOT EXISTS idx_tenant_id ON settings(tenant_id)`);

    // ============================================================
    // Performance indexes — members / memberships / attendance /
    // payments / membership_plans
    // ============================================================
    //
    // Design rules:
    //   * All unique indexes on (tenant_id, ...) above are also the
    //     fastest lookup indexes for those columns, so we do NOT
    //     re-add plain (phone) or (email) indexes — they're covered.
    //   * Composite indexes are ordered by equality filters first,
    //     then range / ORDER BY columns last (SQLite left-to-prefix rule).
    //   * status is selective enough on its own to deserve a partial
    //     index for the very common WHERE status='Active' dashboard
    //     queries that scan large member tables.
    // ------------------------------------------------------------

    // --- members ---
    // (id, tenant_id) lookup: PK on id covers equality, but most
    // handlers also pass tenant_id. A composite (tenant_id, id)
    // serves both directions and matches `WHERE id=? AND tenant_id=?`.
    await runQuery(`CREATE INDEX IF NOT EXISTS idx_members_tenant_id ON members(tenant_id, id)`);

    // Phone/email search across the whole table (e.g. /attendance
    // handler that does SELECT * FROM members WHERE phone = ?).
    // Covered by the unique (tenant_id, phone/email) indexes above
    // when a tenant_id is available, but the cross-tenant phone-only
    // search path is still hot, so add a non-unique phone index too.
    await runQuery(`CREATE INDEX IF NOT EXISTS idx_members_phone ON members(phone)`);
    await runQuery(`CREATE INDEX IF NOT EXISTS idx_members_email ON members(email) WHERE email IS NOT NULL AND email != ''`);

    // Tenant-scoped status filter used by every dashboard endpoint
    // (active counts, expired counts, member directory).
    await runQuery(`CREATE INDEX IF NOT EXISTS idx_members_tenant_status ON members(tenant_id, status)`);

    // Recent-members-by-tenant listing.
    await runQuery(`CREATE INDEX IF NOT EXISTS idx_members_tenant_created ON members(tenant_id, created_at DESC)`);

    // --- memberships ---
    // Member timeline: WHERE member_id = ? ORDER BY created_at DESC
    await runQuery(`CREATE INDEX IF NOT EXISTS idx_memberships_member_created ON memberships(member_id, created_at DESC)`);

    // Status scans (active memberships, expiry scans, renewals).
    // tenant_id is included because all queries are tenant-scoped.
    await runQuery(`CREATE INDEX IF NOT EXISTS idx_memberships_tenant_status ON memberships(tenant_id, status)`);

    // Expiry window scans: status='Active' AND end_date BETWEEN ...
    await runQuery(`CREATE INDEX IF NOT EXISTS idx_memberships_status_enddate ON memberships(status, end_date)`);

    // Plan lookups (e.g. revenue by plan, JOIN membership_plans p ON ms.plan_id = p.id)
    await runQuery(`CREATE INDEX IF NOT EXISTS idx_memberships_plan ON memberships(plan_id)`);

    // --- attendance ---
    // Member timeline: WHERE member_id = ? ORDER BY check_in DESC
    await runQuery(`CREATE INDEX IF NOT EXISTS idx_attendance_member_checkin ON attendance(member_id, check_in DESC)`);

    // Tenant-scoped date-range scans (dashboard, recent attendance).
    await runQuery(`CREATE INDEX IF NOT EXISTS idx_attendance_tenant_checkin ON attendance(tenant_id, check_in DESC)`);

    // --- payments ---
    // Member payment history: WHERE member_id = ? ORDER BY created_at DESC
    await runQuery(`CREATE INDEX IF NOT EXISTS idx_payments_member_created ON payments(member_id, created_at DESC)`);

    // Invoice -> payments JOIN.
    await runQuery(`CREATE INDEX IF NOT EXISTS idx_payments_invoice ON payments(invoice_id)`);

    // Revenue / status aggregations across tenants (Successful payments).
    // Partial index keeps it tiny since most rows aren't 'Successful'.
    await runQuery(`CREATE INDEX IF NOT EXISTS idx_payments_status_created ON payments(status, created_at) WHERE status = 'Successful'`);

    // Tenant-scoped payment listing.
    await runQuery(`CREATE INDEX IF NOT EXISTS idx_payments_tenant_created ON payments(tenant_id, created_at DESC)`);

    // --- membership_plans ---
    // Tenant-scoped plan listing and active-plan filter.
    await runQuery(`CREATE INDEX IF NOT EXISTS idx_membership_plans_tenant ON membership_plans(tenant_id)`);
    await runQuery(`CREATE INDEX IF NOT EXISTS idx_membership_plans_tenant_active ON membership_plans(tenant_id, is_active)`);

    // --- Duplicate member protection ---
    // Same tenant cannot have duplicate phone numbers.
    // Same tenant cannot have duplicate emails (when email is not empty).
    // Different tenants may use the same phone/email.
    //
    // Step 1: Clean up any pre-existing duplicate records safely.
    // Keep the OLDEST member per (tenant_id, phone) and per (tenant_id, email) group;
    // re-assign or blank the duplicates so the unique index can be created.
    // PHONE duplicates (phone is required, never NULL — treat empty string as same bucket)
    try {
      await runQuery(`
        UPDATE members
        SET phone = phone || '_dup_' || id
        WHERE id IN (
          SELECT id FROM (
            SELECT id,
                   ROW_NUMBER() OVER (
                     PARTITION BY tenant_id, phone
                     ORDER BY created_at ASC, id ASC
                   ) AS rn
            FROM members
            WHERE phone IS NOT NULL AND phone != ''
          )
          WHERE rn > 1
        )
      `);
    } catch (e) {
      console.error('Failed to deduplicate phone values:', e.message);
    }

    // EMAIL duplicates (only when email is not empty)
    try {
      await runQuery(`
        UPDATE members
        SET email = NULL
        WHERE email IS NOT NULL AND email != ''
          AND id IN (
            SELECT id FROM (
              SELECT id,
                     ROW_NUMBER() OVER (
                       PARTITION BY tenant_id, email
                       ORDER BY created_at ASC, id ASC
                     ) AS rn
              FROM members
              WHERE email IS NOT NULL AND email != ''
            )
            WHERE rn > 1
          )
      `);
    } catch (e) {
      console.error('Failed to deduplicate email values:', e.message);
    }

    // Step 2: Database-level protection with partial unique indexes.
    // Phone: required, never empty — full unique on (tenant_id, phone).
    await runQuery(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_phone_per_tenant
        ON members(tenant_id, phone)
    `);
    // Email: only enforced when email is not NULL and not empty string.
    await runQuery(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_email_per_tenant
        ON members(tenant_id, email)
        WHERE email IS NOT NULL AND email != ''
    `);

    // 18. Templates table
    await runQuery(`
      CREATE TABLE IF NOT EXISTS templates (
        id TEXT PRIMARY KEY,
        tenant_id TEXT,
        name TEXT,
        message_body TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 18b. Discount Rules table
    // [DISCOUNT-FIX] One row per (rule_id, tenant_id). Rules are STRUCTURED (not
    // key/value) so the renewal flow can read a single row to apply a discount.
    // 5 fixed rule ids: loyalty, student, corporate, promotional, custom.
    // `enabled` gates whether the rule applies; `discount_type` is 'amount' | 'percent'.
    // Exactly one of (amount, percent) is meaningful per rule — enforced server-side.
    await runQuery(`
      CREATE TABLE IF NOT EXISTS discount_rules (
        id            TEXT NOT NULL,
        tenant_id     TEXT NOT NULL,
        name          TEXT,
        enabled       INTEGER DEFAULT 0,
        discount_type TEXT DEFAULT 'amount',
        amount        REAL DEFAULT 0,
        percent       REAL DEFAULT 0,
        updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id, tenant_id)
      )
    `);
    await runQuery(`CREATE INDEX IF NOT EXISTS idx_discount_rules_tenant ON discount_rules(tenant_id)`);

    // ============================================================
    // SUBSCRIPTION BILLING TABLES (Razorpay integration)
    // ============================================================

    // subscriptions: per-tenant current billing state — single row per tenant.
    await runQuery(`
      CREATE TABLE IF NOT EXISTS subscriptions (
        id TEXT PRIMARY KEY,
        tenant_id TEXT UNIQUE,
        plan TEXT NOT NULL,
        status TEXT NOT NULL,
        razorpay_customer_id TEXT,
        razorpay_subscription_id TEXT,
        razorpay_plan_id TEXT,
        start_date TIMESTAMP,
        expiry_date TIMESTAMP,
        next_billing_date TIMESTAMP,
        trial_end TIMESTAMP,
        cancelled_at TIMESTAMP,
        cancel_at_period_end INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (tenant_id) REFERENCES tenants (id)
      )
    `);

    // [BILLING] WhatsApp credit ledger + tier metadata on the per-tenant sub row.
    //   allowance  = messages included in the plan this cycle
    //   used       = messages consumed this cycle (reset on renewal/authenticated)
    //   extra_credits = purchased top-up balance (₹1/msg), NOT reset on renewal
    //   extra_credits_this_cycle = top-ups bought this cycle (enforces Pro's cap)
    //   plan_type/subscription_status mirror tenants for a single billing read
    //   has_multiple_gyms = Enterprise multi-gym capability
    try { await runQuery(`ALTER TABLE subscriptions ADD COLUMN plan_type TEXT`); } catch (e) {}
    try { await runQuery(`ALTER TABLE subscriptions ADD COLUMN subscription_status TEXT`); } catch (e) {}
    try { await runQuery(`ALTER TABLE subscriptions ADD COLUMN whatsapp_message_allowance INTEGER DEFAULT 0`); } catch (e) {}
    try { await runQuery(`ALTER TABLE subscriptions ADD COLUMN whatsapp_message_used INTEGER DEFAULT 0`); } catch (e) {}
    try { await runQuery(`ALTER TABLE subscriptions ADD COLUMN whatsapp_extra_credits INTEGER DEFAULT 0`); } catch (e) {}
    try { await runQuery(`ALTER TABLE subscriptions ADD COLUMN extra_credits_this_cycle INTEGER DEFAULT 0`); } catch (e) {}
    try { await runQuery(`ALTER TABLE subscriptions ADD COLUMN has_multiple_gyms INTEGER DEFAULT 0`); } catch (e) {}
    try { await runQuery(`ALTER TABLE subscriptions ADD COLUMN trial_ends_at TIMESTAMP`); } catch (e) {}
    try { await runQuery(`ALTER TABLE subscriptions ADD COLUMN current_period_start TIMESTAMP`); } catch (e) {}

    // subscription_history: immutable ledger of plan changes.
    await runQuery(`
      CREATE TABLE IF NOT EXISTS subscription_history (
        id TEXT PRIMARY KEY,
        tenant_id TEXT,
        from_plan TEXT,
        to_plan TEXT,
        action TEXT,
        razorpay_subscription_id TEXT,
        razorpay_payment_id TEXT,
        amount REAL,
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (tenant_id) REFERENCES tenants (id)
      )
    `);

    // billing_events: webhook delivery log + audit trail.
    await runQuery(`
      CREATE TABLE IF NOT EXISTS billing_events (
        id TEXT PRIMARY KEY,
        tenant_id TEXT,
        event_type TEXT,
        razorpay_event_id TEXT UNIQUE,
        razorpay_subscription_id TEXT,
        razorpay_payment_id TEXT,
        payload TEXT,
        status TEXT DEFAULT 'processed',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (tenant_id) REFERENCES tenants (id)
      )
    `);

    // [IDEMPOTENCY] Server-side dedup for offline-outbox retries. The client
    // stamps every mutation with an Idempotency-Key header; a request that
    // committed but whose response was lost on a dropped connection is retried,
    // and without this the retry would double-apply (dup attendance/payment/
    // member). The cached response is replayed instead. key is tenant-scoped.
    await runQuery(`
      CREATE TABLE IF NOT EXISTS idempotency_keys (
        key TEXT PRIMARY KEY,
        tenant_id TEXT,
        status INTEGER,
        response TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Backfill columns on tenants for Razorpay linkage (idempotent ALTERs).
    try { await runQuery(`ALTER TABLE tenants ADD COLUMN razorpay_customer_id TEXT`); } catch (e) {}
    try { await runQuery(`ALTER TABLE tenants ADD COLUMN razorpay_subscription_id TEXT`); } catch (e) {}
    try { await runQuery(`ALTER TABLE tenants ADD COLUMN next_billing_date TIMESTAMP`); } catch (e) {}
    try { await runQuery(`ALTER TABLE tenants ADD COLUMN cancelled_at TIMESTAMP`); } catch (e) {}

    // [GPS Geofence] Coordinates & Geofencing parameters for member attendance checks
    try { await runQuery(`ALTER TABLE tenants ADD COLUMN latitude REAL`); } catch (e) {}
    try { await runQuery(`ALTER TABLE tenants ADD COLUMN longitude REAL`); } catch (e) {}
    try { await runQuery(`ALTER TABLE tenants ADD COLUMN geofence_radius REAL DEFAULT 50.0`); } catch (e) {}
    // Geofence auto check-in: master switch + the admin's preferred radius unit
    // ('m' metres | 'ft' feet). radius is ALWAYS stored canonically in metres;
    // the unit only drives how the UI displays/collects it.
    try { await runQuery(`ALTER TABLE tenants ADD COLUMN geofence_enabled INTEGER DEFAULT 0`); } catch (e) {}
    try { await runQuery(`ALTER TABLE tenants ADD COLUMN geofence_unit TEXT DEFAULT 'm'`); } catch (e) {}

    // Set default coordinates (Bangalore center) for any legacy/null tenant entries
    try {
      await runQuery(`
        UPDATE tenants 
        SET latitude = COALESCE(latitude, 12.9715987),
            longitude = COALESCE(longitude, 77.5945627),
            geofence_radius = COALESCE(geofence_radius, 50.0)
        WHERE latitude IS NULL OR longitude IS NULL OR geofence_radius IS NULL
      `);
    } catch (e) {
      console.error('[GPS Geofence] failed to backfill coordinates:', e.message);
    }

    await runQuery(`CREATE INDEX IF NOT EXISTS idx_subscriptions_tenant ON subscriptions(tenant_id)`);
    await runQuery(`CREATE INDEX IF NOT EXISTS idx_subscriptions_rzp_sub ON subscriptions(razorpay_subscription_id)`);
    await runQuery(`CREATE INDEX IF NOT EXISTS idx_subscription_history_tenant ON subscription_history(tenant_id, created_at DESC)`);
    await runQuery(`CREATE INDEX IF NOT EXISTS idx_billing_events_tenant ON billing_events(tenant_id, created_at DESC)`);

    // [BILLING] Backfill: guarantee EVERY tenant has a subscriptions row carrying the
    // credit ledger, seeded from tenants.subscription_plan and the plan catalog. Runs
    // once per boot; idempotent (INSERT OR IGNORE + a one-time allowance sync for rows
    // that predate the ledger columns). Legacy plan names are normalized by the
    // catalog (enterprise -> enterprise_low, trial -> pro-level allowance).
    try {
      const { resolvePlan, getPlan } = require('./lib/billingPlans');
      const tenantsForBackfill = await allQuery(`SELECT id, subscription_plan, subscription_status, trial_end FROM tenants`);
      for (const t of tenantsForBackfill) {
        const canonical = resolvePlan(t.subscription_plan);
        const plan = getPlan(canonical);
        const status = t.subscription_status || (String(t.subscription_plan || '') === 'trial' ? 'trial' : 'active');
        await runQuery(
          `INSERT INTO subscriptions (id, tenant_id, plan, status, plan_type, subscription_status,
             whatsapp_message_allowance, whatsapp_message_used, whatsapp_extra_credits, extra_credits_this_cycle,
             has_multiple_gyms, trial_ends_at, current_period_start, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) ON CONFLICT DO NOTHING`,
          ['sub_' + t.id, t.id, canonical, status, canonical, status,
           plan.whatsappAllowance, plan.multiGym ? 1 : 0, t.trial_end || null]
        );
        // For rows that existed BEFORE the ledger columns: fill NULL allowance/plan_type
        // without clobbering any live used/credits counters.
        await runQuery(
          `UPDATE subscriptions
              SET plan_type = COALESCE(plan_type, ?),
                  subscription_status = COALESCE(subscription_status, ?),
                  whatsapp_message_allowance = COALESCE(whatsapp_message_allowance, ?),
                  has_multiple_gyms = COALESCE(has_multiple_gyms, ?),
                  trial_ends_at = COALESCE(trial_ends_at, ?)
            WHERE tenant_id = ? AND whatsapp_message_allowance IS NULL`,
          [canonical, status, plan.whatsappAllowance, plan.multiGym ? 1 : 0, t.trial_end || null, t.id]
        );
      }
      console.log(`[billing] Ledger backfill complete for ${tenantsForBackfill.length} tenant(s).`);
    } catch (e) {
      console.error('[billing] ledger backfill failed:', e.message);
    }

    // kiosk_tokens: multi-instance kiosk check-in tokens
    await runQuery(`
      CREATE TABLE IF NOT EXISTS kiosk_tokens (
        token TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        FOREIGN KEY (tenant_id) REFERENCES tenants (id)
      )
    `);

    // 19. Email Logs table
    await runQuery(`
      CREATE TABLE IF NOT EXISTS email_logs (
        id TEXT PRIMARY KEY,
        tenant_id TEXT,
        recipient TEXT,
        subject TEXT,
        provider TEXT,
        provider_message_id TEXT,
        status TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (tenant_id) REFERENCES tenants (id)
      )
    `);
    await runQuery(`CREATE INDEX IF NOT EXISTS idx_email_logs_tenant ON email_logs(tenant_id, created_at DESC)`);

    // ==========================================================
    // [IDENTITY] Identity-platform tables (see IDENTITY_PLATFORM.md).
    // All additive — existing logins/tokens keep working while the
    // session/verification layer moves onto these.
    // ==========================================================

    // 20. Auth sessions — one row per login, refresh-rotated, revocable.
    await runQuery(`
      CREATE TABLE IF NOT EXISTS auth_sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        refresh_hash TEXT,
        refresh_prev_hash TEXT,
        rotated_at TIMESTAMP,
        jti TEXT,
        remember INTEGER DEFAULT 0,
        scoped_tenant TEXT,
        scoped_role TEXT,
        browser TEXT,
        os TEXT,
        device_label TEXT,
        ip TEXT,
        user_agent TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_active TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        expires_at TIMESTAMP NOT NULL,
        revoked_at TIMESTAMP,
        revoke_reason TEXT,
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
      )
    `);
    await runQuery(`CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id, revoked_at)`);
    await runQuery(`CREATE INDEX IF NOT EXISTS idx_auth_sessions_refresh ON auth_sessions(refresh_hash)`);

    // [SECURITY] Distributed persistence for rate limiting and token revocation
    await runQuery(`
      CREATE TABLE IF NOT EXISTS rate_limits (
        key TEXT PRIMARY KEY,
        count INTEGER DEFAULT 1,
        expires_at INTEGER
      )
    `);
    await runQuery(`CREATE INDEX IF NOT EXISTS idx_rate_limits_expiry ON rate_limits(expires_at)`);

    await runQuery(`
      CREATE TABLE IF NOT EXISTS revoked_tokens (
        token_id TEXT PRIMARY KEY,
        type TEXT,
        expires_at INTEGER
      )
    `);
    await runQuery(`CREATE INDEX IF NOT EXISTS idx_revoked_tokens_expiry ON revoked_tokens(expires_at)`);


    // 21. External login providers linked to an account (password is a flag on
    // users, not a row here). UNIQUE(provider, provider_uid) is the global
    // "one Google identity → one account" invariant.
    await runQuery(`
      CREATE TABLE IF NOT EXISTS identity_providers (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        provider_uid TEXT NOT NULL,
        email TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_used_at TIMESTAMP,
        UNIQUE (provider, provider_uid),
        UNIQUE (user_id, provider),
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
      )
    `);

    // 22. Email verification tokens (signup + change-email): hashed, expiring,
    // single-use; a resend invalidates predecessors with an audit trail.
    await runQuery(`
      CREATE TABLE IF NOT EXISTS email_verifications (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        email TEXT NOT NULL,
        purpose TEXT NOT NULL DEFAULT 'signup',
        token_hash TEXT NOT NULL,
        expires_at TIMESTAMP NOT NULL,
        used_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
      )
    `);
    await runQuery(`CREATE INDEX IF NOT EXISTS idx_email_verifications_token ON email_verifications(token_hash)`);

    // 23. Password reset tokens — off the users row so they are single-use and
    // auditable, and a fresh request supersedes earlier ones.
    await runQuery(`
      CREATE TABLE IF NOT EXISTS password_reset_tokens (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        expires_at TIMESTAMP NOT NULL,
        used_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
      )
    `);
    await runQuery(`CREATE INDEX IF NOT EXISTS idx_password_reset_token ON password_reset_tokens(token_hash)`);

    // 24. Phone OTP verifications — phone is a verification factor, never a login.
    await runQuery(`
      CREATE TABLE IF NOT EXISTS phone_verifications (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        phone TEXT NOT NULL,
        otp_hash TEXT NOT NULL,
        attempts INTEGER DEFAULT 0,
        expires_at TIMESTAMP NOT NULL,
        verified_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
      )
    `);
    await runQuery(`CREATE INDEX IF NOT EXISTS idx_phone_verifications_user ON phone_verifications(user_id, created_at DESC)`);

    // 25. Trusted devices — long-lived device recognition for new-device alerts.
    await runQuery(`
      CREATE TABLE IF NOT EXISTS trusted_devices (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        browser TEXT,
        os TEXT,
        first_ip TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        revoked_at TIMESTAMP,
        UNIQUE (user_id, token_hash),
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
      )
    `);

    // 26. Security events — audit trail; the (email, created_at) index backs the
    // account-lockout window query (failures counted per email across IPs).
    await runQuery(`
      CREATE TABLE IF NOT EXISTS security_events (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        email TEXT,
        event TEXT NOT NULL,
        ip TEXT,
        user_agent TEXT,
        meta TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await runQuery(`CREATE INDEX IF NOT EXISTS idx_security_events_user ON security_events(user_id, created_at DESC)`);
    await runQuery(`CREATE INDEX IF NOT EXISTS idx_security_events_email ON security_events(email, created_at DESC)`);

    // 27. Password history — blocks reuse of recent passwords on change/reset.
    await runQuery(`
      CREATE TABLE IF NOT EXISTS password_history (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
      )
    `);

    // ==========================================================
    // [ORG] Organization & Identity Graph tables (see ORG_PLATFORM.md).
    // All additive; the RBAC backfill below reproduces today's permission
    // arrays exactly, so authorize() behavior is unchanged.
    // ==========================================================

    // 28. Permission catalog — one row per assignable capability.
    await runQuery(`
      CREATE TABLE IF NOT EXISTS permissions (
        key TEXT PRIMARY KEY,
        label TEXT,
        category TEXT,
        description TEXT,
        is_system INTEGER DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 29. role_permissions — the DB-driven RBAC join (supersedes roles.permissions
    // JSON as the source of truth; the JSON stays for back-compat/fallback).
    await runQuery(`
      CREATE TABLE IF NOT EXISTS role_permissions (
        id TEXT PRIMARY KEY,
        role_id TEXT NOT NULL,
        permission_key TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (role_id, permission_key),
        FOREIGN KEY (role_id) REFERENCES roles (id) ON DELETE CASCADE
      )
    `);

    // 30. Staff invitations — email + role, hashed token, expiring, single pending
    // per (org, email). Detected at login by the invitee's verified email.
    await runQuery(`
      CREATE TABLE IF NOT EXISTS invitations (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        email TEXT NOT NULL,
        role_id TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        invited_by TEXT,
        accepted_by_user_id TEXT,
        expires_at TIMESTAMP NOT NULL,
        decided_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE,
        FOREIGN KEY (role_id) REFERENCES roles (id)
      )
    `);
    await runQuery(`CREATE INDEX IF NOT EXISTS idx_invitations_email ON invitations(email, status)`);
    await runQuery(`CREATE INDEX IF NOT EXISTS idx_invitations_tenant ON invitations(tenant_id, status)`);

    // 31. Member claims — links a logging-in account to an existing member profile
    // by email/phone match. Confidence gates auto-link vs. manual approval; never
    // silently merges, never duplicates (UNIQUE below).
    await runQuery(`
      CREATE TABLE IF NOT EXISTS member_claims (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        member_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        match_basis TEXT,
        confidence TEXT,
        decided_by TEXT,
        decided_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (tenant_id, member_id, user_id),
        FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE,
        FOREIGN KEY (member_id) REFERENCES members (id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
      )
    `);
    await runQuery(`CREATE INDEX IF NOT EXISTS idx_member_claims_user ON member_claims(user_id, status)`);
    await runQuery(`CREATE INDEX IF NOT EXISTS idx_member_claims_tenant ON member_claims(tenant_id, status)`);

    // 32. Claim history — audit of each claim's state transitions.
    await runQuery(`
      CREATE TABLE IF NOT EXISTS claim_history (
        id TEXT PRIMARY KEY,
        claim_id TEXT NOT NULL,
        action TEXT NOT NULL,
        actor_user_id TEXT,
        meta TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await runQuery(`CREATE INDEX IF NOT EXISTS idx_claim_history_claim ON claim_history(claim_id, created_at)`);

    // 33. Membership history — join/role-change/suspend/leave/ownership-transfer log.
    await runQuery(`
      CREATE TABLE IF NOT EXISTS membership_history (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        action TEXT NOT NULL,
        from_role TEXT,
        to_role TEXT,
        actor_user_id TEXT,
        meta TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await runQuery(`CREATE INDEX IF NOT EXISTS idx_membership_history_tenant ON membership_history(tenant_id, created_at DESC)`);

    // 34. Organization audit logs — org-scoped audit (distinct from account-level
    // security_events): who did what to which target inside an organization.
    await runQuery(`
      CREATE TABLE IF NOT EXISTS org_audit_logs (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        actor_user_id TEXT,
        action TEXT NOT NULL,
        target_type TEXT,
        target_id TEXT,
        meta TEXT,
        ip TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await runQuery(`CREATE INDEX IF NOT EXISTS idx_org_audit_tenant ON org_audit_logs(tenant_id, created_at DESC)`);

    // 35. Geofences — GPS/attendance FOUNDATION ONLY. No engine, no logic reads this
    // yet; it exists so the future attendance/geofencing/anti-spoof layer needs no
    // migration. Per-branch location + radius the attendance engine will consume.
    await runQuery(`
      CREATE TABLE IF NOT EXISTS geofences (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        branch_id TEXT,
        name TEXT,
        latitude REAL,
        longitude REAL,
        radius_m INTEGER DEFAULT 100,
        enabled INTEGER DEFAULT 0,
        anti_spoof_enabled INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE
      )
    `);

    // 36. [U1] Member App foundation — self-service fitness data. All additive.
    // Doc-style exercises_json keeps offline sync one-record-per-plan (LWW), so a
    // plan edited on a phone in airplane mode never half-merges with the server.
    // created_by distinguishes member-authored plans from future trainer-built
    // ones ('staff') — the trainer builder plugs in without a migration.
    await runQuery(`
      CREATE TABLE IF NOT EXISTS workout_plans (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        member_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        day_of_week TEXT,
        exercises_json TEXT DEFAULT '[]',
        trainer_notes TEXT,
        created_by TEXT DEFAULT 'member',
        is_active INTEGER DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP,
        FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE,
        FOREIGN KEY (member_id) REFERENCES members (id) ON DELETE CASCADE
      )
    `);
    await runQuery(`CREATE INDEX IF NOT EXISTS idx_workout_plans_member ON workout_plans(tenant_id, member_id)`);

    await runQuery(`
      CREATE TABLE IF NOT EXISTS workout_sessions (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        member_id TEXT NOT NULL,
        plan_id TEXT,
        plan_name TEXT,
        session_date TEXT,
        duration_min INTEGER DEFAULT 0,
        completed_json TEXT DEFAULT '[]',
        total_volume_kg REAL DEFAULT 0,
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE,
        FOREIGN KEY (member_id) REFERENCES members (id) ON DELETE CASCADE
      )
    `);
    await runQuery(`CREATE INDEX IF NOT EXISTS idx_workout_sessions_member ON workout_sessions(tenant_id, member_id, session_date DESC)`);

    await runQuery(`
      CREATE TABLE IF NOT EXISTS personal_records (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        member_id TEXT NOT NULL,
        exercise TEXT NOT NULL,
        weight_kg REAL DEFAULT 0,
        reps INTEGER DEFAULT 1,
        achieved_on TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE,
        FOREIGN KEY (member_id) REFERENCES members (id) ON DELETE CASCADE
      )
    `);
    await runQuery(`CREATE INDEX IF NOT EXISTS idx_prs_member ON personal_records(tenant_id, member_id)`);

    // One row per member per day; POST /member/health upserts against this key so
    // offline replays of the same day's log can never create duplicates server-side.
    await runQuery(`
      CREATE TABLE IF NOT EXISTS health_logs (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        member_id TEXT NOT NULL,
        log_date TEXT NOT NULL,
        weight_kg REAL,
        water_ml INTEGER DEFAULT 0,
        calories INTEGER DEFAULT 0,
        protein_g REAL DEFAULT 0,
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP,
        UNIQUE(tenant_id, member_id, log_date),
        FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE,
        FOREIGN KEY (member_id) REFERENCES members (id) ON DELETE CASCADE
      )
    `);
    await runQuery(`CREATE INDEX IF NOT EXISTS idx_health_logs_member ON health_logs(tenant_id, member_id, log_date DESC)`);

    // [Health Connect] Add columns for Health Connect metrics
    try { await runQuery(`ALTER TABLE health_logs ADD COLUMN steps INTEGER DEFAULT 0`); } catch (e) {}
    try { await runQuery(`ALTER TABLE health_logs ADD COLUMN sleep_minutes INTEGER DEFAULT 0`); } catch (e) {}
    try { await runQuery(`ALTER TABLE health_logs ADD COLUMN heart_rate REAL`); } catch (e) {}
    try { await runQuery(`ALTER TABLE health_logs ADD COLUMN systolic REAL`); } catch (e) {}
    try { await runQuery(`ALTER TABLE health_logs ADD COLUMN diastolic REAL`); } catch (e) {}
    try { await runQuery(`ALTER TABLE members ADD COLUMN health_connect_linked INTEGER DEFAULT 0`); } catch (e) {}

    await runQuery(`
      CREATE TABLE IF NOT EXISTS body_measurements (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        member_id TEXT NOT NULL,
        measured_on TEXT,
        chest_cm REAL,
        waist_cm REAL,
        hips_cm REAL,
        biceps_cm REAL,
        thigh_cm REAL,
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE,
        FOREIGN KEY (member_id) REFERENCES members (id) ON DELETE CASCADE
      )
    `);
    await runQuery(`CREATE INDEX IF NOT EXISTS idx_measurements_member ON body_measurements(tenant_id, member_id, measured_on DESC)`);

    await runQuery(`
      CREATE TABLE IF NOT EXISTS member_goals (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        member_id TEXT NOT NULL,
        title TEXT NOT NULL,
        target_value TEXT,
        status TEXT DEFAULT 'active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP,
        FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE,
        FOREIGN KEY (member_id) REFERENCES members (id) ON DELETE CASCADE
      )
    `);
    await runQuery(`CREATE INDEX IF NOT EXISTS idx_member_goals_member ON member_goals(tenant_id, member_id)`);

    // [DIET] Per-meal nutrition ledger (the AI photo scanner + manual meal logs).
    // health_logs stays the daily-total source of truth; these rows are the
    // itemized breakdown behind it. items_json holds the AI's per-item estimates.
    await runQuery(`
      CREATE TABLE IF NOT EXISTS nutrition_logs (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        member_id TEXT NOT NULL,
        log_date TEXT NOT NULL,
        name TEXT NOT NULL,
        portion TEXT,
        calories INTEGER DEFAULT 0,
        protein_g REAL DEFAULT 0,
        carbs_g REAL DEFAULT 0,
        fat_g REAL DEFAULT 0,
        source TEXT DEFAULT 'manual',
        items_json TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE,
        FOREIGN KEY (member_id) REFERENCES members (id) ON DELETE CASCADE
      )
    `);
    await runQuery(`CREATE INDEX IF NOT EXISTS idx_nutrition_logs_member ON nutrition_logs(tenant_id, member_id, log_date DESC)`);

    // Helpful indexes for claim matching (email/phone lookups against members).
    await runQuery(`CREATE INDEX IF NOT EXISTS idx_members_email ON members(email)`);
    await runQuery(`CREATE INDEX IF NOT EXISTS idx_members_phone ON members(phone)`);

    // [WHATSAPP-CLOUD] Per-gym WhatsApp automation preferences.
    // -------------------------------------------------------------------------
    // The platform sends every WhatsApp message from ONE centralized Meta Cloud
    // API number (Gymflow-managed credentials in env). This table does NOT hold
    // those global credentials — it holds each gym's independent on/off switches
    // for the four automation categories plus their custom message templates.
    // tenant_id is the gym id (one row per gym). api_key_placeholder is reserved
    // (nullable) for a future per-gym override / custom routing / BYO number.
    await runQuery(`
      CREATE TABLE IF NOT EXISTS gym_whatsapp_settings (
        id TEXT PRIMARY KEY,
        tenant_id TEXT UNIQUE,
        api_key_placeholder TEXT,
        fee_reminder_enabled INTEGER DEFAULT 0,
        festival_greetings_enabled INTEGER DEFAULT 0,
        health_check_enabled INTEGER DEFAULT 0,
        welcome_invoice_enabled INTEGER DEFAULT 0,
        fee_reminder_template TEXT,
        festival_greetings_template TEXT,
        health_check_template TEXT,
        welcome_invoice_template TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (tenant_id) REFERENCES tenants (id) ON DELETE CASCADE
      )
    `);
    await runQuery(`CREATE INDEX IF NOT EXISTS idx_gym_whatsapp_settings_tenant ON gym_whatsapp_settings(tenant_id)`);
    // Additive template columns (safe on pre-existing databases — ignore if present).
    try { await runQuery(`ALTER TABLE gym_whatsapp_settings ADD COLUMN fee_reminder_template TEXT`); } catch (e) {}
    try { await runQuery(`ALTER TABLE gym_whatsapp_settings ADD COLUMN festival_greetings_template TEXT`); } catch (e) {}
    try { await runQuery(`ALTER TABLE gym_whatsapp_settings ADD COLUMN health_check_template TEXT`); } catch (e) {}
    try { await runQuery(`ALTER TABLE gym_whatsapp_settings ADD COLUMN welcome_invoice_template TEXT`); } catch (e) {}

    console.log('All tables and indexes created.');

    // Seed Roles
    const rolesCount = await getQuery(`SELECT COUNT(*) as count FROM roles`);
    if (rolesCount.count === 0) {
      await runQuery(`INSERT INTO roles (id, name, permissions) VALUES 
        ('r1', 'Owner', '["all"]'),
        ('r2', 'Manager', '["bi:read", "finance:read", "members:write", "attendance:write", "tasks:write"]'),
        ('r3', 'Trainer', '["members:read", "tasks:write"]'),
        ('r4', 'Admin', '["members:read", "attendance:write", "payments:write"]')
      `);
      console.log('Seeded roles.');
    }

    // [ROLES] Member role — seeded idempotently OUTSIDE the count===0 block so
    // existing databases (already holding r1-r4) gain it too. Members hold only
    // the self-service permission; the API-layer staff gate (requireStaffRole in
    // server.js) rejects this role on every admin/tenant endpoint regardless.
    await runQuery(`INSERT INTO roles (id, name, permissions) VALUES ('r5', 'Member', '["member:self"]') ON CONFLICT DO NOTHING`);

    // [ROLES] Backfill: mirror every existing user's legacy primary role
    // (users.role_id + users.tenant_id) into user_roles so multi-role lookups
    // have one uniform source. Idempotent via deterministic id + UNIQUE.
    // Guard the FK targets: legacy DBs contain orphan users whose tenant was
    // deleted (old suite cleanups) — those rows cannot be mirrored.
    const roleBackfill = await runQuery(`
      INSERT OR IGNORE INTO user_roles (id, user_id, tenant_id, role_id)
      SELECT 'ur_' || id || '_' || tenant_id || '_' || role_id, id, tenant_id, role_id
      FROM users
      WHERE tenant_id IS NOT NULL AND role_id IS NOT NULL
        AND tenant_id IN (SELECT id FROM tenants)
        AND role_id IN (SELECT id FROM roles)
    `);
    if (roleBackfill && roleBackfill.changes > 0) {
      console.log(`[roles] Backfilled ${roleBackfill.changes} user role assignment(s) into user_roles.`);
    }

    // [ORG] ---- Database-driven RBAC migration (non-regressive by construction) ----
    // 1) Curated permission catalog (nice labels for a future custom-role editor).
    const PERMISSION_CATALOG = [
      ['all', 'Full access', 'Organization', 'Every capability in the organization'],
      ['members:read', 'View members', 'Members', 'See member profiles and lists'],
      ['members:write', 'Manage members', 'Members', 'Add, edit and remove members'],
      ['members:claim:approve', 'Approve member claims', 'Members', 'Review and approve member self-claims'],
      ['payments:write', 'Collect payments', 'Finance', 'Record payments, renewals and collections'],
      ['finance:read', 'View finance', 'Finance', 'See financial summaries and transactions'],
      ['bi:read', 'View analytics', 'Analytics', 'See business intelligence dashboards'],
      ['attendance:write', 'Manage attendance', 'Attendance', 'Record and edit attendance'],
      ['tasks:write', 'Manage tasks', 'Operations', 'Create and complete tasks'],
      ['settings:write', 'Manage settings', 'Settings', 'Change gym settings, plans and exports'],
      ['staff:write', 'Manage staff', 'Staff', 'Add and edit staff records'],
      ['staff:invite', 'Invite staff', 'Staff', 'Send email invitations to staff'],
      ['roles:manage', 'Manage roles', 'Staff', 'Create custom roles and assign permissions'],
      ['branches:write', 'Manage branches', 'Organization', 'Add and edit branches'],
      ['org:manage', 'Manage organization', 'Organization', 'Membership, ownership and org settings'],
      ['member:self', 'Member self-service', 'Member', 'A member managing their own profile']
    ];
    for (const [key, label, category, description] of PERMISSION_CATALOG) {
      await runQuery(`INSERT INTO permissions (key, label, category, description, is_system) VALUES (?, ?, ?, ?, 1) ON CONFLICT DO NOTHING`,
        [key, label, category, description]);
    }
    // 2) Populate role_permissions from each role's existing permissions JSON, so
    //    resolvePermissions() reproduces the current JWT array EXACTLY. Any string
    //    not already in the catalog is added (union), guaranteeing completeness.
    //    Only runs while role_permissions is empty (first migration) — after that
    //    the table is the source of truth and must not be clobbered by JSON edits.
    const rpCount = await getQuery(`SELECT COUNT(*) AS c FROM role_permissions`);
    if (!rpCount || rpCount.c === 0) {
      const allRoles = await allQuery(`SELECT id, permissions FROM roles`);
      for (const role of allRoles) {
        let perms = [];
        try { perms = JSON.parse(role.permissions || '[]'); } catch (e) { perms = []; }
        for (const key of perms) {
          await runQuery(`INSERT INTO permissions (key, label, category, is_system) VALUES (?, ?, 'Other', 1) ON CONFLICT DO NOTHING`, [key, key]);
          await runQuery(`INSERT INTO role_permissions (id, role_id, permission_key) VALUES (?, ?, ?) ON CONFLICT DO NOTHING`,
            ['rp_' + role.id + '_' + key.replace(/[^a-z0-9]/gi, ''), role.id, key]);
        }
      }
      console.log('[org] Backfilled role_permissions from role JSON (RBAC now DB-driven).');
    }
    // 3) Mark the built-in roles as system (protect from edit/delete).
    await runQuery(`UPDATE roles SET is_system = 1 WHERE id IN ('r1','r2','r3','r4','r5') AND (is_system IS NULL OR is_system = 0)`);
    // 4) Backfill membership lifecycle on existing user_roles rows.
    await runQuery(`UPDATE user_roles SET status = 'active' WHERE status IS NULL`);
    await runQuery(`UPDATE user_roles SET joined_at = created_at WHERE joined_at IS NULL`);

    // [IDENTITY] Normalize legacy emails to lowercase so lookups (which now
    // normalize their input) always match and the password/Google paths can never
    // fork one human into two accounts on letter case. Collision-guarded: two
    // accounts differing only by case are left untouched and logged for review.
    const mixedCaseEmails = await allQuery(`SELECT id, email FROM users WHERE email IS NOT NULL AND email <> lower(email)`);
    for (const u of mixedCaseEmails) {
      const clash = await getQuery(`SELECT id FROM users WHERE email = ? AND id <> ?`, [u.email.toLowerCase(), u.id]);
      if (clash) { console.warn(`[identity] Email case collision left unmigrated: user ${u.id}`); continue; }
      await runQuery(`UPDATE users SET email = lower(email) WHERE id = ?`, [u.id]);
    }
    if (mixedCaseEmails.length > 0) console.log(`[identity] Normalized ${mixedCaseEmails.length} legacy email(s) to lowercase.`);

    // [C4 FIX] No seeded human/admin accounts and no default passwords.
    // The first Owner account is created exclusively via the public signup flow
    // (POST /api/v1/auth/signup). We also purge any legacy hard-coded backdoor
    // accounts that may already exist in an older database file (idempotent).
    const purged = await runQuery(
      `DELETE FROM users WHERE id IN ('u1', 'u2') OR email IN ('admin@jsbfitness.in', 'manager@jsbfitness.in')`
    );
    if (purged && purged.changes > 0) {
      console.log(`Removed ${purged.changes} legacy seeded backdoor account(s).`);
    }

    // [DEMO-DATA] No seeded demo staff. The old seed created "Vikram Singh"
    // linked to the removed backdoor account (manager@jsbfitness.in). Staff are
    // created per-tenant through Staff Management.

    // [DEMO-DATA] No global demo membership plans. The old seed inserted four
    // tenant_id=NULL plans (Monthly/Quarterly/…) that no real tenant could ever
    // see (all plan reads are scoped by tenant_id). Plans are now created per gym
    // through Settings → Membership Plans / onboarding.

    // [L5] System/platform tenant `t1` is the inbox that receives SaaS billing
    // notifications (UPI subscription requests). It is NOT a demo gym — it has no
    // owner login and holds no member data. Seed it with an explicit, valid plan/
    // status so it is never reported as a NULL-plan "active enterprise" anomaly.
    const t1Exists = await getQuery(`SELECT id FROM tenants WHERE id = 't1'`);
    if (!t1Exists) {
      await runQuery(`INSERT INTO tenants (id, gym_name, subdomain, owner_user_id, subscription_plan, subscription_status)
                      VALUES ('t1', 'Gym Flow', 'platform', NULL, 'enterprise', 'active')`);
      console.log('Seeded platform tenant t1.');
    } else {
      // Repair an older t1 that was left with a NULL/trial plan — the platform
      // tenant is always a valid active enterprise account.
      await runQuery(`UPDATE tenants SET subscription_plan = 'enterprise', subscription_status = 'active' WHERE id = 't1'`);
    }

    // [L6] One-time cleanup of orphaned rows with a NULL tenant_id (left behind by
    // pre-isolation writes). They belong to no tenant and are invisible to every
    // tenant-scoped query, so they are pure dead data — remove them.
    for (const tbl of ['members', 'attendance', 'memberships', 'payments', 'invoices', 'leads', 'tasks']) {
      try {
        const res = await runQuery(`DELETE FROM ${tbl} WHERE tenant_id IS NULL`);
        if (res && res.changes > 0) console.log(`[L6] Removed ${res.changes} orphan NULL-tenant row(s) from ${tbl}.`);
      } catch (e) { /* table may not exist yet */ }
    }

    // [REAL-DATA] Backfill the full default settings + discount-rule scaffold for
    // EVERY existing tenant (idempotent). Previously only gym_name + currency were
    // seeded at signup, so live tenants were missing reminder windows, GST config
    // and payment-method toggles that the dashboards/automation read by tenant_id.
    const tenantRows = await allQuery(`SELECT id, gym_name FROM tenants`);
    for (const t of tenantRows) {
      await seedTenantDefaults(t.id, t.gym_name);
    }
    if (tenantRows.length > 0) {
      console.log(`Backfilled settings + discount_rules for ${tenantRows.length} tenant(s).`);
    }

    // [MIGRATION] Grandfather operating gyms past the mandatory setup wizard.
    // The legacy onboarding module never executed (dead DOMContentLoaded listener),
    // so onboarding_completed stayed 0 even for long-established tenants. Any
    // tenant that already has a membership plan is clearly past first-time setup —
    // forcing the wizard on them would create duplicate plans. Idempotent.
    const grandfathered = await runQuery(`
      UPDATE tenants SET onboarding_completed = 1
      WHERE onboarding_completed = 0
        AND id IN (SELECT DISTINCT tenant_id FROM membership_plans WHERE tenant_id IS NOT NULL)
    `);
    if (grandfathered && grandfathered.changes > 0) {
      console.log(`Grandfathered ${grandfathered.changes} tenant(s) past the setup wizard.`);
    }

    // Seed Templates with INSERT OR REPLACE to update existing ones
    await runQuery(`INSERT INTO templates (id, name, message_body) VALUES ('welcome', 'Welcome Message', 'Hello *{name}*, welcome to *{gym_name}*! Your profile is set up. Let''s crush those fitness goals! 💪') ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, message_body = EXCLUDED.message_body,
      ('expiry', 'Renewal Reminder', 'Hi *{name}*, this is a friendly reminder from *{gym_name}*. Your {plan_name} membership will expire in *{days_left}* days. Renew today to keep training! 🏋️‍♂️'),
      ('payment', 'Payment Reminder', 'Hi *{name}*, you have a pending payment of *₹{amount_due}* at *{gym_name}*. Please clear it at your earliest convenience. Thank you!'),
      ('inactive', 'Absent Member Alert', 'Hello *{name}*, we missed you at *{gym_name}*! You haven''t checked in for *{days_left}* days. Is everything okay? Let us know if you need any help getting back on track! 🤝'),
      ('promotional', 'Promotional Campaign', 'Dear *{name}*, warm greetings from *{gym_name}*! Celebrate this festival season with a healthy lifestyle. Special 20% discount on annual renewals this week! 🌟'),
      ('lead', 'Lead Follow-Up', 'Hi *{name}*, thank you for visiting *{gym_name}*! Let us know if you are ready to start your fitness journey. 🏆'),
      ('birthday', 'Birthday Greetings', 'Happy Birthday *{name}*! 🎂 Warmest wishes from *{gym_name}*. Have a fantastic day and keep crushing those goals! 🎉')
    `);
    console.log('Updated templates.');
  }
}

module.exports = {
  db,
  runQuery,
  getQuery,
  allQuery,
  initializeDatabase,
  seedTenantDefaults
};
