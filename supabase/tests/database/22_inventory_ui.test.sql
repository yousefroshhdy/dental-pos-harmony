-- Inventory workspace read views (20261030000400_inventory_ui_views.sql):
-- warehouses + sellability, stock with expiry signals, reorder alerts, goods
-- receipts with cost masking, transfer lines. Roles allowed / denied / scoped.
begin;
select tests.load_fixture();
select plan(37);

-- ---------------------------------------------------------------------------
-- Scenario (as the table owner; movements go through the ledger trigger)
--   WH-CAI main · WH-QUA quarantine · WH-TRN transit
--   V1 BIO-TOP-4110 reorder 20 · V2 DRB-MIR-5 (Derby) reorder 5, no stock · V3 BIO-TOP-3508 reorder 0
-- ---------------------------------------------------------------------------
insert into inventory.warehouses (id, code, name, kind) values
  ('60000000-0000-0000-0000-000000000021', 'WH-QUA', 'Quarantine', 'quarantine'),
  ('60000000-0000-0000-0000-000000000022', 'WH-TRN', 'In transit', 'transit');

update catalog.product_variants set reorder_point = 20 where id = '53000000-0000-0000-0000-000000000001';
insert into catalog.products (id, brand_id, category_id, code, name_en)
select '52000000-0000-0000-0000-000000000022', b.id, c.id, 'DRB-MIR', 'Derby mouth mirror'
from catalog.brands b, catalog.categories c where b.code = 'DERBY' and c.code = 'INSTRUMENT';
insert into catalog.product_variants (id, product_id, sku, name_en, reorder_point) values
  ('53000000-0000-0000-0000-000000000022', '52000000-0000-0000-0000-000000000022', 'DRB-MIR-5', 'Mirror #5', 5),
  ('53000000-0000-0000-0000-000000000023', '52000000-0000-0000-0000-000000000001', 'BIO-TOP-3508', 'Top DM 3.5x8', 0);

insert into inventory.lots (id, variant_id, lot_no, expiry_date) values
  ('61000000-0000-0000-0000-000000000021', '53000000-0000-0000-0000-000000000001', 'LNEAR', core.business_date() + 30),
  ('61000000-0000-0000-0000-000000000022', '53000000-0000-0000-0000-000000000001', 'LOLD', core.business_date() - 10),
  ('61000000-0000-0000-0000-000000000023', '53000000-0000-0000-0000-000000000023', 'NO-LOT', null);

insert into inventory.movements (movement_type, warehouse_id, variant_id, lot_id, quantity, source_doc_type) values
  ('receipt', '60000000-0000-0000-0000-000000000001', '53000000-0000-0000-0000-000000000001', '61000000-0000-0000-0000-000000000001', 10, 'receipt'),
  ('receipt', '60000000-0000-0000-0000-000000000001', '53000000-0000-0000-0000-000000000001', '61000000-0000-0000-0000-000000000021', 4, 'receipt'),
  ('receipt', '60000000-0000-0000-0000-000000000001', '53000000-0000-0000-0000-000000000001', '61000000-0000-0000-0000-000000000022', 2, 'receipt'),
  ('receipt', '60000000-0000-0000-0000-000000000021', '53000000-0000-0000-0000-000000000001', '61000000-0000-0000-0000-000000000022', 3, 'receipt'),
  ('receipt', '60000000-0000-0000-0000-000000000022', '53000000-0000-0000-0000-000000000001', '61000000-0000-0000-0000-000000000001', 5, 'receipt'),
  ('receipt', '60000000-0000-0000-0000-000000000001', '53000000-0000-0000-0000-000000000023', '61000000-0000-0000-0000-000000000023', 1, 'receipt'),
  ('adjustment_out', '60000000-0000-0000-0000-000000000001', '53000000-0000-0000-0000-000000000023', '61000000-0000-0000-0000-000000000023', -1, 'adjustment');
update inventory.stock_balances set reserved = 1
where warehouse_id = '60000000-0000-0000-0000-000000000001' and lot_id = '61000000-0000-0000-0000-000000000001';

-- A warehouse-scoped keeper of the quarantine warehouse only.
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000b1', 'keeper.qua@honest.test');
insert into core.employees (id, employee_no, user_id, full_name_en, job_title, manager_id) values
  ('20000000-0000-0000-0000-0000000000b1', 'E0B1', '00000000-0000-0000-0000-0000000000b1', 'Keeper QUA', 'Storekeeper',
   '20000000-0000-0000-0000-000000000008');
insert into core.user_profiles (user_id, employee_id) values ('00000000-0000-0000-0000-0000000000b1', '20000000-0000-0000-0000-0000000000b1');
insert into authz.roles (id, code, name_en) values ('70000000-0000-0000-0000-0000000000b1', 'test_wh_keeper', 'Test keeper');
insert into authz.role_permissions (role_id, permission_code, scope) values
  ('70000000-0000-0000-0000-0000000000b1', 'inventory.module.access', 'all'),
  ('70000000-0000-0000-0000-0000000000b1', 'inventory.stock.read', 'warehouse'),
  ('70000000-0000-0000-0000-0000000000b1', 'inventory.receipt.post', 'warehouse'),
  ('70000000-0000-0000-0000-0000000000b1', 'catalog.product.read', 'all');
insert into authz.user_roles (user_id, role_id, scope_warehouse_id) values
  ('00000000-0000-0000-0000-0000000000b1', '70000000-0000-0000-0000-0000000000b1', '60000000-0000-0000-0000-000000000021');

-- ---------------------------------------------------------------------------
-- Structure
-- ---------------------------------------------------------------------------
select is((select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'api' and c.relkind = 'v' and c.reloptions @> array['security_invoker=true']
             and c.relname in ('v_inventory_warehouses','v_inventory_variants','v_inventory_stock',
                               'v_reorder_alerts','v_goods_receipts','v_transfer_lines')),
          6, 'the six inventory UI views exist and are security_invoker');
select is((select count(*)::int from unnest(array['api.v_inventory_warehouses','api.v_inventory_variants','api.v_inventory_stock',
                                                  'api.v_reorder_alerts','api.v_goods_receipts','api.v_transfer_lines']) v
           where has_table_privilege('anon', v, 'select')), 0, 'anon can read none of them');
select is((select count(*)::int from unnest(array['api.v_inventory_warehouses','api.v_inventory_variants','api.v_inventory_stock',
                                                  'api.v_reorder_alerts','api.v_goods_receipts','api.v_transfer_lines']) v
           where has_table_privilege('authenticated', v, 'select')
             and not has_table_privilege('authenticated', v, 'insert')), 6, 'authenticated may select (read-only) all of them');

-- ---------------------------------------------------------------------------
-- Inventory manager (a8): full picture
-- ---------------------------------------------------------------------------
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a8');
select is((select string_agg(code || ':' || kind || ':' || is_sellable, ',' order by code) from api.v_inventory_warehouses),
          'WH-CAI:main:true,WH-QUA:quarantine:false,WH-TRN:transit:false', 'warehouses carry kind and sellability');
select is((select brand_code || '/' || is_expiry_tracked from api.v_inventory_variants where sku = 'DRB-MIR-5'), 'DERBY/false',
          'variants carry brand and tracking flags');

select is((select on_hand || '/' || reserved || '/' || available from api.v_inventory_stock
           where warehouse_code = 'WH-CAI' and sku = 'BIO-TOP-4110'), '16/1/15', 'main warehouse: on hand, reserved, available over all lots');
select is((select sellable_available from api.v_inventory_stock where warehouse_code = 'WH-CAI' and sku = 'BIO-TOP-4110'), 13,
          'sellable excludes the expired lot');
select is((select expired_qty || '/' || near_expiry_qty from api.v_inventory_stock where warehouse_code = 'WH-CAI' and sku = 'BIO-TOP-4110'),
          '2/4', 'expired and near-expiry quantities');
select is((select earliest_expiry from api.v_inventory_stock where warehouse_code = 'WH-CAI' and sku = 'BIO-TOP-4110'),
          core.business_date() + 30, 'earliest unexpired expiry');
select is((select days_to_earliest_expiry from api.v_inventory_stock where warehouse_code = 'WH-CAI' and sku = 'BIO-TOP-4110'), 30,
          'days to the earliest expiry');
select is((select lot_count from api.v_inventory_stock where warehouse_code = 'WH-CAI' and sku = 'BIO-TOP-4110'), 3, 'lots with stock');
select is((select brand_code from api.v_inventory_stock where warehouse_code = 'WH-CAI' and sku = 'BIO-TOP-4110'), 'BIONER', 'brand on stock rows');
select is((select is_sellable || '/' || on_hand || '/' || sellable_available from api.v_inventory_stock where warehouse_code = 'WH-QUA'),
          'false/3/0', 'quarantine stock is counted but never sellable');
select is((select is_sellable || '/' || on_hand || '/' || sellable_available from api.v_inventory_stock where warehouse_code = 'WH-TRN'),
          'false/5/0', 'transit stock is counted but never sellable');
select is((select count(*)::int from api.v_inventory_stock where sku = 'BIO-TOP-3508'), 0, 'all-zero balances are hidden');

select is((select string_agg(sku || ':' || sellable_available || ':' || shortfall, ',' order by sku) from api.v_reorder_alerts),
          'BIO-TOP-4110:13:7,DRB-MIR-5:0:5', 'reorder alerts: low stock and no stock; no alert without a reorder point');
select is((select sellable_available from api.v_reorder_alerts where sku = 'BIO-TOP-4110'),
          (select sum(available)::int from api.v_stock_available where sku = 'BIO-TOP-4110'),
          'reorder stock agrees with api.v_stock_available');

-- Goods receipt round trip
select api.create_goods_receipt('60000000-0000-0000-0000-000000000001', 'Synthetic Supplier', 'SHP-UI-1',
  '[{"variant_id":"53000000-0000-0000-0000-000000000001","lot_no":"LUI1","expiry_date":"2031-01-31","quantity":6,"unit_cost":500},
    {"variant_id":"53000000-0000-0000-0000-000000000022","lot_no":"NO-LOT","quantity":2,"unit_cost":40}]');
select is((select status || '/' || line_count || '/' || total_quantity || '/' || warehouse_kind from api.v_goods_receipts
           where shipment_ref = 'SHP-UI-1'), 'draft/2/8/main', 'draft receipt with line count and quantity');
select is((select items -> 0 ->> 'sku' || '/' || (items -> 0 ->> 'lot_no') || '/' || (items -> 0 ->> 'expiry_date') || '/' || (items -> 0 ->> 'unit_cost')
           from api.v_goods_receipts where shipment_ref = 'SHP-UI-1'), 'BIO-TOP-4110/LUI1/2031-01-31/500.00',
          'receipt lines carry SKU, lot, expiry and (for cost readers) unit cost');
select api.post_goods_receipt((select id from api.v_goods_receipts where shipment_ref = 'SHP-UI-1'));
select is((select status || '/' || (posted_by = '00000000-0000-0000-0000-0000000000a8') from api.v_goods_receipts where shipment_ref = 'SHP-UI-1'),
          'posted/true', 'posted status and poster shown');
select is((select count(*)::int from api.v_reorder_alerts where sku = 'DRB-MIR-5'), 1, 'still at or below reorder point after 2 units (5)');

-- Transfer lines
select api.create_transfer('60000000-0000-0000-0000-000000000001', '60000000-0000-0000-0000-000000000021',
  '[{"variant_id":"53000000-0000-0000-0000-000000000001","lot_id":"61000000-0000-0000-0000-000000000021","quantity":2}]');
select is((select string_agg(sku || ':' || lot_no || ':' || quantity || ':' || received_qty, ',') from api.v_transfer_lines),
          'BIO-TOP-4110:LNEAR:2:0', 'transfer lines carry SKU and lot');
select is((select expiry_date from api.v_transfer_lines), core.business_date() + 30, 'transfer lines carry the lot expiry');

-- ---------------------------------------------------------------------------
-- Ledger reader without cost.read (sales director + movement.read override)
-- ---------------------------------------------------------------------------
select tests.clear_authentication();
insert into authz.user_permission_overrides (user_id, permission_code, effect, scope, reason)
values ('00000000-0000-0000-0000-0000000000a2', 'inventory.movement.read', 'grant', 'all', 'test: receipts without costs');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a2');
select is((select count(*)::int || '/' || coalesce(max(items -> 0 ->> 'unit_cost'), 'masked') from api.v_goods_receipts
           where shipment_ref = 'SHP-UI-1'), '1/masked', 'receipt visible to a ledger reader, unit cost masked');
select is((select count(*)::int from api.v_inventory_stock), 0, 'no inventory.module.access: no lot-level stock rows');
select is((select count(*)::int from api.v_reorder_alerts), 0, 'no inventory.module.access: no reorder alerts');

-- ---------------------------------------------------------------------------
-- Sales rep (a4): sellable availability only
-- ---------------------------------------------------------------------------
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is((select count(*)::int from api.v_inventory_warehouses), 3, 'rep (stock.read) sees the warehouse list');
select is((select count(*)::int from api.v_inventory_stock) + (select count(*)::int from api.v_reorder_alerts), 0,
          'rep sees no stock detail and no reorder alerts');
select is((select count(*)::int from api.v_goods_receipts) + (select count(*)::int from api.v_transfer_lines), 0,
          'rep sees no receipts and no transfers');
select throws_like($$select api.post_goods_receipt((select id from inventory.goods_receipts limit 1))$$,
                   'PERMISSION_DENIED%', 'rep cannot post receipts (42501)');

-- ---------------------------------------------------------------------------
-- Finance officer (a6): catalogue yes, stock no
-- ---------------------------------------------------------------------------
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select is((select count(*)::int from api.v_inventory_warehouses), 0, 'without inventory.stock.read no warehouses');
select ok((select count(*)::int from api.v_inventory_variants) >= 3, 'catalogue readers see variants (no prices or costs in the view)');

-- ---------------------------------------------------------------------------
-- Warehouse-scoped keeper (b1, WH-QUA only)
-- ---------------------------------------------------------------------------
select tests.authenticate_as('00000000-0000-0000-0000-0000000000b1');
select is((select string_agg(distinct warehouse_code, ',') from api.v_inventory_stock), 'WH-QUA',
          'stock rows follow the warehouse scope');
select is((select count(*)::int from api.v_goods_receipts), 0, 'receipts of other warehouses are not visible');
select throws_like($$select api.create_goods_receipt('60000000-0000-0000-0000-000000000001', 'Synthetic Supplier', 'SHP-UI-2',
  '[{"variant_id":"53000000-0000-0000-0000-000000000022","lot_no":"NO-LOT","quantity":1,"unit_cost":40}]')$$,
                   'PERMISSION_DENIED%', 'keeper cannot receive into a warehouse outside the scope');
select ok((api.create_goods_receipt('60000000-0000-0000-0000-000000000021', 'Synthetic Supplier', 'SHP-UI-3',
  '[{"variant_id":"53000000-0000-0000-0000-000000000022","lot_no":"NO-LOT","quantity":1,"unit_cost":40}]') ->> 'status') = 'draft',
          'keeper receives into the scoped warehouse');
select is((select shipment_ref || ':' || coalesce(items -> 0 ->> 'unit_cost', 'masked') from api.v_goods_receipts), 'SHP-UI-3:masked',
          'keeper sees own-warehouse receipt; no cost.read so cost masked');
select tests.clear_authentication();

select * from finish();
rollback;
