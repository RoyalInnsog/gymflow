const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const bcrypt = require('bcryptjs');

const dbPath = path.resolve(__dirname, 'database.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Error opening database:', err.message);
  } else {
    console.log('Connected to the SQLite database.');
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

    // Unique indexes for duplicate member protection (same tenant cannot have duplicate phone/email)
    await runQuery(`CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_phone_per_tenant ON members(tenant_id, phone)`);
    await runQuery(`CREATE UNIQUE INDEX IF NOT EXISTS idx_unique_email_per_tenant ON members(tenant_id, email)`);

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

    // Seed Owner and Manager Users
    const usersCount = await getQuery(`SELECT COUNT(*) as count FROM users`);
    if (usersCount.count === 0) {
      const ownerHash = await bcrypt.hash('admin123', 10);
      const managerHash = await bcrypt.hash('vikram123', 10);

      await runQuery(`INSERT INTO users (id, role_id, email, password_hash, full_name, email_verified, status) VALUES 
        ('u1', 'r1', 'admin@jsbfitness.in', '${ownerHash}', 'System Admin', 1, 'active'),
        ('u2', 'r2', 'manager@jsbfitness.in', '${managerHash}', 'Gym Manager', 1, 'active')
      `);
      console.log('Seeded users.');
    }

    // Seed Staff
    const staffCount = await getQuery(`SELECT COUNT(*) as count FROM staff`);
    if (staffCount.count === 0) {
      await runQuery(`INSERT INTO staff (id, user_id, name, role, email, phone, branch_id, base_salary, bonus_earned, status) VALUES 
        ('s1', 'u2', 'Vikram Singh', 'Admin', 'manager@jsbfitness.in', '+91 98765 43210', 'JSB Fitness Mumbai', 85000, 15000, 'Checked In')
      `);
      console.log('Seeded staff.');
    }

    // Seed Membership Plans (Upgraded to Monthly, Quarterly, Half-Yearly, Annual)
    const plansCount = await getQuery(`SELECT COUNT(*) as count FROM membership_plans`);
    if (plansCount.count === 0) {
      await runQuery(`INSERT INTO membership_plans (id, name, duration_months, price, tax_rate_percent, description) VALUES 
        ('p_monthly', 'Monthly Membership', 1, 1500, 18.00, 'Gym Access Only (Monthly)'),
        ('p_quarterly', 'Quarterly Power Plan', 3, 4000, 18.00, 'Full Gym Access (3 Months)'),
        ('p_half_yearly', 'Half-Yearly Value Plan', 6, 7500, 18.00, 'Gym Access + 2 Guest Passes (6 Months)'),
        ('p_annual', 'Annual Pro Elite Plan', 12, 12000, 18.00, 'Gym Access, Recovery Room, 4 PT Sessions (12 Months)')
      `);
      console.log('Seeded plans.');
    }

    const requiredPlans = [
      ['p_monthly', 'Monthly Membership', 1, 1500, 18.00, 'Gym Access Only (Monthly)'],
      ['p_quarterly', 'Quarterly Power Plan', 3, 4000, 18.00, 'Full Gym Access (3 Months)'],
      ['p_half_yearly', 'Half-Yearly Value Plan', 6, 7500, 18.00, 'Gym Access + 2 Guest Passes (6 Months)'],
      ['p_annual', 'Annual Pro Elite Plan', 12, 12000, 18.00, 'Gym Access, Recovery Room, 4 PT Sessions (12 Months)']
    ];

    for (const plan of requiredPlans) {
      const existingPlan = await getQuery(`SELECT id FROM membership_plans WHERE id = ?`, [plan[0]]);
      if (!existingPlan) {
        await runQuery(`
          INSERT INTO membership_plans (id, name, duration_months, price, tax_rate_percent, description)
          VALUES (?, ?, ?, ?, ?, ?)
        `, plan);
      }
    }

    // Seed default tenant t1 if not exists
    const t1Exists = await getQuery(`SELECT id FROM tenants WHERE id = 't1'`);
    if (!t1Exists) {
      const trialStart = new Date().toISOString();
      const trialEnd = new Date(Date.now() + 21 * 24 * 60 * 60 * 1000).toISOString();
      await runQuery(`INSERT INTO tenants (id, gym_name, subdomain, owner_user_id, subscription_plan, trial_start, trial_end, subscription_status)
                      VALUES ('t1', 'Kinetic Enterprise', 'kinetic', 'u1', 'enterprise', ?, ?, 'active')`, [trialStart, trialEnd]);
      console.log('Seeded default tenant t1.');
    }

    // Seed Settings
    const settingsCount = await getQuery(`SELECT COUNT(*) as count FROM settings`);
    if (settingsCount.count === 0) {
      await runQuery(`INSERT INTO settings (setting_key, setting_value) VALUES 
        ('gym_name', 'Kinetic Enterprise'),
        ('logo_url', ''),
        ('cover_image', ''),
        ('owner_name', 'System Admin'),
        ('support_phone', '+91 00000 00000'),
        ('email', 'admin@kinetic.app'),
        ('website', 'www.kinetic.app'),
        ('gst_number', ''),
        ('address', 'HQ Address'),
        ('city', 'City'),
        ('state', 'State'),
        ('country', 'India'),
        ('renewal_reminder_days', '7,15,30'),
        ('absent_member_alerts', '3,5,10,30'),
        ('payment_reminder_rules', '1,7,15,30'),
        ('renewal_forecast_window', '30,60,90'),
        ('upi_id', ''),
        ('account_name', ''),
        ('bank_name', ''),
        ('account_number', ''),
        ('ifsc', ''),
        ('razorpay_key_id', ''),
        ('razorpay_secret', ''),
        ('enable_cash', 'true'),
        ('enable_upi', 'true'),
        ('enable_card', 'true'),
        ('enable_bank_transfer', 'true')
      `);
      console.log('Seeded default settings.');
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
  initializeDatabase
};
