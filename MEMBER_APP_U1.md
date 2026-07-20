# Gym Flow — Phase U1: Member App Foundation

Offline-first member application, sibling of the Admin app. Same design system,
same offline engine, separate surface. NO AI / Health Connect / wearables in this
phase — extension points only.

## Architecture decisions

1. **Single-shell app at `/member`** (`member_area_kinetic_enterprise/code.html`),
   hash-routed tabs (`#/home`, `#/workout`, `#/attendance`, `#/progress`,
   `#/profile`, `#/settings`). Reasons: `shellRedirectFor()` already confines r5
   tokens to `/member` (zero auth-surface change); tab switches are instant and
   never hit the network; one navigation entry to precache for offline cold-start.
2. **Reuses the F4A offline engine untouched in mechanism** — only *registrations*
   are added: `routeRegistry.js` read/write rules for `member_*` entities,
   `syncEngine.js` pull endpoints + a scope switch (`self.__GYM_APP_SCOPE__ =
   'member'`, set by the member page before the offline scripts load) so member
   sessions bootstrap member entities instead of admin ones. Admin behavior is
   byte-identical when the flag is absent.
3. **Server-authoritative boundaries kept**: auth, payments, subscription, org
   accept/reject/claim stay online-only (already in `ONLINE_ONLY`). No financial
   simulation.
4. **Member API is a separate router** `routes/member.js` mounted at
   `/api/v1/member` behind `authenticateToken + requireTenant + requireMemberRole`
   (new fail-closed middleware in `lib/identity/core.js`: `role_id === 'r5'`).
   Mounted BEFORE the staff `apiRouter` so it wins the `/api/v1/*` prefix. The
   staff API remains fully unreachable for member tokens (`requireStaffRole`).
   `member_id` is resolved server-side from `user_roles` — never from the client.
5. **Gym linking** reuses the F2 org platform: `/org/context` pending invitations
   + claims, accept/reject/dismiss endpoints. The "No Gym Linked" surface is the
   rebuilt `/member-coming-soon` page (where unlinked platform-members already
   land); after linking, `POST /auth/select-role` scopes into the r5 shell.
6. **Progress charts**: Chart.js CDN (same as Admin), fed from **local** repo
   data so charts render offline.

## New tables (database.js — all additive, indexed on tenant_id+member_id)

| table | purpose | notes |
|---|---|---|
| `workout_plans` | member/trainer plans | `exercises_json` doc-style (offline LWW-friendly), `created_by` 'member'/'staff', `trainer_notes` |
| `workout_sessions` | completed-workout history | `completed_json`, `total_volume_kg`, `duration_min` |
| `personal_records` | PR history | exercise, weight_kg, reps, achieved_on |
| `health_logs` | daily manual health | UNIQUE(tenant,member,log_date); weight/water/calories/protein — server upserts by date |
| `body_measurements` | measurement snapshots | chest/waist/hips/biceps/thigh cm |
| `member_goals` | profile goals | title, target_value, status |

## Member API surface (`/api/v1/member/*`)

Reads return flat arrays (offline entity-store shape). Writes validate + coerce;
tenant_id/member_id always from token context.

- `GET /overview` — gym, membership+plan+days left, trainer, streak, today
- `GET/POST /workouts`, `PUT/DELETE /workouts/:id`
- `GET/POST /sessions`
- `GET/POST /prs`, `DELETE /prs/:id`
- `GET /attendance` (own rows, last 365d)
- `GET/POST /health` (POST = upsert by log_date, absolute values)
- `GET/POST /measurements`, `DELETE /measurements/:id`
- `GET/POST /goals`, `PUT/DELETE /goals/:id`
- `GET /profile`

## Offline wiring

- routeRegistry: READ_RULES + WRITE_RULES + CONFLICT (lww / latest-edit-wins) +
  SYNC_POLICY for `member_workouts`, `member_sessions`, `member_prs`,
  `member_attendance`, `member_health`, `member_measurements`, `member_goals`.
  `/member/overview` + `/member/profile` ride the generic response cache.
- syncEngine: PULL_ENDPOINT additions; member-scope bootstrap/hot lists.
- repositories.js: `GymRepos.MemberSelf.*` façade for all member screens.
- Health-log optimistic dupes (same date offline) are merged client-side by
  `latest row per log_date`; server upsert + re-pull collapses them канonically.
- sw.js: precache `/member`, `/member-coming-soon`; navigation fallback routes
  `/member*` to the cached `/member` shell; `CACHE_VERSION` v2 → v3.

## Screens (all local-first render, skeleton → data, no API wait)

- **Home**: gym card (name/plan/days-left/trainer), today's workout, streak,
  water/weight/calories quick stats + quick log actions, expiry reminder,
  recent activity. Not-linked r5 edge case → link CTA.
- **Workout**: plan list + exercises (sets×reps×kg), tap-to-complete with rest
  timer, finish→`POST /sessions` (queued offline), history, PRs, trainer notes.
- **Attendance**: monthly calendar, 12-week heatmap, streak, history + times.
  (GPS module plugs in here later — check-in stays staff/QR-side in U1.)
- **Progress**: Chart.js — weight, attendance/week, workout consistency,
  measurements, PR progression, water, calories. All from local data.
- **Profile**: identity card, membership, trainer, gym, goals CRUD, connected /
  offline / storage status, future-AI placeholder chip.
- **Settings** (member-specific, NOT admin's): theme dark/light/system
  (`APP_CONFIG.setTheme`), notification prefs (local), offline controls
  (sync status, pending count, storage usage, purge local data), privacy
  (`/security`), account + logout, disabled placeholders for AI/wearables.

## Extension points (architecture only, no implementation)

`window.GymMemberExt` registry: `registerHealthSource()` (Health Connect /
wearables later), `registerAttendanceProvider()` (GPS later), `aiStatus`
placeholder. Health module reads sources through this registry; today only the
manual source exists.

## Verification (failable checks)

1. `npm test` — existing 66 checks stay green + new `[Member API]` section:
   member login → overview/health/workout/session CRUD 200; staff API 403 for
   member token; member API 403 for staff token; tenant/member scoping asserted.
2. Preview at 375px: every tab renders offline (network cut) from IndexedDB.
3. Write offline → outbox queued → reconnect → row lands server-side.
4. Admin pages: untouched behavior (smoke + tests).
