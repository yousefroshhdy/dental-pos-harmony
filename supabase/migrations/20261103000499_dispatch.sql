-- Honest OS migration: decision-hook dispatcher, commissions branch (brief §5 hook rule).
-- Starts from the latest definition (20261031000100_finance_ar_commands.sql, which added
-- 'finance.credit_note') and adds 'perf.commission_adjustment'
-- (wf.on_decided_perf_commission_adjustment, 20261103000400_commissions.sql).
-- Every existing branch is kept; the lead consolidates the branches of this wave.
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
    when 'perf.commission_adjustment' then perform wf.on_decided_perf_commission_adjustment(p_request_id, p_approved);
    else null;                                -- workflows without side effects
  end case;
end $$;
