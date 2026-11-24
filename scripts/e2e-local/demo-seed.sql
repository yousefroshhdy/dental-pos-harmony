-- =============================================================================
-- LOCAL TEST HARNESS ONLY (docs/TESTING.md "Local signed-in stack"). Never apply to a hosted
-- project. Synthetic demo data on top of tests.load_fixture(), so every screen has something
-- to show for the Playwright screenshots (tests/e2e-local). No real data (owner decision A):
-- names are obviously synthetic ("د. تجربة ٣", "Clinic Demo 3"), phones are +2010000000NN,
-- Google place ids are fake strings (lead names never load without a key: "not configured").
--
-- Business data goes through api.* commands as the fixture users (tests.authenticate_as), so
-- the same rules, audit, approvals, notifications and outbox events apply as in the app.
-- Reference/setup rows with no command (product costs, display names of the fixture rows, the
-- Places run results) are written directly as the superuser, as the seed and the tests do.
-- Dates are relative to core.business_date() (Africa/Cairo), so "today" is always today.
-- =============================================================================
\set ON_ERROR_STOP 1
\set QUIET 1
begin;

-- Fixed ids for readability.
\set owner   '''00000000-0000-0000-0000-0000000000a1'''
\set sd      '''00000000-0000-0000-0000-0000000000a2'''
\set am      '''00000000-0000-0000-0000-0000000000a3'''
\set rep1    '''00000000-0000-0000-0000-0000000000a4'''
\set rep2    '''00000000-0000-0000-0000-0000000000a5'''
\set fin     '''00000000-0000-0000-0000-0000000000a6'''
\set inv     '''00000000-0000-0000-0000-0000000000a8'''
\set e_rep1  '''20000000-0000-0000-0000-000000000004'''
\set e_rep2  '''20000000-0000-0000-0000-000000000005'''
\set wh      '''60000000-0000-0000-0000-000000000001'''

-- -----------------------------------------------------------------------------
-- 0. Make the fixture rows obviously synthetic too (setup data, superuser).
-- -----------------------------------------------------------------------------
update crm.customers set doctor_name = 'د. تجربة ١', clinic_name = 'Clinic Demo 1', display_name = 'Clinic Demo 1',
                         phone_primary = '+201000000001'
 where id = '40000000-0000-0000-0000-000000000001';
update crm.customers set doctor_name = 'د. تجربة ٢', clinic_name = 'Clinic Demo 2', display_name = 'Clinic Demo 2',
                         phone_primary = '+201000000002'
 where id = '40000000-0000-0000-0000-000000000002';
update core.employees e set full_name_ar = v.ar, full_name_en = v.en
  from (values ('20000000-0000-0000-0000-000000000001', 'المالك (تجربة)',          'Owner (demo)'),
               ('20000000-0000-0000-0000-000000000002', 'مدير مبيعات تجربة',       'Sales Director Demo'),
               ('20000000-0000-0000-0000-000000000003', 'مدير منطقة تجربة',        'Area Manager Demo'),
               ('20000000-0000-0000-0000-000000000004', 'مندوب تجربة القاهرة',     'Rep Demo Cairo'),
               ('20000000-0000-0000-0000-000000000005', 'مندوب تجربة الدلتا',      'Rep Demo Delta'),
               ('20000000-0000-0000-0000-000000000006', 'محاسب تجربة',             'Finance Demo'),
               ('20000000-0000-0000-0000-000000000007', 'مسؤول نظام تجربة',        'Admin Demo'),
               ('20000000-0000-0000-0000-000000000008', 'أمين مخزن تجربة',         'Inventory Demo'),
               ('20000000-0000-0000-0000-000000000009', 'موظف جديد تجربة',         'New Hire Demo')) v(id, ar, en)
 where e.id = v.id::uuid;
update catalog.products set name_en = 'Top DM implant (demo)', name_ar = 'زرعة توب دي إم (تجربة)'
 where id = '52000000-0000-0000-0000-000000000001';
update catalog.product_variants set name_en = 'Top DM 4.1 x 10 (demo)' where id = '53000000-0000-0000-0000-000000000001';

-- -----------------------------------------------------------------------------
-- 1. Catalogue (inventory manager: products; owner: prices) and costs (setup, superuser)
-- -----------------------------------------------------------------------------
select tests.authenticate_as(:inv);
select api.upsert_product('52000000-0000-0000-0000-0000000000d1', (select id from catalog.brands where code = 'BIONER'),
  (select id from catalog.categories where code = 'IMPLANT'), 'BIO-SCAN', 'Scan body (demo)', 'سكان بودي (تجربة)', null, true, false, false, 'active');
select api.upsert_product('52000000-0000-0000-0000-0000000000d2', (select id from catalog.brands where code = 'DERBY'),
  (select id from catalog.categories where code = 'INSTRUMENT'), 'DER-MIR', 'Mirror handle (demo)', 'مقبض مرآة (تجربة)', null, false, false, false, 'active');
select api.upsert_product('52000000-0000-0000-0000-0000000000d3', (select id from catalog.brands where code = 'DERBY'),
  (select id from catalog.categories where code = 'INSTRUMENT'), 'DER-FOR', 'Extraction forceps (demo)', 'جفت خلع (تجربة)', null, false, false, false, 'active');
select api.upsert_product('52000000-0000-0000-0000-0000000000d4', (select id from catalog.brands where code = 'RDT'),
  (select id from catalog.categories where code = 'BUR'), 'RDT-DIA', 'Diamond bur (demo)', 'سنبلة ماسية (تجربة)', null, true, false, false, 'active');
select api.upsert_variant('53000000-0000-0000-0000-0000000000d1', '52000000-0000-0000-0000-000000000001', 'BIO-TOP-3510', 'Top DM 3.5 x 10 (demo)', '{}', null, 'piece', 5);
select api.upsert_variant('53000000-0000-0000-0000-0000000000d2', '52000000-0000-0000-0000-000000000001', 'BIO-TOP-4112', 'Top DM 4.1 x 12 (demo)', '{}', null, 'piece', 5);
select api.upsert_variant('53000000-0000-0000-0000-0000000000d3', '52000000-0000-0000-0000-0000000000d1', 'BIO-SCAN-01', 'Scan body standard (demo)', '{}', null, 'piece', 3);
select api.upsert_variant('53000000-0000-0000-0000-0000000000d4', '52000000-0000-0000-0000-0000000000d2', 'DER-MIR-05', 'Mirror handle no. 5 (demo)', '{}', null, 'piece', 10);
select api.upsert_variant('53000000-0000-0000-0000-0000000000d5', '52000000-0000-0000-0000-0000000000d3', 'DER-FOR-150', 'Forceps 150 (demo)', '{}', null, 'piece', 4);
select api.upsert_variant('53000000-0000-0000-0000-0000000000d6', '52000000-0000-0000-0000-0000000000d4', 'RDT-DIA-881', 'Diamond bur 881 pack of 5 (demo)', '{}', null, 'pack', 20);
select api.upsert_variant('53000000-0000-0000-0000-0000000000d7', '52000000-0000-0000-0000-0000000000d4', 'RDT-DIA-856', 'Diamond bur 856 pack of 5 (demo)', '{}', null, 'pack', 20);
select tests.clear_authentication();

insert into catalog.product_costs (variant_id, unit_cost, effective_from) values
  ('53000000-0000-0000-0000-0000000000d1', 580, '2026-01-01'), ('53000000-0000-0000-0000-0000000000d2', 620, '2026-01-01'),
  ('53000000-0000-0000-0000-0000000000d3', 150, '2026-01-01'), ('53000000-0000-0000-0000-0000000000d4',  90, '2026-01-01'),
  ('53000000-0000-0000-0000-0000000000d5', 400, '2026-01-01'), ('53000000-0000-0000-0000-0000000000d6', 120, '2026-01-01'),
  ('53000000-0000-0000-0000-0000000000d7', 120, '2026-01-01');

select tests.authenticate_as_aal2(:owner);
select api.set_price_list_item('54000000-0000-0000-0000-000000000001', v.id::uuid, v.price, 1)
  from (values ('53000000-0000-0000-0000-0000000000d1', 950), ('53000000-0000-0000-0000-0000000000d2', 1050),
               ('53000000-0000-0000-0000-0000000000d3', 300), ('53000000-0000-0000-0000-0000000000d4', 180),
               ('53000000-0000-0000-0000-0000000000d5', 750), ('53000000-0000-0000-0000-0000000000d6', 260),
               ('53000000-0000-0000-0000-0000000000d7', 260)) v(id, price);
-- A volume tier: 10+ implants at 900.
select api.set_price_list_item('54000000-0000-0000-0000-000000000001', '53000000-0000-0000-0000-000000000001', 900, 10);
select tests.clear_authentication();

-- -----------------------------------------------------------------------------
-- 2. Stock: two goods receipts into WH-CAI (inventory manager), one left as a draft
-- -----------------------------------------------------------------------------
select tests.authenticate_as(:inv);
select (api.create_goods_receipt(:wh, 'Supplier Demo GmbH', 'SHP-DEMO-001', jsonb_build_array(
  jsonb_build_object('variant_id', '53000000-0000-0000-0000-000000000001', 'lot_no', 'L2026A', 'quantity', 60, 'unit_cost', 600),
  jsonb_build_object('variant_id', '53000000-0000-0000-0000-0000000000d1', 'lot_no', 'DEMO-L01', 'expiry_date', '2031-03-31', 'quantity', 40, 'unit_cost', 580),
  jsonb_build_object('variant_id', '53000000-0000-0000-0000-0000000000d2', 'lot_no', 'DEMO-L02', 'expiry_date', '2031-06-30', 'quantity', 4, 'unit_cost', 620),
  jsonb_build_object('variant_id', '53000000-0000-0000-0000-0000000000d3', 'lot_no', 'DEMO-L03', 'quantity', 25, 'unit_cost', 150),
  jsonb_build_object('variant_id', '53000000-0000-0000-0000-0000000000d4', 'lot_no', 'NO-LOT', 'quantity', 80, 'unit_cost', 90),
  jsonb_build_object('variant_id', '53000000-0000-0000-0000-0000000000d5', 'lot_no', 'NO-LOT', 'quantity', 12, 'unit_cost', 400),
  jsonb_build_object('variant_id', '53000000-0000-0000-0000-0000000000d6', 'lot_no', 'DEMO-B881', 'expiry_date', '2029-12-31', 'quantity', 150, 'unit_cost', 120),
  jsonb_build_object('variant_id', '53000000-0000-0000-0000-0000000000d7', 'lot_no', 'DEMO-B856', 'expiry_date', '2029-12-31', 'quantity', 15, 'unit_cost', 120)))
  ->> 'receipt_id') as grn1 \gset
select api.post_goods_receipt(:'grn1');
select api.create_goods_receipt(:wh, 'Supplier Demo GmbH', 'SHP-DEMO-002', jsonb_build_array(
  jsonb_build_object('variant_id', '53000000-0000-0000-0000-0000000000d6', 'lot_no', 'DEMO-B881B', 'expiry_date', '2030-06-30', 'quantity', 50, 'unit_cost', 118)));
select tests.clear_authentication();

-- -----------------------------------------------------------------------------
-- 3. Customers: 23 more, created by the two reps in their territories (5 without a phone,
--    10 without a location, so the gaps, proposals and map screens have content)
-- -----------------------------------------------------------------------------
select tests.authenticate_as(:rep1);
select (api.create_customer(p_doctor_name => 'د. تجربة ' || n_ar, p_clinic_name => 'Clinic Demo ' || n,
          p_phone_primary => case when n in (6, 11) then null else '+2010000000' || lpad(n::text, 2, '0') end,
          p_governorate_code => 'EG-C', p_city => case when n % 2 = 0 then 'Nasr City' else 'Heliopolis' end,
          p_specialty_code => null, p_address_line => 'Demo street ' || n,
          p_tags => case when n % 4 = 0 then array['gold'] else '{}'::text[] end,
          p_client_ref => ('c0000000-0000-0000-0000-0000000000' || lpad(n::text, 2, '0'))::uuid) ->> 'customer_id')
  from (values (3, '٣'), (4, '٤'), (5, '٥'), (6, '٦'), (7, '٧'), (8, '٨'), (9, '٩'), (10, '١٠'), (11, '١١'), (12, '١٢'),
               (13, '١٣'), (14, '١٤'), (15, '١٥')) v(n, n_ar);
select tests.authenticate_as(:rep2);
select (api.create_customer(p_doctor_name => 'د. تجربة ' || n_ar, p_clinic_name => 'Clinic Demo ' || n,
          p_phone_primary => case when n in (18, 22, 25) then null else '+2010000000' || lpad(n::text, 2, '0') end,
          p_governorate_code => 'EG-DK', p_city => 'Mansoura', p_address_line => 'Demo road ' || n,
          p_client_ref => ('c0000000-0000-0000-0000-0000000000' || lpad(n::text, 2, '0'))::uuid) ->> 'customer_id')
  from (values (16, '١٦'), (17, '١٧'), (18, '١٨'), (19, '١٩'), (20, '٢٠'), (21, '٢١'), (22, '٢٢'), (23, '٢٣'),
               (24, '٢٤'), (25, '٢٥')) v(n, n_ar);
select tests.clear_authentication();

-- Name → id lookups for the rest of the script (psql variables).
select max(id::text) filter (where clinic_name = 'Clinic Demo 1')  as c01, max(id::text) filter (where clinic_name = 'Clinic Demo 2')  as c02,
       max(id::text) filter (where clinic_name = 'Clinic Demo 3')  as c03, max(id::text) filter (where clinic_name = 'Clinic Demo 4')  as c04,
       max(id::text) filter (where clinic_name = 'Clinic Demo 5')  as c05, max(id::text) filter (where clinic_name = 'Clinic Demo 6')  as c06,
       max(id::text) filter (where clinic_name = 'Clinic Demo 7')  as c07, max(id::text) filter (where clinic_name = 'Clinic Demo 8')  as c08,
       max(id::text) filter (where clinic_name = 'Clinic Demo 9')  as c09, max(id::text) filter (where clinic_name = 'Clinic Demo 10') as c10,
       max(id::text) filter (where clinic_name = 'Clinic Demo 11') as c11, max(id::text) filter (where clinic_name = 'Clinic Demo 12') as c12,
       max(id::text) filter (where clinic_name = 'Clinic Demo 13') as c13, max(id::text) filter (where clinic_name = 'Clinic Demo 14') as c14,
       max(id::text) filter (where clinic_name = 'Clinic Demo 15') as c15, max(id::text) filter (where clinic_name = 'Clinic Demo 16') as c16,
       max(id::text) filter (where clinic_name = 'Clinic Demo 17') as c17, max(id::text) filter (where clinic_name = 'Clinic Demo 18') as c18,
       max(id::text) filter (where clinic_name = 'Clinic Demo 19') as c19, max(id::text) filter (where clinic_name = 'Clinic Demo 20') as c20,
       max(id::text) filter (where clinic_name = 'Clinic Demo 21') as c21, max(id::text) filter (where clinic_name = 'Clinic Demo 22') as c22
  from crm.customers \gset

-- Pins for some customers (area manager / sales director verify locations); the rest stay unpinned.
select tests.authenticate_as(:am);
select api.set_customer_location(v.id::uuid, v.lat, v.lng)
  from (values (:'c03', 30.056100, 31.330200), (:'c04', 30.061500, 31.341800), (:'c05', 30.090900, 31.322000),
               (:'c08', 30.052300, 31.347600), (:'c09', 30.087400, 31.338900), (:'c12', 30.072000, 31.351200)) v(id, lat, lng);
select tests.authenticate_as(:sd);
select api.set_customer_location(v.id::uuid, v.lat, v.lng)
  from (values (:'c16', 31.040100, 31.380500), (:'c17', 31.045600, 31.371900), (:'c19', 31.036200, 31.392100)) v(id, lat, lng);
select tests.clear_authentication();

-- -----------------------------------------------------------------------------
-- 4. Offers (owner) and the commission plan (owner activates STD-2026 from the 1st of this
--    month; a second plan stays a draft for the editor)
-- -----------------------------------------------------------------------------
select tests.authenticate_as_aal2(:owner);
select api.upsert_offer('56000000-0000-0000-0000-0000000000d1', 'PKG-DEMO-3', 'Three implants package (demo)', 'باقة ٣ زرعات (تجربة)',
  'package', 2600, core.business_date() - 10, core.business_date() + 45,
  '[{"variant_id":"53000000-0000-0000-0000-000000000001","quantity":3},
    {"variant_id":"53000000-0000-0000-0000-0000000000d3","quantity":1,"is_bonus":true}]',
  null, null, 'Synthetic demo offer');
select api.upsert_offer('56000000-0000-0000-0000-0000000000d2', 'OFF-DEMO-BUR', 'Bur pack price (demo)', 'سعر خاص للسنابل (تجربة)',
  'per_line', null, core.business_date() - 3, null,
  '[{"variant_id":"53000000-0000-0000-0000-0000000000d6","quantity":2,"net_unit_price":230}]',
  null, array['gold'], 'Gold-tagged clinics only');
select api.upsert_offer('56000000-0000-0000-0000-0000000000d3', 'OFF-DEMO-OLD', 'Expired forceps offer (demo)', null,
  'per_line', null, core.business_date() - 60, core.business_date() - 30,
  '[{"variant_id":"53000000-0000-0000-0000-0000000000d5","quantity":1,"net_unit_price":700}]');
select api.activate_commission_plan((select id from perf.commission_plans where code = 'STD-2026'),
  date_trunc('month', core.business_date())::date, true);
select (api.create_commission_plan('DEMO-2027', 'Demo plan 2027 (draft)') ->> 'plan_id') as plan2 \gset
select api.set_commission_rate(:'plan2', 'brand', (select id from catalog.brands where code = 'BIONER'), 4.5,
  core.business_date() + 30, 'Synthetic draft rate', 'demo-plan2-bioner');
select tests.clear_authentication();

-- -----------------------------------------------------------------------------
-- 5. Orders in every status. Reps draft and submit; the area manager (Cairo team) or the
--    sales director accepts; inventory reserves and fulfils; finance invoices.
-- -----------------------------------------------------------------------------
\set v1 '''53000000-0000-0000-0000-000000000001'''
select tests.authenticate_as(:rep1);
select api.save_order_draft(v.id::uuid, v.customer::uuid, v.lines::jsonb, v.notes)
  from (values
    ('d1000000-0000-0000-0000-000000000001', :'c03', '[{"variant_id":"53000000-0000-0000-0000-000000000001","quantity":5,"requested_discount_pct":2},{"variant_id":"53000000-0000-0000-0000-0000000000d6","quantity":2}]', 'Deliver before noon (demo)'),
    ('d1000000-0000-0000-0000-000000000002', :'c04', '[{"variant_id":"53000000-0000-0000-0000-0000000000d1","quantity":3},{"variant_id":"53000000-0000-0000-0000-0000000000d4","quantity":4}]', null),
    ('d1000000-0000-0000-0000-000000000003', :'c05', '[{"variant_id":"53000000-0000-0000-0000-000000000001","quantity":12}]', 'Volume tier demo'),
    ('d1000000-0000-0000-0000-000000000004', :'c08', '[{"variant_id":"53000000-0000-0000-0000-0000000000d5","quantity":2}]', null),
    ('d1000000-0000-0000-0000-000000000005', :'c01', '[{"variant_id":"53000000-0000-0000-0000-0000000000d7","quantity":3},{"variant_id":"53000000-0000-0000-0000-0000000000d3","quantity":1}]', null),
    ('d1000000-0000-0000-0000-000000000006', :'c07', '[{"variant_id":"53000000-0000-0000-0000-0000000000d2","quantity":2}]', null),
    ('d1000000-0000-0000-0000-000000000007', :'c03', '[{"variant_id":"53000000-0000-0000-0000-000000000001","quantity":2,"requested_discount_pct":8}]', 'Asks for 8 % (demo)'),
    ('d1000000-0000-0000-0000-000000000008', :'c09', '[{"variant_id":"53000000-0000-0000-0000-0000000000d4","quantity":6}]', 'Draft, not sent yet'),
    ('d1000000-0000-0000-0000-000000000009', :'c12', '[{"variant_id":"53000000-0000-0000-0000-000000000001","quantity":1,"requested_discount_pct":25}]', 'Asks for 25 % (demo)'),
    ('d1000000-0000-0000-0000-000000000010', :'c04', '[{"variant_id":"53000000-0000-0000-0000-0000000000d5","quantity":1}]', null),
    ('d1000000-0000-0000-0000-000000000015', :'c13', '[{"variant_id":"53000000-0000-0000-0000-0000000000d4","quantity":1}]', 'Cancelled demo')) v(id, customer, lines, notes);
select api.submit_order(v.id::uuid) from (values ('d1000000-0000-0000-0000-000000000001'), ('d1000000-0000-0000-0000-000000000002'),
  ('d1000000-0000-0000-0000-000000000003'), ('d1000000-0000-0000-0000-000000000004'), ('d1000000-0000-0000-0000-000000000005'),
  ('d1000000-0000-0000-0000-000000000006'), ('d1000000-0000-0000-0000-000000000007'), ('d1000000-0000-0000-0000-000000000009'),
  ('d1000000-0000-0000-0000-000000000010')) v(id);
select api.cancel_order('d1000000-0000-0000-0000-000000000015', 'Clinic postponed (demo)');

select tests.authenticate_as(:rep2);
select api.save_order_draft(v.id::uuid, v.customer::uuid, v.lines::jsonb, null)
  from (values
    ('d1000000-0000-0000-0000-000000000011', :'c02', '[{"variant_id":"53000000-0000-0000-0000-000000000001","quantity":2,"requested_discount_pct":5}]'),
    ('d1000000-0000-0000-0000-000000000012', :'c16', '[{"variant_id":"53000000-0000-0000-0000-0000000000d6","quantity":6},{"variant_id":"53000000-0000-0000-0000-0000000000d4","quantity":5}]'),
    ('d1000000-0000-0000-0000-000000000013', :'c17', '[{"variant_id":"53000000-0000-0000-0000-0000000000d1","quantity":1}]'),
    ('d1000000-0000-0000-0000-000000000014', :'c19', '[{"variant_id":"53000000-0000-0000-0000-0000000000d3","quantity":2}]')) v(id, customer, lines);
select api.submit_order(v.id::uuid) from (values ('d1000000-0000-0000-0000-000000000011'), ('d1000000-0000-0000-0000-000000000012'),
  ('d1000000-0000-0000-0000-000000000014')) v(id);

select tests.authenticate_as(:am);
select api.approve_order(v.id::uuid) from (values ('d1000000-0000-0000-0000-000000000001'), ('d1000000-0000-0000-0000-000000000002'),
  ('d1000000-0000-0000-0000-000000000003'), ('d1000000-0000-0000-0000-000000000004'), ('d1000000-0000-0000-0000-000000000005')) v(id);
select api.reject_order('d1000000-0000-0000-0000-000000000010', 'Duplicate of an earlier order (demo)');
select tests.authenticate_as(:sd);
select api.approve_order('d1000000-0000-0000-0000-000000000012');

select tests.authenticate_as(:inv);
select api.reserve_order(v.id::uuid, :wh) from (values ('d1000000-0000-0000-0000-000000000001'), ('d1000000-0000-0000-0000-000000000002'),
  ('d1000000-0000-0000-0000-000000000003'), ('d1000000-0000-0000-0000-000000000004'), ('d1000000-0000-0000-0000-000000000005'),
  ('d1000000-0000-0000-0000-000000000012')) v(id);
select api.post_fulfillment(v.id::uuid, 'demo-ful-' || right(v.id, 2)) from (values ('d1000000-0000-0000-0000-000000000001'),
  ('d1000000-0000-0000-0000-000000000002'), ('d1000000-0000-0000-0000-000000000003'), ('d1000000-0000-0000-0000-000000000004'),
  ('d1000000-0000-0000-0000-000000000012')) v(id);

select tests.authenticate_as(:fin);
select api.issue_invoice(v.id::uuid, 'demo-inv-' || right(v.id, 2)) from (values ('d1000000-0000-0000-0000-000000000001'),
  ('d1000000-0000-0000-0000-000000000002'), ('d1000000-0000-0000-0000-000000000003'), ('d1000000-0000-0000-0000-000000000012')) v(id);
select tests.clear_authentication();

-- -----------------------------------------------------------------------------
-- 6. Payments: the Cairo rep collects cash (finance verifies and allocates FIFO); finance
--    records a bank transfer; one cheque waits for verification.
-- -----------------------------------------------------------------------------
select max(id::text) filter (where order_id = 'd1000000-0000-0000-0000-000000000001') as inv1,
       max(total::text) filter (where order_id = 'd1000000-0000-0000-0000-000000000001') as inv1_total,
       max(id::text) filter (where order_id = 'd1000000-0000-0000-0000-000000000012') as inv12,
       max(total::text) filter (where order_id = 'd1000000-0000-0000-0000-000000000012') as inv12_total
  from finance.invoices \gset
select tests.authenticate_as(:rep1);
select api.record_payment(:'c03', :'inv1_total'::numeric, 'cash', null, now() - interval '2 hours', 'e1000000-0000-0000-0000-000000000001');
select api.record_payment(:'c04', 1500, 'cash', null, now() - interval '1 hour', 'e1000000-0000-0000-0000-000000000002');
select api.record_payment(:'c05', 4000, 'cheque', 'CHQ-DEMO-77', now() - interval '30 minutes', 'e1000000-0000-0000-0000-000000000003',
  core.business_date() + 20);
select tests.authenticate_as(:fin);
select api.confirm_payment(id) from finance.payments where client_ref in ('e1000000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000002');
select api.allocate_payment(id, null, 'demo-alloc-' || right(client_ref::text, 2)) from finance.payments
 where client_ref in ('e1000000-0000-0000-0000-000000000001', 'e1000000-0000-0000-0000-000000000002');
select api.record_payment(:'c16', :'inv12_total'::numeric, 'bank_transfer', 'TRF-DEMO-12', now() - interval '3 hours', 'e1000000-0000-0000-0000-000000000004');
select api.allocate_payment(id, null, 'demo-alloc-04') from finance.payments where client_ref = 'e1000000-0000-0000-0000-000000000004';
select api.calculate_commission_period(core.business_date());
select tests.clear_authentication();

-- -----------------------------------------------------------------------------
-- 7. Field day (today): shifts, route points, planned / in-progress / completed visits,
--    check-ins at unpinned clinics (→ location proposals), one visit exception.
--    Times are spread between the start of the business day (or 3 h ago) and now.
-- -----------------------------------------------------------------------------
select greatest(now() - interval '3 hours',
                (core.business_date()::timestamp at time zone 'Africa/Cairo') + interval '2 minutes')::text as t0,
       ((now() - greatest(now() - interval '3 hours',
                (core.business_date()::timestamp at time zone 'Africa/Cairo') + interval '2 minutes')) / 12)::text as step \gset

select tests.authenticate_as(:rep1);
select api.acknowledge_tracking_notice('2026-10-30.1');
select api.start_shift('e2000000-0000-0000-0000-000000000001', 30.060000, 31.335000, 12, :'t0'::timestamptz);
select api.plan_visits(null, jsonb_build_array(
  jsonb_build_object('customer_id', :'c03', 'date', core.business_date()),
  jsonb_build_object('customer_id', :'c06', 'date', core.business_date()),
  jsonb_build_object('customer_id', :'c07', 'date', core.business_date()),
  jsonb_build_object('customer_id', :'c04', 'date', core.business_date()),
  jsonb_build_object('customer_id', :'c08', 'date', core.business_date()),
  jsonb_build_object('customer_id', :'c09', 'date', core.business_date()),
  jsonb_build_object('customer_id', :'c10', 'date', core.business_date()),
  jsonb_build_object('customer_id', :'c05', 'date', core.business_date() + 1),
  jsonb_build_object('customer_id', :'c12', 'date', core.business_date() + 1),
  jsonb_build_object('customer_id', :'c13', 'date', core.business_date() + 2)),
  'e3000000-0000-0000-0000-000000000001');
select tests.clear_authentication();
select max(id::text) filter (where customer_id = :'c03') as vis03, max(id::text) filter (where customer_id = :'c06') as vis06,
       max(id::text) filter (where customer_id = :'c07') as vis07, max(id::text) filter (where customer_id = :'c04') as vis04
  from field.visits where planned_for = core.business_date() \gset

select tests.authenticate_as(:rep1);
select api.record_location_pings(jsonb_agg(jsonb_build_object('id', ('e2100000-0000-0000-0000-0000000000' || lpad(k::text, 2, '0'))::uuid,
         'lat', 30.0600 - k * 0.0004, 'lng', 31.3350 - k * 0.0006, 'accuracy_m', 15,
         'captured_at', :'t0'::timestamptz + k * (:'step'::interval / 2))))
  from generate_series(1, 12) k;
select api.visit_check_in(:'vis03', :'c03', 30.056150, 31.330250, 9, :'t0'::timestamptz + 1 * :'step'::interval);
select api.visit_check_out(:'vis03', 'order_taken', 'Ordered implants and burs (demo)', 30.056150, 31.330250, 9,
  :'t0'::timestamptz + 3 * :'step'::interval);
select api.visit_check_in(:'vis06', :'c06', 30.058800, 31.336400, 14, :'t0'::timestamptz + 4 * :'step'::interval);
select api.visit_check_out(:'vis06', 'interested', 'Wants a demo kit next week (demo)', 30.058800, 31.336400, 14,
  :'t0'::timestamptz + 6 * :'step'::interval, now() + interval '7 days');
select api.visit_check_in(:'vis07', :'c07', 30.066100, 31.331900, 25, :'t0'::timestamptz + 7 * :'step'::interval);
select api.visit_check_out(:'vis07', 'doctor_unavailable', 'Doctor in surgery (demo)', 30.066100, 31.331900, 25,
  :'t0'::timestamptz + 8 * :'step'::interval);
select api.visit_check_in(:'vis04', :'c04', 30.061550, 31.341850, 8, :'t0'::timestamptz + 10 * :'step'::interval);
select api.request_visit_exception(:'vis06', 'Clinic has no pin yet; GPS fix taken at the door (demo)');

select tests.authenticate_as(:rep2);
select api.acknowledge_tracking_notice('2026-10-30.1');
select api.start_shift('e2000000-0000-0000-0000-000000000002', 31.040000, 31.380000, 10, :'t0'::timestamptz);
select api.plan_visits(null, jsonb_build_array(
  jsonb_build_object('customer_id', :'c16', 'date', core.business_date()),
  jsonb_build_object('customer_id', :'c18', 'date', core.business_date()),
  jsonb_build_object('customer_id', :'c20', 'date', core.business_date()),
  jsonb_build_object('customer_id', :'c17', 'date', core.business_date() + 1)),
  'e3000000-0000-0000-0000-000000000002');
select tests.clear_authentication();
select max(id::text) filter (where customer_id = :'c16') as vis16, max(id::text) filter (where customer_id = :'c18') as vis18
  from field.visits where planned_for = core.business_date() \gset
select tests.authenticate_as(:rep2);
select api.visit_check_in(:'vis16', :'c16', 31.040150, 31.380550, 11, :'t0'::timestamptz + 2 * :'step'::interval);
select api.visit_check_out(:'vis16', 'collection', 'Collected the transfer reference (demo)', 31.040150, 31.380550, 11,
  :'t0'::timestamptz + 4 * :'step'::interval);
select api.visit_check_in(:'vis18', :'c18', 31.043300, 31.384400, 18, :'t0'::timestamptz + 9 * :'step'::interval);
select tests.clear_authentication();

-- -----------------------------------------------------------------------------
-- 8. Leads: the owner sets both reps' base locations (this queues a discovery run); the
--    discovery job's database side (service role) finishes the runs with fake place ids, as
--    the cron would after calling Google Places. Then the Cairo rep works some leads.
-- -----------------------------------------------------------------------------
select tests.authenticate_as_aal2(:owner);
select api.set_employee_base_location(:e_rep1, 'Demo base, Nasr City (synthetic)', 30.060000, 31.335000, 'manual');
select api.set_employee_base_location(:e_rep2, 'Demo base, Mansoura (synthetic)', 31.040000, 31.380000, 'manual', 4);
select tests.clear_authentication();
select max(id::text) filter (where employee_id = :e_rep1) as run1, max(id::text) filter (where employee_id = :e_rep2) as run2
  from crm.lead_discovery_runs where status = 'queued' \gset
set local role service_role;
select service.leads_claim_run(:'run1', true);
select service.leads_finish_run(:'run1', 'done', 24, 3, false, null, (
  select jsonb_agg(jsonb_build_object('place_id', 'ChIJdemoLeadCairo' || lpad(k::text, 4, '0'), 'distance_m', 250 + k * 310,
                                      'lat', 30.0600 + k * 0.0011, 'lng', 31.3350 + k * 0.0013))
    from generate_series(1, 9) k));
select service.leads_claim_run(:'run2', true);
select service.leads_finish_run(:'run2', 'done', 12, 1, false, null, (
  select jsonb_agg(jsonb_build_object('place_id', 'ChIJdemoLeadDelta' || lpad(k::text, 4, '0'), 'distance_m', 400 + k * 450,
                                      'lat', 31.0400 + k * 0.0012, 'lng', 31.3800 + k * 0.0010))
    from generate_series(1, 4) k));
reset role;
select max(id::text) filter (where place_id = 'ChIJdemoLeadCairo0001') as lead1, max(id::text) filter (where place_id = 'ChIJdemoLeadCairo0002') as lead2,
       max(id::text) filter (where place_id = 'ChIJdemoLeadCairo0003') as lead3, max(id::text) filter (where place_id = 'ChIJdemoLeadCairo0004') as lead4
  from crm.leads \gset
select tests.authenticate_as(:rep1);
select api.plan_lead_visit(:'lead1', core.business_date() + 1);
select api.set_lead_status(:'lead2', 'visited');
select api.set_lead_notes(:'lead2', 'Two chairs, interested in burs (demo note)');
select api.set_lead_status(:'lead3', 'not_interested');
select api.convert_lead(:'lead4', 'د. تجربة ٢٦', 'Clinic Demo 26', '+201000000026', null, 'EG-C', 'Nasr City',
  'Converted from a lead (demo)', 'e4000000-0000-0000-0000-000000000001');
select tests.clear_authentication();

-- -----------------------------------------------------------------------------
-- 9. Work, CRM and approvals waiting: tasks, activities, opportunities, a reassignment,
--    an inventory adjustment, a return and a write-off request; KPI targets; a transfer.
-- -----------------------------------------------------------------------------
select tests.authenticate_as(:rep1);
select api.create_task('Call Clinic Demo 7 back about the order (demo)', now() + interval '2 hours', :'c07', 'follow_up', null,
  'e5000000-0000-0000-0000-000000000001');
select api.create_task('Bring the scan body sample (demo)', now() + interval '1 day', :'c05', 'visit_prep', null,
  'e5000000-0000-0000-0000-000000000002');
select api.log_activity(:'c03', 'call', 'Discussed the implant starter kit (demo)');
select api.log_activity(:'c04', 'whatsapp', 'Sent the price list (demo)');
select api.create_opportunity(:'c04', 'Implant starter kit (demo)', 'BIONER', 25000, core.business_date() + 20);
select api.create_opportunity(:'c09', 'Bur subscription (demo)', 'RDT', 6000, core.business_date() + 35);
select api.request_return('d1000000-0000-0000-0000-000000000001', jsonb_build_array(jsonb_build_object(
  'order_item_id', (select id from sales.order_items where order_id = 'd1000000-0000-0000-0000-000000000001'
                     and variant_id = '53000000-0000-0000-0000-0000000000d6'),
  'quantity', 1, 'reason_code', 'damaged')), 'One pack arrived open (demo)', 'e6000000-0000-0000-0000-000000000001');

select tests.authenticate_as(:am);
select api.create_task('Review this week''s plan with the rep (demo)', now() + interval '3 hours', null, 'general', :e_rep1,
  'e5000000-0000-0000-0000-000000000003');
select api.request_customer_reassignment(:'c13', :e_rep2, 'Clinic moved to Mansoura (demo)');

select tests.authenticate_as(:sd);
select api.set_kpi_target('e7000000-0000-0000-0000-000000000001', 'BOOKED_SALES', date_trunc('month', core.business_date())::date,
  (date_trunc('month', core.business_date()) + interval '1 month - 1 day')::date, 150000, :e_rep1);
select api.set_kpi_target('e7000000-0000-0000-0000-000000000002', 'VISITS_COMPLETED', date_trunc('month', core.business_date())::date,
  (date_trunc('month', core.business_date()) + interval '1 month - 1 day')::date, 60, :e_rep1);
select api.set_kpi_target('e7000000-0000-0000-0000-000000000003', 'BOOKED_SALES', date_trunc('month', core.business_date())::date,
  (date_trunc('month', core.business_date()) + interval '1 month - 1 day')::date, 90000, :e_rep2);

select tests.authenticate_as(:inv);
select api.request_inventory_adjustment(:wh, '53000000-0000-0000-0000-0000000000d7',
  (select id from inventory.lots where lot_no = 'DEMO-B856'), -6, 'Damaged in storage (demo count)', 'demo-adj-1');
select tests.authenticate_as_aal2(:owner);
select api.create_warehouse('60000000-0000-0000-0000-0000000000d2', 'WH-DLT', 'Delta demo store', 'branch');
-- Returned goods are received into a quarantine warehouse (docs/VERIFICATION.md, returns lines).
select api.create_warehouse('60000000-0000-0000-0000-0000000000d3', 'WH-QRN', 'Quarantine demo store', 'quarantine');
select tests.authenticate_as(:inv);
select api.create_transfer(:wh, '60000000-0000-0000-0000-0000000000d2', jsonb_build_array(jsonb_build_object(
  'variant_id', '53000000-0000-0000-0000-0000000000d6', 'lot_id', (select id from inventory.lots where lot_no = 'DEMO-B881'), 'quantity', 20)));

select tests.authenticate_as(:fin);
select api.request_invoice_write_off((select id from finance.invoices where order_id = 'd1000000-0000-0000-0000-000000000002'),
  25, 'Rounding difference (demo)', 'demo-wo-1');
select tests.clear_authentication();

-- -----------------------------------------------------------------------------
-- 10. Decision B as on the hosted projects (20261125000290): tiered manual-discount limits
--     (rep 0 %, sales manager up to 25 %, owner above). supabase/seed.sql pins "per_role" for the
--     older suites, and the demo orders above were priced under it; from here on the local stack
--     behaves like staging (docs/VERIFICATION.md, decision-B lines).
-- -----------------------------------------------------------------------------
select tests.authenticate_as_aal2(:owner);
select api.update_setting('sales.discount.limit_mode', '"tiered"', 'Local stack mirrors staging (decision B)');
select tests.clear_authentication();

commit;
