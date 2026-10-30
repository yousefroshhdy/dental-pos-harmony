-- D-14 phase 2, the Android shell (migration 20261102000100_tracking_native_source.sql):
-- source = 'native' is accepted again, and it is ADVISORY ONLY. A native point gets exactly the
-- rules a browser ('pwa') point gets:
--   · bound to the caller's own shift: outside a shift window it is refused, into a shift that
--     ended long ago it is refused (too_late), its capture time is kept;
--   · spacing (half the sampling interval) and the per-shift cap apply, across both sources;
--   · anomaly flags (low accuracy, impossible travel) are still set;
--   · idempotent by point id; another employee's id is a conflict;
--   · permission and read scope are unchanged.
begin;
select tests.load_fixture();
set constraints all immediate;
select plan(26);

-- Fixture: E004 rep Cairo (user a4, manager E003 = a3); E005 rep Delta (user a5); a6 finance.

select ok(not has_function_privilege('anon', 'api.record_location_pings(jsonb)', 'execute')
          and has_function_privilege('authenticated', 'api.record_location_pings(jsonb)', 'execute'),
  'the replaced command keeps its grants (signed-in users only)');

-- ===========================================================================
-- Setup: Rep Cairo opens a shift 2 hours ago
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is(api.acknowledge_tracking_notice('2026-10-30.1') ->> 'version', '2026-10-30.1', 'setup: the rep acknowledges the notice');
select is(api.start_shift('f5000000-0000-0000-0000-000000000001', 30.0444, 31.2357, 10, now() - interval '2 hours') ->> 'status', 'open',
  'setup: the rep starts a shift 2 hours ago');

-- ===========================================================================
-- Accepted, bound to the caller's open shift, capture time kept
-- ===========================================================================
select set_config('t.n1', api.record_location_pings(jsonb_build_array(jsonb_build_object(
    'id','f6000000-0000-0000-0000-000000000001','lat',30.0450,'lng',31.2360,'accuracy_m',8,
    'captured_at',now() - interval '110 minutes','source','native',
    'employee_id','20000000-0000-0000-0000-000000000005')))::text, true) is not null;
select is((current_setting('t.n1')::jsonb ->> 'accepted')::int, 1, 'a native point inside the open shift is accepted');
select ok((select lp.source = 'native'
                  and lp.employee_id = '20000000-0000-0000-0000-000000000004'
                  and lp.shift_id = (select id from field.work_shifts where client_ref = 'f5000000-0000-0000-0000-000000000001')
                  and lp.captured_at = now() - interval '110 minutes'
           from field.location_pings lp where lp.id = 'f6000000-0000-0000-0000-000000000001'),
  'it is stored as native, for the caller (a claimed employee_id is ignored), in the open shift, with its capture time');
select is(api.record_location_pings(jsonb_build_array(jsonb_build_object(
    'id','f6000000-0000-0000-0000-000000000001','lat',30.0450,'lng',31.2360,'accuracy_m',8,
    'captured_at',now() - interval '110 minutes','source','native'))) ->> 'replayed', 'true',
  'a replay of the same native point is an idempotent duplicate');

select is(api.record_location_pings(jsonb_build_array(jsonb_build_object(
    'id','f6000000-0000-0000-0000-000000000002','lat',30.0450,'lng',31.2360,'accuracy_m',8,
    'captured_at',now() - interval '5 hours','source','native'))) -> 'rejected' -> 0 ->> 'reason', 'outside_shift',
  'a native point before the shift started is rejected: outside_shift');
select is(api.record_location_pings(jsonb_build_array(jsonb_build_object(
    'id','f6000000-0000-0000-0000-000000000003','lat',30.0450,'lng',31.2360,'accuracy_m',8,
    'captured_at',now() + interval '10 minutes','source','native'))) -> 'rejected' -> 0 ->> 'reason', 'outside_shift',
  'a native point from the future (past the open window + tolerance) is rejected: outside_shift');
select is(api.record_location_pings(jsonb_build_array(jsonb_build_object(
    'id','f6000000-0000-0000-0000-000000000004','lat',30.0450,'lng',31.2360,'accuracy_m',8,
    'captured_at',now() - interval '90 minutes','source','gps'))) -> 'rejected' -> 0 ->> 'reason', 'invalid',
  'any source other than pwa or native is still rejected: invalid');
select is((select count(*)::int from field.location_pings where id in
            ('f6000000-0000-0000-0000-000000000002','f6000000-0000-0000-0000-000000000003','f6000000-0000-0000-0000-000000000004')), 0,
  'rejected points are not stored');

-- ===========================================================================
-- Spacing, anomaly flags: same rules for both sources
-- ===========================================================================
select is(api.record_location_pings(jsonb_build_array(jsonb_build_object(
    'id','f6000000-0000-0000-0000-000000000005','lat',30.0450,'lng',31.2360,'accuracy_m',8,
    'captured_at',now() - interval '109 minutes','source','native'))) -> 'rejected' -> 0 ->> 'reason', 'too_frequent',
  'a native point 60 s after a stored one is rejected: too_frequent');
select is(api.record_location_pings(jsonb_build_array(jsonb_build_object(
    'id','f6000000-0000-0000-0000-000000000006','lat',30.0450,'lng',31.2360,'accuracy_m',8,
    'captured_at',now() - interval '108 minutes 30 seconds','source','pwa'))) -> 'rejected' -> 0 ->> 'reason', 'too_frequent',
  'and so is a browser point 90 s after a native one: spacing counts every source alike');
select is((api.record_location_pings(jsonb_build_array(jsonb_build_object(
    'id','f6000000-0000-0000-0000-000000000007','lat',30.0460,'lng',31.2370,'accuracy_m',500,
    'captured_at',now() - interval '100 minutes','source','native'))) ->> 'accepted')::int, 1,
  'a low-accuracy native point is accepted …');
select ok((select anomaly_flags @> '{low_accuracy}' from field.location_pings where id = 'f6000000-0000-0000-0000-000000000007'),
  '… and flagged low_accuracy, as a browser point would be');
select is((api.record_location_pings(jsonb_build_array(jsonb_build_object(
    'id','f6000000-0000-0000-0000-000000000008','lat',31.0460,'lng',31.2370,'accuracy_m',8,
    'captured_at',now() - interval '95 minutes','source','native'))) ->> 'accepted')::int, 1,
  'a native point 111 km away 5 minutes later is accepted …');
select ok((select anomaly_flags @> '{impossible_travel}' from field.location_pings where id = 'f6000000-0000-0000-0000-000000000008'),
  '… and flagged impossible_travel (no trust from the native label)');

-- ===========================================================================
-- The per-shift cap
-- ===========================================================================
select tests.clear_authentication();
insert into core.system_settings (key, value, description) values ('tracking.max_points_per_shift', '3', 'test')
  on conflict (key) do update set value = excluded.value;
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is(api.record_location_pings(jsonb_build_array(jsonb_build_object(
    'id','f6000000-0000-0000-0000-000000000009','lat',31.0460,'lng',31.2370,'accuracy_m',8,
    'captured_at',now() - interval '80 minutes','source','native'))) -> 'rejected' -> 0 ->> 'reason', 'shift_cap',
  'with a cap of 3 per shift and 3 stored, a fourth native point is rejected: shift_cap');
select tests.clear_authentication();
update core.system_settings set value = '240' where key = 'tracking.max_points_per_shift';

-- ===========================================================================
-- No late writes into an old shift
-- ===========================================================================
insert into field.work_shifts (id, employee_id, client_ref, end_client_ref, status, notice_version, business_date, started_at,
                               start_captured_at, window_start, ended_at, window_end) values
  ('f7000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000004', gen_random_uuid(), gen_random_uuid(), 'closed',
   '2026-10-30.1', ((now() - interval '40 days') at time zone 'Africa/Cairo')::date, now() - interval '40 days',
   now() - interval '40 days', now() - interval '40 days', now() - interval '40 days' + interval '8 hours',
   now() - interval '40 days' + interval '8 hours');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is(api.record_location_pings(jsonb_build_array(jsonb_build_object(
    'id','f6000000-0000-0000-0000-000000000010','lat',30.0450,'lng',31.2360,'accuracy_m',8,
    'captured_at',now() - interval '40 days' + interval '2 hours','source','native'))) -> 'rejected' -> 0 ->> 'reason', 'too_late',
  'a native point into a shift that ended 40 days ago is rejected: too_late');

-- ===========================================================================
-- Permission and scope unchanged
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a5');
select is(api.record_location_pings(jsonb_build_array(jsonb_build_object(
    'id','f6000000-0000-0000-0000-000000000001','lat',30.0450,'lng',31.2360,'accuracy_m',8,
    'captured_at',now() - interval '110 minutes','source','native'))) -> 'rejected' -> 0 ->> 'reason', 'conflict',
  'another rep re-sending the rep''s point id as native is rejected: conflict');
select is((select count(*)::int from field.location_pings where employee_id = '20000000-0000-0000-0000-000000000004'), 0,
  'another rep cannot read the rep''s native points');
select throws_like($$select api.tracking_day('20000000-0000-0000-0000-000000000004', core.business_date())$$,
  'PERMISSION_DENIED%', 'another rep cannot open the rep''s day');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select throws_like($$select api.record_location_pings(jsonb_build_array(jsonb_build_object(
    'id','f6000000-0000-0000-0000-000000000011','lat',30.0450,'lng',31.2360,'accuracy_m',8,
    'captured_at',now(),'source','native')))$$,
  'PERMISSION_DENIED: field.shift.start', 'a native source does not open the command to roles without field.shift.start');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a3');
select is((select count(*)::int from field.location_pings where employee_id = '20000000-0000-0000-0000-000000000004' and source = 'native'), 3,
  'the rep''s manager reads the team''s native points');
select set_config('t.day', api.tracking_day('20000000-0000-0000-0000-000000000004',
                    ((now() - interval '2 hours') at time zone 'Africa/Cairo')::date)::text, true) is not null;
select ok((select bool_and(p ->> 'source' = 'native') and count(*) = 3
           from jsonb_array_elements(current_setting('t.day')::jsonb -> 'points') p
           where (p ->> 'captured_at')::timestamptz >= now() - interval '2 hours'),
  'the day page lists the native points with their source label');
select ok((select bool_or(p ->> 'id' = 'f6000000-0000-0000-0000-000000000007' and not (p ->> 'usable')::boolean)
           from jsonb_array_elements(current_setting('t.day')::jsonb -> 'points') p),
  'a low-accuracy native point is not usable for distance and stops, like any point');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is((api.my_tracking_status() -> 'open_shift' ->> 'ping_count')::int, 3, 'the rep''s status counts the native points of the open shift');

select * from finish();
rollback;
