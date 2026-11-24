-- Honest OS migration: Phase P step 4, leads around each rep.
--
-- Discovery: when an admin saves or changes a rep's base point or lead radius
-- (api.set_employee_base_location, decision E), a discovery run is queued for that rep
-- (crm.lead_discovery_runs: queued → running → done | failed | not_configured | cancelled).
-- The server (daily cron /api/cron/leads, or the owner's "Run now") claims the run, asks
-- Google Places API (New) with the server key GOOGLE_MAPS_SERVER_KEY, and hands the result
-- back. Nothing here talks to Google: the database only plans the budget and records results.
--
-- Google's Places policy (docs/DECISIONS.md, 2026-11-24 "Phase P step 4"): the place ID may be
-- stored indefinitely; other Places content (name, address, phone, coordinates) may not. So a
-- lead stores ONLY: place_id, the assigned rep, HONEST's own status, first/last seen, the rep's
-- own notes, a planned date, and the distance from the rep's base that WE computed at
-- discovery time (refreshed by later runs; cleared after 30 days, see service.leads_daily).
-- The place coordinates passed to service.leads_finish_run are used for the 50 m customer
-- exclusion inside that call and are never written anywhere.
--
-- Exclusions: a place already linked to a customer (crm.customers.google_place_id, new,
-- nullable, unique) or within 50 m of a pinned live customer is not a lead.
--
-- Cost guard (owner-only settings): leads.daily_request_cap (Nearby + Text Search requests of
-- discovery runs per Cairo day, default 200) and leads.monthly_budget_usd (estimated spend of
-- runs plus live Place Details per Cairo month, default 20). A run that would start over
-- either cap is refused (it stays queued with the reason); a run gets a request budget that
-- fits both caps and stops (truncated) when it is used up.
--
-- First visit: api.convert_lead creates the CRM customer through api.create_customer (the
-- rep's own data: doctor, clinic, optional phone, specialty), moves it to stage 'prospect',
-- links the place_id, and marks the lead 'prospect'. The rep then checks in at the new
-- customer; that check-in fix becomes a location proposal through the step-3 flow.
--
-- Planning: a lead is not a customer yet, so api.plan_visits cannot plan it. api.plan_lead_visit
-- applies the same rules (field.visit.plan scope over the rep, no past date, at most a year
-- ahead, planning.daily_visit_cap) and api.plan_visits is restated so its daily cap also counts
-- planned leads (the only change to it).
--
-- Permissions (new): crm.lead.read, crm.lead.work, crm.lead.assign (docs/AUTHORIZATION.md).
-- Leads belong to an employee, so the scope is the employee scope (authz.employee_in_scope).
--
-- Additive only: three tables, one nullable column with a partial unique index, permissions,
-- settings, functions, triggers, views. Tests: supabase/tests/database/60_phase_p_leads.test.sql.

-- ---------------------------------------------------------------------------
-- 1. Permissions
-- ---------------------------------------------------------------------------
insert into authz.permissions (code, module, description, allowed_scopes, supports_limit, is_sensitive) values
  ('crm.lead.read', 'crm', 'See discovered clinic leads (Google place ids) of employees in scope', '{own,team,territory,all}', false, false),
  ('crm.lead.work', 'crm', 'Work leads: status, notes, plan, first visit (convert to a prospect)', '{own,team,territory,all}', false, false),
  ('crm.lead.assign', 'crm', 'Reassign leads between employees in scope', '{team,territory,all}', false, false)
on conflict (code) do nothing;

insert into authz.role_permissions (role_id, permission_code, scope, limit_value)
select r.id, v.perm, v.scope, null
from (values
  ('sales_rep', 'crm.lead.read', 'own'), ('sales_rep', 'crm.lead.work', 'own'),
  ('area_manager', 'crm.lead.read', 'team'), ('area_manager', 'crm.lead.work', 'team'), ('area_manager', 'crm.lead.assign', 'team'),
  ('sales_director', 'crm.lead.read', 'all'), ('sales_director', 'crm.lead.work', 'all'), ('sales_director', 'crm.lead.assign', 'all')
) v(role, perm, scope)
join authz.roles r on r.code = v.role
on conflict (role_id, permission_code) do nothing;

-- ---------------------------------------------------------------------------
-- 2. Customers: the Google place a customer came from (HONEST's own link; a place id may be
--    stored indefinitely). Set by api.convert_lead.
-- ---------------------------------------------------------------------------
alter table crm.customers add column if not exists google_place_id text;
alter table crm.customers add constraint customers_google_place_id_format
  check (google_place_id is null or (google_place_id ~ '^[A-Za-z0-9_-]+$' and length(google_place_id) between 10 and 300));
create unique index if not exists uq_customers_google_place_id on crm.customers (google_place_id)
  where google_place_id is not null;
comment on column crm.customers.google_place_id is
  'Phase P: Google place id of the clinic (from a converted lead). Only the id is stored (Places policy).';

-- ---------------------------------------------------------------------------
-- 3. Tables
-- ---------------------------------------------------------------------------
create table crm.lead_discovery_runs (
  id                 uuid primary key default gen_random_uuid(),
  employee_id        uuid not null references core.employees(id),
  trigger            text not null check (trigger in ('base_location', 'owner', 'refresh')),
  requested_by       uuid references auth.users(id),
  radius_km          numeric(5,2) not null check (radius_km between 0.5 and 50),
  status             text not null default 'queued'
                     check (status in ('queued', 'running', 'done', 'failed', 'not_configured', 'cancelled')),
  requested_at       timestamptz not null default now(),
  started_at         timestamptz,
  finished_at        timestamptz,
  reserved_requests  int not null default 0 check (reserved_requests >= 0),
  nearby_requests    int not null default 0 check (nearby_requests >= 0),
  text_requests      int not null default 0 check (text_requests >= 0),
  estimated_cost_usd numeric(10,4) not null default 0 check (estimated_cost_usd >= 0),
  places_found       int not null default 0 check (places_found >= 0),
  leads_new          int not null default 0 check (leads_new >= 0),
  leads_seen         int not null default 0 check (leads_seen >= 0),
  excluded_customers int not null default 0 check (excluded_customers >= 0),
  other_rep          int not null default 0 check (other_rep >= 0),
  outside_radius     int not null default 0 check (outside_radius >= 0),
  truncated          boolean not null default false,
  refusal            text check (refusal in ('daily_cap', 'monthly_budget')),
  refused_at         timestamptz,
  error_code         text check (error_code is null or error_code ~ '^[a-z0-9_]{1,60}$'),
  updated_at         timestamptz not null default now(),
  check ((status in ('done', 'failed', 'not_configured', 'cancelled')) = (finished_at is not null)),
  check (status not in ('running', 'done', 'failed') or started_at is not null),
  check ((refusal is null) = (refused_at is null))
);
comment on table crm.lead_discovery_runs is
  'Phase P: one Google Places discovery run for one rep (counts and cost only; no coordinates, no Places content).';
-- At most one waiting run per rep: a new request refreshes it.
create unique index uq_lead_runs_one_queued on crm.lead_discovery_runs (employee_id) where status = 'queued';
create index idx_lead_runs_employee_requested on crm.lead_discovery_runs (employee_id, requested_at desc);
create index idx_lead_runs_open on crm.lead_discovery_runs (status, requested_at) where status in ('queued', 'running');
create index idx_lead_runs_started on crm.lead_discovery_runs (started_at) where started_at is not null;
create index idx_lead_runs_requested_by on crm.lead_discovery_runs (requested_by);
create trigger trg_lead_runs_updated before update on crm.lead_discovery_runs
  for each row execute function core.set_updated_at();
create trigger trg_audit after insert or update or delete on crm.lead_discovery_runs
  for each row execute function audit.log_change();

create table crm.leads (
  id                   uuid primary key default gen_random_uuid(),
  place_id             text not null unique check (place_id ~ '^[A-Za-z0-9_-]+$' and length(place_id) between 10 and 300),
  employee_id          uuid not null references core.employees(id),
  status               text not null default 'new'
                       check (status in ('new', 'visited', 'prospect', 'customer', 'not_interested')),
  distance_m           numeric(8,1) check (distance_m >= 0),
  distance_computed_at timestamptz,
  first_seen_at        timestamptz not null default now(),
  first_seen_run_id    uuid references crm.lead_discovery_runs(id),
  last_seen_run_id     uuid references crm.lead_discovery_runs(id),
  last_seen_at         timestamptz,
  notes                text check (notes is null or length(notes) <= 2000),
  customer_id          uuid unique references crm.customers(id),
  planned_for          date,
  planned_by           uuid references auth.users(id),
  status_changed_at    timestamptz not null default now(),
  status_changed_by    uuid references auth.users(id),
  assigned_at          timestamptz not null default now(),
  assigned_by          uuid references auth.users(id),
  version              int not null default 1,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  check ((status in ('prospect', 'customer')) = (customer_id is not null)),
  check ((distance_m is null) = (distance_computed_at is null)),
  check (planned_for is null or status in ('new', 'visited')),
  check ((planned_for is null) = (planned_by is null))
);
comment on table crm.leads is
  'Phase P: a dental clinic found by Google Places near a rep''s base. Stores the place id and HONEST''s own data only (Places policy).';
comment on column crm.leads.distance_m is
  'Distance from the rep''s base computed by HONEST at discovery time (the place coordinates are not stored); cleared 30 days after it was computed.';
create index idx_leads_employee_status on crm.leads (employee_id, status);
create index idx_leads_employee_planned on crm.leads (employee_id, planned_for) where planned_for is not null;
create index idx_leads_first_seen_run on crm.leads (first_seen_run_id);
create index idx_leads_last_seen_run on crm.leads (last_seen_run_id);
create index idx_leads_planned_by on crm.leads (planned_by);
create index idx_leads_status_changed_by on crm.leads (status_changed_by);
create index idx_leads_assigned_by on crm.leads (assigned_by);
create trigger trg_leads_updated before update on crm.leads
  for each row execute function core.set_updated_at();
create trigger trg_audit after insert or update or delete on crm.leads
  for each row execute function audit.log_change();

-- Live Place Details calls (names and addresses shown to reps), counted for the monthly budget.
-- Counters only; no audit trigger (no business fact), like the tracking device status.
create table crm.lead_api_usage (
  business_date      date not null,
  user_id            uuid not null references auth.users(id),
  detail_requests    int not null default 0 check (detail_requests >= 0),
  estimated_cost_usd numeric(10,4) not null default 0 check (estimated_cost_usd >= 0),
  updated_at         timestamptz not null default now(),
  primary key (business_date, user_id)
);
create index idx_lead_api_usage_user on crm.lead_api_usage (user_id);

-- ---------------------------------------------------------------------------
-- 4. Settings (owner only) and the cost model
-- ---------------------------------------------------------------------------
insert into core.setting_definitions
  (key, group_code, value_type, min_value, max_value, allowed_values, default_value, unit, owner_only, is_editable,
   label_en, label_ar, description_en, description_ar, sort_order) values
  ('leads.daily_request_cap', 'field', 'integer', 0, 5000, null, '200', 'requests', true, true,
   'Lead discovery: Google requests per day', 'اكتشاف العملاء المحتملين: طلبات Google يوميًا',
   'Most Places Nearby and Text Search requests that discovery runs may make in one Cairo day. A run that would start over it waits. 0 stops discovery. Owner only.',
   'أقصى عدد من طلبات البحث في Google Places لعمليات الاكتشاف في يوم واحد بتوقيت القاهرة. أي عملية تتجاوزه تنتظر. القيمة 0 توقف الاكتشاف. للمالك فقط.', 80),
  ('leads.monthly_budget_usd', 'field', 'number', 0, 1000, null, '20', 'USD', true, true,
   'Lead discovery: monthly Google budget (USD)', 'اكتشاف العملاء المحتملين: ميزانية Google الشهرية (دولار)',
   'Estimated spend (list price, before Google''s free monthly usage) of discovery runs and of the clinic names shown to reps in one Cairo month. Over it, runs wait and names are not loaded. Owner only.',
   'الإنفاق التقديري (بسعر القائمة قبل الاستخدام المجاني الشهري من Google) لعمليات الاكتشاف وأسماء العيادات المعروضة للمندوبين في شهر واحد بتوقيت القاهرة. عند تجاوزه تنتظر العمليات ولا تُعرض الأسماء. للمالك فقط.', 81)
on conflict (key) do nothing;

insert into core.system_settings (key, value, description) values
  ('leads.daily_request_cap', '200', 'Phase P: Places requests per Cairo day for lead discovery runs'),
  ('leads.monthly_budget_usd', '20', 'Phase P: estimated Places spend per Cairo month (runs + details), USD')
on conflict (key) do nothing;

-- A numeric setting, or the default when it is missing or malformed.
create or replace function crm.lead_setting(p_key text, p_default numeric) returns numeric
language plpgsql stable security definer set search_path = '' as $$
declare v numeric;
begin
  select (s.value #>> '{}')::numeric into v from core.system_settings s where s.key = p_key;
  return case when v is null or v < 0 then p_default else v end;
exception when others then
  return p_default;
end $$;

-- Estimated price of one request, USD, at Google's list price for the field masks the app uses
-- (src/lib/places): Nearby Search Pro and Text Search Pro (places.id + places.location) and
-- Place Details Pro (id, displayName, formattedAddress, location, googleMapsUri). Google's free
-- monthly usage is ignored, so the estimate is an upper bound. Unverified against the live
-- price list (developers.google.com was not reachable from the build environment).
create or replace function crm.lead_unit_cost_usd(p_kind text) returns numeric
language sql immutable set search_path = '' as $$
  select case p_kind when 'nearby' then 0.032 when 'text' then 0.032 when 'details' then 0.017 end::numeric
$$;

-- Most requests one run may make, whatever the caps leave.
create or replace function crm.lead_run_request_limit() returns int
language sql immutable set search_path = '' as $$ select 400 $$;

-- Most Place Details one user may load in a Cairo day.
create or replace function crm.lead_user_daily_details_limit() returns int
language sql immutable set search_path = '' as $$ select 300 $$;

-- Usage of the current Cairo day and month. A running run counts its reserved budget.
create or replace function crm.lead_usage_now() returns jsonb
language sql stable security definer set search_path = '' as $$
  with b as (
    select core.business_date() as today, date_trunc('month', core.business_date())::date as month_start
  ), runs as (
    select r.*, (r.started_at at time zone 'Africa/Cairo')::date as day
    from crm.lead_discovery_runs r, b
    where r.started_at is not null and r.started_at >= (b.month_start::timestamp at time zone 'Africa/Cairo')
  )
  select jsonb_build_object(
    'today_requests', coalesce((select sum(case when r.status = 'running'
                                                then greatest(r.reserved_requests, r.nearby_requests + r.text_requests)
                                                else r.nearby_requests + r.text_requests end)
                                from runs r, b where r.day = b.today), 0),
    'month_run_cost_usd', coalesce((select sum(case when r.status = 'running'
                                                    then greatest(r.reserved_requests * crm.lead_unit_cost_usd('nearby'), r.estimated_cost_usd)
                                                    else r.estimated_cost_usd end) from runs r), 0),
    'month_detail_requests', coalesce((select sum(u.detail_requests) from crm.lead_api_usage u, b
                                       where u.business_date >= b.month_start), 0),
    'month_detail_cost_usd', coalesce((select sum(u.estimated_cost_usd) from crm.lead_api_usage u, b
                                       where u.business_date >= b.month_start), 0))
$$;

-- ---------------------------------------------------------------------------
-- 5. Scope helper for RLS (SECURITY DEFINER: reads employee territories the caller may not see)
-- ---------------------------------------------------------------------------
-- Employees whose leads the caller may see under p_perm, for a non-global grant: own/team
-- (authz.employee_ids) plus members of the caller's territory tree. Callers check has_global first.
create or replace function crm.lead_scope_employee_ids(p_perm text) returns uuid[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(distinct x.id), '{}') from (
    select unnest(authz.employee_ids(p_perm)) as id
    union
    select et.employee_id from core.employee_territories et
    where et.valid_to is null and et.territory_id = any(authz.territory_ids(p_perm))
  ) x
$$;

-- ---------------------------------------------------------------------------
-- 6. RLS: a rep sees their own leads and runs, a manager their team's. No direct writes.
-- ---------------------------------------------------------------------------
alter table crm.leads enable row level security;
alter table crm.lead_discovery_runs enable row level security;
alter table crm.lead_api_usage enable row level security;
grant select on crm.leads, crm.lead_discovery_runs, crm.lead_api_usage to authenticated;

create policy leads_select on crm.leads for select to authenticated using (
  (select authz.has_global('crm.lead.read'))
  or employee_id = any((select crm.lead_scope_employee_ids('crm.lead.read'))::uuid[])
);
create policy lead_runs_select on crm.lead_discovery_runs for select to authenticated using (
  (select authz.has_global('crm.lead.read'))
  or employee_id = any((select crm.lead_scope_employee_ids('crm.lead.read'))::uuid[])
);
create policy lead_api_usage_select on crm.lead_api_usage for select to authenticated using (
  (select authz.is_owner()) or user_id = (select auth.uid())
);

-- ---------------------------------------------------------------------------
-- 7. Queueing: a base point or radius change queues a run (any path that writes the columns;
--    the only command today is api.set_employee_base_location). Removing the base cancels it.
-- ---------------------------------------------------------------------------
create or replace function crm.lead_queue_run(p_employee_id uuid, p_trigger text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_radius numeric; v_id uuid;
begin
  select e.lead_radius_km into v_radius from core.employees e where e.id = p_employee_id;
  insert into crm.lead_discovery_runs (employee_id, trigger, requested_by, radius_km)
  values (p_employee_id, p_trigger, auth.uid(), coalesce(v_radius, 5))
  on conflict (employee_id) where status = 'queued' do update
     set trigger = excluded.trigger, requested_by = excluded.requested_by, radius_km = excluded.radius_km,
         requested_at = now(), refusal = null, refused_at = null
  returning id into v_id;
  return v_id;
end $$;

create or replace function crm.queue_lead_discovery_on_base() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.base_lat is null then
    update crm.lead_discovery_runs set status = 'cancelled', finished_at = now()
     where employee_id = new.id and status = 'queued';
  else
    perform crm.lead_queue_run(new.id, 'base_location');
  end if;
  return null;
end $$;

create trigger trg_employees_queue_lead_discovery
  after update of base_lat, base_lng, lead_radius_km on core.employees
  for each row when ((old.base_lat, old.base_lng, old.lead_radius_km) is distinct from (new.base_lat, new.base_lng, new.lead_radius_km))
  execute function crm.queue_lead_discovery_on_base();
create trigger trg_employees_queue_lead_discovery_insert
  after insert on core.employees
  for each row when (new.base_lat is not null)
  execute function crm.queue_lead_discovery_on_base();

-- A converted lead becomes 'customer' when its CRM customer becomes active (first order etc.).
create or replace function crm.lead_follow_customer_stage() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update crm.leads set status = 'customer', status_changed_at = now(), status_changed_by = auth.uid(),
                       version = version + 1
   where customer_id = new.id and status = 'prospect';
  return null;
end $$;

create trigger trg_customers_lead_stage after update of lifecycle_stage on crm.customers
  for each row when (new.lifecycle_stage = 'active' and old.lifecycle_stage is distinct from new.lifecycle_stage)
  execute function crm.lead_follow_customer_stage();

-- ---------------------------------------------------------------------------
-- 8. Internal: lock a lead and check the caller's scope over its employee.
-- ---------------------------------------------------------------------------
create or replace function crm.lead_for_update(p_lead_id uuid, p_perm text) returns crm.leads
language plpgsql security definer set search_path = '' as $$
declare v_l crm.leads%rowtype;
begin
  perform authz.require(p_perm);
  if p_lead_id is null then raise exception 'VALIDATION: lead is required' using errcode = 'P0001'; end if;
  select * into v_l from crm.leads where id = p_lead_id for update;
  if not found then raise exception 'NOT_FOUND: lead' using errcode = 'P0002'; end if;
  if not authz.employee_in_scope(p_perm, v_l.employee_id) then
    -- Same answer as a missing lead: no existence oracle outside scope.
    raise exception 'NOT_FOUND: lead' using errcode = 'P0002';
  end if;
  return v_l;
end $$;

-- ---------------------------------------------------------------------------
-- 9. Rep commands
-- ---------------------------------------------------------------------------
-- Status by hand: new ↔ visited, → not_interested, not_interested → new. 'prospect' comes only
-- from api.convert_lead and 'customer' only from the customer becoming active. Leaving 'new'
-- clears the plan (the visit is done or not wanted). Same status again: replayed.
create or replace function api.set_lead_status(p_lead_id uuid, p_status text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_l crm.leads%rowtype;
begin
  v_l := crm.lead_for_update(p_lead_id, 'crm.lead.work');
  if p_status is null or p_status not in ('new', 'visited', 'not_interested') then
    raise exception 'VALIDATION: status must be new, visited or not_interested' using errcode = 'P0001';
  end if;
  if v_l.status in ('prospect', 'customer') then
    raise exception 'INVALID_STATE: the lead is already a % in the CRM', v_l.status using errcode = 'P0001';
  end if;
  if v_l.status = p_status then
    return jsonb_build_object('lead_id', v_l.id, 'status', v_l.status, 'replayed', true);
  end if;
  update crm.leads
     set status = p_status, status_changed_at = now(), status_changed_by = auth.uid(),
         planned_for = case when p_status = 'new' then planned_for end,
         planned_by = case when p_status = 'new' then planned_by end,
         version = version + 1
   where id = v_l.id;
  perform crm._emit('crm.lead_status_changed', 'crm.lead', v_l.id, jsonb_build_object(
    'lead_id', v_l.id, 'employee_id', v_l.employee_id, 'from_status', v_l.status, 'to_status', p_status));
  return jsonb_build_object('lead_id', v_l.id, 'status', p_status, 'replayed', false);
end $$;

-- The rep's own notes (HONEST's data). Empty clears them.
create or replace function api.set_lead_notes(p_lead_id uuid, p_notes text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_l crm.leads%rowtype; v_notes text := nullif(btrim(p_notes), '');
begin
  v_l := crm.lead_for_update(p_lead_id, 'crm.lead.work');
  if v_notes is not null and (length(v_notes) > 2000 or v_notes ~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]') then
    raise exception 'VALIDATION: notes must be at most 2000 characters' using errcode = 'P0001';
  end if;
  if v_notes is not distinct from v_l.notes then
    return jsonb_build_object('lead_id', v_l.id, 'changed', false);
  end if;
  update crm.leads set notes = v_notes, version = version + 1 where id = v_l.id;
  return jsonb_build_object('lead_id', v_l.id, 'changed', true);
end $$;

-- Visits of an employee on a Cairo day that count against planning.daily_visit_cap: planned visits
-- and unplanned check-ins (not cancelled), the same count as api.plan_visits, plus planned leads.
create or replace function field.planned_load(p_employee_id uuid, p_date date, p_except_lead uuid default null) returns int
language sql stable security definer set search_path = '' as $$
  select (select count(*)::int from field.visits v
           where v.employee_id = p_employee_id and v.status <> 'cancelled' and v.planned_for = p_date)
       + (select count(*)::int from field.visits v
           where v.employee_id = p_employee_id and v.status <> 'cancelled' and v.planned_for is null
             and v.check_in_at >= (p_date::timestamp at time zone 'Africa/Cairo')
             and v.check_in_at < ((p_date + 1)::timestamp at time zone 'Africa/Cairo'))
       + (select count(*)::int from crm.leads l
           where l.employee_id = p_employee_id and l.planned_for = p_date
             and (p_except_lead is null or l.id <> p_except_lead))
$$;

-- Plan a lead visit for its rep on a day (the plan rules of api.plan_visits). Same day again: replayed.
create or replace function api.plan_lead_visit(p_lead_id uuid, p_date date)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_l crm.leads%rowtype; v_today date := core.business_date(); v_cap int; v_n int;
begin
  perform authz.require('field.visit.plan');
  v_l := crm.lead_for_update(p_lead_id, 'crm.lead.work');
  if v_l.status not in ('new', 'visited') then
    raise exception 'INVALID_STATE: a % lead is not planned', v_l.status using errcode = 'P0001';
  end if;
  perform field.planning_check_employee(v_l.employee_id);
  if p_date is null then raise exception 'VALIDATION: date is required' using errcode = 'P0001'; end if;
  if p_date < v_today then
    raise exception 'PAST_DATE: % is before today (%)', p_date, v_today using errcode = 'P0001';
  end if;
  if p_date > v_today + 366 then
    raise exception 'VALIDATION: the visit is more than a year ahead' using errcode = 'P0001';
  end if;
  if v_l.planned_for = p_date then
    return jsonb_build_object('lead_id', v_l.id, 'planned_for', p_date, 'replayed', true);
  end if;
  perform field.planning_lock('employee:' || v_l.employee_id::text);
  v_cap := (field.planning_config() ->> 'daily_cap')::int;
  v_n := field.planned_load(v_l.employee_id, p_date, v_l.id) + 1;
  if v_n > v_cap then
    raise exception 'DAILY_CAP: % would have % visits; the most per day is %', p_date, v_n, v_cap using errcode = 'P0001';
  end if;
  update crm.leads set planned_for = p_date, planned_by = auth.uid(), version = version + 1 where id = v_l.id;
  return jsonb_build_object('lead_id', v_l.id, 'planned_for', p_date, 'replayed', false);
end $$;

create or replace function api.unplan_lead_visit(p_lead_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_l crm.leads%rowtype;
begin
  v_l := crm.lead_for_update(p_lead_id, 'crm.lead.work');
  if v_l.planned_for is null then
    return jsonb_build_object('lead_id', v_l.id, 'replayed', true);
  end if;
  update crm.leads set planned_for = null, planned_by = null, version = version + 1 where id = v_l.id;
  return jsonb_build_object('lead_id', v_l.id, 'replayed', false);
end $$;

-- First visit: the rep's own record of the clinic becomes a CRM customer at stage 'prospect',
-- linked to the place id. Phone optional (Phase P). The customer is created by api.create_customer
-- (its permission, validation, duplicate rules, territory and owner logic all apply), owned by the
-- lead's rep. Idempotent: a converted lead answers its customer again (replayed = true).
create or replace function api.convert_lead(
  p_lead_id          uuid,
  p_doctor_name      text default null,
  p_clinic_name      text default null,
  p_phone            text default null,
  p_specialty_code   text default null,
  p_governorate_code text default null,
  p_city             text default null,
  p_notes            text default null,
  p_client_ref       uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_l crm.leads%rowtype; v_res jsonb; v_cust uuid; v_no text; v_emp uuid := authz.current_employee_id();
begin
  v_l := crm.lead_for_update(p_lead_id, 'crm.lead.work');
  if v_l.customer_id is not null then
    select c.customer_no into v_no from crm.customers c where c.id = v_l.customer_id;
    return jsonb_build_object('lead_id', v_l.id, 'customer_id', v_l.customer_id, 'customer_no', v_no,
                              'status', v_l.status, 'warnings', '[]'::jsonb, 'replayed', true);
  end if;
  if exists (select 1 from crm.customers c where c.google_place_id = v_l.place_id) then
    raise exception 'ALREADY_CUSTOMER: this clinic is already a customer' using errcode = 'P0001';
  end if;

  v_res := api.create_customer(
    p_doctor_name => p_doctor_name, p_clinic_name => p_clinic_name, p_phone_primary => p_phone,
    p_governorate_code => p_governorate_code, p_city => p_city, p_kind => 'clinic',
    p_specialty_code => nullif(btrim(p_specialty_code), ''), p_source => 'field',
    p_notes => coalesce(nullif(btrim(p_notes), ''), v_l.notes),
    p_owner_employee_id => v_l.employee_id, p_client_ref => p_client_ref);
  v_cust := (v_res ->> 'customer_id')::uuid;
  v_no := v_res ->> 'customer_no';

  update crm.customers set lifecycle_stage = 'prospect', google_place_id = v_l.place_id, version = version + 1
   where id = v_cust and lifecycle_stage = 'lead';
  if found then
    perform crm._add_activity(v_cust, v_emp, 'stage_change', 'Stage changed: lead → prospect (first visit to a discovered lead)',
                              'crm.leads', v_l.id);
    perform crm._emit('customer.stage_changed', 'crm.customer', v_cust, jsonb_build_object(
      'customer_id', v_cust, 'customer_no', v_no, 'from_stage', 'lead', 'to_stage', 'prospect'));
  end if;

  update crm.leads
     set status = 'prospect', customer_id = v_cust, planned_for = null, planned_by = null,
         status_changed_at = now(), status_changed_by = auth.uid(), version = version + 1
   where id = v_l.id;
  perform crm._emit('crm.lead_converted', 'crm.lead', v_l.id, jsonb_build_object(
    'lead_id', v_l.id, 'employee_id', v_l.employee_id, 'customer_id', v_cust, 'customer_no', v_no));

  return jsonb_build_object('lead_id', v_l.id, 'customer_id', v_cust, 'customer_no', v_no, 'status', 'prospect',
                            'warnings', coalesce(v_res -> 'warnings', '[]'::jsonb), 'replayed', false);
end $$;

-- Before the server loads live names for a list or map: how many Place Details it may fetch now
-- (monthly budget, and at most crm.lead_user_daily_details_limit() per user and day). The
-- granted number is counted as spent. 0 means "budget reached": the page shows ids only.
create or replace function api.lead_details_allowance(p_requested int)
returns int language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid(); v_today date := core.business_date(); v_u jsonb; v_budget numeric;
  v_left numeric; v_used int; v_allowed int; v_unit numeric := crm.lead_unit_cost_usd('details');
begin
  perform authz.require('crm.lead.read');
  if v_uid is null then raise exception 'NO_EMPLOYEE_PROFILE' using errcode = '42501'; end if;
  if p_requested is null or p_requested < 1 or p_requested > 50 then
    raise exception 'VALIDATION: ask for 1 to 50 details' using errcode = 'P0001';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('crm.lead_budget', 0));
  v_u := crm.lead_usage_now();
  v_budget := crm.lead_setting('leads.monthly_budget_usd', 20);
  v_left := v_budget - (v_u ->> 'month_run_cost_usd')::numeric - (v_u ->> 'month_detail_cost_usd')::numeric;
  select coalesce(sum(u.detail_requests), 0)::int into v_used from crm.lead_api_usage u
   where u.business_date = v_today and u.user_id = v_uid;
  v_allowed := greatest(0, least(p_requested, crm.lead_user_daily_details_limit() - v_used,
                                 floor(greatest(v_left, 0) / v_unit)::int));
  if v_allowed > 0 then
    insert into crm.lead_api_usage (business_date, user_id, detail_requests, estimated_cost_usd)
    values (v_today, v_uid, v_allowed, v_allowed * v_unit)
    on conflict (business_date, user_id) do update
       set detail_requests = crm.lead_api_usage.detail_requests + excluded.detail_requests,
           estimated_cost_usd = crm.lead_api_usage.estimated_cost_usd + excluded.estimated_cost_usd,
           updated_at = now();
  end if;
  return v_allowed;
end $$;

-- ---------------------------------------------------------------------------
-- 10. Manager and owner commands
-- ---------------------------------------------------------------------------
-- Move leads to another employee. Both the current and the new employee must be in the caller's
-- crm.lead.assign scope. Converted leads stay with the customer (customer reassignment has its
-- own approval workflow). A plan is cleared; the new rep is notified.
create or replace function api.reassign_leads(p_lead_ids uuid[], p_employee_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_reason text := nullif(btrim(p_reason), ''); v_to core.employees%rowtype; v_l crm.leads%rowtype;
  v_id uuid; v_moved int := 0; v_skipped int := 0;
begin
  perform authz.require('crm.lead.assign');
  if v_reason is null or length(v_reason) < 3 or length(v_reason) > 500 then
    raise exception 'REASON_REQUIRED' using errcode = 'P0001';
  end if;
  if p_lead_ids is null or cardinality(p_lead_ids) = 0 or cardinality(p_lead_ids) > 500 then
    raise exception 'VALIDATION: choose 1 to 500 leads' using errcode = 'P0001';
  end if;
  select * into v_to from core.employees where id = p_employee_id;
  if not found or v_to.employment_status <> 'active' then
    raise exception 'NOT_FOUND: active employee' using errcode = 'P0002';
  end if;
  if not authz.employee_in_scope('crm.lead.assign', p_employee_id) then
    raise exception 'PERMISSION_DENIED: employee is outside your scope' using errcode = '42501';
  end if;
  foreach v_id in array (select array_agg(distinct x order by x) from unnest(p_lead_ids) x) loop
    select * into v_l from crm.leads where id = v_id for update;
    if not found or not authz.employee_in_scope('crm.lead.assign', v_l.employee_id) then
      raise exception 'NOT_FOUND: lead' using errcode = 'P0002';
    end if;
    if v_l.status in ('prospect', 'customer') then
      raise exception 'INVALID_STATE: a converted lead moves with its customer (customer reassignment)' using errcode = 'P0001';
    end if;
    if v_l.employee_id = p_employee_id then v_skipped := v_skipped + 1; continue; end if;
    update crm.leads set employee_id = p_employee_id, assigned_at = now(), assigned_by = auth.uid(),
                         planned_for = null, planned_by = null, distance_m = null, distance_computed_at = null,
                         version = version + 1
     where id = v_l.id;
    v_moved := v_moved + 1;
  end loop;
  if v_moved > 0 then
    perform crm._emit('crm.leads_reassigned', 'core.employee', p_employee_id, jsonb_build_object(
      'employee_id', p_employee_id, 'count', v_moved, 'reason', v_reason));
    if v_to.user_id is not null and v_to.user_id is distinct from auth.uid() then
      perform notify.send_in_app(v_to.user_id, 'leads.assigned', 'Leads assigned to you',
        format('%s lead(s) were assigned to you.', v_moved), '/leads', jsonb_build_object('count', v_moved));
    end if;
  end if;
  return jsonb_build_object('employee_id', p_employee_id, 'moved', v_moved, 'skipped', v_skipped);
end $$;

-- The owner's "Run now": queue (or refresh) a run for one rep. The server then runs it at once.
create or replace function api.request_lead_discovery(p_employee_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_e core.employees%rowtype; v_id uuid;
begin
  if not authz.is_owner() then
    raise exception 'OWNER_ONLY: only an owner can run lead discovery' using errcode = '42501';
  end if;
  select * into v_e from core.employees where id = p_employee_id;
  if not found then raise exception 'NOT_FOUND: employee' using errcode = 'P0002'; end if;
  if v_e.employment_status <> 'active' then
    raise exception 'INVALID_STATE: employee is %', v_e.employment_status using errcode = 'P0001';
  end if;
  if v_e.base_lat is null then
    raise exception 'NO_BASE_LOCATION: set the employee''s base location first' using errcode = 'P0001';
  end if;
  v_id := crm.lead_queue_run(p_employee_id, 'owner');
  return jsonb_build_object('run_id', v_id, 'employee_id', p_employee_id, 'status', 'queued');
end $$;

-- Owner: the cost guard as it stands now.
create or replace function api.lead_usage()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_u jsonb;
begin
  if not authz.is_owner() then
    raise exception 'OWNER_ONLY: the lead budget is for the owner' using errcode = '42501';
  end if;
  v_u := crm.lead_usage_now();
  return v_u || jsonb_build_object(
    'daily_request_cap', crm.lead_setting('leads.daily_request_cap', 200),
    'monthly_budget_usd', crm.lead_setting('leads.monthly_budget_usd', 20),
    'unit_cost_usd', jsonb_build_object('nearby', crm.lead_unit_cost_usd('nearby'), 'text', crm.lead_unit_cost_usd('text'),
                                        'details', crm.lead_unit_cost_usd('details')),
    'run_request_limit', crm.lead_run_request_limit(),
    'queued_runs', (select count(*) from crm.lead_discovery_runs where status = 'queued'));
end $$;

-- ---------------------------------------------------------------------------
-- 11. Service functions (service_role only: the cron route and the owner's "Run now")
-- ---------------------------------------------------------------------------
-- Claim the next queued run (or p_run_id). Answers:
--   {status:'none'}                         nothing to do
--   {status:'cancelled', run_id}            the rep left or has no base any more
--   {status:'not_configured', run_id}       no server key: the run ends as not_configured
--   {status:'refused', run_id, reason}      over the daily cap or the monthly budget (stays queued)
--   {status:'claimed', run_id, employee_id, center:{lat,lng}, radius_m, max_requests}
-- A run left 'running' for more than 15 minutes is failed first and charged its reserved budget.
create or replace function service.leads_claim_run(p_run_id uuid default null, p_key_configured boolean default true)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_r crm.lead_discovery_runs%rowtype; v_e core.employees%rowtype; v_u jsonb;
  v_cap numeric; v_budget numeric; v_day_left numeric; v_money_left numeric; v_max int; v_unit numeric;
begin
  perform pg_advisory_xact_lock(hashtextextended('crm.lead_budget', 0));
  update crm.lead_discovery_runs
     set status = 'failed', finished_at = now(), error_code = 'stale',
         nearby_requests = greatest(nearby_requests, reserved_requests - text_requests),
         estimated_cost_usd = greatest(estimated_cost_usd, reserved_requests * crm.lead_unit_cost_usd('nearby'))
   where status = 'running' and started_at < now() - interval '15 minutes';

  select * into v_r from crm.lead_discovery_runs
   where status = 'queued' and (p_run_id is null or id = p_run_id)
   order by requested_at
   limit 1
   for update skip locked;
  if not found then return jsonb_build_object('status', 'none'); end if;

  select * into v_e from core.employees where id = v_r.employee_id;
  if v_e.employment_status is distinct from 'active' or v_e.base_lat is null then
    update crm.lead_discovery_runs set status = 'cancelled', finished_at = now() where id = v_r.id;
    return jsonb_build_object('status', 'cancelled', 'run_id', v_r.id);
  end if;
  if not coalesce(p_key_configured, false) then
    update crm.lead_discovery_runs set status = 'not_configured', finished_at = now(), refusal = null, refused_at = null
     where id = v_r.id;
    return jsonb_build_object('status', 'not_configured', 'run_id', v_r.id);
  end if;

  v_u := crm.lead_usage_now();
  v_unit := greatest(crm.lead_unit_cost_usd('nearby'), crm.lead_unit_cost_usd('text'));
  v_cap := crm.lead_setting('leads.daily_request_cap', 200);
  v_budget := crm.lead_setting('leads.monthly_budget_usd', 20);
  v_day_left := v_cap - (v_u ->> 'today_requests')::numeric;
  v_money_left := v_budget - (v_u ->> 'month_run_cost_usd')::numeric - (v_u ->> 'month_detail_cost_usd')::numeric;
  v_max := least(crm.lead_run_request_limit()::numeric, floor(greatest(v_day_left, 0)),
                 floor(greatest(v_money_left, 0) / v_unit))::int;
  if v_max < 1 then
    update crm.lead_discovery_runs
       set refusal = case when v_day_left < 1 then 'daily_cap' else 'monthly_budget' end, refused_at = now()
     where id = v_r.id;
    return jsonb_build_object('status', 'refused', 'run_id', v_r.id,
                              'reason', case when v_day_left < 1 then 'daily_cap' else 'monthly_budget' end);
  end if;

  update crm.lead_discovery_runs
     set status = 'running', started_at = now(), reserved_requests = v_max, radius_km = v_e.lead_radius_km,
         refusal = null, refused_at = null
   where id = v_r.id;
  return jsonb_build_object('status', 'claimed', 'run_id', v_r.id, 'employee_id', v_r.employee_id,
                            'center', jsonb_build_object('lat', v_e.base_lat, 'lng', v_e.base_lng),
                            'radius_m', round(v_e.lead_radius_km * 1000), 'max_requests', v_max);
end $$;

-- Record a run's outcome. p_places = [{place_id, distance_m, lat, lng}] as the server computed
-- them (deduplicated by place id here again). lat/lng are used ONLY for the 50 m customer check
-- in this call and are not stored. p_status: 'done' or 'failed' (failed runs still record the
-- requests they made and the places they found).
create or replace function service.leads_finish_run(
  p_run_id uuid, p_status text, p_nearby_requests int, p_text_requests int,
  p_truncated boolean default false, p_error_code text default null, p_places jsonb default '[]')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_r crm.lead_discovery_runs%rowtype; v_e core.employees%rowtype; v_p jsonb; v_pid text; v_dist numeric;
  v_lat numeric; v_lng numeric; v_lead crm.leads%rowtype; v_radius_m numeric;
  v_seen text[] := '{}'; v_found int := 0; v_new int := 0; v_again int := 0; v_excl int := 0; v_other int := 0;
  v_out int := 0; v_cost numeric;
begin
  if p_status is null or p_status not in ('done', 'failed') then
    raise exception 'VALIDATION: status must be done or failed' using errcode = 'P0001';
  end if;
  if coalesce(p_nearby_requests, -1) < 0 or coalesce(p_text_requests, -1) < 0 then
    raise exception 'VALIDATION: request counts are required' using errcode = 'P0001';
  end if;
  if p_error_code is not null and p_error_code !~ '^[a-z0-9_]{1,60}$' then
    raise exception 'VALIDATION: error code' using errcode = 'P0001';
  end if;
  if jsonb_typeof(coalesce(p_places, '[]')) <> 'array' or jsonb_array_length(coalesce(p_places, '[]')) > 5000 then
    raise exception 'VALIDATION: places must be a list of at most 5000' using errcode = 'P0001';
  end if;
  select * into v_r from crm.lead_discovery_runs where id = p_run_id for update;
  if not found then raise exception 'NOT_FOUND: run' using errcode = 'P0002'; end if;
  if v_r.status <> 'running' then
    raise exception 'INVALID_STATE: run is %', v_r.status using errcode = 'P0001';
  end if;
  select * into v_e from core.employees where id = v_r.employee_id;
  v_radius_m := v_r.radius_km * 1000;

  for v_p in select x from jsonb_array_elements(coalesce(p_places, '[]')) x loop
    v_pid := v_p ->> 'place_id';
    if v_pid is null or v_pid !~ '^[A-Za-z0-9_-]+$' or length(v_pid) not between 10 and 300 or v_pid = any(v_seen) then
      continue;
    end if;
    v_seen := v_seen || v_pid;
    v_found := v_found + 1;
    begin
      v_dist := round((v_p ->> 'distance_m')::numeric, 1);
      v_lat := (v_p ->> 'lat')::numeric;
      v_lng := (v_p ->> 'lng')::numeric;
    exception when others then
      v_dist := null; v_lat := null; v_lng := null;
    end;
    if v_dist is not null and (v_dist < 0 or v_dist > 999999) then v_dist := null; end if;
    if v_dist is not null and v_dist > v_radius_m then v_out := v_out + 1; continue; end if;

    -- Already a customer: the place id is linked, or a live pinned customer is within 50 m.
    if exists (select 1 from crm.customers c where c.google_place_id = v_pid)
       or (v_lat is not null and v_lng is not null and exists (
             select 1 from crm.customers c
              where c.archived_at is null and c.latitude is not null
                and c.latitude between v_lat - 0.0006 and v_lat + 0.0006
                and c.longitude between v_lng - 0.0007 and v_lng + 0.0007
                and core.distance_m(v_lat, v_lng, c.latitude, c.longitude) <= 50)) then
      v_excl := v_excl + 1;
      continue;
    end if;

    select * into v_lead from crm.leads where place_id = v_pid for update;
    if found then
      if v_lead.employee_id = v_r.employee_id then
        update crm.leads set last_seen_run_id = v_r.id, last_seen_at = now(),
                             distance_m = v_dist, distance_computed_at = case when v_dist is not null then now() end
         where id = v_lead.id;
        v_again := v_again + 1;
      else
        v_other := v_other + 1;
      end if;
    else
      insert into crm.leads (place_id, employee_id, distance_m, distance_computed_at, first_seen_run_id,
                             last_seen_run_id, last_seen_at)
      values (v_pid, v_r.employee_id, v_dist, case when v_dist is not null then now() end, v_r.id, v_r.id, now())
      on conflict (place_id) do nothing;
      if found then v_new := v_new + 1; else v_other := v_other + 1; end if;
    end if;
  end loop;

  v_cost := p_nearby_requests * crm.lead_unit_cost_usd('nearby') + p_text_requests * crm.lead_unit_cost_usd('text');
  update crm.lead_discovery_runs
     set status = p_status, finished_at = now(), nearby_requests = p_nearby_requests, text_requests = p_text_requests,
         estimated_cost_usd = round(v_cost, 4), places_found = v_found, leads_new = v_new, leads_seen = v_again,
         excluded_customers = v_excl, other_rep = v_other, outside_radius = v_out,
         truncated = coalesce(p_truncated, false), error_code = p_error_code
   where id = v_r.id;

  perform crm._emit('crm.lead_discovery_finished', 'crm.lead_discovery_run', v_r.id, jsonb_build_object(
    'run_id', v_r.id, 'employee_id', v_r.employee_id, 'status', p_status, 'requests', p_nearby_requests + p_text_requests,
    'leads_new', v_new, 'truncated', coalesce(p_truncated, false)));
  if v_new > 0 and v_e.user_id is not null then
    perform notify.send_in_app(v_e.user_id, 'leads.discovered', 'New clinics near you',
      format('%s new clinic lead(s) near your base.', v_new), '/leads', jsonb_build_object('run_id', v_r.id, 'count', v_new));
  end if;

  return jsonb_build_object('run_id', v_r.id, 'status', p_status, 'places_found', v_found, 'leads_new', v_new,
                            'leads_seen', v_again, 'excluded_customers', v_excl, 'other_rep', v_other,
                            'outside_radius', v_out, 'estimated_cost_usd', round(v_cost, 4));
end $$;

-- Daily housekeeping (cron): clear distances computed more than 30 days ago (they derive from
-- Places coordinates; Google allows caching coordinates for at most 30 days), and queue a refresh
-- run for reps whose last finished run is older than 28 days, so distances stay current.
create or replace function service.leads_daily()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_cleared int; v_queued int := 0; v_emp uuid;
begin
  update crm.leads set distance_m = null, distance_computed_at = null
   where distance_computed_at < now() - interval '30 days';
  get diagnostics v_cleared = row_count;
  for v_emp in
    select e.id from core.employees e
     where e.employment_status = 'active' and e.base_lat is not null
       and exists (select 1 from crm.lead_discovery_runs r where r.employee_id = e.id and r.status = 'done')
       and not exists (select 1 from crm.lead_discovery_runs r where r.employee_id = e.id
                        and (r.status in ('queued', 'running')
                             or (r.status = 'done' and r.finished_at > now() - interval '28 days')))
  loop
    perform crm.lead_queue_run(v_emp, 'refresh');
    v_queued := v_queued + 1;
  end loop;
  return jsonb_build_object('distances_cleared', v_cleared, 'refresh_queued', v_queued);
end $$;

-- ---------------------------------------------------------------------------
-- 12. api.plan_visits: the daily cap also counts planned leads. Restated from
--     20261104000800_audit4_planning.sql; only the cap query changes (field.planned_load).
-- ---------------------------------------------------------------------------
create or replace function api.plan_visits(p_employee_id uuid, p_visits jsonb, p_client_ref uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := authz.current_employee_id();
  v_emp uuid := coalesce(p_employee_id, v_me);
  v_today date := core.business_date();
  v_cap int;
  v_e core.employees%rowtype; v_b field.visit_plan_batches%rowtype;
  v_item jsonb; v_i int := 0; v_cust uuid; v_date date; v_c crm.customers%rowtype;
  v_seen text[] := '{}'; v_id uuid; v_ids uuid[] := '{}'; v_rows jsonb := '[]'; v_dates date[] := '{}';
  v_min date; v_max date; v_result jsonb; v_batch uuid;
  v_g boolean; v_terr uuid[]; v_assigned uuid[];
  v_over_d date; v_over_n int;
begin
  perform authz.require('field.visit.plan');
  if p_client_ref is null then raise exception 'VALIDATION: client_ref is required' using errcode = 'P0001'; end if;
  perform field.planning_lock('batch:' || p_client_ref::text);

  -- Idempotent replay.
  select * into v_b from field.visit_plan_batches where client_ref = p_client_ref;
  if found then
    if v_b.requested_by <> auth.uid() or v_b.employee_id is distinct from v_emp then
      raise exception 'CONFLICT: this client_ref was used for another plan' using errcode = 'P0001';
    end if;
    return v_b.result || jsonb_build_object('replayed', true);
  end if;

  v_e := field.planning_check_employee(v_emp);
  if jsonb_typeof(p_visits) is distinct from 'array' or jsonb_array_length(p_visits) = 0 then
    raise exception 'VALIDATION: visits must be a non-empty list' using errcode = 'P0001';
  end if;
  if jsonb_array_length(p_visits) > 200 then
    raise exception 'VALIDATION: at most 200 visits per plan' using errcode = 'P0001';
  end if;
  perform field.planning_lock('employee:' || v_emp::text);
  v_cap := (field.planning_config() ->> 'daily_cap')::int;
  -- The caller's crm.customer.read scope, once (= authz.customer_in_scope('crm.customer.read', id)).
  v_g := authz.has_global('crm.customer.read');
  v_terr := authz.territory_ids('crm.customer.read');
  v_assigned := authz.assigned_customer_ids('crm.customer.read');

  for v_item in select x from jsonb_array_elements(p_visits) x loop
    v_i := v_i + 1;
    begin
      v_cust := (v_item ->> 'customer_id')::uuid;
      v_date := (v_item ->> 'date')::date;
    exception when others then
      v_cust := null; v_date := null;
    end;
    if v_cust is null or v_date is null then
      raise exception 'VALIDATION: visit % needs a customer_id and a date', v_i using errcode = 'P0001';
    end if;
    if v_date < v_today then
      raise exception 'PAST_DATE: visit % is on %, before today (%)', v_i, v_date, v_today using errcode = 'P0001';
    end if;
    if v_date > v_today + 366 then
      raise exception 'VALIDATION: visit % is more than a year ahead', v_i using errcode = 'P0001';
    end if;
    select * into v_c from crm.customers where id = v_cust;
    if not found then raise exception 'NOT_FOUND: customer' using errcode = 'P0002'; end if;
    -- A customer the caller cannot read gets the not-assigned answer, without its number or state (F5).
    if not (v_g or coalesce(v_c.territory_id = any(v_terr), false) or coalesce(v_cust = any(v_assigned), false)) then
      raise exception 'NOT_ASSIGNED: visit % is not for one of this employee''s customers', v_i using errcode = 'P0001';
    end if;
    if v_c.archived_at is not null then
      raise exception 'INVALID_STATE: customer % is archived', v_c.customer_no using errcode = 'P0001';
    end if;
    if not exists (select 1 from crm.customer_assignments a
                   where a.customer_id = v_cust and a.employee_id = v_emp and a.valid_to is null) then
      raise exception 'NOT_ASSIGNED: customer % is not assigned to this employee', v_c.customer_no using errcode = 'P0001';
    end if;
    if (v_cust::text || '|' || v_date::text) = any(v_seen) then
      raise exception 'DUPLICATE: customer % is listed twice for %', v_c.customer_no, v_date using errcode = 'P0001';
    end if;
    if exists (select 1 from field.visits v
               where v.employee_id = v_emp and v.customer_id = v_cust and v.status not in ('cancelled','missed')
                 and (v.planned_for = v_date
                      or (v.planned_for is null and (v.check_in_at at time zone 'Africa/Cairo')::date = v_date))) then
      raise exception 'DUPLICATE: customer % already has a visit on %', v_c.customer_no, v_date using errcode = 'P0001';
    end if;
    v_seen := v_seen || (v_cust::text || '|' || v_date::text);

    v_id := gen_random_uuid();
    insert into field.visits (id, customer_id, employee_id, planned_for, status, planned_by)
    values (v_id, v_cust, v_emp, v_date, 'planned', auth.uid());
    v_ids := v_ids || v_id;
    v_dates := v_dates || v_date;
    v_rows := v_rows || jsonb_build_array(jsonb_build_object('visit_id', v_id, 'customer_id', v_cust, 'date', v_date));
    v_min := least(v_min, v_date); v_max := greatest(v_max, v_date);
  end loop;

  -- Daily cap (F2): every day of this plan, counting the employee's other visits that day (planned, in
  -- progress, done or missed; cancelled ones free their place), the same count the generator uses.
  -- Phase P step 4: planned leads count too (field.planned_load).
  select x.d, x.n into v_over_d, v_over_n
  from (select u.d, field.planned_load(v_emp, u.d) as n
        from (select distinct d from unnest(v_dates) d) u(d)) x
  where x.n > v_cap
  order by x.d
  limit 1;
  if v_over_d is not null then
    raise exception 'DAILY_CAP: % would have % visits; the most per day is %', v_over_d, v_over_n, v_cap
      using errcode = 'P0001';
  end if;

  v_result := jsonb_build_object('client_ref', p_client_ref, 'employee_id', v_emp, 'created', v_i,
                                 'from', v_min, 'to', v_max, 'visits', v_rows);
  insert into field.visit_plan_batches (client_ref, employee_id, requested_by, visit_ids, result)
  values (p_client_ref, v_emp, auth.uid(), v_ids, v_result)
  returning id into v_batch;

  insert into integration.outbox (event_type, aggregate_type, aggregate_id, payload)
  values ('field.visits_planned', 'field.visit_plan_batch', v_batch,
          jsonb_build_object('employee_id', v_emp, 'visit_ids', to_jsonb(v_ids), 'count', v_i,
                             'from', v_min, 'to', v_max));
  if v_emp is distinct from v_me then
    perform notify.send_in_app(v_e.user_id, 'planning.visits_planned', 'Visits added to your plan',
      format('%s visit(s) were added to your plan, from %s to %s.', v_i, v_min, v_max), '/planning',
      jsonb_build_object('client_ref', p_client_ref, 'count', v_i, 'from', v_min, 'to', v_max));
  end if;

  return v_result || jsonb_build_object('replayed', false);
end $$;

-- ---------------------------------------------------------------------------
-- 13. Read views (security_invoker: the RLS above decides the rows)
-- ---------------------------------------------------------------------------
create or replace view api.v_leads with (security_invoker = true) as
  select l.id, l.place_id, l.employee_id, ed.full_name_en as employee_name_en, ed.full_name_ar as employee_name_ar,
         l.status, l.distance_m, l.first_seen_at, l.last_seen_at,
         (l.last_seen_run_id is not distinct from (
            select r.id from crm.lead_discovery_runs r
             where r.employee_id = l.employee_id and r.status = 'done'
             order by r.finished_at desc limit 1)) as in_latest_run,
         l.notes, l.customer_id, c.customer_no, c.display_name as customer_name, c.lifecycle_stage as customer_stage,
         l.planned_for, (l.planned_for = core.business_date()) as planned_today,
         l.status_changed_at, l.assigned_at, l.updated_at, l.version
  from crm.leads l
  left join crm.customers c on c.id = l.customer_id
  left join lateral crm.employee_display(l.employee_id) ed on true;

create or replace view api.v_lead_discovery_runs with (security_invoker = true) as
  select r.id, r.employee_id, ed.full_name_en as employee_name_en, ed.full_name_ar as employee_name_ar,
         r.trigger, r.status, r.radius_km, r.requested_at, r.started_at, r.finished_at,
         r.nearby_requests, r.text_requests, (r.nearby_requests + r.text_requests) as request_count,
         r.estimated_cost_usd, r.places_found, r.leads_new, r.leads_seen, r.excluded_customers, r.other_rep,
         r.outside_radius, r.truncated, r.refusal, r.refused_at, r.error_code
  from crm.lead_discovery_runs r
  left join lateral crm.employee_display(r.employee_id) ed on true;

-- Per employee: leads, visited % (visited, prospect or customer) and converted % (prospect or
-- customer = became a CRM record), with the last run.
create or replace view api.v_lead_stats with (security_invoker = true) as
  select s.employee_id, ed.full_name_en as employee_name_en, ed.full_name_ar as employee_name_ar,
         s.total, s.new_count, s.visited_count, s.prospect_count, s.customer_count, s.not_interested_count,
         s.planned_today,
         round(100.0 * (s.visited_count + s.prospect_count + s.customer_count) / nullif(s.total, 0), 1) as visited_pct,
         round(100.0 * (s.prospect_count + s.customer_count) / nullif(s.total, 0), 1) as converted_pct,
         lr.status as last_run_status, lr.finished_at as last_run_finished_at, lr.requested_at as last_run_requested_at
  from (select l.employee_id, count(*)::int as total,
               (count(*) filter (where l.status = 'new'))::int as new_count,
               (count(*) filter (where l.status = 'visited'))::int as visited_count,
               (count(*) filter (where l.status = 'prospect'))::int as prospect_count,
               (count(*) filter (where l.status = 'customer'))::int as customer_count,
               (count(*) filter (where l.status = 'not_interested'))::int as not_interested_count,
               (count(*) filter (where l.planned_for = core.business_date()))::int as planned_today
        from crm.leads l group by l.employee_id) s
  left join lateral crm.employee_display(s.employee_id) ed on true
  left join lateral (select r.status, r.finished_at, r.requested_at from crm.lead_discovery_runs r
                      where r.employee_id = s.employee_id order by r.requested_at desc limit 1) lr on true;

grant select on api.v_leads, api.v_lead_discovery_runs, api.v_lead_stats to authenticated;
revoke all on api.v_leads, api.v_lead_discovery_runs, api.v_lead_stats from anon;

-- ---------------------------------------------------------------------------
-- 14. Privileges (explicit; PostgreSQL's global PUBLIC execute revoked, gotcha of suite 08)
-- ---------------------------------------------------------------------------
do $$
declare f text;
begin
  foreach f in array array[
    'api.set_lead_status(uuid, text)',
    'api.set_lead_notes(uuid, text)',
    'api.plan_lead_visit(uuid, date)',
    'api.unplan_lead_visit(uuid)',
    'api.convert_lead(uuid, text, text, text, text, text, text, text, uuid)',
    'api.lead_details_allowance(int)',
    'api.reassign_leads(uuid[], uuid, text)',
    'api.request_lead_discovery(uuid)',
    'api.lead_usage()',
    'api.plan_visits(uuid, jsonb, uuid)']
  loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
  -- Internal helpers and trigger functions: never client-callable. The RLS helper stays callable
  -- (it is used by the policies above).
  foreach f in array array[
    'crm.lead_setting(text, numeric)',
    'crm.lead_unit_cost_usd(text)',
    'crm.lead_run_request_limit()',
    'crm.lead_user_daily_details_limit()',
    'crm.lead_usage_now()',
    'crm.lead_queue_run(uuid, text)',
    'crm.queue_lead_discovery_on_base()',
    'crm.lead_follow_customer_stage()',
    'crm.lead_for_update(uuid, text)',
    'field.planned_load(uuid, date, uuid)']
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
  end loop;
  execute 'revoke execute on function crm.lead_scope_employee_ids(text) from public, anon';
  execute 'grant execute on function crm.lead_scope_employee_ids(text) to authenticated';
  foreach f in array array[
    'service.leads_claim_run(uuid, boolean)',
    'service.leads_finish_run(uuid, text, int, int, boolean, text, jsonb)',
    'service.leads_daily()']
  loop
    execute format('revoke execute on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;
