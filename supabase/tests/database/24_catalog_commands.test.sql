-- Catalogue administration commands (20261030000600_catalog_commands.sql): products,
-- variants (SKU uniqueness), discontinue-not-delete, price lists and items, customer
-- price lists, promotions, read views, outbox events and privileges. Also pins down how
-- price changes interact with orders: submitted orders keep their snapshot; drafts are
-- re-priced at submit.
--   users: a1 owner · a4 rep Cairo (customer 4…01) · a5 rep Delta (4…02) · a7 IT admin
--          (catalog.product.read only) · a8 inventory manager (catalog.product.manage, price.read)
begin;
select tests.load_fixture();
select plan(95);
set constraints all immediate;

-- ===========================================================================
-- Products
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a8');
select is(api.upsert_product('e2400000-0000-0000-0000-000000000001',
  (select id from catalog.brands where code = 'BIONER'), (select id from catalog.categories where code = 'IMPLANT'),
  ' test-impl-001 ', 'Synthetic Test Implant', 'زرعة اختبار', 'Synthetic example only') ->> 'created',
  'true', 'inventory manager (catalog.product.manage) creates a product');
select is((select code from catalog.products where id = 'e2400000-0000-0000-0000-000000000001'), 'TEST-IMPL-001',
  'product code is trimmed and upper-cased');
select is((select tax_rate_pct from catalog.products where id = 'e2400000-0000-0000-0000-000000000001'), 14.00::numeric(5,2),
  'VAT comes from sales.default_vat_pct, not from the client');
select tests.clear_authentication();
select is((select count(*)::int from integration.outbox
           where event_type = 'product.created' and aggregate_id = 'e2400000-0000-0000-0000-000000000001'), 1,
  'product.created is written to the outbox in the same transaction');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a8');
select is(api.upsert_product('e2400000-0000-0000-0000-000000000001',
  (select id from catalog.brands where code = 'BIONER'), (select id from catalog.categories where code = 'IMPLANT'),
  'TEST-IMPL-001', 'Synthetic Test Implant v2') ->> 'created', 'false', 'the same id updates the product');
select is((select name_en from catalog.products where id = 'e2400000-0000-0000-0000-000000000001'), 'Synthetic Test Implant v2',
  'update stored');
select tests.clear_authentication();
select is((select count(*)::int from integration.outbox
           where event_type = 'product.updated' and aggregate_id = 'e2400000-0000-0000-0000-000000000001'), 1,
  'product.updated emitted');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a8');
select is(api.upsert_product('e2400000-0000-0000-0000-000000000001',
  (select id from catalog.brands where code = 'BIONER'), (select id from catalog.categories where code = 'IMPLANT'),
  'TEST-IMPL-001', 'Synthetic Test Implant v2') ->> 'created', 'false', 'an unchanged replay succeeds');
select tests.clear_authentication();
select is((select count(*)::int from integration.outbox
           where event_type = 'product.updated' and aggregate_id = 'e2400000-0000-0000-0000-000000000001'), 1,
  'an unchanged replay emits nothing');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a8');
select throws_like($$select api.upsert_product(gen_random_uuid(), (select id from catalog.brands where code = 'DERBY'),
  (select id from catalog.categories where code = 'INSTRUMENT'), 'bio-top', 'Synthetic duplicate')$$,
  'DUPLICATE_CODE%', 'product codes are unique (case-insensitive)');
select throws_ok($$select api.upsert_product(gen_random_uuid(), (select id from catalog.brands where code = 'DERBY'),
  (select id from catalog.categories where code = 'INSTRUMENT'), 'x', 'Synthetic bad code')$$,
  'P0001', null, 'a malformed code is a validation error (P0001)');
select throws_like($$select api.upsert_product(gen_random_uuid(), (select id from catalog.brands where code = 'DERBY'),
  (select id from catalog.categories where code = 'INSTRUMENT'), 'TEST-NONAME', ' ')$$,
  'VALIDATION%', 'an English name is required');
select throws_like($$select api.upsert_product(gen_random_uuid(), gen_random_uuid(),
  (select id from catalog.categories where code = 'INSTRUMENT'), 'TEST-NOBRAND', 'Synthetic no brand')$$,
  'VALIDATION: unknown or inactive brand%', 'the brand must exist');
select throws_like($$select api.upsert_product('e2400000-0000-0000-0000-000000000001',
  (select id from catalog.brands where code = 'BIONER'), (select id from catalog.categories where code = 'IMPLANT'),
  'TEST-IMPL-001', 'Synthetic Test Implant v2', p_status => 'discontinued')$$,
  'VALIDATION%', 'upsert cannot change the status (that is set_product_status)');
select throws_like($$select api.upsert_product('52000000-0000-0000-0000-000000000001',
  (select id from catalog.brands where code = 'BIONER'), (select id from catalog.categories where code = 'IMPLANT'),
  'BIO-TOP', 'Bioner Top DM', p_is_lot_tracked => false)$$,
  'INVALID_STATE%', 'lot tracking cannot be switched off once lots exist');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select throws_ok($$select api.upsert_product(gen_random_uuid(), (select id from catalog.brands where code = 'RDT'),
  (select id from catalog.categories where code = 'BUR'), 'TEST-REP', 'Synthetic rep product')$$,
  '42501', null, 'a sales rep cannot create products (42501)');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a7');
select throws_ok($$select api.upsert_product(gen_random_uuid(), (select id from catalog.brands where code = 'RDT'),
  (select id from catalog.categories where code = 'BUR'), 'TEST-ADMIN', 'Synthetic admin product')$$,
  '42501', null, 'an IT admin with catalog.product.read only cannot create products');
select throws_ok($$select api.set_product_status('52000000-0000-0000-0000-000000000001', 'discontinued')$$,
  '42501', null, 'nor discontinue them');

-- ===========================================================================
-- Variants (SKUs)
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a8');
select is(api.upsert_variant('e3400000-0000-0000-0000-000000000001', 'e2400000-0000-0000-0000-000000000001',
  'test-impl-001-3510', 'Synthetic 3.5x10', '{"diameter_mm":3.5,"length_mm":10}') ->> 'sku',
  'TEST-IMPL-001-3510', 'variant created; SKU upper-cased');
select tests.clear_authentication();
select is((select count(*)::int from integration.outbox
           where event_type = 'variant.created' and aggregate_id = 'e3400000-0000-0000-0000-000000000001'), 1,
  'variant.created emitted');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a8');
select throws_like($$select api.upsert_variant(gen_random_uuid(), 'e2400000-0000-0000-0000-000000000001',
  'bio-top-4110', 'Synthetic clash')$$, 'DUPLICATE_SKU%', 'a SKU is unique across all products (case-insensitive)');
select throws_like($$select api.upsert_variant(gen_random_uuid(), 'e2400000-0000-0000-0000-000000000001',
  'TEST-IMPL-001-4010', 'Synthetic', '[1,2]')$$, 'VALIDATION%', 'attributes must be a JSON object');
select throws_like($$select api.upsert_variant(gen_random_uuid(), 'e2400000-0000-0000-0000-000000000001',
  'TEST-IMPL-001-4010', 'Synthetic', '{"Bad Key":1}')$$, 'VALIDATION%', 'attribute keys are snake_case');
select throws_like($$select api.upsert_variant(gen_random_uuid(), 'e2400000-0000-0000-0000-000000000001',
  'TEST-IMPL-001-4010', 'Synthetic', p_reorder_point => -1)$$, 'VALIDATION%', 'reorder point cannot be negative');
select throws_like($$select api.upsert_variant('e3400000-0000-0000-0000-000000000001', '52000000-0000-0000-0000-000000000001',
  'TEST-IMPL-001-3510', 'Synthetic 3.5x10')$$, 'VALIDATION: a variant cannot move%', 'a variant cannot move to another product');
select throws_like($$select api.upsert_variant('53000000-0000-0000-0000-000000000001', '52000000-0000-0000-0000-000000000001',
  'BIO-TOP-4110-NEW', 'Top DM 4.1x10')$$, 'INVALID_STATE%', 'the SKU of a variant with lots cannot change');
select is(api.upsert_variant('53000000-0000-0000-0000-000000000001', '52000000-0000-0000-0000-000000000001',
  'BIO-TOP-4110', 'Top DM 4.1 x 10 mm', '{}', null, 'unit', 5) ->> 'created', 'false',
  'renaming an in-use variant (same SKU) is fine');
select is(api.upsert_variant('e3400000-0000-0000-0000-000000000002', 'e2400000-0000-0000-0000-000000000001',
  'TEST-IMPL-001-4010', 'Synthetic 4.0x10', p_barcode => 'TEST-0000001') ->> 'created', 'true', 'second variant');
select throws_like($$select api.upsert_variant(gen_random_uuid(), 'e2400000-0000-0000-0000-000000000001',
  'TEST-IMPL-001-4510', 'Synthetic 4.5x10', p_barcode => 'TEST-0000001')$$, 'DUPLICATE_BARCODE%', 'barcodes are unique');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select throws_ok($$select api.upsert_variant(gen_random_uuid(), 'e2400000-0000-0000-0000-000000000001', 'TEST-REP-1', 'Synthetic')$$,
  '42501', null, 'a sales rep cannot create variants');
select throws_ok($$select api.set_variant_status('e3400000-0000-0000-0000-000000000001', 'discontinued')$$,
  '42501', null, 'nor discontinue them');

-- ===========================================================================
-- Discontinue, never delete
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a8');
select is(api.set_variant_status('e3400000-0000-0000-0000-000000000002', 'discontinued') ->> 'status', 'discontinued',
  'a variant is discontinued');
select is(api.set_product_status('e2400000-0000-0000-0000-000000000001', 'discontinued') ->> 'previous_status', 'active',
  'a product is discontinued');
select is((select count(*)::int from catalog.product_variants where product_id = 'e2400000-0000-0000-0000-000000000001'), 2,
  'discontinuing keeps the product and all its variants');
select is((select count(*)::int from api.v_catalog_variants
           where product_id = 'e2400000-0000-0000-0000-000000000001' and not is_sellable), 2,
  'the view marks both variants as not sellable');
select throws_like($$select api.upsert_variant(gen_random_uuid(), 'e2400000-0000-0000-0000-000000000001', 'TEST-IMPL-001-5010', 'Synthetic')$$,
  'INVALID_STATE%', 'no new variants on a discontinued product');
select throws_like($$select api.set_variant_status('e3400000-0000-0000-0000-000000000002', 'active')$$,
  'INVALID_STATE%', 'a variant of a discontinued product cannot be reactivated');
select throws_like($$select api.set_product_status('e2400000-0000-0000-0000-000000000001', 'retired')$$,
  'VALIDATION%', 'unknown status is a validation error');
select is(api.set_product_status('e2400000-0000-0000-0000-000000000001', 'discontinued') ->> 'changed', 'false',
  'setting the same status again is a no-op');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select throws_like($$select api.save_order_draft('72400000-0000-0000-0000-0000000000ff','40000000-0000-0000-0000-000000000001',
  '[{"variant_id":"e3400000-0000-0000-0000-000000000001","quantity":1}]')$$,
  'NOT_FOUND%not sellable%', 'a discontinued product cannot be ordered');
select tests.clear_authentication();
select ok((select count(*) from audit.audit_log where table_name = 'products'
           and record_id = 'e2400000-0000-0000-0000-000000000001' and action = 'UPDATE'
           and new_data ->> 'status' = 'discontinued' and old_data ->> 'status' = 'active') = 1,
  'the status change is in the audit log with old and new values');
select is((select count(*)::int from integration.outbox where event_type = 'variant.updated'
           and aggregate_id = 'e3400000-0000-0000-0000-000000000002' and payload ->> 'status' = 'discontinued'), 1,
  'variant.updated emitted for the status change');

-- ===========================================================================
-- Price lists
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a8');
select throws_ok($$select api.upsert_price_list(gen_random_uuid(), 'TEST-INV', 'Synthetic list')$$,
  '42501', null, 'catalog.product.manage does not allow price management');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');
select is(api.upsert_price_list('e5400000-0000-0000-0000-000000000001', 'test-vip', 'Synthetic VIP clinics', 'customer', 10,
  current_date - 1) ->> 'kind', 'customer', 'owner creates a customer price list');
select throws_like($$select api.upsert_price_list('e5400000-0000-0000-0000-000000000001', 'TEST-VIP', 'Synthetic VIP clinics', 'standard')$$,
  'VALIDATION: the kind%', 'the kind of a list cannot change');
select throws_like($$select api.upsert_price_list('54000000-0000-0000-0000-000000000001', 'DEFAULT', 'Default 2026', 'standard', 100,
  '2026-01-01', null, false)$$, 'DEFAULT_LIST_PROTECTED%', 'the DEFAULT list cannot be deactivated');
select throws_like($$select api.upsert_price_list(gen_random_uuid(), 'TEST-DATES', 'Synthetic dates', 'standard', 100,
  current_date, current_date - 1)$$, 'VALIDATION%', 'valid to before valid from is rejected');
select throws_like($$select api.upsert_price_list(gen_random_uuid(), 'default', 'Synthetic second default')$$,
  'DUPLICATE_CODE%', 'price list codes are unique');

-- ===========================================================================
-- Price list items
-- ===========================================================================
select throws_ok($$select api.set_price_list_item('e5400000-0000-0000-0000-000000000001','53000000-0000-0000-0000-000000000001', 0)$$,
  'P0001', null, 'a zero price is rejected');
select throws_ok($$select api.set_price_list_item('e5400000-0000-0000-0000-000000000001','53000000-0000-0000-0000-000000000001', -5)$$,
  'P0001', null, 'a negative price is rejected');
select throws_like($$select api.set_price_list_item('e5400000-0000-0000-0000-000000000001','53000000-0000-0000-0000-000000000001', 10.005)$$,
  'VALIDATION: price may have at most 2 decimals%', 'more than 2 decimals is rejected (no silent rounding)');
select throws_like($$select api.set_price_list_item('e5400000-0000-0000-0000-000000000001','e3400000-0000-0000-0000-000000000002', 10)$$,
  'INVALID_STATE%', 'a discontinued variant cannot be priced');
select is(api.set_price_list_item('e5400000-0000-0000-0000-000000000001','53000000-0000-0000-0000-000000000001', 900) ->> 'changed',
  'true', 'owner sets a customer price');
select tests.clear_authentication();
select is((select count(*)::int from integration.outbox where event_type = 'price.changed'
           and aggregate_id = 'e5400000-0000-0000-0000-000000000001' and (payload ->> 'unit_price')::numeric = 900), 1,
  'price.changed emitted');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select throws_ok($$select api.set_price_list_item('54000000-0000-0000-0000-000000000001','53000000-0000-0000-0000-000000000001', 1)$$,
  '42501', null, 'a sales rep cannot change prices');

-- ===========================================================================
-- Customer price lists
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');
select is(api.assign_customer_price_list('40000000-0000-0000-0000-000000000001','e5400000-0000-0000-0000-000000000001',
  current_date - 1) ->> 'replayed', 'false', 'owner assigns the customer list');
select throws_like($$select api.assign_customer_price_list('40000000-0000-0000-0000-000000000001','54000000-0000-0000-0000-000000000001')$$,
  'VALIDATION: only customer price lists%', 'a standard list cannot be assigned to a customer');
select throws_like($$select api.assign_customer_price_list('40000000-0000-0000-0000-000000000001','e5400000-0000-0000-0000-000000000001',
  current_date + 5)$$, 'OVERLAP%', 'overlapping assignments of the same list are refused');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select throws_ok($$select api.assign_customer_price_list('40000000-0000-0000-0000-000000000001','e5400000-0000-0000-0000-000000000001')$$,
  '42501', null, 'a sales rep cannot assign price lists');
select is((select state from api.v_customer_price_lists where customer_id = '40000000-0000-0000-0000-000000000001'), 'current',
  'the rep sees the current assignment of their own customer');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a5');
select is((select count(*)::int from api.v_customer_price_lists), 0,
  'another rep does not see assignments of customers outside their scope');

-- ===========================================================================
-- Price changes and orders
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is((api.save_order_draft('72400000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001',
  '[{"variant_id":"53000000-0000-0000-0000-000000000001","quantity":2}]') -> 'lines' -> 0 ->> 'list_price')::numeric, 900::numeric,
  'the customer list price (900) applies to the draft');
select is(api.submit_order('72400000-0000-0000-0000-000000000001') ->> 'status', 'submitted', 'order O1 submitted at 900');
select api.save_order_draft('72400000-0000-0000-0000-000000000002','40000000-0000-0000-0000-000000000001',
  '[{"variant_id":"53000000-0000-0000-0000-000000000001","quantity":1}]');
select tests.clear_authentication();
select set_config('t.o1_total', (select total::text from sales.orders where id = '72400000-0000-0000-0000-000000000001'), true);

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');
select is(api.set_price_list_item('e5400000-0000-0000-0000-000000000001','53000000-0000-0000-0000-000000000001', 950)
  ->> 'previous_unit_price', '900.00', 'owner raises the customer price to 950');
select tests.clear_authentication();
select is((select list_price::numeric from sales.order_items where order_id = '72400000-0000-0000-0000-000000000001'), 900::numeric,
  'the submitted order keeps its 900 price snapshot');
select is((select total::text from sales.orders where id = '72400000-0000-0000-0000-000000000001'), current_setting('t.o1_total'),
  'the submitted order total is unchanged');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select api.submit_order('72400000-0000-0000-0000-000000000002');
select tests.clear_authentication();
select is((select list_price::numeric from sales.order_items where order_id = '72400000-0000-0000-0000-000000000002'), 950::numeric,
  'a draft is re-priced at submit with the list in force then (950)');

-- ===========================================================================
-- Promotions
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a8');
select throws_ok($$select api.create_promotion(gen_random_uuid(), 'Synthetic promo', 5, current_date)$$,
  '42501', null, 'the inventory manager cannot create promotions');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');
select throws_ok($$select api.create_promotion(gen_random_uuid(), 'Synthetic promo', 0, current_date)$$,
  'P0001', null, 'a 0% promotion is rejected');
select throws_ok($$select api.create_promotion(gen_random_uuid(), 'Synthetic promo', 101, current_date)$$,
  'P0001', null, 'more than 100% is rejected');
select throws_like($$select api.create_promotion(gen_random_uuid(), 'Synthetic promo', 5, current_date - 10, current_date - 1)$$,
  'VALIDATION%', 'a promotion cannot be created already ended');
select is(api.create_promotion('e6400000-0000-0000-0000-000000000001', 'Synthetic Bioner week', 10, current_date,
  current_date + 7, p_brand_id => (select id from catalog.brands where code = 'BIONER')) ->> 'replayed', 'false',
  'owner creates a 10% brand promotion');
select is(api.create_promotion('e6400000-0000-0000-0000-000000000001', 'Synthetic Bioner week', 10, current_date,
  current_date + 7, p_brand_id => (select id from catalog.brands where code = 'BIONER')) ->> 'replayed', 'true',
  'creating with the same id again is an idempotent replay');
select api.create_promotion('e6400000-0000-0000-0000-000000000002', 'Synthetic Delta clinic offer', 2, current_date,
  p_customer_id => '40000000-0000-0000-0000-000000000002');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is((select state from api.v_promotions where id = 'e6400000-0000-0000-0000-000000000001'), 'active',
  'reps (catalog.price.read) see the active promotion');
select is((select count(*)::int from api.v_promotions where id = 'e6400000-0000-0000-0000-000000000002'), 0,
  'a customer-specific promotion is hidden from reps outside that customer''s scope');
select is((api.save_order_draft('72400000-0000-0000-0000-000000000003','40000000-0000-0000-0000-000000000001',
  '[{"variant_id":"53000000-0000-0000-0000-000000000001","quantity":1}]') -> 'lines' -> 0 ->> 'applied_discount_pct')::numeric,
  10::numeric, 'the promotion applies to a new order');
select api.submit_order('72400000-0000-0000-0000-000000000003');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');
select is(api.end_promotion('e6400000-0000-0000-0000-000000000001') ->> 'is_active', 'false', 'owner ends the promotion');
select throws_like($$select api.end_promotion('e6400000-0000-0000-0000-000000000001')$$, 'INVALID_STATE%',
  'an ended promotion cannot be ended again');
select is((select state from api.v_promotions where id = 'e6400000-0000-0000-0000-000000000001'), 'ended', 'the view shows it ended');
select tests.clear_authentication();
select is((select promo_discount_pct::numeric from sales.order_items where order_id = '72400000-0000-0000-0000-000000000003'),
  10::numeric, 'the submitted order keeps its promotion after the promotion ends');

-- ===========================================================================
-- Customer price list end, read views, privileges
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');
select is((api.end_customer_price_list('40000000-0000-0000-0000-000000000001','e5400000-0000-0000-0000-000000000001',
  current_date - 1) ->> 'valid_to')::date, current_date, 'ending an assignment keeps it valid through today');
select throws_like($$select api.end_customer_price_list('40000000-0000-0000-0000-000000000001','e5400000-0000-0000-0000-000000000001',
  current_date - 1, current_date - 1)$$, 'VALIDATION%', 'an assignment cannot be ended in the past');
select api.set_price_list_item('e5400000-0000-0000-0000-000000000001','53000000-0000-0000-0000-000000000001', 880, 10);
select is(api.remove_price_list_item('e5400000-0000-0000-0000-000000000001','53000000-0000-0000-0000-000000000001', 10) ->> 'removed',
  'true', 'owner removes a quantity tier');
select throws_ok($$select api.remove_price_list_item('e5400000-0000-0000-0000-000000000001','53000000-0000-0000-0000-000000000001', 10)$$,
  'P0002', null, 'removing it again is NOT_FOUND (P0002)');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select throws_ok($$select api.end_promotion('e6400000-0000-0000-0000-000000000002')$$, '42501', null,
  'a sales rep cannot end promotions');
select tests.clear_authentication();
select ok((select count(*) from audit.audit_log where table_name = 'price_list_items' and action = 'UPDATE'
           and (old_data ->> 'unit_price')::numeric = 900 and (new_data ->> 'unit_price')::numeric = 950) = 1,
  'the price change is in the audit log with old and new price');
select ok((select count(*) from audit.audit_log where table_name = 'customer_price_lists' and action = 'UPDATE'
           and new_data ->> 'valid_to' = current_date::text) = 1,
  'customer price list changes are audited (trigger added by this migration)');
select ok((select count(*) from audit.audit_log where table_name = 'price_list_items' and action = 'DELETE'
           and (old_data ->> 'min_qty')::int = 10) = 1, 'a removed tier stays in the audit log');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a7');
select ok((select count(*) from api.v_catalog_products) >= 2 and (select count(*) from api.v_price_lists) = 0,
  'IT admin sees products but no price lists (no catalog.price.read)');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is((select default_price::numeric from api.v_catalog_variants where id = '53000000-0000-0000-0000-000000000001'), 1000::numeric,
  'reps see the DEFAULT list price on the variant view');
select tests.clear_authentication();
select is((select count(*)::int from information_schema.columns
           where table_schema = 'api' and table_name in ('v_catalog_products','v_catalog_variants','v_price_list_items')
             and column_name like '%cost%'), 0, 'no catalogue view exposes purchase cost');
select is((select count(*)::int from integration.outbox
           where aggregate_type in ('catalog.product','catalog.variant','catalog.price_list','sales.promotion')
             and payload::text ilike '%cost%'), 0, 'no catalogue event carries cost');
select ok(not has_function_privilege('authenticated', 'catalog._emit(text, text, uuid, jsonb)', 'execute')
          and not has_function_privilege('authenticated', 'catalog._require_global(text)', 'execute'),
  'internal catalogue helpers are not client-callable');
select ok(not has_function_privilege('anon', 'api.upsert_product(uuid, uuid, uuid, text, text, text, text, boolean, boolean, boolean, text)', 'execute')
          and not has_table_privilege('anon', 'api.v_catalog_products', 'select'),
  'anon can neither run catalogue commands nor read catalogue views');
select ok(not has_function_privilege('authenticated', 'api.post_inventory_adjustment(uuid, uuid, uuid, int, text, text)', 'execute'),
  'this migration does not re-open functions closed earlier (explicit grants only)');

select * from finish();
rollback;
