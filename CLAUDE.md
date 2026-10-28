# CLAUDE.md — Honest OS

Working rules and context for AI-assisted development of **Honest OS**, the business operating system of Honest® (Egyptian B2B dental products distributor: Bioner implants, Derby instruments, RDT burs).

## Current state

- **Phase 1 (architecture), awaiting owner approval.** No application code exists yet. **Do not start Phase 2 (scaffolding, migrations, features) until the owner approves D-04 in `docs/DECISIONS.md`.**
- The draft schema in `docs/database/draft/` is an architecture artefact, not a migration. It passes its smoke test (45/45) on local PostgreSQL 16 with a Supabase stub.

## Document map (keep in sync with code, in the same PR)

| File | Contents |
|------|----------|
| `docs/PROJECT_BRIEF.md` | Problem, objectives, users, functional/non-functional requirements, operating manual |
| `docs/DISCOVERY.md` | Confirmed facts, verified external facts, unknowns (U-xx), assumptions (A-xx) |
| `docs/ARCHITECTURE.md` | Diagrams, component structure, tech rationale, module dependency map, data flows, offline, GPS, error handling |
| `docs/DATABASE.md` | Conventions, ERDs, table inventory, invariants, RLS, migrations, audit |
| `docs/database/draft/*.sql` | Draft DDL + stub + smoke test |
| `docs/AUTHORIZATION.md` | RBAC + ABAC model, permission catalogue, role matrix, escalation and owner safeguards |
| `docs/API_CONTRACTS.md` | `api.*` commands and views, HTTP endpoints, outbox event contract |
| `docs/INTEGRATIONS.md` | Outbox dispatcher, Make.com scenarios module by module, Paymob/Shopify/WhatsApp/ETA designs |
| `docs/AI.md` | AI use cases, tools, system prompt, output schema, validation, cost |
| `docs/DASHBOARDS.md` | Metric rules, KPI catalogue and formulas, commission rules, dashboards by role, reports |
| `docs/TESTING.md` | Test pyramid, critical suites, fixtures, status definitions |
| `docs/COSTS.md` | Monthly operating cost estimate |
| `docs/RISKS.md` | Risk register |
| `docs/DECISIONS.md` | Open decisions (D-xx) and ADRs |
| `docs/ROADMAP.md` | MVP scope, phases, acceptance criteria, execution checklist, progress tracker |

## Non-negotiable rules

1. **Think before coding.** Identify affected modules, data relationships, permissions and transaction boundaries first. Database design comes before workflow code.
2. **Inspect before modifying.** Read the relevant docs, migrations and existing code. Follow existing conventions.
3. **No disconnected features.** Every module uses the shared `authz` permissions, `audit` triggers, `wf` approvals, `notify` notifications and `integration.outbox`.
4. **Never assume access.** No credentials, APIs, accounts or datasets exist unless `docs/DISCOVERY.md` says they are confirmed. Never invent existing infrastructure.
5. **Never fabricate completion.** Report status as Planned / Implemented / Tested / Verified / Deployed (definitions in `docs/TESTING.md` §4). Generated code is "Implemented", not "done".
6. **Security is enforced in Postgres and on the server.** Frontend checks are UX only. Deny by default. Least privilege.
7. **Money and stock:**
   - Only through `api.*` commands, in one transaction.
   - Ledgers are append-only; corrections are reversals.
   - No direct balance edits.
   - Negative stock blocked unless warehouse policy allows it.
   - Prices, discounts, taxes, totals and commissions are computed on the server. The client never sends them.
8. **Test critical operations first:** authorization, inventory, payments, orders, commissions, approvals. pgTAP for DB rules; Vitest/Playwright for the app.
9. **Controlled changes.** Small, reviewable PRs. **No destructive DB changes (drop, rename, type narrowing, data deletion) without the owner's written approval.** Use expand → migrate → contract.
10. **Keep docs current** in the same PR as the change. Record new decisions in `docs/DECISIONS.md`.
11. **Prefer simplicity.** No new dependency, service or abstraction without a stated reason.
12. **Secrets:** never in Git, never in the browser, never in `core.system_settings`. The service-role key is used only in `src/lib/supabase/admin.ts` (`server-only`).

## Conventions (summary; details in `docs/DATABASE.md` §1)

- **Schemas:** one per module (`core`, `authz`, `catalog`, `inventory`, `crm`, `field`, `work`, `sales`, `finance`, `perf`, `wf`, `audit`, `notify`, `integration`). PostgREST exposes **only** `api`.
- **Columns:** uuid PKs (client-generated allowed for offline commands); `numeric(14,2)` money in EGP; integer quantities; `timestamptz` everywhere, displayed in `Africa/Cairo`; phones in E.164 `+20…`; statuses as `text + CHECK`.
- **Functions:**
  - Every function uses `set search_path = ''` and fully qualified names.
  - Commands are `SECURITY DEFINER` and call `authz.require()` plus a record-scope check.
  - Errors are raised as `CODE: message` with a SQLSTATE: `42501` authz, `P0001` business rule, `P0002` not found.
- **RLS:** enabled on every table, not forced (ADR-005). Wrap helpers as `(select authz.fn(...))` and cast arrays (`::uuid[]`) so they evaluate once per statement. Policies must not reference each other in a cycle; use `SECURITY DEFINER` helpers instead.
- **Idempotency:** every device-retried command takes `p_client_ref` / `p_idempotency_key`.
- **i18n:** Arabic default (RTL) and English. Use Tailwind logical properties (`ms-`, `pe-`, `start-`), never `ml-`/`left-`.
- **Commits:** clear messages; never include AI model identifiers in commits, PRs or code.

## Commands

```bash
# Validate the draft schema (needs a local PostgreSQL 16 server)
createdb honest_draft
psql -d honest_draft -v ON_ERROR_STOP=1 \
  -f docs/database/draft/00_supabase_stub.sql \
  -f docs/database/draft/10_schema_draft.sql \
  -f docs/database/draft/90_smoke_test.sql
```

Phase 2 will add: `pnpm dev`, `pnpm test`, `pnpm e2e`, `supabase start`, `supabase db reset`, `supabase test db`.
