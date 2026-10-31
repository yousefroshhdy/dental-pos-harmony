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
