const fs = require('fs');

function fixMobileSpacing(file) {
  let content = fs.readFileSync(file, 'utf8');
  if (content.includes('<main class="') && !content.includes('pb-32')) {
    content = content.replace(/(<main class="[^"]*)"/, '$1 pb-32"');
    fs.writeFileSync(file, content);
    console.log('Fixed ' + file);
  }
}

fixMobileSpacing('add_member_kinetic_enterprise/code.html');
fixMobileSpacing('add_member_step_1_kinetic_enterprise/code.html');
