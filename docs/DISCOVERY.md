# Phase 0 — Discovery

> Status: **Draft for review** · Owner: Honest® management · Last updated: 2026-10-28

This document separates what is **confirmed**, what is **assumed**, and what is **unknown** about Honest® and its current operations. Nothing in the architecture assumes access to a system, an API, or a dataset that is listed here as unknown.

---

## 1. Confirmed (stated by Honest® management)

| # | Fact | Source |
|---|------|--------|
| C-01 | Honest® is an Egyptian B2B importer/distributor of dental products, selling to clinics, dentists and specialists. | Project brief |
| C-02 | Current brands: **Bioner** (implants, Spain), **Derby Instruments** (instruments, Italy), **RDT GmbH** (burs, Austria). | Project brief |
| C-03 | The catalogue will expand: bone grafts, membranes, sutures, endodontics, others. | Project brief |
| C-04 | Territories include Cairo & Giza, Mansoura, Delta, Alexandria, Upper Egypt, and must be dynamic. | Project brief |
| C-05 | Active field sales reps, existing customers, physical inventory, product-specific pricing, sales orders, customer collections, targets and KPI expectations exist today. | Project brief |
| C-06 | Public website on Framer + Frameship; commerce on Shopify; payments via Paymob. Website `honesteg.co`, checkout `checkout.honesteg.co`. | Project brief |
| C-07 | Operational spreadsheets and records exist. | Project brief |
| C-08 | No centralised operating system connects departments today. | Project brief |
| C-09 | Preliminary KPI baselines: 70 visits/month, 5 new accounts/month, 95% collection, 50 follow-ups/week. Must be editable. | Project brief |
| C-10 | Preliminary commissions: implants 5%, burs & instruments 1.5%. Must be configurable. | Project brief |
| C-11 | Preferred stack: Next.js, React, TypeScript, Tailwind, shadcn/ui, Supabase, Vercel, GitHub. Mobile-first PWA. | Project brief |
| C-12 | Arabic + English, RTL/LTR, EGP, Egyptian phone numbers, Egypt time zone. | Project brief |

## 2. Verified externally (public sources, 2026-10)

| # | Fact | Implication | Confidence |
|---|------|-------------|------------|
| V-01 | Egypt's Personal Data Protection Law No. 151/2020 has executive regulations (Ministerial Decree 816 of 2025, issued 1 Nov 2025), starting a one-year compliance period that ends around **Nov 2026**. They cover consent, licensing, record-keeping, breach notification, **cross-border transfers**, and direct electronic marketing. | Employee GPS data, customer contact data and WhatsApp marketing are in scope. Hosting outside Egypt (Supabase/Vercel regions are outside Egypt) raises a cross-border transfer question → **decision D-03**. | Medium-high. Law-firm summaries, not the gazette text itself. Legal counsel must confirm. |
| V-02 | The Egyptian Tax Authority (ETA) runs **mandatory B2B e-invoicing**: invoices are submitted as JSON/XML, digitally signed (HSM or USB token), validated **before** they are handed to the customer, and get an ETA UUID. Credit/debit notes reference that UUID. Seven-year retention is cited. | If Honest® is in scope (very likely), every invoice Honest OS issues must go through ETA, or invoices must stay in a system that already does this → **decisions D-01/D-02**. | Medium. Third-party guides; confirm against the ETA portal and Honest's tax registration. |
| V-03 | WhatsApp Business Platform charges **per delivered template message** (since 1 Jul 2025), by category (marketing, utility, authentication) and recipient country. Utility templates sent inside an open customer-service window are free. Egypt rates were cut in 2025. | Use utility templates for transactional messages (order confirmations, payment receipts, reminders). Marketing templates cost far more. | High on the model, low on the exact Egypt price (verify on Meta's rate card). |
| V-04 | Supabase Pro is $25/month including a $10 compute credit (covers Micro). Compute is billed separately; Pro includes 8 GB of database, 100 GB of storage, 250 GB of egress and 100k MAU. | Cost model in `docs/COSTS.md`. | Medium. Third-party summaries dated 2026; verify on supabase.com/pricing. |
| V-05 | Vercel Hobby is non-commercial; Pro is ~$20 per developer seat per month plus usage. Viewer seats are free. | Production must run on Vercel Pro. | Medium. Verify on vercel.com/pricing. |
| V-06 | Browser PWAs cannot reliably track location continuously in the background on iOS or Android. iOS web push works only when the PWA is installed to the home screen (iOS 16.4+). | GPS = **verified check-in/check-out**, not live tracking (ADR-010). Notifications must not depend only on push. | High. Platform behaviour. |

## 3. Unknowns that must be resolved (none are assumed in the design)

| # | Question | Why it matters | Blocks |
|---|----------|----------------|--------|
| U-01 | Where is customer data stored today (Excel? Google Sheets? Shopify customers? a phone list)? How many customers? | Migration design, de-duplication rules, data quality plan. | Phase 3 data migration |
| U-02 | Where are inventory records kept? Are lots/expiry tracked today? Is there one warehouse or several? Do reps carry stock (van/consignment stock)? | Warehouse model; whether reps are warehouses (D-06). | Phase 3 |
| U-03 | How are orders and invoices generated today? Is there an accounting system (Odoo, Daftra, QuickBooks, ERPNext, Excel, an external accountant)? Is Honest® already issuing ETA e-invoices, and from which system? | Biggest architectural fork: whether Honest OS issues legal invoices (D-01, D-02). | Phase 4 |
| U-04 | How are payments and collections recorded? Do reps collect cash or cheques (including post-dated cheques)? Bank accounts, InstaPay, Paymob links? | Payment methods, cash-handling controls, reconciliation. | Phase 4 |
| U-05 | Which workflows are manual today (approvals by phone/WhatsApp, Excel KPI sheets, etc.)? | Prioritising automation by hours saved. | MVP scope ordering |
| U-06 | Which systems have API access, and who owns the accounts: Shopify plan and admin access, Paymob merchant account and API keys, a Meta Business Manager / WhatsApp Business Account, Google Workspace? | Integration feasibility (Phase 6). No integration is built until this is answered. | Phase 6 |
| U-07 | Which dataset is authoritative when spreadsheets disagree (e.g. two price lists, two customer lists)? | Migration conflict rules. | Phase 3 |
| U-08 | Head-count: number of users per role, number of reps, their devices (Android/iOS share), and mobile data reliability in the field. | Sizing, offline priority, cost model. | Low, but affects cost |
| U-09 | Product tax treatment: does every product carry 14% VAT, or are some medical devices exempt or zero-rated? | Pricing engine, ETA tax codes. | Phase 4 |
| U-10 | Commission policy details: is commission earned on invoiced or **collected** revenue? Is it net of VAT? Is there a clawback window for returns? Is there a minimum target achievement? | Commission engine (D-05). | Phase 4 |
| U-11 | Credit policy: do customers have credit limits and payment terms? Should an over-limit order be blocked or sent for approval? | Order approval rules. | Phase 3 |
| U-12 | Does Shopify sell B2B to clinics, B2C, or both? Does Shopify hold its own inventory numbers today? | Inventory source of truth and sync direction (D-07). | Phase 6 |
| U-13 | Purchasing/imports: should Honest OS manage supplier POs, import shipments, landed cost? (Not in the module list, but inventory receipts depend on it.) | Scope of goods-receipt module. | Phase 3 |
| U-14 | Are there existing QMS procedures (ISO 13485-style, EDA (Egyptian Drug Authority) device registration, recalls by lot)? | QMS module design; lot traceability is already built into inventory. | Phase 7 |
| U-15 | Honest Academy: is it paid courses, free CME events, certifications? Who attends — customers (dentists)? | Academy data model and its link to CRM (lead source). | Phase 7 |

## 4. Working assumptions (used until a decision replaces them)

Each assumption is reversible and is tagged in the documents where it is used.

| # | Assumption | Reversal cost if wrong |
|---|------------|------------------------|
| A-01 | **One legal entity**, operating in EGP. The schema carries `currency` columns so a second currency or entity can be added later. | Low |
| A-02 | **15–60 internal users** in year one (reps are the majority). | Low (cost scales) |
| A-03 | The general ledger stays in an accounting system or with an external accountant. Honest OS owns operational accounts receivable (invoices, payments, allocations, customer balances, collections). | Medium (D-01) |
| A-04 | Commission is earned on **collected, VAT-exclusive** revenue, attributed to the rep assigned when the order was submitted. | Low (configurable plan basis) |
| A-05 | Orders created offline are **drafts**. Submitting needs connectivity, because prices, discounts and stock are validated on the server. | Low |
| A-06 | Hosting in the EU (Frankfurt) is acceptable pending legal review of PDPL cross-border rules (D-03). | High if refused (would need in-country hosting) |
| A-07 | Reps do **not** hold their own stock in the MVP. If they do, each rep becomes a `rep_stock` warehouse (already supported by the schema). | Low |
| A-08 | Default UI language is **Arabic (RTL)**, with English available per user. | Low |
| A-09 | Standard VAT of 14% applies unless a product category is configured otherwise. | Low (column per product) |

## 5. Data migration inventory (to be filled from U-01…U-07)

| Dataset | Current location | Owner | Records (est.) | Quality issues | Authoritative? | Migrate? |
|---------|------------------|-------|----------------|----------------|----------------|----------|
| Customers | _unknown_ | | | | | Yes |
| Products / SKUs | _unknown_ (likely Shopify + Excel) | | | | | Yes |
| Price lists | _unknown_ | | | | | Yes |
| Opening stock by lot | _unknown_ | | | | | Yes (as opening `receipt` movements) |
| Open invoices / balances | _unknown_ | | | | | Yes (as `opening_balance` ledger entries) |
| Employees & territories | _unknown_ | | | | | Yes |
| Historical orders | _unknown_ | | | | | Optional (KPI history) |
| Targets / KPIs | _unknown_ (spreadsheets) | | | | | Yes (current period) |

Rule: opening balances are imported as **ledger entries** (`receipt` movements, `opening_balance` AR entries), never by writing balance numbers directly. Totals are checked against the source after import.
