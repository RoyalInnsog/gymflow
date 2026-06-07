const fs = require('fs');
const code = fs.readFileSync('routes/api.js', 'utf8');

const regex = /router\.(get|post)\('\/settings[\s\S]*?(?=router\.[a-z]+\(|module\.exports)/g;
let match;
while ((match = regex.exec(code)) !== null) {
  console.log(match[0]);
}
