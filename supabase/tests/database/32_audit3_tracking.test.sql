-- Third audit, tracking findings (migration 20261101000200_audit3_tracking_fixes.sql). Each block
-- fails on the code before that migration:
--   M3  per-shift cap, half-interval spacing (rejected, not errors), a 3000-point day built in
--       well under 2 s with a capped point list (points_truncated)
--   M4  a back-dated second shift cannot overlap the first (R1: 8 real hours stay 8, not 16);
--       overlapping legacy windows are merged; shift anomaly flags reach the day flags
--   M5  no points into a shift that ended long ago; retention counts from the capture time
--   M7  a purged day shows the stored summary, not one whole-shift gap
--   L2  revised by D-14 phase 2 (migration 20261102000100): source = 'native' is accepted again,
--       as an advisory label only (suite 33 shows it gets no extra trust)
begin;
select tests.load_fixture();
set constraints all immediate;
select plan(39);

-- Fixture: E004 rep Cairo (user a4, manager E003 = a3); E005 rep Delta (user a5); a1 owner.

-- ===========================================================================
-- Settings and privileges
-- ===========================================================================
select is((select value #>> '{}' from core.system_settings where key = 'tracking.max_points_per_shift'), '240',
  'M3: per-shift cap defaults to ceil(10 h × 3600 / (300 s / 2)) = 240');
select is((select value #>> '{}' from core.system_settings where key = 'tracking.max_day_points'), '1000',
  'M3: the day page lists at most 1000 points by default');
select is((select value #>> '{}' from core.system_settings where key = 'tracking.late_point_grace_hours'), '24',
  'M5: late points are accepted for 24 hours after a shift ended');
select ok(to_regprocedure('field.tracking_day_windows(uuid, date)') is not null
          and not has_function_privilege('authenticated', 'field.tracking_day_windows(uuid, date)', 'execute')
          and not has_function_privilege('anon', 'field.tracking_day_windows(uuid, date)', 'execute'),
  'the merged-window helper exists and is not client-callable');
select ok(not has_function_privilege('anon', 'api.record_location_pings(jsonb)', 'execute')
          and has_function_privilege('authenticated', 'api.record_location_pings(jsonb)', 'execute')
          and not has_function_privilege('authenticated', 'service.tracking_purge()', 'execute'),
  'replaced commands keep their grants');

-- ===========================================================================
-- M4 (R1 from the audit): two shifts both claiming the last 8 hours
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is(api.acknowledge_tracking_notice('2026-10-30.1') ->> 'version', '2026-10-30.1', 'setup: the rep acknowledges the notice');
select is(api.start_shift('f1000000-0000-0000-0000-000000000001', 30.0444, 31.2357, 10, now() - interval '8 hours') ->> 'status', 'open',
  'setup: the first shift starts 8 hours ago (queued offline)');
select is((api.end_shift('f1000000-0000-0000-0000-000000000002', 30.0444, 31.2357, 10, now()) ->> 'shift_seconds')::int, 28800,
  'setup: it ends now, 8 hours');
select is(api.start_shift('f1000000-0000-0000-0000-000000000003', 30.0444, 31.2357, 10, now() - interval '8 hours') ->> 'status', 'open',
  'setup: a second shift also claims to start 8 hours ago');
select ok((select s2.window_start = s1.window_end and s2.anomaly_flags @> '{overlap_clamped}'
           from field.work_shifts s1, field.work_shifts s2
           where s1.client_ref = 'f1000000-0000-0000-0000-000000000001' and s2.client_ref = 'f1000000-0000-0000-0000-000000000003'),
  'its window is clamped to the end of the previous one and flagged overlap_clamped');
select is((api.end_shift('f1000000-0000-0000-0000-000000000004', 30.0444, 31.2357, 10, now()) ->> 'shift_seconds')::int, 0,
  'so it adds no shift time');
select is((api.tracking_day('20000000-0000-0000-0000-000000000004',
            ((now() - interval '8 hours') at time zone 'Africa/Cairo')::date) ->> 'shift_seconds')::int, 28800,
  'R1: 8 real hours show as 8 hours, not 16');
select ok((api.tracking_day('20000000-0000-0000-0000-000000000004',
            (select business_date from field.work_shifts where client_ref = 'f1000000-0000-0000-0000-000000000003')) -> 'flags')
          @> '["late_sync","overlap_clamped"]',
  'each shift''s anomaly flags are carried into the day flags');
select is((api.my_tracking_status() ->> 'today_shift_seconds')::int,
          (select case when business_date = core.business_date() then 28800 else 0 end from field.work_shifts
           where client_ref = 'f1000000-0000-0000-0000-000000000001'),
  'the shift card''s "today so far" counts the 8 hours once');

-- Legacy overlapping windows (written before the clamp) are merged when the day is computed.
select tests.clear_authentication();
insert into field.work_shifts (id, employee_id, client_ref, end_client_ref, status, notice_version, business_date, started_at,
                               start_captured_at, window_start, ended_at, window_end) values
  ('f3000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000005', gen_random_uuid(), gen_random_uuid(), 'closed',
   '2026-10-30.1', core.business_date() - 10,
   ((core.business_date() - 10) + time '09:00') at time zone 'Africa/Cairo', ((core.business_date() - 10) + time '09:00') at time zone 'Africa/Cairo',
   ((core.business_date() - 10) + time '09:00') at time zone 'Africa/Cairo', ((core.business_date() - 10) + time '17:00') at time zone 'Africa/Cairo',
   ((core.business_date() - 10) + time '17:00') at time zone 'Africa/Cairo'),
  ('f3000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000005', gen_random_uuid(), gen_random_uuid(), 'closed',
   '2026-10-30.1', core.business_date() - 10,
   ((core.business_date() - 10) + time '12:00') at time zone 'Africa/Cairo', ((core.business_date() - 10) + time '12:00') at time zone 'Africa/Cairo',
   ((core.business_date() - 10) + time '12:00') at time zone 'Africa/Cairo', ((core.business_date() - 10) + time '18:00') at time zone 'Africa/Cairo',
   ((core.business_date() - 10) + time '18:00') at time zone 'Africa/Cairo');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');
select set_config('t.legacy', api.tracking_day('20000000-0000-0000-0000-000000000005', core.business_date() - 10)::text, true) is not null;
select ok((current_setting('t.legacy')::jsonb ->> 'shift_count')::int = 2
          and (current_setting('t.legacy')::jsonb ->> 'shift_seconds')::int = 32400,
  'overlapping windows 09:00–17:00 and 12:00–18:00 count as 9 hours, not 14');
select is((current_setting('t.legacy')::jsonb ->> 'gap_seconds')::int, 32400,
  'and the empty merged window is one 9-hour gap, not two');

-- ===========================================================================
-- L2, revised by D-14 phase 2 (20261102000100): 'native' is accepted, advisory only
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is((api.record_location_pings(jsonb_build_array(jsonb_build_object(
    'id','f2000000-0000-0000-0000-000000000001','lat',30.05,'lng',31.24,'accuracy_m',5,
    'captured_at',now() - interval '3 hours','source','native'))) ->> 'accepted'), '1',
  'L2 (phase 2): a point with source "native" is accepted into the caller''s own shift, like any point');
select is((select source from field.location_pings where id = 'f2000000-0000-0000-0000-000000000001'), 'native',
  'and stored with its advisory source label');

-- ===========================================================================
-- M5: points only into an open or recently closed shift
-- ===========================================================================
select is((api.record_location_pings(jsonb_build_array(jsonb_build_object(
    'id','f2000000-0000-0000-0000-000000000002','lat',30.05,'lng',31.24,'accuracy_m',5,'captured_at',now() - interval '4 hours'))))
  ->> 'accepted', '1', 'a late upload into the shift that ended just now is still accepted');
select tests.clear_authentication();
insert into field.work_shifts (id, employee_id, client_ref, end_client_ref, status, notice_version, business_date, started_at,
                               start_captured_at, window_start, ended_at, window_end) values
  ('f3000000-0000-0000-0000-000000000003', '20000000-0000-0000-0000-000000000004', gen_random_uuid(), gen_random_uuid(), 'closed',
   '2026-10-30.1', ((now() - interval '100 days') at time zone 'Africa/Cairo')::date, now() - interval '100 days',
   now() - interval '100 days', now() - interval '100 days', now() - interval '100 days' + interval '8 hours',
   now() - interval '100 days' + interval '8 hours');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is((api.record_location_pings(jsonb_build_array(jsonb_build_object(
    'id','f2000000-0000-0000-0000-000000000003','lat',30.1,'lng',31.3,'accuracy_m',5,
    'captured_at',now() - interval '100 days' + interval '2 hours'))) -> 'rejected' -> 0 ->> 'reason'), 'too_late',
  'R2: a point into a shift that ended 100 days ago is rejected as too_late');
select is((select count(*)::int from field.location_pings where id = 'f2000000-0000-0000-0000-000000000003'), 0,
  'and nothing is stored in the old shift');

-- ===========================================================================
-- M3: spacing and the per-shift cap (answers, never errors)
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a5');
select is(api.acknowledge_tracking_notice('2026-10-30.1') ->> 'version', '2026-10-30.1', 'setup: Rep Delta acknowledges the notice');
select is(api.start_shift('f1000000-0000-0000-0000-000000000011', 31.04, 31.37, 10, now() - interval '2 hours') ->> 'status', 'open',
  'setup: Rep Delta starts a shift 2 hours ago');
select set_config('t.sp', api.record_location_pings(jsonb_build_array(
  jsonb_build_object('id','f2000000-0000-0000-0000-000000000011','lat',31.0400,'lng',31.3700,'accuracy_m',10,'captured_at',now() - interval '100 minutes'),
  jsonb_build_object('id','f2000000-0000-0000-0000-000000000012','lat',31.0401,'lng',31.3700,'accuracy_m',10,'captured_at',now() - interval '99 minutes'),
  jsonb_build_object('id','f2000000-0000-0000-0000-000000000013','lat',31.0402,'lng',31.3700,'accuracy_m',10,'captured_at',now() - interval '97 minutes 30 seconds')))::text,
  true) is not null;
select is((current_setting('t.sp')::jsonb ->> 'accepted')::int, 2,
  'points 150 s apart (half the 300 s interval) are accepted');
select is(current_setting('t.sp')::jsonb -> 'rejected', '[{"id":"f2000000-0000-0000-0000-000000000012","reason":"too_frequent"}]'::jsonb,
  'a point 60 s after a stored one is answered rejected: too_frequent, not an error');
select is((select count(*)::int from field.location_pings where shift_id =
            (select id from field.work_shifts where client_ref = 'f1000000-0000-0000-0000-000000000011')), 2,
  'only the spaced points are stored');

select tests.clear_authentication();
insert into core.system_settings (key, value, description) values ('tracking.max_points_per_shift', '4', 'test')
  on conflict (key) do update set value = excluded.value;
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a5');
select set_config('t.cap', api.record_location_pings(jsonb_build_array(
  jsonb_build_object('id','f2000000-0000-0000-0000-000000000021','lat',31.0400,'lng',31.3700,'accuracy_m',10,'captured_at',now() - interval '90 minutes'),
  jsonb_build_object('id','f2000000-0000-0000-0000-000000000022','lat',31.0400,'lng',31.3700,'accuracy_m',10,'captured_at',now() - interval '85 minutes'),
  jsonb_build_object('id','f2000000-0000-0000-0000-000000000023','lat',31.0400,'lng',31.3700,'accuracy_m',10,'captured_at',now() - interval '80 minutes'),
  jsonb_build_object('id','f2000000-0000-0000-0000-000000000024','lat',31.0400,'lng',31.3700,'accuracy_m',10,'captured_at',now() - interval '75 minutes')))::text,
  true) is not null;
select is((current_setting('t.cap')::jsonb ->> 'accepted')::int, 2, 'with a cap of 4 per shift, only 2 more points are stored');
select is((select array_agg(r ->> 'reason' order by r ->> 'id') from jsonb_array_elements(current_setting('t.cap')::jsonb -> 'rejected') r),
  array['shift_cap','shift_cap'], 'the rest are answered rejected: shift_cap');
select is((api.record_location_pings(jsonb_build_array(
  jsonb_build_object('id','f2000000-0000-0000-0000-000000000021','lat',31.0400,'lng',31.3700,'accuracy_m',10,'captured_at',now() - interval '90 minutes'))))
  ->> 'replayed', 'true', 'a replay of a stored point is still an idempotent duplicate at the cap');
select tests.clear_authentication();
update core.system_settings set value = '240' where key = 'tracking.max_points_per_shift';

-- ===========================================================================
-- M3 performance guard: 3000 points written directly (bypassing the API cap)
-- ===========================================================================
insert into field.work_shifts (id, employee_id, client_ref, end_client_ref, status, notice_version, business_date, started_at,
                               start_captured_at, window_start, ended_at, window_end) values
  ('f3000000-0000-0000-0000-000000000004', '20000000-0000-0000-0000-000000000005', gen_random_uuid(), gen_random_uuid(), 'closed',
   '2026-10-30.1', core.business_date() - 20,
   ((core.business_date() - 20) + time '08:00') at time zone 'Africa/Cairo', ((core.business_date() - 20) + time '08:00') at time zone 'Africa/Cairo',
   ((core.business_date() - 20) + time '08:00') at time zone 'Africa/Cairo', ((core.business_date() - 20) + time '17:00') at time zone 'Africa/Cairo',
   ((core.business_date() - 20) + time '17:00') at time zone 'Africa/Cairo');
insert into field.location_pings (id, shift_id, employee_id, latitude, longitude, accuracy_m, captured_at)
select gen_random_uuid(), 'f3000000-0000-0000-0000-000000000004', '20000000-0000-0000-0000-000000000005',
       30.0444 + (i % 7) * 0.0001, 31.2357 + (i / 500) * 0.01, 5,
       (((core.business_date() - 20) + time '08:00') at time zone 'Africa/Cairo') + i * interval '10 seconds'
from generate_series(1, 3000) i;
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');
select set_config('t.t0', clock_timestamp()::text, true) is not null;
select set_config('t.big', api.tracking_day('20000000-0000-0000-0000-000000000005', core.business_date() - 20)::text, true) is not null;
select ok(clock_timestamp() - current_setting('t.t0')::timestamptz < interval '2 seconds',
  'a 3000-point day is built in under 2 seconds (it took ' || round(extract(epoch from clock_timestamp() - current_setting('t.t0')::timestamptz)::numeric, 3) || ' s)');
select ok((current_setting('t.big')::jsonb ->> 'ping_count')::int = 3000
          and jsonb_array_length(current_setting('t.big')::jsonb -> 'points') = 1000
          and (current_setting('t.big')::jsonb ->> 'points_truncated')::boolean,
  'the point list stops at 1000 and says so (points_truncated); the totals count all 3000');
select is((current_setting('t.big')::jsonb -> 'points' -> 999 ->> 'captured_at')::timestamptz,
          (((core.business_date() - 20) + time '08:00') at time zone 'Africa/Cairo') + interval '10000 seconds',
  'the listed points are the first 1000 in time order');
select is((api.tracking_day('20000000-0000-0000-0000-000000000005', core.business_date() - 10) ->> 'points_truncated')::boolean, false,
  'an ordinary day is not truncated');

-- ===========================================================================
-- M5 retention by capture time, M7 the purged day (t6 from the audit)
-- ===========================================================================
select tests.clear_authentication();
-- Captured 100 days ago but uploaded today: retention counts from the capture.
insert into field.location_pings (id, shift_id, employee_id, latitude, longitude, accuracy_m, captured_at, received_at) values
  ('f2000000-0000-0000-0000-000000000031', 'f3000000-0000-0000-0000-000000000003', '20000000-0000-0000-0000-000000000004',
   30.1, 31.3, 5, now() - interval '100 days' + interval '1 hour', now());
-- A full 8-hour day 100 days ago: one point every 5 minutes, no gap.
insert into field.work_shifts (id, employee_id, client_ref, end_client_ref, status, notice_version, business_date, started_at,
                               start_captured_at, window_start, ended_at, window_end) values
  ('f3000000-0000-0000-0000-000000000009', '20000000-0000-0000-0000-000000000005', gen_random_uuid(), gen_random_uuid(), 'closed',
   '2026-10-30.1', ((now() - interval '100 days') at time zone 'Africa/Cairo')::date, now() - interval '100 days',
   now() - interval '100 days', now() - interval '100 days', now() - interval '100 days' + interval '8 hours',
   now() - interval '100 days' + interval '8 hours');
insert into field.location_pings (id, shift_id, employee_id, latitude, longitude, accuracy_m, captured_at, received_at)
select gen_random_uuid(), 'f3000000-0000-0000-0000-000000000009', '20000000-0000-0000-0000-000000000005', 30.0444, 31.2357 + i * 0.001, 5,
       now() - interval '100 days' + i * interval '5 minutes', now() - interval '100 days' + i * interval '5 minutes'
from generate_series(0, 96) i;
set local role service_role;
select ok((service.tracking_purge() ->> 'deleted')::int >= 98, 'setup: the retention purge runs');
reset role;
select is((select count(*)::int from field.location_pings where id = 'f2000000-0000-0000-0000-000000000031'), 0,
  'M5: a point captured 100 days ago is purged even though it was uploaded today');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');
select set_config('t.purged', api.tracking_day('20000000-0000-0000-0000-000000000005',
                    ((now() - interval '100 days') at time zone 'Africa/Cairo')::date)::text, true) is not null;
select is((current_setting('t.purged')::jsonb ->> 'summary_only')::boolean, true,
  'M7: the purged day is answered from the stored summary (summary_only)');
select ok((current_setting('t.purged')::jsonb ->> 'gap_seconds')::int = 0
          and not (current_setting('t.purged')::jsonb -> 'flags') ? 'gap'
          and jsonb_array_length(current_setting('t.purged')::jsonb -> 'gaps') = 0,
  'M7: no false whole-shift gap: the stored 0 gap seconds, no gap flag, no live gaps');
select ok((current_setting('t.purged')::jsonb ->> 'distance_m')::numeric = (current_setting('t.purged')::jsonb -> 'stored_summary' ->> 'distance_m')::numeric
          and (current_setting('t.purged')::jsonb ->> 'distance_m')::numeric > 9000
          and (current_setting('t.purged')::jsonb ->> 'ping_count')::int = 97
          and (current_setting('t.purged')::jsonb ->> 'shift_seconds')::int = 28800,
  'M7: distance, point count and shift time are the stored summary figures');
select ok(jsonb_array_length(current_setting('t.purged')::jsonb -> 'points') = 0
          and jsonb_array_length(current_setting('t.purged')::jsonb -> 'stops') = 0
          and jsonb_array_length(current_setting('t.purged')::jsonb -> 'shifts') = 1
          and (current_setting('t.purged')::jsonb ->> 'retention_days')::int = 90,
  'M7: no live points or stops; the shift itself and the retention period are still shown');

select * from finish();
rollback;
