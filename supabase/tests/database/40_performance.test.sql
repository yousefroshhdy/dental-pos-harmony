-- Suite 40: database performance guards (TESTING.md §2.9, DATABASE.md §5).
--
--   1. Every foreign key in the domain schemas has a covering index whose leading columns are
--      the FK columns (non-partial, or partial on `fk is not null` only). A failure lists the
--      offending FKs, one per line, with a ready-to-paste `create index` statement. Other
--      modules add tables in parallel: add their FK indexes when this fails at merge.
--   2. On a synthetic dataset (5k customers, 50k movements, 20k visits, 10k orders and
--      invoices, ~7k payments, ~17k ledger entries; generated below, rolled back at the end)
--      the key list queries plan through indexes, not sequential scans of their large tables,
--      and the authz scope helpers are evaluated as InitPlans (once per statement), never in a
--      per-row filter.
--   3. Executing those queries calls the authz scope helpers a bounded number of times,
--      independent of row counts (catches per-row calls hidden inside SQL functions, which
--      EXPLAIN cannot see). Needs track_functions, so it runs only as a superuser.
--
-- Plans are read from EXPLAIN (FORMAT JSON) without ANALYZE: no timing, so no flakiness.
-- Synthetic data is obviously fake ("Synthetic Clinic 00042") and never committed.
begin;
select plan(25);

-- ---------------------------------------------------------------------------
-- 1. Foreign-key coverage
-- ---------------------------------------------------------------------------
select is(
  (select coalesce(string_agg(format('%s.%s (%s) -> %s  [create index if not exists idx_%s_%s on %s.%s (%s);]',
                                     fk.nsp, fk.tbl, fk.cols, fk.target, fk.tbl, replace(fk.cols, ', ', '_'),
                                     fk.nsp, fk.tbl, fk.cols),
                              E'\n#     ' order by fk.nsp, fk.tbl, fk.cols), '')
   from (
     select n.nspname as nsp, t.relname as tbl, c.conrelid, c.conkey, c.confrelid::regclass::text as target,
            (select string_agg(quote_ident(a.attname), ', ' order by k.ord)
             from unnest(c.conkey) with ordinality k(attnum, ord)
             join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum) as cols
     from pg_constraint c
     join pg_class t on t.oid = c.conrelid
     join pg_namespace n on n.oid = t.relnamespace
     where c.contype = 'f'
       and n.nspname in ('core','authz','catalog','inventory','crm','field','work','sales','finance',
                         'perf','wf','audit','notify','integration')
   ) fk
   where not exists (
     select 1 from pg_index i
     where i.indrelid = fk.conrelid
       -- a partial index serves the referential check only when its predicate is implied by
       -- `fk = $1`, i.e. `fk is not null` on a one-column FK
       and (i.indpred is null
            or (cardinality(fk.conkey) = 1
                and pg_get_expr(i.indpred, i.indrelid) = '(' || fk.cols || ' IS NOT NULL)'))
       and (i.indkey::int2[])[0:cardinality(fk.conkey) - 1] @> fk.conkey
       and (i.indkey::int2[])[0:cardinality(fk.conkey) - 1] <@ fk.conkey)),
  '',
  'every foreign key in the domain schemas has a covering index'
);

-- ---------------------------------------------------------------------------
-- Synthetic dataset (as the test superuser / table owner, triggers off for the bulk load)
-- ---------------------------------------------------------------------------
select tests.load_fixture();

alter table core.employees disable trigger user;
alter table crm.customers disable trigger user;
alter table crm.customer_assignments disable trigger user;
alter table catalog.product_variants disable trigger user;
alter table inventory.warehouses disable trigger user;
alter table inventory.movements disable trigger user;
alter table sales.orders disable trigger user;
alter table finance.invoices disable trigger user;
alter table finance.customer_ledger disable trigger user;
alter table finance.payments disable trigger user;
alter table finance.payment_allocations disable trigger user;
alter table field.visits disable trigger user;

do $$
declare v_cai uuid; v_delta uuid; v_nasr uuid := '10000000-0000-0000-0000-000000000003';
begin
  select id into v_cai   from core.territories where code = 'CAI-GIZ';
  select id into v_delta from core.territories where code = 'DELTA';

  -- 40 synthetic reps without logins: 1..20 report to the Cairo area manager (fixture E003),
  -- 21..40 to the sales director (E002). With fixture reps E004/E005: 42 reps.
  insert into core.employees (id, employee_no, full_name_en, job_title, manager_id)
  select ('20000000-0000-0000-0001-' || lpad(to_hex(r), 12, '0'))::uuid, 'SYN-' || r, 'Synthetic Rep ' || r,
         'Sales Representative',
         case when r <= 20 then '20000000-0000-0000-0000-000000000003'::uuid
              else '20000000-0000-0000-0000-000000000002'::uuid end
  from generate_series(1, 40) r;

  -- 5k customers: 40% Nasr City, 30% Cairo & Giza, 30% Delta; 2% archived; ~119 per rep.
  create temp table syn_cust on commit drop as
  select i,
         ('40000000-0000-0000-0001-' || lpad(to_hex(i), 12, '0'))::uuid as id,
         case when i % 10 < 4 then v_nasr when i % 10 < 7 then v_cai else v_delta end as territory_id,
         case i % 42 when 0 then '20000000-0000-0000-0000-000000000004'::uuid
                     when 1 then '20000000-0000-0000-0000-000000000005'::uuid
                     else ('20000000-0000-0000-0001-' || lpad(to_hex(i % 42 - 1), 12, '0'))::uuid end as rep_id
  from generate_series(1, 5000) i;

  insert into crm.customers (id, customer_no, doctor_name, display_name, territory_id, lifecycle_stage,
                             governorate_code, created_at, archived_at)
  select id, 'SYN-' || lpad(i::text, 5, '0'), 'Synthetic Doctor ' || i, 'Synthetic Clinic ' || lpad(i::text, 5, '0'),
         territory_id, (array['lead','prospect','active','dormant'])[1 + i % 4],
         case when territory_id = v_delta then 'EG-DK' else 'EG-C' end,
         now() - make_interval(days => i % 400),
         case when i % 50 = 0 then now() end
  from syn_cust;

  insert into crm.customer_assignments (customer_id, employee_id, valid_from)
  select id, rep_id, now() - interval '200 days' from syn_cust;
  insert into crm.customer_assignments (customer_id, employee_id, valid_from, valid_to)   -- history
  select id, '20000000-0000-0000-0001-000000000001', now() - interval '400 days', now() - interval '200 days'
  from syn_cust where i % 5 = 0;

  -- 20 variants with one lot each, a second warehouse, 50k movements over ~1 year.
  insert into catalog.product_variants (id, product_id, sku, name_en)
  select ('53000000-0000-0000-0001-' || lpad(to_hex(v), 12, '0'))::uuid, '52000000-0000-0000-0000-000000000001',
         'SYN-SKU-' || v, 'Synthetic variant ' || v
  from generate_series(1, 20) v;
  insert into inventory.lots (id, variant_id, lot_no, expiry_date)
  select ('61000000-0000-0000-0001-' || lpad(to_hex(v), 12, '0'))::uuid,
         ('53000000-0000-0000-0001-' || lpad(to_hex(v), 12, '0'))::uuid, 'SYN-L' || v, date '2030-01-01' + v
  from generate_series(1, 20) v;
  insert into inventory.warehouses (id, code, name, kind) values
    ('60000000-0000-0000-0000-000000000099', 'WH-SYN', 'Synthetic branch', 'branch');
  insert into inventory.movements (movement_type, warehouse_id, variant_id, lot_id, quantity, created_at)
  select case when k % 4 = 0 then 'receipt' else 'sale_issue' end,
         case when k % 2 = 0 then '60000000-0000-0000-0000-000000000001'::uuid
              else '60000000-0000-0000-0000-000000000099'::uuid end,
         ('53000000-0000-0000-0001-' || lpad(to_hex(1 + k % 20), 12, '0'))::uuid,
         ('61000000-0000-0000-0001-' || lpad(to_hex(1 + k % 20), 12, '0'))::uuid,
         case when k % 4 = 0 then 10 else -1 end,
         now() - make_interval(secs => k * 600)
  from generate_series(1, 50000) k;

  -- 10k orders over a year, one invoice each (30% open), payments and ledger entries.
  create temp table syn_ord on commit drop as
  select j, ('70000000-0000-0000-0001-' || lpad(to_hex(j), 12, '0'))::uuid as id,
         ('71000000-0000-0000-0001-' || lpad(to_hex(j), 12, '0'))::uuid as invoice_id,
         ('72000000-0000-0000-0001-' || lpad(to_hex(j), 12, '0'))::uuid as payment_id,
         c.id as customer_id, c.rep_id, c.territory_id,
         now() - make_interval(days => j % 365, secs => j) as at,
         (array['draft','submitted','pending_approval','approved','invoiced','invoiced','invoiced',
                'invoiced','closed','cancelled'])[1 + j % 10] as status,
         (array['issued','partially_paid','issued','paid','paid','paid','paid','paid','paid',
                'credited'])[1 + (j / 10) % 10] as inv_status
  from generate_series(1, 10000) j join syn_cust c on c.i = 1 + (j * 7) % 5000;

  insert into sales.orders (id, order_no, customer_id, employee_id, territory_id, status, subtotal, tax_total, total,
                            submitted_at, approved_at, created_at, updated_at)
  select id, 'SO-SYN-' || j, customer_id, rep_id, territory_id, status, 1000, 140, 1140,
         case when status <> 'draft' then at end,
         case when status not in ('draft','submitted','pending_approval','cancelled') then at + interval '2 hours' end,
         at, at
  from syn_ord;
  insert into finance.invoices (id, invoice_no, order_id, customer_id, issue_date, due_date, status,
                                subtotal, tax_total, total, created_at)
  select invoice_id, 'INV-SYN-' || j, id, customer_id, (at at time zone 'Africa/Cairo')::date,
         (at at time zone 'Africa/Cairo')::date + 30, inv_status, 1000, 140, 1140, at
  from syn_ord;
  insert into finance.customer_ledger (customer_id, entry_type, amount, source_table, source_id, posted_at)
  select customer_id, 'invoice', 1140, 'finance.invoices', invoice_id, at from syn_ord;

  insert into finance.payments (id, payment_no, customer_id, collected_by, method, amount, received_at, status, confirmed_at)
  select payment_id, 'PAY-SYN-' || j, customer_id, rep_id, 'cash',
         case when inv_status = 'paid' then 1140 else 500 end, at + interval '5 days', 'confirmed', at + interval '6 days'
  from syn_ord where inv_status in ('paid', 'partially_paid');
  insert into finance.payment_allocations (payment_id, invoice_id, amount, allocated_at)
  select payment_id, invoice_id, case when inv_status = 'paid' then 1140 else 500 end, at + interval '6 days'
  from syn_ord where inv_status in ('paid', 'partially_paid');
  insert into finance.customer_ledger (customer_id, entry_type, amount, source_table, source_id, posted_at)
  select customer_id, 'payment', case when inv_status = 'paid' then -1140 else -500 end, 'finance.payments',
         payment_id, at + interval '6 days'
  from syn_ord where inv_status in ('paid', 'partially_paid');

  -- 20k visits over 180 days: 60% completed, 20% planned, 10% cancelled, 10% missed.
  insert into field.visits (id, customer_id, employee_id, planned_for, status, check_in_at, check_out_at,
                            verification_status, created_at)
  select ('73000000-0000-0000-0001-' || lpad(to_hex(k), 12, '0'))::uuid, c.id, c.rep_id,
         current_date - (k % 180), s.status,
         case when s.status = 'completed' then (current_date - (k % 180)) + time '10:00' + make_interval(mins => k % 300) end,
         case when s.status = 'completed' then (current_date - (k % 180)) + time '10:30' + make_interval(mins => k % 300) end,
         case when s.status = 'completed' then 'verified' else 'pending' end,
         now() - make_interval(days => k % 180)
  from generate_series(1, 20000) k
  join syn_cust c on c.i = 1 + (k * 13) % 5000
  cross join lateral (select (array['completed','completed','completed','completed','completed','completed',
                                    'planned','planned','cancelled','missed'])[1 + k % 10] as status) s;
end $$;

alter table core.employees enable trigger user;
alter table crm.customers enable trigger user;
alter table crm.customer_assignments enable trigger user;
alter table catalog.product_variants enable trigger user;
alter table inventory.warehouses enable trigger user;
alter table inventory.movements enable trigger user;
alter table sales.orders enable trigger user;
alter table finance.invoices enable trigger user;
alter table finance.customer_ledger enable trigger user;
alter table finance.payments enable trigger user;
alter table finance.payment_allocations enable trigger user;
alter table field.visits enable trigger user;

analyze crm.customers;
analyze crm.customer_assignments;
analyze core.employees;
analyze inventory.movements;
analyze sales.orders;
analyze finance.invoices;
analyze finance.customer_ledger;
analyze finance.payments;
analyze finance.payment_allocations;
analyze field.visits;

select is(
  (select format('%s customers, %s movements, %s visits, %s orders, %s invoices',
                 (select count(*) from crm.customers), (select count(*) from inventory.movements),
                 (select count(*) from field.visits), (select count(*) from sales.orders),
                 (select count(*) from finance.invoices))),
  '5002 customers, 50000 movements, 20000 visits, 10000 orders, 10000 invoices',
  'synthetic dataset loaded'
);

-- ---------------------------------------------------------------------------
-- Plan capture and inspection helpers (session-local)
-- ---------------------------------------------------------------------------
create temp table perf_plans (q text primary key, plan jsonb) on commit drop;
grant insert, select on perf_plans to authenticated;

-- EXPLAIN (FORMAT JSON) as the current (authenticated) role, so RLS is in the plan.
create function pg_temp.capture(p_q text, p_sql text) returns void language plpgsql as $$
declare j json;
begin
  execute 'explain (format json) ' || p_sql into j;
  insert into pg_temp.perf_plans values (p_q, j::jsonb);
end $$;

-- Every plan node, flagged when it sits inside an InitPlan (evaluated once per statement).
create function pg_temp.nodes(p_q text) returns table (node jsonb, in_init boolean) language sql as $$
  with recursive n(node, in_init) as (
    select p.plan->0->'Plan', false from pg_temp.perf_plans p where p.q = p_q
    union all
    select c, n.in_init or c->>'Parent Relationship' = 'InitPlan'
    from n cross join lateral jsonb_array_elements(coalesce(n.node->'Plans', '[]'::jsonb)) c
  ) select * from n
$$;

-- Sequential scans of the given tables ('' = none).
create function pg_temp.seq_scans(p_q text, p_tables text[]) returns text language sql as $$
  select coalesce(string_agg(distinct node->>'Relation Name', ', '), '')
  from pg_temp.nodes(p_q) where node->>'Node Type' = 'Seq Scan' and node->>'Relation Name' = any(p_tables)
$$;

create function pg_temp.uses_index(p_q text, p_index text) returns boolean language sql as $$
  select exists (select 1 from pg_temp.nodes(p_q) where node->>'Index Name' = p_index)
$$;

-- authz helpers are InitPlans: at least one InitPlan exists, and no node outside an InitPlan
-- calls authz.* in a per-row condition or as a function scan ('' = clean).
create function pg_temp.per_row_authz(p_q text) returns text language sql as $$
  select case when not exists (select 1 from pg_temp.nodes(p_q) where in_init) then 'no InitPlan in the plan'
    else coalesce((select string_agg(distinct node->>'Node Type' || ': ' || left(x.cond, 120), ' | ')
                   from pg_temp.nodes(p_q)
                   cross join lateral (values (node->>'Filter'), (node->>'Join Filter'), (node->>'Index Cond'),
                                              (node->>'Recheck Cond'), (node->>'Hash Cond'),
                                              (case when node->>'Node Type' = 'Function Scan'
                                                     and node->>'Function Name' in ('has_global','has_permission','territory_ids',
                                                         'employee_ids','assigned_customer_ids','warehouse_ids','grants',
                                                         'tracking_employee_ids')
                                                    then 'authz.' || (node->>'Function Name') end)) x(cond)
                   where not in_init and x.cond like '%authz.%'), '') end
$$;

-- ---------------------------------------------------------------------------
-- 2. Plans of the key queries (shapes copied from src/modules/*/queries.ts)
-- ---------------------------------------------------------------------------
-- Rep (own scope): customer list page, visits list, today.
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select pg_temp.capture('customers_rep',
  'select id, customer_no, display_name, lifecycle_stage, territory_id, primary_rep_employee_id, balance
     from api.v_customers where archived_at is null order by display_name, id limit 25 offset 0');
select pg_temp.capture('visits_rep',
  'select * from api.v_visits order by check_in_at desc nulls first, planned_for desc nulls last, created_at desc limit 50');
select pg_temp.capture('today_rep', 'select * from api.v_my_today order by due_at nulls last');
-- The ledger scan inside crm.customer_balances_in_scope() is invisible from the view's plan:
-- explain the function body itself, as the rep.
select pg_temp.capture('balances_rep',
  (select p.prosrc from pg_proc p where p.oid = 'crm.customer_balances_in_scope()'::regprocedure));
select tests.clear_authentication();

-- Area manager (team / territory scope): order list, visits list.
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a3');
select pg_temp.capture('orders_manager', 'select * from api.v_orders order by created_at desc limit 50');
select pg_temp.capture('visits_manager',
  'select * from api.v_visits order by check_in_at desc nulls first, planned_for desc nulls last, created_at desc limit 50');
select tests.clear_authentication();

-- Finance officer (all): aging, invoice list, payment list.
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select pg_temp.capture('aging_finance', 'select * from api.v_ar_aging order by overdue_amount desc limit 1000');
select pg_temp.capture('invoices_finance',
  'select * from api.v_invoices order by issue_date desc, invoice_no desc limit 50');
select pg_temp.capture('payments_finance', 'select * from api.v_payments order by received_at desc limit 50');
select tests.clear_authentication();

-- Inventory manager: movement list.
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a8');
select pg_temp.capture('movements_inventory', 'select * from api.v_movements order by created_at desc, id limit 100');
select tests.clear_authentication();

-- Customer list (rep)
select ok(pg_temp.uses_index('customers_rep', 'idx_customers_display_name_id'),
  'customer list (rep): ordered index scan on idx_customers_display_name_id');
select is(pg_temp.seq_scans('customers_rep', array['customers','customer_assignments','customer_ledger']), '',
  'customer list (rep): no seq scan on customers / assignments / ledger');
select is(pg_temp.per_row_authz('customers_rep'), '', 'customer list (rep): authz helpers are InitPlans');
select is(pg_temp.per_row_authz('balances_rep'), '',
  'crm.customer_balances_in_scope: scope helpers once per call, not per ledger row');

-- Order list (area manager)
select ok(pg_temp.uses_index('orders_manager', 'idx_orders_created_at'),
  'order list (manager): index scan on idx_orders_created_at');
select is(pg_temp.seq_scans('orders_manager', array['orders','customers','employees']), '',
  'order list (manager): no seq scan on orders / customers / employees');
select is(pg_temp.per_row_authz('orders_manager'), '', 'order list (manager): authz helpers are InitPlans');

-- Visits list (rep and manager) and today
select ok(pg_temp.uses_index('visits_rep', 'idx_visits_check_in_at_planned_for_created_at'),
  'visits list (rep): index scan in list order');
select is(pg_temp.seq_scans('visits_rep', array['visits']), '', 'visits list (rep): no seq scan on visits');
select is(pg_temp.per_row_authz('visits_rep'), '', 'visits list (rep): authz helpers are InitPlans');
select ok(pg_temp.uses_index('visits_manager', 'idx_visits_check_in_at_planned_for_created_at')
          and pg_temp.seq_scans('visits_manager', array['visits']) = '',
  'visits list (manager): index scan in list order, no seq scan on visits');
select is(pg_temp.per_row_authz('visits_manager'), '', 'visits list (manager): authz helpers are InitPlans');
select ok(pg_temp.uses_index('today_rep', 'idx_visits_employee_id_planned_for')
          and pg_temp.seq_scans('today_rep', array['visits','customers']) = '',
  'my today (rep): visits through idx_visits_employee_id_planned_for');

-- Aging (finance)
select is(pg_temp.seq_scans('aging_finance', array['invoices','customer_ledger','payment_allocations','payments']), '',
  'aging (finance): no seq scan on invoices / ledger / allocations / payments');
select ok(pg_temp.uses_index('aging_finance', 'invoices_due_date_idx'),
  'aging (finance): open invoices through the partial open-invoice index');
select is(pg_temp.per_row_authz('aging_finance'), '', 'aging (finance): authz helpers are InitPlans');

-- Invoice, payment and movement lists
select ok(pg_temp.uses_index('invoices_finance', 'idx_invoices_issue_date_invoice_no')
          and pg_temp.seq_scans('invoices_finance', array['invoices']) = '',
  'invoice list (finance): index scan in list order');
select ok(pg_temp.uses_index('payments_finance', 'idx_payments_received_at')
          and pg_temp.seq_scans('payments_finance', array['payments']) = '',
  'payment list (finance): index scan in list order');
select ok(pg_temp.uses_index('movements_inventory', 'idx_movements_created_at_id')
          and pg_temp.seq_scans('movements_inventory', array['movements']) = '',
  'movement list (inventory): index scan in list order');

-- ---------------------------------------------------------------------------
-- 3. Executed: authz scope helpers are called a bounded number of times per statement
-- ---------------------------------------------------------------------------
-- Counts calls of the scope helpers (pg_stat_xact_user_functions) around one execution.
-- Before 20261103000700 the rep's customer page made > 50,000 such calls (one per ledger row).
create temp table perf_calls (q text primary key, calls bigint) on commit drop;

create function pg_temp.helper_calls() returns bigint language sql as $$
  select coalesce(sum(f.calls), 0)::bigint from pg_stat_xact_user_functions f
  where f.schemaname = 'authz'
    and f.funcname in ('has_global','has_permission','territory_ids','employee_ids','assigned_customer_ids',
                       'warehouse_ids','grants','tracking_employee_ids')
$$;

do $$
declare
  v_super boolean := (select rolsuper from pg_roles where rolname = current_user);
  v_before bigint; r record;
begin
  if not v_super then return; end if;
  perform set_config('track_functions', 'all', true);
  perform set_config('jit', 'off', true);
  for r in select * from (values
      ('customers_rep', '00000000-0000-0000-0000-0000000000a4',
       'select count(*) from (select id, balance from api.v_customers where archived_at is null order by display_name, id limit 25) x'),
      ('orders_manager', '00000000-0000-0000-0000-0000000000a3',
       'select count(*) from (select * from api.v_orders order by created_at desc limit 50) x'),
      ('visits_manager', '00000000-0000-0000-0000-0000000000a3',
       'select count(*) from (select * from api.v_visits order by check_in_at desc nulls first limit 50) x'),
      ('aging_finance', '00000000-0000-0000-0000-0000000000a6',
       'select count(*) from (select * from api.v_ar_aging order by overdue_amount desc limit 1000) x')
    ) v(q, uid, sql)
  loop
    v_before := pg_temp.helper_calls();
    perform tests.authenticate_as(r.uid::uuid);
    execute r.sql;
    perform tests.clear_authentication();
    insert into pg_temp.perf_calls values (r.q, pg_temp.helper_calls() - v_before);
  end loop;
end $$;

select ok(coalesce((select calls from perf_calls where q = 'customers_rep') <= 60, true),
  'customer list (rep): scope helpers called a bounded number of times (' ||
  coalesce((select calls::text from perf_calls where q = 'customers_rep'), 'skipped: not superuser') || ')');
select ok(coalesce((select calls from perf_calls where q = 'orders_manager') <= 60, true),
  'order list (manager): scope helpers called a bounded number of times (' ||
  coalesce((select calls::text from perf_calls where q = 'orders_manager'), 'skipped: not superuser') || ')');
select ok(coalesce((select calls from perf_calls where q = 'visits_manager') <= 60, true),
  'visits list (manager): scope helpers called a bounded number of times (' ||
  coalesce((select calls::text from perf_calls where q = 'visits_manager'), 'skipped: not superuser') || ')');
select ok(coalesce((select calls from perf_calls where q = 'aging_finance') <= 60, true),
  'aging (finance): scope helpers called a bounded number of times (' ||
  coalesce((select calls::text from perf_calls where q = 'aging_finance'), 'skipped: not superuser') || ')');

select * from finish();
rollback;
