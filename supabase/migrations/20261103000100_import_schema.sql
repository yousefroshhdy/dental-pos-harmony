-- Honest OS migration: data migration staging (ROADMAP Phase 3 task 11, docs/DATABASE.md §7).
--
-- Schema `import` holds uploaded spreadsheet rows as-is (raw), what validation made of them
-- (normalized) and the per-row errors (the rejects report). Nothing here is a business record:
-- committing a batch posts through the normal api.* commands and ledgers
-- (20261103000110_import_commands.sql).
--
-- D-03: synthetic data only until the PDPL legal review clears real personal data.
--
-- Not exposed to PostgREST (only `api` is). Clients read through api.v_import_* views
-- (security_invoker) and write only through api.import_* commands.
-- Non-destructive: new schema, tables, policies, one permission, one audit trigger.

create schema if not exists import;
comment on schema import is
  'Data migration staging (ROADMAP Phase 3 task 11). Raw rows, validation results, rejects. Not exposed to PostgREST.';

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------
create table import.batches (
  id              uuid primary key default gen_random_uuid(),
  kind            text not null check (kind in ('customers','products','customer_prices','opening_stock','opening_ar')),
  -- uploaded → validated (no row errors) | failed (row errors, or the commit was refused)
  --          → committed (terminal). discarded = abandoned before commit; its rows are deleted.
  status          text not null default 'uploaded'
                  check (status in ('uploaded','validated','committed','failed','discarded')),
  file_name       text check (length(file_name) <= 200),
  row_count       int not null default 0 check (row_count >= 0),
  valid_count     int not null default 0 check (valid_count >= 0),
  error_count     int not null default 0 check (error_count >= 0),
  committed_count int not null default 0 check (committed_count >= 0),
  idempotency_key text not null check (length(idempotency_key) between 8 and 200),
  payload_hash    text not null,                 -- md5 of the uploaded rows: a replay must match
  failure         text,                          -- why the last commit attempt was refused (CODE: message)
  failure_row_no  int,                           -- the row that refused it, when known
  result          jsonb not null default '{}',   -- counts of what the commit created
  created_by      uuid not null references auth.users(id),
  created_at      timestamptz not null default now(),
  validated_at    timestamptz,
  committed_at    timestamptz,
  committed_by    uuid references auth.users(id),
  discarded_at    timestamptz,
  discarded_by    uuid references auth.users(id),
  unique (created_by, idempotency_key),
  check ((status = 'committed') = (committed_at is not null)),
  check ((status = 'discarded') = (discarded_at is not null))
);
create index on import.batches (created_at desc);

create table import.rows (
  id          uuid primary key default gen_random_uuid(),
  batch_id    uuid not null references import.batches(id),
  row_no      int not null check (row_no >= 1),  -- data row number; spreadsheet row = row_no + 1 (header)
  raw         jsonb not null check (jsonb_typeof(raw) = 'object'),
  normalized  jsonb,
  -- Each error is '<code>:<field>', e.g. 'invalid:phone_primary', 'unknown:sku',
  -- 'duplicate_in_file:phone_primary'. Codes are translated in the UI (messages/*/imports.json).
  errors      text[] not null default '{}',
  status      text not null default 'pending' check (status in ('pending','valid','invalid','committed')),
  result      jsonb,                             -- ids created for this row (customer_id, movement_id, ...)
  unique (batch_id, row_no)
);

-- ---------------------------------------------------------------------------
-- 2. Permission (reference-data pattern). Owner holds it implicitly (ADR-007; suite 08
--    requires the owner role to have no explicit grants). Sensitive: granting it to any
--    other role raises a critical security event (api.set_role_permission).
-- ---------------------------------------------------------------------------
insert into authz.permissions (code, module, description, allowed_scopes, supports_limit, is_sensitive) values
  ('admin.import.run', 'admin',
   'Stage, validate and commit data migration imports (customers, products, prices, opening stock, opening AR)',
   '{all}', false, true)
on conflict (code) do nothing;

-- ---------------------------------------------------------------------------
-- 3. RLS (enabled, not forced — ADR-005) and read grants. Writes only via api.import_*.
-- ---------------------------------------------------------------------------
alter table import.batches enable row level security;
alter table import.rows enable row level security;

create policy import_batches_select on import.batches for select to authenticated
  using ((select authz.has_global('admin.import.run')));
create policy import_rows_select on import.rows for select to authenticated
  using ((select authz.has_global('admin.import.run')));

revoke all on schema import from public, anon;
revoke all on all tables in schema import from public, anon, authenticated;
grant usage on schema import to authenticated;
grant select on import.batches, import.rows to authenticated;

-- Batch history is auditable (who uploaded, validated, committed or discarded what).
create trigger trg_audit after insert or update or delete on import.batches
  for each row execute function audit.log_change();
