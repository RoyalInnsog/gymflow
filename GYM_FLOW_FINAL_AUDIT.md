# GYM FLOW — FINAL PRODUCTION AUDIT

**Audit date:** 2026-06-15
**Auditor roles assumed:** Senior SaaS Architect · QA Lead · Security Auditor · Product Manager · Gym Owner · Investor Due-Diligence Reviewer
**Method:** Source inspection + live server execution + authenticated API testing + cross-tenant testing + SQLite database validation + DOM/frontend inspection.
**Verdict (TL;DR):** **NOT SHIPPABLE.** Do not sell this to paying customers. See bottom section.

---

## 0. Executive Summary — Read This First

This product is in a **broken, pre-alpha state masquerading as a finished SaaS.** Two facts make that concrete, and both were verified by running the application, not by reading code:

1. **The current code on disk does not run.** The working tree of `routes/api.js` contains **~40 malformed database calls** of the form `query("SQL ... ?"[params])`. That JavaScript indexes a *string by an array*, evaluating to `query(undefined)`. One of those calls sits in `checkSubscription`, which runs on **every authenticated API request**. When the live server hit it, the **Node process crashed with a segmentation fault (exit 139)** — i.e., a single normal request takes the entire server down for **all** gyms. **The authenticated API is 100% non-functional in the current build.**

2. **The last build that *did* run leaks every gym's data to every other gym.** I started the previous (committed) version, logged in as two different gyms, and called the dashboard/finance/analytics endpoints. They returned **byte-identical data** — the same total revenue (₹141,680), the same member list, the same payment transactions, the same audit log. The entire reporting layer is computed with **no tenant filter**. Gym B sees Gym A's revenue, members' names and phone numbers, and payment history.

In other words: the developer noticed the tenant-isolation hole (#2) and ran an automated regex script (`inject_tenant.js`) to patch it — and that script corrupted the codebase into the non-running state (#1). **You currently get to choose between "leaks all customer data" and "does not start." Neither is sellable.**

On top of that, the **entire SQLite database is downloadable over HTTP with no authentication** (`GET /database.db` → 200, 393 KB, all gyms, all members, all bcrypt password hashes, all reset tokens), and the app ships with **hard-coded backdoor logins** (`admin@jsbfitness.in` / `admin123`).

This is not "a few bugs before launch." This is a foundational rebuild of the data-access and security layers.

---

## How issues are labeled

- **Severity:** Critical / High / Medium / Low
- **Location:** file and line (working tree unless noted). Where behavior was confirmed on the running server, it says **[VERIFIED LIVE]**.
- Every issue includes Reproduction, Root Cause, Suggested Fix, Business Impact.

---

# CRITICAL ISSUES

## C1 — The entire authenticated API is dead: `query("sql"[params])` calls `query(undefined)` and segfaults the server
- **Severity:** Critical — **[VERIFIED LIVE]**
- **Location:** `routes/api.js` — ~40 sites. Representative: line 68 (`checkSubscription`), 173, 202, 254, 270, 333, 339, 389, 396, 457, 464, 516, 517, 520, 1243, 1245, 1317, 1486, 1514, 1541, 1992, 2016, 2355, 2705, 3577, 3715, 3754. Pattern: `getQuery("… WHERE tenant_id = ? "[req.tenant_id, …])`.
- **Reproduction:**
  1. `node server.js`, log in (`POST /api/v1/auth/login`) — succeeds.
  2. `GET /api/v1/dashboard/summary` (or members, settings, anything authenticated).
  3. Observed: server process exits with **Segmentation fault (139)**; client gets connection-refused. Server is down for everyone until restarted.
  - Confirmed in isolation: `getQuery(undefined)` reproducibly crashes the Node process via the sqlite3 native binding.
- **Root Cause:** `inject_tenant.js` (an automated string-rewrite "tenant isolation" refactor, run 2026-06-13) appended ` AND tenant_id = ? ` and the params array **inside** the SQL string literal instead of as the function's second argument. `"…sql…"[a, b]` is a member-access on a string → `undefined`. The helper then calls `db.get(undefined, …)`.
- **Suggested Fix:** Revert `routes/api.js` to the last good commit and re-apply tenant scoping **by hand** (or with a proper AST transform), one query at a time, with tests. Add a lint/CI guard that rejects `query(... "[` / ` `[` patterns. Never run a regex rewrite across 3,700 lines of SQL again without a test suite.
- **Business Impact:** The product literally does not work. A gym owner who installs today cannot load a single screen's data; the server crashes on first use. Total loss of service.

## C2 — Cross-tenant data leakage: dashboard, finance, and analytics are computed globally across ALL gyms
- **Severity:** Critical — **[VERIFIED LIVE]** (on the last-running/committed build)
- **Location:** `routes/api.js` reporting handlers as they exist in the last functional build: `/dashboard/summary`, `/finance/summary`, `/finance/transactions`, `/finance/pending`, `/analytics/bi`, `/analytics/revenue-trend`, `/analytics/churn`, `/analytics/member-segments`, `/analytics/high-value-members`, `/analytics/finance-dashboard`, `/analytics/renewal-forecast`, `/analytics/executive-summary`, `/marketing/dashboard`, `/activity-logs`, `/export/activity`.
- **Reproduction:** Logged in as two separate tenants (t1 and an independent tenant t2). Called each endpoint with both cookies and diffed the responses:
  - `dashboard/summary` → **identical** (both gyms: totalMembers 5, revenueMtd ₹141,680).
  - `finance/summary` / `finance/transactions` → **identical** (Gym B sees Gym A's payments, amounts, txn refs).
  - `analytics/high-value-members` → **identical**, leaking member name "Alex Johnson" and phone "+1 (555) 123-4567" to the other gym.
  - `activity-logs` and `export/activity` (CSV) → **identical**, leaking the other tenant's audit trail and user IDs.
  - `finance/pending` → seeded an Unpaid invoice in t1; tenant **t2 received it** (member "Alex Johnson", amount, t1's tenant_id).
- **Root Cause:** These queries `SELECT … FROM payments/members/invoices/activity_logs` with **no `tenant_id` predicate**. `finance/pending` even passes `[req.tenant_id]` as a bind param but the SQL has no `?` for it (silently ignored).
- **Suggested Fix:** Every query that reads tenant-owned data must filter `tenant_id = ?`. Add an integration test that provisions two tenants with distinct data and asserts zero overlap on every endpoint. Consider a data-access layer that *requires* a tenant id rather than relying on each query author to remember.
- **Business Impact:** Catastrophic. This is a privacy/GDPR/contractual breach: paying customers see competitors' revenue, member PII, and transactions. One screenshot from a customer ends the company. This alone is grounds for an investor to walk.

## C3 — Entire multi-tenant database is downloadable over HTTP with no authentication
- **Severity:** Critical — **[VERIFIED LIVE]**
- **Location:** `server.js:31` — `app.use(express.static(__dirname))` serves the **whole project root**.
- **Reproduction:** With **no cookie**: `GET /database.db` → **HTTP 200, 393,216 bytes**, a valid SQLite file ("SQLite format 3"). Also served unauthenticated: `/server.js`, `/database.js`, `/routes/api.js`, `/package.json` (all 200). Any `backup_*.db` / `backup_*.json` written to root (see C8) is likewise downloadable.
- **Root Cause:** Static middleware rooted at the application directory, which contains the live database, all source, and backups. (`.env` happens to be protected only because Express ignores dotfiles by default — luck, not design.)
- **Suggested Fix:** Never serve the project root. Move the front-end into a dedicated `public/` directory and serve only that. Move `database.db` and backups outside the web root entirely. Add a deployment check that `GET /database.db` returns 404.
- **Business Impact:** Full data breach of every customer with a single GET request, including bcrypt hashes (offline-crackable) and password-reset tokens. Game over.

## C4 — Hard-coded backdoor accounts ship in the product
- **Severity:** Critical — **[VERIFIED LIVE]**
- **Location:** `database.js:694–702` — seeds `admin@jsbfitness.in` / `admin123` (Owner, `["all"]` permissions) and `manager@jsbfitness.in` / `vikram123`, both `email_verified=1`, `status=active`.
- **Reproduction:** `POST /api/v1/auth/login {"email":"admin@jsbfitness.in","password":"admin123"}` → **200, valid auth cookie issued.**
- **Root Cause:** Demo seed data left in the production bootstrap with publicly-knowable passwords. The same hash is even string-interpolated into the seed SQL.
- **Suggested Fix:** Remove all seeded human accounts. First-run should create the owner from signup only. If a seed admin is unavoidable, generate a random password and print it once to the operator.
- **Business Impact:** Anyone who reads this repo (or guesses) owns every fresh install. Combined with C3, an attacker logs in as Owner and/or downloads the DB.

## C5 — Stored XSS via member name / phone / photo URL
- **Severity:** Critical/High — **[VERIFIED via code + DOM inspection]**
- **Location:** `member_directory_kinetic_enterprise/code.html:144–172` (`card.innerHTML = \`…${m.full_name}…${m.phone}…src="${photo}"\``). No escaping anywhere; no DOMPurify/escape helper exists in `assets/js`. Same unescaped-`innerHTML` pattern is pervasive (e.g. `assets/js/onboarding.js`, member profile, timelines).
- **Reproduction:** Add a member named `<img src=x onerror=alert(document.domain)>` (the Add Member API has no input sanitization). Open `/members`. The script executes in the owner's session. A `photo_url` of `x" onerror="…` breaks out of the `src` attribute identically.
- **Root Cause:** User-controlled strings interpolated into `innerHTML` without encoding.
- **Suggested Fix:** Use `textContent`/`createElement` for data, or an escaping helper / DOMPurify for any HTML. Validate/encode on input *and* output.
- **Business Impact:** A malicious member name (or a compromised trainer) runs JavaScript as the gym Owner — can drive any authenticated action, exfiltrate the (cross-tenant) data of C2, etc. httpOnly cookies blunt token theft but not action-on-behalf.

## C6 — No subscription/billing lifecycle: payments are self-asserted and there is no webhook
- **Severity:** Critical (business)
- **Location:** `routes/api.js` `/subscription/submit-upi-payment` (~376) and `/subscription/change` (~263); `server.js` has **no Razorpay webhook route**; `lib/razorpay.js` `createSubscription` ignores the customer and never persists the subscription.
- **Reproduction:** `POST /api/v1/subscription/change {"plan":"enterprise"}` upgrades the tenant to Enterprise **with no payment at all** (it just `UPDATE tenants SET subscription_plan='enterprise'`). The UPI path accepts any 12-digit number as a "UTR" and immediately marks the plan active, pending nobody's verification.
- **Root Cause:** Plan state is writable by the client; there is no server-authoritative billing source (no webhook to confirm captures, renewals, failures, cancellations).
- **Suggested Fix:** Make plan state changeable **only** by verified Razorpay webhooks (signature-checked) / verified payment signatures. Add `/webhooks/razorpay` mounted **before** auth, verify `X-Razorpay-Signature`, and reconcile `subscriptions`/`tenants` there. Treat `/subscription/change` as request-only.
- **Business Impact:** Customers self-upgrade to paid tiers for free; you cannot bill, renew, dun, or cancel reliably. There is no working revenue mechanism — fatal for a SaaS sale.

---

# HIGH PRIORITY ISSUES

## H1 — Attendance check-ins are written with `tenant_id = NULL` and vanish from the gym's own reports
- **Severity:** High — **[VERIFIED LIVE]**
- **Location:** `routes/api.js` `/attendance/check-in` INSERT (working tree ~1257; committed ~898) — `INSERT INTO attendance (id, member_id, check_in, access_method)` omits `tenant_id`.
- **Reproduction:** Checked in a tenant-2 member via the API; queried the DB: the new row has `tenant_id = NULL`. `/attendance/summary` and `/attendance/logs` filter `tenant_id = ?`, so the check-in never appears; dashboard "present today" is wrong.
- **Root Cause:** Missing `tenant_id` column in the INSERT.
- **Suggested Fix:** Add `tenant_id` to the insert; backfill orphaned rows; add a NOT NULL + FK constraint so this can't recur.
- **Business Impact:** The single most-used daily feature (front-desk check-in) silently loses data. Attendance reports, "absent member" automations, and retention scores are all wrong.

## H2 — `/attendance/summary` "present" count is always 0
- **Severity:** High — **[VERIFIED LIVE]**
- **Location:** `routes/api.js` attendance/summary (committed ~837; working ~1196): `const presentResult = await allQuery(...)` then reads `presentResult.count`. `allQuery` returns an **array**; `.count` is `undefined` → `present = 0`.
- **Reproduction:** `GET /api/v1/attendance/summary` → `{"present":0,...}` even when the dashboard reports people present today.
- **Root Cause:** Wrong helper (`allQuery` vs `getQuery`) for a single-row aggregate.
- **Suggested Fix:** Use `getQuery`, or read `rows[0].count`.
- **Business Impact:** Live occupancy / capacity widget is always empty — owner can't trust the floor count.

## H3 — Verification & password-reset emails hard-code `http://localhost`
- **Severity:** High
- **Location:** `lib/emailService.js:80` and `:90` — `http://localhost:${port}/verify-email?...` and `/reset-password?...`.
- **Reproduction:** Sign up on any real host; the verification link points to `http://localhost:3000`, unreachable for the customer.
- **Root Cause:** No configured public base URL.
- **Suggested Fix:** Use an `APP_BASE_URL` env var for all outbound links.
- **Business Impact:** **No one can verify their email or reset their password in production.** Since login requires `email_verified`, every real signup is locked out at the door. (See also H4.)

## H4 — Signup hard-fails if email isn't configured; trial onboarding is a dead end without SMTP
- **Severity:** High
- **Location:** `server.js:223–229` (`sendVerificationEmail` → on failure returns 502 *after* creating the user); login requires `email_verified` (`server.js:165`).
- **Reproduction:** With no `EMAIL_API_KEY`, signup creates the user but returns 502; the user can never verify and therefore can never log in. The DB shows many `email_verified=0` test accounts stuck exactly this way.
- **Root Cause:** Verification is mandatory but delivery is unreliable/unconfigured, with no resend, no admin override, no link surfaced.
- **Suggested Fix:** Provide a resend flow, an operator "force verify," and a configured provider; or allow trial usage before verification with a soft gate.
- **Business Impact:** Onboarding conversion ≈ 0 without flawless email. A trial that can't be entered can't convert.

## H5 — No CSRF protection; auth cookie is not `Secure` and has no `SameSite`
- **Severity:** High
- **Location:** `server.js:179–183` — `res.cookie('auth_token', …, { httpOnly:true, secure:false })`; no `sameSite`. `app.use(cors())` is wildcard.
- **Reproduction:** A logged-in owner visiting a malicious page can be made to POST (e.g. `/api/v1/subscription/change`, `/api/v1/members`, delete member) because the cookie is sent cross-site with no CSRF token.
- **Root Cause:** Cookie-session auth with no CSRF defense and permissive cookie flags.
- **Suggested Fix:** `sameSite:'lax'` (or strict) + `secure:true` in production; add CSRF tokens (or require a custom header that simple cross-site forms can't set) for state-changing routes; scope CORS to known origins.
- **Business Impact:** One-click account/data manipulation against logged-in owners; plaintext token capture on any non-HTTPS hop.

## H6 — No rate limiting / brute-force protection on login (or anything)
- **Severity:** High
- **Location:** `server.js` login handler; no rate-limit middleware anywhere (`grep` confirms none).
- **Reproduction:** Unlimited `POST /api/v1/auth/login` attempts; combined with weak/known passwords (C4) and no password policy (M3), accounts are trivially brute-forceable.
- **Root Cause:** No throttling.
- **Suggested Fix:** Add IP+account rate limiting and exponential backoff/lockout; consider CAPTCHA after N failures.
- **Business Impact:** Credential stuffing and brute force at will; account takeover.

## H7 — Cross-tenant write/tamper on payment verification
- **Severity:** High
- **Location:** `routes/api.js` `/finance/collect/verify` (~1409,1413,1416) and `/memberships/renew/verify` (~2323,2327,2330) — `UPDATE payments … WHERE id = ?` and `SELECT … WHERE id = ? AND status='Pending'` with **no `tenant_id`**.
- **Reproduction:** Knowing/guessing another tenant's `payment_id`, send an invalid signature → that tenant's pending payment is set to `Failed` (`UPDATE payments SET status='Failed' WHERE id=?`). Cross-tenant denial/corruption of billing state.
- **Root Cause:** Payment lookups/updates not scoped to the caller's tenant.
- **Suggested Fix:** Add `AND tenant_id = ?` to every payment read/write; verify the payment belongs to the caller before mutating.
- **Business Impact:** A tenant can sabotage another tenant's payment records.

## H8 — Stateless JWT with no revocation; logout is cosmetic; tokens live up to 30 days
- **Severity:** High
- **Location:** `server.js` `/auth/logout` (clears cookie only); `login` issues `30d` tokens when "remember" is set; no token blacklist/rotation; permissions are baked into the token.
- **Reproduction:** Capture a token; "log out"; the token still authenticates every API call until expiry. Changing a user's role/permissions or suspending them does not invalidate existing tokens.
- **Root Cause:** No server-side session/revocation list; authorization data frozen in a long-lived token.
- **Suggested Fix:** Short access tokens + refresh, or a server session store; a revocation list keyed on logout/suspend/role-change; re-read permissions server-side.
- **Business Impact:** Suspended/fired staff retain access; stolen tokens are valid for a month.

---

# MEDIUM PRIORITY ISSUES

## M1 — Member counts are inconsistent across screens
- **Severity:** Medium — **[VERIFIED LIVE]**
- **Location:** `/subscription/status` (`COUNT(*) … WHERE tenant_id=?` → 9 for t1) vs `/dashboard/summary` totalMembers (active-only / global → 5) vs `/analytics/bi` (`totalActive` 5, `newMembers` 12).
- **Root Cause:** Each endpoint counts a different population (all vs active vs "this month") and, in the committed build, some count globally (C2). No single source of truth.
- **Suggested Fix:** Centralize member metrics; label each number ("active" vs "total"); scope all to tenant.
- **Business Impact:** Owner sees three different "member counts" and trusts none; usage/limit enforcement is ambiguous.

## M2 — Renewal ignores day-based plans and never increments `renewal_count`
- **Severity:** Medium
- **Location:** `routes/api.js` `/memberships/renew` (~2247, ~2268): `endDate = start + duration_months` only — `duration_days` is ignored, so a day-based plan renews to **same-day expiry**. Every renewal inserts `renewal_count = 1` (hard-coded), never incremented.
- **Root Cause:** Incomplete plan-duration handling; renewal counter not derived from history.
- **Suggested Fix:** Compute end date from months **and** days; set `renewal_count = prior + 1` (or count memberships).
- **Business Impact:** Wrong expiry dates (revenue/access errors) for day-based plans; "renewals" analytics understated.

## M3 — No password policy
- **Severity:** Medium
- **Location:** `server.js` `/auth/signup` — only checks presence; no length/complexity (confirmed: no length check exists).
- **Root Cause:** Missing validation.
- **Suggested Fix:** Enforce a minimum length/complexity server-side; reject breached/common passwords.
- **Business Impact:** Users set "1"; combined with H6, trivial takeover.

## M4 — Invoice/receipt numbers collide
- **Severity:** Medium
- **Location:** `routes/api.js` renew (~2258): `RCPT-<year>-<3-digit random>` (only 900 values/year). IDs use bare `Date.now()` (`ms`+`inv`+`pay`), which collide under concurrency → PK insert failure.
- **Root Cause:** Weak uniqueness for human-facing invoice numbers and record IDs.
- **Suggested Fix:** Monotonic per-tenant invoice sequence; UUIDs (or `Date.now()+random+counter`) for PKs.
- **Business Impact:** Duplicate invoice numbers (accounting/tax problems); occasional failed renewals at busy times.

## M5 — File upload accepts any type and any size; served from app origin
- **Severity:** Medium
- **Location:** `routes/api.js` multer config (~3586–3607) — `multer({ storage })` with **no `fileFilter` and no `limits`**, keeps original extension, serves from `/assets/uploads/logos/`.
- **Reproduction:** Upload `logo.html` (or an SVG with script) as a "logo"; it's stored and served same-origin → stored XSS / arbitrary file hosting. A multi-GB upload fills the disk (DoS).
- **Suggested Fix:** Whitelist image MIME types + extensions, cap size (e.g. 2 MB), randomize names with a fixed safe extension, ideally serve uploads from a separate domain/bucket.
- **Business Impact:** Another stored-XSS vector and a disk-exhaustion DoS.

## M6 — `runAutomationScans()` runs synchronously on every dashboard load
- **Severity:** Medium (performance/correctness)
- **Location:** `routes/api.js` `/dashboard/summary:2114` calls `await runAutomationScans()` (the large block ~490–760) that scans memberships/attendance/invoices and writes notifications/tasks every time the dashboard is opened.
- **Root Cause:** Cron-style work executed inline on a hot read path; also racy (concurrent dashboard loads double-create alerts despite "exists" checks).
- **Suggested Fix:** Move to a scheduled job; debounce; make alert creation idempotent with unique constraints.
- **Business Impact:** Slow dashboards under load; duplicate/again-and-again notifications and tasks.

## M7 — Backups are written into the web root and aren't fully git-ignored
- **Severity:** Medium
- **Location:** `routes/api.js` `/backup/create:3528` writes `backup_<tenant>_<ts>.json` to project root (served statically — see C3). `.gitignore` ignores `backup_*.db` but **not** `backup_*.json`; a `backup_1780728409352.db` already sits in the repo root.
- **Suggested Fix:** Write backups outside the web root, access-controlled; ignore all backup artifacts; stream downloads through the authorized endpoint only.
- **Business Impact:** Tenant data backups become publicly fetchable and may be committed to source control.

## M8 — Trial/plan limits not enforced on page access or premium reads consistently
- **Severity:** Medium
- **Location:** `server.js` page routes check only JWT validity (no subscription/trial check); `checkSubscription` blocks some premium **paths** by prefix but the page HTML always loads.
- **Root Cause:** Feature gating is partial and front-end-trusting.
- **Suggested Fix:** Enforce plan/trial server-side on both data and navigation; don't rely on hiding UI.
- **Business Impact:** Expired trials still browse the app; feature locks are bypassable by hitting endpoints directly.

## M9 — Razorpay/UPI secrets stored in plaintext in the `settings` table
- **Severity:** Medium
- **Location:** `database.js:778–779` seeds `razorpay_key_id` / `razorpay_secret` settings; settings are EAV plaintext.
- **Suggested Fix:** Keep payment secrets in env/secret manager, never in the tenant DB; if stored, encrypt at rest.
- **Business Impact:** Combined with C3 (DB downloadable), payment credentials leak.

---

# LOW PRIORITY ISSUES

- **L1 — Repo is full of one-off scripts and dead code.** ~40 `fix_*.js`, `rewrite_*.js`, `refactor_*.js`, `scratch_*.js`, `test_*.js`, plus duplicate routers `routes/api_tenant.js`, `api_fully_isolated.js`, `api_updated.js`, `api_injected.js` (none mounted). Signals an unmaintained, copy-paste-refactor workflow. *Fix:* delete; keep migrations in a `migrations/` dir.
- **L2 — Inconsistent branding.** `package.json`/seeds say "Kinetic Enterprise" / "JSB Fitness"; product is "Gym Flow"; tenant gym names are auto-generated as `"<First> 's Gym"`. *Fix:* finalize white-label naming; don't auto-name gyms from a person's first name.
- **L3 — Schema built by repeated `ALTER TABLE … catch(e){}`.** Migrations are best-effort try/catch with no version tracking. *Fix:* a real migration runner.
- **L4 — `console.error(err)` leaks stack traces;** Express default error page returns stack traces (seen when posting malformed JSON). *Fix:* central error handler, generic messages, structured server-side logging.
- **L5 — Seeded default tenant `t1` has `subscription_plan = NULL`** (DB validation) yet is treated as enterprise/active elsewhere — inconsistent default state. *Fix:* seed explicit plan/status.
- **L6 — Orphaned data already in the DB:** a member and attendance rows with `tenant_id = NULL` (from H1). *Fix:* clean up + constrain.
- **L7 — `members` PK/refs use `Date.now()`-based ids;** signup tenant id is `t_<Date.now()><rand>` — low but nonzero collision risk on bulk import.
- **L8 — No tests.** No automated test suite exists; "tests" are ad-hoc scripts. *Fix:* add API + isolation integration tests (this is how C1/C2 would have been caught).

---

# TOP 25 FIXES BEFORE LAUNCH
(ordered by blast radius)

1. **Make the app run.** Fix all ~40 `query("…"[params])` calls (C1); add a CI guard against the pattern.
2. **Stop serving the project root.** Move front-end to `public/`; move DB/backups out of web root (C3). Verify `GET /database.db` → 404.
3. **Remove backdoor seed accounts** `admin123` / `vikram123` (C4).
4. **Add `tenant_id = ?` to every read and write** across dashboard/finance/analytics/exports/activity-logs (C2) — and prove it with a two-tenant isolation test.
5. **Fix attendance INSERT to include `tenant_id`** + NOT NULL/FK; backfill NULL rows (H1).
6. **Server-authoritative billing:** Razorpay webhook (signature-verified) as the only source of plan state; remove client-writable `/subscription/change` upgrades (C6).
7. **Escape all output** / use DOMPurify or `textContent`; sanitize member name/phone/photo on input and output (C5).
8. **Configure `APP_BASE_URL`** for verification/reset emails; add resend + operator force-verify (H3/H4).
9. **Cookies:** `secure:true`, `sameSite:'lax'`; add CSRF protection; scope CORS (H5).
10. **Rate-limit login** and sensitive endpoints; lockout/backoff (H6).
11. **Scope payment verify/update** by tenant (H7).
12. **JWT revocation / shorter tokens / server-read permissions;** real logout (H8).
13. **Fix `attendance/summary` present count** (`getQuery`/`rows[0]`) (H2).
14. **Single source of truth for member metrics;** label active vs total (M1).
15. **Renewal: honor `duration_days`; increment `renewal_count`** (M2).
16. **Password policy** + breached-password check (M3).
17. **Per-tenant invoice sequences;** collision-safe record IDs (M4).
18. **Harden uploads:** type/size whitelist, random safe names, off-origin storage (M5).
19. **Move automation scans to a scheduled job;** idempotent alerts (M6).
20. **Backups outside web root + gitignore all backup artifacts** (M7).
21. **Enforce plan/trial gating server-side** on data and pages (M8).
22. **Move payment secrets to env/secret manager;** encrypt any at rest (M9).
23. **Central error handler;** no stack traces to clients (L4).
24. **Introduce a real migration runner;** seed explicit tenant defaults (L3/L5).
25. **Delete dead scripts/duplicate routers; add an automated test suite** (L1/L8).

---

# CATEGORY SCORES

| Category | Score | One-line justification |
|---|---:|---|
| **Security** | **8 / 100** | Unauth DB download, backdoor creds, global tenant leakage, stored XSS, no CSRF, no rate limit, plaintext secrets. |
| **Reliability** | **6 / 100** | Current build segfaults on the first authenticated request; data silently orphaned; no tests. |
| **UX** | **42 / 100** | Many screens exist and look polished, but they show wrong/empty/cross-tenant numbers and broken onboarding. |
| **Performance** | **50 / 100** | Reasonable indexes, but heavy synchronous automation on the dashboard hot path and full-table global scans. |
| **SaaS Readiness** | **8 / 100** | Tenant isolation broken both ways, no billing lifecycle/webhooks, localhost emails, white-label half-done. |
| **Business Readiness** | **15 / 100** | Customers can self-upgrade for free; no reliable revenue capture; reports untrustworthy. |
| **Code Quality** | **14 / 100** | Regex refactors that corrupt the codebase, ~40 broken queries, dozens of scratch files, duplicate routers, no tests. |

**Weighting rationale:** Security and Reliability dominate for a product about to handle other people's members, money, and PII. Both are near-zero, and either one independently blocks a sale.

---

# OVERALL SCORE

## **14 / 100**

A working, well-isolated SaaS would start here and lose points for polish. This product instead **does not run in its current state**, and the last version that ran **exposes every customer's data to every other customer and to the open internet.** The attractive front-end cannot offset a non-functional, non-isolated, non-secure backend.

---

# WOULD YOU SELL THIS TO PAYING CUSTOMERS TODAY?

## **NO**

**Why — bluntly:**

- **It doesn't work.** I started the server and logged in successfully, then made one ordinary authenticated request and the **process segfaulted**. The current `routes/api.js` is corrupted by an automated "tenant isolation" refactor; ~40 queries call `query(undefined)`. A gym owner cannot load a single data screen today.
- **The version that does start leaks everything.** Logged in as two different gyms, the dashboard, finance, and analytics endpoints returned **identical** data — same revenue, same members, same transactions, same audit log. Gym B sees Gym A's money and members. That is a contract-ending, possibly law-breaking data breach baked into the core architecture.
- **The database is on the public internet.** `GET /database.db` with no login returns the entire 393 KB multi-tenant SQLite file — all gyms, all PII, all password hashes. So is the source code.
- **There are hard-coded admin backdoors** (`admin123`) that I logged in with.
- **There is no real billing.** A tenant upgrades itself to Enterprise for free with one request; there is no webhook to confirm, renew, or cancel anything. There is no working way to actually get paid or keep customers paying.
- Layered on top: stored XSS via a member's name, no CSRF protection, no login rate limiting, no password policy, verification/reset emails pointing at `localhost`, and attendance check-ins silently saved with a NULL tenant so they disappear from the gym's own reports.

This is not a launch-blocker list to grind through in a week. **C1–C6 together require rebuilding the data-access, isolation, security, and billing layers, then proving isolation with automated tests.** Selling this tomorrow would expose paying gym owners — and their members — to data theft and the company to liability, with a product that, as it sits on disk right now, crashes on first use.

**Recommendation:** Halt any sale. Freeze feature work. Fix C1–C6, then H1–H8, behind a mandatory two-tenant isolation test suite and a security pass, before this is shown to a single paying customer.

---

*Audit methodology note: findings marked **[VERIFIED LIVE]** were reproduced against the running application (login, authenticated API calls, two-tenant cross-isolation tests, and direct SQLite inspection). The remainder are from source inspection of `server.js`, `routes/api.js`, `database.js`, `lib/*`, and the front-end `*_kinetic_enterprise/code.html` screens. Live testing was performed against the last functional (committed) build in an isolated copy; the current working tree was confirmed non-functional (segfault) and is the basis of C1.*
