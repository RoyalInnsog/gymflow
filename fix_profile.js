const fs = require('fs');
let code = fs.readFileSync('member_profile_kinetic_enterprise/code.html', 'utf8');

// Replace hardcoded Active badge with empty skeleton initially
code = code.replace(
  /<div id="member-status-badge".*?>[\s\S]*?<\/div>\s*Active\s*<\/div>/,
  `<div id="member-status-badge" class="absolute -bottom-2 -right-2 bg-surface-container-high text-on-surface-variant font-label-caps text-label-caps px-2 py-1 rounded-full border border-white/10 flex items-center gap-1">
        <div class="w-4 h-4 rounded bg-white/10 animate-pulse"></div>
      </div>`
);

// Replace Platinum badge
code = code.replace(
  /<span id="member-plan-badge".*?>[\s\S]*?<\/span>\s*Platinum\s*<\/span>/,
  `<span id="member-plan-badge" class="bg-[#2A2A2A] text-[#c6c6c6] px-2 py-1 rounded border border-[#4c4546] font-label-caps text-label-caps flex items-center gap-1 min-w-[80px] h-6 animate-pulse"></span>`
);

// Replace Member Name Heading -
code = code.replace(
  '<h2 class="font-headline-lg text-headline-lg text-on-surface" id="member-name-heading">-</h2>',
  '<h2 class="font-headline-lg text-headline-lg text-on-surface bg-white/10 rounded animate-pulse w-48 h-8" id="member-name-heading"></h2>'
);

// Replace Metro Branch
code = code.replace(
  '<span class="material-symbols-outlined text-[18px]">location_on</span> Metro Branch',
  '<span class="material-symbols-outlined text-[18px]">location_on</span> <span id="member-branch">Branch Loading...</span>'
);

fs.writeFileSync('member_profile_kinetic_enterprise/code.html', code);
console.log('Fixed member profile flash');
