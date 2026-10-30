-- Honest OS migration: fourth audit, money and stock — returns on paid invoices, cancelling
-- returns, return replays, and overdue history. Tests: supabase/tests/database/46_audit4_returns_ar.test.sql.
--
--   M-1  A return on a paid or partly paid invoice no longer gets stuck at 'received'.
--        Working decision (DECISIONS.md log, 2026-10-30): the customer is always credited with
--        the full computed return value. The part up to the invoice's open amount reduces that
--        invoice; any excess becomes unapplied customer credit — never a cash refund.
--        Representation (no change to how any balance or view is computed):
--          · the return's credit note is issued on the invoice for the full value, as before;
--          · the invoice's paid money that the credit note displaces is released from the
--            invoice: each standing payment allocation (newest first) gets an appended reversal
--            row and the part still needed on the invoice is re-allocated from the same payment.
--            Both rows carry finance.payment_allocations.credit_note_id;
--          · the released money stays on its payment as unallocated credit. The ledger already
--            holds the payment (−) and the full credit note (−), so the customer balance (= Σ
--            ledger) is lower by the full value, the invoice's open amount is exactly 0, and
--            api.allocate_payment applies the credit to a later invoice (manual or FIFO).
--        Commission: the engine sees the full credit note (credit_clawback within
--        commission.clawback_days, same rule as any credit note) and ignores the release rows,
--        so nothing is clawed back twice.
--        An open return (requested … received, not yet credited) now holds its quantity against
--        ordinary quantity credit notes, so a later credit note cannot leave the return
--        uncreditable (CREDIT_QTY_EXCEEDED at credit time).
--        api.cancel_return withdraws a pending return (its requester) or cancels an approved one
--        that was never received (wf.decide.return or sales.return.receive holders). The held
--        quantity is released (api.v_returnable_lines ignores cancelled returns; order lines'
--        returned_qty only moves on receipt). sales.returns.status gains 'cancelled' (expand only).
--        Partial receipt stays out of scope: receive_return still posts the whole return.
--   M-3  api.request_return checks the order's customer scope before it answers a replay, and a
--        replay is bound to its creator (created_by = auth.uid()); it answers ids and status only.
--   M-4  perf.overdue_invoices(p_as_of) no longer filters on the invoice's CURRENT status: the
--        write-offs posted by p_as_of are already subtracted, so history before a write-off stays.
--
-- Every replaced function starts from its latest definition:
--   finance.credit_note_amounts   20261031000100 §1 (body moved to a 4-argument version)
--   api.request_return, api.credit_return, api.v_returnable_lines, api.v_returns   20261103000200
--   perf.commission_replay_invoice   20261103000400 §3 (two filters added)
--   perf.overdue_invoices            20261103000500 §6
-- Non-destructive: new nullable columns, a widened CHECK (one value added), a new CHECK on the
-- new columns, views with appended columns, new functions. Nothing is dropped, renamed or narrowed.

-- ---------------------------------------------------------------------------
-- 0. Schema (expand only)
-- ---------------------------------------------------------------------------
-- The release rows of a return credit note (see M-1). NULL on every ordinary allocation.
alter table finance.payment_allocations add column if not exists credit_note_id uuid references finance.credit_notes(id);
create index if not exists idx_payment_allocations_credit_note on finance.payment_allocations (credit_note_id)
  where credit_note_id is not null;
comment on column finance.payment_allocations.credit_note_id is
  'Set on the reversal and re-allocation rows that released paid money from an invoice for a return credit note above its open amount; the released money stays on the payment as unapplied customer credit. The commission engine ignores these rows.';

alter table sales.returns add column if not exists cancelled_at timestamptz;
alter table sales.returns add column if not exists cancelled_by uuid references auth.users(id);
alter table sales.returns add column if not exists cancel_reason text;
alter table sales.returns add column if not exists cancel_idempotency_key text unique;
create index if not exists idx_returns_cancelled_by on sales.returns (cancelled_by);

-- Widen the status CHECK of 20261028000700_sales.sql by one value (every existing row still passes).
alter table sales.returns drop constraint returns_status_check,
  add constraint returns_status_check
  check (status in ('requested','pending_approval','approved','received','credited','rejected','cancelled'));
alter table sales.returns add constraint returns_cancelled_check
  check ((status = 'cancelled') = (cancelled_at is not null));

-- ---------------------------------------------------------------------------
-- 1. Views: cancelled returns hold nothing; the return shows its cancellation and customer credit
-- ---------------------------------------------------------------------------
create or replace view api.v_returnable_lines with (security_invoker = true) as
  select oi.order_id, oi.id as order_item_id, oi.line_no, oi.variant_id, v.sku, v.name_en as variant_name,
         f.lot_id, l.lot_no, l.expiry_date,
         f.qty as delivered_qty,
         coalesce(rl.qty, 0)::int as returned_qty,
         coalesce(ii.qty, 0)::int as invoiced_qty,
         coalesce(cr.qty, 0)::int as credited_other_qty,
         coalesce(rline.qty, 0)::int as line_returned_qty,
         greatest(least(f.qty - coalesce(rl.qty, 0),
                        coalesce(ii.qty, 0) - coalesce(cr.qty, 0) - coalesce(rline.qty, 0)), 0)::int as returnable_qty,
         oi.quantity as ordered_qty, oi.list_price, oi.applied_discount_pct, oi.tax_rate_pct, oi.line_total
  from sales.order_items oi
  join lateral (select fi.lot_id, sum(fi.quantity)::int as qty
                from sales.fulfillment_items fi
                join sales.fulfillments fu on fu.id = fi.fulfillment_id and fu.status = 'posted'
                where fi.order_item_id = oi.id
                group by fi.lot_id) f on true
  left join lateral (select sum(ri.quantity) as qty
                     from sales.return_items ri join sales.returns r on r.id = ri.return_id
                                                and r.status not in ('rejected','cancelled')
                     where ri.order_item_id = oi.id and ri.lot_id = f.lot_id) rl on true
  left join lateral (select sum(ri.quantity) as qty
                     from sales.return_items ri join sales.returns r on r.id = ri.return_id
                                                and r.status not in ('rejected','cancelled')
                     where ri.order_item_id = oi.id) rline on true
  left join lateral (select sum(x.quantity) as qty from finance.invoice_items x where x.order_item_id = oi.id) ii on true
  left join lateral (select sum(ci.quantity) as qty
                     from finance.credit_note_items ci
                     join finance.invoice_items x on x.id = ci.invoice_item_id
                     join finance.credit_notes cn on cn.id = ci.credit_note_id and cn.return_id is null
                     where x.order_item_id = oi.id) cr on true
  left join catalog.product_variants v on v.id = oi.variant_id
  left join inventory.lots l on l.id = f.lot_id;

-- Columns appended: cancelled_at, cancelled_by, cancel_reason, customer_credit (the part of the
-- credit that became unapplied customer credit; visible to whoever may read the allocations).
create or replace view api.v_returns with (security_invoker = true) as
  select r.id, r.return_no, r.order_id, o.order_no, o.status as order_status,
         r.customer_id, c.customer_no, c.display_name as customer_name,
         o.employee_id as rep_employee_id, rep.full_name_en as rep_name_en, rep.full_name_ar as rep_name_ar,
         coalesce(o.territory_id, c.territory_id) as territory_id,
         r.status, r.reason, r.notes,
         r.warehouse_id, w.code as warehouse_code, w.name as warehouse_name,
         r.approval_request_id, ar.status as approval_status,
         r.created_by, rq.full_name_en as requested_by_name_en, rq.full_name_ar as requested_by_name_ar,
         (r.created_by = (select auth.uid())) as is_mine,
         r.created_at, r.decided_at, r.received_at, r.credited_at, r.updated_at,
         coalesce(t.lines, 0)::int as lines, coalesce(t.qty, 0)::int as total_qty,
         coalesce(t.credited_qty, 0)::int as credited_qty,
         coalesce(t.estimated_total, 0)::numeric(14,2) as estimated_total,
         coalesce(cn.n, 0)::int as credit_notes, coalesce(cn.total, 0)::numeric(14,2) as credited_total,
         r.cancelled_at, r.cancelled_by, r.cancel_reason,
         coalesce(-cc.released, 0)::numeric(14,2) as customer_credit
  from sales.returns r
  left join sales.orders o on o.id = r.order_id
  left join crm.customers c on c.id = r.customer_id
  left join inventory.warehouses w on w.id = r.warehouse_id
  left join wf.approval_requests ar on ar.id = r.approval_request_id
  left join lateral crm.employee_display(o.employee_id) rep on true
  left join lateral core.user_display(r.created_by) rq on true
  left join lateral (select count(*) as lines, sum(ri.quantity) as qty, sum(ri.credited_qty) as credited_qty,
                            sum(round(oi.line_total * ri.quantity / oi.quantity, 2)) as estimated_total
                     from sales.return_items ri join sales.order_items oi on oi.id = ri.order_item_id
                     where ri.return_id = r.id) t on true
  left join lateral (select count(*) as n, sum(x.amount + x.tax_amount) as total
                     from finance.credit_notes x where x.return_id = r.id) cn on true
  left join lateral (select sum(pa.amount) as released
                     from finance.payment_allocations pa join finance.credit_notes x on x.id = pa.credit_note_id
                     where x.return_id = r.id) cc on true;

-- ---------------------------------------------------------------------------
-- 2. Credit-note amounts. The original body (20261031000100 §1) moves to a 4-argument version:
--      p_return_credit = false (every existing caller, through the 3-argument wrapper):
--        unchanged, plus the hold of open returns on the order line;
--      p_return_credit = true (api.credit_return only): no open-amount check — the caller
--        releases the excess as customer credit; the return's own quantity is not a hold.
-- ---------------------------------------------------------------------------
create or replace function finance.credit_note_amounts(p_invoice_id uuid, p_lines jsonb, p_amount numeric,
                                                       p_return_credit boolean)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_inv finance.invoices%rowtype; b record;
  v_el jsonb; v_item_id uuid; v_q int; v_it record; v_prev record;
  v_net_line numeric; v_amt numeric; v_tax numeric;
  v_sum_amt numeric := 0; v_sum_tax numeric := 0; v_out jsonb := '[]'::jsonb; v_seen uuid[] := '{}';
  v_base numeric; v_has_lines boolean; v_held int; v_line_inv int; v_line_cred int;
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
      -- Audit 4 M-1: units an open return holds on the order line (requested … received, not yet
      -- credited) are not available to an ordinary credit note; the return credits them.
      if not coalesce(p_return_credit, false) and v_it.order_item_id is not null then
        select coalesce(sum(ri.quantity - ri.credited_qty), 0)::int into v_held
        from sales.return_items ri join sales.returns r on r.id = ri.return_id
        where ri.order_item_id = v_it.order_item_id and r.status in ('requested','pending_approval','approved','received');
        if v_held > 0 then
          select coalesce(sum(x.quantity), 0)::int,
                 coalesce(sum((select coalesce(sum(ci.quantity), 0) from finance.credit_note_items ci
                               where ci.invoice_item_id = x.id)), 0)::int
            into v_line_inv, v_line_cred
          from finance.invoice_items x where x.order_item_id = v_it.order_item_id;
          if v_line_cred + v_q + v_held > v_line_inv then
            raise exception 'CREDIT_QTY_EXCEEDED: % unit(s) of this line are held by an open return; credit them through the return',
              v_held using errcode = 'P0001';
          end if;
        end if;
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
  if not coalesce(p_return_credit, false) then
    select * into b from finance.invoice_balance(p_invoice_id);
    if v_sum_amt + v_sum_tax > b.o_open then
      raise exception 'EXCEEDS_INVOICE_OPEN_AMOUNT: credit % exceeds the open amount %', v_sum_amt + v_sum_tax, b.o_open
        using errcode = 'P0001';
    end if;
  end if;
  return jsonb_build_object('amount', v_sum_amt, 'tax_amount', v_sum_tax, 'total', v_sum_amt + v_sum_tax,
                            'lines', case when p_amount is null then v_out end);
end $$;

-- Every existing caller (api.issue_credit_note, wf.on_decided_finance_credit_note) keeps this signature.
create or replace function finance.credit_note_amounts(p_invoice_id uuid, p_lines jsonb, p_amount numeric)
returns jsonb language sql stable security definer set search_path = '' as $$
  select finance.credit_note_amounts(p_invoice_id, p_lines, p_amount, false)
$$;

-- ---------------------------------------------------------------------------
-- 3. Release paid money from an invoice for a return credit note above its open amount.
--    Standing allocations of confirmed payments, newest first: an appended reversal row, then a
--    re-allocation of what the invoice still needs from the same payment. Both rows carry the
--    credit note. The released money stays on the payment (unallocated = customer credit).
--    Caller holds the customer AR lock and the invoice row lock, and has inserted the note.
-- ---------------------------------------------------------------------------
create or replace function finance.release_paid_for_credit(p_invoice_id uuid, p_credit_note_id uuid, p_amount numeric,
                                                           p_reason text)
returns numeric language plpgsql security definer set search_path = '' as $$
declare v_left numeric := p_amount; v_a record; v_take numeric;
begin
  if p_amount is null or p_amount <= 0 then return 0; end if;
  for v_a in
    select pa.* from finance.payment_allocations pa
    join finance.payments p on p.id = pa.payment_id and p.status = 'confirmed'
    where pa.invoice_id = p_invoice_id and pa.amount > 0
      and not exists (select 1 from finance.payment_allocations x where x.reverses_allocation_id = pa.id)
    order by pa.allocated_at desc, pa.id desc
  loop
    exit when v_left <= 0;
    perform 1 from finance.payments where id = v_a.payment_id for update;
    v_take := least(v_a.amount, v_left);
    insert into finance.payment_allocations (payment_id, invoice_id, amount, reverses_allocation_id, allocated_by, reason,
                                             credit_note_id)
    values (v_a.payment_id, p_invoice_id, -v_a.amount, v_a.id, auth.uid(), p_reason, p_credit_note_id);
    if v_a.amount > v_take then
      insert into finance.payment_allocations (payment_id, invoice_id, amount, allocated_by, reason, credit_note_id)
      values (v_a.payment_id, p_invoice_id, v_a.amount - v_take, auth.uid(), p_reason, p_credit_note_id);
    end if;
    v_left := v_left - v_take;
  end loop;
  if v_left > 0 then
    -- Only when earlier credits or write-offs already cover the returned lines' value.
    raise exception 'EXCEEDS_INVOICE_OPEN_AMOUNT: % of the return credit is neither open nor paid on the invoice', v_left
      using errcode = 'P0001';
  end if;
  return p_amount;
end $$;

-- ---------------------------------------------------------------------------
-- 4. api.request_return — from 20261103000200 §3. Change (M-3): the order lock and the customer
--    scope check come before the replay, and a replay is bound to its creator.
-- ---------------------------------------------------------------------------
create or replace function api.request_return(p_order_id uuid, p_lines jsonb, p_notes text default null,
                                              p_client_ref uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_existing sales.returns%rowtype; v_order sales.orders%rowtype;
  v_notes text := nullif(btrim(p_notes), '');
  v_el jsonb; v_n int := 0; v_item uuid; v_lot uuid; v_q int; v_reason text; v_cond text;
  v_lots int; v_ret record; v_oi sales.order_items%rowtype;
  v_parsed jsonb := '[]'::jsonb; v_seen text[] := '{}';
  v_id uuid := gen_random_uuid(); v_no text; v_request uuid; v_status text;
  v_territory uuid; v_reasons text; v_estimate numeric := 0; v_payload_lines jsonb := '[]'::jsonb; v_total_q int := 0;
begin
  perform authz.require('sales.return.request');
  if p_client_ref is null then
    raise exception 'VALIDATION: client reference is required' using errcode = 'P0001';
  end if;

  -- The order lock serializes concurrent returns of one order (returnable quantities).
  select * into v_order from sales.orders where id = p_order_id for update;
  if not found then raise exception 'NOT_FOUND: order %', p_order_id using errcode = 'P0002'; end if;
  if not authz.customer_in_scope('sales.return.request', v_order.customer_id) then
    raise exception 'PERMISSION_DENIED: customer not in your scope' using errcode = '42501';
  end if;

  -- Replay: only the creator's, only while the customer is in scope (above), before any state
  -- check, so a retry after a lost response gets the first result. Ids and status only.
  select * into v_existing from sales.returns where client_ref = p_client_ref;
  if found then
    if v_existing.order_id <> p_order_id or v_existing.created_by is distinct from auth.uid() then
      raise exception 'IDEMPOTENCY_CONFLICT: client reference was used for another return' using errcode = 'P0001';
    end if;
    return jsonb_build_object('return_id', v_existing.id, 'return_no', v_existing.return_no, 'status', v_existing.status,
                              'approval_request_id', v_existing.approval_request_id, 'replayed', true);
  end if;

  if v_order.status not in ('partially_fulfilled','fulfilled','invoiced','closed') then
    raise exception 'INVALID_STATE: order is % (only delivered goods can be returned)', v_order.status using errcode = 'P0001';
  end if;
  if v_notes is not null and length(v_notes) > 1000 then
    raise exception 'VALIDATION: notes are too long' using errcode = 'P0001';
  end if;

  -- Parse and validate every line before writing anything.
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'VALIDATION: lines must be a non-empty list' using errcode = 'P0001';
  end if;
  if jsonb_array_length(p_lines) > 100 then raise exception 'VALIDATION: too many lines' using errcode = 'P0001'; end if;
  for v_el in select * from jsonb_array_elements(p_lines) loop
    v_n := v_n + 1;
    if jsonb_typeof(v_el) <> 'object' or exists (
         select 1 from jsonb_object_keys(v_el) k where k not in ('order_item_id','lot_id','quantity','reason_code','condition')) then
      raise exception 'VALIDATION: line % may only contain order_item_id, lot_id, quantity, reason_code, condition', v_n
        using errcode = 'P0001';
    end if;
    v_item := core.try_cast_uuid(v_el ->> 'order_item_id');
    select * into v_oi from sales.order_items where id = v_item and order_id = p_order_id;
    if v_item is null or not found then
      raise exception 'VALIDATION: line % is not a line of this order', v_n using errcode = 'P0001';
    end if;
    if jsonb_typeof(v_el -> 'quantity') <> 'number'
       or (v_el ->> 'quantity')::numeric <> trunc((v_el ->> 'quantity')::numeric)
       or (v_el ->> 'quantity')::numeric <= 0 or (v_el ->> 'quantity')::numeric > 100000 then
      raise exception 'VALIDATION: line % needs a whole positive quantity', v_n using errcode = 'P0001';
    end if;
    v_q := (v_el ->> 'quantity')::int;
    v_reason := v_el ->> 'reason_code';
    if v_reason is null or v_reason not in ('damaged','defective','wrong_item','expired','near_expiry',
                                            'not_ordered','customer_request','other') then
      raise exception 'VALIDATION: line % has no valid reason_code', v_n using errcode = 'P0001';
    end if;
    if v_reason = 'other' and v_notes is null then
      raise exception 'REASON_REQUIRED: describe the reason in the notes' using errcode = 'P0001';
    end if;
    v_cond := coalesce(v_el ->> 'condition',
                       case v_reason when 'damaged' then 'damaged' when 'defective' then 'damaged'
                                     when 'expired' then 'expired' else 'resaleable' end);
    if v_cond not in ('resaleable','damaged','expired') then
      raise exception 'VALIDATION: line % has an invalid condition', v_n using errcode = 'P0001';
    end if;

    if v_el ? 'lot_id' and jsonb_typeof(v_el -> 'lot_id') <> 'null' then
      v_lot := core.try_cast_uuid(v_el ->> 'lot_id');
      if v_lot is null then raise exception 'VALIDATION: line % has an invalid lot_id', v_n using errcode = 'P0001'; end if;
    else
      select count(*), min(lot_id::text)::uuid into v_lots, v_lot
      from api.v_returnable_lines where order_item_id = v_item;
      if v_lots <> 1 then
        raise exception 'VALIDATION: line % was delivered from % lots; choose the lot', v_n, v_lots using errcode = 'P0001';
      end if;
    end if;
    if (v_item::text || ':' || v_lot::text) = any(v_seen) then
      raise exception 'VALIDATION: line % repeats an order line and lot', v_n using errcode = 'P0001';
    end if;
    v_seen := v_seen || (v_item::text || ':' || v_lot::text);
    if not exists (select 1 from api.v_returnable_lines where order_item_id = v_item and lot_id = v_lot) then
      raise exception 'VALIDATION: line %: that lot was not delivered on this order line', v_n using errcode = 'P0001';
    end if;
    v_parsed := v_parsed || jsonb_build_object('order_item_id', v_item, 'lot_id', v_lot, 'quantity', v_q,
                                               'reason_code', v_reason, 'condition', v_cond, 'n', v_n);
  end loop;

  select string_agg(distinct x ->> 'reason_code', ', ' order by x ->> 'reason_code') into v_reasons
  from jsonb_array_elements(v_parsed) x;
  v_no := core.next_document_no('RET', core.business_date());
  insert into sales.returns (id, return_no, order_id, customer_id, reason, status, created_by, client_ref, notes)
  values (v_id, v_no, p_order_id, v_order.customer_id, v_reasons, 'pending_approval', auth.uid(), p_client_ref, v_notes);

  -- Each line is checked against what is still returnable, counting the lines of this request
  -- already inserted (a pending request holds its quantity).
  for v_el in select * from jsonb_array_elements(v_parsed) loop
    select * into v_ret from api.v_returnable_lines
    where order_item_id = (v_el ->> 'order_item_id')::uuid and lot_id = (v_el ->> 'lot_id')::uuid;
    if (v_el ->> 'quantity')::int > v_ret.returnable_qty then
      raise exception 'QTY_EXCEEDS_RETURNABLE: line % — % requested, % returnable (delivered and invoiced, minus returns)',
        v_el ->> 'n', v_el ->> 'quantity', v_ret.returnable_qty using errcode = 'P0001';
    end if;
    insert into sales.return_items (return_id, order_item_id, lot_id, quantity, condition, reason_code)
    values (v_id, (v_el ->> 'order_item_id')::uuid, (v_el ->> 'lot_id')::uuid, (v_el ->> 'quantity')::int,
            v_el ->> 'condition', v_el ->> 'reason_code');
    v_estimate := v_estimate + round(v_ret.line_total * (v_el ->> 'quantity')::int / v_ret.ordered_qty, 2);
    v_total_q := v_total_q + (v_el ->> 'quantity')::int;
    v_payload_lines := v_payload_lines || jsonb_build_object(
      'order_item_id', v_ret.order_item_id, 'sku', v_ret.sku, 'lot_id', v_ret.lot_id, 'lot_no', v_ret.lot_no,
      'quantity', (v_el ->> 'quantity')::int, 'reason_code', v_el ->> 'reason_code');
  end loop;

  select coalesce(v_order.territory_id, c.territory_id) into v_territory from crm.customers c where c.id = v_order.customer_id;
  v_request := wf.create_request('sales.return', 'sales.return', v_id,
    jsonb_build_object('return_id', v_id, 'return_no', v_no, 'order_id', p_order_id, 'order_no', v_order.order_no,
                       'customer_id', v_order.customer_id, 'territory_id', v_territory,
                       'reason', v_reasons, 'notes', v_notes, 'lines', v_payload_lines,
                       'quantity', v_total_q, 'total', v_estimate),
    v_order.employee_id);
  update sales.returns set approval_request_id = v_request, updated_at = now() where id = v_id
  returning status into v_status;

  perform crm._add_activity(v_order.customer_id, authz.current_employee_id(), 'order',
                            'Return ' || v_no || ' requested on ' || coalesce(v_order.order_no, ''), 'sales.returns', v_id);
  insert into integration.outbox (event_type, aggregate_type, aggregate_id, payload)
  values ('return.requested', 'sales.return', v_id,
          jsonb_build_object('return_id', v_id, 'return_no', v_no, 'order_id', p_order_id, 'order_no', v_order.order_no,
                             'customer_id', v_order.customer_id, 'quantity', v_total_q, 'reason', v_reasons,
                             'approval_request_id', v_request));

  return jsonb_build_object('return_id', v_id, 'return_no', v_no, 'status', v_status, 'approval_request_id', v_request,
                            'estimated_total', v_estimate, 'replayed', false);
end $$;

-- ---------------------------------------------------------------------------
-- 5. api.credit_return — from 20261103000200 §6. Change (M-1): the credit note is always the full
--    return value; what exceeds the invoice's open amount is released from the invoice's payment
--    allocations as unapplied customer credit (finance.release_paid_for_credit).
-- ---------------------------------------------------------------------------
create or replace function api.credit_return(p_return_id uuid, p_idempotency_key text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_key text := nullif(btrim(p_idempotency_key), '');
  v_ret sales.returns%rowtype; v_need record; v_ii record; v_left int; v_take int;
  v_alloc jsonb := '[]'::jsonb; v_inv_row record; v_inv finance.invoices%rowtype; v_calc jsonb;
  v_cn uuid; v_cn_no text; v_n int := 0; v_notes jsonb := '[]'::jsonb; v_sum numeric := 0;
  v_today date := core.business_date();
  v_total numeric; v_open numeric; v_excess numeric; v_credit_sum numeric := 0.00;
begin
  perform authz.require('sales.return.credit');
  if v_key is null or length(v_key) > 100 then
    raise exception 'VALIDATION: idempotency key is required' using errcode = 'P0001';
  end if;

  select * into v_ret from sales.returns where id = p_return_id;
  if not found then raise exception 'NOT_FOUND: return %', p_return_id using errcode = 'P0002'; end if;
  if not authz.customer_in_scope('sales.return.credit', v_ret.customer_id) then
    raise exception 'PERMISSION_DENIED: customer not in your scope' using errcode = '42501';
  end if;
  -- Same lock order as every AR mutation (finance M1): customer AR lock, then rows.
  perform finance.lock_customer_ar(v_ret.customer_id);
  select * into v_ret from sales.returns where id = p_return_id for update;

  if v_ret.credit_idempotency_key = v_key then
    return jsonb_build_object('return_id', v_ret.id, 'status', v_ret.status, 'replayed', true,
      'credit_notes', coalesce((select jsonb_agg(jsonb_build_object('credit_note_id', cn.id, 'credit_no', cn.credit_no,
                                                                    'invoice_id', cn.invoice_id, 'amount', cn.amount,
                                                                    'tax_amount', cn.tax_amount,
                                                                    'total', cn.amount + cn.tax_amount,
                                                                    'customer_credit', coalesce((select -sum(pa.amount)
                                                                       from finance.payment_allocations pa
                                                                       where pa.credit_note_id = cn.id), 0))
                                                 order by cn.credit_no)
                                from finance.credit_notes cn where cn.return_id = v_ret.id), '[]'::jsonb),
      'total', (select coalesce(sum(cn.amount + cn.tax_amount), 0) from finance.credit_notes cn where cn.return_id = v_ret.id),
      'customer_credit', (select coalesce(-sum(pa.amount), 0) from finance.payment_allocations pa
                          join finance.credit_notes cn on cn.id = pa.credit_note_id where cn.return_id = v_ret.id));
  end if;
  if exists (select 1 from sales.returns where credit_idempotency_key = v_key) then
    raise exception 'IDEMPOTENCY_CONFLICT: key was used for another return' using errcode = 'P0001';
  end if;
  if v_ret.status <> 'received' then
    raise exception 'INVALID_STATE: return is % (credit follows receipt)', v_ret.status using errcode = 'P0001';
  end if;

  -- Allocate the quantity of each returned order line to its invoice lines, oldest invoice first,
  -- within what is still creditable on each invoice line (quantity − every credit note line on it).
  for v_need in
    select ri.order_item_id, sum(ri.quantity - ri.credited_qty)::int as qty
    from sales.return_items ri where ri.return_id = v_ret.id
    group by ri.order_item_id having sum(ri.quantity - ri.credited_qty) > 0
    order by ri.order_item_id
  loop
    v_left := v_need.qty;
    for v_ii in
      select x.id, x.invoice_id,
             (x.quantity - coalesce((select sum(ci.quantity) from finance.credit_note_items ci
                                     where ci.invoice_item_id = x.id), 0))::int as creditable
      from finance.invoice_items x join finance.invoices i on i.id = x.invoice_id
      where x.order_item_id = v_need.order_item_id
      order by i.issue_date, i.invoice_no, x.id
    loop
      exit when v_left = 0;
      v_take := least(v_left, greatest(v_ii.creditable, 0));
      continue when v_take = 0;
      v_alloc := v_alloc || jsonb_build_object('invoice_id', v_ii.invoice_id, 'invoice_item_id', v_ii.id, 'quantity', v_take);
      v_left := v_left - v_take;
    end loop;
    if v_left > 0 then
      raise exception 'CREDIT_QTY_EXCEEDED: % returned unit(s) of an order line are not on any creditable invoice line', v_left
        using errcode = 'P0001';
    end if;
  end loop;
  if jsonb_array_length(v_alloc) = 0 then
    raise exception 'INVALID_STATE: nothing left to credit on this return' using errcode = 'P0001';
  end if;

  for v_inv_row in
    select a.invoice_id,
           jsonb_agg(jsonb_build_object('invoice_item_id', a.invoice_item_id, 'quantity', a.quantity) order by a.invoice_item_id) as lines
    from jsonb_to_recordset(v_alloc) as a(invoice_id uuid, invoice_item_id uuid, quantity int)
    group by a.invoice_id
    order by a.invoice_id
  loop
    select * into v_inv from finance.invoices where id = v_inv_row.invoice_id for update;
    if v_inv.status = 'written_off' then
      raise exception 'INVALID_STATE: invoice % is written off', v_inv.invoice_no using errcode = 'P0001';
    end if;
    -- Amounts and VAT exactly as finance computes a quantity credit note (incl. the last-unit
    -- remainder), without the open-amount cap: the excess becomes customer credit below.
    v_calc := finance.credit_note_amounts(v_inv.id, v_inv_row.lines, null, true);
    v_total := (v_calc ->> 'total')::numeric;
    select b.o_open into v_open from finance.invoice_balance(v_inv.id) b;
    v_excess := greatest(v_total - greatest(v_open, 0), 0)::numeric(14,2);
    v_n := v_n + 1;
    v_cn := gen_random_uuid();
    v_cn_no := core.next_document_no('CN', v_today);
    insert into finance.credit_notes (id, credit_no, invoice_id, customer_id, return_id, reason, amount, tax_amount,
                                      issue_date, approval_request_id, created_by, idempotency_key)
    values (v_cn, v_cn_no, v_inv.id, v_inv.customer_id, v_ret.id, 'Return ' || v_ret.return_no,
            (v_calc ->> 'amount')::numeric, (v_calc ->> 'tax_amount')::numeric, v_today, v_ret.approval_request_id,
            auth.uid(), v_key || '#' || v_n);
    insert into finance.credit_note_items (credit_note_id, invoice_item_id, quantity, amount, tax_amount)
    select v_cn, (l ->> 'invoice_item_id')::uuid, (l ->> 'quantity')::int, (l ->> 'amount')::numeric,
           (l ->> 'tax_amount')::numeric
    from jsonb_array_elements(v_calc -> 'lines') l;
    if v_excess > 0 then
      perform finance.release_paid_for_credit(v_inv.id, v_cn, v_excess,
        'Return ' || v_ret.return_no || ', credit note ' || v_cn_no || ': paid amount kept as customer credit');
    end if;
    perform finance.post_ledger(v_inv.customer_id, 'credit_note', -v_total, 'finance.credit_notes', v_cn);
    perform finance.refresh_invoice_status(v_inv.id);
    perform crm._add_activity(v_inv.customer_id, authz.current_employee_id(), 'invoice',
                              'Credit note ' || v_cn_no || ' on ' || v_inv.invoice_no || ' for return ' || v_ret.return_no
                              || case when v_excess > 0 then ' (' || v_excess || ' kept as customer credit)' else '' end,
                              'finance.credit_notes', v_cn);
    insert into integration.outbox (event_type, aggregate_type, aggregate_id, payload)
    values ('credit_note.issued', 'finance.credit_note', v_cn,
            jsonb_build_object('credit_note_id', v_cn, 'credit_no', v_cn_no, 'invoice_id', v_inv.id,
                               'invoice_no', v_inv.invoice_no, 'customer_id', v_inv.customer_id,
                               'return_id', v_ret.id, 'return_no', v_ret.return_no,
                               'amount', (v_calc ->> 'amount')::numeric, 'tax_amount', (v_calc ->> 'tax_amount')::numeric,
                               'total', v_total, 'applied_to_invoice', v_total - v_excess, 'customer_credit', v_excess,
                               'issue_date', v_today, 'currency', v_inv.currency));
    v_sum := v_sum + v_total;
    v_credit_sum := v_credit_sum + v_excess;
    v_notes := v_notes || jsonb_build_object('credit_note_id', v_cn, 'credit_no', v_cn_no, 'invoice_id', v_inv.id,
                                             'amount', (v_calc ->> 'amount')::numeric,
                                             'tax_amount', (v_calc ->> 'tax_amount')::numeric,
                                             'total', v_total, 'customer_credit', v_excess);
  end loop;

  update sales.return_items set credited_qty = quantity where return_id = v_ret.id and credited_qty < quantity;
  update sales.returns set status = 'credited', credited_at = now(), credited_by = auth.uid(),
         credit_idempotency_key = v_key, updated_at = now()
  where id = v_ret.id;

  perform notify.send_in_app(v_ret.created_by, 'return.credited', 'Return credited: ' || v_ret.return_no, null,
                             '/returns/' || v_ret.id,
                             jsonb_build_object('return_id', v_ret.id, 'return_no', v_ret.return_no, 'status', 'credited'));
  insert into integration.outbox (event_type, aggregate_type, aggregate_id, payload)
  values ('return.credited', 'sales.return', v_ret.id,
          jsonb_build_object('return_id', v_ret.id, 'return_no', v_ret.return_no, 'order_id', v_ret.order_id,
                             'customer_id', v_ret.customer_id, 'total', v_sum, 'customer_credit', v_credit_sum,
                             'credit_notes', v_notes));

  return jsonb_build_object('return_id', v_ret.id, 'status', 'credited', 'credit_notes', v_notes, 'total', v_sum,
                            'customer_credit', v_credit_sum, 'replayed', false);
end $$;

-- ---------------------------------------------------------------------------
-- 6. api.cancel_return (M-1). Who:
--      pending (requested / pending_approval): the requester only (approvers reject instead);
--      approved, not yet received: wf.decide.return (in customer scope) or sales.return.receive.
--    Received, credited, rejected and cancelled returns cannot be cancelled. Cancelling a pending
--    return cancels its approval request. The held quantity is released (api.v_returnable_lines
--    ignores cancelled returns); nothing was received, so stock and returned_qty do not move.
-- ---------------------------------------------------------------------------
create or replace function api.cancel_return(p_return_id uuid, p_reason text, p_idempotency_key text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_key text := nullif(btrim(p_idempotency_key), '');
  v_reason text := nullif(btrim(p_reason), '');
  v_ret sales.returns%rowtype; v_allowed boolean := false; v_req_status text; v_from text;
begin
  if not authz.is_active_user() then
    raise exception 'PERMISSION_DENIED: inactive or unknown user' using errcode = '42501';
  end if;
  if v_reason is null or length(v_reason) < 3 then
    raise exception 'REASON_REQUIRED: say why the return is cancelled' using errcode = 'P0001';
  end if;
  if length(v_reason) > 500 then raise exception 'VALIDATION: reason is too long' using errcode = 'P0001'; end if;
  if v_key is null or length(v_key) > 100 then
    raise exception 'VALIDATION: idempotency key is required' using errcode = 'P0001';
  end if;

  select * into v_ret from sales.returns where id = p_return_id;
  if not found then raise exception 'NOT_FOUND: return %', p_return_id using errcode = 'P0002'; end if;
  -- Lock order: order (as request/receive), approval request (as decide_approval), then the return.
  perform 1 from sales.orders where id = v_ret.order_id for update;
  if v_ret.approval_request_id is not null then
    select status into v_req_status from wf.approval_requests where id = v_ret.approval_request_id for update;
  end if;
  select * into v_ret from sales.returns where id = p_return_id for update;

  if v_ret.cancel_idempotency_key = v_key then
    if not (v_ret.cancelled_by = auth.uid()
            or (v_ret.created_by = auth.uid() and authz.has_permission('sales.return.request'))
            or authz.customer_in_scope('wf.decide.return', v_ret.customer_id)
            or authz.has_permission('sales.return.receive')) then
      raise exception 'PERMISSION_DENIED: not your return to cancel' using errcode = '42501';
    end if;
    return jsonb_build_object('return_id', v_ret.id, 'return_no', v_ret.return_no, 'status', v_ret.status,
                              'replayed', true);
  end if;
  if exists (select 1 from sales.returns where cancel_idempotency_key = v_key) then
    raise exception 'IDEMPOTENCY_CONFLICT: key was used for another return' using errcode = 'P0001';
  end if;

  v_from := v_ret.status;
  if v_ret.status in ('requested','pending_approval') then
    v_allowed := v_ret.created_by = auth.uid() and authz.has_permission('sales.return.request');
    if not v_allowed then
      raise exception 'PERMISSION_DENIED: only the requester withdraws a pending return (approvers reject it)'
        using errcode = '42501';
    end if;
    perform authz.require_mfa('sales.return.request');
  elsif v_ret.status = 'approved' then
    if authz.customer_in_scope('wf.decide.return', v_ret.customer_id) then
      perform authz.require_mfa('wf.decide.return');
      v_allowed := true;
    elsif authz.has_permission('sales.return.receive') then
      perform authz.require_mfa('sales.return.receive');
      v_allowed := true;
    end if;
    if not v_allowed then
      raise exception 'PERMISSION_DENIED: an approved return is cancelled by a return approver or the warehouse'
        using errcode = '42501';
    end if;
  else
    raise exception 'INVALID_STATE: return is % (only pending or approved, not yet received, returns can be cancelled)',
      v_ret.status using errcode = 'P0001';
  end if;

  update sales.returns set status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid(),
         cancel_reason = v_reason, cancel_idempotency_key = v_key, updated_at = now()
  where id = v_ret.id;
  if v_req_status = 'pending' then
    update wf.approval_requests set status = 'cancelled', decided_at = now()
    where id = v_ret.approval_request_id and status = 'pending';
  end if;

  perform crm._add_activity(v_ret.customer_id, authz.current_employee_id(), 'order',
                            'Return ' || v_ret.return_no || ' cancelled: ' || v_reason, 'sales.returns', v_ret.id);
  if v_ret.created_by is distinct from auth.uid() then
    perform notify.send_in_app(v_ret.created_by, 'return.cancelled', 'Return cancelled: ' || v_ret.return_no, v_reason,
                               '/returns/' || v_ret.id,
                               jsonb_build_object('return_id', v_ret.id, 'return_no', v_ret.return_no, 'status', 'cancelled'));
  end if;
  insert into integration.outbox (event_type, aggregate_type, aggregate_id, payload)
  values ('return.cancelled', 'sales.return', v_ret.id,
          jsonb_build_object('return_id', v_ret.id, 'return_no', v_ret.return_no, 'order_id', v_ret.order_id,
                             'customer_id', v_ret.customer_id, 'from_status', v_from, 'reason', v_reason,
                             'approval_request_id', v_ret.approval_request_id));

  return jsonb_build_object('return_id', v_ret.id, 'return_no', v_ret.return_no, 'status', 'cancelled',
                            'from_status', v_from, 'replayed', false);
end $$;

-- ---------------------------------------------------------------------------
-- 7. Commission engine — from 20261103000400 §3. Change (M-1): the allocation rows that release
--    paid money for a return credit note (credit_note_id set) are not commission events; the
--    credit note itself carries the clawback, so the money is not clawed back twice.
-- ---------------------------------------------------------------------------
create or replace function perf.commission_replay_invoice(p_invoice_id uuid, p_period_id uuid, p_period_start date,
                                                          p_period_end date, p_last_frozen_end date, p_orphan_from date,
                                                          p_clawback_days int, p_run_id uuid)
returns int language plpgsql volatile security definer set search_path = '' as $$
declare
  v_inv record; ev record; v_r record;
  v_ids uuid[]; v_var uuid[]; v_tot numeric[]; v_net numeric[]; v_sku text[]; v_desc text[];
  v_coll numeric[]; v_cred numeric[]; v_comm numeric[]; v_lplan uuid[];
  v_dcoll numeric[]; v_dcred numeric[]; v_dcomm numeric[]; v_rule uuid[]; v_rate numeric[]; v_kind text[];
  v_w numeric[]; v_split numeric[]; v_over numeric;
  v_st_ids uuid[] := '{}'; v_st_dates date[] := '{}';
  n int; i int; v_pos int; v_rows int := 0;
  v_plan uuid; v_frozen boolean; v_emit boolean; v_acct date; v_stored numeric; v_base numeric;
  v_sum numeric; v_total_over numeric; v_line_plan uuid; v_line_rate numeric; v_has_items boolean;
begin
  select i.id, i.invoice_no, i.customer_id, o.employee_id as rep_id, o.order_no, c.display_name as customer_name
    into v_inv
  from finance.invoices i
  join sales.orders o on o.id = i.order_id
  left join crm.customers c on c.id = i.customer_id
  where i.id = p_invoice_id;
  if not found then return 0; end if;

  select array_agg(ii.id order by ii.id), array_agg(ii.variant_id order by ii.id),
         array_agg(ii.line_total order by ii.id), array_agg((ii.line_total - ii.tax_amount) order by ii.id),
         array_agg(pv.sku order by ii.id), array_agg(ii.description order by ii.id)
    into v_ids, v_var, v_tot, v_net, v_sku, v_desc
  from finance.invoice_items ii
  left join catalog.product_variants pv on pv.id = ii.variant_id
  where ii.invoice_id = p_invoice_id and ii.line_total > 0;
  n := coalesce(array_length(v_ids, 1), 0);
  if n = 0 then return 0; end if;
  v_coll := array_fill(0::numeric, array[n]); v_cred := v_coll; v_comm := v_coll;
  v_lplan := array_fill(null::uuid, array[n]);

  for ev in
    select x.* from (
      select 'payment_allocation'::text as source_type, a.id, a.allocated_at as ts,
             (a.allocated_at at time zone 'Africa/Cairo')::date as day, a.amount::numeric as amount,
             null::uuid as reverses, p.payment_no as doc_no, p.status as payment_status, 1 as ord
      from finance.payment_allocations a join finance.payments p on p.id = a.payment_id
      where a.invoice_id = p_invoice_id and a.amount > 0 and a.credit_note_id is null
      union all
      select 'allocation_reversal', a.id, a.allocated_at, (a.allocated_at at time zone 'Africa/Cairo')::date,
             -a.amount, a.reverses_allocation_id, p.payment_no, p.status, 2
      from finance.payment_allocations a join finance.payments p on p.id = a.payment_id
      where a.invoice_id = p_invoice_id and a.amount < 0 and a.credit_note_id is null
      union all
      select 'credit_note', cn.id, cn.created_at, cn.issue_date, (cn.amount + cn.tax_amount)::numeric,
             null, cn.credit_no, null, 0
      from finance.credit_notes cn where cn.invoice_id = p_invoice_id
    ) x
    where x.day <= p_period_end
    order by x.ts, x.ord, x.id
  loop
    v_frozen := exists (select 1 from perf.commission_entries e join perf.commission_periods cp on cp.id = e.period_id
                        where e.source_type = ev.source_type and e.source_id = ev.id
                          and perf.commission_status_frozen(cp.status));
    if not v_frozen and p_last_frozen_end is not null and ev.day <= p_last_frozen_end and ev.day < p_orphan_from then
      v_frozen := true;          -- settled long ago with no rows (e.g. no plan then): stays at zero
    end if;
    v_acct := case when p_last_frozen_end is not null and ev.day <= p_last_frozen_end
                   then (p_last_frozen_end + 1) else date_trunc('month', ev.day)::date end;
    v_emit := not v_frozen and v_acct = p_period_start;

    v_dcoll := array_fill(0::numeric, array[n]); v_dcred := v_dcoll; v_dcomm := v_dcoll; v_rate := v_dcoll;
    v_rule := array_fill(null::uuid, array[n]); v_kind := array_fill(null::text, array[n]);
    v_plan := perf.commission_plan_for(v_inv.rep_id, ev.day);

    if ev.source_type = 'payment_allocation' then
      -- Collection: pays the lines pro rata to what is still open on each.
      v_sum := 0;
      for i in 1..n loop v_w[i] := greatest(v_tot[i] - v_coll[i] - v_cred[i], 0); v_sum := v_sum + v_w[i]; end loop;
      v_split := perf.split_amount(least(ev.amount, v_sum), v_w[1:n]);
      for i in 1..n loop
        continue when v_split[i] <= 0;
        v_dcoll[i] := v_split[i]; v_kind[i] := 'collection';
      end loop;
      v_st_ids := v_st_ids || ev.id; v_st_dates := v_st_dates || ev.day;

    elsif ev.source_type = 'allocation_reversal' then
      -- Reversal / bounce: the money leaves the lines pro rata to what each holds.
      v_pos := array_position(v_st_ids, ev.reverses);
      if v_pos is not null then
        v_st_ids := v_st_ids[:v_pos - 1] || v_st_ids[v_pos + 1:];
        v_st_dates := v_st_dates[:v_pos - 1] || v_st_dates[v_pos + 1:];
      end if;
      v_sum := 0;
      for i in 1..n loop v_sum := v_sum + v_coll[i]; end loop;
      v_split := perf.split_amount(least(ev.amount, v_sum), v_coll);
      for i in 1..n loop
        v_over := least(v_split[i], v_coll[i]);
        continue when v_over <= 0;
        v_dcoll[i] := -v_over;
        v_kind[i] := case when ev.payment_status = 'bounced' then 'bounce' else 'reversal' end;
        v_dcomm[i] := -(case when v_over >= v_coll[i] then v_comm[i] else round(v_comm[i] * v_over / v_coll[i], 2) end);
      end loop;

    else
      -- Credit note: credited gross per line (lines from its items; an amount-only note is
      -- spread over the open amounts).
      v_has_items := exists (select 1 from finance.credit_note_items ci where ci.credit_note_id = ev.id);
      if v_has_items then
        for i in 1..n loop
          select coalesce(sum(ci.amount + ci.tax_amount), 0) into v_stored
          from finance.credit_note_items ci where ci.credit_note_id = ev.id and ci.invoice_item_id = v_ids[i];
          v_dcred[i] := v_stored;
        end loop;
      else
        v_sum := 0;
        for i in 1..n loop v_w[i] := greatest(v_tot[i] - v_coll[i] - v_cred[i], 0); v_sum := v_sum + v_w[i]; end loop;
        v_dcred := perf.split_amount(ev.amount, case when v_sum > 0 then v_w[1:n] else v_tot end);
      end if;

      if coalesce(array_length(v_st_dates, 1), 0) > 0
         and ev.day - (select max(d) from unnest(v_st_dates) d) <= p_clawback_days then
        v_total_over := 0;
        for i in 1..n loop
          v_over := least(greatest(v_dcred[i] - greatest(v_tot[i] - v_coll[i] - v_cred[i], 0), 0), v_coll[i]);
          continue when v_over <= 0;
          v_dcoll[i] := -v_over; v_kind[i] := 'credit_clawback';
          v_dcomm[i] := -(case when v_over >= v_coll[i] then v_comm[i] else round(v_comm[i] * v_over / v_coll[i], 2) end);
          v_total_over := v_total_over + v_over;
        end loop;
        if v_total_over > 0 then
          -- The clawed-back money now pays the invoice's other open lines.
          v_sum := 0;
          for i in 1..n loop
            v_w[i] := greatest(v_tot[i] - (v_coll[i] + v_dcoll[i]) - (v_cred[i] + v_dcred[i]), 0); v_sum := v_sum + v_w[i];
          end loop;
          v_split := perf.split_amount(least(v_total_over, v_sum), v_w[1:n]);
          for i in 1..n loop
            continue when v_split[i] <= 0 or v_kind[i] is not null;
            v_dcoll[i] := v_split[i]; v_kind[i] := 'credit_reattribution';
          end loop;
        end if;
      end if;
    end if;

    -- Bases, rates and the rows of this period.
    for i in 1..n loop
      continue when v_kind[i] is null;
      v_base := round((v_coll[i] + v_dcoll[i]) * v_net[i] / v_tot[i], 2) - round(v_coll[i] * v_net[i] / v_tot[i], 2);
      if v_kind[i] in ('collection','credit_reattribution') then
        if v_plan is not null then
          select * into v_r from perf.commission_rate(v_plan, v_var[i], ev.day);
          v_rule[i] := v_r.o_rule_id; v_rate[i] := coalesce(v_r.o_rate_pct, 0);
        end if;
        v_dcomm[i] := round(v_base * v_rate[i] / 100, 2);
        v_line_plan := v_plan; v_line_rate := v_rate[i];
      else
        v_line_plan := coalesce(v_plan, v_lplan[i]);
        v_line_rate := case when v_base <> 0 then least(round(abs(v_dcomm[i] / v_base) * 100, 2), 100) else 0 end;
      end if;
      if v_emit and v_line_plan is not null and (v_base <> 0 or v_dcomm[i] <> 0) then
        insert into pg_temp.commission_calc (period_id, employee_id, plan_id, rule_id, source_type, source_id,
                                             invoice_item_id, base_amount, rate_pct, commission_amount, calc_run_id,
                                             entry_kind, event_at, event_date, invoice_id, customer_id, snapshot)
        values (p_period_id, v_inv.rep_id, v_line_plan, v_rule[i], ev.source_type, ev.id, v_ids[i], v_base,
                v_line_rate, v_dcomm[i], p_run_id, v_kind[i], ev.ts, ev.day, v_inv.id, v_inv.customer_id,
                jsonb_strip_nulls(jsonb_build_object(
                  'invoice_no', v_inv.invoice_no, 'order_no', v_inv.order_no, 'customer_name', v_inv.customer_name,
                  'sku', v_sku[i], 'description', v_desc[i], 'document_no', ev.doc_no,
                  'reverses_allocation_id', ev.reverses)));
        v_rows := v_rows + 1;
      end if;
    end loop;

    -- State after the event; a frozen event counts with the commission actually posted.
    for i in 1..n loop
      if v_frozen then
        select coalesce(sum(e.commission_amount), 0) into v_stored from perf.commission_entries e
         where e.source_type = ev.source_type and e.source_id = ev.id and e.invoice_item_id = v_ids[i];
        v_comm[i] := v_comm[i] + v_stored;
      else
        v_comm[i] := v_comm[i] + v_dcomm[i];
      end if;
      v_coll[i] := v_coll[i] + v_dcoll[i];
      v_cred[i] := v_cred[i] + v_dcred[i];
      if v_kind[i] in ('collection','credit_reattribution') and v_plan is not null then v_lplan[i] := v_plan; end if;
    end loop;
  end loop;
  return v_rows;
end $$;

-- ---------------------------------------------------------------------------
-- 8. perf.overdue_invoices — from 20261103000500 §6. Change (M-4): no filter on the invoice's
--    current status; write-offs posted by the end of p_as_of are subtracted, so a write-off
--    removes the invoice only from that day on, never from earlier days' figures.
-- ---------------------------------------------------------------------------
create or replace function perf.overdue_invoices(p_as_of date)
returns table (invoice_id uuid, customer_id uuid, due_date date, open_amount numeric)
language sql stable set search_path = '' as $$
  select x.id, x.customer_id, x.due_date, x.open_amount from (
    select i.id, i.customer_id, i.due_date,
           (i.total
            - coalesce((select sum(pa.amount) from finance.payment_allocations pa
                        where pa.invoice_id = i.id and pa.allocated_at < perf.cairo_start(p_as_of + 1)), 0)
            - coalesce((select sum(cn.amount + cn.tax_amount) from finance.credit_notes cn
                        where cn.invoice_id = i.id and cn.issue_date <= p_as_of), 0)
            - coalesce((select sum(w.amount) from finance.invoice_write_offs w
                        where w.invoice_id = i.id and w.posted_at < perf.cairo_start(p_as_of + 1)), 0))::numeric(14,2) as open_amount
    from finance.invoices i
    where i.issue_date <= p_as_of and i.due_date < p_as_of
  ) x where x.open_amount > 0
$$;

-- ---------------------------------------------------------------------------
-- 9. Privileges (explicit; never "all functions in schema api")
-- ---------------------------------------------------------------------------
revoke all on function
  finance.credit_note_amounts(uuid, jsonb, numeric, boolean),
  finance.credit_note_amounts(uuid, jsonb, numeric),
  finance.release_paid_for_credit(uuid, uuid, numeric, text),
  perf.commission_replay_invoice(uuid, uuid, date, date, date, date, int, uuid)
from public, anon, authenticated;
revoke execute on function
  api.request_return(uuid, jsonb, text, uuid),
  api.credit_return(uuid, text),
  api.cancel_return(uuid, text, text)
from public, anon;
grant execute on function
  api.request_return(uuid, jsonb, text, uuid),
  api.credit_return(uuid, text),
  api.cancel_return(uuid, text, text)
to authenticated;
grant select on api.v_returnable_lines, api.v_returns to authenticated;
revoke all on api.v_returnable_lines, api.v_returns from anon;
