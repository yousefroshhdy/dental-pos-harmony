-- Follow-up to the 2026-10-30 audit, F7: api.create_customer named existing
-- customers in its DUPLICATE_CUSTOMER error and POSSIBLE_DUPLICATE warning
-- regardless of the caller's scope. Now a customer number is revealed only if
-- the caller may read that customer; otherwise the caller learns only that a
-- match exists outside their scope (same contract as api.find_duplicate_customers).
-- Same signature, so existing grants are kept.

create or replace function api.create_customer(
  p_doctor_name      text default null,
  p_clinic_name      text default null,
  p_phone_primary    text default null,
  p_governorate_code text default null,
  p_city             text default null,
  p_kind             text default 'clinic',
  p_specialty_code   text default null,
  p_phone_secondary  text default null,
  p_email            text default null,
  p_address_line     text default null,
  p_source           text default 'field',
  p_tags             text[] default '{}',
  p_notes            text default null,
  p_territory_id     uuid default null,
  p_owner_employee_id uuid default null,
  p_client_ref       uuid default null,
  p_display_name     text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_emp uuid := authz.current_employee_id();
  v_existing crm.customers%rowtype;
  v_doctor text := nullif(btrim(p_doctor_name), '');
  v_clinic text := nullif(btrim(p_clinic_name), '');
  v_display text;
  v_phone core.phone_e164;
  v_phone2 core.phone_e164;
  v_gov text := upper(nullif(btrim(p_governorate_code), ''));
  v_city text := nullif(btrim(p_city), '');
  v_email text := nullif(btrim(p_email), '');
  v_tags text[];
  v_territory uuid;
  v_owner uuid;
  v_id uuid := gen_random_uuid();
  v_no text;
  v_dup_no text;
  v_similar_count int;
  v_dup_id uuid;
  v_hidden_similar int;
  v_similar text[];
  v_warnings jsonb := '[]'::jsonb;
begin
  perform authz.require('crm.customer.create');

  -- Idempotent replay from the offline queue: same client_ref → same answer.
  if p_client_ref is not null then
    select * into v_existing from crm.customers where client_ref = p_client_ref;
    if found then
      if v_existing.created_by is distinct from v_uid then
        raise exception 'CONFLICT: client_ref was already used by another request' using errcode = 'P0001';
      end if;
      return jsonb_build_object('customer_id', v_existing.id, 'customer_no', v_existing.customer_no,
                                'territory_id', v_existing.territory_id, 'warnings', '[]'::jsonb,
                                'replayed', true);
    end if;
  end if;

  -- Validation
  if v_doctor is null and v_clinic is null then
    raise exception 'VALIDATION: doctor_name or clinic_name is required' using errcode = 'P0001';
  end if;
  v_phone := core.to_phone_e164(p_phone_primary, 'phone_primary');
  if v_phone is null then
    raise exception 'VALIDATION: phone_primary is required' using errcode = 'P0001';
  end if;
  v_phone2 := core.to_phone_e164(p_phone_secondary, 'phone_secondary');
  if v_gov is null or not exists (select 1 from core.governorates where code = v_gov) then
    raise exception 'VALIDATION: unknown governorate %', coalesce(v_gov, '(none)') using errcode = 'P0001';
  end if;
  if coalesce(p_kind, 'clinic') not in ('clinic','doctor','hospital','university','lab','distributor') then
    raise exception 'VALIDATION: unknown customer kind %', p_kind using errcode = 'P0001';
  end if;
  if p_specialty_code is not null and not exists (select 1 from crm.specialties where code = p_specialty_code) then
    raise exception 'VALIDATION: unknown specialty %', p_specialty_code using errcode = 'P0001';
  end if;
  if p_source is not null and p_source not in ('field','referral','website','shopify','event','academy','import','other') then
    raise exception 'VALIDATION: unknown source %', p_source using errcode = 'P0001';
  end if;
  if v_email is not null and v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'VALIDATION: email is not valid' using errcode = 'P0001';
  end if;
  v_display := coalesce(nullif(btrim(p_display_name), ''), crm.compose_display_name(v_clinic, v_doctor));
  v_tags := array(select distinct btrim(t) from unnest(coalesce(p_tags, '{}')) t where btrim(t) <> '' order by 1);

  -- Hard duplicate: same primary phone on an active customer. The existing
  -- customer_no is revealed only if the caller may read that customer
  -- (audit 2026-10-30 follow-up to F7: no existence oracle outside scope).
  select c.id, c.customer_no into v_dup_id, v_dup_no from crm.customers c
  where c.phone_primary = v_phone and c.archived_at is null limit 1;
  if v_dup_id is not null then
    if authz.customer_in_scope('crm.customer.read', v_dup_id) then
      raise exception 'DUPLICATE_CUSTOMER: phone is already registered to customer %', v_dup_no
        using errcode = 'P0001', detail = jsonb_build_object('existing_customer_no', v_dup_no)::text,
              hint = 'Request access or a reassignment instead of creating a new record';
    end if;
    raise exception 'DUPLICATE_CUSTOMER: phone is already registered to a customer outside your scope'
      using errcode = 'P0001', detail = jsonb_build_object('outside_scope', true)::text,
            hint = 'Ask your manager; do not create a new record';
  end if;

  -- Territory: explicit (if within the caller's scope) → coverage map → caller's first territory.
  if p_territory_id is not null then
    if not exists (select 1 from core.territories where id = p_territory_id and is_active) then
      raise exception 'NOT_FOUND: territory' using errcode = 'P0002';
    end if;
    if not (authz.has_global('crm.customer.create')
            or p_territory_id = any(authz.territory_ids('crm.customer.create'))) then
      raise exception 'PERMISSION_DENIED: territory is outside your scope' using errcode = '42501';
    end if;
    v_territory := p_territory_id;
  else
    select tc.territory_id into v_territory
    from core.territory_coverage tc join core.territories t on t.id = tc.territory_id and t.is_active
    where tc.governorate_code = v_gov
      and (tc.city = '*' or lower(tc.city) = lower(v_city))
    order by (tc.city = '*'), tc.city
    limit 1;
    if v_territory is null and v_emp is not null then
      select et.territory_id into v_territory
      from core.employee_territories et join core.territories t on t.id = et.territory_id and t.is_active
      where et.employee_id = v_emp and et.valid_to is null
      order by et.valid_from, t.code
      limit 1;
    end if;
  end if;

  -- Owner (primary rep): an explicit employee needs team/territory/all scope over
  -- them; an own-scoped caller always owns what they create.
  if p_owner_employee_id is not null then
    if not exists (select 1 from core.employees where id = p_owner_employee_id and employment_status = 'active') then
      raise exception 'NOT_FOUND: active employee' using errcode = 'P0002';
    end if;
    if p_owner_employee_id is distinct from v_emp
       and not authz.employee_in_scope('crm.customer.create', p_owner_employee_id) then
      raise exception 'PERMISSION_DENIED: employee is outside your scope' using errcode = '42501';
    end if;
    v_owner := p_owner_employee_id;
  elsif authz.max_scope_rank('crm.customer.create') = authz.scope_rank('own') then
    if v_emp is null then raise exception 'NO_EMPLOYEE_PROFILE' using errcode = '42501'; end if;
    v_owner := v_emp;
  end if;

  -- Soft duplicates: similar name in the same governorate → warning, not a block.
  -- Only customers the caller may read are named; others are counted only.
  select count(*) filter (where s.visible)::int,
         coalesce((array_agg(s.customer_no order by s.sim desc, s.customer_no) filter (where s.visible))[1:10], '{}'),
         count(*) filter (where not s.visible)::int
    into v_similar_count, v_similar, v_hidden_similar
  from (select c.customer_no, extensions.similarity(c.display_name, v_display) as sim,
               authz.customer_in_scope('crm.customer.read', c.id) as visible
        from crm.customers c
        where c.governorate_code = v_gov and c.archived_at is null
          and extensions.similarity(c.display_name, v_display) >= 0.6) s;
  if v_similar_count > 0 or v_hidden_similar > 0 then
    v_warnings := jsonb_build_array(jsonb_build_object(
      'code', 'POSSIBLE_DUPLICATE', 'count', v_similar_count, 'customer_nos', to_jsonb(v_similar),
      'outside_scope', v_hidden_similar > 0));
  end if;

  v_no := core.next_document_no('CUS');
  begin
    insert into crm.customers (id, customer_no, kind, doctor_name, clinic_name, display_name, specialty_code,
                               lifecycle_stage, source, phone_primary, phone_secondary, email, address_line,
                               city, governorate_code, territory_id, tags, notes, created_by, client_ref)
    values (v_id, v_no, coalesce(p_kind, 'clinic'), v_doctor, v_clinic, v_display, p_specialty_code,
            'lead', p_source, v_phone, v_phone2, v_email, nullif(btrim(p_address_line), ''),
            v_city, v_gov, v_territory, v_tags, nullif(btrim(p_notes), ''), v_uid, p_client_ref);
  exception when unique_violation then
    select c.customer_no into v_dup_no from crm.customers c
    where c.phone_primary = v_phone and c.archived_at is null limit 1;
    if v_dup_no is not null then
      raise exception 'DUPLICATE_CUSTOMER: phone is already registered to customer %', v_dup_no
        using errcode = 'P0001', detail = jsonb_build_object('existing_customer_no', v_dup_no)::text;
    end if;
    raise exception 'CONFLICT: a concurrent request used the same client_ref' using errcode = 'P0001';
  end;

  perform crm._add_activity(v_id, v_emp, 'stage_change', 'Customer created as lead', 'crm.customers', v_id);
  if v_owner is not null then
    insert into crm.customer_assignments (customer_id, employee_id, role, assigned_by, reason)
    values (v_id, v_owner, 'primary_rep', v_uid, 'created');
    perform crm._add_activity(v_id, v_emp, 'assignment', 'Primary representative assigned', 'core.employees', v_owner);
    if v_owner is distinct from v_emp then
      perform crm._notify_employee(v_owner, 'customer.assigned', 'New customer assigned: ' || v_display,
                                   null, '/customers/' || v_id, jsonb_build_object('customer_id', v_id));
    end if;
  end if;

  perform crm._emit('customer.created', 'crm.customer', v_id, jsonb_build_object(
    'customer_id', v_id, 'customer_no', v_no, 'display_name', v_display, 'lifecycle_stage', 'lead',
    'governorate_code', v_gov, 'territory_id', v_territory, 'owner_employee_id', v_owner,
    'source', p_source));

  return jsonb_build_object('customer_id', v_id, 'customer_no', v_no, 'territory_id', v_territory,
                            'owner_employee_id', v_owner, 'warnings', v_warnings, 'replayed', false);
end $$;
