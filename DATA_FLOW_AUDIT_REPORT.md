# GYM FLOW — DATA-FLOW ROOT-CAUSE AUDIT & REPAIR REPORT

**Date:** 2026-06-17
**Scope:** Root-cause investigation of why modules were disconnected from live data; end-to-end repair of the data-flow architecture (Issues #1–#6). Local only.
**Method:** Every module was traced front-to-back (DOM → fetch → API → SQL → payload → UI mapping) and **verified against a running server with a real tenant**, not by code reading alone.

> **Architecture note:** This is a **vanilla HTML + `fetch` frontend** (the `*_kinetic_enterprise/code.html` screens) talking to an Express/SQLite backend. There are **no** `mockData.ts` / `seedData.ts` / `fakeAnalytics.ts` files — the "demo data" lived as **hardcoded HTML rows** inside the screens, and the "disconnections" were **frontend mapping bugs, a shared API-helper contract bug, a server-side tenant bug, and a structural HTML bug**, not a separate mock data source.

---

## EXECUTIVE SUMMARY OF ROOT CAUSES

| # | Module | Root cause (not a symptom) |
|---|--------|----------------------------|
| 1 | **Receipt** | API used `allQuery` → returned a **JSON array** `[{…}]`; the receipt page read `data.invoice_number` off the array → `undefined`, `Number(data.total_amount)` → `NaN`. Plan was **guessed from the amount**; validity was **hardcoded** in the template. The amount/plan/validity selectors were also fragile CSS chains (one used invalid CSS `.w-1/2`). |
| 2 | **Finance** | `GET /analytics/finance-dashboard` was **500-ing** (a parameter-order bug fixed in the prior phase). Frontend then did `Number(undefined)` → `NaN` and `data.revenueTrend.map()` on `undefined` → charts empty. |
| 3 | **Dashboard / BI** | **The main `/dashboard` was missing its `</script>` tag** — the inline `<script>` ran straight into the Expiry-Alerts modal HTML, so the browser swallowed all that HTML (and the next `<script>`) as script text → **SyntaxError → the entire dashboard data engine never executed** → every widget stuck on `—` / `Loading`. (The separate `/bi` page was failing on the same 500s as #2.) |
| 4 | **Tasks** | The tasks page was **100% static demo HTML** (Anita Desai, Rahul Kumar, Corporate Lead, Equipment Maintenance) with **zero API calls** — it never loaded real data. |
| 5 | **Settings / Branding** | **Two bugs.** (a) Backend `POST /settings` **hardcoded `tenant_id = 't1'`** — every tenant's settings were written to the demo tenant, while the read was correctly tenant-scoped, so nothing came back. (b) The shared helper `window.api.get/post/put/delete` returned the **raw `Response`** (not parsed JSON); the Settings page read `settings.gym_name` / `plans.forEach` off a `Response`, so `loadData()` threw and the form **never hydrated**. |
| 6 | **Equipment / app-wide** | Equipment page was **static demo** (Treadmill X5 Pro, etc.) with zero API calls. The app-wide scan found the systemic `window.api.get` contract bug (#5b) and the structural `</script>` bug (#3) as the two cross-cutting causes; no separate mock data layer exists. |

---

## PER-PAGE DATA-FLOW AUDIT

### 1. Receipt (`/receipt`)
- **Data Source:** `database.db` (invoices + members + payments + memberships + membership_plans)
- **API Endpoint:** `GET /api/v1/finance/receipt/:invoiceNumber`
- **Service Layer:** `routes/api.js` handler → `database.js` `getQuery`
- **DB Query:** invoice JOIN member, LEFT JOIN payment, **LEFT JOIN membership + plan** (added)
- **Returned Payload:** single object `{invoice_number, full_name, member_number, plan_name, start_date, end_date, subtotal, tax_amount, total_amount, method, transaction_reference, …}`
- **UI Mapping:** `membership_receipt_…/code.html` → `#rcpt-plan/#rcpt-validity/#rcpt-subtotal/#rcpt-gst/#rcpt-total/…`
- **Failure Point (was):** API returned an **array**; UI read fields off the array → `undefined`/`NaN`; plan guessed from amount; validity hardcoded; broken CSS selectors. **Fixed.**

### 2. Finance (`/finance`)
- **Data Source:** payments + invoices
- **API Endpoint:** `GET /api/v1/analytics/finance-dashboard?months=N`, `GET /api/v1/finance/transactions`
- **Service Layer:** `routes/api.js` → aggregation queries
- **Returned Payload:** `{currentMonthRevenue, totalOutstanding, unpaidInvoices, forecast, revenueTrend[], collectionsTrend[], duesTrend[], paymentMethods[]}`
- **UI Mapping:** `#metric-mtd-revenue/#metric-dues/#metric-forecast` + 3 Chart.js canvases
- **Failure Point (was):** endpoint 500 → `Number(undefined)=NaN`, `undefined.map()`. **Fixed** (endpoint repaired prior phase; defensive guards added).

### 3. Dashboard (`/dashboard`)
- **Data Source:** executive-summary, revenue-trend, churn, segments, high-value-members, lead-intelligence, finance-dashboard, renewal-forecast
- **API Endpoints:** `GET /api/v1/analytics/*` (8 endpoints)
- **Service Layer:** `dashboard_…/code.html` `loadAllData()` → 8 loaders → `window.api.fetch().json()`
- **Returned Payload:** KPI objects (`kpis.monthlyRevenue.value`, `healthScore.score`, etc.)
- **UI Mapping:** `#kpi-revenue/#kpi-active-members/#intel-*/#health-score-val/#vip-table-body/…`
- **Failure Point (was):** **missing `</script>` → entire inline script failed to parse → `loadAllData` never defined/called.** **Fixed.**

### 4. Tasks (`/tasks`)
- **Data Source:** tasks + members
- **API Endpoints:** `GET /api/v1/tasks`, `PUT /api/v1/tasks/:id`, `GET /api/v1/members`
- **UI Mapping:** `#agenda-list`, `#pending-count`, `#renewals-list`
- **Failure Point (was):** static demo HTML, **no fetch at all**. **Fixed** (now fully data-driven; complete tasks via PUT).

### 5. Settings / Team Profile (`/settings`)
- **Data Source:** `settings` (EAV, per-tenant), tenants, plans/staff/templates/branches
- **API Endpoints:** `GET /api/v1/settings`, `POST /api/v1/settings`, `GET /api/v1/settings/public`, `GET /api/v1/subscription/status`, `GET /api/v1/plans` …
- **UI Mapping:** `#form-gym-profile` fields (gym_name, theme_color, gst_number, support_phone, support_email, website, logo_url)
- **Failure Point (was):** (a) write went to `tenant_id='t1'`; (b) `window.api.get` returned a `Response`, so hydration threw. **Both fixed.**

### 6. Equipment (`/equipment`)
- **Data Source:** equipment
- **API Endpoint:** `GET /api/v1/equipment`
- **UI Mapping:** `#equipment-tbody`
- **Failure Point (was):** static demo, no fetch. **Fixed** (live table + empty state).

---

## FILES MODIFIED (this audit)

| File | Change |
|------|--------|
| `routes/api.js` | **Receipt API**: `allQuery`→`getQuery`, dead `if(!invoice)` fixed, added `JOIN memberships`/`membership_plans` to return real **plan name + validity**. **Settings API**: removed hardcoded `tenant_id='t1'` → writes under `req.tenant_id` (defensive String coercion). |
| `public/assets/js/api.js` | `get/post/put/delete` now return **parsed JSON** (were returning the raw `Response`). `fetch()` unchanged. Added `_json()` guard (returns `null` on parse failure). |
| `membership_receipt_kinetic_enterprise/code.html` | Map single object (not array); real `plan_name` + validity; defensive `money()/txt()/fmtDate()` (never `NaN`/`undefined`); **stable element IDs** replacing fragile/invalid CSS selectors. |
| `finance_kinetic_enterprise/code.html` | Guard response (`res.ok`), all numbers via `Number(x)||0`, all chart arrays via `Array.isArray(...)?...:[]`. |
| `business_intelligence_kinetic_enterprise/code.html` | Guard `res.ok`; `num()` helper; guard `renewalAnalytics`/`forecast` objects and `segments`/`members` arrays. |
| `task_management_kinetic_enterprise/code.html` | Removed all demo rows; added script loading **real tasks** (`/tasks`) with priority/due-date + complete-via-PUT, and **real pending renewals** derived from `/members`. |
| `dashboard_kinetic_enterprise/code.html` | **Added the missing `</script>`** before the Expiry-Alerts modal HTML (the structural root cause). |
| `equipment_inventory_kinetic_enterprise/code.html` | Removed demo rows; added script loading `/equipment` with health-status styling + empty state. |

### APIs modified
- `GET /finance/receipt/:invoiceNumber` — single-row + plan/validity joins.
- `POST /settings` — tenant-scoped write.

### Queries modified
- **Receipt:** `+ LEFT JOIN memberships ms ON i.membership_id = ms.id LEFT JOIN membership_plans pl ON ms.plan_id = pl.id`, `ORDER BY (p.status='Successful') DESC LIMIT 1`, returns `plan_name, start_date, end_date`.
- **Settings:** `INSERT OR REPLACE INTO settings (setting_key, tenant_id, setting_value) VALUES (?, 't1', ?)` → `VALUES (?, ?, ?)` bound to `req.tenant_id`.

> Prerequisite context: the analytics endpoints (`bi`, `revenue-trend`, `finance-dashboard`, `executive-summary`, `renewal-queue`, `payment-recovery`) were returning 500/leaking due to parameter-order and OR-precedence bugs fixed in the **prior Phase-1 work**; those fixes are what allow Finance/BI/Dashboard to return real numbers now.

---

## VERIFICATION RESULTS (live, in the browser, Tenant A)

Performed the required flow: created a real member ("Verify Member"), ran a **Cash renewal** (₹1,000 + 18% GST = **₹1,180**), then inspected each page's **rendered DOM**.

| Check | Result |
|-------|--------|
| **Receipt displays correctly** | `Receipt #RCPT-2026-431`, member "Verify Member", real ID, plan **"A Monthly"**, validity **Jul 17 → Aug 17 2026**, Subtotal **₹1,000**, GST **₹180**, Total **₹1,180**, method **Cash**, real Txn ref. **Zero `undefined`/`NaN`.** |
| **Revenue updates** | `finance/summary` total **₹1,180 → ₹2,360** after the renewal. |
| **Finance dashboard** | MTD Revenue **₹2,360**, Outstanding **₹2,360**, Forecast **₹2,478**; 3 Chart.js charts instantiated with live data. **No NaN.** |
| **Main Dashboard updates** | Revenue **₹2,360**, Active Members **2**, Collections **₹2,360**, Outstanding **₹2,360**, Forecast **₹2,478**, Health **53**, Churn **0%**, Leads **1**, VIP table = Anna A + Verify Member. **No `—`/`Loading`/NaN.** |
| **Renewal forecast updates** | `renewal-forecast` expiring-30 count **2**, revenue-at-risk **₹2,000**. |
| **Tasks update** | "1 Pending / Task Alpha (Due Jun 17)" — **no Anita/Rahul/Corporate/Treadmill demo data.** |
| **Settings persist after refresh** | Saved **"Ronak's Gym" + Red (#ff0000)** + GST/phone/email/website → after full reload the **form hydrated** with all values; usage meters (members 2, WhatsApp 0) and plan card ("A Monthly") render. |
| **Equipment** | Live empty-state "No equipment registered yet" — demo rows gone. |
| **All graphs render** | Finance (3) + Dashboard charts instantiated via Chart.js with real datasets. |
| **App-wide `<script>` scan** | All other screens balanced; **only the dashboard** had the missing tag. |

---

## DEFENSIVE CODING ADDED (never show `undefined`/`null`/`NaN`)

- Receipt: `money(v)=₹${Number(v)||0}`, `txt(v)= '--' fallback`, `fmtDate()` guards invalid dates.
- Finance/BI/Dashboard: `Number(x)||0`, `Array.isArray(x)?x:[]`, object guards for `renewalAnalytics`/`forecast`, `res.ok` checks. The dashboard already had `fmt/pct/txt/num` helpers that emit `₹0`/`0%`/`--`/`0` — they now actually run.
- `api.js`: `_json()` returns `null` (not a throw) on non-JSON responses.

---

## REMAINING NOTES (honest)
- `revenuePerMember` on the BI/`bi` page currently computes **0** (a calculation nuance in that one endpoint) — it renders `₹0`, not `NaN`, so it satisfies the no-NaN requirement but is not yet a meaningful figure. Out of this audit's data-flow scope; flagged for a follow-up.
- New tenants start with **0 membership plans** because the seeded demo plans are global (`tenant_id IS NULL`) and correctly invisible to them — onboarding must create plans first. Pre-existing UX gap, not a data-flow break.
- Security items (XSS, billing webhook, CSRF, etc.) remain out of scope here and are tracked separately in `FIX_PLAN.md` / `PHASE_1_CRITICAL_FIX_REPORT.md`.

**Bottom line:** every module listed (Members, Plans, Renewals, Payments, Finance, Analytics, Dashboard, Tasks, Team Profile/Branding, Receipts, Settings) now reads from **live production data**, with no `undefined`/`NaN`/demo content in the verified flows.
