-- Honest OS migration: read views for the inventory workspace (Phase 3 task 8).
--
-- Views only: no table, column, policy or function changes. Every view is
-- security_invoker, so the caller's RLS on the underlying tables decides what
-- comes back (warehouses/lots: inventory.stock.read; balances: stock scope;
-- receipts/transfers: their own policies; catalog: catalog.product.read).
-- Lot-level and on-hand/reserved figures stay limited to inventory roles
-- (inventory.module.access), exactly like api.v_stock_detail; reps keep
-- api.v_stock_available. Tests: supabase/tests/database/22_inventory_ui.test.sql.
--
-- "Sellable" matches audit rule (a) (DECISIONS 2026-10-29): an active warehouse
-- that is not quarantine or transit, and a lot that has not expired.
-- "Near expiry" = expires within 90 days (DASHBOARDS: 30/60/90-day buckets).
-- "Below reorder" = sellable available, summed over every sellable warehouse the
-- caller can see, is at or below the variant's reorder_point (> 0).

-- ---------------------------------------------------------------------------
-- 1. Warehouses, with whether their stock can be sold.
-- ---------------------------------------------------------------------------
create or replace view api.v_inventory_warehouses with (security_invoker = true) as
  select w.id, w.code, w.name, w.kind, w.is_active, w.allow_negative,
         (w.is_active and w.kind not in ('quarantine', 'transit')) as is_sellable
  from inventory.warehouses w;

-- ---------------------------------------------------------------------------
-- 2. Variants for inventory pickers and brand/product filters (no prices, no costs).
-- ---------------------------------------------------------------------------
create or replace view api.v_inventory_variants with (security_invoker = true) as
  select v.id as variant_id, v.sku, v.name_en as variant_name, v.uom, v.reorder_point, v.status as variant_status,
         p.id as product_id, p.code as product_code, p.name_en as product_name, p.name_ar as product_name_ar,
         p.status as product_status, p.is_lot_tracked, p.is_expiry_tracked,
         b.id as brand_id, b.code as brand_code, b.name as brand_name
  from catalog.product_variants v
  join catalog.products p on p.id = v.product_id
  join catalog.brands b on b.id = p.brand_id;

-- ---------------------------------------------------------------------------
-- 3. Stock per warehouse × variant with expiry signals (inventory roles only).
--    Rows whose lots are all zero (no on-hand, nothing reserved) are left out.
-- ---------------------------------------------------------------------------
create or replace view api.v_inventory_stock with (security_invoker = true) as
  with s as (
    select b.warehouse_id, b.variant_id,
           sum(b.on_hand)::int as on_hand,
           sum(b.reserved)::int as reserved,
           sum(b.on_hand - b.reserved)::int as available,
           sum(case when l.expiry_date is null or l.expiry_date >= current_date
                    then greatest(b.on_hand - b.reserved, 0) else 0 end)::int as unexpired_available,
           sum(case when l.expiry_date < current_date then greatest(b.on_hand, 0) else 0 end)::int as expired_qty,
           sum(case when l.expiry_date >= current_date and l.expiry_date < current_date + 90
                    then greatest(b.on_hand, 0) else 0 end)::int as near_expiry_qty,
           min(l.expiry_date) filter (where b.on_hand > 0 and l.expiry_date >= current_date) as earliest_expiry,
           (count(*) filter (where b.on_hand <> 0))::int as lot_count
    from inventory.stock_balances b
    join inventory.lots l on l.id = b.lot_id
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
         (s.earliest_expiry - current_date) as days_to_earliest_expiry, s.lot_count
  from s
  join inventory.warehouses w on w.id = s.warehouse_id
  join catalog.product_variants v on v.id = s.variant_id
  join catalog.products p on p.id = v.product_id
  join catalog.brands br on br.id = p.brand_id
  where (select authz.has_permission('inventory.module.access'));

-- ---------------------------------------------------------------------------
-- 4. Reorder alerts: active variants with a reorder point whose sellable stock
--    is at or below it — including variants with no stock at all.
-- ---------------------------------------------------------------------------
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
      and (l.expiry_date is null or l.expiry_date >= current_date)
  ) a on true
  where v.reorder_point > 0 and v.status = 'active' and p.status = 'active'
    and coalesce(a.sellable_available, 0) <= v.reorder_point
    and (select authz.has_permission('inventory.module.access'));

-- ---------------------------------------------------------------------------
-- 5. Goods receipts with their lines. Unit cost only for catalog.cost.read.
-- ---------------------------------------------------------------------------
create or replace view api.v_goods_receipts with (security_invoker = true) as
  select g.id, g.receipt_no, g.warehouse_id, w.code as warehouse_code, w.name as warehouse_name,
         w.kind as warehouse_kind, g.supplier, g.shipment_ref, g.status, g.received_at,
         g.created_by, g.posted_by, g.posted_at,
         coalesce(i.line_count, 0)::int as line_count,
         coalesce(i.total_quantity, 0)::int as total_quantity,
         coalesce(i.items, '[]'::jsonb) as items
  from inventory.goods_receipts g
  left join inventory.warehouses w on w.id = g.warehouse_id
  left join lateral (
    select count(*) as line_count, sum(gi.quantity) as total_quantity,
           jsonb_agg(jsonb_build_object(
             'item_id', gi.id, 'variant_id', gi.variant_id, 'sku', pv.sku, 'variant_name', pv.name_en,
             'lot_no', gi.lot_no, 'expiry_date', gi.expiry_date, 'quantity', gi.quantity,
             'unit_cost', case when (select authz.has_permission('catalog.cost.read')) then gi.unit_cost end)
             order by pv.sku, gi.lot_no, gi.id) as items
    from inventory.goods_receipt_items gi
    left join catalog.product_variants pv on pv.id = gi.variant_id
    where gi.receipt_id = g.id
  ) i on true;

-- ---------------------------------------------------------------------------
-- 6. Transfer lines with SKU and lot (api.v_transfers carries ids only).
-- ---------------------------------------------------------------------------
create or replace view api.v_transfer_lines with (security_invoker = true) as
  select ti.id as item_id, ti.transfer_id, ti.variant_id, pv.sku, pv.name_en as variant_name,
         ti.lot_id, l.lot_no, l.expiry_date, ti.quantity, ti.received_qty
  from inventory.transfer_items ti
  left join catalog.product_variants pv on pv.id = ti.variant_id
  left join inventory.lots l on l.id = ti.lot_id;

grant select on api.v_inventory_warehouses, api.v_inventory_variants, api.v_inventory_stock,
                api.v_reorder_alerts, api.v_goods_receipts, api.v_transfer_lines to authenticated;
revoke all on api.v_inventory_warehouses, api.v_inventory_variants, api.v_inventory_stock,
              api.v_reorder_alerts, api.v_goods_receipts, api.v_transfer_lines from anon;
