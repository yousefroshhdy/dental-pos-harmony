-- Phase P step 5 (migration 20261125000500_tracking_device_status.sql): the tracking health panel.
--   · api.report_device_status(shift, payload): the device's own report (collector, location
--     permission, app version, web build, battery saver, points waiting on the phone). Bound to
--     the caller's own OPEN shift, whitelisted keys with typed values, at most 1 KB, and at most
--     one report a minute per shift (a faster one answers rate_limited and stores nothing).
--   · api.v_tracking_health (security_invoker): one row per trackable rep in the caller's D-14
--     scope: latest shift (open / closed, since when), last point (time, arrival, source), the
--     last device report and needs_attention (open shift, nothing arrived for over 15 minutes).
--     No coordinates. A rep sees their own row, a manager their team, anyone else nothing.
begin;
select tests.load_fixture();
set constraints all immediate;
select plan(48);

-- Fixture: E004 rep Cairo (user a4, manager E003 = area manager a3, whose manager is E002 =
-- sales director a2); E005 rep Delta (user a5, manager E002); a6 finance; a1 owner.

-- ===========================================================================
-- Privileges and shape
-- ===========================================================================
select ok(not has_function_privilege('anon', 'api.report_device_status(uuid, jsonb)', 'execute')
          and has_function_privilege('authenticated', 'api.report_device_status(uuid, jsonb)', 'execute'),
  'the command is callable by signed-in users only');
select ok((select c.relrowsecurity from pg_class c where c.oid = 'field.device_status'::regclass),
  'field.device_status has row level security');
select ok(not has_table_privilege('authenticated', 'field.device_status', 'insert')
          and not has_table_privilege('authenticated', 'field.device_status', 'update')
          and not has_table_privilege('authenticated', 'field.device_status', 'delete'),
  'clients cannot write device reports directly (only through the command)');
select ok((select 'security_invoker=true' = any(c.reloptions) from pg_class c where c.oid = 'api.v_tracking_health'::regclass),
  'the health view is security_invoker (RLS of the caller applies)');
select ok(has_table_privilege('authenticated', 'api.v_tracking_health', 'select')
          and not has_table_privilege('anon', 'api.v_tracking_health', 'select'),
  'the health view is readable by signed-in users only');
select is((select count(*)::int from information_schema.columns
           where table_schema = 'api' and table_name = 'v_tracking_health'
             and column_name ~ '(lat|lng|longitude|accuracy)'), 0,
  'the health view carries no coordinates (D-14: positions only on the day page and the team map)');
select ok(not has_function_privilege('authenticated', 'api.post_inventory_adjustment(uuid, uuid, uuid, int, text, text)', 'execute'),
  'this migration does not re-open functions closed earlier');

-- ===========================================================================
-- Setup: Rep Cairo opens a shift 1 hour ago (no point yet); Rep Delta 5 minutes ago
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is(api.acknowledge_tracking_notice('2026-10-30.1') ->> 'version', '2026-10-30.1', 'setup: Rep Cairo acknowledges the notice');
select is(set_config('t.s4', api.start_shift('f9000000-0000-0000-0000-000000000004', 30.0444, 31.2357, 10,
            now() - interval '1 hour') ->> 'shift_id', true) is not null, true, 'setup: Rep Cairo starts a shift 1 hour ago');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a5');
select is(api.acknowledge_tracking_notice('2026-10-30.1') ->> 'version', '2026-10-30.1', 'setup: Rep Delta acknowledges the notice');
select is(set_config('t.s5', api.start_shift('f9000000-0000-0000-0000-000000000005', 31.0409, 31.3785, 10,
            now() - interval '5 minutes') ->> 'shift_id', true) is not null, true, 'setup: Rep Delta starts a shift 5 minutes ago');

-- ===========================================================================
-- api.report_device_status: own open shift, whitelist, size, rate limit
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is(api.report_device_status(current_setting('t.s4')::uuid, jsonb_build_object(
            'source','native','permission','granted','app_version','1.0','web_build','abc123def456',
            'battery_saver',false,'pending_points',3)) ->> 'status', 'recorded',
  'the rep reports the device status of their own open shift');
select ok((select d.employee_id = '20000000-0000-0000-0000-000000000004' and d.source = 'native' and d.permission = 'granted'
                  and d.app_version = '1.0' and d.web_build = 'abc123def456' and d.battery_saver = false
                  and d.pending_points = 3 and d.report_count = 1 and d.reported_at = now()
           from field.device_status d where d.shift_id = current_setting('t.s4')::uuid),
  'it is stored once per shift, for the caller, with the server time');
select ok((select r ->> 'status' = 'rate_limited' and (r ->> 'retry_after_s')::int between 1 and 60
           from (select api.report_device_status(current_setting('t.s4')::uuid,
                   jsonb_build_object('source','native','permission','denied')) as r) x),
  'a second report within a minute answers rate_limited (not an error) with the wait');
select ok((select d.permission = 'granted' and d.report_count = 1 from field.device_status d where d.shift_id = current_setting('t.s4')::uuid),
  'and stores nothing');

-- The minute has passed (moved back as the table owner).
select tests.clear_authentication();
update field.device_status set reported_at = now() - interval '61 seconds' where shift_id = current_setting('t.s4')::uuid;
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is(api.report_device_status(current_setting('t.s4')::uuid,
            jsonb_build_object('source','native','permission','denied')) ->> 'status', 'recorded',
  'after a minute the next report is recorded');
select ok((select d.permission = 'denied' and d.app_version is null and d.battery_saver is null and d.pending_points is null
                  and d.report_count = 2
           from field.device_status d where d.shift_id = current_setting('t.s4')::uuid),
  'a report is a snapshot: it replaces the last one (keys not sent are cleared), and the count goes up');

select throws_like($$select api.report_device_status(current_setting('t.s5')::uuid, '{"permission":"granted"}'::jsonb)$$,
  'NO_OPEN_SHIFT%', 'a rep cannot report on another rep''s shift');
select throws_like($$select api.report_device_status('f9000000-0000-0000-0000-0000000000ff', '{"permission":"granted"}'::jsonb)$$,
  'NO_OPEN_SHIFT%', 'an unknown shift id is refused the same way');
select throws_like($$select api.report_device_status(null, '{"permission":"granted"}'::jsonb)$$,
  'VALIDATION%', 'the shift id is required');
select throws_like($$select api.report_device_status(current_setting('t.s4')::uuid, '{"permission":"granted","lat":30.1}'::jsonb)$$,
  'VALIDATION: unknown key%', 'a key outside the whitelist is refused (no coordinates, no free-form data)');
select throws_like($$select api.report_device_status(current_setting('t.s4')::uuid, '{"employee_id":"20000000-0000-0000-0000-000000000005"}'::jsonb)$$,
  'VALIDATION: unknown key%', 'a claimed employee is refused too');
select throws_like($$select api.report_device_status(current_setting('t.s4')::uuid, '["granted"]'::jsonb)$$,
  'VALIDATION%', 'the payload must be a JSON object');
select throws_like($$select api.report_device_status(current_setting('t.s4')::uuid, null)$$,
  'VALIDATION%', 'the payload is required');
select throws_like($$select api.report_device_status(current_setting('t.s4')::uuid, '{"permission":"maybe"}'::jsonb)$$,
  'VALIDATION: permission%', 'permission takes only the known states');
select throws_like($$select api.report_device_status(current_setting('t.s4')::uuid, '{"source":"gps"}'::jsonb)$$,
  'VALIDATION: source%', 'source is pwa or native');
select throws_like($$select api.report_device_status(current_setting('t.s4')::uuid, '{"app_version":"1.0<script>"}'::jsonb)$$,
  'VALIDATION: app_version%', 'app_version is a short version string');
select throws_like($$select api.report_device_status(current_setting('t.s4')::uuid, '{"battery_saver":"yes"}'::jsonb)$$,
  'VALIDATION: battery_saver%', 'battery_saver is true, false or null');
select throws_like($$select api.report_device_status(current_setting('t.s4')::uuid, '{"pending_points":-1}'::jsonb)$$,
  'VALIDATION: pending_points%', 'pending_points is a whole number from 0');
select throws_like(format($$select api.report_device_status(current_setting('t.s4')::uuid, '{"web_build":"%s"}'::jsonb)$$, repeat('a', 1100)),
  'VALIDATION: payload too large%', 'the payload is kept small (at most 1 KB)');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a3');
select throws_like($$select api.report_device_status(current_setting('t.s4')::uuid, '{"permission":"granted"}'::jsonb)$$,
  'NO_OPEN_SHIFT%', 'the rep''s manager cannot report on the rep''s shift either');
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select throws_like($$select api.report_device_status(current_setting('t.s4')::uuid, '{"permission":"granted"}'::jsonb)$$,
  'PERMISSION_DENIED%', 'without field.shift.start the command is refused');

-- ===========================================================================
-- api.v_tracking_health: scope (D-14) and the attention flag
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is((select string_agg(employee_no, ',' order by employee_no) from api.v_tracking_health), 'E004',
  'a rep sees only their own row');
select ok((select h.shift_open and h.shift_status = 'open' and h.shift_since = now() - interval '1 hour'
                  and h.last_point_at is null and h.needs_attention
                  and h.device_permission = 'denied' and h.device_source = 'native' and h.device_reported_at = now()
           from api.v_tracking_health h where h.employee_no = 'E004'),
  'open for an hour with no point: since the start, no last point, the device report, and needs attention');

select is((api.record_location_pings(jsonb_build_array(jsonb_build_object(
    'id','f9100000-0000-0000-0000-000000000001','lat',30.0450,'lng',31.2360,'accuracy_m',8,
    'captured_at',now() - interval '2 minutes','source','native'))) ->> 'accepted')::int, 1,
  'a point arrives');
select ok((select h.last_point_at = now() - interval '2 minutes' and h.last_point_received_at = now()
                  and h.last_point_source = 'native' and h.shift_last_received_at = now() and not h.needs_attention
           from api.v_tracking_health h where h.employee_no = 'E004'),
  'the last point (time, arrival, source) shows, and the attention flag clears');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a5');
select ok((select string_agg(employee_no, ',' order by employee_no) = 'E005' from api.v_tracking_health),
  'another rep (outside the scope) does not see Rep Cairo');
select ok((select h.shift_open and not h.needs_attention and h.device_reported_at is null
           from api.v_tracking_health h where h.employee_no = 'E005'),
  'a shift open for 5 minutes without a point does not need attention yet; no device report shows as none');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a3');
select ok((select bool_or(employee_no = 'E004') and not bool_or(employee_no = 'E005') from api.v_tracking_health),
  'the area manager sees their team (Rep Cairo), not Rep Delta');
select is((select count(*)::int from field.device_status), 1,
  'the area manager reads the device report of their team only (RLS on the table too)');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a2');
select ok((select bool_or(employee_no = 'E004') and bool_or(employee_no = 'E005') from api.v_tracking_health),
  'the sales director sees both reps (whole team)');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a6');
select is((select count(*)::int from api.v_tracking_health), 0, 'finance (no tracking scope, never tracked) sees nothing');
select is((select count(*)::int from field.device_status), 0, 'nor any device report');

select tests.authenticate_as('00000000-0000-0000-0000-0000000000a1');
select ok((select bool_or(employee_no = 'E004') and bool_or(employee_no = 'E005') and not bool_or(employee_no = 'E006')
           from api.v_tracking_health),
  'the owner sees every trackable rep (not employees who cannot be tracked)');

-- ===========================================================================
-- End of the day
-- ===========================================================================
select tests.authenticate_as('00000000-0000-0000-0000-0000000000a4');
select is(api.end_shift('f9000000-0000-0000-0000-0000000000e4', 30.0450, 31.2360, 10, now()) ->> 'status', 'closed',
  'Rep Cairo ends the day');
select throws_like($$select api.report_device_status(current_setting('t.s4')::uuid, '{"permission":"granted"}'::jsonb)$$,
  'NO_OPEN_SHIFT%', 'a closed shift takes no more device reports');
select ok((select not h.shift_open and h.shift_status = 'closed' and h.shift_since = now() and not h.needs_attention
                  and h.device_permission = 'denied'
           from api.v_tracking_health h where h.employee_no = 'E004'),
  'closed: since the end, never needs attention, the last report of the day stays visible');
select ok((select h.shift_id = current_setting('t.s4')::uuid from api.v_tracking_health h where h.employee_no = 'E004'),
  'the row follows the latest shift');

select tests.clear_authentication();
select * from finish();
rollback;
