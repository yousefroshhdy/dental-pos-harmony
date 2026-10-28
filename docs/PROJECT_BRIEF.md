# Technical Project Brief — Honest OS

> Status: **Draft for approval** · Phase 1 deliverable #1 · Last updated: 2026-10-28

**PROJECT NAME:** Honest OS, the operating system for Honest® (B2B dental distribution, Egypt).

**BUSINESS PURPOSE:** Replace spreadsheets, WhatsApp approvals and disconnected tools with **one source of truth** for customers, field activity, stock, orders, invoices, collections, targets and commissions. Every number management sees must be traceable to a recorded transaction and a person.

**SYSTEM OVERVIEW:** A mobile-first web app (installable PWA) on Next.js, backed by one PostgreSQL database (Supabase).
- Reps use it in the field to see their customers, check in by GPS, record outcomes, create follow-ups and submit orders.
- Managers approve, monitor teams and territories, and act on alerts.
- Inventory, finance and the owner each get controlled workspaces.
- All rules that protect money and stock (prices, discounts, stock movements, payment allocation, commission calculation, permissions) run inside the database and the server, never in the browser.
- External tools (WhatsApp, Gmail, Sheets, Shopify, Paymob, Make.com) receive or send events through a logged, retryable integration layer. They are never the system of record.

**PLATFORMS USED:**

| Platform | Role |
|----------|------|
| Supabase | Postgres, Auth, Storage, Realtime, cron |
| Vercel | Hosting, edge network, cron |
| GitHub | Code, CI/CD |
| Make.com | Non-critical notifications and reporting automations |
| WhatsApp Business Platform (Cloud API) | Messaging |
| Paymob | Online payments, webhooks |
| Shopify Admin API | Catalogue, stock and order sync |
| Google Workspace (Gmail, Sheets, Drive) | Email, exports, archives |
| Anthropic Claude API | Management AI assistant, Phase 7 |
| Sentry or equivalent | Error monitoring |

See `docs/ARCHITECTURE.md` §3 for why each was chosen.

**DATA FLOW (summary):**
`Rep device / staff browser → Next.js server (auth, validation) → Postgres domain commands (transaction, RLS, ledger) → Outbox → Dispatcher → Make.com / WhatsApp / Gmail / Shopify → Dashboards & reports (Postgres views → Next.js)`

---

## 1. Business problem

Honest® runs a real distribution operation (imports, stock, field reps, credit sales, collections), but the operational truth is spread across spreadsheets, Shopify, phones and people's memory. As a result:

1. **No real-time visibility.** Management cannot see today's sales, stock, receivables or rep activity without asking someone to compile it.
2. **Unverifiable field activity.** Visits and follow-ups are self-reported. There is no evidence of presence, so the KPIs built on them are weak.
3. **Leakage risk.** Discounts, price exceptions, stock adjustments and payment records can change without an approval trail.
4. **Slow, error-prone reporting.** KPIs, commissions and aging reports are built by hand, and disputes cannot be settled from data.
5. **Expansion friction.** New territories, brands and reps add more spreadsheet work.

## 2. Objectives (measurable)

| # | Objective | Success measure (target 6 months after go-live) |
|---|-----------|--------------------------------------------------|
| O-1 | Single source of truth | 100% of orders, invoices, payments and stock movements recorded in Honest OS. No parallel spreadsheet for these. |
| O-2 | Verified field activity | ≥ 90% of visits have a GPS-verified check-in. Exceptions are approved or rejected within 48 h. |
| O-3 | Controlled pricing and discounts | 0 orders with a discount above the rep's limit without a recorded approval. |
| O-4 | Inventory integrity | Physical count vs system variance < 1% of SKU-lots per quarterly count. 0 negative balances. |
| O-5 | Collections | DSO and the aging buckets are visible daily. Collection rate reported per rep. Overdue invoices each have a collection task. |
| O-6 | Automated reporting | Daily and weekly management summaries generated without manual work. |
| O-7 | Commission accuracy | Commission statements reproducible from source records. 0 unresolved disputes older than one cycle. |
| O-8 | Adoption | ≥ 95% of reps use the app daily on working days. |

## 3. Stakeholders and users

| Group | Primary needs | Main surface |
|-------|---------------|--------------|
| Owner / executive management | Company-wide visibility, risk alerts, control of permissions and approvals | Executive dashboard, admin console |
| Sales Director | Team performance, pipeline, targets, discount approvals | Manager dashboard |
| Area Managers | Territory performance, rep coaching, approvals within limits | Manager dashboard (territory-scoped) |
| Sales Representatives | Today's plan, customers, check-in, orders, follow-ups, own KPIs and commissions | Mobile PWA |
| Marketing Director | Lead sources, segments, campaign attribution (Shopify / Meta / GA4) | Marketing views, exports |
| Inventory Managers | Stock by warehouse and lot, receipts, transfers, adjustments, expiry alerts | Inventory workspace |
| Finance and collection officers | Invoices, payments, allocation, aging, reconciliation, collection tasks | Finance workspace |
| Quality Managers | Lot traceability, complaints, recalls, CAPA (Phase 7) | QMS module |
| Academy Managers | Courses, attendees, certificates, lead hand-off (Phase 7) | Academy module |
| System Administrators | Users, roles, workflows, integrations, audit | Admin console |
| External: customers (clinics) | Order confirmations, payment receipts, statements | WhatsApp / email (no portal in MVP) |
| External: Egyptian Tax Authority | Valid e-invoices | ETA API (Phase 4, D-02) |

## 4. Functional requirements (grouped by module; IDs used in the roadmap)

**Platform**
- FR-PLT-1: Email/password and magic-link sign-in. Suspended or terminated employees lose access immediately.
- FR-PLT-2: Dynamic roles, scoped permissions (own/team/territory/department/warehouse/all), limits, per-user overrides, owner safeguard (`docs/AUTHORIZATION.md`).
- FR-PLT-3: Full audit trail of data changes and security events. Access history visible to the owner.
- FR-PLT-4: Configurable approval workflows (thresholds, multi-stage, delegation, escalation).
- FR-PLT-5: In-app notifications plus optional push, WhatsApp and email per user preference.
- FR-PLT-6: Arabic/English UI with RTL/LTR. EGP formatting. Egypt time zone (`Africa/Cairo`, which has observed DST since 2023).

**Sales force and CRM (Module A, B)**
- FR-CRM-1: Customer master with lifecycle (lead → prospect → active → dormant/lost/blocked), territory, assigned rep, GPS location, tags, credit terms.
- FR-CRM-2: Duplicate prevention: hard block on the same mobile number, soft warning on name similarity.
- FR-CRM-3: Opportunities and pipeline by stage. Activity timeline. Follow-up tasks.
- FR-CRM-4: Reassignment with history and approval. Territory-based visibility.
- FR-FLD-1: Visit planning, GPS check-in/out verified on the server against a configurable geofence, outcomes, notes, exception flow, anomaly flags.
- FR-FLD-2: Visits, notes and follow-ups work offline and sync idempotently.

**Catalogue, inventory (Module C)**
- FR-INV-1: Brands, categories, products, variants (SKU), lot/expiry/serial tracking flags.
- FR-INV-2: Multi-warehouse, lot-level stock derived from an append-only movement ledger. No direct balance edits. Negative stock blocked unless a warehouse policy allows it.
- FR-INV-3: Receipts, transfers (two-step), adjustments (approval above limit), damage/expiry write-off, returns to quarantine.
- FR-INV-4: Reservations on order approval. FEFO lot suggestion. Reorder, expiry and slow-moving alerts.

**Orders and invoicing (Module D)**
- FR-ORD-1: Order lifecycle as a server-enforced state machine (draft → submitted → pending_approval → approved → reserved → fulfilled → invoiced → closed, plus rejected/cancelled/partially_fulfilled/returned).
- FR-ORD-2: Prices resolved on the server: customer list → promotion → standard. Manual discounts limited by the user's grant; above the limit → approval.
- FR-ORD-3: Invoices generated from fulfilled quantities. Immutable once issued; corrections by credit note. ETA e-invoice integration subject to D-02.

**Payments and collections (Module E)**
- FR-FIN-1: Payments (cash, transfer, cheque with due date, InstaPay, Paymob), verification step, allocation to invoices (partial, multiple), reversal entries only.
- FR-FIN-2: Customer AR ledger and balances, aging buckets, overdue → automatic collection task, promise-to-pay tracking.
- FR-FIN-3: Paymob webhook reconciliation (Phase 6).

**Performance (KPI and commission engines)**
- FR-KPI-1: KPI definitions with formula, source, period, target, weight, assignee (role, employee or territory), effective date, history. Results snapshotted and traceable.
- FR-COM-1: Commission plans by product, brand or category and by employee, with effective dates. Basis is collected or invoiced revenue. Clawback on returns. Period calculate → approve → lock. Statements per rep.

**Management intelligence**
- FR-DSH-1: Role-based dashboards (rep, manager, inventory, finance, executive). Every metric has a documented formula (`docs/DASHBOARDS.md`).
- FR-RPT-1: Scheduled summaries (daily sales, weekly KPI, monthly performance). Exports controlled by permission and audited.
- FR-AI-1 (Phase 7): Read-only AI assistant answering management questions from authorised data with traceable numbers (`docs/AI.md`).

**Later modules (Phase 7):** QMS (complaints, recalls by lot, CAPA, document control), Honest Academy (events, courses, attendance, certificates, lead hand-off to CRM), Document management (versioned files in Supabase Storage with permissioned access).

## 5. Non-functional requirements

| Area | Requirement |
|------|-------------|
| Security | Deny-by-default. Authorization enforced in Postgres (RLS + checks inside definer functions). No service-role key in the browser. Secrets only in Vercel/Supabase secret stores. OWASP ASVS L2 as the review baseline. |
| Integrity | Financial and inventory writes are single DB transactions. Append-only ledgers. Idempotency keys on every client-originated command. Gapless document numbering per year. |
| Performance | Rep screens interactive in < 3 s on a mid-range Android over 3G/4G. Server p95 < 500 ms for reads, < 1 s for commands. JS budget for rep routes ≤ 200 KB gzipped. |
| Availability | Managed services (Supabase, Vercel). Target 99.5% in business hours. RPO ≤ 24 h at MVP (daily backups), ≤ 5 min after enabling point-in-time recovery (recommended before finance go-live). RTO ≤ 4 h. |
| Offline | Visits, notes, follow-ups, customer drafts and order drafts captured offline and synced with conflict detection. |
| Scalability | Up to 200 users, 50k customers, 5M movements without re-architecture (indexes and partitioning plan in `docs/DATABASE.md`). |
| Privacy | GPS only with consent, only at check-in/out. Raw fixes retained 12 months (configurable). Employees can see their own location data. PDPL review before go-live. |
| Localisation | Arabic default (RTL), English option. EGP. `+20` phone validation. `Africa/Cairo` time zone. Dates stored as `timestamptz` (UTC). |
| Maintainability | TypeScript strict. SQL migrations in Git. Generated DB types. Tests on every PR. Docs updated in the same PR as code. |
| Observability | Structured logs with a request id that runs through the app, DB and audit log. Error monitoring. Integration delivery dashboard. |

## 6. Assumptions and constraints

Assumptions are listed in `docs/DISCOVERY.md` §4 (A-01…A-09). Constraints:
- Cost-conscious SME budget. Managed services over self-hosting (`docs/COSTS.md`).
- Code-first. No-code tools only at the edges, never for money or stock.
- Modular monolith. No microservices without an operational reason.
- No assumption of API access or credentials. Every integration has a verification gate.
- Legal compliance (PDPL, ETA, labour law on employee monitoring) is **assessed, not claimed**. Each needs confirmation from counsel or Honest's accountant.

## 7. Risks

Top risks (full register in `docs/RISKS.md`):
1. Invoicing/ETA scope is unresolved (R-01).
2. Cross-border hosting under PDPL (R-02).
3. Data migration quality (R-03).
4. Rep adoption and GPS gaming (R-04, R-05).
5. Scope creep across 22 modules (R-06).

## 8. Success criteria for this architecture phase

- [ ] Owner approves the architecture, the authorization model and the MVP scope.
- [ ] Critical decisions D-01…D-07 in `docs/DECISIONS.md` are answered or explicitly deferred.
- [ ] Unknowns U-01…U-07 have an owner and a date.
- [x] Draft schema compiles and passes its invariant tests (`docs/database/draft/90_smoke_test.sql`: 45/45 on PostgreSQL 16, 2026-10-28).

## 9. Operating manual (outline, completed per phase)

| Role | Daily routine in Honest OS |
|------|----------------------------|
| Rep | Open **Today** → planned visits and due follow-ups → check in at each clinic → record outcome, notes and next follow-up → create an order draft → submit when online → record collections. Review **My KPIs** weekly. |
| Area Manager | Morning: **Approvals** inbox (discounts, exceptions, reassignments) → **Team today** (visits verified/unverified, missed follow-ups) → coach low performers using KPI scorecards. |
| Inventory | Receipts and transfers → reserved vs available → **Expiry** and **Reorder** alerts → adjustments with a reason (approval above limit) → monthly cycle count. |
| Finance | Verify payments received by reps → allocate to invoices → **Aging** → assign collection tasks → monthly commission run (calculate → review → approve → lock). |
| Owner | **Executive dashboard** → exceptions and alerts → review security events and permission changes weekly → approve high-value workflows. |
| Admin | Onboard/offboard users (suspension is immediate) → roles and limits → workflow rules → integration health page. |
