-- =============================================================================
-- HONEST OS — DRAFT SCHEMA (Phase 1 architecture artefact, NOT a migration)
--
-- Status: PLANNED. Validated only for syntax and core invariants against a
-- local PostgreSQL 16 server (see 90_smoke_test.sql). It becomes real
-- migrations in Phase 2 after the architecture review is approved.
--
-- Conventions (see docs/DATABASE.md):
--   * Tables live in private domain schemas; PostgREST exposes only `api`.
--   * uuid primary keys (client-generated allowed → offline idempotency).
--   * Money: numeric(14,2) EGP. Quantities: integer base units.
--   * Status columns: text + CHECK (cheaper to evolve than enums).
--   * Ledgers (inventory.movements, finance.customer_ledger, audit.*) are
--     append-only; corrections are reversing entries.
--   * Every function is `set search_path = ''` and fully qualifies names.
-- =============================================================================

create extension if not exists pg_trgm;
create extension if not exists citext;

create schema if not exists core;
create schema if not exists authz;
create schema if not exists catalog;
create schema if not exists inventory;
create schema if not exists crm;
create schema if not exists field;
create schema if not exists work;
create schema if not exists sales;
create schema if not exists finance;
create schema if not exists perf;
create schema if not exists wf;
create schema if not exists audit;
create schema if not exists notify;
create schema if not exists integration;
create schema if not exists api;

-- ---------------------------------------------------------------------------
-- Shared helpers
-- ---------------------------------------------------------------------------
create or replace function core.set_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

create or replace function core.forbid_mutation() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'APPEND_ONLY: % on %.% is not allowed; post a reversing entry instead',
    tg_op, tg_table_schema, tg_table_name using errcode = 'P0001';
end $$;

-- Great-circle distance in metres (haversine). Accurate to well under 1 m at
-- geofence scale; avoids a PostGIS dependency for the MVP (ADR-011).
create or replace function core.distance_m(lat1 numeric, lng1 numeric, lat2 numeric, lng2 numeric)
returns numeric language sql immutable parallel safe set search_path = '' as $$
  select (2 * 6371008.8 * asin(sqrt(
            power(sin(radians((lat2 - lat1)::float8) / 2), 2) +
            cos(radians(lat1::float8)) * cos(radians(lat2::float8)) *
            power(sin(radians((lng2 - lng1)::float8) / 2), 2))))::numeric(12,1)
$$;

-- Egyptian numbers stored as E.164. Mobile: +20 1[0125] + 8 digits.
-- Landline: +20 + area code + number (8–9 national digits after +20).
create domain core.phone_e164 as text
  check (value ~ '^\+20(1[0125][0-9]{8}|[2-9][0-9]{7,8})$');

create domain core.money as numeric(14,2);

-- ---------------------------------------------------------------------------
-- CORE: organisation
-- ---------------------------------------------------------------------------
create table core.governorates (
  code     text primary key,                 -- e.g. 'CAI', 'GIZ', 'DK' (Dakahlia)
  name_en  text not null,
  name_ar  text not null
);

create table core.departments (
  id        uuid primary key default gen_random_uuid(),
  code      text not null unique,
  name_en   text not null,
  name_ar   text not null,
  parent_id uuid references core.departments(id),
  is_active boolean not null default true
);

create table core.offices (
  id               uuid primary key default gen_random_uuid(),
  code             text not null unique,
  name_en          text not null,
  name_ar          text not null,
  governorate_code text references core.governorates(code),
  address          text,
  is_active        boolean not null default true
);

-- Hierarchical territories: region → area → sub-area. Created dynamically.
create table core.territories (
  id         uuid primary key default gen_random_uuid(),
  code       text not null unique,
  name_en    text not null,
  name_ar    text not null,
  parent_id  uuid references core.territories(id),
  level      text not null default 'area' check (level in ('region','area','sub_area')),
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  check (parent_id is distinct from id)
);

-- Which governorates/cities a territory covers (drives auto-assignment of new customers).
create table core.territory_coverage (
  territory_id     uuid not null references core.territories(id) on delete cascade,
  governorate_code text not null references core.governorates(code),
  city             text not null default '*',
  primary key (governorate_code, city)
);

create table core.employees (
  id                uuid primary key default gen_random_uuid(),
  employee_no       text not null unique,
  user_id           uuid unique references auth.users(id),   -- null until given a login
  full_name_en      text not null,
  full_name_ar      text,
  phone             core.phone_e164,
  email             citext,
  department_id     uuid references core.departments(id),
  office_id         uuid references core.offices(id),
  manager_id        uuid references core.employees(id),
  job_title         text not null,        -- organisational role; grants NOTHING by itself
  employment_status text not null default 'active'
                    check (employment_status in ('active','on_leave','suspended','terminated')),
  hired_on          date,
  terminated_on     date,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  check (manager_id is distinct from id),
  check (terminated_on is null or hired_on is null or terminated_on >= hired_on)
);
create index on core.employees (manager_id);
create trigger trg_employees_updated before update on core.employees
  for each row execute function core.set_updated_at();

create table core.employee_territories (
  id           uuid primary key default gen_random_uuid(),
  employee_id  uuid not null references core.employees(id),
  territory_id uuid not null references core.territories(id),
  assignment   text not null default 'member' check (assignment in ('member','manager')),
  valid_from   date not null default current_date,
  valid_to     date,
  check (valid_to is null or valid_to > valid_from)
);
create unique index uq_employee_territory_open
  on core.employee_territories (employee_id, territory_id) where valid_to is null;

-- App-level user state (auth.users is owned by Supabase Auth).
create table core.user_profiles (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  employee_id  uuid unique references core.employees(id),
  locale       text not null default 'ar' check (locale in ('ar','en')),
  status       text not null default 'active' check (status in ('active','suspended','disabled')),
  suspended_at timestamptz,
  suspended_by uuid references auth.users(id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create table core.system_settings (
  key         text primary key,           -- e.g. 'field.geofence_radius_m'
  value       jsonb not null,
  description text,
  is_secret   boolean not null default false check (is_secret = false), -- secrets never live here
  updated_by  uuid references auth.users(id),
  updated_at  timestamptz not null default now()
);

-- Gapless per-year document numbering (invoices legally benefit from gapless series).
create table core.document_sequences (
  doc_type   text not null,               -- 'SO','INV','CN','PAY','TRF','RET'
  year       int  not null,
  last_value bigint not null default 0,
  primary key (doc_type, year)
);

create or replace function core.next_document_no(p_doc_type text, p_on date default current_date)
returns text language plpgsql set search_path = '' as $$
declare v_year int := extract(year from p_on)::int; v_next bigint;
begin
  insert into core.document_sequences(doc_type, year, last_value) values (p_doc_type, v_year, 1)
  on conflict (doc_type, year) do update set last_value = core.document_sequences.last_value + 1
  returning last_value into v_next;           -- row lock held until commit → gapless
  return p_doc_type || '-' || v_year || '-' || lpad(v_next::text, 6, '0');
end $$;

-- ---------------------------------------------------------------------------
-- CATALOG
-- ---------------------------------------------------------------------------
create table catalog.brands (
  id                uuid primary key default gen_random_uuid(),
  code              text not null unique,      -- 'BIONER','DERBY','RDT'
  name              text not null,
  country_of_origin text,
  is_active         boolean not null default true
);

create table catalog.categories (
  id        uuid primary key default gen_random_uuid(),
  code      text not null unique,              -- 'IMPLANT','BUR','INSTRUMENT','GRAFT','MEMBRANE','SUTURE','ENDO'
  name_en   text not null,
  name_ar   text not null,
  parent_id uuid references catalog.categories(id)
);

create table catalog.products (
  id                uuid primary key default gen_random_uuid(),
  brand_id          uuid not null references catalog.brands(id),
  category_id       uuid not null references catalog.categories(id),
  code              text not null unique,
  name_en           text not null,
  name_ar           text,
  description       text,
  is_lot_tracked    boolean not null default true,
  is_expiry_tracked boolean not null default false,
  is_serial_tracked boolean not null default false,
  tax_rate_pct      numeric(5,2) not null default 14.00,   -- OPEN-Q: confirm VAT treatment per category
  status            text not null default 'active' check (status in ('draft','active','discontinued')),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create table catalog.product_variants (
  id            uuid primary key default gen_random_uuid(),
  product_id    uuid not null references catalog.products(id),
  sku           text not null unique,
  name_en       text not null,
  attributes    jsonb not null default '{}',   -- e.g. {"diameter_mm":4.1,"length_mm":10}
  barcode       text unique,
  uom           text not null default 'unit',
  reorder_point int  not null default 0 check (reorder_point >= 0),
  status        text not null default 'active' check (status in ('active','discontinued')),
  created_at    timestamptz not null default now()
);
create index on catalog.product_variants (product_id);

-- Field-level security by table split: purchase cost lives apart from the
-- variant and carries its own RLS (only catalog.cost.read).
create table catalog.product_costs (
  id             uuid primary key default gen_random_uuid(),
  variant_id     uuid not null references catalog.product_variants(id),
  unit_cost      core.money not null check (unit_cost >= 0),
  currency       char(3) not null default 'EGP',
  fx_rate_to_egp numeric(14,6),
  effective_from date not null,
  created_by     uuid references auth.users(id),
  unique (variant_id, effective_from)
);

create table catalog.price_lists (
  id         uuid primary key default gen_random_uuid(),
  code       text not null unique,
  name       text not null,
  kind       text not null default 'standard' check (kind in ('standard','customer','promotional')),
  currency   char(3) not null default 'EGP',
  priority   int not null default 100,          -- lower wins when several apply
  valid_from date not null default current_date,
  valid_to   date,
  is_active  boolean not null default true,
  check (valid_to is null or valid_to >= valid_from)
);
-- Exactly one active default standard list.
create unique index uq_one_default_price_list on catalog.price_lists ((true))
  where kind = 'standard' and is_active and code = 'DEFAULT';

create table catalog.price_list_items (
  price_list_id uuid not null references catalog.price_lists(id) on delete cascade,
  variant_id    uuid not null references catalog.product_variants(id),
  unit_price    core.money not null check (unit_price >= 0),
  min_qty       int not null default 1 check (min_qty >= 1),
  primary key (price_list_id, variant_id, min_qty)
);

-- ---------------------------------------------------------------------------
-- INVENTORY (warehouses created before authz because grants can be warehouse-scoped)
-- ---------------------------------------------------------------------------
create table inventory.warehouses (
  id             uuid primary key default gen_random_uuid(),
  code           text not null unique,
  name           text not null,
  office_id      uuid references core.offices(id),
  kind           text not null default 'main' check (kind in ('main','branch','rep_stock','quarantine','transit')),
  allow_negative boolean not null default false,   -- policy switch; default deny
  is_active      boolean not null default true
);

create table inventory.lots (
  id              uuid primary key default gen_random_uuid(),
  variant_id      uuid not null references catalog.product_variants(id),
  lot_no          text not null,                 -- 'NO-LOT' for non-tracked items (ADR-013)
  expiry_date     date,
  manufactured_on date,
  created_at      timestamptz not null default now(),
  unique (variant_id, lot_no)
);
create index on inventory.lots (expiry_date) where expiry_date is not null;

create table inventory.serials (
  id         uuid primary key default gen_random_uuid(),
  variant_id uuid not null references catalog.product_variants(id),
  lot_id     uuid references inventory.lots(id),
  serial_no  text not null,
  status     text not null default 'in_stock' check (status in ('in_stock','reserved','sold','returned','scrapped')),
  unique (variant_id, serial_no)
);

-- THE inventory ledger. Append-only. Balances are derived from it.
create table inventory.movements (
  id                   uuid primary key default gen_random_uuid(),
  movement_type        text not null check (movement_type in (
                         'receipt','sale_issue','sale_return','transfer_out','transfer_in',
                         'adjustment_in','adjustment_out','damage','expiry_writeoff','reversal')),
  warehouse_id         uuid not null references inventory.warehouses(id),
  variant_id           uuid not null references catalog.product_variants(id),
  lot_id               uuid not null references inventory.lots(id),
  quantity             int  not null check (quantity <> 0),   -- signed: + in, − out
  unit_cost            core.money,                           -- for valuation; never shown to reps
  reason_code          text,
  source_doc_type      text,                                 -- 'fulfillment','transfer','adjustment','receipt','return'
  source_doc_id        uuid,
  reverses_movement_id uuid unique references inventory.movements(id),
  approval_request_id  uuid,                                 -- FK added after wf schema
  idempotency_key      text unique,
  created_by           uuid references auth.users(id),
  created_at           timestamptz not null default now(),
  check ((movement_type = 'reversal') = (reverses_movement_id is not null)),
  check (movement_type not in ('receipt','sale_return','transfer_in','adjustment_in') or quantity > 0 or movement_type = 'reversal'),
  check (movement_type not in ('sale_issue','transfer_out','adjustment_out','damage','expiry_writeoff') or quantity < 0)
);
create index on inventory.movements (variant_id, warehouse_id, created_at);
create index on inventory.movements (source_doc_type, source_doc_id);
create trigger trg_movements_append_only before update or delete on inventory.movements
  for each row execute function core.forbid_mutation();

-- Derived, trigger-maintained balance. Nobody writes to it directly.
create table inventory.stock_balances (
  warehouse_id uuid not null references inventory.warehouses(id),
  variant_id   uuid not null references catalog.product_variants(id),
  lot_id       uuid not null references inventory.lots(id),
  on_hand      int  not null default 0,
  reserved     int  not null default 0 check (reserved >= 0),
  updated_at   timestamptz not null default now(),
  primary key (warehouse_id, variant_id, lot_id),
  check (reserved <= greatest(on_hand, 0))
);

create or replace function inventory.apply_movement() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_on_hand int; v_allow_negative boolean;
begin
  insert into inventory.stock_balances (warehouse_id, variant_id, lot_id, on_hand)
  values (new.warehouse_id, new.variant_id, new.lot_id, new.quantity)
  on conflict (warehouse_id, variant_id, lot_id)
  do update set on_hand = inventory.stock_balances.on_hand + excluded.on_hand, updated_at = now()
  returning on_hand into v_on_hand;

  select allow_negative into v_allow_negative from inventory.warehouses where id = new.warehouse_id;
  if v_on_hand < 0 and not v_allow_negative then
    raise exception 'INSUFFICIENT_STOCK: warehouse % variant % lot % would go to %',
      new.warehouse_id, new.variant_id, new.lot_id, v_on_hand using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger trg_movements_apply after insert on inventory.movements
  for each row execute function inventory.apply_movement();

create view inventory.v_stock as
  select b.warehouse_id, b.variant_id, b.lot_id, l.lot_no, l.expiry_date,
         b.on_hand, b.reserved, (b.on_hand - b.reserved) as available
  from inventory.stock_balances b join inventory.lots l on l.id = b.lot_id;

create table inventory.transfers (
  id                uuid primary key default gen_random_uuid(),
  transfer_no       text not null unique,
  from_warehouse_id uuid not null references inventory.warehouses(id),
  to_warehouse_id   uuid not null references inventory.warehouses(id),
  status            text not null default 'draft'
                    check (status in ('draft','pending_approval','approved','in_transit','received','cancelled')),
  requested_by      uuid references auth.users(id),
  created_at        timestamptz not null default now(),
  check (from_warehouse_id <> to_warehouse_id)
);
create table inventory.transfer_items (
  id          uuid primary key default gen_random_uuid(),
  transfer_id uuid not null references inventory.transfers(id) on delete cascade,
  variant_id  uuid not null references catalog.product_variants(id),
  lot_id      uuid not null references inventory.lots(id),
  quantity    int not null check (quantity > 0),
  received_qty int not null default 0 check (received_qty >= 0 and received_qty <= quantity)
);

create table inventory.goods_receipts (
  id           uuid primary key default gen_random_uuid(),
  receipt_no   text not null unique,
  warehouse_id uuid not null references inventory.warehouses(id),
  supplier     text not null,                   -- OPEN-Q: suppliers/purchasing module scope
  shipment_ref text,
  received_at  timestamptz not null default now(),
  status       text not null default 'draft' check (status in ('draft','posted','cancelled')),
  posted_by    uuid references auth.users(id)
);
create table inventory.goods_receipt_items (
  id         uuid primary key default gen_random_uuid(),
  receipt_id uuid not null references inventory.goods_receipts(id) on delete cascade,
  variant_id uuid not null references catalog.product_variants(id),
  lot_no     text not null,
  expiry_date date,
  quantity   int not null check (quantity > 0),
  unit_cost  core.money not null check (unit_cost >= 0)
);

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
begin
  -- Only check when an owner assignment existed before the change.
  if authz.count_active_owners() = 0 then
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

-- ---------------------------------------------------------------------------
-- CRM
-- ---------------------------------------------------------------------------
create table crm.specialties (
  code    text primary key,                  -- 'IMPLANTOLOGY','ENDO','PROSTHO','ORTHO','GP','OMFS','PERIO'
  name_en text not null,
  name_ar text not null
);

-- Leads, prospects and customers are ONE entity with a lifecycle stage (ADR-012).
create table crm.customers (
  id                 uuid primary key default gen_random_uuid(),
  customer_no        text not null unique,
  kind               text not null default 'clinic'
                     check (kind in ('clinic','doctor','hospital','university','lab','distributor')),
  doctor_name        text,
  clinic_name        text,
  display_name       text not null,
  specialty_code     text references crm.specialties(code),
  lifecycle_stage    text not null default 'lead'
                     check (lifecycle_stage in ('lead','prospect','active','dormant','lost','blocked')),
  source             text check (source in ('field','referral','website','shopify','event','academy','import','other')),
  phone_primary      core.phone_e164,
  phone_secondary    core.phone_e164,
  email              citext,
  address_line       text,
  city               text,
  governorate_code   text references core.governorates(code),
  territory_id       uuid references core.territories(id),
  latitude           numeric(9,6) check (latitude between 21.5 and 32.0),   -- Egypt bounding box
  longitude          numeric(9,6) check (longitude between 24.5 and 37.5),
  location_verified  boolean not null default false,
  credit_limit       core.money check (credit_limit >= 0),
  payment_terms_days int not null default 0 check (payment_terms_days between 0 and 365),
  tax_registration_no text,
  commercial_reg_no  text,
  tags               text[] not null default '{}',
  notes              text,
  version            int not null default 1,          -- optimistic concurrency (offline edits)
  created_by         uuid references auth.users(id),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  archived_at        timestamptz,
  check (doctor_name is not null or clinic_name is not null),
  check ((latitude is null) = (longitude is null))
);
create index on crm.customers (territory_id);
create index on crm.customers (lifecycle_stage);
create index idx_customers_name_trgm on crm.customers using gin (display_name gin_trgm_ops);
-- Hard duplicate rule: same primary phone among non-archived customers. Soft rule
-- (name similarity) is surfaced by api.find_duplicate_customers().
create unique index uq_customers_phone_active on crm.customers (phone_primary)
  where archived_at is null and phone_primary is not null;
create trigger trg_customers_updated before update on crm.customers
  for each row execute function core.set_updated_at();

-- Customer-specific price lists are linked explicitly.
create table catalog.customer_price_lists (
  customer_id   uuid not null references crm.customers(id),
  price_list_id uuid not null references catalog.price_lists(id),
  valid_from    date not null default current_date,
  valid_to      date,
  primary key (customer_id, price_list_id, valid_from)
);
create table crm.customer_contacts (
  id          uuid primary key default gen_random_uuid(),
  customer_id uuid not null references crm.customers(id) on delete cascade,
  name        text not null,
  role        text,                             -- 'doctor','assistant','purchasing','accountant'
  phone       core.phone_e164,
  email       citext,
  is_primary  boolean not null default false,
  whatsapp_opt_in_at timestamptz                -- consent record for WhatsApp messaging
);

create table crm.customer_assignments (
  id          uuid primary key default gen_random_uuid(),
  customer_id uuid not null references crm.customers(id),
  employee_id uuid not null references core.employees(id),
  role        text not null default 'primary_rep' check (role in ('primary_rep','secondary_rep','collector','key_account')),
  valid_from  timestamptz not null default now(),
  valid_to    timestamptz,
  assigned_by uuid references auth.users(id),
  reason      text,
  check (valid_to is null or valid_to > valid_from)
);
create unique index uq_one_primary_rep on crm.customer_assignments (customer_id)
  where role = 'primary_rep' and valid_to is null;
create index on crm.customer_assignments (employee_id) where valid_to is null;

create table crm.opportunities (
  id                  uuid primary key default gen_random_uuid(),
  customer_id         uuid not null references crm.customers(id),
  owner_employee_id   uuid not null references core.employees(id),
  title               text not null,
  brand_id            uuid references catalog.brands(id),
  stage               text not null default 'new'
                      check (stage in ('new','qualified','proposal','negotiation','won','lost')),
  expected_value      core.money check (expected_value >= 0),
  probability_pct     int check (probability_pct between 0 and 100),
  expected_close_date date,
  lost_reason         text,
  won_order_id        uuid,                          -- FK added after sales schema
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  closed_at           timestamptz,
  check (stage <> 'lost' or lost_reason is not null)
);

-- Unified customer timeline (calls, WhatsApp, visits, orders, payments...).
create table crm.activities (
  id          uuid primary key default gen_random_uuid(),
  customer_id uuid not null references crm.customers(id),
  employee_id uuid references core.employees(id),
  type        text not null check (type in ('call','whatsapp','email','visit','meeting','note',
                                            'order','invoice','payment','stage_change','assignment')),
  occurred_at timestamptz not null default now(),
  summary     text not null,
  ref_table   text,
  ref_id      uuid,
  created_at  timestamptz not null default now()
);
create index on crm.activities (customer_id, occurred_at desc);

-- Customers assigned (open assignment) to employees visible under own/team scope.
-- SECURITY DEFINER so RLS policies can use it without policy-to-policy recursion.
create or replace function authz.assigned_customer_ids(p_perm text) returns uuid[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(distinct a.customer_id), '{}')
  from crm.customer_assignments a
  where a.valid_to is null and a.employee_id = any(authz.employee_ids(p_perm))
$$;

-- ---------------------------------------------------------------------------
-- WORK: tasks & follow-ups (shared by CRM, collections, QMS...)
-- ---------------------------------------------------------------------------
create table work.tasks (
  id                   uuid primary key default gen_random_uuid(),
  title                text not null,
  description          text,
  kind                 text not null default 'follow_up'
                       check (kind in ('follow_up','collection','visit_prep','approval','quality','general')),
  customer_id          uuid references crm.customers(id),
  assignee_employee_id uuid not null references core.employees(id),
  created_by           uuid references auth.users(id),
  source               text not null default 'manual' check (source in ('manual','visit','system','automation')),
  ref_table            text,
  ref_id               uuid,
  priority             text not null default 'normal' check (priority in ('low','normal','high','urgent')),
  due_at               timestamptz not null,
  status               text not null default 'open' check (status in ('open','done','cancelled')),
  completed_at         timestamptz,
  outcome              text,
  created_at           timestamptz not null default now(),
  check ((status = 'done') = (completed_at is not null))
);
create index on work.tasks (assignee_employee_id, status, due_at);

-- ---------------------------------------------------------------------------
-- FIELD: visits & GPS verification (verified check-ins, NOT continuous tracking — ADR-010)
-- ---------------------------------------------------------------------------
create table field.visits (
  id                  uuid primary key,           -- client-generated → offline-safe idempotency
  customer_id         uuid not null references crm.customers(id),
  employee_id         uuid not null references core.employees(id),
  planned_for         date,
  status              text not null default 'planned'
                      check (status in ('planned','in_progress','completed','cancelled','missed')),
  check_in_at         timestamptz,                -- device time of the fix
  check_in_received_at timestamptz,               -- server time
  check_in_distance_m numeric(12,1),
  check_in_accuracy_m numeric(8,1),
  check_out_at        timestamptz,
  verification_status text not null default 'pending'
                      check (verification_status in ('pending','verified','out_of_range','low_accuracy',
                                                     'no_customer_location','no_device_location',
                                                     'exception_requested','exception_approved','exception_rejected')),
  anomaly_flags       text[] not null default '{}', -- 'clock_skew','impossible_travel','duplicate_fix','late_sync'
  outcome             text check (outcome in ('order_taken','interested','follow_up','not_interested',
                                              'doctor_unavailable','collection','demo','complaint','other')),
  notes               text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  check (check_out_at is null or check_in_at is null or check_out_at >= check_in_at)
);
create index on field.visits (employee_id, check_in_at desc);
create index on field.visits (customer_id, check_in_at desc);

-- Raw location fixes (the "visit_locations" entity). Retention-limited (ADR-010).
create table field.location_events (
  id           uuid primary key default gen_random_uuid(),
  visit_id     uuid not null references field.visits(id),
  employee_id  uuid not null references core.employees(id),
  event_type   text not null check (event_type in ('check_in','check_out')),
  latitude     numeric(9,6),
  longitude    numeric(9,6),
  accuracy_m   numeric(8,1),
  captured_at  timestamptz not null,            -- device clock
  received_at  timestamptz not null default now(),
  device_info  jsonb not null default '{}',
  unique (visit_id, event_type)
);
create trigger trg_location_events_append_only before update on field.location_events
  for each row execute function core.forbid_mutation();

-- ---------------------------------------------------------------------------
-- SALES
-- ---------------------------------------------------------------------------
create table sales.discount_rules (           -- promotional / standing discounts
  id             uuid primary key default gen_random_uuid(),
  name           text not null,
  brand_id       uuid references catalog.brands(id),
  category_id    uuid references catalog.categories(id),
  variant_id     uuid references catalog.product_variants(id),
  customer_id    uuid references crm.customers(id),
  discount_pct   numeric(5,2) not null check (discount_pct > 0 and discount_pct <= 100),
  min_qty        int not null default 1,
  valid_from     date not null,
  valid_to       date,
  priority       int not null default 100,
  is_active      boolean not null default true
);

create table sales.orders (
  id                 uuid primary key default gen_random_uuid(),
  order_no           text unique,                -- assigned on submit
  client_ref         uuid unique,                -- idempotency key from the device
  customer_id        uuid not null references crm.customers(id),
  employee_id        uuid not null references core.employees(id),
  territory_id       uuid references core.territories(id),   -- snapshot at submit (KPI attribution)
  visit_id           uuid references field.visits(id),
  status             text not null default 'draft'
                     check (status in ('draft','submitted','pending_approval','approved','rejected','reserved',
                                       'partially_fulfilled','fulfilled','invoiced','closed','cancelled','returned')),
  currency           char(3) not null default 'EGP',
  payment_terms_days int not null default 0,
  subtotal           core.money not null default 0,
  discount_total     core.money not null default 0,
  tax_total          core.money not null default 0,
  total              core.money not null default 0,
  notes              text,
  submitted_at       timestamptz,
  approved_at        timestamptz,
  version            int not null default 1,
  created_by         uuid references auth.users(id),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  check (total = subtotal - discount_total + tax_total)
);
create index on sales.orders (customer_id);
create index on sales.orders (employee_id, submitted_at desc);
create index on sales.orders (status);

create table sales.order_items (
  id                     uuid primary key default gen_random_uuid(),
  order_id               uuid not null references sales.orders(id) on delete cascade,
  line_no                int not null,
  variant_id             uuid not null references catalog.product_variants(id),
  quantity               int not null check (quantity > 0),
  list_price             core.money not null check (list_price >= 0),     -- SERVER-resolved
  price_list_id          uuid references catalog.price_lists(id),
  requested_discount_pct numeric(5,2) not null default 0 check (requested_discount_pct between 0 and 100),
  promo_discount_pct     numeric(5,2) not null default 0 check (promo_discount_pct between 0 and 100),
  applied_discount_pct   numeric(5,2) not null default 0 check (applied_discount_pct between 0 and 100),
  tax_rate_pct           numeric(5,2) not null,
  line_subtotal          core.money not null,
  line_discount          core.money not null,
  line_tax               core.money not null,
  line_total             core.money not null,
  fulfilled_qty          int not null default 0 check (fulfilled_qty >= 0),
  returned_qty           int not null default 0 check (returned_qty >= 0),
  unique (order_id, line_no),
  check (fulfilled_qty <= quantity and returned_qty <= fulfilled_qty),
  check (line_total = line_subtotal - line_discount + line_tax)
);

create table sales.order_status_history (
  id          bigint generated always as identity primary key,
  order_id    uuid not null references sales.orders(id),
  from_status text,
  to_status   text not null,
  changed_by  uuid references auth.users(id),
  changed_at  timestamptz not null default now(),
  reason      text
);
create trigger trg_order_history_append_only before update or delete on sales.order_status_history
  for each row execute function core.forbid_mutation();

-- Allowed state transitions = the order state machine as data.
create table sales.order_transitions (
  from_status         text not null,
  to_status           text not null,
  required_permission text not null references authz.permissions(code),
  primary key (from_status, to_status)
);

create table inventory.reservations (
  id                  uuid primary key default gen_random_uuid(),
  order_item_id       uuid not null references sales.order_items(id),
  warehouse_id        uuid not null references inventory.warehouses(id),
  variant_id          uuid not null references catalog.product_variants(id),
  lot_id              uuid not null references inventory.lots(id),
  quantity            int not null check (quantity > 0),
  status              text not null default 'active' check (status in ('active','consumed','released')),
  expires_at          timestamptz,
  created_at          timestamptz not null default now(),
  closed_at           timestamptz
);
create index on inventory.reservations (order_item_id) where status = 'active';

create table sales.fulfillments (
  id             uuid primary key default gen_random_uuid(),
  fulfillment_no text not null unique,
  order_id       uuid not null references sales.orders(id),
  warehouse_id   uuid not null references inventory.warehouses(id),
  status         text not null default 'draft' check (status in ('draft','posted','cancelled')),
  delivered_at   timestamptz,
  posted_by      uuid references auth.users(id)
);
create table sales.fulfillment_items (
  id             uuid primary key default gen_random_uuid(),
  fulfillment_id uuid not null references sales.fulfillments(id) on delete cascade,
  order_item_id  uuid not null references sales.order_items(id),
  lot_id         uuid not null references inventory.lots(id),
  serial_id      uuid references inventory.serials(id),
  quantity       int not null check (quantity > 0)
);

create table sales.returns (
  id          uuid primary key default gen_random_uuid(),
  return_no   text not null unique,
  order_id    uuid not null references sales.orders(id),
  customer_id uuid not null references crm.customers(id),
  reason      text not null,
  status      text not null default 'requested'
              check (status in ('requested','pending_approval','approved','received','credited','rejected')),
  warehouse_id uuid references inventory.warehouses(id),   -- usually quarantine
  created_by  uuid references auth.users(id),
  created_at  timestamptz not null default now()
);
create table sales.return_items (
  id            uuid primary key default gen_random_uuid(),
  return_id     uuid not null references sales.returns(id) on delete cascade,
  order_item_id uuid not null references sales.order_items(id),
  lot_id        uuid not null references inventory.lots(id),
  quantity      int not null check (quantity > 0),
  condition     text not null default 'resaleable' check (condition in ('resaleable','damaged','expired'))
);

alter table crm.opportunities
  add constraint fk_opp_won_order foreign key (won_order_id) references sales.orders(id);

-- ---------------------------------------------------------------------------
-- FINANCE (operational AR; GL stays in the accounting system — OPEN DECISION D-01)
-- ---------------------------------------------------------------------------
create table finance.invoices (
  id             uuid primary key default gen_random_uuid(),
  invoice_no     text not null unique,
  order_id       uuid references sales.orders(id),
  customer_id    uuid not null references crm.customers(id),
  issue_date     date not null,
  due_date       date not null,
  status         text not null default 'issued'
                 check (status in ('issued','partially_paid','paid','credited','written_off')),
  currency       char(3) not null default 'EGP',
  subtotal       core.money not null,
  discount_total core.money not null default 0,
  tax_total      core.money not null default 0,
  total          core.money not null check (total >= 0),
  eta_uuid       text unique,                    -- Egyptian Tax Authority e-invoice UUID
  eta_status     text check (eta_status in ('not_required','pending','submitted','valid','invalid','rejected','cancelled')),
  eta_submitted_at timestamptz,
  created_by     uuid references auth.users(id),
  created_at     timestamptz not null default now(),
  check (due_date >= issue_date),
  check (total = subtotal - discount_total + tax_total)
);
create index on finance.invoices (customer_id, status);
create index on finance.invoices (due_date) where status in ('issued','partially_paid');
-- Issued invoices are immutable except status/ETA fields (enforced in finance.guard_invoice_update).

create table finance.invoice_items (
  id            uuid primary key default gen_random_uuid(),
  invoice_id    uuid not null references finance.invoices(id),
  order_item_id uuid references sales.order_items(id),
  variant_id    uuid not null references catalog.product_variants(id),
  description   text not null,
  quantity      int not null check (quantity > 0),
  unit_price    core.money not null,
  discount      core.money not null default 0,
  tax_rate_pct  numeric(5,2) not null,
  tax_amount    core.money not null,
  line_total    core.money not null
);
create trigger trg_invoice_items_append_only before update or delete on finance.invoice_items
  for each row execute function core.forbid_mutation();

create or replace function finance.guard_invoice_update() returns trigger
language plpgsql set search_path = '' as $$
begin
  if (new.invoice_no, new.customer_id, new.issue_date, new.subtotal, new.discount_total, new.tax_total, new.total)
     is distinct from
     (old.invoice_no, old.customer_id, old.issue_date, old.subtotal, old.discount_total, old.tax_total, old.total) then
    raise exception 'INVOICE_IMMUTABLE: issue a credit note instead' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger trg_invoices_guard before update on finance.invoices
  for each row execute function finance.guard_invoice_update();
create trigger trg_invoices_no_delete before delete on finance.invoices
  for each row execute function core.forbid_mutation();

create table finance.credit_notes (
  id          uuid primary key default gen_random_uuid(),
  credit_no   text not null unique,
  invoice_id  uuid not null references finance.invoices(id),
  customer_id uuid not null references crm.customers(id),
  return_id   uuid references sales.returns(id),
  reason      text not null,
  amount      core.money not null check (amount > 0),
  tax_amount  core.money not null default 0,
  issue_date  date not null default current_date,
  eta_uuid    text unique,
  approval_request_id uuid,
  created_by  uuid references auth.users(id),
  created_at  timestamptz not null default now()
);
create trigger trg_credit_notes_append_only before update or delete on finance.credit_notes
  for each row execute function core.forbid_mutation();

create table finance.payments (
  id                 uuid primary key default gen_random_uuid(),
  payment_no         text not null unique,
  client_ref         uuid unique,                 -- device idempotency key
  customer_id        uuid not null references crm.customers(id),
  collected_by       uuid references core.employees(id),
  method             text not null check (method in ('cash','bank_transfer','cheque','instapay','paymob_card','paymob_wallet','other')),
  amount             core.money not null check (amount > 0),
  received_at        timestamptz not null,
  reference          text,
  cheque_due_date    date,
  provider           text,                        -- 'paymob'
  provider_txn_id    text,
  status             text not null default 'pending_verification'
                     check (status in ('pending_verification','confirmed','bounced','reversed')),
  confirmed_by       uuid references auth.users(id),
  confirmed_at       timestamptz,
  created_by         uuid references auth.users(id),
  created_at         timestamptz not null default now(),
  unique (provider, provider_txn_id),
  check (method <> 'cheque' or cheque_due_date is not null)
);
create index on finance.payments (customer_id, received_at desc);

-- Allocation rows are append-only; an un-allocation is a negative row that references the original.
create table finance.payment_allocations (
  id                    uuid primary key default gen_random_uuid(),
  payment_id            uuid not null references finance.payments(id),
  invoice_id            uuid not null references finance.invoices(id),
  amount                core.money not null check (amount <> 0),
  reverses_allocation_id uuid unique references finance.payment_allocations(id),
  allocated_by          uuid references auth.users(id),
  allocated_at          timestamptz not null default now(),
  check ((amount < 0) = (reverses_allocation_id is not null))
);
create index on finance.payment_allocations (invoice_id);
create index on finance.payment_allocations (payment_id);
create trigger trg_allocations_append_only before update or delete on finance.payment_allocations
  for each row execute function core.forbid_mutation();

-- Accounts-receivable sub-ledger. Customer balance = SUM(amount). Append-only.
create table finance.customer_ledger (
  id          bigint generated always as identity primary key,
  customer_id uuid not null references crm.customers(id),
  entry_type  text not null check (entry_type in ('invoice','credit_note','payment','payment_reversal','write_off','opening_balance','adjustment')),
  amount      core.money not null check (amount <> 0),   -- + increases what the customer owes
  source_table text not null,
  source_id   uuid not null,
  posted_at   timestamptz not null default now(),
  posted_by   uuid references auth.users(id),
  unique (source_table, source_id, entry_type)            -- a document posts once
);
create index on finance.customer_ledger (customer_id, posted_at);
create trigger trg_customer_ledger_append_only before update or delete on finance.customer_ledger
  for each row execute function core.forbid_mutation();

create view finance.v_customer_balances as
  select customer_id, sum(amount)::numeric(14,2) as balance, max(posted_at) as last_movement_at
  from finance.customer_ledger group by customer_id;

create view finance.v_invoice_open_amounts as
  select i.id as invoice_id, i.customer_id, i.due_date, i.total,
         coalesce(sum(pa.amount), 0)::numeric(14,2) as allocated,
         coalesce((select sum(cn.amount + cn.tax_amount) from finance.credit_notes cn where cn.invoice_id = i.id), 0)::numeric(14,2) as credited,
         (i.total - coalesce(sum(pa.amount), 0)
                  - coalesce((select sum(cn.amount + cn.tax_amount) from finance.credit_notes cn where cn.invoice_id = i.id), 0))::numeric(14,2) as open_amount
  from finance.invoices i left join finance.payment_allocations pa on pa.invoice_id = i.id
  group by i.id;

create table finance.collection_tasks (
  id               uuid primary key default gen_random_uuid(),
  customer_id      uuid not null references crm.customers(id),
  invoice_id       uuid references finance.invoices(id),
  assignee_employee_id uuid not null references core.employees(id),
  due_date         date not null,
  status           text not null default 'open' check (status in ('open','promised','collected','escalated','closed')),
  promised_amount  core.money,
  promised_date    date,
  outcome          text,
  created_at       timestamptz not null default now(),
  closed_at        timestamptz
);

-- ---------------------------------------------------------------------------
-- PERFORMANCE: KPI engine + commissions (formulas are code-registered metrics — ADR-015)
-- ---------------------------------------------------------------------------
create table perf.kpi_definitions (
  id             uuid primary key default gen_random_uuid(),
  code           text not null unique,         -- 'VISITS_COMPLETED','NEW_ACCOUNTS','COLLECTION_RATE'
  name_en        text not null,
  name_ar        text,
  definition     text not null,                -- plain-language definition shown in the UI
  formula        text not null,                -- documented formula (human readable)
  metric_key     text not null,                -- registered SQL metric function (whitelist)
  data_source    text not null,                -- tables the metric reads
  indicator_type text not null check (indicator_type in ('leading','lagging')),
  period_type    text not null check (period_type in ('week','month','quarter','year')),
  unit           text not null check (unit in ('count','pct','egp','ratio')),
  higher_is_better boolean not null default true,
  status         text not null default 'active' check (status in ('draft','active','retired')),
  version        int not null default 1,
  effective_from date not null default current_date
);

create table perf.kpi_targets (
  id           uuid primary key default gen_random_uuid(),
  kpi_id       uuid not null references perf.kpi_definitions(id),
  role_id      uuid references authz.roles(id),
  employee_id  uuid references core.employees(id),
  territory_id uuid references core.territories(id),
  target_value numeric(14,2) not null,
  weight_pct   numeric(5,2) not null default 0 check (weight_pct between 0 and 100),
  period_start date not null,
  period_end   date not null,
  set_by       uuid references auth.users(id),
  created_at   timestamptz not null default now(),
  check (num_nonnulls(role_id, employee_id, territory_id) = 1),
  check (period_end >= period_start)
);

create table perf.kpi_results (
  id             uuid primary key default gen_random_uuid(),
  kpi_id         uuid not null references perf.kpi_definitions(id),
  employee_id    uuid references core.employees(id),
  territory_id   uuid references core.territories(id),
  period_start   date not null,
  period_end     date not null,
  actual_value   numeric(14,2) not null,
  target_value   numeric(14,2),
  achievement_pct numeric(7,2),
  kpi_version    int not null,
  computed_at    timestamptz not null default now(),
  is_final       boolean not null default false,   -- frozen after period close
  source_snapshot jsonb not null default '{}',     -- counts/ids used → traceability
  unique nulls not distinct (kpi_id, employee_id, territory_id, period_start, kpi_version)
);

create table perf.commission_plans (
  id                   uuid primary key default gen_random_uuid(),
  code                 text not null unique,
  name                 text not null,
  basis                text not null default 'collected' check (basis in ('collected','invoiced')),
  min_achievement_pct  numeric(5,2),                -- eligibility threshold, optional
  effective_from       date not null,
  effective_to         date,
  status               text not null default 'draft' check (status in ('draft','active','retired'))
);

create table perf.commission_plan_rules (
  id          uuid primary key default gen_random_uuid(),
  plan_id     uuid not null references perf.commission_plans(id) on delete cascade,
  brand_id    uuid references catalog.brands(id),
  category_id uuid references catalog.categories(id),
  variant_id  uuid references catalog.product_variants(id),
  rate_pct    numeric(5,2) not null check (rate_pct between 0 and 100),   -- seed: IMPLANT 5.00, BUR/INSTRUMENT 1.50
  priority    int not null default 100                                    -- most specific rule wins
);

create table perf.employee_commission_plans (
  employee_id uuid not null references core.employees(id),
  plan_id     uuid not null references perf.commission_plans(id),
  valid_from  date not null,
  valid_to    date,
  primary key (employee_id, plan_id, valid_from)
);

create table perf.commission_periods (
  id           uuid primary key default gen_random_uuid(),
  period_start date not null,
  period_end   date not null,
  status       text not null default 'open' check (status in ('open','calculated','approved','paid','locked')),
  calculated_at timestamptz,
  approved_by  uuid references auth.users(id),
  approved_at  timestamptz,
  unique (period_start, period_end)
);

create table perf.commission_entries (
  id               uuid primary key default gen_random_uuid(),
  period_id        uuid not null references perf.commission_periods(id),
  employee_id      uuid not null references core.employees(id),
  plan_id          uuid not null references perf.commission_plans(id),
  rule_id          uuid references perf.commission_plan_rules(id),
  source_type      text not null check (source_type in ('payment_allocation','credit_note','allocation_reversal')),
  source_id        uuid not null,
  invoice_item_id  uuid references finance.invoice_items(id),
  base_amount      core.money not null,            -- net of tax, signed
  rate_pct         numeric(5,2) not null,
  commission_amount core.money not null,
  calc_run_id      uuid not null,
  created_at       timestamptz not null default now(),
  unique (source_type, source_id, invoice_item_id, employee_id)   -- no double counting
);

create table perf.commission_adjustments (
  id                  uuid primary key default gen_random_uuid(),
  period_id           uuid not null references perf.commission_periods(id),
  employee_id         uuid not null references core.employees(id),
  amount              core.money not null check (amount <> 0),
  kind                text not null check (kind in ('bonus','clawback','correction')),
  reason              text not null,
  approval_request_id uuid,
  created_by          uuid references auth.users(id),
  created_at          timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- WORKFLOW: configurable approvals
-- ---------------------------------------------------------------------------
create table wf.workflow_definitions (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique,   -- 'sales.order.discount','inventory.adjustment','crm.customer.reassign'
  name        text not null,
  entity_type text not null,
  is_active   boolean not null default true,
  version     int not null default 1
);

-- First matching rule (by priority) decides the stages. Condition is a small,
-- validated JSON predicate evaluated server-side — never SQL text.
create table wf.workflow_rules (
  id            uuid primary key default gen_random_uuid(),
  definition_id uuid not null references wf.workflow_definitions(id) on delete cascade,
  priority      int not null,
  condition     jsonb not null default '{}',   -- {"all":[{"field":"discount_pct","op":">","value":10}]}
  auto_approve  boolean not null default false,
  unique (definition_id, priority)
);

create table wf.workflow_stages (
  id                 uuid primary key default gen_random_uuid(),
  rule_id            uuid not null references wf.workflow_rules(id) on delete cascade,
  stage_no           int not null,
  approver_type      text not null check (approver_type in ('permission','role','requester_manager','user')),
  approver_permission text references authz.permissions(code),
  approver_role_id   uuid references authz.roles(id),
  approver_user_id   uuid references auth.users(id),
  required_approvals int not null default 1 check (required_approvals >= 1),
  escalate_after     interval,
  unique (rule_id, stage_no)
);

create table wf.approval_requests (
  id              uuid primary key default gen_random_uuid(),
  definition_id   uuid not null references wf.workflow_definitions(id),
  rule_id         uuid references wf.workflow_rules(id),
  entity_type     text not null,
  entity_id       uuid not null,
  requested_by    uuid not null references auth.users(id),
  payload         jsonb not null,               -- frozen snapshot of what is being approved
  status          text not null default 'pending' check (status in ('pending','approved','rejected','cancelled','expired')),
  current_stage   int not null default 1,
  created_at      timestamptz not null default now(),
  decided_at      timestamptz
);
create unique index uq_one_pending_request on wf.approval_requests (definition_id, entity_id) where status = 'pending';

create table wf.approval_steps (
  id             uuid primary key default gen_random_uuid(),
  request_id     uuid not null references wf.approval_requests(id),
  stage_no       int not null,
  approver_id    uuid not null references auth.users(id),
  on_behalf_of   uuid references auth.users(id),   -- delegation
  decision       text not null check (decision in ('approved','rejected')),
  comment        text,
  decided_at     timestamptz not null default now(),
  unique (request_id, stage_no, approver_id)
);
create trigger trg_approval_steps_append_only before update or delete on wf.approval_steps
  for each row execute function core.forbid_mutation();

create table wf.delegations (
  id            uuid primary key default gen_random_uuid(),
  from_user_id  uuid not null references auth.users(id),
  to_user_id    uuid not null references auth.users(id),
  definition_id uuid references wf.workflow_definitions(id),   -- null = all workflows
  valid_from    timestamptz not null,
  valid_to      timestamptz not null,
  created_at    timestamptz not null default now(),
  check (from_user_id <> to_user_id and valid_to > valid_from)
);

alter table inventory.movements
  add constraint fk_mov_approval foreign key (approval_request_id) references wf.approval_requests(id);

-- ---------------------------------------------------------------------------
-- AUDIT, NOTIFICATIONS, INTEGRATION
-- ---------------------------------------------------------------------------
create table audit.audit_log (
  id            bigint generated always as identity primary key,
  occurred_at   timestamptz not null default now(),
  actor_user_id uuid,
  action        text not null check (action in ('INSERT','UPDATE','DELETE')),
  table_schema  text not null,
  table_name    text not null,
  record_id     text,
  old_data      jsonb,
  new_data      jsonb,
  changed_fields text[],
  request_id    text            -- correlation id set by the app: set_config('app.request_id', ...)
);
create index on audit.audit_log (table_schema, table_name, record_id);
create index on audit.audit_log (actor_user_id, occurred_at desc);
create trigger trg_audit_append_only before update or delete on audit.audit_log
  for each row execute function core.forbid_mutation();

create table audit.security_events (
  id          bigint generated always as identity primary key,
  occurred_at timestamptz not null default now(),
  user_id     uuid,
  event_type  text not null,     -- 'login','login_failed','permission_denied','role_granted','role_revoked','user_suspended','export','owner_change'
  severity    text not null default 'info' check (severity in ('info','warning','critical')),
  details     jsonb not null default '{}'
);
create trigger trg_security_append_only before update or delete on audit.security_events
  for each row execute function core.forbid_mutation();

create or replace function audit.log_change() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_old jsonb; v_new jsonb; v_changed text[];
begin
  if tg_op <> 'INSERT' then v_old := to_jsonb(old); end if;
  if tg_op <> 'DELETE' then v_new := to_jsonb(new); end if;
  if tg_op = 'UPDATE' then
    select array_agg(k) into v_changed
    from jsonb_object_keys(v_new) k where v_new -> k is distinct from v_old -> k;
    if v_changed is null then return null; end if;   -- no-op update
  end if;
  insert into audit.audit_log (actor_user_id, action, table_schema, table_name, record_id,
                               old_data, new_data, changed_fields, request_id)
  values (auth.uid(), tg_op, tg_table_schema, tg_table_name,
          coalesce(v_new ->> 'id', v_old ->> 'id'), v_old, v_new, v_changed,
          nullif(current_setting('app.request_id', true), ''));
  return null;
end $$;

-- Attach audit to every table whose history matters.
do $$
declare t text;
begin
  foreach t in array array[
    'core.employees','core.user_profiles','core.system_settings','core.territories',
    'authz.roles','authz.role_permissions','authz.user_roles','authz.user_permission_overrides',
    'catalog.products','catalog.product_variants','catalog.product_costs','catalog.price_lists','catalog.price_list_items',
    'crm.customers','crm.customer_assignments',
    'sales.orders','sales.order_items','sales.discount_rules',
    'finance.invoices','finance.payments',
    'perf.kpi_definitions','perf.kpi_targets','perf.commission_plans','perf.commission_plan_rules',
    'perf.commission_periods','perf.commission_adjustments',
    'wf.workflow_definitions','wf.workflow_rules','wf.workflow_stages','wf.approval_requests',
    'inventory.warehouses','inventory.transfers']
  loop
    execute format('create trigger trg_audit after insert or update or delete on %s
                    for each row execute function audit.log_change()', t);
  end loop;
end $$;

create table notify.notifications (
  id                uuid primary key default gen_random_uuid(),
  recipient_user_id uuid not null references auth.users(id),
  type              text not null,              -- 'approval.requested','order.approved','task.due',...
  title             text not null,
  body              text,
  link              text,
  data              jsonb not null default '{}',
  read_at           timestamptz,
  created_at        timestamptz not null default now()
);
create index on notify.notifications (recipient_user_id, created_at desc) where read_at is null;

create table notify.channel_preferences (
  user_id   uuid not null references auth.users(id),
  type      text not null,
  channel   text not null check (channel in ('in_app','push','email','whatsapp')),
  enabled   boolean not null default true,
  primary key (user_id, type, channel)
);

-- Transactional outbox (the "integration_events" entity) — written in the same
-- transaction as the business change; a dispatcher delivers it (ADR-016).
create table integration.outbox (
  id              uuid primary key default gen_random_uuid(),
  event_type      text not null,                -- 'order.submitted','invoice.overdue','stock.below_threshold'
  aggregate_type  text not null,
  aggregate_id    uuid not null,
  payload         jsonb not null,
  status          text not null default 'pending' check (status in ('pending','in_flight','delivered','failed','dead')),
  attempts        int not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error      text,
  created_at      timestamptz not null default now(),
  delivered_at    timestamptz
);
create index on integration.outbox (status, next_attempt_at) where status in ('pending','failed');

create table integration.inbound_webhooks (
  id                uuid primary key default gen_random_uuid(),
  provider          text not null,              -- 'paymob','shopify','whatsapp'
  external_event_id text not null,
  signature_valid   boolean not null,
  payload           jsonb not null,
  status            text not null default 'received' check (status in ('received','processed','ignored','failed')),
  error             text,
  received_at       timestamptz not null default now(),
  processed_at      timestamptz,
  unique (provider, external_event_id)          -- idempotent receipt
);

create table integration.external_refs (
  entity_type text not null,                    -- 'customer','variant','order'
  entity_id   uuid not null,
  provider    text not null,                    -- 'shopify'
  external_id text not null,
  synced_at   timestamptz not null default now(),
  primary key (provider, entity_type, external_id),
  unique (provider, entity_type, entity_id)
);

-- ---------------------------------------------------------------------------
-- DOMAIN COMMANDS (examples of the pattern; full set specified in docs/API_CONTRACTS.md)
-- ---------------------------------------------------------------------------

-- Server-side price resolution: customer list → promotional → default. Never trusts the client.
create or replace function sales.resolve_list_price(p_customer_id uuid, p_variant_id uuid, p_qty int,
                                                    p_on date default current_date)
returns table (unit_price numeric, price_list_id uuid)
language sql stable security definer set search_path = '' as $$
  select pli.unit_price, pl.id
  from catalog.price_lists pl
  join catalog.price_list_items pli on pli.price_list_id = pl.id
  where pli.variant_id = p_variant_id and pli.min_qty <= p_qty and pl.is_active
    and p_on >= pl.valid_from and (pl.valid_to is null or p_on <= pl.valid_to)
    and (pl.kind <> 'customer' or exists (
          select 1 from catalog.customer_price_lists cpl
          where cpl.customer_id = p_customer_id and cpl.price_list_id = pl.id
            and p_on >= cpl.valid_from and (cpl.valid_to is null or p_on <= cpl.valid_to)))
  order by case pl.kind when 'customer' then 0 when 'promotional' then 1 else 2 end,
           pl.priority, pli.min_qty desc
  limit 1
$$;


-- Submit an order: prices + discounts computed here; discount above the caller's
-- limit routes to approval instead of failing silently or trusting the client.
create or replace function api.submit_order(p_order_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_order sales.orders%rowtype;
  v_limit numeric;
  v_max_requested numeric;
  v_item record;
  v_price record;
  v_promo numeric;
  v_applied numeric;
  v_sub numeric; v_disc numeric; v_tax numeric;
  v_status text;
  v_def uuid;
begin
  perform authz.require('sales.order.submit');

  select * into v_order from sales.orders where id = p_order_id for update;
  if not found then raise exception 'NOT_FOUND: order %', p_order_id using errcode = 'P0002'; end if;
  if v_order.status <> 'draft' then
    raise exception 'INVALID_STATE: order is %', v_order.status using errcode = 'P0001';
  end if;
  -- ABAC: the caller must be able to act on this customer.
  if not (authz.has_global('sales.order.submit')
          or v_order.employee_id = any(authz.employee_ids('sales.order.submit'))) then
    raise exception 'PERMISSION_DENIED: order belongs to another representative' using errcode = '42501';
  end if;

  for v_item in select * from sales.order_items where order_id = p_order_id for update loop
    select * into v_price from sales.resolve_list_price(v_order.customer_id, v_item.variant_id, v_item.quantity);
    if v_price.unit_price is null then
      raise exception 'NO_PRICE: variant % has no active price', v_item.variant_id using errcode = 'P0001';
    end if;
    select coalesce(max(d.discount_pct), 0) into v_promo
    from sales.discount_rules d
    join catalog.product_variants pv on pv.id = v_item.variant_id
    join catalog.products p on p.id = pv.product_id
    where d.is_active and current_date between d.valid_from and coalesce(d.valid_to, current_date)
      and v_item.quantity >= d.min_qty
      and (d.variant_id is null or d.variant_id = v_item.variant_id)
      and (d.brand_id is null or d.brand_id = p.brand_id)
      and (d.category_id is null or d.category_id = p.category_id)
      and (d.customer_id is null or d.customer_id = v_order.customer_id);
    v_applied := greatest(v_promo, v_item.requested_discount_pct);
    update sales.order_items oi set
      list_price           = v_price.unit_price,
      price_list_id        = v_price.price_list_id,
      promo_discount_pct   = v_promo,
      applied_discount_pct = v_applied,
      tax_rate_pct         = p.tax_rate_pct,
      line_subtotal        = round(v_price.unit_price * v_item.quantity, 2),
      line_discount        = round(v_price.unit_price * v_item.quantity * v_applied / 100, 2),
      line_tax             = round((v_price.unit_price * v_item.quantity
                                    - round(v_price.unit_price * v_item.quantity * v_applied / 100, 2)) * p.tax_rate_pct / 100, 2),
      line_total           = round(v_price.unit_price * v_item.quantity, 2)
                             - round(v_price.unit_price * v_item.quantity * v_applied / 100, 2)
                             + round((v_price.unit_price * v_item.quantity
                                      - round(v_price.unit_price * v_item.quantity * v_applied / 100, 2)) * p.tax_rate_pct / 100, 2)
    from catalog.product_variants pv join catalog.products p on p.id = pv.product_id
    where oi.id = v_item.id and pv.id = oi.variant_id;
  end loop;

  select coalesce(sum(line_subtotal),0), coalesce(sum(line_discount),0), coalesce(sum(line_tax),0),
         coalesce(max(requested_discount_pct - promo_discount_pct), 0)
    into v_sub, v_disc, v_tax, v_max_requested
  from sales.order_items where order_id = p_order_id;
  if v_sub = 0 then raise exception 'EMPTY_ORDER' using errcode = 'P0001'; end if;

  -- Discount authority: manual discount beyond promo vs. the caller's limit (NULL = unlimited).
  v_limit := authz.max_limit('sales.discount.apply');
  if v_max_requested > 0 and not authz.has_permission('sales.discount.apply') then
    v_status := 'pending_approval';
  elsif v_max_requested > coalesce(v_limit, v_max_requested) then
    v_status := 'pending_approval';
  else
    v_status := 'submitted';
  end if;

  update sales.orders set
    order_no = coalesce(order_no, core.next_document_no('SO')),
    subtotal = v_sub, discount_total = v_disc, tax_total = v_tax, total = v_sub - v_disc + v_tax,
    status = v_status, submitted_at = now(),
    territory_id = (select territory_id from crm.customers where id = v_order.customer_id),
    version = version + 1
  where id = p_order_id;

  insert into sales.order_status_history (order_id, from_status, to_status, changed_by, reason)
  values (p_order_id, 'draft', v_status, auth.uid(),
          case when v_status = 'pending_approval' then 'discount above limit' end);

  if v_status = 'pending_approval' then
    select id into v_def from wf.workflow_definitions where code = 'sales.order.discount' and is_active;
    if v_def is null then raise exception 'WORKFLOW_MISSING: sales.order.discount' using errcode = 'P0001'; end if;
    insert into wf.approval_requests (definition_id, entity_type, entity_id, requested_by, payload)
    values (v_def, 'sales.order', p_order_id, auth.uid(),
            jsonb_build_object('max_manual_discount_pct', v_max_requested, 'limit_pct', v_limit,
                               'total', v_sub - v_disc + v_tax));
  end if;

  insert into integration.outbox (event_type, aggregate_type, aggregate_id, payload)
  values ('order.' || v_status, 'sales.order', p_order_id,
          jsonb_build_object('order_id', p_order_id, 'status', v_status, 'total', v_sub - v_disc + v_tax));

  return jsonb_build_object('order_id', p_order_id, 'status', v_status,
                            'total', v_sub - v_disc + v_tax);
end $$;

-- Verified GPS check-in. The server computes distance and verdict; the device only reports a fix.
create or replace function api.visit_check_in(
  p_visit_id uuid, p_customer_id uuid, p_lat numeric, p_lng numeric,
  p_accuracy_m numeric, p_captured_at timestamptz, p_device jsonb default '{}')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_emp uuid := authz.current_employee_id();
  v_cust crm.customers%rowtype;
  v_radius numeric; v_max_acc numeric;
  v_dist numeric; v_status text; v_flags text[] := '{}';
  v_prev record;
begin
  perform authz.require('field.visit.create');
  if v_emp is null then raise exception 'NO_EMPLOYEE_PROFILE' using errcode = '42501'; end if;

  select * into v_cust from crm.customers where id = p_customer_id;
  if not found then raise exception 'NOT_FOUND: customer' using errcode = 'P0002'; end if;
  if not (authz.has_global('crm.customer.read')
          or v_cust.territory_id = any(authz.territory_ids('crm.customer.read'))
          or p_customer_id = any(authz.assigned_customer_ids('crm.customer.read'))) then
    raise exception 'PERMISSION_DENIED: customer not in your scope' using errcode = '42501';
  end if;

  -- Idempotent replay from the offline queue: same visit id → same answer.
  if exists (select 1 from field.location_events where visit_id = p_visit_id and event_type = 'check_in') then
    return (select jsonb_build_object('visit_id', id, 'verification_status', verification_status,
                                      'distance_m', check_in_distance_m, 'replayed', true)
            from field.visits where id = p_visit_id);
  end if;

  v_radius  := coalesce((select (value #>> '{}')::numeric from core.system_settings where key = 'field.geofence_radius_m'), 150);
  v_max_acc := coalesce((select (value #>> '{}')::numeric from core.system_settings where key = 'field.max_accuracy_m'), 100);

  if p_lat is null or p_lng is null then
    v_status := 'no_device_location';
  elsif v_cust.latitude is null then
    v_status := 'no_customer_location';
  else
    v_dist := core.distance_m(p_lat, p_lng, v_cust.latitude, v_cust.longitude);
    v_status := case when p_accuracy_m > v_max_acc then 'low_accuracy'
                     when v_dist > v_radius + least(p_accuracy_m, v_max_acc) then 'out_of_range'
                     else 'verified' end;
  end if;

  if abs(extract(epoch from (now() - p_captured_at))) > 600 then
    v_flags := array_append(v_flags, case when p_captured_at < now() then 'late_sync' else 'clock_skew' end);
  end if;
  select le.latitude, le.longitude, le.captured_at into v_prev
  from field.location_events le where le.employee_id = v_emp and le.captured_at < p_captured_at
  order by le.captured_at desc limit 1;
  if v_prev.captured_at is not null and p_lat is not null and v_prev.latitude is not null then
    if v_prev.latitude = p_lat and v_prev.longitude = p_lng then v_flags := array_append(v_flags, 'duplicate_fix'); end if;
    if core.distance_m(v_prev.latitude, v_prev.longitude, p_lat, p_lng)
       / greatest(extract(epoch from (p_captured_at - v_prev.captured_at)), 1) * 3.6 > 150 then
      v_flags := array_append(v_flags, 'impossible_travel');
    end if;
  end if;

  insert into field.visits (id, customer_id, employee_id, status, check_in_at, check_in_received_at,
                            check_in_distance_m, check_in_accuracy_m, verification_status, anomaly_flags)
  values (p_visit_id, p_customer_id, v_emp, 'in_progress', p_captured_at, now(),
          v_dist, p_accuracy_m, v_status, v_flags)
  on conflict (id) do update set status = 'in_progress', check_in_at = excluded.check_in_at,
    check_in_received_at = excluded.check_in_received_at, check_in_distance_m = excluded.check_in_distance_m,
    check_in_accuracy_m = excluded.check_in_accuracy_m, verification_status = excluded.verification_status,
    anomaly_flags = excluded.anomaly_flags
  where field.visits.employee_id = v_emp;

  insert into field.location_events (visit_id, employee_id, event_type, latitude, longitude, accuracy_m, captured_at, device_info)
  values (p_visit_id, v_emp, 'check_in', p_lat, p_lng, p_accuracy_m, p_captured_at, coalesce(p_device, '{}'));

  insert into crm.activities (customer_id, employee_id, type, occurred_at, summary, ref_table, ref_id)
  values (p_customer_id, v_emp, 'visit', p_captured_at, 'Check-in (' || v_status || ')', 'field.visits', p_visit_id);

  return jsonb_build_object('visit_id', p_visit_id, 'verification_status', v_status,
                            'distance_m', v_dist, 'anomaly_flags', v_flags, 'replayed', false);
end $$;

-- Post an inventory adjustment directly (authorised users) — every stock change is a movement.
create or replace function api.post_inventory_adjustment(
  p_warehouse_id uuid, p_variant_id uuid, p_lot_id uuid, p_quantity int, p_reason text, p_idempotency_key text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_limit numeric;
begin
  perform authz.require('inventory.adjustment.post');
  if not (authz.has_global('inventory.adjustment.post')
          or p_warehouse_id = any(authz.warehouse_ids('inventory.adjustment.post'))) then
    raise exception 'PERMISSION_DENIED: warehouse not in your scope' using errcode = '42501';
  end if;
  v_limit := authz.max_limit('inventory.adjustment.post');      -- max absolute units without approval
  if v_limit is not null and abs(p_quantity) > v_limit then
    raise exception 'APPROVAL_REQUIRED: adjustment of % exceeds limit %', p_quantity, v_limit using errcode = 'P0001';
  end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'REASON_REQUIRED' using errcode = 'P0001'; end if;

  select id into v_id from inventory.movements where idempotency_key = p_idempotency_key;
  if v_id is not null then return v_id; end if;

  insert into inventory.movements (movement_type, warehouse_id, variant_id, lot_id, quantity, reason_code,
                                   source_doc_type, idempotency_key, created_by)
  values (case when p_quantity > 0 then 'adjustment_in' else 'adjustment_out' end,
          p_warehouse_id, p_variant_id, p_lot_id, p_quantity, p_reason, 'adjustment', p_idempotency_key, auth.uid())
  returning id into v_id;
  return v_id;
end $$;

-- Grant a role with anti-escalation: the grantor must hold every permission of the
-- role at an equal-or-wider scope; only owners grant the owner role; nobody edits their own roles.
create or replace function api.grant_role(p_user_id uuid, p_role_id uuid, p_territory_id uuid default null,
                                          p_reason text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_role authz.roles%rowtype; v_missing text; v_id uuid;
begin
  perform authz.require('admin.role.assign');
  if p_user_id = auth.uid() and not authz.is_owner() then
    raise exception 'SELF_GRANT_FORBIDDEN' using errcode = '42501';
  end if;
  select * into v_role from authz.roles where id = p_role_id and is_active;
  if not found then raise exception 'NOT_FOUND: role' using errcode = 'P0002'; end if;
  if v_role.is_owner_role and not authz.is_owner() then
    raise exception 'OWNER_ONLY: only an owner can grant the owner role' using errcode = '42501';
  end if;
  if not authz.is_owner() then
    select rp.permission_code into v_missing
    from authz.role_permissions rp
    where rp.role_id = p_role_id and not exists (
      select 1 from authz.grants(rp.permission_code) g
      where array_position(array['own','team','territory','department','warehouse','all'], g.scope)
         >= array_position(array['own','team','territory','department','warehouse','all'], rp.scope)
        and (rp.limit_value is null and g.limit_value is null or g.limit_value is null or g.limit_value >= rp.limit_value))
    limit 1;
    if v_missing is not null then
      raise exception 'ESCALATION_BLOCKED: you do not hold %', v_missing using errcode = '42501';
    end if;
  end if;

  insert into authz.user_roles (user_id, role_id, scope_territory_id, granted_by, reason)
  values (p_user_id, p_role_id, p_territory_id, auth.uid(), p_reason) returning id into v_id;
  insert into audit.security_events (user_id, event_type, severity, details)
  values (auth.uid(), 'role_granted', case when v_role.is_owner_role then 'critical' else 'warning' end,
          jsonb_build_object('target_user', p_user_id, 'role', v_role.code, 'territory', p_territory_id));
  return v_id;
end $$;

-- ---------------------------------------------------------------------------
-- ROW LEVEL SECURITY (deny by default: RLS on, no policy = no rows)
-- RLS is ENABLED but deliberately NOT FORCED: tables and SECURITY DEFINER
-- functions share one owner role, so domain commands run without RLS while
-- every client role (anon, authenticated) is filtered. See ADR-005.
-- ---------------------------------------------------------------------------
do $$
declare r record;
begin
  for r in select schemaname, tablename from pg_tables
           where schemaname in ('core','authz','catalog','inventory','crm','field','work','sales',
                                'finance','perf','wf','audit','notify','integration')
  loop
    execute format('alter table %I.%I enable row level security', r.schemaname, r.tablename);
  end loop;
end $$;

-- Base privileges: authenticated may SELECT (RLS filters). Writes go through
-- api.* SECURITY DEFINER functions, except a few self-service tables below.
grant usage on schema core, authz, catalog, inventory, crm, field, work, sales, finance, perf, wf, notify, api to authenticated;
do $$
declare s text;
begin
  foreach s in array array['core','authz','catalog','inventory','crm','field','work','sales','finance','perf','wf','notify'] loop
    execute format('grant select on all tables in schema %I to authenticated', s);
  end loop;
end $$;
revoke all on all functions in schema api from public;
grant execute on all functions in schema api to authenticated;

-- CRM: territory / assignment visibility
create policy customers_select on crm.customers for select to authenticated using (
  (select authz.has_global('crm.customer.read'))
  or territory_id = any((select authz.territory_ids('crm.customer.read'))::uuid[])
  or id = any((select authz.assigned_customer_ids('crm.customer.read'))::uuid[])
);
create policy assignments_select on crm.customer_assignments for select to authenticated using (
  exists (select 1 from crm.customers c where c.id = customer_assignments.customer_id)  -- inherits customer RLS
);
create policy activities_select on crm.activities for select to authenticated using (
  exists (select 1 from crm.customers c where c.id = activities.customer_id)
);

-- Sales orders: own/team/territory/all
create policy orders_select on sales.orders for select to authenticated using (
  (select authz.has_global('sales.order.read'))
  or employee_id = any((select authz.employee_ids('sales.order.read'))::uuid[])
  or territory_id = any((select authz.territory_ids('sales.order.read'))::uuid[])
);
create policy order_items_select on sales.order_items for select to authenticated using (
  exists (select 1 from sales.orders o where o.id = order_items.order_id)
);

-- Visits
create policy visits_select on field.visits for select to authenticated using (
  (select authz.has_global('field.visit.read'))
  or employee_id = any((select authz.employee_ids('field.visit.read'))::uuid[])
  or exists (select 1 from crm.customers c where c.id = visits.customer_id
             and c.territory_id = any((select authz.territory_ids('field.visit.read'))::uuid[]))
);
-- Raw GPS fixes are more sensitive than the visit verdict (privacy, ADR-010).
create policy location_events_select on field.location_events for select to authenticated using (
  employee_id = (select authz.current_employee_id())
  or (select authz.has_global('field.location.read'))
  or employee_id = any((select authz.employee_ids('field.location.read'))::uuid[])
);

-- Catalog: everyone with catalog access sees products & prices; costs are separate.
create policy products_select on catalog.products for select to authenticated using ((select authz.has_permission('catalog.product.read')));
create policy variants_select on catalog.product_variants for select to authenticated using ((select authz.has_permission('catalog.product.read')));
create policy brands_select on catalog.brands for select to authenticated using ((select authz.has_permission('catalog.product.read')));
create policy categories_select on catalog.categories for select to authenticated using ((select authz.has_permission('catalog.product.read')));
create policy price_lists_select on catalog.price_lists for select to authenticated using ((select authz.has_permission('catalog.price.read')));
create policy price_items_select on catalog.price_list_items for select to authenticated using ((select authz.has_permission('catalog.price.read')));
create policy costs_select on catalog.product_costs for select to authenticated using ((select authz.has_permission('catalog.cost.read')));

-- Inventory
create policy stock_select on inventory.stock_balances for select to authenticated using (
  (select authz.has_global('inventory.stock.read'))
  or warehouse_id = any((select authz.warehouse_ids('inventory.stock.read'))::uuid[])
  or ((select authz.has_permission('inventory.stock.read')) and exists (
        select 1 from authz.grants('inventory.stock.read') g where g.scope in ('own','team','territory')))
);
create policy lots_select on inventory.lots for select to authenticated using ((select authz.has_permission('inventory.stock.read')));
create policy warehouses_select on inventory.warehouses for select to authenticated using ((select authz.has_permission('inventory.stock.read')));
create policy movements_select on inventory.movements for select to authenticated using (
  (select authz.has_global('inventory.movement.read'))
  or warehouse_id = any((select authz.warehouse_ids('inventory.movement.read'))::uuid[])
);

-- Finance: invoices visible to finance (all) or to reps for their customers' invoices
create policy invoices_select on finance.invoices for select to authenticated using (
  (select authz.has_global('finance.invoice.read'))
  or ((select authz.has_permission('finance.invoice.read'))
      and exists (select 1 from crm.customers c where c.id = invoices.customer_id))
);
create policy payments_select on finance.payments for select to authenticated using (
  (select authz.has_global('finance.payment.read'))
  or collected_by = any((select authz.employee_ids('finance.payment.read'))::uuid[])
);
create policy ledger_select on finance.customer_ledger for select to authenticated using (
  (select authz.has_global('finance.ledger.read'))
  or ((select authz.has_permission('finance.ledger.read'))
      and exists (select 1 from crm.customers c where c.id = customer_ledger.customer_id))
);

-- Performance: own results; managers their team; commission data is stricter.
create policy kpi_results_select on perf.kpi_results for select to authenticated using (
  (select authz.has_global('perf.kpi.read'))
  or employee_id = any((select authz.employee_ids('perf.kpi.read'))::uuid[])
  or territory_id = any((select authz.territory_ids('perf.kpi.read'))::uuid[])
);
create policy commission_entries_select on perf.commission_entries for select to authenticated using (
  (select authz.has_global('perf.commission.read'))
  or employee_id = any((select authz.employee_ids('perf.commission.read'))::uuid[])
);
create policy commission_rules_select on perf.commission_plan_rules for select to authenticated using (
  (select authz.has_permission('perf.commission_plan.read'))
);

-- Self-service: profile, notifications, tasks
create policy profiles_self on core.user_profiles for select to authenticated using (
  user_id = auth.uid() or (select authz.has_permission('admin.user.read'))
);
create policy employees_select on core.employees for select to authenticated using (
  user_id = auth.uid()
  or (select authz.has_global('core.employee.read'))
  or id = any((select authz.employee_ids('core.employee.read'))::uuid[])
);
create policy notifications_own on notify.notifications for select to authenticated using (recipient_user_id = auth.uid());
create policy notifications_mark_read on notify.notifications for update to authenticated
  using (recipient_user_id = auth.uid()) with check (recipient_user_id = auth.uid());
grant update (read_at) on notify.notifications to authenticated;
create policy tasks_select on work.tasks for select to authenticated using (
  assignee_employee_id = (select authz.current_employee_id())
  or (select authz.has_global('work.task.read'))
  or assignee_employee_id = any((select authz.employee_ids('work.task.read'))::uuid[])
);

-- Authorization data: users see their own grants; admins see all.
create policy user_roles_select on authz.user_roles for select to authenticated using (
  user_id = auth.uid() or (select authz.has_permission('admin.role.read'))
);
create policy roles_select on authz.roles for select to authenticated using (true);
create policy role_perms_select on authz.role_permissions for select to authenticated using ((select authz.has_permission('admin.role.read')));
create policy permissions_select on authz.permissions for select to authenticated using (true);

-- Reference data readable by any active user
create policy gov_select on core.governorates for select to authenticated using ((select authz.is_active_user()));
create policy territories_select on core.territories for select to authenticated using ((select authz.is_active_user()));
create policy specialties_select on crm.specialties for select to authenticated using ((select authz.is_active_user()));

-- Authz helper functions are callable by the policies (and harmless: read-only, caller-scoped).
grant usage on schema authz to authenticated;
grant execute on all functions in schema authz to authenticated;
-- But domain functions that write are not exposed outside api.*
revoke execute on function core.next_document_no(text, date) from public;
