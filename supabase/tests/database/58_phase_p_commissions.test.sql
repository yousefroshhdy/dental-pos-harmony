-- Phase P step 7, commissions switched on (20261125000400_commissions_on.sql; owner decision D).
--   * the rate editor: owner only (perf.commission_plan.manage), MFA-gated, append-only and
--     effective-dated rates, draft → active → retired, every change audited
--   * STD-2026 configured with decision D (Bioner 5 %, Derby 1.5 %, RDT 1.5 %; grafts and
--     membranes unset) and activated by the owner; sales reps assigned from the activation date
--   * synthetic invoices and payments: partial payments, bonus (zero) lines, a return within
--     90 days (clawback) and after 90 days (none), a rate edit effective mid-month, an unset
--     STEP rate (0, listed as "no rate"), the rep statement totals and their scope
--   users: a1 owner · a2 sales director · a3 area mgr (manager of a4) · a4 rep Cairo (E004)
--          · a5 rep Delta (E005) · a6 finance officer · a7 admin · a8 inventory manager
--   months: tests.t58_cm(k) = first day of the month k months from the current one
begin;
select tests.load_fixture();
select plan(104);
set constraints all immediate;

-- ---------------------------------------------------------------------------
-- Helpers (created inside this transaction; rolled back with it)
-- ---------------------------------------------------------------------------
create function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return 'OK';
exception when others then
  return 'ERROR ' || sqlstate || ' ' || split_part(sqlerrm, ':', 1);
end $$;
-- Act as a user whose JWT carries the given aal claim (aal1 / aal2).
create function pg_temp.auth_aal(p_user uuid, p_aal text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated', 'aal', p_aal)::text, true);
  perform set_config('request.jwt.claim.sub', p_user::text, true);
  execute 'set local role authenticated';
end $$;
create function pg_temp.enforce(p_on boolean) returns void language sql as $$
  update core.system_settings set value = to_jsonb(p_on) where key = 'security.mfa_enforced'
$$;
grant execute on function pg_temp.try(text), pg_temp.auth_aal(uuid, text) to authenticated;

create function tests.t58_cm(k int) returns date language sql stable as $$
  select (date_trunc('month', core.business_date()) + make_interval(months => k))::date $$;
create function tests.t58_cday(k int, d int) returns date language sql stable as $$ select tests.t58_cm(k) + (d - 1) $$;
create function tests.t58_ts(p_day date) returns timestamptz language sql stable as $$
  select (p_day + time '12:00') at time zone 'Africa/Cairo' $$;
create function tests.t58_id(p_prefix text, n int) returns uuid language sql immutable as $$
  select (p_prefix || '-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid $$;
create function tests.t58_item(n int, k int) returns uuid language sql immutable as $$ select tests.t58_id('58200000', n * 10 + k) $$;

-- An invoiced order n of rep E004 for C-0001. p_lines: [{"v": variant, "q": qty, "p": unit price}],
-- 14 % VAT on every line, no discount. A line at price 0 is a bonus (free) line.
create function tests.t58_invoice(n int, p_lines jsonb, p_issue date) returns uuid language plpgsql as $$
declare v_inv uuid := tests.t58_id('58100000', n); l jsonb; k int := 0; v_sub numeric := 0; v_tax numeric := 0;
        q int; pr numeric; t numeric;
begin
  for l in select * from jsonb_array_elements(p_lines) loop
    v_sub := v_sub + (l ->> 'q')::int * (l ->> 'p')::numeric;
    v_tax := v_tax + round((l ->> 'q')::int * (l ->> 'p')::numeric * 0.14, 2);
  end loop;
  insert into sales.orders (id, order_no, customer_id, employee_id, status, subtotal, discount_total, tax_total, total)
  values (tests.t58_id('58000000', n), 'SO-T58-' || n, '40000000-0000-0000-0000-000000000001',
          '20000000-0000-0000-0000-000000000004', 'invoiced', v_sub, 0, v_tax, v_sub + v_tax);
  insert into finance.invoices (id, invoice_no, order_id, customer_id, issue_date, due_date, status,
                                subtotal, discount_total, tax_total, total)
  values (v_inv, 'INV-T58-' || n, tests.t58_id('58000000', n), '40000000-0000-0000-0000-000000000001',
          p_issue, p_issue, 'issued', v_sub, 0, v_tax, v_sub + v_tax);
  for l in select * from jsonb_array_elements(p_lines) loop
    k := k + 1; q := (l ->> 'q')::int; pr := (l ->> 'p')::numeric; t := round(q * pr * 0.14, 2);
    insert into finance.invoice_items (id, invoice_id, variant_id, description, quantity, unit_price, discount,
                                       tax_rate_pct, tax_amount, line_total, line_subtotal)
    values (tests.t58_item(n, k), v_inv, (l ->> 'v')::uuid, 'Line ' || k, q, pr, 0, 14, t, q * pr + t, q * pr);
  end loop;
  return v_inv;
end $$;

-- A confirmed payment n fully allocated to an invoice at noon Cairo of p_day; returns the allocation.
create function tests.t58_pay(n int, p_invoice uuid, p_amount numeric, p_day date) returns uuid language plpgsql as $$
begin
  insert into finance.payments (id, payment_no, customer_id, method, amount, received_at, status, confirmed_at)
  values (tests.t58_id('58300000', n), 'PAY-T58-' || n, '40000000-0000-0000-0000-000000000001', 'bank_transfer',
          p_amount, tests.t58_ts(p_day), 'confirmed', tests.t58_ts(p_day));
  insert into finance.payment_allocations (id, payment_id, invoice_id, amount, allocated_at)
  values (tests.t58_id('58400000', n), tests.t58_id('58300000', n), p_invoice, p_amount, tests.t58_ts(p_day));
  return tests.t58_id('58400000', n);
end $$;

-- A return credit note n for one whole line (quantity 1).
create function tests.t58_credit(n int, p_invoice uuid, p_item uuid, p_amount numeric, p_tax numeric, p_day date)
returns uuid language plpgsql as $$
begin
  insert into finance.credit_notes (id, credit_no, invoice_id, customer_id, reason, amount, tax_amount, issue_date, created_at)
  values (tests.t58_id('58500000', n), 'CN-T58-' || n, p_invoice, '40000000-0000-0000-0000-000000000001', 'test return',
          p_amount, p_tax, p_day, tests.t58_ts(p_day));
  insert into finance.credit_note_items (credit_note_id, invoice_item_id, quantity, amount, tax_amount)
  values (tests.t58_id('58500000', n), p_item, 1, p_amount, p_tax);
  return tests.t58_id('58500000', n);
end $$;

create function tests.t58_sum(p_source uuid) returns numeric language sql stable as $$
  select coalesce(sum(commission_amount), 0)::numeric from perf.commission_entries where source_id = p_source $$;

-- ===========================================================================
-- 1. Catalogue, flags, privileges
-- ===========================================================================
select is((select requires_mfa and is_sensitive from authz.permissions where code = 'perf.commission_plan.manage'), true,
  'perf.commission_plan.manage is sensitive and requires MFA');
select is((select count(*)::int from authz.role_permissions where permission_code = 'perf.commission_plan.manage'), 0,
  'no role holds perf.commission_plan.manage: the rate editor is the owner''s');
select ok(not has_function_privilege('anon', 'api.set_commission_rate(uuid,text,uuid,numeric,date,text,text)', 'execute')
          and not has_function_privilege('anon', 'api.activate_commission_plan(uuid,date,boolean)', 'execute')
          and not has_function_privilege('anon', 'api.deactivate_commission_plan(uuid,date,text)', 'execute')
          and not has_function_privilege('anon', 'api.create_commission_plan(text,text)', 'execute')
          and not has_function_privilege('anon', 'api.commission_unrated(uuid,date)', 'execute'),
  'anon runs no rate-editor command');
select ok(has_function_privilege('authenticated', 'api.set_commission_rate(uuid,text,uuid,numeric,date,text,text)', 'execute')
          and has_function_privilege('authenticated', 'api.activate_commission_plan(uuid,date,boolean)', 'execute')
          and has_function_privilege('authenticated', 'api.commission_unrated(uuid,date)', 'execute'),
  'signed-in users may call the commands (the database decides who may)');
select ok(not has_function_privilege('authenticated', 'perf.guard_commission_rule()', 'execute')
          and not has_function_privilege('authenticated', 'perf.guard_commission_plan()', 'execute')
          and not has_function_privilege('authenticated', 'perf.require_plan_manager()', 'execute')
          and not has_function_privilege('authenticated', 'perf.commission_last_frozen_end()', 'execute')
          and not has_function_privilege('authenticated', 'perf.commission_rate(uuid,uuid,date)', 'execute')
          and not has_function_privilege('authenticated', 'perf.commission_plan_for(uuid,date)', 'execute'),
  'the editor''s and the engine''s helpers are internal');
select is((select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'api' and c.relname in ('v_commission_plans', 'v_commission_plan_rules', 'v_commission_statement_totals')
             and c.reloptions @> array['security_invoker=true']), 3, 'the new views are security_invoker');

-- ===========================================================================
-- 2. Decision D configuration (the migration configures; the owner activates)
-- ===========================================================================
select is((select status || '/' || basis from perf.commission_plans where code = 'STD-2026'), 'draft/collected',
  'STD-2026 ships as a draft on collected cash: activation is the owner''s step');
select is((select string_agg(b.code || '=' || r.rate_pct, ' ' order by b.code) from perf.commission_plan_rules r
           join perf.commission_plans p on p.id = r.plan_id join catalog.brands b on b.id = r.brand_id
           where p.code = 'STD-2026' and r.voided_at is null),
  'BIONER=5.00 DERBY=1.50 RDT=1.50', 'decision D brand rates: Bioner (implants) 5 %, Derby (instruments) 1.5 %, RDT (burs) 1.5 %');
select is((select string_agg(c.code || '=' || r.rate_pct, ' ' order by c.code) from perf.commission_plan_rules r
           join perf.commission_plans p on p.id = r.plan_id join catalog.categories c on c.id = r.category_id
           where p.code = 'STD-2026' and r.voided_at is null),
  'BUR=1.50 IMPLANT=5.00 INSTRUMENT=1.50', 'the category rates stay (category beats brand)');
select is((select count(*)::int from perf.commission_plan_rules r
           left join catalog.categories c on c.id = r.category_id left join catalog.brands b on b.id = r.brand_id
           where c.code in ('GRAFT', 'MEMBRANE') or b.code = 'STEP'), 0,
  'bone grafts and membranes (GRAFT, MEMBRANE, STEP) have no rate until the owner sets one');
select is((select value from core.system_settings where key = 'commission.clawback_days'), '90'::jsonb,
  'the clawback window is 90 days');

-- ===========================================================================
-- 3. Synthetic reference data and documents
-- ===========================================================================
insert into catalog.brands (code, name) values ('STEP', 'STEP (test)') on conflict (code) do nothing;
insert into catalog.categories (id, code, name_en, name_ar)
values ('58900000-0000-0000-0000-000000000001', 'T58-KIT', 'Kits (test)', 'أطقم (اختبار)');
insert into catalog.products (id, brand_id, category_id, code, name_en)
select v.id::uuid, b.id, c.id, v.code, v.name from (values
  ('58600000-0000-0000-0000-000000000001', 'BIONER', 'T58-KIT', 'T58-KIT', 'Bioner surgical kit (test)'),
  ('58600000-0000-0000-0000-000000000002', 'BIONER', 'T58-KIT', 'T58-ABUT', 'Bioner abutment (test)'),
  ('58600000-0000-0000-0000-000000000003', 'DERBY', 'T58-KIT', 'T58-FORC', 'Derby forceps (test)'),
  ('58600000-0000-0000-0000-000000000004', 'RDT', 'T58-KIT', 'T58-BUR', 'RDT bur kit (test)'),
  ('58600000-0000-0000-0000-000000000005', 'STEP', 'GRAFT', 'T58-GRAFT', 'STEP bone graft (test)')) v(id, brand, cat, code, name)
join catalog.brands b on b.code = v.brand join catalog.categories c on c.code = v.cat;
insert into catalog.product_variants (id, product_id, sku, name_en)
select replace(p.id::text, '58600000', '58700000')::uuid, p.id, p.code || '-1', p.name_en
from catalog.products p where p.code like 'T58-%';

select set_config('t58.plan', (select id::text from perf.commission_plans where code = 'STD-2026'), false);
select set_config('t58.derby', (select id::text from catalog.brands where code = 'DERBY'), false);
select set_config('t58.step', (select id::text from catalog.brands where code = 'STEP'), false);

-- I1 partial payments with a bonus line: kit + bur + 2 free abutments; 1140 in M-3, 1140 in M-2.
select tests.t58_invoice(1, '[{"v":"58700000-0000-0000-0000-000000000001","q":1,"p":1000},
                              {"v":"58700000-0000-0000-0000-000000000004","q":1,"p":1000},
                              {"v":"58700000-0000-0000-0000-000000000002","q":2,"p":0}]', tests.t58_cday(-3, 1));
select tests.t58_pay(11, tests.t58_id('58100000', 1), 1140, tests.t58_cday(-3, 10));
select tests.t58_pay(12, tests.t58_id('58100000', 1), 1140, tests.t58_cday(-2, 5));
-- I2 return within 90 days: implant + Derby forceps paid in full, the implant returned 30 days later.
select tests.t58_invoice(2, '[{"v":"53000000-0000-0000-0000-000000000001","q":1,"p":1000},
                              {"v":"58700000-0000-0000-0000-000000000003","q":1,"p":1000}]', tests.t58_cday(-3, 1));
select tests.t58_pay(21, tests.t58_id('58100000', 2), 2280, tests.t58_cday(-3, 15));
select tests.t58_credit(21, tests.t58_id('58100000', 2), tests.t58_item(2, 1), 1000, 140, tests.t58_cday(-3, 15) + 30);
-- I3 return after 90 days: an implant paid in M-4 and returned 91 days later.
select tests.t58_invoice(3, '[{"v":"53000000-0000-0000-0000-000000000001","q":1,"p":1000}]', tests.t58_cday(-4, 1));
select tests.t58_pay(31, tests.t58_id('58100000', 3), 1140, tests.t58_cday(-4, 3));
select tests.t58_credit(31, tests.t58_id('58100000', 3), tests.t58_item(3, 1), 1000, 140, tests.t58_cday(-4, 3) + 91);
-- I4 rate edit: 2 Derby forceps, half paid on day 10 and half on day 20 of M-1.
select tests.t58_invoice(4, '[{"v":"58700000-0000-0000-0000-000000000003","q":2,"p":1000}]', tests.t58_cday(-1, 1));
select tests.t58_pay(41, tests.t58_id('58100000', 4), 1140, tests.t58_cday(-1, 10));
select tests.t58_pay(42, tests.t58_id('58100000', 4), 1140, tests.t58_cday(-1, 20));
-- I5 unset rate: a STEP bone graft paid in M-2.
select tests.t58_invoice(5, '[{"v":"58700000-0000-0000-0000-000000000005","q":1,"p":1000}]', tests.t58_cday(-2, 1));
select tests.t58_pay(51, tests.t58_id('58100000', 5), 1140, tests.t58_cday(-2, 8));
-- I6 an invoice of free lines only, with money allocated to it (the engine must not choke).
select tests.t58_invoice(6, '[{"v":"58700000-0000-0000-0000-000000000002","q":1,"p":0}]', tests.t58_cday(-2, 1));
select tests.t58_pay(61, tests.t58_id('58100000', 6), 50, tests.t58_cday(-2, 9));

select is((service.commission_calculate(tests.t58_cm(-3)) ->> 'entries')::int, 0,
  'while STD-2026 is a draft, collections earn nothing');

-- ===========================================================================
-- 4. Permission matrix: only the owner edits rates and plans
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a2');
select is(pg_temp.try($$select api.set_commission_rate(current_setting('t58.plan')::uuid, 'brand', current_setting('t58.step')::uuid, 2, core.business_date())$$),
  'ERROR 42501 PERMISSION_DENIED', 'the sales director cannot set a rate');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a3');
select is(pg_temp.try($$select api.set_commission_rate(current_setting('t58.plan')::uuid, 'brand', current_setting('t58.step')::uuid, 2, core.business_date())$$),
  'ERROR 42501 PERMISSION_DENIED', 'an area manager cannot set a rate');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is(pg_temp.try($$select api.set_commission_rate(current_setting('t58.plan')::uuid, 'brand', current_setting('t58.step')::uuid, 2, core.business_date())$$),
  'ERROR 42501 PERMISSION_DENIED', 'a rep cannot set a rate');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select is(pg_temp.try($$select api.set_commission_rate(current_setting('t58.plan')::uuid, 'brand', current_setting('t58.step')::uuid, 2, core.business_date())$$),
  'ERROR 42501 PERMISSION_DENIED', 'finance cannot set a rate');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a7');
select is(pg_temp.try($$select api.set_commission_rate(current_setting('t58.plan')::uuid, 'brand', current_setting('t58.step')::uuid, 2, core.business_date())$$),
  'ERROR 42501 PERMISSION_DENIED', 'the system administrator cannot set a rate');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a8');
select is(pg_temp.try($$select api.set_commission_rate(current_setting('t58.plan')::uuid, 'brand', current_setting('t58.step')::uuid, 2, core.business_date())$$),
  'ERROR 42501 PERMISSION_DENIED', 'the inventory manager cannot set a rate');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is(pg_temp.try($$select api.activate_commission_plan(current_setting('t58.plan')::uuid, core.business_date())$$)
          || '|' || pg_temp.try($$select api.deactivate_commission_plan(current_setting('t58.plan')::uuid, core.business_date(), 'no')$$)
          || '|' || pg_temp.try($$select api.create_commission_plan('T58-REP', 'Rep plan')$$),
  'ERROR 42501 PERMISSION_DENIED|ERROR 42501 PERMISSION_DENIED|ERROR 42501 PERMISSION_DENIED',
  'a rep cannot activate, deactivate or create a plan');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a2');
select is(pg_temp.try($$select api.activate_commission_plan(current_setting('t58.plan')::uuid, core.business_date())$$)
          || '|' || pg_temp.try($$select api.deactivate_commission_plan(current_setting('t58.plan')::uuid, core.business_date(), 'no')$$)
          || '|' || pg_temp.try($$select api.create_commission_plan('T58-SD', 'Director plan')$$),
  'ERROR 42501 PERMISSION_DENIED|ERROR 42501 PERMISSION_DENIED|ERROR 42501 PERMISSION_DENIED',
  'the sales director (perf.commission_plan.read) cannot either');
select is((select count(*)::int from api.v_commission_plans where code = 'STD-2026'), 1,
  'the sales director reads the plans (perf.commission_plan.read)');
select ok((select count(*) from api.v_commission_plan_rules where plan_code = 'STD-2026') >= 6, 'and their rates');
select is(pg_temp.try($$select * from api.commission_unrated(current_setting('t58.plan')::uuid)$$), 'OK',
  'and the no-rate list');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is((select count(*)::int from api.v_commission_plans) + (select count(*)::int from api.v_commission_plan_rules), 0,
  'a rep reads no plan or rate');
select is(pg_temp.try($$select * from api.commission_unrated(current_setting('t58.plan')::uuid)$$),
  'ERROR 42501 PERMISSION_DENIED', 'nor the no-rate list');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select is((select count(*)::int from api.v_commission_plans), 0, 'finance reads no plan (it reads the statements)');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');
select throws_like($$insert into perf.commission_plan_rules (plan_id, rate_pct) values (current_setting('t58.plan')::uuid, 1)$$,
  '%permission denied%', 'not even the owner writes the tables directly: only through the commands');
select tests.clear_authentication();

-- ===========================================================================
-- 5. MFA gate (security.mfa_enforced on): aal1 is refused, aal2 activates STD-2026
-- ===========================================================================
select pg_temp.enforce(true);
select pg_temp.auth_aal('00000000-0000-0000-0000-0000000000a1', 'aal1');
select is(pg_temp.try($$select api.set_commission_rate(current_setting('t58.plan')::uuid, 'brand', current_setting('t58.step')::uuid, 2, core.business_date())$$),
  'ERROR 42501 MFA_REQUIRED', 'enforcement on: the owner at aal1 cannot set a rate');
select is(pg_temp.try($$select api.activate_commission_plan(current_setting('t58.plan')::uuid, tests.t58_cm(-4))$$),
  'ERROR 42501 MFA_REQUIRED', 'enforcement on: the owner at aal1 cannot activate a plan');
select is(pg_temp.try($$select api.deactivate_commission_plan(current_setting('t58.plan')::uuid, core.business_date(), 'test')$$)
          || '|' || pg_temp.try($$select api.create_commission_plan('T58-AAL1', 'Plan at aal1')$$),
  'ERROR 42501 MFA_REQUIRED|ERROR 42501 MFA_REQUIRED', 'enforcement on: nor deactivate or create one');
select is((select count(*)::int from api.v_commission_plans where code = 'STD-2026'), 1, 'reading the plans needs no step-up');
select is(pg_temp.try($$select * from api.commission_unrated(current_setting('t58.plan')::uuid)$$), 'OK',
  'nor reading the no-rate list');
select pg_temp.auth_aal('00000000-0000-0000-0000-0000000000a4', 'aal2');
select is(pg_temp.try($$select api.set_commission_rate(current_setting('t58.plan')::uuid, 'brand', current_setting('t58.step')::uuid, 2, core.business_date())$$),
  'ERROR 42501 PERMISSION_DENIED', 'a non-holder sees PERMISSION_DENIED, never MFA_REQUIRED');
select pg_temp.auth_aal('00000000-0000-0000-0000-0000000000a1', 'aal2');
select is((api.activate_commission_plan(current_setting('t58.plan')::uuid, tests.t58_cm(-4)) ->> 'assigned')::int, 2,
  'aal2: the owner activates STD-2026 from the first open month; both sales reps are assigned');
select is((api.activate_commission_plan(current_setting('t58.plan')::uuid, tests.t58_cm(-4)) ->> 'replayed')::boolean, true,
  'activating again is a replay');
select tests.clear_authentication();
select pg_temp.enforce(false);

select is((select (status, effective_from, activated_by)::text from perf.commission_plans where code = 'STD-2026'),
  '(active,' || tests.t58_cm(-4) || ',00000000-0000-0000-0000-0000000000a1)', 'the plan is active from the chosen day, by the owner');
select is((select string_agg(e.employee_no || '@' || ep.valid_from, ' ' order by e.employee_no) from perf.employee_commission_plans ep
           join core.employees e on e.id = ep.employee_id where ep.plan_id = current_setting('t58.plan')::uuid),
  'E004@' || tests.t58_cm(-4) || ' E005@' || tests.t58_cm(-4), 'every sales rep (role sales_rep) is assigned from the activation date');
select is(perf.commission_plan_for('20000000-0000-0000-0000-000000000004', tests.t58_cday(-4, 3)), current_setting('t58.plan')::uuid,
  'the rep''s plan on a collection day is STD-2026');
select ok((select count(*) from audit.audit_log where table_schema = 'perf' and table_name = 'commission_plans' and action = 'UPDATE'
             and actor_user_id = '00000000-0000-0000-0000-0000000000a1') = 1
          and (select count(*) from audit.audit_log where table_schema = 'perf' and table_name = 'employee_commission_plans'
                 and action = 'INSERT' and actor_user_id = '00000000-0000-0000-0000-0000000000a1') = 2,
  'the activation and the assignments are audited with the owner''s identity');
select is((select count(*)::int from integration.outbox where event_type = 'commission.plan_activated'
           and aggregate_id = current_setting('t58.plan')::uuid), 1, 'commission.plan_activated is in the outbox');

-- A new draft plan; a plan without rates cannot be activated.
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');
select is((api.create_commission_plan('t58-empty', 'Empty test plan') ->> 'status'), 'draft', 'the owner creates a draft plan');
select is((api.create_commission_plan('T58-EMPTY', 'Empty test plan') ->> 'replayed')::boolean, true, 'creating it again is a replay');
select is(pg_temp.try($$select api.create_commission_plan('T58-EMPTY', 'Another name')$$), 'ERROR P0001 DUPLICATE',
  'a plan code is unique');
select is(pg_temp.try($$select api.activate_commission_plan((select id from perf.commission_plans where code = 'T58-EMPTY'), core.business_date())$$),
  'ERROR P0001 VALIDATION', 'a plan without a rate cannot be activated');
select tests.clear_authentication();

-- ===========================================================================
-- 6. M-4: calculate and close
-- ===========================================================================
select lives_ok($$select service.commission_calculate(tests.t58_cm(-4))$$, 'M-4 calculates');
select is(tests.t58_sum(tests.t58_id('58400000', 31)), 50.00::numeric, 'an implant collection earns 5 % of 1000 = 50.00');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select is((api.close_commission_period(tests.t58_cm(-4)) ->> 'status'), 'approved', 'finance closes M-4');
select tests.clear_authentication();

-- ===========================================================================
-- 7. Rate edits: effective-dated, append-only, never inside a closed month
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');
select is(pg_temp.try($$select api.set_commission_rate(current_setting('t58.plan')::uuid, 'brand', current_setting('t58.derby')::uuid, 2.50, tests.t58_cday(-4, 20))$$),
  'ERROR P0001 PERIOD_CLOSED', 'a rate cannot take effect inside a closed month');
select is((api.set_commission_rate(current_setting('t58.plan')::uuid, 'brand', current_setting('t58.derby')::uuid, 2.50,
                                   tests.t58_cday(-1, 15), 'test: Derby up', 'rate-58-1') ->> 'closed')::int, 1,
  'Derby 1.5 % → 2.5 % from day 15 of M-1: the rate in force is closed the day before');
select is((api.set_commission_rate(current_setting('t58.plan')::uuid, 'brand', current_setting('t58.derby')::uuid, 2.50,
                                   tests.t58_cday(-1, 15), 'test: Derby up', 'rate-58-1') ->> 'replayed')::boolean, true,
  'the same change again is a replay');
select is(pg_temp.try($$select api.set_commission_rate(current_setting('t58.plan')::uuid, 'brand', current_setting('t58.derby')::uuid, 3.00, tests.t58_cday(-1, 15), null, 'rate-58-1')$$),
  'ERROR P0001 IDEMPOTENCY_CONFLICT', 'a key used for another rate is refused');
select is(pg_temp.try($$select api.set_commission_rate(current_setting('t58.plan')::uuid, 'variant', null, 2, core.business_date())$$)
          || '|' || pg_temp.try($$select api.set_commission_rate(current_setting('t58.plan')::uuid, 'brand', current_setting('t58.derby')::uuid, 2.555, core.business_date())$$)
          || '|' || pg_temp.try($$select api.set_commission_rate(current_setting('t58.plan')::uuid, 'brand', current_setting('t58.derby')::uuid, 101, core.business_date())$$)
          || '|' || pg_temp.try($$select api.set_commission_rate(current_setting('t58.plan')::uuid, 'shelf', null, 2, core.business_date())$$),
  'ERROR P0001 VALIDATION|ERROR P0001 VALIDATION|ERROR P0001 VALIDATION|ERROR P0001 VALIDATION',
  'a target needs its id, a rate is 0–100 % with 2 decimals, the target type is known');
select is(pg_temp.try($$select api.set_commission_rate(current_setting('t58.plan')::uuid, 'brand', gen_random_uuid(), 2, core.business_date())$$),
  'ERROR P0002 NOT_FOUND', 'an unknown brand is not found');
select tests.clear_authentication();
select is((select string_agg(r.rate_pct || ':' || coalesce(r.effective_from::text, '-') || ':' || coalesce(r.effective_to::text, '-')
                             || ':' || (r.voided_at is not null), ' ' order by r.effective_from nulls first)
           from perf.commission_plan_rules r where r.plan_id = current_setting('t58.plan')::uuid and r.brand_id = current_setting('t58.derby')::uuid),
  '1.50:-:' || tests.t58_cday(-1, 14) || ':false 2.50:' || tests.t58_cday(-1, 15) || ':-:false',
  'append-only: the old Derby row keeps its rate and start and ends the day before; the new rate is a new row');
select is((select created_by from perf.commission_plan_rules where idempotency_key = 'rate-58-1'),
  '00000000-0000-0000-0000-0000000000a1'::uuid, 'the new rate records who set it');
select is((select count(*)::int from audit.audit_log where table_schema = 'perf' and table_name = 'commission_plan_rules'
           and actor_user_id = '00000000-0000-0000-0000-0000000000a1'), 2, 'both rows are in the audit log (close + new)');
select throws_like($$update perf.commission_plan_rules set rate_pct = 9 where brand_id = current_setting('t58.derby')::uuid and effective_to is null$$,
  'COMMISSION_RULE_IMMUTABLE%', 'a rate row is never edited');
select throws_like($$update perf.commission_plan_rules set effective_to = tests.t58_cday(-4, 10) where brand_id = current_setting('t58.derby')::uuid and effective_to is not null$$,
  'PERIOD_CLOSED%', 'a rate''s end cannot move into a closed month');
select throws_like($$delete from perf.commission_plan_rules r using catalog.brands b where b.id = r.brand_id and b.code = 'BIONER'$$,
  'PERIOD_CLOSED%', 'a rate used by a closed month is never deleted');
select throws_like($$insert into perf.commission_plan_rules (plan_id, brand_id, rate_pct, effective_from) values (current_setting('t58.plan')::uuid, current_setting('t58.step')::uuid, 4, tests.t58_cday(-4, 5))$$,
  'PERIOD_CLOSED%', 'a new rate cannot start in a closed month');
select throws_like($$update perf.commission_plans set effective_from = tests.t58_cm(-6) where code = 'STD-2026'$$,
  'COMMISSION_PLAN_IMMUTABLE%', 'an active plan''s start never changes');
select throws_like($$update perf.commission_plans set status = 'draft' where code = 'STD-2026'$$,
  'INVALID_STATE%', 'an active plan never goes back to draft');
select throws_like($$delete from perf.commission_plans where code = 'STD-2026'$$,
  'COMMISSION_PLAN_IMMUTABLE%', 'an active plan is never deleted');

-- ===========================================================================
-- 8. The open months
-- ===========================================================================
select lives_ok($$select service.commission_calculate(tests.t58_cm(-3)), service.commission_calculate(tests.t58_cm(-2)),
                         service.commission_calculate(tests.t58_cm(-1)), service.commission_calculate(tests.t58_cm(0))$$,
  'the open months calculate (zero-value lines and an all-free invoice included)');

-- Partial payments and the bonus line
select is((select string_agg(e.base_amount || '@' || e.rate_pct || ':' || e.commission_amount, ' ' order by e.invoice_item_id)
           from perf.commission_entries e where e.source_id = tests.t58_id('58400000', 11)),
  '500.00@5.00:25.00 500.00@1.50:7.50',
  'partial payment: 1140 pays the kit and the bur pro rata (570 each) → bases 500.00 at Bioner 5 % and RDT 1.5 %');
select is(tests.t58_sum(tests.t58_id('58400000', 12)), 32.50::numeric, 'the second partial payment earns the same 32.50');
select is((select (sum(base_amount), sum(commission_amount), sum(gross_amount))::text from perf.commission_entries
           where invoice_id = tests.t58_id('58100000', 1)),
  '(2000.00,65.00,2280.00)', 'the two payments add up to the invoice net 2000.00 → 65.00 commission; 2280.00 collected');
select is((select count(*)::int from perf.commission_entries where invoice_item_id = tests.t58_item(1, 3)), 0,
  'the free (bonus) abutments have no commission row');
select is((select count(*)::int from perf.commission_entries where invoice_id = tests.t58_id('58100000', 6)), 0,
  'money on an invoice of free lines only earns nothing and raises nothing');

-- Returns: within 90 days (clawback), after 90 days (none)
select is(tests.t58_sum(tests.t58_id('58400000', 21)), 65.00::numeric, 'a full payment of an implant and Derby forceps earns 50.00 + 15.00');
select is((select e.entry_kind || ':' || e.base_amount || ':' || e.commission_amount || ':' || e.gross_amount || ':' || p.period_start
           from perf.commission_entries e join perf.commission_periods p on p.id = e.period_id
           where e.source_id = tests.t58_id('58500000', 21)),
  'credit_clawback:-1000.00:-50.00:-1140.00:' || tests.t58_cm(-2),
  'the implant returned 30 days after collection claws back its 50.00 in the month of the return');
select is((select sum(commission_amount) from perf.commission_entries where invoice_id = tests.t58_id('58100000', 2)), 15.00::numeric,
  'after the return the rep keeps 1.5 % of the forceps (15.00)');
select is((select count(*)::int from perf.commission_entries where source_id = tests.t58_id('58500000', 31)), 0,
  'a return 91 days after the collection claws nothing back');
select is((select sum(commission_amount) from perf.commission_entries where invoice_id = tests.t58_id('58100000', 3)), 50.00::numeric,
  'and the implant keeps its 50.00');

-- The rate edit applies from its effective date only
select is((select string_agg(e.rate_pct || ':' || e.commission_amount, ' ' order by e.event_date) from perf.commission_entries e
           where e.invoice_id = tests.t58_id('58100000', 4)),
  '1.50:15.00 2.50:25.00', 'Derby: the payment before day 15 earns 1.5 %, the one after 2.5 %');
select isnt((select rule_id from perf.commission_entries where source_id = tests.t58_id('58400000', 41)),
  (select rule_id from perf.commission_entries where source_id = tests.t58_id('58400000', 42)), 'each row names the rule it used');
select is((select string_agg(e.rate_pct::text, ',') from perf.commission_entries e where e.invoice_id = tests.t58_id('58100000', 2)
           and e.invoice_item_id = tests.t58_item(2, 2)), '1.50', 'the M-3 forceps collection keeps 1.5 %');

-- Unset STEP rate: 0, and listed as "no rate"
select is((select (rule_id is null, rate_pct, base_amount, commission_amount, gross_amount)::text from perf.commission_entries
           where source_id = tests.t58_id('58400000', 51)),
  '(t,0.00,1000.00,0.00,1140.00)', 'the STEP graft without a rate is commissionable at 0 %: base 1000.00, commission 0.00');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');
select is((select string_agg(sku, ',' order by sku) from api.commission_unrated(current_setting('t58.plan')::uuid)
           where sku like 'T58-%' or sku = 'BIO-TOP-4110'),
  'T58-GRAFT-1', 'the no-rate list shows the STEP graft and none of the products with a rate');
select is((select brand_code || '/' || category_code from api.commission_unrated(current_setting('t58.plan')::uuid) where sku = 'T58-GRAFT-1'),
  'STEP/GRAFT', 'with its brand and category');
select is((api.set_commission_rate(current_setting('t58.plan')::uuid, 'brand', current_setting('t58.step')::uuid, 3.00,
                                   tests.t58_cm(0)) ->> 'rate_pct')::numeric, 3.00::numeric,
  'the owner sets STEP at 3 % from the first of this month');
select is((select count(*)::int from api.commission_unrated(current_setting('t58.plan')::uuid) where sku = 'T58-GRAFT-1'), 0,
  'the graft leaves today''s no-rate list');
select is((select count(*)::int from api.commission_unrated(current_setting('t58.plan')::uuid, tests.t58_cday(-2, 8)) where sku = 'T58-GRAFT-1'), 1,
  'it stays on the list for a day before the rate starts');
select tests.clear_authentication();
select is((service.commission_calculate(tests.t58_cm(-2)) ->> 'changed')::boolean, false,
  'the new STEP rate does not reach back: M-2 recalculates unchanged');
select is(tests.t58_sum(tests.t58_id('58400000', 51)), 0.00::numeric, 'the graft collected in M-2 still earns 0.00');

-- ===========================================================================
-- 9. Rep statement totals: collected cash → commissionable (excl. VAT) → commission → clawbacks → net
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is((select (collected_gross, vat_amount, commissionable, unrated_base, commission, clawbacks, adjustments, net)::text
           from api.v_commission_statement_totals where period_start = tests.t58_cm(-3)),
  '(3420.00,420.00,3000.00,0.00,97.50,0.00,0.00,97.50)', 'M-3 statement: 3420.00 collected, 420.00 VAT, 3000.00 commissionable, 97.50');
select is((select (collected_gross, vat_amount, commissionable, unrated_base, commission, clawbacks, adjustments, net)::text
           from api.v_commission_statement_totals where period_start = tests.t58_cm(-2)),
  '(2280.00,280.00,2000.00,1000.00,32.50,-50.00,0.00,-17.50)',
  'M-2 statement: 2280.00 collected, 1000.00 of it without a rate, 32.50 earned, −50.00 return clawback, net −17.50');
select is((select net from api.v_commission_statement_totals where period_start = tests.t58_cm(-1)), 40.00::numeric,
  'M-1 statement: 15.00 + 25.00');
select is((select (period_status, net)::text from api.v_commission_statement_totals where period_start = tests.t58_cm(-4)),
  '(approved,50.00)', 'M-4 statement (closed): 50.00');
select is((select count(*)::int from api.v_commission_statement_totals where employee_id <> '20000000-0000-0000-0000-000000000004'), 0,
  'a rep sees only his own statement');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a5');
select is((select count(*)::int from api.v_commission_statement_totals), 0, 'another rep sees none of it');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a3');
select is((select count(*)::int from api.v_commission_statement_totals where employee_id = '20000000-0000-0000-0000-000000000004'), 4,
  'the area manager sees his team''s statements');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select is((select count(*)::int from api.v_commission_statement_totals),
  (select count(*)::int from (select distinct period_id, employee_id from perf.commission_entries) x), 'finance sees every statement');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a2');
select ok((select count(*) from api.v_commission_statement_totals) > 0, 'so does the sales director');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a8');
select is((select count(*)::int from api.v_commission_statement_totals), 0, 'without perf.commission.read: none');
select tests.clear_authentication();

-- ===========================================================================
-- 10. Deactivation: the plan applies to the days it covered and to none after
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');
select is(pg_temp.try($$select api.deactivate_commission_plan(current_setting('t58.plan')::uuid, core.business_date(), ' ')$$),
  'ERROR P0001 REASON_REQUIRED', 'deactivating needs a reason');
select is(pg_temp.try($$select api.deactivate_commission_plan(current_setting('t58.plan')::uuid, tests.t58_cday(-4, 10), 'test end')$$),
  'ERROR P0001 PERIOD_CLOSED', 'a plan cannot end inside a closed month');
select is((api.deactivate_commission_plan(current_setting('t58.plan')::uuid, core.business_date(), 'test: the plan ends today')
           ->> 'assignments_ended')::int, 2, 'the owner deactivates STD-2026 from tomorrow; the assignments end today');
select is((api.deactivate_commission_plan(current_setting('t58.plan')::uuid, core.business_date(), 'test: the plan ends today')
           ->> 'replayed')::boolean, true, 'deactivating again is a replay');
select is(pg_temp.try($$select api.set_commission_rate(current_setting('t58.plan')::uuid, 'brand', current_setting('t58.step')::uuid, 4, core.business_date())$$),
  'ERROR P0001 INVALID_STATE', 'a retired plan takes no new rate');
select tests.clear_authentication();
select is(perf.commission_plan_for('20000000-0000-0000-0000-000000000004', core.business_date()), current_setting('t58.plan')::uuid,
  'the retired plan still applies on its last day');
select is(perf.commission_plan_for('20000000-0000-0000-0000-000000000004', core.business_date() + 1), null::uuid,
  'and on no day after it');
select is((service.commission_calculate(tests.t58_cm(-1)) ->> 'changed')::boolean, false,
  'the open months it covered keep their commission');
select throws_like($$update perf.commission_plans set retire_reason = 'rewritten' where code = 'STD-2026'$$,
  'COMMISSION_PLAN_IMMUTABLE%', 'a retired plan never changes');

select * from finish();
rollback;
