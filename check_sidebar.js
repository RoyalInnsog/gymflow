const fs = require('fs');
let code = fs.readFileSync('assets/js/designSystem.js', 'utf8');
const lines = code.split('\n');
const start = lines.findIndex(l => l.includes('<nav class="space-y-1 mb-8">'));
if (start > -1) {
    console.log(lines.slice(Math.max(0, start), start + 25).join('\n'));
} else {
    console.log('Sidebar nav not found');
    console.log(code.substring(code.indexOf('function renderSidebar'), code.indexOf('function renderSidebar') + 1000));
}
