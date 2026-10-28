-- Orders: server-side pricing, discount authority → approval, ABAC, visibility by scope.
begin;
select tests.load_fixture();
select plan(13);

insert into sales.orders (id, customer_id, employee_id) values
  ('70000000-0000-0000-0000-000000000001','40000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000004'),
  ('70000000-0000-0000-0000-000000000002','40000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000004'),
  ('70000000-0000-0000-0000-000000000003','40000000-0000-0000-0000-000000000002','20000000-0000-0000-0000-000000000005');
-- Tampered client payload: list_price 1 EGP. The server must overwrite it.
insert into sales.order_items (order_id, line_no, variant_id, quantity, list_price, requested_discount_pct, tax_rate_pct, line_subtotal, line_discount, line_tax, line_total) values
  ('70000000-0000-0000-0000-000000000001', 1, '53000000-0000-0000-0000-000000000001', 2, 1, 2, 0, 0,0,0,0),
  ('70000000-0000-0000-0000-000000000002', 1, '53000000-0000-0000-0000-000000000001', 1, 1, 5, 0, 0,0,0,0),
  ('70000000-0000-0000-0000-000000000003', 1, '53000000-0000-0000-0000-000000000001', 1, 1, 0, 0, 0,0,0,0);

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is(api.submit_order('70000000-0000-0000-0000-000000000001') ->> 'status', 'submitted', 'order within the 3% limit is submitted');
select is((select total::numeric from sales.orders where id = '70000000-0000-0000-0000-000000000001'), 2234.40::numeric,
  'server price: 2 × 1000 − 2% (40) + 14% VAT on 1960 (274.40) = 2234.40; tampered price ignored');
select ok((select order_no from sales.orders where id = '70000000-0000-0000-0000-000000000001') ~ '^SO-[0-9]{4}-000001$', 'gapless document number assigned');
select is(api.submit_order('70000000-0000-0000-0000-000000000002') ->> 'status', 'pending_approval', 'order above the 3% limit routes to approval');
select throws_like($$select api.submit_order('70000000-0000-0000-0000-000000000003')$$, 'PERMISSION_DENIED%', 'rep cannot submit another rep''s order');
select throws_like($$select api.submit_order('70000000-0000-0000-0000-000000000001')$$, 'INVALID_STATE%', 'an order cannot be submitted twice');
select throws_like($$update sales.orders set total = 1 where id = '70000000-0000-0000-0000-000000000001'$$, '%permission denied%', 'rep cannot edit order totals directly');
select is((select count(*)::int from sales.orders), 2, 'rep sees only own orders');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a3');
select is((select count(*)::int from sales.orders), 2, 'area manager sees team orders (own rep), not Delta');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a2');
select is((select count(*)::int from sales.orders), 3, 'sales director sees all orders');
select tests.clear_authentication();

select is((select count(*)::int from wf.approval_requests where entity_id = '70000000-0000-0000-0000-000000000002' and status = 'pending'), 1, 'approval request created');
select is((select count(*)::int from integration.outbox where aggregate_id in ('70000000-0000-0000-0000-000000000001','70000000-0000-0000-0000-000000000002')), 2, 'outbox events written in the same transaction');
select is((select count(*)::int from sales.order_status_history where order_id = '70000000-0000-0000-0000-000000000002' and to_status = 'pending_approval'), 1, 'status history recorded');

select * from finish();
rollback;
