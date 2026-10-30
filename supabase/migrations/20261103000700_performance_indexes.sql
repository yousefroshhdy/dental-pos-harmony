-- Honest OS migration: database performance (TESTING.md §2.9, DATABASE.md §5).
--
--   1. Foreign-key coverage. Every foreign key in the domain schemas gets an index whose
--      leading columns are the FK columns (Supabase advisor `unindexed_foreign_keys`, 132 on
--      staging, 145 at this commit). A partial index counts only when its predicate is
--      `<fk column> is not null` (implied by the referential check `fk = $1`); any other
--      partial index (e.g. `where valid_to is null`) cannot serve the check on delete/update of
--      the parent row, so the FK gets a full index next to it. Where a hot filter or sort starts
--      with the FK column, the FK index is that composite (e.g. payments (collected_by,
--      received_at desc)). Suite 40 guards this with a catalog query.
--      No exclusions: the smallest reference tables (order_transitions, workflow_stages,
--      offices…) cost a few kB per index and keep the guard a plain "zero offenders".
--   2. Hot filters and sorts from the api views, the RLS policies, the app's list queries
--      (src/modules/*/queries.ts) and the KPI metric functions (perf.metric_*).
--   3. crm.customer_balances_in_scope(): its scope CTE was inlined by the planner, so
--      authz.has_global / territory_ids / assigned_customer_ids ran once per ledger row
--      (45 s for one customer-list page with 15k ledger rows). `as materialized` makes them
--      run once per call. Same signature, same body otherwise, same result.
--
-- Non-destructive: `create index if not exists` and one `create or replace` (same signature).
-- No index is dropped (the advisor's 16 "unused" indexes are kept; see the PR notes).
-- Plain CREATE INDEX takes a SHARE lock while it builds; table sizes before go-live make this
-- seconds. On a large production table, build the index CONCURRENTLY outside a transaction first;
-- `if not exists` then makes this migration a no-op for it.

-- ---------------------------------------------------------------------------
-- 1. Foreign-key coverage
-- ---------------------------------------------------------------------------

-- authz
create index if not exists idx_role_permissions_permission_code on authz.role_permissions (permission_code);
create index if not exists idx_roles_created_by on authz.roles (created_by);
create index if not exists idx_user_permission_overrides_granted_by on authz.user_permission_overrides (granted_by);
create index if not exists idx_user_permission_overrides_permission_code on authz.user_permission_overrides (permission_code);
create index if not exists idx_user_permission_overrides_scope_territory_id on authz.user_permission_overrides (scope_territory_id);
create index if not exists idx_user_roles_granted_by on authz.user_roles (granted_by);
create index if not exists idx_user_roles_revoked_by on authz.user_roles (revoked_by);
create index if not exists idx_user_roles_role_id on authz.user_roles (role_id);
create index if not exists idx_user_roles_scope_department_id on authz.user_roles (scope_department_id);
create index if not exists idx_user_roles_scope_territory_id on authz.user_roles (scope_territory_id);
create index if not exists idx_user_roles_scope_warehouse_id on authz.user_roles (scope_warehouse_id);
create index if not exists idx_user_roles_user_id on authz.user_roles (user_id);

-- catalog
create index if not exists idx_categories_parent_id on catalog.categories (parent_id);
create index if not exists idx_customer_price_lists_price_list_id on catalog.customer_price_lists (price_list_id);
create index if not exists idx_price_list_items_variant_id on catalog.price_list_items (variant_id);
create index if not exists idx_product_costs_created_by on catalog.product_costs (created_by);
create index if not exists idx_products_brand_id on catalog.products (brand_id);
create index if not exists idx_products_category_id on catalog.products (category_id);

-- core
create index if not exists idx_departments_parent_id on core.departments (parent_id);
create index if not exists idx_employee_territories_employee_id on core.employee_territories (employee_id);
create index if not exists idx_employee_territories_territory_id on core.employee_territories (territory_id);
create index if not exists idx_employees_department_id on core.employees (department_id);
create index if not exists idx_employees_office_id on core.employees (office_id);
create index if not exists idx_offices_governorate_code on core.offices (governorate_code);
create index if not exists idx_system_settings_updated_by on core.system_settings (updated_by);
create index if not exists idx_territories_parent_id on core.territories (parent_id);
create index if not exists idx_territory_coverage_territory_id on core.territory_coverage (territory_id);
create index if not exists idx_user_profiles_suspended_by on core.user_profiles (suspended_by);

-- crm
create index if not exists idx_activities_employee_id_occurred_at on crm.activities (employee_id, occurred_at desc);
create index if not exists idx_customer_assignments_assigned_by on crm.customer_assignments (assigned_by);
create index if not exists idx_customer_assignments_customer_id on crm.customer_assignments (customer_id);
create index if not exists idx_customer_assignments_employee_id on crm.customer_assignments (employee_id);
create index if not exists idx_customer_contacts_customer_id on crm.customer_contacts (customer_id);
create index if not exists idx_customers_created_by on crm.customers (created_by);
create index if not exists idx_customers_governorate_code on crm.customers (governorate_code);
create index if not exists idx_customers_specialty_code on crm.customers (specialty_code);
create index if not exists idx_opportunities_brand_id on crm.opportunities (brand_id);
create index if not exists idx_opportunities_owner_employee_id on crm.opportunities (owner_employee_id);
create index if not exists idx_opportunities_won_order_id on crm.opportunities (won_order_id);

-- field
create index if not exists idx_location_events_employee_id_captured_at on field.location_events (employee_id, captured_at);
create index if not exists idx_tracking_notice_acks_notice_version on field.tracking_notice_acks (notice_version);
create index if not exists idx_tracking_notice_acks_user_id on field.tracking_notice_acks (user_id);
create index if not exists idx_tracking_notices_created_by on field.tracking_notices (created_by);
create index if not exists idx_work_shifts_notice_version on field.work_shifts (notice_version);

-- finance
create index if not exists idx_collection_tasks_customer_id on finance.collection_tasks (customer_id);
create index if not exists idx_collection_tasks_updated_by on finance.collection_tasks (updated_by);
create index if not exists idx_collection_tasks_work_task_id on finance.collection_tasks (work_task_id);
create index if not exists idx_credit_notes_created_by on finance.credit_notes (created_by);
create index if not exists idx_credit_notes_customer_id on finance.credit_notes (customer_id);
create index if not exists idx_credit_notes_return_id on finance.credit_notes (return_id);
create index if not exists idx_customer_ledger_posted_by on finance.customer_ledger (posted_by);
create index if not exists idx_invoice_items_variant_id on finance.invoice_items (variant_id);
create index if not exists idx_invoices_created_by on finance.invoices (created_by);
create index if not exists idx_invoices_order_id on finance.invoices (order_id);
create index if not exists idx_payment_allocations_allocated_by on finance.payment_allocations (allocated_by);
-- payments.collected_by is the team-scope column of payments_select; the list sorts by received_at.
create index if not exists idx_payments_collected_by_received_at on finance.payments (collected_by, received_at desc);
create index if not exists idx_payments_confirmed_by on finance.payments (confirmed_by);
create index if not exists idx_payments_created_by on finance.payments (created_by);
create index if not exists idx_payments_reversed_by on finance.payments (reversed_by);

-- inventory
create index if not exists idx_goods_receipt_items_receipt_id on inventory.goods_receipt_items (receipt_id);
create index if not exists idx_goods_receipt_items_variant_id on inventory.goods_receipt_items (variant_id);
create index if not exists idx_goods_receipts_created_by on inventory.goods_receipts (created_by);
create index if not exists idx_goods_receipts_posted_by on inventory.goods_receipts (posted_by);
create index if not exists idx_goods_receipts_warehouse_id on inventory.goods_receipts (warehouse_id);
create index if not exists idx_movements_approval_request_id on inventory.movements (approval_request_id);
create index if not exists idx_movements_created_by on inventory.movements (created_by);
create index if not exists idx_movements_lot_id on inventory.movements (lot_id);
-- warehouse scope of movements_select + the movement list (created_at desc, id).
create index if not exists idx_movements_warehouse_id_created_at_id on inventory.movements (warehouse_id, created_at desc, id);
create index if not exists idx_reservations_lot_id on inventory.reservations (lot_id);
create index if not exists idx_reservations_order_item_id on inventory.reservations (order_item_id);
create index if not exists idx_reservations_variant_id on inventory.reservations (variant_id);
create index if not exists idx_reservations_warehouse_id on inventory.reservations (warehouse_id);
create index if not exists idx_serials_lot_id on inventory.serials (lot_id);
create index if not exists idx_stock_balances_lot_id on inventory.stock_balances (lot_id);
create index if not exists idx_stock_balances_variant_id on inventory.stock_balances (variant_id);
create index if not exists idx_transfer_items_lot_id on inventory.transfer_items (lot_id);
create index if not exists idx_transfer_items_transfer_id on inventory.transfer_items (transfer_id);
create index if not exists idx_transfer_items_variant_id on inventory.transfer_items (variant_id);
create index if not exists idx_transfers_from_warehouse_id on inventory.transfers (from_warehouse_id);
create index if not exists idx_transfers_received_by on inventory.transfers (received_by);
create index if not exists idx_transfers_requested_by on inventory.transfers (requested_by);
create index if not exists idx_transfers_shipped_by on inventory.transfers (shipped_by);
create index if not exists idx_transfers_to_warehouse_id on inventory.transfers (to_warehouse_id);
create index if not exists idx_warehouses_office_id on inventory.warehouses (office_id);

-- notify (the existing index is partial on unread; this one also serves the full list)
create index if not exists idx_notifications_recipient_user_id_created_at on notify.notifications (recipient_user_id, created_at desc);

-- perf
create index if not exists idx_commission_adjustments_created_by on perf.commission_adjustments (created_by);
create index if not exists idx_commission_adjustments_employee_id on perf.commission_adjustments (employee_id);
create index if not exists idx_commission_adjustments_period_id on perf.commission_adjustments (period_id);
create index if not exists idx_commission_entries_employee_id on perf.commission_entries (employee_id);
create index if not exists idx_commission_entries_invoice_item_id on perf.commission_entries (invoice_item_id);
create index if not exists idx_commission_entries_period_id on perf.commission_entries (period_id);
create index if not exists idx_commission_entries_plan_id on perf.commission_entries (plan_id);
create index if not exists idx_commission_entries_rule_id on perf.commission_entries (rule_id);
create index if not exists idx_commission_periods_approved_by on perf.commission_periods (approved_by);
create index if not exists idx_commission_plan_rules_brand_id on perf.commission_plan_rules (brand_id);
create index if not exists idx_commission_plan_rules_category_id on perf.commission_plan_rules (category_id);
create index if not exists idx_commission_plan_rules_plan_id on perf.commission_plan_rules (plan_id);
create index if not exists idx_commission_plan_rules_variant_id on perf.commission_plan_rules (variant_id);
create index if not exists idx_employee_commission_plans_plan_id on perf.employee_commission_plans (plan_id);
create index if not exists idx_kpi_results_employee_id on perf.kpi_results (employee_id);
create index if not exists idx_kpi_results_territory_id on perf.kpi_results (territory_id);
create index if not exists idx_kpi_targets_employee_id on perf.kpi_targets (employee_id);
create index if not exists idx_kpi_targets_kpi_id on perf.kpi_targets (kpi_id);
create index if not exists idx_kpi_targets_role_id on perf.kpi_targets (role_id);
create index if not exists idx_kpi_targets_set_by on perf.kpi_targets (set_by);
create index if not exists idx_kpi_targets_territory_id on perf.kpi_targets (territory_id);

-- sales
create index if not exists idx_discount_rules_brand_id on sales.discount_rules (brand_id);
create index if not exists idx_discount_rules_category_id on sales.discount_rules (category_id);
create index if not exists idx_discount_rules_customer_id on sales.discount_rules (customer_id);
create index if not exists idx_discount_rules_variant_id on sales.discount_rules (variant_id);
create index if not exists idx_fulfillment_items_fulfillment_id on sales.fulfillment_items (fulfillment_id);
create index if not exists idx_fulfillment_items_lot_id on sales.fulfillment_items (lot_id);
create index if not exists idx_fulfillment_items_order_item_id on sales.fulfillment_items (order_item_id);
create index if not exists idx_fulfillment_items_serial_id on sales.fulfillment_items (serial_id);
create index if not exists idx_fulfillments_order_id on sales.fulfillments (order_id);
create index if not exists idx_fulfillments_posted_by on sales.fulfillments (posted_by);
create index if not exists idx_fulfillments_warehouse_id on sales.fulfillments (warehouse_id);
create index if not exists idx_order_items_price_list_id on sales.order_items (price_list_id);
create index if not exists idx_order_items_variant_id on sales.order_items (variant_id);
create index if not exists idx_order_status_history_changed_by on sales.order_status_history (changed_by);
create index if not exists idx_order_status_history_order_id on sales.order_status_history (order_id);
create index if not exists idx_order_transitions_required_permission on sales.order_transitions (required_permission);
create index if not exists idx_orders_created_by on sales.orders (created_by);
create index if not exists idx_orders_territory_id on sales.orders (territory_id);
create index if not exists idx_orders_visit_id on sales.orders (visit_id);
create index if not exists idx_return_items_lot_id on sales.return_items (lot_id);
create index if not exists idx_return_items_order_item_id on sales.return_items (order_item_id);
create index if not exists idx_return_items_return_id on sales.return_items (return_id);
create index if not exists idx_returns_created_by on sales.returns (created_by);
create index if not exists idx_returns_customer_id on sales.returns (customer_id);
create index if not exists idx_returns_order_id on sales.returns (order_id);
create index if not exists idx_returns_warehouse_id on sales.returns (warehouse_id);

-- wf
create index if not exists idx_approval_requests_definition_id on wf.approval_requests (definition_id);
create index if not exists idx_approval_requests_rule_id on wf.approval_requests (rule_id);
create index if not exists idx_approval_requests_subject_employee_id on wf.approval_requests (subject_employee_id);
create index if not exists idx_approval_steps_approver_id on wf.approval_steps (approver_id);
create index if not exists idx_approval_steps_on_behalf_of on wf.approval_steps (on_behalf_of);
create index if not exists idx_delegations_definition_id on wf.delegations (definition_id);
create index if not exists idx_delegations_from_user_id on wf.delegations (from_user_id);
create index if not exists idx_delegations_to_user_id on wf.delegations (to_user_id);
create index if not exists idx_workflow_stages_approver_permission on wf.workflow_stages (approver_permission);
create index if not exists idx_workflow_stages_approver_role_id on wf.workflow_stages (approver_role_id);
create index if not exists idx_workflow_stages_approver_user_id on wf.workflow_stages (approver_user_id);

-- work
create index if not exists idx_tasks_created_by on work.tasks (created_by);
create index if not exists idx_tasks_customer_id on work.tasks (customer_id);

-- ---------------------------------------------------------------------------
-- 2. Hot filters and sorts
-- ---------------------------------------------------------------------------

-- Customer list and pickers: `archived_at is null order by display_name, id` (crm, orders,
-- finance, field queries). An ordered index scan stops after one page instead of sorting all.
create index if not exists idx_customers_display_name_id on crm.customers (display_name, id)
  where archived_at is null;
-- perf.metric_customers_added (created_at range).
create index if not exists idx_customers_created_at on crm.customers (created_at);

-- Order list: `order by created_at desc limit n` (orders queries).
create index if not exists idx_orders_created_at on sales.orders (created_at desc);
-- perf.booked_orders / perf.roster / perf.metric_approval_turnaround_hours (period filters).
create index if not exists idx_orders_submitted_at on sales.orders (submitted_at)
  where submitted_at is not null;
create index if not exists idx_orders_approved_at on sales.orders (approved_at)
  where approved_at is not null;
-- perf.booked_orders: cancellations after the original period closed.
create index if not exists idx_orders_status_updated_at on sales.orders (status, updated_at)
  where status in ('cancelled', 'rejected');
-- api.v_orders.pending_approval_request_id: `entity_id = o.id and status = 'pending'` per row
-- (uq_one_pending_request leads with definition_id, so it cannot serve this lookup).
create index if not exists idx_approval_requests_entity_id on wf.approval_requests (entity_id);

-- Visits: rep plan for a day (v_my_today, planning) and the visits list sort.
create index if not exists idx_visits_employee_id_planned_for on field.visits (employee_id, planned_for);
create index if not exists idx_visits_planned_for on field.visits (planned_for);
-- Matches field queries' `order by check_in_at desc nulls first, planned_for desc nulls last,
-- created_at desc limit n` exactly; also the check_in_at range of perf.completed_visits.
create index if not exists idx_visits_check_in_at_planned_for_created_at
  on field.visits (check_in_at desc nulls first, planned_for desc nulls last, created_at desc);

-- Invoices list: `order by issue_date desc, invoice_no desc` (finance queries); issue_date
-- range of perf.metric_net_revenue. (customer_id, status) and open-by-due-date already exist.
create index if not exists idx_invoices_issue_date_invoice_no on finance.invoices (issue_date desc, invoice_no desc);
-- perf.metric_net_revenue (credit notes in the period).
create index if not exists idx_credit_notes_issue_date on finance.credit_notes (issue_date);

-- Payments list: `order by received_at desc` (finance queries); perf.metric_cash_collected.
create index if not exists idx_payments_received_at on finance.payments (received_at desc);

-- Movement list: `order by created_at desc, id` (inventory queries), all warehouses.
create index if not exists idx_movements_created_at_id on inventory.movements (created_at desc, id);

-- perf.fulfilled_lines: posted fulfilments by coalesce(delivered_at, created_at).
create index if not exists idx_fulfillments_delivered_or_created_at
  on sales.fulfillments ((coalesce(delivered_at, created_at))) where status = 'posted';

-- ---------------------------------------------------------------------------
-- 3. Scope helpers evaluated once per call, not once per row
-- ---------------------------------------------------------------------------
-- Same signature and result as 20261029000200; only `as materialized` is new. Without it the
-- planner inlines the CTE and evaluates the three authz helpers in the per-row filter.
create or replace function crm.customer_balances_in_scope()
returns table (customer_id uuid, balance numeric, last_movement_at timestamptz)
language sql stable security definer set search_path = '' as $$
  with s as materialized (
    select authz.has_global('crm.customer_balance.read') as g,
           authz.territory_ids('crm.customer_balance.read') as t,
           authz.assigned_customer_ids('crm.customer_balance.read') as a)
  select l.customer_id, sum(l.amount)::numeric(14,2), max(l.posted_at)
  from s, finance.customer_ledger l join crm.customers c on c.id = l.customer_id
  where s.g or c.territory_id = any(s.t) or c.id = any(s.a)
  group by l.customer_id
$$;

-- Fresh statistics for the planner on the tables the new indexes serve.
analyze crm.customers;
analyze crm.customer_assignments;
analyze sales.orders;
analyze field.visits;
analyze finance.invoices;
analyze finance.payments;
analyze inventory.movements;
