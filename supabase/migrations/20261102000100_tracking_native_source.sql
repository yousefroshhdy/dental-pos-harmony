-- Honest OS migration: work-hours tracking, D-14 phase 2 (the Android shell).
--
-- The Android app (mobile/, Capacitor + @capacitor-community/background-geolocation) sends its
-- points with source = 'native'. The 2026-11-01 audit (L2, migration 20261101000200) refused
-- 'native' until "an attested channel" existed. Phase 2 accepts it again WITHOUT attestation,
-- so the value is advisory only:
--   · it says which collector took the point (shown on the day page, useful for support);
--   · it grants nothing: the same open-shift binding, ± tolerance window, late-point grace,
--     half-interval spacing, per-shift cap, anomaly flags (low accuracy, clock skew, duplicate,
--     impossible travel) and caller-scope rules apply to 'pwa' and 'native' points alike;
--   · no read, KPI or flag may treat a 'native' point as more trustworthy. If a trusted channel
--     is needed later (Play Integrity, a device-bound key), it must be a separate, verified
--     column, never this client-supplied field.
-- Any other source value is still answered `rejected: invalid`.
--
-- Non-destructive: create or replace of api.record_location_pings(jsonb) from its latest
-- definition (20261101000200) with only the source rule changed; same signature and grants.

-- A batch of points: [{ id, lat, lng, accuracy_m, captured_at, source? }]. Never fails for one bad
-- point: each point is accepted, a duplicate (same id, already stored: idempotent replay) or
-- rejected with a reason:
--   invalid       malformed point
--   conflict      the id belongs to another employee's point
--   outside_shift no shift window (± tolerance) contains it
--   too_late      its shift window ended more than tracking.late_point_grace_hours ago (M5)
--   too_frequent  closer than sample_interval_s / 2 to a stored point of the same shift (M3)
--   shift_cap     the shift already holds tracking.max_points_per_shift points (M3)
-- Rejected points are not stored. `source` is 'pwa' (browser) or 'native' (Android shell); any other
-- value makes that point invalid. The source is ADVISORY ONLY (see the header).
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
  -- D-14 phase 2: 'native' (the Android shell) is accepted again. It is NOT attested: any
  -- authenticated rep can send either value, so `source` is advisory only. No rule may give a
  -- 'native' point more trust than a 'pwa' one (no skipped anomaly check, no wider shift window,
  -- no higher cap, no different scope). Every check below applies to both alike.
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
       or r.source not in ('pwa','native') then           -- advisory only; same checks for both
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
-- Privileges (unchanged; restated because PostgreSQL's global PUBLIC execute is not revoked by
-- schema default privileges, CLAUDE.md gotcha / test 08)
-- ---------------------------------------------------------------------------
revoke execute on function api.record_location_pings(jsonb) from public, anon;
grant execute on function api.record_location_pings(jsonb) to authenticated;
