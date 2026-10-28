-- Honest OS migration: sales orders
-- Origin: docs/database/draft/10_schema_draft.sql (Phase 1, validated). See docs/DATABASE.md.

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
