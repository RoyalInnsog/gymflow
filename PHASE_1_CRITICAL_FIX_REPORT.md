# PHASE 1 + CRITICAL SECURITY HARDENING — FIX REPORT

**Date:** 2026-06-16
**Scope:** Local only. No push, no PR, no merge, no deploy. All work on the local working tree.
**Backup created before any change:**
- Full repo copy (incl. `.git`, excl. `node_modules`): `P:\Projects\GYM_Flow_BACKUP_20260616_002604` (9.4 MB)
- Live DB snapshot: `database.db.pre_phase1_20260616_002604.bak`

**Critical issues addressed:** C1 (query corruption), C2 (tenant isolation), C3 (database/source exposure), C4 (backdoor accounts).
**Verification:** The application was actually started and driven via authenticated HTTP requests with **two independent tenants**. Results below are observed, not assumed.

---

## 1. FILES CHANGED

Only the following were modified to implement C1–C4 (the many other `M` entries in `git status` are pre-existing working-tree edits from before this session and were **not** touched):

| File | Change | Issue |
|---|---|---|
| `routes/api.js` | Repaired 54 corrupted `query("sql"[params])` calls; removed bogus `tenant_id` filters on global tables (`tenants`, `roles`); fixed 6 SQL operator-precedence leaks; scoped 19 unscoped queries; converted `runAutomationScans`/`resolveTemplate`/`logActivity` to take an explicit `tenantId`; fixed 5 `LIMIT ?` param-order bugs; fixed 2 process-crashing handler bugs; moved logo-upload dir under `public/` | C1, C2, C3 |
| `server.js` | Static serving restricted from project root to `public/` only (`dotfiles:'deny'`); added one authenticated route for the daily-closing print page | C3 |
| `database.js` | Removed seeded `admin@jsbfitness.in` / `manager@jsbfitness.in` accounts and default passwords; added idempotent purge of any pre-existing backdoor accounts on boot | C4 |
| `assets/` → `public/assets/` | Entire web-asset tree moved into the new `public/` directory (front-end URLs unchanged) | C3 |
| **Deleted:** `routes/api_injected.js`, `routes/api_tenant.js`, `routes/api_fully_isolated.js`, `routes/api_updated.js` | Unmounted dead duplicate routers; `api_injected.js` alone held **61** corrupted queries | C1 |

No application source other than the three core files (`server.js`, `database.js`, `routes/api.js`) was edited.

---

## 2. EXACT FIXES APPLIED

### C1 — `query("sql"[params])` corruption
- **Transform:** every `query(<string>[params])` (a string indexed by an array → `query(undefined)` → segfault) rewritten to `query(<string>, [params])`. Covered all three quote styles: `"[`, `` `[ ``, and `'[`. The single-quote variant (1 site, line 3335 in `analytics/renewal-queue`) was the one that crashed the server during verification and was initially missed; a definitive AST detector was then used to prove zero remain.
- **Global-table mis-scoping:** the refactor had appended `AND tenant_id = ?` to queries on tables that have **no** `tenant_id` column. Removed from all 9 `tenants` queries and the `roles` query (these were throwing `no such column: tenant_id`).
- **Operator precedence:** the refactor appended `AND tenant_id = ?` after un-parenthesized `OR` groups (`A OR B AND tenant_id` = `A OR (B AND tenant_id)`), leaking other tenants' rows. Parenthesized 6 sites: comm-history timeline, `renewal-queue`, `payment-recovery`, marketing welcome-count, and 2 lead-conversion counts.
- **Param order:** the refactor appended `req.tenant_id` to the end of param arrays even when a `LIMIT ?` placeholder came after the `tenant_id = ?` clause, causing `SQLITE_MISMATCH` and wrong binding. Fixed 5 sites (`analytics/bi`, `revenue-trend`, `finance-dashboard` ×3).
- **Helper functions:** `runAutomationScans()`, `resolveTemplate()`, and `logActivity()` referenced `req.tenant_id` but receive no `req`. Converted each to take an explicit `tenantId` parameter; updated all 5 `runAutomationScans` call sites and the `logActivity` call site to pass `req.tenant_id`.
- **Repo-wide search:** confirmed via AST scan over `server.js`, `database.js`, `routes/api.js`, and `lib/*` that **zero** corruptions remain.

### C2 — Tenant isolation
- Added `tenant_id` scoping to every previously-unscoped query found by an AST scan (19 sites), including the confirmed cross-tenant **read leaks**:
  - `/finance/pending` (was `WHERE status='Unpaid'` with no tenant filter)
  - `/activity-logs` (no filter; also changed `getQuery`→`allQuery` so it returns a list)
  - `/export/:type` activity branch (no filter)
  - `/reports/export` membership type (no filter)
- Scoped both **payment-verify** paths (`/finance/collect/verify`, `/memberships/renew/verify`) so a tenant cannot mark another tenant's payment Failed/Successful by id.
- Added `tenant_id` to all orphaning **INSERTs**: attendance check-in, leads, tasks, staff, equipment, branches, retention events, daily-closing reports, automation notifications/tasks, and activity logs.
- Fixed the 6 precedence leaks and 5 param-order bugs (above) which were themselves cross-tenant leaks.

### C3 — Database / source exposure
- Replaced `app.use(express.static(__dirname))` (served the whole repo, incl. `database.db`, `.env`, all source, backups) with `app.use(express.static(path.join(__dirname,'public'), { dotfiles:'deny' }))`.
- Moved `assets/` into `public/assets/` so `/assets/...` URLs keep working; redirected logo uploads to `public/assets/uploads/logos`.
- Added a single authenticated route for the one screen file the UI opens directly (`/daily_closing_report_kinetic_enterprise/print.html`).

### C4 — Backdoor accounts
- Removed the seed block that created `admin@jsbfitness.in` (`admin123`) and `manager@jsbfitness.in` (`vikram123`). No seeded human accounts and no default passwords remain.
- Added an idempotent on-boot purge that deletes those accounts from any existing database file. On the live DB the boot log confirmed: **"Removed 2 legacy seeded backdoor account(s)."**
- Signup remains the sole path to the first Owner account.

---

## 3. NUMBER OF CORRUPTED QUERIES REPAIRED

| Location | Corruptions (before) | After |
|---|---:|---:|
| `routes/api.js` (live router) | **54** (11 `"[` + 42 `` `[ `` + 1 `'[`) | **0** |
| `routes/api_injected.js` (dead router, deleted) | 61 | n/a (file removed) |
| **Total resolved repo-wide** | **115** | **0** |

Verification method: a `@babel/parser` AST scan that flags any `getQuery/allQuery/runQuery` whose first argument is a `MemberExpression` (the exact corruption signature). Final result: **`CLEAN: zero query(string[params]) corruptions.`**

---

## 4. TENANT ISOLATION RESULTS

Two independent tenants were created via the real signup flow and seeded with distinct data:
- **Tenant A** — Anna A, plan ₹1000, one Cash payment (₹1180 total).
- **Tenant B** — Ben B, plan ₹2000, one Cash payment (₹2360 total).

| Test | Result |
|---|---|
| `GET /members/:id` cross-tenant (A reads B, B reads A) | **404 both ways** — own member 200 |
| `GET /members` list | A sees only Anna; B sees only Ben |
| `finance/summary`, `finance/transactions`, `dashboard/summary` | **Differ correctly** (A ₹1180 / B ₹2360); each sees only its own payments |
| `finance/pending` (seeded Unpaid invoice for A) | B does **not** see A's invoice |
| Analytics suite (enterprise): `bi`, `executive-summary`, `revenue-trend`, `churn`, `member-segments`, `high-value-members`, `finance-dashboard`, `renewal-forecast`, `renewal-queue`, `payment-recovery` | **All differ / scoped** — renewal-queue now shows A→"Anna A", B→"Ben B" (previously returned a third tenant's member to both) |
| `crm/leads`, `tasks` (seeded per tenant) | A sees only Alpha; B sees only Beta |
| `activity-logs`, `export/activity` | Tenant-scoped (no cross-tenant rows) |
| Write IDOR: A `DELETE`s B's member | **404**, B's member intact (200) |
| Exhaustive A-vs-B sweep (44 read endpoints) | 26 differ; the rest identical **only because both new tenants are legitimately empty**; **0 identical-with-foreign-data leaks** |

**Conclusion:** No cross-tenant read or write leakage observed across any tested endpoint.

---

## 5. DATABASE EXPOSURE RESULTS

Unauthenticated requests (no cookie):

| URL | Result |
|---|---|
| `GET /database.db` | **404** (was 200, 393 KB) |
| `GET /.env` | **404** |
| `GET /server.js`, `/database.js`, `/routes/api.js`, `/package.json` | **404** |
| `GET /FIX_PLAN.md`, `/_srv_out.log` | **404** |
| `GET /backup_1780728409352.db` | **404** |
| Path-traversal (`/../database.db`, `/..%2fdatabase.db`, `/%2e%2e/database.db`) | **404** |
| `GET /assets/js/api.js`, `/assets/css/shared.css` (legit) | **200** (still work) |

**Conclusion:** The database, environment file, source, and backups are no longer downloadable; only `public/` assets are served.

---

## 6. AUTHENTICATION RESULTS

| Test | Result |
|---|---|
| Old backdoor `admin@jsbfitness.in` / `admin123` | **401 — rejected** (account purged) |
| Old backdoor `manager@jsbfitness.in` / `vikram123` | **401 — rejected** |
| New signup (Tenant A, Tenant B) | User+tenant created (HTTP 502 only because the verification **email** can't send without `EMAIL_API_KEY` — out of Phase-1 scope; user row exists) |
| Login (valid credentials) | **200**, auth cookie issued |
| Login (wrong password) | **401** |
| Logout → reuse cookie | Authed call **200 before**, **401 after** logout |

---

## 7. REMAINING CRITICAL ISSUES (NOT in this phase's scope)

These were **not** part of C1–C4 and are still open. The app is **not** sellable until at least C5 and C6 are done:

- **C5 — Stored XSS (Critical):** member name/phone/photo are still injected into `innerHTML` unescaped across the front-end (`member_directory_kinetic_enterprise/code.html` and others). Untouched.
- **C6 — Billing lifecycle (Critical):** still no Razorpay webhook; `/subscription/change` can still self-upgrade a tenant to a paid plan for free. Untouched.
- **High (H1–H8 from FIX_PLAN):** email links still point to `http://localhost` (H3); mandatory email verification with no resend strands signups (H4 — this is why signup returned 502 in testing); no CSRF protection and cookie lacks `Secure`/`SameSite` (H5); no login rate limiting (H6); JWT not revocable, logout only clears the cookie (H8).
- **Minor / observed during testing (not blockers):**
  - `logActivity` coverage is thin — it only runs on member creation, so `activity-logs` is sparse. Not a leak (it is tenant-scoped), just low signal.
  - New tenants start with **0 membership plans** because the demo seed plans are global (`tenant_id IS NULL`) and correctly invisible to them; onboarding must create plans first. Pre-existing UX gap.
  - `runAutomationScans` still runs on the dashboard request path with a global throttle (FIX_PLAN M6).

---

## 8. LAUNCH SCORE AFTER FIXES

**Before this phase: 14 / 100** (did not boot; leaked all data; DB downloadable; backdoors).

**After C1–C4: ~50 / 100.**

What changed: the four launch-blocking catastrophes are resolved and **verified on a running instance** — the app boots and survives a full authenticated sweep of 48 endpoints with **zero crashes/segfaults**, tenant isolation holds across reads and writes with **zero observed leaks**, the database/source/backups are no longer exposed, and the hard-coded admin backdoors are gone.

Why it is **not** higher: two Critical issues remain untouched by design (**C5 stored XSS**, **C6 billing has no server-authoritative source**), plus the High-severity hardening items (CSRF, cookie flags, rate limiting, JWT revocation, production email/links). 

**Would I sell it today? Still NO** — but it is no longer "data-breach-on-first-request." It is now a stable, tenant-isolated base on which Phases 3–5 (security hardening, billing, analytics polish) can be built. Recommended next: C5 and C6, then H1–H8.

---

*Honesty note: every PASS above was produced by running `node server.js` and issuing real authenticated HTTP requests against two tenants, including a deliberate crash-hunt that found and fixed a single-quote corruption and an OR-precedence leak the first pass missed. No result here is claimed without a corresponding live test. The pre-change backup and DB snapshot are retained locally for rollback.*
