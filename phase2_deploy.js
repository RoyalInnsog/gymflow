/**
 * Phase 2 Deployment Script
 * =========================
 * Transforms ALL code.html files to use the canonical design system.
 * 
 * Actions per file:
 * 1. Removes ALL old Tailwind config blocks (Config A, B, and C)
 * 2. Removes ALL old navigation markup (headers, sidebars, bottom navs)
 * 3. Removes old sidebar sync scripts
 * 4. Removes old inline style blocks that duplicate shared.css
 * 5. Injects: designSystem.js (before Tailwind CDN), shared.css, api.js, utils.js
 * 6. Injects: placeholder divs for dynamic navigation rendering
 * 7. Fixes body classes for consistent layout
 * 8. Replaces brand strings
 * 9. Replaces USD currency with INR
 */

const fs = require('fs');
const path = require('path');

const BASE_DIR = path.resolve('t:/Downloads/stitch_member_directory_kinetic_enterprise (1)/stitch_member_directory_kinetic_enterprise');

// Pages that should NOT get full navigation (login pages)
const LOGIN_PAGES = ['login_kinetic_enterprise', 'elite_performance_gym_management'];

// Pages that need back buttons
const BACK_NAV_PAGES = {
  'member_profile_kinetic_enterprise': { label: '← Members', href: '/members' },
  'member_timeline_kinetic_enterprise': { label: '← Member Profile', href: '/member-profile' },
  'member_profile_communication_kinetic_enterprise': { label: '← Member Profile', href: '/member-profile' },
  'member_qr_card_kinetic_enterprise': { label: '← Member Profile', href: '/member-profile' },
  'add_member_kinetic_enterprise': { label: '← Members', href: '/members' },
  'add_member_step_1_kinetic_enterprise': { label: '← Members', href: '/members' },
  'payment_center_kinetic_enterprise': { label: '← Finance', href: '/finance' },
  'renew_membership_kinetic_enterprise': { label: '← Members', href: '/members' },
  'membership_receipt_kinetic_enterprise': { label: '← Finance', href: '/finance' },
  'retention_dashboard_kinetic_enterprise': { label: '← Dashboard', href: '/dashboard' },
  'expiry_management_kinetic_enterprise': { label: '← Dashboard', href: '/dashboard' },
  'staff_management_kinetic_enterprise': { label: '← Settings', href: '/settings' },
  'equipment_inventory_kinetic_enterprise': { label: '← Settings', href: '/settings' },
};

// Page titles for <title> tag
const PAGE_TITLES = {
  'dashboard_kinetic_enterprise': 'Owner Dashboard',
  'member_directory_kinetic_enterprise': 'Members',
  'member_profile_kinetic_enterprise': 'Member Profile',
  'member_timeline_kinetic_enterprise': 'Member Timeline',
  'member_profile_communication_kinetic_enterprise': 'Communications',
  'member_qr_card_kinetic_enterprise': 'Member QR Card',
  'add_member_kinetic_enterprise': 'Add Member',
  'add_member_step_1_kinetic_enterprise': 'Add Member',
  'finance_kinetic_enterprise': 'Finance Dashboard',
  'payment_center_kinetic_enterprise': 'Payment Center',
  'renew_membership_kinetic_enterprise': 'Renew Membership',
  'membership_receipt_kinetic_enterprise': 'Receipt',
  'lead_crm_kinetic_enterprise': 'Lead CRM',
  'marketing_kinetic_enterprise': 'Marketing Center',
  'task_management_kinetic_enterprise': 'Tasks',
  'notifications_kinetic_enterprise': 'Notifications',
  'settings_kinetic_enterprise': 'Settings',
  'staff_management_kinetic_enterprise': 'Staff Management',
  'equipment_inventory_kinetic_enterprise': 'Equipment',
  'daily_closing_report_kinetic_enterprise': 'Daily Closing Report',
  'business_intelligence_kinetic_enterprise': 'Analytics',
  'business_dashboard_kinetic_enterprise': 'Business Dashboard',
  'executive_dashboard_kinetic_enterprise': 'Executive Dashboard',
  'attendance_kinetic_enterprise': 'Attendance',
  'retention_dashboard_kinetic_enterprise': 'Retention Dashboard',
  'expiry_management_kinetic_enterprise': 'Expiry Management',
  'login_kinetic_enterprise': 'Login',
  'elite_performance_gym_management': 'Login',
};

function processFile(dirName, filePath) {
  console.log(`Processing: ${dirName}`);
  let html = fs.readFileSync(filePath, 'utf8');
  const isLogin = LOGIN_PAGES.includes(dirName);
  const pageTitle = PAGE_TITLES[dirName] || dirName.replace(/_kinetic_enterprise/g, '').replace(/_/g, ' ');
  const backNav = BACK_NAV_PAGES[dirName];

  // ─── STEP 1: Remove ALL old Tailwind config blocks ───
  // Remove <script> blocks containing tailwind.config
  html = html.replace(/<script[^>]*>\s*\n?\s*tailwind\.config\s*=\s*\{[\s\S]*?\};\s*\n?\s*<\/script>/gi, '');
  html = html.replace(/<script[^>]*id="tailwind-config"[^>]*>[\s\S]*?<\/script>/gi, '');
  // Also remove the window.tailwind block from dashboard
  html = html.replace(/<script>\s*\n?\s*window\.tailwind\s*=[\s\S]*?<\/script>/gi, '');

  // ─── STEP 2: Remove old navigation markup ─────────────
  // Remove ALL <header> tags (they'll be replaced by dynamic rendering)
  html = html.replace(/<header[\s\S]*?<\/header>/gi, '');
  // Remove ALL <nav> tags
  html = html.replace(/<nav[\s\S]*?<\/nav>/gi, '');
  // Remove old sidebar sync scripts
  html = html.replace(/<script\s+id="sidebar-sync-script">[\s\S]*?<\/script>/gi, '');
  // Remove old sidebarCollapsed init scripts
  html = html.replace(/<script>\s*\(function\(\)\s*\{\s*\n?\s*const collapsed = localStorage[\s\S]*?\}\)\(\);\s*\n?\s*<\/script>/gi, '');
  // Remove old toggleSidebar functions
  html = html.replace(/function toggleSidebar\(\)\s*\{[\s\S]*?\n\}/g, '');
  // Remove the addTaskModal that was injected by old nav standardization (it was inside mobile nav)
  // It shows up after bottom nav removal as orphaned content — handled below

  // ─── STEP 3: Remove old inline <style> blocks that overlap with shared.css ───
  // Remove duplicate body/glass-card/scrollbar styles (keep page-specific ones)
  // We'll be selective: remove known duplicate patterns
  html = html.replace(/<style>\s*body\s*\{\s*min-height:\s*max\(884px,\s*100dvh\);\s*\}\s*<\/style>/gi, '');
  
  // ─── STEP 4: Remove old script includes for api.js and utils.js (will re-add) ──
  html = html.replace(/<script\s+src="\/assets\/js\/api\.js"\s*>\s*<\/script>/gi, '');
  html = html.replace(/<script\s+src="\/assets\/js\/utils\.js"\s*>\s*<\/script>/gi, '');

  // ─── STEP 5: Remove duplicate Google Fonts links (keep one set) ────
  // Count Material Symbols links and remove extras
  const msLinks = html.match(/<link[^>]*Material\+Symbols[^>]*>/gi) || [];
  if (msLinks.length > 1) {
    // Keep first, remove rest
    let firstFound = false;
    html = html.replace(/<link[^>]*Material\+Symbols[^>]*>/gi, (match) => {
      if (!firstFound) { firstFound = true; return match; }
      return '';
    });
  }

  // ─── STEP 6: Inject canonical head resources ──────────
  const headInject = `
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@500;600&display=swap" rel="stylesheet">
<link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght,FILL@100..700,0..1&display=swap" rel="stylesheet">
<link href="/assets/css/shared.css" rel="stylesheet">
<script src="/assets/js/designSystem.js"><\/script>
<script src="https://cdn.tailwindcss.com?plugins=forms,container-queries"><\/script>
<script src="/assets/js/api.js"><\/script>
<script src="/assets/js/utils.js"><\/script>`;

  // Remove existing preconnect and font links (we'll replace)
  html = html.replace(/<link[^>]*fonts\.googleapis\.com[^>]*>/gi, '');
  html = html.replace(/<link[^>]*fonts\.gstatic\.com[^>]*>/gi, '');
  // Remove old Tailwind CDN script
  html = html.replace(/<script\s+src="https:\/\/cdn\.tailwindcss\.com[^"]*"\s*>\s*<\/script>/gi, '');

  // Inject after <head> or after <meta viewport>
  if (html.includes('<meta content="width=device-width')) {
    html = html.replace(/(<meta[^>]*viewport[^>]*>)/, '$1\n' + headInject);
  } else {
    html = html.replace(/<head[^>]*>/, '$&\n' + headInject);
  }

  // ─── STEP 7: Fix <title> tag ──────────────────────────
  html = html.replace(/<title>[^<]*<\/title>/i, `<title>JSB Fitness - ${pageTitle}</title>`);

  // ─── STEP 8: Fix body classes ─────────────────────────
  if (!isLogin) {
    // Ensure body has sidebar padding and proper classes
    html = html.replace(/<body[^>]*class="[^"]*"[^>]*>/i, (match) => {
      // Extract existing classes
      let classes = match.match(/class="([^"]*)"/)[1];
      // Remove conflicting classes
      classes = classes.replace(/\bmd:pl-\[\d+px\]/g, '');
      classes = classes.replace(/\bpt-\d+/g, '');
      classes = classes.replace(/\bpb-\d+/g, '');
      classes = classes.replace(/\bpl-\[\d+px\]/g, '');
      classes = classes.replace(/\bfont-body-md\b/g, '');
      classes = classes.replace(/\bfont-body\b/g, '');
      classes = classes.replace(/\btext-body-md\b/g, '');
      classes = classes.replace(/\boverflow-hidden\b/g, '');
      classes = classes.replace(/\bh-screen\b/g, '');
      // Clean up extra spaces
      classes = classes.replace(/\s+/g, ' ').trim();
      // Add canonical classes
      classes = 'font-body text-body-md antialiased min-h-screen md:pl-[280px] pt-16 transition-all duration-300 ' + classes;
      return match.replace(/class="[^"]*"/, `class="${classes.trim()}"`);
    });

    // Inject navigation placeholders right after <body ...>
    html = html.replace(/(<body[^>]*>)/, `$1
<div id="jsb-header" data-page-title="${pageTitle}"></div>
<div id="jsb-sidebar"></div>
`);

    // Inject mobile nav placeholder before </body>
    html = html.replace(/<\/body>/i, `<div id="jsb-mobile-nav"></div>\n</body>`);
  }

  // ─── STEP 9: Brand string replacements ────────────────
  // Replace "Kinetic Enterprise" in visible text (not in file paths or dir names)
  html = html.replace(/>Kinetic Enterprise</g, '>JSB Fitness<');
  html = html.replace(/Kinetic Enterprise(?![\w\/])/g, window.APP_CONFIG?.brand?.name || 'Kinetic SaaS');
  // Replace "Elite Performance" in visible text
  html = html.replace(/>Elite Performance</g, '>JSB Fitness<');
  html = html.replace(/Elite Performance(?![\w\/])/g, window.APP_CONFIG?.brand?.name || 'Kinetic SaaS');

  // ─── STEP 10: Fix USD → INR in Finance page ──────────
  if (dirName === 'finance_kinetic_enterprise') {
    html = html.replace(/\$142\.5k/g, '₹0');
    html = html.replace(/\$42\.5k/g, '₹0');
    html = html.replace(/\$2\.1k/g, '₹0');
    html = html.replace(/\+\$150\.00/g, '+₹0');
    html = html.replace(/-\$845\.20/g, '-₹0');
    html = html.replace(/\+\$300\.00/g, '+₹0');
  }

  // ─── STEP 11: Inject back button for sub-pages ────────
  if (backNav && !isLogin) {
    // Find the first <main> tag and inject back button after the first child div
    html = html.replace(/(<main[^>]*>)/, `$1\n<div class="px-4 md:px-8 pt-4"><a href="${backNav.href}" class="inline-flex items-center gap-1 text-on-surface-variant hover:text-primary transition-colors text-body-md group"><span class="material-symbols-outlined text-[18px] group-hover:-translate-x-0.5 transition-transform">arrow_back</span><span>${backNav.label}</span></a></div>`);
  }

  // ─── STEP 12: Remove orphaned old styles ──────────────
  // Remove old inline style blocks for sidebar collapse (now in shared.css)
  html = html.replace(/<style>\s*\/\*\s*Collapsible sidebar styles\s*\*\/[\s\S]*?<\/style>/gi, '');
  // Remove old custom scrollbar styles that duplicate shared.css
  html = html.replace(/<style>\s*\/\*\s*Custom scrollbar styling\s*\*\/[\s\S]*?<\/style>/gi, '');
  // Remove old transition styles
  html = html.replace(/<style>\s*\/\*\s*Transition styles\s*\*\/[\s\S]*?<\/style>/gi, '');

  // Clean up excessive blank lines
  html = html.replace(/\n{4,}/g, '\n\n');

  fs.writeFileSync(filePath, html);
  console.log(`  ✓ Updated: ${dirName}`);
}

// ─── MAIN ─────────────────────────────────────────────
console.log('═══════════════════════════════════════════');
console.log('  JSB Fitness — Phase 2 Deployment');
console.log('═══════════════════════════════════════════\n');

const items = fs.readdirSync(BASE_DIR);
let processed = 0;
for (const item of items) {
  if (item === 'node_modules' || item === 'routes' || item === 'assets') continue;
  const itemPath = path.join(BASE_DIR, item);
  if (fs.statSync(itemPath).isDirectory()) {
    const codeHtmlPath = path.join(itemPath, 'code.html');
    if (fs.existsSync(codeHtmlPath)) {
      processFile(item, codeHtmlPath);
      processed++;
    }
  }
}

console.log(`\n✓ Processed ${processed} pages.`);

// ─── FIX FINANCE API FALLBACKS ──────────────────────────
console.log('\nFixing Finance API fallbacks...');
const apiPath = path.join(BASE_DIR, 'routes', 'api.js');
let apiContent = fs.readFileSync(apiPath, 'utf8');
// Replace hardcoded fallback 142500 with 0
apiContent = apiContent.replace(
  /totalRevenue:\s*totalCollected\.sum\s*\|\|\s*142500/g,
  'totalRevenue: totalCollected.sum || 0'
);
// Replace hardcoded monthly revenue
apiContent = apiContent.replace(
  /monthlyRevenue:\s*42500/g,
  'monthlyRevenue: totalCollected.sum || 0'
);
// Replace hardcoded pending fallback
apiContent = apiContent.replace(
  /pendingInvoices:\s*pendingDues\.sum\s*\|\|\s*2100/g,
  'pendingInvoices: pendingDues.sum || 0'
);
fs.writeFileSync(apiPath, apiContent);
console.log('  ✓ Finance API fallbacks fixed.');

console.log('\n═══════════════════════════════════════════');
console.log('  Deployment Complete!');
console.log('═══════════════════════════════════════════');
