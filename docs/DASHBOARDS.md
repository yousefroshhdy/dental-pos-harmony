# Dashboards, KPIs & Reporting — Honest OS

> Status: **Specified; KPIs, dashboards, commissions and exports implemented** · Phase 1 deliverable #7 (+ KPI engine rules from §7 of the brief) · Last updated: 2026-10-30

Every metric has: **id, definition, formula, data source, period, attribution and edge-case rules**. Dashboards read registered metric functions (`perf.metric_*`) or `api` views. They never use ad-hoc client calculations, so one number means the same thing on every screen, in every report and in the AI assistant.

---

## 1. Global metric rules (prevent double counting)

| Rule | Definition |
|------|------------|
| **Revenue** | Invoiced net revenue = Σ invoice line `(unit_price × qty − discount)`, **excluding VAT**, minus credit notes (excluding VAT) dated in the period. Orders are pipeline, not revenue. |
| **Booked sales** | Σ order totals (excluding VAT) of orders that reached `submitted`/`approved` in the period, minus orders later `cancelled`/`rejected` (reversed in the period of cancellation if the original period is closed). |
| **Attribution** | To the rep on the order (`sales.orders.employee_id`) and the territory **snapshotted at submit** (`orders.territory_id`). Reassigning a customer later **does not** move historical revenue. Future orders follow the new owner. |
| **Returns** | Reduce revenue in the period the credit note is issued. They do not restate closed periods. |
| **Cancellations** | A cancelled order never counts as revenue. If it was counted as booked in a closed period, the reversal posts in the cancellation period. |
| **Partial payments** | Collections count the allocated amount on the allocation date. Unallocated payments count in "cash received" but not in "collection efficiency" until allocated. |
| **Visits** | Count only `completed` visits. "Verified visits" adds `verification_status in ('verified','exception_approved')`. Several visits to the same customer on the same day count once. |
| **New customer account** | A customer whose **first invoice** is in the period, credited to the rep who created/converted them (or the primary rep at first invoice, configurable). Leads or prospects without an invoice don't count. |
| **Period** | Calendar periods in `Africa/Cairo`. A period closes on day 5 of the next month; after close, `kpi_results.is_final = true` and the results are frozen. |
| **Currency** | EGP. VAT excluded from performance metrics; included in AR metrics (customers owe VAT). |

## 2. KPI catalogue (seed; targets editable by `perf.target.manage`)

| Code | Name | Type | Formula | Source | Period | Initial target |
|------|------|------|---------|--------|--------|----------------|
| `VISITS_COMPLETED` | Customer visits | Leading | count(distinct customer, day) of completed visits | `field.visits` | month | 70 |
| `VISITS_VERIFIED_PCT` | Verified visit rate | Leading | verified ÷ completed × 100 | `field.visits` | month | 90% |
| `NEW_ACCOUNTS` | New customer accounts | Lagging | customers with first invoice in period | `finance.invoices` | month | 5 |
| `FOLLOW_UPS_DONE` | Follow-up activities | Leading | tasks kind=follow_up completed + activities type ∈ (call, whatsapp, visit) linked to an open opportunity or task | `work.tasks`, `crm.activities` | week | 50 |
| `FOLLOW_UP_ON_TIME_PCT` | Follow-ups on time | Leading | completed ≤ due_at ÷ due in period × 100 | `work.tasks` | week | configurable |
| `COLLECTION_RATE` | Collection performance | Lagging | Σ allocations in period on invoices due ≤ period end ÷ (open AR at period start that is due + invoices issued and due within period) × 100 | `finance.payment_allocations`, `finance.invoices` | month | 95% |
| `REVENUE_ACHIEVEMENT` | Sales target achievement | Lagging | net invoiced revenue ÷ revenue target × 100 | invoices, credit notes, `perf.kpi_targets` | month | configurable |
| `CONVERSION_RATE` | Opportunity conversion | Lagging | opportunities won in period ÷ opportunities closed (won + lost) in period × 100 | `crm.opportunities` | month | configurable |
| `VISIT_TO_ORDER_RATE` | Visit conversion | Leading | visits with outcome `order_taken` (or an order linked within 3 days) ÷ completed visits | visits, orders | month | configurable |
| `AOV` | Average order value | Lagging | net revenue ÷ invoiced orders | invoices | month | — |
| `RETENTION_RATE` | Customer retention | Lagging | customers with an invoice in both the trailing-90-day window and the prior 90 days ÷ customers with an invoice in the prior window | invoices | quarter | configurable |
| `CRM_COMPLIANCE` | CRM compliance | Leading | completed visits with outcome + notes + next step recorded within 24 h ÷ completed visits × 100 | visits, tasks | month | configurable |
| `DSO` | Days sales outstanding | Lagging | (AR balance at period end ÷ revenue incl. VAT over last 90 days) × 90 | ledger, invoices | month | — |
| `CATEGORY_MIX` | Product category performance | Lagging | net revenue by category ÷ total | invoice items | month | — |
| `TERRITORY_PERFORMANCE` | Territory achievement | Lagging | territory revenue ÷ territory target | invoices (territory snapshot) | month | — |

**Scorecard** = Σ (min(achievement %, cap 150%) × weight) over the KPIs assigned to the employee, where Σ weights = 100. The cap stops one KPI from hiding another.

**KPI engine mechanics:**
- **Definitions** are rows in `perf.kpi_definitions`. Changing a formula means a **new version**; history keeps the version used.
- **`metric_key`** points to a **registered SQL function** (whitelist) such as `perf.metric_visits_completed(employee_id, from, to)`. Management can configure targets, weights, periods and assignees, but cannot type arbitrary SQL. That keeps it safe and consistent (ADR-015).
- **Calculation:** a nightly pg_cron job plus on-demand runs (manager clicks "refresh") write `perf.kpi_results` with a `source_snapshot` of the ids/counts used. The dashboard drill-down opens exactly those records.

## 3. Commission engine rules

| Rule | Default (A-04, pending D-05) |
|------|------------------------------|
| Basis | **Collected** revenue: commission is earned when a payment allocation lands on an invoice line, pro-rated by line, **excluding VAT** |
| Rate | Most specific rule wins: variant > category > brand > plan default. Seed: category IMPLANT 5.00%, BUR 1.50%, INSTRUMENT 1.50% |
| Earner | Rep on the original order (not the current customer owner) |
| Returns | A credit note within the clawback window (90 days, measured from the invoice's latest standing collection) creates a negative entry in the period of the credit note. **As built:** it claws back only the part of a line's credit above that line's uncollected amount, and the money freed re-allocates to the invoice's other open lines. Goodwill (amount-only) credits never claw back. A return on a paid invoice is credited in full; the excess is released from the invoice's allocations as customer credit, and those **release rows (`payment_allocations.credit_note_id`) are not commission events**: the credit note alone carries the clawback, so nothing is clawed back twice |
| Allocation reversal / bounced cheque | Negative entry in the period of the event; always claws back, whatever the age |
| Eligibility threshold | Optional `min_achievement_pct` per plan (e.g. no commission below 60% revenue achievement). **As built: ignored** (D-05: no threshold) |
| Adjustments | Bonus, clawback or correction rows, each with a reason and an approval |
| Lifecycle | `open → calculated → approved → paid → locked`. Recalculating an approved period is blocked; corrections go to the next period. **Close rule (as built):** a month closes to `approved` either automatically (daily cron, once `perf.period_close_at`, day 6 Cairo, has passed; `approved_by` NULL) or manually and early, oldest open month first, by a `perf.commission.calculate` holder with an aal2 session when MFA is enforced. The freeze is the approval; the `perf.commission_period` workflow is not used. A late event in a closed month posts in the first open month |
| Statement | Per rep: lines (invoice, customer, product, collected base, rate, amount), adjustments, total |

**As built (2026-10-30):** `20261103000400_commissions.sql`, suites 37, 46 and 48; Implemented and Tested. The rate in force on the event day applies; the earner is `sales.orders.employee_id` (an invoice without an order earns nothing). Plan `STD-2026` ships `draft`, so nothing earns until the owner activates it. Statements: `/commissions` (my statement), `/commissions/team`, `/commissions/periods`, `/commissions/adjustments`.

Worked example:
- An implant order of 2 × EGP 1,000 with a 2% discount gives an invoice net of 1,960 + 14% VAT = 2,234.40.
- The customer pays 1,117.20 (half).
- Commission base = 1,117.20 ÷ 1.14 = 980.00, so commission at 5% = **49.00**. The second half earns another 49.00 when it is collected.

### 3.1 AR overdue history

`perf.overdue_invoices(as_of)` (AR_OVERDUE and the dashboards) subtracts write-offs, credits and allocations posted by `as_of`. It **no longer filters on the invoice's current status** (audit 2026-11-03 M-4), so a later full write-off does not remove an invoice from past overdue figures.

### 3.2 Visit coverage (planning)

Coverage per customer: target = max(1, round(period days ÷ class interval)), with intervals A/B/C = 7/14/30 days. Completed visits by any employee count, several on one Cairo day count once. Overdue = never visited, or the last completed visit is more than one interval ago (`api.coverage`).

## 4. Dashboards by role

| Dashboard | Users | Business questions | Widgets (chart type) | Filters | Refresh | Access |
|-----------|-------|--------------------|----------------------|---------|---------|--------|
| **Rep · Today** | Rep | What do I do today? Am I on track? | Planned visits list; due follow-ups; month progress rings for visits / new accounts / revenue vs target (progress ring); my overdue customers (list) | none (own scope) | live | own |
| **Rep · My performance** | Rep | How am I doing vs target and last month? | KPI scorecard (table + bullet charts); revenue trend 6 months (line); commission to date (stat) | period | nightly + on demand | own |
| **Manager · Team** | Area Mgr, Sales Dir. | Who is behind? Where are the gaps? | Rep scorecard table (sortable, RAG status); visits verified vs unverified (stacked bar per rep); pipeline by stage (funnel); approvals pending (list); missed follow-ups (list) | territory, rep, period, brand | live for lists, nightly for KPIs | team / territory |
| **Manager · Territory map** | Area Mgr, Sales Dir. | Coverage: which clinics are not visited? | Customers coloured by last-visit age (map; Phase 5); top dormant customers (list) | territory, specialty | nightly | territory |
| **Inventory** | Inventory Mgr | What will run out or expire? | Available vs reserved by SKU (table); below reorder (list); expiring 30/60/90 d (stacked bar by brand); stock value by warehouse (bar, cost-based, restricted); turnover & slow movers (table) | warehouse, brand, category | live | warehouse / all |
| **Finance · Receivables** | Finance, Collection | Who owes what, how late? | AR aging buckets 0–30/31–60/61–90/90+ (stacked bar); top 20 overdue (table); collections this month vs target (bullet); unallocated payments (list); cheques due this week (list) | territory, rep, customer, as-of | live | finance scopes |
| **Executive overview** | Owner, Exec | How is the company doing? What's at risk? | Revenue MTD/QTD vs target & vs last year (KPI tiles + line); revenue by brand / territory (bar); gross margin by brand (restricted; cost-based); AR total & overdue % (tiles); DSO trend (line); inventory value & expiring value (tiles); top risks feed (anomalies, large discounts, stockouts) | period, brand, territory | nightly KPIs + live tiles | `exec.page.overview` |
| **Workforce analytics** | Owner, Sales Dir. | Productivity and acquisition per rep/territory | Visits per rep per day (heatmap); new accounts by rep (bar); conversion funnel lead → active (funnel) | period, territory | nightly | all |
| **Admin · System health** | Admin | Is everything running? | Outbox status counts, dead letters, webhook failures, cron heartbeats, permission-denied spikes, last backup | — | live | admin |

**Visualisation standards:**
- Every tile has an ⓘ showing its definition and formula from this document.
- Every chart supports drill-down to the record list.
- Colour encodes status consistently (on-track / at-risk / off-track thresholds are configurable).
- The same palette works in RTL and dark mode.
- Numbers use Arabic-Indic or Western digits per user preference.

## 5. Scheduled reports

| Report | Audience | When (Cairo) | Content | Channel |
|--------|----------|--------------|---------|---------|
| Daily sales summary | Management list | 20:00 daily | Revenue/booked by territory & brand, top 5 reps, approvals pending, new overdue | Email (Make Scenario 6) |
| Weekly KPI summary | Dept managers | Sun 08:00 | Scorecards, at-risk reps, follow-up compliance | Email |
| Monthly performance | Executives | 1st 09:00 (after close on day 5, a final version) | Full KPI pack, AR aging, inventory risk, commissions summary | Email + PDF in Storage |
| Rep weekly digest | Each rep | Sat 18:00 | My KPIs, next week's planned visits, overdue customers | WhatsApp utility template / in-app |

**On-demand CSV exports (Implemented, Tested):** `/reports` and `GET /api/export/[kind]` for orders, order lines, invoices, payments, aging, visits, customers, stock and tracking, under the user's own session (RLS and view masking apply). **Every export is logged in `audit.security_events`** (`export` with kind, filters and request id, then `export_result` with the row count, truncation or failure) by `api.log_export`, which also enforces the kind's permissions, MFA for customers and orders, and at most 20 exports per user per 10 minutes. Rows are capped by `REPORTS_EXPORT_MAX_ROWS` (default 50,000).

Exports to Google Sheets and Looker Studio come only from **reporting views** (`report.*`, Phase 5) that contain aggregated, permission-appropriate data, refreshed nightly. Looker Studio never connects to base tables or with an owner credential.
