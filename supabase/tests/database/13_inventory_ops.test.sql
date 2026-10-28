-- Inventory operations: goods receipts, transfers, adjustments with approval, read views and cost masking.
begin;
select tests.load_fixture();
select plan(50);

insert into inventory.warehouses (id, code, name, kind) values
  ('60000000-0000-0000-0000-000000000002', 'WH-ALX', 'Alexandria branch', 'branch');

-- ---------------------------------------------------------------------------
-- Goods receipts
-- ---------------------------------------------------------------------------
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select throws_like($$select api.create_goods_receipt('60000000-0000-0000-0000-000000000001', 'Bioner SA', 'X',
  '[{"variant_id":"53000000-0000-0000-0000-000000000001","lot_no":"L1","quantity":1,"unit_cost":1}]')$$,
  'PERMISSION_DENIED%', 'rep cannot create goods receipts');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a8');
select ok((api.create_goods_receipt('60000000-0000-0000-0000-000000000001', 'Bioner SA', 'SHP-1',
  '[{"variant_id":"53000000-0000-0000-0000-000000000001","lot_no":"L2027X","expiry_date":"2027-05-31","quantity":20,"unit_cost":550},
    {"variant_id":"53000000-0000-0000-0000-000000000001","lot_no":"L2026A","quantity":5}]') ->> 'receipt_no') ~ '^GRN-[0-9]{4}-000001$',
  'receipt created with a GRN number');
select is((select status from inventory.goods_receipts where shipment_ref = 'SHP-1') || '/' || (select count(*) from inventory.movements),
  'draft/0', 'a draft receipt moves no stock');
select is(jsonb_array_length(api.post_goods_receipt((select id from inventory.goods_receipts where shipment_ref = 'SHP-1')) -> 'movements'), 2,
  'posting creates one movement per item');
select throws_like($$select api.post_goods_receipt((select id from inventory.goods_receipts where shipment_ref = 'SHP-1'))$$,
  'INVALID_STATE%', 'a posted receipt cannot be posted again');
select throws_like($$select api.create_goods_receipt('60000000-0000-0000-0000-000000000001', 'Bioner SA', 'SHP-X',
  '[{"variant_id":"53000000-0000-0000-0000-000000000001","lot_no":"L9","quantity":1,"selling_price":1}]')$$,
  'VALIDATION%', 'unknown item fields are rejected');
select api.create_goods_receipt('60000000-0000-0000-0000-000000000001', 'Bioner SA', 'SHP-2',
  '[{"variant_id":"53000000-0000-0000-0000-000000000001","lot_no":"L2027X","expiry_date":"2028-01-01","quantity":1,"unit_cost":550}]');
select throws_like($$select api.post_goods_receipt((select id from inventory.goods_receipts where shipment_ref = 'SHP-2'))$$,
  'LOT_EXPIRY_MISMATCH%', 'a known lot cannot arrive with a different expiry');
select api.create_goods_receipt('60000000-0000-0000-0000-000000000001', 'Bioner SA', 'SHP-3',
  '[{"variant_id":"53000000-0000-0000-0000-000000000001","lot_no":"LEXP","expiry_date":"2021-01-01","quantity":1,"unit_cost":550}]');
select throws_like($$select api.post_goods_receipt((select id from inventory.goods_receipts where shipment_ref = 'SHP-3'))$$,
  'EXPIRED_LOT%', 'expired goods are not received into a sellable warehouse');
select tests.clear_authentication();

select is((select expiry_date from inventory.lots where lot_no = 'L2027X'), '2027-05-31'::date, 'new lot created with its expiry');
select is((select count(*)::int from inventory.lots where variant_id = '53000000-0000-0000-0000-000000000001'), 2,
  'existing lot reused, no duplicate lot rows');
select is((select string_agg(l.lot_no || ':' || b.on_hand, ',' order by l.lot_no) from inventory.stock_balances b
           join inventory.lots l on l.id = b.lot_id), 'L2026A:5,L2027X:20', 'receipt movements update balances');
select is((select string_agg(m.unit_cost::text, ',' order by l.lot_no) from inventory.movements m join inventory.lots l on l.id = m.lot_id
           where m.movement_type = 'receipt'), '600.00,550.00', 'unit cost stored (supplied, or defaulted from the catalogue)');
select is((select posted_by from inventory.goods_receipts where shipment_ref = 'SHP-1'), '00000000-0000-0000-0000-0000000000a8'::uuid,
  'receipt records who posted it');

-- ---------------------------------------------------------------------------
-- Read views: lot detail and cost masking
-- ---------------------------------------------------------------------------
insert into authz.user_permission_overrides (user_id, permission_code, effect, scope, reason)
values ('00000000-0000-0000-0000-0000000000a2', 'inventory.movement.read', 'grant', 'all', 'test: ledger without costs');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a8');
select is((select count(*)::int from api.v_movements where unit_cost is not null), 2, 'inventory manager (cost.read) sees unit costs');
select is((select count(*)::int from api.v_stock_detail), 2, 'inventory manager sees lot-level detail');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a2');
select is((select count(*)::int || '/' || count(unit_cost) from api.v_movements), '2/0', 'ledger reader without cost.read sees movements, costs masked');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is((select count(*)::int from api.v_movements), 0, 'rep cannot read the movement ledger');
select is((select available from api.v_stock_available where warehouse_id = '60000000-0000-0000-0000-000000000001'), 25,
  'rep sees sellable availability per warehouse');
select is((select count(*)::int from api.v_stock_detail), 0, 'rep gets no lot-level detail');
select tests.clear_authentication();

-- ---------------------------------------------------------------------------
-- Transfers: WH-CAI → WH-ALX, 8 × L2027X
-- ---------------------------------------------------------------------------
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select throws_like($$select api.create_transfer('60000000-0000-0000-0000-000000000001', '60000000-0000-0000-0000-000000000002',
  '[{"variant_id":"53000000-0000-0000-0000-000000000001","lot_id":"61000000-0000-0000-0000-000000000001","quantity":1}]')$$,
  'PERMISSION_DENIED%', 'rep cannot create transfers');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a8');
select ok((api.create_transfer('60000000-0000-0000-0000-000000000001', '60000000-0000-0000-0000-000000000002',
  jsonb_build_array(jsonb_build_object('variant_id', '53000000-0000-0000-0000-000000000001',
                                       'lot_id', (select id from inventory.lots where lot_no = 'L2027X'), 'quantity', 8)))
  ->> 'transfer_no') ~ '^TRF-[0-9]{4}-000001$', 'transfer created with a TRF number');
select is(api.ship_transfer((select id from inventory.transfers where transfer_no like 'TRF-%-000001')) ->> 'status', 'in_transit', 'transfer shipped');
select tests.clear_authentication();
select is((select on_hand from inventory.stock_balances b join inventory.lots l on l.id = b.lot_id
           where l.lot_no = 'L2027X' and b.warehouse_id = '60000000-0000-0000-0000-000000000001'), 12, 'source on-hand reduced on shipment');
select is((select sum(on_hand)::int from inventory.stock_balances), 17, 'goods in transit are in neither warehouse');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a8');
select is(api.receive_transfer((select id from inventory.transfers where transfer_no like 'TRF-%-000001')) ->> 'status', 'received', 'transfer received');
select throws_like($$select api.receive_transfer((select id from inventory.transfers where transfer_no like 'TRF-%-000001'))$$,
  'INVALID_STATE%', 'a transfer is received once');
select api.create_transfer('60000000-0000-0000-0000-000000000001', '60000000-0000-0000-0000-000000000002',
  jsonb_build_array(jsonb_build_object('variant_id', '53000000-0000-0000-0000-000000000001',
                                       'lot_id', (select id from inventory.lots where lot_no = 'L2027X'), 'quantity', 100)));
select throws_like($$select api.ship_transfer((select id from inventory.transfers where transfer_no like 'TRF-%-000002'))$$,
  'INSUFFICIENT_STOCK%', 'cannot ship more than is available');
select is((select count(*)::int from api.v_transfers), 2, 'inventory manager sees transfers');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is((select count(*)::int from api.v_transfers), 0, 'rep sees no transfers');
select tests.clear_authentication();
select is((select sum(quantity)::int from inventory.movements where source_doc_type = 'transfer'), 0, 'company-wide net of a transfer is zero');
select is((select on_hand from inventory.stock_balances where warehouse_id = '60000000-0000-0000-0000-000000000002'), 8, 'destination on-hand increased');
select is((select received_qty from inventory.transfer_items ti join inventory.transfers t on t.id = ti.transfer_id
           where t.transfer_no like 'TRF-%-000001'), 8, 'received quantity recorded');

-- ---------------------------------------------------------------------------
-- Adjustments: inventory manager limit = 5 units
-- ---------------------------------------------------------------------------
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select throws_like($$select api.request_inventory_adjustment('60000000-0000-0000-0000-000000000001', '53000000-0000-0000-0000-000000000001',
  '61000000-0000-0000-0000-000000000001', 1, 'found', 'radj-0')$$, 'PERMISSION_DENIED%', 'rep cannot request adjustments');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a8');
select is(api.request_inventory_adjustment('60000000-0000-0000-0000-000000000001', '53000000-0000-0000-0000-000000000001',
  '61000000-0000-0000-0000-000000000001', -2, 'damaged in storage', 'radj-1') ->> 'status', 'posted', 'within the limit: posted directly');
select is(api.request_inventory_adjustment('60000000-0000-0000-0000-000000000001', '53000000-0000-0000-0000-000000000001',
  '61000000-0000-0000-0000-000000000001', -2, 'damaged in storage', 'radj-1') ->> 'movement_id',
  (select id::text from inventory.movements where idempotency_key = 'radj-1'), 'replay returns the same movement');
select is(api.request_inventory_adjustment('60000000-0000-0000-0000-000000000001', '53000000-0000-0000-0000-000000000001',
  '61000000-0000-0000-0000-000000000001', 20, 'count correction', 'radj-2') ->> 'status', 'pending_approval', 'above the limit: approval requested');
select is(api.request_inventory_adjustment('60000000-0000-0000-0000-000000000001', '53000000-0000-0000-0000-000000000001',
  '61000000-0000-0000-0000-000000000001', 20, 'count correction', 'radj-2') ->> 'replayed', 'true', 'replay returns the pending request');
select throws_like($$select api.request_inventory_adjustment('60000000-0000-0000-0000-000000000001', '53000000-0000-0000-0000-000000000001',
  '61000000-0000-0000-0000-000000000001', -100, 'lost', 'radj-9')$$, 'INSUFFICIENT_STOCK%', 'cannot adjust below available stock');
select throws_like($$select api.decide_approval((select r.id from wf.approval_requests r where r.payload ->> 'idempotency_key' = 'radj-2'), 'approve')$$,
  'SELF_APPROVAL%', 'requester cannot approve own adjustment');
select tests.clear_authentication();
select is((select count(*)::int from inventory.movements where idempotency_key = 'radj-2'), 0, 'nothing posted while pending');
select is((select (payload ->> 'limit_metric')::int from wf.approval_requests where payload ->> 'idempotency_key' = 'radj-2'), 20,
  'payload limit_metric = |quantity|');
select set_config('test.req_adj', (select id::text from wf.approval_requests where payload ->> 'idempotency_key' = 'radj-2'), true);

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a2');
select throws_like($$select api.decide_approval(current_setting('test.req_adj')::uuid, 'approve')$$,
  'PERMISSION_DENIED%', 'sales director lacks wf.decide.inventory_adjustment');
select tests.clear_authentication();
insert into authz.user_permission_overrides (user_id, permission_code, effect, scope, limit_value, reason)
values ('00000000-0000-0000-0000-0000000000a6', 'wf.decide.inventory_adjustment', 'grant', 'all', 10, 'test: limited approver');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select throws_like($$select api.decide_approval(current_setting('test.req_adj')::uuid, 'approve')$$,
  'LIMIT_EXCEEDED%', 'approver with a 10-unit limit cannot approve 20');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');
select is(api.decide_approval(current_setting('test.req_adj')::uuid, 'approve') ->> 'status', 'approved', 'owner approves');
select tests.clear_authentication();
select is((select approval_request_id::text || '/' || quantity || '/' || created_by from inventory.movements where idempotency_key = 'radj-2'),
  current_setting('test.req_adj') || '/20/00000000-0000-0000-0000-0000000000a8',
  'hook posted the movement linked to the request, attributed to the requester');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a8');
select is(api.request_inventory_adjustment('60000000-0000-0000-0000-000000000001', '53000000-0000-0000-0000-000000000001',
  '61000000-0000-0000-0000-000000000001', 20, 'count correction', 'radj-2') ->> 'status', 'posted', 'replay after approval reports it posted');
select is(api.request_inventory_adjustment('60000000-0000-0000-0000-000000000001', '53000000-0000-0000-0000-000000000001',
  '61000000-0000-0000-0000-000000000001', 15, 'recount', 'radj-3') ->> 'status', 'pending_approval', 'second large adjustment requested');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');
select is(api.decide_approval((select r.id from wf.approval_requests r where r.payload ->> 'idempotency_key' = 'radj-3'), 'reject', 'recount first') ->> 'status',
  'rejected', 'owner rejects');
select tests.clear_authentication();
select is((select count(*)::int from inventory.movements where idempotency_key = 'radj-3'), 0, 'rejection posts nothing');

select is((select count(*)::int from inventory.stock_balances b
           where b.on_hand <> (select coalesce(sum(m.quantity), 0) from inventory.movements m
                               where m.warehouse_id = b.warehouse_id and m.variant_id = b.variant_id and m.lot_id = b.lot_id)),
  0, 'invariant: every balance equals the sum of its movements');

select * from finish();
rollback;
