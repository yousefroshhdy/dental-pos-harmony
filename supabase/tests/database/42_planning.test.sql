-- Visit planning and coverage: the field.visit.plan permission and settings, visit frequency (managers
-- only, in scope), api.plan_visits (idempotency, own/team scope, assignment, no past days, duplicates,
-- all-or-nothing, notifications and outbox), api.unplan_visit (state, past day, scope, replay),
-- api.generate_plan (working days, daily cap incl. existing visits, existing plans cover occurrences,
-- nothing written), coverage math (target vs visit-days, overdue, visits by anyone, scope) and the views.
begin;
select tests.load_fixture();
select plan(101);

-- Fixture ids: E004 rep Cairo (user a4, manager E003 = area mgr a3, whose manager is E002 = sales
-- director a2); E005 rep Delta (user a5, manager E002); E009 new hire (no login, manager E003).
create function pg_temp.d(n int) returns date language sql stable as $$ select core.business_date() + n $$;
create function pg_temp.at(n int, hhmm text) returns timestamptz language sql stable as $$
  select ((core.business_date() + n) + hhmm::time) at time zone 'Africa/Cairo' $$;
create function pg_temp.next_month() returns date language sql stable as $$
  select (date_trunc('month', core.business_date()) + interval '1 month')::date $$;
-- First day of next month whose day of week is in p_dows (0 = Sunday).
create function pg_temp.first_day(p_dows int[]) returns date language sql stable as $$
  select min(g::date) from generate_series(pg_temp.next_month(), pg_temp.next_month() + 13, interval '1 day') g
  where extract(dow from g)::int = any(p_dows) $$;
create function pg_temp.g(k text) returns jsonb language sql stable as $$ select current_setting('t.' || k)::jsonb $$;

-- Extra customers in Nasr City. K1–K3 assigned to the Cairo rep (E004), K4 unassigned, K5 archived,
-- K6 lost. G01–G30 assigned to the new hire (E009): G01–G12 class A, G13–G20 class B, the rest default.
insert into crm.customers (id, customer_no, doctor_name, display_name, territory_id, lifecycle_stage, archived_at) values
  ('42000000-0000-0000-0000-000000000001','C-4201','Dr. K1','Synthetic K1','10000000-0000-0000-0000-000000000003','active',null),
  ('42000000-0000-0000-0000-000000000002','C-4202','Dr. K2','Synthetic K2','10000000-0000-0000-0000-000000000003','active',null),
  ('42000000-0000-0000-0000-000000000003','C-4203','Dr. K3','Synthetic K3','10000000-0000-0000-0000-000000000003','lead',null),
  ('42000000-0000-0000-0000-000000000004','C-4204','Dr. K4','Synthetic K4','10000000-0000-0000-0000-000000000003','active',null),
  ('42000000-0000-0000-0000-000000000005','C-4205','Dr. K5','Synthetic K5','10000000-0000-0000-0000-000000000003','active',now()),
  ('42000000-0000-0000-0000-000000000006','C-4206','Dr. K6','Synthetic K6','10000000-0000-0000-0000-000000000003','lost',null);
insert into crm.customer_assignments (customer_id, employee_id) values
  ('42000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000004'),
  ('42000000-0000-0000-0000-000000000002','20000000-0000-0000-0000-000000000004'),
  ('42000000-0000-0000-0000-000000000003','20000000-0000-0000-0000-000000000004'),
  ('42000000-0000-0000-0000-000000000005','20000000-0000-0000-0000-000000000004'),
  ('42000000-0000-0000-0000-000000000006','20000000-0000-0000-0000-000000000004');
insert into crm.customers (id, customer_no, doctor_name, display_name, territory_id, lifecycle_stage)
select ('42100000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid, 'C-G' || lpad(n::text, 2, '0'),
       'Dr. G' || n, 'Synthetic G' || lpad(n::text, 2, '0'), '10000000-0000-0000-0000-000000000003', 'active'
from generate_series(1, 30) n;
insert into crm.customer_assignments (customer_id, employee_id)
select ('42100000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid, '20000000-0000-0000-0000-000000000009'
from generate_series(1, 30) n;
insert into field.visit_frequencies (customer_id, visit_class)
select ('42100000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid, case when n <= 12 then 'A' else 'B' end
from generate_series(1, 20) n;

-- ===========================================================================
-- Reference data and privileges
-- ===========================================================================
select is((select count(*)::int from authz.role_permissions rp join authz.roles r on r.id = rp.role_id
           where (r.code, rp.permission_code, rp.scope) in (('sales_rep','field.visit.plan','own'),
                 ('area_manager','field.visit.plan','team'), ('sales_director','field.visit.plan','team'))), 3,
  'reps plan for themselves, managers for their team');
select is((select value from core.system_settings where key = 'planning.visit_interval_days'), '{"A":7,"B":14,"C":30}'::jsonb,
  'class intervals: A weekly, B every 2 weeks, C monthly');
select is((select value #>> '{}' from core.system_settings where key = 'planning.daily_visit_cap'), '8', 'default daily cap is 8');
select ok(not has_function_privilege('anon', 'api.plan_visits(uuid, jsonb, uuid)', 'execute')
          and has_function_privilege('authenticated', 'api.plan_visits(uuid, jsonb, uuid)', 'execute')
          and has_function_privilege('authenticated', 'api.generate_plan(uuid, date)', 'execute')
          and not has_function_privilege('anon', 'api.coverage(date, date)', 'execute'),
  'commands are callable by signed-in users only');
select ok(not has_function_privilege('authenticated', 'field.planning_lock(text)', 'execute')
          and not has_function_privilege('authenticated', 'field.planning_check_employee(uuid)', 'execute')
          and not has_function_privilege('authenticated', 'field.planning_interval_value(jsonb, text, int)', 'execute'),
  'internal planning helpers are not client-callable');
select ok(not has_function_privilege('authenticated', 'api.post_inventory_adjustment(uuid, uuid, uuid, int, text, text)', 'execute'),
  'this migration does not re-open functions closed earlier');

-- ===========================================================================
-- Visit frequency: managers only, customers in scope
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select throws_like($$select api.set_visit_frequency('42000000-0000-0000-0000-000000000001', 'A')$$,
  'PERMISSION_DENIED%', 'a rep cannot change a customer''s visit frequency (own scope)');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a3');
select is(api.set_visit_frequency('42000000-0000-0000-0000-000000000001', 'A') ->> 'interval_days', '7',
  'the area manager sets class A (weekly)');
select is(api.set_visit_frequency('42000000-0000-0000-0000-000000000002', 'B') ->> 'interval_days', '14',
  'and class B (every two weeks)');
select throws_like($$select api.set_visit_frequency('42000000-0000-0000-0000-000000000001', 'D')$$,
  'VALIDATION%', 'only classes A, B and C exist');
select throws_like($$select api.set_visit_frequency('40000000-0000-0000-0000-000000000002', 'A')$$,
  'PERMISSION_DENIED%', 'the Cairo manager cannot set a Delta customer''s frequency');
select throws_like($$select api.set_visit_frequency('42000000-0000-0000-0000-000000000005', 'A')$$,
  'INVALID_STATE%', 'an archived customer gets no frequency');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is((select count(*)::int from field.visit_frequencies
           where customer_id in ('42000000-0000-0000-0000-000000000001','42000000-0000-0000-0000-000000000002')), 2,
  'the rep reads the frequencies of their own customers');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a5');
select is((select count(*)::int from field.visit_frequencies), 0, 'another rep reads none of them');
select tests.clear_authentication();
select is((select count(*)::int from audit.audit_log where table_name = 'visit_frequencies'
           and new_data ->> 'customer_id' in ('42000000-0000-0000-0000-000000000001','42000000-0000-0000-0000-000000000002')), 2,
  'frequency changes are audited');

-- ===========================================================================
-- plan_visits: a rep plans for themselves
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select set_config('t.p1', api.plan_visits(null, jsonb_build_array(
  jsonb_build_object('customer_id','42000000-0000-0000-0000-000000000001','date',pg_temp.d(1)),
  jsonb_build_object('customer_id','42000000-0000-0000-0000-000000000002','date',pg_temp.d(1))),
  '42e00000-0000-0000-0000-000000000001')::text, true);
select ok(pg_temp.g('p1') ->> 'created' = '2' and pg_temp.g('p1') ->> 'replayed' = 'false'
          and pg_temp.g('p1') ->> 'employee_id' = '20000000-0000-0000-0000-000000000004',
  'the rep plans two visits for tomorrow (employee defaults to the caller)');
select is((select count(*)::int from field.visits where employee_id = '20000000-0000-0000-0000-000000000004'
           and status = 'planned' and planned_for = pg_temp.d(1)), 2, 'two planned visits exist');
select is((api.plan_visits(null, jsonb_build_array(
  jsonb_build_object('customer_id','42000000-0000-0000-0000-000000000001','date',pg_temp.d(1)),
  jsonb_build_object('customer_id','42000000-0000-0000-0000-000000000002','date',pg_temp.d(1))),
  '42e00000-0000-0000-0000-000000000001') - 'replayed'), pg_temp.g('p1') - 'replayed',
  'a replay with the same client_ref returns the same answer (same visit ids)');
select is((api.plan_visits(null, '[]'::jsonb, '42e00000-0000-0000-0000-000000000001') ->> 'replayed'), 'true',
  'and is flagged as a replay, whatever the body');
select is((select count(*)::int from field.visits where employee_id = '20000000-0000-0000-0000-000000000004'
           and status = 'planned' and planned_for = pg_temp.d(1)), 2, 'replays create nothing');
select throws_like($$select count(*) from field.visit_plan_batches$$, '%permission denied%',
  'plan batches are not readable by clients');
select tests.clear_authentication();
select is((select count(*)::int from field.visit_plan_batches where client_ref = '42e00000-0000-0000-0000-000000000001'), 1,
  'the batch is stored once');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select throws_like(format($$select api.plan_visits('20000000-0000-0000-0000-000000000005',
  '[{"customer_id":"40000000-0000-0000-0000-000000000002","date":"%s"}]', '42e00000-0000-0000-0000-000000000002')$$, pg_temp.d(1)),
  'PERMISSION_DENIED%', 'a rep cannot plan for another rep');
select throws_like(format($$select api.plan_visits(null,
  '[{"customer_id":"42000000-0000-0000-0000-000000000003","date":"%s"}]', '42e00000-0000-0000-0000-000000000003')$$, pg_temp.d(-1)),
  'PAST_DATE%', 'a past day (Cairo) cannot be planned');
select throws_like(format($$select api.plan_visits(null,
  '[{"customer_id":"42000000-0000-0000-0000-000000000004","date":"%s"}]', '42e00000-0000-0000-0000-000000000004')$$, pg_temp.d(2)),
  'NOT_ASSIGNED%', 'the customer must be assigned to the planned employee');
select throws_like(format($$select api.plan_visits(null,
  '[{"customer_id":"42000000-0000-0000-0000-000000000001","date":"%s"}]', '42e00000-0000-0000-0000-000000000005')$$, pg_temp.d(1)),
  'DUPLICATE%', 'the same customer cannot be planned twice for one day');
select throws_like(format($$select api.plan_visits(null,
  '[{"customer_id":"42000000-0000-0000-0000-000000000003","date":"%1$s"},{"customer_id":"42000000-0000-0000-0000-000000000003","date":"%1$s"}]',
  '42e00000-0000-0000-0000-000000000006')$$, pg_temp.d(3)),
  'DUPLICATE%', 'nor twice in one request');
select throws_like(format($$select api.plan_visits(null,
  '[{"customer_id":"42000000-0000-0000-0000-000000000005","date":"%s"}]', '42e00000-0000-0000-0000-000000000007')$$, pg_temp.d(2)),
  'INVALID_STATE%', 'an archived customer cannot be planned');
select throws_like($$select api.plan_visits(null, '[]', '42e00000-0000-0000-0000-000000000008')$$,
  'VALIDATION%', 'an empty plan is refused');
select throws_like($$select api.plan_visits(null, '[{"customer_id":"42000000-0000-0000-0000-000000000003"}]', '42e00000-0000-0000-0000-000000000009')$$,
  'VALIDATION%', 'each visit needs a date');
select throws_like(format($$select api.plan_visits(null,
  '[{"customer_id":"42000000-0000-0000-0000-000000000003","date":"%s"}]', null)$$, pg_temp.d(2)),
  'VALIDATION%', 'a client_ref is required');
select throws_like(format($$select api.plan_visits(null,
  '[{"customer_id":"42000000-0000-0000-0000-000000000003","date":"%s"},{"customer_id":"42000000-0000-0000-0000-000000000004","date":"%s"}]',
  '42e00000-0000-0000-0000-000000000010')$$, pg_temp.d(4), pg_temp.d(4)),
  'NOT_ASSIGNED%', 'one bad visit fails the request');
select is((select count(*)::int from field.visits where customer_id = '42000000-0000-0000-0000-000000000003'
           and planned_for = pg_temp.d(4)), 0, 'all or nothing: the valid visit was not kept');
select set_config('t.p2', api.plan_visits(null, jsonb_build_array(
  jsonb_build_object('customer_id','42000000-0000-0000-0000-000000000003','date',pg_temp.d(0))),
  '42e00000-0000-0000-0000-000000000011')::text, true);
select is(pg_temp.g('p2') ->> 'created', '1', 'today can be planned');
select ok(exists (select 1 from api.v_my_today where item_type = 'visit'
                  and item_id = (pg_temp.g('p2') -> 'visits' -> 0 ->> 'visit_id')::uuid),
  'today''s planned visit shows on the rep''s day');
select is((select count(*)::int from notify.notifications where type like 'planning.%'), 0,
  'planning for oneself notifies nobody');

-- ===========================================================================
-- plan_visits: managers plan for their team only
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a3');
select throws_like(format($$select api.plan_visits(null,
  '[{"customer_id":"42000000-0000-0000-0000-000000000001","date":"%s"}]', '42e00000-0000-0000-0000-000000000001')$$, pg_temp.d(2)),
  'CONFLICT%', 'another user cannot reuse a client_ref');
select is(api.plan_visits('20000000-0000-0000-0000-000000000004', jsonb_build_array(
  jsonb_build_object('customer_id','42000000-0000-0000-0000-000000000001','date',pg_temp.d(2))),
  '42e00000-0000-0000-0000-000000000012') ->> 'created', '1', 'the area manager plans a visit for a rep in the team');
select throws_like(format($$select api.plan_visits('20000000-0000-0000-0000-000000000005',
  '[{"customer_id":"40000000-0000-0000-0000-000000000002","date":"%s"}]', '42e00000-0000-0000-0000-000000000013')$$, pg_temp.d(1)),
  'PERMISSION_DENIED%', 'but not for a rep outside the team');
select throws_like(format($$select api.plan_visits('20000000-0000-0000-0000-000000000004',
  '[{"customer_id":"42100000-0000-0000-0000-000000000001","date":"%s"}]', '42e00000-0000-0000-0000-000000000014')$$, pg_temp.d(1)),
  'NOT_ASSIGNED%', 'the manager also needs the customer assigned to that rep');
select ok(exists (select 1 from api.v_visit_plan where employee_id = '20000000-0000-0000-0000-000000000004'
                  and customer_id = '42000000-0000-0000-0000-000000000001' and planned_for = pg_temp.d(2)),
  'the manager sees the team plan');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a2');
select is(api.plan_visits('20000000-0000-0000-0000-000000000005', jsonb_build_array(
  jsonb_build_object('customer_id','40000000-0000-0000-0000-000000000002','date',pg_temp.d(1))),
  '42e00000-0000-0000-0000-000000000015') ->> 'created', '1', 'the sales director plans for a direct report');
select tests.clear_authentication();
select is((select count(*)::int from notify.notifications where type = 'planning.visits_planned'
           and recipient_user_id in ('00000000-0000-0000-0000-0000000000a4','00000000-0000-0000-0000-0000000000a5')), 2,
  'the planned rep is notified when someone else plans for them');
select is((select count(*)::int from integration.outbox where event_type = 'field.visits_planned'), 4,
  'every accepted plan writes one outbox event (replays do not)');
select throws_ok(format($$insert into field.visits (id, customer_id, employee_id, planned_for, status)
  values (gen_random_uuid(), '42000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000004', '%s', 'planned')$$, pg_temp.d(1)),
  '23505', null, 'a unique index backs the one-plan-per-day rule');

-- ===========================================================================
-- Views: the week plan and who can be planned for
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is((select count(*)::int from api.v_visit_plan), 4, 'the rep sees their four planned visits');
select ok((select bool_and(week_start = planned_for - extract(dow from planned_for)::int and extract(dow from week_start) = 0
                           and day_of_week = extract(dow from planned_for)::int)
           from api.v_visit_plan), 'weeks start on Sunday');
select is((select visit_class from api.v_visit_plan where customer_id = '42000000-0000-0000-0000-000000000003' limit 1), 'C',
  'a customer without a class shows the default class');
select ok((select bool_and(can_unplan) from api.v_visit_plan), 'future planned visits can be removed');
select is((select string_agg(id::text || ':' || is_me, ',') from api.v_planning_employees),
  '20000000-0000-0000-0000-000000000004:true', 'a rep can plan only for themselves');
select is((select count(*)::int from api.v_planning_customers where employee_id = '20000000-0000-0000-0000-000000000004'), 4,
  'the add-visit picker lists the rep''s open, non-archived, non-lost customers');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a5');
select is((select count(*)::int from api.v_visit_plan where employee_id = '20000000-0000-0000-0000-000000000004'), 0,
  'another rep sees none of them');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a3');
select is((select string_agg(employee_no, ',' order by employee_no) from api.v_planning_employees), 'E003,E004,E009',
  'the area manager can plan for self and the team');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a2');
select is((select string_agg(employee_no, ',' order by employee_no) from api.v_planning_employees), 'E002,E003,E004,E005,E009',
  'the sales director''s team is the whole reporting line');

-- ===========================================================================
-- unplan_visit
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select set_config('t.k2', (select id::text from field.visits where customer_id = '42000000-0000-0000-0000-000000000002'
                           and planned_for = pg_temp.d(1)), true);
select is(api.unplan_visit(current_setting('t.k2')::uuid) ->> 'replayed', 'false', 'the rep removes a planned visit');
select is((select status from field.visits where id = current_setting('t.k2')::uuid), 'cancelled', 'it is cancelled, not deleted');
select is(api.unplan_visit(current_setting('t.k2')::uuid) ->> 'replayed', 'true', 'removing it again is an idempotent replay');
select is((api.plan_visits(null, jsonb_build_array(
  jsonb_build_object('customer_id','42000000-0000-0000-0000-000000000002','date',pg_temp.d(1))),
  '42e00000-0000-0000-0000-000000000016') ->> 'created'), '1', 'a removed day can be planned again');
select lives_ok(format($$select api.visit_check_in('%s', '42000000-0000-0000-0000-000000000003', 30.05, 31.24, 10, now(), '{}')$$,
  pg_temp.g('p2') -> 'visits' -> 0 ->> 'visit_id'), 'the rep checks in on today''s planned visit');
select throws_like(format($$select api.unplan_visit('%s')$$, pg_temp.g('p2') -> 'visits' -> 0 ->> 'visit_id'),
  'INVALID_STATE%', 'a checked-in visit cannot be removed');
select tests.clear_authentication();
insert into field.visits (id, customer_id, employee_id, planned_for, status) values
  ('42a00000-0000-0000-0000-000000000001','42000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000004', pg_temp.d(-2), 'planned');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select throws_like($$select api.unplan_visit('42a00000-0000-0000-0000-000000000001')$$,
  'PAST_DATE%', 'a past day''s planned visit cannot be removed (it is a missed visit)');
select throws_like($$select api.unplan_visit('42a00000-0000-0000-0000-0000000000ff')$$, 'NOT_FOUND%', 'an unknown visit is not found');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a5');
select throws_like(format($$select api.unplan_visit('%s')$$, pg_temp.g('p1') -> 'visits' -> 0 ->> 'visit_id'),
  'PERMISSION_DENIED%', 'another rep cannot remove the visit');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a3');
select is(api.unplan_visit((pg_temp.g('p1') -> 'visits' -> 0 ->> 'visit_id')::uuid) ->> 'status', 'cancelled',
  'the rep''s manager can remove it');
select tests.clear_authentication();
select is((select count(*)::int from notify.notifications where type = 'planning.visit_unplanned'
           and recipient_user_id = '00000000-0000-0000-0000-0000000000a4'), 1, 'and the rep is told');
select is((select count(*)::int from integration.outbox where event_type = 'field.visit_unplanned'), 2,
  'each removal writes one outbox event (the replay does not)');

-- ===========================================================================
-- generate_plan: working days, daily cap, existing plans, nothing written
-- ===========================================================================
update core.system_settings set value = '2' where key = 'planning.daily_visit_cap';
-- Two visits already planned on the first working day of next month (G01 class A, G21 class C).
insert into field.visits (id, customer_id, employee_id, planned_for, status) values
  ('42a00000-0000-0000-0000-000000000011','42100000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000009', pg_temp.first_day('{0,1,2,3,4}'), 'planned'),
  ('42a00000-0000-0000-0000-000000000012','42100000-0000-0000-0000-000000000021','20000000-0000-0000-0000-000000000009', pg_temp.first_day('{0,1,2,3,4}'), 'planned');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select throws_like($$select api.generate_plan('20000000-0000-0000-0000-000000000009', pg_temp.next_month())$$,
  'PERMISSION_DENIED%', 'a rep cannot generate a plan for someone else');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a3');
select throws_like($$select api.generate_plan('20000000-0000-0000-0000-000000000009', (date_trunc('month', core.business_date()) - interval '1 month')::date)$$,
  'PAST_DATE%', 'a month that is over cannot be planned');
select set_config('t.g1', api.generate_plan('20000000-0000-0000-0000-000000000009', pg_temp.next_month())::text, true);
select ok(jsonb_array_length(pg_temp.g('g1') -> 'proposals') > 0 and pg_temp.g('g1') ->> 'customers' = '30'
          and pg_temp.g('g1') ->> 'daily_cap' = '2' and pg_temp.g('g1') ->> 'month' = pg_temp.next_month()::text,
  'the manager gets a proposal for the new hire''s 30 customers next month');
select ok((select bool_and(extract(dow from (p ->> 'date')::date) between 0 and 4) from jsonb_array_elements(pg_temp.g('g1') -> 'proposals') p),
  'every proposed day is a working day (Sunday to Thursday)');
select ok((select bool_and((p ->> 'date')::date between pg_temp.next_month() and (pg_temp.next_month() + interval '1 month')::date - 1)
           from jsonb_array_elements(pg_temp.g('g1') -> 'proposals') p), 'every proposed day is in the month');
select is((select max(x.n + (select count(*) from field.visits v where v.employee_id = '20000000-0000-0000-0000-000000000009'
                                and v.status <> 'cancelled' and v.planned_for = x.d))::int
           from (select (p ->> 'date')::date as d, count(*) as n
                 from jsonb_array_elements(pg_temp.g('g1') -> 'proposals') p group by 1) x), 2,
  'no day exceeds the daily cap, existing visits included');
select ok((select bool_and((d ->> 'existing')::int + (d ->> 'proposed')::int <= 2) from jsonb_array_elements(pg_temp.g('g1') -> 'days') d)
          and (select count(*) from jsonb_array_elements(pg_temp.g('g1') -> 'days') d where extract(dow from (d ->> 'date')::date) in (5,6)) = 0,
  'the day summary lists working days only, each within the cap');
select is((select (d ->> 'existing') || '/' || (d ->> 'proposed') from jsonb_array_elements(pg_temp.g('g1') -> 'days') d
           where (d ->> 'date')::date = pg_temp.first_day('{0,1,2,3,4}')), '2/0', 'a day that is already full gets nothing more');
select ok(jsonb_array_length(pg_temp.g('g1') -> 'unscheduled') > 0
          and (select bool_and(u ->> 'reason' = 'no_capacity') from jsonb_array_elements(pg_temp.g('g1') -> 'unscheduled') u),
  'visits that do not fit under the cap are reported, not squeezed in');
select is((select count(*)::int from (select 1 from jsonb_array_elements(pg_temp.g('g1') -> 'proposals') p
                                       group by p ->> 'customer_id', p ->> 'date' having count(*) > 1) x), 0,
  'no customer is proposed twice on one day');
select ok((select min((p ->> 'date')::date) from jsonb_array_elements(pg_temp.g('g1') -> 'proposals') p
           where p ->> 'customer_id' = '42100000-0000-0000-0000-000000000001') >= pg_temp.first_day('{0,1,2,3,4}') + 6
          and not exists (select 1 from jsonb_array_elements(pg_temp.g('g1') -> 'proposals') p
                          where p ->> 'customer_id' = '42100000-0000-0000-0000-000000000021'
                            and (p ->> 'date')::date < pg_temp.first_day('{0,1,2,3,4}') + 23),
  'an existing plan covers the occurrence: weekly G01 comes again about a week later, monthly G21 about a month later');
select ok((select bool_and(exists (select 1 from crm.customer_assignments a where a.customer_id = (p ->> 'customer_id')::uuid
                                   and a.employee_id = '20000000-0000-0000-0000-000000000009' and a.valid_to is null))
           from jsonb_array_elements(pg_temp.g('g1') -> 'proposals') p), 'only the employee''s own customers are proposed');
select ok((select count(*) from jsonb_array_elements(pg_temp.g('g1') -> 'proposals') p where p ->> 'visit_class' = 'A')
          > (select count(*) from jsonb_array_elements(pg_temp.g('g1') -> 'proposals') p where p ->> 'visit_class' = 'C'),
  'weekly customers get more visits than monthly ones');
select is((select count(*)::int from field.visits where employee_id = '20000000-0000-0000-0000-000000000009'), 2,
  'generating writes nothing');
select is(api.plan_visits('20000000-0000-0000-0000-000000000009',
  (select jsonb_agg(jsonb_build_object('customer_id', p ->> 'customer_id', 'date', p ->> 'date'))
   from (select p from jsonb_array_elements(pg_temp.g('g1') -> 'proposals') p limit 5) x),
  '42e00000-0000-0000-0000-000000000020') ->> 'created', '5', 'a reviewed proposal is saved with plan_visits');
select set_config('t.g2', api.generate_plan('20000000-0000-0000-0000-000000000009', pg_temp.next_month())::text, true);
select ok(not exists (select 1 from jsonb_array_elements(pg_temp.g('g2') -> 'proposals') p
                      join field.visits v on v.customer_id = (p ->> 'customer_id')::uuid and v.planned_for = (p ->> 'date')::date
                       and v.employee_id = '20000000-0000-0000-0000-000000000009' and v.status <> 'cancelled'),
  'a second run does not propose what is already planned');
select tests.clear_authentication();
update core.system_settings set value = '["mon","wed"]' where key = 'planning.work_days';
update core.system_settings set value = '8' where key = 'planning.daily_visit_cap';
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a3');
select set_config('t.g3', api.generate_plan('20000000-0000-0000-0000-000000000009', pg_temp.next_month())::text, true);
select ok((select bool_and(extract(dow from (p ->> 'date')::date) in (1, 3)) from jsonb_array_elements(pg_temp.g('g3') -> 'proposals') p)
          and pg_temp.g('g3') -> 'work_days' = '["mon","wed"]'::jsonb,
  'the generator follows the working-days setting');
select ok((select max(x.n + (select count(*) from field.visits v where v.employee_id = '20000000-0000-0000-0000-000000000009'
                                and v.status <> 'cancelled' and v.planned_for = x.d))
           from (select (p ->> 'date')::date as d, count(*) as n
                 from jsonb_array_elements(pg_temp.g('g3') -> 'proposals') p group by 1) x) <= 8,
  'and the cap setting');
select tests.clear_authentication();
update core.system_settings set value = '["sun","mon","tue","wed","thu"]' where key = 'planning.work_days';
-- Spread: a fresh, empty month with a high cap spreads never-visited customers instead of piling them up.
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a3');
select set_config('t.g4', api.generate_plan('20000000-0000-0000-0000-000000000009', (pg_temp.next_month() + interval '1 month')::date)::text, true);
select ok((select count(distinct p ->> 'date') from jsonb_array_elements(pg_temp.g('g4') -> 'proposals') p) >= 10
          and jsonb_array_length(pg_temp.g('g4') -> 'unscheduled') = 0,
  'with room to spare, every visit is scheduled and they are spread over the month');

-- ===========================================================================
-- Coverage: target vs visit-days in the period, overdue, scope
-- ===========================================================================
-- K1 (class A, 7 days): last visit 10 days ago → overdue by 3. K2 (class B, 14 days): visits 25 and
-- 10 days ago (twice that day: counts once) → 2 of 2, not overdue. K3 (default C): never completed.
select tests.clear_authentication();
insert into field.visits (id, customer_id, employee_id, status, check_in_at, check_out_at, verification_status) values
  ('42a00000-0000-0000-0000-000000000021','42000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000004','completed',pg_temp.at(-10,'10:00'),pg_temp.at(-10,'10:30'),'verified'),
  ('42a00000-0000-0000-0000-000000000022','42000000-0000-0000-0000-000000000002','20000000-0000-0000-0000-000000000004','completed',pg_temp.at(-25,'09:00'),pg_temp.at(-25,'09:30'),'verified'),
  ('42a00000-0000-0000-0000-000000000023','42000000-0000-0000-0000-000000000002','20000000-0000-0000-0000-000000000004','completed',pg_temp.at(-10,'09:00'),pg_temp.at(-10,'09:20'),'verified'),
  ('42a00000-0000-0000-0000-000000000024','42000000-0000-0000-0000-000000000002','20000000-0000-0000-0000-000000000004','completed',pg_temp.at(-10,'16:00'),pg_temp.at(-10,'16:20'),'out_of_range'),
  ('42a00000-0000-0000-0000-000000000025','42000000-0000-0000-0000-000000000002','20000000-0000-0000-0000-000000000004','completed',pg_temp.at(-40,'09:00'),pg_temp.at(-40,'09:20'),'verified'),
  ('42a00000-0000-0000-0000-000000000026','42000000-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000004','cancelled',pg_temp.at(-1,'09:00'),null,'pending');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select set_config('t.cov', (select jsonb_object_agg(customer_no, to_jsonb(c)) from api.coverage(pg_temp.d(-29), pg_temp.d(0)) c)::text, true);
select is(pg_temp.g('cov') -> 'C-4201' ->> 'interval_days', '7', 'K1 is weekly');
select ok((pg_temp.g('cov') -> 'C-4201' ->> 'is_overdue')::boolean and pg_temp.g('cov') -> 'C-4201' ->> 'overdue_days' = '3'
          and pg_temp.g('cov') -> 'C-4201' ->> 'days_since_last_visit' = '10'
          and pg_temp.g('cov') -> 'C-4201' ->> 'last_visit_on' = pg_temp.d(-10)::text,
  'K1: last visit 10 days ago, 3 days overdue');
select is((pg_temp.g('cov') -> 'C-4201' ->> 'actual_visits') || '/' || (pg_temp.g('cov') -> 'C-4201' ->> 'target_visits'), '1/4',
  'K1: 1 of 4 weekly visits in 30 days (a cancelled visit does not count)');
select is((pg_temp.g('cov') -> 'C-4202' ->> 'actual_visits') || '/' || (pg_temp.g('cov') -> 'C-4202' ->> 'target_visits')
          || '/' || (pg_temp.g('cov') -> 'C-4202' ->> 'target_met'), '2/2/true',
  'K2: two visit-days in the period (two visits on one day count once; older ones are outside)');
select ok(not (pg_temp.g('cov') -> 'C-4202' ->> 'is_overdue')::boolean
          and pg_temp.g('cov') -> 'C-4202' ->> 'next_due_on' = pg_temp.d(4)::text
          and pg_temp.g('cov') -> 'C-4202' ->> 'next_planned_on' = pg_temp.d(1)::text,
  'K2: not overdue, next due in 4 days, already planned tomorrow');
select ok((pg_temp.g('cov') -> 'C-4203' ->> 'is_overdue')::boolean and pg_temp.g('cov') -> 'C-4203' -> 'last_visit_on' = 'null'::jsonb
          and pg_temp.g('cov') -> 'C-4203' -> 'overdue_days' = 'null'::jsonb
          and pg_temp.g('cov') -> 'C-4203' ->> 'visit_class' = 'C' and (pg_temp.g('cov') -> 'C-4203' ->> 'class_is_default')::boolean
          and (pg_temp.g('cov') -> 'C-4203' ->> 'actual_visits') || '/' || (pg_temp.g('cov') -> 'C-4203' ->> 'target_visits') = '0/1',
  'K3: never visited (an in-progress check-in is not a visit) = overdue, default class C, 0 of 1');
select ok(pg_temp.g('cov') -> 'C-4206' is null and pg_temp.g('cov') -> 'C-4205' is null and pg_temp.g('cov') -> 'C-4204' is null,
  'lost, archived and other reps'' customers are not in the rep''s coverage');
select is(pg_temp.g('cov') -> 'C-4201' ->> 'employee_id', '20000000-0000-0000-0000-000000000004', 'the rep is shown per customer');
select ok((select period_start = date_trunc('month', core.business_date())::date
                  and period_end = (date_trunc('month', core.business_date()) + interval '1 month')::date - 1
           from api.v_coverage where customer_no = 'C-4203'), 'v_coverage covers this month');
select throws_like($$select * from api.coverage(core.business_date(), core.business_date() - 1)$$, 'VALIDATION%',
  'the period must run forwards');
select tests.clear_authentication();
-- A visit by someone else (the manager) still covers the customer.
insert into field.visits (id, customer_id, employee_id, status, check_in_at, check_out_at, verification_status) values
  ('42a00000-0000-0000-0000-000000000027','42000000-0000-0000-0000-000000000003','20000000-0000-0000-0000-000000000003','completed',pg_temp.at(-1,'11:00'),pg_temp.at(-1,'11:30'),'verified');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select ok((select not is_overdue and last_visit_on = pg_temp.d(-1) from api.coverage(pg_temp.d(-29), pg_temp.d(0)) where customer_no = 'C-4203'),
  'a visit by another employee counts for the customer');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a3');
select is((select count(*)::int from api.v_coverage where employee_id = '20000000-0000-0000-0000-000000000009'), 30,
  'the manager sees the team''s customers');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a5');
select is((select count(*)::int from api.v_coverage where customer_no like 'C-42%' or customer_no like 'C-G%'), 0,
  'another territory''s rep sees none of them');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select is((select count(*)::int from api.v_coverage), 0, 'without field.visit.read (finance) coverage is empty');
select throws_like($$select api.planning_settings()$$, 'PERMISSION_DENIED%', 'and the planning settings are not shown');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select ok((select s ->> 'daily_cap' = '8' and s -> 'intervals' = '{"A":7,"B":14,"C":30}'::jsonb and s ->> 'default_class' = 'C'
                  and s ->> 'today' = core.business_date()::text and not (s ? 'work_dows') from api.planning_settings() s),
  'the planning settings are readable by planners');

select * from finish();
rollback;
