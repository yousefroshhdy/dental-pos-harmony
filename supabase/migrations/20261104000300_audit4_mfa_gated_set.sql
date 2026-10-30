-- Honest OS migration: audit 4, MFA step-up gaps (A-M1, M-5, cross-area notes).
-- Builds on 20261103000600_mfa_step_up.sql (docs/AUTHORIZATION.md §6.7). Additive only.
--
--   1. The gated set grows: admin.settings.manage, admin.workflow.manage, audit.row_image.unmask,
--      wf.decide.write_off, sales.return.credit and perf.commission.calculate now require MFA
--      (inventory.quarantine.release already did). Commands that exercise them through
--      authz.require (update_setting, the workflow rule commands, credit_return, the
--      commission calculate/close commands) need nothing else.
--   2. Paths that exercise a gated permission WITHOUT authz.require on it call
--      authz.require_mfa(perm) themselves, after the permission/scope check (a non-holder still
--      sees PERMISSION_DENIED first):
--        a. inventory.assert_quarantine_release (A-M1): api.create_transfer and
--           api.receive_transfer out of a quarantine warehouse;
--        b. audit.read_row_images: a reveal request needs aal2 for every gated unmask
--           permission the caller holds (audit.row_image.unmask); masked reads are unchanged;
--        c. api.decide_approval: deciding a permission stage needs aal2 when the stage's
--           approver permission is gated (wf.decide.write_off). Approve and reject alike.
--   3. M-5 (working decision): the automatic freeze of a closed commission month IS its
--      approval; no workflow routing. The manual close is covered by MFA on
--      perf.commission.calculate. The cron (service.commission_run, service_role) never calls
--      authz.require, so it keeps closing months with enforcement on (suite 48).
--
-- With security.mfa_enforced off (the shipped default) nothing changes. CREATE OR REPLACE keeps
-- each function's privileges; they are restated explicitly at the end.
--
-- Anyone who later redefines inventory.assert_quarantine_release, audit.read_row_images or
-- api.decide_approval must keep the authz.require_mfa call (suite 48 fails otherwise).

-- ---------------------------------------------------------------------------
-- 1. Flags
-- ---------------------------------------------------------------------------
update authz.permissions set requires_mfa = true
where code in (
  'admin.settings.manage',          -- system settings (security.*, tracking.*, finance limits ...)
  'admin.workflow.manage',          -- approval routing and auto-approve rules
  'audit.row_image.unmask',         -- reveal phones, e-mails, GPS, balances in audit row images
  'wf.decide.write_off',            -- decide invoice write-offs (api.decide_approval)
  'sales.return.credit',            -- issue the credit note of a received return
  'perf.commission.calculate',      -- recalculate and close (freeze) commission months (M-5)
  'inventory.quarantine.release'    -- already flagged by 20261103000600; restated (idempotent)
)
  and not requires_mfa;

-- ---------------------------------------------------------------------------
-- 2a. Quarantine release. From 20261030000700_audit_phase3_fixes.sql (latest). Change: the MFA
--     step-up once the release is allowed by scope (A-M1).
-- ---------------------------------------------------------------------------
create or replace function inventory.assert_quarantine_release(p_from uuid, p_to uuid) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if (select kind from inventory.warehouses where id = p_from) = 'quarantine'
     and (select kind from inventory.warehouses where id = p_to) is distinct from 'quarantine' then
    if not inventory.in_warehouse_scope('inventory.quarantine.release', p_from) then
      raise exception 'PERMISSION_DENIED: moving stock out of quarantine needs inventory.quarantine.release'
        using errcode = '42501';
    end if;
    perform authz.require_mfa('inventory.quarantine.release');
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2b. Audit reader. From 20261103001100_audit_row_image_reader.sql (latest). Change: a reveal
--     request needs aal2 for each unmask permission the caller holds (only gated ones raise).
-- ---------------------------------------------------------------------------
create or replace function audit.read_row_images(
  p_function text, p_filters jsonb,
  p_table_schema text, p_table_name text, p_record_id text, p_actor_user_id uuid,
  p_from date, p_to date, p_action text, p_before_id bigint, p_limit int, p_reveal boolean)
returns table (id bigint, occurred_at timestamptz, actor_user_id uuid, actor_name_en text, actor_name_ar text,
               action text, table_schema text, table_name text, record_id text, changed_fields text[],
               request_id text, old_data jsonb, new_data jsonb, masked jsonb)
language plpgsql volatile set search_path = '' as $$
#variable_conflict use_column
declare
  v_limit int := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_reveal boolean := coalesce(p_reveal, false);
  v_held text[];
  v_revealed text[] := '{}';
  v_rows int := 0;
  v_e jsonb;
  r record;
begin
  if p_action is not null and p_action not in ('INSERT', 'UPDATE', 'DELETE') then
    raise exception 'VALIDATION: action must be INSERT, UPDATE or DELETE' using errcode = '22023';
  end if;
  if p_from is not null and p_to is not null and p_from > p_to then
    raise exception 'VALIDATION: the start date is after the end date' using errcode = '22023';
  end if;

  -- Unmask permissions the caller holds company-wide, evaluated once per call.
  select coalesce(array_agg(distinct m.unmask_permission), '{}') into v_held
  from audit.row_image_masks m
  where m.unmask_permission is not null and authz.has_global(m.unmask_permission);

  -- Revealing exercises the unmask permissions: step-up for the gated ones (audit 4).
  if v_reveal then
    perform authz.require_mfa(h) from unnest(v_held) h;
  end if;

  for r in
    select a.id, a.occurred_at, a.actor_user_id, e.full_name_en, e.full_name_ar, a.action,
           a.table_schema, a.table_name, a.record_id, a.changed_fields, a.request_id, a.old_data, a.new_data
    from audit.audit_log a
    left join core.user_profiles up on up.user_id = a.actor_user_id
    left join core.employees e on e.id = up.employee_id
    where (p_table_schema is null or a.table_schema = p_table_schema)
      and (p_table_name is null or a.table_name = p_table_name)
      and (p_record_id is null or a.record_id = p_record_id)
      and (p_actor_user_id is null or a.actor_user_id = p_actor_user_id)
      and (p_action is null or a.action = p_action)
      and (p_from is null or a.occurred_at >= (p_from::timestamp at time zone 'Africa/Cairo'))
      and (p_to is null or a.occurred_at < ((p_to + 1)::timestamp at time zone 'Africa/Cairo'))
      and (p_before_id is null or a.id < p_before_id)
    order by a.id desc
    limit v_limit
  loop
    v_e := audit.mask_entry(r.table_schema, r.table_name, r.old_data, r.new_data, v_held, v_reveal);
    id := r.id;
    occurred_at := r.occurred_at;
    actor_user_id := r.actor_user_id;
    actor_name_en := r.full_name_en;
    actor_name_ar := r.full_name_ar;
    action := r.action;
    table_schema := r.table_schema;
    table_name := r.table_name;
    record_id := r.record_id;
    changed_fields := r.changed_fields;
    request_id := r.request_id;
    old_data := v_e -> 'old';
    new_data := v_e -> 'new';
    masked := v_e -> 'masked';
    v_revealed := v_revealed || array(select x.value from jsonb_each_text(v_e -> 'revealed') x);
    v_rows := v_rows + 1;
    return next;
  end loop;

  -- The read itself is a security event: who looked at what.
  insert into audit.security_events (user_id, event_type, severity, details)
  values (auth.uid(), 'audit_row_image_read',
          case when cardinality(v_revealed) > 0 then 'warning' else 'info' end,
          jsonb_build_object(
            'function', p_function,
            'filters', coalesce(p_filters, '{}'::jsonb),
            'rows', v_rows,
            'reveal_requested', v_reveal,
            'revealed', (select coalesce(jsonb_agg(distinct c order by c), '[]'::jsonb) from unnest(v_revealed) c)));
end $$;

-- ---------------------------------------------------------------------------
-- 2c. Decisions. From 20261029001050_audit_fix_functions.sql (latest). Change: the MFA step-up
--     for a gated stage permission, after the approver check and before anything is written.
-- ---------------------------------------------------------------------------
create or replace function api.decide_approval(p_request_id uuid, p_decision text, p_comment text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid(); r wf.approval_requests%rowtype; v_def wf.workflow_definitions%rowtype;
  v_rule uuid; v_stage wf.workflow_stages%rowtype; v_decision text; v_p record;
  v_count int; v_next int; v_final text;
begin
  v_decision := case lower(coalesce(p_decision, ''))
                  when 'approve' then 'approved' when 'approved' then 'approved'
                  when 'reject'  then 'rejected' when 'rejected' then 'rejected' end;
  if v_decision is null then
    raise exception 'VALIDATION: decision must be approve or reject' using errcode = 'P0001';
  end if;
  if v_uid is null or not authz.is_active_user() then
    raise exception 'PERMISSION_DENIED: inactive or unknown user' using errcode = '42501';
  end if;

  select * into r from wf.approval_requests where id = p_request_id for update;
  if not found then raise exception 'NOT_FOUND: approval request %', p_request_id using errcode = 'P0002'; end if;
  if r.status <> 'pending' then
    raise exception 'INVALID_STATE: request is %', r.status using errcode = 'P0001';
  end if;
  if r.requested_by = v_uid
     or (r.subject_employee_id is not null and r.subject_employee_id = authz.current_employee_id()) then
    raise exception 'SELF_APPROVAL: you cannot decide your own request' using errcode = '42501';
  end if;
  select * into v_def from wf.workflow_definitions where id = r.definition_id;

  -- Fix the rule on first decision if the creator did not (keeps later stages consistent).
  if r.rule_id is null then
    v_rule := wf.resolve_rule(r.definition_id, r.payload);
    if v_rule is null then raise exception 'WORKFLOW_MISSING: no rule of % matches', v_def.code using errcode = 'P0001'; end if;
    update wf.approval_requests
       set rule_id = v_rule,
           current_stage = coalesce((select min(stage_no) from wf.workflow_stages where rule_id = v_rule), 1)
     where id = r.id returning * into r;
  end if;
  select * into v_stage from wf.workflow_stages where rule_id = r.rule_id and stage_no = r.current_stage;
  if not found then raise exception 'WORKFLOW_MISSING: stage % of %', r.current_stage, v_def.code using errcode = 'P0001'; end if;

  select * into v_p from wf.resolve_principal(r.id);
  if v_p.o_verdict = 'limit' then
    raise exception 'LIMIT_EXCEEDED: your approval limit for % is below this request', v_stage.approver_permission
      using errcode = '42501';
  elsif v_p.o_verdict <> 'ok' then
    if wf.already_decided(r.id, r.current_stage, v_uid, v_uid) then
      raise exception 'ALREADY_DECIDED: you already decided a stage of this request (distinct approvers per stage)' using errcode = 'P0001';
    end if;
    raise exception 'PERMISSION_DENIED: you are not an approver for stage % of %', r.current_stage, v_def.code
      using errcode = '42501';
  end if;
  -- A stage decided by a gated permission (wf.decide.write_off) needs an aal2 session (audit 4).
  perform authz.require_mfa(v_stage.approver_permission);

  insert into wf.approval_steps (request_id, stage_no, approver_id, on_behalf_of, decision, comment)
  values (r.id, r.current_stage, v_uid, v_p.o_on_behalf_of, v_decision, nullif(trim(p_comment), ''));

  if v_decision = 'rejected' then
    v_final := 'rejected';
  else
    select count(distinct coalesce(on_behalf_of, approver_id)) into v_count
    from wf.approval_steps where request_id = r.id and stage_no = r.current_stage and decision = 'approved';
    if v_count >= v_stage.required_approvals then
      select min(stage_no) into v_next from wf.workflow_stages where rule_id = r.rule_id and stage_no > r.current_stage;
      if v_next is null then
        v_final := 'approved';
      else
        update wf.approval_requests set current_stage = v_next where id = r.id;
        insert into integration.outbox (event_type, aggregate_type, aggregate_id, payload)
        values ('approval.requested', 'wf.approval_request', r.id,
                jsonb_build_object('request_id', r.id, 'workflow', v_def.code, 'entity_type', r.entity_type,
                                   'entity_id', r.entity_id, 'stage', v_next));
        perform wf.notify_stage_approvers(r.id);
      end if;
    end if;
  end if;

  if v_final is not null then
    update wf.approval_requests set status = v_final, decided_at = now() where id = r.id;
    perform wf.dispatch_decision_hook(v_def.code, r.id, v_final = 'approved');
    perform notify.send_in_app(r.requested_by, 'approval.decided',
                               'Request ' || v_final || ': ' || v_def.name, nullif(trim(p_comment), ''),
                               '/approvals/' || r.id,
                               jsonb_build_object('request_id', r.id, 'workflow', v_def.code, 'decision', v_final,
                                                  'entity_type', r.entity_type, 'entity_id', r.entity_id));
    insert into integration.outbox (event_type, aggregate_type, aggregate_id, payload)
    values ('approval.decided', 'wf.approval_request', r.id,
            jsonb_build_object('request_id', r.id, 'workflow', v_def.code, 'entity_type', r.entity_type,
                               'entity_id', r.entity_id, 'decision', v_final, 'decided_by', v_uid,
                               'on_behalf_of', v_p.o_on_behalf_of));
  end if;

  return jsonb_build_object('request_id', r.id, 'decision', v_decision,
                            'status', coalesce(v_final, 'pending'),
                            'current_stage', (select current_stage from wf.approval_requests where id = r.id),
                            'on_behalf_of', v_p.o_on_behalf_of);
end $$;

-- ---------------------------------------------------------------------------
-- Privileges (unchanged; restated because PostgreSQL grants PUBLIC execute by default)
-- ---------------------------------------------------------------------------
revoke execute on function inventory.assert_quarantine_release(uuid, uuid) from public, anon, authenticated;
revoke execute on function audit.read_row_images(text, jsonb, text, text, text, uuid, date, date, text, bigint, int, boolean)
  from public, anon, authenticated;
revoke execute on function api.decide_approval(uuid, text, text) from public, anon;
grant execute on function api.decide_approval(uuid, text, text) to authenticated;
