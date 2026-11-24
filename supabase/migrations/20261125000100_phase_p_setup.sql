-- Honest OS migration: Phase P step 1 (setup and real data), part 1 of 2: setup.
--
--   Catalogue        api.create_brand / api.create_category (catalog.product.manage, company-wide;
--                    audited): the old system's items need brands STEP and GENERIC and the category
--                    IMPLANT_PARTS (child of IMPLANT), which the owner adds on /admin/setup.
--   Customers        api.create_customer accepts a customer without a phone (owner decision A: 45 of
--                    the 58 migrated customers have none). api.v_customer_data_gaps lists customers
--                    whose phone or GPS pin is still missing, so reps complete them on the next visit.
--   Employees        base address and point (geocoded or typed), lead radius (decision E, default
--                    5 km): core.employees columns + api.set_employee_base_location + a read view.
--   Warehouses       api.create_warehouse under the new permission inventory.warehouse.manage
--                    (company-wide; the owner holds it implicitly, no role is granted it).
--   Setup screen     api.setup_overview (owner only): counts for the /admin/setup checklist.
--   Logins           api.authorize_sign_in_link (owner only, admin.user.create): the database check
--                    and security event that come BEFORE the server asks Supabase Auth for a one-time
--                    invite / sign-in link (no SMTP yet, so e-mail invites do not arrive).
--
-- Additive only: new columns (nullable, or with a default), functions, views, one permission,
-- two audit triggers. api.create_customer is restated from its latest definition
-- (20261030000800_create_customer_scope.sql); only the blocks marked "Phase P" change.
-- Tests: supabase/tests/database/55_phase_p_setup.test.sql.

-- ---------------------------------------------------------------------------
-- 1. Brands and categories: there was no command to add one. The old system's items need
--    brands STEP and GENERIC and the category IMPLANT_PARTS (child of IMPLANT); the owner adds
--    them on /admin/setup through these commands (not seeded: brand lists are business data).
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'trg_audit' and tgrelid = 'catalog.brands'::regclass) then
    create trigger trg_audit after insert or update or delete on catalog.brands
      for each row execute function audit.log_change();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'trg_audit' and tgrelid = 'catalog.categories'::regclass) then
    create trigger trg_audit after insert or update or delete on catalog.categories
      for each row execute function audit.log_change();
  end if;
end $$;

-- Idempotent by code: an existing brand is returned unchanged (created = false).
create or replace function api.create_brand(p_code text, p_name text, p_country_of_origin text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_code text; v_name text := nullif(btrim(p_name), ''); v_id uuid;
begin
  perform catalog._require_global('catalog.product.manage');
  v_code := catalog._clean_code(p_code, 'brand code');
  if v_name is null or length(v_name) < 2 or length(v_name) > 120 or v_name ~ '[[:cntrl:]]' then
    raise exception 'VALIDATION: brand name must be 2-120 characters' using errcode = 'P0001';
  end if;
  if length(p_country_of_origin) > 80 then
    raise exception 'VALIDATION: country is too long' using errcode = 'P0001';
  end if;
  select b.id into v_id from catalog.brands b where upper(b.code) = v_code;
  if v_id is not null then return jsonb_build_object('brand_id', v_id, 'code', v_code, 'created', false); end if;
  insert into catalog.brands (code, name, country_of_origin)
  values (v_code, v_name, nullif(btrim(p_country_of_origin), ''))
  on conflict (code) do nothing
  returning id into v_id;
  if v_id is null then
    select b.id into v_id from catalog.brands b where b.code = v_code;
    return jsonb_build_object('brand_id', v_id, 'code', v_code, 'created', false);
  end if;
  perform catalog._emit('brand.created', 'catalog.brand', v_id, jsonb_build_object('brand_id', v_id, 'code', v_code));
  return jsonb_build_object('brand_id', v_id, 'code', v_code, 'created', true);
end $$;

create or replace function api.create_category(p_code text, p_name_en text, p_name_ar text, p_parent_code text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_code text; v_en text := nullif(btrim(p_name_en), ''); v_ar text := nullif(btrim(p_name_ar), '');
  v_parent uuid; v_id uuid;
begin
  perform catalog._require_global('catalog.product.manage');
  v_code := catalog._clean_code(p_code, 'category code');
  if v_en is null or length(v_en) < 2 or length(v_en) > 120 or v_ar is null or length(v_ar) < 2 or length(v_ar) > 120 then
    raise exception 'VALIDATION: category names (English and Arabic) must be 2-120 characters' using errcode = 'P0001';
  end if;
  if nullif(btrim(p_parent_code), '') is not null then
    select c.id into v_parent from catalog.categories c where upper(c.code) = upper(btrim(p_parent_code));
    if v_parent is null then raise exception 'NOT_FOUND: parent category' using errcode = 'P0002'; end if;
  end if;
  select c.id into v_id from catalog.categories c where upper(c.code) = v_code;
  if v_id is not null then return jsonb_build_object('category_id', v_id, 'code', v_code, 'created', false); end if;
  insert into catalog.categories (code, name_en, name_ar, parent_id)
  values (v_code, v_en, v_ar, v_parent)
  on conflict (code) do nothing
  returning id into v_id;
  if v_id is null then
    select c.id into v_id from catalog.categories c where c.code = v_code;
    return jsonb_build_object('category_id', v_id, 'code', v_code, 'created', false);
  end if;
  perform catalog._emit('category.created', 'catalog.category', v_id,
    jsonb_build_object('category_id', v_id, 'code', v_code, 'parent_id', v_parent));
  return jsonb_build_object('category_id', v_id, 'code', v_code, 'created', true);
end $$;

-- ---------------------------------------------------------------------------
-- 2. api.create_customer: the phone is optional (Phase P). Restated from
--    20261030000800_create_customer_scope.sql; same signature, grants kept.
-- ---------------------------------------------------------------------------
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
  -- Phase P: a customer may be created without a phone. It is then "phone missing"
  -- (api.v_customer_data_gaps) until a rep adds one with api.update_customer. A phone that IS
  -- given must still be a valid Egyptian number (core.to_phone_e164 raises VALIDATION).
  v_phone := core.to_phone_e164(p_phone_primary, 'phone_primary');
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
  -- Phase P: skipped when there is no phone (soft duplicates below still warn).
  if v_phone is not null then
    select c.id, c.customer_no into v_dup_id, v_dup_no from crm.customers c
    where c.phone_primary = v_phone and c.archived_at is null limit 1;
  end if;
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
  -- Phase P: tell the caller the record still needs a phone.
  if v_phone is null then
    v_warnings := v_warnings || jsonb_build_array(jsonb_build_object('code', 'PHONE_MISSING'));
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
    if v_phone is not null then
      select c.customer_no into v_dup_no from crm.customers c
      where c.phone_primary = v_phone and c.archived_at is null limit 1;
    end if;
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
    'source', p_source, 'phone_missing', v_phone is null));

  return jsonb_build_object('customer_id', v_id, 'customer_no', v_no, 'territory_id', v_territory,
                            'owner_employee_id', v_owner, 'warnings', v_warnings, 'replayed', false);
end $$;

-- ---------------------------------------------------------------------------
-- 3. Customers whose data is still incomplete (phone or verified GPS pin missing).
--    security_invoker: the caller's crm.customers RLS decides which rows come back. A customer
--    with nothing missing has no row; the CRM list can left-join on customer_id.
-- ---------------------------------------------------------------------------
create or replace view api.v_customer_data_gaps with (security_invoker = true) as
  select c.id as customer_id, c.customer_no, c.display_name, c.lifecycle_stage, c.source,
         c.governorate_code, c.city, c.territory_id,
         (c.phone_primary is null) as phone_missing,
         (c.latitude is null) as location_missing,
         (select a.employee_id from crm.customer_assignments a
           where a.customer_id = c.id and a.role = 'primary_rep' and a.valid_to is null
           order by a.valid_from desc limit 1) as primary_rep_employee_id,
         c.created_at
  from crm.customers c
  where c.archived_at is null
    and (c.phone_primary is null or c.latitude is null);

grant select on api.v_customer_data_gaps to authenticated;
revoke all on api.v_customer_data_gaps from anon;

-- ---------------------------------------------------------------------------
-- 4. Employee base location and lead radius (decision E). Written only by
--    api.set_employee_base_location; audited by the existing trg_audit on core.employees
--    (base_lat / base_lng are masked in audit row images by the '%\_lat' / '%\_lng' rules).
-- ---------------------------------------------------------------------------
alter table core.employees
  add column if not exists base_address text,
  add column if not exists base_lat numeric(9,6),
  add column if not exists base_lng numeric(9,6),
  add column if not exists base_location_source text,
  add column if not exists base_set_at timestamptz,
  add column if not exists lead_radius_km numeric(5,2) not null default 5;

alter table core.employees
  add constraint employees_base_address_len check (base_address is null or length(base_address) between 3 and 300),
  add constraint employees_base_lat_egypt check (base_lat between 21.5 and 32.0),        -- Egypt bounding box
  add constraint employees_base_lng_egypt check (base_lng between 24.5 and 37.5),
  add constraint employees_base_point_pair check ((base_lat is null) = (base_lng is null)),
  add constraint employees_base_source check (
    (base_lat is null and base_location_source is null)
    or (base_lat is not null and base_location_source in ('geocoded', 'manual'))),
  add constraint employees_lead_radius check (lead_radius_km >= 0.5 and lead_radius_km <= 50);

comment on column core.employees.base_address is 'Phase P: where the rep starts the day (lead discovery centre). Personal data.';
comment on column core.employees.base_lat is 'Phase P: base point latitude (WGS84); geocoded from base_address or typed by the admin.';
comment on column core.employees.base_lng is 'Phase P: base point longitude (WGS84).';
comment on column core.employees.base_location_source is 'geocoded (Google Geocoding API) | manual (typed or picked by the admin)';
comment on column core.employees.lead_radius_km is 'Decision E: lead discovery radius around the base point, km (default 5; owner can change per rep).';

create or replace function api.set_employee_base_location(
  p_employee_id    uuid,
  p_address        text,
  p_lat            numeric,
  p_lng            numeric,
  p_source         text default 'manual',
  p_lead_radius_km numeric default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_old core.employees%rowtype;
  v_address text := nullif(btrim(p_address), '');
  v_lat numeric := round(p_lat, 6);
  v_lng numeric := round(p_lng, 6);
  v_source text;
  v_radius numeric;
  v_changed boolean;
begin
  perform authz.require('core.employee.manage');
  select * into v_old from core.employees where id = p_employee_id for update;
  if not found then raise exception 'NOT_FOUND: employee' using errcode = 'P0002'; end if;
  if not core.employee_in_scope('core.employee.manage', p_employee_id) then
    raise exception 'PERMISSION_DENIED: employee is outside your scope' using errcode = '42501';
  end if;
  if core.user_holds_owner_role(v_old.user_id) and not authz.is_owner() then
    raise exception 'OWNER_ONLY: only an owner can edit an owner''s record' using errcode = '42501';
  end if;
  -- The base point drives which leads a rep is given: like territories, not self-service.
  if p_employee_id = authz.current_employee_id() and not authz.is_owner() then
    raise exception 'SELF_GRANT_FORBIDDEN: you cannot change your own base location' using errcode = '42501';
  end if;

  if (v_lat is null) <> (v_lng is null) then
    raise exception 'VALIDATION: latitude and longitude go together' using errcode = 'P0001';
  end if;
  if v_lat is not null and not (v_lat between 21.5 and 32.0 and v_lng between 24.5 and 37.5) then
    raise exception 'VALIDATION: the point is outside Egypt' using errcode = 'P0001';
  end if;
  if v_address is not null and (length(v_address) < 3 or length(v_address) > 300 or v_address ~ '[[:cntrl:]]') then
    raise exception 'VALIDATION: the address must be 3-300 characters' using errcode = 'P0001';
  end if;
  if v_lat is not null then
    v_source := coalesce(nullif(btrim(p_source), ''), 'manual');
    if v_source not in ('geocoded', 'manual') then
      raise exception 'VALIDATION: unknown location source %', v_source using errcode = 'P0001';
    end if;
  end if;
  v_radius := coalesce(p_lead_radius_km, v_old.lead_radius_km);
  if v_radius < 0.5 or v_radius > 50 then
    raise exception 'VALIDATION: the lead radius must be between 0.5 and 50 km' using errcode = 'P0001';
  end if;
  v_radius := round(v_radius, 2);

  v_changed := (v_address, v_lat, v_lng, v_source, v_radius)
               is distinct from (v_old.base_address, v_old.base_lat, v_old.base_lng, v_old.base_location_source, v_old.lead_radius_km);
  if v_changed then
    update core.employees
       set base_address = v_address, base_lat = v_lat, base_lng = v_lng, base_location_source = v_source,
           lead_radius_km = v_radius, base_set_at = now()
     where id = p_employee_id;
    -- For the lead-discovery job (Phase P step 4). No coordinates or address in the event:
    -- the location stays in Postgres; the consumer reads it through the database.
    insert into integration.outbox (event_type, aggregate_type, aggregate_id, payload)
    values ('employee.base_location_changed', 'core.employee', p_employee_id,
            jsonb_build_object('employee_id', p_employee_id, 'has_base_location', v_lat is not null,
                               'lead_radius_km', v_radius, 'source', v_source));
  end if;

  return jsonb_build_object('employee_id', p_employee_id, 'has_base_location', v_lat is not null,
                            'source', v_source, 'lead_radius_km', v_radius, 'changed', v_changed);
end $$;

-- Read model: the base point of each employee the caller may read (own row, or core.employee.read
-- in scope: core.employees RLS through security_invoker).
create or replace view api.v_employee_base_locations with (security_invoker = true) as
  select e.id as employee_id, e.employee_no, e.full_name_en, e.full_name_ar, e.job_title, e.employment_status,
         e.user_id, e.base_address, e.base_lat, e.base_lng, e.base_location_source, e.lead_radius_km, e.base_set_at
  from core.employees e;

grant select on api.v_employee_base_locations to authenticated;
revoke all on api.v_employee_base_locations from anon;

-- ---------------------------------------------------------------------------
-- 5. Warehouses: creation for the setup screen.
-- ---------------------------------------------------------------------------
insert into authz.permissions (code, module, description, allowed_scopes, supports_limit, is_sensitive)
values ('inventory.warehouse.manage', 'inventory', 'Create warehouses (setup)', '{all}', false, false)
on conflict (code) do nothing;

-- p_warehouse_id is client-generated: a retried request with the same id and code is a replay.
-- Negative stock stays off (allow_negative = false); changing that policy is not part of setup.
create or replace function api.create_warehouse(p_warehouse_id uuid, p_code text, p_name text, p_kind text default 'main')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_code text := upper(btrim(p_code));
  v_name text := nullif(btrim(p_name), '');
  v_kind text := coalesce(nullif(btrim(p_kind), ''), 'main');
  v_old inventory.warehouses%rowtype;
begin
  perform authz.require('inventory.warehouse.manage');
  if not authz.has_global('inventory.warehouse.manage') then
    raise exception 'PERMISSION_DENIED: inventory.warehouse.manage needs company-wide scope' using errcode = '42501';
  end if;
  if p_warehouse_id is null then raise exception 'VALIDATION: warehouse id is required' using errcode = 'P0001'; end if;
  if v_code is null or v_code !~ '^[A-Z0-9][A-Z0-9._-]{1,39}$' then
    raise exception 'VALIDATION: warehouse code must be 2-40 letters, digits, dot, dash or underscore' using errcode = 'P0001';
  end if;
  if v_name is null or length(v_name) < 2 or length(v_name) > 120 or v_name ~ '[[:cntrl:]]' then
    raise exception 'VALIDATION: warehouse name must be 2-120 characters' using errcode = 'P0001';
  end if;
  if v_kind not in ('main', 'branch', 'rep_stock', 'quarantine', 'transit') then
    raise exception 'VALIDATION: unknown warehouse kind %', v_kind using errcode = 'P0001';
  end if;

  select * into v_old from inventory.warehouses where id = p_warehouse_id;
  if found then
    if upper(v_old.code) <> v_code then
      raise exception 'CONFLICT: this warehouse id was used for another warehouse' using errcode = 'P0001';
    end if;
    return jsonb_build_object('warehouse_id', v_old.id, 'code', v_old.code, 'kind', v_old.kind, 'created', false);
  end if;
  if exists (select 1 from inventory.warehouses where upper(code) = v_code) then
    raise exception 'DUPLICATE_CODE: warehouse code % is already used', v_code using errcode = 'P0001';
  end if;

  begin
    insert into inventory.warehouses (id, code, name, kind, allow_negative, is_active)
    values (p_warehouse_id, v_code, v_name, v_kind, false, true);
  exception when unique_violation then
    raise exception 'DUPLICATE_CODE: warehouse code % is already used', v_code using errcode = 'P0001';
  end;
  insert into integration.outbox (event_type, aggregate_type, aggregate_id, payload)
  values ('inventory.warehouse_created', 'inventory.warehouse', p_warehouse_id,
          jsonb_build_object('warehouse_id', p_warehouse_id, 'code', v_code, 'kind', v_kind));
  return jsonb_build_object('warehouse_id', p_warehouse_id, 'code', v_code, 'kind', v_kind, 'created', true);
end $$;

-- ---------------------------------------------------------------------------
-- 6. Setup checklist (owner only). Counts only; no names, phones or amounts.
-- ---------------------------------------------------------------------------
create or replace function api.setup_overview()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare v_reps uuid[];
begin
  if not authz.is_owner() then
    raise exception 'OWNER_ONLY: the setup overview is for the owner' using errcode = '42501';
  end if;
  select coalesce(array_agg(distinct e.id), '{}') into v_reps
  from core.employees e
  join authz.user_roles ur on ur.user_id = e.user_id and ur.revoked_at is null
       and ur.valid_from <= now() and (ur.valid_to is null or ur.valid_to > now())
  join authz.roles r on r.id = ur.role_id and r.code = 'sales_rep'
  where e.employment_status = 'active';

  return jsonb_build_object(
    'main_warehouses', (select count(*) from inventory.warehouses w where w.is_active and w.kind = 'main'),
    'warehouses', (select count(*) from inventory.warehouses w where w.is_active),
    'territories', (select count(*) from core.territories t where t.is_active),
    'territories_with_coverage', (select count(distinct tc.territory_id) from core.territory_coverage tc
                                  join core.territories t on t.id = tc.territory_id and t.is_active),
    'employees', (select count(*) from core.employees e where e.employment_status = 'active'),
    'employees_with_login', (select count(*) from core.employees e where e.employment_status = 'active' and e.user_id is not null),
    'roles', (select coalesce(jsonb_object_agg(x.code, x.n), '{}'::jsonb) from (
                select r.code, count(distinct ur.user_id) as n
                from authz.user_roles ur join authz.roles r on r.id = ur.role_id
                where ur.revoked_at is null and ur.valid_from <= now() and (ur.valid_to is null or ur.valid_to > now())
                group by r.code) x),
    'reps', cardinality(v_reps),
    'reps_with_base_location', (select count(*) from core.employees e where e.id = any(v_reps) and e.base_lat is not null),
    'customers', (select count(*) from crm.customers c where c.archived_at is null),
    'customers_phone_missing', (select count(*) from crm.customers c where c.archived_at is null and c.phone_primary is null),
    'variants', (select count(*) from catalog.product_variants v where v.status = 'active'),
    'default_list_prices', (select count(*) from catalog.price_list_items i
                            join catalog.price_lists pl on pl.id = i.price_list_id
                            where pl.code = 'DEFAULT' and pl.is_active),
    'stock_units', (select coalesce(sum(b.on_hand), 0) from inventory.stock_balances b),
    'opening_ar_entries', (select count(*) from finance.customer_ledger l where l.entry_type = 'opening_balance'),
    -- Brands and categories the legacy converter's products file uses that do not exist yet.
    'legacy_catalog_missing', (select coalesce(jsonb_agg(x.code order by x.code), '[]'::jsonb) from (
                                 select v.code from (values ('STEP'), ('GENERIC')) v(code)
                                 where not exists (select 1 from catalog.brands b where b.code = v.code and b.is_active)
                                 union all
                                 select 'IMPLANT_PARTS' where not exists (select 1 from catalog.categories c where c.code = 'IMPLANT_PARTS')) x),
    'imports_committed', (select coalesce(jsonb_object_agg(x.kind, x.n), '{}'::jsonb) from (
                            select b.kind, count(*) as n from import.batches b where b.status = 'committed' group by b.kind) x));
end $$;

-- ---------------------------------------------------------------------------
-- 7. One-time invite / sign-in links (no SMTP yet). The server calls this as the owner FIRST;
--    only if it succeeds does it ask Supabase Auth (service role) for a link for the e-mail this
--    returns, and it shows that link once to the owner. Nothing about the link is stored.
--    mode 'invite' = the employee has no login yet (Auth creates it; api.register_user links it);
--    mode 'magiclink' = an existing, active, non-owner login.
-- ---------------------------------------------------------------------------
create or replace function api.authorize_sign_in_link(p_employee_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_emp core.employees%rowtype; v_status text; v_mode text;
begin
  perform authz.require('admin.user.create');
  if not authz.is_owner() then
    raise exception 'OWNER_ONLY: only an owner can issue sign-in links' using errcode = '42501';
  end if;
  select * into v_emp from core.employees where id = p_employee_id;
  if not found then raise exception 'NOT_FOUND: employee' using errcode = 'P0002'; end if;
  if v_emp.employment_status <> 'active' then
    raise exception 'INVALID_STATE: employee is %', v_emp.employment_status using errcode = 'P0001';
  end if;
  if v_emp.email is null then
    raise exception 'VALIDATION: the employee has no e-mail address' using errcode = 'P0001';
  end if;
  if v_emp.user_id is null then
    v_mode := 'invite';
  else
    if v_emp.user_id = auth.uid() then
      raise exception 'INVALID_STATE: you are already signed in' using errcode = 'P0001';
    end if;
    if core.user_holds_owner_role(v_emp.user_id) then
      raise exception 'PERMISSION_DENIED: sign-in links are not issued for owner logins' using errcode = '42501';
    end if;
    select up.status into v_status from core.user_profiles up where up.user_id = v_emp.user_id;
    if v_status is distinct from 'active' then
      raise exception 'INVALID_STATE: the login is %', coalesce(v_status, 'not registered') using errcode = 'P0001';
    end if;
    v_mode := 'magiclink';
  end if;
  perform authz.log_security_event('sign_in_link_issued', 'warning',
    jsonb_build_object('target_employee', p_employee_id, 'target_user', v_emp.user_id, 'mode', v_mode));
  return jsonb_build_object('employee_id', p_employee_id, 'user_id', v_emp.user_id,
                            'email', v_emp.email::text, 'mode', v_mode);
end $$;

-- ---------------------------------------------------------------------------
-- 8. Privileges (explicit; PostgreSQL's global PUBLIC execute revoked, gotcha of suite 08)
-- ---------------------------------------------------------------------------
do $$
declare f text;
begin
  foreach f in array array[
    'api.create_brand(text, text, text)',
    'api.create_category(text, text, text, text)',
    'api.set_employee_base_location(uuid, text, numeric, numeric, text, numeric)',
    'api.create_warehouse(uuid, text, text, text)',
    'api.setup_overview()',
    'api.authorize_sign_in_link(uuid)']
  loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
