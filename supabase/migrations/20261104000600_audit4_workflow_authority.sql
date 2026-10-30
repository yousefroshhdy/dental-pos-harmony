-- Honest OS migration: audit 4 (access), workflow authority fixes. Tests: suite 51.
--
--   A-M4  Auto-approve rules are owner-only end to end. A non-owner could edit an owner's
--         auto-approve rule (condition {} and priority 1) so that it approved everything; only
--         switching auto-approve ON was owner-only. Now a non-owner cannot change a rule whose
--         current OR new auto_approve is true (priority, condition, the flag itself, its stages),
--         and cannot change a rule that is checked before an auto-approve rule in a way that could
--         hand that auto rule more requests (moving it behind the auto rule, or changing its
--         condition). Creating rules and editing every other rule is unchanged. There is no rule
--         delete or deactivate command, so these two commands are the only write paths.
--   A-L1  Escalation authority is re-checked when the target decides (wf.resolve_principal (b)).
--         Being named in wf.approval_escalations is no longer enough: see
--         wf.escalation_target_check for the rule.
--
-- Redefined from their latest definitions (20261103001000_workflow_admin.sql), changing only
-- what is described above: wf.resolve_principal, api.upsert_workflow_rule, api.set_workflow_stage.
-- wf.dispatch_decision_hook and authz.require are not touched. Nothing is dropped or narrowed.

-- ---------------------------------------------------------------------------
-- 1. Escalation eligibility (A-L1)
-- ---------------------------------------------------------------------------
-- May p_user decide p_stage_id of p_request_id because an escalation reached them?
-- 'ok' | 'limit' | 'no'. Evaluated live, at decision time:
--   * an escalation of this request and stage names p_user, and p_user is an active user;
--   * an active owner: 'ok' (owners are the last escalation level and hold every authority);
--   * permission and role stages: the stage's own eligibility (wf.user_stage_check): the
--     permission with a scope that covers the request and a limit that covers its amount, or
--     the role. Escalation there widens who is told, not who may decide;
--   * named-user and requester's-manager stages (they have no permission or role to hold):
--     p_user must still be linked to the stage (the stage's current fallback, or a manager above
--     the named approver / the requester / the fallback in core.employees) AND still hold
--     wf.approval.read with a scope that covers the request. A demoted target (no approving role
--     left), someone moved out of the chain, or a replaced fallback loses the decision.
-- The requester and the employee the request is about are refused by the callers.
create or replace function wf.escalation_target_check(p_user uuid, p_request_id uuid, p_stage_id uuid) returns text
language plpgsql stable security definer set search_path = '' as $$
declare
  r wf.approval_requests%rowtype; s wf.workflow_stages%rowtype;
  v_emp uuid; v_anchors uuid[]; v_linked boolean; v_terr uuid; v_wh uuid; g record;
begin
  if p_user is null then return 'no'; end if;
  select * into s from wf.workflow_stages where id = p_stage_id;
  if s.id is null then return 'no'; end if;
  if not exists (select 1 from wf.approval_escalations e
                 where e.request_id = p_request_id and e.stage_no = s.stage_no and p_user = any(e.target_user_ids)) then
    return 'no';
  end if;
  if not wf.user_is_active(p_user) then return 'no'; end if;
  select * into r from wf.approval_requests where id = p_request_id;
  if r.id is null then return 'no'; end if;

  if p_user = any(wf.owner_user_ids()) then return 'ok'; end if;

  if s.approver_type in ('permission', 'role') then
    return wf.user_stage_check(p_user, p_request_id, p_stage_id);
  end if;

  -- Named-user / requester's-manager stage: still linked to the stage?
  select e.id into v_emp from core.employees e where e.user_id = p_user;
  if v_emp is null then return 'no'; end if;
  select coalesce(array_agg(e.id), '{}'::uuid[]) into v_anchors
  from core.employees e
  where e.user_id = any(array_remove(array[
          case when s.approver_type = 'user' then s.approver_user_id else r.requested_by end,
          s.escalate_to_user_id], null));
  v_linked := (s.escalate_to_user_id is not null and p_user = s.escalate_to_user_id) or exists (
    with recursive up as (
      select e.manager_id as id, 1 as depth from core.employees e
      where e.id = any(v_anchors) and e.manager_id is not null
      union
      select e.manager_id, up.depth + 1 from core.employees e join up on e.id = up.id
      where e.manager_id is not null and up.depth < 20)
    select 1 from up where up.id = v_emp);
  if not v_linked then return 'no'; end if;

  -- ...and still an approver who may see this request.
  v_terr := core.try_cast_uuid(r.payload ->> 'territory_id');
  v_wh   := core.try_cast_uuid(r.payload ->> 'warehouse_id');
  for g in select * from wf.user_grants(p_user, 'wf.approval.read') loop
    if wf.grant_covers(p_user, g.scope, g.territory_id, g.warehouse_id, g.department_id,
                       r.subject_employee_id, v_terr, v_wh) then
      return 'ok';
    end if;
  end loop;
  return 'no';
end $$;

-- ---------------------------------------------------------------------------
-- 2. Decision authority: (b) now goes through wf.escalation_target_check. Everything else as in
--    20261103001000 (revoked delegations grant nothing; self-approval, "about you", distinct
--    approvers per request, delegator authority evaluated live, no transitive delegation).
-- ---------------------------------------------------------------------------
create or replace function wf.resolve_principal(p_request_id uuid, out o_principal uuid, out o_on_behalf_of uuid, out o_verdict text)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid(); r wf.approval_requests%rowtype; v_stage uuid; v_stage_no int;
  v_self text; v_esc text; v_d record; v_v text; v_saw_limit boolean := false;
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

  -- (b) an escalation reached the caller for this stage AND they are still eligible for it now.
  if not wf.already_decided(p_request_id, v_stage_no, v_uid, v_uid) then
    v_esc := wf.escalation_target_check(v_uid, p_request_id, v_stage);
    if v_esc = 'ok' then
      o_principal := v_uid; o_on_behalf_of := null; o_verdict := 'ok'; return;
    end if;
    v_saw_limit := v_saw_limit or v_esc = 'limit';
  end if;

  for v_d in
    select d.from_user_id from wf.delegations d
    where d.to_user_id = v_uid and d.valid_from <= now() and d.valid_to > now()
      and d.revoked_at is null
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
-- 3. Rules editor (A-M4)
-- ---------------------------------------------------------------------------
-- Could changing rule p_rule (from its stored priority/condition to p_priority/p_condition) give
-- an auto-approve rule of the same workflow more requests? Rules match first-by-priority, so a
-- rule R checked before an auto rule A keeps A's requests away from A. That protection is lost
-- when R moves behind A, or when R's condition changes (it may now match less). Moving R
-- forward, or changing a rule checked after every auto rule, can only take requests away.
create or replace function wf.rule_change_exposes_auto(p_rule_id uuid, p_priority int, p_condition jsonb)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from wf.workflow_rules r
    join wf.workflow_rules a on a.definition_id = r.definition_id and a.auto_approve and a.id <> r.id
    where r.id = p_rule_id
      and a.priority > r.priority
      and (p_priority > a.priority or p_condition is distinct from r.condition))
$$;

-- Create (p_rule_id NULL) or edit a rule of a workflow. A new rule that does not auto-approve
-- must come with its stages (p_stages: [{stage_no?, approver_type, approver_permission,
-- approver_role_id, approver_user_id, required_approvals, escalate_after_minutes,
-- escalate_to_user_id}]); stages of an existing rule are edited with api.set_workflow_stage.
-- Owner only: creating an auto-approve rule; any edit of a rule whose current or new
-- auto_approve is true; an edit of a rule checked before an auto-approve rule that could hand
-- it more requests (wf.rule_change_exposes_auto).
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
  v_version int; v_n int; v_owner boolean := authz.is_owner();
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
    if not v_owner then
      if v_auto and not v_rule.auto_approve then
        raise exception 'OWNER_ONLY: only an owner can make a rule approve automatically' using errcode = '42501';
      end if;
      if v_rule.auto_approve then
        raise exception 'OWNER_ONLY: only an owner can change a rule that approves automatically' using errcode = '42501';
      end if;
      if wf.rule_change_exposes_auto(v_rule.id, p_priority, v_cond) then
        raise exception 'OWNER_ONLY: only an owner can change a rule that is checked before an auto-approve rule'
          using errcode = '42501';
      end if;
    end if;
  elsif v_auto and not v_owner then
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
-- it) and for the last stage of a rule that does not auto-approve. Stages of an auto-approve
-- rule are owner-only (they take effect the moment an owner switches auto-approve off).
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
  -- Re-read under the locks: auto_approve only changes while the definition is locked.
  select * into v_rule from wf.workflow_rules where id = p_rule_id for update;
  if v_rule.auto_approve and not authz.is_owner() then
    raise exception 'OWNER_ONLY: only an owner can change a rule that approves automatically' using errcode = '42501';
  end if;

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

-- ---------------------------------------------------------------------------
-- 4. Privileges (explicit; create or replace keeps existing ACLs, restated here)
-- ---------------------------------------------------------------------------
revoke execute on function
  wf.escalation_target_check(uuid, uuid, uuid),
  wf.rule_change_exposes_auto(uuid, int, jsonb),
  wf.resolve_principal(uuid)
from public, anon, authenticated;

revoke execute on function
  api.upsert_workflow_rule(text, int, jsonb, boolean, uuid, jsonb, text),
  api.set_workflow_stage(uuid, int, text, text, uuid, uuid, int, int, uuid, boolean, text)
from public, anon;
grant execute on function
  api.upsert_workflow_rule(text, int, jsonb, boolean, uuid, jsonb, text),
  api.set_workflow_stage(uuid, int, text, text, uuid, uuid, int, int, uuid, boolean, text)
to authenticated;
