const { runQuery, getQuery } = require('./database.js');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

async function testSignup() {
  const full_name = 'Test Admin 5';
  const email = 'testadmin9995@jsbfitness.in';
  const password = 'Password123!';
  
  try {
    const existingUser = await getQuery('SELECT id FROM users WHERE email = ?', [email]);
    if (existingUser) return console.log('Email exists');
    
    console.log('Hashing password...');
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
      [userId, 'r1', tenantId, email, hash, full_name, vToken]); 
      
    console.log('Inserting settings 1...');
    await runQuery(`INSERT INTO settings (tenant_id, setting_key, setting_value) VALUES (?, 'gym_name', ?)`, [tenantId, gymName]);
    console.log('Inserting settings 2...');
    await runQuery(`INSERT INTO settings (tenant_id, setting_key, setting_value) VALUES (?, 'currency', '₹')`, [tenantId]);
      
    console.log('Success!');
  } catch (err) {
    console.error('Test Error:', err.message);
  }
}
setTimeout(testSignup, 1000);
