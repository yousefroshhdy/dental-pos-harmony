-- Offline order drafts (migration 20261103000300_orders_offline_drafts.sql): api.save_order_draft is
-- replay-safe under the key (order id, base version), so the device queue can re-send a save whose
-- answer was lost. Each "replay" block fails on the code before that migration (CONFLICT / INVALID_STATE).
begin;
select tests.load_fixture();
set constraints all immediate;
select plan(28);

-- Fixture: rep E004 = user a4 (Cairo, customer C001 in scope); area manager E003 = user a3 (team of E004);
-- rep E005 = user a5 (Delta); inventory manager a8 has no sales.order.create.
-- Variant 53…01 is sellable at 1000 EGP (14% VAT).

-- ===========================================================================
-- The idempotency record is not visible to clients
-- ===========================================================================
select ok((select relrowsecurity from pg_class where oid = 'sales.order_draft_saves'::regclass),
  'sales.order_draft_saves has RLS enabled');
select ok(not has_table_privilege('authenticated', 'sales.order_draft_saves', 'select')
          and not has_table_privilege('authenticated', 'sales.order_draft_saves', 'insert')
          and not has_table_privilege('anon', 'sales.order_draft_saves', 'select'),
  'clients have no privilege on sales.order_draft_saves');
select ok(not has_function_privilege('authenticated', 'sales.order_draft_answer(uuid, boolean, boolean)', 'execute')
          and not has_function_privilege('anon', 'sales.order_draft_answer(uuid, boolean, boolean)', 'execute'),
  'the internal answer helper is not client-callable');
select ok(has_function_privilege('authenticated', 'api.save_order_draft(uuid, uuid, jsonb, text, uuid, integer, uuid)', 'execute')
          and not has_function_privilege('anon', 'api.save_order_draft(uuid, uuid, jsonb, text, uuid, integer, uuid)', 'execute'),
  'api.save_order_draft stays callable by signed-in users only');

-- ===========================================================================
-- Creating call and its replay
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select set_config('t.create', api.save_order_draft('71000000-0000-0000-0000-0000000003a1', '40000000-0000-0000-0000-000000000001',
  '[{"variant_id":"53000000-0000-0000-0000-000000000001","quantity":2}]', 'offline draft')::text, true);
select is((current_setting('t.create')::jsonb ->> 'created')::boolean, true, 'first save creates the draft');
select is((current_setting('t.create')::jsonb ->> 'replayed')::boolean, false, 'first save is not a replay');
select is((current_setting('t.create')::jsonb ->> 'indicative_total')::numeric, 2280.00::numeric,
  'the server prices the draft (2 × 1000 + 14% VAT)');

select set_config('t.replay', api.save_order_draft('71000000-0000-0000-0000-0000000003a1', '40000000-0000-0000-0000-000000000001',
  '[{"variant_id":"53000000-0000-0000-0000-000000000001","quantity":2}]', 'offline draft')::text, true);
select is((current_setting('t.replay')::jsonb ->> 'replayed')::boolean, true, 'the same creating call again is a replay');
select is((current_setting('t.replay')::jsonb ->> 'version')::int, 1, 'a replay does not bump the version');
select is((current_setting('t.replay')::jsonb ->> 'indicative_total')::numeric, 2280.00::numeric, 'a replay answers the saved totals');

-- ===========================================================================
-- Edit (base version 1) and its replay: before the migration, CONFLICT
-- ===========================================================================
select is((api.save_order_draft('71000000-0000-0000-0000-0000000003a1', '40000000-0000-0000-0000-000000000001',
  '[{"variant_id":"53000000-0000-0000-0000-000000000001","quantity":3}]', 'offline draft', null, 1) ->> 'version')::int,
  2, 'an edit at the current version bumps it');
select set_config('t.edit_replay', api.save_order_draft('71000000-0000-0000-0000-0000000003a1', '40000000-0000-0000-0000-000000000001',
  '[{"variant_id":"53000000-0000-0000-0000-000000000001","quantity":3}]', 'offline draft', null, 1)::text, true);
select is((current_setting('t.edit_replay')::jsonb ->> 'replayed')::boolean, true,
  'replay of the applied edit (same base version, same request) answers replayed');
select is((current_setting('t.edit_replay')::jsonb ->> 'version')::int, 2, 'the replay answers the current version, not a new one');
select is((select version from sales.orders where id = '71000000-0000-0000-0000-0000000003a1'), 2, 'the replay changed nothing');
select is((select count(*)::int from sales.order_items where order_id = '71000000-0000-0000-0000-0000000003a1'), 1,
  'the replay did not duplicate lines');
select is((select count(*)::int from sales.order_status_history where order_id = '71000000-0000-0000-0000-0000000003a1'), 1,
  'one "draft created" history row however often the draft was replayed');

-- A different request under a used key is a real stale edit: CONFLICT with the current version.
select throws_like($$select api.save_order_draft('71000000-0000-0000-0000-0000000003a1', '40000000-0000-0000-0000-000000000001',
  '[{"variant_id":"53000000-0000-0000-0000-000000000001","quantity":9}]', 'offline draft', null, 1)$$,
  'CONFLICT: order changed (current version 2)%', 'different lines at an old version are still a version conflict');
select throws_like($$select api.save_order_draft('71000000-0000-0000-0000-0000000003a1', '40000000-0000-0000-0000-000000000001',
  '[{"variant_id":"53000000-0000-0000-0000-000000000001","quantity":3}]', 'other notes', null, 1)$$,
  'CONFLICT%', 'different notes at an old version are still a version conflict');

-- Late replay of the creating call after the edit: before the migration, CONFLICT.
select is((api.save_order_draft('71000000-0000-0000-0000-0000000003a1', '40000000-0000-0000-0000-000000000001',
  '[{"variant_id":"53000000-0000-0000-0000-000000000001","quantity":2}]', 'offline draft') ->> 'replayed')::boolean, true,
  'a late replay of the creating call is answered as a replay');
select is((select quantity from sales.order_items where order_id = '71000000-0000-0000-0000-0000000003a1'), 3,
  'the late replay did not roll the lines back');

-- ===========================================================================
-- A replay is per caller
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a3');
select throws_like($$select api.save_order_draft('71000000-0000-0000-0000-0000000003a1', '40000000-0000-0000-0000-000000000001',
  '[{"variant_id":"53000000-0000-0000-0000-000000000001","quantity":3}]', 'offline draft', null, 1,
  '20000000-0000-0000-0000-000000000004')$$,
  'CONFLICT%', 'the manager sending the rep''s request is not a replay for them');
select is((api.save_order_draft('71000000-0000-0000-0000-0000000003a1', '40000000-0000-0000-0000-000000000001',
  '[{"variant_id":"53000000-0000-0000-0000-000000000001","quantity":4}]', 'offline draft', null, 2,
  '20000000-0000-0000-0000-000000000004') ->> 'version')::int, 3, 'the manager edits the team draft at the current version');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select throws_like($$select api.save_order_draft('71000000-0000-0000-0000-0000000003a1', '40000000-0000-0000-0000-000000000001',
  '[{"variant_id":"53000000-0000-0000-0000-000000000001","quantity":5}]', 'offline draft', null, 2)$$,
  'CONFLICT: order changed (current version 3)%', 'the rep''s queued edit based on version 2 now conflicts');

-- ===========================================================================
-- Replays after submit; the status rule still holds for new saves
-- ===========================================================================
select is(api.submit_order('71000000-0000-0000-0000-0000000003a1') ->> 'status', 'submitted', 'the draft is submitted online');
select set_config('t.late', api.save_order_draft('71000000-0000-0000-0000-0000000003a1', '40000000-0000-0000-0000-000000000001',
  '[{"variant_id":"53000000-0000-0000-0000-000000000001","quantity":3}]', 'offline draft', null, 1)::text, true);
select ok((current_setting('t.late')::jsonb ->> 'replayed')::boolean and current_setting('t.late')::jsonb ->> 'status' = 'submitted',
  'a late replay after submit answers replayed with the current status (before: INVALID_STATE)');
select throws_like($$select api.save_order_draft('71000000-0000-0000-0000-0000000003a1', '40000000-0000-0000-0000-000000000001',
  '[{"variant_id":"53000000-0000-0000-0000-000000000001","quantity":6}]', 'offline draft', null, 3)$$,
  'INVALID_STATE%', 'a new save of a submitted order is still refused');

-- ===========================================================================
-- Permission and scope still come first
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a8');
select throws_like($$select api.save_order_draft('71000000-0000-0000-0000-0000000003a1', '40000000-0000-0000-0000-000000000001',
  '[{"variant_id":"53000000-0000-0000-0000-000000000001","quantity":3}]', 'offline draft', null, 1)$$,
  '%PERMISSION_DENIED%', 'a user without sales.order.create gets no answer, replay or not');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a5');
select throws_like($$select api.save_order_draft('71000000-0000-0000-0000-0000000003a1', '40000000-0000-0000-0000-000000000001',
  '[{"variant_id":"53000000-0000-0000-0000-000000000001","quantity":3}]', 'offline draft', null, 1)$$,
  'PERMISSION_DENIED%', 'another rep replaying the request is refused by the customer scope');

select tests.clear_authentication();
select * from finish();
rollback;
