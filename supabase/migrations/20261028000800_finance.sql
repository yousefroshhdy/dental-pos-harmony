-- Honest OS migration: finance / receivables
-- Origin: docs/database/draft/10_schema_draft.sql (Phase 1, validated). See docs/DATABASE.md.

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
