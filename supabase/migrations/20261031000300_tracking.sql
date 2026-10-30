-- Honest OS migration: work-hours location tracking of field reps (D-14, Phase 1: server side).
--
-- Points are collected ONLY while the rep has an open shift ("Start my day" → "End my day").
-- The server refuses points outside a shift window and closes shifts left open longer than
-- tracking.max_shift_hours. Raw points are kept tracking.retention_days (90); daily summaries
-- are kept. Derived facts (stops, gaps, distance) are flags for a manager, never penalties.
--
-- Tables:   field.tracking_notices, field.tracking_notice_acks, field.work_shifts,
--           field.location_pings, field.tracking_day_summaries
-- Commands: api.acknowledge_tracking_notice, api.start_shift, api.end_shift,
--           api.record_location_pings
-- Reads:    api.my_tracking_status(), api.tracking_day(employee, day), api.tracking_team_day(day),
--           api.v_tracking_day_summaries
-- Service:  service.tracking_auto_close(), service.tracking_purge()  (cron: /api/cron/tracking)
-- Perms:    field.shift.start (sales_rep, area_manager, sales_director: own), field.tracking.read
--           (area_manager + sales_director: team; owner implicitly all). A rep always sees their own.
--
-- Audit: notices and acknowledgements carry the generic audit trigger. Shifts and points do NOT:
-- audit.audit_log is kept 7 years and append-only, so copying coordinates into it would defeat the
-- 90-day retention. Shift lifecycle is recorded by the shift row itself (server + device times)
-- and by outbox events that carry ids and times only.
--
-- Non-destructive only: new tables, functions, policies, settings and permissions.

-- ---------------------------------------------------------------------------
-- 1. Permissions (reference-data pattern) and system-role grants
-- ---------------------------------------------------------------------------
insert into authz.permissions (code, module, description, allowed_scopes, supports_limit, is_sensitive) values
  ('field.shift.start', 'field',
   'Start and end my working day; location points are collected only while it is open (D-14)',
   '{own}', false, false),
  ('field.tracking.read', 'field',
   'Read work-hours location tracking: shifts, points, stops, gaps and distance (D-14)',
   '{own,team,territory,all}', false, true)
on conflict (code) do nothing;

insert into authz.role_permissions (role_id, permission_code, scope, limit_value)
select r.id, v.perm, v.scope, null
from (values
  ('sales_rep', 'field.shift.start', 'own'),
  -- Managers who visit customers themselves may also run a shift; holding it also lets them
  -- grant the sales_rep role (api.grant_role's ceiling: never grant what you do not hold).
  ('area_manager', 'field.shift.start', 'own'),
  ('sales_director', 'field.shift.start', 'own'),
  ('area_manager', 'field.tracking.read', 'team'),
  ('sales_director', 'field.tracking.read', 'team')
) as v(role_code, perm, scope)
join authz.roles r on r.code = v.role_code
on conflict (role_id, permission_code) do nothing;

-- ---------------------------------------------------------------------------
-- 2. Settings (D-14 defaults; the owner may change any of them)
-- ---------------------------------------------------------------------------
insert into core.system_settings (key, value, description) values
  ('tracking.sample_interval_s', '300', 'Work-hours tracking: seconds between location points on the device'),
  ('tracking.max_shift_hours', '10', 'Work-hours tracking: a shift still open after this many hours is closed automatically'),
  ('tracking.retention_days', '90', 'Work-hours tracking: raw location points are deleted after this many days (minimum 30)'),
  ('tracking.ping_tolerance_s', '120', 'Work-hours tracking: points this many seconds outside the shift window are still accepted'),
  ('tracking.max_accuracy_m', '100', 'Work-hours tracking: points with worse accuracy are flagged low_accuracy and ignored for distance and stops'),
  ('tracking.max_speed_kmh', '150', 'Work-hours tracking: faster movement between two points is flagged impossible_travel'),
  ('tracking.stop_radius_m', '150', 'Work-hours tracking: consecutive points within this radius form a stop'),
  ('tracking.stop_min_minutes', '30', 'Work-hours tracking: a stop lasts at least this many minutes'),
  ('tracking.gap_min_minutes', '20', 'Work-hours tracking: no point for this many minutes during a shift is a gap'),
  ('tracking.max_batch', '500', 'Work-hours tracking: most points accepted in one upload'),
  ('tracking.work_days', '["sun","mon","tue","wed","thu"]', 'Work-hours tracking: the working week (informational)'),
  ('tracking.work_hours', '{"start":"09:00","end":"17:00"}', 'Work-hours tracking: the working day, Cairo time (informational)')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 3. Tables
-- ---------------------------------------------------------------------------
-- Versioned transparency notice. Exactly one is current; a new text = a new version.
create table field.tracking_notices (
  version      text primary key check (version ~ '^[0-9A-Za-z._-]{1,40}$'),
  body_ar      text not null check (length(btrim(body_ar)) > 0),
  body_en      text not null check (length(btrim(body_en)) > 0),
  is_current   boolean not null default false,
  published_at timestamptz not null default now(),
  created_by   uuid references auth.users(id)
);
create unique index uq_tracking_notice_current on field.tracking_notices ((true)) where is_current;

-- The employee's acknowledgement of one notice version (append-only legal record).
create table field.tracking_notice_acks (
  id              uuid primary key default gen_random_uuid(),
  employee_id     uuid not null references core.employees(id),
  user_id         uuid not null references auth.users(id),
  notice_version  text not null references field.tracking_notices(version),
  acknowledged_at timestamptz not null default now(),
  unique (employee_id, notice_version)
);
create trigger trg_tracking_notice_acks_append_only before update on field.tracking_notice_acks
  for each row execute function core.forbid_mutation();

-- One working day. Times come from the server (started_at / ended_at) and from the device
-- (start_captured_at / end_captured_at). window_start / window_end is the effective window that
-- points must fall in: the device time when plausible (offline start), else the server time,
-- never in the future and never longer than tracking.max_shift_hours.
create table field.work_shifts (
  id                uuid primary key default gen_random_uuid(),
  employee_id       uuid not null references core.employees(id),
  client_ref        uuid not null unique,              -- device idempotency key of the start
  end_client_ref    uuid unique,                       -- device idempotency key of the end
  status            text not null default 'open' check (status in ('open','closed','auto_closed')),
  notice_version    text not null references field.tracking_notices(version),
  business_date     date not null,                     -- Cairo date of window_start
  started_at        timestamptz not null default now(),
  start_captured_at timestamptz not null,
  start_latitude    numeric(9,6) check (start_latitude between -90 and 90),
  start_longitude   numeric(9,6) check (start_longitude between -180 and 180),
  start_accuracy_m  numeric(8,1) check (start_accuracy_m >= 0),
  window_start      timestamptz not null,
  ended_at          timestamptz,
  end_captured_at   timestamptz,
  end_latitude      numeric(9,6) check (end_latitude between -90 and 90),
  end_longitude     numeric(9,6) check (end_longitude between -180 and 180),
  end_accuracy_m    numeric(8,1) check (end_accuracy_m >= 0),
  window_end        timestamptz,
  anomaly_flags     text[] not null default '{}',
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  check ((status = 'open') = (ended_at is null)),
  check ((status = 'open') = (window_end is null)),
  check (window_end is null or window_end >= window_start),
  check ((start_latitude is null) = (start_longitude is null)),
  check ((end_latitude is null) = (end_longitude is null))
);
create unique index uq_work_shifts_one_open on field.work_shifts (employee_id) where status = 'open';
create index idx_work_shifts_employee_day on field.work_shifts (employee_id, business_date);
create index idx_work_shifts_open on field.work_shifts (window_start) where status = 'open';
create index idx_work_shifts_started on field.work_shifts (started_at);
create trigger trg_work_shifts_updated before update on field.work_shifts
  for each row execute function core.set_updated_at();

-- Raw location points, idempotent by the device's point id. Append-only; deleted by retention.
create table field.location_pings (
  id            uuid primary key,                       -- client-generated point id
  shift_id      uuid not null references field.work_shifts(id),
  employee_id   uuid not null references core.employees(id),
  latitude      numeric(9,6) not null check (latitude between -90 and 90),
  longitude     numeric(9,6) not null check (longitude between -180 and 180),
  accuracy_m    numeric(8,1) check (accuracy_m >= 0),
  captured_at   timestamptz not null,                   -- device clock
  received_at   timestamptz not null default now(),     -- server clock (retention basis)
  source        text not null default 'pwa' check (source in ('pwa','native')),
  anomaly_flags text[] not null default '{}'            -- low_accuracy, impossible_travel, duplicate_fix, clock_skew
);
create index idx_location_pings_employee_time on field.location_pings (employee_id, captured_at);
create index idx_location_pings_shift_time on field.location_pings (shift_id, captured_at);
create index idx_location_pings_received on field.location_pings (received_at);
create trigger trg_location_pings_append_only before update on field.location_pings
  for each row execute function core.forbid_mutation();

-- Daily facts kept after the raw points are purged (D-14: "daily summaries are kept").
create table field.tracking_day_summaries (
  employee_id       uuid not null references core.employees(id),
  business_date     date not null,
  shift_count       int not null default 0,
  shift_seconds     int not null default 0,
  visit_count       int not null default 0,
  visit_seconds     int not null default 0,
  idle_stop_count   int not null default 0,
  idle_stop_seconds int not null default 0,
  gap_count         int not null default 0,
  gap_seconds       int not null default 0,
  distance_m        numeric(12,1) not null default 0,
  ping_count        int not null default 0,
  flags             text[] not null default '{}',
  computed_at       timestamptz not null default now(),
  primary key (employee_id, business_date)
);

-- History of the notice texts and acknowledgements matters (legal record).
create trigger trg_audit after insert or update or delete on field.tracking_notices
  for each row execute function audit.log_change();
create trigger trg_audit after insert or update or delete on field.tracking_notice_acks
  for each row execute function audit.log_change();

-- ---------------------------------------------------------------------------
-- 4. The first notice (plain language; LEGAL REVIEW D-03 REQUIRED before real use)
-- ---------------------------------------------------------------------------
insert into field.tracking_notices (version, body_ar, body_en, is_current) values (
  '2026-10-30.1',
  $ar$ما الذي نجمعه: موقع الجهاز (خط العرض وخط الطول) ودقته ووقت تسجيله، مرة كل 5 دقائق تقريبًا، من جهاز الشركة فقط.

متى: فقط بين ضغطك على «ابدأ يومي» و«أنهِ يومي». لا يُجمع أي موقع قبل بدء اليوم أو بعد إنهائه، والخادم يرفض أي نقطة خارج يوم العمل. إذا نسيت إنهاء اليوم يُغلق تلقائيًا بعد 10 ساعات.

حدود التطبيق الحالي: يعمل التتبع فقط والتطبيق مفتوح والشاشة مضاءة. يظهر مؤشر «التتبع يعمل» في أعلى الشاشة طوال يوم العمل.

من يرى البيانات: أنت ترى بياناتك. مديرك المباشر ومدير المبيعات يرون بيانات فريقهم فقط. المالك يرى الجميع.

مدة الحفظ: تُحذف نقاط الموقع التفصيلية بعد 90 يومًا. يُحتفظ بملخص يومي (مدة اليوم، عدد الزيارات ومدتها، المسافة، فترات التوقف والانقطاع).

الغرض: متابعة العمل الميداني خلال ساعات العمل فقط: الزيارات ومدتها، والتنقل، وفترات التوقف الطويلة بعيدًا عن العملاء. هذه مؤشرات يراجعها المدير معك، وليست عقوبات تلقائية.

إذا كان لديك سؤال أو اعتراض فتواصل مع مديرك أو مع الإدارة قبل بدء يومك.$ar$,
  $en$What we collect: the device location (latitude and longitude), its accuracy and the time, about once every 5 minutes, from the company device only.

When: only between your tap on "Start my day" and "End my day". Nothing is collected before you start or after you end, and the server refuses any point outside your working day. If you forget to end it, the day is closed automatically after 10 hours.

Current limit of the app: tracking works only while the app is open with the screen on. A "Tracking on" indicator stays at the top of the screen for the whole working day.

Who sees it: you see your own data. Your manager and the sales director see their own team only. The owner sees everyone.

How long we keep it: detailed location points are deleted after 90 days. A daily summary is kept (time on shift, number and length of visits, distance, long stops and gaps).

Purpose: to follow field work during working hours only: visits and their length, travel, and long stops away from customers. These are signals your manager reviews with you, never automatic penalties.

If you have a question or an objection, talk to your manager or to the management before you start your day.$en$,
  true)
on conflict (version) do nothing;

-- ---------------------------------------------------------------------------
-- 5. Internal helpers (not client-callable; revoked at the end)
-- ---------------------------------------------------------------------------
-- Numeric setting with a default (settings are jsonb; a missing or malformed key falls back).
create or replace function field.tracking_num(p_key text, p_default numeric) returns numeric
language plpgsql stable set search_path = '' as $$
declare v numeric;
begin
  select (s.value #>> '{}')::numeric into v from core.system_settings s where s.key = p_key;
  return coalesce(v, p_default);
exception when others then
  return p_default;
end $$;

create or replace function field.try_cast_timestamptz(p_text text) returns timestamptz
language plpgsql stable set search_path = '' as $$
begin
  if p_text is null or btrim(p_text) = '' then return null; end if;
  return p_text::timestamptz;
exception when others then
  return null;
end $$;

-- A device fix: both coordinates or neither; ranges; non-negative accuracy.
create or replace function field.tracking_check_fix(p_lat numeric, p_lng numeric, p_accuracy_m numeric) returns void
language plpgsql immutable set search_path = '' as $$
begin
  if (p_lat is null) <> (p_lng is null) then
    raise exception 'VALIDATION: latitude and longitude go together' using errcode = 'P0001';
  end if;
  if p_lat is not null and (p_lat not between -90 and 90 or p_lng not between -180 and 180) then
    raise exception 'VALIDATION: coordinates out of range' using errcode = 'P0001';
  end if;
  if p_accuracy_m is not null and (p_accuracy_m < 0 or p_accuracy_m > 9999999) then
    raise exception 'VALIDATION: accuracy out of range' using errcode = 'P0001';
  end if;
end $$;

-- Serializes one employee's shift and point writes (start/end/batches never interleave).
create or replace function field.tracking_lock(p_employee_id uuid) returns void
language sql set search_path = '' as $$
  select pg_advisory_xact_lock(hashtextextended('field.work_shifts:' || p_employee_id::text, 0))
$$;

-- Closes shifts open longer than tracking.max_shift_hours (all, or one employee's).
-- window_end is capped at window_start + max, so the extra hours never count as shift time.
create or replace function field.tracking_close_stale(p_employee_id uuid default null) returns int
language plpgsql set search_path = '' as $$
declare
  v_max interval := field.tracking_num('tracking.max_shift_hours', 10) * interval '1 hour';
  r record; v_n int := 0;
begin
  for r in select s.id, s.employee_id, s.window_start, e.user_id
           from field.work_shifts s join core.employees e on e.id = s.employee_id
           where s.status = 'open' and s.window_start < now() - v_max
             and (p_employee_id is null or s.employee_id = p_employee_id)
           order by s.window_start
           for update of s skip locked
  loop
    update field.work_shifts set status = 'auto_closed', ended_at = now(), window_end = r.window_start + v_max
    where id = r.id;
    insert into integration.outbox (event_type, aggregate_type, aggregate_id, payload)
    values ('tracking.shift_auto_closed', 'field.work_shift', r.id,
            jsonb_build_object('shift_id', r.id, 'employee_id', r.employee_id,
                               'window_start', r.window_start, 'window_end', r.window_start + v_max));
    perform notify.send_in_app(r.user_id, 'tracking.shift_auto_closed', 'Your working day was closed automatically',
      'It stayed open longer than the maximum shift length. Tracking has stopped.', '/today',
      jsonb_build_object('shift_id', r.id));
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

-- Employees whose tracking the caller may read: self (D-14: the rep sees their own), plus
-- field.tracking.read at own/team scope, plus members of the caller's territories at territory
-- scope. Global ('all') is checked separately with authz.has_global. SECURITY DEFINER so the RLS
-- policies below can use it without policy-to-policy recursion (same as assigned_customer_ids).
create or replace function authz.tracking_employee_ids() returns uuid[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(distinct x.id), '{}') from (
    select authz.current_employee_id() as id where authz.is_active_user()
    union select unnest(authz.employee_ids('field.tracking.read'))
    union select et.employee_id from core.employee_territories et
     where et.valid_to is null and et.territory_id = any(authz.territory_ids('field.tracking.read'))
  ) x where x.id is not null
$$;

-- One detected stop: overlaps a visit of the employee? within the radius of a customer location?
create or replace function field.tracking_stop(p_employee_id uuid, p_lat numeric, p_lng numeric,
                                               p_start timestamptz, p_end timestamptz, p_points int, p_radius numeric)
returns jsonb language plpgsql stable set search_path = '' as $$
declare v_in_visit boolean; v_near boolean; v_box numeric := greatest(p_radius, 1) / 111000.0 * 2;
begin
  select exists (select 1 from field.visits v
                 where v.employee_id = p_employee_id and v.check_in_at is not null
                   and v.check_in_at < p_end and coalesce(v.check_out_at, now()) > p_start)
    into v_in_visit;
  select exists (select 1 from crm.customers c
                 where c.archived_at is null and c.latitude is not null
                   and c.latitude between p_lat - v_box and p_lat + v_box
                   and c.longitude between p_lng - v_box * 1.3 and p_lng + v_box * 1.3
                   and core.distance_m(p_lat, p_lng, c.latitude, c.longitude) <= p_radius)
    into v_near;
  return jsonb_build_object(
    'start_at', p_start, 'end_at', p_end, 'seconds', floor(extract(epoch from (p_end - p_start)))::int,
    'lat', round(p_lat, 6), 'lng', round(p_lng, 6), 'points', p_points,
    'in_visit', v_in_visit, 'near_customer', v_near, 'flagged', not (v_in_visit or v_near));
end $$;

-- The derived day for one employee and one Cairo calendar day (shifts whose window starts that
-- day). Stops, gaps and distance are computed per shift from the ordered points:
--   stop     consecutive usable points within tracking.stop_radius_m of the running centroid,
--            lasting ≥ tracking.stop_min_minutes; flagged when it overlaps no visit and is not
--            within the radius of a customer location
--   gap      ≥ tracking.gap_min_minutes without any point inside the shift window
--            (from the start, between points, and up to the end / now)
--   distance haversine sum over usable points
-- Usable = not low_accuracy, impossible_travel or duplicate_fix.
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
  s record; p record; v record; v_stop jsonb;
  v_shifts jsonb := '[]'; v_points jsonb := '[]'; v_stops jsonb := '[]'; v_gaps jsonb := '[]'; v_visits jsonb := '[]';
  v_shift_n int := 0; v_shift_secs int := 0; v_visit_n int := 0; v_visit_secs int := 0;
  v_idle_n int := 0; v_idle_secs int := 0; v_gap_n int := 0; v_gap_secs int := 0;
  v_ping_n int := 0; v_dist numeric := 0; v_last_ping timestamptz; v_on_shift boolean := false;
  v_flags text[] := '{}'; v_first_start timestamptz; v_last_end timestamptz;
  v_end timestamptz; v_prev_any timestamptz; v_prev_lat numeric; v_prev_lng numeric;
  c_n int; c_lat numeric; c_lng numeric; c_start timestamptz; c_end timestamptz;
  v_usable boolean; v_secs int;
begin
  for s in select * from field.work_shifts ws
           where ws.employee_id = p_employee_id and ws.business_date = p_day
           order by ws.window_start
  loop
    v_end := coalesce(s.window_end, least(v_now, s.window_start + v_max));
    v_shift_n := v_shift_n + 1;
    v_shift_secs := v_shift_secs + floor(extract(epoch from (v_end - s.window_start)))::int;
    v_first_start := coalesce(v_first_start, s.window_start);
    v_last_end := greatest(v_last_end, v_end);
    if s.status = 'open' and v_now < s.window_start + v_max then v_on_shift := true; end if;
    if s.status = 'open' and v_now >= s.window_start + v_max then v_flags := v_flags || 'overdue_shift'::text; end if;
    if s.status = 'auto_closed' then v_flags := v_flags || 'auto_closed'::text; end if;
    if p_detail then
      v_shifts := v_shifts || jsonb_build_object(
        'id', s.id, 'status', s.status, 'start_at', s.window_start, 'end_at', v_end,
        'open', s.status = 'open', 'seconds', floor(extract(epoch from (v_end - s.window_start)))::int,
        'started_at', s.started_at, 'ended_at', s.ended_at,
        'start_lat', s.start_latitude, 'start_lng', s.start_longitude, 'start_accuracy_m', s.start_accuracy_m,
        'end_lat', s.end_latitude, 'end_lng', s.end_longitude, 'end_accuracy_m', s.end_accuracy_m,
        'anomaly_flags', to_jsonb(s.anomaly_flags));
    end if;

    v_prev_any := s.window_start; v_prev_lat := null; v_prev_lng := null; c_n := 0;
    for p in select * from field.location_pings lp where lp.shift_id = s.id order by lp.captured_at, lp.id loop
      v_ping_n := v_ping_n + 1;
      v_last_ping := greatest(v_last_ping, p.captured_at);
      if p.anomaly_flags && array['impossible_travel','duplicate_fix','clock_skew'] then
        v_flags := v_flags || 'anomaly'::text;
      end if;
      -- gap since the previous point (or the start of the shift)
      if p.captured_at - v_prev_any >= v_gap_min then
        v_secs := floor(extract(epoch from (p.captured_at - v_prev_any)))::int;
        v_gap_n := v_gap_n + 1; v_gap_secs := v_gap_secs + v_secs;
        if p_detail then
          v_gaps := v_gaps || jsonb_build_object('start_at', v_prev_any, 'end_at', p.captured_at, 'seconds', v_secs,
                                                 'ongoing', false, 'shift_id', s.id);
        end if;
      end if;
      v_prev_any := greatest(v_prev_any, p.captured_at);

      v_usable := not (p.anomaly_flags && array['low_accuracy','impossible_travel','duplicate_fix']);
      if v_usable then
        if v_prev_lat is not null then
          v_dist := v_dist + core.distance_m(v_prev_lat, v_prev_lng, p.latitude, p.longitude);
        end if;
        v_prev_lat := p.latitude; v_prev_lng := p.longitude;
        -- stop clustering on the running centroid
        if c_n > 0 and core.distance_m(c_lat, c_lng, p.latitude, p.longitude) <= v_radius then
          c_lat := (c_lat * c_n + p.latitude) / (c_n + 1);
          c_lng := (c_lng * c_n + p.longitude) / (c_n + 1);
          c_n := c_n + 1; c_end := p.captured_at;
        else
          if c_n > 0 and c_end - c_start >= v_stop_min then
            v_stop := field.tracking_stop(p_employee_id, c_lat, c_lng, c_start, c_end, c_n, v_radius);
            if (v_stop ->> 'flagged')::boolean then
              v_idle_n := v_idle_n + 1; v_idle_secs := v_idle_secs + (v_stop ->> 'seconds')::int;
            end if;
            if p_detail then v_stops := v_stops || (v_stop || jsonb_build_object('shift_id', s.id)); end if;
          end if;
          c_n := 1; c_lat := p.latitude; c_lng := p.longitude; c_start := p.captured_at; c_end := p.captured_at;
        end if;
      end if;

      if p_detail then
        v_points := v_points || jsonb_build_object(
          'id', p.id, 'shift_id', s.id, 'captured_at', p.captured_at, 'received_at', p.received_at,
          'lat', p.latitude, 'lng', p.longitude, 'accuracy_m', p.accuracy_m, 'source', p.source,
          'anomaly_flags', to_jsonb(p.anomaly_flags), 'usable', v_usable);
      end if;
    end loop;

    -- the last cluster of the shift
    if c_n > 0 and c_end - c_start >= v_stop_min then
      v_stop := field.tracking_stop(p_employee_id, c_lat, c_lng, c_start, c_end, c_n, v_radius);
      if (v_stop ->> 'flagged')::boolean then
        v_idle_n := v_idle_n + 1; v_idle_secs := v_idle_secs + (v_stop ->> 'seconds')::int;
      end if;
      if p_detail then v_stops := v_stops || (v_stop || jsonb_build_object('shift_id', s.id)); end if;
    end if;
    -- trailing gap up to the end of the shift (or now, while it is open)
    if v_end - v_prev_any >= v_gap_min then
      v_secs := floor(extract(epoch from (v_end - v_prev_any)))::int;
      v_gap_n := v_gap_n + 1; v_gap_secs := v_gap_secs + v_secs;
      if p_detail then
        v_gaps := v_gaps || jsonb_build_object('start_at', v_prev_any, 'end_at', v_end, 'seconds', v_secs,
                                               'ongoing', s.status = 'open' and v_end >= v_now - interval '1 second',
                                               'shift_id', s.id);
      end if;
    end if;
  end loop;

  -- Visits of the day (field.visits check-in/out), whether or not a shift was open.
  for v in select fv.id, fv.customer_id, fv.status, fv.verification_status, fv.check_in_at, fv.check_out_at,
                  c.display_name
           from field.visits fv left join crm.customers c on c.id = fv.customer_id
           where fv.employee_id = p_employee_id and fv.check_in_at >= v_day_start and fv.check_in_at < v_day_end
           order by fv.check_in_at
  loop
    v_secs := greatest(floor(extract(epoch from (coalesce(v.check_out_at, v_now) - v.check_in_at)))::int, 0);
    v_visit_n := v_visit_n + 1; v_visit_secs := v_visit_secs + v_secs;
    if p_detail then
      v_visits := v_visits || jsonb_build_object(
        'id', v.id, 'customer_id', v.customer_id, 'customer_name', case when p_visit_names then v.display_name end,
        'status', v.status, 'verification_status', v.verification_status,
        'start_at', v.check_in_at, 'end_at', v.check_out_at, 'seconds', v_secs, 'open', v.check_out_at is null);
    end if;
  end loop;

  if v_idle_n > 0 then v_flags := v_flags || 'idle_stop'::text; end if;
  if v_gap_n > 0 then v_flags := v_flags || 'gap'::text; end if;

  return jsonb_build_object(
      'employee_id', p_employee_id, 'day', p_day, 'day_start', v_day_start, 'day_end', v_day_end,
      'on_shift', v_on_shift, 'shift_count', v_shift_n, 'shift_seconds', v_shift_secs,
      'first_start_at', v_first_start, 'last_end_at', v_last_end,
      'visit_count', v_visit_n, 'visit_seconds', v_visit_secs,
      'idle_stop_count', v_idle_n, 'idle_stop_seconds', v_idle_secs,
      'gap_count', v_gap_n, 'gap_seconds', v_gap_secs,
      'distance_m', round(v_dist, 1), 'ping_count', v_ping_n, 'last_ping_at', v_last_ping,
      'flags', to_jsonb(array(select distinct f from unnest(v_flags) f order by 1)))
    || case when p_detail then jsonb_build_object('shifts', v_shifts, 'visits', v_visits, 'stops', v_stops,
                                                  'gaps', v_gaps, 'points', v_points)
            else '{}'::jsonb end;
end $$;

-- ---------------------------------------------------------------------------
-- 6. Row level security (deny by default; the caller's own rows + field.tracking.read scope)
-- ---------------------------------------------------------------------------
alter table field.tracking_notices enable row level security;
alter table field.tracking_notice_acks enable row level security;
alter table field.work_shifts enable row level security;
alter table field.location_pings enable row level security;
alter table field.tracking_day_summaries enable row level security;
grant select on field.tracking_notices, field.tracking_notice_acks, field.work_shifts,
                field.location_pings, field.tracking_day_summaries to authenticated;

create policy tracking_notices_select on field.tracking_notices for select to authenticated
  using ((select authz.is_active_user()));
create policy tracking_notice_acks_select on field.tracking_notice_acks for select to authenticated using (
  (select authz.has_global('field.tracking.read'))
  or employee_id = any((select authz.tracking_employee_ids())::uuid[]));
create policy work_shifts_select on field.work_shifts for select to authenticated using (
  (select authz.has_global('field.tracking.read'))
  or employee_id = any((select authz.tracking_employee_ids())::uuid[]));
create policy location_pings_select on field.location_pings for select to authenticated using (
  (select authz.has_global('field.tracking.read'))
  or employee_id = any((select authz.tracking_employee_ids())::uuid[]));
create policy tracking_day_summaries_select on field.tracking_day_summaries for select to authenticated using (
  (select authz.has_global('field.tracking.read'))
  or employee_id = any((select authz.tracking_employee_ids())::uuid[]));

-- ---------------------------------------------------------------------------
-- 7. Commands
-- ---------------------------------------------------------------------------
create or replace function api.acknowledge_tracking_notice(p_version text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_emp uuid := authz.current_employee_id(); v_cur text; v_at timestamptz;
begin
  perform authz.require('field.shift.start');
  if v_emp is null then raise exception 'NO_EMPLOYEE_PROFILE' using errcode = '42501'; end if;
  select version into v_cur from field.tracking_notices where is_current;
  if v_cur is null then raise exception 'NOT_FOUND: no tracking notice is published' using errcode = 'P0002'; end if;
  if p_version is distinct from v_cur then
    raise exception 'NOTICE_OUTDATED: version % is not the current notice (%)', coalesce(p_version, '(none)'), v_cur
      using errcode = 'P0001';
  end if;

  insert into field.tracking_notice_acks (employee_id, user_id, notice_version)
  values (v_emp, auth.uid(), v_cur)
  on conflict (employee_id, notice_version) do nothing
  returning acknowledged_at into v_at;
  if v_at is null then
    select acknowledged_at into v_at from field.tracking_notice_acks where employee_id = v_emp and notice_version = v_cur;
    return jsonb_build_object('version', v_cur, 'acknowledged_at', v_at, 'replayed', true);
  end if;

  perform authz.log_security_event('tracking_notice_acknowledged', 'info',
    jsonb_build_object('employee_id', v_emp, 'version', v_cur));
  return jsonb_build_object('version', v_cur, 'acknowledged_at', v_at, 'replayed', false);
end $$;

create or replace function api.start_shift(p_client_ref uuid, p_lat numeric, p_lng numeric, p_accuracy_m numeric,
                                           p_captured_at timestamptz)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_emp uuid := authz.current_employee_id();
  v_s field.work_shifts%rowtype; v_cur text; v_ws timestamptz; v_flags text[] := '{}'; v_id uuid;
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

-- p_shift_ref (optional): the client_ref the device used to start the shift it is ending.
create or replace function api.end_shift(p_client_ref uuid, p_lat numeric, p_lng numeric, p_accuracy_m numeric,
                                         p_captured_at timestamptz, p_shift_ref uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_emp uuid := authz.current_employee_id();
  v_s field.work_shifts%rowtype; v_we timestamptz; v_flags text[];
  v_tol interval := field.tracking_num('tracking.ping_tolerance_s', 120) * interval '1 second';
  v_max interval := field.tracking_num('tracking.max_shift_hours', 10) * interval '1 hour';
begin
  perform authz.require('field.shift.start');
  if v_emp is null then raise exception 'NO_EMPLOYEE_PROFILE' using errcode = '42501'; end if;
  if p_client_ref is null then raise exception 'VALIDATION: client_ref is required' using errcode = 'P0001'; end if;
  perform field.tracking_lock(v_emp);

  select * into v_s from field.work_shifts where end_client_ref = p_client_ref;
  if found then
    if v_s.employee_id <> v_emp then
      raise exception 'CONFLICT: this client_ref was used by someone else' using errcode = 'P0001';
    end if;
    return jsonb_build_object('shift_id', v_s.id, 'status', v_s.status, 'window_start', v_s.window_start,
                              'window_end', v_s.window_end,
                              'shift_seconds', floor(extract(epoch from (v_s.window_end - v_s.window_start)))::int,
                              'replayed', true);
  end if;

  if p_captured_at is null then raise exception 'VALIDATION: captured_at is required' using errcode = 'P0001'; end if;
  perform field.tracking_check_fix(p_lat, p_lng, p_accuracy_m);

  if p_shift_ref is not null then
    select * into v_s from field.work_shifts where client_ref = p_shift_ref and employee_id = v_emp for update;
    if found and v_s.status <> 'open' then
      raise exception 'INVALID_STATE: shift is already %', v_s.status using errcode = 'P0001';
    end if;
  else
    select * into v_s from field.work_shifts where employee_id = v_emp and status = 'open' for update;
  end if;
  if v_s.id is null then raise exception 'NO_OPEN_SHIFT: no shift is open' using errcode = 'P0001'; end if;

  v_flags := v_s.anomaly_flags;
  if p_captured_at > now() + v_tol then v_flags := v_flags || 'clock_skew'::text; end if;
  if p_lat is null then v_flags := v_flags || 'no_device_location_end'::text; end if;
  v_we := greatest(v_s.window_start, least(now(), p_captured_at, v_s.window_start + v_max));

  update field.work_shifts
     set status = 'closed', ended_at = now(), end_captured_at = p_captured_at, end_client_ref = p_client_ref,
         end_latitude = p_lat, end_longitude = p_lng, end_accuracy_m = p_accuracy_m, window_end = v_we,
         anomaly_flags = array(select distinct f from unnest(v_flags) f order by 1)
   where id = v_s.id;

  insert into integration.outbox (event_type, aggregate_type, aggregate_id, payload)
  values ('tracking.shift_ended', 'field.work_shift', v_s.id,
          jsonb_build_object('shift_id', v_s.id, 'employee_id', v_emp, 'window_start', v_s.window_start, 'window_end', v_we));

  return jsonb_build_object('shift_id', v_s.id, 'status', 'closed', 'window_start', v_s.window_start, 'window_end', v_we,
                            'shift_seconds', floor(extract(epoch from (v_we - v_s.window_start)))::int, 'replayed', false);
end $$;

-- A batch of points: [{ id, lat, lng, accuracy_m, captured_at, source? }]. Never fails for one bad
-- point: each point is accepted, a duplicate (same id, already stored: idempotent replay) or
-- rejected with a reason (invalid, conflict, outside_shift). Rejected points are not stored.
create or replace function api.record_location_pings(p_pings jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_emp uuid := authz.current_employee_id();
  v_tol interval := field.tracking_num('tracking.ping_tolerance_s', 120) * interval '1 second';
  v_max interval := field.tracking_num('tracking.max_shift_hours', 10) * interval '1 hour';
  v_max_acc numeric := field.tracking_num('tracking.max_accuracy_m', 100);
  v_max_kmh numeric := field.tracking_num('tracking.max_speed_kmh', 150);
  v_limit int := field.tracking_num('tracking.max_batch', 500)::int;
  r record; v_owner uuid; v_shift uuid; v_prev record; v_flags text[];
  v_accepted int := 0; v_dup int := 0; v_rejected jsonb := '[]';
begin
  perform authz.require('field.shift.start');
  if v_emp is null then raise exception 'NO_EMPLOYEE_PROFILE' using errcode = '42501'; end if;
  if p_pings is null or jsonb_typeof(p_pings) <> 'array' then
    raise exception 'VALIDATION: pings must be a JSON array' using errcode = 'P0001';
  end if;
  if jsonb_array_length(p_pings) > v_limit then
    raise exception 'VALIDATION: at most % points per upload', v_limit using errcode = 'P0001';
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
       or r.source not in ('pwa','native') then
      v_rejected := v_rejected || jsonb_build_object('id', r.raw_id, 'reason', 'invalid');
      continue;
    end if;

    select employee_id into v_owner from field.location_pings where id = r.id;
    if found then
      if v_owner = v_emp then v_dup := v_dup + 1;
      else v_rejected := v_rejected || jsonb_build_object('id', r.raw_id, 'reason', 'conflict');
      end if;
      continue;
    end if;

    -- The shift whose window (± tolerance) contains the point. Open shifts end at now (capped at max length).
    select ws.id into v_shift from field.work_shifts ws
    where ws.employee_id = v_emp
      and r.captured_at >= ws.window_start - v_tol
      and r.captured_at <= coalesce(ws.window_end, least(now(), ws.window_start + v_max)) + v_tol
    order by ws.window_start desc limit 1;
    if v_shift is null then
      v_rejected := v_rejected || jsonb_build_object('id', r.raw_id, 'reason', 'outside_shift');
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
    v_accepted := v_accepted + 1;
  end loop;

  return jsonb_build_object('accepted', v_accepted, 'duplicates', v_dup, 'rejected', v_rejected,
                            'replayed', v_accepted = 0 and v_dup > 0 and jsonb_array_length(v_rejected) = 0);
end $$;

-- ---------------------------------------------------------------------------
-- 8. Reads
-- ---------------------------------------------------------------------------
-- Everything the shift card needs, for the caller only.
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
  select coalesce(sum(floor(extract(epoch from (coalesce(ws.window_end, least(now(), ws.window_start + v_max)) - ws.window_start)))), 0)::int
    into v_today_secs from field.work_shifts ws where ws.employee_id = v_emp and ws.business_date = v_today;

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

-- One rep, one Cairo day: shifts, visits, stops, gaps, distance and points. The rep may read
-- their own; anyone else needs field.tracking.read covering that employee (else 42501).
create or replace function api.tracking_day(p_employee_id uuid, p_day date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_me uuid := authz.current_employee_id(); v_e core.employees%rowtype; v_names boolean;
  v_retention int := field.tracking_num('tracking.retention_days', 90)::int; v_summary jsonb;
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

  return field.tracking_compute_day(p_employee_id, p_day, true, v_names)
      || jsonb_build_object(
           'employee', jsonb_build_object('id', v_e.id, 'employee_no', v_e.employee_no,
                                          'full_name_en', v_e.full_name_en, 'full_name_ar', v_e.full_name_ar),
           'raw_purged', p_day < core.business_date() - v_retention,
           'stored_summary', v_summary);
end $$;

-- Managers: one row per rep in scope for one Cairo day (default today). Lists reps who can be
-- tracked (hold field.shift.start through a role; the caller only on a day they had a shift)
-- and anyone with a shift that day. Uses the
-- stored daily summary once the raw points are purged.
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
  v_retention int := field.tracking_num('tracking.retention_days', 90)::int;
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
    if s.employee_id is not null and v_day < core.business_date() - v_retention then
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

-- Stored daily summaries (kept after the raw points are purged). RLS decides the rows.
create or replace view api.v_tracking_day_summaries with (security_invoker = true) as
  select s.employee_id, emp.full_name_en as employee_name_en, emp.full_name_ar as employee_name_ar,
         s.business_date, s.shift_count, s.shift_seconds, s.visit_count, s.visit_seconds,
         s.idle_stop_count, s.idle_stop_seconds, s.gap_count, s.gap_seconds, s.distance_m, s.ping_count,
         s.flags, s.computed_at
  from field.tracking_day_summaries s
  left join lateral crm.employee_display(s.employee_id) emp on true;
grant select on api.v_tracking_day_summaries to authenticated;
revoke all on api.v_tracking_day_summaries from anon;

-- ---------------------------------------------------------------------------
-- 9. Service jobs (service_role only; called by /api/cron/tracking)
-- ---------------------------------------------------------------------------
create or replace function service.tracking_auto_close() returns int
language plpgsql security definer set search_path = '' as $$
begin
  return field.tracking_close_stale(null);
end $$;

-- Retention: keeps a daily summary for every day that loses raw points, deletes points received
-- more than tracking.retention_days ago, clears start/end coordinates of shifts that old, and logs
-- the purge as a security event (like field.purge_old_location_events).
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
        where lp.received_at < v_cut) d
  cross join lateral field.tracking_compute_day(d.employee_id, d.business_date, false, false) j
  on conflict (employee_id, business_date) do nothing;
  get diagnostics v_sum = row_count;

  delete from field.location_pings where received_at < v_cut;
  get diagnostics v_del = row_count;

  update field.work_shifts
     set start_latitude = null, start_longitude = null, start_accuracy_m = null,
         end_latitude = null, end_longitude = null, end_accuracy_m = null
   where started_at < v_cut and status <> 'open'
     and (start_latitude is not null or end_latitude is not null);
  get diagnostics v_clr = row_count;

  insert into audit.security_events (user_id, event_type, severity, details)
  values (auth.uid(), 'retention_purge', 'info',
          jsonb_build_object('table', 'field.location_pings', 'deleted', v_del, 'summarized_days', v_sum,
                             'shifts_cleared', v_clr, 'retention_days', v_days));
  return jsonb_build_object('deleted', v_del, 'summarized_days', v_sum, 'shifts_cleared', v_clr, 'retention_days', v_days);
end $$;

-- ---------------------------------------------------------------------------
-- 10. Privileges
-- ---------------------------------------------------------------------------
revoke execute on function field.tracking_num(text, numeric) from public, anon, authenticated;
revoke execute on function field.try_cast_timestamptz(text) from public, anon, authenticated;
revoke execute on function field.tracking_check_fix(numeric, numeric, numeric) from public, anon, authenticated;
revoke execute on function field.tracking_lock(uuid) from public, anon, authenticated;
revoke execute on function field.tracking_close_stale(uuid) from public, anon, authenticated;
revoke execute on function field.tracking_stop(uuid, numeric, numeric, timestamptz, timestamptz, int, numeric) from public, anon, authenticated;
revoke execute on function field.tracking_compute_day(uuid, date, boolean, boolean) from public, anon, authenticated;
-- Needed by the RLS policies above (test 17: client-executable definer helpers must be).
revoke execute on function authz.tracking_employee_ids() from public, anon;
grant execute on function authz.tracking_employee_ids() to authenticated;

revoke all on all functions in schema service from public, anon, authenticated;
grant execute on all functions in schema service to service_role;

-- Explicit grants only: a blanket grant on schema api would re-open functions closed earlier
-- (api.post_inventory_adjustment, test 24).
do $$
declare f text;
begin
  foreach f in array array[
    'api.acknowledge_tracking_notice(text)',
    'api.start_shift(uuid, numeric, numeric, numeric, timestamptz)',
    'api.end_shift(uuid, numeric, numeric, numeric, timestamptz, uuid)',
    'api.record_location_pings(jsonb)',
    'api.my_tracking_status()',
    'api.tracking_day(uuid, date)',
    'api.tracking_team_day(date)']
  loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
