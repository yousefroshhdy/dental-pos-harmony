# Roadmap & Execution Plan — Honest OS

> Status: **Accepted** (owner delegated, 2026-10-28) · Phase 1 deliverables #6 (MVP scope), #7 (phased roadmap), #10 (execution checklist) · Last updated: 2026-10-30
>
> Durations are **rough estimates for 1 full-time developer working with Claude Code**. They are not commitments and are re-estimated at each phase gate.

---

## 1. Progress tracker

Definitions are in `docs/TESTING.md` §4.
- **"Tested"** means automated tests pass locally: PostgreSQL 16 with the Supabase stub, Vitest, and Playwright on Chromium.
- **"Verified"** means exercised end-to-end on staging by a human. Staging exists since 2026-10-30: https://honest-os-staging.vercel.app with Supabase `honest-os-staging`. It needs the owner steps in `docs/runbooks/supabase-vercel-setup.md` (server secrets, exposed schemas, owner login) before anyone can sign in.

| Phase | Planned | Implemented | Tested | Verified | Deployed |
|-------|:-------:|:-----------:|:------:|:--------:|:--------:|
| 0 Discovery | ✅ | n/a | n/a | ⏳ owner review | n/a |
| 1 Architecture | ✅ | ✅ docs + draft schema | ✅ draft smoke test 45/45 | ✅ owner delegated decisions | n/a |
| 2 Foundation | ✅ | ✅ (see detail) | ✅ (see detail) | — needs staging | — |
| 3 Core operations | ✅ | 🟡 DB commands + UI for every area incl. returns, planning, workflow admin, imports, admin v2 (see detail); offline check-in/out, tasks and order drafts; Android shell; pilot not started | 🟡 DB, unit and route-protection e2e; no live click-through | — | — |
| 4 Financial operations | ✅ | 🟡 AR core, write-off, invoice and receipt print, return credits, commissions | 🟡 DB + unit | — | — |
| 5 Management intelligence | ✅ | 🟡 KPI metric functions, role dashboards, targets, snapshots, CSV exports | 🟡 DB + unit | — | — |
| 6 Integrations | ✅ | — | — | — | — |
| 7 Advanced modules | ✅ | — | — | — | — |
| 8 Production hardening | ✅ | 🟡 CSP and security headers, MFA step-up (enforcement off), FK and hot-filter indexes, audit-4 fixes | 🟡 DB + unit | — | — |

### Phase P — Make it usable (2026-11-24)

| Step | Item | Status | Evidence |
|------|------|--------|----------|
| 3 Google Maps | Shared map component (`src/components/map/`): official loader, lazy, ar/en, region EG, markers, grid clusters, polylines, info windows, "The map is not available yet" state with no network | Implemented, Tested (unit) | `tests/unit/maps-no-key.test.ts`, `maps-logic.test.ts` |
| 3 Google Maps | CSP: Google Maps sources behind `googleMaps: true`, script-src unchanged (nonce + strict-dynamic); meta copy from the same builder | Implemented, Tested (unit) | `tests/unit/security-headers-maps.test.ts`, meta parity case. Needs the one-line proxy switch (lead) |
| 3 Google Maps | Customers map `/map` with rep, territory, stage, overdue AR and last-visit filters (`api.v_customer_map`) | Implemented, Tested (DB scope) | suite 57 |
| 3 Google Maps | Customer detail map card: pin, opt-in distance, directions link; office users set the location by Places Autocomplete or a dropped pin (`api.set_customer_location`) | Implemented | e2e not run |
| 3 Google Maps | Pin on first visit: check-in proposal, verifier approves or rejects, `/map/proposals` list | Implemented, Tested (DB) | suite 57 |
| 3 Google Maps | Rep day map on the tracking day page: route, numbered stops and check-ins, gaps | Implemented, Tested (unit + DB scope) | `maps-logic.test.ts`, suite 57 |
| 3 Google Maps | Team map `/map/team`: last point per rep during an open shift only (D-14) | Implemented, Tested (DB) | suite 57 |
| 3 Google Maps | Live map on staging with the owner's browser key | Planned (owner: key + APIs) | — |
| 4 Leads | Discovery queued on a base or radius change; daily cron `/api/cron/leads` and owner "Search now"; "not configured" without a server key | Implemented, Tested (DB + unit) | suite 60, unit `leads-discovery` |
| 4 Leads | Places API (New): Nearby Search (dentist, dental_clinic) over a hex grid with split of full cells, Text Search "عيادة أسنان" with a rectangle restriction, place-id de-duplication, minimal field masks | Implemented, Tested (unit, fetch mocked; no live call) | unit `leads-grid`, `leads-places-client`; place type names not re-checked against Google's page |
| 4 Leads | Places policy: only place id + HONEST's own data stored; live details; attribution + Google Terms/Privacy links; distances cleared after 30 days | Implemented, Tested (DB: no such columns; distance expiry) | suite 60; docs/DECISIONS.md 2026-11-26 (policy page to be confirmed by the owner) |
| 4 Leads | Exclusions: customer place id, pinned customer within 50 m | Implemented, Tested (DB) | suite 60 |
| 4 Leads | "Leads near me" `/leads`: list and map, nearest first, filters, add to today's plan (plan rules + daily cap, shared with `api.plan_visits`), status, notes | Implemented (UI), Tested (DB commands) | suite 60; e2e not run |
| 4 Leads | First visit → CRM prospect (`api.convert_lead` → `api.create_customer`, place id linked), then check-in → pin proposal (step 3 flow) | Implemented, Tested (DB) | suite 60 |
| 4 Leads | Manager view `/leads/team`: per-rep leads, visited %, converted %, runs; owner: search now, radius, cost guard; reassignment (crm.lead.assign) | Implemented (UI), Tested (DB) | suite 60 |
| 4 Leads | Cost guard: `leads.daily_request_cap`, `leads.monthly_budget_usd` (owner), requests and estimated cost per run, refusal over either cap | Implemented, Tested (DB) | suite 60 |
| 4 Leads | Live discovery on staging | Planned (owner: Places API (New), server key, budget alert) | — |

### Detail (as of 2026-10-30)

| Item | Status | Evidence |
|------|--------|----------|
| Migrations (66 files) + reference data | Implemented, Tested; **all 66 applied to Supabase staging** (2026-10-31) | `pnpm test:db` on `648f993`: 2687 assertions in 52 suites, 0 failing files. All 52 suites (2687 assertions) also pass on staging with real pgTAP 1.3.3, rolled back |
| Authorization engine, owner safeguards, grant ceiling | Implemented, Tested | suites 01, 05, 07, 08 |
| Inventory ledger, receipts, transfers, adjustments + approval | Implemented, Tested | suites 02, 13 |
| Orders: draft → submit (server pricing, discount and credit approval) → approve → reserve (FEFO) → fulfil, cancel | Implemented, Tested | suites 03, 12 |
| Approval engine (rules, stages, limits, scope, delegation, hooks) | Implemented, Tested | suites 14, 16 |
| CRM (customers, duplicates, reassignment, opportunities), tasks, visits (check-in/out, exceptions), GPS retention | Implemented, Tested | suites 04, 10, 11, 16 |
| Outbox dispatcher (DB, `/api/cron/outbox`, HMAC signing) | Implemented, Tested | suite 09 + unit tests |
| Views never bypass RLS | Implemented, Tested | suite 15 |
| Independent security audit (15 findings) | All fixed, Tested | `docs/security/audit-2026-10-29.md`, suite 17 |
| Phase 3 audit (10 findings + 1 follow-up) | All fixed, Tested | `docs/security/audit-2026-10-30.md`, suites 25, 26 |
| Finance, dashboards and tracking audit (10 findings) | All fixed, Tested | `docs/security/audit-2026-11-01.md`, suites 31, 32 |
| Next.js shell, i18n (ar RTL / en), login, magic link, proxy, PWA shell | Implemented, Tested | 1442 unit tests + 318 Playwright (Chromium) on `0ba1acf` |
| Admin console v1 (users, invite, roles editor, security events) | Implemented, unit-tested | never clicked through against a live database |
| CI pipeline | Implemented | has not run on GitHub yet |
| WebKit (iOS) end-to-end tests | Implemented | not run (no WebKit in the build sandbox) |
| Phase 3 UI: rep Today, visits (GPS check-in/out, exceptions, consent screen), tasks | Implemented, unit-tested | `src/modules/field`, routes `/today` `/visits` `/tasks` |
| Phase 3 UI: customers (create/edit, duplicates, reassignment, location, timeline), opportunities pipeline | Implemented, Tested | `src/modules/crm`, suite 19 |
| Phase 3 UI: order builder, list, detail, lifecycle actions (server pricing only) | Implemented, Tested | `src/modules/orders`, suite 21 |
| **Phase P — Make it usable**, step 6: offers/packages (owner), bonus lines, net-price entry, invoice discount, decision-B tiers (settings, ship as `per_role`), per-product VAT (owner), server price preview, VAT shown on order/print | DB Implemented, Tested; UI Implemented, unit-tested (no click-through) | migrations `20261125000200`–`0210`, suite 56 (122), `src/modules/offers`, `/offers`, `/offers/vat`, builder in `src/modules/orders` |
| Phase 3 UI: stock, ledger, receipts, transfers, adjustments, reorder/expiry alerts | Implemented, Tested | `src/modules/inventory`, suite 22 |
| Phase 3 UI: approvals inbox and detail, notifications, header bell | Implemented, Tested | `src/modules/approvals`, suite 23 |
| Catalogue maintenance commands and admin UI (products, SKUs, price lists, promotions) | Implemented, Tested | `src/modules/catalog`, suite 24 |
| Offline queue (IndexedDB), sync engine, /sync screen, header indicator; check-in, check-out and task completion queue offline and sync exactly once; per-user wipe on shared devices | Implemented, unit-tested | `src/lib/offline`, `src/modules/offline`, `src/modules/field/offline.ts`. Offline Playwright flow not done yet; order drafts below |
| Every Phase 3 screen redirects signed-out visitors to login | Tested | `tests/e2e/phase3-routes.spec.ts` (116 checks) |
| Rep pilot | Not started | Needs U-01/U-02 data and D-03 clearance |
| AR core: invoices from fulfilled orders (VAT per line, gapless numbers, immutable), credit notes via approval, payments (pending → confirm/reject, reverse/bounce), allocation (manual or oldest-first, lock-safe), statement, aging, overdue scan → collection tasks | Implemented, Tested | `src/modules/finance`, suites 27, 28. Not done: ETA (D-02). Opening-AR import, MFA on reversals, write-off and print: see wave 2 below |
| Dashboards: rep, manager and owner views; KPI functions (ADR-015) with Cairo days, no double counting, DB-enforced scope; targets; daily snapshots | Implemented, Tested | `src/modules/dashboards`, suite 29 |
| Work-hours tracking (D-14 phase 1): notice, shifts, 5-min points, stops, gaps, distance, team and day views, 90-day purge | Implemented, Tested | `src/modules/tracking`, suite 30. Browser collects only with the app open; the native Android collector (phase 2) is below |

**Wave 2 (14 modules, merged in `d6243c2`) and audit 4 (fixes merged in `0ba1acf`).** "Tested" = DB and unit tests pass on `0ba1acf`; nothing has been clicked through on a live database, so nothing is Verified. The e2e checks the reports recommend are listed as Planned in `docs/TESTING.md` §6.

| Item | Status | Evidence |
|------|--------|----------|
| Security headers: per-request nonce CSP, meta copy for the Android app, proxy on dotted page paths | Tested | `src/proxy.ts`, `src/lib/security-headers.ts`; e2e `security-headers.spec.ts`, unit `security-headers-*`, `proxy-*`. HSTS and `upgrade-insecure-requests` not yet seen over HTTPS |
| CSV exports of lists (`/reports`, `/api/export/[kind]`), DB gate and audit (`api.log_export`), rate limit | Tested | `src/modules/reports`, suite 52, unit `reports-*` |
| Per-kind export permissions, all MFA-gated (owner decision 2026-10-31); export buttons on the orders, customers, invoices, payments, aging, visits, stock and tracking list pages | Tested | `20261104001100`, suites 39, 48, 52, 54, unit `reports-export-permissions`. Not Verified on staging |
| MFA step-up (TOTP enrol, verify, step-up link in every module), 17 gated permissions, enforcement off | Tested | `src/modules/security`, suites 39, 48, 49, 50. Rollout is an owner step (runbook §2) |
| Audit row-image reader (`/audit`), masked and logged | Tested | `src/modules/audit`, suites 44, 52 |
| Android tracking app (D-14 phase 2): Capacitor shell, native collector, guarded bridge, email-code login | Tested (web side and `BridgePolicy` policy, in CI); native shell built by CI | suite 33, unit `native-*`, `tracking-native`, `login-otp`, JVM `BridgePolicyTest` (Android CI run 3). Not run on a phone |
| Android builds | **Pilot APK `honest-os-android-pilot` and debug APK built by Android CI run 3** (0ba1acf, 2026-10-30): `BridgePolicyTest` passed; the pilot APK verified signed, not debuggable, `allowBackup=false` and `dataExtractionRules` in the merged manifest. Artifacts expire after 14 days; re-run the workflow for a fresh one | `.github/workflows/android.yml`, `mobile/README.md` |
| Offline order drafts (queued, replay-safe saves, indicative prices, submit online-only) | Tested | `src/modules/orders`, suites 36, 47, unit `orders-offline` |
| Invoice write-off through approval; printable invoice and receipt (ar/en, amount in words) | Tested | `src/modules/finance`, suite 38, unit `finance-print`, `finance-amount-words` |
| Sales returns: request with approval, receive into quarantine, credit; paid invoices credited as customer credit; cancel | Tested | `src/modules/returns`, suites 35, 46. Partial receipt not built |
| Data migration imports (customers, products, customer prices, opening stock, opening AR) | Tested | `src/modules/imports`, suites 34, 47. First dry-run on staging pending (D-03: synthetic data only) |
| Workflow administration: rules editor, delegation, escalation job | Tested | `src/modules/workflow`, suites 43, 51 |
| Visit planning and coverage | Tested | `src/modules/planning`, suites 42, 53 |
| Database performance: FK and hot-filter indexes, plan guards | Tested | suite 40. JIT is off on Supabase (checked on staging); suite 40 also rejects duplicate indexes |
| Admin console v2: settings, employees, territories and coverage | Tested | `src/modules/admin`, suites 41, 49, 50 |
| Commissions: engine, statements, period close, adjustments, daily cron | Tested | `src/modules/commissions`, suites 37, 46, 48. Plan `STD-2026` is still draft; no plan or rate editor |
| Consolidated approval-hook dispatch | Tested | `20261103009900`, suite 45 |
| Wave-2 audit (26 findings: M money and stock, A access and security, F field and mobile) | All fixed and Tested (DB, app and Android CI); nothing Verified on a device yet | `docs/security/audit-2026-11-03.md`, suites 17, 46–53 |
| Audit 4 M-1, M-3 (returns), M-4: returns on paid invoices, `cancel_return`, replay scope, overdue history | Tested | suite 46 |
| Audit 4 M-2, M-3 (orders), M-6: import commit lock, one opening balance per customer, draft replay scope, `import` sweep | Tested | suites 47, 17 |
| Audit 4 A-M1, A-L2, M-5: wider gated set, quarantine release step-up, step-up link | Tested | suite 48, unit `security-*` |
| Audit 4 A-M2, A-M3, A-M1 (employees/territories): definer employment guard, effective owner, owner-set lock | Tested | suite 50 |
| Audit 4 A-M4, A-L1: owner-only auto-approve rules, live escalation authority | Tested | suite 51 |
| Audit 4 A-H1, A-L3: settings hardening | Tested | suite 49, unit `admin-settings-errors` |
| Audit 4 A-LM2, A-L4: audit masking, export controls in the DB | Tested | suite 52, unit `reports-export-log` |
| Audit 4 A-LM1, F1 (web), F7: proxy matcher, meta CSP, 8-digit email codes | Tested (hosted OTP settings are an owner step) | unit `proxy-matcher`, `proxy-csp-meta`, `security-headers-meta`, `login-otp` |
| Audit 4 F1 (native), F3, F4, F8: guarded bridge, non-debuggable pilot APK, idle watcher release, pinned actions | Tested: F4 by unit tests; F1 native by `BridgePolicyTest` in CI; F3 by the CI pilot-APK checks; F8 by CI running on the pinned SHAs | unit `native-idle-watcher`, Android CI run 3. Device checks in `docs/TESTING.md` §6 are still Planned |
| Audit 4 F2, F5, F6, F9: daily cap, linear generator, read scope, planner rule, fast coverage | Tested | suite 53, unit `planning-audit4` |
| **Staging deploy of wave 2 and audit 4** | **Database done; owner steps pending** | All 66 migrations are on staging and all 52 suites pass there (2026-10-31). Still needed before anything is Verified: the runbook owner steps (§2 secrets, exposed schemas, OTP, template, rate limit, TOTP, owner login) and a human click-through |

### Phase P — Make it usable (2026-11-24)

| Item | Status | Evidence |
|------|--------|----------|
| Step 5: fresh pilot APK | Planned (the lead re-runs Actions › Android › Run workflow; artifacts expire after 14 days) | `mobile/README.md` › Install, step 1 |
| Step 5: plain install steps for IT and reps (uninstall old APK, install, notifications, sign-in, location "Allow only while using the app": "Allow all the time" is not offered because the app declares no background location and records through a location foreground service; battery per brand; USB debugging off) | Implemented (docs); in-app guidance corrected the same way | `mobile/README.md`; unit `tracking-native-guidance` |
| Step 5: tracking health panel (shift open/closed and since when, last point and age, collector, permission, app version or web build, battery saver, points waiting, "Needs attention" after 15 minutes) | Tested (DB + unit); not Verified | suite 59; unit `tracking-health`, `native-device-info`; `/tracking` |
| Step 5: one-phone test-day script | Planned (each step Verified only after the owner runs it) | `docs/TESTING.md` §6.1 |
| Step 5: visits flow checked in code (start shift → check-in → check-out → outcome) | Implemented; no blocking bug found in the tracking/field modules beyond the permission guidance | report of Phase P step 5 |
| Step 7 commissions switched on: owner-only MFA rate editor (`/commissions/plans`), STD-2026 configured with decision D (brand rates; grafts/membranes unset and on the "no rate" list), activation with rep assignment from the editor, printable rep statement (collected cash → commissionable → commission → clawbacks → net) | Tested (DB + unit); STD-2026 stays a draft until the owner activates it in the editor; not Verified | suite 58, suites 37/46 unchanged, unit `commissions-editor`, `commissions-messages` |
| Step 2a UI foundation: shadcn/ui components (`src/components/ui`), DataTable (@tanstack/react-table v9, client and server pagination, phone cards), date picker (Cairo calendar, Western digits), form field with inline validation messages, toasts | Implemented, Tested (unit) | unit `ui-components`, `ui-helpers` |
| Step 2a type and theme: IBM Plex Sans Arabic / IBM Plex Sans (self-hosted), Bebas Neue for Latin display only, deep-teal brand tokens, light/dark (next-themes, nonce-carrying script) | Implemented, Tested (build; nonce checked on the built login page) | `src/app/globals.css`, `src/app/[locale]/layout.tsx` |
| Step 2a app shell: department nav groups with permission filtering, collapsible desktop sidebar, phone menu drawer, field bottom bar (Today · Map · Leads · Visits · Orders), account menu with theme and language | Implemented, Tested (unit) | `src/lib/nav.ts`, `src/components/app-shell`, unit `nav-groups`, `nav-bottom-bar` |
| Step 2a context-load error screen ("couldn't load your account", distinct from "account not active") | Implemented, Tested (unit) | `src/lib/authz/context.ts`, unit `ui-context-error` |
| Step 2b Today redesign: date and day summary, quick actions (check-in → today's plan, unplanned visit, new order linked to the visit in progress), shift card, visits in progress, plan, "Leads near me" card (→ `/leads`), follow-ups and tasks with empty states | Implemented, Tested (unit); not clicked through | `/today`, unit `field-today` |
| Step 2b customers list: server-paged DataTable (search, sort by name / number / added / balance, URL state), stage, territory, specialty, rep (combobox) filters in a phone sheet, one-tap overdue / phone missing / no location chips, phone cards, balance and overdue badge, loading / empty / error states | Implemented, Tested (DB + unit) | `api.v_customer_list` (`20261126000200`), suite 61 (30), unit `crm-ui-logic` |
| Step 2b customer detail: header with stage, gap badges, overdue, balance; call / WhatsApp buttons (or "add phone"); new order and check-in; tabs overview / visits / orders / invoices / activity (each tab only with its read permission); map panel kept | Implemented, Tested (unit) | `/customers/[id]`, unit `crm-ui-logic` |
| Step 2b customer create/edit: sectioned form with inline messages; phone optional on create with a live "phone missing" warning and the `PHONE_MISSING` notice after create; a saved phone cannot be cleared | Implemented, Tested (unit) | unit `crm-schemas`, `crm-ui-logic` |
| Step 2b "add phone" on the next visit: bottom sheet on the customer page, the unplanned check-in list and an open visit (`api.update_customer`, phone only) | Implemented, Tested (DB) | suite 61 |
| Step 2a role homes on `/[locale]` (owner > finance > manager > rep), existing `api.*` reads only | Implemented, Tested (unit: role choice, figures) | `src/modules/home`, unit `ui-home-role` |
| Step 2b per-screen redesign (Today, Customers, Customer detail, Orders, then the rest) and screenshots | Planned (next wave) | — |
| Step 2b (B2b) Orders, Finance, Inventory, Returns lists: DataTable with server pagination, sort and search in the URL (`?page=&sort=&q=` plus each list's existing filters), phone cards, empty/error/loading states: orders, invoices, payments, aging, stock (inventory and sales views), movements, receipts, transfers, adjustments (new `/inventory/adjustments`), returns | Implemented, Tested (unit: paging kit); no click-through, no screenshots | `src/modules/orders/kit/`, `src/modules/*/lists.ts`, `*Page` reads in each module's `queries.ts`; unit `orders-kit-paging` |
| Step 2b (B2b) order builder (customer Combobox, numbered sections, offer picker, line cards with quantity steppers, net price, invoice discount, server preview, sticky save/preview bar above the phone bottom bar), order detail (PageHeader, tabs, actions card / phone action sheet), invoice detail (tabs, totals tiles, VAT per rate, collect-payment link), collect payment (Combobox, method choices, DatePicker), payment, stock, receipt, return pages (progress strip) | Implemented, Tested (unit: return progress); pricing, payloads and permission checks unchanged; print pages untouched | unit `returns-progress`; existing `orders-*`, `finance-*`, `inventory-*`, `returns-*` unit tests unchanged and passing |
| Step 2b (B2c) redesign of every other screen: admin (users, employees, roles, role detail, security events, settings in tabs, territories in tabs, employee detail in tabs, owner setup with a progress bar), approvals inbox and detail, notifications, audit search and record history, catalogue (products, product detail, price lists, price list detail, promotions), commissions (statement, team, periods, plans, rate editor in tabs, adjustments, print), dashboard and targets, imports (upload / templates / history tabs), planning (week, generate, coverage), reports, tracking (team day, day map), workflow (hub, rules, rule detail, escalations, delegations), my security, the map pages, and the sign-in page (visual only). PageHeader, back links, Tabs, FormField, Combobox, DatePicker, Sheet ("New …" forms), empty / error / loading states | Implemented, Tested (unit, typecheck, lint, build); not Verified (no click-through, no screenshots) | `src/components/page-kit`, `src/lib/list-query.ts`, `src/modules/*/tables.ts`, unit `b2c-list-query` |
| Step 2b (B2c) server-paged DataTables (page, sort, search and filters in the URL; exact count; phone cards): users, employees, roles, security events, approvals inbox, notifications, catalogue products, planning coverage, import batches. Browser-paged DataTables for bounded lists the API returns whole: audit results (keyset RPC, newer/older links), price lists, commission periods and plans, commission team, workflow rules, tracking team day (`api.tracking_team_day` returns the whole team) | Implemented, Tested (unit: URL state, search sanitising, sort mapping, filter links) | unit `b2c-list-query` |
| Step 2b (D1) local signed-in stack and screenshots: PostgreSQL 16 database `honest_e2e_local` (migrations, seed, fixture, synthetic demo data through `api.*` as the fixture users), pinned PostgREST binary, mock auth + gateway, `pnpm build`/`start` with no Google keys; Playwright screenshots of 86 screens × ar/en × 390/1440 px with automatic checks (horizontal scroll, tap targets, raw keys, console errors, failed requests, error boundaries, 404/500). Fixes from the run: phone header wordmark, order builder sticky bar at 390 px (en), nested `<form>` in the commission plan editor (hydration error), 44 px tabs and filter chips, missing favicon (404 on every page) | Implemented, Tested (screenshots reviewed on the local stack; mock auth, so not Verified) | `scripts/e2e-local/`, `tests/e2e-local/`, `playwright.local.config.ts`, `docs/TESTING.md` §7 |
| Step | Item | Status | Evidence |
| 1 | Old-system workbook → import CSVs (`pnpm legacy:convert`), reconciliation vs the Checks sheet; real files in `private/import/` | Implemented, Tested | `tests/unit/legacy-convert.test.ts` (synthetic workbook); run once on the owner's workbook (locally, output not committed): customer count, debit and credit totals match the source; stock units match the source except the negative rows left out |
| 1 | Imports accept the old data: customers without a phone, old account numbers, base (DEFAULT) prices, unknown cost, governorate batch default | Implemented, Tested | suite 55 (converter output end to end), suites 34/47 unchanged |
| 1 | Owner setup screen `/admin/setup`: warehouse, legacy brands/category, territories (Mansoura → Dakahlia), people, logins with roles (one-time link, no SMTP), reps' base address (Google geocoding or typed), import order | Implemented, Tested (DB + unit) | suite 55, `tests/unit/admin-setup.test.ts`; no live click-through yet |
| 1 | Load the files on staging (owner) | Planned | owner steps in the step-1 report |
| 1 | Browser import of the old-system workbook: `/admin/setup/legacy-import` (owner, MFA), in-memory server conversion, reconciliation vs the Checks sheet, negative-stock decision (fix to 0 / skip), credit balances held by default, five ordered steps (customers → products → prices → opening stock → opening AR) with dry run and commit through the existing import batches, restage / abandon, data-to-complete list | Implemented, Tested (DB + unit); no click-through, not Verified | migration `20261126000300`, suite 62 (80), unit `legacy-browser-import`, `legacy-convert`; one local smoke conversion of the owner's workbook (output not kept): converts, customer count and debit/credit totals match, the on-hand quantity check differs only by the negative rows left out by design |
| — | Privacy clean-up (reviewer, 2026-11-25): no real workbook figure, name or phone in any committed file; real totals replaced with "matches the source"; suite 56 and unit tests use a synthetic net-price shape (2,723.45 / 45.53 %) | Implemented, Tested | scan of every tracked file against the workbook (names, phones, amounts); `pnpm test:db` 3207 / 0 failing, `pnpm check` 1757 |
| 2b | Screen follow-ups from the local screenshot run: permission codes on the approval page and /account/security shown as Arabic/English labels (`messages/*/permissions.json`, fallback to the code); task notification links `/tasks/<id>` forward to `/tasks` instead of a 404 | Implemented, Tested (unit `permission-labels`; route in `tests/e2e/phase3-routes.spec.ts`) | small text links (15–20 px) on leads cards, map proposals, aging, statement and detail pages need a design decision |
| 8 | Verification walkthrough `docs/VERIFICATION.md`: 84 lines across 7 roles (owner 19, sales director 8, area manager 10, sales rep 24, finance 9, inventory 6, admin 8), each with URL, clicks (English + Arabic labels from `messages/`), expected result, status; before-you-start block, record table, what cannot be automated | Implemented; nothing Verified (the owner sets Verified after their own click-through) | `docs/VERIFICATION.md` |
| 8 | Automation of the walkthrough: one Playwright test per line (77 of 84), titled with the line id; writing flows in order (old-system workbook, decision-B approvals, order → invoice → payment → commission → return, lead → prospect → pin, customer without a phone), repeatable on the same database | Tested (local stack: 77 passed, 0 failed) | `tests/e2e-local/verification.spec.ts`, `tests/e2e-local/verify/`, `playwright.verify.config.ts`, `pnpm e2e:local:verify`; local seed now mirrors staging's decision-B tiers and has a quarantine warehouse |
| 8 | Preview mode (read-only, real data): `pnpm verify:preview` with `VERIFY_BASE_URL`, `VERIFY_EMAIL`, `VERIFY_PASSWORD`, `VERIFY_ROLE`; 38 read-only lines; writing and demo-data lines skipped; no screenshot, trace, video or page snapshot kept | Implemented; mechanics exercised against the local stack (all roles); not run on a preview (no test account yet) | `docs/VERIFICATION.md`, `docs/TESTING.md` §8 |
| 8 | Screenshots refreshed: 87 screens (new: `/admin/setup/legacy-import` with the synthetic workbook checked) × ar/en × 390/1440 = 348 | Tested (local) | `tests/e2e-local/screens.ts` |
| 8 | Quarantine warehouse from `/admin/setup`: once a main warehouse exists and no active quarantine one does, the owner sees **Create the quarantine warehouse** (code `WH-QRN` by default); same `api.create_warehouse` with kind `quarantine`, no DB change | Implemented, Tested (unit `admin-setup`; one local run: the form created an active quarantine warehouse and then disappeared) | closes the gap that blocked receiving returns on staging |
| 2b | Review on `d4f3077`, approval type names: every seeded workflow code (12, including `finance.write_off`) has an Arabic and English label; the home approvals card and the dashboard "waiting for you" list now use them too (fallback: the stored English name) | Implemented, Tested (unit `workflow-type-labels`: codes read from the migrations; red before the fix) | — |
| 2b | Review on `d4f3077`, desktop sidebar: the dark column spans the full page height; its content sticks to the viewport and the menu scrolls on its own | Implemented, Tested (local screenshots: new "sidebar shorter than the page" check, 0 of 174 desktop shots) | — |
| 8 | Review on `d4f3077`, owner's 30-minute staging run: section 0 of `docs/VERIFICATION.md`, 11 steps in business order (setup → workbook import → rep invite and login → leads → visit with check-in → order with offer and free item → approval → invoice → payment → commission statement → map and tracking day), each with URL, clicks, expected result and the per-role lines it relies on; a record table for the owner | Implemented; 4 steps rely only on lines Tested (local), 7 have a Planned part; nothing Verified | `docs/VERIFICATION.md` §0 |
| 2b | Review on `d4f3077`, tap targets: 0 under 44 px at 390 px (was 55); home "Open" links, filter chips and sortable headers 44 px; text links use `tap-link` (44 px below `md`). Desktop text links under 24 px in table cells and sentences accepted (`docs/TESTING.md` §7) | Implemented, Tested (local screenshots 348/348, verification 77/77) | replaces the earlier "small text links need a design decision" note |
| review | Plain language on field and finance screens (review of `d4f3077`, item 3): no "server", API, key, env var names, status codes or SQL words in strings reps, managers, finance and inventory read ("Update prices" / «تحديث الأسعار», "Prices are worked out when you save", "Clinic names are not available yet. Ask the owner to finish the Google Maps setup."); the env var name and the Google Cloud check show only to the owner and `admin.settings.manage` holders (`seesSetupDetails`) on the map and leads notices | Implemented, Tested (unit) | unit `user-facing-wording` (scans every `messages/{ar,en}` string; allow-list of owner/admin keys with reasons), `maps-no-key` |

## 2. MVP scope (prioritised)

**MVP goal:** reps and managers run daily field sales in Honest OS, and every order, stock movement and collection is recorded and controlled. **MVP = Phases 2 + 3 + the "AR core" of Phase 4 + basic dashboards from Phase 5.**

| Priority | In MVP | Why first |
|----------|--------|-----------|
| P0 | Auth, users/employees, roles & scoped permissions, audit, settings, i18n (ar/en, RTL), notifications (in-app), outbox | Everything depends on it; security from day one |
| P0 | Territories, customers (lifecycle, duplicates, assignment), contacts, activities timeline, tasks/follow-ups | Core asset; replaces customer spreadsheets |
| P0 | Visits with GPS-verified check-in/out, outcomes, exceptions, offline queue | Accountability; KPI foundation |
| P0 | Catalogue (brands, categories, products, SKUs), price lists, promotions | Required for orders |
| P0 | Inventory: warehouses, lots/expiry, receipts, ledger, transfers, adjustments with approval, reservations | Stock truth |
| P0 | Orders: draft → submit (server pricing + discount limits) → approval → reserve → fulfil → return/cancel | Revenue engine |
| P0 | Approval workflow engine (discount, adjustment, reassignment, visit exception) | Control |
| P1 | Invoices (internal numbering; ETA per D-02), payments (record → confirm), allocations, AR ledger, aging, collection tasks | Cash visibility |
| P1 | Dashboards: Rep Today/My performance, Manager Team, Inventory alerts, Finance aging | Visibility |
| P1 | KPI engine with the seed KPIs (visits, verified %, new accounts, follow-ups, collection rate, revenue achievement) | Accountability |
| P2 (post-MVP) | Commissions; executive overview; scheduled reports; integrations (WhatsApp, Paymob, Shopify, Make); ETA (if not in Phase 4) | Depends on stable financial data |
| P3 (later) | QMS, Academy, document management, AI assistant, forecasting, maps | Depends on data maturity |

**Explicitly out of MVP:** general ledger, payroll, supplier POs and landed cost (U-13), customer portal, native apps.

## 3. Phases (dependency-ordered)

### Phase 0: Discovery (done → owner review)
- **Output:** `docs/DISCOVERY.md`.
- **Exit:** unknowns U-01…U-07 have owners and dates.

### Phase 1: Architecture (done → owner review)
- **Output:** all `docs/*`, draft schema + smoke test.
- **Exit:** owner approves D-04 and answers or defers D-01…D-07. **No Phase 2 code before approval.**

### Phase 2: Foundation (est. 3–4 weeks)
- **Scope:** repository, Next.js app shell, Supabase integration, Auth, migrations, authz engine, audit, base UI system, i18n/RTL, testing infrastructure, CI/CD.
- **Prerequisites:**
  - D-04 approved.
  - GitHub org, Supabase org (2 projects: staging, prod) and Vercel team created under company-owned accounts (D-08).
  - Region decision (D-03) for prod; staging may proceed with synthetic data.
- **Tasks:**
  1. Scaffold Next.js (TS strict, ESLint, Prettier), Tailwind, shadcn/ui, next-intl (ar default, RTL), Serwist PWA shell.
  2. `supabase init`; split the draft into migrations `0001…0013`; `seed.sql` with reference data and the permission catalogue.
  3. Port `90_smoke_test.sql` to pgTAP (`supabase/tests/`) and run it on a real `supabase start` stack (resolves R-17).
  4. Supabase SSR client (`server.ts`, `browser.ts`), `admin.ts` marked `server-only`; middleware with session refresh, locale and request id.
  5. Command wrapper + error mapping (`src/lib/command.ts`, `errors.ts`) with unit tests.
  6. Auth: admin-invited users only, login (password + magic link), MFA enrolment for owner/admin/finance, suspension flow.
  7. Admin console v1: users, employees, roles, permissions matrix, grants with bindings, overrides, effective-access inspector, audit and security event viewers.
  8. Notifications (in-app, Realtime) and the outbox dispatcher route + Integrations health page.
  9. CI: lint, typecheck, Vitest, pgTAP, build, Playwright smoke; preview deploys; staging migrations on merge; manual promote to prod.
  10. Observability: Sentry, structured logger, request id → `app.request_id`.
- **Dependencies:** none beyond prerequisites.
- **Expected outputs:** deployed staging app where an owner can log in, create users and roles, and see audit logs.
- **Acceptance criteria:**
  - All draft smoke scenarios pass as pgTAP in CI.
  - Suspended user is locked out on next request.
  - Last-owner guard works through the UI.
  - No service-role key in client bundles.
  - Arabic RTL and English LTR render correctly.
- **Tests:** authz matrix v1, owner safeguards, escalation, error mapping, RTL visual snapshots.
- **Deployment:** staging only; prod project created but empty.
- **Definition of done:**
  - Merged with green CI.
  - Docs updated (DATABASE, AUTHORIZATION, API_CONTRACTS, TESTING).
  - Verified on staging by the owner (login, create role, grant, suspend).

### Phase 3: Core operations (est. 6–8 weeks)
- **Scope:** territories, CRM, visits/GPS, catalogue, inventory, orders (through fulfilment and returns), approvals engine, tasks, rep PWA with offline queue.
- **Prerequisites:**
  - Phase 2 done.
  - D-06 (rep stock), D-07 (Shopify direction, for the catalogue master), D-09 (credit behaviour) answered.
  - Sample of real customer/product data (U-01, U-02).
- **Tasks:**
  1. Territories & coverage map UI.
  2. Customer master (create/update/duplicates/reassign/archive), contacts, timeline.
  3. Opportunities + pipeline.
  4. Tasks.
  5. Visits: check-in/out, exceptions → approval, consent screen, retention job.
  6. Offline queue (IndexedDB) + sync + conflict UI.
  7. Catalogue & price lists & promotions admin.
  8. Warehouses, lots, goods receipt posting, transfers, adjustments (limit + approval), reservations (FEFO), expiry/reorder alerts.
  9. Orders: builder (indicative prices offline), submit, approvals inbox, reserve, fulfil, cancel, returns → quarantine.
  10. Workflow engine: rules, stages, delegation, escalation job.
  11. Data migration tooling (`import.*` staging, rejects report) + first dry-run migration on staging.
  12. Rep pilot (2 reps, 2 weeks) on staging with anonymised data.
- **Dependencies:** authz, audit, outbox (Phase 2).
- **Expected outputs:** reps can run a full day; managers approve; inventory reflects every movement.
- **Acceptance criteria:**
  - Inventory invariant job reports 0 mismatches.
  - 0 orders above the discount limit without approval.
  - Offline check-ins sync exactly once.
  - Rep "Today" LCP < 2.5 s on throttled 4G.
  - Pilot reps complete ≥ 90% of visits in-app.
- **Tests:** inventory consistency suite, orders/approvals suite, GPS suite, offline Playwright suite, mobile/RTL suites.
- **Deployment:** production go-live of Phase 3 **after** D-03 legal clearance and migration sign-off.
- **Definition of done:** as Phase 2, plus owner sign-off of migrated totals (customers, opening stock by lot).

### Phase 4: Financial operations (est. 4–6 weeks)
- **Scope:** invoices (+ ETA per D-02), credit notes, payments (record/confirm/bounce), allocation/reversal, AR ledger, aging, collection tasks, pricing-rule hardening, credit limits, commissions.
- **Prerequisites:** D-01, D-02, D-05, D-12 answered; PITR enabled on prod; accountant reviews invoice format and rounding.
- **Tasks:**
  1. Invoice issue from fulfilment; numbering; PDF (ar/en).
  2. Credit notes from returns.
  3. Payments with cheque handling.
  4. Allocation UI (FIFO suggestion).
  5. Customer statements.
  6. Aging & collection tasks + overdue job.
  7. Opening AR migration.
  8. ETA integration or accounting export (D-02), sandbox first.
  9. Commission plans/rules/periods, calculation, statements, adjustments, approval, lock.
- **Acceptance criteria:**
  - AR ledger = Σ documents for every customer.
  - Golden commission tests pass.
  - ETA sandbox accepts documents (if in scope).
  - Finance verifies one month of parallel run against the existing process.
- **Tests:** financial consistency suite, commission golden tests, concurrency tests (allocation, numbering).
- **Definition of done:** one full month of **parallel run** reconciled by finance before the old process is switched off.

### Phase 5: Management intelligence (est. 3–4 weeks)
- **Scope:** KPI engine (registered metrics, targets, snapshots, scorecards), dashboards by role, executive overview, scheduled reports, reporting views for Sheets/Looker.
- **Acceptance criteria:**
  - Every tile links to its definition and drill-down.
  - KPI results reproducible from `source_snapshot`.
  - Daily, weekly and monthly reports delivered on schedule for 2 consecutive cycles.

### Phase 6: Integrations & automation (est. 3–5 weeks, gated per integration)
- **Scope:** Make.com scenarios 1–7, WhatsApp templates, Paymob links + webhook reconciliation, Shopify product/stock/order sync, Gmail/Sheets exports.
- **Prerequisites:** each integration's verification gate (INTEGRATIONS.md §2) passed.
- **Acceptance criteria:**
  - Signature verification and idempotency tests pass.
  - Dead-letter handling demonstrated.
  - Paymob reconciliation shows 0 unexplained differences over 2 weeks.
  - Shopify stock matches available stock within one sync interval.

### Phase 7: Advanced modules (est. 6–10 weeks, can be split)
- **Scope:** QMS (complaints, lot-based recall, CAPA, controlled documents), Honest Academy (courses, sessions, attendance, certificates, CRM hand-off), document management, AI assistant (`docs/AI.md`), forecasting.
- **Prerequisites:** U-14, U-15 answered; for AI: an evaluation set of 50 real questions, PDPL review of model provider.
- **Acceptance criteria:**
  - Recall by lot lists every affected customer in < 1 min.
  - AI eval ≥ 95% correct, 0 untraceable numbers.

### Phase 8: Production hardening (continuous, with a formal gate before each major go-live)
- Security review (OWASP ASVS L2 checklist, Supabase advisors, dependency audit, ZAP baseline).
- Performance test at 2× expected load.
- Data migration validation.
- **Backup and restore drill** (restore prod backup to staging; measure RTO).
- Disaster recovery runbook.
- UAT per role.
- Deployment verification checklist.
- Incident runbooks (auth outage, DB saturation, webhook storm).

## 4. Final execution checklist (before Phase 2 starts)

**Decisions**
- [ ] D-04 Stack and architecture approved by the owner
- [ ] D-01 / D-02 Invoicing and ETA direction chosen (or explicitly deferred to the Phase 4 gate)
- [ ] D-03 Legal review requested; staging uses synthetic data only until cleared
- [ ] D-05 Commission policy confirmed (can wait until Phase 4)
- [ ] D-06 Rep stock yes/no
- [ ] D-07 Shopify role
- [ ] D-08 Two owner accounts named

**Accounts (company-owned, MFA on)**
- [ ] GitHub organisation (repo moved or renamed to `honest-os`)
- [ ] Supabase organisation: `honest-os-staging`, `honest-os-prod` (region per D-03)
- [ ] Vercel team (Pro) linked to the repo
- [ ] Sentry project
- [ ] Domain: `app.honesteg.co` DNS access

**Data**
- [ ] Sample exports: customers, products/SKUs, price lists, stock by lot, open invoices (U-01…U-04)
- [ ] Named owner for each dataset and the authoritative source (U-07)

**People**
- [ ] Pilot reps (2) and a pilot area manager chosen
- [ ] Finance contact for invoice format, rounding and tax (U-09)

## 5. Operating model during development

- Small PRs (one feature slice), each with tests and doc updates.
- Every PR states its status honestly: Implemented / Tested / Verified.
- A weekly 30-minute demo on staging for the owner, covering approved scope only. New requests are logged into this roadmap before any work starts.
