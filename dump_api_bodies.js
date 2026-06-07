const fs = require('fs');
const code = fs.readFileSync('routes/api.js', 'utf8');

const endpoints = ['/settings', '/plans', '/staff', '/branches', '/templates'];
endpoints.forEach(ep => {
  console.log(`\n--- ENDPOINTS FOR ${ep} ---`);
  // Match any router.xyz('endpoint' or router.xyz('endpoint/:id'
  const regex = new RegExp(`router\\.(get|post|put|delete)\\('${ep}[a-zA-Z0-9/:-]*'[\\s\\S]*?(?=router\\.[a-z]+\\(|module\\.exports)`, 'g');
  let match;
  while ((match = regex.exec(code)) !== null) {
    console.log(match[0].substring(0, 300) + '... (truncated)');
  }
});
