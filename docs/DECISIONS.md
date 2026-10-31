# Decisions — Honest OS

> Architecture Decision Records (ADRs) plus the **open decisions that need the owner** (deliverable #10). · Last updated: 2026-10-30
>
> ADR status values: **Proposed** (awaiting owner approval) → **Accepted** → **Superseded**.
> As of 2026-10-28, all ADRs in Part B are **Accepted** (owner delegated, D-04). ADR-020, ADR-022 and ADR-023 remain conditional on D-03, D-05 and D-01 respectively.

---

## Part A — Critical decisions

On 2026-10-28 the owner delegated these decisions ("do whatever the right things and recommend the right thing for now"). Each recommendation below is therefore **adopted as the working decision**. Items marked **needs facts** still depend on information only Honest® can supply. Their working decision is designed so that the facts can change it without rework, and the phase that depends on them will not go live until they are confirmed.

| ID | Working decision (adopted 2026-10-28) | Status |
|----|----------------------------------------|--------|
| D-01 | Honest OS issues invoices and owns operational AR; GL stays with accounting | Adopted, **needs facts** (U-03) before Phase 4 |
| D-02 | Prefer sending invoices to an existing ETA-capable accounting system; otherwise direct ETA integration in Phase 4 | Adopted, **needs facts** before Phase 4 |
| D-03 | Supabase eu-central-1 + Vercel fra1; **synthetic data only** until a PDPL opinion clears real personal data | Adopted, **legal review required** before production data |
| D-04 | Stack and architecture as proposed (ADR-001…ADR-005) | **Accepted**. Phase 2 started. |
| D-05 | Collected, VAT-exclusive, rep on the order, 90-day clawback, no threshold; implants 5%, burs/instruments 1.5% | Adopted, confirm before Phase 4 |
| D-06 | Reps hold no stock in the MVP (rep stock warehouses remain supported) | Adopted |
| D-07 | Honest OS is the stock and price master; Shopify receives stock and price, and sends orders | Adopted, confirm before Phase 6 |
| D-08 | Two owner accounts with MFA; company-held GitHub/Supabase/Vercel orgs | Adopted, **owner action** |
| D-09 | Over-limit orders route to approval | Adopted |
| D-10 | Make.com for non-critical automations | Adopted |
| D-11 | Arabic default (RTL), Western digits | Adopted |
| D-12 | 14% VAT on all products until the accountant says otherwise | Adopted, confirm before Phase 4 |
| D-14 | Work-hours location tracking on company devices, during an open shift only (supersedes ADR-010's "no continuous tracking") | Adopted 2026-10-30 by owner request; **legal review (D-03) required before real use** |
| D-13 | Moving stock out of quarantine (to any non-quarantine warehouse) requires `inventory.quarantine.release` (inventory manager by default) | Adopted 2026-10-30, owner may change |

Details of each decision (options considered and the recommendation's reasoning) follow.

### D-01 · Who owns invoicing and the general ledger? **Blocks Phase 4**
- **Options:**
  1. Honest OS issues all invoices and owns AR. An accounting system or accountant keeps the GL and receives exports.
  2. The accounting system issues invoices; Honest OS imports them and owns collections and KPIs only.
  3. Honest OS replaces the accounting system entirely.
- **Recommendation:** **Option 1.** Orders, fulfilment and invoices must stay in one transaction chain for stock, credit and commission integrity. The GL stays with accounting (A-03). Option 3 is out of scope for an SME build; accounting is a regulated, mature product category.
- **Needed from you:** which accounting system or accountant you use today (U-03).

### D-02 · How will ETA e-invoices be produced? **Blocks Phase 4**
- **Options:**
  1. Honest OS integrates directly with the ETA API (needs ERP registration, signing via HSM/USB token, document mapping).
  2. Honest OS sends invoice data to an accounting system or ETA connector that already signs and submits.
  3. Manual entry on the ETA portal (not sustainable).
- **Recommendation:** **Option 2 if your accounting provider already submits to ETA**, otherwise Option 1 scheduled in Phase 4 with an early sandbox spike. The schema already stores `eta_uuid` and `eta_status`.
- **Needed from you:** are you already issuing ETA e-invoices, and from which system? Who holds the signing token?

### D-03 · Hosting region and PDPL cross-border transfer **Blocks loading real personal data**
- **Options:**
  1. Supabase eu-central-1 (Frankfurt) + Vercel fra1, under the PDPL cross-border safeguards your counsel confirms.
  2. Egypt-hosted Postgres and app servers (higher cost and operations work; loses managed Supabase).
- **Recommendation:** **Option 1**, subject to a short legal opinion on PDPL cross-border transfer (licence/permit, consent, contracts) **before production data is loaded**. Development with synthetic data can proceed now.
- **Needed from you:** permission to request that opinion, or a contact for counsel.

### D-04 · Approve the core stack and architecture
- **Proposal:** Next.js + TypeScript + Tailwind/shadcn (PWA) · Supabase (Postgres, Auth, Storage) · Vercel · modular monolith · invariants in Postgres (ADR-001…ADR-005).
- **Needed from you:** approve, or name changes.

### D-05 · Commission policy details
- **Default proposal (A-04):**
  - Earned on **collected** revenue, **excluding VAT**, credited to the rep on the order.
  - 90-day clawback on returns.
  - No minimum-achievement threshold unless you set one.
  - Implants 5%, burs and instruments 1.5%, other categories at a plan default you choose.
- **Needed from you:** confirm or correct each point (U-10).

### D-06 · Do reps carry stock (van or consignment stock)?
- **If yes:** each rep becomes a `rep_stock` warehouse, with transfers to and from the main warehouse, and sales are issued from the rep's stock.
- **If no (default A-07):** all fulfilment comes from company warehouses.
- **Needed from you:** yes or no, and the number of warehouses (U-02).

### D-07 · Shopify's role and inventory direction
- **Options:**
  1. Honest OS is the stock and price master and pushes to Shopify; Shopify orders flow into Honest OS.
  2. Shopify stays independent (separate B2C stock).
  3. Retire Shopify for B2B.
- **Recommendation:** **Option 1** (single stock truth).
- **Needed from you:** who buys on Shopify today (clinics? patients?), and whether Shopify prices equal B2B list prices (U-12).

### D-08 · Number of owners and the break-glass holder
- **Recommendation:** two owner accounts with MFA. The Supabase organisation owner and the GitHub organisation owner should be company-held accounts, not a developer's personal account.

### D-09 · Credit limit behaviour
- **Options:**
  1. Block orders above the credit limit.
  2. Route them to approval.
  3. Warn only.
- **Recommendation:** **Option 2** (approval by the Sales Director or Finance), configurable per customer.

### D-10 · Automation platform
- **Recommendation:** **Make.com** for non-critical notifications and reports. You already use it, and the outbox design makes switching to n8n or code cheap later (ADR-016). Confirm.

### D-11 · Default language and digits
- **Default:** Arabic UI (RTL) with Western digits for SKUs, amounts and phone numbers; English available per user. Confirm or choose Arabic-Indic digits.

### D-12 · Product tax treatment
- **Default:** 14% VAT on all products (A-09). Confirm with your accountant whether any medical devices are exempt or zero-rated (U-09).

### D-14 · Work-hours tracking of field reps (owner request, 2026-10-30)
- **Request:** during the 8-hour working day, track each rep's location on the company-issued device, to see where they are, idle time, number of visits and the time spent at each visit.
- **Working design (defaults; the owner may change any value in `core.system_settings`):**
  - **When:** only while a shift is open. The rep taps "Start my day" and "End my day". The server refuses location points outside an open shift and closes any shift that is still open after 10 hours.
  - **Working week:** Sunday–Thursday, 09:00–17:00 Cairo time.
  - **Sampling:** one point every 5 minutes (lat/lng, accuracy, device time), uploaded in batches. Points are idempotent by client id, and they queue offline.
  - **Derived facts:** visits and visit durations (from check-in/out), stops of 30 minutes or more away from any visit or customer location, gaps of 20 minutes or more with no points, and distance travelled. These are flags for a manager to review, never automatic penalties.
  - **Who sees it:** the rep sees their own. Managers see their team, via the new permission `field.tracking.read`, scoped by team. The owner sees everyone.
  - **Retention:** raw points for 90 days; daily summaries are kept.
  - **Transparency:** a notice the rep must acknowledge (versioned and stored on the server) before the first shift, and a visible "tracking is on" indicator while a shift is open.
- **Technical limit (V-06):** a web app in the browser can only collect points while it is open with the screen on. Reliable background tracking needs a small native Android app on the company devices (for example the same app wrapped with Capacitor, plus a background-location service with a permanent notification). **Phase 1** builds the server side, the manager screens and the in-browser collector. **Phase 2** adds the native collector, once the device platform (assumed Android) is confirmed. Phase 2 is **Implemented** (2026-10-30): the Capacitor Android shell in `mobile/` (ARCHITECTURE §2.8). It has not run on a phone yet.
- **Legal:** location tracking of employees is personal data under Egypt's PDPL (Law 151/2020). Before real use:
  - add this to the D-03 legal review;
  - inform employees in writing (policy or contract annex);
  - keep it to working hours and to the stated purpose.

### D-13 · Releasing quarantine stock
- **Problem (audit 2026-10-30, F3):** returned or recalled goods received into a quarantine warehouse could be made sellable by an ordinary transfer, with no control.
- **Decision:** a transfer that takes stock out of a quarantine warehouse into any other kind of warehouse needs the permission `inventory.quarantine.release`. Transit counts too; otherwise stock could go quarantine → transit → main in two steps. It is checked when the transfer is created and again when it is received, against the source warehouse's scope. Shipping is not checked, because stock in transit is not sellable. The inventory-manager role holds it by default; the owner holds everything. Every transfer is audited.
- **Alternative kept open:** route each release through an approval (`wf`) instead, if Honest® wants a second person to check recalled lots. That can be added without changing data.

---

## Part B — Architecture Decision Records (Proposed)

| ADR | Decision | Rationale (short) | Alternatives rejected | Consequences |
|-----|----------|-------------------|-----------------------|--------------|
| ADR-001 | Modular monolith (one Next.js app, one Postgres DB, schema per module) | Small team; cross-module transactions | Microservices; separate API service | Must police module boundaries in review |
| ADR-002 | Next.js App Router + React + TypeScript (strict) + Tailwind + shadcn/ui | RSC reduces JS on low-end phones; server layer holds secrets | Vite SPA, Remix, SvelteKit, Flutter | Pin versions; follow App Router caching rules |
| ADR-003 | Supabase (Postgres, Auth, Storage, Realtime, pg_cron) | Relational integrity + RLS + managed ops | Firebase, self-hosted, Neon + Clerk + S3, Odoo customisation | Region question (D-03) |
| ADR-004 | Business invariants in Postgres `api.*` functions (SECURITY DEFINER, `search_path=''`) | One enforcement point for all entry paths; atomic | TS-only services with service role | Requires SQL review discipline and pgTAP |
| ADR-005 | PostgREST exposes only `api`; RLS **enabled, not forced**; tables and definer functions share an owner | Tight surface; avoids definer/RLS recursion (found in testing) | All tables in `public`; FORCE RLS | Verify Supabase role behaviour in Phase 2 (R-17) |
| ADR-006 | Authorization = permission catalogue + roles with scope & limit + user role bindings + overrides (deny wins) | Covers RBAC + ABAC needs without a policy language | Hard-coded roles; JSON policy engine (OPA/Cedar) | Scope set is fixed (own/team/territory/department/warehouse/all); extend by migration |
| ADR-007 | Owner role = implicit all permissions; DB guard keeps ≥ 1 active owner; owner role undeletable | Prevents lock-out; new permissions never orphan the owner | Owner as an ordinary role | Owner accounts must use MFA |
| ADR-008 | Permissions are not embedded in the JWT; resolved from DB per request | Immediate revocation/suspension | Custom JWT claims | Slight per-query cost; cache table later if needed |
| ADR-009 | Schema managed by Supabase CLI SQL migrations; types generated; no ORM-owned schema | RLS, functions and triggers are SQL-first | Prisma/Drizzle migrations | Query layer uses supabase-js RPC/views |
| ADR-010 | GPS = verified check-in/out fixes only; no background tracking; raw fixes kept 12 months | Browser limits; privacy proportionality | Continuous tracking; native app | Cannot detect mock-location apps; mitigated by anomaly flags |
| ADR-011 | Haversine SQL function instead of PostGIS for MVP | Only distance needed | PostGIS | Revisit for maps or routing |
| ADR-012 | Leads, prospects and customers in one `crm.customers` table with `lifecycle_stage` | No conversion copy; single duplicate check | Separate `leads` table | Lead-only fields stay nullable |
| ADR-013 | All stock is lot-based; untracked items use a `NO-LOT` lot | One balance key; FEFO and recalls work everywhere | Nullable lot in the balance key | One extra lot row per untracked variant |
| ADR-014 | Integer base-unit quantities; `numeric(14,2)` money; `currency` column | Exactness; future multi-currency | Floats; implicit currency | UoM conversions handled at variant level |
| ADR-015 | KPI formulas are code-registered metric functions; definitions, targets and weights are data | Consistent and safe numbers across dashboards and AI | User-entered SQL/formula language | New metric types need a developer |
| ADR-016 | Transactional outbox + code dispatcher; Make.com consumes signed webhooks and never writes business data | Atomic events, retries, swappable consumers | Triggers calling webhooks; Make writing to the DB | Dispatcher cron must be monitored |
| ADR-017 | PWA with an IndexedDB command queue; offline orders are drafts only | One codebase; server-side pricing kept | Native apps; full offline ordering | Submitting an order requires connectivity |
| ADR-018 | `next-intl`, locale in URL, Arabic default, RTL via logical CSS properties | Clean RTL/LTR support | Runtime CSS flipping | All components must use logical properties |
| ADR-019 | Status columns as `text + CHECK`, not enums | Evolvable | Postgres enums | Slightly weaker typing; generated TS unions from CHECK lists |
| ADR-020 | Region eu-central-1 / fra1 (pending D-03) | Lowest latency to Cairo among managed regions | US regions; Egypt self-host | Legal review required |
| ADR-021 | AI = Claude API with whitelisted read-only tools executed under the user's JWT; numbers must cite tool results; Phase 7 | Traceable, permission-safe answers | Text-to-SQL; AI with write tools | Tool set limits what can be asked |
| ADR-022 | Commission basis = collected, VAT-exclusive (pending D-05) | Aligns pay with cash | Invoiced basis | Commission arrives later for reps |
| ADR-023 | Honest OS owns operational AR; GL in the accounting system (pending D-01) | Focus; regulatory maturity of accounting tools | Build full accounting | Needs an export/sync to accounting |

---

## Part C — Decision log (resolved items)

| Date | Decision | By |
|------|----------|----|
| 2026-10-28 | Repository cleared; Honest OS starts from scratch on branch `ccr-cd8ec6c2-y28xig` | Owner (request) |
| 2026-10-28 | Owner delegated D-01…D-12 to the recommended options (Part A table); D-04 accepted, Phase 2 started | Owner (delegation) |
| 2026-10-28 | DB tests are written in pgTAP syntax. Locally they run against a test-only pgTAP-compatible shim on plain PostgreSQL 16, because this build environment cannot install pgTAP or run Docker. On Supabase they run with real pgTAP via `supabase test db`. | Tech lead |
| 2026-10-28 | Package manager: pnpm. Node 22 LTS. TypeScript 6.0 (7.x is the new native compiler; Next.js tooling compatibility unverified). | Tech lead |
| 2026-10-28 | **`service` schema** (ADR-024): functions only `service_role` may execute, such as the outbox claim/result. It is exposed to PostgREST next to `api`, but `authenticated`/`anon` have no usage on it, so service-only code never sits in `api`, where the blanket grant to `authenticated` would expose it. | Tech lead |
| 2026-10-28 | Every view is `security_invoker` (ADR-025). Plain views skip RLS; this was found to leak customer balances and has been fixed. Enforced by test 15. | Tech lead |
| 2026-10-28 | Approval requests always carry subject employee + territory/warehouse context, filled by trigger (ADR-026), so scope-limited approvers work for every request creator. | Tech lead |
| 2026-10-28 | ~~Customer GPS location is set only by `crm.customer_location.verify` holders or by an approved `no_customer_location` visit exception.~~ **Superseded 2026-10-29:** the approved exception no longer pins the location, because the audit showed a rep could use it to pin the clinic anywhere. Only `crm.customer_location.verify` holders set the location. | Tech lead (owner may override) |
| 2026-10-28 | GPS fix retention cannot be set below 30 days. Purges are logged as security events. | Tech lead |
| 2026-10-28 | D-09 detail: an order over its credit limit routes first to Finance (`wf.decide.credit_limit`), then to discount approval if the discount was also exceeded. Area managers cannot approve credit breaches. The Sales Director has no credit authority by default. | Tech lead (owner may override) |
| 2026-10-28 | `/` always opens Arabic; browser-language detection is off (D-11). | Tech lead |
| 2026-10-28 | Suspending a user also bans the Supabase Auth account (ends refresh tokens); reactivating lifts it. The DB status gate remains the primary control. | Tech lead |
| 2026-10-30 | AR defaults: VAT comes from the order line's snapshot (default 14%); due date = the order's payment terms (customer default 0 days); finance's own non-cheque payments are confirmed at recording, and cheques always wait until they clear; credit notes always go through the `finance.credit_note` approval; a credit may not exceed the invoice's open amount; the allocation limit applies per allocation command. | Tech lead (owner may override) |
| 2026-10-30 | KPI attribution: invoices are credited to the order's rep, or else to the customer's primary rep; AR goes to the current primary rep; payments go to whoever collected them. Open AR counts positive balances only. An employee target overrides a role target. `REVENUE_ACHIEVEMENT` stays draft (wrong unit in the seed); `NET_REVENUE` is used instead. | Tech lead (owner may override) |
| 2026-10-30 | Tracking as built: area managers and the sales director also hold `field.shift.start` (the role-grant ceiling requires it); shifts and points are kept out of the 7-year audit log so that the 90-day purge works, while notices and acknowledgements are audited; points synced after "End my day" are accepted if they fall inside a shift window (± 120 s) **and that shift ended less than 24 h ago** (2026-11-01 audit). Further limits from that audit: at most 240 points per shift, points closer than half the sampling interval are refused, a new shift cannot overlap the previous one (`overlap_clamped`), retention is counted from capture time, and the day view lists at most 1,000 points. Settings: `tracking.max_points_per_shift`, `tracking.late_point_grace_hours`, `tracking.max_day_points`. | Tech lead (owner may override) |
| 2026-10-30 | Staging runs on Vercel **Hobby**, which allows only daily cron jobs, so `vercel.json` runs `/api/cron/outbox` once a day (03:17 UTC). **Before go-live: Vercel Pro (Hobby is non-commercial) and restore `*/2 * * * *`**, or trigger the dispatcher from Supabase `pg_cron` + `pg_net`. No outbox consumers exist yet, so staging loses nothing. | Tech lead |
| 2026-10-29 | Independent audit: 15 findings, all fixed (`docs/security/audit-2026-10-29.md`). Rules adopted from it: **(a)** quarantine/transit/inactive stock is never sellable; **(b)** no order of a blocked or archived customer advances; **(c)** adjustment limits are cumulative per user, warehouse and variant per Cairo day; **(d)** a person decides at most one stage of an approval (separation of duties); the owner therefore cannot single-handedly approve a two-stage request; **(e)** internal SECURITY DEFINER functions are client-callable only if an RLS policy or view needs them (test 17); **(f)** the app auto-retries only roll-back-certain database errors; **(g)** the service worker never caches pages. | Tech lead (owner may override (c) window or (d)) |
| 2026-10-30 | **Security headers (wave 2):** every page gets a per-request nonce CSP from `src/proxy.ts` (`script-src 'self' 'nonce-…' 'strict-dynamic'`, `frame-src 'none'`, `object-src 'none'`, `frame-ancestors 'none'`). `style-src` allows `'unsafe-inline'`, because React `style={}` attributes and Next's injected styles cannot carry nonces. `upgrade-insecure-requests` is sent only in production over HTTPS, HSTS only in production. `Permissions-Policy` allows geolocation for the app only; camera, microphone and payment are off. Pages must stay dynamically rendered for the nonce to work. | Tech lead |
| 2026-10-30 | **CSV exports:** orders, order lines and customers also need `sales.order.export` / `crm.customer.export` (AUTHORIZATION §2 level 7). The row cap is the env var `REPORTS_EXPORT_MAX_ROWS` (default 50,000, hard maximum 200,000), not a setting. Statuses export as codes, money as plain 2-decimal numbers, times in Cairo. | Tech lead (owner may override) |
| 2026-10-30 | **MFA step-up:** one global switch `security.mfa_enforced` (ships `false`) plus a per-permission flag `authz.permissions.requires_mfa`. `authz.require` checks the permission first, then MFA, so a non-holder never learns about MFA. Owners are included. The first set added `admin.override.manage`, because an override is as powerful as a role grant. The set was extended by the audit-4 rows below. The switch is global rather than per role, for simplicity. | Tech lead (owner may override) |
| 2026-10-30 | **Audit row images:** readable only through the masked, logged reader. `audit.row_image.read` and `audit.row_image.unmask` are owner-only by default (scope `all`, no role grants). Because of the grant ceiling only an owner can delegate them, for example to an external auditor; that is allowed. | Tech lead (owner may override) |
| 2026-10-30 | **Android shell (D-14 phase 2):** a Capacitor remote-URL WebView with `@capacitor-community/background-geolocation` replaces the browser collector inside the app. `source = 'native'` is accepted unattested and is advisory only (nothing branches on it). Reps can also sign in with an email code (same Magic Link email, `shouldCreateUser: false`). | Tech lead |
| 2026-10-30 | **Offline order drafts:** draft saves are queued and replay-safe (key = order + base version, recorded in `sales.order_draft_saves`). Submit stays online-only (A-05). Offline prices are the DEFAULT list price, labelled "indicative". | Tech lead |
| 2026-10-30 | **Invoice write-off:** finance officers decide write-offs (`wf.decide.write_off`, scope all, no EGP limit by default). A write-off is VAT-inclusive with no VAT bad-debt relief (accountant to confirm, D-01/D-12). Partial write-offs are allowed. Write-offs do not change net revenue or collection rate. | Tech lead (owner may override) |
| 2026-10-30 | **Returns:** interim rule: only invoiced goods can be returned (returnable = the least of delivered − returned per lot and invoiced − non-return credits − returned per line). A return credit note skips the `finance.credit_note` workflow, because the return was approved and received and the amounts come from the invoice; it carries the return's `approval_request_id`. `wf.decide.return` has no EGP limit. Paid invoices: see the audit-4 M-1 row. | Tech lead (owner may override) |
| 2026-10-30 | **Imports:** `admin.import.run` is owner-only (sensitive, scope all, no role grants) and `requires_mfa`. A batch can also be `discarded`. Opening AR posts `opening_balance` ledger entries, not open invoices, so it shows in balances and statements but not in aging or overdue. Imported customers start as `lead`. | Tech lead (finance may revisit opening AR) |
| 2026-10-30 | **Workflow administration:** rules use the existing `admin.workflow.manage`. Every workflow keeps one catch-all rule. Escalation moves one level per run, at most `wf.escalation.max_levels` (3), with the owners as last resort; the requester and subject are never targets. Delegations are capped at `wf.delegation.max_days` (90). Non-owners cannot route a stage to themselves. Only owners can make a rule auto-approve (extended by audit-4 A-M4). `wf.delegation.manage`: sales director team; area manager, inventory manager and finance officer own. | Tech lead (owner may override) |
| 2026-10-30 | **Performance:** every foreign key in the domain schemas has a covering index (suite 40). SQL functions that compute an authz scope use `as materialized` CTEs or `(select …)`, because `set search_path = ''` stops SQL function inlining. JIT: off on Supabase by default (checked on staging 2026-10-31; re-check on prod). | Tech lead (JIT: owner) |
| 2026-10-30 | **Visit planning:** working defaults: visit class intervals A/B/C = 7/14/30 days, default class C, at most 8 planned visits per day, working days Sunday–Thursday. `field.visit.plan`: rep own; area manager and sales director team. Setting a customer's visit class needs `crm.customer.update` at team scope or wider, so a rep cannot lower their own target. Coverage counts completed visits by any employee. | Tech lead (owner may override) |
| 2026-10-30 | **Owner-only settings:** `security.*`, `tracking.*`, `finance.payment.*` and `commission.*` keys are owner-only by table CHECK, as are VAT, visit-GPS retention, `company.timezone`, `company.currency`, the company tax and commercial-register numbers, and (audit-4 A-L3) `wf.delegation.*` / `wf.escalation.*`. Only keys with a `core.setting_definitions` row can be changed. | Tech lead (owner may override) |
| 2026-10-30 | **Commissions as built (D-05):** the 90-day clawback window applies to credit notes only and is measured from the invoice's latest standing collection. A credit note claws back only the part above the line's uncollected amount, and the money freed re-allocates to the invoice's other open lines. Reversals and bounces always claw back. Goodwill (amount-only) credits never claw back. `min_achievement_pct` is ignored (no threshold). Plan `STD-2026` ships `draft`, so nothing earns until the owner activates it. | Tech lead (owner may override) |
| 2026-10-30 | **Audit 4 M-2/M-3:** import commits are serialised per kind by a transaction advisory lock taken before re-validation. Opening AR is also backstopped by a one-per-customer unique index; opening stock relies on the lock under READ COMMITTED. Draft-save replays re-run the customer and owner scope checks and keep their full answer, because the device and suite 36 rely on the replay answer's totals. | Tech lead |
| 2026-10-30 | **Audit 4 M-1, returns on paid or partly paid invoices:** the customer is credited the full return value. The part up to the invoice's open amount reduces the invoice; the excess is released from the invoice's payment allocations and stays as unallocated customer credit, applied to later invoices with `allocate_payment`. Never cash. Commission clawback follows the credit note (90-day rule); release rows are not commission events. Cash refunds: owner kept customer credit only (2026-10-31). | Tech lead, confirmed by owner |
| 2026-10-30 | **Audit 4 M-1, cancelling returns:** a pending return can be cancelled by its requester only; an approved return that was not received, by holders of `wf.decide.return` (customer in scope) or `sales.return.receive`. Received or later: not cancellable. Partial receipt is deferred. | Tech lead (owner may override) |
| 2026-10-30 | **Audit 4 M-5:** closing a commission month needs no workflow approval. The automatic freeze (cron on day 6, `approved_by` NULL) is the approval; a manual early close by a `perf.commission.calculate` holder needs MFA step-up. The seeded `perf.commission_period` workflow stays unused. Revisit if the owner wants a second sign-off. | Tech lead (owner may override) |
| 2026-10-30 | **Audit 4 A-M1, gated set:** `requires_mfa` also covers `admin.settings.manage`, `admin.workflow.manage`, `audit.row_image.unmask`, `wf.decide.write_off`, `sales.return.credit`, `perf.commission.calculate` and (A-L4) `crm.customer.export`, `sales.order.export`. A workflow stage decided by a gated permission needs aal2 to approve and to reject. Employment (de)activation reuses the `admin.user.suspend` step-up; manager, department, territory-assignment and territory-move changes reuse `admin.role.assign`. Moving between active and on leave is not gated. | Tech lead |
| 2026-10-30 | **Audit 4 A-M3, effective owner:** profile active + employment active or on leave (or no employee record) + owner role active, not revoked and inside `valid_from`/`valid_to`. One predicate, `authz.is_effective_owner`, is used by every last-owner guard, and one advisory lock, `authz.lock_owner_set()`, serialises owner-affecting changes. | Tech lead |
| 2026-10-30 | **Audit 4 A-L1/A-M4, workflow authority:** escalation authority is checked at decision time. Owners always qualify. Permission and role stages need the stage's own eligibility (scope and limit), so escalating them widens who is notified, not who may decide. User and manager stages need a live chain or fallback link plus `wf.approval.read` in scope. Auto-approve rules are owner-only end to end, and a non-owner may not change the condition of a rule checked before an auto-approve rule, even to broaden it (moving it forward is allowed). | Tech lead |
| 2026-10-30 | **Audit 4 A-H1:** while MFA enforcement is on, every `security.*` setting write needs aal2, owners included. Switching enforcement on at aal1 is allowed: it only tightens access, and enrolment at `/account/security` is not gated. | Tech lead |
| 2026-10-30 | **Audit 4 F1, Android bridge:** keep `useLegacyBridge` for background callbacks and replace its inbound path with a guarded `addWebMessageListener` (top frame, `server.url` origin, plugin and method allow-list) rather than drop the flag; upstream has no non-legacy option that keeps background callbacks. The page CSP is also delivered as a meta tag (header policy minus `frame-ancestors`). | Tech lead |
| 2026-10-30 | **Audit 4 F3, Android pilot signing:** the pilot uses a non-debuggable release-type APK signed with the SDK debug keystore (no production keystore yet). Production requires a keystore from GitHub secrets. | Tech lead |
| 2026-10-30 | **Audit 4 F7, email codes:** 8 digits valid for 10 minutes (`otp_length = 8`, `otp_expiry = 600`). During the hosted rollout the app also accepts 6 digits, because Supabase checks the code itself. Login strings state no digit count. | Tech lead |
| 2026-10-30 | **Audit 4 A-L4/A-LM2, exports and masking:** exports are gated and audited in the DB by `api.log_export` (fail closed) plus `api.log_export_result` for the final count. Rate limit: 20 per user per 10 minutes, a constant until a setting exists. Only `crm.customer.export` and `sales.order.export` are MFA-gated; per-kind export codes were approved on 2026-10-31. Audit masking matches keys case-insensitively and errs toward over-masking; location and geometry containers are masked whole (`container_only`). | Tech lead (owner: export codes) |
| 2026-10-30 | **Audit 4 F2/F5/F6, planning:** `generate_plan` takes at most 1000 customers per call (most due first) and checks a 5 s in-function budget instead of `statement_timeout`. A customer outside the caller's read scope is refused as `NOT_ASSIGNED` without its number (not `NOT_FOUND`), so hidden and unassigned customers look the same. Only the planner, or someone with `field.visit.plan` scope over the planner, removes a visit someone else planned; visits without a recorded planner keep the old rule. | Tech lead |
| 2026-10-31 | **Owner approved the tech lead's recommendations ("do what is recommended").** (1) Vercel Authentication protects preview deployments only; the production staging URL is reachable without a Vercel account, behind the app's own login, RLS and server checks. (2) Returns on paid invoices stay customer credit, never cash; a cash refund needs a separate finance command and decision later. (3) Every export kind gets its own `<module>.<resource>.export` permission, MFA-gated, granted to the roles that export today. (4) The four duplicate indexes are dropped (`20261104001000`, written approval for rule 9; no data is deleted). (5) Dependabot opens weekly update PRs for the SHA-pinned workflow actions. | Owner |
| 2026-10-31 | **JIT:** Supabase staging already runs with `jit = off` (server default), so no `alter role` is needed. Check it again on the production project. | Tech lead |
