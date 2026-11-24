-- Phase P: the old-system workbook loaded from the browser (20261126000300_phase_p_legacy_import.sql).
--   owner only + MFA · ordered steps (customers → products → prices → opening stock → opening AR) enforced
--   on the import batches · negative-stock decisions (zero / skip) · credit balances held by default ·
--   restage / abandon · data-quality view scope · no file stored.
-- Synthetic data only: the rows are the converter's output for tests/unit/legacy-synthetic.ts (the same
-- blocks as suite 55), as the server stages them; item RDT-0301 is the synthetic negative-stock row.
--   users: a1 owner · a4 rep Cairo · a7 admin (given admin.import.run below: still not the owner)
begin;
select tests.load_fixture();
select plan(80);
set constraints all immediate;

create function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return 'OK';
exception when others then
  return 'ERROR ' || sqlstate || ' ' || split_part(sqlerrm, ':', 1);
end $$;
create function pg_temp.enforce(p_on boolean) returns void language sql as $$
  update core.system_settings set value = to_jsonb(p_on) where key = 'security.mfa_enforced'
$$;
create function pg_temp.step(p_session uuid, p_step int) returns uuid language sql as $$
  select batch_id from import.legacy_session_steps where session_id = p_session and step_no = p_step
$$;
create function pg_temp.sid(p_name text) returns uuid language sql as $$
  select nullif(current_setting('t.' || p_name, true), '')::uuid
$$;
create function pg_temp.keep(p_name text, p_value text) returns text language sql as $$
  select set_config('t.' || p_name, p_value, true)
$$;
grant execute on all functions in schema pg_temp to authenticated;

-- The converter's synthetic output, as staged by the server (tests/unit/legacy-browser-import.test.ts
-- checks these blocks equal stageAll() for the synthetic workbook with RDT-0301 fixed to 0, credits held).
create temp table t_rows (kind text primary key, rows jsonb);
insert into t_rows values
('customers', $j$[
{"doctor_name":"د/تجربة أول","clinic_name":null,"display_name":null,"kind":"clinic","specialty_code":null,"phone_primary":"+201000000001","phone_secondary":null,"email":null,"governorate_code":"EG-DK","city":null,"address_line":null,"territory_code":null,"rep_employee_no":null,"notes":"Old system account 1","legacy_ref":"1"},
{"doctor_name":"د/ تجربة ثان","clinic_name":null,"display_name":null,"kind":"clinic","specialty_code":null,"phone_primary":null,"phone_secondary":null,"email":null,"governorate_code":"EG-DK","city":null,"address_line":null,"territory_code":null,"rep_employee_no":null,"notes":"Old system account 2","legacy_ref":"2"},
{"doctor_name":null,"clinic_name":"مركز تجريبي","display_name":null,"kind":"clinic","specialty_code":null,"phone_primary":"+201100000002","phone_secondary":null,"email":null,"governorate_code":"EG-DK","city":null,"address_line":"1 شارع تجريبي","territory_code":null,"rep_employee_no":null,"notes":"Old system account 3","legacy_ref":"3"},
{"doctor_name":null,"clinic_name":"Synthetic Lab","display_name":null,"kind":"clinic","specialty_code":null,"phone_primary":null,"phone_secondary":null,"email":null,"governorate_code":"EG-DK","city":null,"address_line":null,"territory_code":null,"rep_employee_no":null,"notes":"Old system account 4; old account type: أخرى; old-system phone not valid: 12345","legacy_ref":"4"},
{"doctor_name":"د/تجربة خامس","clinic_name":null,"display_name":null,"kind":"clinic","specialty_code":null,"phone_primary":null,"phone_secondary":null,"email":null,"governorate_code":"EG-DK","city":null,"address_line":null,"territory_code":null,"rep_employee_no":null,"notes":"Old system account 5; old-system phone shared with another account: +201000000001","legacy_ref":"5"}
]$j$),
('products', $j$[
{"product_code":"BIO-0003","brand_code":"BIONER","category_code":"IMPLANT","product_name_en":"Synthetic Implant DM-3510","product_name_ar":null,"lot_tracked":"yes","expiry_tracked":"yes","sku":"BIO-0003","variant_name_en":"Synthetic Implant DM-3510","barcode":"00000000000017","uom":"unit","reorder_point":null},
{"product_code":"BIO-0021","brand_code":"BIONER","category_code":"IMPLANT_PARTS","product_name_en":"Synthetic Abutment DM-MB15","product_name_ar":null,"lot_tracked":"yes","expiry_tracked":"no","sku":"BIO-0021","variant_name_en":"Synthetic Abutment DM-MB15","barcode":null,"uom":"unit","reorder_point":null},
{"product_code":"RDT-0100","brand_code":"RDT","category_code":"BUR","product_name_en":"Synthetic Round 801 Blue-018","product_name_ar":null,"lot_tracked":"no","expiry_tracked":"no","sku":"RDT-0100","variant_name_en":"Synthetic Round 801 Blue-018","barcode":null,"uom":"unit","reorder_point":null},
{"product_code":"DRB-0200","brand_code":"DERBY","category_code":"INSTRUMENT","product_name_en":"Synthetic Clamp DD251-26","product_name_ar":null,"lot_tracked":"no","expiry_tracked":"no","sku":"DRB-0200","variant_name_en":"Synthetic Clamp DD251-26","barcode":null,"uom":"unit","reorder_point":null},
{"product_code":"STP-0300","brand_code":"STEP","category_code":"MEMBRANE","product_name_en":"SYNTHETIC MEMBRANE","product_name_ar":null,"lot_tracked":"yes","expiry_tracked":"no","sku":"STP-0300","variant_name_en":"SYNTHETIC MEMBRANE","barcode":null,"uom":"unit","reorder_point":null},
{"product_code":"RDT-0301","brand_code":"RDT","category_code":"BUR","product_name_en":"Synthetic flat end taper 882-14-10","product_name_ar":null,"lot_tracked":"no","expiry_tracked":"no","sku":"RDT-0301","variant_name_en":"Synthetic flat end taper 882-14-10","barcode":null,"uom":"unit","reorder_point":null},
{"product_code":"GEN-0302","brand_code":"GENERIC","category_code":"INSTRUMENT","product_name_en":"SYNTHETIC BAND","product_name_ar":null,"lot_tracked":"no","expiry_tracked":"no","sku":"GEN-0302","variant_name_en":"SYNTHETIC BAND","barcode":null,"uom":"unit","reorder_point":null}
]$j$),
('customer_prices', $j$[
{"customer_no":null,"customer_phone":null,"price_list_code":"DEFAULT","price_list_name":"Base price list (old system)","sku":"BIO-0003","unit_price":"5000.00","min_qty":null,"valid_from":null,"customer_legacy_ref":null},
{"customer_no":null,"customer_phone":null,"price_list_code":"DEFAULT","price_list_name":"Base price list (old system)","sku":"BIO-0021","unit_price":"1400.00","min_qty":null,"valid_from":null,"customer_legacy_ref":null},
{"customer_no":null,"customer_phone":null,"price_list_code":"DEFAULT","price_list_name":"Base price list (old system)","sku":"RDT-0100","unit_price":"160.00","min_qty":null,"valid_from":null,"customer_legacy_ref":null},
{"customer_no":null,"customer_phone":null,"price_list_code":"DEFAULT","price_list_name":"Base price list (old system)","sku":"DRB-0200","unit_price":"400.00","min_qty":null,"valid_from":null,"customer_legacy_ref":null},
{"customer_no":null,"customer_phone":null,"price_list_code":"DEFAULT","price_list_name":"Base price list (old system)","sku":"STP-0300","unit_price":"3000.00","min_qty":null,"valid_from":null,"customer_legacy_ref":null},
{"customer_no":null,"customer_phone":null,"price_list_code":"DEFAULT","price_list_name":"Base price list (old system)","sku":"RDT-0301","unit_price":"160.00","min_qty":null,"valid_from":null,"customer_legacy_ref":null}
]$j$),
('opening_stock', $j$[
{"warehouse_code":"WH-MAIN","sku":"BIO-0003","lot_no":"LEGACY-UNKNOWN","expiry_date":"2030-06-30","quantity":"10","unit_cost":null,"cost_unknown":"yes"},
{"warehouse_code":"WH-MAIN","sku":"BIO-0021","lot_no":"LEGACY-UNKNOWN","expiry_date":null,"quantity":"5","unit_cost":"2000.00","cost_unknown":null},
{"warehouse_code":"WH-MAIN","sku":"RDT-0100","lot_no":null,"expiry_date":null,"quantity":"20","unit_cost":null,"cost_unknown":"yes"},
{"warehouse_code":"WH-MAIN","sku":"STP-0300","lot_no":"LEGACY-UNKNOWN","expiry_date":null,"quantity":"3","unit_cost":null,"cost_unknown":"yes"}
]$j$),
('opening_ar', $j$[
{"customer_no":null,"customer_phone":null,"amount":"1000.00","customer_legacy_ref":"1"},
{"customer_no":null,"customer_phone":null,"amount":"500.50","customer_legacy_ref":"4"}
]$j$);
grant select on t_rows to authenticated;

-- All five kinds; p_override replaces kinds wholesale.
create function pg_temp.batches(p_override jsonb default '{}') returns jsonb language sql as $$
  select (select jsonb_object_agg(kind, rows) from t_rows) || p_override
$$;
-- RDT-0301 (the negative row) fixed to 0; GEN-0999 (an item left out of every file) skipped.
create function pg_temp.decisions() returns jsonb language sql as $$
  select '[{"sku":"RDT-0301","name":"Synthetic flat end taper 882-14-10","quantity":-6,"decision":"zero"},
           {"sku":"GEN-0999","name":"Synthetic skipped item","quantity":-2,"decision":"skip"}]'::jsonb
$$;
create function pg_temp.start(p_key text, p_batches jsonb, p_decisions jsonb default null, p_credits text default null,
                              p_summary jsonb default '{"checks":[]}') returns jsonb language sql as $$
  select api.legacy_import_start(p_key, 'synthetic.xlsx', repeat('a', 64), p_summary,
                                 coalesce(p_decisions, pg_temp.decisions()), p_credits, p_batches)
$$;
grant execute on all functions in schema pg_temp to authenticated;

-- Prerequisites from /admin/setup (suite 55 covers them).
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');
select api.create_brand('STEP', 'STEP');
select api.create_brand('GENERIC', 'Generic / unbranded');
select api.create_category('IMPLANT_PARTS', 'Implant components and kits', 'مكونات وأدوات الزرعات', 'IMPLANT');
select api.create_warehouse('60000000-0000-0000-0000-0000000000c2', 'WH-MAIN', 'Synthetic main warehouse');
select tests.clear_authentication();

-- ===========================================================================
-- Schema, privileges, no file stored
-- ===========================================================================
select ok(not has_function_privilege('anon', 'api.legacy_import_check()', 'execute')
      and not has_function_privilege('anon', 'api.legacy_import_start(text, text, text, jsonb, jsonb, text, jsonb)', 'execute')
      and not has_function_privilege('anon', 'api.legacy_import_restage(uuid, int, jsonb, text)', 'execute')
      and not has_function_privilege('anon', 'api.legacy_import_abandon(uuid)', 'execute'),
  'anon cannot execute the legacy import commands');
select ok(has_function_privilege('authenticated', 'api.legacy_import_check()', 'execute')
      and has_function_privilege('authenticated', 'api.legacy_import_start(text, text, text, jsonb, jsonb, text, jsonb)', 'execute')
      and has_function_privilege('authenticated', 'api.legacy_import_restage(uuid, int, jsonb, text)', 'execute')
      and has_function_privilege('authenticated', 'api.legacy_import_abandon(uuid)', 'execute'),
  'signed-in users can call them (the database decides who may)');
select ok(not has_function_privilege('authenticated', 'import._legacy_require()', 'execute')
      and not has_function_privilege('authenticated', 'import._legacy_check_rows(text, jsonb, jsonb, text)', 'execute')
      and not has_function_privilege('authenticated', 'import._legacy_step_guard()', 'execute'),
  'the helpers are not client-callable');
select ok((select bool_and(coalesce(c.reloptions @> array['security_invoker=true'], false)) from pg_class c
           where c.oid in ('api.v_legacy_import_sessions'::regclass, 'api.v_legacy_import_steps'::regclass,
                           'api.v_legacy_import_quality'::regclass)),
  'the new views are security_invoker');
select ok((select bool_and(c.relrowsecurity) from pg_class c
           where c.oid in ('import.legacy_sessions'::regclass, 'import.legacy_session_steps'::regclass)),
  'RLS is enabled on the session tables');
select is((select count(*)::int from information_schema.columns
           where table_schema = 'import' and data_type in ('bytea', 'oid')), 0,
  'no file is stored: the import schema has no binary column');
select is((select requires_mfa::text || '|' || is_sensitive::text from authz.permissions where code = 'admin.import.run'), 'true|true',
  'the commands ride on admin.import.run, which is sensitive and MFA-gated');
select is((select count(*)::int from authz.permissions where code like '%legacy%'), 0,
  'no new permission (suites 39 and 48 unchanged)');

-- ===========================================================================
-- Owner only, MFA
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select throws_ok($$select api.legacy_import_check()$$, '42501', null, 'a rep is refused');
select throws_ok($$select pg_temp.start('p62-rep-000001', pg_temp.batches())$$, '42501', null, 'a rep cannot start an import');
select is((select count(*)::int from api.v_legacy_import_sessions), 0, 'a rep sees no sessions');
select tests.clear_authentication();

insert into authz.role_permissions (role_id, permission_code, scope)
select id, 'admin.import.run', 'all' from authz.roles where code = 'admin';
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a7');
select throws_like($$select api.legacy_import_check()$$, 'OWNER_ONLY%',
  'a non-owner holding admin.import.run is still refused (owner only)');
select throws_like($$select pg_temp.start('p62-admin-0001', pg_temp.batches())$$, 'OWNER_ONLY%', 'and cannot start an import');
select tests.clear_authentication();

select pg_temp.enforce(true);
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');
select throws_like($$select api.legacy_import_check()$$, 'MFA_REQUIRED%', 'enforcement on: the owner at aal1 is refused the upload gate');
select throws_like($$select pg_temp.start('p62-aal1-00001', pg_temp.batches())$$, 'MFA_REQUIRED%', 'and the start');
select tests.authenticate_as_aal2('00000000-0000-0000-0000-0000000000a1');
select is(api.legacy_import_check(), '{"allowed": true, "open_session_id": null}'::jsonb, 'enforcement on: the owner at aal2 passes');
select tests.clear_authentication();
select pg_temp.enforce(false);
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');
select is(api.legacy_import_check() ->> 'allowed', 'true', 'enforcement off: the owner passes at aal1');

-- ===========================================================================
-- Start: the decisions must agree with the rows
-- ===========================================================================
select throws_like($$select pg_temp.start('p62-bad-skip01', pg_temp.batches(),
    '[{"sku":"RDT-0301","quantity":-6,"decision":"skip"}]')$$,
  'LEGACY_DECISION: products rows hold items the owner chose to skip%', 'skip: the item may not be in the products');
select throws_like($$select pg_temp.start('p62-bad-skip02', pg_temp.batches(jsonb_build_object('products',
      (select jsonb_agg(e) from jsonb_array_elements((select rows from t_rows where kind = 'products')) e where e ->> 'sku' <> 'RDT-0301'))),
    '[{"sku":"RDT-0301","quantity":-6,"decision":"skip"}]')$$,
  'LEGACY_DECISION: customer_prices rows hold items%', 'skip: nor in the prices');
select throws_like($$select pg_temp.start('p62-bad-zero01', pg_temp.batches(jsonb_build_object('opening_stock',
      (select rows from t_rows where kind = 'opening_stock')
       || '[{"warehouse_code":"WH-MAIN","sku":"RDT-0301","lot_no":null,"expiry_date":null,"quantity":"1","unit_cost":"1","cost_unknown":null}]'::jsonb)))$$,
  'LEGACY_DECISION: opening stock holds an item the owner fixed to 0%', 'zero: no opening-stock line for the item');
select throws_like($$select pg_temp.start('p62-bad-zero02', pg_temp.batches(),
    '[{"sku":"RDT-0999","quantity":-1,"decision":"zero"}]')$$,
  'LEGACY_DECISION: an item fixed to 0 is missing from the products%', 'zero: the item itself is imported');
select throws_like($$select pg_temp.start('p62-bad-cred01', pg_temp.batches(jsonb_build_object('opening_ar',
      (select rows from t_rows where kind = 'opening_ar') || '[{"customer_legacy_ref":"3","amount":"-300.00"}]'::jsonb)))$$,
  'LEGACY_DECISION: credit balances are held%', 'credits are held by default: no negative opening AR');
select throws_like($$select pg_temp.start('p62-bad-dec001', pg_temp.batches(), '[{"sku":"RDT-0301","quantity":-6,"decision":"later"}]')$$,
  'VALIDATION: each negative stock item%', 'a decision is zero or skip');
select throws_like($$select pg_temp.start('p62-bad-dec002', pg_temp.batches(), '[{"sku":"RDT-0301","quantity":6,"decision":"zero"}]')$$,
  'VALIDATION: each negative stock item%', 'only items below zero');
select throws_like($$select pg_temp.start('p62-bad-kind01', pg_temp.batches('{"invoices": []}'))$$,
  'VALIDATION: batches must be an object keyed by import kind%', 'only the five import kinds');
select throws_like($$select pg_temp.start('p62-bad-none01', '{}'::jsonb, '[]')$$,
  'VALIDATION: the workbook has nothing to import%', 'an empty workbook is refused');
select throws_like($$select pg_temp.start('p62-bad-blob01', pg_temp.batches(), null, null,
    jsonb_build_object('file', repeat('x', 40000)))$$,
  'VALIDATION: the summary must be a small JSON object%', 'no file smuggled into the summary (aggregates only, capped)');
select is((select count(*)::int from import.batches), 0, 'a refused start stages nothing');

-- ===========================================================================
-- Start (credits held by default), replay, one open session
-- ===========================================================================
create temp table t_s1 as select pg_temp.start('p62-session-01', pg_temp.batches()) as r;
select pg_temp.keep('s1', (select r ->> 'session_id' from t_s1));
select is((select string_agg((x ->> 'step_no') || ':' || (x ->> 'kind') || ':' || (x ->> 'row_count'), ',' order by (x ->> 'step_no')::int)
           from t_s1, jsonb_array_elements(r -> 'steps') x),
  '1:customers:5,2:products:7,3:customer_prices:6,4:opening_stock:4,5:opening_ar:2',
  'the start stages one batch per step, in the reviewer''s order');
select is((select string_agg(b.kind || '=' || b.status, ',' order by st.step_no) from import.legacy_session_steps st
           join import.batches b on b.id = st.batch_id where st.session_id = pg_temp.sid('s1')),
  'customers=uploaded,products=uploaded,customer_prices=uploaded,opening_stock=uploaded,opening_ar=uploaded',
  'through the existing import batches, not validated yet');
select is((select status || '|' || credits_mode || '|' || jsonb_array_length(negative_stock) from api.v_legacy_import_sessions
           where id = pg_temp.sid('s1')), 'open|hold|2', 'the session records the decisions; credits held by default');
select is((pg_temp.start('p62-session-01', pg_temp.batches())) - 'status', jsonb_build_object('session_id', pg_temp.sid('s1'), 'replayed', true),
  'a retried start replays the same session');
select throws_like($$select pg_temp.start('p62-session-01', pg_temp.batches(), '[]')$$, 'CONFLICT%',
  'the same key with another upload is a conflict');
select throws_like($$select pg_temp.start('p62-session-02', pg_temp.batches())$$, 'INVALID_STATE: an old-system import is already open%',
  'one open session at a time');
select is((api.legacy_import_check()) ->> 'open_session_id', pg_temp.sid('s1')::text, 'the gate names the open session');
select tests.clear_authentication();
select ok(exists (select 1 from audit.audit_log where table_schema = 'import' and table_name = 'legacy_sessions'
                  and action = 'INSERT' and record_id = pg_temp.sid('s1')::text), 'the session and its decisions are audited');
select is((select (details ->> 'negative_zero') || '|' || (details ->> 'negative_skip') || '|' || (details ->> 'credits_mode')
           from audit.security_events where event_type = 'legacy_import_started'), '1|1|hold',
  'a security event with counts only');
select ok(not exists (select 1 from audit.security_events e where e.event_type = 'legacy_import_started'
                      and e.details::text ~ '(تجربة|Synthetic|RDT-0301)'),
  'the event carries no names or item codes');

-- ===========================================================================
-- Step order, enforced on the batches
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');
select throws_like(format('select api.import_validate(%L)', pg_temp.step(pg_temp.sid('s1'), 2)),
  'LEGACY_ORDER%', 'products cannot be dry-run before customers are committed');
select throws_like(format('select api.import_validate(%L)', pg_temp.step(pg_temp.sid('s1'), 5)),
  'LEGACY_ORDER%', 'nor can opening AR');
select is(api.import_validate(pg_temp.step(pg_temp.sid('s1'), 1)) ->> 'status', 'validated', 'step 1 customers: dry run');
select throws_like(format('select api.import_validate(%L)', pg_temp.step(pg_temp.sid('s1'), 2)),
  'LEGACY_ORDER%', 'a validated step 1 is not enough: it must be committed');
select is(api.import_commit(pg_temp.step(pg_temp.sid('s1'), 1)) ->> 'status', 'committed', 'step 1 customers: commit');
select throws_like(format('select api.legacy_import_restage(%L, 1, %L, %L)', pg_temp.sid('s1'),
    (select rows from t_rows where kind = 'customers'), 'p62-restage-001'),
  'ALREADY_COMMITTED%', 'a committed step cannot be restaged');
select throws_like(format('select api.legacy_import_restage(%L, 3, %L, %L)', pg_temp.sid('s1'),
    (select rows from t_rows where kind = 'customer_prices'), 'p62-restage-002'),
  'LEGACY_ORDER%', 'a later step cannot be restaged before the earlier ones are committed');
select is(api.import_validate(pg_temp.step(pg_temp.sid('s1'), 2)) ->> 'status', 'validated', 'step 2 products: dry run once customers committed');
select is(api.import_commit(pg_temp.step(pg_temp.sid('s1'), 2)) -> 'result', '{"products_created": 7, "variants_created": 7}'::jsonb,
  'step 2 products: the negative-stock item fixed to 0 is imported');

-- Restage the current step (prices), e.g. after the owner corrected the workbook.
select pg_temp.keep('old3', pg_temp.step(pg_temp.sid('s1'), 3)::text);
select throws_like(format('select api.legacy_import_restage(%L, 3, %L, %L)', pg_temp.sid('s1'),
    '[{"price_list_code":"DEFAULT","sku":"GEN-0999","unit_price":"10.00"}]', 'p62-restage-003'),
  'LEGACY_DECISION%', 'a restage still honours the skip decision');
select is((api.legacy_import_restage(pg_temp.sid('s1'), 3, (select rows from t_rows where kind = 'customer_prices'), 'p62-restage-004')) ->> 'replayed',
  'false', 'the current step is restaged');
select is((api.legacy_import_restage(pg_temp.sid('s1'), 3, (select rows from t_rows where kind = 'customer_prices'), 'p62-restage-004')) ->> 'replayed',
  'true', 'a retried restage replays');
select is((select b.status from import.batches b where b.id = pg_temp.sid('old3')) || '|'
          || (select restaged_count from api.v_legacy_import_steps where session_id = pg_temp.sid('s1') and step_no = 3),
  'discarded|1', 'the replaced batch is discarded (its staged rows deleted) and counted');
select is(api.import_validate(pg_temp.step(pg_temp.sid('s1'), 3)) ->> 'status', 'validated', 'step 3 prices: dry run');
select is(api.import_commit(pg_temp.step(pg_temp.sid('s1'), 3)) -> 'result', '{"price_lists_created": 0, "prices_set": 6, "assignments": 0}'::jsonb,
  'step 3 prices: commit');
select is(api.import_validate(pg_temp.step(pg_temp.sid('s1'), 4)) ->> 'status', 'validated', 'step 4 opening stock: dry run');
select is(api.import_commit(pg_temp.step(pg_temp.sid('s1'), 4)) -> 'result',
  '{"receipts_posted": 1, "lines": 4, "units": 38, "cost_unknown_lines": 3}'::jsonb, 'step 4 opening stock: commit');
select is((select status from api.v_legacy_import_sessions where id = pg_temp.sid('s1')), 'open', 'still open before the last step');
select is(api.import_validate(pg_temp.step(pg_temp.sid('s1'), 5)) ->> 'status', 'validated', 'step 5 opening AR: dry run');
select is(api.import_commit(pg_temp.step(pg_temp.sid('s1'), 5)) -> 'result', '{"entries": 2, "total_amount": 1500.50}'::jsonb,
  'step 5 opening AR: the debit balances only');
select is((select status || '|' || (completed_at is not null)::text from api.v_legacy_import_sessions where id = pg_temp.sid('s1')),
  'completed|true', 'the last commit completes the session');
select throws_like(format('select api.legacy_import_abandon(%L)', pg_temp.sid('s1')), 'INVALID_STATE%', 'a completed import cannot be abandoned');
select tests.clear_authentication();

-- What the decisions did
select is((select count(*)::int from inventory.stock_balances b join catalog.product_variants v on v.id = b.variant_id
           where v.sku = 'RDT-0301' and b.on_hand <> 0), 0, '"fix to 0": the item has no stock on hand');
select is((select unit_price from sales.resolve_list_price('40000000-0000-0000-0000-000000000002',
             (select id from catalog.product_variants where sku = 'RDT-0301'), 1)), 160.00::numeric,
  '"fix to 0": but it is in the catalogue with its base price, ready to receive or count');
select is((select count(*)::int from catalog.product_variants where sku = 'GEN-0999'), 0, '"skip": the item is not imported');
select is((select string_agg((d ->> 'sku') || '=' || (d ->> 'decision'), ',' order by d ->> 'sku')
           from import.legacy_sessions s, jsonb_array_elements(s.negative_stock) d where s.id = pg_temp.sid('s1')),
  'GEN-0999=skip,RDT-0301=zero', 'both decisions stay listed on the session');
select is((select count(*)::int from finance.customer_ledger l join integration.external_refs x on x.entity_id = l.customer_id
           where x.provider = 'legacy_pos' and x.external_id = '3' and l.entry_type = 'opening_balance'), 0,
  'the held credit balance was not posted');

-- ===========================================================================
-- Data-quality list: scope
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');
select is((select string_agg(issue || '=' || n, ',' order by issue) from (
             select issue, count(*) as n from api.v_legacy_import_quality where session_id = pg_temp.sid('s1') group by issue) x),
  'cost_unknown=3,location_missing=5,phone_missing=3',
  'the owner sees the session''s customers without phone or pin and the items with unknown cost');
select ok((select bool_and(case entity_type when 'customer' then customer_id is not null and product_id is null
                                            else product_id is not null and customer_id is null end)
           from api.v_legacy_import_quality where session_id = pg_temp.sid('s1')),
  'each row carries the id its link opens (customer or product)');
select tests.clear_authentication();
insert into catalog.product_costs (variant_id, unit_cost, effective_from)
select id, 1500, core.business_date() from catalog.product_variants where sku = 'BIO-0003';
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');
select is((select count(*)::int from api.v_legacy_import_quality where session_id = pg_temp.sid('s1') and issue = 'cost_unknown'), 2,
  'an item leaves the list once its cost is on the catalogue');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is((select count(*)::int from api.v_legacy_import_quality), 0, 'a rep sees nothing (not even their own customers)');
select is((select count(*)::int from api.v_legacy_import_steps), 0, 'nor the steps');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a7');
select is((select count(*)::int from api.v_legacy_import_quality) + (select count(*)::int from api.v_legacy_import_sessions), 0,
  'a non-owner holding admin.import.run sees nothing either');
select tests.clear_authentication();

-- ===========================================================================
-- Credits imported on purpose; abandon
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');
create temp table t_s2 as select pg_temp.start('p62-session-03',
  '{"opening_ar": [{"customer_no":null,"customer_phone":null,"amount":"-300.00","customer_legacy_ref":"3"}]}'::jsonb, '[]', 'import') as r;
select pg_temp.keep('s2', (select r ->> 'session_id' from t_s2));
select is((select string_agg(coalesce(batch_status, 'none'), ',' order by step_no) from api.v_legacy_import_steps where session_id = pg_temp.sid('s2')),
  'none,none,none,none,uploaded', 'steps with nothing to import have no batch');
select is(api.import_validate(pg_temp.step(pg_temp.sid('s2'), 5)) ->> 'status', 'validated', 'empty earlier steps count as done');
select is(api.import_commit(pg_temp.step(pg_temp.sid('s2'), 5)) -> 'result', '{"entries": 1, "total_amount": -300.00}'::jsonb,
  'credits mode import: the credit balance is posted once the owner chose it');
select is((select status from api.v_legacy_import_sessions where id = pg_temp.sid('s2')), 'completed', 'and the session completes');

create temp table t_s3 as select pg_temp.start('p62-session-04',
  jsonb_build_object('products', '[{"product_code":"GEN-0400","brand_code":"GENERIC","category_code":"INSTRUMENT","product_name_en":"Synthetic Probe","sku":"GEN-0400","variant_name_en":"Synthetic Probe","uom":"unit"}]'::jsonb,
                     'customer_prices', '[{"price_list_code":"DEFAULT","sku":"GEN-0400","unit_price":"50.00"}]'::jsonb), '[]') as r;
select pg_temp.keep('s3', (select r ->> 'session_id' from t_s3));
select pg_temp.keep('s3b2', pg_temp.step(pg_temp.sid('s3'), 2)::text);
select is((api.legacy_import_abandon(pg_temp.sid('s3'))) - 'session_id',
  '{"status": "abandoned", "batches_discarded": 2, "replayed": false}'::jsonb, 'the owner abandons an open import');
select is((select count(*)::int from import.rows r join import.legacy_session_steps st on st.batch_id = r.batch_id
           where st.session_id = pg_temp.sid('s3')), 0, 'its staged rows are deleted');
select throws_like(format('select api.import_validate(%L)', pg_temp.sid('s3b2')), 'INVALID_STATE%', 'its batches can no longer run');
select is((api.legacy_import_abandon(pg_temp.sid('s3'))) ->> 'replayed', 'true', 'abandoning twice is a no-op');
select ok((api.legacy_import_check()) ->> 'open_session_id' is null, 'nothing is open any more');
select tests.clear_authentication();

select * from finish();
rollback;
