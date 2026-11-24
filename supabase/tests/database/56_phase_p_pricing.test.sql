-- Phase P step 6: pricing, offers and VAT (migrations 20261125000200 and 20261125000210).
-- Synthetic copies of the real invoice shapes (no real names, numbers or customers):
--   * a package with two bonus lines (kit + abutments free with three implants)
--   * a 46.64 % offer that needs no approval
--   * manual 24 % by a rep (approval) and by a sales manager (direct); 30 % by a manager (owner)
--   * a net price of 2,667.85 typed against a 5,000 list price
--   * an invoice-level discount spread across lines, rounding on the last line
--   * a VAT-0 product next to a 14 % one, and issued invoices that keep their VAT
--   * an expired, untargeted or changed offer refused at submit
begin;
select tests.load_fixture();
select plan(122);

-- ---------------------------------------------------------------------------
-- Synthetic catalogue: implant 5,000 · abutment 1,000 · scan body 600 · surgical kit 9,000 · bur 1,000
-- ---------------------------------------------------------------------------
insert into catalog.products (id, brand_id, category_id, code, name_en)
select v.id::uuid, b.id, c.id, v.code, v.name
from (values ('56100000-0000-0000-0000-000000000001', 'BIONER', 'IMPLANT',    'SYN-IMPL', 'Synthetic implant'),
             ('56100000-0000-0000-0000-000000000002', 'BIONER', 'IMPLANT',    'SYN-ABUT', 'Synthetic abutment'),
             ('56100000-0000-0000-0000-000000000003', 'BIONER', 'IMPLANT',    'SYN-SCAN', 'Synthetic scan body'),
             ('56100000-0000-0000-0000-000000000004', 'BIONER', 'INSTRUMENT', 'SYN-KIT',  'Synthetic surgical kit'),
             ('56100000-0000-0000-0000-000000000005', 'RDT',    'BUR',        'SYN-BUR',  'Synthetic bur')) v(id, brand, cat, code, name)
join catalog.brands b on b.code = v.brand join catalog.categories c on c.code = v.cat;
insert into catalog.product_variants (id, product_id, sku, name_en)
select ('56200000-0000-0000-0000-00000000000' || n)::uuid, ('56100000-0000-0000-0000-00000000000' || n)::uuid, 'SYN-V' || n, 'Synthetic variant ' || n
from generate_series(1, 5) n;
insert into catalog.price_list_items (price_list_id, variant_id, unit_price, min_qty) values
  ('54000000-0000-0000-0000-000000000001', '56200000-0000-0000-0000-000000000001', 5000, 1),
  ('54000000-0000-0000-0000-000000000001', '56200000-0000-0000-0000-000000000002', 1000, 1),
  ('54000000-0000-0000-0000-000000000001', '56200000-0000-0000-0000-000000000003',  600, 1),
  ('54000000-0000-0000-0000-000000000001', '56200000-0000-0000-0000-000000000004', 9000, 1),
  ('54000000-0000-0000-0000-000000000001', '56200000-0000-0000-0000-000000000005', 1000, 1);
insert into inventory.lots (id, variant_id, lot_no, expiry_date)
select ('56500000-0000-0000-0000-00000000000' || n)::uuid, ('56200000-0000-0000-0000-00000000000' || n)::uuid, 'SYN-LOT-' || n, '2031-01-01'
from generate_series(1, 5) n;
insert into inventory.movements (movement_type, warehouse_id, variant_id, lot_id, quantity, source_doc_type)
select 'receipt', '60000000-0000-0000-0000-000000000001', ('56200000-0000-0000-0000-00000000000' || n)::uuid,
       ('56500000-0000-0000-0000-00000000000' || n)::uuid, 50, 'receipt'
from generate_series(1, 5) n;

-- ===========================================================================
-- 1. Catalogue, settings and privileges
-- ===========================================================================
select is((select is_sensitive::text || '|' || supports_limit::text || '|' || requires_mfa::text
           from authz.permissions where code = 'sales.offer.manage'), 'true|false|false',
  'sales.offer.manage is in the catalogue: sensitive, no limit, not MFA-gated');
select is((select count(*)::int from authz.role_permissions where permission_code = 'sales.offer.manage'), 0,
  'no role holds sales.offer.manage explicitly: the owner has it implicitly');
select is((select string_agg(key || '=' || (default_value #>> '{}') || ':' || owner_only, ',' order by key)
           from core.setting_definitions where key like 'sales.discount.%'),
  'sales.discount.limit_mode=per_role:true,sales.discount.manager_max_pct=25:true,sales.discount.rep_max_pct=0:true',
  'the decision-B limits are owner-only settings (mode per_role until the owner switches)');
select ok(not has_function_privilege('authenticated', 'sales.discount_policy()', 'execute')
          and not has_function_privilege('authenticated', 'sales.offer_problem(uuid, uuid, date)', 'execute')
          and not has_function_privilege('authenticated', 'sales.discount_check(numeric, boolean)', 'execute')
          and not has_function_privilege('authenticated', 'sales.order_preview_answer(uuid)', 'execute'),
  'pricing helpers are internal');
select ok(has_function_privilege('authenticated', 'api.upsert_offer(uuid, text, text, text, text, numeric, date, date, jsonb, uuid[], text[], text, int)', 'execute')
          and not has_function_privilege('anon', 'api.upsert_offer(uuid, text, text, text, text, numeric, date, date, jsonb, uuid[], text[], text, int)', 'execute')
          and not has_function_privilege('anon', 'api.preview_order(uuid, jsonb, uuid)', 'execute')
          and not has_function_privilege('anon', 'api.set_product_vat_rate(uuid, numeric, text)', 'execute'),
  'the new commands are for signed-in users only');
select ok((select bool_and(c.relrowsecurity) from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'sales' and c.relname in ('offers', 'offer_items', 'offer_customers')),
  'RLS is on for the offer tables');
select ok(not has_table_privilege('authenticated', 'sales.offers', 'insert, update, delete')
          and not has_table_privilege('authenticated', 'api.v_offers', 'insert, update, delete')
          and not has_table_privilege('anon', 'api.v_offers', 'select'),
  'offers are written only through commands');

-- ===========================================================================
-- 2. Offers (owner-defined)
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a2');
select throws_like($$select api.upsert_offer('56300000-0000-0000-0000-000000000001', 'PKG-3', 'Three implants package', null,
  'package', 12000, core.business_date() - 1, core.business_date() + 30,
  '[{"variant_id":"56200000-0000-0000-0000-000000000001","quantity":3}]')$$,
  'PERMISSION_DENIED%', 'a sales director cannot define offers');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');
select is((api.upsert_offer('56300000-0000-0000-0000-000000000001', 'pkg-3', 'Three implants package', 'باقة ٣ زرعات',
  'package', 12000, core.business_date() - 1, core.business_date() + 30,
  '[{"variant_id":"56200000-0000-0000-0000-000000000001","quantity":3},
    {"variant_id":"56200000-0000-0000-0000-000000000004","quantity":1,"is_bonus":true},
    {"variant_id":"56200000-0000-0000-0000-000000000002","quantity":3,"is_bonus":true}]') ->> 'created')::boolean, true,
  'the owner defines a package: 3 implants for 12,000 with a free kit and 3 free abutments');
select is((select code || '|' || pricing_mode || '|' || package_price::text || '|' || version from sales.offers
           where id = '56300000-0000-0000-0000-000000000001'), 'PKG-3|package|12000.00|1', 'the code is normalised to upper case');
select is(api.upsert_offer('56300000-0000-0000-0000-000000000002', 'OFF-4664', 'Implant at 2,668', null,
  'per_line', null, core.business_date(), null,
  '[{"variant_id":"56200000-0000-0000-0000-000000000001","quantity":1,"net_unit_price":2668},
    {"variant_id":"56200000-0000-0000-0000-000000000003","quantity":1,"is_bonus":true}]') ->> 'code', 'OFF-4664',
  'a per-line offer: one implant at a net 2,668 (46.64 %) with a free scan body');
select lives_ok($$select api.upsert_offer('56300000-0000-0000-0000-000000000003', 'TGT-DELTA', 'Delta only', null,
  'per_line', null, core.business_date(), null,
  '[{"variant_id":"56200000-0000-0000-0000-000000000001","quantity":1,"net_unit_price":4000}]',
  array['40000000-0000-0000-0000-000000000002']::uuid[])$$, 'an offer can target named customers');
select lives_ok($$select api.upsert_offer('56300000-0000-0000-0000-000000000004', 'TAG-GOLD', 'Gold tier', null,
  'per_line', null, core.business_date(), null,
  '[{"variant_id":"56200000-0000-0000-0000-000000000001","quantity":1,"net_unit_price":4500}]', null, array['tier:gold'])$$,
  'an offer can target a tier (customer tag)');
select lives_ok($$select api.upsert_offer('56300000-0000-0000-0000-000000000005', 'SHORT', 'Short window', null,
  'per_line', null, core.business_date() - 5, core.business_date() + 5,
  '[{"variant_id":"56200000-0000-0000-0000-000000000001","quantity":1,"net_unit_price":4200}]')$$, 'a short-window offer');

select throws_like($$select api.upsert_offer(gen_random_uuid(), 'BAD-1', 'Bad', null, 'package', 1000, core.business_date(), null,
  '[{"variant_id":"56200000-0000-0000-0000-000000000001","quantity":1,"net_unit_price":900}]')$$,
  'VALIDATION%', 'a package offer has no per-line prices');
select throws_like($$select api.upsert_offer(gen_random_uuid(), 'BAD-2', 'Bad', null, 'per_line', null, core.business_date(), null,
  '[{"variant_id":"56200000-0000-0000-0000-000000000001","quantity":1}]')$$,
  'VALIDATION%', 'a per-line offer needs a net price on every paid line');
select throws_like($$select api.upsert_offer(gen_random_uuid(), 'BAD-3', 'Bad', null, 'package', 1000, core.business_date(), null,
  '[{"variant_id":"56200000-0000-0000-0000-000000000001","quantity":1},{"variant_id":"56200000-0000-0000-0000-000000000001","quantity":2}]')$$,
  'VALIDATION%', 'a variant appears once among paid lines');
select throws_like($$select api.upsert_offer(gen_random_uuid(), 'BAD-4', 'Bad', null, 'package', 1000, core.business_date(), core.business_date() - 1,
  '[{"variant_id":"56200000-0000-0000-0000-000000000001","quantity":1}]')$$,
  'VALIDATION%', 'the window cannot end before it starts');
select throws_like($$select api.upsert_offer(gen_random_uuid(), 'BAD-5', 'Bad', null, 'package', 1000, core.business_date(), null,
  '[{"variant_id":"56200000-0000-0000-0000-000000000002","quantity":1,"is_bonus":true}]')$$,
  'VALIDATION%', 'an offer needs at least one paid line');
select throws_like($$select api.upsert_offer(gen_random_uuid(), 'BAD-6', 'Bad', null, 'per_line', null, core.business_date(), null,
  '[{"variant_id":"56200000-0000-0000-0000-000000000002","quantity":1,"is_bonus":true,"net_unit_price":5}]')$$,
  'VALIDATION%', 'a bonus line has no price');
select throws_like($$select api.upsert_offer(gen_random_uuid(), 'PKG-3', 'Dup', null, 'package', 1000, core.business_date(), null,
  '[{"variant_id":"56200000-0000-0000-0000-000000000001","quantity":1}]')$$,
  'DUPLICATE_CODE%', 'offer codes are unique');
select throws_like($$select api.upsert_offer('56300000-0000-0000-0000-000000000001', 'PKG-3', 'Three implants package', null,
  'package', 12000, core.business_date() - 1, core.business_date() + 30,
  '[{"variant_id":"56200000-0000-0000-0000-000000000001","quantity":3}]', null, null, null, 7)$$,
  'CONFLICT%', 'a stale version is refused');
select is((select count(*)::int from integration.outbox where event_type = 'offer.created'), 5, 'offer.created emitted per new offer');

-- Reads
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is((select string_agg(code, ',' order by code) from api.v_offers where is_current), 'OFF-4664,PKG-3,SHORT,TAG-GOLD,TGT-DELTA',
  'a rep reads the current offers');
select is((select count(*)::int from api.v_offer_customers where offer_id = '56300000-0000-0000-0000-000000000003'), 0,
  'but not the targeted customer outside their scope');
select is((select string_agg(code, ',' order by code) from jsonb_to_recordset(api.eligible_offers('40000000-0000-0000-0000-000000000001')) as x(code text)),
  'OFF-4664,PKG-3,SHORT', 'eligible offers for this customer: untargeted ones only');
select is((select count(*)::int from jsonb_array_elements(api.eligible_offers('40000000-0000-0000-0000-000000000001') -> 0 -> 'items')), 2,
  'each eligible offer carries its items');
select throws_like($$select api.eligible_offers('40000000-0000-0000-0000-000000000002')$$, 'PERMISSION_DENIED%',
  'eligible offers only for a customer in scope');

-- ===========================================================================
-- 3. Default mode (per_role): nothing changes for existing roles
-- ===========================================================================
select is((select api.submit_order(o) ->> 'status' from (
  select (api.save_order_draft('56400000-0000-0000-0000-000000000000', '40000000-0000-0000-0000-000000000001',
          '[{"variant_id":"53000000-0000-0000-0000-000000000001","quantity":1,"requested_discount_pct":2}]') ->> 'order_id')::uuid as o) x),
  'submitted', 'per_role mode: a rep''s 2 % stays within the role''s 3 %');

-- Switch to the decision-B tiers (owner only)
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a7');
select throws_like($$select api.update_setting('sales.discount.limit_mode', '"tiered"')$$, 'OWNER_ONLY%', 'an admin cannot change discount limits');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');
select is(api.update_setting('sales.discount.limit_mode', '"tiered"', 'decision B') ->> 'changed', 'true', 'the owner switches to the decision-B tiers');
select throws_like($$select api.update_setting('sales.discount.manager_max_pct', '120')$$, 'SETTING_OUT_OF_RANGE%', 'a limit is a percentage');

-- ===========================================================================
-- 4. A package with two bonus lines (no approval; stock, invoice and commission base)
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select set_config('t.pkg', api.save_order_draft('56400000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001',
  '[{"offer_id":"56300000-0000-0000-0000-000000000001","quantity":1}]')::text, true);
select is((current_setting('t.pkg')::jsonb ->> 'subtotal')::numeric || '|' || (current_setting('t.pkg')::jsonb ->> 'discount_total')::numeric
          || '|' || (current_setting('t.pkg')::jsonb ->> 'tax_total')::numeric || '|' || (current_setting('t.pkg')::jsonb ->> 'indicative_total')::numeric,
  '15000.00|3000.00|1680.00|13680.00', 'package: 15,000 list − 3,000 = 12,000 + 14 % VAT = 13,680');
select is((select string_agg(line_no || ':' || sku || ':' || quantity || ':' || is_bonus || ':' || list_price::numeric || ':' || line_total::numeric, ',' order by line_no)
           from api.v_order_lines where order_id = '56400000-0000-0000-0000-000000000001'),
  '1:SYN-V1:3:false:5000.00:13680.00,2:SYN-V4:1:true:0.00:0.00,3:SYN-V2:3:true:0.00:0.00',
  'the offer fills the lines: three paid implants, a free kit and three free abutments');
select is((select count(*)::int from api.v_order_lines where order_id = '56400000-0000-0000-0000-000000000001'
           and offer_code = 'PKG-3' and offer_packages = 1), 3, 'every line carries the offer');
select is((select applied_discount_pct::numeric || '|' || manual_discount_pct::numeric from api.v_order_lines
           where order_id = '56400000-0000-0000-0000-000000000001' and line_no = 1), '20.00|0.00',
  'the package discount is 20 %, none of it manual');
select is(api.submit_order('56400000-0000-0000-0000-000000000001') ->> 'status', 'submitted',
  'an offer needs no approval, even for a rep whose own limit is 0 %');
select is(api.save_order_draft('56400000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001',
  '[{"offer_id":"56300000-0000-0000-0000-000000000001","quantity":1}]') ->> 'replayed', 'true',
  'a replay of the offer save is answered as a replay');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a3');
select api.approve_order('56400000-0000-0000-0000-000000000001');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a8');
select is(api.reserve_order('56400000-0000-0000-0000-000000000001', '60000000-0000-0000-0000-000000000001') ->> 'status', 'reserved',
  'the package is reserved');
select is((select string_agg(v.sku || ':' || r.quantity, ',' order by v.sku) from inventory.reservations r
           join sales.order_items oi on oi.id = r.order_item_id join catalog.product_variants v on v.id = oi.variant_id
           where oi.order_id = '56400000-0000-0000-0000-000000000001'),
  'SYN-V1:3,SYN-V2:3,SYN-V4:1', 'bonus lines reserve stock like any line');
select api.post_fulfillment('56400000-0000-0000-0000-000000000001', 'syn-pkg-ful');
select is((select sum(on_hand)::int from inventory.stock_balances where variant_id in
           ('56200000-0000-0000-0000-000000000002', '56200000-0000-0000-0000-000000000004')), 96,
  'fulfilling the bonus lines takes them out of stock (50 + 50 − 3 − 1)');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select set_config('t.inv', api.issue_invoice('56400000-0000-0000-0000-000000000001', 'syn-pkg-inv') ->> 'invoice_id', true);
select is((select total::numeric || '|' || tax_total::numeric from finance.invoices where id = current_setting('t.inv')::uuid), '13680.00|1680.00',
  'the invoice total matches the order');
select is((select string_agg(is_bonus::text || ':' || line_total::numeric, ',' order by is_bonus, line_total) from api.v_invoice_lines
           where invoice_id = current_setting('t.inv')::uuid), 'false:13680.00,true:0.00,true:0.00',
  'the invoice keeps the bonus flag; free lines are 0');
select is((select count(*)::int from finance.invoice_items where invoice_id = current_setting('t.inv')::uuid and line_total > 0), 1,
  'only the paid line is in the commission base (the engine reads line_total > 0)');

-- ===========================================================================
-- 5. A 46.64 % offer needs no approval
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select api.save_order_draft('56400000-0000-0000-0000-000000000002', '40000000-0000-0000-0000-000000000001',
  '[{"offer_id":"56300000-0000-0000-0000-000000000002"}]');
select is((select string_agg(applied_discount_pct::numeric || '/' || line_discount::numeric || '/' || manual_discount_pct::numeric || '/' || is_bonus, ',' order by line_no)
           from api.v_order_lines where order_id = '56400000-0000-0000-0000-000000000002'),
  '46.64/2332.00/0.00/false,0.00/0.00/0.00/true', '5,000 → 2,668 is 46.64 % off, plus the free scan body');
select is(api.submit_order('56400000-0000-0000-0000-000000000002') ->> 'status', 'submitted', 'the 46.64 % offer is submitted without approval');

-- ===========================================================================
-- 6. Manual discounts against the tiers: rep 0 %, sales manager 25 %, owner above
-- ===========================================================================
select api.save_order_draft('56400000-0000-0000-0000-000000000003', '40000000-0000-0000-0000-000000000001',
  '[{"variant_id":"56200000-0000-0000-0000-000000000001","quantity":1,"requested_discount_pct":24}]');
select is(api.submit_order('56400000-0000-0000-0000-000000000003') -> 'reasons', '["discount above limit"]'::jsonb,
  'a rep''s manual 24 % is beyond the rep tier (0 %): it waits for approval');
select tests.clear_authentication();
select is((select (payload ->> 'owner_required') || '|' || (payload -> 'limit_metrics' ->> 'wf.decide.order_discount') || '|' || r.priority
           from wf.approval_requests a join wf.workflow_rules r on r.id = a.rule_id where a.entity_id = '56400000-0000-0000-0000-000000000003'),
  'false|0|100', '24 % is within the manager tier: any sales manager in scope may decide');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a3');
select is(api.decide_approval((select id from wf.approval_requests where entity_id = '56400000-0000-0000-0000-000000000003'), 'approve') ->> 'status',
  'approved', 'the area manager (a sales manager) approves 24 %, above the old 10 % role limit');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a2');
select api.save_order_draft('56400000-0000-0000-0000-000000000004', '40000000-0000-0000-0000-000000000001',
  '[{"variant_id":"56200000-0000-0000-0000-000000000001","quantity":1,"requested_discount_pct":24}]');
select is(api.submit_order('56400000-0000-0000-0000-000000000004') ->> 'status', 'submitted', 'a sales manager gives 24 % directly');

select api.save_order_draft('56400000-0000-0000-0000-000000000005', '40000000-0000-0000-0000-000000000001',
  '[{"variant_id":"56200000-0000-0000-0000-000000000001","quantity":1,"requested_discount_pct":30}]');
select is(api.submit_order('56400000-0000-0000-0000-000000000005') ->> 'status', 'pending_approval', '30 % by a sales manager waits');
select tests.clear_authentication();
select is((select (payload ->> 'owner_required') || '|' || r.priority || '|' || s.approver_type || '|' || ro.code
           from wf.approval_requests a join wf.workflow_rules r on r.id = a.rule_id
           join wf.workflow_stages s on s.rule_id = r.id join authz.roles ro on ro.id = s.approver_role_id
           where a.entity_id = '56400000-0000-0000-0000-000000000005'),
  'true|35|role|owner', 'above the manager tier the request goes to the owner');
select set_config('t.req30', (select id::text from wf.approval_requests where entity_id = '56400000-0000-0000-0000-000000000005'), true);
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a3');
select throws_like($$select api.decide_approval(current_setting('t.req30')::uuid, 'approve')$$,
  'PERMISSION_DENIED%', 'no sales manager can approve 30 %');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');
select is(api.decide_approval((select id from wf.approval_requests where entity_id = '56400000-0000-0000-0000-000000000005'), 'approve') ->> 'status',
  'approved', 'the owner approves 30 %');
select is((select status from sales.orders where id = '56400000-0000-0000-0000-000000000005'), 'approved', 'the order moved on');

-- Credit + owner: finance first, then the owner
select tests.clear_authentication();
update crm.customers set credit_limit = 1000 where id = '40000000-0000-0000-0000-000000000001';
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a2');
select api.save_order_draft('56400000-0000-0000-0000-000000000015', '40000000-0000-0000-0000-000000000001',
  '[{"variant_id":"56200000-0000-0000-0000-000000000001","quantity":1,"requested_discount_pct":30}]');
select is(api.submit_order('56400000-0000-0000-0000-000000000015') -> 'reasons', '["discount above limit", "credit limit"]'::jsonb,
  'discount and credit reasons are both recorded');
select tests.clear_authentication();
select is((select r.priority || '|' || string_agg(s.stage_no || ':' || coalesce(s.approver_permission, s.approver_type), ',' order by s.stage_no)
           from wf.approval_requests a join wf.workflow_rules r on r.id = a.rule_id join wf.workflow_stages s on s.rule_id = r.id
           where a.entity_id = '56400000-0000-0000-0000-000000000015' group by r.priority),
  '30|1:wf.decide.credit_limit,2:role', 'credit and owner: finance, then the owner');
update crm.customers set credit_limit = null where id = '40000000-0000-0000-0000-000000000001';

-- ===========================================================================
-- 7. Net-price entry: 2,667.85 typed against a 5,000 list price
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select set_config('t.net', api.save_order_draft('56400000-0000-0000-0000-000000000006', '40000000-0000-0000-0000-000000000001',
  '[{"variant_id":"56200000-0000-0000-0000-000000000001","quantity":2,"net_unit_price":2667.85}]')::text, true);
select is((select requested_net_price::numeric || '|' || requested_discount_pct::numeric || '|' || applied_discount_pct::numeric
                  || '|' || line_subtotal::numeric || '|' || line_discount::numeric || '|' || line_tax::numeric || '|' || line_total::numeric
           from api.v_order_lines where order_id = '56400000-0000-0000-0000-000000000006'),
  '2667.85|46.64|46.64|10000.00|4664.30|747.00|6082.70',
  'net 2,667.85 → 46.64 % (2 decimals) and an exact discount of 2 × 2,332.15; VAT on 5,335.70');
select is((select (line_subtotal - line_discount) / quantity from sales.order_items where order_id = '56400000-0000-0000-0000-000000000006'),
  2667.85::numeric, 'the net unit price is exactly what the seller typed');
select is((current_setting('t.net')::jsonb ->> 'indicative_total')::numeric, 6082.70::numeric, 'order total 10,000 − 4,664.30 + 747.00');
select is(api.submit_order('56400000-0000-0000-0000-000000000006') ->> 'status', 'pending_approval', '46.64 % typed by a rep needs approval');
select tests.clear_authentication();
select is((select payload ->> 'owner_required' from wf.approval_requests where entity_id = '56400000-0000-0000-0000-000000000006'), 'true',
  'and 46.64 % is above the manager tier: owner');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select throws_like($$select api.save_order_draft(gen_random_uuid(), '40000000-0000-0000-0000-000000000001',
  '[{"variant_id":"56200000-0000-0000-0000-000000000001","quantity":1,"net_unit_price":5000.01}]')$$,
  'NET_PRICE_ABOVE_LIST%', 'a net price above the list price is refused');
select throws_like($$select api.save_order_draft(gen_random_uuid(), '40000000-0000-0000-0000-000000000001',
  '[{"variant_id":"56200000-0000-0000-0000-000000000001","quantity":1,"net_unit_price":2000,"requested_discount_pct":5}]')$$,
  'VALIDATION%', 'a line takes a net price or a discount, not both');
select throws_like($$select api.save_order_draft(gen_random_uuid(), '40000000-0000-0000-0000-000000000001',
  '[{"variant_id":"56200000-0000-0000-0000-000000000001","quantity":1,"net_unit_price":0}]')$$,
  'VALIDATION%', 'a net price of 0 is refused (free items are bonus lines)');
select throws_like($$select api.save_order_draft(gen_random_uuid(), '40000000-0000-0000-0000-000000000001',
  '[{"variant_id":"56200000-0000-0000-0000-000000000001","quantity":1,"net_unit_price":2667.855}]')$$,
  'VALIDATION%', 'a net price has at most 2 decimals');
select throws_like($$select api.save_order_draft(gen_random_uuid(), '40000000-0000-0000-0000-000000000001',
  '[{"variant_id":"56200000-0000-0000-0000-000000000001","quantity":1,"line_total":1}]')$$,
  'VALIDATION: line 1 may only contain%', 'a line still cannot carry a total');

-- ===========================================================================
-- 8. Invoice-level discount spread by value, rounding on the last line
-- ===========================================================================
select set_config('t.inv_disc', api.save_order_draft('56400000-0000-0000-0000-000000000007', '40000000-0000-0000-0000-000000000001',
  '{"lines":[{"variant_id":"53000000-0000-0000-0000-000000000001","quantity":1},
             {"variant_id":"56200000-0000-0000-0000-000000000002","quantity":1},
             {"variant_id":"56200000-0000-0000-0000-000000000005","quantity":1}],
    "invoice_discount_amount":100}')::text, true);
select is((select string_agg(invoice_discount_share::numeric::text, ',' order by line_no) from api.v_order_lines
           where order_id = '56400000-0000-0000-0000-000000000007'), '33.33,33.33,33.34',
  '100 over three lines of 1,000: 33.33, 33.33 and the rounding on the last line');
select is((select (subtotal - discount_total)::numeric || '|' || discount_total::numeric || '|' || invoice_discount_amount::numeric
           from api.v_orders where id = '56400000-0000-0000-0000-000000000007'), '2900.00|100.00|100.00',
  'the net is exactly the gross minus the discount');
select is((current_setting('t.inv_disc')::jsonb ->> 'invoice_discount_amount')::numeric, 100::numeric, 'the draft answer echoes the invoice discount');
select is((select sum(line_subtotal - line_discount)::numeric from sales.order_items where order_id = '56400000-0000-0000-0000-000000000007'),
  2900.00::numeric, 'Σ line nets = order net');
select is((select max(manual_discount_pct)::numeric from sales.order_items where order_id = '56400000-0000-0000-0000-000000000007'),
  3.33::numeric, 'the invoice discount counts as manual (3.33 % of each line)');
select is((api.save_order_draft('56400000-0000-0000-0000-000000000007', '40000000-0000-0000-0000-000000000001',
  '{"lines":[{"variant_id":"53000000-0000-0000-0000-000000000001","quantity":1},
             {"variant_id":"56200000-0000-0000-0000-000000000002","quantity":1},
             {"variant_id":"56200000-0000-0000-0000-000000000005","quantity":1}],
    "invoice_discount_pct":5}', null, null, 1) ->> 'discount_total')::numeric, 150::numeric, 'or as a percentage: 5 % of 3,000');
select is((select string_agg(invoice_discount_share::numeric::text, ',' order by line_no) from sales.order_items
           where order_id = '56400000-0000-0000-0000-000000000007'), '50.00,50.00,50.00', 'spread 50 / 50 / 50');
select is(api.submit_order('56400000-0000-0000-0000-000000000007') ->> 'status', 'pending_approval',
  'a rep''s invoice discount is a manual discount (tier 0 %)');
select throws_like($$select api.save_order_draft(gen_random_uuid(), '40000000-0000-0000-0000-000000000001',
  '{"lines":[{"variant_id":"53000000-0000-0000-0000-000000000001","quantity":1}], "invoice_discount_amount":1000.01}')$$,
  'INVOICE_DISCOUNT_TOO_LARGE%', 'the invoice discount cannot exceed the net');
select throws_like($$select api.save_order_draft(gen_random_uuid(), '40000000-0000-0000-0000-000000000001',
  '{"lines":[{"variant_id":"53000000-0000-0000-0000-000000000001","quantity":1}], "invoice_discount_amount":10, "invoice_discount_pct":1}')$$,
  'VALIDATION%', 'an amount or a percentage, not both');
select throws_like($$select api.save_order_draft(gen_random_uuid(), '40000000-0000-0000-0000-000000000001',
  '{"lines":[{"variant_id":"53000000-0000-0000-0000-000000000001","quantity":1}], "total":10}')$$,
  'VALIDATION%', 'the payload object takes only lines and the invoice discount');

-- ===========================================================================
-- 9. Free items outside an offer need a sales manager
-- ===========================================================================
select api.save_order_draft('56400000-0000-0000-0000-000000000008', '40000000-0000-0000-0000-000000000001',
  '[{"variant_id":"56200000-0000-0000-0000-000000000001","quantity":1},
    {"variant_id":"56200000-0000-0000-0000-000000000002","quantity":1,"is_bonus":true}]');
select is((select list_price::numeric || '|' || line_total::numeric || '|' || is_bonus || '|' || (offer_id is null) from api.v_order_lines
           where order_id = '56400000-0000-0000-0000-000000000008' and line_no = 2), '0.00|0.00|true|true', 'a manual bonus line is free');
select is(api.submit_order('56400000-0000-0000-0000-000000000008') -> 'reasons', '["free item outside an offer"]'::jsonb,
  'a rep''s free item outside an offer waits for approval');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a3');
select is(api.decide_approval((select id from wf.approval_requests where entity_id = '56400000-0000-0000-0000-000000000008'), 'approve') ->> 'status',
  'approved', 'a sales manager approves the free item');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a2');
select api.save_order_draft('56400000-0000-0000-0000-000000000009', '40000000-0000-0000-0000-000000000001',
  '[{"variant_id":"56200000-0000-0000-0000-000000000001","quantity":1},
    {"variant_id":"56200000-0000-0000-0000-000000000002","quantity":1,"is_bonus":true}]');
select is(api.submit_order('56400000-0000-0000-0000-000000000009') ->> 'status', 'submitted', 'a sales manager gives a free item directly');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select throws_like($$select api.save_order_draft(gen_random_uuid(), '40000000-0000-0000-0000-000000000001',
  '[{"variant_id":"56200000-0000-0000-0000-000000000002","quantity":1,"is_bonus":true,"requested_discount_pct":5}]')$$,
  'VALIDATION%', 'a bonus line takes no discount');
select throws_like($$select api.save_order_draft(gen_random_uuid(), '40000000-0000-0000-0000-000000000001',
  '[{"variant_id":"56200000-0000-0000-0000-000000000002","quantity":1,"is_bonus":"yes"}]')$$,
  'VALIDATION%', 'is_bonus is true or false');

-- ===========================================================================
-- 10. VAT per product (owner only) — a VAT-0 product next to a 14 % one
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a8');
select throws_like($$select api.set_product_vat_rate('56100000-0000-0000-0000-000000000005', 0)$$, 'OWNER_ONLY%',
  'the inventory manager manages products but not VAT');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a2');
select throws_like($$select api.set_product_vat_rate('56100000-0000-0000-0000-000000000005', 0)$$, 'OWNER_ONLY%', 'nor does the sales director');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');
select throws_like($$select api.set_product_vat_rate('56100000-0000-0000-0000-000000000005', 101)$$, 'VALIDATION%', 'VAT is 0–100 %');
select throws_like($$select api.set_product_vat_rate('56100000-0000-0000-0000-000000000005', 14.001)$$, 'VALIDATION%', 'with at most 2 decimals');
select throws_like($$select api.set_product_vat_rate(gen_random_uuid(), 14)$$, 'NOT_FOUND%', 'for a known product');
select is((api.set_product_vat_rate('56100000-0000-0000-0000-000000000005', 0, 'synthetic exempt item') ->> 'vat_rate_pct')::numeric, 0::numeric,
  'the owner sets the bur to 0 % VAT');
select is(api.set_product_vat_rate('56100000-0000-0000-0000-000000000005', 0) ->> 'changed', 'false', 'the same rate again is a no-op');
select tests.clear_authentication();
select is((select count(*)::int from audit.audit_log where table_name = 'products' and record_id = '56100000-0000-0000-0000-000000000005'
           and action = 'UPDATE'), 1, 'the change is in the audit log');
select is((select details ->> 'old' || '>' || (details ->> 'new') from audit.security_events where event_type = 'product_vat_changed'),
  '14.00>0', 'and a security event records old and new rate');
select is((select count(*)::int from integration.outbox where event_type = 'product.vat_changed'), 1, 'product.vat_changed emitted');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select set_config('t.vat', api.preview_order('40000000-0000-0000-0000-000000000001',
  '[{"variant_id":"53000000-0000-0000-0000-000000000001","quantity":1},{"variant_id":"56200000-0000-0000-0000-000000000005","quantity":1}]')::text, true);
select is((current_setting('t.vat')::jsonb -> 'vat_groups'),
  '[{"vat": 140.00, "rate": 14.00, "taxable": 1000.00}, {"vat": 0.00, "rate": 0.00, "taxable": 1000.00}]'::jsonb,
  'VAT per rate: 14 % on the implant, 0 % on the bur');
select is((current_setting('t.vat')::jsonb ->> 'total')::numeric || '|' || (current_setting('t.vat')::jsonb ->> 'prices_include_vat'),
  '2140.00|false', 'the preview total, with prices shown before VAT');
select is((select string_agg(tax_rate_pct::numeric || ':' || line_tax::numeric, ',' order by line_no)
           from jsonb_to_recordset(current_setting('t.vat')::jsonb -> 'lines') as x(line_no int, tax_rate_pct numeric, line_tax numeric)),
  '14.00:140.00,0.00:0.00', 'per-line VAT uses each product''s rate');
select is((select count(*)::int from sales.orders where customer_id = '40000000-0000-0000-0000-000000000001' and status = 'draft'
           and id not in (select id from sales.orders where id::text like '56400000%')), 0, 'the preview saved nothing');
select is((current_setting('t.vat')::jsonb -> 'approval' ->> 'needed'), 'false', 'and says no approval is needed');
select is((api.preview_order('40000000-0000-0000-0000-000000000001',
  '[{"variant_id":"56200000-0000-0000-0000-000000000001","quantity":1,"requested_discount_pct":10}]') -> 'approval' -> 'reasons'),
  '["discount above limit"]'::jsonb, 'the preview warns that 10 % needs approval');

-- Issued invoices and submitted orders keep their VAT
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');
select api.set_product_vat_rate('56100000-0000-0000-0000-000000000001', 5, 'synthetic change');
select tests.clear_authentication();
select is((select tax_total::numeric || '|' || total::numeric from finance.invoices where id = current_setting('t.inv')::uuid), '1680.00|13680.00',
  'an issued invoice does not change when the product VAT changes');
select is((select string_agg(tax_rate_pct::numeric || ':' || tax_amount::numeric, ',' order by tax_amount desc) from finance.invoice_items
           where invoice_id = current_setting('t.inv')::uuid and not is_bonus), '14.00:1680.00', 'its lines keep the rate of the issue');
select is((select tax_rate_pct::numeric || ':' || line_tax::numeric from sales.order_items where order_id = '56400000-0000-0000-0000-000000000002'
           and line_no = 1), '14.00:373.52', 'a submitted order keeps its VAT');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is((api.save_order_draft(gen_random_uuid(), '40000000-0000-0000-0000-000000000001',
  '[{"variant_id":"56200000-0000-0000-0000-000000000001","quantity":1}]') ->> 'tax_total')::numeric, 250::numeric,
  'a new draft takes the new rate (5 % of 5,000)');

-- ===========================================================================
-- 11. Offer validity and targeting, re-checked on submit
-- ===========================================================================
select api.save_order_draft('56400000-0000-0000-0000-000000000010', '40000000-0000-0000-0000-000000000001',
  '[{"offer_id":"56300000-0000-0000-0000-000000000005"}]');
select tests.clear_authentication();
update sales.offers set valid_from = core.business_date() - 10, valid_to = core.business_date() - 1
 where id = '56300000-0000-0000-0000-000000000005';
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select throws_like($$select api.submit_order('56400000-0000-0000-0000-000000000010')$$, 'OFFER_EXPIRED%',
  'an offer that ended after the draft was saved is refused at submit');
select throws_like($$select api.save_order_draft(gen_random_uuid(), '40000000-0000-0000-0000-000000000001',
  '[{"offer_id":"56300000-0000-0000-0000-000000000005"}]')$$, 'OFFER_EXPIRED%', 'and at save');
select throws_like($$select api.save_order_draft(gen_random_uuid(), '40000000-0000-0000-0000-000000000001',
  '[{"offer_id":"56300000-0000-0000-0000-000000000003"}]')$$, 'OFFER_NOT_ELIGIBLE%', 'an offer for other customers is refused');
select throws_like($$select api.save_order_draft(gen_random_uuid(), '40000000-0000-0000-0000-000000000001',
  '[{"offer_id":"56300000-0000-0000-0000-000000000004"}]')$$, 'OFFER_NOT_ELIGIBLE%', 'a tier offer needs the tier');
select tests.clear_authentication();
update crm.customers set tags = array['tier:gold'] where id = '40000000-0000-0000-0000-000000000001';
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is((api.save_order_draft('56400000-0000-0000-0000-000000000011', '40000000-0000-0000-0000-000000000001',
  '[{"offer_id":"56300000-0000-0000-0000-000000000004"}]') ->> 'indicative_total')::numeric, 4725::numeric,
  'with the tier tag the offer applies (4,500 + 5 % VAT)');
select throws_like($$select api.save_order_draft(gen_random_uuid(), '40000000-0000-0000-0000-000000000001',
  '[{"offer_id":"56300000-0000-0000-0000-000000000002"},{"offer_id":"56300000-0000-0000-0000-000000000002"}]')$$,
  'VALIDATION%', 'an offer is listed once per order (use its quantity)');
select throws_like($$select api.save_order_draft(gen_random_uuid(), '40000000-0000-0000-0000-000000000001',
  '[{"offer_id":"56300000-0000-0000-0000-0000000000ff"}]')$$, 'NOT_FOUND%', 'an unknown offer is refused');

-- The owner changes an offer after a draft used it
select api.save_order_draft('56400000-0000-0000-0000-000000000012', '40000000-0000-0000-0000-000000000001',
  '[{"offer_id":"56300000-0000-0000-0000-000000000002","quantity":2}]');
select is((select string_agg(quantity::text, ',' order by line_no) from sales.order_items where order_id = '56400000-0000-0000-0000-000000000012'),
  '2,2', 'two packages double every line');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');
select is((api.upsert_offer('56300000-0000-0000-0000-000000000002', 'OFF-4664', 'Implant at 2,668', null,
  'per_line', null, core.business_date(), null,
  '[{"variant_id":"56200000-0000-0000-0000-000000000001","quantity":1,"net_unit_price":2668}]', null, null, null, 1) ->> 'version')::int, 2,
  'the owner removes the free scan body (version 2)');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select throws_like($$select api.submit_order('56400000-0000-0000-0000-000000000012')$$, 'OFFER_CHANGED%',
  'a draft built on the old offer must be saved again');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');
select is(api.set_offer_active('56300000-0000-0000-0000-000000000001', false) ->> 'is_active', 'false', 'the owner ends the package');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select throws_like($$select api.save_order_draft(gen_random_uuid(), '40000000-0000-0000-0000-000000000001',
  '[{"offer_id":"56300000-0000-0000-0000-000000000001"}]')$$, 'OFFER_INACTIVE%', 'an ended offer cannot be picked');
select is((select count(*)::int from jsonb_array_elements(api.eligible_offers('40000000-0000-0000-0000-000000000001'))), 2,
  'eligible now: the 46.64 % offer and the gold-tier offer');

-- ===========================================================================
-- 12. Package price above the current list value is capped (never a negative discount)
-- ===========================================================================
select tests.clear_authentication();
update catalog.price_list_items set unit_price = 3000
 where price_list_id = '54000000-0000-0000-0000-000000000001' and variant_id = '56200000-0000-0000-0000-000000000001';
update sales.offers set is_active = true where id = '56300000-0000-0000-0000-000000000001';
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is((api.save_order_draft(gen_random_uuid(), '40000000-0000-0000-0000-000000000001',
  '[{"offer_id":"56300000-0000-0000-0000-000000000001"}]') ->> 'discount_total')::numeric, 0::numeric,
  'list fell to 3 × 3,000 = 9,000 < 12,000: the customer pays the list value, no negative discount');

-- ===========================================================================
-- 12b. A partial invoice of a net-price line takes its discount pro rata from the amount
--      (3 × net 2,667.85 against 5,000; one delivered): exactly 2,667.85 net, not 46.64 % of 5,000
-- ===========================================================================
select tests.clear_authentication();
insert into sales.orders (id, order_no, customer_id, employee_id, status, payment_terms_days, subtotal, discount_total, tax_total, total)
values ('56400000-0000-0000-0000-000000000020', 'SO-SYN-56', '40000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000004',
        'partially_fulfilled', 0, 15000, 6996.45, 1120.50, 9124.05);
insert into sales.order_items (id, order_id, line_no, variant_id, quantity, list_price, requested_discount_pct, applied_discount_pct,
                               tax_rate_pct, line_subtotal, line_discount, line_tax, line_total, fulfilled_qty, requested_net_price, manual_discount_pct)
values ('56410000-0000-0000-0000-000000000020', '56400000-0000-0000-0000-000000000020', 1, '56200000-0000-0000-0000-000000000001', 3, 5000,
        46.64, 46.64, 14, 15000, 6996.45, 1120.50, 9124.05, 1, 2667.85, 46.64);
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select set_config('t.part', api.issue_invoice('56400000-0000-0000-0000-000000000020', 'syn-part-inv') ->> 'invoice_id', true);
select is((select discount::numeric || '|' || (line_subtotal - discount)::numeric || '|' || tax_amount::numeric
           from finance.invoice_items where invoice_id = current_setting('t.part')::uuid), '2332.15|2667.85|373.50',
  'one of three net-price units is invoiced at exactly 2,667.85 + 14 % VAT');
select is((select total::numeric from finance.invoices where id = current_setting('t.part')::uuid), 3041.35::numeric,
  'invoice total 2,667.85 + 373.50');

-- ===========================================================================
-- 13. Old payloads keep working
-- ===========================================================================
select is((select line_no || ':' || is_bonus || ':' || coalesce(offer_id::text, '-') || ':' || coalesce(requested_net_price::text, '-')
           from api.v_order_lines where order_id = '56400000-0000-0000-0000-000000000000'), '1:false:-:-',
  'a line saved with the old array payload has the new columns at their defaults');
select is((select count(*)::int from sales.order_items where is_bonus and offer_id is null and line_total <> 0), 0,
  'no bonus line ever carries a value');

select * from finish();
rollback;
