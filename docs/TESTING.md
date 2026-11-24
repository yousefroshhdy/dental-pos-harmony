# Testing Plan — Honest OS

> Status: **In use** · Last updated: 2026-11-24 (Phase P step 8)
>
> **Current suite (Phase P step 8, local run, 2026-11-24):**
> - Database: **3431 assertions in 61 pgTAP-format suites, 0 failing files** (`pnpm test:db`; list in §5). DB suites no longer run on staging since it holds real data (DECISIONS 2026-11-25).
> - Unit: **1937 Vitest tests in 127 files** (`pnpm test`).
> - Local signed-in stack (§7, §8): **77 verification lines passed** (`pnpm e2e:local:verify`) and **348 screenshots** (87 screens × ar/en × 390/1440, `pnpm e2e:local:shots`). Mock auth: Tested, not Verified.
>
> Earlier totals, kept for history (run by the lead on `0ba1acf`, 2026-10-30):
> - Database: 2737 assertions in 53 pgTAP-format suites, 0 failing files locally after the per-kind export permissions and the duplicate-index guard (2026-10-31). Before that change, all 52 suites (2687 assertions) also passed on the real Supabase staging project (PostgreSQL 17, pgTAP 1.3.3), run inside a rolled-back transaction (2026-10-31). Suite 27's `savepoint … rollback to savepoint` gap check ran there as an equivalent sub-transaction, because the remote runner executes each suite inside a function. Suite 40's aging plan check accepts either open-invoice index, because PostgreSQL 16 and 17 choose differently.
> - Unit: 1476 Vitest tests (1442 before the per-kind export permissions)
> - End-to-end: 318 Playwright tests (159 specs × 2 Chromium projects; `pnpm e2e:chromium`; set `PW_CHROMIUM_PATH=/opt/pw-browsers/chromium` in the cloud sandbox). The WebKit project has not been run yet.
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
- Old-system workbook from the browser (Phase P, unit, Tested): `legacy-browser-import` (in-memory conversion of the synthetic workbook buffer with a SHA-256, negative-stock list, missing sheets, row cap; upload validation: name, type, size, zip directory, not-a-workbook and macro parts, zip bombs by declared size, ratio and entry count, same-origin check, form schemas; reconciliation display mapping and tally; decisions: incomplete, fix to 0, skip, credits held/imported; suite 62's rows equal the server's staging; step gating: first step only, dry run → commit, next step after commit, empty steps done, discarded → restage only, closed session) and `legacy-convert` (the converter, imports updated to `src/modules/imports/legacy`).
- App shell and design system (Phase P, unit, Tested): `nav-groups` (department grouping, permission filtering, active entry, labels in both languages), `nav-bottom-bar` (who gets the field bar and which items), `ui-context-error` (context load failure vs inactive account), `ui-home-role` (owner > finance > manager > rep, home figures), `ui-components` (primitives compatibility, 44 px targets, no physical classes, FormField ARIA wiring, DataTable client/server pagination and states), `ui-helpers` (Cairo dates with Western digits, table URL state, zod → `form.*` messages). Playwright checks for the shell are listed as Planned in §6.
- Server-paged lists (Phase P step 2b, B2c, unit, Tested): `b2c-list-query` (PostgREST range, search text sanitising and quoting so a typed value cannot add a filter, allow-listed URL filters, filter-chip links that keep search and sort and reset the page, sort-id → view-column mapping per list, the approvals inbox and coverage default orders, catalogue price range, the imports history tab). Planned e2e: each list's search / sort / page / filter round-trip in the URL on a seeded stack, and the phone card layout at 360 px.
- Plain language on screens (Phase P review, unit, Tested): `user-facing-wording` scans every string of `messages/{ar,en}.json` and `messages/{ar,en}/*.json` for developer words (server / الخادم, API, key / مفتاح, env var names, HTTP status codes, RPC, PostgREST, Supabase, SMTP, JSON, UUID, SQL, idempotency, payload, null, permission codes) and fails on any key outside an explicit allow-list (owner/admin-only screens or the user's own word, each with a one-line reason); it also pins the reviewer's examples and checks `seesSetupDetails` (owner and `admin.settings.manage` only). `maps-no-key` checks the plain no-key map state for everyone and the env var line only with `setupHint`.

### 2.8 Security
- No service-role key in client bundles (CI grep on `.next/static`).
- CSRF: server actions only via POST with origin check (Next.js default) and verified.
- Webhooks: invalid signature → 401 and logged; replayed event → no duplicate effect.
- Rate limits on auth and AI endpoints.
- Headers: CSP (no `unsafe-inline` scripts), HSTS, frame-ancestors none. **As built:** `tests/e2e/security-headers.spec.ts` (headers on a page and `/api/health`, a fresh nonce per request, every script carries it, the service worker registers, no CSP violations, an injected `<img onerror>` is blocked, `offline.html` under its own CSP); unit `security-headers-builder`, `security-headers-proxy`, `security-headers-meta` (the meta policy = header policy minus meta-invalid directives), `proxy-csp-meta` (same nonce in header and meta), `proxy-matcher` (dotted page paths run the proxy; every file in `public/` is skipped).
- MFA step-up: suites 39 and 48 (gated set, real commands at aal1 and aal2 with enforcement on and off), 49 (settings), 50 (employee and territory step-up); unit `security-logic` (`stepUpHref`, safe `next`).
- Exports: suite 52 (`log_export` whitelist, permissions, MFA, rate limit, result rows), suite 54 (per-kind export permissions), unit `reports-route`, `reports-export-log` (the latest SQL whitelist matches `EXPORT_PERMISSIONS` and the filter schemas), `reports-export-permissions` (the map, nav and `ExportCsvButton` visibility, and the list pages that render it).
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

Plan counts are the `select plan(N)` lines; all 53 files declare one. Total **2737** assertions on `a4457b7` (2687 on `0ba1acf`), 0 failing files. There is no suite 20.

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
| 40_performance | FK index coverage, no duplicate indexes, plans on synthetic data, authz helper call counts | 26 |
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
| 54_export_permissions | per-kind export permissions: catalogue, same roles and scopes as before (user by user), refusal per kind without its export permission, MFA at aal1/aal2, whitelist | 49 |
| 55_phase_p_setup | Phase P step 1: customers without a phone (+ `api.v_customer_data_gaps`), employee base location and lead radius, `api.create_warehouse`, `api.setup_overview`, `api.authorize_sign_in_link`; the legacy converter's synthetic output loaded end to end through the import commands (products → DEFAULT prices → opening stock with unknown cost → customers by old account number → opening AR and credits); rejects for the new columns. The embedded files are checked against the converter by `tests/unit/legacy-convert.test.ts` | 119 |
| 56_phase_p_pricing | Phase P step 6 (synthetic copies of real invoice shapes): package with 2 bonus lines (stock, invoice, commission base), 45.53 % offer without approval, manual 24 % rep (approval) / sales manager (direct), 30 % → owner, credit + owner routing, net price 2,723.45 from 5,000, invoice discount 33.33/33.33/33.34 and 5 %, free item outside an offer, VAT-0 next to 14 %, owner-only audited VAT, issued invoices keep their VAT, expired / untargeted / changed / switched-off offers refused, package capped at list, partial invoice of a net-price line, old payloads | 122 |
| 57_phase_p_maps | Phase P step 3: `v_customer_map` scope (rep, area manager, sales director, owner, other rep), overdue flag and last visit; pin on first visit (check-in at an unpinned customer proposes the fix, replay, no proposal without a fix or at a pinned customer, rep and other rep refused, out-of-scope verifier refused, inaccurate fix refused, reason required, approve pins and supersedes, replay, decided proposals immutable, timeline, notification, outbox, audit, a direct set supersedes); team map only during open shifts (not before the start, not after the end, not past the 10-hour cap, scope per role); visit fixes for the day map (scope, field.location.read) | 77 |
| 58_phase_p_commissions | Phase P step 7: decision D configuration, owner-only rate editor (permission matrix, MFA at aal1/aal2), activation and rep assignment, append-only effective-dated rates and plan guards, synthetic invoices: partial payments, bonus (zero) lines, an all-free invoice, return within 90 days (clawback) and after 90 days (none), mid-month rate edit, unset STEP rate (0 and on the no-rate list), rep statement totals and their scope, deactivation | 104 |
| 62_phase_p_legacy_import | Phase P, the old-system workbook from the browser: privileges (anon refused, helpers not callable, views security_invoker, RLS on), no file stored (no binary column, summary capped), no new permission; owner only (rep refused, a non-owner holding `admin.import.run` refused `OWNER_ONLY`), MFA (owner at aal1 refused with enforcement on, aal2 passes); start refusals for each decision rule (skip in products/prices, fix-to-0 in stock or missing from products, negative AR while credits are held) and bad input; the converter's synthetic output staged as five batches, replay, conflict, one open session, audit and a counts-only security event; step order on the existing dry run and commit (`LEGACY_ORDER`), restage of the current step only (decisions re-checked, old batch discarded), completion; "fix to 0" (in the catalogue with its price, no stock) vs "skip" (not imported), held credits not posted; data-quality view (phone, pin, unknown cost; leaves the list once a cost exists; rep and non-owner see nothing); credits imported on purpose; abandon. The staged rows are checked against the server's staging by `tests/unit/legacy-browser-import.test.ts` | 80 |
| 59_phase_p_tracking | Phase P step 5, tracking health: `api.report_device_status` (own open shift only, key whitelist and types, 1 KB cap, one report a minute per shift, snapshot replace, closed shift refused, no direct writes) and `api.v_tracking_health` (security_invoker, no coordinates; rep sees own row, area manager their team, sales director both reps, another rep and finance nothing, owner all trackable; attention after 15 minutes without an arriving point, cleared by a point, never on a closed shift) | 48 |
| 60_phase_p_leads | Phase P step 4: structure and privileges (RLS, no writes, security_invoker views, service-only job functions, **no coordinates, names, addresses or phones stored**), owner-only settings and defaults, role grants; a base save queues one run, a radius change refreshes it, removing the base cancels it; owner-only "Search now"; claim without a key → `not_configured`; claim budget within the daily cap; finish: de-duplication, place-id and 50 m customer exclusions, another rep's lead kept, outside-radius dropped, cost, outbox without coordinates, rep notified; scope (rep, other rep `NOT_FOUND`, area manager team, sales director, finance none, owner); status moves, notes, plan today / past / daily cap shared with `api.plan_visits`; details allowance and monthly budget; first visit → prospect (owner, place id, phone optional, replay, check-in proposal, timeline, outbox, becomes customer when active); converted clinic excluded on the next run; caps: daily refusal, monthly refusal, partial budget, owner-only setting change, stale run charged; reassignment (rep refused, reason, team scope both ways, converted refused, director, notification); stats per rep; 30-day distance clearing and monthly refresh | 114 |
| 61_phase_p_ui_crm | Phase P step 2b: `api.v_customer_list` (security_invoker, read-only, no anon); same live rows as `v_customers` per role (rep, area manager, other rep, owner, no-CRM user), archived excluded; phone/location gap flags agree with `v_customer_data_gaps` both ways; overdue flag, amount and days, not-yet-due is false, combined filters, matches `v_customer_map`; masked overdue and balance without `crm.customer_balance.read` (masked never matches "overdue"), gap flags not masked; "add phone" through `update_customer` (E.164, gap closed, duplicate refused, removal refused, other rep refused) | 30 |

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
| Tracking health (Phase P) | `/tracking` as an area manager at 390 px and 1440 px, ar and en: the "Tracking health now" panel lists only the team; a rep with an open day and no point for 16 minutes shows "Needs attention"; a refused permission shows "Refused" after the next report; a closed day shows "ended HH:MM"; empty and error states |
| Old-system workbook (Phase P, Planned) | Owner at aal2, 390 px and 1440 px, ar and en, synthetic workbook: `/admin/setup` shows the card; upload a .csv → "not an .xlsx"; upload the synthetic .xlsx → reconciliation cards (match / mismatch), negative item needs a decision, "Start" disabled until decided; start → step 1 current, steps 2–5 "Waiting"; dry run → OK/errors counts; commit → step 2 opens; a step with errors lists row numbers and messages; restage the current step; finish → data-to-complete list links open the customer / product; abandon; a rep and a non-owner get the forbidden page and a 403 from `POST /api/legacy-import`; a cross-origin POST gets 403; the owner at aal1 with enforcement on sees the step-up link; no horizontal scroll |
| App shell (Phase P) | At 360×640 and 390×844, ar and en: no horizontal scroll; the menu button opens the drawer from the reading start and lists only permitted groups; a rep sees the bottom bar (5 items, 44 px+), an admin and the owner do not; content is not hidden under the bar. At 1440 px the sidebar collapses to icons and stays collapsed after a reload. |
| Theme and CSP (Phase P) | Logged-in page and `/ar/login` in dark mode: the next-themes script carries the header nonce, no CSP violations, no flash of the light theme on reload; the account menu switches light / dark / system. |
| Role homes (Phase P) | Owner, finance officer, area manager and rep each land on their home; every card shows data, its empty state or its error state; a rep's "Start my day" opens `/today`. |
| Lists (Phase P, B2b) | At 390 px and 1440 px, ar and en, on `/orders`, `/finance/invoices`, `/finance/payments`, `/finance/aging`, `/inventory`, `/inventory/movements`, `/inventory/receipts`, `/inventory/transfers`, `/inventory/adjustments`, `/returns`: phone cards below 768 px and a table above, no horizontal page scroll; page 2 via the pager sets `?page=2` and keeps the filters; sorting a column sets `?sort=`; search (300 ms) resets to page 1; a status tab or a filter resets the page; empty, "no matches" and error states; old links (`?status=`, `?customer=&bucket=`, `?alert=`, `?source_type=&source_id=`) still filter |
| Order builder (Phase P, B2b) | As a rep at 390 px: pick a customer in the Combobox (search by number), add an offer, add a product, step the quantity, switch a line to net price and to bonus, set an invoice discount, "Update prices" scrolls to the preview, Save is reachable in the sticky bar above the bottom bar; the saved draft's lines, payload and server totals are the same as before the redesign; offline banner and "Save on this device" unchanged |
| Order, invoice, payment, return detail (Phase P, B2b) | Order: tabs, actions card at 1440 px and the "Actions" bottom sheet at 390 px; post a fulfilment from the sheet, close and reopen it, retry: one fulfilment (same idempotency key). Invoice: tabs, VAT per rate and basis line, Print opens the unchanged A4 page, "Record a payment" preselects the customer. Collect payment: cheque requires a due date (inline message), amount keypad, sticky submit. Return: progress strip for requested, approved, received, credited, rejected and cancelled |
| Context error (Phase P) | With `my_context` failing (stub the RPC or cut the network after sign-in), the shell shows "couldn't load your account" with Try again, not "account not active"; tracking is not stopped. |

### 6.1 One-phone test day (Phase P step 5)

Every step below is **Planned**. A step becomes **Verified** only after the owner (or the person
he names) runs it on staging and records the result in the table at the end; nothing here is
automated. Steps 3 and 5 use the leads screen and the lead-to-prospect conversion, which come
later in Phase P; steps 4 and 10 use the check-in at an unpinned clinic and the day map, which the
maps step changes. Run those steps once that work is on staging, and the rest now.

**Before the day**

- Staging has: an **area manager** account M with a laptop, a **rep** account R in M's team
  (`core.employees.manager_id`), R's base address saved, and at least two clinics near it (two
  leads, or one lead and one existing test customer). Synthetic names only (owner decision A).
- The pilot phone has the fresh APK, installed with `mobile/README.md` › "Install the pilot app,
  step by step" steps 1–7 (notifications allowed, location "Allow only while using the app" with
  precise location on, battery "Unrestricted", USB debugging off).
- Write down: phone brand and model, Android version, the Android workflow run number.

**The day** (labels in English, Arabic in brackets; the app opens in Arabic)

| # | Who, where | Exact clicks | Expected result | Status |
|---|---|---|---|---|
| 1 | R, phone, at the office | Open **Honest OS** › **Today** (bottom bar; menu **My day**, يومي) › shift card **Start my day** (ابدأ يومي). First time only: read the notice › **I have read and understood this notice** (قرأت هذا الإشعار وفهمته) › **Start my day** again. If Android asks for location: **While using the app**, **Precise** on. | The card shows **On shift** (في يوم العمل) and "Since HH:MM". The notification "Honest OS is recording your location for your working day" appears. Within about a minute: "Last point recorded at HH:MM". | Planned |
| 2 | M, laptop | **Tracking** (التتبع) › section **Tracking health now** (حالة التتبع الآن) | R's row: **Day open** since R's start time; last point a few minutes old; collected by **Android app**; location **Allowed** (right after the start it may say **Unknown** until the next 5-minute report); app version shows **Web** and the build; battery saver **Not reported**; no **Needs attention** badge. R's day is also in the team table below with "On shift: Yes". | Planned |
| 3 | R, phone | Lock the phone, travel to the first clinic (at least 15 minutes). Unlock › bottom bar **Leads** › **Leads near me** › tap the nearest lead. | The lead list is sorted by distance; the lead opens with its details fetched live from Google, Google's attribution shown, status **new**. On M's panel, during the trip, the last point stays at most about 5 minutes old and no **Needs attention** badge appears. | Planned |
| 4 | R, phone, at the clinic | On the lead: **Check in** (تسجيل الوصول). First time on this phone: accept the GPS notice. | A verdict shows. This clinic has no pinned location yet, so the check-in fix is proposed as the clinic's location for a manager to approve (the 2026-10-29 rule), and the visit is **In progress**. **Today** › **Visits in progress** (زيارات جارية) lists it. | Planned |
| 5 | R, phone | On the visit or the lead: record the clinic's own data (doctor, clinic name, phone `+20…`, specialty, notes) › save. | The lead becomes a CRM customer at stage **prospect**, linked to its Google place; the lead's status shows **prospect**; the customer page opens with the data R typed. | Planned |
| 6 | R, phone | **Today** › **Visits in progress** › **Check out** (تسجيل المغادرة) › Outcome **Interested** (مهتم) › a note › optionally **Next follow-up** tomorrow 10:00 › **Check out**. | "Checked out." confirmation; the visit shows **Completed** with the outcome; with a follow-up, a task appears under **Follow-ups** on Today. | Planned |
| 7 | R, phone | Travel to the second clinic. **Today** › **Unplanned visit** (زيارة غير مخططة) › search the clinic › **Check in** › stay at least 10 minutes › **Today** › **Visits in progress** › **Check out** › Outcome **Order taken** (تم أخذ طلبية) or **Not interested** › **Check out**. | The second visit is **Completed**. Two visits on the day. | Planned |
| 8 | R and M (health check) | R: pull down the quick settings › turn **Location** off for 20 minutes, keep the app open. Then turn it back on. | The shift card shows "The phone's location is switched off". On M's panel (reload): after the next report location shows **Location off**; 15 minutes after the last point R's row shows **Needs attention** and moves to the top. After R turns location on, a new point arrives within about 5 minutes and the badge clears on reload. The day page later shows this as a gap. | Planned |
| 9 | R, phone | **Today** › **End my day** (أنهِ يومي) › **Yes, end my day** (نعم، أنهِ يومي). Wait for "All points sent" first if points are waiting. | "Your day has ended (H h MM min)"; the notification disappears. M's panel: **Day closed**, "ended HH:MM", no badge. | Planned |
| 10 | R (phone) and M (laptop) | R: shift card › **See my day** (اعرض يومي). M: **Tracking** › R's name. | The day page shows the route drawn from the day's points, numbered stops, both visit check-ins, any gap (step 8), the distance, and 2 visits. M sees the same day; R sees only R's own. | Planned |

**Record** (fill in on the day, keep in the PR or release notes; then set the steps to Verified)

| Date | Phone, Android version | Workflow run | Steps passed | Steps failed (what was seen) | By |
|---|---|---|---|---|---|
| | | | | | |

## 7. Local signed-in stack (Phase P D1)

A way to run the real app **signed in**, on a machine without Docker, against synthetic data, and
to screenshot every screen. A review aid: nothing here runs in CI, and passing it is **Tested**,
never **Verified** (auth is mocked).

**Run**

```bash
pnpm e2e:local:up                    # setup + start (idempotent); --keep-db reuses the database
PW_CHROMIUM_PATH=… pnpm e2e:local:shots   # screenshots + checks → $SHOTS_DIR (PNG + index.md)
pnpm e2e:local:down                  # stop app, gateway and PostgREST; forget the per-run secret
```

`up` needs PostgreSQL 16 at `PGHOST`/`PGPORT` (default `/var/tmp/honestpg:54329`, started if it is
down), `psql`, `curl`, `openssl` and Node. It then:

1. builds the database `honest_e2e_local` like `scripts/db-test.sh` (stub, shim, migrations,
   `seed.sql`, `tests.load_fixture()`) plus `scripts/e2e-local/demo-seed.sql`: 26 synthetic
   clinics ("Clinic Demo 3", "د. تجربة ٣", phones `+2010000000NN`, some without phone or pin),
   products, prices and a volume tier, stock and a draft receipt, three offers, orders in every
   status, invoices, payments (verified, allocated, a cheque waiting), today's shifts, route points,
   planned / in-progress / completed visits, location proposals, base locations and fake-place-id
   leads, the activated STD-2026 plan with a calculated month, KPI targets, tasks, activities,
   opportunities, a transfer, a quarantine warehouse `WH-QRN`, and approvals waiting (discounts,
   return, reassignment, inventory adjustment, visit exception, write-off). Business rows go
   through `api.*` commands as the fixture users; dates are relative to today (Cairo). Last, the
   owner switches `sales.discount.limit_mode` to `tiered` (decision B, as on staging; the seed
   pins `per_role` for the older suites);
2. downloads the pinned PostgREST static binary (SHA-256 checked) into `.cache/e2e-local/`;
3. writes `.cache/e2e-local/env.local` (git-ignored, mode 600): random HS256 secret, anon and
   service-role keys signed with it, a random shared demo password, an `authenticator` password;
4. starts PostgREST (:54322, schemas `api,service`, anon role `anon`, login role `authenticator`)
   and `scripts/e2e-local/mock-auth.mjs` (:54321: `/rest/v1` → PostgREST, `/auth/v1` → mock auth);
5. runs `pnpm build` and `pnpm start` (:3210) with that env and empty Google keys, so maps and leads
   show their "not configured" states.

Sign in as any fixture user (`owner@honest.test` at aal2, `sd@`, `am.cairo@`, `rep.cairo@`,
`rep.delta@`, `finance@`, `admin@`, `inventory@honest.test`) with `E2E_LOCAL_PASSWORD` from the env
file.

**Screenshots** (`playwright.local.config.ts`, `tests/e2e-local/screens.spec.ts`): every persona
signs in once through the real login form; each screen in `tests/e2e-local/screens.ts` (87,
including `/admin/setup/legacy-import` with the synthetic workbook checked, so the reconciliation
shows; a screen's `prepare` step runs before the shot) is captured full-page in
ar and en at 390 × 844 and 1440 × 900 (`deviceScaleFactor` 1) as
`NN-screen-persona-locale-width.png`. Checks per shot, listed in `index.md`: horizontal scroll at
390 px, visible links/buttons in `<main>` under 44 px, text shaped like a message key, console
errors, failed requests (cancelled prefetches ignored), `role=alert` texts, error-boundary text,
404/500. Knobs: `SHOTS_DIR`, `SHOTS_ONLY`, `SHOTS_LOCALES`, `SHOTS_WIDTHS`, `PW_CHROMIUM_PATH`.
Full-page phone shots show the fixed bottom bar where the first viewport ends. Never commit
screenshots.

**What is real and what is mocked**

| Real | Mocked or missing |
|------|-------------------|
| All migrations, RLS, `api.*` commands, authz, audit, workflow, notifications and outbox rows | GoTrue: password sign-in, refresh, `getUser`, sign-out and the factor list only. No email (magic links and codes are accepted and dropped), no MFA enrolment or verification, no admin API (invites, bans fail with 501) |
| PostgREST (same major version family as Supabase) with JWT role switching and `request.jwt.claims` | `auth.users` is the test stub (id, email); the aal comes from the mock token (owner aal2, others aal1) |
| The production build, proxy, CSP (its `connect-src` already derives from `NEXT_PUBLIC_SUPABASE_URL`) and security headers | No Storage, Realtime, Edge Functions, pg_cron or `pg_net`; the outbox is never dispatched |
| | Google Maps and Places keys are empty: lead names never load, maps show "not configured" |

## 8. Verification walkthrough (Phase P step 8)

`docs/VERIFICATION.md` is the click-through per role (owner, sales director, area manager, sales
rep, finance officer, inventory manager, admin): 84 lines, each with its URL, clicks (English
labels with the Arabic in brackets, from `messages/`), expected result and status. 77 lines are
automated, one Playwright test per line titled with the line id, in
`tests/e2e-local/verification.spec.ts` (helpers in `tests/e2e-local/verify/`, config
`playwright.verify.config.ts`); 7 are Planned (Google keys, the phone, the auth admin API, print
and Excel checks). Only the owner sets a line to Verified.

| Mode | Command | Runs |
|------|---------|------|
| Local | `pnpm e2e:local:up`, then `PW_CHROMIUM_PATH=… pnpm e2e:local:verify` | All 77 automated lines against the local stack; the writing flows (old-system workbook, decision-B approvals, order → invoice → payment → commission → return, lead → prospect → pin, customer without a phone) run in order and create their own records, so the run repeats on the same database. Passing is **Tested (local)**, never Verified (mock auth). |
| Preview | `VERIFY_BASE_URL=… VERIFY_EMAIL=… VERIFY_PASSWORD=… VERIFY_ROLE=<owner\|sd\|am\|rep\|finance\|inventory\|admin> pnpm verify:preview` | The 38 read-only lines of that role against a Vercel preview or staging, signed in with a real password (a test account the owner creates). Staging holds real data (decision A): writing lines and lines that need the local demo records are skipped with the reason; no screenshot, trace, video or failure page snapshot is kept; the session and Playwright's output live in a temporary folder deleted at the end. Not run yet (no test account). |

Local result on the step-8 commit: 77 passed, 0 failed, 0 skipped. Preview mode exercised against
the local stack for all seven roles: 38 passed, the rest skipped, nothing left on disk.
