# GYM Flow — Consolidated Security & Functionality Audit

> Combined CTO audit + deep audit. All findings are actionable. Severity legend: 🔴 CRITICAL · 🟠 HIGH · 🟡 MEDIUM · 🟢 LOW · 🐛 BUG · 🏗️ ARCH

---

## 🔴 CRITICAL

| # | Issue | Location | Impact |
|---|-------|----------|--------|
| C1 | Hardcoded Razorpay test keys in `.env` committed to repo | `.env:22-23` | Test keys exposed. If switched to live keys without rotation, full payment compromise. |
| C2 | `WHATSAPP_CLOUD_ACCESS_TOKEN` (Meta permanent token) committed in `.env` | `.env:28` | Full WhatsApp Business API access — can send/receive messages as the platform, read all conversations, manage templates. |
| C3 | `GEMINI_API_KEY` committed in `.env` | `.env:34` | Google AI Studio key exposed — billable usage, model access. |
| C4 | `JWT_SECRET` in `.env` is a real production-grade secret | `.env:16` | Token signing key in repo — any leaked token can be forged, sessions hijacked, privilege escalation. |
| C5 | `RAZORPAY_WEBHOOK_SECRET` is a placeholder | `.env:18` | Webhook signature verification is effectively disabled — Razorpay callbacks can be spoofed. |
| C6 | Desktop Electron rewrites `Origin: https://localhost` on ALL API calls | `desktop/main.js:74-88` | Bypasses CSRF origin check — the server's `verifyCsrfOrigin` allows `https://localhost`. Any malicious site loaded in the Electron renderer can call the API with the user's cookies. |
| C7 | Kiosk QR check-in tokens stored in `global.kioskTokens` (in-memory, no persistence, no cleanup beyond 15s TTL) | `routes/api/members.js:679-698` | Tokens are guessable (8 bytes hex = 2^64), no rate limit on generation, no binding to staff session. Any user who discovers a valid token can check in any member by phone. |
| **B-N1** | **`apiUtils.js` has two `module.exports` blocks — the second shadows the first and omits `logActivity` + `resolveTemplate`** | `lib/apiUtils.js:96-100, 151-166` | **Every API route that calls `logActivity` throws `TypeError` → 500. WhatsApp template resolution is also dead.** Kills audit trail across the entire API. |

---

## 🟠 HIGH

| # | Issue | Location | Impact |
|---|-------|----------|--------|
| H1 | `ALLOWED_DISCOUNT_IDS`, `ALLOWED_DISCOUNT_TYPES`, `FEET_PER_METER`, `inLatRange`, `inLonRange`, `isFiniteNum`, `fsModule`, `BACKUP_DIR` referenced in `routes/api/settings.js` but DEFINED ONLY in `routes/api_stripped.js` | `settings.js:122,124,128,130` and `members.js:542,559,565,568,582,599,610` | Runtime `ReferenceError` → 500 on discount save, geofence save, geofence check-in. Routes broken in production. |
| H2 | `logActivity` imported from `apiUtils` but `apiUtils.js` exports it at line 99, then re-exports at line 151 — but `logActivity` is defined at line 102 AFTER the first export | `lib/apiUtils.js:99,102,151` | `logActivity` is undefined at require time — all calls throw `TypeError` → 500. |
| H3 | `BACKUP_DIR` defaults to `../data/backups` (repo-relative) | `routes/api_stripped.js:762, routes/api/core.js:378` | Backup files written under repo root — path traversal via symlink if `data/backups` is a symlink; also backups world-readable if served by static middleware. |
| H4 | No Content-Security-Policy enforcement in production when `DISABLE_CSP=true` | `server.js:35` | Allows disabling CSP via env — if accidentally set in prod, removes XSS mitigation. |
| H5 | OTP delivery is console-only; `ALLOW_TEST_OTP` can be true in prod | `lib/identity/account.js:197-200` | Phone verification uses fixed code `000000` if no SMS provider — anyone can verify any phone if deployed without a real provider and `ALLOW_TEST_OTP≠false`. |
| H6 | Google OAuth state cookie uses `sameSite: 'lax'` but callback is cross-origin in some deployments | `routes/auth.js:768` | CSRF on OAuth flow if embedded in iframe or cross-site. |
| H7 | `verifyCsrfOrigin` allows requests with NO Origin/Referer header | `server.js:232` | Non-browser callers (curl, scripts) bypass CSRF — intentional but worth noting; combine with missing `requireStaffRole` on some routes = API abuse surface. |
| H8 | Rate limiter "fail open" on DB error | `lib/identity/core.js:166-170` | SQLite contention or lock → limiter disabled → brute-force / DoS window. |
| **H-N1** | **Signup uses `Math.random()` for subdomain + creates writable user without tenant_id** | `routes/auth.js:136-152, 864` | 1-in-1000 collision risk. Two signups with same name throw on UNIQUE subdomain (no try/catch) → 500 with no rollback. Race condition where the user row points to a non-existent tenant. |
| **H-N3** | **Member PUT allows `status="Active"` without payment validation** | `routes/api/members.js:353-413` | Staff can flip a member from "Expired" to "Active" by sending `{"status":"Active"}` and the next GPS check-in succeeds. No finance gate. |
| **H-N8** | **`/health/sync` N+1 query storm** | `server.js:497-641` | Accepts `biometrics: [...]` up to 5000 items, then loops `runQuery` to insert/update `health_logs` — 5000 round-trips per request. DoS. |
| **H-N9** | **`/attendance/checkin` does NOT require `requireStaffRole` OR `requireMemberRole`** | `server.js:399` | Mounted with `authenticateToken, apiLimiter, requireTenant, idempotency` — but NO role check. A pending-role token can call the check-in endpoint and specify any `member_id`. |
| **H-N10** | **No CAPTCHA/turnstile on login — credential stuffing only rate-limited per IP** | `routes/auth.js:63-113` | `authLimiter` is 10 attempts per 15 min per IP. Behind a NAT, 10 users = 1000 attempts. Only per-email lockout is the gate. |
| **H-N11** | **Ollama AI endpoint has no timeout and no rate limit on `/ask`** | `services/aiInsights.js:38-107, routes/api/ai.js:8-22` | No abort, no max-tokens, no per-request budget. Ties up event loop, fills Ollama context window budget. |
| **H-N12** | **`gatherGymContext` exposes PII to local AI** | `services/aiInsights.js:7-33` | Member full names + expiry dates fed to the LLM as part of the system prompt. No consent gate. |

---

## 🟡 MEDIUM

| # | Issue | Location | Impact |
|---|-------|----------|--------|
| M1 | Subdomain generation uses `Math.random()` (predictable, collision-prone) | `routes/auth.js:138` | Tenant subdomain guessable; possible takeover if subdomain used for isolation. |
| M2 | `uid()` uses `randomUUID()` but many IDs use `Date.now()` + short random | `lib/apiUtils.js:60-62` vs `members.js:193,274,290,308,311` | ID collisions under concurrency (mitigated by `uid()` in newer code but legacy IDs remain). |
| M3 | `checkSubscription` middleware auto-downgrades trial→basic on every request | `lib/apiUtils.js:71-93` | Race condition: concurrent requests during trial expiry can double-downgrade, corrupt `subscription_history`. |
| M4 | Webhook idempotency uses `billing_events.razorpay_event_id` UNIQUE but eventId fallback uses `evt.event + '_' + created_at` | `server.js:130` | Duplicate webhook with same event+timestamp bypasses dedup → double-activation. |
| M5 | `requireFeature` / `authorize` checks JWT permissions array — but permissions are resolved at token issuance, NOT re-checked on each request | `lib/identity/core.js:374-381` | Permission changes (revoke role, change plan) don't take effect until token refresh (up to 1h). |
| M6 | `global.kioskTokens` never cleaned up on server restart — tokens persist in memory only; no Redis/shared store for multi-instance | `routes/api/members.js:679` | Multi-instance deployment breaks kiosk check-in; memory leak if tokens not deleted. |
| M7 | Email verification / password reset tokens stored as SHA-256 — good; but `verification_token` and `reset_token` legacy columns on `users` table store RAW tokens (pre-migration) | `lib/database.js:121-122, lib/identity/account.js:97-101,153-154` | Legacy tokens in `users` table are plaintext — if DB dumped, old links work. |
| M8 | `PLATFORM_UPI_ID` / `PLATFORM_UPI_NAME` from env used directly in subscription status response | `routes/api/billing.js:76-79` | If not set, empty string returned — UI shows nothing (ok), but no validation of format. |
| M9 | `trust proxy` parsing accepts arbitrary string | `server.js:23-26` | If `TRUST_PROXY=malicious`, `app.set('trust proxy', 'malicious')` — Express trusts arbitrary IPs for `req.ip`. |
| M10 | `cookieOptionsFor` only checks `Origin: https://localhost` for Capacitor | `lib/identity/core.js:290-296` | Doesn't handle `capacitor://localhost` origin — cookies may not be sent in APK. |
| **M-N1** | **`verify-otp` phone mismatch — accepts any phone, not the user's stored phone** | `routes/auth.js:713-745` | User with `phone=A` can verify `phone=B` and mark B as their verified phone. |
| **M-N2** | **`forgot-password-otp` uses `Math.random()` for OTP** | `routes/auth.js:290` | `Math.random()` is not cryptographically secure. Bypasses the secure path in `identity/account.js:183`. |
| **M-N3** | **`forgot-password-otp` leaks user existence via `devCode` response shape** | `routes/auth.js:298-303` | `devCode` only included when user exists → enumeration oracle in dev/staging. |
| **M-N9** | **CSP allows `cdn.jsdelivr.net` and `cdnjs.cloudflare.com` in `scriptSrc` — no SRI** | `server.js:45` | Any compromised script from these CDNs executes in the page. |
| **M-N10** | **`connect-src` includes hard-coded Tailscale hostname** | `server.js:46` | `https://desktop-s69biti.tail66553b.ts.net` — leaks personal infra name in public CSP. |
| **M-N15** | **`requireFeature` auto-downgrade race** | `lib/apiUtils.js:20-31` | Trial user calling Pro endpoint at expiry moment is auto-downgraded AND gets 403, but plan may be re-activated by webhook later. |
| **M-N17** | **`provider_message_id` column likely missing on `notifications` table** | `controllers/whatsappCloud.controller.js:151-154` | Webhook handler `UPDATE notifications SET delivery_status = ? WHERE provider_message_id = ?` assumes column exists. If absent, errors silently. |
| **M-N18** | **`notifications` table has no `provider_message_id` in any schema migration** | `lib/database.js:285-330` | CREATE TABLE + ALTERs do not add this column. Webhook UPDATE throws `no such column`. |
| **M-N20** | **Onboarding saves `logo_url` as free-form string — `javascript:` scheme possible** | `routes/api/core.js:60-77` | Attacker posts `logo_url: "javascript:alert(1)"` → stored XSS if rendered as a link. |

---

## 🟢 LOW

| # | Issue | Location | Impact |
|---|-------|----------|--------|
| L1 | `helmet.crossOriginOpenerPolicy: 'same-origin-allow-popups'` weakens COOP for Razorpay | `server.js:50` | Acceptable but document why. |
| L2 | Permissions-Policy allows `geolocation=(self), camera=(self)` | `server.js:55` | Consider `geolocation=(), camera=()` unless needed. |
| L3 | `bcrypt` rounds = 10 (OK), but `DUMMY_PW_HASH` re-generated on every restart | `lib/identity/core.js:33` | Timing analysis can detect dev server restart. |
| L4 | `SESSION_TTL_MS = 12h`, `SESSION_REMEMBER_TTL_MS = 30d` — long sessions | `lib/identity/core.js:218-219` | Consider shorter + sliding window. |
| L5 | No security headers on `/whatsapp/invoice/:token` PDF endpoint | `server.js:196-198` | Serves PDF inline; consider `Content-Disposition: attachment`. |
| L6 | `backup/download/:file` uses `path.basename` + prefix check — TOCTOU | `routes/api/core.js:414-418` | File could be replaced by symlink between check and `res.download`. |
| L7 | `export/:type` CSV generation does not escape formulas | `routes/api/core.js:351-357` | CSV injection if opened in Excel (`=`, `+`, `-`, `@` at start). |
| **L-N1** | **8 MB JSON body limit on `/api/v1/auth/*`** | `server.js:206` | Login accepts 8 MB JSON. Lower to 1 MB, raise only on photo-upload routes. |
| **L-N5** | **Duplicate error handler at end of chain** | `server.js:729-739, 761-768` | Second handler never runs (dead code). |
| **L-N7** | **`notifications.recipient_phone` stored as plaintext** | `lib/database.js:286-308` | Phone numbers not hashed. DB dump leaks all recipient phones. |
| **L-N12** | **`getUserRoles` issues 9 SELECTs per request** | `lib/identity/core.js:385-404` | No cache, no Redis. Performance concern under load. |

---

## 🐛 FUNCTIONAL BUGS

| # | Bug | Location | Effect |
|---|-----|----------|--------|
| B1 | `routes/api/settings.js` references undefined constants (`ALLOWED_DISCOUNT_IDS`, `FEET_PER_METER`, etc.) | `settings.js:122,124,128,130` | Discount save, geofence save, geofence check-in all crash (500). |
| B2 | `logActivity` is undefined in `apiUtils` (exported before definition) | `lib/apiUtils.js:99,102` | Member create, membership extend, activity logging all crash (500). |
| B3 | `routes/api/members.js` uses `FEET_PER_METER`, `inLatRange`, `inLonRange`, `isFiniteNum` from `api_stripped.js` | `members.js:542,559,565,568,582,599,610` | Geofence config & GPS check-in crash (500). |
| B4 | `routes/api/core.js` backup uses `fsModule` and `BACKUP_DIR` but imports from `api_stripped.js` | `core.js:378,391,416` | Backup create/list/download crash (500). |
| B5 | `routes/api_stripped.js` defines all the missing constants/functions but is NOT mounted in `routes/api.js` | `routes/api.js` | The "stripped" router is dead code; the constants it defines are unavailable to the active routers. |
| B6 | Onboarding `complete-setup` trial reset logic has `CASE WHEN onboarding_completed = 1` — but `onboarding_completed` is being SET TO 1 in the same query | `routes/api/core.js:49-58` | Trial end always reset to now+7d on every onboarding POST — infinite free trial. |
| B7 | `membershipEngine.extendEnd` / `computeEndDate` not visible — if they mishandle leap years / month boundaries, renewals corrupt | `lib/membershipEngine.js` | Date math bugs → wrong expiry, billing disputes. |
| B8 | `waAutomations.sendWelcomeInvoice` fire-and-forget with `.catch()` only logging | `routes/api/members.js:331-332` | Welcome WhatsApp fails silently; no retry, no alert. |
| B9 | `whatsappAutomations.runAutomationScansForAllTenants` uses in-process `scanRunning` guard — no DB advisory lock | `server.js:710-718` | Multi-instance (Render, K8s) → duplicate WhatsApp sends. |
| B10 | `razorpay` module (`lib/razorpay.js`) not reviewed — `isRazorpayConfigured`, `createOrder`, `verifyPaymentSignature` critical for billing | `lib/razorpay.js` | If misconfigured, payments silently fail or accept invalid signatures. |
| **B-N2** | **`submit-upi-payment` accepts `notes` (free-form) with no length cap** | `routes/api/billing.js:330-333` | 1 MB notes field fills the row. |
| **B-N3** | **`finance/collect` with `manual=true` still calls `createOrder`** | `routes/api/billing.js:494-512` | Creates orphaned Razorpay order, marks payment Successful without verification. |
| **B-N9** | **`create-order` uses `prices = { basic: 299, ... }` but `billingPlans.js` says `basic: 0`** | `routes/api/billing.js:165-198` | Contradiction: basic is free (per `FREE_TARGETS`), but `create-order` allows paying 299 for it. |
| **B-N14** | **Two parallel automation scan loops → double WhatsApp sends** | `server.js:702-721, 748-758` | In-process scan every 15 min + BullMQ scan every 5 min = double work on single instance. |
| **B-N15** | **`idempotency` middleware has no response body size cap** | `server.js:246-266` | 5 MB response cached in SQLite per `Idempotency-Key` → DoS. |

---

## 🏗️ ARCHITECTURAL / OPERATIONAL RISKS

| # | Risk | Detail |
|---|------|--------|
| A1 | Single SQLite file (`database.db`) — no WAL mode configured, no connection pooling | `lib/database.js:5-12` |
| A2 | No migrations system — schema changes via `ALTER TABLE` in `initializeDatabase()` | `lib/database.js:61-66, 133-143, 310-312` |
| A3 | All secrets in `.env` committed to repo | `.env` |
| A4 | No automated tests for auth/security flows | `tests/` only has `run.js` (integration) and `membershipEngine.test.js` |
| A5 | Desktop Electron serves frontend via loopback HTTP (port 0) — no TLS, cookies sent over plaintext localhost | `desktop/main.js` |
| A6 | No request size limit on `/api/v1/auth/*` (uses global 8mb) | `server.js:206` |
| A7 | No audit logging for admin actions (role assignment, plan changes, subscription overrides) | `activity_logs` table exists but not consistently used |
| A8 | Multi-tenancy relies solely on `tenant_id` in queries — no RLS, no row-level security in SQLite | All routes |
| A9 | WhatsApp Cloud webhook verification fails closed if `appSecret` not set | `controllers/whatsappCloud.controller.js:134` |
| A10 | `capacitor-env.js` baked at build time | `mobile/build-www.js` |
| **A-N13** | **Ollama endpoint hard-coded to `http://127.0.0.1:11434`** | `services/aiInsights.js:57-60` | Production on Render cannot use localhost → AI 500s on every request. No env override. |
| **A-N18** | **`whatsappCloud.service.js` not audited** | Referenced but not read | `getPublicStatus`, `verifyWebhookSignature`, `sendText` are highest-impact un-audited code. |
| **A-N19** | **`whatsappAutomations.js` not audited** | Referenced but not read | 4 workers, scan, festival, welcome-invoice, payment-due. |
| **A-N20** | **`services/whatsappSettings.js` not audited** | Referenced but not read | Per-gym toggles + templates. |
| **A-N22** | **`routes/member.js` (member self-service API) not audited** | Referenced but not read | |
| **A-N23** | **`routes/org.js` (organization graph) not audited** | Referenced but not read | |

---

## ✅ POSITIVES

- `core.authorize(...required)` re-validates permissions from the JWT on every request
- `idempotency_keys` table correctly dedupes retry storms
- `helmet.hsts` enabled only in production
- `express.json` mounted AFTER raw-body webhook routes (HMAC works)
- `app.disable('x-powered-by')` set
- `cors` properly scoped to allowlist (no wildcard)
- Password policy has denylist + email-local-part check + reuse check
- Refresh tokens rotated with theft-detection grace window
- `Idempotency-Key` scoped by `req.tenant_id` to prevent cross-tenant replay

---

## 📋 PRIORITY

1. **Fix B-N1** — duplicate `module.exports` in `lib/apiUtils.js` breaks `logActivity` + `resolveTemplate` across the entire API. One-file fix.
2. **Fix H-N1** — predictable subdomains on signup; user row may point to non-existent tenant.
3. **Fix M-N18 / B-N12** — add missing `provider_message_id` column to `notifications`; webhook delivery-status sync is dead.
4. **Fix B-N19** — `basic=0` vs `basic=299` disagreement; remove `basic` from `create-order`'s allowed list.
5. **Fix A-N13** — Ollama endpoint hard-coded localhost; AI 500s in production.
6. **Fix B-N14** — two parallel automation scan loops double-fire WhatsApp sends.
7. **Fix H-N9** — pending-role tokens can call check-in endpoint (no role check).
8. **Fix H-N8** — N+1 query storm in `/health/sync` (up to 5000 round-trips per request).
