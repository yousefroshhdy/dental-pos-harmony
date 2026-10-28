-- Honest OS migration: Phase 3 — generic approval engine, order lifecycle, inventory operations.
--
-- Contents
--   0. Non-destructive column additions
--   1. Shared private helpers (uuid cast, order status transition, notifications)
--   2. Approval engine: wf.condition_matches, user-parameterised grant replica, stage eligibility,
--      wf.create_request, wf.can_decide, api.decide_approval, hook dispatch (hard-coded CASE)
--   3. Order pricing + commands: save_order_draft, submit_order (credit check, D-09),
--      approve/reject, reserve (FEFO), post_fulfillment, cancel; hooks
--   4. Inventory operations: goods receipts, transfers, adjustments with approval; hook
--   5. Reference data: credit-limit routing rules for 'sales.order.discount'
--   6. RLS policies for tables that had none (sales/inventory/wf)
--   7. Read views (security_invoker)
--   8. Privileges
--
-- Rules followed: every function `set search_path = ''`; commands are SECURITY DEFINER and call
-- authz.require() + a record-scope check; errors are `CODE: message` with SQLSTATE 42501/P0001/P0002;
-- prices, totals, taxes and costs of sale are computed here, never accepted from the client.

-- ---------------------------------------------------------------------------
-- 0. Column additions (expand only)
-- ---------------------------------------------------------------------------
-- The employee a request is "about" (order rep, requester for adjustments). Drives approver scope
-- (own/team) and RLS visibility under wf.approval.read.
alter table wf.approval_requests add column if not exists subject_employee_id uuid references core.employees(id);
create index if not exists idx_approval_requests_subject on wf.approval_requests (subject_employee_id) where status = 'pending';
create index if not exists idx_approval_requests_requester on wf.approval_requests (requested_by, created_at desc);

alter table sales.fulfillments add column if not exists idempotency_key text unique;
alter table sales.fulfillments add column if not exists created_at timestamptz not null default now();

alter table inventory.transfers add column if not exists shipped_at  timestamptz;
alter table inventory.transfers add column if not exists shipped_by  uuid references auth.users(id);
alter table inventory.transfers add column if not exists received_at timestamptz;
alter table inventory.transfers add column if not exists received_by uuid references auth.users(id);

alter table inventory.goods_receipts add column if not exists created_by uuid references auth.users(id);
alter table inventory.goods_receipts add column if not exists posted_at  timestamptz;

create index if not exists idx_reservations_balance on inventory.reservations (warehouse_id, variant_id, lot_id) where status = 'active';

-- ---------------------------------------------------------------------------
-- 1. Shared private helpers
-- ---------------------------------------------------------------------------
-- Text → uuid without raising (malformed input becomes NULL; callers raise a CODE error).
create or replace function core.try_cast_uuid(p_text text) returns uuid
language sql immutable set search_path = '' as $$
  select case when p_text ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              then p_text::uuid end
$$;

-- In-app notification to one user (no-op for NULL).
create or replace function notify.send_in_app(p_user uuid, p_type text, p_title text, p_body text,
                                              p_link text, p_data jsonb)
returns void language sql security definer set search_path = '' as $$
  insert into notify.notifications (recipient_user_id, type, title, body, link, data)
  select p_user, p_type, p_title, p_body, p_link, coalesce(p_data, '{}')
  where p_user is not null
$$;

-- Record scope for an order under a permission (caller = auth.uid()).
create or replace function sales.order_in_scope(p_employee_id uuid, p_territory_id uuid, p_perm text)
returns boolean language sql stable security definer set search_path = '' as $$
  select authz.has_global(p_perm)
      or p_employee_id = any(authz.employee_ids(p_perm))
      or (p_territory_id is not null and p_territory_id = any(authz.territory_ids(p_perm)))
$$;

-- The one place an order changes status after submit: validates the state machine
-- (sales.order_transitions), bumps version, writes history and an outbox event.
-- Permission checks are the caller's job (commands) or were satisfied by a workflow (hooks).
create or replace function sales.change_order_status(p_order_id uuid, p_from text, p_to text,
                                                     p_reason text default null, p_extra jsonb default '{}')
returns void language plpgsql security definer set search_path = '' as $$
declare v_order sales.orders%rowtype;
begin
  if not exists (select 1 from sales.order_transitions where from_status = p_from and to_status = p_to) then
    raise exception 'INVALID_STATE: order cannot move from % to %', p_from, p_to using errcode = 'P0001';
  end if;
  update sales.orders set status = p_to, version = version + 1, updated_at = now(),
         approved_at = case when p_to = 'approved' then now() else approved_at end
  where id = p_order_id and status = p_from
  returning * into v_order;
  if not found then
    raise exception 'INVALID_STATE: order % is not %', p_order_id, p_from using errcode = 'P0001';
  end if;
  insert into sales.order_status_history (order_id, from_status, to_status, changed_by, reason)
  values (p_order_id, p_from, p_to, auth.uid(), p_reason);
  insert into integration.outbox (event_type, aggregate_type, aggregate_id, payload)
  values ('order.' || p_to, 'sales.order', p_order_id,
          jsonb_build_object('order_id', p_order_id, 'order_no', v_order.order_no, 'status', p_to,
                             'from_status', p_from, 'reason', p_reason, 'total', v_order.total,
                             'currency', v_order.currency) || coalesce(p_extra, '{}'));
end $$;

-- Notify the order's representative.
create or replace function sales.notify_order_rep(p_order_id uuid, p_type text, p_title text, p_body text default null)
returns void language sql security definer set search_path = '' as $$
  select notify.send_in_app(e.user_id, p_type, p_title, p_body, '/orders/' || o.id,
                            jsonb_build_object('order_id', o.id, 'order_no', o.order_no, 'status', o.status))
  from sales.orders o join core.employees e on e.id = o.employee_id
  where o.id = p_order_id
$$;

-- ---------------------------------------------------------------------------
-- 2. APPROVAL ENGINE
-- ---------------------------------------------------------------------------

-- 2.1 Condition evaluator. Config is DATA: a tiny JSON predicate language, never SQL.
--   {}  or NULL                         → true
--   {"all":[{"field":"x","op":">","value":10}, ...]} → every clause true
--   ops: = != > >= < <= in ; field may be a dotted path into the payload.
-- Anything malformed (unknown keys/ops, wrong types, missing field) → false, never an error.
create or replace function wf.condition_matches(p_condition jsonb, p_payload jsonb) returns boolean
language plpgsql immutable set search_path = '' as $$
declare
  v_clause jsonb; v_field text; v_op text; v_value jsonb; v_have jsonb; v_ok boolean;
  v_t_have text; v_t_value text;
begin
  if p_condition is null or p_condition = '{}'::jsonb then return true; end if;
  if jsonb_typeof(p_condition) <> 'object' then return false; end if;
  if exists (select 1 from jsonb_object_keys(p_condition) k where k <> 'all') then return false; end if;
  if jsonb_typeof(p_condition -> 'all') is distinct from 'array' then return false; end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then return false; end if;

  for v_clause in select e from jsonb_array_elements(p_condition -> 'all') e loop
    if jsonb_typeof(v_clause) <> 'object' then return false; end if;
    if exists (select 1 from jsonb_object_keys(v_clause) k where k not in ('field','op','value')) then return false; end if;
    if jsonb_typeof(v_clause -> 'field') is distinct from 'string'
       or jsonb_typeof(v_clause -> 'op') is distinct from 'string'
       or not (v_clause ? 'value') then
      return false;
    end if;
    v_field := v_clause ->> 'field';
    v_op    := v_clause ->> 'op';
    v_value := v_clause -> 'value';
    if v_field !~ '^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*){0,4}$' then return false; end if;
    v_have := p_payload #> string_to_array(v_field, '.');
    if v_have is null or jsonb_typeof(v_have) = 'null' then return false; end if;
    v_t_have := jsonb_typeof(v_have);

    if v_op = 'in' then
      if jsonb_typeof(v_value) <> 'array' then return false; end if;
      v_ok := exists (select 1 from jsonb_array_elements(v_value) x
                      where jsonb_typeof(x) = v_t_have
                        and case when v_t_have = 'number' then (x #>> '{}')::numeric = (v_have #>> '{}')::numeric
                                 else x = v_have end);
    elsif v_op in ('=','!=','>','>=','<','<=') then
      v_t_value := jsonb_typeof(v_value);
      if v_t_value <> v_t_have or v_t_have not in ('number','string','boolean') then return false; end if;
      if v_t_have = 'boolean' and v_op not in ('=','!=') then return false; end if;
      if v_t_have = 'number' then
        v_ok := case v_op
          when '='  then (v_have #>> '{}')::numeric =  (v_value #>> '{}')::numeric
          when '!=' then (v_have #>> '{}')::numeric <> (v_value #>> '{}')::numeric
          when '>'  then (v_have #>> '{}')::numeric >  (v_value #>> '{}')::numeric
          when '>=' then (v_have #>> '{}')::numeric >= (v_value #>> '{}')::numeric
          when '<'  then (v_have #>> '{}')::numeric <  (v_value #>> '{}')::numeric
          when '<=' then (v_have #>> '{}')::numeric <= (v_value #>> '{}')::numeric end;
      else
        v_ok := case v_op
          when '='  then (v_have #>> '{}') =  (v_value #>> '{}')
          when '!=' then (v_have #>> '{}') <> (v_value #>> '{}')
          when '>'  then (v_have #>> '{}') collate "C" >  (v_value #>> '{}') collate "C"
          when '>=' then (v_have #>> '{}') collate "C" >= (v_value #>> '{}') collate "C"
          when '<'  then (v_have #>> '{}') collate "C" <  (v_value #>> '{}') collate "C"
          when '<=' then (v_have #>> '{}') collate "C" <= (v_value #>> '{}') collate "C" end;
      end if;
    else
      return false;                       -- unknown operator
    end if;
    if not coalesce(v_ok, false) then return false; end if;
  end loop;
  return true;
exception when others then
  return false;                           -- defensive: config can never break a command
end $$;

-- 2.2 Effective grants for an arbitrary user. Line-for-line replica of authz.grants() with
-- p_user in place of auth.uid(); needed to evaluate a DELEGATOR's authority while the delegate
-- is the caller. supabase/tests/database/14_* asserts it equals authz.grants() for every fixture user.
create or replace function wf.user_is_active(p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from core.user_profiles p
    left join core.employees e on e.id = p.employee_id
    where p.user_id = p_user and p.status = 'active'
      and (e.id is null or e.employment_status in ('active','on_leave')))
$$;

create or replace function wf.user_grants(p_user uuid, p_perm text)
returns table (scope text, territory_id uuid, warehouse_id uuid, department_id uuid, limit_value numeric)
language sql stable security definer set search_path = '' as $$
  with active as (select wf.user_is_active(p_user) as ok),
  owner as (
    select (select ok from active) and exists (
      select 1 from authz.user_roles ur join authz.roles r on r.id = ur.role_id
      where ur.user_id = p_user and r.is_owner_role and r.is_active
        and ur.revoked_at is null and ur.valid_from <= now()
        and (ur.valid_to is null or ur.valid_to > now())) as ok
  ),
  denied as (
    select 1 from authz.user_permission_overrides o
    where o.user_id = p_user and o.permission_code = p_perm and o.effect = 'deny'
      and (o.expires_at is null or o.expires_at > now())
  )
  select 'all'::text, null::uuid, null::uuid, null::uuid, null::numeric
  where (select ok from owner)
  union all
  select rp.scope, ur.scope_territory_id, ur.scope_warehouse_id, ur.scope_department_id, rp.limit_value
  from authz.user_roles ur
  join authz.roles r            on r.id = ur.role_id and r.is_active
  join authz.role_permissions rp on rp.role_id = ur.role_id and rp.permission_code = p_perm
  where ur.user_id = p_user and ur.revoked_at is null and ur.valid_from <= now()
    and (ur.valid_to is null or ur.valid_to > now())
    and (select ok from active) and not exists (select 1 from denied)
  union all
  select o.scope, o.scope_territory_id, null, null, o.limit_value
  from authz.user_permission_overrides o
  where o.user_id = p_user and o.permission_code = p_perm and o.effect = 'grant'
    and (o.expires_at is null or o.expires_at > now())
    and (select ok from active) and not exists (select 1 from denied)
$$;

-- Does one grant (held by p_user) cover the request's subject?
create or replace function wf.grant_covers(p_user uuid, p_scope text, p_grant_territory uuid, p_grant_warehouse uuid,
                                           p_grant_department uuid, p_subject_employee uuid,
                                           p_req_territory uuid, p_req_warehouse uuid)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare v_emp uuid;
begin
  select employee_id into v_emp from core.user_profiles where user_id = p_user;
  case p_scope
    when 'all' then return true;
    when 'own' then return v_emp is not null and p_subject_employee = v_emp;
    when 'team' then
      return v_emp is not null and p_subject_employee is not null and (p_subject_employee = v_emp or exists (
        with recursive team as (
          select e.id from core.employees e where e.manager_id = v_emp
          union
          select e.id from core.employees e join team t on e.manager_id = t.id)
        select 1 from team where id = p_subject_employee));
    when 'territory' then
      return p_req_territory is not null and exists (
        with recursive roots as (
          select p_grant_territory as id where p_grant_territory is not null
          union
          select et.territory_id from core.employee_territories et
          where p_grant_territory is null and et.employee_id = v_emp and et.valid_to is null
        ), tree as (
          select id from roots
          union
          select t.id from core.territories t join tree on t.parent_id = tree.id)
        select 1 from tree where id = p_req_territory);
    when 'warehouse' then
      return p_req_warehouse is not null and p_grant_warehouse = p_req_warehouse;
    when 'department' then
      return p_subject_employee is not null and exists (
        select 1 from core.employees s
        where s.id = p_subject_employee and s.department_id is not null
          and s.department_id = coalesce(p_grant_department,
                                         (select department_id from core.employees where id = v_emp)));
    else return false;
  end case;
end $$;

-- The number compared against an approver's limit. Per-permission metric first
-- (payload.limit_metrics[perm]), then the generic payload.limit_metric, then (legacy
-- 'sales.order.discount' requests) payload.max_manual_discount_pct. NULL = unknown →
-- only an unlimited grant may decide.
create or replace function wf.request_metric(p_payload jsonb, p_perm text, p_def_code text) returns numeric
language plpgsql immutable set search_path = '' as $$
declare v jsonb;
begin
  v := p_payload -> 'limit_metrics' -> p_perm;
  if jsonb_typeof(v) = 'number' then return (v #>> '{}')::numeric; end if;
  v := p_payload -> 'limit_metric';
  if jsonb_typeof(v) = 'number' then return (v #>> '{}')::numeric; end if;
  if p_def_code = 'sales.order.discount' then
    v := p_payload -> 'max_manual_discount_pct';
    if jsonb_typeof(v) = 'number' then return (v #>> '{}')::numeric; end if;
  end if;
  return null;
end $$;

-- First matching rule (by priority) for a definition and payload.
create or replace function wf.resolve_rule(p_definition_id uuid, p_payload jsonb) returns uuid
language sql stable security definer set search_path = '' as $$
  select r.id from wf.workflow_rules r
  where r.definition_id = p_definition_id and wf.condition_matches(r.condition, p_payload)
  order by r.priority limit 1
$$;

-- The stage a pending request is waiting on (resolving the rule if it was not fixed at creation).
create or replace function wf.current_stage_id(p_request_id uuid) returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare r wf.approval_requests%rowtype; v_rule uuid; v_stage uuid;
begin
  select * into r from wf.approval_requests where id = p_request_id;
  if not found then return null; end if;
  v_rule := coalesce(r.rule_id, wf.resolve_rule(r.definition_id, r.payload));
  if v_rule is null then return null; end if;
  if r.rule_id is null then
    select id into v_stage from wf.workflow_stages where rule_id = v_rule order by stage_no limit 1;
  else
    select id into v_stage from wf.workflow_stages where rule_id = v_rule and stage_no = r.current_stage;
  end if;
  return v_stage;
end $$;

-- Can p_user decide this stage of this request? 'ok' | 'limit' (holds it, limit too low) | 'no'.
-- Self-approval and "already decided" are checked by the callers.
create or replace function wf.user_stage_check(p_user uuid, p_request_id uuid, p_stage_id uuid) returns text
language plpgsql stable security definer set search_path = '' as $$
declare
  r wf.approval_requests%rowtype; s wf.workflow_stages%rowtype;
  v_code text; v_supports boolean; v_metric numeric;
  v_covered boolean := false; v_unlimited boolean := false; v_max numeric;
  v_terr uuid; v_wh uuid; g record;
begin
  if p_user is null or not wf.user_is_active(p_user) then return 'no'; end if;
  select * into r from wf.approval_requests where id = p_request_id;
  select * into s from wf.workflow_stages where id = p_stage_id;
  if r.id is null or s.id is null then return 'no'; end if;

  if s.approver_type = 'user' then
    return case when s.approver_user_id = p_user then 'ok' else 'no' end;
  elsif s.approver_type = 'requester_manager' then
    return case when exists (
      select 1 from core.user_profiles rp
      join core.employees re on re.id = rp.employee_id
      join core.user_profiles mp on mp.employee_id = re.manager_id
      where rp.user_id = r.requested_by and mp.user_id = p_user) then 'ok' else 'no' end;
  elsif s.approver_type = 'role' then
    return case when exists (
      select 1 from authz.user_roles ur join authz.roles ro on ro.id = ur.role_id and ro.is_active
      where ur.user_id = p_user and ur.role_id = s.approver_role_id and ur.revoked_at is null
        and ur.valid_from <= now() and (ur.valid_to is null or ur.valid_to > now())) then 'ok' else 'no' end;
  elsif s.approver_type = 'permission' and s.approver_permission is not null then
    v_terr := core.try_cast_uuid(r.payload ->> 'territory_id');
    v_wh   := core.try_cast_uuid(r.payload ->> 'warehouse_id');
    for g in select * from wf.user_grants(p_user, s.approver_permission) loop
      if wf.grant_covers(p_user, g.scope, g.territory_id, g.warehouse_id, g.department_id,
                         r.subject_employee_id, v_terr, v_wh) then
        v_covered := true;
        if g.limit_value is null then v_unlimited := true;
        else v_max := greatest(coalesce(v_max, g.limit_value), g.limit_value); end if;
      end if;
    end loop;
    if not v_covered then return 'no'; end if;
    select supports_limit into v_supports from authz.permissions where code = s.approver_permission;
    if not coalesce(v_supports, false) or v_unlimited then return 'ok'; end if;
    select code into v_code from wf.workflow_definitions where id = r.definition_id;
    v_metric := wf.request_metric(r.payload, s.approver_permission, v_code);
    return case when v_metric is not null and v_metric <= v_max then 'ok' else 'limit' end;
  end if;
  return 'no';
end $$;

-- Has this principal (or this physical user) already decided the given stage?
create or replace function wf.already_decided(p_request_id uuid, p_stage_no int, p_principal uuid, p_caller uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from wf.approval_steps s
                 where s.request_id = p_request_id and s.stage_no = p_stage_no
                   and (coalesce(s.on_behalf_of, s.approver_id) = p_principal or s.approver_id = p_caller))
$$;

-- Who the caller may act as for this request's current stage: themselves, or a delegator.
-- Returns (principal, on_behalf_of, verdict) where verdict is 'ok' | 'limit' | 'no'.
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

  for v_d in
    select d.from_user_id from wf.delegations d
    where d.to_user_id = v_uid and d.valid_from <= now() and d.valid_to > now()
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

-- Caller can decide the request now (inbox + RLS). Read-only, caller-scoped.
create or replace function wf.can_decide(p_request_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select o_verdict = 'ok' from wf.resolve_principal(p_request_id)), false)
$$;

-- In-app notification for stage approvers that are individually known ('user', 'requester_manager').
-- Permission/role stages are announced through the outbox and the inbox view (see report: gap).
create or replace function wf.notify_stage_approvers(p_request_id uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare r wf.approval_requests%rowtype; s wf.workflow_stages%rowtype; v_code text; v_to uuid;
begin
  select * into r from wf.approval_requests where id = p_request_id;
  select * into s from wf.workflow_stages where id = wf.current_stage_id(p_request_id);
  if s.id is null then return; end if;
  select code into v_code from wf.workflow_definitions where id = r.definition_id;
  if s.approver_type = 'user' then
    v_to := s.approver_user_id;
  elsif s.approver_type = 'requester_manager' then
    select mp.user_id into v_to from core.user_profiles rp
    join core.employees re on re.id = rp.employee_id
    join core.user_profiles mp on mp.employee_id = re.manager_id
    where rp.user_id = r.requested_by;
  end if;
  if v_to is not null and v_to <> r.requested_by then
    perform notify.send_in_app(v_to, 'approval.requested', 'Approval requested: ' || v_code, null,
                               '/approvals/' || r.id,
                               jsonb_build_object('request_id', r.id, 'workflow', v_code, 'stage', r.current_stage,
                                                  'entity_type', r.entity_type, 'entity_id', r.entity_id));
  end if;
end $$;

-- Final-decision hooks. Hard-coded CASE: configuration can never name a function to run.
-- crm.customer.reassign / field.visit.exception hooks live in another migration and are
-- resolved by PL/pgSQL at run time.
create or replace function wf.dispatch_decision_hook(p_code text, p_request_id uuid, p_approved boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  case p_code
    when 'sales.order.discount'  then perform wf.on_decided_sales_order_discount(p_request_id, p_approved);
    when 'inventory.adjustment'  then perform wf.on_decided_inventory_adjustment(p_request_id, p_approved);
    when 'sales.order.cancel'    then perform wf.on_decided_sales_order_cancel(p_request_id, p_approved);
    when 'crm.customer.reassign' then perform wf.on_decided_crm_customer_reassign(p_request_id, p_approved);
    when 'field.visit.exception' then perform wf.on_decided_field_visit_exception(p_request_id, p_approved);
    else null;                                -- workflows without side effects
  end case;
end $$;

-- Create an approval request (called by commands, never by clients).
-- Picks the rule now (first match by priority), sets the first stage, emits approval.requested.
-- If a request for (definition, entity) is already pending, returns it (idempotent).
-- auto_approve rules approve immediately and run the hook.
create or replace function wf.create_request(p_code text, p_entity_type text, p_entity_id uuid, p_payload jsonb,
                                             p_subject_employee_id uuid default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid(); v_def wf.workflow_definitions%rowtype; v_rule wf.workflow_rules%rowtype;
  v_first int; v_id uuid;
begin
  if v_uid is null then raise exception 'PERMISSION_DENIED: no authenticated user' using errcode = '42501'; end if;
  select * into v_def from wf.workflow_definitions where code = p_code and is_active;
  if not found then raise exception 'WORKFLOW_MISSING: %', p_code using errcode = 'P0001'; end if;

  select id into v_id from wf.approval_requests
  where definition_id = v_def.id and entity_id = p_entity_id and status = 'pending';
  if v_id is not null then return v_id; end if;

  select * into v_rule from wf.workflow_rules
  where definition_id = v_def.id and wf.condition_matches(condition, p_payload)
  order by priority limit 1;
  if not found then raise exception 'WORKFLOW_MISSING: no rule of % matches', p_code using errcode = 'P0001'; end if;
  select min(stage_no) into v_first from wf.workflow_stages where rule_id = v_rule.id;
  if v_first is null and not v_rule.auto_approve then
    raise exception 'WORKFLOW_MISSING: rule of % has no stages', p_code using errcode = 'P0001';
  end if;

  insert into wf.approval_requests (definition_id, rule_id, entity_type, entity_id, requested_by, payload,
                                    current_stage, subject_employee_id)
  values (v_def.id, v_rule.id, p_entity_type, p_entity_id, v_uid, coalesce(p_payload, '{}'),
          coalesce(v_first, 1), coalesce(p_subject_employee_id, authz.current_employee_id()))
  returning id into v_id;

  insert into integration.outbox (event_type, aggregate_type, aggregate_id, payload)
  values ('approval.requested', 'wf.approval_request', v_id,
          jsonb_build_object('request_id', v_id, 'workflow', p_code, 'entity_type', p_entity_type,
                             'entity_id', p_entity_id, 'stage', coalesce(v_first, 1)));

  if v_rule.auto_approve then
    update wf.approval_requests set status = 'approved', decided_at = now() where id = v_id;
    perform wf.dispatch_decision_hook(p_code, v_id, true);
    insert into integration.outbox (event_type, aggregate_type, aggregate_id, payload)
    values ('approval.decided', 'wf.approval_request', v_id,
            jsonb_build_object('request_id', v_id, 'workflow', p_code, 'entity_type', p_entity_type,
                               'entity_id', p_entity_id, 'decision', 'approved', 'auto', true));
  else
    perform wf.notify_stage_approvers(v_id);
  end if;
  return v_id;
end $$;

-- 2.3 The decision command.
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
      raise exception 'ALREADY_DECIDED: you already decided stage %', r.current_stage using errcode = 'P0001';
    end if;
    raise exception 'PERMISSION_DENIED: you are not an approver for stage % of %', r.current_stage, v_def.code
      using errcode = '42501';
  end if;

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
-- 3. ORDERS
-- ---------------------------------------------------------------------------

-- Server-side pricing of every line of an order (customer list → promo → default; promo vs
-- requested manual discount; VAT on the discounted amount). Shared by draft (indicative) and submit.
create or replace function sales.price_order(p_order_id uuid,
  out o_subtotal numeric, out o_discount numeric, out o_tax numeric, out o_max_manual numeric)
language plpgsql security definer set search_path = '' as $$
declare v_customer uuid; v_item record; v_price record; v_promo numeric; v_applied numeric;
begin
  select customer_id into v_customer from sales.orders where id = p_order_id;
  for v_item in select * from sales.order_items where order_id = p_order_id order by line_no for update loop
    select * into v_price from sales.resolve_list_price(v_customer, v_item.variant_id, v_item.quantity);
    if v_price.unit_price is null then
      raise exception 'NO_PRICE: variant % has no active price', v_item.variant_id using errcode = 'P0001';
    end if;
    select coalesce(max(d.discount_pct), 0) into v_promo
    from sales.discount_rules d
    join catalog.product_variants pv on pv.id = v_item.variant_id
    join catalog.products p on p.id = pv.product_id
    where d.is_active and current_date between d.valid_from and coalesce(d.valid_to, current_date)
      and v_item.quantity >= d.min_qty
      and (d.variant_id is null or d.variant_id = v_item.variant_id)
      and (d.brand_id is null or d.brand_id = p.brand_id)
      and (d.category_id is null or d.category_id = p.category_id)
      and (d.customer_id is null or d.customer_id = v_customer);
    v_applied := greatest(v_promo, v_item.requested_discount_pct);
    update sales.order_items oi set
      list_price           = v_price.unit_price,
      price_list_id        = v_price.price_list_id,
      promo_discount_pct   = v_promo,
      applied_discount_pct = v_applied,
      tax_rate_pct         = p.tax_rate_pct,
      line_subtotal        = round(v_price.unit_price * v_item.quantity, 2),
      line_discount        = round(v_price.unit_price * v_item.quantity * v_applied / 100, 2),
      line_tax             = round((v_price.unit_price * v_item.quantity
                                    - round(v_price.unit_price * v_item.quantity * v_applied / 100, 2)) * p.tax_rate_pct / 100, 2),
      line_total           = round(v_price.unit_price * v_item.quantity, 2)
                             - round(v_price.unit_price * v_item.quantity * v_applied / 100, 2)
                             + round((v_price.unit_price * v_item.quantity
                                      - round(v_price.unit_price * v_item.quantity * v_applied / 100, 2)) * p.tax_rate_pct / 100, 2)
    from catalog.product_variants pv join catalog.products p on p.id = pv.product_id
    where oi.id = v_item.id and pv.id = oi.variant_id;
  end loop;
  select coalesce(sum(line_subtotal),0), coalesce(sum(line_discount),0), coalesce(sum(line_tax),0),
         coalesce(max(requested_discount_pct - promo_discount_pct), 0)
    into o_subtotal, o_discount, o_tax, o_max_manual
  from sales.order_items where order_id = p_order_id;
end $$;

-- Create or replace a draft. Lines carry ONLY variant, quantity and requested discount; anything
-- else (prices, totals, tax) is rejected. Totals returned are indicative — submit recomputes.
create or replace function api.save_order_draft(p_order_id uuid, p_customer_id uuid, p_lines jsonb,
                                                p_notes text default null, p_visit_id uuid default null,
                                                p_version int default null, p_employee_id uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid(); v_me uuid := authz.current_employee_id(); v_emp uuid;
  v_order sales.orders%rowtype; v_cust crm.customers%rowtype; v_is_new boolean;
  v_rec record; v_variant uuid; v_qty numeric; v_disc numeric; v_tot record; v_version int;
begin
  perform authz.require('sales.order.create');
  if p_order_id is null then raise exception 'VALIDATION: order id is required' using errcode = 'P0001'; end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' then
    raise exception 'VALIDATION: lines must be a JSON array' using errcode = 'P0001';
  end if;
  if jsonb_array_length(p_lines) > 200 then
    raise exception 'VALIDATION: at most 200 lines per order' using errcode = 'P0001';
  end if;

  -- Customer in the caller's CRM scope (same rule as api.visit_check_in).
  select * into v_cust from crm.customers where id = p_customer_id;
  if not found then raise exception 'NOT_FOUND: customer' using errcode = 'P0002'; end if;
  if not (authz.has_global('crm.customer.read')
          or v_cust.territory_id = any(authz.territory_ids('crm.customer.read'))
          or p_customer_id = any(authz.assigned_customer_ids('crm.customer.read'))) then
    raise exception 'PERMISSION_DENIED: customer not in your scope' using errcode = '42501';
  end if;
  if v_cust.archived_at is not null or v_cust.lifecycle_stage = 'blocked' then
    raise exception 'CUSTOMER_BLOCKED: customer is archived or blocked' using errcode = 'P0001';
  end if;

  -- Whose order: the caller, or (managers) an employee within sales.order.create scope.
  v_emp := coalesce(p_employee_id, v_me);
  if v_emp is null then raise exception 'NO_EMPLOYEE_PROFILE' using errcode = '42501'; end if;
  if v_emp is distinct from v_me and not (authz.has_global('sales.order.create')
                                          or v_emp = any(authz.employee_ids('sales.order.create'))) then
    raise exception 'PERMISSION_DENIED: employee is outside your scope' using errcode = '42501';
  end if;

  if p_visit_id is not null and not exists (
       select 1 from field.visits where id = p_visit_id and customer_id = p_customer_id) then
    raise exception 'VALIDATION: visit does not belong to this customer' using errcode = 'P0001';
  end if;

  select * into v_order from sales.orders where id = p_order_id for update;
  v_is_new := not found;
  if v_is_new then
    insert into sales.orders (id, customer_id, employee_id, visit_id, notes, payment_terms_days, created_by)
    values (p_order_id, p_customer_id, v_emp, p_visit_id, p_notes, v_cust.payment_terms_days, v_uid)
    returning * into v_order;
    insert into sales.order_status_history (order_id, from_status, to_status, changed_by, reason)
    values (p_order_id, null, 'draft', v_uid, 'draft created');
  else
    if not (authz.has_global('sales.order.create')
            or v_order.employee_id = any(authz.employee_ids('sales.order.create'))
            or v_order.created_by = v_uid) then
      raise exception 'PERMISSION_DENIED: order belongs to another representative' using errcode = '42501';
    end if;
    if v_order.status <> 'draft' then
      raise exception 'INVALID_STATE: order is %', v_order.status using errcode = 'P0001';
    end if;
    -- Optimistic concurrency. A NULL version is accepted only as a replay of the creating call.
    if p_version is null then
      if not (v_order.version = 1 and v_order.created_by = v_uid) then
        raise exception 'CONFLICT: order changed (current version %)', v_order.version using errcode = 'P0001';
      end if;
    elsif p_version <> v_order.version then
      raise exception 'CONFLICT: order changed (current version %)', v_order.version using errcode = 'P0001';
    end if;
    delete from sales.order_items where order_id = p_order_id;     -- draft lines only; no reservations exist
    update sales.orders set customer_id = p_customer_id, employee_id = v_emp, visit_id = p_visit_id,
           notes = p_notes, payment_terms_days = v_cust.payment_terms_days,
           version = case when p_version is null then version else version + 1 end, updated_at = now()
    where id = p_order_id;
  end if;

  for v_rec in select e.line, e.n from jsonb_array_elements(p_lines) with ordinality as e(line, n) loop
    if jsonb_typeof(v_rec.line) <> 'object' then
      raise exception 'VALIDATION: line % must be an object', v_rec.n using errcode = 'P0001';
    end if;
    if exists (select 1 from jsonb_object_keys(v_rec.line) k
               where k not in ('variant_id','quantity','requested_discount_pct')) then
      raise exception 'VALIDATION: line % may only contain variant_id, quantity, requested_discount_pct', v_rec.n
        using errcode = 'P0001';
    end if;
    v_variant := core.try_cast_uuid(v_rec.line ->> 'variant_id');
    if v_variant is null then raise exception 'VALIDATION: line % has no valid variant_id', v_rec.n using errcode = 'P0001'; end if;
    if jsonb_typeof(v_rec.line -> 'quantity') is distinct from 'number' then
      raise exception 'VALIDATION: line % quantity must be a number', v_rec.n using errcode = 'P0001';
    end if;
    v_qty := (v_rec.line ->> 'quantity')::numeric;
    if v_qty <> trunc(v_qty) or v_qty <= 0 or v_qty > 100000 then
      raise exception 'VALIDATION: line % quantity must be a whole number between 1 and 100000', v_rec.n using errcode = 'P0001';
    end if;
    if coalesce(jsonb_typeof(v_rec.line -> 'requested_discount_pct'), 'null') = 'null' then
      v_disc := 0;
    elsif jsonb_typeof(v_rec.line -> 'requested_discount_pct') <> 'number' then
      raise exception 'VALIDATION: line % discount must be a number', v_rec.n using errcode = 'P0001';
    else
      v_disc := (v_rec.line ->> 'requested_discount_pct')::numeric;
    end if;
    if v_disc < 0 or v_disc > 100 then
      raise exception 'VALIDATION: line % discount must be between 0 and 100', v_rec.n using errcode = 'P0001';
    end if;
    if not exists (select 1 from catalog.product_variants pv join catalog.products p on p.id = pv.product_id
                   where pv.id = v_variant and pv.status = 'active' and p.status = 'active') then
      raise exception 'NOT_FOUND: variant % is not sellable', v_variant using errcode = 'P0002';
    end if;
    insert into sales.order_items (order_id, line_no, variant_id, quantity, list_price, requested_discount_pct,
                                   tax_rate_pct, line_subtotal, line_discount, line_tax, line_total)
    values (p_order_id, v_rec.n, v_variant, v_qty::int, 0, round(v_disc, 2), 0, 0, 0, 0, 0);
  end loop;

  select * into v_tot from sales.price_order(p_order_id);
  update sales.orders set subtotal = v_tot.o_subtotal, discount_total = v_tot.o_discount, tax_total = v_tot.o_tax,
         total = v_tot.o_subtotal - v_tot.o_discount + v_tot.o_tax
  where id = p_order_id returning version into v_version;

  return jsonb_build_object(
    'order_id', p_order_id, 'version', v_version, 'status', 'draft', 'created', v_is_new,
    'subtotal', v_tot.o_subtotal, 'discount_total', v_tot.o_discount, 'tax_total', v_tot.o_tax,
    'indicative_total', v_tot.o_subtotal - v_tot.o_discount + v_tot.o_tax,
    'lines', coalesce((select jsonb_agg(jsonb_build_object('line_no', line_no, 'variant_id', variant_id,
                                'quantity', quantity, 'list_price', list_price,
                                'applied_discount_pct', applied_discount_pct, 'line_total', line_total) order by line_no)
                       from sales.order_items where order_id = p_order_id), '[]'::jsonb));
end $$;

-- Submit: prices, promo, discount authority (existing behaviour) + credit check (D-09).
create or replace function api.submit_order(p_order_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_order sales.orders%rowtype;
  v_limit numeric;
  v_max_requested numeric;
  v_tot record;
  v_sub numeric; v_disc numeric; v_tax numeric; v_total numeric;
  v_status text;
  v_territory uuid;
  v_credit_limit numeric; v_balance numeric;
  v_discount_exceeded boolean; v_credit_exceeded boolean := false;
  v_reasons text[] := '{}';
  v_request uuid;
begin
  perform authz.require('sales.order.submit');

  select * into v_order from sales.orders where id = p_order_id for update;
  if not found then raise exception 'NOT_FOUND: order %', p_order_id using errcode = 'P0002'; end if;
  if v_order.status <> 'draft' then
    raise exception 'INVALID_STATE: order is %', v_order.status using errcode = 'P0001';
  end if;
  -- ABAC: the caller must be able to act on this customer.
  if not (authz.has_global('sales.order.submit')
          or v_order.employee_id = any(authz.employee_ids('sales.order.submit'))) then
    raise exception 'PERMISSION_DENIED: order belongs to another representative' using errcode = '42501';
  end if;

  select * into v_tot from sales.price_order(p_order_id);
  v_sub := v_tot.o_subtotal; v_disc := v_tot.o_discount; v_tax := v_tot.o_tax; v_max_requested := v_tot.o_max_manual;
  if v_sub = 0 then raise exception 'EMPTY_ORDER' using errcode = 'P0001'; end if;
  v_total := v_sub - v_disc + v_tax;

  -- Discount authority: manual discount beyond promo vs. the caller's limit (NULL = unlimited).
  v_limit := authz.max_limit('sales.discount.apply');
  if v_max_requested > 0 and not authz.has_permission('sales.discount.apply') then
    v_discount_exceeded := true;
  elsif v_max_requested > coalesce(v_limit, v_max_requested) then
    v_discount_exceeded := true;
  else
    v_discount_exceeded := false;
  end if;
  if v_discount_exceeded then v_reasons := array_append(v_reasons, 'discount above limit'); end if;

  -- Credit check (D-09): AR balance + this order vs credit limit → approval, not a hard block.
  select territory_id, credit_limit into v_territory, v_credit_limit from crm.customers where id = v_order.customer_id;
  if v_credit_limit is not null then
    select coalesce((select balance from finance.v_customer_balances where customer_id = v_order.customer_id), 0)
      into v_balance;
    v_credit_exceeded := v_balance + v_total > v_credit_limit;
    if v_credit_exceeded then v_reasons := array_append(v_reasons, 'credit limit'); end if;
  end if;

  v_status := case when v_discount_exceeded or v_credit_exceeded then 'pending_approval' else 'submitted' end;

  update sales.orders set
    order_no = coalesce(order_no, core.next_document_no('SO')),
    subtotal = v_sub, discount_total = v_disc, tax_total = v_tax, total = v_total,
    status = v_status, submitted_at = now(),
    territory_id = v_territory,
    version = version + 1, updated_at = now()
  where id = p_order_id
  returning * into v_order;

  insert into sales.order_status_history (order_id, from_status, to_status, changed_by, reason)
  values (p_order_id, 'draft', v_status, auth.uid(),
          case when v_status = 'pending_approval' then array_to_string(v_reasons, '; ') end);

  if v_status = 'pending_approval' then
    v_request := wf.create_request('sales.order.discount', 'sales.order', p_order_id,
      jsonb_build_object(
        'order_id', p_order_id, 'order_no', v_order.order_no, 'customer_id', v_order.customer_id,
        'employee_id', v_order.employee_id, 'territory_id', v_territory,
        'reasons', to_jsonb(v_reasons),
        'discount_exceeded', v_discount_exceeded, 'credit_exceeded', v_credit_exceeded,
        'max_manual_discount_pct', greatest(v_max_requested, 0), 'limit_pct', v_limit,
        'total', v_total, 'credit_limit', v_credit_limit, 'balance', v_balance,
        'exposure', case when v_credit_limit is not null then v_balance + v_total end,
        'credit_excess', case when v_credit_exceeded then v_balance + v_total - v_credit_limit end,
        'limit_metric', greatest(v_max_requested, 0),
        'limit_metrics', jsonb_strip_nulls(jsonb_build_object(
            'wf.decide.order_discount', greatest(v_max_requested, 0),
            'wf.decide.credit_limit', case when v_credit_exceeded then v_balance + v_total - v_credit_limit end))),
      v_order.employee_id);
  end if;

  insert into integration.outbox (event_type, aggregate_type, aggregate_id, payload)
  values ('order.' || v_status, 'sales.order', p_order_id,
          jsonb_build_object('order_id', p_order_id, 'order_no', v_order.order_no, 'status', v_status,
                             'total', v_total, 'reasons', to_jsonb(v_reasons)));

  return jsonb_build_object('order_id', p_order_id, 'status', v_status, 'total', v_total,
                            'reasons', to_jsonb(v_reasons), 'approval_request_id', v_request);
end $$;

-- Hook: discount / credit approval decided.
create or replace function wf.on_decided_sales_order_discount(p_request_id uuid, p_approved boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare r wf.approval_requests%rowtype; v_status text;
begin
  select * into r from wf.approval_requests where id = p_request_id;
  select status into v_status from sales.orders where id = r.entity_id for update;
  if not found then raise exception 'NOT_FOUND: order %', r.entity_id using errcode = 'P0002'; end if;
  if v_status <> 'pending_approval' then
    raise exception 'INVALID_STATE: order is %', v_status using errcode = 'P0001';
  end if;
  if p_approved then
    perform sales.change_order_status(r.entity_id, 'pending_approval', 'approved',
                                      'approval request ' || p_request_id, jsonb_build_object('approval_request_id', p_request_id));
    perform sales.notify_order_rep(r.entity_id, 'order.approved', 'Order approved');
  else
    perform sales.change_order_status(r.entity_id, 'pending_approval', 'rejected',
                                      'approval request ' || p_request_id, jsonb_build_object('approval_request_id', p_request_id));
    perform sales.notify_order_rep(r.entity_id, 'order.rejected', 'Order rejected');
  end if;
end $$;

-- Accept a submitted order (no approval needed). Nobody accepts an order they raised.
create or replace function sales.assert_not_own_order(p_order sales.orders) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if p_order.employee_id = authz.current_employee_id() or p_order.created_by = auth.uid()
     or exists (select 1 from sales.order_status_history h
                where h.order_id = p_order.id and h.from_status = 'draft' and h.changed_by = auth.uid()) then
    raise exception 'SELF_APPROVAL: you cannot approve or reject your own order' using errcode = '42501';
  end if;
end $$;

create or replace function api.approve_order(p_order_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_order sales.orders%rowtype;
begin
  perform authz.require('sales.order.approve');
  select * into v_order from sales.orders where id = p_order_id for update;
  if not found then raise exception 'NOT_FOUND: order %', p_order_id using errcode = 'P0002'; end if;
  if not sales.order_in_scope(v_order.employee_id, v_order.territory_id, 'sales.order.approve') then
    raise exception 'PERMISSION_DENIED: order is outside your scope' using errcode = '42501';
  end if;
  if v_order.status <> 'submitted' then
    raise exception 'INVALID_STATE: order is %', v_order.status using errcode = 'P0001';
  end if;
  perform sales.assert_not_own_order(v_order);
  perform sales.change_order_status(p_order_id, 'submitted', 'approved', 'accepted');
  perform sales.notify_order_rep(p_order_id, 'order.approved', 'Order approved');
  return jsonb_build_object('order_id', p_order_id, 'status', 'approved');
end $$;

create or replace function api.reject_order(p_order_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_order sales.orders%rowtype;
begin
  perform authz.require('sales.order.approve');
  if coalesce(trim(p_reason), '') = '' then raise exception 'REASON_REQUIRED' using errcode = 'P0001'; end if;
  select * into v_order from sales.orders where id = p_order_id for update;
  if not found then raise exception 'NOT_FOUND: order %', p_order_id using errcode = 'P0002'; end if;
  if not sales.order_in_scope(v_order.employee_id, v_order.territory_id, 'sales.order.approve') then
    raise exception 'PERMISSION_DENIED: order is outside your scope' using errcode = '42501';
  end if;
  if v_order.status <> 'submitted' then
    raise exception 'INVALID_STATE: order is %', v_order.status using errcode = 'P0001';
  end if;
  perform sales.assert_not_own_order(v_order);
  perform sales.change_order_status(p_order_id, 'submitted', 'rejected', trim(p_reason));
  perform sales.notify_order_rep(p_order_id, 'order.rejected', 'Order rejected', trim(p_reason));
  return jsonb_build_object('order_id', p_order_id, 'status', 'rejected');
end $$;

create or replace function sales.has_pending_cancel(p_order_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from wf.approval_requests r join wf.workflow_definitions d on d.id = r.definition_id
                 where d.code = 'sales.order.cancel' and r.entity_id = p_order_id and r.status = 'pending')
$$;

-- Reserve stock for an approved order: FEFO (earliest expiry first, NULL expiry last, expired lots
-- never), all-or-nothing. Backorders are future work: a shortfall raises INSUFFICIENT_STOCK and
-- the whole call rolls back, leaving no partial reservation.
create or replace function api.reserve_order(p_order_id uuid, p_warehouse_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_order sales.orders%rowtype; v_item record; v_bal record;
  v_need int; v_take int; v_out jsonb := '[]'::jsonb;
begin
  perform authz.require('sales.order.fulfil');
  if not (authz.has_global('sales.order.fulfil') or p_warehouse_id = any(authz.warehouse_ids('sales.order.fulfil'))) then
    raise exception 'PERMISSION_DENIED: warehouse not in your scope' using errcode = '42501';
  end if;
  if not exists (select 1 from inventory.warehouses where id = p_warehouse_id and is_active) then
    raise exception 'NOT_FOUND: warehouse' using errcode = 'P0002';
  end if;
  select * into v_order from sales.orders where id = p_order_id for update;
  if not found then raise exception 'NOT_FOUND: order %', p_order_id using errcode = 'P0002'; end if;
  if v_order.status <> 'approved' then
    raise exception 'INVALID_STATE: order is %', v_order.status using errcode = 'P0001';
  end if;
  if sales.has_pending_cancel(p_order_id) then
    raise exception 'CANCEL_PENDING: a cancellation request is pending' using errcode = 'P0001';
  end if;

  for v_item in select oi.*, pv.sku from sales.order_items oi join catalog.product_variants pv on pv.id = oi.variant_id
                where oi.order_id = p_order_id order by oi.line_no loop
    v_need := v_item.quantity - v_item.fulfilled_qty
              - coalesce((select sum(quantity) from inventory.reservations
                          where order_item_id = v_item.id and status = 'active'), 0);
    if v_need <= 0 then continue; end if;
    -- Lock in lot_id order (the order fulfilment/transfers use) before allocating in FEFO order.
    perform 1 from inventory.stock_balances b
    where b.warehouse_id = p_warehouse_id and b.variant_id = v_item.variant_id
    order by b.lot_id for update;
    for v_bal in
      select b.lot_id, b.on_hand, b.reserved, l.lot_no, l.expiry_date
      from inventory.stock_balances b join inventory.lots l on l.id = b.lot_id
      where b.warehouse_id = p_warehouse_id and b.variant_id = v_item.variant_id
        and b.on_hand - b.reserved > 0
        and (l.expiry_date is null or l.expiry_date >= current_date)
      order by l.expiry_date nulls last, l.lot_no, b.lot_id
      for update of b
    loop
      exit when v_need = 0;
      v_take := least(v_need, v_bal.on_hand - v_bal.reserved);
      update inventory.stock_balances set reserved = reserved + v_take, updated_at = now()
      where warehouse_id = p_warehouse_id and variant_id = v_item.variant_id and lot_id = v_bal.lot_id;
      insert into inventory.reservations (order_item_id, warehouse_id, variant_id, lot_id, quantity)
      values (v_item.id, p_warehouse_id, v_item.variant_id, v_bal.lot_id, v_take);
      v_out := v_out || jsonb_build_object('order_item_id', v_item.id, 'lot_id', v_bal.lot_id, 'lot_no', v_bal.lot_no,
                                           'expiry_date', v_bal.expiry_date, 'quantity', v_take);
      v_need := v_need - v_take;
    end loop;
    if v_need > 0 then
      raise exception 'INSUFFICIENT_STOCK: % short by % in this warehouse', v_item.sku, v_need using errcode = 'P0001';
    end if;
  end loop;

  perform sales.change_order_status(p_order_id, 'approved', 'reserved', null,
                                    jsonb_build_object('warehouse_id', p_warehouse_id));
  return jsonb_build_object('order_id', p_order_id, 'status', 'reserved', 'reservations', v_out,
                            'backordered', '[]'::jsonb);
end $$;

-- Release every active reservation of an order (cancellation).
create or replace function inventory.release_order_reservations(p_order_id uuid) returns int
language plpgsql security definer set search_path = '' as $$
declare v_res record; v_n int := 0;
begin
  for v_res in
    select r.* from inventory.reservations r join sales.order_items oi on oi.id = r.order_item_id
    where oi.order_id = p_order_id and r.status = 'active'
    order by r.warehouse_id, r.variant_id, r.lot_id
    for update of r
  loop
    perform 1 from inventory.stock_balances
    where warehouse_id = v_res.warehouse_id and variant_id = v_res.variant_id and lot_id = v_res.lot_id for update;
    update inventory.stock_balances set reserved = reserved - v_res.quantity, updated_at = now()
    where warehouse_id = v_res.warehouse_id and variant_id = v_res.variant_id and lot_id = v_res.lot_id;
    update inventory.reservations set status = 'released', closed_at = now() where id = v_res.id;
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

-- Post the fulfilment of an order's active reservations. Replay with the same key returns the
-- original fulfilment.
create or replace function api.post_fulfillment(p_order_id uuid, p_idempotency_key text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_order sales.orders%rowtype; v_existing sales.fulfillments%rowtype; v_wh uuid; v_n_wh int;
  v_ful uuid; v_ful_no text; v_res record; v_cost numeric; v_open int; v_to text; v_lines jsonb := '[]'::jsonb;
begin
  perform authz.require('sales.order.fulfil');
  if coalesce(trim(p_idempotency_key), '') = '' then
    raise exception 'VALIDATION: idempotency key is required' using errcode = 'P0001';
  end if;

  select * into v_existing from sales.fulfillments where idempotency_key = p_idempotency_key;
  if found then
    if v_existing.order_id <> p_order_id then
      raise exception 'IDEMPOTENCY_CONFLICT: key was used for another order' using errcode = 'P0001';
    end if;
    return jsonb_build_object('fulfillment_id', v_existing.id, 'fulfillment_no', v_existing.fulfillment_no,
                              'order_status', (select status from sales.orders where id = p_order_id),
                              'replayed', true);
  end if;

  select * into v_order from sales.orders where id = p_order_id for update;
  if not found then raise exception 'NOT_FOUND: order %', p_order_id using errcode = 'P0002'; end if;
  if v_order.status not in ('reserved','partially_fulfilled') then
    raise exception 'INVALID_STATE: order is %', v_order.status using errcode = 'P0001';
  end if;
  if sales.has_pending_cancel(p_order_id) then
    raise exception 'CANCEL_PENDING: a cancellation request is pending' using errcode = 'P0001';
  end if;

  select count(distinct r.warehouse_id), min(r.warehouse_id::text)::uuid into v_n_wh, v_wh
  from inventory.reservations r join sales.order_items oi on oi.id = r.order_item_id
  where oi.order_id = p_order_id and r.status = 'active';
  if v_n_wh = 0 then raise exception 'NOTHING_TO_FULFIL: no active reservations' using errcode = 'P0001'; end if;
  if v_n_wh > 1 then raise exception 'MULTI_WAREHOUSE: reservations span warehouses' using errcode = 'P0001'; end if;
  if not (authz.has_global('sales.order.fulfil') or v_wh = any(authz.warehouse_ids('sales.order.fulfil'))) then
    raise exception 'PERMISSION_DENIED: warehouse not in your scope' using errcode = '42501';
  end if;

  v_ful_no := core.next_document_no('FUL');
  insert into sales.fulfillments (fulfillment_no, order_id, warehouse_id, status, posted_by, idempotency_key)
  values (v_ful_no, p_order_id, v_wh, 'posted', auth.uid(), p_idempotency_key)
  returning id into v_ful;

  for v_res in
    select r.* from inventory.reservations r join sales.order_items oi on oi.id = r.order_item_id
    where oi.order_id = p_order_id and r.status = 'active'
    order by r.variant_id, r.lot_id
    for update of r
  loop
    perform 1 from inventory.stock_balances
    where warehouse_id = v_res.warehouse_id and variant_id = v_res.variant_id and lot_id = v_res.lot_id for update;
    -- reserved first, then the movement lowers on_hand: reserved <= on_hand holds throughout.
    update inventory.stock_balances set reserved = reserved - v_res.quantity, updated_at = now()
    where warehouse_id = v_res.warehouse_id and variant_id = v_res.variant_id and lot_id = v_res.lot_id;
    select pc.unit_cost into v_cost from catalog.product_costs pc
    where pc.variant_id = v_res.variant_id and pc.effective_from <= current_date
    order by pc.effective_from desc limit 1;
    insert into inventory.movements (movement_type, warehouse_id, variant_id, lot_id, quantity, unit_cost,
                                     source_doc_type, source_doc_id, created_by)
    values ('sale_issue', v_res.warehouse_id, v_res.variant_id, v_res.lot_id, -v_res.quantity, v_cost,
            'fulfillment', v_ful, auth.uid());
    update inventory.reservations set status = 'consumed', closed_at = now() where id = v_res.id;
    insert into sales.fulfillment_items (fulfillment_id, order_item_id, lot_id, quantity)
    values (v_ful, v_res.order_item_id, v_res.lot_id, v_res.quantity);
    update sales.order_items set fulfilled_qty = fulfilled_qty + v_res.quantity where id = v_res.order_item_id;
    v_lines := v_lines || jsonb_build_object('order_item_id', v_res.order_item_id, 'lot_id', v_res.lot_id,
                                             'quantity', v_res.quantity);
  end loop;

  select count(*) into v_open from sales.order_items where order_id = p_order_id and fulfilled_qty < quantity;
  v_to := case when v_open = 0 then 'fulfilled' else 'partially_fulfilled' end;
  if v_to <> v_order.status then
    perform sales.change_order_status(p_order_id, v_order.status, v_to, v_ful_no,
                                      jsonb_build_object('fulfillment_id', v_ful, 'fulfillment_no', v_ful_no));
  end if;
  return jsonb_build_object('fulfillment_id', v_ful, 'fulfillment_no', v_ful_no, 'order_status', v_to,
                            'lines', v_lines, 'replayed', false);
end $$;

-- Cancel: draft/submitted directly; approved/reserved via the 'sales.order.cancel' workflow;
-- fulfilled and later go through returns.
create or replace function api.cancel_order(p_order_id uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_order sales.orders%rowtype; v_own boolean; v_req uuid;
begin
  if coalesce(trim(p_reason), '') = '' then raise exception 'REASON_REQUIRED' using errcode = 'P0001'; end if;
  if not authz.is_active_user() then raise exception 'PERMISSION_DENIED: inactive user' using errcode = '42501'; end if;
  select * into v_order from sales.orders where id = p_order_id for update;
  if not found then raise exception 'NOT_FOUND: order %', p_order_id using errcode = 'P0002'; end if;
  v_own := (v_order.employee_id = authz.current_employee_id() or v_order.created_by = auth.uid())
           and authz.has_permission('sales.order.create');

  if v_order.status = 'draft' then
    if not (v_own or (authz.has_permission('sales.order.cancel')
                      and sales.order_in_scope(v_order.employee_id, v_order.territory_id, 'sales.order.cancel'))) then
      raise exception 'PERMISSION_DENIED: sales.order.cancel' using errcode = '42501';
    end if;
    perform sales.change_order_status(p_order_id, 'draft', 'cancelled', trim(p_reason));
    return jsonb_build_object('order_id', p_order_id, 'status', 'cancelled');
  elsif v_order.status = 'submitted' then
    perform authz.require('sales.order.cancel');
    if not sales.order_in_scope(v_order.employee_id, v_order.territory_id, 'sales.order.cancel') then
      raise exception 'PERMISSION_DENIED: order is outside your scope' using errcode = '42501';
    end if;
    perform sales.change_order_status(p_order_id, 'submitted', 'cancelled', trim(p_reason));
    perform sales.notify_order_rep(p_order_id, 'order.cancelled', 'Order cancelled', trim(p_reason));
    return jsonb_build_object('order_id', p_order_id, 'status', 'cancelled');
  elsif v_order.status in ('approved','reserved') then
    if not (v_own or (authz.has_permission('sales.order.cancel')
                      and sales.order_in_scope(v_order.employee_id, v_order.territory_id, 'sales.order.cancel'))) then
      raise exception 'PERMISSION_DENIED: sales.order.cancel' using errcode = '42501';
    end if;
    v_req := wf.create_request('sales.order.cancel', 'sales.order', p_order_id,
               jsonb_build_object('order_id', p_order_id, 'order_no', v_order.order_no, 'reason', trim(p_reason),
                                  'from_status', v_order.status, 'total', v_order.total,
                                  'employee_id', v_order.employee_id, 'territory_id', v_order.territory_id,
                                  'customer_id', v_order.customer_id),
               v_order.employee_id);
    return jsonb_build_object('order_id', p_order_id,
                              'status', (select status from sales.orders where id = p_order_id),
                              'approval_request_id', v_req);
  else
    raise exception 'INVALID_STATE: order is % (use a return for delivered goods)', v_order.status using errcode = 'P0001';
  end if;
end $$;

-- Hook: cancellation decided. Approved → release reservations, cancel.
create or replace function wf.on_decided_sales_order_cancel(p_request_id uuid, p_approved boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare r wf.approval_requests%rowtype; v_status text; v_released int;
begin
  if not p_approved then return; end if;
  select * into r from wf.approval_requests where id = p_request_id;
  select status into v_status from sales.orders where id = r.entity_id for update;
  if not found then raise exception 'NOT_FOUND: order %', r.entity_id using errcode = 'P0002'; end if;
  if v_status not in ('approved','reserved') then
    raise exception 'INVALID_STATE: order is %', v_status using errcode = 'P0001';
  end if;
  v_released := inventory.release_order_reservations(r.entity_id);
  perform sales.change_order_status(r.entity_id, v_status, 'cancelled', r.payload ->> 'reason',
                                    jsonb_build_object('approval_request_id', p_request_id,
                                                       'reservations_released', v_released));
  perform sales.notify_order_rep(r.entity_id, 'order.cancelled', 'Order cancelled', r.payload ->> 'reason');
end $$;

-- ---------------------------------------------------------------------------
-- 4. INVENTORY OPERATIONS
-- ---------------------------------------------------------------------------
create or replace function inventory.in_warehouse_scope(p_perm text, p_warehouse_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select authz.has_global(p_perm) or p_warehouse_id = any(authz.warehouse_ids(p_perm))
$$;

-- Goods receipt (draft). unit_cost is a PURCHASE cost from the supplier document, entered by
-- inventory staff; when omitted the current catalogue cost is used.
create or replace function api.create_goods_receipt(p_warehouse_id uuid, p_supplier text, p_shipment_ref text,
                                                    p_items jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid; v_no text; v_rec record; v_variant uuid; v_qty numeric; v_cost numeric; v_exp date; v_lot text;
begin
  perform authz.require('inventory.receipt.post');
  if not inventory.in_warehouse_scope('inventory.receipt.post', p_warehouse_id) then
    raise exception 'PERMISSION_DENIED: warehouse not in your scope' using errcode = '42501';
  end if;
  if not exists (select 1 from inventory.warehouses where id = p_warehouse_id and is_active) then
    raise exception 'NOT_FOUND: warehouse' using errcode = 'P0002';
  end if;
  if coalesce(trim(p_supplier), '') = '' then raise exception 'VALIDATION: supplier is required' using errcode = 'P0001'; end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'VALIDATION: items must be a non-empty JSON array' using errcode = 'P0001';
  end if;

  v_no := core.next_document_no('GRN');
  insert into inventory.goods_receipts (receipt_no, warehouse_id, supplier, shipment_ref, created_by)
  values (v_no, p_warehouse_id, trim(p_supplier), nullif(trim(p_shipment_ref), ''), auth.uid())
  returning id into v_id;

  for v_rec in select e.item, e.n from jsonb_array_elements(p_items) with ordinality as e(item, n) loop
    if jsonb_typeof(v_rec.item) <> 'object' or exists (
         select 1 from jsonb_object_keys(v_rec.item) k
         where k not in ('variant_id','lot_no','expiry_date','quantity','unit_cost')) then
      raise exception 'VALIDATION: item % may only contain variant_id, lot_no, expiry_date, quantity, unit_cost', v_rec.n
        using errcode = 'P0001';
    end if;
    v_variant := core.try_cast_uuid(v_rec.item ->> 'variant_id');
    if v_variant is null or not exists (select 1 from catalog.product_variants where id = v_variant) then
      raise exception 'VALIDATION: item % has no valid variant_id', v_rec.n using errcode = 'P0001';
    end if;
    v_lot := nullif(trim(v_rec.item ->> 'lot_no'), '');
    if v_lot is null then raise exception 'VALIDATION: item % lot_no is required (NO-LOT for untracked)', v_rec.n using errcode = 'P0001'; end if;
    if jsonb_typeof(v_rec.item -> 'quantity') is distinct from 'number' then
      raise exception 'VALIDATION: item % quantity must be a number', v_rec.n using errcode = 'P0001';
    end if;
    v_qty := (v_rec.item ->> 'quantity')::numeric;
    if v_qty <> trunc(v_qty) or v_qty <= 0 or v_qty > 1000000 then
      raise exception 'VALIDATION: item % quantity must be a positive whole number', v_rec.n using errcode = 'P0001';
    end if;
    v_exp := null;
    if coalesce(jsonb_typeof(v_rec.item -> 'expiry_date'), 'null') <> 'null' then
      begin
        if (v_rec.item ->> 'expiry_date') !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'bad'; end if;
        v_exp := (v_rec.item ->> 'expiry_date')::date;
      exception when others then
        raise exception 'VALIDATION: item % expiry_date must be YYYY-MM-DD', v_rec.n using errcode = 'P0001';
      end;
    end if;
    if v_exp is null and exists (select 1 from catalog.product_variants pv join catalog.products p on p.id = pv.product_id
                                 where pv.id = v_variant and p.is_expiry_tracked) then
      raise exception 'VALIDATION: item % expiry_date is required for this product', v_rec.n using errcode = 'P0001';
    end if;
    if coalesce(jsonb_typeof(v_rec.item -> 'unit_cost'), 'null') = 'null' then
      select pc.unit_cost into v_cost from catalog.product_costs pc
      where pc.variant_id = v_variant and pc.effective_from <= current_date order by pc.effective_from desc limit 1;
      if v_cost is null then raise exception 'VALIDATION: item % unit_cost is required (no catalogue cost)', v_rec.n using errcode = 'P0001'; end if;
    elsif jsonb_typeof(v_rec.item -> 'unit_cost') <> 'number' or (v_rec.item ->> 'unit_cost')::numeric < 0 then
      raise exception 'VALIDATION: item % unit_cost must be a non-negative number', v_rec.n using errcode = 'P0001';
    else
      v_cost := round((v_rec.item ->> 'unit_cost')::numeric, 2);
    end if;
    insert into inventory.goods_receipt_items (receipt_id, variant_id, lot_no, expiry_date, quantity, unit_cost)
    values (v_id, v_variant, v_lot, v_exp, v_qty::int, v_cost);
  end loop;

  return jsonb_build_object('receipt_id', v_id, 'receipt_no', v_no, 'status', 'draft');
end $$;

-- Post a receipt: lots found or created, one 'receipt' movement per item. Posts once.
create or replace function api.post_goods_receipt(p_receipt_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_rcpt inventory.goods_receipts%rowtype; v_item record; v_lot inventory.lots%rowtype; v_kind text;
  v_mov uuid; v_out jsonb := '[]'::jsonb;
begin
  perform authz.require('inventory.receipt.post');
  select * into v_rcpt from inventory.goods_receipts where id = p_receipt_id for update;
  if not found then raise exception 'NOT_FOUND: goods receipt' using errcode = 'P0002'; end if;
  if not inventory.in_warehouse_scope('inventory.receipt.post', v_rcpt.warehouse_id) then
    raise exception 'PERMISSION_DENIED: warehouse not in your scope' using errcode = '42501';
  end if;
  if v_rcpt.status <> 'draft' then
    raise exception 'INVALID_STATE: receipt is %', v_rcpt.status using errcode = 'P0001';
  end if;
  select kind into v_kind from inventory.warehouses where id = v_rcpt.warehouse_id;

  for v_item in select * from inventory.goods_receipt_items where receipt_id = p_receipt_id order by id loop
    if v_item.expiry_date is not null and v_item.expiry_date < current_date and v_kind <> 'quarantine' then
      raise exception 'EXPIRED_LOT: lot % expired on %; receive it into quarantine', v_item.lot_no, v_item.expiry_date
        using errcode = 'P0001';
    end if;
    insert into inventory.lots (variant_id, lot_no, expiry_date)
    values (v_item.variant_id, v_item.lot_no, v_item.expiry_date)
    on conflict (variant_id, lot_no) do nothing;
    select * into v_lot from inventory.lots where variant_id = v_item.variant_id and lot_no = v_item.lot_no for update;
    if v_item.expiry_date is not null and v_lot.expiry_date is not null and v_lot.expiry_date <> v_item.expiry_date then
      raise exception 'LOT_EXPIRY_MISMATCH: lot % is recorded with expiry %', v_item.lot_no, v_lot.expiry_date
        using errcode = 'P0001';
    end if;
    if v_lot.expiry_date is null and v_item.expiry_date is not null then
      update inventory.lots set expiry_date = v_item.expiry_date where id = v_lot.id;
    end if;
    insert into inventory.movements (movement_type, warehouse_id, variant_id, lot_id, quantity, unit_cost,
                                     source_doc_type, source_doc_id, idempotency_key, created_by)
    values ('receipt', v_rcpt.warehouse_id, v_item.variant_id, v_lot.id, v_item.quantity, v_item.unit_cost,
            'receipt', p_receipt_id, 'receipt:' || v_item.id, auth.uid())
    returning id into v_mov;
    v_out := v_out || jsonb_build_object('movement_id', v_mov, 'lot_id', v_lot.id, 'lot_no', v_lot.lot_no,
                                         'quantity', v_item.quantity);
  end loop;

  update inventory.goods_receipts set status = 'posted', posted_by = auth.uid(), posted_at = now()
  where id = p_receipt_id;
  insert into integration.outbox (event_type, aggregate_type, aggregate_id, payload)
  values ('inventory.receipt_posted', 'inventory.goods_receipt', p_receipt_id,
          jsonb_build_object('receipt_id', p_receipt_id, 'receipt_no', v_rcpt.receipt_no,
                             'warehouse_id', v_rcpt.warehouse_id, 'lines', jsonb_array_length(v_out)));
  return jsonb_build_object('receipt_id', p_receipt_id, 'status', 'posted', 'movements', v_out);
end $$;

-- Transfers: draft → in_transit (transfer_out at source) → received (transfer_in at destination).
create or replace function api.create_transfer(p_from uuid, p_to uuid, p_items jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_no text; v_rec record; v_variant uuid; v_lot uuid; v_qty numeric;
begin
  perform authz.require('inventory.transfer.create');
  if not inventory.in_warehouse_scope('inventory.transfer.create', p_from) then
    raise exception 'PERMISSION_DENIED: source warehouse not in your scope' using errcode = '42501';
  end if;
  if p_from is not distinct from p_to then raise exception 'VALIDATION: source and destination must differ' using errcode = 'P0001'; end if;
  if (select count(*) from inventory.warehouses where id in (p_from, p_to) and is_active) <> 2 then
    raise exception 'NOT_FOUND: warehouse' using errcode = 'P0002';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'VALIDATION: items must be a non-empty JSON array' using errcode = 'P0001';
  end if;
  v_no := core.next_document_no('TRF');
  insert into inventory.transfers (transfer_no, from_warehouse_id, to_warehouse_id, status, requested_by)
  values (v_no, p_from, p_to, 'draft', auth.uid()) returning id into v_id;
  for v_rec in select e.item, e.n from jsonb_array_elements(p_items) with ordinality as e(item, n) loop
    if jsonb_typeof(v_rec.item) <> 'object' or exists (
         select 1 from jsonb_object_keys(v_rec.item) k where k not in ('variant_id','lot_id','quantity')) then
      raise exception 'VALIDATION: item % may only contain variant_id, lot_id, quantity', v_rec.n using errcode = 'P0001';
    end if;
    v_variant := core.try_cast_uuid(v_rec.item ->> 'variant_id');
    v_lot := core.try_cast_uuid(v_rec.item ->> 'lot_id');
    if v_variant is null or v_lot is null
       or not exists (select 1 from inventory.lots where id = v_lot and variant_id = v_variant) then
      raise exception 'VALIDATION: item % lot does not belong to the variant', v_rec.n using errcode = 'P0001';
    end if;
    if jsonb_typeof(v_rec.item -> 'quantity') is distinct from 'number' then
      raise exception 'VALIDATION: item % quantity must be a number', v_rec.n using errcode = 'P0001';
    end if;
    v_qty := (v_rec.item ->> 'quantity')::numeric;
    if v_qty <> trunc(v_qty) or v_qty <= 0 or v_qty > 1000000 then
      raise exception 'VALIDATION: item % quantity must be a positive whole number', v_rec.n using errcode = 'P0001';
    end if;
    insert into inventory.transfer_items (transfer_id, variant_id, lot_id, quantity)
    values (v_id, v_variant, v_lot, v_qty::int);
  end loop;
  return jsonb_build_object('transfer_id', v_id, 'transfer_no', v_no, 'status', 'draft');
end $$;

create or replace function api.ship_transfer(p_transfer_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_t inventory.transfers%rowtype; v_item record; v_bal record;
begin
  perform authz.require('inventory.transfer.create');
  select * into v_t from inventory.transfers where id = p_transfer_id for update;
  if not found then raise exception 'NOT_FOUND: transfer' using errcode = 'P0002'; end if;
  if not inventory.in_warehouse_scope('inventory.transfer.create', v_t.from_warehouse_id) then
    raise exception 'PERMISSION_DENIED: source warehouse not in your scope' using errcode = '42501';
  end if;
  if v_t.status not in ('draft','approved') then
    raise exception 'INVALID_STATE: transfer is %', v_t.status using errcode = 'P0001';
  end if;
  for v_item in select * from inventory.transfer_items where transfer_id = p_transfer_id order by variant_id, lot_id loop
    select on_hand, reserved into v_bal from inventory.stock_balances
    where warehouse_id = v_t.from_warehouse_id and variant_id = v_item.variant_id and lot_id = v_item.lot_id for update;
    if coalesce(v_bal.on_hand, 0) - coalesce(v_bal.reserved, 0) < v_item.quantity then
      raise exception 'INSUFFICIENT_STOCK: lot % has % available, transfer needs %', v_item.lot_id,
        coalesce(v_bal.on_hand, 0) - coalesce(v_bal.reserved, 0), v_item.quantity using errcode = 'P0001';
    end if;
    insert into inventory.movements (movement_type, warehouse_id, variant_id, lot_id, quantity,
                                     source_doc_type, source_doc_id, idempotency_key, created_by)
    values ('transfer_out', v_t.from_warehouse_id, v_item.variant_id, v_item.lot_id, -v_item.quantity,
            'transfer', p_transfer_id, 'transfer_out:' || v_item.id, auth.uid());
  end loop;
  update inventory.transfers set status = 'in_transit', shipped_at = now(), shipped_by = auth.uid() where id = p_transfer_id;
  insert into integration.outbox (event_type, aggregate_type, aggregate_id, payload)
  values ('inventory.transfer_shipped', 'inventory.transfer', p_transfer_id,
          jsonb_build_object('transfer_id', p_transfer_id, 'transfer_no', v_t.transfer_no,
                             'from_warehouse_id', v_t.from_warehouse_id, 'to_warehouse_id', v_t.to_warehouse_id));
  return jsonb_build_object('transfer_id', p_transfer_id, 'status', 'in_transit');
end $$;

create or replace function api.receive_transfer(p_transfer_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_t inventory.transfers%rowtype; v_item record;
begin
  perform authz.require('inventory.transfer.receive');
  select * into v_t from inventory.transfers where id = p_transfer_id for update;
  if not found then raise exception 'NOT_FOUND: transfer' using errcode = 'P0002'; end if;
  if not inventory.in_warehouse_scope('inventory.transfer.receive', v_t.to_warehouse_id) then
    raise exception 'PERMISSION_DENIED: destination warehouse not in your scope' using errcode = '42501';
  end if;
  if v_t.status <> 'in_transit' then
    raise exception 'INVALID_STATE: transfer is %', v_t.status using errcode = 'P0001';
  end if;
  for v_item in select * from inventory.transfer_items where transfer_id = p_transfer_id order by variant_id, lot_id loop
    insert into inventory.movements (movement_type, warehouse_id, variant_id, lot_id, quantity,
                                     source_doc_type, source_doc_id, idempotency_key, created_by)
    values ('transfer_in', v_t.to_warehouse_id, v_item.variant_id, v_item.lot_id, v_item.quantity,
            'transfer', p_transfer_id, 'transfer_in:' || v_item.id, auth.uid());
    update inventory.transfer_items set received_qty = quantity where id = v_item.id;
  end loop;
  update inventory.transfers set status = 'received', received_at = now(), received_by = auth.uid() where id = p_transfer_id;
  insert into integration.outbox (event_type, aggregate_type, aggregate_id, payload)
  values ('inventory.transfer_received', 'inventory.transfer', p_transfer_id,
          jsonb_build_object('transfer_id', p_transfer_id, 'transfer_no', v_t.transfer_no,
                             'from_warehouse_id', v_t.from_warehouse_id, 'to_warehouse_id', v_t.to_warehouse_id));
  return jsonb_build_object('transfer_id', p_transfer_id, 'status', 'received');
end $$;

-- Adjustment with approval: within the caller's inventory.adjustment.post limit it posts directly
-- (api.post_inventory_adjustment); above it, an 'inventory.adjustment' request is raised and the
-- hook posts the movement on approval. The idempotency key identifies the adjustment across both
-- paths (entity id = md5 of the key).
create or replace function api.request_inventory_adjustment(p_warehouse_id uuid, p_variant_id uuid, p_lot_id uuid,
                                                            p_quantity int, p_reason text, p_idempotency_key text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_limit numeric; v_mov uuid; v_entity uuid; v_req wf.approval_requests%rowtype; v_bal record;
begin
  perform authz.require('inventory.adjustment.post');
  if not inventory.in_warehouse_scope('inventory.adjustment.post', p_warehouse_id) then
    raise exception 'PERMISSION_DENIED: warehouse not in your scope' using errcode = '42501';
  end if;
  if coalesce(trim(p_idempotency_key), '') = '' then
    raise exception 'VALIDATION: idempotency key is required' using errcode = 'P0001';
  end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'REASON_REQUIRED' using errcode = 'P0001'; end if;
  if p_quantity is null or p_quantity = 0 then raise exception 'VALIDATION: quantity must be non-zero' using errcode = 'P0001'; end if;
  if not exists (select 1 from inventory.lots where id = p_lot_id and variant_id = p_variant_id) then
    raise exception 'VALIDATION: lot does not belong to the variant' using errcode = 'P0001';
  end if;
  if not exists (select 1 from inventory.warehouses where id = p_warehouse_id) then
    raise exception 'NOT_FOUND: warehouse' using errcode = 'P0002';
  end if;

  -- Replays: already posted, or already requested.
  select id into v_mov from inventory.movements where idempotency_key = p_idempotency_key;
  if v_mov is not null then
    return jsonb_build_object('status', 'posted', 'movement_id', v_mov, 'replayed', true,
             'approval_request_id', (select approval_request_id from inventory.movements where id = v_mov));
  end if;
  v_entity := md5('inventory.adjustment:' || p_idempotency_key)::uuid;
  select r.* into v_req from wf.approval_requests r join wf.workflow_definitions d on d.id = r.definition_id
  where d.code = 'inventory.adjustment' and r.entity_id = v_entity
  order by r.created_at desc limit 1;
  if found then
    return jsonb_build_object('status', case when v_req.status = 'pending' then 'pending_approval' else v_req.status end,
                              'approval_request_id', v_req.id, 'movement_id', null, 'replayed', true);
  end if;

  if p_quantity < 0 then
    select on_hand, reserved into v_bal from inventory.stock_balances
    where warehouse_id = p_warehouse_id and variant_id = p_variant_id and lot_id = p_lot_id for update;
    if coalesce(v_bal.on_hand, 0) + p_quantity < coalesce(v_bal.reserved, 0)
       and not (select allow_negative from inventory.warehouses where id = p_warehouse_id) then
      raise exception 'INSUFFICIENT_STOCK: % available, adjustment removes %',
        coalesce(v_bal.on_hand, 0) - coalesce(v_bal.reserved, 0), -p_quantity using errcode = 'P0001';
    end if;
  end if;

  v_limit := authz.max_limit('inventory.adjustment.post');
  if v_limit is null or abs(p_quantity) <= v_limit then
    v_mov := api.post_inventory_adjustment(p_warehouse_id, p_variant_id, p_lot_id, p_quantity, p_reason, p_idempotency_key);
    insert into integration.outbox (event_type, aggregate_type, aggregate_id, payload)
    values ('inventory.adjusted', 'inventory.movement', v_mov,
            jsonb_build_object('movement_id', v_mov, 'warehouse_id', p_warehouse_id, 'variant_id', p_variant_id,
                               'lot_id', p_lot_id, 'quantity', p_quantity, 'reason', p_reason));
    return jsonb_build_object('status', 'posted', 'movement_id', v_mov, 'approval_request_id', null, 'replayed', false);
  end if;

  v_req.id := wf.create_request('inventory.adjustment', 'inventory.adjustment', v_entity,
    jsonb_build_object('warehouse_id', p_warehouse_id, 'variant_id', p_variant_id, 'lot_id', p_lot_id,
                       'quantity', p_quantity, 'reason', trim(p_reason), 'idempotency_key', p_idempotency_key,
                       'requester_limit', v_limit, 'limit_metric', abs(p_quantity),
                       'limit_metrics', jsonb_build_object('wf.decide.inventory_adjustment', abs(p_quantity))));
  return jsonb_build_object('status', (select case when status = 'pending' then 'pending_approval' else status end
                                       from wf.approval_requests where id = v_req.id),
                            'approval_request_id', v_req.id,
                            'movement_id', (select id from inventory.movements where idempotency_key = p_idempotency_key),
                            'replayed', false);
end $$;

-- Hook: adjustment decided. Approved → post the movement, linked to the request.
create or replace function wf.on_decided_inventory_adjustment(p_request_id uuid, p_approved boolean)
returns void language plpgsql security definer set search_path = '' as $$
declare r wf.approval_requests%rowtype; v_q int; v_wh uuid; v_var uuid; v_lot uuid; v_key text; v_bal record; v_mov uuid;
begin
  if not p_approved then return; end if;
  select * into r from wf.approval_requests where id = p_request_id;
  v_q := (r.payload ->> 'quantity')::int;
  v_wh := (r.payload ->> 'warehouse_id')::uuid;
  v_var := (r.payload ->> 'variant_id')::uuid;
  v_lot := (r.payload ->> 'lot_id')::uuid;
  v_key := r.payload ->> 'idempotency_key';
  if exists (select 1 from inventory.movements where idempotency_key = v_key) then return; end if;
  select on_hand, reserved into v_bal from inventory.stock_balances
  where warehouse_id = v_wh and variant_id = v_var and lot_id = v_lot for update;
  if v_q < 0 and coalesce(v_bal.on_hand, 0) + v_q < coalesce(v_bal.reserved, 0)
     and not (select allow_negative from inventory.warehouses where id = v_wh) then
    raise exception 'INSUFFICIENT_STOCK: % available, adjustment removes %',
      coalesce(v_bal.on_hand, 0) - coalesce(v_bal.reserved, 0), -v_q using errcode = 'P0001';
  end if;
  insert into inventory.movements (movement_type, warehouse_id, variant_id, lot_id, quantity, reason_code,
                                   source_doc_type, source_doc_id, approval_request_id, idempotency_key, created_by)
  values (case when v_q > 0 then 'adjustment_in' else 'adjustment_out' end, v_wh, v_var, v_lot, v_q,
          r.payload ->> 'reason', 'adjustment', r.entity_id, p_request_id, v_key, r.requested_by)
  returning id into v_mov;
  insert into integration.outbox (event_type, aggregate_type, aggregate_id, payload)
  values ('inventory.adjusted', 'inventory.movement', v_mov,
          jsonb_build_object('movement_id', v_mov, 'warehouse_id', v_wh, 'variant_id', v_var, 'lot_id', v_lot,
                             'quantity', v_q, 'reason', r.payload ->> 'reason', 'approval_request_id', p_request_id));
end $$;

-- ---------------------------------------------------------------------------
-- 5. Reference data: credit-limit routing for order approvals (D-09)
--   priority 40: credit AND discount exceeded → finance (wf.decide.credit_limit), then discount approver
--   priority 50: credit exceeded              → finance (wf.decide.credit_limit)
--   priority 100 (seeded catch-all)           → discount approver (wf.decide.order_discount)
-- ---------------------------------------------------------------------------
with d as (select id from wf.workflow_definitions where code = 'sales.order.discount'),
rules as (
  insert into wf.workflow_rules (definition_id, priority, condition)
  select d.id, v.priority, v.cond::jsonb from d,
  (values (40, '{"all":[{"field":"credit_exceeded","op":"=","value":true},{"field":"discount_exceeded","op":"=","value":true}]}'),
          (50, '{"all":[{"field":"credit_exceeded","op":"=","value":true}]}')) as v(priority, cond)
  on conflict (definition_id, priority) do nothing
  returning id, priority
)
insert into wf.workflow_stages (rule_id, stage_no, approver_type, approver_permission)
select rules.id, s.stage_no, 'permission', s.perm
from rules join (values (40, 1, 'wf.decide.credit_limit'), (40, 2, 'wf.decide.order_discount'),
                        (50, 1, 'wf.decide.credit_limit')) as s(priority, stage_no, perm)
  on s.priority = rules.priority;

-- ---------------------------------------------------------------------------
-- 6. RLS policies for tables that had none (deny-by-default stays for everything else)
-- ---------------------------------------------------------------------------
create policy order_history_select on sales.order_status_history for select to authenticated using (
  exists (select 1 from sales.orders o where o.id = order_status_history.order_id));
create policy order_transitions_select on sales.order_transitions for select to authenticated using (
  (select authz.is_active_user()));
create policy fulfillments_select on sales.fulfillments for select to authenticated using (
  exists (select 1 from sales.orders o where o.id = fulfillments.order_id)
  or (select authz.has_global('sales.order.fulfil'))
  or warehouse_id = any((select authz.warehouse_ids('sales.order.fulfil'))::uuid[]));
create policy fulfillment_items_select on sales.fulfillment_items for select to authenticated using (
  exists (select 1 from sales.fulfillments f where f.id = fulfillment_items.fulfillment_id));
create policy returns_select on sales.returns for select to authenticated using (
  exists (select 1 from sales.orders o where o.id = returns.order_id));
create policy return_items_select on sales.return_items for select to authenticated using (
  exists (select 1 from sales.returns r where r.id = return_items.return_id));

create policy reservations_select on inventory.reservations for select to authenticated using (
  exists (select 1 from sales.order_items oi where oi.id = reservations.order_item_id)
  or (select authz.has_global('inventory.movement.read'))
  or warehouse_id = any((select authz.warehouse_ids('inventory.movement.read'))::uuid[]));
create policy transfers_select on inventory.transfers for select to authenticated using (
  (select authz.has_global('inventory.transfer.create'))
  or (select authz.has_global('inventory.transfer.receive'))
  or (select authz.has_global('inventory.movement.read'))
  or from_warehouse_id = any((select authz.warehouse_ids('inventory.transfer.create'))::uuid[])
  or to_warehouse_id = any((select authz.warehouse_ids('inventory.transfer.receive'))::uuid[]));
create policy transfer_items_select on inventory.transfer_items for select to authenticated using (
  exists (select 1 from inventory.transfers t where t.id = transfer_items.transfer_id));
create policy goods_receipts_select on inventory.goods_receipts for select to authenticated using (
  (select authz.has_global('inventory.receipt.post'))
  or (select authz.has_global('inventory.movement.read'))
  or warehouse_id = any((select authz.warehouse_ids('inventory.receipt.post'))::uuid[]));
create policy goods_receipt_items_select on inventory.goods_receipt_items for select to authenticated using (
  exists (select 1 from inventory.goods_receipts g where g.id = goods_receipt_items.receipt_id));

create policy workflow_definitions_select on wf.workflow_definitions for select to authenticated using (
  (select authz.is_active_user()));
create policy workflow_rules_select on wf.workflow_rules for select to authenticated using (
  (select authz.has_permission('admin.workflow.manage')) or (select authz.has_permission('wf.approval.read')));
create policy workflow_stages_select on wf.workflow_stages for select to authenticated using (
  (select authz.has_permission('admin.workflow.manage')) or (select authz.has_permission('wf.approval.read')));
-- Requester and the employee the request is about see it; readers by wf.approval.read scope
-- (subject employee / territory / warehouse); anyone who can decide the pending request now
-- (incl. delegates, 'user' and manager stages).
create policy approval_requests_select on wf.approval_requests for select to authenticated using (
  requested_by = (select auth.uid())
  or subject_employee_id = (select authz.current_employee_id())
  or (select authz.has_global('wf.approval.read'))
  or subject_employee_id = any((select authz.employee_ids('wf.approval.read'))::uuid[])
  or (payload ->> 'territory_id') = any((select authz.territory_ids('wf.approval.read'))::text[])
  or (payload ->> 'warehouse_id') = any((select authz.warehouse_ids('wf.approval.read'))::text[])
  or (status = 'pending' and wf.can_decide(id)));
create policy approval_steps_select on wf.approval_steps for select to authenticated using (
  exists (select 1 from wf.approval_requests r where r.id = approval_steps.request_id));
create policy delegations_select on wf.delegations for select to authenticated using (
  from_user_id = (select auth.uid()) or to_user_id = (select auth.uid())
  or (select authz.has_permission('admin.workflow.manage')));

-- ---------------------------------------------------------------------------
-- 7. Read views (security_invoker → the caller's RLS applies)
-- ---------------------------------------------------------------------------
create or replace view api.v_approvals_inbox with (security_invoker = true) as
  select r.id as request_id, d.code as workflow_code, d.name as workflow_name, r.entity_type, r.entity_id,
         r.requested_by, r.subject_employee_id, r.payload, r.status, r.current_stage, r.created_at, r.decided_at,
         (r.requested_by = auth.uid()) as is_mine,
         (r.status = 'pending' and wf.can_decide(r.id)) as can_decide
  from wf.approval_requests r
  join wf.workflow_definitions d on d.id = r.definition_id
  where r.requested_by = auth.uid() or (r.status = 'pending' and wf.can_decide(r.id));

create or replace view api.v_orders with (security_invoker = true) as
  select o.id, o.order_no, o.client_ref, o.customer_id, c.display_name as customer_name,
         o.employee_id, e.full_name_en as employee_name, o.territory_id, o.visit_id, o.status, o.currency,
         o.payment_terms_days, o.subtotal, o.discount_total, o.tax_total, o.total, o.notes,
         o.submitted_at, o.approved_at, o.version, o.created_at, o.updated_at,
         (select r.id from wf.approval_requests r
          where r.entity_id = o.id and r.status = 'pending' order by r.created_at limit 1) as pending_approval_request_id
  from sales.orders o
  left join crm.customers c on c.id = o.customer_id
  left join core.employees e on e.id = o.employee_id;

create or replace view api.v_order_lines with (security_invoker = true) as
  select oi.id as order_item_id, oi.order_id, oi.line_no, oi.variant_id, v.sku, v.name_en as variant_name,
         oi.quantity, oi.list_price, oi.requested_discount_pct, oi.promo_discount_pct, oi.applied_discount_pct,
         oi.tax_rate_pct, oi.line_subtotal, oi.line_discount, oi.line_tax, oi.line_total,
         oi.fulfilled_qty, oi.returned_qty,
         coalesce((select sum(r.quantity) from inventory.reservations r
                   where r.order_item_id = oi.id and r.status = 'active'), 0)::int as reserved_qty
  from sales.order_items oi
  left join catalog.product_variants v on v.id = oi.variant_id;

-- Sellable availability only (no lots, no on-hand/reserved split, no expired lots,
-- no quarantine/transit stock). Safe for reps.
create or replace view api.v_stock_available with (security_invoker = true) as
  select b.warehouse_id, w.code as warehouse_code, w.name as warehouse_name,
         b.variant_id, v.sku, v.name_en as variant_name, p.id as product_id, p.name_en as product_name,
         sum(greatest(b.on_hand - b.reserved, 0))::int as available
  from inventory.stock_balances b
  join inventory.lots l on l.id = b.lot_id
  join inventory.warehouses w on w.id = b.warehouse_id
  join catalog.product_variants v on v.id = b.variant_id
  join catalog.products p on p.id = v.product_id
  where (l.expiry_date is null or l.expiry_date >= current_date)
    and w.kind not in ('quarantine','transit') and w.is_active
  group by b.warehouse_id, w.code, w.name, b.variant_id, v.sku, v.name_en, p.id, p.name_en;

-- Lot-level detail for inventory roles.
create or replace view api.v_stock_detail with (security_invoker = true) as
  select b.warehouse_id, w.code as warehouse_code, b.variant_id, v.sku, b.lot_id, l.lot_no, l.expiry_date,
         (l.expiry_date - current_date) as days_to_expiry,
         b.on_hand, b.reserved, (b.on_hand - b.reserved) as available, b.updated_at
  from inventory.stock_balances b
  join inventory.lots l on l.id = b.lot_id
  join inventory.warehouses w on w.id = b.warehouse_id
  join catalog.product_variants v on v.id = b.variant_id
  where (select authz.has_permission('inventory.module.access'));

create or replace view api.v_movements with (security_invoker = true) as
  select m.id, m.created_at, m.movement_type, m.warehouse_id, w.code as warehouse_code, m.variant_id, v.sku,
         m.lot_id, l.lot_no, m.quantity,
         case when (select authz.has_permission('catalog.cost.read')) then m.unit_cost end as unit_cost,
         m.reason_code, m.source_doc_type, m.source_doc_id, m.reverses_movement_id, m.approval_request_id,
         m.created_by
  from inventory.movements m
  left join inventory.warehouses w on w.id = m.warehouse_id
  left join catalog.product_variants v on v.id = m.variant_id
  left join inventory.lots l on l.id = m.lot_id;

create or replace view api.v_transfers with (security_invoker = true) as
  select t.id, t.transfer_no, t.from_warehouse_id, fw.code as from_warehouse_code,
         t.to_warehouse_id, tw.code as to_warehouse_code, t.status, t.requested_by, t.created_at,
         t.shipped_at, t.received_at,
         coalesce((select jsonb_agg(jsonb_build_object('variant_id', ti.variant_id, 'lot_id', ti.lot_id,
                                                       'quantity', ti.quantity, 'received_qty', ti.received_qty)
                                    order by ti.id)
                   from inventory.transfer_items ti where ti.transfer_id = t.id), '[]'::jsonb) as items
  from inventory.transfers t
  left join inventory.warehouses fw on fw.id = t.from_warehouse_id
  left join inventory.warehouses tw on tw.id = t.to_warehouse_id;

grant select on api.v_approvals_inbox, api.v_orders, api.v_order_lines, api.v_stock_available,
                api.v_stock_detail, api.v_movements, api.v_transfers to authenticated;

-- ---------------------------------------------------------------------------
-- 8. Privileges
-- ---------------------------------------------------------------------------
-- Internal helpers and hooks: never callable by clients (functions are PUBLIC-executable by default).
revoke execute on function
  core.try_cast_uuid(text),
  notify.send_in_app(uuid, text, text, text, text, jsonb),
  sales.order_in_scope(uuid, uuid, text),
  sales.change_order_status(uuid, text, text, text, jsonb),
  sales.notify_order_rep(uuid, text, text, text),
  sales.price_order(uuid),
  sales.assert_not_own_order(sales.orders),
  sales.has_pending_cancel(uuid),
  inventory.release_order_reservations(uuid),
  inventory.in_warehouse_scope(text, uuid),
  wf.condition_matches(jsonb, jsonb),
  wf.user_is_active(uuid),
  wf.user_grants(uuid, text),
  wf.grant_covers(uuid, text, uuid, uuid, uuid, uuid, uuid, uuid),
  wf.request_metric(jsonb, text, text),
  wf.resolve_rule(uuid, jsonb),
  wf.current_stage_id(uuid),
  wf.user_stage_check(uuid, uuid, uuid),
  wf.already_decided(uuid, int, uuid, uuid),
  wf.resolve_principal(uuid),
  wf.notify_stage_approvers(uuid),
  wf.dispatch_decision_hook(text, uuid, boolean),
  wf.create_request(text, text, uuid, jsonb, uuid),
  wf.on_decided_sales_order_discount(uuid, boolean),
  wf.on_decided_sales_order_cancel(uuid, boolean),
  wf.on_decided_inventory_adjustment(uuid, boolean)
from public, authenticated, anon;

-- wf.can_decide is evaluated by the approval_requests RLS policy and the inbox view as the caller.
-- It is read-only and answers only "can *I* decide request X now".
revoke execute on function wf.can_decide(uuid) from public, anon;
grant execute on function wf.can_decide(uuid) to authenticated;

revoke execute on all functions in schema api from public;
grant execute on all functions in schema api to authenticated;
