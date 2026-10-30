-- Honest OS migration: KPI metric functions and basic dashboards (ROADMAP Phase 5, MVP slice).
-- Design: docs/DASHBOARDS.md §1–2 (metric rules, KPI catalogue), ADR-015 (formulas are
-- code-registered SQL functions; definitions and targets are data). Tests: suite 29.
--
--   perf.metric_*            one registered function per metric_key (the whitelist)
--   perf.compute_metric      dispatcher: metric_key → static call (no dynamic SQL)
--   perf.*_target            target resolution (employee > role; territory for territory totals)
--   api.kpi_summary          tiles: one row per active KPI for the caller's scope
--   api.kpi_team             per-employee values (team table)
--   api.kpi_breakdown        totals by root territory or by brand
--   api.kpi_overdue_customers  overdue customers attributed to the scope
--   api.set_kpi_target       perf.target.manage
--   api.v_kpi_targets        targets visible to the caller
--   service.snapshot_kpis    nightly snapshot into perf.kpi_results (service_role only)
--
-- Scope (perf.kpi.read): all → company; own/team → authz.employee_ids; territory → employees
-- assigned to those territories. Computed in Postgres only; a filter that names an employee
-- outside the scope is refused (42501). Everything is attributed to an employee:
--   visits → visit employee · orders/fulfilments → order employee (+ territory snapshot)
--   invoices/credit notes → order employee, else the customer's primary rep
--   payments → collected_by · AR → customer's current primary rep · approvals → subject employee
-- Days are Cairo calendar days (perf.cairo_start), never the session's or UTC's.
--
-- Additive only: two new nullable/defaulted columns on perf.kpi_definitions, a widened unit
-- CHECK (adds 'minutes','hours'), new definitions, draft → active for the implemented seeds,
-- new policies on tables that had none (deny-by-default until now), new functions and a view.

-- ---------------------------------------------------------------------------
-- 1. KPI definitions (reference data)
-- ---------------------------------------------------------------------------
alter table perf.kpi_definitions drop constraint if exists kpi_definitions_unit_check;
alter table perf.kpi_definitions add constraint kpi_definitions_unit_check
  check (unit in ('count','pct','egp','ratio','minutes','hours'));
-- Point-in-time KPIs (AR, alerts, pending approvals) are measured "as of" the period end
-- (capped at today) and their targets are not pro-rated over the period.
alter table perf.kpi_definitions add column if not exists is_point_in_time boolean not null default false;

insert into perf.kpi_definitions (code, name_en, name_ar, definition, formula, metric_key, data_source,
                                  indicator_type, period_type, unit, higher_is_better, is_point_in_time, status) values
  ('VISITS_PLANNED','Planned visits','الزيارات المخططة','Visits planned for the period, one per customer per day (cancelled excluded)',
   'count(distinct customer_id, planned_for) where status <> cancelled','perf.metric_visits_planned','field.visits','leading','month','count',true,false,'active'),
  ('VISIT_AVG_MINUTES','Average visit duration','متوسط مدة الزيارة','Average time from check-in to check-out of completed visits',
   'avg(check_out_at − check_in_at) in minutes','perf.metric_visit_avg_minutes','field.visits','leading','month','minutes',true,false,'active'),
  ('CUSTOMERS_ADDED','Customers added','عملاء مضافون','Customer records created in the period (leads included), by the employee who created them',
   'count(customers created in period)','perf.metric_customers_added','crm.customers','leading','month','count',true,false,'active'),
  ('ORDERS_BOOKED','Orders booked','الطلبات المسجلة','Orders submitted in the period, minus later cancellations/rejections',
   'count(submitted) − count(cancelled/rejected); a cancellation after the period closed reverses in the cancellation period','perf.metric_orders_booked','sales.orders, sales.order_status_history','leading','month','count',true,false,'active'),
  ('BOOKED_SALES','Booked sales','المبيعات المسجلة','Value of booked orders, excluding VAT (orders are pipeline, not revenue)',
   'Σ (subtotal − discount_total) of booked orders, same reversal rule as ORDERS_BOOKED','perf.metric_booked_sales','sales.orders, sales.order_status_history','leading','month','egp',true,false,'active'),
  ('APPROVAL_TURNAROUND_HOURS','Order approval turnaround','زمن اعتماد الطلبات','Average hours from submit to approval for orders approved in the period',
   'avg(approved_at − submitted_at) in hours','perf.metric_approval_turnaround_hours','sales.orders','leading','month','hours',false,false,'active'),
  ('SALES_FULFILLED','Sales fulfilled','المبيعات المسلّمة','Value of posted fulfilments, excluding VAT',
   'Σ fulfilled qty × (line_subtotal − line_discount) ÷ qty','perf.metric_sales_fulfilled','sales.fulfillments, sales.order_items','lagging','month','egp',true,false,'active'),
  ('NET_REVENUE','Net invoiced revenue','صافي الإيرادات المفوترة','Invoiced revenue excluding VAT, minus credit notes (excl. VAT) issued in the period',
   'Σ (invoice subtotal − discount_total) − Σ credit_note.amount','perf.metric_net_revenue','finance.invoices, finance.credit_notes','lagging','month','egp',true,false,'active'),
  ('CASH_COLLECTED','Collections confirmed','التحصيلات المؤكدة','Confirmed payments received in the period (cash, VAT included)',
   'Σ payments.amount where status = confirmed, by received_at','perf.metric_cash_collected','finance.payments','lagging','month','egp',true,false,'active'),
  ('AR_OPEN','Open receivables','الذمم المفتوحة','Amount customers owe at the end of the period (VAT included)',
   'Σ max(customer ledger balance, 0) as of period end','perf.metric_ar_open','finance.customer_ledger','lagging','month','egp',false,true,'active'),
  ('AR_OVERDUE','Overdue receivables','الذمم المتأخرة','Open amount of invoices past their due date at the end of the period (VAT included)',
   'Σ (total − allocations − credit notes incl. VAT) where due_date < as-of date','perf.metric_ar_overdue','finance.invoices, finance.payment_allocations, finance.credit_notes','lagging','month','egp',false,true,'active'),
  ('STOCK_ALERTS','Stock alerts','تنبيهات المخزون','Variants at or below reorder point plus lots expiring within 90 days (company level)',
   'count(reorder alerts) + count(sellable lots with stock expiring ≤ 90 days)','perf.metric_stock_alerts','inventory.stock_balances, inventory.lots, catalog.product_variants','leading','month','count',false,true,'active'),
  ('PENDING_APPROVALS','Pending approvals','الموافقات المعلقة','Approval requests waiting for a decision, about employees in scope',
   'count(approval_requests where status = pending)','perf.metric_pending_approvals','wf.approval_requests','leading','month','count',false,true,'active')
on conflict (code) do nothing;

-- The two seeded KPIs whose metric functions now exist become active.
update perf.kpi_definitions set status = 'active'
 where code in ('VISITS_COMPLETED','VISITS_VERIFIED_PCT','NEW_ACCOUNTS') and status = 'draft';

-- ---------------------------------------------------------------------------
-- 2. Building blocks (internal; invoker functions called from definer api/service code)
-- ---------------------------------------------------------------------------
create type perf.metric_result as (
  value      numeric,     -- NULL = not applicable / no denominator
  detail     jsonb,       -- the inputs of the formula (counts, numerator, denominator)
  source_ids uuid[]       -- the records used (drill-down / reproducibility)
);

-- Start of a Cairo calendar day as an instant (DST-aware).
create or replace function perf.cairo_start(p_day date) returns timestamptz
language sql stable set search_path = '' as $$
  select (p_day::timestamp at time zone 'Africa/Cairo')
$$;

-- When the period containing p_day closes: the start of day 6 of the next month (Cairo).
create or replace function perf.period_close_at(p_day date) returns timestamptz
language sql stable set search_path = '' as $$
  select perf.cairo_start((date_trunc('month', p_day) + interval '1 month' + interval '5 days')::date)
$$;

-- A territory and all its descendants.
create or replace function perf.territory_tree(p_territory_id uuid) returns uuid[]
language sql stable set search_path = '' as $$
  with recursive tree as (
    select t.id from core.territories t where t.id = p_territory_id
    union
    select c.id from core.territories c join tree on c.parent_id = tree.id
  )
  select coalesce(array_agg(id), '{}') from tree
$$;

-- Employees whose KPIs the caller may read (NULL = everyone).
create or replace function perf.kpi_scope_employee_ids() returns uuid[]
language sql stable set search_path = '' as $$
  select case when authz.has_global('perf.kpi.read') then null::uuid[]
    else coalesce(array(
      select unnest(authz.employee_ids('perf.kpi.read'))
      union
      select et.employee_id from core.employee_territories et
       where et.valid_to is null and et.territory_id = any(authz.territory_ids('perf.kpi.read'))), '{}') end
$$;

create or replace function perf.check_period(p_from date, p_to date) returns void
language plpgsql immutable set search_path = '' as $$
begin
  if p_from is null or p_to is null or p_to < p_from then
    raise exception 'VALIDATION: the period end must be on or after its start' using errcode = 'P0001';
  end if;
  if p_to - p_from > 366 then
    raise exception 'VALIDATION: the period cannot exceed 366 days' using errcode = 'P0001';
  end if;
end $$;

-- Current primary rep of a customer (AR and invoice fallback attribution).
create or replace function perf.primary_rep(p_customer_id uuid) returns uuid
language sql stable set search_path = '' as $$
  select a.employee_id from crm.customer_assignments a
  where a.customer_id = p_customer_id and a.role = 'primary_rep' and a.valid_to is null
$$;

-- Employees measured individually in [p_from, p_to] within a scope (NULL = all): active
-- employees whose roles grant perf.kpi.read at own scope (reps), plus anyone with a
-- completed visit or a submitted order in the period, so team rows reconcile with totals.
create or replace function perf.roster(p_scope uuid[], p_from date, p_to date) returns setof uuid
language sql stable set search_path = '' as $$
  select e.id from core.employees e
  where e.employment_status in ('active','on_leave')
    and (p_scope is null or e.id = any(p_scope))
    and (exists (select 1 from authz.user_roles ur
                 join authz.roles r on r.id = ur.role_id and r.is_active
                 join authz.role_permissions rp on rp.role_id = ur.role_id
                  and rp.permission_code = 'perf.kpi.read' and rp.scope = 'own'
                 where ur.user_id = e.user_id and ur.revoked_at is null and ur.valid_from <= now()
                   and (ur.valid_to is null or ur.valid_to > now()))
      or exists (select 1 from field.visits v where v.employee_id = e.id and v.status = 'completed'
                   and v.check_in_at >= perf.cairo_start(p_from) and v.check_in_at < perf.cairo_start(p_to + 1))
      or exists (select 1 from sales.orders o where o.employee_id = e.id
                   and o.submitted_at >= perf.cairo_start(p_from) and o.submitted_at < perf.cairo_start(p_to + 1)))
$$;

-- ---------------------------------------------------------------------------
-- 3. Metric functions. Signature: (employees, territories, from, to); NULL array = no filter.
-- ---------------------------------------------------------------------------

-- Completed visits in the period (Cairo day of check-in), with their customer-day.
create or replace function perf.completed_visits(p_emp uuid[], p_terr uuid[], p_from date, p_to date)
returns table (visit_id uuid, customer_id uuid, local_day date, verified boolean, minutes numeric)
language sql stable set search_path = '' as $$
  select v.id, v.customer_id, (v.check_in_at at time zone 'Africa/Cairo')::date,
         v.verification_status in ('verified','exception_approved'),
         case when v.check_out_at is not null then extract(epoch from v.check_out_at - v.check_in_at) / 60 end
  from field.visits v join crm.customers c on c.id = v.customer_id
  where v.status = 'completed'
    and v.check_in_at >= perf.cairo_start(p_from) and v.check_in_at < perf.cairo_start(p_to + 1)
    and (p_emp is null or v.employee_id = any(p_emp))
    and (p_terr is null or c.territory_id = any(p_terr))
$$;

create or replace function perf.metric_visits_completed(p_emp uuid[], p_terr uuid[], p_from date, p_to date)
returns perf.metric_result language sql stable set search_path = '' as $$
  select row(count(distinct (v.customer_id, v.local_day))::numeric,
             jsonb_build_object('visits', count(*), 'customer_days', count(distinct (v.customer_id, v.local_day))),
             coalesce(array_agg(v.visit_id), '{}'))::perf.metric_result
  from perf.completed_visits(p_emp, p_terr, p_from, p_to) v
$$;

create or replace function perf.metric_visits_verified_pct(p_emp uuid[], p_terr uuid[], p_from date, p_to date)
returns perf.metric_result language sql stable set search_path = '' as $$
  with v as (select * from perf.completed_visits(p_emp, p_terr, p_from, p_to)),
  days as (select v.customer_id, v.local_day, bool_or(v.verified) as ok from v group by 1, 2)
  select row(case when count(*) = 0 then null
                  else round(100.0 * count(*) filter (where days.ok) / count(*), 2) end,
             jsonb_build_object('numerator', count(*) filter (where days.ok), 'denominator', count(*)),
             (select coalesce(array_agg(v.visit_id), '{}') from v))::perf.metric_result
  from days
$$;

create or replace function perf.metric_visits_planned(p_emp uuid[], p_terr uuid[], p_from date, p_to date)
returns perf.metric_result language sql stable set search_path = '' as $$
  select row(count(distinct (v.customer_id, v.planned_for))::numeric,
             jsonb_build_object('visits', count(*), 'customer_days', count(distinct (v.customer_id, v.planned_for))),
             coalesce(array_agg(v.id), '{}'))::perf.metric_result
  from field.visits v join crm.customers c on c.id = v.customer_id
  where v.planned_for between p_from and p_to and v.status <> 'cancelled'
    and (p_emp is null or v.employee_id = any(p_emp))
    and (p_terr is null or c.territory_id = any(p_terr))
$$;

create or replace function perf.metric_visit_avg_minutes(p_emp uuid[], p_terr uuid[], p_from date, p_to date)
returns perf.metric_result language sql stable set search_path = '' as $$
  select row(round(avg(v.minutes), 1),
             jsonb_build_object('visits', count(v.minutes), 'total_minutes', round(coalesce(sum(v.minutes), 0), 1)),
             coalesce(array_agg(v.visit_id) filter (where v.minutes is not null), '{}'))::perf.metric_result
  from perf.completed_visits(p_emp, p_terr, p_from, p_to) v
$$;

create or replace function perf.metric_customers_added(p_emp uuid[], p_terr uuid[], p_from date, p_to date)
returns perf.metric_result language sql stable set search_path = '' as $$
  select row(count(*)::numeric, jsonb_build_object('customers', count(*)),
             coalesce(array_agg(c.id), '{}'))::perf.metric_result
  from crm.customers c
  left join core.user_profiles p on p.user_id = c.created_by
  where c.created_at >= perf.cairo_start(p_from) and c.created_at < perf.cairo_start(p_to + 1)
    and (p_emp is null or p.employee_id = any(p_emp))
    and (p_terr is null or c.territory_id = any(p_terr))
$$;

-- Invoices with their KPI attribution (order rep + territory snapshot, else primary rep + customer territory).
create or replace function perf.attributed_invoices(p_emp uuid[], p_terr uuid[])
returns table (invoice_id uuid, customer_id uuid, issue_date date, net numeric)
language sql stable set search_path = '' as $$
  select i.id, i.customer_id, i.issue_date, (i.subtotal - i.discount_total)
  from finance.invoices i
  join crm.customers c on c.id = i.customer_id
  left join sales.orders o on o.id = i.order_id
  where (p_emp is null or coalesce(o.employee_id, perf.primary_rep(i.customer_id)) = any(p_emp))
    and (p_terr is null or coalesce(o.territory_id, c.territory_id) = any(p_terr))
$$;

create or replace function perf.metric_new_accounts(p_emp uuid[], p_terr uuid[], p_from date, p_to date)
returns perf.metric_result language sql stable set search_path = '' as $$
  with first_inv as (
    select distinct on (i.customer_id) i.id, i.customer_id, i.issue_date
    from finance.invoices i order by i.customer_id, i.issue_date, i.created_at, i.id
  )
  select row(count(*)::numeric, jsonb_build_object('customers', count(*)),
             coalesce(array_agg(f.customer_id), '{}'))::perf.metric_result
  from first_inv f
  where f.issue_date between p_from and p_to
    and f.id in (select a.invoice_id from perf.attributed_invoices(p_emp, p_terr) a)
$$;

-- Booked orders: +1 when submitted in the period, unless cancelled/rejected before that
-- period closed; −1 in the period of a cancellation that happened after the original
-- period closed (DASHBOARDS.md §1 "Booked sales" / "Cancellations").
create or replace function perf.booked_orders(p_emp uuid[], p_terr uuid[], p_from date, p_to date)
returns table (order_id uuid, sign int, net numeric)
language sql stable set search_path = '' as $$
  with bounds as (select perf.cairo_start(p_from) as t0, perf.cairo_start(p_to + 1) as t1),
  o as (
    select o.id, o.submitted_at, (o.subtotal - o.discount_total) as net,
           perf.period_close_at((o.submitted_at at time zone 'Africa/Cairo')::date) as closes_at,
           case when o.status in ('cancelled','rejected') then
             coalesce((select max(h.changed_at) from sales.order_status_history h
                       where h.order_id = o.id and h.to_status = o.status), o.updated_at) end as voided_at
    from sales.orders o, bounds b
    where o.submitted_at is not null
      and (o.submitted_at >= b.t0 and o.submitted_at < b.t1
           or o.status in ('cancelled','rejected') and o.updated_at >= b.t0)
      and (p_emp is null or o.employee_id = any(p_emp))
      and (p_terr is null or o.territory_id = any(p_terr))
  )
  select o.id, 1, o.net from o, bounds b
   where o.submitted_at >= b.t0 and o.submitted_at < b.t1
     and (o.voided_at is null or o.voided_at >= o.closes_at)
  union all
  select o.id, -1, -o.net from o, bounds b
   where o.voided_at is not null and o.voided_at >= o.closes_at
     and o.voided_at >= b.t0 and o.voided_at < b.t1
$$;

create or replace function perf.metric_orders_booked(p_emp uuid[], p_terr uuid[], p_from date, p_to date)
returns perf.metric_result language sql stable set search_path = '' as $$
  select row(coalesce(sum(b.sign), 0)::numeric,
             jsonb_build_object('booked', count(*) filter (where b.sign > 0), 'reversed', count(*) filter (where b.sign < 0)),
             coalesce(array_agg(b.order_id), '{}'))::perf.metric_result
  from perf.booked_orders(p_emp, p_terr, p_from, p_to) b
$$;

create or replace function perf.metric_booked_sales(p_emp uuid[], p_terr uuid[], p_from date, p_to date)
returns perf.metric_result language sql stable set search_path = '' as $$
  select row(coalesce(sum(b.net), 0)::numeric(14,2),
             jsonb_build_object('booked', coalesce(sum(b.net) filter (where b.sign > 0), 0),
                                'reversed', coalesce(-sum(b.net) filter (where b.sign < 0), 0)),
             coalesce(array_agg(b.order_id), '{}'))::perf.metric_result
  from perf.booked_orders(p_emp, p_terr, p_from, p_to) b
$$;

create or replace function perf.metric_approval_turnaround_hours(p_emp uuid[], p_terr uuid[], p_from date, p_to date)
returns perf.metric_result language sql stable set search_path = '' as $$
  select row(round(avg(extract(epoch from o.approved_at - o.submitted_at) / 3600), 1),
             jsonb_build_object('orders', count(*)),
             coalesce(array_agg(o.id), '{}'))::perf.metric_result
  from sales.orders o
  where o.approved_at >= perf.cairo_start(p_from) and o.approved_at < perf.cairo_start(p_to + 1)
    and o.submitted_at is not null
    and (p_emp is null or o.employee_id = any(p_emp))
    and (p_terr is null or o.territory_id = any(p_terr))
$$;

-- Posted fulfilment lines, valued at the order line's net unit price (excl. VAT).
create or replace function perf.fulfilled_lines(p_emp uuid[], p_terr uuid[], p_from date, p_to date)
returns table (fulfillment_id uuid, variant_id uuid, net numeric)
language sql stable set search_path = '' as $$
  select f.id, oi.variant_id, round(fi.quantity * (oi.line_subtotal - oi.line_discount) / oi.quantity, 2)
  from sales.fulfillments f
  join sales.fulfillment_items fi on fi.fulfillment_id = f.id
  join sales.order_items oi on oi.id = fi.order_item_id
  join sales.orders o on o.id = f.order_id
  where f.status = 'posted'
    and coalesce(f.delivered_at, f.created_at) >= perf.cairo_start(p_from)
    and coalesce(f.delivered_at, f.created_at) < perf.cairo_start(p_to + 1)
    and (p_emp is null or o.employee_id = any(p_emp))
    and (p_terr is null or o.territory_id = any(p_terr))
$$;

create or replace function perf.metric_sales_fulfilled(p_emp uuid[], p_terr uuid[], p_from date, p_to date)
returns perf.metric_result language sql stable set search_path = '' as $$
  select row(coalesce(sum(l.net), 0)::numeric(14,2), jsonb_build_object('fulfilments', count(distinct l.fulfillment_id)),
             coalesce(array_agg(distinct l.fulfillment_id), '{}'))::perf.metric_result
  from perf.fulfilled_lines(p_emp, p_terr, p_from, p_to) l
$$;

create or replace function perf.metric_net_revenue(p_emp uuid[], p_terr uuid[], p_from date, p_to date)
returns perf.metric_result language sql stable set search_path = '' as $$
  with a as (select * from perf.attributed_invoices(p_emp, p_terr)),
  inv as (select a.invoice_id, a.net from a where a.issue_date between p_from and p_to),
  cn as (select cn.id, cn.amount from finance.credit_notes cn join a on a.invoice_id = cn.invoice_id
         where cn.issue_date between p_from and p_to)
  select row(((select coalesce(sum(net), 0) from inv) - (select coalesce(sum(amount), 0) from cn))::numeric(14,2),
             jsonb_build_object('invoiced', (select coalesce(sum(net), 0) from inv),
                                'credited', (select coalesce(sum(amount), 0) from cn),
                                'invoices', (select count(*) from inv), 'credit_notes', (select count(*) from cn)),
             (select coalesce(array_agg(invoice_id), '{}') from inv) || (select coalesce(array_agg(id), '{}') from cn)
            )::perf.metric_result
$$;

create or replace function perf.metric_cash_collected(p_emp uuid[], p_terr uuid[], p_from date, p_to date)
returns perf.metric_result language sql stable set search_path = '' as $$
  select row(coalesce(sum(p.amount), 0)::numeric(14,2), jsonb_build_object('payments', count(*)),
             coalesce(array_agg(p.id), '{}'))::perf.metric_result
  from finance.payments p join crm.customers c on c.id = p.customer_id
  where p.status = 'confirmed'
    and p.received_at >= perf.cairo_start(p_from) and p.received_at < perf.cairo_start(p_to + 1)
    and (p_emp is null or p.collected_by = any(p_emp))
    and (p_terr is null or c.territory_id = any(p_terr))
$$;

-- Invoices past due on p_as_of with their open amount (VAT included) on that day.
create or replace function perf.overdue_invoices(p_as_of date)
returns table (invoice_id uuid, customer_id uuid, due_date date, open_amount numeric)
language sql stable set search_path = '' as $$
  select x.id, x.customer_id, x.due_date, x.open_amount from (
    select i.id, i.customer_id, i.due_date,
           (i.total
            - coalesce((select sum(pa.amount) from finance.payment_allocations pa
                        where pa.invoice_id = i.id and pa.allocated_at < perf.cairo_start(p_as_of + 1)), 0)
            - coalesce((select sum(cn.amount + cn.tax_amount) from finance.credit_notes cn
                        where cn.invoice_id = i.id and cn.issue_date <= p_as_of), 0))::numeric(14,2) as open_amount
    from finance.invoices i
    where i.issue_date <= p_as_of and i.due_date < p_as_of and i.status <> 'written_off'
  ) x where x.open_amount > 0
$$;

create or replace function perf.metric_ar_open(p_emp uuid[], p_terr uuid[], p_from date, p_to date)
returns perf.metric_result language sql stable set search_path = '' as $$
  with asof as (select least(p_to, core.business_date()) as d),
  bal as (
    select l.customer_id, sum(l.amount) as balance
    from finance.customer_ledger l, asof
    where l.posted_at < perf.cairo_start(asof.d + 1)
    group by l.customer_id
  )
  select row(coalesce(sum(greatest(b.balance, 0)), 0)::numeric(14,2),
             jsonb_build_object('as_of', (select d from asof), 'customers', count(*) filter (where b.balance > 0)),
             coalesce(array_agg(b.customer_id) filter (where b.balance > 0), '{}'))::perf.metric_result
  from bal b join crm.customers c on c.id = b.customer_id
  where (p_emp is null or perf.primary_rep(b.customer_id) = any(p_emp))
    and (p_terr is null or c.territory_id = any(p_terr))
$$;

create or replace function perf.metric_ar_overdue(p_emp uuid[], p_terr uuid[], p_from date, p_to date)
returns perf.metric_result language sql stable set search_path = '' as $$
  with asof as (select least(p_to, core.business_date()) as d)
  select row(coalesce(sum(o.open_amount), 0)::numeric(14,2),
             jsonb_build_object('as_of', (select d from asof), 'invoices', count(*),
                                'customers', count(distinct o.customer_id)),
             coalesce(array_agg(o.invoice_id), '{}'))::perf.metric_result
  from asof cross join lateral perf.overdue_invoices(asof.d) o join crm.customers c on c.id = o.customer_id
  where (p_emp is null or perf.primary_rep(o.customer_id) = any(p_emp))
    and (p_terr is null or c.territory_id = any(p_terr))
$$;

-- Company level only (NULL value for an employee or territory filter). Live: as of today.
create or replace function perf.metric_stock_alerts(p_emp uuid[], p_terr uuid[], p_from date, p_to date)
returns perf.metric_result language sql stable set search_path = '' as $$
  with today as (select core.business_date() as d),
  reorder as (
    select v.id from catalog.product_variants v join catalog.products p on p.id = v.product_id
    where v.reorder_point > 0 and v.status = 'active' and p.status = 'active'
      and coalesce((select sum(greatest(b.on_hand - b.reserved, 0))
                    from inventory.stock_balances b
                    join inventory.lots l on l.id = b.lot_id
                    join inventory.warehouses w on w.id = b.warehouse_id, today
                    where b.variant_id = v.id and w.is_active and w.kind not in ('quarantine','transit')
                      and (l.expiry_date is null or l.expiry_date >= today.d)), 0) <= v.reorder_point
  ),
  expiring as (
    select distinct b.lot_id from inventory.stock_balances b
    join inventory.lots l on l.id = b.lot_id
    join inventory.warehouses w on w.id = b.warehouse_id, today
    where b.on_hand > 0 and w.is_active and w.kind not in ('quarantine','transit')
      and l.expiry_date is not null and l.expiry_date < today.d + 90
  )
  select case when p_emp is not null or p_terr is not null then row(null, '{}', '{}')::perf.metric_result
    else row(((select count(*) from reorder) + (select count(*) from expiring))::numeric,
             jsonb_build_object('below_reorder', (select count(*) from reorder),
                                'expiring_lots', (select count(*) from expiring)),
             (select coalesce(array_agg(id), '{}') from reorder) || (select coalesce(array_agg(lot_id), '{}') from expiring)
            )::perf.metric_result end
$$;

-- Live: pending now (approvals have no history of "pending as of" a past day).
create or replace function perf.metric_pending_approvals(p_emp uuid[], p_terr uuid[], p_from date, p_to date)
returns perf.metric_result language sql stable set search_path = '' as $$
  select row(count(*)::numeric, jsonb_build_object('requests', count(*)),
             coalesce(array_agg(r.id), '{}'))::perf.metric_result
  from wf.approval_requests r
  where r.status = 'pending'
    and (p_emp is null or r.subject_employee_id = any(p_emp))
    and (p_terr is null or core.jsonb_uuid(r.payload, 'territory_id') = any(p_terr))
$$;

-- The whitelist (ADR-015): a metric_key maps to exactly one registered function.
create or replace function perf.compute_metric(p_metric_key text, p_emp uuid[], p_terr uuid[], p_from date, p_to date)
returns perf.metric_result language plpgsql stable set search_path = '' as $$
begin
  return case p_metric_key
    when 'perf.metric_visits_planned'            then perf.metric_visits_planned(p_emp, p_terr, p_from, p_to)
    when 'perf.metric_visits_completed'          then perf.metric_visits_completed(p_emp, p_terr, p_from, p_to)
    when 'perf.metric_visits_verified_pct'       then perf.metric_visits_verified_pct(p_emp, p_terr, p_from, p_to)
    when 'perf.metric_visit_avg_minutes'         then perf.metric_visit_avg_minutes(p_emp, p_terr, p_from, p_to)
    when 'perf.metric_customers_added'           then perf.metric_customers_added(p_emp, p_terr, p_from, p_to)
    when 'perf.metric_new_accounts'              then perf.metric_new_accounts(p_emp, p_terr, p_from, p_to)
    when 'perf.metric_orders_booked'             then perf.metric_orders_booked(p_emp, p_terr, p_from, p_to)
    when 'perf.metric_booked_sales'              then perf.metric_booked_sales(p_emp, p_terr, p_from, p_to)
    when 'perf.metric_approval_turnaround_hours' then perf.metric_approval_turnaround_hours(p_emp, p_terr, p_from, p_to)
    when 'perf.metric_sales_fulfilled'           then perf.metric_sales_fulfilled(p_emp, p_terr, p_from, p_to)
    when 'perf.metric_net_revenue'               then perf.metric_net_revenue(p_emp, p_terr, p_from, p_to)
    when 'perf.metric_cash_collected'            then perf.metric_cash_collected(p_emp, p_terr, p_from, p_to)
    when 'perf.metric_ar_open'                   then perf.metric_ar_open(p_emp, p_terr, p_from, p_to)
    when 'perf.metric_ar_overdue'                then perf.metric_ar_overdue(p_emp, p_terr, p_from, p_to)
    when 'perf.metric_stock_alerts'              then perf.metric_stock_alerts(p_emp, p_terr, p_from, p_to)
    when 'perf.metric_pending_approvals'         then perf.metric_pending_approvals(p_emp, p_terr, p_from, p_to)
  end;
end $$;

-- Values by brand for the money metrics that have product lines.
create or replace function perf.metric_by_brand(p_metric_key text, p_emp uuid[], p_terr uuid[], p_from date, p_to date)
returns table (brand_id uuid, value numeric)
language sql stable set search_path = '' as $$
  with lines as (
    select oi.variant_id, b.sign * (oi.line_subtotal - oi.line_discount) as net
      from perf.booked_orders(p_emp, p_terr, p_from, p_to) b join sales.order_items oi on oi.order_id = b.order_id
     where p_metric_key = 'perf.metric_booked_sales'
    union all
    select l.variant_id, l.net from perf.fulfilled_lines(p_emp, p_terr, p_from, p_to) l
     where p_metric_key = 'perf.metric_sales_fulfilled'
    union all
    -- invoice lines net of discount, minus credit notes spread over the invoice's lines
    select ii.variant_id,
           case when a.issue_date between p_from and p_to then ii.unit_price * ii.quantity - ii.discount else 0 end
           - coalesce((select sum(cn.amount) from finance.credit_notes cn
                       where cn.invoice_id = a.invoice_id and cn.issue_date between p_from and p_to), 0)
             * (ii.unit_price * ii.quantity - ii.discount) / nullif(a.net, 0)
      from perf.attributed_invoices(p_emp, p_terr) a join finance.invoice_items ii on ii.invoice_id = a.invoice_id
     where p_metric_key = 'perf.metric_net_revenue'
       and (a.issue_date between p_from and p_to
            or exists (select 1 from finance.credit_notes cn
                       where cn.invoice_id = a.invoice_id and cn.issue_date between p_from and p_to))
  )
  select p.brand_id, round(sum(l.net), 2)
  from lines l join catalog.product_variants v on v.id = l.variant_id join catalog.products p on p.id = v.product_id
  group by p.brand_id
$$;

-- ---------------------------------------------------------------------------
-- 4. Targets: employee > role (per holder). Territory targets are territory totals.
--    Count/EGP flow targets are pro-rated by the days of each target period that the
--    selected period covers; percentages, durations and point-in-time targets are not.
-- ---------------------------------------------------------------------------
create or replace function perf.pick_target(p_rows perf.kpi_targets[], p_from date, p_to date, p_prorate boolean)
returns numeric language sql stable set search_path = '' as $$
  with r as (select * from unnest(p_rows)),
  latest as (select distinct on (r.period_start, r.period_end) r.* from r
             order by r.period_start, r.period_end, r.created_at desc)
  select case when not exists (select 1 from latest) then null
              when p_prorate then round(sum(l.target_value * (least(l.period_end, p_to) - greatest(l.period_start, p_from) + 1)::numeric
                                            / (l.period_end - l.period_start + 1)), 2)
              else (select l2.target_value from latest l2 order by l2.period_start desc, l2.created_at desc limit 1) end
  from latest l
$$;

create or replace function perf.employee_target(p_kpi perf.kpi_definitions, p_employee_id uuid, p_from date, p_to date)
returns numeric language sql stable set search_path = '' as $$
  with cand as (
    select t, case when t.employee_id = p_employee_id then 1 else 2 end as lvl
    from perf.kpi_targets t
    where t.kpi_id = p_kpi.id and t.period_start <= p_to and t.period_end >= p_from
      and (t.employee_id = p_employee_id
           or t.role_id in (select ur.role_id from authz.user_roles ur join core.employees e on e.user_id = ur.user_id
                            where e.id = p_employee_id and ur.revoked_at is null and ur.valid_from <= now()
                              and (ur.valid_to is null or ur.valid_to > now())))
  )
  select perf.pick_target(array(select c.t from cand c where c.lvl = (select min(lvl) from cand))::perf.kpi_targets[],
                          p_from, p_to, not p_kpi.is_point_in_time and p_kpi.unit in ('count','egp'))
$$;

create or replace function perf.territory_target(p_kpi perf.kpi_definitions, p_territory_id uuid, p_from date, p_to date)
returns numeric language sql stable set search_path = '' as $$
  select perf.pick_target(array(select t from perf.kpi_targets t
                                where t.kpi_id = p_kpi.id and t.territory_id = p_territory_id
                                  and t.period_start <= p_to and t.period_end >= p_from)::perf.kpi_targets[],
                          p_from, p_to, not p_kpi.is_point_in_time and p_kpi.unit in ('count','egp'))
$$;

-- Target for one subject: an employee, a territory total, or the roster of a scope
-- (sum of count/EGP targets, average of the others).
create or replace function perf.target_for(p_kpi perf.kpi_definitions, p_employee_id uuid, p_scope uuid[],
                                           p_territory_id uuid, p_from date, p_to date)
returns numeric language sql stable set search_path = '' as $$
  select case
    when p_employee_id is not null then perf.employee_target(p_kpi, p_employee_id, p_from, p_to)
    when p_territory_id is not null then perf.territory_target(p_kpi, p_territory_id, p_from, p_to)
    else (select case when p_kpi.unit in ('count','egp') then sum(x.t) else round(avg(x.t), 2) end
          from (select perf.employee_target(p_kpi, r, p_from, p_to) as t from perf.roster(p_scope, p_from, p_to) r) x)
  end
$$;

create or replace function perf.achievement(p_value numeric, p_target numeric, p_higher_is_better boolean)
returns numeric language sql immutable set search_path = '' as $$
  select case when p_value is null or p_target is null or p_target <= 0 then null
              when p_higher_is_better then least(round(100 * p_value / p_target, 2), 99999.99)
              when p_value <= 0 then null
              else least(round(100 * p_target / p_value, 2), 99999.99) end
$$;

-- ---------------------------------------------------------------------------
-- 5. Read commands (SECURITY DEFINER: scope from perf.kpi.read, never from the client)
-- ---------------------------------------------------------------------------

-- Resolve the employee filter for a request; refuses an employee outside the scope.
create or replace function perf.resolve_employee_filter(p_employee_id uuid) returns uuid[]
language plpgsql stable set search_path = '' as $$
declare v_scope uuid[] := perf.kpi_scope_employee_ids();
begin
  if p_employee_id is null then return v_scope; end if;
  if v_scope is not null and not (p_employee_id = any(v_scope)) then
    raise exception 'PERMISSION_DENIED: employee outside your KPI scope' using errcode = '42501';
  end if;
  return array[p_employee_id];
end $$;

create or replace function api.kpi_summary(p_from date, p_to date, p_employee_id uuid default null,
                                           p_territory_id uuid default null)
returns table (kpi_code text, unit text, higher_is_better boolean, is_point_in_time boolean,
               value numeric, target numeric, achievement_pct numeric, detail jsonb)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare v_emp uuid[]; v_terr uuid[]; v_stock boolean;
begin
  perform authz.require('perf.kpi.read');
  perform perf.check_period(p_from, p_to);
  v_emp  := perf.resolve_employee_filter(p_employee_id);
  v_terr := case when p_territory_id is not null then perf.territory_tree(p_territory_id) end;
  v_stock := v_emp is null and v_terr is null and authz.has_permission('inventory.stock.read');
  return query
    select d.code, d.unit, d.higher_is_better, d.is_point_in_time, m.value, t.target,
           perf.achievement(m.value, t.target, d.higher_is_better), m.detail
    from perf.kpi_definitions d
    cross join lateral perf.compute_metric(d.metric_key, v_emp, v_terr, p_from, p_to) m
    cross join lateral (select perf.target_for(d, p_employee_id, v_emp, p_territory_id, p_from, p_to) as target) t
    where d.status = 'active' and (d.code <> 'STOCK_ALERTS' or v_stock)
    order by d.code;
end $$;

-- Per-employee values for the roster of the caller's scope (team table).
create or replace function api.kpi_team(p_from date, p_to date, p_codes text[] default null)
returns table (employee_id uuid, employee_no text, full_name_en text, full_name_ar text,
               kpi_code text, value numeric, target numeric, achievement_pct numeric)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare v_scope uuid[];
begin
  perform authz.require('perf.kpi.read');
  perform perf.check_period(p_from, p_to);
  v_scope := perf.kpi_scope_employee_ids();
  return query
    select e.id, e.employee_no, e.full_name_en, e.full_name_ar, d.code, m.value, t.target,
           perf.achievement(m.value, t.target, d.higher_is_better)
    from perf.roster(v_scope, p_from, p_to) r
    join core.employees e on e.id = r
    cross join perf.kpi_definitions d
    cross join lateral perf.compute_metric(d.metric_key, array[e.id], null, p_from, p_to) m
    cross join lateral (select perf.employee_target(d, e.id, p_from, p_to) as target) t
    where d.status = 'active' and d.code not in ('STOCK_ALERTS')
      and (p_codes is null or d.code = any(p_codes))
    order by e.full_name_en, e.id, d.code;
end $$;

-- Totals by root territory (each with its sub-territories; no overlap) or by brand.
create or replace function api.kpi_breakdown(p_from date, p_to date, p_dimension text, p_codes text[] default null)
returns table (dimension_id uuid, dimension_code text, name_en text, name_ar text, kpi_code text, value numeric)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare v_scope uuid[];
begin
  perform authz.require('perf.kpi.read');
  perform perf.check_period(p_from, p_to);
  v_scope := perf.kpi_scope_employee_ids();
  if p_dimension = 'territory' then
    return query
      select t.id, t.code, t.name_en, t.name_ar, d.code,
             (perf.compute_metric(d.metric_key, v_scope, perf.territory_tree(t.id), p_from, p_to)).value
      from core.territories t
      cross join perf.kpi_definitions d
      where t.parent_id is null and t.is_active and d.status = 'active'
        and d.code = any(coalesce(p_codes, array['VISITS_COMPLETED','BOOKED_SALES','NET_REVENUE','CASH_COLLECTED','AR_OVERDUE']))
        and d.code not in ('STOCK_ALERTS')
      order by t.code, d.code;
  elsif p_dimension = 'brand' then
    return query
      select br.id, br.code, br.name, br.name, d.code, coalesce(x.value, 0)::numeric(14,2)
      from catalog.brands br
      cross join perf.kpi_definitions d
      left join lateral (select b.value from perf.metric_by_brand(d.metric_key, v_scope, null, p_from, p_to) b
                         where b.brand_id = br.id) x on true
      where br.is_active and d.status = 'active'
        and d.code = any(array['BOOKED_SALES','SALES_FULFILLED','NET_REVENUE'])
        and (p_codes is null or d.code = any(p_codes))
      order by br.code, d.code;
  else
    raise exception 'VALIDATION: unknown dimension %', p_dimension using errcode = 'P0001';
  end if;
end $$;

-- Customers with overdue invoices, attributed to employees in scope (primary rep).
create or replace function api.kpi_overdue_customers(p_as_of date default null, p_employee_id uuid default null,
                                                     p_limit int default 20)
returns table (customer_id uuid, customer_no text, display_name text, employee_id uuid,
               overdue_amount numeric, invoice_count int, oldest_due_date date, days_overdue int)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare v_emp uuid[]; v_as_of date := least(coalesce(p_as_of, core.business_date()), core.business_date());
begin
  perform authz.require('perf.kpi.read');
  v_emp := perf.resolve_employee_filter(p_employee_id);
  return query
    select c.id, c.customer_no, c.display_name, x.rep, sum(o.open_amount)::numeric(14,2), count(*)::int,
           min(o.due_date), (v_as_of - min(o.due_date))::int
    from perf.overdue_invoices(v_as_of) o
    join crm.customers c on c.id = o.customer_id
    cross join lateral (select perf.primary_rep(o.customer_id) as rep) x
    where v_emp is null or x.rep = any(v_emp)
    group by c.id, c.customer_no, c.display_name, x.rep
    order by sum(o.open_amount) desc, c.customer_no
    limit least(greatest(coalesce(p_limit, 20), 1), 200);
end $$;

-- ---------------------------------------------------------------------------
-- 6. Targets: command, policies and read view
-- ---------------------------------------------------------------------------
create or replace function api.set_kpi_target(
  p_target_id uuid, p_kpi_code text, p_period_start date, p_period_end date, p_target_value numeric,
  p_employee_id uuid default null, p_role_id uuid default null, p_territory_id uuid default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare v_kpi perf.kpi_definitions%rowtype; v_existing perf.kpi_targets%rowtype;
begin
  perform authz.require('perf.target.manage');
  if p_target_id is null then
    raise exception 'VALIDATION: target id required' using errcode = 'P0001';
  end if;
  select * into v_existing from perf.kpi_targets where id = p_target_id;
  if found then
    if v_existing.set_by is distinct from auth.uid() then
      raise exception 'CONFLICT: target id already used' using errcode = 'P0001';
    end if;
    return jsonb_build_object('target_id', v_existing.id, 'replayed', true);
  end if;

  select * into v_kpi from perf.kpi_definitions where code = p_kpi_code;
  if not found then raise exception 'NOT_FOUND: KPI %', p_kpi_code using errcode = 'P0002'; end if;
  if v_kpi.status <> 'active' then
    raise exception 'INVALID_STATE: KPI % is not active', p_kpi_code using errcode = 'P0001';
  end if;
  if num_nonnulls(p_employee_id, p_role_id, p_territory_id) <> 1 then
    raise exception 'VALIDATION: a target is for exactly one employee, role or territory' using errcode = 'P0001';
  end if;
  perform perf.check_period(p_period_start, p_period_end);
  if p_target_value is null or p_target_value < 0
     or (v_kpi.unit = 'pct' and p_target_value > 100) or p_target_value > 999999999999.99 then
    raise exception 'VALIDATION: target value out of range' using errcode = 'P0001';
  end if;

  if p_employee_id is not null then
    if not exists (select 1 from core.employees where id = p_employee_id) then
      raise exception 'NOT_FOUND: employee %', p_employee_id using errcode = 'P0002';
    end if;
    if not authz.employee_in_scope('perf.target.manage', p_employee_id) then
      raise exception 'PERMISSION_DENIED: employee outside your scope' using errcode = '42501';
    end if;
  elsif p_role_id is not null then
    if not exists (select 1 from authz.roles where id = p_role_id) then
      raise exception 'NOT_FOUND: role %', p_role_id using errcode = 'P0002';
    end if;
    if not authz.has_global('perf.target.manage') then
      raise exception 'PERMISSION_DENIED: role targets need company-wide target authority' using errcode = '42501';
    end if;
  else
    if not exists (select 1 from core.territories where id = p_territory_id) then
      raise exception 'NOT_FOUND: territory %', p_territory_id using errcode = 'P0002';
    end if;
    if not (authz.has_global('perf.target.manage')
            or p_territory_id = any(authz.territory_ids('perf.target.manage'))) then
      raise exception 'PERMISSION_DENIED: territory outside your scope' using errcode = '42501';
    end if;
  end if;

  insert into perf.kpi_targets (id, kpi_id, role_id, employee_id, territory_id, target_value, period_start, period_end, set_by)
  values (p_target_id, v_kpi.id, p_role_id, p_employee_id, p_territory_id, round(p_target_value, 2),
          p_period_start, p_period_end, auth.uid());

  insert into integration.outbox (event_type, aggregate_type, aggregate_id, payload)
  values ('kpi_target.set', 'perf.kpi_target', p_target_id,
          jsonb_build_object('target_id', p_target_id, 'kpi_code', v_kpi.code, 'employee_id', p_employee_id,
                             'role_id', p_role_id, 'territory_id', p_territory_id,
                             'target_value', round(p_target_value, 2),
                             'period_start', p_period_start, 'period_end', p_period_end));
  return jsonb_build_object('target_id', p_target_id, 'replayed', false);
end $$;

-- These tables had RLS but no policy (no rows for clients). Definitions are not secret;
-- targets are visible to target managers, company-wide KPI readers and for employees in scope.
create policy kpi_definitions_select on perf.kpi_definitions for select to authenticated using (
  (select authz.has_permission('perf.kpi.read')) or (select authz.has_permission('perf.target.manage')));
create policy kpi_targets_select on perf.kpi_targets for select to authenticated using (
  (select authz.has_global('perf.target.manage'))
  or (select authz.has_global('perf.kpi.read'))
  or employee_id = any((select authz.employee_ids('perf.kpi.read'))::uuid[])
  or employee_id = any((select authz.employee_ids('perf.target.manage'))::uuid[])
);

create or replace view api.v_kpi_targets with (security_invoker = true) as
  select t.id, d.code as kpi_code, d.unit, t.employee_id, emp.full_name_en as employee_name_en,
         emp.full_name_ar as employee_name_ar, t.role_id, r.code as role_code, r.name_en as role_name_en,
         r.name_ar as role_name_ar, t.territory_id, ter.code as territory_code, ter.name_en as territory_name_en,
         ter.name_ar as territory_name_ar, t.target_value, t.period_start, t.period_end, t.created_at
  from perf.kpi_targets t
  join perf.kpi_definitions d on d.id = t.kpi_id
  left join lateral crm.employee_display(t.employee_id) emp on true
  left join authz.roles r on r.id = t.role_id
  left join core.territories ter on ter.id = t.territory_id;
grant select on api.v_kpi_targets to authenticated;

-- ---------------------------------------------------------------------------
-- 7. Snapshots (perf.kpi_results): company, each root territory, each roster employee.
--    Final rows (is_final) are never rewritten.
-- ---------------------------------------------------------------------------
create or replace function perf.snapshot_period(p_start date, p_end date, p_final boolean) returns int
language plpgsql volatile set search_path = '' as $$
declare v_def perf.kpi_definitions%rowtype; v_subject record; v_m perf.metric_result; v_target numeric; v_n int := 0;
begin
  for v_def in select * from perf.kpi_definitions where status = 'active' order by code loop
    for v_subject in
      select null::uuid as emp, null::uuid as terr
      union all select null, t.id from core.territories t where t.parent_id is null and t.is_active
      union all select r, null from perf.roster(null, p_start, p_end) r
    loop
      v_m := perf.compute_metric(v_def.metric_key,
                                 case when v_subject.emp is not null then array[v_subject.emp] end,
                                 case when v_subject.terr is not null then perf.territory_tree(v_subject.terr) end,
                                 p_start, p_end);
      continue when v_m.value is null;
      v_target := perf.target_for(v_def, v_subject.emp, null, v_subject.terr, p_start, p_end);
      insert into perf.kpi_results (kpi_id, employee_id, territory_id, period_start, period_end, actual_value,
                                    target_value, achievement_pct, kpi_version, computed_at, is_final, source_snapshot)
      values (v_def.id, v_subject.emp, v_subject.terr, p_start, p_end, round(v_m.value, 2), v_target,
              perf.achievement(v_m.value, v_target, v_def.higher_is_better), v_def.version, now(), p_final,
              coalesce(v_m.detail, '{}') || jsonb_build_object(
                'metric_key', v_def.metric_key,
                'source_count', coalesce(cardinality(v_m.source_ids), 0),
                'source_ids', case when coalesce(cardinality(v_m.source_ids), 0) <= 5000 then to_jsonb(v_m.source_ids) end))
      on conflict (kpi_id, employee_id, territory_id, period_start, kpi_version) do update
        set period_end = excluded.period_end, actual_value = excluded.actual_value,
            target_value = excluded.target_value, achievement_pct = excluded.achievement_pct,
            computed_at = excluded.computed_at, is_final = excluded.is_final, source_snapshot = excluded.source_snapshot
        where not perf.kpi_results.is_final;
      v_n := v_n + 1;
    end loop;
  end loop;
  return v_n;
end $$;

-- Nightly: the current month; the previous month is recomputed until it closes on day 5,
-- then written once more as final.
create or replace function service.snapshot_kpis(p_as_of date default null)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_today date := coalesce(p_as_of, core.business_date());
  v_cur date := date_trunc('month', v_today)::date;
  v_prev date := (date_trunc('month', v_today) - interval '1 month')::date;
  v_cur_rows int; v_prev_rows int := 0; v_prev_mode text := 'skipped';
begin
  v_cur_rows := perf.snapshot_period(v_cur, (v_cur + interval '1 month' - interval '1 day')::date, false);
  if extract(day from v_today) <= 5 then
    v_prev_rows := perf.snapshot_period(v_prev, v_cur - 1, false); v_prev_mode := 'provisional';
  elsif not exists (select 1 from perf.kpi_results where period_start = v_prev and is_final) then
    v_prev_rows := perf.snapshot_period(v_prev, v_cur - 1, true); v_prev_mode := 'finalized';
  end if;
  return jsonb_build_object('as_of', v_today, 'current_period', v_cur, 'current_rows', v_cur_rows,
                            'previous_period', v_prev, 'previous_rows', v_prev_rows, 'previous_mode', v_prev_mode);
end $$;

-- ---------------------------------------------------------------------------
-- 8. Function privileges
-- ---------------------------------------------------------------------------
-- Internal perf functions: not callable by clients (they run inside the definer commands).
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'perf' loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
  end loop;
end $$;

revoke all on function service.snapshot_kpis(date) from public, anon, authenticated;
grant execute on function service.snapshot_kpis(date) to service_role;

-- Explicit grants only: a blanket grant on schema api would re-open commands closed earlier.
revoke all on function
  api.kpi_summary(date, date, uuid, uuid),
  api.kpi_team(date, date, text[]),
  api.kpi_breakdown(date, date, text, text[]),
  api.kpi_overdue_customers(date, uuid, int),
  api.set_kpi_target(uuid, text, date, date, numeric, uuid, uuid, uuid)
from public, anon;
grant execute on function
  api.kpi_summary(date, date, uuid, uuid),
  api.kpi_team(date, date, text[]),
  api.kpi_breakdown(date, date, text, text[]),
  api.kpi_overdue_customers(date, uuid, int),
  api.set_kpi_target(uuid, text, date, date, numeric, uuid, uuid, uuid)
to authenticated;
