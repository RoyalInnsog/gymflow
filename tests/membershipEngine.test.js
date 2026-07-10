/*
 * Standalone pure-unit suite for lib/membershipEngine.js.
 * No server needed.
 *
 * Usage: node tests/membershipEngine.test.js
 */
const engine = require('../lib/membershipEngine');

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name, extra ? '-> ' + extra : ''); }
}

console.log('\nMembershipEngine unit suite\n');

// --- addMonths: end-of-month clamping ---
check('addMonths 2025-01-31 +1 = 2025-02-28', engine.addMonths('2025-01-31', 1) === '2025-02-28', engine.addMonths('2025-01-31', 1));
check('addMonths 2024-01-31 +1 = 2024-02-29 (leap)', engine.addMonths('2024-01-31', 1) === '2024-02-29', engine.addMonths('2024-01-31', 1));
check('addMonths 2025-03-31 +1 = 2025-04-30', engine.addMonths('2025-03-31', 1) === '2025-04-30', engine.addMonths('2025-03-31', 1));

// --- leap-year: 12 months from Feb 29 lands on Feb 28 next (non-leap) year ---
check('addMonths 2024-02-29 +12 = 2025-02-28', engine.addMonths('2024-02-29', 12) === '2025-02-28', engine.addMonths('2024-02-29', 12));

// --- addDays across month/year boundaries ---
check('addDays 2025-01-31 +1 = 2025-02-01', engine.addDays('2025-01-31', 1) === '2025-02-01', engine.addDays('2025-01-31', 1));
check('addDays 2025-12-31 +1 = 2026-01-01', engine.addDays('2025-12-31', 1) === '2026-01-01', engine.addDays('2025-12-31', 1));
check('addDays 2024-02-28 +1 = 2024-02-29 (leap)', engine.addDays('2024-02-28', 1) === '2024-02-29', engine.addDays('2024-02-28', 1));
check('addDays 2025-02-28 +1 = 2025-03-01 (non-leap)', engine.addDays('2025-02-28', 1) === '2025-03-01', engine.addDays('2025-02-28', 1));
check('addDays negative crosses year boundary', engine.addDays('2025-01-01', -1) === '2024-12-31', engine.addDays('2025-01-01', -1));

// --- computeEndDate: all four branches ---
check('computeEndDate months only', engine.computeEndDate('2025-01-15', { duration_months: 3 }) === '2025-04-15', engine.computeEndDate('2025-01-15', { duration_months: 3 }));
check('computeEndDate days only', engine.computeEndDate('2025-01-15', { duration_days: 10 }) === '2025-01-25', engine.computeEndDate('2025-01-15', { duration_days: 10 }));
check('computeEndDate months and days (months applied then days)', engine.computeEndDate('2025-01-31', { duration_months: 1, duration_days: 5 }) === engine.addDays('2025-02-28', 5), engine.computeEndDate('2025-01-31', { duration_months: 1, duration_days: 5 }));
check('computeEndDate neither -> +1 month default', engine.computeEndDate('2025-01-31', {}) === '2025-02-28', engine.computeEndDate('2025-01-31', {}));

// --- remainingDays ---
check('remainingDays same day = 0', engine.remainingDays('2025-06-15', '2025-06-15') === 0);
check('remainingDays tomorrow = 1', engine.remainingDays('2025-06-16', '2025-06-15') === 1);
check('remainingDays yesterday = -1', engine.remainingDays('2025-06-14', '2025-06-15') === -1);

// --- isExpired boundary ---
check('isExpired 0 days left -> NOT expired', engine.isExpired('2025-06-15', '2025-06-15') === false);
check('isExpired -1 days left -> expired', engine.isExpired('2025-06-14', '2025-06-15') === true);
check('isExpired 1 day left -> NOT expired', engine.isExpired('2025-06-16', '2025-06-15') === false);

// --- nextRenewalStart ---
check('nextRenewalStart active chain -> end+1', engine.nextRenewalStart('2025-06-20', '2025-06-15') === '2025-06-21', engine.nextRenewalStart('2025-06-20', '2025-06-15'));
check('nextRenewalStart lapsed -> today', engine.nextRenewalStart('2025-06-10', '2025-06-15') === '2025-06-15', engine.nextRenewalStart('2025-06-10', '2025-06-15'));
check('nextRenewalStart null -> today', engine.nextRenewalStart(null, '2025-06-15') === '2025-06-15', engine.nextRenewalStart(null, '2025-06-15'));
check('nextRenewalStart end === today (still active) -> today+1', engine.nextRenewalStart('2025-06-15', '2025-06-15') === '2025-06-16', engine.nextRenewalStart('2025-06-15', '2025-06-15'));

// --- extendEnd stacking ---
const once = engine.extendEnd('2025-01-31', { months: 1 });
const twice = engine.extendEnd(once, { months: 1 });
check('extendEnd stacking (extend twice = sum of two 1-month extends)', twice === engine.addMonths(engine.addMonths('2025-01-31', 1), 1), twice);
check('extendEnd days only', engine.extendEnd('2025-06-15', { days: 10 }) === '2025-06-25', engine.extendEnd('2025-06-15', { days: 10 }));
check('extendEnd months and days combined', engine.extendEnd('2025-01-31', { months: 1, days: 5 }) === engine.addDays('2025-02-28', 5), engine.extendEnd('2025-01-31', { months: 1, days: 5 }));

// --- daysUntil with an ISO timestamp ---
(function () {
  const now = new Date();
  const localToday = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
  const tomorrowLocal = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 12, 0, 0);
  const iso = tomorrowLocal.toISOString();
  check('daysUntil ISO timestamp ~1 day out = 1', engine.daysUntil(iso) === 1, `got ${engine.daysUntil(iso)} for ${iso} (today=${localToday})`);
  check('daysUntil ISO timestamp for today = 0', engine.daysUntil(now.toISOString()) === 0, engine.daysUntil(now.toISOString()));
})();

// --- isValidDateStr ---
check('isValidDateStr rejects 2025-02-30', engine.isValidDateStr('2025-02-30') === false);
check('isValidDateStr rejects 2025-13-01', engine.isValidDateStr('2025-13-01') === false);
check('isValidDateStr rejects garbage', engine.isValidDateStr('garbage') === false);
check('isValidDateStr accepts 2025-02-28', engine.isValidDateStr('2025-02-28') === true);
check('isValidDateStr accepts 2024-02-29 (leap)', engine.isValidDateStr('2024-02-29') === true);
check('isValidDateStr rejects 2023-02-29 (non-leap)', engine.isValidDateStr('2023-02-29') === false);

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
