/*
 * Gym Flow integration smoke + isolation + security + billing suite. [L8]
 *
 * Usage:
 *   1. Start the server:  npm start         (needs RAZORPAY_WEBHOOK_SECRET in .env
 *                                             for the billing webhook assertions)
 *   2. Run the suite:     npm test
 *
 * The suite provisions two throwaway tenants through the real signup flow, force-
 * verifies them in the DB, sets a known password, then exercises tenant isolation,
 * the auth/CSRF/rate-limit hardening, and the Razorpay webhook billing path.
 * Exits non-zero if any assertion fails.
 */
const crypto = require('crypto');
const path = require('path');
const sqlite3 = require('sqlite3');

const BASE = process.env.TEST_BASE || 'http://localhost:3000';
const WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || 'whsec_test_local_123';
const PW = 'TestPass123!';
const DB = path.join(__dirname, '..', 'database.db');

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name, extra ? '-> ' + extra : ''); }
}

function dbRun(sql, p = []) { return new Promise((res, rej) => { const d = new sqlite3.Database(DB); d.run(sql, p, function (e) { d.close(); e ? rej(e) : res(this); }); }); }
function dbGet(sql, p = []) { return new Promise((res, rej) => { const d = new sqlite3.Database(DB); d.get(sql, p, (e, r) => { d.close(); e ? rej(e) : res(r); }); }); }

async function req(path, { method = 'GET', cookie, body, origin, headers = {} } = {}) {
  const h = { ...headers };
  if (cookie) h.Cookie = cookie;
  if (origin) h.Origin = origin;
  let payload;
  if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(`${BASE}${path}`, { method, headers: h, body: payload, redirect: 'manual' });
  let json; const t = await r.text(); try { json = JSON.parse(t); } catch { json = t; }
  return { status: r.status, body: json, setCookie: r.headers.get('set-cookie'), location: r.headers.get('location') };
}
const cookieOf = (sc) => { const m = /auth_token=([^;]+)/.exec(sc || ''); return m ? `auth_token=${m[1]}` : null; };

async function provision(label) {
  const email = `suite_${label}_${Date.now()}${Math.floor(Math.random() * 1000)}@test.local`;
  const s = await req('/api/v1/auth/signup', { method: 'POST', body: { full_name: `Suite ${label}`, email, password: PW }, origin: BASE });
  if (![200, 201].includes(s.status)) throw new Error(`signup ${label} failed: ${s.status} ${JSON.stringify(s.body)}`);
  await dbRun('UPDATE users SET email_verified = 1 WHERE email = ?', [email]);
  const user = await dbGet('SELECT id, tenant_id FROM users WHERE email = ?', [email]);
  const l = await req('/api/v1/auth/login', { method: 'POST', body: { email, password: PW }, origin: BASE });
  const cookie = cookieOf(l.setCookie);
  if (!cookie) throw new Error(`login ${label} failed: ${l.status}`);
  return { email, cookie, tenantId: user.tenant_id, userId: user.id };
}

(async () => {
  console.log(`\nGym Flow integration suite -> ${BASE}\n`);

  // Preflight
  const ping = await req('/login');
  if (ping.status === 0) { console.error('Server not reachable on', BASE, '- run `npm start` first.'); process.exit(2); }

  console.log('Provisioning two tenants...');
  const A = await provision('A');
  const B = await provision('B');

  // --- Seed distinct member data per tenant ---
  console.log('\n[Setup] create a plan + member for each tenant');
  async function seedMember(t, name) {
    const H = { cookie: t.cookie, origin: BASE };
    let plans = (await req('/api/v1/plans', H)).body;
    if (!Array.isArray(plans) || plans.length === 0) {
      await req('/api/v1/plans', { ...H, method: 'POST', body: { name: 'Suite Plan', duration_months: 1, price: 1000 } });
      plans = (await req('/api/v1/plans', H)).body;
    }
    const m = await req('/api/v1/members', { ...H, method: 'POST', body: { full_name: name, phone: '9' + Math.floor(100000000 + Math.random() * 800000000), plan_id: plans[0].id } });
    return m.body.memberId;
  }
  const aMember = await seedMember(A, 'Alpha Member');
  const bMember = await seedMember(B, 'Beta Member');
  check('seeded member for A', !!aMember);
  check('seeded member for B', !!bMember);

  // --- Tenant isolation ---
  console.log('\n[Isolation]');
  const aList = (await req('/api/v1/members', { cookie: A.cookie })).body;
  const bList = (await req('/api/v1/members', { cookie: B.cookie })).body;
  const aNames = (Array.isArray(aList) ? aList : aList.members || []).map(m => m.full_name);
  const bNames = (Array.isArray(bList) ? bList : bList.members || []).map(m => m.full_name);
  check('A sees its own member', aNames.includes('Alpha Member'));
  check('A does NOT see B member', !aNames.includes('Beta Member'));
  check('B does NOT see A member', !bNames.includes('Alpha Member'));
  const crossRead = await req(`/api/v1/members/${bMember}`, { cookie: A.cookie });
  check('A cannot read B member by id (404)', crossRead.status === 404, String(crossRead.status));
  const crossDelete = await req(`/api/v1/members/${bMember}`, { method: 'DELETE', cookie: A.cookie, origin: BASE });
  check('A cannot delete B member (404)', crossDelete.status === 404, String(crossDelete.status));
  const bStill = await req(`/api/v1/members/${bMember}`, { cookie: B.cookie });
  check('B member still intact after A delete attempt', bStill.status === 200, String(bStill.status));

  // --- Auth flow (end-to-end) ---
  console.log('\n[Auth flow]');
  // Fresh signup must be able to log in immediately when email delivery is not
  // configured (no permanent "verify your email" dead end).
  const freshEmail = `auth_${Date.now()}@test.local`;
  const fresh = await req('/api/v1/auth/signup', { method: 'POST', origin: BASE, body: { full_name: 'Auth Flow', email: freshEmail, password: PW } });
  check('Signup succeeds (201)', [200, 201].includes(fresh.status), String(fresh.status));
  const freshLogin = await req('/api/v1/auth/login', { method: 'POST', origin: BASE, body: { email: freshEmail, password: PW } });
  const freshCookie = cookieOf(freshLogin.setCookie);
  check('New account can log in immediately (no verify dead-end)', freshLogin.status === 200 && !!freshCookie, String(freshLogin.status));
  const session = await req('/api/v1/auth/session', { cookie: freshCookie });
  check('Session endpoint returns user + tenant', session.status === 200 && session.body.user && !!session.body.tenant, String(session.status));
  const authCfg = await req('/api/v1/auth/config');
  check('auth/config exposes provider flags', authCfg.status === 200 && typeof authCfg.body.google === 'boolean', JSON.stringify(authCfg.body));
  // cleanup fresh auth-flow tenant
  if (session.body && session.body.user) {
    const ft = session.body.user.tenant_id;
    for (const tbl of ['settings', 'discount_rules', 'users', 'tenants']) {
      await dbRun(`DELETE FROM ${tbl} WHERE ${tbl === 'tenants' ? 'id' : 'tenant_id'} = ?`, [ft]).catch(() => {});
    }
    await dbRun('DELETE FROM users WHERE email = ?', [freshEmail]).catch(() => {});
  }

  // --- Security hardening ---
  console.log('\n[Security]');
  const csrf = await req('/api/v1/attendance/check-in', { method: 'POST', cookie: A.cookie, origin: 'http://evil.example.com', body: { member_id: aMember } });
  check('CSRF: foreign-origin POST blocked (403)', csrf.status === 403, String(csrf.status));
  const sameOrigin = await req('/api/v1/attendance/check-in', { method: 'POST', cookie: A.cookie, origin: BASE, body: { member_id: aMember } });
  check('CSRF: same-origin POST allowed', sameOrigin.status !== 403, String(sameOrigin.status));
  await req('/api/v1/auth/logout', { method: 'POST', cookie: A.cookie, origin: BASE });
  const afterLogout = await req('/api/v1/dashboard/summary', { cookie: A.cookie });
  check('Logout revokes token (401 after logout)', afterLogout.status === 401, String(afterLogout.status));
  const weak = await req('/api/v1/auth/signup', { method: 'POST', origin: BASE, body: { full_name: 'X', email: `w${Date.now()}@t.local`, password: 'short' } });
  check('Password policy rejects < 8 chars (400)', weak.status === 400, String(weak.status));
  let rl = 0; for (let i = 0; i < 13; i++) rl = (await req('/api/v1/auth/login', { method: 'POST', origin: BASE, body: { email: 'nobody@x.com', password: 'bad' } })).status;
  check('Rate limit kicks in on repeated bad logins (429)', rl === 429, String(rl));

  // --- Billing (C6) ---
  console.log('\n[Billing / C6]');
  const selfGrant = await req('/api/v1/subscription/change', { method: 'POST', cookie: B.cookie, origin: BASE, body: { plan: 'enterprise' } });
  check('Client cannot self-grant paid plan (402)', selfGrant.status === 402, String(selfGrant.status));
  const badSig = await req('/webhooks/razorpay', { method: 'POST', headers: { 'X-Razorpay-Signature': 'bad' }, body: { event: 'subscription.charged' } });
  check('Webhook rejects bad signature (400)', badSig.status === 400, String(badSig.status));
  const evt = JSON.stringify({ event: 'subscription.charged', payload: { subscription: { entity: { id: 'sub_suite', notes: { tenant_id: B.tenantId, plan: 'pro' } } } } });
  const sig = crypto.createHmac('sha256', WEBHOOK_SECRET).update(evt).digest('hex');
  const evtId = 'suite_evt_' + Date.now();
  const wh = await req('/webhooks/razorpay', { method: 'POST', headers: { 'X-Razorpay-Signature': sig, 'X-Razorpay-Event-Id': evtId, 'Content-Type': 'application/json' }, body: JSON.parse(evt) });
  const bPlan = await dbGet('SELECT subscription_plan FROM tenants WHERE id = ?', [B.tenantId]);
  check('Valid webhook activates plan (B -> pro)', wh.status === 200 && bPlan.subscription_plan === 'pro', JSON.stringify(bPlan));
  const wh2 = await req('/webhooks/razorpay', { method: 'POST', headers: { 'X-Razorpay-Signature': sig, 'X-Razorpay-Event-Id': evtId, 'Content-Type': 'application/json' }, body: JSON.parse(evt) });
  check('Webhook is idempotent on replay', wh2.body && wh2.body.duplicate === true, JSON.stringify(wh2.body));

  // --- Route smoke: key GETs return non-5xx for an authed tenant ---
  console.log('\n[Route smoke]');
  const routes = ['/dashboard/summary', '/finance/summary', '/finance/transactions', '/attendance/summary', '/attendance/logs', '/members', '/tasks', '/notifications', '/plans', '/subscription/status', '/settings/public', '/crm/leads', '/staff', '/equipment'];
  let smokeBad = [];
  for (const r of routes) { const res = await req('/api/v1' + r, { cookie: B.cookie }); if (res.status >= 500) smokeBad.push(`${r}:${res.status}`); }
  check('No 5xx across key authed GET routes', smokeBad.length === 0, smokeBad.join(', '));

  // --- Cleanup throwaway tenants ---
  for (const t of [A, B]) {
    for (const tbl of ['attendance', 'payments', 'invoices', 'memberships', 'members', 'membership_plans', 'settings', 'discount_rules', 'subscription_history', 'subscriptions', 'notifications', 'users', 'tenants']) {
      const col = tbl === 'tenants' ? 'id' : 'tenant_id';
      await dbRun(`DELETE FROM ${tbl} WHERE ${col} = ?`, [tbl === 'tenants' ? t.tenantId : t.tenantId]).catch(() => {});
    }
    await dbRun('DELETE FROM users WHERE id = ?', [t.userId]).catch(() => {});
  }

  console.log(`\n==== ${pass} passed, ${fail} failed ====\n`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('SUITE ERROR:', e); process.exit(1); });
