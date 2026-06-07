const fs = require('fs');
const path = require('path');

const rootDir = __dirname;
let modifiedCount = 0;

function walkDir(dir) {
    fs.readdirSync(dir).forEach(file => {
        let fullPath = path.join(dir, file);
        if (fs.statSync(fullPath).isDirectory()) {
            if (fullPath.includes('node_modules') || fullPath.includes('.git') || fullPath.includes('activity_log')) return;
            walkDir(fullPath);
        } else {
            if (fullPath.endsWith('.html') || fullPath.endsWith('.js')) {
                if (fullPath.includes('saas_transformer.js') || fullPath.includes('database.js') || fullPath.includes('server.js')) return;
                
                let content = fs.readFileSync(fullPath, 'utf8');
                let originalContent = content;

                if (fullPath.endsWith('.html')) {
                    // Replace <title>JSB Fitness - XYZ</title> with dynamic title
                    content = content.replace(/<title>JSB Fitness - /g, '<title>Kinetic SaaS - ');
                    
                    // Replace plain text JSB Fitness with span
                    // We must be careful not to replace JSB Fitness inside tags or attributes if possible, 
                    // but since this is a simple string, we will replace specific known occurrences in HTML.
                    content = content.replace(/>JSB Fitness Mumbai</g, '><span class="dynamic-gym-name">JSB Fitness Mumbai</span><');
                    content = content.replace(/>JSB Fitness Admin</g, '>Admin<');
                    content = content.replace(/>JSB Fitness</g, '><span class="dynamic-gym-name">JSB Fitness</span><');
                    content = content.replace(/Welcome to JSB Fitness/g, 'Welcome to <span class="dynamic-gym-name">JSB Fitness</span>');
                    content = content.replace(/JSB FITNESS/g, '<span class="dynamic-gym-name uppercase">JSB FITNESS</span>');
                    
                    // Specific Empty States logic: the prompt says "Scan all pages. Remove hardcoded demo data where appropriate. Whenever data does not exist: Use professional empty states."
                    // Ensure the empty states in HTML files use the dynamic span.
                }

                if (fullPath.endsWith('code.html') || fullPath.endsWith('.js')) {
                    // Replace JS hardcoded JSB Fitness in scripts
                    content = content.replace(/'JSB Fitness Mumbai'/g, "window.APP_CONFIG?.brand?.name || 'Kinetic SaaS'");
                    content = content.replace(/'JSB Fitness'/g, "window.APP_CONFIG?.brand?.name || 'Kinetic SaaS'");
                    content = content.replace(/: 'JSB';/g, ": 'GYM';");
                }

                if (content !== originalContent) {
                    fs.writeFileSync(fullPath, content, 'utf8');
                    modifiedCount++;
                    console.log(`Modified: ${fullPath.replace(rootDir, '')}`);
                }
            }
        }
    });
}

console.log('Starting SaaS Transformation Scan...');
walkDir(rootDir);
console.log(`\nComplete! Modified ${modifiedCount} files.`);
