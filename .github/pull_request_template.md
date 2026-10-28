## Summary

<!-- What changes and why. Link the ROADMAP item / decision (D-xx, ADR-xxx). Keep PRs small. -->

## Status

<!-- One of the statuses in docs/TESTING.md §4. Generated or merged code is "Implemented", not "done". -->

- [ ] Planned
- [ ] Implemented: code is written
- [ ] Tested: automated tests for the critical paths exist and pass in CI
- [ ] Verified: tested and exercised end to end on staging by a human (record the result below)
- [ ] Deployed: live in production, smoke test passed, monitoring green

## Tests run

<!-- Commands and results, e.g. `pnpm check`, `pnpm test:db` (N assertions), `pnpm e2e` (projects). Say what was NOT run. -->

- [ ] `pnpm lint && pnpm typecheck && pnpm test`
- [ ] `pnpm test:db`
- [ ] `pnpm build` and `pnpm e2e`

## Security / permissions impact

<!-- New or changed permissions (authz catalogue, role matrix), RLS policies, SECURITY DEFINER functions,
     api.* commands, secrets or env vars, endpoints, webhooks. Enforcement must live in Postgres or on the
     server (CLAUDE.md rule 6). Write "None" if nothing changes. -->

## Docs updated

<!-- Which docs/*.md changed in this PR (CLAUDE.md rule 10). New decisions go in docs/DECISIONS.md. -->

## Migration impact

<!-- New migrations, in order. Expand → migrate → contract. -->

- [ ] No migrations
- [ ] Additive only (new tables, columns, functions, policies)
- [ ] **Destructive** (drop, rename, type narrowing, data deletion): written owner approval linked here: <!-- link -->
