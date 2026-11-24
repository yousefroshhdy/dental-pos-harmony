-- Honest OS migration: Phase P step 6, part 2 — order pricing with offers, bonus lines, net prices
-- and invoice-level discounts; decision-B approval; server-computed preview; invoice lines.
--
-- Redefines (CREATE OR REPLACE, from their latest definitions; every existing behaviour is kept):
--   sales.price_order        20261030000700_audit_phase3_fixes.sql
--   sales.order_draft_answer 20261103000300_orders_offline_drafts.sql
--   api.save_order_draft     20261104000200_audit4_imports_drafts.sql
--   api.submit_order         20261029000300_orders_inventory_workflow.sql
--   api.issue_invoice        20261031000100_finance_ar_commands.sql
--   api.v_orders, api.v_order_lines (20261029000300), api.v_invoice_lines (20261031000110): columns appended
-- New: sales.discount_check, sales.order_preview_answer, api.preview_order.
--
-- PRICING RULES (sales.price_order; amounts numeric(14,2) EGP, before VAT unless named "tax"/"total")
--   Prices on price lists EXCLUDE VAT. VAT is added per line at the product's rate (decision C).
--   1. Bonus line (is_bonus): price 0, no discount, no VAT, line total 0. It still reserves and ships
--      stock and counts in quantity reports; it earns no commission (the engine reads line_total > 0).
--   2. Offer line: list price from the price lists (customer → promotional → default). Per-line offer:
--      net = offer net unit price × qty, capped at the list value. Package offer: package price ×
--      packages, capped at the list value of the offer's paid lines, spread over them by list value
--      (round half-up to 0.01, the last line absorbs the rounding). No promotion. Not manual.
--   3. Other lines (unchanged rule): the larger of the best promotion and the requested discount %.
--      Net-price entry: discount amount = (list − net) × qty (exact), requested % = (list − net) / list
--      × 100 rounded half-up to 2 decimals; the line takes the larger of that amount and the promotion.
--      A net price above the list price is refused (NET_PRICE_ABOVE_LIST).
--   4. Invoice-level discount (amount, or % of the order net after line discounts): spread over the
--      lines with a net above 0 by net value, rounded to 0.01, the LAST such line (by line number)
--      absorbing the rounding, so Σ line nets = gross − every discount, exactly.
--   5. VAT per line = round((line_subtotal − line_discount) × rate / 100, 2).
--   6. Manual % per line (compared to the limits, 2 decimals) = manual discount beyond promotion or
--      offer + the invoice-discount share, as % of the line's list value.
-- APPROVAL (api.submit_order, sales.discount_check): settings sales.discount.* (decision B)
--   per_role: unchanged (role limit on sales.discount.apply; approvers by wf.decide.order_discount limit).
--   tiered:   own authority rep_max / manager_max (holders of wf.decide.order_discount) / owner unlimited;
--             above own authority → approval; within manager_max any sales manager in scope decides,
--             above it only the owner (payload.owner_required → rules 30/35 → owner role stage).
--   Offers never need approval. A bonus line outside an offer needs a sales manager unless the
--   submitter is one (or the owner). Offer validity and targeting are re-checked at submit, and the
--   order's offer lines must still match the offer (OFFER_CHANGED otherwise).

-- ---------------------------------------------------------------------------
-- 1. Pricing (internal)
-- ---------------------------------------------------------------------------
create or replace function sales.price_order(p_order_id uuid,
  out o_subtotal numeric, out o_discount numeric, out o_tax numeric, out o_max_manual numeric)
language plpgsql security definer set search_path = '' as $$
declare
  v_order sales.orders%rowtype; v_item record; v_price record; v_offer sales.offers%rowtype;
  v_today date := core.business_date(); v_sku text; v_rate numeric;
  v_promo numeric; v_applied numeric; v_gross numeric; v_disc numeric; v_promo_amt numeric; v_manual_amt numeric;
  v_manual_pct numeric; v_req_pct numeric; v_net_unit numeric;
  v_grp record; v_line record; v_target numeric; v_group_gross numeric; v_alloc numeric; v_left numeric;
  v_n int; v_i int; v_net_total numeric; v_inv numeric; v_share numeric;
begin
  select * into v_order from sales.orders where id = p_order_id;

  -- Pass 1: list price and line-level discounts.
  for v_item in select * from sales.order_items where order_id = p_order_id order by line_no for update loop
    -- Audit F2: a variant (or its product) discontinued after the draft was saved is refused.
    if not exists (select 1 from catalog.product_variants pv join catalog.products p on p.id = pv.product_id
                   where pv.id = v_item.variant_id and pv.status = 'active' and p.status = 'active') then
      select sku into v_sku from catalog.product_variants where id = v_item.variant_id;
      raise exception 'NOT_SELLABLE: % is no longer sold (discontinued or inactive)', coalesce(v_sku, v_item.variant_id::text)
        using errcode = 'P0001';
    end if;
    select p.tax_rate_pct into v_rate
    from catalog.product_variants pv join catalog.products p on p.id = pv.product_id where pv.id = v_item.variant_id;

    if v_item.is_bonus then
      update sales.order_items set list_price = 0, price_list_id = null, requested_discount_pct = 0,
             promo_discount_pct = 0, applied_discount_pct = 0, tax_rate_pct = v_rate, line_subtotal = 0,
             line_discount = 0, line_tax = 0, line_total = 0, invoice_discount_share = 0, manual_discount_pct = 0
      where id = v_item.id;
      continue;
    end if;

    select * into v_price from sales.resolve_list_price(v_order.customer_id, v_item.variant_id, v_item.quantity, v_today);
    if v_price.unit_price is null then
      raise exception 'NO_PRICE: variant % has no active price', v_item.variant_id using errcode = 'P0001';
    end if;
    v_gross := round(v_price.unit_price * v_item.quantity, 2);
    v_promo := 0; v_req_pct := v_item.requested_discount_pct; v_manual_pct := 0;

    if v_item.offer_id is not null then
      select * into v_offer from sales.offers where id = v_item.offer_id;
      if v_offer.pricing_mode = 'per_line' then
        select oi.net_unit_price into v_net_unit from sales.offer_items oi
        where oi.offer_id = v_item.offer_id and oi.variant_id = v_item.variant_id and not oi.is_bonus;
        if v_net_unit is null then
          raise exception 'OFFER_CHANGED: offer % no longer has this item; save the draft again', v_offer.code
            using errcode = 'P0001';
        end if;
        v_disc := greatest(v_gross - round(v_net_unit * v_item.quantity, 2), 0);   -- never above the list value
      else
        v_disc := 0;                                                              -- package: pass 2
      end if;
      v_req_pct := 0;
      v_applied := case when v_gross > 0 then round(v_disc / v_gross * 100, 2) else 0 end;
    else
      select coalesce(max(d.discount_pct), 0) into v_promo
      from sales.discount_rules d
      join catalog.product_variants pv on pv.id = v_item.variant_id
      join catalog.products p on p.id = pv.product_id
      where d.is_active and v_today between d.valid_from and coalesce(d.valid_to, v_today)
        and v_item.quantity >= d.min_qty
        and (d.variant_id is null or d.variant_id = v_item.variant_id)
        and (d.brand_id is null or d.brand_id = p.brand_id)
        and (d.category_id is null or d.category_id = p.category_id)
        and (d.customer_id is null or d.customer_id = v_order.customer_id);
      if v_item.requested_net_price is not null then
        if v_item.requested_net_price > v_price.unit_price then
          raise exception 'NET_PRICE_ABOVE_LIST: line % net price % is above the list price %',
            v_item.line_no, v_item.requested_net_price, v_price.unit_price using errcode = 'P0001';
        end if;
        v_promo_amt := round(v_gross * v_promo / 100, 2);
        v_manual_amt := round((v_price.unit_price - v_item.requested_net_price) * v_item.quantity, 2);
        v_req_pct := round((v_price.unit_price - v_item.requested_net_price) / v_price.unit_price * 100, 2);
        v_disc := greatest(v_promo_amt, v_manual_amt);
        v_applied := case when v_gross > 0 then round(v_disc / v_gross * 100, 2) else 0 end;
        v_manual_pct := case when v_gross > 0 then round(greatest(v_manual_amt - v_promo_amt, 0) / v_gross * 100, 2) else 0 end;
      else
        -- Unchanged rule: the larger of the promotion and the requested discount.
        v_applied := greatest(v_promo, v_item.requested_discount_pct);
        v_disc := round(v_gross * v_applied / 100, 2);
        v_manual_pct := greatest(v_item.requested_discount_pct - v_promo, 0);
      end if;
    end if;

    update sales.order_items set list_price = v_price.unit_price, price_list_id = v_price.price_list_id,
           requested_discount_pct = v_req_pct, promo_discount_pct = v_promo, applied_discount_pct = v_applied,
           tax_rate_pct = v_rate, line_subtotal = v_gross, line_discount = v_disc, invoice_discount_share = 0,
           manual_discount_pct = v_manual_pct, line_tax = 0, line_total = v_gross - v_disc
    where id = v_item.id;
  end loop;

  -- Pass 2: package offers — the package price × packages spread over the paid lines by list value.
  for v_grp in
    select oi.offer_id, max(oi.offer_packages) as packages, o.package_price
    from sales.order_items oi join sales.offers o on o.id = oi.offer_id
    where oi.order_id = p_order_id and not oi.is_bonus and o.pricing_mode = 'package'
    group by oi.offer_id, o.package_price
  loop
    select coalesce(sum(line_subtotal), 0), count(*) into v_group_gross, v_n
    from sales.order_items where order_id = p_order_id and offer_id = v_grp.offer_id and not is_bonus;
    v_target := least(round(v_grp.package_price * v_grp.packages, 2), v_group_gross);
    v_left := v_target; v_i := 0;
    for v_line in select id, line_subtotal from sales.order_items
                  where order_id = p_order_id and offer_id = v_grp.offer_id and not is_bonus order by line_no loop
      v_i := v_i + 1;
      if v_i = v_n then
        v_alloc := v_left;                                     -- the last line absorbs the rounding
      else
        v_alloc := case when v_group_gross > 0 then round(v_target * v_line.line_subtotal / v_group_gross, 2) else 0 end;
      end if;
      v_alloc := least(greatest(v_alloc, 0), v_line.line_subtotal);
      v_left := v_left - v_alloc;
      update sales.order_items set line_discount = line_subtotal - v_alloc,
             applied_discount_pct = case when line_subtotal > 0 then round((line_subtotal - v_alloc) / line_subtotal * 100, 2) else 0 end,
             line_total = v_alloc
      where id = v_line.id;
    end loop;
  end loop;

  -- Pass 3: invoice-level discount, spread by net value, rounding on the last line.
  select coalesce(sum(line_subtotal - line_discount), 0) into v_net_total
  from sales.order_items where order_id = p_order_id and not is_bonus;
  v_inv := coalesce(v_order.invoice_discount_amount, round(v_net_total * coalesce(v_order.invoice_discount_pct, 0) / 100, 2));
  if v_inv > 0 then
    if v_inv > v_net_total then
      raise exception 'INVOICE_DISCOUNT_TOO_LARGE: the invoice discount % is above the order net %', v_inv, v_net_total
        using errcode = 'P0001';
    end if;
    select count(*) into v_n from sales.order_items
    where order_id = p_order_id and not is_bonus and line_subtotal - line_discount > 0;
    v_left := v_inv; v_i := 0;
    for v_line in select id, line_subtotal, line_discount from sales.order_items
                  where order_id = p_order_id and not is_bonus and line_subtotal - line_discount > 0 order by line_no loop
      v_i := v_i + 1;
      if v_i = v_n then
        v_share := v_left;
      else
        v_share := round(v_inv * (v_line.line_subtotal - v_line.line_discount) / v_net_total, 2);
      end if;
      if v_share < 0 or v_share > v_line.line_subtotal - v_line.line_discount then
        raise exception 'INVOICE_DISCOUNT_TOO_LARGE: the invoice discount cannot be spread over these lines; change it slightly'
          using errcode = 'P0001';
      end if;
      v_left := v_left - v_share;
      update sales.order_items set invoice_discount_share = v_share, line_discount = line_discount + v_share,
             applied_discount_pct = round((line_discount + v_share) / line_subtotal * 100, 2),
             manual_discount_pct = least(manual_discount_pct + round(v_share / line_subtotal * 100, 2), 100),
             line_total = line_subtotal - line_discount - v_share
      where id = v_line.id;
    end loop;
  end if;

  -- Pass 4: VAT per line at the product's rate, on the discounted amount.
  update sales.order_items set
    line_tax   = round((line_subtotal - line_discount) * tax_rate_pct / 100, 2),
    line_total = line_subtotal - line_discount + round((line_subtotal - line_discount) * tax_rate_pct / 100, 2)
  where order_id = p_order_id;

  select coalesce(sum(line_subtotal), 0), coalesce(sum(line_discount), 0), coalesce(sum(line_tax), 0),
         coalesce(max(manual_discount_pct) filter (where not is_bonus), 0)
    into o_subtotal, o_discount, o_tax, o_max_manual
  from sales.order_items where order_id = p_order_id;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Discount authority of the caller (internal; shared by submit and preview)
-- ---------------------------------------------------------------------------
create or replace function sales.discount_check(p_max_manual numeric, p_free_items boolean)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  pol record; v_limit numeric; v_owner boolean := authz.is_owner();
  v_manager boolean := authz.has_permission('wf.decide.order_discount');
  v_exceeded boolean; v_owner_required boolean := false; v_free boolean;
  v_max numeric := coalesce(p_max_manual, 0);
begin
  select * into pol from sales.discount_policy();
  if pol.o_mode = 'tiered' then
    v_limit := case when v_owner then null when v_manager then pol.o_manager_max else pol.o_rep_max end;
  else
    v_limit := authz.max_limit('sales.discount.apply');            -- per_role: unchanged
  end if;
  if v_max > 0 and not authz.has_permission('sales.discount.apply') then
    v_exceeded := true;
  else
    v_exceeded := v_max > coalesce(v_limit, v_max);
  end if;
  if pol.o_mode = 'tiered' and v_exceeded and v_max > pol.o_manager_max then v_owner_required := true; end if;
  v_free := coalesce(p_free_items, false) and not (v_owner or v_manager);
  return jsonb_build_object(
    'mode', pol.o_mode, 'limit_pct', v_limit, 'max_manual_pct', v_max, 'manager_max_pct', pol.o_manager_max,
    'discount_exceeded', v_exceeded, 'owner_required', v_owner_required, 'free_item_approval', v_free,
    'needed', v_exceeded or v_free,
    'reasons', to_jsonb(array_remove(array[case when v_exceeded then 'discount above limit' end,
                                           case when v_free then 'free item outside an offer' end], null)));
end $$;

-- ---------------------------------------------------------------------------
-- 3. Answers
-- ---------------------------------------------------------------------------
-- The draft as api.save_order_draft answers it. From 20261103000300: same keys, plus the invoice
-- discount input and, per line, the bonus / offer / discount detail.
create or replace function sales.order_draft_answer(p_order_id uuid, p_created boolean, p_replayed boolean)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'order_id', o.id, 'version', o.version, 'status', o.status, 'created', p_created, 'replayed', p_replayed,
    'subtotal', o.subtotal, 'discount_total', o.discount_total, 'tax_total', o.tax_total,
    'indicative_total', o.subtotal - o.discount_total + o.tax_total,
    'invoice_discount_amount', o.invoice_discount_amount, 'invoice_discount_pct', o.invoice_discount_pct,
    'lines', coalesce((select jsonb_agg(jsonb_build_object('line_no', i.line_no, 'variant_id', i.variant_id,
                                'quantity', i.quantity, 'list_price', i.list_price,
                                'applied_discount_pct', i.applied_discount_pct, 'line_total', i.line_total,
                                'is_bonus', i.is_bonus, 'offer_id', i.offer_id, 'line_discount', i.line_discount,
                                'manual_discount_pct', i.manual_discount_pct, 'line_tax', i.line_tax) order by i.line_no)
                       from sales.order_items i where i.order_id = o.id), '[]'::jsonb))
  from sales.orders o where o.id = p_order_id
$$;

-- Full server-computed pricing of an order: totals, lines, VAT per rate. Internal (preview).
create or replace function sales.order_preview_answer(p_order_id uuid)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'subtotal', o.subtotal, 'discount_total', o.discount_total, 'tax_total', o.tax_total, 'total', o.total,
    'prices_include_vat', false,
    'invoice_discount_total', (select coalesce(sum(i.invoice_discount_share), 0) from sales.order_items i where i.order_id = o.id),
    'lines', coalesce((select jsonb_agg(jsonb_build_object(
                 'line_no', i.line_no, 'variant_id', i.variant_id, 'sku', v.sku, 'variant_name', v.name_en,
                 'quantity', i.quantity, 'is_bonus', i.is_bonus, 'offer_id', i.offer_id, 'offer_code', of.code,
                 'list_price', i.list_price, 'requested_net_price', i.requested_net_price,
                 'requested_discount_pct', i.requested_discount_pct, 'applied_discount_pct', i.applied_discount_pct,
                 'manual_discount_pct', i.manual_discount_pct, 'line_subtotal', i.line_subtotal,
                 'line_discount', i.line_discount, 'invoice_discount_share', i.invoice_discount_share,
                 'tax_rate_pct', i.tax_rate_pct, 'line_tax', i.line_tax, 'line_total', i.line_total) order by i.line_no)
               from sales.order_items i
               join catalog.product_variants v on v.id = i.variant_id
               left join sales.offers of on of.id = i.offer_id
               where i.order_id = o.id), '[]'::jsonb),
    'vat_groups', coalesce((select jsonb_agg(jsonb_build_object('rate', g.rate, 'taxable', g.taxable, 'vat', g.vat) order by g.rate desc)
                            from (select i.tax_rate_pct as rate, sum(i.line_subtotal - i.line_discount) as taxable, sum(i.line_tax) as vat
                                  from sales.order_items i where i.order_id = o.id and not i.is_bonus
                                  group by i.tax_rate_pct) g), '[]'::jsonb))
  from sales.orders o where o.id = p_order_id
$$;

-- ---------------------------------------------------------------------------
-- 4. api.save_order_draft — from 20261104000200_audit4_imports_drafts.sql. Changes (marked "pricing"):
--    p_lines is the old array, or {"lines": [...], "invoice_discount_amount"|"invoice_discount_pct": n};
--    a line is a product line {variant_id, quantity, requested_discount_pct? | net_unit_price?, is_bonus?}
--    or an offer line {offer_id, quantity?} (quantity = packages, default 1) that the server expands into
--    the offer's items. Lines are numbered in order after expansion. Everything else is unchanged:
--    replay by (order id, base version) + fingerprint of the request as sent, scope, concurrency, and
--    no client prices or totals.
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
  -- pricing
  v_lines jsonb; v_inv_amt numeric; v_inv_pct numeric; v_net numeric; v_bonus boolean; v_line_no int := 0;
  v_offer uuid; v_offers uuid[] := '{}'; v_problem text; v_code text; v_oi record; v_today date := core.business_date();
begin
  perform authz.require('sales.order.create');
  if p_order_id is null then raise exception 'VALIDATION: order id is required' using errcode = 'P0001'; end if;
  -- pricing: the payload is the line array, or an object with the lines and the invoice discount.
  if p_lines is not null and jsonb_typeof(p_lines) = 'object' then
    if exists (select 1 from jsonb_object_keys(p_lines) k where k not in ('lines', 'invoice_discount_amount', 'invoice_discount_pct')) then
      raise exception 'VALIDATION: the order may only contain lines, invoice_discount_amount, invoice_discount_pct' using errcode = 'P0001';
    end if;
    v_lines := p_lines -> 'lines';
    if coalesce(jsonb_typeof(p_lines -> 'invoice_discount_amount'), 'null') <> 'null' then
      if jsonb_typeof(p_lines -> 'invoice_discount_amount') <> 'number' then
        raise exception 'VALIDATION: invoice discount must be a number' using errcode = 'P0001';
      end if;
      v_inv_amt := (p_lines ->> 'invoice_discount_amount')::numeric;
      if v_inv_amt <= 0 or v_inv_amt <> round(v_inv_amt, 2) or v_inv_amt > 999999999999.99 then
        raise exception 'VALIDATION: invoice discount must be above 0 with at most 2 decimals' using errcode = 'P0001';
      end if;
    end if;
    if coalesce(jsonb_typeof(p_lines -> 'invoice_discount_pct'), 'null') <> 'null' then
      if jsonb_typeof(p_lines -> 'invoice_discount_pct') <> 'number' then
        raise exception 'VALIDATION: invoice discount percentage must be a number' using errcode = 'P0001';
      end if;
      v_inv_pct := (p_lines ->> 'invoice_discount_pct')::numeric;
      if v_inv_pct <= 0 or v_inv_pct > 100 or v_inv_pct <> round(v_inv_pct, 2) then
        raise exception 'VALIDATION: invoice discount percentage must be above 0 and at most 100, 2 decimals' using errcode = 'P0001';
      end if;
    end if;
    if v_inv_amt is not null and v_inv_pct is not null then
      raise exception 'VALIDATION: give the invoice discount as an amount or a percentage, not both' using errcode = 'P0001';
    end if;
  else
    v_lines := p_lines;
  end if;
  if v_lines is null or jsonb_typeof(v_lines) <> 'array' then
    raise exception 'VALIDATION: lines must be a JSON array' using errcode = 'P0001';
  end if;
  if jsonb_array_length(v_lines) > 200 then
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
    -- Audit 4 M-3: the answer carries the CURRENT draft (lines, prices, totals), so the caller must
    -- still be allowed to see it: the same customer and owner scope checks as a save, on the
    -- request's customer and on the order's current one. No state check: a late replay after
    -- submit is still answered.
    if exists (select 1 from crm.customers c
               where c.id in (p_customer_id, v_order.customer_id)
                 and not (authz.has_global('crm.customer.read')
                          or c.territory_id = any(authz.territory_ids('crm.customer.read'))
                          or c.id = any(authz.assigned_customer_ids('crm.customer.read')))) then
      raise exception 'PERMISSION_DENIED: customer not in your scope' using errcode = '42501';
    end if;
    if not (authz.has_global('sales.order.create')
            or v_order.employee_id = any(authz.employee_ids('sales.order.create'))
            or v_order.created_by = v_uid) then
      raise exception 'PERMISSION_DENIED: order belongs to another representative' using errcode = '42501';
    end if;
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
    insert into sales.orders (id, customer_id, employee_id, visit_id, notes, payment_terms_days, created_by,
                              invoice_discount_amount, invoice_discount_pct)
    values (p_order_id, p_customer_id, v_emp, p_visit_id, p_notes, v_cust.payment_terms_days, v_uid, v_inv_amt, v_inv_pct)
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
           invoice_discount_amount = v_inv_amt, invoice_discount_pct = v_inv_pct,
           version = case when p_version is null then version else version + 1 end, updated_at = now()
    where id = p_order_id;
  end if;

  for v_rec in select e.line, e.n from jsonb_array_elements(v_lines) with ordinality as e(line, n) loop
    if jsonb_typeof(v_rec.line) <> 'object' then
      raise exception 'VALIDATION: line % must be an object', v_rec.n using errcode = 'P0001';
    end if;

    if v_rec.line ? 'offer_id' then
      -- pricing: an offer line, expanded into the offer's items.
      if exists (select 1 from jsonb_object_keys(v_rec.line) k where k not in ('offer_id','quantity')) then
        raise exception 'VALIDATION: line % may only contain offer_id, quantity (an offer line)', v_rec.n using errcode = 'P0001';
      end if;
      v_offer := core.try_cast_uuid(v_rec.line ->> 'offer_id');
      if v_offer is null then raise exception 'VALIDATION: line % has no valid offer_id', v_rec.n using errcode = 'P0001'; end if;
      if coalesce(jsonb_typeof(v_rec.line -> 'quantity'), 'null') = 'null' then
        v_qty := 1;
      elsif jsonb_typeof(v_rec.line -> 'quantity') <> 'number' then
        raise exception 'VALIDATION: line % quantity must be a number', v_rec.n using errcode = 'P0001';
      else
        v_qty := (v_rec.line ->> 'quantity')::numeric;
      end if;
      if v_qty <> trunc(v_qty) or v_qty <= 0 or v_qty > 100000 then
        raise exception 'VALIDATION: line % quantity must be a whole number between 1 and 100000', v_rec.n using errcode = 'P0001';
      end if;
      if v_offer = any(v_offers) then
        raise exception 'VALIDATION: offer on line % is listed twice; raise its quantity instead', v_rec.n using errcode = 'P0001';
      end if;
      v_offers := v_offers || v_offer;
      v_problem := sales.offer_problem(v_offer, p_customer_id, v_today);
      if v_problem = 'NOT_FOUND' then raise exception 'NOT_FOUND: offer on line %', v_rec.n using errcode = 'P0002'; end if;
      if v_problem is not null then
        select code into v_code from sales.offers where id = v_offer;
        raise exception '%: offer % cannot be used for this customer today', v_problem, v_code using errcode = 'P0001';
      end if;
      for v_oi in select * from sales.offer_items where offer_id = v_offer order by line_no loop
        if v_oi.quantity * v_qty > 100000 then
          raise exception 'VALIDATION: line % quantity must be a whole number between 1 and 100000', v_rec.n using errcode = 'P0001';
        end if;
        if not exists (select 1 from catalog.product_variants pv join catalog.products p on p.id = pv.product_id
                       where pv.id = v_oi.variant_id and pv.status = 'active' and p.status = 'active') then
          raise exception 'NOT_FOUND: variant % is not sellable', v_oi.variant_id using errcode = 'P0002';
        end if;
        v_line_no := v_line_no + 1;
        insert into sales.order_items (order_id, line_no, variant_id, quantity, list_price, requested_discount_pct,
                                       tax_rate_pct, line_subtotal, line_discount, line_tax, line_total,
                                       is_bonus, offer_id, offer_packages)
        values (p_order_id, v_line_no, v_oi.variant_id, (v_oi.quantity * v_qty)::int, 0, 0, 0, 0, 0, 0, 0,
                v_oi.is_bonus, v_offer, v_qty::int);
      end loop;
      continue;
    end if;

    if exists (select 1 from jsonb_object_keys(v_rec.line) k
               where k not in ('variant_id','quantity','requested_discount_pct','net_unit_price','is_bonus')) then
      raise exception 'VALIDATION: line % may only contain variant_id, quantity, requested_discount_pct, net_unit_price, is_bonus', v_rec.n
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
    -- pricing: net price and bonus flag.
    if coalesce(jsonb_typeof(v_rec.line -> 'net_unit_price'), 'null') = 'null' then
      v_net := null;
    elsif jsonb_typeof(v_rec.line -> 'net_unit_price') <> 'number' then
      raise exception 'VALIDATION: line % net price must be a number', v_rec.n using errcode = 'P0001';
    else
      v_net := (v_rec.line ->> 'net_unit_price')::numeric;
      if v_net <= 0 or v_net <> round(v_net, 2) or v_net > 999999999999.99 then
        raise exception 'VALIDATION: line % net price must be above 0 with at most 2 decimals (free items are bonus lines)', v_rec.n
          using errcode = 'P0001';
      end if;
      if coalesce(jsonb_typeof(v_rec.line -> 'requested_discount_pct'), 'null') <> 'null' then
        raise exception 'VALIDATION: line % takes a net price or a discount, not both', v_rec.n using errcode = 'P0001';
      end if;
    end if;
    if coalesce(jsonb_typeof(v_rec.line -> 'is_bonus'), 'null') not in ('null', 'boolean') then
      raise exception 'VALIDATION: line % is_bonus must be true or false', v_rec.n using errcode = 'P0001';
    end if;
    v_bonus := coalesce((v_rec.line ->> 'is_bonus')::boolean, false);
    if v_bonus and (v_disc <> 0 or v_net is not null) then
      raise exception 'VALIDATION: line % is a bonus (free) line and takes no discount or price', v_rec.n using errcode = 'P0001';
    end if;
    if not exists (select 1 from catalog.product_variants pv join catalog.products p on p.id = pv.product_id
                   where pv.id = v_variant and pv.status = 'active' and p.status = 'active') then
      raise exception 'NOT_FOUND: variant % is not sellable', v_variant using errcode = 'P0002';
    end if;
    v_line_no := v_line_no + 1;
    insert into sales.order_items (order_id, line_no, variant_id, quantity, list_price, requested_discount_pct,
                                   tax_rate_pct, line_subtotal, line_discount, line_tax, line_total,
                                   is_bonus, requested_net_price)
    values (p_order_id, v_line_no, v_variant, v_qty::int, 0, round(v_disc, 2), 0, 0, 0, 0, 0, v_bonus, v_net);
  end loop;
  if v_line_no > 200 then
    raise exception 'VALIDATION: at most 200 lines per order' using errcode = 'P0001';
  end if;

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
-- 5. api.submit_order — from 20261029000300_orders_inventory_workflow.sql. Changes (marked "pricing"):
--    offers re-checked (validity, targeting, composition), discount authority by sales.discount_check
--    (per_role = unchanged; tiered = decision B), the free-item reason, owner routing. Unchanged:
--    pricing at submit, credit check (D-09), document number, history, outbox, request payload keys.
-- ---------------------------------------------------------------------------
create or replace function api.submit_order(p_order_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_order sales.orders%rowtype;
  v_limit numeric;
  v_max_requested numeric;
  v_tot record;
  v_sub numeric; v_disc numeric; v_tax numeric; v_total numeric;
  v_status text;
  v_territory uuid;
  v_credit_limit numeric; v_balance numeric;
  v_discount_exceeded boolean; v_credit_exceeded boolean := false;
  v_reasons text[] := '{}';
  v_request uuid;
  -- pricing
  v_o record; v_problem text; v_chk jsonb; v_free boolean; v_owner_required boolean; v_metric numeric;
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

  -- pricing: every offer on the order is still valid for this customer today, and unchanged.
  for v_o in select oi.offer_id, max(oi.offer_packages) as packages, o.code
             from sales.order_items oi join sales.offers o on o.id = oi.offer_id
             where oi.order_id = p_order_id group by oi.offer_id, o.code loop
    v_problem := sales.offer_problem(v_o.offer_id, v_order.customer_id, core.business_date());
    if v_problem is not null then
      raise exception '%: offer % cannot be used for this customer today', v_problem, v_o.code using errcode = 'P0001';
    end if;
    if exists ((select i.variant_id, i.is_bonus, (i.quantity * v_o.packages)::int from sales.offer_items i where i.offer_id = v_o.offer_id
                except all
                select oi.variant_id, oi.is_bonus, oi.quantity from sales.order_items oi
                where oi.order_id = p_order_id and oi.offer_id = v_o.offer_id)
               union all
               (select oi.variant_id, oi.is_bonus, oi.quantity from sales.order_items oi
                where oi.order_id = p_order_id and oi.offer_id = v_o.offer_id
                except all
                select i.variant_id, i.is_bonus, (i.quantity * v_o.packages)::int from sales.offer_items i where i.offer_id = v_o.offer_id)) then
      raise exception 'OFFER_CHANGED: offer % changed after this draft was saved; save the draft again', v_o.code
        using errcode = 'P0001';
    end if;
  end loop;

  select * into v_tot from sales.price_order(p_order_id);
  v_sub := v_tot.o_subtotal; v_disc := v_tot.o_discount; v_tax := v_tot.o_tax; v_max_requested := v_tot.o_max_manual;
  -- An order of free lines only has a 0 subtotal but lines: still refused as empty of value.
  if v_sub = 0 then raise exception 'EMPTY_ORDER' using errcode = 'P0001'; end if;
  v_total := v_sub - v_disc + v_tax;

  -- pricing: discount authority (per_role: the role limit, as before; tiered: decision B).
  v_free := exists (select 1 from sales.order_items where order_id = p_order_id and is_bonus and offer_id is null);
  v_chk := sales.discount_check(v_max_requested, v_free);
  v_limit := (v_chk ->> 'limit_pct')::numeric;
  v_owner_required := (v_chk ->> 'owner_required')::boolean;
  v_discount_exceeded := (v_chk ->> 'discount_exceeded')::boolean;
  if v_discount_exceeded then v_reasons := array_append(v_reasons, 'discount above limit'); end if;
  if (v_chk ->> 'free_item_approval')::boolean then v_reasons := array_append(v_reasons, 'free item outside an offer'); end if;
  -- The decision-B tiers route by rule (owner_required); a manager in scope may decide the rest.
  v_metric := case when v_chk ->> 'mode' = 'tiered' then 0 else greatest(v_max_requested, 0) end;

  -- Credit check (D-09): AR balance + this order vs credit limit → approval, not a hard block.
  select territory_id, credit_limit into v_territory, v_credit_limit from crm.customers where id = v_order.customer_id;
  if v_credit_limit is not null then
    select coalesce((select balance from finance.v_customer_balances where customer_id = v_order.customer_id), 0)
      into v_balance;
    v_credit_exceeded := v_balance + v_total > v_credit_limit;
    if v_credit_exceeded then v_reasons := array_append(v_reasons, 'credit limit'); end if;
  end if;

  v_status := case when (v_chk ->> 'needed')::boolean or v_credit_exceeded then 'pending_approval' else 'submitted' end;

  update sales.orders set
    order_no = coalesce(order_no, core.next_document_no('SO')),
    subtotal = v_sub, discount_total = v_disc, tax_total = v_tax, total = v_total,
    status = v_status, submitted_at = now(),
    territory_id = v_territory,
    version = version + 1, updated_at = now()
  where id = p_order_id
  returning * into v_order;

  insert into sales.order_status_history (order_id, from_status, to_status, changed_by, reason)
  values (p_order_id, 'draft', v_status, auth.uid(),
          case when v_status = 'pending_approval' then array_to_string(v_reasons, '; ') end);

  if v_status = 'pending_approval' then
    v_request := wf.create_request('sales.order.discount', 'sales.order', p_order_id,
      jsonb_build_object(
        'order_id', p_order_id, 'order_no', v_order.order_no, 'customer_id', v_order.customer_id,
        'employee_id', v_order.employee_id, 'territory_id', v_territory,
        'reasons', to_jsonb(v_reasons),
        -- A free item outside an offer goes to the discount approver: routed as a discount.
        'discount_exceeded', v_discount_exceeded or (v_chk ->> 'free_item_approval')::boolean,
        'credit_exceeded', v_credit_exceeded,
        'max_manual_discount_pct', greatest(v_max_requested, 0), 'limit_pct', v_limit,
        'limit_mode', v_chk ->> 'mode', 'owner_required', v_owner_required,
        'free_items', (v_chk ->> 'free_item_approval')::boolean,
        'total', v_total, 'credit_limit', v_credit_limit, 'balance', v_balance,
        'exposure', case when v_credit_limit is not null then v_balance + v_total end,
        'credit_excess', case when v_credit_exceeded then v_balance + v_total - v_credit_limit end,
        'limit_metric', v_metric,
        'limit_metrics', jsonb_strip_nulls(jsonb_build_object(
            'wf.decide.order_discount', v_metric,
            'wf.decide.credit_limit', case when v_credit_exceeded then v_balance + v_total - v_credit_limit end))),
      v_order.employee_id);
  end if;

  insert into integration.outbox (event_type, aggregate_type, aggregate_id, payload)
  values ('order.' || v_status, 'sales.order', p_order_id,
          jsonb_build_object('order_id', p_order_id, 'order_no', v_order.order_no, 'status', v_status,
                             'total', v_total, 'reasons', to_jsonb(v_reasons)));

  return jsonb_build_object('order_id', p_order_id, 'status', v_status, 'total', v_total,
                            'reasons', to_jsonb(v_reasons), 'approval_request_id', v_request);
end $$;

-- ---------------------------------------------------------------------------
-- 6. api.preview_order — the server's pricing of a would-be draft, saved nothing.
--    Runs api.save_order_draft (every check and the full pricing) on a throw-away id inside a
--    sub-transaction that is always rolled back; returns totals, lines, VAT per rate and whether the
--    caller's submit would need approval (discount / free item; the credit check runs at submit).
-- ---------------------------------------------------------------------------
create or replace function api.preview_order(p_customer_id uuid, p_lines jsonb, p_employee_id uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_id uuid := gen_random_uuid(); v_result jsonb;
begin
  perform authz.require('sales.order.create');
  begin
    perform api.save_order_draft(v_id, p_customer_id, p_lines, null, null, null, p_employee_id);
    select sales.order_preview_answer(v_id)
           || jsonb_build_object('approval', sales.discount_check(
                (select coalesce(max(manual_discount_pct) filter (where not is_bonus), 0) from sales.order_items where order_id = v_id),
                exists (select 1 from sales.order_items where order_id = v_id and is_bonus and offer_id is null)))
      into v_result;
    raise exception 'PREVIEW_ROLLBACK' using errcode = 'HOPRV';
  exception when sqlstate 'HOPRV' then
    null;   -- everything the save wrote is rolled back; v_result keeps the answer
  end;
  return v_result;
end $$;

-- ---------------------------------------------------------------------------
-- 7. api.issue_invoice — from 20261031000100_finance_ar_commands.sql. Changes (marked "pricing"):
--    the bonus flag is copied to the invoice line, and a partial invoice of a line priced by net
--    price, offer or invoice-discount share takes its discount pro rata from the line's discount
--    amount (old-style percentage lines keep the old formula). VAT is never recomputed from the
--    product: the invoice line takes the rate stored on the order line, and keeps it for good.
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
           oi.applied_discount_pct, oi.tax_rate_pct, oi.line_discount, oi.line_tax, oi.is_bonus,
           -- pricing: an old-style line's discount is exactly its percentage of the list value
           (oi.line_discount = round(oi.list_price * oi.quantity * oi.applied_discount_pct / 100, 2)) as pct_priced,
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
      v_disc := case when v_it.pct_priced then round(v_it.list_price * v_q * v_it.applied_discount_pct / 100, 2)
                     else round(v_it.line_discount * v_q / v_it.quantity, 2) end;
      v_tax  := round((v_gross - v_disc) * v_it.tax_rate_pct / 100, 2);
    end if;
    v_sub := v_sub + v_gross; v_dsum := v_dsum + v_disc; v_tsum := v_tsum + v_tax;
    v_lines := v_lines || jsonb_build_object(
      'order_item_id', v_it.id, 'variant_id', v_it.variant_id, 'description', v_it.description,
      'quantity', v_q, 'unit_price', v_it.list_price, 'line_subtotal', v_gross, 'discount', v_disc,
      'tax_rate_pct', v_it.tax_rate_pct, 'tax_amount', v_tax, 'line_total', v_gross - v_disc + v_tax,
      'is_bonus', v_it.is_bonus);
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
                                     discount, tax_rate_pct, tax_amount, line_total, line_subtotal, is_bonus)
  select v_id, l.order_item_id, l.variant_id, l.description, l.quantity, l.unit_price,
         l.discount, l.tax_rate_pct, l.tax_amount, l.line_total, l.line_subtotal, l.is_bonus
  from jsonb_to_recordset(v_lines) as l(order_item_id uuid, variant_id uuid, description text, quantity int,
                                        unit_price numeric, line_subtotal numeric, discount numeric,
                                        tax_rate_pct numeric, tax_amount numeric, line_total numeric, is_bonus boolean);

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
-- 8. Views: columns appended (existing columns unchanged, same order)
-- ---------------------------------------------------------------------------
create or replace view api.v_orders with (security_invoker = true) as
  select o.id, o.order_no, o.client_ref, o.customer_id, c.display_name as customer_name,
         o.employee_id, e.full_name_en as employee_name, o.territory_id, o.visit_id, o.status, o.currency,
         o.payment_terms_days, o.subtotal, o.discount_total, o.tax_total, o.total, o.notes,
         o.submitted_at, o.approved_at, o.version, o.created_at, o.updated_at,
         (select r.id from wf.approval_requests r
          where r.entity_id = o.id and r.status = 'pending' order by r.created_at limit 1) as pending_approval_request_id,
         o.invoice_discount_amount, o.invoice_discount_pct
  from sales.orders o
  left join crm.customers c on c.id = o.customer_id
  left join core.employees e on e.id = o.employee_id;

create or replace view api.v_order_lines with (security_invoker = true) as
  select oi.id as order_item_id, oi.order_id, oi.line_no, oi.variant_id, v.sku, v.name_en as variant_name,
         oi.quantity, oi.list_price, oi.requested_discount_pct, oi.promo_discount_pct, oi.applied_discount_pct,
         oi.tax_rate_pct, oi.line_subtotal, oi.line_discount, oi.line_tax, oi.line_total,
         oi.fulfilled_qty, oi.returned_qty,
         coalesce((select sum(r.quantity) from inventory.reservations r
                   where r.order_item_id = oi.id and r.status = 'active'), 0)::int as reserved_qty,
         oi.is_bonus, oi.offer_id, ofr.code as offer_code, oi.offer_packages, oi.requested_net_price,
         oi.invoice_discount_share, oi.manual_discount_pct
  from sales.order_items oi
  left join catalog.product_variants v on v.id = oi.variant_id
  left join sales.offers ofr on ofr.id = oi.offer_id;

create or replace view api.v_invoice_lines with (security_invoker = true) as
  select ii.id as invoice_item_id, ii.invoice_id, ii.order_item_id, ii.variant_id, v.sku, ii.description,
         ii.quantity, ii.unit_price,
         coalesce(ii.line_subtotal, round(ii.unit_price * ii.quantity, 2))::numeric(14,2) as line_subtotal,
         ii.discount, ii.tax_rate_pct, ii.tax_amount, ii.line_total,
         coalesce(cn.qty, 0)::int as credited_qty, coalesce(cn.total, 0)::numeric(14,2) as credited_amount,
         ii.is_bonus
  from finance.invoice_items ii
  left join catalog.product_variants v on v.id = ii.variant_id
  left join lateral (select sum(ci.quantity) as qty, sum(ci.amount + ci.tax_amount) as total
                     from finance.credit_note_items ci where ci.invoice_item_id = ii.id) cn on true;

-- ---------------------------------------------------------------------------
-- 9. Privileges (CREATE OR REPLACE keeps grants; restated, and new functions revoked from PUBLIC)
-- ---------------------------------------------------------------------------
revoke execute on function sales.price_order(uuid) from public, anon, authenticated;
revoke execute on function sales.discount_check(numeric, boolean) from public, anon, authenticated;
revoke execute on function sales.order_draft_answer(uuid, boolean, boolean) from public, anon, authenticated;
revoke execute on function sales.order_preview_answer(uuid) from public, anon, authenticated;
revoke execute on function api.save_order_draft(uuid, uuid, jsonb, text, uuid, int, uuid) from public, anon;
revoke execute on function api.submit_order(uuid) from public, anon;
revoke execute on function api.preview_order(uuid, jsonb, uuid) from public, anon;
revoke execute on function api.issue_invoice(uuid, text) from public, anon;
grant execute on function api.save_order_draft(uuid, uuid, jsonb, text, uuid, int, uuid) to authenticated;
grant execute on function api.submit_order(uuid) to authenticated;
grant execute on function api.preview_order(uuid, jsonb, uuid) to authenticated;
grant execute on function api.issue_invoice(uuid, text) to authenticated;
grant select on api.v_orders, api.v_order_lines, api.v_invoice_lines to authenticated;
revoke all on api.v_orders, api.v_order_lines, api.v_invoice_lines from anon;
