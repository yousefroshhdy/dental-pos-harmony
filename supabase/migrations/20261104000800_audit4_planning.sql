-- Honest OS migration: audit 4 (area F) planning fixes. Redefines the planning commands and reads of
-- 20261103000900_planning.sql, keeping all their other rules.
--
--   F2  api.plan_visits enforces planning.daily_visit_cap per employee and day (existing visits included,
--       cancelled ones not), under the employee lock it already takes. api.generate_plan no longer scans
--       arrays inside its per-day loop: occurrences are taken from day buckets in a fixed priority order
--       (same result as before), existing visits are a per-customer bitmask, and output is built once at
--       the end. At most 1,000 customers per call (the most due first; the rest are counted as
--       'customers_skipped'), and a 5 s budget checked inside the loop. A function-level
--       `set statement_timeout` does not work here: PostgreSQL arms that timer when the top-level
--       statement starts, so a SET attached to a function changes nothing for the running call.
--   F5  api.generate_plan only considers customers in the caller's crm.customer.read scope.
--       api.plan_visits treats a customer outside that scope exactly like one that is not assigned to the
--       employee (NOT_ASSIGNED, no number, no archived state), so nothing about it can be learned or planned.
--   F6  field.visits.planned_by (new, nullable) records who planned a visit. api.unplan_visit refuses to
--       remove a visit planned by someone else unless the caller is that planner or has field.visit.plan
--       scope over the planner, and tells the planner when someone else removes it. api.v_visit_plan gets
--       may_unplan (state and this rule; can_unplan keeps meaning "the state allows it"). Visits planned before this migration are backfilled from
--       field.visit_plan_batches; a visit with no planner keeps the old rule.
--   F9  api.coverage aggregates completed visits once (one grouped pass joined back) instead of three
--       correlated subqueries per customer. Same columns, same scope, same results.
--
-- Non-destructive: one nullable column, two indexes, one helper, function redefinitions, one view column added.

-- ---------------------------------------------------------------------------
-- 1. Who planned a visit (F6)
-- ---------------------------------------------------------------------------
alter table field.visits add column if not exists planned_by uuid references auth.users(id);
comment on column field.visits.planned_by is
  'The user who planned the visit with api.plan_visits (null: not planned through it; older plans are backfilled from field.visit_plan_batches).';

create index if not exists idx_visits_planned_by on field.visits (planned_by);

update field.visits v set planned_by = b.requested_by
from field.visit_plan_batches b
where v.id = any(b.visit_ids) and v.planned_by is null;

-- Daily-cap counts (F2): an employee's unplanned check-ins on a Cairo day.
create index if not exists idx_visits_employee_unplanned_check_in on field.visits (employee_id, check_in_at)
  where planned_for is null;

-- May the caller remove a visit planned by p_planned_by? Yes when nobody is recorded (older visits), when
-- the caller planned it, or when the caller has field.visit.plan scope over the planner. The visit's own
-- employee scope is checked separately by api.unplan_visit. Used by api.v_visit_plan (may_unplan).
create or replace function field.unplan_allowed(p_planned_by uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_planned_by is null
      or p_planned_by = auth.uid()
      or authz.has_global('field.visit.plan')
      or exists (select 1 from core.employees e
                 where e.user_id = p_planned_by and authz.employee_in_scope('field.visit.plan', e.id))
$$;

-- ---------------------------------------------------------------------------
-- 2. api.plan_visits: daily cap (F2), read scope (F5), planned_by (F6)
-- ---------------------------------------------------------------------------
-- Create planned visits for one employee. p_visits = [{"customer_id": uuid, "date": "YYYY-MM-DD"}, …].
-- All or nothing; idempotent on p_client_ref (a replay returns the first answer with replayed = true).
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
  select x.d, x.n into v_over_d, v_over_n
  from (select u.d,
               (select count(*)::int from field.visits v
                 where v.employee_id = v_emp and v.status <> 'cancelled' and v.planned_for = u.d)
             + (select count(*)::int from field.visits v
                 where v.employee_id = v_emp and v.status <> 'cancelled' and v.planned_for is null
                   and v.check_in_at >= (u.d::timestamp at time zone 'Africa/Cairo')
                   and v.check_in_at < ((u.d + 1)::timestamp at time zone 'Africa/Cairo')) as n
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
-- 3. api.unplan_visit: the planner decides (F6)
-- ---------------------------------------------------------------------------
-- Remove a planned visit: only while it is still 'planned', not checked in, and today or later; and, when
-- someone else planned it, only by that planner or someone with field.visit.plan scope over them.
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
  if not field.unplan_allowed(v_v.planned_by) then
    raise exception 'PERMISSION_DENIED: this visit was planned by someone else; ask them to change it' using errcode = '42501';
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
  select user_id into v_user from core.employees where id = v_v.employee_id;
  if v_v.employee_id is distinct from v_me then
    perform notify.send_in_app(v_user, 'planning.visit_unplanned', 'A planned visit was removed',
      format('A visit planned for %s was removed from your plan.', v_v.planned_for), '/planning',
      jsonb_build_object('visit_id', v_v.id, 'planned_for', v_v.planned_for));
  end if;
  -- The planner hears about it when someone else removed it (once, if the planner is also the employee).
  if v_v.planned_by is not null and v_v.planned_by is distinct from auth.uid()
     and not (v_v.planned_by is not distinct from v_user and v_v.employee_id is distinct from v_me) then
    perform notify.send_in_app(v_v.planned_by, 'planning.planned_visit_removed', 'A visit you planned was removed',
      format('A visit you planned for %s was removed from the plan.', v_v.planned_for), '/planning',
      jsonb_build_object('visit_id', v_v.id, 'planned_for', v_v.planned_for, 'employee_id', v_v.employee_id));
  end if;
  return jsonb_build_object('visit_id', v_v.id, 'status', 'cancelled', 'replayed', false);
end $$;

-- ---------------------------------------------------------------------------
-- 4. The generator (F2, F5): a proposal for one employee and month. Writes nothing.
-- ---------------------------------------------------------------------------
-- Same rules as 20261103000900: each assigned customer (not archived, not lost, and now only those in the
-- caller's crm.customer.read scope) is due one interval after its last completed visit (never visited or
-- overdue = due on the first plannable day). Occurrences are taken in due order, then class A before B
-- before C, then the longest since a visit, then customer number. An existing visit of this employee
-- before the next occurrence would fall due covers it. Otherwise the visit goes on the least-loaded working
-- day from a quarter interval before to half an interval after its due day (ties: the closest to the due
-- day), else the first later working day with room. A day never exceeds planning.daily_visit_cap,
-- existing visits included. Occurrences that find no room are returned as 'unscheduled'.
--
-- How it stays linear: the tie-break keys after the due day never change, so customers are numbered once
-- in that order; due days only move forward, so days are walked in order and each day's customers are taken
-- by number. A customer whose next due day is still the current day (or earlier) is the next occurrence
-- and is handled at once. Existing visits are one bitmask per customer (bit k = day v_start + k).
create or replace function api.generate_plan(p_employee_id uuid, p_month date)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  c_max_customers constant int := 1000;
  c_budget constant interval := interval '5 seconds';
  v_t0 timestamptz := clock_timestamp();
  v_emp uuid := coalesce(p_employee_id, authz.current_employee_id());
  v_today date := core.business_date();
  v_cfg jsonb := field.planning_config();
  v_cap int := (v_cfg ->> 'daily_cap')::int;
  v_dows int[] := array(select x::int from jsonb_array_elements_text(v_cfg -> 'work_dows') x);
  v_e core.employees%rowtype;
  v_g boolean; v_terr uuid[]; v_assigned uuid[];
  v_m0 date; v_m1 date; v_start date;
  d_dates date[]; d_load int[]; d_existing int[]; v_nd int;
  c_ids uuid[]; c_nos text[]; c_names text[]; c_class text[]; c_last date[];
  c_int int[]; c_due date[]; c_prev date[]; c_mask bigint[];
  v_n int; v_total int;
  o_i int[] := '{}'; o_date date[] := '{}'; o_due date[] := '{}'; o_reason text[] := '{}';
  u_i int[] := '{}'; u_due date[] := '{}';
  v_d date; v_bucket int[]; v_i int; v_k int; v_pick int; v_tol int; v_early int; v_due date; v_e_date date;
  v_lo int; v_hi int; v_steps int := 0;
  v_props jsonb; v_unsched jsonb; v_days jsonb;
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

  -- Working days left in the month, with the visits the employee already has on each (one grouped pass).
  select coalesce(array_agg(g.d order by g.d), '{}'), coalesce(array_agg(coalesce(x.n, 0) order by g.d), '{}')
    into d_dates, d_existing
  from (select s::date as d from generate_series(v_start, v_m1, interval '1 day') s) g
  left join (select coalesce(v.planned_for, (v.check_in_at at time zone 'Africa/Cairo')::date) as d, count(*)::int as n
             from field.visits v
             where v.employee_id = v_emp and v.status <> 'cancelled'
               and (v.planned_for between v_start and v_m1
                    or (v.planned_for is null
                        and v.check_in_at >= (v_start::timestamp at time zone 'Africa/Cairo')
                        and v.check_in_at < ((v_m1 + 1)::timestamp at time zone 'Africa/Cairo')))
             group by 1) x on x.d = g.d
  where extract(dow from g.d)::int = any(v_dows);
  d_load := d_existing;
  v_nd := coalesce(array_length(d_dates, 1), 0);

  -- The employee's customers that the caller can read (F5), their last completed visit (by anyone, Cairo
  -- day), the most due first when there are more than c_max_customers; numbered in tie-break order.
  v_g := authz.has_global('crm.customer.read');
  v_terr := authz.territory_ids('crm.customer.read');
  v_assigned := authz.assigned_customer_ids('crm.customer.read');
  with cs as (
    select c.id, c.customer_no, c.display_name, coalesce(f.visit_class, v_cfg ->> 'default_class') as cls
    from crm.customers c
    left join field.visit_frequencies f on f.customer_id = c.id
    where c.archived_at is null and c.lifecycle_stage <> 'lost'
      and exists (select 1 from crm.customer_assignments a
                  where a.customer_id = c.id and a.employee_id = v_emp and a.valid_to is null)
      and (v_g or c.territory_id = any(v_terr) or c.id = any(v_assigned))
  ), lv as (
    select v.customer_id, max((v.check_in_at at time zone 'Africa/Cairo')::date) as last_on
    from field.visits v
    where v.customer_id in (select cs.id from cs) and v.status = 'completed'
      and (v.check_in_at at time zone 'Africa/Cairo')::date <= v_today
    group by v.customer_id
  ), r as (
    select cs.id, cs.customer_no, cs.display_name, cs.cls, lv.last_on,
           (v_cfg -> 'intervals' ->> cs.cls)::int as iv, count(*) over () as total
    from cs left join lv on lv.customer_id = cs.id
  ), top as (
    select r.*, case when r.last_on is null then v_start else greatest(v_start, r.last_on + r.iv) end as due0
    from r
    order by due0, r.cls, r.last_on nulls first, r.customer_no
    limit c_max_customers
  )
  select coalesce(array_agg(t.id order by t.cls, t.last_on nulls first, t.customer_no), '{}'),
         coalesce(array_agg(t.customer_no order by t.cls, t.last_on nulls first, t.customer_no), '{}'),
         coalesce(array_agg(t.display_name order by t.cls, t.last_on nulls first, t.customer_no), '{}'),
         coalesce(array_agg(t.cls order by t.cls, t.last_on nulls first, t.customer_no), '{}'),
         coalesce(array_agg(t.last_on order by t.cls, t.last_on nulls first, t.customer_no), '{}'),
         coalesce(array_agg(t.iv order by t.cls, t.last_on nulls first, t.customer_no), '{}'),
         coalesce(array_agg(t.due0 order by t.cls, t.last_on nulls first, t.customer_no), '{}'),
         coalesce(max(t.total), 0)
    into c_ids, c_nos, c_names, c_class, c_last, c_int, c_due, v_total
  from top t;
  v_n := coalesce(array_length(c_ids, 1), 0);
  c_prev := c_last;

  -- Visits the employee already has in the window (planned, in progress or done), per customer.
  select coalesce(array_agg(coalesce(m.mask, 0) order by u.i), '{}') into c_mask
  from unnest(c_ids) with ordinality u(id, i)
  left join (select v.customer_id, bit_or((1::bigint) << (v.planned_for - v_start)) as mask
             from field.visits v
             where v.employee_id = v_emp and v.status <> 'cancelled' and v.planned_for between v_start and v_m1
             group by v.customer_id) m on m.customer_id = u.id;

  v_d := v_start;
  <<days>>
  while v_d <= v_m1 and v_n > 0 loop
    v_bucket := array(select u.i::int from unnest(c_due) with ordinality u(d, i) where u.d = v_d order by u.i);
    foreach v_i in array v_bucket loop
      loop
        v_steps := v_steps + 1;
        exit days when v_steps > 20000;
        if clock_timestamp() - v_t0 > c_budget then
          raise exception 'TIMEOUT: the plan took too long to work out; try fewer customers' using errcode = 'P0001';
        end if;
        v_due := c_due[v_i];

        -- An existing visit before the occurrence after this one would fall due covers this one.
        v_e_date := null;
        if c_mask[v_i] <> 0 then
          v_lo := greatest(coalesce(c_prev[v_i] + 1, v_start), v_start) - v_start;
          v_hi := least(v_due + c_int[v_i] - 1, v_m1) - v_start;
          for v_k in v_lo .. v_hi loop
            if (c_mask[v_i] >> v_k) & 1 = 1 then v_e_date := v_start + v_k; exit; end if;
          end loop;
        end if;

        if v_e_date is not null then
          c_prev[v_i] := v_e_date;
          c_due[v_i] := v_e_date + c_int[v_i];
        else
          -- Place it: the least-loaded working day from a quarter interval early to half an interval late
          -- (ties: the closest to the due day, then the earlier), else the first later day with room.
          v_tol := c_int[v_i] / 2;
          v_early := c_int[v_i] / 4;
          v_pick := null;
          for v_k in 1 .. v_nd loop
            continue when d_dates[v_k] < v_due - v_early or d_dates[v_k] <= coalesce(c_prev[v_i], '-infinity'::date)
                       or d_load[v_k] >= v_cap
                       or (c_mask[v_i] >> (d_dates[v_k] - v_start)) & 1 = 1;
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
            u_i := u_i || v_i;
            u_due := u_due || v_due;
            c_due[v_i] := null;
            exit;
          end if;

          o_i := o_i || v_i;
          o_date := o_date || d_dates[v_pick];
          o_due := o_due || v_due;
          o_reason := o_reason || (case when c_prev[v_i] is distinct from c_last[v_i] then 'due'
                                        when c_last[v_i] is null then 'never_visited'
                                        when c_last[v_i] + c_int[v_i] < v_today then 'overdue'
                                        else 'due' end);
          d_load[v_pick] := d_load[v_pick] + 1;
          c_prev[v_i] := d_dates[v_pick];
          c_due[v_i] := greatest(v_due + c_int[v_i], d_dates[v_pick] + (c_int[v_i] + 1) / 2);
        end if;
        -- Due on a later day: that day's bucket takes it (or the month is over for it).
        exit when c_due[v_i] > v_d;
      end loop;
    end loop;
    v_d := v_d + 1;
  end loop;

  select coalesce(jsonb_agg(jsonb_build_object('date', d, 'existing', e, 'proposed', l - e) order by d), '[]')
    into v_days from unnest(d_dates, d_existing, d_load) u(d, e, l);

  select coalesce(jsonb_agg(jsonb_build_object(
           'customer_id', c.id, 'customer_no', c.no, 'customer_name', c.name,
           'visit_class', c.cls, 'date', o.d, 'due_on', o.due, 'last_visit_on', c.last,
           'reason', o.reason) order by o.d, c.no), '[]')
    into v_props
  from unnest(o_i, o_date, o_due, o_reason) o(i, d, due, reason)
  join unnest(c_ids, c_nos, c_names, c_class, c_last) with ordinality c(id, no, name, cls, last, i) on c.i = o.i;

  select coalesce(jsonb_agg(jsonb_build_object(
           'customer_id', c.id, 'customer_no', c.no, 'customer_name', c.name,
           'visit_class', c.cls, 'due_on', u.due, 'reason', 'no_capacity') order by u.k), '[]')
    into v_unsched
  from unnest(u_i, u_due) with ordinality u(i, due, k)
  join unnest(c_ids, c_nos, c_names, c_class) with ordinality c(id, no, name, cls, i) on c.i = u.i;

  return jsonb_build_object(
    'employee_id', v_emp, 'month', v_m0, 'from', v_start, 'to', v_m1,
    'daily_cap', v_cap, 'work_days', v_cfg -> 'work_days', 'customers', v_n,
    'customers_skipped', greatest(v_total - v_n, 0),
    'days', v_days,
    'proposals', v_props,
    'unscheduled', v_unsched);
end $$;

-- ---------------------------------------------------------------------------
-- 5. Coverage (F9): one grouped pass over visits, same columns, scope and results
-- ---------------------------------------------------------------------------
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
  ), base as materialized (
    select c.id as cid, c.customer_no as cno, c.display_name as cname, c.territory_id as terr,
           c.lifecycle_stage as stage,
           coalesce(f.visit_class, v_cfg ->> 'default_class') as cls, f.visit_class is null as is_default
    from crm.customers c
    cross join s
    left join field.visit_frequencies f on f.customer_id = c.id
    where s.can_read and (s.g or c.territory_id = any(s.t) or c.id = any(s.a))
      and c.archived_at is null and c.lifecycle_stage <> 'lost'
  ), vd as (
    -- Completed visit-days (Cairo) of these customers: several visits on one day count once.
    select v.customer_id as cid, (v.check_in_at at time zone 'Africa/Cairo')::date as d
    from field.visits v
    where v.status = 'completed' and v.customer_id in (select b.cid from base b)
    group by 1, 2
  ), agg as (
    select vd.cid,
           max(vd.d) filter (where vd.d <= v_today) as last_on,
           (count(*) filter (where vd.d between p_from and p_to))::int as done
    from vd
    group by vd.cid
  ), nxt as (
    select v.customer_id as cid, min(v.planned_for) as next_plan
    from field.visits v
    where v.status = 'planned' and v.planned_for >= v_today and v.customer_id in (select b.cid from base b)
    group by 1
  ), rep as (
    select distinct on (a.customer_id) a.customer_id as cid, a.employee_id as rep_id
    from crm.customer_assignments a
    where a.valid_to is null and a.customer_id in (select b.cid from base b)
    order by a.customer_id, (a.role = 'primary_rep') desc, a.valid_from, a.id
  ), k as (
    select b.*, rep.rep_id, agg.last_on, coalesce(agg.done, 0) as done, nxt.next_plan,
           (v_cfg -> 'intervals' ->> b.cls)::int as iv,
           greatest(1, round(v_days::numeric / (v_cfg -> 'intervals' ->> b.cls)::int))::int as target
    from base b
    left join agg on agg.cid = b.cid
    left join nxt on nxt.cid = b.cid
    left join rep on rep.cid = b.cid
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

-- ---------------------------------------------------------------------------
-- 6. The week plan view (F6): may_unplan (new, last column) = can_unplan (the visit's state allows it) and
--    the caller may remove it (field.unplan_allowed). The screens show "Remove" from may_unplan.
-- ---------------------------------------------------------------------------
create or replace view api.v_visit_plan with (security_invoker = true) as
  select v.id, v.employee_id, emp.full_name_en as employee_name_en, emp.full_name_ar as employee_name_ar,
         v.customer_id, c.customer_no, c.display_name as customer_name,
         coalesce(f.visit_class, (select field.planning_config() ->> 'default_class')) as visit_class,
         v.planned_for, v.planned_for - extract(dow from v.planned_for)::int as week_start,
         extract(dow from v.planned_for)::int as day_of_week,
         v.status, v.verification_status, v.check_in_at, v.check_out_at, v.outcome,
         (v.status = 'planned' and v.check_in_at is null and v.planned_for >= core.business_date()) as can_unplan,
         (v.status in ('planned','missed') and v.planned_for < core.business_date()) as is_missed,
         v.created_at,
         (v.status = 'planned' and v.check_in_at is null and v.planned_for >= core.business_date()
          and field.unplan_allowed(v.planned_by)) as may_unplan
  from field.visits v
  left join crm.customers c on c.id = v.customer_id
  left join field.visit_frequencies f on f.customer_id = v.customer_id
  left join lateral crm.employee_display(v.employee_id) emp on true
  where v.planned_for is not null and v.status <> 'cancelled';

-- ---------------------------------------------------------------------------
-- 7. Privileges (explicit; never a blanket grant on a schema)
-- ---------------------------------------------------------------------------
-- Needed by api.v_visit_plan (test 17: client-executable definer helpers must be used by a view or policy).
revoke execute on function field.unplan_allowed(uuid) from public, anon;
grant execute on function field.unplan_allowed(uuid) to authenticated;
grant select on api.v_visit_plan to authenticated;
revoke all on api.v_visit_plan from anon;

do $$
declare f text;
begin
  foreach f in array array[
    'api.plan_visits(uuid, jsonb, uuid)',
    'api.unplan_visit(uuid)',
    'api.generate_plan(uuid, date)',
    'api.coverage(date, date)']
  loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
