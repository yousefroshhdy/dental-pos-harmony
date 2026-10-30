-- Honest OS migration: one consolidated approval-hook dispatch.
--
-- Several modules built in parallel each redefined wf.dispatch_decision_hook in their
-- own *_99_dispatch.sql file, so the last one applied would drop the others' branches.
-- This file runs after all of them and is the single source of truth. When a module
-- adds a hook, add its branch here (and only here).
-- Still a hard-coded CASE: configuration can never name a function to run.
create or replace function wf.dispatch_decision_hook(p_code text, p_request_id uuid, p_approved boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  case p_code
    when 'sales.order.discount'  then perform wf.on_decided_sales_order_discount(p_request_id, p_approved);
    when 'inventory.adjustment'  then perform wf.on_decided_inventory_adjustment(p_request_id, p_approved);
    when 'sales.order.cancel'    then perform wf.on_decided_sales_order_cancel(p_request_id, p_approved);
    when 'crm.customer.reassign' then perform wf.on_decided_crm_customer_reassign(p_request_id, p_approved);
    when 'field.visit.exception' then perform wf.on_decided_field_visit_exception(p_request_id, p_approved);
    when 'finance.credit_note'   then perform wf.on_decided_finance_credit_note(p_request_id, p_approved);
    when 'finance.write_off'     then perform wf.on_decided_finance_write_off(p_request_id, p_approved);
    when 'sales.return'          then perform wf.on_decided_sales_return(p_request_id, p_approved);
    else null;                                -- workflows without side effects
  end case;
end $$;

revoke all on function wf.dispatch_decision_hook(text, uuid, boolean) from public, anon, authenticated;
