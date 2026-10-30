-- KPI metric functions and dashboard reads (20261031000200_dashboards_kpis.sql).
--   users: a1 owner · a2 sales director (perf.kpi.read all, perf.target.manage) · a3 area mgr
--          Cairo (team: E003, E004, E009) · a4 rep Cairo (E004) · a5 rep Delta (E005, reports
--          to the director) · a6 finance (no perf.kpi.read) · a7 admin
-- A deterministic September 2026 fixture (all synthetic): visits, orders, a fulfilment,
-- invoices, payments, a credit note. Times are Cairo wall-clock (UTC+3 in September).
begin;
select tests.load_fixture();
select plan(108);
set constraints all immediate;

create function pg_temp.cairo(p text) returns timestamptz language sql immutable as $$
  select (p::timestamp at time zone 'Africa/Cairo') $$;
create function pg_temp.kpi(p_code text, p_from date, p_to date, p_emp uuid default null, p_terr uuid default null)
returns numeric language sql as $$
  select value from api.kpi_summary(p_from, p_to, p_emp, p_terr) where kpi_code = p_code $$;
grant execute on all functions in schema pg_temp to authenticated;

-- ---------------------------------------------------------------------------
-- Fixture
-- ---------------------------------------------------------------------------
insert into crm.customers (id, customer_no, clinic_name, display_name, territory_id, lifecycle_stage, created_by, created_at)
values ('40000000-0000-0000-0000-000000000003', 'C-T29', 'Synthetic Clinic 29', 'Synthetic Clinic 29',
        '10000000-0000-0000-0000-000000000003', 'lead', '00000000-0000-0000-0000-0000000000a4', pg_temp.cairo('2026-09-10 09:00'));
insert into crm.customer_assignments (customer_id, employee_id) values
  ('40000000-0000-0000-0000-000000000003', '20000000-0000-0000-0000-000000000004');

insert into catalog.products (id, brand_id, category_id, code, name_en)
select '52000000-0000-0000-0000-0000000029d1', b.id, c.id, 'DRB-T29', 'Synthetic Derby probe'
from catalog.brands b, catalog.categories c where b.code = 'DERBY' and c.code = 'INSTRUMENT';
insert into catalog.product_variants (id, product_id, sku, name_en, reorder_point) values
  ('53000000-0000-0000-0000-0000000029d1', '52000000-0000-0000-0000-0000000029d1', 'DRB-T29-1', 'Synthetic probe', 5);
insert into inventory.lots (id, variant_id, lot_no, expiry_date) values
  ('61000000-0000-0000-0000-0000000029e1', '53000000-0000-0000-0000-000000000001', 'L29EXP', core.business_date() + 30);
insert into inventory.movements (movement_type, warehouse_id, variant_id, lot_id, quantity, source_doc_type) values
  ('receipt', '60000000-0000-0000-0000-000000000001', '53000000-0000-0000-0000-000000000001',
   '61000000-0000-0000-0000-0000000029e1', 3, 'receipt');

-- Visits. E004: V1+V2 same customer and day (counts once), V3 unverified, V4 missed (planned only),
-- V5 at 01:30 Cairo on 1 Sep (still 31 Aug in UTC), V6 at 01:00 Cairo on 1 Oct (30 Sep in UTC),
-- V7 cancelled. E005: V8.
insert into field.visits (id, customer_id, employee_id, planned_for, status, check_in_at, check_out_at, verification_status) values
  ('29a00000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000004','2026-09-10','completed',pg_temp.cairo('2026-09-10 08:00'),pg_temp.cairo('2026-09-10 08:45'),'verified'),
  ('29a00000-0000-0000-0000-000000000002','40000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000004','2026-09-10','completed',pg_temp.cairo('2026-09-10 11:00'),pg_temp.cairo('2026-09-10 11:15'),'out_of_range'),
  ('29a00000-0000-0000-0000-000000000003','40000000-0000-0000-0000-000000000003','20000000-0000-0000-0000-000000000004','2026-09-11','completed',pg_temp.cairo('2026-09-11 09:00'),pg_temp.cairo('2026-09-11 09:30'),'out_of_range'),
  ('29a00000-0000-0000-0000-000000000004','40000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000004','2026-09-12','missed',null,null,'pending'),
  ('29a00000-0000-0000-0000-000000000005','40000000-0000-0000-0000-000000000003','20000000-0000-0000-0000-000000000004','2026-09-01','completed',pg_temp.cairo('2026-09-01 01:30'),pg_temp.cairo('2026-09-01 02:00'),'verified'),
  ('29a00000-0000-0000-0000-000000000006','40000000-0000-0000-0000-000000000003','20000000-0000-0000-0000-000000000004','2026-10-01','completed',pg_temp.cairo('2026-10-01 01:00'),pg_temp.cairo('2026-10-01 01:20'),'verified'),
  ('29a00000-0000-0000-0000-000000000007','40000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000004','2026-09-15','cancelled',null,null,'pending'),
  ('29a00000-0000-0000-0000-000000000008','40000000-0000-0000-0000-000000000002','20000000-0000-0000-0000-000000000005','2026-09-15','completed',pg_temp.cairo('2026-09-15 10:00'),pg_temp.cairo('2026-09-15 11:00'),'verified');

-- Orders. O1 fulfilled; O2 cancelled in the same period (never counts); O3 submitted in August,
-- cancelled 15 Oct after August closed (counts in Aug, reverses in Oct); O4 pending approval;
-- O5 draft; O6 Delta; O7 at 00:30 Cairo on 1 Oct (30 Sep in UTC).
insert into sales.orders (id, order_no, customer_id, employee_id, territory_id, status, subtotal, discount_total, tax_total, total,
                          submitted_at, approved_at, updated_at) values
  ('29b00000-0000-0000-0000-000000000001','SO-T29-1','40000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000004','10000000-0000-0000-0000-000000000003','fulfilled',2000,40,274.40,2234.40,pg_temp.cairo('2026-09-05 10:00'),pg_temp.cairo('2026-09-05 14:00'),pg_temp.cairo('2026-09-07 12:00')),
  ('29b00000-0000-0000-0000-000000000002','SO-T29-2','40000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000004','10000000-0000-0000-0000-000000000003','cancelled',1000,0,140,1140,pg_temp.cairo('2026-09-20 10:00'),null,pg_temp.cairo('2026-09-21 10:00')),
  ('29b00000-0000-0000-0000-000000000003','SO-T29-3','40000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000004','10000000-0000-0000-0000-000000000003','cancelled',800,0,112,912,pg_temp.cairo('2026-08-10 10:00'),null,pg_temp.cairo('2026-10-15 10:00')),
  ('29b00000-0000-0000-0000-000000000004','SO-T29-4','40000000-0000-0000-0000-000000000003','20000000-0000-0000-0000-000000000004','10000000-0000-0000-0000-000000000003','pending_approval',500,0,70,570,pg_temp.cairo('2026-09-25 10:00'),null,pg_temp.cairo('2026-09-25 10:00')),
  ('29b00000-0000-0000-0000-000000000005',null,'40000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000004',null,'draft',300,0,42,342,null,null,pg_temp.cairo('2026-09-26 10:00')),
  ('29b00000-0000-0000-0000-000000000006','SO-T29-6','40000000-0000-0000-0000-000000000002','20000000-0000-0000-0000-000000000005',(select id from core.territories where code = 'DELTA'),'approved',3000,0,420,3420,pg_temp.cairo('2026-09-08 10:00'),pg_temp.cairo('2026-09-09 12:00'),pg_temp.cairo('2026-09-09 12:00')),
  ('29b00000-0000-0000-0000-000000000007','SO-T29-7','40000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000004','10000000-0000-0000-0000-000000000003','submitted',700,0,98,798,pg_temp.cairo('2026-10-01 00:30'),null,pg_temp.cairo('2026-10-01 00:30'));
insert into sales.order_items (id, order_id, line_no, variant_id, quantity, list_price, applied_discount_pct, tax_rate_pct,
                               line_subtotal, line_discount, line_tax, line_total, fulfilled_qty) values
  ('29b10000-0000-0000-0000-000000000001','29b00000-0000-0000-0000-000000000001',1,'53000000-0000-0000-0000-000000000001',2,1000,2,14,2000,40,274.40,2234.40,2),
  ('29b10000-0000-0000-0000-000000000002','29b00000-0000-0000-0000-000000000002',1,'53000000-0000-0000-0000-000000000001',1,1000,0,14,1000,0,140,1140,0),
  ('29b10000-0000-0000-0000-000000000003','29b00000-0000-0000-0000-000000000003',1,'53000000-0000-0000-0000-0000000029d1',1,800,0,14,800,0,112,912,0),
  ('29b10000-0000-0000-0000-000000000004','29b00000-0000-0000-0000-000000000004',1,'53000000-0000-0000-0000-0000000029d1',1,500,0,14,500,0,70,570,0),
  ('29b10000-0000-0000-0000-000000000005','29b00000-0000-0000-0000-000000000005',1,'53000000-0000-0000-0000-000000000001',1,300,0,14,300,0,42,342,0),
  ('29b10000-0000-0000-0000-000000000006','29b00000-0000-0000-0000-000000000006',1,'53000000-0000-0000-0000-000000000001',3,1000,0,14,3000,0,420,3420,0),
  ('29b10000-0000-0000-0000-000000000007','29b00000-0000-0000-0000-000000000007',1,'53000000-0000-0000-0000-0000000029d1',1,700,0,14,700,0,98,798,0);
insert into sales.order_status_history (order_id, from_status, to_status, changed_at) values
  ('29b00000-0000-0000-0000-000000000002','submitted','cancelled',pg_temp.cairo('2026-09-21 10:00')),
  ('29b00000-0000-0000-0000-000000000003','submitted','cancelled',pg_temp.cairo('2026-10-15 10:00'));

insert into sales.fulfillments (id, fulfillment_no, order_id, warehouse_id, status, created_at) values
  ('29c00000-0000-0000-0000-000000000001','FUL-T29-1','29b00000-0000-0000-0000-000000000001','60000000-0000-0000-0000-000000000001','posted',pg_temp.cairo('2026-09-07 12:00'));
insert into sales.fulfillment_items (fulfillment_id, order_item_id, lot_id, quantity) values
  ('29c00000-0000-0000-0000-000000000001','29b10000-0000-0000-0000-000000000001','61000000-0000-0000-0000-000000000001',2);

-- Finance. I1 (O1, Cairo rep) due 21 Sep; I2 (no order → primary rep E005) issued in August.
insert into finance.invoices (id, invoice_no, order_id, customer_id, issue_date, due_date, status, subtotal, discount_total, tax_total, total) values
  ('29d00000-0000-0000-0000-000000000001','INV-T29-1','29b00000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001','2026-09-07','2026-09-21','partially_paid',2000,40,274.40,2234.40),
  ('29d00000-0000-0000-0000-000000000002','INV-T29-2',null,'40000000-0000-0000-0000-000000000002','2026-08-20','2026-09-19','partially_paid',5000,0,700,5700);
insert into finance.invoice_items (invoice_id, variant_id, description, quantity, unit_price, discount, tax_rate_pct, tax_amount, line_total) values
  ('29d00000-0000-0000-0000-000000000001','53000000-0000-0000-0000-000000000001','Synthetic implant',2,1000,40,14,274.40,2234.40),
  ('29d00000-0000-0000-0000-000000000002','53000000-0000-0000-0000-0000000029d1','Synthetic probe',10,500,0,14,700,5700);
insert into finance.payments (id, payment_no, customer_id, collected_by, method, amount, received_at, status) values
  ('29e00000-0000-0000-0000-000000000001','PAY-T29-1','40000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000004','cash',1117.20,pg_temp.cairo('2026-09-15 12:00'),'confirmed'),
  ('29e00000-0000-0000-0000-000000000002','PAY-T29-2','40000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000004','cash',500,pg_temp.cairo('2026-09-16 12:00'),'pending_verification'),
  ('29e00000-0000-0000-0000-000000000003','PAY-T29-3','40000000-0000-0000-0000-000000000002','20000000-0000-0000-0000-000000000005','bank_transfer',2000,pg_temp.cairo('2026-09-20 12:00'),'confirmed'),
  ('29e00000-0000-0000-0000-000000000004','PAY-T29-4','40000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000004','cash',50,pg_temp.cairo('2026-10-01 00:15'),'confirmed');
insert into finance.payment_allocations (payment_id, invoice_id, amount, allocated_at) values
  ('29e00000-0000-0000-0000-000000000001','29d00000-0000-0000-0000-000000000001',1117.20,pg_temp.cairo('2026-09-15 12:00')),
  ('29e00000-0000-0000-0000-000000000003','29d00000-0000-0000-0000-000000000002',2000,pg_temp.cairo('2026-09-20 12:00'));
insert into finance.credit_notes (id, credit_no, invoice_id, customer_id, reason, amount, tax_amount, issue_date) values
  ('29f00000-0000-0000-0000-000000000001','CN-T29-1','29d00000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001','Synthetic return',100,14,'2026-09-25');
insert into finance.customer_ledger (customer_id, entry_type, amount, source_table, source_id, posted_at) values
  ('40000000-0000-0000-0000-000000000001','invoice',2234.40,'finance.invoices','29d00000-0000-0000-0000-000000000001',pg_temp.cairo('2026-09-07 12:00')),
  ('40000000-0000-0000-0000-000000000002','invoice',5700,'finance.invoices','29d00000-0000-0000-0000-000000000002',pg_temp.cairo('2026-08-20 12:00')),
  ('40000000-0000-0000-0000-000000000001','payment',-1117.20,'finance.payments','29e00000-0000-0000-0000-000000000001',pg_temp.cairo('2026-09-15 12:00')),
  ('40000000-0000-0000-0000-000000000002','payment',-2000,'finance.payments','29e00000-0000-0000-0000-000000000003',pg_temp.cairo('2026-09-20 12:00')),
  ('40000000-0000-0000-0000-000000000001','credit_note',-114,'finance.credit_notes','29f00000-0000-0000-0000-000000000001',pg_temp.cairo('2026-09-25 12:00')),
  ('40000000-0000-0000-0000-000000000001','payment',-50,'finance.payments','29e00000-0000-0000-0000-000000000004',pg_temp.cairo('2026-10-01 00:15'));

-- A pending approval about E004 (the context trigger fills subject + territory).
insert into wf.approval_requests (definition_id, entity_type, entity_id, requested_by, payload)
select d.id, 'sales.order', '29b00000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-0000000000a4', '{}'::jsonb
from wf.workflow_definitions d where d.code = 'sales.order.discount';

-- ===========================================================================
-- 1. The rep sees correct numbers for their own scope (September)
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is(pg_temp.kpi('VISITS_PLANNED', '2026-09-01', '2026-09-30'), 4::numeric, 'rep: planned visits = customer-days planned, cancelled excluded');
select is(pg_temp.kpi('VISITS_COMPLETED', '2026-09-01', '2026-09-30'), 3::numeric, 'rep: completed visits count one per customer per day');
select is(pg_temp.kpi('VISITS_VERIFIED_PCT', '2026-09-01', '2026-09-30'), 66.67::numeric, 'rep: verified rate = verified customer-days ÷ completed (2/3)');
select is(pg_temp.kpi('VISIT_AVG_MINUTES', '2026-09-01', '2026-09-30'), 30.0::numeric, 'rep: average check-in → check-out duration (45+15+30+30)/4');
select is(pg_temp.kpi('CUSTOMERS_ADDED', '2026-09-01', '2026-09-30'), 1::numeric, 'rep: customers created by the rep');
select is(pg_temp.kpi('NEW_ACCOUNTS', '2026-09-01', '2026-09-30'), 1::numeric, 'rep: first invoice in the period → new account');
select is(pg_temp.kpi('ORDERS_BOOKED', '2026-09-01', '2026-09-30'), 2::numeric, 'rep: booked orders exclude the cancelled one and the draft');
select is(pg_temp.kpi('BOOKED_SALES', '2026-09-01', '2026-09-30'), 2460.00::numeric, 'rep: booked sales excl. VAT (1960 + 500)');
select is(pg_temp.kpi('APPROVAL_TURNAROUND_HOURS', '2026-09-01', '2026-09-30'), 4.0::numeric, 'rep: approval turnaround in hours');
select is(pg_temp.kpi('SALES_FULFILLED', '2026-09-01', '2026-09-30'), 1960.00::numeric, 'rep: fulfilled value excl. VAT');
select is(pg_temp.kpi('NET_REVENUE', '2026-09-01', '2026-09-30'), 1860.00::numeric, 'rep: net revenue = invoice net − credit note net');
select is(pg_temp.kpi('CASH_COLLECTED', '2026-09-01', '2026-09-30'), 1117.20::numeric, 'rep: only confirmed payments count');
select is(pg_temp.kpi('AR_OPEN', '2026-09-01', '2026-09-30'), 1003.20::numeric, 'rep: open AR at period end (VAT incl.)');
select is(pg_temp.kpi('AR_OVERDUE', '2026-09-01', '2026-09-30'), 1003.20::numeric, 'rep: overdue AR at period end');
select is(pg_temp.kpi('AR_OVERDUE', '2026-09-01', '2026-09-20'), 0::numeric, 'rep: not overdue before the due date');
select is(pg_temp.kpi('PENDING_APPROVALS', '2026-09-01', '2026-09-30'), 1::numeric, 'rep: pending approvals about the rep');
select is((select count(*)::int from api.kpi_summary('2026-09-01', '2026-09-30') where kpi_code = 'STOCK_ALERTS'), 0,
  'rep: no company stock-alert tile');
select is((select detail ->> 'numerator' || '/' || (detail ->> 'denominator') from api.kpi_summary('2026-09-01', '2026-09-30')
           where kpi_code = 'VISITS_VERIFIED_PCT'), '2/3', 'rep: the detail carries the formula inputs');

-- ===========================================================================
-- 2. Scope isolation
-- ===========================================================================
select throws_ok($$select * from api.kpi_summary('2026-09-01', '2026-09-30', '20000000-0000-0000-0000-000000000005')$$,
  '42501', null, 'a rep cannot read a colleague''s figures');
select throws_like($$select * from api.kpi_summary('2026-09-01', '2026-09-30', '20000000-0000-0000-0000-000000000005')$$,
  'PERMISSION_DENIED%', 'the refusal is PERMISSION_DENIED');
select is(pg_temp.kpi('VISITS_COMPLETED', '2026-09-01', '2026-09-30', null, (select id from core.territories where code = 'DELTA')),
  0::numeric, 'a territory filter only narrows the rep''s own scope');
select is((select count(distinct employee_id)::int from api.kpi_team('2026-09-01', '2026-09-30')), 1, 'rep: the team table is just the rep');
select is((select string_agg(customer_no, ',') from api.kpi_overdue_customers('2026-09-30')), 'C-0001', 'rep: only own overdue customers');
select throws_ok($$select * from api.kpi_overdue_customers('2026-09-30', '20000000-0000-0000-0000-000000000005')$$,
  '42501', null, 'nor a colleague''s overdue customers');
select is((select value from api.kpi_breakdown('2026-09-01', '2026-09-30', 'territory') where dimension_code = 'DELTA' and kpi_code = 'BOOKED_SALES'),
  0::numeric, 'rep: the territory breakdown is limited to own scope');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a5');
select is(pg_temp.kpi('VISITS_COMPLETED', '2026-09-01', '2026-09-30'), 1::numeric, 'the Delta rep sees only their visit');
select is(pg_temp.kpi('CASH_COLLECTED', '2026-09-01', '2026-09-30'), 2000.00::numeric, 'and only their collections');
select is(pg_temp.kpi('PENDING_APPROVALS', '2026-09-01', '2026-09-30'), 0::numeric, 'and no approvals about a colleague');
select is(pg_temp.kpi('NEW_ACCOUNTS', '2026-08-01', '2026-08-31'), 1::numeric, 'an invoice without an order is credited to the primary rep');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a3');
select is(pg_temp.kpi('VISITS_COMPLETED', '2026-09-01', '2026-09-30'), 3::numeric, 'area manager: team figures (E004)');
select is(pg_temp.kpi('BOOKED_SALES', '2026-09-01', '2026-09-30', '20000000-0000-0000-0000-000000000004'), 2460.00::numeric,
  'area manager: may filter to a team member');
select throws_ok($$select * from api.kpi_summary('2026-09-01', '2026-09-30', '20000000-0000-0000-0000-000000000005')$$,
  '42501', null, 'area manager: not a rep outside the team');
select is((select string_agg(distinct employee_id::text, ',') from api.kpi_team('2026-09-01', '2026-09-30')),
  '20000000-0000-0000-0000-000000000004', 'area manager: the team table lists the measured team members');
select is((select count(*)::int from api.v_approval_requests where status = 'pending'), 1,
  'area manager: the pending-approvals panel source shows the team request');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select throws_ok($$select * from api.kpi_summary('2026-09-01', '2026-09-30')$$, '42501', null, 'finance (no perf.kpi.read) is refused');
select throws_ok($$select * from api.kpi_team('2026-09-01', '2026-09-30')$$, '42501', null, 'also for the team table');
select throws_ok($$select * from api.kpi_overdue_customers()$$, '42501', null, 'and for overdue customers');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a7');
select throws_ok($$select * from api.kpi_breakdown('2026-09-01', '2026-09-30', 'brand')$$, '42501', null, 'an IT admin is refused');
select tests.authenticate_anon();
select throws_like($$select * from api.kpi_summary('2026-09-01', '2026-09-30')$$, '%permission denied%', 'anon cannot call KPI reads');

-- ===========================================================================
-- 3. Company totals (director, owner), breakdowns, no double counting
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a2');
select is(pg_temp.kpi('VISITS_COMPLETED', '2026-09-01', '2026-09-30'), 4::numeric, 'director: company visits');
select is(pg_temp.kpi('VISITS_VERIFIED_PCT', '2026-09-01', '2026-09-30'), 75.00::numeric, 'director: company verified rate (3/4)');
select is(pg_temp.kpi('ORDERS_BOOKED', '2026-09-01', '2026-09-30'), 3::numeric, 'director: company orders booked');
select is(pg_temp.kpi('BOOKED_SALES', '2026-09-01', '2026-09-30'), 5460.00::numeric, 'director: company booked sales');
select is(pg_temp.kpi('APPROVAL_TURNAROUND_HOURS', '2026-09-01', '2026-09-30'), 15.0::numeric, 'director: average turnaround (4 h, 26 h)');
select is(pg_temp.kpi('NET_REVENUE', '2026-09-01', '2026-09-30'), 1860.00::numeric, 'director: September net revenue');
select is(pg_temp.kpi('NET_REVENUE', '2026-08-01', '2026-08-31'), 5000.00::numeric, 'director: August net revenue');
select is(pg_temp.kpi('CASH_COLLECTED', '2026-09-01', '2026-09-30'), 3117.20::numeric, 'director: company collections');
select is(pg_temp.kpi('AR_OPEN', '2026-09-01', '2026-09-30'), 4703.20::numeric, 'director: company open AR');
select is(pg_temp.kpi('AR_OVERDUE', '2026-09-01', '2026-09-30'), 4703.20::numeric, 'director: company overdue AR');
select is(pg_temp.kpi('AR_OVERDUE', '2026-09-01', '2026-09-20'), 3700.00::numeric, 'director: overdue AR as of 20 Sep (after the 2000 payment)');
select is(pg_temp.kpi('STOCK_ALERTS', '2026-09-01', '2026-09-30'), 2::numeric, 'director: stock alerts = 1 below reorder + 1 lot expiring');
select is(pg_temp.kpi('PENDING_APPROVALS', '2026-09-01', '2026-09-30'), 1::numeric, 'director: company pending approvals');
select is((select sum(value) from api.kpi_team('2026-09-01', '2026-09-30', array['ORDERS_BOOKED'])), 3::numeric,
  'the team rows add up to the company total (no double counting)');
select is((select string_agg(dimension_code || '=' || value, ',' order by dimension_code)
           from api.kpi_breakdown('2026-09-01', '2026-09-30', 'territory') where kpi_code = 'BOOKED_SALES' and value <> 0),
  'CAI-GIZ=2460.00,DELTA=3000.00', 'territory breakdown rolls sub-territories up into their region');
select is((select string_agg(dimension_code || '=' || value, ',' order by dimension_code)
           from api.kpi_breakdown('2026-09-01', '2026-09-30', 'brand') where kpi_code = 'BOOKED_SALES'),
  'BIONER=4960.00,DERBY=500.00,RDT=0.00', 'brand breakdown of booked sales');
select is((select sum(value) from api.kpi_breakdown('2026-09-01', '2026-09-30', 'brand') where kpi_code = 'BOOKED_SALES'),
  5460.00::numeric, 'brand rows add up to the total');
select is((select value from api.kpi_breakdown('2026-09-01', '2026-09-30', 'brand') where kpi_code = 'NET_REVENUE' and dimension_code = 'BIONER'),
  1860.00::numeric, 'brand net revenue spreads the credit note over the invoice lines');
select is((select value from api.kpi_breakdown('2026-08-01', '2026-08-31', 'brand') where kpi_code = 'NET_REVENUE' and dimension_code = 'DERBY'),
  5000.00::numeric, 'brand net revenue in August');
select is((select value from api.kpi_breakdown('2026-09-01', '2026-09-30', 'brand') where kpi_code = 'SALES_FULFILLED' and dimension_code = 'BIONER'),
  1960.00::numeric, 'brand fulfilled value');
select throws_like($$select * from api.kpi_breakdown('2026-09-01', '2026-09-30', 'colour')$$, 'VALIDATION%', 'unknown dimension is refused');
select is((select string_agg(customer_no || '=' || overdue_amount || '/' || days_overdue, ',' order by customer_no)
           from api.kpi_overdue_customers('2026-09-30')), 'C-0001=1003.20/9,C-0002=3700.00/11', 'director: every overdue customer, with days overdue');

-- Cancellations: a cancelled order never counts; a late cancellation reverses in its own period.
select is(pg_temp.kpi('ORDERS_BOOKED', '2026-08-01', '2026-08-31'), 1::numeric, 'O3 counts in August (cancelled only after August closed)');
select is(pg_temp.kpi('BOOKED_SALES', '2026-08-01', '2026-08-31'), 800.00::numeric, 'with its value');
select is(pg_temp.kpi('ORDERS_BOOKED', '2026-10-01', '2026-10-31', '20000000-0000-0000-0000-000000000004'), 0::numeric,
  'October: O7 booked, O3 reversed');
select is(pg_temp.kpi('BOOKED_SALES', '2026-10-01', '2026-10-31', '20000000-0000-0000-0000-000000000004'), -100.00::numeric,
  'October booked sales = 700 − 800');
select is((select count(*)::int from api.kpi_summary('2026-09-01', '2026-09-30', '20000000-0000-0000-0000-000000000004')
           where kpi_code = 'STOCK_ALERTS'), 0, 'no stock alerts on an employee view');
select throws_like($$select * from api.kpi_summary('2026-09-30', '2026-09-01')$$, 'VALIDATION%', 'an inverted period is refused');
select throws_like($$select * from api.kpi_summary('2025-01-01', '2026-09-01')$$, 'VALIDATION%', 'a period over 366 days is refused');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');
select is(pg_temp.kpi('BOOKED_SALES', '2026-09-01', '2026-09-30'), 5460.00::numeric, 'owner: company booked sales');

-- ===========================================================================
-- 4. Cairo-day boundaries (never the session's or UTC's day)
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is(pg_temp.kpi('VISITS_COMPLETED', '2026-09-01', '2026-09-01'), 1::numeric, '01:30 Cairo on 1 Sep (31 Aug UTC) is 1 Sep');
select is(pg_temp.kpi('VISITS_COMPLETED', '2026-09-30', '2026-09-30'), 0::numeric, '01:00 Cairo on 1 Oct (30 Sep UTC) is not 30 Sep');
select is(pg_temp.kpi('VISITS_COMPLETED', '2026-10-01', '2026-10-01'), 1::numeric, '… it is 1 Oct');
select is(pg_temp.kpi('ORDERS_BOOKED', '2026-10-01', '2026-10-01'), 1::numeric, 'an order at 00:30 Cairo on 1 Oct is booked on 1 Oct');
select is(pg_temp.kpi('CASH_COLLECTED', '2026-10-01', '2026-10-01'), 50.00::numeric, 'a payment at 00:15 Cairo on 1 Oct is collected on 1 Oct');
select is(pg_temp.kpi('AR_OPEN', '2026-09-30', '2026-09-30'), 1003.20::numeric, 'AR at the end of 30 Sep excludes that payment');
select set_config('timezone', 'Pacific/Kiritimati', true) is not null as tz_moved;
select is(pg_temp.kpi('VISITS_COMPLETED', '2026-09-01', '2026-09-30'), 3::numeric, 'the session time zone does not move the numbers');
select is(pg_temp.kpi('ORDERS_BOOKED', '2026-09-01', '2026-09-30'), 2::numeric, '… for orders either');
select set_config('timezone', 'UTC', true) is not null as tz_reset;

-- ===========================================================================
-- 5. Targets
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a2');
select is(api.set_kpi_target('29f10000-0000-0000-0000-000000000001', 'VISITS_COMPLETED', '2026-09-01', '2026-09-30', 6,
  p_employee_id => '20000000-0000-0000-0000-000000000004') ->> 'replayed', 'false', 'director sets an employee target');
select is(api.set_kpi_target('29f10000-0000-0000-0000-000000000001', 'VISITS_COMPLETED', '2026-09-01', '2026-09-30', 6,
  p_employee_id => '20000000-0000-0000-0000-000000000004') ->> 'replayed', 'true', 'a retried call is a replay');
select lives_ok($$select api.set_kpi_target('29f10000-0000-0000-0000-000000000002', 'BOOKED_SALES', '2026-09-01', '2026-09-30', 4920,
  p_role_id => (select id from authz.roles where code = 'sales_rep'))$$, 'director sets a role target (per rep)');
select lives_ok($$select api.set_kpi_target('29f10000-0000-0000-0000-000000000003', 'VISITS_VERIFIED_PCT', '2026-09-01', '2026-09-30', 90,
  p_role_id => (select id from authz.roles where code = 'sales_rep'))$$, 'and a percentage target');
select throws_like($$select api.set_kpi_target(gen_random_uuid(), 'VISITS_VERIFIED_PCT', '2026-09-01', '2026-09-30', 120,
  p_role_id => (select id from authz.roles where code = 'sales_rep'))$$, 'VALIDATION%', 'a percentage target above 100 is refused');
select throws_like($$select api.set_kpi_target(gen_random_uuid(), 'VISITS_COMPLETED', '2026-09-01', '2026-09-30', 6)$$,
  'VALIDATION%', 'a target needs exactly one subject');
select throws_like($$select api.set_kpi_target(gen_random_uuid(), 'FOLLOW_UPS_DONE', '2026-09-01', '2026-09-30', 6,
  p_employee_id => '20000000-0000-0000-0000-000000000004')$$, 'INVALID_STATE%', 'a draft KPI takes no target');
select tests.clear_authentication();
select is((select count(*)::int from integration.outbox where event_type = 'kpi_target.set'), 3, 'each new target emits one outbox event');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a2');
select is(pg_temp.kpi('BOOKED_SALES', '2026-09-01', '2026-09-30'), 5460.00::numeric, 'director total unchanged by targets');
select is((select target || '/' || achievement_pct from api.kpi_summary('2026-09-01', '2026-09-30') where kpi_code = 'BOOKED_SALES'),
  '9840.00/55.49', 'company target = the role target for each measured rep; achievement %');
select is((select count(*)::int from api.v_kpi_targets), 3, 'director sees every target');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is((select target || '/' || achievement_pct from api.kpi_summary('2026-09-01', '2026-09-30') where kpi_code = 'VISITS_COMPLETED'),
  '6.00/50.00', 'rep: own target wins and gives achievement');
select is((select target || '/' || achievement_pct from api.kpi_summary('2026-09-01', '2026-09-30') where kpi_code = 'BOOKED_SALES'),
  '4920.00/50.00', 'rep: the role target applies when there is no own target');
select is((select target || '/' || achievement_pct from api.kpi_summary('2026-09-01', '2026-09-15') where kpi_code = 'VISITS_COMPLETED'),
  '3.00/100.00', 'rep: a count target is pro-rated to the selected days');
select is((select target from api.kpi_summary('2026-09-01', '2026-09-15') where kpi_code = 'VISITS_VERIFIED_PCT'),
  90::numeric, 'rep: a percentage target is not pro-rated');
select is((select count(*)::int from api.v_kpi_targets), 1, 'rep sees only their own employee target');
select throws_ok($$select api.set_kpi_target(gen_random_uuid(), 'VISITS_COMPLETED', '2026-09-01', '2026-09-30', 99,
  p_employee_id => '20000000-0000-0000-0000-000000000004')$$, '42501', null, 'a rep cannot set targets');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a3');
select throws_ok($$select api.set_kpi_target(gen_random_uuid(), 'VISITS_COMPLETED', '2026-09-01', '2026-09-30', 99,
  p_employee_id => '20000000-0000-0000-0000-000000000004')$$, '42501', null, 'an area manager without perf.target.manage cannot either');
select is((select target from api.kpi_summary('2026-09-01', '2026-09-30') where kpi_code = 'VISITS_COMPLETED'),
  6::numeric, 'area manager: team target = the measured members'' targets');

-- ===========================================================================
-- 6. Snapshots (service only), finalisation and RLS on results
-- ===========================================================================
select tests.clear_authentication();
select ok(not has_function_privilege('authenticated', 'service.snapshot_kpis(date)', 'execute'), 'clients cannot run snapshots');
select ok(not has_function_privilege('authenticated', 'perf.compute_metric(text, uuid[], uuid[], date, date)', 'execute'),
  'clients cannot call the metric functions directly');
set local role service_role;
select is(service.snapshot_kpis('2026-10-03') ->> 'previous_mode', 'provisional', 'before day 6 the previous month is provisional');
reset role;
select is((select actual_value || '/' || is_final || '/' || (source_snapshot ->> 'source_count') from perf.kpi_results r
           join perf.kpi_definitions d on d.id = r.kpi_id
           where d.code = 'VISITS_COMPLETED' and r.employee_id = '20000000-0000-0000-0000-000000000004' and r.period_start = '2026-09-01'),
  '3.00/false/4', 'snapshot of the rep''s September visits with its source records');
select is((select actual_value from perf.kpi_results r join perf.kpi_definitions d on d.id = r.kpi_id
           where d.code = 'BOOKED_SALES' and r.employee_id is null and r.territory_id is null and r.period_start = '2026-09-01'),
  5460.00::numeric, 'company row');
select is((select target_value || '/' || achievement_pct from perf.kpi_results r join perf.kpi_definitions d on d.id = r.kpi_id
           where d.code = 'VISITS_COMPLETED' and r.employee_id = '20000000-0000-0000-0000-000000000004' and r.period_start = '2026-09-01'),
  '6.00/50.00', 'snapshot stores target and achievement');
set local role service_role;
select is(service.snapshot_kpis('2026-10-07') ->> 'previous_mode', 'finalized', 'after day 5 the previous month is written as final');
reset role;
insert into field.visits (id, customer_id, employee_id, planned_for, status, check_in_at, check_out_at, verification_status) values
  ('29a00000-0000-0000-0000-000000000009','40000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000004','2026-09-20','completed',pg_temp.cairo('2026-09-20 09:00'),pg_temp.cairo('2026-09-20 09:30'),'verified');
set local role service_role;
select is(service.snapshot_kpis('2026-10-08') ->> 'previous_mode', 'skipped', 'a final month is not recomputed');
reset role;
select is((select actual_value || '/' || is_final from perf.kpi_results r join perf.kpi_definitions d on d.id = r.kpi_id
           where d.code = 'VISITS_COMPLETED' and r.employee_id = '20000000-0000-0000-0000-000000000004' and r.period_start = '2026-09-01'),
  '3.00/true', 'final results are frozen after close');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is(pg_temp.kpi('VISITS_COMPLETED', '2026-09-01', '2026-09-30'), 4::numeric, 'live figures still reflect the late visit');
select is((select count(*)::int from perf.kpi_results where employee_id is distinct from '20000000-0000-0000-0000-000000000004'), 0,
  'a rep reads only their own snapshot rows');
select ok((select count(*) from perf.kpi_results) > 0, '… and does read them');

select * from finish();
rollback;
