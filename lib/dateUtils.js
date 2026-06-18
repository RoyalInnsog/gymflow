/**
 * Centralized Date Utilities
 * Ensures all date calculations are done server-side to prevent scattering
 * timezone logic across SQL queries.
 */

// We use local server time (as was intended by 'localtime' in SQLite), 
// but computed explicitly in Node to avoid hardcoded dates and DB logic fragmentation.

function getTodayString() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function getLastNDaysString(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function getNextNDaysString(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

module.exports = {
  getTodayString,
  getLastNDaysString,
  getNextNDaysString
};
