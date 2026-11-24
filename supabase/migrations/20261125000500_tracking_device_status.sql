-- Honest OS migration: Phase P step 5, the tracking health panel (D-14).
--
-- Managers need to see, per rep, whether tracking is actually working on the phone: the shift
-- (open or closed, since when), the last point (when it was taken, when it arrived, which
-- collector), and what the device itself last reported (location permission, app version, web
-- build, battery saver, points still waiting on the phone). Without it, a gap on the day page
-- cannot be told apart from a refused permission or a phone that killed the app.
--
-- Table:   field.device_status, one row per shift: the device's LAST report (a snapshot, replaced
--          by every report). No coordinates, no device identifiers.
-- Command: api.report_device_status(p_shift_id, p_payload jsonb)
--            · bound to the caller's own OPEN shift (anything else: NO_OPEN_SHIFT);
--            · whitelisted keys with typed values (anything else: VALIDATION), at most 1 KB;
--            · at most one report a minute per shift: a faster one answers
--              {status: rate_limited, retry_after_s} and stores nothing (not an error, so a
--              device that reloads at the wrong moment does not log failures).
--          The client sends it at shift start and every 5 minutes while collecting. It is a
--          snapshot, so a lost or repeated report is harmless: no client_ref is needed, and the
--          device never queues it offline (a stale status is worse than none).
-- Read:    api.v_tracking_health (security_invoker), one row per trackable employee in the
--          caller's D-14 scope (field.tracking_health_roster: the caller, field.tracking.read
--          own/team/territory, or global; trackable = holds field.shift.start through an active
--          role, or has ever had a shift). RLS on work_shifts, location_pings and device_status
--          applies on top. needs_attention: the shift is open and nothing arrived for more than
--          15 minutes (from the shift start when no point arrived yet).
--
-- Audit: like shifts and points (20261031000300), device reports carry no audit trigger: the row
-- is overwritten every 5 minutes and holds no business fact; the audit log would only grow.
-- The value of `source` stays advisory (20261102000100): it is the collector the device says it
-- runs, shown for support, and grants nothing.
--
-- Non-destructive: one new table, one new internal helper, one new command, one new view.

-- ---------------------------------------------------------------------------
-- 1. Table
-- ---------------------------------------------------------------------------
create table field.device_status (
  shift_id       uuid primary key references field.work_shifts(id),
  employee_id    uuid not null references core.employees(id),
  reported_at    timestamptz not null default now(),          -- server time of the last report
  report_count   int not null default 1 check (report_count >= 1),
  source         text check (source in ('pwa','native')),     -- the collector the device runs (advisory)
  permission     text check (permission in ('granted','denied','prompt','services_off','unknown')),
  app_version    text check (app_version ~ '^[0-9A-Za-z._+-]{1,40}$'),   -- the Android shell's version, when known
  web_build      text check (web_build ~ '^[0-9A-Za-z._+-]{1,40}$'),     -- the web deployment that served the page
  battery_saver  boolean,                                     -- null: the device cannot tell
  pending_points int check (pending_points between 0 and 100000),          -- points on the phone, not yet sent
  created_at     timestamptz not null default now()
);
create index idx_device_status_employee on field.device_status (employee_id, reported_at desc);

alter table field.device_status enable row level security;
grant select on field.device_status to authenticated;
create policy device_status_select on field.device_status for select to authenticated using (
  (select authz.has_global('field.tracking.read'))
  or employee_id = any((select authz.tracking_employee_ids())::uuid[]));

-- ---------------------------------------------------------------------------
-- 2. The roster of the health view (definer: core.employees and authz.user_roles are not
--    readable by a manager through RLS). Same scope rule as api.tracking_team_day, but the
--    caller is listed too (a rep sees their own row) and every day counts (latest shift).
-- ---------------------------------------------------------------------------
create or replace function field.tracking_health_roster()
returns table (employee_id uuid, employee_no text, full_name_en text, full_name_ar text)
language sql stable security definer set search_path = '' as $$
  select e.id, e.employee_no, e.full_name_en, e.full_name_ar
  from core.employees e
  where authz.is_active_user()
    and (authz.has_global('field.tracking.read') or e.id = any(authz.tracking_employee_ids()))
    and (exists (select 1 from field.work_shifts ws where ws.employee_id = e.id)
         or (e.employment_status in ('active','on_leave') and e.user_id is not null and exists (
               select 1 from authz.user_roles ur
               join authz.roles r on r.id = ur.role_id and r.is_active
               join authz.role_permissions rp on rp.role_id = ur.role_id and rp.permission_code = 'field.shift.start'
               where ur.user_id = e.user_id and ur.revoked_at is null and ur.valid_from <= now()
                 and (ur.valid_to is null or ur.valid_to > now()))))
$$;

-- ---------------------------------------------------------------------------
-- 3. Command
-- ---------------------------------------------------------------------------
-- p_payload keys (all optional; a key not sent is stored as null):
--   source          'pwa' | 'native'
--   permission      'granted' | 'denied' | 'prompt' | 'services_off' | 'unknown'
--   app_version     ^[0-9A-Za-z._+-]{1,40}$ or null
--   web_build       ^[0-9A-Za-z._+-]{1,40}$ or null
--   battery_saver   true | false | null
--   pending_points  integer 0..100000 or null
create or replace function api.report_device_status(p_shift_id uuid, p_payload jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_emp uuid := authz.current_employee_id();
  v_min interval := interval '60 seconds';
  v_keys constant text[] := array['source','permission','app_version','web_build','battery_saver','pending_points'];
  v_bad text; v_last timestamptz; v_n int;
  v_source text; v_perm text; v_app text; v_web text; v_saver boolean; v_pending int;
begin
  perform authz.require('field.shift.start');
  if v_emp is null then raise exception 'NO_EMPLOYEE_PROFILE' using errcode = '42501'; end if;
  if p_shift_id is null then raise exception 'VALIDATION: shift_id is required' using errcode = 'P0001'; end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'VALIDATION: payload must be a JSON object' using errcode = 'P0001';
  end if;
  if octet_length(p_payload::text) > 1024 then
    raise exception 'VALIDATION: payload too large (at most 1024 bytes)' using errcode = 'P0001';
  end if;
  select string_agg(k, ', ' order by k) into v_bad from jsonb_object_keys(p_payload) k where k <> all (v_keys);
  if v_bad is not null then
    raise exception 'VALIDATION: unknown key(s) %', left(v_bad, 200) using errcode = 'P0001';
  end if;

  -- Typed values (a JSON null is the same as a missing key).
  if p_payload ? 'source' and jsonb_typeof(p_payload -> 'source') <> 'null' then
    v_source := p_payload ->> 'source';
    if jsonb_typeof(p_payload -> 'source') <> 'string' or v_source not in ('pwa','native') then
      raise exception 'VALIDATION: source must be pwa or native' using errcode = 'P0001';
    end if;
  end if;
  if p_payload ? 'permission' and jsonb_typeof(p_payload -> 'permission') <> 'null' then
    v_perm := p_payload ->> 'permission';
    if jsonb_typeof(p_payload -> 'permission') <> 'string'
       or v_perm not in ('granted','denied','prompt','services_off','unknown') then
      raise exception 'VALIDATION: permission must be granted, denied, prompt, services_off or unknown' using errcode = 'P0001';
    end if;
  end if;
  if p_payload ? 'app_version' and jsonb_typeof(p_payload -> 'app_version') <> 'null' then
    v_app := p_payload ->> 'app_version';
    if jsonb_typeof(p_payload -> 'app_version') <> 'string' or v_app !~ '^[0-9A-Za-z._+-]{1,40}$' then
      raise exception 'VALIDATION: app_version must be a short version string' using errcode = 'P0001';
    end if;
  end if;
  if p_payload ? 'web_build' and jsonb_typeof(p_payload -> 'web_build') <> 'null' then
    v_web := p_payload ->> 'web_build';
    if jsonb_typeof(p_payload -> 'web_build') <> 'string' or v_web !~ '^[0-9A-Za-z._+-]{1,40}$' then
      raise exception 'VALIDATION: web_build must be a short build id' using errcode = 'P0001';
    end if;
  end if;
  if p_payload ? 'battery_saver' and jsonb_typeof(p_payload -> 'battery_saver') <> 'null' then
    if jsonb_typeof(p_payload -> 'battery_saver') <> 'boolean' then
      raise exception 'VALIDATION: battery_saver must be true, false or null' using errcode = 'P0001';
    end if;
    v_saver := (p_payload ->> 'battery_saver')::boolean;
  end if;
  if p_payload ? 'pending_points' and jsonb_typeof(p_payload -> 'pending_points') <> 'null' then
    if jsonb_typeof(p_payload -> 'pending_points') <> 'number'
       or (p_payload ->> 'pending_points') !~ '^[0-9]{1,6}$'
       or (p_payload ->> 'pending_points')::int > 100000 then
      raise exception 'VALIDATION: pending_points must be a whole number from 0 to 100000' using errcode = 'P0001';
    end if;
    v_pending := (p_payload ->> 'pending_points')::int;
  end if;

  -- Serialized with the rep's shift and point writes; an overdue shift is closed first.
  perform field.tracking_lock(v_emp);
  perform field.tracking_close_stale(v_emp);
  if not exists (select 1 from field.work_shifts ws
                 where ws.id = p_shift_id and ws.employee_id = v_emp and ws.status = 'open') then
    raise exception 'NO_OPEN_SHIFT: this is not your open shift' using errcode = 'P0001';
  end if;

  select d.reported_at into v_last from field.device_status d where d.shift_id = p_shift_id for update;
  if v_last is not null and v_last > now() - v_min then
    return jsonb_build_object('status', 'rate_limited', 'shift_id', p_shift_id, 'reported_at', v_last,
                              'retry_after_s', greatest(ceil(extract(epoch from (v_last + v_min - now())))::int, 1));
  end if;

  insert into field.device_status as d (shift_id, employee_id, reported_at, source, permission, app_version, web_build,
                                        battery_saver, pending_points)
  values (p_shift_id, v_emp, now(), v_source, v_perm, v_app, v_web, v_saver, v_pending)
  on conflict (shift_id) do update
     set reported_at = now(), report_count = d.report_count + 1, source = excluded.source,
         permission = excluded.permission, app_version = excluded.app_version, web_build = excluded.web_build,
         battery_saver = excluded.battery_saver, pending_points = excluded.pending_points
  returning d.report_count into v_n;

  return jsonb_build_object('status', 'recorded', 'shift_id', p_shift_id, 'reported_at', now(), 'report_count', v_n);
end $$;

-- ---------------------------------------------------------------------------
-- 4. The health view (security_invoker; scope = the roster, then RLS on every table read)
-- ---------------------------------------------------------------------------
create or replace view api.v_tracking_health with (security_invoker = true) as
  select r.employee_id, r.employee_no, r.full_name_en, r.full_name_ar,
         s.id as shift_id, s.status as shift_status, coalesce(s.status = 'open', false) as shift_open,
         s.window_start as shift_started_at, s.window_end as shift_ended_at,
         case when s.status = 'open' then s.window_start else s.window_end end as shift_since,
         lp.captured_at as last_point_at, lp.received_at as last_point_received_at, lp.source as last_point_source,
         sp.last_received_at as shift_last_received_at, coalesce(sp.n, 0) as shift_point_count,
         d.reported_at as device_reported_at, d.source as device_source, d.permission as device_permission,
         d.app_version as device_app_version, d.web_build as device_web_build,
         d.battery_saver as device_battery_saver, d.pending_points as device_pending_points,
         now() as checked_at,
         coalesce(s.status = 'open'
                  and coalesce(sp.last_received_at, s.window_start) < now() - interval '15 minutes', false) as needs_attention
  from field.tracking_health_roster() r
  left join lateral (select ws.id, ws.status, ws.window_start, ws.window_end from field.work_shifts ws
                     where ws.employee_id = r.employee_id
                     order by (ws.status = 'open') desc, ws.window_start desc, ws.id desc limit 1) s on true
  left join lateral (select p.captured_at, p.received_at, p.source from field.location_pings p
                     where p.employee_id = r.employee_id
                     order by p.captured_at desc, p.received_at desc limit 1) lp on true
  left join lateral (select max(p.received_at) as last_received_at, count(*)::int as n from field.location_pings p
                     where p.shift_id = s.id) sp on true
  left join field.device_status d on d.shift_id = s.id;

grant select on api.v_tracking_health to authenticated;
revoke all on api.v_tracking_health from anon;

-- ---------------------------------------------------------------------------
-- 5. Privileges (explicit; PostgreSQL's global PUBLIC execute is revoked by hand, test 08)
-- ---------------------------------------------------------------------------
-- The roster is needed by the view (test 17: client-executable definer helpers must be).
revoke execute on function field.tracking_health_roster() from public, anon;
grant execute on function field.tracking_health_roster() to authenticated;

revoke execute on function api.report_device_status(uuid, jsonb) from public, anon;
grant execute on function api.report_device_status(uuid, jsonb) to authenticated;
