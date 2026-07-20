const { runQuery } = require('./database.js');
setTimeout(async () => {
  try {
    await runQuery(`INSERT INTO users (id, role_id, tenant_id, email, password_hash, full_name, email_verified, status, verification_token) VALUES (?, ?, ?, ?, ?, ?, 0, 'active', ?)`, 
      ['test_u_2', 'r1', 'test_t_2', 'testadmin9992@jsbfitness.in', 'hash', 'Test Admin', 'vtoken']);
    console.log('Signup Insert Success');
  } catch (err) {
    console.error('Signup Error:', err.message);
  }
}, 1000);
