-- Honest OS migration: replay-safe order draft saves for the offline queue (Phase 3, offline order drafts).
--
-- Why: the order builder now saves drafts through the device queue (docs/ARCHITECTURE.md §6, A-05:
-- "Order: draft only; submit requires online"). The queue re-sends a save whose answer was lost.
-- api.save_order_draft (20261029000300) was replay-safe only for the creating call, and only while the
-- draft was still at version 1:
--   * a lost answer to an edit (p_version = N, applied → N + 1) was re-sent as CONFLICT, although applied;
--   * a late replay of the creating call after a later edit was CONFLICT;
--   * a late replay after the order was submitted was INVALID_STATE.
-- The device would then show "failed/conflict" for work the server already has.
--
-- Fix (additive; same signature, same answer keys):
--   * sales.order_draft_saves records every applied save under its idempotency key
--     (order id, base version: 0 for the creating call, else the p_version it was based on), with the
--     caller and a fingerprint of the request (customer, lines, notes, visit, employee).
--   * api.save_order_draft first looks the key up. The same caller sending the same request under the
--     same key is a replay: nothing changes and the current draft comes back with "replayed": true
--     (also once the order has moved on, e.g. submitted). A different request under a used key is not a
--     replay: it falls through to the old checks, so a stale edit is still CONFLICT ("current version N",
--     which the device queue turns into its conflict state) and a submitted order is still INVALID_STATE.
--   * The order row is now locked before that lookup, so two concurrent sends of the same save serialise
--     and the second one is answered as a replay.
-- Every other rule is unchanged (scope, blocked customers, line validation, no client prices).
-- Tests: supabase/tests/database/36_orders_offline.test.sql.

-- ---------------------------------------------------------------------------
-- 1. Idempotency record of applied draft saves (technical; sales.orders and sales.order_items, which
--    carry the business change, are already audited). Not readable by clients: RLS on, no policy,
--    no grants. Only api.save_order_draft (SECURITY DEFINER) writes and reads it.
-- ---------------------------------------------------------------------------
create table sales.order_draft_saves (
  order_id       uuid not null references sales.orders(id),
  base_version   int  not null check (base_version >= 0),   -- 0 = the creating call (p_version null)
  saved_by       uuid not null references auth.users(id),
  fingerprint    text not null,                             -- md5 of the request, see api.save_order_draft
  result_version int  not null check (result_version >= 1),
  saved_at       timestamptz not null default now(),
  primary key (order_id, base_version)
);
comment on table sales.order_draft_saves is
  'Idempotency keys of applied api.save_order_draft calls: (order id, base version) → caller, request fingerprint, resulting version.';

alter table sales.order_draft_saves enable row level security;
revoke all on sales.order_draft_saves from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. The draft as api.save_order_draft answers it (shared by the save and the replay path).
--    Internal: called only from the SECURITY DEFINER command.
-- ---------------------------------------------------------------------------
create or replace function sales.order_draft_answer(p_order_id uuid, p_created boolean, p_replayed boolean)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'order_id', o.id, 'version', o.version, 'status', o.status, 'created', p_created, 'replayed', p_replayed,
    'subtotal', o.subtotal, 'discount_total', o.discount_total, 'tax_total', o.tax_total,
    'indicative_total', o.subtotal - o.discount_total + o.tax_total,
    'lines', coalesce((select jsonb_agg(jsonb_build_object('line_no', i.line_no, 'variant_id', i.variant_id,
                                'quantity', i.quantity, 'list_price', i.list_price,
                                'applied_discount_pct', i.applied_discount_pct, 'line_total', i.line_total) order by i.line_no)
                       from sales.order_items i where i.order_id = o.id), '[]'::jsonb))
  from sales.orders o where o.id = p_order_id
$$;
revoke execute on function sales.order_draft_answer(uuid, boolean, boolean) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. api.save_order_draft: from 20261029000300_orders_inventory_workflow.sql. Changes are marked
--    "offline drafts": the request fingerprint, the order lock moved up, the replay lookup, and the
--    idempotency record written after a save.
-- ---------------------------------------------------------------------------
create or replace function api.save_order_draft(p_order_id uuid, p_customer_id uuid, p_lines jsonb,
                                                p_notes text default null, p_visit_id uuid default null,
                                                p_version int default null, p_employee_id uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid(); v_me uuid := authz.current_employee_id(); v_emp uuid;
  v_order sales.orders%rowtype; v_cust crm.customers%rowtype; v_is_new boolean;
  v_rec record; v_variant uuid; v_qty numeric; v_disc numeric; v_tot record; v_version int;
  v_fp text; v_base int;
begin
  perform authz.require('sales.order.create');
  if p_order_id is null then raise exception 'VALIDATION: order id is required' using errcode = 'P0001'; end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' then
    raise exception 'VALIDATION: lines must be a JSON array' using errcode = 'P0001';
  end if;
  if jsonb_array_length(p_lines) > 200 then
    raise exception 'VALIDATION: at most 200 lines per order' using errcode = 'P0001';
  end if;

  -- Offline drafts: lock the order first, then answer a replay of a save this caller already applied.
  -- Idempotency key = (order id, base version); the fingerprint makes sure it is the same request.
  v_emp := coalesce(p_employee_id, v_me);
  v_fp := md5(jsonb_build_object('customer_id', p_customer_id, 'lines', p_lines, 'notes', p_notes,
                                 'visit_id', p_visit_id, 'employee_id', v_emp)::text);
  select * into v_order from sales.orders where id = p_order_id for update;
  v_is_new := not found;
  if not v_is_new and exists (
       select 1 from sales.order_draft_saves s
       where s.order_id = p_order_id and s.base_version = coalesce(p_version, 0)
         and s.saved_by = v_uid and s.fingerprint = v_fp) then
    return sales.order_draft_answer(p_order_id, false, true);
  end if;

  -- Customer in the caller's CRM scope (same rule as api.visit_check_in).
  select * into v_cust from crm.customers where id = p_customer_id;
  if not found then raise exception 'NOT_FOUND: customer' using errcode = 'P0002'; end if;
  if not (authz.has_global('crm.customer.read')
          or v_cust.territory_id = any(authz.territory_ids('crm.customer.read'))
          or p_customer_id = any(authz.assigned_customer_ids('crm.customer.read'))) then
    raise exception 'PERMISSION_DENIED: customer not in your scope' using errcode = '42501';
  end if;
  if v_cust.archived_at is not null or v_cust.lifecycle_stage = 'blocked' then
    raise exception 'CUSTOMER_BLOCKED: customer is archived or blocked' using errcode = 'P0001';
  end if;

  -- Whose order: the caller, or (managers) an employee within sales.order.create scope.
  if v_emp is null then raise exception 'NO_EMPLOYEE_PROFILE' using errcode = '42501'; end if;
  if v_emp is distinct from v_me and not (authz.has_global('sales.order.create')
                                          or v_emp = any(authz.employee_ids('sales.order.create'))) then
    raise exception 'PERMISSION_DENIED: employee is outside your scope' using errcode = '42501';
  end if;

  if p_visit_id is not null and not exists (
       select 1 from field.visits where id = p_visit_id and customer_id = p_customer_id) then
    raise exception 'VALIDATION: visit does not belong to this customer' using errcode = 'P0001';
  end if;

  if v_is_new then
    insert into sales.orders (id, customer_id, employee_id, visit_id, notes, payment_terms_days, created_by)
    values (p_order_id, p_customer_id, v_emp, p_visit_id, p_notes, v_cust.payment_terms_days, v_uid)
    returning * into v_order;
    insert into sales.order_status_history (order_id, from_status, to_status, changed_by, reason)
    values (p_order_id, null, 'draft', v_uid, 'draft created');
  else
    if not (authz.has_global('sales.order.create')
            or v_order.employee_id = any(authz.employee_ids('sales.order.create'))
            or v_order.created_by = v_uid) then
      raise exception 'PERMISSION_DENIED: order belongs to another representative' using errcode = '42501';
    end if;
    if v_order.status <> 'draft' then
      raise exception 'INVALID_STATE: order is %', v_order.status using errcode = 'P0001';
    end if;
    -- Optimistic concurrency. A NULL version is accepted only as a replay of the creating call.
    if p_version is null then
      if not (v_order.version = 1 and v_order.created_by = v_uid) then
        raise exception 'CONFLICT: order changed (current version %)', v_order.version using errcode = 'P0001';
      end if;
    elsif p_version <> v_order.version then
      raise exception 'CONFLICT: order changed (current version %)', v_order.version using errcode = 'P0001';
    end if;
    delete from sales.order_items where order_id = p_order_id;     -- draft lines only; no reservations exist
    update sales.orders set customer_id = p_customer_id, employee_id = v_emp, visit_id = p_visit_id,
           notes = p_notes, payment_terms_days = v_cust.payment_terms_days,
           version = case when p_version is null then version else version + 1 end, updated_at = now()
    where id = p_order_id;
  end if;

  for v_rec in select e.line, e.n from jsonb_array_elements(p_lines) with ordinality as e(line, n) loop
    if jsonb_typeof(v_rec.line) <> 'object' then
      raise exception 'VALIDATION: line % must be an object', v_rec.n using errcode = 'P0001';
    end if;
    if exists (select 1 from jsonb_object_keys(v_rec.line) k
               where k not in ('variant_id','quantity','requested_discount_pct')) then
      raise exception 'VALIDATION: line % may only contain variant_id, quantity, requested_discount_pct', v_rec.n
        using errcode = 'P0001';
    end if;
    v_variant := core.try_cast_uuid(v_rec.line ->> 'variant_id');
    if v_variant is null then raise exception 'VALIDATION: line % has no valid variant_id', v_rec.n using errcode = 'P0001'; end if;
    if jsonb_typeof(v_rec.line -> 'quantity') is distinct from 'number' then
      raise exception 'VALIDATION: line % quantity must be a number', v_rec.n using errcode = 'P0001';
    end if;
    v_qty := (v_rec.line ->> 'quantity')::numeric;
    if v_qty <> trunc(v_qty) or v_qty <= 0 or v_qty > 100000 then
      raise exception 'VALIDATION: line % quantity must be a whole number between 1 and 100000', v_rec.n using errcode = 'P0001';
    end if;
    if coalesce(jsonb_typeof(v_rec.line -> 'requested_discount_pct'), 'null') = 'null' then
      v_disc := 0;
    elsif jsonb_typeof(v_rec.line -> 'requested_discount_pct') <> 'number' then
      raise exception 'VALIDATION: line % discount must be a number', v_rec.n using errcode = 'P0001';
    else
      v_disc := (v_rec.line ->> 'requested_discount_pct')::numeric;
    end if;
    if v_disc < 0 or v_disc > 100 then
      raise exception 'VALIDATION: line % discount must be between 0 and 100', v_rec.n using errcode = 'P0001';
    end if;
    if not exists (select 1 from catalog.product_variants pv join catalog.products p on p.id = pv.product_id
                   where pv.id = v_variant and pv.status = 'active' and p.status = 'active') then
      raise exception 'NOT_FOUND: variant % is not sellable', v_variant using errcode = 'P0002';
    end if;
    insert into sales.order_items (order_id, line_no, variant_id, quantity, list_price, requested_discount_pct,
                                   tax_rate_pct, line_subtotal, line_discount, line_tax, line_total)
    values (p_order_id, v_rec.n, v_variant, v_qty::int, 0, round(v_disc, 2), 0, 0, 0, 0, 0);
  end loop;

  select * into v_tot from sales.price_order(p_order_id);
  update sales.orders set subtotal = v_tot.o_subtotal, discount_total = v_tot.o_discount, tax_total = v_tot.o_tax,
         total = v_tot.o_subtotal - v_tot.o_discount + v_tot.o_tax
  where id = p_order_id returning version into v_version;

  -- Offline drafts: remember the applied save under its key. A NULL-version re-save of a new draft
  -- (still version 1) replaces the record of the creating call.
  v_base := case when v_is_new then 0 else coalesce(p_version, 0) end;
  insert into sales.order_draft_saves (order_id, base_version, saved_by, fingerprint, result_version)
  values (p_order_id, v_base, v_uid, v_fp, v_version)
  on conflict (order_id, base_version) do update
    set saved_by = excluded.saved_by, fingerprint = excluded.fingerprint,
        result_version = excluded.result_version, saved_at = now();

  return sales.order_draft_answer(p_order_id, v_is_new, false);
end $$;

-- ---------------------------------------------------------------------------
-- 4. Privileges (unchanged, restated explicitly; CLAUDE.md gotcha on PUBLIC execute).
-- ---------------------------------------------------------------------------
revoke execute on function api.save_order_draft(uuid, uuid, jsonb, text, uuid, int, uuid) from public, anon;
grant execute on function api.save_order_draft(uuid, uuid, jsonb, text, uuid, int, uuid) to authenticated;
