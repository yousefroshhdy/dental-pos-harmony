-- Honest OS migration: platform administration commands and read views (Phase 2)
-- Admin console v1: user context, users/employees, roles & permissions with the
-- anti-escalation ceiling, suspension, notifications, audit readers, owner bootstrap.

-- ---------------------------------------------------------------------------
-- Scope ordering helper (wider scope = higher rank) and grant-ceiling check
-- ---------------------------------------------------------------------------
create or replace function authz.scope_rank(p_scope text) returns int
language sql immutable set search_path = '' as $$
  select array_position(array['own','team','territory','department','warehouse','all'], p_scope)
$$;

-- True when the caller holds p_perm at >= p_scope and >= p_limit (NULL limit = unlimited).
create or replace function authz.can_grant(p_perm text, p_scope text, p_limit numeric) returns boolean
language sql stable security definer set search_path = '' as $$
  select authz.is_owner() or exists (
    select 1 from authz.grants(p_perm) g
    where authz.scope_rank(g.scope) >= authz.scope_rank(p_scope)
      and (g.limit_value is null or (p_limit is not null and g.limit_value >= p_limit)))
$$;

create or replace function authz.log_security_event(p_type text, p_severity text, p_details jsonb)
returns void language sql security definer set search_path = '' as $$
  insert into audit.security_events (user_id, event_type, severity, details)
  values (auth.uid(), p_type, p_severity, coalesce(p_details, '{}'))
$$;

-- ---------------------------------------------------------------------------
-- Current user context (drives UI gating; enforcement stays in RLS/commands)
-- ---------------------------------------------------------------------------
create or replace function api.my_context() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'user_id',   auth.uid(),
    'active',    authz.is_active_user(),
    'is_owner',  authz.is_owner(),
    'locale',    coalesce(p.locale, 'ar'),
    'status',    coalesce(p.status, 'unregistered'),
    'employee',  case when e.id is null then null else jsonb_build_object(
                   'id', e.id, 'employee_no', e.employee_no, 'full_name_en', e.full_name_en,
                   'full_name_ar', e.full_name_ar, 'job_title', e.job_title) end,
    'permissions', coalesce((
      select jsonb_object_agg(x.code, jsonb_build_object('scope', x.scope, 'limit', x.lim))
      from (
        select pm.code,
               (array_agg(g.scope order by authz.scope_rank(g.scope) desc))[1] as scope,
               case when bool_or(g.limit_value is null) then null else max(g.limit_value) end as lim
        from authz.permissions pm cross join lateral authz.grants(pm.code) g
        group by pm.code) x), '{}'::jsonb))
  from (select auth.uid() as uid) me
  left join core.user_profiles p on p.user_id = me.uid
  left join core.employees e on e.id = p.employee_id
$$;

-- ---------------------------------------------------------------------------
-- Employees & users
-- ---------------------------------------------------------------------------
create or replace function api.create_employee(
  p_employee_no text, p_full_name_en text, p_job_title text,
  p_full_name_ar text default null, p_phone text default null, p_email text default null,
  p_department_id uuid default null, p_office_id uuid default null, p_manager_id uuid default null,
  p_hired_on date default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform authz.require('core.employee.manage');
  if coalesce(trim(p_employee_no), '') = '' or coalesce(trim(p_full_name_en), '') = '' then
    raise exception 'VALIDATION: employee number and name are required' using errcode = 'P0001';
  end if;
  insert into core.employees (employee_no, full_name_en, full_name_ar, job_title, phone, email,
                              department_id, office_id, manager_id, hired_on)
  values (trim(p_employee_no), trim(p_full_name_en), nullif(trim(p_full_name_ar), ''), trim(p_job_title),
          nullif(p_phone, '')::core.phone_e164, nullif(p_email, ''), p_department_id, p_office_id, p_manager_id, p_hired_on)
  returning id into v_id;
  return v_id;
exception when unique_violation then
  raise exception 'DUPLICATE: employee number % already exists', p_employee_no using errcode = 'P0001';
end $$;

-- Links an Auth user (created by the server via the Auth admin API) to an employee.
create or replace function api.register_user(p_user_id uuid, p_employee_id uuid, p_locale text default 'ar')
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform authz.require('admin.user.create');
  if not exists (select 1 from auth.users where id = p_user_id) then
    raise exception 'NOT_FOUND: auth user' using errcode = 'P0002';
  end if;
  if exists (select 1 from core.employees where id = p_employee_id and user_id is not null and user_id <> p_user_id) then
    raise exception 'CONFLICT: employee already linked to another login' using errcode = 'P0001';
  end if;
  update core.employees set user_id = p_user_id where id = p_employee_id;
  if not found then raise exception 'NOT_FOUND: employee' using errcode = 'P0002'; end if;
  insert into core.user_profiles (user_id, employee_id, locale)
  values (p_user_id, p_employee_id, coalesce(p_locale, 'ar'))
  on conflict (user_id) do update set employee_id = excluded.employee_id;
  perform authz.log_security_event('user_registered', 'info',
    jsonb_build_object('target_user', p_user_id, 'employee', p_employee_id));
end $$;

create or replace function api.suspend_user(p_user_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_target_is_owner boolean;
begin
  perform authz.require('admin.user.suspend');
  if p_user_id = auth.uid() then
    raise exception 'SELF_SUSPEND_FORBIDDEN' using errcode = '42501';
  end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'REASON_REQUIRED' using errcode = 'P0001'; end if;
  select exists (select 1 from authz.user_roles ur join authz.roles r on r.id = ur.role_id
                 where ur.user_id = p_user_id and r.is_owner_role and ur.revoked_at is null)
    into v_target_is_owner;
  if v_target_is_owner and not authz.is_owner() then
    raise exception 'OWNER_ONLY: only an owner can suspend an owner' using errcode = '42501';
  end if;
  update core.user_profiles set status = 'suspended', suspended_at = now(), suspended_by = auth.uid()
  where user_id = p_user_id and status = 'active';
  if not found then raise exception 'INVALID_STATE: user is not active' using errcode = 'P0001'; end if;
  perform authz.log_security_event('user_suspended', 'warning',
    jsonb_build_object('target_user', p_user_id, 'reason', p_reason));
end $$;

create or replace function api.reactivate_user(p_user_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform authz.require('admin.user.suspend');
  update core.user_profiles set status = 'active', suspended_at = null, suspended_by = null
  where user_id = p_user_id and status = 'suspended';
  if not found then raise exception 'INVALID_STATE: user is not suspended' using errcode = 'P0001'; end if;
  perform authz.log_security_event('user_reactivated', 'warning',
    jsonb_build_object('target_user', p_user_id, 'reason', p_reason));
end $$;

-- ---------------------------------------------------------------------------
-- Roles & permissions (anti-escalation ceiling on every grant)
-- ---------------------------------------------------------------------------
create or replace function api.create_role(p_code text, p_name_en text, p_name_ar text default null,
                                           p_description text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  perform authz.require('admin.role.manage');
  if p_code !~ '^[a-z][a-z0-9_]{2,40}$' then
    raise exception 'VALIDATION: role code must be lowercase letters, digits, underscore' using errcode = 'P0001';
  end if;
  insert into authz.roles (code, name_en, name_ar, description, created_by)
  values (p_code, p_name_en, p_name_ar, p_description, auth.uid()) returning id into v_id;
  perform authz.log_security_event('role_created', 'info', jsonb_build_object('role', p_code));
  return v_id;
exception when unique_violation then
  raise exception 'DUPLICATE: role % already exists', p_code using errcode = 'P0001';
end $$;

create or replace function api.set_role_permission(p_role_id uuid, p_permission text, p_scope text,
                                                   p_limit numeric default null)
returns void language plpgsql security definer set search_path = '' as $$
declare v_perm authz.permissions%rowtype; v_role authz.roles%rowtype;
begin
  perform authz.require('admin.role.manage');
  select * into v_role from authz.roles where id = p_role_id;
  if not found then raise exception 'NOT_FOUND: role' using errcode = 'P0002'; end if;
  if v_role.is_owner_role then
    raise exception 'OWNER_ROLE_PROTECTED: the owner role always has every permission' using errcode = 'P0001';
  end if;
  select * into v_perm from authz.permissions where code = p_permission;
  if not found then raise exception 'NOT_FOUND: permission %', p_permission using errcode = 'P0002'; end if;
  if not (p_scope = any(v_perm.allowed_scopes)) then
    raise exception 'VALIDATION: scope % not allowed for %', p_scope, p_permission using errcode = 'P0001';
  end if;
  if p_limit is not null and not v_perm.supports_limit then
    raise exception 'VALIDATION: % does not take a limit', p_permission using errcode = 'P0001';
  end if;
  if not authz.can_grant(p_permission, p_scope, p_limit) then
    raise exception 'ESCALATION_BLOCKED: you do not hold % at that scope/limit', p_permission using errcode = '42501';
  end if;
  -- A user may not widen a role they hold themselves (would elevate their own access).
  if not authz.is_owner() and exists (select 1 from authz.user_roles ur where ur.role_id = p_role_id
                                      and ur.user_id = auth.uid() and ur.revoked_at is null) then
    raise exception 'SELF_GRANT_FORBIDDEN: you hold this role' using errcode = '42501';
  end if;
  insert into authz.role_permissions (role_id, permission_code, scope, limit_value)
  values (p_role_id, p_permission, p_scope, p_limit)
  on conflict (role_id, permission_code) do update set scope = excluded.scope, limit_value = excluded.limit_value;
  perform authz.log_security_event('role_permission_set', case when v_perm.is_sensitive then 'critical' else 'warning' end,
    jsonb_build_object('role', v_role.code, 'permission', p_permission, 'scope', p_scope, 'limit', p_limit));
end $$;

create or replace function api.remove_role_permission(p_role_id uuid, p_permission text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform authz.require('admin.role.manage');
  delete from authz.role_permissions where role_id = p_role_id and permission_code = p_permission;
  if not found then raise exception 'NOT_FOUND: role permission' using errcode = 'P0002'; end if;
  perform authz.log_security_event('role_permission_removed', 'warning',
    jsonb_build_object('role_id', p_role_id, 'permission', p_permission));
end $$;

create or replace function api.revoke_role(p_user_role_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_ur authz.user_roles%rowtype; v_owner_role boolean;
begin
  perform authz.require('admin.role.assign');
  select * into v_ur from authz.user_roles where id = p_user_role_id and revoked_at is null for update;
  if not found then raise exception 'NOT_FOUND: active role assignment' using errcode = 'P0002'; end if;
  select is_owner_role into v_owner_role from authz.roles where id = v_ur.role_id;
  if v_owner_role and not authz.is_owner() then
    raise exception 'OWNER_ONLY: only an owner can revoke the owner role' using errcode = '42501';
  end if;
  update authz.user_roles set revoked_at = now(), revoked_by = auth.uid(), reason = coalesce(p_reason, reason)
  where id = p_user_role_id;
  perform authz.log_security_event('role_revoked', case when v_owner_role then 'critical' else 'warning' end,
    jsonb_build_object('target_user', v_ur.user_id, 'role_id', v_ur.role_id, 'reason', p_reason));
end $$;

-- ---------------------------------------------------------------------------
-- Notifications (self-service)
-- ---------------------------------------------------------------------------
create or replace function api.mark_notifications_read(p_ids uuid[])
returns int language sql security definer set search_path = '' as $$
  with u as (
    update notify.notifications set read_at = now()
    where recipient_user_id = auth.uid() and read_at is null and id = any(p_ids)
    returning 1)
  select count(*)::int from u
$$;

-- ---------------------------------------------------------------------------
-- Owner bootstrap — run ONCE by the project owner from the Supabase SQL editor
-- (service context). Not callable by app users.
-- ---------------------------------------------------------------------------
create or replace function core.bootstrap_owner(p_email text, p_full_name text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_user uuid; v_emp uuid; v_owner_role uuid;
begin
  if authz.count_active_owners() > 0 then
    raise exception 'BOOTSTRAP_DONE: an active owner already exists' using errcode = 'P0001';
  end if;
  select id into v_user from auth.users where lower(email) = lower(p_email);
  if v_user is null then
    raise exception 'NOT_FOUND: create the auth user % first (Dashboard → Authentication → Add user)', p_email
      using errcode = 'P0002';
  end if;
  select id into v_owner_role from authz.roles where is_owner_role;
  insert into core.employees (employee_no, user_id, full_name_en, job_title)
  values ('OWNER-' || to_char(now(), 'YYYYMMDDHH24MISS'), v_user, p_full_name, 'Company Owner')
  on conflict (user_id) do update set full_name_en = excluded.full_name_en
  returning id into v_emp;
  insert into core.user_profiles (user_id, employee_id) values (v_user, v_emp)
  on conflict (user_id) do update set employee_id = excluded.employee_id, status = 'active';
  insert into authz.user_roles (user_id, role_id, reason) values (v_user, v_owner_role, 'bootstrap');
  insert into audit.security_events (user_id, event_type, severity, details)
  values (v_user, 'owner_bootstrap', 'critical', jsonb_build_object('email', p_email));
  return v_user;
end $$;
revoke all on function core.bootstrap_owner(text, text) from public;

-- ---------------------------------------------------------------------------
-- Read views (security_invoker → caller's RLS applies)
-- ---------------------------------------------------------------------------
create or replace view api.v_permissions with (security_invoker = true) as
  select code, module, description, allowed_scopes, supports_limit, is_sensitive from authz.permissions;

create or replace view api.v_roles with (security_invoker = true) as
  select r.id, r.code, r.name_en, r.name_ar, r.description, r.is_system, r.is_owner_role, r.is_active,
         (select count(*) from authz.role_permissions rp where rp.role_id = r.id) as permission_count
  from authz.roles r;

create or replace view api.v_role_permissions with (security_invoker = true) as
  select role_id, permission_code, scope, limit_value from authz.role_permissions;

create or replace view api.v_users with (security_invoker = true) as
  select p.user_id, p.status, p.locale, p.suspended_at, p.created_at,
         e.id as employee_id, e.employee_no, e.full_name_en, e.full_name_ar, e.job_title, e.employment_status,
         e.email::text as email
  from core.user_profiles p
  left join core.employees e on e.id = p.employee_id;
-- Note: never expose auth.users to `authenticated` — Supabase applies no RLS there,
-- so any grant would leak every user's email. Work email lives on core.employees.

create or replace view api.v_user_roles with (security_invoker = true) as
  select ur.id, ur.user_id, ur.role_id, r.code as role_code, r.name_en as role_name_en,
         ur.scope_territory_id, ur.scope_warehouse_id, ur.valid_from, ur.valid_to, ur.granted_at, ur.revoked_at
  from authz.user_roles ur join authz.roles r on r.id = ur.role_id;

create or replace view api.v_employees with (security_invoker = true) as
  select id, employee_no, user_id, full_name_en, full_name_ar, job_title, department_id, office_id,
         manager_id, employment_status, hired_on
  from core.employees;

create or replace view api.v_territories with (security_invoker = true) as
  select id, code, name_en, name_ar, parent_id, level, is_active from core.territories;

create or replace view api.v_notifications with (security_invoker = true) as
  select id, type, title, body, link, data, read_at, created_at
  from notify.notifications where recipient_user_id = auth.uid();

create or replace view api.v_security_events with (security_invoker = true) as
  select id, occurred_at, user_id, event_type, severity, details from audit.security_events;

create or replace view api.v_audit_log with (security_invoker = true) as
  select id, occurred_at, actor_user_id, action, table_schema, table_name, record_id, changed_fields, request_id
  from audit.audit_log;

-- Audit readers (RLS on audit tables; no write grants anywhere)
grant usage on schema audit to authenticated;
grant select on audit.audit_log, audit.security_events to authenticated;
create policy audit_log_select on audit.audit_log for select to authenticated
  using ((select authz.has_permission('audit.log.read')));
create policy security_events_select on audit.security_events for select to authenticated
  using ((select authz.has_permission('audit.security.read')));

grant usage on schema api to authenticated;
grant select on all tables in schema api to authenticated;
revoke execute on all functions in schema api from public;
grant execute on all functions in schema api to authenticated;
