-- Phase P step 3 (Google Maps): the customers map view and its scope, pin-on-first-visit
-- (a check-in at an unpinned customer proposes the fix; a crm.customer_location.verify holder
-- decides; nobody else can), the team map (last point during an open shift only, D-14) and the
-- visit fixes of the rep day map. Synthetic data only.
begin;
select tests.load_fixture();
select plan(77);

-- Fixture: E004 rep Cairo (a4, Nasr City, manager E003 = area mgr a3 over CAI-GIZ, whose manager is
-- E002 = sales director a2); E005 rep Delta (a5, manager E002). C-0001 (Nasr, a4) is pinned,
-- C-0002 (Delta, a5) is pinned. Added here: three unpinned synthetic clinics.
insert into crm.customers (id, customer_no, doctor_name, display_name, territory_id, lifecycle_stage, phone_primary) values
  ('40000000-0000-0000-0000-0000000057a1', 'C-57A1', 'Dr. Synthetic A', 'Synthetic Clinic A',
   '10000000-0000-0000-0000-000000000003', 'prospect', '+201000005701'),
  ('40000000-0000-0000-0000-0000000057a2', 'C-57A2', 'Dr. Synthetic B', 'Synthetic Clinic B',
   (select id from core.territories where code = 'DELTA'), 'lead', '+201000005702'),
  ('40000000-0000-0000-0000-0000000057a3', 'C-57A3', 'Dr. Synthetic C', 'Synthetic Clinic C (archived)',
   '10000000-0000-0000-0000-000000000003', 'lost', '+201000005703');
update crm.customers set archived_at = now() where id = '40000000-0000-0000-0000-0000000057a3';
insert into crm.customer_assignments (customer_id, employee_id) values
  ('40000000-0000-0000-0000-0000000057a1', '20000000-0000-0000-0000-000000000004'),
  ('40000000-0000-0000-0000-0000000057a2', '20000000-0000-0000-0000-000000000005'),
  ('40000000-0000-0000-0000-0000000057a3', '20000000-0000-0000-0000-000000000004');
-- An invoice 10 days overdue for C-0001 and one not yet due for C-0002.
insert into finance.invoices (id, invoice_no, customer_id, issue_date, due_date, subtotal, total) values
  ('57300000-0000-0000-0000-000000000001', 'INV-57-0001', '40000000-0000-0000-0000-000000000001',
   core.business_date() - 40, core.business_date() - 10, 1000, 1000),
  ('57300000-0000-0000-0000-000000000002', 'INV-57-0002', '40000000-0000-0000-0000-000000000002',
   core.business_date() - 5, core.business_date() + 25, 800, 800);

-- ===========================================================================
-- Structure and privileges
-- ===========================================================================
select ok((select bool_and(coalesce(c.reloptions @> array['security_invoker=true'], false)) from pg_class c
           where c.oid in ('api.v_customer_map'::regclass, 'api.v_team_last_location'::regclass,
                           'api.v_customer_location_proposals'::regclass)),
  'the three map views are security_invoker');
select ok((select relrowsecurity from pg_class where oid = 'crm.customer_location_proposals'::regclass),
  'location proposals have RLS enabled');
select ok(not has_table_privilege('authenticated', 'crm.customer_location_proposals', 'insert')
          and not has_table_privilege('authenticated', 'crm.customer_location_proposals', 'update')
          and not has_table_privilege('authenticated', 'crm.customer_location_proposals', 'delete'),
  'no direct writes on proposals');
select ok(has_function_privilege('authenticated', 'api.decide_customer_location_proposal(uuid, boolean, text)', 'execute')
          and not has_function_privilege('anon', 'api.decide_customer_location_proposal(uuid, boolean, text)', 'execute')
          and has_function_privilege('authenticated', 'api.tracking_day_visit_fixes(uuid, date)', 'execute')
          and not has_function_privilege('anon', 'api.tracking_day_visit_fixes(uuid, date)', 'execute'),
  'the new commands are for signed-in users only');
select ok(not has_function_privilege('authenticated', 'field.propose_location_from_check_in()', 'execute')
          and not has_function_privilege('authenticated', 'crm.supersede_location_proposals()', 'execute'),
  'the trigger functions are not client-callable');
select ok(not has_table_privilege('anon', 'api.v_customer_map', 'select')
          and not has_table_privilege('anon', 'api.v_team_last_location', 'select'),
  'anon cannot read the map views');

-- ===========================================================================
-- Customers map: scope per role
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is((select string_agg(customer_no, ',' order by customer_no) from api.v_customer_map), 'C-0001,C-57A1',
  'rep: only their own live customers (not Delta, not archived)');
select ok((select is_overdue and max_days_overdue = 10 and overdue_amount = 1000.00
           from api.v_customer_map where customer_no = 'C-0001'),
  'rep: their own customer''s overdue flag, days and amount');
select is((select is_overdue from api.v_customer_map where customer_no = 'C-57A1'), false,
  'rep: no overdue invoice → false (not masked)');
select ok((select latitude = 30.044400 and longitude = 31.235700 and location_verified is false
                  and primary_rep_employee_id = '20000000-0000-0000-0000-000000000004'
                  and territory_code = 'CAI-NASR' and lifecycle_stage = 'active'
           from api.v_customer_map where customer_no = 'C-0001'),
  'rep: pin, stage, rep and territory columns');
select ok((select latitude is null and last_visit_on is null from api.v_customer_map where customer_no = 'C-57A1'),
  'rep: the unpinned prospect has no pin and no visit yet');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a3');
select is((select string_agg(customer_no, ',' order by customer_no) from api.v_customer_map), 'C-0001,C-57A1',
  'area manager: the customers of their territory tree only');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a2');
select is((select string_agg(customer_no, ',' order by customer_no) from api.v_customer_map), 'C-0001,C-0002,C-57A1,C-57A2',
  'sales director (all): every live customer');
select is((select is_overdue from api.v_customer_map where customer_no = 'C-0002'), false,
  'sales director: an invoice that is not yet due is not overdue');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');
select is((select count(*)::int from api.v_customer_map), 4, 'owner: every live customer, archived ones excluded');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a5');
select is((select string_agg(customer_no, ',' order by customer_no) from api.v_customer_map), 'C-0002,C-57A2',
  'the Delta rep sees only Delta');

-- ===========================================================================
-- Pin on first visit
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is(api.visit_check_in('57000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-0000000057a1',
                             30.061234, 31.330987, 18, now() - interval '40 minutes') ->> 'verification_status',
  'no_customer_location', 'a rep can check in at an unpinned customer');
select is((select count(*)::int from api.v_customer_location_proposals), 1, 'the check-in recorded one proposal');
select ok((select status = 'pending' and latitude = 30.061234 and longitude = 31.330987 and accuracy_m = 18
                  and proposed_by = '20000000-0000-0000-0000-000000000004'
                  and visit_id = '57000000-0000-0000-0000-000000000001'
                  and customer_name = 'Synthetic Clinic A' and not customer_has_location
           from api.v_customer_location_proposals),
  'the proposal carries the fix, its accuracy, the rep and the visit');
select is((api.visit_check_in('57000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-0000000057a1',
                              30.061234, 31.330987, 18, now() - interval '40 minutes') ->> 'replayed'), 'true',
  'replaying the check-in (offline queue)');
select is((select count(*)::int from api.v_customer_location_proposals), 1, 'a replay proposes nothing twice');
select ok((select latitude is null from crm.customers where id = '40000000-0000-0000-0000-0000000057a1'),
  'the proposal does not pin the clinic (2026-10-29 rule)');
select is((select last_visit_on from api.v_customer_map where customer_no = 'C-57A1'), core.business_date(),
  'the customers map shows the last visit date');
select throws_like($$select api.decide_customer_location_proposal(
                       (select id from crm.customer_location_proposals where visit_id = '57000000-0000-0000-0000-000000000001'), true)$$,
  'PERMISSION_DENIED%', 'the rep (no crm.customer_location.verify) cannot approve their own proposal');

-- A pinned customer and a check-in without a device fix propose nothing.
select is(api.visit_check_in('57000000-0000-0000-0000-000000000002', '40000000-0000-0000-0000-000000000001',
                             30.044410, 31.235710, 12, now() - interval '35 minutes') ->> 'verification_status',
  'verified', 'setup: a check-in at the pinned customer');
select is(api.visit_check_in('57000000-0000-0000-0000-000000000003', '40000000-0000-0000-0000-0000000057a1',
                             null, null, null, now() - interval '32 minutes') ->> 'verification_status',
  'no_device_location', 'setup: a check-in without a device fix');
-- A second visit at the same clinic: a second proposal, and an inaccurate one.
select is(api.visit_check_in('57000000-0000-0000-0000-000000000004', '40000000-0000-0000-0000-0000000057a1',
                             30.061300, 31.331050, 450, now() - interval '30 minutes') ->> 'verification_status',
  'no_customer_location', 'setup: a second check-in with a poor fix');
select is((select string_agg(visit_id::text, ',' order by captured_at) from api.v_customer_location_proposals),
  '57000000-0000-0000-0000-000000000001,57000000-0000-0000-0000-000000000004',
  'only the check-ins at the unpinned customer with a fix are proposed');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a5');
select is(api.visit_check_in('57000000-0000-0000-0000-000000000005', '40000000-0000-0000-0000-0000000057a2',
                             31.050000, 31.380000, 15, now() - interval '28 minutes') ->> 'verification_status',
  'no_customer_location', 'setup: the Delta rep checks in at their unpinned customer');
select is((select count(*)::int from api.v_customer_location_proposals), 1, 'the Delta rep sees only their own proposal');
select throws_like($$select api.decide_customer_location_proposal(
                       (select id from crm.customer_location_proposals where visit_id = '57000000-0000-0000-0000-000000000005'), true)$$,
  'PERMISSION_DENIED%', 'another rep without the permission is refused too');

-- The area manager (crm.customer_location.verify, territory) decides for Cairo only.
select tests.clear_authentication();
select set_config('t.p5', (select id::text from crm.customer_location_proposals
                           where visit_id = '57000000-0000-0000-0000-000000000005'), true) is not null;
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a3');
select is((select count(*)::int from api.v_customer_location_proposals where status = 'pending'), 2,
  'the verifier sees the pending proposals of their territory');
select is((select count(*)::int from crm.customer_location_proposals where visit_id = '57000000-0000-0000-0000-000000000005'), 0,
  'and not the Delta one (RLS)');
select throws_like(format('select api.decide_customer_location_proposal(%L, true)', current_setting('t.p5')),
  'PERMISSION_DENIED%', 'the verifier cannot decide a proposal outside their scope');
select throws_like($$select api.decide_customer_location_proposal(
                       (select id from api.v_customer_location_proposals where visit_id = '57000000-0000-0000-0000-000000000004'), true)$$,
  'LOCATION_INACCURATE%', 'a fix worse than field.max_accuracy_m cannot become the clinic pin');
select throws_like($$select api.decide_customer_location_proposal(
                       (select id from api.v_customer_location_proposals where visit_id = '57000000-0000-0000-0000-000000000001'), false, '  ')$$,
  'REASON_REQUIRED%', 'a rejection needs a reason');
select ok((select r ->> 'status' = 'approved' and r ->> 'replayed' = 'false' and (r ->> 'latitude')::numeric = 30.061234
           from (select api.decide_customer_location_proposal(
                   (select id from api.v_customer_location_proposals where visit_id = '57000000-0000-0000-0000-000000000001'), true) as r) x),
  'the verifier approves the first proposal');
select ok((select latitude = 30.061234 and longitude = 31.330987 and location_verified and version = 2
           from crm.customers where id = '40000000-0000-0000-0000-0000000057a1'),
  'the proposal is now the verified clinic location');
select ok((select status = 'approved' and decided_by = '20000000-0000-0000-0000-000000000003' and decided_at is not null
           from crm.customer_location_proposals where visit_id = '57000000-0000-0000-0000-000000000001'),
  'the decision records who and when');
select is((select status from crm.customer_location_proposals where visit_id = '57000000-0000-0000-0000-000000000004'), 'superseded',
  'the other pending proposal for the clinic is superseded');
select is(api.decide_customer_location_proposal(
            (select id from api.v_customer_location_proposals where visit_id = '57000000-0000-0000-0000-000000000001'), true) ->> 'replayed',
  'true', 'approving again is an idempotent replay');
select throws_like($$select api.decide_customer_location_proposal(
                       (select id from api.v_customer_location_proposals where visit_id = '57000000-0000-0000-0000-000000000001'), false, 'changed my mind')$$,
  'INVALID_STATE%', 'an approved proposal cannot be rejected afterwards');
select throws_like($$select api.decide_customer_location_proposal(
                       (select id from api.v_customer_location_proposals where visit_id = '57000000-0000-0000-0000-000000000004'), false, 'poor fix')$$,
  'INVALID_STATE%', 'a superseded proposal cannot be decided');
select tests.clear_authentication();
select is((select count(*)::int from crm.activities where customer_id = '40000000-0000-0000-0000-0000000057a1'
           and summary in ('Clinic location proposed from a visit check-in', 'Clinic location set from an approved visit proposal')), 3,
  'the customer timeline shows both proposals and the approval');
select is((select count(*)::int from notify.notifications where recipient_user_id = '00000000-0000-0000-0000-0000000000a4'
           and type = 'customer.location_proposal_decided'), 1, 'the rep is notified of the decision');
select is((select count(*)::int from integration.outbox
           where event_type in ('customer.location_proposed', 'customer.location_proposal_decided')
             and aggregate_id = '40000000-0000-0000-0000-0000000057a1'), 3, 'proposals and decisions are published to the outbox');
select ok((select count(*) from audit.audit_log where table_name = 'customer_location_proposals') >= 4,
  'proposal changes are audited');

-- After the pin, the next check-in at the clinic is verified against it and proposes nothing.
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is(api.visit_check_in('57000000-0000-0000-0000-000000000006', '40000000-0000-0000-0000-0000000057a1',
                             30.061250, 31.331000, 15, now() - interval '8 minutes') ->> 'verification_status',
  'verified', 'the next visit at the clinic is verified against the approved pin');
select is((select count(*)::int from crm.customer_location_proposals
           where customer_id = '40000000-0000-0000-0000-0000000057a1'), 2, 'and no new proposal is recorded');
select is((select status from api.v_customer_location_proposals where visit_id = '57000000-0000-0000-0000-000000000001'), 'approved',
  'the rep sees the decision on their own proposal');

-- Delta: the sales director (all) rejects; then a direct set supersedes any new pending one.
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a2');
select is(api.decide_customer_location_proposal(
            (select id from api.v_customer_location_proposals where visit_id = '57000000-0000-0000-0000-000000000005'),
            false, 'fix is across the street') ->> 'status',
  'rejected', 'the sales director rejects the Delta proposal with a reason');
select ok((select latitude is null from crm.customers where id = '40000000-0000-0000-0000-0000000057a2'),
  'a rejected proposal pins nothing');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a5');
select is(api.visit_check_in('57000000-0000-0000-0000-000000000007', '40000000-0000-0000-0000-0000000057a2',
                             31.050100, 31.380100, 12, now() - interval '10 minutes') ->> 'verification_status',
  'no_customer_location', 'setup: another check-in at the still unpinned Delta clinic');
select is((select status from api.v_customer_location_proposals where visit_id = '57000000-0000-0000-0000-000000000007'), 'pending',
  'a new pending proposal');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a2');
select is(api.set_customer_location('40000000-0000-0000-0000-0000000057a2', 31.050200, 31.380200) ->> 'location_verified', 'true',
  'an office user sets the location directly (address search or dropped pin)');
select is((select status from api.v_customer_location_proposals where visit_id = '57000000-0000-0000-0000-000000000007'), 'superseded',
  'the direct set supersedes the pending proposal');
select is((select string_agg(status, ',' order by captured_at) from api.v_customer_location_proposals), 'approved,superseded,rejected,superseded',
  'the sales director (all) sees every proposal with its outcome');

-- ===========================================================================
-- Team map: last point per rep, open shifts only (D-14)
-- ===========================================================================
select tests.clear_authentication();
-- E005 has a shift left open past the 10-hour cap (not closed yet by the auto-close job).
insert into field.work_shifts (employee_id, client_ref, notice_version, business_date, start_captured_at,
                               start_latitude, start_longitude, start_accuracy_m, window_start, started_at)
values ('20000000-0000-0000-0000-000000000005', '57100000-0000-0000-0000-0000000000f5',
        (select version from field.tracking_notices where is_current),
        ((now() - interval '11 hours') at time zone 'Africa/Cairo')::date, now() - interval '11 hours',
        31.04, 31.37, 10, now() - interval '11 hours', now() - interval '11 hours');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is((select count(*)::int from api.v_team_last_location), 0, 'no open shift: the rep is not on the team map');
select lives_ok($$select api.acknowledge_tracking_notice((select version from field.tracking_notices where is_current))$$,
  'setup: the rep acknowledges the tracking notice');
select is(api.start_shift('57100000-0000-0000-0000-000000000001', 30.050000, 31.300000, 10, now() - interval '60 minutes') ->> 'status',
  'open', 'setup: the rep starts the day');
select ok((select point_source = 'shift_start' and latitude = 30.050000 from api.v_team_last_location),
  'before the first point, the start-of-day fix is shown');
select is(((api.record_location_pings(jsonb_build_array(
  jsonb_build_object('id','57200000-0000-0000-0000-000000000001','lat',30.051000,'lng',31.301000,'accuracy_m',12,'captured_at',now() - interval '50 minutes'),
  jsonb_build_object('id','57200000-0000-0000-0000-000000000002','lat',30.052000,'lng',31.302000,'accuracy_m',14,'captured_at',now() - interval '40 minutes'),
  jsonb_build_object('id','57200000-0000-0000-0000-000000000003','lat',30.053000,'lng',31.303000,'accuracy_m',600,'captured_at',now() - interval '30 minutes'))))
  ->> 'accepted')::int, 3, 'setup: three points, the latest with poor accuracy');
select ok((select point_source = 'ping' and latitude = 30.052000 and longitude = 31.302000 and accuracy_m = 14
           from api.v_team_last_location),
  'the rep sees their own last usable point (a low-accuracy point is skipped)');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a3');
select is((select string_agg(full_name_en, ',') from api.v_team_last_location), 'Rep Cairo',
  'area manager: their team''s rep, on shift');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a2');
select is((select string_agg(full_name_en, ',') from api.v_team_last_location), 'Rep Cairo',
  'sales director: the rep on shift; the shift past the 10-hour cap is not an open day');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a5');
select is((select count(*)::int from api.v_team_last_location), 0,
  'another rep sees no one (their own shift is past the cap; the Cairo rep is out of scope)');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');
select is((select count(*)::int from api.v_team_last_location), 1, 'owner: the one rep on an open shift');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is(api.end_shift('57100000-0000-0000-0000-0000000000e1', 30.052500, 31.302500, 10, now(),
                        '57100000-0000-0000-0000-000000000001') ->> 'status', 'closed', 'setup: the rep ends the day');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a3');
select is((select count(*)::int from field.location_pings where employee_id = '20000000-0000-0000-0000-000000000004'), 3,
  'the manager can still read the day''s points (tracking day view)');
select is((select count(*)::int from api.v_team_last_location), 0, 'but after the end of the day the rep is off the team map');

-- ===========================================================================
-- Rep day map: visit fixes, same scope as the tracking day
-- ===========================================================================
select is((select count(*)::int from api.tracking_day_visit_fixes('20000000-0000-0000-0000-000000000004', core.business_date())
           where event_type = 'check_in'), 4,
  'the manager reads the rep''s check-in fixes of the day (the check-in without a fix is not listed)');
select ok((select bool_and(latitude is not null and customer_id is not null)
           from api.tracking_day_visit_fixes('20000000-0000-0000-0000-000000000004', core.business_date())),
  'each fix has a position and its customer');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is((select count(*)::int from api.tracking_day_visit_fixes('20000000-0000-0000-0000-000000000004', core.business_date())), 4,
  'the rep reads their own day');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a5');
select throws_like($$select * from api.tracking_day_visit_fixes('20000000-0000-0000-0000-000000000004', core.business_date())$$,
  'PERMISSION_DENIED%', 'another rep cannot read the rep''s visit fixes');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a3');
select throws_like($$select * from api.tracking_day_visit_fixes('20000000-0000-0000-0000-000000000005', core.business_date())$$,
  'PERMISSION_DENIED%', 'a manager outside the rep''s team cannot either');
select throws_like($$select * from api.tracking_day_visit_fixes(null, core.business_date())$$,
  'VALIDATION%', 'the employee is required');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a2');
select is((select count(*)::int from api.tracking_day_visit_fixes('20000000-0000-0000-0000-000000000005', core.business_date())), 2,
  'the sales director reads the Delta rep''s fixes (team)');

select tests.clear_authentication();
select * from finish();
rollback;
