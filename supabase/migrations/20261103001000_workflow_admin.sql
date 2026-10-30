-- Honest OS migration: approval workflow administration (Phase 3, ROADMAP task 10).
-- Rules editor, out-of-office delegation commands, and the escalation job. Tests: suite 43.
--
-- Contents
--   0. Expand-only schema changes (columns, escalation log table, audit, settings, permission grants)
--   1. Internal helpers (condition validation, stage writer, people/manager helpers)
--   2. Decision authority: wf.resolve_principal, replaced from its latest definition
--      (20261029001050_audit_fix_functions.sql) with two additions only:
--        a. a revoked delegation grants nothing (d.revoked_at is null)
--        b. a user an escalation reached for the request's current stage may decide that stage
--      Everything else (self-approval, "about you", distinct approvers per request, delegator
--      authority evaluated live, no transitive delegation) is unchanged.
--   3. Commands: api.upsert_workflow_rule, api.set_workflow_stage, api.create_delegation,
--      api.revoke_delegation
--   4. Service job: service.workflow_escalate (service_role only; /api/cron/escalations)
--   5. RLS (new table, delegation scope for managers) and read views
--   6. Privileges
--
-- Rules followed: `set search_path = ''`, fully qualified names; commands are SECURITY DEFINER
-- and call authz.require() + a record-scope check; errors are `CODE: message` with SQLSTATE
-- 42501 / P0001 / P0002; conditions stay DATA in the existing {"all":[{field,op,value}]} format,
-- never SQL. Nothing existing is dropped, renamed or narrowed. wf.dispatch_decision_hook and
-- authz.require are not touched.

-- ---------------------------------------------------------------------------
-- 0. Expand-only schema changes
-- ---------------------------------------------------------------------------

-- Configured escalation fallback of a stage (used when its escalate_after passes).
alter table wf.workflow_stages add column if not exists escalate_to_user_id uuid references auth.users(id);

-- Who created a delegation, why, and its revocation. Existing rows stay valid (all nullable).
alter table wf.delegations add column if not exists created_by    uuid references auth.users(id);
alter table wf.delegations add column if not exists reason        text;
alter table wf.delegations add column if not exists client_ref    text;
alter table wf.delegations add column if not exists revoked_at    timestamptz;
alter table wf.delegations add column if not exists revoked_by    uuid references auth.users(id);
alter table wf.delegations add column if not exists revoke_reason text;
create index if not exists idx_delegations_to_active on wf.delegations (to_user_id, valid_to) where revoked_at is null;
create index if not exists idx_delegations_from on wf.delegations (from_user_id, valid_to desc);
create index if not exists idx_delegations_client_ref on wf.delegations (created_by, client_ref) where client_ref is not null;

-- One row per escalation of one stage of one request, per level. Append-only; the unique key
-- makes the escalation job idempotent (a re-run or an overlapping run inserts nothing twice).
create table if not exists wf.approval_escalations (
  id              uuid primary key default gen_random_uuid(),
  request_id      uuid not null references wf.approval_requests(id),
  stage_no        int not null,
  level           int not null check (level between 1 and 10),
  target_user_ids uuid[] not null default '{}',
  basis           text not null check (basis in ('fallback','approver_manager','owners','none')),
  escalated_at    timestamptz not null default now(),
  unique (request_id, stage_no, level)
);
create index if not exists idx_approval_escalations_targets on wf.approval_escalations using gin (target_user_ids);
alter table wf.approval_escalations enable row level security;

do $$
begin
  if not exists (select 1 from pg_trigger where tgname = 'trg_approval_escalations_append_only'
                   and tgrelid = 'wf.approval_escalations'::regclass) then
    create trigger trg_approval_escalations_append_only before update or delete on wf.approval_escalations
      for each row execute function core.forbid_mutation();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'trg_audit' and tgrelid = 'wf.approval_escalations'::regclass) then
    create trigger trg_audit after insert or update or delete on wf.approval_escalations
      for each row execute function audit.log_change();
  end if;
  -- Delegations move approval authority, so their history is audited too (was missing).
  if not exists (select 1 from pg_trigger where tgname = 'trg_audit' and tgrelid = 'wf.delegations'::regclass) then
    create trigger trg_audit after insert or update or delete on wf.delegations
      for each row execute function audit.log_change();
  end if;
end $$;

insert into core.system_settings (key, value, description) values
  ('wf.delegation.max_days', '90', 'Approvals: longest out-of-office delegation window, in days'),
  ('wf.escalation.max_levels', '3', 'Approvals: how many times one stage of a request may escalate (each after another escalate_after)')
on conflict (key) do nothing;

-- Out-of-office delegation for the roles that decide approvals. 'own' = delegate my own
-- authority; the sales director also manages the delegations of his team (area managers).
-- The IT admin gets none (suite 08: no wf permission on admin).
insert into authz.role_permissions (role_id, permission_code, scope, limit_value)
select r.id, 'wf.delegation.manage', v.scope, null
from (values ('sales_director','team'), ('area_manager','own'), ('inventory_manager','own'), ('finance_officer','own'))
  as v(code, scope)
join authz.roles r on r.code = v.code
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- 1. Internal helpers (never client-callable)
-- ---------------------------------------------------------------------------

-- Why a condition is invalid (NULL = valid). Same grammar wf.condition_matches evaluates:
--   {}  |  {"all":[{"field":"<path>","op":"<op>","value":<scalar or array for in>}, ...]}
-- ops = != > >= < <= in; field = dotted identifier path (≤ 5 parts); booleans only with = / !=;
-- "in" takes a non-empty array of scalars of one type. At most 20 clauses.
create or replace function wf.condition_error(p_condition jsonb) returns text
language plpgsql immutable set search_path = '' as $$
declare v_clause jsonb; v_op text; v_value jsonb; v_t text; v_n int := 0;
begin
  if p_condition is null then return 'condition is required (use {} for "always")'; end if;
  if jsonb_typeof(p_condition) <> 'object' then return 'condition must be an object'; end if;
  if p_condition = '{}'::jsonb then return null; end if;
  if exists (select 1 from jsonb_object_keys(p_condition) k where k <> 'all') then
    return 'only the "all" combinator is supported';
  end if;
  if jsonb_typeof(p_condition -> 'all') is distinct from 'array' then return '"all" must be an array'; end if;
  if jsonb_array_length(p_condition -> 'all') = 0 then return '"all" needs at least one clause (or use {})'; end if;
  if jsonb_array_length(p_condition -> 'all') > 20 then return 'at most 20 clauses'; end if;
  for v_clause in select e from jsonb_array_elements(p_condition -> 'all') e loop
    v_n := v_n + 1;
    if jsonb_typeof(v_clause) <> 'object' then return format('clause %s must be an object', v_n); end if;
    if exists (select 1 from jsonb_object_keys(v_clause) k where k not in ('field','op','value'))
       or not (v_clause ? 'field' and v_clause ? 'op' and v_clause ? 'value') then
      return format('clause %s needs exactly field, op and value', v_n);
    end if;
    if jsonb_typeof(v_clause -> 'field') <> 'string'
       or (v_clause ->> 'field') !~ '^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*){0,4}$' then
      return format('clause %s: field must be a name such as amount or order.total', v_n);
    end if;
    if jsonb_typeof(v_clause -> 'op') <> 'string'
       or (v_clause ->> 'op') not in ('=','!=','>','>=','<','<=','in') then
      return format('clause %s: unknown operator', v_n);
    end if;
    v_op := v_clause ->> 'op';
    v_value := v_clause -> 'value';
    if v_op = 'in' then
      if jsonb_typeof(v_value) <> 'array' or jsonb_array_length(v_value) = 0 or jsonb_array_length(v_value) > 50 then
        return format('clause %s: "in" needs a list of 1 to 50 values', v_n);
      end if;
      select min(jsonb_typeof(x)) into v_t from jsonb_array_elements(v_value) x;
      if v_t not in ('number','string','boolean')
         or exists (select 1 from jsonb_array_elements(v_value) x where jsonb_typeof(x) <> v_t) then
        return format('clause %s: "in" values must all be numbers, all texts or all booleans', v_n);
      end if;
    else
      v_t := jsonb_typeof(v_value);
      if v_t not in ('number','string','boolean') then
        return format('clause %s: value must be a number, a text or a boolean', v_n);
      end if;
      if v_t = 'boolean' and v_op not in ('=','!=') then
        return format('clause %s: booleans compare only with = or !=', v_n);
      end if;
      if v_t = 'string' and length(v_value #>> '{}') > 200 then
        return format('clause %s: text value is too long', v_n);
      end if;
    end if;
  end loop;
  return null;
end $$;

-- Text → int without raising (NULL when missing or not a whole number in int range).
create or replace function wf.try_int(p_text text) returns int
language sql immutable set search_path = '' as $$
  select case when p_text ~ '^\s*-?[0-9]{1,9}\s*$' then trim(p_text)::int end
$$;

-- Managers (as users) of the given users, via core.employees.manager_id. Active users only.
create or replace function wf.manager_user_ids(p_users uuid[]) returns uuid[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(distinct m.user_id), '{}'::uuid[])
  from core.employees e
  join core.employees m on m.id = e.manager_id
  where e.user_id = any(coalesce(p_users, '{}'::uuid[]))
    and m.user_id is not null and wf.user_is_active(m.user_id)
$$;

-- Active holders of the owner role.
create or replace function wf.owner_user_ids() returns uuid[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(distinct ur.user_id), '{}'::uuid[])
  from authz.user_roles ur join authz.roles r on r.id = ur.role_id and r.is_owner_role and r.is_active
  where ur.revoked_at is null and ur.valid_from <= now() and (ur.valid_to is null or ur.valid_to > now())
    and wf.user_is_active(ur.user_id)
$$;

-- When a pending request started waiting on its current stage.
create or replace function wf.stage_started_at(p_request_id uuid) returns timestamptz
language sql stable security definer set search_path = '' as $$
  select coalesce((select max(s.decided_at) from wf.approval_steps s
                   where s.request_id = r.id and s.stage_no < r.current_stage), r.created_at)
  from wf.approval_requests r where r.id = p_request_id
$$;

-- In-app notice to every active owner except the actor (workflow configuration changed).
create or replace function wf.notify_owners_of_change(p_title text, p_data jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid;
begin
  foreach v_owner in array wf.owner_user_ids() loop
    continue when v_owner = auth.uid();
    perform notify.send_in_app(v_owner, 'workflow.changed', p_title, null, '/workflow/rules', coalesce(p_data, '{}'));
  end loop;
end $$;

-- Validate and write one stage of a rule (insert or update by (rule, stage_no)). Shared by
-- api.upsert_workflow_rule (first stages of a new rule) and api.set_workflow_stage.
-- The caller's command has already required admin.workflow.manage and locked the definition.
-- Anti-escalation: a non-owner cannot configure a stage that they could decide themselves
-- (name themselves, a role they hold, a permission they hold, or themselves as fallback).
create or replace function wf.put_stage(p_rule_id uuid, p_stage_no int, p_approver_type text,
                                        p_approver_permission text, p_approver_role_id uuid, p_approver_user_id uuid,
                                        p_required_approvals int, p_escalate_after_minutes int, p_escalate_to_user_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid(); v_owner boolean := authz.is_owner(); v_id uuid;
  v_perm text; v_role uuid; v_user uuid; v_required int := coalesce(p_required_approvals, 1);
  v_role_row authz.roles%rowtype;
begin
  if p_stage_no is null or p_stage_no not between 1 and 20 then
    raise exception 'VALIDATION: stage number must be between 1 and 20' using errcode = 'P0001';
  end if;
  if p_approver_type is null or p_approver_type not in ('permission','role','requester_manager','user') then
    raise exception 'VALIDATION: approver type must be permission, role, requester_manager or user' using errcode = 'P0001';
  end if;
  if v_required not between 1 and 5 then
    raise exception 'VALIDATION: required approvals must be between 1 and 5' using errcode = 'P0001';
  end if;

  case p_approver_type
    when 'permission' then
      v_perm := nullif(trim(p_approver_permission), '');
      if v_perm is null or v_perm not like 'wf.decide.%'
         or not exists (select 1 from authz.permissions where code = v_perm) then
        raise exception 'VALIDATION: a permission stage needs an existing wf.decide.* permission' using errcode = 'P0001';
      end if;
      if not v_owner and authz.has_permission(v_perm) then
        raise exception 'ESCALATION_BLOCKED: you hold % yourself; only an owner can route a stage to it', v_perm
          using errcode = '42501';
      end if;
    when 'role' then
      select * into v_role_row from authz.roles where id = p_approver_role_id;
      if v_role_row.id is null or not v_role_row.is_active then
        raise exception 'VALIDATION: a role stage needs an active role' using errcode = 'P0001';
      end if;
      v_role := v_role_row.id;
      if not v_owner and exists (
          select 1 from authz.user_roles ur where ur.user_id = v_uid and ur.role_id = v_role
            and ur.revoked_at is null and (ur.valid_to is null or ur.valid_to > now())) then
        raise exception 'ESCALATION_BLOCKED: you hold this role yourself; only an owner can route a stage to it'
          using errcode = '42501';
      end if;
    when 'user' then
      v_user := p_approver_user_id;
      if v_user is null or not wf.user_is_active(v_user) then
        raise exception 'VALIDATION: a user stage needs an active user' using errcode = 'P0001';
      end if;
      if not v_owner and v_user = v_uid then
        raise exception 'ESCALATION_BLOCKED: you cannot name yourself as an approver' using errcode = '42501';
      end if;
      if v_required <> 1 then
        raise exception 'VALIDATION: a single named user gives exactly one approval' using errcode = 'P0001';
      end if;
    else -- requester_manager
      if v_required <> 1 then
        raise exception 'VALIDATION: the requester''s manager gives exactly one approval' using errcode = 'P0001';
      end if;
  end case;

  if p_escalate_after_minutes is not null and p_escalate_after_minutes not between 15 and 43200 then
    raise exception 'VALIDATION: escalate after must be between 15 minutes and 30 days' using errcode = 'P0001';
  end if;
  if p_escalate_to_user_id is not null then
    if p_escalate_after_minutes is null then
      raise exception 'VALIDATION: an escalation fallback needs an escalate-after time' using errcode = 'P0001';
    end if;
    if not wf.user_is_active(p_escalate_to_user_id) then
      raise exception 'VALIDATION: the escalation fallback must be an active user' using errcode = 'P0001';
    end if;
    if not v_owner and p_escalate_to_user_id = v_uid then
      raise exception 'ESCALATION_BLOCKED: you cannot name yourself as the escalation fallback' using errcode = '42501';
    end if;
  end if;

  insert into wf.workflow_stages (rule_id, stage_no, approver_type, approver_permission, approver_role_id,
                                  approver_user_id, required_approvals, escalate_after, escalate_to_user_id)
  values (p_rule_id, p_stage_no, p_approver_type, v_perm, v_role, v_user, v_required,
          case when p_escalate_after_minutes is null then null else make_interval(mins => p_escalate_after_minutes) end,
          p_escalate_to_user_id)
  on conflict (rule_id, stage_no) do update set
    approver_type       = excluded.approver_type,
    approver_permission = excluded.approver_permission,
    approver_role_id    = excluded.approver_role_id,
    approver_user_id    = excluded.approver_user_id,
    required_approvals  = excluded.required_approvals,
    escalate_after      = excluded.escalate_after,
    escalate_to_user_id = excluded.escalate_to_user_id
  returning id into v_id;
  return v_id;
end $$;

-- After a configuration change: every definition keeps a catch-all rule (otherwise a request
-- that matches nothing makes its command fail with WORKFLOW_MISSING), and every rule that is
-- not auto-approved keeps at least one stage. Bumps the definition version and records it.
create or replace function wf.after_config_change(p_definition_id uuid, p_action text, p_reason text, p_details jsonb)
returns int language plpgsql security definer set search_path = '' as $$
declare v_def wf.workflow_definitions%rowtype; v_version int;
begin
  select * into v_def from wf.workflow_definitions where id = p_definition_id;
  if not exists (select 1 from wf.workflow_rules where definition_id = p_definition_id and condition = '{}'::jsonb) then
    raise exception 'CATCH_ALL_REQUIRED: workflow % must keep one rule with an empty condition', v_def.code
      using errcode = 'P0001';
  end if;
  if exists (select 1 from wf.workflow_rules r where r.definition_id = p_definition_id and not r.auto_approve
             and not exists (select 1 from wf.workflow_stages s where s.rule_id = r.id)) then
    raise exception 'VALIDATION: every rule needs at least one stage unless it auto-approves' using errcode = 'P0001';
  end if;
  update wf.workflow_definitions set version = version + 1 where id = p_definition_id returning version into v_version;
  perform authz.log_security_event('workflow_changed', case when authz.is_owner() then 'info' else 'warning' end,
    coalesce(p_details, '{}') || jsonb_build_object('workflow', v_def.code, 'action', p_action,
                                                     'reason', p_reason, 'version', v_version));
  if not authz.is_owner() then
    perform wf.notify_owners_of_change('Approval workflow changed: ' || v_def.name,
      jsonb_build_object('workflow', v_def.code, 'action', p_action, 'version', v_version));
  end if;
  return v_version;
end $$;

-- People pickers for the workflow screens (names and job titles only; no contact details).
-- Self-scoping: empty unless the caller may configure workflows or manage delegations.
-- in_delegation_scope = the caller may create delegations on that person's behalf.
create or replace function core.workflow_people()
returns table (user_id uuid, employee_id uuid, employee_no text, full_name_en text, full_name_ar text,
               job_title text, in_delegation_scope boolean)
language sql stable security definer set search_path = '' as $$
  with me as (
    select authz.is_active_user()
           and (authz.has_permission('admin.workflow.manage') or authz.has_permission('wf.delegation.manage')) as allowed,
           authz.has_global('wf.delegation.manage') as all_scope,
           authz.employee_ids('wf.delegation.manage') as scope_ids
  )
  select p.user_id, e.id, e.employee_no, e.full_name_en, e.full_name_ar, e.job_title,
         (me.all_scope or e.id = any(me.scope_ids))
  from me
  join core.employees e on me.allowed
  join core.user_profiles p on p.employee_id = e.id and p.status = 'active'
  where e.employment_status in ('active','on_leave')
$$;

-- Users whose delegations the caller manages (wf.delegation.manage own/team/all). For RLS.
create or replace function authz.delegation_user_ids() returns uuid[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(p.user_id), '{}'::uuid[])
  from core.user_profiles p
  where authz.is_active_user()
    and (authz.has_global('wf.delegation.manage')
         or p.employee_id = any(authz.employee_ids('wf.delegation.manage')))
$$;

-- ---------------------------------------------------------------------------
-- 2. Decision authority (replaces the 20261029001050 definition; see header)
-- ---------------------------------------------------------------------------
create or replace function wf.resolve_principal(p_request_id uuid, out o_principal uuid, out o_on_behalf_of uuid, out o_verdict text)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid(); r wf.approval_requests%rowtype; v_stage uuid; v_stage_no int;
  v_self text; v_d record; v_v text; v_saw_limit boolean := false;
begin
  o_verdict := 'no';
  if v_uid is null or not wf.user_is_active(v_uid) then return; end if;
  select * into r from wf.approval_requests where id = p_request_id;
  if not found or r.status <> 'pending' or r.requested_by = v_uid then return; end if;
  if r.subject_employee_id is not null
     and r.subject_employee_id = (select employee_id from core.user_profiles where user_id = v_uid) then
    return;                                   -- nobody decides a request about themselves
  end if;
  v_stage := wf.current_stage_id(p_request_id);
  if v_stage is null then return; end if;
  select stage_no into v_stage_no from wf.workflow_stages where id = v_stage;

  v_self := wf.user_stage_check(v_uid, p_request_id, v_stage);
  if v_self = 'ok' and not wf.already_decided(p_request_id, v_stage_no, v_uid, v_uid) then
    o_principal := v_uid; o_on_behalf_of := null; o_verdict := 'ok'; return;
  end if;
  v_saw_limit := (v_self = 'limit');

  -- (b) escalation reached the caller for this stage: they decide it as themselves.
  if exists (select 1 from wf.approval_escalations e
             where e.request_id = p_request_id and e.stage_no = v_stage_no and v_uid = any(e.target_user_ids))
     and not wf.already_decided(p_request_id, v_stage_no, v_uid, v_uid) then
    o_principal := v_uid; o_on_behalf_of := null; o_verdict := 'ok'; return;
  end if;

  for v_d in
    select d.from_user_id from wf.delegations d
    where d.to_user_id = v_uid and d.valid_from <= now() and d.valid_to > now()
      and d.revoked_at is null                                         -- (a)
      and (d.definition_id is null or d.definition_id = r.definition_id)
      and d.from_user_id <> r.requested_by
      and (r.subject_employee_id is null or r.subject_employee_id is distinct from
           (select employee_id from core.user_profiles where user_id = d.from_user_id))
    order by d.created_at
  loop
    v_v := wf.user_stage_check(v_d.from_user_id, p_request_id, v_stage);
    if v_v = 'ok' and not wf.already_decided(p_request_id, v_stage_no, v_d.from_user_id, v_uid) then
      o_principal := v_d.from_user_id; o_on_behalf_of := v_d.from_user_id; o_verdict := 'ok'; return;
    end if;
    v_saw_limit := v_saw_limit or v_v = 'limit';
  end loop;
  if v_saw_limit then o_verdict := 'limit'; end if;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Commands
-- ---------------------------------------------------------------------------

-- Create (p_rule_id NULL) or edit a rule of a workflow. A new rule that does not auto-approve
-- must come with its stages (p_stages: [{stage_no?, approver_type, approver_permission,
-- approver_role_id, approver_user_id, required_approvals, escalate_after_minutes,
-- escalate_to_user_id}]); stages of an existing rule are edited with api.set_workflow_stage.
-- Only an owner may make a rule auto-approve.
create or replace function api.upsert_workflow_rule(p_definition_code text, p_priority int,
                                                    p_condition jsonb default '{}'::jsonb,
                                                    p_auto_approve boolean default false,
                                                    p_rule_id uuid default null,
                                                    p_stages jsonb default null,
                                                    p_reason text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_def wf.workflow_definitions%rowtype; v_rule wf.workflow_rules%rowtype; v_err text;
  v_cond jsonb := coalesce(p_condition, '{}'::jsonb); v_auto boolean := coalesce(p_auto_approve, false);
  v_reason text := nullif(trim(p_reason), ''); v_stage jsonb; v_i int := 0; v_created boolean := false;
  v_version int; v_n int;
begin
  perform authz.require('admin.workflow.manage');
  if v_reason is null or length(v_reason) < 3 then
    raise exception 'REASON_REQUIRED: say why the workflow changes' using errcode = 'P0001';
  end if;
  select * into v_def from wf.workflow_definitions where code = p_definition_code for update;
  if not found then raise exception 'NOT_FOUND: workflow %', p_definition_code using errcode = 'P0002'; end if;
  if p_priority is null or p_priority not between 1 and 9999 then
    raise exception 'VALIDATION: priority must be between 1 and 9999' using errcode = 'P0001';
  end if;
  v_err := wf.condition_error(v_cond);
  if v_err is not null then raise exception 'INVALID_CONDITION: %', v_err using errcode = 'P0001'; end if;

  if p_rule_id is not null then
    select * into v_rule from wf.workflow_rules where id = p_rule_id and definition_id = v_def.id for update;
    if not found then raise exception 'NOT_FOUND: rule % of %', p_rule_id, v_def.code using errcode = 'P0002'; end if;
    if p_stages is not null then
      raise exception 'VALIDATION: edit the stages of an existing rule one by one' using errcode = 'P0001';
    end if;
    if v_auto and not v_rule.auto_approve and not authz.is_owner() then
      raise exception 'OWNER_ONLY: only an owner can make a rule approve automatically' using errcode = '42501';
    end if;
  elsif v_auto and not authz.is_owner() then
    raise exception 'OWNER_ONLY: only an owner can make a rule approve automatically' using errcode = '42501';
  end if;

  if exists (select 1 from wf.workflow_rules where definition_id = v_def.id and priority = p_priority
             and id is distinct from p_rule_id) then
    raise exception 'DUPLICATE: priority % is already used in %', p_priority, v_def.code using errcode = 'P0001';
  end if;

  if p_rule_id is not null then
    update wf.workflow_rules set priority = p_priority, condition = v_cond, auto_approve = v_auto
    where id = p_rule_id returning * into v_rule;
  else
    if p_stages is not null and jsonb_typeof(p_stages) <> 'array' then
      raise exception 'VALIDATION: stages must be a list' using errcode = 'P0001';
    end if;
    v_n := coalesce(jsonb_array_length(p_stages), 0);
    if v_n = 0 and not v_auto then
      raise exception 'VALIDATION: a new rule needs at least one stage' using errcode = 'P0001';
    end if;
    if v_n > 20 then raise exception 'VALIDATION: at most 20 stages' using errcode = 'P0001'; end if;
    insert into wf.workflow_rules (definition_id, priority, condition, auto_approve)
    values (v_def.id, p_priority, v_cond, v_auto) returning * into v_rule;
    v_created := true;
    for v_stage in select e from jsonb_array_elements(coalesce(p_stages, '[]'::jsonb)) e loop
      v_i := v_i + 1;
      if jsonb_typeof(v_stage) <> 'object' then
        raise exception 'VALIDATION: stage % must be an object', v_i using errcode = 'P0001';
      end if;
      if exists (select 1 from wf.workflow_stages
                 where rule_id = v_rule.id
                   and stage_no = coalesce(wf.try_int(v_stage ->> 'stage_no'), v_i)) then
        raise exception 'VALIDATION: stage numbers must be distinct' using errcode = 'P0001';
      end if;
      perform wf.put_stage(v_rule.id,
                           coalesce(wf.try_int(v_stage ->> 'stage_no'), v_i),
                           v_stage ->> 'approver_type',
                           v_stage ->> 'approver_permission',
                           core.try_cast_uuid(v_stage ->> 'approver_role_id'),
                           core.try_cast_uuid(v_stage ->> 'approver_user_id'),
                           coalesce(wf.try_int(v_stage ->> 'required_approvals'), 1),
                           wf.try_int(v_stage ->> 'escalate_after_minutes'),
                           core.try_cast_uuid(v_stage ->> 'escalate_to_user_id'));
    end loop;
  end if;

  v_version := wf.after_config_change(v_def.id, case when v_created then 'rule_created' else 'rule_updated' end, v_reason,
    jsonb_build_object('rule_id', v_rule.id, 'priority', v_rule.priority, 'condition', v_rule.condition,
                       'auto_approve', v_rule.auto_approve));
  return jsonb_build_object('rule_id', v_rule.id, 'created', v_created, 'workflow', v_def.code, 'version', v_version);
end $$;

-- Set (insert or update) or remove one stage of a rule.
-- Removing is refused while a request on the rule is pending (its path would change under
-- it) and for the last stage of a rule that does not auto-approve.
create or replace function api.set_workflow_stage(p_rule_id uuid, p_stage_no int,
                                                  p_approver_type text default null,
                                                  p_approver_permission text default null,
                                                  p_approver_role_id uuid default null,
                                                  p_approver_user_id uuid default null,
                                                  p_required_approvals int default 1,
                                                  p_escalate_after_minutes int default null,
                                                  p_escalate_to_user_id uuid default null,
                                                  p_remove boolean default false,
                                                  p_reason text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_rule wf.workflow_rules%rowtype; v_def wf.workflow_definitions%rowtype; v_reason text := nullif(trim(p_reason), '');
  v_stage_id uuid; v_version int;
begin
  perform authz.require('admin.workflow.manage');
  if v_reason is null or length(v_reason) < 3 then
    raise exception 'REASON_REQUIRED: say why the workflow changes' using errcode = 'P0001';
  end if;
  select * into v_rule from wf.workflow_rules where id = p_rule_id;
  if not found then raise exception 'NOT_FOUND: rule %', p_rule_id using errcode = 'P0002'; end if;
  select * into v_def from wf.workflow_definitions where id = v_rule.definition_id for update;
  perform 1 from wf.workflow_rules where id = p_rule_id for update;

  if coalesce(p_remove, false) then
    select id into v_stage_id from wf.workflow_stages where rule_id = p_rule_id and stage_no = p_stage_no;
    if v_stage_id is null then raise exception 'NOT_FOUND: stage % of the rule', p_stage_no using errcode = 'P0002'; end if;
    if exists (select 1 from wf.approval_requests where rule_id = p_rule_id and status = 'pending') then
      raise exception 'RULE_IN_USE: requests on this rule are pending; decide or cancel them first' using errcode = 'P0001';
    end if;
    if not v_rule.auto_approve and (select count(*) from wf.workflow_stages where rule_id = p_rule_id) = 1 then
      raise exception 'VALIDATION: a rule needs at least one stage unless it auto-approves' using errcode = 'P0001';
    end if;
    delete from wf.workflow_stages where id = v_stage_id;
  else
    v_stage_id := wf.put_stage(p_rule_id, p_stage_no, p_approver_type, p_approver_permission, p_approver_role_id,
                               p_approver_user_id, p_required_approvals, p_escalate_after_minutes, p_escalate_to_user_id);
  end if;

  v_version := wf.after_config_change(v_def.id, case when coalesce(p_remove, false) then 'stage_removed' else 'stage_set' end,
    v_reason, jsonb_build_object('rule_id', p_rule_id, 'stage_no', p_stage_no, 'approver_type', p_approver_type,
                                 'approver_permission', p_approver_permission, 'approver_role_id', p_approver_role_id,
                                 'approver_user_id', p_approver_user_id, 'required_approvals', p_required_approvals,
                                 'escalate_after_minutes', p_escalate_after_minutes,
                                 'escalate_to_user_id', p_escalate_to_user_id));
  return jsonb_build_object('rule_id', p_rule_id, 'stage_no', p_stage_no,
                            'stage_id', case when coalesce(p_remove, false) then null else v_stage_id end,
                            'removed', coalesce(p_remove, false), 'workflow', v_def.code, 'version', v_version);
end $$;

-- Out-of-office delegation: the delegate may decide the delegator's approvals only inside
-- [valid_from, valid_to), for the listed workflows (NULL/empty = all). The engine evaluates
-- the DELEGATOR's authority at decision time and still refuses self-approval, requests about
-- the delegate, and a second decision by the same person on one request.
-- From someone else (p_from_employee_id): wf.delegation.manage must cover that employee, and
-- the caller cannot make themselves the delegate. Idempotent on p_client_ref.
create or replace function api.create_delegation(p_to_employee_id uuid, p_valid_from timestamptz, p_valid_to timestamptz,
                                                 p_workflow_codes text[] default null,
                                                 p_from_employee_id uuid default null,
                                                 p_reason text default null,
                                                 p_client_ref text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid(); v_from_emp uuid; v_from_user uuid; v_to_user uuid; v_from timestamptz; v_to timestamptz;
  v_max_days int; v_defs uuid[] := '{}'; v_code text; v_def uuid; v_ids uuid[] := '{}'; v_id uuid;
  v_reason text := nullif(trim(p_reason), ''); v_ref text := nullif(trim(p_client_ref), '');
  v_codes text[]; v_all boolean;
begin
  if v_uid is null or not authz.is_active_user() then
    raise exception 'PERMISSION_DENIED: inactive or unknown user' using errcode = '42501';
  end if;
  perform authz.require('wf.delegation.manage');

  if v_ref is not null then
    if length(v_ref) > 100 then raise exception 'VALIDATION: client_ref is too long' using errcode = 'P0001'; end if;
    perform pg_advisory_xact_lock(hashtextextended('wf.delegation:' || v_uid::text || ':' || v_ref, 0));
    select coalesce(array_agg(id order by created_at, id), '{}') into v_ids
    from wf.delegations where created_by = v_uid and client_ref = v_ref;
    if cardinality(v_ids) > 0 then
      return jsonb_build_object('delegation_ids', to_jsonb(v_ids), 'replayed', true);
    end if;
  end if;

  v_from_emp := coalesce(p_from_employee_id, authz.current_employee_id());
  if v_from_emp is null then
    raise exception 'VALIDATION: your login is not linked to an employee' using errcode = 'P0001';
  end if;
  select user_id into v_from_user from core.employees where id = v_from_emp;
  if not found then raise exception 'NOT_FOUND: employee %', v_from_emp using errcode = 'P0002'; end if;
  if v_from_user is distinct from v_uid and not authz.employee_in_scope('wf.delegation.manage', v_from_emp) then
    raise exception 'PERMISSION_DENIED: you cannot manage delegations of this employee' using errcode = '42501';
  end if;
  if v_from_user is null or not wf.user_is_active(v_from_user) then
    raise exception 'VALIDATION: the delegator is not an active user' using errcode = 'P0001';
  end if;

  select user_id into v_to_user from core.employees where id = p_to_employee_id;
  if not found then raise exception 'NOT_FOUND: employee %', p_to_employee_id using errcode = 'P0002'; end if;
  if v_to_user is null or not wf.user_is_active(v_to_user) then
    raise exception 'VALIDATION: the delegate is not an active user' using errcode = 'P0001';
  end if;
  if v_to_user = v_from_user then
    raise exception 'VALIDATION: a delegation needs two different people' using errcode = 'P0001';
  end if;
  if v_from_user <> v_uid and v_to_user = v_uid then
    raise exception 'SELF_GRANT_FORBIDDEN: you cannot delegate someone else''s approvals to yourself' using errcode = '42501';
  end if;
  if v_reason is not null and length(v_reason) > 500 then
    raise exception 'VALIDATION: reason is too long' using errcode = 'P0001';
  end if;

  v_from := greatest(coalesce(p_valid_from, now()), now());
  v_to := p_valid_to;
  select coalesce((select (s.value #>> '{}')::int from core.system_settings s where s.key = 'wf.delegation.max_days'), 90)
    into v_max_days;
  if v_to is null or v_to <= v_from then
    raise exception 'VALIDATION: the delegation must end after it starts (and in the future)' using errcode = 'P0001';
  end if;
  if v_to - v_from > make_interval(days => v_max_days) then
    raise exception 'VALIDATION: a delegation lasts at most % days', v_max_days using errcode = 'P0001';
  end if;
  if v_from > now() + interval '365 days' then
    raise exception 'VALIDATION: a delegation starts within a year' using errcode = 'P0001';
  end if;

  select coalesce(array_agg(distinct c), '{}') into v_codes
  from unnest(coalesce(p_workflow_codes, '{}'::text[])) c where nullif(trim(c), '') is not null;
  v_all := cardinality(v_codes) = 0;
  if v_all then
    v_defs := array[null::uuid];
  else
    foreach v_code in array v_codes loop
      select id into v_def from wf.workflow_definitions where code = trim(v_code) and is_active;
      if v_def is null then raise exception 'NOT_FOUND: workflow %', v_code using errcode = 'P0002'; end if;
      v_defs := v_defs || v_def;
    end loop;
  end if;

  if exists (select 1 from wf.delegations d
             where d.from_user_id = v_from_user and d.to_user_id = v_to_user and d.revoked_at is null
               and d.valid_from < v_to and d.valid_to > v_from
               and (d.definition_id is null or v_all or d.definition_id = any(v_defs))) then
    raise exception 'DUPLICATE: an overlapping delegation to this person already exists' using errcode = 'P0001';
  end if;

  foreach v_def in array v_defs loop
    insert into wf.delegations (from_user_id, to_user_id, definition_id, valid_from, valid_to,
                                created_by, reason, client_ref)
    values (v_from_user, v_to_user, v_def, v_from, v_to, v_uid, v_reason, v_ref)
    returning id into v_id;
    v_ids := v_ids || v_id;
  end loop;

  perform notify.send_in_app(v_to_user, 'delegation.created', 'You can decide approvals on someone''s behalf', v_reason,
                             '/workflow/delegations',
                             jsonb_build_object('delegation_ids', to_jsonb(v_ids), 'from_user_id', v_from_user,
                                                'valid_from', v_from, 'valid_to', v_to, 'workflows', to_jsonb(v_codes)));
  if v_from_user <> v_uid then
    perform notify.send_in_app(v_from_user, 'delegation.created', 'Your approvals were delegated', v_reason,
                               '/workflow/delegations',
                               jsonb_build_object('delegation_ids', to_jsonb(v_ids), 'to_user_id', v_to_user,
                                                  'valid_from', v_from, 'valid_to', v_to, 'workflows', to_jsonb(v_codes)));
  end if;
  return jsonb_build_object('delegation_ids', to_jsonb(v_ids), 'from_user_id', v_from_user, 'to_user_id', v_to_user,
                            'valid_from', v_from, 'valid_to', v_to, 'replayed', false);
end $$;

-- End a delegation now (nothing is deleted). Allowed for the delegator, the delegate (decline),
-- a manager whose wf.delegation.manage covers the delegator, and workflow administrators.
-- Revoking a revoked delegation is a no-op.
create or replace function api.revoke_delegation(p_delegation_id uuid, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid(); d wf.delegations%rowtype; v_from_emp uuid; v_reason text := nullif(trim(p_reason), '');
begin
  if v_uid is null or not authz.is_active_user() then
    raise exception 'PERMISSION_DENIED: inactive or unknown user' using errcode = '42501';
  end if;
  select * into d from wf.delegations where id = p_delegation_id for update;
  if not found then raise exception 'NOT_FOUND: delegation %', p_delegation_id using errcode = 'P0002'; end if;
  select employee_id into v_from_emp from core.user_profiles where user_id = d.from_user_id;
  if not (d.from_user_id = v_uid or d.to_user_id = v_uid
          or authz.has_permission('admin.workflow.manage')
          or (v_from_emp is not null and authz.employee_in_scope('wf.delegation.manage', v_from_emp))) then
    raise exception 'PERMISSION_DENIED: you cannot end this delegation' using errcode = '42501';
  end if;
  if d.revoked_at is not null then
    return jsonb_build_object('delegation_id', d.id, 'status', 'revoked', 'replayed', true);
  end if;
  if d.valid_to <= now() then
    raise exception 'INVALID_STATE: the delegation has already ended' using errcode = 'P0001';
  end if;
  if v_reason is not null and length(v_reason) > 500 then
    raise exception 'VALIDATION: reason is too long' using errcode = 'P0001';
  end if;
  update wf.delegations set revoked_at = now(), revoked_by = v_uid, revoke_reason = v_reason where id = d.id;
  if d.to_user_id <> v_uid then
    perform notify.send_in_app(d.to_user_id, 'delegation.revoked', 'A delegation to you has ended', v_reason,
                               '/workflow/delegations', jsonb_build_object('delegation_id', d.id));
  end if;
  if d.from_user_id <> v_uid then
    perform notify.send_in_app(d.from_user_id, 'delegation.revoked', 'Your delegation has ended', v_reason,
                               '/workflow/delegations', jsonb_build_object('delegation_id', d.id));
  end if;
  return jsonb_build_object('delegation_id', d.id, 'status', 'revoked', 'replayed', false);
end $$;

-- ---------------------------------------------------------------------------
-- 4. Escalation job (service_role only)
-- ---------------------------------------------------------------------------
-- For each pending request whose current stage has escalate_after: once it has waited
-- level × escalate_after on that stage, escalate one more level (at most
-- wf.escalation.max_levels, one level per run):
--   level 1: the stage's escalate_to_user_id; else the approver's manager ('user' stage: the
--            named user's manager; 'requester_manager' stage: that manager's manager);
--            permission/role stages without a fallback go to the owners.
--   level n: the managers of level n-1's targets; nobody above → the owners.
-- The requester and the employee the request is about are never targets. Targets may decide
-- the stage (wf.resolve_principal (b)), are notified in-app, and an `approval.escalated`
-- outbox event is written. Idempotent: (request, stage, level) is unique; concurrent runs skip
-- locked requests.
create or replace function service.workflow_escalate(p_limit int default 200)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_limit int := least(greatest(coalesce(p_limit, 200), 1), 2000);
  v_max int; r record; v_level int; v_prev uuid[]; v_seen uuid[]; v_targets uuid[]; v_basis text;
  v_exclude uuid[]; v_id uuid; v_t uuid;
  v_scanned int := 0; v_escalated int := 0; v_notified int := 0; v_owner_fallback int := 0; v_no_target int := 0;
begin
  select coalesce((select (s.value #>> '{}')::int from core.system_settings s where s.key = 'wf.escalation.max_levels'), 3)
    into v_max;
  v_max := least(greatest(v_max, 1), 10);

  for r in
    select ar.id, ar.requested_by, ar.subject_employee_id, ar.entity_type, ar.entity_id, ar.current_stage,
           d.code, d.name, s.stage_no, s.approver_type, s.approver_user_id, s.escalate_after, s.escalate_to_user_id
    from wf.approval_requests ar
    join wf.workflow_definitions d on d.id = ar.definition_id
    join wf.workflow_stages s on s.rule_id = ar.rule_id and s.stage_no = ar.current_stage
    where ar.status = 'pending' and s.escalate_after is not null
      and coalesce((select max(st.decided_at) from wf.approval_steps st
                    where st.request_id = ar.id and st.stage_no < ar.current_stage), ar.created_at)
          + s.escalate_after <= now()
    order by ar.created_at, ar.id
    limit v_limit
    for update of ar skip locked
  loop
    v_scanned := v_scanned + 1;
    select coalesce(max(e.level), 0) + 1 into v_level
    from wf.approval_escalations e where e.request_id = r.id and e.stage_no = r.stage_no;
    continue when v_level > v_max;
    continue when wf.stage_started_at(r.id) + r.escalate_after * v_level > now();

    select coalesce(array_agg(distinct t), '{}') into v_seen
    from wf.approval_escalations e cross join lateral unnest(e.target_user_ids) t
    where e.request_id = r.id and e.stage_no = r.stage_no;
    select e.target_user_ids into v_prev from wf.approval_escalations e
    where e.request_id = r.id and e.stage_no = r.stage_no and e.level = v_level - 1;

    v_exclude := array[r.requested_by]
                 || coalesce((select array_agg(e.user_id) from core.employees e
                              where e.id = r.subject_employee_id and e.user_id is not null), '{}'::uuid[]);

    if v_level = 1 then
      if r.escalate_to_user_id is not null and wf.user_is_active(r.escalate_to_user_id) then
        v_targets := array[r.escalate_to_user_id]; v_basis := 'fallback';
      elsif r.approver_type = 'user' then
        v_targets := wf.manager_user_ids(array[r.approver_user_id]); v_basis := 'approver_manager';
      elsif r.approver_type = 'requester_manager' then
        v_targets := wf.manager_user_ids(wf.manager_user_ids(array[r.requested_by])); v_basis := 'approver_manager';
      else
        v_targets := '{}'; v_basis := 'owners';
      end if;
    else
      v_targets := wf.manager_user_ids(coalesce(v_prev, '{}')); v_basis := 'approver_manager';
    end if;

    select coalesce(array_agg(distinct t), '{}') into v_targets
    from unnest(v_targets) t where not (t = any(v_exclude));
    if cardinality(v_targets) = 0 then
      select coalesce(array_agg(distinct t), '{}') into v_targets
      from unnest(wf.owner_user_ids()) t where not (t = any(v_exclude));
      v_basis := case when cardinality(v_targets) = 0 then 'none' else 'owners' end;
    end if;

    insert into wf.approval_escalations (request_id, stage_no, level, target_user_ids, basis)
    values (r.id, r.stage_no, v_level, v_targets, v_basis)
    on conflict (request_id, stage_no, level) do nothing
    returning id into v_id;
    continue when v_id is null;
    v_escalated := v_escalated + 1;
    if v_basis = 'owners' then v_owner_fallback := v_owner_fallback + 1; end if;
    if v_basis = 'none' then v_no_target := v_no_target + 1; end if;

    foreach v_t in array v_targets loop
      continue when v_t = any(v_seen);            -- already reached at a lower level
      perform notify.send_in_app(v_t, 'approval.escalated', 'Approval escalated to you: ' || r.name, null,
                                 '/approvals/' || r.id,
                                 jsonb_build_object('request_id', r.id, 'workflow', r.code, 'stage', r.stage_no,
                                                    'level', v_level, 'entity_type', r.entity_type,
                                                    'entity_id', r.entity_id));
      v_notified := v_notified + 1;
    end loop;

    insert into integration.outbox (event_type, aggregate_type, aggregate_id, payload)
    values ('approval.escalated', 'wf.approval_request', r.id,
            jsonb_build_object('request_id', r.id, 'workflow', r.code, 'entity_type', r.entity_type,
                               'entity_id', r.entity_id, 'stage', r.stage_no, 'level', v_level,
                               'basis', v_basis, 'target_count', cardinality(v_targets)));
  end loop;

  return jsonb_build_object('scanned', v_scanned, 'escalated', v_escalated, 'notified', v_notified,
                            'owner_fallback', v_owner_fallback, 'no_target', v_no_target);
end $$;

-- ---------------------------------------------------------------------------
-- 5. RLS and read views
-- ---------------------------------------------------------------------------
-- Escalations: visible exactly when the request is (same pattern as approval_steps).
create policy approval_escalations_select on wf.approval_escalations for select to authenticated using (
  exists (select 1 from wf.approval_requests r where r.id = approval_escalations.request_id));

-- Managers see the delegations of the people their wf.delegation.manage covers (additive).
create policy delegations_select_scope on wf.delegations for select to authenticated using (
  from_user_id = any((select authz.delegation_user_ids())::uuid[]));

grant select on wf.approval_escalations to authenticated;

create or replace view api.v_workflow_definitions with (security_invoker = true) as
  select d.id, d.code, d.name, d.entity_type, d.is_active, d.version,
         (select count(*) from wf.workflow_rules r where r.definition_id = d.id)::int as rule_count
  from wf.workflow_definitions d;

create or replace view api.v_workflow_rules with (security_invoker = true) as
  select r.id as rule_id, r.definition_id, d.code as workflow_code, r.priority, r.condition, r.auto_approve,
         (r.condition = '{}'::jsonb) as is_catch_all,
         (select count(*) from wf.workflow_stages s where s.rule_id = r.id)::int as stage_count
  from wf.workflow_rules r join wf.workflow_definitions d on d.id = r.definition_id;

create or replace view api.v_workflow_stages with (security_invoker = true) as
  select s.id as stage_id, s.rule_id, s.stage_no, s.approver_type, s.approver_permission,
         s.approver_role_id, ro.code as approver_role_code, ro.name_en as approver_role_name_en,
         ro.name_ar as approver_role_name_ar,
         s.approver_user_id, au.full_name_en as approver_user_name_en, au.full_name_ar as approver_user_name_ar,
         s.required_approvals,
         (extract(epoch from s.escalate_after) / 60)::int as escalate_after_minutes,
         s.escalate_to_user_id, eu.full_name_en as escalate_to_name_en, eu.full_name_ar as escalate_to_name_ar
  from wf.workflow_stages s
  left join authz.roles ro on ro.id = s.approver_role_id
  left join lateral core.user_display(s.approver_user_id) au on true
  left join lateral core.user_display(s.escalate_to_user_id) eu on true;

create or replace view api.v_delegations with (security_invoker = true) as
  select dl.id, dl.from_user_id, fu.full_name_en as from_name_en, fu.full_name_ar as from_name_ar,
         dl.to_user_id, tu.full_name_en as to_name_en, tu.full_name_ar as to_name_ar,
         dl.definition_id, d.code as workflow_code, d.name as workflow_name,
         dl.valid_from, dl.valid_to, dl.created_at, dl.created_by, dl.reason,
         dl.revoked_at, dl.revoked_by, dl.revoke_reason,
         case when dl.revoked_at is not null then 'revoked'
              when dl.valid_to <= now() then 'ended'
              when dl.valid_from > now() then 'scheduled'
              else 'active' end as status,
         (dl.from_user_id = (select auth.uid())) as is_from_me,
         (dl.to_user_id = (select auth.uid())) as is_to_me
  from wf.delegations dl
  left join wf.workflow_definitions d on d.id = dl.definition_id
  left join lateral core.user_display(dl.from_user_id) fu on true
  left join lateral core.user_display(dl.to_user_id) tu on true;

-- One row per escalated stage of a request the caller can see.
create or replace view api.v_approval_escalations with (security_invoker = true) as
  select r.id as request_id, d.code as workflow_code, d.name as workflow_name, r.entity_type, r.entity_id,
         r.status, r.current_stage, e.stage_no, r.created_at,
         max(e.level)::int as level, min(e.escalated_at) as first_escalated_at, max(e.escalated_at) as last_escalated_at,
         bool_or((select auth.uid()) = any(e.target_user_ids)) as i_am_target,
         (r.status = 'pending' and r.current_stage = e.stage_no) as is_open,
         (authz.approval_verdict(r.id) = 'ok') as can_decide
  from wf.approval_escalations e
  join wf.approval_requests r on r.id = e.request_id
  join wf.workflow_definitions d on d.id = r.definition_id
  group by r.id, d.code, d.name, e.stage_no;

create or replace view api.v_workflow_people with (security_invoker = true) as
  select p.user_id, p.employee_id, p.employee_no, p.full_name_en, p.full_name_ar, p.job_title, p.in_delegation_scope
  from core.workflow_people() p;

grant select on api.v_workflow_definitions, api.v_workflow_rules, api.v_workflow_stages, api.v_delegations,
                 api.v_approval_escalations, api.v_workflow_people to authenticated;

-- ---------------------------------------------------------------------------
-- 6. Privileges
-- ---------------------------------------------------------------------------
-- Internal helpers and the stage writer: never client-callable (suite 14: wf.can_decide is the
-- only client-executable wf function).
revoke execute on function
  wf.try_int(text),
  wf.condition_error(jsonb),
  wf.manager_user_ids(uuid[]),
  wf.owner_user_ids(),
  wf.stage_started_at(uuid),
  wf.notify_owners_of_change(text, jsonb),
  wf.put_stage(uuid, int, text, text, uuid, uuid, int, int, uuid),
  wf.after_config_change(uuid, text, text, jsonb),
  wf.resolve_principal(uuid)
from public, anon, authenticated;

-- Evaluated as the caller by a policy (delegation_user_ids) or a view (workflow_people); both
-- answer only about the caller's own scope.
revoke execute on function authz.delegation_user_ids(), core.workflow_people() from public, anon;
grant execute on function authz.delegation_user_ids(), core.workflow_people() to authenticated;

revoke execute on function
  api.upsert_workflow_rule(text, int, jsonb, boolean, uuid, jsonb, text),
  api.set_workflow_stage(uuid, int, text, text, uuid, uuid, int, int, uuid, boolean, text),
  api.create_delegation(uuid, timestamptz, timestamptz, text[], uuid, text, text),
  api.revoke_delegation(uuid, text)
from public, anon;
grant execute on function
  api.upsert_workflow_rule(text, int, jsonb, boolean, uuid, jsonb, text),
  api.set_workflow_stage(uuid, int, text, text, uuid, uuid, int, int, uuid, boolean, text),
  api.create_delegation(uuid, timestamptz, timestamptz, text[], uuid, text, text),
  api.revoke_delegation(uuid, text)
to authenticated;

revoke all on function service.workflow_escalate(int) from public, anon, authenticated;
grant execute on function service.workflow_escalate(int) to service_role;
