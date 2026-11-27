# Honest OS

The business operating system for **Honest®**, an Egyptian B2B distributor of dental products. It is one secure platform for field sales, CRM, GPS-verified visits, inventory, orders, invoicing, collections, KPIs, commissions, approvals and management dashboards.

**Status (2026-11-24, Phase P step 8):**

- **Implemented and Tested** (automated tests pass locally): the app (Next.js, ar/en) and database
  for field sales, CRM, leads, visits and tracking, orders with offers and decision-B discount
  approvals, inventory, invoices, payments, returns, commissions with the owner's rate editor,
  dashboards, maps (key-less state), owner setup and the old-system workbook import.
  - `pnpm test:db`: 3488 assertions in 62 suites, 0 failing.
  - `pnpm test`: 2013 unit tests.
  - Local signed-in stack: 78 verification lines and 348 screenshots
    ([`docs/VERIFICATION.md`](docs/VERIFICATION.md), [`docs/TESTING.md`](docs/TESTING.md) §7–8).
- **On staging:** all 81 migrations. **Nothing is Verified**: that needs the owner's own
  click-through ([`docs/VERIFICATION.md`](docs/VERIFICATION.md)). MFA enforcement ships off.
- **Owner actions pending:** rotate the Supabase secret key and re-add the three secrets as
  Sensitive in Vercel; Google Cloud keys and APIs (Maps JS, Places API (New), Geocoding) with a
  budget alert; exposed schemas `api, service`; leaked-password protection; SMTP; activate
  STD-2026; create the verification test account(s); run the legacy import; set the reps' base
  addresses; create the quarantine warehouse for returns on `/admin/setup`.

## Start here

1. [`docs/PROJECT_BRIEF.md`](docs/PROJECT_BRIEF.md): what we are building and why
2. [`docs/DECISIONS.md`](docs/DECISIONS.md): **decisions the owner needs to make** (Part A)
3. [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md): system architecture, data flows, module map
4. [`docs/ROADMAP.md`](docs/ROADMAP.md): MVP scope, phases, execution checklist, progress tracker
5. [`docs/VERIFICATION.md`](docs/VERIFICATION.md): the click-through per role, for the owner's sign-off
6. [`docs/USER_MANUAL.md`](docs/USER_MANUAL.md) (English) / [`docs/USER_MANUAL.ar.md`](docs/USER_MANUAL.ar.md) (العربية): the user manual per role

Also in `docs/`:

| Topic | File |
|-------|------|
| Discovery | [`DISCOVERY.md`](docs/DISCOVERY.md) |
| Database | [`DATABASE.md`](docs/DATABASE.md) (draft SQL in [`database/draft/`](docs/database/draft/)) |
| Authorization | [`AUTHORIZATION.md`](docs/AUTHORIZATION.md) |
| API contracts | [`API_CONTRACTS.md`](docs/API_CONTRACTS.md) |
| Integrations | [`INTEGRATIONS.md`](docs/INTEGRATIONS.md) |
| AI | [`AI.md`](docs/AI.md) |
| Dashboards | [`DASHBOARDS.md`](docs/DASHBOARDS.md) |
| Testing | [`TESTING.md`](docs/TESTING.md) |
| Costs | [`COSTS.md`](docs/COSTS.md) |
| Risks | [`RISKS.md`](docs/RISKS.md) |

Development rules for humans and AI assistants are in [`CLAUDE.md`](CLAUDE.md).

**Stack:** Next.js · TypeScript · Tailwind · shadcn/ui (PWA) · Supabase (PostgreSQL, Auth, Storage) · Vercel · GitHub Actions.
