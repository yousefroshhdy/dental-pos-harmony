-- Honest OS migration: third-audit fixes for work-hours tracking (D-14).
--
--   M3  A point flood made a rep's day impossible to review (quadratic day build, no cap).
--       · tracking.max_points_per_shift caps the points stored per shift (default 240 =
--         ceil(10 h × 3600 / (300 s / 2))); more are answered `rejected: shift_cap`.
--       · A point closer than sample_interval_s / 2 to a stored point of the same shift is
--         answered `rejected: too_frequent` (not an error).
--       · field.tracking_compute_day is set-based (jsonb_agg over queries, window functions);
--         the only loop left (stop clustering) keeps scalar state and appends to an array.
--         No `v_x := v_x || …` remains in a loop (record_location_pings' rejected list too).
--       · api.tracking_day lists at most tracking.max_day_points points (default 1000) and says
--         so with `points_truncated`; ping_count is still the full count.
--   M4  Overlapping back-dated shifts double-counted shift time.
--       · api.start_shift clamps window_start to the employee's latest window_end (flag
--         overlap_clamped).
--       · The day merges overlapping shift windows (field.tracking_day_windows) for shift time,
--         gaps, distance and stops, and carries every shift's anomaly_flags into the day flags.
--   M5  Points were accepted into any old shift window; retention was keyed on received_at.
--       · Points go only into an open shift, or one whose window ended less than
--         tracking.late_point_grace_hours (default 24) ago; else `rejected: too_late`.
--       · service.tracking_purge deletes on least(captured_at, received_at).
--   M7  After the purge, the day page showed the whole shift as a gap.
--       · api.tracking_day returns the stored summary figures when one exists, with
--         summary_only = true and no live stops, gaps or points; api.tracking_team_day uses the
--         same rule.
--   L2  A forged source = 'native' was accepted. Only 'pwa' is accepted (VALIDATION otherwise)
--       until the Phase 2 native collector has an attested channel.
--
-- Non-destructive: create or replace of existing functions (same signatures), one new internal
-- helper, one new index, three new settings.

-- ---------------------------------------------------------------------------
-- 1. Settings (the owner may change any of them)
-- ---------------------------------------------------------------------------
insert into core.system_settings (key, value, description) values
  ('tracking.max_points_per_shift', '240',
   'Work-hours tracking: most points stored for one shift (default ceil(max_shift_hours × 3600 / (sample_interval_s / 2)))'),
  ('tracking.late_point_grace_hours', '24',
   'Work-hours tracking: points are accepted into a closed shift only this many hours after its window ended'),
  ('tracking.max_day_points', '1000',
   'Work-hours tracking: most points listed on one day page (the totals still count every point)')
on conflict (key) do nothing;

-- Retention is keyed on the capture time now (M5).
create index if not exists idx_location_pings_captured on field.location_pings (captured_at);

-- ---------------------------------------------------------------------------
-- 2. Merged shift windows of one employee's Cairo day (M4)
-- ---------------------------------------------------------------------------
-- Shifts whose window starts that day (business_date), merged where they overlap or touch, so
-- time is never counted twice. An open shift ends at now (capped at tracking.max_shift_hours).
create or replace function field.tracking_day_windows(p_employee_id uuid, p_day date)
returns table (seg int, seg_start timestamptz, seg_end timestamptz, shift_ids uuid[], has_open boolean)
language sql stable set search_path = '' as $$
  with w as (
    select ws.id, ws.window_start as s,
           coalesce(ws.window_end,
                    least(now(), ws.window_start + field.tracking_num('tracking.max_shift_hours', 10) * interval '1 hour')) as e,
           ws.status = 'open' as is_open
    from field.work_shifts ws
    where ws.employee_id = p_employee_id and ws.business_date = p_day
  ), b as (
    select w.*,
           case when w.s <= max(w.e) over (order by w.s, w.id rows between unbounded preceding and 1 preceding)
                then 0 else 1 end as brk
    from w
  ), g as (
    select b.*, sum(b.brk) over (order by b.s, b.id) as grp from b
  )
  select g.grp::int, min(g.s), max(g.e), array_agg(g.id order by g.s, g.id), bool_or(g.is_open)
  from g group by g.grp order by g.grp
$$;

-- ---------------------------------------------------------------------------
-- 3. The derived day, set-based (M3 c, M4)
-- ---------------------------------------------------------------------------
-- Same definitions as 20261031000300_tracking.sql, computed over the merged windows:
--   stop     consecutive usable points within tracking.stop_radius_m of the running centroid,
--            lasting ≥ tracking.stop_min_minutes; flagged when it overlaps no visit and is not
--            within the radius of a customer location
--   gap      ≥ tracking.gap_min_minutes without any point inside a window
--            (from the start, between points, and up to the end / now)
--   distance haversine sum over usable points, per window
-- Usable = not low_accuracy, impossible_travel or duplicate_fix. Day flags = every shift's
-- anomaly_flags + auto_closed / overdue_shift + anomaly / idle_stop / gap.
-- Cost: one indexed pass per figure (n log n at worst); the point list is capped at
-- tracking.max_day_points (points_truncated says when).
create or replace function field.tracking_compute_day(p_employee_id uuid, p_day date,
                                                      p_detail boolean default true, p_visit_names boolean default false)
returns jsonb language plpgsql stable set search_path = '' as $$
declare
  v_day_start timestamptz := (p_day::timestamp at time zone 'Africa/Cairo');
  v_day_end   timestamptz := ((p_day + 1)::timestamp at time zone 'Africa/Cairo');
  v_now       timestamptz := now();
  v_max       interval := field.tracking_num('tracking.max_shift_hours', 10) * interval '1 hour';
  v_radius    numeric  := field.tracking_num('tracking.stop_radius_m', 150);
  v_stop_min  interval := field.tracking_num('tracking.stop_min_minutes', 30) * interval '1 minute';
  v_gap_min   interval := field.tracking_num('tracking.gap_min_minutes', 20) * interval '1 minute';
  v_pt_limit  int := greatest(field.tracking_num('tracking.max_day_points', 1000), 0)::int;
  v_unusable  text[] := array['low_accuracy','impossible_travel','duplicate_fix'];
  v_shift_ids uuid[]; v_shift_n int; v_on_shift boolean; v_flags text[];
  v_shift_secs int; v_first_start timestamptz; v_last_end timestamptz;
  v_ping_n int; v_last_ping timestamptz; v_anomaly boolean; v_dist numeric;
  v_gap_n int; v_gap_secs int; v_gaps jsonb;
  v_visit_n int; v_visit_secs int; v_visits jsonb; v_shifts jsonb; v_points jsonb; v_listed int;
  v_stops jsonb[] := '{}'; v_stop jsonb; v_idle_n int := 0; v_idle_secs int := 0;
  p record; c_seg int; c_shift uuid; c_n int := 0; c_lat numeric; c_lng numeric; c_start timestamptz; c_end timestamptz;
begin
  -- Shifts of the day, their state and their flags.
  select coalesce(array_agg(ws.id order by ws.window_start, ws.id), '{}'), count(*)::int,
         coalesce(bool_or(ws.status = 'open' and v_now < ws.window_start + v_max), false)
    into v_shift_ids, v_shift_n, v_on_shift
  from field.work_shifts ws where ws.employee_id = p_employee_id and ws.business_date = p_day;

  select coalesce(array_agg(distinct f), '{}') into v_flags
  from field.work_shifts ws
  cross join lateral unnest(ws.anomaly_flags
                            || case when ws.status = 'auto_closed' then array['auto_closed'] else '{}'::text[] end
                            || case when ws.status = 'open' and v_now >= ws.window_start + v_max
                                    then array['overdue_shift'] else '{}'::text[] end) as f
  where ws.employee_id = p_employee_id and ws.business_date = p_day;

  -- Shift time over the merged windows (never counted twice).
  select coalesce(sum(floor(extract(epoch from (w.seg_end - w.seg_start)))), 0)::int, min(w.seg_start), max(w.seg_end)
    into v_shift_secs, v_first_start, v_last_end
  from field.tracking_day_windows(p_employee_id, p_day) w;

  -- Point totals.
  select count(*)::int, max(lp.captured_at),
         coalesce(bool_or(lp.anomaly_flags && array['impossible_travel','duplicate_fix','clock_skew']), false)
    into v_ping_n, v_last_ping, v_anomaly
  from field.location_pings lp where lp.shift_id = any(v_shift_ids);

  -- Distance: haversine between consecutive usable points of each window.
  select coalesce(sum(x.d), 0) into v_dist
  from (select core.distance_m(lag(lp.latitude) over w, lag(lp.longitude) over w, lp.latitude, lp.longitude) as d
        from field.tracking_day_windows(p_employee_id, p_day) s
        cross join lateral unnest(s.shift_ids) as u(sid)
        join field.location_pings lp on lp.shift_id = u.sid
        where not (lp.anomaly_flags && v_unusable)
        window w as (partition by s.seg order by lp.captured_at, lp.id)) x;

  -- Gaps: from each window start, between points, and up to each window end.
  with seg as (
    select * from field.tracking_day_windows(p_employee_id, p_day)
  ), pt as (
    select s.seg, lp.shift_id, lp.captured_at,
           greatest(s.seg_start, lag(lp.captured_at) over (partition by s.seg order by lp.captured_at, lp.id)) as prev_any
    from seg s cross join lateral unnest(s.shift_ids) as u(sid)
    join field.location_pings lp on lp.shift_id = u.sid
  ), last_pt as (
    select pt.seg, max(pt.captured_at) as last_at from pt group by pt.seg
  ), g as (
    select pt.prev_any as start_at, pt.captured_at as end_at, false as ongoing, pt.shift_id
    from pt where pt.captured_at - pt.prev_any >= v_gap_min
    union all
    select greatest(s.seg_start, l.last_at), s.seg_end,
           s.has_open and s.seg_end >= v_now - interval '1 second', s.shift_ids[cardinality(s.shift_ids)]
    from seg s left join last_pt l on l.seg = s.seg
    where s.seg_end - greatest(s.seg_start, l.last_at) >= v_gap_min
  )
  select count(*)::int, coalesce(sum(floor(extract(epoch from (g.end_at - g.start_at)))), 0)::int,
         coalesce(jsonb_agg(jsonb_build_object('start_at', g.start_at, 'end_at', g.end_at,
                                               'seconds', floor(extract(epoch from (g.end_at - g.start_at)))::int,
                                               'ongoing', g.ongoing, 'shift_id', g.shift_id) order by g.start_at), '[]')
    into v_gap_n, v_gap_secs, v_gaps
  from g;

  -- Stops: running-centroid clustering of the usable points, in time order, per window.
  -- One pass with scalar state; a stop is appended to an array (no jsonb concatenation).
  for p in
    select s.seg, lp.shift_id, lp.latitude, lp.longitude, lp.captured_at
    from field.tracking_day_windows(p_employee_id, p_day) s
    cross join lateral unnest(s.shift_ids) as u(sid)
    join field.location_pings lp on lp.shift_id = u.sid
    where not (lp.anomaly_flags && v_unusable)
    order by s.seg, lp.captured_at, lp.id
  loop
    if c_n > 0 and p.seg = c_seg and core.distance_m(c_lat, c_lng, p.latitude, p.longitude) <= v_radius then
      c_lat := (c_lat * c_n + p.latitude) / (c_n + 1);
      c_lng := (c_lng * c_n + p.longitude) / (c_n + 1);
      c_n := c_n + 1; c_end := p.captured_at;
    else
      if c_n > 0 and c_end - c_start >= v_stop_min then
        v_stop := field.tracking_stop(p_employee_id, c_lat, c_lng, c_start, c_end, c_n, v_radius);
        if (v_stop ->> 'flagged')::boolean then
          v_idle_n := v_idle_n + 1; v_idle_secs := v_idle_secs + (v_stop ->> 'seconds')::int;
        end if;
        if p_detail then v_stops := array_append(v_stops, v_stop || jsonb_build_object('shift_id', c_shift)); end if;
      end if;
      c_n := 1; c_seg := p.seg; c_shift := p.shift_id;
      c_lat := p.latitude; c_lng := p.longitude; c_start := p.captured_at; c_end := p.captured_at;
    end if;
  end loop;
  if c_n > 0 and c_end - c_start >= v_stop_min then
    v_stop := field.tracking_stop(p_employee_id, c_lat, c_lng, c_start, c_end, c_n, v_radius);
    if (v_stop ->> 'flagged')::boolean then
      v_idle_n := v_idle_n + 1; v_idle_secs := v_idle_secs + (v_stop ->> 'seconds')::int;
    end if;
    if p_detail then v_stops := array_append(v_stops, v_stop || jsonb_build_object('shift_id', c_shift)); end if;
  end if;

  -- Visits of the day (field.visits check-in/out), whether or not a shift was open.
  select count(*)::int,
         coalesce(sum(greatest(floor(extract(epoch from (coalesce(fv.check_out_at, v_now) - fv.check_in_at)))::int, 0)), 0)::int,
         coalesce(jsonb_agg(jsonb_build_object(
           'id', fv.id, 'customer_id', fv.customer_id, 'customer_name', case when p_visit_names then c.display_name end,
           'status', fv.status, 'verification_status', fv.verification_status,
           'start_at', fv.check_in_at, 'end_at', fv.check_out_at,
           'seconds', greatest(floor(extract(epoch from (coalesce(fv.check_out_at, v_now) - fv.check_in_at)))::int, 0),
           'open', fv.check_out_at is null) order by fv.check_in_at, fv.id) filter (where p_detail), '[]')
    into v_visit_n, v_visit_secs, v_visits
  from field.visits fv left join crm.customers c on c.id = fv.customer_id
  where fv.employee_id = p_employee_id and fv.check_in_at >= v_day_start and fv.check_in_at < v_day_end;

  if v_anomaly then v_flags := v_flags || 'anomaly'::text; end if;
  if v_idle_n > 0 then v_flags := v_flags || 'idle_stop'::text; end if;
  if v_gap_n > 0 then v_flags := v_flags || 'gap'::text; end if;

  if p_detail then
    select coalesce(jsonb_agg(jsonb_build_object(
             'id', ws.id, 'status', ws.status, 'start_at', ws.window_start,
             'end_at', coalesce(ws.window_end, least(v_now, ws.window_start + v_max)),
             'open', ws.status = 'open',
             'seconds', floor(extract(epoch from (coalesce(ws.window_end, least(v_now, ws.window_start + v_max)) - ws.window_start)))::int,
             'started_at', ws.started_at, 'ended_at', ws.ended_at,
             'start_lat', ws.start_latitude, 'start_lng', ws.start_longitude, 'start_accuracy_m', ws.start_accuracy_m,
             'end_lat', ws.end_latitude, 'end_lng', ws.end_longitude, 'end_accuracy_m', ws.end_accuracy_m,
             'anomaly_flags', to_jsonb(ws.anomaly_flags)) order by ws.window_start, ws.id), '[]')
      into v_shifts
    from field.work_shifts ws where ws.employee_id = p_employee_id and ws.business_date = p_day;

    select count(*)::int,
           coalesce(jsonb_agg(jsonb_build_object(
             'id', x.id, 'shift_id', x.shift_id, 'captured_at', x.captured_at, 'received_at', x.received_at,
             'lat', x.latitude, 'lng', x.longitude, 'accuracy_m', x.accuracy_m, 'source', x.source,
             'anomaly_flags', to_jsonb(x.anomaly_flags), 'usable', not (x.anomaly_flags && v_unusable))
             order by x.captured_at, x.id), '[]')
      into v_listed, v_points
    from (select lp.* from field.location_pings lp where lp.shift_id = any(v_shift_ids)
          order by lp.captured_at, lp.id limit v_pt_limit) x;
  end if;

  return jsonb_build_object(
      'employee_id', p_employee_id, 'day', p_day, 'day_start', v_day_start, 'day_end', v_day_end,
      'on_shift', v_on_shift, 'shift_count', v_shift_n, 'shift_seconds', v_shift_secs,
      'first_start_at', v_first_start, 'last_end_at', v_last_end,
      'visit_count', v_visit_n, 'visit_seconds', v_visit_secs,
      'idle_stop_count', v_idle_n, 'idle_stop_seconds', v_idle_secs,
      'gap_count', v_gap_n, 'gap_seconds', v_gap_secs,
      'distance_m', round(v_dist, 1), 'ping_count', v_ping_n, 'last_ping_at', v_last_ping,
      'flags', to_jsonb(array(select distinct f from unnest(v_flags) f order by 1)))
    || case when p_detail then jsonb_build_object('shifts', v_shifts, 'visits', v_visits, 'stops', to_jsonb(v_stops),
                                                  'gaps', v_gaps, 'points', v_points,
                                                  'points_truncated', v_listed < v_ping_n, 'points_limit', v_pt_limit)
            else '{}'::jsonb end;
end $$;

-- ---------------------------------------------------------------------------
-- 4. Commands
-- ---------------------------------------------------------------------------
-- From 20261031000300 (latest definition); M4: the window never starts before the employee's
-- latest previous window_end, so back-dated shifts cannot overlap (flag overlap_clamped).
create or replace function api.start_shift(p_client_ref uuid, p_lat numeric, p_lng numeric, p_accuracy_m numeric,
                                           p_captured_at timestamptz)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_emp uuid := authz.current_employee_id();
  v_s field.work_shifts%rowtype; v_cur text; v_ws timestamptz; v_flags text[] := '{}'; v_id uuid; v_prev_end timestamptz;
  v_tol interval := field.tracking_num('tracking.ping_tolerance_s', 120) * interval '1 second';
  v_max interval := field.tracking_num('tracking.max_shift_hours', 10) * interval '1 hour';
begin
  perform authz.require('field.shift.start');
  if v_emp is null then raise exception 'NO_EMPLOYEE_PROFILE' using errcode = '42501'; end if;
  if p_client_ref is null then raise exception 'VALIDATION: client_ref is required' using errcode = 'P0001'; end if;
  perform field.tracking_lock(v_emp);

  -- Idempotent replay from the offline queue.
  select * into v_s from field.work_shifts where client_ref = p_client_ref;
  if found then
    if v_s.employee_id <> v_emp then
      raise exception 'CONFLICT: this client_ref was used by someone else' using errcode = 'P0001';
    end if;
    return jsonb_build_object('shift_id', v_s.id, 'status', v_s.status, 'window_start', v_s.window_start,
                              'max_end_at', v_s.window_start + v_max, 'replayed', true);
  end if;

  if p_captured_at is null then raise exception 'VALIDATION: captured_at is required' using errcode = 'P0001'; end if;
  perform field.tracking_check_fix(p_lat, p_lng, p_accuracy_m);

  select version into v_cur from field.tracking_notices where is_current;
  if v_cur is null or not exists (select 1 from field.tracking_notice_acks a
                                  where a.employee_id = v_emp and a.notice_version = v_cur) then
    raise exception 'NOTICE_REQUIRED: acknowledge the current tracking notice before starting a shift'
      using errcode = 'P0001';
  end if;

  perform field.tracking_close_stale(v_emp);
  if exists (select 1 from field.work_shifts where employee_id = v_emp and status = 'open') then
    raise exception 'SHIFT_OPEN: a shift is already open' using errcode = 'P0001';
  end if;

  -- Effective start: the device time when plausible (a start queued offline), never in the future.
  if p_captured_at > now() + v_tol then
    v_ws := now(); v_flags := v_flags || 'clock_skew'::text;
  elsif p_captured_at < now() - v_max then
    raise exception 'VALIDATION: the shift start is older than the maximum shift length' using errcode = 'P0001';
  else
    v_ws := least(p_captured_at, now());
    if now() - p_captured_at > interval '10 minutes' then v_flags := v_flags || 'late_sync'::text; end if;
  end if;
  -- Never before the end of the previous window (M4): no shift time is counted twice.
  select max(ws.window_end) into v_prev_end from field.work_shifts ws where ws.employee_id = v_emp and ws.window_end is not null;
  if v_prev_end is not null and v_ws < v_prev_end then
    v_ws := v_prev_end; v_flags := v_flags || 'overlap_clamped'::text;
  end if;
  if p_lat is null then v_flags := v_flags || 'no_device_location'::text; end if;

  insert into field.work_shifts (employee_id, client_ref, status, notice_version, business_date, start_captured_at,
                                 start_latitude, start_longitude, start_accuracy_m, window_start, anomaly_flags)
  values (v_emp, p_client_ref, 'open', v_cur, (v_ws at time zone 'Africa/Cairo')::date, p_captured_at,
          p_lat, p_lng, p_accuracy_m, v_ws, v_flags)
  returning id into v_id;

  insert into integration.outbox (event_type, aggregate_type, aggregate_id, payload)
  values ('tracking.shift_started', 'field.work_shift', v_id,
          jsonb_build_object('shift_id', v_id, 'employee_id', v_emp, 'window_start', v_ws));

  return jsonb_build_object('shift_id', v_id, 'status', 'open', 'window_start', v_ws,
                            'max_end_at', v_ws + v_max, 'anomaly_flags', to_jsonb(v_flags), 'replayed', false);
end $$;

-- A batch of points: [{ id, lat, lng, accuracy_m, captured_at, source? }]. Never fails for one bad
-- point: each point is accepted, a duplicate (same id, already stored: idempotent replay) or
-- rejected with a reason:
--   invalid       malformed point
--   conflict      the id belongs to another employee's point
--   outside_shift no shift window (± tolerance) contains it
--   too_late      its shift window ended more than tracking.late_point_grace_hours ago (M5)
--   too_frequent  closer than sample_interval_s / 2 to a stored point of the same shift (M3)
--   shift_cap     the shift already holds tracking.max_points_per_shift points (M3)
-- Rejected points are not stored. A batch claiming source "native" is refused as a whole (L2).
create or replace function api.record_location_pings(p_pings jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_emp uuid := authz.current_employee_id();
  v_tol interval := field.tracking_num('tracking.ping_tolerance_s', 120) * interval '1 second';
  v_max interval := field.tracking_num('tracking.max_shift_hours', 10) * interval '1 hour';
  v_max_acc numeric := field.tracking_num('tracking.max_accuracy_m', 100);
  v_max_kmh numeric := field.tracking_num('tracking.max_speed_kmh', 150);
  v_limit int := field.tracking_num('tracking.max_batch', 500)::int;
  v_interval numeric := greatest(field.tracking_num('tracking.sample_interval_s', 300), 2);
  v_half interval := (v_interval / 2) * interval '1 second';
  v_cap int := field.tracking_num('tracking.max_points_per_shift',
                 ceil(field.tracking_num('tracking.max_shift_hours', 10) * 3600 / (v_interval / 2)))::int;
  v_grace interval := field.tracking_num('tracking.late_point_grace_hours', 24) * interval '1 hour';
  r record; v_owner uuid; v_shift uuid; v_shift_open boolean; v_shift_end timestamptz; v_prev record; v_flags text[];
  v_count_shift uuid; v_count int := 0;
  v_accepted int := 0; v_dup int := 0; v_rejected jsonb[] := '{}';
begin
  perform authz.require('field.shift.start');
  if v_emp is null then raise exception 'NO_EMPLOYEE_PROFILE' using errcode = '42501'; end if;
  if p_pings is null or jsonb_typeof(p_pings) <> 'array' then
    raise exception 'VALIDATION: pings must be a JSON array' using errcode = 'P0001';
  end if;
  if jsonb_array_length(p_pings) > v_limit then
    raise exception 'VALIDATION: at most % points per upload', v_limit using errcode = 'P0001';
  end if;
  -- L2: only the in-browser collector ('pwa') exists. A client can claim any source, so 'native'
  -- is refused until the Phase 2 native collector sends through an attested channel (e.g. Play
  -- Integrity / a device-bound key checked on the server). RE-ENABLE HERE, and in the per-point
  -- source check below, only together with that attestation (D-14, V-06).
  if exists (select 1 from jsonb_array_elements(p_pings) as x(v)
             where jsonb_typeof(x.v) = 'object' and x.v ->> 'source' = 'native') then
    raise exception 'VALIDATION: source "native" is not accepted until the native collector is attested; send "pwa"'
      using errcode = 'P0001';
  end if;
  perform field.tracking_lock(v_emp);
  perform field.tracking_close_stale(v_emp);

  for r in
    select x.ord, left(x.v ->> 'id', 64) as raw_id, core.try_cast_uuid(x.v ->> 'id') as id,
           case when jsonb_typeof(x.v -> 'lat') = 'number' then (x.v ->> 'lat')::numeric end as lat,
           case when jsonb_typeof(x.v -> 'lng') = 'number' then (x.v ->> 'lng')::numeric end as lng,
           case when jsonb_typeof(x.v -> 'accuracy_m') = 'number' then (x.v ->> 'accuracy_m')::numeric end as acc,
           jsonb_typeof(x.v -> 'accuracy_m') as acc_type,
           field.try_cast_timestamptz(x.v ->> 'captured_at') as captured_at,
           coalesce(x.v ->> 'source', 'pwa') as source
    from jsonb_array_elements(p_pings) with ordinality as x(v, ord)
    order by field.try_cast_timestamptz(x.v ->> 'captured_at') nulls first, x.ord
  loop
    if r.id is null or r.lat is null or r.lng is null or r.captured_at is null
       or r.lat not between -90 and 90 or r.lng not between -180 and 180
       or (r.acc_type is not null and r.acc_type not in ('number','null'))
       or (r.acc is not null and (r.acc < 0 or r.acc > 9999999))
       or r.source <> 'pwa' then                          -- L2: add 'native' here only with attestation
      v_rejected := array_append(v_rejected, jsonb_build_object('id', r.raw_id, 'reason', 'invalid'));
      continue;
    end if;

    select employee_id into v_owner from field.location_pings where id = r.id;
    if found then
      if v_owner = v_emp then v_dup := v_dup + 1;
      else v_rejected := array_append(v_rejected, jsonb_build_object('id', r.raw_id, 'reason', 'conflict'));
      end if;
      continue;
    end if;

    -- The shift whose window (± tolerance) contains the point. Open shifts end at now (capped at max length).
    select ws.id, ws.status = 'open', ws.window_end into v_shift, v_shift_open, v_shift_end
    from field.work_shifts ws
    where ws.employee_id = v_emp
      and r.captured_at >= ws.window_start - v_tol
      and r.captured_at <= coalesce(ws.window_end, least(now(), ws.window_start + v_max)) + v_tol
    order by ws.window_start desc limit 1;
    if v_shift is null then
      v_rejected := array_append(v_rejected, jsonb_build_object('id', r.raw_id, 'reason', 'outside_shift'));
      continue;
    end if;
    -- M5: late uploads only into an open shift or one that ended less than the grace ago.
    if not v_shift_open and v_shift_end < now() - v_grace then
      v_rejected := array_append(v_rejected, jsonb_build_object('id', r.raw_id, 'reason', 'too_late'));
      continue;
    end if;
    -- M3: one point per half sampling interval, at most v_cap per shift.
    if exists (select 1 from field.location_pings lp
               where lp.shift_id = v_shift
                 and lp.captured_at > r.captured_at - v_half and lp.captured_at < r.captured_at + v_half) then
      v_rejected := array_append(v_rejected, jsonb_build_object('id', r.raw_id, 'reason', 'too_frequent'));
      continue;
    end if;
    if v_count_shift is distinct from v_shift then
      select count(*)::int into v_count
      from (select 1 from field.location_pings lp where lp.shift_id = v_shift limit greatest(v_cap, 0)) x;
      v_count_shift := v_shift;
    end if;
    if v_count >= v_cap then
      v_rejected := array_append(v_rejected, jsonb_build_object('id', r.raw_id, 'reason', 'shift_cap'));
      continue;
    end if;

    v_flags := '{}';
    if r.acc is null or r.acc > v_max_acc then v_flags := v_flags || 'low_accuracy'::text; end if;
    if r.captured_at > now() + interval '60 seconds' then v_flags := v_flags || 'clock_skew'::text; end if;
    select lp.latitude, lp.longitude, lp.captured_at into v_prev
    from field.location_pings lp
    where lp.employee_id = v_emp and lp.captured_at <= r.captured_at
    order by lp.captured_at desc, lp.received_at desc limit 1;
    if v_prev.captured_at is not null then
      if v_prev.captured_at = r.captured_at and v_prev.latitude = round(r.lat, 6) and v_prev.longitude = round(r.lng, 6) then
        v_flags := v_flags || 'duplicate_fix'::text;
      elsif core.distance_m(v_prev.latitude, v_prev.longitude, r.lat, r.lng)
            / greatest(extract(epoch from (r.captured_at - v_prev.captured_at)), 1) * 3.6 > v_max_kmh then
        v_flags := v_flags || 'impossible_travel'::text;
      end if;
    end if;

    insert into field.location_pings (id, shift_id, employee_id, latitude, longitude, accuracy_m, captured_at, source, anomaly_flags)
    values (r.id, v_shift, v_emp, r.lat, r.lng, r.acc, r.captured_at, r.source, v_flags);
    v_accepted := v_accepted + 1; v_count := v_count + 1;
  end loop;

  return jsonb_build_object('accepted', v_accepted, 'duplicates', v_dup, 'rejected', to_jsonb(v_rejected),
                            'replayed', v_accepted = 0 and v_dup > 0 and cardinality(v_rejected) = 0);
end $$;

-- ---------------------------------------------------------------------------
-- 5. Reads
-- ---------------------------------------------------------------------------
-- From 20261031000300; today_shift_seconds now merges overlapping windows (M4).
create or replace function api.my_tracking_status()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_emp uuid := authz.current_employee_id();
  v_max interval := field.tracking_num('tracking.max_shift_hours', 10) * interval '1 hour';
  v_n field.tracking_notices%rowtype; v_ack timestamptz; v_open field.work_shifts%rowtype;
  v_last record; v_today date := core.business_date(); v_shift jsonb; v_today_secs int;
begin
  if not authz.is_active_user() then raise exception 'PERMISSION_DENIED: inactive user' using errcode = '42501'; end if;
  select * into v_n from field.tracking_notices where is_current;
  if v_emp is not null and v_n.version is not null then
    select acknowledged_at into v_ack from field.tracking_notice_acks where employee_id = v_emp and notice_version = v_n.version;
  end if;
  if v_emp is not null then
    select * into v_open from field.work_shifts where employee_id = v_emp and status = 'open';
  end if;
  if v_open.id is not null then
    select max(lp.captured_at) as captured_at, max(lp.received_at) as received_at, count(*)::int as n
      into v_last from field.location_pings lp where lp.shift_id = v_open.id;
    v_shift := jsonb_build_object(
      'id', v_open.id, 'client_ref', v_open.client_ref, 'status', v_open.status, 'started_at', v_open.started_at,
      'window_start', v_open.window_start, 'max_end_at', v_open.window_start + v_max,
      'overdue', now() >= v_open.window_start + v_max,
      'last_ping_at', v_last.captured_at, 'last_ping_received_at', v_last.received_at, 'ping_count', v_last.n);
  end if;
  select coalesce(sum(floor(extract(epoch from (w.seg_end - w.seg_start)))), 0)::int
    into v_today_secs from field.tracking_day_windows(v_emp, v_today) w;

  return jsonb_build_object(
    'employee_id', v_emp,
    'can_start', v_emp is not null and authz.has_permission('field.shift.start'),
    'server_now', now(), 'business_date', v_today,
    'notice', case when v_n.version is null then null else jsonb_build_object(
                'version', v_n.version, 'body_ar', v_n.body_ar, 'body_en', v_n.body_en, 'published_at', v_n.published_at) end,
    'acknowledged_at', v_ack,
    'open_shift', v_shift,
    'today_shift_seconds', v_today_secs,
    'settings', jsonb_build_object(
      'sample_interval_s', field.tracking_num('tracking.sample_interval_s', 300),
      'max_shift_hours', field.tracking_num('tracking.max_shift_hours', 10),
      'retention_days', field.tracking_num('tracking.retention_days', 90),
      'max_accuracy_m', field.tracking_num('tracking.max_accuracy_m', 100),
      'max_batch', field.tracking_num('tracking.max_batch', 500),
      'work_days', (select s.value from core.system_settings s where s.key = 'tracking.work_days'),
      'work_hours', (select s.value from core.system_settings s where s.key = 'tracking.work_hours')));
end $$;

-- From 20261031000300. One rep, one Cairo day. M3: the point list is capped (points_truncated).
-- M7: once the retention purge has summarized the day (a stored summary exists), the figures
-- come from that summary and no live stops, gaps or points are returned (summary_only = true):
-- recomputing from the remaining shifts would report the whole shift as one gap.
create or replace function api.tracking_day(p_employee_id uuid, p_day date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_me uuid := authz.current_employee_id(); v_e core.employees%rowtype; v_names boolean;
  v_retention int := field.tracking_num('tracking.retention_days', 90)::int; v_summary jsonb; v_day jsonb;
begin
  if not authz.is_active_user() then raise exception 'PERMISSION_DENIED: inactive user' using errcode = '42501'; end if;
  if p_employee_id is null or p_day is null then
    raise exception 'VALIDATION: employee and day are required' using errcode = 'P0001';
  end if;
  if not (authz.has_global('field.tracking.read') or p_employee_id = any(authz.tracking_employee_ids())) then
    raise exception 'PERMISSION_DENIED: field.tracking.read' using errcode = '42501';
  end if;
  select * into v_e from core.employees where id = p_employee_id;
  if not found then raise exception 'NOT_FOUND: employee' using errcode = 'P0002'; end if;

  -- Customer names only for visits the caller may read anyway (field.visit.read scope, or own).
  v_names := p_employee_id = v_me or authz.has_global('field.visit.read')
             or p_employee_id = any(authz.employee_ids('field.visit.read'));
  select to_jsonb(s) - 'employee_id' - 'business_date' into v_summary
  from field.tracking_day_summaries s where s.employee_id = p_employee_id and s.business_date = p_day;

  v_day := field.tracking_compute_day(p_employee_id, p_day, true, v_names);
  if v_summary is not null then
    v_day := v_day || jsonb_build_object(
      'on_shift', false,
      'shift_count', v_summary -> 'shift_count', 'shift_seconds', v_summary -> 'shift_seconds',
      'visit_count', v_summary -> 'visit_count', 'visit_seconds', v_summary -> 'visit_seconds',
      'idle_stop_count', v_summary -> 'idle_stop_count', 'idle_stop_seconds', v_summary -> 'idle_stop_seconds',
      'gap_count', v_summary -> 'gap_count', 'gap_seconds', v_summary -> 'gap_seconds',
      'distance_m', v_summary -> 'distance_m', 'ping_count', v_summary -> 'ping_count',
      'last_ping_at', null, 'flags', coalesce(v_summary -> 'flags', '[]'::jsonb),
      'stops', '[]'::jsonb, 'gaps', '[]'::jsonb, 'points', '[]'::jsonb, 'points_truncated', false);
  end if;

  return v_day
      || jsonb_build_object(
           'employee', jsonb_build_object('id', v_e.id, 'employee_no', v_e.employee_no,
                                          'full_name_en', v_e.full_name_en, 'full_name_ar', v_e.full_name_ar),
           'raw_purged', p_day < core.business_date() - v_retention,
           'summary_only', v_summary is not null,
           'retention_days', v_retention,
           'stored_summary', v_summary);
end $$;

-- From 20261031000300. M7: a stored summary, when one exists, is the day's figures (same rule
-- as api.tracking_day), not only past the retention boundary.
create or replace function api.tracking_team_day(p_day date default null)
returns table (employee_id uuid, employee_no text, full_name_en text, full_name_ar text, business_date date,
               on_shift boolean, shift_count int, shift_seconds int, first_start_at timestamptz, last_end_at timestamptz,
               visit_count int, visit_seconds int, idle_stop_count int, idle_stop_seconds int,
               gap_count int, gap_seconds int, distance_m numeric, ping_count int, last_ping_at timestamptz,
               flags text[], from_summary boolean)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_day date := coalesce(p_day, core.business_date());
  v_all boolean; v_ids uuid[]; e record; j jsonb; s field.tracking_day_summaries%rowtype;
begin
  perform authz.require('field.tracking.read');
  v_all := authz.has_global('field.tracking.read');
  v_ids := authz.tracking_employee_ids();
  for e in
    select emp.id, emp.employee_no, emp.full_name_en, emp.full_name_ar from core.employees emp
    where (v_all or emp.id = any(v_ids))
      and (exists (select 1 from field.work_shifts ws where ws.employee_id = emp.id and ws.business_date = v_day)
           or (emp.id is distinct from authz.current_employee_id()
               and emp.employment_status in ('active','on_leave') and emp.user_id is not null and exists (
                 select 1 from authz.user_roles ur
                 join authz.roles r on r.id = ur.role_id and r.is_active
                 join authz.role_permissions rp on rp.role_id = ur.role_id and rp.permission_code = 'field.shift.start'
                 where ur.user_id = emp.user_id and ur.revoked_at is null and ur.valid_from <= now()
                   and (ur.valid_to is null or ur.valid_to > now()))))
    order by emp.full_name_en, emp.id
  loop
    select * into s from field.tracking_day_summaries ds where ds.employee_id = e.id and ds.business_date = v_day;
    employee_id := e.id; employee_no := e.employee_no; full_name_en := e.full_name_en; full_name_ar := e.full_name_ar;
    business_date := v_day;
    if s.employee_id is not null then
      on_shift := false; shift_count := s.shift_count; shift_seconds := s.shift_seconds;
      first_start_at := null; last_end_at := null;
      visit_count := s.visit_count; visit_seconds := s.visit_seconds;
      idle_stop_count := s.idle_stop_count; idle_stop_seconds := s.idle_stop_seconds;
      gap_count := s.gap_count; gap_seconds := s.gap_seconds; distance_m := s.distance_m;
      ping_count := s.ping_count; last_ping_at := null; flags := s.flags; from_summary := true;
    else
      j := field.tracking_compute_day(e.id, v_day, false, false);
      on_shift := (j ->> 'on_shift')::boolean; shift_count := (j ->> 'shift_count')::int;
      shift_seconds := (j ->> 'shift_seconds')::int;
      first_start_at := (j ->> 'first_start_at')::timestamptz; last_end_at := (j ->> 'last_end_at')::timestamptz;
      visit_count := (j ->> 'visit_count')::int; visit_seconds := (j ->> 'visit_seconds')::int;
      idle_stop_count := (j ->> 'idle_stop_count')::int; idle_stop_seconds := (j ->> 'idle_stop_seconds')::int;
      gap_count := (j ->> 'gap_count')::int; gap_seconds := (j ->> 'gap_seconds')::int;
      distance_m := (j ->> 'distance_m')::numeric; ping_count := (j ->> 'ping_count')::int;
      last_ping_at := (j ->> 'last_ping_at')::timestamptz;
      flags := array(select jsonb_array_elements_text(j -> 'flags')); from_summary := false;
    end if;
    return next;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 6. Retention keyed on the capture time (M5)
-- ---------------------------------------------------------------------------
-- From 20261031000300. A point goes once least(captured_at, received_at) is older than
-- tracking.retention_days, so nothing outlives the retention counted from its capture (a late
-- upload no longer restarts the clock). The day is summarized first, as before.
create or replace function service.tracking_purge() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v_days int; v_cut timestamptz; v_sum int; v_del int; v_clr int;
begin
  v_days := field.tracking_num('tracking.retention_days', 90)::int;
  if v_days < 30 then
    raise exception 'VALIDATION: tracking.retention_days must be at least 30 (got %)', v_days using errcode = 'P0001';
  end if;
  v_cut := now() - make_interval(days => v_days);

  insert into field.tracking_day_summaries (employee_id, business_date, shift_count, shift_seconds, visit_count,
         visit_seconds, idle_stop_count, idle_stop_seconds, gap_count, gap_seconds, distance_m, ping_count, flags)
  select d.employee_id, d.business_date, (j ->> 'shift_count')::int, (j ->> 'shift_seconds')::int,
         (j ->> 'visit_count')::int, (j ->> 'visit_seconds')::int, (j ->> 'idle_stop_count')::int,
         (j ->> 'idle_stop_seconds')::int, (j ->> 'gap_count')::int, (j ->> 'gap_seconds')::int,
         (j ->> 'distance_m')::numeric, (j ->> 'ping_count')::int,
         array(select jsonb_array_elements_text(j -> 'flags'))
  from (select distinct ws.employee_id, ws.business_date
        from field.location_pings lp join field.work_shifts ws on ws.id = lp.shift_id
        where lp.captured_at < v_cut or lp.received_at < v_cut) d
  cross join lateral field.tracking_compute_day(d.employee_id, d.business_date, false, false) j
  on conflict (employee_id, business_date) do nothing;
  get diagnostics v_sum = row_count;

  delete from field.location_pings where captured_at < v_cut or received_at < v_cut;
  get diagnostics v_del = row_count;

  update field.work_shifts
     set start_latitude = null, start_longitude = null, start_accuracy_m = null,
         end_latitude = null, end_longitude = null, end_accuracy_m = null
   where (started_at < v_cut or window_start < v_cut) and status <> 'open'
     and (start_latitude is not null or end_latitude is not null);
  get diagnostics v_clr = row_count;

  insert into audit.security_events (user_id, event_type, severity, details)
  values (auth.uid(), 'retention_purge', 'info',
          jsonb_build_object('table', 'field.location_pings', 'deleted', v_del, 'summarized_days', v_sum,
                             'shifts_cleared', v_clr, 'retention_days', v_days));
  return jsonb_build_object('deleted', v_del, 'summarized_days', v_sum, 'shifts_cleared', v_clr, 'retention_days', v_days);
end $$;

-- ---------------------------------------------------------------------------
-- 7. Privileges (explicit; never a blanket grant on a schema)
-- ---------------------------------------------------------------------------
revoke execute on function field.tracking_day_windows(uuid, date) from public, anon, authenticated;
revoke execute on function field.tracking_compute_day(uuid, date, boolean, boolean) from public, anon, authenticated;
revoke execute on function service.tracking_purge() from public, anon, authenticated;
grant execute on function service.tracking_purge() to service_role;

do $$
declare f text;
begin
  foreach f in array array[
    'api.start_shift(uuid, numeric, numeric, numeric, timestamptz)',
    'api.record_location_pings(jsonb)',
    'api.my_tracking_status()',
    'api.tracking_day(uuid, date)',
    'api.tracking_team_day(date)']
  loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
