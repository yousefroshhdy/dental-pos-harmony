-- Honest OS migration: Phase P step 3, pin on first visit.
--
-- Rule kept from 2026-10-29 (audit #6): only a holder of crm.customer_location.verify sets a
-- clinic location. A rep's fix never pins the clinic by itself.
--
-- New: when a rep checks in at a customer with no location (api.visit_check_in already allows
-- it and records verification_status = 'no_customer_location'), the check-in fix is recorded
-- as a PROPOSAL. A crm.customer_location.verify holder covering the customer approves it (the
-- proposal becomes the verified clinic location) or rejects it with a reason.
--
-- Design notes:
-- * The proposal is written by an AFTER INSERT trigger on field.location_events (check_in rows),
--   not inside api.visit_check_in, so a later redefinition of the check-in command keeps it.
-- * Not a wf.* approval: the decision right is the crm.customer_location.verify permission
--   itself (the same right that sets a location directly), and wf.dispatch_decision_hook is not
--   redefined here. Decisions are audited by the row trigger, logged on the customer timeline,
--   notified to the rep and published to the outbox.
-- * Once the customer has a location (approved proposal, or set directly with
--   api.set_customer_location), every other pending proposal for it becomes 'superseded'.
-- * The visit's own verification verdict is not changed by the decision (that stays with the
--   visit-exception workflow, wf.decide.visit_exception).
-- Non-destructive: one new table, new functions, new triggers, one new view.

-- ---------------------------------------------------------------------------
-- 1. Table
-- ---------------------------------------------------------------------------
create table crm.customer_location_proposals (
  id            uuid primary key default gen_random_uuid(),
  customer_id   uuid not null references crm.customers(id),
  visit_id      uuid not null unique references field.visits(id),   -- one proposal per visit
  proposed_by   uuid not null references core.employees(id),
  latitude      numeric(9,6) not null check (latitude between 21.5 and 32.0),   -- Egypt, as crm.customers
  longitude     numeric(9,6) not null check (longitude between 24.5 and 37.5),
  accuracy_m    numeric(8,1) check (accuracy_m >= 0),
  captured_at   timestamptz not null,                                -- device time of the fix
  anomaly_flags text[] not null default '{}',                        -- the visit's flags at check-in
  status        text not null default 'pending'
                check (status in ('pending','approved','rejected','superseded')),
  decided_by    uuid references core.employees(id),
  decided_at    timestamptz,
  decision_note text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  check ((status in ('approved','rejected')) = (decided_at is not null)),
  check (status <> 'rejected' or coalesce(btrim(decision_note), '') <> '')
);
create index idx_location_proposals_customer_status on crm.customer_location_proposals (customer_id, status);
create index idx_location_proposals_pending_created on crm.customer_location_proposals (created_at)
  where status = 'pending';
create index idx_location_proposals_proposed_by on crm.customer_location_proposals (proposed_by);
create index idx_location_proposals_decided_by on crm.customer_location_proposals (decided_by);

create trigger trg_location_proposals_updated before update on crm.customer_location_proposals
  for each row execute function core.set_updated_at();
create trigger trg_audit after insert or update or delete on crm.customer_location_proposals
  for each row execute function audit.log_change();

-- ---------------------------------------------------------------------------
-- 2. RLS: the rep sees their own proposals; verifiers see those of customers in their
--    crm.customer_location.verify scope. No direct writes (commands and triggers only).
-- ---------------------------------------------------------------------------
alter table crm.customer_location_proposals enable row level security;
grant select on crm.customer_location_proposals to authenticated;

create policy customer_location_proposals_select on crm.customer_location_proposals for select to authenticated using (
  proposed_by = (select authz.current_employee_id())
  or (select authz.has_global('crm.customer_location.verify'))
  or customer_id = any((select authz.assigned_customer_ids('crm.customer_location.verify'))::uuid[])
  or exists (select 1 from crm.customers c where c.id = customer_location_proposals.customer_id
             and c.territory_id = any((select authz.territory_ids('crm.customer_location.verify'))::uuid[]))
);

-- ---------------------------------------------------------------------------
-- 3. Proposal on check-in at an unpinned customer
-- ---------------------------------------------------------------------------
create or replace function field.propose_location_from_check_in() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_v field.visits%rowtype; v_c crm.customers%rowtype; v_id uuid;
begin
  select * into v_v from field.visits where id = new.visit_id;
  if not found or v_v.verification_status <> 'no_customer_location' then return null; end if;
  select * into v_c from crm.customers where id = v_v.customer_id;
  if not found or v_c.latitude is not null or v_c.archived_at is not null then return null; end if;
  -- Outside Egypt cannot be a clinic location (same box as crm.customers); nothing to propose.
  if new.latitude not between 21.5 and 32.0 or new.longitude not between 24.5 and 37.5 then return null; end if;

  insert into crm.customer_location_proposals (customer_id, visit_id, proposed_by, latitude, longitude,
                                               accuracy_m, captured_at, anomaly_flags)
  values (v_v.customer_id, v_v.id, new.employee_id, round(new.latitude, 6), round(new.longitude, 6),
          new.accuracy_m, new.captured_at, v_v.anomaly_flags)
  on conflict (visit_id) do nothing
  returning id into v_id;

  if v_id is not null then
    perform crm._add_activity(v_v.customer_id, new.employee_id, 'note',
      'Clinic location proposed from a visit check-in', 'crm.customer_location_proposals', v_id);
    perform crm._emit('customer.location_proposed', 'crm.customer', v_v.customer_id, jsonb_build_object(
      'proposal_id', v_id, 'customer_id', v_v.customer_id, 'visit_id', v_v.id, 'employee_id', new.employee_id,
      'accuracy_m', new.accuracy_m));
  end if;
  return null;
end $$;

create trigger trg_location_events_propose after insert on field.location_events
  for each row when (new.event_type = 'check_in' and new.latitude is not null and new.longitude is not null)
  execute function field.propose_location_from_check_in();

-- A location set by any path ends the other pending proposals for that customer.
create or replace function crm.supersede_location_proposals() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update crm.customer_location_proposals set status = 'superseded'
  where customer_id = new.id and status = 'pending';
  return null;
end $$;

create trigger trg_customers_location_supersede after update of latitude, longitude on crm.customers
  for each row when (new.latitude is not null and (old.latitude, old.longitude) is distinct from (new.latitude, new.longitude))
  execute function crm.supersede_location_proposals();

-- ---------------------------------------------------------------------------
-- 4. Decision command
-- ---------------------------------------------------------------------------
-- p_approve = true: the proposal becomes the clinic's verified location. Refused when the
-- customer already has a location (ALREADY_PINNED: set it directly instead), when the fix is
-- missing an accuracy or is worse than field.max_accuracy_m (LOCATION_INACCURATE: drop a pin
-- instead), or when the customer is archived.
-- p_approve = false: rejected; a reason is required.
-- Idempotent: repeating the same decision answers replayed = true.
create or replace function api.decide_customer_location_proposal(p_proposal_id uuid, p_approve boolean,
                                                                 p_note text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_p crm.customer_location_proposals%rowtype; v_c crm.customers%rowtype;
  v_emp uuid := authz.current_employee_id(); v_target text; v_max_acc numeric; v_note text := nullif(btrim(p_note), '');
begin
  perform authz.require('crm.customer_location.verify');
  if p_proposal_id is null or p_approve is null then
    raise exception 'VALIDATION: proposal and decision are required' using errcode = 'P0001';
  end if;
  select * into v_p from crm.customer_location_proposals where id = p_proposal_id for update;
  if not found then raise exception 'NOT_FOUND: location proposal' using errcode = 'P0002'; end if;
  if not authz.customer_in_scope('crm.customer_location.verify', v_p.customer_id) then
    raise exception 'PERMISSION_DENIED: customer not in your scope' using errcode = '42501';
  end if;

  v_target := case when p_approve then 'approved' else 'rejected' end;
  if v_p.status = v_target then
    return jsonb_build_object('proposal_id', v_p.id, 'customer_id', v_p.customer_id, 'status', v_p.status,
                              'replayed', true);
  end if;
  if v_p.status <> 'pending' then
    raise exception 'INVALID_STATE: proposal is %', v_p.status using errcode = 'P0001';
  end if;

  select * into v_c from crm.customers where id = v_p.customer_id for update;
  if not found then raise exception 'NOT_FOUND: customer' using errcode = 'P0002'; end if;

  if not p_approve then
    if v_note is null then raise exception 'REASON_REQUIRED' using errcode = 'P0001'; end if;
    update crm.customer_location_proposals
       set status = 'rejected', decided_by = v_emp, decided_at = now(), decision_note = v_note
     where id = v_p.id;
    perform crm._add_activity(v_p.customer_id, v_emp, 'note', 'Proposed clinic location rejected',
                              'crm.customer_location_proposals', v_p.id);
  else
    if v_c.archived_at is not null then
      raise exception 'INVALID_STATE: customer is archived' using errcode = 'P0001';
    end if;
    if v_c.latitude is not null then
      raise exception 'ALREADY_PINNED: the customer already has a location' using errcode = 'P0001';
    end if;
    v_max_acc := coalesce((select (value #>> '{}')::numeric from core.system_settings where key = 'field.max_accuracy_m'), 100);
    if v_p.accuracy_m is null or v_p.accuracy_m > v_max_acc then
      raise exception 'LOCATION_INACCURATE: the fix accuracy is worse than % m', v_max_acc using errcode = 'P0001';
    end if;
    -- Decide first, then pin: the customers trigger supersedes the OTHER pending proposals.
    update crm.customer_location_proposals
       set status = 'approved', decided_by = v_emp, decided_at = now(), decision_note = v_note
     where id = v_p.id;
    update crm.customers set latitude = v_p.latitude, longitude = v_p.longitude, location_verified = true,
                             version = version + 1
     where id = v_p.customer_id;
    perform crm._add_activity(v_p.customer_id, v_emp, 'note', 'Clinic location set from an approved visit proposal',
                              'crm.customer_location_proposals', v_p.id);
  end if;

  perform crm._emit('customer.location_proposal_decided', 'crm.customer', v_p.customer_id, jsonb_build_object(
    'proposal_id', v_p.id, 'customer_id', v_p.customer_id, 'visit_id', v_p.visit_id,
    'employee_id', v_p.proposed_by, 'decision', v_target));
  perform crm._notify_employee(v_p.proposed_by, 'customer.location_proposal_decided',
    'Clinic location ' || v_target, v_note, '/customers/' || v_p.customer_id,
    jsonb_build_object('proposal_id', v_p.id, 'customer_id', v_p.customer_id, 'approved', p_approve));

  return jsonb_build_object('proposal_id', v_p.id, 'customer_id', v_p.customer_id, 'status', v_target,
                            'latitude', case when p_approve then v_p.latitude end,
                            'longitude', case when p_approve then v_p.longitude end,
                            'replayed', false);
end $$;

-- ---------------------------------------------------------------------------
-- 5. Read view (security_invoker: the proposals RLS above, plus customer RLS on the join)
-- ---------------------------------------------------------------------------
create or replace view api.v_customer_location_proposals with (security_invoker = true) as
  select p.id, p.customer_id, c.customer_no, c.display_name as customer_name, c.territory_id,
         t.name_en as territory_name_en, t.name_ar as territory_name_ar,
         (c.latitude is not null) as customer_has_location,
         p.visit_id, p.proposed_by, pb.full_name_en as proposed_by_name_en, pb.full_name_ar as proposed_by_name_ar,
         p.latitude, p.longitude, p.accuracy_m, p.captured_at, p.anomaly_flags,
         p.status, p.decided_by, db.full_name_en as decided_by_name_en, db.full_name_ar as decided_by_name_ar,
         p.decided_at, p.decision_note, p.created_at
  from crm.customer_location_proposals p
  left join crm.customers c on c.id = p.customer_id
  left join core.territories t on t.id = c.territory_id
  left join lateral crm.employee_display(p.proposed_by) pb on true
  left join lateral crm.employee_display(p.decided_by) db on true;

-- ---------------------------------------------------------------------------
-- 6. Privileges
-- ---------------------------------------------------------------------------
grant select on api.v_customer_location_proposals to authenticated;
revoke all on api.v_customer_location_proposals from anon;

-- Trigger functions: never client-callable.
revoke execute on function field.propose_location_from_check_in() from public, anon, authenticated;
revoke execute on function crm.supersede_location_proposals() from public, anon, authenticated;

revoke execute on function api.decide_customer_location_proposal(uuid, boolean, text) from public, anon;
grant execute on function api.decide_customer_location_proposal(uuid, boolean, text) to authenticated;
