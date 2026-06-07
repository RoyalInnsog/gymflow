const fs = require('fs');
let code = fs.readFileSync('signup_kinetic_enterprise/code.html', 'utf8');
const start = code.indexOf("document.getElementById('signup-form')");
if (start > -1) {
    console.log(code.substring(start, start + 1000));
} else {
    console.log("Not found");
}
