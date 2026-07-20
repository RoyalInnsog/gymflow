const fs = require('fs');
let code = fs.readFileSync('routes/api.js', 'utf8');
const start = code.indexOf("router.get('/tasks'");
if (start !== -1) {
    console.log(code.substring(start, start + 300));
} else {
    console.log('No /tasks GET route found');
}
