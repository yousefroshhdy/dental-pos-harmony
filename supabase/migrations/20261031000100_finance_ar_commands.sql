-- Honest OS migration: Phase 4 — receivables core (AR) commands.
--
-- Contents
--   0. Expand-only schema additions (idempotency keys, credit-note lines, payment status
--      detail, collection-task links) and a stricter invoice immutability guard
--   1. Private helpers: invoice balance, ledger posting, invoice status refresh,
--      credit-note amounts
--   2. api.issue_invoice            invoice the uninvoiced fulfilled quantity of an order
--   3. api.issue_credit_note        always through the 'finance.credit_note' workflow; the
--                                   decision hook issues the note and posts the ledger
--   4. api.record_payment / confirm_payment / reject_payment / reverse_payment
--   5. api.allocate_payment (manual or FIFO) / api.reverse_allocation
--   6. api.update_collection_task   promise-to-pay, escalate, close
--   7. service.finance_overdue_scan cron: one collection task (+ rep work task) per newly
--                                   overdue invoice, outbox 'invoice.overdue'
--   8. Privileges
--
-- Rules (CLAUDE.md rule 7): money moves only through these commands, each in one
-- transaction; finance.customer_ledger, finance.payment_allocations, finance.credit_notes and
-- finance.invoice_items are append-only (corrections are reversal rows); every amount is
-- computed here from server data. The client sends ids, quantities, a payment amount it
-- received, or a goodwill credit amount — never prices, discounts, taxes or totals.
--
-- Rounding: numeric round() in PostgreSQL rounds half away from zero (TESTING.md §2.3).
-- VAT: per line, at the order line's rate (the product's rate, which defaults to the
-- sales.default_vat_pct setting, D-12), on the line amount after discount.
-- Business day: core.business_date() (Africa/Cairo), never current_date.

-- ---------------------------------------------------------------------------
-- 0. Schema additions (expand only)
-- ---------------------------------------------------------------------------
alter table finance.invoices add column if not exists idempotency_key text unique;

-- Gross line amount before discount (unit_price × quantity). Lets totals be checked per line.
alter table finance.invoice_items add column if not exists line_subtotal core.money;
alter table finance.invoice_items add constraint invoice_items_line_total_check
  check (line_subtotal is null or line_total = line_subtotal - discount + tax_amount);
create index if not exists idx_invoice_items_invoice on finance.invoice_items (invoice_id);
create index if not exists idx_invoice_items_order_item on finance.invoice_items (order_item_id) where order_item_id is not null;

alter table finance.credit_notes add column if not exists idempotency_key text unique;
create index if not exists idx_credit_notes_invoice on finance.credit_notes (invoice_id);

-- Lines of a quantity-based credit note (an amount-based one has none). Append-only.
create table if not exists finance.credit_note_items (
  id              uuid primary key default gen_random_uuid(),
  credit_note_id  uuid not null references finance.credit_notes(id),
  invoice_item_id uuid not null references finance.invoice_items(id),
  quantity        int not null check (quantity > 0),
  amount          core.money not null check (amount >= 0),       -- excluding VAT
  tax_amount      core.money not null check (tax_amount >= 0)
);
create index if not exists idx_credit_note_items_note on finance.credit_note_items (credit_note_id);
create index if not exists idx_credit_note_items_item on finance.credit_note_items (invoice_item_id);
create trigger trg_credit_note_items_append_only before update or delete on finance.credit_note_items
  for each row execute function core.forbid_mutation();
alter table finance.credit_note_items enable row level security;
grant select on finance.credit_note_items to authenticated;

alter table finance.payments add column if not exists status_reason text;
alter table finance.payments add column if not exists reversed_at timestamptz;
alter table finance.payments add column if not exists reversed_by uuid references auth.users(id);
create index if not exists idx_payments_status on finance.payments (status) where status = 'pending_verification';

alter table finance.payment_allocations add column if not exists idempotency_key text;
alter table finance.payment_allocations add column if not exists reason text;
create index if not exists idx_allocations_idempotency on finance.payment_allocations (idempotency_key)
  where idempotency_key is not null;

alter table finance.collection_tasks add column if not exists work_task_id uuid references work.tasks(id);
alter table finance.collection_tasks add column if not exists updated_at timestamptz not null default now();
alter table finance.collection_tasks add column if not exists updated_by uuid references auth.users(id);
-- The overdue scan creates exactly one collection task per invoice.
create unique index if not exists uq_collection_task_invoice on finance.collection_tasks (invoice_id)
  where invoice_id is not null;
create index if not exists idx_collection_tasks_assignee on finance.collection_tasks (assignee_employee_id, status);
create trigger trg_audit after insert or update or delete on finance.collection_tasks
  for each row execute function audit.log_change();
create trigger trg_audit after insert on finance.credit_notes
  for each row execute function audit.log_change();

-- Issued invoices are immutable except status and the ETA fields (status follows payments
-- and credit notes; eta_* are written by a future e-invoicing integration, D-02).
-- Starts from 20261028000800_finance.sql; adds order, dates, currency and provenance.
create or replace function finance.guard_invoice_update() returns trigger
language plpgsql set search_path = '' as $$
begin
  if (new.invoice_no, new.order_id, new.customer_id, new.issue_date, new.due_date, new.currency,
      new.subtotal, new.discount_total, new.tax_total, new.total, new.created_by, new.created_at,
      new.idempotency_key)
     is distinct from
     (old.invoice_no, old.order_id, old.customer_id, old.issue_date, old.due_date, old.currency,
      old.subtotal, old.discount_total, old.tax_total, old.total, old.created_by, old.created_at,
      old.idempotency_key) then
    raise exception 'INVOICE_IMMUTABLE: issue a credit note instead' using errcode = 'P0001';
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- 1. Private helpers (definer; never client-callable — revoked in §8)
-- ---------------------------------------------------------------------------
-- What is still owed on one invoice. open = total − net allocations − credit notes (incl. VAT).
create or replace function finance.invoice_balance(p_invoice_id uuid,
  out o_total numeric, out o_allocated numeric, out o_credited numeric, out o_open numeric)
language sql stable security definer set search_path = '' as $$
  select i.total,
         a.s, c.s, (i.total - a.s - c.s)
  from finance.invoices i
  cross join lateral (select coalesce(sum(pa.amount), 0)::numeric(14,2) as s
                      from finance.payment_allocations pa where pa.invoice_id = i.id) a
  cross join lateral (select coalesce(sum(cn.amount + cn.tax_amount), 0)::numeric(14,2) as s
                      from finance.credit_notes cn where cn.invoice_id = i.id) c
  where i.id = p_invoice_id
$$;

-- Unallocated part of a payment (net of allocation reversals).
create or replace function finance.payment_unallocated(p_payment_id uuid) returns numeric
language sql stable security definer set search_path = '' as $$
  select (p.amount - coalesce((select sum(pa.amount) from finance.payment_allocations pa
                               where pa.payment_id = p.id), 0))::numeric(14,2)
  from finance.payments p where p.id = p_payment_id
$$;

-- One AR ledger row. A zero amount posts nothing (the ledger CHECK forbids 0).
create or replace function finance.post_ledger(p_customer_id uuid, p_entry_type text, p_amount numeric,
                                               p_source_table text, p_source_id uuid)
returns void language sql security definer set search_path = '' as $$
  insert into finance.customer_ledger (customer_id, entry_type, amount, source_table, source_id, posted_by)
  select p_customer_id, p_entry_type, p_amount, p_source_table, p_source_id, auth.uid()
  where p_amount <> 0
$$;

-- Close the collection work of a settled invoice, or reopen it when a reversal makes a
-- past-due invoice owed again (bounced cheque). The linked rep task follows.
create or replace function finance.sync_collection_tasks(p_invoice_id uuid, p_open numeric, p_due_date date)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_open <= 0 then
    update work.tasks w set status = 'done', completed_at = now(), outcome = coalesce(w.outcome, 'Invoice settled')
    from finance.collection_tasks t
    where t.invoice_id = p_invoice_id and t.status in ('open','promised','escalated')
      and w.id = t.work_task_id and w.status = 'open';
    update finance.collection_tasks
       set status = 'collected', closed_at = now(), updated_at = now(), updated_by = auth.uid(),
           outcome = coalesce(outcome, 'Invoice settled')
     where invoice_id = p_invoice_id and status in ('open','promised','escalated');
  elsif p_due_date < core.business_date() then
    update work.tasks w set status = 'open', completed_at = null, outcome = null
    from finance.collection_tasks t
    where t.invoice_id = p_invoice_id and t.status = 'collected'
      and w.id = t.work_task_id and w.status = 'done';
    update finance.collection_tasks
       set status = 'open', closed_at = null, updated_at = now(), updated_by = auth.uid(),
           outcome = 'Reopened: invoice owed again'
     where invoice_id = p_invoice_id and status = 'collected';
  end if;
end $$;

-- Invoice status from its balance: paid / credited when nothing is open, partially_paid once
-- something was allocated, issued otherwise. written_off is final.
create or replace function finance.refresh_invoice_status(p_invoice_id uuid) returns text
language plpgsql security definer set search_path = '' as $$
declare v_inv finance.invoices%rowtype; b record; v_status text;
begin
  select * into v_inv from finance.invoices where id = p_invoice_id;
  if not found or v_inv.status = 'written_off' then return v_inv.status; end if;
  select * into b from finance.invoice_balance(p_invoice_id);
  v_status := case when b.o_open <= 0 and v_inv.total > 0 and b.o_credited >= v_inv.total then 'credited'
                   when b.o_open <= 0 then 'paid'
                   when b.o_allocated > 0 then 'partially_paid'
                   else 'issued' end;
  if v_status is distinct from v_inv.status then
    update finance.invoices set status = v_status where id = p_invoice_id;
  end if;
  perform finance.sync_collection_tasks(p_invoice_id, b.o_open, v_inv.due_date);
  return v_status;
end $$;

-- Amounts of a credit note, computed from the invoice. Exactly one of p_lines / p_amount.
--   p_lines  [{invoice_item_id, quantity}]: per line, the line's net amount pro rata, VAT at the
--            line's rate; the last remaining quantity of a line takes the exact remainder so a
--            full credit equals the line to the cent.
--   p_amount a goodwill amount excluding VAT; VAT at the invoice's effective rate.
-- Raises VALIDATION / CREDIT_QTY_EXCEEDED / EXCEEDS_INVOICE_OPEN_AMOUNT. Caller locks the invoice.
create or replace function finance.credit_note_amounts(p_invoice_id uuid, p_lines jsonb, p_amount numeric)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_inv finance.invoices%rowtype; b record;
  v_el jsonb; v_item_id uuid; v_q int; v_it record; v_prev record;
  v_net_line numeric; v_amt numeric; v_tax numeric;
  v_sum_amt numeric := 0; v_sum_tax numeric := 0; v_out jsonb := '[]'::jsonb; v_seen uuid[] := '{}';
  v_base numeric; v_has_lines boolean;
begin
  select * into v_inv from finance.invoices where id = p_invoice_id;
  if not found then raise exception 'NOT_FOUND: invoice %', p_invoice_id using errcode = 'P0002'; end if;
  v_has_lines := case when p_lines is null or jsonb_typeof(p_lines) <> 'array' then false
                      else jsonb_array_length(p_lines) > 0 end;
  if p_lines is not null and jsonb_typeof(p_lines) not in ('array','null') then
    raise exception 'VALIDATION: credit lines must be a list' using errcode = 'P0001';
  end if;
  if v_has_lines = (p_amount is not null) then
    raise exception 'VALIDATION: give either credit lines or an amount' using errcode = 'P0001';
  end if;

  if p_amount is not null then
    if p_amount <= 0 or p_amount <> round(p_amount, 2) then
      raise exception 'VALIDATION: amount must be positive with at most 2 decimals' using errcode = 'P0001';
    end if;
    v_base := v_inv.subtotal - v_inv.discount_total;
    if v_base <= 0 then raise exception 'VALIDATION: invoice has no taxable amount to credit' using errcode = 'P0001'; end if;
    v_sum_amt := p_amount;
    v_sum_tax := round(p_amount * v_inv.tax_total / v_base, 2);
  else
    if jsonb_array_length(p_lines) > 500 then raise exception 'VALIDATION: too many lines' using errcode = 'P0001'; end if;
    for v_el in select * from jsonb_array_elements(p_lines) loop
      if jsonb_typeof(v_el) <> 'object'
         or exists (select 1 from jsonb_object_keys(v_el) k where k not in ('invoice_item_id','quantity')) then
        raise exception 'VALIDATION: a credit line has only invoice_item_id and quantity' using errcode = 'P0001';
      end if;
      v_item_id := core.try_cast_uuid(v_el ->> 'invoice_item_id');
      if v_item_id is null or jsonb_typeof(v_el -> 'quantity') <> 'number'
         or (v_el ->> 'quantity')::numeric <> trunc((v_el ->> 'quantity')::numeric)
         or (v_el ->> 'quantity')::numeric <= 0 then
        raise exception 'VALIDATION: invalid credit line' using errcode = 'P0001';
      end if;
      if v_item_id = any(v_seen) then raise exception 'VALIDATION: duplicate credit line' using errcode = 'P0001'; end if;
      v_seen := v_seen || v_item_id;
      v_q := (v_el ->> 'quantity')::int;
      select * into v_it from finance.invoice_items where id = v_item_id and invoice_id = p_invoice_id;
      if not found then raise exception 'VALIDATION: line % is not on this invoice', v_item_id using errcode = 'P0001'; end if;
      select coalesce(sum(ci.quantity), 0)::int as q, coalesce(sum(ci.amount), 0) as amt, coalesce(sum(ci.tax_amount), 0) as tax
        into v_prev from finance.credit_note_items ci where ci.invoice_item_id = v_item_id;
      if v_prev.q + v_q > v_it.quantity then
        raise exception 'CREDIT_QTY_EXCEEDED: % of % already credited on this line', v_prev.q, v_it.quantity using errcode = 'P0001';
      end if;
      v_net_line := coalesce(v_it.line_subtotal, round(v_it.unit_price * v_it.quantity, 2)) - v_it.discount;
      if v_prev.q + v_q = v_it.quantity then
        v_amt := greatest(v_net_line - v_prev.amt, 0);
        v_tax := greatest(v_it.tax_amount - v_prev.tax, 0);
      else
        v_amt := round(v_net_line * v_q / v_it.quantity, 2);
        v_tax := round(v_amt * v_it.tax_rate_pct / 100, 2);
      end if;
      v_sum_amt := v_sum_amt + v_amt; v_sum_tax := v_sum_tax + v_tax;
      v_out := v_out || jsonb_build_object('invoice_item_id', v_item_id, 'quantity', v_q, 'amount', v_amt, 'tax_amount', v_tax);
    end loop;
  end if;

  if v_sum_amt + v_sum_tax <= 0 then raise exception 'VALIDATION: nothing to credit' using errcode = 'P0001'; end if;
  select * into b from finance.invoice_balance(p_invoice_id);
  if v_sum_amt + v_sum_tax > b.o_open then
    raise exception 'EXCEEDS_INVOICE_OPEN_AMOUNT: credit % exceeds the open amount %', v_sum_amt + v_sum_tax, b.o_open
      using errcode = 'P0001';
  end if;
  return jsonb_build_object('amount', v_sum_amt, 'tax_amount', v_sum_tax, 'total', v_sum_amt + v_sum_tax,
                            'lines', case when p_amount is null then v_out end);
end $$;

-- ---------------------------------------------------------------------------
-- 2. Issue an invoice for an order's fulfilled, not yet invoiced quantity
-- ---------------------------------------------------------------------------
create or replace function api.issue_invoice(p_order_id uuid, p_idempotency_key text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_key text := nullif(btrim(p_idempotency_key), '');
  v_existing finance.invoices%rowtype;
  v_order sales.orders%rowtype;
  v_it record;
  v_today date := core.business_date();
  v_id uuid := gen_random_uuid();
  v_no text; v_q int; v_gross numeric; v_disc numeric; v_tax numeric;
  v_sub numeric := 0; v_dsum numeric := 0; v_tsum numeric := 0; v_total numeric;
  v_lines jsonb := '[]'::jsonb; v_left int; v_order_status text;
begin
  perform authz.require('finance.invoice.issue');
  if v_key is null or length(v_key) > 100 then
    raise exception 'VALIDATION: idempotency key is required' using errcode = 'P0001';
  end if;

  select * into v_order from sales.orders where id = p_order_id for update;
  if not found then raise exception 'NOT_FOUND: order %', p_order_id using errcode = 'P0002'; end if;
  if not authz.customer_in_scope('finance.invoice.issue', v_order.customer_id) then
    raise exception 'PERMISSION_DENIED: customer not in your scope' using errcode = '42501';
  end if;

  -- Replay (checked under the order lock, so a concurrent retry sees the first result).
  select * into v_existing from finance.invoices where idempotency_key = v_key;
  if found then
    if v_existing.order_id is distinct from p_order_id then
      raise exception 'IDEMPOTENCY_CONFLICT: key was used for another order' using errcode = 'P0001';
    end if;
    return jsonb_build_object('invoice_id', v_existing.id, 'invoice_no', v_existing.invoice_no,
                              'total', v_existing.total, 'due_date', v_existing.due_date,
                              'status', v_existing.status, 'eta_status', v_existing.eta_status,
                              'order_status', v_order.status, 'replayed', true);
  end if;

  if v_order.status not in ('fulfilled','partially_fulfilled') then
    raise exception 'INVALID_STATE: order is %', v_order.status using errcode = 'P0001';
  end if;

  for v_it in
    select oi.id, oi.line_no, oi.variant_id, oi.quantity, oi.fulfilled_qty, oi.list_price,
           oi.applied_discount_pct, oi.tax_rate_pct, oi.line_discount, oi.line_tax,
           coalesce(nullif(btrim(v.name_en), ''), v.sku) as description,
           coalesce(ii.q, 0)::int as invoiced_qty, coalesce(ii.disc, 0) as invoiced_disc, coalesce(ii.tax, 0) as invoiced_tax
    from sales.order_items oi
    join catalog.product_variants v on v.id = oi.variant_id
    left join lateral (select sum(x.quantity) as q, sum(x.discount) as disc, sum(x.tax_amount) as tax
                       from finance.invoice_items x where x.order_item_id = oi.id) ii on true
    where oi.order_id = p_order_id
    order by oi.line_no
  loop
    v_q := v_it.fulfilled_qty - v_it.invoiced_qty;
    continue when v_q <= 0;
    v_gross := round(v_it.list_price * v_q, 2);
    if v_it.invoiced_qty + v_q = v_it.quantity then
      -- Last part of the line: take the order's exact remainder, so Σ invoices = order line.
      v_disc := greatest(v_it.line_discount - v_it.invoiced_disc, 0);
      v_tax  := greatest(v_it.line_tax - v_it.invoiced_tax, 0);
    else
      v_disc := round(v_it.list_price * v_q * v_it.applied_discount_pct / 100, 2);
      v_tax  := round((v_gross - v_disc) * v_it.tax_rate_pct / 100, 2);
    end if;
    v_sub := v_sub + v_gross; v_dsum := v_dsum + v_disc; v_tsum := v_tsum + v_tax;
    v_lines := v_lines || jsonb_build_object(
      'order_item_id', v_it.id, 'variant_id', v_it.variant_id, 'description', v_it.description,
      'quantity', v_q, 'unit_price', v_it.list_price, 'line_subtotal', v_gross, 'discount', v_disc,
      'tax_rate_pct', v_it.tax_rate_pct, 'tax_amount', v_tax, 'line_total', v_gross - v_disc + v_tax);
  end loop;

  if jsonb_array_length(v_lines) = 0 then
    raise exception 'NOTHING_TO_INVOICE: every fulfilled quantity is already invoiced' using errcode = 'P0001';
  end if;
  v_total := v_sub - v_dsum + v_tsum;

  -- Gapless: the number is taken inside this transaction (row lock until commit).
  v_no := core.next_document_no('INV', v_today);
  insert into finance.invoices (id, invoice_no, order_id, customer_id, issue_date, due_date, status, currency,
                                subtotal, discount_total, tax_total, total, created_by, idempotency_key)
  values (v_id, v_no, p_order_id, v_order.customer_id, v_today, v_today + v_order.payment_terms_days,
          case when v_total = 0 then 'paid' else 'issued' end, v_order.currency,
          v_sub, v_dsum, v_tsum, v_total, auth.uid(), v_key);

  insert into finance.invoice_items (invoice_id, order_item_id, variant_id, description, quantity, unit_price,
                                     discount, tax_rate_pct, tax_amount, line_total, line_subtotal)
  select v_id, l.order_item_id, l.variant_id, l.description, l.quantity, l.unit_price,
         l.discount, l.tax_rate_pct, l.tax_amount, l.line_total, l.line_subtotal
  from jsonb_to_recordset(v_lines) as l(order_item_id uuid, variant_id uuid, description text, quantity int,
                                        unit_price numeric, line_subtotal numeric, discount numeric,
                                        tax_rate_pct numeric, tax_amount numeric, line_total numeric);

  perform finance.post_ledger(v_order.customer_id, 'invoice', v_total, 'finance.invoices', v_id);

  -- The order is 'invoiced' once everything ordered was fulfilled and invoiced. A partially
  -- fulfilled order stays open for the rest of its fulfilment.
  v_order_status := v_order.status;
  select count(*) into v_left
  from sales.order_items oi
  where oi.order_id = p_order_id
    and oi.quantity > coalesce((select sum(x.quantity) from finance.invoice_items x where x.order_item_id = oi.id), 0);
  if v_order.status = 'fulfilled' and v_left = 0 then
    perform sales.change_order_status(p_order_id, 'fulfilled', 'invoiced', v_no,
                                      jsonb_build_object('invoice_id', v_id, 'invoice_no', v_no));
    v_order_status := 'invoiced';
  end if;

  perform crm._add_activity(v_order.customer_id, authz.current_employee_id(), 'invoice',
                            'Invoice ' || v_no || ' issued', 'finance.invoices', v_id);
  perform sales.notify_order_rep(p_order_id, 'invoice.issued', 'Invoice issued: ' || v_no);
  insert into integration.outbox (event_type, aggregate_type, aggregate_id, payload)
  values ('invoice.issued', 'finance.invoice', v_id,
          jsonb_build_object('invoice_id', v_id, 'invoice_no', v_no, 'order_id', p_order_id,
                             'order_no', v_order.order_no, 'customer_id', v_order.customer_id,
                             'issue_date', v_today, 'due_date', v_today + v_order.payment_terms_days,
                             'subtotal', v_sub, 'discount_total', v_dsum, 'tax_total', v_tsum,
                             'total', v_total, 'currency', v_order.currency));

  return jsonb_build_object('invoice_id', v_id, 'invoice_no', v_no, 'subtotal', v_sub, 'discount_total', v_dsum,
                            'tax_total', v_tsum, 'total', v_total, 'due_date', v_today + v_order.payment_terms_days,
                            'status', case when v_total = 0 then 'paid' else 'issued' end, 'eta_status', null,
                            'lines', jsonb_array_length(v_lines), 'order_status', v_order_status, 'replayed', false);
end $$;

-- ---------------------------------------------------------------------------
-- 3. Credit notes (workflow 'finance.credit_note'; seeded with one approver stage)
-- ---------------------------------------------------------------------------
-- Issue the note once the workflow approves it: re-validates against the invoice as it is now.
create or replace function wf.on_decided_finance_credit_note(p_request_id uuid, p_approved boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare
  r wf.approval_requests%rowtype; v_inv finance.invoices%rowtype; v_calc jsonb; v_id uuid; v_no text;
  v_today date := core.business_date();
begin
  select * into r from wf.approval_requests where id = p_request_id;
  if not p_approved then return; end if;
  v_id := r.entity_id;
  if exists (select 1 from finance.credit_notes where id = v_id) then return; end if;

  select * into v_inv from finance.invoices where id = core.jsonb_uuid(r.payload, 'invoice_id') for update;
  if not found then raise exception 'NOT_FOUND: invoice of credit note request' using errcode = 'P0002'; end if;
  v_calc := finance.credit_note_amounts(v_inv.id,
              case when r.payload ->> 'mode' = 'lines'
                   then (select jsonb_agg(jsonb_build_object('invoice_item_id', l ->> 'invoice_item_id',
                                                             'quantity', (l ->> 'quantity')::int))
                         from jsonb_array_elements(r.payload -> 'lines') l) end,
              case when r.payload ->> 'mode' = 'amount' then (r.payload ->> 'amount')::numeric end);
  if (v_calc ->> 'total')::numeric <> (r.payload ->> 'total')::numeric then
    raise exception 'INVALID_STATE: the invoice changed since this credit note was requested; reject and request again'
      using errcode = 'P0001';
  end if;

  v_no := core.next_document_no('CN', v_today);
  insert into finance.credit_notes (id, credit_no, invoice_id, customer_id, reason, amount, tax_amount, issue_date,
                                    approval_request_id, created_by, idempotency_key)
  values (v_id, v_no, v_inv.id, v_inv.customer_id, r.payload ->> 'reason', (v_calc ->> 'amount')::numeric,
          (v_calc ->> 'tax_amount')::numeric, v_today, r.id, r.requested_by, r.payload ->> 'idempotency_key');
  if v_calc -> 'lines' is not null and jsonb_typeof(v_calc -> 'lines') = 'array' then
    insert into finance.credit_note_items (credit_note_id, invoice_item_id, quantity, amount, tax_amount)
    select v_id, (l ->> 'invoice_item_id')::uuid, (l ->> 'quantity')::int, (l ->> 'amount')::numeric,
           (l ->> 'tax_amount')::numeric
    from jsonb_array_elements(v_calc -> 'lines') l;
  end if;

  perform finance.post_ledger(v_inv.customer_id, 'credit_note', -(v_calc ->> 'total')::numeric, 'finance.credit_notes', v_id);
  perform finance.refresh_invoice_status(v_inv.id);
  perform crm._add_activity(v_inv.customer_id, authz.current_employee_id(), 'invoice',
                            'Credit note ' || v_no || ' on ' || v_inv.invoice_no, 'finance.credit_notes', v_id);
  insert into integration.outbox (event_type, aggregate_type, aggregate_id, payload)
  values ('credit_note.issued', 'finance.credit_note', v_id,
          jsonb_build_object('credit_note_id', v_id, 'credit_no', v_no, 'invoice_id', v_inv.id,
                             'invoice_no', v_inv.invoice_no, 'customer_id', v_inv.customer_id,
                             'amount', (v_calc ->> 'amount')::numeric, 'tax_amount', (v_calc ->> 'tax_amount')::numeric,
                             'total', (v_calc ->> 'total')::numeric, 'issue_date', v_today, 'currency', v_inv.currency));
end $$;

-- Final-decision hooks: starts from 20261029000300_orders_inventory_workflow.sql §2.2 and adds
-- 'finance.credit_note'. Still a hard-coded CASE (configuration can never name a function).
create or replace function wf.dispatch_decision_hook(p_code text, p_request_id uuid, p_approved boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  case p_code
    when 'sales.order.discount'  then perform wf.on_decided_sales_order_discount(p_request_id, p_approved);
    when 'inventory.adjustment'  then perform wf.on_decided_inventory_adjustment(p_request_id, p_approved);
    when 'sales.order.cancel'    then perform wf.on_decided_sales_order_cancel(p_request_id, p_approved);
    when 'crm.customer.reassign' then perform wf.on_decided_crm_customer_reassign(p_request_id, p_approved);
    when 'field.visit.exception' then perform wf.on_decided_field_visit_exception(p_request_id, p_approved);
    when 'finance.credit_note'   then perform wf.on_decided_finance_credit_note(p_request_id, p_approved);
    else null;                                -- workflows without side effects
  end case;
end $$;

-- Request a credit note. The amounts are computed here; the note itself is issued by the
-- workflow hook when approved (immediately if an admin configures an auto-approve rule).
-- The requester can never approve their own request (api.decide_approval, SELF_APPROVAL).
create or replace function api.issue_credit_note(p_invoice_id uuid, p_lines jsonb default null, p_amount numeric default null,
                                                 p_reason text default null, p_idempotency_key text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_key text := nullif(btrim(p_idempotency_key), '');
  v_reason text := nullif(btrim(p_reason), '');
  v_cn finance.credit_notes%rowtype; v_req wf.approval_requests%rowtype;
  v_inv finance.invoices%rowtype; v_calc jsonb; v_id uuid := gen_random_uuid(); v_request uuid;
  v_territory uuid; v_status text;
begin
  perform authz.require('finance.credit_note.issue');
  if v_key is null or length(v_key) > 100 then
    raise exception 'VALIDATION: idempotency key is required' using errcode = 'P0001';
  end if;
  if v_reason is null or length(v_reason) < 3 then
    raise exception 'REASON_REQUIRED: a credit note needs a reason' using errcode = 'P0001';
  end if;

  select * into v_inv from finance.invoices where id = p_invoice_id for update;
  if not found then raise exception 'NOT_FOUND: invoice %', p_invoice_id using errcode = 'P0002'; end if;
  if not authz.customer_in_scope('finance.credit_note.issue', v_inv.customer_id) then
    raise exception 'PERMISSION_DENIED: customer not in your scope' using errcode = '42501';
  end if;

  -- Replays: an issued note, or the request that is (or was) deciding it.
  select * into v_cn from finance.credit_notes where idempotency_key = v_key;
  if found then
    if v_cn.invoice_id <> p_invoice_id then
      raise exception 'IDEMPOTENCY_CONFLICT: key was used for another invoice' using errcode = 'P0001';
    end if;
    return jsonb_build_object('credit_note_id', v_cn.id, 'credit_no', v_cn.credit_no, 'status', 'issued',
                              'approval_request_id', v_cn.approval_request_id,
                              'total', v_cn.amount + v_cn.tax_amount, 'replayed', true);
  end if;
  select r.* into v_req from wf.approval_requests r join wf.workflow_definitions d on d.id = r.definition_id
  where d.code = 'finance.credit_note' and r.payload ->> 'idempotency_key' = v_key
  order by r.created_at desc limit 1;
  if found then
    if core.jsonb_uuid(v_req.payload, 'invoice_id') is distinct from p_invoice_id then
      raise exception 'IDEMPOTENCY_CONFLICT: key was used for another invoice' using errcode = 'P0001';
    end if;
    return jsonb_build_object('credit_note_id', v_req.entity_id, 'status',
                              case v_req.status when 'pending' then 'pending_approval' else v_req.status end,
                              'approval_request_id', v_req.id, 'total', (v_req.payload ->> 'total')::numeric,
                              'replayed', true);
  end if;

  if v_inv.status = 'written_off' then
    raise exception 'INVALID_STATE: invoice is %', v_inv.status using errcode = 'P0001';
  end if;
  v_calc := finance.credit_note_amounts(p_invoice_id, p_lines, p_amount);
  select territory_id into v_territory from crm.customers where id = v_inv.customer_id;

  v_request := wf.create_request('finance.credit_note', 'finance.credit_note', v_id,
    jsonb_build_object('credit_note_id', v_id, 'invoice_id', p_invoice_id, 'invoice_no', v_inv.invoice_no,
                       'customer_id', v_inv.customer_id, 'territory_id', v_territory,
                       'mode', case when p_amount is not null then 'amount' else 'lines' end,
                       'amount', (v_calc ->> 'amount')::numeric, 'tax_amount', (v_calc ->> 'tax_amount')::numeric,
                       'total', (v_calc ->> 'total')::numeric, 'lines', v_calc -> 'lines',
                       'reason', v_reason, 'idempotency_key', v_key,
                       'limit_metric', (v_calc ->> 'total')::numeric),
    null);
  v_status := case when exists (select 1 from finance.credit_notes where id = v_id) then 'issued' else 'pending_approval' end;
  return jsonb_build_object('credit_note_id', v_id, 'status', v_status, 'approval_request_id', v_request,
                            'credit_no', (select credit_no from finance.credit_notes where id = v_id),
                            'amount', (v_calc ->> 'amount')::numeric, 'tax_amount', (v_calc ->> 'tax_amount')::numeric,
                            'total', (v_calc ->> 'total')::numeric, 'replayed', false);
end $$;

-- ---------------------------------------------------------------------------
-- 4. Payments: record → (confirm | reject); confirmed → reverse (e.g. bounced cheque)
-- Only confirmed payments reach the AR ledger.
-- ---------------------------------------------------------------------------
create or replace function api.record_payment(p_customer_id uuid, p_amount numeric, p_method text,
                                              p_reference text default null, p_received_at timestamptz default null,
                                              p_client_ref uuid default null, p_cheque_due_date date default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_emp uuid := authz.current_employee_id();
  v_existing finance.payments%rowtype;
  v_ref text := nullif(btrim(p_reference), '');
  v_at timestamptz := coalesce(p_received_at, now());
  v_id uuid := gen_random_uuid(); v_no text; v_confirm boolean;
begin
  perform authz.require('finance.payment.record');
  if p_client_ref is null then
    raise exception 'VALIDATION: client reference is required' using errcode = 'P0001';
  end if;

  select * into v_existing from finance.payments where client_ref = p_client_ref;
  if found then
    if v_existing.customer_id <> p_customer_id or v_existing.amount <> p_amount or v_existing.method <> p_method then
      raise exception 'IDEMPOTENCY_CONFLICT: client reference was used for another payment' using errcode = 'P0001';
    end if;
    return jsonb_build_object('payment_id', v_existing.id, 'payment_no', v_existing.payment_no,
                              'status', v_existing.status, 'replayed', true);
  end if;

  if not exists (select 1 from crm.customers where id = p_customer_id) then
    raise exception 'NOT_FOUND: customer' using errcode = 'P0002';
  end if;
  if not authz.customer_in_scope('finance.payment.record', p_customer_id) then
    raise exception 'PERMISSION_DENIED: customer not in your scope' using errcode = '42501';
  end if;
  if p_amount is null or p_amount <= 0 or p_amount <> round(p_amount, 2) or p_amount > 100000000 then
    raise exception 'VALIDATION: amount must be positive with at most 2 decimals' using errcode = 'P0001';
  end if;
  -- Paymob methods arrive through the webhook integration (Phase 6), never by hand.
  if p_method is null or p_method not in ('cash','cheque','bank_transfer','instapay','other') then
    raise exception 'VALIDATION: unsupported payment method' using errcode = 'P0001';
  end if;
  if p_method = 'cheque' and (p_cheque_due_date is null or v_ref is null) then
    raise exception 'VALIDATION: a cheque needs its number and due date' using errcode = 'P0001';
  end if;
  if p_method <> 'cheque' and p_cheque_due_date is not null then
    raise exception 'VALIDATION: only cheques have a due date' using errcode = 'P0001';
  end if;
  if v_ref is not null and length(v_ref) > 100 then
    raise exception 'VALIDATION: reference is too long' using errcode = 'P0001';
  end if;
  if v_at > now() + interval '10 minutes' then
    raise exception 'VALIDATION: received_at is in the future' using errcode = 'P0001';
  end if;

  -- Finance may confirm a non-cheque payment as it records it; a cheque waits until it clears.
  v_confirm := p_method <> 'cheque' and authz.customer_in_scope('finance.payment.confirm', p_customer_id);

  v_no := core.next_document_no('PAY', core.business_date());
  insert into finance.payments (id, payment_no, client_ref, customer_id, collected_by, method, amount, received_at,
                                reference, cheque_due_date, status, confirmed_by, confirmed_at, created_by)
  values (v_id, v_no, p_client_ref, p_customer_id, v_emp, p_method, p_amount, v_at, v_ref, p_cheque_due_date,
          case when v_confirm then 'confirmed' else 'pending_verification' end,
          case when v_confirm then auth.uid() end, case when v_confirm then now() end, auth.uid());

  perform crm._add_activity(p_customer_id, v_emp, 'payment', 'Payment ' || v_no || ' recorded (' || p_method || ')',
                            'finance.payments', v_id);
  insert into integration.outbox (event_type, aggregate_type, aggregate_id, payload)
  values ('payment.recorded', 'finance.payment', v_id,
          jsonb_build_object('payment_id', v_id, 'payment_no', v_no, 'customer_id', p_customer_id,
                             'method', p_method, 'amount', p_amount, 'currency', 'EGP', 'collected_by', v_emp,
                             'status', case when v_confirm then 'confirmed' else 'pending_verification' end));
  if v_confirm then
    perform finance.post_ledger(p_customer_id, 'payment', -p_amount, 'finance.payments', v_id);
    insert into integration.outbox (event_type, aggregate_type, aggregate_id, payload)
    values ('payment.confirmed', 'finance.payment', v_id,
            jsonb_build_object('payment_id', v_id, 'payment_no', v_no, 'customer_id', p_customer_id,
                               'amount', p_amount, 'currency', 'EGP'));
  end if;

  return jsonb_build_object('payment_id', v_id, 'payment_no', v_no,
                            'status', case when v_confirm then 'confirmed' else 'pending_verification' end,
                            'replayed', false);
end $$;

create or replace function api.confirm_payment(p_payment_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_p finance.payments%rowtype;
begin
  perform authz.require('finance.payment.confirm');
  select * into v_p from finance.payments where id = p_payment_id for update;
  if not found then raise exception 'NOT_FOUND: payment %', p_payment_id using errcode = 'P0002'; end if;
  if not authz.customer_in_scope('finance.payment.confirm', v_p.customer_id) then
    raise exception 'PERMISSION_DENIED: customer not in your scope' using errcode = '42501';
  end if;
  if v_p.status = 'confirmed' then
    return jsonb_build_object('payment_id', v_p.id, 'status', 'confirmed', 'replayed', true);
  end if;
  if v_p.status <> 'pending_verification' then
    raise exception 'INVALID_STATE: payment is %', v_p.status using errcode = 'P0001';
  end if;

  update finance.payments set status = 'confirmed', confirmed_by = auth.uid(), confirmed_at = now() where id = p_payment_id;
  perform finance.post_ledger(v_p.customer_id, 'payment', -v_p.amount, 'finance.payments', v_p.id);
  perform crm._notify_employee(v_p.collected_by, 'payment.confirmed', 'Payment confirmed: ' || v_p.payment_no,
                               null, '/finance/payments/' || v_p.id, jsonb_build_object('payment_id', v_p.id));
  insert into integration.outbox (event_type, aggregate_type, aggregate_id, payload)
  values ('payment.confirmed', 'finance.payment', v_p.id,
          jsonb_build_object('payment_id', v_p.id, 'payment_no', v_p.payment_no, 'customer_id', v_p.customer_id,
                             'amount', v_p.amount, 'currency', 'EGP'));
  return jsonb_build_object('payment_id', v_p.id, 'status', 'confirmed', 'replayed', false);
end $$;

-- A pending payment that finance does not accept (wrong record, cheque refused before
-- clearing). Nothing was posted, so nothing is reversed: a cheque becomes 'bounced', anything
-- else 'reversed', with the reason.
create or replace function api.reject_payment(p_payment_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_p finance.payments%rowtype; v_reason text := nullif(btrim(p_reason), ''); v_status text;
begin
  perform authz.require('finance.payment.confirm');
  if v_reason is null or length(v_reason) < 3 then
    raise exception 'REASON_REQUIRED: say why the payment is rejected' using errcode = 'P0001';
  end if;
  select * into v_p from finance.payments where id = p_payment_id for update;
  if not found then raise exception 'NOT_FOUND: payment %', p_payment_id using errcode = 'P0002'; end if;
  if not authz.customer_in_scope('finance.payment.confirm', v_p.customer_id) then
    raise exception 'PERMISSION_DENIED: customer not in your scope' using errcode = '42501';
  end if;
  if v_p.status in ('bounced','reversed') and v_p.confirmed_at is null then
    return jsonb_build_object('payment_id', v_p.id, 'status', v_p.status, 'replayed', true);
  end if;
  if v_p.status <> 'pending_verification' then
    raise exception 'INVALID_STATE: payment is %', v_p.status using errcode = 'P0001';
  end if;
  v_status := case when v_p.method = 'cheque' then 'bounced' else 'reversed' end;
  update finance.payments set status = v_status, status_reason = v_reason, reversed_at = now(), reversed_by = auth.uid()
  where id = p_payment_id;
  perform crm._notify_employee(v_p.collected_by, 'payment.rejected', 'Payment rejected: ' || v_p.payment_no,
                               v_reason, '/finance/payments/' || v_p.id, jsonb_build_object('payment_id', v_p.id));
  insert into integration.outbox (event_type, aggregate_type, aggregate_id, payload)
  values ('payment.rejected', 'finance.payment', v_p.id,
          jsonb_build_object('payment_id', v_p.id, 'payment_no', v_p.payment_no, 'customer_id', v_p.customer_id,
                             'amount', v_p.amount, 'status', v_status));
  return jsonb_build_object('payment_id', v_p.id, 'status', v_status, 'replayed', false);
end $$;

-- Reverse a confirmed payment (bounced cheque, posting error): undo every live allocation with a
-- negative allocation row, and post a payment_reversal (+amount) to the ledger. Nothing is edited.
create or replace function api.reverse_payment(p_payment_id uuid, p_reason text, p_bounced boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_p finance.payments%rowtype; v_reason text := nullif(btrim(p_reason), ''); v_status text;
  v_alloc record; v_invoices uuid[] := '{}'; v_inv uuid; v_count int := 0;
begin
  perform authz.require('finance.payment.reverse');
  if v_reason is null or length(v_reason) < 3 then
    raise exception 'REASON_REQUIRED: say why the payment is reversed' using errcode = 'P0001';
  end if;
  select * into v_p from finance.payments where id = p_payment_id for update;
  if not found then raise exception 'NOT_FOUND: payment %', p_payment_id using errcode = 'P0002'; end if;
  if not authz.customer_in_scope('finance.payment.reverse', v_p.customer_id) then
    raise exception 'PERMISSION_DENIED: customer not in your scope' using errcode = '42501';
  end if;
  if v_p.status in ('bounced','reversed') and v_p.confirmed_at is not null then
    return jsonb_build_object('payment_id', v_p.id, 'status', v_p.status, 'replayed', true);
  end if;
  if v_p.status <> 'confirmed' then
    raise exception 'INVALID_STATE: payment is %', v_p.status using errcode = 'P0001';
  end if;
  v_status := case when coalesce(p_bounced, false) then 'bounced' else 'reversed' end;

  -- Lock the invoices this payment touched (id order, like allocate_payment) before un-allocating.
  perform 1 from finance.invoices i
  where i.id in (select pa.invoice_id from finance.payment_allocations pa where pa.payment_id = p_payment_id)
  order by i.id for update;
  for v_alloc in
    select pa.* from finance.payment_allocations pa
    where pa.payment_id = p_payment_id and pa.amount > 0
      and not exists (select 1 from finance.payment_allocations x where x.reverses_allocation_id = pa.id)
    order by pa.allocated_at, pa.id
  loop
    insert into finance.payment_allocations (payment_id, invoice_id, amount, reverses_allocation_id, allocated_by, reason)
    values (p_payment_id, v_alloc.invoice_id, -v_alloc.amount, v_alloc.id, auth.uid(), 'Payment reversed: ' || v_reason);
    v_count := v_count + 1;
    if not v_alloc.invoice_id = any(v_invoices) then v_invoices := v_invoices || v_alloc.invoice_id; end if;
  end loop;

  update finance.payments set status = v_status, status_reason = v_reason, reversed_at = now(), reversed_by = auth.uid()
  where id = p_payment_id;
  perform finance.post_ledger(v_p.customer_id, 'payment_reversal', v_p.amount, 'finance.payments', v_p.id);
  foreach v_inv in array v_invoices loop perform finance.refresh_invoice_status(v_inv); end loop;

  perform crm._add_activity(v_p.customer_id, authz.current_employee_id(), 'payment',
                            'Payment ' || v_p.payment_no || ' ' || v_status || ': ' || v_reason, 'finance.payments', v_p.id);
  perform crm._notify_employee(v_p.collected_by, 'payment.reversed', 'Payment ' || v_status || ': ' || v_p.payment_no,
                               v_reason, '/finance/payments/' || v_p.id, jsonb_build_object('payment_id', v_p.id));
  insert into integration.outbox (event_type, aggregate_type, aggregate_id, payload)
  values ('payment.reversed', 'finance.payment', v_p.id,
          jsonb_build_object('payment_id', v_p.id, 'payment_no', v_p.payment_no, 'customer_id', v_p.customer_id,
                             'amount', v_p.amount, 'status', v_status, 'reason', v_reason,
                             'allocations_reversed', v_count));
  return jsonb_build_object('payment_id', v_p.id, 'status', v_status, 'allocations_reversed', v_count, 'replayed', false);
end $$;

-- ---------------------------------------------------------------------------
-- 5. Allocation. p_allocations = [{invoice_id, amount}] or NULL for FIFO (oldest due first).
-- Concurrency: the payment row, then every candidate invoice (in id order) is locked FOR UPDATE
-- before any open amount is read, so two allocations can never over-allocate one invoice.
-- Limit: finance.payment.allocate limit_value = max EGP per allocation command (NULL = unlimited).
-- ---------------------------------------------------------------------------
create or replace function api.allocate_payment(p_payment_id uuid, p_allocations jsonb default null,
                                                p_idempotency_key text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_key text := nullif(btrim(p_idempotency_key), '');
  v_p finance.payments%rowtype; v_left numeric; v_limit numeric; v_total numeric := 0;
  v_el jsonb; v_inv uuid; v_amt numeric; v_open numeric; v_status text; v_row record;
  v_req jsonb := '[]'::jsonb; v_ids uuid[] := '{}'; v_out jsonb := '[]'::jsonb; v_invoices jsonb := '[]'::jsonb;
  v_one jsonb;
begin
  perform authz.require('finance.payment.allocate');
  if v_key is not null and length(v_key) > 100 then
    raise exception 'VALIDATION: idempotency key is too long' using errcode = 'P0001';
  end if;

  select * into v_p from finance.payments where id = p_payment_id for update;
  if not found then raise exception 'NOT_FOUND: payment %', p_payment_id using errcode = 'P0002'; end if;
  if not authz.customer_in_scope('finance.payment.allocate', v_p.customer_id) then
    raise exception 'PERMISSION_DENIED: customer not in your scope' using errcode = '42501';
  end if;

  if v_key is not null and exists (select 1 from finance.payment_allocations where idempotency_key = v_key) then
    if exists (select 1 from finance.payment_allocations where idempotency_key = v_key and payment_id <> p_payment_id) then
      raise exception 'IDEMPOTENCY_CONFLICT: key was used for another payment' using errcode = 'P0001';
    end if;
    return jsonb_build_object('payment_id', p_payment_id, 'replayed', true,
      'allocations', (select jsonb_agg(jsonb_build_object('allocation_id', id, 'invoice_id', invoice_id, 'amount', amount) order by id)
                      from finance.payment_allocations where idempotency_key = v_key),
      'payment_unallocated', finance.payment_unallocated(p_payment_id));
  end if;

  if v_p.status <> 'confirmed' then
    raise exception 'INVALID_STATE: only confirmed payments can be allocated (payment is %)', v_p.status using errcode = 'P0001';
  end if;
  v_left := finance.payment_unallocated(p_payment_id);
  if v_left <= 0 then raise exception 'NOTHING_TO_ALLOCATE: the payment is fully allocated' using errcode = 'P0001'; end if;

  if p_allocations is null then
    -- FIFO: lock the customer's open invoices, then fill the oldest due first.
    perform 1 from finance.invoices
    where customer_id = v_p.customer_id and status in ('issued','partially_paid') order by id for update;
    for v_row in
      select i.id, b.o_open from finance.invoices i cross join lateral finance.invoice_balance(i.id) b
      where i.customer_id = v_p.customer_id and i.status in ('issued','partially_paid') and b.o_open > 0
      order by i.due_date, i.issue_date, i.invoice_no
    loop
      exit when v_left - v_total <= 0;
      v_amt := least(v_row.o_open, v_left - v_total);
      v_req := v_req || jsonb_build_object('invoice_id', v_row.id, 'amount', v_amt);
      v_total := v_total + v_amt;
    end loop;
    if v_total = 0 then raise exception 'NOTHING_TO_ALLOCATE: the customer has no open invoices' using errcode = 'P0001'; end if;
  else
    if jsonb_typeof(p_allocations) <> 'array' or jsonb_array_length(p_allocations) = 0 or jsonb_array_length(p_allocations) > 200 then
      raise exception 'VALIDATION: allocations must be a non-empty list' using errcode = 'P0001';
    end if;
    for v_el in select * from jsonb_array_elements(p_allocations) loop
      if jsonb_typeof(v_el) <> 'object'
         or exists (select 1 from jsonb_object_keys(v_el) k where k not in ('invoice_id','amount'))
         or core.try_cast_uuid(v_el ->> 'invoice_id') is null or jsonb_typeof(v_el -> 'amount') <> 'number' then
        raise exception 'VALIDATION: an allocation has only invoice_id and amount' using errcode = 'P0001';
      end if;
      v_inv := (v_el ->> 'invoice_id')::uuid; v_amt := (v_el ->> 'amount')::numeric;
      if v_amt <= 0 or v_amt <> round(v_amt, 2) then
        raise exception 'VALIDATION: allocation amounts are positive with at most 2 decimals' using errcode = 'P0001';
      end if;
      if v_inv = any(v_ids) then raise exception 'VALIDATION: an invoice appears twice' using errcode = 'P0001'; end if;
      v_ids := v_ids || v_inv;
      v_req := v_req || jsonb_build_object('invoice_id', v_inv, 'amount', v_amt);
      v_total := v_total + v_amt;
    end loop;
    perform 1 from finance.invoices where id = any(v_ids) order by id for update;
    for v_el in select * from jsonb_array_elements(v_req) loop
      v_inv := (v_el ->> 'invoice_id')::uuid; v_amt := (v_el ->> 'amount')::numeric;
      select status into v_status from finance.invoices where id = v_inv and customer_id = v_p.customer_id;
      if not found then raise exception 'VALIDATION: invoice % is not this customer''s', v_inv using errcode = 'P0001'; end if;
      if v_status not in ('issued','partially_paid') then
        raise exception 'INVOICE_CLOSED: invoice is %', v_status using errcode = 'P0001';
      end if;
      select o_open into v_open from finance.invoice_balance(v_inv);
      if v_amt > v_open then
        raise exception 'OVER_ALLOCATION: % exceeds the invoice''s open amount %', v_amt, v_open using errcode = 'P0001';
      end if;
    end loop;
    if v_total > v_left then
      raise exception 'OVER_ALLOCATION: % exceeds the payment''s unallocated %', v_total, v_left using errcode = 'P0001';
    end if;
  end if;

  v_limit := authz.max_limit('finance.payment.allocate');
  if v_limit is not null and v_total > v_limit then
    raise exception 'LIMIT_EXCEEDED: allocating % is above your limit %', v_total, v_limit using errcode = '42501';
  end if;

  for v_el in select * from jsonb_array_elements(v_req) loop
    insert into finance.payment_allocations (payment_id, invoice_id, amount, allocated_by, idempotency_key)
    values (p_payment_id, (v_el ->> 'invoice_id')::uuid, (v_el ->> 'amount')::numeric, auth.uid(), v_key)
    returning jsonb_build_object('allocation_id', id, 'invoice_id', invoice_id, 'amount', amount) into v_one;
    v_out := v_out || v_one;
    v_status := finance.refresh_invoice_status((v_el ->> 'invoice_id')::uuid);
    v_invoices := v_invoices || jsonb_build_object('id', (v_el ->> 'invoice_id')::uuid, 'status', v_status,
                    'open_amount', (select o_open from finance.invoice_balance((v_el ->> 'invoice_id')::uuid)));
  end loop;

  insert into integration.outbox (event_type, aggregate_type, aggregate_id, payload)
  values ('payment.allocated', 'finance.payment', p_payment_id,
          jsonb_build_object('payment_id', p_payment_id, 'payment_no', v_p.payment_no, 'customer_id', v_p.customer_id,
                             'allocated', v_total, 'allocations', v_out));
  return jsonb_build_object('payment_id', p_payment_id, 'allocations', v_out, 'allocated', v_total,
                            'payment_unallocated', finance.payment_unallocated(p_payment_id),
                            'invoices', v_invoices, 'fifo', p_allocations is null, 'replayed', false);
end $$;

-- Undo one allocation with a negative row (the original stays). The invoice reopens.
create or replace function api.reverse_allocation(p_allocation_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_a finance.payment_allocations%rowtype; v_p finance.payments%rowtype; v_reason text := nullif(btrim(p_reason), '');
        v_id uuid; v_existing uuid;
begin
  perform authz.require('finance.payment.reverse');
  if v_reason is null or length(v_reason) < 3 then
    raise exception 'REASON_REQUIRED: say why the allocation is reversed' using errcode = 'P0001';
  end if;
  select * into v_a from finance.payment_allocations where id = p_allocation_id;
  if not found then raise exception 'NOT_FOUND: allocation %', p_allocation_id using errcode = 'P0002'; end if;
  select * into v_p from finance.payments where id = v_a.payment_id for update;
  if not authz.customer_in_scope('finance.payment.reverse', v_p.customer_id) then
    raise exception 'PERMISSION_DENIED: customer not in your scope' using errcode = '42501';
  end if;
  if v_a.amount < 0 then raise exception 'INVALID_STATE: this row is itself a reversal' using errcode = 'P0001'; end if;
  perform 1 from finance.invoices where id = v_a.invoice_id for update;
  select id into v_existing from finance.payment_allocations where reverses_allocation_id = p_allocation_id;
  if v_existing is not null then
    return jsonb_build_object('reversal_id', v_existing, 'allocation_id', p_allocation_id, 'replayed', true);
  end if;

  insert into finance.payment_allocations (payment_id, invoice_id, amount, reverses_allocation_id, allocated_by, reason)
  values (v_a.payment_id, v_a.invoice_id, -v_a.amount, v_a.id, auth.uid(), v_reason)
  returning id into v_id;
  perform finance.refresh_invoice_status(v_a.invoice_id);
  insert into integration.outbox (event_type, aggregate_type, aggregate_id, payload)
  values ('payment.allocation_reversed', 'finance.payment', v_a.payment_id,
          jsonb_build_object('payment_id', v_a.payment_id, 'allocation_id', v_a.id, 'reversal_id', v_id,
                             'invoice_id', v_a.invoice_id, 'amount', v_a.amount, 'reason', v_reason));
  return jsonb_build_object('reversal_id', v_id, 'allocation_id', p_allocation_id,
                            'invoice_status', (select status from finance.invoices where id = v_a.invoice_id),
                            'payment_unallocated', finance.payment_unallocated(v_a.payment_id), 'replayed', false);
end $$;

-- ---------------------------------------------------------------------------
-- 6. Collection tasks: promise-to-pay, reopen (broken promise), escalate, collected, close.
-- Who: finance.collection.manage in scope, or the assignee (rep) with work.task.manage.
-- ---------------------------------------------------------------------------
create or replace function api.update_collection_task(p_task_id uuid, p_action text, p_promised_date date default null,
                                                      p_promised_amount numeric default null, p_note text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_t finance.collection_tasks%rowtype; v_emp uuid := authz.current_employee_id();
  v_note text := nullif(btrim(p_note), ''); v_to text;
begin
  select * into v_t from finance.collection_tasks where id = p_task_id for update;
  if not found then raise exception 'NOT_FOUND: collection task %', p_task_id using errcode = 'P0002'; end if;
  if not ((authz.has_permission('finance.collection.manage')
           and (authz.has_global('finance.collection.manage')
                or v_t.assignee_employee_id = any(authz.employee_ids('finance.collection.manage'))
                or authz.customer_in_scope('finance.collection.manage', v_t.customer_id)))
          or (v_t.assignee_employee_id = v_emp and authz.has_permission('work.task.manage'))) then
    raise exception 'PERMISSION_DENIED: collection task is outside your scope' using errcode = '42501';
  end if;
  if v_note is not null and length(v_note) > 1000 then
    raise exception 'VALIDATION: note is too long' using errcode = 'P0001';
  end if;

  v_to := case p_action when 'promise' then 'promised' when 'reopen' then 'open' when 'escalate' then 'escalated'
                        when 'collected' then 'collected' when 'close' then 'closed' end;
  if v_to is null then raise exception 'VALIDATION: unknown action' using errcode = 'P0001'; end if;
  if v_t.status in ('collected','closed') then
    raise exception 'INVALID_STATE: collection task is %', v_t.status using errcode = 'P0001';
  end if;
  if (p_action = 'reopen' and v_t.status not in ('promised','escalated'))
     or (p_action = 'escalate' and v_t.status = 'escalated') then
    raise exception 'INVALID_STATE: collection task is %', v_t.status using errcode = 'P0001';
  end if;
  if p_action = 'promise' then
    if p_promised_date is null or p_promised_date < core.business_date() or p_promised_date > core.business_date() + 365 then
      raise exception 'VALIDATION: promise date must be today or later' using errcode = 'P0001';
    end if;
    if p_promised_amount is not null and (p_promised_amount <= 0 or p_promised_amount <> round(p_promised_amount, 2)) then
      raise exception 'VALIDATION: promised amount must be positive' using errcode = 'P0001';
    end if;
  elsif p_action in ('close','escalate') and v_note is null then
    raise exception 'REASON_REQUIRED: add a note' using errcode = 'P0001';
  end if;

  update finance.collection_tasks set
    status = v_to,
    promised_date = case when p_action = 'promise' then p_promised_date else promised_date end,
    promised_amount = case when p_action = 'promise' then p_promised_amount else promised_amount end,
    outcome = coalesce(v_note, outcome),
    closed_at = case when v_to in ('collected','closed') then now() end,
    updated_at = now(), updated_by = auth.uid()
  where id = p_task_id;
  if v_to in ('collected','closed') and v_t.work_task_id is not null then
    update work.tasks set status = 'done', completed_at = now(), outcome = coalesce(v_note, 'Collection ' || v_to)
    where id = v_t.work_task_id and status = 'open';
  end if;
  perform crm._add_activity(v_t.customer_id, v_emp, 'note',
    case p_action when 'promise' then 'Promise to pay by ' || p_promised_date
                                     || coalesce(' (EGP ' || p_promised_amount || ')', '')
                  else 'Collection ' || v_to end || coalesce(' — ' || v_note, ''),
    'finance.collection_tasks', p_task_id);
  return jsonb_build_object('task_id', p_task_id, 'status', v_to);
end $$;

-- ---------------------------------------------------------------------------
-- 7. Overdue scan (cron via /api/cron/overdue, service_role only). Idempotent: an invoice gets
-- at most one collection task (unique index), concurrent runs skip locked invoices.
-- ---------------------------------------------------------------------------
create or replace function service.finance_overdue_scan(p_limit int default 500)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_today date := core.business_date(); r record; v_assignee uuid; v_task uuid; v_work uuid;
  v_created int := 0; v_unassigned int := 0; v_scanned int := 0;
begin
  for r in
    select i.id, i.invoice_no, i.customer_id, i.order_id, i.due_date, c.display_name
    from finance.invoices i join crm.customers c on c.id = i.customer_id
    where i.status in ('issued','partially_paid') and i.due_date < v_today
      and not exists (select 1 from finance.collection_tasks t where t.invoice_id = i.id)
    order by i.due_date, i.invoice_no
    limit least(greatest(coalesce(p_limit, 500), 1), 5000)
    for update of i skip locked
  loop
    v_scanned := v_scanned + 1;
    continue when (select o_open from finance.invoice_balance(r.id)) <= 0;
    select a.employee_id into v_assignee from crm.customer_assignments a
    where a.customer_id = r.customer_id and a.role = 'primary_rep' and a.valid_to is null limit 1;
    if v_assignee is null then
      select o.employee_id into v_assignee from sales.orders o where o.id = r.order_id;
    end if;
    if v_assignee is null then v_unassigned := v_unassigned + 1; continue; end if;

    insert into finance.collection_tasks (customer_id, invoice_id, assignee_employee_id, due_date, status)
    values (r.customer_id, r.id, v_assignee, v_today, 'open')
    on conflict (invoice_id) where invoice_id is not null do nothing
    returning id into v_task;
    continue when v_task is null;

    insert into work.tasks (title, kind, customer_id, assignee_employee_id, source, ref_table, ref_id, priority, due_at)
    values ('Collect overdue invoice ' || r.invoice_no, 'collection', r.customer_id, v_assignee, 'system',
            'finance.collection_tasks', v_task, 'high', (v_today::timestamp + time '17:00') at time zone 'Africa/Cairo')
    returning id into v_work;
    update finance.collection_tasks set work_task_id = v_work where id = v_task;

    perform notify.send_in_app((select e.user_id from core.employees e where e.id = v_assignee), 'invoice.overdue',
                               'Overdue invoice ' || r.invoice_no, r.display_name, '/finance/collections',
                               jsonb_build_object('invoice_id', r.id, 'collection_task_id', v_task));
    insert into integration.outbox (event_type, aggregate_type, aggregate_id, payload)
    values ('invoice.overdue', 'finance.invoice', r.id,
            jsonb_build_object('invoice_id', r.id, 'invoice_no', r.invoice_no, 'customer_id', r.customer_id,
                               'due_date', r.due_date, 'days_overdue', v_today - r.due_date,
                               'open_amount', (select o_open from finance.invoice_balance(r.id)),
                               'collection_task_id', v_task, 'assignee_employee_id', v_assignee));
    v_created := v_created + 1;
  end loop;
  return jsonb_build_object('business_date', v_today, 'scanned', v_scanned, 'created', v_created,
                            'unassigned', v_unassigned);
end $$;

-- ---------------------------------------------------------------------------
-- 8. Privileges
-- ---------------------------------------------------------------------------
revoke execute on function
  finance.invoice_balance(uuid),
  finance.payment_unallocated(uuid),
  finance.post_ledger(uuid, text, numeric, text, uuid),
  finance.sync_collection_tasks(uuid, numeric, date),
  finance.refresh_invoice_status(uuid),
  finance.credit_note_amounts(uuid, jsonb, numeric),
  wf.on_decided_finance_credit_note(uuid, boolean),
  wf.dispatch_decision_hook(text, uuid, boolean)
from public, anon, authenticated;

revoke all on all functions in schema service from public, anon, authenticated;
grant execute on all functions in schema service to service_role;

revoke execute on all functions in schema api from public;
revoke execute on function
  api.issue_invoice(uuid, text),
  api.issue_credit_note(uuid, jsonb, numeric, text, text),
  api.record_payment(uuid, numeric, text, text, timestamptz, uuid, date),
  api.confirm_payment(uuid),
  api.reject_payment(uuid, text),
  api.reverse_payment(uuid, text, boolean),
  api.allocate_payment(uuid, jsonb, text),
  api.reverse_allocation(uuid, text),
  api.update_collection_task(uuid, text, date, numeric, text)
from anon;
grant execute on function
  api.issue_invoice(uuid, text),
  api.issue_credit_note(uuid, jsonb, numeric, text, text),
  api.record_payment(uuid, numeric, text, text, timestamptz, uuid, date),
  api.confirm_payment(uuid),
  api.reject_payment(uuid, text),
  api.reverse_payment(uuid, text, boolean),
  api.allocate_payment(uuid, jsonb, text),
  api.reverse_allocation(uuid, text),
  api.update_collection_task(uuid, text, date, numeric, text)
to authenticated;
