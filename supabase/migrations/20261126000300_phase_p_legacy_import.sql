-- Honest OS migration: Phase P, load the old-system workbook from the browser (/admin/setup/legacy-import).
--
-- The server converts the uploaded .xlsx in memory (src/modules/imports/legacy/convert.ts) and stages
-- the result through the EXISTING import machinery: one import batch per kind (api.import_create_batch),
-- dry run (api.import_validate) and commit (api.import_commit), unchanged. This migration adds only
-- the "legacy import session" that ties the five batches together:
--
--   import.legacy_sessions       who started it, the owner's decisions (negative stock, credit balances),
--                                the reconciliation summary (aggregates only), the file's SHA-256 (a
--                                fingerprint; the file itself is never stored anywhere).
--   import.legacy_session_steps  step 1..5 = customers → products → customer_prices → opening_stock →
--                                opening_ar, each with its import batch (NULL = nothing to import).
--   api.legacy_import_check      owner + admin.import.run (MFA-gated): the server calls it BEFORE it
--                                parses an uploaded workbook.
--   api.legacy_import_start      records the session and stages every step's batch in one transaction;
--                                checks the decisions against the rows (see below).
--   api.legacy_import_restage    replaces the batch of the current step (the owner fixed the workbook).
--   api.legacy_import_abandon    discards the uncommitted batches and closes the session.
--   trigger on import.batches    a step's batch may be validated or committed only after every earlier
--                                step committed (LEGACY_ORDER), whichever screen calls the import command;
--                                the last commit completes the session.
--   api.v_legacy_import_sessions / _steps / _quality  (security_invoker) for the page; _quality lists the
--                                session's customers without a phone or a pin and stocked items whose
--                                cost is unknown.
--
-- Decisions (docs/DECISIONS.md 2026-11-26):
--   negative stock "zero": the item IS imported (product and base price) and gets NO opening-stock line,
--                          so it starts at 0 on hand (the opening_stock kind refuses quantity 0).
--   negative stock "skip": the item is left out of products, prices and stock; it stays listed on the
--                          session for the owner to add later.
--   credit balances:       'hold' (default): the opening AR batch may carry no negative amount;
--                          'import': the credits are imported with the debits.
--
-- Owner only: every command needs admin.import.run (requires_mfa, so aal2 while enforcement is on) AND
-- the owner role. No new permission (suites 39 and 48 unchanged). Additive only.
-- Tests: supabase/tests/database/62_phase_p_legacy_import.test.sql.

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------
create table import.legacy_sessions (
  id              uuid primary key default gen_random_uuid(),
  status          text not null default 'open' check (status in ('open','completed','abandoned')),
  idempotency_key text not null check (length(idempotency_key) between 8 and 180),
  payload_hash    text not null,
  file_name       text check (length(file_name) <= 200),
  -- Fingerprint of the uploaded workbook, so a restaged step can be told apart; not the file.
  file_sha256     text check (file_sha256 ~ '^[0-9a-f]{64}$'),
  -- Aggregates only: reconciliation lines (check, expected, output, status), row counts, warnings.
  summary         jsonb not null default '{}' check (jsonb_typeof(summary) = 'object' and length(summary::text) <= 32000),
  credits_mode    text not null default 'hold' check (credits_mode in ('hold','import')),
  -- [{sku, name, quantity, decision: zero|skip}], one per item the old system had below zero.
  negative_stock  jsonb not null default '[]' check (jsonb_typeof(negative_stock) = 'array'),
  created_by      uuid not null references auth.users(id),
  created_at      timestamptz not null default now(),
  completed_at    timestamptz,
  abandoned_at    timestamptz,
  abandoned_by    uuid references auth.users(id),
  unique (created_by, idempotency_key),
  check ((status = 'completed') = (completed_at is not null)),
  check ((status = 'abandoned') = (abandoned_at is not null))
);
create index on import.legacy_sessions (created_by);
create index on import.legacy_sessions (abandoned_by);
create index on import.legacy_sessions (created_at desc);
-- One open session at a time.
create unique index legacy_sessions_one_open on import.legacy_sessions ((true)) where status = 'open';

create table import.legacy_session_steps (
  id                 uuid not null default gen_random_uuid() unique,   -- for the audit log
  session_id         uuid not null references import.legacy_sessions(id),
  step_no            smallint not null check (step_no between 1 and 5),
  kind               text not null,
  batch_id           uuid unique references import.batches(id),   -- NULL = nothing to import in this step
  replaced_batch_ids uuid[] not null default '{}',                -- earlier batches of the step (discarded)
  updated_at         timestamptz not null default now(),
  primary key (session_id, step_no),
  check (kind = (array['customers','products','customer_prices','opening_stock','opening_ar'])[step_no])
);

comment on table import.legacy_sessions is
  'Browser import of the old-system workbook: decisions, reconciliation aggregates and the file hash. No file is stored.';
comment on table import.legacy_session_steps is
  'The five import batches of a legacy session, in order: customers, products, customer_prices, opening_stock, opening_ar.';

-- The policies below call authz.is_owner() as the client. The 2026-10-29 sweep (20261029001000, rule
-- (e), suite 17) revoked it because no policy needed it then; a policy needing it may call it. It only
-- tells the caller whether they themselves are an owner.
grant execute on function authz.is_owner() to authenticated;

alter table import.legacy_sessions enable row level security;
alter table import.legacy_session_steps enable row level security;

create policy legacy_sessions_select on import.legacy_sessions for select to authenticated
  using ((select authz.has_global('admin.import.run')) and (select authz.is_owner()));
create policy legacy_session_steps_select on import.legacy_session_steps for select to authenticated
  using ((select authz.has_global('admin.import.run')) and (select authz.is_owner()));

revoke all on import.legacy_sessions, import.legacy_session_steps from public, anon, authenticated;
grant select on import.legacy_sessions, import.legacy_session_steps to authenticated;

create trigger trg_audit after insert or update or delete on import.legacy_sessions
  for each row execute function audit.log_change();
create trigger trg_audit after insert or update or delete on import.legacy_session_steps
  for each row execute function audit.log_change();

-- ---------------------------------------------------------------------------
-- 2. Helpers (not client-callable)
-- ---------------------------------------------------------------------------
create or replace function import._legacy_require() returns void
language plpgsql set search_path = '' as $$
begin
  -- Permission first (a non-holder never learns about MFA), then MFA (inside authz.require), then owner.
  perform authz.require('admin.import.run');
  if not authz.has_global('admin.import.run') then
    raise exception 'PERMISSION_DENIED: admin.import.run needs company-wide scope' using errcode = '42501';
  end if;
  if not authz.is_owner() then
    raise exception 'OWNER_ONLY: the old-system import is for the owner' using errcode = '42501';
  end if;
end $$;

create or replace function import._legacy_kind(p_step int) returns text
language sql immutable set search_path = '' as $$
  select (array['customers','products','customer_prices','opening_stock','opening_ar'])[p_step]
$$;

-- The owner's decisions must agree with the rows of a step (raises VALIDATION otherwise).
create or replace function import._legacy_check_rows(p_kind text, p_rows jsonb, p_negative jsonb, p_credits text)
returns void language plpgsql stable set search_path = '' as $$
declare v_bad int;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'VALIDATION: the % rows must be a JSON array', p_kind using errcode = 'P0001';
  end if;
  if jsonb_array_length(p_rows) > 5000 then
    raise exception 'VALIDATION: at most 5000 % rows', p_kind using errcode = 'P0001';
  end if;
  if exists (select 1 from jsonb_array_elements(p_rows) e where jsonb_typeof(e) <> 'object') then
    raise exception 'VALIDATION: every % row must be a JSON object', p_kind using errcode = 'P0001';
  end if;

  if p_kind in ('products', 'customer_prices', 'opening_stock') then
    -- "skip": the item is in none of products, prices and stock.
    select count(*) into v_bad
    from jsonb_array_elements(p_rows) r, jsonb_array_elements(p_negative) d
    where d ->> 'decision' = 'skip' and upper(btrim(r ->> 'sku')) = d ->> 'sku';
    if v_bad > 0 then
      raise exception 'LEGACY_DECISION: % rows hold items the owner chose to skip', p_kind using errcode = 'P0001';
    end if;
  end if;
  if p_kind = 'opening_stock' then
    -- "zero": no opening-stock line (the item starts at 0 on hand).
    select count(*) into v_bad
    from jsonb_array_elements(p_rows) r, jsonb_array_elements(p_negative) d
    where d ->> 'decision' = 'zero' and upper(btrim(r ->> 'sku')) = d ->> 'sku';
    if v_bad > 0 then
      raise exception 'LEGACY_DECISION: opening stock holds an item the owner fixed to 0' using errcode = 'P0001';
    end if;
  end if;
  if p_kind = 'products' then
    -- "zero": the item itself is imported.
    select count(*) into v_bad
    from jsonb_array_elements(p_negative) d
    where d ->> 'decision' = 'zero'
      and not exists (select 1 from jsonb_array_elements(p_rows) r where upper(btrim(r ->> 'sku')) = d ->> 'sku');
    if v_bad > 0 then
      raise exception 'LEGACY_DECISION: an item fixed to 0 is missing from the products' using errcode = 'P0001';
    end if;
  end if;
  if p_kind = 'opening_ar' and p_credits = 'hold' then
    if exists (select 1 from jsonb_array_elements(p_rows) r
               where coalesce(import._num(btrim(r ->> 'amount')), 0) < 0 or btrim(r ->> 'amount') like '-%') then
      raise exception 'LEGACY_DECISION: credit balances are held; the opening AR may hold debit balances only' using errcode = 'P0001';
    end if;
  end if;
end $$;

-- Every step before p_step is done (committed, or nothing to import).
create or replace function import._legacy_earlier_done(p_session uuid, p_step int) returns boolean
language sql stable set search_path = '' as $$
  select not exists (
    select 1 from import.legacy_session_steps s join import.batches b on b.id = s.batch_id
    where s.session_id = p_session and s.step_no < p_step and b.status <> 'committed')
$$;

-- ---------------------------------------------------------------------------
-- 3. Step order, enforced on the import batches themselves
-- ---------------------------------------------------------------------------
create or replace function import._legacy_step_guard() returns trigger
language plpgsql set search_path = '' as $$
declare v_step import.legacy_session_steps%rowtype; v_status text;
begin
  if new.status not in ('validated', 'failed', 'committed') then return new; end if;
  select * into v_step from import.legacy_session_steps where batch_id = new.id;
  if not found then return new; end if;
  select ls.status into v_status from import.legacy_sessions ls where ls.id = v_step.session_id;
  if v_status <> 'open' then
    raise exception 'INVALID_STATE: this old-system import is %', v_status using errcode = 'P0001';
  end if;
  if not import._legacy_earlier_done(v_step.session_id, v_step.step_no) then
    raise exception 'LEGACY_ORDER: commit the earlier steps first (customers, products, prices, opening stock, opening AR)'
      using errcode = 'P0001';
  end if;
  return new;
end $$;

create or replace function import._legacy_step_completed() returns trigger
language plpgsql set search_path = '' as $$
declare v_session uuid;
begin
  select s.session_id into v_session from import.legacy_session_steps s where s.batch_id = new.id;
  if v_session is null then return null; end if;
  if import._legacy_earlier_done(v_session, 6) then
    update import.legacy_sessions set status = 'completed', completed_at = now()
    where id = v_session and status = 'open';
  end if;
  return null;
end $$;

create trigger trg_legacy_step_order before update of status on import.batches
  for each row execute function import._legacy_step_guard();
create trigger trg_legacy_step_completed after update of status on import.batches
  for each row when (new.status = 'committed' and old.status is distinct from 'committed')
  execute function import._legacy_step_completed();

-- ---------------------------------------------------------------------------
-- 4. Commands
-- ---------------------------------------------------------------------------
-- The gate before the server parses a workbook: owner, admin.import.run, MFA when enforced.
create or replace function api.legacy_import_check()
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform import._legacy_require();
  return jsonb_build_object('allowed', true,
    'open_session_id', (select s.id from import.legacy_sessions s where s.status = 'open'));
end $$;

-- p_batches: {"customers": [...], "products": [...], "customer_prices": [...], "opening_stock": [...],
-- "opening_ar": [...]} — staging rows exactly as the /imports upload builds them (text or null values).
-- p_negative_stock: [{"sku", "name", "quantity" (< 0), "decision": "zero" | "skip"}].
create or replace function api.legacy_import_start(
  p_idempotency_key text, p_file_name text, p_file_sha256 text, p_summary jsonb,
  p_negative_stock jsonb, p_credits_mode text, p_batches jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_key text := btrim(coalesce(p_idempotency_key, ''));
  v_credits text := coalesce(nullif(btrim(p_credits_mode), ''), 'hold');
  v_negative jsonb := coalesce(p_negative_stock, '[]'::jsonb);
  v_summary jsonb := coalesce(p_summary, '{}'::jsonb);
  v_hash text;
  v_existing import.legacy_sessions%rowtype;
  v_id uuid;
  v_kind text;
  v_rows jsonb;
  v_batch jsonb;
  v_steps jsonb := '[]';
  v_total int := 0;
begin
  perform import._legacy_require();
  if length(v_key) < 8 or length(v_key) > 180 then
    raise exception 'VALIDATION: idempotency key must be 8-180 characters' using errcode = 'P0001';
  end if;
  v_hash := md5(jsonb_build_array(p_file_name, p_file_sha256, v_summary, v_negative, v_credits, p_batches)::text);
  select * into v_existing from import.legacy_sessions where created_by = v_uid and idempotency_key = v_key;
  if found then
    if v_existing.payload_hash <> v_hash then
      raise exception 'CONFLICT: this idempotency key was used for a different upload' using errcode = 'P0001';
    end if;
    return jsonb_build_object('session_id', v_existing.id, 'status', v_existing.status, 'replayed', true);
  end if;
  if exists (select 1 from import.legacy_sessions s where s.status = 'open') then
    raise exception 'INVALID_STATE: an old-system import is already open; finish or abandon it first' using errcode = 'P0001';
  end if;

  if v_credits not in ('hold', 'import') then
    raise exception 'VALIDATION: credits mode must be hold or import' using errcode = 'P0001';
  end if;
  if p_file_sha256 is not null and p_file_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'VALIDATION: file fingerprint must be a SHA-256 hex digest' using errcode = 'P0001';
  end if;
  if jsonb_typeof(v_summary) <> 'object' or length(v_summary::text) > 32000 then
    raise exception 'VALIDATION: the summary must be a small JSON object (aggregates only)' using errcode = 'P0001';
  end if;
  if jsonb_typeof(v_negative) <> 'array' or jsonb_array_length(v_negative) > 5000 then
    raise exception 'VALIDATION: negative stock decisions must be a JSON array' using errcode = 'P0001';
  end if;
  if exists (select 1 from jsonb_array_elements(v_negative) d where jsonb_typeof(d) <> 'object') then
    raise exception 'VALIDATION: each negative stock item must be a JSON object' using errcode = 'P0001';
  end if;
  if exists (select 1 from jsonb_array_elements(v_negative) d
             where exists (select 1 from jsonb_object_keys(d) k where k not in ('sku', 'name', 'quantity', 'decision'))
                or coalesce(d ->> 'decision', '') not in ('zero', 'skip')
                or coalesce(d ->> 'sku', '') !~ '^[A-Z0-9][A-Z0-9._-]{0,63}$'
                or case when jsonb_typeof(d -> 'quantity') = 'number' then (d ->> 'quantity')::numeric >= 0 else true end
                or length(coalesce(d ->> 'name', '')) > 160) then
    raise exception 'VALIDATION: each negative stock item needs sku, a quantity below 0 and decision zero or skip'
      using errcode = 'P0001';
  end if;
  if (select count(distinct d ->> 'sku') from jsonb_array_elements(v_negative) d) <> jsonb_array_length(v_negative) then
    raise exception 'VALIDATION: one decision per item' using errcode = 'P0001';
  end if;
  if p_batches is null or jsonb_typeof(p_batches) <> 'object'
     or exists (select 1 from jsonb_object_keys(p_batches) k
                where k not in ('customers', 'products', 'customer_prices', 'opening_stock', 'opening_ar')) then
    raise exception 'VALIDATION: batches must be an object keyed by import kind' using errcode = 'P0001';
  end if;
  for i in 1..5 loop
    v_kind := import._legacy_kind(i);
    perform import._legacy_check_rows(v_kind, coalesce(p_batches -> v_kind, '[]'::jsonb), v_negative, v_credits);
    v_total := v_total + jsonb_array_length(coalesce(p_batches -> v_kind, '[]'::jsonb));
  end loop;
  if v_total = 0 then raise exception 'VALIDATION: the workbook has nothing to import' using errcode = 'P0001'; end if;

  insert into import.legacy_sessions (idempotency_key, payload_hash, file_name, file_sha256, summary, credits_mode,
                                      negative_stock, created_by)
  values (v_key, v_hash, left(nullif(btrim(p_file_name), ''), 200), p_file_sha256, v_summary, v_credits, v_negative, v_uid)
  returning id into v_id;

  for i in 1..5 loop
    v_kind := import._legacy_kind(i);
    v_rows := coalesce(p_batches -> v_kind, '[]'::jsonb);
    v_batch := null;
    if jsonb_array_length(v_rows) > 0 then
      v_batch := api.import_create_batch(v_kind, v_rows, v_key || ':' || i, p_file_name);
    end if;
    insert into import.legacy_session_steps (session_id, step_no, kind, batch_id)
    values (v_id, i, v_kind, (v_batch ->> 'batch_id')::uuid);
    v_steps := v_steps || jsonb_build_object('step_no', i, 'kind', v_kind, 'batch_id', v_batch ->> 'batch_id',
                                             'row_count', jsonb_array_length(v_rows));
  end loop;

  perform authz.log_security_event('legacy_import_started', 'info', jsonb_build_object(
    'session_id', v_id, 'rows', v_total, 'credits_mode', v_credits,
    'negative_zero', (select count(*) from jsonb_array_elements(v_negative) d where d ->> 'decision' = 'zero'),
    'negative_skip', (select count(*) from jsonb_array_elements(v_negative) d where d ->> 'decision' = 'skip')));
  return jsonb_build_object('session_id', v_id, 'status', 'open', 'steps', v_steps, 'replayed', false);
end $$;

-- Replace the batch of the CURRENT step (every earlier step committed, this one not) with new rows from
-- a corrected workbook. The decisions recorded at the start still apply. Empty rows = nothing to import.
create or replace function api.legacy_import_restage(p_session_id uuid, p_step int, p_rows jsonb, p_idempotency_key text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  s import.legacy_sessions%rowtype;
  st import.legacy_session_steps%rowtype;
  b import.batches%rowtype;
  v_key text := btrim(coalesce(p_idempotency_key, ''));
  v_batch jsonb;
begin
  perform import._legacy_require();
  if length(v_key) < 8 or length(v_key) > 180 then
    raise exception 'VALIDATION: idempotency key must be 8-180 characters' using errcode = 'P0001';
  end if;
  select * into s from import.legacy_sessions where id = p_session_id for update;
  if not found then raise exception 'NOT_FOUND: old-system import' using errcode = 'P0002'; end if;
  select * into st from import.legacy_session_steps where session_id = p_session_id and step_no = p_step;
  if not found then raise exception 'NOT_FOUND: import step' using errcode = 'P0002'; end if;
  if st.batch_id is not null then select * into b from import.batches where id = st.batch_id; end if;

  -- A retried request: the step already holds the batch of this key.
  if b.id is not null and b.idempotency_key = v_key || ':' || p_step || ':r' then
    if b.payload_hash <> md5(coalesce(p_rows, '[]'::jsonb)::text) then
      raise exception 'CONFLICT: this idempotency key was used for a different upload' using errcode = 'P0001';
    end if;
    return jsonb_build_object('session_id', s.id, 'step_no', p_step, 'batch_id', b.id, 'replayed', true);
  end if;

  if s.status <> 'open' then raise exception 'INVALID_STATE: this old-system import is %', s.status using errcode = 'P0001'; end if;
  if b.status = 'committed' then
    raise exception 'ALREADY_COMMITTED: this step was committed' using errcode = 'P0001';
  end if;
  if not import._legacy_earlier_done(s.id, p_step) then
    raise exception 'LEGACY_ORDER: commit the earlier steps first' using errcode = 'P0001';
  end if;
  perform import._legacy_check_rows(st.kind, coalesce(p_rows, '[]'::jsonb), s.negative_stock, s.credits_mode);

  if b.id is not null and b.status <> 'discarded' then perform api.import_discard(b.id); end if;
  if jsonb_array_length(coalesce(p_rows, '[]'::jsonb)) > 0 then
    v_batch := api.import_create_batch(st.kind, p_rows, v_key || ':' || p_step || ':r', s.file_name);
  end if;
  update import.legacy_session_steps
     set batch_id = (v_batch ->> 'batch_id')::uuid,
         replaced_batch_ids = case when st.batch_id is null then replaced_batch_ids else replaced_batch_ids || st.batch_id end,
         updated_at = now()
   where session_id = s.id and step_no = p_step;

  -- Restaging the last open step with nothing left to import completes the session.
  if import._legacy_earlier_done(s.id, 6) then
    update import.legacy_sessions set status = 'completed', completed_at = now() where id = s.id;
  end if;
  return jsonb_build_object('session_id', s.id, 'step_no', p_step, 'batch_id', v_batch ->> 'batch_id', 'replayed', false);
end $$;

-- Close an open session: its uncommitted batches are discarded (their staged rows deleted); what was
-- committed stays (ledgers are append-only; corrections are reversals).
create or replace function api.legacy_import_abandon(p_session_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s import.legacy_sessions%rowtype; r record; v_n int := 0;
begin
  perform import._legacy_require();
  select * into s from import.legacy_sessions where id = p_session_id for update;
  if not found then raise exception 'NOT_FOUND: old-system import' using errcode = 'P0002'; end if;
  if s.status = 'abandoned' then return jsonb_build_object('session_id', s.id, 'status', 'abandoned', 'replayed', true); end if;
  if s.status <> 'open' then raise exception 'INVALID_STATE: this old-system import is %', s.status using errcode = 'P0001'; end if;
  for r in select b.id from import.legacy_session_steps st join import.batches b on b.id = st.batch_id
           where st.session_id = s.id and b.status not in ('committed', 'discarded') loop
    perform api.import_discard(r.id);
    v_n := v_n + 1;
  end loop;
  update import.legacy_sessions set status = 'abandoned', abandoned_at = now(), abandoned_by = auth.uid() where id = s.id;
  return jsonb_build_object('session_id', s.id, 'status', 'abandoned', 'batches_discarded', v_n, 'replayed', false);
end $$;

-- ---------------------------------------------------------------------------
-- 5. Read views (security_invoker: owner + admin.import.run through the tables' RLS)
-- ---------------------------------------------------------------------------
create or replace view api.v_legacy_import_sessions with (security_invoker = true) as
  select s.id, s.status, s.file_name, s.file_sha256, s.summary, s.credits_mode, s.negative_stock,
         s.created_by, e.full_name_en as created_by_name_en, e.full_name_ar as created_by_name_ar,
         s.created_at, s.completed_at, s.abandoned_at
  from import.legacy_sessions s
  left join core.user_profiles up on up.user_id = s.created_by
  left join core.employees e on e.id = up.employee_id;

create or replace view api.v_legacy_import_steps with (security_invoker = true) as
  select st.session_id, st.step_no, st.kind, st.batch_id, cardinality(st.replaced_batch_ids) as restaged_count,
         b.status as batch_status, b.row_count, b.valid_count, b.error_count, b.committed_count,
         b.result, b.failure, b.failure_row_no, b.validated_at, b.committed_at, st.updated_at
  from import.legacy_session_steps st
  left join import.batches b on b.id = st.batch_id;

-- What the owner still has to complete after the import: the session's customers without a phone or a
-- verified pin, and the items it stocked with an unknown cost (until a cost is on the catalogue).
create or replace view api.v_legacy_import_quality with (security_invoker = true) as
  select st.session_id, gap.issue, 'customer'::text as entity_type, c.id as entity_id, c.id as customer_id,
         null::uuid as product_id, c.customer_no as code, c.display_name as label
  from import.legacy_session_steps st
  join import.rows r on r.batch_id = st.batch_id and r.status = 'committed'
  join crm.customers c on c.id = (r.result ->> 'customer_id')::uuid and c.archived_at is null
  cross join lateral (values ('phone_missing', c.phone_primary is null), ('location_missing', c.latitude is null)) gap(issue, hit)
  where st.kind = 'customers' and gap.hit
  union all
  select distinct st.session_id, 'cost_unknown'::text, 'product'::text, v.id, null::uuid, v.product_id, v.sku, v.name_en
  from import.legacy_session_steps st
  join import.rows r on r.batch_id = st.batch_id and r.status = 'committed'
                    and coalesce((r.normalized ->> 'cost_unknown')::boolean, false)
  join catalog.product_variants v on v.id = (r.normalized ->> 'variant_id')::uuid
  where st.kind = 'opening_stock'
    and (select authz.has_permission('catalog.cost.read'))
    and not exists (select 1 from catalog.product_costs pc
                    where pc.variant_id = v.id and pc.effective_from <= (select core.business_date()));

-- ---------------------------------------------------------------------------
-- 6. Privileges (explicit; PostgreSQL's global PUBLIC execute revoked, gotcha of suite 08)
-- ---------------------------------------------------------------------------
revoke all on all functions in schema import from public, anon, authenticated;
grant select on api.v_legacy_import_sessions, api.v_legacy_import_steps, api.v_legacy_import_quality to authenticated;
revoke all on api.v_legacy_import_sessions, api.v_legacy_import_steps, api.v_legacy_import_quality from anon;

do $$
declare f text;
begin
  foreach f in array array[
    'api.legacy_import_check()',
    'api.legacy_import_start(text, text, text, jsonb, jsonb, text, jsonb)',
    'api.legacy_import_restage(uuid, int, jsonb, text)',
    'api.legacy_import_abandon(uuid)']
  loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
