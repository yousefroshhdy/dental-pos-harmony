-- Finance immutability and the audit trail.
begin;
select tests.load_fixture();
select plan(9);

insert into finance.invoices (id, invoice_no, customer_id, issue_date, due_date, subtotal, discount_total, tax_total, total)
values ('90000000-0000-0000-0000-000000000001','INV-2026-000001','40000000-0000-0000-0000-000000000001', current_date, current_date + 30, 2000, 40, 274.40, 2234.40);
select throws_like($$update finance.invoices set total = 100, subtotal = 100, tax_total = 0, discount_total = 0 where id = '90000000-0000-0000-0000-000000000001'$$,
  'INVOICE_IMMUTABLE%', 'issued invoice amounts cannot be edited');
select throws_like($$delete from finance.invoices$$, 'APPEND_ONLY%', 'invoices cannot be deleted');
select lives_ok($$update finance.invoices set status = 'partially_paid' where id = '90000000-0000-0000-0000-000000000001'$$, 'invoice status may still change');
select is((select count(*)::int from audit.audit_log where table_name = 'customers' and action = 'INSERT'), 2, 'customer inserts are audited');
select throws_like($$delete from audit.audit_log$$, 'APPEND_ONLY%', 'audit log cannot be deleted');

-- Rep's actions are attributed to the rep
insert into sales.orders (id, customer_id, employee_id) values
  ('70000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000004');
insert into sales.order_items (order_id, line_no, variant_id, quantity, list_price, tax_rate_pct, line_subtotal, line_discount, line_tax, line_total)
values ('70000000-0000-0000-0000-000000000001', 1, '53000000-0000-0000-0000-000000000001', 1, 0, 0, 0,0,0,0);
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select api.submit_order('70000000-0000-0000-0000-000000000001');
select is((select count(*)::int from audit.audit_log), 0, 'rep cannot read the audit log');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a7');
select ok((select count(*) from audit.audit_log where table_name = 'orders' and action = 'UPDATE'
           and actor_user_id = '00000000-0000-0000-0000-0000000000a4') >= 1, 'admin sees the order update attributed to the rep');
select ok((select count(*) from api.v_audit_log) > 0, 'admin can read the audit view');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select is((select count(*)::int from api.v_security_events), 0, 'finance cannot read security events');

select * from finish();
rollback;
