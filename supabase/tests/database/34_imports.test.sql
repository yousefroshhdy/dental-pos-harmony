-- Data migration imports (20261103000100_import_schema.sql, 20261103000200_import_commands.sql):
-- staging, per-row validation (rejects report), idempotent staging, all-or-nothing commit,
-- opening stock = inventory ledger, opening AR = customer ledger, permissions.
-- Synthetic data only (D-03).
--   users: a1 owner · a4 rep Cairo · a8 inventory manager (inventory.receipt.post, no admin.import.run)
--   fixture: C-0001 (+201001234567), C-0002 (+201112345678), WH-CAI, BIO-TOP-4110 (cost 600,
--            lot L2026A expiring 2030-12-31)
begin;
select tests.load_fixture();
select plan(90);
set constraints all immediate;

-- A quarantine warehouse (expired opening stock may only land there).
insert into inventory.warehouses (id, code, name, kind)
values ('60000000-0000-0000-0000-0000000000f1', 'WH-QUA', 'Synthetic quarantine', 'quarantine');

-- Batch id by idempotency key, readable by any role later in the transaction.
create function pg_temp.remember(p_name text, p_key text) returns void language sql as $$
  select set_config('t.' || p_name, (select id::text from import.batches where idempotency_key = p_key), true)
$$;
create function pg_temp.b(p_name text) returns uuid language sql as $$
  select nullif(current_setting('t.' || p_name, true), '')::uuid
$$;
create function pg_temp.errs(p_name text, p_row int) returns text language sql as $$
  select array_to_string(errors, ',') from import.rows where batch_id = pg_temp.b(p_name) and row_no = p_row
$$;
grant execute on function pg_temp.b(text) to authenticated;

-- ===========================================================================
-- Catalogue and privileges
-- ===========================================================================
select is((select is_sensitive::text || '|' || array_to_string(allowed_scopes, ',') from authz.permissions where code = 'admin.import.run'),
  'true|all', 'admin.import.run exists, is sensitive and company-wide only');
select is((select count(*)::int from authz.role_permissions where permission_code = 'admin.import.run'), 0,
  'no system role holds admin.import.run explicitly (the owner holds it implicitly)');
select ok(not has_function_privilege('anon', 'api.import_commit(uuid)', 'execute'), 'anon cannot run import commands');
select ok(has_function_privilege('authenticated', 'api.import_create_batch(text, jsonb, text, text)', 'execute'),
  'signed-in users can call the staging command (the database decides who may)');
select ok(not has_function_privilege('authenticated', 'import._validate(uuid)', 'execute'),
  'internal import helpers are not client-callable');
select ok((select coalesce(c.reloptions @> array['security_invoker=true'], false) from pg_class c where c.oid = 'api.v_import_batches'::regclass)
      and (select coalesce(c.reloptions @> array['security_invoker=true'], false) from pg_class c where c.oid = 'api.v_import_rows'::regclass),
  'import views are security_invoker');

-- ===========================================================================
-- Denied roles (42501)
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select throws_ok($$select api.import_create_batch('customers', '[{"phone_primary":"01001110001","governorate_code":"EG-C","clinic_name":"X"}]', 'rep-try-0001')$$,
  '42501', null, 'a rep cannot stage an import');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a8');
select throws_ok($$select api.import_create_batch('opening_stock', '[{"warehouse_code":"WH-CAI","sku":"BIO-TOP-4110","quantity":"1"}]', 'inv-try-0001')$$,
  '42501', null, 'the inventory manager cannot import opening stock without admin.import.run');
select tests.clear_authentication();

-- ===========================================================================
-- Customers: staging, idempotency, validation
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');
select is((api.import_create_batch('customers', $j$[
  {"clinic_name":"Synthetic Clinic One","doctor_name":"Dr. Test One","phone_primary":"01001110001","governorate_code":"EG-C","city":"Nasr City","territory_code":"CAI-NASR","rep_employee_no":"E004"},
  {"clinic_name":"Synthetic Clinic Two","phone_primary":"12345","governorate_code":"EG-C"},
  {"clinic_name":"Synthetic Clinic Three","phone_primary":"01001110003","governorate_code":"EG-C"},
  {"clinic_name":"Synthetic Clinic Four","phone_primary":"+20 100 111 0003","governorate_code":"EG-C"},
  {"clinic_name":"Synthetic Clinic Five","phone_primary":"+201001234567","governorate_code":"EG-C"},
  {"phone_primary":"01001110006","governorate_code":"EG-XX"}
]$j$, 'cust-bad-0001', 'customers-bad.csv') ->> 'row_count')::int, 6, 'the owner stages a customers file (6 rows)');
select pg_temp.remember('cbad', 'cust-bad-0001');
select is(api.import_create_batch('customers', $j$[
  {"clinic_name":"Synthetic Clinic One","doctor_name":"Dr. Test One","phone_primary":"01001110001","governorate_code":"EG-C","city":"Nasr City","territory_code":"CAI-NASR","rep_employee_no":"E004"},
  {"clinic_name":"Synthetic Clinic Two","phone_primary":"12345","governorate_code":"EG-C"},
  {"clinic_name":"Synthetic Clinic Three","phone_primary":"01001110003","governorate_code":"EG-C"},
  {"clinic_name":"Synthetic Clinic Four","phone_primary":"+20 100 111 0003","governorate_code":"EG-C"},
  {"clinic_name":"Synthetic Clinic Five","phone_primary":"+201001234567","governorate_code":"EG-C"},
  {"phone_primary":"01001110006","governorate_code":"EG-XX"}
]$j$, 'cust-bad-0001', 'customers-bad.csv') - 'status',
  jsonb_build_object('batch_id', pg_temp.b('cbad'), 'kind', 'customers', 'row_count', 6, 'replayed', true),
  'replaying the same idempotency key and rows returns the same batch');
select throws_like($$select api.import_create_batch('customers', '[{"phone_primary":"01001110001","governorate_code":"EG-C","clinic_name":"Other"}]', 'cust-bad-0001')$$,
  'CONFLICT%', 'the same key with a different file is a conflict');
select throws_like($$select api.import_create_batch('customers', '[{"phone_primary":"01001110001","governorate_code":"EG-C","salary":"1"}]', 'cust-col-0001')$$,
  'VALIDATION: unknown column salary%', 'an unknown column is refused');
select throws_like($$select api.import_create_batch('customers', '[{"clinic_name":"X","governorate_code":"EG-C"}]', 'cust-col-0002')$$,
  'VALIDATION: missing column phone_primary%', 'a missing required column is refused');
select throws_like($$select api.import_create_batch('payroll', '[{"a":"1"}]', 'kind-bad-0001')$$,
  'VALIDATION: unknown import kind%', 'an unknown kind is refused');
select is((select count(*)::int from api.v_import_rows where batch_id = pg_temp.b('cbad')), 6, 'six rows staged as-is');

select is(api.import_validate(pg_temp.b('cbad')) ->> 'status', 'failed', 'validation with rejects leaves the batch failed');
select is((select valid_count || '|' || error_count from api.v_import_batches where id = pg_temp.b('cbad')), '1|5',
  'one valid row, five rejects');
select is(pg_temp.errs('cbad', 2), 'invalid:phone_primary', 'rejects: phone format');
select is(pg_temp.errs('cbad', 3) || ' / ' || pg_temp.errs('cbad', 4),
  'duplicate_in_file:phone_primary / duplicate_in_file:phone_primary', 'rejects: the same phone twice in the file (after normalising)');
select is(pg_temp.errs('cbad', 5), 'exists:phone_primary', 'rejects: phone already registered to a customer');
select is(pg_temp.errs('cbad', 6), 'required:doctor_name/clinic_name,unknown:governorate_code', 'rejects: missing name, unknown governorate');
select is((select normalized ->> 'phone_primary' from import.rows where batch_id = pg_temp.b('cbad') and row_no = 1), '+201001110001',
  'normalized carries the E.164 phone');
select throws_like(format('select api.import_commit(%L)', pg_temp.b('cbad')), 'INVALID_STATE%', 'a batch with rejects cannot be committed');
select tests.clear_authentication();

-- ===========================================================================
-- Customers: all-or-nothing commit
-- ===========================================================================
-- Row 3 passes validation but its insert fails (an injected trigger): nothing may be posted.
create function tests.import_boom() returns trigger language plpgsql as $$
begin
  if new.phone_primary = '+201001110099' then raise exception 'SYNTHETIC_FAILURE: injected' using errcode = 'P0001'; end if;
  return new;
end $$;
create trigger trg_import_boom before insert on crm.customers for each row execute function tests.import_boom();

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');
select api.import_create_batch('customers', $j$[
  {"clinic_name":"Synthetic Clinic One","doctor_name":"Dr. Test One","phone_primary":"01001110001","governorate_code":"EG-C","city":"Nasr City","territory_code":"CAI-NASR","rep_employee_no":"E004"},
  {"clinic_name":"Synthetic Clinic Seven","phone_primary":"01001110007","governorate_code":"EG-GZ","kind":"lab"},
  {"clinic_name":"Synthetic Clinic Nine","phone_primary":"01001110099","governorate_code":"EG-C"}
]$j$, 'cust-ok-00001', 'customers.csv');
select pg_temp.remember('cok', 'cust-ok-00001');
select is(api.import_validate(pg_temp.b('cok')) ->> 'status', 'validated', 'a clean customers file validates');
select is((select api.import_commit(pg_temp.b('cok')) - 'failure_sqlstate'),
  jsonb_build_object('batch_id', pg_temp.b('cok'), 'kind', 'customers', 'status', 'failed', 'committed', false,
                     'failure', 'SYNTHETIC_FAILURE: injected', 'failure_row_no', 3),
  'a failure on row 3 fails the commit and names the row');
select is((select count(*)::int from api.v_customers where phone_primary in ('+201001110001', '+201001110007')), 0,
  'all-or-nothing: rows 1 and 2 were rolled back too');
select is((select status || '|' || failure_row_no from api.v_import_batches where id = pg_temp.b('cok')), 'failed|3',
  'the failure is recorded on the batch');
select tests.clear_authentication();
drop trigger trg_import_boom on crm.customers;

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');
select is(api.import_validate(pg_temp.b('cok')) ->> 'status', 'validated', 'once the cause is fixed the batch re-validates');
select is(api.import_commit(pg_temp.b('cok')) ->> 'status', 'committed', 'and commits');
select is((select count(*)::int from api.v_customers where phone_primary in ('+201001110001', '+201001110007', '+201001110099')), 3,
  'three customers created');
select tests.clear_authentication();
select is((select count(*)::int from crm.customers where source = 'import' and lifecycle_stage = 'lead'), 3,
  'through api.create_customer: source import, lifecycle lead');
select is((select t.code || '|' || e.employee_no from crm.customers c
           join core.territories t on t.id = c.territory_id
           join crm.customer_assignments a on a.customer_id = c.id and a.role = 'primary_rep' and a.valid_to is null
           join core.employees e on e.id = a.employee_id
           where c.phone_primary = '+201001110001'), 'CAI-NASR|E004', 'territory and primary rep from the file');
select is((select count(*)::int from import.rows where batch_id = pg_temp.b('cok') and status = 'committed'
           and result ->> 'customer_no' like 'CUS-%'), 3, 'each staging row links to the customer it created');
select is((select count(*)::int from integration.outbox where event_type = 'import.committed' and aggregate_id = pg_temp.b('cok')), 1,
  'import.committed outbox event');
select is((select count(*)::int from integration.outbox where event_type = 'customer.created'
           and payload ->> 'source' = 'import'), 3, 'every customer emitted its normal customer.created event');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');
select throws_like(format('select api.import_commit(%L)', pg_temp.b('cok')), 'ALREADY_COMMITTED%', 'a double commit is refused');
select throws_like(format('select api.import_discard(%L)', pg_temp.b('cok')), 'ALREADY_COMMITTED%', 'a committed batch cannot be discarded');
select throws_like(format('select api.import_validate(%L)', pg_temp.b('cok')), 'ALREADY_COMMITTED%', 'nor re-validated');

-- ===========================================================================
-- Products and variants
-- ===========================================================================
select api.import_create_batch('products', $j$[
  {"product_code":"SYN-NEW","brand_code":"BIONER","category_code":"IMPLANT","product_name_en":"Synthetic A","sku":"SYN-NEW-1","variant_name_en":"A1"},
  {"product_code":"SYN-NEW","brand_code":"BIONER","category_code":"IMPLANT","product_name_en":"Synthetic B","sku":"SYN-NEW-2","variant_name_en":"B1"},
  {"product_code":"SYN-ODD","brand_code":"NOPE","category_code":"IMPLANT","product_name_en":"Synthetic C","sku":"BIO-TOP-4110","variant_name_en":"C1","reorder_point":"-1"}
]$j$, 'prod-bad-0001');
select pg_temp.remember('pbad', 'prod-bad-0001');
select is(api.import_validate(pg_temp.b('pbad')) ->> 'error_count', '3', 'products with rejects');
select is(pg_temp.errs('pbad', 1) || ' / ' || pg_temp.errs('pbad', 2), 'inconsistent:product_code / inconsistent:product_code',
  'rejects: two rows describe one new product differently');
select is(pg_temp.errs('pbad', 3), 'unknown:brand_code,exists:sku,negative:reorder_point', 'rejects: unknown brand, SKU exists, negative reorder point');

select api.import_create_batch('products', $j$[
  {"product_code":"SYN-IMP","brand_code":"bioner","category_code":"IMPLANT","product_name_en":"Synthetic Implant","expiry_tracked":"yes","sku":"SYN-IMP-3510","variant_name_en":"Synthetic 3.5x10","reorder_point":"5"},
  {"product_code":"SYN-IMP","brand_code":"bioner","category_code":"IMPLANT","product_name_en":"Synthetic Implant","expiry_tracked":"yes","sku":"syn-imp-4010","variant_name_en":"Synthetic 4.0x10"},
  {"product_code":"BIO-TOP","sku":"BIO-TOP-4111","variant_name_en":"Top DM 4.1x11"}
]$j$, 'prod-ok-00001');
select pg_temp.remember('pok', 'prod-ok-00001');
select is(api.import_validate(pg_temp.b('pok')) ->> 'status', 'validated', 'a clean products file validates (existing product reused)');
select is(api.import_commit(pg_temp.b('pok')) -> 'result', '{"products_created": 1, "variants_created": 3}'::jsonb,
  'one product and three variants created');
select tests.clear_authentication();
select is((select p.is_expiry_tracked::text || '|' || p.status || '|' || count(v.*) from catalog.products p
           join catalog.product_variants v on v.product_id = p.id where p.code = 'SYN-IMP' group by p.id),
  'true|active|2', 'the new product carries its flags and both variants');
select is((select p.code from catalog.product_variants v join catalog.products p on p.id = v.product_id where v.sku = 'BIO-TOP-4111'),
  'BIO-TOP', 'a variant of an existing product attaches to it');

-- ===========================================================================
-- Customer price lists
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');
select api.import_create_batch('customer_prices', $j$[
  {"customer_no":"C-9999","price_list_code":"SYN-CL-1","price_list_name":"Synthetic list","sku":"BIO-TOP-4110","unit_price":"900"},
  {"customer_phone":"01001110001","price_list_code":"DEFAULT","sku":"NOPE-1","unit_price":"-5"},
  {"customer_no":"C-0001","customer_phone":"+201112345678","price_list_code":"SYN-CL-1","price_list_name":"Synthetic list","sku":"BIO-TOP-4110","unit_price":"12.345"}
]$j$, 'price-bad-0001');
select pg_temp.remember('lbad', 'price-bad-0001');
select is(api.import_validate(pg_temp.b('lbad')) ->> 'error_count', '3', 'price rows with rejects');
select is(pg_temp.errs('lbad', 1), 'unknown:customer_no', 'rejects: unknown customer');
select is(pg_temp.errs('lbad', 2), 'wrong_kind:price_list_code,unknown:sku,negative:unit_price',
  'rejects: not a customer list, unknown SKU, negative price');
select is(pg_temp.errs('lbad', 3), 'mismatch:customer_phone,invalid:unit_price', 'rejects: customer number and phone disagree, 3 decimals');

select api.import_create_batch('customer_prices', $j$[
  {"customer_phone":"01001110001","price_list_code":"syn-cl-1","price_list_name":"Synthetic clinic list","sku":"BIO-TOP-4110","unit_price":"950"},
  {"customer_phone":"01001110001","price_list_code":"SYN-CL-1","price_list_name":"Synthetic clinic list","sku":"SYN-IMP-3510","unit_price":"1200.50","min_qty":"1"},
  {"customer_no":"C-0002","price_list_code":"SYN-CL-1","sku":"BIO-TOP-4110","unit_price":"950","valid_from":"2026-01-01"}
]$j$, 'price-ok-00001');
select pg_temp.remember('lok', 'price-ok-00001');
select is(api.import_validate(pg_temp.b('lok')) ->> 'status', 'validated', 'a clean price file validates (shared list, repeated price agrees)');
select is(api.import_commit(pg_temp.b('lok')) -> 'result', '{"price_lists_created": 1, "prices_set": 2, "assignments": 2}'::jsonb,
  'one customer list, two prices, two assignments');
select tests.clear_authentication();
select is((select pl.kind || '|' || pl.valid_from || '|' || count(i.*) from catalog.price_lists pl
           join catalog.price_list_items i on i.price_list_id = pl.id where pl.code = 'SYN-CL-1' group by pl.id),
  'customer|2026-01-01|2', 'the list is a customer list starting on the earliest assignment date');
select is((select count(*)::int from catalog.customer_price_lists cpl join catalog.price_lists pl on pl.id = cpl.price_list_id
           where pl.code = 'SYN-CL-1'), 2, 'both customers are assigned the list');

-- ===========================================================================
-- Opening stock
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');
select api.import_create_batch('opening_stock', $j$[
  {"warehouse_code":"WH-NOPE","sku":"SYN-IMP-3510","lot_no":"SYN-LX","expiry_date":"2030-01-01","quantity":"1","unit_cost":"1"},
  {"warehouse_code":"WH-CAI","sku":"NOPE-1","lot_no":"X1","quantity":"1","unit_cost":"10"},
  {"warehouse_code":"WH-CAI","sku":"SYN-IMP-3510","lot_no":"SYN-LN","expiry_date":"2030-01-01","quantity":"-5","unit_cost":"1"},
  {"warehouse_code":"WH-CAI","sku":"SYN-IMP-3510","lot_no":"SYN-L0","expiry_date":"2020-01-01","quantity":"3","unit_cost":"450"},
  {"warehouse_code":"WH-CAI","sku":"SYN-IMP-4010","lot_no":"SYN-L9","quantity":"3","unit_cost":"450"},
  {"warehouse_code":"WH-CAI","sku":"BIO-TOP-4110","lot_no":"L2026A","expiry_date":"2031-01-01","quantity":"2"},
  {"warehouse_code":"WH-CAI","sku":"BIO-TOP-4111","lot_no":"L-NC","quantity":"2"}
]$j$, 'stock-bad-0001');
select pg_temp.remember('sbad', 'stock-bad-0001');
select is(api.import_validate(pg_temp.b('sbad')) ->> 'error_count', '7', 'opening stock with rejects');
select is(pg_temp.errs('sbad', 1), 'unknown:warehouse_code', 'rejects: unknown warehouse');
select is(pg_temp.errs('sbad', 2), 'unknown:sku', 'rejects: unknown SKU');
select is(pg_temp.errs('sbad', 3), 'negative:quantity', 'rejects: negative quantity');
select is(pg_temp.errs('sbad', 4), 'expired:expiry_date', 'rejects: expiry in the past (outside quarantine)');
select is(pg_temp.errs('sbad', 5), 'required:expiry_date', 'rejects: expiry-tracked product without expiry');
select is(pg_temp.errs('sbad', 6), 'mismatch:expiry_date', 'rejects: lot already recorded with another expiry');
select is(pg_temp.errs('sbad', 7), 'required:unit_cost', 'rejects: no cost in the file and none in the catalogue');

select api.import_create_batch('opening_stock', $j$[
  {"warehouse_code":"wh-cai","sku":"BIO-TOP-4110","lot_no":"L2026A","expiry_date":"2030-12-31","quantity":"10"},
  {"warehouse_code":"WH-CAI","sku":"SYN-IMP-3510","lot_no":"SYN-L1","expiry_date":"2029-06-30","quantity":"5","unit_cost":"450"},
  {"warehouse_code":"WH-QUA","sku":"BIO-TOP-4110","lot_no":"L2019X","expiry_date":"2020-01-01","quantity":"2","unit_cost":"600"}
]$j$, 'stock-ok-00001');
select pg_temp.remember('sok', 'stock-ok-00001');
select is(api.import_validate(pg_temp.b('sok')) ->> 'status', 'validated', 'clean opening stock validates (expired lot only in quarantine)');
select is(api.import_commit(pg_temp.b('sok')) -> 'result', '{"receipts_posted": 2, "lines": 3, "units": 17}'::jsonb,
  'one goods receipt per warehouse, three lines, 17 units');
select tests.clear_authentication();
select is((select on_hand from inventory.stock_balances where warehouse_id = '60000000-0000-0000-0000-000000000001'
           and lot_id = '61000000-0000-0000-0000-000000000001'), 10, 'opening stock is on hand in the lot');
select is((select coalesce(sum(m.quantity), 0)::int from import.rows x join inventory.movements m on m.id = (x.result ->> 'movement_id')::uuid
           where x.batch_id = pg_temp.b('sok') and m.movement_type = 'receipt'),
          (select sum((normalized ->> 'quantity')::int)::int from import.rows where batch_id = pg_temp.b('sok')),
  'opening stock equals the ledger: every staged unit is one receipt movement');
select is((select count(*)::int from inventory.stock_balances b
           where b.on_hand <> (select coalesce(sum(m.quantity), 0) from inventory.movements m
                               where m.warehouse_id = b.warehouse_id and m.variant_id = b.variant_id and m.lot_id = b.lot_id)),
  0, 'inventory invariant: every balance equals the sum of its movements');
select is((select string_agg(g.status || ':' || g.supplier, ',') from inventory.goods_receipts g where g.shipment_ref = 'IMPORT-' || upper(left(pg_temp.b('sok')::text, 8))),
  'posted:Opening stock (import),posted:Opening stock (import)', 'posted as ordinary goods receipts (document trail)');
select is((select l.expiry_date::text from inventory.lots l join catalog.product_variants v on v.id = l.variant_id
           where v.sku = 'SYN-IMP-3510' and l.lot_no = 'SYN-L1'), '2029-06-30', 'new lots carry their expiry');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');
select api.import_create_batch('opening_stock', '[{"warehouse_code":"WH-CAI","sku":"BIO-TOP-4110","lot_no":"L2026A","expiry_date":"2030-12-31","quantity":"1"}]',
  'stock-again-001');
select pg_temp.remember('sagain', 'stock-again-001');
select api.import_validate(pg_temp.b('sagain'));
select is(pg_temp.errs('sagain', 1), 'already_imported:lot_no', 'the same warehouse, SKU and lot cannot be opened twice');

-- ===========================================================================
-- Opening AR balances
-- ===========================================================================
select api.import_create_batch('opening_ar', $j$[
  {"customer_no":"C-9999","amount":"100"},
  {"customer_no":"C-0001","amount":"0"},
  {"customer_phone":"01001110007","amount":"12,5"},
  {"customer_no":"C-0002","amount":"10"},
  {"customer_phone":"+201112345678","amount":"20"}
]$j$, 'ar-bad-000001');
select pg_temp.remember('abad', 'ar-bad-000001');
select is(api.import_validate(pg_temp.b('abad')) ->> 'error_count', '5', 'opening AR with rejects');
select is(pg_temp.errs('abad', 1) || ' / ' || pg_temp.errs('abad', 2) || ' / ' || pg_temp.errs('abad', 3),
  'unknown:customer_no / invalid:amount / invalid:amount', 'rejects: unknown customer, zero amount, thousands separator');
select is(pg_temp.errs('abad', 4) || ' / ' || pg_temp.errs('abad', 5),
  'duplicate_in_file:customer / duplicate_in_file:customer', 'rejects: one customer twice (by number and by phone)');

select api.import_create_batch('opening_ar', $j$[
  {"customer_no":"c-0001","amount":"1500.50"},
  {"customer_phone":"+201112345678","amount":"2499.5"},
  {"customer_phone":"01001110007","amount":"-300"}
]$j$, 'ar-ok-0000001');
select pg_temp.remember('aok', 'ar-ok-0000001');
select is(api.import_validate(pg_temp.b('aok')) ->> 'status', 'validated', 'clean opening AR validates (a negative amount is a credit)');
select is(api.import_commit(pg_temp.b('aok')) -> 'result', '{"entries": 3, "total_amount": 3700.00}'::jsonb, 'three opening entries');
select tests.clear_authentication();
select is((select coalesce(sum(l.amount), 0) from finance.customer_ledger l
           where l.entry_type = 'opening_balance' and l.source_table = 'import.rows'
             and l.source_id in (select id from import.rows where batch_id = pg_temp.b('aok'))),
          (select sum((normalized ->> 'amount')::numeric) from import.rows where batch_id = pg_temp.b('aok')),
  'opening AR equals the ledger: the staged total is the posted total');
select is((select balance from finance.v_customer_balances where customer_id = '40000000-0000-0000-0000-000000000001'), 1500.50::numeric,
  'the customer balance derives from the ledger entry');
select is((select string_agg(l.entry_type || '=' || l.amount, ',' order by l.amount) from finance.customer_ledger l
           join crm.customers c on c.id = l.customer_id where c.phone_primary = '+201001110007'),
  'opening_balance=-300.00', 'a credit balance posts as a negative entry');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select is((select ledger_balance from api.v_ar_aging where customer_id = '40000000-0000-0000-0000-000000000002'), 2499.50::numeric,
  'finance sees the opening balance in the aging ledger balance');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');
select api.import_create_batch('opening_ar', '[{"customer_no":"C-0001","amount":"1"}]', 'ar-again-00001');
select pg_temp.remember('aagain', 'ar-again-00001');
select api.import_validate(pg_temp.b('aagain'));
select is(pg_temp.errs('aagain', 1), 'already_imported:customer', 'a customer gets one opening balance');

-- ===========================================================================
-- Discard, visibility, denied commands
-- ===========================================================================
select is(api.import_discard(pg_temp.b('aagain')) ->> 'status', 'discarded', 'an uncommitted batch can be discarded');
select is((select count(*)::int from import.rows where batch_id = pg_temp.b('aagain')), 0, 'discarding deletes its staged rows');
select is(api.import_discard(pg_temp.b('aagain')) ->> 'replayed', 'true', 'discarding twice is a no-op');
select throws_like(format('select api.import_validate(%L)', pg_temp.b('aagain')), 'INVALID_STATE%', 'a discarded batch cannot be validated');
select ok((select count(*) from api.v_import_batches) >= 10 and (select count(*) from api.v_import_rows) > 0, 'the owner sees the batch history');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is((select count(*)::int from api.v_import_batches) + (select count(*)::int from api.v_import_rows), 0,
  'a rep sees no batches and no staged rows');
select throws_ok(format('select api.import_validate(%L)', pg_temp.b('sagain')), '42501', null, 'a rep cannot validate');
select throws_ok(format('select api.import_commit(%L)', pg_temp.b('sagain')), '42501', null, 'a rep cannot commit');
select throws_ok(format('select api.import_discard(%L)', pg_temp.b('sagain')), '42501', null, 'a rep cannot discard');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a8');
select throws_ok(format('select api.import_commit(%L)', pg_temp.b('sagain')), '42501', null, 'nor can the inventory manager');
select tests.clear_authentication();
select is((select status from import.batches where id = pg_temp.b('sagain')), 'failed', 'the denied attempts changed nothing');

select * from finish();
rollback;
