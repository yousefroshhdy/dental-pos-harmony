# Honest OS

The business operating system for **Honest®**, an Egyptian B2B distributor of dental products. It is one secure platform for field sales, CRM, GPS-verified visits, inventory, orders, invoicing, collections, KPIs, commissions, approvals and management dashboards.

**Status:** Phase 1 (architecture) is complete and **awaiting owner review**. No application code yet.

## Start here

1. [`docs/PROJECT_BRIEF.md`](docs/PROJECT_BRIEF.md): what we are building and why
2. [`docs/DECISIONS.md`](docs/DECISIONS.md): **decisions the owner needs to make** (Part A)
3. [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md): system architecture, data flows, module map
4. [`docs/ROADMAP.md`](docs/ROADMAP.md): MVP scope, phases, execution checklist

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

**Proposed stack:** Next.js · TypeScript · Tailwind · shadcn/ui (PWA) · Supabase (PostgreSQL, Auth, Storage) · Vercel · GitHub Actions.
