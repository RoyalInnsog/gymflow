# GYM FLOW — PRIORITIZED REPAIR & EXECUTION PLAN (`FIX_PLAN.md`)

**Generated:** 2026-06-16
**Scope:** Repair plan only. No code has been changed. All file/line references are against the **current working tree** (the files on disk), unless explicitly marked *(committed build)*.
**Companion doc:** `GYM_FLOW_FINAL_AUDIT.md` (findings + evidence).

---

## How to read this plan

**Complexity** — implementation difficulty:
- `S` (Small): mechanical, localized, < ~2h.
- `M` (Medium): touches several handlers or needs a test, ~2–8h.
- `L` (Large): architectural / cross-cutting, > ~8h.

**Risk** — chance the *fix itself* breaks something and how careful you must be:
- `Low` — isolated, hard to get wrong.
- `Med` — affects shared paths; needs regression testing.
- `High` — touches auth/billing/data-access core; needs tests + staged rollout.

**Important context that shapes the whole plan:**
The working tree is the output of a half-finished automated refactor (`inject_tenant.js`). It did two things at once:
1. Added `tenant_id` scoping to most handlers — **good intent**, but
2. Corrupted ~49 query calls into `query("sql"[params])` = `query(undefined)` — **which makes the app segfault on first authenticated request.**

So a large amount of isolation work *exists but does not run and is unverified*. **Phase 1 must come first** — until the app boots, nothing else can be tested. After Phase 1, much of Phase 2/5 becomes *verification* of already-written scoping plus fixing the handful of endpoints the refactor missed.

---

# PART A — FINDINGS BY SEVERITY

> Each finding: exact file · exact function · exact lines · root cause · current snippet · fixed snippet · effort.

---

## CRITICAL

---

### C1 — `query("sql"[params])` pattern crashes the server (≈49 sites)
- **File:** `routes/api.js`
- **Functions / lines (all 49 sites):**
  `checkSubscription` →68 · `/onboarding/complete-tour`→173 · `/onboarding/complete-setup`→202 · `/onboarding/restart-tour`→254 · `/subscription/change`→270 · `/subscription/verify-payment`→333,339 · `/subscription/submit-upi-payment`→389,396 · `resolveTemplate`→457,464 · `runAutomationScans`→516,517,520,550,578,609,670,701,726,757 · `/members/:id`→849,865,880,895,908,925 · `POST /members`→1034 · `DELETE /members/:id`→1176,1177,1178,1179,1180 · `/attendance/check-in`→1243,1245 · `/finance/receipt/:invoiceNumber`→1317 · `/crm/leads/:id/stage`→1486 · `/tasks/:id`→1514 · `/notifications/:id/read`→1541 · `/whatsapp/send`→1992,2007,2011,2016 · `/reports/closing/today`→2355 · `/templates/:id`→2705 · `/settings/public`→3577 · `/templates/:id (2)`→3715 · `/branches/:id`→3754.
- **Root cause:** `inject_tenant.js` appended ` AND tenant_id = ? ` **and** the params array inside the string literal. `"…sql…"[a, b]` is member access on a string → `undefined`; the helper then calls `db.get(undefined, …)`, which segfaults the sqlite3 native binding. `checkSubscription` (line 68) runs on **every** request via `router.use(checkSubscription)`, so the whole API is down.
- **Current code (representative — string literal, line 68):**
  ```js
  const tenant = await getQuery("SELECT subscription_plan, trial_end, subscription_status FROM tenants WHERE id = ? AND tenant_id = ? "[req.tenant_id, req.tenant_id]);
  ```
- **Current code (representative — template literal, line 865):**
  ```js
  const attEvents = await allQuery(`SELECT check_in, check_out FROM attendance WHERE member_id = ?  AND tenant_id = ? ORDER BY check_in DESC`[member.id, req.tenant_id]);
  ```
- **Fixed code (canonical transform — move `[params]` out of the string into arg #2):**
  ```js
  // line 68 — note: tenants are keyed by id only; tenant_id is not a tenants column, drop it
  const tenant = await getQuery(
    "SELECT subscription_plan, trial_end, subscription_status FROM tenants WHERE id = ?",
    [req.tenant_id]
  );

  // line 865
  const attEvents = await allQuery(
    `SELECT check_in, check_out FROM attendance WHERE member_id = ? AND tenant_id = ? ORDER BY check_in DESC`,
    [member.id, req.tenant_id]
  );
  ```
  Apply the identical `"…"[x,y]` → `"…", [x,y]` transform to **all 49 lines**. Watch two correctness traps the refactor also introduced:
  - **`tenants` queries** (68, 173, 202, 254, 270, 333, 339, 389, 396, 3577) gained ` AND tenant_id = ?` but `tenants` has **no `tenant_id` column** (its PK is `id`). Remove the bogus `AND tenant_id = ?` and bind `id` once.
  - **Comm history query (line 920–925)** has an operator-precedence bug (`WHERE a OR b OR c AND tenant_id`) — wrap the OR group in parentheses while fixing.
- **Guardrail:** add a CI grep that fails the build on `/\)\s*\[/`-style `query(...)[` or `"\s*\[req` patterns.
- **Effort:** Complexity `M` · Risk `Med` (mechanical but 49 sites; one missed query keeps the crash). ~6–10h incl. a boot smoke-test of every route.

---

### C2 — Tenant isolation: reporting endpoints not (or unverifiably) scoped
- **File:** `routes/api.js`
- **Two sub-classes:**
  - **(a) Missed entirely — still global** (these have *no* working tenant filter):
    - `/activity-logs` handler (route at line 3403; query `FROM activity_logs a` at **3407**) — 0 tenant refs.
    - `/export/:type` **activity branch** — `GET /export/:type` (3464), line **3482**: `SELECT … FROM activity_logs` (no `WHERE`).
    - `/finance/pending` (`GET /finance/pending`, 1331) — query lines **1335–1337**: passes `[req.tenant_id]` but SQL has **no placeholder** (silently ignored).
    - `/finance/collect/verify` (1400) payment lookup/update **1409, 1413, 1416** and `/memberships/renew/verify` (2314) **2323, 2327, 2330** — `WHERE id = ?` with no `tenant_id` (cross-tenant tamper; see H7).
    - `/reports/closing/lock` (2428) — 0 tenant refs (verify/fix).
  - **(b) Scoped-but-broken** — most analytics handlers (`/analytics/bi`, `/churn`, `/member-segments`, `/finance-dashboard`, `/executive-summary`, `/renewal-forecast`, `/marketing/dashboard`, etc.) *had* `tenant_id` injected, but via the C1 broken syntax, so they don't run and were never verified. After C1, they must be proven isolated, not assumed.
- **Root cause:** Aggregate/report queries authored without a `tenant_id` predicate; refactor missed JOIN/`activity_logs` queries and the `finance/pending` placeholder.
- **Current code (finance/pending, 1333–1338):**
  ```js
  const pending = await allQuery(`
    SELECT i.*, m.full_name, m.photo_url, m.phone, m.id as member_id
    FROM invoices i
    JOIN members m ON i.member_id = m.id
    WHERE i.status = 'Unpaid'
  `, [req.tenant_id]);
  ```
- **Fixed code:**
  ```js
  const pending = await allQuery(`
    SELECT i.*, m.full_name, m.photo_url, m.phone, m.id as member_id
    FROM invoices i
    JOIN members m ON i.member_id = m.id
    WHERE i.status = 'Unpaid' AND i.tenant_id = ?
  `, [req.tenant_id]);
  ```
- **Current code (export activity, 3482):**
  ```js
  data = await allQuery("SELECT id, user_id, action, table_name, created_at FROM activity_logs");
  ```
- **Fixed code:**
  ```js
  data = await allQuery(
    "SELECT id, user_id, action, table_name, created_at FROM activity_logs WHERE tenant_id = ?",
    [req.tenant_id]
  );
  ```
- **Mandatory companion work:** a two-tenant isolation integration test (provision tenant A + B with distinct data; assert every GET returns only the caller's rows; assert no two tenants get byte-identical aggregates). This is the only reliable way to confirm (b).
- **Effort:** Complexity `L` · Risk `High` (core data-access; easy to miss a query). ~16–24h incl. the test harness.

---

### C3 — Entire project root (incl. `database.db` + source) served unauthenticated
- **File:** `server.js` · **Function:** top-level middleware setup · **Line:** **31**
- **Root cause:** Static middleware rooted at the app directory, which contains the live DB, all source, and backups. `GET /database.db` → 200 (verified).
- **Current code (31):**
  ```js
  app.use(express.static(__dirname));
  ```
- **Fixed code:**
  ```js
  // Serve ONLY a dedicated public dir; never the project root.
  app.use(express.static(path.join(__dirname, 'public'), { dotfiles: 'deny' }));
  ```
  Companion: move front-end screen folders + `assets/` under `public/`; move `database.db` and all backups **outside the web root** (e.g. a `data/` dir excluded from static); add a deploy check asserting `GET /database.db` → 404. (Pairs with M7.)
- **Effort:** Complexity `M` · Risk `Med` (static-path move can break asset URLs; test every screen loads). ~4–6h.

---

### C4 — Hard-coded backdoor accounts in seed
- **File:** `database.js` · **Function:** `initializeDatabase` (users seed block) · **Lines:** **695–703**
- **Root cause:** Demo users seeded with publicly-known passwords and `email_verified=1`. Login as `admin@jsbfitness.in` / `admin123` verified.
- **Current code (695–702):**
  ```js
  const ownerHash = await bcrypt.hash('admin123', 10);
  const managerHash = await bcrypt.hash('vikram123', 10);
  await runQuery(`INSERT INTO users (id, role_id, email, password_hash, full_name, email_verified, status) VALUES
    ('u1', 'r1', 'admin@jsbfitness.in', '${ownerHash}', 'System Admin', 1, 'active'),
    ('u2', 'r2', 'manager@jsbfitness.in', '${managerHash}', 'Gym Manager', 1, 'active')
  `);
  ```
- **Fixed code:** remove the seeded humans entirely; let the owner be created via signup only.
  ```js
  // No seeded human accounts. First Owner is created through /api/v1/auth/signup.
  // (If an operator bootstrap account is required, generate a random password,
  //  print it once to stdout, and force a reset on first login.)
  ```
  Also stop string-interpolating hashes into SQL — bind them.
- **Effort:** Complexity `S` · Risk `Low`. ~1h (plus a migration to delete `u1`/`u2` from existing DBs).

---

### C5 — Stored XSS: member fields injected into `innerHTML` unescaped
- **File:** `member_directory_kinetic_enterprise/code.html` (and the same pattern across other screens / `assets/js/onboarding.js`)
- **Function:** the member-grid render callback · **Lines:** **144–172** (sinks at **148** `src="${photo}"`, **152** `${m.full_name}`, **153** `${m.phone}`)
- **Root cause:** User-controlled member data interpolated into `innerHTML` with no encoding; no escaping/DOMPurify helper exists in `assets/js`.
- **Current code (148–153):**
  ```js
  card.innerHTML = `
    ...
    <img ... src="${photo}" onerror="..."/>
    <span ...>${initials}</span>
    ...
    <h3 ...>${m.full_name}</h3>
    <p ...>${m.phone}</p>
  `;
  ```
- **Fixed code (escape on output; validate `photo` is a safe URL):**
  ```js
  // assets/js/utils.js (add once, reuse everywhere)
  function esc(s){ return String(s ?? '').replace(/[&<>"']/g, c =>
    ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function safeUrl(u){ try { const x=new URL(u, location.origin);
    return ['http:','https:'].includes(x.protocol) ? x.href : ''; } catch { return ''; } }

  // render
  card.innerHTML = `
    ...
    <img ... src="${esc(safeUrl(photo))}" onerror="..."/>
    <span ...>${esc(initials)}</span>
    ...
    <h3 ...>${esc(m.full_name)}</h3>
    <p ...>${esc(m.phone)}</p>
  `;
  ```
  Sweep every screen that does ``innerHTML = `...${data}...` `` with the same `esc()`/`safeUrl()`. Also sanitize on **input** in `POST /members` (`routes/api.js`) as defense-in-depth.
- **Effort:** Complexity `L` (pervasive across ~30 HTML files) · Risk `Med` (must not break legitimate markup). ~8–16h.

---

### C6 — No billing lifecycle: plan state is client-writable; no Razorpay webhook
- **Files:** `routes/api.js` (`/subscription/change` 263–276, `/subscription/submit-upi-payment` 376–437), `lib/razorpay.js` (`createSubscription` 104–121 ignores customer/never persists), `server.js` (no webhook route)
- **Root cause:** Tenant plan can be set directly by the client; there is no server-authoritative billing source (no webhook to confirm capture/renewal/failure/cancellation).
- **Current code (`/subscription/change`, 263–271):**
  ```js
  router.post('/subscription/change', async (req, res) => {
    const { plan } = req.body;
    if (!['trial','basic','pro','enterprise'].includes(plan)) { ... }
    await runQuery("UPDATE tenants SET subscription_plan = ?, subscription_status = ? WHERE id = ? AND tenant_id = ? "[plan, ...]);
  ```
- **Fixed architecture (sketch — do NOT trust the client for paid state):**
  ```js
  // server.js — mount BEFORE auth; raw body for signature check
  app.post('/webhooks/razorpay',
    express.raw({ type: 'application/json' }),
    (req, res) => {
      const sig = req.headers['x-razorpay-signature'];
      const expected = crypto.createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
                             .update(req.body).digest('hex');
      if (sig !== expected) return res.status(400).end();
      const evt = JSON.parse(req.body);
      // idempotent via billing_events.razorpay_event_id (already in schema)
      // on subscription.charged/activated -> set tenants.subscription_plan/status + next_billing_date
      // on subscription.halted/cancelled  -> downgrade/expire
      res.json({ ok: true });
    });

  // /subscription/change becomes request-only: it may START a checkout,
  // but NEVER sets a paid plan directly. Paid state changes ONLY in the webhook.
  ```
- **Effort:** Complexity `L` · Risk `High` (money path). ~24–40h incl. sandbox testing of upgrade/downgrade/renew/cancel/dunning.

---

## HIGH

---

### H1 — Attendance check-in saved with `tenant_id = NULL`
- **File:** `routes/api.js` · **Function:** `POST /attendance/check-in` (1237) · **Lines:** **1257–1260**
- **Root cause:** INSERT omits `tenant_id`; rows become invisible to tenant-scoped attendance/summary/logs (verified — new row had `tenant_id=NULL`).
- **Current code (1257–1260):**
  ```js
  await runQuery(`
    INSERT INTO attendance (id, member_id, check_in, access_method)
    VALUES (?, ?, datetime('now', 'localtime'), 'Manual')
  `, [checkInId, member.id]);
  ```
- **Fixed code:**
  ```js
  await runQuery(`
    INSERT INTO attendance (id, tenant_id, member_id, check_in, access_method)
    VALUES (?, ?, ?, datetime('now', 'localtime'), 'Manual')
  `, [checkInId, req.tenant_id, member.id]);
  ```
  Companion: backfill `attendance` rows where `tenant_id IS NULL` from `members`; add `NOT NULL` + index. (Other unscoped INSERTs the refactor left in *committed* code — `payments`/`leads`/`memberships` — already carry `tenant_id` in the working tree; verify after C1.)
- **Effort:** Complexity `S` · Risk `Low`. ~2h incl. backfill.

---

### H2 — `/attendance/summary` "present" is always 0
- **File:** `routes/api.js` · **Function:** `GET /attendance/summary` (1196) · **Lines:** **1198, 1206**
- **Root cause:** `allQuery` returns an array; code reads `.count` off the array → `undefined`.
- **Current code (1198, 1206):**
  ```js
  const presentResult = await allQuery(`
    SELECT COUNT(DISTINCT member_id) as count
    FROM attendance
    WHERE (date(check_in) = '${getTodayString()}') AND tenant_id = ? `, [req.tenant_id]);
  ...
  const present = Math.min(presentResult.count || 0, total);
  ```
- **Fixed code:**
  ```js
  const presentResult = await getQuery(`
    SELECT COUNT(DISTINCT member_id) as count
    FROM attendance
    WHERE date(check_in) = ? AND tenant_id = ?`, [getTodayString(), req.tenant_id]);
  ...
  const present = Math.min(presentResult.count || 0, total);
  ```
  (Also bind the date instead of interpolating, for consistency.)
- **Effort:** Complexity `S` · Risk `Low`. ~0.5h.

---

### H3 — Verification/reset emails hard-code `http://localhost`
- **File:** `lib/emailService.js` · **Functions:** `sendVerificationEmail` (79), `sendPasswordReset` (89) · **Lines:** **80, 90**
- **Root cause:** No configured public base URL.
- **Current code (80 / 90):**
  ```js
  const link = `http://localhost:${port}/verify-email?token=${token}`;
  const link = `http://localhost:${port}/reset-password?token=${token}`;
  ```
- **Fixed code:**
  ```js
  const base = process.env.APP_BASE_URL || `http://localhost:${port}`;
  const link = `${base}/verify-email?token=${token}`;
  const link = `${base}/reset-password?token=${token}`;
  ```
  Add `APP_BASE_URL` to `.env`/`.env.example`; thread it through instead of `port`.
- **Effort:** Complexity `S` · Risk `Low`. ~1h.

---

### H4 — Mandatory verification + unreliable email = onboarding dead end
- **File:** `server.js` · **Function:** `/api/v1/auth/signup` (192) and login gate (165) · **Lines:** **223–229** (signup 502), **165–167** (login requires `email_verified`)
- **Root cause:** Verification required, delivery unreliable/unconfigured, no resend / operator override / surfaced link.
- **Current code (223–229):**
  ```js
  const emailResult = await emailService.sendVerificationEmail(email, vToken, tenantId, PORT);
  if (!emailResult.success) {
    return res.status(502).json({ error: 'Signup successful, but failed to send verification email. Please contact support.' });
  }
  ```
- **Fixed code (add resend endpoint + don't strand the user):**
  ```js
  // Keep the user; surface a resend path instead of a dead 502.
  if (!emailResult.success) {
    return res.status(201).json({
      message: 'Account created. We could not send the verification email — use Resend.',
      verificationPending: true
    });
  }
  // + new route: POST /api/v1/auth/resend-verification { email }
  // + operator action to force-verify; + optional grace login before verify with a soft gate.
  ```
- **Effort:** Complexity `M` · Risk `Med`. ~6–10h.

---

### H5 — No CSRF protection; cookie not `Secure`, no `SameSite`; wildcard CORS
- **File:** `server.js` · **Functions:** middleware setup (28) + login cookie (179) · **Lines:** **28** (`cors()`), **179–183** (`secure:false`, no `sameSite`)
- **Root cause:** Cookie-session auth with permissive flags and no CSRF defense.
- **Current code (28, 179–183):**
  ```js
  app.use(cors());
  ...
  res.cookie('auth_token', token, {
    httpOnly: true,
    secure: false, // Set to true if HTTPS is enabled
    maxAge: remember ? 30*24*60*60*1000 : 8*60*60*1000
  });
  ```
- **Fixed code:**
  ```js
  app.use(cors({ origin: process.env.ALLOWED_ORIGINS?.split(',') || false, credentials: true }));
  ...
  res.cookie('auth_token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: remember ? 30*24*60*60*1000 : 8*60*60*1000
  });
  ```
  Add CSRF tokens (or require a non-simple custom header, e.g. `X-Requested-With`, enforced server-side) on all state-changing routes.
- **Effort:** Complexity `M` · Risk `Med` (CSRF tokens touch every mutating call + front-end). ~6–10h.

---

### H6 — No rate limiting / brute-force protection
- **File:** `server.js` (login handler 144) — no limiter middleware anywhere.
- **Root cause:** No throttling on auth or sensitive endpoints.
- **Current code:** *(none — absence of middleware)*
  ```js
  app.post('/api/v1/auth/login', async (req, res) => { /* unlimited attempts */ });
  ```
- **Fixed code (example with express-rate-limit):**
  ```js
  const rateLimit = require('express-rate-limit');
  const authLimiter = rateLimit({ windowMs: 15*60*1000, max: 10, standardHeaders: true });
  app.post('/api/v1/auth/login', authLimiter, async (req, res) => { ... });
  app.post('/api/v1/auth/forgot-password', authLimiter, ...);
  app.post('/api/v1/auth/signup', authLimiter, ...);
  ```
  Add account-level lockout/backoff after N failures.
- **Effort:** Complexity `S–M` · Risk `Low`. ~3–5h.

---

### H7 — Cross-tenant payment tamper on verify endpoints
- **File:** `routes/api.js` · **Functions:** `/finance/collect/verify` (1400), `/memberships/renew/verify` (2314) · **Lines:** **1409, 1413, 1416** and **2323, 2327, 2330**
- **Root cause:** Payment lookups/updates keyed on `id` only, no `tenant_id`.
- **Current code (1409 / 1413):**
  ```js
  await runQuery(`UPDATE payments SET status = 'Failed' WHERE id = ?`, [payment_id]);
  ...
  const payment = await getQuery(`SELECT * FROM payments WHERE id = ? AND status = 'Pending'`, [payment_id]);
  ```
- **Fixed code:**
  ```js
  await runQuery(`UPDATE payments SET status = 'Failed' WHERE id = ? AND tenant_id = ?`, [payment_id, req.tenant_id]);
  ...
  const payment = await getQuery(`SELECT * FROM payments WHERE id = ? AND status = 'Pending' AND tenant_id = ?`, [payment_id, req.tenant_id]);
  ```
  Apply to all payment/invoice/membership updates in both verify handlers.
- **Effort:** Complexity `S` · Risk `Low`. ~2h.

---

### H8 — Stateless JWT: no revocation; logout cosmetic; 30-day tokens; permissions frozen in token
- **File:** `server.js` · **Functions:** `authenticateToken` (41), `/auth/login` (172–183), `/auth/logout` (292–295)
- **Root cause:** No server-side session/revocation; authz baked into a long-lived token.
- **Current code (292–295):**
  ```js
  app.post('/api/v1/auth/logout', (req, res) => {
    res.clearCookie('auth_token');
    res.json({ message: 'Session terminated successfully.' });
  });
  ```
- **Fixed code (direction — pick one):**
  ```js
  // Option A: server session store (token id -> valid). Logout/suspend/role-change revokes.
  // Option B: short access token (15m) + refresh token (rotating, revocable);
  //           re-read permissions from DB on each request instead of trusting the token claim.
  // Either way: maintain a revocation list keyed on jti; check it in authenticateToken.
  ```
- **Effort:** Complexity `L` · Risk `High` (auth core). ~10–16h.

---

## MEDIUM

---

### M1 — Member counts inconsistent across screens
- **File:** `routes/api.js` · **Functions:** `/subscription/status` (123, member count ~129), `/dashboard/summary` (2112, totalMembers 2116 = active-only), `/analytics/bi` (1584)
- **Root cause:** Each endpoint counts a different population (all vs active vs this-month); no shared metric source.
- **Current code (examples):**
  ```js
  // subscription/status ~129: ALL members
  "SELECT COUNT(*) as count FROM members WHERE tenant_id = ?"
  // dashboard/summary 2116: ACTIVE only
  "SELECT COUNT(*) as count FROM members WHERE status = 'Active' AND tenant_id = ?"
  ```
- **Fixed code (centralize + label):**
  ```js
  // lib/metrics.js
  async function memberCounts(tenantId){
    const total  = (await getQuery("SELECT COUNT(*) c FROM members WHERE tenant_id=?",[tenantId])).c;
    const active = (await getQuery("SELECT COUNT(*) c FROM members WHERE status='Active' AND tenant_id=?",[tenantId])).c;
    return { total, active };
  }
  // expose both as { totalMembers, activeMembers } everywhere; never relabel one as the other.
  ```
- **Effort:** Complexity `M` · Risk `Low`. ~4–6h.

---

### M2 — Renewal ignores `duration_days`; `renewal_count` hard-coded to 1
- **File:** `routes/api.js` · **Function:** `POST /memberships/renew` (2225) · **Lines:** **2247** (end-date math), **2268** (`renewal_count` literal `1`)
- **Root cause:** End date uses only `duration_months`; counter never derived from history.
- **Current code (2247 / 2268):**
  ```js
  endDateObj.setMonth(endDateObj.getMonth() + plan.duration_months);
  ...
  INSERT INTO memberships (... renewal_count) VALUES (?, ?, ?, ?, ?, ?, ?, 1)
  ```
- **Fixed code:**
  ```js
  endDateObj.setMonth(endDateObj.getMonth() + (plan.duration_months || 0));
  endDateObj.setDate(endDateObj.getDate() + (plan.duration_days || 0));
  ...
  const prior = await getQuery(
    "SELECT COUNT(*) c FROM memberships WHERE member_id=? AND tenant_id=?",
    [member_id, req.tenant_id]);
  // bind (prior.c) as renewal_count instead of the literal 1
  ```
- **Effort:** Complexity `S–M` · Risk `Med` (date math + money). ~2–3h.

---

### M3 — No password policy
- **File:** `server.js` · **Function:** `/api/v1/auth/signup` (192) · **Lines:** **193–194**
- **Current code:**
  ```js
  const { full_name, email, password } = req.body;
  if (!full_name || !email || !password) return res.status(400).json({ error: 'All fields are required.' });
  ```
- **Fixed code:**
  ```js
  if (!full_name || !email || !password) return res.status(400).json({ error: 'All fields are required.' });
  if (String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  // optional: reject top-N breached/common passwords; require mixed character classes.
  ```
- **Effort:** Complexity `S` · Risk `Low`. ~1–2h.

---

### M4 — Invoice numbers / record IDs collide
- **File:** `routes/api.js` · **Function:** `POST /memberships/renew` (2225) · **Lines:** **2255–2258**
- **Root cause:** `RCPT-<year>-<3-digit random>` (900 values/yr); IDs are bare `Date.now()`.
- **Current code (2255–2258):**
  ```js
  const msId = 'ms' + Date.now();
  const invoiceId = 'inv' + Date.now();
  const paymentId = 'pay' + Date.now();
  const invoiceNum = 'RCPT-' + new Date().getFullYear() + '-' + Math.floor(100 + Math.random()*900);
  ```
- **Fixed code:**
  ```js
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const msId='ms_'+uid(), invoiceId='inv_'+uid(), paymentId='pay_'+uid();
  // invoiceNum from a per-tenant monotonic counter (e.g. an invoice_seq table / row), not random.
  ```
- **Effort:** Complexity `M` · Risk `Med` (sequence needs to be atomic). ~3–5h.

---

### M5 — File upload accepts any type/size; served same-origin
- **File:** `routes/api.js` · **Function:** multer config + `/settings/upload-logo` (3586–3607) · **Lines:** **3586–3600**
- **Current code (3600):**
  ```js
  const upload = multer({ storage: storage });
  ```
- **Fixed code:**
  ```js
  const upload = multer({
    storage,
    limits: { fileSize: 2 * 1024 * 1024 },          // 2 MB
    fileFilter: (req, file, cb) => {
      const ok = ['image/png','image/jpeg','image/webp'].includes(file.mimetype);
      cb(ok ? null : new Error('Only PNG/JPEG/WebP allowed'), ok);
    }
  });
  // filename(): force a safe extension from mimetype; ignore originalname extension.
  ```
- **Effort:** Complexity `S` · Risk `Low`. ~2–3h.

---

### M6 — `runAutomationScans()` runs synchronously on every dashboard load
- **File:** `routes/api.js` · **Function:** `GET /dashboard/summary` (2112) calling `runAutomationScans` (def ~490) · **Line:** **2114**
- **Current code (2114):**
  ```js
  await runAutomationScans();
  ```
- **Fixed code:**
  ```js
  // Remove from the request path. Run on an interval / cron instead:
  //   setInterval(() => runAutomationScansForAllTenants().catch(log), 15*60*1000);
  // Make each alert/task creation idempotent via a UNIQUE constraint, not a SELECT-then-INSERT race.
  ```
- **Effort:** Complexity `M` · Risk `Med` (changes automation timing). ~6–10h.

---

### M7 — Backups written into the web root; `backup_*.json` not git-ignored
- **File:** `routes/api.js` · **Function:** `POST /backup/create` (3518) · **Line:** **3529** (`writeFileSync` to project root). `.gitignore` ignores `backup_*.db` but not `*.json`.
- **Current code (3527–3529):**
  ```js
  const backupName = `backup_${req.tenant_id}_${Date.now()}.json`;
  const backupPath = path.join(__dirname, '..', backupName);
  fsModule.writeFileSync(backupPath, JSON.stringify(backupData, null, 2));
  ```
- **Fixed code:**
  ```js
  const backupDir = process.env.BACKUP_DIR || path.join(__dirname, '..', 'data', 'backups'); // OUTSIDE web root
  fsModule.mkdirSync(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, `backup_${req.tenant_id}_${Date.now()}.json`);
  fsModule.writeFileSync(backupPath, JSON.stringify(backupData, null, 2));
  ```
  Add `data/` + `backup_*` to `.gitignore`. (Depends on C3.)
- **Effort:** Complexity `S` · Risk `Low`. ~2h.

---

### M8 — Plan/trial gating not enforced on page access
- **File:** `server.js` · **Function:** page route loop (120–137); `checkSubscription` (routes/api.js 63) gates only some API path prefixes
- **Current code (122–133):**
  ```js
  pages.forEach(p => {
    app.get(p.route, (req, res) => {
      if (!publicRoutes.includes(p.route)) {
        const token = req.cookies.auth_token;
        if (!token) return res.redirect('/login');
        try { jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] }); }
        catch { res.clearCookie('auth_token'); return res.redirect('/login'); }
      }
      res.sendFile(path.join(__dirname, p.dir, 'code.html'));
    });
  });
  ```
- **Fixed code (direction):**
  ```js
  // Gate premium screens + expired trials server-side (check tenant plan/status),
  // not just by hiding UI. Enforce the same feature matrix used by checkSubscription.
  ```
- **Effort:** Complexity `M` · Risk `Med`. ~4–6h.

---

### M9 — Payment secrets stored plaintext in `settings`
- **File:** `database.js` · **Function:** `initializeDatabase` settings seed · **Lines:** **778–779** (`razorpay_key_id`, `razorpay_secret`)
- **Current code (778–779):**
  ```js
  ('razorpay_key_id', ''),
  ('razorpay_secret', ''),
  ```
- **Fixed code:** keep secrets in env/secret-manager, not the tenant DB.
  ```js
  // Remove razorpay_secret from settings. Read keys from process.env (per-deploy),
  // or, if multi-tenant keys are required, encrypt at rest with a KMS-managed key.
  ```
- **Effort:** Complexity `M` · Risk `Med` (touches payment config flow). ~2–3h.

---

## LOW

| ID | File / Location | Issue | Root cause | Fix | Effort |
|----|-----------------|-------|-----------|-----|--------|
| **L1** | repo root: `fix_*.js`, `rewrite_*.js`, `refactor_*.js`, `scratch_*.js`, `test_*.js`; `routes/api_tenant.js`, `api_fully_isolated.js`, `api_updated.js`, `api_injected.js` | ~40 one-off scripts + 4 unmounted duplicate routers | copy-paste refactor workflow | delete; keep real migrations in `migrations/` | `S` · Low · ~2h |
| **L2** | `package.json` name; `database.js` seeds; auto gym name `server.js:209` | Branding mismatch ("Kinetic"/"JSB"/"Gym Flow"); gyms auto-named `"<First>'s Gym"` | leftover demo naming | finalize white-label; prompt for gym name at onboarding | `S` · Low · ~2h |
| **L3** | `database.js:41–676` | Schema via repeated `ALTER TABLE … catch(e){}`, no versioning | no migration runner | adopt a versioned migration tool | `M` · Med · ~4–6h |
| **L4** | `server.js` (no error handler); body-parser errors return stack traces | Stack traces leak to clients | Express default error page | add central error middleware; generic messages; structured logs | `S` · Low · ~2h |
| **L5** | `tenants` row `t1` (DB) | Seed tenant has `subscription_plan = NULL` but treated as active/enterprise | inconsistent seed | seed explicit plan/status | `S` · Low · ~1h |
| **L6** | DB: `members`/`attendance` rows with `tenant_id=NULL` | Orphaned data (from H1) | missing scoping historically | one-time cleanup + NOT NULL constraints | `S` · Low · ~2h |
| **L7** | `routes/api.js` ids; `server.js:208` tenant id | `Date.now()`-based PKs → bulk-import collision risk | weak id generation | shared `uid()` helper (see M4) | `S` · Low · ~1h |
| **L8** | whole repo | No automated tests | none written | add API + isolation integration suite (also enables Phase 1–5 verification) | `L` · Med · ~8–16h |

---

# PART B — REPAIR ROADMAP (5 PHASES)

> Phases are ordered by dependency. **Do not start a phase until the prior phase boots and its tests pass.** Several findings span phases — each is listed under its *primary* phase with cross-references.

---

## PHASE 1 — Make the application stable and bootable
**Goal:** server starts, every authenticated route returns a response (no segfault), a boot smoke-test passes.

| Finding | Action | Complexity | Risk |
|---|---|---|---|
| **C1** | Fix all 49 `query("sql"[params])` sites; drop bogus `tenant_id` on `tenants` queries; fix comm-history `OR` precedence | M | Med |
| L4 (partial) | Add central error handler so a bad query returns 500, never crashes the process | S | Low |
| L8 (start) | Stand up a minimal test harness: login + GET every route, assert no 5xx/crash | M | Med |

- **Exit criteria:** `node server.js` boots; automated smoke-test hits all ~80 routes for a logged-in tenant with zero crashes.
- **Phase hours:** **~12–18h** · **Complexity:** Medium · **Risk:** Medium (a single missed C1 site reintroduces the crash — the smoke-test is the safety net).

---

## PHASE 2 — Tenant isolation
**Goal:** no tenant can read or write another tenant's data, proven by an automated two-tenant test.

| Finding | Action | Complexity | Risk |
|---|---|---|---|
| **C2(a)** | Scope the *missed* endpoints: `/activity-logs` (3407), `/export/:type` activity (3482), `/finance/pending` (1335–1337), `/reports/closing/lock` | M | High |
| **C2(b)** | Verify every refactor-scoped analytics endpoint actually isolates (post-C1); fix any that don't | L | High |
| **H1** | Add `tenant_id` to attendance INSERT (1257–1260) + backfill | S | Low |
| **H7** | Scope payment lookups/updates in both verify handlers (1409/1413/1416, 2323/2327/2330) | S | Low |
| L6 | Clean up existing `tenant_id=NULL` rows; add NOT NULL constraints | S | Low |

- **Exit criteria:** two-tenant isolation suite (provision A + B, distinct data) passes on **every** endpoint; no two tenants receive identical aggregates.
- **Phase hours:** **~26–36h** · **Complexity:** Large · **Risk:** High (core data-access; the test suite is mandatory, not optional).

---

## PHASE 3 — Security vulnerabilities
**Goal:** close the data-exposure, auth, and injection holes.

| Finding | Action | Complexity | Risk |
|---|---|---|---|
| **C3** | Serve only `public/`; move `database.db` + backups out of web root; assert `/database.db`→404 | M | Med |
| **C4** | Remove backdoor seed accounts; migration to delete `u1`/`u2` | S | Low |
| **C5** | Output-escape all `innerHTML` data sweep (member dir + all screens); input-sanitize members | L | Med |
| **H5** | Cookie `secure`+`sameSite`; CSRF tokens on mutations; scope CORS | M | Med |
| **H6** | Rate-limit auth endpoints + lockout | S–M | Low |
| **H8** | JWT revocation / short tokens + refresh; re-read permissions server-side | L | High |
| **M3** | Password length/complexity | S | Low |
| **M5** | Upload type/size/extension hardening | S | Low |
| **M7** | Backups out of web root + gitignore | S | Low |
| **M9** | Payment secrets to env/secret-manager | M | Med |
| L4 | Finish central error handler / no stack traces | S | Low |

- **Exit criteria:** unauthenticated `/database.db` and source → 404; XSS payload in member name renders inert; brute-force throttled; logout/suspend revokes tokens; security regression tests green.
- **Phase hours:** **~40–58h** · **Complexity:** Large · **Risk:** High (H8 + CSRF touch the auth core).

---

## PHASE 4 — Billing & subscription architecture
**Goal:** plan state is server-authoritative; upgrades/renewals/cancellations are reliable.

| Finding | Action | Complexity | Risk |
|---|---|---|---|
| **C6** | Signature-verified `/webhooks/razorpay` (mounted pre-auth); plan state changes ONLY via webhook; idempotent via `billing_events` | L | High |
| C6 | `/subscription/change` + UPI path become request/checkout-only, never grant paid state | M | High |
| **M4** | Per-tenant monotonic invoice numbers; collision-safe IDs | M | Med |
| **M8** | Enforce plan/trial gating server-side on pages + premium reads | M | Med |
| L5 | Seed explicit tenant plan/status defaults | S | Low |

- **Exit criteria:** sandbox Razorpay upgrade/downgrade/renew/cancel/dunning all reconcile correctly; client cannot self-grant a paid plan; no duplicate invoice numbers under concurrency.
- **Phase hours:** **~34–52h** · **Complexity:** Large · **Risk:** High (money path; needs sandbox + idempotency tests).

---

## PHASE 5 — Analytics & reporting accuracy
**Goal:** every number a gym owner sees is correct and tenant-scoped.

| Finding | Action | Complexity | Risk |
|---|---|---|---|
| **H2** | Fix `/attendance/summary` present count (`getQuery`) | S | Low |
| **M1** | Single source of truth for member metrics; label active vs total | M | Low |
| **M2** | Renewal honors `duration_days`; real `renewal_count` | S–M | Med |
| **M6** | Move `runAutomationScans` off the request path; idempotent alerts | M | Med |
| C2(b) follow-up | Re-validate every dashboard/analytics figure against hand-computed expected values per tenant | M | Med |

- **Exit criteria:** dashboard/BI/finance figures match hand-computed values for two seeded tenants; renewal dates correct for month- and day-based plans; no duplicate automation alerts.
- **Phase hours:** **~16–26h** · **Complexity:** Medium · **Risk:** Medium.

---

# PART C — TOTALS & SEQUENCING

| Phase | Theme | Hours (range) | Complexity | Risk |
|------:|-------|:-------------:|:----------:|:----:|
| 1 | Stable & bootable | 12–18 | Medium | Medium |
| 2 | Tenant isolation | 26–36 | Large | High |
| 3 | Security | 40–58 | Large | High |
| 4 | Billing | 34–52 | Large | High |
| 5 | Analytics accuracy | 16–26 | Medium | Medium |
| — | Cross-cutting cleanup (L1, L2, L3, L7, L8 test suite) | 16–28 | Medium | Med |
| **Total** | | **≈ 144–218 h** | | |

**Calendar estimate:** ≈ **4–6 weeks** for one focused senior engineer; ≈ **2.5–3.5 weeks** for two (Phase 3 and Phase 4 can partly parallelize *after* Phases 1–2 land, since billing and front-end XSS are largely independent).

**Hard sequencing rules:**
1. **Phase 1 is an absolute gate** — nothing is testable until the app boots.
2. **Phase 2 before Phase 4/5** — billing and analytics both assume correct tenant scoping.
3. **The Phase 2 isolation test suite is a prerequisite deliverable, not optional** — it's the only thing that proves C2 is actually closed and prevents regression.
4. **Do not re-run blanket regex refactors** (`inject_tenant.js` et al.) — they caused C1. Any future cross-file change goes through an AST transform + the test suite.

**Minimum bar to even demo safely:** Phases 1 + 2 + C3 + C4 (boot + isolation + stop serving the DB + remove backdoors). Everything else is required before charging real customers.

---

*No fixes have been applied. This document is planning only. Line numbers are valid as of the current working tree on 2026-06-16; they will shift as edits land — re-anchor against the function names when implementing.*
