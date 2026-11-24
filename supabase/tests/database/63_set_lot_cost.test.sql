-- Phase P: the owner sets an unknown lot cost once (20261126000400_set_lot_cost.sql, decision 2026-11-24).
--   inventory.lot.set_cost: sensitive, MFA-gated, granted to no role; api.set_lot_cost is owner only.
--   A lot's cost is unknown while a receipt brought units into it without a purchase cost (opening
--   stock imported with cost_unknown). The cost is set once, with a reason, into the append-only
--   inventory.lot_costs (audited, outbox event without the amount); a known cost is never overwritten;
--   past movements keep their NULL cost (no back-fill). api.v_lot_costs shows the status to cost
--   readers with stock access, never to reps. The legacy "data to complete" list drops an item once
--   every one of its unknown-cost lots has a cost.
-- Synthetic data only (SYN-LC1 with two unknown-cost lots, SYN-LC2 with a known cost).
--   users: a1 owner · a4 rep Cairo · a6 finance officer · a7 admin · a8 inventory manager
begin;
select tests.load_fixture();
select plan(57);
set constraints all immediate;

create function pg_temp.try(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return 'OK';
exception when others then
  return 'ERROR ' || sqlstate || ' ' || split_part(sqlerrm, ':', 1);
end $$;
create function pg_temp.enforce(p_on boolean) returns void language sql as $$
  update core.system_settings set value = to_jsonb(p_on) where key = 'security.mfa_enforced'
$$;
create function pg_temp.lot(p_lot_no text) returns uuid language sql security definer set search_path = '' as $$
  select id from inventory.lots where lot_no = p_lot_no
$$;
create function pg_temp.step(p_session uuid, p_step int) returns uuid language sql as $$
  select batch_id from import.legacy_session_steps where session_id = p_session and step_no = p_step
$$;
create function pg_temp.sid(p_name text) returns uuid language sql as $$
  select nullif(current_setting('t.' || p_name, true), '')::uuid
$$;
create function pg_temp.keep(p_name text, p_value text) returns text language sql as $$
  select set_config('t.' || p_name, p_value, true)
$$;
create function pg_temp.set_cost(p_lot_no text, p_cost numeric, p_reason text, p_key text) returns jsonb language sql as $$
  select api.set_lot_cost(pg_temp.lot(p_lot_no), p_cost, p_reason, p_key::uuid)
$$;
grant execute on all functions in schema pg_temp to authenticated;

-- ===========================================================================
-- Structure and privileges
-- ===========================================================================
select is((select requires_mfa::text || '|' || is_sensitive::text || '|' || allowed_scopes::text
           from authz.permissions where code = 'inventory.lot.set_cost'),
  'true|true|{all}', 'inventory.lot.set_cost exists: sensitive, MFA-gated, company-wide only');
select is((select count(*)::int from authz.role_permissions where permission_code = 'inventory.lot.set_cost'), 0,
  'it is granted to no role (the owner holds every permission)');
select ok(not has_function_privilege('anon', 'api.set_lot_cost(uuid, numeric, text, uuid)', 'execute'),
  'anon cannot execute api.set_lot_cost');
select ok(has_function_privilege('authenticated', 'api.set_lot_cost(uuid, numeric, text, uuid)', 'execute'),
  'signed-in users can call it (the database decides who may)');
select ok((select coalesce(c.reloptions @> array['security_invoker=true'], false) from pg_class c
           where c.oid = 'api.v_lot_costs'::regclass), 'api.v_lot_costs is security_invoker');
select ok(not has_table_privilege('anon', 'api.v_lot_costs', 'select'), 'anon cannot read api.v_lot_costs');
select ok((select c.relrowsecurity from pg_class c where c.oid = 'inventory.lot_costs'::regclass),
  'RLS is enabled on inventory.lot_costs');
select ok(not has_table_privilege('authenticated', 'inventory.lot_costs', 'insert')
      and not has_table_privilege('authenticated', 'inventory.lot_costs', 'update')
      and not has_table_privilege('authenticated', 'inventory.lot_costs', 'delete'),
  'clients cannot write inventory.lot_costs (only the command does)');
select is((select string_agg(t.tgname, ',' order by t.tgname) from pg_trigger t
           where t.tgrelid = 'inventory.lot_costs'::regclass and not t.tgisinternal),
  'trg_audit,trg_lot_costs_append_only', 'inventory.lot_costs is audited and append-only');

-- ===========================================================================
-- Synthetic stock with unknown cost: the old-system import (owner, opening stock with cost_unknown)
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');
create temp table t_s as select api.legacy_import_start('p63-session-01', 'synthetic.xlsx', repeat('b', 64), '{"checks":[]}', '[]', null,
  $j${"products": [
    {"product_code":"SYN-LC1","brand_code":"BIONER","category_code":"IMPLANT","product_name_en":"Synthetic Lot Cost One","product_name_ar":null,"lot_tracked":"yes","expiry_tracked":"no","sku":"SYN-LC1","variant_name_en":"Synthetic Lot Cost One","barcode":null,"uom":"unit","reorder_point":null},
    {"product_code":"SYN-LC2","brand_code":"BIONER","category_code":"IMPLANT","product_name_en":"Synthetic Lot Cost Two","product_name_ar":null,"lot_tracked":"yes","expiry_tracked":"no","sku":"SYN-LC2","variant_name_en":"Synthetic Lot Cost Two","barcode":null,"uom":"unit","reorder_point":null}],
   "opening_stock": [
    {"warehouse_code":"WH-CAI","sku":"SYN-LC1","lot_no":"LC1-A","expiry_date":null,"quantity":"10","unit_cost":null,"cost_unknown":"yes"},
    {"warehouse_code":"WH-CAI","sku":"SYN-LC1","lot_no":"LC1-B","expiry_date":null,"quantity":"4","unit_cost":null,"cost_unknown":"yes"},
    {"warehouse_code":"WH-CAI","sku":"SYN-LC2","lot_no":"LC2-A","expiry_date":null,"quantity":"5","unit_cost":"250.00","cost_unknown":null}]}$j$::jsonb) as r;
select pg_temp.keep('s1', (select r ->> 'session_id' from t_s));
select api.import_validate(pg_temp.step(pg_temp.sid('s1'), 2));
select api.import_commit(pg_temp.step(pg_temp.sid('s1'), 2));
select api.import_validate(pg_temp.step(pg_temp.sid('s1'), 4));
select is(api.import_commit(pg_temp.step(pg_temp.sid('s1'), 4)) -> 'result' ->> 'cost_unknown_lines', '2',
  'setup: opening stock imported with two unknown-cost lines');

select is((select string_agg(lot_no || '=' || cost_status || ':' || coalesce(unit_cost::text, '-'), ',' order by lot_no)
           from api.v_lot_costs where sku in ('SYN-LC1', 'SYN-LC2')),
  'LC1-A=unknown:-,LC1-B=unknown:-,LC2-A=known:250.00', 'the owner sees each lot''s cost status');
select is((select count(*)::int from api.v_legacy_import_quality where session_id = pg_temp.sid('s1') and issue = 'cost_unknown'), 1,
  'data to complete: the item with unknown-cost lots is listed');

-- ===========================================================================
-- Who may call it
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is(pg_temp.try($$select pg_temp.set_cost('LC1-A', 100, 'synthetic reason', '63000000-0000-0000-0000-000000000001')$$),
  'ERROR 42501 PERMISSION_DENIED', 'a rep is refused');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select is(pg_temp.try($$select pg_temp.set_cost('LC1-A', 100, 'synthetic reason', '63000000-0000-0000-0000-000000000001')$$),
  'ERROR 42501 PERMISSION_DENIED', 'the finance officer is refused');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a8');
select is(pg_temp.try($$select pg_temp.set_cost('LC1-A', 100, 'synthetic reason', '63000000-0000-0000-0000-000000000001')$$),
  'ERROR 42501 PERMISSION_DENIED', 'the inventory manager is refused');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a7');
select is(pg_temp.try($$select pg_temp.set_cost('LC1-A', 100, 'synthetic reason', '63000000-0000-0000-0000-000000000001')$$),
  'ERROR 42501 PERMISSION_DENIED', 'the admin is refused');
select tests.clear_authentication();
insert into authz.role_permissions (role_id, permission_code, scope)
select id, 'inventory.lot.set_cost', 'all' from authz.roles where code = 'admin';
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a7');
select is(pg_temp.try($$select pg_temp.set_cost('LC1-A', 100, 'synthetic reason', '63000000-0000-0000-0000-000000000001')$$),
  'ERROR 42501 OWNER_ONLY', 'a non-owner given the permission is still refused (owner only)');
select tests.clear_authentication();
delete from authz.role_permissions where permission_code = 'inventory.lot.set_cost';

select pg_temp.enforce(true);
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');
select is(pg_temp.try($$select pg_temp.set_cost('LC1-A', 100, 'synthetic reason', '63000000-0000-0000-0000-000000000001')$$),
  'ERROR 42501 MFA_REQUIRED', 'enforcement on: the owner at aal1 is refused');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is(pg_temp.try($$select pg_temp.set_cost('LC1-A', 100, 'synthetic reason', '63000000-0000-0000-0000-000000000001')$$),
  'ERROR 42501 PERMISSION_DENIED', 'enforcement on: a rep still learns nothing about MFA');
select tests.clear_authentication();
select is((select count(*)::int from inventory.lot_costs), 0, 'nothing was stored by the refused calls');

-- ===========================================================================
-- Input rules (owner at aal2, enforcement on)
-- ===========================================================================
select tests.authenticate_as_aal2('00000000-0000-0000-0000-0000000000a1');
select is(pg_temp.try($$select pg_temp.set_cost('LC1-A', 0, 'synthetic reason', '63000000-0000-0000-0000-000000000002')$$),
  'ERROR P0001 VALIDATION', 'a cost of 0 is refused (unknown is never stored as 0)');
select is(pg_temp.try($$select pg_temp.set_cost('LC1-A', -5, 'synthetic reason', '63000000-0000-0000-0000-000000000002')$$),
  'ERROR P0001 VALIDATION', 'a negative cost is refused');
select is(pg_temp.try($$select pg_temp.set_cost('LC1-A', null, 'synthetic reason', '63000000-0000-0000-0000-000000000002')$$),
  'ERROR P0001 VALIDATION', 'a missing cost is refused');
select is(pg_temp.try($$select pg_temp.set_cost('LC1-A', 10.555, 'synthetic reason', '63000000-0000-0000-0000-000000000002')$$),
  'ERROR P0001 VALIDATION', 'more than two decimals are refused');
select is(pg_temp.try($$select pg_temp.set_cost('LC1-A', 1000000000000, 'synthetic reason', '63000000-0000-0000-0000-000000000002')$$),
  'ERROR P0001 VALIDATION', 'a cost that does not fit an amount is refused');
select is(pg_temp.try($$select pg_temp.set_cost('LC1-A', 100, null, '63000000-0000-0000-0000-000000000002')$$),
  'ERROR P0001 VALIDATION', 'a missing reason is refused');
select is(pg_temp.try($$select pg_temp.set_cost('LC1-A', 100, '  ab  ', '63000000-0000-0000-0000-000000000002')$$),
  'ERROR P0001 VALIDATION', 'a reason under 3 characters is refused');
select is(pg_temp.try(format('select pg_temp.set_cost(%L, 100, %L, %L)', 'LC1-A', repeat('x', 501), '63000000-0000-0000-0000-000000000002')),
  'ERROR P0001 VALIDATION', 'a reason over 500 characters is refused');
select is(pg_temp.try($$select pg_temp.set_cost('LC1-A', 100, 'synthetic reason', null)$$),
  'ERROR P0001 VALIDATION', 'a missing idempotency key is refused');
select is(pg_temp.try($$select api.set_lot_cost(gen_random_uuid(), 100, 'synthetic reason', '63000000-0000-0000-0000-000000000002')$$),
  'ERROR P0002 NOT_FOUND', 'an unknown lot is NOT_FOUND');
select is(pg_temp.try($$select pg_temp.set_cost('LC2-A', 300, 'synthetic reason', '63000000-0000-0000-0000-000000000002')$$),
  'ERROR P0001 COST_ALREADY_SET', 'a lot received with a known cost is refused');
select is(pg_temp.try($$select pg_temp.set_cost('L2026A', 300, 'synthetic reason', '63000000-0000-0000-0000-000000000002')$$),
  'ERROR P0001 COST_ALREADY_SET', 'a lot with no unknown-cost units is refused');
select is((select count(*)::int from inventory.lot_costs), 0, 'nothing was stored by the refused calls');

-- ===========================================================================
-- Set once
-- ===========================================================================
create temp table t_set1 as
  select pg_temp.set_cost('LC1-A', 1234.5, '  Supplier invoice found (synthetic)  ', '63000000-0000-0000-0000-000000000010') as r;
select is((select (r ->> 'unit_cost') || '|' || (r ->> 'cost_status') || '|' || (r ->> 'replayed') from t_set1),
  '1234.50|set|false', 'the owner at aal2 sets the unknown cost');
select tests.clear_authentication();
select is((select lc.unit_cost::text || '|' || lc.reason || '|' || lc.set_by::text from inventory.lot_costs lc where lc.lot_id = pg_temp.lot('LC1-A')),
  '1234.50|Supplier invoice found (synthetic)|00000000-0000-0000-0000-0000000000a1', 'the cost, the trimmed reason and who set it are stored');
select is((select count(*)::int from audit.audit_log a
           where a.table_schema = 'inventory' and a.table_name = 'lot_costs' and a.action = 'INSERT'
             and a.actor_user_id = '00000000-0000-0000-0000-0000000000a1'
             and a.new_data ->> 'reason' = 'Supplier invoice found (synthetic)'
             and (a.new_data ->> 'unit_cost')::numeric = 1234.50
             and a.new_data ->> 'lot_id' = pg_temp.lot('LC1-A')::text
             and a.record_id = (select lc.id::text from inventory.lot_costs lc where lc.lot_id = pg_temp.lot('LC1-A'))), 1,
  'one audit row carries the cost and the reason, keyed by the row id (audit timeline)');
select is((select count(*)::int from integration.outbox o
           where o.event_type = 'inventory.lot_cost_set' and o.aggregate_type = 'inventory.lot'
             and o.aggregate_id = pg_temp.lot('LC1-A') and o.payload ->> 'sku' = 'SYN-LC1' and not (o.payload ? 'unit_cost')), 1,
  'one outbox event, without the amount');
select is((select count(*)::int from inventory.movements m
           where m.lot_id = pg_temp.lot('LC1-A') and m.movement_type = 'receipt' and m.unit_cost is null), 1,
  'past movements are not back-filled: the receipt keeps its unknown cost');
select is((select count(*)::int from inventory.goods_receipt_items gi
           join catalog.product_variants v on v.id = gi.variant_id
           where v.sku = 'SYN-LC1' and gi.lot_no = 'LC1-A' and gi.unit_cost is null), 1,
  'nor the receipt document');

select tests.authenticate_as_aal2('00000000-0000-0000-0000-0000000000a1');
select is((select (r ->> 'unit_cost') || '|' || (r ->> 'replayed') || '|' || (r ->> 'set_at' = (select r ->> 'set_at' from t_set1))::text
           from (select pg_temp.set_cost('LC1-A', 1234.50, 'synthetic retry', '63000000-0000-0000-0000-000000000010') as r) x),
  '1234.50|true|true', 'a retry with the same key and value replays the same result');
select is(pg_temp.try($$select pg_temp.set_cost('LC1-A', 999, 'synthetic reason', '63000000-0000-0000-0000-000000000010')$$),
  'ERROR P0001 COST_ALREADY_SET', 'the same key with a different value is refused');
select is(pg_temp.try($$select pg_temp.set_cost('LC1-A', 999, 'synthetic reason', '63000000-0000-0000-0000-000000000011')$$),
  'ERROR P0001 COST_ALREADY_SET', 'a second call with a different value is refused: a known cost is never overwritten');
select is(pg_temp.try($$select pg_temp.set_cost('LC1-A', 1234.50, 'synthetic reason', '63000000-0000-0000-0000-000000000012')$$),
  'ERROR P0001 COST_ALREADY_SET', 'even with the same value under a new key');
select is(pg_temp.try($$select pg_temp.set_cost('LC1-B', 50, 'synthetic reason', '63000000-0000-0000-0000-000000000010')$$),
  'ERROR P0001 CONFLICT', 'a key already used for another lot is refused');
select tests.clear_authentication();
select is((select count(*)::int from inventory.lot_costs) || '|'
          || (select count(*) from audit.audit_log where table_schema = 'inventory' and table_name = 'lot_costs') || '|'
          || (select count(*) from integration.outbox where event_type = 'inventory.lot_cost_set'),
  '1|1|1', 'the replay and the refusals wrote nothing');
select is(pg_temp.try(format('update inventory.lot_costs set unit_cost = 1 where lot_id = %L', pg_temp.lot('LC1-A'))),
  'ERROR P0001 APPEND_ONLY', 'the stored cost cannot be edited, even directly');
select is(pg_temp.try(format('delete from inventory.lot_costs where lot_id = %L', pg_temp.lot('LC1-A'))),
  'ERROR P0001 APPEND_ONLY', 'nor deleted');

-- ===========================================================================
-- Reads
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');
select is((select string_agg(lot_no || '=' || cost_status || ':' || coalesce(unit_cost::text, '-'), ',' order by lot_no)
           from api.v_lot_costs where sku in ('SYN-LC1', 'SYN-LC2')),
  'LC1-A=set:1234.50,LC1-B=unknown:-,LC2-A=known:250.00', 'the set cost shows on the lot');
select is((select count(*)::int from api.v_legacy_import_quality where session_id = pg_temp.sid('s1') and issue = 'cost_unknown'), 1,
  'data to complete: the item stays listed while one of its lots is still unknown');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a8');
select is((select count(*)::int from api.v_lot_costs where sku in ('SYN-LC1', 'SYN-LC2')), 3,
  'the inventory manager (cost reader with stock access) sees the lot costs');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is((select count(*)::int from api.v_lot_costs), 0, 'a rep reads no lot cost through the view');
select is((select count(*)::int from inventory.lot_costs), 0, 'nor from the table');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select is((select count(*)::int from api.v_lot_costs), 0, 'a cost reader without stock access sees no lots');

select tests.authenticate_as_aal2('00000000-0000-0000-0000-0000000000a1');
select is(pg_temp.set_cost('LC1-B', 1200, 'synthetic stock count', '63000000-0000-0000-0000-000000000020') ->> 'unit_cost', '1200.00',
  'the second unknown lot gets its cost');
select is((select count(*)::int from api.v_legacy_import_quality where session_id = pg_temp.sid('s1') and issue = 'cost_unknown'), 0,
  'data to complete: the item leaves the list once all its unknown lots have a cost');
select is((select count(*)::int from api.v_lot_costs where cost_status = 'unknown'), 0, 'no unknown-cost lot is left');
select tests.clear_authentication();
select pg_temp.enforce(false);

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');
select is((select requires_mfa from api.v_permissions where code = 'inventory.lot.set_cost'), true,
  'the permission catalogue shows the MFA flag');
select tests.clear_authentication();

select * from finish();
rollback;
