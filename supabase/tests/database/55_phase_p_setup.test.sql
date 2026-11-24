-- Phase P step 1: setup and real-data imports (20261125000100_phase_p_setup.sql,
-- 20261125000110_phase_p_imports.sql).
--   customers without a phone · employee base location · warehouses · setup overview ·
--   sign-in link authorization · imports of the legacy converter's output, end to end.
-- Synthetic data only: the "legacy-fixture" blocks below are what scripts/legacy/convert.ts makes of
-- the synthetic workbook in tests/unit/legacy-synthetic.ts, parsed exactly as the /imports upload
-- does (customers with the batch default governorate EG-DK). tests/unit/legacy-convert.test.ts
-- fails if they drift apart.
--   users: a1 owner · a4 rep Cairo · a5 rep Delta · a7 admin (core.employee.manage, admin.user.create)
--          · a8 inventory manager
begin;
select tests.load_fixture();
select plan(119);
set constraints all immediate;

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
-- Catalogue, privileges, schema
-- ===========================================================================
select is((select count(*)::int from catalog.brands where code in ('STEP', 'GENERIC'))
          + (select count(*)::int from catalog.categories where code = 'IMPLANT_PARTS'), 0,
  'the legacy brands and category are not seeded (the owner adds them on /admin/setup)');
select ok(not has_function_privilege('anon', 'api.create_brand(text, text, text)', 'execute')
      and has_function_privilege('authenticated', 'api.create_category(text, text, text, text)', 'execute'),
  'brand and category commands: authenticated only');
select is((select array_to_string(allowed_scopes, ',') || '|' || is_sensitive::text || '|' || requires_mfa::text
           from authz.permissions where code = 'inventory.warehouse.manage'), 'all|false|false',
  'inventory.warehouse.manage exists, company-wide only, not MFA-gated (suites 39/48 unchanged)');
select is((select count(*)::int from authz.role_permissions where permission_code = 'inventory.warehouse.manage'), 0,
  'no role holds inventory.warehouse.manage (the owner holds it implicitly)');
select ok(not has_function_privilege('anon', 'api.set_employee_base_location(uuid, text, numeric, numeric, text, numeric)', 'execute')
      and not has_function_privilege('anon', 'api.create_warehouse(uuid, text, text, text)', 'execute')
      and not has_function_privilege('anon', 'api.setup_overview()', 'execute')
      and not has_function_privilege('anon', 'api.authorize_sign_in_link(uuid)', 'execute'),
  'anon cannot execute the new commands');
select ok(has_function_privilege('authenticated', 'api.set_employee_base_location(uuid, text, numeric, numeric, text, numeric)', 'execute')
      and has_function_privilege('authenticated', 'api.create_warehouse(uuid, text, text, text)', 'execute')
      and has_function_privilege('authenticated', 'api.setup_overview()', 'execute')
      and has_function_privilege('authenticated', 'api.authorize_sign_in_link(uuid)', 'execute'),
  'signed-in users can call them (the database decides who may)');
select ok(not has_function_privilege('authenticated', 'import._find_customer(text, text, text)', 'execute'),
  'the new import helper is not client-callable');
select ok((select bool_and(coalesce(c.reloptions @> array['security_invoker=true'], false)) from pg_class c
           where c.oid in ('api.v_customer_data_gaps'::regclass, 'api.v_employee_base_locations'::regclass)),
  'the new views are security_invoker');
select is((select is_nullable from information_schema.columns
           where table_schema = 'inventory' and table_name = 'goods_receipt_items' and column_name = 'unit_cost'), 'YES',
  'goods receipt lines may carry an unknown (NULL) cost');
select is((select column_default from information_schema.columns
           where table_schema = 'core' and table_name = 'employees' and column_name = 'lead_radius_km'), '5',
  'decision E: the lead radius defaults to 5 km');

-- ===========================================================================
-- Customers without a phone
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');
create temp table t_np as
  select api.create_customer(p_clinic_name => 'Synthetic No-Phone Clinic', p_governorate_code => 'EG-DK') as r;
select ok((select (r ->> 'customer_no') like 'CUS-%' from t_np), 'a customer can be created without a phone');
select ok((select r -> 'warnings' @> '[{"code": "PHONE_MISSING"}]'::jsonb from t_np), 'the answer warns that the phone is missing');
select is((select phone_missing::text || '|' || location_missing::text from api.v_customer_data_gaps
           where customer_id = (select (r ->> 'customer_id')::uuid from t_np)), 'true|true',
  'api.v_customer_data_gaps flags it (phone and GPS pin missing)');
select is((select count(*)::int from api.v_customer_data_gaps where customer_id = '40000000-0000-0000-0000-000000000001'), 0,
  'a customer with a phone and a pin has no row');
select throws_like($$select api.create_customer(p_clinic_name => 'Synthetic Bad Phone', p_phone_primary => '12345', p_governorate_code => 'EG-C')$$,
  'VALIDATION: phone_primary is not a valid%', 'a phone that is given must still be valid');
select throws_like($$select api.create_customer(p_clinic_name => 'Synthetic Duplicate', p_phone_primary => '01001234567', p_governorate_code => 'EG-C')$$,
  'DUPLICATE_CUSTOMER%', 'a duplicate phone is still refused');
create temp table t_np4 as
  select api.create_customer(p_clinic_name => 'Synthetic Rep Clinic', p_governorate_code => 'EG-C',
                             p_territory_id => '10000000-0000-0000-0000-000000000003',
                             p_owner_employee_id => '20000000-0000-0000-0000-000000000004') as r;
select tests.clear_authentication();
select is((select payload ->> 'phone_missing' from integration.outbox where event_type = 'customer.created'
           and aggregate_id = (select (r ->> 'customer_id')::uuid from t_np)), 'true',
  'customer.created carries phone_missing');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is((select string_agg(primary_rep_employee_id::text, ',') from api.v_customer_data_gaps
           where customer_id in ((select (r ->> 'customer_id')::uuid from t_np), (select (r ->> 'customer_id')::uuid from t_np4))),
  '20000000-0000-0000-0000-000000000004', 'a rep sees their own customer to complete (with the primary rep), not others');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a5');
select is((select count(*)::int from api.v_customer_data_gaps where customer_id = (select (r ->> 'customer_id')::uuid from t_np4)), 0,
  'another rep does not see it');
select tests.clear_authentication();

-- ===========================================================================
-- Employee base location (decision E)
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');
select is(api.set_employee_base_location('20000000-0000-0000-0000-000000000004', '  1 Synthetic Street, Mansoura  ',
                                         31.0409123, 31.3785, 'geocoded'),
  '{"employee_id": "20000000-0000-0000-0000-000000000004", "has_base_location": true, "source": "geocoded", "lead_radius_km": 5.00, "changed": true}'::jsonb,
  'the owner sets a rep''s base address and point');
select is((select base_address || '|' || base_lat || '|' || base_lng || '|' || base_location_source || '|' || lead_radius_km
           from core.employees where id = '20000000-0000-0000-0000-000000000004'),
  '1 Synthetic Street, Mansoura|31.040912|31.378500|geocoded|5.00', 'stored trimmed, rounded to 6 decimals, radius 5 km');
select is((select (api.set_employee_base_location('20000000-0000-0000-0000-000000000004', '1 Synthetic Street, Mansoura',
                                                  31.040912, 31.3785, 'geocoded')) ->> 'changed'), 'false',
  'the same location again changes nothing');
select is((api.set_employee_base_location('20000000-0000-0000-0000-000000000004', '1 Synthetic Street, Mansoura',
                                          31.040912, 31.3785, 'geocoded', 7.5)) ->> 'lead_radius_km', '7.50',
  'the owner changes the radius per rep');
select throws_like($$select api.set_employee_base_location('20000000-0000-0000-0000-000000000004', 'Synthetic', 40.0, 31.0)$$,
  'VALIDATION: the point is outside Egypt%', 'a point outside Egypt is refused');
select throws_like($$select api.set_employee_base_location('20000000-0000-0000-0000-000000000004', 'Synthetic', 31.0, null)$$,
  'VALIDATION: latitude and longitude go together%', 'half a point is refused');
select throws_like($$select api.set_employee_base_location('20000000-0000-0000-0000-000000000004', 'Synthetic', 31.0, 31.0, 'manual', 60)$$,
  'VALIDATION: the lead radius%', 'a radius above 50 km is refused');
select throws_like($$select api.set_employee_base_location('20000000-0000-0000-0000-000000000004', 'Synthetic', 31.0, 31.0, 'gps')$$,
  'VALIDATION: unknown location source%', 'only geocoded or manual');
select throws_like($$select api.set_employee_base_location('20000000-0000-0000-0000-000000000099', null, null, null)$$,
  'NOT_FOUND%', 'an unknown employee is not found');
select tests.clear_authentication();
select is((select count(*)::int from integration.outbox where event_type = 'employee.base_location_changed'
           and aggregate_id = '20000000-0000-0000-0000-000000000004'), 2, 'one outbox event per real change');
select ok(not exists (select 1 from integration.outbox o, jsonb_object_keys(o.payload) k
                      where o.event_type = 'employee.base_location_changed' and (k like '%lat%' or k like '%lng%' or k like '%address%')),
  'the event carries no coordinates or address');
select ok(exists (select 1 from audit.audit_log a where a.table_schema = 'core' and a.table_name = 'employees'
                  and a.record_id = '20000000-0000-0000-0000-000000000004' and a.action = 'UPDATE'
                  and a.changed_fields @> array['base_lat', 'base_lng', 'base_address']),
  'the change is in the audit log');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select throws_ok($$select api.set_employee_base_location('20000000-0000-0000-0000-000000000004', 'Synthetic', 31.0, 31.0)$$,
  '42501', null, 'a rep cannot set a base location (not even their own)');
select is((select base_lat::text from api.v_employee_base_locations where employee_id = '20000000-0000-0000-0000-000000000004'),
  '31.040912', 'the rep reads their own base point');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a5');
select is((select count(*)::int from api.v_employee_base_locations where employee_id = '20000000-0000-0000-0000-000000000004'), 0,
  'another rep cannot read it');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a7');
select is((api.set_employee_base_location('20000000-0000-0000-0000-000000000005', null, 30.5, 31.2)) ->> 'source', 'manual',
  'an admin with core.employee.manage sets a typed point (source manual)');
select throws_like($$select api.set_employee_base_location('20000000-0000-0000-0000-000000000007', 'Synthetic', 30.0, 31.0)$$,
  'SELF_GRANT_FORBIDDEN%', 'nobody but an owner changes their own base');
select throws_like($$select api.set_employee_base_location('20000000-0000-0000-0000-000000000001', 'Synthetic', 30.0, 31.0)$$,
  'OWNER_ONLY%', 'only an owner edits an owner''s record');
select is((api.set_employee_base_location('20000000-0000-0000-0000-000000000005', null, null, null)) ->> 'has_base_location', 'false',
  'the base can be cleared (skip)');
select tests.clear_authentication();
select is((select coalesce(base_location_source, 'none') from core.employees where id = '20000000-0000-0000-0000-000000000005'), 'none',
  'clearing also clears the source');

-- ===========================================================================
-- Warehouses
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');
select is(api.create_warehouse('60000000-0000-0000-0000-0000000000a2', ' wh-main ', 'Synthetic main warehouse'),
  '{"warehouse_id": "60000000-0000-0000-0000-0000000000a2", "code": "WH-MAIN", "kind": "main", "created": true}'::jsonb,
  'the owner creates the main warehouse (code upper-cased)');
select is((api.create_warehouse('60000000-0000-0000-0000-0000000000a2', 'WH-MAIN', 'Synthetic main warehouse')) ->> 'created', 'false',
  'a retried request with the same id is a replay');
select throws_like($$select api.create_warehouse('60000000-0000-0000-0000-0000000000a3', 'WH-MAIN', 'Another')$$,
  'DUPLICATE_CODE%', 'the code is unique');
select throws_like($$select api.create_warehouse('60000000-0000-0000-0000-0000000000a2', 'WH-OTHER', 'Other')$$,
  'CONFLICT%', 'an id reused for another code is a conflict');
select throws_like($$select api.create_warehouse('60000000-0000-0000-0000-0000000000a4', 'WH 2', 'Synthetic')$$,
  'VALIDATION%', 'a bad code is refused');
select throws_like($$select api.create_warehouse('60000000-0000-0000-0000-0000000000a4', 'WH-2', 'Synthetic', 'garage')$$,
  'VALIDATION: unknown warehouse kind%', 'an unknown kind is refused');
select tests.clear_authentication();
select is((select kind || '|' || allow_negative::text || '|' || is_active::text from inventory.warehouses where code = 'WH-MAIN'),
  'main|false|true', 'negative stock stays off');
select ok(exists (select 1 from audit.audit_log where table_name = 'warehouses' and action = 'INSERT'
                  and record_id = '60000000-0000-0000-0000-0000000000a2'), 'warehouse creation is audited');
select is((select count(*)::int from integration.outbox where event_type = 'inventory.warehouse_created'
           and aggregate_id = '60000000-0000-0000-0000-0000000000a2'), 1, 'one outbox event');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a8');
select throws_ok($$select api.create_warehouse('60000000-0000-0000-0000-0000000000a5', 'WH-INV', 'Synthetic')$$,
  '42501', null, 'the inventory manager cannot create warehouses');
select tests.clear_authentication();

-- ===========================================================================
-- Brands and categories for the old system's items
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');
select is((api.setup_overview()) -> 'legacy_catalog_missing', '["GENERIC", "IMPLANT_PARTS", "STEP"]'::jsonb,
  'the overview lists the brands and category the converter needs');
select is((api.create_brand(' step ', 'STEP')) - 'brand_id', '{"code": "STEP", "created": true}'::jsonb, 'the owner adds brand STEP');
select is((api.create_brand('STEP', 'STEP again')) ->> 'created', 'false', 'adding it again changes nothing');
select is((api.create_brand('GENERIC', 'Generic / unbranded')) ->> 'created', 'true', 'and brand GENERIC');
select is((api.create_category('IMPLANT_PARTS', 'Implant components and kits', 'مكونات وأدوات الزرعات', 'IMPLANT')) ->> 'created', 'true',
  'and the category IMPLANT_PARTS under IMPLANT');
select throws_like($$select api.create_category('X-1', 'Synthetic', 'تجريبي', 'NOPE')$$, 'NOT_FOUND: parent category%', 'an unknown parent is refused');
select throws_like($$select api.create_brand('a b', 'Synthetic')$$, 'VALIDATION%', 'a bad brand code is refused');
select is((api.setup_overview()) -> 'legacy_catalog_missing', '[]'::jsonb, 'nothing is missing any more');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select throws_ok($$select api.create_brand('SYN', 'Synthetic')$$, '42501', null, 'a rep cannot add brands');
select tests.clear_authentication();
select is((select p.code from catalog.categories c join catalog.categories p on p.id = c.parent_id where c.code = 'IMPLANT_PARTS'),
  'IMPLANT', 'IMPLANT_PARTS is a child of IMPLANT');
select is((select count(*)::int from audit.audit_log where table_schema = 'catalog' and table_name in ('brands', 'categories') and action = 'INSERT'), 3,
  'brand and category creation is audited');
select is((select count(*)::int from integration.outbox where event_type in ('brand.created', 'category.created')), 3, 'with outbox events');

-- ===========================================================================
-- Setup overview (owner only)
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');
select is((select (x ->> 'main_warehouses')::int || '|' || (x ->> 'reps') || '|' || (x ->> 'reps_with_base_location')
                  || '|' || (x -> 'roles' ->> 'sales_rep')
           from (select api.setup_overview() as x) s), '2|2|1|2',
  'the overview counts main warehouses, reps and reps with a base point');
select ok((select (x ->> 'customers_phone_missing')::int >= 1 and x ? 'imports_committed' and x ? 'default_list_prices'
           from (select api.setup_overview() as x) s), 'and data to complete and import progress');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a7');
select throws_like($$select api.setup_overview()$$, 'OWNER_ONLY%', 'an admin cannot read it');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select throws_ok($$select api.setup_overview()$$, '42501', null, 'nor can a rep');
select tests.clear_authentication();

-- ===========================================================================
-- Sign-in links (no SMTP): the database check before the Auth admin call
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');
select throws_like($$select api.authorize_sign_in_link('20000000-0000-0000-0000-000000000009')$$,
  'VALIDATION: the employee has no e-mail%', 'an employee needs an e-mail first');
select tests.clear_authentication();
update core.employees set email = case id
    when '20000000-0000-0000-0000-000000000009' then 'new.hire@honest.test'
    when '20000000-0000-0000-0000-000000000004' then 'rep.cairo@honest.test'
    when '20000000-0000-0000-0000-000000000005' then 'rep.delta@honest.test'
    when '20000000-0000-0000-0000-000000000001' then 'owner@honest.test' end
  where id in ('20000000-0000-0000-0000-000000000009', '20000000-0000-0000-0000-000000000004',
               '20000000-0000-0000-0000-000000000005', '20000000-0000-0000-0000-000000000001');
update core.user_profiles set status = 'suspended' where user_id = '00000000-0000-0000-0000-0000000000a5';
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');
select is(api.authorize_sign_in_link('20000000-0000-0000-0000-000000000009'),
  '{"employee_id": "20000000-0000-0000-0000-000000000009", "user_id": null, "email": "new.hire@honest.test", "mode": "invite"}'::jsonb,
  'no login yet: an invite link for the employee''s own e-mail');
select is(api.authorize_sign_in_link('20000000-0000-0000-0000-000000000004') ->> 'mode', 'magiclink',
  'an active login: a one-time sign-in link');
select throws_like($$select api.authorize_sign_in_link('20000000-0000-0000-0000-000000000005')$$,
  'INVALID_STATE: the login is suspended%', 'never for a suspended login');
select throws_like($$select api.authorize_sign_in_link('20000000-0000-0000-0000-000000000001')$$,
  'INVALID_STATE: you are already signed in%', 'not for yourself');
select tests.clear_authentication();
select is((select count(*)::int from audit.security_events where event_type = 'sign_in_link_issued'
           and details ->> 'target_employee' in ('20000000-0000-0000-0000-000000000009', '20000000-0000-0000-0000-000000000004')), 2,
  'each authorized link is a security event');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a7');
select throws_like($$select api.authorize_sign_in_link('20000000-0000-0000-0000-000000000009')$$,
  'OWNER_ONLY%', 'an admin with admin.user.create still cannot issue links');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select throws_ok($$select api.authorize_sign_in_link('20000000-0000-0000-0000-000000000009')$$, '42501', null, 'nor can a rep');
select tests.clear_authentication();
update core.user_profiles set status = 'active' where user_id = '00000000-0000-0000-0000-0000000000a5';

-- ===========================================================================
-- The legacy converter's output, end to end through the import commands
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');

-- legacy-fixture:1-products.csv
select api.import_create_batch('products', $j$[
{"product_code":"BIO-0003","brand_code":"BIONER","category_code":"IMPLANT","product_name_en":"Synthetic Implant DM-3510","product_name_ar":null,"lot_tracked":"yes","expiry_tracked":"yes","sku":"BIO-0003","variant_name_en":"Synthetic Implant DM-3510","barcode":"00000000000017","uom":"unit","reorder_point":null},
{"product_code":"BIO-0021","brand_code":"BIONER","category_code":"IMPLANT_PARTS","product_name_en":"Synthetic Abutment DM-MB15","product_name_ar":null,"lot_tracked":"yes","expiry_tracked":"no","sku":"BIO-0021","variant_name_en":"Synthetic Abutment DM-MB15","barcode":null,"uom":"unit","reorder_point":null},
{"product_code":"RDT-0100","brand_code":"RDT","category_code":"BUR","product_name_en":"Synthetic Round 801 Blue-018","product_name_ar":null,"lot_tracked":"no","expiry_tracked":"no","sku":"RDT-0100","variant_name_en":"Synthetic Round 801 Blue-018","barcode":null,"uom":"unit","reorder_point":null},
{"product_code":"DRB-0200","brand_code":"DERBY","category_code":"INSTRUMENT","product_name_en":"Synthetic Clamp DD251-26","product_name_ar":null,"lot_tracked":"no","expiry_tracked":"no","sku":"DRB-0200","variant_name_en":"Synthetic Clamp DD251-26","barcode":null,"uom":"unit","reorder_point":null},
{"product_code":"STP-0300","brand_code":"STEP","category_code":"MEMBRANE","product_name_en":"SYNTHETIC MEMBRANE","product_name_ar":null,"lot_tracked":"yes","expiry_tracked":"no","sku":"STP-0300","variant_name_en":"SYNTHETIC MEMBRANE","barcode":null,"uom":"unit","reorder_point":null},
{"product_code":"RDT-0301","brand_code":"RDT","category_code":"BUR","product_name_en":"Synthetic flat end taper 882-14-10","product_name_ar":null,"lot_tracked":"no","expiry_tracked":"no","sku":"RDT-0301","variant_name_en":"Synthetic flat end taper 882-14-10","barcode":null,"uom":"unit","reorder_point":null},
{"product_code":"GEN-0302","brand_code":"GENERIC","category_code":"INSTRUMENT","product_name_en":"SYNTHETIC BAND","product_name_ar":null,"lot_tracked":"no","expiry_tracked":"no","sku":"GEN-0302","variant_name_en":"SYNTHETIC BAND","barcode":null,"uom":"unit","reorder_point":null}
]$j$, 'p55-products-01', '1-products.csv');
select pg_temp.remember('prod', 'p55-products-01');
select is(api.import_validate(pg_temp.b('prod')) ->> 'status', 'validated', 'converter products: dry run passes');
select is(api.import_commit(pg_temp.b('prod')) -> 'result', '{"products_created": 7, "variants_created": 7}'::jsonb,
  'converter products: one product and one SKU per old item');

-- legacy-fixture:2-base-prices.csv
select api.import_create_batch('customer_prices', $j$[
{"customer_no":null,"customer_phone":null,"price_list_code":"DEFAULT","price_list_name":"Base price list (old system)","sku":"BIO-0003","unit_price":"5000.00","min_qty":null,"valid_from":null,"customer_legacy_ref":null},
{"customer_no":null,"customer_phone":null,"price_list_code":"DEFAULT","price_list_name":"Base price list (old system)","sku":"BIO-0021","unit_price":"1400.00","min_qty":null,"valid_from":null,"customer_legacy_ref":null},
{"customer_no":null,"customer_phone":null,"price_list_code":"DEFAULT","price_list_name":"Base price list (old system)","sku":"RDT-0100","unit_price":"160.00","min_qty":null,"valid_from":null,"customer_legacy_ref":null},
{"customer_no":null,"customer_phone":null,"price_list_code":"DEFAULT","price_list_name":"Base price list (old system)","sku":"DRB-0200","unit_price":"400.00","min_qty":null,"valid_from":null,"customer_legacy_ref":null},
{"customer_no":null,"customer_phone":null,"price_list_code":"DEFAULT","price_list_name":"Base price list (old system)","sku":"STP-0300","unit_price":"3000.00","min_qty":null,"valid_from":null,"customer_legacy_ref":null},
{"customer_no":null,"customer_phone":null,"price_list_code":"DEFAULT","price_list_name":"Base price list (old system)","sku":"RDT-0301","unit_price":"160.00","min_qty":null,"valid_from":null,"customer_legacy_ref":null}
]$j$, 'p55-prices-0001', '2-base-prices.csv');
select pg_temp.remember('price', 'p55-prices-0001');
select is(api.import_validate(pg_temp.b('price')) ->> 'status', 'validated', 'converter base prices: dry run passes (rows without a customer)');
select is(api.import_commit(pg_temp.b('price')) -> 'result', '{"price_lists_created": 0, "prices_set": 6, "assignments": 0}'::jsonb,
  'converter base prices: six prices on the existing DEFAULT list, nobody assigned');

-- legacy-fixture:3-opening-stock.csv
select api.import_create_batch('opening_stock', $j$[
{"warehouse_code":"WH-MAIN","sku":"BIO-0003","lot_no":"LEGACY-UNKNOWN","expiry_date":"2030-06-30","quantity":"10","unit_cost":null,"cost_unknown":"yes"},
{"warehouse_code":"WH-MAIN","sku":"BIO-0021","lot_no":"LEGACY-UNKNOWN","expiry_date":null,"quantity":"5","unit_cost":"2000.00","cost_unknown":null},
{"warehouse_code":"WH-MAIN","sku":"RDT-0100","lot_no":null,"expiry_date":null,"quantity":"20","unit_cost":null,"cost_unknown":"yes"},
{"warehouse_code":"WH-MAIN","sku":"STP-0300","lot_no":"LEGACY-UNKNOWN","expiry_date":null,"quantity":"3","unit_cost":null,"cost_unknown":"yes"}
]$j$, 'p55-stock-00001', '3-opening-stock.csv');
select pg_temp.remember('stock', 'p55-stock-00001');
select is(api.import_validate(pg_temp.b('stock')) ->> 'status', 'validated', 'converter opening stock: dry run passes (unknown costs marked)');
select is(api.import_commit(pg_temp.b('stock')) -> 'result',
  '{"receipts_posted": 1, "lines": 4, "units": 38, "cost_unknown_lines": 3}'::jsonb,
  'converter opening stock: one receipt into WH-MAIN, 38 units, 3 lines with unknown cost');

-- legacy-fixture:4-customers.csv
select api.import_create_batch('customers', $j$[
{"doctor_name":"د/تجربة أول","clinic_name":null,"display_name":null,"kind":"clinic","specialty_code":null,"phone_primary":"+201000000001","phone_secondary":null,"email":null,"governorate_code":"EG-DK","city":null,"address_line":null,"territory_code":null,"rep_employee_no":null,"notes":"Old system account 1","legacy_ref":"1"},
{"doctor_name":"د/ تجربة ثان","clinic_name":null,"display_name":null,"kind":"clinic","specialty_code":null,"phone_primary":null,"phone_secondary":null,"email":null,"governorate_code":"EG-DK","city":null,"address_line":null,"territory_code":null,"rep_employee_no":null,"notes":"Old system account 2","legacy_ref":"2"},
{"doctor_name":null,"clinic_name":"مركز تجريبي","display_name":null,"kind":"clinic","specialty_code":null,"phone_primary":"+201100000002","phone_secondary":null,"email":null,"governorate_code":"EG-DK","city":null,"address_line":"1 شارع تجريبي","territory_code":null,"rep_employee_no":null,"notes":"Old system account 3","legacy_ref":"3"},
{"doctor_name":null,"clinic_name":"Synthetic Lab","display_name":null,"kind":"clinic","specialty_code":null,"phone_primary":null,"phone_secondary":null,"email":null,"governorate_code":"EG-DK","city":null,"address_line":null,"territory_code":null,"rep_employee_no":null,"notes":"Old system account 4; old account type: أخرى; old-system phone not valid: 12345","legacy_ref":"4"},
{"doctor_name":"د/تجربة خامس","clinic_name":null,"display_name":null,"kind":"clinic","specialty_code":null,"phone_primary":null,"phone_secondary":null,"email":null,"governorate_code":"EG-DK","city":null,"address_line":null,"territory_code":null,"rep_employee_no":null,"notes":"Old system account 5; old-system phone shared with another account: +201000000001","legacy_ref":"5"}
]$j$, 'p55-customers-1', '4-customers.csv');
select pg_temp.remember('cust', 'p55-customers-1');
select is(api.import_validate(pg_temp.b('cust')) ->> 'status', 'validated', 'converter customers: dry run passes (3 of 5 without a phone)');
select is(api.import_commit(pg_temp.b('cust')) -> 'result', '{"customers_created": 5, "phone_missing": 3, "legacy_refs": 5}'::jsonb,
  'converter customers: five leads, three flagged phone missing, five old account numbers kept');

-- legacy-fixture:5-opening-ar.csv
select api.import_create_batch('opening_ar', $j$[
{"customer_no":null,"customer_phone":null,"amount":"1000.00","customer_legacy_ref":"1"},
{"customer_no":null,"customer_phone":null,"amount":"500.50","customer_legacy_ref":"4"}
]$j$, 'p55-ar-debit-01', '5-opening-ar.csv');
select pg_temp.remember('ar', 'p55-ar-debit-01');
select is(api.import_validate(pg_temp.b('ar')) ->> 'status', 'validated', 'converter opening AR: dry run passes (customers named by old account number)');
select is(api.import_commit(pg_temp.b('ar')) -> 'result', '{"entries": 2, "total_amount": 1500.50}'::jsonb,
  'converter opening AR: two debit balances, total = the Checks debit total');

-- legacy-fixture:6-opening-ar-credits.csv
select api.import_create_batch('opening_ar', $j$[
{"customer_no":null,"customer_phone":null,"amount":"-300.00","customer_legacy_ref":"3"}
]$j$, 'p55-ar-credit-1', '6-opening-ar-credits.csv');
select pg_temp.remember('arc', 'p55-ar-credit-1');
select is(api.import_validate(pg_temp.b('arc')) ->> 'status', 'validated', 'converter credit balances: dry run passes');
select is(api.import_commit(pg_temp.b('arc')) -> 'result', '{"entries": 1, "total_amount": -300.00}'::jsonb,
  'converter credit balances: posted as a negative opening entry once confirmed');
select tests.clear_authentication();

-- What the commits posted
select is((select b.code || '|' || c.code || '|' || p.is_lot_tracked::text || '|' || p.is_expiry_tracked::text || '|' || v.barcode
           from catalog.product_variants v join catalog.products p on p.id = v.product_id
           join catalog.brands b on b.id = p.brand_id join catalog.categories c on c.id = p.category_id where v.sku = 'BIO-0003'),
  'BIONER|IMPLANT|true|true|00000000000017', 'the Bioner implant is lot- and expiry-tracked with its GTIN as barcode');
select is((select string_agg(v.sku || ':' || b.code || '/' || c.code, ',' order by v.sku)
           from catalog.product_variants v join catalog.products p on p.id = v.product_id
           join catalog.brands b on b.id = p.brand_id join catalog.categories c on c.id = p.category_id
           where v.sku in ('BIO-0021', 'STP-0300', 'GEN-0302', 'RDT-0301')),
  'BIO-0021:BIONER/IMPLANT_PARTS,GEN-0302:GENERIC/INSTRUMENT,RDT-0301:RDT/BUR,STP-0300:STEP/MEMBRANE',
  'abutments, STEP membranes, unbranded and maker-less items land in the new brands and category');
select is((select unit_price from sales.resolve_list_price('40000000-0000-0000-0000-000000000002',
             (select id from catalog.product_variants where sku = 'BIO-0003'), 1)), 5000.00::numeric,
  'server pricing finds the base price for any customer');
select is((select count(*)::int || '|' || count(*) filter (where gi.unit_cost is null)::int || '|' || count(*) filter (where gi.unit_cost = 0)::int
           from inventory.goods_receipt_items gi join inventory.goods_receipts g on g.id = gi.receipt_id
           where g.shipment_ref = 'IMPORT-' || upper(left(pg_temp.b('stock')::text, 8))), '4|3|0',
  'unknown costs are stored as NULL, never 0');
select is((select count(*)::int from inventory.movements m join import.rows x on (x.result ->> 'movement_id')::uuid = m.id
           where x.batch_id = pg_temp.b('stock') and m.unit_cost is null), 3, 'the receipt movements carry the unknown cost too');
select is((select string_agg(v.sku || ':' || l.lot_no || ':' || coalesce(l.expiry_date::text, '-') || ':' || b.on_hand, ',' order by v.sku)
           from inventory.stock_balances b join inventory.lots l on l.id = b.lot_id
           join catalog.product_variants v on v.id = b.variant_id
           where b.warehouse_id = '60000000-0000-0000-0000-0000000000a2'),
  'BIO-0003:LEGACY-UNKNOWN:2030-06-30:10,BIO-0021:LEGACY-UNKNOWN:-:5,RDT-0100:NO-LOT:-:20,STP-0300:LEGACY-UNKNOWN:-:3',
  'stock on hand in the main warehouse by lot (placeholder lot where the old system had none)');
select is((select count(*)::int from inventory.stock_balances b
           where b.on_hand <> (select coalesce(sum(m.quantity), 0) from inventory.movements m
                               where m.warehouse_id = b.warehouse_id and m.variant_id = b.variant_id and m.lot_id = b.lot_id)),
  0, 'inventory invariant: every balance equals the sum of its movements');
select is((select count(*)::int from integration.external_refs x join crm.customers c on c.id = x.entity_id
           where x.provider = 'legacy_pos' and x.entity_type = 'customer' and c.source = 'import'), 5,
  'each imported customer is linked to its old account number');
select is((select count(*)::int from crm.customers c join integration.external_refs x on x.entity_id = c.id and x.provider = 'legacy_pos'
           where c.phone_primary is null and c.governorate_code = 'EG-DK'), 3,
  'three customers have no phone, all in the batch default governorate');
select is((select l.amount::numeric from finance.customer_ledger l join integration.external_refs x on x.entity_id = l.customer_id
           where x.provider = 'legacy_pos' and x.external_id = '1' and l.entry_type = 'opening_balance'), 1000.00::numeric,
  'the opening balance landed on the customer named by the old account number');
select is((select sum(l.amount)::numeric from finance.customer_ledger l join integration.external_refs x on x.entity_id = l.customer_id
           where x.provider = 'legacy_pos' and l.entry_type = 'opening_balance'), 1200.50::numeric,
  'opening AR equals the workbook net (debit 1500.50 - credit 300.00)');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');
select is((select count(*)::int from api.v_customer_data_gaps g join api.v_import_rows x on (x.result ->> 'customer_id')::uuid = g.customer_id
           where x.batch_id = pg_temp.b('cust') and g.phone_missing and (x.result ->> 'phone_missing')::boolean), 3,
  'the gaps view lists them for completion (the staging rows say which)');
select is((select (x -> 'imports_committed' ->> 'customers')::int || '|' || (x ->> 'opening_ar_entries')
           from (select api.setup_overview() as x) s), '1|3', 'the setup overview shows the import progress');

-- ===========================================================================
-- Rejects for the new columns and rules
-- ===========================================================================
select api.import_create_batch('customers', $j$[
  {"clinic_name":"Synthetic Again","phone_primary":null,"governorate_code":"EG-DK","legacy_ref":"1"},
  {"clinic_name":"Synthetic Twin A","phone_primary":null,"governorate_code":"EG-DK","legacy_ref":"77"},
  {"clinic_name":"Synthetic Twin B","phone_primary":null,"governorate_code":"EG-DK","legacy_ref":"77"},
  {"clinic_name":"Synthetic Space","phone_primary":null,"governorate_code":"EG-DK","legacy_ref":"7 7"},
  {"clinic_name":"Synthetic Phone","phone_primary":"123","governorate_code":"EG-DK"},
  {"clinic_name":"Synthetic Fine","phone_primary":null,"governorate_code":"EG-DK"}
]$j$, 'p55-cust-bad-01');
select pg_temp.remember('cbad', 'p55-cust-bad-01');
select is(api.import_validate(pg_temp.b('cbad')) ->> 'error_count', '5', 'customer rejects for the new rules');
select is(pg_temp.errs('cbad', 1), 'exists:legacy_ref', 'rejects: an old account number already imported');
select is(pg_temp.errs('cbad', 2) || ' / ' || pg_temp.errs('cbad', 3), 'duplicate_in_file:legacy_ref / duplicate_in_file:legacy_ref',
  'rejects: the same old account number twice in the file');
select is(pg_temp.errs('cbad', 4), 'invalid:legacy_ref', 'rejects: an old account number with a space');
select is(pg_temp.errs('cbad', 5), 'invalid:phone_primary', 'rejects: a phone that is given but not valid');
select is(pg_temp.errs('cbad', 6), '', 'an empty phone is not an error');

select api.import_create_batch('opening_ar', $j$[
  {"customer_legacy_ref":"999","amount":"10"},
  {"customer_no":"C-0001","customer_legacy_ref":"2","amount":"10"},
  {"customer_phone":"+201112345678","customer_legacy_ref":"bad ref","amount":"10"}
]$j$, 'p55-ar-bad-0001');
select pg_temp.remember('abad', 'p55-ar-bad-0001');
select is(api.import_validate(pg_temp.b('abad')) ->> 'error_count', '3', 'opening AR rejects for old account numbers');
select is(pg_temp.errs('abad', 1) || ' / ' || pg_temp.errs('abad', 2) || ' / ' || pg_temp.errs('abad', 3),
  'unknown:customer_legacy_ref / mismatch:customer_legacy_ref / invalid:customer_legacy_ref',
  'rejects: unknown, disagreeing with the customer number, malformed');

select api.import_create_batch('customer_prices', $j$[
  {"customer_no":"C-0001","price_list_code":"DEFAULT","sku":"BIO-0003","unit_price":"4000"},
  {"price_list_code":"SYN-MIX","price_list_name":"Synthetic mix","sku":"BIO-0003","unit_price":"4000"},
  {"customer_legacy_ref":"1","price_list_code":"SYN-MIX","price_list_name":"Synthetic mix","sku":"BIO-0021","unit_price":"1000"},
  {"price_list_code":"SYN-BASE-2","price_list_name":"Synthetic base 2","sku":"RDT-0100","unit_price":"150"},
  {"price_list_code":"SYN-BASE-2","price_list_name":"Synthetic base 2","sku":"RDT-0100","unit_price":"150"}
]$j$, 'p55-price-bad-1');
select pg_temp.remember('lbad', 'p55-price-bad-1');
select is(api.import_validate(pg_temp.b('lbad')) ->> 'error_count', '5', 'price rejects for base-list rows');
select is(pg_temp.errs('lbad', 1), 'wrong_kind:price_list_code', 'rejects: a customer row on the standard DEFAULT list');
select is(pg_temp.errs('lbad', 2) || ' / ' || pg_temp.errs('lbad', 3), 'inconsistent:price_list_code / inconsistent:price_list_code',
  'rejects: one new code used with and without a customer');
select is(pg_temp.errs('lbad', 4) || ' / ' || pg_temp.errs('lbad', 5), 'duplicate_in_file:sku / duplicate_in_file:sku',
  'rejects: the same base-list SKU twice');

select api.import_create_batch('customer_prices', $j$[
  {"price_list_code":"SYN-BASE-2","price_list_name":"Synthetic base 2","sku":"RDT-0100","unit_price":"150"},
  {"customer_legacy_ref":"2","price_list_code":"SYN-CL-2","price_list_name":"Synthetic clinic 2","sku":"RDT-0100","unit_price":"140"},
  {"price_list_code":"DEFAULT","sku":"DRB-0200","unit_price":"390","valid_from":"2099-01-01"}
]$j$, 'p55-price-ok-01');
select pg_temp.remember('lok', 'p55-price-ok-01');
select is(api.import_validate(pg_temp.b('lok')) ->> 'status', 'validated',
  'a new standard list, a customer list (by old account number), and a base price (a start date is ignored for an existing list)');
select is(api.import_commit(pg_temp.b('lok')) -> 'result', '{"price_lists_created": 2, "prices_set": 3, "assignments": 1}'::jsonb,
  'two lists, three prices, one assignment');
select tests.clear_authentication();
select is((select string_agg(pl.code || ':' || pl.kind, ',' order by pl.code) from catalog.price_lists pl where pl.code in ('SYN-BASE-2', 'SYN-CL-2')),
  'SYN-BASE-2:standard,SYN-CL-2:customer', 'the list kind follows the rows (no customer = standard)');
select is((select count(*)::int from catalog.customer_price_lists cpl join catalog.price_lists pl on pl.id = cpl.price_list_id
           where pl.code = 'SYN-BASE-2'), 0, 'nobody is assigned to a standard list');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');
select api.import_create_batch('opening_stock', $j$[
  {"warehouse_code":"WH-MAIN","sku":"DRB-0200","quantity":"1","unit_cost":"10","cost_unknown":"yes"},
  {"warehouse_code":"WH-MAIN","sku":"DRB-0200","lot_no":"SYN-L2","quantity":"1","cost_unknown":"maybe"},
  {"warehouse_code":"WH-MAIN","sku":"GEN-0302","quantity":"1"}
]$j$, 'p55-stock-bad-1');
select pg_temp.remember('sbad', 'p55-stock-bad-1');
select is(api.import_validate(pg_temp.b('sbad')) ->> 'error_count', '3', 'opening stock rejects for cost_unknown');
select is(pg_temp.errs('sbad', 1) || ' / ' || pg_temp.errs('sbad', 2) || ' / ' || pg_temp.errs('sbad', 3),
  'inconsistent:unit_cost / invalid:cost_unknown,required:unit_cost / required:unit_cost',
  'rejects: a cost marked unknown, a bad flag, an accidental blank (suite 34 rule kept)');

-- api.create_goods_receipt: cost_unknown only for opening stock imports
select throws_like(format($$select api.create_goods_receipt('60000000-0000-0000-0000-0000000000a2', 'Synthetic', null,
                     '[{"variant_id":"%s","lot_no":"NO-LOT","quantity":1,"unit_cost":5,"cost_unknown":true}]')$$,
                   (select id from catalog.product_variants where sku = 'GEN-0302')),
  'VALIDATION: item 1 has a unit_cost and cost_unknown%', 'a receipt line cannot have a cost and be unknown');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a8');
select throws_like(format($$select api.create_goods_receipt('60000000-0000-0000-0000-000000000001', 'Synthetic supplier', null,
                     '[{"variant_id":"%s","lot_no":"NO-LOT","quantity":1,"cost_unknown":true}]')$$,
                   '53000000-0000-0000-0000-000000000001'),
  'VALIDATION: item 1 an unknown cost is allowed only for opening stock imports%',
  'a supplier receipt by the inventory manager must carry its cost');
select is((api.create_goods_receipt('60000000-0000-0000-0000-000000000001', 'Synthetic supplier', null,
            '[{"variant_id":"53000000-0000-0000-0000-000000000001","lot_no":"L2026A","expiry_date":"2030-12-31","quantity":1,"cost_unknown":false}]'::jsonb)) ->> 'status',
  'draft', 'cost_unknown false behaves as before (catalogue cost)');
select tests.clear_authentication();

select * from finish();
rollback;
