-- Honest OS migration: crm, tasks, field visits
-- Origin: docs/database/draft/10_schema_draft.sql (Phase 1, validated). See docs/DATABASE.md.

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
  email              extensions.citext,
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
create index idx_customers_name_trgm on crm.customers using gin (display_name extensions.gin_trgm_ops);
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
  email       extensions.citext,
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
