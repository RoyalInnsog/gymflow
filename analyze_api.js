const fs = require('fs');
const code = fs.readFileSync('routes/api.js', 'utf8');
const routes = [];
const regex = /router\.(get|post|put|delete)\(['"`](.*?)['"`]/g;
let match;
while ((match = regex.exec(code)) !== null) {
  routes.push(`${match[1].toUpperCase()} ${match[2]}`);
}
console.log(routes.join('\n'));
