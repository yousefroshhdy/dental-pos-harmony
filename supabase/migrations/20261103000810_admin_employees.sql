-- Honest OS migration: admin console v2, employees
--
--   api.update_employee()             names, job title, contact, department, office, manager chain
--   api.set_employment_status()       active / on_leave / suspended / terminated (with reason)
--   api.employee_customer_holdings()  the customers an employee holds (for a hand-over list)
--   api.assign_employee_territory()   open or retype a territory assignment (member / manager)
--   api.end_employee_territory()      close a territory assignment
--   api.v_admin_employees, api.v_employee_territories, api.v_departments, api.v_offices
--
-- Rules:
--   * Manager chains never form a cycle: a BEFORE trigger walks the chain under an advisory
--     lock (so two concurrent edits cannot each close half a loop) and raises MANAGER_CYCLE.
--   * Scope: the target employee (and a new manager) must be inside the caller's scope of
--     core.employee.manage (own / team / territory / department / all).
--   * Nobody but an owner changes their own manager, department, status or territories
--     (those drive their own data scope), and only an owner edits an owner's record.
--   * Deactivating an employee reassigns NOTHING: it returns the customers they still hold
--     so the manager can hand them over deliberately (crm reassign workflow).
--   * Ending the employment of the last active owner is refused (LAST_OWNER), checked at commit.
-- Additive only: new functions, triggers, policies and views.

-- ---------------------------------------------------------------------------
-- 1. Internal helpers (invoker; called only from the definer commands below)
-- ---------------------------------------------------------------------------
-- True when p_employee_id lies inside the caller's scope of p_perm.
create or replace function core.employee_in_scope(p_perm text, p_employee_id uuid) returns boolean
language sql stable set search_path = '' as $$
  select authz.has_global(p_perm)
      or p_employee_id = any(authz.employee_ids(p_perm))
      or exists (select 1 from core.employee_territories et
                 where et.employee_id = p_employee_id and et.valid_to is null
                   and et.territory_id = any(authz.territory_ids(p_perm)))
      or exists (select 1 from authz.grants(p_perm) g
                 join core.employees e on e.id = p_employee_id
                 where g.scope = 'department' and e.department_id is not null
                   and e.department_id = coalesce(g.department_id,
                         (select me.department_id from core.employees me where me.id = authz.current_employee_id())))
$$;

-- The user holds the owner role (whatever their current status).
create or replace function core.user_holds_owner_role(p_user_id uuid) returns boolean
language sql stable set search_path = '' as $$
  select p_user_id is not null and exists (
    select 1 from authz.user_roles ur join authz.roles r on r.id = ur.role_id
    where ur.user_id = p_user_id and r.is_owner_role and ur.revoked_at is null
      and (ur.valid_to is null or ur.valid_to > now()))
$$;

-- ---------------------------------------------------------------------------
-- 2. Manager-chain cycle guard (backstop for every write path)
-- ---------------------------------------------------------------------------
create or replace function core.guard_manager_cycle() returns trigger
language plpgsql set search_path = '' as $$
begin
  -- Serialise chain edits: two concurrent edits (A→B, B→A) would each see no cycle.
  perform pg_advisory_xact_lock(hashtextextended('core.employees.manager_chain', 0));
  if new.manager_id = new.id or exists (
       with recursive up(id) as (
         select new.manager_id
         union
         select e.manager_id from core.employees e join up on e.id = up.id where e.manager_id is not null)
       select 1 from up where up.id = new.id) then
    raise exception 'MANAGER_CYCLE: % cannot report to someone who reports to them', new.employee_no
      using errcode = 'P0001';
  end if;
  return new;
end $$;
-- UPDATE only: a new row has no reports, so an insert cannot close a loop (the table CHECK
-- already refuses manager_id = id), and inserts never take the lock.
create trigger trg_employees_manager_cycle before update of manager_id on core.employees
  for each row when (new.manager_id is not null and new.manager_id is distinct from old.manager_id)
  execute function core.guard_manager_cycle();

-- ---------------------------------------------------------------------------
-- 3. Last-owner guard on employment status (an owner whose employee record is suspended or
--    terminated has no grants: authz.is_active_user). Deferred like the ADR-007 guards.
-- ---------------------------------------------------------------------------
create or replace function core.guard_last_owner_employment() returns trigger
language plpgsql set search_path = '' as $$
begin
  if core.user_holds_owner_role(new.user_id) and not exists (
       select 1 from authz.user_roles ur
       join authz.roles r on r.id = ur.role_id and r.is_owner_role and r.is_active
       join core.user_profiles p on p.user_id = ur.user_id and p.status = 'active'
       left join core.employees e on e.id = p.employee_id
       where ur.revoked_at is null and ur.valid_from <= now() and (ur.valid_to is null or ur.valid_to > now())
         and (e.id is null or e.employment_status in ('active','on_leave'))) then
    raise exception 'LAST_OWNER: at least one active owner must remain' using errcode = 'P0001';
  end if;
  return null;
end $$;
create constraint trigger trg_employees_last_owner
  after update of employment_status on core.employees deferrable initially deferred
  for each row when (old.employment_status in ('active','on_leave') and new.employment_status not in ('active','on_leave'))
  execute function core.guard_last_owner_employment();

-- Territory assignments drive scope: keep their history.
create trigger trg_audit after insert or update or delete on core.employee_territories
  for each row execute function audit.log_change();

-- ---------------------------------------------------------------------------
-- 4. Commands
-- ---------------------------------------------------------------------------
-- Full replacement of the editable fields (employee_no is the identity and never changes).
-- p_expected_updated_at: the updated_at the editor loaded; a different stored value → CONFLICT.
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

-- Customers an employee currently holds (open assignments on non-archived customers).
-- Minimal columns so an admin without CRM access can plan a hand-over.
create or replace function core.employee_held_customers(p_employee_id uuid)
returns table (customer_id uuid, customer_no text, display_name text, role text, lifecycle_stage text,
               territory_code text, assigned_since timestamptz)
language sql stable set search_path = '' as $$
  select c.id, c.customer_no, c.display_name, a.role, c.lifecycle_stage, t.code, a.valid_from
  from crm.customer_assignments a
  join crm.customers c on c.id = a.customer_id and c.archived_at is null
  left join core.territories t on t.id = c.territory_id
  where a.employee_id = p_employee_id and a.valid_to is null
  order by c.customer_no, a.role
$$;

create or replace function api.employee_customer_holdings(p_employee_id uuid)
returns table (customer_id uuid, customer_no text, display_name text, role text, lifecycle_stage text,
               territory_code text, assigned_since timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform authz.require('core.employee.read');
  if not exists (select 1 from core.employees where id = p_employee_id) then
    raise exception 'NOT_FOUND: employee' using errcode = 'P0002';
  end if;
  if not core.employee_in_scope('core.employee.read', p_employee_id) then
    raise exception 'PERMISSION_DENIED: employee is outside your scope' using errcode = '42501';
  end if;
  return query select * from core.employee_held_customers(p_employee_id);
end $$;

-- Change employment status. Deactivation (suspended / terminated) reassigns nothing and
-- returns what the employee still holds.
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

-- Shared checks for the two territory-assignment commands.
create or replace function core.check_territory_assignment(p_employee_id uuid, p_territory_id uuid)
returns void language plpgsql stable set search_path = '' as $$
begin
  if not core.employee_in_scope('core.territory.manage', p_employee_id) then
    raise exception 'PERMISSION_DENIED: employee is outside your scope' using errcode = '42501';
  end if;
  if not (authz.has_global('core.territory.manage') or p_territory_id = any(authz.territory_ids('core.territory.manage'))) then
    raise exception 'PERMISSION_DENIED: territory is outside your scope' using errcode = '42501';
  end if;
  -- Territories widen the holder's territory scope: no self-service.
  if p_employee_id = authz.current_employee_id() and not authz.is_owner() then
    raise exception 'SELF_GRANT_FORBIDDEN: you cannot change your own territories' using errcode = '42501';
  end if;
end $$;

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
  if found then
    if v_row.assignment = p_assignment then
      return jsonb_build_object('employee_territory_id', v_row.id, 'created', false, 'changed', false);
    end if;
    update core.employee_territories set assignment = p_assignment where id = v_row.id;
  else
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

-- Close an open assignment. valid_to must be after valid_from, so a same-day removal ends
-- tomorrow; only "valid_to is null" counts as open anywhere, so the effect is immediate.
create or replace function api.end_employee_territory(p_employee_territory_id uuid, p_reason text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare v_row core.employee_territories%rowtype;
begin
  perform authz.require('core.territory.manage');
  select * into v_row from core.employee_territories where id = p_employee_territory_id and valid_to is null for update;
  if not found then raise exception 'NOT_FOUND: open territory assignment' using errcode = 'P0002'; end if;
  perform core.check_territory_assignment(v_row.employee_id, v_row.territory_id);
  update core.employee_territories set valid_to = greatest(core.business_date(), v_row.valid_from + 1)
  where id = v_row.id;
  perform authz.log_security_event('employee_territory_ended', 'warning',
    jsonb_build_object('employee', v_row.employee_id, 'territory', v_row.territory_id,
                       'reason', nullif(btrim(p_reason), '')));
  insert into integration.outbox (event_type, aggregate_type, aggregate_id, payload)
  values ('employee.territory_ended', 'core.employee', v_row.employee_id,
          jsonb_build_object('employee_id', v_row.employee_id, 'territory_id', v_row.territory_id, 'version', 1));
end $$;

-- ---------------------------------------------------------------------------
-- 5. RLS (reference tables had none, so clients saw no rows) and read views
-- ---------------------------------------------------------------------------
create policy departments_select on core.departments for select to authenticated
  using ((select authz.is_active_user()));
create policy offices_select on core.offices for select to authenticated
  using ((select authz.is_active_user()));
-- Inherits employee visibility (core.employees RLS); no policy cycle (employees_select uses
-- definer helpers only).
create policy employee_territories_select on core.employee_territories for select to authenticated
  using (exists (select 1 from core.employees e where e.id = employee_territories.employee_id));

create or replace view api.v_admin_employees with (security_invoker = true) as
  select e.id, e.employee_no, e.user_id, e.full_name_en, e.full_name_ar, e.job_title,
         e.phone::text as phone, e.email::text as email,
         e.department_id, d.code as department_code, d.name_en as department_name_en, d.name_ar as department_name_ar,
         e.office_id, o.code as office_code, o.name_en as office_name_en, o.name_ar as office_name_ar,
         e.manager_id, m.employee_no as manager_no, m.full_name_en as manager_name_en, m.full_name_ar as manager_name_ar,
         e.employment_status, e.hired_on, e.terminated_on, e.created_at, e.updated_at,
         (select count(*) from core.employees r where r.manager_id = e.id
           and r.employment_status in ('active','on_leave'))::int as direct_reports
  from core.employees e
  left join core.departments d on d.id = e.department_id
  left join core.offices o on o.id = e.office_id
  left join core.employees m on m.id = e.manager_id;

create or replace view api.v_employee_territories with (security_invoker = true) as
  select et.id, et.employee_id, et.territory_id, t.code as territory_code, t.name_en as territory_name_en,
         t.name_ar as territory_name_ar, t.is_active as territory_active, et.assignment, et.valid_from, et.valid_to
  from core.employee_territories et
  join core.territories t on t.id = et.territory_id;

create or replace view api.v_departments with (security_invoker = true) as
  select id, code, name_en, name_ar, parent_id, is_active from core.departments;

create or replace view api.v_offices with (security_invoker = true) as
  select id, code, name_en, name_ar, governorate_code, is_active from core.offices;

-- ---------------------------------------------------------------------------
-- 6. Privileges (explicit; never a blanket grant)
-- ---------------------------------------------------------------------------
revoke execute on function core.employee_in_scope(text, uuid) from public, anon, authenticated;
revoke execute on function core.user_holds_owner_role(uuid) from public, anon, authenticated;
revoke execute on function core.guard_manager_cycle() from public, anon, authenticated;
revoke execute on function core.guard_last_owner_employment() from public, anon, authenticated;
revoke execute on function core.check_territory_assignment(uuid, uuid) from public, anon, authenticated;
revoke execute on function core.employee_held_customers(uuid) from public, anon, authenticated;

do $$
declare f text;
begin
  foreach f in array array[
    'api.update_employee(uuid, text, text, text, text, text, uuid, uuid, uuid, date, timestamptz)',
    'api.employee_customer_holdings(uuid)',
    'api.set_employment_status(uuid, text, text, date)',
    'api.assign_employee_territory(uuid, uuid, text)',
    'api.end_employee_territory(uuid, text)']
  loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
grant select on api.v_admin_employees, api.v_employee_territories, api.v_departments, api.v_offices to authenticated;
