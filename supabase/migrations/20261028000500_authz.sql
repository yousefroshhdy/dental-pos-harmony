-- Honest OS migration: authorization engine
-- Origin: docs/database/draft/10_schema_draft.sql (Phase 1, validated). See docs/DATABASE.md.

-- ---------------------------------------------------------------------------
-- AUTHZ: dynamic RBAC + ABAC (see docs/AUTHORIZATION.md)
-- ---------------------------------------------------------------------------
create table authz.permissions (
  code           text primary key,              -- '<module>.<resource>.<action>' e.g. 'sales.order.approve'
  module         text not null,
  description    text not null,
  allowed_scopes text[] not null default '{own,team,territory,department,warehouse,all}',
  supports_limit boolean not null default false, -- e.g. max discount %, max approval amount
  is_sensitive   boolean not null default false, -- granting it raises a security event
  check (code ~ '^[a-z_]+\.[a-z_]+\.[a-z_]+$')
);

create table authz.roles (
  id            uuid primary key default gen_random_uuid(),
  code          text not null unique,
  name_en       text not null,
  name_ar       text,
  description   text,
  is_system     boolean not null default false,  -- seeded, cannot be deleted
  is_owner_role boolean not null default false,  -- implicit ALL permissions (ADR-007)
  is_active     boolean not null default true,
  created_by    uuid references auth.users(id),
  created_at    timestamptz not null default now()
);
create unique index uq_single_owner_role on authz.roles ((true)) where is_owner_role;

create table authz.role_permissions (
  role_id         uuid not null references authz.roles(id) on delete cascade,
  permission_code text not null references authz.permissions(code),
  scope           text not null check (scope in ('own','team','territory','department','warehouse','all')),
  limit_value     numeric(14,2),                 -- meaning defined per permission (pct or EGP)
  primary key (role_id, permission_code)
);

create table authz.user_roles (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references auth.users(id),
  role_id             uuid not null references authz.roles(id),
  -- Optional ABAC bindings. Null = derive from the employee's own assignments.
  scope_territory_id  uuid references core.territories(id),
  scope_warehouse_id  uuid references inventory.warehouses(id),
  scope_department_id uuid references core.departments(id),
  valid_from          timestamptz not null default now(),
  valid_to            timestamptz,
  granted_by          uuid references auth.users(id),
  granted_at          timestamptz not null default now(),
  revoked_at          timestamptz,
  revoked_by          uuid references auth.users(id),
  reason              text
);
create index on authz.user_roles (user_id) where revoked_at is null;

-- Per-user exceptions. DENY always beats GRANT.
create table authz.user_permission_overrides (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users(id),
  permission_code    text not null references authz.permissions(code),
  effect             text not null check (effect in ('grant','deny')),
  scope              text check (scope in ('own','team','territory','department','warehouse','all')),
  scope_territory_id uuid references core.territories(id),
  limit_value        numeric(14,2),
  reason             text not null,
  expires_at         timestamptz,
  granted_by         uuid references auth.users(id),
  created_at         timestamptz not null default now(),
  check (effect = 'deny' or scope is not null)
);
create index on authz.user_permission_overrides (user_id, permission_code);

-- ---- authorization functions (SECURITY DEFINER, read-only, STABLE) ----
create or replace function authz.current_employee_id() returns uuid
language sql stable security definer set search_path = '' as $$
  select employee_id from core.user_profiles where user_id = auth.uid()
$$;

create or replace function authz.is_active_user() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from core.user_profiles p
    left join core.employees e on e.id = p.employee_id
    where p.user_id = auth.uid() and p.status = 'active'
      and (e.id is null or e.employment_status in ('active','on_leave')))
$$;

create or replace function authz.is_owner() returns boolean
language sql stable security definer set search_path = '' as $$
  select authz.is_active_user() and exists (
    select 1 from authz.user_roles ur join authz.roles r on r.id = ur.role_id
    where ur.user_id = auth.uid() and r.is_owner_role and r.is_active
      and ur.revoked_at is null and ur.valid_from <= now()
      and (ur.valid_to is null or ur.valid_to > now()))
$$;

-- Every grant the current user holds for one permission (roles ∪ grant overrides),
-- minus denies. This is the single source the other helpers read.
create or replace function authz.grants(p_perm text)
returns table (scope text, territory_id uuid, warehouse_id uuid, department_id uuid, limit_value numeric)
language sql stable security definer set search_path = '' as $$
  with denied as (
    select 1 from authz.user_permission_overrides o
    where o.user_id = auth.uid() and o.permission_code = p_perm and o.effect = 'deny'
      and (o.expires_at is null or o.expires_at > now())
  )
  select 'all'::text, null::uuid, null::uuid, null::uuid, null::numeric
  where authz.is_owner()
  union all
  select rp.scope, ur.scope_territory_id, ur.scope_warehouse_id, ur.scope_department_id, rp.limit_value
  from authz.user_roles ur
  join authz.roles r            on r.id = ur.role_id and r.is_active
  join authz.role_permissions rp on rp.role_id = ur.role_id and rp.permission_code = p_perm
  where ur.user_id = auth.uid() and ur.revoked_at is null and ur.valid_from <= now()
    and (ur.valid_to is null or ur.valid_to > now())
    and authz.is_active_user() and not exists (select 1 from denied)
  union all
  select o.scope, o.scope_territory_id, null, null, o.limit_value
  from authz.user_permission_overrides o
  where o.user_id = auth.uid() and o.permission_code = p_perm and o.effect = 'grant'
    and (o.expires_at is null or o.expires_at > now())
    and authz.is_active_user() and not exists (select 1 from denied)
$$;

create or replace function authz.has_permission(p_perm text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from authz.grants(p_perm))
$$;

create or replace function authz.has_global(p_perm text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from authz.grants(p_perm) g where g.scope = 'all')
$$;

-- Highest limit across grants; NULL limit on any grant = unlimited.
create or replace function authz.max_limit(p_perm text) returns numeric
language sql stable security definer set search_path = '' as $$
  select case when bool_or(g.limit_value is null) then null else max(g.limit_value) end
  from authz.grants(p_perm) g
$$;

-- Territories (incl. descendants) visible under 'territory' scope.
create or replace function authz.territory_ids(p_perm text) returns uuid[]
language sql stable security definer set search_path = '' as $$
  with recursive roots as (
    select g.territory_id as id from authz.grants(p_perm) g
     where g.scope = 'territory' and g.territory_id is not null
    union
    select et.territory_id from authz.grants(p_perm) g
      join core.employee_territories et
        on et.employee_id = authz.current_employee_id() and et.valid_to is null
     where g.scope = 'territory' and g.territory_id is null
  ), tree as (
    select id from roots
    union
    select t.id from core.territories t join tree on t.parent_id = tree.id
  )
  select coalesce(array_agg(id), '{}') from tree
$$;

-- Employees whose records are visible under 'own' / 'team' scope.
create or replace function authz.employee_ids(p_perm text) returns uuid[]
language sql stable security definer set search_path = '' as $$
  with recursive me as (select authz.current_employee_id() as id),
  team as (
    select e.id from core.employees e, me
     where e.manager_id = me.id
       and exists (select 1 from authz.grants(p_perm) g where g.scope = 'team')
    union
    select e.id from core.employees e join team on e.manager_id = team.id
  )
  select coalesce(array_agg(x.id), '{}') from (
    select me.id from me where me.id is not null
       and exists (select 1 from authz.grants(p_perm) g where g.scope in ('own','team'))
    union select id from team
  ) x
$$;

create or replace function authz.warehouse_ids(p_perm text) returns uuid[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(distinct g.warehouse_id), '{}')
  from authz.grants(p_perm) g where g.scope = 'warehouse' and g.warehouse_id is not null
$$;

-- Raise a structured, auditable denial.
create or replace function authz.require(p_perm text) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if not authz.has_permission(p_perm) then
    raise exception 'PERMISSION_DENIED: %', p_perm using errcode = '42501';
  end if;
end $$;

-- ---- owner lock-out safeguard (ADR-007) ----
create or replace function authz.count_active_owners() returns int
language sql stable security definer set search_path = '' as $$
  select count(distinct ur.user_id)::int
  from authz.user_roles ur
  join authz.roles r on r.id = ur.role_id and r.is_owner_role and r.is_active
  join core.user_profiles p on p.user_id = ur.user_id and p.status = 'active'
  where ur.revoked_at is null and (ur.valid_to is null or ur.valid_to > now())
$$;

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
  if v_affects_owner and authz.count_active_owners() = 0 then
    raise exception 'LAST_OWNER: at least one active owner must remain' using errcode = 'P0001';
  end if;
  return null;
end $$;
create constraint trigger trg_user_roles_last_owner
  after update or delete on authz.user_roles deferrable initially deferred
  for each row execute function authz.guard_last_owner();
create constraint trigger trg_profiles_last_owner
  after update of status on core.user_profiles deferrable initially deferred
  for each row when (old.status = 'active' and new.status <> 'active')
  execute function authz.guard_last_owner();

create or replace function authz.protect_owner_role() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' and old.is_owner_role then
    raise exception 'OWNER_ROLE_PROTECTED' using errcode = 'P0001';
  end if;
  if tg_op = 'UPDATE' and old.is_owner_role
     and (new.is_owner_role is distinct from true or new.is_active is distinct from true) then
    raise exception 'OWNER_ROLE_PROTECTED' using errcode = 'P0001';
  end if;
  return coalesce(new, old);
end $$;
create trigger trg_roles_protect_owner before update or delete on authz.roles
  for each row execute function authz.protect_owner_role();
