-- Customer returns (20261103000200_returns.sql, 20261103000299_dispatch.sql): request with the
-- 'sales.return' approval, scope, no over-return, receipt into quarantine only, the stock invariant,
-- returned stock not sellable until released (D-13), credit notes at the invoiced prices with VAT,
-- idempotent replays.
--   users: a2 sales director · a3 area mgr Cairo · a4 rep Cairo (customer 4…01) · a5 rep Delta (4…02)
--          · a6 finance officer · a8 inventory manager
begin;
select tests.load_fixture();
select plan(92);
set constraints all immediate;

-- ---------------------------------------------------------------------------
-- Setup
--   WH-CAI main (fixture), WH-RQ quarantine (synthetic)
--   Order A  C-0001, rep a4: 3 × 1000, 2% → 3000 − 60 + 14% × 2940 = 3351.60; fulfilled and invoiced
--   Order B  C-0001, rep a4: 2 × 1000, fulfilled, NOT invoiced
-- ---------------------------------------------------------------------------
insert into inventory.movements (movement_type, warehouse_id, variant_id, lot_id, quantity, source_doc_type) values
  ('receipt','60000000-0000-0000-0000-000000000001','53000000-0000-0000-0000-000000000001','61000000-0000-0000-0000-000000000001', 10, 'receipt');
insert into inventory.warehouses (id, code, name, kind) values
  ('60000000-0000-0000-0000-000000000035', 'WH-RQ', 'Synthetic returns quarantine', 'quarantine');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select api.save_order_draft('f3500000-0000-0000-0000-00000000000a', '40000000-0000-0000-0000-000000000001',
  '[{"variant_id":"53000000-0000-0000-0000-000000000001","quantity":3,"requested_discount_pct":2}]');
select api.submit_order('f3500000-0000-0000-0000-00000000000a');
select api.save_order_draft('f3500000-0000-0000-0000-00000000000b', '40000000-0000-0000-0000-000000000001',
  '[{"variant_id":"53000000-0000-0000-0000-000000000001","quantity":2}]');
select api.submit_order('f3500000-0000-0000-0000-00000000000b');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a3');
select api.approve_order('f3500000-0000-0000-0000-00000000000a');
select api.approve_order('f3500000-0000-0000-0000-00000000000b');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a8');
select api.reserve_order('f3500000-0000-0000-0000-00000000000a', '60000000-0000-0000-0000-000000000001');
select api.post_fulfillment('f3500000-0000-0000-0000-00000000000a', 'ful-ret-A');
select api.reserve_order('f3500000-0000-0000-0000-00000000000b', '60000000-0000-0000-0000-000000000001');
select api.post_fulfillment('f3500000-0000-0000-0000-00000000000b', 'ful-ret-B');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select api.issue_invoice('f3500000-0000-0000-0000-00000000000a', 'inv-ret-A');
select tests.clear_authentication();

create temp table t_ids (k text primary key, id uuid);
grant select, insert on t_ids to authenticated;
insert into t_ids select 'itemA', id from sales.order_items where order_id = 'f3500000-0000-0000-0000-00000000000a';
insert into t_ids select 'itemB', id from sales.order_items where order_id = 'f3500000-0000-0000-0000-00000000000b';
insert into t_ids select 'invA', id from finance.invoices where order_id = 'f3500000-0000-0000-0000-00000000000a';

select is((select status from sales.orders where id = 'f3500000-0000-0000-0000-00000000000a') || '/' ||
          (select status from sales.orders where id = 'f3500000-0000-0000-0000-00000000000b'),
  'invoiced/fulfilled', 'setup: order A invoiced, order B fulfilled but not invoiced');

-- ===========================================================================
-- Catalogue and privileges
-- ===========================================================================
select is((select string_agg(code || ':' || is_sensitive, ',' order by code) from authz.permissions
           where code in ('sales.return.request','sales.return.receive','sales.return.credit')),
  'sales.return.credit:true,sales.return.receive:false,sales.return.request:false',
  'the three return permissions are in the catalogue (credit is sensitive)');
select is((select string_agg(r.code || ':' || rp.permission_code || ':' || rp.scope, ',' order by r.code)
           from authz.role_permissions rp join authz.roles r on r.id = rp.role_id
           where rp.permission_code in ('sales.return.request','sales.return.receive','sales.return.credit')),
  'area_manager:sales.return.request:team,finance_officer:sales.return.credit:all,inventory_manager:sales.return.receive:all,'
  || 'sales_director:sales.return.request:all,sales_rep:sales.return.request:own',
  'reps request (own), managers request (team/all), inventory receives, finance credits');
select ok(has_function_privilege('authenticated', 'api.request_return(uuid, jsonb, text, uuid)', 'execute')
          and has_function_privilege('authenticated', 'api.receive_return(uuid, uuid, text)', 'execute')
          and has_function_privilege('authenticated', 'api.credit_return(uuid, text)', 'execute'),
  'the three commands are callable by signed-in users');
select ok(not has_function_privilege('anon', 'api.request_return(uuid, jsonb, text, uuid)', 'execute')
          and not has_function_privilege('anon', 'api.receive_return(uuid, uuid, text)', 'execute')
          and not has_function_privilege('anon', 'api.credit_return(uuid, text)', 'execute'),
  'anon cannot call them');
select ok(not has_function_privilege('authenticated', 'wf.on_decided_sales_return(uuid, boolean)', 'execute')
          and not has_function_privilege('anon', 'wf.on_decided_sales_return(uuid, boolean)', 'execute'),
  'the decision hook is not client-callable');
select is((select count(*)::int from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'api' and c.relname in ('v_returns','v_return_lines','v_returnable_lines')
             and 'security_invoker=true' = any(c.reloptions)), 3, 'the three return views are security_invoker');

-- ===========================================================================
-- Scope, permissions and validation
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a5');
select throws_ok($$select api.request_return('f3500000-0000-0000-0000-00000000000a',
  ('[{"order_item_id":"' || (select id from t_ids where k = 'itemA') || '","quantity":1,"reason_code":"damaged"}]')::jsonb,
  null, 'c3500000-0000-0000-0000-000000000099')$$, '42501', 'PERMISSION_DENIED: customer not in your scope',
  'a rep cannot request a return for another rep''s customer');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select throws_ok($$select api.request_return('f3500000-0000-0000-0000-00000000000a', '[]', null, 'c3500000-0000-0000-0000-000000000099')$$,
  '42501', 'PERMISSION_DENIED: sales.return.request', 'finance cannot request returns');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a8');
select throws_ok($$select api.request_return('f3500000-0000-0000-0000-00000000000a', '[]', null, 'c3500000-0000-0000-0000-000000000099')$$,
  '42501', 'PERMISSION_DENIED: sales.return.request', 'inventory cannot request returns');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select throws_like($$select api.request_return('f3500000-0000-0000-0000-00000000000a',
  ('[{"order_item_id":"' || (select id from t_ids where k = 'itemA') || '","quantity":1,"reason_code":"damaged"}]')::jsonb, null, null)$$,
  'VALIDATION: client reference%', 'a client reference is required');
select throws_like($$select api.request_return('f3500000-0000-0000-0000-00000000000a', '[]', null, 'c3500000-0000-0000-0000-000000000099')$$,
  'VALIDATION: lines%', 'at least one line');
select throws_like($$select api.request_return('f3500000-0000-0000-0000-00000000000a',
  ('[{"order_item_id":"' || (select id from t_ids where k = 'itemA') || '","quantity":1,"reason_code":"damaged","unit_price":1}]')::jsonb,
  null, 'c3500000-0000-0000-0000-000000000099')$$,
  'VALIDATION: line 1 may only contain%', 'a line cannot carry a price or any other key');
select throws_like($$select api.request_return('f3500000-0000-0000-0000-00000000000a',
  ('[{"order_item_id":"' || (select id from t_ids where k = 'itemA') || '","quantity":1,"reason_code":"bored"}]')::jsonb,
  null, 'c3500000-0000-0000-0000-000000000099')$$,
  'VALIDATION: line 1 has no valid reason_code%', 'reason codes come from the list');
select throws_like($$select api.request_return('f3500000-0000-0000-0000-00000000000a',
  ('[{"order_item_id":"' || (select id from t_ids where k = 'itemA') || '","quantity":1,"reason_code":"other"}]')::jsonb,
  null, 'c3500000-0000-0000-0000-000000000099')$$,
  'REASON_REQUIRED%', 'reason "other" needs notes');
select throws_like($$select api.request_return('f3500000-0000-0000-0000-00000000000a',
  ('[{"order_item_id":"' || (select id from t_ids where k = 'itemB') || '","quantity":1,"reason_code":"damaged"}]')::jsonb,
  null, 'c3500000-0000-0000-0000-000000000099')$$,
  'VALIDATION: line 1 is not a line of this order%', 'a line of another order is refused');
select throws_like($$select api.request_return('f3500000-0000-0000-0000-00000000000a',
  ('[{"order_item_id":"' || (select id from t_ids where k = 'itemA') || '","quantity":1.5,"reason_code":"damaged"}]')::jsonb,
  null, 'c3500000-0000-0000-0000-000000000099')$$,
  'VALIDATION: line 1 needs a whole positive quantity%', 'quantities are whole units');
select throws_like($$select api.request_return('f3500000-0000-0000-0000-00000000000a',
  ('[{"order_item_id":"' || (select id from t_ids where k = 'itemA') || '","lot_id":"61000000-0000-0000-0000-0000000000ff","quantity":1,"reason_code":"damaged"}]')::jsonb,
  null, 'c3500000-0000-0000-0000-000000000099')$$,
  'VALIDATION: line 1: that lot was not delivered%', 'only a delivered lot can come back');
select throws_like($$select api.request_return('f3500000-0000-0000-0000-00000000000a',
  ('[{"order_item_id":"' || (select id from t_ids where k = 'itemA') || '","quantity":4,"reason_code":"damaged"}]')::jsonb,
  null, 'c3500000-0000-0000-0000-000000000099')$$,
  'QTY_EXCEEDS_RETURNABLE%', 'no over-return: 4 of 3 delivered');
select throws_like($$select api.request_return('f3500000-0000-0000-0000-00000000000b',
  ('[{"order_item_id":"' || (select id from t_ids where k = 'itemB') || '","quantity":1,"reason_code":"damaged"}]')::jsonb,
  null, 'c3500000-0000-0000-0000-000000000099')$$,
  'QTY_EXCEEDS_RETURNABLE%', 'interim rule: goods delivered but not yet invoiced cannot be returned');
select is((select (delivered_qty, invoiced_qty, returned_qty, returnable_qty, lot_no)::text from api.v_returnable_lines
           where order_id = 'f3500000-0000-0000-0000-00000000000a'), '(3,3,0,3,L2026A)',
  'the rep sees 3 returnable units of lot L2026A on order A');
select is((select returnable_qty from api.v_returnable_lines where order_id = 'f3500000-0000-0000-0000-00000000000b'), 0,
  'and none on the uninvoiced order B');
select is((select count(*)::int from sales.returns), 0, 'refused requests left nothing behind');

-- ===========================================================================
-- Request R1 (2 units) with approval
-- ===========================================================================
insert into t_ids select 'R1', (api.request_return('f3500000-0000-0000-0000-00000000000a',
  ('[{"order_item_id":"' || (select id from t_ids where k = 'itemA') || '","quantity":2,"reason_code":"damaged"}]')::jsonb,
  'Synthetic: box crushed in transit', 'c3500000-0000-0000-0000-000000000001') ->> 'return_id')::uuid;
select is((select status from api.v_returns where id = (select id from t_ids where k = 'R1')), 'pending_approval',
  'a return request waits for approval');
select is((api.request_return('f3500000-0000-0000-0000-00000000000a',
  ('[{"order_item_id":"' || (select id from t_ids where k = 'itemA') || '","quantity":2,"reason_code":"damaged"}]')::jsonb,
  null, 'c3500000-0000-0000-0000-000000000001') ->> 'replayed')::boolean, true, 'a replay with the same client_ref is a replay');
select is((select count(*)::int from api.v_returns), 1, 'the replay created nothing new');
select throws_like($$select api.request_return('f3500000-0000-0000-0000-00000000000b',
  ('[{"order_item_id":"' || (select id from t_ids where k = 'itemB') || '","quantity":1,"reason_code":"damaged"}]')::jsonb,
  null, 'c3500000-0000-0000-0000-000000000001')$$, 'IDEMPOTENCY_CONFLICT%', 'the same client_ref for another order is refused');
select throws_like($$select api.request_return('f3500000-0000-0000-0000-00000000000a',
  ('[{"order_item_id":"' || (select id from t_ids where k = 'itemA') || '","quantity":2,"reason_code":"wrong_item"}]')::jsonb,
  null, 'c3500000-0000-0000-0000-000000000098')$$, 'QTY_EXCEEDS_RETURNABLE%', 'a pending request holds its quantity');
insert into t_ids select 'R2', (api.request_return('f3500000-0000-0000-0000-00000000000a',
  ('[{"order_item_id":"' || (select id from t_ids where k = 'itemA') || '","quantity":1,"reason_code":"customer_request"}]')::jsonb,
  null, 'c3500000-0000-0000-0000-000000000002') ->> 'return_id')::uuid;
select is((select returnable_qty from api.v_returnable_lines where order_id = 'f3500000-0000-0000-0000-00000000000a'), 0,
  'two requests (2 + 1) use up the 3 delivered units');
select tests.clear_authentication();

select is((select return_no from sales.returns where id = (select id from t_ids where k = 'R1')),
  'RET-' || extract(year from core.business_date()) || '-000001', 'returns are numbered RET-YYYY-NNNNNN');
select is((select (ri.quantity, ri.reason_code, ri.condition, ri.lot_id)::text from sales.return_items ri
           where ri.return_id = (select id from t_ids where k = 'R1')),
  '(2,damaged,damaged,61000000-0000-0000-0000-000000000001)', 'the line keeps its lot (defaulted: one lot delivered), reason and condition');
select is((select d.code || ':' || r.status || ':' || r.subject_employee_id || ':' || (r.payload ->> 'total')
           from wf.approval_requests r join wf.workflow_definitions d on d.id = r.definition_id
           where r.entity_id = (select id from t_ids where k = 'R1')),
  'sales.return:pending:20000000-0000-0000-0000-000000000004:2234.40',
  'the request goes to the sales.return workflow about the order''s rep, with the estimated credit');
select is((select approval_request_id from sales.returns where id = (select id from t_ids where k = 'R1')),
  (select id from wf.approval_requests where entity_id = (select id from t_ids where k = 'R1')), 'the return links its approval request');
select is((select count(*)::int from integration.outbox where event_type = 'return.requested'), 2, 'return.requested emitted per request');

-- Approval: requester cannot decide; area manager is no approver; sales director decides.
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select throws_like($$select api.decide_approval((select approval_request_id from sales.returns where id = (select id from t_ids where k = 'R1')), 'approve')$$,
  'SELF_APPROVAL%', 'the requester cannot approve their own return');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a3');
select throws_like($$select api.decide_approval((select approval_request_id from sales.returns where id = (select id from t_ids where k = 'R1')), 'approve')$$,
  'PERMISSION_DENIED%', 'an area manager without wf.decide.return cannot approve');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a2');
select api.decide_approval((select approval_request_id from sales.returns where id = (select id from t_ids where k = 'R2')), 'reject', 'synthetic: not eligible');
select api.decide_approval((select approval_request_id from sales.returns where id = (select id from t_ids where k = 'R1')), 'approve');
select tests.clear_authentication();
select is((select status from sales.returns where id = (select id from t_ids where k = 'R2')), 'rejected', 'a rejected request is closed');
select is((select status || ':' || (decided_at is not null) from sales.returns where id = (select id from t_ids where k = 'R1')),
  'approved:true', 'the approved return is ready to receive');
select is((select returnable_qty from api.v_returnable_lines where order_id = 'f3500000-0000-0000-0000-00000000000a'), 1,
  'a rejected request frees its quantity');
select is((select count(*)::int from notify.notifications where recipient_user_id = '00000000-0000-0000-0000-0000000000a4'
           and type in ('return.approved','return.rejected')), 2, 'the rep is told about both decisions');

-- ===========================================================================
-- Receive into quarantine only
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select throws_ok($$select api.receive_return((select id from t_ids where k = 'R1'), '60000000-0000-0000-0000-000000000035', 'rcv-x')$$,
  '42501', 'PERMISSION_DENIED: sales.return.receive', 'a rep cannot receive returned goods');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a8');
select throws_like($$select api.receive_return((select id from t_ids where k = 'R1'), '60000000-0000-0000-0000-000000000035', ' ')$$,
  'VALIDATION%', 'an idempotency key is required');
select throws_like($$select api.receive_return((select id from t_ids where k = 'R2'), '60000000-0000-0000-0000-000000000035', 'rcv-2')$$,
  'INVALID_STATE%', 'a rejected return cannot be received');
select throws_like($$select api.receive_return((select id from t_ids where k = 'R1'), '60000000-0000-0000-0000-000000000001', 'rcv-1')$$,
  'WAREHOUSE_NOT_QUARANTINE%', 'returned goods never go straight into a sellable warehouse');
select is((api.receive_return((select id from t_ids where k = 'R1'), '60000000-0000-0000-0000-000000000035', 'rcv-1') ->> 'status'),
  'received', 'inventory receives the return into quarantine');
select is((api.receive_return((select id from t_ids where k = 'R1'), '60000000-0000-0000-0000-000000000035', 'rcv-1') ->> 'replayed')::boolean,
  true, 'a replay with the same key changes nothing');
select tests.clear_authentication();

select is((select count(*)::int || ':' || sum(quantity) from inventory.movements
           where source_doc_type = 'return' and source_doc_id = (select id from t_ids where k = 'R1')
             and movement_type = 'sale_return' and warehouse_id = '60000000-0000-0000-0000-000000000035'
             and lot_id = '61000000-0000-0000-0000-000000000001'),
  '1:2', 'one sale_return movement of +2 into the quarantine warehouse, same lot');
select is((select on_hand from inventory.stock_balances where warehouse_id = '60000000-0000-0000-0000-000000000035'), 2,
  'quarantine holds the 2 returned units');
select is((select l.expiry_date from inventory.stock_balances b join inventory.lots l on l.id = b.lot_id
           where b.warehouse_id = '60000000-0000-0000-0000-000000000035'), '2030-12-31'::date, 'lot and expiry are kept');
select is((select returned_qty from sales.order_items where id = (select id from t_ids where k = 'itemA')), 2,
  'the order line counts the returned units');
select is((select status from sales.orders where id = 'f3500000-0000-0000-0000-00000000000a'), 'invoiced',
  'a partial return leaves the order invoiced');
select is((select count(*)::int from inventory.stock_balances b
           where b.on_hand <> (select coalesce(sum(m.quantity), 0) from inventory.movements m
                               where m.warehouse_id = b.warehouse_id and m.variant_id = b.variant_id and m.lot_id = b.lot_id)), 0,
  'stock invariant: every balance equals the sum of its movements');
select is((select count(*)::int from inventory.movements m join inventory.warehouses w on w.id = m.warehouse_id
           where m.source_doc_type = 'return' and w.kind <> 'quarantine'), 0, 'no return movement lands outside quarantine');
select is((select count(*)::int from integration.outbox where event_type = 'return.received'), 1, 'return.received emitted once');

-- ===========================================================================
-- Returned stock is not sellable until released (audit rule (a), D-13)
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is((select count(*)::int from api.v_stock_available where warehouse_id = '60000000-0000-0000-0000-000000000035'), 0,
  'quarantine stock is not offered to reps');
select tests.clear_authentication();
select throws_like($$insert into inventory.reservations (order_item_id, warehouse_id, variant_id, lot_id, quantity)
  values ((select id from t_ids where k = 'itemB'), '60000000-0000-0000-0000-000000000035',
          '53000000-0000-0000-0000-000000000001', '61000000-0000-0000-0000-000000000001', 1)$$,
  'WAREHOUSE_NOT_SELLABLE%', 'quarantine stock cannot be reserved');
select throws_like($$insert into inventory.movements (movement_type, warehouse_id, variant_id, lot_id, quantity, source_doc_type)
  values ('sale_issue', '60000000-0000-0000-0000-000000000035', '53000000-0000-0000-0000-000000000001',
          '61000000-0000-0000-0000-000000000001', -1, 'fulfillment')$$,
  'WAREHOUSE_NOT_SELLABLE%', 'quarantine stock cannot be sold');
insert into authz.role_permissions (role_id, permission_code, scope)
select id, 'inventory.transfer.create', 'all' from authz.roles where code = 'area_manager';
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a3');
select throws_ok($$select api.create_transfer('60000000-0000-0000-0000-000000000035', '60000000-0000-0000-0000-000000000001',
  '[{"variant_id":"53000000-0000-0000-0000-000000000001","lot_id":"61000000-0000-0000-0000-000000000001","quantity":2}]')$$,
  '42501', 'PERMISSION_DENIED: moving stock out of quarantine needs inventory.quarantine.release',
  'moving returned stock back to sellable needs inventory.quarantine.release');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a8');
select lives_ok($$select api.create_transfer('60000000-0000-0000-0000-000000000035', '60000000-0000-0000-0000-000000000001',
  '[{"variant_id":"53000000-0000-0000-0000-000000000001","lot_id":"61000000-0000-0000-0000-000000000001","quantity":2}]')$$,
  'the inventory manager may release it (D-13)');
select tests.clear_authentication();

-- ===========================================================================
-- Credit at the invoiced prices, with VAT
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select throws_ok($$select api.credit_return((select id from t_ids where k = 'R1'), 'crd-x')$$,
  '42501', 'PERMISSION_DENIED: sales.return.credit', 'a rep cannot credit a return');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a8');
select throws_ok($$select api.credit_return((select id from t_ids where k = 'R1'), 'crd-x')$$,
  '42501', 'PERMISSION_DENIED: sales.return.credit', 'inventory cannot credit a return');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select throws_like($$select api.credit_return((select id from t_ids where k = 'R2'), 'crd-2')$$,
  'INVALID_STATE%', 'only a received return is credited');
select is((api.credit_return((select id from t_ids where k = 'R1'), 'crd-1') ->> 'total')::numeric, 2234.40::numeric,
  'R1 credit = 2 of 3 units: 2940 × 2/3 = 1960.00 + 14% VAT 274.40');
select is((api.credit_return((select id from t_ids where k = 'R1'), 'crd-1') ->> 'replayed')::boolean, true,
  'a replay with the same key returns the first credit');
select throws_like($$select api.credit_return((select id from t_ids where k = 'R1'), 'crd-1b')$$,
  'INVALID_STATE%', 'a return is credited once');
select tests.clear_authentication();

select is((select (amount, tax_amount, invoice_id, credit_no like 'CN-%')::text from finance.credit_notes
           where return_id = (select id from t_ids where k = 'R1')),
  '(1960.00,274.40,' || (select id from t_ids where k = 'invA') || ',t)', 'one credit note on invoice A, linked by return_id');
select is((select string_agg(ci.quantity || '@' || ci.amount || '+' || ci.tax_amount, ',') from finance.credit_note_items ci
           join finance.credit_notes cn on cn.id = ci.credit_note_id where cn.return_id = (select id from t_ids where k = 'R1')),
  '2@1960.00+274.40', 'the credit note has the returned quantity as a line');
select is((select amount::numeric from finance.customer_ledger where entry_type = 'credit_note'
           and source_id = (select id from finance.credit_notes where return_id = (select id from t_ids where k = 'R1'))),
  -2234.40::numeric, 'the credit posts to the AR ledger once, negative');
select is((select (status, open_amount)::text from api.v_invoices where id = (select id from t_ids where k = 'invA')),
  '(issued,1117.20)', 'invoice A has 1117.20 left open');
select is((select status || ':' || (select sum(credited_qty) from sales.return_items where return_id = r.id)
           from sales.returns r where r.id = (select id from t_ids where k = 'R1')), 'credited:2', 'R1 is credited');
select is((select count(*)::int from finance.credit_notes where return_id = (select id from t_ids where k = 'R1')), 1,
  'the replay issued nothing more');
select is((select (payload ->> 'return_id')::uuid from integration.outbox where event_type = 'credit_note.issued'),
  (select id from t_ids where k = 'R1'), 'credit_note.issued names the return');
select is((select count(*)::int from integration.outbox where event_type = 'return.credited'), 1, 'return.credited emitted once');

-- ===========================================================================
-- The last unit: full return → order 'returned', Σ credits = the invoice to the cent
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
insert into t_ids select 'R3', (api.request_return('f3500000-0000-0000-0000-00000000000a',
  ('[{"order_item_id":"' || (select id from t_ids where k = 'itemA') || '","lot_id":"61000000-0000-0000-0000-000000000001","quantity":1,"reason_code":"near_expiry"}]')::jsonb,
  null, 'c3500000-0000-0000-0000-000000000003') ->> 'return_id')::uuid;
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a2');
select api.decide_approval((select approval_request_id from sales.returns where id = (select id from t_ids where k = 'R3')), 'approve');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a8');
select throws_like($$select api.receive_return((select id from t_ids where k = 'R3'), '60000000-0000-0000-0000-000000000035', 'rcv-1')$$,
  'IDEMPOTENCY_CONFLICT%', 'a receive key used for another return is refused');
select is((api.receive_return((select id from t_ids where k = 'R3'), '60000000-0000-0000-0000-000000000035', 'rcv-3') ->> 'order_status'),
  'returned', 'everything delivered came back: the order moves to returned');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select is((api.credit_return((select id from t_ids where k = 'R3'), 'crd-3') ->> 'total')::numeric, 1117.20::numeric,
  'the last unit takes the exact remainder: 980.00 + 137.20 VAT');
select tests.clear_authentication();
select is((select sum(amount + tax_amount) from finance.credit_notes where invoice_id = (select id from t_ids where k = 'invA')),
  (select total::numeric from finance.invoices where id = (select id from t_ids where k = 'invA')), 'Σ credit notes = the invoice total');
select is((select sum(tax_amount) from finance.credit_notes where invoice_id = (select id from t_ids where k = 'invA')),
  (select tax_total::numeric from finance.invoices where id = (select id from t_ids where k = 'invA')), 'Σ credited VAT = the invoice VAT');
select is((select status from finance.invoices where id = (select id from t_ids where k = 'invA')), 'credited',
  'a fully credited invoice is credited');
select is((select to_status || ':' || reason from sales.order_status_history
           where order_id = 'f3500000-0000-0000-0000-00000000000a' order by id desc limit 1),
  'returned:' || (select return_no from sales.returns where id = (select id from t_ids where k = 'R3')),
  'the order history names the return');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select throws_like($$select api.request_return('f3500000-0000-0000-0000-00000000000a',
  ('[{"order_item_id":"' || (select id from t_ids where k = 'itemA') || '","quantity":1,"reason_code":"damaged"}]')::jsonb,
  null, 'c3500000-0000-0000-0000-000000000004')$$, 'INVALID_STATE%', 'a returned order takes no more returns');

-- ===========================================================================
-- Views and visibility
-- ===========================================================================
select is((select count(*)::int from api.v_returns), 3, 'the rep sees the returns of his order');
select is((select (status, warehouse_code, credit_notes, credited_total, total_qty, estimated_total)::text from api.v_returns
           where id = (select id from t_ids where k = 'R1')),
  '(credited,WH-RQ,1,2234.40,2,2234.40)', 'v_returns shows status, warehouse, credit and quantities');
select is((select (quantity, credited_qty, lot_no, reason_code)::text from api.v_return_lines
           where return_id = (select id from t_ids where k = 'R1')), '(2,2,L2026A,damaged)', 'v_return_lines shows the line');
select is((select count(*)::int from api.v_credit_notes where return_id is not null), 2, 'the rep sees both return credit notes');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a5');
select is((select count(*)::int from api.v_returns), 0, 'another rep sees none');
select is((select count(*)::int from api.v_return_lines), 0, 'nor their lines');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a8');
select is((select count(*)::int from api.v_returns), 3, 'inventory sees every return');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select is((select count(*)::int from api.v_returns where status = 'credited'), 2, 'finance sees the credited returns');
select tests.authenticate_anon();
select throws_ok($$select count(*) from api.v_returns$$, '42501', null, 'anon cannot read returns');
select tests.clear_authentication();

-- ===========================================================================
-- Documents: audited, never deleted
-- ===========================================================================
select ok((select count(*) from audit.audit_log where table_schema = 'sales' and table_name = 'returns') >= 3,
  'returns are audited');
select throws_like($$delete from sales.returns where id = (select id from t_ids where k = 'R2')$$, '%', 'a return cannot be deleted');

select * from finish();
rollback;
