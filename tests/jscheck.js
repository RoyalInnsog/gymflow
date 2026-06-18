// Extract inline <script> blocks from each screen and parse them to catch syntax
// errors (e.g. the over-escaped template literals we just fixed).
const fs = require('fs');
const cheerio = require('cheerio');
const parser = require('@babel/parser');
const { glob } = require('fs');

const files = require('child_process').execSync('git ls-files "*_kinetic_enterprise/code.html" "*gym_management/code.html"', { encoding: 'utf8' })
  .split('\n').map(s => s.trim()).filter(Boolean);

let bad = 0, checked = 0;
for (const f of files) {
  let html; try { html = fs.readFileSync(f, 'utf8'); } catch { continue; }
  const $ = cheerio.load(html);
  $('script').each((i, el) => {
    const src = $(el).attr('src');
    if (src) return; // external
    const code = $(el).html();
    if (!code || !code.trim()) return;
    checked++;
    try {
      parser.parse(code, { sourceType: 'script', errorRecovery: false });
    } catch (e) {
      bad++;
      console.log(`SYNTAX ERROR in ${f} (script #${i}): ${e.message.split('\n')[0]}`);
    }
  });
}
console.log(`\nChecked ${checked} inline scripts across ${files.length} screens. ${bad ? bad + ' FAILED' : 'All parsed OK ✓'}`);
