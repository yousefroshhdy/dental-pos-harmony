-- Honest OS migration: catalog
-- Origin: docs/database/draft/10_schema_draft.sql (Phase 1, validated). See docs/DATABASE.md.

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
