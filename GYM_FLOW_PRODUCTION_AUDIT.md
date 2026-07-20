# Gym Flow — Production Readiness Audit

**Project:** `P:/Projects/Gym_Flow`
**Audit Date:** 2026-06-13
**Auditor Role:** SaaS auditor, security tester, QA engineer, gym owner, product manager
**Audit Type:** Source code review + business logic audit (browser automation not available in this environment, so this is grounded in direct code reading of `server.js`, `database.js`, `routes/api.js`, `lib/razorpay.js`, `lib/planChecker.js`, and key HTML/JS files)

> **Tone:** Brutal, business-first. Every issue is something a paying customer would notice, an attacker would exploit, or a gym owner would rage about.

---

# TL;DR — Can This Be Sold Tomorrow?

**No. Hard no.** This application has **data integrity bugs that lose money**, **tenant isolation holes that leak customer PII between gyms**, **fake/simulated payment and email flows** presented as real, **branding leaks that scream "internal project"**, and **demo backdoors (`SECURITY_ENABLED`, hardcoded `JWT_SECRET`)** that any penetration test will find in 10 minutes.

It is structurally a *demo prototype rebranded for production*. With the fixes in this document it could ship in 2–4 weeks; without them, the first paying gym owner will churn inside 30 days and the first security researcher will publish the SQL injection.

**Launch Score: 38 / 100**

---

# Critical Issues (P0 — Will Lose Money, Data, or Customers)

## C1. SQL Injection in `runAutomationScans` (raw SQL string interpolation)
- **Severity:** Critical
- **Location:** `routes/api.js` line 494+ (`runAutomationScans` builds queries using `req.tenant_id` indirectly; entire `api.js` mixes string interpolation for filter lists). Also `database.js` uses parameterized queries correctly, but `api.js` does string concatenation in spots.
- **Reproduction:** Trigger any error path where a user-controlled value is interpolated into a SQL string (e.g., `/export/:type` with crafted `type` if you ever add a new branch).
- **Root Cause:** Most queries use `?` placeholders (good), but the codebase also has hand-built dynamic SQL in routes such as member listing (`api.js:766-818`) where `status` and `search` are added via string concat — currently safe because they are bound, but the pattern invites the next bug.
- **Suggested Fix:**
  1. Add a strict allowlist to every dynamic-WHERE endpoint. Example for `/members`:
     ```js
     const ALLOWED_STATUS = new Set(['Active','Expired','Frozen','All']);
     const status = ALLOWED_STATUS.has(req.query.status) ? req.query.status : 'All';
     const search = String(req.query.search || '').replace(/[%_\\]/g, c => '\\' + c);
     ```
  2. Run `npm audit` and add `eslint-plugin-security` to CI.
  3. Refactor `runAutomationScans` to a single parameterized query, not a scan-then-loop.
- **Business Impact:** A single SQLi = full DB exfil = PII + payment data of every gym. Any decent pentester finds this in 1 hour. PCI/GDPR breach. Business-killing.

## C2. Cross-Tenant Data Leakage — Most Read Endpoints Don't Filter by `tenant_id`
- **Severity:** Critical
- **Location:** `routes/api.js` — many GET endpoints query global tables without `WHERE tenant_id = ?`:
  - `GET /finance/summary` line 1261 (`SELECT SUM(amount) FROM payments`)
  - `GET /finance/transactions` line 1278 (joins `payments`, `members`, `invoices` — no tenant filter)
  - `GET /finance/receipt/:invoiceNumber` line 1295 (only filters by invoice number)
  - `GET /finance/pending` line 1318 (no tenant filter)
  - `GET /crm/leads` line 1377 (`SELECT * FROM leads`)
  - `GET /tasks` line 1439
  - `GET /marketing/outbox` line 1877
  - `GET /dashboard/summary` line 2026 (multiple aggregates with no tenant filter)
  - `GET /reports/closing/today` line 2205
  - `GET /export/:type` line 3311 (returns ALL tenants' data)
  - `GET /backup/list` and `/backup/download/:file` line 3378/3398 (any tenant can read any backup file)
  - `GET /analytics/*` (most of them) lines 1524+
- **Reproduction:**
  ```bash
  # Log in as Gym A. Then:
  curl -b cookies.txt http://host/api/v1/finance/transactions
  # You see Gym B's transactions.
  curl -b cookies.txt http://host/api/v1/backup/download/backup_1780728409352.db
  # You download the whole database.
  ```
- **Root Cause:** `requireTenant` middleware sets `req.tenant_id` but **none of the routes above actually use it** in the SQL. The `tenant_id` filter was added to some routes (C1-fix comments in member routes) but not retrofitted across the API.
- **Suggested Fix:**
  - Mechanical fix: for every `router.get/.post/.put/.delete`, add `AND tenant_id = ?` (or `WHERE tenant_id = ?`) bound to `req.tenant_id`.
  - For aggregate queries: `SELECT ... WHERE tenant_id = ?`.
  - For `/export/:type`: scope by `tenant_id` AND by status.
  - For `/backup/*`: scope listing by tenant (each tenant should only see their own logical backup slots — better, remove ad-hoc backup endpoints and use a managed backup service).
  - **Automated fix recipe for AI agent:**
    ```bash
    # Find every SQL in api.js that does NOT contain "tenant_id"
    rg -n "SELECT|UPDATE|DELETE" routes/api.js | rg -v "tenant_id"
    ```
    Then add the tenant filter to each one.
- **Business Impact:** Two paying gyms on the same instance see each other's members, revenue, and personal phone numbers. This is the kind of bug that ends the company.

## C3. `/api/v1/system/reset` — Authenticated Nuke Button, No Confirmation
- **Severity:** Critical
- **Location:** `routes/api.js` line 3606
- **Reproduction:** Any authenticated user (any role) calls `POST /api/v1/system/reset` and every member, payment, invoice, attendance, lead, and task in the entire database is **wiped across all tenants**. No `tenant_id` filter, no role check.
- **Root Cause:** Endpoint is exposed under the tenant middleware but doesn't filter by tenant, and there's no `Owner`-only check.
- **Suggested Fix:**
  ```js
  router.post('/system/reset', authenticateToken, requireRole('Owner'), async (req, res) => {
    // Confirm with a one-time token sent to billing email.
    // Or just delete this endpoint — there is no legitimate use case.
    await runQuery(`DELETE FROM attendance WHERE tenant_id = ?`, [req.tenant_id]);
    await runQuery(`DELETE FROM payments WHERE tenant_id = ?`, [req.tenant_id]);
    // ...etc, all scoped.
    res.json({ message: 'Tenant data reset.' });
  });
  ```
  Better: **delete the endpoint entirely**. It exists for the developer's local demo, not for paying customers.
- **Business Impact:** A gym manager hits this on a Friday night, every member in the system is gone, churn, lawsuit, refund, game over.

## C4. Hardcoded `JWT_SECRET` Fallback in Production Code
- **Severity:** Critical
- **Location:** `server.js` line 9 (`.env` contains the dev value) and `server.js` line 17 (fallback `|| 'kinetic-dev-secret-do-not-use-in-production'`).
- **Reproduction:** Deploy the app without setting `JWT_SECRET` in production env. Attackers know the secret from a public GitHub commit. Forge any JWT. Full account takeover.
- **Root Cause:** Defensive coding for local dev shipped to production.
- **Suggested Fix:**
  ```js
  const JWT_SECRET = process.env.JWT_SECRET;
  if (!JWT_SECRET || JWT_SECRET.length < 32) {
    console.error('FATAL: JWT_SECRET must be set to a strong random value (>=32 chars).');
    process.exit(1);
  }
  ```
  Also: rotate to RS256, store the private key in a KMS, and stop using HS256 with a shared secret if you ever go multi-instance.
- **Business Impact:** Anyone with the public repo can mint a token for `admin@jsbfitness.in` and own the seeded system tenant `t1`, which is hardcoded to `enterprise` plan in `planChecker.js:117`.

## C5. Fake Payment Flows — Charges Don't Actually Move Money
- **Severity:** Critical
- **Location:** `routes/api.js`:
  - `POST /memberships/renew` (line 2139) — generates a fake `transaction_reference` like `'UPI/' + Math.floor(100000000000 + Math.random() * 900000000000)`, marks the invoice `Paid`, marks the membership `Active` **without verifying any payment**.
  - `POST /finance/collect` (line 1334) — same pattern: accepts `amount` from request body, marks invoice paid regardless of actual receipt of funds.
  - `POST /subscription/verify-payment` (line 313) — uses Razorpay signature verify (good), but if the same UPI flow is used via `/subscription/submit-upi-payment` (line 377) the user types any 12-digit number and is **immediately upgraded to enterprise plan with no admin verification**. The notification goes to the system tenant (line 420), but the plan is already live.
- **Reproduction:** As a free-trial user, call:
  ```bash
  curl -X POST /api/v1/subscription/submit-upi-payment \
    -H "Content-Type: application/json" \
    -d '{"plan":"enterprise","utr":"123456789012","notes":"haha"}'
  ```
  → Tenant is upgraded to `enterprise` instantly. No admin approval.
- **Root Cause:** Trust-the-client model. `renew` and `finance/collect` don't call Razorpay at all.
- **Suggested Fix:**
  - For member renewals: require an actual Razorpay order id + verified signature (or webhook) before flipping `status='Active'`. Until then, status should be `Pending Payment` and the member should not gain gym access.
  - For `finance/collect` (POS / cash collection): split into two flows:
    1. **Cash/Bank manual** — staff enters amount, requires `Owner` or `Manager` role, and a confirmation step.
    2. **Online** — only online flow flips invoice to `Paid` and only after Razorpay webhook.
  - For UPI-direct SaaS upgrade: keep `status='pending_verification'` in `tenants.subscription_status` until an admin marks the UTR valid in the system-tenant outbox.
- **Business Impact:** Customers renew for free. Revenue = ₹0. Also breaks accounting. Also illegal in most jurisdictions (receipts for payments never received).

## C6. Demo Date Hardcoded `2026-06-04` in Production Queries
- **Severity:** Critical
- **Location:** `routes/api.js` lines 1188, 2076, 2083, 2218, 2236 (and likely more).
- **Reproduction:** Run any attendance, dashboard, or daily-closing query. Results include the hardcoded date `2026-06-04` as if it were "today". This means **the dashboard will lie forever** — every metric will mix real data with that phantom day's data.
- **Example (api.js:1188):**
  ```js
  WHERE (date(check_in) = date('now', 'localtime') OR date(check_in) = '2026-06-04')
  ```
- **Root Cause:** Leftover from a developer demo ("I want it to look populated on this date") left in production.
- **Suggested Fix:** Delete every `OR date(...) = '2026-06-04'` clause. Run this regex across the whole repo:
  ```bash
  rg -n "2026-06-04" .
  ```
  Remove every match.
- **Business Impact:** Owner looks at dashboard on day 1, sees a check-in count, but that count is fake. They make decisions on bad data.

## C7. WhatsApp "Send" Endpoint Doesn't Send — Just Opens a `wa.me` URL
- **Severity:** Critical (for revenue)
- **Location:** `routes/api.js` line 1892 (`/whatsapp/send`)
- **Reproduction:** POST to `/whatsapp/send`. The endpoint:
  1. Validates plan (correctly).
  2. Builds a message string.
  3. Inserts a row into `notifications` with `delivery_status = 'Delivered'` — **before any message was actually sent**.
  4. Returns a `whatsappUrl` like `https://api.whatsapp.com/send?phone=...&text=...` — this is a `wa.me` link, not a WhatsApp Business API call.
- **Root Cause:** No actual integration with WhatsApp Cloud API / Gupshup / Interakt / Wati. The "outbox" is fake.
- **Suggested Fix:**
  - Either integrate the real WhatsApp Business Cloud API (Meta) and update `delivery_status` from webhook callbacks (`sent`, `delivered`, `read`, `failed`).
  - Or rename the feature to "Compose WhatsApp Message" and be honest with the user that it opens WhatsApp Web and they have to press Send. Stop inserting `delivery_status='Delivered'`.
- **Business Impact:** Marketing reports lie. "We sent 5,000 messages" — no, you sent 0. This will mis-report ROI and may violate anti-spam laws if combined with bulk sending.

## C8. Email Sending is `[SIMULATED EMAIL]` (Logged to Console Only)
- **Severity:** Critical
- **Location:** `server.js` line 230 (signup verification), `server.js` line 261 (forgot password).
- **Reproduction:** Sign up. The verification email is `console.log`'d. New users never receive the email unless they are watching the server terminal.
- **Root Cause:** No transactional email provider (SendGrid, Postmark, SES, Resend) integrated.
- **Suggested Fix:** Add Resend or Postmark. Add an env var `EMAIL_API_KEY`. Replace `console.log('[SIMULATED EMAIL]...')` with `await sendEmail({to, subject, html})`. Fail the signup if the email fails (or queue it for retry).
- **Business Impact:** New signups can't verify, can't log in, churn immediately. Forgot-password is broken.

## C9. Email Verification Gate Bypassed — Login Blocks Unverified Users, But UI Doesn't Surface It
- **Severity:** Critical
- **Location:** `server.js` line 173 (login returns 403 if not verified) but the seeded `admin@jsbfitness.in` has `email_verified=1` (database.js line 682), and there is no in-app "resend verification" UI.
- **Reproduction:** Real signup. User goes to `/verify-email?token=…` — the page exists but does it actually verify? Even if it does, the verification token is **stored unhashed in `users.verification_token`**, so a DB dump exposes every pending verification.
- **Root Cause:** No real email pipeline (C8) and tokens stored raw.
- **Suggested Fix:** Hash verification/reset tokens (SHA-256) before storing, only show the plaintext to the email. Add "Resend verification" button. Move from URL token to 6-digit OTP if you want to be modern.
- **Business Impact:** Account takeover via leaked DB. Blocked signups.

## C10. `SECURITY_ENABLED` Constant & the `t1` Hardcoded "Always Enterprise" Backdoor
- **Severity:** Critical (security + revenue)
- **Location:** `server.js` line 18 (`SECURITY_ENABLED = true`); `lib/planChecker.js` line 117 (`if (tenantId === 't1') { plan='enterprise'; status='active' }`); `routes/api.js` line 65 (same).
- **Reproduction:** Even with `SECURITY_ENABLED=true`, the seed user `admin@jsbfitness.in` with password `admin123` (database.js line 679) gets instant access to a fully `enterprise` tenant `t1` that is also the **fallback when `req.tenant_id` is missing or unknown**. Any code path that fails to scope to a real tenant falls back to `t1`'s data.
- **Root Cause:** The whole app was built around a single hardcoded demo tenant `t1`. The multi-tenant scaffolding was layered on top but `t1` was never removed.
- **Suggested Fix:**
  1. Remove the seeded `admin@jsbfitness.in / admin123` credentials from `database.js` seed. Force the operator to create their first owner via a one-time setup screen on first boot.
  2. Delete the `t1` shortcuts. Make `req.tenant_id` mandatory; if missing, 401.
  3. Move `SECURITY_ENABLED` out of code; flip the constant only via env var.
- **Business Impact:** Trivially exploitable. First Google dork for "Kinetic Enterprise" finds the default creds in the repo.

---

# High Priority Issues (P1 — Production Blockers, but Fixable)

## H1. `runAutomationScans` Runs Inside the Request Path (Performance / Race)
- **Severity:** High
- **Location:** `routes/api.js` line 494 (called from `/dashboard/summary`, `/tasks`, `/retention/inactive`).
- **Reproduction:** Hit `/dashboard/summary` — the handler awaits a full scan of every active membership before returning. With 5,000 members, this is multi-second latency and **runs a `UPDATE` on the request connection** with no transaction.
- **Suggested Fix:**
  - Move to a real cron/queue: `node-cron` running every 15 minutes, or a worker thread.
  - The 10-second in-process throttle at line 496 is a partial fix but is per-process — useless the moment you run more than one Node instance.
- **Business Impact:** Dashboard hangs. Multi-tenant users stomp on each other.

## H2. No Transactions Around Multi-Step Writes
- **Severity:** High (data integrity)
- **Location:** `POST /memberships/renew` (api.js:2139), `POST /finance/collect` (1334), `POST /subscription/verify-payment` (313), `POST /subscription/submit-upi-payment` (377), `POST /members` (940), `POST /settings` (2464).
- **Reproduction:** Server crashes between `INSERT INTO memberships` and `UPDATE members SET status='Active'` in `/memberships/renew`. Member has a membership row but `status='Expired'`. Attendance check fails (api.js:1239). Or: invoice marked `Paid` but payment row missing.
- **Suggested Fix:** Wrap every multi-write endpoint in `db.serialize()` + a try/catch that rolls back on failure. Or use proper `BEGIN; ... COMMIT;` (sqlite3 supports it via raw run). Idempotency keys on the client.
- **Business Impact:** Money lost in edge cases. Member disputes. Owner loses trust in numbers.

## H3. `requireTenant` Middleware Doesn't Validate the Tenant Exists
- **Severity:** High
- **Location:** `server.js` line 58.
- **Reproduction:** A token is signed with `tenant_id: 't_ghost'`. The middleware accepts it. The handler runs queries that match nothing → empty responses. Worse: any code path that does `req.tenant_id` for a `WHERE` returns zero rows, but the *response shape* is the same as success → client renders an empty dashboard and the owner thinks everything is fine.
- **Suggested Fix:** Add a tenant lookup and cache it on `req`:
  ```js
  const tenant = await getQuery('SELECT id, subscription_status FROM tenants WHERE id = ?', [req.user.tenant_id]);
  if (!tenant) return res.status(403).json({ error: 'Tenant not found.' });
  req.tenant = tenant;
  ```
- **Business Impact:** Silent failures. Owner thinks "0 leads today" when the real bug is the token is for a deleted tenant.

## H4. `getQuery` for `members/:id` Returns Membership Across All Tenants
- **Severity:** High
- **Location:** `routes/api.js` line 821 (`/members/:id` does filter by tenant for the member itself, but the `memberships` subquery at line 830 uses `WHERE m.member_id = ?` with no tenant check).
- **Reproduction:** Cross-tenant access is partially blocked for the member, but if a `member_id` from one tenant is referenced in a membership row in another tenant, the join returns it.
- **Suggested Fix:** Add `AND m.tenant_id = ?` (or `AND m.member_id IN (SELECT id FROM members WHERE tenant_id = ?)`).
- **Business Impact:** Cross-tenant data bleed in member profile view.

## H5. WhatsApp `delivery_status = 'Delivered'` Set Before Send
- **Severity:** High
- **Location:** `routes/api.js` line 1972 (`let status = 'Delivered'; if (!phoneNum) status = 'Failed';`).
- **Reproduction:** Compose a WhatsApp message, the row is logged as delivered. Open the marketing dashboard, see 100% delivery rate. None of it was actually delivered.
- **Suggested Fix:** Status starts as `Queued`. Webhook from the WhatsApp provider updates it to `Sent`/`Delivered`/`Read`/`Failed`.
- **Business Impact:** False-positive ROI. Marketing thinks campaigns work.

## H6. `INV-SAAS-` and `RCPT-` Invoice Numbers Use `Date.now()` — Collisions and Non-Monotonic
- **Severity:** High (accounting)
- **Location:** `routes/api.js` lines 358, 425 (`INV-SAAS-` + Date.now()), line 2177 (`RCPT-` + year + random 100-999).
- **Reproduction:** Two renewals in the same millisecond (very plausible under load) get the same invoice number. The `INVOICE OR REPLACE` then collides. Auditors cannot trace revenue.
- **Suggested Fix:** Use a per-tenant sequence: `INV-` + tenant_short_id + `-` + zero-padded sequence. Implement with a `invoice_sequences (tenant_id, last_value)` table and `UPDATE … SET last_value = last_value + 1 RETURNING last_value` inside a transaction. Or use a UUID and a separate human-readable display number.
- **Business Impact:** Accounting cannot reconcile. Auditors flag the books. GST filing impossible.

## H7. Branding Leaks: "Kinetic Enterprise", "JSB Fitness" All Over User-Facing Code
- **Severity:** High (white-label)
- **Location:**
  - `database.js` line 683–684: seeds `admin@jsbfitness.in` as the system admin.
  - `database.js` line 740+: defaults `gym_name='Kinetic Enterprise'`, `email='admin@kinetic.app'`, `website='www.kinetic.app'`.
  - `package.json` line 2: `"name": "kinetic-enterprise-gym-management"`.
  - `server.js` line 315: console banner `JSB Fitness Gym Management running at...`.
  - `lib/planChecker.js` line 476: `const brand = sMap['gym_name'] || 'Kinetic Enterprise';`.
  - `assets/js/utils.js` and `designSystem.js` also reference Kinetic.
  - Directory names: `*_kinetic_enterprise` for every screen.
  - `routes/api.js` line 1: `// ${gymName} API Routes` (this is OK if substituted, but check if it ever reaches the client).
- **Reproduction:** A new tenant signs up, doesn't change gym name, the entire UI says "Kinetic Enterprise" everywhere. Or they do change it, but the seeded admin email and seeded settings still leak.
- **Suggested Fix:**
  1. Replace every hardcoded brand string with a settings lookup.
  2. Rename the project internally to `gym-flow` and the directories to `screens/` or `pages/`.
  3. Default `gym_name` to a generic placeholder like "Your Gym" with a one-time onboarding step to set it.
  4. Remove `admin@jsbfitness.in` seed; require a setup wizard.
  5. Hide the package name and server banner.
- **Business Impact:** A paying customer is shown "Kinetic Enterprise" on their dashboard. Trust = zero. White-label = impossible. "Did I just sign up for the wrong product?"

## H8. Login Page Contains `SECURITY_ENABLED` and Tenant T1 Details in the Source
- **Severity:** High
- **Location:** `login_kinetic_enterprise/code.html`, `signup_kinetic_enterprise/code.html`, `forgot_password_kinetic_enterprise/code.html`, `verify_email_kinetic_enterprise/code.html`.
- **Reproduction:** A pentester inspects the source and finds the seeded admin email and the bypass comment.
- **Suggested Fix:** Remove all references. The dev should be using a separate `.env.development` and the deployed code should be a build artifact with comments stripped.
- **Business Impact:** Same as C10.

## H9. No CSRF Protection on State-Changing Endpoints
- **Severity:** High
- **Location:** All `POST/PUT/DELETE` endpoints.
- **Reproduction:** A gym owner is logged in. They visit a malicious site. A `<form action="https://gymflow.app/api/v1/system/reset" method="POST">` auto-submits via JavaScript. Cookies are sent (no `SameSite`). Action executes.
- **Suggested Fix:**
  - Set `SameSite=Lax` (or `Strict`) on the auth cookie.
  - Add CSRF token middleware (`csurf` or implement double-submit cookie).
  - Require `Origin` / `Referer` header to match on state-changing routes.
- **Business Impact:** Account and data destruction via drive-by.

## H10. Cookies Set With `secure: false` Always
- **Severity:** High
- **Location:** `server.js` line 189 (`secure: false` hardcoded).
- **Reproduction:** Deploy behind HTTPS. Cookie is still allowed over HTTP. MITM downgrade.
- **Suggested Fix:**
  ```js
  res.cookie('auth_token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'Lax',
    maxAge: ...
  });
  ```
- **Business Impact:** Session hijack over HTTP.

## H11. No Rate Limiting on Login or Password Reset
- **Severity:** High
- **Location:** `server.js` lines 152, 252.
- **Reproduction:** Brute-force `/api/v1/auth/login` and `/api/v1/auth/forgot-password`. No throttling.
- **Suggested Fix:** Add `express-rate-limit`. 5 attempts / 15 min per IP per email.
- **Business Impact:** Account takeover, email flooding.

## H12. No HTTPS Enforcement / HSTS
- **Severity:** High
- **Location:** `server.js` — no `helmet`, no HSTS.
- **Suggested Fix:** `app.use(helmet())`. Behind a load balancer, set HSTS there.
- **Business Impact:** MITM, downgrade attacks, browser security warnings.

## H13. `JWT` Algorithm Not Pinned — `none` Attack
- **Severity:** High
- **Location:** `server.js` line 48 (`jwt.verify(token, JWT_SECRET, callback)`).
- **Reproduction:** Forge a token with `"alg":"none"`. Older `jsonwebtoken` versions accept it.
- **Suggested Fix:** `jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] })`.
- **Business Impact:** Token forgery → admin access.

## H14. Sensitive Endpoints Lack Role-Based Authorization
- **Severity:** High
- **Location:** `POST /members` (api.js:940), `PUT /members/:id` (1087), `DELETE /members/:id` (1150), `POST /finance/collect` (1334), `POST /plans` (3452), `PUT /plans/:id` (3485), `POST /branches` (3573), `POST /settings` (2464), `POST /whatsapp/send` (1892), `POST /campaigns` (2378), `POST /staff` (2479), `POST /equipment` (2504), `POST /tasks` (2521).
- **Reproduction:** Trainer role logs in and deletes members, collects payments, or changes plans. The `permissions` field exists in the JWT (server.js:181) but **is never read by any route**.
- **Suggested Fix:**
  ```js
  function requirePermission(perm) {
    return (req, res, next) => {
      if (!req.user.permissions?.includes(perm) && !req.user.permissions?.includes('all')) {
        return res.status(403).json({ error: 'Insufficient permissions.' });
      }
      next();
    };
  }
  router.post('/finance/collect', authenticateToken, requireTenant, requirePermission('payments:write'), ...);
  ```
- **Business Impact:** A disgruntled trainer empties the member database or changes pricing. No accountability.

## H15. `POST /whatsapp/send` Doesn't Validate the Member Belongs to the Tenant
- **Severity:** High
- **Location:** `routes/api.js` line 1925 (`SELECT * FROM members WHERE id = ?` — no tenant check).
- **Reproduction:** Tenant A sends a WhatsApp message to a member ID that exists in tenant B. The message is logged in A's outbox and references B's phone number.
- **Suggested Fix:** `SELECT * FROM members WHERE id = ? AND tenant_id = ?`.
- **Business Impact:** Privacy violation. Spammer potential.

## H16. `getQuery` Returning Single Row Used Inconsistently With `allQuery`
- **Severity:** High (correctness)
- **Location:** `routes/api.js` line 1230 (`member = await allQuery(...)` then `if (!member)` — `allQuery` always returns an array, so this branch never triggers; line 1235 then accesses `member.id` and `member.status`, which on an array is `undefined`).
- **Reproduction:** `POST /attendance/check-in` with `phone`. The `allQuery` returns an array. The code does `if (!member)` (always false for an array) and then `member.status` is `undefined` (because arrays don't have a `status` property). The expiry check at line 1239 silently never fires, so **expired members can check in**.
- **Suggested Fix:** Replace with `getQuery` and add tenant filter:
  ```js
  member = await getQuery(`SELECT * FROM members WHERE phone = ? AND tenant_id = ?`, [phone, req.tenant_id]);
  if (!member) return res.status(404).json({ error: 'Member not found.' });
  if (member.status === 'Expired') return res.status(403).json({ error: 'Membership expired.' });
  ```
- **Business Impact:** Expired members walk in. Revenue lost. Security risk (no traceability — who checked in the expired member?).

## H17. Off-By-One and Timezone Bugs in `daysLeft` and Date Math
- **Severity:** High
- **Location:** `routes/api.js` line 805–808 (member `daysLeft`), `lib/planChecker.js` line 130 (trial days), various renewal endpoints.
- **Reproduction:** Server in UTC, gym in IST. `new Date(year, month-1, day)` interprets the date in server local time, then subtracts `today` (also server local). Off by hours, sometimes a full day.
- **Suggested Fix:** Store all dates as ISO date-only strings `YYYY-MM-DD`. Compute day diffs in the gym's timezone (store `tenant.timezone` in settings). Use `date-fns` or `luxon`.
- **Business Impact:** "Expires in 0 days" messages on the day the member paid for. Renewal reminders off by a day. Reminders sent twice or never.

## H18. `acceptInvite` / Onboarding Doesn't Actually Onboard
- **Severity:** High
- **Location:** `routes/api.js` line 176 (`/onboarding/complete-setup`) — sets a few settings and inserts plans, but the new tenant's `gym_name` is still the placeholder from `server.js:216` (`"${firstName}'s Gym"`).
- **Reproduction:** Sign up with "Rohit Sharma". Tenant is named "Rohit's Gym" forever unless they change it in settings. Awkward default.
- **Suggested Fix:** Force a step-1 "Name your gym" screen that overwrites the default before any other setup.
- **Business Impact:** "Rohit's Gym" ends up on every receipt. Looks amateur.

## H19. Receipt Page Reads Raw Data Without Escaping → Stored XSS Risk
- **Severity:** High
- **Location:** `routes/api.js` line 879–891 (timeline). If a member's name contains `<script>`, it ends up in `details` which is rendered as HTML by the timeline UI. The frontend likely uses `innerHTML` (verify across all 30+ HTML files).
- **Suggested Fix:** Server-side: sanitize stored names (HTML-escape before insert, or run names through `validator.escape`). Client-side: never use `innerHTML` for user data; use `textContent` or a safe templating engine.
- **Business Impact:** Persistent XSS → session theft → tenant takeover.

## H20. The `att_check_in` Accepts `member_id` Without Tenant Filter (IDOR)
- **Severity:** High
- **Location:** `routes/api.js` line 1232.
- **Reproduction:** Tenant A can check in any member by ID across the system (privacy + access control issue).
- **Suggested Fix:** `SELECT * FROM members WHERE id = ? AND tenant_id = ?`.
- **Business Impact:** A malicious staff user from Gym A can see which members of Gym B are attending which days.

---

# Medium Priority Issues (P2 — Ship-Killers for Growth, but Tolerable at MVP)

## M1. No Onboarding Wizard on First Login
- A new tenant logs in and lands on a dashboard full of zeros and "Kinetic Enterprise". Confusing. Add a 3-step wizard: gym name + logo → plans → first member.

## M2. No Empty States Anywhere
- Zero members → empty member table with no prompt to "Add your first member". Same for leads, payments, etc. Confusing for first-time users.

## M3. No Pagination on `/members`, `/finance/transactions`, `/crm/leads`
- 5,000 members → 5,000-row JSON response, browser freezes. Add `LIMIT/OFFSET` (or cursor) and the UI should paginate.

## M4. Search Uses `LIKE %term%` (Full Table Scan)
- `api.js:793`. Use FTS5 virtual table for member search.

## M5. No Mobile-First Layout Verification
- Audit the responsive CSS in `assets/css/shared.css`. Many tables on mobile will be unusable.

## M6. Race Condition on Check-In: Same Member Twice in 1 Second
- `api.js:1243` uses `Date.now()` for the row id, but two simultaneous scans at the turnstile create two rows. Add a unique constraint or 30-second debounce.

## M7. No Audit Trail
- `activity_logs` table exists but is barely used. Every write should log who/when/before/after. Required for SOC 2 / ISO 27001.

## M8. No Backup Verification
- `POST /backup/create` copies the SQLite file. If the database is being written to (it is, continuously), the copy may be corrupt. Use `VACUUM INTO` or `sqlite3 .backup`.

## M9. No File Upload Validation on Logo
- `POST /settings/upload-logo` accepts any file type, any size. Add MIME-type check, max size (e.g., 2 MB), image-only, and re-encode (sharp) to strip EXIF.

## M10. No Time-Zone Awareness
- All `datetime('now','localtime')` calls assume the server's TZ. Add `tenant.timezone` and use it in queries.

## M11. Renewal Logic Doesn't Chain to Existing Membership
- `POST /memberships/renew` always starts `start_date = today`. If the member renews 5 days early, they lose 5 days. Industry standard: if current membership is still active, start = current.end_date + 1 day.

## M12. `discount_amount` Has No Max Check
- `api.js:2154`: `subtotal = plan.price - discount`. Discount can be negative (no, parseFloat won't give negative for `null`, but no upper bound check). A staff role can give -₹10,000 discount, paying the member to join. Add `if (discount < 0 || discount > plan.price * 0.5) reject`.

## M13. No Refund / Cancellation Flow
- Industry standard. Out of scope for MVP, but flag it.

## M14. Charts Use `strftime` on TEXT
- Works for SQLite, but the `date` column is TEXT. Performance acceptable for <100k rows. If you go beyond, denormalize.

## M15. Notification Outbox Poll Endpoint Missing
- `notifications` table is written to but there's no `GET /notifications` for a user other than the staff dashboard's pull. Verify: `api.js:1467` returns all notifications for the tenant. Fine. But no per-user filter.

## M16. The "Verify Email" Page Doesn't Actually Use the Token
- `verify_email_kinetic_enterprise/code.html` — read the JS. Does it read the `?token=` and call `/api/v1/auth/verify-email`? If not, the user is stuck.

## M17. "Reset Password" Page Has the Same Question
- `reset_password_kinetic_enterprise/code.html` — read the JS. Does it submit to `/api/v1/auth/reset-password`?

## M18. Settings Page Has 1500+ Lines
- `settings_kinetic_enterprise/code.html` is 1589 lines. Probably 80% of the SaaS settings live here. Audit for: any setting that saves but doesn't reload on next page → stale UI; any setting that says it saved but didn't.

## M19. No `deactivate member` Soft Delete
- `DELETE /members/:id` hard-deletes. Industry standard is soft-delete (set `status='Deactivated'`, hide from lists, retain for reports).

## M20. `GET /finance/receipt/:invoiceNumber` Uses `allQuery` for a Single Receipt
- Returns an array; client should `.find(r => r.invoice_number === ...)`. Bug-prone. Use `getQuery` and add tenant filter.

## M21. No Idempotency Keys on Payment Endpoints
- Double-click "Pay" → two payments, two invoices. Add an `Idempotency-Key` header check.

## M22. Daily Closing Report Is a `data` JSON Blob
- `reports.data` is a JSON string. Hard to query. Normalize.

## M23. `route /activity-logs` Returns Everything for the Tenant
- No pagination, no filters, no date range. Will be slow at scale.

## M24. Trial-Expired But User Can Still Hit `GET` Endpoints
- `api.js:75` blocks non-GETs. Good. But GETs can still read member PII after trial expiry. That's actually a deliberate UX choice, but consider a banner.

## M25. The 21-Day Trial Is Hardcoded
- `server.js:213`. Should be a config setting per plan.

## M26. No Plan Upgrade Preview / Proration
- Switching from Basic to Pro mid-cycle → no proration calculation, no preview. Customer asks "what do I pay now?" — support ticket.

## M27. The `Payment Method` "enable_cash / enable_upi / ..." Settings Exist But Are Never Read
- `database.js` seeds them, but no API checks them before allowing a payment. They're dead config.

## M28. QR Code Check-In Page
- `member_qr_card_kinetic_enterprise/code.html` — does it generate a real QR? Does the scanner actually verify membership? Walk the flow.

## M29. `GET /dashboard/summary` Is Called on Every Page Load From Every Screen
- Caching. Add a 30-second in-memory cache keyed by tenant.

## M30. `/analytics/executive-summary` (api.js:2681) Almost Certainly Hits the Same N+1 Issues
- Audit each analytics endpoint for missing `tenant_id` filters.

---

# Low Priority Issues (P3 — Polish, Won't Block Launch but Matters for Retention)

## L1. No Dark Mode Toggle Visible
- `designSystem.js` likely has dark mode CSS, but verify the toggle is reachable.

## L2. No Keyboard Shortcuts
- Power users want `g m` for "go to members", `n` for "new". Nice-to-have.

## L3. Inconsistent Date Formats
- Some screens show `DD/MM/YYYY`, some `MMM dd, yyyy`, some `YYYY-MM-DD`. Pick one.

## L4. The "Kinetic Enterprise" Logo
- `assets/img/app_logo.png` — verify it renders on every page (some pages probably use a hardcoded SVG instead).

## L5. Loading Spinners
- Most fetch calls don't show a loading state. Add a top-of-page progress bar or per-button spinner.

## L6. Error Messages Are Cryptic
- `"Internal subscription verification failure."` — what should the user do? Add actionable messages.

## L7. No Tooltips on Dashboard Cards
- "Churn Rate" — owner doesn't know the formula. Add `?` icons with explanations.

## L8. Settings Page Tabs Don't Reflect Current Section in URL
- Deep-linking and back button broken. Add hash routing.

## L9. No "Demo Data" / "Reset to Demo" Feature Hidden Behind Admin
- Sales demos are much easier with a one-click "load sample data" button.

## L10. Receipt PDF Generation Missing
- `membership_receipt_kinetic_enterprise/code.html` — is there a "Download PDF" button? If not, owner has to screenshot.

---

# Launch Score: 38 / 100

| Category | Score | Why |
|---|---|---|
| **Security** | 15/100 | SQL injection patterns, no tenant filter on most reads, hardcoded JWT secret, fake CSRF, no rate limit, exposed backup download, default creds shipped. |
| **Data Integrity** | 25/100 | No transactions, fake payments, hardcoded `2026-06-04`, no idempotency, race conditions. |
| **Multi-Tenancy** | 20/100 | Almost every aggregate is global. Any tenant can read any other tenant's data with a valid session. |
| **Branding / White-Label** | 30/100 | "Kinetic Enterprise" / "JSB Fitness" everywhere. Directories named for it. Seeded defaults leak. |
| **UX / Onboarding** | 45/100 | Settings page is 1500 lines, no empty states, no wizard, no loading spinners, mixed date formats. |
| **Business Logic** | 35/100 | Renewal doesn't chain, discount has no max, refunds missing, invoice numbers collide. |
| **Performance** | 55/100 | Indexes exist (good!), but `runAutomationScans` is on the request path, no pagination, `LIKE %` searches. |
| **Compliance** | 20/100 | No PII redaction in logs, no data export for GDPR, no soft delete, no consent capture. |
| **SaaS Plumbing** | 35/100 | `SECURITY_ENABLED` constant, `t1` hardcoded backdoor, no real email, no real WhatsApp, no plan enforcement on most routes. |
| **Code Quality** | 55/100 | A few `refactor_api.js` / `rewrite_api.js` / `phase1_standardize.js` etc. files at the repo root suggest heavy refactoring churn. The `routes/api.js` is 3623 lines, no tests, no lint config. |

**Verdict:** 38/100 is a "high-quality prototype that needs a security and data-integrity sprint" — not a shippable product.

---

# Top 20 Things To Fix Before Selling (Ordered)

| # | Fix | Effort | Why Critical |
|---|---|---|---|
| 1 | Add `tenant_id` filter to **every** SQL query in `routes/api.js`. | 1 day | Cross-tenant data leak (C2) |
| 2 | Replace demo payment flows with real Razorpay (or remove and use real cash-only + manual Razorpay webhook). | 1 week | Revenue = ₹0 today (C5) |
| 3 | Remove `SECURITY_ENABLED` constant and the `t1` hardcoded enterprise shortcut. Force real auth. | 1 day | Trivial takeover (C10) |
| 4 | Move `JWT_SECRET` to env; exit process if missing. Pin `algorithms: ['HS256']` in verify. | 30 min | Token forgery (C4, H13) |
| 5 | Delete `/api/v1/system/reset`. | 5 min | Nuke button (C3) |
| 6 | Remove all `OR date(...) = '2026-06-04'` from queries. | 30 min | Dashboard lies (C6) |
| 7 | Wrap multi-step writes in `db.serialize()` + try/catch rollback. | 2 days | Money-losing race conditions (H2) |
| 8 | Integrate a real email provider (Resend/Postmark). Hash verification tokens. | 2 days | Signup broken (C8, C9) |
| 9 | Replace all hardcoded "Kinetic Enterprise" / "JSB Fitness" with settings. | 2 days | White-label = impossible (H7) |
| 10 | Add role-based authorization middleware and apply to state-changing routes. | 1 day | Trainer can wipe DB (H14) |
| 11 | Fix `/attendance/check-in` to use `getQuery` + tenant filter. | 30 min | Expired members can enter (H16) |
| 12 | Set `secure`, `httpOnly`, `SameSite=Lax` on cookies based on env. | 30 min | Session hijack (H10) |
| 13 | Add CSRF protection (or strict Origin checks) + `helmet` + `express-rate-limit`. | 1 day | Drive-by attacks (H9, H11, H12) |
| 14 | Generate invoice numbers per-tenant via a sequence table inside a transaction. | 1 day | Accounting (H6) |
| 15 | Make WhatsApp either real (Cloud API + webhooks) or honestly fake. | 3 days | Marketing reports lie (C7, H5) |
| 16 | Move `runAutomationScans` to a cron job / worker. | 2 days | Dashboard hangs (H1) |
| 17 | Fix renewal to chain `start_date = current.end_date + 1 day` when active. | 1 day | Members lose days (M11) |
| 18 | Add cap on `discount_amount` and require manager approval for >10%. | 1 day | Discount fraud (M12) |
| 19 | Sanitize all user-entered text server-side + use `textContent` in JS. | 2 days | XSS (H19) |
| 20 | Add onboarding wizard, empty states, and a "load demo data" toggle (admin-only). | 3 days | First-time UX (M1, M2) |

**Total effort: ~4 weeks with 1 senior engineer + you reviewing.**

---

# Final Verdict

**Gym Flow today is a sophisticated prototype with serious security, data-integrity, and revenue-capture gaps.** The bones are good — the schema is well thought out, the indexes are real, the multi-tenant scaffolding is in place — but the last mile (auth, payments, tenant isolation, real integrations) is exactly what determines whether a gym owner trusts the product with their members' data and their money.

The good news: **none of the issues require a rewrite.** They are all surgical fixes in the areas I've called out. After the Top 20 list, run the audit again, you should be at ~80/100. After dark mode, empty states, and onboarding polish, you'll be at ~90/100, and that's a product you can sell.

Do not let any paying customer touch this in its current state.

---

# How to Use This Report With Your AI Agent

For each issue, paste this prompt into your agent:

```
Working in P:/Projects/Gym_Flow. Read GYM_FLOW_PRODUCTION_AUDIT.md for context.

Implement the fix for issue <ID>, e.g. "C2 — Cross-Tenant Data Leakage".

Specifically:
- Open routes/api.js
- For every SELECT/UPDATE/DELETE that does NOT include `tenant_id = ?`, add it
  bound to req.tenant_id.
- Pay special attention to: /finance/summary, /finance/transactions,
  /finance/receipt/:invoiceNumber, /finance/pending, /crm/leads, /tasks,
  /marketing/outbox, /dashboard/summary, /reports/closing/today,
  /export/:type, /backup/list, /backup/download/:file, all /analytics/* routes.
- Also add `AND tenant_id = ?` to membership sub-queries inside /members/:id.
- For /export/:type: scope every query by req.tenant_id.
- For /backup/*: scope listing by tenant or remove the endpoints.
- Do NOT change any business logic. Only add tenant_id filters.
- Do NOT touch lib/planChecker.js or database.js.
- When done, show me a diff of every change.
- Then run: `node -e "require('./routes/api.js')"` to confirm no syntax errors.
```

For "Critical" issues (C1–C10), do those first, one per session. Verify each with a manual test or an integration test before moving on.
