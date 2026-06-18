const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const bcrypt = require('bcryptjs');

const dbPath = path.resolve(__dirname, 'database.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Error opening database:', err.message);
  } else {
    console.log('Connected to the SQLite database.');
    // [REL] Concurrency hardening for the Node.js + SQLite combo.
    //  * WAL lets readers run concurrently with a writer (no more reader/writer
    //    lock contention during the morning check-in rush).
    //  * busy_timeout makes a blocked writer wait-and-retry for up to 5s instead
    //    of immediately throwing SQLITE_BUSY when another write is in flight.
    //  * NORMAL synchronous is the safe, fast pairing for WAL.
    //  * foreign_keys enforces referential integrity (off by default in SQLite).
    db.serialize(() => {
      db.run('PRAGMA journal_mode = WAL');
      db.run('PRAGMA busy_timeout = 5000');
      db.run('PRAGMA synchronous = NORMAL');
      db.run('PRAGMA foreign_keys = ON');
    });
  }
});

function runQuery(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function getQuery(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function allQuery(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
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
  await runQuery(`INSERT OR IGNORE INTO settings (tenant_id, setting_key, setting_value) VALUES (?, 'gym_name', ?)`, [tenantId, gymName || 'My Gym']);
  await runQuery(`INSERT OR IGNORE INTO settings (tenant_id, setting_key, setting_value) VALUES (?, 'currency', '₹')`, [tenantId]);
  for (const [k, v] of DEFAULT_TENANT_SETTINGS) {
    await runQuery(`INSERT OR IGNORE INTO settings (tenant_id, setting_key, setting_value) VALUES (?, ?, ?)`, [tenantId, k, v]);
  }
  for (const [ruleId, ruleName] of DEFAULT_DISCOUNT_RULES) {
    await runQuery(
      `INSERT OR IGNORE INTO discount_rules (id, tenant_id, name, enabled, discount_type, amount, percent)
       VALUES (?, ?, ?, 0, 'amount', 0, 0)`,
      [ruleId, tenantId, ruleName]
    );
  }
}

async function initializeDatabase() {
  db.serialize(async () => {
    // -1. Tenants table
    await runQuery(`
      CREATE TABLE IF NOT EXISTS tenants (
        id TEXT PRIMARY KEY,
        gym_name TEXT,
        subdomain TEXT UNIQUE,
        owner_user_id TEXT,
        subscription_plan TEXT,
        subscription_status TEXT DEFAULT 'trial',
        trial_start DATETIME,
        trial_end DATETIME,
        status TEXT DEFAULT 'active',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Onboarding columns
    try { await runQuery(`ALTER TABLE tenants ADD COLUMN tour_completed INTEGER DEFAULT 0`); } catch (e) {}
    try { await runQuery(`ALTER TABLE tenants ADD COLUMN onboarding_completed INTEGER DEFAULT 0`); } catch (e) {}
    try { await runQuery(`ALTER TABLE tenants ADD COLUMN recommended_plan TEXT`); } catch (e) {}
    try { await runQuery(`ALTER TABLE tenants ADD COLUMN gym_type TEXT`); } catch (e) {}
    try { await runQuery(`ALTER TABLE tenants ADD COLUMN opening_time TEXT`); } catch (e) {}
    try { await runQuery(`ALTER TABLE tenants ADD COLUMN closing_time TEXT`); } catch (e) {}
    try { await runQuery(`ALTER TABLE tenants ADD COLUMN staff_count INTEGER`); } catch (e) {}
    try { await runQuery(`ALTER TABLE tenants ADD COLUMN expected_members INTEGER`); } catch (e) {}
    try { await runQuery(`ALTER TABLE tenants ADD COLUMN logo_url TEXT`); } catch (e) {}
    try { await runQuery(`ALTER TABLE tenants ADD COLUMN cover_url TEXT`); } catch (e) {}

    // 0. Settings table
    await runQuery(`
      CREATE TABLE IF NOT EXISTS settings (
        setting_key TEXT,
        tenant_id TEXT,
        setting_value TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
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
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // 1. Roles table
    await runQuery(`
      CREATE TABLE IF NOT EXISTS roles (
        id TEXT PRIMARY KEY,
        name TEXT UNIQUE,
        permissions TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

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
        trial_start DATETIME,
        trial_end DATETIME,
        subscription_status TEXT DEFAULT 'active',
        status TEXT DEFAULT 'active',
        verification_token TEXT,
        reset_token TEXT,
        token_expiry DATETIME,
        is_active INTEGER DEFAULT 1,
        last_login DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (role_id) REFERENCES roles (id)
      )
    `);

    // Add Phase 5A new fields to existing users table via ALTER
    try { await runQuery(`ALTER TABLE users ADD COLUMN full_name TEXT`); } catch (e) {}
    try { await runQuery(`ALTER TABLE users ADD COLUMN tenant_id TEXT`); } catch (e) {}
    try { await runQuery(`ALTER TABLE users ADD COLUMN email_verified INTEGER DEFAULT 0`); } catch (e) {}
    try { await runQuery(`ALTER TABLE users ADD COLUMN trial_start DATETIME`); } catch (e) {}
    try { await runQuery(`ALTER TABLE users ADD COLUMN trial_end DATETIME`); } catch (e) {}
    try { await runQuery(`ALTER TABLE users ADD COLUMN subscription_status TEXT DEFAULT 'active'`); } catch (e) {}
    try { await runQuery(`ALTER TABLE users ADD COLUMN status TEXT DEFAULT 'active'`); } catch (e) {}
    try { await runQuery(`ALTER TABLE users ADD COLUMN verification_token TEXT`); } catch (e) {}
    try { await runQuery(`ALTER TABLE users ADD COLUMN reset_token TEXT`); } catch (e) {}
    try { await runQuery(`ALTER TABLE users ADD COLUMN token_expiry DATETIME`); } catch (e) {}
    try { await runQuery(`ALTER TABLE users ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP`); } catch (e) {}

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
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
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
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
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
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);

    try { await runQuery(`ALTER TABLE membership_plans ADD COLUMN duration_days INTEGER DEFAULT 0`); } catch (e) {}
    try { await runQuery(`ALTER TABLE membership_plans ADD COLUMN joining_fee REAL DEFAULT 0`); } catch (e) {}
    try { await runQuery(`ALTER TABLE membership_plans ADD COLUMN freeze_allowed INTEGER DEFAULT 0`); } catch (e) {}
    try { await runQuery(`ALTER TABLE membership_plans ADD COLUMN pt_included INTEGER DEFAULT 0`); } catch (e) {}
    try { await runQuery(`ALTER TABLE membership_plans ADD COLUMN is_active INTEGER DEFAULT 1`); } catch (e) {}

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
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (member_id) REFERENCES members (id),
        FOREIGN KEY (plan_id) REFERENCES membership_plans (id)
      )
    `);

    // 7. Attendance table
    await runQuery(`
      CREATE TABLE IF NOT EXISTS attendance (
        id TEXT PRIMARY KEY,
        tenant_id TEXT,
        member_id TEXT,
        check_in DATETIME DEFAULT CURRENT_TIMESTAMP,
        check_out DATETIME,
        verified_by_staff_id TEXT,
        access_method TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
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
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
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
            due_date DATETIME,
            amount_due REAL,
            applied_discounts TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
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
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
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
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (target_role_id) REFERENCES roles (id),
        FOREIGN KEY (target_user_id) REFERENCES users (id)
      )
    `);

    // Schema alterations for WhatsApp outbox logging
    try { await runQuery(`ALTER TABLE notifications ADD COLUMN recipient_name TEXT`); } catch (e) {}
    try { await runQuery(`ALTER TABLE notifications ADD COLUMN recipient_phone TEXT`); } catch (e) {}
    try { await runQuery(`ALTER TABLE notifications ADD COLUMN delivery_status TEXT DEFAULT 'Sent'`); } catch (e) {}
    try { await runQuery(`ALTER TABLE notifications ADD COLUMN campaign_source TEXT`); } catch (e) {}
    try { await runQuery(`ALTER TABLE campaigns ADD COLUMN image_data TEXT`); } catch (e) {}
    
    // Schema alterations for Phase 3
    try { await runQuery(`ALTER TABLE invoices ADD COLUMN due_date DATETIME`); } catch (e) {}
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
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
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
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
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
        due_date DATETIME,
        status TEXT,
        assigned_staff_id TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
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
        last_contacted_at DATETIME,
        contact_channel TEXT,
        notes TEXT,
        outcome TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
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
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
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
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
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
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
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
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
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
        updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
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
        start_date DATETIME,
        expiry_date DATETIME,
        next_billing_date DATETIME,
        trial_end DATETIME,
        cancelled_at DATETIME,
        cancel_at_period_end INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (tenant_id) REFERENCES tenants (id)
      )
    `);

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
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
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
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (tenant_id) REFERENCES tenants (id)
      )
    `);

    // Backfill columns on tenants for Razorpay linkage (idempotent ALTERs).
    try { await runQuery(`ALTER TABLE tenants ADD COLUMN razorpay_customer_id TEXT`); } catch (e) {}
    try { await runQuery(`ALTER TABLE tenants ADD COLUMN razorpay_subscription_id TEXT`); } catch (e) {}
    try { await runQuery(`ALTER TABLE tenants ADD COLUMN next_billing_date DATETIME`); } catch (e) {}
    try { await runQuery(`ALTER TABLE tenants ADD COLUMN cancelled_at DATETIME`); } catch (e) {}

    await runQuery(`CREATE INDEX IF NOT EXISTS idx_subscriptions_tenant ON subscriptions(tenant_id)`);
    await runQuery(`CREATE INDEX IF NOT EXISTS idx_subscriptions_rzp_sub ON subscriptions(razorpay_subscription_id)`);
    await runQuery(`CREATE INDEX IF NOT EXISTS idx_subscription_history_tenant ON subscription_history(tenant_id, created_at DESC)`);
    await runQuery(`CREATE INDEX IF NOT EXISTS idx_billing_events_tenant ON billing_events(tenant_id, created_at DESC)`);

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
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (tenant_id) REFERENCES tenants (id)
      )
    `);
    await runQuery(`CREATE INDEX IF NOT EXISTS idx_email_logs_tenant ON email_logs(tenant_id, created_at DESC)`);

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

    // Seed Templates with INSERT OR REPLACE to update existing ones
    await runQuery(`INSERT OR REPLACE INTO templates (id, name, message_body) VALUES 
      ('welcome', 'Welcome Message', 'Hello *{name}*, welcome to *{gym_name}*! Your profile is set up. Let''s crush those fitness goals! 💪'),
      ('expiry', 'Renewal Reminder', 'Hi *{name}*, this is a friendly reminder from *{gym_name}*. Your {plan_name} membership will expire in *{days_left}* days. Renew today to keep training! 🏋️‍♂️'),
      ('payment', 'Payment Reminder', 'Hi *{name}*, you have a pending payment of *₹{amount_due}* at *{gym_name}*. Please clear it at your earliest convenience. Thank you!'),
      ('inactive', 'Absent Member Alert', 'Hello *{name}*, we missed you at *{gym_name}*! You haven''t checked in for *{days_left}* days. Is everything okay? Let us know if you need any help getting back on track! 🤝'),
      ('promotional', 'Promotional Campaign', 'Dear *{name}*, warm greetings from *{gym_name}*! Celebrate this festival season with a healthy lifestyle. Special 20% discount on annual renewals this week! 🌟'),
      ('lead', 'Lead Follow-Up', 'Hi *{name}*, thank you for visiting *{gym_name}*! Let us know if you are ready to start your fitness journey. 🏆'),
      ('birthday', 'Birthday Greetings', 'Happy Birthday *{name}*! 🎂 Warmest wishes from *{gym_name}*. Have a fantastic day and keep crushing those goals! 🎉')
    `);
    console.log('Updated templates.');
  });
}

module.exports = {
  db,
  runQuery,
  getQuery,
  allQuery,
  initializeDatabase,
  seedTenantDefaults
};
