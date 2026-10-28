-- Honest OS migration: approval requests always carry their scope context.
--
-- Bug fixed (integration of migrations 0200 and 0300): the approval engine
-- checks scope-limited approvers against the request's subject employee
-- (own/team grants) and payload.territory_id / payload.warehouse_id (territory/
-- warehouse grants). CRM and field requests were inserted without them, so an
-- area manager was refused as approver for his own rep's visit exception or a
-- customer reassignment in his territory (supabase/tests/database/16_*).
--
-- This trigger fills missing context from the request's entity, so every
-- request creator — current and future — gets correct approver scoping.
-- Values already supplied (e.g. by wf.create_request) are never overwritten.

create or replace function wf.fill_request_context() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_subject uuid; v_territory uuid; v_warehouse uuid;
begin
  case new.entity_type
    when 'field.visit' then
      select v.employee_id, c.territory_id into v_subject, v_territory
      from field.visits v join crm.customers c on c.id = v.customer_id where v.id = new.entity_id;
    when 'crm.customer' then
      select a.employee_id, c.territory_id into v_subject, v_territory
      from crm.customers c
      left join crm.customer_assignments a
        on a.customer_id = c.id and a.role = 'primary_rep' and a.valid_to is null
      where c.id = new.entity_id;
    when 'sales.order' then
      select o.employee_id, o.territory_id into v_subject, v_territory
      from sales.orders o where o.id = new.entity_id;
    when 'inventory.adjustment' then
      v_warehouse := nullif(new.payload ->> 'warehouse_id', '')::uuid;
      select e.id into v_subject from core.user_profiles p join core.employees e on e.id = p.employee_id
      where p.user_id = new.requested_by;
    else
      null;
  end case;

  if new.subject_employee_id is null then new.subject_employee_id := v_subject; end if;
  if v_territory is not null and not (new.payload ? 'territory_id') then
    new.payload := new.payload || jsonb_build_object('territory_id', v_territory);
  end if;
  if v_warehouse is not null and not (new.payload ? 'warehouse_id') then
    new.payload := new.payload || jsonb_build_object('warehouse_id', v_warehouse);
  end if;
  return new;
end $$;

revoke execute on function wf.fill_request_context() from public;

create trigger trg_approval_requests_context before insert on wf.approval_requests
  for each row execute function wf.fill_request_context();
