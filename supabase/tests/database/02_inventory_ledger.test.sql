-- Inventory: append-only ledger, derived balances, negative-stock policy, adjustment limits.
begin;
select tests.load_fixture();
select plan(13);

insert into inventory.movements (movement_type, warehouse_id, variant_id, lot_id, quantity, source_doc_type)
values ('receipt','60000000-0000-0000-0000-000000000001','53000000-0000-0000-0000-000000000001','61000000-0000-0000-0000-000000000001', 10, 'receipt');
select is((select on_hand from inventory.stock_balances), 10, 'receipt updates the derived balance');

select throws_like($$insert into inventory.movements (movement_type, warehouse_id, variant_id, lot_id, quantity)
  values ('adjustment_out','60000000-0000-0000-0000-000000000001','53000000-0000-0000-0000-000000000001','61000000-0000-0000-0000-000000000001', -15)$$,
  'INSUFFICIENT_STOCK%', 'negative stock is rejected');
select throws_like($$update inventory.movements set quantity = 999$$, 'APPEND_ONLY%', 'ledger rows cannot be edited');
select throws_like($$delete from inventory.movements$$, 'APPEND_ONLY%', 'ledger rows cannot be deleted');
select throws_like($$insert into inventory.movements (movement_type, warehouse_id, variant_id, lot_id, quantity)
  values ('receipt','60000000-0000-0000-0000-000000000001','53000000-0000-0000-0000-000000000001','61000000-0000-0000-0000-000000000001', -1)$$,
  '%violates check constraint%', 'movement sign must match its type');

-- Rep: no write path to stock
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select throws_like($$update inventory.stock_balances set on_hand = 1000$$, '%permission denied%', 'rep cannot write balances directly');
select throws_like($$select api.post_inventory_adjustment('60000000-0000-0000-0000-000000000001','53000000-0000-0000-0000-000000000001','61000000-0000-0000-0000-000000000001', 5, 'found', 'k1')$$,
  'PERMISSION_DENIED%', 'rep cannot post inventory adjustments');

-- Inventory manager: limit 5 units without approval
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a8');
select isnt(api.post_inventory_adjustment('60000000-0000-0000-0000-000000000001','53000000-0000-0000-0000-000000000001','61000000-0000-0000-0000-000000000001', -3, 'damaged in storage', 'adj-1'),
  null, 'inventory manager posts an adjustment within limit');
select is(api.post_inventory_adjustment('60000000-0000-0000-0000-000000000001','53000000-0000-0000-0000-000000000001','61000000-0000-0000-0000-000000000001', -3, 'damaged in storage', 'adj-1'),
  (select id from inventory.movements where idempotency_key = 'adj-1'), 'replaying the same idempotency key returns the same movement');
select throws_like($$select api.post_inventory_adjustment('60000000-0000-0000-0000-000000000001','53000000-0000-0000-0000-000000000001','61000000-0000-0000-0000-000000000001', -6, 'count', 'adj-2')$$,
  'APPROVAL_REQUIRED%', 'adjustment above the unit limit needs approval');
select throws_like($$select api.post_inventory_adjustment('60000000-0000-0000-0000-000000000001','53000000-0000-0000-0000-000000000001','61000000-0000-0000-0000-000000000001', 1, ' ', 'adj-3')$$,
  'REASON_REQUIRED%', 'adjustments need a reason');
select tests.clear_authentication();

select is((select on_hand from inventory.stock_balances), 7, 'balance reflects the single applied adjustment (10 − 3)');
select is((select count(*)::int from inventory.stock_balances b
           where b.on_hand <> (select coalesce(sum(m.quantity), 0) from inventory.movements m
                               where m.warehouse_id = b.warehouse_id and m.variant_id = b.variant_id and m.lot_id = b.lot_id)),
          0, 'invariant: every balance equals the sum of its movements');

select * from finish();
rollback;
