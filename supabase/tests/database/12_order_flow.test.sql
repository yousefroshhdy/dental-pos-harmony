-- Order lifecycle: draft → submit → (discount / credit approval) → reserve (FEFO) → fulfil,
-- cancellation paths, self-approval, idempotency, all-or-nothing reservation, stock invariants.
begin;
select tests.load_fixture();
select plan(78);

-- Stock in WH-CAI for variant 53…01: lot L2026A (exp 2030-12-31) 10, lot L2029B (exp 2029-06-30) 8,
-- expired lot LOLD (exp 2020-01-01) 50 — must never be reserved.
insert into inventory.lots (id, variant_id, lot_no, expiry_date) values
  ('61000000-0000-0000-0000-000000000002', '53000000-0000-0000-0000-000000000001', 'L2029B', '2029-06-30'),
  ('61000000-0000-0000-0000-000000000003', '53000000-0000-0000-0000-000000000001', 'LOLD',   '2020-01-01');
insert into inventory.movements (movement_type, warehouse_id, variant_id, lot_id, quantity, source_doc_type) values
  ('receipt','60000000-0000-0000-0000-000000000001','53000000-0000-0000-0000-000000000001','61000000-0000-0000-0000-000000000001', 10, 'receipt'),
  ('receipt','60000000-0000-0000-0000-000000000001','53000000-0000-0000-0000-000000000001','61000000-0000-0000-0000-000000000002',  8, 'receipt'),
  ('receipt','60000000-0000-0000-0000-000000000001','53000000-0000-0000-0000-000000000001','61000000-0000-0000-0000-000000000003', 50, 'receipt');

-- ---------------------------------------------------------------------------
-- Drafts (rep a4, customer C-0001)
-- ---------------------------------------------------------------------------
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is((api.save_order_draft('71000000-0000-0000-0000-00000000000a', '40000000-0000-0000-0000-000000000001',
            '[{"variant_id":"53000000-0000-0000-0000-000000000001","quantity":15,"requested_discount_pct":2}]') ->> 'indicative_total')::numeric,
          16758.00::numeric, 'draft returns server-computed indicative total: 15 × 1000 − 2% + 14% VAT');
select throws_like($$select api.save_order_draft('71000000-0000-0000-0000-0000000000ff', '40000000-0000-0000-0000-000000000001',
            '[{"variant_id":"53000000-0000-0000-0000-000000000001","quantity":1,"list_price":1}]')$$,
  'VALIDATION%', 'client-sent prices are rejected');
select throws_like($$select api.save_order_draft('71000000-0000-0000-0000-0000000000fe', '40000000-0000-0000-0000-000000000002',
            '[{"variant_id":"53000000-0000-0000-0000-000000000001","quantity":1}]')$$,
  'PERMISSION_DENIED%', 'rep cannot draft for a customer outside their scope');
select throws_like($$select api.save_order_draft('71000000-0000-0000-0000-00000000000a', '40000000-0000-0000-0000-000000000001',
            '[{"variant_id":"53000000-0000-0000-0000-000000000001","quantity":15}]', null, null, 99)$$,
  'CONFLICT%', 'stale version is rejected');
select is((api.save_order_draft('71000000-0000-0000-0000-00000000000a', '40000000-0000-0000-0000-000000000001',
            '[{"variant_id":"53000000-0000-0000-0000-000000000001","quantity":15,"requested_discount_pct":2}]', 'deliver Sunday', null, 1) ->> 'version')::int,
          2, 'update with the current version bumps the version');
select is((select count(*)::int from sales.order_items where order_id = '71000000-0000-0000-0000-00000000000a'), 1,
  'draft lines are replaced, not appended');
select is(api.submit_order('71000000-0000-0000-0000-00000000000a') ->> 'status', 'submitted', 'order A submitted (2% within the rep''s 3%)');
select throws_like($$select api.approve_order('71000000-0000-0000-0000-00000000000a')$$, 'PERMISSION_DENIED%', 'rep cannot accept orders');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a3');
select is(api.approve_order('71000000-0000-0000-0000-00000000000a') ->> 'status', 'approved', 'area manager accepts a team order');
select throws_like($$select api.reserve_order('71000000-0000-0000-0000-00000000000a', '60000000-0000-0000-0000-000000000001')$$,
  'PERMISSION_DENIED%', 'area manager cannot reserve stock');

-- ---------------------------------------------------------------------------
-- Reserve (FEFO) and fulfil
-- ---------------------------------------------------------------------------
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a8');
select is(api.reserve_order('71000000-0000-0000-0000-00000000000a', '60000000-0000-0000-0000-000000000001') ->> 'status',
  'reserved', 'inventory manager reserves order A');
select tests.clear_authentication();
select is((select string_agg(l.lot_no || ':' || r.quantity, ',' order by l.expiry_date)
           from inventory.reservations r join inventory.lots l on l.id = r.lot_id
           join sales.order_items oi on oi.id = r.order_item_id
           where oi.order_id = '71000000-0000-0000-0000-00000000000a'),
  'L2029B:8,L2026A:7', 'FEFO: earliest-expiring lot first, then the next; expired lot skipped');
select is((select string_agg(l.lot_no || ':' || b.reserved, ',' order by l.expiry_date)
           from inventory.stock_balances b join inventory.lots l on l.id = b.lot_id),
  'LOLD:0,L2029B:8,L2026A:7', 'stock_balances.reserved incremented per lot');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a8');
select throws_like($$select api.reserve_order('71000000-0000-0000-0000-00000000000a', '60000000-0000-0000-0000-000000000001')$$,
  'INVALID_STATE%', 'an order is reserved once');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select throws_like($$select api.post_fulfillment('71000000-0000-0000-0000-00000000000a', 'ful-A')$$,
  'PERMISSION_DENIED%', 'rep cannot post fulfilments');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a8');
select is(api.post_fulfillment('71000000-0000-0000-0000-00000000000a', 'ful-A') ->> 'order_status', 'fulfilled', 'fulfilment posted');
select is(api.post_fulfillment('71000000-0000-0000-0000-00000000000a', 'ful-A') ->> 'replayed', 'true', 'replay with the same key is recognised');
select tests.clear_authentication();
select is((select count(*)::int from sales.fulfillments where order_id = '71000000-0000-0000-0000-00000000000a'), 1,
  'replay created no second fulfilment');
select ok((select fulfillment_no from sales.fulfillments where order_id = '71000000-0000-0000-0000-00000000000a') ~ '^FUL-[0-9]{4}-000001$',
  'fulfilment number from the FUL series');
select is((select string_agg(l.lot_no || ':' || b.on_hand || '/' || b.reserved, ',' order by l.expiry_date)
           from inventory.stock_balances b join inventory.lots l on l.id = b.lot_id),
  'LOLD:50/0,L2029B:0/0,L2026A:3/0', 'on-hand reduced and reservations consumed per lot');
select is((select sum(quantity)::int from inventory.movements where movement_type = 'sale_issue' and source_doc_type = 'fulfillment'
           and source_doc_id = (select id from sales.fulfillments where order_id = '71000000-0000-0000-0000-00000000000a')),
  -15, 'sale_issue movements total −15');
select is((select count(*)::int from inventory.movements where movement_type = 'sale_issue' and unit_cost = 600), 2,
  'sale issues carry the current unit cost for valuation');
select is((select count(*)::int from inventory.reservations where status = 'consumed'), 2, 'both reservations consumed');
select is((select fulfilled_qty from sales.order_items where order_id = '71000000-0000-0000-0000-00000000000a'), 15, 'fulfilled_qty updated');
select is((select string_agg(to_status, '>' order by id) from sales.order_status_history where order_id = '71000000-0000-0000-0000-00000000000a'),
  'draft>submitted>approved>reserved>fulfilled', 'every transition is in the status history');
select is((select count(*)::int from integration.outbox where event_type = 'order.fulfilled' and aggregate_id = '71000000-0000-0000-0000-00000000000a'), 1,
  'order.fulfilled emitted');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a2');
select throws_like($$select api.cancel_order('71000000-0000-0000-0000-00000000000a', 'customer changed mind')$$,
  'INVALID_STATE%', 'a fulfilled order cannot be cancelled (returns flow)');

-- ---------------------------------------------------------------------------
-- Discount approvals: B 8% (AM ok), C 15% (AM blocked, SD ok), D 25% (SD blocked, owner rejects),
-- E 5% from the Delta rep (outside the AM's team)
-- ---------------------------------------------------------------------------
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select api.save_order_draft('71000000-0000-0000-0000-00000000000b', '40000000-0000-0000-0000-000000000001',
  '[{"variant_id":"53000000-0000-0000-0000-000000000001","quantity":1,"requested_discount_pct":8}]');
select api.save_order_draft('71000000-0000-0000-0000-00000000000c', '40000000-0000-0000-0000-000000000001',
  '[{"variant_id":"53000000-0000-0000-0000-000000000001","quantity":5,"requested_discount_pct":15}]');
select api.save_order_draft('71000000-0000-0000-0000-00000000000d', '40000000-0000-0000-0000-000000000001',
  '[{"variant_id":"53000000-0000-0000-0000-000000000001","quantity":1,"requested_discount_pct":25}]');
select is(api.submit_order('71000000-0000-0000-0000-00000000000b') ->> 'status', 'pending_approval', 'order B (8%) needs approval');
select api.submit_order('71000000-0000-0000-0000-00000000000c');
select api.submit_order('71000000-0000-0000-0000-00000000000d');
select throws_like($$select api.decide_approval((select id from wf.approval_requests where entity_id = '71000000-0000-0000-0000-00000000000b'), 'approve')$$,
  'SELF_APPROVAL%', 'rep cannot approve their own discount');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a3');
select is(api.decide_approval((select id from wf.approval_requests where entity_id = '71000000-0000-0000-0000-00000000000b'), 'approve') ->> 'status',
  'approved', 'area manager approves 8% (limit 10%)');
select is((select status from sales.orders where id = '71000000-0000-0000-0000-00000000000b'), 'approved', 'hook moved order B to approved');
select throws_like($$select api.decide_approval((select id from wf.approval_requests where entity_id = '71000000-0000-0000-0000-00000000000c'), 'approve')$$,
  'LIMIT_EXCEEDED%', 'area manager cannot approve 15%');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a2');
select is(api.decide_approval((select id from wf.approval_requests where entity_id = '71000000-0000-0000-0000-00000000000c'), 'approve') ->> 'status',
  'approved', 'sales director approves 15% (limit 20%)');
select throws_like($$select api.decide_approval((select id from wf.approval_requests where entity_id = '71000000-0000-0000-0000-00000000000d'), 'approve')$$,
  'LIMIT_EXCEEDED%', 'sales director cannot approve 25%');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');
select is(api.decide_approval((select id from wf.approval_requests where entity_id = '71000000-0000-0000-0000-00000000000d'), 'reject', 'too deep') ->> 'status',
  'rejected', 'owner rejects 25%');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is((select string_agg(id::text || ':' || status, ',' order by id) from api.v_orders
           where id in ('71000000-0000-0000-0000-00000000000c','71000000-0000-0000-0000-00000000000d')),
  '71000000-0000-0000-0000-00000000000c:approved,71000000-0000-0000-0000-00000000000d:rejected', 'rep sees C approved, D rejected');
select is((select count(*)::int from api.v_notifications where type = 'order.approved'), 3, 'rep notified for A, B and C approvals');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a5');
select api.save_order_draft('71000000-0000-0000-0000-00000000000e', '40000000-0000-0000-0000-000000000002',
  '[{"variant_id":"53000000-0000-0000-0000-000000000001","quantity":1,"requested_discount_pct":5}]');
select api.submit_order('71000000-0000-0000-0000-00000000000e');
select tests.clear_authentication();
select set_config('test.req_e', (select id::text from wf.approval_requests where entity_id = '71000000-0000-0000-0000-00000000000e'), true);
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a3');
select is((select count(*)::int from wf.approval_requests where entity_id = '71000000-0000-0000-0000-00000000000e'), 0,
  'area manager cannot even see a request outside their team');
select throws_like($$select api.decide_approval(current_setting('test.req_e')::uuid, 'approve')$$,
  'PERMISSION_DENIED%', 'area manager cannot approve outside their team (scope)');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a2');
select is(api.decide_approval((select id from wf.approval_requests where entity_id = '71000000-0000-0000-0000-00000000000e'), 'approve') ->> 'status',
  'approved', 'sales director (all scope) approves it');

-- Manager drafts on behalf of a team rep; the rep (subject) still cannot approve it
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a3');
select throws_like($$select api.save_order_draft('71000000-0000-0000-0000-0000000000fd', '40000000-0000-0000-0000-000000000001',
  '[{"variant_id":"53000000-0000-0000-0000-000000000001","quantity":1}]', null, null, null, '20000000-0000-0000-0000-000000000005')$$,
  'PERMISSION_DENIED%', 'manager cannot draft for an employee outside the team');
select is((api.save_order_draft('71000000-0000-0000-0000-00000000000f', '40000000-0000-0000-0000-000000000001',
  '[{"variant_id":"53000000-0000-0000-0000-000000000001","quantity":1,"requested_discount_pct":15}]', null, null, null,
  '20000000-0000-0000-0000-000000000004') ->> 'created')::boolean, true, 'manager drafts on behalf of a team rep');
select is(api.submit_order('71000000-0000-0000-0000-00000000000f') ->> 'status', 'pending_approval', '15% exceeds the manager''s 10%');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select throws_like($$select api.decide_approval((select id from wf.approval_requests where entity_id = '71000000-0000-0000-0000-00000000000f'), 'approve')$$,
  'SELF_APPROVAL%', 'the rep the order is about cannot decide it either');
select tests.clear_authentication();
select is((select count(*)::int from integration.outbox where event_type = 'order.rejected' and aggregate_id = '71000000-0000-0000-0000-00000000000d'), 1,
  'order.rejected emitted');
select is((select count(*)::int from wf.approval_steps), 4, 'one approval step per decision (failed attempts leave none)');

-- ---------------------------------------------------------------------------
-- All-or-nothing reservation: C needs 5, only 3 sellable (L2026A); expired lot ignored
-- ---------------------------------------------------------------------------
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a8');
select throws_like($$select api.reserve_order('71000000-0000-0000-0000-00000000000c', '60000000-0000-0000-0000-000000000001')$$,
  'INSUFFICIENT_STOCK%', 'insufficient sellable stock is rejected');
select tests.clear_authentication();
select is((select count(*)::int from inventory.reservations r join sales.order_items oi on oi.id = r.order_item_id
           where oi.order_id = '71000000-0000-0000-0000-00000000000c'), 0, 'no partial reservation left behind');
select is((select sum(reserved)::int from inventory.stock_balances), 0, 'reserved quantities unchanged');
select is((select status from sales.orders where id = '71000000-0000-0000-0000-00000000000c'), 'approved', 'order C stays approved');

-- ---------------------------------------------------------------------------
-- Cancellation: reserved order B via workflow (releases stock); draft G by its rep; submitted H by SD
-- ---------------------------------------------------------------------------
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a8');
select is(api.reserve_order('71000000-0000-0000-0000-00000000000b', '60000000-0000-0000-0000-000000000001') ->> 'status', 'reserved', 'order B reserved');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select ok((api.cancel_order('71000000-0000-0000-0000-00000000000b', 'clinic closed') ->> 'approval_request_id') is not null,
  'cancelling a reserved order raises an approval request');
select is((select status from api.v_orders where id = '71000000-0000-0000-0000-00000000000b'), 'reserved', 'order stays reserved until decided');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a8');
select throws_like($$select api.post_fulfillment('71000000-0000-0000-0000-00000000000b', 'ful-B')$$,
  'CANCEL_PENDING%', 'fulfilment is blocked while a cancellation is pending');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a3');
select throws_like($$select api.decide_approval((select r.id from wf.approval_requests r join wf.workflow_definitions d on d.id = r.definition_id
                                                where d.code = 'sales.order.cancel' and r.entity_id = '71000000-0000-0000-0000-00000000000b'), 'approve')$$,
  'PERMISSION_DENIED%', 'area manager cannot decide cancellations');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a2');
select is(api.decide_approval((select r.id from wf.approval_requests r join wf.workflow_definitions d on d.id = r.definition_id
                               where d.code = 'sales.order.cancel' and r.entity_id = '71000000-0000-0000-0000-00000000000b'), 'approve') ->> 'status',
  'approved', 'sales director approves the cancellation');
select tests.clear_authentication();
select is((select status from sales.orders where id = '71000000-0000-0000-0000-00000000000b'), 'cancelled', 'hook cancelled order B');
select is((select string_agg(r.status, ',') from inventory.reservations r join sales.order_items oi on oi.id = r.order_item_id
           where oi.order_id = '71000000-0000-0000-0000-00000000000b'), 'released', 'reservation released');
select is((select reserved from inventory.stock_balances where lot_id = '61000000-0000-0000-0000-000000000001'), 0, 'reserved stock returned to available');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select api.save_order_draft('71000000-0000-0000-0000-000000000010', '40000000-0000-0000-0000-000000000001',
  '[{"variant_id":"53000000-0000-0000-0000-000000000001","quantity":1}]');
select is(api.cancel_order('71000000-0000-0000-0000-000000000010', 'duplicate') ->> 'status', 'cancelled', 'rep cancels own draft directly');
select api.save_order_draft('71000000-0000-0000-0000-000000000011', '40000000-0000-0000-0000-000000000001',
  '[{"variant_id":"53000000-0000-0000-0000-000000000001","quantity":1}]');
select api.submit_order('71000000-0000-0000-0000-000000000011');
select throws_like($$select api.cancel_order('71000000-0000-0000-0000-000000000011', 'oops')$$, 'PERMISSION_DENIED%',
  'rep cannot cancel a submitted order');
select api.save_order_draft('71000000-0000-0000-0000-000000000012', '40000000-0000-0000-0000-000000000001',
  '[{"variant_id":"53000000-0000-0000-0000-000000000001","quantity":1}]');
select api.submit_order('71000000-0000-0000-0000-000000000012');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a2');
select is(api.cancel_order('71000000-0000-0000-0000-000000000011', 'customer request') ->> 'status', 'cancelled', 'sales director cancels a submitted order');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a3');
select throws_like($$select api.reject_order('71000000-0000-0000-0000-000000000012', ' ')$$, 'REASON_REQUIRED%', 'rejection needs a reason');
select is(api.reject_order('71000000-0000-0000-0000-000000000012', 'wrong customer') ->> 'status', 'rejected', 'area manager rejects a submitted order');

-- Self-approval of an order one raised oneself
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a2');
select api.save_order_draft('71000000-0000-0000-0000-000000000013', '40000000-0000-0000-0000-000000000001',
  '[{"variant_id":"53000000-0000-0000-0000-000000000001","quantity":1}]');
select api.submit_order('71000000-0000-0000-0000-000000000013');
select throws_like($$select api.approve_order('71000000-0000-0000-0000-000000000013')$$, 'SELF_APPROVAL%',
  'nobody accepts an order they raised');

-- ---------------------------------------------------------------------------
-- Credit limit (D-09): C-0001 limit 5,000, AR balance 3,000
-- ---------------------------------------------------------------------------
select tests.clear_authentication();
update crm.customers set credit_limit = 5000 where id = '40000000-0000-0000-0000-000000000001';
insert into finance.customer_ledger (customer_id, entry_type, amount, source_table, source_id)
values ('40000000-0000-0000-0000-000000000001', 'opening_balance', 3000, 'import', '7f000000-0000-0000-0000-000000000001');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select api.save_order_draft('71000000-0000-0000-0000-000000000020', '40000000-0000-0000-0000-000000000001',
  '[{"variant_id":"53000000-0000-0000-0000-000000000001","quantity":2}]');
select api.save_order_draft('71000000-0000-0000-0000-000000000021', '40000000-0000-0000-0000-000000000001',
  '[{"variant_id":"53000000-0000-0000-0000-000000000001","quantity":1}]');
select api.save_order_draft('71000000-0000-0000-0000-000000000022', '40000000-0000-0000-0000-000000000001',
  '[{"variant_id":"53000000-0000-0000-0000-000000000001","quantity":2,"requested_discount_pct":8}]');
select is(api.submit_order('71000000-0000-0000-0000-000000000020') ->> 'status', 'pending_approval',
  '3,000 + 2,280 > 5,000 routes to approval');
select is(api.submit_order('71000000-0000-0000-0000-000000000021') ->> 'status', 'submitted', '3,000 + 1,140 within the limit is submitted');
select is(api.submit_order('71000000-0000-0000-0000-000000000022') -> 'reasons', '["discount above limit", "credit limit"]'::jsonb,
  'credit and discount reasons are both recorded');
select tests.clear_authentication();
select is((select reason from sales.order_status_history where order_id = '71000000-0000-0000-0000-000000000020' and to_status = 'pending_approval'),
  'credit limit', 'history records the credit-limit reason');
select is((select (payload ->> 'balance')::numeric || '/' || (payload ->> 'credit_limit')::numeric || '/' || (payload ->> 'credit_excess')::numeric
           || '/' || (payload -> 'limit_metrics' ->> 'wf.decide.credit_limit')::numeric
           from wf.approval_requests where entity_id = '71000000-0000-0000-0000-000000000020'),
  '3000.00/5000.00/280.00/280.00', 'payload carries balance, limit, excess and the per-permission limit metric');
select is((select r.priority from wf.approval_requests a join wf.workflow_rules r on r.id = a.rule_id
           where a.entity_id = '71000000-0000-0000-0000-000000000020'), 50, 'credit-only rule selected');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a3');
select throws_like($$select api.decide_approval((select id from wf.approval_requests where entity_id = '71000000-0000-0000-0000-000000000020'), 'approve')$$,
  'PERMISSION_DENIED%', 'area manager cannot approve a credit-limit breach');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select is(api.decide_approval((select id from wf.approval_requests where entity_id = '71000000-0000-0000-0000-000000000020'), 'approve') ->> 'status',
  'approved', 'finance (wf.decide.credit_limit) approves it');
select is(api.decide_approval((select id from wf.approval_requests where entity_id = '71000000-0000-0000-0000-000000000022'), 'approve') ->> 'current_stage',
  '2', 'credit + discount: finance first, then the discount stage');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a3');
select is(api.decide_approval((select id from wf.approval_requests where entity_id = '71000000-0000-0000-0000-000000000022'), 'approve') ->> 'status',
  'approved', 'area manager completes the discount stage (8% within 10%)');
select tests.clear_authentication();
select is((select string_agg(status, ',' order by id) from sales.orders
           where id in ('71000000-0000-0000-0000-000000000020','71000000-0000-0000-0000-000000000022')),
  'approved,approved', 'both credit-routed orders approved by their hooks');

-- ---------------------------------------------------------------------------
-- Invariants
-- ---------------------------------------------------------------------------
select is((select count(*)::int from inventory.stock_balances b
           where b.on_hand <> (select coalesce(sum(m.quantity), 0) from inventory.movements m
                               where m.warehouse_id = b.warehouse_id and m.variant_id = b.variant_id and m.lot_id = b.lot_id)),
  0, 'invariant: every balance equals the sum of its movements');
select is((select count(*)::int from inventory.stock_balances b
           where b.reserved < 0 or b.reserved > greatest(b.on_hand, 0)
              or b.reserved <> (select coalesce(sum(r.quantity), 0) from inventory.reservations r
                                where r.status = 'active' and r.warehouse_id = b.warehouse_id
                                  and r.variant_id = b.variant_id and r.lot_id = b.lot_id)),
  0, 'invariant: 0 ≤ reserved ≤ on_hand and reserved = Σ active reservations');

select * from finish();
rollback;
