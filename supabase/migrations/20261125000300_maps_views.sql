-- Honest OS migration: Phase P step 3 (Google Maps), read side.
--
--   api.v_customer_map             one row per live customer for the customers map: pin, stage,
--                                  primary rep, territory, overdue flag (masked like the balance),
--                                  last visit. security_invoker: the caller's customer RLS applies,
--                                  exactly as for api.v_customers.
--   api.v_team_last_location       the last usable point of each rep, during an OPEN shift only
--                                  (D-14). security_invoker: the work_shifts / location_pings RLS
--                                  (field.tracking.read scope, or the rep's own) applies.
--   api.tracking_day_visit_fixes   the visit check-in / check-out fixes of one rep and Cairo day,
--                                  for the rep day map. Same scope as api.tracking_day, plus
--                                  field.location.read (raw visit fixes, ADR-010).
--
-- Helpers used by the views run as SECURITY DEFINER and are referenced by a view (suite 17 sweep).

-- ---------------------------------------------------------------------------
-- 1. Overdue receivables per customer, only for customers whose balance the caller may read
--    (crm.customer_balance.read scope, same rule as crm.customer_balances_in_scope). Open amount
--    = total - allocations - credit notes - write-offs, as in api.v_ar_aging.
-- ---------------------------------------------------------------------------
create or replace function crm.customer_overdue_in_scope()
returns table (customer_id uuid, overdue_amount numeric, max_days_overdue int)
language sql stable security definer set search_path = '' as $$
  with s as materialized (
    select authz.has_global('crm.customer_balance.read') as g,
           authz.territory_ids('crm.customer_balance.read') as t,
           authz.assigned_customer_ids('crm.customer_balance.read') as a,
           core.business_date() as today)
  , inv as (
    select i.customer_id, (s.today - i.due_date)::int as days,
           i.total - coalesce((select sum(pa.amount) from finance.payment_allocations pa where pa.invoice_id = i.id), 0)
                   - coalesce((select sum(cn.amount + cn.tax_amount) from finance.credit_notes cn where cn.invoice_id = i.id), 0)
                   - coalesce((select sum(w.amount) from finance.invoice_write_offs w where w.invoice_id = i.id), 0)
             as open_amount
    from s, finance.invoices i join crm.customers c on c.id = i.customer_id
    where (s.g or c.territory_id = any(s.t) or c.id = any(s.a))
      and i.status in ('issued','partially_paid') and i.due_date < s.today
  )
  select inv.customer_id, sum(inv.open_amount)::numeric(14,2), max(inv.days)
  from inv where inv.open_amount > 0
  group by inv.customer_id
$$;

-- ---------------------------------------------------------------------------
-- 2. Customers map
-- ---------------------------------------------------------------------------
create or replace view api.v_customer_map with (security_invoker = true) as
  select c.id, c.customer_no, c.display_name, c.kind, c.lifecycle_stage, c.city, c.governorate_code,
         c.latitude, c.longitude, c.location_verified,
         c.territory_id, t.code as territory_code, t.name_en as territory_name_en, t.name_ar as territory_name_ar,
         pr.employee_id as primary_rep_employee_id, rep.full_name_en as primary_rep_name_en,
         rep.full_name_ar as primary_rep_name_ar,
         -- NULL = masked (no crm.customer_balance.read for this customer), like v_customers.balance.
         case when bs.visible then coalesce(od.overdue_amount, 0) > 0 end as is_overdue,
         case when bs.visible then coalesce(od.overdue_amount, 0)::numeric(14,2) end as overdue_amount,
         case when bs.visible then od.max_days_overdue end as max_days_overdue,
         -- Visits the caller may read (field.visits RLS): a rep sees their own visits' dates.
         lv.last_visit_at,
         (lv.last_visit_at at time zone 'Africa/Cairo')::date as last_visit_on
  from crm.customers c
  left join core.territories t on t.id = c.territory_id
  left join lateral (select a.employee_id from crm.customer_assignments a
                     where a.customer_id = c.id and a.role = 'primary_rep' and a.valid_to is null
                     limit 1) pr on true
  left join lateral crm.employee_display(pr.employee_id) rep on true
  left join lateral (select max(v.check_in_at) as last_visit_at from field.visits v
                     where v.customer_id = c.id and v.check_in_at is not null
                       and v.status in ('in_progress','completed')) lv on true
  left join crm.customer_overdue_in_scope() od on od.customer_id = c.id
  cross join lateral (select (
       (select authz.has_global('crm.customer_balance.read'))
    or c.territory_id = any((select authz.territory_ids('crm.customer_balance.read'))::uuid[])
    or c.id = any((select authz.assigned_customer_ids('crm.customer_balance.read'))::uuid[])) as visible) bs
  where c.archived_at is null;

-- ---------------------------------------------------------------------------
-- 3. Team map: last point per rep during an open shift only (D-14)
-- ---------------------------------------------------------------------------
-- The shift cap as an interval (tracking.max_shift_hours, default 10). field.tracking_num is
-- internal (not client-callable), and the view runs as the caller, so it needs its own helper.
create or replace function field.open_shift_max_interval() returns interval
language sql stable security definer set search_path = '' as $$
  select coalesce((select (s.value #>> '{}')::numeric from core.system_settings s
                   where s.key = 'tracking.max_shift_hours'), 10) * interval '1 hour'
$$;

-- An open shift past the cap is "overdue" (closed by tracking_close_stale on the next command
-- or the auto-close job): it is not an open working day any more, so it is not shown.
-- The point is the latest usable ping (not low_accuracy / impossible_travel / duplicate_fix);
-- before the first ping, the start-of-day fix.
create or replace view api.v_team_last_location with (security_invoker = true) as
  select ws.employee_id, emp.full_name_en, emp.full_name_ar,
         ws.id as shift_id, ws.window_start as shift_started_at,
         case when lp.id is not null then 'ping' else 'shift_start' end as point_source,
         coalesce(lp.latitude, ws.start_latitude) as latitude,
         coalesce(lp.longitude, ws.start_longitude) as longitude,
         case when lp.id is not null then lp.accuracy_m else ws.start_accuracy_m end as accuracy_m,
         coalesce(lp.captured_at, ws.window_start) as captured_at,
         coalesce(lp.anomaly_flags, '{}') as anomaly_flags,
         lp.source
  from field.work_shifts ws
  left join lateral (select p.id, p.latitude, p.longitude, p.accuracy_m, p.captured_at, p.anomaly_flags, p.source
                     from field.location_pings p
                     where p.shift_id = ws.id
                       and not (p.anomaly_flags && array['low_accuracy','impossible_travel','duplicate_fix'])
                     order by p.captured_at desc, p.id desc
                     limit 1) lp on true
  left join lateral crm.employee_display(ws.employee_id) emp on true
  where ws.status = 'open'
    and now() < ws.window_start + (select field.open_shift_max_interval())
    and (lp.id is not null or ws.start_latitude is not null);

-- ---------------------------------------------------------------------------
-- 4. Visit fixes for the rep day map
-- ---------------------------------------------------------------------------
-- Raw visit fixes are field.location_events (ADR-010: more sensitive than the visit verdict,
-- readable by the rep and by field.location.read). The day must be readable (tracking scope,
-- same check as api.tracking_day); without field.location.read covering the rep the list is
-- empty (the map then shows the visits from the timeline only), never an error.
create or replace function api.tracking_day_visit_fixes(p_employee_id uuid, p_day date)
returns table (visit_id uuid, customer_id uuid, event_type text, latitude numeric, longitude numeric,
               accuracy_m numeric, captured_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_me uuid := authz.current_employee_id();
  v_from timestamptz := (p_day::timestamp at time zone 'Africa/Cairo');
  v_to timestamptz := ((p_day + 1)::timestamp at time zone 'Africa/Cairo');
begin
  if not authz.is_active_user() then raise exception 'PERMISSION_DENIED: inactive user' using errcode = '42501'; end if;
  if p_employee_id is null or p_day is null then
    raise exception 'VALIDATION: employee and day are required' using errcode = 'P0001';
  end if;
  if not (authz.has_global('field.tracking.read') or p_employee_id = any(authz.tracking_employee_ids())) then
    raise exception 'PERMISSION_DENIED: field.tracking.read' using errcode = '42501';
  end if;
  if not (p_employee_id = v_me or authz.has_global('field.location.read')
          or p_employee_id = any(authz.employee_ids('field.location.read'))) then
    return;
  end if;
  return query
    select le.visit_id, v.customer_id, le.event_type, le.latitude, le.longitude, le.accuracy_m, le.captured_at
    from field.location_events le
    join field.visits v on v.id = le.visit_id
    where le.employee_id = p_employee_id and le.latitude is not null and le.longitude is not null
      and le.captured_at >= v_from and le.captured_at < v_to
    order by le.captured_at, le.id;
end $$;

-- ---------------------------------------------------------------------------
-- 5. Privileges (explicit; PostgreSQL grants PUBLIC execute on new functions, test 08)
-- ---------------------------------------------------------------------------
grant select on api.v_customer_map, api.v_team_last_location to authenticated;
revoke all on api.v_customer_map, api.v_team_last_location from anon;

-- Needed by the views above, which run as the caller (suite 17: referenced by a view).
revoke execute on function crm.customer_overdue_in_scope() from public, anon;
grant execute on function crm.customer_overdue_in_scope() to authenticated;
revoke execute on function field.open_shift_max_interval() from public, anon;
grant execute on function field.open_shift_max_interval() to authenticated;

revoke execute on function api.tracking_day_visit_fixes(uuid, date) from public, anon;
grant execute on function api.tracking_day_visit_fixes(uuid, date) to authenticated;
