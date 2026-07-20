const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

const BASE_DIR = 't:/Downloads/stitch_member_directory_kinetic_enterprise (1)/stitch_member_directory_kinetic_enterprise';
const MASTER_FILE = path.join(BASE_DIR, 'task_management_kinetic_enterprise', 'code.html');

console.log('Reading master file to extract standard navigation components...');
const masterHtml = fs.readFileSync(MASTER_FILE, 'utf8');
const $master = cheerio.load(masterHtml, { decodeEntities: false });

const masterHeader = $master.html($master('header'));
const masterSidebar = $master.html($master('nav.desktop-sidebar'));
const masterBottomNav = $master.html($master('nav.md\\:hidden'));
const masterScript = $master.html($master('script#sidebar-sync-script'));

// Also need the inline script that checks localStorage in head
let masterHeadScript = '';
$master('head script').each((i, el) => {
    const content = $master(el).html();
    if (content && content.includes('localStorage.getItem(\'sidebarCollapsed\')')) {
        masterHeadScript = $master.html($master(el));
    }
});

if (!masterHeader || !masterSidebar || !masterBottomNav) {
    console.error('Failed to extract master elements!');
    process.exit(1);
}

// Function to process a single file
function processFile(filePath) {
    console.log(`Processing: ${filePath}`);
    const html = fs.readFileSync(filePath, 'utf8');
    const $ = cheerio.load(html, { decodeEntities: false });

    // 1. Remove old navigation elements
    $('header').remove();
    $('nav').remove();
    $('script#sidebar-sync-script').remove();
    
    // Remove old head script checking sidebarCollapsed
    $('head script').each((i, el) => {
        const content = $(el).html();
        if (content && content.includes('sidebarCollapsed')) {
            $(el).remove();
        }
    });

    // 2. Insert new elements
    // Head script
    if (masterHeadScript) {
        $('head').append('\n' + masterHeadScript + '\n');
    }

    // Insert Header and Sidebar right after body open
    // Since cheerio might wrap in html/body if missing, we just prepend to body
    $('body').prepend('\n' + masterSidebar + '\n');
    $('body').prepend('\n' + masterHeader + '\n');

    // Insert Bottom Nav just before body close
    $('body').append('\n' + masterBottomNav + '\n');

    // Insert sync script just before body close
    if (masterScript) {
        $('body').append('\n' + masterScript + '\n');
    }

    // 3. Inject global utilities (api.js, utils.js) into head if not present
    const hasApi = $('head script[src="/assets/js/api.js"]').length > 0;
    if (!hasApi) {
        $('head').append('\n<script src="/assets/js/api.js"></script>\n');
    }
    const hasUtils = $('head script[src="/assets/js/utils.js"]').length > 0;
    if (!hasUtils) {
        $('head').append('\n<script src="/assets/js/utils.js"></script>\n');
    }

    // Ensure body has the necessary padding classes for sidebar
    const bodyClasses = $('body').attr('class') || '';
    if (!bodyClasses.includes('md:pl-[280px]')) {
        $('body').attr('class', bodyClasses + ' md:pl-[280px]');
    }

    // 4. Update the active state in Bottom Nav based on directory name
    // (This is a bit tricky, but the sync script handles desktop sidebar. For bottom nav, we can leave it to JS or just highlight here)
    // The masterBottomNav has "Tasks" highlighted. Let's remove the highlighting from all and let the client-side script handle it if possible.
    // Actually, we can just strip the highlighting classes from the masterBottomNav here.
    $('nav.md\\:hidden a').each((i, el) => {
        $(el).removeClass('text-secondary font-bold bg-surface-variant/30');
        $(el).addClass('text-on-surface-variant');
        $(el).find('span.material-symbols-outlined').css('font-variation-settings', "'FILL' 0");
    });

    fs.writeFileSync(filePath, $.html());
    console.log(`Updated: ${filePath}`);
}

// Find all code.html files
const items = fs.readdirSync(BASE_DIR);
for (const item of items) {
    if (item === 'node_modules') continue;
    const itemPath = path.join(BASE_DIR, item);
    if (fs.statSync(itemPath).isDirectory()) {
        const codeHtmlPath = path.join(itemPath, 'code.html');
        if (fs.existsSync(codeHtmlPath)) {
            processFile(codeHtmlPath);
        }
    }
}

console.log('Done standardizing navigation!');
