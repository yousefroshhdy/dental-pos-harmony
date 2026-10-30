# Testing Plan — Honest OS

> Status: **In use** · Last updated: 2026-10-30
>
> **Current suite (all passing locally; run by the lead on `0ba1acf`, 2026-10-30):**
> - Database: **2687 assertions in 52 pgTAP-format suites, 0 failing files** (`pnpm test:db`; list in §5). The first 1346 (suites 01–32) also pass on the real Supabase staging project with pgTAP 1.3.3, run inside a rolled-back transaction (2026-10-30). Suite 27's `savepoint … rollback to savepoint` gap check ran there as an equivalent sub-transaction, because the remote runner executes each suite inside a function. Suites 33–53 have not run on staging yet.
> - Unit: **1442 Vitest tests** (`pnpm test`)
> - End-to-end: **318 Playwright tests** (159 specs × 2 Chromium projects; `pnpm e2e:chromium`; set `PW_CHROMIUM_PATH=/opt/pw-browsers/chromium` in the cloud sandbox). The WebKit project has not been run yet.
> - Android JVM: `mobile/android/app/src/test/java/eg/honest/os/BridgePolicyTest.java` (6 tests), run by `.github/workflows/android.yml` (`testDebugUnitTest`). Locally it passed with javac 21 and JUnit 4.13.2; it has not yet run in CI with the new workflow.
> - CI (`.github/workflows/ci.yml`) has not run on GitHub yet.

## 1. Test pyramid and tooling

| Layer | Tool | Runs | Gate |
|-------|------|------|------|
| Database: constraints, triggers, RLS, commands | **pgTAP** via `supabase test db` on a local Supabase stack | Every PR (CI) | Required |
| Unit (TS): zod schemas, error mapping, formatters, offline queue logic, pricing display helpers | **Vitest** | Every PR | Required |
| Integration (TS ↔ DB): server actions against local Supabase with seeded users per role | Vitest + Supabase local | Every PR | Required |
| End-to-end | **Playwright**: projects `mobile-android` (Pixel 7 profile, 4G throttling), `mobile-ios` (iPhone 14 WebKit), `desktop-chrome` | PR (smoke) + nightly (full) | Smoke required |
| Accessibility | axe-core in Playwright | Nightly | Report |
| Performance | Lighthouse CI (rep routes), k6 for API p95 | Nightly + before releases | Budgets enforced |
| Security | Dependency audit, secret scanning, Supabase security advisor, OWASP ZAP baseline on staging | Weekly + before releases | No high findings |

## 2. Critical test suites (must exist before the feature is called "Tested")

### 2.1 Permission & RLS tests (`supabase/tests/authz_*.sql`)
- One seeded user per default role, plus a suspended user, a terminated employee and an anonymous request.
- For **every table**: assert the rows visible per role match an expected matrix (fixture with 2 territories, 3-level manager chain, 4 reps).
- For **every `api` command**: allowed roles succeed; disallowed roles get `42501`.
- Escalation: grant ceiling, self-grant, owner-only grant, direct-table writes (all present in the draft smoke test).
- Owner safeguards: last owner revoke/suspend, owner role delete/deactivate (in the draft smoke test).
- Override precedence (deny beats grant); expiry of roles and overrides.
- **Permission drift snapshot:** a generated matrix of role × permission × scope committed to the repo. CI fails on unexpected changes.

### 2.2 Inventory consistency
- Balance = Σ movements per (warehouse, variant, lot) for every row: invariant query `select … where on_hand <> sum(movements)` must return 0 rows after each test.
- Negative stock blocked; allowed only in `allow_negative` warehouses.
- Reservation never exceeds available. Concurrent reservations of the last unit: two sessions in parallel, exactly one succeeds (pgTAP + a `dblink` or TS concurrency test).
- Transfer: `transfer_out` and `transfer_in` net to zero company-wide; in-transit visible.
- Reversal of a movement restores the prior balance; double reversal blocked (unique `reverses_movement_id`).
- Property-based test (fast-check in TS): random sequences of receipts, issues, transfers and reversals keep balances = ledger and ≥ 0.

### 2.3 Financial consistency
- Invoice totals = Σ lines; VAT rounding per line, 2 dp, banker's rounding **not** used (round half away from zero, matching the ETA expectation; confirm with accountant).
- Allocation: Σ allocations per invoice ≤ invoice total − credits; Σ allocations per payment ≤ payment amount. Concurrent allocations against the same invoice: one fails.
- AR ledger: customer balance = Σ invoices − Σ credits − Σ confirmed allocations… reconciled against `v_customer_balances` for every customer after each scenario.
- Immutability: invoice amounts, ledger rows, allocations (draft smoke test covers invoices and the audit log).
- Gapless numbering under concurrency (10 parallel issues → 10 consecutive numbers, no gaps after a rolled-back transaction because numbering happens inside the same transaction).
- Commission golden tests: the worked example in `DASHBOARDS.md` §3 plus returns, bounced cheque, partial payments, reassigned customer, rate change mid-period (effective dating) → expected statements as fixtures.

### 2.4 Orders and approvals
- Server-side pricing ignores client-supplied prices and totals (in the draft smoke test).
- Discount ≤ limit → submitted; > limit → pending_approval + approval request (in the draft smoke test).
- State machine: every disallowed transition rejected. Every allowed transition writes history.
- Approver cannot approve their own request or above their limit. Delegation works only inside its window. Escalation fires after `escalate_after`.

### 2.5 Field / GPS
- Verified / out_of_range / low_accuracy / no location / no customer location (draft smoke test covers four).
- Idempotent replay (draft). Anomaly flags: impossible travel (draft), duplicate fix, late sync, clock skew.
- Retention job deletes fixes older than 12 months and keeps visit verdicts.

### 2.6 Offline synchronisation (Playwright + Vitest)
- Go offline (Playwright `context.setOffline(true)`) → check in, note, follow-up, order draft → reload app → still queued → go online → all synced exactly once (server row counts).
- Kill the app mid-sync → resume → no duplicates.
- Conflict: edit customer offline while the manager edits online → version conflict UI shows a field diff.
- Queue item older than 7 days → flagged, not auto-applied.

### 2.7 Mobile responsiveness and localisation
- Every rep route at 360×640 and 390×844: no horizontal scroll, tap targets ≥ 44 px, primary action reachable with the thumb.
- Arabic RTL screenshots (visual regression) for all rep routes and key manager routes. Mixed-direction strings (Arabic + SKU codes) render correctly.
- Number, date and currency formatting in `ar-EG` and `en-EG`. Phone input accepts `01…` and normalises to `+201…`.

### 2.8 Security
- No service-role key in client bundles (CI grep on `.next/static`).
- CSRF: server actions only via POST with origin check (Next.js default) and verified.
- Webhooks: invalid signature → 401 and logged; replayed event → no duplicate effect.
- Rate limits on auth and AI endpoints.
- Headers: CSP (no `unsafe-inline` scripts), HSTS, frame-ancestors none. **As built:** `tests/e2e/security-headers.spec.ts` (headers on a page and `/api/health`, a fresh nonce per request, every script carries it, the service worker registers, no CSP violations, an injected `<img onerror>` is blocked, `offline.html` under its own CSP); unit `security-headers-builder`, `security-headers-proxy`, `security-headers-meta` (the meta policy = header policy minus meta-invalid directives), `proxy-csp-meta` (same nonce in header and meta), `proxy-matcher` (dotted page paths run the proxy; every file in `public/` is skipped).
- MFA step-up: suites 39 and 48 (gated set, real commands at aal1 and aal2 with enforcement on and off), 49 (settings), 50 (employee and territory step-up); unit `security-logic` (`stepUpHref`, safe `next`).
- Exports: suite 52 (`log_export` whitelist, permissions, MFA, rate limit, result rows), unit `reports-route`, `reports-export-log` (the SQL whitelist matches `EXPORT_PERMISSIONS` and the filter schemas).
- Android bridge: JVM `BridgePolicyTest`; unit `native-bridge`, `native-idle-watcher`, `tracking-native`.
- Uploaded files: type and size checks; private buckets; signed URLs with short expiry.

### 2.9 Performance
- Budgets: rep routes LCP < 2.5 s on throttled 4G (Lighthouse mobile), JS ≤ 200 KB gzipped, server p95 reads < 500 ms, commands < 1 s, with synthetic data of 50k customers, 1M movements and 200k visits.
- RLS cost: `EXPLAIN ANALYZE` on the customer list, order list and visits list for a rep and a director; must use indexes, with authz helpers as InitPlans. **As built: suite 40.** It loads synthetic data at about 1/10 of the planned volume inside a rolled-back transaction, asserts plans from `EXPLAIN (FORMAT JSON)` without ANALYZE (expected index, no Seq Scan on large tables, authz helpers only as InitPlans) for the customer, order, visit, today, aging, invoice, payment and movement lists, and counts executed authz helper calls (≤ 60 per query; superuser only, otherwise reported as skipped). Timing is not asserted. It also guards foreign-key index coverage.
- Planning and coverage: suite 53 times the generator (2005 customers; a flooded month) and coverage against a 3 s threshold.

## 3. Sample data (fixtures)

- `supabase/seed.sql` holds reference data only: governorates, specialties, categories, brands (Bioner, Derby, RDT), permission catalogue, system roles, default settings, KPI definitions and commission plan seed.
- `supabase/tests/fixtures/*.sql` holds a scenario company: 2 regions (Cairo & Giza, Delta) + 1 sub-area, 1 owner, 1 sales director, 2 area managers, 4 reps, 1 inventory manager, 1 finance officer; 20 customers with coordinates; 10 SKUs across 3 brands with lots and expiries; price lists (standard + one customer-specific + one promotion).
- **Production data never leaves production.** Staging uses anonymised copies (names and phones replaced, coordinates jittered by ±300 m).

## 4. Definition of "Tested" and "Verified"

| Status | Meaning |
|--------|---------|
| Planned | Documented here or in ROADMAP |
| Implemented | Code merged |
| **Tested** | Automated tests for its critical paths exist and pass in CI |
| **Verified** | Tested **and** exercised end-to-end on staging by a human, with the result recorded in the PR or release notes |
| Deployed | Live in production, smoke test passed, monitoring green |

## 5. Database suites (`supabase/tests/database/`)

Plan counts are the `select plan(N)` lines; all 52 files declare one. Total **2687** assertions on `0ba1acf`, 0 failing files. There is no suite 20.

| Suite | Covers | Plan |
|-------|--------|-----:|
| 01_authz_rls | row visibility per role, status gates, overrides, expiry | 18 |
| 02_inventory_ledger | append-only ledger, derived balances, negative stock, adjustment limits | 14 |
| 03_orders_pricing | server-side pricing, discount authority → approval, scope | 13 |
| 04_field_gps | GPS verification, idempotent replay, anomaly flags | 8 |
| 05_owner_escalation | owner lock-out safeguards, escalation prevention | 14 |
| 06_finance_audit | finance immutability, audit trail | 9 |
| 07_platform_admin | user context, registration, suspension, roles and the grant ceiling | 26 |
| 08_reference_and_privileges | reference data, privilege surface (no `anon` execute on `api`) | 17 |
| 09_outbox | outbox dispatcher, backoff, dead letters, retry | 58 |
| 10_crm | customers, duplicates, updates, reassignment, opportunities | 100 |
| 11_field_tasks | tasks, today view, check-out, visit exceptions | 74 |
| 12_order_flow | order lifecycle, approvals, reserve (FEFO), fulfil, cancel | 78 |
| 13_inventory_ops | receipts, transfers, adjustments with approval, cost masking | 50 |
| 14_workflow_engine | condition evaluator, rule selection, stages, delegation, self-approval | 59 |
| 15_view_security | views never bypass RLS | 5 |
| 16_crm_workflow_integration | CRM/field approvals through the generic engine | 11 |
| 17_audit_regressions | 2026-10-29 audit; definer and PUBLIC-execute sweep (now includes `import`) | 24 |
| 18_rls_initplan | no policy calls `auth.uid()` per row | 1 |
| 19_crm_ui | CRM read surface | 26 |
| 21_orders_ui | orders read views and UI contracts | 21 |
| 22_inventory_ui | inventory workspace views | 37 |
| 23_approvals_ui | approvals read surface | 40 |
| 24_catalog_commands | catalogue administration | 95 |
| 25_audit_phase3 | Phase 3 audit regressions | 65 |
| 26_create_customer_scope | duplicate errors stay inside the caller's scope | 7 |
| 27_finance_commands | invoices, VAT, numbering, payments, allocation, credit notes | 112 |
| 28_finance_ledger | aging, statement, collections, overdue scan | 52 |
| 29_dashboards | KPI metric functions and dashboard reads | 108 |
| 30_tracking | work-hours tracking (D-14) | 98 |
| 31_audit3_finance | 2026-11-01 audit, AR and dashboards | 68 |
| 32_audit3_tracking | 2026-11-01 audit, tracking | 39 |
| 33_tracking_native | `source = 'native'` points (Android app) | 26 |
| 34_imports | staging, validation, all-or-nothing commit, opening stock and AR | 90 |
| 35_returns | request, approval, quarantine receipt, credit at invoiced prices | 92 |
| 36_orders_offline | replay-safe draft saves | 28 |
| 37_commissions | DASHBOARDS §3 golden example, clawbacks, close, adjustments, cron | 100 |
| 38_finance_writeoff | write-off approval, open amounts, print reads | 81 |
| 39_mfa | MFA step-up: flag, switch, `authz.require`, real commands, exact gated set | 64 |
| 40_performance | FK index coverage, plans on synthetic data, authz helper call counts | 25 |
| 41_admin_v2 | settings whitelist, employees, territories, cycles | 113 |
| 42_planning | plan, unplan, generator, coverage | 101 |
| 43_workflow_admin | rules editor, delegation, escalation | 94 |
| 44_audit_reader | owner-only row-image reader, masking, logging | 64 |
| 45_dispatch_consolidated | every `wf.on_decided_*` hook is in the one dispatch | 1 |
| 46_audit4_returns_ar | audit 4 M-1, M-3 (returns), M-4 | 70 |
| 47_audit4_imports_drafts | audit 4 M-2, M-3 (orders) | 22 |
| 48_audit4_mfa | audit 4 A-M1, M-5: gated set, quarantine release, reveal, write-off decision, commission close and cron | 65 |
| 49_audit4_settings | audit 4 A-H1, A-L3 | 91 |
| 50_audit4_owner_guards | audit 4 A-M2, A-M3, A-M1 (employee/territory); deferred guards fired while authenticated | 54 |
| 51_audit4_workflow | audit 4 A-M4, A-L1 | 42 |
| 52_audit4_audit_exports | audit 4 A-LM2, A-L4 | 66 |
| 53_audit4_planning | audit 4 F2, F5, F6, F9 | 51 |

**Pinned sets:** suites 39 and 48 compare the exact MFA-gated permission set; flagging a permission means updating both.

## 6. End-to-end checks recommended by the wave-2 and audit-4 reports (Planned)

None of these is written yet. They need a seeded Supabase stack or staging.

| Area | Check |
|------|-------|
| MFA | Enrol on `/account/security` (QR shows, a test TOTP code confirms, factor Active, session verified); cancel and restart removes an abandoned factor; a wrong code shows `INVALID_CODE`; with enforcement on, an admin suspending a user sees `MFA_REQUIRED` with the step-up link, verifies, lands back and succeeds; a rep only ever sees the plain denial; `/ar/account/security?next=//evil.example` shows no back link |
| MFA (scope changes) | As admin at aal1 with enforcement on: suspend an employee, change a manager, assign a territory; each shows the MFA error and changes nothing. With enforcement off, terminating an employee persists after reload |
| Settings | Change the check-in radius and reset it; an owner-only key has no edit form for the admin; out-of-range value shows the translated error; with enforcement on, an aal1 owner cannot turn MFA off; an external logo URL is refused |
| Exports | Owner downloads each export (BOM, Arabic headers, opens in Excel); a rep sees only invoices, visits and stock and gets 403 on orders and customers; signed out → 401; cap 2 adds the truncation row; customers export with MFA on at aal1 → 403 `mfa_required`; 21 rapid exports → 429; the `export` and `export_result` events appear on `/admin/security` |
| Audit reader | Owner sees `/audit`, an admin gets Forbidden; find a customer change by table and id, open its timeline, phone shown as hidden; reveal shows it and logs a warning event; filters and paging |
| Security headers | A logged-in `/ar/audit/crm.customers/<id>` has the CSP header and a matching meta nonce; `/ar/login` meta nonce equals the header nonce |
| Email code | 8-digit code login against a local Supabase stack, reading the email from Inbucket |
| Offline orders | Offline on `/orders/new`: add lines, save → item on `/sync`; online → syncs once and "Open the order" appears; reload restores lines; Submit disabled offline; offline product search; a conflict on `/sync` resolved with "Send mine" |
| Returns | Rep requests a return at 360 px; sales director approves; inventory manager receives into a quarantine-only list; finance credits it, including on a paid invoice (customer-credit note); requester cancels a pending return; inventory manager cancels an approved one; cancel hidden for other reps and for received returns |
| Write-off and print | Collection officer requests, finance approves, invoice shows written off and its task leaves the active list; self-approval refused; print pages in ar and en (RTL/LTR, A4 preview, no horizontal scroll at 360 px); receipt refused for a pending payment |
| Imports | Owner sees the nav entry, a rep gets Forbidden; template CSV has a BOM; upload, validate, fix, re-upload, commit; `.xlsx` refused; opening AR from two tabs commits once |
| Commissions | Rep statement at 360 px; area manager team summary; finance recalculates and closes the oldest month and the rep is notified; adjustment request approved by the second owner; cron 401 without the bearer |
| Workflow | Admin edits a rule and adds a stage (ar RTL, 360 px); a non-owner sees no auto-approve switch and a disabled Save on an owner's auto rule; delegation created, used and revoked; an escalated approval disappears from a demoted user's inbox |
| Planning | Rep adds and removes a visit; a past day shows `PAST_DATE`; a manager generates next month and saves part of it; a second run does not repeat; a full day shows `DAILY_CAP`; a rep's plan hides Remove on a manager-planned visit; coverage loads and "Plan a visit" preselects the customer |
| Admin v2 | Create an employee and assign a territory; the manager list excludes own reports; terminating keeps held customers listed; territory create, move, deactivate, coverage; RTL at 360×640 |
| Android (device) | Tracking survives 10+ minutes with the screen off; an injected cross-origin iframe calling the bridge is refused (logcat `HonestBridge`); `adb shell run-as eg.honest.os` fails on the pilot APK; `chrome://inspect` shows nothing; End my day, sign-out and a shift ended elsewhere remove the notification; one watcher after a reload; code login inside the app; fallback page offline |
