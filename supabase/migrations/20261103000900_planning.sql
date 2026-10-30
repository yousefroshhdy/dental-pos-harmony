-- Honest OS migration: visit planning and coverage (Phase 3, planning module).
--
-- A plan is a set of field.visits rows with status 'planned' and a planned_for day. Reps plan for
-- themselves; managers plan for their team. The rep checks in on the planned visit from /today
-- (api.visit_check_in upserts the same visit id), so plans, visits and KPIs share one table.
--
-- Settings:  planning.visit_interval_days {"A":7,"B":14,"C":30}, planning.default_visit_class "C",
--            planning.daily_visit_cap 8, planning.work_days ["sun".."thu"]
-- Tables:    field.visit_frequencies (customer → class A/B/C), field.visit_plan_batches (idempotency)
-- Commands:  api.set_visit_frequency, api.plan_visits, api.unplan_visit
-- Reads:     api.generate_plan (a proposal; writes nothing), api.planning_settings(), api.coverage(from, to),
--            api.v_visit_plan, api.v_coverage (this month), api.v_planning_employees, api.v_planning_customers
-- Perms:     field.visit.plan (new): sales_rep own, area_manager + sales_director team (the roles that read
--            visits; a planner must see the plan through field.visit.read RLS).
--            Visit frequency: crm.customer.update at team scope or wider (managers), customer in scope.
--
-- Rules (enforced here, not in the app):
--   * the customer must have an open assignment to the planned employee;
--   * no day before core.business_date() (Cairo); at most 366 days ahead; at most 200 visits per call;
--   * one plan per employee, customer and day (planned / in progress / done; a partial unique index backs it);
--   * unplanning only while the visit is still 'planned', not checked in and not in the past; it cancels
--     the row (history kept), never deletes it.
--
-- Coverage counts completed visits by anyone (several on the same Cairo day count once, DASHBOARDS.md §1),
-- for customers in the caller's crm.customer.read scope. A customer is overdue when it was never visited or
-- its last visit is more than its interval ago.
--
-- Non-destructive only: new tables, indexes, functions, views, settings and one permission.

-- ---------------------------------------------------------------------------
-- 1. Permission (reference-data pattern) and system-role grants
-- ---------------------------------------------------------------------------
insert into authz.permissions (code, module, description, allowed_scopes, supports_limit, is_sensitive) values
  ('field.visit.plan', 'field',
   'Plan and unplan customer visits (own: for myself; team: for my team)',
   '{own,team,territory,all}', false, false)
on conflict (code) do nothing;

insert into authz.role_permissions (role_id, permission_code, scope, limit_value)
select r.id, 'field.visit.plan', v.scope, null
from (values ('sales_rep', 'own'), ('area_manager', 'team'), ('sales_director', 'team')) as v(role_code, scope)
join authz.roles r on r.code = v.role_code
on conflict (role_id, permission_code) do nothing;

-- ---------------------------------------------------------------------------
-- 2. Settings (working defaults; the owner may change them)
-- ---------------------------------------------------------------------------
insert into core.system_settings (key, value, description) values
  ('planning.visit_interval_days', '{"A":7,"B":14,"C":30}', 'Visit planning: days between visits for customer class A, B and C'),
  ('planning.default_visit_class', '"C"', 'Visit planning: class used for a customer that has none'),
  ('planning.daily_visit_cap', '8', 'Visit planning: most visits per rep per day in a generated plan'),
  ('planning.work_days', '["sun","mon","tue","wed","thu"]', 'Visit planning: the days a generated plan uses')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- 3. Tables and indexes
-- ---------------------------------------------------------------------------
-- How often a customer should be visited. No row = planning.default_visit_class.
create table field.visit_frequencies (
  id          uuid primary key default gen_random_uuid(),
  customer_id uuid not null unique references crm.customers(id),
  visit_class text not null check (visit_class in ('A','B','C')),
  updated_by  uuid references auth.users(id),
  updated_at  timestamptz not null default now()
);
create trigger trg_audit after insert or update or delete on field.visit_frequencies
  for each row execute function audit.log_change();

-- One row per accepted api.plan_visits call: the device idempotency key and the answer it got.
create table field.visit_plan_batches (
  id           uuid primary key default gen_random_uuid(),
  client_ref   uuid not null unique,
  employee_id  uuid not null references core.employees(id),
  requested_by uuid not null references auth.users(id),
  visit_ids    uuid[] not null default '{}',
  result       jsonb not null,
  created_at   timestamptz not null default now()
);
create trigger trg_visit_plan_batches_append_only before update on field.visit_plan_batches
  for each row execute function core.forbid_mutation();

create index if not exists idx_visits_employee_planned on field.visits (employee_id, planned_for) where planned_for is not null;
create index if not exists idx_visits_customer_completed on field.visits (customer_id, check_in_at) where status = 'completed';
-- Backstop for the command's duplicate rule (the command also covers in-progress and done visits).
create unique index if not exists uq_visits_one_plan_per_day on field.visits (employee_id, customer_id, planned_for)
  where status = 'planned' and planned_for is not null;

alter table field.visit_frequencies enable row level security;
alter table field.visit_plan_batches enable row level security;
grant select on field.visit_frequencies to authenticated;
-- A frequency is visible with its customer (inherits crm.customers RLS; no cycle back here).
create policy visit_frequencies_select on field.visit_frequencies for select to authenticated using (
  exists (select 1 from crm.customers c where c.id = visit_frequencies.customer_id));
-- field.visit_plan_batches: no client access (commands return what the caller needs).

-- ---------------------------------------------------------------------------
-- 4. Helpers
-- ---------------------------------------------------------------------------
-- The planning settings with defaults (malformed values fall back). Not secret: read by the views.
create or replace function field.planning_config() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_int jsonb; v_cap int; v_def text; v_days text[]; v_dows int[];
  c_names constant text[] := array['sun','mon','tue','wed','thu','fri','sat'];
begin
  select s.value into v_int from core.system_settings s where s.key = 'planning.visit_interval_days';
  begin
    v_cap := (select (s.value #>> '{}')::int from core.system_settings s where s.key = 'planning.daily_visit_cap');
  exception when others then v_cap := null;
  end;
  select s.value #>> '{}' into v_def from core.system_settings s where s.key = 'planning.default_visit_class';
  begin
    select array(select lower(x) from jsonb_array_elements_text(s.value) x)
      into v_days from core.system_settings s where s.key = 'planning.work_days';
  exception when others then v_days := null;
  end;
  v_days := array(select d from unnest(coalesce(v_days, '{}')) d where d = any(c_names));
  if cardinality(v_days) = 0 then v_days := array['sun','mon','tue','wed','thu']; end if;
  v_dows := array(select array_position(c_names, d) - 1 from unnest(v_days) d order by 1);

  return jsonb_build_object(
    'intervals', jsonb_build_object(
      'A', field.planning_interval_value(v_int, 'A', 7),
      'B', field.planning_interval_value(v_int, 'B', 14),
      'C', field.planning_interval_value(v_int, 'C', 30)),
    'default_class', case when v_def in ('A','B','C') then v_def else 'C' end,
    'daily_cap', case when v_cap between 1 and 50 then v_cap else 8 end,
    'work_dows', to_jsonb(v_dows),
    'work_days', to_jsonb(array(select c_names[d + 1] from unnest(v_dows) d)));
end $$;

create or replace function field.planning_interval_value(p_map jsonb, p_class text, p_default int) returns int
language plpgsql immutable set search_path = '' as $$
declare v int;
begin
  v := (p_map ->> p_class)::int;
  return case when v between 1 and 365 then v else p_default end;
exception when others then
  return p_default;
end $$;

-- Serializes one employee's plan writes (two devices planning the same day never interleave).
create or replace function field.planning_lock(p_key text) returns void
language sql set search_path = '' as $$
  select pg_advisory_xact_lock(hashtextextended('field.visit_plan:' || p_key, 0))
$$;

-- Employees the caller may plan for (= authz.employee_in_scope('field.visit.plan', id)), active only.
-- Global scope lists self plus employees with at least one open customer assignment.
create or replace function field.plannable_employees()
returns table (id uuid, employee_no text, full_name_en text, full_name_ar text, job_title text, is_me boolean)
language sql stable security definer set search_path = '' as $$
  with me as materialized (
    select authz.current_employee_id() as emp,
           authz.has_permission('field.visit.plan') as can_plan,
           authz.has_global('field.visit.plan') as g,
           authz.employee_ids('field.visit.plan') as ids,
           authz.territory_ids('field.visit.plan') as terr)
  select e.id, e.employee_no, e.full_name_en, e.full_name_ar, e.job_title, e.id is not distinct from me.emp
  from core.employees e cross join me
  where me.can_plan and e.employment_status in ('active','on_leave')
    and ((me.g and (e.id = me.emp or exists (select 1 from crm.customer_assignments a
                                              where a.employee_id = e.id and a.valid_to is null)))
         or e.id = any(me.ids)
         or exists (select 1 from core.employee_territories et
                    where et.employee_id = e.id and et.valid_to is null and et.territory_id = any(me.terr)))
$$;

-- Common employee checks for plan commands: exists, active, in the caller's field.visit.plan scope.
create or replace function field.planning_check_employee(p_employee_id uuid) returns core.employees
language plpgsql stable security definer set search_path = '' as $$
declare v_e core.employees%rowtype;
begin
  if p_employee_id is null then raise exception 'NO_EMPLOYEE_PROFILE' using errcode = '42501'; end if;
  select * into v_e from core.employees where id = p_employee_id;
  if not found then raise exception 'NOT_FOUND: employee' using errcode = 'P0002'; end if;
  if not authz.employee_in_scope('field.visit.plan', p_employee_id) then
    raise exception 'PERMISSION_DENIED: you cannot plan visits for this employee' using errcode = '42501';
  end if;
  if v_e.employment_status not in ('active','on_leave') then
    raise exception 'INVALID_STATE: employee is not active' using errcode = 'P0001';
  end if;
  return v_e;
end $$;

-- ---------------------------------------------------------------------------
-- 5. Commands
-- ---------------------------------------------------------------------------
-- Set a customer's visit class. Managers only: crm.customer.update at team scope or wider (a rep must
-- not lower their own customers' targets), and the customer must be in that permission's scope.
create or replace function api.set_visit_frequency(p_customer_id uuid, p_visit_class text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_c crm.customers%rowtype; v_cfg jsonb := field.planning_config();
begin
  perform authz.require('crm.customer.update');
  if coalesce(authz.max_scope_rank('crm.customer.update'), 0) < authz.scope_rank('team') then
    raise exception 'PERMISSION_DENIED: only managers set visit frequency' using errcode = '42501';
  end if;
  if p_visit_class is null or p_visit_class not in ('A','B','C') then
    raise exception 'VALIDATION: visit class must be A, B or C' using errcode = 'P0001';
  end if;
  select * into v_c from crm.customers where id = p_customer_id;
  if not found then raise exception 'NOT_FOUND: customer' using errcode = 'P0002'; end if;
  if not authz.customer_in_scope('crm.customer.update', p_customer_id) then
    raise exception 'PERMISSION_DENIED: customer not in your scope' using errcode = '42501';
  end if;
  if v_c.archived_at is not null then
    raise exception 'INVALID_STATE: customer is archived' using errcode = 'P0001';
  end if;

  insert into field.visit_frequencies (customer_id, visit_class, updated_by)
  values (p_customer_id, p_visit_class, auth.uid())
  on conflict (customer_id) do update set visit_class = excluded.visit_class, updated_by = excluded.updated_by,
    updated_at = now()
  where field.visit_frequencies.visit_class is distinct from excluded.visit_class;

  return jsonb_build_object('customer_id', p_customer_id, 'visit_class', p_visit_class,
                            'interval_days', (v_cfg -> 'intervals' ->> p_visit_class)::int);
end $$;

-- Create planned visits for one employee. p_visits = [{"customer_id": uuid, "date": "YYYY-MM-DD"}, …].
-- All or nothing; idempotent on p_client_ref (a replay returns the first answer with replayed = true).
create or replace function api.plan_visits(p_employee_id uuid, p_visits jsonb, p_client_ref uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_me uuid := authz.current_employee_id();
  v_emp uuid := coalesce(p_employee_id, v_me);
  v_today date := core.business_date();
  v_e core.employees%rowtype; v_b field.visit_plan_batches%rowtype;
  v_item jsonb; v_i int := 0; v_cust uuid; v_date date; v_c crm.customers%rowtype;
  v_seen text[] := '{}'; v_id uuid; v_ids uuid[] := '{}'; v_rows jsonb := '[]';
  v_min date; v_max date; v_result jsonb; v_batch uuid;
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
    insert into field.visits (id, customer_id, employee_id, planned_for, status)
    values (v_id, v_cust, v_emp, v_date, 'planned');
    v_ids := v_ids || v_id;
    v_rows := v_rows || jsonb_build_array(jsonb_build_object('visit_id', v_id, 'customer_id', v_cust, 'date', v_date));
    v_min := least(v_min, v_date); v_max := greatest(v_max, v_date);
  end loop;

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

-- Remove a planned visit: only while it is still 'planned', not checked in, and today or later.
-- The row is cancelled (history kept). Unplanning a cancelled visit again is an idempotent replay.
create or replace function api.unplan_visit(p_visit_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_v field.visits%rowtype; v_me uuid := authz.current_employee_id(); v_user uuid;
begin
  perform authz.require('field.visit.plan');
  select * into v_v from field.visits where id = p_visit_id for update;
  if not found then raise exception 'NOT_FOUND: visit' using errcode = 'P0002'; end if;
  if not authz.employee_in_scope('field.visit.plan', v_v.employee_id) then
    raise exception 'PERMISSION_DENIED: you cannot change this employee''s plan' using errcode = '42501';
  end if;
  if v_v.status = 'cancelled' and v_v.planned_for is not null and v_v.check_in_at is null then
    return jsonb_build_object('visit_id', v_v.id, 'status', 'cancelled', 'replayed', true);
  end if;
  if v_v.status <> 'planned' or v_v.planned_for is null or v_v.check_in_at is not null
     or exists (select 1 from field.location_events le where le.visit_id = v_v.id) then
    raise exception 'INVALID_STATE: only a planned visit that is not checked in can be removed' using errcode = 'P0001';
  end if;
  if v_v.planned_for < core.business_date() then
    raise exception 'PAST_DATE: a planned visit from a past day cannot be removed' using errcode = 'P0001';
  end if;

  update field.visits set status = 'cancelled', updated_at = now() where id = v_v.id;

  insert into integration.outbox (event_type, aggregate_type, aggregate_id, payload)
  values ('field.visit_unplanned', 'field.visit', v_v.id,
          jsonb_build_object('visit_id', v_v.id, 'employee_id', v_v.employee_id, 'planned_for', v_v.planned_for));
  if v_v.employee_id is distinct from v_me then
    select user_id into v_user from core.employees where id = v_v.employee_id;
    perform notify.send_in_app(v_user, 'planning.visit_unplanned', 'A planned visit was removed',
      format('A visit planned for %s was removed from your plan.', v_v.planned_for), '/planning',
      jsonb_build_object('visit_id', v_v.id, 'planned_for', v_v.planned_for));
  end if;
  return jsonb_build_object('visit_id', v_v.id, 'status', 'cancelled', 'replayed', false);
end $$;

-- ---------------------------------------------------------------------------
-- 6. The generator: a proposal for one employee and month. Writes nothing.
-- ---------------------------------------------------------------------------
-- Each assigned customer (not archived, not lost) is due one interval after its last completed visit
-- (never visited or overdue = due on the first plannable day). Occurrences are taken in due order
-- (then class A before B before C, then the longest since a visit). An existing visit of this employee
-- before the next occurrence would fall due covers it. Otherwise the visit goes on the least-loaded
-- working day from a quarter interval before to half an interval after its due day (never before the
-- first plannable day; ties: the closest to the due day), else the first later working day with room. Working days are planning.work_days; a day never exceeds planning.daily_visit_cap,
-- existing visits included. Occurrences that find no room are returned as 'unscheduled'.
create or replace function api.generate_plan(p_employee_id uuid, p_month date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_emp uuid := coalesce(p_employee_id, authz.current_employee_id());
  v_today date := core.business_date();
  v_cfg jsonb := field.planning_config();
  v_cap int := (v_cfg ->> 'daily_cap')::int;
  v_dows int[] := array(select x::int from jsonb_array_elements_text(v_cfg -> 'work_dows') x);
  v_e core.employees%rowtype;
  v_m0 date; v_m1 date; v_start date;
  d_dates date[]; d_load int[]; d_existing int[];
  c_ids uuid[]; c_nos text[]; c_names text[]; c_class text[]; c_last date[];
  c_int int[]; c_due date[]; c_prev date[];
  x_cust uuid[]; x_date date[];
  v_n int; v_best int; v_i int; v_k int; v_pick int; v_tol int; v_early int; v_due date; v_e_date date; v_guard int := 0;
  v_props jsonb := '[]'; v_unsched jsonb := '[]'; v_days jsonb;
begin
  perform authz.require('field.visit.plan');
  v_e := field.planning_check_employee(v_emp);
  if p_month is null then raise exception 'VALIDATION: month is required' using errcode = 'P0001'; end if;
  v_m0 := date_trunc('month', p_month)::date;
  v_m1 := (v_m0 + interval '1 month')::date - 1;
  if v_m1 < v_today then
    raise exception 'PAST_DATE: % is over', to_char(v_m0, 'YYYY-MM') using errcode = 'P0001';
  end if;
  if v_m0 > v_today + 366 then raise exception 'VALIDATION: month is more than a year ahead' using errcode = 'P0001'; end if;
  v_start := greatest(v_m0, v_today);

  -- Working days left in the month, with the visits the employee already has on each.
  select coalesce(array_agg(g.d order by g.d), '{}'),
         coalesce(array_agg((select count(*)::int from field.visits v
                             where v.employee_id = v_emp and v.status <> 'cancelled'
                               and coalesce(v.planned_for, (v.check_in_at at time zone 'Africa/Cairo')::date) = g.d)
                            order by g.d), '{}')
    into d_dates, d_existing
  from (select s::date as d from generate_series(v_start, v_m1, interval '1 day') s) g
  where extract(dow from g.d)::int = any(v_dows);
  d_load := d_existing;

  -- The employee's customers and their last completed visit (by anyone, Cairo day).
  select coalesce(array_agg(x.id order by x.customer_no), '{}'), coalesce(array_agg(x.customer_no order by x.customer_no), '{}'),
         coalesce(array_agg(x.display_name order by x.customer_no), '{}'), coalesce(array_agg(x.cls order by x.customer_no), '{}'),
         coalesce(array_agg(x.last_on order by x.customer_no), '{}')
    into c_ids, c_nos, c_names, c_class, c_last
  from (select c.id, c.customer_no, c.display_name, coalesce(f.visit_class, v_cfg ->> 'default_class') as cls,
               (select max((v.check_in_at at time zone 'Africa/Cairo')::date) from field.visits v
                 where v.customer_id = c.id and v.status = 'completed'
                   and (v.check_in_at at time zone 'Africa/Cairo')::date <= v_today) as last_on
        from crm.customers c
        left join field.visit_frequencies f on f.customer_id = c.id
        where c.archived_at is null and c.lifecycle_stage <> 'lost'
          and exists (select 1 from crm.customer_assignments a
                      where a.customer_id = c.id and a.employee_id = v_emp and a.valid_to is null)) x;

  -- Visits the employee already has in the window (planned, in progress or done).
  select coalesce(array_agg(v.customer_id order by v.planned_for), '{}'), coalesce(array_agg(v.planned_for order by v.planned_for), '{}')
    into x_cust, x_date
  from field.visits v
  where v.employee_id = v_emp and v.status <> 'cancelled' and v.planned_for between v_start and v_m1;

  v_n := coalesce(array_length(c_ids, 1), 0);
  c_int := array_fill(0, array[greatest(v_n, 1)]);
  c_due := array_fill(null::date, array[greatest(v_n, 1)]);
  c_prev := array_fill(null::date, array[greatest(v_n, 1)]);
  for v_i in 1 .. v_n loop
    c_int[v_i] := (v_cfg -> 'intervals' ->> c_class[v_i])::int;
    c_due[v_i] := case when c_last[v_i] is null then v_start else greatest(v_start, c_last[v_i] + c_int[v_i]) end;
    c_prev[v_i] := c_last[v_i];
  end loop;

  loop
    v_guard := v_guard + 1;
    exit when v_guard > 20000;
    v_best := null;
    for v_i in 1 .. v_n loop
      if c_due[v_i] is not null and c_due[v_i] <= v_m1 and (
           v_best is null or c_due[v_i] < c_due[v_best]
           or (c_due[v_i] = c_due[v_best] and (c_class[v_i] < c_class[v_best]
               or (c_class[v_i] = c_class[v_best]
                   and coalesce(c_last[v_i], '-infinity'::date) < coalesce(c_last[v_best], '-infinity'::date))))) then
        v_best := v_i;
      end if;
    end loop;
    exit when v_best is null;
    v_i := v_best; v_due := c_due[v_i];

    -- An existing visit before the occurrence after this one would fall due covers this one.
    select min(u.d) into v_e_date from unnest(x_cust, x_date) u(c, d)
    where u.c = c_ids[v_i] and u.d > coalesce(c_prev[v_i], '-infinity'::date) and u.d < v_due + c_int[v_i];
    if v_e_date is not null then
      c_prev[v_i] := v_e_date;
      c_due[v_i] := v_e_date + c_int[v_i];
      continue;
    end if;

    -- Place it: the least-loaded working day from a quarter interval early to half an interval late
    -- (ties: the closest to the due day, then the earlier), else the first later day with room.
    v_tol := c_int[v_i] / 2;
    v_early := c_int[v_i] / 4;
    v_pick := null;
    for v_k in 1 .. coalesce(array_length(d_dates, 1), 0) loop
      continue when d_dates[v_k] < v_due - v_early or d_dates[v_k] <= coalesce(c_prev[v_i], '-infinity'::date)
                 or d_load[v_k] >= v_cap
                 or exists (select 1 from unnest(x_cust, x_date) u(c, d) where u.c = c_ids[v_i] and u.d = d_dates[v_k]);
      if d_dates[v_k] <= v_due + v_tol then
        if v_pick is null or d_load[v_k] < d_load[v_pick]
           or (d_load[v_k] = d_load[v_pick] and abs(d_dates[v_k] - v_due) < abs(d_dates[v_pick] - v_due)) then
          v_pick := v_k;
        end if;
      else
        if v_pick is null then v_pick := v_k; end if;
        exit;
      end if;
    end loop;

    if v_pick is null then
      v_unsched := v_unsched || jsonb_build_array(jsonb_build_object(
        'customer_id', c_ids[v_i], 'customer_no', c_nos[v_i], 'customer_name', c_names[v_i],
        'visit_class', c_class[v_i], 'due_on', v_due, 'reason', 'no_capacity'));
      c_due[v_i] := null;
      continue;
    end if;

    v_props := v_props || jsonb_build_array(jsonb_build_object(
      'customer_id', c_ids[v_i], 'customer_no', c_nos[v_i], 'customer_name', c_names[v_i],
      'visit_class', c_class[v_i], 'date', d_dates[v_pick], 'due_on', v_due, 'last_visit_on', c_last[v_i],
      'reason', case when c_prev[v_i] is distinct from c_last[v_i] then 'due'
                     when c_last[v_i] is null then 'never_visited'
                     when c_last[v_i] + c_int[v_i] < v_today then 'overdue'
                     else 'due' end));
    d_load[v_pick] := d_load[v_pick] + 1;
    c_prev[v_i] := d_dates[v_pick];
    c_due[v_i] := greatest(v_due + c_int[v_i], d_dates[v_pick] + (c_int[v_i] + 1) / 2);
  end loop;

  select coalesce(jsonb_agg(jsonb_build_object('date', d, 'existing', e, 'proposed', l - e) order by d), '[]')
    into v_days from unnest(d_dates, d_existing, d_load) u(d, e, l);

  return jsonb_build_object(
    'employee_id', v_emp, 'month', v_m0, 'from', v_start, 'to', v_m1,
    'daily_cap', v_cap, 'work_days', v_cfg -> 'work_days', 'customers', v_n,
    'days', v_days,
    'proposals', (select coalesce(jsonb_agg(p order by p ->> 'date', p ->> 'customer_no'), '[]') from jsonb_array_elements(v_props) p),
    'unscheduled', v_unsched);
end $$;

-- ---------------------------------------------------------------------------
-- 7. Reads
-- ---------------------------------------------------------------------------
-- The planning settings for the UI (cap, intervals, working days, default class).
create or replace function api.planning_settings() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not (authz.has_permission('field.visit.plan') or authz.has_permission('field.visit.read')) then
    raise exception 'PERMISSION_DENIED: field.visit.plan' using errcode = '42501';
  end if;
  return field.planning_config() - 'work_dows' || jsonb_build_object('today', core.business_date());
end $$;

-- Coverage for any period of up to 367 days: per customer in the caller's crm.customer.read scope, the
-- class target vs completed visit-days in the period, and the overdue verdict as of today (Cairo).
-- Visits by every employee count (coverage is about the customer), so this reads as definer and scopes
-- itself: no field.visit.read = no rows; customers only within crm.customer.read (all / territory / assigned).
create or replace function api.coverage(p_from date, p_to date)
returns table (
  customer_id uuid, customer_no text, customer_name text, territory_id uuid, lifecycle_stage text,
  employee_id uuid, employee_name_en text, employee_name_ar text,
  visit_class text, class_is_default boolean, interval_days int,
  period_start date, period_end date, target_visits int, actual_visits int, target_met boolean,
  last_visit_on date, days_since_last_visit int, next_due_on date, is_overdue boolean, overdue_days int,
  next_planned_on date)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_cfg jsonb := field.planning_config();
  v_today date := core.business_date();
  v_days int;
begin
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 366 then
    raise exception 'VALIDATION: the period must be 1 to 367 days' using errcode = 'P0001';
  end if;
  v_days := p_to - p_from + 1;
  return query
  with s as materialized (
    select authz.has_permission('field.visit.read') as can_read,
           authz.has_global('crm.customer.read') as g,
           authz.territory_ids('crm.customer.read') as t,
           authz.assigned_customer_ids('crm.customer.read') as a
  ), base as (
    select c.id as cid, c.customer_no as cno, c.display_name as cname, c.territory_id as terr,
           c.lifecycle_stage as stage, rep.employee_id as rep_id,
           coalesce(f.visit_class, v_cfg ->> 'default_class') as cls, f.visit_class is null as is_default,
           (select max((v.check_in_at at time zone 'Africa/Cairo')::date) from field.visits v
             where v.customer_id = c.id and v.status = 'completed'
               and (v.check_in_at at time zone 'Africa/Cairo')::date <= v_today) as last_on,
           (select count(distinct (v.check_in_at at time zone 'Africa/Cairo')::date)::int from field.visits v
             where v.customer_id = c.id and v.status = 'completed'
               and v.check_in_at >= (p_from::timestamp at time zone 'Africa/Cairo')
               and v.check_in_at < ((p_to + 1)::timestamp at time zone 'Africa/Cairo')) as done,
           (select min(v.planned_for) from field.visits v
             where v.customer_id = c.id and v.status = 'planned' and v.planned_for >= v_today) as next_plan
    from crm.customers c
    cross join s
    left join field.visit_frequencies f on f.customer_id = c.id
    left join lateral (select a.employee_id from crm.customer_assignments a
                       where a.customer_id = c.id and a.valid_to is null
                       order by (a.role = 'primary_rep') desc, a.valid_from limit 1) rep on true
    where s.can_read and (s.g or c.territory_id = any(s.t) or c.id = any(s.a))
      and c.archived_at is null and c.lifecycle_stage <> 'lost'
  ), k as (
    select b.*, (v_cfg -> 'intervals' ->> b.cls)::int as iv,
           greatest(1, round(v_days::numeric / (v_cfg -> 'intervals' ->> b.cls)::int))::int as target
    from base b
  )
  select k.cid, k.cno, k.cname, k.terr, k.stage,
         k.rep_id, emp.full_name_en, emp.full_name_ar,
         k.cls, k.is_default, k.iv,
         p_from, p_to, k.target, k.done, k.done >= k.target,
         k.last_on, v_today - k.last_on,
         coalesce(k.last_on + k.iv, v_today),
         k.last_on is null or v_today - k.last_on > k.iv,
         case when k.last_on is null then null else greatest(0, v_today - k.last_on - k.iv) end,
         k.next_plan
  from k
  left join core.employees emp on emp.id = k.rep_id;
end $$;

-- This month's coverage (Cairo).
create or replace view api.v_coverage with (security_invoker = true) as
  select * from api.coverage(date_trunc('month', core.business_date())::date,
                             (date_trunc('month', core.business_date()) + interval '1 month')::date - 1);

-- Planned visits by employee and week (weeks start on Sunday). Cancelled plans are left out.
create or replace view api.v_visit_plan with (security_invoker = true) as
  select v.id, v.employee_id, emp.full_name_en as employee_name_en, emp.full_name_ar as employee_name_ar,
         v.customer_id, c.customer_no, c.display_name as customer_name,
         coalesce(f.visit_class, (select field.planning_config() ->> 'default_class')) as visit_class,
         v.planned_for, v.planned_for - extract(dow from v.planned_for)::int as week_start,
         extract(dow from v.planned_for)::int as day_of_week,
         v.status, v.verification_status, v.check_in_at, v.check_out_at, v.outcome,
         (v.status = 'planned' and v.check_in_at is null and v.planned_for >= core.business_date()) as can_unplan,
         (v.status in ('planned','missed') and v.planned_for < core.business_date()) as is_missed,
         v.created_at
  from field.visits v
  left join crm.customers c on c.id = v.customer_id
  left join field.visit_frequencies f on f.customer_id = v.customer_id
  left join lateral crm.employee_display(v.employee_id) emp on true
  where v.planned_for is not null and v.status <> 'cancelled';

-- Who the caller can plan for (self first in the UI).
create or replace view api.v_planning_employees with (security_invoker = true) as
  select * from field.plannable_employees();

-- Open customer assignments the caller can see (RLS on crm.customers / assignments): the add-visit picker.
create or replace view api.v_planning_customers with (security_invoker = true) as
  select a.employee_id, a.customer_id, a.role as assignment_role, c.customer_no, c.display_name as customer_name,
         c.lifecycle_stage, coalesce(f.visit_class, (select field.planning_config() ->> 'default_class')) as visit_class
  from crm.customer_assignments a
  join crm.customers c on c.id = a.customer_id
  left join field.visit_frequencies f on f.customer_id = a.customer_id
  where a.valid_to is null and c.archived_at is null and c.lifecycle_stage <> 'lost';

-- ---------------------------------------------------------------------------
-- 8. Privileges (explicit; never a blanket grant on a schema)
-- ---------------------------------------------------------------------------
revoke execute on function field.planning_interval_value(jsonb, text, int) from public, anon, authenticated;
revoke execute on function field.planning_lock(text) from public, anon, authenticated;
revoke execute on function field.planning_check_employee(uuid) from public, anon, authenticated;
-- Needed by the views above (test 17: client-executable definer helpers must be).
revoke execute on function field.planning_config() from public, anon;
grant execute on function field.planning_config() to authenticated;
revoke execute on function field.plannable_employees() from public, anon;
grant execute on function field.plannable_employees() to authenticated;

grant select on api.v_coverage, api.v_visit_plan, api.v_planning_employees, api.v_planning_customers to authenticated;
revoke all on api.v_coverage, api.v_visit_plan, api.v_planning_employees, api.v_planning_customers from anon;

do $$
declare f text;
begin
  foreach f in array array[
    'api.set_visit_frequency(uuid, text)',
    'api.plan_visits(uuid, jsonb, uuid)',
    'api.unplan_visit(uuid)',
    'api.generate_plan(uuid, date)',
    'api.planning_settings()',
    'api.coverage(date, date)']
  loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
