-- Honest OS migration: row level security and grants
-- Origin: docs/database/draft/10_schema_draft.sql (Phase 1, validated). See docs/DATABASE.md.

-- ---------------------------------------------------------------------------
-- ROW LEVEL SECURITY (deny by default: RLS on, no policy = no rows)
-- RLS is ENABLED but deliberately NOT FORCED: tables and SECURITY DEFINER
-- functions share one owner role, so domain commands run without RLS while
-- every client role (anon, authenticated) is filtered. See ADR-005.
-- ---------------------------------------------------------------------------
do $$
declare r record;
begin
  for r in select schemaname, tablename from pg_tables
           where schemaname in ('core','authz','catalog','inventory','crm','field','work','sales',
                                'finance','perf','wf','audit','notify','integration')
  loop
    execute format('alter table %I.%I enable row level security', r.schemaname, r.tablename);
  end loop;
end $$;

-- Base privileges: authenticated may SELECT (RLS filters). Writes go through
-- api.* SECURITY DEFINER functions, except a few self-service tables below.
grant usage on schema core, authz, catalog, inventory, crm, field, work, sales, finance, perf, wf, notify, api to authenticated;
do $$
declare s text;
begin
  foreach s in array array['core','authz','catalog','inventory','crm','field','work','sales','finance','perf','wf','notify'] loop
    execute format('grant select on all tables in schema %I to authenticated', s);
  end loop;
end $$;
revoke all on all functions in schema api from public;
grant execute on all functions in schema api to authenticated;

-- CRM: territory / assignment visibility
create policy customers_select on crm.customers for select to authenticated using (
  (select authz.has_global('crm.customer.read'))
  or territory_id = any((select authz.territory_ids('crm.customer.read'))::uuid[])
  or id = any((select authz.assigned_customer_ids('crm.customer.read'))::uuid[])
);
create policy assignments_select on crm.customer_assignments for select to authenticated using (
  exists (select 1 from crm.customers c where c.id = customer_assignments.customer_id)  -- inherits customer RLS
);
create policy activities_select on crm.activities for select to authenticated using (
  exists (select 1 from crm.customers c where c.id = activities.customer_id)
);

-- Sales orders: own/team/territory/all
create policy orders_select on sales.orders for select to authenticated using (
  (select authz.has_global('sales.order.read'))
  or employee_id = any((select authz.employee_ids('sales.order.read'))::uuid[])
  or territory_id = any((select authz.territory_ids('sales.order.read'))::uuid[])
);
create policy order_items_select on sales.order_items for select to authenticated using (
  exists (select 1 from sales.orders o where o.id = order_items.order_id)
);

-- Visits
create policy visits_select on field.visits for select to authenticated using (
  (select authz.has_global('field.visit.read'))
  or employee_id = any((select authz.employee_ids('field.visit.read'))::uuid[])
  or exists (select 1 from crm.customers c where c.id = visits.customer_id
             and c.territory_id = any((select authz.territory_ids('field.visit.read'))::uuid[]))
);
-- Raw GPS fixes are more sensitive than the visit verdict (privacy, ADR-010).
create policy location_events_select on field.location_events for select to authenticated using (
  employee_id = (select authz.current_employee_id())
  or (select authz.has_global('field.location.read'))
  or employee_id = any((select authz.employee_ids('field.location.read'))::uuid[])
);

-- Catalog: everyone with catalog access sees products & prices; costs are separate.
create policy products_select on catalog.products for select to authenticated using ((select authz.has_permission('catalog.product.read')));
create policy variants_select on catalog.product_variants for select to authenticated using ((select authz.has_permission('catalog.product.read')));
create policy brands_select on catalog.brands for select to authenticated using ((select authz.has_permission('catalog.product.read')));
create policy categories_select on catalog.categories for select to authenticated using ((select authz.has_permission('catalog.product.read')));
create policy price_lists_select on catalog.price_lists for select to authenticated using ((select authz.has_permission('catalog.price.read')));
create policy price_items_select on catalog.price_list_items for select to authenticated using ((select authz.has_permission('catalog.price.read')));
create policy costs_select on catalog.product_costs for select to authenticated using ((select authz.has_permission('catalog.cost.read')));

-- Inventory
create policy stock_select on inventory.stock_balances for select to authenticated using (
  (select authz.has_global('inventory.stock.read'))
  or warehouse_id = any((select authz.warehouse_ids('inventory.stock.read'))::uuid[])
  or ((select authz.has_permission('inventory.stock.read')) and exists (
        select 1 from authz.grants('inventory.stock.read') g where g.scope in ('own','team','territory')))
);
create policy lots_select on inventory.lots for select to authenticated using ((select authz.has_permission('inventory.stock.read')));
create policy warehouses_select on inventory.warehouses for select to authenticated using ((select authz.has_permission('inventory.stock.read')));
create policy movements_select on inventory.movements for select to authenticated using (
  (select authz.has_global('inventory.movement.read'))
  or warehouse_id = any((select authz.warehouse_ids('inventory.movement.read'))::uuid[])
);

-- Finance: invoices visible to finance (all) or to reps for their customers' invoices
create policy invoices_select on finance.invoices for select to authenticated using (
  (select authz.has_global('finance.invoice.read'))
  or ((select authz.has_permission('finance.invoice.read'))
      and exists (select 1 from crm.customers c where c.id = invoices.customer_id))
);
create policy payments_select on finance.payments for select to authenticated using (
  (select authz.has_global('finance.payment.read'))
  or collected_by = any((select authz.employee_ids('finance.payment.read'))::uuid[])
);
create policy ledger_select on finance.customer_ledger for select to authenticated using (
  (select authz.has_global('finance.ledger.read'))
  or ((select authz.has_permission('finance.ledger.read'))
      and exists (select 1 from crm.customers c where c.id = customer_ledger.customer_id))
);

-- Performance: own results; managers their team; commission data is stricter.
create policy kpi_results_select on perf.kpi_results for select to authenticated using (
  (select authz.has_global('perf.kpi.read'))
  or employee_id = any((select authz.employee_ids('perf.kpi.read'))::uuid[])
  or territory_id = any((select authz.territory_ids('perf.kpi.read'))::uuid[])
);
create policy commission_entries_select on perf.commission_entries for select to authenticated using (
  (select authz.has_global('perf.commission.read'))
  or employee_id = any((select authz.employee_ids('perf.commission.read'))::uuid[])
);
create policy commission_rules_select on perf.commission_plan_rules for select to authenticated using (
  (select authz.has_permission('perf.commission_plan.read'))
);

-- Self-service: profile, notifications, tasks
create policy profiles_self on core.user_profiles for select to authenticated using (
  user_id = auth.uid() or (select authz.has_permission('admin.user.read'))
);
create policy employees_select on core.employees for select to authenticated using (
  user_id = auth.uid()
  or (select authz.has_global('core.employee.read'))
  or id = any((select authz.employee_ids('core.employee.read'))::uuid[])
);
create policy notifications_own on notify.notifications for select to authenticated using (recipient_user_id = auth.uid());
create policy notifications_mark_read on notify.notifications for update to authenticated
  using (recipient_user_id = auth.uid()) with check (recipient_user_id = auth.uid());
grant update (read_at) on notify.notifications to authenticated;
create policy tasks_select on work.tasks for select to authenticated using (
  assignee_employee_id = (select authz.current_employee_id())
  or (select authz.has_global('work.task.read'))
  or assignee_employee_id = any((select authz.employee_ids('work.task.read'))::uuid[])
);

-- Authorization data: users see their own grants; admins see all.
create policy user_roles_select on authz.user_roles for select to authenticated using (
  user_id = auth.uid() or (select authz.has_permission('admin.role.read'))
);
create policy roles_select on authz.roles for select to authenticated using (true);
create policy role_perms_select on authz.role_permissions for select to authenticated using ((select authz.has_permission('admin.role.read')));
create policy permissions_select on authz.permissions for select to authenticated using (true);

-- Reference data readable by any active user
create policy gov_select on core.governorates for select to authenticated using ((select authz.is_active_user()));
create policy territories_select on core.territories for select to authenticated using ((select authz.is_active_user()));
create policy specialties_select on crm.specialties for select to authenticated using ((select authz.is_active_user()));

-- Authz helper functions are callable by the policies (and harmless: read-only, caller-scoped).
grant usage on schema authz to authenticated;
grant execute on all functions in schema authz to authenticated;
-- But domain functions that write are not exposed outside api.*
revoke execute on function core.next_document_no(text, date) from public;
