const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./database.sqlite');
db.run("INSERT INTO users (id, role_id, tenant_id, email, password_hash, full_name, email_verified, status, verification_token) VALUES (?, ?, ?, ?, ?, ?, 0, 'active', ?)", 
  ['test_u_1', 'r1', 'test_t_1', 'testadmin999@jsbfitness.in', 'hash', 'Test Admin', 'vtoken'], function(err) {
    if (err) console.error('Signup Error:', err.message);
    else console.log('Signup Insert Success');
});
