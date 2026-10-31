# API Contracts — Honest OS

> Status: **Specified; implemented commands listed in §1a and §1b** · Last updated: 2026-10-30

## 1. Conventions

- **Transport:** Next.js Server Actions → `supabase.rpc('<command>', args)` with the user's session. PostgREST exposes only the `api` schema.
- **Naming:** `api.<verb>_<noun>` for commands, `api.v_<noun>` for read views (`security_invoker = true`).
- **Idempotency:** every command that a device can retry takes `p_client_ref uuid` or `p_idempotency_key text`. A replay returns the original result and never applies twice.
- **Errors:** `CODE: message` with SQLSTATE (see `docs/ARCHITECTURE.md` §8.1). The TS wrapper turns them into `AppError`.
- **Money and quantities:** money as numeric strings in JSON (`"2234.40"`), quantities as integers. Clients **never** send prices, totals, tax or user ids. The server derives them.
- **Time:** ISO-8601 with offset. Device-captured times are labelled `captured_at`. The server stamps `received_at`.

### TS wrapper (Phase 2)

```ts
// src/lib/command.ts — every server action goes through this
export async function command<I, O>(name: string, schema: ZodSchema<I>, input: unknown): Promise<Result<O>> {
  const args = schema.parse(input);                       // 422 on invalid input
  const supabase = await createServerClient();             // user JWT, never service role
  const requestId = headers().get('x-request-id')!;
  for (let attempt = 0; attempt < 3; attempt++) {
    const { data, error } = await supabase.rpc(name, args, { head: false });
    if (!error) return ok(data as O);
    const appErr = toAppError(error, requestId);            // maps SQLSTATE + CODE prefix
    if (!appErr.retryable) return fail(appErr);             // 40001/40P01 are retryable
    await sleep(100 * 2 ** attempt + Math.random() * 100);
  }
  return fail(AppError.unavailable(requestId));
}
```

## 1a. As built (2026-10-28)

Implemented and tested on local PostgreSQL 16 with the stub. Not yet on a live Supabase project. The authoritative signatures are in the migration files.

| Area | Commands | Migration |
|------|----------|-----------|
| Platform | `my_context()`, `create_employee(…)`, `register_user(user, employee, locale)`, `suspend_user(user, reason)`, `reactivate_user(user, reason)`, `create_role(code, name_en, name_ar?, description?)`, `set_role_permission(role, perm, scope, limit?)`, `remove_role_permission(role, perm)`, `grant_role(user, role, territory?, reason?)`, `revoke_role(user_role, reason)`, `mark_notifications_read(ids[])` | 1200, 1400 |
| CRM | `create_customer(…, p_client_ref)`, `update_customer(id, version, changes jsonb)`, `set_customer_location(id, lat, lng)`, `request_customer_reassignment(id, to_employee, reason)`, `create_opportunity(…)`, `move_opportunity(id, stage, lost_reason?)`, `log_activity(customer, type, summary, at?)` | 0200 |
| Tasks | `create_task(title, due_at, customer?, kind?, assignee?, client_ref?)`, `complete_task(id, outcome)` | 0200 |
| Field | `visit_check_in(visit_id, customer, lat, lng, accuracy, captured_at, device)`, `visit_check_out(visit_id, outcome, notes, lat, lng, accuracy, captured_at, next_follow_up_at?)`, `request_visit_exception(visit_id, reason)` | 1200, 0200 |
| Orders | `save_order_draft(order_id, customer, lines jsonb, notes?, visit?, version?, employee?)`, `submit_order(id)`, `approve_order(id)`, `reject_order(id, reason)`, `reserve_order(id, warehouse)`, `post_fulfillment(id, idempotency_key)`, `cancel_order(id, reason)` | 1200, 0300 |
| Inventory | `create_goods_receipt(warehouse, supplier, shipment_ref, items jsonb)`, `post_goods_receipt(id)`, `create_transfer(from, to, items jsonb)`, `ship_transfer(id)`, `receive_transfer(id)`, `post_inventory_adjustment(…)`, `request_inventory_adjustment(…, idempotency_key)` | 1200, 0300 |
| Approvals | `decide_approval(request, 'approve'\|'reject', comment?)` | 0300 |
| Integrations | `retry_outbox_event(id)`; service-only: `service.outbox_claim(limit)`, `service.outbox_result(id, ok, http_status, error)` | 0100 (2026-10-29) |

**Read views:**
- **Admin and platform:** `v_users`, `v_user_roles`, `v_roles`, `v_role_permissions`, `v_permissions`, `v_employees`, `v_territories`, `v_notifications`, `v_security_events`, `v_audit_log`.
- **CRM, field and tasks:** `v_customers` (balance masked), `v_customer_timeline`, `v_opportunities`, `v_tasks`, `v_visits`, `v_my_today`.
- **Orders, stock and approvals:** `v_orders`, `v_order_lines`, `v_stock_available`, `v_stock_detail`, `v_movements` (cost masked), `v_transfers`, `v_approvals_inbox`.
- **Integrations:** `v_outbox_health`, `v_outbox_dead`, `v_integration_routes`.

**Phase 3 additions (migrations `20261030000100`–`0600`, 2026-10-30):**

| Area | Commands | Read views | Migration |
|------|----------|------------|-----------|
| CRM | `find_duplicate_customers(…)` (read-only) | `v_crm_assignable_employees`, `v_governorates`, `v_specialties` | 0100 |
| Orders | — | `v_sellable_variants`, `v_order_status_history` | 0300 |
| Inventory | — | `v_inventory_stock`, `v_inventory_variants`, `v_inventory_warehouses`, `v_reorder_alerts`, `v_goods_receipts`, `v_transfer_lines` | 0400 |
| Approvals | — | `v_approval_requests`, `v_approval_steps` | 0500 |
| Catalogue | `upsert_product`, `upsert_variant`, `set_product_status`, `set_variant_status` (no hard delete), `upsert_price_list`, `set_price_list_item`, `remove_price_list_item`, `assign_customer_price_list`, `end_customer_price_list`, `create_promotion`, `end_promotion`; all require a company-wide `catalog.*` grant | `v_catalog_products`, `v_catalog_variants`, `v_catalog_brands`, `v_catalog_categories`, `v_price_lists`, `v_price_list_items`, `v_customer_price_lists`, `v_promotions` | 0600 |

All the new views are `security_invoker`. Suites 19 and 21–24 cover them, and suites 17 and 18 still guard the privilege sweep and per-statement `auth.uid()`.

**Contract changes from the 2026-10-30 audit (migrations `0700`, `0800`; suites 25, 26):**
- **Customer duplicates never reveal what the caller can't read.**
  - `find_duplicate_customers` names only customers the caller can read. Other matches appear only as `phone_duplicate_outside_scope`, `similar_outside_scope` or `exists_outside_scope`.
  - `create_customer` follows the same rule. An out-of-scope hard duplicate raises `DUPLICATE_CUSTOMER: … outside your scope`, with detail `{"outside_scope": true}`. The `POSSIBLE_DUPLICATE` warning names only readable customers and carries `outside_scope`.
- **Discontinued items:** `submit_order` (via `sales.price_order`) and `reserve_order` raise `NOT_SELLABLE` (P0001) for an inactive variant or product.
- **Quarantine release:** `create_transfer` and `receive_transfer` raise 42501 when stock leaves a quarantine warehouse for any other kind of warehouse and the caller lacks `inventory.quarantine.release` (D-13). The scope is checked on the source warehouse.
- **Price lists:**
  - The DEFAULT list cannot start in the future (`upsert_price_list`).
  - `assign_customer_price_list` refuses a past end date and ignores cancelled assignments in its overlap check.
  - Customer-specific lists are readable only by price managers or for customers in the caller's scope.
- **Dates:** business dates are Cairo days (`core.business_date()`).

**Finance, dashboards and tracking (migrations `20261031000100`–`0300`; suites 27–30):**

| Area | Commands | Read views / functions | Cron |
|------|----------|------------------------|------|
| Finance (AR core) | `issue_invoice(order, key)`, `issue_credit_note(invoice, lines\|amount, reason, key)` (via the `finance.credit_note` approval), `record_payment(customer, amount, method, reference, received_at, client_ref, cheque_due_date)`, `confirm_payment`, `reject_payment`, `reverse_payment(payment, reason, bounced)`, `allocate_payment(payment, allocations\|null = oldest first, key)`, `reverse_allocation`, `update_collection_task`; service: `finance_overdue_scan(limit)` | `v_invoices`, `v_invoice_lines`, `v_credit_notes`, `v_payments`, `v_payment_allocations`, `v_customer_statement`, `v_ar_aging`, `v_ar_aging_totals`, `v_collection_tasks`, `v_invoiceable_orders`, `v_invoiceable_order_lines` | `/api/cron/overdue` daily |
| Dashboards | `set_kpi_target(…)`; service: `snapshot_kpis(as_of?)` | `kpi_summary(from, to, employee?, territory?)`, `kpi_team(from, to, codes?)`, `kpi_breakdown(from, to, 'territory'\|'brand', codes?)`, `kpi_overdue_customers(as_of?, employee?, limit?)`, `v_kpi_targets` | `/api/cron/kpi-snapshot` daily |
| Tracking (D-14) | `acknowledge_tracking_notice(version)`, `start_shift(…)`, `end_shift(…)`, `record_location_pings(jsonb)`; service: `tracking_auto_close()`, `tracking_purge()` | `my_tracking_status()`, `tracking_day(employee, day)`, `tracking_team_day(day)`, `v_tracking_day_summaries` | `/api/cron/tracking` daily |

New outbox events: `invoice.issued`, `invoice.overdue`, `credit_note.issued`, `payment.recorded`, `payment.confirmed`, `payment.rejected`, `payment.reversed`, `payment.allocated`, `payment.allocation_reversed`, `kpi_target.set`, and shift start/end/auto-close (no coordinates).

**Additional error codes (beyond §8.1 of ARCHITECTURE):**
- **Duplicates and conflicts:** `DUPLICATE_CUSTOMER`, `CONFLICT` (stale `version`), `IDEMPOTENCY_CONFLICT`.
- **Approvals:** `SELF_APPROVAL`, `LIMIT_EXCEEDED`, `ALREADY_DECIDED`, `CANCEL_PENDING`.
- **Stock:** `INSUFFICIENT_STOCK`, `LOT_EXPIRY_MISMATCH`, `EXPIRED_LOT`, `NOTHING_TO_FULFIL`.
- **Customers:** `CUSTOMER_BLOCKED`.
- **Configuration:** `WORKFLOW_MISSING`.

**Approval hook contract:**
- `wf.on_decided_<code>(request_id uuid, approved boolean)` is called exactly once at the final decision, in the same transaction, by `wf.dispatch_decision_hook` (a hard-coded CASE, never dynamic SQL).
- Hooks are not client-executable. They must not call `authz.require`: the workflow decision is the authorization.
- All branches live in one definition, `20261103009900_dispatch_consolidated.sql` (suite 45 guards it). A new hook adds its branch there, never in a module's own dispatch file.

### 1b. Wave 2 and audit 4 (migrations `20261102000100`–`20261104000800`, 2026-10-30)

Implemented and Tested (suites 33–53); nothing Verified. Signatures below are the latest definitions. "Step-up" means the command is subject to MFA (`MFA_REQUIRED`, 42501) when `security.mfa_enforced` is on (AUTHORIZATION §6.7). Every function sets `search_path = ''`, is revoked from `public`/`anon` and granted to `authenticated` by name; `service.*` functions are `service_role` only. Every view is `security_invoker`.

**Imports** (`20261103000100`, `…000110`; audit 4 `20261104000200`; suites 34, 47). Kinds: `customers`, `products`, `customer_prices`, `opening_stock`, `opening_ar`.

| Command | Permission | Answer | Errors / notes |
|---------|------------|--------|----------------|
| `import_create_batch(p_kind text, p_rows jsonb, p_idempotency_key text, p_file_name text = null)` | `admin.import.run` (all, step-up) + the kind's posting permission at all (customers `crm.customer.create`, products `catalog.product.manage`, customer_prices `catalog.price.manage`, opening_stock `inventory.receipt.post`, opening_ar none) | `{batch_id, kind, status:'uploaded', row_count, …}` | `CONFLICT` (same key, different rows), `VALIDATION` (unknown or missing column, > 5000 rows, value > 2000 characters). Same key and rows replays. |
| `import_validate(p_batch_id uuid)` | same | counts and per-row errors (`code:field`) | `ALREADY_COMMITTED`, `NOT_FOUND` |
| `import_commit(p_batch_id uuid)` | same | `{batch_id, kind, status:'committed', committed:true, …}` or `{…, status:'failed', committed:false, failure, failure_sqlstate, failure_row_no}` | Re-validates, then posts every row through the normal `api.*` commands in one subtransaction (all or nothing). Commits of the same kind are serialised by `pg_advisory_xact_lock('import.commit:<kind>')`; a batch whose rows were imported meanwhile fails with `already_imported:*` row errors. `ALREADY_COMMITTED`. Event `import.committed` `{batch_id, kind, rows, result}`, no personal data. |
| `import_discard(p_batch_id uuid)` | same | `{batch_id, status:'discarded', replayed}` | deletes the staged rows; `ALREADY_COMMITTED` |

Views: `v_import_batches`, `v_import_rows`.

**Returns** (`20261103000200`; audit 4 `20261104000100`; suites 35, 46). Replaces the planned `api.create_return`.

| Command | Permission | Answer | Errors / notes |
|---------|------------|--------|----------------|
| `request_return(p_order_id uuid, p_lines jsonb, p_notes text = null, p_client_ref uuid = null)` | `sales.return.request`, customer in scope | `{return_id, return_no, status, approval_request_id, estimated_total, replayed}` | Always goes to the `sales.return` approval. Lines `[{order_item_id, lot_id?, quantity, reason_code, condition?}]` (lot optional when delivered from one lot). `QTY_EXCEEDS_RETURNABLE`, `VALIDATION`. The order is locked and scope checked before a replay lookup; a replay must come from the creator (`IDEMPOTENCY_CONFLICT`). Event `return.requested`; the hook emits `return.approved` / `return.rejected`. |
| `receive_return(p_return_id uuid, p_warehouse_id uuid, p_idempotency_key text)` | `sales.return.receive`, warehouse in scope | `{return_id, status:'received', warehouse_id, movements, order_status, replayed}` | quarantine warehouses only (`WAREHOUSE_NOT_QUARANTINE`); posts `sale_return` movements to the delivered lot; whole return only. Event `return.received`. |
| `credit_return(p_return_id uuid, p_idempotency_key text)` | `sales.return.credit` (step-up) | `{return_id, status:'credited', credit_notes, total, customer_credit, replayed}` | Takes the customer AR lock; one credit note per invoice (`CN-…`, oldest invoice first, amounts from `finance.credit_note_amounts`). The full value is always credited; any excess over the invoice's open amount is released from its payment allocations and stays as unallocated customer credit. `CREDIT_QTY_EXCEEDED`, `EXCEEDS_INVOICE_OPEN_AMOUNT` (lines already covered by goodwill credits or write-offs), `INVALID_STATE`. Events `return.credited` and `credit_note.issued`, both with `customer_credit` (the credit-note event also `applied_to_invoice`). |
| `cancel_return(p_return_id uuid, p_reason text, p_idempotency_key text)` | requester (pending), or `wf.decide.return` in customer scope / `sales.return.receive` (approved, not received) | `{return_id, return_no, status:'cancelled'}` | `REASON_REQUIRED`, `INVALID_STATE` (received or later), `PERMISSION_DENIED`. Cancels a pending approval request; releases the held quantity. Event `return.cancelled`; the requester is notified when someone else cancels. |

Views: `v_returns` (adds `cancelled_at`, `cancelled_by`, `cancel_reason`, `customer_credit`), `v_return_lines`, `v_returnable_lines` (the single source of the returnable rule; ignores cancelled returns).

**Offline order drafts** (`20261103000300`; audit 4 `20261104000200`; suites 36, 47). `save_order_draft(p_order_id, p_customer_id, p_lines, p_notes = null, p_visit_id = null, p_version = null, p_employee_id = null)` keeps its signature and answer and adds `replayed`. The same caller sending the same key (order + base version) and the same request gets the current draft back with `replayed: true`, even after later edits or submit. Different content under a used key: `CONFLICT` or `INVALID_STATE`. A replay is answered only if the caller still passes the customer and owner scope checks (no state check); otherwise `PERMISSION_DENIED`.

**Commissions** (`20261103000400`; suites 37, 46, 48).

| Command | Permission | Answer | Errors / notes |
|---------|------------|--------|----------------|
| `calculate_commission_period(p_period date)` | `perf.commission.calculate` at all (step-up) | `{period_id, period_start, period_end, status, frozen, changed, inserted, deleted, invoices, run_id, …}` | recalculates an open month; unchanged rows keep their id (`changed:false`) |
| `close_commission_period(p_period date)` | same | `{period_id, period_start, period_end, status:'approved', entries_total, adjustments_total, total, employees, calculation, replayed}` | the oldest open month, after it ended: `PREVIOUS_PERIOD_OPEN`, `PERIOD_NOT_ENDED`. Notifies each rep (`commission.statement_final`); event `commission.period_closed`. |
| `adjust_commission(p_employee_id uuid, p_period date, p_amount numeric, p_reason text, p_kind text = null, p_idempotency_key text = null)` | `perf.commission.adjust` + employee in scope | `{adjustment_id, approval_request_id, amount, kind, status: pending_approval\|posted, …}` | `SELF_ADJUSTMENT`, `PERIOD_CLOSED`, `REASON_REQUIRED`, `IDEMPOTENCY_CONFLICT`. Through the `perf.commission_adjustment` workflow; the hook posts the row and emits `commission.adjusted`. |
| service: `commission_calculate(p_period date)`, `commission_run(p_now timestamptz = null)` | `service_role` | | `commission_run` closes every month whose `perf.period_close_at` (day 6, Cairo) has passed, oldest first, then recalculates the open months |

Views: `v_commission_statement`, `v_commission_summary`, `v_commission_periods`, `v_commission_adjustment_requests`. Entries are immutable (`COMMISSION_ENTRY_IMMUTABLE`).

**Invoice write-off and print** (`20261103000500`; suite 38).
- `request_invoice_write_off(p_invoice_id uuid, p_amount numeric, p_reason text, p_idempotency_key text)`: `finance.collection.manage`, customer in scope; takes the customer AR lock. Errors `WRITE_OFF_PENDING`, `EXCEEDS_INVOICE_OPEN_AMOUNT`, `IDEMPOTENCY_CONFLICT` (key reused with another invoice or amount), `REASON_REQUIRED`. Decided through `finance.write_off` (`wf.decide.write_off`, limit = EGP, step-up on approve and reject). The hook re-checks the open amount, posts a `write_off` ledger entry (−amount, VAT-inclusive, numbered `WO-YYYY-nnnnnn`), sets the invoice `written_off` when nothing is left open, closes its collection and work tasks, and emits `invoice.written_off`.
- `company_profile()`: needs `finance.invoice.read` or `finance.payment.read`; returns the `company.*` settings for print.
- Views: `v_invoice_write_offs`, `v_invoice_print_party` (customer address, tax and register numbers). `v_invoices` gains a last column `written_off`; open amounts in `v_invoices`, `v_ar_aging`, `v_collection_tasks`, `v_customer_statement` and `perf.overdue_invoices` subtract write-offs.

**MFA** (`20261103000600`; suites 39, 48). `my_mfa_status()` → `{enforced, aal, required_permissions[]}` (the caller's own gated permissions). `v_permissions` gains `requires_mfa`. New error code `MFA_REQUIRED` (42501).

**Admin console v2** (`20261103000800`–`0820`; audit 4 `20261104000400`, `…000500`; suites 41, 49, 50).

| Command | Permission | Errors / notes |
|---------|------------|----------------|
| `update_setting(p_key text, p_value jsonb, p_reason text = null, p_expected_updated_at timestamptz = null)` → `{key, value, changed, updated_at}` | `admin.settings.manage` (step-up) | `SETTING_NOT_WHITELISTED`, `OWNER_ONLY` (42501), `SETTING_READ_ONLY`, `SETTING_OUT_OF_RANGE` (also text longer than `max_value`, fallback 200), `SETTING_SECRET_REFUSED`, `CONFLICT`, `VALIDATION` (e.g. `company.logo_url` not a same-origin image path), `MFA_REQUIRED` (any `security.*` key while enforcement is on, without aal2). Same value again does nothing. Audit row + `setting_changed` security event; event `setting.updated` carries key and version only. |
| `update_employee(p_employee_id, p_full_name_en, p_job_title, p_full_name_ar = null, p_phone = null, p_email = null, p_department_id = null, p_office_id = null, p_manager_id = null, p_hired_on = null, p_expected_updated_at = null)` → jsonb | `core.employee.manage` (scoped); a new manager must be in scope | full replace; `CONFLICT`, `MANAGER_CYCLE`, `OWNER_ONLY`, `SELF_GRANT_FORBIDDEN`; step-up when the manager or department changes. Event `employee.updated`. |
| `set_employment_status(p_employee_id, p_status, p_reason, p_effective_on = null)` → jsonb | same | reason required; reassigns nothing and returns the customers, direct reports and territories still held; `LAST_OWNER`, `SELF_SUSPEND_FORBIDDEN`; step-up when deactivating or reactivating from suspended/terminated. Event `employee.status_changed`. |
| `employee_customer_holdings(p_employee_id)` → table | same | minimal columns for a hand-over |
| `assign_employee_territory(p_employee_id, p_territory_id, p_assignment = 'member')` → jsonb, `end_employee_territory(p_employee_territory_id, p_reason = null)` | same | step-up on a real change. Events `employee.territory_assigned` / `employee.territory_ended`. |
| `create_territory(p_code, p_name_en, p_name_ar, p_parent_id = null)` → uuid, `rename_territory(p_territory_id, p_name_en, p_name_ar)`, `move_territory(p_territory_id, p_new_parent_id, p_reason = null)` → jsonb, `set_territory_active(p_territory_id, p_active, p_reason)` → jsonb, `set_territory_coverage(p_territory_id, p_governorate_code, p_city = '*')` → jsonb, `remove_territory_coverage(p_governorate_code, p_city = '*')`, `territory_customer_counts()` → table | `core.territory.manage` (a region, a move to the top level or coverage taken from outside your scope needs `all`) | `TERRITORY_TOO_DEEP` (> 3 levels), `TERRITORY_CYCLE`, `TERRITORY_HAS_CHILDREN`, `DUPLICATE`; `move_territory` steps up on a real move. Events `territory.created`, `.renamed`, `.moved`, `.deactivated`, `.reactivated`, `.coverage_changed`. |

Views: `v_settings` (only `admin.settings.manage` holders), `v_admin_employees`, `v_employee_territories`, `v_departments`, `v_offices`, `v_territory_coverage`.

**Visit planning** (`20261103000900`; audit 4 `20261104000800`; suites 42, 53).

| Command | Permission | Answer | Errors / notes |
|---------|------------|--------|----------------|
| `plan_visits(p_employee_id uuid, p_visits jsonb, p_client_ref uuid)` | `field.visit.plan` over the employee (null = me) | `{client_ref, employee_id, created, from, to, visits[], replayed}` | `[{customer_id, date}]`, at most 200, all or nothing. `NOT_ASSIGNED` (not assigned to that employee, or not readable by the caller, which gives no customer number), `PAST_DATE`, `DUPLICATE`, `DAILY_CAP` (more than `planning.daily_visit_cap` non-cancelled visits that day), `CONFLICT` (client_ref reused for another plan), `NOT_FOUND`. Stores `planned_by`. Event `field.visits_planned` (aggregate `field.visit_plan_batch`); the rep is notified when someone else planned. |
| `unplan_visit(p_visit_id uuid)` | `field.visit.plan` over the employee; a visit someone else planned needs that planner or scope over the planner | `{visit_id, status:'cancelled', replayed}` | only `planned`, not checked in, today or later; `PERMISSION_DENIED`, `INVALID_STATE`. Event `field.visit_unplanned`; notification `planning.planned_visit_removed` to the planner when someone else removes it. |
| `generate_plan(p_employee_id uuid, p_month date)` | `field.visit.plan` over the employee | `{employee_id, month, from, to, daily_cap, work_days, customers, customers_skipped, days, proposals, unscheduled}` | writes nothing; only customers the caller may read; at most 1000 customers (most due first); `TIMEOUT` after a 5 s budget |
| `set_visit_frequency(p_customer_id uuid, p_visit_class text)` | `crm.customer.update` at team or wider, customer in scope | jsonb | class A/B/C |
| `planning_settings()`, `coverage(p_from date, p_to date)` → table | `coverage` returns nothing without `field.visit.read`, and only customers in `crm.customer.read` scope | | |

Views: `v_coverage` (current month), `v_visit_plan` (`week_start`, `can_unplan`, `is_missed`, and last column `may_unplan`, the planner rule), `v_planning_employees`, `v_planning_customers`.

**Workflow administration** (`20261103001000`; audit 4 `20261104000600`; suites 43, 51).

| Command | Permission | Errors / notes |
|---------|------------|----------------|
| `upsert_workflow_rule(p_definition_code text, p_priority int, p_condition jsonb = '{}', p_auto_approve boolean = false, p_rule_id uuid = null, p_stages jsonb = null, p_reason text = null)` → jsonb | `admin.workflow.manage` (step-up) | `INVALID_CONDITION`, `DUPLICATE` (priority in use), `CATCH_ALL_REQUIRED`, `REASON_REQUIRED`, `OWNER_ONLY` (creating or changing an auto-approve rule, or an edit that could expose one). Writes a `workflow_changed` security event, bumps the workflow version, notifies owners when the editor is not an owner. |
| `set_workflow_stage(p_rule_id, p_stage_no, p_approver_type = null, p_approver_permission = null, p_approver_role_id = null, p_approver_user_id = null, p_required_approvals = 1, p_escalate_after_minutes = null, p_escalate_to_user_id = null, p_remove = false, p_reason = null)` → jsonb | same | only `wf.decide.*` permissions; `ESCALATION_BLOCKED` (non-owner routing to themselves); `RULE_IN_USE` (removing a stage while requests are pending, or the last stage); `OWNER_ONLY` on auto-approve rules |
| `create_delegation(p_to_employee_id, p_valid_from timestamptz, p_valid_to timestamptz, p_workflow_codes text[] = null, p_from_employee_id = null, p_reason = null, p_client_ref text = null)` → jsonb | own authority, or `wf.delegation.manage` over the delegator | `SELF_GRANT_FORBIDDEN`, `VALIDATION` (window > `wf.delegation.max_days`, overlap); a repeated client_ref returns the first result |
| `revoke_delegation(p_delegation_id, p_reason = null)` → jsonb | delegator, delegate, a manager in scope, or a workflow admin | idempotent |
| service: `workflow_escalate(p_limit int = 200)` | `service_role` | one level per run once a request has waited level × `escalate_after`; in-app `approval.escalated` notice and outbox event; idempotent |

Views: `v_workflow_definitions`, `v_workflow_rules`, `v_workflow_stages`, `v_delegations`, `v_approval_escalations`, `v_workflow_people`. `decide_approval` (redefined in `20261104000300`): an escalation target can now get `PERMISSION_DENIED` or `LIMIT_EXCEEDED` (AUTHORIZATION §8.1), and a stage decided by a gated permission needs aal2 to approve or reject.

**Audit reader** (`20261103001100`; audit 4 `20261104000300`, `…000700`; suites 44, 48, 52).
- `audit_search(p_table_schema = null, p_table_name = null, p_record_id = null, p_actor_user_id = null, p_from date = null, p_to date = null, p_action = null, p_before_id bigint = null, p_limit = 50 (max 200), p_reveal = false)` and `audit_record_history(p_table_schema, p_table_name, p_record_id, p_before_id = null, p_limit = 100, p_reveal = false)` return `id, occurred_at, actor_user_id, actor_name_en, actor_name_ar, action, table_schema, table_name, record_id, changed_fields, request_id, old_data, new_data, masked`. Newest first, paged by `p_before_id`; dates are Cairo days, both ends included.
- Permission `audit.row_image.read` at scope `all`. Masked values read `"[masked:<category>]"` (`masked` maps path → category). `p_reveal => true` lifts masks the caller may lift (`audit.row_image.unmask`, step-up; cost keys by `catalog.cost.read`).
- Every successful call writes one `audit_row_image_read` security event (severity `warning` when something was revealed). Denied calls are not logged (the raise rolls back).
- Errors: `PERMISSION_DENIED` (42501, also for a non-`all` grant), `VALIDATION` (22023: unknown action, reversed dates, missing record id).
- `audit_tables()` lists audited tables (not logged).

**Exports** (`20261104000710`; suite 52).
- `log_export(p_kind text, p_filters jsonb = '{}', p_row_count int = null, p_request_id text = null) → bigint`: kind whitelisted (`audit.export_kinds()`), the kind's permissions through `authz.require`: its read permission and its own MFA-gated `<module>.<resource>.export` permission (`20261104001100`; table under `GET /api/export/[kind]`), filter keys per kind with values matching `^[A-Za-z0-9_.:-]{1,64}$` (`q` stored as `"[redacted]"`), at most 20 per user per 10 minutes. Writes one `export` security event; returns its id. Errors `VALIDATION` (22023), `PERMISSION_DENIED`, `MFA_REQUIRED`, `RATE_LIMITED` (P0001).
- `log_export_result(p_export_id bigint, p_row_count int, p_truncated boolean = false, p_failed boolean = false)`: only the user who opened the export, once, within an hour. Writes `export_result` (not counted by the rate limit). Errors `NOT_FOUND`, `INVALID_STATE` (already recorded), `VALIDATION`.

**Tracking** (`20261102000100`; suite 33). `record_location_pings` accepts `source` `pwa` or `native` per point; anything else is answered `rejected: invalid`. `source` is advisory only.

**New error codes:** `MFA_REQUIRED`, `RATE_LIMITED`, `QTY_EXCEEDS_RETURNABLE`, `WAREHOUSE_NOT_QUARANTINE`, `CREDIT_QTY_EXCEEDED`, `WRITE_OFF_PENDING`, `ALREADY_COMMITTED`, `ALREADY_IMPORTED`, `PREVIOUS_PERIOD_OPEN`, `PERIOD_NOT_ENDED`, `PERIOD_CLOSED`, `SELF_ADJUSTMENT`, `SETTING_NOT_WHITELISTED`, `SETTING_READ_ONLY`, `SETTING_OUT_OF_RANGE`, `SETTING_SECRET_REFUSED`, `MANAGER_CYCLE`, `TERRITORY_TOO_DEEP`, `TERRITORY_CYCLE`, `TERRITORY_HAS_CHILDREN`, `NOT_ASSIGNED`, `PAST_DATE`, `DAILY_CAP`, `TIMEOUT`, `INVALID_CONDITION`, `CATCH_ALL_REQUIRED`, `RULE_IN_USE`.

**New outbox events:** `import.committed`; `return.requested`, `return.approved`, `return.rejected`, `return.received`, `return.credited`, `return.cancelled`; `commission.period_closed`, `commission.adjusted`; `invoice.written_off`; `setting.updated`; `employee.updated`, `employee.status_changed`, `employee.territory_assigned`, `employee.territory_ended`; `territory.created`, `.renamed`, `.moved`, `.deactivated`, `.reactivated`, `.coverage_changed`; `field.visits_planned`, `field.visit_unplanned`; `approval.escalated`. `credit_note.issued` gains `customer_credit` and `applied_to_invoice`.

## 2. Commands (MVP)

| Command | Permission | Input (beyond ids) | Output | Notable errors |
|---------|------------|--------------------|--------|----------------|
| `api.create_customer` | `crm.customer.create` | names, kind, specialty, phones, email, address, governorate, city, lat/lng?, tags, `p_client_ref` | `{customer_id, customer_no, territory_id, warnings[]}` | `DUPLICATE_CUSTOMER{existing_id}`, `PERMISSION_DENIED` |
| `api.update_customer` | `crm.customer.update` (scope) | changed fields, `p_version` | `{customer_id, version}` | `CONFLICT{current}`, `NOT_FOUND` |
| `api.request_customer_reassignment` | `crm.customer.reassign` or request-only | customer, to_employee, reason | `{approval_request_id}` | |
| `api.create_opportunity` / `api.move_opportunity` | `crm.opportunity.manage` | stage, value, close date, lost_reason | `{opportunity_id, stage}` | `INVALID_STATE` |
| `api.create_task` / `api.complete_task` | `work.task.manage` (own) | title, due_at, customer?, kind | `{task_id}` | |
| `api.visit_check_in` ✅ | `field.visit.create` | `p_visit_id` (client uuid), customer, lat, lng, accuracy_m, captured_at, device | `{visit_id, verification_status, distance_m, anomaly_flags[], replayed}` | `PERMISSION_DENIED` (customer out of scope) |
| `api.visit_check_out` | `field.visit.create` | visit, outcome, notes, lat/lng, next_follow_up? | `{visit_id, status}` | `INVALID_STATE` |
| `api.request_visit_exception` | `field.visit.exception.request` | visit, reason, attachment path | `{approval_request_id}` | |
| `api.save_order_draft` | `sales.order.create` | customer, visit?, lines[{variant_id, qty, requested_discount_pct}], notes, `p_client_ref`, `p_version` | `{order_id, version, indicative_total}` | `CONFLICT` |
| `api.submit_order` ✅ | `sales.order.submit` (+ `sales.discount.apply` limit) | order | `{order_id, status: submitted\|pending_approval, total}` | `INVALID_STATE`, `NO_PRICE`, `EMPTY_ORDER`, `CREDIT_LIMIT` (Phase 3) |
| `api.decide_approval` | `wf.approval.decide.<wf>` (limit) | request, decision, comment | `{request_id, status, next_stage?}` | `SELF_APPROVAL`, `LIMIT_EXCEEDED`, `INVALID_STATE` |
| `api.reserve_order` | `sales.order.fulfil` or system on approval | order, warehouse? | `{reservations[], backordered[]}` | `INSUFFICIENT_STOCK` |
| `api.post_fulfillment` | `sales.order.fulfil` (warehouse scope) | order, lines[{order_item_id, lot_id, qty, serial_id?}], `p_idempotency_key` | `{fulfillment_id, order_status}` | `INSUFFICIENT_STOCK`, `LOT_MISMATCH` |
| `api.cancel_order` | `sales.order.cancel` (+ workflow after approval) | order, reason | `{order_id, status}` | `INVALID_STATE` |
| ~~`api.create_return`~~ | — | — | — | **Superseded** by `request_return`, `receive_return`, `credit_return`, `cancel_return` (§1b) |
| `api.post_goods_receipt` | `inventory.receipt.post` (W) | receipt id | `{movements[]}` | |
| `api.create_transfer` / `api.receive_transfer` | `inventory.transfer.*` (W) | lines | `{transfer_id, status}` | `INSUFFICIENT_STOCK` |
| `api.post_inventory_adjustment` ✅ | `inventory.adjustment.post` (W, limit units) | warehouse, variant, lot, qty (±), reason, `p_idempotency_key` | `movement_id` | `APPROVAL_REQUIRED`, `REASON_REQUIRED` |
| `api.issue_invoice` | `finance.invoice.issue` | order (from fulfilled qty) | `{invoice_id, invoice_no, total, eta_status}` | `NOTHING_TO_INVOICE` |
| `api.issue_credit_note` | `finance.credit_note.issue` (+ workflow) | invoice, amount/lines, reason, return? | `{credit_note_id}` | `EXCEEDS_INVOICE_OPEN_AMOUNT` |
| `api.record_payment` | `finance.payment.record` (own/team) | customer, method, amount, received_at, reference, cheque_due_date?, `p_client_ref` | `{payment_id, payment_no, status: pending_verification}` | |
| `api.confirm_payment` / `api.bounce_payment` | `finance.payment.confirm` | payment | `{payment_id, status}` | `INVALID_STATE` |
| `api.allocate_payment` | `finance.payment.allocate` (limit) | payment, allocations[{invoice_id, amount}] | `{allocations[], payment_unallocated, invoices[{id, open_amount, status}]}` | `OVER_ALLOCATION`, `INVOICE_CLOSED` |
| `api.reverse_allocation` | `finance.payment.reverse` | allocation, reason | `{reversal_id}` | |
| `api.grant_role` ✅ / `api.revoke_role` | `admin.role.assign` | user, role, bindings, validity, reason | `{user_role_id}` | `ESCALATION_BLOCKED`, `OWNER_ONLY`, `SELF_GRANT_FORBIDDEN`, `LAST_OWNER` |
| `api.suspend_user` | `admin.user.suspend` | user, reason | `{user_id, status}` | `LAST_OWNER` |
| `api.set_kpi_target` | `perf.target.manage` | kpi, assignee, period, target, weight | `{target_id}` | |
| ~~`api.calculate_commissions`~~ | — | — | — | **Superseded** by `calculate_commission_period` (§1b) |
| ~~`api.approve_commission_period`~~ | — | — | — | **Superseded** by `close_commission_period` (§1b); the `perf.commission_period` workflow is unused (DECISIONS, audit 4 M-5) |
| `api.mark_notification_read` | self | ids[] | `{count}` | |

✅ = prototyped and tested in the draft.

## 3. Read views (MVP)

`api.v_my_today` (planned visits, due tasks), `api.v_customers` (masked balance column), `api.v_customer_timeline`, `api.v_catalog` (variant, product, brand, price for caller's default list, **no cost**), `api.v_stock_available` (available qty only for reps), `api.v_stock_detail` (lot-level, inventory roles), `api.v_orders`, `api.v_order_detail`, `api.v_approvals_inbox`, `api.v_invoices`, `api.v_aging`, `api.v_kpi_scorecard`, `api.v_commission_statement`, `api.v_notifications`. Every view is `security_invoker`, so RLS applies.

## 4. HTTP endpoints (Next.js route handlers)

| Endpoint | Caller | Auth | Behaviour |
|----------|--------|------|-----------|
| `POST /api/webhooks/paymob` | Paymob | HMAC (Paymob HMAC secret, computed over Paymob's documented field order; verify against current Paymob docs at integration time) | Verify → `insert integration.inbound_webhooks` (unique provider + transaction id) → `api.ingest_paymob_event` → 200 fast. Invalid signature → 401 + security event. |
| `POST /api/webhooks/shopify` | Shopify | `X-Shopify-Hmac-Sha256` (base64 HMAC-SHA256 of raw body with app secret) | Same pattern. Handles `orders/create`, `orders/paid`, `products/update` (log only; Honest OS wins). |
| `GET/POST /api/webhooks/whatsapp` | Meta | GET: `hub.verify_token` challenge. POST: `X-Hub-Signature-256` (HMAC-SHA256 with app secret) | Delivery statuses + inbound replies → `notify` / CRM activity |
| `GET\|POST /api/cron/outbox` | Vercel Cron `17 3 * * *` UTC (daily: Hobby limit; target every 1–5 min on Pro or via pg_cron) | `Authorization: Bearer $CRON_SECRET` | Claim ≤ 100 rows `FOR UPDATE SKIP LOCKED` → deliver → update status/backoff |
| `GET\|POST /api/cron/kpi-snapshot` | `23 22 * * *` UTC (00:23 Cairo in winter, 01:23 in summer) | `CRON_SECRET` | `service.snapshot_kpis(as_of?)` via the service role. Writes the current month; the previous month is provisional until day 5, then written once as final. |
| `GET\|POST /api/cron/overdue` | `7 3 * * *` UTC (before the outbox run) | `CRON_SECRET` | `service.finance_overdue_scan(500)`. Overdue invoices → collection tasks (and reopens tasks closed while still unpaid) + outbox `invoice.overdue`. Returns `{business_date, scanned, created, unassigned, reopened}`. |
| `GET\|POST /api/cron/tracking` | `41 0 * * *` UTC | `CRON_SECRET` | `service.tracking_auto_close()`, then `service.tracking_purge()` (90-day retention) |
| `GET\|POST /api/cron/commissions` | `47 1 * * *` UTC (≈ 03:47–04:47 Cairo) | `CRON_SECRET` | `service.commission_run()`: closes every month past day 6 (Cairo), then recalculates the open months |
| `GET\|POST /api/cron/escalations` | `47 4 * * *` UTC (daily: Hobby limit; `*/15 * * * *` on Pro before go-live) | `CRON_SECRET` | `service.workflow_escalate()`: one escalation level per run |
| `GET /api/export/[kind]` | signed-in user (browser link) | session cookie; user JWT, never the service role | CSV (UTF-8 BOM, CRLF, RFC 4180, formula guard) of `orders`, `order_lines`, `invoices`, `payments`, `aging`, `visits`, `customers`, `stock` or `tracking`, read from the `api.v_*` views page by page (1,000 rows), capped by `REPORTS_EXPORT_MAX_ROWS` (default 50,000, max 200,000; a note row marks truncation or interruption). Filters as on the list pages plus Cairo-day `from`/`to`; `?locale=` sets the headers. Calls `api.log_export` before reading and `api.log_export_result` at the end. Permissions per kind (read AND export, every export permission MFA-gated; `EXPORT_PERMISSIONS` in `src/modules/reports/kinds.ts` mirrors `audit.export_kinds()`): `orders`, `order_lines` `sales.order.read` + `sales.order.export`; `invoices` `finance.invoice.read` + `finance.invoice.export`; `payments` `finance.payment.read` + `finance.payment.export`; `aging` (`finance.page.aging` or `finance.ledger.read`) + `finance.aging.export`; `visits` `field.visit.read` + `field.visit.export`; `customers` `crm.customer.read` + `crm.customer.export`; `stock` `inventory.stock.read` + `inventory.stock.export`; `tracking` `field.tracking.read` + `field.tracking.export`. The list pages (`/orders`, `/finance/invoices`, `/finance/payments`, `/finance/aging`, `/visits`, `/customers`, `/inventory`, `/tracking`) link here with their current filters through `ExportCsvButton`, shown only when the user may run that export. Responses: **401** `unauthenticated`; **403** `forbidden` (no permission, checked before any DB call and again by `log_export`) or **403** `mfa_required` (step-up needed, for every kind once `security.mfa_enforced` is on); **429** `rate_limited` with `Retry-After: 600` (more than 20 exports in 10 minutes); **400** `invalid_filters` with the field names; **404** `unknown_export`; **500** `export_failed` with a request id. |

**2026-11-01 audit changes (suite 31):**
- **Payments:** `record_payment` refuses a `received_at` more than `finance.payment.max_backdate_days_rep` (3) days back for reps, or more than `…_finance` (31) days for finance, and refuses any date in a closed KPI period.
- **Collection tasks:** in `update_collection_task`, the assignee may only `promise` or `escalate`. `close` and `reopen` need `finance.collection.manage`. `collected` requires the invoice to be fully paid (`INVOICE_STILL_OPEN`).
- **Concurrency:** every AR mutation for a customer takes a per-customer advisory lock (`finance.lock_customer_ar`).
- **CASH_COLLECTED:** a reversal after its period closed counts as a negative amount on the reversal day; closed months are never restated.

## 5. Outbound event contract (outbox → Make.com / consumers)

```http
POST https://hook.eu2.make.com/<scenario-hook-id>
Content-Type: application/json
X-Honest-Event: order.pending_approval
X-Honest-Event-Id: 6f1c…   (outbox.id — consumers dedupe on this)
X-Honest-Timestamp: 1767225600
X-Honest-Signature: sha256=<hex HMAC-SHA256(secret, timestamp + "." + raw_body)>
```

```json
{
  "id": "6f1c2b9e-…",
  "type": "order.pending_approval",
  "occurred_at": "2026-11-02T09:15:00+02:00",
  "version": 1,
  "data": {
    "order_id": "…",
    "order_no": "SO-2026-000123",
    "customer": {"id": "…", "display_name": "Dr. Ahmed Clinic", "territory": "CAI-NASR"},
    "rep": {"employee_id": "…", "name": "…"},
    "total": "2234.40",
    "currency": "EGP",
    "reason": "discount above limit",
    "approve_url": "https://app.honesteg.co/ar/approvals/…"
  }
}
```

Rules:
1. Payloads carry the **minimum** data the consumer needs. There are no costs, no national IDs and no GPS coordinates, and phone numbers appear only when the consumer must send a message.
2. Consumers must reject signatures older than 5 minutes and dedupe on `X-Honest-Event-Id`.
3. Any event schema change bumps `version`. Consumers ignore unknown fields.

Event catalogue (MVP): `customer.created`, `order.submitted`, `order.pending_approval`, `order.approved`, `order.rejected`, `order.fulfilled`, `invoice.issued`, `invoice.overdue`, `payment.recorded`, `payment.confirmed`, `stock.below_reorder`, `lot.expiring`, `task.overdue`, `kpi.below_threshold`, `visit.exception_requested`, `report.daily_sales`, `report.weekly_kpi`.
