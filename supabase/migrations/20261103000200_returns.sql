-- Honest OS migration: Phase 3 task 9 — sales returns into quarantine, and their credit notes.
-- Tests: supabase/tests/database/35_returns.test.sql.
--
-- Contents
--   0. Expand-only schema additions on sales.returns / sales.return_items (tables from
--      20261028000700_sales.sql), audit triggers, no-delete guards, an extra read policy
--   1. Permission catalogue: sales.return.request / .receive / .credit (reference-data pattern)
--   2. Read views: api.v_returnable_lines, api.v_returns, api.v_return_lines
--   3. api.request_return   reps (own customers) ask to take back delivered, invoiced goods;
--                           always through the seeded 'sales.return' workflow (wf.decide.return)
--   4. wf.on_decided_sales_return  decision hook (approved / rejected). Its dispatch branch is in
--                           20261103000299_dispatch.sql
--   5. api.receive_return   inventory posts 'sale_return' movements into a QUARANTINE warehouse only
--   6. api.credit_return    finance issues one credit note per invoice for the returned lines at their
--                           invoiced prices (VAT by finance.credit_note_amounts), linked by return_id
--   7. Privileges
--
-- Rules
--   * Returnable quantity of an order line and lot =
--       least(delivered from that lot − already returned from that lot,
--             invoiced on the line − credited on the line by non-return credit notes − already returned on the line)
--     where "already returned" counts every return that is not rejected (a pending request holds its
--     quantity). Interim rule: only INVOICED goods can be returned, because api.issue_invoice still
--     invoices fulfilled_qty − invoiced_qty and would bill goods returned before invoicing. Lifting it
--     needs the finance change described in the module report.
--   * Movement type: the existing 'sale_return' (inventory.movements CHECK) is the return-in type; no
--     new type is added. It is not 'sale_issue', so the sellable-warehouse trigger lets it into
--     quarantine; stock leaves quarantine only by a transfer with inventory.quarantine.release (D-13).
--   * Lot and expiry are kept: the movement posts to the delivered lot (expiry lives on the lot).
--   * A return credit note does not go through the 'finance.credit_note' workflow: the return itself was
--     approved (sales.return), the goods were physically received, and every amount is computed from
--     the invoice lines. The credit note carries the return's approval_request_id.
--   * Money: the client sends ids, quantities, reason codes and notes only. Every amount is computed here.
--   * Idempotency: request_return takes p_client_ref (device retries); receive_return and credit_return
--     take p_idempotency_key. A replay returns the first result and changes nothing.
--   * Business day: core.business_date() (Cairo).
--
-- Non-destructive: new columns (nullable or defaulted), new CHECKs on new columns, new triggers,
-- policies, views and functions. Nothing is dropped, renamed or narrowed.

-- ---------------------------------------------------------------------------
-- 0. Schema additions (expand only)
-- ---------------------------------------------------------------------------
alter table sales.returns add column if not exists client_ref uuid unique;
alter table sales.returns add column if not exists notes text;
alter table sales.returns add column if not exists approval_request_id uuid references wf.approval_requests(id);
alter table sales.returns add column if not exists decided_at timestamptz;
alter table sales.returns add column if not exists received_at timestamptz;
alter table sales.returns add column if not exists received_by uuid references auth.users(id);
alter table sales.returns add column if not exists receive_idempotency_key text unique;
alter table sales.returns add column if not exists credited_at timestamptz;
alter table sales.returns add column if not exists credited_by uuid references auth.users(id);
alter table sales.returns add column if not exists credit_idempotency_key text unique;
alter table sales.returns add column if not exists updated_at timestamptz not null default now();
create index if not exists idx_returns_order on sales.returns (order_id);
create index if not exists idx_returns_status on sales.returns (status, created_at desc);
create index if not exists idx_returns_customer on sales.returns (customer_id);

alter table sales.return_items add column if not exists reason_code text
  check (reason_code is null or reason_code in ('damaged','defective','wrong_item','expired','near_expiry',
                                                'not_ordered','customer_request','other'));
alter table sales.return_items add column if not exists credited_qty int not null default 0;
alter table sales.return_items add constraint return_items_credited_qty_check
  check (credited_qty >= 0 and credited_qty <= quantity);
create index if not exists idx_return_items_return on sales.return_items (return_id);
create index if not exists idx_return_items_order_item on sales.return_items (order_item_id, lot_id);
create index if not exists idx_credit_notes_return on finance.credit_notes (return_id) where return_id is not null;

-- Returns are documents: never deleted (rejected ones stay as history). Audited like orders.
create trigger trg_returns_no_delete before delete on sales.returns
  for each row execute function core.forbid_mutation();
create trigger trg_return_items_no_delete before delete on sales.return_items
  for each row execute function core.forbid_mutation();
create trigger trg_audit after insert or update or delete on sales.returns
  for each row execute function audit.log_change();
create trigger trg_audit after insert or update or delete on sales.return_items
  for each row execute function audit.log_change();

-- Visibility: the existing returns_select (the order is visible) plus the requester, and the people
-- who handle returns company-wide (receiving, crediting). Additive permissive policy; no recursion
-- (only authz helpers, no other table's policy).
create policy returns_select_handlers on sales.returns for select to authenticated using (
  created_by = (select auth.uid())
  or (select authz.has_global('sales.return.receive'))
  or (select authz.has_global('sales.return.credit'))
  or warehouse_id = any((select authz.warehouse_ids('sales.return.receive'))::uuid[]));

-- ---------------------------------------------------------------------------
-- 1. Permission catalogue (same pattern as 20261028001500_reference_data.sql)
--    sales.return.create stays (the order state machine names it for → returned); the request
--    command checks sales.return.request.
-- ---------------------------------------------------------------------------
insert into authz.permissions (code, module, description, allowed_scopes, supports_limit, is_sensitive) values
  ('sales.return.request', 'sales', 'Request a customer return of delivered goods', '{own,team,territory,all}', false, false),
  ('sales.return.receive', 'sales', 'Receive returned goods into a quarantine warehouse', '{warehouse,all}', false, false),
  ('sales.return.credit', 'sales', 'Issue the credit note of a received return', '{territory,all}', false, true)
on conflict (code) do nothing;

insert into authz.role_permissions (role_id, permission_code, scope, limit_value)
select r.id, v.perm, v.scope, null
from (values
  ('sales_rep',         'sales.return.request', 'own'),
  ('area_manager',      'sales.return.request', 'team'),
  ('sales_director',    'sales.return.request', 'all'),
  ('inventory_manager', 'sales.return.receive', 'all'),
  ('finance_officer',   'sales.return.credit',  'all')
) as v(role_code, perm, scope)
join authz.roles r on r.code = v.role_code
on conflict (role_id, permission_code) do nothing;

-- ---------------------------------------------------------------------------
-- 2. Read views (security_invoker → the caller's RLS applies to every joined table).
--    Commands read api.v_returnable_lines too, as owner, so the rule lives in one place.
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
                     from sales.return_items ri join sales.returns r on r.id = ri.return_id and r.status <> 'rejected'
                     where ri.order_item_id = oi.id and ri.lot_id = f.lot_id) rl on true
  left join lateral (select sum(ri.quantity) as qty
                     from sales.return_items ri join sales.returns r on r.id = ri.return_id and r.status <> 'rejected'
                     where ri.order_item_id = oi.id) rline on true
  left join lateral (select sum(x.quantity) as qty from finance.invoice_items x where x.order_item_id = oi.id) ii on true
  left join lateral (select sum(ci.quantity) as qty
                     from finance.credit_note_items ci
                     join finance.invoice_items x on x.id = ci.invoice_item_id
                     join finance.credit_notes cn on cn.id = ci.credit_note_id and cn.return_id is null
                     where x.order_item_id = oi.id) cr on true
  left join catalog.product_variants v on v.id = oi.variant_id
  left join inventory.lots l on l.id = f.lot_id;

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
         coalesce(cn.n, 0)::int as credit_notes, coalesce(cn.total, 0)::numeric(14,2) as credited_total
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
                     from finance.credit_notes x where x.return_id = r.id) cn on true;

create or replace view api.v_return_lines with (security_invoker = true) as
  select ri.id as return_item_id, ri.return_id, ri.order_item_id, oi.line_no, oi.variant_id,
         v.sku, v.name_en as variant_name, ri.lot_id, l.lot_no, l.expiry_date,
         ri.quantity, ri.credited_qty, ri.reason_code, ri.condition,
         oi.list_price, oi.applied_discount_pct, oi.tax_rate_pct,
         round(oi.line_total * ri.quantity / oi.quantity, 2)::numeric(14,2) as estimated_total
  from sales.return_items ri
  join sales.order_items oi on oi.id = ri.order_item_id
  left join catalog.product_variants v on v.id = oi.variant_id
  left join inventory.lots l on l.id = ri.lot_id;

grant select on api.v_returnable_lines, api.v_returns, api.v_return_lines to authenticated;
revoke all on api.v_returnable_lines, api.v_returns, api.v_return_lines from anon;

-- ---------------------------------------------------------------------------
-- 3. Request a return (always through the 'sales.return' workflow)
-- ---------------------------------------------------------------------------
-- p_lines: [{order_item_id, lot_id?, quantity, reason_code, condition?}]. lot_id may be left out
-- when the line was delivered from one lot only.
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

  -- Replay (before any other check, so a retry after a lost response always gets the first result).
  select * into v_existing from sales.returns where client_ref = p_client_ref;
  if found then
    if v_existing.order_id <> p_order_id then
      raise exception 'IDEMPOTENCY_CONFLICT: client reference was used for another return' using errcode = 'P0001';
    end if;
    return jsonb_build_object('return_id', v_existing.id, 'return_no', v_existing.return_no, 'status', v_existing.status,
                              'approval_request_id', v_existing.approval_request_id, 'replayed', true);
  end if;

  -- The order lock serializes concurrent returns of one order (returnable quantities).
  select * into v_order from sales.orders where id = p_order_id for update;
  if not found then raise exception 'NOT_FOUND: order %', p_order_id using errcode = 'P0002'; end if;
  if not authz.customer_in_scope('sales.return.request', v_order.customer_id) then
    raise exception 'PERMISSION_DENIED: customer not in your scope' using errcode = '42501';
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
-- 4. Decision hook (dispatched for 'sales.return' by 20261103000299_dispatch.sql)
-- ---------------------------------------------------------------------------
create or replace function wf.on_decided_sales_return(p_request_id uuid, p_approved boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare r wf.approval_requests%rowtype; v_ret sales.returns%rowtype; v_to text;
begin
  select * into r from wf.approval_requests where id = p_request_id;
  select * into v_ret from sales.returns where id = r.entity_id for update;
  if not found then raise exception 'NOT_FOUND: return %', r.entity_id using errcode = 'P0002'; end if;
  if v_ret.status not in ('requested','pending_approval') then return; end if;   -- decided already
  v_to := case when p_approved then 'approved' else 'rejected' end;
  update sales.returns set status = v_to, decided_at = now(), updated_at = now(),
         approval_request_id = coalesce(approval_request_id, p_request_id)
  where id = v_ret.id;
  perform notify.send_in_app(v_ret.created_by, 'return.' || v_to,
                             case when p_approved then 'Return approved: ' else 'Return rejected: ' end || v_ret.return_no,
                             null, '/returns/' || v_ret.id,
                             jsonb_build_object('return_id', v_ret.id, 'return_no', v_ret.return_no, 'status', v_to));
  insert into integration.outbox (event_type, aggregate_type, aggregate_id, payload)
  values ('return.' || v_to, 'sales.return', v_ret.id,
          jsonb_build_object('return_id', v_ret.id, 'return_no', v_ret.return_no, 'order_id', v_ret.order_id,
                             'customer_id', v_ret.customer_id, 'approval_request_id', p_request_id));
end $$;

-- ---------------------------------------------------------------------------
-- 5. Receive an approved return into a quarantine warehouse
-- ---------------------------------------------------------------------------
create or replace function api.receive_return(p_return_id uuid, p_warehouse_id uuid, p_idempotency_key text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_key text := nullif(btrim(p_idempotency_key), '');
  v_ret sales.returns%rowtype; v_order sales.orders%rowtype; v_wh inventory.warehouses%rowtype;
  v_it record; v_cost numeric; v_n int := 0; v_open int; v_order_status text;
begin
  perform authz.require('sales.return.receive');
  if v_key is null or length(v_key) > 100 then
    raise exception 'VALIDATION: idempotency key is required' using errcode = 'P0001';
  end if;

  select * into v_ret from sales.returns where id = p_return_id;
  if not found then raise exception 'NOT_FOUND: return %', p_return_id using errcode = 'P0002'; end if;
  -- Lock order first, then the return (the same order as api.request_return).
  select * into v_order from sales.orders where id = v_ret.order_id for update;
  select * into v_ret from sales.returns where id = p_return_id for update;

  if v_ret.receive_idempotency_key = v_key then
    return jsonb_build_object('return_id', v_ret.id, 'status', v_ret.status, 'warehouse_id', v_ret.warehouse_id,
                              'order_status', v_order.status, 'replayed', true);
  end if;
  if exists (select 1 from sales.returns where receive_idempotency_key = v_key) then
    raise exception 'IDEMPOTENCY_CONFLICT: key was used for another return' using errcode = 'P0001';
  end if;

  select * into v_wh from inventory.warehouses where id = p_warehouse_id;
  if not found or not v_wh.is_active then raise exception 'NOT_FOUND: warehouse' using errcode = 'P0002'; end if;
  if not inventory.in_warehouse_scope('sales.return.receive', p_warehouse_id) then
    raise exception 'PERMISSION_DENIED: warehouse not in your scope' using errcode = '42501';
  end if;
  if v_wh.kind <> 'quarantine' then
    raise exception 'WAREHOUSE_NOT_QUARANTINE: returned goods are received into a quarantine warehouse only (D-13)'
      using errcode = 'P0001';
  end if;
  if v_ret.status <> 'approved' then
    raise exception 'INVALID_STATE: return is %', v_ret.status using errcode = 'P0001';
  end if;

  for v_it in
    select ri.id, ri.order_item_id, ri.lot_id, ri.quantity, ri.reason_code, oi.variant_id
    from sales.return_items ri join sales.order_items oi on oi.id = ri.order_item_id
    where ri.return_id = v_ret.id
    order by oi.line_no, ri.lot_id
  loop
    -- Cost basis: the cost the goods left with (their sale_issue on this order), else the catalogue cost.
    select m.unit_cost into v_cost
    from inventory.movements m join sales.fulfillments f on f.id = m.source_doc_id
    where m.source_doc_type = 'fulfillment' and m.movement_type = 'sale_issue' and f.order_id = v_ret.order_id
      and m.variant_id = v_it.variant_id and m.lot_id = v_it.lot_id
    order by m.created_at desc limit 1;
    if v_cost is null then
      select pc.unit_cost into v_cost from catalog.product_costs pc
      where pc.variant_id = v_it.variant_id and pc.effective_from <= core.business_date()
      order by pc.effective_from desc limit 1;
    end if;
    insert into inventory.movements (movement_type, warehouse_id, variant_id, lot_id, quantity, unit_cost, reason_code,
                                     source_doc_type, source_doc_id, idempotency_key, created_by)
    values ('sale_return', p_warehouse_id, v_it.variant_id, v_it.lot_id, v_it.quantity, v_cost, v_it.reason_code,
            'return', v_ret.id, 'return:' || v_ret.id || ':' || v_it.id, auth.uid());
    update sales.order_items set returned_qty = returned_qty + v_it.quantity where id = v_it.order_item_id;
    v_n := v_n + 1;
  end loop;

  update sales.returns set status = 'received', warehouse_id = p_warehouse_id, received_at = now(),
         received_by = auth.uid(), receive_idempotency_key = v_key, updated_at = now()
  where id = v_ret.id;

  -- Everything delivered came back → the order is 'returned' (state machine: invoiced/closed → returned).
  v_order_status := v_order.status;
  select count(*) into v_open from sales.order_items where order_id = v_order.id and returned_qty < fulfilled_qty;
  if v_open = 0 and v_order.status in ('invoiced','closed') then
    perform sales.change_order_status(v_order.id, v_order.status, 'returned', v_ret.return_no,
                                      jsonb_build_object('return_id', v_ret.id, 'return_no', v_ret.return_no));
    v_order_status := 'returned';
  end if;

  perform crm._add_activity(v_ret.customer_id, authz.current_employee_id(), 'order',
                            'Return ' || v_ret.return_no || ' received into ' || v_wh.code, 'sales.returns', v_ret.id);
  perform notify.send_in_app(v_ret.created_by, 'return.received', 'Return received: ' || v_ret.return_no, null,
                             '/returns/' || v_ret.id,
                             jsonb_build_object('return_id', v_ret.id, 'return_no', v_ret.return_no, 'status', 'received'));
  insert into integration.outbox (event_type, aggregate_type, aggregate_id, payload)
  values ('return.received', 'sales.return', v_ret.id,
          jsonb_build_object('return_id', v_ret.id, 'return_no', v_ret.return_no, 'order_id', v_ret.order_id,
                             'customer_id', v_ret.customer_id, 'warehouse_id', p_warehouse_id, 'warehouse_code', v_wh.code,
                             'lines', v_n, 'order_status', v_order_status));

  return jsonb_build_object('return_id', v_ret.id, 'status', 'received', 'warehouse_id', p_warehouse_id,
                            'movements', v_n, 'order_status', v_order_status, 'replayed', false);
end $$;

-- ---------------------------------------------------------------------------
-- 6. Credit a received return: one credit note per invoice, at the invoiced prices
-- ---------------------------------------------------------------------------
create or replace function api.credit_return(p_return_id uuid, p_idempotency_key text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_key text := nullif(btrim(p_idempotency_key), '');
  v_ret sales.returns%rowtype; v_need record; v_ii record; v_left int; v_take int;
  v_alloc jsonb := '[]'::jsonb; v_inv_row record; v_inv finance.invoices%rowtype; v_calc jsonb;
  v_cn uuid; v_cn_no text; v_n int := 0; v_notes jsonb := '[]'::jsonb; v_sum numeric := 0;
  v_today date := core.business_date();
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
                                                                    'total', cn.amount + cn.tax_amount) order by cn.credit_no)
                                from finance.credit_notes cn where cn.return_id = v_ret.id), '[]'::jsonb),
      'total', (select coalesce(sum(cn.amount + cn.tax_amount), 0) from finance.credit_notes cn where cn.return_id = v_ret.id));
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
    -- Amounts and VAT exactly as finance computes a quantity credit note (incl. the last-unit remainder
    -- and the open-amount check).
    v_calc := finance.credit_note_amounts(v_inv.id, v_inv_row.lines, null);
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
    perform finance.post_ledger(v_inv.customer_id, 'credit_note', -(v_calc ->> 'total')::numeric, 'finance.credit_notes', v_cn);
    perform finance.refresh_invoice_status(v_inv.id);
    perform crm._add_activity(v_inv.customer_id, authz.current_employee_id(), 'invoice',
                              'Credit note ' || v_cn_no || ' on ' || v_inv.invoice_no || ' for return ' || v_ret.return_no,
                              'finance.credit_notes', v_cn);
    insert into integration.outbox (event_type, aggregate_type, aggregate_id, payload)
    values ('credit_note.issued', 'finance.credit_note', v_cn,
            jsonb_build_object('credit_note_id', v_cn, 'credit_no', v_cn_no, 'invoice_id', v_inv.id,
                               'invoice_no', v_inv.invoice_no, 'customer_id', v_inv.customer_id,
                               'return_id', v_ret.id, 'return_no', v_ret.return_no,
                               'amount', (v_calc ->> 'amount')::numeric, 'tax_amount', (v_calc ->> 'tax_amount')::numeric,
                               'total', (v_calc ->> 'total')::numeric, 'issue_date', v_today, 'currency', v_inv.currency));
    v_sum := v_sum + (v_calc ->> 'total')::numeric;
    v_notes := v_notes || jsonb_build_object('credit_note_id', v_cn, 'credit_no', v_cn_no, 'invoice_id', v_inv.id,
                                             'amount', (v_calc ->> 'amount')::numeric,
                                             'tax_amount', (v_calc ->> 'tax_amount')::numeric,
                                             'total', (v_calc ->> 'total')::numeric);
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
                             'customer_id', v_ret.customer_id, 'total', v_sum, 'credit_notes', v_notes));

  return jsonb_build_object('return_id', v_ret.id, 'status', 'credited', 'credit_notes', v_notes, 'total', v_sum,
                            'replayed', false);
end $$;

-- ---------------------------------------------------------------------------
-- 7. Privileges (explicit; never "all functions in schema api")
-- ---------------------------------------------------------------------------
revoke execute on function wf.on_decided_sales_return(uuid, boolean) from public, anon, authenticated;
revoke execute on function
  api.request_return(uuid, jsonb, text, uuid),
  api.receive_return(uuid, uuid, text),
  api.credit_return(uuid, text)
from public, anon;
grant execute on function
  api.request_return(uuid, jsonb, text, uuid),
  api.receive_return(uuid, uuid, text),
  api.credit_return(uuid, text)
to authenticated;
