-- Honest OS migration: audit 4, area A — owner guards and step-up on scope changes
--
--   A-M2  core.guard_last_owner_employment is a deferred constraint trigger, so it runs at COMMIT
--         as the caller (`authenticated`). It called core.user_holds_owner_role, which that role
--         cannot execute, so every suspend / terminate failed at commit. It is now SECURITY
--         DEFINER with an empty search_path, like authz.guard_last_owner.
--   A-M3  The last-owner guards counted owners by profile status and role only. One predicate,
--         authz.is_effective_owner(user), now decides for every guard exactly what authz.is_owner()
--         decides for the signed-in user: profile active, employment active or on_leave (or no
--         employee record), owner role active, not revoked and inside valid_from / valid_to.
--         authz.count_active_owners() counts users that pass it.
--         Every owner-affecting change takes one advisory transaction lock (authz.lock_owner_set)
--         before the guard counts, so two owners deactivating each other concurrently are
--         serialised: the second commit re-counts after the first one is visible (READ COMMITTED,
--         which is what PostgREST uses). The guards take it for role revokes / edits, profile
--         suspensions and re-links, and employment changes; api.set_employment_status also takes
--         it up front, before any row lock.
--         A new deferred guard watches core.user_profiles.employee_id (re-linking an owner's
--         profile to a suspended or terminated employee record removes that owner too).
--   A-M1  Commands that change access as much as a flagged permission now ask for the same
--         step-up (authz.require_mfa, only while security.mfa_enforced is on):
--           api.set_employment_status   deactivation and reactivation  → admin.user.suspend
--           api.update_employee         manager or department change   → admin.role.assign
--           api.assign_employee_territory / api.end_employee_territory → admin.role.assign
--           api.move_territory          (changes every territory scope above it) → admin.role.assign
--         The permission flags themselves are unchanged.
--
-- Additive: new helpers and one new trigger; existing functions redefined with CREATE OR
-- REPLACE from their latest definitions (privileges are kept and re-stated below).

-- ---------------------------------------------------------------------------
-- 1. The shared predicate and the owner-set lock (internal; never client-callable)
-- ---------------------------------------------------------------------------
-- Would authz.is_owner() be true for this user? Kept identical to authz.is_active_user() +
-- authz.is_owner() (20261028000500_authz.sql); suite 50 checks that they agree.
create or replace function authz.is_effective_owner(p_user_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_user_id is not null
     and exists (
       select 1 from core.user_profiles p
       left join core.employees e on e.id = p.employee_id
       where p.user_id = p_user_id and p.status = 'active'
         and (e.id is null or e.employment_status in ('active','on_leave')))
     and exists (
       select 1 from authz.user_roles ur join authz.roles r on r.id = ur.role_id
       where ur.user_id = p_user_id and r.is_owner_role and r.is_active
         and ur.revoked_at is null and ur.valid_from <= now()
         and (ur.valid_to is null or ur.valid_to > now()))
$$;

-- ADR-007 count, now of effective owners (also read by core.bootstrap_owner).
create or replace function authz.count_active_owners() returns int
language sql stable security definer set search_path = '' as $$
  select count(distinct ur.user_id)::int
  from authz.user_roles ur
  join authz.roles r on r.id = ur.role_id and r.is_owner_role
  where ur.revoked_at is null and authz.is_effective_owner(ur.user_id)
$$;

-- One fixed key for every change that can remove an owner. Transaction-scoped: released at
-- commit / rollback, after the commit is visible to the waiter.
create or replace function authz.lock_owner_set() returns void
language sql volatile security definer set search_path = '' as $$
  select pg_advisory_xact_lock(hashtextextended('authz.owner_set', 0))
$$;

-- ---------------------------------------------------------------------------
-- 2. The guards
-- ---------------------------------------------------------------------------
-- authz.guard_last_owner — from 20261028000500_authz.sql (its only definition). Changes: the lock
-- before counting; the count uses the effective-owner predicate. Fires for authz.user_roles
-- (update / delete) and core.user_profiles (status, and now employee_id / delete).
create or replace function authz.guard_last_owner() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_affects_owner boolean;
begin
  -- Only changes that touch an owner can remove the last owner. Checking every
  -- change would also block role edits on a fresh database that has no owner yet.
  if tg_table_name = 'user_roles' then
    v_affects_owner := exists (select 1 from authz.roles r where r.id = old.role_id and r.is_owner_role);
  else
    v_affects_owner := exists (select 1 from authz.user_roles ur join authz.roles r on r.id = ur.role_id
                               where ur.user_id = old.user_id and r.is_owner_role and ur.revoked_at is null);
  end if;
  if v_affects_owner then
    -- Serialise with concurrent owner changes, then count with a fresh snapshot.
    perform authz.lock_owner_set();
    if authz.count_active_owners() = 0 then
      raise exception 'LAST_OWNER: at least one active owner must remain' using errcode = 'P0001';
    end if;
  end if;
  return null;
end $$;

-- core.guard_last_owner_employment — from 20261103000810_admin_employees.sql. Changes: SECURITY
-- DEFINER (A-M2); the owner is found through the profile linked to this employee record as well
-- as employees.user_id; lock, then the shared count (A-M3).
create or replace function core.guard_last_owner_employment() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if core.user_holds_owner_role(new.user_id)
     or exists (select 1 from core.user_profiles p
                where p.employee_id = new.id and core.user_holds_owner_role(p.user_id)) then
    perform authz.lock_owner_set();
    if authz.count_active_owners() = 0 then
      raise exception 'LAST_OWNER: at least one active owner must remain' using errcode = 'P0001';
    end if;
  end if;
  return null;
end $$;

-- Re-linking (or removing) an owner's profile can also leave no effective owner.
create constraint trigger trg_profiles_last_owner_link
  after update of employee_id or delete on core.user_profiles deferrable initially deferred
  for each row execute function authz.guard_last_owner();

-- ---------------------------------------------------------------------------
-- 3. Commands (A-M1 step-up; A-M3 lock)
-- ---------------------------------------------------------------------------
-- api.update_employee — from 20261103000810_admin_employees.sql. Change: step-up on a manager or department change.
create or replace function api.update_employee(
  p_employee_id uuid, p_full_name_en text, p_job_title text,
  p_full_name_ar text default null, p_phone text default null, p_email text default null,
  p_department_id uuid default null, p_office_id uuid default null, p_manager_id uuid default null,
  p_hired_on date default null, p_expected_updated_at timestamptz default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_old core.employees%rowtype;
  v_new core.employees%rowtype;
  v_me uuid := authz.current_employee_id();
  v_changed text[];
begin
  perform authz.require('core.employee.manage');
  select * into v_old from core.employees where id = p_employee_id for update;
  if not found then raise exception 'NOT_FOUND: employee' using errcode = 'P0002'; end if;
  if not core.employee_in_scope('core.employee.manage', p_employee_id) then
    raise exception 'PERMISSION_DENIED: employee is outside your scope' using errcode = '42501';
  end if;
  if core.user_holds_owner_role(v_old.user_id) and not authz.is_owner() then
    raise exception 'OWNER_ONLY: only an owner can edit an owner''s record' using errcode = '42501';
  end if;
  if p_expected_updated_at is not null and v_old.updated_at <> p_expected_updated_at then
    raise exception 'CONFLICT: employee was changed by someone else' using errcode = 'P0001';
  end if;
  if coalesce(btrim(p_full_name_en), '') = '' or coalesce(btrim(p_job_title), '') = '' then
    raise exception 'VALIDATION: name and job title are required' using errcode = 'P0001';
  end if;

  v_new := v_old;
  v_new.full_name_en  := btrim(p_full_name_en);
  v_new.full_name_ar  := nullif(btrim(p_full_name_ar), '');
  v_new.job_title     := btrim(p_job_title);
  v_new.phone         := nullif(btrim(p_phone), '')::core.phone_e164;
  v_new.email         := nullif(btrim(p_email), '');
  v_new.department_id := p_department_id;
  v_new.office_id     := p_office_id;
  v_new.manager_id    := p_manager_id;
  v_new.hired_on      := p_hired_on;

  if v_new.department_id is distinct from v_old.department_id and v_new.department_id is not null
     and not exists (select 1 from core.departments where id = v_new.department_id and is_active) then
    raise exception 'NOT_FOUND: active department' using errcode = 'P0002';
  end if;
  if v_new.office_id is distinct from v_old.office_id and v_new.office_id is not null
     and not exists (select 1 from core.offices where id = v_new.office_id and is_active) then
    raise exception 'NOT_FOUND: active office' using errcode = 'P0002';
  end if;
  if v_new.manager_id is distinct from v_old.manager_id and v_new.manager_id is not null then
    if v_new.manager_id = p_employee_id then
      raise exception 'MANAGER_CYCLE: an employee cannot be their own manager' using errcode = 'P0001';
    end if;
    if not exists (select 1 from core.employees where id = v_new.manager_id and employment_status in ('active','on_leave')) then
      raise exception 'NOT_FOUND: active manager' using errcode = 'P0002';
    end if;
    if not core.employee_in_scope('core.employee.manage', v_new.manager_id) then
      raise exception 'PERMISSION_DENIED: the new manager is outside your scope' using errcode = '42501';
    end if;
  end if;
  -- Manager and department drive the caller's own data scope.
  if p_employee_id = v_me and not authz.is_owner()
     and (v_new.manager_id is distinct from v_old.manager_id or v_new.department_id is distinct from v_old.department_id) then
    raise exception 'SELF_GRANT_FORBIDDEN: you cannot change your own manager or department' using errcode = '42501';
  end if;
  -- A-M1 (audit 4): manager and department drive data scope (team / department grants) like a
  -- role grant does, so changing them needs the admin.role.assign step-up while MFA is enforced.
  if v_new.manager_id is distinct from v_old.manager_id or v_new.department_id is distinct from v_old.department_id then
    perform authz.require_mfa('admin.role.assign');
  end if;
  if v_new.terminated_on is not null and v_new.hired_on is not null and v_new.terminated_on < v_new.hired_on then
    raise exception 'VALIDATION: hire date is after the termination date' using errcode = 'P0001';
  end if;

  select array_agg(k order by k) into v_changed
  from jsonb_object_keys(to_jsonb(v_new)) k
  where k not in ('updated_at') and to_jsonb(v_new) -> k is distinct from to_jsonb(v_old) -> k;
  if v_changed is null then
    return jsonb_build_object('employee_id', p_employee_id, 'changed', '[]'::jsonb, 'updated_at', v_old.updated_at);
  end if;

  update core.employees set
    full_name_en = v_new.full_name_en, full_name_ar = v_new.full_name_ar, job_title = v_new.job_title,
    phone = v_new.phone, email = v_new.email, department_id = v_new.department_id, office_id = v_new.office_id,
    manager_id = v_new.manager_id, hired_on = v_new.hired_on
  where id = p_employee_id
  returning updated_at into v_new.updated_at;

  if 'manager_id' = any(v_changed) or 'department_id' = any(v_changed) then
    perform authz.log_security_event('employee_reporting_changed', 'warning',
      jsonb_build_object('employee', p_employee_id, 'old_manager', v_old.manager_id, 'new_manager', v_new.manager_id,
                         'old_department', v_old.department_id, 'new_department', v_new.department_id));
  end if;
  -- Field names only: no names, phones or emails leave through the outbox.
  insert into integration.outbox (event_type, aggregate_type, aggregate_id, payload)
  values ('employee.updated', 'core.employee', p_employee_id,
          jsonb_build_object('employee_id', p_employee_id, 'changed', to_jsonb(v_changed), 'version', 1));
  return jsonb_build_object('employee_id', p_employee_id, 'changed', to_jsonb(v_changed), 'updated_at', v_new.updated_at);
exception when unique_violation then
  raise exception 'DUPLICATE: employee details clash with another record' using errcode = 'P0001';
end $$;

-- api.set_employment_status — from 20261103000810. Changes: owner-set lock; step-up on (de)activation.
create or replace function api.set_employment_status(p_employee_id uuid, p_status text, p_reason text,
                                                     p_effective_on date default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_emp core.employees%rowtype;
  v_owner boolean;
  v_deactivating boolean;
  v_held jsonb;
begin
  perform authz.require('core.employee.manage');
  -- A-M3 (audit 4): a status change can remove an owner. Serialise it with every other
  -- owner-affecting change (taken before any row lock, held until commit).
  perform authz.lock_owner_set();
  if p_status is null or p_status not in ('active','on_leave','suspended','terminated') then
    raise exception 'VALIDATION: unknown employment status %', p_status using errcode = 'P0001';
  end if;
  if coalesce(btrim(p_reason), '') = '' then raise exception 'REASON_REQUIRED' using errcode = 'P0001'; end if;
  select * into v_emp from core.employees where id = p_employee_id for update;
  if not found then raise exception 'NOT_FOUND: employee' using errcode = 'P0002'; end if;
  if not core.employee_in_scope('core.employee.manage', p_employee_id) then
    raise exception 'PERMISSION_DENIED: employee is outside your scope' using errcode = '42501';
  end if;
  if p_employee_id = authz.current_employee_id() then
    raise exception 'SELF_SUSPEND_FORBIDDEN: you cannot change your own employment status' using errcode = '42501';
  end if;
  v_owner := core.user_holds_owner_role(v_emp.user_id);
  if v_owner and not authz.is_owner() then
    raise exception 'OWNER_ONLY: only an owner can change an owner''s status' using errcode = '42501';
  end if;
  if v_emp.employment_status = p_status then
    raise exception 'INVALID_STATE: employee is already %', p_status using errcode = 'P0001';
  end if;
  v_deactivating := p_status in ('suspended','terminated');
  -- A-M1 (audit 4): deactivating or reactivating an employee changes access exactly as
  -- suspending / reactivating the user does, so it needs the admin.user.suspend step-up.
  -- active <-> on_leave changes no access (both count as active in authz.is_active_user).
  if v_deactivating or v_emp.employment_status in ('suspended','terminated') then
    perform authz.require_mfa('admin.user.suspend');
  end if;

  update core.employees set
    employment_status = p_status,
    terminated_on = case when p_status = 'terminated' then coalesce(p_effective_on, core.business_date()) else null end
  where id = p_employee_id;

  select coalesce(jsonb_agg(jsonb_build_object('customer_id', h.customer_id, 'customer_no', h.customer_no,
                                               'display_name', h.display_name, 'role', h.role)), '[]'::jsonb)
    into v_held
  from core.employee_held_customers(p_employee_id) h;

  perform authz.log_security_event('employee_status_changed', case when v_owner then 'critical' else 'warning' end,
    jsonb_build_object('employee', p_employee_id, 'from', v_emp.employment_status, 'to', p_status, 'reason', p_reason,
                       'held_customers', jsonb_array_length(v_held)));
  insert into integration.outbox (event_type, aggregate_type, aggregate_id, payload)
  values ('employee.status_changed', 'core.employee', p_employee_id,
          jsonb_build_object('employee_id', p_employee_id, 'status', p_status, 'version', 1));
  return jsonb_build_object(
    'employee_id', p_employee_id, 'status', p_status, 'deactivated', v_deactivating,
    'held_customers', v_held,
    'direct_reports', (select count(*) from core.employees r where r.manager_id = p_employee_id
                       and r.employment_status in ('active','on_leave')),
    'open_territories', (select count(*) from core.employee_territories et
                         where et.employee_id = p_employee_id and et.valid_to is null));
exception when check_violation then
  raise exception 'VALIDATION: the termination date is before the hire date' using errcode = 'P0001';
end $$;

-- api.assign_employee_territory — from 20261103000810. Change: step-up on a real change.
create or replace function api.assign_employee_territory(p_employee_id uuid, p_territory_id uuid,
                                                         p_assignment text default 'member')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_row core.employee_territories%rowtype; v_created boolean := false;
begin
  perform authz.require('core.territory.manage');
  if p_assignment is null or p_assignment not in ('member','manager') then
    raise exception 'VALIDATION: assignment must be member or manager' using errcode = 'P0001';
  end if;
  if not exists (select 1 from core.employees where id = p_employee_id) then
    raise exception 'NOT_FOUND: employee' using errcode = 'P0002';
  end if;
  if exists (select 1 from core.employees where id = p_employee_id and employment_status = 'terminated') then
    raise exception 'INVALID_STATE: employee is terminated' using errcode = 'P0001';
  end if;
  if not exists (select 1 from core.territories where id = p_territory_id) then
    raise exception 'NOT_FOUND: territory' using errcode = 'P0002';
  end if;
  if not exists (select 1 from core.territories where id = p_territory_id and is_active) then
    raise exception 'INVALID_STATE: territory is inactive' using errcode = 'P0001';
  end if;
  perform core.check_territory_assignment(p_employee_id, p_territory_id);

  select * into v_row from core.employee_territories
  where employee_id = p_employee_id and territory_id = p_territory_id and valid_to is null for update;
  -- A-M1 (audit 4): a territory assignment widens territory scope like a role grant does, so a
  -- real change (not an idempotent re-send) needs the admin.role.assign step-up.
  if found then
    if v_row.assignment = p_assignment then
      return jsonb_build_object('employee_territory_id', v_row.id, 'created', false, 'changed', false);
    end if;
    perform authz.require_mfa('admin.role.assign');
    update core.employee_territories set assignment = p_assignment where id = v_row.id;
  else
    perform authz.require_mfa('admin.role.assign');
    insert into core.employee_territories (employee_id, territory_id, assignment, valid_from)
    values (p_employee_id, p_territory_id, p_assignment, core.business_date())
    returning * into v_row;
    v_created := true;
  end if;

  perform authz.log_security_event('employee_territory_assigned', 'warning',
    jsonb_build_object('employee', p_employee_id, 'territory', p_territory_id, 'assignment', p_assignment));
  insert into integration.outbox (event_type, aggregate_type, aggregate_id, payload)
  values ('employee.territory_assigned', 'core.employee', p_employee_id,
          jsonb_build_object('employee_id', p_employee_id, 'territory_id', p_territory_id,
                             'assignment', p_assignment, 'version', 1));
  return jsonb_build_object('employee_territory_id', v_row.id, 'created', v_created, 'changed', true);
exception when unique_violation then
  raise exception 'CONFLICT: the assignment was changed concurrently' using errcode = 'P0001';
end $$;

-- api.end_employee_territory — from 20261103000810. Change: step-up.
create or replace function api.end_employee_territory(p_employee_territory_id uuid, p_reason text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare v_row core.employee_territories%rowtype;
begin
  perform authz.require('core.territory.manage');
  select * into v_row from core.employee_territories where id = p_employee_territory_id and valid_to is null for update;
  if not found then raise exception 'NOT_FOUND: open territory assignment' using errcode = 'P0002'; end if;
  perform core.check_territory_assignment(v_row.employee_id, v_row.territory_id);
  -- A-M1 (audit 4): ending an assignment changes territory scope; gated like revoking a role.
  perform authz.require_mfa('admin.role.assign');
  update core.employee_territories set valid_to = greatest(core.business_date(), v_row.valid_from + 1)
  where id = v_row.id;
  perform authz.log_security_event('employee_territory_ended', 'warning',
    jsonb_build_object('employee', v_row.employee_id, 'territory', v_row.territory_id,
                       'reason', nullif(btrim(p_reason), '')));
  insert into integration.outbox (event_type, aggregate_type, aggregate_id, payload)
  values ('employee.territory_ended', 'core.employee', v_row.employee_id,
          jsonb_build_object('employee_id', v_row.employee_id, 'territory_id', v_row.territory_id, 'version', 1));
end $$;

-- api.move_territory — from 20261103000820_admin_territories.sql. Change: step-up on a real move.
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
  -- A-M1 (audit 4): a move changes authz.territory_ids for every territory grant above the old
  -- and the new parent (the subtree's customers and employees change hands), so it is gated
  -- like a role grant.
  perform authz.require_mfa('admin.role.assign');

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

-- ---------------------------------------------------------------------------
-- 4. Privileges (explicit; never a blanket grant)
-- ---------------------------------------------------------------------------
revoke execute on function authz.is_effective_owner(uuid) from public, anon, authenticated;
revoke execute on function authz.count_active_owners() from public, anon, authenticated;
revoke execute on function authz.lock_owner_set() from public, anon, authenticated;
revoke execute on function authz.guard_last_owner() from public, anon, authenticated;
revoke execute on function core.guard_last_owner_employment() from public, anon, authenticated;

do $$
declare f text;
begin
  foreach f in array array[
    'api.update_employee(uuid, text, text, text, text, text, uuid, uuid, uuid, date, timestamptz)',
    'api.set_employment_status(uuid, text, text, date)',
    'api.assign_employee_territory(uuid, uuid, text)',
    'api.end_employee_territory(uuid, text)',
    'api.move_territory(uuid, uuid, text)']
  loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
