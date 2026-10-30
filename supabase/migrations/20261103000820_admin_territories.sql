-- Honest OS migration: admin console v2, territories & coverage (ROADMAP Phase 3 task 1)
--
--   api.create_territory()           new region / area / sub-area (level follows the depth)
--   api.rename_territory()           names only (the code is the identity used in events)
--   api.move_territory()             new parent (cycle-safe, depth ≤ 3, subtree levels follow)
--   api.set_territory_active()       deactivate (no active children) / reactivate (parent active)
--   api.set_territory_coverage()     governorate (+ optional city) → territory
--   api.remove_territory_coverage()
--   api.territory_customer_counts()  customers and employees per territory (aggregates only)
--   api.v_territory_coverage
--
-- Rules:
--   * The tree never forms a cycle: a BEFORE trigger walks the ancestors under an advisory lock
--     and raises TERRITORY_CYCLE (backstop for every write path).
--   * Depth: region (root) → area → sub_area. Commands refuse a fourth level (TERRITORY_TOO_DEEP).
--   * Scope: core.territory.manage. Root regions, moves to the root and coverage taken from a
--     territory outside the caller's scope need the permission at `all`.
--   * Deactivation keeps customers, assignments and coverage where they are (they are counted
--     in the result); inactive territories are skipped by coverage lookups and new customers.
-- Additive only.

-- ---------------------------------------------------------------------------
-- 1. Tree helpers and the cycle guard
-- ---------------------------------------------------------------------------
-- Number of ancestors (a root is 0).
create or replace function core.territory_depth(p_territory_id uuid) returns int
language sql stable set search_path = '' as $$
  with recursive up(id, parent_id, n) as (
    select t.id, t.parent_id, 0 from core.territories t where t.id = p_territory_id
    union all
    select t.id, t.parent_id, up.n + 1 from core.territories t join up on t.id = up.parent_id where up.n < 32)
  select max(n) from up
$$;

-- Levels below the territory (a leaf is 0).
create or replace function core.territory_height(p_territory_id uuid) returns int
language sql stable set search_path = '' as $$
  with recursive down(id, n) as (
    select p_territory_id, 0
    union all
    select t.id, down.n + 1 from core.territories t join down on t.parent_id = down.id where down.n < 32)
  select max(n) from down
$$;

create or replace function core.territory_level_for_depth(p_depth int) returns text
language sql immutable set search_path = '' as $$
  select (array['region','area','sub_area'])[p_depth + 1]
$$;

create or replace function core.guard_territory_cycle() returns trigger
language plpgsql set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('core.territories.tree', 0));
  if new.parent_id = new.id or exists (
       with recursive up(id) as (
         select new.parent_id
         union
         select t.parent_id from core.territories t join up on t.id = up.id where t.parent_id is not null)
       select 1 from up where up.id = new.id) then
    raise exception 'TERRITORY_CYCLE: % cannot sit under its own sub-territory', new.code using errcode = 'P0001';
  end if;
  return new;
end $$;
-- UPDATE only: a new territory has no children, so an insert cannot close a loop.
create trigger trg_territories_cycle before update of parent_id on core.territories
  for each row when (new.parent_id is not null and new.parent_id is distinct from old.parent_id)
  execute function core.guard_territory_cycle();

create or replace function core.territory_in_scope(p_territory_id uuid) returns boolean
language sql stable set search_path = '' as $$
  select authz.has_global('core.territory.manage')
      or p_territory_id = any(authz.territory_ids('core.territory.manage'))
$$;

create or replace function core.emit_territory_event(p_event text, p_territory_id uuid, p_extra jsonb default '{}')
returns void language sql set search_path = '' as $$
  insert into integration.outbox (event_type, aggregate_type, aggregate_id, payload)
  select p_event, 'core.territory', t.id,
         jsonb_build_object('territory_id', t.id, 'code', t.code, 'parent_id', t.parent_id, 'level', t.level,
                            'is_active', t.is_active, 'version', 1) || coalesce(p_extra, '{}')
  from core.territories t where t.id = p_territory_id
$$;

-- Coverage history (who moved a governorate between territories).
create trigger trg_audit after insert or update or delete on core.territory_coverage
  for each row execute function audit.log_change();

-- ---------------------------------------------------------------------------
-- 2. Commands
-- ---------------------------------------------------------------------------
create or replace function api.create_territory(p_code text, p_name_en text, p_name_ar text,
                                                p_parent_id uuid default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_code text := upper(btrim(p_code)); v_depth int := 0; v_id uuid;
begin
  perform authz.require('core.territory.manage');
  if v_code is null or v_code !~ '^[A-Z0-9][A-Z0-9-]{1,39}$' then
    raise exception 'VALIDATION: territory code must be 2–40 capital letters, digits or hyphens' using errcode = 'P0001';
  end if;
  if coalesce(btrim(p_name_en), '') = '' or coalesce(btrim(p_name_ar), '') = ''
     or length(p_name_en) > 120 or length(p_name_ar) > 120 then
    raise exception 'VALIDATION: English and Arabic names are required (at most 120 characters)' using errcode = 'P0001';
  end if;
  if p_parent_id is null then
    if not authz.has_global('core.territory.manage') then
      raise exception 'PERMISSION_DENIED: only company-wide territory managers create regions' using errcode = '42501';
    end if;
  else
    if not exists (select 1 from core.territories where id = p_parent_id) then
      raise exception 'NOT_FOUND: parent territory' using errcode = 'P0002';
    end if;
    if not exists (select 1 from core.territories where id = p_parent_id and is_active) then
      raise exception 'INVALID_STATE: parent territory is inactive' using errcode = 'P0001';
    end if;
    if not core.territory_in_scope(p_parent_id) then
      raise exception 'PERMISSION_DENIED: parent territory is outside your scope' using errcode = '42501';
    end if;
    v_depth := core.territory_depth(p_parent_id) + 1;
    if v_depth > 2 then
      raise exception 'TERRITORY_TOO_DEEP: territories have at most three levels' using errcode = 'P0001';
    end if;
  end if;

  insert into core.territories (code, name_en, name_ar, parent_id, level)
  values (v_code, btrim(p_name_en), btrim(p_name_ar), p_parent_id, core.territory_level_for_depth(v_depth))
  returning id into v_id;
  perform core.emit_territory_event('territory.created', v_id);
  return v_id;
exception when unique_violation then
  raise exception 'DUPLICATE: territory % already exists', v_code using errcode = 'P0001';
end $$;

create or replace function api.rename_territory(p_territory_id uuid, p_name_en text, p_name_ar text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform authz.require('core.territory.manage');
  if coalesce(btrim(p_name_en), '') = '' or coalesce(btrim(p_name_ar), '') = ''
     or length(p_name_en) > 120 or length(p_name_ar) > 120 then
    raise exception 'VALIDATION: English and Arabic names are required (at most 120 characters)' using errcode = 'P0001';
  end if;
  if not exists (select 1 from core.territories where id = p_territory_id) then
    raise exception 'NOT_FOUND: territory' using errcode = 'P0002';
  end if;
  if not core.territory_in_scope(p_territory_id) then
    raise exception 'PERMISSION_DENIED: territory is outside your scope' using errcode = '42501';
  end if;
  update core.territories set name_en = btrim(p_name_en), name_ar = btrim(p_name_ar)
  where id = p_territory_id and (name_en, name_ar) is distinct from (btrim(p_name_en), btrim(p_name_ar));
  if found then perform core.emit_territory_event('territory.renamed', p_territory_id); end if;
end $$;

-- p_new_parent_id NULL = make it a region. Returns {territory_id, changed, level}.
create or replace function api.move_territory(p_territory_id uuid, p_new_parent_id uuid, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_t core.territories%rowtype; v_base int := 0;
begin
  perform authz.require('core.territory.manage');
  -- Same lock as the trigger: no concurrent move can interleave between the checks and the update.
  perform pg_advisory_xact_lock(hashtextextended('core.territories.tree', 0));
  select * into v_t from core.territories where id = p_territory_id for update;
  if not found then raise exception 'NOT_FOUND: territory' using errcode = 'P0002'; end if;
  if not core.territory_in_scope(p_territory_id) then
    raise exception 'PERMISSION_DENIED: territory is outside your scope' using errcode = '42501';
  end if;
  if v_t.parent_id is not distinct from p_new_parent_id then
    return jsonb_build_object('territory_id', p_territory_id, 'changed', false, 'level', v_t.level);
  end if;
  if p_new_parent_id is null then
    if not authz.has_global('core.territory.manage') then
      raise exception 'PERMISSION_DENIED: only company-wide territory managers create regions' using errcode = '42501';
    end if;
  else
    if not exists (select 1 from core.territories where id = p_new_parent_id) then
      raise exception 'NOT_FOUND: parent territory' using errcode = 'P0002';
    end if;
    -- Cycle: the new parent is the territory itself or one of its descendants.
    if p_new_parent_id = p_territory_id or exists (
         with recursive down(id) as (
           select p_territory_id
           union
           select t.id from core.territories t join down on t.parent_id = down.id)
         select 1 from down where down.id = p_new_parent_id) then
      raise exception 'TERRITORY_CYCLE: a territory cannot move under its own sub-territory' using errcode = 'P0001';
    end if;
    if not exists (select 1 from core.territories where id = p_new_parent_id and is_active) then
      raise exception 'INVALID_STATE: parent territory is inactive' using errcode = 'P0001';
    end if;
    if not core.territory_in_scope(p_new_parent_id) then
      raise exception 'PERMISSION_DENIED: the new parent is outside your scope' using errcode = '42501';
    end if;
    v_base := core.territory_depth(p_new_parent_id) + 1;
  end if;
  if v_base + core.territory_height(p_territory_id) > 2 then
    raise exception 'TERRITORY_TOO_DEEP: territories have at most three levels' using errcode = 'P0001';
  end if;

  update core.territories set parent_id = p_new_parent_id where id = p_territory_id;
  -- The levels of the moved subtree follow its new depth.
  with recursive down(id, n) as (
    select p_territory_id, v_base
    union all
    select t.id, down.n + 1 from core.territories t join down on t.parent_id = down.id)
  update core.territories t set level = core.territory_level_for_depth(down.n)
  from down where t.id = down.id and t.level is distinct from core.territory_level_for_depth(down.n);

  perform authz.log_security_event('territory_moved', 'warning',
    jsonb_build_object('territory', p_territory_id, 'code', v_t.code, 'old_parent', v_t.parent_id,
                       'new_parent', p_new_parent_id, 'reason', nullif(btrim(p_reason), '')));
  perform core.emit_territory_event('territory.moved', p_territory_id, jsonb_build_object('old_parent_id', v_t.parent_id));
  return jsonb_build_object('territory_id', p_territory_id, 'changed', true, 'level', core.territory_level_for_depth(v_base));
end $$;

-- Returns {territory_id, is_active, customers, open_assignments, coverage}: what still points at it.
create or replace function api.set_territory_active(p_territory_id uuid, p_active boolean, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_t core.territories%rowtype;
begin
  perform authz.require('core.territory.manage');
  if p_active is null then raise exception 'VALIDATION: active flag is required' using errcode = 'P0001'; end if;
  if coalesce(btrim(p_reason), '') = '' then raise exception 'REASON_REQUIRED' using errcode = 'P0001'; end if;
  select * into v_t from core.territories where id = p_territory_id for update;
  if not found then raise exception 'NOT_FOUND: territory' using errcode = 'P0002'; end if;
  if not core.territory_in_scope(p_territory_id) then
    raise exception 'PERMISSION_DENIED: territory is outside your scope' using errcode = '42501';
  end if;
  if v_t.is_active = p_active then
    raise exception 'INVALID_STATE: territory is already %', case when p_active then 'active' else 'inactive' end
      using errcode = 'P0001';
  end if;
  if not p_active and exists (select 1 from core.territories where parent_id = p_territory_id and is_active) then
    raise exception 'TERRITORY_HAS_CHILDREN: deactivate or move its sub-territories first' using errcode = 'P0001';
  end if;
  if p_active and v_t.parent_id is not null
     and not exists (select 1 from core.territories where id = v_t.parent_id and is_active) then
    raise exception 'INVALID_STATE: reactivate the parent territory first' using errcode = 'P0001';
  end if;

  update core.territories set is_active = p_active where id = p_territory_id;
  perform authz.log_security_event(case when p_active then 'territory_reactivated' else 'territory_deactivated' end,
    'warning', jsonb_build_object('territory', p_territory_id, 'code', v_t.code, 'reason', p_reason));
  perform core.emit_territory_event(case when p_active then 'territory.reactivated' else 'territory.deactivated' end,
                                    p_territory_id);
  return jsonb_build_object(
    'territory_id', p_territory_id, 'is_active', p_active,
    'customers', (select count(*) from crm.customers c where c.territory_id = p_territory_id and c.archived_at is null),
    'open_assignments', (select count(*) from core.employee_territories et
                         where et.territory_id = p_territory_id and et.valid_to is null),
    'coverage', (select count(*) from core.territory_coverage tc where tc.territory_id = p_territory_id));
end $$;

-- city '*' (or empty) = the whole governorate. A city is matched case-insensitively, like
-- api.create_customer does. Returns {governorate_code, city, territory_id, previous_territory_id}.
create or replace function api.set_territory_coverage(p_territory_id uuid, p_governorate_code text, p_city text default '*')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_city text := coalesce(nullif(btrim(p_city), ''), '*'); v_row core.territory_coverage%rowtype;
begin
  perform authz.require('core.territory.manage');
  if length(v_city) > 80 or v_city ~ '[[:cntrl:]]' then
    raise exception 'VALIDATION: city name is too long' using errcode = 'P0001';
  end if;
  if not exists (select 1 from core.governorates where code = p_governorate_code) then
    raise exception 'NOT_FOUND: governorate' using errcode = 'P0002';
  end if;
  if not exists (select 1 from core.territories where id = p_territory_id) then
    raise exception 'NOT_FOUND: territory' using errcode = 'P0002';
  end if;
  if not exists (select 1 from core.territories where id = p_territory_id and is_active) then
    raise exception 'INVALID_STATE: territory is inactive' using errcode = 'P0001';
  end if;
  if not core.territory_in_scope(p_territory_id) then
    raise exception 'PERMISSION_DENIED: territory is outside your scope' using errcode = '42501';
  end if;

  select * into v_row from core.territory_coverage
  where governorate_code = p_governorate_code and lower(city) = lower(v_city) for update;
  if found then
    if v_row.territory_id = p_territory_id then
      return jsonb_build_object('governorate_code', p_governorate_code, 'city', v_row.city,
                                'territory_id', p_territory_id, 'previous_territory_id', p_territory_id);
    end if;
    -- Taking coverage away from a territory outside your scope changes someone else's map.
    if not core.territory_in_scope(v_row.territory_id) then
      raise exception 'PERMISSION_DENIED: that area is covered by a territory outside your scope' using errcode = '42501';
    end if;
    update core.territory_coverage set territory_id = p_territory_id
    where governorate_code = v_row.governorate_code and city = v_row.city;
  else
    insert into core.territory_coverage (territory_id, governorate_code, city)
    values (p_territory_id, p_governorate_code, v_city);
    v_row.city := v_city;
  end if;
  perform core.emit_territory_event('territory.coverage_changed', p_territory_id,
    jsonb_build_object('governorate_code', p_governorate_code, 'city', v_row.city,
                       'previous_territory_id', v_row.territory_id));
  return jsonb_build_object('governorate_code', p_governorate_code, 'city', v_row.city,
                            'territory_id', p_territory_id, 'previous_territory_id', v_row.territory_id);
end $$;

create or replace function api.remove_territory_coverage(p_governorate_code text, p_city text default '*')
returns void language plpgsql security definer set search_path = '' as $$
declare v_city text := coalesce(nullif(btrim(p_city), ''), '*'); v_row core.territory_coverage%rowtype;
begin
  perform authz.require('core.territory.manage');
  select * into v_row from core.territory_coverage
  where governorate_code = p_governorate_code and lower(city) = lower(v_city) for update;
  if not found then raise exception 'NOT_FOUND: coverage' using errcode = 'P0002'; end if;
  if not core.territory_in_scope(v_row.territory_id) then
    raise exception 'PERMISSION_DENIED: territory is outside your scope' using errcode = '42501';
  end if;
  delete from core.territory_coverage where governorate_code = v_row.governorate_code and city = v_row.city;
  perform core.emit_territory_event('territory.coverage_changed', v_row.territory_id,
    jsonb_build_object('governorate_code', v_row.governorate_code, 'city', v_row.city, 'removed', true));
end $$;

-- Aggregates per territory (direct, not rolled up; the UI rolls the tree up). A row with a NULL
-- territory counts customers without one (company-wide callers only). Counts only: no names.
create or replace function api.territory_customer_counts()
returns table (territory_id uuid, customers int, active_customers int, leads int, employees int)
language plpgsql stable security definer set search_path = '' as $$
declare v_all boolean; v_scope uuid[];
begin
  perform authz.require('core.territory.manage');
  v_all := authz.has_global('core.territory.manage');
  v_scope := case when v_all then null else authz.territory_ids('core.territory.manage') end;
  return query
    select t.id,
           (select count(*) from crm.customers c where c.territory_id = t.id and c.archived_at is null)::int,
           (select count(*) from crm.customers c where c.territory_id = t.id and c.archived_at is null
              and c.lifecycle_stage = 'active')::int,
           (select count(*) from crm.customers c where c.territory_id = t.id and c.archived_at is null
              and c.lifecycle_stage in ('lead','prospect'))::int,
           (select count(distinct et.employee_id) from core.employee_territories et
              where et.territory_id = t.id and et.valid_to is null)::int
    from core.territories t
    where v_all or t.id = any(v_scope)
    union all
    select null::uuid,
           count(*)::int,
           (count(*) filter (where c.lifecycle_stage = 'active'))::int,
           (count(*) filter (where c.lifecycle_stage in ('lead','prospect')))::int,
           0
    from crm.customers c
    where v_all and c.territory_id is null and c.archived_at is null
    having v_all;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Read view
-- ---------------------------------------------------------------------------
create or replace view api.v_territory_coverage with (security_invoker = true) as
  select tc.territory_id, t.code as territory_code, t.name_en as territory_name_en, t.name_ar as territory_name_ar,
         t.is_active as territory_active, tc.governorate_code, g.name_en as governorate_name_en,
         g.name_ar as governorate_name_ar, tc.city
  from core.territory_coverage tc
  join core.territories t on t.id = tc.territory_id
  join core.governorates g on g.code = tc.governorate_code;

-- ---------------------------------------------------------------------------
-- 4. Privileges (explicit; never a blanket grant)
-- ---------------------------------------------------------------------------
revoke execute on function core.territory_depth(uuid) from public, anon, authenticated;
revoke execute on function core.territory_height(uuid) from public, anon, authenticated;
revoke execute on function core.territory_level_for_depth(int) from public, anon, authenticated;
revoke execute on function core.guard_territory_cycle() from public, anon, authenticated;
revoke execute on function core.territory_in_scope(uuid) from public, anon, authenticated;
revoke execute on function core.emit_territory_event(text, uuid, jsonb) from public, anon, authenticated;

do $$
declare f text;
begin
  foreach f in array array[
    'api.create_territory(text, text, text, uuid)',
    'api.rename_territory(uuid, text, text)',
    'api.move_territory(uuid, uuid, text)',
    'api.set_territory_active(uuid, boolean, text)',
    'api.set_territory_coverage(uuid, text, text)',
    'api.remove_territory_coverage(text, text)',
    'api.territory_customer_counts()']
  loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
grant select on api.v_territory_coverage to authenticated;
