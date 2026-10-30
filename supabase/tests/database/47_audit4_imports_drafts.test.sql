-- Audit 4 (money and stock) regressions, migration 20261104000200_audit4_imports_drafts.sql.
--   M-2: two concurrent imports of the same kind could load opening stock or opening AR twice.
--        api.import_commit now takes a per-kind transaction advisory lock before re-validating, and
--        finance.customer_ledger allows one opening_balance per customer. A two-session race cannot
--        run inside one pgTAP transaction, so this suite proves the pieces (lock present and taken
--        before the re-validation, the index, the sequential outcome a waiting session sees); the
--        two-session race was reproduced by hand (audit4-M/race_*).
--   M-3 (orders half): a replay of api.save_order_draft answered before the customer and owner scope
--        checks, so a rep who lost the customer could still read the current draft (lines, prices).
-- Synthetic data only (D-03).
--   users: a1 owner · a3 area manager Cairo (team of E004) · a4 rep Cairo (C-0001) · a5 rep Delta
begin;
select tests.load_fixture();
select plan(22);
set constraints all immediate;

create function pg_temp.remember(p_name text, p_key text) returns void language sql as $$
  select set_config('t.' || p_name, (select id::text from import.batches where idempotency_key = p_key), true)
$$;
create function pg_temp.b(p_name text) returns uuid language sql as $$
  select nullif(current_setting('t.' || p_name, true), '')::uuid
$$;
create function pg_temp.errs(p_name text, p_row int) returns text language sql as $$
  select array_to_string(errors, ',') from import.rows where batch_id = pg_temp.b(p_name) and row_no = p_row
$$;
grant execute on function pg_temp.b(text) to authenticated;

-- ===========================================================================
-- M-2 · the commit is serialized per import kind
-- ===========================================================================
select ok(pg_get_functiondef('api.import_commit(uuid)'::regprocedure) ~ 'pg_advisory_xact_lock\s*\(\s*hashtextextended\s*\(\s*''import\.commit:''',
  'M-2 api.import_commit takes a per-kind transaction advisory lock');
select ok(strpos(pg_get_functiondef('api.import_commit(uuid)'::regprocedure), 'pg_advisory_xact_lock') > 0
          and strpos(pg_get_functiondef('api.import_commit(uuid)'::regprocedure), 'pg_advisory_xact_lock')
          < strpos(pg_get_functiondef('api.import_commit(uuid)'::regprocedure), 'import._validate('),
  'M-2 the lock is taken before the re-validation (the "already imported" checks run under it)');
select ok(strpos(pg_get_functiondef('api.import_commit(uuid)'::regprocedure), 'authz.require(''admin.import.run'')')
          < strpos(pg_get_functiondef('api.import_commit(uuid)'::regprocedure), 'pg_advisory_xact_lock'),
  'M-2 the permission check still comes before the lock (no lock for callers without admin.import.run)');

-- ===========================================================================
-- M-2 · one opening balance per customer, enforced by the database
-- ===========================================================================
select ok(exists (select 1 from pg_index i join pg_class c on c.oid = i.indexrelid
                  join pg_namespace n on n.oid = c.relnamespace
                  where n.nspname = 'finance' and c.relname = 'customer_ledger_one_opening_balance_uidx'
                    and i.indrelid = 'finance.customer_ledger'::regclass and i.indisunique
                    and pg_get_expr(i.indpred, i.indrelid) ~ 'opening_balance'),
  'M-2 finance.customer_ledger has a partial unique index on customer_id for opening_balance');
insert into finance.customer_ledger (customer_id, entry_type, amount, source_table, source_id)
values ('40000000-0000-0000-0000-000000000002', 'opening_balance', 100, 'test', 'a4700000-0000-0000-0000-000000000001');
select throws_ok($$insert into finance.customer_ledger (customer_id, entry_type, amount, source_table, source_id)
  values ('40000000-0000-0000-0000-000000000002', 'opening_balance', 100, 'test', 'a4700000-0000-0000-0000-000000000002')$$,
  '23505', null, 'M-2 a second opening balance for the same customer is rejected by the index');
select lives_ok($$insert into finance.customer_ledger (customer_id, entry_type, amount, source_table, source_id)
  values ('40000000-0000-0000-0000-000000000002', 'adjustment', 100, 'test', 'a4700000-0000-0000-0000-000000000003')$$,
  'M-2 other entry types for that customer are not affected');

-- ===========================================================================
-- M-2 · opening AR: two batches staged and validated side by side (the race), committed in turn.
-- The second commit is what a waiting session runs once the first has committed.
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');
select api.import_create_batch('opening_ar', '[{"customer_no":"C-0001","amount":"5000.00"}]', 'a47-ar-A-0001');
select api.import_create_batch('opening_ar', '[{"customer_no":"C-0001","amount":"5000.00"}]', 'a47-ar-B-0001');
select pg_temp.remember('arA', 'a47-ar-A-0001');
select pg_temp.remember('arB', 'a47-ar-B-0001');
select is(api.import_validate(pg_temp.b('arA')) ->> 'status', 'validated', 'M-2 AR batch A validates');
select is(api.import_validate(pg_temp.b('arB')) ->> 'status', 'validated', 'M-2 AR batch B validates (A is not committed yet)');
select is(api.import_commit(pg_temp.b('arA')) ->> 'status', 'committed', 'M-2 AR batch A commits');
select is(api.import_commit(pg_temp.b('arB')) - 'batch_id',
  '{"kind": "opening_ar", "status": "failed", "committed": false, "row_count": 1, "error_count": 1, "valid_count": 0}'::jsonb,
  'M-2 AR batch B is refused at commit: the re-validation sees A''s opening balance');
select is(pg_temp.errs('arB', 1), 'already_imported:customer', 'M-2 the refused row says the customer was already imported');
select tests.clear_authentication();
select is((select count(*)::int || '|' || sum(amount) from finance.customer_ledger
           where customer_id = '40000000-0000-0000-0000-000000000001' and entry_type = 'opening_balance'),
  '1|5000.00', 'M-2 C-0001 has exactly one opening balance of 5000');

-- ===========================================================================
-- M-2 · opening stock: the same for one warehouse, SKU and lot
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');
select api.import_create_batch('opening_stock', '[{"warehouse_code":"WH-CAI","sku":"BIO-TOP-4110","lot_no":"A47-OPEN-1","expiry_date":"2031-01-31","quantity":"100"}]', 'a47-st-A-0001');
select api.import_create_batch('opening_stock', '[{"warehouse_code":"WH-CAI","sku":"BIO-TOP-4110","lot_no":"A47-OPEN-1","expiry_date":"2031-01-31","quantity":"100"}]', 'a47-st-B-0001');
select pg_temp.remember('stA', 'a47-st-A-0001');
select pg_temp.remember('stB', 'a47-st-B-0001');
select is(api.import_validate(pg_temp.b('stA')) ->> 'status', 'validated', 'M-2 stock batch A validates');
select is(api.import_validate(pg_temp.b('stB')) ->> 'status', 'validated', 'M-2 stock batch B validates (A is not committed yet)');
select is(api.import_commit(pg_temp.b('stA')) ->> 'status', 'committed', 'M-2 stock batch A commits');
select is(api.import_commit(pg_temp.b('stB')) ->> 'status', 'failed', 'M-2 stock batch B is refused at commit');
select is(pg_temp.errs('stB', 1), 'already_imported:lot_no', 'M-2 the refused row says the lot was already imported');
select tests.clear_authentication();
select is((select sum(m.quantity)::int from inventory.movements m join inventory.lots l on l.id = m.lot_id
           where l.lot_no = 'A47-OPEN-1' and m.movement_type = 'receipt'),
  100, 'M-2 the lot received 100 units once, not 200');

-- ===========================================================================
-- M-3 · a replay re-runs the customer and owner scope checks before it answers
-- ===========================================================================
-- a4 creates a draft (1 unit); the area manager edits it to 7 units at 5%.
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select api.save_order_draft('f4700000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001',
  '[{"variant_id":"53000000-0000-0000-0000-000000000001","quantity":1}]');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a3');
select api.save_order_draft('f4700000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001',
  '[{"variant_id":"53000000-0000-0000-0000-000000000001","quantity":7,"requested_discount_pct":5}]', 'manager note', null, 1,
  '20000000-0000-0000-0000-000000000004');
-- Legitimate replay while still in scope: answered as before (current draft, replayed).
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select ok((api.save_order_draft('f4700000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001',
  '[{"variant_id":"53000000-0000-0000-0000-000000000001","quantity":1}]') ->> 'replayed')::boolean,
  'M-3 a replay by the creator while the customer is in scope still answers replayed');

-- The order is moved to rep E005 (outside the area manager's team); the customer stays in Cairo.
select tests.clear_authentication();
update sales.orders set employee_id = '20000000-0000-0000-0000-000000000005' where id = 'f4700000-0000-0000-0000-000000000001';
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a3');
select throws_like($$select api.save_order_draft('f4700000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001',
  '[{"variant_id":"53000000-0000-0000-0000-000000000001","quantity":7,"requested_discount_pct":5}]', 'manager note', null, 1,
  '20000000-0000-0000-0000-000000000004')$$,
  'PERMISSION_DENIED: order belongs to another representative%',
  'M-3 the manager''s replay is refused once the order is outside their scope (before: the current draft)');

-- The customer is reassigned away from a4 (the auditor's scenario).
select tests.clear_authentication();
update crm.customer_assignments set valid_from = now() - interval '2 days', valid_to = now() - interval '1 hour'
where customer_id = '40000000-0000-0000-0000-000000000001';
insert into crm.customer_assignments (customer_id, employee_id, role) values
  ('40000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000005', 'primary_rep');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is((select count(*)::int from sales.orders where id = 'f4700000-0000-0000-0000-000000000001'), 0,
  'M-3 a4 can no longer read the order');
select throws_like($$select api.save_order_draft('f4700000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001',
  '[{"variant_id":"53000000-0000-0000-0000-000000000001","quantity":1}]')$$,
  'PERMISSION_DENIED: customer not in your scope%',
  'M-3 the former creator''s replay is refused (before: the manager''s current lines, prices and totals)');

select tests.clear_authentication();
select * from finish();
rollback;
