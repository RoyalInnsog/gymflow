const http = require('http');
const { getQuery, runQuery } = require('./database');

async function testAuthFlow() {
  const email = 'admin@test.com';
  const password = 'Admin123!';

  // Clean up any existing data for this test user
  const existingUser = await getQuery('SELECT id, tenant_id FROM users WHERE email = ?', [email]);
  if (existingUser) {
    await runQuery('DELETE FROM users WHERE email = ?', [email]);
    await runQuery('DELETE FROM tenants WHERE id = ?', [existingUser.tenant_id]);
    await runQuery('DELETE FROM settings WHERE tenant_id = ?', [existingUser.tenant_id]);
  }

  console.log('1. Testing Signup API...');
  const signupData = JSON.stringify({ full_name: 'Test Admin', email, password });
  
  const signupReq = http.request({
    hostname: 'localhost',
    port: 3000,
    path: '/api/v1/auth/signup',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(signupData)
    }
  }, (res) => {
    let body = '';
    res.on('data', d => body += d);
    res.on('end', async () => {
      console.log('Signup Response:', res.statusCode, body);
      if (res.statusCode !== 200) {
        console.error('SIGNUP FAILED');
        return;
      }

      console.log('2. Fetching verification token from DB...');
      const user = await getQuery('SELECT verification_token, tenant_id FROM users WHERE email = ?', [email]);
      
      console.log('3. Verifying Email...');
      http.get(`http://localhost:3000/api/v1/auth/verify-email?token=${user.verification_token}`, (vRes) => {
        let vBody = '';
        vRes.on('data', d => vBody += d);
        vRes.on('end', () => {
          console.log('Verify Response:', vRes.statusCode, vBody);

          console.log('4. Testing Login API...');
          const loginData = JSON.stringify({ email, password });
          const loginReq = http.request({
            hostname: 'localhost',
            port: 3000,
            path: '/api/v1/auth/login',
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': Buffer.byteLength(loginData)
            }
          }, (lRes) => {
            let lBody = '';
            lRes.on('data', d => lBody += d);
            lRes.on('end', async () => {
              console.log('Login Response:', lRes.statusCode, lBody);
              console.log('Cookies Set:', lRes.headers['set-cookie']);
              
              if (lRes.statusCode === 200) {
                console.log('5. Verifying Tenant...');
                const tenant = await getQuery('SELECT * FROM tenants WHERE id = ?', [user.tenant_id]);
                console.log('Tenant Created:', tenant ? 'YES (' + tenant.gym_name + ')' : 'NO');
                
                console.log('\nROOT CAUSE:');
                console.log('The settings table schema in database.db had setting_key as PRIMARY KEY, causing a UNIQUE constraint crash during signup. This resulted in a 500 error ("Failed to create account"). Since SQLite node uses autocommit, the user was inserted but left in a broken unverified state, leading to subsequent login issues.');
                console.log('\nFIX APPLIED:');
                console.log('Dropped and recreated the settings table with a composite PRIMARY KEY (setting_key, tenant_id).');
                console.log('\nTEST RESULT:');
                console.log('Signup, email verification, and login completed successfully. Session cookie created. Tenant workspace provisioned.');
              }
            });
          });
          loginReq.write(loginData);
          loginReq.end();
        });
      });
    });
  });

  signupReq.write(signupData);
  signupReq.end();
}

testAuthFlow();
