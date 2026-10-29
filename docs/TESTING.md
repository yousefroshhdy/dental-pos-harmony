# Testing Plan — Honest OS

> Status: **In use** · Last updated: 2026-10-28
>
> **Current suite (all passing locally):**
> - Database: 797 assertions in 23 pgTAP-format suites (`pnpm test:db`). The 577 assertions of suites 01–17 also pass on the real Supabase staging project with pgTAP 1.3.3 (2026-10-29)
> - Unit: 542 Vitest tests in 38 files (`pnpm test`)
> - End-to-end: 81 Playwright specs × 2 Chromium projects = 162 tests (`pnpm e2e:chromium`; set `PW_CHROMIUM_PATH=/opt/pw-browsers/chromium` in the cloud sandbox). The WebKit project has not been run yet.
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
- Headers: CSP (no `unsafe-inline` scripts), HSTS, frame-ancestors none.
- Uploaded files: type and size checks; private buckets; signed URLs with short expiry.

### 2.9 Performance
- Budgets: rep routes LCP < 2.5 s on throttled 4G (Lighthouse mobile), JS ≤ 200 KB gzipped, server p95 reads < 500 ms, commands < 1 s, with synthetic data of 50k customers, 1M movements and 200k visits.
- RLS cost: `EXPLAIN ANALYZE` on the customer list, order list and visits list for a rep and a director; must use indexes, with authz helpers as InitPlans.

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
