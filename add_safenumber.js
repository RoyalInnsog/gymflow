const fs = require('fs');
let code = fs.readFileSync('assets/js/utils.js', 'utf8');

const newFns = `safeNumber: function(val, fallback = '0') {
        if (val === undefined || val === null || Number.isNaN(Number(val))) return fallback;
        return Number(val).toLocaleString('en-IN');
    },

    formatCurrency: function(amount) {
        if (amount === undefined || amount === null || Number.isNaN(Number(amount))) return '₹0';`;

code = code.replace('formatCurrency: function(amount) {', newFns);

fs.writeFileSync('assets/js/utils.js', code);
console.log('Added safeNumber to utils.js');
