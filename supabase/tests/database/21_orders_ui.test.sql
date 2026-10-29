-- Orders UI read views (20261030000300_orders_ui_views.sql) and the contracts the UI relies on:
-- the builder sends only variant ids + quantities and reads every price back from the server;
-- the UI's status machine (src/modules/orders/logic.ts) matches sales.order_transitions.
begin;
select tests.load_fixture();
select plan(21);

-- ---------------------------------------------------------------------------
-- View hygiene
-- ---------------------------------------------------------------------------
select ok((select coalesce(c.reloptions @> array['security_invoker=true'], false) from pg_class c
           where c.oid = 'api.v_sellable_variants'::regclass), 'v_sellable_variants is security_invoker');
select ok((select coalesce(c.reloptions @> array['security_invoker=true'], false) from pg_class c
           where c.oid = 'api.v_order_status_history'::regclass), 'v_order_status_history is security_invoker');
select ok(not has_table_privilege('authenticated', 'api.v_sellable_variants', 'insert, update, delete'),
  'authenticated cannot write through v_sellable_variants');
select ok(not has_table_privilege('authenticated', 'api.v_order_status_history', 'insert, update, delete'),
  'authenticated cannot write through v_order_status_history');
select ok(not has_table_privilege('anon', 'api.v_sellable_variants', 'select')
          and not has_table_privilege('anon', 'api.v_order_status_history', 'select'), 'anon cannot read either view');
select ok(not exists (select 1 from information_schema.columns
                      where table_schema = 'api' and table_name = 'v_sellable_variants'
                        and column_name ~ '(price|cost)'), 'the variant listing carries no price or cost column');

-- ---------------------------------------------------------------------------
-- Sellable variants
-- ---------------------------------------------------------------------------
insert into catalog.product_variants (id, product_id, sku, name_en, status) values
  ('53000000-0000-0000-0000-0000000000d1', '52000000-0000-0000-0000-000000000001', 'BIO-TOP-OLD', 'Top DM discontinued', 'discontinued');
insert into catalog.products (id, brand_id, category_id, code, name_en, status)
  select '52000000-0000-0000-0000-0000000000d2', brand_id, category_id, 'BIO-DRAFT', 'Draft product', 'draft'
  from catalog.products where id = '52000000-0000-0000-0000-000000000001';
insert into catalog.product_variants (id, product_id, sku, name_en) values
  ('53000000-0000-0000-0000-0000000000d2', '52000000-0000-0000-0000-0000000000d2', 'BIO-DRAFT-1', 'Variant of a draft product');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is((select string_agg(sku, ',' order by sku) from api.v_sellable_variants), 'BIO-TOP-4110',
  'rep sees only active variants of active products');
select is((select brand_code || '/' || category_code from api.v_sellable_variants where sku = 'BIO-TOP-4110'), 'BIONER/IMPLANT',
  'brand and category are joined for search and display');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a9');
select is((select count(*)::int from api.v_sellable_variants), 0, 'a login without a profile sees no catalogue');

select tests.authenticate_anon();
select throws_like($$select count(*) from api.v_sellable_variants$$, '%permission denied%', 'anon is refused');
select tests.clear_authentication();

-- ---------------------------------------------------------------------------
-- Builder contract: ids + quantities in, server prices out
-- ---------------------------------------------------------------------------
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is((api.save_order_draft('72000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001',
            '[{"variant_id":"53000000-0000-0000-0000-000000000001","quantity":3}]') ->> 'indicative_total')::numeric,
          3420.00::numeric, 'a draft of ids + quantities is priced by the server (3 × 1000 + 14% VAT)');
select is((select list_price::numeric || '|' || line_total::numeric from api.v_order_lines
           where order_id = '72000000-0000-0000-0000-000000000001'), '1000.00|3420.00',
  'the saved draft''s server prices are readable through v_order_lines');
select throws_like($$select api.save_order_draft('72000000-0000-0000-0000-000000000002', '40000000-0000-0000-0000-000000000001',
            '[{"variant_id":"53000000-0000-0000-0000-0000000000d1","quantity":1}]')$$,
  'NOT_FOUND%', 'a discontinued variant cannot be ordered even by id');
select is(api.submit_order('72000000-0000-0000-0000-000000000001') ->> 'status', 'submitted', 'rep submits the draft');

-- ---------------------------------------------------------------------------
-- Status history
-- ---------------------------------------------------------------------------
select is((select string_agg(coalesce(from_status, '-') || '>' || to_status, ',' order by id)
           from api.v_order_status_history where order_id = '72000000-0000-0000-0000-000000000001'),
  '->draft,draft>submitted', 'rep sees the order''s timeline');
select is((select bool_and(is_mine) and bool_and(changed_by_name_en = 'Rep Cairo') from api.v_order_status_history
           where order_id = '72000000-0000-0000-0000-000000000001'), true, 'rows carry is_mine and the actor''s name');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a5');
select is((select count(*)::int from api.v_order_status_history where order_id = '72000000-0000-0000-0000-000000000001'), 0,
  'another territory''s rep sees no history of the order');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a3');
select is(api.reject_order('72000000-0000-0000-0000-000000000001', 'wrong customer') ->> 'status', 'rejected', 'area manager rejects');
select is((select reason || '|' || (not is_mine)::text || '|' || changed_by_name_en from api.v_order_status_history
           where order_id = '72000000-0000-0000-0000-000000000001' and to_status = 'rejected'),
  'wrong customer|false|Area Mgr Cairo', 'manager sees the rejection with its reason and actor');
select tests.clear_authentication();

-- ---------------------------------------------------------------------------
-- UI status machine == database status machine
-- (mirrors ORDER_TRANSITIONS in src/modules/orders/logic.ts)
-- ---------------------------------------------------------------------------
select is((select string_agg(from_status || '>' || to_status, ',' order by from_status, to_status) from sales.order_transitions),
  'approved>cancelled,approved>reserved,closed>returned,draft>cancelled,draft>pending_approval,draft>submitted,'
  'fulfilled>invoiced,invoiced>closed,invoiced>returned,partially_fulfilled>fulfilled,partially_fulfilled>invoiced,'
  'pending_approval>approved,pending_approval>rejected,reserved>cancelled,reserved>fulfilled,reserved>partially_fulfilled,'
  'submitted>approved,submitted>cancelled,submitted>rejected',
  'sales.order_transitions matches the UI state machine');
select is((select string_agg(m[1], ',') from pg_constraint k
           cross join lateral regexp_matches(pg_get_constraintdef(k.oid), '''([a-z_]+)''', 'g') m
           where k.conrelid = 'sales.orders'::regclass and k.contype = 'c' and pg_get_constraintdef(k.oid) ~ '\mstatus\M'),
  'draft,submitted,pending_approval,approved,rejected,reserved,partially_fulfilled,fulfilled,invoiced,closed,cancelled,returned',
  'sales.orders.status allows exactly the UI''s statuses');

select * from finish();
rollback;
