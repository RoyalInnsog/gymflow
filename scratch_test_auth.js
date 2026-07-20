const { initializeDatabase, runQuery, getQuery, allQuery } = require('./database');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

async function testSignup() {
  await initializeDatabase();
  const full_name = 'Test Admin';
  const email = 'admin@test.com';
  const password = 'Admin123!';

  try {
    const existingUser = await getQuery('SELECT id FROM users WHERE email = ?', [email]);
    if (existingUser) {
      console.log('User exists, deleting...');
      await runQuery('DELETE FROM users WHERE email = ?', [email]);
    }
    
    const hash = await bcrypt.hash(password, 10);
    const userId = 'u_' + Date.now();
    const vToken = crypto.randomBytes(32).toString('hex');
    
    const tenantId = 't_' + Date.now() + Math.floor(Math.random() * 1000);
    const gymName = full_name.split(' ')[0] + "'s Gym";
    const subdomain = full_name.toLowerCase().replace(/[^a-z0-9]/g, '') + Math.floor(Math.random() * 1000);
    
    console.log('Inserting tenant...');
    await runQuery(`INSERT INTO tenants (id, gym_name, subdomain, owner_user_id, subscription_plan) VALUES (?, ?, ?, ?, 'trial')`, 
      [tenantId, gymName, subdomain, userId]);
    
    console.log('Inserting user...');
    await runQuery(`INSERT INTO users (id, role_id, tenant_id, email, password_hash, full_name, email_verified, status, verification_token) VALUES (?, ?, ?, ?, ?, ?, 0, 'active', ?)`, 
      [userId, 'r1', tenantId, email, hash, full_name, vToken]); // r1 = System Owner
      
    console.log('Inserting settings...');
    await runQuery(`INSERT INTO settings (tenant_id, setting_key, setting_value) VALUES (?, 'gym_name', ?)`, [tenantId, gymName]);
    await runQuery(`INSERT INTO settings (tenant_id, setting_key, setting_value) VALUES (?, 'currency', '₹')`, [tenantId]);
      
    console.log('Signup successful');

    console.log('Testing Login...');
    const user = await getQuery(`SELECT users.*, roles.permissions FROM users JOIN roles ON users.role_id = roles.id WHERE email = ?`, [email]);
    if (!user) throw new Error('User not found after insert');

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) throw new Error('Password mismatch');

    console.log('Login successful');

  } catch (err) {
    console.error('ERROR TRACE:', err);
  }
}

testSignup();
