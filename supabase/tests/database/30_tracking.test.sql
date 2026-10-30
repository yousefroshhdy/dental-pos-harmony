-- Work-hours location tracking (D-14): notice before the first shift, one open shift, points
-- only inside a shift window (idempotent by point id, anomaly flags), end/replay, the derived
-- day (stops, gaps, distance, visits) on a synthetic track, Cairo-day boundaries, auto-close,
-- retention purge with daily summaries, and read scope per role.
begin;
select tests.load_fixture();
select plan(98);

-- Fixture ids: E004 rep Cairo (user a4, manager E003 = area mgr a3, whose manager is E002 = sales
-- director a2); E005 rep Delta (user a5, manager E002); E009 new hire (no login, manager E003).

-- ===========================================================================
-- Reference data and privileges
-- ===========================================================================
select is((select count(*)::int from field.tracking_notices where is_current), 1, 'exactly one current tracking notice is published');
select ok((select body_en ~ '90 days' and body_ar ~ '90' from field.tracking_notices where is_current),
  'the notice states the 90-day retention in both languages');
select is((select value #>> '{}' from core.system_settings where key = 'tracking.max_shift_hours'), '10', 'D-14 default: 10-hour shift cap');
select is((select value #>> '{}' from core.system_settings where key = 'tracking.sample_interval_s'), '300', 'D-14 default: one point every 5 minutes');
select is((select value #>> '{}' from core.system_settings where key = 'tracking.retention_days'), '90', 'D-14 default: 90-day retention');
select is((select count(*)::int from authz.role_permissions rp join authz.roles r on r.id = rp.role_id
           where (r.code, rp.permission_code, rp.scope) in (('sales_rep','field.shift.start','own'),
                 ('area_manager','field.tracking.read','team'), ('sales_director','field.tracking.read','team'))), 3,
  'system roles hold the new permissions at the D-14 scopes');
select ok(not exists (select 1 from authz.role_permissions where permission_code = 'field.tracking.read'
                      and role_id = (select id from authz.roles where code = 'sales_rep')),
  'reps do not hold field.tracking.read (they see only themselves)');
select ok(not has_function_privilege('anon', 'api.start_shift(uuid, numeric, numeric, numeric, timestamptz)', 'execute')
          and has_function_privilege('authenticated', 'api.record_location_pings(jsonb)', 'execute'),
  'commands are callable by signed-in users only');
select ok(not has_function_privilege('authenticated', 'field.tracking_compute_day(uuid, date, boolean, boolean)', 'execute')
          and not has_function_privilege('authenticated', 'field.tracking_close_stale(uuid)', 'execute'),
  'internal tracking helpers are not client-callable');
select ok(not has_function_privilege('authenticated', 'service.tracking_purge()', 'execute')
          and not has_function_privilege('authenticated', 'service.tracking_auto_close()', 'execute')
          and has_function_privilege('service_role', 'service.tracking_purge()', 'execute')
          and has_function_privilege('service_role', 'service.tracking_auto_close()', 'execute'),
  'auto-close and purge are service-role only');
select ok(not has_function_privilege('authenticated', 'api.post_inventory_adjustment(uuid, uuid, uuid, int, text, text)', 'execute'),
  'this migration does not re-open functions closed earlier');

-- ===========================================================================
-- Notice required, then one open shift
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is((api.my_tracking_status() ->> 'acknowledged_at'), null, 'status: the notice is not yet acknowledged');
select throws_like($$select api.start_shift('e1000000-0000-0000-0000-000000000001', 30.0444, 31.2357, 10, now() - interval '30 minutes')$$,
  'NOTICE_REQUIRED%', 'a shift cannot start before the notice is acknowledged');
select is((api.record_location_pings('[{"id":"e2000000-0000-0000-0000-000000000099","lat":30.0444,"lng":31.2357,"accuracy_m":10}]'::jsonb
           || jsonb_build_array(jsonb_build_object('id','e2000000-0000-0000-0000-000000000098','lat',30.0444,'lng',31.2357,
                                                   'accuracy_m',10,'captured_at',now())))
           -> 'rejected' -> 1 ->> 'reason'), 'outside_shift', 'no shift open: points are refused');
select is((select count(*)::int from field.location_pings), 0, 'and nothing is stored');
select throws_like($$select api.acknowledge_tracking_notice('2020-01-01.1')$$, 'NOTICE_OUTDATED%', 'only the current notice version can be acknowledged');
select is(api.acknowledge_tracking_notice('2026-10-30.1') ->> 'replayed', 'false', 'the rep acknowledges the notice');
select is(api.acknowledge_tracking_notice('2026-10-30.1') ->> 'replayed', 'true', 'acknowledging again is an idempotent replay');
select is((select count(*)::int from field.tracking_notice_acks where employee_id = '20000000-0000-0000-0000-000000000004'), 1,
  'the acknowledgement is stored once, with its version and time');

select is(set_config('t.s1', api.start_shift('e1000000-0000-0000-0000-000000000001', 30.0444, 31.2357, 10,
  now() - interval '30 minutes')::text, true)::jsonb ->> 'status', 'open', 'the rep starts the day');
select ok((select window_start = now() - interval '30 minutes' and started_at = now()
                  and business_date = (window_start at time zone 'Africa/Cairo')::date
           from field.work_shifts where client_ref = 'e1000000-0000-0000-0000-000000000001'),
  'the window starts at the device time; server time and the Cairo business date are stored');
select ok((select r ->> 'replayed' = 'true' and r ->> 'shift_id' = current_setting('t.s1')::jsonb ->> 'shift_id'
           from (select api.start_shift('e1000000-0000-0000-0000-000000000001', 30.0444, 31.2357, 10, now() - interval '30 minutes') as r) x),
  'replaying the start returns the same shift');
select throws_like($$select api.start_shift('e1000000-0000-0000-0000-000000000002', 30.0444, 31.2357, 10, now())$$,
  'SHIFT_OPEN%', 'a second open shift is refused');
select throws_like($$select api.start_shift('e1000000-0000-0000-0000-000000000003', 95, 31.2357, 10, now())$$,
  'VALIDATION%', 'an impossible coordinate is refused');
select ok((api.my_tracking_status() -> 'open_shift' ->> 'id') = current_setting('t.s1')::jsonb ->> 'shift_id',
  'status shows the open shift');

-- ===========================================================================
-- Points: window, idempotency, anomaly flags
-- ===========================================================================
select set_config('t.b1', jsonb_build_array(
  jsonb_build_object('id','e2000000-0000-0000-0000-000000000001','lat',30.0444,'lng',31.2357,'accuracy_m',12,'captured_at',now() - interval '20 minutes'),
  jsonb_build_object('id','e2000000-0000-0000-0000-000000000002','lat',30.0450,'lng',31.2360,'accuracy_m',15,'captured_at',now() - interval '15 minutes'),
  jsonb_build_object('id','e2000000-0000-0000-0000-000000000003','lat',30.0450,'lng',31.2360,'accuracy_m',15,'captured_at',now() - interval '2 hours'))::text, true) is not null;
select ok((select r ->> 'accepted' = '2' and r -> 'rejected' -> 0 ->> 'reason' = 'outside_shift'
                  and r -> 'rejected' -> 0 ->> 'id' = 'e2000000-0000-0000-0000-000000000003'
           from (select api.record_location_pings(current_setting('t.b1')::jsonb) as r) x),
  'points inside the shift are stored; a point before the shift start is rejected');
select ok((select r ->> 'accepted' = '0' and r ->> 'duplicates' = '2'
           from (select api.record_location_pings(current_setting('t.b1')::jsonb) as r) x),
  'replaying the batch stores nothing twice (idempotent by point id)');
select is((select count(*)::int from field.location_pings where employee_id = '20000000-0000-0000-0000-000000000004'), 2,
  'two points stored');
select is(api.record_location_pings('[{"id":"e2000000-0000-0000-0000-000000000001","lat":30.0444,"lng":31.2357,"accuracy_m":12,"captured_at":"2026-01-01T00:00:00Z"}]'::jsonb) ->> 'replayed',
  'true', 'a batch of already-stored ids answers replayed (the queue marks it done)');
select is(api.record_location_pings('[{"id":"not-a-uuid","lat":30.0,"lng":31.0,"captured_at":"2026-01-01T00:00:00Z"},{"id":"e2000000-0000-0000-0000-000000000004","lng":31.0}]'::jsonb)
          -> 'rejected' @> '[{"id":"not-a-uuid","reason":"invalid"},{"id":"e2000000-0000-0000-0000-000000000004","reason":"invalid"}]',
  true,
  'malformed points are rejected one by one, not the whole batch');
select throws_like($$select api.record_location_pings('{"id":"x"}'::jsonb)$$, 'VALIDATION%array%', 'the batch must be an array');
select is((api.record_location_pings(jsonb_build_array(
  jsonb_build_object('id','e2000000-0000-0000-0000-000000000005','lat',30.5000,'lng',31.2360,'accuracy_m',15,'captured_at',now() - interval '12 minutes'))))
  ->> 'accepted', '1', 'setup: a point 50 km away three minutes later');
select ok((select anomaly_flags @> '{impossible_travel}' from field.location_pings where id = 'e2000000-0000-0000-0000-000000000005'),
  'impossible travel is flagged');
select lives_ok($$select api.record_location_pings(jsonb_build_array(
  jsonb_build_object('id','e2000000-0000-0000-0000-000000000006','lat',30.0450,'lng',31.2360,'accuracy_m',500,'captured_at',now() - interval '9 minutes'),
  jsonb_build_object('id','e2000000-0000-0000-0000-000000000007','lat',30.0450,'lng',31.2360,'accuracy_m',15,'captured_at',now() - interval '9 minutes'),
  jsonb_build_object('id','e2000000-0000-0000-0000-000000000008','lat',30.0451,'lng',31.2361,'accuracy_m',15,'captured_at',now() + interval '90 seconds')))$$,
  'setup: low-accuracy, duplicate and slightly-future points');
select ok((select anomaly_flags @> '{low_accuracy}' from field.location_pings where id = 'e2000000-0000-0000-0000-000000000006'),
  'low accuracy is flagged');
-- Audit 3 (M3): a point closer than half the sampling interval to a stored one is refused
-- (too_frequent), so a same-time, same-place repeat is no longer stored as duplicate_fix.
select ok(not exists (select 1 from field.location_pings where id = 'e2000000-0000-0000-0000-000000000007'),
  'a second point with the same time and place is refused as too frequent');
select ok((select anomaly_flags @> '{clock_skew}' from field.location_pings where id = 'e2000000-0000-0000-0000-000000000008'),
  'a point from the device''s future (within tolerance) is flagged clock_skew');
select is((api.record_location_pings(jsonb_build_array(
  jsonb_build_object('id','e2000000-0000-0000-0000-000000000009','lat',30.0451,'lng',31.2361,'accuracy_m',15,'captured_at',now() + interval '1 hour'))))
  -> 'rejected' -> 0 ->> 'reason', 'outside_shift', 'a point far in the future is rejected');
select is((select (api.my_tracking_status() -> 'open_shift' ->> 'ping_count')::int), 5, 'status counts the points of the open shift');
select throws_like($$update field.location_pings set latitude = 0 where id = 'e2000000-0000-0000-0000-000000000001'$$,
  '%permission denied%', 'points cannot be edited by app users');

-- ===========================================================================
-- End of the day
-- ===========================================================================
select is(api.end_shift('e1000000-0000-0000-0000-0000000000e1', 30.0451, 31.2361, 12, now(), 'e1000000-0000-0000-0000-000000000001') ->> 'status',
  'closed', 'the rep ends the day');
select ok((select status = 'closed' and window_end = now() and end_client_ref = 'e1000000-0000-0000-0000-0000000000e1'
           from field.work_shifts where client_ref = 'e1000000-0000-0000-0000-000000000001'), 'the shift is closed at the end time');
select is(api.end_shift('e1000000-0000-0000-0000-0000000000e1', 30.0451, 31.2361, 12, now()) ->> 'replayed', 'true',
  'replaying the end is idempotent');
select throws_like($$select api.end_shift('e1000000-0000-0000-0000-0000000000e2', null, null, null, now())$$,
  'NO_OPEN_SHIFT%', 'ending again with a new ref finds no open shift');
select is((api.record_location_pings(jsonb_build_array(
  jsonb_build_object('id','e2000000-0000-0000-0000-000000000010','lat',30.0452,'lng',31.2362,'accuracy_m',15,'captured_at',now() - interval '5 minutes'),
  jsonb_build_object('id','e2000000-0000-0000-0000-000000000011','lat',30.0452,'lng',31.2362,'accuracy_m',15,'captured_at',now() + interval '5 minutes'))))
  ->> 'accepted', '1', 'after the end, a late upload inside the closed window is accepted and one after it is not');
select is(api.my_tracking_status() -> 'open_shift', 'null'::jsonb, 'status shows no open shift after the end');

-- ===========================================================================
-- Read scope
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a5');
select is((select count(*)::int from field.location_pings where employee_id = '20000000-0000-0000-0000-000000000004'), 0,
  'another rep cannot read the rep''s points');
select is((select count(*)::int from field.work_shifts where employee_id = '20000000-0000-0000-0000-000000000004'), 0,
  'another rep cannot read the rep''s shifts');
select throws_like($$select api.tracking_day('20000000-0000-0000-0000-000000000004', core.business_date())$$,
  'PERMISSION_DENIED%', 'another rep cannot open the rep''s day');
select throws_like($$select * from api.tracking_team_day()$$, 'PERMISSION_DENIED: field.tracking.read', 'reps have no team view');
select lives_ok($$select api.tracking_day('20000000-0000-0000-0000-000000000005', core.business_date())$$, 'a rep opens their own day');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is((select (api.tracking_day('20000000-0000-0000-0000-000000000004',
            (select business_date from field.work_shifts where client_ref = 'e1000000-0000-0000-0000-000000000001')) ->> 'ping_count')::int), 6,
  'the rep reads their own points');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a3');
select is((select count(*)::int from field.location_pings where employee_id = '20000000-0000-0000-0000-000000000004'), 6,
  'the area manager reads the team''s points');
select lives_ok($$select api.tracking_day('20000000-0000-0000-0000-000000000004', core.business_date())$$, 'the area manager opens a team member''s day');
select throws_like($$select api.tracking_day('20000000-0000-0000-0000-000000000005', core.business_date())$$,
  'PERMISSION_DENIED%', 'the area manager cannot open another team''s rep');
select ok((select bool_or(employee_id = '20000000-0000-0000-0000-000000000004') and not bool_or(employee_id = '20000000-0000-0000-0000-000000000005')
           from api.tracking_team_day((select business_date from field.work_shifts where client_ref = 'e1000000-0000-0000-0000-000000000001'))),
  'the area manager''s team view lists the team, not other teams');
select is((select count(*)::int from api.tracking_team_day() where employee_id = '20000000-0000-0000-0000-000000000003'), 0,
  'a manager without a shift is not listed in their own team view');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a2');
select is((select count(*)::int from api.tracking_team_day()
           where employee_id in ('20000000-0000-0000-0000-000000000004','20000000-0000-0000-0000-000000000005')), 2,
  'the sales director''s team view lists both reps');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select throws_like($$select * from api.tracking_team_day()$$, 'PERMISSION_DENIED%', 'finance has no tracking access');
select is((select count(*)::int from field.location_pings), 0, 'finance reads no points');
select throws_like($$select api.start_shift('e1000000-0000-0000-0000-000000000004', null, null, null, now())$$,
  'PERMISSION_DENIED: field.shift.start', 'only field staff start shifts');

-- ===========================================================================
-- Synthetic track: Rep Delta (E005), Thursday 2026-10-01, 09:00–13:00 Cairo
--   09:00–09:40  9 points at the customer C-0002 location        → stop, near a customer
--   09:45, 09:50 moving                                              (no stop)
--   09:55–10:35  9 points at C, far from customers, no visit       → flagged idle stop, 40 min
--   10:15        one low-accuracy point far away                    (ignored for stops/distance)
--   10:35–11:05  no point                                           → gap, 30 min
--   11:05–11:40  8 points at D, visit 11:10–11:35                   → stop inside a visit
--   11:40–13:00  no point                                           → trailing gap, 80 min
-- ===========================================================================
select tests.clear_authentication();
select is((select count(*)::int from integration.outbox where event_type in ('tracking.shift_started','tracking.shift_ended')
           and payload::text !~ 'lat'), 2, 'shift start and end are emitted without coordinates');
select is((select count(*)::int from audit.security_events where event_type = 'tracking_notice_acknowledged'), 1,
  'the acknowledgement is logged once as a security event');
insert into field.work_shifts (id, employee_id, client_ref, status, notice_version, business_date, started_at, start_captured_at,
                               window_start, ended_at, end_captured_at, window_end) values
  ('e3000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000005', 'e3000000-0000-0000-0000-0000000000c1', 'closed',
   '2026-10-30.1', '2026-10-01', '2026-10-01 09:00 Africa/Cairo', '2026-10-01 09:00 Africa/Cairo', '2026-10-01 09:00 Africa/Cairo',
   '2026-10-01 13:00 Africa/Cairo', '2026-10-01 13:00 Africa/Cairo', '2026-10-01 13:00 Africa/Cairo');
insert into field.location_pings (id, shift_id, employee_id, latitude, longitude, accuracy_m, captured_at, anomaly_flags)
select gen_random_uuid(), 'e3000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000005', t.lat, t.lng, t.acc,
       ('2026-10-01 ' || t.hm)::timestamp at time zone 'Africa/Cairo', t.flags
from (
  select (time '09:00' + g * interval '5 minutes')::text as hm, 31.040900 as lat, 31.378500 as lng, 10 as acc, '{}'::text[] as flags
    from generate_series(0, 8) g
  union all values ('09:45', 31.050000, 31.380000, 10, '{}'::text[]), ('09:50', 31.070000, 31.390000, 10, '{}'::text[])
  union all select (time '09:55' + g * interval '5 minutes')::text, 31.100000, 31.400000, 10, '{}'::text[]
    from generate_series(0, 8) g
  union all values ('10:15', 31.200000, 31.500000, 500, '{low_accuracy}'::text[])
  union all select (time '11:05' + g * interval '5 minutes')::text, 31.100000, 31.420000, 10, '{}'::text[]
    from generate_series(0, 7) g
) t;
insert into field.visits (id, customer_id, employee_id, status, check_in_at, check_out_at, outcome) values
  ('e4000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000005', 'completed',
   '2026-10-01 11:10 Africa/Cairo', '2026-10-01 11:35 Africa/Cairo', 'demo');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');
select set_config('t.day', api.tracking_day('20000000-0000-0000-0000-000000000005', '2026-10-01')::text, true) is not null;
select is((current_setting('t.day')::jsonb ->> 'shift_seconds')::int, 14400, 'shift time: 4 hours');
select is((current_setting('t.day')::jsonb ->> 'ping_count')::int, 29, 'every point of the day is listed');
select is(jsonb_array_length(current_setting('t.day')::jsonb -> 'points'), 29, 'the point list carries every point');
select is(jsonb_array_length(current_setting('t.day')::jsonb -> 'stops'), 3, 'three stops of 30 minutes or more are detected');
select is((select string_agg(s ->> 'seconds', ',' order by s ->> 'start_at') from jsonb_array_elements(current_setting('t.day')::jsonb -> 'stops') s),
  '2400,2400,2100', 'stop durations: 40, 40 and 35 minutes');
select is((select string_agg(concat_ws('/', s ->> 'near_customer', s ->> 'in_visit', s ->> 'flagged'), ',' order by s ->> 'start_at')
           from jsonb_array_elements(current_setting('t.day')::jsonb -> 'stops') s),
  'true/false/false,false/false/true,false/true/false', 'only the stop away from customers and visits is flagged');
select ok((current_setting('t.day')::jsonb ->> 'idle_stop_count')::int = 1 and (current_setting('t.day')::jsonb ->> 'idle_stop_seconds')::int = 2400,
  'idle-stop time: one flagged stop of 40 minutes');
select is((select string_agg(g ->> 'seconds', ',' order by g ->> 'start_at') from jsonb_array_elements(current_setting('t.day')::jsonb -> 'gaps') g),
  '1800,4800', 'gaps of 20 minutes or more: 30 minutes mid-shift and 80 minutes to the end');
select is((current_setting('t.day')::jsonb ->> 'gap_seconds')::int, 6600, 'gap time is summed');
select is((current_setting('t.day')::jsonb ->> 'distance_m')::numeric,
  core.distance_m(31.040900, 31.378500, 31.050000, 31.380000) + core.distance_m(31.050000, 31.380000, 31.070000, 31.390000)
  + core.distance_m(31.070000, 31.390000, 31.100000, 31.400000) + core.distance_m(31.100000, 31.400000, 31.100000, 31.420000),
  'distance is the haversine sum, ignoring the low-accuracy point');
select ok((current_setting('t.day')::jsonb ->> 'visit_count')::int = 1 and (current_setting('t.day')::jsonb ->> 'visit_seconds')::int = 1500
          and current_setting('t.day')::jsonb -> 'visits' -> 0 ->> 'customer_name' = 'Dr. Mona Clinic',
  'the visit and its 25 minutes come from check-in/out');
select ok((current_setting('t.day')::jsonb -> 'flags') @> '["gap","idle_stop"]', 'the day is flagged for review');
select is((select count(*)::int from jsonb_array_elements(current_setting('t.day')::jsonb -> 'points') p where p ->> 'usable' = 'false'), 1,
  'the low-accuracy point is marked unusable');
select ok((select idle_stop_seconds = 2400 and gap_seconds = 6600 and visit_count = 1 and flags @> '{idle_stop,gap}'
           from api.tracking_team_day('2026-10-01') where employee_id = '20000000-0000-0000-0000-000000000005'),
  'the team summary carries the same figures');

-- ===========================================================================
-- Cairo-day boundaries (never the UTC date)
-- ===========================================================================
select tests.clear_authentication();
insert into field.visits (id, customer_id, employee_id, status, check_in_at, check_out_at, outcome) values
  ('e4000000-0000-0000-0000-000000000002', '40000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000005', 'completed',
   '2026-10-05 23:50 Africa/Cairo', '2026-10-05 23:58 Africa/Cairo', 'demo'),
  ('e4000000-0000-0000-0000-000000000003', '40000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000005', 'completed',
   '2026-10-06 00:10 Africa/Cairo', '2026-10-06 00:20 Africa/Cairo', 'demo');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a5');
select is((api.tracking_day('20000000-0000-0000-0000-000000000005', '2026-10-05') -> 'visits' -> 0 ->> 'id'),
  'e4000000-0000-0000-0000-000000000002', '23:50 Cairo belongs to that Cairo day');
select is((api.tracking_day('20000000-0000-0000-0000-000000000005', '2026-10-06') -> 'visits' -> 0 ->> 'id'),
  'e4000000-0000-0000-0000-000000000003', '00:10 Cairo (21:10 UTC the day before) belongs to the next Cairo day');
select ok(((api.my_tracking_status() ->> 'business_date')::date = core.business_date()), 'status reports the Cairo business date');

-- ===========================================================================
-- Auto-close
-- ===========================================================================
select tests.clear_authentication();
insert into field.tracking_notice_acks (employee_id, user_id, notice_version)
  values ('20000000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-0000000000a5', '2026-10-30.1');
insert into field.work_shifts (id, employee_id, client_ref, notice_version, business_date, start_captured_at, window_start) values
  ('e3000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000005', 'e3000000-0000-0000-0000-0000000000c2',
   '2026-10-30.1', ((now() - interval '12 hours') at time zone 'Africa/Cairo')::date, now() - interval '12 hours', now() - interval '12 hours'),
  ('e3000000-0000-0000-0000-000000000003', '20000000-0000-0000-0000-000000000009', 'e3000000-0000-0000-0000-0000000000c3',
   '2026-10-30.1', ((now() - interval '11 hours') at time zone 'Africa/Cairo')::date, now() - interval '11 hours', now() - interval '11 hours'),
  ('e3000000-0000-0000-0000-000000000004', '20000000-0000-0000-0000-000000000004', 'e3000000-0000-0000-0000-0000000000c4',
   '2026-10-30.1', ((now() - interval '2 hours') at time zone 'Africa/Cairo')::date, now() - interval '2 hours', now() - interval '2 hours');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a5');
select is((api.my_tracking_status() -> 'open_shift' ->> 'overdue'), 'true', 'status marks a shift past the cap as overdue');
select is((api.record_location_pings(jsonb_build_array(
  jsonb_build_object('id','e2000000-0000-0000-0000-000000000020','lat',31.04,'lng',31.37,'accuracy_m',10,'captured_at',now()))))
  -> 'rejected' -> 0 ->> 'reason', 'outside_shift', 'a point after the cap is refused (the stale shift is closed first)');
select is((select status from field.work_shifts where id = 'e3000000-0000-0000-0000-000000000002'), 'auto_closed',
  'the rep''s own stale shift is closed automatically before new points or a new shift');
select is(api.start_shift('e1000000-0000-0000-0000-000000000005', 31.04, 31.37, 10, now()) ->> 'status', 'open',
  'a new day can start once the stale shift is closed');
select tests.clear_authentication();
select is(service.tracking_auto_close(), 1, 'the service job closes the other stale shift only');
select ok((select status = 'auto_closed' and window_end = window_start + interval '10 hours'
           from field.work_shifts where id = 'e3000000-0000-0000-0000-000000000003'), 'its time is capped at the 10-hour maximum');
select is((select status from field.work_shifts where id = 'e3000000-0000-0000-0000-000000000004'), 'open', 'a shift under the cap stays open');
select is((select count(*)::int from integration.outbox where event_type = 'tracking.shift_auto_closed'), 2, 'auto-closes are emitted');
select is((select count(*)::int from notify.notifications where type = 'tracking.shift_auto_closed'
           and recipient_user_id = '00000000-0000-0000-0000-0000000000a5'), 1, 'the rep is told the day was closed');

-- ===========================================================================
-- Retention purge (daily summaries are kept)
-- ===========================================================================
insert into field.work_shifts (id, employee_id, client_ref, status, notice_version, business_date, started_at, start_captured_at,
                               start_latitude, start_longitude, window_start, ended_at, window_end) values
  ('e3000000-0000-0000-0000-000000000005', '20000000-0000-0000-0000-000000000005', 'e3000000-0000-0000-0000-0000000000c5', 'closed',
   '2026-10-30.1', ((now() - interval '100 days') at time zone 'Africa/Cairo')::date, now() - interval '100 days', now() - interval '100 days',
   31.04, 31.37, now() - interval '100 days', now() - interval '100 days' + interval '1 hour', now() - interval '100 days' + interval '1 hour');
insert into field.location_pings (id, shift_id, employee_id, latitude, longitude, accuracy_m, captured_at, received_at) values
  ('e2000000-0000-0000-0000-000000000030', 'e3000000-0000-0000-0000-000000000005', '20000000-0000-0000-0000-000000000005',
   31.04, 31.37, 10, now() - interval '100 days', now() - interval '100 days'),
  ('e2000000-0000-0000-0000-000000000031', 'e3000000-0000-0000-0000-000000000005', '20000000-0000-0000-0000-000000000005',
   31.05, 31.37, 10, now() - interval '100 days' + interval '5 minutes', now() - interval '100 days');
-- Audit 3 (M5): retention counts from the capture time; the synthetic 2026-10-01 track above
-- also expires once that date is more than 90 days ago, so the expected count is taken first.
select set_config('t.expired', (select count(*) from field.location_pings
                                where least(captured_at, received_at) < now() - interval '90 days')::text, true) is not null;
select is((service.tracking_purge() ->> 'deleted')::int, current_setting('t.expired')::int,
  'points captured more than 90 days ago are deleted, newer ones are kept');
select is((select count(*)::int from field.location_pings where id in ('e2000000-0000-0000-0000-000000000030','e2000000-0000-0000-0000-000000000031')),
  0, 'the old points are gone');
select ok((select ping_count = 2 and shift_seconds = 3600 and distance_m > 1000 from field.tracking_day_summaries
           where employee_id = '20000000-0000-0000-0000-000000000005'
             and business_date = ((now() - interval '100 days') at time zone 'Africa/Cairo')::date),
  'the day''s summary is kept before its points are deleted');
select ok((select start_latitude is null and start_longitude is null from field.work_shifts where id = 'e3000000-0000-0000-0000-000000000005'),
  'start/end coordinates of old shifts are cleared too');
select is((select (details ->> 'deleted')::int from audit.security_events where event_type = 'retention_purge'
           and details ->> 'table' = 'field.location_pings'), current_setting('t.expired')::int, 'the purge is logged as a security event');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');
select ok((select from_summary and ping_count = 2 from api.tracking_team_day(((now() - interval '100 days') at time zone 'Africa/Cairo')::date)
           where employee_id = '20000000-0000-0000-0000-000000000005'), 'the team view falls back to the kept summary');
select is((select count(*)::int from api.v_tracking_day_summaries where employee_id = '20000000-0000-0000-0000-000000000005'), 1,
  'kept summaries are readable through the view');
select tests.clear_authentication();
update core.system_settings set value = '10' where key = 'tracking.retention_days';
select throws_like($$select service.tracking_purge()$$, 'VALIDATION%at least 30%', 'a dangerously short retention is refused');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select throws_like($$select service.tracking_purge()$$, '%permission denied%', 'a rep cannot run the purge');

select * from finish();
rollback;
