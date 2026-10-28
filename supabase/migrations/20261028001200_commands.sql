-- Honest OS migration: domain commands (api.*)
-- Origin: docs/database/draft/10_schema_draft.sql (Phase 1, validated). See docs/DATABASE.md.

-- ---------------------------------------------------------------------------
-- DOMAIN COMMANDS (examples of the pattern; full set specified in docs/API_CONTRACTS.md)
-- ---------------------------------------------------------------------------

-- Server-side price resolution: customer list → promotional → default. Never trusts the client.
create or replace function sales.resolve_list_price(p_customer_id uuid, p_variant_id uuid, p_qty int,
                                                    p_on date default current_date)
returns table (unit_price numeric, price_list_id uuid)
language sql stable security definer set search_path = '' as $$
  select pli.unit_price, pl.id
  from catalog.price_lists pl
  join catalog.price_list_items pli on pli.price_list_id = pl.id
  where pli.variant_id = p_variant_id and pli.min_qty <= p_qty and pl.is_active
    and p_on >= pl.valid_from and (pl.valid_to is null or p_on <= pl.valid_to)
    and (pl.kind <> 'customer' or exists (
          select 1 from catalog.customer_price_lists cpl
          where cpl.customer_id = p_customer_id and cpl.price_list_id = pl.id
            and p_on >= cpl.valid_from and (cpl.valid_to is null or p_on <= cpl.valid_to)))
  order by case pl.kind when 'customer' then 0 when 'promotional' then 1 else 2 end,
           pl.priority, pli.min_qty desc
  limit 1
$$;


-- Submit an order: prices + discounts computed here; discount above the caller's
-- limit routes to approval instead of failing silently or trusting the client.
create or replace function api.submit_order(p_order_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_order sales.orders%rowtype;
  v_limit numeric;
  v_max_requested numeric;
  v_item record;
  v_price record;
  v_promo numeric;
  v_applied numeric;
  v_sub numeric; v_disc numeric; v_tax numeric;
  v_status text;
  v_def uuid;
begin
  perform authz.require('sales.order.submit');

  select * into v_order from sales.orders where id = p_order_id for update;
  if not found then raise exception 'NOT_FOUND: order %', p_order_id using errcode = 'P0002'; end if;
  if v_order.status <> 'draft' then
    raise exception 'INVALID_STATE: order is %', v_order.status using errcode = 'P0001';
  end if;
  -- ABAC: the caller must be able to act on this customer.
  if not (authz.has_global('sales.order.submit')
          or v_order.employee_id = any(authz.employee_ids('sales.order.submit'))) then
    raise exception 'PERMISSION_DENIED: order belongs to another representative' using errcode = '42501';
  end if;

  for v_item in select * from sales.order_items where order_id = p_order_id for update loop
    select * into v_price from sales.resolve_list_price(v_order.customer_id, v_item.variant_id, v_item.quantity);
    if v_price.unit_price is null then
      raise exception 'NO_PRICE: variant % has no active price', v_item.variant_id using errcode = 'P0001';
    end if;
    select coalesce(max(d.discount_pct), 0) into v_promo
    from sales.discount_rules d
    join catalog.product_variants pv on pv.id = v_item.variant_id
    join catalog.products p on p.id = pv.product_id
    where d.is_active and current_date between d.valid_from and coalesce(d.valid_to, current_date)
      and v_item.quantity >= d.min_qty
      and (d.variant_id is null or d.variant_id = v_item.variant_id)
      and (d.brand_id is null or d.brand_id = p.brand_id)
      and (d.category_id is null or d.category_id = p.category_id)
      and (d.customer_id is null or d.customer_id = v_order.customer_id);
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
    into v_sub, v_disc, v_tax, v_max_requested
  from sales.order_items where order_id = p_order_id;
  if v_sub = 0 then raise exception 'EMPTY_ORDER' using errcode = 'P0001'; end if;

  -- Discount authority: manual discount beyond promo vs. the caller's limit (NULL = unlimited).
  v_limit := authz.max_limit('sales.discount.apply');
  if v_max_requested > 0 and not authz.has_permission('sales.discount.apply') then
    v_status := 'pending_approval';
  elsif v_max_requested > coalesce(v_limit, v_max_requested) then
    v_status := 'pending_approval';
  else
    v_status := 'submitted';
  end if;

  update sales.orders set
    order_no = coalesce(order_no, core.next_document_no('SO')),
    subtotal = v_sub, discount_total = v_disc, tax_total = v_tax, total = v_sub - v_disc + v_tax,
    status = v_status, submitted_at = now(),
    territory_id = (select territory_id from crm.customers where id = v_order.customer_id),
    version = version + 1
  where id = p_order_id;

  insert into sales.order_status_history (order_id, from_status, to_status, changed_by, reason)
  values (p_order_id, 'draft', v_status, auth.uid(),
          case when v_status = 'pending_approval' then 'discount above limit' end);

  if v_status = 'pending_approval' then
    select id into v_def from wf.workflow_definitions where code = 'sales.order.discount' and is_active;
    if v_def is null then raise exception 'WORKFLOW_MISSING: sales.order.discount' using errcode = 'P0001'; end if;
    insert into wf.approval_requests (definition_id, entity_type, entity_id, requested_by, payload)
    values (v_def, 'sales.order', p_order_id, auth.uid(),
            jsonb_build_object('max_manual_discount_pct', v_max_requested, 'limit_pct', v_limit,
                               'total', v_sub - v_disc + v_tax));
  end if;

  insert into integration.outbox (event_type, aggregate_type, aggregate_id, payload)
  values ('order.' || v_status, 'sales.order', p_order_id,
          jsonb_build_object('order_id', p_order_id, 'status', v_status, 'total', v_sub - v_disc + v_tax));

  return jsonb_build_object('order_id', p_order_id, 'status', v_status,
                            'total', v_sub - v_disc + v_tax);
end $$;

-- Verified GPS check-in. The server computes distance and verdict; the device only reports a fix.
create or replace function api.visit_check_in(
  p_visit_id uuid, p_customer_id uuid, p_lat numeric, p_lng numeric,
  p_accuracy_m numeric, p_captured_at timestamptz, p_device jsonb default '{}')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_emp uuid := authz.current_employee_id();
  v_cust crm.customers%rowtype;
  v_radius numeric; v_max_acc numeric;
  v_dist numeric; v_status text; v_flags text[] := '{}';
  v_prev record;
begin
  perform authz.require('field.visit.create');
  if v_emp is null then raise exception 'NO_EMPLOYEE_PROFILE' using errcode = '42501'; end if;

  select * into v_cust from crm.customers where id = p_customer_id;
  if not found then raise exception 'NOT_FOUND: customer' using errcode = 'P0002'; end if;
  if not (authz.has_global('crm.customer.read')
          or v_cust.territory_id = any(authz.territory_ids('crm.customer.read'))
          or p_customer_id = any(authz.assigned_customer_ids('crm.customer.read'))) then
    raise exception 'PERMISSION_DENIED: customer not in your scope' using errcode = '42501';
  end if;

  -- Idempotent replay from the offline queue: same visit id → same answer.
  if exists (select 1 from field.location_events where visit_id = p_visit_id and event_type = 'check_in') then
    return (select jsonb_build_object('visit_id', id, 'verification_status', verification_status,
                                      'distance_m', check_in_distance_m, 'replayed', true)
            from field.visits where id = p_visit_id);
  end if;

  v_radius  := coalesce((select (value #>> '{}')::numeric from core.system_settings where key = 'field.geofence_radius_m'), 150);
  v_max_acc := coalesce((select (value #>> '{}')::numeric from core.system_settings where key = 'field.max_accuracy_m'), 100);

  if p_lat is null or p_lng is null then
    v_status := 'no_device_location';
  elsif v_cust.latitude is null then
    v_status := 'no_customer_location';
  else
    v_dist := core.distance_m(p_lat, p_lng, v_cust.latitude, v_cust.longitude);
    v_status := case when p_accuracy_m > v_max_acc then 'low_accuracy'
                     when v_dist > v_radius + least(p_accuracy_m, v_max_acc) then 'out_of_range'
                     else 'verified' end;
  end if;

  if abs(extract(epoch from (now() - p_captured_at))) > 600 then
    v_flags := array_append(v_flags, case when p_captured_at < now() then 'late_sync' else 'clock_skew' end);
  end if;
  select le.latitude, le.longitude, le.captured_at into v_prev
  from field.location_events le where le.employee_id = v_emp and le.captured_at < p_captured_at
  order by le.captured_at desc limit 1;
  if v_prev.captured_at is not null and p_lat is not null and v_prev.latitude is not null then
    if v_prev.latitude = p_lat and v_prev.longitude = p_lng then v_flags := array_append(v_flags, 'duplicate_fix'); end if;
    if core.distance_m(v_prev.latitude, v_prev.longitude, p_lat, p_lng)
       / greatest(extract(epoch from (p_captured_at - v_prev.captured_at)), 1) * 3.6 > 150 then
      v_flags := array_append(v_flags, 'impossible_travel');
    end if;
  end if;

  insert into field.visits (id, customer_id, employee_id, status, check_in_at, check_in_received_at,
                            check_in_distance_m, check_in_accuracy_m, verification_status, anomaly_flags)
  values (p_visit_id, p_customer_id, v_emp, 'in_progress', p_captured_at, now(),
          v_dist, p_accuracy_m, v_status, v_flags)
  on conflict (id) do update set status = 'in_progress', check_in_at = excluded.check_in_at,
    check_in_received_at = excluded.check_in_received_at, check_in_distance_m = excluded.check_in_distance_m,
    check_in_accuracy_m = excluded.check_in_accuracy_m, verification_status = excluded.verification_status,
    anomaly_flags = excluded.anomaly_flags
  where field.visits.employee_id = v_emp;

  insert into field.location_events (visit_id, employee_id, event_type, latitude, longitude, accuracy_m, captured_at, device_info)
  values (p_visit_id, v_emp, 'check_in', p_lat, p_lng, p_accuracy_m, p_captured_at, coalesce(p_device, '{}'));

  insert into crm.activities (customer_id, employee_id, type, occurred_at, summary, ref_table, ref_id)
  values (p_customer_id, v_emp, 'visit', p_captured_at, 'Check-in (' || v_status || ')', 'field.visits', p_visit_id);

  return jsonb_build_object('visit_id', p_visit_id, 'verification_status', v_status,
                            'distance_m', v_dist, 'anomaly_flags', v_flags, 'replayed', false);
end $$;

-- Post an inventory adjustment directly (authorised users) — every stock change is a movement.
create or replace function api.post_inventory_adjustment(
  p_warehouse_id uuid, p_variant_id uuid, p_lot_id uuid, p_quantity int, p_reason text, p_idempotency_key text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_limit numeric;
begin
  perform authz.require('inventory.adjustment.post');
  if not (authz.has_global('inventory.adjustment.post')
          or p_warehouse_id = any(authz.warehouse_ids('inventory.adjustment.post'))) then
    raise exception 'PERMISSION_DENIED: warehouse not in your scope' using errcode = '42501';
  end if;
  v_limit := authz.max_limit('inventory.adjustment.post');      -- max absolute units without approval
  if v_limit is not null and abs(p_quantity) > v_limit then
    raise exception 'APPROVAL_REQUIRED: adjustment of % exceeds limit %', p_quantity, v_limit using errcode = 'P0001';
  end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'REASON_REQUIRED' using errcode = 'P0001'; end if;

  select id into v_id from inventory.movements where idempotency_key = p_idempotency_key;
  if v_id is not null then return v_id; end if;

  insert into inventory.movements (movement_type, warehouse_id, variant_id, lot_id, quantity, reason_code,
                                   source_doc_type, idempotency_key, created_by)
  values (case when p_quantity > 0 then 'adjustment_in' else 'adjustment_out' end,
          p_warehouse_id, p_variant_id, p_lot_id, p_quantity, p_reason, 'adjustment', p_idempotency_key, auth.uid())
  returning id into v_id;
  return v_id;
end $$;

-- Grant a role with anti-escalation: the grantor must hold every permission of the
-- role at an equal-or-wider scope; only owners grant the owner role; nobody edits their own roles.
create or replace function api.grant_role(p_user_id uuid, p_role_id uuid, p_territory_id uuid default null,
                                          p_reason text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_role authz.roles%rowtype; v_missing text; v_id uuid;
begin
  perform authz.require('admin.role.assign');
  if p_user_id = auth.uid() and not authz.is_owner() then
    raise exception 'SELF_GRANT_FORBIDDEN' using errcode = '42501';
  end if;
  -- Record scope: a team-scoped assigner may only manage users in their own team.
  if not authz.has_global('admin.role.assign') and not exists (
       select 1 from core.user_profiles p
       where p.user_id = p_user_id and p.employee_id = any(authz.employee_ids('admin.role.assign'))) then
    raise exception 'PERMISSION_DENIED: user is outside your scope' using errcode = '42501';
  end if;
  select * into v_role from authz.roles where id = p_role_id and is_active;
  if not found then raise exception 'NOT_FOUND: role' using errcode = 'P0002'; end if;
  if v_role.is_owner_role and not authz.is_owner() then
    raise exception 'OWNER_ONLY: only an owner can grant the owner role' using errcode = '42501';
  end if;
  if not authz.is_owner() then
    select rp.permission_code into v_missing
    from authz.role_permissions rp
    where rp.role_id = p_role_id and not exists (
      select 1 from authz.grants(rp.permission_code) g
      where array_position(array['own','team','territory','department','warehouse','all'], g.scope)
         >= array_position(array['own','team','territory','department','warehouse','all'], rp.scope)
        and (rp.limit_value is null and g.limit_value is null or g.limit_value is null or g.limit_value >= rp.limit_value))
    limit 1;
    if v_missing is not null then
      raise exception 'ESCALATION_BLOCKED: you do not hold %', v_missing using errcode = '42501';
    end if;
  end if;

  insert into authz.user_roles (user_id, role_id, scope_territory_id, granted_by, reason)
  values (p_user_id, p_role_id, p_territory_id, auth.uid(), p_reason) returning id into v_id;
  insert into audit.security_events (user_id, event_type, severity, details)
  values (auth.uid(), 'role_granted', case when v_role.is_owner_role then 'critical' else 'warning' end,
          jsonb_build_object('target_user', p_user_id, 'role', v_role.code, 'territory', p_territory_id));
  return v_id;
end $$;
