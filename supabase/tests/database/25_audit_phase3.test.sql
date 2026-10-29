-- Regressions for the Phase 3 audit (20261030000700_audit_phase3_fixes.sql), one block per
-- finding. Each block fails on the migrations before that file.
--   users: a1 owner · a2 sales director (all customers) · a3 area mgr Cairo · a4 rep Cairo
--          (customer 4…01) · a5 rep Delta (4…02) · a6 finance (+ a test stock clerk role)
--          · a8 inventory manager (catalog.price.read, no catalog.price.manage, no CRM)
begin;
select tests.load_fixture();
select plan(65);
set constraints all immediate;

-- ===========================================================================
-- F1 customer-specific price lists are visible only to price managers or to
--    callers who can see a customer the list is assigned to
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');
select api.upsert_price_list('e2500000-0000-0000-0000-000000000001', 'MONA-VIP', 'Synthetic Delta private', 'customer', 10, '2026-01-01');
select api.set_price_list_item('e2500000-0000-0000-0000-000000000001', '53000000-0000-0000-0000-000000000001', 650);
select api.assign_customer_price_list('40000000-0000-0000-0000-000000000002', 'e2500000-0000-0000-0000-000000000001', '2026-01-01');
select api.upsert_price_list('e2500000-0000-0000-0000-000000000002', 'SPARE-VIP', 'Synthetic unassigned private', 'customer', 10, '2026-01-01');
select api.set_price_list_item('e2500000-0000-0000-0000-000000000002', '53000000-0000-0000-0000-000000000001', 700);
select is((select count(*)::int from api.v_price_lists where kind = 'customer'), 2, 'F1 the owner (price manager) sees every customer list');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is((select count(*)::int from api.v_price_lists where kind = 'customer'), 0,
  'F1 a rep sees no customer list of a customer outside their scope');
select is((select count(*)::int from catalog.price_list_items
           where price_list_id in ('e2500000-0000-0000-0000-000000000001', 'e2500000-0000-0000-0000-000000000002')), 0,
  'F1 nor its prices (table policy)');
select is((select count(*)::int from api.v_price_list_items where price_list_code = 'MONA-VIP'), 0, 'F1 nor through the view');
select is((select string_agg(code, ',') from api.v_price_lists where kind <> 'customer'), 'DEFAULT',
  'F1 standard lists stay visible with catalog.price.read');
select is((select unit_price::numeric from api.v_price_list_items where price_list_code = 'DEFAULT'), 1000.00::numeric,
  'F1 standard list prices stay visible');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a5');
select is((select string_agg(code, ',') from api.v_price_lists where kind = 'customer'), 'MONA-VIP',
  'F1 the rep of the assigned customer sees that list, not an unassigned one');
select is((select unit_price::numeric from api.v_price_list_items where price_list_code = 'MONA-VIP'), 650.00::numeric,
  'F1 and its price');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a2');
select is((select string_agg(code, ',') from api.v_price_lists where kind = 'customer'), 'MONA-VIP',
  'F1 a director who sees every customer sees assigned lists only');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a8');
select is((select count(*)::int from api.v_price_lists where kind = 'customer'), 0,
  'F1 catalog.price.read without catalog.price.manage or the customer: no customer lists');

-- Server pricing (definer) is unaffected.
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a5');
select is((api.save_order_draft('e2510000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000002',
  '[{"variant_id":"53000000-0000-0000-0000-000000000001","quantity":1}]'::jsonb) -> 'lines' -> 0 ->> 'list_price')::numeric,
  650::numeric, 'F1 an order for that customer is still priced from its customer list');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is((api.save_order_draft('e2510000-0000-0000-0000-000000000002', '40000000-0000-0000-0000-000000000001',
  '[{"variant_id":"53000000-0000-0000-0000-000000000001","quantity":1}]'::jsonb) -> 'lines' -> 0 ->> 'list_price')::numeric,
  1000::numeric, 'F1 other customers keep the DEFAULT price');
select is(api.submit_order('e2510000-0000-0000-0000-000000000002') ->> 'total', '1140.00',
  'F1 submit prices on the server as before (1000 + 14% VAT)');

-- ===========================================================================
-- F2 a discontinued variant or product cannot be submitted or reserved
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select api.save_order_draft('e2520000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001',
  '[{"variant_id":"53000000-0000-0000-0000-000000000001","quantity":2}]'::jsonb);
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a8');
select api.set_variant_status('53000000-0000-0000-0000-000000000001', 'discontinued');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select throws_like($$select api.submit_order('e2520000-0000-0000-0000-000000000001')$$, 'NOT_SELLABLE: BIO-TOP-4110%',
  'F2 a draft whose variant was discontinued cannot be submitted');
select throws_ok($$select api.submit_order('e2520000-0000-0000-0000-000000000001')$$, 'P0001', null,
  'F2 it is a business-rule error (P0001)');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a8');
select api.set_variant_status('53000000-0000-0000-0000-000000000001', 'active');
select api.set_product_status('52000000-0000-0000-0000-000000000001', 'discontinued');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select throws_like($$select api.submit_order('e2520000-0000-0000-0000-000000000001')$$, 'NOT_SELLABLE%',
  'F2 nor one whose product was discontinued');
select is((select status from sales.orders where id = 'e2520000-0000-0000-0000-000000000001'), 'draft',
  'F2 the order stays a draft');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a8');
select api.set_product_status('52000000-0000-0000-0000-000000000001', 'active');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is(api.submit_order('e2520000-0000-0000-0000-000000000001') ->> 'status', 'submitted',
  'F2 once sellable again it submits');

-- Reserve: approved, then discontinued (e.g. a recall) → no new reservation.
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a3');
select api.approve_order('e2520000-0000-0000-0000-000000000001');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a8');
select api.post_goods_receipt((api.create_goods_receipt('60000000-0000-0000-0000-000000000001', 'Synthetic Supplier', 'SHP-F2',
  '[{"variant_id":"53000000-0000-0000-0000-000000000001","lot_no":"L2026A","expiry_date":"2030-12-31","quantity":10}]'::jsonb)
  ->> 'receipt_id')::uuid);
select api.set_variant_status('53000000-0000-0000-0000-000000000001', 'discontinued');
select throws_like($$select api.reserve_order('e2520000-0000-0000-0000-000000000001', '60000000-0000-0000-0000-000000000001')$$,
  'NOT_SELLABLE: BIO-TOP-4110%', 'F2 an approved order of a discontinued variant cannot be reserved');
select is((select count(*)::int from inventory.reservations r join sales.order_items oi on oi.id = r.order_item_id
           where oi.order_id = 'e2520000-0000-0000-0000-000000000001'), 0, 'F2 nothing was reserved');
select api.set_variant_status('53000000-0000-0000-0000-000000000001', 'active');
select is(api.reserve_order('e2520000-0000-0000-0000-000000000001', '60000000-0000-0000-0000-000000000001') ->> 'status',
  'reserved', 'F2 a sellable order reserves as before');

-- ===========================================================================
-- F3 stock leaves quarantine only with inventory.quarantine.release (D-13)
-- ===========================================================================
select tests.clear_authentication();
select is((select is_sensitive from authz.permissions where code = 'inventory.quarantine.release'), true,
  'F3 inventory.quarantine.release is in the catalogue (sensitive)');
select is((select string_agg(r.code, ',' order by r.code) from authz.role_permissions rp join authz.roles r on r.id = rp.role_id
           where rp.permission_code = 'inventory.quarantine.release'), 'inventory_manager',
  'F3 granted to the inventory manager role only (the owner holds everything)');
insert into inventory.warehouses (id, code, name, kind) values
  ('e2530000-0000-0000-0000-000000000001', 'WH-QUAR', 'Synthetic quarantine', 'quarantine'),
  ('e2530000-0000-0000-0000-000000000002', 'WH-QUAR2', 'Synthetic quarantine 2', 'quarantine'),
  ('e2530000-0000-0000-0000-000000000003', 'WH-TRANSIT', 'Synthetic transit', 'transit');
-- A stock clerk: may create and receive transfers, but not release quarantine.
insert into authz.roles (id, code, name_en) values ('e2530000-0000-0000-0000-0000000000c1', 'test_stock_clerk', 'Synthetic stock clerk');
insert into authz.role_permissions (role_id, permission_code, scope) values
  ('e2530000-0000-0000-0000-0000000000c1', 'inventory.transfer.create', 'all'),
  ('e2530000-0000-0000-0000-0000000000c1', 'inventory.transfer.receive', 'all'),
  ('e2530000-0000-0000-0000-0000000000c1', 'inventory.stock.read', 'all');
insert into authz.user_roles (user_id, role_id) values ('00000000-0000-0000-0000-0000000000a6', 'e2530000-0000-0000-0000-0000000000c1');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a8');
select api.post_goods_receipt((api.create_goods_receipt('e2530000-0000-0000-0000-000000000001', 'Returned by clinic', 'SHP-F3',
  '[{"variant_id":"53000000-0000-0000-0000-000000000001","lot_no":"L2026A","expiry_date":"2030-12-31","quantity":5}]'::jsonb)
  ->> 'receipt_id')::uuid);

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select throws_ok($$select api.create_transfer('e2530000-0000-0000-0000-000000000001', '60000000-0000-0000-0000-000000000001',
  '[{"variant_id":"53000000-0000-0000-0000-000000000001","lot_id":"61000000-0000-0000-0000-000000000001","quantity":5}]'::jsonb)$$,
  '42501', 'PERMISSION_DENIED: moving stock out of quarantine needs inventory.quarantine.release',
  'F3 inventory.transfer.create alone cannot move quarantine stock into a sellable warehouse');
select throws_ok($$select api.create_transfer('e2530000-0000-0000-0000-000000000001', 'e2530000-0000-0000-0000-000000000003',
  '[{"variant_id":"53000000-0000-0000-0000-000000000001","lot_id":"61000000-0000-0000-0000-000000000001","quantity":5}]'::jsonb)$$,
  '42501', null, 'F3 nor via a transit warehouse');
select lives_ok($$select api.create_transfer('e2530000-0000-0000-0000-000000000001', 'e2530000-0000-0000-0000-000000000002',
  '[{"variant_id":"53000000-0000-0000-0000-000000000001","lot_id":"61000000-0000-0000-0000-000000000001","quantity":1}]'::jsonb)$$,
  'F3 quarantine to quarantine needs no release');
select lives_ok($$select api.create_transfer('60000000-0000-0000-0000-000000000001', 'e2530000-0000-0000-0000-000000000001',
  '[{"variant_id":"53000000-0000-0000-0000-000000000001","lot_id":"61000000-0000-0000-0000-000000000001","quantity":1}]'::jsonb)$$,
  'F3 moving stock into quarantine needs no release');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a8');
select set_config('t25.release', api.create_transfer('e2530000-0000-0000-0000-000000000001', '60000000-0000-0000-0000-000000000001',
  '[{"variant_id":"53000000-0000-0000-0000-000000000001","lot_id":"61000000-0000-0000-0000-000000000001","quantity":5}]'::jsonb)
  ->> 'transfer_id', true) is not null as created;
select is(api.ship_transfer(current_setting('t25.release')::uuid) ->> 'status', 'in_transit',
  'F3 the inventory manager releases quarantine stock (created and shipped)');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select throws_ok($$select api.receive_transfer(current_setting('t25.release')::uuid)$$, '42501', null,
  'F3 receiving released stock into a sellable warehouse also needs the permission');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a8');
select is(api.receive_transfer(current_setting('t25.release')::uuid) ->> 'status', 'received',
  'F3 the inventory manager receives it');
select is((select sum(quantity)::int from inventory.movements where source_doc_id = current_setting('t25.release')::uuid
           and movement_type = 'transfer_in' and warehouse_id = '60000000-0000-0000-0000-000000000001'), 5,
  'F3 the released stock is now in the main warehouse');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');
select lives_ok($$select api.create_transfer('e2530000-0000-0000-0000-000000000002', '60000000-0000-0000-0000-000000000001',
  '[{"variant_id":"53000000-0000-0000-0000-000000000001","lot_id":"61000000-0000-0000-0000-000000000001","quantity":1}]'::jsonb)$$,
  'F3 the owner can release');

-- ===========================================================================
-- F4 a cancelled assignment does not block assigning the list again
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');
select api.upsert_price_list('e2540000-0000-0000-0000-000000000001', 'AHMED-VIP', 'Synthetic Cairo private', 'customer', 10, '2026-01-01');
select api.assign_customer_price_list('40000000-0000-0000-0000-000000000001', 'e2540000-0000-0000-0000-000000000001',
  core.business_date() + 10);
select is((api.end_customer_price_list('40000000-0000-0000-0000-000000000001', 'e2540000-0000-0000-0000-000000000001',
  core.business_date() + 10) ->> 'cancelled')::boolean, true, 'F4 a scheduled assignment is cancelled before it starts');
select lives_ok($$select api.assign_customer_price_list('40000000-0000-0000-0000-000000000001',
  'e2540000-0000-0000-0000-000000000001', core.business_date())$$, 'F4 the list can be assigned again afterwards');
select is((select string_agg(state, ',' order by valid_from) from api.v_customer_price_lists
           where price_list_id = 'e2540000-0000-0000-0000-000000000001'), 'current,cancelled',
  'F4 the new assignment is current; the cancelled one stays as history');
select throws_like($$select api.assign_customer_price_list('40000000-0000-0000-0000-000000000001',
  'e2540000-0000-0000-0000-000000000001', core.business_date() + 20)$$, 'OVERLAP%',
  'F4 a real overlap is still refused');

-- ===========================================================================
-- F5 the DEFAULT list cannot start in the future
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');
select throws_like($$select api.upsert_price_list('54000000-0000-0000-0000-000000000001', 'DEFAULT', 'Default 2027', 'standard', 100,
  core.business_date() + 60)$$, 'DEFAULT_LIST_PROTECTED%', 'F5 DEFAULT cannot be moved to a future start date');
select is((select valid_from from catalog.price_lists where code = 'DEFAULT'), '2026-01-01'::date, 'F5 DEFAULT is unchanged');
select lives_ok($$select api.upsert_price_list('54000000-0000-0000-0000-000000000001', 'DEFAULT', 'Default 2026', 'standard', 100,
  core.business_date())$$, 'F5 a start date of today is fine');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is((api.save_order_draft('e2550000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001',
  '[{"variant_id":"53000000-0000-0000-0000-000000000001","quantity":1}]'::jsonb) -> 'lines' -> 0 ->> 'list_price')::numeric,
  1000::numeric, 'F5 orders still find the DEFAULT price');

-- ===========================================================================
-- F6 assign cannot back-date an end date
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');
select api.upsert_price_list('e2560000-0000-0000-0000-000000000001', 'AHMED-OLD', 'Synthetic Cairo older', 'customer', 10, '2026-01-01');
select api.assign_customer_price_list('40000000-0000-0000-0000-000000000001', 'e2560000-0000-0000-0000-000000000001',
  core.business_date() - 30);
select throws_like($$select api.assign_customer_price_list('40000000-0000-0000-0000-000000000001',
  'e2560000-0000-0000-0000-000000000001', core.business_date() - 30, core.business_date() - 10)$$,
  'VALIDATION: the end date cannot be in the past%', 'F6 a replay cannot back-date the end date');
select is((select valid_to from catalog.customer_price_lists where price_list_id = 'e2560000-0000-0000-0000-000000000001'),
  null::date, 'F6 the assignment is unchanged');
select is((api.assign_customer_price_list('40000000-0000-0000-0000-000000000001', 'e2560000-0000-0000-0000-000000000001',
  core.business_date() - 30, core.business_date() + 5) ->> 'replayed')::boolean, true, 'F6 a future end date is still accepted');
select tests.clear_authentication();
insert into catalog.customer_price_lists (customer_id, price_list_id, valid_from, valid_to)
values ('40000000-0000-0000-0000-000000000001', 'e2560000-0000-0000-0000-000000000001',
        core.business_date() - 90, core.business_date() - 60);
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');
select lives_ok($$select api.assign_customer_price_list('40000000-0000-0000-0000-000000000001',
  'e2560000-0000-0000-0000-000000000001', core.business_date() - 90, core.business_date() - 60)$$,
  'F6 an exact replay of an assignment that already ended is still idempotent');
select throws_like($$select api.assign_customer_price_list('40000000-0000-0000-0000-000000000001',
  'e2560000-0000-0000-0000-000000000001', core.business_date() - 90, core.business_date() - 70)$$,
  'VALIDATION: the end date cannot be in the past%', 'F6 but it cannot move that end date further back');

-- ===========================================================================
-- F7 the duplicate pre-check is not a customer-existence oracle
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select set_config('t25.dup', api.find_duplicate_customers(p_phone_primary => '01112345678')::text, true) is not null as checked;
select ok(current_setting('t25.dup')::jsonb -> 'phone_duplicate_customer_no' = 'null'::jsonb,
  'F7 a phone match outside the caller''s scope reveals no customer number');
select is(current_setting('t25.dup')::jsonb ->> 'exists_outside_scope', 'true', 'F7 only that a match exists elsewhere');
select is(current_setting('t25.dup')::jsonb ->> 'phone_duplicate_outside_scope', 'true', 'F7 flagged as a phone match');
select set_config('t25.dup', api.find_duplicate_customers(p_governorate_code => 'EG-DK', p_display_name => 'Dr. Mona Clinic')::text, true)
  is not null as checked;
select is(current_setting('t25.dup')::jsonb - 'phone_duplicate_customer_no' - 'phone_duplicate_outside_scope',
  '{"similar_count": 0, "similar_customer_nos": [], "similar_outside_scope": true, "exists_outside_scope": true}'::jsonb,
  'F7 a similar name outside the scope: no number, no count, only the flag');
select ok(position('C-0002' in current_setting('t25.dup')) = 0 and position('Mona' in current_setting('t25.dup')) = 0,
  'F7 neither the customer number nor the name appears anywhere in the result');
select is(api.find_duplicate_customers(p_governorate_code => 'EG-DK', p_display_name => 'Dr. Zed Clinic') ->> 'exists_outside_scope',
  'false', 'F7 no match: no flag');
select is(api.find_duplicate_customers(p_phone_primary => '+201001234567') - 'similar_count' - 'similar_customer_nos'
            - 'similar_outside_scope',
  '{"phone_duplicate_customer_no": "C-0001", "phone_duplicate_outside_scope": false, "exists_outside_scope": false}'::jsonb,
  'F7 an in-scope match keeps its customer number');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a2');
select is(api.find_duplicate_customers(p_governorate_code => 'EG-DK', p_display_name => 'Dr. Mona Clinic') #>> '{similar_customer_nos,0}',
  'C-0002', 'F7 a caller who can see the customer gets its number');

-- ===========================================================================
-- F10 business dates are the Cairo day. The session time zone is moved so that its
--     calendar day differs from Cairo's (current_date is the session's day).
-- ===========================================================================
select tests.clear_authentication();
insert into inventory.warehouses (id, code, name) values ('e25a0000-0000-0000-0000-000000000001', 'WH-F10', 'Synthetic F10');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a8');
select api.post_goods_receipt((api.create_goods_receipt('e25a0000-0000-0000-0000-000000000001', 'Synthetic Supplier', 'SHP-F10',
  jsonb_build_array(jsonb_build_object('variant_id', '53000000-0000-0000-0000-000000000001', 'lot_no', 'LF10',
                                       'expiry_date', core.business_date(), 'quantity', 4))) ->> 'receipt_id')::uuid);

select set_config('timezone', case when extract(hour from now() at time zone 'Africa/Cairo') >= 13
                                   then 'Etc/GMT-14' else 'Etc/GMT+12' end, true) is not null as tz_moved;
select isnt(current_date, core.business_date(), 'F10 precondition: the session day is not the Cairo day');
select is(core.business_date(), (now() at time zone 'Africa/Cairo')::date, 'F10 core.business_date() is the Cairo day');

select is((select days_to_earliest_expiry || '/' || sellable_available || '/' || expired_qty from api.v_inventory_stock
           where warehouse_id = 'e25a0000-0000-0000-0000-000000000001'), '0/4/0',
  'F10 v_inventory_stock: a lot expiring today (Cairo) is sellable, 0 days left');
select is((select days_to_expiry from api.v_stock_detail where warehouse_id = 'e25a0000-0000-0000-0000-000000000001'), 0,
  'F10 v_stock_detail: 0 days to expiry');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');
select api.upsert_price_list('e25a0000-0000-0000-0000-000000000002', 'ONE-DAY', 'Synthetic one day', 'customer', 10,
  core.business_date(), core.business_date());
select is((select is_current from api.v_price_lists where code = 'ONE-DAY'), true, 'F10 v_price_lists: a list valid only today is current');
select api.assign_customer_price_list('40000000-0000-0000-0000-000000000001', 'e25a0000-0000-0000-0000-000000000002',
  core.business_date(), core.business_date());
select is((select state from api.v_customer_price_lists where price_list_id = 'e25a0000-0000-0000-0000-000000000002'), 'current',
  'F10 v_customer_price_lists: an assignment for today only is current');
select api.create_promotion('e25a0000-0000-0000-0000-000000000003', 'Synthetic one-day offer', 10, core.business_date(),
  core.business_date(), p_customer_id => '40000000-0000-0000-0000-000000000001');
select is((select state from api.v_promotions where id = 'e25a0000-0000-0000-0000-000000000003'), 'active',
  'F10 v_promotions: a promotion for today only is active (and create_promotion accepted it)');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is((api.save_order_draft('e25a0000-0000-0000-0000-000000000004', '40000000-0000-0000-0000-000000000001',
  '[{"variant_id":"53000000-0000-0000-0000-000000000001","quantity":1}]'::jsonb) -> 'lines' -> 0 ->> 'applied_discount_pct')::numeric,
  10::numeric, 'F10 pricing applies today''s promotion');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');
select is((api.upsert_price_list('e25a0000-0000-0000-0000-000000000005', 'STD-F10', 'Synthetic standard', 'standard') ->> 'kind'),
  'standard', 'F10 a list created without a start date …');
select is((select valid_from from catalog.price_lists where code = 'STD-F10'), core.business_date(), 'F10 … starts on the Cairo day');
select api.upsert_price_list('e25a0000-0000-0000-0000-000000000006', 'F10-END', 'Synthetic to end', 'customer', 10, '2026-01-01');
select api.assign_customer_price_list('40000000-0000-0000-0000-000000000001', 'e25a0000-0000-0000-0000-000000000006', '2026-01-01');
select throws_like($$select api.end_customer_price_list('40000000-0000-0000-0000-000000000001',
  'e25a0000-0000-0000-0000-000000000006', '2026-01-01', core.business_date() - 1)$$,
  'VALIDATION: the end date cannot be in the past%', 'F10 end_customer_price_list: yesterday (Cairo) is in the past');
select lives_ok($$select api.end_customer_price_list('40000000-0000-0000-0000-000000000001',
  'e25a0000-0000-0000-0000-000000000006', '2026-01-01', core.business_date())$$,
  'F10 end_customer_price_list: today (Cairo) is not');

select * from finish();
rollback;
