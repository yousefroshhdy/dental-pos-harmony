-- Honest OS migration: read surface the CRM screens need (Phase 3 UI).
--
-- Gaps closed (PostgREST exposes only `api`, so these had no client path):
--   api.v_governorates               reference list for the customer form (required field)
--   api.v_specialties                reference list for the form and the list filter
--   api.v_crm_assignable_employees   active colleagues a customer can be reassigned to
--                                    (reps hold no core.employee.read, so api.v_employees
--                                    shows them only themselves)
--   api.find_duplicate_customers     pre-check before api.create_customer, so the user can
--                                    confirm or cancel BEFORE a record exists (the command
--                                    itself only warns after inserting)
--
-- Additive only: new views and functions, no change to existing objects.

-- ---------------------------------------------------------------------------
-- 1. Reference lists (RLS on the base tables: any active user)
-- ---------------------------------------------------------------------------
create or replace view api.v_governorates with (security_invoker = true) as
  select g.code, g.name_en, g.name_ar from core.governorates g;

create or replace view api.v_specialties with (security_invoker = true) as
  select s.code, s.name_en, s.name_ar from crm.specialties s;

-- ---------------------------------------------------------------------------
-- 2. Reassignment targets
-- ---------------------------------------------------------------------------
-- Colleague names are not sensitive inside the company (see crm.employee_display);
-- only identity and job title are returned, never contact details. Self-scoping:
-- empty unless the caller is active and holds crm.customer.read (the permission
-- api.request_customer_reassignment requires).
create or replace function crm.assignable_employees()
returns table (id uuid, employee_no text, full_name_en text, full_name_ar text, job_title text)
language sql stable security definer set search_path = '' as $$
  with me as (select authz.is_active_user() and authz.has_permission('crm.customer.read') as allowed)
  select e.id, e.employee_no, e.full_name_en, e.full_name_ar, e.job_title
  from me
  join core.employees e on me.allowed
  join core.user_profiles p on p.employee_id = e.id and p.status = 'active'
  where e.employment_status = 'active'
$$;

create or replace view api.v_crm_assignable_employees with (security_invoker = true) as
  select a.id, a.employee_no, a.full_name_en, a.full_name_ar, a.job_title
  from crm.assignable_employees() a;

-- ---------------------------------------------------------------------------
-- 3. Duplicate pre-check
-- ---------------------------------------------------------------------------
-- Same rules as api.create_customer: a hard duplicate is the same primary phone on
-- an active customer; a soft duplicate is a similar display name (trigram >= 0.6)
-- in the same governorate. Like the command, it reveals customer numbers only,
-- never names or owners. Read-only.
create or replace function api.find_duplicate_customers(
  p_doctor_name      text default null,
  p_clinic_name      text default null,
  p_phone_primary    text default null,
  p_governorate_code text default null,
  p_display_name     text default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_display text;
  v_phone core.phone_e164;
  v_gov text := upper(nullif(btrim(p_governorate_code), ''));
  v_hard text;
  v_count int := 0;
  v_similar text[] := '{}';
begin
  perform authz.require('crm.customer.create');

  v_display := coalesce(nullif(btrim(p_display_name), ''),
                        crm.compose_display_name(p_clinic_name, p_doctor_name));
  v_phone := core.to_phone_e164(p_phone_primary, 'phone_primary');

  if v_phone is not null then
    select c.customer_no into v_hard from crm.customers c
    where c.phone_primary = v_phone and c.archived_at is null limit 1;
  end if;

  -- Very short names match too much to be a useful warning.
  if v_display is not null and length(v_display) >= 3 and v_gov is not null then
    select count(*)::int, coalesce((array_agg(s.customer_no order by s.sim desc, s.customer_no))[1:10], '{}')
      into v_count, v_similar
    from (select c.customer_no, extensions.similarity(c.display_name, v_display) as sim
          from crm.customers c
          where c.governorate_code = v_gov and c.archived_at is null
            and extensions.similarity(c.display_name, v_display) >= 0.6) s;
  end if;

  return jsonb_build_object(
    'phone_duplicate_customer_no', v_hard,
    'similar_count', v_count,
    'similar_customer_nos', to_jsonb(v_similar));
end $$;

-- ---------------------------------------------------------------------------
-- 4. Privileges
-- ---------------------------------------------------------------------------
grant select on api.v_governorates, api.v_specialties, api.v_crm_assignable_employees to authenticated;
revoke all on api.v_governorates, api.v_specialties, api.v_crm_assignable_employees from anon;

-- The view runs as the invoker, so authenticated needs execute; the function is
-- self-scoping (returns nothing without crm.customer.read).
revoke execute on function crm.assignable_employees() from public, anon;
grant execute on function crm.assignable_employees() to authenticated;

revoke execute on function api.find_duplicate_customers(text, text, text, text, text) from public, anon;
grant execute on function api.find_duplicate_customers(text, text, text, text, text) to authenticated;
