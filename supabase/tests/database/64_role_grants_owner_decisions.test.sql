-- The owner's role decisions of 2026-11-28 (migration 20261126000500_role_grants_owner_decisions.sql):
--   1. Commission adjustments: unchanged. Only owners request and decide them, and the requester never
--      decides their own request (a second owner approves; D-08).
--   2. The finance officer opens the company dashboard: perf.kpi.read at company-wide scope, and the
--      dashboard's reads (kpi_summary, kpi_team, kpi_breakdown, kpi_overdue_customers, approvals) work.
--      Nothing else is widened.
--   3. The collection officer works the field like a rep, for visits: start and end the day (tracking
--      notice first), send tracking points, check in and out, read their own visits and day. Every
--      field.* grant of the sales rep, at own scope; still no orders, leads or commissions.
--   4. The sales director reads tracking for the whole company (field.tracking.read and its export
--      team → all). The area manager and the rep keep their scope.
begin;
select tests.load_fixture();
set constraints all immediate;
select plan(57);

-- Fixture: a1 owner (E001); a2 sales director (E002); a3 area manager Cairo (E003, manager E002);
-- a4 rep Cairo (E004, manager E003, customer C-0001); a5 rep Delta (E005, manager E002, C-0002);
-- a6 finance officer (E006). Added here (synthetic): b1 collection officer (E0C1) and b2 a rep whose
-- manager is the owner (E0C2), so b2 is outside the sales director's team.
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000b1', 'collector@honest.test'),
  ('00000000-0000-0000-0000-0000000000b2', 'rep.outside@honest.test');
insert into core.employees (id, employee_no, user_id, full_name_en, job_title, manager_id) values
  ('20000000-0000-0000-0000-0000000000c1', 'E0C1', '00000000-0000-0000-0000-0000000000b1', 'Collector', 'Collection Officer',
   '20000000-0000-0000-0000-000000000001'),
  ('20000000-0000-0000-0000-0000000000c2', 'E0C2', '00000000-0000-0000-0000-0000000000b2', 'Rep Outside', 'Sales Representative',
   '20000000-0000-0000-0000-000000000001');
insert into core.user_profiles (user_id, employee_id) values
  ('00000000-0000-0000-0000-0000000000b1', '20000000-0000-0000-0000-0000000000c1'),
  ('00000000-0000-0000-0000-0000000000b2', '20000000-0000-0000-0000-0000000000c2');
insert into authz.user_roles (user_id, role_id)
select v.uid::uuid, r.id from (values ('00000000-0000-0000-0000-0000000000b1', 'collection_officer'),
                                      ('00000000-0000-0000-0000-0000000000b2', 'sales_rep')) v(uid, code)
join authz.roles r on r.code = v.code;

-- authz helpers are not client-callable: evaluate them for a user's claims as the test owner.
create function pg_temp.claims(p_user text) returns void language sql as $$
  select set_config('request.jwt.claims', coalesce(json_build_object('sub', p_user, 'role', 'authenticated')::text, ''), true),
         set_config('request.jwt.claim.sub', coalesce(p_user, ''), true)
$$;
create function pg_temp.req(p_user text, p_perm text) returns text language plpgsql as $$
declare r text := 'ok';
begin
  perform pg_temp.claims(p_user);
  begin perform authz.require(p_perm); exception when others then r := sqlerrm; end;
  perform pg_temp.claims(null);
  return r;
end $$;
create function pg_temp.has_global(p_user text, p_perm text) returns boolean language plpgsql as $$
declare r boolean;
begin
  perform pg_temp.claims(p_user); r := authz.has_global(p_perm); perform pg_temp.claims(null); return r;
end $$;
create function pg_temp.employee_ids(p_user text, p_perm text) returns uuid[] language plpgsql as $$
declare r uuid[];
begin
  perform pg_temp.claims(p_user); r := authz.employee_ids(p_perm); perform pg_temp.claims(null); return r;
end $$;

create function pg_temp.grants(p_role text, p_like text) returns text[] language sql as $$
  select coalesce(array_agg(rp.permission_code || ':' || rp.scope order by rp.permission_code), '{}')
  from authz.role_permissions rp join authz.roles r on r.id = rp.role_id
  where r.code = p_role and rp.permission_code like p_like
$$;

-- ===========================================================================
-- The grants (exactly the owner's decisions)
-- ===========================================================================
select is(pg_temp.grants('finance_officer', 'perf.%'),
  array['perf.commission.calculate:all','perf.commission.read:all','perf.kpi.read:all'],
  'finance officer: perf.kpi.read at company scope; no target or plan permission');
select is(pg_temp.grants('finance_officer', 'inventory.%') || pg_temp.grants('finance_officer', 'field.%'), '{}'::text[],
  'finance officer: nothing else widened (no stock, no field permission)');
select is(pg_temp.grants('collection_officer', 'field.%'),
  array['field.shift.start:own','field.visit.create:own','field.visit.export:own','field.visit.plan:own',
        'field.visit.read:own','field.visit_exception.request:own'],
  'collection officer: shift, check-in, own visits, own planning, visit exception, own visit export');
select is(pg_temp.grants('collection_officer', 'field.%'), pg_temp.grants('sales_rep', 'field.%'),
  'collection officer: the same field permissions as the sales rep, at the same (own) scope');
select is(pg_temp.grants('collection_officer', 'sales.%') || pg_temp.grants('collection_officer', 'crm.lead%')
          || pg_temp.grants('collection_officer', 'perf.%'), '{}'::text[],
  'collection officer: still no order, lead or commission permission');
select is(pg_temp.grants('sales_director', 'field.tracking%'), array['field.tracking.export:all','field.tracking.read:all'],
  'sales director: tracking read and its export at company scope');
select is(pg_temp.grants('area_manager', 'field.tracking%'), array['field.tracking.export:team','field.tracking.read:team'],
  'area manager: tracking stays at team scope');
select is(pg_temp.grants('sales_rep', 'field.tracking%'), '{}'::text[], 'sales rep: still no tracking read');
select is((select count(*)::int from authz.role_permissions
           where permission_code in ('perf.commission.adjust', 'wf.decide.commission_adjust')), 0,
  'commission adjustments: no role holds the request or decide permission (owners only, unchanged)');

-- ===========================================================================
-- Setup data: Rep Cairo completes a visit today (a figure for the dashboard)
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is(api.visit_check_in('64000000-0000-0000-0000-000000000004', '40000000-0000-0000-0000-000000000001',
            30.0444, 31.2357, 10, now() - interval '20 minutes') ->> 'verification_status', 'verified',
  'setup: Rep Cairo checks in at Dr. Ahmed Clinic');
select is(api.visit_check_out('64000000-0000-0000-0000-000000000004', 'interested', 'test visit', 30.0444, 31.2357, 10,
            now() - interval '5 minutes') ->> 'status', 'completed', 'setup: and checks out');

-- ===========================================================================
-- 2. Finance officer: the company dashboard
-- ===========================================================================
select tests.clear_authentication();
select is(pg_temp.req('00000000-0000-0000-0000-0000000000a6', 'perf.kpi.read'), 'ok', 'finance passes authz.require(perf.kpi.read)');
select ok(pg_temp.has_global('00000000-0000-0000-0000-0000000000a6', 'perf.kpi.read'),
  'at company-wide scope (the dashboard''s company layout)');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select ok((select count(*) > 0 from api.kpi_summary(core.business_date(), core.business_date())),
  'kpi_summary returns the company figures');
select is((select value from api.kpi_summary(core.business_date(), core.business_date()) where kpi_code = 'VISITS_COMPLETED'),
  1::numeric, 'the company figures include every rep''s work (today''s completed visit)');
select is((select array_agg(kpi_code order by kpi_code) from api.kpi_summary(core.business_date(), core.business_date())),
  (select array_agg(code order by code) from perf.kpi_definitions where status = 'active' and code <> 'STOCK_ALERTS'),
  'every active KPI except the stock alerts (finance holds no stock permission)');
select ok((select count(distinct employee_id) >= 2 from api.kpi_team(core.business_date(), core.business_date())
           where employee_id in ('20000000-0000-0000-0000-000000000004', '20000000-0000-0000-0000-000000000005')),
  'kpi_team lists the reps of the whole company');
select ok((select count(*) > 0 from api.kpi_breakdown(core.business_date(), core.business_date(), 'territory')),
  'kpi_breakdown by territory works');
select ok((select count(*) > 0 from api.kpi_breakdown(core.business_date(), core.business_date(), 'brand')),
  'kpi_breakdown by brand works');
select lives_ok($$select * from api.kpi_overdue_customers(core.business_date(), null, 20)$$, 'kpi_overdue_customers works');
select lives_ok($$select * from api.kpi_summary(core.business_date(), core.business_date(), '20000000-0000-0000-0000-000000000005')$$,
  'finance may filter the dashboard to one employee');
select lives_ok($$select count(*) from api.v_approval_requests$$, 'the pending-approvals list reads');
select throws_like($$select api.set_kpi_target(gen_random_uuid(), 'VISITS_COMPLETED', core.business_date(), core.business_date(), 10,
                       '20000000-0000-0000-0000-000000000004')$$,
  'PERMISSION_DENIED%', 'finance still cannot set targets');

-- ===========================================================================
-- 3. Collection officer: the field day, like a rep
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000b1');
select throws_like($$select api.start_shift('64000000-0000-0000-0000-0000000000a1', 31.0409, 31.3785, 10, now() - interval '30 minutes')$$,
  'NOTICE_REQUIRED%', 'the tracking notice comes first for the collector too');
select is(api.acknowledge_tracking_notice('2026-10-30.1') ->> 'replayed', 'false', 'the collector acknowledges the notice');
select is(set_config('t.shift', api.start_shift('64000000-0000-0000-0000-0000000000a1', 31.0409, 31.3785, 10,
            now() - interval '30 minutes') ->> 'shift_id', true) is not null, true, 'the collector starts the day');
select is((api.record_location_pings(jsonb_build_array(jsonb_build_object('id', '64000000-0000-0000-0000-0000000000e1',
            'lat', 31.0410, 'lng', 31.3786, 'accuracy_m', 10, 'captured_at', now() - interval '20 minutes'))) ->> 'accepted')::int, 1,
  'and sends a tracking point');
select is(api.visit_check_in('64000000-0000-0000-0000-0000000000c1', '40000000-0000-0000-0000-000000000002',
            31.0409, 31.3785, 10, now() - interval '15 minutes') ->> 'verification_status', 'verified',
  'the collector checks in at Dr. Mona Clinic');
select is(api.visit_check_out('64000000-0000-0000-0000-0000000000c1', 'collection', 'collected (test)', 31.0409, 31.3785, 10,
            now() - interval '10 minutes') ->> 'status', 'completed', 'and checks out');
select is((select count(*)::int from api.v_visits where id = '64000000-0000-0000-0000-0000000000c1'), 1,
  'the collector reads their own visit');
select is((select count(*)::int from api.v_visits where id = '64000000-0000-0000-0000-000000000004'), 0,
  'but not a rep''s visit');
select is((select count(*)::int from api.v_visits where employee_id <> '20000000-0000-0000-0000-0000000000c1'), 0,
  'and no other employee''s visit at all');
select lives_ok($$select api.tracking_day('20000000-0000-0000-0000-0000000000c1', core.business_date())$$,
  'the collector opens their own day');
select throws_like($$select api.tracking_day('20000000-0000-0000-0000-000000000004', core.business_date())$$,
  'PERMISSION_DENIED%', 'but not a rep''s day');
select throws_like($$select * from api.tracking_team_day()$$, 'PERMISSION_DENIED%', 'and has no team view');
select is((select array_agg(employee_id) from api.v_tracking_health), array['20000000-0000-0000-0000-0000000000c1'::uuid],
  'the health panel shows the collector only their own row');
select throws_like($$select api.save_order_draft('64000000-0000-0000-0000-0000000000d1', '40000000-0000-0000-0000-000000000002',
            '[{"variant_id":"53000000-0000-0000-0000-000000000001","qty":1}]'::jsonb)$$,
  'PERMISSION_DENIED%', 'the collector still cannot create orders');
select throws_like($$select api.kpi_summary(core.business_date(), core.business_date())$$, 'PERMISSION_DENIED%',
  'nor read KPIs (no commission or KPI permission)');
select is(api.end_shift('64000000-0000-0000-0000-0000000000a2', 31.0409, 31.3785, 10, now()) ->> 'status', 'closed',
  'the collector ends the day');

-- ===========================================================================
-- 4. Sales director: tracking for the whole company
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000b2');
select is(api.acknowledge_tracking_notice('2026-10-30.1') ->> 'replayed', 'false', 'setup: the rep outside the team acknowledges the notice');
select is(set_config('t.out', api.start_shift('64000000-0000-0000-0000-0000000000b1', 30.0444, 31.2357, 10,
            now() - interval '40 minutes') ->> 'shift_id', true) is not null, true, 'setup: and starts the day');
select is((api.record_location_pings(jsonb_build_array(jsonb_build_object('id', '64000000-0000-0000-0000-0000000000e2',
            'lat', 30.0445, 'lng', 31.2358, 'accuracy_m', 10, 'captured_at', now() - interval '30 minutes'))) ->> 'accepted')::int, 1,
  'setup: and sends a point');

select tests.clear_authentication();
select ok(pg_temp.has_global('00000000-0000-0000-0000-0000000000a2', 'field.tracking.read'),
  'the sales director reads tracking at company scope');
select ok(not ('20000000-0000-0000-0000-0000000000c2' = any(pg_temp.employee_ids('00000000-0000-0000-0000-0000000000a2', 'admin.user.read')))
          and '20000000-0000-0000-0000-000000000005' = any(pg_temp.employee_ids('00000000-0000-0000-0000-0000000000a2', 'admin.user.read')),
  'the rep is outside the sales director''s team (the reporting line); Rep Delta is inside');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a2');
select lives_ok($$select api.tracking_day('20000000-0000-0000-0000-0000000000c2', core.business_date())$$,
  'the sales director opens the day of a rep outside the team');
select is((select count(*)::int from api.tracking_team_day() where employee_id = '20000000-0000-0000-0000-0000000000c2'), 1,
  'the team day lists the rep outside the team');
select is((select count(*)::int from api.tracking_team_day() where employee_id = '20000000-0000-0000-0000-0000000000c1'), 1,
  'and the collector');
select is((select count(*)::int from api.v_tracking_health where employee_id = '20000000-0000-0000-0000-0000000000c2'), 1,
  'the health panel shows the rep outside the team');
select is((select count(*)::int from api.v_team_last_location where employee_id = '20000000-0000-0000-0000-0000000000c2'), 1,
  'the team map shows the rep outside the team');
select is((select count(*)::int from field.location_pings where employee_id = '20000000-0000-0000-0000-0000000000c2'), 1,
  'RLS on the points follows the company scope');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a3');
select throws_like($$select api.tracking_day('20000000-0000-0000-0000-0000000000c2', core.business_date())$$,
  'PERMISSION_DENIED%', 'the area manager still sees only their team');
select is((select count(*)::int from api.v_tracking_health where employee_id = '20000000-0000-0000-0000-0000000000c2'), 0,
  'and not on the health panel');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select throws_like($$select api.tracking_day('20000000-0000-0000-0000-0000000000c2', core.business_date())$$,
  'PERMISSION_DENIED%', 'a rep cannot see another rep''s tracking');
select is((select count(*)::int from api.v_tracking_health where employee_id <> '20000000-0000-0000-0000-000000000004')
          + (select count(*)::int from api.v_team_last_location where employee_id <> '20000000-0000-0000-0000-000000000004')
          + (select count(*)::int from field.location_pings where employee_id <> '20000000-0000-0000-0000-000000000004'), 0,
  'nor anyone else''s row, map point or tracking point');

-- ===========================================================================
-- 1. Commission adjustments: unchanged (the requesting owner never decides)
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select throws_ok($$select api.adjust_commission('20000000-0000-0000-0000-000000000004', core.business_date(), 10, 'test bonus', 'bonus', 'adj-64-fin')$$,
  '42501', null, 'the finance officer cannot request a commission adjustment');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');
select is(api.adjust_commission('20000000-0000-0000-0000-000000000004', core.business_date(), 100, 'Bonus (test)', 'bonus', 'adj-64')
            ->> 'status', 'pending_approval', 'an owner requests an adjustment: it waits for a decision');
select throws_like($$select api.decide_approval((select r.id from wf.approval_requests r join wf.workflow_definitions d on d.id = r.definition_id
                       where d.code = 'perf.commission_adjustment' and r.payload ->> 'idempotency_key' = 'adj-64'), 'approve')$$,
  'SELF_APPROVAL%', 'the requesting owner cannot approve it (a second owner decides)');

select tests.clear_authentication();
select * from finish();
rollback;
