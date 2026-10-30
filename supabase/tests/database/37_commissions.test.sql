-- Commission engine (20261103000400_commissions.sql): DASHBOARDS.md §3 golden example, partial
-- payments, returns (credit notes) with re-attribution, the 90-day clawback window, goodwill
-- credits, bounced cheque, allocation reversal after close, reassigned customer, mid-period
-- rate change, late events after close, closed-period immutability, adjustments through the
-- workflow, scope, idempotent recalculation and the cron.
--   users: a1 owner · a3 area mgr (manager of a4) · a4 rep Cairo (E004) · a5 rep Delta (E005)
--          · a6 finance officer · a8 inventory manager
--   months: tests.cm(k) = first day of the month k months from the current one (Ma = −4 … M0 = 0)
begin;
select tests.load_fixture();
select plan(100);
set constraints all immediate;

-- ---------------------------------------------------------------------------
-- Helpers (created inside this transaction; rolled back with it)
-- ---------------------------------------------------------------------------
create function tests.cm(k int) returns date language sql stable as $$
  select (date_trunc('month', core.business_date()) + make_interval(months => k))::date $$;
create function tests.cday(k int, d int) returns date language sql stable as $$ select tests.cm(k) + (d - 1) $$;
create function tests.cts(p_day date) returns timestamptz language sql stable as $$
  select (p_day + time '12:00') at time zone 'Africa/Cairo' $$;
create function tests.cid(p_prefix text, n int) returns uuid language sql immutable as $$
  select (p_prefix || '-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid $$;
create function tests.citem(n int, k int) returns uuid language sql immutable as $$ select tests.cid('c3200000', n * 10 + k) $$;

-- An invoiced order of rep E004 for C-0001: implants (k=1), burs (k=2), instruments (k=3) at
-- 1000 each + 14% VAT, no discount.
create function tests.cm_invoice(n int, p_implant int, p_bur int, p_instr int, p_issue date) returns uuid
language plpgsql as $$
declare v_sub numeric := (p_implant + p_bur + p_instr) * 1000; v_tax numeric := (p_implant + p_bur + p_instr) * 140;
        v_inv uuid := tests.cid('c3100000', n); v_q int; k int;
begin
  insert into sales.orders (id, order_no, customer_id, employee_id, status, subtotal, discount_total, tax_total, total)
  values (tests.cid('c3000000', n), 'SO-CM-' || n, '40000000-0000-0000-0000-000000000001',
          '20000000-0000-0000-0000-000000000004', 'invoiced', v_sub, 0, v_tax, v_sub + v_tax);
  insert into finance.invoices (id, invoice_no, order_id, customer_id, issue_date, due_date, status,
                                subtotal, discount_total, tax_total, total)
  values (v_inv, 'INV-CM-' || n, tests.cid('c3000000', n), '40000000-0000-0000-0000-000000000001',
          p_issue, p_issue, 'issued', v_sub, 0, v_tax, v_sub + v_tax);
  for k in 1..3 loop
    v_q := case k when 1 then p_implant when 2 then p_bur else p_instr end;
    continue when v_q = 0;
    insert into finance.invoice_items (id, invoice_id, variant_id, description, quantity, unit_price, discount,
                                       tax_rate_pct, tax_amount, line_total, line_subtotal)
    values (tests.citem(n, k), v_inv,
            case k when 1 then '53000000-0000-0000-0000-000000000001'::uuid
                   when 2 then 'c3700000-0000-0000-0000-0000000000b1'::uuid
                   else 'c3700000-0000-0000-0000-0000000000d1'::uuid end,
            case k when 1 then 'Implant' when 2 then 'Bur' else 'Instrument' end,
            v_q, 1000, 0, 14, v_q * 140, v_q * 1140, v_q * 1000);
  end loop;
  return v_inv;
end $$;

-- A confirmed payment n fully allocated to an invoice at noon Cairo of p_day; returns the allocation.
create function tests.cm_pay(n int, p_invoice uuid, p_amount numeric, p_day date, p_method text default 'bank_transfer')
returns uuid language plpgsql as $$
begin
  insert into finance.payments (id, payment_no, customer_id, method, amount, received_at, cheque_due_date, status, confirmed_at)
  values (tests.cid('c3300000', n), 'PAY-CM-' || n, '40000000-0000-0000-0000-000000000001', p_method, p_amount,
          tests.cts(p_day), case when p_method = 'cheque' then p_day end, 'confirmed', tests.cts(p_day));
  insert into finance.payment_allocations (id, payment_id, invoice_id, amount, allocated_at)
  values (tests.cid('c3400000', n), tests.cid('c3300000', n), p_invoice, p_amount, tests.cts(p_day));
  return tests.cid('c3400000', n);
end $$;

-- Reverse allocation of payment n (bounced cheque or plain reversal) at noon of p_day.
create function tests.cm_reverse(n int, p_day date, p_bounced boolean) returns uuid language plpgsql as $$
begin
  insert into finance.payment_allocations (id, payment_id, invoice_id, amount, reverses_allocation_id, allocated_at, reason)
  select tests.cid('c3400000', n + 500), a.payment_id, a.invoice_id, -a.amount, a.id, tests.cts(p_day), 'test reversal'
  from finance.payment_allocations a where a.id = tests.cid('c3400000', n);
  if p_bounced then
    update finance.payments set status = 'bounced', reversed_at = tests.cts(p_day) where id = tests.cid('c3300000', n);
  end if;
  return tests.cid('c3400000', n + 500);
end $$;

-- Credit note n on an invoice: one line (p_item, quantity 1) or an amount-only note (p_item NULL).
create function tests.cm_credit(n int, p_invoice uuid, p_item uuid, p_amount numeric, p_tax numeric, p_day date)
returns uuid language plpgsql as $$
begin
  insert into finance.credit_notes (id, credit_no, invoice_id, customer_id, reason, amount, tax_amount, issue_date, created_at)
  values (tests.cid('c3500000', n), 'CN-CM-' || n, p_invoice, '40000000-0000-0000-0000-000000000001', 'test return',
          p_amount, p_tax, p_day, tests.cts(p_day));
  if p_item is not null then
    insert into finance.credit_note_items (credit_note_id, invoice_item_id, quantity, amount, tax_amount)
    values (tests.cid('c3500000', n), p_item, 1, p_amount, p_tax);
  end if;
  return tests.cid('c3500000', n);
end $$;

-- Commission of one source document (all its rows).
create function tests.cm_sum(p_source uuid) returns numeric language sql stable as $$
  select coalesce(sum(commission_amount), 0)::numeric from perf.commission_entries where source_id = p_source $$;
create function tests.cm_period_total(k int) returns numeric language sql stable as $$
  select coalesce(sum(e.commission_amount), 0)::numeric from perf.commission_entries e
  join perf.commission_periods p on p.id = e.period_id where p.period_start = tests.cm(k) $$;

-- ---------------------------------------------------------------------------
-- Reference data for the scenarios: plan active, a bur and an instrument product
-- ---------------------------------------------------------------------------
update perf.commission_plans set status = 'active', effective_from = '2000-01-01' where code = 'STD-2026';
insert into catalog.products (id, brand_id, category_id, code, name_en)
select 'c3600000-0000-0000-0000-0000000000b1', b.id, c.id, 'RDT-BUR-CM', 'RDT bur (test)'
from catalog.brands b, catalog.categories c where b.code = 'RDT' and c.code = 'BUR';
insert into catalog.products (id, brand_id, category_id, code, name_en)
select 'c3600000-0000-0000-0000-0000000000d1', b.id, c.id, 'DRB-INS-CM', 'Derby instrument (test)'
from catalog.brands b, catalog.categories c where b.code = 'DERBY' and c.code = 'INSTRUMENT';
insert into catalog.product_variants (id, product_id, sku, name_en) values
  ('c3700000-0000-0000-0000-0000000000b1','c3600000-0000-0000-0000-0000000000b1','RDT-BUR-CM-1','Bur (test)'),
  ('c3700000-0000-0000-0000-0000000000d1','c3600000-0000-0000-0000-0000000000d1','DRB-INS-CM-1','Instrument (test)');

-- Mid-period rate change (effective dating): instruments 1.50% → 2.00% from day 15 of Mc (k = −2).
update perf.commission_plan_rules r set effective_to = tests.cday(-2, 14)
from catalog.categories c where c.id = r.category_id and c.code = 'INSTRUMENT';
insert into perf.commission_plan_rules (plan_id, category_id, rate_pct, priority, effective_from)
select p.id, c.id, 2.00, 50, tests.cday(-2, 15)
from perf.commission_plans p, catalog.categories c where p.code = 'STD-2026' and c.code = 'INSTRUMENT';

-- Rate resolution: most specific wins, effective-dated.
insert into perf.commission_plan_rules (plan_id, brand_id, rate_pct, priority)
select p.id, b.id, 9.00, 10 from perf.commission_plans p, catalog.brands b where p.code = 'STD-2026' and b.code = 'RDT';
select is((select o_rate_pct from perf.commission_rate((select id from perf.commission_plans where code = 'STD-2026'),
            'c3700000-0000-0000-0000-0000000000b1', tests.cday(-1, 1))), 1.50::numeric,
  'a category rule beats a brand rule (BUR 1.50% over RDT 9%)');
select is((select o_rate_pct from perf.commission_rate((select id from perf.commission_plans where code = 'STD-2026'),
            'c3700000-0000-0000-0000-0000000000d1', tests.cday(-2, 14))), 1.50::numeric,
  'the instrument rate on day 14 is the old rule');
select is((select o_rate_pct from perf.commission_rate((select id from perf.commission_plans where code = 'STD-2026'),
            'c3700000-0000-0000-0000-0000000000d1', tests.cday(-2, 15))), 2.00::numeric,
  'the instrument rate from day 15 is the new rule');
insert into perf.commission_plan_rules (id, plan_id, variant_id, rate_pct, priority)
select 'c3800000-0000-0000-0000-000000000001', p.id, '53000000-0000-0000-0000-000000000001', 7.00, 90
from perf.commission_plans p where p.code = 'STD-2026';
select is((select o_rate_pct from perf.commission_rate((select id from perf.commission_plans where code = 'STD-2026'),
            '53000000-0000-0000-0000-000000000001', tests.cday(-1, 1))), 7.00::numeric,
  'a variant rule beats the category rule, whatever its priority');
delete from perf.commission_plan_rules where id = 'c3800000-0000-0000-0000-000000000001';
select is((select perf.commission_plan_for('20000000-0000-0000-0000-000000000004', tests.cday(-1, 1))),
  (select id from perf.commission_plans where code = 'STD-2026'), 'an employee without an assignment gets the active default plan');

-- ===========================================================================
-- 1. Golden test — DASHBOARDS.md §3 worked example, through the real commands (month M0)
--    2 × 1000 implants, 2% discount → net 1960 + 14% VAT = 2234.40; the customer pays half.
-- ===========================================================================
insert into inventory.movements (movement_type, warehouse_id, variant_id, lot_id, quantity, source_doc_type) values
  ('receipt','60000000-0000-0000-0000-000000000001','53000000-0000-0000-0000-000000000001','61000000-0000-0000-0000-000000000001', 10, 'receipt');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select api.save_order_draft('c3000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001',
  '[{"variant_id":"53000000-0000-0000-0000-000000000001","quantity":2,"requested_discount_pct":2}]');
select api.submit_order('c3000000-0000-0000-0000-000000000001');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a3');
select api.approve_order('c3000000-0000-0000-0000-000000000001');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a8');
select api.reserve_order('c3000000-0000-0000-0000-000000000001', '60000000-0000-0000-0000-000000000001');
select api.post_fulfillment('c3000000-0000-0000-0000-000000000001', 'cm-golden-ful');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select is((api.issue_invoice('c3000000-0000-0000-0000-000000000001', 'cm-golden-inv') ->> 'total')::numeric, 2234.40::numeric,
  'golden: invoice total 1960 + 14% VAT = 2234.40');
select api.record_payment('40000000-0000-0000-0000-000000000001', 1117.20, 'bank_transfer', 'golden half 1', null,
  'c3900000-0000-0000-0000-000000000001');
select api.allocate_payment((select id from finance.payments where client_ref = 'c3900000-0000-0000-0000-000000000001'),
  jsonb_build_array(jsonb_build_object('invoice_id', (select id from finance.invoices where order_id = 'c3000000-0000-0000-0000-000000000001'),
                                       'amount', 1117.20)), 'cm-golden-alloc-1');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select throws_ok($$select api.calculate_commission_period(core.business_date())$$, '42501', null,
  'a rep cannot run the commission calculation');
select tests.clear_authentication();

select is((service.commission_calculate(tests.cm(0)) ->> 'changed')::boolean, true, 'golden: the first calculation creates rows');
select is((select (base_amount, rate_pct, commission_amount, entry_kind, employee_id)::text from perf.commission_entries
           where invoice_id = (select id from finance.invoices where order_id = 'c3000000-0000-0000-0000-000000000001')),
  '(980.00,5.00,49.00,collection,20000000-0000-0000-0000-000000000004)',
  'golden: base = 1117.20 ÷ 1.14 = 980.00, commission at 5% = 49.00, to the order''s rep');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select api.record_payment('40000000-0000-0000-0000-000000000001', 1117.20, 'bank_transfer', 'golden half 2', null,
  'c3900000-0000-0000-0000-000000000002');
select api.allocate_payment((select id from finance.payments where client_ref = 'c3900000-0000-0000-0000-000000000002'),
  null, 'cm-golden-alloc-2');
select is((api.calculate_commission_period(core.business_date()) ->> 'inserted')::int, 1,
  'golden: finance recalculates; the second half adds one row');
select tests.clear_authentication();
select is((select (sum(base_amount), sum(commission_amount))::text from perf.commission_entries
           where invoice_id = (select id from finance.invoices where order_id = 'c3000000-0000-0000-0000-000000000001')),
  '(1960.00,98.00)', 'golden: the second half earns another 49.00; the bases add up to the net 1960.00');

-- Idempotent and deterministic recalculation
create temp table golden_ids as select string_agg(id::text, ',' order by id) as ids, max(calc_run_id::text) as runs
  from perf.commission_entries where period_id = (select id from perf.commission_periods where period_start = tests.cm(0));
select is((service.commission_calculate(tests.cm(0)) ->> 'changed')::boolean, false, 'recalculating changes nothing');
select is((select string_agg(id::text, ',' order by id) || '|' || max(calc_run_id::text) from perf.commission_entries
           where period_id = (select id from perf.commission_periods where period_start = tests.cm(0))),
  (select ids || '|' || runs from golden_ids), 'recalculation keeps every row (same ids, same run)');
select is((service.commission_calculate(tests.cm(0)) ->> 'total')::numeric, 98.00::numeric, 'a third run gives the same total');

-- ===========================================================================
-- 2. Scenario data (direct inserts with controlled dates)
-- ===========================================================================
-- S2 partial payments: implant + bur (2280); 570 in Ma, the remaining 1710 in Mb.
select tests.cm_invoice(2, 1, 1, 0, tests.cday(-4, 1));
select tests.cm_pay(21, tests.cid('c3100000', 2), 570, tests.cday(-4, 10));
select tests.cm_pay(22, tests.cid('c3100000', 2), 1710, tests.cday(-3, 5));
-- S3 return within 90 days: implant + bur paid half in Mb, then the implant is credited in full.
select tests.cm_invoice(3, 1, 1, 0, tests.cday(-3, 1));
select tests.cm_pay(31, tests.cid('c3100000', 3), 1140, tests.cday(-3, 3));
select tests.cm_credit(31, tests.cid('c3100000', 3), tests.citem(3, 1), 1000, 140, tests.cday(-3, 20));
-- S4 credit note 91 days after the collection: no clawback. S4b exactly 90 days: clawback.
select tests.cm_invoice(4, 1, 1, 0, tests.cday(-4, 1));
select tests.cm_pay(41, tests.cid('c3100000', 4), 1140, tests.cday(-4, 2));
select tests.cm_credit(41, tests.cid('c3100000', 4), tests.citem(4, 1), 1000, 140, tests.cday(-4, 2) + 91);
select tests.cm_invoice(5, 1, 1, 0, tests.cday(-4, 1));
select tests.cm_pay(51, tests.cid('c3100000', 5), 1140, tests.cday(-4, 2));
select tests.cm_credit(51, tests.cid('c3100000', 5), tests.citem(5, 1), 1000, 140, tests.cday(-4, 2) + 90);
-- S5 bounced cheque: collected on day 28 of Mb, bounced on day 3 of Mc.
select tests.cm_invoice(6, 1, 0, 0, tests.cday(-3, 1));
select tests.cm_pay(61, tests.cid('c3100000', 6), 1140, tests.cday(-3, 28), 'cheque');
select tests.cm_reverse(61, tests.cday(-2, 3), true);
-- S6 allocation reversed after its month closed (the reversal is inserted after the close below).
select tests.cm_invoice(7, 0, 1, 0, tests.cday(-4, 1));
select tests.cm_pay(71, tests.cid('c3100000', 7), 1140, tests.cday(-4, 15));
-- S7 reassigned customer: collected in Mc after C-0001 moved to rep E005.
select tests.cm_invoice(8, 0, 1, 0, tests.cday(-2, 1));
select tests.cm_pay(81, tests.cid('c3100000', 8), 1140, tests.cday(-2, 10));
update crm.customer_assignments set valid_to = now() + interval '1 second'
 where customer_id = '40000000-0000-0000-0000-000000000001' and role = 'primary_rep' and valid_to is null;
insert into crm.customer_assignments (customer_id, employee_id, reason)
values ('40000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000005', 'territory change (test)');
-- S8 mid-period rate change: 2 instruments (2280), half on day 10 and half on day 20 of Mc.
select tests.cm_invoice(9, 0, 0, 2, tests.cday(-2, 1));
select tests.cm_pay(91, tests.cid('c3100000', 9), 1140, tests.cday(-2, 10));
select tests.cm_pay(92, tests.cid('c3100000', 9), 1140, tests.cday(-2, 20));
-- S9 goodwill (amount-only) credit on the unpaid half: never claws back.
select tests.cm_invoice(10, 1, 0, 0, tests.cday(-2, 1));
select tests.cm_pay(101, tests.cid('c3100000', 10), 570, tests.cday(-2, 5));
select tests.cm_credit(101, tests.cid('c3100000', 10), null, 500, 70, tests.cday(-2, 6));

-- ===========================================================================
-- 3. Ma (k = −4): calculate, check, close
-- ===========================================================================
select lives_ok($$select service.commission_calculate(tests.cm(-4))$$, 'Ma calculates');
select is((select string_agg(e.invoice_item_id::text || '=' || e.base_amount || '@' || e.rate_pct || ':' || e.commission_amount, ' ' order by e.invoice_item_id)
           from perf.commission_entries e where e.source_id = tests.cid('c3400000', 21)),
  tests.citem(2, 1) || '=250.00@5.00:12.50 ' || tests.citem(2, 2) || '=250.00@1.50:3.75',
  'partial payment: 570 pays both open lines pro rata (285 each) → bases 250.00 → 12.50 + 3.75');
select is(tests.cm_sum(tests.cid('c3400000', 41)), 32.50::numeric, 'S4: the collection earns 25.00 + 7.50');
select is(tests.cm_sum(tests.cid('c3400000', 71)), 15.00::numeric, 'S6: a bur collection earns 1.5% of 1000 = 15.00');
select is(tests.cm_period_total(-4), (12.50 + 3.75 + 32.50 + 32.50 + 15.00)::numeric, 'Ma total');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select throws_like($$select api.close_commission_period(tests.cm(-3))$$, 'PREVIOUS_PERIOD_OPEN%',
  'a month cannot close before the previous one');
select throws_like($$select api.close_commission_period(core.business_date())$$, 'PERIOD_NOT_ENDED%',
  'the current month cannot close');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a3');
select throws_ok($$select api.close_commission_period(tests.cm(-4))$$, '42501', null, 'an area manager cannot close a period');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select throws_ok($$select api.close_commission_period(tests.cm(-4))$$, '42501', null, 'a rep cannot close a period');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select is((api.close_commission_period(tests.cm(-4)) ->> 'status'), 'approved', 'finance closes Ma');
select is((api.close_commission_period(tests.cm(-4)) ->> 'replayed')::boolean, true, 'closing again is a replay');
select tests.clear_authentication();
select is((select approved_by from perf.commission_periods where period_start = tests.cm(-4)),
  '00000000-0000-0000-0000-0000000000a6'::uuid, 'the close records who froze it');
select is((select count(*)::int from notify.notifications where recipient_user_id = '00000000-0000-0000-0000-0000000000a4'
           and type = 'commission.statement_final'), 1, 'the rep is told the statement is final');
select is((select (payload ->> 'total')::numeric from integration.outbox where event_type = 'commission.period_closed'
           and (payload ->> 'period_start')::date = tests.cm(-4)), 96.25::numeric, 'commission.period_closed carries the total');

-- Closed-period immutability
create temp table ma_snapshot as select string_agg(id::text || commission_amount, ',' order by id) as s
  from perf.commission_entries where period_id = (select id from perf.commission_periods where period_start = tests.cm(-4));
select throws_like($$delete from perf.commission_entries where period_id = (select id from perf.commission_periods where period_start = tests.cm(-4))$$,
  'PERIOD_CLOSED%', 'rows of a closed period cannot be deleted');
select throws_like($$update perf.commission_entries set commission_amount = 0 where source_id = tests.cid('c3400000', 71)$$,
  'COMMISSION_ENTRY_IMMUTABLE%', 'commission rows are never edited');
select throws_like($$insert into perf.commission_entries (period_id, employee_id, plan_id, source_type, source_id, base_amount, rate_pct, commission_amount, calc_run_id)
                     select p.id, '20000000-0000-0000-0000-000000000004', (select id from perf.commission_plans where code = 'STD-2026'),
                            'payment_allocation', gen_random_uuid(), 1, 1, 1, gen_random_uuid()
                     from perf.commission_periods p where p.period_start = tests.cm(-4)$$,
  'PERIOD_CLOSED%', 'nothing can be added to a closed period');
select throws_like($$update perf.commission_periods set status = 'open' where period_start = tests.cm(-4)$$,
  'PERIOD_CLOSED%', 'a closed period cannot be reopened');
select throws_like($$delete from perf.commission_periods where period_start = tests.cm(-4)$$, '%', 'periods are never deleted');
select is((service.commission_calculate(tests.cm(-4)) ->> 'frozen')::boolean, true, 'recalculating a closed period is a no-op');

-- Events that reach the database after Ma closed: S6's reversal (dated Mb) and a late
-- allocation dated in Ma itself (posted in the first open month, never restating Ma).
select tests.cm_reverse(71, tests.cday(-3, 10), false);
select tests.cm_invoice(11, 0, 1, 0, tests.cday(-4, 1));
select tests.cm_pay(111, tests.cid('c3100000', 11), 1140, tests.cday(-4, 28));

-- ===========================================================================
-- 4. Mb (k = −3)
-- ===========================================================================
select lives_ok($$select service.commission_calculate(tests.cm(-3))$$, 'Mb calculates');
select is((select string_agg(e.base_amount || ':' || e.commission_amount, ' ' order by e.invoice_item_id)
           from perf.commission_entries e where e.source_id = tests.cid('c3400000', 22)),
  '750.00:37.50 750.00:11.25', 'partial payment: the rest (1710) earns 37.50 + 11.25');
select is((select sum(commission_amount) from perf.commission_entries where invoice_id = tests.cid('c3100000', 2)),
  65.00::numeric, 'partial payments add up to 5% × 1000 + 1.5% × 1000 = 65.00');
select is((select sum(base_amount) from perf.commission_entries where invoice_id = tests.cid('c3100000', 2)),
  2000.00::numeric, 'and their bases to the invoice net, to the cent');
select is((select string_agg(e.entry_kind || ':' || e.commission_amount, ' ' order by e.event_at, e.entry_kind, e.invoice_item_id)
           from perf.commission_entries e where e.invoice_id = tests.cid('c3100000', 3)),
  'collection:25.00 collection:7.50 credit_clawback:-25.00 credit_reattribution:7.50',
  'return within 90 days: the implant commission is clawed back; the money now pays the burs');
select is((select sum(commission_amount) from perf.commission_entries where invoice_id = tests.cid('c3100000', 3)), 15.00::numeric,
  'after the return the rep keeps 1.5% of the burs actually paid (15.00)');
select is((select (base_amount, rate_pct)::text from perf.commission_entries where source_id = tests.cid('c3500000', 31)
           and entry_kind = 'credit_clawback'), '(-500.00,5.00)', 'the clawback row carries the base and rate it reverses');
select is((select entry_kind || ':' || commission_amount || ':' || p.period_start from perf.commission_entries e
           join perf.commission_periods p on p.id = e.period_id where e.source_id = tests.cid('c3400000', 61)),
  'collection:50.00:' || tests.cm(-3), 'bounced cheque: the collection earned 50.00 in Mb');
select is((select entry_kind || ':' || commission_amount || ':' || p.period_start from perf.commission_entries e
           join perf.commission_periods p on p.id = e.period_id where e.source_id = tests.cid('c3400000', 571)),
  'reversal:-15.00:' || tests.cm(-3), 'S6: the reversal after close is a negative row in Mb');
select is((select string_agg(id::text || commission_amount, ',' order by id) from perf.commission_entries
           where period_id = (select id from perf.commission_periods where period_start = tests.cm(-4))),
  (select s from ma_snapshot), 'the closed month is untouched by later events');
select is((select p.period_start || ':' || e.event_date || ':' || e.commission_amount from perf.commission_entries e
           join perf.commission_periods p on p.id = e.period_id where e.source_id = tests.cid('c3400000', 111)),
  tests.cm(-3) || ':' || tests.cday(-4, 28) || ':15.00', 'a late allocation of a closed month posts in the first open month');
select is((service.commission_calculate(tests.cm(-3)) ->> 'changed')::boolean, false, 'Mb recalculation is idempotent');

-- ===========================================================================
-- 5. Mc (k = −2) and Md (k = −1)
-- ===========================================================================
select lives_ok($$select service.commission_calculate(tests.cm(-2))$$, 'Mc calculates');
select lives_ok($$select service.commission_calculate(tests.cm(-1))$$, 'Md calculates');
select is((select entry_kind || ':' || base_amount || ':' || commission_amount || ':' || p.period_start from perf.commission_entries e
           join perf.commission_periods p on p.id = e.period_id where e.source_id = tests.cid('c3400000', 561)),
  'bounce:-1000.00:-50.00:' || tests.cm(-2), 'bounced cheque: −50.00 in the month it bounced (Mc), Mb is not restated');
select is((select sum(commission_amount) from perf.commission_entries where invoice_id = tests.cid('c3100000', 6)), 0.00::numeric,
  'a bounced cheque nets to zero');
select is((select string_agg(rate_pct || ':' || commission_amount, ' ' order by event_date) from perf.commission_entries
           where invoice_id = tests.cid('c3100000', 9)),
  '1.50:15.00 2.00:20.00', 'mid-period rate change: each collection takes the rate in force on its day');
select isnt((select rule_id from perf.commission_entries where source_id = tests.cid('c3400000', 91)),
  (select rule_id from perf.commission_entries where source_id = tests.cid('c3400000', 92)), 'the two rows name different rules');
select is((select employee_id from perf.commission_entries where source_id = tests.cid('c3400000', 81)),
  '20000000-0000-0000-0000-000000000004'::uuid, 'reassigned customer: the order''s rep still earns');
select is((select count(*)::int from perf.commission_entries where employee_id = '20000000-0000-0000-0000-000000000005'), 0,
  'the customer''s new rep earns nothing on the old order');
select is((select count(*)::int from perf.commission_entries where source_id = tests.cid('c3500000', 41)), 0,
  'a credit note 91 days after the collection claws nothing back');
select is(tests.cm_sum(tests.cid('c3500000', 51)), -17.50::numeric,
  'a credit note exactly 90 days after: implant −25.00, burs +7.50');
select is((select p.period_start from perf.commission_entries e join perf.commission_periods p on p.id = e.period_id
           where e.source_id = tests.cid('c3500000', 51) limit 1), date_trunc('month', tests.cday(-4, 2) + 90)::date,
  'the clawback posts in the credit note''s month');
select is((select count(*)::int from perf.commission_entries where source_id = tests.cid('c3500000', 101)), 0,
  'a goodwill credit on the unpaid part claws nothing back');
select is(tests.cm_sum(tests.cid('c3400000', 101)), 25.00::numeric, 'and the collection keeps its 25.00');

-- ===========================================================================
-- 6. Scope (statement, summary, periods)
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select ok((select count(*) from api.v_commission_statement) > 0, 'a rep sees his statement');
select is((select count(*)::int from api.v_commission_statement where employee_id <> '20000000-0000-0000-0000-000000000004'), 0,
  'a rep sees only his own lines');
select is((select invoice_no || '/' || customer_name from api.v_commission_statement where source_id = tests.cid('c3400000', 81)),
  'INV-CM-8/Dr. Ahmed Clinic', 'the statement still names the invoice and customer after the reassignment');
select is((select employee_name_en from api.v_commission_summary where period_start = tests.cm(-2)), 'Rep Cairo',
  'the summary names the rep');
select is((select total from api.v_commission_summary where period_start = tests.cm(-4)), 96.25::numeric,
  'the rep''s Ma summary total');
select ok((select count(*) from api.v_commission_periods) > 0, 'a rep sees the periods');
select is((select total from api.v_commission_periods where period_start = tests.cm(-4)), 96.25::numeric,
  'period totals are of the lines the caller may read');
select throws_like($$insert into perf.commission_adjustments (period_id, employee_id, amount, kind, reason)
                     select id, '20000000-0000-0000-0000-000000000004', 1, 'bonus', 'x' from perf.commission_periods limit 1$$,
  '%permission denied%', 'clients cannot write commission tables');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a5');
select is((select count(*)::int from api.v_commission_statement), 0, 'another rep sees none of these lines');
select is((select count(*)::int from api.v_commission_summary), 0, 'nor a summary row');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a3');
select ok((select count(*) from api.v_commission_statement where employee_id = '20000000-0000-0000-0000-000000000004') > 0,
  'the area manager sees his team''s statement');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select is((select count(*)::int from api.v_commission_statement), (select count(*)::int from perf.commission_entries),
  'finance sees every line');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a2');
select ok((select count(*) from api.v_commission_summary) > 0, 'the sales director sees the summary');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a8');
select is((select count(*)::int from api.v_commission_statement), 0, 'without perf.commission.read: no statement');
select is((select count(*)::int from api.v_commission_periods), 0, 'and no periods');
select tests.clear_authentication();
select ok(not has_function_privilege('authenticated', 'service.commission_calculate(date)', 'execute')
          and not has_function_privilege('authenticated', 'service.commission_run(timestamptz)', 'execute'),
  'the engine and the cron are service-only');
select ok(has_function_privilege('service_role', 'service.commission_calculate(date)', 'execute'), 'service_role runs the engine');
select ok(not has_function_privilege('authenticated', 'perf.commission_replay_invoice(uuid, uuid, date, date, date, date, integer, uuid)', 'execute')
          and not has_function_privilege('authenticated', 'perf.commission_close(date, uuid)', 'execute')
          and not has_function_privilege('anon', 'api.adjust_commission(uuid, date, numeric, text, text, text)', 'execute'),
  'internal helpers are not client-callable; anon runs no commission command');

-- ===========================================================================
-- 7. Adjustments through the workflow
-- ===========================================================================
insert into authz.user_permission_overrides (user_id, permission_code, effect, scope, reason)
values ('00000000-0000-0000-0000-0000000000a6', 'perf.commission.adjust', 'grant', 'all', 'test: finance prepares adjustments');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select throws_ok($$select api.adjust_commission('20000000-0000-0000-0000-000000000005', core.business_date(), 10, 'test bonus', 'bonus', 'adj-rep')$$,
  '42501', null, 'a rep cannot adjust commissions');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select throws_like($$select api.adjust_commission('20000000-0000-0000-0000-000000000006', core.business_date(), 10, 'my bonus', 'bonus', 'adj-self')$$,
  'SELF_ADJUSTMENT%', 'nobody adjusts their own commission');
select throws_like($$select api.adjust_commission('20000000-0000-0000-0000-000000000004', core.business_date(), -50, 'wrong sign', 'bonus', 'adj-sign')$$,
  'VALIDATION%', 'a bonus must be positive');
select throws_like($$select api.adjust_commission('20000000-0000-0000-0000-000000000004', core.business_date(), 50, ' ', 'bonus', 'adj-reason')$$,
  'REASON_REQUIRED%', 'an adjustment needs a reason');
select throws_like($$select api.adjust_commission('20000000-0000-0000-0000-000000000004', core.business_date(), 50.555, 'decimals', 'bonus', 'adj-dec')$$,
  'VALIDATION%', 'at most 2 decimals');
select throws_like($$select api.adjust_commission('20000000-0000-0000-0000-000000000004', tests.cm(-4), 50, 'into closed', 'bonus', 'adj-closed')$$,
  'PERIOD_CLOSED%', 'a closed period takes no adjustment');
select is((api.adjust_commission('20000000-0000-0000-0000-000000000004', core.business_date(), 100, 'Quarterly bonus (test)', 'bonus', 'adj-1') ->> 'status'),
  'pending_approval', 'an adjustment waits for approval');
select is((api.adjust_commission('20000000-0000-0000-0000-000000000004', core.business_date(), 100, 'Quarterly bonus (test)', 'bonus', 'adj-1') ->> 'replayed')::boolean,
  true, 'a repeated request is a replay');
select throws_like($$select api.decide_approval((select request_id from api.v_commission_adjustment_requests where status = 'pending'), 'approve')$$,
  'SELF_APPROVAL%', 'the requester cannot approve it');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is((select amount from api.v_commission_adjustment_requests where status = 'pending'), 100.00::numeric,
  'the rep sees the pending adjustment about him');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a5');
select is((select count(*)::int from api.v_commission_adjustment_requests), 0, 'another rep does not');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');
select lives_ok($$select api.decide_approval((select request_id from api.v_commission_adjustment_requests where status = 'pending'), 'approve')$$,
  'the owner approves it');
select tests.clear_authentication();
select is((select (amount, kind, approval_request_id is not null, created_by)::text from perf.commission_adjustments
           where idempotency_key = 'adj-1'), '(100.00,bonus,t,00000000-0000-0000-0000-0000000000a6)',
  'the decision hook posts the adjustment');
select is((select count(*)::int from notify.notifications where recipient_user_id = '00000000-0000-0000-0000-0000000000a4'
           and type = 'commission.adjusted'), 1, 'the rep is notified of the adjustment');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is((select string_agg(line_type || ':' || kind || ':' || amount, ',') from api.v_commission_statement
           where period_start = tests.cm(0) and line_type = 'adjustment'), 'adjustment:bonus:100.00',
  'the adjustment is on the statement');
select is((select (earned, clawed_back, adjustments, total)::text from api.v_commission_summary where period_start = tests.cm(0)),
  '(98.00,0.00,100.00,198.00)', 'the summary adds it to the total');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select is((api.adjust_commission('20000000-0000-0000-0000-000000000004', core.business_date(), 100, 'Quarterly bonus (test)', 'bonus', 'adj-1') ->> 'status'),
  'posted', 'a replay after approval reports it posted');
select is((api.adjust_commission('20000000-0000-0000-0000-000000000004', core.business_date(), -20, 'Overpaid last month (test)', null, 'adj-2') ->> 'kind'),
  'clawback', 'a negative amount defaults to a clawback');
select tests.clear_authentication();

-- ===========================================================================
-- 8. Statement golden fixture (per rep and month) and the cron
-- ===========================================================================
-- Expected per month for rep E004 (S4b's clawback −17.50 lands in the month of day 2 of Ma + 90 days).
create temp table expected_months (k int, total numeric);
insert into expected_months values
  (-4, 12.50 + 3.75 + 32.50 + 32.50 + 15.00),                       -- S2 first half, S4, S4b, S6
  (-3, 37.50 + 11.25 + 15.00 + 50.00 - 15.00 + 15.00),              -- S2 rest, S3 net, S5 cheque, S6 reversal, late S11
  (-2, -50.00 + 15.00 + 15.00 + 20.00 + 25.00),                     -- S5 bounce, S7, S8 × 2, S9
  (-1, 0.00);
update expected_months set total = total - 17.50 where tests.cm(k) = date_trunc('month', tests.cday(-4, 2) + 90)::date;
select is((select string_agg(to_char(tests.cm(x.k), 'YYYY-MM') || '=' || coalesce(s.total, 0.00), ' ' order by x.k)
           from expected_months x
           left join api.v_commission_summary s on s.period_start = tests.cm(x.k)
                 and s.employee_id = '20000000-0000-0000-0000-000000000004'),
  (select string_agg(to_char(tests.cm(k), 'YYYY-MM') || '=' || total::numeric(14,2), ' ' order by k) from expected_months),
  'statement totals per month match the expected fixture');

select lives_ok($$select service.commission_run()$$, 'the cron runs');
select is((select count(*)::int from perf.commission_periods p
           where not perf.commission_status_frozen(p.status) and perf.period_close_at(p.period_start) <= now()), 0,
  'the cron closed every month whose close date passed');
select is((select status from perf.commission_periods where period_start = tests.cm(0)), 'calculated',
  'the current month stays open (calculated)');
select is((select count(*)::int from perf.commission_periods p where perf.commission_status_frozen(p.status)
           and p.period_start > tests.cm(-4) and p.approved_by is not null), 0, 'cron closes record no person');

select * from finish();
rollback;
