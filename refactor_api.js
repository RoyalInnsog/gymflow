const fs = require('fs');
let code = fs.readFileSync('routes/api.js', 'utf8');

const helper = `
// Template Resolver Helper
async function resolveTemplate(templateId, data) {
  const tpl = await getQuery("SELECT message_body FROM templates WHERE id = ?", [templateId]);
  if (!tpl) return '';
  let msg = tpl.message_body;
  const settings = await allQuery("SELECT * FROM settings");
  const sMap = {};
  settings.forEach(s => sMap[s.setting_key] = s.setting_value);
  const brand = sMap['gym_name'] || 'Kinetic Enterprise';
  msg = msg.replace(/{{gym_name}}/g, brand);
  for (let k in data) {
    msg = msg.replace(new RegExp('{{'+k+'}}', 'g'), data[k] || '');
  }
  return msg;
}
`;

if (!code.includes('resolveTemplate')) {
    code = code.replace('let lastScanTime = 0;', helper + '\nlet lastScanTime = 0;');
}

code = code.replace(/const whatsappMsg = `Hi \*\$\{ms\.full_name\}\*, your membership at \*JSB Fitness\* expired on \*\$\{ms\.end_date\}\*\. Contact us or drop by the gym to renew\. We'd love to see you back! 💪`;/g, 
"const whatsappMsg = await resolveTemplate('whatsapp_expiry', { member_name: ms.full_name, end_date: ms.end_date });");

code = code.replace(/const whatsappMsg = `Hi \*\$\{ms\.full_name\}\*, this is a friendly reminder from \*JSB Fitness\*\. Your membership will expire in \*\$\{daysLeft\} days\* \(on \*\$\{ms\.end_date\}\*\)\. Renew today to keep training! 🏋️‍♂️`;/g, 
"const whatsappMsg = await resolveTemplate('whatsapp_expiry_reminder', { member_name: ms.full_name, days_left: daysLeft, end_date: ms.end_date });");

code = code.replace(/const whatsappMsg = `Hello \*\$\{m\.full_name\}\*, we missed you at \*JSB Fitness\*\! You haven't checked in for \*\$\{absenceDays\} days\*\. Is everything okay\? Let us know if you need any help getting back on track\! 🤝`;/g, 
"const whatsappMsg = await resolveTemplate('whatsapp_retention', { member_name: m.full_name, absence_days: absenceDays });");

code = code.replace(/const whatsappMsg = `Hi \*\$\{inv\.full_name\}\*, you have a pending payment of \*₹\$\{inv\.total_amount\}\* for Invoice \*\#\$\{inv\.invoice_number\}\* at \*JSB Fitness\*\. Please clear it at your earliest convenience\. Thank you\!`;/g, 
"const whatsappMsg = await resolveTemplate('whatsapp_payment_due', { member_name: inv.full_name, amount: inv.total_amount, invoice_number: inv.invoice_number });");

// There's also some template usage in routes/api.js, let's just make sure "JSB Fitness" inside notifications is replaced:
// In lines like: [ntId, `Membership for ${ms.full_name} (${ms.member_id}) expired on ${ms.end_date}.`] - no JSB fitness there
// There might be JSB Fitness elsewhere in notifications:
// "Profile created for ${member.full_name}. Welcome to JSB Fitness!"
code = code.replace(/Welcome to JSB Fitness/g, "Welcome to ${gymName || 'Kinetic SaaS'}");
// Wait, gymName is not defined in that context. Let's just use "our gym"
code = code.replace(/Welcome to JSB Fitness/g, "Welcome to our gym");
code = code.replace(/Joined JSB Fitness/g, "Joined");

fs.writeFileSync('routes/api.js', code, 'utf8');
console.log('Refactored api.js');
