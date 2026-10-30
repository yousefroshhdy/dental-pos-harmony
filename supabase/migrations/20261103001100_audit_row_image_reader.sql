-- Honest OS migration: audit row-image reader (security audit 2026-10-29 #4 follow-up).
--
-- Since 20261029001000_audit_fixes.sql clients may read only the metadata columns of
-- audit.audit_log (api.v_audit_log). The old/new row images bypass every table's RLS
-- (costs, phones, credit limits, coordinates), so they are readable only through the
-- definer functions below:
--
--   api.audit_search(filters…)                       latest changes matching the filters
--   api.audit_record_history(schema, table, id, …)   one record's timeline
--   api.audit_tables()                               the tables that carry the audit trigger
--
-- Rules:
--   * Gate: audit.row_image.read at scope 'all'. No role holds it; the owner holds every
--     permission implicitly, so by default only owners can read row images. Only a holder
--     can grant it (api.set_role_permission's ceiling), so an admin cannot hand it out.
--   * Masking: audit.row_image_masks lists key patterns per table (LIKE patterns; '%' = any
--     table). Masked values are replaced by the string '[masked:<category>]' at any depth of
--     the image (approval payloads carry credit_limit and balance), and listed in `masked`
--     (path → category). A rule is lifted when the caller holds its unmask permission at
--     scope 'all'; rules with requires_reveal are lifted only when the call also passes
--     p_reveal => true. Defaults: cost needs catalog.cost.read; balances, credit limits,
--     phones, emails and GPS coordinates are masked by default (audit.row_image.unmask
--     plus p_reveal).
--   * Every successful call writes one audit.security_events row
--     ('audit_row_image_read': who, which function, which filters/record, how many rows,
--     which categories were revealed). Severity 'warning' when anything was revealed.
--     A denied call raises and rolls back, so it leaves no row (no autonomous transactions).
--
-- Non-destructive: one new table, new functions, two new permissions.

-- ---------------------------------------------------------------------------
-- 1. Permissions (reference-data pattern). Granted to no role: owners hold them implicitly.
-- ---------------------------------------------------------------------------
insert into authz.permissions (code, module, description, allowed_scopes, supports_limit, is_sensitive) values
  ('audit.row_image.read', 'audit',
   'Read audit row images (old and new values) through the masked audit reader; every read is logged',
   '{all}', false, true),
  ('audit.row_image.unmask', 'audit',
   'Reveal phones, emails, GPS coordinates, balances and credit limits in audit row images; every reveal is logged',
   '{all}', false, true)
on conflict (code) do nothing;

-- ---------------------------------------------------------------------------
-- 2. Mask list (config). Changed by migration only; readable by row-image readers.
-- ---------------------------------------------------------------------------
create table audit.row_image_masks (
  table_schema      text not null default '%',   -- LIKE pattern
  table_name        text not null default '%',   -- LIKE pattern
  key_pattern       text not null,               -- LIKE pattern, matched against keys at any depth
  category          text not null check (category in ('cost','balance','credit_limit','phone','email','gps')),
  unmask_permission text references authz.permissions(code),  -- NULL = never unmasked
  requires_reveal   boolean not null default true,
  primary key (table_schema, table_name, key_pattern)
);
comment on table audit.row_image_masks is
  'Keys masked in audit row images (api.audit_search / api.audit_record_history). Patterns use LIKE: % any, \_ a literal underscore.';

insert into audit.row_image_masks (table_schema, table_name, key_pattern, category, unmask_permission, requires_reveal) values
  ('%', '%', '%cost',            'cost',         'catalog.cost.read',      false),  -- unit_cost, landed_cost
  ('%', '%', 'cost\_%',          'cost',         'catalog.cost.read',      false),
  ('%', '%', '%balance%',        'balance',      'audit.row_image.unmask', true),
  ('%', '%', '%credit\_limit%',  'credit_limit', 'audit.row_image.unmask', true),
  ('%', '%', '%phone%',          'phone',        'audit.row_image.unmask', true),   -- phone, phone_primary, phone_secondary
  ('%', '%', '%mobile%',         'phone',        'audit.row_image.unmask', true),
  ('%', '%', '%email%',          'email',        'audit.row_image.unmask', true),
  ('%', '%', '%latitude',        'gps',          'audit.row_image.unmask', true),
  ('%', '%', '%longitude',       'gps',          'audit.row_image.unmask', true),
  ('%', '%', 'lat',              'gps',          'audit.row_image.unmask', true),
  ('%', '%', 'lng',              'gps',          'audit.row_image.unmask', true),
  ('%', '%', 'lon',              'gps',          'audit.row_image.unmask', true),
  ('%', '%', '%\_lat',           'gps',          'audit.row_image.unmask', true),
  ('%', '%', '%\_lng',           'gps',          'audit.row_image.unmask', true),
  ('%', '%', '%\_lon',           'gps',          'audit.row_image.unmask', true)
on conflict do nothing;

alter table audit.row_image_masks enable row level security;
grant select on audit.row_image_masks to authenticated;
create policy row_image_masks_select on audit.row_image_masks for select to authenticated
  using ((select authz.has_global('audit.row_image.read')));

-- ---------------------------------------------------------------------------
-- 3. Internal helpers (invoker; run as the definer api functions; not client-callable)
-- ---------------------------------------------------------------------------

-- Mask every key matching one of p_rules ([{pattern, category}]) at any depth.
-- Returns {"v": masked value, "m": {"path": "category"}}; NULL values are left as NULL.
create or replace function audit.mask_jsonb(p_value jsonb, p_rules jsonb, p_path text default '')
returns jsonb language plpgsql immutable set search_path = '' as $$
declare
  v_out jsonb; v_m jsonb := '{}'; v_child jsonb; v_path text; v_cat text; r record; i int;
begin
  if p_value is null then
    return jsonb_build_object('v', null, 'm', '{}'::jsonb);
  elsif jsonb_typeof(p_value) = 'object' then
    v_out := '{}';
    for r in select e.key, e.value from jsonb_each(p_value) e loop
      v_path := case when p_path = '' then r.key else p_path || '.' || r.key end;
      select x ->> 'category' into v_cat
      from jsonb_array_elements(p_rules) x
      where r.key like (x ->> 'pattern')
      limit 1;
      if v_cat is not null and jsonb_typeof(r.value) <> 'null' then
        v_out := v_out || jsonb_build_object(r.key, '[masked:' || v_cat || ']');
        v_m := v_m || jsonb_build_object(v_path, v_cat);
      else
        v_child := audit.mask_jsonb(r.value, p_rules, v_path);
        v_out := v_out || jsonb_build_object(r.key, v_child -> 'v');
        v_m := v_m || (v_child -> 'm');
      end if;
    end loop;
  elsif jsonb_typeof(p_value) = 'array' then
    v_out := '[]';
    for i in 0 .. jsonb_array_length(p_value) - 1 loop
      v_child := audit.mask_jsonb(p_value -> i, p_rules, p_path || '[' || i || ']');
      v_out := v_out || jsonb_build_array(v_child -> 'v');
      v_m := v_m || (v_child -> 'm');
    end loop;
  else
    v_out := p_value;
  end if;
  return jsonb_build_object('v', v_out, 'm', v_m);
end $$;

-- Mask one audit entry for a caller holding p_held (unmask permissions held at scope 'all').
-- Returns {"old", "new", "masked": {path: category}, "revealed": {path: category}}.
create or replace function audit.mask_entry(p_schema text, p_table text, p_old jsonb, p_new jsonb,
                                            p_held text[], p_reveal boolean)
returns jsonb language plpgsql stable set search_path = '' as $$
declare
  v_mask jsonb; v_reveal jsonb; v_o jsonb; v_n jsonb; v_masked jsonb; v_revealed jsonb := '{}';
begin
  select coalesce(jsonb_agg(jsonb_build_object('pattern', m.key_pattern, 'category', m.category)
                            order by m.category, m.key_pattern) filter (where not m.lifted), '[]'),
         coalesce(jsonb_agg(jsonb_build_object('pattern', m.key_pattern, 'category', m.category)
                            order by m.category, m.key_pattern) filter (where m.lifted and m.requires_reveal), '[]')
  into v_mask, v_reveal
  from (select rm.key_pattern, rm.category, rm.requires_reveal,
               coalesce(rm.unmask_permission = any(p_held), false)
                 and (not rm.requires_reveal or coalesce(p_reveal, false)) as lifted
        from audit.row_image_masks rm
        where p_schema like rm.table_schema and p_table like rm.table_name) m;

  v_o := audit.mask_jsonb(p_old, v_mask);
  v_n := audit.mask_jsonb(p_new, v_mask);
  v_masked := (v_o -> 'm') || (v_n -> 'm');

  if v_reveal <> '[]'::jsonb then
    -- What the reveal uncovered: keys the reveal rules would have masked, minus keys still masked.
    v_revealed := ((audit.mask_jsonb(p_old, v_reveal) -> 'm') || (audit.mask_jsonb(p_new, v_reveal) -> 'm'))
                  - array(select jsonb_object_keys(v_masked));
  end if;

  return jsonb_build_object(
    'old', case when p_old is null then null else v_o -> 'v' end,
    'new', case when p_new is null then null else v_n -> 'v' end,
    'masked', v_masked,
    'revealed', v_revealed);
end $$;

-- The shared reader. Callers (api.audit_search / api.audit_record_history) authorize first.
create or replace function audit.read_row_images(
  p_function text, p_filters jsonb,
  p_table_schema text, p_table_name text, p_record_id text, p_actor_user_id uuid,
  p_from date, p_to date, p_action text, p_before_id bigint, p_limit int, p_reveal boolean)
returns table (id bigint, occurred_at timestamptz, actor_user_id uuid, actor_name_en text, actor_name_ar text,
               action text, table_schema text, table_name text, record_id text, changed_fields text[],
               request_id text, old_data jsonb, new_data jsonb, masked jsonb)
language plpgsql volatile set search_path = '' as $$
#variable_conflict use_column
declare
  v_limit int := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_reveal boolean := coalesce(p_reveal, false);
  v_held text[];
  v_revealed text[] := '{}';
  v_rows int := 0;
  v_e jsonb;
  r record;
begin
  if p_action is not null and p_action not in ('INSERT', 'UPDATE', 'DELETE') then
    raise exception 'VALIDATION: action must be INSERT, UPDATE or DELETE' using errcode = '22023';
  end if;
  if p_from is not null and p_to is not null and p_from > p_to then
    raise exception 'VALIDATION: the start date is after the end date' using errcode = '22023';
  end if;

  -- Unmask permissions the caller holds company-wide, evaluated once per call.
  select coalesce(array_agg(distinct m.unmask_permission), '{}') into v_held
  from audit.row_image_masks m
  where m.unmask_permission is not null and authz.has_global(m.unmask_permission);

  for r in
    select a.id, a.occurred_at, a.actor_user_id, e.full_name_en, e.full_name_ar, a.action,
           a.table_schema, a.table_name, a.record_id, a.changed_fields, a.request_id, a.old_data, a.new_data
    from audit.audit_log a
    left join core.user_profiles up on up.user_id = a.actor_user_id
    left join core.employees e on e.id = up.employee_id
    where (p_table_schema is null or a.table_schema = p_table_schema)
      and (p_table_name is null or a.table_name = p_table_name)
      and (p_record_id is null or a.record_id = p_record_id)
      and (p_actor_user_id is null or a.actor_user_id = p_actor_user_id)
      and (p_action is null or a.action = p_action)
      and (p_from is null or a.occurred_at >= (p_from::timestamp at time zone 'Africa/Cairo'))
      and (p_to is null or a.occurred_at < ((p_to + 1)::timestamp at time zone 'Africa/Cairo'))
      and (p_before_id is null or a.id < p_before_id)
    order by a.id desc
    limit v_limit
  loop
    v_e := audit.mask_entry(r.table_schema, r.table_name, r.old_data, r.new_data, v_held, v_reveal);
    id := r.id;
    occurred_at := r.occurred_at;
    actor_user_id := r.actor_user_id;
    actor_name_en := r.full_name_en;
    actor_name_ar := r.full_name_ar;
    action := r.action;
    table_schema := r.table_schema;
    table_name := r.table_name;
    record_id := r.record_id;
    changed_fields := r.changed_fields;
    request_id := r.request_id;
    old_data := v_e -> 'old';
    new_data := v_e -> 'new';
    masked := v_e -> 'masked';
    v_revealed := v_revealed || array(select x.value from jsonb_each_text(v_e -> 'revealed') x);
    v_rows := v_rows + 1;
    return next;
  end loop;

  -- The read itself is a security event: who looked at what.
  insert into audit.security_events (user_id, event_type, severity, details)
  values (auth.uid(), 'audit_row_image_read',
          case when cardinality(v_revealed) > 0 then 'warning' else 'info' end,
          jsonb_build_object(
            'function', p_function,
            'filters', coalesce(p_filters, '{}'::jsonb),
            'rows', v_rows,
            'reveal_requested', v_reveal,
            'revealed', (select coalesce(jsonb_agg(distinct c order by c), '[]'::jsonb) from unnest(v_revealed) c)));
end $$;

revoke execute on function audit.mask_jsonb(jsonb, jsonb, text) from public, anon, authenticated;
revoke execute on function audit.mask_entry(text, text, jsonb, jsonb, text[], boolean) from public, anon, authenticated;
revoke execute on function audit.read_row_images(text, jsonb, text, text, text, uuid, date, date, text, bigint, int, boolean)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Client API
-- ---------------------------------------------------------------------------
create or replace function audit.require_row_image_reader() returns void
language plpgsql stable set search_path = '' as $$
begin
  perform authz.require('audit.row_image.read');
  -- Scope check: row images are company-wide data, so only a company-wide grant reads them.
  if not authz.has_global('audit.row_image.read') then
    raise exception 'PERMISSION_DENIED: audit.row_image.read requires scope all' using errcode = '42501';
  end if;
end $$;
revoke execute on function audit.require_row_image_reader() from public, anon, authenticated;

create or replace function api.audit_search(
  p_table_schema text default null, p_table_name text default null, p_record_id text default null,
  p_actor_user_id uuid default null, p_from date default null, p_to date default null,
  p_action text default null, p_before_id bigint default null, p_limit int default 50,
  p_reveal boolean default false)
returns table (id bigint, occurred_at timestamptz, actor_user_id uuid, actor_name_en text, actor_name_ar text,
               action text, table_schema text, table_name text, record_id text, changed_fields text[],
               request_id text, old_data jsonb, new_data jsonb, masked jsonb)
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_schema text := nullif(btrim(p_table_schema), '');
  v_table  text := nullif(btrim(p_table_name), '');
  v_record text := nullif(btrim(p_record_id), '');
  v_action text := upper(nullif(btrim(p_action), ''));
begin
  perform audit.require_row_image_reader();
  return query
    select * from audit.read_row_images(
      'audit_search',
      jsonb_strip_nulls(jsonb_build_object(
        'table_schema', v_schema, 'table_name', v_table, 'record_id', v_record,
        'actor_user_id', p_actor_user_id, 'from', p_from, 'to', p_to, 'action', v_action,
        'before_id', p_before_id, 'limit', p_limit)),
      v_schema, v_table, v_record, p_actor_user_id, p_from, p_to, v_action, p_before_id, p_limit, p_reveal);
end $$;
comment on function api.audit_search(text, text, text, uuid, date, date, text, bigint, int, boolean) is
  'Owner-only (audit.row_image.read, scope all) masked audit row images, newest first, keyset-paged by p_before_id. Dates are Cairo business days, inclusive. Logged as a security event.';

create or replace function api.audit_record_history(
  p_table_schema text, p_table_name text, p_record_id text,
  p_before_id bigint default null, p_limit int default 100, p_reveal boolean default false)
returns table (id bigint, occurred_at timestamptz, actor_user_id uuid, actor_name_en text, actor_name_ar text,
               action text, table_schema text, table_name text, record_id text, changed_fields text[],
               request_id text, old_data jsonb, new_data jsonb, masked jsonb)
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_schema text := nullif(btrim(p_table_schema), '');
  v_table  text := nullif(btrim(p_table_name), '');
  v_record text := nullif(btrim(p_record_id), '');
begin
  perform audit.require_row_image_reader();
  if v_schema is null or v_table is null or v_record is null then
    raise exception 'VALIDATION: schema, table and record id are required' using errcode = '22023';
  end if;
  return query
    select * from audit.read_row_images(
      'audit_record_history',
      jsonb_strip_nulls(jsonb_build_object(
        'table_schema', v_schema, 'table_name', v_table, 'record_id', v_record,
        'before_id', p_before_id, 'limit', p_limit)),
      v_schema, v_table, v_record, null, null, null, null, p_before_id, p_limit, p_reveal);
end $$;
comment on function api.audit_record_history(text, text, text, bigint, int, boolean) is
  'Owner-only (audit.row_image.read, scope all) masked change history of one record, newest first. Logged as a security event.';

-- Tables that carry the audit trigger (search filter options). Metadata only; not logged.
create or replace function api.audit_tables()
returns table (table_schema text, table_name text)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform audit.require_row_image_reader();
  return query
    select distinct n.nspname::text, c.relname::text
    from pg_catalog.pg_trigger t
    join pg_catalog.pg_class c on c.oid = t.tgrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where t.tgfoid = 'audit.log_change()'::pg_catalog.regprocedure and not t.tgisinternal
    order by 1, 2;
end $$;

revoke execute on function api.audit_search(text, text, text, uuid, date, date, text, bigint, int, boolean) from public, anon;
revoke execute on function api.audit_record_history(text, text, text, bigint, int, boolean) from public, anon;
revoke execute on function api.audit_tables() from public, anon;
grant execute on function api.audit_search(text, text, text, uuid, date, date, text, bigint, int, boolean) to authenticated;
grant execute on function api.audit_record_history(text, text, text, bigint, int, boolean) to authenticated;
grant execute on function api.audit_tables() to authenticated;
