# Decisions — Honest OS

> Architecture Decision Records (ADRs) plus the **open decisions that need the owner** (deliverable #10). · Last updated: 2026-10-28
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
| D-13 | Moving stock from quarantine into a sellable warehouse requires `inventory.quarantine.release` (inventory manager by default) | Adopted 2026-10-30, owner may change |

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

### D-13 · Releasing quarantine stock
- **Problem (audit 2026-10-30, F3):** returned or recalled goods received into a quarantine warehouse could be made sellable by an ordinary transfer, with no control.
- **Decision:** a transfer from a non-sellable warehouse into a sellable one needs the permission `inventory.quarantine.release`. It is checked when the transfer is created and again when it is received. The inventory-manager role holds it by default; the owner holds everything. Every transfer is audited.
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
| 2026-10-29 | Independent audit: 15 findings, all fixed (`docs/security/audit-2026-10-29.md`). Rules adopted from it: **(a)** quarantine/transit/inactive stock is never sellable; **(b)** no order of a blocked or archived customer advances; **(c)** adjustment limits are cumulative per user, warehouse and variant per Cairo day; **(d)** a person decides at most one stage of an approval (separation of duties); the owner therefore cannot single-handedly approve a two-stage request; **(e)** internal SECURITY DEFINER functions are client-callable only if an RLS policy or view needs them (test 17); **(f)** the app auto-retries only roll-back-certain database errors; **(g)** the service worker never caches pages. | Tech lead (owner may override (c) window or (d)) |
