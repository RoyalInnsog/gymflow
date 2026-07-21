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
  const setCookies = r.headers.getSetCookie ? r.headers.getSetCookie() : (r.headers.get('set-cookie') ? [r.headers.get('set-cookie')] : []);
  return { status: r.status, body: json, setCookie: r.headers.get('set-cookie'), setCookies, location: r.headers.get('location') };
}
const cookieOf = (sc) => { const m = /auth_token=([^;]+)/.exec(sc || ''); return m ? `auth_token=${m[1]}` : null; };
// Build a full "name=value; name=value" Cookie header from a set-cookie array.
const jarOf = (setCookies) => (setCookies || []).map(c => c.split(';')[0]).filter(Boolean).join('; ');
// Pull one cookie's value out of a set-cookie array.
const cookieVal = (setCookies, name) => { for (const c of (setCookies || [])) { const m = new RegExp('^' + name + '=([^;]+)').exec(c); if (m) return m[1]; } return null; };

async function provision(label) {
  // Lowercase: the identity platform normalizes emails on signup (prevents
  // case-forked duplicate accounts), so direct-DB reads must use the stored form.
  const email = `suite_${label}_${Date.now()}${Math.floor(Math.random() * 1000)}@test.local`.toLowerCase();
  const phone = '9' + Math.floor(100000000 + Math.random() * 800000000);
  const s = await req('/api/v1/auth/signup', { method: 'POST', body: { full_name: `Suite ${label}`, email, phone, password: PW }, origin: BASE });
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
  const fresh = await req('/api/v1/auth/signup', { method: 'POST', origin: BASE, body: { full_name: 'Auth Flow', email: freshEmail, phone: '9' + Math.floor(100000000 + Math.random() * 800000000), password: PW } });
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

  // --- Identity platform: sessions, rotation, password, phone, normalization ---
  // Placed BEFORE the rate-limit test below (which exhausts the /login limiter).
  const idEmail = `id_${Date.now()}@test.local`;
  const idPhone = '9' + Math.floor(100000000 + Math.random() * 800000000);
  const idTenantIds = [];
  await req('/api/v1/auth/signup', { method: 'POST', origin: BASE, body: { full_name: 'Identity One', email: idEmail, phone: idPhone, password: PW } });

  console.log('\n[Identity: sessions]');
  const s1 = await req('/api/v1/auth/login', { method: 'POST', origin: BASE, body: { email: idEmail, password: PW } });
  const jar1 = jarOf(s1.setCookies);
  check('Login sets refresh_token cookie', !!cookieVal(s1.setCookies, 'refresh_token'));
  check('Login sets device_token cookie', !!cookieVal(s1.setCookies, 'device_token'));
  const sess1 = await req('/api/v1/auth/sessions', { cookie: jar1 });
  check('New login appears in /sessions as current', sess1.status === 200 && (sess1.body.sessions || []).some(s => s.current), JSON.stringify(sess1.body).slice(0, 120));
  const s2 = await req('/api/v1/auth/login', { method: 'POST', origin: BASE, body: { email: idEmail, password: PW } });
  const jar2 = jarOf(s2.setCookies);
  const twoList = await req('/api/v1/auth/sessions', { cookie: jar2 });
  check('Second login yields >= 2 active sessions', (twoList.body.sessions || []).length >= 2, String((twoList.body.sessions || []).length));
  const la = await req('/api/v1/auth/logout-all', { method: 'POST', cookie: jar1, origin: BASE });
  check('logout-all revokes other sessions', la.status === 200 && la.body.revoked >= 1, JSON.stringify(la.body));
  check('Current session survives logout-all', (await req('/api/v1/auth/sessions', { cookie: jar1 })).status === 200);
  check('Other session rejected after logout-all (401)', (await req('/api/v1/auth/sessions', { cookie: jar2 })).status === 401);

  console.log('\n[Identity: refresh rotation & theft detection]');
  const sr = await req('/api/v1/auth/login', { method: 'POST', origin: BASE, body: { email: idEmail, password: PW } });
  const R0 = cookieVal(sr.setCookies, 'refresh_token');
  const sidR = (await req('/api/v1/auth/sessions', { cookie: jarOf(sr.setCookies) })).body.sessions.find(s => s.current).id;
  const rot = await req('/api/v1/auth/refresh', { method: 'POST', origin: BASE, cookie: `refresh_token=${R0}` });
  const R1 = cookieVal(rot.setCookies, 'refresh_token');
  check('Refresh rotates the token', rot.status === 200 && !!R1 && R1 !== R0, String(rot.status));
  // Backdate the rotation beyond the 30s concurrency grace so reuse counts as theft.
  await dbRun(`UPDATE auth_sessions SET rotated_at = datetime('now','-120 seconds') WHERE id = ?`, [sidR]);
  const reuse = await req('/api/v1/auth/refresh', { method: 'POST', origin: BASE, cookie: `refresh_token=${R0}` });
  check('Reused (post-grace) refresh token rejected (401)', reuse.status === 401, String(reuse.status));
  const revoked = await dbGet(`SELECT revoked_at, revoke_reason FROM auth_sessions WHERE id = ?`, [sidR]);
  check('Refresh reuse revokes the whole session', !!revoked.revoked_at && revoked.revoke_reason === 'refresh_reuse', JSON.stringify(revoked));
  check('Legit rotated token dead after theft-revoke', (await req('/api/v1/auth/refresh', { method: 'POST', origin: BASE, cookie: `refresh_token=${R1}` })).status === 401);

  console.log('\n[Identity: password change]');
  const cpA = await req('/api/v1/auth/login', { method: 'POST', origin: BASE, body: { email: idEmail, password: PW } });
  const jarA = jarOf(cpA.setCookies);
  const cpB = await req('/api/v1/auth/login', { method: 'POST', origin: BASE, body: { email: idEmail, password: PW } });
  const jarB = jarOf(cpB.setCookies);
  const NEWPW = 'ChangedPass789!';
  const chg = await req('/api/v1/auth/change-password', { method: 'POST', origin: BASE, cookie: jarA, body: { current_password: PW, new_password: NEWPW } });
  check('change-password succeeds', chg.status === 200, JSON.stringify(chg.body).slice(0, 120));
  check('Changing session stays signed in', (await req('/api/v1/auth/sessions', { cookie: jarA })).status === 200);
  check('Other session signed out by password change (401)', (await req('/api/v1/auth/sessions', { cookie: jarB })).status === 401);
  const reusePw = await req('/api/v1/auth/change-password', { method: 'POST', origin: BASE, cookie: jarA, body: { current_password: NEWPW, new_password: PW } });
  check('Password reuse rejected (PASSWORD_REUSE)', reusePw.status === 400 && reusePw.body.code === 'PASSWORD_REUSE', JSON.stringify(reusePw.body));
  check('New password works at login', (await req('/api/v1/auth/login', { method: 'POST', origin: BASE, body: { email: idEmail, password: NEWPW } })).status === 200);

  console.log('\n[Identity: phone OTP]');
  const otpJar = jarOf((await req('/api/v1/auth/login', { method: 'POST', origin: BASE, body: { email: idEmail, password: NEWPW } })).setCookies);
  const otpReq = await req('/api/v1/auth/phone/request-otp', { method: 'POST', origin: BASE, cookie: otpJar, body: { phone: '9998887776' } });
  check('OTP request returns a 6-digit devCode (non-prod)', otpReq.status === 200 && /^\d{6}$/.test(String(otpReq.body.devCode || '')), JSON.stringify(otpReq.body));
  check('Wrong OTP rejected (OTP_INVALID)', (await req('/api/v1/auth/phone/verify-otp', { method: 'POST', origin: BASE, cookie: otpJar, body: { phone: '9998887776', code: '000000' } })).body.code === 'OTP_INVALID');
  const goodOtp = await req('/api/v1/auth/phone/verify-otp', { method: 'POST', origin: BASE, cookie: otpJar, body: { phone: '9998887776', code: String(otpReq.body.devCode) } });
  check('Correct OTP verifies phone', goodOtp.status === 200 && goodOtp.body.phone_verified === true, JSON.stringify(goodOtp.body));

  console.log('\n[Identity: platform roles & redirects]');
  const extEmail = `ext_${Date.now()}@test.local`;
  const extPhone = '9' + Math.floor(100000000 + Math.random() * 800000000);
  await req('/api/v1/auth/signup', { method: 'POST', origin: BASE, body: { full_name: 'Ext User', email: extEmail, phone: extPhone, password: PW } });
  
  const extLogin = await req('/api/v1/auth/login', { method: 'POST', origin: BASE, body: { email: extEmail, password: PW } });
  let extJar = jarOf(extLogin.setCookies);
  
  const extSess = await req('/api/v1/auth/session', { cookie: extJar });
  check('New signup user has phone_verified = 0', extSess.body.user.phone_verified === 0, JSON.stringify(extSess.body.user));
  check('New signup user has platform_role = null', extSess.body.user.platform_role === null, JSON.stringify(extSess.body.user));

  const pageRedirect1 = await req('/dashboard', { cookie: extJar });
  check('Unverified phone redirects to /verify-phone', pageRedirect1.status === 302 && pageRedirect1.location === '/verify-phone', `${pageRedirect1.status} ${pageRedirect1.location}`);

  const extOtpReq = await req('/api/v1/auth/phone/request-otp', { method: 'POST', origin: BASE, cookie: extJar, body: { phone: extPhone } });
  const extVerifyOtp = await req('/api/v1/auth/phone/verify-otp', { method: 'POST', origin: BASE, cookie: extJar, body: { phone: extPhone, code: String(extOtpReq.body.devCode) } });
  extJar = jarOf(extVerifyOtp.setCookies);

  const extSess2 = await req('/api/v1/auth/session', { cookie: extJar });
  check('After OTP verification, user has phone_verified = 1', extSess2.body.user.phone_verified === 1, JSON.stringify(extSess2.body.user));

  const pageRedirect2 = await req('/dashboard', { cookie: extJar });
  check('Verified phone but unselected platform role redirects to /select-role', pageRedirect2.status === 302 && pageRedirect2.location === '/select-role', `${pageRedirect2.status} ${pageRedirect2.location}`);

  const badRole = await req('/api/v1/auth/platform-role', { method: 'POST', origin: BASE, cookie: extJar, body: { role: 'SUPERADMIN' } });
  check('Invalid platform role rejected', badRole.status === 400);

  const goodRole = await req('/api/v1/auth/platform-role', { method: 'POST', origin: BASE, cookie: extJar, body: { role: 'MEMBER' } });
  check('Setting platform role MEMBER works', goodRole.status === 200 && goodRole.body.redirect === '/member-coming-soon', JSON.stringify(goodRole.body));
  extJar = jarOf(goodRole.setCookies);

  const pageRedirect3 = await req('/dashboard', { cookie: extJar });
  check('Platform role MEMBER redirects to /member-coming-soon', pageRedirect3.status === 302 && pageRedirect3.location === '/member-coming-soon', `${pageRedirect3.status} ${pageRedirect3.location}`);

  const doubleRole = await req('/api/v1/auth/platform-role', { method: 'POST', origin: BASE, cookie: extJar, body: { role: 'ADMIN' } });
  check('Cannot select platform role twice', doubleRole.status === 400 && doubleRole.body.code === 'ROLE_ALREADY_SELECTED', JSON.stringify(doubleRole.body));

  // cleanup ext user
  if (extSess2.body && extSess2.body.user) {
    const ft = extSess2.body.user.tenant_id;
    for (const tbl of ['settings', 'discount_rules', 'users', 'tenants']) {
      await dbRun(`DELETE FROM ${tbl} WHERE ${tbl === 'tenants' ? 'id' : 'tenant_id'} = ?`, [ft]).catch(() => {});
    }
  }
  await dbRun('DELETE FROM users WHERE email = ?', [extEmail]).catch(() => {});

  const admEmail = `adm_${Date.now()}@test.local`;
  const admPhone = '9' + Math.floor(100000000 + Math.random() * 800000000);
  await req('/api/v1/auth/signup', { method: 'POST', origin: BASE, body: { full_name: 'Adm User', email: admEmail, phone: admPhone, password: PW } });
  let admLogin = await req('/api/v1/auth/login', { method: 'POST', origin: BASE, body: { email: admEmail, password: PW } });
  let admJar = jarOf(admLogin.setCookies);
  const admOtpReq = await req('/api/v1/auth/phone/request-otp', { method: 'POST', origin: BASE, cookie: admJar, body: { phone: admPhone } });
  const admVerifyOtp = await req('/api/v1/auth/phone/verify-otp', { method: 'POST', origin: BASE, cookie: admJar, body: { phone: admPhone, code: String(admOtpReq.body.devCode) } });
  admJar = jarOf(admVerifyOtp.setCookies);
  const admRole = await req('/api/v1/auth/platform-role', { method: 'POST', origin: BASE, cookie: admJar, body: { role: 'ADMIN' } });
  check('Setting platform role ADMIN works', admRole.status === 200 && admRole.body.redirect === '/dashboard', JSON.stringify(admRole.body));
  admJar = jarOf(admRole.setCookies);
  const pageRedirect4 = await req('/dashboard', { cookie: admJar });
  check('Platform role ADMIN has access to /dashboard (200)', pageRedirect4.status === 200, String(pageRedirect4.status));
  // cleanup adm user
  const admSess = await req('/api/v1/auth/session', { cookie: admJar });
  if (admSess.body && admSess.body.user) {
    const ft = admSess.body.user.tenant_id;
    for (const tbl of ['settings', 'discount_rules', 'users', 'tenants']) {
      await dbRun(`DELETE FROM ${tbl} WHERE ${tbl === 'tenants' ? 'id' : 'tenant_id'} = ?`, [ft]).catch(() => {});
    }
  }
  await dbRun('DELETE FROM users WHERE email = ?', [admEmail]).catch(() => {});

  console.log('\n[Identity: email normalization / no duplicate account]');
  const mixed = `Mixed.Case_${Date.now()}@Test.Local`;
  const su1 = await req('/api/v1/auth/signup', { method: 'POST', origin: BASE, body: { full_name: 'Mixed Case', email: mixed, phone: '9' + Math.floor(100000000 + Math.random() * 800000000), password: PW } });
  check('Signup with mixed-case email succeeds', [200, 201].includes(su1.status), String(su1.status));
  const su2 = await req('/api/v1/auth/signup', { method: 'POST', origin: BASE, body: { full_name: 'Dup', email: mixed.toLowerCase(), phone: '9123456780', password: PW } });
  check('Duplicate signup (lowercased) blocked (400)', su2.status === 400, String(su2.status));
  check('Login with UPPERCASE email hits the same account', (await req('/api/v1/auth/login', { method: 'POST', origin: BASE, body: { email: mixed.toUpperCase(), password: PW } })).status === 200);
  const oneAcct = await dbGet(`SELECT COUNT(*) AS c FROM users WHERE lower(email) = ?`, [mixed.toLowerCase()]);
  check('Exactly one account for the email (no case-fork)', oneAcct.c === 1, JSON.stringify(oneAcct));

  console.log('\n[Identity: passwordless (Google-only) account]');
  const gId = 'u_gtest_' + Date.now(), gEmail = `gonly_${Date.now()}@test.local`, gTen = 't_gtest_' + Date.now();
  await dbRun(`INSERT INTO tenants (id,gym_name,subdomain,owner_user_id,subscription_plan,subscription_status) VALUES (?,?,?,?,'trial','trial')`, [gTen, 'G Gym', 'gtest' + Date.now(), gId]);
  await dbRun(`INSERT INTO users (id,role_id,tenant_id,email,password_hash,full_name,email_verified,status,password_set) VALUES (?, 'r1', ?, ?, NULL, 'G Only', 1, 'active', 0)`, [gId, gTen, gEmail]);
  await dbRun(`INSERT INTO user_roles (id,user_id,tenant_id,role_id) VALUES (?,?,?,'r1') ON CONFLICT DO NOTHING`, ['ur_' + gId, gId, gTen]);
  check('Passwordless account cannot password-login (401)', (await req('/api/v1/auth/login', { method: 'POST', origin: BASE, body: { email: gEmail, password: 'anything123' } })).status === 401);

  // Identity cleanup — collect owned tenants, delete users (cascades sessions/
  // events/providers/roles/verifications), then their tenants + settings.
  for (const em of [idEmail, mixed.toLowerCase(), gEmail]) {
    const u = await dbGet('SELECT id, tenant_id FROM users WHERE lower(email) = ?', [em.toLowerCase()]).catch(() => null);
    if (u && u.tenant_id) idTenantIds.push(u.tenant_id);
  }
  for (const em of [idEmail, mixed.toLowerCase(), gEmail]) {
    await dbRun('DELETE FROM users WHERE lower(email) = ?', [em.toLowerCase()]).catch(() => {});
  }
  for (const t of idTenantIds) {
    for (const tbl of ['settings', 'discount_rules', 'membership_plans', 'tenants']) {
      await dbRun(`DELETE FROM ${tbl} WHERE ${tbl === 'tenants' ? 'id' : 'tenant_id'} = ?`, [t]).catch(() => {});
    }
  }

  // --- Organization & Identity Graph (F2) ---
  // Self-contained: provisions its own accounts, exercises invitations, claims,
  // permission enforcement and membership lifecycle, then cleans up. Runs before
  // the rate-limit test below (which saturates the /login limiter).
  const orgUsers = [];
  async function provisionAcct(label, phone) {
    const email = `org_${label}_${Date.now()}${Math.floor(Math.random() * 1000)}@test.local`.toLowerCase();
    await req('/api/v1/auth/signup', { method: 'POST', origin: BASE, body: { full_name: `Org ${label}`, email, phone, password: PW } });
    const l = await req('/api/v1/auth/login', { method: 'POST', origin: BASE, body: { email, password: PW } });
    const row = await dbGet('SELECT id, tenant_id FROM users WHERE email = ?', [email]);
    orgUsers.push(email);
    return { email, phone, jar: jarOf(l.setCookies), userId: row.id, tenantId: row.tenant_id };
  }

  console.log('\n[Org: invitations]');
  const O = await provisionAcct('owner', '9' + Math.floor(100000000 + Math.random() * 800000000));
  const I = await provisionAcct('invitee', '9' + Math.floor(100000000 + Math.random() * 800000000));
  const inv = await req('/api/v1/org/invitations', { method: 'POST', origin: BASE, cookie: O.jar, body: { email: I.email, role_id: 'r2' } });
  check('Owner can invite staff by email (201)', inv.status === 201 && !!inv.body.id, String(inv.status));
  const ctxI = await req('/api/v1/org/context', { cookie: I.jar });
  check('Invitee sees the pending invitation', (ctxI.body.pending_invitations || []).length === 1, JSON.stringify(ctxI.body.pending_invitations));
  const acc = await req(`/api/v1/org/invitations/${inv.body.id}/accept`, { method: 'POST', origin: BASE, cookie: I.jar, body: {} });
  check('Invitee accepts → joins the org', acc.status === 200 && acc.body.tenant_id === O.tenantId, JSON.stringify(acc.body).slice(0, 100));
  const reAcc = await req(`/api/v1/org/invitations/${inv.body.id}/accept`, { method: 'POST', origin: BASE, cookie: I.jar, body: {} });
  check('Re-accept blocked — no duplicate membership', reAcc.body.code === 'ALREADY_ACCEPTED', JSON.stringify(reAcc.body));
  const roster = await req('/api/v1/org/members', { cookie: O.jar });
  const inviteeRows = (roster.body.members || []).filter(m => m.email === I.email);
  check('Roster lists the invitee once as Manager', inviteeRows.length === 1 && inviteeRows[0].role_name === 'Manager', JSON.stringify(inviteeRows));
  check('Invitee now holds two organizations', (await req('/api/v1/org/context', { cookie: I.jar })).body.organizations.length === 2);

  console.log('\n[Org: permission enforcement (DB-driven RBAC)]');
  const sw = await req('/api/v1/auth/select-role', { method: 'POST', origin: BASE, cookie: I.jar, body: { tenant_id: O.tenantId, role_id: 'r2' } });
  const jarMgr = jarOf(sw.setCookies);
  const mgrInvite = await req('/api/v1/org/invitations', { method: 'POST', origin: BASE, cookie: jarMgr, body: { email: 'x@y.local', role_id: 'r3' } });
  check('Manager CANNOT invite (403 PERMISSION_DENIED)', mgrInvite.status === 403 && mgrInvite.body.code === 'PERMISSION_DENIED', String(mgrInvite.status));
  const mgrClaims = await req('/api/v1/org/claims', { cookie: jarMgr });
  check('Manager CAN view claims (has members:write)', mgrClaims.status === 200, String(mgrClaims.status));

  console.log('\n[Org: member claim]');
  // Give O a plan, then a member whose email+phone match a new account M.
  let oPlans = (await req('/api/v1/plans', { cookie: O.jar })).body;
  if (!Array.isArray(oPlans) || oPlans.length === 0) {
    await req('/api/v1/plans', { method: 'POST', origin: BASE, cookie: O.jar, body: { name: 'Org Plan', duration_months: 1, price: 1000 } });
    oPlans = (await req('/api/v1/plans', { cookie: O.jar })).body;
  }
  const mPhone = '9' + Math.floor(100000000 + Math.random() * 800000000);
  const mEmail = `org_member_${Date.now()}@test.local`.toLowerCase();
  const mkMember = await req('/api/v1/members', { method: 'POST', origin: BASE, cookie: O.jar, body: { full_name: 'Claim Target', phone: mPhone, email: mEmail, plan_id: oPlans[0].id, start_date: '2026-07-01', end_date: '2026-08-01' } });
  const memberId = mkMember.body.memberId || mkMember.body.member_id;
  check('Owner created a member to be claimed', !!memberId, JSON.stringify(mkMember.body).slice(0, 100));
  const M = await provisionAcct('claimer', mPhone); // same phone
  // Re-point M's email to the member's email so both match (high confidence).
  await dbRun('UPDATE users SET email = ? WHERE id = ?', [mEmail, M.userId]);
  const mLogin = await req('/api/v1/auth/login', { method: 'POST', origin: BASE, body: { email: mEmail, password: PW } });
  const jarM = jarOf(mLogin.setCookies);
  const ctxM = await req('/api/v1/org/context', { cookie: jarM });
  const pc = (ctxM.body.pending_claims || [])[0];
  check('Claim candidate detected (both fields, high confidence)', !!pc && pc.match_basis === 'both' && pc.confidence === 'high', JSON.stringify(ctxM.body.pending_claims));
  const cAcc = await req('/api/v1/org/claims/accept', { method: 'POST', origin: BASE, cookie: jarM, body: { tenant_id: O.tenantId, member_id: memberId } });
  check('High-confidence claim auto-links', cAcc.status === 200 && cAcc.body.linked === true, JSON.stringify(cAcc.body));
  const link = await dbGet('SELECT role_id, member_id, status FROM user_roles WHERE user_id = ? AND member_id = ?', [M.userId, memberId]);
  check('Graph link written (user_roles.member_id → member, role r5)', !!link && link.role_id === 'r5' && link.status === 'active', JSON.stringify(link));
  const reClaim = await req('/api/v1/org/claims/accept', { method: 'POST', origin: BASE, cookie: jarM, body: { tenant_id: O.tenantId, member_id: memberId } });
  check('Re-claim blocked (CLAIM_TAKEN)', reClaim.body.code === 'CLAIM_TAKEN', JSON.stringify(reClaim.body));

  // --- [U1] Member self-service API ---
  // M is now linked to O's gym as r5 (via the claim above). Scope into the
  // member role and exercise the /api/v1/member surface + its two hard gates.
  console.log('\n[Member API (U1)]');
  const swM = await req('/api/v1/auth/select-role', { method: 'POST', origin: BASE, cookie: jarM, body: { tenant_id: O.tenantId, role_id: 'r5' } });
  const jarMbr = jarOf(swM.setCookies);
  check('Member can scope into r5 via select-role', swM.status === 200 && !!jarMbr, String(swM.status));

  const mOv = await req('/api/v1/member/overview', { cookie: jarMbr });
  check('Member overview 200 + linked + plan resolved',
    mOv.status === 200 && mOv.body.linked === true && mOv.body.membership && mOv.body.membership.plan_name === 'Org Plan' && typeof mOv.body.membership.days_left === 'number',
    JSON.stringify(mOv.body).slice(0, 160));

  const mCross = await req('/api/v1/members', { cookie: jarMbr });
  check('Member token 403 on the STAFF API', mCross.status === 403, String(mCross.status));
  const sCross = await req('/api/v1/member/overview', { cookie: O.jar });
  check('Staff token 403 on the MEMBER API', sCross.status === 403, String(sCross.status));

  const h1 = await req('/api/v1/member/health', { method: 'POST', origin: BASE, cookie: jarMbr, body: { water_ml: 500, weight_kg: 80 } });
  check('Health log created (water 500 / weight 80)', h1.status === 201 && h1.body.water_ml === 500 && h1.body.weight_kg === 80, JSON.stringify(h1.body).slice(0, 120));
  const h2 = await req('/api/v1/member/health', { method: 'POST', origin: BASE, cookie: jarMbr, body: { water_ml: 750 } });
  check('Same-day health POST upserts (water 750, weight preserved)', h2.status === 201 && h2.body.water_ml === 750 && h2.body.weight_kg === 80, JSON.stringify(h2.body).slice(0, 120));
  const hList = await req('/api/v1/member/health', { cookie: jarMbr });
  check('Health list has exactly ONE row for today (no dupes)', Array.isArray(hList.body) && hList.body.length === 1, JSON.stringify(hList.body).slice(0, 120));

  const wp = await req('/api/v1/member/workouts', { method: 'POST', origin: BASE, cookie: jarMbr, body: { name: 'Push Day', day_of_week: 'mon', exercises: [{ name: 'Bench Press', sets: 3, reps: 10, weight_kg: 60 }] } });
  check('Workout plan created with exercises', wp.status === 201 && wp.body.id && Array.isArray(wp.body.exercises) && wp.body.exercises[0].name === 'Bench Press', JSON.stringify(wp.body).slice(0, 140));
  const wpUpd = await req(`/api/v1/member/workouts/${wp.body.id}`, { method: 'PUT', origin: BASE, cookie: jarMbr, body: { day_of_week: 'tue' } });
  check('Workout plan update keeps exercises', wpUpd.status === 200 && wpUpd.body.day_of_week === 'tue' && wpUpd.body.exercises.length === 1, JSON.stringify(wpUpd.body).slice(0, 140));

  const ws = await req('/api/v1/member/sessions', { method: 'POST', origin: BASE, cookie: jarMbr, body: { plan_id: wp.body.id, plan_name: 'Push Day', duration_min: 45, completed: ['Bench Press'], total_volume_kg: 1800 } });
  check('Workout session logged', ws.status === 201 && !!ws.body.id, JSON.stringify(ws.body).slice(0, 120));
  const wsList = await req('/api/v1/member/sessions', { cookie: jarMbr });
  check('Session history returns completed[] parsed', Array.isArray(wsList.body) && wsList.body.length === 1 && wsList.body[0].completed[0] === 'Bench Press', JSON.stringify(wsList.body).slice(0, 140));

  const pr = await req('/api/v1/member/prs', { method: 'POST', origin: BASE, cookie: jarMbr, body: { exercise: 'Bench Press', weight_kg: 80, reps: 1 } });
  check('PR saved', pr.status === 201 && pr.body.exercise === 'Bench Press', JSON.stringify(pr.body).slice(0, 120));

  const gl = await req('/api/v1/member/goals', { method: 'POST', origin: BASE, cookie: jarMbr, body: { title: 'Reach 75kg', target_value: '75 kg' } });
  check('Goal created', gl.status === 201 && !!gl.body.id, JSON.stringify(gl.body).slice(0, 120));
  const glDone = await req(`/api/v1/member/goals/${gl.body.id}`, { method: 'PUT', origin: BASE, cookie: jarMbr, body: { status: 'done' } });
  check('Goal status transitions', glDone.status === 200 && glDone.body.status === 'done', JSON.stringify(glDone.body).slice(0, 120));

  const mAtt = await req('/api/v1/member/attendance', { cookie: jarMbr });
  check('Member attendance list is an array', mAtt.status === 200 && Array.isArray(mAtt.body), String(mAtt.status));
  const mProf = await req('/api/v1/member/profile', { cookie: jarMbr });
  check('Member profile resolves the linked members-row', mProf.status === 200 && mProf.body.linked === true && mProf.body.member && mProf.body.member.full_name === 'Claim Target', JSON.stringify(mProf.body).slice(0, 140));
  const mUnknown = await req('/api/v1/member/nope', { cookie: jarMbr });
  check('Unknown member route is a clean 404 (not staff 403)', mUnknown.status === 404, String(mUnknown.status));

  console.log('\n[Org: membership lifecycle]');
  const selfSusp = await req(`/api/v1/org/members/${O.userId}/suspend`, { method: 'POST', origin: BASE, cookie: O.jar, body: {} });
  check('Cannot suspend the only owner (409 LAST_OWNER)', selfSusp.status === 409 && selfSusp.body.code === 'LAST_OWNER', JSON.stringify(selfSusp.body));
  const susp = await req(`/api/v1/org/members/${I.userId}/suspend`, { method: 'POST', origin: BASE, cookie: O.jar, body: {} });
  check('Owner can suspend a member', susp.status === 200, String(susp.status));
  // I's original token was revoked by its earlier select-role (token exchange), so
  // re-login for a fresh view of its active memberships.
  const iRelogin = async () => jarOf((await req('/api/v1/auth/login', { method: 'POST', origin: BASE, body: { email: I.email, password: PW } })).setCookies);
  const ctxISusp = await req('/api/v1/org/context', { cookie: await iRelogin() });
  check('Suspended membership disappears from getUserRoles', !(ctxISusp.body.organizations || []).some(o => o.tenant_id === O.tenantId), JSON.stringify(ctxISusp.body.organizations));
  await req(`/api/v1/org/members/${I.userId}/reactivate`, { method: 'POST', origin: BASE, cookie: O.jar, body: {} });
  check('Reactivated membership returns', ((await req('/api/v1/org/context', { cookie: await iRelogin() })).body.organizations || []).some(o => o.tenant_id === O.tenantId));

  console.log('\n[Org: ownership transfer]');
  const xfer = await req('/api/v1/org/ownership/transfer', { method: 'POST', origin: BASE, cookie: O.jar, body: { to_user_id: I.userId } });
  check('Ownership transfer succeeds', xfer.status === 200, JSON.stringify(xfer.body).slice(0, 100));
  const ownerRow = await dbGet('SELECT owner_user_id FROM tenants WHERE id = ?', [O.tenantId]);
  check('tenants.owner_user_id points to the new owner', ownerRow.owner_user_id === I.userId, JSON.stringify(ownerRow));
  const newOwnerRole = await dbGet(`SELECT role_id FROM user_roles WHERE user_id = ? AND tenant_id = ? AND role_id = 'r1' AND status = 'active'`, [I.userId, O.tenantId]);
  check('New owner holds the Owner role', !!newOwnerRole, JSON.stringify(newOwnerRole));

  // Org cleanup — delete provisioned accounts (cascades user_roles/invitations/
  // member_claims/staff) then their tenants + tenant-scoped data.
  const orgTenantIds = [];
  for (const em of orgUsers) {
    const u = await dbGet('SELECT id, tenant_id FROM users WHERE lower(email) = ?', [em.toLowerCase()]).catch(() => null);
    if (u && u.tenant_id) orgTenantIds.push(u.tenant_id);
    await dbRun('DELETE FROM member_claims WHERE user_id = ?', [u ? u.id : '']).catch(() => {});
  }
  for (const em of orgUsers) await dbRun('DELETE FROM users WHERE lower(email) = ?', [em.toLowerCase()]).catch(() => {});
  for (const t of orgTenantIds) {
    for (const tbl of ['workout_plans', 'workout_sessions', 'personal_records', 'health_logs', 'body_measurements', 'member_goals', 'members', 'memberships', 'membership_plans', 'invitations', 'member_claims', 'staff', 'settings', 'discount_rules', 'tenants']) {
      await dbRun(`DELETE FROM ${tbl} WHERE ${tbl === 'tenants' ? 'id' : 'tenant_id'} = ?`, [t]).catch(() => {});
    }
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
  const weak = await req('/api/v1/auth/signup', { method: 'POST', origin: BASE, body: { full_name: 'X', email: `w${Date.now()}@t.local`, phone: '9123456780', password: 'short' } });
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
