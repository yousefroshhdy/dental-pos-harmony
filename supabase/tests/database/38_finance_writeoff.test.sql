-- Invoice write-off and printable documents (20261103000500_finance_write_off_print.sql,
-- 20261103000599_dispatch.sql).
--   flow     request → approval (workflow finance.write_off) → write_off row + ledger entry
--   limits   amount ≤ open amount, validation, idempotency, one pending per invoice,
--            re-checked at decision time, no self-approval, approver EGP limit
--   scan     a written-off invoice no longer reopens collection work (11-01 known item);
--            a partly written-off invoice is still collected
--   ledger   customer balance = Σ ledger = Σ open invoices − unallocated payments
--   scope    finance.collection.manage only, in customer scope; RLS on the new view/table
--   print    api.company_profile(), api.v_invoice_print_party
-- Users: a3 area mgr · a4 rep Cairo (E004) · a5 rep Delta · a6 finance officer · a7 admin
--        c1 collection officer · f2 second finance officer · t1 collector scoped to Cairo
begin;
select tests.load_fixture();
select plan(81);
set constraints all immediate;

create function pg_temp.try(p_sql text) returns text language plpgsql as $$
declare r text;
begin
  execute p_sql into r;
  return r;
exception when others then
  return 'ERROR ' || sqlstate || ' ' || split_part(sqlerrm, ':', 1);
end $$;
create function pg_temp.req(p_key text) returns uuid language sql as $$
  select r.id from wf.approval_requests r join wf.workflow_definitions d on d.id = r.definition_id
  where d.code = 'finance.write_off' and r.payload ->> 'idempotency_key' = p_key $$;
create function pg_temp.task_status(p_invoice uuid) returns text language sql as $$
  select status from finance.collection_tasks where invoice_id = p_invoice $$;
grant execute on all functions in schema pg_temp to authenticated;

-- ---------------------------------------------------------------------------
-- Setup (schema owner, like an opening-balance import). Synthetic data only.
--   X1 I1 1140 due −40 · X2 I2 2280 due −10 (P2 1000 allocated) · X3 I3 1140 due −20
--   (P3 1000 unallocated) · X4 I4 1140 due −15 (P4 500 allocated) · D1 (Delta) ID 1140 due −20
-- ---------------------------------------------------------------------------
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000038c1', 'collector.38@honest.test'),
  ('00000000-0000-0000-0000-0000000038f2', 'finance2.38@honest.test'),
  ('00000000-0000-0000-0000-0000000038d1', 'collector.cairo.38@honest.test');
insert into core.employees (id, employee_no, user_id, full_name_en, job_title, manager_id) values
  ('38a00000-0000-0000-0000-0000000000c1', 'E38C1', '00000000-0000-0000-0000-0000000038c1', 'Synthetic Collector', 'Collection Officer', '20000000-0000-0000-0000-000000000006'),
  ('38a00000-0000-0000-0000-0000000000f2', 'E38F2', '00000000-0000-0000-0000-0000000038f2', 'Synthetic Finance Two', 'Finance Officer', '20000000-0000-0000-0000-000000000001'),
  ('38a00000-0000-0000-0000-0000000000d1', 'E38D1', '00000000-0000-0000-0000-0000000038d1', 'Synthetic Cairo Collector', 'Collection Officer', '20000000-0000-0000-0000-000000000006');
insert into core.user_profiles (user_id, employee_id) values
  ('00000000-0000-0000-0000-0000000038c1', '38a00000-0000-0000-0000-0000000000c1'),
  ('00000000-0000-0000-0000-0000000038f2', '38a00000-0000-0000-0000-0000000000f2'),
  ('00000000-0000-0000-0000-0000000038d1', '38a00000-0000-0000-0000-0000000000d1');
insert into authz.roles (id, code, name_en, name_ar) values
  ('38b00000-0000-0000-0000-000000000001', 't38_cairo_collector', 'Test Cairo collector', 'محصل تجريبي');
insert into authz.role_permissions (role_id, permission_code, scope) values
  ('38b00000-0000-0000-0000-000000000001', 'finance.collection.manage', 'territory'),
  ('38b00000-0000-0000-0000-000000000001', 'finance.invoice.read', 'territory');
insert into authz.user_roles (user_id, role_id, scope_territory_id)
select '00000000-0000-0000-0000-0000000038c1'::uuid, id, null::uuid from authz.roles where code = 'collection_officer'
union all
select '00000000-0000-0000-0000-0000000038f2'::uuid, id, null::uuid from authz.roles where code = 'finance_officer'
union all
select '00000000-0000-0000-0000-0000000038d1'::uuid, '38b00000-0000-0000-0000-000000000001'::uuid, (select id from core.territories where code = 'CAI-GIZ');

insert into crm.customers (id, customer_no, clinic_name, display_name, territory_id, lifecycle_stage)
select ('38c00000-0000-0000-0000-00000000000' || n)::uuid, 'C-T38-' || n, 'Synthetic Clinic 38-' || n, 'Synthetic Clinic 38-' || n,
       '10000000-0000-0000-0000-000000000003', 'active'
from generate_series(1, 4) n;
insert into crm.customers (id, customer_no, clinic_name, display_name, territory_id, lifecycle_stage)
select '38c00000-0000-0000-0000-0000000000d1', 'C-T38-D1', 'Synthetic Delta Clinic 38', 'Synthetic Delta Clinic 38', id, 'active'
from core.territories where code = 'DELTA';
insert into crm.customer_assignments (customer_id, employee_id)
select ('38c00000-0000-0000-0000-00000000000' || n)::uuid, '20000000-0000-0000-0000-000000000004'::uuid from generate_series(1, 4) n
union all select '38c00000-0000-0000-0000-0000000000d1'::uuid, '20000000-0000-0000-0000-000000000005'::uuid;

insert into finance.invoices (id, invoice_no, customer_id, issue_date, due_date, status, subtotal, discount_total, tax_total, total) values
  ('38d00000-0000-0000-0000-000000000001', 'INV-T38-1', '38c00000-0000-0000-0000-000000000001', core.business_date() - 70, core.business_date() - 40, 'issued', 1000, 0, 140, 1140),
  ('38d00000-0000-0000-0000-000000000002', 'INV-T38-2', '38c00000-0000-0000-0000-000000000002', core.business_date() - 40, core.business_date() - 10, 'partially_paid', 2000, 0, 280, 2280),
  ('38d00000-0000-0000-0000-000000000003', 'INV-T38-3', '38c00000-0000-0000-0000-000000000003', core.business_date() - 50, core.business_date() - 20, 'issued', 1000, 0, 140, 1140),
  ('38d00000-0000-0000-0000-000000000004', 'INV-T38-4', '38c00000-0000-0000-0000-000000000004', core.business_date() - 45, core.business_date() - 15, 'partially_paid', 1000, 0, 140, 1140),
  ('38d00000-0000-0000-0000-0000000000d1', 'INV-T38-D1', '38c00000-0000-0000-0000-0000000000d1', core.business_date() - 50, core.business_date() - 20, 'issued', 1000, 0, 140, 1140);
insert into finance.customer_ledger (customer_id, entry_type, amount, source_table, source_id)
select customer_id, 'invoice', total, 'finance.invoices', id from finance.invoices where invoice_no like 'INV-T38-%';
insert into finance.payments (id, payment_no, client_ref, customer_id, collected_by, method, amount, received_at, status, confirmed_at) values
  ('38e00000-0000-0000-0000-000000000002', 'PAY-T38-2', gen_random_uuid(), '38c00000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000004', 'cash', 1000, now() - interval '2 hours', 'confirmed', now() - interval '2 hours'),
  ('38e00000-0000-0000-0000-000000000003', 'PAY-T38-3', gen_random_uuid(), '38c00000-0000-0000-0000-000000000003', '20000000-0000-0000-0000-000000000004', 'cash', 1000, now() - interval '2 hours', 'confirmed', now() - interval '2 hours'),
  ('38e00000-0000-0000-0000-000000000004', 'PAY-T38-4', gen_random_uuid(), '38c00000-0000-0000-0000-000000000004', '20000000-0000-0000-0000-000000000004', 'bank_transfer', 500, now() - interval '2 hours', 'confirmed', now() - interval '2 hours');
insert into finance.customer_ledger (customer_id, entry_type, amount, source_table, source_id)
select customer_id, 'payment', -amount, 'finance.payments', id from finance.payments where payment_no like 'PAY-T38-%';
insert into finance.payment_allocations (id, payment_id, invoice_id, amount) values
  ('38f00000-0000-0000-0000-000000000002', '38e00000-0000-0000-0000-000000000002', '38d00000-0000-0000-0000-000000000002', 1000),
  ('38f00000-0000-0000-0000-000000000004', '38e00000-0000-0000-0000-000000000004', '38d00000-0000-0000-0000-000000000004', 500);

-- ===========================================================================
-- Reference data and privileges
-- ===========================================================================
select is((select count(*)::int from wf.workflow_definitions d join wf.workflow_rules r on r.definition_id = d.id
           join wf.workflow_stages s on s.rule_id = r.id
           where d.code = 'finance.write_off' and s.approver_permission = 'wf.decide.write_off'), 1,
  'the finance.write_off workflow has one stage decided by wf.decide.write_off');
select ok((select supports_limit and is_sensitive from authz.permissions where code = 'wf.decide.write_off'),
  'wf.decide.write_off is a sensitive permission with an EGP limit');
select ok(pg_get_functiondef('wf.dispatch_decision_hook(text,uuid,boolean)'::regprocedure) ~ 'finance\.write_off'
          and pg_get_functiondef('wf.dispatch_decision_hook(text,uuid,boolean)'::regprocedure) ~ 'finance\.credit_note',
  'dispatch runs the write-off hook and keeps the credit-note branch');
select ok(not has_function_privilege('authenticated', 'wf.on_decided_finance_write_off(uuid,boolean)', 'execute')
          and not has_function_privilege('authenticated', 'finance.invoice_written_off(uuid)', 'execute'),
  'the hook and the balance helper are not client-callable');
select ok(not has_function_privilege('anon', 'api.request_invoice_write_off(uuid,numeric,text,text)', 'execute')
          and has_function_privilege('authenticated', 'api.request_invoice_write_off(uuid,numeric,text,text)', 'execute'),
  'the request command is for signed-in users only');
select ok(exists (select 1 from pg_trigger where tgrelid = 'finance.invoice_write_offs'::regclass
                  and tgname = 'trg_invoice_write_offs_append_only'), 'append-only trigger is installed');

-- ===========================================================================
-- Before: the overdue scan creates collection work and reopens a task finance closed
-- ===========================================================================
select is((service.finance_overdue_scan() ->> 'created')::int >= 5, true, 'scan creates collection tasks for the overdue invoices');
select is(pg_temp.task_status('38d00000-0000-0000-0000-000000000001'), 'open', 'I1 has an open collection task');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select is(pg_temp.try($$select api.update_collection_task((select id from finance.collection_tasks where invoice_id = '38d00000-0000-0000-0000-000000000001'),
            'close', null, null, 'handed to legal (synthetic)') ->> 'status'$$), 'closed', 'finance closes I1''s task on purpose');
select tests.clear_authentication();
select ok((service.finance_overdue_scan() ->> 'reopened')::int >= 1, 'the scan reopens it while the invoice is open (the 11-01 known item)');
select is(pg_temp.task_status('38d00000-0000-0000-0000-000000000001'), 'open', 'I1''s task is open again');

-- ===========================================================================
-- Who may request
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is(pg_temp.try($$select api.request_invoice_write_off('38d00000-0000-0000-0000-000000000001', 1140, 'synthetic reason', 'wo-38-rep')$$),
  'ERROR 42501 PERMISSION_DENIED', 'a rep cannot request a write-off');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a3');
select is(pg_temp.try($$select api.request_invoice_write_off('38d00000-0000-0000-0000-000000000001', 1140, 'synthetic reason', 'wo-38-am')$$),
  'ERROR 42501 PERMISSION_DENIED', 'an area manager cannot request a write-off');
select tests.authenticate_as('00000000-0000-0000-0000-0000000038d1');
select is(pg_temp.try($$select api.request_invoice_write_off('38d00000-0000-0000-0000-0000000000d1', 1140, 'synthetic reason', 'wo-38-scope')$$),
  'ERROR 42501 PERMISSION_DENIED', 'a Cairo-scoped collector cannot write off a Delta invoice');

-- ===========================================================================
-- Full write-off of I1: request, idempotency, pending guard, approval
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000038c1');
select is(pg_temp.try($$select api.request_invoice_write_off('38d00000-0000-0000-0000-000000000001', 1140, 'clinic closed (synthetic)', 'wo-38-1') ->> 'status'$$),
  'pending_approval', 'a collection officer requests a full write-off; it waits for approval');
select is(pg_temp.try($$select api.request_invoice_write_off('38d00000-0000-0000-0000-000000000001', 1140, 'clinic closed (synthetic)', 'wo-38-1') ->> 'replayed'$$),
  'true', 'the same key replays the request');
select is((select count(*)::int from wf.approval_requests r join wf.workflow_definitions d on d.id = r.definition_id
           where d.code = 'finance.write_off' and r.payload ->> 'invoice_id' = '38d00000-0000-0000-0000-000000000001'), 1,
  'the replay created no second request');
select is(pg_temp.try($$select api.request_invoice_write_off('38d00000-0000-0000-0000-000000000001', 1000, 'clinic closed (synthetic)', 'wo-38-1')$$),
  'ERROR P0001 IDEMPOTENCY_CONFLICT', 'the same key with another amount is a conflict');
select is(pg_temp.try($$select api.request_invoice_write_off('38d00000-0000-0000-0000-000000000001', 100, 'second try (synthetic)', 'wo-38-1b')$$),
  'ERROR P0001 WRITE_OFF_PENDING', 'only one pending write-off per invoice');
select is((select status from finance.invoices where id = '38d00000-0000-0000-0000-000000000001'), 'issued',
  'nothing is posted while the request is pending');
select is((select count(*)::int from finance.customer_ledger where entry_type = 'write_off'), 0, 'no write-off ledger entry yet');
select is(pg_temp.try(format($$select api.decide_approval(%L, 'approve') ->> 'status'$$, pg_temp.req('wo-38-1'))),
  'ERROR 42501 SELF_APPROVAL', 'the requester cannot approve their own write-off');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select is(pg_temp.try(format($$select api.decide_approval(%L, 'approve') ->> 'status'$$, pg_temp.req('wo-38-1'))),
  'approved', 'a finance officer approves');
select tests.clear_authentication();
select is((select status from finance.invoices where id = '38d00000-0000-0000-0000-000000000001'), 'written_off', 'I1 is written off');
select is((select amount::numeric from finance.invoice_write_offs where invoice_id = '38d00000-0000-0000-0000-000000000001'), 1140.00::numeric,
  'the write-off row holds the approved amount');
select ok((select write_off_no like 'WO-%' and requested_by = '00000000-0000-0000-0000-0000000038c1'
                  and posted_by = '00000000-0000-0000-0000-0000000000a6'
           from finance.invoice_write_offs where invoice_id = '38d00000-0000-0000-0000-000000000001'),
  'numbered WO-…, with requester and approver recorded');
select is((select amount::numeric from finance.customer_ledger where entry_type = 'write_off' and customer_id = '38c00000-0000-0000-0000-000000000001'),
  -1140.00::numeric, 'a write_off ledger entry of −1140 is posted');
select is((select source_table from finance.customer_ledger where entry_type = 'write_off' and customer_id = '38c00000-0000-0000-0000-000000000001'),
  'finance.invoice_write_offs', 'the entry points at the write-off document');
select is((select o_open from finance.invoice_balance('38d00000-0000-0000-0000-000000000001')), 0.00::numeric, 'nothing is open on I1');
select is(pg_temp.task_status('38d00000-0000-0000-0000-000000000001'), 'closed', 'I1''s collection task is closed');
select ok((select outcome like 'Written off: WO-%' from finance.collection_tasks where invoice_id = '38d00000-0000-0000-0000-000000000001'),
  'with a written-off outcome');
select is((select w.status from work.tasks w join finance.collection_tasks t on t.work_task_id = w.id
           where t.invoice_id = '38d00000-0000-0000-0000-000000000001'), 'done', 'the rep''s work task is done');
select is((select count(*)::int from integration.outbox where event_type = 'invoice.written_off'
           and aggregate_id = '38d00000-0000-0000-0000-000000000001'), 1, 'one invoice.written_off outbox event');
select throws_like($$update finance.invoice_write_offs set amount = 1$$, '%', 'a posted write-off cannot be edited');

-- ===========================================================================
-- After: the scan skips the written-off invoice
-- ===========================================================================
select lives_ok($$select service.finance_overdue_scan()$$, 'the scan runs again');
select is(pg_temp.task_status('38d00000-0000-0000-0000-000000000001'), 'closed', 'the written-off invoice''s task stays closed');
select is((select count(*)::int from finance.collection_tasks where invoice_id = '38d00000-0000-0000-0000-000000000001'), 1,
  'no new collection task for it');
select lives_ok($$select service.finance_overdue_scan()$$, 'and again (idempotent)');
select is(pg_temp.task_status('38d00000-0000-0000-0000-000000000001'), 'closed', 'still closed');

select tests.authenticate_as('00000000-0000-0000-0000-0000000038c1');
select is(pg_temp.try($$select api.request_invoice_write_off('38d00000-0000-0000-0000-000000000001', 1, 'again (synthetic)', 'wo-38-1c')$$),
  'ERROR P0001 INVALID_STATE', 'a written-off invoice cannot be written off again');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select is(pg_temp.try($$select api.issue_credit_note('38d00000-0000-0000-0000-000000000001', null, 10, 'synthetic', 'cn-38-1')$$),
  'ERROR P0001 INVALID_STATE', 'nor credited');

-- ===========================================================================
-- Partial write-off of I2 (open 1280): self-approval, approver limit, still collected
-- ===========================================================================
select is(pg_temp.try($$select api.request_invoice_write_off('38d00000-0000-0000-0000-000000000002', 280, 'settlement discount (synthetic)', 'wo-38-2') ->> 'status'$$),
  'pending_approval', 'finance requests a partial write-off');
select is(pg_temp.try(format($$select api.decide_approval(%L, 'approve')$$, pg_temp.req('wo-38-2'))),
  'ERROR 42501 SELF_APPROVAL', 'a finance officer cannot approve their own request');
select tests.clear_authentication();
update authz.role_permissions set limit_value = 100
where permission_code = 'wf.decide.write_off' and role_id = (select id from authz.roles where code = 'finance_officer');
select tests.authenticate_as('00000000-0000-0000-0000-0000000038f2');
select is(pg_temp.try(format($$select api.decide_approval(%L, 'approve')$$, pg_temp.req('wo-38-2'))),
  'ERROR 42501 LIMIT_EXCEEDED', 'an approver limit of EGP 100 cannot approve 280');
select tests.clear_authentication();
update authz.role_permissions set limit_value = null
where permission_code = 'wf.decide.write_off' and role_id = (select id from authz.roles where code = 'finance_officer');
select tests.authenticate_as('00000000-0000-0000-0000-0000000038f2');
select is(pg_temp.try(format($$select api.decide_approval(%L, 'approve') ->> 'status'$$, pg_temp.req('wo-38-2'))),
  'approved', 'another finance officer without a limit approves');
select is((select status from api.v_invoices where id = '38d00000-0000-0000-0000-000000000002'), 'partially_paid', 'I2 stays partially paid');
select is((select open_amount from api.v_invoices where id = '38d00000-0000-0000-0000-000000000002'), 1000.00::numeric(14,2),
  'v_invoices: open 2280 − 1000 − 280 = 1000');
select is((select written_off from api.v_invoices where id = '38d00000-0000-0000-0000-000000000002'), 280.00::numeric(14,2),
  'v_invoices shows the written-off amount');
select is((select invoice_open_amount from api.v_collection_tasks where invoice_id = '38d00000-0000-0000-0000-000000000002'), 1000.00::numeric(14,2),
  'v_collection_tasks shows the remaining open amount');
select tests.clear_authentication();
select is((select open_amount from perf.overdue_invoices(core.business_date()) where invoice_id = '38d00000-0000-0000-0000-000000000002'),
  1000.00::numeric(14,2), 'AR overdue counts only what is still owed');
select lives_ok($$select service.finance_overdue_scan()$$, 'scan after the partial write-off');
select is(pg_temp.task_status('38d00000-0000-0000-0000-000000000002'), 'open', 'the rest of I2 is still collected');

-- ===========================================================================
-- Request limits on I3 (open 1140) and re-validation at decision time
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000038c1');
select is(pg_temp.try($$select api.request_invoice_write_off('38d00000-0000-0000-0000-000000000003', 1140.01, 'too much (synthetic)', 'wo-38-3x')$$),
  'ERROR P0001 EXCEEDS_INVOICE_OPEN_AMOUNT', 'the amount cannot exceed the open amount');
select is(pg_temp.try($$select api.request_invoice_write_off('38d00000-0000-0000-0000-000000000003', 0, 'zero (synthetic)', 'wo-38-3z')$$),
  'ERROR P0001 VALIDATION', 'zero is refused');
select is(pg_temp.try($$select api.request_invoice_write_off('38d00000-0000-0000-0000-000000000003', 1.234, 'cents (synthetic)', 'wo-38-3c')$$),
  'ERROR P0001 VALIDATION', 'more than two decimals is refused');
select is(pg_temp.try($$select api.request_invoice_write_off('38d00000-0000-0000-0000-000000000003', 10, ' x ', 'wo-38-3r')$$),
  'ERROR P0001 REASON_REQUIRED', 'a reason is required');
select is(pg_temp.try($$select api.request_invoice_write_off('38d00000-0000-0000-0000-000000000003', 10, 'no key (synthetic)', ' ')$$),
  'ERROR P0001 VALIDATION', 'an idempotency key is required');
select is(pg_temp.try($$select api.request_invoice_write_off('38d00000-0000-0000-0000-0000000000ff', 10, 'unknown (synthetic)', 'wo-38-3u')$$),
  'ERROR P0002 NOT_FOUND', 'an unknown invoice is not found');
select is(pg_temp.try($$select api.request_invoice_write_off('38d00000-0000-0000-0000-000000000003', 500, 'partial (synthetic)', 'wo-38-3') ->> 'status'$$),
  'pending_approval', 'a write-off of 500 on I3 is requested');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select is(pg_temp.try($$select api.allocate_payment('38e00000-0000-0000-0000-000000000003',
            '[{"invoice_id":"38d00000-0000-0000-0000-000000000003","amount":1000}]', 'alloc-38-3') ->> 'allocated'$$),
  '1000', 'meanwhile a payment of 1000 is allocated to I3 (open 140)');
select is(pg_temp.try(format($$select api.decide_approval(%L, 'approve')$$, pg_temp.req('wo-38-3'))),
  'ERROR P0001 EXCEEDS_INVOICE_OPEN_AMOUNT', 'the hook re-checks the amount against the invoice as it is now');
select is((select status from wf.approval_requests where id = pg_temp.req('wo-38-3')), 'pending', 'the failed approval rolled back');
select is(pg_temp.try(format($$select api.decide_approval(%L, 'reject', 'paid meanwhile') ->> 'status'$$, pg_temp.req('wo-38-3'))),
  'rejected', 'the approver rejects it');
select is((select count(*)::int from finance.invoice_write_offs where invoice_id = '38d00000-0000-0000-0000-000000000003'), 0,
  'a rejected request posts nothing');

-- ===========================================================================
-- Scoped collector writes off the rest of I4, then the payment bounces
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000038d1');
select is(pg_temp.try($$select api.request_invoice_write_off('38d00000-0000-0000-0000-000000000004', 640, 'remainder (synthetic)', 'wo-38-4') ->> 'status'$$),
  'pending_approval', 'a Cairo-scoped collector requests on a Cairo invoice');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select is(pg_temp.try(format($$select api.decide_approval(%L, 'approve') ->> 'status'$$, pg_temp.req('wo-38-4'))), 'approved', 'approved');
select is((select status from finance.invoices where id = '38d00000-0000-0000-0000-000000000004'), 'written_off', 'I4 is written off');
select is(pg_temp.try($$select api.reverse_payment('38e00000-0000-0000-0000-000000000004', 'transfer recalled (synthetic)', true) ->> 'status'$$),
  'bounced', 'the payment that paid part of I4 bounces');
select is((select status || ' ' || open_amount from api.v_invoices where id = '38d00000-0000-0000-0000-000000000004'), 'issued 500.00',
  'I4 is owed again (500) instead of hiding the debt');

-- ===========================================================================
-- Balance = ledger = documents
-- ===========================================================================
select is((select count(*)::int from crm.customers c
           where c.customer_no like 'C-T38-%'
             and (select coalesce(sum(l.amount), 0) from finance.customer_ledger l where l.customer_id = c.id)
                 is distinct from
                 (select coalesce(sum(v.open_amount), 0) from api.v_invoices v where v.customer_id = c.id)
                 - (select coalesce(sum(p.unallocated), 0) from api.v_payments p where p.customer_id = c.id)), 0,
  'every customer''s ledger balance equals open invoices minus unallocated payments');
select is((select count(*)::int from api.v_customers v where v.customer_no like 'C-T38-%'
           and v.balance is distinct from (select sum(l.amount) from finance.customer_ledger l where l.customer_id = v.id)), 0,
  'the customer balance shown equals the ledger');
select is((select balance from api.v_customers where id = '38c00000-0000-0000-0000-000000000001'), 0.00::numeric(14,2),
  'X1 owes nothing after the full write-off');
select is((select ledger_balance - total_open from api.v_ar_aging where customer_id = '38c00000-0000-0000-0000-000000000002'), 0.00::numeric,
  'aging: X2 ledger balance equals its open invoices');
select is((select document_no from api.v_customer_statement where entry_type = 'write_off'
           and customer_id = '38c00000-0000-0000-0000-000000000001'),
          (select write_off_no from finance.invoice_write_offs where invoice_id = '38d00000-0000-0000-0000-000000000001'),
  'the statement shows the write-off number');

-- ===========================================================================
-- Read scope and print helpers
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is((select count(*)::int from api.v_invoice_write_offs where customer_no like 'C-T38-%'), 3, 'the rep sees his customers'' write-offs');
select is((select customer_no from api.v_invoice_print_party where invoice_id = '38d00000-0000-0000-0000-000000000001'), 'C-T38-1',
  'the rep reads the customer block of his invoice');
select is(pg_temp.try($$select api.company_profile() ->> 'legal_name_en'$$), 'Honest Trading (placeholder name)',
  'the company header is readable by invoice readers');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a5');
select is((select count(*)::int from api.v_invoice_write_offs where customer_no like 'C-T38-%'), 0, 'another rep sees none');
select is((select count(*)::int from api.v_invoice_print_party where invoice_id = '38d00000-0000-0000-0000-000000000001'), 0,
  'nor the customer block');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a7');
select is(pg_temp.try($$select api.company_profile()$$), 'ERROR 42501 PERMISSION_DENIED', 'the admin (no finance read) cannot read it');
select tests.clear_authentication();
select ok(not has_function_privilege('anon', 'api.company_profile()', 'execute'), 'anon cannot read the company profile');

select * from finish();
rollback;
