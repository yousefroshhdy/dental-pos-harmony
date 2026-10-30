-- Receivables read side and collections (20261031000110_finance_ar_views.sql + the overdue
-- scan): aging buckets on the Cairo business day, statement running balance, record scope,
-- the overdue scan (exactly one task per invoice), collection tasks, balance = ledger.
--   users: a2 sales director · a3 area mgr Cairo · a4 rep Cairo (customer 4…01) · a5 rep Delta
--          (4…02) · a6 finance officer
begin;
select tests.load_fixture();
select plan(52);
set constraints all immediate;

-- ---------------------------------------------------------------------------
-- Setup (as the owner of the schema, like an opening-balance import would):
-- C-0002 (Delta) invoices due relative to core.business_date() — never current_date
--   +5d 50 · 0d 5 · −10d 100 · −30d 10 · −31d 20 · −45d 200 · −75d 300 · −120d 400
-- C-0001 (Cairo): one invoice due −5d, 70
-- ---------------------------------------------------------------------------
create temp table t_inv (n int, customer_id uuid, days int, total numeric);
insert into t_inv values
  (1, '40000000-0000-0000-0000-000000000002',    5,  50), (2, '40000000-0000-0000-0000-000000000002',    0,   5),
  (3, '40000000-0000-0000-0000-000000000002',  -10, 100), (4, '40000000-0000-0000-0000-000000000002',  -30,  10),
  (5, '40000000-0000-0000-0000-000000000002',  -31,  20), (6, '40000000-0000-0000-0000-000000000002',  -45, 200),
  (7, '40000000-0000-0000-0000-000000000002',  -75, 300), (8, '40000000-0000-0000-0000-000000000002', -120, 400),
  (9, '40000000-0000-0000-0000-000000000001',   -5,  70);
insert into finance.invoices (id, invoice_no, customer_id, issue_date, due_date, subtotal, total)
select ('f8000000-0000-0000-0000-00000000000' || n)::uuid, 'TST-' || n, customer_id,
       core.business_date() + days - 30, core.business_date() + days, total, total
from t_inv;
insert into finance.customer_ledger (customer_id, entry_type, amount, source_table, source_id, posted_at)
select customer_id, 'invoice', total, 'finance.invoices', ('f8000000-0000-0000-0000-00000000000' || n)::uuid,
       now() - make_interval(days => 200 - n)
from t_inv;

-- A 30 EGP bank transfer from C-0002, recorded and confirmed by finance, not allocated (unapplied).
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select api.record_payment('40000000-0000-0000-0000-000000000002', 30, 'bank_transfer', 'TRF-SYN-9', null,
                          'f8200000-0000-0000-0000-000000000001');

-- ===========================================================================
-- Aging
-- ===========================================================================
select is((select current_amount || '|' || d1_30 || '|' || d31_60 || '|' || d61_90 || '|' || d90_plus || '|' || total_open
           from api.v_ar_aging where customer_id = '40000000-0000-0000-0000-000000000002'),
  '55.00|110.00|220.00|300.00|400.00|1085.00',
  'buckets: due today is current; 30 days late is 1–30; 31 is 31–60; 120 is > 90');
select is((select ledger_balance || '|' || unapplied_credit || '|' || overdue_invoices || '|' || max_days_overdue
           from api.v_ar_aging where customer_id = '40000000-0000-0000-0000-000000000002'),
  '1055.00|30.00|6|120', 'ledger balance, unapplied payment, overdue count and oldest age');
select is((select customers || '|' || d1_30 || '|' || total_open || '|' || overdue_amount from api.v_ar_aging_totals),
  '2|180.00|1155.00|1100.00', 'aging totals across customers');
select is((select string_agg(invoice_no || '=' || coalesce(aging_bucket, '-'), ',' order by invoice_no)
           from api.v_invoices where invoice_no like 'TST-%'),
  'TST-1=current,TST-2=current,TST-3=d1_30,TST-4=d1_30,TST-5=d31_60,TST-6=d31_60,TST-7=d61_90,TST-8=d90_plus,TST-9=d1_30',
  'each invoice carries its aging bucket');
select is((select days_overdue from api.v_invoices where invoice_no = 'TST-8'), 120, 'days overdue on the Cairo business day');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a5');
select is((select count(*)::int from api.v_ar_aging), 0, 'a rep has no aging report (no finance.page.aging)');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a3');
select is((select count(*)::int from api.v_ar_aging), 0, 'nor an area manager by default');
select is((select customers from api.v_ar_aging_totals), 0, 'nor its totals');

-- ===========================================================================
-- Record scope (42501 for commands, empty reads for rows out of scope)
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a5');
select is((select count(*)::int from api.v_invoices), 8, 'the Delta rep sees their customer''s 8 invoices');
select is((select count(*)::int from api.v_invoices where customer_id = '40000000-0000-0000-0000-000000000001'), 0,
  'and none of another rep''s customer');
select is((select count(*)::int from api.v_payments), 1, 'the rep sees a payment finance recorded for their customer');
select is((select count(*)::int from api.v_customer_statement), 0, 'a rep has no ledger statement (no finance.ledger.read)');
select throws_ok($$select api.record_payment('40000000-0000-0000-0000-000000000001', 10, 'cash', null, null,
                   'f8200000-0000-0000-0000-0000000000ff')$$, '42501', null, 'nor records payments for another rep''s customer');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is((select string_agg(invoice_no, ',') from api.v_invoices), 'TST-9', 'the Cairo rep sees only TST-9');
select is((select count(*)::int from api.v_payments), 0, 'and no Delta payment');
select is((select count(*)::int from api.v_invoice_lines), 0, 'no invoice lines of other customers');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a3');
select is((select string_agg(invoice_no, ',') from api.v_invoices), 'TST-9', 'the Cairo area manager sees the Cairo territory only');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a2');
select is((select count(*)::int from api.v_invoices), 9, 'the sales director (finance.invoice.read all) sees every invoice');
select tests.clear_authentication();

-- ===========================================================================
-- Statement with running balance
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select is((select string_agg(running_balance::text, ',' order by posted_at, entry_id)
           from api.v_customer_statement where customer_id = '40000000-0000-0000-0000-000000000002'),
  '50.00,55.00,155.00,165.00,185.00,385.00,685.00,1085.00,1055.00', 'the running balance accumulates every entry');
select is((select document_no || ':' || credit from api.v_customer_statement
           where customer_id = '40000000-0000-0000-0000-000000000002' and entry_type = 'payment'),
  (select payment_no from finance.payments where client_ref = 'f8200000-0000-0000-0000-000000000001') || ':30.00',
  'a payment appears as a credit with its number');
select is((select running_balance from api.v_customer_statement
           where customer_id = '40000000-0000-0000-0000-000000000002' and posted_at >= now() - interval '193 days'
           order by posted_at, entry_id limit 1), 685.00::numeric(14,2),
  'a date-filtered statement keeps the true running balance (opening balance included)');
select is((select running_balance from api.v_customer_statement
           where customer_id = '40000000-0000-0000-0000-000000000002' order by posted_at desc, entry_id desc limit 1),
  (select balance from api.v_customers where id = '40000000-0000-0000-0000-000000000002'),
  'the statement''s closing balance equals the CRM customer balance');
select is((select count(*)::int from crm.customers c
           where (select balance from api.v_customers v where v.id = c.id)
                 <> coalesce((select sum(amount) from finance.customer_ledger l where l.customer_id = c.id), 0)), 0,
  'for every customer the CRM balance equals the ledger');

-- ===========================================================================
-- Overdue scan (service_role only; exactly one task per invoice)
-- ===========================================================================
select tests.clear_authentication();
select ok(not has_function_privilege('authenticated', 'service.finance_overdue_scan(integer)', 'execute')
          and not has_function_privilege('anon', 'service.finance_overdue_scan(integer)', 'execute')
          and has_function_privilege('service_role', 'service.finance_overdue_scan(integer)', 'execute'),
  'the overdue scan runs only as the service role');
create temp table scan (r jsonb);
grant all on scan to service_role;
set local role service_role;
insert into scan select service.finance_overdue_scan();
reset role;
select is((select (r ->> 'created')::int from scan), 7, 'the scan opens a task for each of the 7 overdue invoices');
select is((select count(*)::int from finance.collection_tasks), 7, '7 collection tasks');
select is((select count(*)::int from finance.collection_tasks t join finance.invoices i on i.id = t.invoice_id
           where i.due_date >= core.business_date()), 0, 'nothing for invoices not yet past due');
select is((select count(*)::int from finance.collection_tasks
           where customer_id = '40000000-0000-0000-0000-000000000002' and assignee_employee_id = '20000000-0000-0000-0000-000000000005'), 6,
  'Delta tasks go to the customer''s primary rep');
select is((select count(*)::int from work.tasks where kind = 'collection' and source = 'system'
           and assignee_employee_id = '20000000-0000-0000-0000-000000000005' and status = 'open'), 6,
  'the rep gets a linked collection task in their task list');
select is((select count(*)::int from finance.collection_tasks t join work.tasks w on w.id = t.work_task_id
           where w.ref_table = 'finance.collection_tasks' and w.ref_id = t.id), 7, 'each collection task links its work task');
select is((select count(*)::int from integration.outbox where event_type = 'invoice.overdue'), 7, 'invoice.overdue per invoice');
select is((select count(*)::int from notify.notifications where type = 'invoice.overdue'
           and recipient_user_id = '00000000-0000-0000-0000-0000000000a5'), 6, 'the rep is notified');
truncate scan;
set local role service_role;
insert into scan select service.finance_overdue_scan();
reset role;
select is((select (r ->> 'created')::int from scan), 0, 'a second run creates nothing');
select is((select count(*)::int from (select invoice_id from finance.collection_tasks group by invoice_id having count(*) > 1) d), 0,
  'exactly one collection task per invoice');
select is((select count(*)::int from integration.outbox where event_type = 'invoice.overdue'), 7, 'and no second event');

-- ===========================================================================
-- Collection tasks
-- ===========================================================================
create temp table t_task4 as select id from finance.collection_tasks where invoice_id = 'f8000000-0000-0000-0000-000000000004';
grant select on t_task4 to authenticated;
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a5');
select is((select count(*)::int from api.v_collection_tasks), 6, 'the rep sees their 6 collection tasks');
select is(api.update_collection_task((select id from finance.collection_tasks where invoice_id = 'f8000000-0000-0000-0000-000000000004'),
    'promise', core.business_date() + 3, 10, 'will pay on Sunday') ->> 'status', 'promised', 'the rep records a promise to pay');
select throws_like(format($$select api.update_collection_task(%L, 'promise', %L, null, null)$$,
    (select id from finance.collection_tasks where invoice_id = 'f8000000-0000-0000-0000-000000000005'), core.business_date() - 1),
  'VALIDATION%', 'a promise date is today or later');
select throws_like(format($$select api.update_collection_task(%L, 'archive')$$,
    (select id from finance.collection_tasks where invoice_id = 'f8000000-0000-0000-0000-000000000005')),
  'VALIDATION%', 'unknown actions are refused');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is((select count(*)::int from api.v_collection_tasks), 1, 'the Cairo rep sees only their own task');
select throws_ok(format($$select api.update_collection_task(%L, 'escalate', null, null, 'x')$$, (select id from t_task4)),
  '42501', null, 'another rep cannot touch it');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select is((select promised_amount::text || '@' || (promised_date - core.business_date()) from api.v_collection_tasks
           where invoice_id = 'f8000000-0000-0000-0000-000000000004'), '10.00@3', 'finance sees the promise');
select throws_like(format($$select api.update_collection_task(%L, 'close')$$,
    (select id from finance.collection_tasks where invoice_id = 'f8000000-0000-0000-0000-000000000005')),
  'REASON_REQUIRED%', 'closing needs a note');
select is(api.update_collection_task((select id from finance.collection_tasks where invoice_id = 'f8000000-0000-0000-0000-000000000005'),
    'close', null, null, 'disputed; handled by credit note') ->> 'status', 'closed', 'finance closes a task with a note');
select throws_like(format($$select api.update_collection_task(%L, 'escalate', null, null, 'late')$$,
    (select id from finance.collection_tasks where invoice_id = 'f8000000-0000-0000-0000-000000000005')),
  'INVALID_STATE%', 'a closed task stays closed');
select tests.clear_authentication();
select is((select w.status from work.tasks w join finance.collection_tasks t on t.work_task_id = w.id
           where t.invoice_id = 'f8000000-0000-0000-0000-000000000005'), 'done', 'closing it completes the rep''s task');

-- Settling the invoice completes its collection; a reversal reopens it.
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select api.record_payment('40000000-0000-0000-0000-000000000002', 100, 'bank_transfer', 'TRF-SYN-10', null,
                          'f8200000-0000-0000-0000-000000000002');
select is((api.allocate_payment((select id from finance.payments where client_ref = 'f8200000-0000-0000-0000-000000000002'),
    '[{"invoice_id":"f8000000-0000-0000-0000-000000000003","amount":100}]') -> 'invoices' -> 0 ->> 'status'), 'paid',
  'the invoice is paid');
select is((select status from api.v_collection_tasks where invoice_id = 'f8000000-0000-0000-0000-000000000003'), 'collected',
  'its collection task is collected automatically');
select tests.clear_authentication();
select is((select w.status from work.tasks w join finance.collection_tasks t on t.work_task_id = w.id
           where t.invoice_id = 'f8000000-0000-0000-0000-000000000003'), 'done', 'and the rep''s task is done');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select api.reverse_payment((select id from finance.payments where client_ref = 'f8200000-0000-0000-0000-000000000002'), 'recalled by the bank');
select is((select status from api.v_collection_tasks where invoice_id = 'f8000000-0000-0000-0000-000000000003'), 'open',
  'a reversal that makes the overdue invoice owed again reopens the collection task');
select is((select status || ':' || open_amount from api.v_invoices where invoice_no = 'TST-3'), 'issued:100.00',
  'and the invoice');
select tests.clear_authentication();

select is((select count(*)::int from crm.customers c
           where coalesce((select sum(amount) from finance.customer_ledger l where l.customer_id = c.id), 0)
              <> coalesce((select sum(total) from finance.invoices i where i.customer_id = c.id), 0)
               - coalesce((select sum(amount + tax_amount) from finance.credit_notes n where n.customer_id = c.id), 0)
               - coalesce((select sum(amount) from finance.payments p where p.customer_id = c.id and p.status = 'confirmed'), 0)), 0,
  'the ledger still equals the documents for every customer');

select * from finish();
rollback;
