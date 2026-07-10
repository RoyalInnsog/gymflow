/**
 * MembershipEngine — centralized calendar-date arithmetic for membership durations.
 *
 * Single source of truth shared by the browser (window.MembershipEngine) and the
 * server (lib/membershipEngine.js re-exports this same file). All date math is
 * done on epoch-day integers derived via Date.UTC, never via local-time parsing
 * of 'YYYY-MM-DD' strings (that mixing of UTC parsing + local mutation caused the
 * old off-by-one bugs when the server runs UTC but users are IST) and never via
 * toISOString() on "now" (which also shifts by the local UTC offset).
 *
 * Dates in/out of this module are always 'YYYY-MM-DD' strings representing a
 * calendar day (no timezone attached) unless a function explicitly documents
 * that it accepts an ISO timestamp (daysUntil).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.MembershipEngine = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var MS_PER_DAY = 86400000;
  var DATE_STR_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

  /**
   * Validate that a string is a well-formed 'YYYY-MM-DD' date representing a
   * real calendar date (rejects e.g. 2025-02-30, 2025-13-01, 'garbage').
   * @param {*} s
   * @returns {boolean}
   */
  function isValidDateStr(s) {
    if (typeof s !== 'string') return false;
    var m = DATE_STR_RE.exec(s);
    if (!m) return false;
    var year = parseInt(m[1], 10);
    var month = parseInt(m[2], 10);
    var day = parseInt(m[3], 10);
    if (month < 1 || month > 12 || day < 1 || day > 31) return false;
    var d = new Date(Date.UTC(year, month - 1, day));
    return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
  }

  /**
   * Convert a validated 'YYYY-MM-DD' string to an integer epoch-day count
   * (days since 1970-01-01 UTC). Internal helper — callers should validate
   * with isValidDateStr first where input is untrusted.
   * @param {string} s
   * @returns {number}
   */
  function toEpochDay(s) {
    var m = DATE_STR_RE.exec(s);
    var year = parseInt(m[1], 10);
    var month = parseInt(m[2], 10);
    var day = parseInt(m[3], 10);
    return Math.floor(Date.UTC(year, month - 1, day) / MS_PER_DAY);
  }

  /**
   * Convert an integer epoch-day count back to a 'YYYY-MM-DD' string.
   * @param {number} epochDay
   * @returns {string}
   */
  function fromEpochDay(epochDay) {
    var d = new Date(epochDay * MS_PER_DAY);
    var year = d.getUTCFullYear();
    var month = String(d.getUTCMonth() + 1).padStart(2, '0');
    var day = String(d.getUTCDate()).padStart(2, '0');
    return year + '-' + month + '-' + day;
  }

  /**
   * Today's calendar date in the local device/server timezone, as 'YYYY-MM-DD'.
   * Uses getFullYear/getMonth/getDate (never toISOString) — same convention as
   * lib/dateUtils.getTodayString so server and client agree on "today".
   * @returns {string}
   */
  function todayStr() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  /**
   * Add (or subtract, if n is negative) a number of whole days to a date string.
   * @param {string} dateStr 'YYYY-MM-DD'
   * @param {number} n
   * @returns {string} 'YYYY-MM-DD'
   */
  function addDays(dateStr, n) {
    return fromEpochDay(toEpochDay(dateStr) + Math.trunc(n));
  }

  /**
   * Add (or subtract) a number of calendar months to a date string, with
   * end-of-month clamping: if the target month is shorter than the source
   * day-of-month, the result clamps to the last valid day of the target month
   * (2025-01-31 +1 -> 2025-02-28; 2024-01-31 +1 -> 2024-02-29, a leap year).
   * @param {string} dateStr 'YYYY-MM-DD'
   * @param {number} n number of months to add (may be negative)
   * @returns {string} 'YYYY-MM-DD'
   */
  function addMonths(dateStr, n) {
    var m = DATE_STR_RE.exec(dateStr);
    var year = parseInt(m[1], 10);
    var month = parseInt(m[2], 10) - 1; // 0-based
    var day = parseInt(m[3], 10);
    var totalMonths = month + Math.trunc(n);
    var targetYear = year + Math.floor(totalMonths / 12);
    var targetMonth = ((totalMonths % 12) + 12) % 12;
    // Day 0 of (targetMonth + 1) == last day of targetMonth (leap-year correct).
    var lastDayOfTargetMonth = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
    var clampedDay = Math.min(day, lastDayOfTargetMonth);
    var d = new Date(Date.UTC(targetYear, targetMonth, clampedDay));
    return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
  }

  /**
   * Compute a membership end date from a start date and plan duration fields.
   * Branches:
   *  - duration_days > 0 AND duration_months > 0: apply months first, then days.
   *  - only duration_days > 0: addDays(start, duration_days).
   *  - only duration_months > 0: addMonths(start, duration_months).
   *  - neither set: addMonths(start, 1) (preserves the existing default).
   * @param {string} startStr 'YYYY-MM-DD'
   * @param {{duration_months?: number, duration_days?: number}} plan
   * @returns {string} 'YYYY-MM-DD'
   */
  function computeEndDate(startStr, plan) {
    var months = (plan && plan.duration_months) || 0;
    var days = (plan && plan.duration_days) || 0;
    if (days > 0 && months > 0) {
      return addDays(addMonths(startStr, months), days);
    }
    if (days > 0) {
      return addDays(startStr, days);
    }
    if (months > 0) {
      return addMonths(startStr, months);
    }
    return addMonths(startStr, 1);
  }

  /**
   * Number of whole calendar days remaining between endStr and today
   * (endEpochDay - todayEpochDay). Negative means the end date has passed.
   * @param {string} endStr 'YYYY-MM-DD'
   * @param {string} [today] 'YYYY-MM-DD', defaults to todayStr()
   * @returns {number}
   */
  function remainingDays(endStr, today) {
    var t = today || todayStr();
    return toEpochDay(endStr) - toEpochDay(t);
  }

  /**
   * Whether a membership has expired. A membership is valid through the end
   * of its end_date, so remainingDays === 0 is NOT expired (matches existing
   * cron semantics) — only remainingDays < 0 is expired.
   * @param {string} endStr 'YYYY-MM-DD'
   * @param {string} [today] 'YYYY-MM-DD', defaults to todayStr()
   * @returns {boolean}
   */
  function isExpired(endStr, today) {
    return remainingDays(endStr, today) < 0;
  }

  /**
   * Determine the start date for a renewal: chains onto the day after the
   * current membership's end date if that membership is still active
   * (end >= today), otherwise starts today (lapsed membership).
   * @param {string|null|undefined} currentEndStr 'YYYY-MM-DD' or falsy/invalid
   * @param {string} [today] 'YYYY-MM-DD', defaults to todayStr()
   * @returns {string} 'YYYY-MM-DD'
   */
  function nextRenewalStart(currentEndStr, today) {
    var t = today || todayStr();
    if (currentEndStr && isValidDateStr(currentEndStr) && toEpochDay(currentEndStr) >= toEpochDay(t)) {
      return addDays(currentEndStr, 1);
    }
    return t;
  }

  /**
   * Extend an existing end date by a number of months and/or days (stacks
   * unlimited times — calling repeatedly keeps adding on top of the result).
   * @param {string} endStr 'YYYY-MM-DD'
   * @param {{months?: number, days?: number}} [opts]
   * @returns {string} 'YYYY-MM-DD'
   */
  function extendEnd(endStr, opts) {
    var months = (opts && opts.months) || 0;
    var days = (opts && opts.days) || 0;
    return addDays(addMonths(endStr, months), days);
  }

  /**
   * Calendar-day difference between the LOCAL calendar date of dateLike and
   * local today. Accepts an ISO timestamp or date string (e.g. trial_end).
   * The timestamp is first converted to its local Y/M/D, then compared as
   * epoch days (so this is a whole-calendar-day diff, not a millisecond diff
   * divided by 24h — avoids DST/partial-day skew). Used by the trial badge.
   * @param {string|Date} dateLike
   * @returns {number}
   */
  function daysUntil(dateLike) {
    var d = new Date(dateLike);
    var localStr = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    return toEpochDay(localStr) - toEpochDay(todayStr());
  }

  return {
    isValidDateStr: isValidDateStr,
    todayStr: todayStr,
    addDays: addDays,
    addMonths: addMonths,
    computeEndDate: computeEndDate,
    remainingDays: remainingDays,
    isExpired: isExpired,
    nextRenewalStart: nextRenewalStart,
    extendEnd: extendEnd,
    daysUntil: daysUntil
  };
});
