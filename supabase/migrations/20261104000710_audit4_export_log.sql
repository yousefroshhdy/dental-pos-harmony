-- Honest OS migration: audit-4 A-L4, export controls lived only in the app.
--
-- Before: /api/export/[kind] checked crm.customer.export / sales.order.export in Next only,
-- logged the export to the app log only, and had no rate limit or MFA step-up.
--
-- Now (all additive):
--   1. crm.customer.export and sales.order.export require MFA (docs/AUTHORIZATION.md §6:
--      exports need an aal2 session), through the requires_mfa flag of 20261103000600. Only these
--      two rows are touched: the other export kinds have no dedicated <module>.<resource>.export
--      permission, and flagging their read permissions would gate every page read.
--   2. api.log_export(kind, filters, row_count, request_id) → bigint, the server-side gate the
--      export route calls BEFORE it reads or streams anything (fail closed):
--        * p_kind must be on the whitelist (audit.export_kinds); else VALIDATION (22023)
--        * the caller must hold the kind's permissions (same rule as src/modules/reports/kinds.ts);
--          authz.require on each one, so the MFA step-up applies when security.mfa_enforced is on
--        * filters: only the kind's filter keys; values must be ids, codes or dates; free text (q)
--          is stored as "[redacted]" so no personal data lands in the security log
--        * rate limit: at most 20 exports per user per 10 minutes, counted from the log itself;
--          the 21st raises RATE_LIMITED (P0001). Serialised per user with an advisory lock.
--        * writes one audit.security_events row: event_type 'export', user from auth.uid(),
--          occurred_at = request time, details {kind, filters, rows, request_id}
--   3. api.log_export_result(export_id, row_count, truncated, failed): the route reports the
--      final row count when the stream ends (the count is unknown before streaming). Only the
--      user who opened the export, once, within an hour. Writes an 'export_result' event.
--   4. Index audit.security_events (user_id, event_type, occurred_at desc) for the rate limit.
--
-- The rows themselves still come from the api.v_* views under the user's session, so RLS stays
-- the boundary: PostgREST paging over the same views returns the same rows by design.

-- ---------------------------------------------------------------------------
-- 1. MFA step-up for the export permissions (only these rows)
-- ---------------------------------------------------------------------------
update authz.permissions set requires_mfa = true
where code in ('crm.customer.export', 'sales.order.export');

-- ---------------------------------------------------------------------------
-- 2. Index for the per-user rate limit and the result lookup
-- ---------------------------------------------------------------------------
create index if not exists security_events_user_type_time_idx
  on audit.security_events (user_id, event_type, occurred_at desc);

-- ---------------------------------------------------------------------------
-- 3. Internal helpers (invoker; run inside the definer api functions; not client-callable)
-- ---------------------------------------------------------------------------
-- The export whitelist. "perms": alternatives (outer list ORed, inner list ANDed), mirroring
-- EXPORT_PERMISSIONS in src/modules/reports/kinds.ts. "filters": the keys of FILTER_SCHEMAS in
-- src/modules/reports/schemas.ts. A unit test (tests/unit/reports-export-log.test.ts) compares
-- this literal with the app; keep the markers.
create or replace function audit.export_kinds() returns jsonb
language sql immutable set search_path = '' as $$
  select
-- export-kinds:begin
$json${
  "orders":      { "perms": [["sales.order.read", "sales.order.export"]], "filters": ["status", "from", "to"] },
  "order_lines": { "perms": [["sales.order.read", "sales.order.export"]], "filters": ["status", "from", "to"] },
  "invoices":    { "perms": [["finance.invoice.read"]],                    "filters": ["status", "bucket", "customer", "from", "to"] },
  "payments":    { "perms": [["finance.payment.read"]],                    "filters": ["status", "customer", "from", "to"] },
  "aging":       { "perms": [["finance.page.aging"], ["finance.ledger.read"]], "filters": [] },
  "visits":      { "perms": [["field.visit.read"]],                        "filters": ["status", "who", "from", "to"] },
  "customers":   { "perms": [["crm.customer.read", "crm.customer.export"]], "filters": ["q", "stage", "territory", "specialty"] },
  "stock":       { "perms": [["inventory.stock.read"]],                    "filters": ["warehouse", "brand", "product"] },
  "tracking":    { "perms": [["field.tracking.read"]],                     "filters": ["date"] }
}$json$
-- export-kinds:end
  ::jsonb
$$;

-- Validate the kind and authorize the caller for it. Returns the kind's whitelist entry.
-- PERMISSION_DENIED names the first missing permission of the first rule; once a rule is held,
-- authz.require runs on each of its permissions, so MFA_REQUIRED applies to flagged ones.
create or replace function audit.require_export(p_kind text) returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  v_spec jsonb := audit.export_kinds() -> p_kind;
  v_rule jsonb;
  v_perm text;
begin
  if p_kind is null or v_spec is null then
    raise exception 'VALIDATION: unknown export kind %', coalesce(p_kind, '(null)') using errcode = '22023';
  end if;
  select a.value into v_rule
  from jsonb_array_elements(v_spec -> 'perms') with ordinality a(value, n)
  where not exists (select 1 from jsonb_array_elements_text(a.value) p(code) where not authz.has_permission(p.code))
  order by a.n
  limit 1;
  if v_rule is null then
    select p.code into v_perm
    from jsonb_array_elements_text(v_spec -> 'perms' -> 0) with ordinality p(code, n)
    where not authz.has_permission(p.code)
    order by p.n limit 1;
    raise exception 'PERMISSION_DENIED: %', v_perm using errcode = '42501';
  end if;
  for v_perm in select p.code from jsonb_array_elements_text(v_rule) p(code) loop
    perform authz.require(v_perm);
  end loop;
  return v_spec;
end $$;

revoke execute on function audit.export_kinds() from public, anon, authenticated;
revoke execute on function audit.require_export(text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Client API
-- ---------------------------------------------------------------------------
create or replace function api.log_export(p_kind text, p_filters jsonb default '{}'::jsonb,
                                          p_row_count int default null, p_request_id text default null)
returns bigint
language plpgsql volatile security definer set search_path = '' as $$
declare
  c_max_exports constant int := 20;                  -- per user per window (no setting exists yet)
  c_window      constant interval := '10 minutes';
  v_uid uuid := auth.uid();
  v_spec jsonb;
  v_filters jsonb := '{}';
  v_n int;
  v_id bigint;
  r record;
begin
  v_spec := audit.require_export(p_kind);
  if v_uid is null then
    raise exception 'PERMISSION_DENIED: not signed in' using errcode = '42501';
  end if;

  if p_filters is not null and jsonb_typeof(p_filters) <> 'object' then
    raise exception 'VALIDATION: filters must be an object' using errcode = '22023';
  end if;
  for r in select e.key, e.value from jsonb_each(coalesce(p_filters, '{}'::jsonb)) e order by e.key loop
    if not (v_spec -> 'filters') ? r.key then
      raise exception 'VALIDATION: filter % is not allowed for export %', left(r.key, 40), p_kind using errcode = '22023';
    end if;
    continue when jsonb_typeof(r.value) = 'null';
    if r.key = 'q' then
      -- Free-text search can hold names or phone numbers: never stored.
      v_filters := v_filters || jsonb_build_object('q', '[redacted]');
    elsif jsonb_typeof(r.value) not in ('string', 'number', 'boolean')
          or (r.value #>> '{}') !~ '^[A-Za-z0-9_.:-]{1,64}$' then
      raise exception 'VALIDATION: filter % must be an id, code or date', r.key using errcode = '22023';
    else
      v_filters := v_filters || jsonb_build_object(r.key, r.value);
    end if;
  end loop;
  if p_row_count is not null and p_row_count < 0 then
    raise exception 'VALIDATION: row count must not be negative' using errcode = '22023';
  end if;

  -- Rate limit, counted from the log. The lock makes concurrent exports of one user queue here.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('audit.export:' || v_uid::text, 0));
  select count(*) into v_n
  from audit.security_events e
  where e.user_id = v_uid and e.event_type = 'export' and e.occurred_at > now() - c_window;
  if v_n >= c_max_exports then
    raise exception 'RATE_LIMITED: at most % exports per 10 minutes; try again later', c_max_exports
      using errcode = 'P0001';
  end if;

  insert into audit.security_events (user_id, event_type, severity, details)
  values (v_uid, 'export', 'info',
          jsonb_build_object(
            'kind', p_kind,
            'filters', v_filters,
            'rows', p_row_count,
            'request_id', case when p_request_id ~ '^[A-Za-z0-9:._-]{1,100}$' then p_request_id end))
  returning id into v_id;
  return v_id;
end $$;
comment on function api.log_export(text, jsonb, int, text) is
  'Server-side export gate (A-L4): whitelisted kind, the kind''s permissions (MFA step-up applies), filters without personal data, at most 20 exports per user per 10 minutes. Logs an audit.security_events ''export'' row and returns its id. The export route calls it before streaming and fails closed.';

create or replace function api.log_export_result(p_export_id bigint, p_row_count int,
                                                 p_truncated boolean default false, p_failed boolean default false)
returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_ev record;
begin
  if v_uid is null then
    raise exception 'PERMISSION_DENIED: not signed in' using errcode = '42501';
  end if;
  if p_row_count is null or p_row_count < 0 then
    raise exception 'VALIDATION: row count must be zero or more' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('audit.export:' || v_uid::text, 0));

  -- Record scope: the caller's own export, opened within the last hour.
  select e.id, e.occurred_at, e.details ->> 'kind' as kind into v_ev
  from audit.security_events e
  where e.id = p_export_id and e.event_type = 'export' and e.user_id = v_uid
    and e.occurred_at > now() - interval '1 hour';
  if not found then
    raise exception 'NOT_FOUND: export %', p_export_id using errcode = 'P0002';
  end if;
  perform audit.require_export(v_ev.kind);
  if exists (select 1 from audit.security_events e
             where e.user_id = v_uid and e.event_type = 'export_result' and e.occurred_at >= v_ev.occurred_at
               and e.details ->> 'export_id' = p_export_id::text) then
    raise exception 'INVALID_STATE: the result of export % is already recorded', p_export_id using errcode = 'P0001';
  end if;

  insert into audit.security_events (user_id, event_type, severity, details)
  values (v_uid, 'export_result', case when coalesce(p_failed, false) then 'warning' else 'info' end,
          jsonb_build_object('export_id', p_export_id, 'kind', v_ev.kind, 'rows', p_row_count,
                             'truncated', coalesce(p_truncated, false), 'failed', coalesce(p_failed, false)));
end $$;
comment on function api.log_export_result(bigint, int, boolean, boolean) is
  'Records the final row count of an export opened with api.log_export (same user, once, within an hour) as an audit.security_events ''export_result'' row.';

revoke execute on function api.log_export(text, jsonb, int, text) from public, anon;
revoke execute on function api.log_export_result(bigint, int, boolean, boolean) from public, anon;
grant execute on function api.log_export(text, jsonb, int, text) to authenticated;
grant execute on function api.log_export_result(bigint, int, boolean, boolean) to authenticated;
