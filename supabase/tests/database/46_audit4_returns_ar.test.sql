-- Fourth audit, money and stock (20261104000100_audit4_returns_ar.sql):
--   M-1  a return on a paid or partly paid invoice is credited in full: the part up to the invoice's
--        open amount reduces the invoice, the rest is released from the invoice's payment
--        allocations as unapplied customer credit (never cash); the commission engine sees the full
--        credit note and does not claw back twice. api.cancel_return releases a pending or approved
--        return's held quantity. An open return holds its quantity against ordinary credit notes.
--   M-3  a request_return replay is bound to its creator and re-checks the customer scope.
--   M-4  perf.overdue_invoices keeps a written-off invoice in the overdue figures before its write-off.
--   users: a1 owner · a2 sales director · a3 area mgr Cairo · a4 rep Cairo (customer 4…01)
--          · a5 rep Delta · a6 finance officer · a8 inventory manager
begin;
select tests.load_fixture();
select plan(70);
set constraints all immediate;

-- ---------------------------------------------------------------------------
-- Setup (all C-0001, rep a4; 1 unit = 1000, VAT 14%)
--   A 3 units, 2%  → 3351.60  paid in full by P1            (return 1 unit = 1117.20)
--   D 3 units, 2%  → 3351.60  partly paid, 2500.00 by P2     (return 1 unit: 851.60 + 265.60 credit)
--   C 1 unit       → 1140.00  unpaid; takes P1's freed credit later
--   E 2 units      → 2280.00  unpaid; cancel paths, replay binding, the hold on credit notes
--   W 1 unit       → 1140.00  back-dated overdue, then written off (M-4)
-- ---------------------------------------------------------------------------
insert into inventory.movements (movement_type, warehouse_id, variant_id, lot_id, quantity, source_doc_type) values
  ('receipt','60000000-0000-0000-0000-000000000001','53000000-0000-0000-0000-000000000001','61000000-0000-0000-0000-000000000001', 20, 'receipt');
insert into inventory.warehouses (id, code, name, kind) values
  ('60000000-0000-0000-0000-000000000046', 'WH-RQ46', 'Synthetic returns quarantine', 'quarantine');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select api.save_order_draft('f4600000-0000-0000-0000-00000000000a', '40000000-0000-0000-0000-000000000001',
  '[{"variant_id":"53000000-0000-0000-0000-000000000001","quantity":3,"requested_discount_pct":2}]');
select api.save_order_draft('f4600000-0000-0000-0000-00000000000d', '40000000-0000-0000-0000-000000000001',
  '[{"variant_id":"53000000-0000-0000-0000-000000000001","quantity":3,"requested_discount_pct":2}]');
select api.save_order_draft('f4600000-0000-0000-0000-00000000000c', '40000000-0000-0000-0000-000000000001',
  '[{"variant_id":"53000000-0000-0000-0000-000000000001","quantity":1}]');
select api.save_order_draft('f4600000-0000-0000-0000-00000000000e', '40000000-0000-0000-0000-000000000001',
  '[{"variant_id":"53000000-0000-0000-0000-000000000001","quantity":2}]');
select api.save_order_draft('f4600000-0000-0000-0000-0000000000f0', '40000000-0000-0000-0000-000000000001',
  '[{"variant_id":"53000000-0000-0000-0000-000000000001","quantity":1}]');
select api.submit_order(o) from unnest(array['f4600000-0000-0000-0000-00000000000a','f4600000-0000-0000-0000-00000000000d',
  'f4600000-0000-0000-0000-00000000000c','f4600000-0000-0000-0000-00000000000e','f4600000-0000-0000-0000-0000000000f0']::uuid[]) o;
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a3');
select api.approve_order(o) from unnest(array['f4600000-0000-0000-0000-00000000000a','f4600000-0000-0000-0000-00000000000d',
  'f4600000-0000-0000-0000-00000000000c','f4600000-0000-0000-0000-00000000000e','f4600000-0000-0000-0000-0000000000f0']::uuid[]) o;
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a8');
select api.reserve_order(o, '60000000-0000-0000-0000-000000000001')
from unnest(array['f4600000-0000-0000-0000-00000000000a','f4600000-0000-0000-0000-00000000000d',
  'f4600000-0000-0000-0000-00000000000c','f4600000-0000-0000-0000-00000000000e','f4600000-0000-0000-0000-0000000000f0']::uuid[]) o;
select api.post_fulfillment(o, 'ful-46-' || right(o::text, 2))
from unnest(array['f4600000-0000-0000-0000-00000000000a','f4600000-0000-0000-0000-00000000000d',
  'f4600000-0000-0000-0000-00000000000c','f4600000-0000-0000-0000-00000000000e','f4600000-0000-0000-0000-0000000000f0']::uuid[]) o;
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select api.issue_invoice(o, 'inv-46-' || right(o::text, 2))
from unnest(array['f4600000-0000-0000-0000-00000000000a','f4600000-0000-0000-0000-00000000000d',
  'f4600000-0000-0000-0000-00000000000c','f4600000-0000-0000-0000-00000000000e','f4600000-0000-0000-0000-0000000000f0']::uuid[]) o;
select tests.clear_authentication();

create temp table t_ids (k text primary key, id uuid);
grant select, insert on t_ids to authenticated;
insert into t_ids select 'inv' || upper(right(order_id::text, 1)), id from finance.invoices
  where order_id in ('f4600000-0000-0000-0000-00000000000a','f4600000-0000-0000-0000-00000000000d',
                     'f4600000-0000-0000-0000-00000000000c','f4600000-0000-0000-0000-00000000000e');
insert into t_ids select 'invW', id from finance.invoices where order_id = 'f4600000-0000-0000-0000-0000000000f0';
insert into t_ids select 'item' || upper(right(order_id::text, 1)), id from sales.order_items
  where order_id in ('f4600000-0000-0000-0000-00000000000a','f4600000-0000-0000-0000-00000000000d',
                     'f4600000-0000-0000-0000-00000000000e');
create or replace function pg_temp.id(p_k text) returns uuid language sql stable as $$ select id from t_ids where k = p_k $$;
create or replace function pg_temp.lines(p_item text, p_qty int) returns jsonb language sql stable as $$
  select jsonb_build_array(jsonb_build_object('order_item_id', pg_temp.id(p_item), 'quantity', p_qty, 'reason_code', 'damaged'))
$$;
create or replace function pg_temp.open(p_inv text) returns numeric language sql stable as $$
  select o_open from finance.invoice_balance(pg_temp.id(p_inv))
$$;
-- Allocation rows that released paid money for one credit note, as "amount,amount" in time order.
create or replace function pg_temp.released(p_cn uuid) returns text language sql stable as $$
  select string_agg(amount::text, ',' order by allocated_at, amount) from finance.payment_allocations where credit_note_id = p_cn
$$;
grant execute on function pg_temp.id(text), pg_temp.lines(text, int) to authenticated;

select is((select string_agg(total::text, ',' order by invoice_no) from finance.invoices
           where order_id::text like 'f4600000-%'),
  '3351.60,3351.60,1140.00,2280.00,1140.00', 'setup: invoices A, D, C, E, W');

-- Payments: P1 pays A in full, P2 pays 2500.00 of D.
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
insert into t_ids select 'P1', (api.record_payment('40000000-0000-0000-0000-000000000001', 3351.60, 'cash', 'R46-1', null,
                                                   'c4600000-0000-0000-0000-000000000001') ->> 'payment_id')::uuid;
insert into t_ids select 'P2', (api.record_payment('40000000-0000-0000-0000-000000000001', 2500.00, 'cash', 'R46-2', null,
                                                   'c4600000-0000-0000-0000-000000000002') ->> 'payment_id')::uuid;
select api.allocate_payment(pg_temp.id('P1'), jsonb_build_array(jsonb_build_object('invoice_id', pg_temp.id('invA'), 'amount', 3351.60)), 'al-46-1');
select api.allocate_payment(pg_temp.id('P2'), jsonb_build_array(jsonb_build_object('invoice_id', pg_temp.id('invD'), 'amount', 2500.00)), 'al-46-2');
-- One test transaction has one now(): place the collections a minute before the later events so the
-- commission engine replays them in real-life order (test-only, triggers off).
select tests.clear_authentication();
set session_replication_role = replica;
update finance.payment_allocations set allocated_at = allocated_at - interval '1 minute' where idempotency_key in ('al-46-1','al-46-2');
set session_replication_role = origin;
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select is((select status || '|' || open_amount from api.v_invoices where id = pg_temp.id('invA')) || ' ' ||
          (select status || '|' || open_amount from api.v_invoices where id = pg_temp.id('invD')),
  'paid|0.00 partially_paid|851.60', 'setup: A is paid, D has 851.60 open');

-- ===========================================================================
-- M-1 · a return on a fully paid invoice (A)
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
insert into t_ids select 'rA', (api.request_return('f4600000-0000-0000-0000-00000000000a', pg_temp.lines('itemA', 1), null,
                                                   'c4600000-0000-0000-0000-0000000000a1') ->> 'return_id')::uuid;
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a2');
select api.decide_approval((select approval_request_id from sales.returns where id = pg_temp.id('rA')), 'approve');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a8');
select api.receive_return(pg_temp.id('rA'), '60000000-0000-0000-0000-000000000046', 'rcv-46-A');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
create temp table t_credit as select api.credit_return(pg_temp.id('rA'), 'cr-46-A') as r;
select is((select r ->> 'status' from t_credit), 'credited', 'M-1 a return on a fully paid invoice is credited (no longer stuck)');
select is((select (r ->> 'total')::numeric || '|' || (r ->> 'customer_credit')::numeric from t_credit), '1117.20|1117.20',
  'M-1 the customer gets the full return value, all of it as customer credit');
select tests.clear_authentication();
insert into t_ids select 'cnA', id from finance.credit_notes where return_id = pg_temp.id('rA');
select is((select invoice_id = pg_temp.id('invA') and amount = 980.00 and tax_amount = 137.20
           from finance.credit_notes where id = pg_temp.id('cnA')), true,
  'M-1 one credit note on invoice A for the full value (980.00 + VAT 137.20)');
select is(pg_temp.open('invA'), 0.00::numeric, 'M-1 invoice A open amount is 0, never negative');
select is((select status from finance.invoices where id = pg_temp.id('invA')), 'paid', 'M-1 invoice A stays paid');
select is(pg_temp.released(pg_temp.id('cnA')), '-3351.60,2234.40',
  'M-1 the paid money is released by an appended reversal and a re-allocation of the rest (append-only)');
select is(finance.payment_unallocated(pg_temp.id('P1')), 1117.20::numeric, 'M-1 P1 now holds 1117.20 unapplied customer credit');
select is((select amount::numeric from finance.customer_ledger where source_table = 'finance.credit_notes' and source_id = pg_temp.id('cnA')),
  -1117.20::numeric, 'M-1 the ledger is credited with the full return value once');
select is((select status from sales.returns where id = pg_temp.id('rA')), 'credited', 'M-1 the return is credited');
select is((select payload ->> 'customer_credit' from integration.outbox where event_type = 'return.credited'
             and aggregate_id = pg_temp.id('rA')), '1117.20', 'M-1 the return.credited event carries the customer credit');

-- Replay: same answer, nothing posted twice.
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select is((select (r ->> 'replayed') || '|' || (r ->> 'total') || '|' || (r ->> 'customer_credit')
           from (select api.credit_return(pg_temp.id('rA'), 'cr-46-A') as r) x), 'true|1117.20|1117.20',
  'M-1 a replayed credit returns the first result');
select tests.clear_authentication();
select is((select count(*)::int from finance.payment_allocations where credit_note_id = pg_temp.id('cnA')), 2,
  'M-1 the replay releases nothing more');

-- ===========================================================================
-- M-1 · a return on a partly paid invoice (D): 851.60 reduces D, 265.60 becomes customer credit
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
insert into t_ids select 'rD', (api.request_return('f4600000-0000-0000-0000-00000000000d', pg_temp.lines('itemD', 1), null,
                                                   'c4600000-0000-0000-0000-0000000000d1') ->> 'return_id')::uuid;
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a2');
select api.decide_approval((select approval_request_id from sales.returns where id = pg_temp.id('rD')), 'approve');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a8');
select api.receive_return(pg_temp.id('rD'), '60000000-0000-0000-0000-000000000046', 'rcv-46-D');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select is((select (r ->> 'total')::numeric || '|' || (r ->> 'customer_credit')::numeric
           from (select api.credit_return(pg_temp.id('rD'), 'cr-46-D') as r) x), '1117.20|265.60',
  'M-1 partly paid: full value credited, the 265.60 above the open 851.60 is customer credit');
select tests.clear_authentication();
insert into t_ids select 'cnD', id from finance.credit_notes where return_id = pg_temp.id('rD');
select is(pg_temp.open('invD'), 0.00::numeric, 'M-1 invoice D open amount is 0');
select is(pg_temp.released(pg_temp.id('cnD')), '-2500.00,2234.40', 'M-1 only the excess is released from P2');
select is(finance.payment_unallocated(pg_temp.id('P2')), 265.60::numeric, 'M-1 P2 holds 265.60 unapplied customer credit');

-- AR invariants across the customer.
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select is((select count(*)::int from api.v_invoices where open_amount < 0), 0, 'M-1 no invoice is ever over-credited');
select is((select ledger_balance from api.v_ar_aging where customer_id = '40000000-0000-0000-0000-000000000001'),
  (select sum(amount) from finance.customer_ledger where customer_id = '40000000-0000-0000-0000-000000000001')::numeric(14,2),
  'M-1 customer balance = the sum of the ledger');
select is((select unapplied_credit from api.v_ar_aging where customer_id = '40000000-0000-0000-0000-000000000001'),
  1382.80::numeric, 'M-1 aging shows the 1117.20 + 265.60 unapplied credit');
select is((select sum(unallocated) from api.v_payments where id in (pg_temp.id('P1'), pg_temp.id('P2'))), 1382.80::numeric,
  'M-1 the payments list shows the same credit as unallocated');

-- The credit offsets a later invoice through the existing allocation command.
select is((api.allocate_payment(pg_temp.id('P1'), jsonb_build_array(jsonb_build_object('invoice_id', pg_temp.id('invC'), 'amount', 1117.20)),
                                'al-46-3') ->> 'payment_unallocated')::numeric, 0.00::numeric,
  'M-1 P1''s customer credit is allocated to invoice C');
select is((select status || '|' || open_amount from api.v_invoices where id = pg_temp.id('invC')), 'partially_paid|22.80',
  'M-1 invoice C is offset by the credit');

-- Commission: the clawback sees the full return value once (no double clawback by the release).
select tests.clear_authentication();
update perf.commission_plans set status = 'active', effective_from = '2000-01-01' where code = 'STD-2026';
select service.commission_calculate(core.business_date());
select is((select string_agg(entry_kind || ':' || s, ',' order by entry_kind) from (
             select entry_kind, sum(commission_amount) as s from perf.commission_entries
             where invoice_id = pg_temp.id('invA') group by entry_kind) x),
  'collection:147.00,credit_clawback:-49.00', 'M-1 A: the returned unit''s commission is clawed back as a credit clawback');
select is((select sum(commission_amount) from perf.commission_entries where invoice_id = pg_temp.id('invD')), 98.00::numeric,
  'M-1 D: the rep keeps commission on the two kept units only');
select is((select count(*)::int from perf.commission_entries where invoice_id in (pg_temp.id('invA'), pg_temp.id('invD'))
             and entry_kind in ('reversal','bounce')), 0, 'M-1 the release rows are not clawed back a second time');
select is((select sum(commission_amount) from perf.commission_entries where invoice_id = pg_temp.id('invC')), 49.00::numeric,
  'M-1 C earns on the customer credit applied to it');

-- A later reversal of P2 makes D owed again for exactly the value kept, and its commission goes.
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select is((api.reverse_payment(pg_temp.id('P2'), 'cheque returned by the bank') ->> 'allocations_reversed')::int, 1,
  'M-1 reversing P2 un-allocates only its standing re-allocation');
select tests.clear_authentication();
select is(pg_temp.open('invD'), 2234.40::numeric, 'M-1 D is owed again for the two kept units');
select service.commission_calculate(core.business_date());
select is((select sum(commission_amount) from perf.commission_entries where invoice_id = pg_temp.id('invD')), 0.00::numeric,
  'M-1 D''s commission is fully clawed back after the reversal');
select is((select count(*)::int from api.v_invoices where open_amount < 0), 0, 'M-1 still no invoice below zero');

-- ===========================================================================
-- M-3 · request_return replays are bound to their creator and re-check scope
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
insert into t_ids select 'rE1', (api.request_return('f4600000-0000-0000-0000-00000000000e', pg_temp.lines('itemE', 2), null,
                                                    'c4600000-0000-0000-0000-0000000000e1') ->> 'return_id')::uuid;
select is((select string_agg(k, ',' order by k) from jsonb_object_keys(
             api.request_return('f4600000-0000-0000-0000-00000000000e', pg_temp.lines('itemE', 2), null,
                                'c4600000-0000-0000-0000-0000000000e1')) k),
  'approval_request_id,replayed,return_id,return_no,status', 'M-3 the creator''s replay answers ids and status only');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a3');
select throws_like($$select api.request_return('f4600000-0000-0000-0000-00000000000e', pg_temp.lines('itemE', 2), null,
                                               'c4600000-0000-0000-0000-0000000000e1')$$,
  'IDEMPOTENCY_CONFLICT%', 'M-3 another user in scope cannot replay the creator''s request');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a5');
select throws_like($$select api.request_return('f4600000-0000-0000-0000-00000000000e', pg_temp.lines('itemE', 2), null,
                                               'c4600000-0000-0000-0000-0000000000e1')$$,
  'PERMISSION_DENIED%', 'M-3 a user out of scope gets no replay answer');

-- ===========================================================================
-- M-1 · api.cancel_return
-- ===========================================================================
select tests.clear_authentication();
select ok(has_function_privilege('authenticated', 'api.cancel_return(uuid, text, text)', 'execute')
          and not has_function_privilege('anon', 'api.cancel_return(uuid, text, text)', 'execute'),
  'cancel_return is callable by signed-in users only');
select is((select returnable_qty from api.v_returnable_lines where order_item_id = pg_temp.id('itemE')), 0,
  'cancel: the pending request holds both units of E');

-- Pending: only the requester.
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a3');
select throws_like($$select api.cancel_return(pg_temp.id('rE1'), 'not needed', 'cx-46-1')$$, 'PERMISSION_DENIED%',
  'cancel: a manager cannot withdraw someone else''s pending return');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a2');
select throws_like($$select api.cancel_return(pg_temp.id('rE1'), 'not needed', 'cx-46-1')$$, 'PERMISSION_DENIED%',
  'cancel: an approver rejects a pending return instead of cancelling it');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select throws_like($$select api.cancel_return(pg_temp.id('rE1'), ' ', 'cx-46-1')$$, 'REASON_REQUIRED%', 'cancel: a reason is required');
select throws_like($$select api.cancel_return(pg_temp.id('rE1'), 'not needed', null)$$, 'VALIDATION%', 'cancel: an idempotency key is required');
select is(api.cancel_return(pg_temp.id('rE1'), 'customer kept the goods', 'cx-46-1') ->> 'status', 'cancelled',
  'cancel: the requester withdraws the pending return');
select is((api.cancel_return(pg_temp.id('rE1'), 'customer kept the goods', 'cx-46-1') ->> 'replayed')::boolean, true,
  'cancel: a retry is a replay');
select tests.clear_authentication();
select is((select r.status || '|' || ar.status || '|' || r.cancel_reason || '|' || (r.cancelled_by = '00000000-0000-0000-0000-0000000000a4')
           from sales.returns r join wf.approval_requests ar on ar.id = r.approval_request_id where r.id = pg_temp.id('rE1')),
  'cancelled|cancelled|customer kept the goods|true', 'cancel: the return and its approval request are cancelled, with who and why');
select is((select returnable_qty from api.v_returnable_lines where order_item_id = pg_temp.id('itemE')), 2,
  'cancel: the held quantity is released');
select is((select returned_qty from sales.order_items where id = pg_temp.id('itemE')), 0, 'cancel: nothing was ever received');
select is((select count(*)::int from integration.outbox where event_type = 'return.cancelled' and aggregate_id = pg_temp.id('rE1')), 1,
  'cancel: one return.cancelled event');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a2');
select throws_like($$select api.decide_approval((select approval_request_id from sales.returns where id = pg_temp.id('rE1')), 'approve')$$,
  'INVALID_STATE%', 'cancel: the cancelled request can no longer be approved');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a8');
select throws_like($$select api.receive_return(pg_temp.id('rE1'), '60000000-0000-0000-0000-000000000046', 'rcv-46-E1')$$,
  'INVALID_STATE%', 'cancel: a cancelled return cannot be received');

-- The freed quantity can be requested again; approved returns are cancelled by receivers or approvers.
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
insert into t_ids select 'rE2', (api.request_return('f4600000-0000-0000-0000-00000000000e', pg_temp.lines('itemE', 2), null,
                                                    'c4600000-0000-0000-0000-0000000000e2') ->> 'return_id')::uuid;
select ok(pg_temp.id('rE2') is not null, 'cancel: the released units can be requested again');
select throws_like($$select api.cancel_return(pg_temp.id('rE2'), 'oops', 'cx-46-1')$$, 'IDEMPOTENCY_CONFLICT%',
  'cancel: a key used for another return is refused');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a2');
select api.decide_approval((select approval_request_id from sales.returns where id = pg_temp.id('rE2')), 'approve');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select throws_like($$select api.cancel_return(pg_temp.id('rE2'), 'changed my mind', 'cx-46-2')$$, 'PERMISSION_DENIED%',
  'cancel: the requester cannot cancel after approval');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a5');
select throws_like($$select api.cancel_return(pg_temp.id('rE2'), 'changed my mind', 'cx-46-2')$$, 'PERMISSION_DENIED%',
  'cancel: another rep cannot cancel it');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a8');
select is(api.cancel_return(pg_temp.id('rE2'), 'goods never arrived at the warehouse', 'cx-46-2') ->> 'status', 'cancelled',
  'cancel: the inventory manager cancels an approved return that never arrived');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
insert into t_ids select 'rE3', (api.request_return('f4600000-0000-0000-0000-00000000000e', pg_temp.lines('itemE', 1), null,
                                                    'c4600000-0000-0000-0000-0000000000e3') ->> 'return_id')::uuid;
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a2');
select api.decide_approval((select approval_request_id from sales.returns where id = pg_temp.id('rE3')), 'approve');
select is(api.cancel_return(pg_temp.id('rE3'), 'customer will keep the item', 'cx-46-3') ->> 'status', 'cancelled',
  'cancel: the return approver (wf.decide.return) cancels an approved return');
select is((select returnable_qty from api.v_returnable_lines where order_item_id = pg_temp.id('itemE')), 2,
  'cancel: approved-and-cancelled returns hold nothing');

-- Received, credited and rejected returns cannot be cancelled.
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
insert into t_ids select 'rE4', (api.request_return('f4600000-0000-0000-0000-00000000000e', pg_temp.lines('itemE', 1), null,
                                                    'c4600000-0000-0000-0000-0000000000e4') ->> 'return_id')::uuid;
insert into t_ids select 'rE5', (api.request_return('f4600000-0000-0000-0000-00000000000e', pg_temp.lines('itemE', 1), null,
                                                    'c4600000-0000-0000-0000-0000000000e5') ->> 'return_id')::uuid;
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a2');
select api.decide_approval((select approval_request_id from sales.returns where id = pg_temp.id('rE4')), 'approve');
select api.decide_approval((select approval_request_id from sales.returns where id = pg_temp.id('rE5')), 'reject');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a8');
select api.receive_return(pg_temp.id('rE4'), '60000000-0000-0000-0000-000000000046', 'rcv-46-E4');
select throws_like($$select api.cancel_return(pg_temp.id('rE4'), 'too late', 'cx-46-4')$$, 'INVALID_STATE%',
  'cancel: a received return cannot be cancelled');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select throws_like($$select api.cancel_return(pg_temp.id('rE5'), 'already rejected', 'cx-46-5')$$, 'INVALID_STATE%',
  'cancel: a rejected return cannot be cancelled');

-- An open return holds its quantity against ordinary credit notes (no CREDIT_QTY_EXCEEDED later).
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select throws_like(format($$select api.issue_credit_note(%L, %L::jsonb, null, 'price dispute', 'cn-46-hold-2')$$,
                          pg_temp.id('invE'), jsonb_build_array(jsonb_build_object('invoice_item_id',
                            (select id from finance.invoice_items where invoice_id = pg_temp.id('invE')), 'quantity', 2))),
  'CREDIT_QTY_EXCEEDED%', 'hold: finance cannot credit units an open return holds');
select lives_ok(format($$select api.issue_credit_note(%L, %L::jsonb, null, 'price dispute', 'cn-46-hold-1')$$,
                       pg_temp.id('invE'), jsonb_build_array(jsonb_build_object('invoice_item_id',
                         (select id from finance.invoice_items where invoice_id = pg_temp.id('invE')), 'quantity', 1))),
  'hold: the unit no return holds can still be credited');

-- The received return on the unpaid invoice E is credited the ordinary way (nothing released).
select is((select (r ->> 'total')::numeric || '|' || (r ->> 'customer_credit')::numeric
           from (select api.credit_return(pg_temp.id('rE4'), 'cr-46-E4') as r) x), '1140.00|0.00',
  'unpaid invoice: the credit fits the open amount, no customer credit');
select tests.clear_authentication();
select is((select count(*)::int from finance.payment_allocations pa join finance.credit_notes cn on cn.id = pa.credit_note_id
           where cn.return_id = pg_temp.id('rE4')), 0, 'unpaid invoice: no allocation is touched');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a8');
select throws_like($$select api.cancel_return(pg_temp.id('rE4'), 'too late', 'cx-46-4')$$, 'INVALID_STATE%',
  'cancel: a credited return cannot be cancelled');

-- The status CHECK grew by 'cancelled' only.
select tests.clear_authentication();
select throws_ok($$update sales.returns set status = 'void' where id = pg_temp.id('rE5')$$, '23514', null,
  'the status CHECK still refuses unknown statuses');
select is((select status from api.v_returns where id = pg_temp.id('rE1')), 'cancelled', 'the returns view shows the cancelled return');

-- ===========================================================================
-- M-4 · a written-off invoice stays in the overdue figures of the days before its write-off
-- ===========================================================================
set session_replication_role = replica;   -- test-only: back-date invoice W past due
update finance.invoices set issue_date = core.business_date() - 40, due_date = core.business_date() - 10
where id = pg_temp.id('invW');
set session_replication_role = origin;
select is((select count(*)::int || '|' || sum(open_amount) from perf.overdue_invoices(core.business_date() - 1)
           where invoice_id = pg_temp.id('invW')), '1|1140.00', 'M-4 W is overdue yesterday before the write-off');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select api.request_invoice_write_off(pg_temp.id('invW'), 1140.00, 'clinic closed (synthetic)', 'wo-46-W');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');
select api.decide_approval((select r.id from wf.approval_requests r join wf.workflow_definitions d on d.id = r.definition_id
                            where d.code = 'finance.write_off' and r.status = 'pending' and r.payload ->> 'invoice_id' = pg_temp.id('invW')::text),
                           'approve');
select tests.clear_authentication();
select is((select status from finance.invoices where id = pg_temp.id('invW')), 'written_off', 'M-4 W is written off today');
select is((select count(*)::int || '|' || sum(open_amount) from perf.overdue_invoices(core.business_date() - 1)
           where invoice_id = pg_temp.id('invW')), '1|1140.00', 'M-4 yesterday''s overdue figure is unchanged by today''s write-off');
select is((select count(*)::int from perf.overdue_invoices(core.business_date()) where invoice_id = pg_temp.id('invW')), 0,
  'M-4 from the write-off day on, W is no longer overdue');

-- ===========================================================================
-- M-3 · after the customer is reassigned away, the former creator's replay is refused
-- ===========================================================================
update crm.customer_assignments set valid_from = now() - interval '2 days', valid_to = now() - interval '1 hour'
where customer_id = '40000000-0000-0000-0000-000000000001';
insert into crm.customer_assignments (customer_id, employee_id, role) values
  ('40000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000005', 'primary_rep');
update sales.orders set employee_id = '20000000-0000-0000-0000-000000000005' where id = 'f4600000-0000-0000-0000-00000000000e';
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select throws_like($$select api.request_return('f4600000-0000-0000-0000-00000000000e', pg_temp.lines('itemE', 1), null,
                                               'c4600000-0000-0000-0000-0000000000e4')$$,
  'PERMISSION_DENIED%', 'M-3 a former creator no longer in scope gets no replay answer');

select * from finish();
rollback;
