-- Honest OS migration: core organisation
-- Origin: docs/database/draft/10_schema_draft.sql (Phase 1, validated). See docs/DATABASE.md.

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
  email             extensions.citext,
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
