-- Honest OS migration: inventory ledger
-- Origin: docs/database/draft/10_schema_draft.sql (Phase 1, validated). See docs/DATABASE.md.

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
