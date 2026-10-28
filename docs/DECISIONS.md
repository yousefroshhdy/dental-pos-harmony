# Decisions — Honest OS

> Architecture Decision Records (ADRs) plus the **open decisions that need the owner** (deliverable #10). · Last updated: 2026-10-28
>
> ADR status values: **Proposed** (awaiting owner approval) → **Accepted** → **Superseded**.

---

## Part A — Critical unresolved decisions (owner input required)

Listed in order of how much they block. For each: options, recommendation, and what happens if it is not answered.

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
