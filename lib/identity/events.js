/*
 * [IDENTITY] Security events: the audit trail behind the Security Center's
 * "recent activity", new-device alerts, and the per-email account lockout.
 * Recording is best-effort — an audit failure must never break an auth flow.
 */
const { getQuery, runQuery, allQuery } = require('../../database');
const core = require('./core');

// Lockout: >= MAX failures for one email within WINDOW (across ALL IPs — this is
// what the per-IP limiter cannot see) => login temporarily refused with the same
// generic copy as the rate limiter, so it leaks nothing about account existence.
const LOCKOUT_WINDOW_MS = 15 * 60 * 1000;
const LOCKOUT_MAX_FAILURES = 8;

async function record({ userId = null, email = null, event, req = null, meta = null }) {
  try {
    await runQuery(
      `INSERT INTO security_events (id, user_id, email, event, ip, user_agent, meta)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [core.newId('sev'), userId, email ? core.normalizeEmail(email) : null, event,
       req ? (req.ip || null) : null,
       req ? String(req.headers['user-agent'] || '').slice(0, 512) : null,
       meta ? JSON.stringify(meta) : null]);
  } catch (e) {
    console.error('[identity] security event write failed:', e.message);
  }
}

async function isLockedOut(email) {
  const row = await getQuery(
    `SELECT COUNT(*) AS c FROM security_events
      WHERE email = ? AND event = 'login_failed' AND created_at > datetime('now', '-15 minutes')`,
    [core.normalizeEmail(email)]);
  return row.c >= LOCKOUT_MAX_FAILURES;
}

// Recent activity for the Security Center — user agent is parsed at read time.
async function recentEvents(userId, limit = 15) {
  const rows = await allQuery(
    `SELECT event, ip, user_agent, created_at FROM security_events
      WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`, [userId, limit]);
  return rows.map(r => {
    const ua = core.parseUserAgent(r.user_agent);
    return { event: r.event, ip: r.ip, browser: ua.browser, os: ua.os, created_at: r.created_at };
  });
}

module.exports = { record, isLockedOut, recentEvents, LOCKOUT_WINDOW_MS, LOCKOUT_MAX_FAILURES };
