# GYM Flow Identity Platform — Architecture, Audit & Implementation Plan

Date: 2026-07-04. Scope: global identity, authentication, sessions, verification,
provider linking, recovery, and the security UX for the multi-tenant gym SaaS.
Constraint honored throughout: this is an **upgrade path**, not a rip-and-replace —
existing users, cookies and tokens keep working while the platform underneath is replaced.

---

## 1. Audit of the current implementation

### What already exists and is sound (kept)
- JWT (HS256) in an httpOnly `SameSite=Lax` cookie, `Secure` in production; strong-secret boot check.
- bcrypt password hashing; timing-equalized login with decoy hash (anti-enumeration).
- One-time email-verification / reset tokens stored **hashed** (sha256) at rest.
- Enumeration-safe forgot-password / resend-verification (always-200).
- Per-IP+route in-memory rate limiter with success refund; separate non-refunding limiter design.
- CSRF Origin/Referer verification for state-changing requests; CORS allow-list; CSP; HSTS; static-root lockdown.
- Server-side role spine: `user_roles` junction, scoped vs pending tokens, fail-closed `requireStaffRole`.
- jti revocation list honored by `authenticateToken` (logout actually revokes).
- Google OAuth code flow with `state` cookie.

### Confirmed defects (each verified in code)
| # | Severity | Issue | Impact |
|---|----------|-------|--------|
| A1 | **High** | `normalizeEmail()` (server.js:252) is defined but **never called**. Login/signup/forgot/resend all match raw case-sensitive email; Google lowercases. | `Foo@Bar.com` (password signup) + `foo@bar.com` (Google) forks **duplicate accounts** — violates the one-human-one-account invariant. Case-typo lockouts. |
| A2 | **High** | Google callback suspension check uses `&&` (server.js:890): `!is_active && status !== 'active'`. `isAccountActive()` exists but is only used by select-role. | A suspended account (`status='suspended'`, `is_active=1`) can still sign in via Google. |
| A3 | **High** | No session store. Sessions are stateless JWTs; revocation list is in-memory only. | No "view active sessions", no logout-other-devices, revocations lost on restart, a stolen 30-day remember-me token is irrevocable in practice. |
| A4 | **High** | Password reset does **not** invalidate existing sessions. | An attacker with a live session survives the victim's password reset. |
| A5 | Medium | Email verification token has **no expiry** and lives on the users row (single slot). | Old links work forever; a resend silently invalidates the previous link with no audit trail. |
| A6 | Medium | No provider records. Google linking is implicit by email match; Google-provisioned accounts get a random bcrypt password. | Nothing to show/unlink in UI; no `sub`-based lookup (breaks if user changes their Google email); "set a password" (Case 4) only possible via the forgot-password side door. |
| A7 | Medium | No account lockout / failed-attempt tracking; rate limit is per-IP only. | Distributed credential-stuffing against one account is unthrottled across IPs. |
| A8 | Medium | No security/audit events (logins, resets, changes) and no new-device detection or alerts. | No forensics, no user-visible history, silent account takeover. |
| A9 | Medium | No change-password, set-password, or change-email endpoint exists at all. | Core account-lifecycle cases (4, 5) unimplemented. |
| A10 | Medium | Phone is captured but never verified (no OTP anywhere); `/auth/phone` is add-once plaintext. | Phone can't serve as a verification/recovery factor as specified. |
| A11 | Low | `id = 'u_' + Date.now()` (and tenant ids) — collision-prone under concurrency. | Duplicate-key failures at scale. |
| A12 | Low | Tenant row inserted before user row without a transaction. | Orphan tenants if the user insert fails. |
| A13 | Low | Auth endpoints (~450 lines) and 15 helpers live inside server.js. | Monolith; every identity change risks the whole file. |

### Frontend audit (from parallel page audit)
- Good: httpOnly-cookie only (no tokens in localStorage), shared form engine (strength meter, caps-lock, show/hide), `credentials:'include'` centralized in `api.js`.
- Gaps: no 429/lockout feedback; no loading states on forgot/reset; password-match rule duplicated in 3 places; no session-expiry recovery (401 → silent failure); no security/sessions UI anywhere; no phone-OTP UI.

---

## 2. Target architecture

```
One human ──► users (global account, tenant-independent)
                ├── identity_providers   (google …; password = users.password_set)
                ├── user_roles ──► tenants (many gyms, many roles)   [exists, kept]
                ├── auth_sessions        (device-bound, refresh-rotated, revocable)
                ├── trusted_devices      (long-lived device recognition)
                ├── email_verifications  (signup + change-email, expiring, single-use)
                ├── password_reset_tokens(expiring, single-use, audited)
                ├── phone_verifications  (OTP, attempt-capped)
                ├── password_history     (reuse prevention)
                └── security_events      (audit trail + lockout source)
```

Module layout (new):
- `lib/identity/core.js` — JWT sign/verify, cookies, middleware, role spine, normalizers, ids, rate-limiter factory.
- `lib/identity/sessions.js` — session create/rotate/refresh/revoke/list, trusted devices, UA parsing.
- `lib/identity/account.js` — email verification, password reset/change/policy/history, phone OTP, provider linking.
- `lib/identity/events.js` — security events, failed-login tracking, lockout decision.
- `routes/auth.js` — every `/api/v1/auth/*` endpoint.
- `server.js` — pages, webhook, mounting only (auth logic removed).

## 3. Database design (additive; no destructive migration)

New tables (all `TEXT` ids from `crypto.randomBytes`, FKs `ON DELETE CASCADE` to users):

- **auth_sessions**: `id(sid)`, `user_id`, `refresh_hash`, `refresh_prev_hash`, `rotated_at`, `jti`,
  `remember`, `browser`, `os`, `device_label`, `ip`, `user_agent`, `created_at`, `last_active`,
  `expires_at`, `revoked_at`, `revoke_reason`. Indexes: user_id, refresh_hash.
- **identity_providers**: `user_id`, `provider`, `provider_uid`(google `sub`), `email`,
  `created_at`, `last_used_at`. UNIQUE(provider, provider_uid), UNIQUE(user_id, provider).
- **email_verifications**: `user_id`, `email`(address being proven — the *new* one for changes),
  `purpose`('signup'|'change'), `token_hash`, `expires_at`(24 h), `used_at`. Index token_hash.
- **password_reset_tokens**: `user_id`, `token_hash`, `expires_at`(1 h), `used_at`. Index token_hash.
- **phone_verifications**: `user_id`, `phone`, `otp_hash`, `attempts`, `expires_at`(10 min), `verified_at`.
- **trusted_devices**: `user_id`, `token_hash`(httpOnly device cookie, 400 d), `browser`, `os`,
  `first_ip`, `last_seen`, `revoked_at`. UNIQUE(user_id, token_hash).
- **security_events**: `user_id?`, `email?`(for pre-auth failures), `event`, `ip`, `user_agent`,
  `meta`(JSON), `created_at`. Indexes (user_id, created_at), (email, created_at) — the lockout window query.
- **password_history**: `user_id`, `password_hash`, `created_at`.

users additions: `phone_verified_at DATETIME`, `password_set INTEGER DEFAULT 1`,
`password_changed_at DATETIME`. New Google-provisioned accounts get `password_hash = NULL, password_set = 0`
(login treats NULL as decoy-compare → generic 401). Legacy columns
(`verification_token`, `reset_token`, `token_expiry`) stay readable as fallback until drained.

Migrations at boot: lowercase-normalize existing emails (collision-guarded, logged),
backfill `password_set = 1`.

## 4. API design (`/api/v1/auth`)

Kept (upgraded in place, same paths/payloads): `POST login`, `POST signup`, `GET verify-email`,
`POST resend-verification`, `POST forgot-password`, `POST reset-password`, `POST logout`,
`POST select-role`, `POST phone`(legacy add-once), `GET config`, `GET google`, `GET google/callback`, `GET session`.

New:
| Endpoint | Auth | Purpose |
|---|---|---|
| `POST /refresh` | refresh cookie | Rotate refresh token, mint new access JWT. 401 on invalid/reused. |
| `POST /logout-all` | ✓ | Revoke every session of the account. |
| `GET /sessions` | ✓ | List active sessions (`current` flagged). |
| `DELETE /sessions/:id` | ✓ | Revoke one session (owner-scoped). |
| `GET /devices` / `DELETE /devices/:id` | ✓ | Trusted devices list / forget. |
| `GET /security` | ✓ | One-call summary: verified flags, password_set, providers, recent security events. |
| `POST /change-password` | ✓ | Requires current password; history check; revokes other sessions. |
| `POST /set-password` | ✓ | Only when `password_set=0` (Google-only account → Case 4). |
| `POST /change-email` | ✓ | Requires current password when set; sends verify link to the NEW address (Case 5). |
| `POST /phone/request-otp` | ✓ | 6-digit OTP, 10 min, 60 s cooldown, 5/day; pluggable transport (dev: console + devCode). |
| `POST /phone/verify-otp` | ✓ | ≤5 attempts; sets phone + `phone_verified_at`. |
| `GET /google?intent=link` | ✓ | OAuth round-trip that links Google to the **current** account. |
| `DELETE /providers/google` | ✓ | Unlink; refused unless a password is set (never strand the account). |

Error contract: every failure returns `{ error, code? }` with stable codes the UI can branch on
(`TOKEN_EXPIRED`, `ALREADY_VERIFIED`, `OTP_EXPIRED`, `OTP_ATTEMPTS`, `LOCKED`, `PASSWORD_REUSE`,
`GOOGLE_IN_USE`, `LAST_LOGIN_METHOD`…). Enumeration-sensitive endpoints keep single generic responses.

## 5. Session design

Hybrid stateless/stateful (Clerk-style, sized for this deployment):
- **Access token**: JWT cookie `auth_token` (unchanged name — zero client breakage), now carries `sid`;
  TTL **1 h** (was 8 h/30 d). Verified statelessly per request; in-memory revoked-sid/jti check.
- **Refresh token**: 256-bit opaque, sha256-hashed on the session row, httpOnly cookie
  `refresh_token`, rotated **on every use**. Previous hash kept for a 30 s concurrency grace window;
  presentation of a rotated-out token ⇒ theft signal ⇒ whole session revoked + security event.
- **Session row** absolute expiry: remember-me 30 d, otherwise 12 h. `last_active` updated on refresh.
- Page routes perform **inline refresh** (expired access + valid refresh ⇒ rotate, set cookies, serve page);
  `api.js` retries once through `POST /refresh` on 401 — so shorter access TTLs cost the user nothing.
- Logout revokes the session row + jti; logout-all revokes all rows; password reset/change revoke sessions (A4 fixed).
- **Legacy tokens** (no `sid`) stay accepted until natural expiry — nobody is force-logged-out by the upgrade.
- Restart exposure: in-memory deny-list loss is bounded by the 1 h access TTL; refresh always hits the DB.

## 6. Security design (delta over what exists)

- Account lockout: ≥8 failed logins for one email in 15 min (any IP — counted in `security_events`)
  ⇒ 429 with the same generic copy as the IP limiter (no enumeration signal).
- New-device detection: per-device httpOnly cookie → `trusted_devices`; unrecognized device on login
  ⇒ security event + alert email (when email is configured).
- Password policy: ≥8 chars + top-common-password denylist + must not contain the email local part;
  history check blocks reuse of the last 3.
- All lifecycle changes (password/email/provider/phone) emit security events; sensitive ones also
  send best-effort notification email to the (old) address.
- Google: lookup order `sub` → normalized email; linking only when Google asserts `email_verified`;
  `isAccountActive()` enforced (A2 fixed); provider rows give unlink + audit.
- Everything else (CSP, CSRF origin check, hashed one-time tokens, decoy compare, cookie flags) retained.

## 7. Provider linking strategy
`identity_providers` keyed by (provider, provider_uid). Password is a capability flag
(`users.password_set`), not a row. Adding Apple/Microsoft later = new provider constant + OAuth
handler; account resolution, linking, unlink-safety and UI are already generic.
Unlink is refused if it would leave zero login methods.

## 8. Verification strategy
Email: single-use hashed tokens in `email_verifications` with 24 h expiry + purposes
(`signup`, `change`); resend invalidates predecessors; `ALREADY_VERIFIED` and `TOKEN_EXPIRED`
are distinct, actionable UI states. Phone: OTP as specified in §4 — phone is **never** a login credential.

## 9. Recovery strategy
- Lost password → reset flow (single-use, 1 h, revokes all sessions, notifies).
- Google unavailable → set-password path exists (Case 4), or reset flow via email.
- Lost email access → change-email requires the password + proof of the new inbox; the old inbox is notified.
- Phone unavailable → phone is never required to sign in, so recovery = email/Google; changing a verified
  phone re-runs OTP on the new number behind a fresh-password check.

## 10. UX plan
- New **Security Center** page (`/security`): active sessions (revoke / logout-all), linked login
  methods (Google link/unlink, set/change password), email & phone verification state + actions,
  trusted devices, recent security activity. Mobile-first, design-system native.
- Login: 429/lockout copy, `verificationRequired` → inline resend, session-expired banner.
- Forgot/reset: loading states brought up to login-page standard; expired-token → direct resend CTA.
- Verify-email page: handles `signup` and `change` purposes, expired/used states.

## 11. Implementation stages
1. Schema + migrations (database.js) — boot clean on existing DB. ✅ check: server boots, tables exist.
2. `lib/identity/*` services. ✅ check: unit-exercised via endpoints.
3. `routes/auth.js` port + upgrades; slim server.js. ✅ check: existing 18-check suite still green.
4. emailService additions (security alerts, change-email). ✅ check: email_logs rows in dev mode.
5. Frontend: api.js refresh-retry; login/forgot/reset/verify page fixes; Security Center page (built in parallel by a delegated agent against §4 contract). ✅ check: mobile-viewport walkthrough.
6. New `[Identity]` test section in tests/run.js (sessions, rotation, reuse-detection, lockout, change flows). ✅ check: suite green.

## 12. Compatibility & migration notes
- Cookie name, login/signup payloads, and redirect contract unchanged — existing pages and the
  Android WebView keep working untouched.
- Legacy JWTs accepted until expiry; legacy verification/reset tokens honored as fallback until drained.
- In-memory limiter/deny-list remain single-instance scoped (matches the single-instance Render deploy);
  the session/refresh layer is DB-backed, so a future multi-instance move only needs a shared cache for
  the fast-path deny-list.
