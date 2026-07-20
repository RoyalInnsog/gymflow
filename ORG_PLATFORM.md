# GYM Flow — Organization & Identity Graph Platform (F2)

Date: 2026-07-04. Builds on the F1 Identity Platform (see [IDENTITY_PLATFORM.md](IDENTITY_PLATFORM.md)).
**Scope:** the relationship engine between accounts, organizations, roles, permissions,
staff invitations, and member claims — plus foundation-only schema for custom roles,
franchises/branches and GPS. **Non-goals (this pass):** rebuilding auth/login, building
attendance, building the full member app. Everything is an additive extension.

Guiding constraint, same as F1: **zero regression, zero forced logout, zero data loss.**
The existing 46-check suite must stay green after every milestone.

---

## 1. Architecture audit — what already exists

The single most important finding: **most of the "organization graph" already exists,
just not by these names.**

| Prompt concept | Already implemented as | Gap to close |
|---|---|---|
| Organization | `tenants` table | needs no new table; add nothing structural |
| OrganizationMembers | `user_roles` (user_id, tenant_id, role_id, member_id) | no lifecycle (status/invited_by/joined_at); treated as pure junction |
| Roles | `roles` (id, name, permissions JSON) — global r1–r5 | roles are **global**, permissions are a **JSON blob** → no custom per-org roles, not individually assignable |
| Permissions (RBAC) | `authorize(...required)` reads `req.user.permissions` (flat array in JWT), `'all'` = wildcard | works, but the array is derived from the JSON blob; no catalog, no assignment table |
| Member↔account link | `user_roles.member_id` (placeholder, always NULL today) | no claim flow writes it |
| Members | `members` (tenant_id, full_name, phone, email, status, …) — **no user_id** | account link is via `user_roles.member_id`, unused |
| Staff | `staff` (tenant_id, user_id, name, role, email, phone, salary…) — HR record | separate from access (`user_roles`); not auto-created on role grant |
| Branches/franchise | `branches` (tenant_id, name, manager_id…) exists | unused; fine as future-branch foundation |
| Org switching | `POST /auth/select-role` (F1) re-scopes the token | **already done** — the switcher is a UI over this |

### Existing issues (confirmed in code)
1. **RBAC is not database-driven.** `roles.permissions` is a JSON blob parsed at token-sign time (`getUserRoles` → `signScopedToken`). Permissions can't be individually assigned and there are no custom roles. — *routes/api.js:27 `authorize`, lib/identity/core.js `getUserRoles`/`signScopedToken`.*
2. **Roles are global, not org-scoped.** All tenants share r1–r5. An owner can't create a gym-specific role.
3. **`user_roles` has no membership lifecycle.** No suspend/leave/invited state, no `invited_by`, no join timestamp, no history — so "suspend a manager", "ownership transfer", "membership history" have nowhere to live.
4. **No staff invitation.** Staff are added as HR rows (`POST /staff`) with no account link and no invite/accept handshake.
5. **No member claim.** `members` and `users` are unlinked; `user_roles.member_id` is a dead placeholder. A member who signs in is a brand-new owner of an empty gym, not linked to their profile.
6. **No org-level audit.** `security_events` (F1) is account-level; there's no per-organization audit of role changes, invites, claims.

---

## 2. Target architecture — the graph

```
account (users)                                  ← F1, global identity
  └── organization membership (user_roles*)      ← extended with lifecycle
        ├── organization (tenants)               ← "organization" = tenant
        ├── role (roles*)                         ← now org-scoped-capable + custom
        │     └── permissions (role_permissions → permissions catalog)   ← DB-driven RBAC
        ├── linked member profile (members via user_roles.member_id)     ← member claim writes this
        └── (future) branch (branches)            ← franchise/multi-branch foundation

invitations ─────► accept ─────► user_roles row (+ staff HR row)   ← staff onboarding handshake
members ─┐
accounts ─┴─► claim match (email/phone) ─► member_claims ─► accept ─► user_roles.member_id  ← member claim
membership_history / org_audit_logs                              ← forensics for both
geofences (schema only)                                          ← GPS foundation, no logic
```

`*` = extended in place, not replaced.

**Lead decision (consistency):** `user_roles` **is** OrganizationMembers. Creating a
parallel `organization_members` table would fork the source of truth that F1's
`getUserRoles`, `requireStaffRole`, and `/select-role` all depend on. We extend it.

---

## 3. Database design (all additive; no destructive migration)

**Extend `roles`:** `+ tenant_id TEXT` (NULL = global system role; non-NULL = custom
org role), `+ is_system INTEGER DEFAULT 0`, `+ description TEXT`. Drop the `name UNIQUE`
constraint conceptually by keying custom roles per tenant (system roles keep unique ids
r1–r5; custom roles get generated ids). *SQLite can't drop a column constraint without a
rebuild; the existing UNIQUE(name) stays and custom role names are stored as
`"<tenant> · <name>"`-free by using unique ids — names are not the key.*

**Extend `user_roles`:** `+ status TEXT DEFAULT 'active'` (active|suspended|left|invited),
`+ invited_by TEXT`, `+ joined_at DATETIME`, `+ suspended_at DATETIME`, `+ left_at DATETIME`.
`getUserRoles` filters to `status='active'` so suspended/left memberships grant no access.

**New tables:**
- **permissions** — catalog: `key` PK, `label`, `category`, `description`, `is_system`.
- **role_permissions** — `role_id`, `permission_key`, UNIQUE(role_id, permission_key). The
  DB-driven RBAC join. `resolvePermissions(roleId)` reads this; `'all'` stays a wildcard key.
- **invitations** — `id`, `tenant_id`, `email`(normalized), `role_id`, `token_hash`,
  `status`(pending|accepted|rejected|revoked|expired), `invited_by`, `accepted_by_user_id`,
  `expires_at`(7d), `created_at`, `decided_at`. UNIQUE(tenant_id, email) WHERE pending
  (enforced in code — SQLite partial-unique via app check).
- **member_claims** — `id`, `tenant_id`, `member_id`, `user_id`, `status`(pending|accepted|rejected|cancelled),
  `match_basis`(email|phone|both), `confidence`(high|medium), `created_at`, `decided_at`,
  `decided_by`. UNIQUE(tenant_id, member_id, user_id).
- **claim_history** — `id`, `claim_id`, `action`, `actor_user_id`, `meta`, `created_at`.
- **membership_history** — `id`, `tenant_id`, `user_id`, `action`(invited|joined|role_changed|
  suspended|reactivated|left|removed|ownership_transferred), `from_role`, `to_role`,
  `actor_user_id`, `meta`, `created_at`.
- **org_audit_logs** — `id`, `tenant_id`, `actor_user_id`, `action`, `target_type`,
  `target_id`, `meta`, `ip`, `created_at`. Org-scoped audit (distinct from account-level
  `security_events`).
- **geofences** — `id`, `tenant_id`, `branch_id`, `name`, `latitude`, `longitude`,
  `radius_m`, `enabled`, `anti_spoof_enabled`, `created_at`. **Schema only — no logic.**
  GPS/attendance foundation; documented as inert.

**Backfill migrations (idempotent, at boot):**
1. Seed `permissions` catalog (curated labels/categories) **∪** every string found in
   existing `roles.permissions` JSON — the union guarantees the catalog is complete.
2. Populate `role_permissions` from each role's parsed `permissions` JSON — so
   `resolvePermissions` reproduces today's JWT array **exactly**. This is what makes the
   RBAC swap provably non-regressive.
3. Backfill `user_roles.status='active'`, `joined_at=created_at` for existing rows.

## 4. Permission model
`resolvePermissions(roleId)` = `SELECT permission_key FROM role_permissions WHERE role_id=?`;
if empty (a role the backfill hasn't touched), fall back to parsing `roles.permissions` JSON.
Owner keeps `'all'`. `getUserRoles`/`signScopedToken` call this instead of parsing JSON, so
**the JWT `permissions` array and every `authorize()` call site are unchanged** — only the
source of truth moved from a blob to a table. Custom roles: `POST /org/roles` creates a
tenant-scoped role; `PUT /org/roles/:id/permissions` assigns from the catalog. New
capability keys (`staff:invite`, `roles:manage`, `members:claim:approve`, `org:manage`) are
added to the catalog and granted to Owner (who also matches via `'all'`).

## 5. Invitation architecture
Owner/manager `POST /org/invitations {email, role_id}` → hashed token, 7-day expiry,
`status=pending`, one pending invite per (org,email). Detection: on login, `/org/context`
returns pending invitations where `email = account's verified email`. Accept →
`user_roles` row (status active, invited_by) **if none exists** (no duplicate) + a minimal
`staff` HR row if none exists + `membership_history(invited→joined)` + invite marked
accepted. Reject → invite `rejected`. Expired/revoked/already-accepted all return distinct,
actionable states. Server re-validates the invite belongs to the account's email — the
client never asserts which org/role it's joining.

## 6. Member-claim architecture
On login, `/org/context` computes **candidate matches**: `members` rows whose
`email = account.email` OR `phone = account.phone`, in orgs the account is **not already a
member of**, with **no existing claim** (pending/rejected/accepted) for this (member,user).
Confidence: both email+phone → `high`; single field → `medium`. Prompt "Do you belong to
this gym?" → **YES**: high-confidence auto-links (user-confirmed, not silent) by writing an
r5 Member `user_roles` row with `member_id` set + `member_claims(accepted)`; medium-confidence
creates `member_claims(pending)` for **manual admin approval** (`POST /org/claims/:id/approve`).
**NOT NOW** → `member_claims(rejected)` so we don't re-prompt. Never silently merge; never
duplicate (UNIQUE(tenant,member,user) + "already linked" guard). Member lifecycle
(Prospect→Added→ClaimPending→ClaimAccepted→Active→Expired→Renewed→Archived) is expressible
from `members.status` + `member_claims.status` + `memberships` end dates — no rigid state
machine imposed.

## 7. API design (`/api/v1/org`, mounted account-level like `/api/v1/auth`)
Account-level (auth only): `GET /context`, `GET /organizations`,
`GET /invitations/pending`, `POST /invitations/:id/accept`, `POST /invitations/:id/reject`,
`GET /claims/pending`, `POST /claims/:id/accept`, `POST /claims/:id/reject`.
Org-admin (auth + tenant + permission): `GET/POST /invitations`, `DELETE /invitations/:id`,
`GET /members`, `PATCH /members/:userId/role`, `POST /members/:userId/suspend|reactivate`,
`DELETE /members/:userId`, `POST /ownership/transfer`, `GET /roles`, `POST /roles`,
`PUT /roles/:id/permissions`, `GET /permissions`, `GET /claims`, `POST /claims/:id/approve|reject`.
Org **switch** reuses `POST /auth/select-role` (F1) — not duplicated. Errors:
`{ error, code }` (`INVITE_EXPIRED`, `INVITE_WRONG_EMAIL`, `ALREADY_MEMBER`, `CLAIM_TAKEN`,
`LAST_OWNER`, `PERMISSION_DENIED`…).

## 8. Frontend flows
- **Org switcher**: shell header control listing `organizations` from `/org/context`,
  switching via `/auth/select-role`; full picker stays at `/select-role`.
- **Pending banners**: shell mounts a banner (top, below header) when `/org/context` has
  pending invitations or claims → links to the acceptance/confirmation UI.
- **Invitation acceptance** + **Claim confirmation**: new page `/join` handling both
  (invites list with Accept/Reject; claim cards "Do you belong to this gym? Yes / Not now").
- **Placeholders**: reusable states for permission-denied, no-organization, no-linked-member,
  and coming-soon (custom roles, branches, GPS) — native to the design system.
- Do **not** build the member app; only routing + placeholders.

## 9. Migration strategy
All schema is `ALTER … ADD COLUMN` / `CREATE TABLE IF NOT EXISTS` + idempotent backfills.
RBAC backfill reproduces the exact current permission arrays. Existing tokens keep working
(permissions still ride in the JWT). No endpoint signature changes. `select-role`, staff
page, add-member all unchanged. Existing admins see zero difference until they use the new
invite/claim/switcher features.

## 10. Security review
Server-authoritative throughout: invitations validated against the account's verified email;
claims validated against real member email/phone matches with confidence gating and manual
approval for medium confidence; role/permission changes and ownership transfer require the
actor's permission and can't remove the last owner; all org-admin routes re-check
`tenant_id` ownership so one org can't act on another. RBAC is enforced from the DB-derived
JWT array (unchanged `authorize`), never from client claims. Org-admin mutations write
`org_audit_logs`.

## 11. Implementation stages (each keeps the app working)
1. Schema + migrations → boot clean, 46-check suite green.
2. `lib/org/permissions.js` (RBAC resolution) wired into `getUserRoles` → suite green (proves no regression).
3. `lib/org/{invitations,claims,membership}.js` services → node smoke.
4. `routes/org.js` + `/org/context`; login-time detection → endpoint checks.
5. Frontend: `/join` page + shell switcher/banner + placeholders (delegated build) → jscheck + serve.
6. `[Org]` test section (invite→accept no-dup, claim→link no-dup, permission enforce, suspend, ownership transfer) → suite green.

## 12–13. Implementation & validation
Implemented incrementally below; validated by an extended `tests/run.js` plus live smoke.
