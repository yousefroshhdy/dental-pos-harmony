-- Third-audit regressions for receivables and dashboards (20261101000100_audit3_finance_fixes.sql).
--   M1  every AR mutation takes the per-customer advisory lock; FIFO never over-allocates
--   M2  received_at back-date bounds (rep 3 days, finance 31 days, never a closed period);
--       a late confirmation is collected in the open period
--   M6  collection tasks: who may do what, 'collected' only when settled, the scan reopens
--   L1  kpi_summary hides another territory's target
--   L3  a bounce does not restate a closed period's CASH_COLLECTED
--   users: a2 sales director (perf.kpi.read all) · a3 area mgr Cairo (team) · a4 rep Cairo
--          (E004, customer 4…01) · a5 rep Delta (E005, 4…02) · a6 finance officer
-- Dates are relative to core.business_date(); "closed month" is the previous month once it
-- has closed (from day 6), else the month before it.
begin;
select tests.load_fixture();
select plan(68);
set constraints all immediate;

-- Runs a statement and returns its text result, or 'ERROR <sqlstate> <CODE>' (the error is
-- rolled back with its subtransaction), so one regression never aborts the rest of the suite.
create function pg_temp.try(p_sql text) returns text language plpgsql as $$
declare r text;
begin
  execute p_sql into r;
  return r;
exception when others then
  return 'ERROR ' || sqlstate || ' ' || split_part(sqlerrm, ':', 1);
end $$;
-- Is this backend holding the AR advisory lock of a customer? (bigint key: classid = high
-- 32 bits, objid = low 32 bits, objsubid = 1)
create function pg_temp.tryj(p_sql text) returns jsonb language plpgsql as $$
declare r jsonb;
begin
  execute p_sql into r;
  return r;
exception when others then
  return jsonb_build_object('error', sqlstate || ' ' || split_part(sqlerrm, ':', 1));
end $$;
create function pg_temp.ar_locked(p_customer uuid) returns boolean language sql as $$
  select exists (select 1 from pg_locks l
                 where l.locktype = 'advisory' and l.pid = pg_backend_pid() and l.granted and l.objsubid = 1
                   and ((l.classid::bigint << 32) | l.objid::bigint) = hashtextextended('finance.ar:' || p_customer::text, 0)) $$;
create function pg_temp.noon(p_day date) returns timestamptz language sql immutable as $$
  select ((p_day::timestamp + time '12:00') at time zone 'Africa/Cairo') $$;
create function pg_temp.closed_month() returns date language sql as $$
  select (date_trunc('month', core.business_date())
          - case when extract(day from core.business_date()) > 5 then interval '1 month' else interval '2 months' end)::date $$;
create function pg_temp.month_end(p_start date) returns date language sql immutable as $$
  select (p_start + interval '1 month' - interval '1 day')::date $$;
create function pg_temp.cash(p_from date) returns numeric language sql as $$
  select value from api.kpi_summary(p_from, pg_temp.month_end(p_from)) where kpi_code = 'CASH_COLLECTED' $$;
create function pg_temp.this_month() returns date language sql as $$
  select date_trunc('month', core.business_date())::date $$;
grant execute on all functions in schema pg_temp to authenticated;

-- ---------------------------------------------------------------------------
-- Setup (schema owner, like an opening-balance import): five synthetic Cairo customers X1…X5
-- (rep E004), each with two invoices (1140 due −20d, 2280 due −5d) and a confirmed 2000 payment.
-- ---------------------------------------------------------------------------
insert into crm.customers (id, customer_no, clinic_name, display_name, territory_id, lifecycle_stage)
select ('31c00000-0000-0000-0000-00000000000' || n)::uuid, 'C-T31-' || n, 'Synthetic Clinic 31-' || n, 'Synthetic Clinic 31-' || n,
       '10000000-0000-0000-0000-000000000003', 'active'
from generate_series(1, 5) n;
insert into crm.customer_assignments (customer_id, employee_id)
select ('31c00000-0000-0000-0000-00000000000' || n)::uuid, '20000000-0000-0000-0000-000000000004' from generate_series(1, 5) n;
insert into finance.invoices (id, invoice_no, customer_id, issue_date, due_date, status, subtotal, discount_total, tax_total, total)
select ('31d00000-0000-0000-0000-0000000000' || n || k)::uuid, 'INV-T31-' || n || k, ('31c00000-0000-0000-0000-00000000000' || n)::uuid,
       core.business_date() - 30, core.business_date() - case k when 1 then 20 else 5 end, 'issued',
       1000 * k, 0, 140 * k, 1140 * k
from generate_series(1, 5) n, generate_series(1, 2) k;
insert into finance.payments (id, payment_no, client_ref, customer_id, collected_by, method, amount, received_at, status, confirmed_at)
select ('31e00000-0000-0000-0000-00000000000' || n)::uuid, 'PAY-T31-' || n, gen_random_uuid(), ('31c00000-0000-0000-0000-00000000000' || n)::uuid,
       '20000000-0000-0000-0000-000000000004', 'cash', 2000, now() - interval '1 hour', 'confirmed', now() - interval '1 hour'
from generate_series(1, 5) n;
-- X3 and X4 already have one allocation each (to reverse below).
insert into finance.payment_allocations (id, payment_id, invoice_id, amount) values
  ('31f00000-0000-0000-0000-000000000003', '31e00000-0000-0000-0000-000000000003', '31d00000-0000-0000-0000-000000000031', 1000),
  ('31f00000-0000-0000-0000-000000000004', '31e00000-0000-0000-0000-000000000004', '31d00000-0000-0000-0000-000000000041', 1000);

-- ===========================================================================
-- M1. Per-customer AR lock and FIFO
-- ===========================================================================
select ok(not exists (select 1 from pg_locks where locktype = 'advisory' and pid = pg_backend_pid()),
  'M1 no advisory lock is held before the commands run');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select is(pg_temp.tryj($$select api.allocate_payment('31e00000-0000-0000-0000-000000000001', null, 'fifo-31-1') -> 'allocations'$$)
            @> '[{"invoice_id":"31d00000-0000-0000-0000-000000000011","amount":1140.00},{"invoice_id":"31d00000-0000-0000-0000-000000000012","amount":860.00}]',
          true, 'M1 FIFO fills the oldest due invoice first, then the next');
select ok(pg_temp.ar_locked('31c00000-0000-0000-0000-000000000001'), 'M1 FIFO allocation holds the customer''s AR lock');
select ok(not pg_temp.ar_locked('31c00000-0000-0000-0000-000000000002'), 'M1 the lock is per customer (X2 not locked yet)');

select is(pg_temp.try($$select api.allocate_payment('31e00000-0000-0000-0000-000000000002',
            '[{"invoice_id":"31d00000-0000-0000-0000-000000000021","amount":500}]', 'man-31-2') ->> 'allocated'$$),
          '500', 'M1 a manual allocation is applied');
select ok(pg_temp.ar_locked('31c00000-0000-0000-0000-000000000002'), 'M1 manual allocation holds the customer''s AR lock');

select is(pg_temp.try($$select api.reverse_allocation('31f00000-0000-0000-0000-000000000003', 'wrong invoice') ->> 'replayed'$$),
          'false', 'M1 an allocation is reversed');
select ok(pg_temp.ar_locked('31c00000-0000-0000-0000-000000000003'), 'M1 allocation reversal holds the customer''s AR lock');

select is(pg_temp.try($$select api.reverse_payment('31e00000-0000-0000-0000-000000000004', 'cheque returned', true) ->> 'status'$$),
          'bounced', 'M1 a payment is reversed as bounced');
select ok(pg_temp.ar_locked('31c00000-0000-0000-0000-000000000004'), 'M1 payment reversal holds the customer''s AR lock');

select ok(pg_temp.try($$select api.issue_credit_note('31d00000-0000-0000-0000-000000000051', null, 100, 'synthetic goodwill', 'cn-31-5') ->> 'status'$$)
            in ('pending_approval', 'issued'), 'M1 a credit note is requested');
select ok(pg_temp.ar_locked('31c00000-0000-0000-0000-000000000005'), 'M1 a credit-note request holds the customer''s AR lock');

select tests.clear_authentication();
select is((select count(*)::int from unnest(array[
             'api.allocate_payment(uuid,jsonb,text)', 'api.reverse_allocation(uuid,text)', 'api.reverse_payment(uuid,text,boolean)',
             'api.issue_credit_note(uuid,jsonb,numeric,text,text)', 'wf.on_decided_finance_credit_note(uuid,boolean)']::regprocedure[]) f
           where pg_get_functiondef(f) ~ 'finance\.lock_customer_ar\('), 5,
  'M1 every allocation, reversal and credit-note path (incl. the approval hook) takes the AR lock');
select ok(substring(pg_get_functiondef('api.allocate_payment(uuid,jsonb,text)'::regprocedure)
                    from 'for v_row in(.*?)loop') ~ 'for update',
  'M1 FIFO selects its candidates FOR UPDATE in the loop statement itself');

-- Another payment for X1: FIFO takes only what is still open (2280 − 860 = 1420).
insert into finance.payments (id, payment_no, client_ref, customer_id, collected_by, method, amount, received_at, status, confirmed_at)
values ('31e00000-0000-0000-0000-000000000011', 'PAY-T31-11', gen_random_uuid(), '31c00000-0000-0000-0000-000000000001',
        '20000000-0000-0000-0000-000000000004', 'cash', 2000, now(), 'confirmed', now());
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select is(pg_temp.tryj($$select api.allocate_payment('31e00000-0000-0000-0000-000000000011', null, 'fifo-31-11')$$)
            @> '{"allocated":1420.00,"payment_unallocated":580.00}', true,
  'M1 FIFO allocates only the open remainder and leaves the rest unallocated');
select tests.clear_authentication();
select is((select count(*)::int from finance.invoices i
           where (select coalesce(sum(pa.amount), 0) from finance.payment_allocations pa where pa.invoice_id = i.id) > i.total), 0,
  'M1 no invoice is allocated more than its total');
select is((select string_agg(invoice_no || '=' || status, ',' order by invoice_no) from finance.invoices
           where invoice_no in ('INV-T31-11', 'INV-T31-12', 'INV-T31-31', 'INV-T31-41')),
  'INV-T31-11=paid,INV-T31-12=paid,INV-T31-31=issued,INV-T31-41=issued',
  'M1 invoice statuses follow the allocations and their reversals');

-- ===========================================================================
-- M2. received_at back-date bounds (C-0001, rep a4 / finance a6)
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is(pg_temp.try(format($$select api.record_payment('40000000-0000-0000-0000-000000000001', 100, 'cash', null, %L,
            '31a00000-0000-0000-0000-000000000001') ->> 'status'$$, pg_temp.noon(core.business_date() - 2))),
  'pending_verification', 'M2 a rep may record a payment received 2 days ago');
select is(pg_temp.try(format($$select api.record_payment('40000000-0000-0000-0000-000000000001', 100, 'cash', null, %L,
            '31a00000-0000-0000-0000-000000000002') ->> 'status'$$, pg_temp.noon(core.business_date() - 3))),
  'pending_verification', 'M2 … and 3 days ago (the rep bound)');
select throws_like(format($$select api.record_payment('40000000-0000-0000-0000-000000000001', 100, 'cash', null, %L,
            '31a00000-0000-0000-0000-000000000003')$$, pg_temp.noon(core.business_date() - 4)),
  'VALIDATION%at most 3 days%', 'M2 a rep cannot back-date 4 days');
select throws_like(format($$select api.record_payment('40000000-0000-0000-0000-000000000001', 100, 'cash', null, %L,
            '31a00000-0000-0000-0000-000000000004')$$, '2025-01-15T10:00:00Z'),
  'VALIDATION%', 'M2 a rep cannot back-date into last year (audit repro)');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select is(pg_temp.try(format($$select api.record_payment('40000000-0000-0000-0000-000000000001', 100, 'bank_transfer', 'TRF-T31-1', %L,
            '31a00000-0000-0000-0000-000000000005') ->> 'status'$$, pg_temp.noon(core.business_date() - 5))),
  'confirmed', 'M2 finance may record a transfer received 5 days ago (always an open period)');
select throws_like(format($$select api.record_payment('40000000-0000-0000-0000-000000000001', 100, 'bank_transfer', 'TRF-T31-2', %L,
            '31a00000-0000-0000-0000-000000000006')$$, pg_temp.noon(core.business_date() - 32)),
  'VALIDATION%at most 31 days%', 'M2 finance cannot back-date beyond its 31-day bound');
select tests.clear_authentication();
update core.system_settings set value = '400' where key = 'finance.payment.max_backdate_days_finance';
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select throws_like(format($$select api.record_payment('40000000-0000-0000-0000-000000000001', 100, 'bank_transfer', 'TRF-T31-3', %L,
            '31a00000-0000-0000-0000-000000000007')$$, pg_temp.noon(pg_temp.closed_month() + 19)),
  'VALIDATION%closed period%', 'M2 even within the bound, a payment cannot land in a closed month');
select tests.clear_authentication();
update core.system_settings set value = '10' where key = 'finance.payment.max_backdate_days_rep';
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is(pg_temp.try(format($$select api.record_payment('40000000-0000-0000-0000-000000000001', 100, 'cash', null, %L,
            '31a00000-0000-0000-0000-000000000008') ->> 'status'$$, pg_temp.noon(core.business_date() - 5))),
  'pending_verification', 'M2 the bounds are settings the owner can change');
select tests.clear_authentication();
update core.system_settings set value = '3' where key = 'finance.payment.max_backdate_days_rep';
update core.system_settings set value = '31' where key = 'finance.payment.max_backdate_days_finance';
select is((select string_agg(key || '=' || value::text, ',' order by key) from core.system_settings
           where key like 'finance.payment.max_backdate_days_%'),
  'finance.payment.max_backdate_days_finance=31,finance.payment.max_backdate_days_rep=3', 'M2 default bounds are seeded');

-- A pending payment received in the closed month (recorded back then) confirmed only now is
-- collected now: confirming it cannot restate the closed month.
insert into finance.payments (id, payment_no, client_ref, customer_id, collected_by, method, amount, received_at, status)
values ('31e00000-0000-0000-0000-000000000021', 'PAY-T31-21', gen_random_uuid(), '40000000-0000-0000-0000-000000000001',
        '20000000-0000-0000-0000-000000000004', 'cash', 300, pg_temp.noon(pg_temp.closed_month() + 9), 'pending_verification');
create temp table t_kpi (k text primary key, v numeric);
grant all on t_kpi to authenticated;
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a2');
insert into t_kpi values ('closed0', pg_temp.cash(pg_temp.closed_month())), ('now0', pg_temp.cash(pg_temp.this_month()));
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select is(pg_temp.try($$select api.confirm_payment('31e00000-0000-0000-0000-000000000021') ->> 'status'$$), 'confirmed',
  'M2 finance confirms the old pending payment');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a2');
select is(pg_temp.cash(pg_temp.closed_month()), (select v from t_kpi where k = 'closed0'),
  'M2 the closed month''s collections are not restated by a late confirmation');
select is(pg_temp.cash(pg_temp.this_month()) - (select v from t_kpi where k = 'now0'), 300::numeric,
  'M2 … the payment is collected in the period it was confirmed');

-- ===========================================================================
-- L3. A bounce does not restate a closed period's CASH_COLLECTED
-- ===========================================================================
select tests.clear_authentication();
insert into finance.payments (id, payment_no, client_ref, customer_id, collected_by, method, amount, received_at, status, confirmed_at)
values ('31e00000-0000-0000-0000-000000000031', 'PAY-T31-31', gen_random_uuid(), '40000000-0000-0000-0000-000000000001',
        '20000000-0000-0000-0000-000000000004', 'bank_transfer', 5000, pg_temp.noon(pg_temp.closed_month() + 19), 'confirmed',
        pg_temp.noon(pg_temp.closed_month() + 19) + interval '1 hour');
insert into finance.customer_ledger (customer_id, entry_type, amount, source_table, source_id, posted_at)
values ('40000000-0000-0000-0000-000000000001', 'payment', -5000, 'finance.payments', '31e00000-0000-0000-0000-000000000031',
        pg_temp.noon(pg_temp.closed_month() + 19) + interval '1 hour');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a2');
select is(pg_temp.cash(pg_temp.closed_month()), 5000.00::numeric, 'L3 the closed month collected 5000');
insert into t_kpi values ('now1', pg_temp.cash(pg_temp.this_month()));
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
insert into t_kpi values ('rep1', pg_temp.cash(pg_temp.this_month()));
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select is(pg_temp.try($$select api.reverse_payment('31e00000-0000-0000-0000-000000000031', 'returned by bank', true) ->> 'status'$$),
  'bounced', 'L3 the transfer bounces now');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a2');
select is(pg_temp.cash(pg_temp.closed_month()), 5000.00::numeric, 'L3 the closed month still shows 5000 (not restated)');
select is(pg_temp.cash(pg_temp.this_month()) - (select v from t_kpi where k = 'now1'), -5000.00::numeric,
  'L3 the bounce counts −5000 in the current period');
select ok(((select detail from api.kpi_summary(pg_temp.this_month(), pg_temp.month_end(pg_temp.this_month()))
            where kpi_code = 'CASH_COLLECTED') ->> 'reversals')::int >= 1, 'L3 the reversal is visible in the KPI detail');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is(pg_temp.cash(pg_temp.this_month()) - (select v from t_kpi where k = 'rep1'), -5000.00::numeric,
  'L3 the collector''s own KPI carries the reversal in the current period');

-- A payment reversed before its period closes simply drops out of that period (no negative).
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a2');
insert into t_kpi values ('now2', pg_temp.cash(pg_temp.this_month()));
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select api.record_payment('40000000-0000-0000-0000-000000000001', 700, 'cash', null, null, '31a00000-0000-0000-0000-000000000009');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a2');
select is(pg_temp.cash(pg_temp.this_month()) - (select v from t_kpi where k = 'now2'), 700.00::numeric, 'L3 a new payment counts now');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select api.reverse_payment((select id from finance.payments where client_ref = '31a00000-0000-0000-0000-000000000009'), 'keyed twice');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a2');
select is(pg_temp.cash(pg_temp.this_month()) - (select v from t_kpi where k = 'now2'), 0.00::numeric,
  'L3 reversed in the same open period, it nets to zero (not −700)');

-- ===========================================================================
-- M6. Collection tasks
-- ===========================================================================
select tests.clear_authentication();
insert into finance.invoices (id, invoice_no, customer_id, issue_date, due_date, status, subtotal, discount_total, tax_total, total)
values ('31d00000-0000-0000-0000-000000000099', 'INV-T31-OLD', '40000000-0000-0000-0000-000000000001',
        core.business_date() - 60, core.business_date() - 40, 'issued', 1000, 0, 140, 1140);
insert into finance.customer_ledger (customer_id, entry_type, amount, source_table, source_id)
values ('40000000-0000-0000-0000-000000000001', 'invoice', 1140, 'finance.invoices', '31d00000-0000-0000-0000-000000000099');
create temp table scan (n int generated always as identity, r jsonb);
grant all on scan to service_role;
set local role service_role;
insert into scan (r) select service.finance_overdue_scan();
reset role;
create temp table t_old as select id from finance.collection_tasks where invoice_id = '31d00000-0000-0000-0000-000000000099';
grant select on t_old to authenticated;
select is((select count(*)::int from t_old), 1, 'M6 the scan opens a collection task for the overdue invoice');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is(pg_temp.try(format($$select api.update_collection_task(%L, 'collected')::text$$, (select id from t_old))),
  'ERROR 42501 PERMISSION_DENIED', 'M6 the assignee cannot mark an unpaid task collected (audit repro)');
select is(pg_temp.try(format($$select api.update_collection_task(%L, 'close', null, null, 'customer will pay later')::text$$, (select id from t_old))),
  'ERROR 42501 PERMISSION_DENIED', 'M6 the assignee cannot close it');
select is(pg_temp.try(format($$select api.update_collection_task(%L, 'promise', %L, 500, 'pays next week') ->> 'status'$$,
            (select id from t_old), core.business_date() + 2)),
  'promised', 'M6 the assignee records a promise to pay');
select is(pg_temp.try(format($$select api.update_collection_task(%L, 'reopen')::text$$, (select id from t_old))),
  'ERROR 42501 PERMISSION_DENIED', 'M6 the assignee cannot reopen (a broken promise is finance''s call)');
select is(pg_temp.try(format($$select api.update_collection_task(%L, 'escalate', null, null, 'not answering') ->> 'status'$$, (select id from t_old))),
  'escalated', 'M6 the assignee escalates');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select is(pg_temp.try(format($$select api.update_collection_task(%L, 'collected')::text$$, (select id from t_old))),
  'ERROR P0001 INVOICE_STILL_OPEN', 'M6 nobody marks a task collected while the invoice is open');
select is(pg_temp.try(format($$select api.update_collection_task(%L, 'close', null, null, 'handed to legal') ->> 'status'$$, (select id from t_old))),
  'closed', 'M6 finance closes it with a note');
select tests.clear_authentication();
select is((select w.status from work.tasks w join finance.collection_tasks t on t.work_task_id = w.id where t.id = (select id from t_old)),
  'done', 'M6 … which completes the rep''s work task');

set local role service_role;
insert into scan (r) select service.finance_overdue_scan();
reset role;
select is((select (r ->> 'reopened')::int from scan order by n desc limit 1), 1, 'M6 the scan reopens the closed task of the still-overdue invoice');
select is((select status || ':' || coalesce(outcome, '') from finance.collection_tasks where id = (select id from t_old)),
  'open:Reopened: invoice still open and overdue', 'M6 the task is open again, with the reason');
select is((select w.status from work.tasks w join finance.collection_tasks t on t.work_task_id = w.id where t.id = (select id from t_old)),
  'open', 'M6 … and so is the rep''s work task');
select ok(exists (select 1 from notify.notifications where recipient_user_id = '00000000-0000-0000-0000-0000000000a4'
                  and type = 'invoice.overdue' and data ->> 'reopened' = 'true'), 'M6 the assignee is told');
set local role service_role;
insert into scan (r) select service.finance_overdue_scan();
reset role;
select is((select (r ->> 'reopened')::int || '/' || (r ->> 'created')::int from scan order by n desc limit 1), '0/0',
  'M6 a second run reopens and creates nothing (idempotent)');
select is((select count(*)::int from finance.collection_tasks where invoice_id = '31d00000-0000-0000-0000-000000000099'), 1,
  'M6 still exactly one task for the invoice');

-- Tasks without an invoice: 'collected' only when the customer owes nothing.
insert into finance.collection_tasks (id, customer_id, assignee_employee_id, due_date, status) values
  ('31b00000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000005', core.business_date(), 'open'),
  ('31b00000-0000-0000-0000-000000000002', '40000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000004', core.business_date(), 'open');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select is(pg_temp.try($$select api.update_collection_task('31b00000-0000-0000-0000-000000000001', 'collected') ->> 'status'$$),
  'collected', 'M6 finance marks collected when the customer owes nothing');
select is(pg_temp.try($$select api.update_collection_task('31b00000-0000-0000-0000-000000000002', 'collected')::text$$),
  'ERROR P0001 INVOICE_STILL_OPEN', 'M6 … but not while the customer''s balance is positive');

-- Once the invoice is settled the task is collected automatically and the scan leaves it.
select api.record_payment('40000000-0000-0000-0000-000000000001', 1140, 'bank_transfer', 'TRF-T31-9', null,
                          '31a00000-0000-0000-0000-000000000010');
select is(pg_temp.try($$select api.allocate_payment((select id from finance.payments where client_ref = '31a00000-0000-0000-0000-000000000010'),
            '[{"invoice_id":"31d00000-0000-0000-0000-000000000099","amount":1140}]', 'man-31-99') -> 'invoices' -> 0 ->> 'status'$$),
  'paid', 'M6 the invoice is paid');
select tests.clear_authentication();
set local role service_role;
insert into scan (r) select service.finance_overdue_scan();
reset role;
select is((select status from finance.collection_tasks where id = (select id from t_old)), 'collected',
  'M6 a settled invoice''s task stays collected after the scan');

-- ===========================================================================
-- L1. kpi_summary and another territory's target
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a2');
select is(api.set_kpi_target('31900000-0000-0000-0000-000000000001', 'NET_REVENUE', pg_temp.this_month(),
            pg_temp.month_end(pg_temp.this_month()), 777777, null, null,
            (select id from core.territories where code = 'DELTA')) ->> 'replayed', 'false', 'L1 the director sets a Delta target');
select is(api.set_kpi_target('31900000-0000-0000-0000-000000000002', 'NET_REVENUE', pg_temp.this_month(),
            pg_temp.month_end(pg_temp.this_month()), 4444, '20000000-0000-0000-0000-000000000004') ->> 'replayed', 'false',
  'L1 … and a target for the Cairo rep');
select is((select target from api.kpi_summary(pg_temp.this_month(), pg_temp.month_end(pg_temp.this_month()), null,
             (select id from core.territories where code = 'DELTA')) where kpi_code = 'NET_REVENUE'), 777777.00::numeric,
  'L1 a company-wide KPI reader sees the territory target');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is((select count(*)::int from api.v_kpi_targets where territory_id is not null), 0, 'L1 the rep cannot list territory targets');
select is((select coalesce(target::text, 'NULL') from api.kpi_summary(pg_temp.this_month(), pg_temp.month_end(pg_temp.this_month()), null,
             (select id from core.territories where code = 'DELTA')) where kpi_code = 'NET_REVENUE'), 'NULL',
  'L1 … nor read the Delta target through kpi_summary (audit repro)');
select is((select target from api.kpi_summary(pg_temp.this_month(), pg_temp.month_end(pg_temp.this_month()))
           where kpi_code = 'NET_REVENUE'), 4444.00::numeric, 'L1 the rep still sees their own target');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a3');
select is((select coalesce(target::text, 'NULL') from api.kpi_summary(pg_temp.this_month(), pg_temp.month_end(pg_temp.this_month()), null,
             (select id from core.territories where code = 'DELTA')) where kpi_code = 'NET_REVENUE'), 'NULL',
  'L1 a team-scoped manager does not see another territory''s target either');

-- ===========================================================================
-- Privileges
-- ===========================================================================
select tests.clear_authentication();
select ok(not has_function_privilege('authenticated', 'finance.lock_customer_ar(uuid)', 'execute')
          and not has_function_privilege('authenticated', 'finance.ar_lock_key(uuid)', 'execute')
          and not has_function_privilege('anon', 'finance.lock_customer_ar(uuid)', 'execute')
          and not has_function_privilege('authenticated', 'perf.metric_cash_collected(uuid[],uuid[],date,date)', 'execute'),
  'the lock helpers and metric functions are internal');
select ok(not has_function_privilege('authenticated', 'service.finance_overdue_scan(integer)', 'execute')
          and has_function_privilege('service_role', 'service.finance_overdue_scan(integer)', 'execute'),
  'the overdue scan stays service-role only');
select ok(not has_function_privilege('authenticated', 'wf.on_decided_finance_credit_note(uuid,boolean)', 'execute'),
  'the credit-note decision hook is not client-callable');
select ok((select bool_and(has_function_privilege('authenticated', f, 'execute') and not has_function_privilege('anon', f, 'execute'))
           from unnest(array['api.record_payment(uuid,numeric,text,text,timestamptz,uuid,date)', 'api.allocate_payment(uuid,jsonb,text)',
                             'api.reverse_allocation(uuid,text)', 'api.reverse_payment(uuid,text,boolean)',
                             'api.issue_credit_note(uuid,jsonb,numeric,text,text)',
                             'api.update_collection_task(uuid,text,date,numeric,text)', 'api.kpi_summary(date,date,uuid,uuid)']::regprocedure[]) f),
  'the replaced commands stay callable by authenticated users only');
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname in ('api','finance','perf','service','wf')
             and p.proname in ('allocate_payment','reverse_allocation','reverse_payment','issue_credit_note','record_payment',
                               'update_collection_task','kpi_summary','finance_overdue_scan','metric_cash_collected',
                               'on_decided_finance_credit_note','lock_customer_ar','ar_lock_key')
             and not coalesce(p.proconfig, '{}') @> array['search_path=""']), 0,
  'every replaced or new function pins search_path = ''''');

select * from finish();
rollback;
