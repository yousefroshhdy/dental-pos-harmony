-- Tasks (self/team assignment, idempotency, completion), today view, visit check-out
-- (idempotent replay, follow-ups), verification exceptions + approval hook, visit
-- RLS per role, raw GPS privacy and the location retention job.
begin;
select tests.load_fixture();
select plan(74);

-- ---------------------------------------------------------------------------
-- Extra fixture: a planned visit today and two tasks for the Cairo rep.
-- ---------------------------------------------------------------------------
insert into field.visits (id, customer_id, employee_id, planned_for, status) values
  ('81000000-0000-0000-0000-000000000010', '40000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000004',
   (now() at time zone 'Africa/Cairo')::date, 'planned');
insert into work.tasks (title, customer_id, assignee_employee_id, due_at) values
  ('Overdue call', '40000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000004', now() - interval '2 days'),
  ('Next week call', '40000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000004', now() + interval '7 days');

-- ===========================================================================
-- Tasks
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is(set_config('t.k1', api.create_task('Call Dr. Ahmed', now() + interval '2 hours', '40000000-0000-0000-0000-000000000001',
  'follow_up', null, 'd1000000-0000-0000-0000-000000000001')::text, true)::jsonb ->> 'assignee_employee_id',
  '20000000-0000-0000-0000-000000000004', 'rep creates a task assigned to self by default');
select ok((select r ->> 'task_id' = current_setting('t.k1')::jsonb ->> 'task_id' and r ->> 'replayed' = 'true'
           from (select api.create_task('Call Dr. Ahmed', now() + interval '2 hours', '40000000-0000-0000-0000-000000000001',
                                        'follow_up', null, 'd1000000-0000-0000-0000-000000000001') as r) x),
  'replaying create_task with the same client_ref returns the same task');
select throws_like($$select api.create_task('Help', now(), null, 'general', '20000000-0000-0000-0000-000000000005')$$,
  'PERMISSION_DENIED: employee%', 'rep cannot assign tasks to another rep');
select throws_like($$select api.create_task('Spy', now(), '40000000-0000-0000-0000-000000000002')$$,
  'PERMISSION_DENIED: customer%', 'rep cannot create a task on another rep''s customer');
select throws_like($$select api.create_task('X', now(), null, 'party')$$, 'VALIDATION%kind%', 'unknown task kind is rejected');
select throws_like($$select api.create_task('  ', now())$$, 'VALIDATION: title%', 'task title is required');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a3');
select is(set_config('t.k2', api.create_task('Prepare demo', now() + interval '1 hour', '40000000-0000-0000-0000-000000000001',
  'visit_prep', '20000000-0000-0000-0000-000000000004')::text, true)::jsonb ->> 'assignee_employee_id',
  '20000000-0000-0000-0000-000000000004', 'area manager assigns a task to a team member');
select throws_like($$select api.create_task('Delta job', now(), null, 'general', '20000000-0000-0000-0000-000000000005')$$,
  'PERMISSION_DENIED: employee%', 'area manager cannot assign outside the team/territory');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a2');
select lives_ok($$select api.create_task('Quarterly review', now() + interval '1 day', null, 'general', '20000000-0000-0000-0000-000000000005')$$,
  'sales director assigns to anyone');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a8');
select throws_like($$select api.create_task('X', now())$$, 'PERMISSION_DENIED: work.task.manage', 'inventory manager has no task permission');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is((select count(*)::int from api.v_notifications where type = 'task.assigned'), 1, 'assignee is notified of a task from the manager');
select is(api.complete_task((current_setting('t.k1')::jsonb ->> 'task_id')::uuid, 'Doctor ordered a kit') ->> 'status', 'done',
  'rep completes own task');
select is(api.complete_task((current_setting('t.k1')::jsonb ->> 'task_id')::uuid, 'Doctor ordered a kit') ->> 'replayed', 'true',
  'completing again is an idempotent replay');
select throws_like(format($$select api.complete_task(%L, '')$$, current_setting('t.k2')::jsonb ->> 'task_id'),
  'VALIDATION: outcome%', 'an outcome is required');
select is((select count(*)::int from crm.activities where ref_table = 'work.tasks'
           and ref_id = (current_setting('t.k1')::jsonb ->> 'task_id')::uuid), 1, 'completion writes a timeline note');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a5');
select throws_like(format($$select api.complete_task(%L, 'done')$$, current_setting('t.k2')::jsonb ->> 'task_id'),
  'PERMISSION_DENIED%', 'another rep cannot complete the task');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a3');
select is(api.complete_task((current_setting('t.k2')::jsonb ->> 'task_id')::uuid, 'Demo kit packed') ->> 'status', 'done',
  'manager completes a team member''s task');

-- ===========================================================================
-- Today view and task view
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is((select is_overdue from api.v_my_today where item_type = 'task' and title = 'Overdue call'), true,
  'today view lists overdue tasks');
select is((select count(*)::int from api.v_my_today where item_type = 'visit' and item_id = '81000000-0000-0000-0000-000000000010'), 1,
  'today view lists today''s planned visit');
select is((select count(*)::int from api.v_my_today where title = 'Next week call'), 0, 'future tasks are not in today''s list');
select is((select count(*)::int from api.v_my_today where item_id = (current_setting('t.k1')::jsonb ->> 'task_id')::uuid), 0,
  'completed tasks drop off the list');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a5');
select is((select count(*)::int from api.v_my_today where title = 'Overdue call'), 0, 'today view is personal');
select is((select count(*)::int from api.v_tasks where assignee_employee_id = '20000000-0000-0000-0000-000000000004'), 0,
  'another rep cannot read the rep''s tasks');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a3');
select is((select count(*)::int from api.v_tasks where assignee_employee_id = '20000000-0000-0000-0000-000000000004'), 4,
  'area manager reads the team''s tasks');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select is((select count(*)::int from api.v_tasks), 0, 'finance has no task access');

-- ===========================================================================
-- Visit check-out
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is(api.visit_check_in('81000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000001',
  30.044800, 31.235700, 20, now() - interval '5 minutes') ->> 'verification_status', 'verified', 'setup: verified check-in');
select is(set_config('t.v1', api.visit_check_out('81000000-0000-0000-0000-000000000001', 'order_taken', 'Ordered 10 implants',
  30.044800, 31.235700, 15, now(), now() + interval '3 days')::text, true)::jsonb ->> 'status', 'completed',
  'check-out completes the visit');
select isnt(current_setting('t.v1')::jsonb ->> 'follow_up_task_id', null, 'check-out creates the follow-up task');
select ok((select r ->> 'replayed' = 'true' and r ->> 'follow_up_task_id' = current_setting('t.v1')::jsonb ->> 'follow_up_task_id'
           from (select api.visit_check_out('81000000-0000-0000-0000-000000000001', 'order_taken', 'Ordered 10 implants',
                                            30.044800, 31.235700, 15, now(), now() + interval '3 days') as r) x),
  'offline replay of a check-out returns the original result');
select is((select count(*)::int from field.location_events where visit_id = '81000000-0000-0000-0000-000000000001'
           and event_type = 'check_out'), 1, 'exactly one check-out fix is stored');
select is((select count(*)::int from work.tasks where ref_table = 'field.visits' and ref_id = '81000000-0000-0000-0000-000000000001'
           and source = 'visit' and status = 'open'), 1, 'the follow-up task is linked to the visit (no duplicate on replay)');
select ok((select outcome = 'order_taken' and check_out_at is not null and notes = 'Ordered 10 implants'
           from field.visits where id = '81000000-0000-0000-0000-000000000001'), 'visit records outcome, notes and check-out time');
select is(api.visit_check_in('81000000-0000-0000-0000-000000000002', '40000000-0000-0000-0000-000000000001',
  30.064400, 31.235700, 20, now() - interval '4 minutes') ->> 'verification_status', 'out_of_range', 'setup: out-of-range check-in');
select throws_like($$select api.visit_check_out('81000000-0000-0000-0000-000000000010', 'other', null, null, null, null, now())$$,
  'INVALID_STATE%planned', 'a visit that was never checked in cannot be checked out');
select throws_like($$select api.visit_check_out('81000000-0000-0000-0000-000000000002', 'great', null, null, null, null, now())$$,
  'VALIDATION%outcome%', 'unknown outcome is rejected');
select throws_like($$select api.visit_check_out('81000000-0000-0000-0000-000000000002', 'demo', null, null, null, null, now() - interval '1 hour')$$,
  'VALIDATION%before check-in', 'check-out cannot precede check-in');
select throws_like($$select api.visit_check_out('81000000-0000-0000-0000-0000000000ff', 'demo', null, null, null, null, now())$$,
  'NOT_FOUND%', 'unknown visit is NOT_FOUND');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a5');
select throws_like($$select api.visit_check_out('81000000-0000-0000-0000-000000000002', 'demo', null, null, null, null, now())$$,
  'PERMISSION_DENIED%', 'only the visiting rep can check out');

-- ===========================================================================
-- Verification exceptions
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is(api.visit_check_in('81000000-0000-0000-0000-000000000003', '40000000-0000-0000-0000-000000000001',
  30.044500, 31.235700, 350, now() - interval '3 minutes') ->> 'verification_status', 'low_accuracy', 'setup: low-accuracy check-in');
select throws_like($$select api.request_visit_exception('81000000-0000-0000-0000-000000000001', 'just because')$$,
  'INVALID_STATE%verified%', 'a verified visit needs no exception');
select is(set_config('t.e1', api.request_visit_exception('81000000-0000-0000-0000-000000000002', 'Clinic moved to the next street')::text,
  true)::jsonb ->> 'verification_status', 'exception_requested', 'rep requests an exception for an out-of-range visit');
select ok((select r ->> 'replayed' = 'true' and r ->> 'approval_request_id' = current_setting('t.e1')::jsonb ->> 'approval_request_id'
           from (select api.request_visit_exception('81000000-0000-0000-0000-000000000002', 'Clinic moved to the next street') as r) x),
  'repeating the request returns the pending approval');
select throws_like($$select api.request_visit_exception('81000000-0000-0000-0000-000000000003', '')$$,
  'REASON_REQUIRED%', 'an exception needs a reason');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a5');
select throws_like($$select api.request_visit_exception('81000000-0000-0000-0000-000000000003', 'not mine')$$,
  'PERMISSION_DENIED%', 'another rep cannot request an exception for the visit');
select throws_like(format($$select wf.on_decided_field_visit_exception(%L, true)$$, current_setting('t.e1')::jsonb ->> 'approval_request_id'),
  '%permission denied%', 'app users cannot call the visit exception hook');

select tests.clear_authentication();
select ok((select payload ->> 'original_status' = 'out_of_range' and entity_type = 'field.visit' and status = 'pending'
           from wf.approval_requests where id = (current_setting('t.e1')::jsonb ->> 'approval_request_id')::uuid),
  'approval request captures the original verdict');
select is((select count(*)::int from integration.outbox where event_type = 'visit.exception_requested'
           and aggregate_id = '81000000-0000-0000-0000-000000000002'), 1, 'visit.exception_requested is emitted once');
select ok(not exists (select 1 from integration.outbox where event_type like 'visit.%'
                      and (payload ? 'latitude' or payload ? 'longitude' or payload ? 'lat')),
  'visit events carry no GPS coordinates');
select lives_ok(format($$select wf.on_decided_field_visit_exception(%L, true)$$, current_setting('t.e1')::jsonb ->> 'approval_request_id'),
  'approval hook runs');
select is((select verification_status from field.visits where id = '81000000-0000-0000-0000-000000000002'), 'exception_approved',
  'approved exception updates the visit verdict');
select lives_ok(format($$select wf.on_decided_field_visit_exception(%L, true)$$, current_setting('t.e1')::jsonb ->> 'approval_request_id'),
  'visit hook is idempotent');
update wf.approval_requests set status = 'approved', decided_at = now()
where id = (current_setting('t.e1')::jsonb ->> 'approval_request_id')::uuid;
select throws_like(format($$select wf.on_decided_field_visit_exception(%L, false)$$, current_setting('t.e1')::jsonb ->> 'approval_request_id'),
  'INVALID_STATE: request is approved', 'a decision contradicting the request status is refused');
select throws_like($$select wf.on_decided_field_visit_exception('99999999-0000-0000-0000-000000000000', true)$$,
  'NOT_FOUND%', 'unknown request is NOT_FOUND');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select set_config('t.e2', api.request_visit_exception('81000000-0000-0000-0000-000000000003', 'GPS was poor inside the building')::text, true)
  is not null as setup;
select tests.clear_authentication();
select wf.on_decided_field_visit_exception((current_setting('t.e2')::jsonb ->> 'approval_request_id')::uuid, false);
select is((select verification_status from field.visits where id = '81000000-0000-0000-0000-000000000003'), 'exception_rejected',
  'rejected exception updates the visit verdict');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select throws_like($$select api.request_visit_exception('81000000-0000-0000-0000-000000000003', 'try again')$$,
  'INVALID_STATE%', 'a rejected exception cannot be re-requested');
select is((select count(*)::int from api.v_notifications where type = 'visit.exception_decided'), 2, 'rep is notified of both decisions');

-- First visit to a new clinic: no stored location → approved exception pins the clinic.
select set_config('t.c1', api.create_customer(p_clinic_name => 'Fresh Lead Clinic', p_phone_primary => '01566667777',
  p_governorate_code => 'EG-C')::text, true) is not null as setup;
select is(api.visit_check_in('81000000-0000-0000-0000-000000000004', (current_setting('t.c1')::jsonb ->> 'customer_id')::uuid,
  30.100000, 31.300000, 15, now() - interval '2 minutes') ->> 'verification_status', 'no_customer_location',
  'check-in at a clinic without a stored location is flagged');
select set_config('t.e3', api.request_visit_exception('81000000-0000-0000-0000-000000000004', 'First visit to a new clinic')::text, true)
  is not null as setup;
select tests.clear_authentication();
select wf.on_decided_field_visit_exception((current_setting('t.e3')::jsonb ->> 'approval_request_id')::uuid, true);
select ok((select location_verified and latitude = 30.100000 and longitude = 31.300000 from crm.customers
           where id = (current_setting('t.c1')::jsonb ->> 'customer_id')::uuid),
  'approving a no-location exception sets the clinic location from the check-in fix');

-- ===========================================================================
-- Visit RLS per role and raw GPS privacy
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is((select count(*)::int from api.v_visits), 5, 'rep sees own visits');
select is((select count(*)::int from field.location_events), 5, 'rep sees own raw fixes');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a5');
select is((select count(*)::int from api.v_visits), 0, 'another rep sees no visits');
select is((select count(*)::int from field.location_events), 0, 'another rep sees no raw fixes');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a3');
select is((select count(*)::int from api.v_visits), 5, 'area manager sees the team''s visits');
select is((select count(*)::int from field.location_events), 5, 'area manager reads the team''s raw fixes (field.location.read team)');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a2');
select is((select count(*)::int from api.v_visits where employee_name_en = 'Rep Cairo'), 5, 'sales director sees all visits with rep names');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select is((select count(*)::int from api.v_visits), 0, 'finance has no visit access');
select tests.clear_authentication();
select is((select count(*)::int from information_schema.columns where table_schema = 'api' and table_name = 'v_visits'
           and column_name in ('latitude','longitude')), 0, 'the visits view exposes no raw coordinates');

-- ===========================================================================
-- Retention
-- ===========================================================================
insert into field.visits (id, customer_id, employee_id, status) values
  ('81000000-0000-0000-0000-000000000020', '40000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000004', 'completed');
insert into field.location_events (visit_id, employee_id, event_type, latitude, longitude, accuracy_m, captured_at, received_at) values
  ('81000000-0000-0000-0000-000000000020', '20000000-0000-0000-0000-000000000004', 'check_in', 30.0448, 31.2357, 10,
   now() - interval '400 days', now() - interval '400 days');
select is(field.purge_old_location_events(), 1, 'retention job deletes fixes older than the configured window');
select is((select count(*)::int from field.location_events), 5, 'recent fixes are kept');
select ok(exists (select 1 from field.visits where id = '81000000-0000-0000-0000-000000000020'), 'the visit verdict is kept');
select is((select (details ->> 'deleted')::int from audit.security_events where event_type = 'retention_purge'), 1,
  'the purge is recorded as a security event');
update core.system_settings set value = '10' where key = 'field.location_retention_days';
select throws_like($$select field.purge_old_location_events()$$, 'VALIDATION%at least 30%', 'a dangerously short retention is refused');
select ok(not has_function_privilege('authenticated', 'field.purge_old_location_events()', 'execute')
          and not has_function_privilege('anon', 'field.purge_old_location_events()', 'execute')
          and not has_function_privilege('authenticated', 'wf.on_decided_field_visit_exception(uuid, boolean)', 'execute')
          and not has_function_privilege('anon', 'wf.on_decided_field_visit_exception(uuid, boolean)', 'execute'),
  'purge and visit hook are not executable by app roles');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select throws_like($$select field.purge_old_location_events()$$, '%permission denied%', 'a rep cannot run the purge');

select * from finish();
rollback;
