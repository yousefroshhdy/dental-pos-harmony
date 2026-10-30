-- Honest OS migration: Phase 4 — receivables read side (RLS policies and api views).
--
-- Every view is security_invoker, so the caller's RLS decides the rows:
--   invoices / ledger   finance.invoice.read / finance.ledger.read AND the customer is visible
--                       (crm.customer.read scope: reps their customers, managers their territory)
--   payments            finance.payment.read: all, or collected by me/my team, or (new) for a
--                       customer assigned to me/my team or in my territories
--   allocations, lines, credit notes   follow their invoice (or payment)
--   collection tasks    finance.collection.manage in scope, or assigned to me
-- Aging and invoicing helpers are additionally gated by a page/command permission.
-- No definer function is used by these views; amounts are summed from RLS-visible rows,
-- which are complete whenever the parent invoice or payment is visible.

-- ---------------------------------------------------------------------------
-- 1. RLS policies for the finance tables that had none (deny-by-default otherwise)
-- ---------------------------------------------------------------------------
create policy invoice_items_select on finance.invoice_items for select to authenticated using (
  exists (select 1 from finance.invoices i where i.id = invoice_items.invoice_id));
create policy credit_notes_select on finance.credit_notes for select to authenticated using (
  exists (select 1 from finance.invoices i where i.id = credit_notes.invoice_id));
create policy credit_note_items_select on finance.credit_note_items for select to authenticated using (
  exists (select 1 from finance.credit_notes cn where cn.id = credit_note_items.credit_note_id));
create policy payment_allocations_select on finance.payment_allocations for select to authenticated using (
  exists (select 1 from finance.invoices i where i.id = payment_allocations.invoice_id)
  or exists (select 1 from finance.payments p where p.id = payment_allocations.payment_id));
-- Additive: a rep also sees payments of their own customers that someone else recorded.
create policy payments_customer_select on finance.payments for select to authenticated using (
  customer_id = any((select authz.assigned_customer_ids('finance.payment.read'))::uuid[])
  or exists (select 1 from crm.customers c where c.id = payments.customer_id
             and c.territory_id = any((select authz.territory_ids('finance.payment.read'))::uuid[])));
create policy collection_tasks_select on finance.collection_tasks for select to authenticated using (
  assignee_employee_id = (select authz.current_employee_id())
  or (select authz.has_global('finance.collection.manage'))
  or assignee_employee_id = any((select authz.employee_ids('finance.collection.manage'))::uuid[])
  or customer_id = any((select authz.assigned_customer_ids('finance.collection.manage'))::uuid[])
  or exists (select 1 from crm.customers c where c.id = collection_tasks.customer_id
             and c.territory_id = any((select authz.territory_ids('finance.collection.manage'))::uuid[])));

-- ---------------------------------------------------------------------------
-- 2. Views
-- ---------------------------------------------------------------------------
create or replace view api.v_invoices with (security_invoker = true) as
  select i.id, i.invoice_no, i.order_id, o.order_no, i.customer_id, c.customer_no, c.display_name as customer_name,
         c.territory_id, o.employee_id as rep_employee_id, rep.full_name_en as rep_name_en, rep.full_name_ar as rep_name_ar,
         i.issue_date, i.due_date, i.status, i.currency, i.subtotal, i.discount_total, i.tax_total, i.total,
         a.allocated, cr.credited, (i.total - a.allocated - cr.credited)::numeric(14,2) as open_amount,
         case when i.total - a.allocated - cr.credited > 0 and i.status in ('issued','partially_paid')
              then greatest(core.business_date() - i.due_date, 0) else 0 end as days_overdue,
         (i.total - a.allocated - cr.credited > 0 and i.status in ('issued','partially_paid')
          and i.due_date < core.business_date()) as is_overdue,
         case when not (i.total - a.allocated - cr.credited > 0 and i.status in ('issued','partially_paid')) then null
              when core.business_date() - i.due_date <= 0 then 'current'
              when core.business_date() - i.due_date <= 30 then 'd1_30'
              when core.business_date() - i.due_date <= 60 then 'd31_60'
              when core.business_date() - i.due_date <= 90 then 'd61_90'
              else 'd90_plus' end as aging_bucket,
         i.eta_status, i.eta_uuid, i.created_at
  from finance.invoices i
  left join crm.customers c on c.id = i.customer_id
  left join sales.orders o on o.id = i.order_id
  left join lateral crm.employee_display(o.employee_id) rep on true
  cross join lateral (select coalesce(sum(pa.amount), 0)::numeric(14,2) as allocated
                      from finance.payment_allocations pa where pa.invoice_id = i.id) a
  cross join lateral (select coalesce(sum(cn.amount + cn.tax_amount), 0)::numeric(14,2) as credited
                      from finance.credit_notes cn where cn.invoice_id = i.id) cr;

create or replace view api.v_invoice_lines with (security_invoker = true) as
  select ii.id as invoice_item_id, ii.invoice_id, ii.order_item_id, ii.variant_id, v.sku, ii.description,
         ii.quantity, ii.unit_price,
         coalesce(ii.line_subtotal, round(ii.unit_price * ii.quantity, 2))::numeric(14,2) as line_subtotal,
         ii.discount, ii.tax_rate_pct, ii.tax_amount, ii.line_total,
         coalesce(cn.qty, 0)::int as credited_qty, coalesce(cn.total, 0)::numeric(14,2) as credited_amount
  from finance.invoice_items ii
  left join catalog.product_variants v on v.id = ii.variant_id
  left join lateral (select sum(ci.quantity) as qty, sum(ci.amount + ci.tax_amount) as total
                     from finance.credit_note_items ci where ci.invoice_item_id = ii.id) cn on true;

create or replace view api.v_credit_notes with (security_invoker = true) as
  select cn.id, cn.credit_no, cn.invoice_id, i.invoice_no, cn.customer_id, c.display_name as customer_name,
         cn.reason, cn.amount, cn.tax_amount, (cn.amount + cn.tax_amount)::numeric(14,2) as total,
         cn.issue_date, cn.return_id, cn.approval_request_id, cn.created_at,
         exists (select 1 from finance.credit_note_items ci where ci.credit_note_id = cn.id) as by_lines
  from finance.credit_notes cn
  left join finance.invoices i on i.id = cn.invoice_id
  left join crm.customers c on c.id = cn.customer_id;

create or replace view api.v_payments with (security_invoker = true) as
  select p.id, p.payment_no, p.client_ref, p.customer_id, c.customer_no, c.display_name as customer_name,
         p.collected_by, col.full_name_en as collected_by_name_en, col.full_name_ar as collected_by_name_ar,
         p.method, p.amount, a.allocated,
         case when p.status = 'confirmed' then (p.amount - a.allocated) else 0 end::numeric(14,2) as unallocated,
         p.received_at, p.reference, p.cheque_due_date, p.status, p.status_reason,
         p.confirmed_at, p.reversed_at, p.created_at,
         (p.collected_by = (select authz.current_employee_id())) as is_mine
  from finance.payments p
  left join crm.customers c on c.id = p.customer_id
  left join lateral crm.employee_display(p.collected_by) col on true
  cross join lateral (select coalesce(sum(pa.amount), 0)::numeric(14,2) as allocated
                      from finance.payment_allocations pa where pa.payment_id = p.id) a;

create or replace view api.v_payment_allocations with (security_invoker = true) as
  select pa.id, pa.payment_id, p.payment_no, p.method as payment_method, pa.invoice_id, i.invoice_no, pa.amount,
         pa.reverses_allocation_id,
         exists (select 1 from finance.payment_allocations x where x.reverses_allocation_id = pa.id) as is_reversed,
         pa.allocated_at, pa.reason
  from finance.payment_allocations pa
  left join finance.payments p on p.id = pa.payment_id
  left join finance.invoices i on i.id = pa.invoice_id;

-- Statement: the AR ledger with a running balance per customer (debit = owed, credit = paid/credited).
-- The window runs over every visible row of the customer; ledger RLS shows all of a customer's
-- rows or none, so the running balance is the true balance. Filters on posted_at are applied
-- after the window, so a date-filtered statement still shows true running balances.
create or replace view api.v_customer_statement with (security_invoker = true) as
  select l.id as entry_id, l.customer_id, c.customer_no, c.display_name as customer_name,
         l.posted_at, (l.posted_at at time zone 'Africa/Cairo')::date as posted_date,
         l.entry_type, l.source_table, l.source_id,
         coalesce(i.invoice_no, cn.credit_no, p.payment_no) as document_no,
         i.due_date,
         greatest(l.amount, 0)::numeric(14,2) as debit,
         greatest(-l.amount, 0)::numeric(14,2) as credit,
         l.amount,
         (sum(l.amount) over (partition by l.customer_id order by l.posted_at, l.id
                              rows between unbounded preceding and current row))::numeric(14,2) as running_balance
  from finance.customer_ledger l
  left join crm.customers c on c.id = l.customer_id
  left join finance.invoices i on l.source_table = 'finance.invoices' and i.id = l.source_id
  left join finance.credit_notes cn on l.source_table = 'finance.credit_notes' and cn.id = l.source_id
  left join finance.payments p on l.source_table = 'finance.payments' and p.id = l.source_id;

-- Aging per customer. Buckets by days past due on core.business_date(): current (not yet due),
-- 1–30, 31–60, 61–90, > 90. unapplied_credit = open invoices − ledger balance (unallocated
-- payments and credits). Rows only for holders of finance.page.aging or finance.ledger.read.
create or replace view api.v_ar_aging with (security_invoker = true) as
  with gate as (
    select ((select authz.has_permission('finance.page.aging')) or (select authz.has_permission('finance.ledger.read'))) as ok
  ), inv as (
    select i.customer_id, core.business_date() - i.due_date as days,
           (i.total - coalesce((select sum(pa.amount) from finance.payment_allocations pa where pa.invoice_id = i.id), 0)
                    - coalesce((select sum(cn.amount + cn.tax_amount) from finance.credit_notes cn where cn.invoice_id = i.id), 0)
           ) as open_amount
    from finance.invoices i, gate
    where gate.ok and i.status in ('issued','partially_paid')
  ), per as (
    select customer_id,
           coalesce(sum(open_amount) filter (where days <= 0), 0) as current_amount,
           coalesce(sum(open_amount) filter (where days between 1 and 30), 0) as d1_30,
           coalesce(sum(open_amount) filter (where days between 31 and 60), 0) as d31_60,
           coalesce(sum(open_amount) filter (where days between 61 and 90), 0) as d61_90,
           coalesce(sum(open_amount) filter (where days > 90), 0) as d90_plus,
           sum(open_amount) as total_open,
           count(*)::int as open_invoices,
           (count(*) filter (where days > 0))::int as overdue_invoices,
           max(days) filter (where days > 0) as max_days_overdue
    from inv where open_amount > 0
    group by customer_id
  ), bal as (
    select l.customer_id, sum(l.amount) as balance
    from finance.customer_ledger l, gate where gate.ok
    group by l.customer_id
  )
  select c.id as customer_id, c.customer_no, c.display_name as customer_name, c.territory_id,
         t.code as territory_code, t.name_en as territory_name_en, t.name_ar as territory_name_ar,
         pr.employee_id as rep_employee_id, rep.full_name_en as rep_name_en, rep.full_name_ar as rep_name_ar,
         coalesce(per.current_amount, 0)::numeric(14,2) as current_amount,
         coalesce(per.d1_30, 0)::numeric(14,2) as d1_30,
         coalesce(per.d31_60, 0)::numeric(14,2) as d31_60,
         coalesce(per.d61_90, 0)::numeric(14,2) as d61_90,
         coalesce(per.d90_plus, 0)::numeric(14,2) as d90_plus,
         coalesce(per.total_open, 0)::numeric(14,2) as total_open,
         coalesce(per.total_open, 0) - coalesce(per.current_amount, 0) as overdue_amount,
         coalesce(per.open_invoices, 0) as open_invoices,
         coalesce(per.overdue_invoices, 0) as overdue_invoices,
         coalesce(per.max_days_overdue, 0) as max_days_overdue,
         coalesce(bal.balance, 0)::numeric(14,2) as ledger_balance,
         greatest(coalesce(per.total_open, 0) - coalesce(bal.balance, 0), 0)::numeric(14,2) as unapplied_credit
  from crm.customers c
  left join per on per.customer_id = c.id
  left join bal on bal.customer_id = c.id
  left join core.territories t on t.id = c.territory_id
  left join lateral (select a.employee_id from crm.customer_assignments a
                     where a.customer_id = c.id and a.role = 'primary_rep' and a.valid_to is null limit 1) pr on true
  left join lateral crm.employee_display(pr.employee_id) rep on true
  where per.customer_id is not null or coalesce(bal.balance, 0) <> 0;

create or replace view api.v_ar_aging_totals with (security_invoker = true) as
  select count(*)::int as customers,
         coalesce(sum(current_amount), 0)::numeric(14,2) as current_amount,
         coalesce(sum(d1_30), 0)::numeric(14,2) as d1_30,
         coalesce(sum(d31_60), 0)::numeric(14,2) as d31_60,
         coalesce(sum(d61_90), 0)::numeric(14,2) as d61_90,
         coalesce(sum(d90_plus), 0)::numeric(14,2) as d90_plus,
         coalesce(sum(total_open), 0)::numeric(14,2) as total_open,
         coalesce(sum(overdue_amount), 0)::numeric(14,2) as overdue_amount,
         coalesce(sum(ledger_balance), 0)::numeric(14,2) as ledger_balance,
         coalesce(sum(unapplied_credit), 0)::numeric(14,2) as unapplied_credit
  from api.v_ar_aging;

create or replace view api.v_collection_tasks with (security_invoker = true) as
  select t.id, t.customer_id, c.customer_no, c.display_name as customer_name, t.invoice_id, i.invoice_no,
         i.due_date as invoice_due_date,
         case when i.id is not null then
           (i.total - coalesce((select sum(pa.amount) from finance.payment_allocations pa where pa.invoice_id = i.id), 0)
                    - coalesce((select sum(cn.amount + cn.tax_amount) from finance.credit_notes cn where cn.invoice_id = i.id), 0)
           )::numeric(14,2) end as invoice_open_amount,
         case when i.id is not null then greatest(core.business_date() - i.due_date, 0) end as days_overdue,
         t.assignee_employee_id, asg.full_name_en as assignee_name_en, asg.full_name_ar as assignee_name_ar,
         t.due_date, t.status, t.promised_amount, t.promised_date,
         (t.status = 'promised' and t.promised_date < core.business_date()) as promise_broken,
         t.outcome, t.work_task_id, t.created_at, t.updated_at, t.closed_at,
         (t.assignee_employee_id = (select authz.current_employee_id())) as is_mine
  from finance.collection_tasks t
  left join crm.customers c on c.id = t.customer_id
  left join finance.invoices i on i.id = t.invoice_id
  left join lateral crm.employee_display(t.assignee_employee_id) asg on true;

-- Orders that can be invoiced now (fulfilled quantity not yet invoiced). For invoice issuers only.
create or replace view api.v_invoiceable_order_lines with (security_invoker = true) as
  select oi.id as order_item_id, oi.order_id, oi.line_no, oi.variant_id, v.sku, v.name_en as variant_name,
         oi.quantity, oi.fulfilled_qty, coalesce(ii.q, 0)::int as invoiced_qty,
         (oi.fulfilled_qty - coalesce(ii.q, 0))::int as uninvoiced_qty,
         oi.list_price, oi.applied_discount_pct, oi.tax_rate_pct
  from sales.order_items oi
  join sales.orders o on o.id = oi.order_id
  left join catalog.product_variants v on v.id = oi.variant_id
  left join lateral (select sum(x.quantity) as q from finance.invoice_items x where x.order_item_id = oi.id) ii on true
  where o.status in ('fulfilled','partially_fulfilled')
    and (select authz.has_permission('finance.invoice.issue'));

create or replace view api.v_invoiceable_orders with (security_invoker = true) as
  select o.id as order_id, o.order_no, o.customer_id, c.display_name as customer_name, o.status,
         o.employee_id, e.full_name_en as employee_name_en, e.full_name_ar as employee_name_ar,
         o.payment_terms_days, o.total as order_total, o.submitted_at,
         sum(l.uninvoiced_qty)::int as uninvoiced_qty,
         (count(*) filter (where l.uninvoiced_qty > 0))::int as uninvoiced_lines,
         (select count(*) from finance.invoices i where i.order_id = o.id)::int as invoices
  from api.v_invoiceable_order_lines l
  join sales.orders o on o.id = l.order_id
  left join crm.customers c on c.id = o.customer_id
  left join lateral crm.employee_display(o.employee_id) e on true
  group by o.id, o.order_no, o.customer_id, c.display_name, o.status, o.employee_id, e.full_name_en, e.full_name_ar,
           o.payment_terms_days, o.total, o.submitted_at
  having sum(l.uninvoiced_qty) > 0;

grant select on api.v_invoices, api.v_invoice_lines, api.v_credit_notes, api.v_payments, api.v_payment_allocations,
                api.v_customer_statement, api.v_ar_aging, api.v_ar_aging_totals, api.v_collection_tasks,
                api.v_invoiceable_order_lines, api.v_invoiceable_orders to authenticated;
revoke all on api.v_invoices, api.v_invoice_lines, api.v_credit_notes, api.v_payments, api.v_payment_allocations,
              api.v_customer_statement, api.v_ar_aging, api.v_ar_aging_totals, api.v_collection_tasks,
              api.v_invoiceable_order_lines, api.v_invoiceable_orders from anon;
