-- Receivables commands (20261031000100_finance_ar_commands.sql): invoices from fulfilment,
-- VAT rounding, gapless numbering, immutability, payments (record → confirm/reject → reverse),
-- allocation (manual, FIFO, limits, over-allocation), credit notes through the workflow,
-- idempotent replays.
--   users: a1 owner · a3 area mgr Cairo · a4 rep Cairo (customer 4…01) · a5 rep Delta (4…02)
--          · a6 finance officer · a8 inventory manager
begin;
select tests.load_fixture();
select plan(112);
set constraints all immediate;

-- ---------------------------------------------------------------------------
-- Setup: stock, 30-day terms for C-0001, and three orders ready to invoice
--   A  API flow, C-0001: 3 × 1000, 2% discount → 3000 − 60 + 14% × 2940 = 3351.60, fulfilled
--   B  C-0001, partially fulfilled: line 1 = 2 × 0.75 (1 fulfilled), line 2 = 3 × 1000 − 2.5% (3 fulfilled)
--   C  C-0002 (Delta): 1 × 1000 + 14% = 1140, fulfilled
-- ---------------------------------------------------------------------------
insert into inventory.movements (movement_type, warehouse_id, variant_id, lot_id, quantity, source_doc_type) values
  ('receipt','60000000-0000-0000-0000-000000000001','53000000-0000-0000-0000-000000000001','61000000-0000-0000-0000-000000000001', 10, 'receipt');
update crm.customers set payment_terms_days = 30 where id = '40000000-0000-0000-0000-000000000001';

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select api.save_order_draft('f7000000-0000-0000-0000-00000000000a', '40000000-0000-0000-0000-000000000001',
  '[{"variant_id":"53000000-0000-0000-0000-000000000001","quantity":3,"requested_discount_pct":2}]');
select api.submit_order('f7000000-0000-0000-0000-00000000000a');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a3');
select api.approve_order('f7000000-0000-0000-0000-00000000000a');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a8');
select api.reserve_order('f7000000-0000-0000-0000-00000000000a', '60000000-0000-0000-0000-000000000001');
select api.post_fulfillment('f7000000-0000-0000-0000-00000000000a', 'ful-fin-A');
select tests.clear_authentication();

insert into sales.orders (id, order_no, customer_id, employee_id, status, payment_terms_days, subtotal, discount_total, tax_total, total) values
  ('f7000000-0000-0000-0000-00000000000b','SO-TEST-B','40000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000004',
   'partially_fulfilled', 0, 3001.50, 75.00, 409.71, 3336.21),
  ('f7000000-0000-0000-0000-00000000000c','SO-TEST-C','40000000-0000-0000-0000-000000000002','20000000-0000-0000-0000-000000000005',
   'fulfilled', 15, 1000, 0, 140, 1140);
insert into sales.order_items (id, order_id, line_no, variant_id, quantity, list_price, applied_discount_pct, tax_rate_pct,
                               line_subtotal, line_discount, line_tax, line_total, fulfilled_qty) values
  ('f7100000-0000-0000-0000-0000000000b1','f7000000-0000-0000-0000-00000000000b',1,'53000000-0000-0000-0000-000000000001', 2, 0.75, 0, 14, 1.50, 0, 0.21, 1.71, 1),
  ('f7100000-0000-0000-0000-0000000000b2','f7000000-0000-0000-0000-00000000000b',2,'53000000-0000-0000-0000-000000000001', 3, 1000, 2.5, 14, 3000, 75, 409.50, 3334.50, 3),
  ('f7100000-0000-0000-0000-0000000000c1','f7000000-0000-0000-0000-00000000000c',1,'53000000-0000-0000-0000-000000000001', 1, 1000, 0, 14, 1000, 0, 140, 1140, 1);

-- ===========================================================================
-- Invoices
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select throws_ok($$select api.issue_invoice('f7000000-0000-0000-0000-00000000000a', 'inv-A')$$, '42501', null,
  'a rep cannot issue invoices');
select is((select count(*)::int from api.v_invoiceable_orders), 0, 'the invoicing queue is empty for reps');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select is((select count(*)::int from api.v_invoiceable_orders), 3, 'finance sees three orders ready to invoice');
select throws_like($$select api.issue_invoice('f7000000-0000-0000-0000-00000000000a', '')$$, 'VALIDATION%',
  'an idempotency key is required');
select is((api.issue_invoice('f7000000-0000-0000-0000-00000000000a', 'inv-A') ->> 'total')::numeric, 3351.60::numeric,
  'invoice A total is computed on the server from the order lines');
select is((api.issue_invoice('f7000000-0000-0000-0000-00000000000a', 'inv-A') ->> 'replayed')::boolean, true,
  'a replay with the same key returns the first invoice');
select throws_like($$select api.issue_invoice('f7000000-0000-0000-0000-00000000000b', 'inv-A')$$, 'IDEMPOTENCY_CONFLICT%',
  'the same key for another order is refused');
select throws_like($$select api.issue_invoice('f7000000-0000-0000-0000-00000000000a', 'inv-A2')$$, 'INVALID_STATE%',
  'a fully invoiced order cannot be invoiced again');
select tests.clear_authentication();
select is((select count(*)::int from finance.invoices where order_id = 'f7000000-0000-0000-0000-00000000000a'), 1,
  'exactly one invoice for order A');
select is((select status from sales.orders where id = 'f7000000-0000-0000-0000-00000000000a'), 'invoiced',
  'a fully fulfilled and invoiced order moves to invoiced');
select is((select to_status || ':' || reason from sales.order_status_history
           where order_id = 'f7000000-0000-0000-0000-00000000000a' order by id desc limit 1),
  'invoiced:' || (select invoice_no from finance.invoices where order_id = 'f7000000-0000-0000-0000-00000000000a'),
  'the order history names the invoice');
select is((select (subtotal, discount_total, tax_total)::text from finance.invoices where order_id = 'f7000000-0000-0000-0000-00000000000a'),
  '(3000.00,60.00,411.60)', 'invoice A subtotal, discount and VAT');
select is((select due_date - issue_date from finance.invoices where order_id = 'f7000000-0000-0000-0000-00000000000a'), 30,
  'due date = issue date + the customer''s payment terms (snapshotted on the order)');
select is((select issue_date from finance.invoices where order_id = 'f7000000-0000-0000-0000-00000000000a'), core.business_date(),
  'issue date is the Cairo business day');
select is((select amount::numeric from finance.customer_ledger where entry_type = 'invoice'
           and source_id = (select id from finance.invoices where order_id = 'f7000000-0000-0000-0000-00000000000a')),
  3351.60::numeric(14,2), 'the invoice posts its total to the AR ledger once');
select is((select count(*)::int from integration.outbox where event_type = 'invoice.issued'
           and aggregate_id = (select id from finance.invoices where order_id = 'f7000000-0000-0000-0000-00000000000a')), 1,
  'invoice.issued is emitted once');
select is((select count(*)::int from crm.activities where type = 'invoice' and customer_id = '40000000-0000-0000-0000-000000000001'), 1,
  'the customer timeline records the invoice');

-- Partial fulfilment: invoice what was delivered, the rest later; VAT rounds half away from zero.
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select is((api.issue_invoice('f7000000-0000-0000-0000-00000000000b', 'inv-B1') ->> 'total')::numeric, 3335.36::numeric,
  'B1 invoices the fulfilled quantity: 0.75 + 0.11 VAT, plus 3334.50');
select tests.clear_authentication();
select is((select tax_amount::numeric from finance.invoice_items where order_item_id = 'f7100000-0000-0000-0000-0000000000b1'), 0.11::numeric(14,2),
  'VAT 14% of 0.75 = 0.105 rounds half away from zero to 0.11 (not banker''s 0.10)');
select is((select status from sales.orders where id = 'f7000000-0000-0000-0000-00000000000b'), 'partially_fulfilled',
  'a partially fulfilled order stays open for the rest');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select throws_like($$select api.issue_invoice('f7000000-0000-0000-0000-00000000000b', 'inv-B-again')$$, 'NOTHING_TO_INVOICE%',
  'nothing more to invoice until more is fulfilled');
select tests.clear_authentication();
update sales.order_items set fulfilled_qty = 2 where id = 'f7100000-0000-0000-0000-0000000000b1';
update sales.orders set status = 'fulfilled' where id = 'f7000000-0000-0000-0000-00000000000b';
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select is((api.issue_invoice('f7000000-0000-0000-0000-00000000000b', 'inv-B2') ->> 'total')::numeric, 0.85::numeric,
  'B2 takes the exact remainder of the line: 0.75 + (0.21 − 0.11) VAT');
select tests.clear_authentication();
select is((select sum(total) from finance.invoices where order_id = 'f7000000-0000-0000-0000-00000000000b'), 3336.21::numeric,
  'Σ invoices of an order = the order total, to the cent');
select is((select sum(tax_amount) from finance.invoice_items where order_item_id = 'f7100000-0000-0000-0000-0000000000b1'),
  0.21::numeric, 'Σ VAT of a line across partial invoices = the order line''s VAT');
select is((select status from sales.orders where id = 'f7000000-0000-0000-0000-00000000000b'), 'invoiced',
  'order B is invoiced once everything is');

-- Totals = Σ lines for every invoice
select is((select count(*)::int from finance.invoices i
           cross join lateral (select sum(line_subtotal) s, sum(discount) d, sum(tax_amount) t, sum(line_total) l
                               from finance.invoice_items ii where ii.invoice_id = i.id) x
           where (i.subtotal, i.discount_total, i.tax_total, i.total) is distinct from (x.s, x.d, x.t, x.l)), 0,
  'every invoice''s subtotal, discount, VAT and total equal the sum of its lines');
select is((select count(*)::int from finance.invoice_items where line_total <> line_subtotal - discount + tax_amount), 0,
  'every line total = subtotal − discount + VAT');

-- Gapless numbering, also across a rolled-back attempt
savepoint gap;
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select api.issue_invoice('f7000000-0000-0000-0000-00000000000c', 'inv-C-rolled-back');
rollback to savepoint gap;
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select is((api.issue_invoice('f7000000-0000-0000-0000-00000000000c', 'inv-C') ->> 'invoice_no'),
  'INV-' || extract(year from core.business_date()) || '-000004',
  'a rolled-back issue leaves no gap: the next invoice takes the same number');
select tests.clear_authentication();
select is((select string_agg(right(invoice_no, 6), ',' order by invoice_no) from finance.invoices), '000001,000002,000003,000004',
  'invoice numbers are consecutive');
select is((select due_date - issue_date from finance.invoices where order_id = 'f7000000-0000-0000-0000-00000000000c'), 15,
  'due date follows the order''s terms');

-- Immutability
select throws_like($$update finance.invoices set total = 1, subtotal = 1, tax_total = 0, discount_total = 0
                     where order_id = 'f7000000-0000-0000-0000-00000000000c'$$, 'INVOICE_IMMUTABLE%', 'invoice amounts are immutable');
select throws_like($$update finance.invoices set due_date = due_date + 60 where order_id = 'f7000000-0000-0000-0000-00000000000c'$$,
  'INVOICE_IMMUTABLE%', 'the due date is immutable too');
select throws_like($$update finance.invoice_items set unit_price = 1 where order_item_id = 'f7100000-0000-0000-0000-0000000000c1'$$,
  'APPEND_ONLY%', 'invoice lines are append-only');
select throws_like($$delete from finance.customer_ledger$$, 'APPEND_ONLY%', 'the AR ledger is append-only');
select lives_ok($$update finance.invoices set eta_status = 'pending' where order_id = 'f7000000-0000-0000-0000-00000000000c'$$,
  'ETA fields stay writable for a future e-invoicing integration');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select throws_like($$update finance.invoices set status = 'paid'$$, '%permission denied%', 'clients cannot write invoices directly');
select tests.clear_authentication();

-- ===========================================================================
-- Payments
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is(api.record_payment('40000000-0000-0000-0000-000000000001', 2000, 'cash', null, now() - interval '1 hour',
                             'f7200000-0000-0000-0000-000000000001') ->> 'status', 'pending_verification',
  'a rep''s cash collection waits for finance to verify it');
select is((api.record_payment('40000000-0000-0000-0000-000000000001', 2000, 'cash', null, now() - interval '1 hour',
                              'f7200000-0000-0000-0000-000000000001') ->> 'replayed')::boolean, true,
  'a replay from the offline queue returns the same payment');
select throws_like($$select api.record_payment('40000000-0000-0000-0000-000000000001', 2500, 'cash', null, null,
                     'f7200000-0000-0000-0000-000000000001')$$, 'IDEMPOTENCY_CONFLICT%',
  'a reused client reference with different data is refused');
select throws_ok($$select api.record_payment('40000000-0000-0000-0000-000000000002', 100, 'cash', null, null,
                   'f7200000-0000-0000-0000-0000000000ff')$$, '42501', null,
  'a rep cannot record a payment for another rep''s customer');
select throws_like($$select api.record_payment('40000000-0000-0000-0000-000000000001', 100, 'cheque', 'CHQ-1', null,
                     'f7200000-0000-0000-0000-0000000000fe')$$, 'VALIDATION%', 'a cheque needs a due date');
select throws_like($$select api.record_payment('40000000-0000-0000-0000-000000000001', 10.005, 'cash', null, null,
                     'f7200000-0000-0000-0000-0000000000fd')$$, 'VALIDATION%', 'amounts have at most 2 decimals');
select throws_like($$select api.record_payment('40000000-0000-0000-0000-000000000001', 10, 'paymob_card', null, null,
                     'f7200000-0000-0000-0000-0000000000fc')$$, 'VALIDATION%', 'Paymob payments only come from the integration');
select throws_like($$select api.record_payment('40000000-0000-0000-0000-000000000001', 10, 'cash', null, now() + interval '1 day',
                     'f7200000-0000-0000-0000-0000000000fb')$$, 'VALIDATION%', 'a payment cannot be received in the future');
select is((select count(*)::int from api.v_payments where id = (select id from finance.payments where client_ref = 'f7200000-0000-0000-0000-000000000001')), 1,
  'the rep sees the payment they recorded');
select throws_ok($$select api.confirm_payment((select id from finance.payments where client_ref = 'f7200000-0000-0000-0000-000000000001'))$$,
  '42501', null, 'a rep cannot confirm payments');
select tests.clear_authentication();
select is((select count(*)::int from finance.customer_ledger where entry_type = 'payment'), 0,
  'a pending payment is not in the ledger');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select throws_like($$select api.allocate_payment((select id from finance.payments where client_ref = 'f7200000-0000-0000-0000-000000000001'))$$,
  'INVALID_STATE%', 'a pending payment cannot be allocated');
select is(api.confirm_payment((select id from finance.payments where client_ref = 'f7200000-0000-0000-0000-000000000001')) ->> 'status',
  'confirmed', 'finance confirms the payment');
select is((api.confirm_payment((select id from finance.payments where client_ref = 'f7200000-0000-0000-0000-000000000001')) ->> 'replayed')::boolean,
  true, 'confirming twice is a replay');
select tests.clear_authentication();
select is((select amount::numeric from finance.customer_ledger where entry_type = 'payment'
           and source_id = (select id from finance.payments where client_ref = 'f7200000-0000-0000-0000-000000000001')),
  -2000.00::numeric(14,2), 'a confirmed payment posts once, as a credit');
select is((select count(*)::int from notify.notifications where type = 'payment.confirmed'
           and recipient_user_id = '00000000-0000-0000-0000-0000000000a4'), 1, 'the collecting rep is told');

-- Allocation: manual
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select throws_ok($$select api.allocate_payment((select id from finance.payments where client_ref = 'f7200000-0000-0000-0000-000000000001'))$$,
  '42501', null, 'a rep cannot allocate');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select throws_like(format($$select api.allocate_payment(%L, %L)$$,
    (select id from finance.payments where client_ref = 'f7200000-0000-0000-0000-000000000001'),
    jsonb_build_array(jsonb_build_object('invoice_id', (select id from finance.invoices where order_id = 'f7000000-0000-0000-0000-00000000000a'), 'amount', 2500))),
  'OVER_ALLOCATION%', 'Σ allocations cannot exceed the payment');
select throws_like(format($$select api.allocate_payment(%L, %L)$$,
    (select id from finance.payments where client_ref = 'f7200000-0000-0000-0000-000000000001'),
    jsonb_build_array(jsonb_build_object('invoice_id', (select id from finance.invoices where order_id = 'f7000000-0000-0000-0000-00000000000c'), 'amount', 100))),
  'VALIDATION%', 'a payment cannot be allocated to another customer''s invoice');
select throws_like(format($$select api.allocate_payment(%L, %L)$$,
    (select id from finance.payments where client_ref = 'f7200000-0000-0000-0000-000000000001'),
    jsonb_build_array(jsonb_build_object('invoice_id', (select id from finance.invoices where order_id = 'f7000000-0000-0000-0000-00000000000a'), 'amount', 100, 'total', 1))),
  'VALIDATION%', 'allocation lines accept only invoice_id and amount');
select is((api.allocate_payment((select id from finance.payments where client_ref = 'f7200000-0000-0000-0000-000000000001'),
    jsonb_build_array(jsonb_build_object('invoice_id', (select id from finance.invoices where order_id = 'f7000000-0000-0000-0000-00000000000a'), 'amount', 1500)),
    'alloc-1') ->> 'payment_unallocated')::numeric, 500.00::numeric, 'a partial allocation leaves 500 unallocated');
select is((api.allocate_payment((select id from finance.payments where client_ref = 'f7200000-0000-0000-0000-000000000001'),
    jsonb_build_array(jsonb_build_object('invoice_id', (select id from finance.invoices where order_id = 'f7000000-0000-0000-0000-00000000000a'), 'amount', 1500)),
    'alloc-1') ->> 'replayed')::boolean, true, 'an allocation replayed with its key is not applied twice');
select is((select status || ':' || open_amount from api.v_invoices where order_id = 'f7000000-0000-0000-0000-00000000000a'),
  'partially_paid:1851.60', 'invoice A is partially paid with 1851.60 open');

-- Allocation limit (finance.payment.allocate limit = EGP per command)
select tests.clear_authentication();
update authz.role_permissions set limit_value = 100
where permission_code = 'finance.payment.allocate' and role_id = (select id from authz.roles where code = 'finance_officer');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select throws_ok(format($$select api.allocate_payment(%L, %L)$$,
    (select id from finance.payments where client_ref = 'f7200000-0000-0000-0000-000000000001'),
    jsonb_build_array(jsonb_build_object('invoice_id', (select id from finance.invoices where order_id = 'f7000000-0000-0000-0000-00000000000a'), 'amount', 150))),
  '42501', null, 'an allocation above the user''s EGP limit is refused');
select tests.clear_authentication();
update authz.role_permissions set limit_value = null
where permission_code = 'finance.payment.allocate' and role_id = (select id from authz.roles where code = 'finance_officer');

-- FIFO: a bank transfer recorded by finance is confirmed at once and fills the oldest due first
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select is(api.record_payment('40000000-0000-0000-0000-000000000001', 4000, 'bank_transfer', 'TRF-SYN-1', null,
                             'f7200000-0000-0000-0000-000000000002') ->> 'status', 'confirmed',
  'finance confirms a non-cheque payment as it records it');
select is((api.allocate_payment((select id from finance.payments where client_ref = 'f7200000-0000-0000-0000-000000000002')) ->> 'allocated')::numeric,
  4000.00::numeric, 'FIFO allocates the whole payment');
select is((select string_agg(right(invoice_no, 6) || '=' || status || ':' || open_amount, ',' order by invoice_no)
           from api.v_invoices where customer_id = '40000000-0000-0000-0000-000000000001'),
  '000001=partially_paid:1187.81,000002=paid:0.00,000003=paid:0.00',
  'FIFO pays the invoices due first (B1, B2 due today) before A (due in 30 days)');
select throws_like($$select api.allocate_payment((select id from finance.payments where client_ref = 'f7200000-0000-0000-0000-000000000002'))$$,
  'NOTHING_TO_ALLOCATE%', 'a fully allocated payment has nothing left');

-- Over-allocation of an invoice
select is(api.record_payment('40000000-0000-0000-0000-000000000001', 5000, 'instapay', 'IPN-SYN-1', null,
                             'f7200000-0000-0000-0000-000000000003') ->> 'status', 'confirmed', 'a 5000 InstaPay payment');
select throws_like(format($$select api.allocate_payment(%L, %L)$$,
    (select id from finance.payments where client_ref = 'f7200000-0000-0000-0000-000000000003'),
    jsonb_build_array(jsonb_build_object('invoice_id', (select id from finance.invoices where order_id = 'f7000000-0000-0000-0000-00000000000a'), 'amount', 1500))),
  'OVER_ALLOCATION%', 'an invoice cannot be allocated beyond its open amount');
select throws_like(format($$select api.allocate_payment(%L, %L)$$,
    (select id from finance.payments where client_ref = 'f7200000-0000-0000-0000-000000000003'),
    jsonb_build_array(jsonb_build_object('invoice_id', (select id from finance.invoices where order_id = 'f7000000-0000-0000-0000-00000000000b' order by invoice_no limit 1), 'amount', 1))),
  'INVOICE_CLOSED%', 'a paid invoice takes no more allocations');
select tests.clear_authentication();
select is((select count(*)::int from api.v_invoices where open_amount < 0), 0, 'no invoice is ever over-allocated');
select is((select count(*)::int from finance.payments p
           where (select coalesce(sum(amount), 0) from finance.payment_allocations pa where pa.payment_id = p.id) > p.amount), 0,
  'no payment is ever over-allocated');

-- Reject a pending payment: nothing posts
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select api.record_payment('40000000-0000-0000-0000-000000000001', 50, 'cash', null, null, 'f7200000-0000-0000-0000-000000000004');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select throws_like($$select api.reject_payment((select id from finance.payments where client_ref = 'f7200000-0000-0000-0000-000000000004'), '')$$,
  'REASON_REQUIRED%', 'rejecting needs a reason');
select is(api.reject_payment((select id from finance.payments where client_ref = 'f7200000-0000-0000-0000-000000000004'), 'not received in the cash box') ->> 'status',
  'reversed', 'a rejected pending cash payment is closed');
select tests.clear_authentication();
select is((select count(*)::int from finance.customer_ledger
           where source_id = (select id from finance.payments where client_ref = 'f7200000-0000-0000-0000-000000000004')), 0,
  'a rejected payment never touched the ledger');

-- Bounced cheque: confirm (cleared), allocate, then reverse → balance and invoice restored
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is(api.record_payment('40000000-0000-0000-0000-000000000001', 1000, 'cheque', 'CHQ-SYN-77', null,
                             'f7200000-0000-0000-0000-000000000005', core.business_date() + 7) ->> 'status',
  'pending_verification', 'a cheque waits until it clears');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select is(api.record_payment('40000000-0000-0000-0000-000000000001', 300, 'cheque', 'CHQ-SYN-78', null,
                             'f7200000-0000-0000-0000-000000000006', core.business_date() + 7) ->> 'status',
  'pending_verification', 'even finance''s cheques wait until they clear');
select api.confirm_payment((select id from finance.payments where client_ref = 'f7200000-0000-0000-0000-000000000005'));
select api.allocate_payment((select id from finance.payments where client_ref = 'f7200000-0000-0000-0000-000000000005'),
    jsonb_build_array(jsonb_build_object('invoice_id', (select id from finance.invoices where order_id = 'f7000000-0000-0000-0000-00000000000a'), 'amount', 1000)));
select tests.clear_authentication();
create temp table bal_before as select sum(amount) + 1000 as b from finance.customer_ledger where customer_id = '40000000-0000-0000-0000-000000000001';
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select throws_ok($$select api.reverse_payment((select id from finance.payments where client_ref = 'f7200000-0000-0000-0000-000000000005'), 'bounced', true)$$,
  '42501', null, 'a rep cannot reverse payments');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select is(api.reverse_payment((select id from finance.payments where client_ref = 'f7200000-0000-0000-0000-000000000005'), 'returned unpaid by the bank', true) ->> 'status',
  'bounced', 'the cleared cheque bounces');
select is((api.reverse_payment((select id from finance.payments where client_ref = 'f7200000-0000-0000-0000-000000000005'), 'again', true) ->> 'replayed')::boolean,
  true, 'reversing twice is a replay');
select tests.clear_authentication();
select is((select sum(amount) from finance.customer_ledger where customer_id = '40000000-0000-0000-0000-000000000001'),
  (select b from bal_before), 'the reversal restores the customer balance');
select is((select count(*)::int from finance.customer_ledger where entry_type = 'payment_reversal' and amount = 1000), 1,
  'the reversal is a new ledger row, not an edit');
select is((select open_amount from api.v_invoices where order_id = 'f7000000-0000-0000-0000-00000000000a'), 1187.81::numeric(14,2),
  'the bounced cheque''s allocation is reversed and the invoice reopens');
select is((select count(*)::int from finance.payment_allocations where amount < 0 and reverses_allocation_id is not null), 1,
  'the un-allocation is a negative row that references the original');
select throws_like($$update finance.payment_allocations set amount = 1$$, 'APPEND_ONLY%', 'allocations are append-only');

-- Reverse one allocation (the 1500 of the first payment)
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select is((api.reverse_allocation((select id from finance.payment_allocations where idempotency_key = 'alloc-1'), 'allocated to the wrong invoice')
           ->> 'payment_unallocated')::numeric, 2000.00::numeric, 'reversing an allocation frees the payment');
select is((api.reverse_allocation((select id from finance.payment_allocations where idempotency_key = 'alloc-1'), 'again') ->> 'replayed')::boolean,
  true, 'an allocation is reversed once');
select is((select open_amount from api.v_invoices where order_id = 'f7000000-0000-0000-0000-00000000000a'), 2687.81::numeric(14,2),
  'the invoice reopens by the reversed amount');

-- ===========================================================================
-- Credit notes (workflow 'finance.credit_note'; requester ≠ approver)
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select throws_ok(format($$select api.issue_credit_note(%L, null, 10, 'goodwill', 'cn-rep')$$,
    (select id from finance.invoices where order_id = 'f7000000-0000-0000-0000-00000000000a')), '42501', null,
  'a rep cannot issue credit notes');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select throws_like(format($$select api.issue_credit_note(%L, %L, 10, 'both', 'cn-x')$$,
    (select id from finance.invoices where order_id = 'f7000000-0000-0000-0000-00000000000c'),
    jsonb_build_array(jsonb_build_object('invoice_item_id', (select id from finance.invoice_items where order_item_id = 'f7100000-0000-0000-0000-0000000000c1'), 'quantity', 1))),
  'VALIDATION%', 'lines or an amount, not both');
select throws_like(format($$select api.issue_credit_note(%L, %L, null, 'client total', 'cn-y')$$,
    (select id from finance.invoices where order_id = 'f7000000-0000-0000-0000-00000000000c'),
    jsonb_build_array(jsonb_build_object('invoice_item_id', (select id from finance.invoice_items where order_item_id = 'f7100000-0000-0000-0000-0000000000c1'), 'quantity', 1, 'amount', 1))),
  'VALIDATION%', 'credit lines carry no client amounts');
select throws_like(format($$select api.issue_credit_note(%L, null, 10, '', 'cn-z')$$,
    (select id from finance.invoices where order_id = 'f7000000-0000-0000-0000-00000000000c')),
  'REASON_REQUIRED%', 'a credit note needs a reason');
select throws_like(format($$select api.issue_credit_note(%L, null, 5000, 'too much', 'cn-big')$$,
    (select id from finance.invoices where order_id = 'f7000000-0000-0000-0000-00000000000a')),
  'EXCEEDS_INVOICE_OPEN_AMOUNT%', 'a credit cannot exceed the invoice''s open amount');
select is(api.issue_credit_note((select id from finance.invoices where order_id = 'f7000000-0000-0000-0000-00000000000c'),
    jsonb_build_array(jsonb_build_object('invoice_item_id', (select id from finance.invoice_items where order_item_id = 'f7100000-0000-0000-0000-0000000000c1'), 'quantity', 1)),
    null, 'damaged on delivery', 'cn-C') ->> 'status', 'pending_approval', 'a credit note request waits for approval');
select is((api.issue_credit_note((select id from finance.invoices where order_id = 'f7000000-0000-0000-0000-00000000000c'),
    jsonb_build_array(jsonb_build_object('invoice_item_id', (select id from finance.invoice_items where order_item_id = 'f7100000-0000-0000-0000-0000000000c1'), 'quantity', 1)),
    null, 'damaged on delivery', 'cn-C') ->> 'replayed')::boolean, true, 'requesting again with the same key is a replay');
select tests.clear_authentication();
select is((select (payload ->> 'amount') || '+' || (payload ->> 'tax_amount') from wf.approval_requests
           where entity_type = 'finance.credit_note' and payload ->> 'idempotency_key' = 'cn-C'), '1000.00+140.00',
  'the server computed the credit: the full line, VAT at the line''s rate');
select is((select count(*)::int from finance.credit_notes), 0, 'nothing is credited before approval');
select is((select count(*)::int from finance.customer_ledger where entry_type = 'credit_note'), 0, 'nor posted');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select throws_ok(format($$select api.decide_approval(%L, 'approve')$$,
    (select id from wf.approval_requests where payload ->> 'idempotency_key' = 'cn-C')), '42501', null,
  'the requester cannot approve their own credit note');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');
select is(api.decide_approval((select id from wf.approval_requests where payload ->> 'idempotency_key' = 'cn-C'), 'approve') ->> 'status',
  'approved', 'a second person approves');
select tests.clear_authentication();
select ok((select credit_no ~ ('^CN-' || extract(year from core.business_date()) || '-000001$') from finance.credit_notes where idempotency_key = 'cn-C'),
  'the credit note takes the first CN number');
select is((select amount::numeric from finance.customer_ledger where entry_type = 'credit_note'), -1140.00::numeric(14,2),
  'the credit note posts its total (incl. VAT) as a credit');
select is((select status || ':' || open_amount from api.v_invoices where order_id = 'f7000000-0000-0000-0000-00000000000c'),
  'credited:0.00', 'a fully credited invoice is credited with nothing open');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select is(api.issue_credit_note((select id from finance.invoices where order_id = 'f7000000-0000-0000-0000-00000000000c'),
    jsonb_build_array(jsonb_build_object('invoice_item_id', (select id from finance.invoice_items where order_item_id = 'f7100000-0000-0000-0000-0000000000c1'), 'quantity', 1)),
    null, 'damaged on delivery', 'cn-C') ->> 'status', 'issued', 'after approval the replay reports the issued note');
select throws_like(format($$select api.issue_credit_note(%L, %L, null, 'again', 'cn-C2')$$,
    (select id from finance.invoices where order_id = 'f7000000-0000-0000-0000-00000000000c'),
    jsonb_build_array(jsonb_build_object('invoice_item_id', (select id from finance.invoice_items where order_item_id = 'f7100000-0000-0000-0000-0000000000c1'), 'quantity', 1))),
  'CREDIT_QTY_EXCEEDED%', 'a line cannot be credited twice');

-- Goodwill amount on invoice A: VAT at the invoice's effective rate
select is((api.issue_credit_note((select id from finance.invoices where order_id = 'f7000000-0000-0000-0000-00000000000a'),
    null, 100, 'price adjustment', 'cn-A') ->> 'tax_amount')::numeric, 14.00::numeric, 'a goodwill credit of 100 carries 14 VAT');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');
select api.decide_approval((select id from wf.approval_requests where payload ->> 'idempotency_key' = 'cn-A'), 'approve');
select tests.clear_authentication();
select is((select open_amount from api.v_invoices where order_id = 'f7000000-0000-0000-0000-00000000000a'), 2573.81::numeric(14,2),
  'the credit reduces the open amount by 114');
select is((select count(*)::int from integration.outbox where event_type = 'credit_note.issued'), 2, 'credit_note.issued per note');
select throws_like($$update finance.credit_notes set amount = 1$$, 'APPEND_ONLY%', 'credit notes are append-only');

-- ===========================================================================
-- Ledger invariant: balance = Σ invoices − Σ credit notes − Σ confirmed payments
-- ===========================================================================
select is((select count(*)::int from crm.customers c
           where coalesce((select sum(amount) from finance.customer_ledger l where l.customer_id = c.id), 0)
              <> coalesce((select sum(total) from finance.invoices i where i.customer_id = c.id), 0)
               - coalesce((select sum(amount + tax_amount) from finance.credit_notes n where n.customer_id = c.id), 0)
               - coalesce((select sum(amount) from finance.payments p where p.customer_id = c.id and p.status = 'confirmed'), 0)), 0,
  'for every customer the AR ledger equals the documents');
select is((select sum(amount) from finance.customer_ledger where customer_id = '40000000-0000-0000-0000-000000000001'),
  3351.60 + 3335.36 + 0.85 - 114 - 2000 - 4000 - 5000, 'C-0001 balance: three invoices, one credit, three confirmed payments');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select is((select balance from api.v_customers where id = '40000000-0000-0000-0000-000000000001'),
  (select sum(amount) from finance.customer_ledger where customer_id = '40000000-0000-0000-0000-000000000001'),
  'the customer balance shown in CRM equals the ledger');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is((select balance from api.v_customers where id = '40000000-0000-0000-0000-000000000001'), -4426.19::numeric(14,2),
  'the rep sees the same (credit) balance for their customer');
select tests.clear_authentication();

-- ===========================================================================
-- Privileges
-- ===========================================================================
select ok(not has_function_privilege('authenticated', 'finance.invoice_balance(uuid)', 'execute')
          and not has_function_privilege('authenticated', 'finance.post_ledger(uuid, text, numeric, text, uuid)', 'execute')
          and not has_function_privilege('authenticated', 'finance.refresh_invoice_status(uuid)', 'execute')
          and not has_function_privilege('authenticated', 'finance.credit_note_amounts(uuid, jsonb, numeric)', 'execute')
          and not has_function_privilege('authenticated', 'wf.on_decided_finance_credit_note(uuid, boolean)', 'execute'),
  'finance helpers and the credit-note hook are not client-callable');
select ok(not has_function_privilege('anon', 'api.record_payment(uuid, numeric, text, text, timestamptz, uuid, date)', 'execute')
          and has_function_privilege('authenticated', 'api.record_payment(uuid, numeric, text, text, timestamptz, uuid, date)', 'execute')
          and not has_function_privilege('anon', 'api.issue_invoice(uuid, text)', 'execute'),
  'finance commands are for signed-in users only');

select * from finish();
rollback;
