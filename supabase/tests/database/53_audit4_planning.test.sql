-- Audit 4 (area F) planning fixes:
--   F2 api.plan_visits enforces planning.daily_visit_cap; api.generate_plan is linear, caps customers per call
--      and stays fast after a flooded month;
--   F5 planning never names or plans a customer outside the caller's crm.customer.read scope;
--   F6 a visit planned by someone else can be removed only by that planner or someone with scope over them,
--      and the planner is told when someone else removes it;
--   F9 api.coverage aggregates visits once (fast for 10k customers) and still never shows a customer that
--      crm.customers RLS hides.
begin;
select tests.load_fixture();
select plan(51);

-- Fixture ids: E002 sales director (a2) > E003 area mgr Cairo (a3) > E004 rep Cairo (a4) and E009 new hire
-- (no login); E005 rep Delta (a5, manager E002). C-0001 (Nasr City, a4), C-0002 (Delta, a5).
create function pg_temp.d(n int) returns date language sql stable as $$ select core.business_date() + n $$;
create function pg_temp.next_month() returns date language sql stable as $$
  select (date_trunc('month', core.business_date()) + interval '1 month')::date $$;
create function pg_temp.g(k text) returns jsonb language sql stable as $$ select current_setting('t.' || k)::jsonb $$;
-- The error a statement raises, as 'SQLSTATE message' (null when it succeeds).
create function pg_temp.err(p_sql text) returns text language plpgsql as $$
begin
  execute p_sql;
  return null;
exception when others then
  return sqlstate || ' ' || sqlerrm;
end $$;
-- Milliseconds a statement takes.
create function pg_temp.ms(p_sql text) returns numeric language plpgsql as $$
declare t0 timestamptz := clock_timestamp();
begin
  execute p_sql;
  return round(extract(epoch from clock_timestamp() - t0) * 1000);
end $$;
create function pg_temp.plan1(p_emp uuid, p_cust uuid, p_day int) returns jsonb language sql as $$
  select api.plan_visits(p_emp, jsonb_build_array(jsonb_build_object('customer_id', p_cust, 'date', pg_temp.d(p_day))), gen_random_uuid())
$$;

-- P1–P4 Nasr City, assigned to the Cairo rep (E004); P5 Nasr City, unassigned; P6 Nasr City, archived, E004.
-- S1 Delta, assigned to the Delta rep (E005); S2 the same but archived. C-0002 (Delta) also gets E004 as
-- secondary rep: the rep sees it, the Cairo area manager does not.
insert into crm.customers (id, customer_no, doctor_name, display_name, territory_id, lifecycle_stage, archived_at) values
  ('5300c000-0000-0000-0000-000000000001','C-5301','Dr. P1','Synthetic P1','10000000-0000-0000-0000-000000000003','active',null),
  ('5300c000-0000-0000-0000-000000000002','C-5302','Dr. P2','Synthetic P2','10000000-0000-0000-0000-000000000003','active',null),
  ('5300c000-0000-0000-0000-000000000003','C-5303','Dr. P3','Synthetic P3','10000000-0000-0000-0000-000000000003','active',null),
  ('5300c000-0000-0000-0000-000000000004','C-5304','Dr. P4','Synthetic P4','10000000-0000-0000-0000-000000000003','active',null),
  ('5300c000-0000-0000-0000-000000000005','C-5305','Dr. P5','Synthetic P5','10000000-0000-0000-0000-000000000003','active',null),
  ('5300c000-0000-0000-0000-000000000006','C-5306','Dr. P6','Synthetic P6','10000000-0000-0000-0000-000000000003','active',now()),
  ('5300c000-0000-0000-0000-000000000011','C-5311','Dr. S1','Hidden S1',(select id from core.territories where code = 'DELTA'),'active',null),
  ('5300c000-0000-0000-0000-000000000012','C-5312','Dr. S2','Hidden S2',(select id from core.territories where code = 'DELTA'),'active',now());
insert into crm.customer_assignments (customer_id, employee_id, role) values
  ('5300c000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000004','primary_rep'),
  ('5300c000-0000-0000-0000-000000000002','20000000-0000-0000-0000-000000000004','primary_rep'),
  ('5300c000-0000-0000-0000-000000000003','20000000-0000-0000-0000-000000000004','primary_rep'),
  ('5300c000-0000-0000-0000-000000000004','20000000-0000-0000-0000-000000000004','primary_rep'),
  ('5300c000-0000-0000-0000-000000000006','20000000-0000-0000-0000-000000000004','primary_rep'),
  ('5300c000-0000-0000-0000-000000000011','20000000-0000-0000-0000-000000000005','primary_rep'),
  ('5300c000-0000-0000-0000-000000000012','20000000-0000-0000-0000-000000000005','primary_rep'),
  ('40000000-0000-0000-0000-000000000002','20000000-0000-0000-0000-000000000004','secondary_rep');

-- ===========================================================================
-- F2: api.plan_visits enforces the daily cap (2 here), existing visits included
-- ===========================================================================
update core.system_settings set value = '2' where key = 'planning.daily_visit_cap';
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select set_config('t.cap1', api.plan_visits(null, jsonb_build_array(
  jsonb_build_object('customer_id','5300c000-0000-0000-0000-000000000001','date',pg_temp.d(3)),
  jsonb_build_object('customer_id','5300c000-0000-0000-0000-000000000002','date',pg_temp.d(3))),
  '53e00000-0000-0000-0000-000000000001')::text, true);
select is(pg_temp.g('cap1') ->> 'created', '2', 'F2 a rep plans up to the cap on one day');
select throws_like(format($$select api.plan_visits(null, '[{"customer_id":"5300c000-0000-0000-0000-000000000003","date":"%s"}]', gen_random_uuid())$$,
  pg_temp.d(3)), 'DAILY_CAP%', 'F2 one more visit on a full day is refused');
select throws_like(format($$select api.plan_visits(null, '[{"customer_id":"5300c000-0000-0000-0000-000000000001","date":"%1$s"},
  {"customer_id":"5300c000-0000-0000-0000-000000000002","date":"%1$s"},{"customer_id":"5300c000-0000-0000-0000-000000000003","date":"%1$s"}]', gen_random_uuid())$$,
  pg_temp.d(4)), 'DAILY_CAP%', 'F2 more than the cap in one request is refused');
select is((select count(*)::int from field.visits where employee_id = '20000000-0000-0000-0000-000000000004' and planned_for = pg_temp.d(4)), 0,
  'F2 all or nothing: no visit of the refused request is kept');
select is(api.plan_visits(null, '[]', '53e00000-0000-0000-0000-000000000001') ->> 'replayed', 'true',
  'F2 a replay of an accepted plan still answers, even on a full day');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a3');
select throws_like(format($$select pg_temp.plan1('20000000-0000-0000-0000-000000000004', '5300c000-0000-0000-0000-000000000003', 3)$$),
  'DAILY_CAP%', 'F2 the cap binds a manager planning for the rep too');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is(api.unplan_visit((pg_temp.g('cap1') -> 'visits' -> 1 ->> 'visit_id')::uuid) ->> 'status', 'cancelled', 'F2 the rep removes one visit');
select is(pg_temp.plan1(null, '5300c000-0000-0000-0000-000000000003', 3) ->> 'created', '1', 'F2 a cancelled visit frees its place');
-- Two unplanned visits today (checked in without a plan) fill today.
select tests.clear_authentication();
insert into field.visits (id, customer_id, employee_id, status, check_in_at, check_out_at, verification_status) values
  ('53a00000-0000-0000-0000-000000000001','5300c000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000004','completed',
   (core.business_date() + time '00:01') at time zone 'Africa/Cairo', (core.business_date() + time '00:11') at time zone 'Africa/Cairo', 'verified'),
  ('53a00000-0000-0000-0000-000000000002','5300c000-0000-0000-0000-000000000002','20000000-0000-0000-0000-000000000004','in_progress',
   (core.business_date() + time '00:21') at time zone 'Africa/Cairo', null, 'pending');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select throws_like($$select pg_temp.plan1(null, '5300c000-0000-0000-0000-000000000003', 0)$$, 'DAILY_CAP%',
  'F2 visits checked in without a plan count towards the cap');
select is(pg_temp.plan1(null, '5300c000-0000-0000-0000-000000000003', 5) ->> 'created', '1', 'F2 another day still has room');
select tests.clear_authentication();
update core.system_settings set value = '8' where key = 'planning.daily_visit_cap';

-- ===========================================================================
-- F5: no customer outside the caller's crm.customer.read scope is named or planned
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a3');
select is((select count(*)::int from crm.customers where id = '40000000-0000-0000-0000-000000000002'), 0,
  'F5 (premise) the Cairo area manager cannot read the Delta customer C-0002');
select set_config('t.gen1', api.generate_plan('20000000-0000-0000-0000-000000000004', pg_temp.next_month())::text, true);
select ok(not (pg_temp.g('gen1')::text like '%C-0002%' or pg_temp.g('gen1')::text like '%Mona%'
               or pg_temp.g('gen1')::text like '%40000000-0000-0000-0000-000000000002%'),
  'F5 generate_plan does not show the manager a customer they cannot read (number, name or id)');
select ok(exists (select 1 from jsonb_array_elements(pg_temp.g('gen1') -> 'proposals') p where p ->> 'customer_no' = 'C-0001'),
  'F5 the customers the manager can read are still proposed');
select is(pg_temp.g('gen1') ->> 'customers', '5', 'F5 the customer count leaves the hidden customer out (C-0001 + P1–P4)');
select set_config('t.e1', pg_temp.err($$select pg_temp.plan1('20000000-0000-0000-0000-000000000004', '40000000-0000-0000-0000-000000000002', 11)$$), true);
select ok(current_setting('t.e1') like 'P0001 NOT_ASSIGNED:%' and current_setting('t.e1') not like '%C-0002%',
  'F5 the manager cannot plan the hidden customer, and the error does not name it');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select set_config('t.e2', pg_temp.err($$select pg_temp.plan1(null, '5300c000-0000-0000-0000-000000000011', 11)$$), true);
select ok(current_setting('t.e2') like 'P0001 NOT_ASSIGNED:%' and current_setting('t.e2') not like '%C-5311%',
  'F5 a rep probing another rep''s customer learns nothing about it');
select set_config('t.e3', pg_temp.err($$select pg_temp.plan1(null, '5300c000-0000-0000-0000-000000000012', 11)$$), true);
select ok(current_setting('t.e3') = current_setting('t.e2')
          and current_setting('t.e3') not like '%C-5312%' and current_setting('t.e3') not like '%archived%',
  'F5 a hidden archived customer gives exactly the same answer (no archived oracle)');
select throws_like($$select pg_temp.plan1(null, '5300c0ff-0000-0000-0000-000000000099', 11)$$, 'NOT_FOUND%',
  'F5 an unknown customer is still not found');
select tests.clear_authentication();
select is((select count(*)::int from field.visits where customer_id in ('40000000-0000-0000-0000-000000000002',
           '5300c000-0000-0000-0000-000000000011','5300c000-0000-0000-0000-000000000012')), 0, 'F5 none of these probes created a visit');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is(pg_temp.plan1(null, '40000000-0000-0000-0000-000000000002', 11) ->> 'created', '1',
  'F5 the rep still plans a Delta customer assigned to them (they can read it)');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a2');
select is(pg_temp.plan1('20000000-0000-0000-0000-000000000004', '40000000-0000-0000-0000-000000000002', 12) ->> 'created', '1',
  'F5 the sales director (reads all customers) plans it for the rep');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a3');
select throws_like($$select pg_temp.plan1('20000000-0000-0000-0000-000000000004', '5300c000-0000-0000-0000-000000000005', 12)$$,
  'NOT_ASSIGNED: customer C-5305%', 'F5 a visible but unassigned customer is still named in the error');
select throws_like($$select pg_temp.plan1('20000000-0000-0000-0000-000000000004', '5300c000-0000-0000-0000-000000000006', 12)$$,
  'INVALID_STATE: customer C-5306 is archived%', 'F5 a visible archived customer is still reported as archived');

-- ===========================================================================
-- F6: who planned a visit decides who may remove it
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a3');
select set_config('t.m1', pg_temp.plan1('20000000-0000-0000-0000-000000000004', '5300c000-0000-0000-0000-000000000004', 7) -> 'visits' -> 0 ->> 'visit_id', true);
select tests.clear_authentication();
select is((select planned_by from field.visits where id = current_setting('t.m1')::uuid), '00000000-0000-0000-0000-0000000000a3'::uuid,
  'F6 the visit records who planned it');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select throws_like(format($$select api.unplan_visit('%s')$$, current_setting('t.m1')), 'PERMISSION_DENIED%',
  'F6 the rep cannot remove a visit their manager planned');
select is((select status from field.visits where id = current_setting('t.m1')::uuid), 'planned', 'F6 the visit stays planned');
select is((select can_unplan::text || '/' || may_unplan::text from api.v_visit_plan where id = current_setting('t.m1')::uuid), 'true/false',
  'F6 the rep''s plan view does not offer to remove it (may_unplan), although its state would allow it (can_unplan)');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a3');
select is((select may_unplan from api.v_visit_plan where id = current_setting('t.m1')::uuid), true, 'F6 the planner''s view does');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a2');
select is(api.unplan_visit(current_setting('t.m1')::uuid) ->> 'status', 'cancelled',
  'F6 the planner''s manager (scope over the planner) can remove it');
select tests.clear_authentication();
select is((select count(*)::int from notify.notifications where recipient_user_id = '00000000-0000-0000-0000-0000000000a3'
           and type = 'planning.planned_visit_removed' and data ->> 'visit_id' = current_setting('t.m1')), 1,
  'F6 and the planner is told');
select is((select count(*)::int from notify.notifications where recipient_user_id = '00000000-0000-0000-0000-0000000000a4'
           and type = 'planning.visit_unplanned' and data ->> 'visit_id' = current_setting('t.m1')), 1, 'F6 so is the rep');
-- The planner removes their own visit for the rep: the rep is told, the planner is not.
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a3');
select set_config('t.m2', pg_temp.plan1('20000000-0000-0000-0000-000000000004', '5300c000-0000-0000-0000-000000000004', 8) -> 'visits' -> 0 ->> 'visit_id', true);
select is(api.unplan_visit(current_setting('t.m2')::uuid) ->> 'status', 'cancelled', 'F6 the planner removes their own plan');
select tests.clear_authentication();
select is((select count(*)::int from notify.notifications where data ->> 'visit_id' = current_setting('t.m2')
           and recipient_user_id = '00000000-0000-0000-0000-0000000000a3'), 0, 'F6 nobody tells the planner about their own change');
-- The rep plans for themselves: the rep removes it; the manager may remove it too (scope over the planner).
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select set_config('t.r1', pg_temp.plan1(null, '5300c000-0000-0000-0000-000000000004', 9) -> 'visits' -> 0 ->> 'visit_id', true);
select is((select may_unplan from api.v_visit_plan where id = current_setting('t.r1')::uuid), true, 'F6 the rep may remove their own plan');
select is(api.unplan_visit(current_setting('t.r1')::uuid) ->> 'status', 'cancelled', 'F6 and does');
select set_config('t.r2', pg_temp.plan1(null, '5300c000-0000-0000-0000-000000000004', 10) -> 'visits' -> 0 ->> 'visit_id', true);
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a3');
select is(api.unplan_visit(current_setting('t.r2')::uuid) ->> 'status', 'cancelled', 'F6 the rep''s manager removes the rep''s own plan');
select tests.clear_authentication();
select is((select count(*)::int from notify.notifications where data ->> 'visit_id' = current_setting('t.r2')
           and recipient_user_id = '00000000-0000-0000-0000-0000000000a4'), 1, 'F6 the rep (employee and planner) is told once');
-- A peer or junior of the planner cannot remove it.
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a2');
select set_config('t.m3', pg_temp.plan1('20000000-0000-0000-0000-000000000004', '5300c000-0000-0000-0000-000000000003', 10) -> 'visits' -> 0 ->> 'visit_id', true);
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a3');
select throws_like(format($$select api.unplan_visit('%s')$$, current_setting('t.m3')), 'PERMISSION_DENIED%',
  'F6 the area manager cannot remove a visit the sales director planned');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a5');
select throws_like(format($$select api.unplan_visit('%s')$$, current_setting('t.m3')), 'PERMISSION_DENIED%',
  'F6 another rep still cannot remove it');
-- A visit with no recorded planner (planned before this change) keeps the old rule.
select tests.clear_authentication();
insert into field.visits (id, customer_id, employee_id, planned_for, status) values
  ('53a00000-0000-0000-0000-000000000011','5300c000-0000-0000-0000-000000000004','20000000-0000-0000-0000-000000000004', pg_temp.d(13), 'planned');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is(api.unplan_visit('53a00000-0000-0000-0000-000000000011') ->> 'status', 'cancelled',
  'F6 a visit with no recorded planner can still be removed by the rep');

-- ===========================================================================
-- F2: the generator is linear, caps customers per call and survives a flooded month
-- ===========================================================================
-- 2,005 class-A customers for the new hire (E009); 300 of them already have a visit on every day of next month.
select tests.clear_authentication();
set local session_replication_role = replica;  -- bulk fixture rows without audit/outbox triggers
insert into crm.customers (id, customer_no, doctor_name, display_name, territory_id, lifecycle_stage)
select ('5310c000-0000-0000-0000-' || lpad(g::text, 12, '0'))::uuid, 'C-B' || lpad(g::text, 4, '0'), 'Dr ' || g, 'Bulk ' || g,
       '10000000-0000-0000-0000-000000000003', 'active'
from generate_series(1, 2005) g;
insert into crm.customer_assignments (customer_id, employee_id)
select ('5310c000-0000-0000-0000-' || lpad(g::text, 12, '0'))::uuid, '20000000-0000-0000-0000-000000000009' from generate_series(1, 2005) g;
insert into field.visit_frequencies (customer_id, visit_class)
select ('5310c000-0000-0000-0000-' || lpad(g::text, 12, '0'))::uuid, 'A' from generate_series(1, 2005) g;
set local session_replication_role = origin;
analyze crm.customers; analyze crm.customer_assignments; analyze field.visits;
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a3');
select set_config('t.gen2', api.generate_plan('20000000-0000-0000-0000-000000000009', pg_temp.next_month())::text, true);
select ok((pg_temp.g('gen2') ->> 'customers')::int = 1000 and (pg_temp.g('gen2') ->> 'customers_skipped')::int = 1005,
  'F2 one call plans at most 1,000 customers and says how many it left out');
select ok(jsonb_array_length(pg_temp.g('gen2') -> 'proposals') > 0
          and (select bool_and((d ->> 'existing')::int + (d ->> 'proposed')::int <= 8) from jsonb_array_elements(pg_temp.g('gen2') -> 'days') d),
  'F2 the capped run still fills the month within the daily cap');
select set_config('t.ms1', pg_temp.ms($$select api.generate_plan('20000000-0000-0000-0000-000000000009', pg_temp.next_month())$$)::text, true);
select ok(current_setting('t.ms1')::numeric < 3000, format('F2 2,005 customers, empty month: %s ms (was over 5 s)', current_setting('t.ms1')));
select tests.clear_authentication();
set local session_replication_role = replica;
insert into field.visits (id, customer_id, employee_id, planned_for, status)
select gen_random_uuid(), ('5310c000-0000-0000-0000-' || lpad(c::text, 12, '0'))::uuid, '20000000-0000-0000-0000-000000000009', d::date, 'planned'
from generate_series(1, 300) c
cross join generate_series(pg_temp.next_month(), (pg_temp.next_month() + interval '1 month')::date - 1, interval '1 day') d;
set local session_replication_role = origin;
analyze field.visits;
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a3');
select set_config('t.ms2', pg_temp.ms($$select api.generate_plan('20000000-0000-0000-0000-000000000009', pg_temp.next_month())$$)::text, true);
select ok(current_setting('t.ms2')::numeric < 3000, format('F2 the same after ~9,000 visits flood the month: %s ms (was over 30 s)', current_setting('t.ms2')));
select is((select count(*)::int from jsonb_array_elements(api.generate_plan('20000000-0000-0000-0000-000000000009', pg_temp.next_month()) -> 'days') d
           where (d ->> 'proposed')::int > 0), 0, 'F2 a month whose days are all full gets no proposals');

-- ===========================================================================
-- F9: coverage scope for every fixture role, and speed
-- ===========================================================================
select tests.clear_authentication();
create temp table cov_scope (who text, can_read boolean, rls_only text[], cov_only text[]);
grant all on cov_scope to authenticated;
do $$ declare u text; begin
  foreach u in array array['a1','a2','a3','a4','a5','a6','a7','a8'] loop
    perform tests.authenticate_as(('00000000-0000-0000-0000-0000000000' || u)::uuid);
    insert into cov_scope select u, authz.has_permission('field.visit.read'),
      array(select customer_no from crm.customers where archived_at is null and lifecycle_stage <> 'lost'
            except select customer_no from api.coverage(pg_temp.d(-30), pg_temp.d(0))),
      array(select customer_no from api.coverage(pg_temp.d(-30), pg_temp.d(0))
            except select customer_no from crm.customers);
    perform tests.clear_authentication();
  end loop; end $$;
select is((select count(*)::int from cov_scope where cardinality(cov_only) > 0), 0,
  'F9 for all 8 fixture roles, coverage shows no customer that crm.customers RLS hides');
select is((select string_agg(who, ',' order by who) from cov_scope where can_read and cardinality(rls_only) = 0),
          (select string_agg(who, ',' order by who) from cov_scope where can_read),
  'F9 and every role that reads visits sees exactly its readable customers');
-- 10,000 customers and 100,000 completed visits, read by the owner.
set local session_replication_role = replica;
insert into crm.customers (id, customer_no, doctor_name, display_name, territory_id, lifecycle_stage)
select ('5320c000-0000-0000-0000-' || lpad(g::text, 12, '0'))::uuid, 'C-Z' || lpad(g::text, 5, '0'), 'Dr ' || g, 'Cov ' || g,
       '10000000-0000-0000-0000-000000000003', 'active'
from generate_series(1, 10000) g;
insert into crm.customer_assignments (customer_id, employee_id)
select ('5320c000-0000-0000-0000-' || lpad(g::text, 12, '0'))::uuid, '20000000-0000-0000-0000-000000000004' from generate_series(1, 10000) g;
insert into field.visits (id, customer_id, employee_id, status, check_in_at, check_in_received_at, check_out_at, verification_status)
select gen_random_uuid(), ('5320c000-0000-0000-0000-' || lpad((1 + g % 10000)::text, 12, '0'))::uuid,
       '20000000-0000-0000-0000-000000000004', 'completed',
       now() - (g % 300) * interval '1 day', now() - (g % 300) * interval '1 day', now() - (g % 300) * interval '1 day' + interval '20 minutes', 'verified'
from generate_series(1, 100000) g;
insert into field.visits (id, customer_id, employee_id, planned_for, status)
select gen_random_uuid(), ('5320c000-0000-0000-0000-' || lpad(g::text, 12, '0'))::uuid, '20000000-0000-0000-0000-000000000004',
       pg_temp.d(1 + g % 20), 'planned'
from generate_series(1, 10000, 3) g;
set local session_replication_role = origin;
analyze crm.customers; analyze crm.customer_assignments; analyze field.visits;
-- The reference: last visit, visit-days in the period and next plan, computed directly per customer.
create temp table cov_ref as
select c.id,
       (select max((v.check_in_at at time zone 'Africa/Cairo')::date) from field.visits v
         where v.customer_id = c.id and v.status = 'completed' and (v.check_in_at at time zone 'Africa/Cairo')::date <= core.business_date()) as last_on,
       (select count(distinct (v.check_in_at at time zone 'Africa/Cairo')::date)::int from field.visits v
         where v.customer_id = c.id and v.status = 'completed'
           and (v.check_in_at at time zone 'Africa/Cairo')::date between pg_temp.d(-366) and pg_temp.d(0)) as done,
       (select min(v.planned_for) from field.visits v where v.customer_id = c.id and v.status = 'planned'
           and v.planned_for >= core.business_date()) as next_plan
from crm.customers c where c.archived_at is null and c.lifecycle_stage <> 'lost';
grant select on cov_ref to authenticated;
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');
select set_config('t.ms3', pg_temp.ms($$select count(*) from api.coverage(pg_temp.d(-366), pg_temp.d(0))$$)::text, true);
select ok(current_setting('t.ms3')::numeric < 2500, format('F9 owner, 10,000 customers over 367 days: %s ms (was over 5 s)', current_setting('t.ms3')));
select set_config('t.ms4', pg_temp.ms($$select count(*) from (select * from api.v_coverage order by customer_no limit 50) x$$)::text, true);
select ok(current_setting('t.ms4')::numeric < 2500, format('F9 owner, first page of v_coverage: %s ms (was over 5 s)', current_setting('t.ms4')));
select is((select count(*)::int from api.coverage(pg_temp.d(-366), pg_temp.d(0)) k
           join cov_ref r on r.id = k.customer_id
           where k.last_visit_on is distinct from r.last_on or k.actual_visits is distinct from r.done
              or k.next_planned_on is distinct from r.next_plan), 0,
  'F9 the single grouped pass gives the same last visit, visit-days and next plan for every customer');
select is((select count(*)::int from api.coverage(pg_temp.d(-366), pg_temp.d(0))), (select count(*)::int from cov_ref),
  'F9 and the same customers');

select * from finish();
rollback;
