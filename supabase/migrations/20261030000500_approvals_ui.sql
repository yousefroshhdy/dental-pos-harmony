-- Honest OS migration: read surface for the approvals inbox and request detail UI (Phase 3, task 9/10).
--
-- Gaps closed (additive only; nothing existing is dropped, renamed or narrowed):
--   1. An approver who decided a request lost sight of it afterwards unless they also held
--      wf.approval.read in scope (e.g. a delegate). New permissive policy: whoever decided a
--      request (themselves, or on whose behalf a delegate decided) can still read it.
--      Uses a SECURITY DEFINER helper, because a policy on wf.approval_requests that read
--      wf.approval_steps directly would recurse (approval_steps_select reads approval_requests).
--   2. api.v_approvals_inbox has no names, stage detail or "why can't I decide". New views
--      api.v_approval_requests (every request the caller can see, with display context and
--      the caller's decision verdict) and api.v_approval_steps (the decision trail).
--
-- Verdict values of authz.approval_verdict (caller-scoped, mirrors api.decide_approval's order):
--   ok · own_request · about_you · limit · already_decided · not_approver · closed
--
-- The caller-evaluated helpers live in authz/core, not wf: suite 14 pins wf.can_decide as the
-- only client-executable wf function, and suite 17 requires each one to back a policy or view.

-- ---------------------------------------------------------------------------
-- 1. Helpers
-- ---------------------------------------------------------------------------

-- Requests the caller decided, personally or through a delegate acting for them.
create or replace function authz.approval_decided_ids() returns uuid[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(distinct s.request_id), '{}'::uuid[])
  from wf.approval_steps s
  where auth.uid() is not null
    and (s.approver_id = auth.uid() or s.on_behalf_of = auth.uid())
$$;

-- Why the caller can or cannot decide a request right now. Read-only and about the caller only.
create or replace function authz.approval_verdict(p_request_id uuid) returns text
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid(); r wf.approval_requests%rowtype; v_p record;
begin
  if v_uid is null or not wf.user_is_active(v_uid) then return 'not_approver'; end if;
  select * into r from wf.approval_requests where id = p_request_id;
  if not found then return null; end if;
  if r.status <> 'pending' then return 'closed'; end if;
  if r.requested_by = v_uid then return 'own_request'; end if;
  if r.subject_employee_id is not null
     and r.subject_employee_id = (select employee_id from core.user_profiles where user_id = v_uid) then
    return 'about_you';
  end if;
  select * into v_p from wf.resolve_principal(p_request_id);
  if v_p.o_verdict = 'ok' then return 'ok'; end if;
  if v_p.o_verdict = 'limit' then return 'limit'; end if;
  if wf.already_decided(r.id, r.current_stage, v_uid, v_uid) then return 'already_decided'; end if;
  return 'not_approver';
end $$;

-- Display name of an app user (colleague names are not sensitive inside the company; same
-- rule as crm.employee_display). core.user_profiles RLS would otherwise hide the requester.
create or replace function core.user_display(p_user_id uuid)
returns table (full_name_en text, full_name_ar text)
language sql stable security definer set search_path = '' as $$
  select e.full_name_en, e.full_name_ar
  from core.user_profiles p join core.employees e on e.id = p.employee_id
  where p.user_id = p_user_id and authz.is_active_user()
$$;

-- Safe uuid from a payload key (NULL if missing or malformed). Plain SQL, not a definer.
create or replace function core.jsonb_uuid(p_payload jsonb, p_key text) returns uuid
language sql immutable set search_path = '' as $$
  select case when (p_payload ->> p_key) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
              then (p_payload ->> p_key)::uuid end
$$;

-- ---------------------------------------------------------------------------
-- 2. Visibility after deciding (additive permissive policy)
-- ---------------------------------------------------------------------------
create policy approval_requests_select_decided on wf.approval_requests for select to authenticated using (
  id = any((select authz.approval_decided_ids())::uuid[]));

-- ---------------------------------------------------------------------------
-- 3. Read views (security_invoker → the caller's RLS applies to every joined table;
--    names of related records are NULL when the caller may not read them)
-- ---------------------------------------------------------------------------
create or replace view api.v_approval_requests with (security_invoker = true) as
  select r.id as request_id, d.code as workflow_code, d.name as workflow_name,
         r.entity_type, r.entity_id, r.payload, r.status, r.current_stage,
         nullif((select count(*) from wf.workflow_stages ws where ws.rule_id = r.rule_id), 0)::int as stage_count,
         st.approver_type as stage_approver_type, st.approver_permission as stage_permission,
         st.required_approvals as stage_required_approvals,
         (select count(distinct coalesce(s.on_behalf_of, s.approver_id)) from wf.approval_steps s
          where s.request_id = r.id and s.stage_no = r.current_stage and s.decision = 'approved')::int as stage_approvals,
         coalesce((select max(s.decided_at) from wf.approval_steps s
                   where s.request_id = r.id and s.stage_no < r.current_stage), r.created_at) as stage_started_at,
         r.created_at, r.decided_at,
         r.requested_by, rq.full_name_en as requester_name_en, rq.full_name_ar as requester_name_ar,
         r.subject_employee_id, sb.full_name_en as subject_name_en, sb.full_name_ar as subject_name_ar,
         (r.requested_by = (select auth.uid())) as is_mine,
         (mv.verdict = 'ok') as can_decide,
         mv.verdict as my_verdict,
         (md.decision is not null) as decided_by_me, md.decision as my_decision, md.decided_at as my_decided_at,
         c.customer_no, c.display_name as customer_name,
         fe.full_name_en as from_employee_name_en, fe.full_name_ar as from_employee_name_ar,
         te.full_name_en as to_employee_name_en, te.full_name_ar as to_employee_name_ar,
         w.code as warehouse_code, w.name as warehouse_name,
         v.sku as variant_sku, v.name_en as variant_name
  from wf.approval_requests r
  join wf.workflow_definitions d on d.id = r.definition_id
  left join wf.workflow_stages st on st.rule_id = r.rule_id and st.stage_no = r.current_stage
  left join lateral core.user_display(r.requested_by) rq on true
  left join lateral crm.employee_display(r.subject_employee_id) sb on true
  left join lateral crm.employee_display(core.jsonb_uuid(r.payload, 'from_employee_id')) fe on true
  left join lateral crm.employee_display(core.jsonb_uuid(r.payload, 'to_employee_id')) te on true
  cross join lateral (select authz.approval_verdict(r.id) as verdict) mv
  left join lateral (
    select s.decision, s.decided_at from wf.approval_steps s
    where s.request_id = r.id and (s.approver_id = (select auth.uid()) or s.on_behalf_of = (select auth.uid()))
    order by s.decided_at desc limit 1) md on true
  left join crm.customers c on c.id = core.jsonb_uuid(r.payload, 'customer_id')
  left join inventory.warehouses w on w.id = core.jsonb_uuid(r.payload, 'warehouse_id')
  left join catalog.product_variants v on v.id = core.jsonb_uuid(r.payload, 'variant_id');

create or replace view api.v_approval_steps with (security_invoker = true) as
  select s.id, s.request_id, s.stage_no, s.decision, s.comment, s.decided_at,
         s.approver_id, ap.full_name_en as approver_name_en, ap.full_name_ar as approver_name_ar,
         s.on_behalf_of, ob.full_name_en as on_behalf_of_name_en, ob.full_name_ar as on_behalf_of_name_ar
  from wf.approval_steps s
  left join lateral core.user_display(s.approver_id) ap on true
  left join lateral core.user_display(s.on_behalf_of) ob on true;

grant select on api.v_approval_requests, api.v_approval_steps to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Privileges. The helpers are evaluated as the caller by the policy and views above,
--    so `authenticated` needs EXECUTE; they answer only about the caller (or return names).
-- ---------------------------------------------------------------------------
revoke execute on function
  authz.approval_decided_ids(),
  authz.approval_verdict(uuid),
  core.user_display(uuid),
  core.jsonb_uuid(jsonb, text)
from public, anon;
grant execute on function
  authz.approval_decided_ids(),
  authz.approval_verdict(uuid),
  core.user_display(uuid),
  core.jsonb_uuid(jsonb, text)
to authenticated;
