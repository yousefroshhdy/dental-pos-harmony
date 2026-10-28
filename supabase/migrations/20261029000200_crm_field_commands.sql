-- Honest OS migration: Phase 3 CRM, tasks and field-visit commands.
--
-- Commands (SECURITY DEFINER, authz.require + record scope, structured errors):
--   api.create_customer, api.update_customer, api.set_customer_location,
--   api.request_customer_reassignment, api.create_opportunity, api.move_opportunity,
--   api.create_task, api.complete_task, api.log_activity,
--   api.visit_check_out, api.request_visit_exception
-- Approval hooks (called by api.decide_approval; NOT executable by app users):
--   wf.on_decided_crm_customer_reassign(uuid, boolean)
--   wf.on_decided_field_visit_exception(uuid, boolean)
-- Read views (security_invoker): api.v_customers, api.v_customer_timeline,
--   api.v_opportunities, api.v_tasks, api.v_visits, api.v_my_today
-- Retention: field.purge_old_location_events() (pg_cron / service context only)
--
-- Non-destructive only: new columns, indexes, policies, triggers and functions.

-- ---------------------------------------------------------------------------
-- 1. Schema additions (expand only)
-- ---------------------------------------------------------------------------
-- Device idempotency keys for commands that an offline queue may replay.
alter table crm.customers add column if not exists client_ref uuid unique;
alter table work.tasks    add column if not exists client_ref uuid unique;

-- Retention scans by server receipt time (device clocks are not trusted).
create index if not exists idx_location_events_received on field.location_events (received_at);
create index if not exists idx_opportunities_customer on crm.opportunities (customer_id);
create index if not exists idx_opportunities_owner on crm.opportunities (owner_employee_id) where closed_at is null;
create index if not exists idx_tasks_ref on work.tasks (ref_table, ref_id) where ref_id is not null;
create index if not exists idx_customers_governorate on crm.customers (governorate_code) where archived_at is null;

-- History matters for the pipeline, tasks, visits (KPI disputes) and contacts.
do $$
declare t text;
begin
  foreach t in array array['crm.opportunities','crm.customer_contacts','work.tasks','field.visits'] loop
    if not exists (select 1 from pg_trigger where tgname = 'trg_audit' and tgrelid = t::regclass) then
      execute format('create trigger trg_audit after insert or update or delete on %s
                      for each row execute function audit.log_change()', t);
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Shared helpers
-- ---------------------------------------------------------------------------
-- Normalise common Egyptian phone spellings (01x…, 0020…, 20…, Arabic-Indic
-- digits, spaces/dashes) to E.164 and validate with the core.phone_e164 domain.
create or replace function core.to_phone_e164(p_raw text, p_field text default 'phone')
returns core.phone_e164 language plpgsql immutable set search_path = '' as $$
declare v text;
begin
  if p_raw is null or btrim(p_raw) = '' then return null; end if;
  v := translate(p_raw, '٠١٢٣٤٥٦٧٨٩', '0123456789');
  v := regexp_replace(v, '[[:space:]().-]', '', 'g');
  if v like '00%' then v := '+' || substr(v, 3); end if;
  if v ~ '^20[0-9]{9,10}$' then v := '+' || v;
  elsif v ~ '^0[0-9]{8,10}$' then v := '+20' || substr(v, 2);
  end if;
  return v::core.phone_e164;
exception when check_violation then
  raise exception 'VALIDATION: % is not a valid Egyptian phone number', p_field using errcode = 'P0001';
end $$;

-- Highest scope rank the caller holds for a permission (NULL = not held).
create or replace function authz.max_scope_rank(p_perm text) returns int
language sql stable security definer set search_path = '' as $$
  select max(authz.scope_rank(g.scope)) from authz.grants(p_perm) g
$$;

-- Record scope for customers: all / territory (incl. sub-territories) / own-team assignment.
create or replace function authz.customer_in_scope(p_perm text, p_customer_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select authz.has_global(p_perm)
      or exists (select 1 from crm.customers c
                 where c.id = p_customer_id and c.territory_id = any(authz.territory_ids(p_perm)))
      or p_customer_id = any(authz.assigned_customer_ids(p_perm))
$$;

-- Record scope for acting on behalf of another employee: all / own+team / members of my territories.
create or replace function authz.employee_in_scope(p_perm text, p_employee_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select authz.has_global(p_perm)
      or p_employee_id = any(authz.employee_ids(p_perm))
      or exists (select 1 from core.employee_territories et
                 where et.employee_id = p_employee_id and et.valid_to is null
                   and et.territory_id = any(authz.territory_ids(p_perm)))
$$;

-- Display name used for search and soft-duplicate detection.
create or replace function crm.compose_display_name(p_clinic text, p_doctor text) returns text
language sql immutable set search_path = '' as $$
  select coalesce(nullif(btrim(p_clinic), ''), nullif(btrim(p_doctor), ''))
$$;

-- Customer lifecycle state machine for manual changes. 'blocked' is set only by
-- finance/credit commands, never through api.update_customer.
create or replace function crm.stage_transition_allowed(p_from text, p_to text) returns boolean
language sql immutable set search_path = '' as $$
  select exists (select 1 from (values
    ('lead','prospect'), ('lead','active'), ('lead','lost'),
    ('prospect','lead'), ('prospect','active'), ('prospect','lost'),
    ('active','dormant'), ('active','lost'),
    ('dormant','active'), ('dormant','lost'),
    ('lost','lead'), ('lost','prospect')) v(f, t)
    where v.f = p_from and v.t = p_to)
$$;

-- Opportunity stage machine: open stages move freely; won/lost are terminal.
create or replace function crm.opportunity_transition_allowed(p_from text, p_to text) returns boolean
language sql immutable set search_path = '' as $$
  select p_from in ('new','qualified','proposal','negotiation')
     and p_to in ('new','qualified','proposal','negotiation','won','lost')
     and p_from <> p_to
$$;

create or replace function crm.default_probability(p_stage text) returns int
language sql immutable set search_path = '' as $$
  select case p_stage when 'new' then 10 when 'qualified' then 25 when 'proposal' then 50
                      when 'negotiation' then 75 when 'won' then 100 when 'lost' then 0 end
$$;

-- Employee names for read views (colleague names are not sensitive inside the
-- company; RLS on core.employees would otherwise hide a rep's name from finance).
create or replace function crm.employee_display(p_employee_id uuid)
returns table (full_name_en text, full_name_ar text)
language sql stable security definer set search_path = '' as $$
  select e.full_name_en, e.full_name_ar from core.employees e
  where e.id = p_employee_id and authz.is_active_user()
$$;

-- Balances the caller may see (crm.customer_balance.read scope). Reads the
-- ledger as definer so the masking does not depend on finance.ledger.read RLS,
-- and is self-scoping, so calling it directly reveals nothing extra.
create or replace function crm.customer_balances_in_scope()
returns table (customer_id uuid, balance numeric, last_movement_at timestamptz)
language sql stable security definer set search_path = '' as $$
  with s as (select authz.has_global('crm.customer_balance.read') as g,
                    authz.territory_ids('crm.customer_balance.read') as t,
                    authz.assigned_customer_ids('crm.customer_balance.read') as a)
  select l.customer_id, sum(l.amount)::numeric(14,2), max(l.posted_at)
  from s, finance.customer_ledger l join crm.customers c on c.id = l.customer_id
  where s.g or c.territory_id = any(s.t) or c.id = any(s.a)
  group by l.customer_id
$$;

-- Internal writers (not callable by app users; revoked at the end).
create or replace function crm._add_activity(p_customer_id uuid, p_employee_id uuid, p_type text, p_summary text,
                                             p_ref_table text default null, p_ref_id uuid default null,
                                             p_occurred_at timestamptz default now())
returns uuid language sql security definer set search_path = '' as $$
  insert into crm.activities (customer_id, employee_id, type, occurred_at, summary, ref_table, ref_id)
  values (p_customer_id, p_employee_id, p_type, coalesce(p_occurred_at, now()), p_summary, p_ref_table, p_ref_id)
  returning id
$$;

create or replace function crm._emit(p_event_type text, p_aggregate_type text, p_aggregate_id uuid, p_payload jsonb)
returns void language sql security definer set search_path = '' as $$
  insert into integration.outbox (event_type, aggregate_type, aggregate_id, payload)
  values (p_event_type, p_aggregate_type, p_aggregate_id, coalesce(p_payload, '{}'))
$$;

create or replace function crm._notify_employee(p_employee_id uuid, p_type text, p_title text,
                                                p_body text default null, p_link text default null,
                                                p_data jsonb default '{}')
returns void language sql security definer set search_path = '' as $$
  insert into notify.notifications (recipient_user_id, type, title, body, link, data)
  select e.user_id, p_type, p_title, p_body, p_link, coalesce(p_data, '{}')
  from core.employees e
  where e.id = p_employee_id and e.user_id is not null
    and e.user_id is distinct from auth.uid()        -- no self-notifications
$$;

-- ---------------------------------------------------------------------------
-- 3. Customers
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

  -- Hard duplicate: same primary phone on an active customer. Only the existing
  -- customer_no is revealed (the caller may not be allowed to see that record).
  select c.customer_no into v_dup_no from crm.customers c
  where c.phone_primary = v_phone and c.archived_at is null limit 1;
  if v_dup_no is not null then
    raise exception 'DUPLICATE_CUSTOMER: phone is already registered to customer %', v_dup_no
      using errcode = 'P0001', detail = jsonb_build_object('existing_customer_no', v_dup_no)::text,
            hint = 'Request access or a reassignment instead of creating a new record';
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
  select count(*)::int, coalesce((array_agg(s.customer_no order by s.sim desc, s.customer_no))[1:10], '{}')
    into v_similar_count, v_similar
  from (select c.customer_no, extensions.similarity(c.display_name, v_display) as sim
        from crm.customers c
        where c.governorate_code = v_gov and c.archived_at is null
          and extensions.similarity(c.display_name, v_display) >= 0.6) s;
  if v_similar_count > 0 then
    v_warnings := jsonb_build_array(jsonb_build_object(
      'code', 'POSSIBLE_DUPLICATE', 'count', v_similar_count, 'customer_nos', to_jsonb(v_similar)));
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

-- Whitelisted field update with optimistic concurrency. Territory, assignment,
-- credit terms and GPS location have their own governed commands.
create or replace function api.update_customer(p_customer_id uuid, p_version int, p_changes jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_old crm.customers%rowtype;
  v_new crm.customers%rowtype;
  v_allowed constant text[] := array['doctor_name','clinic_name','display_name','kind','specialty_code',
    'phone_primary','phone_secondary','email','address_line','city','governorate_code','tags','notes',
    'lifecycle_stage'];
  v_bad text;
  v_dup_no text;
  v_emp uuid := authz.current_employee_id();
begin
  perform authz.require('crm.customer.update');
  if p_changes is null or jsonb_typeof(p_changes) <> 'object' or p_changes = '{}'::jsonb then
    raise exception 'VALIDATION: changes must be a non-empty object' using errcode = 'P0001';
  end if;
  select string_agg(k, ', ' order by k) into v_bad
  from jsonb_object_keys(p_changes) k where not (k = any(v_allowed));
  if v_bad is not null then
    raise exception 'VALIDATION: field(s) cannot be changed here: %', v_bad using errcode = 'P0001';
  end if;

  select * into v_old from crm.customers where id = p_customer_id for update;
  if not found then raise exception 'NOT_FOUND: customer' using errcode = 'P0002'; end if;
  if not authz.customer_in_scope('crm.customer.update', p_customer_id) then
    raise exception 'PERMISSION_DENIED: customer not in your scope' using errcode = '42501';
  end if;
  if v_old.archived_at is not null then
    raise exception 'INVALID_STATE: customer is archived' using errcode = 'P0001';
  end if;

  v_new := v_old;
  if p_changes ? 'doctor_name' then v_new.doctor_name := nullif(btrim(p_changes ->> 'doctor_name'), ''); end if;
  if p_changes ? 'clinic_name' then v_new.clinic_name := nullif(btrim(p_changes ->> 'clinic_name'), ''); end if;
  if v_new.doctor_name is null and v_new.clinic_name is null then
    raise exception 'VALIDATION: doctor_name or clinic_name is required' using errcode = 'P0001';
  end if;
  if p_changes ? 'display_name' then
    v_new.display_name := coalesce(nullif(btrim(p_changes ->> 'display_name'), ''),
                                   crm.compose_display_name(v_new.clinic_name, v_new.doctor_name));
  elsif (v_new.doctor_name, v_new.clinic_name) is distinct from (v_old.doctor_name, v_old.clinic_name)
        and v_old.display_name is not distinct from crm.compose_display_name(v_old.clinic_name, v_old.doctor_name) then
    v_new.display_name := crm.compose_display_name(v_new.clinic_name, v_new.doctor_name);
  end if;
  if p_changes ? 'kind' then
    v_new.kind := p_changes ->> 'kind';
    if v_new.kind is null or v_new.kind not in ('clinic','doctor','hospital','university','lab','distributor') then
      raise exception 'VALIDATION: unknown customer kind %', coalesce(v_new.kind, '(none)') using errcode = 'P0001';
    end if;
  end if;
  if p_changes ? 'specialty_code' then
    v_new.specialty_code := nullif(btrim(p_changes ->> 'specialty_code'), '');
    if v_new.specialty_code is not null and not exists (select 1 from crm.specialties where code = v_new.specialty_code) then
      raise exception 'VALIDATION: unknown specialty %', v_new.specialty_code using errcode = 'P0001';
    end if;
  end if;
  if p_changes ? 'phone_primary' then
    v_new.phone_primary := core.to_phone_e164(p_changes ->> 'phone_primary', 'phone_primary');
    if v_new.phone_primary is null then
      raise exception 'VALIDATION: phone_primary cannot be removed' using errcode = 'P0001';
    end if;
  end if;
  if p_changes ? 'phone_secondary' then
    v_new.phone_secondary := core.to_phone_e164(p_changes ->> 'phone_secondary', 'phone_secondary');
  end if;
  if p_changes ? 'email' then
    v_new.email := nullif(btrim(p_changes ->> 'email'), '');
    if v_new.email is not null and v_new.email::text !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
      raise exception 'VALIDATION: email is not valid' using errcode = 'P0001';
    end if;
  end if;
  if p_changes ? 'address_line' then v_new.address_line := nullif(btrim(p_changes ->> 'address_line'), ''); end if;
  if p_changes ? 'city' then v_new.city := nullif(btrim(p_changes ->> 'city'), ''); end if;
  if p_changes ? 'notes' then v_new.notes := nullif(btrim(p_changes ->> 'notes'), ''); end if;
  if p_changes ? 'governorate_code' then
    v_new.governorate_code := upper(nullif(btrim(p_changes ->> 'governorate_code'), ''));
    if v_new.governorate_code is null or not exists (select 1 from core.governorates where code = v_new.governorate_code) then
      raise exception 'VALIDATION: unknown governorate %', coalesce(v_new.governorate_code, '(none)') using errcode = 'P0001';
    end if;
  end if;
  if p_changes ? 'tags' then
    if jsonb_typeof(p_changes -> 'tags') <> 'array' then
      raise exception 'VALIDATION: tags must be an array of strings' using errcode = 'P0001';
    end if;
    v_new.tags := array(select distinct btrim(t) from jsonb_array_elements_text(p_changes -> 'tags') t
                        where btrim(t) <> '' order by 1);
  end if;
  if p_changes ? 'lifecycle_stage' then
    v_new.lifecycle_stage := p_changes ->> 'lifecycle_stage';
    if v_new.lifecycle_stage is distinct from v_old.lifecycle_stage
       and not crm.stage_transition_allowed(v_old.lifecycle_stage, v_new.lifecycle_stage) then
      raise exception 'INVALID_STATE: customer cannot move from % to %', v_old.lifecycle_stage,
        coalesce(v_new.lifecycle_stage, '(none)') using errcode = 'P0001';
    end if;
  end if;

  -- A replay of an edit that is already applied is a no-op, whatever version it carries.
  if v_new is not distinct from v_old then
    return jsonb_build_object('customer_id', p_customer_id, 'version', v_old.version,
                              'lifecycle_stage', v_old.lifecycle_stage, 'changed', false);
  end if;
  if p_version is distinct from v_old.version then
    raise exception 'CONFLICT: customer was changed by someone else (your version %, current %)',
      coalesce(p_version::text, 'null'), v_old.version
      using errcode = 'P0001',
            detail = jsonb_build_object('current_version', v_old.version, 'updated_at', v_old.updated_at)::text;
  end if;

  if v_new.phone_primary is distinct from v_old.phone_primary then
    select c.customer_no into v_dup_no from crm.customers c
    where c.phone_primary = v_new.phone_primary and c.archived_at is null and c.id <> p_customer_id limit 1;
    if v_dup_no is not null then
      raise exception 'DUPLICATE_CUSTOMER: phone is already registered to customer %', v_dup_no
        using errcode = 'P0001', detail = jsonb_build_object('existing_customer_no', v_dup_no)::text;
    end if;
  end if;

  update crm.customers set
    doctor_name = v_new.doctor_name, clinic_name = v_new.clinic_name, display_name = v_new.display_name,
    kind = v_new.kind, specialty_code = v_new.specialty_code, phone_primary = v_new.phone_primary,
    phone_secondary = v_new.phone_secondary, email = v_new.email, address_line = v_new.address_line,
    city = v_new.city, governorate_code = v_new.governorate_code, tags = v_new.tags, notes = v_new.notes,
    lifecycle_stage = v_new.lifecycle_stage, version = v_old.version + 1
  where id = p_customer_id;

  if v_new.lifecycle_stage is distinct from v_old.lifecycle_stage then
    perform crm._add_activity(p_customer_id, v_emp, 'stage_change',
      'Stage changed: ' || v_old.lifecycle_stage || ' → ' || v_new.lifecycle_stage, 'crm.customers', p_customer_id);
    perform crm._emit('customer.stage_changed', 'crm.customer', p_customer_id, jsonb_build_object(
      'customer_id', p_customer_id, 'customer_no', v_old.customer_no,
      'from_stage', v_old.lifecycle_stage, 'to_stage', v_new.lifecycle_stage));
  end if;

  return jsonb_build_object('customer_id', p_customer_id, 'version', v_old.version + 1,
                            'lifecycle_stage', v_new.lifecycle_stage, 'changed', true);
exception when unique_violation then
  raise exception 'DUPLICATE_CUSTOMER: phone is already registered to another customer' using errcode = 'P0001';
end $$;

-- Set or correct the clinic GPS pin (drives check-in verification). Audited by
-- the row trigger; changing an existing pin also raises a security event.
create or replace function api.set_customer_location(p_customer_id uuid, p_lat numeric, p_lng numeric)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_c crm.customers%rowtype; v_emp uuid := authz.current_employee_id(); v_lat numeric; v_lng numeric;
begin
  perform authz.require('crm.customer_location.verify');
  if p_lat is null or p_lng is null or p_lat not between 21.5 and 32.0 or p_lng not between 24.5 and 37.5 then
    raise exception 'VALIDATION: coordinates must be inside Egypt' using errcode = 'P0001';
  end if;
  select * into v_c from crm.customers where id = p_customer_id for update;
  if not found then raise exception 'NOT_FOUND: customer' using errcode = 'P0002'; end if;
  if not authz.customer_in_scope('crm.customer_location.verify', p_customer_id) then
    raise exception 'PERMISSION_DENIED: customer not in your scope' using errcode = '42501';
  end if;
  if v_c.archived_at is not null then
    raise exception 'INVALID_STATE: customer is archived' using errcode = 'P0001';
  end if;
  v_lat := round(p_lat, 6); v_lng := round(p_lng, 6);

  update crm.customers set latitude = v_lat, longitude = v_lng, location_verified = true, version = version + 1
  where id = p_customer_id;

  perform crm._add_activity(p_customer_id, v_emp, 'note',
    case when v_c.latitude is null then 'Clinic location set and verified' else 'Clinic location changed and verified' end,
    'crm.customers', p_customer_id);
  if v_c.latitude is not null and (v_c.latitude, v_c.longitude) is distinct from (v_lat, v_lng) then
    perform authz.log_security_event('customer_location_changed', 'warning', jsonb_build_object(
      'customer_id', p_customer_id, 'moved_m', core.distance_m(v_c.latitude, v_c.longitude, v_lat, v_lng)));
  end if;

  return jsonb_build_object('customer_id', p_customer_id, 'latitude', v_lat, 'longitude', v_lng,
                            'location_verified', true, 'version', v_c.version + 1);
end $$;

-- ---------------------------------------------------------------------------
-- 4. Reassignment (approval workflow 'crm.customer.reassign')
-- ---------------------------------------------------------------------------
create or replace function api.request_customer_reassignment(p_customer_id uuid, p_to_employee_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_c crm.customers%rowtype; v_from uuid; v_def uuid; v_req uuid; v_emp uuid := authz.current_employee_id();
begin
  perform authz.require('crm.customer.read');
  select * into v_c from crm.customers where id = p_customer_id for update;
  if not found then raise exception 'NOT_FOUND: customer' using errcode = 'P0002'; end if;
  if not authz.customer_in_scope('crm.customer.read', p_customer_id) then
    raise exception 'PERMISSION_DENIED: customer not in your scope' using errcode = '42501';
  end if;
  if coalesce(btrim(p_reason), '') = '' then raise exception 'REASON_REQUIRED' using errcode = 'P0001'; end if;
  if v_c.archived_at is not null then
    raise exception 'INVALID_STATE: customer is archived' using errcode = 'P0001';
  end if;
  if not exists (select 1 from core.employees where id = p_to_employee_id and employment_status = 'active') then
    raise exception 'NOT_FOUND: active employee' using errcode = 'P0002';
  end if;
  select a.employee_id into v_from from crm.customer_assignments a
  where a.customer_id = p_customer_id and a.role = 'primary_rep' and a.valid_to is null;
  if v_from is not distinct from p_to_employee_id then
    raise exception 'INVALID_STATE: employee is already the primary representative' using errcode = 'P0001';
  end if;
  select id into v_def from wf.workflow_definitions where code = 'crm.customer.reassign' and is_active;
  if v_def is null then raise exception 'WORKFLOW_MISSING: crm.customer.reassign' using errcode = 'P0001'; end if;
  if exists (select 1 from wf.approval_requests where definition_id = v_def and entity_id = p_customer_id and status = 'pending') then
    raise exception 'INVALID_STATE: a reassignment request is already pending for this customer' using errcode = 'P0001';
  end if;

  insert into wf.approval_requests (definition_id, entity_type, entity_id, requested_by, payload)
  values (v_def, 'crm.customer', p_customer_id, auth.uid(), jsonb_build_object(
    'customer_id', p_customer_id, 'from_employee_id', v_from, 'to_employee_id', p_to_employee_id,
    'reason', btrim(p_reason)))
  returning id into v_req;

  perform crm._add_activity(p_customer_id, v_emp, 'assignment', 'Reassignment requested: ' || btrim(p_reason),
                            'wf.approval_requests', v_req);
  perform crm._emit('approval.requested', 'wf.approval_request', v_req, jsonb_build_object(
    'request_id', v_req, 'workflow', 'crm.customer.reassign', 'entity_type', 'crm.customer',
    'entity_id', p_customer_id, 'customer_no', v_c.customer_no));

  return jsonb_build_object('approval_request_id', v_req, 'status', 'pending');
end $$;

-- Approval hook: called by api.decide_approval (definer context) after a final decision.
create or replace function wf.on_decided_crm_customer_reassign(p_request_id uuid, p_approved boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_req wf.approval_requests%rowtype; v_code text;
  v_customer uuid; v_from uuid; v_to uuid; v_current uuid; v_now timestamptz := clock_timestamp();
  v_actor uuid;
begin
  select r.* into v_req from wf.approval_requests r where r.id = p_request_id for update;
  if not found then raise exception 'NOT_FOUND: approval request' using errcode = 'P0002'; end if;
  select code into v_code from wf.workflow_definitions where id = v_req.definition_id;
  if v_code is distinct from 'crm.customer.reassign' then
    raise exception 'INVALID_STATE: request % is not a customer reassignment', p_request_id using errcode = 'P0001';
  end if;
  if p_approved is null then raise exception 'VALIDATION: decision is required' using errcode = 'P0001'; end if;
  if v_req.status in ('cancelled','expired')
     or (v_req.status = 'approved' and not p_approved) or (v_req.status = 'rejected' and p_approved) then
    raise exception 'INVALID_STATE: request is %', v_req.status using errcode = 'P0001';
  end if;

  v_customer := (v_req.payload ->> 'customer_id')::uuid;
  v_from     := (v_req.payload ->> 'from_employee_id')::uuid;
  v_to       := (v_req.payload ->> 'to_employee_id')::uuid;
  v_actor    := coalesce(authz.current_employee_id(), (select e.id from core.employees e where e.user_id = v_req.requested_by));

  if not p_approved then
    perform crm._add_activity(v_customer, v_actor, 'assignment', 'Reassignment rejected', 'wf.approval_requests', p_request_id);
    return;
  end if;

  perform 1 from crm.customers where id = v_customer for update;
  select a.employee_id into v_current from crm.customer_assignments a
  where a.customer_id = v_customer and a.role = 'primary_rep' and a.valid_to is null;
  if v_current is not distinct from v_to then
    return;                                              -- already applied (idempotent)
  end if;
  if not exists (select 1 from core.employees where id = v_to and employment_status = 'active') then
    raise exception 'INVALID_STATE: target employee is no longer active' using errcode = 'P0001';
  end if;

  update crm.customer_assignments
     set valid_to = greatest(v_now, valid_from + interval '1 millisecond')
   where customer_id = v_customer and role = 'primary_rep' and valid_to is null;
  insert into crm.customer_assignments (customer_id, employee_id, role, valid_from, assigned_by, reason)
  values (v_customer, v_to, 'primary_rep', v_now, coalesce(auth.uid(), v_req.requested_by), v_req.payload ->> 'reason');

  perform crm._add_activity(v_customer, v_actor, 'assignment', 'Customer reassigned (approved)', 'wf.approval_requests', p_request_id);
  perform crm._emit('customer.reassigned', 'crm.customer', v_customer, jsonb_build_object(
    'customer_id', v_customer, 'from_employee_id', v_current, 'to_employee_id', v_to,
    'requested_from_employee_id', v_from, 'approval_request_id', p_request_id));
  perform crm._notify_employee(v_to, 'customer.assigned', 'A customer was assigned to you', null,
                               '/customers/' || v_customer, jsonb_build_object('customer_id', v_customer));
  if v_current is not null then
    perform crm._notify_employee(v_current, 'customer.unassigned', 'A customer was reassigned', null, null,
                                 jsonb_build_object('customer_id', v_customer));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 5. Opportunities
-- ---------------------------------------------------------------------------
create or replace function api.create_opportunity(p_customer_id uuid, p_title text, p_brand_code text default null,
                                                  p_expected_value numeric default null,
                                                  p_expected_close_date date default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_emp uuid := authz.current_employee_id(); v_c crm.customers%rowtype; v_brand uuid; v_id uuid; v_task uuid;
begin
  perform authz.require('crm.opportunity.manage');
  if v_emp is null then raise exception 'NO_EMPLOYEE_PROFILE' using errcode = '42501'; end if;
  select * into v_c from crm.customers where id = p_customer_id;
  if not found then raise exception 'NOT_FOUND: customer' using errcode = 'P0002'; end if;
  if not authz.customer_in_scope('crm.opportunity.manage', p_customer_id) then
    raise exception 'PERMISSION_DENIED: customer not in your scope' using errcode = '42501';
  end if;
  if v_c.archived_at is not null or v_c.lifecycle_stage = 'blocked' then
    raise exception 'INVALID_STATE: customer is %', case when v_c.archived_at is not null then 'archived' else 'blocked' end
      using errcode = 'P0001';
  end if;
  if coalesce(btrim(p_title), '') = '' then raise exception 'VALIDATION: title is required' using errcode = 'P0001'; end if;
  if p_expected_value is not null and p_expected_value < 0 then
    raise exception 'VALIDATION: expected value cannot be negative' using errcode = 'P0001';
  end if;
  if nullif(btrim(p_brand_code), '') is not null then
    select id into v_brand from catalog.brands where code = upper(btrim(p_brand_code)) and is_active;
    if v_brand is null then raise exception 'NOT_FOUND: brand %', p_brand_code using errcode = 'P0002'; end if;
  end if;

  insert into crm.opportunities (customer_id, owner_employee_id, title, brand_id, stage, expected_value,
                                 probability_pct, expected_close_date)
  values (p_customer_id, v_emp, btrim(p_title), v_brand, 'new', round(p_expected_value, 2),
          crm.default_probability('new'), p_expected_close_date)
  returning id into v_id;

  -- docs/ARCHITECTURE.md §5.2: every new opportunity gets a follow-up in 3 days.
  insert into work.tasks (title, kind, customer_id, assignee_employee_id, created_by, source, ref_table, ref_id, due_at)
  values ('Follow up: ' || btrim(p_title), 'follow_up', p_customer_id, v_emp, auth.uid(), 'system',
          'crm.opportunities', v_id, now() + interval '3 days')
  returning id into v_task;

  perform crm._add_activity(p_customer_id, v_emp, 'note', 'Opportunity created: ' || btrim(p_title), 'crm.opportunities', v_id);
  perform crm._emit('opportunity.created', 'crm.opportunity', v_id, jsonb_build_object(
    'opportunity_id', v_id, 'customer_id', p_customer_id, 'owner_employee_id', v_emp, 'stage', 'new',
    'brand_code', upper(nullif(btrim(p_brand_code), '')), 'expected_value', round(p_expected_value, 2)::text));

  return jsonb_build_object('opportunity_id', v_id, 'stage', 'new', 'follow_up_task_id', v_task);
end $$;

create or replace function api.move_opportunity(p_opportunity_id uuid, p_stage text, p_lost_reason text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_o crm.opportunities%rowtype; v_emp uuid := authz.current_employee_id();
begin
  perform authz.require('crm.opportunity.manage');
  select * into v_o from crm.opportunities where id = p_opportunity_id for update;
  if not found then raise exception 'NOT_FOUND: opportunity' using errcode = 'P0002'; end if;
  if not (authz.has_global('crm.opportunity.manage')
          or v_o.owner_employee_id = any(authz.employee_ids('crm.opportunity.manage'))
          or authz.customer_in_scope('crm.opportunity.manage', v_o.customer_id)) then
    raise exception 'PERMISSION_DENIED: opportunity not in your scope' using errcode = '42501';
  end if;
  if p_stage is null or p_stage not in ('new','qualified','proposal','negotiation','won','lost') then
    raise exception 'VALIDATION: unknown stage %', coalesce(p_stage, '(none)') using errcode = 'P0001';
  end if;
  if p_stage = v_o.stage then                       -- replay / no-op
    return jsonb_build_object('opportunity_id', p_opportunity_id, 'stage', v_o.stage, 'changed', false);
  end if;
  if not crm.opportunity_transition_allowed(v_o.stage, p_stage) then
    raise exception 'INVALID_STATE: opportunity cannot move from % to %', v_o.stage, p_stage using errcode = 'P0001';
  end if;
  if p_stage = 'lost' and coalesce(btrim(p_lost_reason), '') = '' then
    raise exception 'REASON_REQUIRED: a lost opportunity needs a reason' using errcode = 'P0001';
  end if;

  update crm.opportunities set
    stage = p_stage, probability_pct = crm.default_probability(p_stage),
    lost_reason = case when p_stage = 'lost' then btrim(p_lost_reason) end,
    closed_at = case when p_stage in ('won','lost') then now() end,
    updated_at = now()
  where id = p_opportunity_id;

  perform crm._add_activity(v_o.customer_id, v_emp, 'stage_change',
    'Opportunity "' || v_o.title || '": ' || v_o.stage || ' → ' || p_stage
      || case when p_stage = 'lost' then ' (' || btrim(p_lost_reason) || ')' else '' end,
    'crm.opportunities', p_opportunity_id);
  if p_stage in ('won','lost') then
    perform crm._emit('opportunity.' || p_stage, 'crm.opportunity', p_opportunity_id, jsonb_build_object(
      'opportunity_id', p_opportunity_id, 'customer_id', v_o.customer_id, 'owner_employee_id', v_o.owner_employee_id,
      'expected_value', v_o.expected_value::text));
  end if;

  return jsonb_build_object('opportunity_id', p_opportunity_id, 'stage', p_stage, 'changed', true);
end $$;

-- ---------------------------------------------------------------------------
-- 6. Tasks
-- ---------------------------------------------------------------------------
create or replace function api.create_task(p_title text, p_due_at timestamptz, p_customer_id uuid default null,
                                           p_kind text default 'follow_up', p_assignee_employee_id uuid default null,
                                           p_client_ref uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_emp uuid := authz.current_employee_id(); v_assignee uuid; v_existing work.tasks%rowtype; v_id uuid;
begin
  perform authz.require('work.task.manage');
  if v_emp is null then raise exception 'NO_EMPLOYEE_PROFILE' using errcode = '42501'; end if;

  if p_client_ref is not null then
    select * into v_existing from work.tasks where client_ref = p_client_ref;
    if found then
      if v_existing.created_by is distinct from auth.uid() then
        raise exception 'CONFLICT: client_ref was already used by another request' using errcode = 'P0001';
      end if;
      return jsonb_build_object('task_id', v_existing.id, 'assignee_employee_id', v_existing.assignee_employee_id,
                                'replayed', true);
    end if;
  end if;

  if coalesce(btrim(p_title), '') = '' then raise exception 'VALIDATION: title is required' using errcode = 'P0001'; end if;
  if p_due_at is null then raise exception 'VALIDATION: due_at is required' using errcode = 'P0001'; end if;
  if coalesce(p_kind, 'follow_up') not in ('follow_up','collection','visit_prep','approval','quality','general') then
    raise exception 'VALIDATION: unknown task kind %', p_kind using errcode = 'P0001';
  end if;

  v_assignee := coalesce(p_assignee_employee_id, v_emp);
  if v_assignee <> v_emp then
    if not exists (select 1 from core.employees where id = v_assignee and employment_status in ('active','on_leave')) then
      raise exception 'NOT_FOUND: active employee' using errcode = 'P0002';
    end if;
    if not authz.employee_in_scope('work.task.manage', v_assignee) then
      raise exception 'PERMISSION_DENIED: employee is outside your scope' using errcode = '42501';
    end if;
  end if;
  if p_customer_id is not null then
    if not exists (select 1 from crm.customers where id = p_customer_id) then
      raise exception 'NOT_FOUND: customer' using errcode = 'P0002';
    end if;
    if not authz.customer_in_scope('crm.customer.read', p_customer_id) then
      raise exception 'PERMISSION_DENIED: customer not in your scope' using errcode = '42501';
    end if;
  end if;

  insert into work.tasks (title, kind, customer_id, assignee_employee_id, created_by, source, due_at, client_ref)
  values (btrim(p_title), coalesce(p_kind, 'follow_up'), p_customer_id, v_assignee, auth.uid(), 'manual', p_due_at, p_client_ref)
  returning id into v_id;

  if v_assignee <> v_emp then
    perform crm._notify_employee(v_assignee, 'task.assigned', 'New task: ' || btrim(p_title), null,
                                 '/tasks/' || v_id, jsonb_build_object('task_id', v_id, 'due_at', p_due_at));
  end if;

  return jsonb_build_object('task_id', v_id, 'assignee_employee_id', v_assignee, 'replayed', false);
end $$;

create or replace function api.complete_task(p_task_id uuid, p_outcome text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_t work.tasks%rowtype; v_emp uuid := authz.current_employee_id();
begin
  perform authz.require('work.task.manage');
  select * into v_t from work.tasks where id = p_task_id for update;
  if not found then raise exception 'NOT_FOUND: task' using errcode = 'P0002'; end if;
  if v_t.assignee_employee_id is distinct from v_emp
     and not authz.employee_in_scope('work.task.manage', v_t.assignee_employee_id) then
    raise exception 'PERMISSION_DENIED: task belongs to another employee' using errcode = '42501';
  end if;
  if v_t.status = 'done' then
    return jsonb_build_object('task_id', p_task_id, 'status', 'done', 'replayed', true);
  end if;
  if v_t.status <> 'open' then
    raise exception 'INVALID_STATE: task is %', v_t.status using errcode = 'P0001';
  end if;
  if coalesce(btrim(p_outcome), '') = '' then
    raise exception 'VALIDATION: outcome is required' using errcode = 'P0001';
  end if;

  update work.tasks set status = 'done', completed_at = now(), outcome = btrim(p_outcome) where id = p_task_id;
  if v_t.customer_id is not null then
    perform crm._add_activity(v_t.customer_id, v_emp, 'note', 'Task done: ' || v_t.title || ' — ' || btrim(p_outcome),
                              'work.tasks', p_task_id);
  end if;
  return jsonb_build_object('task_id', p_task_id, 'status', 'done', 'replayed', false);
end $$;

-- ---------------------------------------------------------------------------
-- 7. Manual timeline entries
-- ---------------------------------------------------------------------------
create or replace function api.log_activity(p_customer_id uuid, p_type text, p_summary text,
                                            p_occurred_at timestamptz default now())
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_emp uuid := authz.current_employee_id(); v_id uuid;
begin
  perform authz.require('crm.activity.create');
  if v_emp is null then raise exception 'NO_EMPLOYEE_PROFILE' using errcode = '42501'; end if;
  if not exists (select 1 from crm.customers where id = p_customer_id) then
    raise exception 'NOT_FOUND: customer' using errcode = 'P0002';
  end if;
  if not authz.customer_in_scope('crm.activity.create', p_customer_id) then
    raise exception 'PERMISSION_DENIED: customer not in your scope' using errcode = '42501';
  end if;
  if p_type is null or p_type not in ('call','whatsapp','email','meeting','note') then
    raise exception 'VALIDATION: activity type % cannot be logged manually', coalesce(p_type, '(none)') using errcode = 'P0001';
  end if;
  if coalesce(btrim(p_summary), '') = '' then raise exception 'VALIDATION: summary is required' using errcode = 'P0001'; end if;
  if p_occurred_at > now() + interval '10 minutes' then
    raise exception 'VALIDATION: occurred_at cannot be in the future' using errcode = 'P0001';
  end if;
  v_id := crm._add_activity(p_customer_id, v_emp, p_type, btrim(p_summary), null, null, coalesce(p_occurred_at, now()));
  return jsonb_build_object('activity_id', v_id);
end $$;

-- ---------------------------------------------------------------------------
-- 8. Visits: check-out and verification exceptions
-- ---------------------------------------------------------------------------
create or replace function api.visit_check_out(
  p_visit_id uuid, p_outcome text, p_notes text, p_lat numeric, p_lng numeric, p_accuracy_m numeric,
  p_captured_at timestamptz, p_next_follow_up_at timestamptz default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_emp uuid := authz.current_employee_id();
  v_v field.visits%rowtype; v_task uuid; v_flags text[]; v_name text;
begin
  perform authz.require('field.visit.create');
  if v_emp is null then raise exception 'NO_EMPLOYEE_PROFILE' using errcode = '42501'; end if;
  select * into v_v from field.visits where id = p_visit_id for update;
  if not found then raise exception 'NOT_FOUND: visit' using errcode = 'P0002'; end if;
  if v_v.employee_id <> v_emp then
    raise exception 'PERMISSION_DENIED: only the visiting representative can check out' using errcode = '42501';
  end if;

  -- Idempotent replay from the offline queue.
  if exists (select 1 from field.location_events where visit_id = p_visit_id and event_type = 'check_out') then
    select t.id into v_task from work.tasks t
    where t.ref_table = 'field.visits' and t.ref_id = p_visit_id and t.source = 'visit' limit 1;
    return jsonb_build_object('visit_id', p_visit_id, 'status', v_v.status, 'outcome', v_v.outcome,
                              'follow_up_task_id', v_task, 'replayed', true);
  end if;

  if v_v.status <> 'in_progress' then
    raise exception 'INVALID_STATE: visit is %', v_v.status using errcode = 'P0001';
  end if;
  if p_outcome is null or p_outcome not in ('order_taken','interested','follow_up','not_interested',
                                             'doctor_unavailable','collection','demo','complaint','other') then
    raise exception 'VALIDATION: unknown visit outcome %', coalesce(p_outcome, '(none)') using errcode = 'P0001';
  end if;
  if p_captured_at is null then raise exception 'VALIDATION: captured_at is required' using errcode = 'P0001'; end if;
  if v_v.check_in_at is not null and p_captured_at < v_v.check_in_at then
    raise exception 'VALIDATION: check-out time is before check-in' using errcode = 'P0001';
  end if;
  if p_next_follow_up_at is not null and p_next_follow_up_at <= p_captured_at then
    raise exception 'VALIDATION: next follow-up must be after the visit' using errcode = 'P0001';
  end if;

  v_flags := v_v.anomaly_flags;
  if abs(extract(epoch from (now() - p_captured_at))) > 600 then
    v_flags := array(select distinct f from unnest(array_append(v_flags,
                 case when p_captured_at < now() then 'late_sync' else 'clock_skew' end)) f order by 1);
  end if;

  insert into field.location_events (visit_id, employee_id, event_type, latitude, longitude, accuracy_m, captured_at)
  values (p_visit_id, v_emp, 'check_out', p_lat, p_lng, p_accuracy_m, p_captured_at);

  update field.visits set status = 'completed', check_out_at = p_captured_at, outcome = p_outcome,
         notes = nullif(btrim(p_notes), ''), anomaly_flags = v_flags, updated_at = now()
  where id = p_visit_id;

  if p_next_follow_up_at is not null then
    select display_name into v_name from crm.customers where id = v_v.customer_id;
    insert into work.tasks (title, kind, customer_id, assignee_employee_id, created_by, source, ref_table, ref_id, due_at)
    values ('Follow up: ' || coalesce(v_name, 'customer'), 'follow_up', v_v.customer_id, v_emp, auth.uid(),
            'visit', 'field.visits', p_visit_id, p_next_follow_up_at)
    returning id into v_task;
  end if;

  perform crm._add_activity(v_v.customer_id, v_emp, 'visit', 'Check-out (' || p_outcome || ')', 'field.visits',
                            p_visit_id, p_captured_at);
  perform crm._emit('visit.completed', 'field.visit', p_visit_id, jsonb_build_object(
    'visit_id', p_visit_id, 'customer_id', v_v.customer_id, 'employee_id', v_emp, 'outcome', p_outcome,
    'verification_status', v_v.verification_status, 'follow_up_task_id', v_task));

  return jsonb_build_object('visit_id', p_visit_id, 'status', 'completed', 'outcome', p_outcome,
                            'follow_up_task_id', v_task, 'replayed', false);
end $$;

create or replace function api.request_visit_exception(p_visit_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_v field.visits%rowtype; v_def uuid; v_req uuid; v_emp uuid := authz.current_employee_id();
begin
  perform authz.require('field.visit_exception.request');
  select * into v_v from field.visits where id = p_visit_id for update;
  if not found then raise exception 'NOT_FOUND: visit' using errcode = 'P0002'; end if;
  if not (authz.has_global('field.visit_exception.request')
          or v_v.employee_id = any(authz.employee_ids('field.visit_exception.request'))) then
    raise exception 'PERMISSION_DENIED: visit belongs to another employee' using errcode = '42501';
  end if;
  select id into v_def from wf.workflow_definitions where code = 'field.visit.exception' and is_active;
  if v_def is null then raise exception 'WORKFLOW_MISSING: field.visit.exception' using errcode = 'P0001'; end if;

  if v_v.verification_status = 'exception_requested' then        -- replay
    select id into v_req from wf.approval_requests
    where definition_id = v_def and entity_id = p_visit_id and status = 'pending';
    if v_req is not null then
      return jsonb_build_object('approval_request_id', v_req, 'verification_status', 'exception_requested',
                                'replayed', true);
    end if;
  end if;
  if coalesce(btrim(p_reason), '') = '' then raise exception 'REASON_REQUIRED' using errcode = 'P0001'; end if;
  if v_v.verification_status not in ('out_of_range','no_customer_location','no_device_location','low_accuracy') then
    raise exception 'INVALID_STATE: visit verification is % (no exception needed or already decided)', v_v.verification_status
      using errcode = 'P0001';
  end if;
  if v_v.status not in ('in_progress','completed') then
    raise exception 'INVALID_STATE: visit is %', v_v.status using errcode = 'P0001';
  end if;

  insert into wf.approval_requests (definition_id, entity_type, entity_id, requested_by, payload)
  values (v_def, 'field.visit', p_visit_id, auth.uid(), jsonb_build_object(
    'visit_id', p_visit_id, 'customer_id', v_v.customer_id, 'employee_id', v_v.employee_id,
    'original_status', v_v.verification_status, 'distance_m', v_v.check_in_distance_m,
    'accuracy_m', v_v.check_in_accuracy_m, 'reason', btrim(p_reason)))
  returning id into v_req;

  update field.visits set verification_status = 'exception_requested', updated_at = now() where id = p_visit_id;

  perform crm._add_activity(v_v.customer_id, v_emp, 'visit', 'Visit verification exception requested',
                            'field.visits', p_visit_id);
  perform crm._emit('visit.exception_requested', 'field.visit', p_visit_id, jsonb_build_object(
    'visit_id', p_visit_id, 'approval_request_id', v_req, 'customer_id', v_v.customer_id,
    'employee_id', v_v.employee_id, 'original_status', v_v.verification_status));

  return jsonb_build_object('approval_request_id', v_req, 'verification_status', 'exception_requested',
                            'replayed', false);
end $$;

-- Approval hook. On approval of a 'no_customer_location' exception, the check-in
-- fix becomes the clinic's verified location (docs/ARCHITECTURE.md §7: location is
-- set at the first approved visit or by a manager) when it is accurate enough.
create or replace function wf.on_decided_field_visit_exception(p_request_id uuid, p_approved boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_req wf.approval_requests%rowtype; v_code text; v_v field.visits%rowtype; v_target text;
  v_fix_lat numeric; v_fix_lng numeric; v_fix_acc numeric; v_max_acc numeric; v_actor uuid;
begin
  select r.* into v_req from wf.approval_requests r where r.id = p_request_id for update;
  if not found then raise exception 'NOT_FOUND: approval request' using errcode = 'P0002'; end if;
  select code into v_code from wf.workflow_definitions where id = v_req.definition_id;
  if v_code is distinct from 'field.visit.exception' then
    raise exception 'INVALID_STATE: request % is not a visit exception', p_request_id using errcode = 'P0001';
  end if;
  if p_approved is null then raise exception 'VALIDATION: decision is required' using errcode = 'P0001'; end if;
  if v_req.status in ('cancelled','expired')
     or (v_req.status = 'approved' and not p_approved) or (v_req.status = 'rejected' and p_approved) then
    raise exception 'INVALID_STATE: request is %', v_req.status using errcode = 'P0001';
  end if;

  select * into v_v from field.visits where id = v_req.entity_id for update;
  if not found then raise exception 'NOT_FOUND: visit' using errcode = 'P0002'; end if;
  v_target := case when p_approved then 'exception_approved' else 'exception_rejected' end;
  if v_v.verification_status = v_target then return; end if;        -- already applied
  if v_v.verification_status <> 'exception_requested' then
    raise exception 'INVALID_STATE: visit verification is %', v_v.verification_status using errcode = 'P0001';
  end if;

  update field.visits set verification_status = v_target, updated_at = now() where id = v_v.id;
  v_actor := authz.current_employee_id();

  if p_approved and v_req.payload ->> 'original_status' = 'no_customer_location' then
    v_max_acc := coalesce((select (value #>> '{}')::numeric from core.system_settings where key = 'field.max_accuracy_m'), 100);
    select le.latitude, le.longitude, le.accuracy_m into v_fix_lat, v_fix_lng, v_fix_acc
    from field.location_events le where le.visit_id = v_v.id and le.event_type = 'check_in';
    if v_fix_lat is not null and v_fix_lng is not null and coalesce(v_fix_acc, v_max_acc + 1) <= v_max_acc
       and v_fix_lat between 21.5 and 32.0 and v_fix_lng between 24.5 and 37.5 then
      update crm.customers set latitude = v_fix_lat, longitude = v_fix_lng, location_verified = true,
                               version = version + 1
      where id = v_v.customer_id and latitude is null;
      if found then
        perform crm._add_activity(v_v.customer_id, v_actor, 'note',
          'Clinic location set from an approved visit', 'field.visits', v_v.id);
      end if;
    end if;
  end if;

  perform crm._add_activity(v_v.customer_id, v_actor, 'visit',
    'Visit verification exception ' || case when p_approved then 'approved' else 'rejected' end,
    'field.visits', v_v.id);
  perform crm._emit('visit.exception_decided', 'field.visit', v_v.id, jsonb_build_object(
    'visit_id', v_v.id, 'approval_request_id', p_request_id, 'employee_id', v_v.employee_id,
    'decision', case when p_approved then 'approved' else 'rejected' end));
  perform crm._notify_employee(v_v.employee_id, 'visit.exception_decided',
    'Visit exception ' || case when p_approved then 'approved' else 'rejected' end, null,
    '/visits/' || v_v.id, jsonb_build_object('visit_id', v_v.id, 'approved', p_approved));
end $$;

-- ---------------------------------------------------------------------------
-- 9. Retention (ADR-010): raw GPS fixes older than the configured window.
-- The visit verdict stays; only raw coordinates are deleted. Service context only.
-- ---------------------------------------------------------------------------
create or replace function field.purge_old_location_events() returns int
language plpgsql security definer set search_path = '' as $$
declare v_days int; v_n int;
begin
  select (value #>> '{}')::int into v_days from core.system_settings where key = 'field.location_retention_days';
  v_days := coalesce(v_days, 365);
  if v_days < 30 then
    raise exception 'VALIDATION: field.location_retention_days must be at least 30 (got %)', v_days using errcode = 'P0001';
  end if;
  delete from field.location_events where received_at < now() - make_interval(days => v_days);
  get diagnostics v_n = row_count;
  insert into audit.security_events (user_id, event_type, severity, details)
  values (auth.uid(), 'retention_purge', 'info',
          jsonb_build_object('table', 'field.location_events', 'deleted', v_n, 'retention_days', v_days));
  return v_n;
end $$;

-- Schedule daily at 03:17 Cairo-ish (01:17 UTC) when pg_cron is available (Supabase).
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'cron') then
    execute $c$select cron.schedule('field-location-retention', '17 1 * * *',
                                     'select field.purge_old_location_events()')$c$;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 10. RLS for tables that had none (deny-by-default until now)
-- ---------------------------------------------------------------------------
drop policy if exists opportunities_select on crm.opportunities;
create policy opportunities_select on crm.opportunities for select to authenticated using (
  (select authz.has_global('crm.opportunity.read'))
  or owner_employee_id = any((select authz.employee_ids('crm.opportunity.read'))::uuid[])
  or customer_id = any((select authz.assigned_customer_ids('crm.opportunity.read'))::uuid[])
  or exists (select 1 from crm.customers c where c.id = opportunities.customer_id
             and c.territory_id = any((select authz.territory_ids('crm.opportunity.read'))::uuid[]))
);
drop policy if exists customer_contacts_select on crm.customer_contacts;
create policy customer_contacts_select on crm.customer_contacts for select to authenticated using (
  exists (select 1 from crm.customers c where c.id = customer_contacts.customer_id)   -- inherits customer RLS
);
drop policy if exists territory_coverage_select on core.territory_coverage;
create policy territory_coverage_select on core.territory_coverage for select to authenticated
  using ((select authz.is_active_user()));

-- ---------------------------------------------------------------------------
-- 11. Read views (security_invoker → the caller's RLS applies)
-- ---------------------------------------------------------------------------
create or replace view api.v_customers with (security_invoker = true) as
  select c.id, c.customer_no, c.kind, c.doctor_name, c.clinic_name, c.display_name, c.specialty_code,
         c.lifecycle_stage, c.source, c.phone_primary::text as phone_primary, c.phone_secondary::text as phone_secondary,
         c.email::text as email, c.address_line, c.city, c.governorate_code,
         c.territory_id, t.code as territory_code, t.name_en as territory_name_en, t.name_ar as territory_name_ar,
         c.latitude, c.longitude, c.location_verified, c.tags, c.notes, c.version,
         pr.employee_id as primary_rep_employee_id, rep.full_name_en as primary_rep_name_en,
         rep.full_name_ar as primary_rep_name_ar,
         -- Field-level masking: balance and credit terms need crm.customer_balance.read in scope.
         case when bs.visible then coalesce(b.balance, 0)::numeric(14,2) end as balance,
         case when bs.visible then b.last_movement_at end as balance_updated_at,
         case when bs.visible then c.credit_limit end as credit_limit,
         case when bs.visible then c.payment_terms_days end as payment_terms_days,
         c.created_at, c.updated_at, c.archived_at
  from crm.customers c
  left join core.territories t on t.id = c.territory_id
  left join lateral (select a.employee_id from crm.customer_assignments a
                     where a.customer_id = c.id and a.role = 'primary_rep' and a.valid_to is null) pr on true
  left join lateral crm.employee_display(pr.employee_id) rep on true
  left join crm.customer_balances_in_scope() b on b.customer_id = c.id
  cross join lateral (select (
       (select authz.has_global('crm.customer_balance.read'))
    or c.territory_id = any((select authz.territory_ids('crm.customer_balance.read'))::uuid[])
    or c.id = any((select authz.assigned_customer_ids('crm.customer_balance.read'))::uuid[])) as visible) bs;

create or replace view api.v_customer_timeline with (security_invoker = true) as
  select a.id, a.customer_id, a.type, a.occurred_at, a.summary, a.employee_id,
         emp.full_name_en as employee_name_en, emp.full_name_ar as employee_name_ar,
         a.ref_table, a.ref_id, a.created_at
  from crm.activities a
  left join lateral crm.employee_display(a.employee_id) emp on true;

create or replace view api.v_opportunities with (security_invoker = true) as
  select o.id, o.customer_id, c.customer_no, c.display_name as customer_name, o.title,
         o.brand_id, b.code as brand_code, b.name as brand_name, o.stage, o.expected_value, o.probability_pct,
         o.expected_close_date, o.lost_reason, o.won_order_id,
         o.owner_employee_id, own.full_name_en as owner_name_en, own.full_name_ar as owner_name_ar,
         o.created_at, o.updated_at, o.closed_at
  from crm.opportunities o
  left join crm.customers c on c.id = o.customer_id
  left join catalog.brands b on b.id = o.brand_id
  left join lateral crm.employee_display(o.owner_employee_id) own on true;

create or replace view api.v_tasks with (security_invoker = true) as
  select t.id, t.title, t.description, t.kind, t.priority, t.status, t.due_at, t.completed_at, t.outcome,
         t.source, t.ref_table, t.ref_id, t.customer_id, c.customer_no, c.display_name as customer_name,
         t.assignee_employee_id, asg.full_name_en as assignee_name_en, asg.full_name_ar as assignee_name_ar,
         (t.status = 'open' and t.due_at < now()) as is_overdue, t.created_at
  from work.tasks t
  left join crm.customers c on c.id = t.customer_id
  left join lateral crm.employee_display(t.assignee_employee_id) asg on true;

-- Visit verdicts only; raw GPS fixes stay in field.location_events (field.location.read).
create or replace view api.v_visits with (security_invoker = true) as
  select v.id, v.customer_id, c.customer_no, c.display_name as customer_name,
         v.employee_id, emp.full_name_en as employee_name_en, emp.full_name_ar as employee_name_ar,
         v.planned_for, v.status, v.check_in_at, v.check_in_received_at, v.check_in_distance_m,
         v.check_in_accuracy_m, v.check_out_at, v.verification_status, v.anomaly_flags, v.outcome, v.notes,
         v.created_at, v.updated_at
  from field.visits v
  left join crm.customers c on c.id = v.customer_id
  left join lateral crm.employee_display(v.employee_id) emp on true;

-- The caller's day: open tasks due today (Cairo) or overdue, plus today's planned
-- visits and any visit still in progress.
create or replace view api.v_my_today with (security_invoker = true) as
  with me as (select (select authz.current_employee_id()) as emp,
                     (now() at time zone 'Africa/Cairo')::date as today)
  select 'task'::text as item_type, t.id as item_id, t.title, t.kind, t.priority, t.status,
         t.customer_id, c.display_name as customer_name, t.due_at, null::date as planned_for,
         (t.due_at < now()) as is_overdue
  from work.tasks t
  cross join me
  left join crm.customers c on c.id = t.customer_id
  where t.assignee_employee_id = me.emp and t.status = 'open'
    and (t.due_at at time zone 'Africa/Cairo')::date <= me.today
  union all
  select 'visit'::text, v.id, coalesce(c.display_name, 'Visit'), null::text, null::text, v.status,
         v.customer_id, c.display_name, v.check_in_at, v.planned_for,
         (v.status = 'planned' and v.planned_for < me.today)
  from field.visits v
  cross join me
  left join crm.customers c on c.id = v.customer_id
  where v.employee_id = me.emp
    and (v.status = 'in_progress' or (v.status = 'planned' and v.planned_for = me.today));

-- ---------------------------------------------------------------------------
-- 12. Privileges
-- ---------------------------------------------------------------------------
grant select on api.v_customers, api.v_customer_timeline, api.v_opportunities, api.v_tasks,
                api.v_visits, api.v_my_today to authenticated;
revoke all on api.v_customers, api.v_customer_timeline, api.v_opportunities, api.v_tasks,
              api.v_visits, api.v_my_today from anon;

-- Hooks, retention and internal writers are never callable by app users.
revoke execute on function wf.on_decided_crm_customer_reassign(uuid, boolean) from public, anon, authenticated;
revoke execute on function wf.on_decided_field_visit_exception(uuid, boolean) from public, anon, authenticated;
revoke execute on function field.purge_old_location_events() from public, anon, authenticated;
revoke execute on function crm._add_activity(uuid, uuid, text, text, text, uuid, timestamptz) from public, anon, authenticated;
revoke execute on function crm._emit(text, text, uuid, jsonb) from public, anon, authenticated;
revoke execute on function crm._notify_employee(uuid, text, text, text, text, jsonb) from public, anon, authenticated;

revoke execute on all functions in schema api from public;
grant execute on all functions in schema api to authenticated;
