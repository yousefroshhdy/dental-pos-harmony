-- Honest OS migration: fixes for the Phase 3 audit (2026-10-29). Regression tests:
-- supabase/tests/database/25_audit_phase3.test.sql.
--
--   F1  customer-specific price lists are visible only to price managers (company-wide
--       catalog.price.manage) or to callers who can see a customer the list is assigned to
--   F2  a discontinued variant/product cannot be submitted or reserved (NOT_SELLABLE, P0001)
--   F3  stock leaves a quarantine warehouse only with inventory.quarantine.release (D-13)
--   F4  a cancelled customer price list assignment no longer blocks a new one
--   F5  the DEFAULT list cannot start in the future (it must always be current)
--   F6  api.assign_customer_price_list cannot back-date an end date
--   F7  api.find_duplicate_customers reveals only a flag for matches outside the caller's scope
--   F10 business dates are the Cairo calendar day (core.business_date()), not the UTC one
--
-- Non-destructive: one permission + one role grant (reference data), two new helpers,
-- alter policy, create or replace function / view with unchanged signatures and columns.
-- Every replaced function starts from its latest definition (noted per function).

-- ---------------------------------------------------------------------------
-- F10. The business day. Egypt's calendar day (DST-aware), never the session's or UTC's.
-- Invoker, stable, reveals nothing: callable by everyone (views and defaults use it).
-- ---------------------------------------------------------------------------
create or replace function core.business_date() returns date
language sql stable set search_path = '' as $$
  select (now() at time zone 'Africa/Cairo')::date
$$;
comment on function core.business_date() is 'Today in Africa/Cairo (company.timezone). Use instead of current_date.';
grant execute on function core.business_date() to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- F3. Permission catalogue (same pattern as 20261028001500_reference_data.sql).
-- ---------------------------------------------------------------------------
insert into authz.permissions (code, module, description, supports_limit, is_sensitive)
values ('inventory.quarantine.release', 'inventory',
        'Release quarantined stock (transfer it out of a quarantine warehouse)', false, true)
on conflict (code) do nothing;

insert into authz.role_permissions (role_id, permission_code, scope, limit_value)
select r.id, 'inventory.quarantine.release', 'all', null
from authz.roles r where r.code = 'inventory_manager'
on conflict (role_id, permission_code) do nothing;

-- ---------------------------------------------------------------------------
-- F1. Price list visibility.
-- ---------------------------------------------------------------------------
-- Ids of the price lists the caller may read. SECURITY DEFINER so the policies below do
-- not recurse through crm.customers / catalog.customer_price_lists RLS (same pattern as
-- authz.assigned_customer_ids). The caller's grants are computed once (materialized).
create or replace function catalog.readable_price_list_ids() returns uuid[]
language sql stable security definer set search_path = '' as $$
  with me as materialized (
    select authz.has_permission('catalog.price.read')     as can_read,
           authz.has_global('catalog.price.manage')       as is_manager,
           authz.has_global('crm.customer.read')          as all_customers,
           authz.territory_ids('crm.customer.read')       as territories,
           authz.assigned_customer_ids('crm.customer.read') as assigned
  )
  select coalesce(array_agg(pl.id), '{}')
  from me
  join catalog.price_lists pl on me.can_read
  where pl.kind <> 'customer'
     or me.is_manager
     or exists (select 1 from catalog.customer_price_lists cpl
                join crm.customers c on c.id = cpl.customer_id
                where cpl.price_list_id = pl.id
                  and (me.all_customers or c.territory_id = any(me.territories) or c.id = any(me.assigned)))
$$;
revoke execute on function catalog.readable_price_list_ids() from public, anon;
grant execute on function catalog.readable_price_list_ids() to authenticated;

-- Server pricing (sales.resolve_list_price, SECURITY DEFINER) is not affected by these.
alter policy price_lists_select on catalog.price_lists
  using (id = any((select catalog.readable_price_list_ids())::uuid[]));
alter policy price_items_select on catalog.price_list_items
  using (price_list_id = any((select catalog.readable_price_list_ids())::uuid[]));

-- ---------------------------------------------------------------------------
-- F2 + F10. Pricing: from 20261029000300_orders_inventory_workflow.sql. Changes: every line
-- must be sellable (active variant of an active product), and the Cairo business day is
-- used for list validity and promotions.
-- ---------------------------------------------------------------------------
create or replace function sales.price_order(p_order_id uuid,
  out o_subtotal numeric, out o_discount numeric, out o_tax numeric, out o_max_manual numeric)
language plpgsql security definer set search_path = '' as $$
declare v_customer uuid; v_item record; v_price record; v_promo numeric; v_applied numeric;
        v_today date := core.business_date(); v_sku text;
begin
  select customer_id into v_customer from sales.orders where id = p_order_id;
  for v_item in select * from sales.order_items where order_id = p_order_id order by line_no for update loop
    -- Audit F2: a variant (or its product) discontinued after the draft was saved is refused.
    if not exists (select 1 from catalog.product_variants pv join catalog.products p on p.id = pv.product_id
                   where pv.id = v_item.variant_id and pv.status = 'active' and p.status = 'active') then
      select sku into v_sku from catalog.product_variants where id = v_item.variant_id;
      raise exception 'NOT_SELLABLE: % is no longer sold (discontinued or inactive)', coalesce(v_sku, v_item.variant_id::text)
        using errcode = 'P0001';
    end if;
    select * into v_price from sales.resolve_list_price(v_customer, v_item.variant_id, v_item.quantity, v_today);
    if v_price.unit_price is null then
      raise exception 'NO_PRICE: variant % has no active price', v_item.variant_id using errcode = 'P0001';
    end if;
    select coalesce(max(d.discount_pct), 0) into v_promo
    from sales.discount_rules d
    join catalog.product_variants pv on pv.id = v_item.variant_id
    join catalog.products p on p.id = pv.product_id
    where d.is_active and v_today between d.valid_from and coalesce(d.valid_to, v_today)
      and v_item.quantity >= d.min_qty
      and (d.variant_id is null or d.variant_id = v_item.variant_id)
      and (d.brand_id is null or d.brand_id = p.brand_id)
      and (d.category_id is null or d.category_id = p.category_id)
      and (d.customer_id is null or d.customer_id = v_customer);
    v_applied := greatest(v_promo, v_item.requested_discount_pct);
    update sales.order_items oi set
      list_price           = v_price.unit_price,
      price_list_id        = v_price.price_list_id,
      promo_discount_pct   = v_promo,
      applied_discount_pct = v_applied,
      tax_rate_pct         = p.tax_rate_pct,
      line_subtotal        = round(v_price.unit_price * v_item.quantity, 2),
      line_discount        = round(v_price.unit_price * v_item.quantity * v_applied / 100, 2),
      line_tax             = round((v_price.unit_price * v_item.quantity
                                    - round(v_price.unit_price * v_item.quantity * v_applied / 100, 2)) * p.tax_rate_pct / 100, 2),
      line_total           = round(v_price.unit_price * v_item.quantity, 2)
                             - round(v_price.unit_price * v_item.quantity * v_applied / 100, 2)
                             + round((v_price.unit_price * v_item.quantity
                                      - round(v_price.unit_price * v_item.quantity * v_applied / 100, 2)) * p.tax_rate_pct / 100, 2)
    from catalog.product_variants pv join catalog.products p on p.id = pv.product_id
    where oi.id = v_item.id and pv.id = oi.variant_id;
  end loop;
  select coalesce(sum(line_subtotal),0), coalesce(sum(line_discount),0), coalesce(sum(line_tax),0),
         coalesce(max(requested_discount_pct - promo_discount_pct), 0)
    into o_subtotal, o_discount, o_tax, o_max_manual
  from sales.order_items where order_id = p_order_id;
end $$;

-- From 20261029000300_orders_inventory_workflow.sql. Changes: unsellable lines are refused
-- (F2) and lot expiry is judged on the Cairo business day (F10).
create or replace function api.reserve_order(p_order_id uuid, p_warehouse_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_order sales.orders%rowtype; v_item record; v_bal record;
  v_need int; v_take int; v_out jsonb := '[]'::jsonb;
  v_today date := core.business_date();
begin
  perform authz.require('sales.order.fulfil');
  if not (authz.has_global('sales.order.fulfil') or p_warehouse_id = any(authz.warehouse_ids('sales.order.fulfil'))) then
    raise exception 'PERMISSION_DENIED: warehouse not in your scope' using errcode = '42501';
  end if;
  if not exists (select 1 from inventory.warehouses where id = p_warehouse_id and is_active) then
    raise exception 'NOT_FOUND: warehouse' using errcode = 'P0002';
  end if;
  select * into v_order from sales.orders where id = p_order_id for update;
  if not found then raise exception 'NOT_FOUND: order %', p_order_id using errcode = 'P0002'; end if;
  if v_order.status <> 'approved' then
    raise exception 'INVALID_STATE: order is %', v_order.status using errcode = 'P0001';
  end if;
  if sales.has_pending_cancel(p_order_id) then
    raise exception 'CANCEL_PENDING: a cancellation request is pending' using errcode = 'P0001';
  end if;

  for v_item in select oi.*, pv.sku, (pv.status = 'active' and p.status = 'active') as is_sellable
                from sales.order_items oi
                join catalog.product_variants pv on pv.id = oi.variant_id
                join catalog.products p on p.id = pv.product_id
                where oi.order_id = p_order_id order by oi.line_no loop
    v_need := v_item.quantity - v_item.fulfilled_qty
              - coalesce((select sum(quantity) from inventory.reservations
                          where order_item_id = v_item.id and status = 'active'), 0);
    if v_need <= 0 then continue; end if;
    -- Audit F2: no new reservation for a discontinued variant/product (e.g. a recall).
    if not v_item.is_sellable then
      raise exception 'NOT_SELLABLE: % is no longer sold (discontinued or inactive)', v_item.sku using errcode = 'P0001';
    end if;
    -- Lock in lot_id order (the order fulfilment/transfers use) before allocating in FEFO order.
    perform 1 from inventory.stock_balances b
    where b.warehouse_id = p_warehouse_id and b.variant_id = v_item.variant_id
    order by b.lot_id for update;
    for v_bal in
      select b.lot_id, b.on_hand, b.reserved, l.lot_no, l.expiry_date
      from inventory.stock_balances b join inventory.lots l on l.id = b.lot_id
      where b.warehouse_id = p_warehouse_id and b.variant_id = v_item.variant_id
        and b.on_hand - b.reserved > 0
        and (l.expiry_date is null or l.expiry_date >= v_today)
      order by l.expiry_date nulls last, l.lot_no, b.lot_id
      for update of b
    loop
      exit when v_need = 0;
      v_take := least(v_need, v_bal.on_hand - v_bal.reserved);
      update inventory.stock_balances set reserved = reserved + v_take, updated_at = now()
      where warehouse_id = p_warehouse_id and variant_id = v_item.variant_id and lot_id = v_bal.lot_id;
      insert into inventory.reservations (order_item_id, warehouse_id, variant_id, lot_id, quantity)
      values (v_item.id, p_warehouse_id, v_item.variant_id, v_bal.lot_id, v_take);
      v_out := v_out || jsonb_build_object('order_item_id', v_item.id, 'lot_id', v_bal.lot_id, 'lot_no', v_bal.lot_no,
                                           'expiry_date', v_bal.expiry_date, 'quantity', v_take);
      v_need := v_need - v_take;
    end loop;
    if v_need > 0 then
      raise exception 'INSUFFICIENT_STOCK: % short by % in this warehouse', v_item.sku, v_need using errcode = 'P0001';
    end if;
  end loop;

  perform sales.change_order_status(p_order_id, 'approved', 'reserved', null,
                                    jsonb_build_object('warehouse_id', p_warehouse_id));
  return jsonb_build_object('order_id', p_order_id, 'status', 'reserved', 'reservations', v_out,
                            'backordered', '[]'::jsonb);
end $$;

-- ---------------------------------------------------------------------------
-- F3. Quarantine release (working decision D-13): stock leaves a quarantine warehouse only
-- with inventory.quarantine.release in the scope of that warehouse. Any destination other
-- than another quarantine warehouse counts (a transit warehouse would otherwise launder
-- the stock into a sellable one in two steps). Checked when the transfer is created and
-- again when it is received, which is the moment the stock becomes sellable.
-- ---------------------------------------------------------------------------
create or replace function inventory.assert_quarantine_release(p_from uuid, p_to uuid) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if (select kind from inventory.warehouses where id = p_from) = 'quarantine'
     and (select kind from inventory.warehouses where id = p_to) is distinct from 'quarantine'
     and not inventory.in_warehouse_scope('inventory.quarantine.release', p_from) then
    raise exception 'PERMISSION_DENIED: moving stock out of quarantine needs inventory.quarantine.release'
      using errcode = '42501';
  end if;
end $$;
revoke execute on function inventory.assert_quarantine_release(uuid, uuid) from public, anon, authenticated;

-- From 20261029000300_orders_inventory_workflow.sql. Change: the quarantine release check.
create or replace function api.create_transfer(p_from uuid, p_to uuid, p_items jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_no text; v_rec record; v_variant uuid; v_lot uuid; v_qty numeric;
begin
  perform authz.require('inventory.transfer.create');
  if not inventory.in_warehouse_scope('inventory.transfer.create', p_from) then
    raise exception 'PERMISSION_DENIED: source warehouse not in your scope' using errcode = '42501';
  end if;
  if p_from is not distinct from p_to then raise exception 'VALIDATION: source and destination must differ' using errcode = 'P0001'; end if;
  if (select count(*) from inventory.warehouses where id in (p_from, p_to) and is_active) <> 2 then
    raise exception 'NOT_FOUND: warehouse' using errcode = 'P0002';
  end if;
  perform inventory.assert_quarantine_release(p_from, p_to);
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'VALIDATION: items must be a non-empty JSON array' using errcode = 'P0001';
  end if;
  v_no := core.next_document_no('TRF');
  insert into inventory.transfers (transfer_no, from_warehouse_id, to_warehouse_id, status, requested_by)
  values (v_no, p_from, p_to, 'draft', auth.uid()) returning id into v_id;
  for v_rec in select e.item, e.n from jsonb_array_elements(p_items) with ordinality as e(item, n) loop
    if jsonb_typeof(v_rec.item) <> 'object' or exists (
         select 1 from jsonb_object_keys(v_rec.item) k where k not in ('variant_id','lot_id','quantity')) then
      raise exception 'VALIDATION: item % may only contain variant_id, lot_id, quantity', v_rec.n using errcode = 'P0001';
    end if;
    v_variant := core.try_cast_uuid(v_rec.item ->> 'variant_id');
    v_lot := core.try_cast_uuid(v_rec.item ->> 'lot_id');
    if v_variant is null or v_lot is null
       or not exists (select 1 from inventory.lots where id = v_lot and variant_id = v_variant) then
      raise exception 'VALIDATION: item % lot does not belong to the variant', v_rec.n using errcode = 'P0001';
    end if;
    if jsonb_typeof(v_rec.item -> 'quantity') is distinct from 'number' then
      raise exception 'VALIDATION: item % quantity must be a number', v_rec.n using errcode = 'P0001';
    end if;
    v_qty := (v_rec.item ->> 'quantity')::numeric;
    if v_qty <> trunc(v_qty) or v_qty <= 0 or v_qty > 1000000 then
      raise exception 'VALIDATION: item % quantity must be a positive whole number', v_rec.n using errcode = 'P0001';
    end if;
    insert into inventory.transfer_items (transfer_id, variant_id, lot_id, quantity)
    values (v_id, v_variant, v_lot, v_qty::int);
  end loop;
  return jsonb_build_object('transfer_id', v_id, 'transfer_no', v_no, 'status', 'draft');
end $$;

-- From 20261029000300_orders_inventory_workflow.sql. Change: the quarantine release check.
create or replace function api.receive_transfer(p_transfer_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_t inventory.transfers%rowtype; v_item record;
begin
  perform authz.require('inventory.transfer.receive');
  select * into v_t from inventory.transfers where id = p_transfer_id for update;
  if not found then raise exception 'NOT_FOUND: transfer' using errcode = 'P0002'; end if;
  if not inventory.in_warehouse_scope('inventory.transfer.receive', v_t.to_warehouse_id) then
    raise exception 'PERMISSION_DENIED: destination warehouse not in your scope' using errcode = '42501';
  end if;
  if v_t.status <> 'in_transit' then
    raise exception 'INVALID_STATE: transfer is %', v_t.status using errcode = 'P0001';
  end if;
  perform inventory.assert_quarantine_release(v_t.from_warehouse_id, v_t.to_warehouse_id);
  for v_item in select * from inventory.transfer_items where transfer_id = p_transfer_id order by variant_id, lot_id loop
    insert into inventory.movements (movement_type, warehouse_id, variant_id, lot_id, quantity,
                                     source_doc_type, source_doc_id, idempotency_key, created_by)
    values ('transfer_in', v_t.to_warehouse_id, v_item.variant_id, v_item.lot_id, v_item.quantity,
            'transfer', p_transfer_id, 'transfer_in:' || v_item.id, auth.uid());
    update inventory.transfer_items set received_qty = quantity where id = v_item.id;
  end loop;
  update inventory.transfers set status = 'received', received_at = now(), received_by = auth.uid() where id = p_transfer_id;
  insert into integration.outbox (event_type, aggregate_type, aggregate_id, payload)
  values ('inventory.transfer_received', 'inventory.transfer', p_transfer_id,
          jsonb_build_object('transfer_id', p_transfer_id, 'transfer_no', v_t.transfer_no,
                             'from_warehouse_id', v_t.from_warehouse_id, 'to_warehouse_id', v_t.to_warehouse_id));
  return jsonb_build_object('transfer_id', p_transfer_id, 'status', 'received');
end $$;

-- ---------------------------------------------------------------------------
-- F5 + F10. From 20261030000600_catalog_commands.sql. Changes: Cairo business day for the
-- default start date, and the DEFAULT list may not start in the future.
-- ---------------------------------------------------------------------------
create or replace function api.upsert_price_list(
  p_price_list_id uuid,
  p_code          text,
  p_name          text,
  p_kind          text default 'standard',
  p_priority      int default 100,
  p_valid_from    date default core.business_date(),
  p_valid_to      date default null,
  p_is_active     boolean default true)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_code text;
  v_name text := nullif(btrim(p_name), '');
  v_old catalog.price_lists%rowtype;
  v_new catalog.price_lists%rowtype;
  v_created boolean;
begin
  perform catalog._require_global('catalog.price.manage');

  if p_price_list_id is null then raise exception 'VALIDATION: price list id is required' using errcode = 'P0001'; end if;
  v_code := catalog._clean_code(p_code, 'price list code');
  if v_name is null or length(v_name) < 2 or length(v_name) > 120 then
    raise exception 'VALIDATION: price list name must be 2-120 characters' using errcode = 'P0001';
  end if;
  if p_kind is null or p_kind not in ('standard', 'customer', 'promotional') then
    raise exception 'VALIDATION: unknown price list kind %', coalesce(p_kind, '(none)') using errcode = 'P0001';
  end if;
  if p_priority is null or p_priority < 1 or p_priority > 1000 then
    raise exception 'VALIDATION: priority must be between 1 and 1000' using errcode = 'P0001';
  end if;
  if p_valid_from is null then raise exception 'VALIDATION: valid from is required' using errcode = 'P0001'; end if;
  if p_valid_to is not null and p_valid_to < p_valid_from then
    raise exception 'VALIDATION: valid to must be on or after valid from' using errcode = 'P0001';
  end if;
  if p_is_active is null then raise exception 'VALIDATION: active flag is required' using errcode = 'P0001'; end if;

  select * into v_old from catalog.price_lists where id = p_price_list_id for update;
  v_created := not found;

  if exists (select 1 from catalog.price_lists where upper(code) = v_code and id <> p_price_list_id) then
    raise exception 'DUPLICATE_CODE: price list code % is already used', v_code using errcode = 'P0001';
  end if;
  if not v_created and v_old.kind <> p_kind then
    raise exception 'VALIDATION: the kind of a price list cannot change' using errcode = 'P0001';
  end if;
  -- Audit F5: DEFAULT is the fallback for every order, so it must be current today as well.
  if (not v_created and v_old.code = 'DEFAULT' and v_code <> 'DEFAULT')
     or (v_code = 'DEFAULT' and (p_kind <> 'standard' or not p_is_active or p_valid_to is not null
                                 or p_valid_from > core.business_date())) then
    raise exception 'DEFAULT_LIST_PROTECTED: the DEFAULT list must stay standard, active, current and open-ended'
      using errcode = 'P0001';
  end if;

  begin
    if v_created then
      insert into catalog.price_lists (id, code, name, kind, currency, priority, valid_from, valid_to, is_active)
      values (p_price_list_id, v_code, v_name, p_kind, 'EGP', p_priority, p_valid_from, p_valid_to, p_is_active)
      returning * into v_new;
    else
      update catalog.price_lists set code = v_code, name = v_name, priority = p_priority,
             valid_from = p_valid_from, valid_to = p_valid_to, is_active = p_is_active
      where id = p_price_list_id
      returning * into v_new;
    end if;
  exception when unique_violation then
    raise exception 'DUPLICATE_CODE: price list code % is already used', v_code using errcode = 'P0001';
  end;

  if v_created or (v_new.code, v_new.name, v_new.priority, v_new.valid_from, v_new.valid_to, v_new.is_active)
                   is distinct from (v_old.code, v_old.name, v_old.priority, v_old.valid_from, v_old.valid_to, v_old.is_active) then
    perform catalog._emit('price_list.updated', 'catalog.price_list', p_price_list_id,
      jsonb_build_object('price_list_id', p_price_list_id, 'code', v_new.code, 'kind', v_new.kind,
                         'priority', v_new.priority, 'valid_from', v_new.valid_from, 'valid_to', v_new.valid_to,
                         'is_active', v_new.is_active, 'created', v_created));
  end if;

  return jsonb_build_object('price_list_id', p_price_list_id, 'code', v_new.code, 'kind', v_new.kind,
                            'is_active', v_new.is_active, 'created', v_created);
end $$;

-- ---------------------------------------------------------------------------
-- F4 + F6 + F10. From 20261030000600_catalog_commands.sql. Changes: cancelled rows
-- (valid_to = valid_from - 1, never effective) are ignored by the overlap check; an end
-- date cannot be moved into the past (same rule as api.end_customer_price_list); Cairo day.
-- ---------------------------------------------------------------------------
create or replace function api.assign_customer_price_list(p_customer_id uuid, p_price_list_id uuid,
                                                          p_valid_from date default core.business_date(),
                                                          p_valid_to date default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_cust crm.customers%rowtype; v_kind text; v_replayed boolean := false;
        v_existing catalog.customer_price_lists%rowtype; v_today date := core.business_date();
begin
  perform catalog._require_global('catalog.price.manage');
  select * into v_cust from crm.customers where id = p_customer_id;
  if not found then raise exception 'NOT_FOUND: customer' using errcode = 'P0002'; end if;
  if not authz.customer_in_scope('crm.customer.read', p_customer_id) then
    raise exception 'PERMISSION_DENIED: customer not in your scope' using errcode = '42501';
  end if;
  if v_cust.archived_at is not null then
    raise exception 'INVALID_STATE: customer is archived' using errcode = 'P0001';
  end if;
  select kind into v_kind from catalog.price_lists where id = p_price_list_id;
  if not found then raise exception 'NOT_FOUND: price list' using errcode = 'P0002'; end if;
  if v_kind <> 'customer' then
    raise exception 'VALIDATION: only customer price lists can be assigned to a customer' using errcode = 'P0001';
  end if;
  if p_valid_from is null then raise exception 'VALIDATION: valid from is required' using errcode = 'P0001'; end if;
  if p_valid_to is not null and p_valid_to < p_valid_from then
    raise exception 'VALIDATION: valid to must be on or after valid from' using errcode = 'P0001';
  end if;

  -- Same assignment again (same start date) = idempotent replay / end-date change.
  select * into v_existing from catalog.customer_price_lists
  where customer_id = p_customer_id and price_list_id = p_price_list_id and valid_from = p_valid_from for update;
  v_replayed := found;
  -- Audit F6: an end date cannot be set in the past (an exact replay of the stored end date is fine).
  if p_valid_to is not null and p_valid_to < v_today
     and not (v_replayed and v_existing.valid_to is not distinct from p_valid_to) then
    raise exception 'VALIDATION: the end date cannot be in the past' using errcode = 'P0001';
  end if;
  -- Audit F4: cancelled rows (valid_to < valid_from) never applied and cannot overlap.
  if exists (select 1 from catalog.customer_price_lists
             where customer_id = p_customer_id and price_list_id = p_price_list_id and valid_from <> p_valid_from
               and (valid_to is null or valid_to >= valid_from)
               and daterange(valid_from, valid_to, '[]') && daterange(p_valid_from, p_valid_to, '[]')) then
    raise exception 'OVERLAP: this customer already has this price list for part of that period' using errcode = 'P0001';
  end if;

  insert into catalog.customer_price_lists (customer_id, price_list_id, valid_from, valid_to)
  values (p_customer_id, p_price_list_id, p_valid_from, p_valid_to)
  on conflict (customer_id, price_list_id, valid_from) do update set valid_to = excluded.valid_to;

  return jsonb_build_object('customer_id', p_customer_id, 'price_list_id', p_price_list_id,
                            'valid_from', p_valid_from, 'valid_to', p_valid_to, 'replayed', v_replayed);
end $$;

-- F10. From 20261030000600_catalog_commands.sql. Change: Cairo business day.
create or replace function api.end_customer_price_list(p_customer_id uuid, p_price_list_id uuid, p_valid_from date,
                                                       p_end_on date default core.business_date())
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_row catalog.customer_price_lists%rowtype; v_to date;
begin
  perform catalog._require_global('catalog.price.manage');
  if not authz.customer_in_scope('crm.customer.read', p_customer_id) then
    raise exception 'PERMISSION_DENIED: customer not in your scope' using errcode = '42501';
  end if;
  if p_end_on is null or p_end_on < core.business_date() then
    raise exception 'VALIDATION: the end date cannot be in the past' using errcode = 'P0001';
  end if;
  select * into v_row from catalog.customer_price_lists
  where customer_id = p_customer_id and price_list_id = p_price_list_id and valid_from = p_valid_from for update;
  if not found then raise exception 'NOT_FOUND: customer price list' using errcode = 'P0002'; end if;
  if v_row.valid_to is not null and v_row.valid_to <= p_end_on then
    raise exception 'INVALID_STATE: this assignment already ends on %', v_row.valid_to using errcode = 'P0001';
  end if;
  v_to := case when p_end_on < v_row.valid_from then v_row.valid_from - 1 else p_end_on end;
  update catalog.customer_price_lists set valid_to = v_to
  where customer_id = p_customer_id and price_list_id = p_price_list_id and valid_from = p_valid_from;
  return jsonb_build_object('customer_id', p_customer_id, 'price_list_id', p_price_list_id,
                            'valid_from', p_valid_from, 'valid_to', v_to, 'cancelled', v_to < v_row.valid_from);
end $$;

-- F10. From 20261030000600_catalog_commands.sql. Change: Cairo business day.
create or replace function api.create_promotion(
  p_promotion_id uuid,
  p_name         text,
  p_discount_pct numeric,
  p_valid_from   date,
  p_valid_to     date default null,
  p_brand_id     uuid default null,
  p_category_id  uuid default null,
  p_variant_id   uuid default null,
  p_customer_id  uuid default null,
  p_min_qty      int default 1,
  p_priority     int default 100)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_name text := nullif(btrim(p_name), '');
  v_variant record;
begin
  perform catalog._require_global('catalog.price.manage');
  if p_promotion_id is null then raise exception 'VALIDATION: promotion id is required' using errcode = 'P0001'; end if;

  -- Idempotent replay: the same id returns the stored promotion unchanged.
  if exists (select 1 from sales.discount_rules where id = p_promotion_id) then
    return (select jsonb_build_object('promotion_id', d.id, 'name', d.name, 'discount_pct', d.discount_pct,
                                      'replayed', true)
            from sales.discount_rules d where d.id = p_promotion_id);
  end if;

  if v_name is null or length(v_name) < 2 or length(v_name) > 120 then
    raise exception 'VALIDATION: promotion name must be 2-120 characters' using errcode = 'P0001';
  end if;
  if p_discount_pct is null or p_discount_pct <= 0 or p_discount_pct > 100 or p_discount_pct <> round(p_discount_pct, 2) then
    raise exception 'VALIDATION: discount must be above 0 and at most 100 percent, with at most 2 decimals'
      using errcode = 'P0001';
  end if;
  if p_valid_from is null then raise exception 'VALIDATION: valid from is required' using errcode = 'P0001'; end if;
  if p_valid_to is not null and p_valid_to < p_valid_from then
    raise exception 'VALIDATION: valid to must be on or after valid from' using errcode = 'P0001';
  end if;
  if p_valid_to is not null and p_valid_to < core.business_date() then
    raise exception 'VALIDATION: a new promotion cannot end in the past' using errcode = 'P0001';
  end if;
  if p_min_qty is null or p_min_qty < 1 or p_min_qty > 100000 then
    raise exception 'VALIDATION: minimum quantity must be between 1 and 100000' using errcode = 'P0001';
  end if;
  if p_priority is null or p_priority < 1 or p_priority > 1000 then
    raise exception 'VALIDATION: priority must be between 1 and 1000' using errcode = 'P0001';
  end if;
  if p_brand_id is not null and not exists (select 1 from catalog.brands where id = p_brand_id) then
    raise exception 'VALIDATION: unknown brand' using errcode = 'P0001';
  end if;
  if p_category_id is not null and not exists (select 1 from catalog.categories where id = p_category_id) then
    raise exception 'VALIDATION: unknown category' using errcode = 'P0001';
  end if;
  if p_variant_id is not null then
    select pv.id, p.brand_id, p.category_id into v_variant
    from catalog.product_variants pv join catalog.products p on p.id = pv.product_id where pv.id = p_variant_id;
    if not found then raise exception 'VALIDATION: unknown variant' using errcode = 'P0001'; end if;
    if (p_brand_id is not null and p_brand_id <> v_variant.brand_id)
       or (p_category_id is not null and p_category_id <> v_variant.category_id) then
      raise exception 'VALIDATION: the variant does not belong to that brand or category' using errcode = 'P0001';
    end if;
  end if;
  if p_customer_id is not null then
    if not exists (select 1 from crm.customers where id = p_customer_id) then
      raise exception 'NOT_FOUND: customer' using errcode = 'P0002';
    end if;
    if not authz.customer_in_scope('crm.customer.read', p_customer_id) then
      raise exception 'PERMISSION_DENIED: customer not in your scope' using errcode = '42501';
    end if;
  end if;

  insert into sales.discount_rules (id, name, brand_id, category_id, variant_id, customer_id, discount_pct,
                                    min_qty, valid_from, valid_to, priority, is_active)
  values (p_promotion_id, v_name, p_brand_id, p_category_id, p_variant_id, p_customer_id, p_discount_pct,
          p_min_qty, p_valid_from, p_valid_to, p_priority, true);

  perform catalog._emit('promotion.created', 'sales.promotion', p_promotion_id,
    jsonb_build_object('promotion_id', p_promotion_id, 'name', v_name, 'discount_pct', p_discount_pct,
                       'brand_id', p_brand_id, 'category_id', p_category_id, 'variant_id', p_variant_id,
                       'customer_id', p_customer_id, 'min_qty', p_min_qty,
                       'valid_from', p_valid_from, 'valid_to', p_valid_to));
  return jsonb_build_object('promotion_id', p_promotion_id, 'name', v_name, 'discount_pct', p_discount_pct,
                            'replayed', false);
end $$;

-- F10. From 20261030000600_catalog_commands.sql. Change: Cairo business day.
create or replace function api.end_promotion(p_promotion_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_row sales.discount_rules%rowtype; v_to date; v_today date := core.business_date();
begin
  perform catalog._require_global('catalog.price.manage');
  select * into v_row from sales.discount_rules where id = p_promotion_id for update;
  if not found then raise exception 'NOT_FOUND: promotion' using errcode = 'P0002'; end if;
  if v_row.customer_id is not null and not authz.customer_in_scope('crm.customer.read', v_row.customer_id) then
    raise exception 'PERMISSION_DENIED: customer not in your scope' using errcode = '42501';
  end if;
  if not v_row.is_active or v_row.valid_to < v_today then
    raise exception 'INVALID_STATE: promotion has already ended' using errcode = 'P0001';
  end if;
  v_to := case when v_row.valid_from <= v_today then least(coalesce(v_row.valid_to, v_today), v_today)
               else v_row.valid_to end;
  update sales.discount_rules set is_active = false, valid_to = v_to where id = p_promotion_id;
  perform catalog._emit('promotion.ended', 'sales.promotion', p_promotion_id,
    jsonb_build_object('promotion_id', p_promotion_id, 'name', v_row.name, 'ended_on', v_today));
  return jsonb_build_object('promotion_id', p_promotion_id, 'is_active', false, 'valid_to', v_to);
end $$;

-- ---------------------------------------------------------------------------
-- F7. From 20261030000100_crm_ui_reads.sql. Changes: a match the caller cannot see (their
-- crm.customer.read scope) is reported only as a flag: no customer number, no count.
-- In-scope matches keep their detail. New keys: phone_duplicate_outside_scope,
-- similar_outside_scope, exists_outside_scope (any of the two).
-- ---------------------------------------------------------------------------
create or replace function api.find_duplicate_customers(
  p_doctor_name      text default null,
  p_clinic_name      text default null,
  p_phone_primary    text default null,
  p_governorate_code text default null,
  p_display_name     text default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_display text;
  v_phone core.phone_e164;
  v_gov text := upper(nullif(btrim(p_governorate_code), ''));
  v_hard text;
  v_hard_hidden boolean := false;
  v_count int := 0;
  v_similar text[] := '{}';
  v_similar_hidden boolean := false;
  v_all boolean;
  v_territories uuid[];
  v_assigned uuid[];
begin
  perform authz.require('crm.customer.create');

  -- The caller's customer visibility (same rule as the crm.customers policy), computed once.
  v_all := authz.has_global('crm.customer.read');
  v_territories := authz.territory_ids('crm.customer.read');
  v_assigned := authz.assigned_customer_ids('crm.customer.read');

  v_display := coalesce(nullif(btrim(p_display_name), ''),
                        crm.compose_display_name(p_clinic_name, p_doctor_name));
  v_phone := core.to_phone_e164(p_phone_primary, 'phone_primary');

  if v_phone is not null then
    select c.customer_no into v_hard from crm.customers c
    where c.phone_primary = v_phone and c.archived_at is null
      and (v_all or c.territory_id = any(v_territories) or c.id = any(v_assigned))
    order by c.customer_no limit 1;
    if v_hard is null then
      v_hard_hidden := exists (select 1 from crm.customers c
                               where c.phone_primary = v_phone and c.archived_at is null);
    end if;
  end if;

  -- Very short names match too much to be a useful warning.
  if v_display is not null and length(v_display) >= 3 and v_gov is not null then
    select count(*) filter (where s.visible)::int,
           coalesce((array_agg(s.customer_no order by s.sim desc, s.customer_no) filter (where s.visible))[1:10], '{}'),
           coalesce(bool_or(not s.visible), false)
      into v_count, v_similar, v_similar_hidden
    from (select c.customer_no, extensions.similarity(c.display_name, v_display) as sim,
                 (v_all or c.territory_id = any(v_territories) or c.id = any(v_assigned)) as visible
          from crm.customers c
          where c.governorate_code = v_gov and c.archived_at is null
            and extensions.similarity(c.display_name, v_display) >= 0.6) s;
  end if;

  return jsonb_build_object(
    'phone_duplicate_customer_no', v_hard,
    'phone_duplicate_outside_scope', v_hard_hidden,
    'similar_count', v_count,
    'similar_customer_nos', to_jsonb(v_similar),
    'similar_outside_scope', v_similar_hidden,
    'exists_outside_scope', v_hard_hidden or v_similar_hidden);
end $$;

-- ---------------------------------------------------------------------------
-- F10. Views: same columns as before; only current_date → core.business_date().
-- From 20261029000300 (v_stock_available, v_stock_detail), 20261030000400
-- (v_inventory_stock, v_reorder_alerts) and 20261030000600 (v_price_lists,
-- v_customer_price_lists, v_promotions).
-- ---------------------------------------------------------------------------
create or replace view api.v_stock_available with (security_invoker = true) as
  select b.warehouse_id, w.code as warehouse_code, w.name as warehouse_name,
         b.variant_id, v.sku, v.name_en as variant_name, p.id as product_id, p.name_en as product_name,
         sum(greatest(b.on_hand - b.reserved, 0))::int as available
  from inventory.stock_balances b
  join inventory.lots l on l.id = b.lot_id
  join inventory.warehouses w on w.id = b.warehouse_id
  join catalog.product_variants v on v.id = b.variant_id
  join catalog.products p on p.id = v.product_id
  where (l.expiry_date is null or l.expiry_date >= (select core.business_date()))
    and w.kind not in ('quarantine','transit') and w.is_active
  group by b.warehouse_id, w.code, w.name, b.variant_id, v.sku, v.name_en, p.id, p.name_en;

create or replace view api.v_stock_detail with (security_invoker = true) as
  select b.warehouse_id, w.code as warehouse_code, b.variant_id, v.sku, b.lot_id, l.lot_no, l.expiry_date,
         (l.expiry_date - (select core.business_date())) as days_to_expiry,
         b.on_hand, b.reserved, (b.on_hand - b.reserved) as available, b.updated_at
  from inventory.stock_balances b
  join inventory.lots l on l.id = b.lot_id
  join inventory.warehouses w on w.id = b.warehouse_id
  join catalog.product_variants v on v.id = b.variant_id
  where (select authz.has_permission('inventory.module.access'));

create or replace view api.v_inventory_stock with (security_invoker = true) as
  with today as materialized (select core.business_date() as d),
  s as (
    select b.warehouse_id, b.variant_id,
           sum(b.on_hand)::int as on_hand,
           sum(b.reserved)::int as reserved,
           sum(b.on_hand - b.reserved)::int as available,
           sum(case when l.expiry_date is null or l.expiry_date >= today.d
                    then greatest(b.on_hand - b.reserved, 0) else 0 end)::int as unexpired_available,
           sum(case when l.expiry_date < today.d then greatest(b.on_hand, 0) else 0 end)::int as expired_qty,
           sum(case when l.expiry_date >= today.d and l.expiry_date < today.d + 90
                    then greatest(b.on_hand, 0) else 0 end)::int as near_expiry_qty,
           min(l.expiry_date) filter (where b.on_hand > 0 and l.expiry_date >= today.d) as earliest_expiry,
           (count(*) filter (where b.on_hand <> 0))::int as lot_count
    from inventory.stock_balances b
    join inventory.lots l on l.id = b.lot_id
    cross join today
    group by b.warehouse_id, b.variant_id
    having bool_or(b.on_hand <> 0 or b.reserved <> 0)
  )
  select s.warehouse_id, w.code as warehouse_code, w.name as warehouse_name, w.kind as warehouse_kind,
         (w.is_active and w.kind not in ('quarantine', 'transit')) as is_sellable,
         s.variant_id, v.sku, v.name_en as variant_name, p.id as product_id, p.name_en as product_name,
         br.id as brand_id, br.code as brand_code, br.name as brand_name, v.reorder_point,
         s.on_hand, s.reserved, s.available,
         (case when w.is_active and w.kind not in ('quarantine', 'transit') then s.unexpired_available else 0 end)::int
           as sellable_available,
         s.expired_qty, s.near_expiry_qty, s.earliest_expiry,
         (s.earliest_expiry - (select today.d from today)) as days_to_earliest_expiry, s.lot_count
  from s
  join inventory.warehouses w on w.id = s.warehouse_id
  join catalog.product_variants v on v.id = s.variant_id
  join catalog.products p on p.id = v.product_id
  join catalog.brands br on br.id = p.brand_id
  where (select authz.has_permission('inventory.module.access'));

create or replace view api.v_reorder_alerts with (security_invoker = true) as
  select v.id as variant_id, v.sku, v.name_en as variant_name, p.id as product_id, p.name_en as product_name,
         br.id as brand_id, br.code as brand_code, br.name as brand_name, v.reorder_point,
         coalesce(a.sellable_available, 0)::int as sellable_available,
         (v.reorder_point - coalesce(a.sellable_available, 0))::int as shortfall
  from catalog.product_variants v
  join catalog.products p on p.id = v.product_id
  join catalog.brands br on br.id = p.brand_id
  left join lateral (
    select sum(greatest(b.on_hand - b.reserved, 0)) as sellable_available
    from inventory.stock_balances b
    join inventory.lots l on l.id = b.lot_id
    join inventory.warehouses w on w.id = b.warehouse_id
    where b.variant_id = v.id
      and w.is_active and w.kind not in ('quarantine', 'transit')
      and (l.expiry_date is null or l.expiry_date >= (select core.business_date()))
  ) a on true
  where v.reorder_point > 0 and v.status = 'active' and p.status = 'active'
    and coalesce(a.sellable_available, 0) <= v.reorder_point
    and (select authz.has_permission('inventory.module.access'));

create or replace view api.v_price_lists with (security_invoker = true) as
  select pl.id, pl.code, pl.name, pl.kind, pl.currency, pl.priority, pl.valid_from, pl.valid_to, pl.is_active,
         (pl.is_active and (select core.business_date()) >= pl.valid_from
          and (pl.valid_to is null or (select core.business_date()) <= pl.valid_to)) as is_current,
         (pl.code = 'DEFAULT') as is_default,
         (select count(*) from catalog.price_list_items pli where pli.price_list_id = pl.id)::int as item_count,
         (select count(*) from catalog.customer_price_lists cpl
          where cpl.price_list_id = pl.id and (cpl.valid_to is null or cpl.valid_to >= (select core.business_date()))
            and cpl.valid_to is distinct from cpl.valid_from - 1)::int as customer_count
  from catalog.price_lists pl;

-- state: current | scheduled | ended | cancelled (ended before it started).
create or replace view api.v_customer_price_lists with (security_invoker = true) as
  select cpl.customer_id, c.customer_no, c.display_name as customer_name,
         cpl.price_list_id, pl.code as price_list_code, pl.name as price_list_name,
         cpl.valid_from, cpl.valid_to,
         case when cpl.valid_to is not null and cpl.valid_to < cpl.valid_from then 'cancelled'
              when cpl.valid_to is not null and cpl.valid_to < (select core.business_date()) then 'ended'
              when cpl.valid_from > (select core.business_date()) then 'scheduled'
              else 'current' end as state
  from catalog.customer_price_lists cpl
  join crm.customers c on c.id = cpl.customer_id
  join catalog.price_lists pl on pl.id = cpl.price_list_id;

-- state: active | scheduled | ended.
create or replace view api.v_promotions with (security_invoker = true) as
  select d.id, d.name, d.discount_pct, d.min_qty, d.valid_from, d.valid_to, d.priority, d.is_active,
         d.brand_id, b.code as brand_code, b.name as brand_name,
         d.category_id, c.code as category_code, c.name_en as category_name_en, c.name_ar as category_name_ar,
         d.variant_id, v.sku as variant_sku, v.name_en as variant_name_en,
         d.customer_id, cu.customer_no, cu.display_name as customer_name,
         case when not d.is_active or d.valid_to < (select core.business_date()) then 'ended'
              when d.valid_from > (select core.business_date()) then 'scheduled'
              else 'active' end as state
  from sales.discount_rules d
  left join catalog.brands b on b.id = d.brand_id
  left join catalog.categories c on c.id = d.category_id
  left join catalog.product_variants v on v.id = d.variant_id
  left join crm.customers cu on cu.id = d.customer_id;

-- ---------------------------------------------------------------------------
-- Privileges. create or replace keeps each object's existing grants; restated for the
-- replaced api functions so this file is self-explanatory (PUBLIC never executes them).
-- ---------------------------------------------------------------------------
do $$
declare f text;
begin
  foreach f in array array[
    'api.reserve_order(uuid, uuid)',
    'api.create_transfer(uuid, uuid, jsonb)',
    'api.receive_transfer(uuid)',
    'api.upsert_price_list(uuid, text, text, text, int, date, date, boolean)',
    'api.assign_customer_price_list(uuid, uuid, date, date)',
    'api.end_customer_price_list(uuid, uuid, date, date)',
    'api.create_promotion(uuid, text, numeric, date, date, uuid, uuid, uuid, uuid, int, int)',
    'api.end_promotion(uuid)',
    'api.find_duplicate_customers(text, text, text, text, text)']
  loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
revoke execute on function sales.price_order(uuid) from public, anon, authenticated;
